function tradeDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "random",
    "buildingStatus",
    "buildingFunctions",
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

  const buildings = (holding?.buildings?.list ?? []).filter((building) => (
    deps.buildingStatus(building).value === "built"
    && deps.buildingFunctions(building).income
    && building?.income?.trade?.enabled
  ));
  if (!buildings.length) return { sold: 0, buyers: 0, revenue: 0 };

  const assignedByBuilding = new Map(buildings.map((building) => [
    building,
    deps.assignedBuildingPeople(holding, building, workerContext)
  ]));
  const staffedBuildings = buildings.filter((building) => (assignedByBuilding.get(building) ?? []).length > 0);
  if (!staffedBuildings.length) {
    report?.skipped?.push?.("Торговля: ни в одном торговом здании не назначен работник.");
    return { sold: 0, buyers: 0, revenue: 0 };
  }

  if (!report.trade || typeof report.trade !== "object") report.trade = { buyers: 0, sold: 0, revenue: 0, purchases: [] };
  if (!Array.isArray(report.trade.purchases)) report.trade.purchases = [];

  let sold = 0;
  let buyersTotal = 0;
  let revenueTotal = 0;
  const reputation = Math.max(0, Math.floor(deps.safeNumber(deps.reputationTotal(holding), 0)));
  if (!reputation) {
    report?.skipped?.push?.("Торговля: нет Репутации для поиска покупателей.");
    return { sold, buyers: buyersTotal, revenue: revenueTotal };
  }

  const buildingFilters = new Map(staffedBuildings.map((building) => [building, deps.tradeCandidateFilters(building)]));
  const candidatePools = new Map(staffedBuildings.map((building) => [building, deps.tradeCandidates(holding, buildingFilters.get(building))]));
  const candidatesForBudget = (building, budget, priceEfficiency) => {
    const pool = candidatePools.get(building) ?? [];
    return pool.filter((candidate) => (
      deps.tradeCandidateQuantity(candidate) > 0
      && deps.tradeUnitSalePrice(candidate.basePrice, priceEfficiency) <= budget
    ));
  };
  const eligibleShops = () => staffedBuildings.filter((building) => (
    candidatePools.get(building) ?? []
  ).some((candidate) => deps.tradeCandidateQuantity(candidate) > 0));

  for (let day = 1; day <= days; day += 1) {
    const rolls = Array.from({ length: reputation }, () => Math.ceil(deps.random() * 6));
    const buyers = rolls.filter((die) => die === 6).length;
    if (!buyers) continue;
    buyersTotal += buyers;
    report.trade.buyers += buyers;

    for (let buyer = 1; buyer <= buyers; buyer += 1) {
      const shops = eligibleShops();
      if (!shops.length) {
        report?.skipped?.push?.("Торговля: покупатель не нашел подходящих товаров с отметкой к продаже.");
        break;
      }

      const building = shops[Math.floor(deps.random() * shops.length)];
      const trade = building.income?.trade ?? {};
      const traders = assignedByBuilding.get(building) ?? [];
      const traderCount = traders.length;
      const pickedTrader = traders[Math.floor(deps.random() * traders.length)];
      const sellerEfficiency = Math.max(0, deps.personBuildingEfficiency(holding, building, pickedTrader, workerContext));
      const priceEfficiency = Math.max(0.1, sellerEfficiency);
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
        sold += taken;
        revenueTotal += revenue;
        report.trade.sold += taken;
        report.trade.revenue += revenue;
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
          note: `Продал: ${pickedTrader?.name || "назначенный торговец"}`
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
        report.trade.purchases.push({
          building: building.name || "Здание",
          item: candidate.name,
          kind: candidate.kind,
          resourceId,
          itemId,
          roomId: candidate.roomId,
          qty: taken,
          revenue,
          unitPrice,
          trader: pickedTrader?.name || "назначенный торговец",
          efficiency: priceEfficiency
        });
      }

      const traderText = `, торговец: ${pickedTrader?.name || "житель"}`;
      if (!buyerSpent) {
        report?.skipped?.push?.(`${building.name || "Здание"}: покупатель ничего не купил, бюджет ${budgetRoll.result} = ${budgetRoll.total}${traderText}.`);
      }
    }
  }

  if (Array.isArray(holding?.storage?.items)) {
    holding.storage.items = holding.storage.items.filter((row) => (
      deps.itemQuantity(row) > 0
      && Math.max(0, deps.safeNumber(row.qty ?? row.itemData?.system?.quantity ?? 1, 1)) > 0
    ));
  }
  return { sold, buyers: buyersTotal, revenue: revenueTotal };
}
