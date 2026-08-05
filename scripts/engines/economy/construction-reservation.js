import {
  CONSTRUCTION_RESERVATION_VERSION,
  validConstructionReservation
} from "../../data/construction-reservation.js";
import { validateConstructionRecipe } from "../../core/economy-quantity-contract.js";

export { CONSTRUCTION_RESERVATION_VERSION, validConstructionReservation } from "../../data/construction-reservation.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
}

function amount(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedRoomId(value = "") {
  return text(value) || "outdoors";
}

function recipeRows(costs = []) {
  return (Array.isArray(costs) ? costs : [])
    .map((row, index) => {
      const normalized = {
        id: text(row?.id) || `material-${index + 1}`,
        resourceId: text(row?.resourceId ?? row?.resource ?? row?.name),
        resourceGroup: text(row?.resourceGroup),
        name: text(row?.name ?? row?.label ?? row?.resourceId) || "Материал",
        qty: whole(row?.qty ?? row?.quantity)
      };
      if (row?.roomId !== undefined || row?.storageRoomId !== undefined) {
        normalized.roomId = normalizedRoomId(row?.roomId ?? row?.storageRoomId);
      }
      return normalized;
    })
    .filter((row) => row.qty > 0);
}

function dependenciesForReservation(dependencies = {}) {
  for (const name of ["planCosts", "takeResourceLots"]) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Construction reservation requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function rowIdentity(row = {}, index = -1) {
  return {
    storageRowId: text(row?.id),
    storageRowIndex: index,
    resourceId: text(row?.resourceId ?? row?.id ?? "custom"),
    name: text(row?.name ?? row?.label ?? row?.resourceId) || "Материал",
    roomId: normalizedRoomId(row?.roomId ?? row?.storageRoomId)
  };
}

function plannedStorageRow(holding = {}, cost = {}) {
  const rows = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const plannedIndex = Number(cost?.storageRowIndex);
  const plannedId = text(cost?.storageRowId);
  if (Number.isInteger(plannedIndex) && plannedIndex >= 0 && plannedIndex < rows.length) {
    const row = rows[plannedIndex];
    if (!plannedId || text(row?.id) === plannedId) return { row, index: plannedIndex };
  }
  if (plannedId) {
    const index = rows.findIndex((row) => text(row?.id) === plannedId);
    if (index >= 0) return { row: rows[index], index };
  }
  return { row: null, index: -1 };
}

function aggregateConcreteCosts(holding = {}, costs = []) {
  const grouped = new Map();
  const missingSources = [];
  for (const cost of Array.isArray(costs) ? costs : []) {
    const qty = whole(cost?.qty);
    if (!qty) continue;
    const resolved = plannedStorageRow(holding, cost);
    if (!resolved.row) {
      missingSources.push({ ...clone(cost), qty });
      continue;
    }
    const identity = rowIdentity(resolved.row, resolved.index);
    const key = `${identity.storageRowId || `#${identity.storageRowIndex}`}|${identity.roomId}`;
    const current = grouped.get(key) ?? { ...identity, qty: 0, costIds: [] };
    current.qty += qty;
    const costId = text(cost?.id);
    if (costId && !current.costIds.includes(costId)) current.costIds.push(costId);
    grouped.set(key, current);
  }
  return {
    sources: [...grouped.values()].sort((left, right) => (
      left.storageRowIndex - right.storageRowIndex
      || left.storageRowId.localeCompare(right.storageRowId, "ru")
    )),
    missingSources
  };
}

export function reserveConstructionMaterials({
  holding,
  building,
  costs = null,
  operationId = "",
  reservedAt = "",
  reservedQd = null,
  replacePriorAllocation = false,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object" || !building || typeof building !== "object") {
    throw new TypeError("FBL Skyhold | Construction reservation requires a holding and building draft.");
  }
  const deps = dependenciesForReservation(dependencies);
  const id = text(operationId);
  if (!id) throw new TypeError("FBL Skyhold | Construction reservation requires operationId.");

  const existing = building?.constructionReservation;
  const existingIsConsumed = text(existing?.status) === "consumed";
  if (validConstructionReservation(building)) {
    if (text(existing.operationId) === id) {
      return { ok: true, replay: true, changed: false, reservation: clone(existing) };
    }
    if (!(replacePriorAllocation && existingIsConsumed)) {
      return {
        ok: false,
        conflict: true,
        code: "already-reserved",
        message: "Материалы проекта уже зарезервированы другой операцией.",
        reservation: clone(existing)
      };
    }
    // A completed construction/repair snapshot is immutable provenance, but
    // a later repair may replace it only after a new full reservation succeeds.
  }
  if (building?.materialsAllocated && !replacePriorAllocation) {
    return {
      ok: false,
      legacy: true,
      code: "legacy-allocation",
      message: "У проекта уже есть legacy-отметка выделенных материалов; повторное списание запрещено."
    };
  }

  const recipeValidation = validateConstructionRecipe(costs ?? building?.materialCosts);
  if (!recipeValidation.ok) {
    return { ok: false, code: "fractional-recipe", message: "Economy V2 резервирует только целые единицы материалов." };
  }
  const recipe = recipeRows(costs ?? building?.materialCosts);
  if (!recipe.length) return { ok: false, code: "empty-recipe", message: "У проекта нет материального рецепта." };

  const plan = deps.planCosts({ holding, costs: recipe });
  if (!plan?.ok) {
    return { ok: false, code: "insufficient-materials", missing: clone(plan?.missing ?? []), message: "Не хватает материалов для проекта." };
  }
  const concrete = aggregateConcreteCosts(holding, plan?.costs ?? []);
  if (concrete.missingSources.length) {
    return { ok: false, code: "stale-plan", missing: clone(concrete.missingSources), message: "Источник материалов изменился; подготовьте резерв заново." };
  }
  for (const source of concrete.sources) {
    const row = holding.storage.resources[source.storageRowIndex];
    if (!row || whole(row?.qty) < source.qty) {
      return { ok: false, code: "stale-plan", missing: [clone(source)], message: "Запас изменился; подготовьте резерв заново." };
    }
  }

  const sources = [];
  for (const source of concrete.sources) {
    const row = holding.storage.resources[source.storageRowIndex];
    const lots = deps.takeResourceLots(holding, row, source.qty);
    sources.push({
      ...source,
      qty: source.qty,
      lots: Array.isArray(lots) ? clone(lots) : [],
      untrackedQty: Math.max(0, source.qty - (Array.isArray(lots) ? lots.reduce((sum, lot) => sum + amount(lot?.qty), 0) : 0))
    });
  }

  const reservation = {
    version: CONSTRUCTION_RESERVATION_VERSION,
    operationId: id,
    status: "reserved",
    reservedAt: text(reservedAt),
    reservedQd: reservedQd === null || reservedQd === undefined ? null : whole(reservedQd),
    recipe: clone(recipe),
    concreteCosts: clone(plan?.costs ?? []),
    sources
  };
  building.constructionReservation = reservation;
  building.materialsAllocated = true;
  building.materialsAllocatedAt = reservation.reservedAt;
  building.materialsAllocatedLine = recipe.map((row) => `${row.qty} ${row.name}`).join(" · ");
  return { ok: true, replay: false, changed: true, reservation: clone(reservation) };
}
