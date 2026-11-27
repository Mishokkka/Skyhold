// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData, requestShipOperation, requestWorkforceOperation } from "../../../data/store.js";
import { buildResidentAllocationRemovalCommand } from "../../../data/workforce-socket.js";
import { findReadableHoldingEntry, hiddenBuildingIds, residentHasHiddenWork } from "../../../data/access-guard.js";
import { addCollectionRow, deleteCollectionRow } from "../../../data/collection-operations.js";
import { holdingPermissionContext } from "../../../data/holding-permissions.js";
import { isPlayerWritablePath } from "../../../data/player-write-guard.js";
import { stableDataHash } from "../../../data/storage-commit.js";
import { isPublicSpecialNote } from "../../../core/special-effects.js";
import { normalizeBelief } from "../../../generators/resident-rules.js";
import { createSafeIcon, escapeHtml, fieldValue } from "../../../core/helpers.js";
import { makeId } from "../../../data/utils.js";
import { isResidentAway, isResidentRestingOnShip, shipForResident } from "../../../data/resident-presence.js";
import { buildWorkAllocationTargets, MAX_WORK_ALLOCATIONS_PER_PERSON, parseWorkAllocationTargetKey, validateHoldingWorkAllocations } from "../../../data/work-allocations.js";
import { loadResidentEditorClass } from "../../lazy-apps.js";
import { rememberApplicationFocusReturn } from "../../common/window-focus-keeper.js";
import { syncSelectionSummary } from "../../common/selection-summary.js";
import { residentTraitTooltip } from "../../common/resident-trait-chips.js";
import { confirmBuildingWorkerAdmission } from "../../common/building-worker-admission.js";
import { vacatePoliticsRepresentative } from "../../../data/resident-assignments.js";
import { applyResidentEditorAllocations, droppedLocksForAllocationChange, transferResidentBetweenHoldings } from "../../../data/labor-mutations.js";
import { lockedAllocationChangeError, workforceIssueMessage, workforcePlan } from "../../../data/workforce-plan.js";
import { newLaborIssues, residentLaborUnavailableReason } from "../../../data/labor-model.js";
import { holdingWorkerAdmissionIssues } from "../../../engines/workers/building-qualification.js";
import { normalizePerson } from "../../../data/normalizers/resident.js";

function safeWorkforceError(holding, check, fallback = "Некорректный план рабочих QD.") {
  return check?.orphanedOvertime
    ? check.message
    : (workforceIssueMessage(holding, check?.issues?.[0], { isGM: Boolean(game.user?.isGM) }) || check?.message || fallback);
}

const RESIDENT_CONTEXT_MENU_WIDTH = 230;
const RESIDENT_CONTEXT_MENU_HEIGHT = 150;

function residentAddress(element) {
  const { holdingId, residentId, id } = element?.dataset ?? {};
  return { holdingId, personId: residentId ?? id };
}

function residentScope(data, { holdingId, personId }) {
  const { holding, index: holdingIndex } = findReadableHoldingEntry(data, holdingId);
  const people = holding?.people?.list ?? [];
  const matches = personId ? people.filter((person) => String(person?.id ?? "") === personId) : [];
  const person = matches.length === 1 ? matches[0] : null;
  return { holding, holdingIndex, person, personIndex: person ? people.indexOf(person) : -1 };
}

function residentScopedPath(scope, path) {
  const field = residentFieldPath(path);
  return field && scope.person ? `holdings.${scope.holdingIndex}.people.list.${scope.personIndex}.${field}` : "";
}

function residentFieldPath(path) {
  return String(path ?? "").match(/^holdings\.\d+\.people\.list\.\d+\.(.+)$/)?.[1] ?? "";
}

export function canWriteResidentEditorField(data, scope, permissions, path) {
  const field = residentFieldPath(path);
  const scopedPath = residentScopedPath(scope, path);
  if (!scopedPath) return false;
  if (permissions.isGM) return true;
  if (/^(home|role|workAssignment|workAllocations)(?:\.|$)/.test(field) && !permissions.canEditBuildings) return false;
  return isPlayerWritablePath(scopedPath, data, data);
}

const editorDraftSources = new WeakMap();

export function captureResidentEditorDraft(editor, person) {
  if (!editor || !person) return;
  const fields = [...editor.querySelectorAll("[data-field]"), ...editor.querySelectorAll("[data-work-allocation-target]")];
  const work = editor.querySelector("[data-work-assignment-field]");
  if (work) fields.push(work);
  editorDraftSources.set(editor, { person: structuredClone(person), fields: new Map(fields.map((field) => [field, fieldValue(field)])) });
}

function residentDraftValue(person, path) {
  if (path === "workAssignment") return String(person?.workAssignment ?? "");
  return path.split(".").reduce((value, key) => value?.[key], person);
}

function resolveResidentDraftUpdate(update, renderedPerson, person) {
  const renderedField = residentFieldPath(update.path);
  const allocation = /^workAllocations\.(\d+)\.(.+)$/.exec(renderedField);
  let field = renderedField;
  if (allocation) {
    const id = renderedPerson.workAllocations?.[Number(allocation[1])]?.id;
    const rows = person.workAllocations ?? [];
    const matching = id ? rows.filter((row) => row.id === id) : [];
    if (matching.length !== 1) return null;
    field = `workAllocations.${rows.indexOf(matching[0])}.${allocation[2]}`;
  }
  const before = residentDraftValue(renderedPerson, renderedField);
  const current = residentDraftValue(person, field);
  if (!field || (!Object.is(before, current) && !Object.is(update.value, current))) return null;
  return { ...update, renderedField, field, path: update.path.slice(0, -renderedField.length) + field };
}

function keepsCrewLeadership(holding, person, value) {
  if (!value.startsWith("construction-leader:") || String(person.workAssignment ?? "") !== value) return false;
  const crewId = value.slice("construction-leader:".length);
  return (holding.constructionCrews ?? []).some((crew) => String(crew.id) === crewId && String(crew.leaderId ?? "") === String(person.id));
}

function droppedLocksForWorkAssignmentChange(holding, person, value = "") {
  if (!holding || !person || keepsCrewLeadership(holding, person, value)) return [];
  const nextValue = String(value ?? "");
  const targetBuilding = (holding.buildings?.list ?? []).find((row) => String(row.id) === nextValue);
  if (targetBuilding) {
    const target = buildWorkAllocationTargets(holding).find((row) => row.sourceId === nextValue && row.available);
    return droppedLocksForAllocationChange(holding, person.id, target
      ? [{ sourceId: nextValue, functionId: target.functionId, normalQd: 1, overtimeQd: 0 }]
      : []);
  }
  return droppedLocksForAllocationChange(holding, person.id, []);
}

const lockKeyOf = (row) => `${row?.personId ?? ""}::${row?.sourceId ?? ""}::${row?.functionId ?? ""}`;
const hasUnconfirmedLocks = (dropped, confirmedKeys) => dropped.some((row) => !confirmedKeys.has(lockKeyOf(row)));

function pruneInactiveResidentLocks(holding, personId) {
  if (!Array.isArray(holding?.workforcePlan?.locks)) return;
  const dropped = droppedLocksForAllocationChange(holding, personId,
    (holding.people?.list ?? []).find((row) => String(row?.id ?? "") === String(personId))?.workAllocations ?? []);
  if (!dropped.length) return;
  const droppedSet = new Set(dropped.map((row) => `${row.personId}::${row.sourceId}::${row.functionId}`));
  holding.workforcePlan.locks = holding.workforcePlan.locks.filter((row) =>
    !droppedSet.has(`${row.personId}::${row.sourceId}::${row.functionId}`));
}

function clearRecoveredResidentStatus(person = {}) {
  if (Math.max(0, Number(person?.injuredDays ?? 0) || 0) > 0) return;
  if (/ранен|тяжело|сломлен|injured|wound/i.test(String(person?.status ?? ""))) person.status = "";
  if (person.battleCondition) person.battleCondition = "";
}

function createResidentContextMenuButton(item = {}) {
  const button = document.createElement("button");
  button.type = "button";
  if (item.danger) button.classList.add("danger");
  button.dataset.action = String(item.action ?? "");
  const text = document.createElement("span");
  text.textContent = String(item.label ?? "");
  button.append(createSafeIcon(item.icon), text);
  return button;
}

export const ResidentEventActions = {
  click: {
    "crew-shore-duty": "_onCrewShoreDuty",
    "remove-trait": "_onRemoveTrait",
    "add-work-allocation": "_onAddWorkAllocation",
    "remove-work-allocation": "_onRemoveWorkAllocation",
    "transfer-resident": "_onTransferResident",
    "add-row": "_onAddRow",
    "delete-row": "_onDeleteRow",
    "toggle-person-dead": "_onTogglePersonDead",
    "close-person-editor": "_onClosePersonEditor",
    "generate-residents": "_onGenerateResidents",
    "accept-generated-residents": "_onAcceptGeneratedResidents",
    "clear-generated-residents": "_onClearGeneratedResidents",
    "toggle-generated-person-editor": "_onToggleGeneratedPersonEditor"
  },
  publicClick: []
};

export const ResidentEventDomain = {
async _onCrewShoreDuty(event, type = "shore-duty") {
  event.preventDefault();
  if (!this._canManagePeople()) return;
  const button = event.currentTarget;
  const { residentId, shipId, holdingId, revision } = button.dataset;
  if (!residentId || !shipId || !holdingId) return;
  if (!["shore-duty", "return-to-ship"].includes(type)) return;
  const returning = type === "return-to-ship";
  const key = `${type}:${holdingId}:${shipId}:${residentId}`;
  this._shoreDutyBusy ??= new Set();
  this._shoreDutyRetries ??= new Map();
  if (this._shoreDutyBusy.has(key)) return;
  const operation = this._shoreDutyRetries.get(key) ?? {
    type, operationId: makeId(type, 20),
    holdingId, shipId, residentId, expectedRevision: Number(revision)
  };
  this._shoreDutyRetries.set(key, operation);
  this._shoreDutyBusy.add(key);
  button.disabled = true;
  try {
    await requestShipOperation(operation);
    this._shoreDutyRetries.delete(key);
    this.activePeopleTab = returning ? "ship-crew" : "living";
    ui.notifications.info(returning
      ? "Моряк вернулся на корабль. Работа и жильё освобождены."
      : "Моряк переведён в жители. Назначьте ему работу и жильё обычным способом.");
    this.requestRender();
  } catch (error) {
    if (!error.retryable || error.code === "conflict") this._shoreDutyRetries.delete(key);
    ui.notifications.error(error.message || "Не удалось изменить размещение моряка.");
    this.requestRender();
  } finally {
    this._shoreDutyBusy.delete(key);
    button.disabled = false;
  }
},

async _workAssignmentAdmissionDecision(data, path, value, personOverride = null) {
  const parts = path.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
  if (!parts) return { allowed: true, allowAdmissionOverride: false };
  const holding = data?.holdings?.[Number(parts[1])];
  const person = personOverride ?? holding?.people?.list?.[Number(parts[2])];
  const building = (holding?.buildings?.list ?? []).find((row) => String(row?.id ?? "") === String(value ?? ""));
  if (!holding || !person || !building) return { allowed: true, allowAdmissionOverride: false };
  return confirmBuildingWorkerAdmission({ manager: this, building, person });
},

async _onWorkAssignmentChange(event) {
  event.preventDefault();
  const field = event.currentTarget;
  const address = residentAddress(field.closest?.(".fbls-person-row"));
  const data = SkyholdData.get();
  const source = residentScope(data, address);
  const path = residentScopedPath(source, field.dataset.workAssignmentField);
  if (!path || !holdingPermissionContext(source.holding).canEditBuildings) return;
  const value = String(field.value ?? "");
  const hidden = hiddenBuildingIds(source.holding);
  if (hidden.has(value) || residentHasHiddenWork(source.holding, source.person, hidden)) {
    this.requestRender();
    return ui.notifications.warn("Назначение недоступно.");
  }
  const expected = stableDataHash(source.person);
  const building = source.holding.buildings?.list?.find((row) => String(row.id) === value);
  const expectedBuilding = stableDataHash(building);
  const isGM = Boolean(game.user?.isGM);
  const droppedLocks = droppedLocksForWorkAssignmentChange(source.holding, source.person, value);
  const confirmedLockKeys = new Set(droppedLocks.map(lockKeyOf));
  if (droppedLocks.length) {
    if (!isGM) {
      ui.notifications.warn(droppedLocks.some((row) => row.visibility === "gm")
        ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
        : "Закреплённое назначение нельзя заменить здесь. Сначала снимите закрепление в общем плане работ или удалите строку плана.");
      this.requestRender();
      return;
    }
    if (!await this._confirmAction("Снять закреплённое назначение",
      "Смена места работы заменит текущие назначения и снимет их закрепление в общем плане работ. Продолжить?")) {
      this.requestRender();
      return;
    }
  }
  try {
    const decision = await this._workAssignmentAdmissionDecision(data, path, value);
    if (!decision.allowed) {
      this.requestRender();
      return;
    }
    const result = await SkyholdData.transaction((draft) => {
      const { holding, person } = residentScope(draft, address);
      const targetBuilding = holding?.buildings?.list?.find((row) => String(row.id) === value);
      const hidden = hiddenBuildingIds(holding);
      if (!person || !holdingPermissionContext(holding).canEditBuildings || stableDataHash(person) !== expected
        || stableDataHash(targetBuilding) !== expectedBuilding || hidden.has(value) || residentHasHiddenWork(holding, person, hidden)) {
        return SkyholdData.skipTransaction({ stale: true });
      }
      if (keepsCrewLeadership(holding, person, value)) return SkyholdData.skipTransaction(null);
      const innerDropped = droppedLocksForWorkAssignmentChange(holding, person, value);
      if (!game.user?.isGM && innerDropped.length) {
        return SkyholdData.skipTransaction({ warnNoSlot: true });
      }
      if (game.user?.isGM && hasUnconfirmedLocks(innerDropped, confirmedLockKeys)) {
        return SkyholdData.skipTransaction({ stale: true });
      }
      if (targetBuilding) {
        const ok = this._assignPersonToBuilding(holding, person.id, value, { ...decision, replace: true });
        return ok ? { warnNoSlot: false } : SkyholdData.skipTransaction({ warnNoSlot: true });
      }
      if (value && residentLaborUnavailableReason(holding, person)) return SkyholdData.skipTransaction({ warnNoSlot: true });
      this._clearPersonFromAssignments(holding, person.id);
      pruneInactiveResidentLocks(holding, person.id);
      if (!value) {
        person.workAssignment = "";
        this._setPersonFree?.(holding, person.id);
      } else if (value === "soldier") {
        person.workAssignment = "soldier";
        person.role = "Солдат";
      } else if (value === "other") {
        person.workAssignment = "other";
        person.role = String(person.role ?? "") || "Другое";
      } else if (value === "construction" || value.startsWith("construction:")) {
        const crewId = value === "construction" ? this._constructionCrews(holding)[0]?.id : value.split(":")[1];
        if (!this._assignPersonToCrew(holding, person.id, crewId)) return SkyholdData.skipTransaction({ warnNoSlot: true });
      } else return SkyholdData.skipTransaction({ warnNoSlot: true });
      return { warnNoSlot: false };
    }, { reason: "resident:work-assignment", scope: "holdings" });
    if (!result) return;
    if (result.stale) ui.notifications.warn("Житель или место работы изменились. Обновите окно и повторите назначение.");
    if (result.warnNoSlot) ui.notifications.warn("Назначение недоступно. Прежняя работа сохранена.");
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to update work assignment", error);
    ui.notifications.error("Не удалось назначить работу. Подробности в консоли.");
  }
},

_onResidentFilterChange(event) {
  const field = event.currentTarget;
  const key = field?.dataset?.residentFilter;
  if (!key) return;
  this.residentFilters[key] = field.value ?? "";
  if (key === "search") {
    this._applyResidentSearchFilter?.(this.element, this.residentFilters.search);
    return;
  }
  this.requestRender();
},

_onResidentSearchInput(event) {
  const value = String(event.currentTarget?.value ?? "");
  this.residentFilters.search = value;
  this._applyResidentSearchFilter?.(this.element, value);
},

_applyResidentSearchFilter(root = this.element, value = "") {
  const search = String(value ?? "").trim().toLocaleLowerCase("ru");
  const rows = Array.from(root?.querySelectorAll?.(".fbls-person-row[data-resident-search]") ?? []);
  let visible = 0;
  for (const row of rows) {
    const haystack = String(row.dataset.residentSearch ?? row.textContent ?? "").toLocaleLowerCase("ru");
    const show = !search || haystack.includes(search);
    row.hidden = !show;
    const editorRow = row.nextElementSibling?.classList?.contains("fbls-person-edit-row") ? row.nextElementSibling : null;
    if (editorRow) editorRow.hidden = !show;
    if (show) visible += 1;
  }
  const empty = root?.querySelector?.("[data-resident-search-empty]");
  if (empty) empty.hidden = rows.length === 0 || visible > 0;
  return visible;
},

async _onTogglePersonDead(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const id = String(event.currentTarget?.dataset?.id ?? "");
  const holdingId = String(event.currentTarget?.dataset?.holdingId ?? "");
  const dead = String(event.currentTarget?.dataset?.dead ?? "true") !== "false";
  if (!holdingId || !id) return;
  try {
    const updated = await SkyholdData.updateHolding(holdingId, (holding) => {
      const matches = (holding?.people?.list ?? []).filter((row) => String(row.id) === id);
      if (matches.length !== 1) return SkyholdData.skipTransaction(false);
      const [person] = matches;
      if (person.dead === dead) return SkyholdData.skipTransaction(true);
      person.dead = dead;
      person.status = dead ? "Погиб" : "";
      if (dead) person.injuredDays = 0;
      if (dead && !person.deathDate) person.deathDate = new Date().toISOString().slice(0, 10);
      if (!dead) person.deathDate = "";
      if (dead) {
        vacatePoliticsRepresentative(holding, person.id, "представитель погиб");
        this._clearPersonFromAssignments?.(holding, person.id);
        person.home = "";
      }
      return true;
    }, { reason: "resident:toggle-dead" });
    if (!updated) return ui.notifications.warn("Житель недоступен или его ID неоднозначен.");
    if (this.activeHoldingId !== holdingId) return this.requestRender();
    this.activePeopleTab = "living";
    this.activeSpecialTab = dead ? "cemetery" : "records";
    this.activeTab = dead ? "special" : "people";
    this.editingPersonId = null;
    this.expandedPersonId = null;
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to mark resident death state", error);
    ui.notifications.error("Не удалось изменить состояние жителя. Подробности в консоли.");
  }
},

async _onTraitSelectChange(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const field = event.currentTarget;
  const path = field.dataset.traitsField;
  if (!path) return;
  if (!this._canPlayerWriteFieldPath(path)) return;

  const selected = Array.from(field.selectedOptions ?? []).map((option) => option.value).filter(Boolean);

  try {
    const updated = await this._updateActiveHoldingPath(path, selected.join(", "), { reason: "resident:trait-select" });
    if (!updated) return;
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to update resident traits", error);
    ui.notifications.error("Не удалось сохранить черты жителя. Подробности в консоли.");
  }
},

async _onTraitAddChange(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const field = event.currentTarget;
  const path = field.dataset.traitAddField;
  const trait = String(field.value ?? "").trim();
  if (!path || !trait) return;

  const editor = field.closest?.(".fbls-person-editor.v2");
  if (editor) {
    const hidden = editor.querySelector?.("[data-resident-traits-value]");
    const existing = this._parseTraits(hidden?.value ?? "");
    const lowered = new Set(existing.map((item) => item.toLowerCase()));
    if (!lowered.has(trait.toLowerCase())) existing.push(trait);
    if (hidden) hidden.value = existing.join(", ");
    field.value = "";
    this._refreshResidentTraitEditor(editor);
    return;
  }

  try {
    await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const existing = this._parseTraits(foundry.utils.getProperty(data, scopedPath));
      const lowered = new Set(existing.map((item) => item.toLowerCase()));
      if (!lowered.has(trait.toLowerCase())) existing.push(trait);
      foundry.utils.setProperty(data, scopedPath, existing.join(", "));
    }, { reason: "resident:add-trait", scope: "holdings" });
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to add resident trait", error);
    ui.notifications.error("Не удалось добавить черту жителя. Подробности в консоли.");
  }
},

async _onRemoveTrait(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const button = event.currentTarget;
  const trait = String(button.dataset.traitName ?? "").trim().toLowerCase();
  if (!trait) return;

  const editor = button.closest?.(".fbls-person-editor.v2");
  if (editor) {
    const hidden = editor.querySelector?.("[data-resident-traits-value]");
    const filtered = this._parseTraits(hidden?.value ?? "").filter((item) => item.toLowerCase() !== trait);
    if (hidden) hidden.value = filtered.join(", ");
    this._refreshResidentTraitEditor(editor);
    return;
  }

  const path = button.dataset.traitsField;
  if (!path) return;

  try {
    await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const filtered = this._parseTraits(foundry.utils.getProperty(data, scopedPath)).filter((item) => item.toLowerCase() !== trait);
      foundry.utils.setProperty(data, scopedPath, filtered.join(", "));
    }, { reason: "resident:remove-trait", scope: "holdings" });
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to remove resident trait", error);
    ui.notifications.error("Не удалось убрать черту жителя. Подробности в консоли.");
  }
},

_refreshResidentTraitEditor(editor) {
  if (!editor) return;
  const hidden = editor.querySelector?.("[data-resident-traits-value]");
  const list = editor.querySelector?.("[data-resident-trait-list]");
  const select = editor.querySelector?.("[data-trait-add-field]");
  const traits = this._parseTraits(hidden?.value ?? "");
  const lower = new Set(traits.map((item) => item.toLowerCase()));
  const badges = this._traitBadges?.(traits.join(", ")) ?? traits.map((name) => ({ name, description: "" }));
  syncSelectionSummary(editor, badges.map(badge => badge.name), "Черт нет");

  if (list) {
    list.replaceChildren();
    if (!traits.length) {
      const empty = document.createElement("span");
      empty.className = "fbls-muted-text";
      empty.textContent = "Черт нет.";
      list.appendChild(empty);
    } else {
      const path = hidden?.dataset?.field ?? "";
      for (const badge of badges) {
        const chip = document.createElement("span");
        chip.className = "fbls-trait-badge editor-chip fbls-note-tip";
        chip.dataset.fblsTooltip = residentTraitTooltip(badge);
        chip.append(document.createTextNode(badge.name));

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "fbls-chip-remove";
        remove.dataset.action = "remove-trait";
        remove.dataset.traitsField = path;
        remove.dataset.traitName = badge.name;
        remove.title = "Убрать черту";
        remove.setAttribute("aria-label", `Убрать черту ${badge.name}`);
        remove.textContent = "×";
        chip.appendChild(remove);
        list.appendChild(chip);
      }
    }
  }

  if (select) {
    for (const option of Array.from(select.options ?? [])) {
      if (!option.value) {
        option.disabled = false;
        continue;
      }
      const selected = lower.has(String(option.value).toLowerCase());
      option.disabled = selected;
      const cleanLabel = String(option.textContent ?? "").replace(/\s+✓$/, "");
      option.textContent = selected ? `${cleanLabel} ✓` : cleanLabel;
    }
    select.value = "";
  }
},

async _onAddWorkAllocation(event) {
  event.preventDefault();
  const address = residentAddress(event.currentTarget?.closest?.(".fbls-person-editor.v2"));
  if (!address.personId || !this._canEditBuildings()) return;
  try {
    if (!await this._savePersonEditorDraft(event)) return;
    const updated = await SkyholdData.transaction((data) => {
      const { holding, person } = residentScope(data, address);
      if (!person || !holdingPermissionContext(holding).canEditBuildings || residentHasHiddenWork(holding, person)) return SkyholdData.skipTransaction(false);
      if ((person.workAllocations ?? []).length >= MAX_WORK_ALLOCATIONS_PER_PERSON) {
        ui.notifications.warn(`Достигнут лимит строк труда (${MAX_WORK_ALLOCATIONS_PER_PERSON}). Удалите лишние строки плана.`);
        return SkyholdData.skipTransaction(false);
      }
      const check = applyResidentEditorAllocations(holding, person.id, { nextAllocations: [...(person.workAllocations ?? []), {
        schemaVersion: 1,
        id: makeId("work"),
        sourceId: "",
        functionId: "",
        normalQd: 0,
        overtimeQd: 0
      }] });
      if (!check.ok) ui.notifications.warn(safeWorkforceError(holding, check));
      return check.ok || SkyholdData.skipTransaction(false);
    }, { reason: "resident:add-work-allocation", scope: "holdings" });
    if (updated) this.requestRender();
    return Boolean(updated);
  } catch (error) {
    console.error("FBL Skyhold | Failed to add resident work allocation", error);
    ui.notifications.error("Не удалось добавить функцию в план труда. Подробности в консоли.");
    return false;
  }
},

async _onRemoveWorkAllocation(event) {
  event.preventDefault();
  const address = residentAddress(event.currentTarget?.closest?.(".fbls-person-editor.v2"));
  const allocationId = String(event.currentTarget?.dataset?.allocationId ?? "");
  if (!address.personId || !allocationId || !this._canEditBuildings()) return;
  try {
    if (!await this._savePersonEditorDraft(event)) return false;
    const isGM = Boolean(game.user?.isGM);
    const currentData = SkyholdData.get();
    const current = residentScope(currentData, address);
    const removedRow = (current.person?.workAllocations ?? []).find((row) => String(row.id) === allocationId);
    let confirmedLockKeys = new Set();
    if (current.person && removedRow) {
      if (!holdingPermissionContext(current.holding).canEditBuildings
        || residentHasHiddenWork(current.holding, current.person)) return false;
      const previewNext = (current.person.workAllocations ?? []).filter((row) => String(row.id) !== allocationId);
      const dropped = droppedLocksForAllocationChange(current.holding, address.personId, previewNext, [removedRow]);
      if (dropped.length) {
        if (!isGM && dropped.some((row) => row.visibility === "gm")) {
          ui.notifications.warn("Назначение недоступно. Обновите окно или обратитесь к ГМу.");
          return false;
        }
        if (!await this._confirmAction("Снять закреплённое назначение",
          "Строка закреплена в общем плане работ. Удалить назначение и снять закрепление?")) {
          return false;
        }
        confirmedLockKeys = new Set(dropped.map(lockKeyOf));
      }
      const rowQd = Math.max(0, Number(removedRow.normalQd ?? 0) || 0) + Math.max(0, Number(removedRow.overtimeQd ?? 0) || 0);
      if (!isGM && removedRow.sourceId && removedRow.functionId && (rowQd > 0 || dropped.length > 0)) {
        await requestWorkforceOperation(buildResidentAllocationRemovalCommand({
          operationId: makeId("workforce-remove", 20),
          holdingId: current.holding.id,
          expectedRevision: currentData.meta.revision,
          personId: address.personId,
          buildingId: removedRow.sourceId,
          functionId: removedRow.functionId
        }));
        this.requestRender();
        return true;
      }
    }
    let failureMessage = "";
    const updated = await SkyholdData.transaction((data) => {
      const { holding, person } = residentScope(data, address);
      if (!person || !holdingPermissionContext(holding).canEditBuildings || residentHasHiddenWork(holding, person)) return SkyholdData.skipTransaction(false);
      const innerRemoved = (person.workAllocations ?? []).find((row) => String(row.id) === allocationId);
      const nextAllocations = (person.workAllocations ?? []).filter((row) => String(row.id) !== allocationId);
      if (nextAllocations.length === person.workAllocations?.length) return SkyholdData.skipTransaction(false);
      const innerDropped = droppedLocksForAllocationChange(holding, person.id, nextAllocations, innerRemoved ? [innerRemoved] : []);
      if (hasUnconfirmedLocks(innerDropped, confirmedLockKeys)) {
        failureMessage = "Список закреплений изменился. Повторите удаление строки.";
        return SkyholdData.skipTransaction(false);
      }
      const check = applyResidentEditorAllocations(holding, person.id, {
        nextAllocations,
        conserving: true,
        isGM,
        confirmedUnlock: true
      });
      if (!check.ok) failureMessage = safeWorkforceError(holding, check);
      return check.ok || SkyholdData.skipTransaction(false);
    }, { reason: "resident:remove-work-allocation", scope: "holdings" });
    if (!updated && failureMessage) ui.notifications.warn(failureMessage);
    if (updated) this.requestRender();
    return Boolean(updated);
  } catch (error) {
    console.error("FBL Skyhold | Failed to remove resident work allocation", error);
    ui.notifications.warn(error?.message || "Не удалось убрать функцию из плана труда.");
    return false;
  }
},

_residentTransferContext(holding, data) {
  const currentId = String(holding?.id ?? "");
  const residents = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const targets = (data?.holdings ?? []).filter((item) => String(item.id) !== currentId);
  return {
    residentOptions: [
      { value: "", label: "Выбери жителя", selected: true },
      ...residents.map((person) => ({ value: String(person.id), label: person.name || "Без имени", selected: false }))
    ],
    targetOptions: [
      { value: "", label: "Куда переслать", selected: true },
      ...targets.map((item) => ({ value: String(item.id), label: item.name || "Владение", selected: false }))
    ],
    hasTargets: targets.length > 0,
    hasResidents: residents.length > 0
  };
},

async _onTransferResident(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const root = event.currentTarget?.closest?.(".fbls-transfer-card");
  const residentId = String(root?.querySelector("[data-transfer-resident]")?.value ?? "");
  const targetId = String(root?.querySelector("[data-transfer-target]")?.value ?? "");
  if (!residentId || !targetId) { ui.notifications.warn("Выбери жителя и целевое владение."); return; }
  const sourceId = this.activeHoldingId;
  const sourceHolding = SkyholdData.view().holdings.find((row) => row.id === sourceId);
  const person = sourceHolding?.people?.list?.find((row) => row.id === residentId);
  const destination = SkyholdData.view().holdings.find((row) => row.id === targetId);
  if (!person || !destination || !await this._confirmAction("Переселить жителя", `Переселить «${escapeHtml(person.name)}» в «${escapeHtml(destination.name)}»? Текущие назначения и жильё будут освобождены.`)) return;
  const result = await SkyholdData.transaction(async (data) => {
    const source = data.holdings.find((item) => item.id === sourceId);
    const target = data.holdings.find((item) => String(item.id) === targetId);
    if (!source || !target || source === target) return SkyholdData.skipTransaction({ ok: false, message: "" });
    const transferred = transferResidentBetweenHoldings(source, target, residentId);
    if (!transferred.ok) return SkyholdData.skipTransaction(transferred);
    if (transferred.shipIds.length) {
      const { configureWorldShipEconomy } = await import("../../../engines/ships/world-market.js");
      for (const ship of source.special.ships.list) if (transferred.shipIds.includes(ship.id)) {
        ship.timelineQd = Math.max(Number(ship.timelineQd ?? 0), Number(source.gm?.calendaria?.lastQd ?? 0));
        configureWorldShipEconomy(data, source, ship);
      }
    }
    return transferred;
  }, { reason: "resident:transfer", scope: "holdings" });
  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }
  this.requestRender();
  ui.notifications.info(`${result.personName} переслан в ${result.targetName}.`);
},

async _onAddRow(event) {
  event.preventDefault();
  const { collection, holdingId } = event.currentTarget?.dataset ?? {};
  if (!collection) return;
  const special = /^holdings\.\d+\.special\.list$/.test(collection);
  if (!special && !game.user?.isGM && !(collection.endsWith(".buildings.list") && this._canEditBuildings())) return;

  try {
    const row = this._emptyRowFor(collection, SkyholdData.view());
    if (special) {
      const added = await SkyholdData.updateHolding(holdingId, (holding) => {
        if (!holdingPermissionContext(holding).canEditSpecial) return SkyholdData.skipTransaction(false);
        addCollectionRow(holding, "special.list", { ...row, visibility: "public" });
        return true;
      }, { fallback: false, reason: "special:add-note" });
      if (!added) return ui.notifications.warn("Добавление записи недоступно.");
    } else await SkyholdData.addRow(collection, row);
    this.requestRender();
    if (collection.endsWith(".people.list")) await this._openResidentEditor(row.id, event.currentTarget);
  } catch (error) {
    console.error("FBL Skyhold | Failed to add row", error);
    ui.notifications.error("Не удалось добавить запись. Подробности в консоли.");
  }
},

async _onDeleteRow(event) {
  event.preventDefault();
  const button = event.currentTarget;
  const collection = button.dataset.collection;
  const rowId = button.dataset.id;
  if (!collection || !rowId) return;

  const data = SkyholdData.view();
  const scope = collection.match(/^holdings\.(\d+)\.(.+)$/);
  const holdingId = button.dataset.holdingId ?? (scope ? data.holdings[Number(scope[1])]?.id : null);
  if (scope?.[2] === "buildings.list") return this._executeBuildingContextAction(rowId, "delete", holdingId);
  const collectionIn = (root) => {
    if (!scope) return game.user?.isGM ? collection : "";
    const { holding, index } = findReadableHoldingEntry(root, holdingId);
    if (!holding) return "";
    if (!game.user?.isGM) {
      const permissions = holdingPermissionContext(holding);
      if (!(scope[2] === "special.list" && permissions.canEditSpecial)) return "";
    }
    return index >= 0 ? `holdings.${index}.${scope[2]}` : "";
  };
  const confirmedPath = collectionIn(data);
  if (!confirmedPath) return;
  const confirmedRows = foundry.utils.getProperty(data, confirmedPath);
  const matched = Array.isArray(confirmedRows) ? confirmedRows.filter((row) => String(row?.id ?? "") === rowId) : [];
  if (matched.length !== 1) return ui.notifications.warn("Запись недоступна или её ID неоднозначен.");
  if (!game.user?.isGM && scope?.[2] === "special.list" && !isPublicSpecialNote(matched[0])) {
    return ui.notifications.warn("Особую запись с настройками или эффектом может удалить ГМ.");
  }
  const expected = stableDataHash(matched[0]);
  const confirmed = await this._confirmAction("Удалить запись", "Удалить эту запись из владения?");
  if (!confirmed) return;

  try {
    const deleted = await SkyholdData.transaction((draft, { skip }) => {
      const path = collectionIn(draft);
      const rows = path ? foundry.utils.getProperty(draft, path) : null;
      const matches = Array.isArray(rows) ? rows.filter((row) => String(row?.id ?? "") === rowId) : [];
      if (matches.length !== 1 || stableDataHash(matches[0]) !== expected) return skip(false);
      deleteCollectionRow(draft, path, rowId);
      return true;
    }, { reason: `delete-row:${collection}`, scope: scope ? "holdings" : collection.startsWith("catalog.") ? "catalog" : "both" });
    if (!deleted) return ui.notifications.warn("Запись изменилась после открытия подтверждения. Повторите действие.");
    if (this.activeHoldingId === holdingId && this.editingPersonId === rowId) this.editingPersonId = null;
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to delete row", error);
    ui.notifications.error("Не удалось удалить запись. Подробности в консоли.");
  }
},

async _openResidentEditor(personId = "", returnElement = null) {
  if (!this._canManagePeople() || !personId) return null;
  const holdingId = this.activeHoldingId;
  const ResidentEditor = await loadResidentEditorClass();
  const app = ResidentEditor.open({ holdingId, personId: String(personId) });
  rememberApplicationFocusReturn(app, returnElement ?? document.activeElement);
  return app;
},

_closeResidentContextMenu() {
  try { this._residentContextCleanup?.(); } catch (_error) {}
  this._residentContextCleanup = null;
  const menu = document.querySelector(".fbls-resident-context-menu");
  if (menu) menu.remove();
},

async _executeResidentContextAction(personId = "", action = "", holdingId = this.activeHoldingId) {
  if (!this._canManagePeople()) return;
  if (holdingId !== this.activeHoldingId) return ui.notifications.warn("Откройте меню жителя в его владении.");
  const data = SkyholdData.get();
  const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
  if (holdingIndex < 0) return;
  const holding = data.holdings[holdingIndex];
  const actualHoldingIndex = holdingIndex;
  const person = (holding?.people?.list ?? []).find((row) => String(row.id) === String(personId));
  if (!holding || !person) return;

  if (action === "return-to-ship") {
    if (!this._canReturnResidentToShip(person, holding)) return;
    await this._onCrewShoreDuty({
      preventDefault() {},
      currentTarget: { dataset: { residentId: person.id, shipId: shipForResident(person, holding).id,
        holdingId: holding.id, revision: data.meta.revision } }
    }, "return-to-ship");
    return;
  }

  if (action === "edit") {
    const row = this.element?.querySelector?.(`.fbls-person-row[data-id="${String(personId).replace(/["\\]/g, "\\$&")}"]`);
    await this._openResidentEditor(personId, row);
    return;
  }

  if (action === "mark-dead" || action === "restore") {
    if (!game.user?.isGM) return;
    await this._onTogglePersonDead({
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { dataset: { id: String(personId), holdingId, dead: action === "mark-dead" ? "true" : "false" } }
    });
    return;
  }

  if (action === "delete" && game.user?.isGM) {
    await this._onDeleteRow({
      preventDefault() {},
      currentTarget: { dataset: { collection: `holdings.${actualHoldingIndex}.people.list`, holdingId, id: String(personId) } }
    });
  }
},

_canReturnResidentToShip(person, holding) {
  if (!this._canManagePeople() || !person || person.dead || isResidentAway(person) || isResidentRestingOnShip(person, holding)) return false;
  const ship = shipForResident(person, holding);
  return Boolean(ship?.navigationMode === "world" && ship.location?.kind === "home" && !ship.activeVoyage && !ship.transportOrderId && ship.status !== "away");
},

async _showResidentActionMenu(personId = "", position = null, holdingId = this.activeHoldingId) {
  this._closeResidentContextMenu();
  if (holdingId !== this.activeHoldingId) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  const person = (holding?.people?.list ?? []).find((row) => String(row.id) === String(personId));
  if (!person) return;
  const items = [{ action: "edit", icon: "fa-solid fa-pen", label: "Редактировать" }];
  if (game.user?.isGM) items.push(
    person.dead
      ? { action: "restore", icon: "fa-solid fa-heart-pulse", label: "Вернуть из кладбища" }
      : { action: "mark-dead", icon: "fa-solid fa-skull", label: "Отметить погибшим", danger: true },
    { action: "delete", icon: "fa-solid fa-trash", label: "Удалить", danger: true }
  );
  if (this._canReturnResidentToShip(person, holding)) items.splice(1, 0,
    { action: "return-to-ship", icon: "fa-solid fa-ship", label: "Вернуть на корабль" });
  const menu = document.createElement("div");
  menu.className = "fbl-skyhold fbls-building-context-menu fbls-resident-context-menu";
  menu.append(...items.map(createResidentContextMenuButton));
  const left = Math.max(8, Math.min(window.innerWidth - RESIDENT_CONTEXT_MENU_WIDTH, Number(position?.x ?? 0)));
  const top = Math.max(8, Math.min(window.innerHeight - Math.max(RESIDENT_CONTEXT_MENU_HEIGHT, items.length * 40 + 16), Number(position?.y ?? 0)));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.body.appendChild(menu);

  const onDocPointer = (event) => {
    if (event.target?.closest?.(".fbls-resident-context-menu")) return;
    this._closeResidentContextMenu();
  };
  const onEsc = (event) => {
    if (event.key === "Escape") this._closeResidentContextMenu();
  };
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onEsc, true);
  this._residentContextCleanup = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  menu.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = String(button.dataset.action ?? "");
    this._closeResidentContextMenu();
    await this._executeResidentContextAction(personId, action, holdingId);
  }));
},

async _onResidentContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManagePeople()) return;
  const target = event.target;
  if (target?.closest?.("button, input, textarea, select, a")) return;
  const personId = String(event.currentTarget?.dataset?.id ?? "");
  if (!personId) return;
  await this._showResidentActionMenu(personId, { x: event.clientX, y: event.clientY }, String(event.currentTarget?.dataset?.holdingId ?? ""));
},

async _savePersonEditorDraft(event) {
  const editor = event?.currentTarget?.closest?.(".fbls-person-editor.v2") ?? this.element?.querySelector?.(".fbls-person-editor.v2");
  const baseline = editorDraftSources.get(editor);
  if (!baseline) return false;
  const address = residentAddress(editor);
  const currentData = SkyholdData.get();
  const source = residentScope(currentData, address);
  const permissions = holdingPermissionContext(source.holding);
  if (!source.person || !permissions.canEditResidents) return false;
  const expected = stableDataHash(source.person);
  const canWrite = (path) => canWriteResidentEditorField(currentData, source, permissions, path);

  const regularFields = Array.from(editor.querySelectorAll("[data-field]"));
  const workField = editor.querySelector("[data-work-assignment-field]");
  const workAllocationTargetFields = Array.from(editor.querySelectorAll("[data-work-allocation-target]"));
  let regularUpdates = [];
  let workUpdate = null;
  const submitted = new Map();
  for (const [field, originalValue] of baseline.fields) {
    if (field.disabled || field.matches?.(":disabled")) continue;
    const value = fieldValue(field);
    if (!Object.is(value, originalValue)) submitted.set(field, value);
  }
  const allocationBasePath = source.person ? `holdings.${source.holdingIndex}.people.list.${source.personIndex}.workAllocations` : "";
  const pathFor = (field) => field.dataset.field
    || field.dataset.workAssignmentField
    || (field.dataset.workAllocationTarget !== undefined && allocationBasePath
      ? `${allocationBasePath}.${Math.max(0, Math.floor(Number(field.dataset.allocationIndex) || 0))}.sourceId`
      : "");
  if ([...submitted.keys()].some((field) => !canWrite(pathFor(field)))) {
    ui.notifications.warn("Нет права сохранить изменённое поле. Черновик остался в карточке.");
    return false;
  }

  for (const field of regularFields) {
    const path = field.dataset.field;
    if (!submitted.has(field)) continue;
    let value = submitted.get(field);
    if (field instanceof HTMLTextAreaElement && this._sanitizeTextBlock) value = this._sanitizeTextBlock(value);
    if (path.endsWith(".belief")) value = normalizeBelief(value);
    regularUpdates.push({ path, value });
  }

  for (const field of workAllocationTargetFields) {
    if (!submitted.has(field)) continue;
    const allocationIndex = Math.max(0, Math.floor(Number(field.dataset.allocationIndex) || 0));
    const target = parseWorkAllocationTargetKey(field.value);
    for (const [key, value] of [["sourceId", target.sourceId], ["functionId", target.functionId]]) {
      const path = allocationBasePath ? `${allocationBasePath}.${allocationIndex}.${key}` : "";
      regularUpdates.push({ path, value });
    }
  }

  if (workField && submitted.has(workField)) {
    const path = workField.dataset.workAssignmentField;
    const value = String(workField.value ?? "");
    if (value !== "__mixed__") workUpdate = { path, value };
  }

  const resolve = (update) => resolveResidentDraftUpdate(update, baseline.person, source.person);
  const changedWork = Boolean(workUpdate);
  regularUpdates = regularUpdates.map(resolve);
  if (workUpdate) workUpdate = resolve(workUpdate);
  if ((changedWork && !workUpdate) || regularUpdates.includes(null)) {
    ui.notifications.warn("Поле или строка плана изменились в другой сессии. Скопируйте свою правку и нажмите «Обновить карточку».");
    return false;
  }
  if (!regularUpdates.length && !workUpdate) return true;

  let workDecision = { allowed: true, allowAdmissionOverride: false };
  const hidden = hiddenBuildingIds(source.holding);
  const updatesWorkAllocations = regularUpdates.some(({ path }) => /\.workAllocations(?:\.|$)/.test(path));
  const updatesWork = workUpdate || regularUpdates.some(({ path }) => /\.(?:workAllocations|role)(?:\.|$)/.test(path));
  const hiddenWork = residentHasHiddenWork(source.holding, source.person, hidden);
  if (workUpdate && hidden.has(workUpdate.value) || updatesWork && hiddenWork) {
    ui.notifications.warn("Назначение недоступно.");
    return false;
  }
  const workAllocationAdmissionOverrides = [];
  const candidatePersonPath = workUpdate?.path || regularUpdates.find((update) => /\.people\.list\.\d+\./.test(String(update.path ?? "")))?.path || allocationBasePath;
  const scopedPersonPath = residentScopedPath(source, candidatePersonPath);
  const workParts = scopedPersonPath?.match?.(/^holdings\.(\d+)\.people\.list\.(\d+)(?:\.|$)/);
  const currentHolding = workParts ? currentData?.holdings?.[Number(workParts[1])] : null;
  const currentPerson = workParts ? currentHolding?.people?.list?.[Number(workParts[2])] : null;
  const previewPerson = currentPerson ? structuredClone(currentPerson) : null;
  if (previewPerson && workParts) {
    const prefix = `holdings.${workParts[1]}.people.list.${workParts[2]}.`;
    for (const update of regularUpdates) {
      const scopedPath = residentScopedPath(source, update.path);
      if (!scopedPath?.startsWith(prefix)) continue;
      foundry.utils.setProperty(previewPerson, scopedPath.slice(prefix.length), update.value);
    }
  }

  if (workUpdate) {
    workDecision = await this._workAssignmentAdmissionDecision(currentData, residentScopedPath(source, workUpdate.path), workUpdate.value, previewPerson);
    if (!workDecision.allowed) {
      workField.value = baseline.fields.get(workField);
      submitted.delete(workField);
      workUpdate = null;
    }
  }
  let confirmedWorkLockKeys = new Set();
  if (workUpdate && currentHolding && (previewPerson || currentPerson)) {
    const targetPerson = currentPerson ?? previewPerson;
    const isGM = Boolean(game.user?.isGM);
    const dropped = droppedLocksForWorkAssignmentChange(currentHolding, targetPerson, workUpdate.value);
    if (dropped.length) {
      if (!isGM) {
        ui.notifications.warn(dropped.some((row) => row.visibility === "gm")
          ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
          : "Закреплённое назначение нельзя заменить здесь. Сначала снимите закрепление в общем плане работ или удалите строку плана.");
        this.requestRender?.();
        return false;
      }
      if (!await this._confirmAction("Снять закреплённое назначение",
        "Смена места работы заменит текущие назначения и снимет их закрепление в общем плане работ. Продолжить?")) {
        this.requestRender?.();
        return false;
      }
      confirmedWorkLockKeys = new Set(dropped.map(lockKeyOf));
    }
  }

  let previewExplicitBuildingIds = new Set();
  let confirmedAllocationLockKeys = new Set();
  if (previewPerson && currentHolding && !hiddenWork && !workUpdate && updatesWorkAllocations) {
    previewExplicitBuildingIds = new Set((previewPerson.workAllocations ?? [])
      .filter((allocation) => Math.max(0, Number(allocation?.normalQd ?? 0) || 0) + Math.max(0, Number(allocation?.overtimeQd ?? 0) || 0) > 0)
      .map((allocation) => String(allocation?.sourceId ?? ""))
      .filter(Boolean));
    const previewHolding = structuredClone(currentHolding);
    previewHolding.people.list[Number(workParts[2])] = previewPerson;
    const allocationCheck = validateHoldingWorkAllocations(previewHolding, { previousHolding: currentHolding });
    const blockingIssue = allocationCheck.issues.find((issue) => (
      issue?.code !== "admission-denied"
      && (String(issue?.personId ?? "") === String(previewPerson.id ?? "")
        || previewExplicitBuildingIds.has(String(issue?.buildingId ?? "")))
    ));
    const isGM = Boolean(game.user?.isGM);
    if (blockingIssue) {
      ui.notifications.warn(workforceIssueMessage(previewHolding, blockingIssue, { isGM }) || "Некорректный план рабочих QD.");
      return false;
    }
    const droppedLocks = droppedLocksForAllocationChange(currentHolding, previewPerson.id, previewPerson.workAllocations);
    const droppedKeys = new Set(droppedLocks.map(lockKeyOf));
    const plan = workforcePlan(currentHolding);
    const lockError = lockedAllocationChangeError(currentHolding, previewHolding,
      { ...plan, locks: (plan.locks ?? []).filter((row) => !droppedKeys.has(lockKeyOf(row))) }, { isGM });
    if (lockError) {
      ui.notifications.warn(lockError);
      return false;
    }
    if (droppedLocks.length) {
      if (!isGM) {
        ui.notifications.warn(droppedLocks.some((row) => row.visibility === "gm")
          ? "Назначение недоступно. Обновите окно или обратитесь к ГМу."
          : "Закреплённое назначение нельзя снять через правку поля. Используйте кнопку удаления строки или общий план работ.");
        this.requestRender?.();
        return false;
      }
      if (!await this._confirmAction("Снять закреплённое назначение",
        "Изменение удалит закреплённую строку плана работ и снимет её закрепление. Продолжить?")) {
        this.requestRender?.();
        return false;
      }
      confirmedAllocationLockKeys = droppedKeys;
    }
    const admissionIssues = newLaborIssues(holdingWorkerAdmissionIssues(currentHolding), holdingWorkerAdmissionIssues(previewHolding));
    for (const { buildingId } of admissionIssues.filter((issue) => issue.personId === String(previewPerson.id))) {
      if (hidden.has(buildingId)) {
        ui.notifications.warn("Назначение недоступно.");
        return false;
      }
      const building = currentHolding.buildings.list.find((row) => String(row.id) === buildingId);
      const decision = await confirmBuildingWorkerAdmission({ manager: this, building, person: previewPerson });
      if (!decision.allowed) {
        this.requestRender?.();
        return false;
      }
      if (decision.allowAdmissionOverride) {
        workAllocationAdmissionOverrides.push(building);
      }
    }
  }

  if (!regularUpdates.length && !workUpdate) return true;

  const invalidWage = regularUpdates.some(({ path, value }) => path.endsWith(".wageDailyOverrideCopper")
    && value !== null && !(Number.isSafeInteger(value) && value > 0));
  if (invalidWage) { ui.notifications.warn("Личная ставка должна быть положительным целым числом или пустой."); return false; }
  const approvedBuilding = workUpdate && source.holding.buildings?.list?.find((row) => String(row.id) === workUpdate.value);
  const updates = [...regularUpdates, ...(workUpdate ? [workUpdate] : [])];
  const result = await SkyholdData.transaction((data) => {
    const target = residentScope(data, address);
    const currentPermissions = holdingPermissionContext(target.holding);
    if (!target.person || stableDataHash(target.person) !== expected || !currentPermissions.canEditResidents
      || updates.some(({ path }) => !canWriteResidentEditorField(data, target, currentPermissions, path))) {
      return SkyholdData.skipTransaction({ stale: true });
    }
    const targetBuildings = target.holding.buildings?.list ?? [];
    const hidden = hiddenBuildingIds(target.holding);
    if (workUpdate && (stableDataHash(targetBuildings.find((row) => String(row.id) === workUpdate.value)) !== stableDataHash(approvedBuilding)
      || !holdingPermissionContext(target.holding).canEditBuildings || hidden.has(workUpdate.value))) return SkyholdData.skipTransaction({ stale: true });
    if ((updatesWork && residentHasHiddenWork(target.holding, target.person, hidden))
      || [...previewExplicitBuildingIds].some((id) => hidden.has(id))
      || regularUpdates.some(({ path, value }) => path.endsWith(".home") && targetBuildings.some((building) =>
        hidden.has(String(building.id)) && (String(building.id) === value || building.name === value)))) {
      return SkyholdData.skipTransaction({ stale: true });
    }
    const overrideBuildings = workAllocationAdmissionOverrides.map((override) => targetBuildings.find((row) => row.id === override.id));
    if (overrideBuildings.some((building, index) => stableDataHash(building) !== stableDataHash(workAllocationAdmissionOverrides[index]))) {
      return SkyholdData.skipTransaction({ stale: true });
    }
    const changesWage = regularUpdates.some(({ path }) => /\.(volunteerLabor|wageDailyOverrideCopper)$/.test(path));
    const holdingBeforeWageMutation = changesWage && !updatesWorkAllocations && !workUpdate ? structuredClone(target.holding) : null;
    const allocationsDraft = updatesWorkAllocations ? { workAllocations: structuredClone(target.person.workAllocations ?? []) } : null;
    const pathIn = (path) => residentScopedPath(target, path);
    let warnNoSlot = false;

    for (const { path, value } of regularUpdates) {
      const scopedPath = pathIn(path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const allocationPath = scopedPath.match(/\.people\.list\.\d+\.(workAllocations(?:\.|$).*)$/)?.[1];
      if (allocationPath) foundry.utils.setProperty(allocationsDraft, allocationPath, value);
      else foundry.utils.setProperty(data, scopedPath, value);
      const injuredMatch = scopedPath.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.injuredDays$/);
      if (injuredMatch && Math.max(0, Number(value) || 0) <= 0) {
        const holding = data.holdings?.[Number(injuredMatch[1])];
        const person = holding?.people?.list?.[Number(injuredMatch[2])];
        if (person) clearRecoveredResidentStatus(person);
      }
    }

    if (allocationsDraft && !workUpdate) {
      const innerDropped = droppedLocksForAllocationChange(target.holding, address.personId, allocationsDraft.workAllocations);
      if (hasUnconfirmedLocks(innerDropped, confirmedAllocationLockKeys)) {
        return SkyholdData.skipTransaction({ stale: true, message: "Список закреплений изменился. Обновите карточку и повторите сохранение." });
      }
      const approved = overrideBuildings.length ? [...new Set([
        ...targetBuildings.filter((row) => row.workerAdmissionOverrideIds?.includes(address.personId)).map((row) => row.id),
        ...overrideBuildings.map((row) => row.id)
      ])] : undefined;
      const check = applyResidentEditorAllocations(target.holding, address.personId, {
        nextAllocations: allocationsDraft.workAllocations,
        admissionOverrideBuildingIds: approved,
        isGM: Boolean(game.user?.isGM),
        confirmedUnlock: true
      });
      if (!check.ok) return SkyholdData.skipTransaction({ stale: true, message: safeWorkforceError(target.holding, check) });
    }
    if (holdingBeforeWageMutation) {
      const check = validateHoldingWorkAllocations(target.holding, { previousHolding: holdingBeforeWageMutation });
      if (!check.ok) return SkyholdData.skipTransaction({
        stale: true,
        message: workforceIssueMessage(target.holding, check.issues[0], { isGM: Boolean(game.user?.isGM) })
      });
    }

    if (workUpdate) {
      const { path, value } = workUpdate;
      const scopedPath = pathIn(path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const parts = scopedPath.match(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
      if (parts) {
        const holding = data.holdings?.[Number(parts[1])];
        const person = holding?.people?.list?.[Number(parts[2])];
        // Saving unrelated resident fields must not vacate and requalify an existing foreman.
        const keepLeader = holding && person && keepsCrewLeadership(holding, person, value);
        if (holding && person && !keepLeader && value !== "__mixed__") {
          const innerDropped = droppedLocksForWorkAssignmentChange(holding, person, value);
          if (!game.user?.isGM && innerDropped.length) {
            return SkyholdData.skipTransaction({ warnNoSlot: true });
          }
          if (game.user?.isGM && hasUnconfirmedLocks(innerDropped, confirmedWorkLockKeys)) {
            return SkyholdData.skipTransaction({ stale: true, message: "Список закреплений изменился. Обновите карточку и повторите смену работы." });
          }
          if (approvedBuilding) {
            const ok = this._assignPersonToBuilding?.(holding, person.id, value, { ...workDecision, replace: true });
            if (!ok) return SkyholdData.skipTransaction({ warnNoSlot: true });
          } else {
            if (value && residentLaborUnavailableReason(holding, person)) return SkyholdData.skipTransaction({ warnNoSlot: true });
            this._clearPersonFromAssignments?.(holding, person.id);
            pruneInactiveResidentLocks(holding, person.id);
            if (!value) {
              person.workAssignment = "";
              this._setPersonFree?.(holding, person.id);
            } else if (value === "soldier") {
              person.workAssignment = "soldier";
              person.role = /^\s*(солдат|сержант)\b/i.test(String(person.role ?? "")) ? person.role : "Солдат";
            } else if (value === "other") {
              person.workAssignment = "other";
              person.role = String(person.role ?? "") || "Другое";
            } else if (value === "construction" || value.startsWith("construction:")) {
              const crewId = value === "construction" ? this._constructionCrews?.(holding)?.[0]?.id : value.split(":")[1];
              if (!this._assignPersonToCrew?.(holding, person.id, crewId)) warnNoSlot = true;
            } else warnNoSlot = true;
          }
        }
      } else foundry.utils.setProperty(data, scopedPath, value);
    }

    if (warnNoSlot) return SkyholdData.skipTransaction({ warnNoSlot: true });
    const person = structuredClone(target.holding.people.list.find((row) => String(row.id) === address.personId));
    normalizePerson(person);
    return { saved: true, person, allocationsSuperseded: Boolean(allocationsDraft && workUpdate) };
  }, { reason: "resident:save-editor-draft", scope: "holdings" });

  if (result?.warnNoSlot) ui.notifications.warn("Назначение недоступно. Прежняя работа сохранена.");
  if (result?.stale) ui.notifications.warn(result.message || "Житель, место работы или права изменились. Скопируйте правку, обновите карточку и повторите её.");
  if (result?.saved) {
    const committed = result.person;
    const superseded = result.allocationsSuperseded === true;
    const isAllocationField = (field) => field?.dataset?.workAllocationTarget !== undefined
      || String(field?.dataset?.field ?? "").includes(".workAllocations.");
    for (const [field, value] of submitted) {
      if (superseded && isAllocationField(field)) continue;
      baseline.fields.set(field, value);
    }
    for (const { field, renderedField } of updates) {
      if (field === "workAssignment") {
        baseline.person.workAssignment = committed.workAssignment;
        baseline.person.workAllocations = committed.workAllocations;
      } else if (!superseded || !String(renderedField ?? "").startsWith("workAllocations.")) {
        const value = residentDraftValue(committed, field);
        foundry.utils.setProperty(baseline.person, renderedField, value);
      }
    }
    if (superseded) {
      ui.notifications.warn("Смена основной должности заменила несохранённые правки строк QD.");
      this.requestRender?.();
    }
  }
  return result?.saved === true;
},

async _onClosePersonEditor(event) {
  event.preventDefault();
  try {
    if (!await this._savePersonEditorDraft(event)) return;
  } catch (error) {
    console.error("FBL Skyhold | Failed to save resident draft", error);
    ui.notifications.error("Не удалось сохранить жителя. Подробности в консоли.");
    return;
  }
  this.editingPersonId = null;
  this.requestRender();
},

async _onPersonEditorWorkAssignmentChange(event) {
  event.preventDefault();

  const field = event.currentTarget;
  const workSet = field?.closest?.(".work-set.compact-resident-work");
  const customRole = workSet?.querySelector?.(".person-custom-role");
  const isCustom = String(field?.value ?? "") === "other";
  workSet?.classList?.toggle?.("has-custom-work", isCustom);
  customRole?.classList?.toggle?.("is-hidden", !isCustom);

  try {
    const saved = await this._savePersonEditorDraft(event);
    this.requestRender();
    return saved;
  } catch (error) {
    console.error("FBL Skyhold | Failed to update resident work assignment from editor", error);
    ui.notifications.error("Не удалось обновить работу жителя. Подробности в консоли.");
    return false;
  }
},

};
