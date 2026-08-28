// ============================================================================
//  Application shell — DOM creation, mouse/keyboard interaction, and all the
//  ephemeral UI state (selection, banks, the editor, focus, keyboard
//  partitions). The DAG's actual data lives in state.ts (nodes/edges, and
//  every mutation to them); ancestry/ranking queries live in queries.ts;
//  the coordinate-assignment layout algorithm lives in layout.ts; user
//  preferences live in settings.ts. This file is the only one that touches
//  the DOM.
//  - Focus: an "excluded" node-id mask lets the view narrow to a subgraph
//    without ever duplicating the graph itself — every layout pass filters
//    the current node/edge lists by this mask at the moment it runs, then
//    re-lays-out and repaints the same, persistent DOM elements.
// ============================================================================

import type { NodeDef, GraphDef } from "./state";
import {
  initGraph, getNodes, getEdges, hasEdge, addEdge, deleteEdge,
  addNode as graphAddNode, updateNode, deleteNodes as graphDeleteNodes,
} from "./state";
import { computeRanks, computeRelations } from "./queries";
import {
  computeLayout, bezierPath, colX, edgeKey,
  COL_W, H_PAD, NODE_W, MARGIN, LABEL_BAND,
} from "./layout";
import type { NodeSize } from "./layout";
import { getSettings, setSettingValue } from "./settings";
import type { FollowMode } from "./settings";

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

// ============================================================================
//  Layout + render
// ============================================================================
function render(container: HTMLElement, initial: GraphDef): void {
  initGraph(initial);

  // ---- Focus mask -----------------------------------------------------------
  // `excluded` names the node ids currently hidden from view. The graph data
  // itself is never copied or mutated by this — every layout pass filters
  // the current node/edge lists by this mask at the moment it runs, so
  // toggling focus just means recomputing a layout.
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
  const fullRankMap0 = computeRanks({ nodes: getNodes().slice(), edges: getEdges().slice() });
  let maxRank0 = Math.max(...getNodes().map(n => fullRankMap0.get(n.id)!));

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
  interface EdgeRec {
    from: string; to: string;
    el: SVGElement;    // the visible, decorative path
    hit: SVGElement;   // a fat transparent path that actually catches the mouse
    color: string;
    hoverW?: number;   // stroke-width to restore when a hover ends
  }
  const edgeRecs: EdgeRec[] = [];
  const activeEdges = new Set<number>();   // indices emphasised by the current applyFocus
  let hoveredEdge: number | null = null;

  // Whether edge `i` responds to the mouse right now. In Union/Intersection
  // with a committed selection only the emphasised (active) edges do; with no
  // selection, or in Edit / rank mode, every visible edge does.
  function edgeTargetable(i: number): boolean {
    if (edgeRecs[i].el.style.display === "none") return false;
    if (selMode === "edit") return true;
    if ((mode === "nodes" || mode === "subselect") && selectedIds.length) return activeEdges.has(i);
    return true;
  }
  function setEdgeHover(i: number, on: boolean): void {
    const rec = edgeRecs[i];
    if (on) {
      if (rec.hoverW === undefined)
        rec.hoverW = parseFloat(rec.el.getAttribute("stroke-width") || "2");
      rec.el.setAttribute("stroke-width", (rec.hoverW + 2.5).toFixed(1));
      rec.el.style.filter = `drop-shadow(0 0 3px ${rec.color})`;   // a glow — unlike the fade/emphasis scheme
      rec.el.style.opacity = "1";
      svg.appendChild(rec.el);                                     // lift it above its neighbours
    } else {
      rec.el.setAttribute("stroke-width", String(rec.hoverW ?? 2));
      rec.el.style.filter = "";
      rec.hoverW = undefined;
    }
  }
  function clearEdgeHover(): void {
    if (hoveredEdge !== null) { setEdgeHover(hoveredEdge, false); hoveredEdge = null; }
  }
  function rebuildEdgeRecs(): void {
    edgeRecs.forEach(r => { r.el.remove(); r.hit.remove(); });
    edgeRecs.length = 0;
    activeEdges.clear();
    hoveredEdge = null;
    const E = getEdges();
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
      path.style.pointerEvents = "none";   // the fat hit path below does the catching
      svg.appendChild(path);               // appended last -> always in front of rank rects

      const hit = document.createElementNS(SVG, "path");
      hit.setAttribute("fill", "none");
      hit.setAttribute("stroke", "transparent");
      hit.setAttribute("stroke-width", "14");
      hit.style.pointerEvents = "stroke";
      svg.appendChild(hit);

      const rec: EdgeRec = { from: e.from, to: e.to, el: path, hit, color: PALETTE[edgeColor[i]] };
      edgeRecs.push(rec);

      hit.addEventListener("mouseenter", () => {
        if (!edgeTargetable(i)) { hit.style.cursor = ""; return; }
        hit.style.cursor = "pointer";
        clearEdgeHover();
        hoveredEdge = i;
        setEdgeHover(i, true);
      });
      hit.addEventListener("mouseleave", () => { if (hoveredEdge === i) clearEdgeHover(); });
      hit.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (!edgeTargetable(i)) return;
        clearEdgeHover();
        deleteEdge(rec.from, rec.to);
        syncGraphStructure();
        refresh();
      });
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
  getNodes().forEach(def => addNodeCard(def));

  // --- Graph relations — recomputed whenever the graph is mutated (addNode) --
  let children = new Map<string, string[]>();
  let parents = new Map<string, string[]>();
  let ancOf = new Map<string, Set<string>>();
  let descOf = new Map<string, Set<string>>();

  function rebuildRelations(): void {
    const rel = computeRelations({ nodes: getNodes().slice(), edges: getEdges().slice() });
    children = rel.children; parents = rel.parents; ancOf = rel.ancOf; descOf = rel.descOf;
  }
  rebuildRelations();

  // ---- Mutable per-layout state, recomputed by relayout() -------------------
  let rankMap = new Map<string, number>();
  let maxRank = 0;
  let byRank: LaidNode[][] = [];
  let canvasW = 0, canvasH = 0;
  let scrollDomain = COL_W;

  // Re-run the layout algorithm (layout.ts, given each node's measured size)
  // over whichever nodes/edges are currently included, and paint the result
  // onto the persistent DOM. No new graph object is retained anywhere —
  // `induced` is thrown away once this returns. Returns the new maxRank.
  function relayout(): number {
    const inducedNodes = getNodes().filter(n => included(n.id));
    const inducedEdges = getEdges().filter(e => included(e.from) && included(e.to));
    const induced: GraphDef = { nodes: inducedNodes, edges: inducedEdges };

    rankMap = computeRanks(induced);
    maxRank = inducedNodes.length ? Math.max(...inducedNodes.map(n => rankMap.get(n.id)!)) : 0;

    const sizes = new Map<string, NodeSize>();
    inducedNodes.forEach(def => {
      const ln = nodes.get(def.id)!;
      sizes.set(def.id, { width: ln.width, height: ln.height });
    });
    const layout = computeLayout(induced, rankMap, maxRank, sizes);
    canvasW = layout.canvasW; canvasH = layout.canvasH; scrollDomain = layout.scrollDomain;

    byRank = layout.byRank.map(ids => ids.map(id => nodes.get(id)!));
    layout.positions.forEach((pos, id) => {
      const ln = nodes.get(id)!;
      ln.rank = pos.rank; ln.orderInRank = pos.orderInRank; ln.x = pos.x; ln.y = pos.y;
    });

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
    getEdges().forEach((e, i) => {
      const rec = edgeRecs[i];
      if (includedEdgeKeys.has(edgeKey(e))) {
        const d = bezierPath(layout.edgeAnchors.get(edgeKey(e))!);
        rec.el.style.display = "";
        rec.hit.style.display = "";
        rec.el.setAttribute("d", d);
        rec.hit.setAttribute("d", d);
      } else {
        rec.el.style.display = "none";
        rec.hit.style.display = "none";
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
  // "edit" replaces ancestor/descendant emphasis with three independent,
  // directly-clicked node selections (green/red/yellow = A/D/S) — see
  // applyEditFocus() and editBankClick().
  let selMode: "union" | "intersection" | "edit" = "union";

  // The barrier cursor only signals that adding a green/red node is blocked —
  // toggling (Shift, or prospective mode overriding it) an already-selected
  // node back off is always allowed, so selected nodes never show it.
  const updateCursors = (): void => {
    const barring = shiftHeld || prospective !== null;
    nodes.forEach(ln => {
      const id = ln.def.id;
      const barred = barredSet.has(id) || prospectiveBlocked(id);
      ln.el.style.cursor = barring && barred ? "not-allowed" : "pointer";
    });
  };

  function resetFocus(): void {
    nodes.forEach(ln => {
      const s = ln.el.style;
      s.opacity = ""; s.boxShadow = ""; s.outline = ""; s.outlineOffset = "";
    });
    nodeTally.forEach(t => { t.style.display = "none"; t.innerHTML = ""; });
    nodeEnum.forEach(e => { e.style.display = "none"; });
    clearEdgeHover();
    activeEdges.clear();
    edgeRecs.forEach(r => { r.el.setAttribute("stroke-width", "2"); r.el.style.opacity = "1"; r.el.style.filter = ""; });
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
        st.outline = `${(1.5 + s).toFixed(1)}px dashed ${rgbaStr(DOTTED_COL, 0.5 + 0.4 * s)}`;
        st.outlineOffset = `-${(3 + 2 * s).toFixed(1)}px`;
      }
    });

    edgeRecs.forEach((r, i) => {
      const active = (setA.has(r.from) && setA.has(r.to)) || (setD.has(r.from) && setD.has(r.to));
      if (active) {
        activeEdges.add(i);
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

  // Edit mode's rendering: just the three bank rings, full strength, with no
  // ancestor/descendant computation at all — there's no single "selection" to
  // compute a cone from, only three independent node sets.
  function applyEditFocus(): void {
    resetFocus();
    const paint = (bank: Set<string> | null, color: number[]): void => {
      bank?.forEach(id => {
        if (!included(id)) return;
        const ln = nodes.get(id); if (!ln) return;
        ln.el.style.boxShadow = ringShadow(rgbaStr(color, 0.85), 2.6, 0.4);
        ln.el.style.opacity = "1";
      });
    };
    paint(bankA, HL.green);
    paint(bankD, HL.red);
    paint(bankS, HL.yellow);
  }
  // M / the mode button: cycle Union -> Intersection -> Edit -> Union. Banks
  // A/S/D are shared state either way (Edit mode just populates them by
  // clicking instead of select-then-press), so nothing needs clearing here.
  function cycleSelMode(): void {
    const next = selMode === "union" ? "intersection" : selMode === "intersection" ? "edit" : "union";
    // None of A/S/D can stay disabled while they're live edit-mode targets —
    // remember whatever each was set to, force it enabled for the duration
    // (still via its own toggleDisableX here, before selMode flips, so that
    // function's edit-mode guard doesn't block it), and put it back exactly
    // as found on the way out.
    if (next === "edit" && selMode !== "edit") {
      bankADisabledBeforeEdit = bankADisabled;
      bankDDisabledBeforeEdit = bankDDisabled;
      bankSDisabledBeforeEdit = bankSDisabled;
      if (bankADisabled) toggleDisableA();
      if (bankDDisabled) toggleDisableD();
      if (bankSDisabled) toggleDisableS();
    } else if (selMode === "edit" && next !== "edit") {
      // Re-disabling always empties the bank, same as toggleDisableX.
      if (bankADisabledBeforeEdit) { stripBankHover(bankA); bankADisabled = true; bankA = null; }
      if (bankDDisabledBeforeEdit) { stripBankHover(bankD); bankDDisabled = true; bankD = null; }
      if (bankSDisabledBeforeEdit) { stripBankHover(bankS); bankSDisabled = true; bankS = null; }
      paintBankBadges();
    }
    selMode = next;
    refresh();
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
  // Starting state comes from settings.ts (bank{A,S,D}DisabledByDefault).
  let bankSDisabled = getSettings().bankSDisabledByDefault.value;
  // Right-click on A/D deactivates them the same way — emptied, no
  // Prospective Mode, bare A/D presses do nothing. Unlike S, though, A/D
  // still have a job while disabled: attaching to a new node being created
  // (see boundA/boundD below).
  let bankADisabled = getSettings().bankADisabledByDefault.value;
  let bankDDisabled = getSettings().bankDDisabledByDefault.value;
  // Remembers bankXDisabled across a trip through Edit mode (where all three
  // are always forced off) — see cycleSelMode.
  let bankSDisabledBeforeEdit = false;
  let bankADisabledBeforeEdit = false;
  let bankDDisabledBeforeEdit = false;
  // While A/D are disabled, Ctrl+A/Ctrl+D in the editor still needs
  // somewhere to remember "attach these as parents/children of the new
  // node" — bankA/bankD stay empty (disabled means no real bank), so this
  // is where that pending selection lives instead. Set by an explicit
  // overwrite (see handlePaneKeydown), not by toggling membership one node
  // at a time like a real bank — and still checked by wouldCreateCycle,
  // exactly as bankA/bankD would be, so e.g. Ctrl+D can't bind something
  // that would cycle against whatever Ctrl+A bound.
  let boundA: Set<string> | null = null;
  let boundD: Set<string> | null = null;
  // Pressing a bank key with nothing selected arms it, waiting for a selection
  // to bank (and deselect) on the next press — instead of banking immediately.
  let prospective: BankLetter | null = null;

  const bankOf = (letter: BankLetter): Set<string> | null =>
    letter === "A" ? bankA : letter === "D" ? bankD : bankS;
  // A node can only ever belong to one bank — this is what blocks banking a
  // selection that overlaps a *different* bank.
  const bankConflict = (bank: Set<string> | null, sel: string[]): boolean =>
    !!bank && sel.some(id => bank.has(id));
  const otherBanksConflict = (letter: BankLetter, sel: string[]): boolean =>
    (["A", "D", "S"] as BankLetter[]).some(l => l !== letter && bankConflict(bankOf(l), sel));
  // A/D feed a new node's ancestors/descendants, and A/D also wire directly
  // onto S (see wireBankToS) — so banking any of the three while another
  // already holds an ancestor/descendant of the incoming selection would wire
  // a cycle, and is blocked here instead. S is subject to both halves of the
  // check, since it plays the "future node" role for both A and D at once.
  function wouldCreateCycle(letter: BankLetter, sel: string[]): boolean {
    // Disabled A/D still have to be checked against — see boundA/boundD.
    const dSet = bankDDisabled ? boundD : bankD;
    const aSet = bankADisabled ? boundA : bankA;
    const dIsAncestor = !!dSet && sel.some(s => Array.from(dSet).some(d => ancOf.get(s)!.has(d)));
    const aIsDescendant = !!aSet && sel.some(s => Array.from(aSet).some(a => descOf.get(s)!.has(a)));
    if (letter === "A") return dIsAncestor;
    if (letter === "D") return aIsDescendant;
    return dIsAncestor || aIsDescendant;
  }
  // Would clicking `id` while `letter` is prospective be rejected outright —
  // it's already in a different bank, or it would create an A/D cycle? Used
  // both to keep the click from ever adding it, and to bar the cursor over
  // it. Never true for an already-selected node: toggling one back off is
  // always allowed.
  function prospectiveBlocked(id: string): boolean {
    if (prospective === null || selectedIds.includes(id)) return false;
    return otherBanksConflict(prospective, [id]) || wouldCreateCycle(prospective, [id]);
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
  // A bank's icon can be mid-hover (cross-hatch applied to its members) at
  // the moment the bank is cleared by a click on that same icon — the
  // matching mouseleave never runs, since the icon doesn't actually move, so
  // its members would otherwise be stuck cross-hatched forever. Every path
  // that empties a bank strips it first.
  const stripBankHover = (bank: Set<string> | null): void => {
    bank?.forEach(id => nodes.get(id)?.el.classList.remove("bank-hover"));
  };
  // Clearing A/D also switches off the editor's matching toggle, if it was
  // on, and drops any pending disabled-mode attach set (boundA/boundD) —
  // refresh() (not just paintBankBadges/updateBar) matters here because
  // edit mode's node rings are painted directly from bank contents.
  function clearBankA(): void {
    stripBankHover(bankA);
    bankA = null; boundA = null;
    editorUseA = false; updateEditorFlags();
    paintBankBadges(); refresh();
  }
  function clearBankD(): void {
    stripBankHover(bankD);
    bankD = null; boundD = null;
    editorUseD = false; updateEditorFlags();
    paintBankBadges(); refresh();
  }
  function clearBankS(): void { stripBankHover(bankS); bankS = null; paintBankBadges(); refresh(); }
  // Right-click: toggle disabled/enabled, always emptying the bank (and any
  // pending disabled-mode attach set) in the process.
  function toggleDisableS(): void {
    if (selMode === "edit") return;   // S can't be disabled while it's a live edit-mode target
    stripBankHover(bankS);
    bankSDisabled = !bankSDisabled;
    bankS = null;
    paintBankBadges(); refresh();
  }
  function toggleDisableA(): void {
    if (selMode === "edit") return;   // A can't be disabled while it's a live edit-mode target
    stripBankHover(bankA);
    bankADisabled = !bankADisabled;
    bankA = null; boundA = null;
    editorUseA = false; updateEditorFlags();
    paintBankBadges(); refresh();
  }
  function toggleDisableD(): void {
    if (selMode === "edit") return;   // D can't be disabled while it's a live edit-mode target
    stripBankHover(bankD);
    bankDDisabled = !bankDDisabled;
    bankD = null; boundD = null;
    editorUseD = false; updateEditorFlags();
    paintBankBadges(); refresh();
  }
  // Ctrl+Left / Ctrl+Right with the DAG in focus: move bank S's contents
  // wholesale into bank D / A, emptying S and whatever the destination held.
  // A disabled or empty S does nothing; a disabled destination is re-enabled.
  function moveBankSInto(letter: "A" | "D"): void {
    if (bankSDisabled || !bankS || !bankS.size) return;
    const ids = Array.from(bankS);
    stripBankHover(bankS);
    bankS = null;
    if (letter === "A") {
      stripBankHover(bankA);
      bankADisabled = false; boundA = null;
      bankA = new Set(ids);
    } else {
      stripBankHover(bankD);
      bankDDisabled = false; boundD = null;
      bankD = new Set(ids);
    }
    paintBankBadges();
    refresh();
  }

  // The set wireBankToS should treat as "S" — the real bank, unless it's been
  // disabled, in which case the current selection stands in for it directly
  // (and is never itself recorded into the bank).
  const effectiveS = (): Set<string> | null =>
    bankSDisabled ? (selectedIds.length ? new Set(selectedIds) : null) : bankS;
  // What the editor should actually attach as parents/children when the new
  // node is added: the real toggle when enabled, or whatever's pending in
  // boundA/boundD when disabled — see handlePaneKeydown.
  const attachA = (): boolean => bankADisabled ? !!boundA : editorUseA;
  const attachD = (): boolean => bankDDisabled ? !!boundD : editorUseD;
  // Giving each focus level its own banks would be a coordination nightmare
  // (a node banked here, then edited on a deeper level such that it becomes
  // kin of other bank members up here...) — simplest and safest is to just
  // empty everything whenever focus is pushed or popped.
  function clearAllBanks(): void {
    bankA = null; bankD = null; bankS = null;
    boundA = null; boundD = null;
    bankADisabled = false; bankDDisabled = false; bankSDisabled = false;
    prospective = null;
    editorUseA = false; editorUseD = false; updateEditorFlags();
    paintBankBadges(); updateBar();
  }
  // A node can belong to at most one bank; right-click removes it from
  // whichever it's currently in (a no-op if it's in none). Also prunes it
  // from boundA/boundD, since a deleted node can't stay pending-bound to a
  // new one that hasn't been created yet.
  function removeFromBanks(id: string): boolean {
    let changed = false;
    if (bankA?.delete(id)) { changed = true; if (!bankA.size) bankA = null; }
    if (bankD?.delete(id)) { changed = true; if (!bankD.size) bankD = null; }
    if (bankS?.delete(id)) { changed = true; if (!bankS.size) bankS = null; }
    if (boundA?.delete(id) && !boundA.size) boundA = null;
    if (boundD?.delete(id) && !boundD.size) boundD = null;
    return changed;
  }

  // Try to bank `sel` into the given letter. Fails silently (returns false) on
  // a cross-bank conflict or a would-be A/D cycle.
  function setBankRaw(letter: BankLetter, sel: string[]): boolean {
    if (otherBanksConflict(letter, sel)) return false;
    if (wouldCreateCycle(letter, sel)) return false;
    const set = new Set(sel);
    if (letter === "A") bankA = set;
    else if (letter === "D") bankD = set;
    else bankS = set;
    paintBankBadges(); updateBar();
    return true;
  }
  // As setBankRaw, but also toggles the editor's matching attach flag —
  // mirroring Ctrl+A/Ctrl+D in the editor. Used by the keyboard-driven commit
  // path (pressBank/commitProspective); edit-mode clicks use setBankRaw
  // directly, since flipping that flag on every click would be nonsensical.
  function setBank(letter: BankLetter, sel: string[]): boolean {
    const ok = setBankRaw(letter, sel);
    if (ok) {
      if (letter === "A") { editorUseA = !editorUseA; updateEditorFlags(); }
      else if (letter === "D") { editorUseD = !editorUseD; updateEditorFlags(); }
    }
    return ok;
  }
  // The full behaviour of pressing a bank key with the DAG in focus: arms
  // prospective mode when nothing's selected, or banks immediately otherwise.
  // While any bank is prospective, no bank key does anything further — Enter
  // commits it (see the keydown handler) and Esc cancels it, regardless of
  // which bank is armed.
  const bankDisabled = (letter: BankLetter): boolean =>
    letter === "A" ? bankADisabled : letter === "D" ? bankDDisabled : bankSDisabled;
  function pressBank(letter: BankLetter): void {
    if (selMode === "edit") return;   // edit mode banks via direct clicks, never prospective
    if (prospective !== null) return;
    if (bankDisabled(letter)) return; // no Prospective Mode for a disabled bank
    if (!selectedIds.length) { prospective = letter; updateBar(); updateCursors(); return; }
    setBank(letter, selectedIds);
  }
  // XOR `sel`'s membership into `letter`'s bank, individually gated by the
  // usual cross-bank/cycle checks (only the nodes that pass are toggled in).
  // Returns whether anything actually changed.
  function toggleBankMembershipRaw(letter: BankLetter, sel: string[]): boolean {
    const cur = bankOf(letter);
    const next = cur ? new Set(cur) : new Set<string>();
    let changed = false;
    sel.forEach(id => {
      if (next.has(id)) { next.delete(id); changed = true; return; }
      const conflicts = (["A", "D", "S"] as BankLetter[]).some(l => l !== letter && bankOf(l)?.has(id));
      if (conflicts || wouldCreateCycle(letter, [id])) return;
      next.add(id); changed = true;
    });
    if (!changed) return false;
    const result = next.size ? next : null;
    if (letter === "A") bankA = result;
    else if (letter === "D") bankD = result;
    else bankS = result;
    paintBankBadges(); updateBar();
    return true;
  }
  // Shift+letter: as toggleBankMembershipRaw, but also toggles the editor's
  // matching attach flag — the keyboard-driven commit path only.
  function toggleBankMembership(letter: BankLetter, sel: string[]): void {
    if (selMode === "edit" || prospective !== null || !sel.length) return;
    if (bankDisabled(letter)) return;
    if (toggleBankMembershipRaw(letter, sel)) {
      if (letter === "A") { editorUseA = !editorUseA; updateEditorFlags(); }
      else if (letter === "D") { editorUseD = !editorUseD; updateEditorFlags(); }
    }
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
  // Edit mode has no single coherent "selection" to move along ranks with —
  // up to three independent bank selections instead — so neither ever
  // applies there, except when a whole rank is explicitly selected.
  const lrActive = (): boolean => {
    if (mode === "rank") return true;
    if (selMode === "edit") return false;
    if (mode === "nodes") return singularRank() !== null;
    return false;
  };
  const udActive = (): boolean => {
    if (mode === "rank") return true;
    if (selMode === "edit") return false;
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
    if (mode === "rank") { resetFocus(); renderRank(rankSel); updateBar(); syncEditor(); return; }
    if (selMode === "edit") { applyEditFocus(); updateBar(); syncEditor(); return; }
    if (mode === "idle") { resetFocus(); updateBar(); syncEditor(); return; }
    applyFocus(selectedIds, 1, true);            // "nodes" or "subselect"
    if (selectedIds.length >= 2) {
      renderEnum();
      if (mode === "subselect") renderSubselect();
    }
    updateBar();
    syncEditor();
  }

  // ---- Status bar (union/intersection, selection type, nav hints, focus) ----
  const bar = document.createElement("div");
  bar.className = "dag-statusbar";
  const modeBtn = document.createElement("button");
  modeBtn.className = "dag-modebtn"; modeBtn.type = "button";
  modeBtn.title = "Selection mode — Union / Intersection / Edit (click, or press M to cycle)";
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
  aBtn.title = "Bank A — A banks/arms, Shift+A toggles membership, Alt+A clears, Ctrl+A/Ctrl+Shift+A wire it onto S as parents, right-click disables (Ctrl+A in the editor then binds the selection directly, without banking it), hold C then A to centre on it";
  const sBtn = document.createElement("button");
  sBtn.className = "dag-bankbtn s"; sBtn.type = "button"; sBtn.textContent = "S";
  sBtn.title = "Bank S — S banks/arms, Shift+S toggles membership, Alt+S clears, right-click disables (S's wiring actions then use the selection directly), Ctrl+Left/Ctrl+Right moves its contents into bank D/A, hold C then S to centre on it";
  const dBtn = document.createElement("button");
  dBtn.className = "dag-bankbtn d"; dBtn.type = "button"; dBtn.textContent = "D";
  dBtn.title = "Bank D — D banks/arms, Shift+D toggles membership, Alt+D clears, Ctrl+D/Ctrl+Shift+D wire it onto S as children, right-click disables (Ctrl+D in the editor then binds the selection directly, without banking it), hold C then D to centre on it";
  const editorInd = document.createElement("button");
  editorInd.className = "dag-editorind open"; editorInd.type = "button"; editorInd.textContent = "I";
  editorInd.title = "Node editor (below) — W or click starts a new node; select one node to edit it";
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
  groupBanks.style.display = getSettings().banksHiddenByDefault.value ? "none" : "";
  const groupEditing = document.createElement("div");
  groupEditing.className = "dag-bargroup";
  groupEditing.append(editorInd, delBtn);

  // Settings framework: icons for [1]/[2] only (the rest aren't the sort of
  // thing a live icon toggle would make sense for — see settings.ts). A
  // settings modal to bring other settings into the bar, or take these back
  // out, comes later; showOnBar just decides whether the icon exists at all.
  const setting1Btn = document.createElement("button");
  setting1Btn.className = "dag-settingbtn"; setting1Btn.type = "button"; setting1Btn.textContent = "1";
  const setting2Btn = document.createElement("button");
  setting2Btn.className = "dag-settingbtn"; setting2Btn.type = "button"; setting2Btn.textContent = "2";
  const groupSettings = document.createElement("div");
  groupSettings.className = "dag-bargroup";
  groupSettings.append(setting1Btn, setting2Btn);

  bar.append(groupState, groupMode, groupBanks, groupEditing, groupSettings);
  panelFooter.appendChild(bar);
  modeBtn.addEventListener("click", () => cycleSelMode());
  aBtn.addEventListener("click", () => clearBankA());
  sBtn.addEventListener("click", () => clearBankS());
  dBtn.addEventListener("click", () => clearBankD());
  aBtn.addEventListener("contextmenu", ev => { ev.preventDefault(); toggleDisableA(); });
  sBtn.addEventListener("contextmenu", ev => { ev.preventDefault(); toggleDisableS(); });
  dBtn.addEventListener("contextmenu", ev => { ev.preventDefault(); toggleDisableD(); });
  editorInd.addEventListener("click", () => startNewNode());
  delBtn.addEventListener("click", () => deleteNodes(selectedIds));

  // [1] selectAndCenterOnCreate: plain boolean toggle.
  function updateSetting1Btn(): void {
    const s = getSettings().selectAndCenterOnCreate;
    setting1Btn.style.display = s.showOnBar ? "" : "none";
    setting1Btn.classList.toggle("on", s.value);
    setting1Btn.title = `Setting — select & centre on a new node when it's created: currently ${s.value ? "on" : "off"} (click to toggle)`;
  }
  setting1Btn.addEventListener("click", () => {
    setSettingValue("selectAndCenterOnCreate", !getSettings().selectAndCenterOnCreate.value);
    updateSetting1Btn();
  });
  // [2] followSelection: 3-state cycle, keep-in-view -> center -> none.
  function updateSetting2Btn(): void {
    const s = getSettings().followSelection;
    setting2Btn.style.display = s.showOnBar ? "" : "none";
    setting2Btn.classList.toggle("follow-center", s.value === "center");
    setting2Btn.classList.toggle("follow-none", s.value === "none");
    setting2Btn.title = `Setting — Left/Right follow mode: currently "${s.value}" (click to cycle keep-in-view / center / none)`;
  }
  setting2Btn.addEventListener("click", () => {
    const cur = getSettings().followSelection.value;
    const next: FollowMode = cur === "keep-in-view" ? "center" : cur === "center" ? "none" : "keep-in-view";
    setSettingValue("followSelection", next);
    updateSetting2Btn();
  });
  updateSetting1Btn();
  updateSetting2Btn();

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
    selectedIds.length > 0 && (otherBanksConflict(letter, selectedIds) || wouldCreateCycle(letter, selectedIds));
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
    modeBtn.textContent = selMode === "intersection" ? "I" : selMode === "edit" ? "E" : "U";
    modeBtn.classList.toggle("on", selMode === "intersection");
    modeBtn.classList.toggle("edit", selMode === "edit");
    let t = "∅";
    if (mode === "rank") t = "R";
    else if (selMode !== "edit" && (mode === "nodes" || mode === "subselect"))
      t = selectedIds.length === 1 ? "S" : (singularRank() !== null ? "C" : "M");
    selInd.textContent = t;
    lrInd.classList.toggle("off", !lrActive());
    udInd.classList.toggle("off", !udActive());
    delBtn.disabled = !selectedIds.length;

    const editMode = selMode === "edit";
    const paintBank = (btn: HTMLButtonElement, letter: BankLetter, filled: boolean): void => {
      btn.classList.toggle("off", !filled);
      btn.classList.toggle("would-accept", !editMode && !filled && selectedIds.length > 0 && !wouldReject(letter));
      btn.classList.toggle("conflict", !editMode && wouldReject(letter));
      btn.classList.toggle("prospective", !editMode && prospective === letter);
      btn.classList.toggle("locked", !editMode && prospective !== null && prospective !== letter);
    };
    paintBank(aBtn, "A", !!bankA);
    paintBank(dBtn, "D", !!bankD);
    paintBank(sBtn, "S", !!bankS);
    aBtn.classList.toggle("disabled", bankADisabled);
    sBtn.classList.toggle("disabled", bankSDisabled);
    dBtn.classList.toggle("disabled", bankDDisabled);

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
  // [2] followSelection: "keep-in-view" (default) only nudges the scroll
  // enough to bring the column on screen; "center" always centres it
  // instead; "none" never auto-scrolls for it at all.
  const reveal = (): void => {
    const mode = getSettings().followSelection.value;
    if (mode === "none") return;
    if (mode === "center") { centerOnSelection(); return; }
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
    getNodes().forEach(n => { if (!target.has(n.id)) newExcluded.add(n.id); });
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
  // frontier (dotted) nodes just beyond them. Selected nodes that are leaves
  // (no children, so they have no frontier of their own to hand off to) stay
  // selected instead of being dropped.
  const advance = (): void => {
    const { dotted } = computeGreenAndDotted(selectedIds, false);
    const next = new Set<string>(dotted);
    selectedIds.forEach(id => {
      if (!children.get(id)!.some(c => included(c))) next.add(id);
    });
    if (!next.size) return;
    selectedIds = [...next]; mode = "nodes"; subBuffer = "";
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

  // ---- Node editor (always open, below the DAG view) ------------------------
  // Three states: "disabled" (nothing to do — the resting default), "new" (a
  // fresh node draft, entered only by explicitly pressing W — see
  // startNewNode — and then locked in regardless of what gets selected
  // afterwards), and "existing" (mirrors the single selected node, whenever
  // one exists and "new" isn't locked in). See syncEditor() for the switch.
  type EditorMode = "disabled" | "new" | "existing";
  let editorUseA = false;
  let editorUseD = false;
  let editingNew = false;               // locked into "new" (via startNewNode) until committed/cleared
  let editorOrigTitle = "";             // existing-mode baseline, for the Save dirty-check
  let editorOrigBody = "";
  let lastEditorMode: EditorMode | undefined;
  let lastEditorTarget: string | null | undefined;
  let nextNodeSeq = 1;

  const editorBox = document.createElement("div");
  editorBox.className = "dag-nodebox";
  const editorModeIcon = document.createElement("div");
  editorModeIcon.className = "dag-nodebox-modeicon";
  const editorInner = document.createElement("div");
  editorInner.className = "dag-nodebox-inner";
  const flagA = document.createElement("div"); flagA.className = "dag-nodebox-flag a";
  const flagD = document.createElement("div"); flagD.className = "dag-nodebox-flag d";
  const editorTitle = document.createElement("input");
  editorTitle.type = "text"; editorTitle.className = "dag-nodebox-title"; editorTitle.placeholder = "Title";
  const editorBody = document.createElement("textarea");
  editorBody.className = "dag-nodebox-body"; editorBody.placeholder = "Body (optional)";
  const editorHint = document.createElement("div");
  editorHint.className = "dag-nodebox-hint";
  const editorButtons = document.createElement("div");
  editorButtons.className = "dag-nodebox-buttons";
  const editorAddBtn = document.createElement("button");
  editorAddBtn.type = "button"; editorAddBtn.className = "dag-nodebox-btn primary";
  editorAddBtn.textContent = "Add";
  const editorCancelBtn = document.createElement("button");
  editorCancelBtn.type = "button"; editorCancelBtn.className = "dag-nodebox-btn";
  editorCancelBtn.textContent = "Clear";
  editorButtons.appendChild(editorAddBtn); editorButtons.appendChild(editorCancelBtn);
  editorInner.appendChild(flagA); editorInner.appendChild(flagD);
  editorInner.appendChild(editorTitle); editorInner.appendChild(editorBody);
  editorInner.appendChild(editorHint); editorInner.appendChild(editorButtons);
  // Shown instead of editorInner when nothing is selected and no draft is in
  // progress — a placeholder "card" reserved for future content.
  const editorEmptyCard = document.createElement("div");
  editorEmptyCard.className = "dag-nodebox-empty";
  editorBox.appendChild(editorModeIcon); editorBox.appendChild(editorInner); editorBox.appendChild(editorEmptyCard);
  panelFooter.appendChild(editorBox);
  editorAddBtn.addEventListener("click", () => { if (lastEditorMode === "existing") commitExisting(); else commitNew(); });
  editorCancelBtn.addEventListener("click", () => { if (lastEditorMode === "existing") deleteEditorTarget(); else clearEditorDraft(); });

  function updateEditorFlags(): void {
    flagA.classList.toggle("on", attachA());
    flagD.classList.toggle("on", attachD());
  }
  // Paint the chrome (background/icon/hint/buttons/disabled-ness) for
  // whichever mode is currently showing — cheap, so it's fine to call on
  // every syncEditor pass and every keystroke.
  function paintEditorChrome(mode: EditorMode): void {
    editorBox.classList.toggle("mode-new", mode === "new");
    editorBox.classList.toggle("mode-existing", mode === "existing");
    editorBox.classList.toggle("mode-disabled", mode === "disabled");
    editorInner.style.display = mode === "disabled" ? "none" : "block";
    editorEmptyCard.style.display = mode === "disabled" ? "block" : "none";
    editorTitle.disabled = mode === "disabled";
    editorBody.disabled = mode === "disabled";
    flagA.style.display = mode === "new" ? "" : "none";
    flagD.style.display = mode === "new" ? "" : "none";
    if (mode === "existing") {
      editorModeIcon.textContent = "E";
      editorAddBtn.textContent = "Save";
      editorCancelBtn.textContent = "Delete";
      const dirty = editorTitle.value !== editorOrigTitle || editorBody.value !== editorOrigBody;
      editorAddBtn.disabled = !dirty || !editorTitle.value.trim();
      editorCancelBtn.disabled = false;
      editorHint.textContent = "Editing the selected node · Esc deselects";
    } else {
      editorModeIcon.textContent = "N";
      editorAddBtn.textContent = "Add";
      editorCancelBtn.textContent = "Clear";
      editorAddBtn.disabled = mode === "disabled" || !editorTitle.value.trim();
      editorCancelBtn.disabled = mode === "disabled";
      editorHint.textContent = mode === "disabled"
        ? "W starts a new node · select a single node to edit it"
        : "Tab to switch fields · Ctrl+A/Ctrl+D toggle banks as ancestors/descendants · Ctrl+Enter adds · Esc clears";
    }
  }
  // Recomputes which node (if any) the editor should be showing, and
  // repopulates its fields only when that target actually changes — so an
  // unrelated refresh() (e.g. toggling U/I) never clobbers an in-progress
  // draft or a live edit mid-keystroke.
  function syncEditor(): void {
    const mode: EditorMode = editingNew ? "new" : (selectedIds.length === 1 ? "existing" : "disabled");
    const target = mode === "existing" ? selectedIds[0] : null;
    if (mode !== lastEditorMode || target !== lastEditorTarget) {
      lastEditorMode = mode; lastEditorTarget = target;
      if (mode === "existing") {
        const def = nodes.get(target!)!.def;
        editorOrigTitle = def.title; editorOrigBody = def.body || "";
        editorTitle.value = editorOrigTitle; editorBody.value = editorOrigBody;
      } else {
        editorTitle.value = ""; editorBody.value = "";
        if (mode === "disabled") { editorUseA = false; editorUseD = false; updateEditorFlags(); }
      }
    }
    paintEditorChrome(mode);
  }
  // W (or the "I" status-bar icon): explicitly start a fresh new-node draft,
  // locking the editor into "new" no matter what gets selected afterwards.
  function startNewNode(): void {
    if (!editingNew) {
      editingNew = true;
      editorUseA = !!bankA; editorUseD = !!bankD;   // default on if there's something to attach
      updateEditorFlags();
      lastEditorMode = undefined; lastEditorTarget = undefined;   // force a resync
      syncEditor();
    }
    editorTitle.focus();
  }
  function clearEditorDraft(): void {
    editorTitle.value = ""; editorBody.value = "";
    editingNew = false;
    editorUseA = false; editorUseD = false; updateEditorFlags();
    lastEditorMode = undefined; lastEditorTarget = undefined;   // force a resync even if mode/target don't change
    syncEditor();
  }
  // Apply title/body edits onto the node actually being edited.
  function updateNodeContent(id: string, title: string, body: string): void {
    const ln = nodes.get(id); if (!ln) return;
    updateNode(id, title, body || undefined);
    (ln.el.querySelector(".dag-node-title") as HTMLDivElement).textContent = title;
    let bodyEl = ln.el.querySelector(".dag-node-body") as HTMLDivElement | null;
    if (body) {
      if (!bodyEl) {
        bodyEl = document.createElement("div");
        bodyEl.className = "dag-node-body";
        ln.el.insertBefore(bodyEl, nodeTally.get(id)!);
      }
      bodyEl.textContent = body;
    } else if (bodyEl) {
      bodyEl.remove();
    }
    ln.height = ln.el.offsetHeight;
    relayout();
  }
  const onEditorInput = (): void => paintEditorChrome(lastEditorMode ?? "disabled");
  editorTitle.addEventListener("input", onEditorInput);
  editorBody.addEventListener("input", onEditorInput);
  function commitNew(): void {
    const title = editorTitle.value.trim();
    if (!title) { editorTitle.focus(); return; }   // a node needs a label
    const body = editorBody.value.trim(), useA = attachA(), useD = attachD();
    addNode(title, body, useA, useD);
    editingNew = false;
    editorUseA = false; editorUseD = false; updateEditorFlags();
    lastEditorMode = undefined; lastEditorTarget = undefined;   // force a resync
    syncEditor();
  }
  function commitExisting(): void {
    if (lastEditorMode !== "existing" || !lastEditorTarget) return;
    const title = editorTitle.value.trim();
    if (!title) { editorTitle.focus(); return; }
    const body = editorBody.value.trim();
    updateNodeContent(lastEditorTarget, title, body);
    editorOrigTitle = title; editorOrigBody = body;
    editorTitle.value = title; editorBody.value = body;
    paintEditorChrome("existing");
  }
  function deleteEditorTarget(): void {
    if (lastEditorMode !== "existing" || !lastEditorTarget) return;
    deleteNodes([lastEditorTarget]);
  }

  // The pane's own keybinds — Ctrl+A/Ctrl+D/Ctrl+Enter/Esc, and Space's
  // "focus the first input" when nothing in the pane has focus yet. Shared
  // between two call sites: editorBox's own listener (below, for when a
  // field actually has focus) and the global keydown handler (used when the
  // pane is merely the *active partition*, reached via Shift+Tab, with
  // nothing inside it focused — see "Keyboard focus partitions").
  // Ctrl+A/Ctrl+D in the editor, while that bank is disabled: overwrite
  // boundA/boundD outright with whatever's currently selected — never a
  // toggle, and an empty selection means "nothing" (clears it) rather than
  // arming Prospective Mode. Still subject to the same cross-bank/cycle
  // checks a real bank commit would use; a rejected overwrite just leaves
  // the previous binding as it was.
  function overwriteBound(letter: "A" | "D"): void {
    if (!selectedIds.length) {
      if (letter === "A") boundA = null; else boundD = null;
    } else if (!otherBanksConflict(letter, selectedIds) && !wouldCreateCycle(letter, selectedIds)) {
      if (letter === "A") boundA = new Set(selectedIds); else boundD = new Set(selectedIds);
    }
    updateEditorFlags();
  }
  function handlePaneKeydown(e: KeyboardEvent): void {
    const k = e.key;
    if (e.ctrlKey && (k === "a" || k === "A")) {
      e.preventDefault();
      if (bankADisabled) overwriteBound("A");
      else if (bankA) { editorUseA = !editorUseA; updateEditorFlags(); }
      // Empty, enabled bank: there's nothing to attach and nothing to toggle,
      // so Ctrl+A does nothing here — it must not quietly bank the selection.
    } else if (e.ctrlKey && (k === "d" || k === "D")) {
      e.preventDefault();
      if (bankDDisabled) overwriteBound("D");
      else if (bankD) { editorUseD = !editorUseD; updateEditorFlags(); }
      // Empty, enabled bank: Ctrl+D does nothing (see Ctrl+A above).
    } else if (e.ctrlKey && k === "Enter") {
      e.preventDefault();
      if (lastEditorMode === "existing") commitExisting(); else commitNew();
    } else if (k === "Escape") {
      e.preventDefault();
      if (lastEditorMode === "existing") { selectedIds = []; mode = "idle"; refresh(); }
      else clearEditorDraft();
    } else if (k === " " && !partitionTabbables("pane").includes(document.activeElement as HTMLElement)) {
      e.preventDefault();
      editorTitle.focus();
    }
  }
  // Isolated from the rest of the app's shortcuts: stopPropagation keeps every
  // keydown that reaches here (i.e. while a field in the box has focus) from
  // ever being seen by the global handler below. Plain Tab is deliberately
  // left alone here — it's handled globally, wrapping within the pane's own
  // tabbables (inputs, then buttons) instead of the old hardcoded two-field
  // cycle.
  editorBox.addEventListener("keydown", ev => {
    ev.stopPropagation();
    handlePaneKeydown(ev);
  });

  // After the graph's nodes/edges change: recolour/redraw edges, recompute
  // ancestor/descendant relations, grow the rank pools if the graph now needs
  // more of them (it can only ever need more, never fewer), and relay out.
  function syncGraphStructure(): void {
    rebuildEdgeRecs();
    rebuildRelations();
    const fullGraph: GraphDef = { nodes: getNodes().slice(), edges: getEdges().slice() };
    const newFullRankMap = computeRanks(fullGraph);
    const newMaxRank0 = Math.max(...fullGraph.nodes.map(n => newFullRankMap.get(n.id)!));
    if (newMaxRank0 > maxRank0) growRankPools(newMaxRank0);
    relayout();
  }

  // Add a new node to the (single, never-duplicated) graph, wire it to
  // whatever's currently in banks A/D per the two flags, and bring the
  // persistent DOM up to date. By default never touches selection or scroll
  // position — adding a node can only ever need as many or more ranks,
  // never fewer — but [1] selectAndCenterOnCreate opts into selecting and
  // centring on it instead.
  function addNode(title: string, body: string, useA: boolean, useD: boolean): void {
    const id = "N" + nextNodeSeq++;
    const def: NodeDef = { id, title, body: body || undefined };
    graphAddNode(def);
    // Disabled A/D attach from boundA/boundD instead of the (always-empty,
    // while disabled) bank itself.
    if (useA) (bankADisabled ? boundA : bankA)?.forEach(a => addEdge(a, id));
    if (useD) (bankDDisabled ? boundD : bankD)?.forEach(d => addEdge(id, d));
    boundA = null; boundD = null;

    addNodeCard(def);
    syncGraphStructure();
    paintBankBadges();
    const selectOnCreate = getSettings().selectAndCenterOnCreate.value;
    if (selectOnCreate) { selectedIds = [id]; mode = "nodes"; subBuffer = ""; }
    refresh();
    if (selectOnCreate) centerOnSelection();
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
          if (!union) { deleteEdge(from, to); changed = true; }
        } else if (!ancOf.get(from)!.has(to)) {                 // would `to` already be an ancestor of `from`?
          addEdge(from, to); changed = true;
        }
      });
    });
    if (changed) { syncGraphStructure(); refresh(); }   // ancestor/descendant sets shift -> selection colours can too
  }

  // Edit mode only: A/D wire onto S the instant both sides have members —
  // no manual Ctrl+A/Ctrl+D commit needed. Only ever adds (skipping anything
  // that already exists or would close a cycle), so it's safe to call after
  // every bank-selection change, whichever bank changed.
  function applyEditWiring(): void {
    if (selMode !== "edit") return;
    let changed = false;
    if (bankA && bankS) {
      bankA.forEach(a => bankS!.forEach(s => {
        if (!hasEdge(a, s) && !ancOf.get(a)!.has(s)) { addEdge(a, s); changed = true; }
      }));
    }
    if (bankD && bankS) {
      bankS.forEach(s => bankD!.forEach(d => {
        if (!hasEdge(s, d) && !ancOf.get(s)!.has(d)) { addEdge(s, d); changed = true; }
      }));
    }
    if (changed) syncGraphStructure();
  }
  // Edit mode's per-click handler: a plain click replaces `letter`'s bank
  // with just this node (or clears it, if it was already the sole member) —
  // Shift toggles membership instead, same as toggleBankMembership. Either
  // way, immediately re-applies any newly-possible A->S / S->D wiring.
  function editBankClick(letter: BankLetter, id: string, shift: boolean): void {
    if (bankDisabled(letter)) return;   // A/S/D are always force-enabled during edit mode; defensive
    if (shift) {
      toggleBankMembershipRaw(letter, [id]);
    } else {
      const cur = bankOf(letter);
      if (cur && cur.size === 1 && cur.has(id)) {
        // Sole member clicked again -> clear, same as Alt+<letter>.
        if (letter === "A") clearBankA(); else if (letter === "D") clearBankD(); else clearBankS();
      } else {
        setBankRaw(letter, [id]);
      }
    }
    applyEditWiring();
    refresh();
  }

  // ---- Delete: remove nodes from the graph, their banks, and the DOM -------
  function deleteNodes(ids: string[]): void {
    const idSet = new Set(ids.filter(id => nodes.has(id)));
    if (!idSet.size) return;
    graphDeleteNodes(idSet);
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
      // Edit mode: left-click is green/A, entirely independent of the
      // normal ancestor/descendant selection flow below.
      if (selMode === "edit") { editBankClick("A", id, ev.shiftKey); return; }
      // Prospective mode overrides Shift: every click just toggles membership.
      const toggling = prospective !== null || (ev.shiftKey && mode === "nodes" && selectedIds.length);
      if (toggling) {
        if (selectedIds.includes(id)) {
          selectedIds = selectedIds.filter(x => x !== id);           // already selected -> deselect
        } else if (!blockedSet.has(id) && !prospectiveBlocked(id)) {
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
      if (boxBtn !== -1) return;                                     // mid box-sweep: no hover preview
      if (selMode === "edit") return;                                // no hover preview in edit mode
      if (mode !== "idle") { updateCursors(); return; }              // a committed view is frozen
      applyFocus([id], HOVER, false);
    });
    ln.el.addEventListener("mouseleave", () => {
      if (selMode === "edit" || mode !== "idle") return;
      resetFocus();
    });
    // Edit mode: middle-click is yellow/S. Middle-click never fires "click",
    // so it's caught on mousedown instead (also preventing its usual
    // autoscroll gesture).
    ln.el.addEventListener("mousedown", ev => {
      if (selMode === "edit" && ev.button === 1 && !ev.shiftKey) {   // Shift+middle -> box sweep instead
        ev.preventDefault();
        editBankClick("S", id, ev.shiftKey);
      }
    });
    // Right-click: in edit mode, red/D (its usual meaning is replaced, as
    // noted in the mode's own docs) — and there Shift behaves exactly like
    // Shift+left/middle-click, toggling membership rather than deleting.
    // Outside edit mode: clear this node's bank membership, or, with Shift,
    // delete it outright regardless of the current selection.
    ln.el.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      if (selMode === "edit") { editBankClick("D", id, ev.shiftKey); return; }
      if (ev.shiftKey) { deleteNodes([id]); return; }
      if (removeFromBanks(id)) { paintBankBadges(); updateBar(); }
    });
  }

  // ---- Shift-drag box selection -------------------------------------------
  // Hold Shift and drag (any button) to sweep a rectangle over the DAG. On
  // release, with at least one node enclosed:
  //   Union / Intersection — Left adds the enclosed nodes to the selection
  //                          (exactly as Shift+click does); Right deletes them.
  //   Edit                 — Left / Middle / Right add them to bank A / S / D.
  // A Shift press that never passes the drag threshold falls through to the
  // normal per-node click.
  const boxEl = document.createElement("div");
  boxEl.className = "dag-boxsel";
  boxEl.style.display = "none";
  container.appendChild(boxEl);

  let boxBtn = -1;                 // -1 = idle, else the mouse button held
  let boxX0 = 0, boxY0 = 0;
  let boxActive = false;           // past the threshold — a real sweep, not a click
  let boxDragJustFinished = false; // swallow the trailing click / contextmenu
  const BOX_THRESH = 4;

  const boxLocalPt = (ev: MouseEvent): [number, number] => {
    const r = container.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];   // container-local == node x/y frame
  };
  const paintBox = (x1: number, y1: number): void => {
    boxEl.style.left = Math.min(boxX0, x1) + "px";
    boxEl.style.top = Math.min(boxY0, y1) + "px";
    boxEl.style.width = Math.abs(x1 - boxX0) + "px";
    boxEl.style.height = Math.abs(y1 - boxY0) + "px";
  };
  const nodesInBox = (x1: number, y1: number): string[] => {
    const lx = Math.min(boxX0, x1), hx = Math.max(boxX0, x1);
    const ly = Math.min(boxY0, y1), hy = Math.max(boxY0, y1);
    const hits: string[] = [];
    nodes.forEach((ln, id) => {
      if (!included(id) || ln.el.style.display === "none") return;
      if (ln.x < hx && ln.x + ln.width > lx && ln.y < hy && ln.y + ln.height > ly) hits.push(id);
    });
    return hits;
  };

  function boxAddToSelection(hits: string[]): void {
    let changed = false;
    hits.forEach(id => {
      if (selectedIds.includes(id) || blockedSet.has(id) || prospectiveBlocked(id)) return;
      selectedIds = [...selectedIds, id]; changed = true;
    });
    if (!changed) return;
    mode = "nodes"; subBuffer = "";
    refresh(); reveal();
  }
  // Edit-mode sweep: add every hit to `letter`'s bank without ever toggling an
  // existing member out, under the same cross-bank / cycle guards a single
  // click uses, then re-run any now-possible A->S / S->D wiring.
  function boxAddToBank(letter: BankLetter, hits: string[]): void {
    if (bankDisabled(letter)) return;
    const cur = bankOf(letter);
    const next = cur ? new Set(cur) : new Set<string>();
    let changed = false;
    hits.forEach(id => {
      if (next.has(id)) return;
      const clash = (["A", "D", "S"] as BankLetter[]).some(l => l !== letter && bankOf(l)?.has(id));
      if (clash || wouldCreateCycle(letter, [id])) return;
      next.add(id); changed = true;
    });
    if (!changed) return;
    if (letter === "A") bankA = next;
    else if (letter === "D") bankD = next;
    else bankS = next;
    paintBankBadges();
    applyEditWiring();
    refresh();
  }
  function finishBox(ev: MouseEvent): void {
    const [x1, y1] = boxLocalPt(ev);
    const hits = nodesInBox(x1, y1);
    if (hits.length) {
      if (selMode === "edit") {
        boxAddToBank(boxBtn === 0 ? "A" : boxBtn === 1 ? "S" : "D", hits);
      } else if (boxBtn === 2) {
        deleteNodes(hits);
      } else if (boxBtn === 0) {
        boxAddToSelection(hits);
      }
    }
    setActivePartition("dag", false);
  }

  container.addEventListener("mousedown", ev => {
    if (!ev.shiftKey || boxBtn !== -1) return;
    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return;
    ev.preventDefault();                    // no text selection / middle-click autoscroll
    boxBtn = ev.button;
    boxActive = false;
    [boxX0, boxY0] = boxLocalPt(ev);
  });
  window.addEventListener("mousemove", ev => {
    if (boxBtn === -1) return;
    const [x, y] = boxLocalPt(ev);
    if (!boxActive) {
      if (Math.abs(x - boxX0) < BOX_THRESH && Math.abs(y - boxY0) < BOX_THRESH) return;
      boxActive = true;
      boxEl.style.display = "block";
    }
    paintBox(x, y);
  });
  window.addEventListener("mouseup", ev => {
    if (boxBtn === -1) return;
    const wasActive = boxActive;
    boxEl.style.display = "none";
    if (wasActive) {
      boxDragJustFinished = true;
      setTimeout(() => { boxDragJustFinished = false; }, 0);
      finishBox(ev);
    }
    boxBtn = -1; boxActive = false;
  });
  // Swallow the click / contextmenu the browser fires right after a sweep so
  // it doesn't also land as a node toggle, an empty-space deselect, or a
  // native context menu.
  document.addEventListener("click", ev => {
    if (boxDragJustFinished) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
  document.addEventListener("contextmenu", ev => {
    if (boxDragJustFinished || boxActive) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);

  // ---- Keyboard focus partitions ---------------------------------------------
  // Three coarse regions share the keyboard: the DAG view, the icon bar, and
  // the node editor pane. Exactly one is "active" at a time and receives
  // keybinds — Shift+Tab cycles between them, and is the only way to land on
  // the icon bar; a click there deliberately leaves the active partition
  // alone, since its buttons are meant as quick actions from wherever the
  // user currently is, not a place to "switch into".
  type Partition = "dag" | "icons" | "pane";
  const PARTITION_ORDER: Partition[] = ["dag", "icons", "pane"];
  let activePartition: Partition = "dag";
  let partitionKeynav = false;   // reached via Shift+Tab -> a deeper blue border

  const partitionEl = (p: Partition): HTMLElement =>
    p === "dag" ? scrollEl() : p === "icons" ? bar : editorBox;

  function paintPartitions(): void {
    PARTITION_ORDER.forEach(p => {
      const el = partitionEl(p);
      const active = activePartition === p;
      el.classList.toggle("dag-partition-active", active);
      el.classList.toggle("dag-partition-keynav", active && partitionKeynav);
    });
  }
  function setActivePartition(p: Partition, keynav: boolean): void {
    activePartition = p; partitionKeynav = keynav;
    paintPartitions();
  }
  // A click anywhere sets the active partition to whichever one it landed in
  // — except the icon bar. Capturing phase, so this still runs even though
  // node clicks (and others) call stopPropagation on the way up.
  document.addEventListener("click", ev => {
    const target = ev.target as Node;
    if (editorBox.contains(target)) setActivePartition("pane", false);
    else if (bar.contains(target)) { /* icon bar: leave the active partition as it is */ }
    else if (scrollEl().contains(target)) setActivePartition("dag", false);
  }, true);

  // The tabbable elements of a partition, in document order — used both to
  // wrap plain Tab within the active partition, and to know what Space
  // should focus first when "entering" it. The DAG view has none of its own
  // (its "entering" gesture selects rank 0 instead — see the keydown handler).
  function partitionTabbables(p: Partition): HTMLElement[] {
    if (p === "icons") return [modeBtn, aBtn, sBtn, dBtn, editorInd, delBtn].filter(el => !el.disabled);
    if (p === "pane") return [editorTitle, editorBody, editorAddBtn, editorCancelBtn].filter(el => !el.disabled);
    return [];
  }
  // Shift+Tab always cycles partitions, everywhere, regardless of what has
  // focus — so it's caught in the capturing phase, ahead of anything (e.g.
  // the pane's own keydown handler) that might otherwise stopPropagation it
  // away. It defocuses whatever's focused (only ever meaningful for a pane
  // input) without touching the DAG view's own selection state.
  document.addEventListener("keydown", e => {
    if (e.key !== "Tab" || !e.shiftKey) return;
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    const i = PARTITION_ORDER.indexOf(activePartition);
    setActivePartition(PARTITION_ORDER[(i + 1) % PARTITION_ORDER.length], true);
  }, true);
  // Plain Tab, once something in the active partition already has focus,
  // wraps within that partition's own tabbables instead of spilling into
  // whatever's next in the whole document.
  document.addEventListener("keydown", e => {
    if (e.key !== "Tab" || e.shiftKey) return;
    const list = partitionTabbables(activePartition);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;   // nothing of this partition's focused yet -> let native Tab happen
    e.preventDefault();
    list[(i + 1) % list.length].focus();
  }, true);

  // ---- Keyboard ------------------------------------------------------------
  // Holding C then pressing A/S/D centres on that bank immediately; releasing
  // C without ever having done so centres on the selection instead. Tracked
  // here, independently of the bank keys' own handling below.
  let heldC = false;
  let cComboFired = false;   // a bank centred while this C hold is still down
  document.addEventListener("keydown", e => {
    const k = e.key.toLowerCase();
    if (k === "shift") { if (!shiftHeld) { shiftHeld = true; updateCursors(); } return; }
    if (activePartition !== "dag") return;   // hold-C-then-letter centres the DAG view; only makes sense there
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
    if (k === "Tab") return;                               // handled by the dedicated listeners above

    // Icon bar: nothing but "enter" it — Space, when none of its buttons
    // have focus yet. Everything else is native button behaviour (Enter/
    // Space activates whichever one does have focus) once it's been entered.
    if (activePartition === "icons") {
      if (k === " " && !partitionTabbables("icons").includes(document.activeElement as HTMLElement)) {
        e.preventDefault();
        modeBtn.focus();
      }
      return;
    }
    // The pane: route to its own keybinds regardless of whether one of its
    // fields actually has focus. (If one does, this never runs at all —
    // the pane's own listener already handled it and stopped propagation.)
    if (activePartition === "pane") { handlePaneKeydown(e); return; }

    // Everything from here on is the DAG view's own keybinds, live only
    // while it's the active partition.

    // A prospective bank takes over Esc/Enter before anything else does.
    if (prospective !== null && k === "Escape") { e.preventDefault(); prospective = null; updateBar(); updateCursors(); return; }
    if (prospective !== null && k === "Enter")  { e.preventDefault(); commitProspective(); return; }
    // Pressing the same letter that armed prospective mode also completes it
    // (e.g. arm with A, complete with A again) — same effect as Enter.
    if (prospective !== null && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        k.toLowerCase() === prospective.toLowerCase()) {
      e.preventDefault(); commitProspective(); return;
    }

    // Holding C takes priority over A/S/D's own bindings (see above).
    if (heldC && !e.ctrlKey && !e.altKey && !e.shiftKey &&
        (k === "a" || k === "A" || k === "s" || k === "S" || k === "d" || k === "D")) {
      e.preventDefault();
      return;
    }

    // Global: manual scroll, emphasis mode, and focus.
    if (e.altKey && k === "ArrowLeft")  { e.preventDefault(); setScroll(scrollCols - 1); return; }
    if (e.altKey && k === "ArrowRight") { e.preventDefault(); setScroll(scrollCols + 1); return; }
    if (e.ctrlKey && k === "ArrowLeft")  { e.preventDefault(); moveBankSInto("D"); return; }
    if (e.ctrlKey && k === "ArrowRight") { e.preventDefault(); moveBankSInto("A"); return; }
    if (k === "m" || k === "M") { e.preventDefault(); cycleSelMode(); return; }
    // Push needs an ancestry to narrow into, which edit mode has none of;
    // popping back out (staying in edit mode) is still fine.
    if (k === "f" || k === "F") {
      e.preventDefault();
      if (e.shiftKey) popFocus();
      else if (selMode !== "edit") pushFocus();
      return;
    }
    if (k === "a" || k === "A") {
      e.preventDefault();
      // Ctrl+A wires bank A onto S. With A empty there's nothing to wire, so
      // it does nothing — in particular it must not quietly bank the selection
      // into S via ensureBankS().
      if (e.ctrlKey) { if (bankA) { ensureBankS(); wireBankToS("A", e.shiftKey); } }
      else if (e.altKey) clearBankA();
      else if (e.shiftKey) toggleBankMembership("A", selectedIds);
      else pressBank("A");
      return;
    }
    if (k === "d" || k === "D") {
      e.preventDefault();
      if (e.ctrlKey) { if (bankD) { ensureBankS(); wireBankToS("D", e.shiftKey); } }  // D empty -> nothing (see Ctrl+A)
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
    if ((k === "w" || k === "W") && !e.ctrlKey && !e.altKey) { e.preventDefault(); startNewNode(); return; }

    if (k === "Delete" && selectedIds.length) { e.preventDefault(); deleteNodes(selectedIds); return; }

    if (k === "Home") { e.preventDefault(); selectRankNodes(0); return; }
    if (k === "End")  { e.preventDefault(); selectRankNodes(maxRank); return; }

    // Edit mode's selections live entirely in the banks, with no "mode" of
    // their own (mode stays "idle") — so Esc needs its own case here, rather
    // than falling into the idle/nodes/rank handling below.
    if (k === "Escape" && selMode === "edit" && mode === "idle") {
      e.preventDefault();
      bankA = null; bankD = null; bankS = null;
      editorUseA = false; editorUseD = false; updateEditorFlags();
      paintBankBadges(); refresh();
      return;
    }

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
    // idle: Home/End (handled above) act, and so does Space — the DAG
    // view's own "entering" gesture when it's the active partition and
    // nothing is selected yet, same destination as Home.
    if (mode === "idle" && k === " ") { e.preventDefault(); selectRankNodes(0); return; }
  });

  // Click on empty space returns to the default deselected state.
  container.addEventListener("click", () => {
    if (mode !== "idle") { mode = "idle"; selectedIds = []; subBuffer = ""; refresh(); }
  });

  relayout();
  applyScroll();
  updateBar();
  updateFocusIndicator();
  syncEditor();
  paintPartitions();
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
