import { resourceLabel } from "../../core/resources.js";
import { hiddenBuildingIds, hiddenStorageRoomIds, residentHasHiddenWork } from "../../data/access-guard.js";
import { evaluateDefenseSquad, isAvailableDefenseResident, MANAGER_SQUAD_TYPE_PROFILES } from "../../data/military-resident-rules.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { indexStorageRows, resolveStorageRow } from "../../engines/storage/row-identity.js";

export const DEFENSE_ARMAMENT_IDS = Object.freeze(["armament-simple", "armament-complex", "armament-elite"]);
export const DEFENSE_OPERATIONS = new Set([
  "assignDefenseArmament", "unassignDefenseArmament", "disbandDefenseSquad", "fillDefenseSquad", "editDefense"
]);
export const DEFENSE_SQUAD_CHANGED = "Отряд изменился или недоступен. Откройте действие заново.";

function squadResidentIds(squad) {
  return [squad.sergeantId, ...(squad.memberIds ?? []).slice(0, 4)].filter(Boolean).map(String);
}

export function canEnrollDefenseResident(holding, person, hiddenBuildings) {
  return isAvailableDefenseResident(person, holding) && !residentHasHiddenWork(holding, person, hiddenBuildings);
}

export function normalizeDefenseOperation(raw, common) {
  const squadId = String(raw.squadId ?? "");
  const expectedSquadHash = String(raw.expectedSquadHash ?? "");
  const invalid = () => new Error("FBL Skyhold | Некорректная команда управления обороной.");
  if (squadId ? !/^[a-z0-9]{1,7}$/.test(expectedSquadHash) : common.type !== "editDefense") throw invalid();
  if (common.type === "editDefense") {
    const field = String(raw.field ?? "");
    const value = String(raw.value ?? "");
    const squadField = /^(name|type|notes|sergeantId|memberIds\.[0-3])$/.test(field);
    if (squadId ? !squadField : !["commanderId", "notes"].includes(field)) throw invalid();
    if (field === "type" && !Object.hasOwn(MANAGER_SQUAD_TYPE_PROFILES, value)) throw invalid();
    return { ...common, squadId, expectedSquadHash, field, value, expectedValue: String(raw.expectedValue ?? "") };
  }
  if (common.type === "assignDefenseArmament") {
    const resourceId = String(raw.resourceId ?? "");
    if (!DEFENSE_ARMAMENT_IDS.includes(resourceId)) throw invalid();
    return { ...common, squadId, expectedSquadHash, resourceId };
  }
  return { ...common, squadId, expectedSquadHash };
}

function returnArmament(holding, squad, operationId, note, logic) {
  const resourceId = squad.armamentResourceId;
  const placements = logic._storageAddWithOverflow(holding, {
    resourceId, roomId: squad.armamentSourceRoomId || "outdoors"
  }, 1);
  if (placements.reduce((sum, row) => sum + row.qty, 0) !== 1) {
    throw new Error("Не удалось вернуть комплект вооружения на склад.");
  }
  logic._appendStorageLog(holding, placements.map((row) => ({
    kind: "military-armament-return", resourceId, name: resourceLabel(resourceId),
    qty: row.qty, roomId: row.roomId, source: squad.name || "Отряд", note, operationId
  })));
}

function fillDefenseSquad(holding, squad, logic, hiddenBuildings) {
  const defense = holding.gm.defense;
  const squadType = squad.type === "militia" ? "line" : squad.type ?? "line";
  const taken = new Set([String(defense.commanderId ?? ""), ...defense.squads.filter((other) => other !== squad).flatMap(squadResidentIds)]);
  const existing = new Set(squadResidentIds(squad));
  const byId = indexStorageRows(holding.people?.list);
  const candidates = [...byId.entries()]
    .filter(([id, person]) => !taken.has(id) && canEnrollDefenseResident(holding, person, hiddenBuildings))
    .map(([id, resident]) => {
      const efficiency = logic._soldierEfficiency(resident, squadType);
      const free = logic._hasSoldierProfession(resident) || (!resident.workAssignment && !resident.staffAppointment
        && !(resident.workAllocationMode === "explicit" && resident.workAllocations?.some((work) => work.normalQd || work.overtimeQd)));
      return { id, efficiency, kept: Number(existing.has(id)), free: Number(free) };
    })
    .filter((entry) => entry.efficiency > 0)
    .sort((a, b) => b.efficiency - a.efficiency || b.kept - a.kept || b.free - a.free || a.id.localeCompare(b.id));
  if (!candidates.length) return { ok: false, message: "Нет подходящих жителей для этого типа отряда." };
  let best;
  // For a given first slot the remaining seats are additive. Try every leader
  // with the best four other candidates, including the real sergeant bonus.
  for (const first of candidates) {
    const selected = [first];
    for (const candidate of candidates) {
      if (candidate !== first) selected.push(candidate);
      if (selected.length === 5) break;
    }
    const memberIds = selected.slice(1).map(({ id }) => id);
    const { effective } = evaluateDefenseSquad({ type: squadType, sergeantId: first.id, memberIds }, byId);
    const rank = [effective, selected.reduce((sum, row) => sum + row.kept, 0),
      selected.reduce((sum, row) => sum + row.free, 0), Number(squad.sergeantId === first.id)];
    if (!best || rank.map((value, index) => value - best.rank[index]).find(Boolean) > 0) {
      best = { rank, firstId: first.id, memberIds, selected };
    }
  }
  for (const { id, kept } of best.selected) if (!kept) logic._clearPersonFromAssignments(holding, id);
  squad.sergeantId = best.firstId;
  squad.memberIds = Array.from({ length: 4 }, (_, index) => best.memberIds[index] ?? "");
  logic._applyDefenseSalaries(holding);
  return { ok: true, message: "Состав отряда обновлён." };
}

function editDefense(holding, squad, operation, logic, hiddenBuildings) {
  const { field, value, expectedValue } = operation;
  const [key, slot] = field.split(".");
  const defense = holding.gm.defense;
  const target = () => slot !== undefined ? squad.memberIds : (squad ?? defense);
  const property = slot ?? key;
  const before = String(target()[property] ?? "");
  if (before === value) return { ok: true, unchanged: true };
  if (!squad && before !== expectedValue) return { ok: false, message: "План обороны изменился. Обновите окно." };
  if (value && (slot !== undefined || key === "sergeantId" || key === "commanderId")) {
    const candidates = (holding.people?.list ?? []).filter((person) => String(person.id ?? "") === value);
    const [person] = candidates;
    if (candidates.length !== 1 || !canEnrollDefenseResident(holding, person, hiddenBuildings)) {
      return { ok: false, message: "Житель отсутствует или недоступен для назначения. Обновите окно." };
    }
    const assigned = String(defense.commanderId ?? "") === value || defense.squads.some((entry) => squadResidentIds(entry).includes(value));
    const qualified = key === "commanderId" ? logic._isCommanderCandidate(person)
      : logic._hasSoldierProfession(person) && logic._isSuitableForSquadType(person, squad.type);
    if (assigned || !qualified) return { ok: false, message: "Назначение недоступно. Сверьте состав обороны." };
    logic._clearPersonFromAssignments(holding, person.id);
  }
  if (field === "type") {
    const assigned = new Set(squadResidentIds(squad));
    const incompatible = (holding.people?.list ?? []).some((person) => assigned.has(String(person.id))
      && !logic._isSuitableForSquadType(person, value));
    if (incompatible) return { ok: false, message: "В составе есть бойцы, не подходящие для нового типа. Сначала освободите их места." };
  }
  target()[property] = value;
  if (field !== "notes") logic._applyDefenseSalaries(holding);
  return { ok: true, message: "План обороны обновлён." };
}

export function applyDefenseOperation(holding, operation, { requester, logic }) {
  const { type, operationId, squadId, expectedSquadHash, resourceId } = operation;
  const squads = holding.gm?.defense?.squads ?? [];
  const { row: squad } = squadId ? resolveStorageRow(squads, squadId) : { row: null };
  if (squadId && (!squad || stableDataHash(squad) !== expectedSquadHash)) return { ok: false, message: DEFENSE_SQUAD_CHANGED };
  if (type === "editDefense" || type === "fillDefenseSquad") {
    const hiddenBuildings = hiddenBuildingIds(holding, requester.isGM);
    return type === "editDefense" ? editDefense(holding, squad, operation, logic, hiddenBuildings)
      : fillDefenseSquad(holding, squad, logic, hiddenBuildings);
  }

  if (type === "assignDefenseArmament") {
    if (squad.armamentResourceId === resourceId) return { ok: true, unchanged: true };
    const hiddenRooms = hiddenStorageRoomIds(holding, requester.isGM);
    const stockById = indexStorageRows(holding.storage?.resources);
    const payment = logic._storagePay(holding, [{ resourceId, qty: 1 }], {
      eligibleResourceRow: (row) => stockById.get(String(row.id ?? "")) === row
        && !hiddenRooms.has(logic._normalizeStorageRoomId(row.roomId ?? row.storageRoomId))
    });
    if (!payment.ok) return { ok: false, message: "На доступном складе нет свободной единицы выбранного вооружения." };
    logic._appendStorageLog(holding, payment.costs.map((row) => ({
      kind: "military-armament-assign", resourceId, name: resourceLabel(resourceId),
      qty: -row.qty, roomId: row.roomId, source: squad.name || "Отряд", note: "Комплект закреплён за отрядом", operationId
    })));
    if (squad.armamentResourceId) returnArmament(holding, squad, operationId, "Прежний комплект возвращён при замене", logic);
    squad.armamentResourceId = resourceId;
    squad.armamentSourceRoomId = payment.costs[0].roomId;
    squad.equipped = true;
    return { ok: true, message: "Комплект вооружения закреплён за отрядом." };
  }

  if (type === "disbandDefenseSquad") {
    if (squad.armamentResourceId) returnArmament(holding, squad, operationId, "Комплект возвращён при расформировании отряда", logic);
    squads.splice(squads.indexOf(squad), 1);
    logic._applyDefenseSalaries(holding);
    return { ok: true, message: "Отряд расформирован." };
  }

  if (!squad.armamentResourceId) return { ok: false, message: "У отряда нет закреплённого вооружения." };
  returnArmament(holding, squad, operationId, "Комплект снят с отряда", logic);
  squad.armamentResourceId = "";
  squad.armamentSourceRoomId = "outdoors";
  squad.equipped = false;
  return { ok: true, message: "Комплект вооружения возвращён на склад." };
}
