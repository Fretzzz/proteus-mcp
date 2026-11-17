/**
 * Netlist reconstruction from the parsed DSN model.
 *
 * Connectivity sources, in order of confidence:
 *   1. pin tables / terminal refs: absolute pointers from a pin to the wire it touches
 *   2. junction dots: records listing up to four wires that meet
 *   3. geometry: a wire end lying on another wire of the same sheet
 *   4. names: wire labels and terminal labels with the same text (global, case-insensitive)
 *   5. hidden power pins (VCC/GND/...) with no wire join the net of the same name
 * Bus wires are reported but not expanded into member nets.
 */
import type { DsnComponent, DsnModel, DsnTerminal } from './dsn.js';
import type { CdbPin } from './cdb.js';

export interface NetNode {
  ref: string;
  pin: string;
  number: string;
  /** Index of the pin in the component's pin table. */
  index: number;
  /** Joined by name only (hidden power pin). */
  implicit?: boolean;
}

export interface Net {
  name: string;
  /** True if the name came from a label/terminal rather than being auto-generated. */
  named: boolean;
  /** Other names the same net carries (several labels/terminals on one net). */
  aliases: string[];
  nodes: NetNode[];
  terminals: { kind: string; label: string; sheet: number }[];
  labels: string[];
  sheets: number[];
}

export interface Netlist {
  nets: Net[];
  unconnected: NetNode[];
  busWires: number;
  warnings: string[];
}

export type PinResolver = (c: DsnComponent) => CdbPin[] | null;

const POWER_PIN_NAMES = /^(VCC|VDD|VEE|GND|VSS|AVCC|AVDD|AGND|DGND|AVSS|V\+|V-)$/i;

class UnionFind {
  private p = new Map<string, string>();
  add(x: string) {
    if (!this.p.has(x)) this.p.set(x, x);
  }
  find(x: string): string {
    this.add(x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r)!;
    let c = x;
    while (this.p.get(c) !== r) {
      const n = this.p.get(c)!;
      this.p.set(c, r);
      c = n;
    }
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
  keys() {
    return this.p.keys();
  }
}

export function terminalNetName(t: DsnTerminal): string | null {
  if (t.kind === 'vprobe' || t.kind === 'iprobe' || t.kind === 'tape') return null;
  const label = t.label.text.trim();
  if (label) return label;
  if (t.kind === 'power') return 'VCC';
  if (t.kind === 'ground') return 'GND';
  return null;
}

function onSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): boolean {
  if (px < Math.min(ax, bx) || px > Math.max(ax, bx) || py < Math.min(ay, by) || py > Math.max(ay, by)) return false;
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) === 0;
}

export function componentLabel(c: DsnComponent): string {
  return c.ref || `${c.device}#${c.objectIndex}`;
}

export function buildNetlist(model: DsnModel, pinsOf: PinResolver, opts: { geometry?: boolean } = {}): Netlist {
  const uf = new UnionFind();
  const warnings: string[] = [];
  const wireById = new Map<number, (typeof model.wires)[number]>();
  for (const w of model.wires) wireById.set(w.offset, w);
  const sig = (w: { offset: number }) => `W:${w.offset}`;
  const wires = model.wires.filter((w) => !w.bus);
  for (const w of wires) uf.add(sig(w));

  // junctions
  for (const j of model.junctions) {
    const ws = j.refs.filter((r) => r && wireById.has(r) && !wireById.get(r)!.bus);
    for (let k = 1; k < ws.length; k++) uf.union(`W:${ws[0]}`, `W:${ws[k]}`);
  }
  // geometry within a sheet
  const bySheet = new Map<number, typeof wires>();
  for (const w of wires) {
    if (!bySheet.has(w.sheet)) bySheet.set(w.sheet, []);
    bySheet.get(w.sheet)!.push(w);
  }
  for (const list of opts.geometry ? bySheet.values() : []) {
    for (const a of list) {
      const ends = [a.points[0], a.points[a.points.length - 1]];
      for (const b of list) {
        if (a === b) continue;
        for (const e of ends) {
          let hit = false;
          for (let k = 0; k + 1 < b.points.length && !hit; k++)
            hit = onSegment(e.x, e.y, b.points[k].x, b.points[k].y, b.points[k + 1].x, b.points[k + 1].y);
          if (b.points.length === 1) hit = b.points[0].x === e.x && b.points[0].y === e.y;
          if (hit) uf.union(sig(a), sig(b));
        }
      }
    }
  }
  // named wires
  const displayName = new Map<string, string>();
  const nameKey = (n: string) => `N:${n.toUpperCase()}`;
  const labelsByRoot: [string, string][] = [];
  for (const w of wires) {
    if (w.label && w.label.text.trim()) {
      const n = w.label.text.trim();
      displayName.set(nameKey(n), n);
      uf.union(nameKey(n), sig(w));
      labelsByRoot.push([sig(w), n]);
    }
  }
  // terminals
  const termByKey: { key: string; t: DsnTerminal }[] = [];
  model.terminals.forEach((t, i) => {
    const key = `T:${i}`;
    uf.add(key);
    termByKey.push({ key, t });
    for (const r of [t.ref, ...t.extraRefs]) if (r && wireById.has(r) && !wireById.get(r)!.bus) uf.union(key, `W:${r}`);
    const n = terminalNetName(t);
    if (n) {
      displayName.set(nameKey(n), displayName.get(nameKey(n)) ?? n);
      uf.union(key, nameKey(n));
    }
  });
  // pins
  const pinNodes: { key: string; node: NetNode; connected: boolean }[] = [];
  let busPins = 0;
  model.components.forEach((c, ci) => {
    const pins = pinsOf(c);
    if (!pins) warnings.push(`no pin names for ${componentLabel(c)} (${c.device}); using pin indices`);
    c.pinRefs.forEach((r, k) => {
      const p = pins?.[k];
      const node: NetNode = { ref: componentLabel(c), pin: p?.name ?? String(k + 1), number: p?.number ?? '', index: k };
      const key = `P:${ci}:${k}`;
      uf.add(key);
      let connected = false;
      if (r && wireById.has(r)) {
        if (wireById.get(r)!.bus) busPins++;
        else {
          uf.union(key, `W:${r}`);
          connected = true;
        }
      } else if (!r && p && POWER_PIN_NAMES.test(p.name)) {
        node.implicit = true;
        displayName.set(nameKey(p.name), displayName.get(nameKey(p.name)) ?? p.name.toUpperCase());
        uf.union(key, nameKey(p.name));
        connected = true;
      }
      pinNodes.push({ key, node, connected });
    });
  });
  if (busPins) warnings.push(`${busPins} pin(s) attach to bus wires; bus members are not expanded`);

  // collect nets
  const groups = new Map<string, Net>();
  const get = (root: string): Net => {
    let n = groups.get(root);
    if (!n) {
      n = { name: '', named: false, aliases: [], nodes: [], terminals: [], labels: [], sheets: [] };
      groups.set(root, n);
    }
    return n;
  };
  const names = new Map<string, Set<string>>();
  for (const k of uf.keys()) {
    if (!k.startsWith('N:')) continue;
    const r = uf.find(k);
    if (!names.has(r)) names.set(r, new Set());
    names.get(r)!.add(displayName.get(k) ?? k.slice(2));
  }
  const unconnected: NetNode[] = [];
  for (const pn of pinNodes) {
    const r = uf.find(pn.key);
    const hasOther = pn.connected;
    if (!hasOther) {
      unconnected.push(pn.node);
      continue;
    }
    get(r).nodes.push(pn.node);
  }
  for (const { key, t } of termByKey) {
    const r = uf.find(key);
    const n = get(r);
    n.terminals.push({ kind: t.kind, label: t.label.text, sheet: t.sheet });
    if (!n.sheets.includes(t.sheet)) n.sheets.push(t.sheet);
  }
  for (const [wkey, label] of labelsByRoot) {
    const n = get(uf.find(wkey));
    if (!n.labels.includes(label)) n.labels.push(label);
  }
  for (const w of wires) {
    const n = groups.get(uf.find(sig(w)));
    if (n && !n.sheets.includes(w.sheet)) n.sheets.push(w.sheet);
  }

  let auto = 0;
  const nets: Net[] = [];
  for (const [root, n] of groups) {
    if (n.nodes.length === 0 && n.terminals.length === 0) continue;
    const nm = names.get(root);
    if (nm && nm.size) {
      const list = [...nm].sort();
      n.name = list[0];
      n.named = true;
      n.aliases = list.slice(1);
      const supply = list.filter((x) => /^(VCC|VDD|V\+|\+?\d+V\d*|AVCC|VBAT)$/i.test(x));
      const ground = list.filter((x) => /^(GND|VSS|AGND|DGND|0V|V-)$/i.test(x));
      if (supply.length && ground.length) warnings.push(`supply and ground joined in one net: ${list.join(', ')}`);
    }
    nets.push(n);
  }
  // stable ordering: named nets first (alphabetical), then by first node
  const firstNode = (n: Net) => (n.nodes[0] ? `${n.nodes[0].ref}.${n.nodes[0].index}` : '');
  nets.sort((a, b) => (a.named === b.named ? (a.named ? a.name.localeCompare(b.name) : firstNode(a).localeCompare(firstNode(b))) : a.named ? -1 : 1));
  for (const n of nets) if (!n.named) n.name = `#${String(auto++).padStart(5, '0')}`;
  for (const n of nets) n.nodes.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }) || a.index - b.index);
  return { nets, unconnected, busWires: model.wires.filter((w) => w.bus).length, warnings };
}
