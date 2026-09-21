// ============================================================================
//  Concrete SettingIcon implementations, one per icon-capable setting.
//  Placeholder single-letter glyphs for now.
// ============================================================================

import type { SettingIcon } from "./setting_icon";

const pick = (map: Record<string, string>, k: string): string => map[k] ?? k;

export const selectOnCreateIcon: SettingIcon = {
  render(el, state) {
    el.textContent = "1";
    el.classList.toggle("on", state === "on");
    el.title = `Select & centre on a new node when it's created: ${state === "on" ? "on" : "off"}`;
  },
  label: (state) => (state === "on"
    ? "On — select & centre new nodes"
    : "Off — leave selection & scroll alone"),
};

export const followSelectionIcon: SettingIcon = {
  render(el, state) {
    el.textContent = "2";
    el.classList.toggle("follow-center", state === "center");
    el.classList.toggle("follow-none", state === "none");
    el.title = `Left/Right follow mode: "${state}"`;
  },
  label: (state) => pick({
    "keep-in-view": "Keep in view (nudge onto screen)",
    "center": "Center on the selection",
    "none": "Don't auto-scroll",
  }, state),
};

export const edgeConflictIcon: SettingIcon = {
  render(el, state) {
    el.textContent = state === "block" ? "B" : state === "remove-parent" ? "P" : "C";
    el.classList.toggle("edge-remove-parent", state === "remove-parent");
    el.classList.toggle("edge-remove-child", state === "remove-child");
    el.title = `Drag-created edge that breaks A/S/D bank ordering: ${pick({
      "block": "block it",
      "remove-parent": "create it, dropping the offending parent from its bank",
      "remove-child": "create it, dropping the offending child from its bank",
    }, state)}`;
  },
  label: (state) => pick({
    "block": "Block the edge",
    "remove-parent": "Create it — drop the offending parent",
    "remove-child": "Create it — drop the offending child",
  }, state),
};

export const showNewNodeIcon: SettingIcon = {
  render(el, state) {
    el.textContent = "G";
    el.classList.toggle("on", state === "on");
    el.title = `Show the node being created as a translucent preview in the graph: ${state === "on" ? "on" : "off"}`;
  },
  label: (state) => (state === "on"
    ? "On — preview the new node in the graph"
    : "Off — no preview"),
};

export const nodeRightClickIcon: SettingIcon = {
  render(el, state) {
    el.textContent = state === "shift-deletes" ? "S" : "P";
    el.classList.toggle("rc-shift-deletes", state === "shift-deletes");
    el.title = state === "shift-deletes"
      ? "Node right-click: Shift+right-click deletes, right-click clears the bank tag"
      : "Node right-click: right-click deletes, Shift+right-click clears the bank tag";
  },
  label: (state) => (state === "shift-deletes"
    ? "Shift+right-click deletes (right-click clears the bank tag)"
    : "Right-click deletes (Shift+right-click clears the bank tag)"),
};
