const MODES = new Set(["caravan", "rail", "airship"]);
const DIRECTIONS = new Set(["inbound", "outbound"]);
const AMOUNTS = ["distanceKm", "travelQd", "capacityLoad", "dispatchCopper", "distanceCopper", "loadCopperPerUnit", "operatingCopper", "hireCopper"];
const FACTORS = ["riskFactor", "priceFactor", "timeFactor", "capacityFactor"];
const BILLING_MONEY = ["freightCopper", "insuranceCopper", "taxCopper", "handlingCopper", "expressSurchargeCopper", "deliveryCopper"];
const SERVICES = new Set(["standard", "express", "charter"]);
const MAX_NUMBER = Number.MAX_SAFE_INTEGER;
const MAX_FACTOR = 1_000_000;
const MAX_LEGS = 20_000;

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, length = 1_000) => String(value ?? "").trim().slice(0, length);
const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
/** Exact integer allocation; equal remainders and all-zero weights follow leg order. */
export function allocateMarketTransportCharges(total, weights = []) {
  if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(weights)
    || weights.some((weight) => !Number.isFinite(Number(weight)) || Number(weight) < 0)) {
    throw new RangeError("Некорректное распределение стоимости перевозки.");
  }
  if (!weights.length) {
    if (total) throw new RangeError("Нельзя распределить стоимость перевозки без участков.");
    return [];
  }
  const parsed = weights.map(Number), sum = parsed.reduce((value, weight) => value + weight, 0);
  if (!Number.isFinite(sum)) throw new RangeError("Сумма весов стоимости перевозки слишком велика.");
  const exact = parsed.map((weight) => total * (sum > 0 ? weight / sum : 1 / parsed.length));
  const result = exact.map(Math.floor);
  const ranked = exact.map((value, index) => ({ index, remainder: value - result[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const remaining = total - result.reduce((value, amount) => value + amount, 0);
  if (remaining < 0 || remaining > ranked.length) throw new RangeError("Не удалось точно распределить стоимость перевозки.");
  for (let index = 0; index < remaining; index++) result[ranked[index].index] += 1;
  return result;
}
function number(value, fallback = 0, minimum = 0, maximum = MAX_NUMBER) {
  const parsed = value === undefined || value === null || value === "" ? fallback : Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function normalizeLeg(source) {
  if (!object(source)) return null;
  const leg = { ...clone(source), id: text(source.id), routeId: text(source.routeId),
    fromRegionId: text(source.fromRegionId), toRegionId: text(source.toRegionId),
    fromCountryId: text(source.fromCountryId), toCountryId: text(source.toCountryId),
    fromLabel: text(source.fromLabel, 2_000), toLabel: text(source.toLabel, 2_000),
    mode: text(source.mode), modeLabel: text(source.modeLabel, 2_000),
    carrierId: text(source.carrierId), carrierLabel: text(source.carrierLabel, 2_000),
    visibility: source.visibility === "gm" ? "gm" : "public",
    kind: source.kind === "last-mile" ? "last-mile" : "route", sharePct: number(source.sharePct, 0, 0, 100) };
  if (!leg.id || !leg.fromRegionId || !leg.toRegionId || !leg.carrierId || !MODES.has(leg.mode)) return null;
  for (const field of AMOUNTS) leg[field] = number(source[field]);
  for (const field of FACTORS) leg[field] = number(source[field], 1, 0.000001, MAX_FACTOR);
  if (Object.hasOwn(source, "chargedCopper")) leg.chargedCopper = Math.floor(number(source.chargedCopper));
  return leg;
}

/** Normalize only the saved snapshot. Never consult current routes, companies or rates. */
export function normalizeMarketTransportPlan(value) {
  if (!object(value)) return undefined;
  // A newer version belongs to its reader. Retain it without interpreting its financial promises.
  if (Number(value.version) !== 1) return clone(value);
  if (!DIRECTIONS.has(value.direction) || !text(value.key) || !Array.isArray(value.legs)
    || !value.legs.length || value.legs.length > MAX_LEGS) return undefined;
  const legs = value.legs.map(normalizeLeg);
  if (legs.some((leg) => !leg) || new Set(legs.map((leg) => leg.id)).size !== legs.length
    || legs.some((leg, index) => index > 0 && legs[index - 1].toRegionId !== leg.fromRegionId)) return undefined;
  const result = { ...clone(value), version: 1, key: text(value.key), direction: value.direction, legs };
  for (const field of AMOUNTS) result[field] = number(value[field]);
  result.riskFactor = number(value.riskFactor, 1, 0.000001, MAX_FACTOR);
  if (object(value.billing)) {
    result.billing = { ...clone(value.billing) };
    for (const field of BILLING_MONEY) if (Object.hasOwn(value.billing, field)) result.billing[field] = Math.floor(number(value.billing[field]));
    if (Object.hasOwn(value.billing, "batchCount")) result.billing.batchCount = Math.floor(number(value.billing.batchCount, 1, 1));
    if (Object.hasOwn(value.billing, "serviceLevel")) result.billing.serviceLevel = SERVICES.has(value.billing.serviceLevel) ? value.billing.serviceLevel : "standard";
  }
  return result;
}

function validNumericTerms(value, fields) {
  return fields.every((field) => {
    if (value[field] === undefined || value[field] === null) return true;
    const parsed = Number(value[field]);
    const factor = FACTORS.includes(field), maximum = field === "sharePct" ? 100 : factor ? MAX_FACTOR : MAX_NUMBER;
    return Number.isFinite(parsed) && parsed >= (factor ? 0.000001 : 0) && parsed <= maximum;
  });
}

/** Copy a new agreement before any debit/write; malformed new promises must not become legacy orders. */
export function marketTransportPlanSnapshot(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = normalizeMarketTransportPlan(value);
  if (Number(value?.version) !== 1 || !normalized || !validNumericTerms(value, [...AMOUNTS, "riskFactor"])
    || !value.legs.every((leg) => validNumericTerms(leg, [...AMOUNTS, ...FACTORS, "sharePct"])
      && (!Object.hasOwn(leg, "chargedCopper") || (Number.isSafeInteger(leg.chargedCopper) && leg.chargedCopper >= 0)))
    || (Object.hasOwn(value, "billing") && (!object(value.billing)
      || !BILLING_MONEY.every((field) => !Object.hasOwn(value.billing, field)
        || (Number.isSafeInteger(value.billing[field]) && value.billing[field] >= 0))
      || (Object.hasOwn(value.billing, "batchCount") && (!Number.isSafeInteger(value.billing.batchCount) || value.billing.batchCount < 1))
      || (Object.hasOwn(value.billing, "serviceLevel") && !SERVICES.has(value.billing.serviceLevel))))) {
    throw new RangeError("Некорректный сохранённый план перевозки. Пересчитайте заказ перед подтверждением.");
  }
  if (object(value.billing)) {
    const fields = BILLING_MONEY.filter((field) => field !== "deliveryCopper");
    if (fields.every((field) => Object.hasOwn(value.billing, field)) && Object.hasOwn(value.billing, "deliveryCopper")
      && fields.reduce((sum, field) => sum + value.billing[field], 0) !== value.billing.deliveryCopper) {
      throw new RangeError("Состав расходов перевозки не совпадает с оплатой заказа.");
    }
    if (value.legs.every((leg) => Object.hasOwn(leg, "chargedCopper")) && Object.hasOwn(value.billing, "freightCopper")
      && value.legs.reduce((sum, leg) => sum + leg.chargedCopper, 0) !== value.billing.freightCopper) {
      throw new RangeError("Стоимость участков не совпадает с фрахтом заказа.");
    }
  }
  return normalized;
}

/** Freeze the fee attribution of one order without copying the whole multi-batch bill into every order. */
export function marketTransportPlanForOrder(value, options = {}) {
  const snapshot = marketTransportPlanSnapshot(value);
  if (!snapshot) return undefined;
  const supplied = Object.hasOwn(options, "transportLegCosts") && options.transportLegCosts !== undefined;
  const alreadyBilled = object(snapshot.billing) || snapshot.legs.some((leg) => Object.hasOwn(leg, "chargedCopper"));
  if (!supplied && !alreadyBilled) return snapshot;
  let charges = supplied ? options.transportLegCosts : snapshot.legs.map((leg) => leg.chargedCopper ?? 0);
  if (!Array.isArray(charges) || charges.length !== snapshot.legs.length
    || charges.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new RangeError("Распределение стоимости не совпадает с участками перевозки.");
  }
  const freight = options.freightCopper ?? charges.reduce((sum, amount) => sum + amount, 0);
  if (charges.reduce((sum, amount) => sum + amount, 0) !== freight) {
    if (!options.allowReallocation) throw new RangeError("Стоимость участков не совпадает с фрахтом заказа.");
    charges = allocateMarketTransportCharges(freight, charges);
  }
  snapshot.legs = snapshot.legs.map((leg, index) => ({ ...leg, chargedCopper: charges[index] }));
  snapshot.billing = { batchCount: options.batchCount ?? 1, freightCopper: freight,
    insuranceCopper: options.insuranceCopper ?? 0, taxCopper: options.taxCopper ?? 0,
    handlingCopper: options.handlingCopper ?? 0, expressSurchargeCopper: options.expressSurchargeCopper ?? 0,
    serviceLevel: options.serviceLevel ?? "standard" };
  const delivery = BILLING_MONEY.filter((field) => field !== "deliveryCopper").reduce((sum, field) => sum + snapshot.billing[field], 0);
  snapshot.billing.deliveryCopper = options.deliveryCopper ?? delivery;
  if (delivery !== snapshot.billing.deliveryCopper) throw new RangeError("Состав расходов перевозки не совпадает с оплатой заказа.");
  return marketTransportPlanSnapshot(snapshot);
}

/** Loading retains unknown/malformed metadata for recovery and never invents a plan for an old order. */
export function savedMarketTransportPlanFields(order = {}) {
  return Object.hasOwn(order, "transportPlan")
    ? { transportPlan: normalizeMarketTransportPlan(order.transportPlan) ?? clone(order.transportPlan) }
    : {};
}
