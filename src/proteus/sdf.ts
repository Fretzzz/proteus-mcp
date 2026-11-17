/**
 * Writer for ISIS Schematic Description Format (SDF), the text netlist PROSPICE.EXE simulates.
 *
 * Layout (from SDF files Proteus generated, format 4.5 - 8.0):
 *   ISIS SCHEMATIC DESCRIPTION FORMAT 8.0 / header lines
 *   *PROPERTIES,n   KEY=VALUE simulator options (SIMTYPE, TSTART, TSTOP, PARTITION, ...)
 *   *MODELDEFS,n    NAME : params   (interface models: TTL, CMOS, 8051, AVR, ...)
 *   *PARTLIST,n     REF,DEVICE,VALUE,KEY=VALUE,...
 *   *NETLIST,n      NAME,count \n [NAME,<terminal type>] \n REF,<pin type>,PIN ...
 *   *GATES,0
 * Pin types seen: PS passive, IP input, OP output, IO bidirectional, PP power pin.
 * Terminal markers: GT generic, IT input, OT output, BT bidirectional, PR power rail.
 *
 * This writer produces a flat netlist straight from the schematic. It does not perform the
 * model expansion Proteus' own netlist compiler does (MODFILE sub-circuits, *MODELDEFS from
 * the library), so it is suited to designs built from primitive and DLL-modelled parts.
 */
import type { ProteusProject } from './project.js';
import { componentLabel } from '../format/netlist.js';

export interface SdfOptions {
  title?: string;
  simtype?: 'TRANSIENT' | 'INTERACTIVE' | string;
  tstart?: string;
  tstop?: string;
  partition?: string;
  extraProperties?: Record<string, string>;
  /** Interface model definitions to emit in *MODELDEFS, NAME -> parameter string. */
  modelDefs?: Record<string, string>;
}

const quote = (v: string) => (/[,\s"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const TERMINAL_MARK: Record<string, string> = { input: 'IT', output: 'OT', bidir: 'BT', power: 'PR', ground: 'PR', default: 'GT' };

function pinType(primitive: string | undefined, implicit: boolean): string {
  if (implicit) return 'PP';
  const p = (primitive ?? '').toUpperCase();
  if (/ANALOG|PASSIVE/.test(p) || p === '') return 'PS';
  return 'IO';
}

export function toSdf(project: ProteusProject, opts: SdfOptions = {}): string {
  const nl = project.netlist();
  const now = new Date();
  const d = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
  const props: Record<string, string> = {};
  if (opts.simtype ?? 'TRANSIENT') props.SIMTYPE = opts.simtype ?? 'TRANSIENT';
  props.TSTART = opts.tstart ?? '0';
  if (opts.tstop) props.TSTOP = opts.tstop;
  props.PARTITION = opts.partition ?? Math.floor(Math.random() * 0xffffffff).toString(16).toUpperCase().padStart(8, '0');
  Object.assign(props, opts.extraProperties ?? {});

  const lines: string[] = [];
  lines.push('ISIS SCHEMATIC DESCRIPTION FORMAT 8.0', '=====================================');
  lines.push(`Design:   ${opts.title ?? project.file.split(/[\\/]/).pop()}`, 'Doc. no.: <NONE>', 'Revision: <NONE>', 'Author:   <NONE>');
  lines.push(`Created:  ${d}`, `Modified: ${d}`, '');
  const pk = Object.keys(props).sort();
  lines.push(`*PROPERTIES,${pk.length}`, ...pk.map((k) => `${k}=${props[k]}`), '');
  const md = Object.entries(opts.modelDefs ?? {});
  lines.push(`*MODELDEFS,${md.length}`, ...md.map(([k, v]) => `${k} : ${v}`), '');

  const parts = project.model.components.filter((c) => c.ref);
  const primByRef = new Map<string, string | undefined>();
  const partLines = parts
    .map((c) => {
      const p: Record<string, string> = { ...c.properties, EID: c.objectIndex.toString(16).toUpperCase() };
      for (const k of ['PROGRAM', 'MODFILE']) {
        const v = p[k];
        if (k === 'PROGRAM' && v && !/^[A-Za-z]:|^[\\/]/.test(v)) p[k] = project.resolveProjectPath(v);
      }
      primByRef.set(componentLabel(c), p.PRIMITIVE);
      const kv = Object.keys(p)
        .sort()
        .map((k) => `${k}=${quote(p[k])}`)
        .join(',');
      return `${quote(componentLabel(c))},${quote(c.device)},${quote(c.value ?? '')}${kv ? ',' + kv : ''}`;
    })
    .sort();
  lines.push(`*PARTLIST,${partLines.length}`, ...partLines, '');

  const netBlocks: string[] = [];
  for (const n of nl.nets) {
    const body: string[] = [];
    const marks = new Set(n.terminals.map((t) => TERMINAL_MARK[t.kind] ?? 'GT'));
    if (n.named) for (const m of marks) body.push(`${quote(n.name)},${m}`);
    for (const node of n.nodes) body.push(`${quote(node.ref)},${pinType(primByRef.get(node.ref), !!node.implicit)},${quote(node.pin)}`);
    if (!n.nodes.length) continue;
    netBlocks.push(`${quote(n.name)},${body.length}\n${body.join('\n')}`);
  }
  // Models look up every pin they own, so unconnected pins are listed as one-node nets
  // (Proteus' own netlist compiler does the same).
  let next = nl.nets.filter((n) => !n.named).length;
  for (const u of nl.unconnected) {
    if (!primByRef.has(u.ref)) continue;
    const name = `#${String(next++).padStart(5, '0')}`;
    netBlocks.push(`${name},1\n${quote(u.ref)},${pinType(primByRef.get(u.ref), false)},${quote(u.pin)}`);
  }
  lines.push(`*NETLIST,${netBlocks.length}`, netBlocks.join('\n\n'), '', '*GATES,0', '', '');
  return lines.join('\r\n').replace(/\n/g, '\r\n').replace(/\r\r/g, '\r');
}
