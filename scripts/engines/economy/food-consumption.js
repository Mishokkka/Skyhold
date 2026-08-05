function foodDependencies(dependencies = {}) {
  const required = ["safeNumber", "normalizeResourceId", "resourceDef", "resourceLabel", "formatNumber"];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Food consumption requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function requiredDependency(dependencies = {}, name = "") {
  const dependency = dependencies?.[name];
  if (typeof dependency !== "function") {
    throw new TypeError(`FBL Skyhold | Food consumption requires dependency "${name}".`);
  }
  return dependency;
}

const CORE_NUTRITION_TAGS = Object.freeze(["staple", "protein", "fresh"]);

export const DIET_GROUPS = Object.freeze(["staple", "protein", "dairy", "produce"]);
export const RICH_DIET_MIN_GROUP_SHARE = 0.2;

const DIET_GROUP_LABELS = Object.freeze({
  staple: "основа",
  protein: "белок",
  dairy: "молочные продукты",
  produce: "овощи и фрукты"
});

const DIET_GROUP_TAG_PRIORITY = Object.freeze([
  ["dairy"],
  ["staple"],
  ["protein"],
  ["produce", "fresh"]
]);

function normalizedDietGroup(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return DIET_GROUPS.includes(normalized) ? normalized : "";
}

function emptyDietGroupPersonDays() {
  return Object.fromEntries(DIET_GROUPS.map((group) => [group, 0]));
}

function oldestLotQd(row = {}) {
  const values = (Array.isArray(row?.lots) ? row.lots : [])
    .map((lot) => Number(lot?.receivedQd))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

function resourceDefinition(row = {}, dependencies = {}) {
  const id = dependencies.normalizeResourceId(row.resourceId, row.id, row.name);
  return dependencies.resourceDef(id, row.name);
}

export function usesStandardRationUnits(row = {}, dependencies = {}) {
  const definition = resourceDefinition(row, dependencies);
  return Object.hasOwn(definition ?? {}, "rationPoints") || Object.hasOwn(row, "rationPoints");
}

function storageQuantityFor(holding, row, dependencies = {}) {
  if (typeof dependencies.storageAvailableQuantity === "function") {
    return Math.max(0, dependencies.safeNumber(dependencies.storageAvailableQuantity(holding, row), 0));
  }
  return Math.max(0, dependencies.safeNumber(row?.qty, 0));
}

function sourceCapacityPersonDays(entry, dependencies = {}) {
  if (entry.kind === "buffer") return entry.expiredAtTarget ? 0 : Math.max(0, Math.floor(Number(entry.bufferEntry?.points) || 0));
  const qty = Number.isFinite(Number(entry.usableQtyAtTarget))
    ? Math.max(0, Number(entry.usableQtyAtTarget))
    : storageQuantityFor(entry.holding, entry.row, dependencies);
  const usableQty = entry.standardUnits ? Math.floor(qty + 1e-9) : qty;
  return usableQty * entry.foodValue;
}

export function shelfLifeProfileForResource(row = {}, dependencies = {}) {
  const definition = resourceDefinition(row, dependencies);
  const shelfLifeMode = String(row.shelfLifeMode ?? definition?.shelfLifeMode ?? "").trim().toLowerCase();
  const configuredTendays = Object.hasOwn(definition ?? {}, "shelfLifeTendays")
    ? definition.shelfLifeTendays
    : row.shelfLifeTendays;
  const configuredDays = row.shelfLifeDays
    ?? definition?.legacyShelfLifeDays
    ?? definition?.shelfLifeDays;
  const parsedTendays = Number(configuredTendays);
  const parsedDays = Number(configuredDays);
  const explicitTendays = Number.isFinite(parsedTendays) && parsedTendays > 0 ? Math.floor(parsedTendays) : 0;
  const legacyDays = Number.isFinite(parsedDays) && parsedDays > 0 ? Math.floor(parsedDays) : 0;
  if (shelfLifeMode === "tendays" && explicitTendays > 0) {
    return { tendays: explicitTendays, days: explicitTendays * 10, qd: explicitTendays * 40 };
  }
  const tendays = explicitTendays || (legacyDays > 0 ? Math.ceil(legacyDays / 10) : 0);
  const days = legacyDays || (tendays * 10);
  const qdCandidates = [tendays > 0 ? tendays * 40 : 0, days > 0 ? days * 4 : 0].filter((value) => value > 0);
  return { tendays, days, qd: qdCandidates.length ? Math.min(...qdCandidates) : 0 };
}

export function baseExpiryQdForOpenedUnits(entry, openedUnits, openedQd) {
  const shelfLifeQd = Math.max(0, Math.floor(Number(entry.shelfLifeQd) || 0));
  if (!shelfLifeQd) return 0;
  let remaining = Math.max(0, Number(openedUnits) || 0);
  const expiries = [];
  const lots = [...(Array.isArray(entry.row?.lots) ? entry.row.lots : [])]
    .map((lot, index) => ({ lot, index }))
    .filter(({ lot }) => Number(lot?.qty) > 0)
    .sort((left, right) => (Number(left.lot.receivedQd) || 0) - (Number(right.lot.receivedQd) || 0) || left.index - right.index);
  for (const { lot } of lots) {
    if (remaining <= 1e-9) break;
    const fromLot = Math.min(remaining, Math.max(0, Number(lot.qty) || 0));
    if (fromLot <= 0) continue;
    expiries.push(Math.max(0, Math.floor(Number(lot.receivedQd) || 0)) + shelfLifeQd);
    remaining -= fromLot;
  }
  if (remaining > 1e-9 || !expiries.length) expiries.push(openedQd + shelfLifeQd);
  return Math.min(...expiries);
}

export function addRationBufferPoints(buffer, entry, points, openedQd = 0, expiresQd = 0, dependencies = {}) {
  const whole = Math.max(0, Math.floor(Number(points) || 0));
  if (!whole) return 0;
  const normalizeRationBufferEntry = requiredDependency(dependencies, "normalizeRationBufferEntry");
  const rationBufferEntryKey = requiredDependency(dependencies, "rationBufferEntryKey");
  const candidate = normalizeRationBufferEntry({
    points: whole,
    resourceId: entry.resourceId,
    name: entry.name,
    dietGroup: entry.dietGroup,
    nutritionTags: entry.nutritionTags,
    sourceRowId: entry.row?.id ?? "",
    sourceRoomId: entry.row?.roomId ?? entry.row?.storageRoomId ?? "",
    unitRationPoints: entry.foodValue,
    openedQd,
    shelfLifeTendays: entry.shelfLifeTendays,
    shelfLifeDays: entry.shelfLifeDays,
    expiresQd
  });
  if (!candidate) return 0;
  const key = rationBufferEntryKey(candidate);
  const existing = buffer.entries.find((row) => rationBufferEntryKey(row) === key);
  if (existing) existing.points += whole;
  else buffer.entries.push(candidate);
  return whole;
}

export function nutritionTagsForResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = deps.resourceDef(id, row.name);
  const source = row.nutritionTags ?? definition?.nutritionTags ?? [];
  return [...new Set((Array.isArray(source) ? source : String(source ?? "").split(/[,;\n]/))
    .map((tag) => String(tag ?? "").trim().toLowerCase())
    .filter(Boolean))];
}

export function nutritionDiversity(tags = []) {
  const normalized = new Set((Array.isArray(tags) ? tags : []).map((tag) => String(tag ?? "").trim().toLowerCase()).filter(Boolean));
  const covered = CORE_NUTRITION_TAGS.filter((tag) => normalized.has(tag)).length;
  const score = Math.round((covered / CORE_NUTRITION_TAGS.length) * 100);
  return {
    score,
    covered,
    target: CORE_NUTRITION_TAGS.length,
    label: score >= 100 ? "Разнообразный" : (score >= 67 ? "Достаточный" : (score >= 34 ? "Ограниченный" : (score > 0 ? "Однообразный" : "Нет питания")))
  };
}

// A resource contributes to at most one group. Explicit dietGroup wins; the
// legacy nutritionTags fallback keeps current catalogs useful without a schema
// migration. Dairy precedes protein so milk is not counted twice, while eggs
// remain protein rather than inheriting their secondary "fresh" tag.
export function dietGroupForResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = deps.resourceDef(id, row.name);
  const explicit = normalizedDietGroup(row.dietGroup ?? definition?.dietGroup);
  if (explicit) return explicit;
  const tags = new Set(nutritionTagsForResource(row, deps));
  for (const aliases of DIET_GROUP_TAG_PRIORITY) {
    if (!aliases.some((tag) => tags.has(tag))) continue;
    return aliases[0] === "fresh" ? "produce" : aliases[0];
  }
  return "";
}

export function dietVariety(dietGroupPersonDays = {}, { needed = 0, eaten = 0 } = {}) {
  const requiredPersonDays = Math.max(0, Number(needed) || 0);
  const eatenPersonDays = Math.max(0, Number(eaten) || 0);
  const thresholdPersonDays = requiredPersonDays * RICH_DIET_MIN_GROUP_SHARE;
  const groups = emptyDietGroupPersonDays();
  const shares = emptyDietGroupPersonDays();
  for (const group of DIET_GROUPS) {
    groups[group] = Math.max(0, Number(dietGroupPersonDays?.[group]) || 0);
    shares[group] = requiredPersonDays > 0 ? groups[group] / requiredPersonDays : 0;
  }
  const qualifyingGroups = requiredPersonDays > 0
    ? DIET_GROUPS.filter((group) => groups[group] + 1e-9 >= thresholdPersonDays)
    : [];
  const fullFed = requiredPersonDays > 0 && eatenPersonDays + 1e-9 >= requiredPersonDays;
  const richDiet = fullFed && qualifyingGroups.length >= 3;
  const score = fullFed ? Math.round((Math.min(3, qualifyingGroups.length) / 3) * 100) : 0;
  const label = requiredPersonDays <= 0
    ? "Нет питания"
    : (!fullFed
      ? "Недостаточно пищи"
      : (richDiet
        ? "Богатый"
        : (qualifyingGroups.length >= 2
          ? "Разнообразный"
          : (qualifyingGroups.length === 1 ? "Однообразный" : "Без пищевых групп"))));
  return {
    groups,
    shares,
    thresholdShare: RICH_DIET_MIN_GROUP_SHARE,
    thresholdPersonDays,
    qualifyingGroups,
    qualifyingGroupCount: qualifyingGroups.length,
    fullFed,
    richDiet,
    score,
    label
  };
}

export function isFoodResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = deps.resourceDef(id, row.name);
  if (requiredDependency(deps, "effectiveConsumerRationPoints")(row, definition) > 0) return true;
  if (Object.hasOwn(definition ?? {}, "rationPoints") || Object.hasOwn(row, "rationPoints")) return false;
  const text = `${id} ${row.name ?? ""} ${row.category ?? ""} ${definition?.category ?? ""} ${(definition?.aliases ?? []).join(" ")}`.toLowerCase();
  if (/еда|пища|food|ration|meal/.test(text)) return true;
  return ["bread", "fruits", "grain", "honey", "meat", "milk", "vegetables", "flour"].includes(id);
}

export function foodValueForResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const id = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  const definition = deps.resourceDef(id, row.name);
  const configured = requiredDependency(deps, "effectiveConsumerRationPoints")(row, definition);
  if (configured > 0) return configured;
  if (Object.hasOwn(definition ?? {}, "rationPoints") || Object.hasOwn(row, "rationPoints")) return 0;
  // Неизвестная пользовательская еда сохраняет старое правило 1 unit = 1 человеко-день.
  return isFoodResource(row, deps) ? 1 : 0;
}

export function foodPersonDaysForResource(row = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  const qty = Math.max(0, deps.safeNumber(row.qty ?? row.quantity ?? row.count, 0));
  const consumableQty = usesStandardRationUnits(row, deps) ? Math.floor(qty + 1e-9) : qty;
  return consumableQty * foodValueForResource(row, deps);
}

export function totalFoodPersonDays(rows = [], dependencies = {}) {
  const deps = foodDependencies(dependencies);
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + foodPersonDaysForResource(row, deps), 0);
}

export function totalHoldingFoodPersonDays(holding = {}, dependencies = {}) {
  const deps = foodDependencies(dependencies);
  return (holding?.storage?.resources ?? []).reduce((sum, row) => (
    sum + foodPersonDaysForResource({ ...row, qty: storageQuantityFor(holding, row, deps) }, deps)
  ), 0)
    + requiredDependency(deps, "totalRationBufferPoints")(holding?.storage?.rationBuffer);
}

export function boardFoodDailyForPerson(person = {}, dependencies = {}) {
  foodDependencies(dependencies);
  if (person?.dead) return 0;
  return requiredDependency(dependencies, "foodProvisionDaily")(person);
}

export function totalBoardFoodDaily(people = [], dependencies = {}) {
  const deps = foodDependencies(dependencies);
  return (Array.isArray(people) ? people : []).reduce((sum, person) => sum + boardFoodDailyForPerson(person, deps), 0);
}

export function runFoodConsumption({
  holding,
  qd = 0,
  report = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Food consumption requires a holding draft.");
  const deps = foodDependencies(dependencies);
  const days = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 4);
  // Ранение не отменяет ежедневный паёк. Readiness также резервирует пищу для
  // всех жителей с пансионом, поэтому фактический ход обязан использовать ту же базу.
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const dailyBoardFood = totalBoardFoodDaily(people, deps);
  const needed = days * dailyBoardFood;
  if (!needed) {
    if (report?.food) {
      const variety = dietVariety(report.food.dietGroupPersonDays, {
        needed: report.food.needed,
        eaten: report.food.eaten
      });
      report.food.dietGroupPersonDays = variety.groups;
      report.food.dietGroupShares = variety.shares;
      report.food.dietGroupThresholdShare = variety.thresholdShare;
      report.food.dietGroupThresholdPersonDays = variety.thresholdPersonDays;
      report.food.qualifyingDietGroups = variety.qualifyingGroups;
      report.food.qualifyingDietGroupCount = variety.qualifyingGroupCount;
      report.food.fullFed = variety.fullFed;
      report.food.richDiet = variety.richDiet;
    }
    return { needed: 0, eaten: 0, hungryResidentDays: 0 };
  }

  let remaining = needed;
  const taken = [];
  const takenEntries = [];
  const consumedNutritionTags = new Set();
  const consumedDietGroupPersonDays = emptyDietGroupPersonDays();
  if (!holding.storage || typeof holding.storage !== "object" || Array.isArray(holding.storage)) holding.storage = {};
  const rationBuffer = requiredDependency(deps, "normalizeRationBuffer")(holding.storage.rationBuffer);
  holding.storage.rationBuffer = rationBuffer;
  const openedQd = Math.max(0, Math.floor(
    deps.safeNumber(holding?.gm?.calendaria?.lastQd, 0) + Math.max(0, deps.safeNumber(qd, 0))
  ));
  const consumptionQd = Math.max(0, openedQd - 1);
  const bufferedSources = rationBuffer.entries
    .map((bufferEntry, index) => ({
      kind: "buffer",
      bufferEntry,
      index,
      sourceRank: 0,
      oldestQd: bufferEntry.openedQd,
      foodValue: 1,
      standardUnits: true,
      expiredAtTarget: bufferEntry.expiresQd > 0 && consumptionQd >= bufferEntry.expiresQd,
      resourceId: bufferEntry.resourceId,
      name: bufferEntry.name,
      dietGroup: bufferEntry.dietGroup,
      nutritionTags: [...bufferEntry.nutritionTags]
    }))
    .sort((left, right) => {
      const leftExpiry = left.bufferEntry.expiresQd || Number.POSITIVE_INFINITY;
      const rightExpiry = right.bufferEntry.expiresQd || Number.POSITIVE_INFINITY;
      return leftExpiry - rightExpiry || left.oldestQd - right.oldestQd || left.index - right.index;
    });
  const storedSources = [...(holding.storage.resources ?? [])]
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isFoodResource(row, deps))
    .sort((left, right) => oldestLotQd(left.row) - oldestLotQd(right.row) || left.index - right.index)
    .map(({ row, index }) => {
      const shelfLife = shelfLifeProfileForResource(row, deps);
      return {
        kind: "resource",
        holding,
        row,
        index,
        sourceRank: 1,
        oldestQd: oldestLotQd(row),
        foodValue: foodValueForResource(row, deps),
        standardUnits: usesStandardRationUnits(row, deps),
        shelfLifeTendays: shelfLife.tendays,
        shelfLifeDays: shelfLife.days,
        shelfLifeQd: shelfLife.qd,
        usableQtyAtTarget: typeof deps.storageUsableQuantityAtQd === "function"
          ? deps.storageUsableQuantityAtQd(holding, row, consumptionQd)
          : storageQuantityFor(holding, row, deps),
        resourceId: deps.normalizeResourceId(row.resourceId, row.id, row.name),
        name: row.name || deps.resourceLabel(deps.normalizeResourceId(row.resourceId, row.id, row.name)),
        dietGroup: dietGroupForResource(row, deps),
        nutritionTags: nutritionTagsForResource(row, deps)
      };
    });
  const foodSources = [...bufferedSources, ...storedSources];
  const consumedBySource = new Map();

  const consumeFromSource = (entry, personDaysLimit = Number.POSITIVE_INFINITY) => {
    if (remaining <= 0 || personDaysLimit <= 0) return 0;
    const { foodValue, dietGroup } = entry;
    const capacity = sourceCapacityPersonDays(entry, deps);
    if (!capacity || !foodValue) return 0;
    const foodDays = Math.min(capacity, remaining, personDaysLimit);
    if (foodDays <= 0) return 0;
    let take = 0;
    let bufferedPoints = 0;
    let bufferPoints = 0;
    let wastedPoints = 0;
    if (entry.kind === "buffer") {
      bufferPoints = Math.min(entry.bufferEntry.points, Math.ceil(foodDays - 1e-9));
      entry.bufferEntry.points -= bufferPoints;
      wastedPoints = Math.max(0, bufferPoints - foodDays);
    } else {
      const { row } = entry;
      const have = storageQuantityFor(holding, row, deps);
      if (entry.standardUnits) {
        take = Math.min(Math.floor(have + 1e-9), Math.ceil((foodDays / foodValue) - 1e-9));
        const openedPoints = take * foodValue;
        const spentPoints = Math.min(openedPoints, Math.ceil(foodDays - 1e-9));
        const expiresQd = baseExpiryQdForOpenedUnits(entry, take, openedQd);
        bufferedPoints = addRationBufferPoints(rationBuffer, entry, openedPoints - spentPoints, openedQd, expiresQd, deps);
        wastedPoints = Math.max(0, spentPoints - foodDays);
      } else {
        take = Math.min(have, foodDays / foodValue);
      }
      if (typeof deps.consumeStorageResource === "function") deps.consumeStorageResource(holding, row, take, { usableAtQd: consumptionQd });
      else row.qty = Math.max(0, Number((have - take).toFixed(6)));
    }
    remaining = Math.max(0, Number((remaining - foodDays).toFixed(6)));
    for (const tag of entry.nutritionTags) consumedNutritionTags.add(tag);
    if (dietGroup) consumedDietGroupPersonDays[dietGroup] += foodDays;
    const consumed = consumedBySource.get(entry) ?? { qty: 0, personDays: 0, bufferedPoints: 0, bufferPoints: 0, wastedPoints: 0 };
    consumed.qty += take;
    consumed.personDays += foodDays;
    consumed.bufferedPoints += bufferedPoints;
    consumed.bufferPoints += bufferPoints;
    consumed.wastedPoints += wastedPoints;
    consumedBySource.set(entry, consumed);
    return foodDays;
  };

  // When the settlement can be fully fed, reserve up to three qualifying
  // groups before the ordinary FIFO pass. This maximizes meaningful variety
  // without ever withholding food during a shortage.
  const availablePersonDays = foodSources.reduce((sum, entry) => sum + sourceCapacityPersonDays(entry, deps), 0);
  const plannedBySource = new Map();
  let plannedPersonDays = 0;
  const planFromSource = (entry, personDaysLimit = Number.POSITIVE_INFINITY) => {
    const capacity = sourceCapacityPersonDays(entry, deps);
    const alreadyPlanned = plannedBySource.get(entry) ?? 0;
    const available = Math.max(0, capacity - alreadyPlanned);
    const unplannedNeed = Math.max(0, needed - plannedPersonDays);
    const amount = Math.min(available, personDaysLimit, unplannedNeed);
    if (amount <= 0) return 0;
    plannedBySource.set(entry, alreadyPlanned + amount);
    plannedPersonDays += amount;
    return amount;
  };
  if (availablePersonDays + 1e-9 >= needed) {
    const targetPerGroup = Math.ceil((needed * RICH_DIET_MIN_GROUP_SHARE) - 1e-9);
    const candidates = DIET_GROUPS
      .map((group) => {
        const rows = foodSources.filter((entry) => entry.dietGroup === group);
        const available = rows.reduce((sum, entry) => sum + sourceCapacityPersonDays(entry, deps), 0);
        const first = rows[0];
        return { group, rows, available, sourceRank: first?.sourceRank ?? 2, oldestQd: first?.oldestQd ?? Number.POSITIVE_INFINITY, index: first?.index ?? Number.POSITIVE_INFINITY };
      })
      .filter((candidate) => candidate.available + 1e-9 >= targetPerGroup)
      .sort((left, right) => left.sourceRank - right.sourceRank || left.oldestQd - right.oldestQd || left.index - right.index || DIET_GROUPS.indexOf(left.group) - DIET_GROUPS.indexOf(right.group))
      .slice(0, 3);
    for (const candidate of candidates) {
      let groupRemaining = targetPerGroup;
      for (const entry of candidate.rows) {
        if (groupRemaining <= 1e-9 || plannedPersonDays + 1e-9 >= needed) break;
        groupRemaining = Math.max(0, groupRemaining - planFromSource(entry, groupRemaining));
      }
    }
  }

  for (const entry of foodSources) {
    if (plannedPersonDays + 1e-9 >= needed) break;
    planFromSource(entry);
  }

  for (const entry of foodSources) {
    const personDays = plannedBySource.get(entry) ?? 0;
    if (personDays <= 0) continue;
    consumeFromSource(entry, personDays);
  }
  rationBuffer.entries = rationBuffer.entries.filter((entry) => entry.points > 0);

  for (const entry of foodSources) {
    const consumed = consumedBySource.get(entry);
    if (!consumed) continue;
    const { dietGroup, resourceId, name } = entry;
    if (entry.kind === "buffer") {
      taken.push(`${name} из буфера -${deps.formatNumber(consumed.bufferPoints)} (${deps.formatNumber(consumed.personDays)} чел.-дн.)`);
      takenEntries.push({
        domain: "food",
        kind: "ration-buffer",
        resourceId,
        name,
        qty: -consumed.bufferPoints,
        roomId: entry.bufferEntry.sourceRoomId,
        source: "Буфер открытых рационов",
        note: `${deps.formatNumber(consumed.personDays)} чел.-дн.; ${days} дн.; пансион ${deps.formatNumber(dailyBoardFood)}/день`,
        meta: { personDays: consumed.personDays, dietGroup, sourceRowId: entry.bufferEntry.sourceRowId }
      });
      continue;
    }
    const { row } = entry;
    const bufferedNote = consumed.bufferedPoints > 0 ? `; остаток ${deps.formatNumber(consumed.bufferedPoints)} рац. перенесён в буфер` : "";
    taken.push(`${name} -${deps.formatNumber(consumed.qty)} (${deps.formatNumber(consumed.personDays)} чел.-дн.${bufferedNote})`);
    takenEntries.push({
      domain: "food",
      kind: "resource",
      resourceId,
      name,
      qty: -consumed.qty,
      roomId: row.roomId ?? row.storageRoomId ?? "",
      source: "Питание поселения",
      note: `${deps.formatNumber(consumed.personDays)} чел.-дн.; ${days} дн.; пансион ${deps.formatNumber(dailyBoardFood)}/день${bufferedNote}`,
      meta: { personDays: consumed.personDays, dietGroup, bufferedRationPoints: consumed.bufferedPoints, wastedRationPoints: consumed.wastedPoints }
    });
  }

  const eaten = needed - remaining;
  const hungryResidentDays = Math.max(0, remaining);
  if (report?.food) {
    report.food.needed += needed;
    report.food.eaten += eaten;
    report.food.hungryResidentDays += hungryResidentDays;
    if (taken.length) report.food.lines.push(`Съедено: ${taken.join(", ")}.`);
    if (hungryResidentDays) report.food.lines.push(`Голод: ${hungryResidentDays} человеко-дней без пищи.`);
    const nutritionTags = [...new Set([...(report.food.nutritionTags ?? []), ...consumedNutritionTags])];
    const dietGroupPersonDays = emptyDietGroupPersonDays();
    for (const group of DIET_GROUPS) {
      dietGroupPersonDays[group] = Math.max(0, deps.safeNumber(report.food.dietGroupPersonDays?.[group], 0))
        + consumedDietGroupPersonDays[group];
    }
    const diversity = dietVariety(dietGroupPersonDays, {
      needed: report.food.needed,
      eaten: report.food.eaten
    });
    report.food.nutritionTags = nutritionTags;
    report.food.nutritionDiversity = diversity.score;
    report.food.nutritionDiversityLabel = diversity.label;
    report.food.dietGroupPersonDays = diversity.groups;
    report.food.dietGroupShares = diversity.shares;
    report.food.dietGroupThresholdShare = diversity.thresholdShare;
    report.food.dietGroupThresholdPersonDays = diversity.thresholdPersonDays;
    report.food.qualifyingDietGroups = diversity.qualifyingGroups;
    report.food.qualifyingDietGroupCount = diversity.qualifyingGroupCount;
    report.food.fullFed = diversity.fullFed;
    report.food.richDiet = diversity.richDiet;
    if (eaten > 0 && !diversity.richDiet) {
      const groupDetails = DIET_GROUPS
        .filter((group) => diversity.groups[group] > 0)
        .map((group) => `${DIET_GROUP_LABELS[group]} ${deps.formatNumber(diversity.groups[group])}`);
      report.food.lines.push(`Рацион ${diversity.label.toLowerCase()}: ${groupDetails.join(", ") || "без пищевых групп"}. Богатый рацион требует полной сытости и любых трёх групп по 20% потребности; обычная пища всё равно закрывает голод, но не даёт бонус общего стола.`);
    }
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
  return { needed, eaten, hungryResidentDays };
}
