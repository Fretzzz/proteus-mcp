/**
 * Parser for ISIS schematic data (ROOT.DSN inside a .pdsprj).
 *
 * The layout was reverse engineered from Proteus 8.13 files; see docs/FORMAT.md.
 * Summary of what this module relies on:
 *
 *   "ISIS SCHEMATIC FILE\x1a"           file magic at offset 0
 *   "DESIGN CONFIGURATION DATA\x1a"     colours, fonts, graphic styles
 *   library section                      device/symbol definitions used by the design
 *   int32 trailerOffset                  absolute pointer, stored right before the first circuit
 *   "ISIS CIRCUIT FILE\x1a" ... "OBJECT DATA\0" <objects> 0xff   (one per sheet / sub-circuit)
 *   trailer                              sheet table (names + absolute section offsets), SPICE options
 *
 * Object records are found by anchoring on their self-describing parts:
 *   - text labels  : ff <len u8> <text> <x i32> <y i32> <24 bytes> ff <vis u8> <font>\0 <LABEL KIND>\0 <4 bytes>
 *   - components   : labels [COMPONENT ID, COMPONENT VALUE, SUBCKT NAME, PROPERTIES] then
 *                    [u16 pinCount][pstr device][x][y][rot i32][objIndex i32][i32][i32][u8][pinCount x i32 wireRef]
 *   - wires/buses  : <tag u8><24-byte graphic style> 02 7f "WIRE"|"BUS WIRE" \0 <u16 hasLabel> [label] <u16 n> n x (x,y)
 *   - terminals    : <tag><x><y><rot><pstr symbol "$TER..."><6 bytes> label "TERMINAL LABEL" <i32 wireRef>
 *   - junctions    : 01 <x> <y> <4 x i32 wireRef>
 *
 * Every "wireRef" is the absolute file offset of a wire record (0 = not connected).
 */
import { LATIN1, i32, u16, inBounds, isPrintable, isTextByte, indexOfAll, readPString, parseProperties } from './bytes.js';

export interface Point {
  x: number;
  y: number;
}

export interface DsnLabel {
  /** Offset of the 0xff marker that starts the label. */
  offset: number;
  /** Offset just after the label (after the 4 trailing bytes). */
  end: number;
  kind: string;
  text: string;
  x: number;
  y: number;
  visible: boolean;
  font: string;
}

export type PropsStorage =
  | { kind: 'none'; lengthOffset: number }
  | { kind: 'inline'; labelOffset: number; lengthOffset: number }
  | { kind: 'block'; lengthOffset: number; textOffset: number; length: number }
  /** Label shows the visible subset inline; the full text follows in a block. */
  | { kind: 'both'; labelOffset: number; lengthOffset: number; textOffset: number; length: number };

export interface DsnComponent {
  sheet: number;
  /** Offset of the first label of the record. */
  offset: number;
  /** Offset just after the pin table. */
  end: number;
  ref: string | null;
  value: string | null;
  device: string;
  x: number;
  y: number;
  /** Rotation in degrees (stored as tenths of a degree). */
  rotation: number;
  objectIndex: number;
  /** Raw orientation/flag words that follow the object index. */
  flags: [number, number, number];
  propertiesText: string;
  properties: Record<string, string>;
  propsStorage: PropsStorage;
  labels: DsnLabel[];
  /** Absolute wire record offset for each pin (0 = unconnected), in symbol pin order. */
  pinRefs: number[];
  /** Absolute offsets of each pinRef slot (for relocation). */
  pinRefSlots: number[];
}

export interface DsnWire {
  sheet: number;
  offset: number;
  end: number;
  bus: boolean;
  label: DsnLabel | null;
  points: Point[];
}

export interface DsnTerminal {
  sheet: number;
  offset: number;
  symbol: string;
  kind: string;
  label: DsnLabel;
  x: number;
  y: number;
  rotation: number;
  ref: number;
  refSlot: number;
  /** Probes and generators have a second wire slot (e.g. a probe dropped onto a wire splits it). */
  extraRefs: number[];
  extraRefSlots: number[];
}

export interface DsnJunction {
  sheet: number;
  offset: number;
  x: number;
  y: number;
  refs: number[];
  refSlots: number[];
}

export interface DsnSection {
  index: number;
  name: string | null;
  offset: number;
  objectStart: number;
  objectEnd: number;
}

export interface DsnModel {
  size: number;
  dates: string[];
  trailerOffset: number | null;
  trailerPointerSlot: number | null;
  sections: DsnSection[];
  components: DsnComponent[];
  wires: DsnWire[];
  terminals: DsnTerminal[];
  junctions: DsnJunction[];
  /** Labels that are not part of components/terminals/wires (probes, generators, scripts...). */
  otherLabels: DsnLabel[];
  /** Size of the fixed component header before the pin table (17 current, 13 older files). */
  componentHeader?: number;
  warnings: string[];
}

const SECTION_MAGIC = Buffer.from('ISIS CIRCUIT FILE\x1a', LATIN1);
const OBJECT_DATA = Buffer.from('OBJECT DATA\0', LATIN1);
const LABEL_FIXED = 24;
const STYLE_HEADER = 0x19;

const LABEL_KINDS = [
  'COMPONENT ID',
  'COMPONENT VALUE',
  'SUBCKT NAME',
  'SUBCKT ID',
  'PROPERTIES',
  'TERMINAL LABEL',
  'WIRE LABEL',
  'VPROBE LABEL',
  'IPROBE LABEL',
  'GENERATOR LABEL',
  'TAPE LABEL',
  'SCRIPT',
  'DESCRIPTION',
  'ACTIVE REGION',
];

/** Records laid out as <X LABEL> <PROPERTIES> [text] <2 bytes> <ref> <ref>. */
const ATTACHMENT_LABELS: Record<string, string> = { 'GENERATOR LABEL': 'generator', 'VPROBE LABEL': 'vprobe', 'IPROBE LABEL': 'iprobe', 'TAPE LABEL': 'tape' };

const COMPONENT_LABELS = new Set(['COMPONENT ID', 'COMPONENT VALUE', 'SUBCKT NAME', 'SUBCKT ID', 'PROPERTIES']);

/**
 * Given the offset of a label-kind string (e.g. "COMPONENT ID"), recover the whole label.
 * Returns null if the bytes around it do not form a valid label.
 */
export function parseLabelAt(b: Buffer, kindOffset: number): DsnLabel | null {
  const kindEnd = b.indexOf(0, kindOffset);
  if (kindEnd < 0) return null;
  const kind = b.toString(LATIN1, kindOffset, kindEnd);
  // font: printable run ending at kindOffset-1 (its NUL)
  if (b[kindOffset - 1] !== 0) return null;
  let fs = kindOffset - 2;
  while (fs >= 0 && isPrintable(b[fs]) && kindOffset - 2 - fs < 64) fs--;
  // b[fs] is the visibility byte, b[fs-1] must be 0xff
  const vis = b[fs];
  if (vis > 1 || b[fs - 1] !== 0xff) return null;
  const font = b.toString(LATIN1, fs + 1, kindOffset - 1);
  if (!font) return null;
  const marker = fs - 1; // the ff before visibility
  const coordsEnd = marker - LABEL_FIXED; // end of x,y
  for (let len = 0; len < 255; len++) {
    const s = coordsEnd - 8 - len - 2;
    if (s < 0) break;
    if (b[s] !== 0xff || b[s + 1] !== len) continue;
    let ok = true;
    for (let k = s + 2; k < s + 2 + len; k++) if (!isTextByte(b[k])) { ok = false; break; }
    if (!ok) continue;
    return {
      offset: s,
      end: kindEnd + 1 + 4,
      kind,
      text: b.toString(LATIN1, s + 2, s + 2 + len),
      x: i32(b, s + 2 + len),
      y: i32(b, s + 6 + len),
      visible: vis === 1,
      font,
    };
  }
  return null;
}

/** Parse a label that starts exactly at `s` (0xff marker). */
export function parseLabelForward(b: Buffer, s: number): DsnLabel | null {
  if (!inBounds(b, s, 2) || b[s] !== 0xff) return null;
  const len = b[s + 1];
  const marker = s + 2 + len + 8 + LABEL_FIXED;
  if (!inBounds(b, marker, 3) || b[marker] !== 0xff || b[marker + 1] > 1) return null;
  const fontEnd = b.indexOf(0, marker + 2);
  if (fontEnd < 0 || fontEnd - marker > 66) return null;
  const kindEnd = b.indexOf(0, fontEnd + 1);
  if (kindEnd < 0 || kindEnd - fontEnd > 40) return null;
  const l = parseLabelAt(b, fontEnd + 1);
  return l && l.offset === s ? l : null;
}

function findSections(b: Buffer, warnings: string[]): { sections: DsnSection[]; trailerOffset: number | null; trailerPointerSlot: number | null } {
  const starts = indexOfAll(b, SECTION_MAGIC);
  const sections: DsnSection[] = [];
  let trailerOffset: number | null = null;
  let trailerPointerSlot: number | null = null;
  if (starts.length && starts[0] >= 4) {
    const t = i32(b, starts[0] - 4);
    if (t > starts[0] && t <= b.length) {
      trailerOffset = t;
      trailerPointerSlot = starts[0] - 4;
    } else warnings.push('trailer pointer before first circuit section not recognised');
  }
  starts.forEach((s, idx) => {
    const od = b.indexOf(OBJECT_DATA, s);
    const next = idx + 1 < starts.length ? starts[idx + 1] : trailerOffset ?? b.length;
    const objectStart = od >= 0 && od < next ? od + OBJECT_DATA.length : next;
    sections.push({ index: idx, name: null, offset: s, objectStart, objectEnd: next });
  });
  // Sheet names: the trailer stores <pstr name> ... <i32 sectionOffset>
  if (trailerOffset !== null) {
    for (const sec of sections) {
      const hits = indexOfAll(b, int32le(sec.offset), trailerOffset, b.length);
      for (const h of hits) {
        const name = nearestPString(b, h, trailerOffset);
        if (name) { sec.name = name; break; }
      }
    }
  }
  return { sections, trailerOffset, trailerPointerSlot };
}

function int32le(v: number): Buffer {
  const x = Buffer.alloc(4);
  x.writeInt32LE(v);
  return x;
}

function nearestPString(b: Buffer, before: number, floor: number): string | null {
  for (let end = before; end > Math.max(floor, before - 24); end--) {
    for (let n = 1; n < 64; n++) {
      const s = end - n - 1;
      if (s < floor) break;
      if (b[s] !== n) continue;
      let ok = true;
      for (let k = s + 1; k < end; k++) if (!isPrintable(b[k])) { ok = false; break; }
      if (ok) return b.toString(LATIN1, s + 1, end);
    }
  }
  return null;
}

export function parseDsn(b: Buffer): DsnModel {
  const warnings: string[] = [];
  if (b.toString(LATIN1, 0, 19) !== 'ISIS SCHEMATIC FILE') warnings.push('missing "ISIS SCHEMATIC FILE" magic');
  const dates = [...b.toString(LATIN1, 0, 0x100).matchAll(/\d\d\/\d\d\/\d\d/g)].map((m) => m[0]);
  const { sections, trailerOffset, trailerPointerSlot } = findSections(b, warnings);

  const model: DsnModel = {
    size: b.length,
    dates,
    trailerOffset,
    trailerPointerSlot,
    sections,
    components: [],
    wires: [],
    terminals: [],
    junctions: [],
    otherLabels: [],
    warnings,
  };

  for (const sec of sections) parseSection(b, sec, model);
  return model;
}

function parseSection(b: Buffer, sec: DsnSection, m: DsnModel): void {
  const { objectStart: from, objectEnd: to } = sec;
  if (to <= from) return;

  // 1. wires and buses
  const wireOffsets = new Set<number>();
  for (const name of ['WIRE', 'BUS WIRE']) {
    const pat = Buffer.from('\x02\x7f' + name + '\0', LATIN1);
    for (const p of indexOfAll(b, pat, from, to)) {
      const nameAt = p + 2;
      const off = nameAt - STYLE_HEADER;
      let o = nameAt + name.length + 1;
      if (!inBounds(b, o, 4)) continue;
      const hasLabel = u16(b, o);
      o += 2;
      let label: DsnLabel | null = null;
      if (hasLabel === 1) {
        label = parseLabelForward(b, o);
        if (!label) { m.warnings.push(`wire label not parsed at 0x${o.toString(16)}`); continue; }
        o = label.end;
      } else if (hasLabel !== 0) continue;
      const n = u16(b, o);
      o += 2;
      if (n < 1 || n > 10000 || !inBounds(b, o, 8 * n)) continue;
      const points: Point[] = [];
      for (let k = 0; k < n; k++) points.push({ x: i32(b, o + 8 * k), y: i32(b, o + 8 * k + 4) });
      m.wires.push({ sheet: sec.index, offset: off, end: o + 8 * n, bus: name === 'BUS WIRE', label, points });
      wireOffsets.add(off);
    }
  }
  const validRef = (v: number) => v === 0 || wireOffsets.has(v);

  // 2. labels by kind
  const labels: DsnLabel[] = [];
  const seen = new Set<number>();
  for (const kind of LABEL_KINDS) {
    const pat = Buffer.from('\0' + kind + '\0', LATIN1);
    for (const p of indexOfAll(b, pat, from, to)) {
      const l = parseLabelAt(b, p + 1);
      if (l && !seen.has(l.offset)) { seen.add(l.offset); labels.push(l); }
    }
  }
  labels.sort((a, c) => a.offset - c.offset);
  const byEnd = new Map<number, DsnLabel>();
  for (const l of labels) byEnd.set(l.end, l);
  const used = new Set<DsnLabel>();
  for (const w of m.wires) if (w.label) for (const l of labels) if (l.offset === w.label.offset) used.add(l);

  // 3. components (anchored on their PROPERTIES label)
  type Pending = { chain: DsnLabel[]; pl: DsnLabel; propertiesText: string; propsStorage: PropsStorage; device: string; r: number; np: number };
  const pending: Pending[] = [];
  for (const pl of labels) {
    if (pl.kind !== 'PROPERTIES') continue;
    const chain: DsnLabel[] = [pl];
    let cur = pl;
    for (;;) {
      const prev = byEnd.get(cur.offset);
      if (!prev || prev.kind === 'PROPERTIES' || !(COMPONENT_LABELS.has(prev.kind) || prev.kind in ATTACHMENT_LABELS)) break;
      chain.unshift(prev);
      cur = prev;
    }
    if (chain[0].kind in ATTACHMENT_LABELS) {
      // generators and probes: properties block, 2 flag bytes, then two wire ref slots
      const gl = chain[0];
      const pb = propsBlock(b, pl);
      const textEnd = pb.hasBlock ? pb.textOffset + pb.length : pb.textOffset;
      const refSlot = textEnd + 2;
      const ref = inBounds(b, refSlot, 4) ? i32(b, refSlot) : 0;
      const ref2 = inBounds(b, refSlot + 4, 4) ? i32(b, refSlot + 4) : 0;
      chain.forEach((l) => used.add(l));
      const sym = symbolBefore(b, gl.offset);
      m.terminals.push({
        sheet: sec.index,
        offset: sym ? sym.start : gl.offset,
        symbol: sym?.name ?? '?',
        kind: ATTACHMENT_LABELS[gl.kind],
        label: gl,
        x: gl.x,
        y: gl.y,
        rotation: 0,
        ref: validRef(ref) ? ref : 0,
        refSlot,
        extraRefs: [validRef(ref2) ? ref2 : 0],
        extraRefSlots: [refSlot + 4],
      });
      if (!validRef(ref)) m.warnings.push(`${ATTACHMENT_LABELS[gl.kind]} "${gl.text}" at 0x${gl.offset.toString(16)}: ref does not point at a wire`);
      continue;
    }
    const lengthOffset = pl.end;
    if (!inBounds(b, lengthOffset, 4)) continue;
    const pb = propsBlock(b, pl);
    const L = pb.length;
    let o = pb.textOffset;
    let propertiesText = pl.text;
    let propsStorage: PropsStorage;
    if (pb.hasBlock) {
      propertiesText = b.toString(LATIN1, o, o + L);
      propsStorage = pl.text === '' ? { kind: 'block', lengthOffset, textOffset: o, length: L } : { kind: 'both', labelOffset: pl.offset, lengthOffset, textOffset: o, length: L };
      o += L;
    } else if (pl.text !== '') {
      propsStorage = { kind: 'inline', labelOffset: pl.offset, lengthOffset };
    } else propsStorage = { kind: 'none', lengthOffset };

    if (!inBounds(b, o, 3)) continue;
    const np = u16(b, o);
    const dev = readPString(b, o + 2);
    if (!dev || np > 4096 || dev.value.length === 0 || ![...dev.value].every((ch) => isTextByte(ch.charCodeAt(0)) && ch.charCodeAt(0) >= 0x20)) {
      m.warnings.push(`PROPERTIES label at 0x${pl.offset.toString(16)} not followed by a component body`);
      continue;
    }
    chain.forEach((l) => used.add(l));
    pending.push({ chain, pl, propertiesText, propsStorage, device: dev.value, r: dev.end, np });
  }

  // The fixed header between position and pin table is 17 bytes in current files and 13 in
  // older ones (no second flag word). Pick per component when the refs decide it, else use
  // the size most components in this file agree on.
  const refsAt = (p: Pending, hdr: number): number[] | null => {
    const start = p.r + 8 + hdr;
    if (!inBounds(b, start, 4 * p.np)) return null;
    const refs: number[] = [];
    for (let k = 0; k < p.np; k++) refs.push(i32(b, start + 4 * k));
    return refs;
  };
  const HDRS = [17, 13];
  const votes = new Map<number, number>();
  const decided = new Map<Pending, number>();
  for (const p of pending) {
    const fits = HDRS.filter((h) => {
      const refs = refsAt(p, h);
      return refs !== null && refs.every(validRef) && refs.some((v) => v !== 0);
    });
    if (fits.length === 1) {
      decided.set(p, fits[0]);
      votes.set(fits[0], (votes.get(fits[0]) ?? 0) + 1);
    }
  }
  const fileHdr = [...votes].sort((a, c) => c[1] - a[1])[0]?.[0] ?? m.componentHeader ?? 17;
  if (votes.size) m.componentHeader = fileHdr;
  for (const p of pending) {
    const hdr = decided.get(p) ?? fileHdr;
    const refs = refsAt(p, hdr) ?? [];
    const start = p.r + 8 + hdr;
    if (!refs.every(validRef)) m.warnings.push(`component ${p.device} at 0x${p.pl.offset.toString(16)}: pin refs do not all point at wires`);
    const get = (k: string) => p.chain.find((l) => l.kind === k)?.text ?? null;
    const r = p.r;
    m.components.push({
      sheet: sec.index,
      offset: p.chain[0].offset,
      end: start + 4 * p.np,
      ref: get('COMPONENT ID'),
      value: get('COMPONENT VALUE'),
      device: p.device,
      x: i32(b, r),
      y: i32(b, r + 4),
      rotation: i32(b, r + 8) / 10,
      objectIndex: i32(b, r + 12),
      flags: hdr === 17 ? [i32(b, r + 16), i32(b, r + 20), b[r + 24]] : [i32(b, r + 16), 0, b[r + 20]],
      propertiesText: p.propertiesText,
      properties: parseProperties(p.propertiesText),
      propsStorage: p.propsStorage,
      labels: p.chain,
      pinRefs: refs.map((v) => (validRef(v) ? v : 0)),
      pinRefSlots: refs.map((_, k) => start + 4 * k),
    });
  }

  // 4. terminals
  for (const l of labels) {
    if (l.kind !== 'TERMINAL LABEL') continue;
    used.add(l);
    const symEnd = l.offset - 6;
    let symbol = '';
    let symStart = -1;
    for (let n = 1; n < 64; n++) {
      const s = symEnd - n - 1;
      if (s < 0) break;
      if (b[s] === n && b[s + 1] === 0x24 /* $ */) {
        symbol = b.toString(LATIN1, s + 1, symEnd);
        symStart = s;
        break;
      }
    }
    const refSlot = l.end;
    const ref = inBounds(b, refSlot, 4) ? i32(b, refSlot) : 0;
    const base = symStart - 12;
    const ok = symStart > 0 && base >= 0;
    m.terminals.push({
      sheet: sec.index,
      offset: ok ? base - 1 : l.offset,
      symbol: symbol || '?',
      kind: terminalKind(symbol),
      label: l,
      x: ok ? i32(b, base) : l.x,
      y: ok ? i32(b, base + 4) : l.y,
      rotation: ok ? i32(b, base + 8) / 10 : 0,
      ref: validRef(ref) ? ref : 0,
      refSlot,
      extraRefs: [],
      extraRefSlots: [],
    });
    if (!validRef(ref)) m.warnings.push(`terminal "${l.text}" at 0x${l.offset.toString(16)}: ref does not point at a wire`);
  }

  // 5. junction / connection nodes: 01 x y r1 r2 r3 r4 (refs to wires, unused slots 0)
  if (wireOffsets.size) {
    const W = [...wireOffsets];
    const candidates = new Set<number>();
    for (const w of W) for (const p of indexOfAll(b, int32le(w), from, to)) candidates.add(p);
    const known = new Set<number>();
    for (const c of m.components) if (c.sheet === sec.index) c.pinRefSlots.forEach((s) => known.add(s));
    for (const t of m.terminals) if (t.sheet === sec.index) [t.refSlot, ...t.extraRefSlots].forEach((s) => known.add(s));
    const tried = new Set<number>();
    for (const p of [...candidates].sort((a, c) => a - c)) {
      if (known.has(p)) continue;
      // p is one of the 4 ref slots; try each alignment
      for (let k = 0; k < 4; k++) {
        const start = p - 9 - 4 * k;
        if (start < from || tried.has(start)) continue;
        if (b[start] !== 0x01 || !inBounds(b, start, 25)) continue;
        const refs = [0, 1, 2, 3].map((j) => i32(b, start + 9 + 4 * j));
        if (!refs.every(validRef) || refs.filter((v) => v).length < 1) continue;
        tried.add(start);
        const refSlots = [0, 1, 2, 3].map((j) => start + 9 + 4 * j);
        refSlots.forEach((s) => known.add(s));
        m.junctions.push({ sheet: sec.index, offset: start, x: i32(b, start + 1), y: i32(b, start + 5), refs, refSlots });
        break;
      }
    }
  }

  for (const l of labels) if (!used.has(l)) m.otherLabels.push(l);
}

/**
 * The PROPERTIES label is followed by <i32 L>. A block of L bytes of property text follows
 * unless the label already carries exactly that text inline (then L == inline length).
 */
function propsBlock(b: Buffer, pl: DsnLabel): { hasBlock: boolean; length: number; textOffset: number } {
  const L = inBounds(b, pl.end, 4) ? i32(b, pl.end) : 0;
  const o = pl.end + 4;
  const fits = L > 0 && L < 1 << 20 && inBounds(b, o, L);
  const inlineLen = Buffer.byteLength(pl.text, LATIN1);
  const hasBlock = fits && (inlineLen === 0 || L !== inlineLen || b[o] === 0x7b);
  return { hasBlock, length: L, textOffset: o };
}

/** A "$SYMBOL" pascal string ending right before `labelStart` (or 6 bytes before it). */
function symbolBefore(b: Buffer, labelStart: number): { name: string; start: number } | null {
  for (const gap of [0, 6]) {
    const end = labelStart - gap;
    for (let n = 1; n < 64; n++) {
      const s = end - n - 1;
      if (s < 0) break;
      if (b[s] === n && b[s + 1] === 0x24) {
        const name = b.toString(LATIN1, s + 1, end);
        if ([...name].every((ch) => isPrintable(ch.charCodeAt(0)))) return { name, start: s };
      }
    }
  }
  return null;
}

export function terminalKind(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.startsWith('$TER')) return s.slice(4).toLowerCase() || 'default';
  return s.replace(/^\$/, '').toLowerCase();
}
