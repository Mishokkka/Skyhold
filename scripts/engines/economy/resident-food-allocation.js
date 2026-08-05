import { foodProvisionDaily, normalizeFoodProvisionMode } from "../../data/food-provision.js";

const RECEIPT_LIMIT = 32;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function allocationState(holding) {
  if (!holding.gm || typeof holding.gm !== "object" || Array.isArray(holding.gm)) holding.gm = {};
  if (!holding.gm.economy || typeof holding.gm.economy !== "object" || Array.isArray(holding.gm.economy)) holding.gm.economy = {};
  const source = holding.gm.economy.foodAllocation;
  const state = source && typeof source === "object" && !Array.isArray(source) ? source : {};
  holding.gm.economy.foodAllocation = {
    cursorResidentId: String(state.cursorResidentId ?? ""),
    receipts: Array.isArray(state.receipts) ? state.receipts.slice(-RECEIPT_LIMIT) : []
  };
  return holding.gm.economy.foodAllocation;
}

function rotated(rows, cursorResidentId = "") {
  if (!rows.length) return [];
  const index = rows.findIndex((row) => row.id === cursorResidentId);
  const start = index >= 0 ? index : 0;
  return [...rows.slice(start), ...rows.slice(0, start)];
}

function inputFingerprint({ days, eatenPersonDays, targetQd, residents }) {
  return JSON.stringify({
    days,
    eatenPersonDays,
    targetQd,
    residents: residents.map((row) => [row.id, row.mode, row.daily])
  });
}

export function settleResidentFood({
  holding,
  days = 10,
  eatenPersonDays = 0,
  targetQd = 0,
  operationId = ""
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Resident food allocation requires a holding draft.");
  const wholeDays = Math.max(0, Math.floor(finite(days, 0)));
  const periods = Math.floor(wholeDays / 10);
  const residents = (holding?.people?.list ?? [])
    .filter((person) => person && !person.dead)
    .map((person) => {
      const id = String(person.id ?? "").trim();
      const mode = normalizeFoodProvisionMode(person.foodProvisionMode, { boardFoodDaily: person.boardFoodDaily });
      return { person, id, name: String(person.name ?? (id || "Житель")), mode, daily: foodProvisionDaily(person) };
    })
    .filter((row) => row.id)
    .sort((left, right) => left.id.localeCompare(right.id, "ru"));
  const provided = residents.filter((row) => row.daily > 0);
  const normalizedEaten = Math.max(0, finite(eatenPersonDays, 0));
  const normalizedTargetQd = Math.max(0, Math.floor(finite(targetQd, 0)));
  const normalizedOperationId = String(operationId ?? "").trim();
  const fingerprint = inputFingerprint({
    days: wholeDays,
    eatenPersonDays: normalizedEaten,
    targetQd: normalizedTargetQd,
    residents
  });
  const state = allocationState(holding);
  if (normalizedOperationId) {
    const prior = state.receipts.find((receipt) => receipt?.operationId === normalizedOperationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error(`FBL Skyhold | Conflicting resident food allocation operation: ${normalizedOperationId}`);
      return { ...clone(prior.result), replayed: true };
    }
  }

  const priority = rotated(provided, state.cursorResidentId);
  const totalRequired = priority.reduce((sum, row) => sum + row.daily * wholeDays, 0);
  let remaining = Math.min(totalRequired, normalizedEaten);
  const rows = [];
  let fullyFedCount = 0;
  for (const row of priority) {
    const required = row.daily * wholeDays;
    const eaten = Math.min(required, remaining);
    remaining -= eaten;
    const fullyFed = eaten + 1e-9 >= required;
    const hungerBefore = Math.max(0, Math.floor(finite(row.person.hungerStreakTendays, 0)));
    const hungerAfter = periods > 0 ? (fullyFed ? 0 : hungerBefore + periods) : hungerBefore;
    row.person.hungerStreakTendays = hungerAfter;
    if (fullyFed) fullyFedCount += 1;
    rows.push({
      personId: row.id,
      name: row.name,
      mode: row.mode,
      requiredPersonDays: required,
      eatenPersonDays: eaten,
      missingPersonDays: Math.max(0, required - eaten),
      fullyFed,
      hungerBefore,
      hungerAfter
    });
  }

  for (const row of residents.filter((resident) => resident.daily <= 0)) {
    const hungerBefore = Math.max(0, Math.floor(finite(row.person.hungerStreakTendays, 0)));
    if (periods > 0) row.person.hungerStreakTendays = 0;
    rows.push({
      personId: row.id,
      name: row.name,
      mode: row.mode,
      requiredPersonDays: 0,
      eatenPersonDays: 0,
      missingPersonDays: 0,
      fullyFed: true,
      hungerBefore,
      hungerAfter: row.person.hungerStreakTendays
    });
  }

  if (priority.length) {
    const advance = totalRequired > normalizedEaten ? Math.max(1, fullyFedCount) : priority.length;
    state.cursorResidentId = priority[advance % priority.length].id;
  } else {
    state.cursorResidentId = "";
  }
  rows.sort((left, right) => left.personId.localeCompare(right.personId, "ru"));
  const result = {
    targetQd: normalizedTargetQd,
    days: wholeDays,
    requiredPersonDays: totalRequired,
    eatenPersonDays: Math.min(totalRequired, normalizedEaten),
    missingPersonDays: Math.max(0, totalRequired - normalizedEaten),
    fullyFedResidents: rows.filter((row) => row.fullyFed).length,
    hungryResidents: rows.filter((row) => !row.fullyFed).length,
    cursorResidentId: state.cursorResidentId,
    rows,
    replayed: false
  };
  if (normalizedOperationId) {
    state.receipts.push({ operationId: normalizedOperationId, fingerprint, result: clone(result) });
    state.receipts = state.receipts.slice(-RECEIPT_LIMIT);
  }
  return result;
}
