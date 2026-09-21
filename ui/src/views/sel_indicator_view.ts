// Selection-kind indicator: what sort of thing is selected right now.
export type SelKind = "none" | "rank" | "single" | "column" | "multi";

export interface SelIndicatorView {
  readonly el: HTMLElement;
  set(kind: SelKind): void;
}

export function createSelIndicatorView(): SelIndicatorView {
  const el = document.createElement("div");
  el.className = "dag-selind";
  el.title = "Selection: ∅ none · R rank · S single node · C nodes in one rank · M nodes across ranks";
  const GLYPH: Record<SelKind, string> = {
    none: "∅", rank: "R", single: "S", column: "C", multi: "M",
  };
  return { el, set: (kind) => { el.textContent = GLYPH[kind]; } };
}
