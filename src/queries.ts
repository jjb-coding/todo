// ============================================================================
//  DAG queries — ranking and ancestry. Every function here takes a GraphDef
//  explicitly and returns a fresh result; nothing is shared or cached, and
//  nothing ever calls back into a caller. Safe to call as often as needed.
// ============================================================================

import type { GraphDef } from "./state";

// ---- Ranking: longest-path layering over a topological order ---------------
export function computeRanks(g: GraphDef): Map<string, number> {
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

export interface Relations {
  children: Map<string, string[]>;
  parents: Map<string, string[]>;
  ancOf: Map<string, Set<string>>;
  descOf: Map<string, Set<string>>;
}

// Everything reachable from `start` along `adj` (start excluded).
function reach(start: string, adj: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(adj.get(start) || [])];
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const y of adj.get(x) || []) stack.push(y);
  }
  return seen;
}

// Immediate parent/child lists, plus full ancestor/descendant closures, for
// every node in `g`. Computed over the whole graph — callers wanting a
// focused subgraph's relations should filter the *result*, not `g`, since
// ancestry is a property of the true structure, not of what's on screen.
export function computeRelations(g: GraphDef): Relations {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const ancOf = new Map<string, Set<string>>();
  const descOf = new Map<string, Set<string>>();
  g.nodes.forEach(n => { children.set(n.id, []); parents.set(n.id, []); });
  g.edges.forEach(e => { children.get(e.from)!.push(e.to); parents.get(e.to)!.push(e.from); });
  g.nodes.forEach(n => { ancOf.set(n.id, reach(n.id, parents)); descOf.set(n.id, reach(n.id, children)); });
  return { children, parents, ancOf, descOf };
}
