// LR nav indicator — lit unless Left/Right would currently do nothing.
export interface BoolIconView {
  readonly el: HTMLElement;
  set(active: boolean): void;
}

export function createLrIconView(): BoolIconView {
  const el = document.createElement("div");
  el.className = "dag-navind";
  el.textContent = "LR";
  el.title = "Left/Right arrows — active when they'd change rank";
  return { el, set: (active) => { el.classList.toggle("off", !active); } };
}
