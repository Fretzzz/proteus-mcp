/**
 * Firmware embedded in a project by VSM Studio / Visual Designer.
 *
 *   FIRMWARE.XML              <FIRMWARE FAMILY COMPILER TYPE><PROJECTS><STRING>name</STRING>...
 *   FIRMWARE/<name>.XML       <PROJECT NAME TYPE CONFIGURATION BUILDPATH><FILES><FILE GROUP NAME .../>
 *   FIRMWARE/<name>/...       source files (main.ino, *.c, *.asm, ...) and build output (Debug/Debug.elf)
 */
import type { ProjectArchive } from '../format/archive.js';

export interface FirmwareProject {
  name: string;
  type: string | null;
  configuration: string | null;
  files: { name: string; group: string | null; inArchive: boolean }[];
}

export interface FirmwareInfo {
  family: string | null;
  compiler: string | null;
  processorType: string | null;
  projects: FirmwareProject[];
  /** All archive entries under FIRMWARE/. */
  entries: string[];
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function readFirmware(a: ProjectArchive): FirmwareInfo | null {
  const xml = a.getText('FIRMWARE.XML');
  const entries = a.names().filter((n) => /^FIRMWARE\//i.test(n) && !n.endsWith('/'));
  if (!xml && !entries.length) return null;
  const head = xml?.match(/<FIRMWARE\b[^>]*>/)?.[0] ?? '';
  const names = [...(xml ?? '').matchAll(/<STRING>([^<]*)<\/STRING>/g)].map((m) => unescape(m[1]));
  const projects: FirmwareProject[] = names.map((name) => {
    const px = a.getText(`FIRMWARE/${name}.XML`) ?? '';
    const ph = px.match(/<PROJECT\b[^>]*>/)?.[0] ?? '';
    const files = [...px.matchAll(/<FILE\b[^>]*\/?>/g)].map((m) => {
      const fname = unescape(attr(m[0], 'NAME') ?? '');
      const candidates = [`FIRMWARE/${fname}`, `FIRMWARE/${name}/${fname}`];
      return { name: fname, group: attr(m[0], 'GROUP'), inArchive: candidates.some((c) => a.has(c) || !!a.resolve(c)) };
    });
    return { name, type: attr(ph, 'TYPE'), configuration: attr(ph, 'CONFIGURATION'), files };
  });
  return { family: attr(head, 'FAMILY'), compiler: attr(head, 'COMPILER'), processorType: attr(head, 'TYPE'), projects, entries };
}

const TEXT_EXT = /\.(c|h|cpp|hpp|cc|ino|pde|s|asm|a51|inc|txt|py|js|htm|html|css|json|xml|svg|lkr|cmd|ld|mk|bas|chart|ini|md|csv)$/i;

export function isTextEntry(name: string): boolean {
  return TEXT_EXT.test(name) || !/\.[^/]+$/.test(name);
}
