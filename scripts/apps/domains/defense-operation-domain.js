import { resourceLabel } from "../../core/resources.js";
import { hiddenStorageRoomIds } from "../../data/access-guard.js";
import { MANAGER_SQUAD_TYPE_PROFILES } from "../../data/military-resident-rules.js";
import { isResidentInPopulation } from "../../data/resident-presence.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { indexStorageRows, resolveStorageRow } from "../../engines/storage/row-identity.js";

export const DEFENSE_ARMAMENT_IDS = Object.freeze(["armament-simple", "armament-complex", "armament-elite"]);
export const DEFENSE_OPERATIONS = new Set([
  "assignDefenseArmament", "unassignDefenseArmament", "disbandDefenseSquad", "fillDefenseSquad", "editDefense"
]);
export const DEFENSE_SQUAD_CHANGED = "Отряд изменился или недоступен. Откройте действие заново.";

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

function fillDefenseSquad(holding, squad, logic) {
  const defense = holding.gm.defense;
  const squadType = squad.type === "militia" ? "line" : squad.type ?? "line";
  const taken = new Set([defense.commanderId, ...defense.squads.filter((other) => other !== squad)
    .flatMap((other) => [other.sergeantId, ...(other.memberIds ?? []).slice(0, 4)])].filter(Boolean).map(String));
  const candidates = (holding.people?.list ?? [])
    .filter((person) => person && isResidentInPopulation(person, holding) && !logic._isResidentInjured(person))
    .filter((person) => !logic._isChildResident(person) && logic._isSuitableForSquadType(person, squadType)
      && !taken.has(String(person.id)))
    .map((person) => {
      const efficiency = Number(logic._soldierEfficiency(person, squadType));
      const sergeant = logic._isSergeantCandidate(person);
      const military = logic._isMilitaryBackgroundResident(person) ? 0.35 : 0;
      const soldier = logic._isSoldierResident(person) ? 0.25 : 0;
      const free = !String(person.workAssignment ?? "").trim() ? 0.05 : 0;
      const score = (Number.isFinite(efficiency) ? efficiency : 0) + (sergeant ? 0.35 : 0) + military + soldier + free;
      return { person, score, sergeant };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const first = candidates.find((entry) => entry.sergeant) ?? candidates[0];
  if (!first) return { ok: false, message: "Нет подходящих жителей для этого типа отряда." };
  const selected = new Map([[String(first.person.id), first.person]]);
  for (const { person } of candidates) {
    if (selected.size >= 5) break;
    const id = String(person.id);
    if (!selected.has(id)) selected.set(id, person);
  }
  for (const person of selected.values()) {
    logic._clearPersonFromAssignments(holding, person.id);
    person.workAssignment = "soldier";
    if (!/^\s*(солдат|сержант)\b/i.test(String(person.role ?? ""))) person.role = "Солдат";
  }
  const [firstId, ...memberIds] = selected.keys();
  squad.sergeantId = firstId;
  squad.memberIds = Array.from({ length: 4 }, (_, index) => memberIds[index] ?? "");
  logic._sanitizeDefenseAssignments(holding);
  logic._applyDefenseSalaries(holding);
  return { ok: true, message: "Состав отряда обновлён." };
}

function editDefense(holding, squad, operation, logic) {
  const { field, value, expectedValue } = operation;
  const [key, slot] = field.split(".");
  const target = slot !== undefined ? squad.memberIds : (squad ?? holding.gm.defense);
  const property = slot ?? key;
  const before = String(target[property] ?? "");
  if (before === value) return { ok: true, unchanged: true };
  if (!squad && before !== expectedValue) return { ok: false, message: "План обороны изменился. Обновите окно." };
  target[property] = value;
  if (field !== "notes") {
    logic._sanitizeDefenseAssignments(holding);
    const after = slot !== undefined ? squad.memberIds[slot] : target[property];
    if (after !== value) return { ok: false, message: "Назначение недоступно. Сверьте состав обороны." };
    logic._applyDefenseSalaries(holding);
  }
  return { ok: true, message: "План обороны обновлён." };
}

export function applyDefenseOperation(holding, operation, { requester, logic }) {
  const { type, operationId, squadId, expectedSquadHash, resourceId } = operation;
  const squads = holding.gm?.defense?.squads ?? [];
  const { row: squad } = squadId ? resolveStorageRow(squads, squadId) : { row: null };
  if (squadId && (!squad || stableDataHash(squad) !== expectedSquadHash)) return { ok: false, message: DEFENSE_SQUAD_CHANGED };
  if (type === "editDefense") return editDefense(holding, squad, operation, logic);
  if (type === "fillDefenseSquad") return fillDefenseSquad(holding, squad, logic);

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
