// ============================================================================
//  Settings — a small store of user preferences, held privately here (same
//  discipline as state.ts's graph). Each setting carries its value plus two
//  independent flags: whether it's even *eligible* to appear as an icon on
//  the status bar (canShowOnBar — fixed per setting, decided once below)
//  and whether it currently *does* (showOnBar — mutable, meant to be
//  flipped later by a settings modal; for now it's just the framework, so
//  nothing here changes showOnBar itself except at startup).
//  Values persist only for the running session; nothing is written to
//  storage, and none of this reaches into the app to apply a change —
//  main.ts reads these values where it needs them.
// ============================================================================

// [2]: how Left/Right (rank and node selection) scrolling follows the
// current selection. "keep-in-view" is today's existing behaviour (nudge
// the scroll just enough to bring it on screen); "center" always centres
// it; "none" never auto-scrolls for it at all.
export type FollowMode = "center" | "keep-in-view" | "none";

// [3]: when a drag-created edge would break the A ≺ S ≺ D bank ordering
// (e.g. put an S node above an A node): "block" refuses the edge; the other
// two create it anyway, dropping the offending parent / child node from its
// bank to restore consistency.
export type EdgeConflictMode = "block" | "remove-parent" | "remove-child";

// [4]: which right-click on a node deletes it. "plain-deletes" (default): a
// bare right-click deletes, Shift+right-click clears the node's bank tag.
// "shift-deletes": the reverse.
export type NodeRightClick = "plain-deletes" | "shift-deletes";

export interface Setting<T> {
  value: T;
  readonly canShowOnBar: boolean;   // immutable: is this setting even eligible for the icon bar?
  showOnBar: boolean;               // mutable: is it actually shown there right now?
}

function setting<T>(value: T, canShowOnBar: boolean, showOnBar: boolean): Setting<T> {
  return { value, canShowOnBar, showOnBar: canShowOnBar && showOnBar };
}

export interface Settings {
  // [1]: upon creating a node, select and centre on it (vs. today's
  // behaviour of leaving selection/scroll untouched).
  selectAndCenterOnCreate: Setting<boolean>;
  // [2], see FollowMode above.
  followSelection: Setting<FollowMode>;
  // [3], see EdgeConflictMode above.
  edgeConflictResolution: Setting<EdgeConflictMode>;
  // [4], see NodeRightClick above.
  nodeRightClick: Setting<NodeRightClick>;
  // Whether banks A/S/D start disabled. Startup-only — not something a live
  // icon toggle would make sense for.
  bankADisabledByDefault: Setting<boolean>;
  bankSDisabledByDefault: Setting<boolean>;
  bankDDisabledByDefault: Setting<boolean>;
  // Whether the banks group on the icon bar starts hidden. Also startup-only.
  banksHiddenByDefault: Setting<boolean>;
}

const settings: Settings = {
  selectAndCenterOnCreate: setting(false, true, true),
  followSelection: setting<FollowMode>("keep-in-view", true, true),
  edgeConflictResolution: setting<EdgeConflictMode>("block", true, true),
  nodeRightClick: setting<NodeRightClick>("plain-deletes", true, true),
  bankADisabledByDefault: setting(false, false, false),
  bankSDisabledByDefault: setting(false, false, false),
  bankDDisabledByDefault: setting(false, false, false),
  banksHiddenByDefault: setting(false, false, false),
};

// The live store — callers may read any setting's fields directly
// (settings.value / .canShowOnBar / .showOnBar) but should only ever write
// through the functions below, so every change funnels through one place.
export function getSettings(): Readonly<Settings> { return settings; }

export function setSettingValue<K extends keyof Settings>(key: K, value: Settings[K]["value"]): void {
  settings[key].value = value;
}

// No-ops for a setting whose canShowOnBar is false — that flag is immutable.
export function setShowOnBar<K extends keyof Settings>(key: K, show: boolean): void {
  const s = settings[key];
  if (s.canShowOnBar) s.showOnBar = show;
}
