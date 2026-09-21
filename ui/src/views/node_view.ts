// ============================================================================
//  Node view — owns one node's DOM (the .dag-node card, its inner tally and
//  bank badge, and the sibling .dag-enum superscript) and every visual
//  attribute that can be applied to it. main.ts holds all the logic and
//  decides *what* state a node is in; it drives that state in through these
//  methods and never touches the elements directly.
// ============================================================================

import type { NodeDef } from "../state";
import { ringShadow, rgbStr, rgbaStr, darker, tallySvg, DOTTED_COL, HL } from "../colors";

export type RingKind = "select" | "green" | "red" | "bank-a" | "bank-d" | "bank-s";
export type TallyKind = "green" | "red";
export type EdgeDropKind = "ok" | "no";
export type BankLetter = "A" | "D" | "S";

export interface NodeView {
  readonly el: HTMLDivElement;        // the .dag-node card — main.ts wires pointer listeners here
  readonly def: NodeDef;
  readonly width: number;
  visible: boolean;

  measure(): number;                                    // current offsetHeight
  setContent(title: string, body: string | undefined): void;
  moveTo(x: number, y: number): void;
  show(visible: boolean): void;

  reset(): void;                                         // clear ring / opacity / outline, hide tally + enum
  setOpacity(o: number): void;
  setRing(kind: RingKind, strength: number): void;
  setDottedOutline(strength: number): void;              // the "frontier" dashed inner ring
  setSubselectOutline(): void;                           // the thick sub-select border
  setCursor(c: "pointer" | "not-allowed"): void;

  setTally(count: number, kind: TallyKind): void;
  showEnum(text: string, left: number, top: number): void;
  styleEnum(active: boolean): void;                      // sub-select emphasis tweak
  hideEnum(): void;

  setBadge(letter: BankLetter, provisional: boolean): void;
  hideBadge(): void;

  setBankHover(on: boolean): void;
  setEdgeDrop(kind: EdgeDropKind | null): void;
  setGhost(on: boolean): void;          // translucent "new node" preview styling

  destroy(): void;
}

export function createNodeView(def: NodeDef, container: HTMLElement, width: number): NodeView {
  const el = document.createElement("div");
  el.className = "dag-node";
  const titleEl = document.createElement("div");
  titleEl.className = "dag-node-title";
  titleEl.textContent = def.title;
  el.appendChild(titleEl);
  let bodyEl: HTMLDivElement | null = null;
  if (def.body) {
    bodyEl = document.createElement("div");
    bodyEl.className = "dag-node-body";
    bodyEl.textContent = def.body;
    el.appendChild(bodyEl);
  }
  el.style.width = width + "px";
  el.style.left = "-9999px"; el.style.top = "0"; el.style.visibility = "hidden";
  container.appendChild(el);            // measure off-screen (position:absolute already in CSS)
  el.style.visibility = "visible"; el.style.cursor = "pointer";

  const tallyEl = document.createElement("div");
  tallyEl.className = "dag-tally";
  el.appendChild(tallyEl);

  const badgeEl = document.createElement("div");
  badgeEl.className = "dag-bank-badge";
  el.appendChild(badgeEl);

  const enumEl = document.createElement("div");
  enumEl.className = "dag-enum";
  container.appendChild(enumEl);

  const RINGS: Record<RingKind, (s: number) => string> = {
    select:   s => ringShadow(rgbaStr(HL.yellow, 0.65 + 0.35 * s), 1.5 + 1.5 * s, s),
    green:    s => ringShadow(rgbaStr(HL.green,  0.55 + 0.45 * s), 1 + 1.3 * s, 0),
    red:      s => ringShadow(rgbaStr(HL.red,    0.55 + 0.45 * s), 1 + 1.3 * s, 0),
    "bank-a": () => ringShadow(rgbaStr(HL.green,  0.85), 2.6, 0.4),
    "bank-d": () => ringShadow(rgbaStr(HL.red,    0.85), 2.6, 0.4),
    "bank-s": () => ringShadow(rgbaStr(HL.yellow, 0.85), 2.6, 0.4),
  };

  const view: NodeView = {
    el, def, width,
    visible: true,

    measure: () => el.offsetHeight,
    setContent(title, body) {
      titleEl.textContent = title;
      if (body) {
        if (!bodyEl) {
          bodyEl = document.createElement("div");
          bodyEl.className = "dag-node-body";
          el.insertBefore(bodyEl, tallyEl);
        }
        bodyEl.textContent = body;
      } else if (bodyEl) {
        bodyEl.remove();
        bodyEl = null;
      }
    },
    moveTo(x, y) { el.style.left = x + "px"; el.style.top = y + "px"; },
    show(v) {
      view.visible = v;
      el.style.display = v ? "" : "none";
      if (!v) { enumEl.style.display = "none"; tallyEl.style.display = "none"; }
    },

    reset() {
      el.style.opacity = ""; el.style.boxShadow = ""; el.style.outline = ""; el.style.outlineOffset = "";
      tallyEl.style.display = "none"; tallyEl.innerHTML = "";
      enumEl.style.display = "none";
    },
    setOpacity(o) { el.style.opacity = String(o); },
    setRing(kind, s) { el.style.boxShadow = RINGS[kind](s); },
    setDottedOutline(s) {
      el.style.outline = `${(1.5 + s).toFixed(1)}px dashed ${rgbaStr(DOTTED_COL, 0.5 + 0.4 * s)}`;
      el.style.outlineOffset = `-${(3 + 2 * s).toFixed(1)}px`;
    },
    setSubselectOutline() {
      el.style.outline = "2.5px dashed rgba(18,26,38,0.9)";
      el.style.outlineOffset = "-5px";
    },
    setCursor(c) { el.style.cursor = c; },

    setTally(count, kind) {
      tallyEl.innerHTML = tallySvg(count, rgbStr(darker(kind === "green" ? HL.green : HL.red)));
      tallyEl.style.display = "block";
    },
    showEnum(text, left, top) {
      enumEl.textContent = text;
      enumEl.style.left = left + "px";
      enumEl.style.top = top + "px";
      enumEl.style.opacity = ".55"; enumEl.style.color = "#5b6b7a";
      enumEl.style.display = "block";
    },
    styleEnum(active) {
      if (active) { enumEl.style.opacity = "1"; enumEl.style.color = "#0f1720"; }
      else { enumEl.style.opacity = "0.25"; }
    },
    hideEnum() { enumEl.style.display = "none"; },

    setBadge(letter, provisional) {
      badgeEl.textContent = letter;
      badgeEl.className = "dag-bank-badge " + letter.toLowerCase() + (provisional ? " provisional" : "");
      badgeEl.style.display = "block";
    },
    hideBadge() { badgeEl.style.display = "none"; },

    setBankHover(on) { el.classList.toggle("bank-hover", on); },
    setEdgeDrop(kind) {
      el.classList.toggle("edge-drop", kind === "ok");
      el.classList.toggle("edge-drop-no", kind === "no");
    },
    setGhost(on) { el.classList.toggle("dag-node-ghost", on); },

    destroy() { el.remove(); enumEl.remove(); },
  };
  return view;
}
