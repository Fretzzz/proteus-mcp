import { ProjectArchive } from '../dist/format/archive.js';
const a = await ProjectArchive.open(process.argv[2]);
const b = a.get(process.argv[3] ?? 'ROOT.DSN');
const from = parseInt(process.argv[4], 16), len = parseInt(process.argv[5] ?? '100', 16);
for (let o = from; o < from + len; o += 16) {
  const s = b.subarray(o, Math.min(o + 16, b.length));
  console.log(o.toString(16).padStart(6, '0'), s.toString('hex').match(/../g).join(' ').padEnd(48), s.toString('latin1').replace(/[^ -~]/g, '.'));
}
