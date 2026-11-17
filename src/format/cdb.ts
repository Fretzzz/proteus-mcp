/**
 * ROOT.CDB: the "component database" Proteus writes next to ROOT.DSN.
 *
 * Two record kinds matter here (see docs/FORMAT.md):
 *   pin list : <u32 objectIndex> <pstr ref> <u32 pinCount> pinCount x (<pstr pinName> <pstr pinNumber>)
 *   part     : <pstr ref> <pstr value> <pstr device> <pstr package> <u32 textLen> <property text>
 * Pin lists use the same pin order as the component's pin table in ROOT.DSN.
 */
import { LATIN1, readPString, u32 } from './bytes.js';

export interface CdbPin {
  name: string;
  number: string;
}

export interface CdbPart {
  offset: number;
  end: number;
  ref: string;
  value: string;
  device: string;
  package: string;
  propertiesText: string;
}

function pstr(s: string): Buffer {
  const b = Buffer.from(s, LATIN1);
  if (b.length > 255) throw new Error(`string too long for CDB (max 255 bytes): ${s.slice(0, 40)}...`);
  return Buffer.concat([Buffer.from([b.length]), b]);
}

/** Pin names/numbers for a component, or null if the pin list is not found. */
export function cdbPins(cdb: Buffer, objectIndex: number, ref: string, pinCount: number): CdbPin[] | null {
  const key = Buffer.concat([Buffer.alloc(4), pstr(ref)]);
  key.writeUInt32LE(objectIndex >>> 0, 0);
  let p = -1;
  for (;;) {
    p = cdb.indexOf(key, p + 1);
    if (p < 0) return null;
    let o = p + key.length;
    if (o + 4 > cdb.length) return null;
    const n = u32(cdb, o);
    if (n !== pinCount) continue;
    o += 4;
    const pins: CdbPin[] = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const a = readPString(cdb, o);
      if (!a) { ok = false; break; }
      const c = readPString(cdb, a.end);
      if (!c) { ok = false; break; }
      pins.push({ name: a.value, number: c.value });
      o = c.end;
    }
    if (ok) return pins;
  }
}

/** Locate the part record for ref/value/device. */
export function cdbPart(cdb: Buffer, ref: string, value: string, device: string): CdbPart | null {
  let key: Buffer;
  try {
    key = Buffer.concat([pstr(ref), pstr(value), pstr(device)]);
  } catch {
    return null;
  }
  let p = -1;
  for (;;) {
    p = cdb.indexOf(key, p + 1);
    if (p < 0) return null;
    const pkg = readPString(cdb, p + key.length);
    if (!pkg || pkg.end + 4 > cdb.length) continue;
    const len = u32(cdb, pkg.end);
    if (len > 1 << 20 || pkg.end + 4 + len > cdb.length) continue;
    return {
      offset: p,
      end: pkg.end + 4 + len,
      ref,
      value,
      device,
      package: pkg.value,
      propertiesText: cdb.toString(LATIN1, pkg.end + 4, pkg.end + 4 + len),
    };
  }
}

export function encodeCdbPart(p: Omit<CdbPart, 'offset' | 'end'>): Buffer {
  const text = Buffer.from(p.propertiesText, LATIN1);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(text.length);
  return Buffer.concat([pstr(p.ref), pstr(p.value), pstr(p.device), pstr(p.package), len, text]);
}

/** Rename the ref inside a pin-list record. Returns the new buffer or null if not found. */
export function cdbRenamePinList(cdb: Buffer, objectIndex: number, oldRef: string, newRef: string, pinCount: number): Buffer | null {
  const key = Buffer.concat([Buffer.alloc(4), pstr(oldRef)]);
  key.writeUInt32LE(objectIndex >>> 0, 0);
  let p = -1;
  for (;;) {
    p = cdb.indexOf(key, p + 1);
    if (p < 0) return null;
    const o = p + key.length;
    if (o + 4 <= cdb.length && u32(cdb, o) === pinCount) break;
  }
  return Buffer.concat([cdb.subarray(0, p + 4), pstr(newRef), cdb.subarray(p + key.length)]);
}
