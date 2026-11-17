#!/usr/bin/env node
/**
 * proteus-mcp: Model Context Protocol server for Labcenter Proteus 8.
 * Transport: stdio.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProteusProject } from './proteus/project.js';
import { findInstallation, requireInstallation } from './proteus/install.js';
import { loadLibraryIndex, searchDevices } from './proteus/library.js';
import { toSdf } from './proteus/sdf.js';
import { runProspice } from './proteus/simulate.js';
import { openInProteus, launchWithIni } from './proteus/gui.js';
import { readFirmware, isTextEntry } from './proteus/firmware.js';
import { componentLabel } from './format/netlist.js';

const VERSION = '0.1.0';

const server = new McpServer({ name: 'proteus', version: VERSION });

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (data: unknown): Content => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] });
const fail = (e: unknown): Content => ({ content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown>,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } = { readOnlyHint: true },
) {
  server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: any) => {
    try {
      return ok(await run(args));
    } catch (e) {
      return fail(e);
    }
  }) as any);
}

const projectPath = z.string().describe('Path to a Proteus .pdsprj project file');
const writeOpts = {
  outputPath: z.string().optional().describe('Write to this path instead of overwriting the project'),
  backup: z.boolean().optional().describe('When overwriting, first copy the original to <file>.bak (default true)'),
};

async function open(p: string) {
  return ProteusProject.open(path.resolve(p));
}

async function walk(dir: string, recursive: boolean, out: string[], limit: number) {
  let ents;
  try {
    ents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (out.length >= limit) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && !/^(node_modules|\.git|Project Backups)$/i.test(e.name)) await walk(p, recursive, out, limit);
    } else if (/\.pdsprj$/i.test(e.name)) out.push(p);
  }
}

// ---------------------------------------------------------------- installation / discovery

tool('proteus_installation', 'Locate the local Proteus 8 installation: version, program and data folders, simulator and sample paths.', {}, async () => {
  const i = findInstallation();
  if (!i) return { found: false, hint: 'Set PROTEUS_HOME to the folder containing BIN\\PDS.EXE' };
  return { found: true, ...i };
});

tool(
  'list_projects',
  'Find .pdsprj projects in a folder (optionally recursive). Use source "samples" to list the example projects shipped with Proteus.',
  {
    directory: z.string().optional().describe('Folder to search (default: current directory)'),
    source: z.enum(['directory', 'samples']).optional(),
    query: z.string().optional().describe('Case-insensitive filter on the path'),
    recursive: z.boolean().optional(),
    limit: z.number().int().positive().max(2000).optional(),
  },
  async ({ directory, source, query, recursive, limit }) => {
    const dir = source === 'samples' ? requireInstallation().samples : path.resolve(directory ?? '.');
    const out: string[] = [];
    await walk(dir, recursive ?? source === 'samples', out, 5000);
    const q = query?.toLowerCase();
    const list = out.filter((p) => !q || p.toLowerCase().includes(q));
    return { directory: dir, total: list.length, projects: list.slice(0, limit ?? 100) };
  },
);

// ---------------------------------------------------------------- reading designs

tool('project_overview', 'Summarise a project: archive contents, sheets, component/wire/terminal counts, firmware, file metadata and parser warnings.', { path: projectPath }, async ({ path: p }) => {
  const pr = await open(p);
  const m = pr.model;
  const fw = readFirmware(pr.archive);
  return {
    file: pr.file,
    metadata: pr.projectXml(),
    archive: pr.archive.sizes(),
    sheets: m.sections.map((s) => ({
      index: s.index,
      name: s.name,
      components: m.components.filter((c) => c.sheet === s.index).length,
      wires: m.wires.filter((w) => w.sheet === s.index).length,
    })),
    counts: {
      components: m.components.length,
      wires: m.wires.filter((w) => !w.bus).length,
      busWires: m.wires.filter((w) => w.bus).length,
      terminals: m.terminals.length,
      junctions: m.junctions.length,
      wireLabels: m.wires.filter((w) => w.label).length,
      otherLabels: m.otherLabels.length,
    },
    hasPcbLayout: pr.archive.has('ROOT.LYT'),
    firmware: fw ? { family: fw.family, compiler: fw.compiler, processorType: fw.processorType, projects: fw.projects.map((x) => x.name) } : null,
    warnings: m.warnings,
  };
});

tool(
  'list_components',
  'List the parts placed in the schematic with reference, value, library device, package, sheet, position and properties.',
  {
    path: projectPath,
    filter: z.string().optional().describe('Case-insensitive match on reference, value or device'),
    includeProperties: z.boolean().optional().describe('Include each part\'s property map (default true)'),
  },
  async ({ path: p, filter, includeProperties }) => {
    const pr = await open(p);
    const f = filter?.toLowerCase();
    return pr
      .components()
      .filter((c) => !f || [c.ref, c.value ?? '', c.device].some((s) => s.toLowerCase().includes(f)))
      .map((c) => (includeProperties === false ? { ...c, properties: undefined } : c));
  },
);

tool('get_component', 'Full detail of one part: properties, every pin with its name, number and the net it is on.', { path: projectPath, ref: z.string().describe('Reference designator, e.g. U1') }, async ({ path: p, ref }) => {
  const pr = await open(p);
  const c = pr.findComponent(ref);
  const info = pr.components().find((x) => x.ref === componentLabel(c));
  const nl = pr.netlist();
  const netOf = new Map<number, string>();
  for (const n of nl.nets) for (const node of n.nodes) if (node.ref === componentLabel(c)) netOf.set(node.index, n.name);
  const pins = pr.pins(c);
  return {
    ...info,
    propertiesText: c.propertiesText,
    labels: c.labels.map((l) => ({ kind: l.kind, text: l.text, visible: l.visible })),
    pins: c.pinRefs.map((r, k) => ({
      index: k,
      name: pins?.[k]?.name ?? null,
      number: pins?.[k]?.number ?? null,
      net: netOf.get(k) ?? null,
      wired: r !== 0,
    })),
  };
});

tool(
  'get_netlist',
  'Reconstruct the connectivity of the schematic. Formats: "json" (nets with nodes/terminals), "text" (one net per line), "sdf" (Proteus SDF netlist).',
  { path: projectPath, format: z.enum(['json', 'text', 'sdf']).optional(), includeUnconnected: z.boolean().optional() },
  async ({ path: p, format, includeUnconnected }) => {
    const pr = await open(p);
    if (format === 'sdf') return toSdf(pr, { simtype: 'TRANSIENT' });
    const nl = pr.netlist();
    if (format === 'text') {
      const lines = nl.nets.map((n) => `${n.name}: ${n.nodes.map((x) => `${x.ref}.${x.pin}${x.number && x.number !== x.pin ? `(${x.number})` : ''}${x.implicit ? '*' : ''}`).join(' ')}`);
      if (includeUnconnected) lines.push('', 'UNCONNECTED: ' + nl.unconnected.map((x) => `${x.ref}.${x.pin}`).join(' '));
      if (nl.warnings.length) lines.push('', ...nl.warnings.map((w) => 'warning: ' + w));
      lines.push('', '(* = hidden power pin joined by name)');
      return lines.join('\n');
    }
    return { nets: nl.nets, unconnected: includeUnconnected ? nl.unconnected : nl.unconnected.length, busWires: nl.busWires, warnings: nl.warnings };
  },
);

tool(
  'trace_net',
  'Find the net attached to a pin ("U1.P1.0", "U1.12", "R1.1") or a net by name ("VCC"), and list everything on it.',
  { path: projectPath, target: z.string().describe('REF.PIN (pin name or number) or a net name') },
  async ({ path: p, target }) => {
    const pr = await open(p);
    const nl = pr.netlist();
    const t = target.trim();
    let net = nl.nets.find((n) => n.name.toLowerCase() === t.toLowerCase());
    if (!net) {
      const dot = t.indexOf('.');
      if (dot > 0) {
        const ref = t.slice(0, dot).toLowerCase();
        const pin = t.slice(dot + 1).toLowerCase();
        net = nl.nets.find((n) => n.nodes.some((x) => x.ref.toLowerCase() === ref && (x.pin.toLowerCase() === pin || x.number.toLowerCase() === pin || x.pin.toLowerCase().split('/').includes(pin))));
        if (!net) {
          const u = nl.unconnected.find((x) => x.ref.toLowerCase() === ref && (x.pin.toLowerCase() === pin || x.number.toLowerCase() === pin));
          if (u) return { target, connected: false, pin: u };
        }
      }
    }
    if (!net) throw new Error(`nothing matches "${target}"`);
    return net;
  },
);

tool(
  'get_bom',
  'Bill of materials grouped by device + value + package (or one row per part).',
  { path: projectPath, format: z.enum(['json', 'csv']).optional(), grouped: z.boolean().optional() },
  async ({ path: p, format, grouped }) => {
    const pr = await open(p);
    const comps = pr.components().filter((c) => !/^\$/.test(c.device));
    type Row = { quantity: number; refs: string[]; device: string; value: string; package: string };
    const rows: Row[] = [];
    if (grouped === false) for (const c of comps) rows.push({ quantity: 1, refs: [c.ref], device: c.device, value: c.value ?? '', package: c.package ?? '' });
    else {
      const map = new Map<string, Row>();
      for (const c of comps) {
        const k = `${c.device}|${c.value}|${c.package}`;
        const r = map.get(k) ?? { quantity: 0, refs: [], device: c.device, value: c.value ?? '', package: c.package ?? '' };
        r.quantity++;
        r.refs.push(c.ref);
        map.set(k, r);
      }
      rows.push(...map.values());
    }
    for (const r of rows) r.refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    rows.sort((a, b) => a.refs[0].localeCompare(b.refs[0], undefined, { numeric: true }));
    if (format === 'csv') {
      const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
      return ['Quantity,References,Value,Device,Package', ...rows.map((r) => [r.quantity, q(r.refs.join(' ')), q(r.value), q(r.device), q(r.package)].join(','))].join('\n');
    }
    return rows;
  },
);

tool(
  'check_design',
  'Electrical/design-rule style checks: missing or unreadable microcontroller PROGRAM files, duplicate references, single-pin nets, unconnected pins, parser warnings.',
  { path: projectPath },
  async ({ path: p }) => (await open(p)).checkDesign(),
);

// ---------------------------------------------------------------- editing designs

tool(
  'set_component_properties',
  'Set, add or remove properties of a part (e.g. PROGRAM, CLOCK on a microcontroller, or model parameters). Writes ROOT.DSN and ROOT.CDB; the file is re-parsed and connectivity verified before saving. Close the project in Proteus first.',
  {
    path: projectPath,
    ref: z.string(),
    set: z.record(z.string()).optional().describe('Properties to set, e.g. {"CLOCK":"12MHz"}'),
    remove: z.array(z.string()).optional().describe('Property names to delete'),
    ...writeOpts,
  },
  async ({ path: p, ref, set, remove, outputPath, backup }) => {
    const pr = await open(p);
    const changes: Record<string, string | null> = { ...(set ?? {}) };
    for (const k of remove ?? []) changes[k] = null;
    if (!Object.keys(changes).length) throw new Error('nothing to change');
    const notes = pr.setProperties(ref, changes);
    const saved = await pr.save({ outputPath, backup });
    return { ...saved, notes, properties: pr.findComponent(ref).properties };
  },
  { destructiveHint: true, readOnlyHint: false },
);

tool(
  'set_component_value',
  'Change the value text of a part (e.g. a resistor from 10k to 4k7). Close the project in Proteus first.',
  { path: projectPath, ref: z.string(), value: z.string(), ...writeOpts },
  async ({ path: p, ref, value, outputPath, backup }) => {
    const pr = await open(p);
    const notes = pr.setValue(ref, value);
    return { ...(await pr.save({ outputPath, backup })), notes };
  },
  { destructiveHint: true, readOnlyHint: false },
);

tool(
  'rename_component',
  'Change the reference designator of a part (e.g. R7 -> R2). Close the project in Proteus first.',
  { path: projectPath, ref: z.string(), newRef: z.string(), ...writeOpts },
  async ({ path: p, ref, newRef, outputPath, backup }) => {
    const pr = await open(p);
    const notes = pr.rename(ref, newRef);
    return { ...(await pr.save({ outputPath, backup })), notes };
  },
  { destructiveHint: true, readOnlyHint: false },
);

// ---------------------------------------------------------------- firmware & archive files

tool('list_firmware', 'List firmware (VSM Studio / Visual Designer / Arduino) projects embedded in the design and their source files.', { path: projectPath }, async ({ path: p }) => {
  const pr = await open(p);
  return readFirmware(pr.archive) ?? { firmware: null, note: 'no embedded firmware; check microcontroller PROGRAM properties instead' };
});

tool(
  'read_project_file',
  'Read a text file stored inside the .pdsprj archive (e.g. "FIRMWARE/ATmega328P/main.ino", "PROJECT.XML"). Binary entries are returned as a hex preview.',
  { path: projectPath, entry: z.string(), maxBytes: z.number().int().positive().optional() },
  async ({ path: p, entry, maxBytes }) => {
    const pr = await open(p);
    const k = pr.archive.resolve(entry);
    if (!k) throw new Error(`no entry "${entry}". Entries: ${pr.archive.names().join(', ')}`);
    const b = pr.archive.get(k)!;
    const lim = maxBytes ?? 200000;
    if (isTextEntry(k) && !b.subarray(0, 4096).includes(0)) return { entry: k, size: b.length, truncated: b.length > lim, text: b.toString('utf8', 0, Math.min(lim, b.length)) };
    return { entry: k, size: b.length, binary: true, hexPreview: b.subarray(0, Math.min(512, lim)).toString('hex').replace(/(.{32})/g, '$1\n') };
  },
);

tool(
  'write_project_file',
  'Create or replace a text file inside the archive, e.g. firmware source under FIRMWARE/. ROOT.DSN and ROOT.CDB cannot be written raw (use the component tools). Close the project in Proteus first.',
  { path: projectPath, entry: z.string(), content: z.string(), ...writeOpts },
  async ({ path: p, entry, content, outputPath, backup }) => {
    const pr = await open(p);
    const norm = entry.replace(/\\/g, '/').replace(/^\/+/, '');
    if (/^ROOT\.(DSN|CDB|LYT)$/i.test(norm)) throw new Error(`${norm} is binary; use the component editing tools`);
    if (norm.includes('..')) throw new Error('entry may not contain ".."');
    const existed = pr.archive.has(norm) || !!pr.archive.resolve(norm);
    if (!existed && !/^FIRMWARE\//i.test(norm)) throw new Error('new entries may only be created under FIRMWARE/');
    pr.archive.set(norm, Buffer.from(content, 'utf8'));
    return { ...(await pr.save({ outputPath, backup })), entry: norm, created: !existed, bytes: Buffer.byteLength(content) };
  },
  { destructiveHint: true, readOnlyHint: false },
);

// ---------------------------------------------------------------- library

tool(
  'search_library',
  'Search the installed Proteus device libraries by part name, description, category or manufacturer (e.g. "atmega328", "lcd 16x2", "op amp").',
  { query: z.string(), category: z.string().optional(), limit: z.number().int().positive().max(500).optional() },
  async ({ query, category, limit }) => {
    const i = requireInstallation();
    const devices = await loadLibraryIndex(i.library, i.libraryIndex);
    return { totalDevices: devices.length, results: searchDevices(devices, query, { category, limit }) };
  },
);

// ---------------------------------------------------------------- simulation & GUI

tool(
  'export_sdf',
  'Write the design as an SDF netlist (the text format PROSPICE simulates). Returns the text, and writes it to outputPath if given.',
  { path: projectPath, outputPath: z.string().optional(), tstop: z.string().optional().describe('Transient stop time, e.g. "100m"') },
  async ({ path: p, outputPath, tstop }) => {
    const pr = await open(p);
    const sdf = toSdf(pr, { tstop });
    if (outputPath) await fs.writeFile(path.resolve(outputPath), sdf, 'latin1');
    return outputPath ? { written: path.resolve(outputPath), bytes: sdf.length } : sdf;
  },
  { readOnlyHint: false },
);

tool(
  'simulate',
  "Headless simulator check (no GUI): compiles the design to an SDF netlist and runs Proteus' PROSPICE.EXE on it. Reports whether the simulator accepts the netlist, loads every model and reads microcontroller firmware, plus any model/pin errors. In this graph-based mode PROSPICE only computes what graphs/probes request, so it is a validation run rather than an interactive simulation, and waveform output is not decoded. Use open_in_proteus with autorun for interactive runs.",
  {
    path: projectPath,
    tstop: z.string().describe('Simulation stop time, e.g. "10m" or "1"'),
    timeoutSeconds: z.number().positive().max(600).optional(),
    keepFiles: z.boolean().optional(),
  },
  async ({ path: p, tstop, timeoutSeconds, keepFiles }) => {
    const inst = requireInstallation();
    const pr = await open(p);
    const sdf = toSdf(pr, { tstop });
    const r = await runProspice(inst, sdf, { timeoutMs: (timeoutSeconds ?? 60) * 1000 });
    const summary = {
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
      errors: r.messages.filter((m) => m.level === 'error' || m.level === 'fatal').map((m) => m.text),
      warnings: r.messages.filter((m) => m.level === 'warning').map((m) => m.text),
      log: r.messages.map((m) => `${m.level}: ${m.text}`),
      resultFiles: r.resultFiles,
      workDir: r.workDir,
    };
    if (!keepFiles) await fs.rm(r.workDir, { recursive: true, force: true }).catch(() => undefined);
    return summary;
  },
  { readOnlyHint: true, openWorldHint: false },
);

tool(
  'open_in_proteus',
  'Open the project in the Proteus GUI. With autorun, launches through PDS.EXE\'s integration INI (DESIGNFILE/PROGRAM/AUTORUN) so the simulation starts once loaded.',
  { path: projectPath, autorun: z.boolean().optional(), program: z.string().optional().describe('Firmware file to load into the processor (integration mode)') },
  async ({ path: p, autorun, program }) => {
    const inst = requireInstallation();
    const full = path.resolve(p);
    await fs.access(full);
    if (autorun || program) return { launched: true, mode: 'integration-ini', ...(await launchWithIni(inst, { designFile: full, program, autorun })) };
    return { launched: true, mode: 'direct', pid: await openInProteus(inst, full) };
  },
  { readOnlyHint: false, openWorldHint: true },
);

// ---------------------------------------------------------------- low level (for further reverse engineering)

tool(
  'inspect_records',
  'Low-level view of ROOT.DSN as decoded by this server: circuit sections, record offsets and raw label data. Useful when extending the format support.',
  { path: projectPath, kind: z.enum(['sections', 'components', 'wires', 'terminals', 'junctions', 'labels']), limit: z.number().int().positive().optional() },
  async ({ path: p, kind, limit }) => {
    const pr = await open(p);
    const m = pr.model;
    const hex = (n: number) => '0x' + n.toString(16);
    const lim = limit ?? 200;
    switch (kind) {
      case 'sections':
        return { size: m.size, trailerOffset: m.trailerOffset !== null ? hex(m.trailerOffset) : null, sections: m.sections.map((s) => ({ ...s, offset: hex(s.offset), objectStart: hex(s.objectStart), objectEnd: hex(s.objectEnd) })) };
      case 'components':
        return m.components.slice(0, lim).map((c) => ({ ref: c.ref, device: c.device, offset: hex(c.offset), objectIndex: c.objectIndex, flags: c.flags, propsStorage: c.propsStorage.kind, pinRefs: c.pinRefs.map((r) => (r ? hex(r) : 0)) }));
      case 'wires':
        return m.wires.slice(0, lim).map((w) => ({ offset: hex(w.offset), sheet: w.sheet, bus: w.bus, label: w.label?.text ?? null, points: w.points }));
      case 'terminals':
        return m.terminals.slice(0, lim).map((t) => ({ offset: hex(t.offset), symbol: t.symbol, label: t.label.text, x: t.x, y: t.y, ref: t.ref ? hex(t.ref) : 0 }));
      case 'junctions':
        return m.junctions.slice(0, lim).map((j) => ({ offset: hex(j.offset), x: j.x, y: j.y, refs: j.refs.map((r) => (r ? hex(r) : 0)) }));
      case 'labels':
        return m.otherLabels.slice(0, lim).map((l) => ({ offset: hex(l.offset), kind: l.kind, text: l.text, x: l.x, y: l.y, visible: l.visible }));
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
