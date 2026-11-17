// Robustness run over every .pdsprj under a folder (default: the Proteus SAMPLES folder).
// Parses each design, builds its netlist, and performs in-memory edits that force pointer
// relocation, verifying the re-parsed result. Nothing is written to disk.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProteusProject } from '../dist/proteus/project.js';
import { findInstallation } from '../dist/proteus/install.js';

const root = process.argv[2] ?? findInstallation()?.samples;
if (!root) throw new Error('pass a folder or install Proteus');

async function* walk(d) {
  for (const e of await fs.readdir(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.pdsprj$/i.test(e.name)) yield p;
  }
}

const stats = { files: 0, openFail: 0, components: 0, wires: 0, terminals: 0, junctions: 0, nets: 0, withWarnings: 0, noPins: 0, editOk: 0, editRefused: 0, editBroken: 0, editSkipped: 0 };
const warnKinds = new Map();
const failures = [];
for await (const f of walk(root)) {
  stats.files++;
  let p;
  try {
    p = await ProteusProject.open(f);
  } catch (e) {
    stats.openFail++;
    failures.push(`${f}: ${e.message}`);
    continue;
  }
  const m = p.model;
  stats.components += m.components.length;
  stats.wires += m.wires.length;
  stats.terminals += m.terminals.length;
  stats.junctions += m.junctions.length;
  const nl = p.netlist();
  stats.nets += nl.nets.length;
  const warns = [...m.warnings, ...nl.warnings];
  if (warns.length) stats.withWarnings++;
  for (const w of warns) {
    const k = w.replace(/0x[0-9a-f]+/g, 'X').replace(/"[^"]*"/g, '"…"').replace(/for \S+ \([^)]*\)/, 'for … (…)').replace(/\d+/g, 'N');
    warnKinds.set(k, (warnKinds.get(k) ?? 0) + 1);
  }
  if (nl.warnings.some((w) => w.startsWith('no pin names'))) stats.noPins++;

  // edit round trip on the first referenced component
  const c = m.components.find((x) => x.ref && x.value !== null && m.components.filter((y) => y.ref === x.ref).length === 1);
  if (!c) { stats.editSkipped++; continue; }
  try {
    p.setProperties(c.ref, { MCP_TEST: 'relocation-check-' + 'x'.repeat(40) });
    p.setValue(c.ref, (c.value ?? '') + '_EDITED');
    const again = p.model.components.find((x) => x.ref === c.ref);
    if (again?.properties.MCP_TEST?.startsWith('relocation-check') && again.value?.endsWith('_EDITED')) stats.editOk++;
    else { stats.editBroken++; failures.push(`${f}: edit not visible after reparse`); }
  } catch (e) {
    if (/refusing to edit/.test(e.message)) stats.editRefused++;
    else { stats.editBroken++; failures.push(`${f}: ${e.message}`); }
  }
}
console.log(stats);
console.log('warning kinds:');
for (const [k, n] of [...warnKinds].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(String(n).padStart(6), k);
console.log('failures:', failures.length);
for (const x of failures.slice(0, 30)) console.log('  ', x);
