import { MODULE_ID, SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { fieldValue, joinList, splitList } from "../../core/helpers.js";
import { getSkyholdAppClass, getSkyholdManager } from "../registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

export class SkyholdCrewEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: true });
    const manager = getActiveSkyholdManager();
    const canEdit = this._canEditCrew(holding);
    if (!manager) return { ...context, canEdit, holding, holdingIndex, hasHolding: Boolean(holding), crews: [], hasCrews: false };
    const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !(manager._isResidentInjured?.(person)) && (manager._canResidentWork?.(person) ?? true));
    const occupiedAll = manager._assignedWorkerSet?.(holding) ?? new Set();
    const crews = manager._constructionCrews(holding).map((crew) => {
      const ownIds = new Set([String(crew.leaderId ?? ""), ...(crew.memberIds ?? []).map((id) => String(id ?? ""))].filter(Boolean));
      const leaderPeople = people.filter((person) => ownIds.has(String(person.id)) || !occupiedAll.has(String(person.id)));
      const prepared = manager._prepareConstructionCrew(holding, crew);
      return {
        ...prepared,
        namePath: `holdings.${holdingIndex}.constructionCrews.${(holding.constructionCrews ?? []).findIndex((item) => String(item.id) === String(crew.id))}.name`,
        leaderPath: `holdings.${holdingIndex}.constructionCrews.${(holding.constructionCrews ?? []).findIndex((item) => String(item.id) === String(crew.id))}.leaderId`,
        suitablePath: `holdings.${holdingIndex}.constructionCrews.${(holding.constructionCrews ?? []).findIndex((item) => String(item.id) === String(crew.id))}.suitableWorkerTypes`,
        suitableTypeOptions: manager._workerTypeSelectOptions(crew.suitableWorkerTypes),
        suitableTypeBadges: manager._suitableTypeBadges(crew.suitableWorkerTypes, `holdings.${holdingIndex}.constructionCrews.${(holding.constructionCrews ?? []).findIndex((item) => String(item.id) === String(crew.id))}.suitableWorkerTypes`),
        hasSuitableTypeBadges: splitList(crew.suitableWorkerTypes).length > 0,
        leaderOptions: [{ id: "", name: "Нет лидера", selected: !crew.leaderId }, ...leaderPeople.map((person) => ({ id: person.id, name: person.name || "Без имени", selected: String(person.id) === String(crew.leaderId) }))],
        slots: this._crewSlots(holding, manager, crew)
      };
    });
    return { ...context, canEdit, holding, holdingIndex, hasHolding: Boolean(holding), crews, hasCrews: crews.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    root.querySelectorAll("[data-field]").forEach((field) => field.addEventListener("change", (event) => this._onFieldChange(event)));
    root.querySelectorAll("[data-crew-slot]").forEach((field) => field.addEventListener("change", (event) => this._onCrewSlotChange(event)));
    root.querySelectorAll("[data-suitable-type-add-field]").forEach((field) => field.addEventListener("change", (event) => this._onSuitableTypeAddChange(event)));
    root.querySelectorAll("[data-action='remove-suitable-type']").forEach((button) => button.addEventListener("click", (event) => this._onRemoveSuitableType(event)));
    root.querySelectorAll("[data-action='add-crew']").forEach((button) => button.addEventListener("click", (event) => this._onAddCrew(event)));
    root.querySelectorAll("[data-action='delete-crew']").forEach((button) => button.addEventListener("click", (event) => this._onDeleteCrew(event)));
    root.querySelectorAll("[data-action='roll-construction-crew']").forEach((button) => button.addEventListener("click", (event) => this._onRollConstructionCrew(event)));
    root.querySelectorAll("[data-action='distribute-crew']").forEach((button) => button.addEventListener("click", (event) => this._onDistributeCrew(event)));
    root.querySelectorAll("[data-action='return-crew']").forEach((button) => button.addEventListener("click", (event) => this._onReturnCrew(event)));
  }

  async _onClose(options) {
    await super._onClose(options);
    this._unbindGlobalInputGuard();
    getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
  }

  _canEditCrew(holding = null) {
    if (game.user?.isGM) return true;
    const data = SkyholdData.get();
    const target = holding ?? findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    return Boolean(target?.gm?.playersCanEditBuildings === true);
  }

  _crewSlots(holding, manager, crew) {
    const ids = Array.isArray(crew?.memberIds) ? [...crew.memberIds] : [];
    while (ids.length && !ids[ids.length - 1]) ids.pop();
    ids.push("");
    const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
    const chosen = new Set(ids.filter(Boolean));
    const occupiedBuildings = manager._assignedWorkerSet(holding);
    return ids.map((selectedId, slot) => {
      const rawSelectedId = String(selectedId ?? "");
      const selectedPerson = people.find((person) => String(person.id) === rawSelectedId);
      selectedId = selectedPerson ? rawSelectedId : "";
      const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
      for (const person of people) {
        const id = String(person.id ?? "");
        const unavailable = (chosen.has(id) && id !== selectedId) || (occupiedBuildings.has(id) && id !== selectedId) || !(manager._canResidentWork?.(person) ?? true);
        if (unavailable) continue;
        const detail = manager._constructionContributionDetail(person, splitList(crew?.suitableWorkerTypes).map((item) => item.toLowerCase()));
        options.push({ id, name: person.name || "Без имени", selected: id === selectedId, disabled: false, hint: `${manager._workerType(person)} · ${detail.dice}к6` });
      }
      return { crewId: crew.id, slot, slotNo: slot + 1, selectedId, label: selectedPerson?.name ?? "Пусто", options };
    });
  }

  async _onFieldChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const field = event.currentTarget;
    const path = field.dataset.field;
    if (!path) return;
    const value = fieldValue(field);
    await SkyholdData.update(path, value);
    this.render({ force: true, focus: false });
  }

  async _onCrewSlotChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const slot = Number(event.currentTarget?.dataset?.crewSlot);
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    if (!Number.isFinite(slot) || !crewId) return;
    const value = String(event.currentTarget?.value ?? "");
    const data = SkyholdData.get();
    const holding = findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    if (!holding) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    manager._setCrewSlot(holding, crewId, slot, value);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onAddCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const data = SkyholdData.get();
    const holding = findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    if (!holding) return;
    if (!Array.isArray(holding.constructionCrews)) holding.constructionCrews = [];
    holding.constructionCrews.push({ id: foundry.utils.randomID?.(10) ?? `crew-${Date.now()}`, name: `Стройбригада ${holding.constructionCrews.length + 1}`, memberIds: [], leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец", distributed: false, distributedIds: [] });
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDeleteCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const data = SkyholdData.get();
    const holding = findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    if (!holding || !Array.isArray(holding.constructionCrews) || holding.constructionCrews.length <= 1) { ui.notifications.warn("Нельзя удалить последнюю стройбригаду."); return; }
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const crew = holding.constructionCrews.find((item) => String(item.id) === crewId);
    for (const id of crew?.memberIds ?? []) manager._setPersonFree(holding, id);
    holding.constructionCrews = holding.constructionCrews.filter((item) => String(item.id) !== crewId);
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }
  async _onSuitableTypeAddChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const field = event.currentTarget;
    const path = field.dataset.suitableTypeAddField;
    const value = String(field.value ?? "").trim();
    if (!path || !value) return;
    const data = SkyholdData.get();
    const list = splitList(foundry.utils.getProperty(data, path));
    if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
    foundry.utils.setProperty(data, path, joinList(list));
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onRemoveSuitableType(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const path = event.currentTarget?.dataset?.suitableTypesField;
    const value = String(event.currentTarget?.dataset?.suitableType ?? "").trim().toLowerCase();
    if (!path || !value) return;
    const data = SkyholdData.get();
    const list = splitList(foundry.utils.getProperty(data, path)).filter((item) => item.toLowerCase() !== value);
    foundry.utils.setProperty(data, path, joinList(list));
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onDistributeCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const data = SkyholdData.get();
    const holding = findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    const crew = holding?.constructionCrews?.find((item) => String(item.id) === crewId);
    if (!holding || !crew) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const ids = [...(crew.memberIds ?? [])].filter(Boolean);
    crew.distributedIds = ids;
    crew.memberIds = [];
    crew.distributed = true;
    for (const id of ids) {
      let placed = false;
      for (const building of holding.buildings?.list ?? []) {
        if (manager._buildingStatus(building).value !== "built") continue;
        const max = Math.max(0, manager._safeNumber(building.workersMax, 0));
        if (max <= 0) continue;
        if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
        while (building.assignedWorkerIds.length < max) building.assignedWorkerIds.push("");
        const slot = building.assignedWorkerIds.findIndex((value) => !value);
        if (slot >= 0) { manager._setBuildingSlot(holding, building.id, slot, id); placed = true; break; }
      }
      if (!placed) manager._setPersonFree(holding, id);
    }
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onReturnCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const data = SkyholdData.get();
    const holding = findReadableHoldingEntry(data, this.holdingId, { fallback: true }).holding;
    const crew = holding?.constructionCrews?.find((item) => String(item.id) === crewId);
    if (!holding || !crew) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const ids = [...(crew.distributedIds ?? [])].filter(Boolean);
    crew.memberIds = [];
    for (const id of ids) manager._setCrewSlot(holding, crew.id, crew.memberIds.length, id);
    crew.distributedIds = [];
    crew.distributed = false;
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  }

  async _onRollConstructionCrew(event) {
    event.preventDefault();
    event.stopPropagation();
    if (typeof this._canEditCrew === "function" && !this._canEditCrew()) return;
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    manager.activeHoldingId = this.holdingId;
    await manager._onRollConstructionCrew(event);
  }

  _bindInputGuards(root) {
    const stop = (event) => event.stopPropagation();
    root.querySelectorAll("input, textarea, select").forEach((field) => {
      for (const eventName of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "mousedown", "mouseup", "click", "dblclick"]) {
        field.addEventListener(eventName, stop, { capture: true });
        field.addEventListener(eventName, stop);
      }
    });
  }

  _bindGlobalInputGuard(root) {
    this._unbindGlobalInputGuard();
    const editableSelector = "input, textarea, select, [contenteditable='true']";
    this._globalInputGuard = (event) => {
      const target = event.target;
      const active = document.activeElement;
      const targetInside = target instanceof Element && root.contains(target);
      const activeInside = active instanceof Element && root.contains(active);
      const targetEditable = target instanceof Element && Boolean(target.closest(editableSelector));
      const activeEditable = active instanceof Element && Boolean(active.closest(editableSelector));
      if ((targetInside && targetEditable) || (activeInside && activeEditable)) event.stopImmediatePropagation();
    };
    for (const eventName of ["keydown", "keyup", "keypress"]) window.addEventListener(eventName, this._globalInputGuard, true);
  }

  _unbindGlobalInputGuard() {
    if (!this._globalInputGuard) return;
    for (const eventName of ["keydown", "keyup", "keypress"]) window.removeEventListener(eventName, this._globalInputGuard, true);
    this._globalInputGuard = null;
  }
}


SkyholdCrewEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-crew-editor"],
  tag: "section",
  window: {
    title: "Стройбригады",
    icon: "fa-solid fa-helmet-safety",
    resizable: true
  },
  position: {
    width: 920,
    height: 720
  }
};
SkyholdCrewEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/crew-editor.hbs` }
};
