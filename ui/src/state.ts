// ============================================================================
//  Graph state — the single source of truth for the DAG's nodes and edges.
//  Held privately in this module; every mutation goes through a named
//  function here (addNode, addEdge, deleteEdge, deleteNodes, updateNode) so
//  nothing outside ever reaches in and pushes/splices the arrays directly.
//  Readers get `readonly` views — a type-level contract, not a runtime
//  freeze, but enough to keep every real mutation funnelled through one
//  place and easy to audit.
// ============================================================================

export interface NodeDef { id: string; title: string; body?: string; }
export interface EdgeDef { from: string; to: string; }
export interface GraphDef { nodes: NodeDef[]; edges: EdgeDef[]; }

let nodes: NodeDef[] = [];
let edges: EdgeDef[] = [];

// Replaces the whole graph outright — used once, at startup, with the
// initial data. Takes its own copies, so the caller's arrays are never
// aliased into the private store.
export function initGraph(def: GraphDef): void {
  nodes = def.nodes.slice();
  edges = def.edges.slice();
}

export function getNodes(): readonly NodeDef[] { return nodes; }
export function getEdges(): readonly EdgeDef[] { return edges; }
export function getNode(id: string): NodeDef | undefined { return nodes.find(n => n.id === id); }
export function hasEdge(from: string, to: string): boolean {
  return edges.some(e => e.from === from && e.to === to);
}

export function addNode(def: NodeDef): void { nodes.push(def); }

// Edits a node's label in place (same identity, so anything already holding
// a reference from getNode/getNodes sees the change).
export function updateNode(id: string, title: string, body: string | undefined): void {
  const n = getNode(id);
  if (n) { n.title = title; n.body = body; }
}

export function addEdge(from: string, to: string): void { edges.push({ from, to }); }

export function deleteEdge(from: string, to: string): void {
  const i = edges.findIndex(e => e.from === from && e.to === to);
  if (i >= 0) edges.splice(i, 1);
}

// Removes a set of nodes and every edge touching any of them, in one pass.
export function deleteNodes(ids: ReadonlySet<string>): void {
  nodes = nodes.filter(n => !ids.has(n.id));
  edges = edges.filter(e => !ids.has(e.from) && !ids.has(e.to));
}
