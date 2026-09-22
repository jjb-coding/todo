// ============================================================================
//  Settings group — the row of setting icons under the status bar. Given a
//  category, it finds every icon-capable setting in that category that's
//  currently shown, and renders one button each. Left-click cycles the
//  setting through its enumerable states; right-click opens a menu of all
//  states to pick from directly. It links straight into settings.ts and owns
//  no setting logic of its own.
//
//  The whole group is rebuilt from scratch on every settings change (from
//  here, the settings modal, or a cross-setting irrelevance effect) rather
//  than patched incrementally — `showOnBar` itself can now change live from
//  the modal, so the very set of rendered buttons can change, not just their
//  painted state.
// ============================================================================

import { getSettings, advanceSetting, setSettingString, getIrrelevance, onSettingsChanged } from "../settings";
import type { Settings, SettingCategory } from "../settings";
import type { SettingIcon } from "./setting_icon";
import { localise } from "../lang";

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

function openMenu(btn: HTMLElement, key: keyof Settings, icon: SettingIcon): void {
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
    // setSettingString notifies -> the group (and the modal, if open) rebuild.
    item.addEventListener("click", () => { setSettingString(key, state); closeMenu(); });
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

export function createSettingsGroup(category: SettingCategory): SettingsGroupView {
  const el = document.createElement("div");
  el.className = "dag-bargroup";

  // A setting whose current value has no real effect (see settings.ts's
  // getIrrelevance) still shows its state as a placeholder — greying it out
  // is layered on via this wrapper span, entirely outside the icon's own
  // render(), which each SettingIcon owns and repaints on its own terms.
  function rebuild(): void {
    el.innerHTML = "";
    const S = getSettings();
    (Object.keys(S) as (keyof Settings)[]).forEach(key => {
      const s = S[key];
      if (s.category !== category || !s.icon || !s.showOnBar) return;
      const icon = s.icon;

      const wrap = document.createElement("span");
      wrap.className = "dag-setting-wrap";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dag-settingbtn";
      wrap.appendChild(btn);

      icon.render(btn, s.value);
      const irr = getIrrelevance(key);
      wrap.classList.toggle("irrelevant", !!irr);
      if (irr) btn.title = localise(irr.attributionKey);   // overrides the icon's own state tooltip

      btn.addEventListener("click", () => advanceSetting(key));
      btn.addEventListener("contextmenu", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        openMenu(btn, key, icon);
      });
      el.appendChild(wrap);
    });
  }

  rebuild();
  onSettingsChanged(rebuild);
  return { el };
}
