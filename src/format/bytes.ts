/** Small helpers for reading Proteus' little-endian binary structures. */

export const LATIN1 = 'latin1' as const;

export function i32(b: Buffer, o: number): number {
  return b.readInt32LE(o);
}

export function u32(b: Buffer, o: number): number {
  return b.readUInt32LE(o);
}

export function u16(b: Buffer, o: number): number {
  return b.readUInt16LE(o);
}

export function inBounds(b: Buffer, o: number, n = 1): boolean {
  return o >= 0 && o + n <= b.length;
}

/** Printable for names/fonts: ASCII 0x20..0x7e. */
export function isPrintable(c: number): boolean {
  return c >= 0x20 && c < 0x7f;
}

/** Text that may appear in labels/property blocks (adds tab/CR/LF and latin1 high range). */
export function isTextByte(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c !== 0x7f && c !== 0xff);
}

export function readCString(b: Buffer, o: number, max = 256): { value: string; end: number } | null {
  const lim = Math.min(b.length, o + max);
  for (let i = o; i < lim; i++) {
    if (b[i] === 0) return { value: b.toString(LATIN1, o, i), end: i + 1 };
    if (!isPrintable(b[i])) return null;
  }
  return null;
}

/** u8-length-prefixed string. */
export function readPString(b: Buffer, o: number): { value: string; end: number } | null {
  if (!inBounds(b, o)) return null;
  const n = b[o];
  if (!inBounds(b, o + 1, n)) return null;
  return { value: b.toString(LATIN1, o + 1, o + 1 + n), end: o + 1 + n };
}

export function indexOfAll(b: Buffer, needle: Buffer | string, from = 0, to = b.length): number[] {
  const out: number[] = [];
  let p = from - 1;
  for (;;) {
    p = b.indexOf(needle as any, p + 1);
    if (p < 0 || p >= to) break;
    out.push(p);
  }
  return out;
}

export function int32Bytes(v: number): Buffer {
  const x = Buffer.alloc(4);
  x.writeInt32LE(v, 0);
  return x;
}

/** Parse Proteus property text: lines of `{KEY=VALUE}`. */
export function parseProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\{([^=}\n]+)=([^}\n]*)\}/g)) out[m[1].trim()] = m[2];
  return out;
}

/**
 * Apply property changes to Proteus' property text while preserving its exact layout:
 * unchanged lines, blank lines and the trailing newline run are kept byte-for-byte (Proteus
 * treats the newline structure as significant). Changed keys are rewritten in place, removed
 * keys drop their line, and new keys are inserted after the last property line.
 */
export function formatProperties(original: string, changes: Record<string, string | null>): string {
  const lines = original.split('\n');
  const seen = new Set<string>();
  const out: string[] = [];
  let lastProp = -1;
  for (const line of lines) {
    const m = line.match(/^\{([^=}\n]+)=([^}\n]*)\}$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1].trim();
    seen.add(key);
    if (key in changes) {
      const v = changes[key];
      if (v === null) continue;
      out.push(`{${key}=${v}}`);
    } else out.push(line);
    lastProp = out.length - 1;
  }
  const added = Object.entries(changes)
    .filter(([k, v]) => !seen.has(k) && v !== null)
    .map(([k, v]) => `{${k}=${v}}`);
  if (added.length) {
    if (lastProp >= 0) out.splice(lastProp + 1, 0, ...added);
    else if (out.length === 1 && out[0] === '') return added.join('\n') + '\n';
    else out.unshift(...added);
  }
  return out.join('\n');
}
