// ============================================================================
//  Settings — a small store of user preferences, held privately here (same
//  discipline as state.ts's graph). Every setting's value is an enum/string
//  (booleans included, as "on"/"off"), carries the ordered list of states it
//  cycles through, a category and subcategory (for the settings modal's
//  sidebar/section grouping — all "dag_view" for now), and either a
//  SettingIcon strategy or null when it can never be shown as a status-bar
//  icon. `showOnBar` says whether it currently is, mutable from the settings
//  modal. Values persist only for the running session; nothing here reaches
//  into the app to apply a change — main.ts reads these where needed.
//
//  Registry-driven UI: settings_group.ts (icon bar) and settings_modal.ts
//  (the modal) both render themselves entirely off the `Settings` object and
//  the metadata below, rather than hardcoding a per-setting layout — adding a
//  setting here is enough for both to pick it up. Both subscribe to
//  onSettingsChanged so a change from either place (or getIrrelevance's
//  cross-setting effects) is reflected everywhere immediately.
// ============================================================================

import type { SettingIcon } from "./views/setting_icon";
import {
  selectOnCreateIcon, followSelectionIcon, edgeConflictIcon, nodeRightClickIcon, showNewNodeIcon,
} from "./views/setting_icons";

// how Left/Right scrolling follows the current selection.
export type FollowMode = "center" | "keep-in-view" | "none";
// when a drag-created edge would break the A ≺ S ≺ D bank ordering.
export type EdgeConflictMode = "block" | "remove-parent" | "remove-child";
// which right-click chord on a node deletes it.
export type NodeRightClick = "plain-deletes" | "shift-deletes";
export type OnOff = "on" | "off";

export type SettingCategory = "dag_view";
export const CATEGORIES: readonly SettingCategory[] = ["dag_view"];

// Groups settings into page-divider sections within the settings modal.
export type SettingSubcategory = "navigation" | "interaction" | "new_node_editor" | "banks_startup";
export const SUBCATEGORY_ORDER: readonly SettingSubcategory[] =
  ["navigation", "interaction", "new_node_editor", "banks_startup"];

export interface Setting<T extends string> {
  value: T;
  readonly states: readonly T[];       // ordered — left-click cycles through these
  readonly category: SettingCategory;
  readonly subcategory: SettingSubcategory;
  readonly icon: SettingIcon | null;   // null -> can never be a status-bar icon
  showOnBar: boolean;                   // currently shown as an icon (only meaningful when icon != null)
}

function setting<T extends string>(
  value: T, states: readonly T[], category: SettingCategory, subcategory: SettingSubcategory,
  icon: SettingIcon | null, showOnBar: boolean,
): Setting<T> {
  return { value, states, category, subcategory, icon, showOnBar: !!icon && showOnBar };
}

export interface Settings {
  // [1]: upon creating a node, select and centre on it (vs. leaving
  // selection/scroll untouched).
  selectAndCenterOnCreate: Setting<OnOff>;
  // [2], see FollowMode above.
  followSelection: Setting<FollowMode>;
  // [3], see EdgeConflictMode above.
  edgeConflictResolution: Setting<EdgeConflictMode>;
  // [4], see NodeRightClick above.
  nodeRightClick: Setting<NodeRightClick>;
  // [5]: show the node currently being created as a translucent preview.
  showNewNodeInGraph: Setting<OnOff>;
  // Startup-only: whether banks A/S/D start disabled, and whether the banks
  // icon group starts hidden. Never status-bar icons.
  bankADisabledByDefault: Setting<OnOff>;
  bankSDisabledByDefault: Setting<OnOff>;
  bankDDisabledByDefault: Setting<OnOff>;
  banksHiddenByDefault: Setting<OnOff>;
}

const settings: Settings = {
  selectAndCenterOnCreate: setting<OnOff>(
    "off", ["off", "on"], "dag_view", "navigation", selectOnCreateIcon, true),
  followSelection: setting<FollowMode>(
    "keep-in-view", ["keep-in-view", "center", "none"], "dag_view", "navigation", followSelectionIcon, true),
  edgeConflictResolution: setting<EdgeConflictMode>(
    "block", ["block", "remove-parent", "remove-child"], "dag_view", "interaction", edgeConflictIcon, true),
  nodeRightClick: setting<NodeRightClick>(
    "plain-deletes", ["plain-deletes", "shift-deletes"], "dag_view", "interaction", nodeRightClickIcon, true),
  showNewNodeInGraph: setting<OnOff>(
    "on", ["on", "off"], "dag_view", "new_node_editor", showNewNodeIcon, true),
  bankADisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", "banks_startup", null, false),
  bankSDisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", "banks_startup", null, false),
  bankDDisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", "banks_startup", null, false),
  banksHiddenByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", "banks_startup", null, false),
};

// Readers may touch any setting's fields directly (settings.value / .states /
// .icon / .showOnBar) but should only write through the functions below.
export function getSettings(): Readonly<Settings> { return settings; }

// ---- Change notification ---------------------------------------------------
// Every mutator below fires this after changing anything, so every rendered
// view of the settings (icon bar, modal, main.ts's ghost sync) can just
// subscribe once and re-derive its own display — regardless of which view
// (or which cross-setting irrelevance effect) actually caused the change.
type Listener = () => void;
const listeners = new Set<Listener>();
export function onSettingsChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void { listeners.forEach(cb => cb()); }

export function setSettingValue<K extends keyof Settings>(key: K, value: Settings[K]["value"]): void {
  settings[key].value = value;
  notify();
}

export function setShowOnBar<K extends keyof Settings>(key: K, show: boolean): void {
  const s = settings[key];
  if (s.icon) s.showOnBar = show;
  notify();
}

// Loose helpers for the generic settings-group UI, which deals only in
// strings and can't line up `key` with its value type at compile time.
export function advanceSetting(key: keyof Settings): void {
  const s = settings[key] as unknown as { value: string; states: readonly string[] };
  const i = s.states.indexOf(s.value);
  s.value = s.states[(i + 1) % s.states.length];
  notify();
}
export function setSettingString(key: keyof Settings, value: string): void {
  (settings[key] as unknown as { value: string }).value = value;
  notify();
}

// ---- Cross-setting irrelevance ----------------------------------------------
// A setting can be rendered but have no actual effect because of another
// setting's current value. `attributionKey` is itself a localisation key (in
// the same "prepend a namespace" style as everything else here), not English
// text — a real translation would map each specific attributionKey to its
// own full sentence, e.g. "irrelevant_attribution:banksHiddenByDefault:on"
// -> "Irrelevant while the icon bar is hidden."
export interface Irrelevance { readonly attributionKey: string; }

export function getIrrelevance(key: keyof Settings): Irrelevance | null {
  switch (key) {
    // The banks icon group being hidden makes moot whether each bank starts
    // disabled — there's no bar left to show that state on.
    case "bankADisabledByDefault":
    case "bankSDisabledByDefault":
    case "bankDDisabledByDefault":
      if (settings.banksHiddenByDefault.value === "on") {
        return { attributionKey: "irrelevant_attribution:banksHiddenByDefault:on" };
      }
      return null;
    // With both A and D starting disabled, there's no A/S/D bank ordering
    // left for a drag-created edge to ever break.
    case "edgeConflictResolution":
      if (settings.bankADisabledByDefault.value === "on" && settings.bankDDisabledByDefault.value === "on") {
        return { attributionKey: "irrelevant_attribution:bankADisabledByDefault+bankDDisabledByDefault:on" };
      }
      return null;
    default:
      return null;
  }
}
