import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ProteusProject } from '../dist/proteus/project.js';
import { indexOfAll, int32Bytes } from '../dist/format/bytes.js';
const root = process.argv[2];
async function* walk(d) { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) yield* walk(p); else if (/\.pdsprj$/i.test(e.name)) yield p; } }
const hist = new Map(); const ex = new Map(); const propCtx = new Map(); const propEx = new Map();
for await (const f of walk(root)) {
  const p = await ProteusProject.open(f); const b = p.dsn, m = p.model;
  const known = new Set();
  for (const c of m.components) c.pinRefSlots.forEach(s => known.add(s));
  for (const t of m.terminals) [t.refSlot, ...t.extraRefSlots].forEach(s => known.add(s));
  for (const j of m.junctions) j.refSlots.forEach(s => known.add(s));
  if (m.trailerPointerSlot) known.add(m.trailerPointerSlot);
  const targets = [...m.wires.map(w => w.offset), ...m.sections.map(s => s.offset), m.trailerOffset].filter(Boolean);
  for (const t of targets) for (const pos of indexOfAll(b, int32Bytes(t))) {
    if (known.has(pos) || (m.trailerOffset && pos >= m.trailerOffset)) continue;
    const ctx = b.subarray(Math.max(0, pos - 300), pos).toString('latin1');
    const kinds = [...ctx.matchAll(/\0([A-Z][A-Z ]{2,30})\0/g)].map(x => x[1]);
    const syms = [...ctx.matchAll(/(\$[A-Z0-9_ ]{2,30}|WIRE DOT|BUS WIRE|WIRE)/g)].map(x => x[1]);
    const k = `${kinds.at(-1) ?? '-'} | ${syms.at(-1) ?? '-'}`;
    hist.set(k, (hist.get(k) ?? 0) + 1); if (!ex.has(k)) ex.set(k, `${f} @0x${pos.toString(16)}`);
  }
  for (const w of m.warnings) { const mm = w.match(/PROPERTIES label at 0x([0-9a-f]+) not followed/); if (!mm) continue; const o = parseInt(mm[1], 16);
    const ctx = b.subarray(Math.max(0, o - 400), o).toString('latin1'); const kinds = [...ctx.matchAll(/\0([A-Z][A-Z ]{2,30})\0/g)].map(x => x[1]); const syms = [...ctx.matchAll(/(\$[A-Z0-9_ ]{2,30})/g)].map(x => x[1]);
    const k = `${kinds.at(-1) ?? '-'} | ${syms.at(-1) ?? '-'}`; propCtx.set(k, (propCtx.get(k) ?? 0) + 1); if (!propEx.has(k)) propEx.set(k, `${f} @0x${o.toString(16)}`); }
}
console.log('UNEXPLAINED POINTERS'); for (const [k, n] of [...hist].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(n).padStart(6), k, '  e.g.', ex.get(k).split(/[\/]/).slice(-1)[0]);
console.log('UNPARSED PROPERTIES'); for (const [k, n] of [...propCtx].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(n).padStart(6), k, '  e.g.', propEx.get(k).split(/[\/]/).slice(-1)[0]);
