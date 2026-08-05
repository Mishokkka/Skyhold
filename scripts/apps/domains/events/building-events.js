// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { MODULE_ID } from "../../../data/constants.js";
import { SkyholdData } from "../../../data/store.js";
import { clone, makeId } from "../../../data/utils.js";
import { stableDataHash } from "../../../data/storage-commit.js";
import { appendHoldingOperation, findHoldingOperation } from "../../../data/operations.js";
import { traitBadges } from "../../../generators/trait-definitions.js";
import { loadBuildingEditorClass } from "../../lazy-apps.js";
import { openUniqueBuilding } from "../../unique-buildings/registry.js";
import { createSafeIcon, escapeHtml, joinList, rollD6Pool, splitList } from "../../../core/helpers.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { assignResidentsToFreeHousing } from "../../../engines/housing/assignment.js";
import { reserveConstructionMaterials, validConstructionReservation } from "../../../engines/economy/construction-reservation.js";
import { buildingDeletionBlocker, deleteBuildingWithStorageLifecycle } from "../../../engines/storage/building-lifecycle.js";
import { rememberApplicationFocusReturn } from "../../common/window-focus-keeper.js";
import { createFoundryChatMessage, foundryChatSpeaker, foundryDialogV2 } from "../../../integrations/foundry-runtime.js";
import {
  applyWorkerAssignmentPlan,
  isBuiltAssignableBuilding,
  isCivilianWorkerCandidate,
  workerAssignmentScore
} from "../../../engines/workers/assignment-planner.js";

const BUILDING_CONTEXT_MENU_WIDTH = 280;
const BUILDING_CONTEXT_MENU_HEIGHT = 220;
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
  const leader = (crew.members ?? []).find((person) => person?.isLeader) ?? null;
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
    "auto-assign-building-workers": "_onAutoAssignBuildingWorkers",
    "auto-assign-housing": "_onAutoAssignHousing",
    "allocate-building-materials": "_onAllocateBuildingMaterials",
    "roll-construction-crew": "_onRollConstructionCrew",
    "collect-building-production": "_onCollectBuildingProduction"
  },
  publicClick: [
    "open-building-editor",
    "auto-assign-building-workers",
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
    isMilitaryResidentLike: (person) => Boolean(this._isMilitaryResidentLike?.(person)),
    setPersonFree: (holding, personId) => this._setPersonFree(holding, personId),
    assignedWorkerSet: (holding) => this._assignedWorkerSet?.(holding) ?? new Set(),
    applyPersonSalaryForAssignment: (holding, person, building) => this._applyPersonSalaryForAssignment?.(holding, person, building)
  };
},

_isBuiltAssignableBuilding(building = {}) {
  return isBuiltAssignableBuilding(building, this._workerPlannerDependencies());
},

_isCivilianWorkerCandidate(person = {}, building = null) {
  return isCivilianWorkerCandidate(person, building, this._workerPlannerDependencies());
},

_buildingAssignmentScore(holding, building, person) {
  return workerAssignmentScore(holding, building, person, this._workerPlannerDependencies());
},

_autoAssignWorkersToBuildings(holding, { mode = "free" } = {}) {
  return applyWorkerAssignmentPlan({
    holding,
    mode,
    dependencies: this._workerPlannerDependencies()
  });
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

async _onAutoAssignBuildingWorkers(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const mode = String(event.currentTarget?.dataset?.mode ?? "free") === "all" ? "all" : "free";
  try {
    const data = SkyholdData.get();
    const holdingId = this._activeWritableHoldingId(data);
    const source = (data?.holdings ?? []).find((holding) => String(holding?.id ?? "") === String(holdingId ?? ""));
    if (!source) return this._warnNoActiveHolding();
    const sourceHash = stableDataHash(source);
    const previewHolding = clone(source);
    const preview = this._autoAssignWorkersToBuildings(previewHolding, { mode });
    if (!preview.ok) {
      ui.notifications.warn(preview.message);
      return;
    }
    const rows = preview.assignments.slice(0, 14).map((assignment) => (
      `<li><strong>${escapeHtml(assignment.personName)}</strong> → ${escapeHtml(assignment.buildingName)} <small>(${Math.round(assignment.score * 100) / 100})</small></li>`
    )).join("");
    const extra = preview.assignments.length > 14 ? `<p>И ещё назначений: ${preview.assignments.length - 14}.</p>` : "";
    const clearing = preview.cleared ? `<p>Будет очищено старых рабочих слотов: <strong>${preview.cleared}</strong>.</p>` : "";
    const confirmed = await foundryDialogV2().confirm({
      window: { title: mode === "all" ? "План перераспределения работников" : "Предложения по свободным слотам" },
      content: `<div class="fbls-dialog-text"><p>${escapeHtml(preview.message)}</p>${clearing}<ul>${rows}</ul>${extra}</div>`,
      modal: true
    });
    if (!confirmed) return;
    const operationId = makeId("worker-plan", 20);
    const result = await this._updateActiveHolding((holding) => {
      if (stableDataHash(holding) !== sourceHash) {
        return SkyholdData.skipTransaction({ ok: false, stale: true, message: "Назначения изменились после предпросмотра. Построй план заново." });
      }
      if (findHoldingOperation(holding, operationId)) {
        return SkyholdData.skipTransaction({ ok: true, duplicate: true, operationId, assigned: 0, cleared: 0, message: "Этот план уже применён." });
      }
      const applied = this._autoAssignWorkersToBuildings(holding, { mode });
      if (!applied.ok) return SkyholdData.skipTransaction(applied);
      appendHoldingOperation(holding, {
        operationId,
        type: "worker-assignment",
        createdAt: new Date().toISOString(),
        title: mode === "all" ? "Перераспределение работников" : "Заполнение свободных слотов",
        summary: applied.message,
        assigned: applied.assigned,
        cleared: applied.cleared
      });
      return { ...applied, operationId };
    }, { reason: "building:auto-assign-workers" });
    if (!result) return;
    if (!result.ok) {
      ui.notifications.warn(result.message);
      return;
    }
    this.activeTab = "buildings";
    this.requestRender();
    ui.notifications.info(result.message);
  } catch (error) {
    console.error("FBL Skyhold | Failed to auto-assign building workers", error);
    ui.notifications.error("Не удалось автораспределить работников. Подробности в консоли.");
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
    const collected = this._collectProductionLine(holding, building, line, { ignoreWorkTime: true });
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
    .filter((person) => this._isCivilianWorkerCandidate(person, building))
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
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === String(buildingId));
  if (!holding || !building) return;
  const name = String(building?.name ?? "Здание");
  if (action === "delete") {
    const blocked = buildingDeletionBlocker(building);
    if (!blocked.ok) {
      ui.notifications.warn(blocked.message);
      return;
    }
    const confirmed = await this._confirmAction?.("Удалить здание", `Удалить «${name}»? Содержимое его хранилища будет перенесено под открытое небо.`);
    if (!confirmed) return;
    const deleted = await SkyholdData.updateHolding(holding.id, (freshHolding) => {
      const result = deleteBuildingWithStorageLifecycle(freshHolding, buildingId, {
        releaseWorker: (target, personId) => this._setPersonFree(target, personId),
        appendStorageLog: (target, entries) => this._appendStorageLog(target, entries)
      });
      return result.ok ? result : SkyholdData.skipTransaction(result);
    }, { reason: "building:context-delete" });
    if (!deleted) return;
    if (!deleted.ok) {
      ui.notifications.warn(deleted.message);
      return;
    }
    this.requestRender();
    const moved = deleted.movedResources + deleted.movedItems;
    ui.notifications.info(`Здание «${name}» удалено.${moved ? ` Позиций перенесено наружу: ${moved}.` : ""}`);
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
  const items = [
    { action: "clear", icon: "fa-solid fa-user-minus", label: "Убрать всех жителей" },
    { action: "fill-free", icon: "fa-solid fa-user-plus", label: "Распределить сюда свободных жителей" },
    { action: "fill-max", icon: "fa-solid fa-people-group", label: "Распределить сюда максимум жителей" },
    { action: "delete", icon: "fa-solid fa-trash", label: "Удалить", danger: true }
  ];
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
  const holding = data.holdings.find((item) => String(item.id) === String(this.activeHoldingId)) ?? data.holdings[0];
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

async _onSuitableTypeAddChange(event) {
  event.preventDefault();
  if (!this._canEditBuildings()) return;
  const field = event.currentTarget;
  const path = field.dataset.suitableTypeAddField;
  const value = String(field.value ?? "").trim();
  if (!path || !value) return;
  try {
    await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const list = splitList(foundry.utils.getProperty(data, scopedPath));
      if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
      foundry.utils.setProperty(data, scopedPath, joinList(list));
    }, { reason: "building:add-suitable-type" });
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to add suitable type", error);
    ui.notifications.error("Не удалось добавить подходящий тип. Подробности в консоли.");
  }
},

async _onRemoveSuitableType(event) {
  event.preventDefault();
  if (!this._canEditBuildings()) return;
  const button = event.currentTarget;
  const path = button.dataset.suitableTypesField;
  const value = String(button.dataset.suitableType ?? "").trim().toLowerCase();
  if (!path || !value) return;
  try {
    await SkyholdData.transaction((data) => {
      const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
      if (!scopedPath) return SkyholdData.skipTransaction(null);
      const list = splitList(foundry.utils.getProperty(data, scopedPath)).filter((item) => item.toLowerCase() !== value);
      foundry.utils.setProperty(data, scopedPath, joinList(list));
    }, { reason: "building:remove-suitable-type" });
    this.requestRender();
  } catch (error) {
    console.error("FBL Skyhold | Failed to remove suitable type", error);
    ui.notifications.error("Не удалось убрать подходящий тип. Подробности в консоли.");
  }
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
      await SkyholdData.transaction((data) => {
        const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
        const scopedParts = scopedPath.match(/holdings\.(\d+)\.buildings\.list\.(\d+)\.assignedWorkerIds\.(\d+)$/);
        if (!scopedParts) return SkyholdData.skipTransaction(null);
        const holding = data.holdings[Number(scopedParts[1])];
        const building = holding?.buildings?.list?.[Number(scopedParts[2])];
        if (!holding || !building) return SkyholdData.skipTransaction(null);
        this._setBuildingSlot(holding, building.id, Number(scopedParts[3]), field.value || "");
      }, { reason: "building:worker-change" });
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
  return {
    id: id || makeId("b", 12),
    templateId: String(template.id ?? ""),
    primaryDev: String(templateCopy.primaryDev ?? template.primaryDev ?? ""),
    sourceRequirement: String(templateCopy.sourceRequirement ?? ""),
    sourceRawMaterials: String(templateCopy.sourceRawMaterials ?? ""),
    specialRequirements: String(templateCopy.specialRequirements ?? ""),
    compendiumId: String(templateCopy.compendiumId ?? ""),
    name: String(templateCopy.name ?? "Новая постройка"),
    type: String(templateCopy.type ?? templateCopy.category ?? "Особые"),
    visibility: "public",
    status: "Проект",
    constructionStatus: "planned",
    constructionCrewId: "",
    location: String(templateCopy.location ?? ""),
    requirements: templateCopy.requirements ?? { food: 0, technology: 0, culture: 0, war: 0 },
    bonuses: templateCopy.bonuses ?? { food: 0, technology: 0, culture: 0, war: 0 },
    workersMin: Number(templateCopy.workersMin ?? 1) || 0,
    workersMax: Number(templateCopy.workersMax ?? 1) || 1,
    assignedWorkerIds: Array.from({ length: Math.max(0, Number(templateCopy.workersMax ?? 1) || 1) }, () => ""),
    suitableWorkerTypes: String(templateCopy.suitableWorkerTypes ?? ""),
    workerTypeEffects: templateCopy.workerTypeEffects ?? {},
    workerRole: String(templateCopy.workerRole ?? ""),
    workerPrimaryAttribute: String(templateCopy.workerPrimaryAttribute ?? ""),
    effect: String(templateCopy.effect ?? templateCopy.description ?? ""),
    production: String(templateCopy.production ?? ""),
    functions: templateCopy.functions ?? { production: false, income: false, defense: false, housing: false, storage: false, culture: false },
    productionLines: Array.isArray(templateCopy.productionLines) ? templateCopy.productionLines : [],
    income: templateCopy.income ?? { base: 0, perWorker: 0, formula: "", risk: 0, illegal: false },
    enterpriseCapital: templateCopy.enterpriseCapital ?? {
      version: 2,
      enabled: false,
      landCopper: 0,
      equipmentCopper: 0,
      workingCapitalCopper: 0,
      commissioningPaidCopper: 0,
      workingCapitalReserveCopper: 0,
      fundingProvenance: "treasury",
      legacyGrandfathered: false,
      fundedCopper: 0,
      renewalPercentAnnual: 10,
      notes: ""
    },
    defense: templateCopy.defense ?? { base: 0, perStep: 0, workerStep: 0, combatTag: "garrison" },
    housing: templateCopy.housing ?? { capacity: 0, comfort: 0, quality: 0, notes: "" },
    storage: templateCopy.storage ?? { capacity: 0, security: 0, quality: 0 },
    religion: templateCopy.religion ?? { religious: false, faith: "", customFaith: "", notes: "" },
    special: templateCopy.special ?? {},
    medical: templateCopy.medical ?? {},
    reputation: Number(templateCopy.reputation ?? 0) || 0,
    moraleDelta: Number(templateCopy.moraleDelta ?? 0) || 0,
    upkeep: Number(templateCopy.upkeep ?? 0) || 0,
    materialCosts: Array.isArray(templateCopy.materialCosts) ? templateCopy.materialCosts : [],
    icon: String(templateCopy.icon ?? template.icon ?? "fa-solid fa-building"),
    img: String(templateCopy.img ?? templateCopy.image ?? template.img ?? template.image ?? ""),
    audio: audioConfigFromTemplate(templateCopy),
    requiredBuildingIds: Array.isArray(templateCopy.requiredBuildingIds) ? templateCopy.requiredBuildingIds : [],
    buildDifficulty: Number(templateCopy.buildDifficulty ?? 0) || 0,
    buildTarget: Math.max(1, Number(templateCopy.buildTarget ?? 6) || 6),
    buildProgress: 0,
    notes: String(templateCopy.notes ?? templateCopy.description ?? "")
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


_buildingMaterialCostsForAllocation(building = {}) {
  return (Array.isArray(building?.materialCosts) ? building.materialCosts : [])
    .map((item) => {
      const resourceId = String(item?.resourceId ?? item?.resource ?? item?.name ?? "").trim();
      const name = String(item?.name ?? item?.label ?? resourceId ?? "Материал").trim() || resourceId || "Материал";
      const qty = Math.max(0, this._safeNumber(item?.qty, 0));
      return { resourceId, id: resourceId, name, qty };
    })
    .filter((item) => item.qty > 0);
},

async _onAllocateBuildingMaterials(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const buildingId = String(event.currentTarget?.dataset?.id ?? "");
  if (!buildingId) return;
  const operationId = makeId("construction-reserve", 20);
  const reservedAt = new Date().toISOString();

  const result = await this._updateActiveHolding((holding) => {
    const building = (holding.buildings?.list ?? []).find((item) => String(item.id) === buildingId);
    if (!building) return SkyholdData.skipTransaction({ ok: false, tone: "silent", message: "" });

    const costs = this._buildingMaterialCostsForAllocation(building);
    if (!costs.length) return SkyholdData.skipTransaction({ ok: false, tone: "info", message: "У здания нет материальных затрат." });
    if (validConstructionReservation(building) || building.materialsAllocated) return SkyholdData.skipTransaction({ ok: false, tone: "info", message: "Материалы для этого здания уже выделены." });

    const reservation = reserveConstructionMaterials({
      holding,
      building,
      costs,
      operationId,
      reservedAt,
      reservedQd: holding?.gm?.calendaria?.lastQd,
      dependencies: {
        planCosts: ({ holding: draft, costs: rows }) => this._storageCanPay(draft, rows),
        takeResourceLots: (draft, row, qty) => this._storageTakeLots(draft, row, qty)
      }
    });
    if (!reservation.ok) {
      const missing = (reservation?.missing ?? []).map((item) => `${item.name || item.resourceId}: нужно ${item.qty}, есть ${this._formatNumber ? this._formatNumber(item.have) : item.have}`).join("; ");
      return SkyholdData.skipTransaction({ ok: false, tone: "warn", message: `Не хватает материалов: ${missing || "неизвестно"}.` });
    }
    appendHoldingOperation(holding, {
      operationId,
      type: "construction-reservation",
      createdAt: reservedAt,
      title: `Материалы выделены: ${building.name || "здание"}`,
      summary: building.materialsAllocatedLine,
      payload: { buildingId: building.id, reservation: clone(reservation.reservation) }
    });
    return { ok: true, buildingName: building.name || "здание", reservation: reservation.reservation };
  }, { reason: "building:allocate-materials" });

  if (!result) return;
  if (!result.ok) {
    if (result.tone === "info") ui.notifications.info(result.message);
    else if (result.tone === "warn") ui.notifications.warn(result.message);
    return;
  }
  ui.notifications.info(`Материалы выделены: ${result.buildingName}.`);
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
  ui.notifications.info("Прогресс строительства и ремонта начисляется только при расчёте десятника: так бригада использует общий запас труда и не может работать повторно.");
}
};
