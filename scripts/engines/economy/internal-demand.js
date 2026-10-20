const MAX_SAFE_BUDGET = Number.MAX_SAFE_INTEGER;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value, min)));
}

function uniqueTags(values = []) {
  const source = Array.isArray(values) ? values : [values];
  return Array.from(new Set(source.map((value) => text(value).toLowerCase()).filter(Boolean)));
}

function stableId(row = {}, fallback = "") {
  return text(row.id ?? row.key ?? row.sourceId ?? row.buildingId ?? fallback);
}

function priority(row = {}) {
  return Math.floor(finite(row.priority ?? row.gmPriority, 0));
}

function comparePriorityThenId(left = {}, right = {}) {
  const priorityDelta = priority(right) - priority(left);
  if (priorityDelta) return priorityDelta;
  return stableId(left).localeCompare(stableId(right), "ru");
}

function candidateTags(candidate = {}) {
  return uniqueTags([
    ...(Array.isArray(candidate.tags) ? candidate.tags : []),
    candidate.categoryTag,
    ...(Array.isArray(candidate.marketTags) ? candidate.marketTags : []),
    candidate.kind === "service" ? "service" : ""
  ]);
}

function tagSetAllows(allowed = [], candidate = {}) {
  const selectors = uniqueTags(allowed);
  if (!selectors.length || selectors.includes("all")) return true;
  const tags = new Set(candidateTags(candidate));
  return selectors.some((selector) => tags.has(selector));
}

function candidateAvailableToPool(candidate = {}, pool = {}) {
  const sourceIds = uniqueTags(candidate.sourceIds ?? []);
  if (sourceIds.length && !sourceIds.includes(text(pool.id).toLowerCase())) return false;
  return tagSetAllows(pool.allowedTags, candidate);
}

function candidateAvailableToChannel(candidate = {}, channel = {}) {
  const channelId = text(channel.id);
  if (candidate.channelId && text(candidate.channelId) !== channelId) return false;
  if (channel.roomId && channel.roomId !== "all" && text(candidate.roomId) !== channel.roomId) return false;
  if (channel.allowedKinds.length && !channel.allowedKinds.includes(candidate.kind)) return false;
  return tagSetAllows(channel.allowedTags, candidate);
}

function expirySortValue(value) {
  if (value === null || value === undefined || value === "") return MAX_SAFE_BUDGET;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : MAX_SAFE_BUDGET;
}

function normalizedExpiry(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, whole(parsed)) : null;
}

function compareCandidates(left = {}, right = {}) {
  const leftExpiry = expirySortValue(left.expiresInQd);
  const rightExpiry = expirySortValue(right.expiresInQd);
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  const priceDelta = whole(left.basePriceCopper) - whole(right.basePriceCopper);
  if (priceDelta) return priceDelta;
  const priorityDelta = priority(right) - priority(left);
  if (priorityDelta) return priorityDelta;
  const ageDelta = whole(right.ageQd) - whole(left.ageQd);
  if (ageDelta) return ageDelta;
  return stableId(left).localeCompare(stableId(right), "ru");
}

function normalizedPool(row = {}, index = 0) {
  return {
    id: stableId(row, `pool-${index + 1}`),
    label: text(row.label ?? row.name ?? row.id ?? `Спрос ${index + 1}`),
    budgetCopper: whole(row.budgetCopper),
    allowedTags: uniqueTags(row.allowedTags ?? ["all"]),
    priority: priority(row),
    source: text(row.source ?? row.id)
  };
}

function normalizedChannel(row = {}, index = 0) {
  const sellerEfficiency = Math.max(0, finite(row.sellerEfficiency, 0));
  return {
    id: stableId(row, `channel-${index + 1}`),
    buildingId: text(row.buildingId ?? row.id),
    label: text(row.label ?? row.name ?? row.id ?? `Канал ${index + 1}`),
    sourceIds: uniqueTags(row.sourceIds ?? ["population"]),
    allowedTags: uniqueTags(row.allowedTags ?? ["all"]),
    allowedKinds: uniqueTags(row.allowedKinds ?? ["resource", "item", "service"]),
    roomId: text(row.roomId || "all"),
    throughputUnits: whole(row.throughputUnits),
    sellerEfficiency,
    sellerName: text(row.sellerName ?? row.trader ?? "назначенный торговец"),
    priority: priority(row),
    diminishingFactor: clamp(row.diminishingFactor ?? 1, 0, 1)
  };
}

function normalizedCandidate(row = {}, index = 0) {
  return {
    id: stableId(row, `candidate-${index + 1}`),
    kind: ["resource", "item", "service"].includes(text(row.kind)) ? text(row.kind) : "resource",
    name: text(row.name ?? row.label ?? row.id ?? `Товар ${index + 1}`),
    qty: whole(row.qty),
    basePriceCopper: whole(row.basePriceCopper),
    categoryTag: text(row.categoryTag).toLowerCase(),
    marketTags: uniqueTags(row.marketTags),
    tags: candidateTags(row),
    sourceIds: uniqueTags(row.sourceIds),
    channelId: text(row.channelId),
    expiresInQd: normalizedExpiry(row.expiresInQd),
    ageQd: whole(row.ageQd),
    gmPriority: priority(row),
    roomId: text(row.roomId),
    resourceId: text(row.resourceId),
    itemId: text(row.itemId),
    origin: text(row.origin),
    snapshot: row
  };
}

export function internalDemandSellerPriceFactor(efficiency = 2) {
  return clamp(finite(efficiency, 2) * 0.5, 0.5, 1.5);
}

export function internalDemandUnitPrice(basePriceCopper = 0, sellerEfficiency = 2) {
  const base = whole(basePriceCopper);
  if (!base) return 0;
  return Math.max(1, Math.round(base * internalDemandSellerPriceFactor(sellerEfficiency)));
}

export function internalDemandDiminishingFactor(ordinal = 0) {
  return 1 / (Math.max(0, whole(ordinal)) + 1);
}

export function diminishingDemandBudget(sources = []) {
  return [...(Array.isArray(sources) ? sources : [])]
    .filter((row) => row?.active !== false && whole(row?.budgetCopper) > 0)
    .sort(comparePriorityThenId)
    .reduce((sum, row, index) => sum + Math.floor(whole(row.budgetCopper) * internalDemandDiminishingFactor(index)), 0);
}

export function buildInternalDemandPools({
  populationCount = 0,
  populationBudgetPerResidentCopper = 0,
  satisfactionFactor = 1,
  wagePaymentRatio = 1,
  innVisitorSources = [],
  marketFlowSources = [],
  priorities = {}
} = {}) {
  const populationBudget = Math.floor(
    whole(populationCount)
      * whole(populationBudgetPerResidentCopper)
      * clamp(satisfactionFactor, 0, 2)
      * clamp(wagePaymentRatio, 0, 1)
  );
  return [
    {
      id: "population",
      label: "Население",
      budgetCopper: populationBudget,
      allowedTags: ["all"],
      priority: finite(priorities.population, 30),
      source: "population"
    },
    {
      id: "inn-visitors",
      label: "Гости трактиров",
      budgetCopper: diminishingDemandBudget(innVisitorSources),
      allowedTags: ["food.prepared", "alcohol", "beverage", "service", "service.inn"],
      priority: finite(priorities.innVisitors, 20),
      source: "inn-visitors"
    },
    {
      id: "market-flow",
      label: "Внешний поток рынка",
      budgetCopper: diminishingDemandBudget(marketFlowSources),
      allowedTags: ["all"],
      priority: finite(priorities.marketFlow, 10),
      source: "market-flow"
    }
  ];
}

export function planInternalDemand({ pools = [], channels = [], candidates = [], operationId = "" } = {}) {
  const normalizedPools = (Array.isArray(pools) ? pools : []).map(normalizedPool).filter((row) => row.id && row.budgetCopper > 0).sort(comparePriorityThenId);
  const normalizedChannels = (Array.isArray(channels) ? channels : []).map(normalizedChannel).filter((row) => row.id && row.throughputUnits > 0 && row.sourceIds.length).sort(comparePriorityThenId);
  const normalizedCandidates = (Array.isArray(candidates) ? candidates : []).map(normalizedCandidate).filter((row) => row.id && row.qty > 0 && row.basePriceCopper > 0);
  const remainingQty = new Map(normalizedCandidates.map((row) => [row.id, row.qty]));
  const remainingThroughput = new Map(normalizedChannels.map((row) => [row.id, Math.floor(row.throughputUnits * row.diminishingFactor)]));
  const sales = [];
  const poolSummaries = [];

  for (const pool of normalizedPools) {
    let remainingBudget = pool.budgetCopper;
    let spentCopper = 0;
    let soldUnits = 0;
    const sourceId = text(pool.id).toLowerCase();
    const poolChannels = normalizedChannels.filter((channel) => channel.sourceIds.includes(sourceId));

    for (const channel of poolChannels) {
      let channelRoom = whole(remainingThroughput.get(channel.id));
      if (!channelRoom || !remainingBudget) continue;
      const priceFactor = internalDemandSellerPriceFactor(channel.sellerEfficiency);
      const eligible = normalizedCandidates
        .filter((candidate) => whole(remainingQty.get(candidate.id)) > 0)
        .filter((candidate) => candidateAvailableToPool(candidate, pool) && candidateAvailableToChannel(candidate, channel))
        .sort(compareCandidates);

      for (const candidate of eligible) {
        if (!remainingBudget || !channelRoom) break;
        const unitPriceCopper = internalDemandUnitPrice(candidate.basePriceCopper, channel.sellerEfficiency);
        if (!unitPriceCopper || unitPriceCopper > remainingBudget) continue;
        const available = whole(remainingQty.get(candidate.id));
        const qty = Math.min(available, channelRoom, Math.floor(remainingBudget / unitPriceCopper));
        if (!qty) continue;
        const revenueCopper = qty * unitPriceCopper;
        remainingQty.set(candidate.id, available - qty);
        channelRoom -= qty;
        remainingThroughput.set(channel.id, channelRoom);
        remainingBudget -= revenueCopper;
        spentCopper += revenueCopper;
        soldUnits += qty;
        sales.push({
          id: `${text(operationId) || "internal-demand"}:${pool.id}:${channel.id}:${candidate.id}:${sales.length + 1}`,
          poolId: pool.id,
          poolLabel: pool.label,
          channelId: channel.id,
          buildingId: channel.buildingId,
          channelLabel: channel.label,
          candidateId: candidate.id,
          kind: candidate.kind,
          name: candidate.name,
          resourceId: candidate.resourceId,
          itemId: candidate.itemId,
          roomId: candidate.roomId,
          origin: candidate.origin,
          qty,
          basePriceCopper: candidate.basePriceCopper,
          sellerEfficiency: channel.sellerEfficiency,
          sellerPriceFactor: priceFactor,
          sellerName: channel.sellerName,
          unitPriceCopper,
          revenueCopper,
          expiresInQd: candidate.expiresInQd
        });
      }
    }

    poolSummaries.push({
      id: pool.id,
      label: pool.label,
      budgetCopper: pool.budgetCopper,
      spentCopper,
      unusedCopper: remainingBudget,
      soldUnits
    });
  }

  const channelSummaries = normalizedChannels.map((channel) => ({
    id: channel.id,
    label: channel.label,
    throughputUnits: Math.floor(channel.throughputUnits * channel.diminishingFactor),
    usedUnits: Math.floor(channel.throughputUnits * channel.diminishingFactor) - whole(remainingThroughput.get(channel.id)),
    sellerEfficiency: channel.sellerEfficiency,
    sellerPriceFactor: internalDemandSellerPriceFactor(channel.sellerEfficiency)
  }));
  return {
    version: 1,
    operationId: text(operationId),
    sales,
    pools: poolSummaries,
    channels: channelSummaries,
    soldUnits: sales.reduce((sum, row) => sum + row.qty, 0),
    revenueCopper: sales.reduce((sum, row) => sum + row.revenueCopper, 0)
  };
}

function requireApplyDependencies(dependencies = {}) {
  for (const key of ["candidateQuantity", "takeCandidate", "addMoney"]) {
    if (typeof dependencies[key] !== "function") throw new TypeError(`FBL Skyhold | Internal demand requires dependency "${key}".`);
  }
  return dependencies;
}

export function applyInternalDemandPlan({ plan, candidates = [], report = null, dependencies = {} } = {}) {
  const deps = requireApplyDependencies(dependencies);
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.sales)) return { ok: false, message: "План внутреннего спроса отсутствует." };
  const byId = new Map((Array.isArray(candidates) ? candidates : []).map((candidate, index) => [stableId(candidate, `candidate-${index + 1}`), candidate]));
  const required = new Map();
  for (const sale of plan.sales) required.set(sale.candidateId, whole(required.get(sale.candidateId)) + whole(sale.qty));
  for (const [candidateId, qty] of required.entries()) {
    const candidate = byId.get(candidateId);
    if (!candidate || whole(deps.candidateQuantity(candidate)) < qty) {
      return { ok: false, stale: true, message: `Товар внутреннего спроса изменился после Preview: ${candidateId}.` };
    }
  }

  const applied = [];
  for (const sale of plan.sales) {
    const candidate = byId.get(sale.candidateId);
    const taken = whole(deps.takeCandidate(candidate, sale.qty));
    if (taken !== whole(sale.qty)) throw new Error(`FBL Skyhold | Internal demand apply diverged for ${sale.candidateId}.`);
    deps.addMoney(sale.revenueCopper);
    const row = { ...sale, appliedQty: taken };
    applied.push(row);
    deps.appendLedger?.(report, [{
      domain: "trade",
      kind: sale.kind,
      resourceId: sale.resourceId,
      itemId: sale.itemId,
      name: sale.name,
      qty: -taken,
      roomId: sale.roomId,
      sourceId: sale.channelId,
      source: sale.channelLabel,
      note: `${sale.sellerName}; спрос: ${sale.poolLabel}`
    }, {
      domain: "trade",
      kind: "money",
      resourceId: "money",
      name: "Выручка",
      qty: sale.revenueCopper,
      roomId: "treasury",
      sourceId: sale.channelId,
      source: sale.channelLabel,
      note: `${sale.name}: ${taken} по ${sale.unitPriceCopper} ММ; продавец ×${sale.sellerPriceFactor}`
    }]);
  }
  return { ok: true, applied, soldUnits: plan.soldUnits, revenueCopper: plan.revenueCopper };
}
