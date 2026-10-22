// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData, requestShipOperation } from "../../../data/store.js";
import { normalizeBelief } from "../../../generators/resident-rules.js";
import { createSafeIcon, escapeHtml, fieldValue } from "../../../core/helpers.js";
import { makeId } from "../../../data/utils.js";
import { isResidentAway, isResidentRestingOnShip, shipForResident } from "../../../data/resident-presence.js";
import { parseWorkAllocationTargetKey, validateHoldingWorkAllocations, WORK_ALLOCATION_MODE_EXPLICIT } from "../../../data/work-allocations.js";
import { loadResidentEditorClass } from "../../lazy-apps.js";
import { rememberApplicationFocusReturn } from "../../common/window-focus-keeper.js";
import { syncSelectionSummary } from "../../common/selection-summary.js";
import { residentTraitTooltip } from "../../common/resident-trait-chips.js";
import { confirmBuildingWorkerAdmission } from "../../common/building-worker-admission.js";
import { transferResidentBetweenHoldings, vacatePoliticsRepresentative } from "../../../data/resident-assignments.js";
import { staffAppointmentFor } from "../../../data/hybrid-labor.js";

const RESIDENT_CONTEXT_MENU_WIDTH = 230;
const RESIDENT_CONTEXT_MENU_HEIGHT = 150;

function keepsCrewLeadership(holding, person, value) {
  if (!value.startsWith("construction-leader:") || String(person.workAssignment ?? "") !== value) return false;
  const crewId = value.slice("construction-leader:".length);
  return (holding.constructionCrews ?? []).some((crew) => String(crew.id) === crewId && String(crew.leaderId ?? "") === String(person.id));
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
  const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
  const parts = scopedPath?.match?.(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
  if (!parts) return { allowed: true, allowAdmissionOverride: false };
  const holding = data?.holdings?.[Number(parts[1])];
  const person = personOverride ?? holding?.people?.list?.[Number(parts[2])];
  const building = (holding?.buildings?.list ?? []).find((row) => String(row?.id ?? "") === String(value ?? ""));
  if (!holding || !person || !building) return { allowed: true, allowAdmissionOverride: false };
  return confirmBuildingWorkerAdmission({ manager: this, building, person });
},

async _onWorkAssignmentChange(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;
  const field = event.currentTarget;
  const path = field.dataset.workAssignmentField;
  if (!path) return;
  const value = String(field.value ?? "");
  try {
    const decision = await this._workAssignmentAdmissionDecision(SkyholdData.get(), path, value);
    if (!decision.allowed) {
      this.requestRender();
      return;
    }
    const result = await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const parts = scopedPath.match(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
      if (!parts) {
        foundry.utils.setProperty(data, scopedPath, value);
        return { warnNoSlot: false };
      }
      const holding = data.holdings[Number(parts[1])];
      const person = holding?.people?.list?.[Number(parts[2])];
      if (!holding || !person) return SkyholdData.skipTransaction(null);
      if (keepsCrewLeadership(holding, person, value)) return SkyholdData.skipTransaction(null);
      this._clearPersonFromAssignments(holding, person.id);
      person.workAssignment = value;
      if (!value) this._setPersonFree?.(holding, person.id);
      else if (value === "soldier") {
        person.workAssignment = "soldier";
        person.role = "Солдат";
        this._applyPersonSalaryForAssignment?.(holding, person, null);
      }
      else if (value === "other") {
        person.role = String(person.role ?? "") || "Другое";
        this._applyPersonSalaryForAssignment?.(holding, person, null);
      }
      else if (value === "construction") this._assignPersonToCrew(holding, person.id, this._constructionCrews(holding)[0]?.id);
      else if (value.startsWith("construction:")) this._assignPersonToCrew(holding, person.id, value.split(":")[1]);
      else {
        const ok = this._assignPersonToBuilding(holding, person.id, value, decision);
        if (!ok) {
          person.workAssignment = "";
          this._setPersonFree?.(holding, person.id);
          return { warnNoSlot: true };
        }
      }
      return { warnNoSlot: false };
    }, { reason: "resident:work-assignment", scope: "holdings" });
    if (!result) return;
    if (result.warnNoSlot) ui.notifications.warn("В выбранном здании нет свободного рабочего слота.");
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
  if (!this._canManagePeople()) return;
  const id = String(event.currentTarget?.dataset?.id ?? "");
  const dead = String(event.currentTarget?.dataset?.dead ?? "true") !== "false";
  if (!id) return;
  try {
    const updated = await this._updateActiveHolding((holding) => {
      const person = (holding?.people?.list ?? []).find((row) => String(row.id) === id);
      if (!person) return SkyholdData.skipTransaction(false);
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
    if (!updated) return;
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
        remove.addEventListener("click", (event) => this._onRemoveTrait(event));
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
  if (!this._canManagePeople()) return;
  const personId = String(event.currentTarget?.dataset?.personId ?? "");
  if (!personId) return;
  try {
    if (!await this._savePersonEditorDraft(event)) return;
    const updated = await this._updateActiveHolding((holding) => {
      const person = (holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
      if (!person) return SkyholdData.skipTransaction(false);
      this._clearPersonFromAssignments?.(holding, personId);
      person.workAssignment = "";
      person.workAllocationMode = WORK_ALLOCATION_MODE_EXPLICIT;
      if (!Array.isArray(person.workAllocations)) person.workAllocations = [];
      person.workAllocations.push({
        schemaVersion: 1,
        id: makeId("work"),
        sourceId: "",
        functionId: "",
        normalQd: 0,
        overtimeQd: 0
      });
      return true;
    }, { reason: "resident:add-work-allocation" });
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
  if (!this._canManagePeople()) return;
  const personId = String(event.currentTarget?.dataset?.personId ?? "");
  const allocationId = String(event.currentTarget?.dataset?.allocationId ?? "");
  if (!personId || !allocationId) return;
  try {
    if (!await this._savePersonEditorDraft(event)) return;
    const updated = await this._updateActiveHolding((holding) => {
      const person = (holding?.people?.list ?? []).find((row) => String(row?.id ?? "") === personId);
      if (!person) return SkyholdData.skipTransaction(false);
      const before = Array.isArray(person.workAllocations) ? person.workAllocations.length : 0;
      person.workAllocations = (person.workAllocations ?? []).filter((row) => String(row?.id ?? "") !== allocationId);
      return person.workAllocations.length !== before;
    }, { reason: "resident:remove-work-allocation" });
    if (updated) this.requestRender();
    return Boolean(updated);
  } catch (error) {
    console.error("FBL Skyhold | Failed to remove resident work allocation", error);
    ui.notifications.error("Не удалось убрать функцию из плана труда. Подробности в консоли.");
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
  const collection = event.currentTarget?.dataset?.collection;
  if (!game.user?.isGM && !(this._canEditBuildings() && String(collection ?? "").endsWith(".buildings.list"))) return;

  if (!collection) return;

  try {
    const row = this._emptyRowFor(collection, SkyholdData.view());
    await SkyholdData.addRow(collection, row);
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
  if (!game.user?.isGM && !(this._canEditBuildings() && String(collection ?? "").endsWith(".buildings.list"))) return;
  const rowId = button.dataset.id;
  if (!collection || !rowId) return;

  const confirmed = await this._confirmAction("Удалить запись", "Удалить эту запись из владения?");
  if (!confirmed) return;

  try {
    await SkyholdData.deleteRow(collection, rowId);
    if (this.editingPersonId === rowId) this.editingPersonId = null;
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to delete row", error);
    ui.notifications.error("Не удалось удалить запись. Подробности в консоли.");
  }
},

async _onEditPerson(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const rowId = event.currentTarget?.dataset?.id;
  if (!rowId) return;

  await this._openResidentEditor(rowId, event.currentTarget);
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

async _executeResidentContextAction(personId = "", action = "") {
  if (!this._canManagePeople()) return;
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
    await this._onTogglePersonDead({
      preventDefault() {},
      stopPropagation() {},
      currentTarget: { dataset: { id: String(personId), dead: action === "mark-dead" ? "true" : "false" } }
    });
    return;
  }

  if (action === "delete") {
    await this._onDeleteRow({
      preventDefault() {},
      currentTarget: { dataset: { collection: `holdings.${actualHoldingIndex}.people.list`, id: String(personId) } }
    });
  }
},

_canReturnResidentToShip(person, holding) {
  if (!this._canManagePeople() || !person || person.dead || isResidentAway(person) || isResidentRestingOnShip(person, holding)) return false;
  const ship = shipForResident(person, holding);
  return Boolean(ship?.navigationMode === "world" && ship.location?.kind === "home" && !ship.activeVoyage && ship.status !== "away");
},

async _showResidentActionMenu(personId = "", position = null) {
  this._closeResidentContextMenu();
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  const person = (holding?.people?.list ?? []).find((row) => String(row.id) === String(personId));
  if (!person) return;
  const items = [
    { action: "edit", icon: "fa-solid fa-pen", label: "Редактировать" },
    person.dead
      ? { action: "restore", icon: "fa-solid fa-heart-pulse", label: "Вернуть из кладбища" }
      : { action: "mark-dead", icon: "fa-solid fa-skull", label: "Отметить погибшим", danger: true },
    { action: "delete", icon: "fa-solid fa-trash", label: "Удалить", danger: true }
  ];
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
    await this._executeResidentContextAction(personId, action);
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
  await this._showResidentActionMenu(personId, { x: event.clientX, y: event.clientY });
},

async _savePersonEditorDraft(event) {
  const editor = event?.currentTarget?.closest?.(".fbls-person-editor.v2") ?? this.element?.querySelector?.(".fbls-person-editor.v2");
  if (!editor || !this._canManagePeople?.()) return false;

  const regularFields = Array.from(editor.querySelectorAll("[data-field]")).filter((field) => !/\.salary(?:Modifier)?$/.test(String(field.dataset.field ?? "")));
  const salaryFields = Array.from(editor.querySelectorAll("[data-field]")).filter((field) => /\.salary(?:Modifier)?$/.test(String(field.dataset.field ?? "")));
  const workField = editor.querySelector("[data-work-assignment-field]");
  const workAllocationTargetFields = Array.from(editor.querySelectorAll("[data-work-allocation-target]"));
  const regularUpdates = [];
  const salaryUpdates = [];
  let workUpdate = null;

  for (const field of regularFields) {
    const path = field.dataset.field;
    if (!path || !this._canPlayerWriteFieldPath(path)) continue;
    let value = fieldValue(field);
    if (field instanceof HTMLTextAreaElement && this._sanitizeTextBlock) value = this._sanitizeTextBlock(value);
    if (path.endsWith(".belief")) value = normalizeBelief(value);
    regularUpdates.push({ path, value });
  }

  const modePath = editor.querySelector("[data-field$='.workAllocationMode']")?.dataset?.field ?? "";
  const allocationBasePath = modePath.replace(/\.workAllocationMode$/, ".workAllocations");
  for (const field of workAllocationTargetFields) {
    const allocationIndex = Math.max(0, Math.floor(Number(field.dataset.allocationIndex) || 0));
    const target = parseWorkAllocationTargetKey(field.value);
    for (const [key, value] of [["sourceId", target.sourceId], ["functionId", target.functionId]]) {
      const path = allocationBasePath ? `${allocationBasePath}.${allocationIndex}.${key}` : "";
      if (!path || !this._canPlayerWriteFieldPath(path)) continue;
      regularUpdates.push({ path, value });
    }
  }

  if (workField) {
    const path = workField.dataset.workAssignmentField;
    const value = String(workField.value ?? "");
    if (path && this._canPlayerWriteFieldPath(path)) {
      workUpdate = { path, value };
    }
  }

  for (const field of salaryFields) {
    const path = field.dataset.field;
    if (!path || !this._canPlayerWriteFieldPath(path)) continue;
    salaryUpdates.push({ path, value: fieldValue(field) });
  }

  let workDecision = { allowed: true, allowAdmissionOverride: false };
  const workAllocationAdmissionOverrides = [];
  const currentData = SkyholdData.get();
  const candidatePersonPath = workUpdate?.path || modePath || regularUpdates.find((update) => /\.people\.list\.\d+\./.test(String(update.path ?? "")))?.path;
  const scopedPersonPath = candidatePersonPath ? this._resolveActiveHoldingScopedPath(currentData, candidatePersonPath) : "";
  const workParts = scopedPersonPath?.match?.(/^holdings\.(\d+)\.people\.list\.(\d+)(?:\.|$)/);
  const currentHolding = workParts ? currentData?.holdings?.[Number(workParts[1])] : null;
  const currentPerson = workParts ? currentHolding?.people?.list?.[Number(workParts[2])] : null;
  const previewPerson = currentPerson ? structuredClone(currentPerson) : null;
  if (previewPerson && workParts) {
    const prefix = `holdings.${workParts[1]}.people.list.${workParts[2]}.`;
    for (const update of regularUpdates) {
      const scopedPath = this._resolveActiveHoldingScopedPath(currentData, update.path);
      if (!scopedPath?.startsWith(prefix)) continue;
      foundry.utils.setProperty(previewPerson, scopedPath.slice(prefix.length), update.value);
    }
  }

  if (workUpdate && String(previewPerson?.workAllocationMode ?? "") !== WORK_ALLOCATION_MODE_EXPLICIT) {
    workDecision = await this._workAssignmentAdmissionDecision(currentData, workUpdate.path, workUpdate.value, previewPerson);
    if (!workDecision.allowed) {
      if (workField && currentPerson) workField.value = String(currentPerson.workAssignment ?? "");
      workUpdate = null;
    }
  }

  let previewExplicitBuildingIds = new Set();
  if (previewPerson && currentHolding && String(previewPerson.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT) {
    previewExplicitBuildingIds = new Set((previewPerson.workAllocations ?? [])
      .filter((allocation) => Math.max(0, Number(allocation?.normalQd ?? 0) || 0) + Math.max(0, Number(allocation?.overtimeQd ?? 0) || 0) > 0)
      .map((allocation) => String(allocation?.sourceId ?? ""))
      .filter(Boolean));
    const previewHolding = structuredClone(currentHolding);
    previewHolding.people.list[Number(workParts[2])] = previewPerson;
    const allocationCheck = validateHoldingWorkAllocations(previewHolding);
    const blockingIssue = allocationCheck.issues.find((issue) => (
      String(issue?.personId ?? "") === String(previewPerson.id ?? "")
      || previewExplicitBuildingIds.has(String(issue?.buildingId ?? ""))
    ));
    if (blockingIssue) {
      ui.notifications.warn(blockingIssue.message || "Некорректный план рабочих QD.");
      return false;
    }
    for (const buildingId of previewExplicitBuildingIds) {
      const building = (currentHolding.buildings?.list ?? []).find((row) => String(row?.id ?? "") === buildingId);
      if (!building) continue;
      const admission = this._buildingWorkerAdmission?.(building, previewPerson) ?? { eligible: true, hard: false, overridden: false };
      if (!admission.hard || admission.eligible) continue;
      if (admission.overridden) {
        workAllocationAdmissionOverrides.push({ holdingIndex: Number(workParts[1]), personId: String(previewPerson.id), buildingId });
        continue;
      }
      const decision = await confirmBuildingWorkerAdmission({ manager: this, building, person: previewPerson });
      if (!decision.allowed) {
        this.requestRender?.();
        return false;
      }
      if (decision.allowAdmissionOverride) {
        workAllocationAdmissionOverrides.push({ holdingIndex: Number(workParts[1]), personId: String(previewPerson.id), buildingId });
      }
    }
  }

  if (!regularUpdates.length && !workUpdate && !salaryUpdates.length) return true;

  const result = await SkyholdData.transaction((data) => {
    let warnNoSlot = false;

    for (const { path, value } of regularUpdates) {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      foundry.utils.setProperty(data, scopedPath, value);
      const injuredMatch = scopedPath.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.injuredDays$/);
      if (injuredMatch && Math.max(0, Number(value) || 0) <= 0) {
        const holding = data.holdings?.[Number(injuredMatch[1])];
        const person = holding?.people?.list?.[Number(injuredMatch[2])];
        if (person) clearRecoveredResidentStatus(person);
      }
    }

    const explicitMatches = new Set(regularUpdates.map(({ path }) => (
      this._resolveActiveHoldingScopedPath(data, path).match(/^holdings\.(\d+)\.people\.list\.(\d+)\.workAllocation/)?.slice(1, 3).join(":")
    )).filter(Boolean));
    for (const match of explicitMatches) {
      const [holdingIndex, personIndex] = match.split(":").map(Number);
      const holding = data.holdings?.[holdingIndex];
      const person = holding?.people?.list?.[personIndex];
      if (!holding || !person || String(person.workAllocationMode ?? "") !== WORK_ALLOCATION_MODE_EXPLICIT) continue;
      this._clearPersonFromAssignments?.(holding, person.id);
      person.workAssignment = "";
      if (!String(person.role ?? "").trim() || ["Свободен", "Без работы"].includes(String(person.role))) person.role = "План QD";
    }

    for (const override of workAllocationAdmissionOverrides) {
      const holding = data.holdings?.[override.holdingIndex];
      const building = (holding?.buildings?.list ?? []).find((row) => String(row?.id ?? "") === override.buildingId);
      if (!building || !(holding?.people?.list ?? []).some((person) => String(person?.id ?? "") === override.personId)) continue;
      if (!Array.isArray(building.workerAdmissionOverrideIds)) building.workerAdmissionOverrideIds = [];
      if (!building.workerAdmissionOverrideIds.some((id) => String(id) === override.personId)) building.workerAdmissionOverrideIds.push(override.personId);
    }

    if (workUpdate) {
      const { path, value } = workUpdate;
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const parts = scopedPath.match(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
      if (parts) {
        const holding = data.holdings?.[Number(parts[1])];
        const person = holding?.people?.list?.[Number(parts[2])];
        // Saving unrelated resident fields must not vacate and requalify an existing foreman.
        const keepLeader = holding && person && String(person.workAllocationMode ?? "") !== WORK_ALLOCATION_MODE_EXPLICIT
          && keepsCrewLeadership(holding, person, value);
        const keepStaff = holding && person && person.workAllocationMode !== WORK_ALLOCATION_MODE_EXPLICIT
          && staffAppointmentFor(person)?.buildingId === value;
        if (holding && person && !keepLeader && !keepStaff) {
          this._clearPersonFromAssignments?.(holding, person.id);
          if (String(person.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT) {
            person.workAssignment = "";
          } else {
            person.workAssignment = value;
            if (!value) this._setPersonFree?.(holding, person.id);
            else if (value === "soldier") {
              person.workAssignment = "soldier";
              person.role = /^\s*(солдат|сержант)\b/i.test(String(person.role ?? "")) ? person.role : "Солдат";
              this._applyPersonSalaryForAssignment?.(holding, person, null);
            } else if (value === "other") {
              person.role = String(person.role ?? "") || "Другое";
              this._applyPersonSalaryForAssignment?.(holding, person, null);
            } else if (value === "construction") this._assignPersonToCrew?.(holding, person.id, this._constructionCrews?.(holding)?.[0]?.id);
            else if (value.startsWith("construction:")) this._assignPersonToCrew?.(holding, person.id, value.split(":")[1]);
            else {
              const ok = this._assignPersonToBuilding?.(holding, person.id, value, workDecision);
              if (!ok) {
                person.workAssignment = "";
                this._setPersonFree?.(holding, person.id);
                warnNoSlot = true;
              }
            }
          }
        }
      } else foundry.utils.setProperty(data, scopedPath, value);
    }

    for (const { path, value } of salaryUpdates) {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      foundry.utils.setProperty(data, scopedPath, value);
      const match = scopedPath.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.salaryModifier$/);
      if (match && this._applyPersonSalaryForAssignment) {
        const holding = data.holdings?.[Number(match[1])];
        const person = holding?.people?.list?.[Number(match[2])];
        const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(person?.workAssignment));
        if (holding && person) this._applyPersonSalaryForAssignment(holding, person, building ?? null);
      }
    }

    return { warnNoSlot };
  }, { reason: "resident:save-editor-draft", scope: "holdings" });

  if (result?.warnNoSlot) ui.notifications.warn("В выбранном здании нет свободного рабочего слота.");
  return Boolean(result);
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
