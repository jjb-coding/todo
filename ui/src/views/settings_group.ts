// ============================================================================
//  Settings group — the row of setting icons under the status bar. Given a
//  category, it finds every icon-capable setting in that category that's
//  currently shown, and renders one button each. Left-click cycles the
//  setting through its enumerable states; right-click opens a menu of all
//  states to pick from directly. It links straight into settings.ts and owns
//  no setting logic of its own.
// ============================================================================

import { getSettings, advanceSetting, setSettingString } from "../settings";
import type { Settings, SettingCategory } from "../settings";
import type { SettingIcon } from "./setting_icon";

export interface SettingsGroupView {
  readonly el: HTMLElement;
}

let activeMenu: HTMLElement | null = null;
function closeMenu(): void {
  if (!activeMenu) return;
  activeMenu.remove();
  activeMenu = null;
  document.removeEventListener("mousedown", onDocDown, true);
}
function onDocDown(ev: MouseEvent): void {
  if (activeMenu && !activeMenu.contains(ev.target as Node)) closeMenu();
}

function openMenu(
  btn: HTMLElement, key: keyof Settings, icon: SettingIcon,
  paint: () => void, notify: () => void,
): void {
  closeMenu();
  const s = getSettings()[key] as unknown as { value: string; states: readonly string[] };
  const menu = document.createElement("div");
  menu.className = "dag-setting-menu";
  s.states.forEach(state => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "dag-setting-menu-item";
    item.textContent = icon.label(state);
    item.classList.toggle("current", state === s.value);
    item.addEventListener("click", () => { setSettingString(key, state); paint(); notify(); closeMenu(); });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(6, r.left) + "px";
  const above = r.top - menu.offsetHeight - 6;               // the bar sits near the bottom
  menu.style.top = (above >= 6 ? above : r.bottom + 6) + "px";
  activeMenu = menu;
  setTimeout(() => document.addEventListener("mousedown", onDocDown, true), 0);
}

export function createSettingsGroup(
  category: SettingCategory,
  onChange?: (key: keyof Settings) => void,
): SettingsGroupView {
  const el = document.createElement("div");
  el.className = "dag-bargroup";
  const S = getSettings();
  const notify = (key: keyof Settings) => () => onChange?.(key);

  (Object.keys(S) as (keyof Settings)[]).forEach(key => {
    const s = S[key];
    if (s.category !== category || !s.icon || !s.showOnBar) return;
    const icon = s.icon;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dag-settingbtn";
    const paint = (): void => icon.render(btn, (getSettings()[key] as unknown as { value: string }).value);
    paint();
    btn.addEventListener("click", () => { advanceSetting(key); paint(); onChange?.(key); });
    btn.addEventListener("contextmenu", ev => {
      ev.preventDefault();
      ev.stopPropagation();
      openMenu(btn, key, icon, paint, notify(key));
    });
    el.appendChild(btn);
  });

  return { el };
}
