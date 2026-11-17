// Unit + integration tests. Integration tests use the sample projects of a local Proteus
// install (none are shipped with this repository) and are skipped when Proteus is absent.
// Run: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatProperties, parseProperties } from '../dist/format/bytes.js';
import { ProteusProject } from '../dist/proteus/project.js';
import { findInstallation } from '../dist/proteus/install.js';
import { toSdf } from '../dist/proteus/sdf.js';

test('parseProperties reads {KEY=VALUE} lines', () => {
  assert.deepEqual(parseProperties('{A=1}\n{PROGRAM=fw.hex}\n\n'), { A: '1', PROGRAM: 'fw.hex' });
});

test('formatProperties preserves layout and trailing newlines', () => {
  const t = '{A=1}\n{B=2}\n{C=3}\n\n\n\n\n';
  assert.equal(formatProperties(t, { B: '22' }), '{A=1}\n{B=22}\n{C=3}\n\n\n\n\n');
  assert.equal(formatProperties(t, { D: '4' }), '{A=1}\n{B=2}\n{C=3}\n{D=4}\n\n\n\n\n');
  assert.equal(formatProperties(t, { A: null }), '{B=2}\n{C=3}\n\n\n\n\n');
  assert.equal(formatProperties('', { X: '1' }), '{X=1}\n');
});

const inst = findInstallation();
const sample = process.env.PROTEUS_TEST_PROJECT ?? (inst ? path.join(inst.samples, 'Tutorials', '555.pdsprj') : '');
const haveSample = !!sample && existsSync(sample);

test('parses a real project and builds a netlist', { skip: !haveSample && 'no Proteus sample available' }, async () => {
  const p = await ProteusProject.open(sample);
  assert.ok(p.model.components.length > 0, 'components');
  assert.ok(p.model.wires.length > 0, 'wires');
  const nl = p.netlist();
  assert.ok(nl.nets.length > 0, 'nets');
  for (const c of p.model.components) for (const r of c.pinRefs) if (r) assert.ok(p.model.wires.some((w) => w.offset === r), 'pin refs resolve to wires');
  assert.match(toSdf(p, { tstop: '1m' }), /\*NETLIST,\d+/);
});

test('relocating edits round-trip and keep connectivity', { skip: !haveSample && 'no Proteus sample available' }, async () => {
  const p = await ProteusProject.open(sample);
  const before = p.netlist().nets.length;
  const c = p.model.components.find((x) => x.ref && p.model.components.filter((y) => y.ref === x.ref).length === 1);
  assert.ok(c);
  p.setProperties(c.ref, { MCP_TEST: 'x'.repeat(50) });
  p.rename(c.ref, c.ref + '_RENAMED');
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'proteus-mcp-test-')), 'edited.pdsprj');
  await p.save({ outputPath: out, backup: false });
  const q = await ProteusProject.open(out);
  const e = q.model.components.find((x) => x.ref === c.ref + '_RENAMED');
  assert.ok(e, 'renamed component found');
  assert.equal(e.properties.MCP_TEST, 'x'.repeat(50));
  assert.equal(q.netlist().nets.length, before);
});
