const MAX_MARKETS = 256;
const MAX_OFFERS = 8_192;
const MAX_ROUTES = 4_096;
const MAX_TRADE_EDGES = 16_384;
const MAX_EDGE_CANDIDATES = 100_000;
const MAX_CYCLES = 32;
const EPSILON = 1e-10;

const ERROR = "error";
const SEVERITY_ORDER = new Map([[ERROR, 0], ["warning", 1], ["info", 2]]);

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function booleanFalse(value) {
  return value === false || String(value ?? "").trim().toLowerCase() === "false";
}

function collectionSize(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function rowEntries(value, path, maximum = Infinity) {
  if (Array.isArray(value)) {
    const result = [];
    const length = Math.min(value.length, maximum);
    for (let index = 0; index < length; index += 1) result.push({ row: value[index], path: `${path}[${index}]` });
    return result;
  }
  if (!value || typeof value !== "object") return [];
  return Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximum)
    .map((key) => ({
      row: value[key],
      path: `${path}[${JSON.stringify(key)}]`,
      fallbackId: key
    }));
}

function atPath(source, segments) {
  let value = source;
  for (const segment of segments) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function field(source, basePath, candidates) {
  for (const segments of candidates) {
    const value = atPath(source, segments);
    if (!hasValue(value)) continue;
    return { present: true, value, path: `${basePath}.${segments.join(".")}` };
  }
  return { present: false, value: null, path: basePath };
}

function addIssue(issues, severity, code, path, message) {
  issues.push({ severity, code, path: String(path ?? ""), message: String(message ?? "") });
}

function boundedEntries(value, path, maximum, issues) {
  const size = collectionSize(value);
  if (size > maximum) {
    addIssue(issues, ERROR, "integrity-input-limit", path, `Integrity input contains ${size} rows; only the deterministic limit of ${maximum} can be checked.`);
  }
  return rowEntries(value, path, maximum);
}

function integerValue(raw, kind, issues) {
  if (!raw.present) return { present: false, valid: false, value: null, path: raw.path };
  const value = Number(raw.value);
  if (!Number.isFinite(value)) {
    addIssue(issues, ERROR, `invalid-${kind}`, raw.path, `${kind} must be a finite whole number.`);
    return { present: true, valid: false, value: null, path: raw.path };
  }
  if (value < 0) {
    addIssue(issues, ERROR, `negative-${kind}`, raw.path, `${kind} cannot be negative.`);
    return { present: true, valid: false, value, path: raw.path };
  }
  if (!Number.isInteger(value)) {
    addIssue(issues, ERROR, `non-integer-${kind}`, raw.path, `${kind} must be expressed as a whole number.`);
    return { present: true, valid: false, value, path: raw.path };
  }
  return { present: true, valid: true, value, path: raw.path };
}

function instrumentId(row) {
  const explicit = String(row?.instrumentId ?? row?.commodityId ?? "").trim();
  if (explicit) return explicit;
  const itemUuid = String(row?.itemUuid ?? row?.uuid ?? row?.itemId ?? "").trim();
  if (itemUuid) return `item:${itemUuid}`;
  const resourceId = String(row?.resourceId ?? row?.resource ?? "").trim();
  if (resourceId && resourceId !== "custom") return resourceId;
  const customName = String(row?.name ?? row?.label ?? row?.id ?? "").trim().toLocaleLowerCase();
  return resourceId === "custom" && customName ? `custom:${customName}` : "";
}

function manualPricingDeclaration(row, basePath) {
  const pricingMode = String(row?.pricingMode ?? row?.priceMode ?? "").trim().toLowerCase();
  const declared = pricingMode === "manual" || row?.manualPricing === true;
  const path = pricingMode === "manual" ? `${basePath}.pricingMode` : `${basePath}.manualPricing`;
  const sourceType = String(row?.sourceType ?? "").trim().toLowerCase();
  const resourceId = String(row?.resourceId ?? row?.resource ?? "").trim().toLowerCase();
  const itemBound = sourceType === "item" || Boolean(String(row?.itemUuid ?? row?.uuid ?? row?.itemId ?? "").trim());
  return { declared, eligible: declared && (itemBound || resourceId === "custom"), path };
}

function priceFields(row, basePath, forcedSide = "") {
  const genericPrice = [["unitPriceCopper"], ["priceCopper"], ["price"], ["basePriceCopper"]];
  const askCandidates = [
    ["askUnitCopper"], ["askCopper"], ["askPriceCopper"], ["sellPriceCopper"],
    ["ask", "unitPriceCopper"], ["ask", "priceCopper"], ["ask", "price"]
  ];
  const bidCandidates = [
    ["bidUnitCopper"], ["bidCopper"], ["bidPriceCopper"], ["buyPriceCopper"],
    ["bid", "unitPriceCopper"], ["bid", "priceCopper"], ["bid", "price"]
  ];
  if (forcedSide === "ask") askCandidates.push(...genericPrice);
  else if (forcedSide === "bid") bidCandidates.push(...genericPrice);
  else askCandidates.push(...genericPrice);
  return {
    ask: field(row, basePath, askCandidates),
    bid: field(row, basePath, bidCandidates)
  };
}

function quantityFields(row, basePath, forcedSide = "") {
  const stockCandidates = [
    ["askStock"], ["stock"], ["baseStock"],
    ["ask", "stock"], ["ask", "quantity"]
  ];
  const demandCandidates = [
    ["bidDemand"], ["demand"],
    ["bid", "demand"], ["bid", "quantity"]
  ];
  if (forcedSide === "ask") stockCandidates.push(["quantity"]);
  else if (forcedSide === "bid") demandCandidates.push(["quantity"]);
  return {
    stock: field(row, basePath, stockCandidates),
    demand: field(row, basePath, demandCandidates)
  };
}

function compareOfferPath(left, right) {
  return left.path.localeCompare(right.path);
}

function marketIdFor(row, fallback = "") {
  return String(row?.marketId ?? row?.id ?? fallback ?? "").trim();
}

function looksLikeOffer(row) {
  if (!row || typeof row !== "object") return false;
  return [
    "marketId", "instrumentId", "commodityId", "resourceId", "resource", "itemUuid", "itemId",
    "askCopper", "askPriceCopper", "bidCopper", "bidPriceCopper", "unitPriceCopper", "priceCopper",
    "basePriceCopper", "stock", "baseStock", "demand", "side", "pricingMode", "manualPricing"
  ].some((key) => Object.hasOwn(row, key)) || Boolean(row.ask && typeof row.ask === "object") || Boolean(row.bid && typeof row.bid === "object");
}

function collectOffer({ row, path, marketId, forcedSide = "", issues, records, state }) {
  if (!row || typeof row !== "object" || row.active === false) return;
  if (state.offerCount >= MAX_OFFERS) {
    if (!state.offerLimitReported) {
      addIssue(issues, ERROR, "integrity-input-limit", "quotes", `Integrity input exceeds the deterministic limit of ${MAX_OFFERS} active offers.`);
      state.offerLimitReported = true;
    }
    return;
  }
  state.offerCount += 1;

  const resolvedMarketId = String(row.marketId ?? marketId ?? "").trim();
  const instrument = instrumentId(row);
  const manual = manualPricingDeclaration(row, path);
  const side = String(forcedSide || row.side || "").trim().toLowerCase();
  const normalizedSide = side === "bid" || side === "buy" ? "bid" : (side === "ask" || side === "sell" ? "ask" : "");
  const prices = priceFields(row, path, normalizedSide);
  const quantities = quantityFields(row, path, normalizedSide);
  const issueCountBeforeNumbers = issues.length;
  const ask = integerValue(prices.ask, "price", issues);
  const bid = integerValue(prices.bid, "price", issues);
  const stock = integerValue(quantities.stock, "stock", issues);
  const demand = integerValue(quantities.demand, "demand", issues);
  const invalidNumber = issues.length > issueCountBeforeNumbers;

  if (manual.declared && !manual.eligible) {
    addIssue(issues, ERROR, "manual-pricing-not-eligible", manual.path, "Manual pricing is allowed only for an explicitly bound item or a custom resource offer.");
  }
  if (manual.eligible) return;

  if (!resolvedMarketId) {
    addIssue(issues, ERROR, "non-tradable-offer", path, "An automatic offer has no market id and cannot be traded.");
    return;
  }
  if (!instrument) {
    addIssue(issues, ERROR, "non-tradable-offer", path, "An automatic offer has no stable resource, item, or instrument identity.");
    return;
  }
  if (booleanFalse(row.tradable)) {
    addIssue(issues, ERROR, "non-tradable-offer", `${path}.tradable`, `Active automatic offer ${instrument} is explicitly non-tradable.`);
    return;
  }
  if (invalidNumber) return;
  const pricedAsk = ask.valid && ask.value > 0;
  const pricedBid = bid.valid && bid.value > 0;
  if (!pricedAsk && !pricedBid) {
    addIssue(issues, ERROR, "non-tradable-offer", path, `Automatic offer ${instrument} has neither a positive ask nor a positive bid.`);
    return;
  }

  records.push({
    marketId: resolvedMarketId,
    instrument,
    path,
    ask: pricedAsk ? ask.value : null,
    bid: pricedBid ? bid.value : null,
    stock: stock.present && stock.valid ? stock.value : null,
    demand: demand.present && demand.valid ? demand.value : null,
    finiteStock: stock.present && stock.valid,
    finiteDemand: demand.present && demand.valid,
    askAvailable: pricedAsk && (!stock.present || stock.value > 0),
    bidAvailable: pricedBid && (!demand.present || demand.value > 0)
  });
}

function collectOfferContainer({ container, path, marketId, issues, records, state }) {
  if (!container || typeof container !== "object" || container.active === false) return;
  const groups = [
    ["offers", ""],
    ["quotes", ""],
    ["asks", "ask"],
    ["bids", "bid"]
  ];
  let nested = false;
  for (const [key, side] of groups) {
    if (!Array.isArray(container[key]) && (!container[key] || typeof container[key] !== "object")) continue;
    nested = true;
    const remaining = Math.max(0, MAX_OFFERS - state.offerCount);
    if (collectionSize(container[key]) > remaining && !state.offerLimitReported) {
      addIssue(issues, ERROR, "integrity-input-limit", `${path}.${key}`, `Integrity input exceeds the deterministic limit of ${MAX_OFFERS} active offers.`);
      state.offerLimitReported = true;
    }
    for (const entry of rowEntries(container[key], `${path}.${key}`, remaining)) {
      collectOffer({ row: entry.row, path: entry.path, marketId, forcedSide: side, issues, records, state });
    }
  }
  if (!nested && looksLikeOffer(container)) collectOffer({ row: container, path, marketId, issues, records, state });
}

function collectRecords(markets, quotes, issues) {
  const records = [];
  const state = { offerCount: 0, offerLimitReported: false };
  const marketEntries = boundedEntries(markets, "markets", MAX_MARKETS, issues);
  for (const entry of marketEntries) {
    const row = entry.row;
    if (!row || typeof row !== "object" || row.active === false) continue;
    const marketId = marketIdFor(row, entry.fallbackId);
    collectOfferContainer({ container: row, path: entry.path, marketId, issues, records, state });
  }
  const quoteEntries = boundedEntries(quotes, "quotes", MAX_OFFERS, issues);
  for (const entry of quoteEntries) {
    const row = entry.row;
    if (!row || typeof row !== "object" || row.active === false) continue;
    collectOfferContainer({ container: row, path: entry.path, marketId: String(row.marketId ?? entry.fallbackId ?? "").trim(), issues, records, state });
  }
  return records.sort((left, right) => left.marketId.localeCompare(right.marketId)
    || left.instrument.localeCompare(right.instrument)
    || compareOfferPath(left, right));
}

function bestQuotes(records) {
  const books = new Map();
  for (const record of records) {
    if (!books.has(record.marketId)) books.set(record.marketId, { asks: new Map(), bids: new Map() });
    const book = books.get(record.marketId);
    if (record.askAvailable) {
      const current = book.asks.get(record.instrument);
      if (!current || record.ask < current.ask || (record.ask === current.ask && record.path.localeCompare(current.path) < 0)) {
        book.asks.set(record.instrument, record);
      }
    }
    if (record.bidAvailable) {
      const current = book.bids.get(record.instrument);
      if (!current || record.bid > current.bid || (record.bid === current.bid && record.path.localeCompare(current.path) < 0)) {
        book.bids.set(record.instrument, record);
      }
    }
  }
  return books;
}

function sameMarketSpreadIssues(books, issues) {
  for (const marketId of [...books.keys()].sort((left, right) => left.localeCompare(right))) {
    const book = books.get(marketId);
    const instruments = [...book.asks.keys()].filter((id) => book.bids.has(id)).sort((left, right) => left.localeCompare(right));
    for (const instrument of instruments) {
      const ask = book.asks.get(instrument);
      const bid = book.bids.get(instrument);
      if (bid.bid < ask.ask) continue;
      addIssue(
        issues,
        ERROR,
        "same-market-crossed-quote",
        bid.path,
        `Market ${marketId} bids ${bid.bid} C for ${instrument} while its executable ask is ${ask.ask} C at ${ask.path}.`
      );
    }
  }
}

function routeEndpoint(row, side) {
  const candidates = side === "from"
    ? ["fromMarketId", "sourceMarketId", "originMarketId", "from", "source", "origin"]
    : ["toMarketId", "targetMarketId", "destinationMarketId", "to", "target", "destination"];
  for (const key of candidates) {
    const value = String(row?.[key] ?? "").trim();
    if (value) return value;
  }
  return "";
}

function finiteRouteNumber(row, basePath, candidates, issues, { integer = false, maximum = Infinity } = {}) {
  const raw = field(row, basePath, candidates.map((candidate) => [candidate]));
  if (!raw.present) return { present: false, valid: true, value: 0, path: raw.path };
  const value = Number(raw.value);
  if (!Number.isFinite(value) || value < 0 || value > maximum || (integer && !Number.isInteger(value))) {
    addIssue(issues, ERROR, "invalid-route-cost", raw.path, "Route freight and tax inputs must be finite non-negative values in their declared units.");
    return { present: true, valid: false, value: 0, path: raw.path };
  }
  return { present: true, valid: true, value, path: raw.path };
}

function routeEconomics(row, path, issues) {
  const complete = finiteRouteNumber(row, path, ["allInCostCopperPerUnit", "fullCostCopperPerUnit", "deliveryCopperPerUnit", "deliveryCopper"], issues, { integer: true });
  let fixedCopper = 0;
  let valid = complete.valid;
  if (complete.present) {
    fixedCopper = complete.value;
  } else {
    const componentGroups = [
      ["freightCopperPerUnit", "freightCopper", "operationalFreightCopperPerUnit", "routeCopperPerUnit", "routeCopper", "costCopperPerUnit", "costCopper"],
      ["taxCopperPerUnit", "taxCopper"],
      ["handlingCopperPerUnit", "handlingCopper"],
      ["insuranceCopperPerUnit", "insuranceCopper"],
      ["surchargeCopperPerUnit", "surchargeCopper", "expressSurchargeCopperPerUnit", "expressSurchargeCopper"],
      ["customsCopperPerUnit", "customsCopper"],
      ["otherCopperPerUnit", "otherCopper"]
    ];
    for (const group of componentGroups) {
      const component = finiteRouteNumber(row, path, group, issues, { integer: true });
      valid = valid && component.valid;
      fixedCopper += component.value;
    }
  }

  const aggregateTax = finiteRouteNumber(row, path, ["purchaseTaxRate", "taxRate"], issues, { maximum: 100 });
  let purchaseTaxRate = aggregateTax.value;
  valid = valid && aggregateTax.valid;
  if (!aggregateTax.present) {
    const importTax = finiteRouteNumber(row, path, ["importTaxRate"], issues, { maximum: 100 });
    const exportTax = finiteRouteNumber(row, path, ["exportTaxRate"], issues, { maximum: 100 });
    purchaseTaxRate = importTax.value + exportTax.value;
    valid = valid && importTax.valid && exportTax.valid;
  }
  const salesTax = finiteRouteNumber(row, path, ["salesTaxRate", "destinationTaxRate"], issues, { maximum: 100 });
  valid = valid && salesTax.valid;
  return { valid, fixedCopper, purchaseTaxRate, salesTaxRate: salesTax.value };
}

function routeRestrictions(row) {
  const raw = row?.instrumentIds ?? row?.resourceIds ?? row?.commodities ?? [];
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,;|\n]/);
  const result = new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean));
  const single = String(row?.instrumentId ?? row?.resourceId ?? "").trim();
  if (single) result.add(single);
  return result;
}

function normalizeRoutes(routes, issues) {
  const result = [];
  for (const entry of boundedEntries(routes, "routes", MAX_ROUTES, issues)) {
    const row = entry.row;
    if (!row || typeof row !== "object" || row.active === false) continue;
    let from = routeEndpoint(row, "from");
    let to = routeEndpoint(row, "to");
    if (!from || !to || from === to) continue;
    const direction = String(row.direction ?? "").trim().toLowerCase();
    if (direction === "reverse") [from, to] = [to, from];
    const forwardEconomics = routeEconomics(row, entry.path, issues);
    if (forwardEconomics.valid) result.push({ from, to, path: entry.path, economics: forwardEconomics, restrictions: routeRestrictions(row) });

    const oneWay = row.oneWay === true || row.bidirectional === false || ["forward", "one-way", "oneway", "reverse"].includes(direction);
    if (oneWay) continue;
    const reverseSource = row.reverseCosts && typeof row.reverseCosts === "object"
      ? { ...row, ...row.reverseCosts }
      : row;
    const reversePath = row.reverseCosts && typeof row.reverseCosts === "object" ? `${entry.path}.reverseCosts` : `${entry.path}#reverse`;
    const reverseEconomics = routeEconomics(reverseSource, reversePath, issues);
    if (reverseEconomics.valid) result.push({ from: to, to: from, path: reversePath, economics: reverseEconomics, restrictions: routeRestrictions(row) });
  }
  return result.sort((left, right) => left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to)
    || left.path.localeCompare(right.path));
}

function tradeEdges(books, routes, issues) {
  const edges = [];
  let candidates = 0;
  let stopped = false;
  for (const route of routes) {
    const sourceBook = books.get(route.from);
    const targetBook = books.get(route.to);
    if (!sourceBook || !targetBook) continue;
    const instruments = [...sourceBook.asks.keys()].filter((instrument) => targetBook.bids.has(instrument));
    instruments.sort((left, right) => left.localeCompare(right));
    for (const instrument of instruments) {
      candidates += 1;
      if (candidates > MAX_EDGE_CANDIDATES || edges.length >= MAX_TRADE_EDGES) {
        stopped = true;
        break;
      }
      if (route.restrictions.size && !route.restrictions.has(instrument)) continue;
      const ask = sourceBook.asks.get(instrument);
      const bid = targetBook.bids.get(instrument);
      const fullCost = ask.ask * (1 + route.economics.purchaseTaxRate) + route.economics.fixedCopper;
      const proceeds = bid.bid * Math.max(0, 1 - route.economics.salesTaxRate);
      if (!(fullCost > 0) || !(proceeds > 0)) continue;
      const multiplier = proceeds / fullCost;
      const edge = {
        from: route.from,
        to: route.to,
        instrument,
        path: route.path,
        askPath: ask.path,
        bidPath: bid.path,
        askCopper: ask.ask,
        bidCopper: bid.bid,
        fullCost,
        proceeds,
        multiplier,
        logGain: Math.log(multiplier)
      };
      edges.push(edge);
      if (multiplier > 1 + EPSILON && (!ask.finiteStock || !bid.finiteDemand)) {
        const missing = [!ask.finiteStock ? "source stock" : "", !bid.finiteDemand ? "destination demand" : ""].filter(Boolean).join(" and ");
        addIssue(
          issues,
          ERROR,
          "unbounded-profitable-trade-edge",
          route.path,
          `${route.from} -> ${route.to} is profitable for ${instrument} after freight and tax (${proceeds.toFixed(2)} C proceeds versus ${fullCost.toFixed(2)} C all-in cost) but has no finite ${missing}.`
        );
      }
    }
    if (stopped) break;
  }
  if (stopped) {
    addIssue(issues, ERROR, "integrity-input-limit", "routes", `Trade graph exceeds the deterministic limit of ${MAX_TRADE_EDGES} edges or ${MAX_EDGE_CANDIDATES} route/offer candidates.`);
  }
  return edges.sort((left, right) => left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to)
    || left.instrument.localeCompare(right.instrument)
    || left.path.localeCompare(right.path));
}

function weakComponents(edges) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from).add(edge.to);
    adjacency.get(edge.to).add(edge.from);
  }
  const unseen = new Set([...adjacency.keys()].sort((left, right) => left.localeCompare(right)));
  const components = [];
  while (unseen.size) {
    const first = [...unseen][0];
    const queue = [first];
    const component = [];
    unseen.delete(first);
    while (queue.length) {
      const current = queue.shift();
      component.push(current);
      for (const neighbor of [...(adjacency.get(current) ?? [])].sort((left, right) => left.localeCompare(right))) {
        if (!unseen.has(neighbor)) continue;
        unseen.delete(neighbor);
        queue.push(neighbor);
      }
    }
    components.push(component.sort((left, right) => left.localeCompare(right)));
  }
  return components;
}

function canonicalCycle(edges) {
  if (!edges.length) return [];
  const rotations = edges.map((_, index) => [...edges.slice(index), ...edges.slice(0, index)]);
  rotations.sort((left, right) => {
    const leftKey = left.map((edge) => `${edge.from}>${edge.to}:${edge.instrument}:${edge.path}`).join("|");
    const rightKey = right.map((edge) => `${edge.from}>${edge.to}:${edge.instrument}:${edge.path}`).join("|");
    return leftKey.localeCompare(rightKey);
  });
  return rotations[0];
}

function positiveCycle(vertices, edges) {
  if (vertices.length < 2 || edges.length < 2) return null;
  const scores = new Map(vertices.map((vertex) => [vertex, 0]));
  const predecessor = new Map();
  let updated = "";
  for (let pass = 0; pass < vertices.length; pass += 1) {
    updated = "";
    for (const edge of edges) {
      const candidate = scores.get(edge.from) + edge.logGain;
      if (candidate <= scores.get(edge.to) + EPSILON) continue;
      scores.set(edge.to, candidate);
      predecessor.set(edge.to, edge);
      updated = edge.to;
    }
    if (!updated) return null;
  }
  let cursor = updated;
  for (let index = 0; index < vertices.length; index += 1) {
    const edge = predecessor.get(cursor);
    if (!edge) return null;
    cursor = edge.from;
  }
  const start = cursor;
  const reverse = [];
  do {
    const edge = predecessor.get(cursor);
    if (!edge || reverse.length > vertices.length) return null;
    reverse.push(edge);
    cursor = edge.from;
  } while (cursor !== start);
  const cycle = canonicalCycle(reverse.reverse());
  const logGain = cycle.reduce((sum, edge) => sum + edge.logGain, 0);
  return logGain > EPSILON ? { edges: cycle, logGain } : null;
}

function arbitrageCycleIssues(edges, issues) {
  let count = 0;
  for (const vertices of weakComponents(edges)) {
    if (count >= MAX_CYCLES) break;
    const vertexSet = new Set(vertices);
    const componentEdges = edges.filter((edge) => vertexSet.has(edge.from) && vertexSet.has(edge.to));
    const cycle = positiveCycle(vertices, componentEdges);
    if (!cycle) continue;
    const multiplier = Math.exp(cycle.logGain);
    const routeText = cycle.edges.map((edge) => `${edge.from} --${edge.instrument}--> ${edge.to}`).join("; ");
    addIssue(
      issues,
      ERROR,
      "profitable-arbitrage-cycle",
      cycle.edges.map((edge) => edge.path).join(" -> "),
      `A repeatable market cycle remains profitable after full freight and tax: ${routeText} (multiplier ${Number.isFinite(multiplier) ? multiplier.toFixed(6) : ">1e308"}).`
    );
    count += 1;
  }
}

function sortedUniqueIssues(issues) {
  const unique = new Map();
  for (const issue of issues) {
    const key = `${issue.severity}\u001f${issue.code}\u001f${issue.path}\u001f${issue.message}`;
    if (!unique.has(key)) unique.set(key, issue);
  }
  return [...unique.values()].sort((left, right) => (SEVERITY_ORDER.get(left.severity) ?? 99) - (SEVERITY_ORDER.get(right.severity) ?? 99)
    || left.code.localeCompare(right.code)
    || left.path.localeCompare(right.path)
    || left.message.localeCompare(right.message));
}

/**
 * Validate automatic bilateral market quotes as a bounded, deterministic graph.
 *
 * Current one-sided market offers (`basePriceCopper`/`baseStock`) are accepted as
 * asks. Future rows may expose `askCopper`/`stock` and `bidCopper`/`demand`, or
 * separate `asks` and `bids` arrays. Route copper fields are interpreted per one
 * quoted unit; `allInCostCopperPerUnit` or `deliveryCopperPerUnit` overrides the
 * component sum. Routes are bidirectional by default unless explicitly one-way.
 * Explicit manual pricing is exempt only for `sourceType: "item"` or
 * `resourceId: "custom"`; any numeric values it does declare are still checked.
 */
export function analyzeMarketIntegrity({ markets = [], quotes = [], routes = [] } = {}) {
  const issues = [];
  const records = collectRecords(markets, quotes, issues);
  const books = bestQuotes(records);
  sameMarketSpreadIssues(books, issues);
  const normalizedRoutes = normalizeRoutes(routes, issues);
  const edges = tradeEdges(books, normalizedRoutes, issues);
  arbitrageCycleIssues(edges, issues);
  const sortedIssues = sortedUniqueIssues(issues);
  return {
    ready: !sortedIssues.some((issue) => issue.severity === ERROR),
    issues: sortedIssues
  };
}
