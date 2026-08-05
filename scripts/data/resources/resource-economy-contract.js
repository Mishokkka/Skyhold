import { formatForbiddenLandsCost, parseCopperCurrency } from "../../core/currency.js";

export const RESOURCE_ECONOMY_VERSION = 2;
export const CARGO_POINT_CLASSES = Object.freeze([1, 2, 5, 10, 20, 40]);
export const RESOURCE_TENDAY_DAYS = 10;

const CARGO_CLASS_IDS = new Set(["none", "1", "2", "5", "10", "20", "40", "livestock", "oversized"]);

function own(source, key) {
  return Boolean(source && typeof source === "object" && Object.hasOwn(source, key));
}

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Number.isFinite(parsed) ? parsed : fallback);
}

function wholeNonNegative(value, fallback = 0) {
  return Math.max(0, Math.round(finiteNonNegative(value, fallback)));
}

function wholeCargoPoints(value, fallback = 0) {
  return Math.max(0, Math.ceil(finiteNonNegative(value, fallback) - Number.EPSILON));
}

function legacyLoadValue(value, fallback = 0) {
  const text = String(value ?? "").trim().toLowerCase().replace(",", ".");
  if (!text) return finiteNonNegative(fallback, 0);
  if (["tiny", "negligible", "невесомый", "ничтожный"].includes(text)) return 0;
  if (["light", "легкий", "лёгкий"].includes(text)) return 0.5;
  if (["normal", "обычный"].includes(text)) return 1;
  if (["heavy", "тяжелый", "тяжёлый"].includes(text)) return 2;
  return finiteNonNegative(text, fallback);
}

function resourceLooksLikeLivestock(source = {}) {
  if (String(source.cargoClass ?? "").trim().toLowerCase() === "livestock") return true;
  const category = String(source.category ?? "").trim().toLowerCase();
  if (category === "животные" || category === "livestock") return true;
  const tags = Array.isArray(source.marketTags) ? source.marketTags : String(source.marketTags ?? "").split(/[,;\n]/);
  return tags.some((tag) => String(tag ?? "").trim().toLowerCase() === "livestock");
}

export function cargoClassPoints(value = 10) {
  const points = Math.max(1, wholeNonNegative(value, 10));
  return CARGO_POINT_CLASSES.find((candidate) => points <= candidate) ?? points;
}

export function legacyLoadFromCargoPoints(value = 0) {
  return wholeNonNegative(value, 0) / 10;
}

export function cargoPointsFromLegacy(source = {}, { isMoney = false } = {}) {
  if (isMoney) return 0;
  if (own(source, "cargoPoints") && source.cargoPoints !== "") {
    return Math.max(1, wholeCargoPoints(source.cargoPoints, 1));
  }
  const explicitLoad = source.load ?? source.weight;
  if (explicitLoad !== undefined && explicitLoad !== null && explicitLoad !== "") {
    return Math.max(1, wholeCargoPoints(legacyLoadValue(explicitLoad, 0) * 10, 1));
  }
  const hasPhysicalMetadata = own(source, "packageMassKg")
    || own(source, "massKg")
    || own(source, "packageVolumeL")
    || own(source, "volumeL");
  if (!hasPhysicalMetadata) return 10;
  const massKg = finiteNonNegative(source.packageMassKg ?? source.massKg, 0);
  const volumeL = finiteNonNegative(source.packageVolumeL ?? source.volumeL, 0);
  if (!(massKg > 0) && !(volumeL > 0)) return 10;
  const derivedLoad = Math.max(massKg / 10, volumeL / 20);
  return Math.max(1, wholeCargoPoints(derivedLoad * 10, 10));
}

export function cargoProfile(source = {}, { isMoney = false } = {}) {
  if (isMoney) return { cargoClass: "none", cargoPoints: 0 };
  const requestedClass = String(source.cargoClass ?? "").trim().toLowerCase();
  const rawPoints = cargoPointsFromLegacy(source, { isMoney: false });
  const livestock = requestedClass === "livestock" || (!requestedClass && resourceLooksLikeLivestock(source));
  if (livestock) return { cargoClass: "livestock", cargoPoints: rawPoints };
  if (requestedClass === "oversized" || rawPoints > CARGO_POINT_CLASSES.at(-1)) {
    return { cargoClass: "oversized", cargoPoints: Math.max(CARGO_POINT_CLASSES.at(-1) + 1, rawPoints) };
  }
  if (CARGO_CLASS_IDS.has(requestedClass) && /^\d+$/.test(requestedClass)) {
    const cargoPoints = Number(requestedClass);
    return { cargoClass: requestedClass, cargoPoints };
  }
  const cargoPoints = cargoClassPoints(rawPoints);
  return { cargoClass: String(cargoPoints), cargoPoints };
}

export function resourceTradeReady(resource = {}) {
  return resource?.isMoney !== true
    && resource?.tradable === true
    && wholeNonNegative(resource?.referencePriceCopper, 0) > 0;
}

function legacyLooksEdible(resource = {}) {
  const tags = [
    ...(Array.isArray(resource.nutritionTags) ? resource.nutritionTags : []),
    ...(Array.isArray(resource.materialGroups) ? resource.materialGroups : []),
    ...(Array.isArray(resource.marketTags) ? resource.marketTags : [])
  ].map((tag) => String(tag ?? "").trim().toLowerCase());
  if (tags.some((tag) => ["edible", "food", "food.raw", "food.processed"].includes(tag))) return true;
  const text = `${resource.resourceId ?? resource.id ?? ""} ${resource.name ?? resource.label ?? ""}`;
  return /(bread|food|ration|meal|grain|flour|meat|milk|honey|fruit|vegetable|egg|хлеб|пищ|еда|паек|паёк|зерн|мук|мяс|молок|мед|мёд|фрукт|овощ|яйц)/i.test(text);
}

/** The authoritative ration value used by consumption, reserve and spoilage. */
export function effectiveRationPointsPerUnit(resource = {}, definition = null) {
  if (definition && own(definition, "rationPoints")) return wholeNonNegative(definition.rationPoints, 0);
  if (own(resource, "rationPoints")) return wholeNonNegative(resource.rationPoints, 0);
  if (definition && own(definition, "foodValue")) return finiteNonNegative(definition.foodValue, 0);
  if (own(resource, "foodValue")) return finiteNonNegative(resource.foodValue, 0);
  return legacyLooksEdible({ ...(definition ?? {}), ...resource }) ? 1 : 0;
}

export function normalizeResourceEconomy(source = {}, { isMoney = false } = {}) {
  const sourceEconomyVersion = Math.max(1, wholeNonNegative(source.economyVersion, 1));
  const legacyEconomy = source.legacyEconomy === true || sourceEconomyVersion < RESOURCE_ECONOMY_VERSION;
  const economyVersion = Math.max(RESOURCE_ECONOMY_VERSION, sourceEconomyVersion);
  const legacyPrice = parseCopperCurrency(source.cost ?? source.legacyCost ?? "");
  const referencePriceCopper = own(source, "referencePriceCopper") && source.referencePriceCopper !== ""
    ? wholeNonNegative(source.referencePriceCopper, 0)
    : legacyPrice;
  const requestedTradable = isMoney
    ? false
    : (own(source, "tradable") ? source.tradable === true : referencePriceCopper > 0);
  const tradeConfigurationError = requestedTradable && referencePriceCopper <= 0
    ? "Ресурс помечен как торговый, но справочная цена не задана."
    : "";
  const tradeDisabledReason = String(source.tradeDisabledReason ?? source.nonTradableReason ?? "").trim()
    || (!requestedTradable && !isMoney ? "Торговля этим ресурсом отключена в каталоге." : "");
  const profile = cargoProfile(source, { isMoney });
  const manualLoad = String(source.loadMode ?? "").trim().toLowerCase() === "manual";
  const legacyLoad = manualLoad && own(source, "load")
    ? legacyLoadValue(source.load, legacyLoadFromCargoPoints(profile.cargoPoints))
    : (own(source, "legacyLoad")
      ? legacyLoadValue(source.legacyLoad, legacyLoadFromCargoPoints(profile.cargoPoints))
      : legacyLoadValue(source.load ?? source.weight, legacyLoadFromCargoPoints(profile.cargoPoints)));
  const configuredRations = own(source, "rationPoints") ? source.rationPoints : (source.foodValue ?? source.personDaysPerUnit);
  const rationPoints = wholeNonNegative(configuredRations, 0);
  const legacyShelfLifeDays = own(source, "legacyShelfLifeDays")
    ? wholeNonNegative(source.legacyShelfLifeDays, 0)
    : wholeNonNegative(source.shelfLifeDays, 0);
  const hasTendayShelfLife = own(source, "shelfLifeTendays") && source.shelfLifeTendays !== "";
  const shelfLifeMode = String(source.shelfLifeMode ?? "").trim().toLowerCase() === "legacy-days" || !hasTendayShelfLife
    ? "legacy-days"
    : "tendays";
  const shelfLifeTendays = hasTendayShelfLife
    ? wholeNonNegative(source.shelfLifeTendays, 0)
    : (legacyShelfLifeDays > 0 ? Math.ceil(legacyShelfLifeDays / RESOURCE_TENDAY_DAYS) : 0);

  return {
    economyVersion,
    legacyEconomy,
    legacyEconomyVersion: legacyEconomy ? Math.min(sourceEconomyVersion, RESOURCE_ECONOMY_VERSION - 1) : 0,
    referencePriceCopper,
    tradable: requestedTradable,
    tradeReady: requestedTradable && referencePriceCopper > 0 && !isMoney,
    tradeConfigurationError,
    tradeDisabledReason,
    ...profile,
    legacyLoad,
    loadMode: manualLoad ? "manual" : "auto",
    // Compatibility aliases deliberately preserve the legacy runtime until a
    // consumer is moved to the explicit V2 field. They are not canonical.
    load: legacyLoad,
    rationPoints,
    foodValue: own(source, "foodValue") ? finiteNonNegative(source.foodValue, rationPoints) : rationPoints,
    legacyShelfLifeDays,
    shelfLifeMode,
    shelfLifeTendays,
    shelfLifeDays: legacyShelfLifeDays || (shelfLifeMode === "tendays" ? shelfLifeTendays * RESOURCE_TENDAY_DAYS : 0),
    legacyCost: String(source.legacyCost ?? source.cost ?? "").trim(),
    cost: legacyEconomy
      ? (String(source.cost ?? "").trim() || formatForbiddenLandsCost(referencePriceCopper))
      : formatForbiddenLandsCost(referencePriceCopper)
  };
}

export function resourceEconomyIssues(resource = {}) {
  const issues = [];
  const id = String(resource.id ?? resource.resourceId ?? "resource");
  const isMoney = id === "money" || resource.isMoney === true;
  if (wholeNonNegative(resource.economyVersion, 0) < RESOURCE_ECONOMY_VERSION || resource.legacyEconomy === true) {
    issues.push({ code: "economy-version", id, message: "Ресурс работает через legacy-адаптер и ещё не подтверждён как Economy V2." });
  }
  if (!isMoney && (!Number.isInteger(Number(resource.cargoPoints)) || Number(resource.cargoPoints) <= 0)) {
    issues.push({ code: "cargo-points", id, message: "Материальный ресурс должен иметь положительные целые cargo points." });
  }
  if (!Number.isInteger(Number(resource.rationPoints)) || Number(resource.rationPoints) < 0) {
    issues.push({ code: "ration-points", id, message: "Рационы партии должны быть целым неотрицательным числом." });
  }
  if (!Number.isInteger(Number(resource.shelfLifeTendays)) || Number(resource.shelfLifeTendays) < 0) {
    issues.push({ code: "shelf-life", id, message: "Срок хранения должен быть целым числом десятников." });
  }
  if (resource.tradable === true && wholeNonNegative(resource.referencePriceCopper, 0) <= 0) {
    issues.push({ code: "trade-price", id, message: "Торговому ресурсу нужна положительная справочная цена." });
  }
  if (wholeNonNegative(resource.rationPoints, 0) <= 0 && String(resource.dietGroup ?? "").trim()) {
    issues.push({ code: "diet-without-rations", id, message: "Непищевой ресурс не может давать группу разнообразия." });
  }
  return issues;
}

export function validateResourceEconomyCatalog(resources = []) {
  const rows = Array.isArray(resources) ? resources : [];
  const issues = rows.flatMap((resource) => resourceEconomyIssues(resource));
  const seenIds = new Map();
  for (const [index, resource] of rows.entries()) {
    const id = String(resource?.id ?? resource?.resourceId ?? "").trim();
    const identity = id.toLocaleLowerCase("en");
    if (!identity) {
      issues.push({ code: "resource-id", id: "", index, message: "У ресурса должен быть непустой уникальный id." });
      continue;
    }
    if (seenIds.has(identity)) {
      issues.push({
        code: "duplicate-resource-id",
        id,
        index,
        firstIndex: seenIds.get(identity),
        message: `Каталог содержит повторяющийся id ресурса «${id}». Исправьте дубликат вручную, чтобы не переназначить склад, рецепты и заказы.`
      });
      continue;
    }
    seenIds.set(identity, index);
  }
  return issues;
}
