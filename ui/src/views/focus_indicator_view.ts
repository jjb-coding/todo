// Focus indicator: an "F" with the current focus-stack depth as a superscript,
// dimmed when the depth is zero (not focused into anything).
export interface FocusIndicatorView {
  readonly el: HTMLElement;
  set(depth: number): void;
}

export function createFocusIndicatorView(): FocusIndicatorView {
  const el = document.createElement("div");
  el.className = "dag-focusind";
  el.title = "Focus — F narrows to the selection's ancestry, Shift+F pops back out";
  const letter = document.createElement("span");
  letter.textContent = "F";
  const depthEl = document.createElement("span");
  depthEl.className = "dag-focus-depth";
  depthEl.textContent = "0";
  el.append(letter, depthEl);
  return {
    el,
    set: (depth) => {
      depthEl.textContent = String(depth);
      el.classList.toggle("off", depth === 0);
    },
  };
}
