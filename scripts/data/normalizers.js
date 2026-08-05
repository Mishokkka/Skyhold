import { DEFAULT_BUILDING_TEMPLATES, DEPRECATED_TEMPLATE_IDS, LEGACY_BUILDING_UPKEEP, TEMPLATE_CATALOG_VERSION } from "./building-templates.js";
import { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
import { BASE_HOLDING, HOLDING_TYPES } from "./schema/base-holding.js";
import { SKYHOLD_SCHEMA_VERSION } from "./schema-version.js";
import { isLegacyRawMaterialItemBinding, LIVESTOCK_RESOURCE_IDS, normalizeResourceCatalogRow, normalizeResourceRow, normalizeResourceId } from "../core/resources.js";
import { clone, isPlainObject, makeId, mergeDefaults, toBoolean, toNumber } from "./utils.js";
import { eventRegionOptionValue, normalizeEventRegionOptions, normalizeEventTagThresholds, normalizeRandomEventTables } from "./random-events.js";
import { normalizeDefenseSquad, normalizeMassCombatState } from "./normalizers/combat.js";
import { normalizeStorageItemRow, normalizeStorageLogRow } from "./normalizers/storage.js";
import { normalizeFleet } from "./normalizers/fleet.js";
import { normalizeBuilding, normalizeUniqueBuildingWorkers } from "./normalizers/building.js";
import { normalizeEventArchive, normalizeEventHistory, normalizeEventSchedule, normalizeHoldingOperationLog, normalizeLastEventRoll } from "./normalizers/events.js";
import { clearBuildingReferences, clearPersonReferences, normalizeConstructionCrew, normalizePerson } from "./normalizers/resident.js";
import { normalizeContentDoctrines } from "./content-packs.js";
import { createDefaultMarketEconomy, DEFAULT_MARKET_BASE_OFFERS, normalizeMarketEconomy } from "./market/economy.js";
import { normalizeMarketRouteMap } from "./market/route-map.js";
import { enterpriseCapitalForTemplate, enterpriseCapitalSchemaVersionForTemplate } from "./building-template-capital.js";
import { legacyBuildingMaintenanceForTemplate } from "./building-template-maintenance.js";
import { normalizeRationBuffer } from "./ration-buffer.js";
import { normalizePayrollState } from "./labor/payroll-state.js";
import { normalizeWageIndex } from "./labor/wage-catalog.js";
import { planEnterpriseCapitalV2Migration } from "../core/enterprise-capital.js";

export { clearBuildingReferences, clearPersonReferences };

export { SKYHOLD_SCHEMA_VERSION };
const SCHEMA_VERSION_DEPRECATED_FIREPLACE_REMOVED = 46;
const SCHEMA_VERSION_FOOD_CHAIN_REBALANCED = 71;
const SCHEMA_VERSION_FRESH_FOOD_SERVICES_REBALANCED = 75;
const SCHEMA_VERSION_MARKET_DEMAND = 77;
const SCHEMA_VERSION_INDUSTRIAL_CHAIN_REBALANCED = 78;
const SCHEMA_VERSION_TEXTILE_CHAIN_REBALANCED = 79;
const SCHEMA_VERSION_BUILDING_MAINTENANCE_SPLIT = 80;
const SCHEMA_VERSION_SETTLEMENT_SERVICES = 81;
const SCHEMA_VERSION_SEASONS_AND_LIVESTOCK_CONTENTS = 82;
const SCHEMA_VERSION_LIVESTOCK_MARKET_OFFERS = 85;
const SCHEMA_VERSION_TAVERN_PROCESSING_AND_LIVESTOCK_PRICES = 86;
const SCHEMA_VERSION_TAVERN_INSTANCE_RECOVERY = 87;
const SCHEMA_VERSION_OWN_RESOURCE_CATALOG = 88;
const SCHEMA_VERSION_EXPANDED_LIVESTOCK = 89;
const SCHEMA_VERSION_TAVERN_COMMON_TABLE = 92;
const SCHEMA_VERSION_ENTERPRISE_CAPITAL_V2 = 94;
const MARKET_ORDER_STATUSES = new Set(["pending", "in-transit", "delivered", "delayed", "lost", "cancelled"]);
const MARKET_DISPATCH_STATUSES = new Set(["booked", "departed", "delivered", "lost", "cancelled"]);
const MARKET_RISK_STATUSES = new Set(["pending", "resolved", "waived"]);
const MARKET_RISK_OUTCOMES = new Set(["pending", "clear", "delayed", "lost", "waived"]);

function normalizeOptions(options = {}) {
  const fromVersion = Math.max(0, Math.floor(toNumber(options.fromVersion, 0)));
  return {
    mode: String(options.mode ?? "load"),
    destructive: toBoolean(options.destructive, false),
    fromVersion,
    toVersion: Math.max(fromVersion, Math.floor(toNumber(options.toVersion, SKYHOLD_SCHEMA_VERSION)))
  };
}

function storedSchemaVersion(stored) {
  return Math.max(0, Math.floor(toNumber(stored?.meta?.schemaVersion, 0)));
}

const FOOD_CHAIN_LEGACY_LINES = Object.freeze({
  "grain-field": Object.freeze({ source: "time", cadence: "tenday", resourceId: "grain", outputQty: 20, expenses: "", effect: "Осенью можно собрать крупный урожай Grain. В менеджере оформлено как накопление урожая за десятник с ручным сбором." }),
  mill: Object.freeze({ source: "workers", cadence: "qd", resourceId: "flour", outputQty: 12, expenses: "grain 12", effect: "Grain превращается в Flour по Quarter Day." }),
  bakery: Object.freeze({ source: "workers", cadence: "qd", resourceId: "bread", outputQty: 12, expenses: "flour 12", effect: "Flour превращается в Bread/Food." })
});

function normalizedProductionExpense(value = "") {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDefaultProductionSeasons(line = {}) {
  const seasons = line?.seasons;
  if (!seasons || typeof seasons !== "object" || Array.isArray(seasons)) return true;
  return ["spring", "summer", "autumn", "winter"].every((key) => seasons[key] !== false);
}

function migrateFoodChainBuildingMechanics(building = {}, options = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_FOOD_CHAIN_REBALANCED)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacy = FOOD_CHAIN_LEGACY_LINES[templateId];
  if (!legacy || !Array.isArray(building.productionLines) || building.productionLines.length !== 1) return false;
  const line = building.productionLines[0] ?? {};
  const source = String(line.source ?? "workers");
  const cadence = String(line.cadence ?? line.period ?? "day");
  const resourceId = normalizeResourceId(line.resourceId, line.resource, line.name);
  const matches = source === legacy.source
    && cadence === legacy.cadence
    && resourceId === legacy.resourceId
    && toNumber(line.outputQty ?? line.output ?? line.quantity, 0) === legacy.outputQty
    && normalizedProductionExpense(line.expenses) === legacy.expenses
    && !String(line.formula ?? "").trim()
    && hasDefaultProductionSeasons(line);
  if (!matches) return false;
  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.productionLines = clone(current.productionLines ?? []);
  if (String(building.effect ?? "") === legacy.effect) building.effect = String(current.effect ?? building.effect ?? "");
  if (String(building.notes ?? "") === legacy.effect) building.notes = String(current.notes ?? building.notes ?? "");
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

function migrateBuildingMaintenance(building = {}, options = {}, { source = building } = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_BUILDING_MAINTENANCE_SPLIT)) return false;
  if (isPlainObject(source?.maintenance)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const hasBuiltin = Object.hasOwn(LEGACY_BUILDING_UPKEEP, templateId);
  const legacyUpkeep = hasBuiltin ? Math.max(0, toNumber(LEGACY_BUILDING_UPKEEP[templateId], 0)) : 0;
  const sourceHasUpkeep = source?.upkeep !== undefined && source?.upkeep !== null && source?.upkeep !== "";
  const sourceUpkeep = Math.max(0, toNumber(source?.upkeep, legacyUpkeep));
  const untouchedBuiltin = hasBuiltin && (!sourceHasUpkeep || sourceUpkeep === legacyUpkeep);
  building.maintenance = untouchedBuiltin
    ? clone(legacyBuildingMaintenanceForTemplate(templateId, legacyUpkeep))
    : {
        version: 1,
        class: "custom",
        billingMode: "legacy-monthly",
        copperPerTenday: null,
        operatingCopperMonthly: sourceUpkeep,
        repairReserveCopperMonthly: 0,
        notes: "Сохранено прежнее пользовательское содержание; распределение можно изменить в редакторе здания."
      };
  building.upkeep = building.maintenance.operatingCopperMonthly + building.maintenance.repairReserveCopperMonthly;
  return true;
}

const LEGACY_SERVICE_BUILDINGS = Object.freeze({
  bathhouse: Object.freeze({
    production: false,
    income: false,
    description: "Гигиена, отдых и довольство.",
    effect: "Позволяет пользоваться баней, повышает довольство.",
    notes: "Позволяет пользоваться баней, повышает довольство."
  }),
  apothecary: Object.freeze({
    production: true,
    income: true,
    description: "Травы, настойки, обезболивающие, мази и учет медицинских запасов.",
    effect: "Медицинская поддержка и доход от лекарств. При наличии трав снижает риск смерти раненых после защиты поселения.",
    notes: "В Mass Combat считается медицинской поддержкой. Подходит для аптекарей, лекарей и травников."
  }),
  "personnel-office": Object.freeze({
    production: false,
    income: true,
    description: "Учет работников и снижение расходов на рабочую силу.",
    effect: "Уменьшает оплату рабочей силы на 10%.",
    notes: "Уменьшает оплату рабочей силы на 10%."
  })
});

function migrateSettlementServices(building = {}, options = {}, { source = building } = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_SETTLEMENT_SERVICES)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacy = LEGACY_SERVICE_BUILDINGS[templateId];
  if (!legacy) return false;
  const sourceIncome = isPlainObject(source?.income) ? source.income : {};
  const sourceFunctions = isPlainObject(source?.functions) ? source.functions : {};
  const customService = isPlainObject(sourceIncome.service);
  const customFixedIncome = toNumber(sourceIncome.base, 0) !== 0
    || toNumber(sourceIncome.perWorker, 0) !== 0
    || Boolean(String(sourceIncome.formula ?? "").trim());
  const customProduction = templateId === "apothecary" && Array.isArray(source?.productionLines) && source.productionLines.length > 0;
  const productionFlagMatches = sourceFunctions.production === undefined || Boolean(sourceFunctions.production) === legacy.production;
  const incomeFlagMatches = sourceFunctions.income === undefined || Boolean(sourceFunctions.income) === legacy.income;
  const untouched = !customService && !customFixedIncome && !customProduction && productionFlagMatches && incomeFlagMatches;

  if (!untouched) {
    if (!customService && isPlainObject(building?.income?.service)) building.income.service.enabled = false;
    if (sourceFunctions.production !== undefined) building.functions.production = Boolean(sourceFunctions.production);
    if (sourceFunctions.income !== undefined) building.functions.income = Boolean(sourceFunctions.income);
    return false;
  }

  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.functions = { ...(building.functions ?? {}), production: current.functions?.production, income: current.functions?.income };
  building.productionLines = clone(current.productionLines ?? []);
  building.income = {
    ...(building.income ?? {}),
    base: 0,
    perWorker: 0,
    formula: "",
    service: clone(current.income?.service ?? {})
  };
  for (const key of ["description", "effect", "notes"]) {
    if (String(source?.[key] ?? "") === legacy[key]) building[key] = String(current?.[key] ?? building?.[key] ?? "");
  }
  if (!String(source?.workerRole ?? "").trim()) building.workerRole = String(current?.workerRole ?? building?.workerRole ?? "");
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

const FRESH_FOOD_LEGACY_LINES = Object.freeze({
  garden: Object.freeze([
    Object.freeze({ source: "workers", cadence: "day", resourceId: "vegetables", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none" }),
    Object.freeze({ source: "workers", cadence: "day", resourceId: "herbs", outputQty: 1, laborQdPerBatch: 2, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none" })
  ]),
  pasture: Object.freeze([
    Object.freeze({ source: "workers", cadence: "day", resourceId: "milk", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none" })
  ]),
  pigsty: Object.freeze([
    Object.freeze({ source: "workers", cadence: "tenday", resourceId: "meat", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 1, expenses: "", requiresCollection: true, collectQd: 0, autoCollect: "worker" })
  ]),
  inn: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "bread", outputQty: 6, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "Meat 6", requiresCollection: false, collectQd: 0, autoCollect: "none" }),
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "bread", outputQty: 6, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "Vegetables 6", requiresCollection: false, collectQd: 0, autoCollect: "none" })
  ])
});

const FRESH_FOOD_LEGACY_TEXT = Object.freeze({
  garden: Object.freeze({ name: "Сад", description: "Огород, травы и овощи для стола и лекарского дела.", effect: "Весной и летом дает Vegetables или Herbs.", notes: "Весной и летом дает Vegetables или Herbs." }),
  pasture: Object.freeze({ effect: "Коровы дают Milk раз в день. Забой и приплод оставлены как ручная/событийная операция.", notes: "Коровы дают Milk раз в день. Забой и приплод оставлены как ручная/событийная операция." }),
  pigsty: Object.freeze({ effect: "Свиней можно забивать на Meat, приплод идет событием раз в год.", notes: "Свиней можно забивать на Meat, приплод идет событием раз в год." }),
  inn: Object.freeze({ description: "Постоялый двор, еда, слухи и малый доход.", effect: "Meat или Vegetables превращаются в Food.", notes: "Meat или Vegetables превращаются в Food." })
});

const SEASON_LIVESTOCK_LEGACY_LINES = Object.freeze({
  garden: Object.freeze([
    Object.freeze({ source: "time", cadence: "tenday", resourceId: "vegetables", outputQty: 12, laborQdPerBatch: 0, maxBatchesPerCadence: 1, expenses: "", requiresCollection: true, collectQd: 2, autoCollect: "building", seasons: { spring: true, summer: true, autumn: true, winter: false } }),
    Object.freeze({ source: "time", cadence: "tenday", resourceId: "fruits", outputQty: 8, laborQdPerBatch: 0, maxBatchesPerCadence: 1, expenses: "", requiresCollection: true, collectQd: 2, autoCollect: "building", seasons: { spring: false, summer: true, autumn: true, winter: false } }),
    Object.freeze({ source: "time", cadence: "tenday", resourceId: "herbs", outputQty: 3, laborQdPerBatch: 0, maxBatchesPerCadence: 1, expenses: "", requiresCollection: true, collectQd: 2, autoCollect: "building", seasons: { spring: true, summer: true, autumn: false, winter: false } })
  ]),
  pasture: Object.freeze([
    Object.freeze({ source: "workers", cadence: "day", resourceId: "milk", outputQty: 2, laborQdPerBatch: 2, maxBatchesPerCadence: 0, expenses: "Grain 0.1", requiresCollection: false, collectQd: 0, autoCollect: "none" })
  ]),
  pigsty: Object.freeze([
    Object.freeze({ source: "time", cadence: "tenday", resourceId: "meat", outputQty: 11, laborQdPerBatch: 0, maxBatchesPerCadence: 1, expenses: "Grain 2", requiresCollection: true, collectQd: 2, autoCollect: "building" })
  ]),
  sheepfold: Object.freeze([
    Object.freeze({ source: "workers", cadence: "year", resourceId: "wool", outputQty: 36, laborQdPerBatch: 2, maxBatchesPerCadence: 1, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none", seasons: { spring: true, summer: false, autumn: false, winter: false } }),
    Object.freeze({ source: "workers", cadence: "year", resourceId: "meat", outputQty: 48, laborQdPerBatch: 1, maxBatchesPerCadence: 1, expenses: "Grain 6", requiresCollection: false, collectQd: 0, autoCollect: "none", seasons: { spring: false, summer: false, autumn: true, winter: false } }),
    Object.freeze({ source: "workers", cadence: "year", resourceId: "pelt", outputQty: 6, laborQdPerBatch: 1, maxBatchesPerCadence: 1, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none", seasons: { spring: false, summer: false, autumn: true, winter: false } })
  ])
});

const SEASON_LIVESTOCK_LEGACY_TEXT = Object.freeze({
  garden: Object.freeze({ effect: "Смешанное хозяйство даёт Vegetables, Fruits и Herbs в разные половины Зарости и Ухудно; урожай собирается последовательно и не возникает зимой.", notes: "Овощи доступны до Дождехода, фрукты — со второй половины Зарости до первой половины Ухудно, травы — в Зарости. Каждая линия требует 2 QD сбора и переносится с теньдня." }),
  pasture: Object.freeze({ effect: "За 2 рабочих QD пастух получает 2 кувшина Milk; на цикл требуется 0,1 мешка Grain как добавка к пастбищному корму.", notes: "Молоко производится круглый год при наличии стада, работника и зерновой подкормки. Забой и приплод оставлены как ручная/событийная операция." }),
  pigsty: Object.freeze({ effect: "Устойчивое стадо раз в десятник даёт 11 партий Meat на эффективного работника, расходуя 2 мешка Grain; разделка требует 2 QD.", notes: "Линия описывает усреднённый забой и восстановление стада, а не забой одной и той же дюжины каждый десятник. Приплод, падёж и покупка племенных животных остаются событиями." }),
  sheepfold: Object.freeze({ effect: "Весенняя стрижка даёт 36 Wool за 2 QD; осенняя выбраковка даёт 48 Meat и 6 Pelt за 2 QD, расходуя 6 Grain.", notes: "Выход усреднён для стада до двенадцати овец. Работника можно назначать сезонно; приплод, падёж и расширение стада остаются событиями." })
});

function productionLineMatchesLegacy(line = {}, legacy = {}) {
  return String(line?.source ?? "workers") === legacy.source
    && String(line?.cadence ?? line?.period ?? "day") === legacy.cadence
    && normalizeResourceId(line?.resourceId, line?.resource, line?.name) === legacy.resourceId
    && toNumber(line?.outputQty ?? line?.output ?? line?.quantity, 0) === legacy.outputQty
    && toNumber(line?.laborQdPerBatch ?? line?.workQd ?? line?.workerQD, legacy.laborQdPerBatch) === legacy.laborQdPerBatch
    && Math.floor(toNumber(line?.maxBatchesPerCadence, 0)) === legacy.maxBatchesPerCadence
    && normalizedProductionExpense(line?.expenses) === normalizedProductionExpense(legacy.expenses)
    && !String(line?.formula ?? "").trim()
    && Boolean(line?.requiresCollection) === legacy.requiresCollection
    && toNumber(line?.collectQd, 0) === legacy.collectQd
    && String(line?.autoCollect ?? "none") === legacy.autoCollect
    && (legacy.daylightProductionOnly === undefined || Boolean(line?.daylightProductionOnly) === legacy.daylightProductionOnly)
    && hasDefaultProductionSeasons(line);
}

function productionLinesMatchLegacy(lines = [], legacyLines = []) {
  return Array.isArray(lines)
    && lines.length === legacyLines.length
    && legacyLines.every((legacy, index) => productionLineMatchesLegacy(lines[index], legacy));
}

function productionSeasonsMatch(line = {}, legacy = {}) {
  if (!legacy.seasons) return hasDefaultProductionSeasons(line);
  const seasons = line?.seasons ?? {};
  return ["spring", "summer", "autumn", "winter"].every((key) => Boolean(seasons[key] !== false) === Boolean(legacy.seasons[key] !== false));
}

function productionLineMatchesSeasonLivestockLegacy(line = {}, legacy = {}) {
  return String(line?.source ?? "workers") === legacy.source
    && String(line?.cadence ?? line?.period ?? "day") === legacy.cadence
    && normalizeResourceId(line?.resourceId, line?.resource) === legacy.resourceId
    && toNumber(line?.outputQty ?? line?.output ?? line?.quantity, 0) === legacy.outputQty
    && toNumber(line?.laborQdPerBatch ?? line?.workQd ?? line?.workerQD, 0) === legacy.laborQdPerBatch
    && Math.floor(toNumber(line?.maxBatchesPerCadence, 0)) === legacy.maxBatchesPerCadence
    && String(line?.expenses ?? "").trim() === legacy.expenses
    && Boolean(line?.requiresCollection) === legacy.requiresCollection
    && toNumber(line?.collectQd, 0) === legacy.collectQd
    && String(line?.autoCollect ?? "none") === legacy.autoCollect
    && productionSeasonsMatch(line, legacy);
}

function migrateSeasonsAndLivestockContents(building = {}, options = {}, { source = building, instance = false } = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_SEASONS_AND_LIVESTOCK_CONTENTS)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacyLines = SEASON_LIVESTOCK_LEGACY_LINES[templateId];
  const sourceLines = Array.isArray(source?.productionLines) ? source.productionLines : building?.productionLines;
  const livestockTemplate = ["pasture", "pigsty", "sheepfold"].includes(templateId);
  // Existing contents are an explicit GM choice. Do not replace either those
  // rows or their production links with the new built-in herd defaults.
  if (livestockTemplate && Array.isArray(source?.contents) && source.contents.length > 0) return false;
  if (!legacyLines || !Array.isArray(sourceLines) || sourceLines.length !== legacyLines.length) return false;
  if (!legacyLines.every((legacy, index) => productionLineMatchesSeasonLivestockLegacy(sourceLines[index], legacy))) return false;

  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.productionLines = clone(current.productionLines ?? []);
  if (livestockTemplate) {
    building.contents = clone(current.contents ?? []);
    // До появления физического скота старое действующее хозяйство уже
    // подразумевало полное стадо. Экземпляру сохраняем это поголовье, а
    // каталог новых проектов остаётся пустым и требует рыночной закупки.
    if (instance && building.contents[0]) building.contents[0].qty = 12;
  }
  const legacyText = SEASON_LIVESTOCK_LEGACY_TEXT[templateId] ?? {};
  for (const key of ["effect", "notes"]) {
    if (legacyText[key] !== undefined && String(source?.[key] ?? "") === legacyText[key]) building[key] = String(current?.[key] ?? building?.[key] ?? "");
  }
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

const LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE = Object.freeze({
  pasture: Object.freeze({ contentId: "cows", contentNamePattern: /(?:коров|cow|cattle)/, resourceId: "cattle" }),
  pigsty: Object.freeze({ contentId: "pigs", contentNamePattern: /(?:свин|pig)/, resourceId: "pigs" }),
  sheepfold: Object.freeze({ contentId: "sheep", contentNamePattern: /(?:овц|овеч|sheep)/, resourceId: "sheep" })
});

function livestockContentResourceForBuilding(building = {}) {
  const directId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  if (LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE[directId]) return LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE[directId];
  const identity = [building?.templateId, building?.id, building?.name]
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/ё/g, "е"))
    .join(" ");
  if (/(?:pasture|пастбищ)/.test(identity)) return LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE.pasture;
  if (/(?:pigsty|свинарник)/.test(identity)) return LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE.pigsty;
  if (/(?:sheepfold|овчарн)/.test(identity)) return LIVESTOCK_CONTENT_RESOURCE_BY_TEMPLATE.sheepfold;
  return null;
}

function isLegacyInnVegetableProducer(building = {}) {
  const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
  if (lines.length !== 1) return false;
  const line = lines[0] ?? {};
  return String(line?.source ?? "workers") === "workers"
    && String(line?.cadence ?? line?.period ?? "day") === "day"
    && normalizeResourceId(line?.resourceId, line?.resource, line?.name) === "vegetables"
    && toNumber(line?.outputQty ?? line?.output ?? line?.quantity, 0) === 12
    && toNumber(line?.laborQdPerBatch ?? line?.workQd ?? line?.workerQD, 1) === 1
    && Math.floor(toNumber(line?.maxBatchesPerCadence, 0)) === 0
    && String(line?.expenses ?? "").trim() === ""
    && Boolean(line?.requiresCollection) === false
    && hasDefaultProductionSeasons(line);
}

function isInnLikeBuilding(building = {}) {
  const identities = [building?.templateId, building?.id, building?.name]
    .map((value) => String(value ?? "").trim().toLowerCase().replace(/ё/g, "е"))
    .filter(Boolean);
  return identities.some((value) => value === "inn" || value === "tavern" || /(?:трактир|таверн)/.test(value));
}

const LEGACY_TAVERN_PREPARED_LINES = Object.freeze([
  Object.freeze({
    id: "prepared-meat",
    name: "Готовая пища из мяса",
    expense: "Meat 6"
  }),
  Object.freeze({
    id: "prepared-vegetables",
    name: "Готовая пища из овощей",
    expense: "Vegetables 6"
  })
]);

const LEGACY_TAVERN_LINE_KEYS = new Set([
  "id", "active", "name", "mode", "source", "cadence", "cadenceEvery",
  "laborQdPerBatch", "maxBatchesPerCadence", "cadenceKey", "batchesInCadence",
  "period", "contentId", "contentUnitsPerBatch", "resourceId", "resource", "base", "perWorker",
  "outputQty", "workQd", "formula", "expenses", "expenseMode", "costsText",
  "requiresCollection", "collectQd", "autoCollect", "daylightCollectionOnly",
  "daylightProductionOnly", "overtime", "pendingQty", "passive", "workInProgress", "storageRoomId", "seasons",
  "itemUuid", "itemId"
]);

function exactDefaultSeasons(seasons) {
  if (seasons === undefined) return true;
  if (!isPlainObject(seasons)) return false;
  const keys = Object.keys(seasons);
  return keys.length === 4
    && ["spring", "summer", "autumn", "winter"].every((key) => seasons[key] === true);
}

function isExactLegacyTavernPreparedLine(line = {}, legacy = {}) {
  if (!isPlainObject(line) || Object.keys(line).some((key) => !LEGACY_TAVERN_LINE_KEYS.has(key))) return false;
  return String(line.id ?? "") === legacy.id
    && toBoolean(line.active, true) === true
    && (line.name === undefined || String(line.name) === legacy.name)
    && String(line.mode ?? "Приготовление пищи") === "Приготовление пищи"
    && String(line.source ?? "workers") === "workers"
    && String(line.cadence ?? line.period ?? "qd") === "qd"
    && Math.floor(toNumber(line.cadenceEvery, 1)) === 1
    && toNumber(line.laborQdPerBatch ?? line.workQd, 1) === 1
    && Math.floor(toNumber(line.maxBatchesPerCadence, 0)) === 0
    && String(line.cadenceKey ?? "") === ""
    && Math.floor(toNumber(line.batchesInCadence, 0)) === 0
    && (line.period === undefined || String(line.period) === "qd")
    && String(line.contentId ?? "") === ""
    && Math.floor(toNumber(line.contentUnitsPerBatch, 1)) === 1
    && normalizeResourceId(line.resourceId, line.resource) === "prepared-food"
    && (line.resource === undefined || String(line.resource) === "Готовая пища")
    && toNumber(line.base, 0) === 0
    && toNumber(line.perWorker, 0) === 0
    && toNumber(line.outputQty ?? line.output ?? line.quantity, 0) === 6
    && toNumber(line.workQd, 1) === 1
    && String(line.formula ?? "") === ""
    && String(line.expenses ?? "") === legacy.expense
    && String(line.expenseMode ?? "cycle") === "cycle"
    && (line.costsText === undefined || String(line.costsText) === legacy.expense)
    && toBoolean(line.requiresCollection, false) === false
    && toNumber(line.collectQd, 0) === 0
    && String(line.autoCollect ?? "none") === "none"
    && toBoolean(line.daylightCollectionOnly, false) === false
    && toBoolean(line.daylightProductionOnly, false) === false
    && toBoolean(line.overtime, false) === false
    && toNumber(line.pendingQty, 0) === 0
    && toBoolean(line.passive, false) === false
    && (line.workInProgress === undefined || line.workInProgress === null)
    && String(line.storageRoomId ?? "outdoors") === "outdoors"
    && exactDefaultSeasons(line.seasons)
    && String(line.itemUuid ?? "") === ""
    && String(line.itemId ?? "") === "";
}

function exactLegacyTavernPreparedLine(line = {}) {
  const legacy = LEGACY_TAVERN_PREPARED_LINES.find((candidate) => String(line?.id ?? "") === candidate.id);
  return legacy ? isExactLegacyTavernPreparedLine(line, legacy) : false;
}

const LEGACY_TAVERN_TEXT = Object.freeze({
  description: new Set([
    "Постоялый двор, где работники собирают съедобное сырьё, готовят пищу и обслуживают жителей и приезжих при наличии реального спроса.",
    "Постоялый двор, который обслуживает жителей и приезжих только при наличии работников, свободной пищи и реального спроса."
  ]),
  effect: new Set([
    "За 1 рабочий QD трактир превращает 6 партий Meat или Vegetables в 6 партий готовой пищи. Работник может забрать сырьё у производителя с режимом сбора «работником потребителя». За десятник трактир обслуживает спрос жителей и приезжих в пределах рабочей мощности.",
    "За десятник трактир обслуживает спрос жителей и приезжих в пределах рабочей мощности. Каждая услуга расходует 0,5 человеко-дня пищи и приносит 8 медных."
  ]),
  notes: new Set([
    "Приготовление не создаёт сырьё: каждая линия сначала требует реальный запас Meat или Vegetables. Сначала общий стол кормит жителей. Оставшийся запас может быть продан как питание и ночлег; число приезжих зависит от Репутации, УРС и шести гостевых мест.",
    "Сначала общий стол кормит жителей. Оставшийся запас может быть продан как питание и ночлег; число приезжих зависит от Репутации, УРС и шести гостевых мест."
  ])
});

const LEGACY_TAVERN_SERVICE_NOTES = new Set([
  "Спрос за десятник: 0,2 визита на жителя + 2 визита за Репутацию + 2 визита за УРС. Сначала питаются жители; трактир продаёт только оставшуюся пищу.",
  "Сначала общий стол кормит жителей. Оставшийся запас может быть продан как питание и ночлег; число приезжих зависит от Репутации, УРС и шести гостевых мест."
]);

function hasLegacyTavernServiceFingerprint(service = {}) {
  if (!isPlainObject(service)) return false;
  return service.enabled === true
    && String(service.demandPool ?? "hospitality") === "hospitality"
    && String(service.label ?? "Питание и ночлег") === "Питание и ночлег"
    && toNumber(service.localDemandPerResident, 0.2) === 0.2
    && toNumber(service.visitorDemandPerReputation, 2) === 2
    && toNumber(service.visitorDemandPerConnection, 2) === 2
    && toNumber(service.servicesPerWorker, 20) === 20
    && toNumber(service.foodPersonDaysPerService, 0.5) === 0.5
    && toBoolean(service.visitorRequiresHousing, true) === true
    && String(service.inputResourceId ?? "") === ""
    && toNumber(service.inputQtyPerService, 0) === 0
    && toNumber(service.priceCopper, 8) === 8
    && LEGACY_TAVERN_SERVICE_NOTES.has(String(service.notes ?? ""));
}

function migrateTavernCommonTable(building = {}, options = {}) {
  if (!isInnLikeBuilding(building)) return false;
  const currentInn = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === "inn");
  if (!currentInn) return false;

  const lines = Array.isArray(building.productionLines) ? building.productionLines : [];
  const exactLegacyLineCount = lines.filter((line) => exactLegacyTavernPreparedLine(line)).length;
  const hasLegacyTextFingerprint = ["description", "effect", "notes"]
    .some((key) => LEGACY_TAVERN_TEXT[key].has(String(building?.[key] ?? "")));
  const hasLegacyServiceFingerprint = hasLegacyTavernServiceFingerprint(building?.income?.service);
  const legacySchema = isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_TAVERN_COMMON_TABLE);
  if (!legacySchema && exactLegacyLineCount === 0) return false;

  let changed = false;
  if (exactLegacyLineCount > 0) {
    building.productionLines = lines.filter((line) => !exactLegacyTavernPreparedLine(line));
    if (!isPlainObject(building.functions)) building.functions = {};
    if (building.productionLines.length === 0 && building.functions.production !== false) {
      building.functions.production = false;
    }
    changed = true;
  }

  const builtInFingerprint = exactLegacyLineCount > 0 || hasLegacyTextFingerprint || hasLegacyServiceFingerprint;
  if (builtInFingerprint && toNumber(building.moraleDelta, 0) === 2) {
    building.moraleDelta = 0;
    changed = true;
  }

  if (!isPlainObject(building.income)) building.income = {};
  if (builtInFingerprint && isPlainObject(building.income.service)) {
    const service = building.income.service;
    if (toNumber(service.localDemandPerResident, 0.2) === 0.2) {
      service.localDemandPerResident = 0;
      changed = true;
    }
    if (service.residentMealCapacityPerWorker === undefined) {
      service.residentMealCapacityPerWorker = toNumber(currentInn?.income?.service?.residentMealCapacityPerWorker, 20);
      changed = true;
    }
  }

  for (const key of ["description", "effect", "notes"]) {
    if (!LEGACY_TAVERN_TEXT[key].has(String(building?.[key] ?? ""))) continue;
    building[key] = String(currentInn?.[key] ?? building[key] ?? "");
    changed = true;
  }

  if (changed && !String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return changed;
}

function migrateLivestockMarketAndLegacyInn(building = {}) {
  let changed = false;
  const livestock = livestockContentResourceForBuilding(building);
  if (livestock && Array.isArray(building?.contents)) {
    const content = building.contents.find((row) => {
      if (String(row?.id ?? "") === livestock.contentId) return true;
      const name = String(row?.name ?? row?.label ?? "").trim().toLowerCase().replace(/ё/g, "е");
      return livestock.contentNamePattern.test(name);
    });
    if (content && !String(content.resourceId ?? "").trim()) {
      content.resourceId = livestock.resourceId;
      changed = true;
    }
  }
  // Schema 84 mistakenly removed this line while trying to replace the broken
  // vegetable generator. Resolve that exact stale state to the current inn
  // model, which now uses an implied common table instead of production lines.
  // Keep the exact detector idempotent for split worlds whose metadata may
  // have advanced before an old holdings partition was rewritten.
  if (isInnLikeBuilding(building) && isLegacyInnVegetableProducer(building)) {
    const currentInn = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === "inn");
    building.productionLines = clone(currentInn?.productionLines ?? []);
    if (!isPlainObject(building.functions)) building.functions = {};
    building.functions.production = Boolean(currentInn?.functions?.production);
    changed = true;
  }
  return changed;
}

function migrateExpandedLivestockContents(building = {}, options = {}, { source = building, instance = false } = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_EXPANDED_LIVESTOCK)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  if (!["stables", "dovecote"].includes(templateId) || (Array.isArray(source?.contents) && source.contents.length > 0)) return false;
  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row?.id ?? "") === templateId);
  if (!current?.contents?.length) return false;
  building.contents = clone(current.contents);
  if (!instance) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

function migrateTavernProcessing(building = {}, options = {}) {
  if (!isInnLikeBuilding(building)) return false;
  const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
  if (lines.length > 0) return false;
  const originalBuiltInText = "Постоялый двор: харчевня на первом этаже и комнаты для съема на втором этаже.";
  const originalBuiltInTextKey = ["description", "effect", "notes"]
    .find((key) => String(building?.[key] ?? "") === originalBuiltInText) ?? "";
  const hasOriginalBuiltInText = Boolean(originalBuiltInTextKey);
  const hasRebalancedBuiltInText = [
      "Постоялый двор, где работники собирают съедобное сырьё, готовят пищу и обслуживают жителей и приезжих при наличии реального спроса.",
      "Постоялый двор, который обслуживает жителей и приезжих только при наличии работников, свободной пищи и реального спроса.",
      "За десятник трактир обслуживает спрос жителей и приезжих в пределах рабочей мощности. Каждая услуга расходует 0,5 человеко-дня пищи и приносит 8 медных.",
      "Сначала общий стол кормит жителей. Оставшийся запас может быть продан как питание и ночлег; число приезжих зависит от Репутации, УРС и шести гостевых мест."
    ].some((text) => [building?.description, building?.effect, building?.notes].some((value) => String(value ?? "") === text));
  const isBrokenBuiltInState = hasOriginalBuiltInText || (
    building?.functions?.production !== true
    && building?.income?.service?.enabled === true
    && hasRebalancedBuiltInText
  );
  // Split storage can advance root metadata before rewriting a holding. The
  // exact schema-85 built-in state therefore remains repairable idempotently,
  // while an intentionally empty/custom inn is left alone.
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_TAVERN_INSTANCE_RECOVERY) && !isBrokenBuiltInState) return false;
  if (building?.income?.service?.enabled === false && !hasOriginalBuiltInText) return false;
  const currentInn = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === "inn");
  if (!currentInn) return false;
  building.productionLines = clone(currentInn.productionLines ?? []);
  if (!isPlainObject(building.functions)) building.functions = {};
  building.functions.production = Boolean(currentInn?.functions?.production);
  return true;
}

function defaultInnTradeMatches(trade = {}) {
  return String(trade?.budgetFormula ?? "2d6*10") === "2d6*10"
    && Math.floor(toNumber(trade?.maxLotsPerBuyer, 1)) === 1
    && String(trade?.roomId ?? "all") === "all"
    && String(trade?.kind ?? "all") === "all"
    && String(trade?.notes ?? "") === "Покупатели трактирных услуг и мелких товаров.";
}

function migrateFreshFoodAndHospitality(building = {}, options = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_FRESH_FOOD_SERVICES_REBALANCED)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacyLines = FRESH_FOOD_LEGACY_LINES[templateId];
  if (!legacyLines || !productionLinesMatchLegacy(building?.productionLines, legacyLines)) return false;
  if (templateId === "inn" && (
    ![0, 1].includes(toNumber(building?.income?.base, 0))
    || toNumber(building?.income?.perWorker, 0) !== 1
    || String(building?.income?.formula ?? "").trim()
  )) return false;

  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.productionLines = clone(current.productionLines ?? []);
  if (templateId === "inn") {
    const preserveTrade = !defaultInnTradeMatches(building?.income?.trade);
    const trade = preserveTrade ? clone(building?.income?.trade ?? {}) : clone(current?.income?.trade ?? {});
    building.functions = { ...(building.functions ?? {}), production: Boolean(current?.functions?.production), income: true };
    building.income = {
      ...(building.income ?? {}),
      base: 0,
      perWorker: 0,
      formula: "",
      service: clone(current?.income?.service ?? {}),
      trade
    };
  }

  const legacyText = FRESH_FOOD_LEGACY_TEXT[templateId] ?? {};
  for (const key of ["name", "description", "effect", "notes"]) {
    if (legacyText[key] !== undefined && String(building?.[key] ?? "") === legacyText[key]) building[key] = String(current?.[key] ?? building[key] ?? "");
  }
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

const INDUSTRIAL_CHAIN_LEGACY_LINES = Object.freeze({
  lumbermill: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "wood", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ]),
  quarry: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "stone", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ]),
  mine: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "iron-ore", outputQty: 2, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ]),
  forge: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "iron", outputQty: 12, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "Iron Ore 12", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ])
});

const INDUSTRIAL_CHAIN_LEGACY_TEXT = Object.freeze({
  lumbermill: Object.freeze({
    description: "Заготовка древесины.",
    effect: "Каждый работник производит Wood за Quarter Day.",
    notes: "Каждый работник производит Wood за Quarter Day."
  }),
  quarry: Object.freeze({
    description: "Добыча камня для строительства.",
    effect: "Каждый работник производит Stone за Quarter Day.",
    notes: "Каждый работник производит Stone за Quarter Day."
  }),
  mine: Object.freeze({
    description: "Добыча железной руды. Опасно, но выгодно.",
    effect: "Каждый шахтер производит Iron Ore за Quarter Day.",
    notes: "Каждый шахтер производит Iron Ore за Quarter Day."
  }),
  forge: Object.freeze({
    description: "Переработка руды и основа металлообработки.",
    effect: "Iron Ore превращается в Iron.",
    notes: "Iron Ore превращается в Iron."
  })
});

function migrateIndustrialChain(building = {}, options = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_INDUSTRIAL_CHAIN_REBALANCED)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacyLines = INDUSTRIAL_CHAIN_LEGACY_LINES[templateId];
  if (!legacyLines || !productionLinesMatchLegacy(building?.productionLines, legacyLines)) return false;
  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.productionLines = clone(current.productionLines ?? []);
  const legacyText = INDUSTRIAL_CHAIN_LEGACY_TEXT[templateId] ?? {};
  for (const key of ["description", "effect", "notes"]) {
    if (String(building?.[key] ?? "") === legacyText[key]) building[key] = String(current?.[key] ?? building[key] ?? "");
  }
  if (!String(building?.workerRole ?? "").trim()) building.workerRole = String(current?.workerRole ?? "");
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

const TEXTILE_CHAIN_LEGACY_LINES = Object.freeze({
  sheepfold: Object.freeze([
    Object.freeze({ source: "workers", cadence: "tenday", resourceId: "wool", outputQty: 4, laborQdPerBatch: 1, maxBatchesPerCadence: 1, expenses: "", requiresCollection: true, collectQd: 0, autoCollect: "worker", daylightProductionOnly: false })
  ]),
  tannery: Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "leather", outputQty: 12, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "Pelt 12", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ]),
  "tailor-shop": Object.freeze([
    Object.freeze({ source: "workers", cadence: "qd", resourceId: "cloth-wool", outputQty: 12, laborQdPerBatch: 1, maxBatchesPerCadence: 0, expenses: "Wool 12", requiresCollection: false, collectQd: 0, autoCollect: "none", daylightProductionOnly: false })
  ])
});

const TEXTILE_CHAIN_LEGACY_TEXT = Object.freeze({
  sheepfold: Object.freeze({
    description: "Овцы дают шерсть, мясо и приплод.",
    effect: "Стрижка дает Wool, забой дает Meat, приплод идет событием.",
    notes: "Стрижка дает Wool, забой дает Meat, приплод идет событием."
  }),
  tannery: Object.freeze({
    description: "Выделка шкур в кожу.",
    effect: "Pelt превращается в Leather.",
    notes: "Pelt превращается в Leather."
  }),
  "tailor-shop": Object.freeze({
    description: "Ткачество и пошив одежды.",
    effect: "Wool превращается в Cloth, Wool. Бонус к Crafting одежды.",
    notes: "Wool превращается в Cloth, Wool. Бонус к Crafting одежды."
  })
});

function migrateTextileChain(building = {}, options = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_TEXTILE_CHAIN_REBALANCED)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  const legacyLines = TEXTILE_CHAIN_LEGACY_LINES[templateId];
  if (!legacyLines || !productionLinesMatchLegacy(building?.productionLines, legacyLines)) return false;
  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === templateId);
  if (!current) return false;
  building.productionLines = clone(current.productionLines ?? []);
  const legacyText = TEXTILE_CHAIN_LEGACY_TEXT[templateId] ?? {};
  for (const key of ["description", "effect", "notes"]) {
    if (String(building?.[key] ?? "") === legacyText[key]) building[key] = String(current?.[key] ?? building[key] ?? "");
  }
  if (!String(building?.workerRole ?? "").trim()) building.workerRole = String(current?.workerRole ?? "");
  if (templateId === "sheepfold" && toNumber(building?.workersMin, 1) === 1) building.workersMin = 0;
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

function migrateEnterpriseCapital(building = {}, options = {}, { instance = false } = {}) {
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  if (!isBeforeSkyholdSchemaVersion(options, enterpriseCapitalSchemaVersionForTemplate(templateId))) return false;
  const capital = enterpriseCapitalForTemplate(templateId);
  if (!capital || isPlainObject(building?.enterpriseCapital)) return false;
  building.enterpriseCapital = clone(capital);
  if (instance) {
    const status = String(building?.constructionStatus ?? building?.status ?? "").trim().toLowerCase();
    const lifecycle = String(building?.lifecycle ?? "").trim().toLowerCase();
    const target = Math.max(0, toNumber(building?.buildTarget, 0));
    const progress = Math.max(0, toNumber(building?.buildProgress, 0));
    const completed = /built|постро/.test(status) || lifecycle === "active" || (target > 0 && progress >= target);
    if (completed) Object.assign(building.enterpriseCapital, enterpriseCapitalForTemplate(templateId, { funded: true }));
  }
  return true;
}

function migrateEnterpriseCapitalV2(building = {}, options = {}, { landRightsProvided = false } = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_ENTERPRISE_CAPITAL_V2)) return false;
  if (!isPlainObject(building?.enterpriseCapital)) return false;
  const plan = planEnterpriseCapitalV2Migration(building, toNumber, { landRightsProvided });
  if (!plan.needed) return false;
  Object.assign(building.enterpriseCapital, plan.patch);
  return true;
}

const LEGACY_MARKET_TEXT = Object.freeze({
  description: "Торговые ряды и место приезжих купцов.",
  effect: "Supply как у обычной деревни. Довольство +3.",
  notes: "Supply как у обычной деревни. Довольство +3."
});

function legacyMarketTradeMatches(trade = {}) {
  return Boolean(trade?.enabled)
    && String(trade?.budgetFormula ?? "3d6*10") === "3d6*10"
    && Math.floor(toNumber(trade?.maxLotsPerBuyer, 2)) === 2
    && String(trade?.roomId ?? "all") === "all"
    && String(trade?.kind ?? "all") === "all"
    && String(trade?.notes ?? "") === "Обычная рыночная торговля.";
}

function migrateMarketDemand(building = {}, options = {}) {
  if (!isBeforeSkyholdSchemaVersion(options, SCHEMA_VERSION_MARKET_DEMAND)) return false;
  const templateId = String(building?.templateId ?? "").trim() || String(building?.id ?? "").trim();
  if (templateId !== "market") return false;
  const income = building?.income ?? {};
  if (
    toNumber(income.base, 0) !== 1
    || toNumber(income.perWorker, 0) !== 1
    || String(income.formula ?? "").trim()
    || !legacyMarketTradeMatches(income.trade)
  ) return false;
  const current = DEFAULT_BUILDING_TEMPLATES.find((row) => String(row.id) === "market");
  if (!current) return false;
  building.functions = { ...(building.functions ?? {}), income: true };
  building.income = {
    ...income,
    base: 0,
    perWorker: 0,
    formula: "",
    trade: clone(current.income?.trade ?? {})
  };
  for (const key of ["description", "effect", "notes"]) {
    if (String(building?.[key] ?? "") === LEGACY_MARKET_TEXT[key]) building[key] = String(current?.[key] ?? building[key] ?? "");
  }
  if (!String(building.templateId ?? "").trim()) building.templateVersion = TEMPLATE_CATALOG_VERSION;
  return true;
}

function normalizeMigrationOptions(stored, options = {}) {
  return normalizeOptions({
    ...options,
    fromVersion: options.fromVersion ?? storedSchemaVersion(stored),
    toVersion: SKYHOLD_SCHEMA_VERSION
  });
}

export function isBeforeSkyholdSchemaVersion(options = {}, version = SKYHOLD_SCHEMA_VERSION) {
  return Math.max(0, Math.floor(toNumber(options.fromVersion, 0))) < Math.max(0, Math.floor(toNumber(version, 0)));
}

export function normalizeSkyholdData(stored, options = {}) {
  return migrateData(stored, { ...options, mode: "load", destructive: false });
}

export function repairSkyholdData(stored, options = {}) {
  return migrateData(stored, { ...options, mode: "repair", destructive: true });
}

export function migrateData(stored, options = {}) {
  const normalize = normalizeMigrationOptions(stored, options);
  if (!stored || typeof stored !== "object") return migrateData(clone(DEFAULT_SKYHOLD_DATA), normalize);

  if (Array.isArray(stored.holdings)) {
    // The two large runtime partitions are normalized independently below.
    const migrated = mergeDefaults(DEFAULT_SKYHOLD_DATA, { ...stored, holdings: [], catalog: {} });
    migrated.meta.schemaVersion = SKYHOLD_SCHEMA_VERSION;
    migrated.meta.economyVersion = stored?.meta && Object.hasOwn(stored.meta, "economyVersion")
      ? Math.max(1, Math.floor(toNumber(stored.meta.economyVersion, 1)))
      : 1;
    // Activation is an explicit migration receipt, not a schema default. A
    // current marker belongs to genuinely new defaults, but must never leak
    // through mergeDefaults into an existing world that did not store it.
    if (stored?.meta?.economyActivation && typeof stored.meta.economyActivation === "object") {
      migrated.meta.economyActivation = clone(stored.meta.economyActivation);
    } else {
      delete migrated.meta.economyActivation;
    }
    migrated.catalog = normalizeCatalogPartition(stored.catalog, normalize);
    migrated.holdings = normalizeHoldingsPartition(stored.holdings, migrated.catalog, normalize);
    migrated.meta.templateCatalogVersion = TEMPLATE_CATALOG_VERSION;
    migrated.meta.revision = Math.max(0, toNumber(migrated.meta.revision, 0));
    return migrated;
  }

  return migrateLegacySettlement(stored, normalize);
}

export function normalizeCatalogPartition(storedCatalog, options = {}) {
  const normalize = normalizeOptions(options);
  const stored = isPlainObject(storedCatalog) ? storedCatalog : {};
  const catalog = mergeDefaults(DEFAULT_SKYHOLD_DATA.catalog, stored);
  if (!Array.isArray(catalog.buildings)) catalog.buildings = [];
  if (!Array.isArray(catalog.deletedBuildingTemplateIds)) catalog.deletedBuildingTemplateIds = [];
  catalog.buildings = mergeBuildingTemplateCatalog(catalog.buildings, catalog.deletedBuildingTemplateIds, normalize);
  if (!Array.isArray(catalog.resources)) catalog.resources = [];
  // Loading and schema normalization must never activate Economy V2. Even an
  // untouched native V1 row remains a legacy row until the GM runs the
  // explicit preview/backup/activation command.
  catalog.resources = catalog.resources.map((row) => normalizeResourceCatalogRow(row));
  catalog.marketRouteMap = normalizeMarketRouteMap(catalog.marketRouteMap);
  catalog.eventRegions = normalizeEventRegionOptions(catalog.eventRegions, { fallback: !Array.isArray(stored.eventRegions) });
  // Legacy/provider markets can contain GM-authored records. They are not
  // interpreted by the current market engine, but normal loading must retain
  // them for export or a later explicit conversion. Only manual repair purges
  // the obsolete partition.
  catalog.markets = normalize.destructive
    ? []
    : (Array.isArray(catalog.markets) ? catalog.markets.map((row) => clone(row)) : []);
  const hasStoredMarketEconomy = Boolean(stored.marketEconomy && typeof stored.marketEconomy === "object");
  const normalizedMarketEconomy = hasStoredMarketEconomy
    ? normalizeMarketEconomy(stored.marketEconomy, { locations: catalog.eventRegions })
    : createDefaultMarketEconomy(catalog.eventRegions);
  if (isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_OWN_RESOURCE_CATALOG)) {
    for (const offer of normalizedMarketEconomy.baseOffers) {
      if (!isLegacyRawMaterialItemBinding(offer)) continue;
      offer.sourceType = "resource";
      offer.resourceId = normalizeResourceId(offer.resourceId, offer.name);
      offer.itemUuid = "";
    }
  }
  if (isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_EXPANDED_LIVESTOCK)) {
    const newMarketResourceIds = new Set(["goats", "horses", "chickens", "geese", "rabbits", "pigeons", "eggs", "feathers"]);
    const existingResources = new Set(normalizedMarketEconomy.baseOffers.map((row) => normalizeResourceId(row?.resourceId, row?.name)));
    for (const offer of DEFAULT_MARKET_BASE_OFFERS) {
      const resourceId = normalizeResourceId(offer?.resourceId, offer?.name);
      if (!newMarketResourceIds.has(resourceId) || existingResources.has(resourceId)) continue;
      normalizedMarketEconomy.baseOffers.push(clone(offer));
      existingResources.add(resourceId);
    }
    const offerCollections = [
      normalizedMarketEconomy.baseOffers,
      ...normalizedMarketEconomy.countries.map((row) => row.offers ?? []),
      ...normalizedMarketEconomy.specialties.map((row) => row.offers ?? [])
    ];
    for (const offer of offerCollections.flat()) {
      const resourceId = normalizeResourceId(offer?.resourceId, offer?.name);
      if (LIVESTOCK_RESOURCE_IDS.includes(resourceId) || (offer?.tags ?? []).includes("livestock")) offer.kind = "livestock";
    }
  }
  if (isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_LIVESTOCK_MARKET_OFFERS)) {
    const existingResources = new Set(normalizedMarketEconomy.baseOffers.map((row) => normalizeResourceId(row?.resourceId, row?.name)));
    for (const offer of DEFAULT_MARKET_BASE_OFFERS) {
      const resourceId = normalizeResourceId(offer?.resourceId, offer?.name);
      if (!["cattle", "pigs", "sheep"].includes(resourceId) || existingResources.has(resourceId)) continue;
      normalizedMarketEconomy.baseOffers.push(clone(offer));
      existingResources.add(resourceId);
    }
  }
  if (isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_TAVERN_PROCESSING_AND_LIVESTOCK_PRICES)) {
    const oldLivestockPrices = new Map([["cattle", 200], ["pigs", 50], ["sheep", 100]]);
    const currentLivestockOffers = new Map(DEFAULT_MARKET_BASE_OFFERS
      .map((offer) => [normalizeResourceId(offer?.resourceId, offer?.name), offer])
      .filter(([resourceId]) => oldLivestockPrices.has(resourceId)));
    for (const offer of normalizedMarketEconomy.baseOffers) {
      const resourceId = normalizeResourceId(offer?.resourceId, offer?.name);
      const oldPrice = oldLivestockPrices.get(resourceId);
      const current = currentLivestockOffers.get(resourceId);
      if (!current || toNumber(offer?.basePriceCopper, -1) !== oldPrice) continue;
      offer.basePriceCopper = current.basePriceCopper;
    }
  }
  catalog.marketEconomy = normalizedMarketEconomy;
  if (!hasStoredMarketEconomy) {
    // Schema 66 promotes the former region-wide economy modifiers into the
    // newly created country profile. Clear their location copies so the same
    // factor is not multiplied twice. Legacy provider markets are discarded.
    for (const location of catalog.eventRegions) {
      location.marketPriceFactor = null;
      location.marketAvailabilityFactor = null;
      location.marketDeliveryFactor = null;
      location.marketTimeFactor = null;
      location.marketRiskFactor = null;
      location.marketTaxRate = 0;
    }
  }
  catalog.combatDoctrines = normalizeContentDoctrines(catalog.combatDoctrines);
  return catalog;
}

export function normalizeHoldingsPartition(storedHoldings, catalog, options = {}) {
  const normalize = normalizeOptions(options);
  const holdings = Array.isArray(storedHoldings)
    ? storedHoldings.map((holding) => mergeHoldingDefaults(holding, normalize))
    : [];
  const normalized = holdings.length ? holdings : clone(DEFAULT_SKYHOLD_DATA.holdings);
  reconcileHoldingRegions(normalized, catalog);
  return normalized;
}

export function reconcileHoldingRegions(holdings, catalog, { cloneOnWrite = false } = {}) {
  const rows = Array.isArray(holdings) ? holdings : [];
  const eventRegions = Array.isArray(catalog?.eventRegions) ? catalog.eventRegions : [];
  const defaultRegion = String(eventRegions[0]?.value ?? "");
  const regionIds = new Set(eventRegions.map((row) => String(row.value ?? "")));
  let next = rows;
  let changed = false;
  for (let index = 0; index < rows.length; index += 1) {
    const holding = rows[index];
    const rawRegion = String(holding?.overview?.region ?? "").trim();
    const resolvedRegion = rawRegion ? eventRegionOptionValue(rawRegion, eventRegions) : defaultRegion;
    if (!regionIds.has(resolvedRegion) || resolvedRegion === rawRegion) continue;
    if (cloneOnWrite) {
      if (!changed) next = [...rows];
      next[index] = { ...holding, overview: { ...holding.overview, region: resolvedRegion } };
    } else {
      holding.overview.region = resolvedRegion;
    }
    changed = true;
  }
  return { holdings: next, changed };
}

function migrateLegacySettlement(stored, options = {}) {
  const normalize = normalizeOptions(options);
  const legacyHolding = mergeHoldingDefaults({
    id: "legacy-skyhold",
    name: stored?.overview?.settlementName ?? "Остров-летяга",
    type: "sky-island",
    owner: "",
    visibility: "public",
    overview: {
      status: stored?.overview?.status ?? "Стабильно",
      period: stored?.overview?.week ? `Неделя ${stored.overview.week}` : "Неделя 1",
      description: stored?.overview?.description ?? "",
      publicNotes: stored?.overview?.publicNotes ?? "",
      population: Array.isArray(stored?.residents?.groups)
        ? stored.residents.groups.reduce((sum, row) => sum + Number(row.count || 0), 0)
        : 0
    },
    people: {
      notes: stored?.residents?.notes ?? "",
      list: (stored?.residents?.groups ?? []).map((row) => ({
        id: row.id ?? makeId("person"),
        name: row.name ?? "",
        role: row.type ?? "",
        skill: row.status ?? "",
        race: "",
        salary: 0,
        salaryModifier: 0,
        home: "",
        status: row.status ?? "",
        notes: row.notes ?? ""
      }))
    },
    buildings: {
      notes: stored?.buildings?.notes ?? "",
      list: stored?.buildings?.list ?? []
    },
    special: {
      notes: stored?.special?.notes ?? "",
      list: stored?.special?.list ?? []
    },
    storage: {
      notes: stored?.storage?.notes ?? "",
      resources: stored?.storage?.resources ?? [],
      items: stored?.storage?.items ?? [],
      log: stored?.storage?.log ?? []
    },
    gm: {
      notes: stored?.gm?.notes ?? "",
      lastRoll: stored?.gm?.lastRoll ?? null
    }
  }, normalize);

  return {
    meta: {
      schemaVersion: SKYHOLD_SCHEMA_VERSION,
      economyVersion: stored?.meta && Object.hasOwn(stored.meta, "economyVersion")
        ? Math.max(1, Math.floor(toNumber(stored.meta.economyVersion, 1)))
        : 1,
      templateCatalogVersion: TEMPLATE_CATALOG_VERSION,
      lastUpdated: stored?.meta?.lastUpdated ?? null,
      revision: Math.max(0, toNumber(stored?.meta?.revision, 0)),
      storageCommit: null
    },
    holdings: [legacyHolding],
    catalog: {
      buildings: clone(DEFAULT_BUILDING_TEMPLATES),
      deletedBuildingTemplateIds: [],
      resources: [],
      markets: [],
      marketEconomy: createDefaultMarketEconomy(normalizeEventRegionOptions(null)),
      marketRouteMap: normalizeMarketRouteMap(),
      eventRegions: normalizeEventRegionOptions(null),
      combatDoctrines: []
    }
  };
}


function mergeBuildingTemplateCatalog(rows = [], deletedIds = [], options = {}) {
  const normalize = normalizeOptions(options);
  const deleted = new Set((deletedIds ?? []).map((id) => String(id)));
  const map = new Map();
  const defaultIds = new Set();
  for (const template of DEFAULT_BUILDING_TEMPLATES) {
    const normalized = normalizeBuildingTemplate(template, normalize);
    const normalizedId = String(normalized.id);
    if (deleted.has(normalizedId)) continue;
    map.set(normalizedId, normalized);
    defaultIds.add(normalizedId);
  }
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? row.templateId ?? row.name ?? "").trim();
    if (!id || deleted.has(id)) continue;
    if (normalize.destructive && DEPRECATED_TEMPLATE_IDS?.has?.(id) && !defaultIds.has(id)) continue;
    const base = map.get(id) ?? {};
    const merged = mergeDefaults(base, row);
    migrateBuildingMaintenance(merged, normalize, { source: row });
    if (base?.templateVersion && toNumber(row.templateVersion, 0) < TEMPLATE_CATALOG_VERSION) {
      // 1.0.7: refresh curated catalog mechanics while keeping user-facing
      // notes/material edits from the stored template.
      merged.suitableWorkerTypes = base.suitableWorkerTypes;
      merged.workerTypeEffects = clone(base.workerTypeEffects ?? {});
      merged.workerPrimaryAttribute = base.workerPrimaryAttribute ?? "";
      merged.buildTarget = base.buildTarget;
      if (base.type === "Складские" && (!row.type || row.type === "Инфраструктура")) merged.type = base.type;
      if (["arsenal", "lazaret", "apothecary"].includes(id)) merged.requirements = clone(base.requirements ?? merged.requirements ?? {});
      if (row.visibility === undefined) merged.visibility = base.visibility ?? "public";
      merged.templateVersion = TEMPLATE_CATALOG_VERSION;
    }
    migrateFoodChainBuildingMechanics(merged, normalize);
    const migratedFreshFood = migrateFreshFoodAndHospitality(merged, normalize);
    migrateIndustrialChain(merged, normalize);
    migrateTextileChain(merged, normalize);
    migrateSettlementServices(merged, normalize, { source: row });
    const migratedSeasonLivestock = migrateSeasonsAndLivestockContents(merged, normalize, { source: row });
    migrateLivestockMarketAndLegacyInn(merged, normalize);
    migrateExpandedLivestockContents(merged, normalize, { source: row });
    migrateTavernProcessing(merged, normalize);
    migrateTavernCommonTable(merged, normalize);
    if (
      isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_SEASONS_AND_LIVESTOCK_CONTENTS)
      && ["pasture", "pigsty", "sheepfold"].includes(id)
      && !migratedSeasonLivestock
      && !Array.isArray(row?.contents)
    ) merged.contents = [];
    const migratedMarketDemand = migrateMarketDemand(merged, normalize);
    if (
      isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_FRESH_FOOD_SERVICES_REBALANCED)
      && id === "inn"
      && !migratedFreshFood
      && !isPlainObject(row?.income?.service)
    ) {
      merged.income = { ...(merged.income ?? {}), service: { ...(merged.income?.service ?? {}), enabled: false } };
    }
    if (
      isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_MARKET_DEMAND)
      && id === "market"
      && !migratedMarketDemand
      && row?.income?.trade?.demandModel === undefined
    ) {
      merged.income = {
        ...(merged.income ?? {}),
        trade: { ...(merged.income?.trade ?? {}), demandModel: "legacy" }
      };
    }
    map.set(id, normalizeBuildingTemplate(merged, normalize));
  }
  return Array.from(map.values());
}

function normalizeBuildingTemplate(template = {}, options = {}) {
  const normalize = normalizeOptions(options);
  const row = clone(template ?? {});
  normalizeBuilding(row, normalize);
  row.templateVersion = TEMPLATE_CATALOG_VERSION;
  row.unlocked = toBoolean(row.unlocked, true);
  row.visibility = row.visibility === "gm" ? "gm" : "public";
  row.primaryDev = ["food", "technology", "culture", "war"].includes(String(row.primaryDev ?? "")) ? String(row.primaryDev) : guessPrimaryDev(row);
  row.description = String(row.description ?? row.effect ?? row.notes ?? "");
  row.sourceRequirement = String(row.sourceRequirement ?? row.requirement ?? "");
  row.sourceRawMaterials = String(row.sourceRawMaterials ?? row.rawMaterials ?? "");
  row.specialRequirements = String(row.specialRequirements ?? "");
  row.compendiumId = String(row.compendiumId ?? "");
  return row;
}

function guessPrimaryDev(row = {}) {
  const bonuses = isPlainObject(row.bonuses) ? row.bonuses : {};
  const entries = ["food", "technology", "culture", "war"].map((key) => [key, toNumber(bonuses[key], 0)]);
  entries.sort((a, b) => b[1] - a[1]);
  if (entries[0]?.[1]) return entries[0][0];
  const text = `${row.name ?? ""} ${row.type ?? ""} ${row.effect ?? ""}`.toLowerCase();
  if (/еда|пищ|зерн|сад|пастбищ|мельниц|пекар|колод|погреб/.test(text)) return "food";
  if (/кузн|шахт|лес|камен|мастер|центр|пирс|маяк|голуб/.test(text)) return "technology";
  if (/храм|святилищ|библиот|рынок|баня|кладбищ|шпиль|зал/.test(text)) return "culture";
  if (/стен|башн|ров|решет|темниц|стрельбищ|лагерь|эшаф/.test(text)) return "war";
  return "technology";
}

function isDeprecatedFireplaceBuilding(building = {}) {
  const id = String(building?.id ?? "").toLowerCase();
  const templateId = String(building?.templateId ?? "").toLowerCase();
  const name = String(building?.name ?? "").trim().toLowerCase();
  return id === "fireplace" || templateId === "fireplace" || name === "\u043a\u0430\u043c\u0438\u043d";
}

function normalizeMarketCargoRow(row, fallbackRoomId = "outdoors") {
  if (!row || typeof row !== "object") return null;
  const sourceType = String(row.sourceType ?? (row.item ? "item" : "resource")) === "item" ? "item" : "resource";
  const qty = Math.max(0, toNumber(row.qty, 0));
  if (!qty) return null;
  const common = {
    offerId: String(row.offerId ?? ""),
    sourceType,
    name: String(row.name ?? "Товар"),
    providerId: String(row.providerId ?? ""),
    providerLabel: String(row.providerLabel ?? ""),
    qty,
    targetRoomId: String(row.targetRoomId ?? fallbackRoomId ?? "outdoors") || "outdoors"
  };
  if (sourceType === "item") {
    const item = normalizeStorageItemRow(row.item ?? row.itemData);
    return item ? { ...common, item } : null;
  }
  return {
    ...common,
    resourceId: String(row.resourceId ?? "custom"),
    unit: "ед.",
    img: String(row.img ?? ""),
    economyVersion: Math.max(1, Math.floor(toNumber(row.economyVersion, 1))),
    cargoClass: String(row.cargoClass ?? ""),
    cargoPoints: Math.max(1, Math.ceil(toNumber(row.cargoPoints, toNumber(row.load ?? row.weight, 0) * 10) || 1)),
    loadMode: String(row.loadMode ?? "manual") === "auto" ? "auto" : "manual",
    load: Math.max(0, toNumber(row.load ?? row.weight, 0)),
    packageMassKg: Math.max(0, toNumber(row.packageMassKg, 0)),
    packageVolumeL: Math.max(0, toNumber(row.packageVolumeL, 0))
  };
}

function retainNormalizedMarketOrders(orders = [], archiveLimit = 300) {
  const terminalStatuses = new Set(["delivered", "lost", "cancelled"]);
  const archived = orders.filter((order) => terminalStatuses.has(String(order?.status ?? "")));
  const retainedArchive = new Set(Number.isFinite(archiveLimit) ? archived.slice(-archiveLimit) : archived);
  return orders.filter((order) => !terminalStatuses.has(String(order?.status ?? "")) || retainedArchive.has(order));
}

function normalizeMarketStockLine(line = {}) {
  const offerId = String(line?.offerId ?? line?.id ?? "").trim();
  const qty = Math.max(0, Math.floor(toNumber(line?.qty, 0)));
  if (!offerId || qty <= 0) return null;
  return {
    offerId,
    sourceOfferId: String(line?.sourceOfferId ?? offerId).trim() || offerId,
    providerId: String(line?.providerId ?? "").trim(),
    qty
  };
}

function normalizeMarketStockReservations(reservations = []) {
  return (Array.isArray(reservations) ? reservations : []).map((row) => {
    const operationId = String(row?.operationId ?? "").trim();
    const marketId = String(row?.marketId ?? "external-market").trim() || "external-market";
    const quoteKey = String(row?.quoteKey ?? "").trim();
    if (!operationId || !quoteKey) return null;
    return {
      operationId,
      marketId,
      quoteKey,
      createdAt: String(row?.createdAt ?? ""),
      lines: (Array.isArray(row?.lines) ? row.lines : []).map(normalizeMarketStockLine).filter(Boolean),
      releases: (Array.isArray(row?.releases) ? row.releases : []).map((release) => {
        const releaseOperationId = String(release?.operationId ?? "").trim();
        if (!releaseOperationId) return null;
        return {
          operationId: releaseOperationId,
          releasedAt: String(release?.releasedAt ?? ""),
          lines: (Array.isArray(release?.lines) ? release.lines : []).map(normalizeMarketStockLine).filter(Boolean)
        };
      }).filter(Boolean)
    };
  }).filter((row) => row?.lines?.length);
}

function normalizeMarketLiquidityState(source = {}) {
  const row = isPlainObject(source) ? source : {};
  const lines = [];
  const seenLines = new Set();
  for (const sourceLine of Array.isArray(row.lines) ? row.lines : []) {
    if (!isPlainObject(sourceLine)) continue;
    const marketId = String(sourceLine.marketId ?? "").trim();
    const quoteKey = String(sourceLine.quoteKey ?? "").trim();
    const offerId = String(sourceLine.offerId ?? "").trim();
    if (!marketId || !quoteKey || !offerId) continue;
    const key = JSON.stringify([marketId, quoteKey, offerId]);
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    const askUnitCopper = Math.max(1, Math.round(toNumber(sourceLine.askUnitCopper ?? sourceLine.unitPriceCopper, 1)));
    lines.push({
      key,
      marketId,
      quoteKey,
      offerId,
      askUnitCopper,
      askStock: Math.max(0, Math.floor(toNumber(sourceLine.askStock ?? sourceLine.stock, 0))),
      baseAskStock: Math.max(0, Math.floor(toNumber(sourceLine.baseAskStock ?? sourceLine.baseStock ?? sourceLine.askStock, 0))),
      bidUnitCopper: Math.max(0, Math.min(askUnitCopper - 1, Math.round(toNumber(sourceLine.bidUnitCopper, 0)))),
      bidDemand: Math.max(0, Math.floor(toNumber(sourceLine.bidDemand, 0))),
      baseBidDemand: Math.max(0, Math.floor(toNumber(sourceLine.baseBidDemand ?? sourceLine.bidDemand, 0)))
    });
  }
  const lineKeys = new Set(lines.map((line) => line.key));
  const reservationIds = new Set();
  const reservations = [];
  for (const sourceReservation of Array.isArray(row.reservations) ? row.reservations : []) {
    if (!isPlainObject(sourceReservation)) continue;
    const id = String(sourceReservation.id ?? sourceReservation.reservationId ?? "").trim();
    const key = String(sourceReservation.key ?? "").trim();
    const side = String(sourceReservation.side ?? "") === "bid" ? "bid" : (String(sourceReservation.side ?? "") === "ask" ? "ask" : "");
    const quantity = Math.max(0, Math.floor(toNumber(sourceReservation.quantity, 0)));
    if (!id || !lineKeys.has(key) || !side || !quantity || reservationIds.has(id)) continue;
    reservationIds.add(id);
    const committedQuantity = Math.min(quantity, Math.max(0, Math.floor(toNumber(sourceReservation.committedQuantity, 0))));
    const cancelledQuantity = Math.min(quantity - committedQuantity, Math.max(0, Math.floor(toNumber(sourceReservation.cancelledQuantity, 0))));
    reservations.push({
      id,
      operationId: String(sourceReservation.operationId ?? ""),
      key,
      side,
      quantity,
      committedQuantity,
      cancelledQuantity,
      status: String(sourceReservation.status ?? (committedQuantity === quantity ? "committed" : (cancelledQuantity === quantity ? "cancelled" : "reserved")))
    });
  }
  const receiptOperations = new Set();
  const receipts = [];
  for (const sourceReceipt of Array.isArray(row.receipts) ? row.receipts : []) {
    if (!isPlainObject(sourceReceipt)) continue;
    const operationId = String(sourceReceipt.operationId ?? "").trim();
    const action = String(sourceReceipt.action ?? "").trim();
    const fingerprint = String(sourceReceipt.fingerprint ?? "").trim();
    if (!operationId || !action || !fingerprint || receiptOperations.has(operationId)) continue;
    receiptOperations.add(operationId);
    receipts.push(clone(sourceReceipt));
  }
  return { schemaVersion: 1, lines, reservations, receipts };
}

function normalizeMarketExportBook(source = {}, { archiveLimit = null, advanceRunLimit = null } = {}) {
  const row = isPlainObject(source) ? source : {};
  const orders = (Array.isArray(row.orders) ? row.orders : []).filter(isPlainObject).map((order) => clone(order));
  const terminal = new Set(["delivered", "lost", "cancelled"]);
  const archived = orders.filter((order) => terminal.has(String(order?.status ?? "")));
  const retainedArchive = new Set(Number.isFinite(archiveLimit) ? archived.slice(-archiveLimit) : archived);
  const advanceRuns = [];
  const operationIds = new Set();
  const normalizedAdvanceRuns = (Array.isArray(row.advanceRuns) ? row.advanceRuns : []).filter(isPlainObject);
  const retainedAdvanceRuns = Number.isFinite(advanceRunLimit) ? normalizedAdvanceRuns.slice(-advanceRunLimit) : normalizedAdvanceRuns;
  for (const run of retainedAdvanceRuns) {
    const operationId = String(run?.operationId ?? "").trim();
    if (!operationId || operationIds.has(operationId)) continue;
    operationIds.add(operationId);
    advanceRuns.push(clone(run));
  }
  return {
    version: 1,
    orders: orders.filter((order) => !terminal.has(String(order?.status ?? "")) || retainedArchive.has(order)),
    advanceRuns
  };
}

export function mergeHoldingDefaults(holding, options = {}) {
  const normalize = normalizeOptions(options);
  const type = HOLDING_TYPES[holding?.type] ? holding.type : "settlement";
  const base = {
    ...BASE_HOLDING,
    id: holding?.id || makeId("holding"),
    type
  };

  const merged = mergeDefaults(base, holding ?? {});
  merged.id = String(merged.id || makeId("holding"));
  merged.name = String(merged.name || "Новое владение");
  merged.type = HOLDING_TYPES[merged.type] ? merged.type : "settlement";
  merged.visibility = merged.visibility === "gm" ? "gm" : "public";
  const commonTableState = isPlainObject(merged?.gm?.economy?.commonTable)
    ? merged.gm.economy.commonTable
    : {};
  merged.gm.economy.commonTable = {
    ...commonTableState,
    activeMoraleBonus: toNumber(commonTableState.activeMoraleBonus, 0) > 0 ? 1 : 0,
    pendingMoraleBonus: toNumber(commonTableState.pendingMoraleBonus, 0) > 0 ? 1 : 0
  };
  const foodAllocationState = isPlainObject(merged?.gm?.economy?.foodAllocation)
    ? merged.gm.economy.foodAllocation
    : {};
  merged.gm.economy.foodAllocation = {
    cursorResidentId: String(foodAllocationState.cursorResidentId ?? ""),
    receipts: (() => {
      const rows = Array.isArray(foodAllocationState.receipts)
        ? foodAllocationState.receipts.filter((row) => isPlainObject(row) && String(row.operationId ?? "").trim())
        : [];
      return normalize.destructive ? rows.slice(-32) : rows;
    })()
  };
  if (!Array.isArray(merged.constructionCrewIds)) merged.constructionCrewIds = [];
  merged.constructionCrewIds = merged.constructionCrewIds.map((id) => String(id ?? "")).filter(Boolean);
  if (!Array.isArray(merged.constructionCrews)) merged.constructionCrews = [];
  if (!merged.constructionCrews.length && merged.constructionCrewIds.length) {
    merged.constructionCrews = [{ id: makeId("crew"), name: "Стройбригада", memberIds: merged.constructionCrewIds, leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец", distributed: false, distributedIds: [] }];
  }
  if (!merged.constructionCrews.length) {
    merged.constructionCrews = [{ id: makeId("crew"), name: "Стройбригада", memberIds: [], leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец", distributed: false, distributedIds: [] }];
  }
  merged.constructionCrews = merged.constructionCrews.map((crew, index) => normalizeConstructionCrew(crew, index));
  merged.constructionCrewIds = merged.constructionCrews[0]?.memberIds ?? [];

  if (!Array.isArray(merged.people.list)) merged.people.list = [];
  for (const person of merged.people.list) normalizePerson(person);
  if (!Array.isArray(merged.buildings.list)) merged.buildings.list = [];
  if (normalize.destructive && isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_DEPRECATED_FIREPLACE_REMOVED)) {
    merged.buildings.list = merged.buildings.list.filter((building) => !isDeprecatedFireplaceBuilding(building));
    for (const building of merged.buildings.list) {
      if (Array.isArray(building.requiredBuildingIds)) building.requiredBuildingIds = building.requiredBuildingIds.filter((id) => String(id) !== "fireplace");
    }
  }
  if (!isPlainObject(merged.overview.development)) merged.overview.development = {};
  merged.overview.development.food = toNumber(merged.overview.development.food, 0);
  merged.overview.development.technology = toNumber(merged.overview.development.technology, 0);
  merged.overview.development.culture = toNumber(merged.overview.development.culture, 0);
  merged.overview.development.war = toNumber(merged.overview.development.war, 0);

  for (const building of merged.buildings.list) {
    migrateFoodChainBuildingMechanics(building, normalize);
    migrateBuildingMaintenance(building, normalize, { source: building });
    migrateFreshFoodAndHospitality(building, normalize);
    migrateIndustrialChain(building, normalize);
    migrateTextileChain(building, normalize);
    migrateSettlementServices(building, normalize, { source: building });
    migrateSeasonsAndLivestockContents(building, normalize, { source: building, instance: true });
    migrateLivestockMarketAndLegacyInn(building, normalize);
    migrateExpandedLivestockContents(building, normalize, { source: building, instance: true });
    migrateTavernProcessing(building, normalize);
    migrateTavernCommonTable(building, normalize);
    migrateEnterpriseCapital(building, normalize, { instance: true });
    migrateEnterpriseCapitalV2(building, normalize, {
      landRightsProvided: toBoolean(merged?.gm?.economy?.landRightsProvided, false)
    });
    migrateMarketDemand(building, normalize);
    normalizeBuilding(building, normalize);
  }
  normalizeUniqueBuildingWorkers(merged);
  if (!Array.isArray(merged.special.list)) merged.special.list = [];
  merged.special.fleet = normalizeFleet(merged.special.fleet, { holdingId: merged.id, destructive: normalize.destructive });
  if (!isPlainObject(merged.special.market)) merged.special.market = {};
  merged.special.market.schemaVersion = 2;
  merged.special.market.preferredRoomId = String(merged.special.market.preferredRoomId ?? "outdoors") || "outdoors";
  if (!Array.isArray(merged.special.market.orders)) merged.special.market.orders = [];
  merged.special.market.stockReservations = normalizeMarketStockReservations(merged.special.market.stockReservations);
  merged.special.market.liquidity = normalizeMarketLiquidityState(merged.special.market.liquidity);
  merged.special.market.exportBook = normalizeMarketExportBook(merged.special.market.exportBook, {
    archiveLimit: normalize.destructive ? 300 : null,
    advanceRunLimit: normalize.destructive ? 300 : null
  });
  merged.special.market.orders = merged.special.market.orders
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const id = String(row.id ?? row.operationId ?? makeId("market-order"));
      const status = MARKET_ORDER_STATUSES.has(String(row.status ?? "")) ? String(row.status) : "delivered";
      const deliveryMode = String(row.deliveryMode ?? "") === "scheduled" || ["pending", "in-transit", "delayed"].includes(status) ? "scheduled" : "instant";
      const deliveryQd = deliveryMode === "scheduled" ? Math.max(1, toNumber(row.deliveryQd ?? row.etaQd, 1)) : 0;
      const targetRoomId = String(row.targetRoomId ?? "outdoors") || "outdoors";
      const riskStatus = MARKET_RISK_STATUSES.has(String(row.riskStatus ?? "")) ? String(row.riskStatus) : "waived";
      const riskOutcome = MARKET_RISK_OUTCOMES.has(String(row.riskOutcome ?? "")) ? String(row.riskOutcome) : (riskStatus === "pending" ? "pending" : "waived");
      const fallbackDispatchStatus = status === "delivered" ? "delivered" : (status === "lost" ? "lost" : (status === "cancelled" ? "cancelled" : "departed"));
      const dispatchStatus = MARKET_DISPATCH_STATUSES.has(String(row.dispatchStatus ?? "")) ? String(row.dispatchStatus) : fallbackDispatchStatus;
      return {
        ...row,
        id,
        operationId: String(row.operationId ?? id),
        parentOperationId: String(row.parentOperationId ?? row.operationId ?? id),
        batchIndex: Math.max(0, Math.floor(toNumber(row.batchIndex, 0))),
        batchCount: Math.max(1, Math.floor(toNumber(row.batchCount, 1))),
        deliveryOperationId: String(row.deliveryOperationId ?? ""),
        createdAt: String(row.createdAt ?? row.orderedAt ?? ""),
        orderedAt: String(row.orderedAt ?? row.createdAt ?? ""),
        deliveredAt: String(row.deliveredAt ?? ""),
        status,
        dispatchStatus,
        dispatchedAt: String(row.dispatchedAt ?? ""),
        deliveryMode,
        deliveryQd,
        standardDeliveryQd: deliveryMode === "scheduled" ? Math.max(1, toNumber(row.standardDeliveryQd, deliveryQd)) : 0,
        serviceLevel: deliveryMode === "scheduled" && ["standard", "express", "charter", "owned"].includes(String(row.serviceLevel ?? "")) ? String(row.serviceLevel) : "standard",
        etaQd: deliveryMode === "scheduled" ? Math.max(1, toNumber(row.etaQd ?? deliveryQd, deliveryQd)) : 0,
        remainingQd: ["delivered", "lost", "cancelled"].includes(status) ? 0 : Math.max(0, toNumber(row.remainingQd ?? deliveryQd, deliveryQd)),
        marketId: String(row.marketId ?? "external-market"),
        marketLabel: String(row.marketLabel ?? "Внешний рынок"),
        quoteKey: String(row.quoteKey ?? ""),
        locationId: String(row.locationId ?? "standard"),
        locationText: String(row.locationText ?? ""),
        targetRoomId,
        originRegionId: String(row.originRegionId ?? ""),
        destinationRegionId: String(row.destinationRegionId ?? ""),
        routeDistance: Math.max(0, toNumber(row.routeDistance, 0)),
        routeDistanceKm: Math.max(0, toNumber(row.routeDistanceKm, toNumber(row.routeDistance, 0) * 40)),
        routeHops: Math.max(0, Math.floor(toNumber(row.routeHops, 0))),
        routePath: Array.isArray(row.routePath) ? row.routePath.map((id) => String(id ?? "")).filter(Boolean).slice(0, 100) : [],
        transportMode: ["caravan", "rail", "airship", "multimodal"].includes(String(row.transportMode ?? "")) ? String(row.transportMode) : "",
        carrierId: String(row.carrierId ?? ""),
        carrierLabel: String(row.carrierLabel ?? ""),
        carrierCapacityFactor: Math.max(0.1, Math.min(5, toNumber(row.carrierCapacityFactor, 1))),
        carrierCapacityLoad: Math.max(0, toNumber(row.carrierCapacityLoad, 0)),
        carrierCapacityCargoPoints: Math.max(0, Math.floor(toNumber(row.carrierCapacityCargoPoints, toNumber(row.carrierCapacityLoad, 0) * 10))),
        carrierCapacityMassKg: Math.max(0, toNumber(row.carrierCapacityMassKg, toNumber(row.carrierCapacityLoad, 0) * 10)),
        carrierCapacityVolumeL: Math.max(0, toNumber(row.carrierCapacityVolumeL, toNumber(row.carrierCapacityLoad, 0) * 20)),
        bookingCapacityLoad: Math.max(0, toNumber(row.bookingCapacityLoad, row.carrierCapacityLoad)),
        bookingCapacityCargoPoints: Math.max(0, Math.floor(toNumber(row.bookingCapacityCargoPoints, toNumber(row.bookingCapacityLoad, row.carrierCapacityLoad) * 10))),
        bookingCapacityMassKg: Math.max(0, toNumber(row.bookingCapacityMassKg, toNumber(row.bookingCapacityLoad, row.carrierCapacityLoad) * 10)),
        bookingCapacityVolumeL: Math.max(0, toNumber(row.bookingCapacityVolumeL, toNumber(row.bookingCapacityLoad, row.carrierCapacityLoad) * 20)),
        chargedCapacityShare: Math.max(0, toNumber(row.chargedCapacityShare, 0)),
        totalLoad: Math.max(0, toNumber(row.totalLoad, 0)),
        totalCargoPoints: Math.max(0, Math.ceil(toNumber(row.totalCargoPoints, toNumber(row.totalLoad, 0) * 10))),
        totalMassKg: Math.max(0, toNumber(row.totalMassKg, toNumber(row.totalLoad, 0) * 10)),
        totalVolumeL: Math.max(0, toNumber(row.totalVolumeL, toNumber(row.totalLoad, 0) * 20)),
        billableLoad: Math.max(0, toNumber(row.billableLoad, row.totalLoad)),
        merchantProviderIds: Array.isArray(row.merchantProviderIds) ? row.merchantProviderIds.map((id) => String(id ?? "")).filter(Boolean).slice(0, 100) : [],
        accessLevel: Math.max(0, Math.floor(toNumber(row.accessLevel, 0))),
        requiredAccessLevel: Math.max(0, Math.floor(toNumber(row.requiredAccessLevel, 0))),
        routeCopper: Math.max(0, toNumber(row.routeCopper, 0)),
        taxCopper: Math.max(0, toNumber(row.taxCopper, 0)),
        handlingCopper: Math.max(0, toNumber(row.handlingCopper, 0)),
        expressSurchargeCopper: Math.max(0, toNumber(row.expressSurchargeCopper, 0)),
        insuranceCopper: Math.max(0, toNumber(row.insuranceCopper, 0)),
        insuranceCoverageRate: Math.max(0, Math.min(1, toNumber(row.insuranceCoverageRate, 0))),
        insuredValueCopper: Math.max(0, Math.floor(toNumber(row.insuredValueCopper ?? row.subtotalCopper, 0))),
        maximumInsurancePayoutCopper: Math.max(0, Math.floor(toNumber(row.maximumInsurancePayoutCopper, 0))),
        insurancePayoutCopper: Math.max(0, Math.floor(toNumber(row.insurancePayoutCopper, 0))),
        insuranceOperationId: String(row.insuranceOperationId ?? ""),
        insurancePaidAt: String(row.insurancePaidAt ?? ""),
        riskFactor: Math.max(0.25, Math.min(4, toNumber(row.riskFactor, 1))),
        riskLossChance: Math.max(0, Math.min(0.08, toNumber(row.riskLossChance, 0))),
        riskDelayChance: Math.max(0, Math.min(0.45, toNumber(row.riskDelayChance, 0))),
        riskMaxDelayQd: Math.max(1, Math.min(20, Math.ceil(toNumber(row.riskMaxDelayQd, 1)))),
        riskResolutionId: String(row.riskResolutionId ?? ""),
        riskResolutionVersion: Math.max(1, Math.floor(toNumber(row.riskResolutionVersion, 1))),
        riskStatus,
        riskOutcome,
        riskResolvedAt: String(row.riskResolvedAt ?? ""),
        riskLossRoll: row.riskLossRoll === null || row.riskLossRoll === undefined ? null : Math.max(0, Math.min(1, toNumber(row.riskLossRoll, 1))),
        riskDelayRoll: row.riskDelayRoll === null || row.riskDelayRoll === undefined ? null : Math.max(0, Math.min(1, toNumber(row.riskDelayRoll, 1))),
        delayQd: Math.max(0, Math.min(20, Math.ceil(toNumber(row.delayQd, 0)))),
        delayRemainingQd: status === "delayed" ? Math.max(0, Math.min(20, Math.ceil(toNumber(row.delayRemainingQd ?? row.delayQd, 0)))) : 0,
        delayedAt: String(row.delayedAt ?? ""),
        lostAt: String(row.lostAt ?? ""),
        cancelledAt: String(row.cancelledAt ?? ""),
        cancellationOperationId: String(row.cancellationOperationId ?? ""),
        cancellationRefundCopper: Math.max(0, Math.floor(toNumber(row.cancellationRefundCopper, 0))),
        cancellationWithheldCopper: Math.max(0, Math.floor(toNumber(row.cancellationWithheldCopper, 0))),
        subtotalCopper: Math.max(0, toNumber(row.subtotalCopper, 0)),
        deliveryCopper: Math.max(0, toNumber(row.deliveryCopper, 0)),
        totalCopper: Math.max(0, toNumber(row.totalCopper, 0)),
        lines: Array.isArray(row.lines) ? row.lines.map((line) => ({
          offerId: String(line?.offerId ?? ""),
          sourceOfferId: String(line?.sourceOfferId ?? line?.offerId ?? ""),
          sourceType: String(line?.sourceType ?? (line?.itemUuid ? "item" : "resource")) === "item" ? "item" : "resource",
          resourceId: String(line?.resourceId ?? "custom"),
          itemUuid: String(line?.itemUuid ?? ""),
          providerId: String(line?.providerId ?? ""),
          providerLabel: String(line?.providerLabel ?? ""),
          name: String(line?.name ?? "Товар"),
          qty: Math.max(0, toNumber(line?.qty, 0)),
          unitPriceCopper: Math.max(0, toNumber(line?.unitPriceCopper, 0)),
          economyVersion: Math.max(1, Math.floor(toNumber(line?.economyVersion, 1))),
          cargoClass: String(line?.cargoClass ?? ""),
          unitCargoPoints: Math.max(0, Math.ceil(toNumber(line?.unitCargoPoints, toNumber(line?.load, 0) * 10))),
          totalCargoPoints: Math.max(0, Math.ceil(toNumber(line?.totalCargoPoints, toNumber(line?.unitCargoPoints, toNumber(line?.load, 0) * 10) * toNumber(line?.qty, 0))))
        })).filter((line) => line.qty > 0) : [],
        cargo: Array.isArray(row.cargo) ? row.cargo.map((cargo) => normalizeMarketCargoRow(cargo, targetRoomId)).filter(Boolean) : []
      };
    });
  merged.special.market.orders = retainNormalizedMarketOrders(merged.special.market.orders, normalize.destructive ? 300 : null);
  if (!Array.isArray(merged.storage.resources)) merged.storage.resources = [];
  if (!Array.isArray(merged.storage.items)) merged.storage.items = [];
  merged.storage.moneyCopper = Math.max(0, toNumber(merged.storage.moneyCopper ?? merged.storage.money ?? merged.storage.coinsCopper ?? 0, 0));
  const currentStorageQd = Math.max(0, toNumber(merged?.gm?.calendaria?.lastQd, 0));
  const normalizedResources = merged.storage.resources.map((row) => normalizeResourceRow(row, {
    currentQd: currentStorageQd,
    // This also reconciles direct quantity edits made by the storage UI:
    // reductions consume FIFO, increases become a fresh lot at the current QD.
    seedPerishableLots: true
  }));
  const regularResources = [];
  for (const row of normalizedResources) {
    if (normalizeResourceId(row.resourceId, row.name) === "money") merged.storage.moneyCopper += toNumber(row.qty, 0);
    else regularResources.push(row);
  }
  merged.storage.resources = regularResources;
  merged.storage.rationBuffer = normalizeRationBuffer(merged.storage.rationBuffer);
  merged.storage.items = merged.storage.items.map((row) => normalizeStorageItemRow(row)).filter(Boolean);
  if (!Array.isArray(merged.storage.log)) merged.storage.log = [];
  merged.storage.log = merged.storage.log.map((row) => normalizeStorageLogRow(row)).filter(Boolean);
  if (normalize.destructive) merged.storage.log = merged.storage.log.slice(-250);
  merged.log = normalizeHoldingOperationLog(merged.log, { limit: normalize.destructive ? 250 : null });
  if (!isPlainObject(merged.gm)) merged.gm = {};
  merged.gm.playersCanUseStorage = toBoolean(merged.gm.playersCanUseStorage, false);
  merged.gm.playersCanEditOverview = toBoolean(merged.gm.playersCanEditOverview, true);
  merged.gm.playersCanEditBuildings = toBoolean(merged.gm.playersCanEditBuildings, false);
  merged.gm.playersCanEditResidents = toBoolean(merged.gm.playersCanEditResidents, false);
  merged.gm.playersCanEditDefense = toBoolean(merged.gm.playersCanEditDefense, false);
  merged.gm.playersCanEditBattle = toBoolean(merged.gm.playersCanEditBattle, false);
  merged.gm.playersCanEditSpecial = toBoolean(merged.gm.playersCanEditSpecial, false);
  merged.gm.playersCanManageMarkets = toBoolean(merged.gm.playersCanManageMarkets, false);
  merged.gm.loadingImage = String(merged.gm.loadingImage ?? "");
  merged.gm.eventTables = normalizeRandomEventTables(holding?.gm?.eventTables);
  merged.gm.eventHistory = normalizeEventHistory(holding?.gm?.eventHistory, { limit: normalize.destructive ? 80 : null });
  merged.gm.eventSchedule = normalizeEventSchedule(holding?.gm?.eventSchedule, { limit: normalize.destructive ? 80 : null });
  merged.gm.eventArchive = normalizeEventArchive(holding?.gm?.eventArchive, { limit: normalize.destructive ? 160 : null });
  merged.gm.lastRoll = normalizeLastEventRoll(holding?.gm?.lastRoll ?? merged.gm.lastRoll);
  merged.gm.eventTagThresholds = normalizeEventTagThresholds(holding?.gm?.eventTagThresholds ?? merged.gm.eventTagThresholds);
  if (!isPlainObject(merged.gm.modifiers)) merged.gm.modifiers = {};
  for (const key of ["food", "technology", "culture", "war", "defense", "reputation", "morale"]) merged.gm.modifiers[key] = toNumber(merged.gm.modifiers[key], 0);
  merged.gm.modifiers.marketConnectionsLevel = Math.max(0, Math.floor(toNumber(merged.gm.modifiers.marketConnectionsLevel, 1)));
  if (!isPlainObject(merged.gm.efficiencyModifiers)) merged.gm.efficiencyModifiers = {};
  for (const key of ["all", "production", "constructionCrew"]) merged.gm.efficiencyModifiers[key] = toNumber(merged.gm.efficiencyModifiers[key], 0);
  if (!isPlainObject(merged.gm.defense)) merged.gm.defense = {};
  merged.gm.defense.militiaTrained = toBoolean(merged.gm.defense.militiaTrained, false);
  merged.gm.defense.militiaEquipped = toBoolean(merged.gm.defense.militiaEquipped, false);
  merged.gm.defense.militiaLeader = toBoolean(merged.gm.defense.militiaLeader, false);
  merged.gm.defense.commanderId = String(merged.gm.defense.commanderId ?? "");
  merged.gm.defense.victorySound = String(merged.gm.defense.victorySound ?? "");
  merged.gm.defense.defeatSound = String(merged.gm.defense.defeatSound ?? "");
  merged.gm.defense.drawSound = String(merged.gm.defense.drawSound ?? "");
  merged.gm.defense.notes = String(merged.gm.defense.notes ?? "");
  if (!Array.isArray(merged.gm.defense.squads)) merged.gm.defense.squads = [];
  merged.gm.defense.squads = merged.gm.defense.squads.map((row) => normalizeDefenseSquad(row)).filter(Boolean);
  if (!isPlainObject(merged.gm.calendaria)) merged.gm.calendaria = {};
  merged.gm.calendaria.enabled = toBoolean(merged.gm.calendaria.enabled, false);
  merged.gm.calendaria.lastTimestamp = merged.gm.calendaria.lastTimestamp === null || merged.gm.calendaria.lastTimestamp === undefined ? null : toNumber(merged.gm.calendaria.lastTimestamp, null);
  merged.gm.calendaria.lastDateKey = String(merged.gm.calendaria.lastDateKey ?? "");
  merged.gm.calendaria.lastDateText = String(merged.gm.calendaria.lastDateText ?? merged.gm.calendaria.lastDateKey ?? "");
  merged.gm.calendaria.lastDateTime = isPlainObject(merged.gm.calendaria.lastDateTime) ? merged.gm.calendaria.lastDateTime : null;
  merged.gm.calendaria.lastQd = Math.max(0, toNumber(merged.gm.calendaria.lastQd, 0));
  if (!isPlainObject(merged.gm.economy)) merged.gm.economy = {};
  merged.gm.economy.landRightsProvided = toBoolean(merged.gm.economy.landRightsProvided, false);
  if (!isPlainObject(merged.gm.economy.labor)) merged.gm.economy.labor = {};
  merged.gm.economy.labor.wageIndex = normalizeWageIndex(merged.gm.economy.labor.wageIndex);
  merged.gm.economy.labor.payroll = normalizePayrollState(merged.gm.economy.labor.payroll);
  if (!isPlainObject(merged.gm.economy.treasury)) merged.gm.economy.treasury = {};
  merged.gm.economy.treasury.upkeepThirdRemainder = Math.max(0, Math.min(2, Math.floor(toNumber(merged.gm.economy.treasury.upkeepThirdRemainder, 0))));
  merged.gm.economy.treasury.salaryArrearsCopper = Math.max(0, Math.floor(toNumber(merged.gm.economy.treasury.salaryArrearsCopper, 0)));
  merged.gm.economy.treasury.upkeepArrearsCopper = Math.max(0, Math.floor(toNumber(merged.gm.economy.treasury.upkeepArrearsCopper, 0)));
  merged.gm.economy.treasury.upkeepOverdueTendays = Math.max(0, Math.floor(toNumber(merged.gm.economy.treasury.upkeepOverdueTendays, 0)));

  merged.gm.massCombat = normalizeMassCombatState(holding?.gm?.massCombat, normalize);

  return merged;
}
