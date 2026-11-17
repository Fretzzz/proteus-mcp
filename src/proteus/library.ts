/**
 * Device library search.
 *
 * DATA\LIBRARY\<NAME>.LIB  : "DEVICE LIBRARY\x1a" ; u32@0x18 = device count ;
 *                            directory at 0x20 of 0x50-byte entries, each starting with a NUL-padded name.
 * DATA\Library Indexing\<hash>#<NAME>.IDX : "DEVICE LIBRARY INDEX\x1a" ; u32@0x24 = count ;
 *                            entries from 0x28: u32 stamp, 6 C strings
 *                            (category, ?, sub-category, manufacturer, ?, description), u32.
 * Index entries are in the same order as the library directory.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface LibraryDevice {
  name: string;
  library: string;
  category: string;
  subcategory: string;
  manufacturer: string;
  description: string;
}

async function readDirectory(file: string): Promise<string[]> {
  const fh = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(0x20);
    await fh.read(head, 0, 0x20, 0);
    if (head.toString('latin1', 0, 14) !== 'DEVICE LIBRARY') return [];
    const n = head.readUInt32LE(0x18);
    if (n > 100000) return [];
    const dir = Buffer.alloc(n * 0x50);
    await fh.read(dir, 0, dir.length, 0x20);
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * 0x50;
      const e = dir.indexOf(0, o);
      names.push(dir.toString('latin1', o, e < 0 || e > o + 64 ? o + 64 : e));
    }
    return names;
  } finally {
    await fh.close();
  }
}

function parseIndex(b: Buffer): Omit<LibraryDevice, 'name' | 'library'>[] {
  if (b.toString('latin1', 0, 20) !== 'DEVICE LIBRARY INDEX') return [];
  const n = b.readUInt32LE(0x24);
  const out: Omit<LibraryDevice, 'name' | 'library'>[] = [];
  let o = 0x28;
  const cs = () => {
    const e = b.indexOf(0, o);
    const s = b.toString('latin1', o, e);
    o = e + 1;
    return s;
  };
  for (let i = 0; i < n && o + 4 < b.length; i++) {
    o += 4;
    const [category, , subcategory, manufacturer, , description] = [cs(), cs(), cs(), cs(), cs(), cs()];
    o += 4;
    out.push({ category, subcategory, manufacturer, description });
  }
  return out;
}

let cache: { key: string; devices: LibraryDevice[] } | null = null;

export async function loadLibraryIndex(libraryDir: string, indexDir: string): Promise<LibraryDevice[]> {
  const key = libraryDir + '|' + indexDir;
  if (cache && cache.key === key) return cache.devices;
  const libs = (await fs.readdir(libraryDir)).filter((f) => /\.LIB$/i.test(f));
  let idxFiles: string[] = [];
  try {
    idxFiles = await fs.readdir(indexDir);
  } catch {
    /* no index folder */
  }
  const devices: LibraryDevice[] = [];
  for (const lib of libs) {
    const names = await readDirectory(path.join(libraryDir, lib)).catch(() => []);
    const idxName = idxFiles.find((f) => f.toUpperCase().endsWith('#' + lib.replace(/\.LIB$/i, '.IDX').toUpperCase()));
    let meta: ReturnType<typeof parseIndex> = [];
    if (idxName) meta = parseIndex(await fs.readFile(path.join(indexDir, idxName)).catch(() => Buffer.alloc(0)));
    const aligned = meta.length === names.length;
    names.forEach((name, i) => {
      const m = aligned ? meta[i] : undefined;
      devices.push({
        name,
        library: lib.replace(/\.LIB$/i, ''),
        category: m?.category ?? '',
        subcategory: m?.subcategory ?? '',
        manufacturer: m?.manufacturer ?? '',
        description: m?.description ?? '',
      });
    });
  }
  cache = { key, devices };
  return devices;
}

export function searchDevices(devices: LibraryDevice[], query: string, opts: { category?: string; limit?: number } = {}): LibraryDevice[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const cat = opts.category?.toLowerCase();
  const scored: { d: LibraryDevice; s: number }[] = [];
  for (const d of devices) {
    if (cat && !d.category.toLowerCase().includes(cat) && !d.subcategory.toLowerCase().includes(cat)) continue;
    const name = d.name.toLowerCase();
    const hay = `${name} ${d.description} ${d.category} ${d.subcategory} ${d.manufacturer} ${d.library}`.toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    let s = 0;
    for (const t of terms) s += name === t ? 100 : name.startsWith(t) ? 40 : name.includes(t) ? 20 : 1;
    if (d.name.endsWith('.BUS')) s -= 5;
    scored.push({ d, s });
  }
  scored.sort((a, b) => b.s - a.s || a.d.name.localeCompare(b.d.name));
  return scored.slice(0, opts.limit ?? 25).map((x) => x.d);
}
