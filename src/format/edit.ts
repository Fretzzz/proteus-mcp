/**
 * Safe in-place editing of ROOT.DSN.
 *
 * ROOT.DSN stores absolute file offsets (pin -> wire, terminal -> wire, junction -> wire,
 * header -> trailer, trailer -> circuit sections). Changing the length of any text shifts
 * everything after it, so every pointer to a later record must be rewritten.
 *
 * Strategy:
 *   1. Shorter text is padded with '\n' (Proteus itself pads property blocks this way), so
 *      no byte moves and nothing needs relocating.
 *   2. Otherwise every pointer slot we understand is relocated, but only after proving that
 *      the slots are complete: for each pointer target after the edit, the number of int32
 *      occurrences of that value anywhere in the file must equal the number of known slots.
 *      Any unexplained occurrence aborts the edit.
 *   3. The result is re-parsed and its connectivity compared with the original.
 */
import { LATIN1, i32, indexOfAll, int32Bytes, formatProperties, parseProperties } from './bytes.js';
import { parseDsn, type DsnComponent, type DsnModel } from './dsn.js';
import { buildNetlist, type PinResolver } from './netlist.js';

export class EditError extends Error {}

interface PointerMap {
  targets: Set<number>;
  /** slot position -> target value */
  slots: Map<number, number>;
}

function pointerMap(b: Buffer, m: DsnModel): PointerMap {
  const targets = new Set<number>();
  const slots = new Map<number, number>();
  for (const w of m.wires) targets.add(w.offset);
  for (const s of m.sections) targets.add(s.offset);
  if (m.trailerOffset !== null) targets.add(m.trailerOffset);
  const addSlot = (pos: number) => {
    const v = i32(b, pos);
    if (v && targets.has(v)) slots.set(pos, v);
  };
  for (const c of m.components) c.pinRefSlots.forEach(addSlot);
  for (const t of m.terminals) [t.refSlot, ...t.extraRefSlots].forEach(addSlot);
  for (const j of m.junctions) j.refSlots.forEach(addSlot);
  if (m.trailerPointerSlot !== null) addSlot(m.trailerPointerSlot);
  if (m.trailerOffset !== null) {
    for (const s of m.sections) for (const p of indexOfAll(b, int32Bytes(s.offset), m.trailerOffset, b.length)) slots.set(p, s.offset);
  }
  return { targets, slots };
}

/**
 * Byte ranges whose layout is fully decoded (wire records, labels, component records,
 * terminals, junctions). An int32 lying wholly inside one of them that is not a known pointer
 * slot is a coordinate/flag/text that merely equals some offset, not a pointer.
 */
function decodedSpans(m: DsnModel): [number, number][] {
  const spans: [number, number][] = [];
  for (const w of m.wires) spans.push([w.offset, w.end]);
  for (const c of m.components) spans.push([c.offset, c.end]);
  for (const t of m.terminals) {
    spans.push([t.label.offset, t.label.end]);
    const last = Math.max(t.refSlot, ...t.extraRefSlots) + 4;
    if (t.offset < t.label.offset) spans.push([t.offset, last]);
  }
  for (const j of m.junctions) spans.push([j.offset, j.offset + 25]);
  for (const l of m.otherLabels) spans.push([l.offset, l.end]);
  return spans.sort((a, c) => a[0] - c[0]);
}

function insideDecoded(spans: [number, number][], pos: number): boolean {
  let lo = 0, hi = spans.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid][0] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  // spans can nest/overlap: check a few candidates to the left
  for (let k = best; k >= 0 && k > best - 8; k--) if (spans[k][0] <= pos && pos + 4 <= spans[k][1]) return true;
  return false;
}

/** Replace b[at, at+removeLen) with `insert`, relocating every pointer that needs it. */
export function spliceDsn(b: Buffer, m: DsnModel, at: number, removeLen: number, insert: Buffer): Buffer {
  const delta = insert.length - removeLen;
  const out = Buffer.concat([b.subarray(0, at), insert, b.subarray(at + removeLen)]);
  if (delta === 0) return out;
  const { targets, slots } = pointerMap(b, m);
  const spans = decodedSpans(m);
  for (const t of targets) {
    if (t < at + removeLen) continue;
    const occurrences = indexOfAll(b, int32Bytes(t)).filter(
      (p) => (p < at || p >= at + removeLen) && (slots.has(p) || !insideDecoded(spans, p)),
    );
    const known = [...slots].filter(([, v]) => v === t).length;
    if (occurrences.length !== known) {
      throw new EditError(
        `refusing to edit: offset 0x${t.toString(16)} is referenced ${occurrences.length} time(s) but only ${known} pointer slot(s) are understood. ` +
          `The file may contain a record type this tool does not decode yet.`,
      );
    }
  }
  for (const [pos, v] of slots) {
    if (v < at + removeLen) continue;
    const np = pos >= at + removeLen ? pos + delta : pos;
    out.writeInt32LE(v + delta, np);
  }
  return out;
}

function netSignature(m: DsnModel, pins: PinResolver): string {
  const nl = buildNetlist(m, pins);
  return nl.nets
    .map((n) => n.nodes.map((x) => `${x.ref}.${x.index}`).join(',') + '|' + n.terminals.map((t) => t.kind + ':' + t.label).sort().join(','))
    .sort()
    .join('\n');
}

export interface EditResult {
  dsn: Buffer;
  relocated: boolean;
  detail: string;
}

function verify(before: DsnModel, afterBuf: Buffer, pins: PinResolver, renamed?: { from: string; to: string }): DsnModel {
  const after = parseDsn(afterBuf);
  const counts = (x: DsnModel) => [x.components.length, x.wires.length, x.terminals.length, x.junctions.length, x.sections.length].join('/');
  if (counts(before) !== counts(after))
    throw new EditError(`verification failed: object counts changed ${counts(before)} -> ${counts(after)}`);
  const mapName = (s: string) => (renamed && s === renamed.to ? renamed.from : s);
  const sigAfter = netSignature(after, pins)
    .split('\n')
    .map((l) => l.replace(/[^,|]+(?=\.\d+)/g, (r) => mapName(r)))
    .sort()
    .join('\n');
  if (netSignature(before, pins) !== sigAfter) throw new EditError('verification failed: connectivity changed after edit');
  return after;
}

function findComponent(m: DsnModel, ref: string): DsnComponent {
  const hits = m.components.filter((c) => c.ref === ref);
  if (hits.length === 0) throw new EditError(`no component with reference "${ref}"`);
  if (hits.length > 1) throw new EditError(`reference "${ref}" is ambiguous (${hits.length} components on different sheets)`);
  return hits[0];
}

/** Change, add (string) or delete (null) properties on a component. */
export function setComponentProperties(b: Buffer, ref: string, changes: Record<string, string | null>, pins: PinResolver): EditResult & { text: string } {
  const m = parseDsn(b);
  const c = findComponent(m, ref);
  const newText = formatProperties(c.propertiesText, changes);
  for (const v of Object.values(changes)) if (v !== null && /[{}\n]/.test(v)) throw new EditError('property values cannot contain "{", "}" or newlines');
  const st = c.propsStorage;
  let enc = Buffer.from(newText, LATIN1);
  let out: Buffer;
  let relocated = false;
  if (st.kind === 'block') {
    out = spliceDsn(b, m, st.textOffset, st.length, enc);
    out.writeInt32LE(enc.length, st.lengthOffset);
    relocated = enc.length !== st.length;
  } else if (st.kind === 'both') {
    // full text lives in the block; the label shows the visible subset
    let step = spliceDsn(b, m, st.textOffset, st.length, enc);
    step.writeInt32LE(enc.length, st.lengthOffset);
    relocated = enc.length !== st.length;
    const label = c.labels[c.labels.length - 1];
    const visibleKeys = new Set(Object.keys(parseProperties(label.text)));
    const visibleChanges = Object.fromEntries(Object.entries(changes).filter(([k]) => visibleKeys.has(k)));
    if (Object.keys(visibleChanges).length) {
      const inline = Buffer.from(formatProperties(label.text, visibleChanges), LATIN1);
      if (inline.length > 254) throw new EditError('visible property text would exceed 254 bytes');
      const oldLen = step[label.offset + 1];
      step = spliceDsn(step, parseDsn(step), label.offset + 1, 1 + oldLen, Buffer.concat([Buffer.from([inline.length]), inline]));
      relocated ||= inline.length !== oldLen;
    }
    out = step;
  } else if (st.kind === 'inline') {
    const label = c.labels[c.labels.length - 1];
    const oldLen = b[label.offset + 1];
    if (enc.length > 254) {
      // move the text out of the label into a length-prefixed block (the form Proteus uses for long text)
      const step1 = spliceDsn(b, m, label.offset + 1, 1 + oldLen, Buffer.from([0]));
      step1.writeInt32LE(0, st.lengthOffset - oldLen);
      const m1 = parseDsn(step1);
      const c1 = findComponent(m1, ref);
      const lo = c1.propsStorage.lengthOffset;
      out = spliceDsn(step1, m1, lo + 4, 0, enc);
      out.writeInt32LE(enc.length, lo);
    } else {
      out = spliceDsn(b, m, label.offset + 1, 1 + oldLen, Buffer.concat([Buffer.from([enc.length]), enc]));
      const lenPos = st.lengthOffset + (enc.length - oldLen);
      out.writeInt32LE(enc.length, lenPos);
    }
    relocated = enc.length !== oldLen;
  } else {
    out = spliceDsn(b, m, st.lengthOffset + 4, 0, enc);
    out.writeInt32LE(enc.length, st.lengthOffset);
    relocated = enc.length > 0;
  }
  verify(m, out, pins);
  return { dsn: out, relocated, text: newText, detail: `${ref}: properties updated (${st.kind} storage${relocated ? ', pointers relocated' : ''})` };
}

/** Change a component's reference (COMPONENT ID) or value (COMPONENT VALUE) text. */
export function setComponentLabel(b: Buffer, ref: string, which: 'COMPONENT ID' | 'COMPONENT VALUE', text: string, pins: PinResolver): EditResult {
  if (/[\n{}]/.test(text)) throw new EditError('text cannot contain newlines or braces');
  const enc = Buffer.from(text, LATIN1);
  if (enc.length > 254) throw new EditError('text too long (max 254 bytes)');
  const m = parseDsn(b);
  const c = findComponent(m, ref);
  if (which === 'COMPONENT ID' && m.components.some((x) => x.ref === text && x !== c)) throw new EditError(`reference "${text}" already exists`);
  const label = c.labels.find((l) => l.kind === which);
  if (!label) throw new EditError(`${ref} has no ${which} label`);
  const oldLen = b[label.offset + 1];
  const out = spliceDsn(b, m, label.offset + 1, 1 + oldLen, Buffer.concat([Buffer.from([enc.length]), enc]));
  verify(m, out, pins, which === 'COMPONENT ID' ? { from: ref, to: text } : undefined);
  return { dsn: out, relocated: enc.length !== oldLen, detail: `${ref}: ${which} set to "${text}"` };
}
