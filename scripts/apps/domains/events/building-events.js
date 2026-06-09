// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, MODULE_ID, SkyholdData } from "../../../data/store.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { traitBadges } from "../../../generators/trait-definitions.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";


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

export const BuildingEventDomain = {

_isBuiltAssignableBuilding(building = {}) {
  const status = String(building?.constructionStatus ?? "built");
  return status === "built" && Math.max(0, this._safeNumber(building?.workersMax, 0)) > 0;
},

_isCivilianWorkerCandidate(person = {}, building = null) {
  if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0) return false;
  const ageGroup = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
  if (ageGroup === "Ре" && this._safeNumber(person?.age, 0) < 12) return false;
  const isDefense = Boolean(building?.functions?.defense || this._safeNumber(building?.defense?.base, 0) || this._safeNumber(building?.defense?.perStep, 0) || this._safeNumber(building?.defense?.workerStep, 0));
  if (!isDefense && (this._isSoldierResident?.(person) || this._isMilitaryResidentLike?.(person))) return false;
  return true;
},

_buildingAssignmentScore(holding, building, person) {
  const result = this._workerEfficiencyForPerson?.(holding, building, person) ?? { value: 1 };
  const base = Number.isFinite(Number(result.value)) ? Number(result.value) : 0;
  const isDefense = Boolean(building?.functions?.defense || this._safeNumber(building?.defense?.base, 0) || this._safeNumber(building?.defense?.perStep, 0) || this._safeNumber(building?.defense?.workerStep, 0));
  const militaryBonus = isDefense && (this._isSoldierResident?.(person) || this._isMilitaryResidentLike?.(person)) ? 0.5 : 0;
  return Math.max(0, base + militaryBonus);
},

_autoAssignWorkersToBuildings(holding, { mode = "free" } = {}) {
  const buildings = (holding?.buildings?.list ?? []).filter((building) => this._isBuiltAssignableBuilding(building));
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  if (!buildings.length) return { assigned: 0, cleared: 0, message: "Нет построенных зданий со слотами работников." };
  let cleared = 0;
  if (mode === "all") {
    const defenseIds = new Set();
    const defense = holding?.gm?.defense ?? {};
    if (defense.commanderId) defenseIds.add(String(defense.commanderId));
    for (const squad of defense.squads ?? []) {
      if (squad?.sergeantId) defenseIds.add(String(squad.sergeantId));
      for (const id of (squad?.memberIds ?? []).slice(0, 4)) if (id) defenseIds.add(String(id));
    }
    for (const building of buildings) {
      const max = Math.max(0, this._safeNumber(building.workersMax, 0));
      const oldIds = (building.assignedWorkerIds ?? []).filter(Boolean);
      cleared += oldIds.length;
      for (const id of oldIds) if (!defenseIds.has(String(id))) this._setPersonFree(holding, id);
      building.assignedWorkerIds = Array.from({ length: max }, () => "");
    }
    for (const crew of holding?.constructionCrews ?? []) {
      const oldIds = Array.isArray(crew.memberIds) ? crew.memberIds.filter(Boolean) : [];
      cleared += oldIds.length;
      for (const id of oldIds) if (!defenseIds.has(String(id))) this._setPersonFree(holding, id);
      crew.memberIds = [];
      crew.leaderId = "";
    }
    for (const person of people) {
      const id = String(person?.id ?? "");
      if (!id || defenseIds.has(id)) continue;
      if (this._isSoldierResident?.(person) || this._isMilitaryResidentLike?.(person)) continue;
      const ageGroup = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
      if (ageGroup === "Ре" && this._safeNumber(person?.age, 0) < 12) continue;
      this._setPersonFree(holding, id);
    }
  }

  const occupied = mode === "all" ? (this._assignedWorkerSet?.(holding) ?? new Set()) : (this._assignedWorkerSet?.(holding) ?? new Set());
  const used = new Set(occupied);
  let assigned = 0;
  const sortedBuildings = buildings.slice().sort((a, b) => {
    const da = (a?.functions?.defense || a?.defense?.base || a?.defense?.perStep || a?.defense?.workerStep) ? 0 : 1;
    const db = (b?.functions?.defense || b?.defense?.base || b?.defense?.perStep || b?.defense?.workerStep) ? 0 : 1;
    return da - db;
  });

  for (const building of sortedBuildings) {
    const max = Math.max(0, this._safeNumber(building.workersMax, 0));
    if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
    while (building.assignedWorkerIds.length < max) building.assignedWorkerIds.push("");
    for (let slot = 0; slot < max; slot += 1) {
      if (building.assignedWorkerIds[slot]) continue;
      const candidates = people
        .filter((person) => !used.has(String(person.id)))
        .filter((person) => mode === "all" || ["", "Свободен", "Без работы", "Ребенок"].includes(String(person?.workAssignment || person?.role || "")))
        .filter((person) => this._isCivilianWorkerCandidate(person, building))
        .map((person) => ({ person, score: this._buildingAssignmentScore(holding, building, person) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score || String(a.person.name ?? "").localeCompare(String(b.person.name ?? ""), "ru"));
      const pick = candidates[0]?.person;
      if (!pick) continue;
      building.assignedWorkerIds[slot] = String(pick.id);
      pick.workAssignment = String(building.id);
      pick.role = building.workerRole || building.name || "Работает в здании";
      this._applyPersonSalaryForAssignment?.(holding, pick, building);
      used.add(String(pick.id));
      assigned += 1;
    }
  }
  return { assigned, cleared, message: assigned ? `Назначено работников: ${assigned}${cleared ? `, очищено старых слотов: ${cleared}` : ""}.` : "Подходящих свободных работников не найдено." };
},

async _onAutoAssignBuildingWorkers(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;
  const mode = String(event.currentTarget?.dataset?.mode ?? "free") === "all" ? "all" : "free";
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    const result = this._autoAssignWorkersToBuildings(holding, { mode });
    await SkyholdData.set(data);
    this.activeTab = "buildings";
    this.render({ force: true, focus: false });
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
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id ?? "") === buildingId);
  const line = building?.productionLines?.[lineIndex];
  if (!holding || !building || !line) return;
  const result = this._collectProductionLine(holding, building, line, { ignoreWorkTime: true });
  if (result?.ok) {
    const entries = Array.isArray(result.placements) && result.placements.length
      ? result.placements.map((item) => ({ kind: "collect", resourceId: result.resourceId, name: result.resourceName, qty: item.qty, roomId: item.roomId, source: result.source, note: item.overflowFrom ? `Ручной сбор, переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}` : "Ручной сбор" }))
      : [{ kind: "collect", resourceId: result.resourceId, name: result.resourceName, qty: result.qty, roomId: result.roomId, source: result.source, note: "Ручной сбор" }];
    this._appendStorageLog(holding, entries);
  }
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
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
  let assigned = 0;
  for (let slot = 0; slot < max; slot += 1) {
    if (building.assignedWorkerIds[slot]) continue;
    const candidates = people
      .filter((person) => !picked.has(String(person.id)))
      .filter((person) => !protectedIds.has(String(person.id)))
      .filter((person) => mode === "all" || ["", "Свободен", "Без работы", "Ребенок"].includes(String(person?.workAssignment || person?.role || "")))
      .filter((person) => this._isCivilianWorkerCandidate(person, building))
      .map((person) => ({ person, score: this._buildingAssignmentScore(holding, building, person) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || String(a.person.name ?? "").localeCompare(String(b.person.name ?? ""), "ru"));
    const pick = candidates[0]?.person;
    if (!pick) continue;
    if (mode === "all") this._setPersonFree(holding, pick.id);
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
    const confirmed = await this._confirmAction?.("Удалить здание", `Удалить «${name}»?`);
    if (!confirmed) return;
    holding.buildings.list = (holding.buildings.list ?? []).filter((item) => String(item.id ?? "") !== String(buildingId));
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
    ui.notifications.info(`Здание «${name}» удалено.`);
    return;
  }
  const result = action === "clear"
    ? this._clearBuildingWorkers(holding, buildingId)
    : this._fillBuildingWorkers(holding, buildingId, { mode: action === "fill-max" ? "all" : "free" });
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
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
  menu.className = "fbls-building-context-menu";
  menu.innerHTML = items.map((item) => `<button type="button" class="${item.danger ? "danger" : ""}" data-action="${item.action}"><i class="${item.icon}"></i><span>${item.label}</span></button>`).join("");
  const left = Math.max(8, Math.min(window.innerWidth - 280, Number(position?.x ?? 0)));
  const top = Math.max(8, Math.min(window.innerHeight - 220, Number(position?.y ?? 0)));
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

_onOpenBuildingEditor(event) {
  const target = event.target;
  if (this._buildingDragActive) return;
  if (target?.closest?.("button, input, textarea, select, a")) return;

  const buildingId = event.currentTarget?.dataset?.id;
  if (!buildingId) return;

  const editor = new SkyholdBuildingEditor({ holdingId: this.activeHoldingId, buildingId });
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
  window.setTimeout(() => { this._buildingDragActive = false; }, 40);
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
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => String(item.id) === String(this.activeHoldingId)) ?? data.holdings[0];
  const list = holding?.buildings?.list;
  if (!Array.isArray(list)) return;
  const from = list.findIndex((item) => String(item.id) === draggedId);
  const to = list.findIndex((item) => String(item.id) === targetId);
  if (from < 0 || to < 0 || from === to) return;
  const [row] = list.splice(from, 1);
  list.splice(to, 0, row);
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
},

async _onSuitableTypeAddChange(event) {
  event.preventDefault();
  if (!this._canEditBuildings()) return;
  const field = event.currentTarget;
  const path = field.dataset.suitableTypeAddField;
  const value = String(field.value ?? "").trim();
  if (!path || !value) return;
  try {
    const data = SkyholdData.get();
    const list = splitList(foundry.utils.getProperty(data, path));
    if (!list.some((item) => item.toLowerCase() === value.toLowerCase())) list.push(value);
    foundry.utils.setProperty(data, path, joinList(list));
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
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
    const data = SkyholdData.get();
    const list = splitList(foundry.utils.getProperty(data, path)).filter((item) => item.toLowerCase() !== value);
    foundry.utils.setProperty(data, path, joinList(list));
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
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
    const data = SkyholdData.get();
    if (parts) {
      const holding = data.holdings[Number(parts[1])];
      const building = holding?.buildings?.list?.[Number(parts[2])];
      this._setBuildingSlot(holding, building?.id, Number(parts[3]), field.value || "");
      await SkyholdData.set(data);
    } else {
      await SkyholdData.update(path, field.value || "");
    }
    this.render({ force: true, focus: false });
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
  const data = SkyholdData.get();
  const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
  if (holdingIndex < 0) return;
  const holding = data.holdings[holdingIndex];
  const template = (data.catalog?.buildings ?? []).find((item) => String(item.id) === templateId);
  if (!template) { ui.notifications.warn("Шаблон здания не найден."); return; }
  const templateState = this._buildingTemplateContext?.(holding, data)?.rows?.find((row) => String(row.id) === templateId);
  if (templateState && templateState.playerVisible === false && !game.user?.isGM) {
    ui.notifications.warn("Шаблон скрыт ГМом.");
    return;
  }
  if (templateState && !templateState.unlocked) {
    ui.notifications.warn(`Шаблон закрыт: ${templateState.reasonText || "требования не выполнены"}.`);
    return;
  }
  // Материалы больше не списываются при создании blueprint-проекта.
  // Проект можно поставить в очередь и дофармить недостающие ресурсы позже.
  if (!holding.buildings) holding.buildings = { list: [] };
  if (!Array.isArray(holding.buildings.list)) holding.buildings.list = [];
  const id = foundry.utils.randomID?.(12) ?? `b-${Date.now()}`;
  const building = this._buildingFromTemplate(template, id);
  holding.buildings.list.push(building);
  await SkyholdData.set(data);
  this.activeTab = "buildings";
  this.expandedBuildingId = id;
  this.render({ force: true, focus: false });
  ui.notifications.info(`${building.name} добавлено в проекты строительства.`);
},

_buildingFromTemplate(template = {}, id = "") {
  const templateCopy = foundry?.utils?.deepClone?.(template) ?? JSON.parse(JSON.stringify(template ?? {}));
  delete templateCopy.unlocked;
  delete templateCopy.locked;
  delete templateCopy.css;
  delete templateCopy.reasonText;
  return {
    id: id || foundry.utils.randomID?.(12) || `b-${Date.now()}`,
    templateId: String(template.id ?? ""),
    primaryDev: String(templateCopy.primaryDev ?? template.primaryDev ?? ""),
    sourceRequirement: String(templateCopy.sourceRequirement ?? ""),
    sourceRawMaterials: String(templateCopy.sourceRawMaterials ?? ""),
    specialRequirements: String(templateCopy.specialRequirements ?? ""),
    compendiumId: String(templateCopy.compendiumId ?? ""),
    name: String(templateCopy.name ?? "Новая постройка"),
    type: String(templateCopy.type ?? templateCopy.category ?? "Особые"),
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
    defense: templateCopy.defense ?? { base: 0, perStep: 0, workerStep: 0 },
    housing: templateCopy.housing ?? { capacity: 0, comfort: 0, quality: 0, notes: "" },
    storage: templateCopy.storage ?? { capacity: 0, security: 0, quality: 0 },
    religion: templateCopy.religion ?? { religious: false, faith: "", customFaith: "", notes: "" },
    reputation: Number(templateCopy.reputation ?? 0) || 0,
    moraleDelta: Number(templateCopy.moraleDelta ?? 0) || 0,
    upkeep: Number(templateCopy.upkeep ?? 0) || 0,
    materialCosts: Array.isArray(templateCopy.materialCosts) ? templateCopy.materialCosts : [],
    icon: String(templateCopy.icon ?? template.icon ?? "fa-solid fa-building"),
    img: String(templateCopy.img ?? templateCopy.image ?? template.img ?? template.image ?? ""),
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
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const building = holding?.buildings?.list?.find((item) => String(item.id) === buildingId);
  if (!building) return;
  building.constructionCrewId = crewId;
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
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

  const data = SkyholdData.get();
  const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
  if (holdingIndex < 0) return;
  const holding = data.holdings[holdingIndex];
  const building = (holding.buildings?.list ?? []).find((item) => String(item.id) === buildingId);
  if (!building) return;

  const costs = this._buildingMaterialCostsForAllocation(building);
  if (!costs.length) {
    ui.notifications.info("У здания нет материальных затрат.");
    return;
  }
  if (building.materialsAllocated) {
    ui.notifications.info("Материалы для этого здания уже выделены.");
    return;
  }

  const canPay = this._storageCanPay?.(holding, costs);
  if (!canPay?.ok) {
    const missing = (canPay?.missing ?? []).map((item) => `${item.name || item.resourceId}: нужно ${item.qty}, есть ${this._formatNumber ? this._formatNumber(item.have) : item.have}`).join("; ");
    ui.notifications.warn(`Не хватает материалов: ${missing || "неизвестно"}.`);
    return;
  }

  this._storagePay(holding, costs);
  building.materialsAllocated = true;
  building.materialsAllocatedAt = new Date().toISOString();
  building.materialsAllocatedLine = costs.map((item) => `${item.qty} ${item.name}`).join(" · ");

  await SkyholdData.set(data);
  ui.notifications.info(`Материалы выделены: ${building.name || "здание"}.`);
  this.render({ force: true, focus: false });
},

async _onRollConstructionCrew(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding) return;

  const crewId = event.currentTarget?.dataset?.crewId || null;
  const crew = this._constructionCrew(holding, crewId);
  if (!crew.count || !crew.dice) {
    ui.notifications.warn("Стройбригада пуста.");
    return;
  }

  const dicePool = Math.max(1, crew.dice);
  const firstRolls = rollD6Pool(dicePool);
  const reroll = applyBuilderRerollIfAvailable(holding, crew, dicePool, firstRolls);
  const rolls = reroll.rolls;
  const successes = rolls.filter((value) => value >= 6).length;
  const diceText = diceTextHtml(rolls);
  const details = crew.members.map((person) => `<li>${escapeHtml(person.name)}: ${person.contribution}к6${person.contributionReasons ? ` — ${escapeHtml(person.contributionReasons)}` : ""}</li>`).join("");
  if (reroll.used) await SkyholdData.set(data);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>${escapeHtml(crew.name || "Стройбригада")}</h3>
        <p><strong>Пул:</strong> ${crew.rawDice}к6, довольство ${crew.moraleMod > 0 ? "+" : ""}${crew.moraleMod} (${escapeHtml(crew.moraleReason)}) = ${crew.dice}к6</p>
        <p><strong>Кости:</strong> ${diceText}</p>
        <p><strong>Успехи:</strong> ${successes}</p>
        ${reroll.note ? `<p><strong>Builder:</strong> ${escapeHtml(reroll.note)}</p>` : ""}
        ${details ? `<ul>${details}</ul>` : ""}
      </div>
    `
  });
},

async _onRollConstruction(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canEditBuildings()) return;

  const buildingId = event.currentTarget?.dataset?.id;
  if (!buildingId) return;

  const data = SkyholdData.get();
  const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
  if (holdingIndex < 0) return;
  const holding = data.holdings[holdingIndex];
  const buildingIndex = (holding.buildings?.list ?? []).findIndex((item) => item.id === buildingId);
  if (buildingIndex < 0) return;
  const building = holding.buildings.list[buildingIndex];

  const materialCosts = this._buildingMaterialCostsForAllocation?.(building) ?? [];
  if (materialCosts.length && !building.materialsAllocated) {
    ui.notifications.warn("Сначала выдели материалы для постройки.");
    return;
  }

  const crewId = event.currentTarget?.dataset?.crewId || building.constructionCrewId || null;
  const crew = this._constructionCrew(holding, crewId);
  if (!crew.count || !crew.dice) {
    ui.notifications.warn("Стройбригада пуста. Назначь жителям работу вроде “Стройбригада”, “строитель”, “ремонтник” или “механик”.");
    return;
  }

  const difficulty = this._safeNumber(building.buildDifficulty, 0);
  const dicePool = Math.max(1, crew.dice + difficulty);
  const firstRolls = rollD6Pool(dicePool);
  const reroll = applyBuilderRerollIfAvailable(holding, crew, dicePool, firstRolls);
  const rolls = reroll.rolls;
  const successes = rolls.filter((value) => value >= 6).length;
  const oldProgress = this._safeNumber(building.buildProgress, 0);
  const target = Math.max(1, this._safeNumber(building.buildTarget, 6));
  const nextProgress = Math.min(target, oldProgress + successes);
  building.buildProgress = nextProgress;
  if (nextProgress >= target) {
    building.constructionStatus = "built";
    building.status = "Построено";
  } else if (building.constructionStatus === "planned") {
    building.constructionStatus = "building";
    building.status = "Строится";
  }

  await SkyholdData.set(data);

  const diceText = diceTextHtml(rolls);
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>Строительство: ${escapeHtml(building.name)}</h3>
        <p><strong>Стройбригада:</strong> ${escapeHtml(crew.names)}</p>
        <p><strong>Пул:</strong> ${crew.rawDice}к6, довольство ${crew.moraleMod > 0 ? "+" : ""}${crew.moraleMod} (${escapeHtml(crew.moraleReason)})${difficulty ? `, сложность ${difficulty > 0 ? "+" : ""}${difficulty}` : ""} = ${dicePool}к6</p>
        <p><strong>Кости:</strong> ${diceText}</p>
        <p><strong>Успехи:</strong> ${successes}. Прогресс: ${oldProgress} → ${nextProgress} / ${target}</p>
        ${reroll.note ? `<p><strong>Builder:</strong> ${escapeHtml(reroll.note)}</p>` : ""}
        ${nextProgress >= target ? "<p><strong>Постройка завершена.</strong></p>" : ""}
      </div>
    `
  });

  this.activeTab = "buildings";
  this.expandedBuildingId = null;
  this.render({ force: true, focus: false });
}
};
