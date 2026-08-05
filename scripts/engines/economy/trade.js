function tradeDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "random",
    "buildingStatus",
    "buildingFunctions",
    "buildingEffectiveWorkers",
    "reputationTotal",
    "tradeCandidateFilters",
    "tradeCandidates",
    "tradeCandidateQuantity",
    "tradeUnitSalePrice",
    "assignedBuildingPeople",
    "personBuildingEfficiency",
    "rollFormulaTotal",
    "reduceTradeCandidate",
    "addMoney",
    "itemQuantity"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Trade requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function defaultSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeTradeDemand(trade = {}, safeNumber = defaultSafeNumber) {
  return {
    demandModel: String(trade?.demandModel ?? "legacy") === "settlement" ? "settlement" : "legacy",
    localDemandPerResident: Math.max(0, safeNumber(trade?.localDemandPerResident, 0.08)),
    visitorDemandPerReputation: Math.max(0, safeNumber(trade?.visitorDemandPerReputation, 1)),
    visitorDemandPerConnection: Math.max(0, safeNumber(trade?.visitorDemandPerConnection, 1)),
    buyersPerWorker: Math.max(0, safeNumber(trade?.buyersPerWorker, 8))
  };
}

export function tradeDemandSnapshot({
  population = 0,
  reputation = 0,
  connections = 1,
  periods = 1,
  effectiveWorkers = 0,
  trade = {},
  safeNumber = defaultSafeNumber
} = {}) {
  const config = normalizeTradeDemand(trade, safeNumber);
  const tendays = Math.max(0, Math.floor(safeNumber(periods, 0)));
  const localDemand = Math.max(0, Math.floor(safeNumber(population, 0) * config.localDemandPerResident * tendays));
  const visitorDemand = Math.max(0, Math.floor((
    safeNumber(reputation, 0) * config.visitorDemandPerReputation
    + safeNumber(connections, 0) * config.visitorDemandPerConnection
  ) * tendays));
  const capacity = Math.max(0, Math.floor(safeNumber(effectiveWorkers, 0) * config.buyersPerWorker * tendays));
  return {
    config,
    periods: tendays,
    localDemand,
    visitorDemand,
    demand: localDemand + visitorDemand,
    capacity
  };
}

export function sharedTradeDemandSnapshot({
  buildings = [],
  population = 0,
  reputation = 0,
  connections = 1,
  periods = 1,
  safeNumber = defaultSafeNumber
} = {}) {
  const snapshots = (Array.isArray(buildings) ? buildings : [])
    .map((building) => tradeDemandSnapshot({
      population,
      reputation,
      connections,
      periods,
      effectiveWorkers: 0,
      trade: building?.income?.trade,
      safeNumber
    }))
    .filter((snapshot) => snapshot.config.demandModel === "settlement");
  if (!snapshots.length) return tradeDemandSnapshot({ population, reputation, connections, periods, safeNumber });

  // Settlement markets share one non-additive customer pool. Different custom
  // storefronts may advertise different reach; the widest configured reach
  // opens the pool while their staffed service capacities still add together.
  // Selecting by calculated reach instead of array position makes the result
  // stable when buildings are reordered and prevents duplicated demand.
  return snapshots.reduce((best, candidate) => {
    if (candidate.demand !== best.demand) return candidate.demand > best.demand ? candidate : best;
    if (candidate.localDemand !== best.localDemand) return candidate.localDemand > best.localDemand ? candidate : best;
    if (candidate.visitorDemand !== best.visitorDemand) return candidate.visitorDemand > best.visitorDemand ? candidate : best;
    return best;
  });
}

function ensureTradeReport(report = {}) {
  if (!report.trade || typeof report.trade !== "object") report.trade = {};
  const trade = report.trade;
  trade.buyers = Math.max(0, Number(trade.buyers) || 0);
  trade.sold = Math.max(0, Number(trade.sold) || 0);
  trade.revenue = Math.max(0, Number(trade.revenue) || 0);
  trade.demand = Math.max(0, Number(trade.demand) || 0);
  trade.capacity = Math.max(0, Number(trade.capacity) || 0);
  trade.servedBuyers = Math.max(0, Number(trade.servedBuyers) || 0);
  trade.unserved = Math.max(0, Number(trade.unserved) || 0);
  trade.capacityShortfall = Math.max(0, Number(trade.capacityShortfall) || 0);
  trade.stockShortfall = Math.max(0, Number(trade.stockShortfall) || 0);
  if (!Array.isArray(trade.purchases)) trade.purchases = [];
  if (!Array.isArray(trade.lines)) trade.lines = [];
  return trade;
}

export async function runTrade({
  holding,
  qd = 0,
  report,
  workerContext = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Trade requires a holding draft.");
  if (!report || typeof report !== "object") throw new TypeError("FBL Skyhold | Trade requires a mutable report.");
  const deps = tradeDependencies(dependencies);
  const days = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 4);
  if (!days) return { sold: 0, buyers: 0, revenue: 0 };

  const capitalReady = (building) => typeof deps.enterpriseCapitalReady !== "function" || deps.enterpriseCapitalReady(building, holding);
  const buildings = (holding?.buildings?.list ?? []).filter((building) => (
    deps.buildingStatus(building).value === "built"
    && deps.buildingFunctions(building).income
    && building?.income?.trade?.enabled
    && capitalReady(building)
  ));
  if (!buildings.length) return { sold: 0, buyers: 0, revenue: 0 };

  const tradeReport = ensureTradeReport(report);
  let sold = 0;
  let buyersTotal = 0;
  let revenueTotal = 0;
  let demandTotal = 0;
  let capacityTotal = 0;
  let servedBuyersTotal = 0;
  let unservedTotal = 0;
  const reputation = Math.max(0, Math.floor(deps.safeNumber(deps.reputationTotal(holding), 0)));
  const connections = Math.max(0, deps.safeNumber(holding?.gm?.modifiers?.marketConnectionsLevel, 1));
  const population = (holding?.people?.list ?? []).filter((person) => !person?.dead).length;
  const buildingFilters = new Map(buildings.map((building) => [building, deps.tradeCandidateFilters(building)]));
  const candidatePools = new Map(buildings.map((building) => [building, deps.tradeCandidates(holding, buildingFilters.get(building))]));
  const candidatesForBudget = (building, budget, priceEfficiency) => {
    const pool = candidatePools.get(building) ?? [];
    return pool.filter((candidate) => (
      deps.tradeCandidateQuantity(candidate) > 0
      && deps.tradeUnitSalePrice(candidate.basePrice, priceEfficiency) <= budget
    ));
  };
  const eligibleShops = (source) => source.filter((building) => (
    candidatePools.get(building) ?? []
  ).some((candidate) => deps.tradeCandidateQuantity(candidate) > 0));

  const processBuyer = async (building, { buyers = 1, day = 1, emitSkip = false, laborRate = null } = {}) => {
    const trade = building.income?.trade ?? {};
    const normalizedDemand = normalizeTradeDemand(trade, deps.safeNumber);
    const buyerLaborRate = Math.max(0, deps.safeNumber(laborRate, normalizedDemand.buyersPerWorker));
    const labor = typeof deps.spendBuildingLabor === "function"
      ? deps.spendBuildingLabor(holding, building, workerContext, {
        units: 1,
        unitsPerWorker: buyerLaborRate,
        purpose: "trade",
        useEfficiency: true
      })
      : null;
    if (labor && !labor.ok) return { spent: 0, sold: 0, laborBlocked: true };
    const assigned = deps.assignedBuildingPeople(holding, building, workerContext);
    const traders = assigned.length ? assigned : [null];
    const traderCount = Math.max(1, traders.length);
    const pickedTrader = traders[Math.floor(deps.random() * traders.length)] ?? null;
    const sellerEfficiency = pickedTrader
      ? Math.max(0, deps.personBuildingEfficiency(holding, building, pickedTrader, workerContext))
      : 1;
    const priceEfficiency = Math.max(0.1, sellerEfficiency || 1);
    const budgetRoll = await deps.rollFormulaTotal(String(trade.budgetFormula || "2d6*10"), {
      eff: priceEfficiency,
      workers: traderCount,
      reputation,
      buyers,
      qd,
      days,
      day
    });
    let budget = Math.max(0, Math.floor(deps.safeNumber(budgetRoll.total, 0)));
    const lots = Math.max(1, Math.floor(deps.safeNumber(trade.maxLotsPerBuyer, 1))) * traderCount;
    let buyerSpent = 0;
    let buyerSold = 0;

    for (let lot = 0; lot < lots && budget > 0; lot += 1) {
      const candidates = candidatesForBudget(building, budget, priceEfficiency);
      if (!candidates.length) break;
      const candidate = candidates[Math.floor(deps.random() * candidates.length)];
      const unitPrice = deps.tradeUnitSalePrice(candidate.basePrice, priceEfficiency);
      const amount = Math.min(deps.tradeCandidateQuantity(candidate), Math.floor(budget / Math.max(1, unitPrice)));
      if (!amount) break;
      const taken = deps.reduceTradeCandidate(candidate, amount);
      if (!taken) break;
      const revenue = taken * unitPrice;
      deps.addMoney(holding, revenue);
      budget -= revenue;
      buyerSpent += revenue;
      buyerSold += taken;
      sold += taken;
      revenueTotal += revenue;
      tradeReport.sold += taken;
      tradeReport.revenue += revenue;
      const resourceId = candidate.kind === "resource" ? String(candidate.row?.resourceId ?? candidate.row?.id ?? "custom") : "";
      const itemId = candidate.kind === "item" ? String(candidate.row?.itemUuid ?? candidate.row?.uuid ?? candidate.row?.id ?? "") : "";
      deps.appendLedger?.(report, [{
        domain: "trade",
        kind: candidate.kind === "item" ? "item" : "resource",
        resourceId,
        itemId,
        name: candidate.name,
        qty: -taken,
        roomId: candidate.roomId,
        sourceId: building.id,
        source: building.name || "Здание",
        note: pickedTrader?.name ? `Продал: ${pickedTrader.name}` : "Независимая продажа"
      }, {
        domain: "trade",
        kind: "money",
        resourceId: "money",
        name: "Выручка",
        qty: revenue,
        roomId: "treasury",
        sourceId: building.id,
        source: building.name || "Здание",
        note: `${candidate.name}: ${taken} ед. по ${unitPrice} ММ`
      }]);
      tradeReport.purchases.push({
        building: building.name || "Здание",
        item: candidate.name,
        kind: candidate.kind,
        resourceId,
        itemId,
        roomId: candidate.roomId,
        qty: taken,
        revenue,
        unitPrice,
        trader: pickedTrader?.name || "",
        efficiency: priceEfficiency
      });
    }

    if (!buyerSpent && emitSkip) {
      const traderText = pickedTrader ? `, торговец: ${pickedTrader.name || "житель"}` : ", торговец не назначен";
      report?.skipped?.push?.(`${building.name || "Здание"}: покупатель ничего не купил, бюджет ${budgetRoll.result} = ${budgetRoll.total}${traderText}.`);
    }
    return { spent: buyerSpent, sold: buyerSold };
  };

  const settlementBuildings = buildings.filter((building) => normalizeTradeDemand(building?.income?.trade, deps.safeNumber).demandModel === "settlement");
  const legacyBuildings = buildings.filter((building) => !settlementBuildings.includes(building));
  const periods = Math.floor(Math.max(0, deps.safeNumber(qd, 0)) / 40);

  if (settlementBuildings.length && periods > 0) {
    if (settlementBuildings.length > 1) tradeReport.lines.push("Общий спрос распределяется по явному приоритету зданий сверху вниз.");
    const demandSnapshot = sharedTradeDemandSnapshot({
      buildings: settlementBuildings,
      population,
      reputation,
      connections,
      periods,
      safeNumber: deps.safeNumber
    });
    const demand = demandSnapshot.demand;
    const capacities = new Map(settlementBuildings.map((building) => {
      const config = normalizeTradeDemand(building?.income?.trade, deps.safeNumber);
      const laborCapacity = typeof deps.buildingLaborCapacity === "function"
        ? deps.buildingLaborCapacity(holding, building, workerContext, {
          unitsPerWorker: config.buyersPerWorker * periods,
          purpose: "trade",
          useEfficiency: true
        })
        : null;
      const effectiveWorkers = deps.buildingEffectiveWorkers(holding, building, workerContext)?.total ?? 0;
      const snapshot = tradeDemandSnapshot({ population, reputation, connections, periods, effectiveWorkers, trade: building?.income?.trade, safeNumber: deps.safeNumber });
      return [building, laborCapacity ? Math.max(0, Math.floor(deps.safeNumber(laborCapacity.capacity, 0))) : snapshot.capacity];
    }));
    const capacity = [...capacities.values()].reduce((sum, value) => sum + value, 0);
    let remaining = demand;
    let served = 0;
    let failedAttempts = 0;

    for (const building of settlementBuildings) {
      const buildingCapacity = capacities.get(building) ?? 0;
      let used = 0;
      let buildingServed = 0;
      while (remaining > 0 && used < buildingCapacity) {
        const result = await processBuyer(building, {
          buyers: demand,
          buyer: used + 1,
          emitSkip: false,
          laborRate: normalizeTradeDemand(building?.income?.trade, deps.safeNumber).buyersPerWorker * periods
        });
        if (result.laborBlocked) break;
        used += 1;
        if (result.spent > 0) {
          remaining -= 1;
          served += 1;
          buildingServed += 1;
        } else failedAttempts += 1;
      }
      if (!buildingCapacity) tradeReport.lines.push(`${building.name || "Рынок"}: нет рабочей мощности для покупателей.`);
      else tradeReport.lines.push(`${building.name || "Рынок"}: мощность ${buildingCapacity}, покупателей с покупкой ${buildingServed}.`);
    }

    const arrivals = Math.min(demand, capacity);
    const unserved = Math.max(0, demand - served);
    const capacityShortfall = Math.max(0, demand - capacity);
    const stockShortfall = Math.max(0, unserved - capacityShortfall);
    buyersTotal += arrivals;
    servedBuyersTotal += served;
    demandTotal += demand;
    capacityTotal += capacity;
    unservedTotal += unserved;
    tradeReport.buyers += arrivals;
    tradeReport.servedBuyers += served;
    tradeReport.demand += demand;
    tradeReport.capacity += capacity;
    tradeReport.unserved += unserved;
    tradeReport.capacityShortfall += capacityShortfall;
    tradeReport.stockShortfall += stockShortfall;
    tradeReport.lines.push(`Общий спрос ${demand}: жители ${demandSnapshot.localDemand}, приезжие ${demandSnapshot.visitorDemand}; обслужено покупкой ${served}, не обслужено ${unserved}.`);
    if (capacityShortfall) tradeReport.lines.push(`Не хватило торговцев: потеряно не менее ${capacityShortfall} покупателей.`);
    if (stockShortfall || failedAttempts) tradeReport.lines.push(`Не хватило подходящего товара или бюджета: не состоялось ${stockShortfall} покупок.`);
  }

  if (legacyBuildings.length) {
    if (!reputation) report?.skipped?.push?.("Торговля: нет Репутации для поиска покупателей.");
    else {
      for (let day = 1; day <= days; day += 1) {
        const rolls = Array.from({ length: reputation }, () => Math.ceil(deps.random() * 6));
        const buyers = rolls.filter((die) => die === 6).length;
        if (!buyers) continue;
        buyersTotal += buyers;
        tradeReport.buyers += buyers;
        for (let buyer = 1; buyer <= buyers; buyer += 1) {
          const shops = eligibleShops(legacyBuildings);
          if (!shops.length) {
            report?.skipped?.push?.("Торговля: покупатель не нашел подходящих товаров с отметкой к продаже.");
            break;
          }
          const building = shops[Math.floor(deps.random() * shops.length)];
          const result = await processBuyer(building, { buyers, day, buyer, emitSkip: true });
          if (result.laborBlocked) {
            report?.skipped?.push?.(`${building.name || "Здание"}: покупатель не обслужен — не осталось рабочих QD.`);
          }
        }
      }
    }
  }

  if (Array.isArray(holding?.storage?.items)) {
    holding.storage.items = holding.storage.items.filter((row) => (
      deps.itemQuantity(row) > 0
      && Math.max(0, deps.safeNumber(row.qty ?? row.itemData?.system?.quantity ?? 1, 1)) > 0
    ));
  }
  if (!settlementBuildings.length) return { sold, buyers: buyersTotal, revenue: revenueTotal };
  return {
    sold,
    buyers: buyersTotal,
    revenue: revenueTotal,
    demand: demandTotal,
    capacity: capacityTotal,
    servedBuyers: servedBuyersTotal,
    unserved: unservedTotal
  };
}
