// ============================================================================
//  DAG layout engine
//  - Columns are indexed by rank, all equal width.
//  - Each Column holds an ordered list of "places": a place is either a Node
//    or a thin Gap. A multi-rank edge reserves one Gap per intermediate column
//    so its connector has a clear horizontal channel to pass through.
//  - Vertical positions come from an iterative coordinate-assignment pass
//    (barycentre of neighbours + order-preserving minimum-separation
//    projection). This straightens long edges and removes small lateral jogs.
//  - Between columns the connector is a gentle Bezier; inside a column it runs
//    straight through the gap channel.
//  - Edge colours: <=4 hues, chosen to keep edges that share an endpoint
//    distinct.
//  - Focus: an "excluded" node-id mask lets the view narrow to a subgraph
//    without ever duplicating the graph itself — every layout pass filters
//    `g` by the current mask at the moment it runs, then re-lays-out and
//    repaints the same, persistent DOM elements.
// ============================================================================

interface NodeDef { id: string; title: string; body?: string; }
interface EdgeDef { from: string; to: string; }
interface GraphDef { nodes: NodeDef[]; edges: EdgeDef[]; }

interface LaidNode {
  def: NodeDef;
  rank: number;
  orderInRank: number;
  el: HTMLDivElement;
  width: number;
  height: number;   // measured from content
  x: number;        // absolute top-left
  y: number;
}

// A vertical slot in a column, resolved by the coordinate-assignment pass.
interface Place {
  kind: "node" | "gap";
  rank: number;
  half: number;     // half-extent incl. padding (drives min separation)
  weight: number;   // how strongly it's pulled toward its desired centre
  order: number;    // stacking order within the column
  center: number;   // resolved absolute centre-y
  desired: number;  // target centre-y for the current iteration
  node?: LaidNode;
  edgeKey?: string; // for gaps
}

// ---- Tunable geometry ------------------------------------------------------
const COL_W    = 240;                  // every column is this wide
const H_PAD    = 34;                   // node inset inside its column
const NODE_W   = COL_W - 2 * H_PAD;    // -> inter-column channel is 2*H_PAD wide
const NODE_PAD = 13;                   // vertical breathing room around a node
const GAP_H    = 2;                    // a gap is essentially a single line...
const GAP_PAD  = 6;                    // ...with a little clearance around it
const MARGIN   = 44;
const LABEL_BAND = 34;                 // space at the top for rank labels
const BEZIER   = 0.3;                  // Bezier handle length as a fraction of dx
const ITERS    = 16;                   // coordinate-assignment iterations

const PALETTE = ["#2563eb", "#e07b1a", "#0d9488", "#7c3aed"]; // blue, orange, teal, violet (kept clear of the semantic red/green rings)

// ---- Selection / hover styling --------------------------------------------
const HOVER = 0.42;                                    // hover effect strength (0..1)
const DROP = "0 1px 2px #1b273312, 0 6px 14px -10px #1b273340"; // default node shadow
const HL = { yellow: [245, 179, 1], green: [47, 158, 68], red: [224, 49, 49] };
const DOTTED_COL = [120, 128, 138]; // neutral grey for the "frontier" outline
const NEUTRAL_COL = [[238, 242, 247], [231, 236, 243]]; // even, odd column bg
function tintCol(region: "anc" | "self" | "desc", parity: number): number[] {
  if (region === "anc")  return parity ? [214, 236, 223] : [224, 242, 231];
  if (region === "self") return parity ? [241, 234, 201] : [247, 241, 214];
  return parity ? [242, 222, 222] : [248, 231, 231];
}
const lerpCol = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgbStr  = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgbaStr = (c: number[], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
const ringShadow = (color: string, w: number, glow: number) =>
  `0 0 0 ${w.toFixed(1)}px ${color}` +
  (glow > 0 ? `, 0 0 ${(10 * glow).toFixed(1)}px ${rgbaStr(HL.yellow, 0.3 * glow)}` : "") +
  `, ${DROP}`;
const darker = (c: number[]) => c.map(v => Math.round(v * 0.82));

// A unary tally (marks grouped in fives, the fifth a diagonal) rendered as tiny SVG.
function tallySvg(n: number, color: string): string {
  const H = 13, m = 4, gg = 5;
  const marks: string[] = [];
  let x = 1, c = n;
  while (c > 0) {
    const k = Math.min(5, c), gs = x, bars = Math.min(k, 4);
    for (let i = 0; i < bars; i++) {
      marks.push(`<line x1="${x}" y1="1" x2="${x}" y2="${H - 1}"/>`);
      if (i < bars - 1) x += m;
    }
    if (k === 5) marks.push(`<line x1="${gs - 2}" y1="${H - 1}" x2="${x + 2}" y2="1"/>`);
    x += m + gg; c -= k;
  }
  const w = Math.max(3, x - gg);
  return `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" fill="none" stroke="${color}" ` +
         `stroke-width="1.6" stroke-linecap="round">${marks.join("")}</svg>`;
}

// ---- Geometry helpers ------------------------------------------------------
const colX       = (rank: number) => MARGIN + rank * COL_W;
const nodeLeftX  = (rank: number) => colX(rank) + H_PAD;
const nodeRightX = (rank: number) => colX(rank) + COL_W - H_PAD;
const edgeKey    = (e: EdgeDef) => e.from + "->" + e.to;

// ---- Ranking: longest-path layering over a topological order ---------------
function computeRanks(g: GraphDef): Map<string, number> {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  g.nodes.forEach(n => { adj.set(n.id, []); indeg.set(n.id, 0); });
  g.edges.forEach(e => {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  });

  const rank = new Map<string, number>();
  g.nodes.forEach(n => rank.set(n.id, 0));
  const remaining = new Map(indeg);
  const queue: string[] = [];
  remaining.forEach((d, id) => { if (d === 0) queue.push(id); });

  let processed = 0;
  while (queue.length) {
    const u = queue.shift()!;
    processed++;
    for (const v of adj.get(u)!) {
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1));
      remaining.set(v, remaining.get(v)! - 1);
      if (remaining.get(v) === 0) queue.push(v);
    }
  }
  if (processed !== g.nodes.length) throw new Error("Graph is not acyclic.");
  return rank;
}

// ---- Node element (HTML so the browser sizes it from content) --------------
function makeNodeEl(def: NodeDef): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "dag-node";
  const title = document.createElement("div");
  title.className = "dag-node-title";
  title.textContent = def.title;
  el.appendChild(title);
  if (def.body) {
    const body = document.createElement("div");
    body.className = "dag-node-body";
    body.textContent = def.body;
    el.appendChild(body);
  }
  return el;
}

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

// ============================================================================
//  Layout + render
// ============================================================================
function render(container: HTMLElement, g: GraphDef): void {
  // ---- Focus mask -----------------------------------------------------------
  // `excluded` names the node ids currently hidden from view. The graph object
  // `g` is never copied or mutated — every layout pass filters it by this mask
  // at the moment it runs, so toggling focus just means recomputing a layout.
  let excluded = new Set<string>();
  const included = (id: string) => !excluded.has(id);

  // --- SVG scaffold (defs first, everything else appended after) ------------
  container.style.position = "relative";
  const SVG = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(SVG, "svg");
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;";
  const markers = PALETTE.map((c, i) =>
    `<marker id="arrow-${i}" markerWidth="9" markerHeight="9" refX="8" refY="3" ` +
    `orient="auto" markerUnits="userSpaceOnUse">` +
    `<path d="M0,0 L8,3 L0,6 Z" fill="${c}"/></marker>`).join("");
  const rankHatch =
    `<pattern id="rankHatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<rect width="7" height="7" fill="rgb(248,244,220)"/>` +
    `<line x1="0" y1="0" x2="0" y2="7" stroke="rgba(110,110,110,0.22)" stroke-width="2"/></pattern>`;
  svg.innerHTML = "<defs>" + markers + rankHatch + "</defs>";
  container.appendChild(svg);

  // A sticky footer, inside the same white-bordered pane as the DAG itself,
  // holding (top to bottom) the rank scrollbar, the icon bar, and the node
  // editor — CSS `order` on each fixes that stacking regardless of the order
  // they're actually built in below.
  const panelFooter = document.createElement("div");
  panelFooter.className = "dag-panel-footer";
  container.parentElement!.appendChild(panelFooter);

  // --- Column backgrounds + rank labels, sized to the full graph's rank count.
  // A focused subgraph can only ever need fewer; adding a node can only ever
  // need more — growRankPools() (below, near the scrollbar) extends the pool
  // when that happens, reusing addRankSlot(). -----------------------------
  const fullRankMap0 = computeRanks(g);
  let maxRank0 = Math.max(...g.nodes.map(n => fullRankMap0.get(n.id)!));

  const colRects: { el: SVGElement; rank: number; parity: number }[] = [];
  const rankLabels: HTMLDivElement[] = [];
  function addRankSlot(r: number): void {
    const rect = document.createElementNS(SVG, "rect");
    rect.setAttribute("x", String(colX(r)));
    rect.setAttribute("y", String(LABEL_BAND - 6));
    rect.setAttribute("width", String(COL_W));
    rect.setAttribute("fill", rgbStr(NEUTRAL_COL[r % 2]));
    svg.appendChild(rect);
    colRects.push({ el: rect, rank: r, parity: r % 2 });

    const label = document.createElement("div");
    label.className = "dag-rank-label";
    label.textContent = "rank " + r;
    label.style.left = (colX(r) + H_PAD) + "px";
    label.style.top = "10px";
    container.appendChild(label);
    label.addEventListener("click", ev => {
      ev.stopPropagation();
      mode = "rank"; rankSel = r; selectedIds = []; subBuffer = "";
      refresh(); reveal();
    });
    rankLabels.push(label);
  }
  for (let r = 0; r <= maxRank0; r++) addRankSlot(r);

  // --- Edge colouring: <=4 hues, keep shared-endpoint edges distinct ---------
  // Rebuilt from scratch on demand (addNode) — simplest way to keep colouring
  // consistent as edges are added, and cheap at this scale.
  const edgeRecs: { from: string; to: string; el: SVGElement }[] = [];
  function rebuildEdgeRecs(): void {
    edgeRecs.forEach(r => r.el.remove());
    edgeRecs.length = 0;
    const E = g.edges;
    const conflict: number[][] = E.map(() => []);
    for (let i = 0; i < E.length; i++)
      for (let j = i + 1; j < E.length; j++)
        if (E[i].from === E[j].from || E[i].to === E[j].to) {
          conflict[i].push(j); conflict[j].push(i);
        }
    const K = PALETTE.length;
    const edgeColor = new Array<number>(E.length).fill(0);
    const orderByDeg = E.map((_, i) => i).sort((a, b) => conflict[b].length - conflict[a].length);
    const pickLeastUsed = (i: number): number => {
      const used = new Array<number>(K).fill(0);
      for (const j of conflict[i]) used[edgeColor[j]]++;
      let best = 0;
      for (let c = 1; c < K; c++) if (used[c] < used[best]) best = c;
      return best;
    };
    for (const i of orderByDeg) edgeColor[i] = pickLeastUsed(i);
    for (let pass = 0; pass < 200; pass++) {
      let improved = false;
      for (let i = 0; i < E.length; i++) {
        const before = (() => { let s = 0; for (const j of conflict[i]) if (edgeColor[j] === edgeColor[i]) s++; return s; })();
        const cand = pickLeastUsed(i);
        let after = 0; for (const j of conflict[i]) if (edgeColor[j] === cand) after++;
        if (after < before) { edgeColor[i] = cand; improved = true; }
      }
      if (!improved) break;
    }
    E.forEach((e, i) => {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", PALETTE[edgeColor[i]]);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("marker-end", `url(#arrow-${edgeColor[i]})`);
      svg.appendChild(path);   // appended last -> always in front of rank rects
      edgeRecs.push({ from: e.from, to: e.to, el: path });
    });
  }
  rebuildEdgeRecs();

  // --- Node cards: build + MEASURE their content-driven heights --------------
  // Each node also gets a lineage tally (top-right, inside), an enumeration
  // digit (top-right, outside), and a bank badge (bottom-right, inside) — all
  // absolutely positioned so toggling them never reflows anything. addNodeCard
  // is reused later (addNode) to bring a freshly-created node into being.
  const nodes = new Map<string, LaidNode>();
  const nodeTally = new Map<string, HTMLDivElement>();
  const nodeEnum = new Map<string, HTMLDivElement>();
  const nodeBank = new Map<string, HTMLDivElement>();

  function addNodeCard(def: NodeDef): LaidNode {
    const el = makeNodeEl(def);
    el.style.width = NODE_W + "px";
    el.style.left = "-9999px"; el.style.top = "0"; el.style.visibility = "hidden";
    container.appendChild(el);   // .dag-node is already position:absolute; measure off-screen
    const height = el.offsetHeight;
    el.style.visibility = "visible"; el.style.cursor = "pointer";

    const ln: LaidNode = { def, rank: 0, orderInRank: 0, el, width: NODE_W, height, x: 0, y: 0 };
    nodes.set(def.id, ln);

    const tally = document.createElement("div");
    tally.className = "dag-tally";
    el.appendChild(tally);
    nodeTally.set(def.id, tally);

    const bank = document.createElement("div");
    bank.className = "dag-bank-badge";
    el.appendChild(bank);
    nodeBank.set(def.id, bank);

    const en = document.createElement("div");
    en.className = "dag-enum";
    container.appendChild(en);
    nodeEnum.set(def.id, en);

    wireNode(ln);
    return ln;
  }
  g.nodes.forEach(def => addNodeCard(def));

  // --- Graph relations — recomputed whenever the graph is mutated (addNode) --
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const ancOf = new Map<string, Set<string>>();
  const descOf = new Map<string, Set<string>>();

  // Everything reachable from `start` along `adj` (start excluded).
  const reach = (start: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(adj.get(start) || [])];
    while (stack.length) {
      const x = stack.pop()!;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of adj.get(x) || []) stack.push(y);
    }
    return seen;
  };

  function rebuildRelations(): void {
    children.clear(); parents.clear(); ancOf.clear(); descOf.clear();
    g.nodes.forEach(n => { children.set(n.id, []); parents.set(n.id, []); });
    g.edges.forEach(e => { children.get(e.from)!.push(e.to); parents.get(e.to)!.push(e.from); });
    g.nodes.forEach(n => { ancOf.set(n.id, reach(n.id, parents)); descOf.set(n.id, reach(n.id, children)); });
  }
  rebuildRelations();

  // ---- Mutable per-layout state, recomputed by relayout() -------------------
  let rankMap = new Map<string, number>();
  let maxRank = 0;
  let byRank: LaidNode[][] = [];
  let canvasW = 0, canvasH = 0;
  let scrollDomain = COL_W;

  function bezierPath(a: [number, number][]): string {
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

  // Re-run the layout algorithm over whichever nodes/edges are currently
  // included, and paint the result onto the persistent DOM. No new graph
  // object is retained anywhere — `induced` is thrown away once this returns.
  // Returns the new maxRank.
  function relayout(): number {
    const inducedNodes = g.nodes.filter(n => included(n.id));
    const inducedEdges = g.edges.filter(e => included(e.from) && included(e.to));
    const induced: GraphDef = { nodes: inducedNodes, edges: inducedEdges };

    rankMap = computeRanks(induced);
    maxRank = inducedNodes.length ? Math.max(...inducedNodes.map(n => rankMap.get(n.id)!)) : 0;

    byRank = []; for (let r = 0; r <= maxRank; r++) byRank[r] = [];
    inducedNodes.forEach(def => {
      const ln = nodes.get(def.id)!;
      ln.rank = rankMap.get(def.id)!;
      byRank[ln.rank].push(ln);
    });
    byRank.forEach(list => list.forEach((ln, i) => { ln.orderInRank = i; }));
    const nodeNorm = (ln: LaidNode) => (ln.orderInRank + 0.5) / byRank[ln.rank].length;

    const columns: Place[][] = []; for (let r = 0; r <= maxRank; r++) columns[r] = [];
    const nodePlace = new Map<string, Place>();
    const gapPlace = new Map<string, Place>();     // key: "edgeKey@rank"

    inducedNodes.forEach(def => {
      const ln = nodes.get(def.id)!;
      const p: Place = {
        kind: "node", rank: ln.rank, half: ln.height / 2 + NODE_PAD, weight: 1,
        order: nodeNorm(ln), center: 0, desired: 0, node: ln,
      };
      nodePlace.set(def.id, p);
      columns[ln.rank].push(p);
    });

    inducedEdges.forEach(e => {
      const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
      if (rw - ru <= 1) return;
      const s = nodeNorm(nodes.get(e.from)!), t = nodeNorm(nodes.get(e.to)!);
      for (let r = ru + 1; r < rw; r++) {
        const f = (r - ru) / (rw - ru);
        const p: Place = {
          kind: "gap", rank: r, half: GAP_H / 2 + GAP_PAD, weight: 1.5,
          order: s + (t - s) * f, center: 0, desired: 0, edgeKey: edgeKey(e),
        };
        gapPlace.set(edgeKey(e) + "@" + r, p);
        columns[r].push(p);
      }
    });
    columns.forEach(col => col.sort((a, b) => a.order - b.order));

    const neighbours = new Map<Place, Place[]>();
    const link = (a: Place, b: Place) => {
      (neighbours.get(a) || neighbours.set(a, []).get(a)!).push(b);
      (neighbours.get(b) || neighbours.set(b, []).get(b)!).push(a);
    };
    inducedEdges.forEach(e => {
      const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
      const chain: Place[] = [nodePlace.get(e.from)!];
      for (let r = ru + 1; r < rw; r++) chain.push(gapPlace.get(edgeKey(e) + "@" + r)!);
      chain.push(nodePlace.get(e.to)!);
      for (let k = 0; k < chain.length - 1; k++) link(chain[k], chain[k + 1]);
    });

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
        p.desired = nb && nb.length
          ? nb.reduce((s, q) => s + q.center, 0) / nb.length
          : p.center;
      }
      columns.forEach(projectColumn);
    }

    // Normalise so the topmost place sits just below the label band.
    let minTop = Infinity, maxBot = LABEL_BAND;
    allPlaces.forEach(p => { minTop = Math.min(minTop, p.center - p.half); });
    if (allPlaces.length) {
      const shift = LABEL_BAND + NODE_PAD - minTop;
      allPlaces.forEach(p => { p.center += shift; });
      inducedNodes.forEach(def => {
        const ln = nodes.get(def.id)!;
        const p = nodePlace.get(def.id)!;
        ln.x = nodeLeftX(ln.rank);
        ln.y = p.center - ln.height / 2;
        maxBot = Math.max(maxBot, ln.y + ln.height);
      });
    }

    canvasW = 2 * MARGIN + (maxRank + 1) * COL_W;
    canvasH = maxBot + MARGIN;
    scrollDomain = (maxRank + 1) * COL_W;

    // Anchors: source-right, then (enter,exit) across each intermediate gap,
    // then target-left. Every anchor has a horizontal tangent, so flats stay
    // flat and the between-column joins ease smoothly.
    function edgeAnchors(e: EdgeDef): [number, number][] {
      const ru = rankMap.get(e.from)!, rw = rankMap.get(e.to)!;
      const a: [number, number][] = [[nodeRightX(ru), nodePlace.get(e.from)!.center]];
      for (let r = ru + 1; r < rw; r++) {
        const y = gapPlace.get(edgeKey(e) + "@" + r)!.center;
        a.push([nodeLeftX(r), y]);
        a.push([nodeRightX(r), y]);
      }
      a.push([nodeLeftX(rw), nodePlace.get(e.to)!.center]);
      return a;
    }

    // Paint: nodes.
    const includedSet = new Set(inducedNodes.map(n => n.id));
    nodes.forEach((ln, id) => {
      if (includedSet.has(id)) {
        ln.el.style.display = "";
        ln.el.style.left = ln.x + "px";
        ln.el.style.top = ln.y + "px";
      } else {
        ln.el.style.display = "none";
        nodeEnum.get(id)!.style.display = "none";
        nodeTally.get(id)!.style.display = "none";
      }
    });

    // Paint: edges.
    const includedEdgeKeys = new Set(inducedEdges.map(edgeKey));
    g.edges.forEach((e, i) => {
      const rec = edgeRecs[i];
      if (includedEdgeKeys.has(edgeKey(e))) {
        rec.el.style.display = "";
        rec.el.setAttribute("d", bezierPath(edgeAnchors(e)));
      } else {
        rec.el.style.display = "none";
      }
    });

    // Paint: column backgrounds + rank labels (only the first maxRank+1 slots
    // are relevant; the rest — left over from a larger prior layout — hide).
    for (let r = 0; r <= maxRank0; r++) {
      const show = r <= maxRank;
      colRects[r].el.style.display = show ? "" : "none";
      rankLabels[r].style.display = show ? "" : "none";
      if (show) colRects[r].el.setAttribute("height", String(canvasH - LABEL_BAND - MARGIN + 12));
    }

    container.style.width = canvasW + "px";
    container.style.height = canvasH + "px";
    svg.setAttribute("width", String(canvasW));
    svg.setAttribute("height", String(canvasH));

    updateScrollbarGeometry();
    return maxRank;
  }

  // --- Selection, multi-selection, lineage tallies ---------------------------
  let blockedSet = new Set<string>();   // already-emphasised nodes: can't be shift-added
  let barredSet = new Set<string>();    // green/red only — drives the "not-allowed" cursor
  let shiftHeld = false;
  let selMode: "union" | "intersection" = "union";

  // The barrier cursor only signals that adding a green/red node is blocked —
  // toggling (Shift, or prospective mode overriding it) an already-selected
  // node back off is always allowed, so selected nodes never show it.
  const updateCursors = (): void => {
    const barring = shiftHeld || prospective !== null;
    nodes.forEach(ln => {
      ln.el.style.cursor = barring && barredSet.has(ln.def.id) ? "not-allowed" : "pointer";
    });
  };

  function resetFocus(): void {
    nodes.forEach(ln => {
      const s = ln.el.style;
      s.opacity = ""; s.boxShadow = ""; s.outline = ""; s.outlineOffset = "";
    });
    nodeTally.forEach(t => { t.style.display = "none"; t.innerHTML = ""; });
    nodeEnum.forEach(e => { e.style.display = "none"; });
    edgeRecs.forEach(r => { r.el.setAttribute("stroke-width", "2"); r.el.style.opacity = "1"; });
    colRects.forEach(c => {
      c.el.setAttribute("fill", rgbStr(NEUTRAL_COL[c.parity]));
      c.el.setAttribute("stroke", "none");
    });
    rankLabels.forEach(l => {
      l.style.fontWeight = ""; l.style.color = ""; l.style.background = "";
      l.style.padding = ""; l.style.borderRadius = "";
    });
    blockedSet = new Set();
    barredSet = new Set();
    updateCursors();
  }

  function setTally(id: string, count: number, color: number[]): void {
    const t = nodeTally.get(id)!;
    t.innerHTML = tallySvg(count, rgbStr(darker(color)));
    t.style.display = "block";
  }

  // Ancestor counts (kept-threshold Set, respecting selMode unless `forceUnion`)
  // plus the "dotted" frontier: every node that is neither selected nor green,
  // but whose *immediate* parents are all selected or green. Single pass, not
  // transitive — a dotted node's own parents must already be covered, so it
  // never in turn helps cover anyone else.
  function computeGreenAndDotted(sel: string[], forceUnion: boolean): {
    greenCount: Map<string, number>; green: Set<string>; dotted: Set<string>;
  } {
    const selSet = new Set(sel);
    const greenCount = new Map<string, number>();
    sel.forEach(id => ancOf.get(id)!.forEach(a => greenCount.set(a, (greenCount.get(a) || 0) + 1)));
    sel.forEach(id => greenCount.delete(id));
    const gThresh = !forceUnion && selMode === "intersection" ? sel.length : 1;
    const green = new Set<string>();
    greenCount.forEach((v, k) => { if (v >= gThresh) green.add(k); });

    const covered = (id: string) => selSet.has(id) || green.has(id);
    const dotted = new Set<string>();
    nodes.forEach((_ln, id) => {
      if (!included(id) || covered(id)) return;
      const ps = parents.get(id)!.filter(p => included(p));
      if (ps.length && ps.every(covered)) dotted.add(id);
    });
    return { greenCount, green, dotted };
  }

  // sel: selected ids. s: strength (1 committed, HOVER preview).
  // committed distinguishes a real selection (tallies drawn, shift-barrier armed)
  // from a transient hover preview.
  function applyFocus(sel: string[], s: number, committed: boolean): void {
    resetFocus();
    if (sel.length === 0) return;

    const selSet = new Set(sel);
    const { greenCount, green, dotted } = computeGreenAndDotted(sel, false);
    const red = new Map<string, number>();     // descendant id -> how many selected lineages it's in
    let minR = Infinity, maxR = -Infinity;
    for (const id of sel) {
      const r = rankMap.get(id)!;
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      descOf.get(id)!.forEach(d => red.set(d, (red.get(d) || 0) + 1));
    }
    sel.forEach(id => red.delete(id));   // antichain: selected are neither ancestor nor descendant

    // Background zones: green left of the selection band, yellow within it, red right.
    colRects.forEach(c => {
      const region: "anc" | "self" | "desc" =
        c.rank < minR ? "anc" : c.rank > maxR ? "desc" : "self";
      c.el.setAttribute("fill", rgbStr(lerpCol(NEUTRAL_COL[c.parity], tintCol(region, c.parity), s)));
    });

    // Emphasis threshold: union keeps any positive count; intersection keeps only
    // nodes shared by every selected node (count == number selected).
    const selN = sel.length;
    const rThresh = selMode === "intersection" ? selN : 1;

    // Cones used to activate edges (only among the kept, emphasised nodes).
    const setA = new Set<string>(sel); green.forEach(k => setA.add(k));
    const setD = new Set<string>(sel); red.forEach((v, k) => { if (v >= rThresh) setD.add(k); });

    const blocked = new Set<string>(sel);
    green.forEach(k => blocked.add(k));
    red.forEach((_v, k) => blocked.add(k));
    const barred = new Set<string>();               // green/red only — never the selection itself
    green.forEach(k => barred.add(k));
    red.forEach((_v, k) => barred.add(k));

    nodes.forEach(ln => {
      const id = ln.def.id, st = ln.el.style;
      if (!included(id)) return;
      const gc = greenCount.get(id) || 0, rc = red.get(id) || 0;
      const isDotted = dotted.has(id);
      if (selSet.has(id)) {
        st.boxShadow = ringShadow(rgbaStr(HL.yellow, 0.65 + 0.35 * s), 1.5 + 1.5 * s, s);
        st.opacity = "1";
      } else if (green.has(id)) {                            // ancestor kept for this mode
        st.boxShadow = ringShadow(rgbaStr(HL.green, 0.55 + 0.45 * s), 1 + 1.3 * s, 0);
        st.opacity = "1";
        if (committed) setTally(id, gc, HL.green);
      } else if (rc >= rThresh) {                            // descendant kept for this mode
        st.boxShadow = ringShadow(rgbaStr(HL.red, 0.55 + 0.45 * s), 1 + 1.3 * s, 0);
        st.opacity = "1";
        if (committed) setTally(id, rc, HL.red);
      } else if (isDotted) {                                 // unrelated, but every ancestor is covered
        st.opacity = String(1 - (1 - 0.82) * s);
      } else {                                                // unrelated: dim by zone
        const base = ln.rank < minR ? 0.48 : ln.rank > maxR ? 0.62 : 0.30;
        st.opacity = String(1 - (1 - base) * s);
      }
      if (isDotted) {
        // Inner dotted ring via outline (outline never reflows); layers over
        // whatever ring (red/green/none) the node already has above.
        st.outline = `${(1.5 + s).toFixed(1)}px dotted ${rgbaStr(DOTTED_COL, 0.5 + 0.4 * s)}`;
        st.outlineOffset = `-${(3 + 2 * s).toFixed(1)}px`;
      }
    });

    edgeRecs.forEach(r => {
      const active = (setA.has(r.from) && setA.has(r.to)) || (setD.has(r.from) && setD.has(r.to));
      if (active) {
        r.el.setAttribute("stroke-width", (2 + 1.8 * s).toFixed(1));
        r.el.style.opacity = "1";
        svg.appendChild(r.el);           // bring active edges to the front
      } else {
        r.el.style.opacity = String(1 - 0.6 * s);
      }
    });

    blockedSet = committed ? blocked : new Set();
    barredSet = committed ? barred : new Set();
    updateCursors();
  }

  // ---- Interaction state ---------------------------------------------------
  type Mode = "idle" | "nodes" | "rank" | "subselect";
  let mode: Mode = "idle";
  let selectedIds: string[] = [];
  let rankSel = 0;                       // active rank in "rank" mode
  let subBuffer = "";                    // digits typed in "subselect" mode
  let subPrior: string[] = [];          // selection to restore if subselect is cancelled

  // ---- Banks A/D/S: named node sets ------------------------------------------
  // A/D wire up newly-created nodes as ancestors/descendants; S is a target
  // for directly wiring A/D's nodes onto existing ones (see wireBankToS).
  type BankLetter = "A" | "D" | "S";
  let bankA: Set<string> | null = null;
  let bankD: Set<string> | null = null;
  let bankS: Set<string> | null = null;
  // Right-click on S deactivates it: emptied, and the Ctrl+A/Ctrl+D wiring
  // actions fall back to using the current selection directly instead of S.
  let bankSDisabled = false;
  // Pressing a bank key with nothing selected arms it, waiting for a selection
  // to bank (and deselect) on the next press — instead of banking immediately.
  let prospective: BankLetter | null = null;

  const bankOf = (letter: BankLetter): Set<string> | null =>
    letter === "A" ? bankA : letter === "D" ? bankD : bankS;
  // A node can only ever belong to one bank — this is what blocks banking a
  // selection that overlaps a *different* bank.
  const bankConflict = (bank: Set<string> | null): boolean =>
    !!bank && selectedIds.some(id => bank.has(id));
  const otherBanksConflict = (letter: BankLetter): boolean =>
    (["A", "D", "S"] as BankLetter[]).some(l => l !== letter && bankConflict(bankOf(l)));
  // A/D feed a new node's ancestors/descendants, and A/D also wire directly
  // onto S (see wireBankToS) — so banking any of the three while another
  // already holds an ancestor/descendant of the incoming selection would wire
  // a cycle, and is blocked here instead. S is subject to both halves of the
  // check, since it plays the "future node" role for both A and D at once.
  function wouldCreateCycle(letter: BankLetter, sel: string[]): boolean {
    const dIsAncestor = !!bankD && sel.some(s => Array.from(bankD!).some(d => ancOf.get(s)!.has(d)));
    const aIsDescendant = !!bankA && sel.some(s => Array.from(bankA!).some(a => descOf.get(s)!.has(a)));
    if (letter === "A") return dIsAncestor;
    if (letter === "D") return aIsDescendant;
    return dIsAncestor || aIsDescendant;
  }
  function paintBankBadges(): void {
    nodes.forEach((_ln, id) => {
      const badge = nodeBank.get(id)!;
      if (bankA && bankA.has(id)) { badge.textContent = "A"; badge.className = "dag-bank-badge a"; badge.style.display = "block"; }
      else if (bankD && bankD.has(id)) { badge.textContent = "D"; badge.className = "dag-bank-badge d"; badge.style.display = "block"; }
      else if (bankS && bankS.has(id)) { badge.textContent = "S"; badge.className = "dag-bank-badge s"; badge.style.display = "block"; }
      else { badge.style.display = "none"; }
    });
  }
  // Clearing A/D also switches off the editor's matching toggle, if it was on.
  function clearBankA(): void {
    bankA = null;
    if (editorUseA) { editorUseA = false; updateEditorFlags(); }
    paintBankBadges(); updateBar();
  }
  function clearBankD(): void {
    bankD = null;
    if (editorUseD) { editorUseD = false; updateEditorFlags(); }
    paintBankBadges(); updateBar();
  }
  function clearBankS(): void { bankS = null; paintBankBadges(); updateBar(); }
  // Right-click: toggle S disabled/enabled, always emptying it in the process.
  function toggleDisableS(): void {
    bankSDisabled = !bankSDisabled;
    bankS = null;
    paintBankBadges(); updateBar();
  }
  // The set wireBankToS should treat as "S" — the real bank, unless it's been
  // disabled, in which case the current selection stands in for it directly
  // (and is never itself recorded into the bank).
  const effectiveS = (): Set<string> | null =>
    bankSDisabled ? (selectedIds.length ? new Set(selectedIds) : null) : bankS;
  // Giving each focus level its own banks would be a coordination nightmare
  // (a node banked here, then edited on a deeper level such that it becomes
  // kin of other bank members up here...) — simplest and safest is to just
  // empty everything whenever focus is pushed or popped.
  function clearAllBanks(): void {
    bankA = null; bankD = null; bankS = null;
    bankSDisabled = false;
    prospective = null;
    editorUseA = false; editorUseD = false; updateEditorFlags();
    paintBankBadges(); updateBar();
  }
  // A node can belong to at most one bank; right-click removes it from
  // whichever it's currently in (a no-op if it's in none).
  function removeFromBanks(id: string): boolean {
    let changed = false;
    if (bankA?.delete(id)) { changed = true; if (!bankA.size) bankA = null; }
    if (bankD?.delete(id)) { changed = true; if (!bankD.size) bankD = null; }
    if (bankS?.delete(id)) { changed = true; if (!bankS.size) bankS = null; }
    return changed;
  }

  // Try to bank `sel` into the given letter. Fails silently (returns false) on
  // a cross-bank conflict or a would-be A/D cycle. Setting A/D also toggles
  // the editor's matching attach flag, mirroring Ctrl+A/Ctrl+D in the editor.
  function setBank(letter: BankLetter, sel: string[]): boolean {
    if (otherBanksConflict(letter)) return false;
    if (wouldCreateCycle(letter, sel)) return false;
    const set = new Set(sel);
    if (letter === "A") { bankA = set; editorUseA = !editorUseA; updateEditorFlags(); }
    else if (letter === "D") { bankD = set; editorUseD = !editorUseD; updateEditorFlags(); }
    else { bankS = set; }
    paintBankBadges(); updateBar();
    return true;
  }
  // The full behaviour of pressing a bank key with the DAG in focus: arms
  // prospective mode when nothing's selected, or banks immediately otherwise.
  // While any bank is prospective, no bank key does anything further — Enter
  // commits it (see the keydown handler) and Esc cancels it, regardless of
  // which bank is armed.
  function pressBank(letter: BankLetter): void {
    if (prospective !== null) return;
    if (letter === "S" && bankSDisabled) return;
    if (!selectedIds.length) { prospective = letter; updateBar(); return; }
    setBank(letter, selectedIds);
  }
  // Shift+letter: XOR the current selection's membership in that bank instead
  // of overwriting it. Each node is still subject to the usual cross-bank and
  // cycle checks (individually — only the nodes that pass are toggled in).
  function toggleBankMembership(letter: BankLetter, sel: string[]): void {
    if (prospective !== null || !sel.length) return;
    if (letter === "S" && bankSDisabled) return;
    const cur = bankOf(letter);
    const next = cur ? new Set(cur) : new Set<string>();
    let changed = false;
    sel.forEach(id => {
      if (next.has(id)) { next.delete(id); changed = true; return; }
      const conflicts = (["A", "D", "S"] as BankLetter[]).some(l => l !== letter && bankOf(l)?.has(id));
      if (conflicts || wouldCreateCycle(letter, [id])) return;
      next.add(id); changed = true;
    });
    if (!changed) return;
    const result = next.size ? next : null;
    if (letter === "A") { bankA = result; editorUseA = !editorUseA; updateEditorFlags(); }
    else if (letter === "D") { bankD = result; editorUseD = !editorUseD; updateEditorFlags(); }
    else { bankS = result; }
    paintBankBadges(); updateBar();
  }
  // Enter, while a bank is armed: commit its selection, deselecting on success.
  // A failed attempt (conflict/cycle) or an empty selection leaves it armed.
  function commitProspective(): void {
    if (prospective === null) return;
    if (selectedIds.length && setBank(prospective, selectedIds)) {
      selectedIds = []; mode = "idle"; subBuffer = "";
      prospective = null;
      refresh();
    } else {
      updateBar();
    }
  }
  // Ctrl+A/Ctrl+D-on-S: if S is empty (and not disabled) but the current
  // selection would itself be a valid bank S, fill it first (as if S were
  // pressed) before the wiring action runs. Skipped while another bank is
  // prospective, same as pressBank — and while S is disabled, since then the
  // wiring action uses the selection directly and must never bank it.
  function ensureBankS(): void {
    if (prospective === null && !bankSDisabled && !bankS && selectedIds.length) setBank("S", selectedIds);
  }

  const singularRank = (): number | null => {
    if (!selectedIds.length) return null;
    const r0 = rankMap.get(selectedIds[0])!;
    return selectedIds.every(id => rankMap.get(id)! === r0) ? r0 : null;
  };
  const nodesOnRank = (r: number): string[] =>
    byRank[r].slice().sort((a, b) => a.y - b.y).map(ln => ln.def.id);

  // Whether Left/Right or Up/Down currently do anything, given the selection.
  const lrActive = (): boolean => {
    if (mode === "rank") return true;
    if (mode === "nodes") return singularRank() !== null;
    return false;
  };
  const udActive = (): boolean => {
    if (mode === "rank") return true;
    if (mode === "nodes" && selectedIds.length === 1) return true;
    return false;
  };

  // Enumerate a singular selection top-to-bottom, zero-padded to equal width.
  const computeEnum = (): { order: string[]; labels: Map<string, string> } => {
    const order = selectedIds.slice().sort((a, b) => {
      const delta = nodes.get(a)!.x - nodes.get(b)!.x;
      if (delta !== 0)
        return delta;
      return nodes.get(a)!.y - nodes.get(b)!.y;
    });
    const w = String(order.length).length;
    const labels = new Map<string, string>();
    order.forEach((id, i) => labels.set(id, String(i + 1).padStart(w, "0")));
    return { order, labels };
  };

  function renderEnum(): void {
    const { order, labels } = computeEnum();
    const w = String(order.length).length;
    order.forEach(id => {
      const ln = nodes.get(id)!, e = nodeEnum.get(id)!;
      e.textContent = labels.get(id)!;
      e.style.left = (ln.x + NODE_W - w * 6.5) + "px";   // top-right, just outside the box
      e.style.top = (ln.y - 14) + "px";
      e.style.opacity = ".55"; e.style.color = "#5b6b7a";
      e.style.display = "block";
    });
  }

  function renderSubselect(): void {
    const { labels } = computeEnum();
    selectedIds.forEach(id => {
      const cand = subBuffer === "" || labels.get(id)!.startsWith(subBuffer);
      const ln = nodes.get(id)!, e = nodeEnum.get(id)!;
      if (cand) {
        ln.el.style.outline = "2.5px dashed rgba(18,26,38,0.9)";   // dotted sub-selection border
        ln.el.style.outlineOffset = "-5px";
        e.style.opacity = "1"; e.style.color = "#0f1720";
      } else {
        ln.el.style.opacity = "0.3";
        e.style.opacity = "0.25";
      }
    });
  }

  function renderRank(r: number): void {
    colRects.forEach(c => {
      if (c.rank === r) {
        c.el.setAttribute("fill", "url(#rankHatch)");
        c.el.setAttribute("stroke", "rgba(224,180,0,0.55)");
        c.el.setAttribute("stroke-width", "2");
      }
    });
    const l = rankLabels[r];
    l.style.fontWeight = "800"; l.style.color = "#6a5d12";
    l.style.background = "rgba(232,197,0,0.30)";
    l.style.padding = "2px 6px"; l.style.borderRadius = "5px";
  }

  // One renderer for whatever mode we're in.
  function refresh(): void {
    if (mode === "idle") { resetFocus(); updateBar(); return; }
    if (mode === "rank") { resetFocus(); renderRank(rankSel); updateBar(); return; }
    applyFocus(selectedIds, 1, true);            // "nodes" or "subselect"
    if (selectedIds.length >= 2) {
      renderEnum();
      if (mode === "subselect") renderSubselect();
    }
    updateBar();
  }

  // ---- Status bar (union/intersection, selection type, nav hints, focus) ----
  const bar = document.createElement("div");
  bar.className = "dag-statusbar";
  const modeBtn = document.createElement("button");
  modeBtn.className = "dag-modebtn"; modeBtn.type = "button";
  modeBtn.title = "Emphasis mode — Union / Intersection (click, or press U / I)";
  const selInd = document.createElement("div");
  selInd.className = "dag-selind";
  selInd.title = "Selection: ∅ none · R rank · S single node · C nodes in one rank · M nodes across ranks";
  const lrInd = document.createElement("div");
  lrInd.className = "dag-navind";
  lrInd.textContent = "LR";
  lrInd.title = "Left/Right arrows — active when they'd change rank";
  const udInd = document.createElement("div");
  udInd.className = "dag-navind";
  udInd.textContent = "UD";
  udInd.title = "Up/Down arrows — active when they'd move within a rank";
  const focusInd = document.createElement("div");
  focusInd.className = "dag-focusind";
  focusInd.title = "Focus — F narrows to the selection's ancestry, Shift+F pops back out";
  const focusLetter = document.createElement("span");
  focusLetter.textContent = "F";
  const focusDepthEl = document.createElement("span");
  focusDepthEl.className = "dag-focus-depth";
  focusDepthEl.textContent = "0";
  focusInd.appendChild(focusLetter);
  focusInd.appendChild(focusDepthEl);
  const aBtn = document.createElement("button");
  aBtn.className = "dag-bankbtn a"; aBtn.type = "button"; aBtn.textContent = "A";
  aBtn.title = "Bank A — A banks/arms, Shift+A toggles membership, Alt+A clears, Ctrl+A/Ctrl+Shift+A wire it onto S as parents, hold C then A to centre on it";
  const sBtn = document.createElement("button");
  sBtn.className = "dag-bankbtn s"; sBtn.type = "button"; sBtn.textContent = "S";
  sBtn.title = "Bank S — S banks/arms, Shift+S toggles membership, Alt+S clears, right-click disables (S's wiring actions then use the selection directly), hold C then S to centre on it";
  const dBtn = document.createElement("button");
  dBtn.className = "dag-bankbtn d"; dBtn.type = "button"; dBtn.textContent = "D";
  dBtn.title = "Bank D — D banks/arms, Shift+D toggles membership, Alt+D clears, Ctrl+D/Ctrl+Shift+D wire it onto S as children, hold C then D to centre on it";
  const editorInd = document.createElement("button");
  editorInd.className = "dag-editorind"; editorInd.type = "button"; editorInd.textContent = "I";
  editorInd.title = "New node editor — W opens, click toggles open/closed";
  const delBtn = document.createElement("button");
  delBtn.className = "dag-delbtn"; delBtn.type = "button"; delBtn.textContent = "Del";
  delBtn.disabled = true;
  delBtn.title = "Delete the selected node(s) — Delete key, or Shift+right-click a node to delete just it";

  // Grouped into: state (LR/UD/selection), mode (U-I / Focus), banks (A/S/D),
  // editing (editor toggle / delete) — each wrapped in its own bordered box.
  const groupState = document.createElement("div");
  groupState.className = "dag-bargroup";
  groupState.append(lrInd, udInd, selInd);
  const groupMode = document.createElement("div");
  groupMode.className = "dag-bargroup";
  groupMode.append(modeBtn, focusInd);
  const groupBanks = document.createElement("div");
  groupBanks.className = "dag-bargroup";
  groupBanks.append(aBtn, sBtn, dBtn);
  const groupEditing = document.createElement("div");
  groupEditing.className = "dag-bargroup";
  groupEditing.append(editorInd, delBtn);
  bar.append(groupState, groupMode, groupBanks, groupEditing);
  panelFooter.appendChild(bar);
  modeBtn.addEventListener("click", () => { selMode = selMode === "union" ? "intersection" : "union"; refresh(); });
  aBtn.addEventListener("click", () => clearBankA());
  sBtn.addEventListener("click", () => clearBankS());
  dBtn.addEventListener("click", () => clearBankD());
  sBtn.addEventListener("contextmenu", ev => { ev.preventDefault(); toggleDisableS(); });
  editorInd.addEventListener("click", () => { if (editorOpen) closeEditor(); else openEditor(); });
  delBtn.addEventListener("click", () => deleteNodes(selectedIds));

  // Hovering a filled bank's icon highlights its nodes with a cross-hatch —
  // distinct from the coloured-drop-shadow/dotted-outline selection scheme.
  const bankHover = (bank: Set<string> | null, on: boolean): void => {
    if (!bank) return;
    bank.forEach(id => nodes.get(id)?.el.classList.toggle("bank-hover", on));
  };
  aBtn.addEventListener("mouseenter", () => bankHover(bankA, true));
  aBtn.addEventListener("mouseleave", () => bankHover(bankA, false));
  dBtn.addEventListener("mouseenter", () => bankHover(bankD, true));
  dBtn.addEventListener("mouseleave", () => bankHover(bankD, false));
  sBtn.addEventListener("mouseenter", () => bankHover(bankSDisabled ? null : bankS, true));
  sBtn.addEventListener("mouseleave", () => bankHover(bankSDisabled ? null : bankS, false));

  // Would banking the current selection into `letter` fail — either because it
  // overlaps a different bank, or because it would wire a future cycle?
  const wouldReject = (letter: BankLetter): boolean =>
    selectedIds.length > 0 && (otherBanksConflict(letter) || wouldCreateCycle(letter, selectedIds));
  // A/D, once filled: what would Ctrl+<letter>'s wiring action onto S do right
  // now? null = nothing special to report (no S target, or would do something
  // useful); "advisory" = every prospective pair either exists already or is
  // cycle-blocked, but at least one exists to remove in toggle mode (so this
  // only really means "union mode would be a no-op"); "blocked" = every
  // prospective pair is cycle-blocked and none exist — neither mode does
  // anything at all.
  function bankActionState(letter: "A" | "D"): "advisory" | "blocked" | null {
    const src = letter === "A" ? bankA : bankD;
    const target = effectiveS();
    if (!src || !src.size || !target || !target.size) return null;
    let anyAddable = false, anyRemovable = false, anyBlocked = false;
    src.forEach(u => target.forEach(v => {
      const [from, to] = letter === "A" ? [u, v] : [v, u];
      if (hasEdge(from, to)) anyRemovable = true;
      else if (ancOf.get(from)!.has(to)) anyBlocked = true;
      else anyAddable = true;
    }));
    if (anyAddable) return null;
    if (!anyRemovable && anyBlocked) return "blocked";
    return anyRemovable || anyBlocked ? "advisory" : null;
  }

  function updateBar(): void {
    modeBtn.textContent = selMode === "intersection" ? "I" : "U";
    modeBtn.classList.toggle("on", selMode === "intersection");
    let t = "∅";
    if (mode === "rank") t = "R";
    else if (mode === "nodes" || mode === "subselect")
      t = selectedIds.length === 1 ? "S" : (singularRank() !== null ? "C" : "M");
    selInd.textContent = t;
    lrInd.classList.toggle("off", !lrActive());
    udInd.classList.toggle("off", !udActive());
    delBtn.disabled = !selectedIds.length;

    const paintBank = (btn: HTMLButtonElement, letter: BankLetter, filled: boolean): void => {
      btn.classList.toggle("off", !filled);
      btn.classList.toggle("would-accept", !filled && selectedIds.length > 0 && !wouldReject(letter));
      btn.classList.toggle("conflict", wouldReject(letter));
      btn.classList.toggle("prospective", prospective === letter);
      btn.classList.toggle("locked", prospective !== null && prospective !== letter);
    };
    paintBank(aBtn, "A", !!bankA);
    paintBank(dBtn, "D", !!bankD);
    paintBank(sBtn, "S", !!bankS);
    sBtn.classList.toggle("disabled", bankSDisabled);

    const aState = bankA ? bankActionState("A") : null;
    const dState = bankD ? bankActionState("D") : null;
    aBtn.classList.toggle("action-advisory", aState === "advisory");
    aBtn.classList.toggle("action-blocked", aState === "blocked");
    dBtn.classList.toggle("action-advisory", dState === "advisory");
    dBtn.classList.toggle("action-blocked", dState === "blocked");
  }

  function updateFocusIndicator(): void {
    focusDepthEl.textContent = String(focusStack.length);
    focusInd.classList.toggle("off", focusStack.length === 0);
  }

  // ---- Manual horizontal scroll (whole-column steps) -----------------------
  let scrollCols = 0;
  const scrollEl = () => container.parentElement as HTMLElement;
  const viewportPx = () => (scrollEl() ? scrollEl().clientWidth : canvasW);
  const viewportCols = () => Math.max(1, Math.floor(viewportPx() / COL_W));
  const minScroll = () => -(viewportCols() - 1);
  const maxScroll = () => maxRank;
  const clampScroll = (c: number) => Math.max(minScroll(), Math.min(maxScroll(), Math.round(c)));
  // Scroll value that puts rank c's column centre in the middle of the viewport.
  // c may be fractional (e.g. 1.5), meaning "centred between ranks 1 and 2".
  const centerScrollFor = (c: number): number => (MARGIN + c * COL_W + COL_W / 2 - viewportPx() / 2) / COL_W;
  const clampRank = (r: number) => Math.max(0, Math.min(maxRank, r));

  // ---- Horizontal rank scrollbar: one tick per rank, a draggable view box --
  // Ticks/box/box are placed as fractions of the rank span alone (MARGIN
  // excluded), so the ranks land at perfectly even (r+0.5)/(maxRank+1) points.
  // Pools are sized to the full graph's rank count; relayout() (via
  // updateScrollbarGeometry) shows/hides & repositions down to the current one.
  const domainFrac = (canvasX: number) => (canvasX - MARGIN) / scrollDomain;

  const hscrollTrack = document.createElement("div");
  hscrollTrack.className = "dag-hscroll";
  const hscrollTicks: HTMLDivElement[] = [];
  const hscrollBorders: HTMLDivElement[] = [];
  // Tick and border are always created in pairs; the one trailing border past
  // the true last tick is simply never shown (updateScrollbarGeometry hides
  // any r >= maxRank), which sidesteps having to know which slot is "last".
  function addScrollSlot(): void {
    const tick = document.createElement("div");
    tick.className = "dag-hscroll-tick";
    hscrollTrack.appendChild(tick);
    hscrollTicks.push(tick);
    const border = document.createElement("div");
    border.className = "dag-hscroll-border";
    hscrollTrack.appendChild(border);
    hscrollBorders.push(border);
  }
  for (let r = 0; r <= maxRank0; r++) addScrollSlot();
  const hscrollBox = document.createElement("div");
  hscrollBox.className = "dag-hscroll-box";
  hscrollTrack.appendChild(hscrollBox);
  panelFooter.appendChild(hscrollTrack);

  // Grow the rank/scrollbar pools to cover a larger graph (addNode only ever
  // grows — a focused view narrows via `excluded` instead, never shrinking
  // these pools).
  function growRankPools(newMaxRank0: number): void {
    for (let r = maxRank0 + 1; r <= newMaxRank0; r++) { addRankSlot(r); addScrollSlot(); }
    maxRank0 = newMaxRank0;
  }

  // Position/size the view box from a (possibly fractional, mid-drag) scroll value.
  const paintScrollbar = (colsFloat: number): void => {
    hscrollBox.style.left = (domainFrac(colsFloat * COL_W) * 100).toFixed(3) + "%";
    hscrollBox.style.width = ((viewportPx() / scrollDomain) * 100).toFixed(3) + "%";
  };
  // Continuous (unrounded) rank the viewport is currently centred on.
  const centerRaw = (colsFloat: number): number => colsFloat - MARGIN / COL_W - 0.5 + viewportPx() / (2 * COL_W);
  // Highlight whichever tick(s) the viewport's true centre sits on — two,
  // straddling the middle, when it falls almost exactly between two ranks.
  const paintCurrentNotch = (): void => {
    const raw = centerRaw(scrollCols);
    const lo = Math.floor(raw);
    const ranks = Math.abs(raw - lo - 0.5) < 0.02 ? [clampRank(lo), clampRank(lo + 1)] : [clampRank(Math.round(raw))];
    hscrollTicks.forEach((t, r) => t.classList.toggle("current", r <= maxRank && ranks.includes(r)));
  };
  // Reposition/show-hide ticks and borders for the current maxRank, then repaint.
  function updateScrollbarGeometry(): void {
    hscrollTicks.forEach((tick, r) => {
      if (r <= maxRank) {
        tick.style.display = "";
        tick.style.left = (domainFrac(colX(r) + COL_W / 2) * 100).toFixed(3) + "%";
      } else {
        tick.style.display = "none";
      }
    });
    hscrollBorders.forEach((b, r) => {
      if (r < maxRank) {
        b.style.display = "";
        b.style.left = (domainFrac(colX(r) + COL_W) * 100).toFixed(3) + "%";
      } else {
        b.style.display = "none";
      }
    });
    paintScrollbar(scrollCols);
    paintCurrentNotch();
  }
  const applyScroll = () => {
    container.style.transform = `translateX(${-scrollCols * COL_W}px)`;
    paintScrollbar(scrollCols);
    paintCurrentNotch();
  };
  const setScroll = (c: number): void => { scrollCols = clampScroll(c); applyScroll(); };
  // Like setScroll, but keeps the fractional part — needed so "centre on rank c"
  // lands exactly in the middle of the viewport instead of snapping to a whole column.
  const setScrollExact = (c: number): void => { scrollCols = Math.max(minScroll(), Math.min(maxScroll(), c)); applyScroll(); };

  // Rank whose column centre is nearest the middle of the current (fractional) view.
  const colAtCenter = (colsFloat: number): number => clampRank(Math.round(centerRaw(colsFloat)));
  const setTargetNotch = (rank: number | null): void => {
    hscrollTicks.forEach((t, r) => t.classList.toggle("target", r === rank));
  };

  let dragging = false;
  let dragStartX = 0;
  let dragStartScroll = 0;
  hscrollBox.addEventListener("pointerdown", ev => {
    ev.preventDefault();
    dragging = true;
    dragStartX = ev.clientX;
    dragStartScroll = scrollCols;
    try { hscrollBox.setPointerCapture(ev.pointerId); } catch { /* fall back to bubbled events */ }
    hscrollBox.classList.add("dragging");
    setTargetNotch(colAtCenter(scrollCols));
  });
  hscrollBox.addEventListener("pointermove", ev => {
    if (!dragging) return;
    const trackW = hscrollTrack.clientWidth || 1;
    const deltaCols = ((ev.clientX - dragStartX) * (canvasW / trackW)) / COL_W;
    scrollCols = Math.max(minScroll(), Math.min(maxScroll(), dragStartScroll + deltaCols));
    applyScroll();                                    // continuous, unsnapped, while dragging
    setTargetNotch(colAtCenter(scrollCols));
  });
  const endHscrollDrag = (ev: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    hscrollBox.classList.remove("dragging");
    try { hscrollBox.releasePointerCapture(ev.pointerId); } catch { /* capture may already be gone */ }
    setScrollExact(centerScrollFor(colAtCenter(scrollCols)));   // snap: centre on the nearest rank
    setTargetNotch(null);
  };
  hscrollBox.addEventListener("pointerup", endHscrollDrag);
  hscrollBox.addEventListener("pointercancel", endHscrollDrag);

  // Which columns the current selection occupies.
  const currentCols = (): number[] => {
    if (mode === "rank") return [rankSel];
    if (mode === "nodes" || mode === "subselect")
      return [...new Set(selectedIds.map(id => rankMap.get(id)!))];
    return [];
  };
  // Scroll the (single) current column into view with the fewest whole-column shifts.
  const reveal = (): void => {
    const cols = currentCols();
    if (cols.length !== 1) return;
    const c = cols[0], vc = viewportCols();
    if (c < scrollCols) setScroll(c);
    else if (c > scrollCols + vc - 1) setScroll(c - vc + 1);
  };
  const centerOnSelection = (): void => {
    const cols = currentCols(); if (!cols.length) return;
    const c = (Math.min(...cols) + Math.max(...cols)) / 2;   // true midpoint — may sit between two ranks
    setScrollExact(centerScrollFor(c));
  };
  // Hold C, then A/S/D, then release C: centre on that bank's span instead of
  // the current selection. Ranks come from currently-visible (non-excluded)
  // members only.
  const centerOnBank = (letter: BankLetter): void => {
    const bank = bankOf(letter);
    if (!bank) return;
    const cols = Array.from(bank).map(id => rankMap.get(id)).filter((r): r is number => r !== undefined);
    if (!cols.length) return;
    const c = (Math.min(...cols) + Math.max(...cols)) / 2;
    setScrollExact(centerScrollFor(c));
  };

  // ---- Focus: push/pop a mask, narrowing the view to a selection's ancestry -
  let focusStack: Set<string>[] = [];

  // Selected nodes union their ancestors — computed as in Union mode
  // regardless of the current emphasis mode. Always an ancestor-closed
  // subgraph. (Pressing Space then F reaches the "include the frontier too"
  // case this used to need a separate Shift+F for.)
  function focusTargetSet(sel: string[]): Set<string> {
    const { green } = computeGreenAndDotted(sel, true);
    const set = new Set<string>(sel);
    green.forEach(id => set.add(id));
    return set;
  }

  function pushFocus(): void {
    if (!selectedIds.length) return;
    const target = focusTargetSet(selectedIds);
    const newExcluded = new Set<string>();
    g.nodes.forEach(n => { if (!target.has(n.id)) newExcluded.add(n.id); });
    const oldMaxRank = maxRank;
    focusStack.push(excluded);
    excluded = newExcluded;
    mode = "idle"; selectedIds = []; subBuffer = "";
    clearAllBanks();
    const newMaxRank = relayout();
    if (newMaxRank < oldMaxRank) setScrollExact(centerScrollFor(newMaxRank));   // fewer ranks -> centre on the last one
    refresh();
    updateFocusIndicator();
  }

  function popFocus(): void {
    if (!focusStack.length) return;
    excluded = focusStack.pop()!;
    mode = "idle"; selectedIds = []; subBuffer = "";
    clearAllBanks();
    relayout();                          // there are always at least as many ranks — no scroll adjustment needed
    refresh();
    updateFocusIndicator();
  }

  // ---- Navigation ----------------------------------------------------------
  const selectRankNodes = (r: number): void => {
    selectedIds = nodesOnRank(r); mode = "nodes"; subBuffer = ""; refresh(); reveal();
  };
  const moveRankSel = (dir: -1 | 1): void => {   // Left/Right on a singular selection
    const r = singularRank(); if (r === null) return;
    const target = r + dir;
    if (target < 0 || target > maxRank) return;
    const want = new Set<string>();
    for (const id of selectedIds) {
      const kin = dir < 0 ? parents.get(id)! : children.get(id)!;   // immediate ancestors / descendants
      for (const nb of kin) if (rankMap.get(nb) === target) want.add(nb);
    }
    if (!want.size) return;                       // no immediate kin on the neighbouring rank
    selectedIds = [...want]; mode = "nodes"; refresh(); reveal();
  };
  const moveWithinRank = (dir: -1 | 1): void => { // Up/Down on a single node (wraps)
    const id = selectedIds[0], order = nodesOnRank(rankMap.get(id)!), i = order.indexOf(id);
    selectedIds = [order[(i + dir + order.length) % order.length]];
    mode = "nodes"; refresh(); reveal();
  };
  const pickFromRank = (down: boolean): void => { // first Up/Down leaving rank mode
    const order = nodesOnRank(rankSel);
    selectedIds = [down ? order[0] : order[order.length - 1]];
    mode = "nodes"; refresh(); reveal();
  };
  // Space: advance the selection from the selected (yellow) nodes to the
  // frontier (dotted) nodes just beyond them.
  const advance = (): void => {
    const { dotted } = computeGreenAndDotted(selectedIds, false);
    if (!dotted.size) return;
    selectedIds = [...dotted]; mode = "nodes"; subBuffer = "";
    refresh(); reveal();
  };

  // ---- Sub-selection (type a number to isolate one node) -------------------
  function subDigit(d: string): void {
    const { labels } = computeEnum();
    const next = subBuffer + d;
    const cands = selectedIds.filter(id => labels.get(id)!.startsWith(next));
    if (!cands.length) return;                    // ignore a digit that matches nothing
    subBuffer = next;
    if (cands.length === 1) { selectedIds = [cands[0]]; subBuffer = ""; mode = "nodes"; }
    refresh();
  }
  const startSubselect = (d: string): void => { subPrior = selectedIds.slice(); subBuffer = ""; mode = "subselect"; subDigit(d); };
  const subBackspace = (): void => {
    subBuffer = subBuffer.slice(0, -1);
    if (subBuffer === "") mode = "nodes";         // emptied the buffer -> plain selection again
    refresh();
  };
  const exitSubselect = (): void => { selectedIds = subPrior; subBuffer = ""; mode = "nodes"; refresh(); };

  // ---- Node creation (W opens the editor, below the DAG view) ---------------
  let editorOpen = false;
  let editorUseA = false;
  let editorUseD = false;
  let nextNodeSeq = 1;

  const editorBox = document.createElement("div");
  editorBox.className = "dag-nodebox";
  const flagA = document.createElement("div"); flagA.className = "dag-nodebox-flag a";
  const flagD = document.createElement("div"); flagD.className = "dag-nodebox-flag d";
  const editorTitle = document.createElement("input");
  editorTitle.type = "text"; editorTitle.className = "dag-nodebox-title"; editorTitle.placeholder = "Title";
  const editorBody = document.createElement("textarea");
  editorBody.className = "dag-nodebox-body"; editorBody.placeholder = "Body (optional)";
  const editorHint = document.createElement("div");
  editorHint.className = "dag-nodebox-hint";
  editorHint.textContent = "Tab to switch fields · Ctrl+A/Ctrl+D toggle banks as ancestors/descendants · Ctrl+Enter adds · Esc cancels";
  const editorButtons = document.createElement("div");
  editorButtons.className = "dag-nodebox-buttons";
  const editorAddBtn = document.createElement("button");
  editorAddBtn.type = "button"; editorAddBtn.className = "dag-nodebox-btn primary";
  editorAddBtn.textContent = "Add Node"; editorAddBtn.tabIndex = -1;
  const editorCancelBtn = document.createElement("button");
  editorCancelBtn.type = "button"; editorCancelBtn.className = "dag-nodebox-btn";
  editorCancelBtn.textContent = "Cancel"; editorCancelBtn.tabIndex = -1;
  editorButtons.appendChild(editorAddBtn); editorButtons.appendChild(editorCancelBtn);
  editorBox.appendChild(flagA); editorBox.appendChild(flagD);
  editorBox.appendChild(editorTitle); editorBox.appendChild(editorBody);
  editorBox.appendChild(editorHint); editorBox.appendChild(editorButtons);
  panelFooter.appendChild(editorBox);
  editorAddBtn.addEventListener("click", () => commitEditor());
  editorCancelBtn.addEventListener("click", () => closeEditor());

  function updateEditorFlags(): void {
    flagA.classList.toggle("on", editorUseA);
    flagD.classList.toggle("on", editorUseD);
  }
  function openEditor(): void {
    if (editorOpen) return;
    editorOpen = true;
    editorUseA = !!bankA; editorUseD = !!bankD;   // default on if there's something to attach
    editorTitle.value = ""; editorBody.value = "";
    updateEditorFlags();
    editorBox.classList.add("open");
    editorInd.classList.add("open");
    editorTitle.focus();
  }
  function closeEditor(): void {
    editorOpen = false;
    editorBox.classList.remove("open");
    editorInd.classList.remove("open");
  }
  function commitEditor(): void {
    const title = editorTitle.value.trim();
    if (!title) { editorTitle.focus(); return; }   // a node needs a label
    addNode(title, editorBody.value.trim(), editorUseA, editorUseD);
    closeEditor();
  }

  // Isolated from the rest of the app's shortcuts: stopPropagation keeps every
  // keydown that reaches here (i.e. while a field in the box has focus) from
  // ever being seen by the global handler below.
  editorBox.addEventListener("keydown", ev => {
    ev.stopPropagation();
    const k = ev.key;
    if (k === "Tab") {
      ev.preventDefault();
      (document.activeElement === editorTitle ? editorBody : editorTitle).focus();
    } else if (ev.ctrlKey && (k === "a" || k === "A")) {
      ev.preventDefault();
      // An empty bank can't be toggled on — instead, act as if A were pressed
      // with the DAG in focus (banks the current selection, and toggles this
      // same flag as a side effect of setBank).
      if (bankA) { editorUseA = !editorUseA; updateEditorFlags(); }
      else pressBank("A");
    } else if (ev.ctrlKey && (k === "d" || k === "D")) {
      ev.preventDefault();
      if (bankD) { editorUseD = !editorUseD; updateEditorFlags(); }
      else pressBank("D");
    } else if (ev.ctrlKey && k === "Enter") {
      ev.preventDefault(); commitEditor();
    } else if (k === "Escape") {
      ev.preventDefault(); closeEditor();
    }
  });

  const addEdgeRaw = (from: string, to: string): void => { g.edges.push({ from, to }); };
  const removeEdge = (from: string, to: string): void => {
    const i = g.edges.findIndex(e => e.from === from && e.to === to);
    if (i >= 0) g.edges.splice(i, 1);
  };
  const hasEdge = (from: string, to: string): boolean => g.edges.some(e => e.from === from && e.to === to);

  // After `g.nodes`/`g.edges` change: recolour/redraw edges, recompute
  // ancestor/descendant relations, grow the rank pools if the graph now needs
  // more of them (it can only ever need more, never fewer), and relay out.
  function syncGraphStructure(): void {
    rebuildEdgeRecs();
    rebuildRelations();
    const newFullRankMap = computeRanks(g);
    const newMaxRank0 = Math.max(...g.nodes.map(n => newFullRankMap.get(n.id)!));
    if (newMaxRank0 > maxRank0) growRankPools(newMaxRank0);
    relayout();
  }

  // Add a new node to the (single, never-duplicated) graph `g`, wire it to
  // whatever's currently in banks A/D per the two flags, and bring the
  // persistent DOM up to date. Never touches selection or scroll position —
  // adding a node can only ever need as many or more ranks, never fewer.
  function addNode(title: string, body: string, useA: boolean, useD: boolean): void {
    const id = "N" + nextNodeSeq++;
    const def: NodeDef = { id, title, body: body || undefined };
    g.nodes.push(def);
    if (useA && bankA) bankA.forEach(a => addEdgeRaw(a, id));
    if (useD && bankD) bankD.forEach(d => addEdgeRaw(id, d));

    addNodeCard(def);
    syncGraphStructure();
    paintBankBadges();
    refresh();
  }

  // Ctrl+A / Ctrl+D with the DAG in focus: wire bank A on as parents of bank S
  // (or bank D on as children), skipping any pair that would close a cycle.
  // Toggle mode (default) removes an already-existing edge instead of adding
  // it; union mode (Ctrl+Shift) only ever adds, leaving existing ones be.
  function wireBankToS(source: "A" | "D", union: boolean): void {
    const src = source === "A" ? bankA : bankD;
    const target = effectiveS();
    if (!src || !target || !src.size || !target.size) return;
    let changed = false;
    src.forEach(u => {
      target.forEach(v => {
        const [from, to] = source === "A" ? [u, v] : [v, u];   // A: u is v's parent; D: v is u's parent
        if (hasEdge(from, to)) {
          if (!union) { removeEdge(from, to); changed = true; }
        } else if (!ancOf.get(from)!.has(to)) {                 // would `to` already be an ancestor of `from`?
          addEdgeRaw(from, to); changed = true;
        }
      });
    });
    if (changed) { syncGraphStructure(); refresh(); }   // ancestor/descendant sets shift -> selection colours can too
  }

  // ---- Delete: remove nodes from the graph, their banks, and the DOM -------
  function deleteNodes(ids: string[]): void {
    const idSet = new Set(ids.filter(id => nodes.has(id)));
    if (!idSet.size) return;
    g.nodes = g.nodes.filter(n => !idSet.has(n.id));
    g.edges = g.edges.filter(e => !idSet.has(e.from) && !idSet.has(e.to));
    idSet.forEach(id => {
      nodes.get(id)!.el.remove();                 // takes its tally/badge children with it
      nodes.delete(id);
      nodeEnum.get(id)?.remove();
      nodeEnum.delete(id);
      nodeTally.delete(id);
      nodeBank.delete(id);
      removeFromBanks(id);
    });
    selectedIds = selectedIds.filter(id => !idSet.has(id));
    if (!selectedIds.length) mode = "idle";
    subBuffer = "";
    syncGraphStructure();
    paintBankBadges();
    refresh();
  }

  // ---- Mouse ---------------------------------------------------------------
  // A function declaration (hoisted) so addNodeCard can wire a node up front,
  // before the rest of this section — which defines mode/selectedIds/etc — has
  // executed. The listeners themselves only run later, once those exist.
  function wireNode(ln: LaidNode): void {
    const id = ln.def.id;
    ln.el.addEventListener("click", ev => {
      ev.stopPropagation();
      // Prospective mode overrides Shift: every click just toggles membership.
      const toggling = prospective !== null || (ev.shiftKey && mode === "nodes" && selectedIds.length);
      if (toggling) {
        if (selectedIds.includes(id)) {
          selectedIds = selectedIds.filter(x => x !== id);           // already selected -> deselect
        } else if (!blockedSet.has(id)) {
          selectedIds = [...selectedIds, id];                        // barrier: an insensible pick
        }
        mode = selectedIds.length ? "nodes" : "idle";
      } else if (selectedIds.length === 1 && selectedIds[0] === id) {
        selectedIds = []; mode = "idle";                              // toggle the sole selection off
      } else {
        selectedIds = [id]; mode = "nodes";                          // fresh single selection
      }
      subBuffer = "";
      if (selectedIds.length) refresh();
      else { refresh(); applyFocus([id], HOVER, false); }            // deselected but still hovering
    });
    ln.el.addEventListener("mouseenter", () => {
      if (mode !== "idle") { updateCursors(); return; }              // a committed view is frozen
      applyFocus([id], HOVER, false);
    });
    ln.el.addEventListener("mouseleave", () => {
      if (mode !== "idle") return;
      resetFocus();
    });
    // Right-click: clear this node's bank membership. Shift+right-click:
    // delete it outright, regardless of the current selection.
    ln.el.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      if (ev.shiftKey) { deleteNodes([id]); return; }
      if (removeFromBanks(id)) { paintBankBadges(); updateBar(); }
    });
  }

  // ---- Keyboard ------------------------------------------------------------
  // Holding C then pressing A/S/D centres on that bank immediately; releasing
  // C without ever having done so centres on the selection instead. Tracked
  // here, independently of the bank keys' own handling below.
  let heldC = false;
  let cComboFired = false;   // a bank centred while this C hold is still down
  document.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "shift") { if (!shiftHeld) { shiftHeld = true; updateCursors(); } return; }
    if (k === "c") { if (!heldC) { heldC = true; cComboFired = false; } return; }
    if (heldC && !e.ctrlKey && !e.altKey && !e.shiftKey && (k === "a" || k === "s" || k === "d")) {
      e.preventDefault();
      centerOnBank(k.toUpperCase() as BankLetter);
      cComboFired = true;
    }
  });
  document.addEventListener("keyup", e => {
    const k = e.key.toLowerCase();
    if (k === "shift") { shiftHeld = false; updateCursors(); return; }
    if (k === "c") {
      if (!cComboFired) centerOnSelection();
      heldC = false; cComboFired = false;
    }
  });
  window.addEventListener("blur", () => { heldC = false; cComboFired = false; });

  document.addEventListener("keydown", e => {
    const k = e.key;
    if (k === "Shift" || k === "c" || k === "C") return;   // handled by the tracking listener above

    // A prospective bank takes over Esc/Enter before anything else does.
    if (prospective !== null && k === "Escape") { e.preventDefault(); prospective = null; updateBar(); return; }
    if (prospective !== null && k === "Enter")  { e.preventDefault(); commitProspective(); return; }

    // Holding C takes priority over A/S/D's own bindings (see above).
    if (heldC && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        (k === "a" || k === "A" || k === "s" || k === "S" || k === "d" || k === "D")) {
      e.preventDefault();
      return;
    }

    // Global: manual scroll, emphasis mode, and focus.
    if (e.altKey && k === "ArrowLeft")  { e.preventDefault(); setScroll(scrollCols - 1); return; }
    if (e.altKey && k === "ArrowRight") { e.preventDefault(); setScroll(scrollCols + 1); return; }
    if (k === "i" || k === "I") { e.preventDefault(); selMode = "intersection"; refresh(); return; }
    if (k === "u" || k === "U") { e.preventDefault(); selMode = "union"; refresh(); return; }
    if (k === "f" || k === "F") { e.preventDefault(); if (e.shiftKey) popFocus(); else pushFocus(); return; }
    if (k === "a" || k === "A") {
      e.preventDefault();
      if (e.ctrlKey) { ensureBankS(); wireBankToS("A", e.shiftKey); }
      else if (e.altKey) clearBankA();
      else if (e.shiftKey) toggleBankMembership("A", selectedIds);
      else pressBank("A");
      return;
    }
    if (k === "d" || k === "D") {
      e.preventDefault();
      if (e.ctrlKey) { ensureBankS(); wireBankToS("D", e.shiftKey); }
      else if (e.altKey) clearBankD();
      else if (e.shiftKey) toggleBankMembership("D", selectedIds);
      else pressBank("D");
      return;
    }
    if (k === "s" || k === "S") {
      e.preventDefault();
      if (e.altKey) clearBankS();
      else if (e.ctrlKey) { /* reserved */ }
      else if (e.shiftKey) toggleBankMembership("S", selectedIds);
      else pressBank("S");
      return;
    }
    if ((k === "w" || k === "W") && !e.ctrlKey && !e.altKey) { e.preventDefault(); openEditor(); return; }

    if (k === "Delete" && selectedIds.length) { e.preventDefault(); deleteNodes(selectedIds); return; }

    if (k === "Home") { e.preventDefault(); selectRankNodes(0); return; }
    if (k === "End")  { e.preventDefault(); selectRankNodes(maxRank); return; }

    if (mode === "subselect") {
      if (k === "Escape")         { e.preventDefault(); exitSubselect(); }
      else if (k === "Backspace") { e.preventDefault(); subBackspace(); }
      else if (/^[0-9]$/.test(k)) { e.preventDefault(); subDigit(k); }
      return;
    }

    if (mode === "rank") {
      if (k === "Escape")          { e.preventDefault(); mode = "idle"; refresh(); }
      else if (k === " ")          { e.preventDefault(); selectRankNodes(rankSel); }   // select the whole rank
      else if (k === "ArrowLeft")  { e.preventDefault(); if (rankSel > 0) { rankSel--; refresh(); reveal(); } }
      else if (k === "ArrowRight") { e.preventDefault(); if (rankSel < maxRank) { rankSel++; refresh(); reveal(); } }
      else if (k === "ArrowUp")    { e.preventDefault(); pickFromRank(false); }   // enter at the bottom
      else if (k === "ArrowDown")  { e.preventDefault(); pickFromRank(true); }    // enter at the top
      return;
    }

    if (mode === "nodes") {
      const r = singularRank();
      if (k === "Escape") {
        e.preventDefault();
        if (r !== null) { mode = "rank"; rankSel = r; selectedIds = []; refresh(); }   // singular -> select the rank
        else { mode = "idle"; selectedIds = []; refresh(); }                           // multi-rank -> deselect
        return;
      }
      if (selectedIds.length >= 2 && /^[0-9]$/.test(k))  { e.preventDefault(); startSubselect(k); }
      if (k === " ") { e.preventDefault(); advance(); return; }
      if (r === null) return;                       // multi-rank selection: only Esc/Home/End act
      if (k === "ArrowLeft")       { e.preventDefault(); moveRankSel(-1); }
      else if (k === "ArrowRight") { e.preventDefault(); moveRankSel(1); }
      else if (selectedIds.length === 1 && k === "ArrowUp")   { e.preventDefault(); moveWithinRank(-1); }
      else if (selectedIds.length === 1 && k === "ArrowDown") { e.preventDefault(); moveWithinRank(1); }
      return;
    }
    // idle: only Home/End (handled above) act.
  });

  // Click on empty space returns to the default deselected state.
  container.addEventListener("click", () => {
    if (mode !== "idle") { mode = "idle"; selectedIds = []; subBuffer = ""; refresh(); }
  });

  relayout();
  applyScroll();
  updateBar();
  updateFocusIndicator();
}

// ============================================================================
//  Dummy graph. Ranks resolve to: A(0) | B,C(1) | D,E,G(2) | F(3) | H(4)
//  Snaking edges: A->F, A->H, C->F, E->H
// ============================================================================
const demo: GraphDef = {
  nodes: [
    { id: "A", title: "Ingest",     body: "Read raw events from the source queue." },
    { id: "B", title: "Validate",   body: "Schema + range checks. Rejects go to a dead-letter store for later inspection." },
    { id: "C", title: "Normalize" },
    { id: "D", title: "Enrich",     body: "Join reference data." },
    { id: "E", title: "Score",      body: "Apply the model." },
    { id: "G", title: "Audit log",  body: "Append-only trail." },
    { id: "F", title: "Aggregate",  body: "Roll up per-window metrics before they are written downstream." },
    { id: "H", title: "Publish",    body: "Emit to the sink and notify subscribers." },
  ],
  edges: [
    { from: "A", to: "B" }, { from: "A", to: "C" }, { from: "A", to: "F" }, { from: "A", to: "H" },
    { from: "B", to: "D" }, { from: "B", to: "G" },
    { from: "C", to: "D" }, { from: "C", to: "E" }, { from: "C", to: "F" }, { from: "C", to: "G" },
    { from: "D", to: "F" },
    { from: "E", to: "F" }, { from: "E", to: "H" },
    { from: "F", to: "H" },
  ],
};

render(document.getElementById("stage")!, demo);
