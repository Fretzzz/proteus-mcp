/** Locate a Proteus 8 installation on this machine. */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export interface Installation {
  root: string;
  bin: string;
  data: string;
  version: string | null;
  product: string | null;
  exe: string;
  prospice: string;
  samples: string;
  library: string;
  libraryIndex: string;
  models: string;
}

function regQuery(key: string): string {
  try {
    return execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
  } catch {
    return '';
  }
}

function fromUninstallKeys(): { root: string; version: string | null; product: string | null }[] {
  const out: { root: string; version: string | null; product: string | null }[] = [];
  for (const key of [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]) {
    const text = regQuery(key);
    for (const block of text.split(/\r?\n(?=HKEY_)/)) {
      const name = block.match(/DisplayName\s+REG_SZ\s+(.*)/)?.[1]?.trim();
      if (!name || !/^Proteus\b/i.test(name)) continue;
      const loc = block.match(/InstallLocation\s+REG_SZ\s+(.*)/)?.[1]?.trim();
      const ver = block.match(/DisplayVersion\s+REG_SZ\s+(.*)/)?.[1]?.trim() ?? null;
      if (loc) out.push({ root: loc.replace(/[\\/]+$/, ''), version: ver, product: name });
    }
  }
  return out;
}

function candidates(): { root: string; version: string | null; product: string | null }[] {
  const list: { root: string; version: string | null; product: string | null }[] = [];
  if (process.env.PROTEUS_HOME) list.push({ root: process.env.PROTEUS_HOME, version: null, product: null });
  if (process.platform === 'win32') list.push(...fromUninstallKeys());
  for (const base of ['C:\\Program Files (x86)\\Labcenter Electronics', 'C:\\Program Files\\Labcenter Electronics']) {
    try {
      for (const d of readdirSync(base)) if (/^Proteus/i.test(d)) list.push({ root: path.join(base, d), version: null, product: d });
    } catch {
      /* not present */
    }
  }
  return list;
}

let cached: Installation | null | undefined;

export function findInstallation(): Installation | null {
  if (cached !== undefined) return cached;
  cached = null;
  for (const c of candidates()) {
    const bin = path.join(c.root, 'BIN');
    const exe = path.join(bin, 'PDS.EXE');
    if (!existsSync(exe)) continue;
    // DATA lives next to BIN, or under ProgramData on some installs
    const programData = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'Labcenter Electronics', path.basename(c.root), 'DATA');
    const data = [path.join(c.root, 'DATA'), programData].find((d) => existsSync(d)) ?? path.join(c.root, 'DATA');
    cached = {
      root: c.root,
      bin,
      data,
      version: c.version,
      product: c.product,
      exe,
      prospice: path.join(bin, 'PROSPICE.EXE'),
      samples: path.join(data, 'SAMPLES'),
      library: path.join(data, 'LIBRARY'),
      libraryIndex: path.join(data, 'Library Indexing'),
      models: path.join(data, 'MODELS'),
    };
    break;
  }
  return cached;
}

export function requireInstallation(): Installation {
  const i = findInstallation();
  if (!i) throw new Error('Proteus 8 installation not found. Set PROTEUS_HOME to the folder that contains BIN\\PDS.EXE.');
  return i;
}
