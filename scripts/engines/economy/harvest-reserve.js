import {
  ALBUGRIR_QD_PER_DAY,
  ALBUGRIR_QD_PER_YEAR,
  albugrirCalendarDay
} from "../../core/albugrir-calendar.js";
import { productionCadenceWindow } from "../../core/production-cadence.js";
import { normalizeResourceLots, storageQualityEffectiveShelfLifeDays } from "../../core/resource-lots.js";
import { effectiveConsumerRationPoints } from "../resource-ration-points.js";

const EPSILON = 0.000001;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : Math.max(0, Number(fallback) || 0);
}

function normalizedQd(value = 0) {
  return Math.max(0, Math.floor(finiteNonNegative(value, 0)));
}

function isShadowQd(qd = 1) {
  return albugrirCalendarDay(Math.ceil(Math.max(1, normalizedQd(qd)) / ALBUGRIR_QD_PER_DAY)).shadowDay;
}

function firstCollectionQd(productionQd, line = {}) {
  let qd = normalizedQd(productionQd);
  if (line?.requiresCollection) qd += 1;
  if (line?.daylightCollectionOnly) {
    while (isShadowQd(qd)) qd += 1;
  }
  return qd;
}

function grainLine(line = {}) {
  const id = String(line?.resourceId ?? line?.resource ?? "").trim().toLowerCase();
  return line?.active !== false && (id === "grain" || id === "зерно");
}

function nextSummerCadenceQd(line = {}, currentQd = 0, horizonQd = ALBUGRIR_QD_PER_YEAR) {
  const start = normalizedQd(currentQd);
  const limit = start + Math.max(1, normalizedQd(horizonQd));
  for (let qd = start + 1; qd <= limit; qd += 1) {
    if (!productionCadenceWindow(line, qd).due) continue;
    const day = albugrirCalendarDay(Math.ceil(qd / ALBUGRIR_QD_PER_DAY));
    if (day.technicalSeasonKey === "summer") return qd;
  }
  return null;
}

export function nextGrainHarvest({
  currentQd = 0,
  fields = [],
  grainFoodValue = 0,
  horizonQd = ALBUGRIR_QD_PER_YEAR
} = {}) {
  const startQd = normalizedQd(currentQd);
  const candidates = [];
  let fieldCount = 0;
  let staffedFieldCount = 0;

  for (const field of Array.isArray(fields) ? fields : []) {
    const lines = (Array.isArray(field?.productionLines) ? field.productionLines : []).filter(grainLine);
    if (!lines.length) continue;
    fieldCount += 1;
    const effectiveWorkers = finiteNonNegative(field?.effectiveWorkers, 0);
    if (effectiveWorkers <= EPSILON) continue;
    staffedFieldCount += 1;
    for (const line of lines) {
      const pendingQty = finiteNonNegative(line?.pendingQty, 0);
      const productionQd = pendingQty > EPSILON
        ? startQd
        : nextSummerCadenceQd(line, startQd, horizonQd);
      if (productionQd === null) continue;
      const availableQd = pendingQty > EPSILON
        ? firstCollectionQd(startQd, line)
        : firstCollectionQd(productionQd, line);
      candidates.push({
        fieldId: String(field?.id ?? ""),
        fieldName: String(field?.name ?? "Поле"),
        availableQd,
        productionQd,
        expectedQty: pendingQty > EPSILON ? pendingQty : finiteNonNegative(field?.expectedQty, 0),
        pending: pendingQty > EPSILON
      });
    }
  }

  if (!candidates.length) {
    return {
      hasHarvest: false,
      fieldCount,
      staffedFieldCount,
      reason: fieldCount ? "no-workers" : "no-fields",
      currentQd: startQd
    };
  }

  const availableQd = Math.min(...candidates.map((row) => row.availableQd));
  const earliest = candidates.filter((row) => row.availableQd === availableQd);
  const expectedQty = earliest.reduce((sum, row) => sum + row.expectedQty, 0);
  const date = albugrirCalendarDay(Math.ceil(Math.max(1, availableQd) / ALBUGRIR_QD_PER_DAY));
  return {
    hasHarvest: true,
    currentQd: startQd,
    productionQd: Math.min(...earliest.map((row) => row.productionQd)),
    availableQd,
    daysUntil: Math.max(0, (availableQd - startQd) / ALBUGRIR_QD_PER_DAY),
    fieldCount,
    staffedFieldCount,
    contributingFieldCount: earliest.length,
    expectedQty,
    expectedFoodPersonDays: expectedQty * finiteNonNegative(grainFoodValue, 0),
    pending: earliest.some((row) => row.pending),
    date,
    dateLabel: `${date.trilune.name}, ${date.dayOfTrilune} день`
  };
}

function resourceDefinitionIndex(resourceDefinitions = []) {
  return new Map((Array.isArray(resourceDefinitions) ? resourceDefinitions : [])
    .map((row) => [String(row?.id ?? row?.resourceId ?? ""), row])
    .filter(([id]) => id));
}

function roomIndex(rooms = []) {
  return new Map((Array.isArray(rooms) ? rooms : [])
    .map((row) => [String(row?.id ?? "outdoors") || "outdoors", row]));
}

function foodLots({ resources = [], definitions, rooms, currentQd }) {
  const durable = [];
  const expiring = [];
  let grossPersonDays = 0;

  for (const resource of Array.isArray(resources) ? resources : []) {
    const resourceId = String(resource?.resourceId ?? resource?.id ?? "");
    const definition = definitions.get(resourceId) ?? {};
    const foodValue = effectiveConsumerRationPoints(resource, definition);
    const qty = finiteNonNegative(resource?.qty, 0);
    if (foodValue <= EPSILON || qty <= EPSILON) continue;
    const shelfLifeDays = Math.max(0, Math.floor(finiteNonNegative(resource?.shelfLifeDays ?? definition?.shelfLifeDays, 0)));
    const rowPersonDays = qty * foodValue;
    grossPersonDays += rowPersonDays;
    if (!shelfLifeDays) {
      durable.push(rowPersonDays);
      continue;
    }

    const roomId = String(resource?.roomId ?? resource?.storageRoomId ?? "outdoors") || "outdoors";
    const room = rooms.get(roomId) ?? rooms.get("outdoors") ?? {};
    const storageQuality = finiteNonNegative(room?.quality, 0);
    const lots = normalizeResourceLots(resource, {
      currentQd,
      shelfLifeDays,
      seedMissing: true,
      agedThroughQd: currentQd
    });
    for (const lot of lots) {
      const agedThroughQd = Math.max(lot.receivedQd, normalizedQd(lot.agedThroughQd));
      const elapsedSinceAging = Math.max(0, currentQd - agedThroughQd) / ALBUGRIR_QD_PER_DAY;
      const ageDays = finiteNonNegative(lot.ageDays, 0) + elapsedSinceAging;
      const effectiveShelfLifeDays = storageQualityEffectiveShelfLifeDays(
        finiteNonNegative(lot.shelfLifeDays, shelfLifeDays),
        storageQuality
      );
      const remainingLifeDays = Math.max(0, effectiveShelfLifeDays - ageDays);
      const expiryQd = currentQd + remainingLifeDays * ALBUGRIR_QD_PER_DAY;
      expiring.push({
        resourceId,
        name: String(resource?.name ?? definition?.label ?? resourceId),
        personDays: finiteNonNegative(lot.qty, 0) * foodValue,
        expiryQd
      });
    }
  }

  return { durable, expiring, grossPersonDays };
}

export function evaluateFoodReserve({
  currentQd = 0,
  targetQd = null,
  boardFoodDaily = 0,
  resources = [],
  resourceDefinitions = [],
  rooms = []
} = {}) {
  const startQd = normalizedQd(currentQd);
  const dailyNeed = finiteNonNegative(boardFoodDaily, 0);
  const definitions = resourceDefinitionIndex(resourceDefinitions);
  const roomRows = roomIndex(rooms);
  const lots = foodLots({ resources, definitions, rooms: roomRows, currentQd: startQd });
  const coverageDays = dailyNeed > EPSILON ? lots.grossPersonDays / dailyNeed : null;
  if (targetQd === null || targetQd === undefined) {
    return {
      hasTarget: false,
      currentQd: startQd,
      boardFoodDaily: dailyNeed,
      grossPersonDays: lots.grossPersonDays,
      coverageDays
    };
  }

  const endQd = Math.max(startQd, finiteNonNegative(targetQd, startQd));
  const daysUntilTarget = (endQd - startQd) / ALBUGRIR_QD_PER_DAY;
  const requiredPersonDays = dailyNeed * daysUntilTarget;
  let scheduledExpiring = 0;
  let atRiskPersonDays = 0;
  let durablePersonDays = lots.durable.reduce((sum, value) => sum + value, 0);

  for (const lot of lots.expiring.sort((left, right) => left.expiryQd - right.expiryQd)) {
    if (lot.expiryQd > endQd + EPSILON) {
      durablePersonDays += lot.personDays;
      continue;
    }
    const usableDays = Math.max(0, (lot.expiryQd - startQd) / ALBUGRIR_QD_PER_DAY);
    const consumptionCapacity = Math.min(requiredPersonDays, dailyNeed * usableDays);
    const usable = Math.min(lot.personDays, Math.max(0, consumptionCapacity - scheduledExpiring));
    scheduledExpiring += usable;
    atRiskPersonDays += Math.max(0, lot.personDays - usable);
  }

  const usablePersonDays = scheduledExpiring + durablePersonDays;
  const balancePersonDays = usablePersonDays - requiredPersonDays;
  return {
    hasTarget: true,
    currentQd: startQd,
    targetQd: endQd,
    daysUntilTarget,
    boardFoodDaily: dailyNeed,
    grossPersonDays: lots.grossPersonDays,
    usablePersonDays,
    requiredPersonDays,
    balancePersonDays,
    deficitPersonDays: Math.max(0, -balancePersonDays),
    surplusPersonDays: Math.max(0, balancePersonDays),
    atRiskPersonDays,
    coverageDays,
    usableCoverageDays: dailyNeed > EPSILON ? usablePersonDays / dailyNeed : null,
    sufficient: dailyNeed <= EPSILON || balancePersonDays >= -EPSILON
  };
}
