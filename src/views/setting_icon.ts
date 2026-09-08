// ============================================================================
//  SettingIcon — the display strategy for one setting's status-bar icon.
//  Generic across every setting: it's handed the setting's current
//  enum/string value and decides how the button looks (a switch/case in every
//  current case). settings_group.ts owns the button element, the click-cycle
//  and the right-click menu; the icon only paints and names states.
// ============================================================================

export interface SettingIcon {
  /** Paint `el` for the setting's current `state` value. */
  render(el: HTMLButtonElement, state: string): void;
  /** Human label for `state`, shown in the right-click menu. */
  label(state: string): string;
}
