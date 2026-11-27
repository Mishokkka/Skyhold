import { FloatingTooltipsMixin } from "../common/floating-tooltip.js";
import { DisclosureState } from "../common/disclosure-state.js";
import { selectionSummary } from "../common/selection-summary.js";
import { PendingFieldSavesMixin } from "../common/pending-field-saves.js";
import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { canReadResident, findReadableHoldingEntry, hiddenBuildingIds, residentHasHiddenWork } from "../../data/access-guard.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { droppedLocksForAllocationChange } from "../../data/labor-mutations.js";
import { escapeHtml, fieldValue, joinList, splitList } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { getSkyholdManager, requestSkyholdAppRender } from "../registry.js";
import { bindDelegatedActions, dispatchDelegatedAction, unbindDelegatedActions } from "../common/delegated-events.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { CONSTRUCTION_DICE_FIELDS, CONSTRUCTION_TRAIT_KEYS, normalizeConstructionDiceRules } from "../../engines/workers/construction-dice.js";
import { rememberApplicationFocusReturn, restoreApplicationFocus } from "../common/window-focus-keeper.js";

import { traitOptions } from "../../generators/trait-definitions.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const CREW_EDITOR_NO_HOLDING_MESSAGE = "Владение не найдено или недоступно.";
const lockKeyOf = (row) => `${row.personId}::${row.sourceId}::${row.functionId}`;
const crewReturnIds = (crew) => new Set([...(crew.distributedIds ?? []), crew.distributedLeaderId].map((id) => String(id ?? "")).filter(Boolean));
const privateCrewAssignments = (holding, ids) => {
  const hidden = hiddenBuildingIds(holding, false);
  return [...ids].some((id) => {
    const person = holding.people?.list?.find((row) => String(row.id) === id);
    return person && (!canReadResident(person, { isGM: false }) || residentHasHiddenWork(holding, person, hidden));
  });
};
const crewLockDenial = (locks) => locks.some((row) => row.visibility === "gm")
  ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
  : "У части участников бригады есть закреплённые назначения. Сначала снимите закрепления в общем плане работ.";
const CREW_EDITOR_ACTIONS = {
  "remove-construction-trait": "_onRemoveConstructionTrait",
  "reset-construction-rules": "_onResetConstructionRules",
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

export class SkyholdCrewEditor extends FloatingTooltipsMixin(PendingFieldSavesMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
    this._rulesOpen = false;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const { holding, index: holdingIndex } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
    const canEdit = this._canEditCrew(holding);
    if (!holding) {
      return { ...context, canEdit: false, holding: null, holdingIndex: -1, hasHolding: false, error: CREW_EDITOR_NO_HOLDING_MESSAGE, crews: [], hasCrews: false };
    }
    const manager = getActiveSkyholdManager();
    const rules = normalizeConstructionDiceRules(holding?.gm?.constructionDiceRules);
    const ruleFields = CONSTRUCTION_DICE_FIELDS.filter((field) => !Object.hasOwn(CONSTRUCTION_TRAIT_KEYS, field.key)).map((field) => ({ ...field, value: rules[field.key] }));
    const ruleGroups = [
      { title: "Труд одного человека", icon: "fa-solid fa-hammer", description: "Одинаково для рабочего и руководителя. Бонусы типа складываются с базой.", keys: ["base", "professional", "suitable", "cap"], types: true },
      { title: "Черты человека", icon: "fa-solid fa-user-gear", description: "Каждая имеющаяся черта применяется один раз. Результат входит в личный предел.", keys: [], traits: true },
      { title: "Бонус на всю бригаду", icon: "fa-solid fa-people-group", description: "Добавляется к сумме труда всех участников, после личных ограничений.", keys: ["coordination"], team: true }
    ].map((group) => ({ ...group, fields: group.keys.map((key) => ruleFields.find((field) => field.key === key)) }));
    const ruleContext = {
      canEditRules: Boolean(game.user?.isGM),
      rulesOpen: this._rulesOpen,
      rules,
      ruleFields,
      ruleGroups,
      traitRules: rules.traitRules.map((row) => ({ ...row, key: `trait:${row.name}` })),
      availableTraits: traitOptions(rules.traitRules.map((row) => row.name)).filter((row) => !row.selected),
      crewModifier: manager?._gmEfficiencyModifiers?.(holding)?.constructionCrew ?? Number(holding?.gm?.efficiencyModifiers?.constructionCrew ?? 0)
    };
    if (!manager) return { ...context, ...ruleContext, canEdit, holding, holdingIndex, hasHolding: true, error: "", crews: [], hasCrews: false };
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
        suitableSelection: selectionSummary(splitList(crew.suitableWorkerTypes), "Не заданы"),
        hasSuitableTypeBadges: splitList(crew.suitableWorkerTypes).length > 0,
        leaderOptions: [{ id: "", name: "Нет руководителя", selected: !crew.leaderId, disabled: false }, ...leaderPeople.map((person) => {
          const qualification = manager._constructionLeaderQualification(person);
          return {
            id: person.id,
            name: person.name || "Без имени",
            selected: String(person.id) === String(crew.leaderId),
            disabled: !qualification.eligible,
            hint: qualification.reason
          };
        })],
        slots: this._crewSlots(holding, manager, crew, renderContext)
      };
    });
    return { ...context, ...ruleContext, canEdit, holding, holdingIndex, hasHolding: true, error: "", crews, hasCrews: crews.length > 0 };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._selectionDisclosures ??= new DisclosureState();
    this._selectionDisclosures.bind(root);
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    root.querySelector("[data-construction-rules]")?.addEventListener("toggle", (event) => { this._rulesOpen = event.currentTarget.open; });
    root.querySelector("[data-construction-trait-add]")?.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.currentTarget, "_onAddConstructionTrait"));
    root.querySelectorAll("[data-construction-rule]").forEach((field) => field.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.currentTarget, "_onConstructionRuleChange")));
    root.querySelectorAll("[data-field]").forEach((field) => field.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.currentTarget, "_onFieldChange")));
    root.querySelectorAll("[data-crew-slot]").forEach((field) => field.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.currentTarget, "_onCrewSlotChange")));
    root.querySelectorAll("[data-suitable-type-add-field]").forEach((field) => field.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.currentTarget, "_onSuitableTypeAddChange")));
    bindDelegatedActions(this, root, CREW_EDITOR_ACTIONS);
  }

  async _onClose(options) {
    this._selectionDisclosures?.close();
    await super._onClose(options);
    unbindDelegatedActions(this);
    this._unbindGlobalInputGuard();
    requestSkyholdAppRender();
  }

  _canEditCrew(holding = null) {
    const data = SkyholdData.view();
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
    const eligiblePeople = livingPeople.filter((person) => !(manager._isResidentInjured?.(person)) && (manager._canResidentWork?.(person, holding) ?? true));
    const crewIndexById = new Map((holding?.constructionCrews ?? []).map((crew, index) => [String(crew?.id ?? ""), index]));
    return {
      livingPeople,
      eligiblePeople,
      peopleById: new Map(livingPeople.map((person) => [String(person?.id ?? ""), person])),
      occupiedAll: manager._assignedWorkerSet?.(holding) ?? new Set(),
      crewIndexById,
      rules: normalizeConstructionDiceRules(holding?.gm?.constructionDiceRules),
      contributionCache: new Map()
    };
  }

  _crewContributionDetail(manager, person, suitable, renderContext) {
    const key = `${String(person?.id ?? "")}|${suitable.join(",")}`;
    if (!renderContext?.contributionCache?.has(key)) {
      renderContext?.contributionCache?.set(key, manager._constructionContributionDetail(person, suitable, renderContext.rules));
    }
    return renderContext?.contributionCache?.get(key) ?? manager._constructionContributionDetail(person, suitable, renderContext?.rules);
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
        const unavailable = (chosen.has(id) && id !== selectedId) || (occupiedBuildings.has(id) && id !== selectedId) || !(manager._canResidentWork?.(person, holding) ?? true);
        if (unavailable) continue;
        const detail = this._crewContributionDetail(manager, person, suitable, renderContext);
        options.push({ id, name: person.name || "Без имени", selected: id === selectedId, disabled: false, hint: `${manager._workerType(person)} · ${detail.dice}к6` });
      }
      return { crewId: crew.id, slot, slotNo: slot + 1, selectedId, label: selectedPerson?.name ?? "Пусто", options };
    });
  }

  async _refreshConstructionRules() {
    const active = globalThis.document?.activeElement;
    const restore = active && this.element?.contains(active);
    if (restore) rememberApplicationFocusReturn(this, active);
    await this.requestRender();
    const current = globalThis.document?.activeElement;
    if (restore && (!current || current === globalThis.document?.body || current === active)) {
      restoreApplicationFocus(this, { root: this.element });
    }
  }

  async _onConstructionRuleChange(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const field = event.currentTarget;
    const key = String(field.dataset.constructionRule ?? "");
    const traitName = key.startsWith("trait:") ? key.slice(6) : "";
    const definition = traitName ? { min: -20, max: 20 } : CONSTRUCTION_DICE_FIELDS.find((item) => item.key === key && !Object.hasOwn(CONSTRUCTION_TRAIT_KEYS, key));
    if (!definition && key !== "professionalTypes") return;
    const value = definition ? Number(field.value) : String(field.value ?? "");
    if (definition && (!String(field.value).trim() || !Number.isInteger(value) || value < definition.min || value > definition.max)) {
      ui.notifications.warn(`Введите целое число от ${definition.min} до ${definition.max}.`);
      await this._refreshConstructionRules();
      return;
    }
    const updated = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!game.user?.isGM) return SkyholdData.skipTransaction(false);
      holding.gm ??= {};
      const rules = normalizeConstructionDiceRules(holding.gm.constructionDiceRules);
      if (traitName) {
        const row = rules.traitRules.find((item) => item.name === traitName);
        if (!row) return SkyholdData.skipTransaction(false);
        row.dice = value;
      } else rules[key] = value;
      holding.gm.constructionDiceRules = normalizeConstructionDiceRules(rules);
      return true;
    }, { fallback: false, reason: "crew-editor:construction-rules" });
    if (updated) {
      await this._refreshConstructionRules();
      requestSkyholdAppRender();
    }
  }

  async _changeConstructionTrait(name, remove = false) {
    if (!game.user?.isGM || !name) return;
    const updated = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!game.user?.isGM) return SkyholdData.skipTransaction(false);
      const rules = normalizeConstructionDiceRules(holding.gm?.constructionDiceRules);
      const exists = rules.traitRules.some((row) => row.name.toLowerCase() === name.toLowerCase());
      if (remove) {
        if (!exists) return SkyholdData.skipTransaction(false);
        rules.traitRules = rules.traitRules.filter((row) => row.name.toLowerCase() !== name.toLowerCase());
      } else {
        if (exists || rules.traitRules.length >= 100 || !traitOptions().some((row) => row.name === name)) return SkyholdData.skipTransaction(false);
        rules.traitRules.push({ name, dice: 1 });
      }
      holding.gm ??= {};
      holding.gm.constructionDiceRules = rules;
      return true;
    }, { fallback: false, reason: "crew-editor:construction-trait" });
    if (updated) {
      await this._refreshConstructionRules();
      requestSkyholdAppRender();
    }
  }

  async _onAddConstructionTrait(event) {
    event.preventDefault();
    await this._changeConstructionTrait(String(event.currentTarget.value ?? "").trim());
  }

  async _onRemoveConstructionTrait(event) {
    event.preventDefault();
    await this._changeConstructionTrait(String(event.currentTarget.dataset.traitName ?? "").trim(), true);
  }

  async _onResetConstructionRules(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const updated = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!game.user?.isGM) return SkyholdData.skipTransaction(false);
      if (holding.gm) delete holding.gm.constructionDiceRules;
      return true;
    }, { fallback: false, reason: "crew-editor:reset-construction-rules" });
    if (updated) {
      await this._refreshConstructionRules();
      requestSkyholdAppRender();
    }
  }

  async _onFieldChange(event) {
    event.preventDefault();
    if (!this._canEditCrew()) return;
    const field = event.currentTarget;
    const path = field.dataset.field;
    if (!path) return;
    const value = fieldValue(field);
    const manager = path.endsWith(".leaderId") ? getActiveSkyholdManager({ warn: true }) : null;
    if (path.endsWith(".leaderId") && !manager) return;
    const updated = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(false);
      const leaderMatch = scopedPath.match(/^holdings\.(\d+)\.constructionCrews\.(\d+)\.leaderId$/);
      if (leaderMatch) {
        const holding = data.holdings[Number(leaderMatch[1])];
        const crew = holding?.constructionCrews?.[Number(leaderMatch[2])];
        if (!holding || !crew) return SkyholdData.skipTransaction(false);
        return manager._setCrewLeader(holding, crew.id, value);
      }
      foundry.utils.setProperty(data, scopedPath, value);
      return true;
    }, { reason: "crew-editor:field-change", scope: "holdings" });
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
    const crew = SkyholdData.view().holdings.find((row) => row.id === this.holdingId)?.constructionCrews?.find((row) => row.id === crewId);
    if (!crew || !await manager._confirmAction("Удалить стройбригаду", `Удалить «${escapeHtml(crew.name)}»? Участники будут освобождены от назначений.`)) return;
    const result = await SkyholdData.updateHolding(this.holdingId, (holding) => {
      if (!holding || !Array.isArray(holding.constructionCrews) || holding.constructionCrews.length <= 1) {
        return SkyholdData.skipTransaction({ ok: false, message: "Нельзя удалить последнюю стройбригаду." });
      }
      const crew = holding.constructionCrews.find((item) => String(item.id) === crewId);
      const participantIds = new Set([String(crew?.leaderId ?? ""), ...(crew?.memberIds ?? []).map((id) => String(id ?? ""))].filter(Boolean));
      for (const id of participantIds) manager._setPersonFree(holding, id);
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
    }, { reason: "crew-editor:add-suitable-type", scope: "holdings" });
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
    }, { reason: "crew-editor:remove-suitable-type", scope: "holdings" });
    if (!updated) return;
    this.requestRender();
  }

  async _onDistributeCrew(event) {
    event.preventDefault();
    if (this._crewMoveBusy || !this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    this._crewMoveBusy = true;
    try {
      const distributed = await SkyholdData.updateHolding(this.holdingId, (holding) => {
        const crew = holding?.constructionCrews?.find((item) => String(item.id) === crewId);
        if (!holding || !crew || crew.distributed) return SkyholdData.skipTransaction(false);
        const leaderId = String(crew.leaderId ?? "");
        const ids = [...new Set([leaderId, ...(crew.memberIds ?? []).map((id) => String(id ?? ""))].filter(Boolean))];
        crew.memberIds = [];
        crew.leaderId = "";
        crew.distributedIds = [];
        crew.distributedLeaderId = "";
        const hidden = hiddenBuildingIds(holding, game.user?.isGM === true);
        for (const id of ids) {
          let placed = false;
          for (const building of holding.buildings?.list ?? []) {
            if (hidden.has(String(building.id)) || manager._buildingStatus(building).value !== "built") continue;
            if (manager._assignPersonToBuilding?.(holding, id, building.id, { replace: true })) { placed = true; break; }
          }
          if (!placed) manager._setPersonFree(holding, id);
        }
        const currentCrew = holding.constructionCrews?.find((item) => String(item.id) === crewId);
        if (!currentCrew) return SkyholdData.skipTransaction(false);
        currentCrew.distributedLeaderId = leaderId;
        currentCrew.distributedIds = ids;
        currentCrew.distributed = true;
        return true;
      }, { fallback: false, reason: "crew-editor:distribute-crew" });
      if (!distributed) return;
      this.requestRender();
    } catch (error) {
      ui.notifications?.warn?.(error?.message || "Не удалось распределить бригаду.");
      this.requestRender();
    } finally {
      this._crewMoveBusy = false;
    }
  }

  async _onReturnCrew(event) {
    event.preventDefault();
    if (this._crewMoveBusy || !this._canEditCrew()) return;
    const crewId = String(event.currentTarget?.dataset?.crewId ?? "");
    const manager = getActiveSkyholdManager({ warn: true });
    if (!manager) return;
    this._crewMoveBusy = true;
    try {
      const isGM = game.user?.isGM === true;
      const { holding: previewHolding } = findReadableHoldingEntry(SkyholdData.get(), this.holdingId, { fallback: false });
      const previewCrew = previewHolding?.constructionCrews?.find((item) => String(item.id) === crewId);
      if (previewCrew?.distributed !== true) return;
      const previewIds = crewReturnIds(previewCrew);
      if (!isGM && privateCrewAssignments(previewHolding, previewIds)) {
        ui.notifications?.warn?.("Назначение недоступно. Обновите окно или обратитесь к ГМу.");
        return;
      }
      const dropped = [...previewIds].flatMap((id) => droppedLocksForAllocationChange(previewHolding, id, []));
      if (dropped.length) {
        if (!isGM) {
          ui.notifications?.warn?.(crewLockDenial(dropped));
          return;
        }
        if (!await manager._confirmAction?.("Снять закреплённые назначения",
          "Возврат бригады снимет закреплённые назначения её участников в общем плане работ. Продолжить?")) return;
      }
      const confirmedLockKeys = new Set(dropped.map(lockKeyOf));
      let deniedMessage = "";
      const returned = await SkyholdData.updateHolding(this.holdingId, (holding) => {
        const getCrew = () => holding?.constructionCrews?.find((item) => String(item.id) === crewId);
        const crew = getCrew();
        if (crew?.distributed !== true) return SkyholdData.skipTransaction(false);
        const ids = [...new Set((crew.distributedIds ?? []).map((id) => String(id ?? "")).filter(Boolean))];
        const leaderId = String(crew.distributedLeaderId ?? "");
        const returnIds = crewReturnIds(crew);
        if (returnIds.size !== previewIds.size || [...returnIds].some((id) => !previewIds.has(id))) {
          deniedMessage = "Состав бригады изменился. Обновите окно и повторите возврат.";
          return SkyholdData.skipTransaction(false);
        }
        if (!isGM && privateCrewAssignments(holding, returnIds)) {
          deniedMessage = "Назначение недоступно. Обновите окно или обратитесь к ГМу.";
          return SkyholdData.skipTransaction(false);
        }
        const innerDropped = [...returnIds].flatMap((id) => droppedLocksForAllocationChange(holding, id, []));
        if (innerDropped.some((row) => !confirmedLockKeys.has(lockKeyOf(row)))) {
          deniedMessage = isGM ? "Закрепления изменились. Обновите окно и подтвердите возврат ещё раз." : crewLockDenial(innerDropped);
          return SkyholdData.skipTransaction(false);
        }
        crew.memberIds = [];
        for (const id of ids) {
          const currentCrew = getCrew();
          if (!currentCrew || !manager._setCrewSlot(holding, crewId, currentCrew.memberIds.length, id)) {
            deniedMessage = "Не удалось вернуть участника в бригаду. Обновите окно или обратитесь к ГМу.";
            return SkyholdData.skipTransaction(false);
          }
        }
        if (leaderId && !manager._setCrewLeader(holding, crewId, leaderId)) {
          deniedMessage = "Не удалось вернуть руководителя в бригаду. Обновите окно или обратитесь к ГМу.";
          return SkyholdData.skipTransaction(false);
        }
        const currentCrew = getCrew();
        if (!currentCrew) return SkyholdData.skipTransaction(false);
        const locks = holding.workforcePlan?.locks;
        if (Array.isArray(locks)) {
          const droppedKeys = new Set(innerDropped.map(lockKeyOf));
          holding.workforcePlan.locks = locks.filter((row) => !droppedKeys.has(lockKeyOf(row)));
        }
        currentCrew.distributedIds = [];
        currentCrew.distributedLeaderId = "";
        currentCrew.distributed = false;
        return true;
      }, { fallback: false, reason: "crew-editor:return-crew" });
      if (!returned) {
        if (deniedMessage) ui.notifications?.warn?.(deniedMessage);
        return;
      }
      this.requestRender();
    } catch (error) {
      ui.notifications?.warn?.(error?.message || "Не удалось вернуть бригаду.");
      this.requestRender();
    } finally {
      this._crewMoveBusy = false;
    }
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
