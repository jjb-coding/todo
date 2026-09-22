// ============================================================================
//  Settings modal — a gear button (top-right, floating over everything) that
//  opens a full editor for every registered setting. Entirely generated from
//  settings.ts's registry: categories down the side, subcategories as
//  collapsible page dividers in the main scrolling column, and one table per
//  subcategory with Setting / Appears in Icon Bar / State columns. Nothing
//  here is a fixed per-setting layout — add a setting to settings.ts and it
//  appears here for free.
//
//  Self-mounted: call createSettingsModal() once; it appends its own gear
//  button and (initially hidden) overlay to document.body and manages both
//  internally. It subscribes to onSettingsChanged so it stays in sync with
//  changes made anywhere else (the icon bar, or a cross-setting irrelevance
//  effect), and re-renders itself on any change made from within.
// ============================================================================

import {
  getSettings, setSettingString, setShowOnBar, getIrrelevance, onSettingsChanged,
  CATEGORIES, SUBCATEGORY_ORDER,
} from "./settings";
import type { Settings, SettingCategory, SettingSubcategory } from "./settings";
import { localise } from "./lang";

function isOnOff(states: readonly string[]): boolean {
  return states.length === 2 && states.includes("on") && states.includes("off");
}

function createToggle(isOn: boolean, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dag-modal-toggle" + (isOn ? " on" : "");
  btn.textContent = localise(isOn ? "common:on" : "common:off");
  btn.addEventListener("click", ev => { ev.stopPropagation(); onClick(); });
  return btn;
}

export function createSettingsModal(): void {
  let selectedCategory: SettingCategory = CATEGORIES[0];
  const collapsed = new Set<SettingSubcategory>();
  let isOpen = false;

  const gearButton = document.createElement("button");
  gearButton.type = "button";
  gearButton.className = "dag-gear-btn";
  gearButton.textContent = "⚙";   // ⚙
  gearButton.title = localise("settings_modal:open");

  const overlay = document.createElement("div");
  overlay.className = "dag-settings-overlay";

  const panel = document.createElement("div");
  panel.className = "dag-settings-panel";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dag-settings-close";
  closeBtn.textContent = "×";   // ×
  closeBtn.title = localise("settings_modal:close");

  const sidebar = document.createElement("div");
  sidebar.className = "dag-settings-sidebar";
  const main = document.createElement("div");
  main.className = "dag-settings-main";

  panel.append(closeBtn, sidebar, main);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.body.appendChild(gearButton);

  function open(): void { isOpen = true; overlay.classList.add("open"); render(); }
  function close(): void { isOpen = false; overlay.classList.remove("open"); }

  gearButton.addEventListener("click", open);
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("mousedown", ev => { if (ev.target === overlay) close(); });
  document.addEventListener("keydown", ev => { if (isOpen && ev.key === "Escape") close(); });

  // One setting's row(s): the first row carries its name + icon-bar toggle;
  // an OnOff-typed setting is a single row with a State toggle, anything
  // else spreads one row per option (blank Setting/Icon-bar cells past the
  // first) so every option is visible as plain text, never a dropdown.
  function buildEntryRows(key: keyof Settings, band: "band-a" | "band-b"): HTMLTableRowElement[] {
    const s = getSettings()[key] as unknown as {
      value: string; states: readonly string[]; icon: unknown; showOnBar: boolean;
    };
    const irr = getIrrelevance(key);
    const onOff = isOnOff(s.states);
    const rowCount = onOff ? 1 : s.states.length;
    const rows: HTMLTableRowElement[] = [];

    for (let i = 0; i < rowCount; i++) {
      const tr = document.createElement("tr");
      tr.className = "dag-settings-row " + band + (irr ? " irrelevant" : "");
      if (irr) tr.title = localise(irr.attributionKey);

      const nameTd = document.createElement("td");
      nameTd.className = "dag-settings-cell-name";
      if (i === 0) {
        nameTd.textContent = localise("setting:" + key);
        nameTd.classList.toggle("strike", !!irr);
      }
      tr.appendChild(nameTd);

      const iconTd = document.createElement("td");
      iconTd.className = "dag-settings-cell-iconbar";
      if (i === 0 && s.icon) {
        iconTd.appendChild(createToggle(s.showOnBar, () => setShowOnBar(key, !getSettings()[key].showOnBar)));
      }
      tr.appendChild(iconTd);

      const stateTd = document.createElement("td");
      stateTd.className = "dag-settings-cell-state";
      if (onOff) {
        stateTd.appendChild(createToggle(s.value === "on", () => setSettingString(key, s.value === "on" ? "off" : "on")));
      } else {
        const state = s.states[i];
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "dag-settings-option" + (state === s.value ? " current" : "");
        opt.textContent = localise("setting_value:" + key + ":" + state);
        opt.addEventListener("click", () => setSettingString(key, state));
        stateTd.appendChild(opt);
      }
      tr.appendChild(stateTd);
      rows.push(tr);
    }
    return rows;
  }

  function buildSection(subcat: SettingSubcategory, keys: (keyof Settings)[]): HTMLElement {
    const section = document.createElement("div");
    section.className = "dag-settings-section" + (collapsed.has(subcat) ? " collapsed" : "");

    const header = document.createElement("div");
    header.className = "dag-settings-section-header";
    header.textContent = localise("settings_subcategory:" + subcat);
    header.addEventListener("click", () => {
      if (collapsed.has(subcat)) collapsed.delete(subcat); else collapsed.add(subcat);
      render();
    });
    section.appendChild(header);

    if (!collapsed.has(subcat)) {
      const table = document.createElement("table");
      table.className = "dag-settings-table";
      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      ["setting_column:setting", "setting_column:appears_in_icon_bar", "setting_column:state"].forEach(k => {
        const th = document.createElement("th");
        th.textContent = localise(k);
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement("tbody");
      keys.forEach((key, i) => {
        buildEntryRows(key, i % 2 === 0 ? "band-a" : "band-b").forEach(tr => tbody.appendChild(tr));
      });
      table.appendChild(tbody);
      section.appendChild(table);
    }
    return section;
  }

  function render(): void {
    if (!isOpen) return;

    sidebar.innerHTML = "";
    CATEGORIES.forEach(cat => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dag-settings-cat" + (cat === selectedCategory ? " current" : "");
      btn.textContent = localise("settings_category:" + cat);
      btn.addEventListener("click", () => { selectedCategory = cat; render(); });
      sidebar.appendChild(btn);
    });

    main.innerHTML = "";
    const S = getSettings();
    const bySub = new Map<SettingSubcategory, (keyof Settings)[]>();
    (Object.keys(S) as (keyof Settings)[]).forEach(key => {
      const s = S[key];
      if (s.category !== selectedCategory) return;
      if (!bySub.has(s.subcategory)) bySub.set(s.subcategory, []);
      bySub.get(s.subcategory)!.push(key);
    });
    SUBCATEGORY_ORDER.forEach(sub => {
      const keys = bySub.get(sub);
      if (keys && keys.length) main.appendChild(buildSection(sub, keys));
    });
  }

  onSettingsChanged(render);
}
