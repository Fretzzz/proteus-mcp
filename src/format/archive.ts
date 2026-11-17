/** .pdsprj container: a ZIP holding PROJECT.XML, ROOT.DSN, ROOT.CDB, firmware and scripts. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export class ProjectArchive {
  private constructor(
    public readonly file: string,
    private entries: Map<string, Uint8Array>,
  ) {}

  static async open(file: string): Promise<ProjectArchive> {
    const data = await fs.readFile(file);
    let raw: Record<string, Uint8Array>;
    try {
      raw = unzipSync(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } catch (e) {
      throw new Error(`${file} is not a Proteus 8 project (.pdsprj is a ZIP archive): ${(e as Error).message}`);
    }
    return new ProjectArchive(path.resolve(file), new Map(Object.entries(raw)));
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Case-insensitive lookup of an entry name. */
  resolve(name: string): string | null {
    if (this.entries.has(name)) return name;
    const n = name.replace(/\\/g, '/').toLowerCase();
    for (const k of this.entries.keys()) if (k.toLowerCase() === n) return k;
    return null;
  }

  get(name: string): Buffer | null {
    const k = this.resolve(name);
    if (!k) return null;
    const v = this.entries.get(k)!;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  getText(name: string): string | null {
    const k = this.resolve(name);
    return k ? strFromU8(this.entries.get(k)!) : null;
  }

  set(name: string, data: Buffer | Uint8Array | string): void {
    const k = this.resolve(name) ?? name.replace(/\\/g, '/');
    this.entries.set(k, typeof data === 'string' ? strToU8(data) : new Uint8Array(data));
  }

  delete(name: string): boolean {
    const k = this.resolve(name);
    return k ? this.entries.delete(k) : false;
  }

  sizes(): { name: string; size: number }[] {
    return [...this.entries].map(([name, v]) => ({ name, size: v.byteLength }));
  }

  /**
   * Write the archive. By default overwrites the source after copying it to `<file>.bak`.
   * Writes to a temp file first so a failure never leaves a truncated project.
   */
  async save(opts: { outputPath?: string; backup?: boolean } = {}): Promise<{ path: string; backup: string | null }> {
    const out = path.resolve(opts.outputPath ?? this.file);
    const zipped = zipSync(Object.fromEntries(this.entries), { level: 6 });
    let backup: string | null = null;
    if ((opts.backup ?? true) && out === this.file) {
      backup = this.file + '.bak';
      await fs.copyFile(this.file, backup);
    }
    const tmp = out + '.tmp-' + process.pid;
    await fs.writeFile(tmp, zipped);
    await fs.rename(tmp, out);
    return { path: out, backup };
  }
}
