import { isResidentInPopulation } from "../../data/resident-presence.js";
import { nutritionBalance } from "./nutrition.js";
import { politicsRuntimeEffects } from "../politics/runtime-effects.js";

function foodDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "normalizeResourceId",
    "resourceDef",
    "resourceLabel",
    "formatNumber",
    "normalizeFoodRationUnits",
    "resolveFoodRation",
    "foodRationTierLabel",
    "isResourceBatchPeriodActive",
    "syncResourceRowBatches",
    "availableResourceRowQuantity",
    "availableResourceBatchInventory",
    "takeResourceBatchById",
    "applySettlementHunger",
    "hungerPenaltyFactor",
    "normalizeHungerLevel"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Food consumption requires dependency "${name}".`);
    }
  }
  return dependencies;
}

export function isFoodResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = deps.resourceDef(id, row.name);
  if (row.noAutoConsume === true || definition?.noAutoConsume === true) return false;
  // A storage row is inventory, not a second resource definition. Legacy
  // holdings may still carry stale foodEdible=true metadata, but a known
  // catalog resource must always follow the catalog. Explicit row opt-in is
  // reserved for genuinely custom resources.
  return id === "custom" ? row.foodEdible === true : definition?.foodEdible === true;
}

export function runFoodConsumption({
  holding,
  qd = 0,
  report = null,
  residentPresenceDaysById = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Food consumption requires a holding draft.");
  const deps = foodDependencies(dependencies);
  const days = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 4);
  // Injury does not cancel daily food. Readiness and the actual period use all living residents.
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const hasPresenceAccounting = residentPresenceDaysById !== null || people.some((person) => !isResidentInPopulation(person, holding));
  const presenceValue = (personId) => {
    if (residentPresenceDaysById instanceof Map) return residentPresenceDaysById.get(personId);
    if (residentPresenceDaysById && typeof residentPresenceDaysById === "object") return residentPresenceDaysById[personId];
    return undefined;
  };
  const homeDaysById = new Map(people.map((person) => {
    const personId = String(person?.id ?? "");
    const explicit = presenceValue(personId);
    const fallback = isResidentInPopulation(person, holding) ? days : 0;
    const parsed = Number(explicit);
    return [personId, Math.max(0, Math.min(days, Number.isFinite(parsed) ? parsed : fallback))];
  }));
  const residentDays = [...homeDaysById.values()].reduce((sum, value) => sum + value, 0);
  const presentPeople = people.filter((person) => (homeDaysById.get(String(person?.id ?? "")) ?? 0) > 0);
  const selectedUnits = deps.normalizeFoodRationUnits(holding?.gm?.food?.rationUnitsPerResident, 10);
  const edibleRows = (holding?.storage?.resources ?? []).filter((row) => isFoodResource(row, deps));
  const compactBatches = !deps.isResourceBatchPeriodActive(holding);
  for (const row of edibleRows) deps.syncResourceRowBatches(row, { compact: compactBatches });
  const availableBeforeConsumption = edibleRows.reduce((sum, row) => sum + deps.availableResourceRowQuantity(row, holding), 0);
  const ration = deps.resolveFoodRation({
    residentDays,
    available: availableBeforeConsumption,
    selectedUnits,
    multiplier: politicsRuntimeEffects(holding)?.foodMultiplier ?? 1
  });
  const needed = ration.selectedTarget;
  if (!days || !residentDays) return {
    needed: 0,
    minimumNeeded: 0,
    eaten: 0,
    hungryResidentDays: 0,
    availableBeforeConsumption,
    selectedUnits,
    effectiveTier: ration.effectiveTier,
    dietTypes: [],
    hungerLevel: days >= 10
      ? deps.applySettlementHunger({ holding, hungryResidentDays: 0, livingCount: presentPeople.length, report }).after
      : deps.normalizeHungerLevel(holding?.gm?.food?.hungerLevel),
    hungerFactor: days >= 10
      ? deps.hungerPenaltyFactor(0)
      : deps.hungerPenaltyFactor(holding?.gm?.food?.hungerLevel),
    ...(hasPresenceAccounting ? { residentDays: 0 } : {})
  };

  let remaining = ration.consumeTarget;
  const takenByRow = new Map();
  const candidates = edibleRows.flatMap((row, rowIndex) => deps.availableResourceBatchInventory(row, holding, { compact: compactBatches }).map((batch, batchIndex) => ({
    row,
    rowIndex,
    batchIndex,
    batch
  }))).sort((left, right) => right.batch.ageQd - left.batch.ageQd || left.rowIndex - right.rowIndex || left.batchIndex - right.batchIndex);

  const foodGroup = (row) => {
    const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
    return String(id === "custom" ? row.foodType ?? "" : deps.resourceDef(id, row.name)?.foodType ?? "").trim().toLowerCase();
  };
  const groupStocks = new Map();
  for (const candidate of candidates) {
    const group = foodGroup(candidate.row);
    if (group) groupStocks.set(group, (groupStocks.get(group) ?? 0) + candidate.batch.qty);
  }
  const portion = Math.ceil(ration.consumeTarget * 0.2);
  const balancedGroups = [...groupStocks].filter(([, qty]) => qty >= portion).slice(0, 3).map(([group]) => group);
  const consume = (candidate, limit) => {
    const take = Math.min(candidate.batch.qty, remaining, limit);
    if (take <= 0) return 0;
    const receipt = deps.takeResourceBatchById(candidate.row, candidate.batch.id, take, { holding });
    if (!receipt) return 0;
    remaining -= receipt.qty;
    candidate.batch.qty -= receipt.qty;
    const resourceId = deps.normalizeResourceId(candidate.row.resourceId, candidate.row.id, candidate.row.name);
    const name = candidate.row.name || deps.resourceLabel(resourceId);
    const key = String(candidate.row.id ?? candidate.rowIndex);
    const summary = takenByRow.get(key) ?? { row: candidate.row, resourceId, name, qty: 0 };
    summary.qty += receipt.qty;
    takenByRow.set(key, summary);
    return receipt.qty;
  };
  // Secure modest shares of available groups; keep FIFO within each group.
  for (const group of balancedGroups) {
    let groupRemaining = portion;
    for (const candidate of candidates) {
      if (foodGroup(candidate.row) !== group || groupRemaining <= 0) continue;
      groupRemaining -= consume(candidate, groupRemaining);
    }
  }
  for (const candidate of candidates) consume(candidate, remaining);

  const takenEntries = [];
  const dietTypes = new Set();
  const foodGroups = {};
  for (const { row, resourceId, name, qty: take } of takenByRow.values()) {
    const definition = deps.resourceDef(resourceId, name);
    const foodType = String(resourceId === "custom" ? row.foodType : definition?.foodType || "").trim().toLowerCase();
    if (foodType) {
      dietTypes.add(foodType);
      foodGroups[foodType] = (foodGroups[foodType] ?? 0) + take;
    }
    takenEntries.push({
      domain: "food",
      kind: "resource",
      resourceId,
      name,
      qty: -take,
      roomId: row.roomId ?? row.storageRoomId ?? "",
      source: "Питание поселения",
      note: `${residentDays} человеко-дней в поселении`
    });
  }

  const eaten = ration.consumeTarget - remaining;
  const hungryResidentDays = ration.hungryResidentDays;
  const nutrition = nutritionBalance({ deficitDays: holding?.gm?.food?.nutritionDeficitDays,
    days, effectiveUnits: ration.achievedUnits, foodGroups, eaten });
  holding.gm ??= {};
  holding.gm.food ??= {};
  holding.gm.food.nutritionDeficitDays = nutrition.deficitDays;
  const hunger = days > 0
    ? deps.applySettlementHunger({ holding, hungryResidentDays, livingCount: Math.max(1, Math.ceil(residentDays / days)),
        minimumLevel: nutrition.chronicHungerLevel, periodDays: days, report })
    : {
        before: deps.normalizeHungerLevel(holding?.gm?.food?.hungerLevel),
        after: deps.normalizeHungerLevel(holding?.gm?.food?.hungerLevel),
        factor: deps.hungerPenaltyFactor(holding?.gm?.food?.hungerLevel)
      };
  if (report?.food) {
    report.food.needed += needed;
    report.food.eaten += eaten;
    report.food.hungryResidentDays += hungryResidentDays;
    report.food.availableBeforeConsumption = availableBeforeConsumption;
    report.food.minimumNeeded = Math.max(0, Number(report.food.minimumNeeded) || 0) + ration.minimumTarget;
    report.food.selectedUnits = selectedUnits;
    report.food.selectedTier = ration.selectedTier;
    report.food.effectiveTier = ration.effectiveTier;
    report.food.fallback = ration.fallback;
    report.food.politicsFoodMultiplier = politicsRuntimeEffects(holding)?.foodMultiplier ?? 1;
    report.food.dietTypes = [...dietTypes];
    report.food.effectiveUnits = ration.achievedUnits;
    report.food.rationModifier = ration.moraleModifier;
    report.food.diversityBonus = nutrition.diversityBonus;
    report.food.nutritionDeficitDays = nutrition.deficitDays;
    if (nutrition.diversityBonus > 0) report.food.lines.push(`Разнообразие питания: +${nutrition.diversityBonus} довольства (${nutrition.substantialGroups} существенных групп продуктов).`);
    if (nutrition.chronicHungerLevel > 0) report.food.lines.push(`Длительное недоедание: ${nutrition.deficitDays} дней накопленного дефицита; нужен обычный или усиленный рацион для восстановления.`);
    const taken = [...takenByRow.values()].map((item) => `${item.name} -${deps.formatNumber(item.qty)}`);
    if (taken.length) report.food.lines.push(`Съедено: ${taken.join(", ")}.`);
    report.food.lines.push(`Рацион: ${deps.foodRationTierLabel(ration.effectiveTier)} (${eaten} ед.; фактически ${deps.formatNumber(ration.achievedUnits)} из выбранных ${selectedUnits} ед. на жителя за декаду).`);
    if (hungryResidentDays) report.food.lines.push(`Голод: ${hungryResidentDays} человеко-дней без пищи.`);
  }
  deps.appendLedger?.(report, takenEntries);
  if (hungryResidentDays) deps.appendLedger?.(report, {
    domain: "food",
    kind: "notice",
    name: "Дефицит пищи",
    qty: hungryResidentDays,
    source: "Питание поселения",
    status: "warning",
    note: `${hungryResidentDays} человеко-дней без пищи`
  });
  return {
    needed,
    minimumNeeded: ration.minimumTarget,
    eaten,
    hungryResidentDays,
    availableBeforeConsumption,
    selectedUnits,
    selectedTier: ration.selectedTier,
    effectiveTier: ration.effectiveTier,
    fallback: ration.fallback,
    dietTypes: [...dietTypes],
    effectiveUnits: ration.achievedUnits,
    rationModifier: ration.moraleModifier,
    diversityBonus: nutrition.diversityBonus,
    nutritionDeficitDays: nutrition.deficitDays,
    hungerLevel: hunger.after,
    hungerFactor: hunger.factor,
    ...(hasPresenceAccounting ? { residentDays } : {})
  };
}
