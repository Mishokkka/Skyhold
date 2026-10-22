// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { MODULE_ID } from "../../../data/constants.js";
import { buildingLaborMode } from "../../../data/hybrid-labor.js";
import { clearBuildingReferences } from "../../../data/normalizers/resident.js";
import { requestConstructionOperation, SkyholdData } from "../../../data/store.js";
import { makeId } from "../../../data/utils.js";
import { traitBadges } from "../../../generators/trait-definitions.js";
import { loadBuildingEditorClass } from "../../lazy-apps.js";
import { openUniqueBuilding } from "../../unique-buildings/registry.js";
import { createSafeIcon, escapeHtml, rollD6Pool } from "../../../core/helpers.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { planConstructionCancellation } from "../../../engines/economy/construction-stages.js";
import {
  applyConstructionProjectCancellation,
  isCancellableConstructionProject
} from "../../../workflows/economy/construction-cancellation.js";
import { assignResidentsToFreeHousing } from "../../../engines/housing/assignment.js";
import { rememberApplicationFocusReturn } from "../../common/window-focus-keeper.js";
import { confirmBuildingWorkerAdmission } from "../../common/building-worker-admission.js";
import { createFoundryChatMessage, foundryChatSpeaker } from "../../../integrations/foundry-runtime.js";
import {
  isBuiltAssignableBuilding,
  isCivilianWorkerCandidate,
  workerAssignmentScore
} from "../../../engines/workers/assignment-planner.js";

const BUILDING_CONTEXT_MENU_WIDTH = 280;
const BUILDING_CONTEXT_MENU_HEIGHT = 260;
const BUILDING_DRAG_CLICK_SUPPRESS_MS = 40;

function clampAudioVolume(value, fallback = 0.45) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function audioConfigFromTemplate(templateCopy = {}) {
  const source = templateCopy?.audio && typeof templateCopy.audio === "object" ? templateCopy.audio : {};
  const legacyTrack = String(source.track ?? source.src ?? templateCopy.soundTrack ?? templateCopy.audioTrack ?? "").trim();
  let mode = String(source.mode ?? source.type ?? "").trim();
  if (!["file", "playlist-sound", "playlist"].includes(mode)) {
    if (source.playlistId && source.soundId) mode = "playlist-sound";
    else if (source.playlistId) mode = "playlist";
    else mode = "file";
  }
  const src = String(source.src ?? (mode === "file" ? legacyTrack : "")).trim();
  return {
    mode,
    track: String(source.track ?? src),
    src,
    playlistId: mode === "file" ? "" : String(source.playlistId ?? "").trim(),
    soundId: mode === "playlist-sound" ? String(source.soundId ?? "").trim() : "",
    volume: clampAudioVolume(source.volume, 0.45),
    loop: source.loop !== false
  };
}

function createBuildingContextMenuButton(item = {}) {
  const button = document.createElement("button");
  button.type = "button";
  if (item.danger) button.classList.add("danger");
  button.dataset.action = String(item.action ?? "");
  const text = document.createElement("span");
  text.textContent = String(item.label ?? "");
  button.append(createSafeIcon(item.icon), text);
  return button;
}


function hasTraitValue(person = {}, name = "") {
  const target = String(name ?? "").trim().toLowerCase();
  if (!target) return false;
  return traitBadges(person?.traitsText ?? person?.traits).some((trait) => String(trait.name ?? "").trim().toLowerCase() === target);
}

function builderRerollMonthKey(holding = {}) {
  const key = String(holding?.gm?.calendaria?.lastDateKey ?? "").trim();
  const match = key.match(/^(-?\d+)\D+(\d+)/);
  if (match) return `${match[1]}-${match[2]}`;
  const date = new Date();
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
}

function rawCrewForPrepared(holding = {}, crew = {}) {
  const id = String(crew?.id ?? "");
  if (!Array.isArray(holding.constructionCrews)) holding.constructionCrews = [];
  return holding.constructionCrews.find((item) => String(item.id ?? "") === id) ?? null;
}

function applyBuilderRerollIfAvailable(holding = {}, crew = {}, dicePool = 1, firstRolls = []) {
  const leader = crew?.leader ?? null;
  if (!leader || !hasTraitValue(leader, "Builder")) return { rolls: firstRolls, used: false, note: "" };
  const rawCrew = rawCrewForPrepared(holding, crew);
  if (!rawCrew) return { rolls: firstRolls, used: false, note: "" };
  const monthKey = builderRerollMonthKey(holding);
  if (String(rawCrew.builderRerollMonth ?? "") === monthKey) return { rolls: firstRolls, used: false, note: `Builder уже использован в этом месяце (${monthKey}).` };
  const secondRolls = rollD6Pool(Math.max(1, dicePool));
  const firstSuccesses = firstRolls.filter((value) => value >= 6).length;
  const secondSuccesses = secondRolls.filter((value) => value >= 6).length;
  rawCrew.builderRerollMonth = monthKey;
  rawCrew.builderRerollLastLeaderId = String(leader.id ?? "");
  rawCrew.builderRerollLastAt = new Date().toISOString();
  if (secondSuccesses > firstSuccesses) return { rolls: secondRolls, used: true, note: `Builder: ${leader.name || "лидер"} перебросил кубы строительства за ${monthKey}. Было ${firstSuccesses}, стало ${secondSuccesses}.` };
  return { rolls: firstRolls, used: true, note: `Builder: ${leader.name || "лидер"} перебросил кубы строительства за ${monthKey}, но оставлен первый результат (${firstSuccesses} против ${secondSuccesses}).` };
}

function diceTextHtml(rolls = []) {
  return rolls.map((roll) => roll === 6 ? `<strong>${roll}</strong>` : String(roll)).join(", ");
}

export const BuildingEventActions = {
  click: {
    "open-building-editor": "_onOpenBuildingEditor",
    "auto-assign-housing": "_onAutoAssignHousing",
    "roll-construction": "_onRollConstruction",
    "roll-construction-crew": "_onRollConstructionCrew",
    "collect-building-production": "_onCollectBuildingProduction"
  },
  publicClick: [
    "open-building-editor",
    "auto-assign-housing"
  ]
};

export const BuildingEventDomain = {

_workerPlannerDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    buildingOperationalState,
    workerEfficiencyForPerson: (holding, building, person) => this._workerEfficiencyForPerson?.(holding, building, person) ?? { value: 1 },
    isSoldierResident: (person) => Boolean(this._isSoldierResident?.(person)),
    isMilitaryResidentLike: (person) => Boolean(this._isMilitaryResidentLike?.(person))
  };
},

_isBuiltAssignableBuilding(building = {}) {
  return isBuiltAssignableBuilding(building, this._workerPlannerDependencies());
},

_isCivilianWorkerCandidate(person = {}, building = null, holding = null) {
  return isCivilianWorkerCandidate(person, building, this._workerPlannerDependencies(), holding);
},

_buildingAssignmentScore(holding, building, person) {
  return workerAssignmentScore(holding, building, person, this._workerPlannerDependencies());
},

_autoAssignResidentsToHousing(holding) {
  return assignResidentsToFreeHousing(holding, {
    isResidentialBuilding: (building) => this._isResidentialBuilding(building)
  });
},

async _onAutoAssignHousing(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  try {
    const result = await this._updateActiveHolding((holding) => {
      return this._autoAssignResidentsToHousing(holding);
    }, { reason: "building:auto-assign-housing" });
    if (!result) return;
    this.activeTab = "buildings";
    this.requestRender();
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to auto-assign housing", error);
    ui.notifications.error("Не удалось автораспределить жителей по домам. Подробности в консоли.");
  }
},

async _onCollectBuildingProduction(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const buildingId = String(event.currentTarget?.dataset?.buildingId ?? "");
  const lineIndex = Number(event.currentTarget?.dataset?.lineIndex);
  if (!buildingId || !Number.isFinite(lineIndex)) return;
  const result = await this._updateActiveHolding((holding) => {
    const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === buildingId);
    const line = building?.productionLines?.[lineIndex];
    if (!holding || !building || !line) return SkyholdData.skipTransaction(null);
    const collected = this._collectProductionLine(holding, building, line, { ignoreWorkTime: buildingLaborMode(building) === "legacy" });
    if (!collected?.ok) return SkyholdData.skipTransaction(collected);
    const entries = Array.isArray(collected.placements) && collected.placements.length
      ? collected.placements.map((item) => ({ kind: "collect", resourceId: collected.resourceId, name: collected.resourceName, qty: item.qty, roomId: item.roomId, source: collected.source, note: item.overflowFrom ? `Ручной сбор, переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}` : "Ручной сбор" }))
      : [{ kind: "collect", resourceId: collected.resourceId, name: collected.resourceName, qty: collected.qty, roomId: collected.roomId, source: collected.source, note: "Ручной сбор" }];
    this._appendStorageLog(holding, entries);
    return collected;
  }, { reason: "building:collect-production" });
  if (!result) return;
  this.requestRender();
  if (result?.ok) ui.notifications.info(result.message || "Ресурс собран.");
  else ui.notifications.warn(result?.message || "Нечего собирать.");
},


_buildingProtectedAssignmentIds(holding) {
  const ids = new Set();
  const defense = holding?.gm?.defense ?? {};
  if (defense.commanderId) ids.add(String(defense.commanderId));
  for (const squad of defense.squads ?? []) {
    if (squad?.sergeantId) ids.add(String(squad.sergeantId));
    for (const id of (squad?.memberIds ?? []).slice(0, 4)) if (id) ids.add(String(id));
  }
  return ids;
},

_clearBuildingWorkers(holding, buildingId) {
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === String(buildingId ?? ""));
  if (!building) return { cleared: 0, message: "Здание не найдено." };
  const max = Math.max(0, this._safeNumber(building.workersMax, 0));
  const oldIds = (Array.isArray(building.assignedWorkerIds) ? building.assignedWorkerIds : []).map((id) => String(id ?? "")).filter(Boolean);
  for (const id of oldIds) this._setPersonFree(holding, id);
  building.assignedWorkerIds = Array.from({ length: max }, () => "");
  return { cleared: oldIds.length, message: oldIds.length ? `Слоты здания очищены: ${oldIds.length}.` : "В здании не было назначенных жителей." };
},

_fillBuildingWorkers(holding, buildingId, { mode = "free" } = {}) {
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === String(buildingId ?? ""));
  if (!building) return { assigned: 0, message: "Здание не найдено." };
  if (!this._isBuiltAssignableBuilding(building)) return { assigned: 0, message: "В это здание сейчас нельзя назначать работников." };
  if (buildingLaborMode(building) !== "legacy") return { assigned: 0, message: "Распределите людей и их основные работы через «План работ»." };
  const max = Math.max(0, this._safeNumber(building.workersMax, 0));
  if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
  while (building.assignedWorkerIds.length < max) building.assignedWorkerIds.push("");
  if (mode === "all") {
    const oldIds = building.assignedWorkerIds.map((id) => String(id ?? "")).filter(Boolean);
    for (const id of oldIds) this._setPersonFree(holding, id);
    building.assignedWorkerIds = Array.from({ length: max }, () => "");
  }
  const protectedIds = this._buildingProtectedAssignmentIds(holding);
  const picked = new Set((building.assignedWorkerIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  const candidateRows = people
    .filter((person) => !protectedIds.has(String(person.id)))
    .filter((person) => mode === "all" || ["", "Свободен", "Без работы", "Ребенок"].includes(String(person?.workAssignment || person?.role || "")))
    .filter((person) => this._isCivilianWorkerCandidate(person, building, holding))
    .map((person) => ({ person, score: this._buildingAssignmentScore(holding, building, person) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.person.name ?? "").localeCompare(String(b.person.name ?? ""), "ru"));
  let assigned = 0;
  for (let slot = 0; slot < max; slot += 1) {
    if (building.assignedWorkerIds[slot]) continue;
    const pick = candidateRows.find((row) => !picked.has(String(row.person.id)))?.person;
    if (!pick) continue;
    this._clearPersonFromAssignments(holding, pick.id);
    building.assignedWorkerIds[slot] = String(pick.id);
    pick.workAllocationMode = "legacy";
    pick.workAssignment = String(building.id);
    pick.role = building.workerRole || building.name || "Работает в здании";
    this._applyPersonSalaryForAssignment?.(holding, pick, building);
    picked.add(String(pick.id));
    assigned += 1;
  }
  return { assigned, message: assigned ? `Назначено жителей: ${assigned}.` : "Подходящих жителей не найдено." };
},

_closeBuildingContextMenu() {
  try { this._buildingContextCleanup?.(); } catch (_error) {}
  this._buildingContextCleanup = null;
  const menu = document.querySelector(".fbls-building-context-menu");
  if (menu) menu.remove();
},

async _executeBuildingContextAction(buildingId = "", action = "") {
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === String(buildingId));
  if (!holding || !building) return;
  const name = String(building?.name ?? "Здание");
  if (action === "mothball" || action === "unmothball") {
    return this._onSetFinanceBuildingMothball?.({
      holdingId: String(holding.id ?? ""),
      buildingId: String(building.id ?? ""),
      mothballed: action === "mothball"
    });
  }
  if (action === "cancel-project") {
    if (!game.user?.isGM) {
      ui.notifications.warn("Отменять незавершённый строительный проект может только ГМ.");
      return;
    }
    const requestedOperationId = makeId("construction-cancel", 20);
    const preview = planConstructionCancellation({ holding, building, operationId: requestedOperationId });
    if (!preview.ok) {
      ui.notifications.warn(preview.message || "Этот проект нельзя отменить.");
      return;
    }
    const operationId = preview.replay ? String(preview.operationId ?? requestedOperationId) : requestedOperationId;
    const refundText = preview.refund.length
      ? preview.refund.map((row) => `${row.name}: ${row.qty}`).join("; ")
      : "без возврата материалов";
    const confirmed = await this._confirmAction?.(
      "Отменить проект",
      `Отменить незавершённый проект «${name}»? Проект будет удалён, бригада освобождена. Возврат: ${refundText}.`
    );
    if (!confirmed) return;
    const cancelled = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
      const result = applyConstructionProjectCancellation({
        holding: freshHolding,
        buildingId,
        operationId,
        createdAt: new Date().toISOString(),
        plan: preview,
        dependencies: {
          addStorageWithOverflow: (draft, row, qty) => this._storageAddWithOverflow(draft, row, qty),
          appendStorageLog: (draft, entries) => this._appendStorageLog(draft, entries),
          setPersonFree: (draft, personId) => this._setPersonFree(draft, personId)
        }
      });
      return result.ok && !result.replay ? result : SkyholdData.skipTransaction(result);
    }, { reason: `building:cancel-construction:${operationId}` });
    if (!cancelled?.ok) {
      ui.notifications.warn(cancelled?.message || "Не удалось отменить проект.");
      return;
    }
    this.requestRender();
    const returned = cancelled.refund?.length
      ? cancelled.refund.map((row) => `${row.name}: ${row.qty}`).join("; ")
      : "материалы не возвращались";
    ui.notifications.info(`Проект «${name}» отменён; ${returned}.`);
    return;
  }
  if (action === "delete") {
    if (isCancellableConstructionProject(building)) {
      ui.notifications.warn("Незавершённый проект нужно отменять через действие «Отменить проект».");
      return;
    }
    const confirmed = await this._confirmAction?.("Удалить здание", `Удалить построенное здание «${name}»? Строительные материалы не возвращаются.`);
    if (!confirmed) return;
    const deleted = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
      const before = freshHolding.buildings?.list?.length ?? 0;
      const removed = freshHolding.buildings?.list?.find((item) => String(item.id ?? "") === String(buildingId));
      if (!removed) return SkyholdData.skipTransaction(false);
      clearBuildingReferences(freshHolding, removed);
      if (!freshHolding.buildings) freshHolding.buildings = { list: [] };
      freshHolding.buildings.list = (freshHolding.buildings.list ?? []).filter((item) => String(item.id ?? "") !== String(buildingId));
      return freshHolding.buildings.list.length !== before;
    }, { reason: "building:context-delete" });
    if (!deleted) return;
    this.requestRender();
    ui.notifications.info(`Здание «${name}» удалено.`);
    return;
  }
  const result = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
    return action === "clear"
      ? this._clearBuildingWorkers(freshHolding, buildingId)
      : this._fillBuildingWorkers(freshHolding, buildingId, { mode: action === "fill-max" ? "all" : "free" });
  }, { reason: "building:context-workers" });
  if (!result) return;
  this.requestRender();
  ui.notifications.info(result?.message || "Готово.");
},

async _showBuildingActionMenu(buildingId = "", position = null) {
  this._closeBuildingContextMenu();
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId);
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === String(buildingId));
  if (!holding || !building) return;
  const cancellableProject = isCancellableConstructionProject(building);
  const mothballed = this._financeBuildingMothballed?.(holding, buildingId) === true;
  const items = [
    { action: "clear", icon: "fa-solid fa-user-minus", label: "Убрать всех жителей" },
    { action: "fill-free", icon: "fa-solid fa-user-plus", label: "Распределить сюда свободных жителей" },
    { action: "fill-max", icon: "fa-solid fa-people-group", label: "Распределить сюда максимум жителей" },
    game.user?.isGM && !cancellableProject
      ? mothballed
        ? { action: "unmothball", icon: "fa-solid fa-power-off", label: "Снять консервацию" }
        : { action: "mothball", icon: "fa-solid fa-box-archive", label: "Законсервировать" }
      : null,
    cancellableProject
      ? { action: "cancel-project", icon: "fa-solid fa-hammer-circle-xmark", label: game.user?.isGM ? "Отменить проект" : "Отменить проект (только ГМ)", danger: true }
      : { action: "delete", icon: "fa-solid fa-trash", label: "Удалить здание", danger: true }
  ].filter(Boolean);
  const menu = document.createElement("div");
  menu.className = "fbl-skyhold fbls-building-context-menu";
  menu.append(...items.map(createBuildingContextMenuButton));
  const left = Math.max(8, Math.min(window.innerWidth - BUILDING_CONTEXT_MENU_WIDTH, Number(position?.x ?? 0)));
  const top = Math.max(8, Math.min(window.innerHeight - BUILDING_CONTEXT_MENU_HEIGHT, Number(position?.y ?? 0)));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  document.body.appendChild(menu);
  const onDocPointer = (event) => {
    if (event.target?.closest?.('.fbls-building-context-menu')) return;
    this._closeBuildingContextMenu();
  };
  const onEsc = (event) => {
    if (event.key === "Escape") this._closeBuildingContextMenu();
  };
  document.addEventListener("pointerdown", onDocPointer, true);
  document.addEventListener("keydown", onEsc, true);
  this._buildingContextCleanup = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onEsc, true);
  };
  menu.querySelectorAll("button[data-action]").forEach((button) => button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const action = String(button.dataset.action ?? "");
    this._closeBuildingContextMenu();
    await this._executeBuildingContextAction(buildingId, action);
  }));
},

async _onBuildingContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const target = event.target;
  if (target?.closest?.("button, input, textarea, select, a")) return;
  const buildingId = String(event.currentTarget?.dataset?.id ?? event.currentTarget?.dataset?.buildingId ?? "");
  if (!buildingId) return;
  await this._showBuildingActionMenu(buildingId, { x: event.clientX, y: event.clientY });
},

async _onOpenBuildingEditor(event) {
  const target = event.target;
  if (this._buildingDragActive) return;
  if (target?.closest?.("button, input, textarea, select, a")) return;

  const buildingId = event.currentTarget?.dataset?.id;
  if (!buildingId) return;

  const uniqueApp = openUniqueBuilding({ holdingId: this.activeHoldingId, buildingId });
  if (uniqueApp) return;
  const SkyholdBuildingEditor = await loadBuildingEditorClass();
  const editor = new SkyholdBuildingEditor({ holdingId: this.activeHoldingId, buildingId });
  rememberApplicationFocusReturn(editor, event.currentTarget);
  editor.render({ force: true, focus: true });
},

_onBuildingDragStart(event) {
  if (!this._canEditBuildings()) return;
  const card = event.currentTarget;
  const buildingId = String(card?.dataset?.buildingId || card?.dataset?.id || "");
  if (!buildingId) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => String(item.id) === String(this.activeHoldingId));
  const buildingIndex = (holding?.buildings?.list ?? []).findIndex((item) => String(item.id) === buildingId);
  const building = buildingIndex >= 0 ? holding.buildings.list[buildingIndex] : null;
  if (!holding || !building) return;
  const prepared = this._prepareBuildingRow?.(holding, building, buildingIndex, true) ?? building;
  const payload = {
    type: "fbl-skyhold-building",
    moduleId: MODULE_ID,
    holdingId: String(holding.id ?? ""),
    buildingId,
    name: String(building.name ?? "Постройка"),
    icon: String(prepared.icon ?? building.icon ?? "fa-solid fa-building"),
    img: String(prepared.img ?? building.img ?? building.image ?? "")
  };
  this._buildingDragActive = true;
  card.classList?.add?.("dragging");
  event.dataTransfer?.setData?.("text/plain", JSON.stringify(payload));
  event.dataTransfer?.setData?.(`application/${MODULE_ID}+json`, JSON.stringify(payload));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
},

_onBuildingDragEnd(event) {
  event.currentTarget?.classList?.remove?.("dragging");
  window.setTimeout(() => { this._buildingDragActive = false; }, BUILDING_DRAG_CLICK_SUPPRESS_MS);
},

_onBuildingDragOver(event) {
  if (!this._canEditBuildings()) return;
  const target = event.currentTarget;
  const draggedId = this._buildingDragIdFromEvent?.(event) || "";
  const targetId = String(target?.dataset?.buildingId || target?.dataset?.id || "");
  if (!targetId || draggedId === targetId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  target.classList?.add?.("drag-over");
},

_buildingDragIdFromEvent(event) {
  const raw = event.dataTransfer?.getData?.(`application/${MODULE_ID}+json`) || event.dataTransfer?.getData?.("text/plain") || "";
  if (!raw) return "";
  try {
    const payload = JSON.parse(raw);
    if (payload?.type !== "fbl-skyhold-building") return "";
    return String(payload.buildingId ?? "");
  } catch (_error) { return ""; }
},

async _onBuildingDrop(event) {
  if (!this._canEditBuildings()) return;
  const targetCard = event.currentTarget;
  targetCard?.classList?.remove?.("drag-over");
  const draggedId = this._buildingDragIdFromEvent(event);
  const targetId = String(targetCard?.dataset?.buildingId || targetCard?.dataset?.id || "");
  if (!draggedId || !targetId || draggedId === targetId) return;
  event.preventDefault();
  event.stopPropagation();
  const moved = await this._updateActiveHolding((holding) => {
    const list = holding?.buildings?.list;
    if (!Array.isArray(list)) return SkyholdData.skipTransaction(false);
    const from = list.findIndex((item) => String(item.id) === draggedId);
    const to = list.findIndex((item) => String(item.id) === targetId);
    if (from < 0 || to < 0 || from === to) return SkyholdData.skipTransaction(false);
    const [row] = list.splice(from, 1);
    list.splice(to, 0, row);
    return true;
  }, { reason: "building:reorder" });
  if (!moved) return;
  this.requestRender();
},

async _onBuildingWorkerChange(event) {
  event.preventDefault();
  if (!this._canEditBuildings()) return;
  const field = event.currentTarget;
  const path = field.dataset.buildingWorkerField;
  if (!path) return;
  const parts = path.match(/holdings\.(\d+)\.buildings\.list\.(\d+)\.assignedWorkerIds\.(\d+)$/);
  try {
    if (parts) {
      const currentData = SkyholdData.get();
      const currentPath = this._resolveActiveHoldingScopedPath(currentData, path);
      const currentParts = currentPath.match(/holdings\.(\d+)\.buildings\.list\.(\d+)\.assignedWorkerIds\.(\d+)$/);
      const currentHolding = currentParts ? currentData.holdings?.[Number(currentParts[1])] : null;
      const currentBuilding = currentParts ? currentHolding?.buildings?.list?.[Number(currentParts[2])] : null;
      const person = (currentHolding?.people?.list ?? []).find((row) => String(row?.id ?? "") === String(field.value ?? ""));
      const decision = await confirmBuildingWorkerAdmission({ manager: this, building: currentBuilding, person });
      if (!decision.allowed) { this.requestRender(); return; }
      await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
        const scopedParts = scopedPath.match(/holdings\.(\d+)\.buildings\.list\.(\d+)\.assignedWorkerIds\.(\d+)$/);
        if (!scopedParts) return SkyholdData.skipTransaction(null);
        const holding = data.holdings[Number(scopedParts[1])];
        const building = holding?.buildings?.list?.[Number(scopedParts[2])];
        if (!holding || !building) return SkyholdData.skipTransaction(null);
        return this._setBuildingSlot(holding, building.id, Number(scopedParts[3]), field.value || "", decision)
          || SkyholdData.skipTransaction(false);
      }, { reason: "building:worker-change", scope: "holdings" });
    } else {
      const updated = await this._updateActiveHoldingPath(path, field.value || "", { reason: "building:worker-change" });
      if (!updated) return;
    }
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to assign building worker", error);
    ui.notifications.error("Не удалось назначить работника. Подробности в консоли.");
  }
},

async _onCreateBuildingFromTemplate(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const templateId = String(event.currentTarget?.dataset?.templateId ?? "");
  if (!templateId) return;
  const result = await this._updateActiveHolding((holding, data) => {
    const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
    if (!template) return SkyholdData.skipTransaction({ ok: false, message: "Шаблон здания не найден." });
    const templateState = this._buildingTemplateContext?.(holding, data)?.rows?.find((row) => String(row.id) === templateId);
    if (templateState && templateState.playerVisible === false && !game.user?.isGM) {
      return SkyholdData.skipTransaction({ ok: false, message: "Шаблон скрыт ГМом." });
    }
    if (templateState && !templateState.unlocked) {
      return SkyholdData.skipTransaction({ ok: false, message: `Шаблон закрыт: ${templateState.reasonText || "требования не выполнены"}.` });
    }
    // Материалы больше не списываются при создании blueprint-проекта.
    // Проект можно поставить в очередь и дофармить недостающие ресурсы позже.
    if (!holding.buildings) holding.buildings = { list: [] };
    if (!Array.isArray(holding.buildings.list)) holding.buildings.list = [];
    const id = makeId("b", 12);
    const building = this._buildingFromTemplate(template, id);
    holding.buildings.list.push(building);
    return { ok: true, id, name: building.name };
  }, { reason: "building:create-from-template" });
  if (!result) return;
  if (!result.ok) { ui.notifications.warn(result.message); return; }
  this.activeTab = "buildings";
  this.expandedBuildingId = result.id;
  this.requestRender();
  ui.notifications.info(`${result.name} добавлено в проекты строительства.`);
},

_buildingFromTemplate(template = {}, id = "") {
  const templateCopy = foundry?.utils?.deepClone?.(template) ?? JSON.parse(JSON.stringify(template ?? {}));
  delete templateCopy.unlocked;
  delete templateCopy.locked;
  delete templateCopy.css;
  delete templateCopy.reasonText;
  const workersMax = Math.max(0, Number(templateCopy.workersMax ?? 0) || 0);
  return {
    ...templateCopy,
    id: id || makeId("b", 12),
    templateId: String(template.id ?? ""),
    visibility: "public",
    status: "Проект",
    constructionStatus: "planned",
    constructionCrewId: "",
    buildProgress: 0,
    assignedWorkerIds: Array.from({ length: workersMax }, () => ""),
    workerAdmissionOverrideIds: [],
    audio: audioConfigFromTemplate(templateCopy),
    serviceProjects: Array.isArray(templateCopy.serviceProjects) ? templateCopy.serviceProjects : []
  };
},

async _onBuildingConstructionCrewChange(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const buildingId = String(event.currentTarget?.dataset?.buildingId ?? "");
  const crewId = String(event.currentTarget?.value ?? "");
  const updated = await this._updateActiveHolding((holding) => {
    const building = holding?.buildings?.list?.find((item) => String(item.id) === buildingId);
    if (!building) return SkyholdData.skipTransaction(false);
    building.constructionCrewId = crewId;
    return true;
  }, { reason: "building:set-construction-crew" });
  if (!updated) return;
  this.requestRender();
},


async _onRollConstructionCrew(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;

  const crewId = event.currentTarget?.dataset?.crewId || null;
  const result = await this._updateActiveHolding((holding) => {
    const crew = this._constructionCrew(holding, crewId);
    if (!crew.count || !crew.dice) return SkyholdData.skipTransaction({ ok: false, message: "Стройбригада пуста." });

    const dicePool = Math.max(1, crew.dice);
    const firstRolls = rollD6Pool(dicePool);
    const reroll = applyBuilderRerollIfAvailable(holding, crew, dicePool, firstRolls);
    const rolls = reroll.rolls;
    const successes = rolls.filter((value) => value >= 6).length;
    const details = crew.members.map((person) => `<li>${escapeHtml(person.name)}: ${person.contribution}к6${person.contributionReasons ? ` — ${escapeHtml(person.contributionReasons)}` : ""}</li>`).join("");
    const chat = {
      ok: true,
      holdingName: holding.name || "Владение",
      crewName: crew.name || "Стройбригада",
      rawDice: crew.rawDice,
      moraleMod: crew.moraleMod,
      moraleReason: crew.moraleReason,
      dice: crew.dice,
      diceText: diceTextHtml(rolls),
      successes,
      rerollNote: reroll.note,
      details
    };
    return reroll.used ? chat : SkyholdData.skipTransaction(chat);
  }, { reason: "building:roll-construction-crew" });

  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }

  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: result.holdingName }),
    content: `
      <div class="fbls-chat-card">
        <h3>${escapeHtml(result.crewName)}</h3>
        <p><strong>Пул:</strong> ${result.rawDice}к6, довольство ${result.moraleMod > 0 ? "+" : ""}${result.moraleMod} (${escapeHtml(result.moraleReason)}) = ${result.dice}к6</p>
        <p><strong>Кости:</strong> ${result.diceText}</p>
        <p><strong>Успехи:</strong> ${result.successes}</p>
        ${result.rerollNote ? `<p><strong>Builder:</strong> ${escapeHtml(result.rerollNote)}</p>` : ""}
        ${result.details ? `<ul>${result.details}</ul>` : ""}
      </div>
    `
  });
},

async _onRollConstruction(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;

  const buildingId = String(event.currentTarget?.dataset?.id ?? "");
  if (!buildingId) return;
  const data = SkyholdData.get();
  const holdingId = this._activeWritableHoldingId(data);
  const holding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === String(holdingId));
  const building = (holding?.buildings?.list ?? []).find((row) => String(row?.id ?? "") === buildingId);
  const crewId = String(event.currentTarget?.dataset?.crewId ?? building?.constructionCrewId ?? "");
  if (!holding || !building || !crewId) {
    ui.notifications.warn("Не удалось определить проект или назначенную стройбригаду.");
    return;
  }

  let result;
  try {
    result = await requestConstructionOperation({
      type: "rollConstruction",
      operationId: makeId("construction", 20),
      expectedRevision: Math.max(0, Number(data?.meta?.revision) || 0),
      holdingId: String(holding.id ?? ""),
      buildingId,
      crewId
    });
  } catch (error) {
    console.error("FBL Skyhold | Failed to execute construction operation", error);
    ui.notifications.warn(error?.message || "Строительный бросок не выполнен.");
    return;
  }

  if (!result?.ok) {
    if (result?.message) ui.notifications.warn(result.message);
    return;
  }

  await createFoundryChatMessage({
    speaker: foundryChatSpeaker({ alias: result.holdingName }),
    content: `
      <div class="fbls-chat-card">
        <h3>Строительство: ${escapeHtml(result.buildingName)}</h3>
        <p><strong>Стройбригада:</strong> ${escapeHtml(result.crewNames)}</p>
        <p><strong>Пул:</strong> ${result.rawDice}к6, довольство ${result.moraleMod > 0 ? "+" : ""}${result.moraleMod} (${escapeHtml(result.moraleReason)})${result.difficulty ? `, сложность ${result.difficulty > 0 ? "+" : ""}${result.difficulty}` : ""} = ${result.dicePool}к6</p>
        <p><strong>Кости:</strong> ${diceTextHtml(result.rolls)}</p>
        <p><strong>Успехи:</strong> ${result.successes}${result.successBonus ? ` (${result.rolledSuccesses} на костях +${result.successBonus} Центр Строительства)` : ""}; принято стадий: ${result.appliedStages}. Прогресс: ${result.oldProgress} → ${result.nextProgress} / ${result.target}</p>
        ${result.appliedStages < result.requestedStages ? `<p><strong>Материалы ограничили прогресс:</strong> ${escapeHtml(result.missingText || "не хватает материалов следующей стадии")}</p>` : ""}
        ${result.rerollNote ? `<p><strong>Builder:</strong> ${escapeHtml(result.rerollNote)}</p>` : ""}
        ${result.nextProgress >= result.target ? "<p><strong>Постройка завершена.</strong></p>" : ""}
      </div>
    `
  });

  this.activeTab = "buildings";
  this.expandedBuildingId = null;
  this.requestRender();
}
};
