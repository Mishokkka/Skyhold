import { isInnMealServiceBuilding } from "./resident-meal-capacity.js";
import { normalizeRationBuffer, normalizeRationBufferEntry, rationBufferEntryKey } from "../../data/ration-buffer.js";
import {
  addRationBufferPoints,
  baseExpiryQdForOpenedUnits,
  dietGroupForResource,
  nutritionTagsForResource,
  shelfLifeProfileForResource,
  usesStandardRationUnits
} from "./food-consumption.js";

function serviceDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "buildingStatus",
    "buildingFunctions",
    "enterpriseCapitalReady",
    "buildingEffectiveWorkers",
    "reputationTotal",
    "isFoodResource",
    "foodValueForResource",
    "normalizeResourceId",
    "resourceDef",
    "resourceLabel",
    "consumeStorageResource",
    "storageAvailableQuantity",
    "addMoney",
    "formatNumber",
    "appendLedger"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Hospitality service requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function oldestLotQd(row = {}) {
  const values = (Array.isArray(row?.lots) ? row.lots : [])
    .map((lot) => Number(lot?.receivedQd))
    .filter(Number.isFinite);
  return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
}

function defaultSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizedIdentity(value) {
  return String(value ?? "").trim().toLowerCase().replace(/ё/g, "е");
}

function commonTableCapacityMap(snapshot, safeNumber = defaultSafeNumber) {
  if (snapshot == null) return null;
  const source = snapshot instanceof Map
    ? snapshot
    : (snapshot?.byBuilding instanceof Map ? snapshot.byBuilding : null);
  const result = new Map();
  if (source) {
    for (const [key, value] of source.entries()) {
      const capacity = value && typeof value === "object" ? value.remainingServiceCapacity : value;
      result.set(normalizedIdentity(key), Math.max(0, Math.floor(safeNumber(capacity, 0))));
    }
    return result;
  }

  if (Array.isArray(snapshot?.contributingInns)) {
    for (const row of snapshot.contributingInns) {
      const key = normalizedIdentity(row?.buildingId ?? row?.buildingName);
      if (!key) continue;
      result.set(key, Math.max(0, Math.floor(safeNumber(row?.remainingServiceCapacity, 0))));
    }
    return result;
  }

  const objectSource = snapshot?.byBuilding && typeof snapshot.byBuilding === "object"
    ? snapshot.byBuilding
    : snapshot;
  if (objectSource && typeof objectSource === "object") {
    for (const [key, value] of Object.entries(objectSource)) {
      const capacity = value && typeof value === "object" ? value.remainingServiceCapacity : value;
      if (Number.isFinite(Number(capacity))) {
        result.set(normalizedIdentity(key), Math.max(0, Math.floor(safeNumber(capacity, 0))));
      }
    }
  }
  return result;
}

function commonTableCapacityForBuilding(building, capacities) {
  if (!(capacities instanceof Map)) return null;
  for (const identity of [building?.id, building?.name, building?.templateId].map(normalizedIdentity).filter(Boolean)) {
    if (capacities.has(identity)) return capacities.get(identity);
  }
  return 0;
}

function availableGuestHousingCapacity(building, people, safeNumber = defaultSafeNumber) {
  const housingCapacity = Math.max(0, safeNumber(building?.housing?.capacity, 0));
  if (!housingCapacity) return 0;
  const identities = new Set([building?.id, building?.name].map(normalizedIdentity).filter(Boolean));
  if (!identities.size) return housingCapacity;
  const permanentResidents = people.reduce((sum, person) => (
    identities.has(normalizedIdentity(person?.home)) ? sum + 1 : sum
  ), 0);
  return Math.max(0, housingCapacity - permanentResidents);
}

export function normalizeHospitalityService(service = {}, safeNumber = defaultSafeNumber) {
  return {
    enabled: Boolean(service?.enabled),
    demandPool: String(service?.demandPool ?? "hospitality").trim() || "hospitality",
    label: String(service?.label ?? "Платные услуги").trim() || "Платные услуги",
    localDemandPerResident: Math.max(0, safeNumber(service?.localDemandPerResident, 0.2)),
    visitorDemandPerReputation: Math.max(0, safeNumber(service?.visitorDemandPerReputation, 2)),
    visitorDemandPerConnection: Math.max(0, safeNumber(service?.visitorDemandPerConnection, 2)),
    servicesPerWorker: Math.max(0, Math.floor(safeNumber(service?.servicesPerWorker, 20))),
    foodPersonDaysPerService: Math.max(0, safeNumber(service?.foodPersonDaysPerService, 0.5)),
    visitorRequiresHousing: service?.visitorRequiresHousing === undefined ? true : Boolean(service.visitorRequiresHousing),
    inputResourceId: String(service?.inputResourceId ?? "").trim(),
    inputQtyPerService: Math.max(0, safeNumber(service?.inputQtyPerService, 0)),
    priceCopper: Math.max(0, Math.floor(safeNumber(service?.priceCopper, 8))),
    notes: String(service?.notes ?? "")
  };
}

export function hospitalityDemandSnapshot({
  population = 0,
  reputation = 0,
  connections = 1,
  periods = 1,
  effectiveWorkers = 0,
  housingCapacity = 0,
  service = {},
  safeNumber = defaultSafeNumber
} = {}) {
  const config = normalizeHospitalityService(service, safeNumber);
  const tendays = Math.max(0, Math.floor(safeNumber(periods, 0)));
  const localDemand = Math.max(0, Math.floor(safeNumber(population, 0) * config.localDemandPerResident * tendays));
  const rawVisitorDemand = Math.max(0, Math.floor((
    safeNumber(reputation, 0) * config.visitorDemandPerReputation
    + safeNumber(connections, 0) * config.visitorDemandPerConnection
  ) * tendays));
  const guestCapacity = config.visitorRequiresHousing
    ? Math.max(0, Math.floor(safeNumber(housingCapacity, 0) * 10 * tendays))
    : rawVisitorDemand;
  const visitorDemand = config.visitorRequiresHousing
    ? (guestCapacity > 0 ? Math.min(rawVisitorDemand, guestCapacity) : 0)
    : rawVisitorDemand;
  const capacity = Math.max(0, Math.floor(safeNumber(effectiveWorkers, 0) * config.servicesPerWorker * tendays));
  return {
    config,
    periods: tendays,
    localDemand,
    rawVisitorDemand,
    visitorDemand,
    guestCapacity,
    demand: localDemand + visitorDemand,
    capacity
  };
}

export function sharedHospitalityDemandSnapshot({
  buildings = [],
  population = 0,
  reputation = 0,
  connections = 1,
  periods = 1,
  safeNumber = defaultSafeNumber
} = {}) {
  const tendays = Math.max(0, Math.floor(safeNumber(periods, 0)));
  const snapshots = (Array.isArray(buildings) ? buildings : []).map((building) => {
    const config = normalizeHospitalityService(building?.income?.service, safeNumber);
    const localDemand = Math.max(0, Math.floor(safeNumber(population, 0) * config.localDemandPerResident * tendays));
    const visitorDemand = Math.max(0, Math.floor((
      safeNumber(reputation, 0) * config.visitorDemandPerReputation
      + safeNumber(connections, 0) * config.visitorDemandPerConnection
    ) * tendays));
    return { config, periods: tendays, localDemand, visitorDemand, demand: localDemand + visitorDemand };
  });
  if (!snapshots.length) {
    const config = normalizeHospitalityService({}, safeNumber);
    return { config, periods: tendays, localDemand: 0, visitorDemand: 0, demand: 0 };
  }

  // Buildings with the same demandPool serve one audience. Their capacities
  // add, but duplicating the same venue must not duplicate residents or
  // visitors. A wider custom reach may enlarge that one pool; array order may
  // never decide the settlement result.
  return snapshots.reduce((best, candidate) => {
    if (candidate.demand !== best.demand) return candidate.demand > best.demand ? candidate : best;
    if (candidate.localDemand !== best.localDemand) return candidate.localDemand > best.localDemand ? candidate : best;
    if (candidate.visitorDemand !== best.visitorDemand) return candidate.visitorDemand > best.visitorDemand ? candidate : best;
    return best;
  });
}

function foodRows(holding, deps) {
  return [...(holding?.storage?.resources ?? [])]
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => deps.isFoodResource(row))
    .sort((left, right) => oldestLotQd(left.row) - oldestLotQd(right.row) || left.index - right.index)
    .map(({ row }) => row);
}

function foodEntry(holding, row, deps) {
  const shelfLife = shelfLifeProfileForResource(row, deps);
  const resourceId = deps.normalizeResourceId(row.resourceId, row.id, row.name);
  return {
    kind: "resource",
    holding,
    row,
    resourceId,
    name: row.name || deps.resourceLabel(resourceId),
    foodValue: Math.max(0, deps.foodValueForResource(row)),
    standardUnits: usesStandardRationUnits(row, deps),
    dietGroup: dietGroupForResource(row, deps),
    nutritionTags: nutritionTagsForResource(row, deps),
    shelfLifeTendays: shelfLife.tendays,
    shelfLifeDays: shelfLife.days,
    shelfLifeQd: shelfLife.qd
  };
}

function openedRationQd(holding, qd, deps) {
  return Math.max(0, Math.floor(
    deps.safeNumber(holding?.gm?.calendaria?.lastQd, 0) + Math.max(0, deps.safeNumber(qd, 0))
  ));
}

function availableFoodPersonDays(holding, deps, { targetQd = 0 } = {}) {
  const consumptionQd = Math.max(0, Math.floor(Number(targetQd) || 0) - 1);
  const buffer = normalizeRationBuffer(holding?.storage?.rationBuffer);
  const buffered = buffer.entries.reduce((sum, entry) => (
    entry.expiresQd > 0 && consumptionQd >= entry.expiresQd ? sum : sum + entry.points
  ), 0);
  return buffered + foodRows(holding, deps).reduce((sum, row) => {
    const qty = Math.max(0, deps.safeNumber(
      typeof deps.storageUsableQuantityAtQd === "function"
        ? deps.storageUsableQuantityAtQd(holding, row, consumptionQd)
        : deps.storageAvailableQuantity(holding, row),
      0
    ));
    const usableQty = usesStandardRationUnits(row, deps) ? Math.floor(qty + 1e-9) : qty;
    return sum + usableQty * Math.max(0, deps.foodValueForResource(row));
  }, 0);
}

function consumeFoodPersonDays(holding, personDays, deps, { targetQd = 0 } = {}) {
  let remaining = Math.max(0, deps.safeNumber(personDays, 0));
  const consumptionQd = Math.max(0, Math.floor(Number(targetQd) || 0) - 1);
  const entries = [];
  if (!holding.storage || typeof holding.storage !== "object" || Array.isArray(holding.storage)) holding.storage = {};
  const rationBuffer = normalizeRationBuffer(holding.storage.rationBuffer);
  holding.storage.rationBuffer = rationBuffer;

  const bufferedSources = rationBuffer.entries
    .filter((entry) => !(entry.expiresQd > 0 && consumptionQd >= entry.expiresQd))
    .sort((left, right) => {
      const leftExpiry = left.expiresQd || Number.POSITIVE_INFINITY;
      const rightExpiry = right.expiresQd || Number.POSITIVE_INFINITY;
      return leftExpiry - rightExpiry || left.openedQd - right.openedQd || left.id.localeCompare(right.id);
    });
  for (const bufferEntry of bufferedSources) {
    if (remaining <= 0.000001) break;
    const personDaysTaken = Math.min(remaining, bufferEntry.points);
    const spentPoints = Math.min(bufferEntry.points, Math.ceil(personDaysTaken - 1e-9));
    if (!spentPoints) continue;
    bufferEntry.points -= spentPoints;
    remaining = Math.max(0, Number((remaining - personDaysTaken).toFixed(6)));
    entries.push({
      domain: "service",
      kind: "ration-buffer",
      resourceId: bufferEntry.resourceId,
      name: bufferEntry.name,
      qty: -spentPoints,
      roomId: bufferEntry.sourceRoomId,
      source: "Услуги трактира",
      note: `${deps.formatNumber(personDaysTaken)} чел.-дн. на питание гостей из открытой партии`,
      meta: {
        personDays: personDaysTaken,
        wastedRationPoints: Math.max(0, spentPoints - personDaysTaken),
        sourceRowId: bufferEntry.sourceRowId
      }
    });
  }

  for (const row of foodRows(holding, deps)) {
    if (remaining <= 0.000001) break;
    const have = Math.max(0, deps.safeNumber(
      typeof deps.storageUsableQuantityAtQd === "function"
        ? deps.storageUsableQuantityAtQd(holding, row, consumptionQd)
        : deps.storageAvailableQuantity(holding, row),
      0
    ));
    const source = foodEntry(holding, row, deps);
    const foodValue = source.foodValue;
    if (!have || !foodValue) continue;
    const usableQty = source.standardUnits ? Math.floor(have + 1e-9) : have;
    const takenPersonDays = Math.min(remaining, usableQty * foodValue);
    const takenQty = source.standardUnits
      ? Math.min(usableQty, Math.ceil((takenPersonDays / foodValue) - 1e-9))
      : Math.min(usableQty, takenPersonDays / foodValue);
    const openedPoints = source.standardUnits ? takenQty * foodValue : takenPersonDays;
    const spentPoints = source.standardUnits ? Math.min(openedPoints, Math.ceil(takenPersonDays - 1e-9)) : takenPersonDays;
    const expiresQd = source.standardUnits ? baseExpiryQdForOpenedUnits(source, takenQty, targetQd) : 0;
    const bufferedPoints = source.standardUnits
      ? addRationBufferPoints(rationBuffer, source, openedPoints - spentPoints, targetQd, expiresQd, {
        normalizeRationBufferEntry,
        rationBufferEntryKey
      })
      : 0;
    deps.consumeStorageResource(holding, row, takenQty, { usableAtQd: consumptionQd });
    remaining = Math.max(0, Number((remaining - takenPersonDays).toFixed(6)));
    entries.push({
      domain: "service",
      kind: "resource",
      resourceId: source.resourceId,
      name: source.name,
      qty: -takenQty,
      roomId: row.roomId ?? row.storageRoomId ?? "",
      source: "Услуги трактира",
      note: `${deps.formatNumber(takenPersonDays)} чел.-дн. на питание гостей${bufferedPoints > 0 ? `; остаток ${bufferedPoints} рац. перенесён в буфер` : ""}`,
      meta: {
        personDays: takenPersonDays,
        bufferedRationPoints: bufferedPoints,
        wastedRationPoints: source.standardUnits ? Math.max(0, spentPoints - takenPersonDays) : 0
      }
    });
  }
  rationBuffer.entries = rationBuffer.entries.filter((entry) => entry.points > 0);
  return { consumed: Math.max(0, personDays - remaining), remaining, entries };
}

function resourceRows(holding, resourceId, deps) {
  const wanted = deps.normalizeResourceId(resourceId);
  if (!wanted) return [];
  return [...(holding?.storage?.resources ?? [])]
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => deps.normalizeResourceId(row?.resourceId, row?.id, row?.name) === wanted)
    .sort((left, right) => oldestLotQd(left.row) - oldestLotQd(right.row) || left.index - right.index)
    .map(({ row }) => row);
}

function availableResourceQty(holding, resourceId, deps) {
  return resourceRows(holding, resourceId, deps)
    .reduce((sum, row) => {
      const qty = Math.max(0, deps.safeNumber(deps.storageAvailableQuantity(holding, row), 0));
      const normalizedId = deps.normalizeResourceId(row.resourceId, row.id, row.name);
      const definition = deps.resourceDef(normalizedId, row.name);
      const quantityStep = deps.safeNumber(row.quantityStep ?? definition?.quantityStep, 0);
      const wholeUnits = quantityStep >= 1 || Number(row.economyVersion ?? definition?.economyVersion) >= 2;
      return sum + (wholeUnits ? Math.floor(qty + 1e-9) : qty);
    }, 0);
}

function consumeServiceResource(holding, resourceId, qty, building, deps) {
  let remaining = Math.max(0, deps.safeNumber(qty, 0));
  let consumedUnits = 0;
  const entries = [];
  for (const row of resourceRows(holding, resourceId, deps)) {
    if (remaining <= 0.000001) break;
    const have = Math.max(0, deps.safeNumber(deps.storageAvailableQuantity(holding, row), 0));
    if (!have) continue;
    const normalizedId = deps.normalizeResourceId(row.resourceId, row.id, row.name);
    const definition = deps.resourceDef(normalizedId, row.name);
    const quantityStep = deps.safeNumber(row.quantityStep ?? definition?.quantityStep, 0);
    const wholeUnits = quantityStep >= 1 || Number(row.economyVersion ?? definition?.economyVersion) >= 2;
    const available = wholeUnits ? Math.floor(have + 1e-9) : have;
    const taken = wholeUnits
      ? Math.min(available, Math.ceil(remaining - 1e-9))
      : Math.min(available, remaining);
    if (taken <= 0) continue;
    deps.consumeStorageResource(holding, row, taken);
    consumedUnits += taken;
    remaining = Math.max(0, Number((remaining - Math.min(remaining, taken)).toFixed(6)));
    entries.push({
      domain: "service",
      kind: "resource",
      resourceId: normalizedId,
      name: row.name || deps.resourceLabel(normalizedId),
      qty: -taken,
      roomId: row.roomId ?? row.storageRoomId ?? "",
      sourceId: building.id,
      source: building.name || "Услуги",
      note: `${deps.formatNumber(taken)} целых партий израсходовано на услуги`
    });
  }
  return { consumed: consumedUnits, fulfilled: Math.max(0, qty - remaining), remaining, entries };
}

export function runHospitalityServices({
  holding,
  qd = 0,
  report,
  workerContext = null,
  commonTableSnapshot = null,
  residentMealCapacity = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Hospitality service requires a holding draft.");
  if (!report || typeof report !== "object") throw new TypeError("FBL Skyhold | Hospitality service requires a mutable report.");
  const deps = serviceDependencies(dependencies);
  const periods = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 40);
  if (!periods) return { demand: 0, served: 0, revenue: 0, foodPersonDays: 0 };

  const buildings = (holding?.buildings?.list ?? []).filter((building) => (
    deps.buildingStatus(building).value === "built"
    && deps.buildingFunctions(building).income
    && deps.enterpriseCapitalReady(building, holding)
    && building?.income?.service?.enabled
  ));
  if (!buildings.length) return { demand: 0, served: 0, revenue: 0, foodPersonDays: 0 };

  if (!report.services || typeof report.services !== "object") {
    report.services = { demand: 0, capacity: 0, served: 0, unserved: 0, foodPersonDays: 0, revenue: 0, lines: [] };
  }
  if (!Array.isArray(report.services.lines)) report.services.lines = [];

  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const targetQd = openedRationQd(holding, qd, deps);
  const commonTableCapacities = commonTableCapacityMap(commonTableSnapshot ?? residentMealCapacity, deps.safeNumber);
  const reputation = Math.max(0, deps.safeNumber(deps.reputationTotal(holding), 0));
  const connections = Math.max(0, deps.safeNumber(holding?.gm?.modifiers?.marketConnectionsLevel, 1));
  const pools = new Map();
  for (const building of buildings) {
    const config = normalizeHospitalityService(building?.income?.service, deps.safeNumber);
    const list = pools.get(config.demandPool) ?? [];
    list.push(building);
    pools.set(config.demandPool, list);
  }

  let demandTotal = 0;
  let servedTotal = 0;
  let revenueTotal = 0;
  let foodTotal = 0;

  for (const poolBuildings of pools.values()) {
    if (poolBuildings.length > 1) report.services.lines.push("Общий спрос этого пула распределяется по явному приоритету зданий сверху вниз.");
    const sharedDemand = sharedHospitalityDemandSnapshot({
      buildings: poolBuildings,
      population: people.length,
      reputation,
      connections,
      periods,
      safeNumber: deps.safeNumber
    });
    const demandBasis = sharedDemand.config;
    let localRemaining = sharedDemand.localDemand;
    let visitorRemaining = sharedDemand.visitorDemand;
    const initialLocal = localRemaining;
    const initialVisitors = visitorRemaining;
    let poolCapacity = 0;

    for (const building of poolBuildings) {
      const workers = deps.buildingEffectiveWorkers(holding, building, workerContext);
      const baseSnapshot = hospitalityDemandSnapshot({
        population: people.length,
        reputation,
        connections,
        periods,
        effectiveWorkers: workers.total,
        housingCapacity: availableGuestHousingCapacity(building, people, deps.safeNumber),
        service: building?.income?.service,
        safeNumber: deps.safeNumber
      });
      const laborSnapshot = typeof deps.buildingLaborCapacity === "function"
        ? deps.buildingLaborCapacity(holding, building, workerContext, {
          unitsPerWorker: baseSnapshot.config.servicesPerWorker * periods,
          purpose: "service",
          useEfficiency: true
        })
        : null;
      const commonTableCapacity = isInnMealServiceBuilding(building)
        ? commonTableCapacityForBuilding(building, commonTableCapacities)
        : null;
      const snapshot = laborSnapshot
        ? { ...baseSnapshot, capacity: Math.max(0, Math.floor(deps.safeNumber(laborSnapshot.capacity, 0))) }
        : (commonTableCapacity === null
          ? baseSnapshot
          : { ...baseSnapshot, capacity: commonTableCapacity * periods });
      const commonTableReservedCapacity = laborSnapshot || commonTableCapacity === null
        ? 0
        : Math.max(0, baseSnapshot.capacity - snapshot.capacity);
      poolCapacity += snapshot.capacity;
      report.services.capacity += snapshot.capacity;
      if (!snapshot.capacity) {
        const reason = commonTableReservedCapacity > 0
          ? "вся рабочая мощность занята общим столом для жителей"
          : "нет рабочей мощности для обслуживания";
        report.services.lines.push(`${building.name || snapshot.config.label}: ${reason}.`);
        continue;
      }

      const visitorRequested = Math.min(visitorRemaining, snapshot.guestCapacity, snapshot.capacity);
      const localRequested = Math.min(localRemaining, Math.max(0, snapshot.capacity - visitorRequested));
      const requested = visitorRequested + localRequested;
      if (!requested) {
        report.services.lines.push(`${building.name || snapshot.config.label}: доступная мощность ${snapshot.capacity}, но спроса нет.`);
        continue;
      }

      const foodPerService = snapshot.config.foodPersonDaysPerService;
      const foodCapacity = foodPerService > 0
        ? Math.floor((availableFoodPersonDays(holding, deps, { targetQd }) + 0.000001) / foodPerService)
        : requested;
      const inputPerService = snapshot.config.inputQtyPerService;
      const inputCapacity = snapshot.config.inputResourceId && inputPerService > 0
        ? Math.floor((availableResourceQty(holding, snapshot.config.inputResourceId, deps) + 0.000001) / inputPerService)
        : requested;
      let served = Math.min(requested, foodCapacity, inputCapacity);
      const labor = served > 0 && typeof deps.spendBuildingLabor === "function"
        ? deps.spendBuildingLabor(holding, building, workerContext, {
          units: served,
          unitsPerWorker: snapshot.config.servicesPerWorker * periods,
          purpose: "service",
          useEfficiency: true
        })
        : null;
      if (labor && !labor.ok) served = 0;
      const visitorServed = Math.min(visitorRequested, served);
      const localServed = Math.min(localRequested, Math.max(0, served - visitorServed));
      const foodNeeded = served * foodPerService;
      const food = consumeFoodPersonDays(holding, foodNeeded, deps, { targetQd });
      if (food.entries.length) deps.appendLedger(report, food.entries.map((entry) => ({ ...entry, sourceId: building.id, source: building.name || snapshot.config.label })));
      const inputNeeded = served * inputPerService;
      const input = snapshot.config.inputResourceId && inputNeeded > 0
        ? consumeServiceResource(holding, snapshot.config.inputResourceId, inputNeeded, building, deps)
        : { consumed: 0, remaining: 0, entries: [] };
      if (input.entries.length) deps.appendLedger(report, input.entries);

      const revenue = Math.max(0, Math.floor(served * snapshot.config.priceCopper));
      if (revenue) {
        deps.addMoney(holding, revenue);
        deps.appendLedger(report, {
          domain: "service",
          kind: "money",
          resourceId: "money",
          name: "Выручка за услуги",
          qty: revenue,
          roomId: "treasury",
          sourceId: building.id,
          source: building.name || snapshot.config.label,
          note: `${served} услуг по ${deps.formatNumber(snapshot.config.priceCopper)} ММ; жители ${localServed}, гости ${visitorServed}`
        });
        report.income.push(`${building.name || snapshot.config.label}: Деньги +${revenue} (услуги ${served}; жители ${localServed}, гости ${visitorServed})`);
      }

      localRemaining = Math.max(0, localRemaining - localServed);
      visitorRemaining = Math.max(0, visitorRemaining - visitorServed);
      servedTotal += served;
      revenueTotal += revenue;
      foodTotal += food.consumed;
      const detail = [`спрос ${requested}`, `обслужено ${served}`];
      if (commonTableReservedCapacity > 0) detail.push(`общий стол ${commonTableReservedCapacity}`);
      if (labor?.ok && labor.laborQd > 0) detail.push(`труд ${labor.laborQd} QD`);
      if (foodPerService > 0) detail.push(`пища ${deps.formatNumber(food.consumed)} чел.-дн.`);
      if (inputPerService > 0) detail.push(`${deps.resourceLabel(snapshot.config.inputResourceId)} ${deps.formatNumber(input.consumed)}`);
      detail.push(`выручка ${revenue} ММ`);
      report.services.lines.push(`${building.name || snapshot.config.label}: ${detail.join(", ")}.`);
      if (served < requested) {
        const reasons = [];
        if (foodCapacity < requested) reasons.push("пищи после питания жителей");
        if (inputCapacity < requested) reasons.push(deps.resourceLabel(snapshot.config.inputResourceId));
        report.services.lines.push(`${building.name || snapshot.config.label}: не обслужено ${requested - served} — не хватило ${reasons.join(" и ") || "ресурсов"}.`);
      }
    }

    const poolDemand = initialLocal + initialVisitors;
    const poolUnserved = Math.max(0, localRemaining + visitorRemaining);
    demandTotal += poolDemand;
    report.services.demand += poolDemand;
    report.services.unserved += poolUnserved;
    if (poolUnserved > 0 && poolCapacity < poolDemand) {
      report.services.lines.push(`${demandBasis.label}: не обслужено ${poolUnserved} из-за нехватки рабочей мощности или доступных мест.`);
    }
  }

  report.services.served += servedTotal;
  report.services.foodPersonDays += foodTotal;
  report.services.revenue += revenueTotal;
  return { demand: demandTotal, served: servedTotal, unserved: Math.max(0, demandTotal - servedTotal), revenue: revenueTotal, foodPersonDays: foodTotal };
}
