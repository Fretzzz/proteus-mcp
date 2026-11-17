/** High-level view of a .pdsprj project, built on the format parsers. */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ProjectArchive } from '../format/archive.js';
import { parseDsn, type DsnComponent, type DsnModel } from '../format/dsn.js';
import { cdbPart, cdbPins, cdbRenamePinList, encodeCdbPart, type CdbPin } from '../format/cdb.js';
import { buildNetlist, componentLabel, type Netlist } from '../format/netlist.js';
import { setComponentLabel, setComponentProperties } from '../format/edit.js';
import { formatProperties } from '../format/bytes.js';

export interface ComponentInfo {
  ref: string;
  value: string | null;
  device: string;
  package: string | null;
  sheet: number;
  sheetName: string | null;
  x: number;
  y: number;
  /** Position in inches (Proteus stores 10 nm units; 0.1 in grid = 254000). */
  xInch: number;
  yInch: number;
  rotation: number;
  pinCount: number;
  properties: Record<string, string>;
}

const UNITS_PER_INCH = 2540000;

export class ProteusProject {
  private constructor(
    public readonly archive: ProjectArchive,
    public dsn: Buffer,
    public cdb: Buffer | null,
    public model: DsnModel,
  ) {}

  static async open(file: string): Promise<ProteusProject> {
    if (!/\.pdsprj$/i.test(file)) throw new Error(`expected a .pdsprj file, got ${file}`);
    const archive = await ProjectArchive.open(file);
    const dsn = archive.get('ROOT.DSN');
    if (!dsn) throw new Error(`${file} has no ROOT.DSN`);
    return new ProteusProject(archive, Buffer.from(dsn), archive.get('ROOT.CDB'), parseDsn(Buffer.from(dsn)));
  }

  get file(): string {
    return this.archive.file;
  }

  get dir(): string {
    return path.dirname(this.archive.file);
  }

  pins = (c: DsnComponent): CdbPin[] | null => (this.cdb ? cdbPins(this.cdb, c.objectIndex, c.ref ?? '', c.pinRefs.length) : null);

  packageOf(c: DsnComponent): string | null {
    if (c.properties.PACKAGE) return c.properties.PACKAGE;
    if (this.cdb && c.ref && c.value !== null) return cdbPart(this.cdb, c.ref, c.value, c.device)?.package ?? null;
    return null;
  }

  sheetName(i: number): string | null {
    return this.model.sections[i]?.name ?? null;
  }

  components(): ComponentInfo[] {
    return this.model.components.map((c) => ({
      ref: componentLabel(c),
      value: c.value,
      device: c.device,
      package: this.packageOf(c),
      sheet: c.sheet,
      sheetName: this.sheetName(c.sheet),
      x: c.x,
      y: c.y,
      xInch: +(c.x / UNITS_PER_INCH).toFixed(3),
      yInch: +(c.y / UNITS_PER_INCH).toFixed(3),
      rotation: c.rotation,
      pinCount: c.pinRefs.length,
      properties: c.properties,
    }));
  }

  findComponent(ref: string): DsnComponent {
    const c = this.model.components.find((x) => componentLabel(x) === ref) ?? this.model.components.find((x) => componentLabel(x).toLowerCase() === ref.toLowerCase());
    if (!c) throw new Error(`no component "${ref}". Known: ${this.model.components.map(componentLabel).join(', ')}`);
    return c;
  }

  netlist(): Netlist {
    return buildNetlist(this.model, this.pins);
  }

  projectXml(): Record<string, string> {
    const x = this.archive.getText('PROJECT.XML') ?? '';
    const ts = x.match(/<TIMESTAMP([^>]*)\/>/)?.[1] ?? '';
    const attrs: Record<string, string> = {};
    for (const m of ts.matchAll(/(\w+)="([^"]*)"/g)) attrs[m[1]] = m[2];
    const out: Record<string, string> = {};
    if (attrs.RELEASE) out.proteusRelease = attrs.RELEASE;
    if (attrs.FILEVER) out.fileVersion = attrs.FILEVER;
    if (attrs.CREATED) out.created = new Date(+attrs.CREATED * 1000).toISOString();
    if (attrs.MODIFIED) out.modified = new Date(+attrs.MODIFIED * 1000).toISOString();
    return out;
  }

  /** Resolve a file-valued property (e.g. PROGRAM) relative to the project folder. */
  resolveProjectPath(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.dir, p);
  }

  checkDesign(): { errors: string[]; warnings: string[]; info: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [...this.model.warnings];
    const info: string[] = [];
    const refs = new Map<string, number>();
    for (const c of this.model.components) {
      if (!c.ref) warnings.push(`component ${c.device} (object ${c.objectIndex}) has no reference`);
      else refs.set(c.ref, (refs.get(c.ref) ?? 0) + 1);
      const prog = c.properties.PROGRAM;
      if (prog !== undefined) {
        if (!prog.trim()) errors.push(`${c.ref}: microcontroller has no PROGRAM file set`);
        else if (!/^\$|%/.test(prog) && !existsSync(this.resolveProjectPath(prog)))
          errors.push(`${c.ref}: PROGRAM file not found: ${prog} (resolved ${this.resolveProjectPath(prog)})`);
        else info.push(`${c.ref}: PROGRAM=${prog}${c.properties.CLOCK ? `, CLOCK=${c.properties.CLOCK}` : ''}`);
      }
    }
    for (const [r, n] of refs) if (n > 1) errors.push(`duplicate reference ${r} (${n} components)`);
    const nl = this.netlist();
    warnings.push(...nl.warnings);
    for (const n of nl.nets) {
      if (n.nodes.length === 1 && n.terminals.length === 0)
        warnings.push(`net ${n.name} has a single pin (${n.nodes[0].ref}.${n.nodes[0].pin}): dangling wire?`);
      if (n.nodes.length === 0 && n.terminals.length === 1 && !n.named) warnings.push(`terminal with no connections on sheet ${n.terminals[0].sheet}`);
    }
    const byRef = new Map<string, string[]>();
    for (const u of nl.unconnected) {
      if (!byRef.has(u.ref)) byRef.set(u.ref, []);
      byRef.get(u.ref)!.push(u.pin + (u.number ? `(${u.number})` : ''));
    }
    for (const [r, pins] of byRef) info.push(`${r}: unconnected pins: ${pins.join(', ')}`);
    return { errors, warnings: [...new Set(warnings)], info };
  }

  // ---------- editing ----------

  private reparse(newDsn: Buffer) {
    this.dsn = newDsn;
    this.model = parseDsn(newDsn);
    this.archive.set('ROOT.DSN', newDsn);
  }

  setProperties(ref: string, changes: Record<string, string | null>): string[] {
    const c = this.findComponent(ref);
    const realRef = c.ref ?? ref;
    const notes: string[] = [];
    const r = setComponentProperties(this.dsn, realRef, changes, this.pins);
    notes.push(r.detail);
    // keep ROOT.CDB consistent (it is a cache, but Proteus tools read it)
    if (this.cdb && c.value !== null) {
      const part = cdbPart(this.cdb, realRef, c.value, c.device);
      if (part) {
        const text = formatProperties(part.propertiesText, changes);
        this.cdb = Buffer.concat([this.cdb.subarray(0, part.offset), encodeCdbPart({ ...part, propertiesText: text }), this.cdb.subarray(part.end)]);
        this.archive.set('ROOT.CDB', this.cdb);
        notes.push('ROOT.CDB updated');
      } else notes.push('ROOT.CDB part record not found (Proteus rebuilds it on next save)');
    }
    this.reparse(r.dsn);
    return notes;
  }

  setValue(ref: string, value: string): string[] {
    const c = this.findComponent(ref);
    const realRef = c.ref ?? ref;
    const r = setComponentLabel(this.dsn, realRef, 'COMPONENT VALUE', value, this.pins);
    const notes = [r.detail];
    if (this.cdb && c.value !== null) {
      const part = cdbPart(this.cdb, realRef, c.value, c.device);
      if (part) {
        this.cdb = Buffer.concat([this.cdb.subarray(0, part.offset), encodeCdbPart({ ...part, value }), this.cdb.subarray(part.end)]);
        this.archive.set('ROOT.CDB', this.cdb);
        notes.push('ROOT.CDB updated');
      }
    }
    this.reparse(r.dsn);
    return notes;
  }

  rename(ref: string, newRef: string): string[] {
    const c = this.findComponent(ref);
    const realRef = c.ref ?? ref;
    const r = setComponentLabel(this.dsn, realRef, 'COMPONENT ID', newRef, this.pins);
    const notes = [r.detail];
    if (this.cdb) {
      const renamed = cdbRenamePinList(this.cdb, c.objectIndex, realRef, newRef, c.pinRefs.length);
      if (renamed) this.cdb = renamed;
      if (c.value !== null) {
        const part = cdbPart(this.cdb, realRef, c.value, c.device);
        if (part) this.cdb = Buffer.concat([this.cdb.subarray(0, part.offset), encodeCdbPart({ ...part, ref: newRef }), this.cdb.subarray(part.end)]);
      }
      this.archive.set('ROOT.CDB', this.cdb);
      notes.push('ROOT.CDB updated');
    }
    this.reparse(r.dsn);
    return notes;
  }

  save(opts: { outputPath?: string; backup?: boolean } = {}) {
    return this.archive.save(opts);
  }
}
