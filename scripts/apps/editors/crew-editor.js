import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { fieldValue, joinList, splitList } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindDelegatedActions, unbindDelegatedActions } from "../common/delegated-events.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const CREW_EDITOR_NO_HOLDING_MESSAGE = "Владение не найдено или недоступно.";
const CREW_EDITOR_ACTIONS = {
  "remove-suitable-type": "_onRemoveSuitableType",
  "add-crew": "_onAddCrew",
  "delete-crew": "_onDeleteCrew",
  "roll-construction-crew": "_onRollConstructionCrew",
  "distribute-crew": "_onDistributeCrew",
  "return-crew": "_onReturnCrew"
};

function getActiveSkyholdManager({ warn = false } = {}) {
  const manager = getSkyholdManager();
  if (!manager && warn) ui.notifications?.warn?.("FBL Skyhold manager is closed. Open it before using this editor action.");
  return manager;
}

export class SkyholdCrewEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const canEdit = this._canEditCrew(holding);
    if (!holding) {
      return { ...context, canEdit: false, holding: null, holdingIndex: -1, hasHolding: false, error: CREW_EDITOR_NO_HOLDING_MESSAGE, crews: [], hasCrews: false };
    }
    const manager = getActiveSkyholdManager();
    if (!manager) return { ...context, canEdit, holding, holdingIndex, hasHolding: true, error: "", crews: [], hasCrews: false };
    const renderContext = this._crewRenderContext(holding, manager);
    const { eligiblePeople, occupiedAll, crewIndexById } = renderContext;
    const crews = manager._constructionCrews(holding).map((crew) => {
      const ownIds = new Set([String(crew.leaderId ?? ""), ...(crew.memberIds ?? []).map((id) => String(id ?? ""))].filter(Boolean));
      const crewIndex = crewIndexById.get(String(crew.id)) ?? -1;
      const crewBasePath = `holdings.${holdingIndex}.constructionCrews.${crewIndex}`;
      const suitablePath = `${crewBasePath}.suitableWorkerTypes`;
      const leaderPeople = eligiblePeople.filter((person) => ownIds.has(String(person.id)) || !occupiedAll.has(String(person.id)));
      const prepared = manager._prepareConstructionCrew(holding, crew);
      return {
        ...prepared,
        namePath: `${crewBasePath}.name`,
        leaderPath: `${crewBasePath}.leaderId`,
        suitablePath,
        suitableTypeOptions: manager._workerTypeSelectOptions(crew.suitableWorkerTypes),
        suitableTypeBadges: manager._suitableTypeBadges(crew.suitableWorkerTypes, suitablePath),
        hasSuitableTypeBadges: splitList(crew.suitableWorkerTypes).length > 0,
        leaderOptions: [{ id: "", name: "Нет лидера", selected: !crew.leaderId }, ...leaderPeople.map((person) => ({ id: person.id, name: person.name || "Без имени", selected: String(person.id) === String(crew.leaderId) }))],
        slots: this._crewSlots(holding, manager, crew, renderContext)
      };
    });
    return { ...context, canEdit, holding, holdingIndex, hasHolding: true, error: "", crews, hasCrews: crews.length > 0 };
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
    bindDelegatedActions(this, root, CREW_EDITOR_ACTIONS);
  }

  async _onClose(options) {
    await super._onClose(options);
    unbindDelegatedActions(this);
    this._unbindGlobalInputGuard();
    requestSkyholdAppRender();
  }

  _canEditCrew(holding = null) {
    const data = SkyholdData.get();
    const target = holding ?? findReadableHoldingEntry(data, this.holdingId, { fallback: false }).holding;
    return holdingPermissionContext(target).canEditBuildings;
  }

  _resolveHoldingScopedPath(data, path = "") {
    const suffix = String(path ?? "").match(/^holdings\.\d+\.(.+)$/)?.[1];
    if (!suffix) return "";
    const { index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    if (holdingIndex < 0) return "";
    return `holdings.${holdingIndex}.${suffix}`;
  }

  _crewRenderContext(holding, manager) {
    const livingPeople = (holding?.people?.list ?? []).filter((person) => !person?.dead);
    const eligiblePeople = livingPeople.filter((person) => !(manager._isResidentInjured?.(person)) && (manager._canResidentWork?.(person) ?? true));
    const crewIndexById = new Map((holding?.constructionCrews ?? []).map((crew, index) => [String(crew?.id ?? ""), index]));
    return {
      livingPeople,
      eligiblePeople,
      peopleById: new Map(livingPeople.map((person) => [String(person?.id ?? ""), person])),
      occupiedAll: manager._assignedWorkerSet?.(holding) ?? new Set(),
      crewIndexById,
      contributionCache: new Map()
    };
  }

  _crewContributionDetail(manager, person, suitable, renderContext) {
    const key = `${String(person?.id ?? "")}|${suitable.join(",")}`;
    if (!renderContext?.contributionCache?.has(key)) {
      renderContext?.contributionCache?.set(key, manager._constructionContributionDetail(person, suitable));
    }
    return renderContext?.contributionCache?.get(key) ?? manager._constructionContributionDetail(person, suitable);
  }

  _crewSlots(holding, manager, crew, renderContext = null) {
    renderContext = renderContext ?? this._crewRenderContext(holding, manager);
    const ids = Array.isArray(crew?.memberIds) ? [...crew.memberIds] : [];
    while (ids.length && !ids[ids.length - 1]) ids.pop();
    ids.push("");
    const people = renderContext.livingPeople;
    const peopleById = renderContext.peopleById;
    const chosen = new Set(ids.filter(Boolean));
    const occupiedBuildings = renderContext.occupiedAll;
    const suitable = splitList(crew?.suitableWorkerTypes).map((item) => item.toLowerCase());
    return ids.map((selectedId, slot) => {
      const rawSelectedId = String(selectedId ?? "");
      const selectedPerson = peopleById.get(rawSelectedId);
      selectedId = selectedPerson ? rawSelectedId : "";
      const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
      for (const person of people) {
        const id = String(person.id ?? "");
        const unavailable = (chosen.has(id) && id !== selectedId) || (occupiedBuildings.has(id) && id !== selectedId) || !(manager._canResidentWork?.(person) ?? true);
        if (unavailable) continue;
        const detail = this._crewContributionDetail(manager, person, suitable, renderContext);
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
    const updated = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(false);
      foundry.utils.setProperty(data, scopedPath, value);
      return true;
    }, { reason: "crew-editor:field-change" });
    if (!updated) return;
    this.requestRender();
  }

  async _onCrewSlotChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const slot = Number(event.currentTarget?.dataset?.crewSlot);
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    if (!Number.isFinite(slot) || !crewId) return;
    const value = String(event.currentTarget?.value ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const updated = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      manager._setCrewSlot(holding, crewId, slot, value);
      return true;
    }, { fallback: false, reason: "crew-editor:set-slot" });
    if (!updated) return;
    this.requestRender();
  }

  async _onAddCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const added = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!Array.isArray(holding.constructionCrews)) holding.constructionCrews = [];
      holding.constructionCrews.push({ id: makeId("crew"), name: `Стройбригада ${holding.constructionCrews.length + 1}`, memberIds: [], leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец", distributed: false, distributedIds: [] });
      return true;
    }, { fallback: false, reason: "crew-editor:add-crew" });
    if (!added) return;
    this.requestRender();
  }

  async _onDeleteCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const result = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!holding || !Array.isArray(holding.constructionCrews) || holding.constructionCrews.length <= 1) {
        return SkyholdData.skipTransaction({ ok: false, message: "Нельзя удалить последнюю стройбригаду." });
      }
      const crew = holding.constructionCrews.find((item) => String(item.id) === crewId);
      for (const id of crew?.memberIds ?? []) manager._setPersonFree(holding, id);
      holding.constructionCrews = holding.constructionCrews.filter((item) => String(item.id) !== crewId);
      return { ok: true };
    }, { fallback: false, reason: "crew-editor:delete-crew" });
    if (!result?.ok) {
      if (result?.message) ui.notifications.warn(result.message);
      return;
    }
    this.requestRender();
  }
  async _onSuitableTypeAddChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const field = event.currentTarget;
    const path = field.dataset.suitableTypeAddField;
    const value = String(field.value ?? "").trim();
    if (!path || !value) return;
    const updated = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(false);
      const list = splitList(foundry.utils.getProperty(data, scopedPath));
      if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
      foundry.utils.setProperty(data, scopedPath, joinList(list));
      return true;
    }, { reason: "crew-editor:add-suitable-type" });
    if (!updated) return;
    this.requestRender();
  }

  async _onRemoveSuitableType(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const path = event.currentTarget?.dataset?.suitableTypesField;
    const value = String(event.currentTarget?.dataset?.suitableType ?? "").trim().toLowerCase();
    if (!path || !value) return;
    const updated = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(false);
      const list = splitList(foundry.utils.getProperty(data, scopedPath)).filter((item) => item.toLowerCase() !== value);
      foundry.utils.setProperty(data, scopedPath, joinList(list));
      return true;
    }, { reason: "crew-editor:remove-suitable-type" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDistributeCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const distributed = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      const crew = holding?.constructionCrews?.find((item) => String(item.id) === crewId);
      if (!holding || !crew) return SkyholdData.skipTransaction(false);
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
      return true;
    }, { fallback: false, reason: "crew-editor:distribute-crew" });
    if (!distributed) return;
    this.requestRender();
  }

  async _onReturnCrew(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    const returned = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      const crew = holding?.constructionCrews?.find((item) => String(item.id) === crewId);
      if (!holding || !crew) return SkyholdData.skipTransaction(false);
      const ids = [...(crew.distributedIds ?? [])].filter(Boolean);
      crew.memberIds = [];
      for (const id of ids) manager._setCrewSlot(holding, crew.id, crew.memberIds.length, id);
      crew.distributedIds = [];
      crew.distributed = false;
      return true;
    }, { fallback: false, reason: "crew-editor:return-crew" });
    if (!returned) return;
    this.requestRender();
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
    bindInputGuards(root);
  }

  _bindGlobalInputGuard(root) {
    bindGlobalInputGuard(this, root);
  }

  _unbindGlobalInputGuard() {
    unbindGlobalInputGuard(this);
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
