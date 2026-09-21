// ============================================================================
//  Layout geometry — given a graph, its rank assignment, and each node's
//  measured size, computes where everything goes: column x, iteratively
//  resolved y (barycentre of neighbours + order-preserving minimum-
//  separation projection), the Bezier anchor points for every edge, and the
//  resulting canvas dimensions. Touches no DOM — the caller paints the
//  result. Mutation here (e.g. a Place's `.center`) is purely internal,
//  ephemeral working state, rebuilt from scratch on every call.
// ============================================================================

import type { GraphDef, EdgeDef } from "./state";

// ---- Tunable geometry ------------------------------------------------------
export const COL_W    = 240;                  // every column is this wide
export const H_PAD    = 34;                   // node inset inside its column
export const NODE_W   = COL_W - 2 * H_PAD;    // -> inter-column channel is 2*H_PAD wide
export const NODE_PAD = 13;                   // vertical breathing room around a node
const GAP_H    = 2;                           // a gap is essentially a single line...
const GAP_PAD  = 6;                           // ...with a little clearance around it
export const MARGIN   = 44;
export const LABEL_BAND = 34;                 // space at the top for rank labels
const BEZIER   = 0.3;                         // Bezier handle length as a fraction of dx
const ITERS    = 16;                          // coordinate-assignment iterations

// ---- Geometry helpers ------------------------------------------------------
export const colX       = (rank: number): number => MARGIN + rank * COL_W;
export const nodeLeftX  = (rank: number): number => colX(rank) + H_PAD;
export const nodeRightX = (rank: number): number => colX(rank) + COL_W - H_PAD;
export const edgeKey    = (e: EdgeDef): string => e.from + "->" + e.to;

// ---- Weighted isotonic regression (pool adjacent violators) ----------------
// Returns a non-decreasing fit of t minimising sum w_i (u_i - t_i)^2.
function isotonic(t: number[], w: number[]): number[] {
  const val: number[] = [], wt: number[] = [], cnt: number[] = [];
  for (let i = 0; i < t.length; i++) {
    let v = t[i], ww = w[i], c = 1;
    while (val.length && val[val.length - 1] > v) {
      const pv = val.pop()!, pw = wt.pop()!, pc = cnt.pop()!;
      v = (pv * pw + v * ww) / (pw + ww);
      ww = pw + ww;
      c = pc + c;
    }
    val.push(v); wt.push(ww); cnt.push(c);
  }
  const out: number[] = [];
  for (let b = 0; b < val.length; b++) for (let k = 0; k < cnt[b]; k++) out.push(val[b]);
  return out;
}

// A vertical slot in a column, resolved by the coordinate-assignment pass.
interface Place {
  kind: "node" | "gap";
  half: number;     // half-extent incl. padding (drives min separation)
  weight: number;   // how strongly it's pulled toward its desired centre
  order: number;    // stacking order within the column
  center: number;   // resolved absolute centre-y
  desired: number;  // target centre-y for the current iteration
}

// Place an ordered column of `Place`s at their desired centres, respecting
// order and minimum separation. Classic separation-constrained least squares.
function projectColumn(col: Place[]): void {
  const n = col.length;
  if (n === 0) return;
  const off: number[] = new Array(n).fill(0);   // minimal centre offsets
  for (let i = 1; i < n; i++) off[i] = off[i - 1] + col[i - 1].half + col[i].half;
  const t = col.map((p, i) => p.desired - off[i]);
  const w = col.map(p => p.weight);
  const u = isotonic(t, w);
  for (let i = 0; i < n; i++) col[i].center = u[i] + off[i];
}

// Anchors: source-right, then (enter,exit) across each intermediate gap, then
// target-left. Every anchor has a horizontal tangent, so flats stay flat and
// the between-column joins ease smoothly.
export function bezierPath(a: readonly (readonly [number, number])[]): string {
  let d = `M ${a[0][0].toFixed(1)} ${a[0][1].toFixed(1)}`;
  for (let i = 1; i < a.length; i++) {
    const [x0, y0] = a[i - 1], [x1, y1] = a[i];
    const h = (x1 - x0) * BEZIER;
    d += ` C ${(x0 + h).toFixed(1)} ${y0.toFixed(1)},` +
         ` ${(x1 - h).toFixed(1)} ${y1.toFixed(1)},` +
         ` ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

export interface NodeSize { width: number; height: number; }
export interface NodeLayout { x: number; y: number; rank: number; orderInRank: number; }
export interface LayoutResult {
  positions: Map<string, NodeLayout>;
  edgeAnchors: Map<string, [number, number][]>;   // keyed by edgeKey(e)
  byRank: string[][];                             // node ids per rank, in order
  maxRank: number;
  canvasW: number;
  canvasH: number;
  scrollDomain: number;
}

// Runs the whole coordinate-assignment pass over `g` (already filtered down
// to whatever's currently included/visible by the caller) and returns every
// piece of geometry the caller needs to paint it. `sizes` must have an entry
// for every node in `g.nodes`. `rankMap`/`maxRank` come from computeRanks —
// ranking is a structural query, not a layout computation, so it isn't
// redone here.
export function computeLayout(
  g: GraphDef,
  rankMap: Map<string, number>,
  maxRank: number,
  sizes: Map<string, NodeSize>,
): LayoutResult {
  const byRank: string[][] = []; for (let r = 0; r <= maxRank; r++) byRank[r] = [];
  g.nodes.forEach(def => { byRank[rankMap.get(def.id)!].push(def.id); });
  const orderInRank = new Map<string, number>();
  byRank.forEach(list => list.forEach((id, i) => orderInRank.set(id, i)));
  const nodeNorm = (id: string): number => (orderInRank.get(id)! + 0.5) / byRank[rankMap.get(id)!].length;

  const columns: Place[][] = []; for (let r = 0; r <= maxRank; r++) columns[r] = [];
  const nodePlace = new Map<string, Place>();
  const gapPlace = new Map<string, Place>();     // key: "edgeKey@rank"

  g.nodes.forEach(def => {
    const id = def.id, r = rankMap.get(id)!, size = sizes.get(id)!;
    const p: Place = {
      kind: "node", half: size.height / 2 + NODE_PAD, weight: 1,
      order: nodeNorm(id), center: 0, desired: 0,
    };
    nodePlace.set(id, p);
    columns[r].push(p);
  });

  g.edges.forEach(e => {
    const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
    if (rw - ru <= 1) return;
    const s = nodeNorm(e.from), t = nodeNorm(e.to);
    for (let r = ru + 1; r < rw; r++) {
      const f = (r - ru) / (rw - ru);
      const p: Place = {
        kind: "gap", half: GAP_H / 2 + GAP_PAD, weight: 1.5,
        order: s + (t - s) * f, center: 0, desired: 0,
      };
      gapPlace.set(edgeKey(e) + "@" + r, p);
      columns[r].push(p);
    }
  });
  columns.forEach(col => col.sort((a, b) => a.order - b.order));

  const neighbours = new Map<Place, Place[]>();
  const link = (a: Place, b: Place): void => {
    (neighbours.get(a) || neighbours.set(a, []).get(a)!).push(b);
    (neighbours.get(b) || neighbours.set(b, []).get(b)!).push(a);
  };
  g.edges.forEach(e => {
    const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
    const chain: Place[] = [nodePlace.get(e.from)!];
    for (let r = ru + 1; r < rw; r++) chain.push(gapPlace.get(edgeKey(e) + "@" + r)!);
    chain.push(nodePlace.get(e.to)!);
    for (let k = 0; k < chain.length - 1; k++) link(chain[k], chain[k + 1]);
  });

  // Immediate above/below neighbours within a column (order is fixed from here
  // on) — used to keep a place with no graph neighbours from floating: it
  // nestles against its column neighbours instead of staying wherever the
  // initial top-down stacking left it.
  const colPrev = new Map<Place, Place>();
  const colNext = new Map<Place, Place>();
  columns.forEach(col => col.forEach((p, i) => {
    if (i > 0) colPrev.set(p, col[i - 1]);
    if (i < col.length - 1) colNext.set(p, col[i + 1]);
  }));

  columns.forEach(col => {
    let y = 0;
    col.forEach((p, i) => {
      if (i > 0) y += col[i - 1].half + p.half;
      p.center = y;
    });
  });
  const allPlaces: Place[] = ([] as Place[]).concat(...columns);
  for (let it = 0; it < ITERS; it++) {
    for (const p of allPlaces) {
      const nb = neighbours.get(p);
      if (nb && nb.length) {
        p.desired = nb.reduce((s, q) => s + q.center, 0) / nb.length;
        continue;
      }
      // No graph neighbours (an isolated node) — pull toward the midpoint of
      // its column neighbours, or snug against whichever one it has.
      const a = colPrev.get(p), b = colNext.get(p);
      if (a && b) p.desired = (a.center + b.center) / 2;
      else if (a) p.desired = a.center + a.half + p.half;
      else if (b) p.desired = b.center - b.half - p.half;
      else p.desired = p.center;
    }
    columns.forEach(projectColumn);
  }

  // Final compaction: an isolated node has no barycentre pulling it anywhere,
  // so the iteration can leave it stranded a whole node-height from its column
  // neighbours (it only ever chases them one lagging step at a time, and the
  // sweep isn't guaranteed to converge). Snap each to the tightest spot its
  // neighbours allow — midpoint between them, or flush against the only one.
  // Top-to-bottom so a run of isolated nodes collapses against the last
  // connected node above them. No edges touch these nodes, so nothing else
  // in the geometry depends on where they land.
  columns.forEach(col => {
    for (let i = 0; i < col.length; i++) {
      const p = col[i];
      if (neighbours.get(p)?.length) continue;
      const lo = i > 0 ? col[i - 1].center + col[i - 1].half + p.half : -Infinity;
      const hi = i < col.length - 1 ? col[i + 1].center - col[i + 1].half - p.half : Infinity;
      let target: number;
      if (lo === -Infinity && hi === Infinity) target = p.center;
      else if (lo === -Infinity) target = hi;
      else if (hi === Infinity) target = lo;
      else target = (col[i - 1].center + col[i + 1].center) / 2;
      p.center = Math.max(lo === -Infinity ? target : lo, Math.min(hi === Infinity ? target : hi, target));
    }
  });

  // Normalise so the topmost place sits just below the label band.
  let minTop = Infinity, maxBot = LABEL_BAND;
  allPlaces.forEach(p => { minTop = Math.min(minTop, p.center - p.half); });
  const positions = new Map<string, NodeLayout>();
  if (allPlaces.length) {
    const shift = LABEL_BAND + NODE_PAD - minTop;
    allPlaces.forEach(p => { p.center += shift; });
    g.nodes.forEach(def => {
      const id = def.id, r = rankMap.get(id)!, size = sizes.get(id)!;
      const p = nodePlace.get(id)!;
      const x = nodeLeftX(r), y = p.center - size.height / 2;
      positions.set(id, { x, y, rank: r, orderInRank: orderInRank.get(id)! });
      maxBot = Math.max(maxBot, y + size.height);
    });
  }

  const canvasW = 2 * MARGIN + (maxRank + 1) * COL_W;
  const canvasH = maxBot + MARGIN;
  const scrollDomain = (maxRank + 1) * COL_W;

  const edgeAnchors = new Map<string, [number, number][]>();
  g.edges.forEach(e => {
    const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
    const a: [number, number][] = [[nodeRightX(ru), nodePlace.get(e.from)!.center]];
    for (let r = ru + 1; r < rw; r++) {
      const y = gapPlace.get(edgeKey(e) + "@" + r)!.center;
      a.push([nodeLeftX(r), y]);
      a.push([nodeRightX(r), y]);
    }
    a.push([nodeLeftX(rw), nodePlace.get(e.to)!.center]);
    edgeAnchors.set(edgeKey(e), a);
  });

  return { positions, edgeAnchors, byRank, maxRank, canvasW, canvasH, scrollDomain };
}
