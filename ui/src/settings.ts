// ============================================================================
//  Settings — a small store of user preferences, held privately here (same
//  discipline as state.ts's graph). Every setting's value is an enum/string
//  (booleans included, as "on"/"off"), carries the ordered list of states it
//  cycles through, a category (all "dag_view" for now), and either a
//  SettingIcon strategy or null when it can never be shown as a status-bar
//  icon. `showOnBar` (mutable, meant for a future settings modal) says whether
//  it currently is. Values persist only for the running session; nothing here
//  reaches into the app to apply a change — main.ts reads these where needed.
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

export interface Setting<T extends string> {
  value: T;
  readonly states: readonly T[];       // ordered — left-click cycles through these
  readonly category: SettingCategory;
  readonly icon: SettingIcon | null;   // null -> can never be a status-bar icon
  showOnBar: boolean;                   // currently shown as an icon (only meaningful when icon != null)
}

function setting<T extends string>(
  value: T, states: readonly T[], category: SettingCategory,
  icon: SettingIcon | null, showOnBar: boolean,
): Setting<T> {
  return { value, states, category, icon, showOnBar: !!icon && showOnBar };
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
  selectAndCenterOnCreate: setting<OnOff>("off", ["off", "on"], "dag_view", selectOnCreateIcon, true),
  followSelection: setting<FollowMode>(
    "keep-in-view", ["keep-in-view", "center", "none"], "dag_view", followSelectionIcon, true),
  edgeConflictResolution: setting<EdgeConflictMode>(
    "block", ["block", "remove-parent", "remove-child"], "dag_view", edgeConflictIcon, true),
  nodeRightClick: setting<NodeRightClick>(
    "plain-deletes", ["plain-deletes", "shift-deletes"], "dag_view", nodeRightClickIcon, true),
  showNewNodeInGraph: setting<OnOff>("on", ["on", "off"], "dag_view", showNewNodeIcon, true),
  bankADisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", null, false),
  bankSDisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", null, false),
  bankDDisabledByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", null, false),
  banksHiddenByDefault: setting<OnOff>("off", ["off", "on"], "dag_view", null, false),
};

// Readers may touch any setting's fields directly (settings.value / .states /
// .icon / .showOnBar) but should only write through the functions below.
export function getSettings(): Readonly<Settings> { return settings; }

export function setSettingValue<K extends keyof Settings>(key: K, value: Settings[K]["value"]): void {
  settings[key].value = value;
}

export function setShowOnBar<K extends keyof Settings>(key: K, show: boolean): void {
  const s = settings[key];
  if (s.icon) s.showOnBar = show;
}

// Loose helpers for the generic settings-group UI, which deals only in
// strings and can't line up `key` with its value type at compile time.
export function advanceSetting(key: keyof Settings): void {
  const s = settings[key] as unknown as { value: string; states: readonly string[] };
  const i = s.states.indexOf(s.value);
  s.value = s.states[(i + 1) % s.states.length];
}
export function setSettingString(key: keyof Settings, value: string): void {
  (settings[key] as unknown as { value: string }).value = value;
}
