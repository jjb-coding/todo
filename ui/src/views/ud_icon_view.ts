import type { BoolIconView } from "./lr_icon_view";

// UD nav indicator — lit unless Up/Down would currently do nothing.
export function createUdIconView(): BoolIconView {
  const el = document.createElement("div");
  el.className = "dag-navind";
  el.textContent = "UD";
  el.title = "Up/Down arrows — active when they'd move within a rank";
  return { el, set: (active) => { el.classList.toggle("off", !active); } };
}
