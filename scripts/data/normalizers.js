import { DEFAULT_BUILDING_TEMPLATES, DEPRECATED_TEMPLATE_IDS, TEMPLATE_CATALOG_VERSION } from "./building-templates.js";
import { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
import { BASE_HOLDING, HOLDING_TYPES } from "./schema/base-holding.js";
import { SKYHOLD_SCHEMA_VERSION } from "./schema-version.js";
import { normalizeResourceCatalogRow, normalizeResourceRow, normalizeResourceId, storageResourceKey, withResourceCatalog } from "../core/resources.js";
import {
  addResourceBatches,
  protectedResourceBatchIds,
  syncResourceRowBatches
} from "../core/resource-batches.js";
import { clone, isPlainObject, makeId, mergeDefaults, toBoolean, toNumber } from "./utils.js";
import { politicsCultureThreshold } from "./politics-availability.js";
import { normalizePoliticsState } from "./politics-state.js";
import { eventRegionOptionValue, normalizeEventRegionOptions, normalizeEventTagThresholds, normalizeRandomEventTables } from "./random-events.js";
import { normalizeDefenseSquad, normalizeMassCombatState } from "./normalizers/combat.js";
import { normalizeStorageItemRow, normalizeStorageLogRow } from "./normalizers/storage.js";
import { normalizeBuilding, normalizeUniqueBuildingWorkers } from "./normalizers/building.js";
import { normalizeEventArchive, normalizeEventHistory, normalizeEventSchedule, normalizeHoldingOperationLog, normalizeLastEventRoll } from "./normalizers/events.js";
import { clearBuildingReferences, clearPersonReferences, normalizeConstructionCrew, normalizePerson } from "./normalizers/resident.js";
import { normalizeContentDoctrines } from "./content-packs.js";
import { createDefaultMarketEconomy, normalizeMarketEconomy } from "./market/economy.js";
import { normalizeMarketRouteMap } from "./market/route-map.js";
import { normalizeMarketStockState } from "./market/stock-state.js";
import { normalizeMarketDemandState } from "./market/demand-state.js";
import { normalizeMarketOutboundState } from "./market/outbound-state.js";
import { savedMarketTransportPlanFields } from "./market/transport-plan.js";
import { normalizeFinanceObligationsState } from "./finance/obligations.js";
import { normalizeInternalDemandConfig } from "./economy/internal-demand.js";
import { normalizeShipsState } from "./ships.js";

export { clearBuildingReferences, clearPersonReferences };

export { SKYHOLD_SCHEMA_VERSION };

function remapOutboundStorageRowId(holding, fromRowId = "", toRowId = "") {
  const sourceId = String(fromRowId ?? "").trim();
  const targetId = String(toRowId ?? "").trim();
  if (!sourceId || !targetId || sourceId === targetId) return;
  for (const order of holding?.special?.market?.outbound?.orders ?? []) {
    for (const field of ["cargoReservations", "cargo"]) {
      for (const cargo of Array.isArray(order?.[field]) ? order[field] : []) {
        if (String(cargo?.rowId ?? cargo?.storageRowId ?? "") !== sourceId) continue;
        cargo.rowId = targetId;
        if (Object.prototype.hasOwnProperty.call(cargo, "storageRowId")) cargo.storageRowId = targetId;
      }
    }
  }
}
const SCHEMA_VERSION_DEPRECATED_FIREPLACE_REMOVED = 46;
const MARKET_ORDER_STATUSES = new Set(["pending", "in-transit", "delivered", "delayed", "needsResolution", "lost", "cancelled"]);
const MARKET_DISPATCH_STATUSES = new Set(["booked", "departed", "delivered", "lost", "cancelled"]);
const MARKET_RISK_STATUSES = new Set(["pending", "needsResolution", "resolved", "waived"]);
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

function signedInteger(value, fallback = 0, minimum = -1000, maximum = 1000) {
  const parsed = Number(value);
  const integer = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
  return Math.max(minimum, Math.min(maximum, integer));
}

function normalizeMoraleSnapshot(value, people = []) {
  if (!isPlainObject(value)) return null;
  const livingIds = new Set((people ?? []).filter((person) => !person?.dead).map((person) => String(person?.id ?? "")).filter(Boolean));
  const residents = {};
  const sourceResidents = isPlainObject(value.residents) ? value.residents : {};
  for (const [residentId, row] of Object.entries(sourceResidents)) {
    const id = String(residentId ?? "").trim();
    if (!id || !livingIds.has(id) || !isPlainObject(row)) continue;
    const ration = isPlainObject(row.ration) ? row.ration : {};
    const tier = ["enhanced", "normal", "sparse", "hunger"].includes(String(ration.tier ?? "")) ? String(ration.tier) : "normal";
    const work = isPlainObject(row.work) ? row.work : {};
    residents[id] = {
      ration: {
        value: Math.max(-2, Math.min(3, toNumber(ration.value, tier === "enhanced" ? 1 : tier === "sparse" ? -1 : tier === "hunger" ? -2 : 0))),
        diversityBonus: Math.max(0, Math.min(2, toNumber(ration.diversityBonus, 0))),
        tier
      },
      work: {
        value: signedInteger(work.value, 0, -3, 3),
        conditions: signedInteger(work.conditions, 0, -3, 3),
        pay: signedInteger(work.pay, 0, -2, 2),
        overtime: signedInteger(work.overtime, 0, -2, 0),
        totalQd: Math.max(0, Math.floor(toNumber(work.totalQd, 0))),
        overtimeQd: Math.max(0, Math.floor(toNumber(work.overtimeQd, 0))),
        reason: String(work.reason ?? "").slice(0, 2000)
      }
    };
  }
  const ration = isPlainObject(value.ration) ? value.ration : {};
  const rootTier = ["enhanced", "normal", "sparse", "hunger"].includes(String(ration.tier ?? "")) ? String(ration.tier) : "normal";
  const normalized = {
    schema: 1,
    operationId: String(value.operationId ?? ""),
    periodKey: String(value.periodKey ?? ""),
    createdAt: String(value.createdAt ?? ""),
    ration: {
      tier: rootTier,
      modifier: Math.max(-2, Math.min(3, toNumber(ration.modifier, rootTier === "enhanced" ? 1 : rootTier === "sparse" ? -1 : rootTier === "hunger" ? -2 : 0))),
      diversityBonus: Math.max(0, Math.min(2, toNumber(ration.diversityBonus, 0))),
      effectiveUnits: Math.max(0, Math.min(15, toNumber(ration.effectiveUnits, 10)))
    },
    residents
  };
  if (Object.prototype.hasOwnProperty.call(value, "rawMorale")) normalized.rawMorale = signedInteger(value.rawMorale);
  if (isPlainObject(value.control)) normalized.control = clone(value.control);
  return normalized;
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
  return migrateData(stored, { mode: "load", destructive: false, ...options });
}

export function repairSkyholdData(stored, options = {}) {
  return migrateData(stored, { mode: "repair", destructive: true, ...options });
}

export function migrateData(stored, options = {}) {
  const normalize = normalizeMigrationOptions(stored, options);
  if (!stored || typeof stored !== "object") return migrateData(clone(DEFAULT_SKYHOLD_DATA), normalize);

  if (Array.isArray(stored.holdings)) {
    const storedTemplateVersion = Math.max(0, Math.floor(toNumber(stored?.meta?.templateCatalogVersion, 0)));
    // The two large runtime partitions are normalized independently below.
    const migrated = mergeDefaults(DEFAULT_SKYHOLD_DATA, { ...stored, holdings: [], catalog: {} });
    migrated.meta.schemaVersion = SKYHOLD_SCHEMA_VERSION;
    migrated.catalog = normalizeCatalogPartition(stored.catalog, normalize);
    migrated.holdings = normalizeHoldingsPartition(stored.holdings, migrated.catalog, normalize);
    // Catalog mechanics are migrated only by the explicit Preview/Apply
    // workflow. Loading preserves the saved catalog and its version, including
    // an unknown legacy version; defaults are supplied by new-world creation.
    migrated.meta.templateCatalogVersion = storedTemplateVersion;
    migrated.meta.revision = Math.max(0, toNumber(migrated.meta.revision, 0));
    return migrated;
  }

  return migrateLegacySettlement(stored, normalize);
}

export function normalizeCatalogPartition(storedCatalog, options = {}) {
  return withResourceCatalog(storedCatalog?.resources, () => normalizeCatalogWithResources(storedCatalog, options));
}

function normalizeCatalogWithResources(storedCatalog, options = {}) {
  const normalize = normalizeOptions(options);
  const stored = isPlainObject(storedCatalog) ? storedCatalog : {};
  const catalog = mergeDefaults(DEFAULT_SKYHOLD_DATA.catalog, stored);
  // A missing or empty saved list is not consent to install today's catalog.
  // New worlds already pass DEFAULT_SKYHOLD_DATA.catalog explicitly.
  catalog.buildings = Array.isArray(stored.buildings) ? clone(stored.buildings) : [];
  if (!Array.isArray(catalog.deletedBuildingTemplateIds)) catalog.deletedBuildingTemplateIds = [];
  catalog.buildings = mergeBuildingTemplateCatalog(catalog.buildings, catalog.deletedBuildingTemplateIds, normalize);
  if (!Array.isArray(catalog.resources)) catalog.resources = [];
  catalog.resources = catalog.resources.map((row) => normalizeResourceCatalogRow(row));
  catalog.marketRouteMap = normalizeMarketRouteMap(catalog.marketRouteMap);
  catalog.eventRegions = normalizeEventRegionOptions(catalog.eventRegions, { fallback: !Array.isArray(stored.eventRegions) });
  catalog.markets = [];
  const hasStoredMarketEconomy = Boolean(stored.marketEconomy && typeof stored.marketEconomy === "object");
  catalog.marketEconomy = hasStoredMarketEconomy
    ? normalizeMarketEconomy(stored.marketEconomy, { locations: catalog.eventRegions })
    : createDefaultMarketEconomy(catalog.eventRegions);
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
    ? withResourceCatalog(catalog?.resources, () => storedHoldings.map((holding) => mergeHoldingDefaults(holding, normalize)))
    : [];
  reconcileHoldingRegions(holdings, catalog);
  return holdings;
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
      templateCatalogVersion: normalize.destructive ? TEMPLATE_CATALOG_VERSION : Math.max(0, Math.floor(toNumber(stored?.meta?.templateCatalogVersion, 0))),
      lastUpdated: stored?.meta?.lastUpdated ?? null,
      revision: Math.max(0, toNumber(stored?.meta?.revision, 0)),
      storageCommit: null
    },
    holdings: [legacyHolding],
    catalog: normalizeCatalogPartition(stored?.catalog, normalize)
  };
}


function mergeBuildingTemplateCatalog(rows = [], deletedIds = [], options = {}) {
  const normalize = normalizeOptions(options);
  const deleted = new Set((deletedIds ?? []).map((id) => String(id)));
  const map = new Map();
  for (const template of normalize.destructive ? DEFAULT_BUILDING_TEMPLATES : []) {
    const normalized = normalizeBuildingTemplate(template, normalize);
    const normalizedId = String(normalized.id);
    if (deleted.has(normalizedId)) continue;
    map.set(normalizedId, normalized);
  }
  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id ?? row.templateId ?? row.name ?? "").trim();
    if (!id || deleted.has(id)) continue;
    if (normalize.destructive && DEPRECATED_TEMPLATE_IDS.has(id) && !map.has(id)) continue;
    const base = map.get(id) ?? {};
    const merged = mergeDefaults(base, row);
    map.set(id, normalizeBuildingTemplate(merged, normalize));
  }
  return Array.from(map.values());
}

function normalizeBuildingTemplate(template = {}, options = {}) {
  const normalize = normalizeOptions(options);
  const row = clone(template ?? {});
  normalizeBuilding(row, { ...normalize, preserveTemplateMechanics: !normalize.destructive });
  row.templateVersion = Math.max(0, Math.floor(toNumber(row.templateVersion, 0)));
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
    ageQd: Math.max(0, Math.floor(toNumber(row.ageQd, 0))),
    ...(row.shelfLifeQd !== undefined ? { shelfLifeQd: Math.max(0, Math.floor(toNumber(row.shelfLifeQd, 0))) } : {}),
    spoiledQty: Math.min(qty, Math.max(0, Math.floor(toNumber(row.spoiledQty, 0)))),
    unitPriceCopper: Math.max(0, Math.floor(toNumber(row.unitPriceCopper, 0))),
    resourceId: String(row.resourceId ?? "custom"),
    unit: "ед.",
    img: String(row.img ?? ""),
    load: Math.max(0, toNumber(row.load ?? row.weight, 0))
  };
}

function retainNormalizedMarketOrders(orders = [], archiveLimit = 300) {
  const terminalStatuses = new Set(["delivered", "lost", "cancelled"]);
  const archived = orders.filter((order) => terminalStatuses.has(String(order?.status ?? "")));
  const retainedArchive = new Set(archived.slice(-archiveLimit));
  return orders.filter((order) => !terminalStatuses.has(String(order?.status ?? "")) || retainedArchive.has(order));
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
  const peopleById = new Map(merged.people.list.map((person) => [String(person?.id ?? ""), person]));
  for (const crew of merged.constructionCrews) {
    const leaderId = String(crew?.leaderId ?? "");
    const leader = peopleById.get(leaderId);
    if (leader) {
      leader.workAssignment = `construction-leader:${crew.id}`;
      leader.workAllocationMode = "legacy";
      leader.role = `Руководитель: ${crew.name || "Стройбригада"}`;
    }
    for (const memberId of crew?.memberIds ?? []) {
      const member = peopleById.get(String(memberId ?? ""));
      if (!member) continue;
      member.workAssignment = `construction:${crew.id}`;
      member.workAllocationMode = "legacy";
      member.role = crew.name || "Стройбригада";
    }
  }
  if (!Array.isArray(merged.buildings.list)) merged.buildings.list = [];
  if (isBeforeSkyholdSchemaVersion(normalize, SCHEMA_VERSION_DEPRECATED_FIREPLACE_REMOVED)) {
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

  for (const building of merged.buildings.list) normalizeBuilding(building, { ...normalize, preserveTemplateMechanics: !normalize.destructive, people: merged.people.list });
  normalizeUniqueBuildingWorkers(merged);
  if (!Array.isArray(merged.special.list)) merged.special.list = [];
  merged.special.ships = normalizeShipsState(merged.special.ships);
  if (!isPlainObject(merged.special.market)) merged.special.market = {};
  merged.special.market.preferredRoomId = String(merged.special.market.preferredRoomId ?? "outdoors") || "outdoors";
  merged.special.market.stock = normalizeMarketStockState(merged.special.market.stock);
  merged.special.market.demand = normalizeMarketDemandState(merged.special.market.demand);
  merged.special.market.outbound = normalizeMarketOutboundState(merged.special.market.outbound);
  if (!Array.isArray(merged.special.market.orders)) merged.special.market.orders = [];
  merged.special.market.orders = merged.special.market.orders
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const id = String(row.id ?? row.operationId ?? makeId("market-order"));
      let status = MARKET_ORDER_STATUSES.has(String(row.status ?? "")) ? String(row.status) : "delivered";
      const deliveryMode = String(row.deliveryMode ?? "") === "scheduled" || ["pending", "in-transit", "delayed", "needsResolution"].includes(status) ? "scheduled" : "instant";
      const deliveryQd = deliveryMode === "scheduled" ? Math.max(1, toNumber(row.deliveryQd ?? row.etaQd, 1)) : 0;
      const targetRoomId = String(row.targetRoomId ?? "outdoors") || "outdoors";
      const riskStatus = MARKET_RISK_STATUSES.has(String(row.riskStatus ?? ""))
        ? String(row.riskStatus)
        : (status === "needsResolution" ? "needsResolution" : "waived");
      if (riskStatus === "needsResolution" && ["pending", "in-transit", "delayed", "needsResolution"].includes(status)) status = "needsResolution";
      const riskOutcome = MARKET_RISK_OUTCOMES.has(String(row.riskOutcome ?? "")) ? String(row.riskOutcome) : (["pending", "needsResolution"].includes(riskStatus) ? "pending" : "waived");
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
        serviceLevel: deliveryMode === "scheduled" && ["standard", "express", "charter"].includes(String(row.serviceLevel ?? "")) ? String(row.serviceLevel) : "standard",
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
        ...savedMarketTransportPlanFields(row),
        transportMode: ["caravan", "rail", "airship", "multimodal"].includes(String(row.transportMode ?? "")) ? String(row.transportMode) : "",
        carrierId: String(row.carrierId ?? ""),
        carrierLabel: String(row.carrierLabel ?? ""),
        carrierCapacityFactor: Math.max(0.1, Math.min(5, toNumber(row.carrierCapacityFactor, 1))),
        carrierCapacityLoad: Math.max(0, toNumber(row.carrierCapacityLoad, 0)),
        bookingCapacityLoad: Math.max(0, toNumber(row.bookingCapacityLoad, row.carrierCapacityLoad)),
        chargedCapacityShare: Math.max(0, toNumber(row.chargedCapacityShare, 0)),
        totalLoad: Math.max(0, toNumber(row.totalLoad, 0)),
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
        riskSeed: String(row.riskSeed ?? ""),
        riskResolutionId: String(row.riskResolutionId ?? ""),
        riskResolutionVersion: Math.max(1, Math.floor(toNumber(row.riskResolutionVersion, 1))),
        riskStatus,
        riskOutcome,
        riskProposedAt: String(row.riskProposedAt ?? ""),
        riskProposal: isPlainObject(row.riskProposal) && ["delayed", "lost"].includes(String(row.riskProposal.outcome ?? "")) ? {
          id: String(row.riskProposal.id ?? row.riskResolutionId ?? ""),
          outcome: String(row.riskProposal.outcome),
          proposedAt: String(row.riskProposal.proposedAt ?? row.riskProposedAt ?? ""),
          lossRoll: Math.max(0, Math.min(1, toNumber(row.riskProposal.lossRoll, 1))),
          lossChance: Math.max(0, Math.min(0.08, toNumber(row.riskProposal.lossChance, row.riskLossChance))),
          delayRoll: Math.max(0, Math.min(1, toNumber(row.riskProposal.delayRoll, 1))),
          delayChance: Math.max(0, Math.min(0.45, toNumber(row.riskProposal.delayChance, row.riskDelayChance))),
          delayDurationRoll: Math.max(0, Math.min(1, toNumber(row.riskProposal.delayDurationRoll, 0))),
          maxDelayQd: Math.max(1, Math.min(20, Math.ceil(toNumber(row.riskProposal.maxDelayQd, row.riskMaxDelayQd)))),
          delayQd: Math.max(1, Math.min(20, Math.ceil(toNumber(row.riskProposal.delayQd, 1)))),
          insuredValueCopper: Math.max(0, Math.floor(toNumber(row.riskProposal.insuredValueCopper, row.insuredValueCopper))),
          insuranceCoverageRate: Math.max(0, Math.min(1, toNumber(row.riskProposal.insuranceCoverageRate, row.insuranceCoverageRate))),
          maximumInsurancePayoutCopper: Math.max(0, Math.floor(toNumber(row.riskProposal.maximumInsurancePayoutCopper, row.maximumInsurancePayoutCopper))),
          ...(row.riskProposal.potentialInsurancePayoutCopper != null ? {
            potentialInsurancePayoutCopper: Math.max(0, Math.floor(toNumber(row.riskProposal.potentialInsurancePayoutCopper, 0)))
          } : {}),
          ...(row.riskProposal.proposedInsurancePayoutCopper != null ? {
            proposedInsurancePayoutCopper: Math.max(0, Math.floor(toNumber(row.riskProposal.proposedInsurancePayoutCopper, 0)))
          } : {})
        } : null,
        riskResolutionOperationId: String(row.riskResolutionOperationId ?? ""),
        riskResolutionChoice: ["proposal", "changed", "cancelled", "manual-delivery"].includes(String(row.riskResolutionChoice ?? "")) ? String(row.riskResolutionChoice) : "",
        riskResolvedAt: String(row.riskResolvedAt ?? ""),
        riskLossRoll: row.riskLossRoll === null || row.riskLossRoll === undefined ? null : Math.max(0, Math.min(1, toNumber(row.riskLossRoll, 1))),
        riskDelayRoll: row.riskDelayRoll === null || row.riskDelayRoll === undefined ? null : Math.max(0, Math.min(1, toNumber(row.riskDelayRoll, 1))),
        riskDelayDurationRoll: row.riskDelayDurationRoll === null || row.riskDelayDurationRoll === undefined ? null : Math.max(0, Math.min(1, toNumber(row.riskDelayDurationRoll, 0))),
        delayQd: Math.max(0, Math.min(20, Math.ceil(toNumber(row.delayQd, 0)))),
        delayRemainingQd: status === "delayed" ? Math.max(0, Math.min(20, Math.ceil(toNumber(row.delayRemainingQd ?? row.delayQd, 0)))) : 0,
        delayedAt: String(row.delayedAt ?? ""),
        lostAt: String(row.lostAt ?? ""),
        cancelledAt: String(row.cancelledAt ?? ""),
        cancellationOperationId: String(row.cancellationOperationId ?? ""),
        cancellationRefundCopper: Math.max(0, Math.floor(toNumber(row.cancellationRefundCopper, 0))),
        cancellationWithheldCopper: Math.max(0, Math.floor(toNumber(row.cancellationWithheldCopper, 0))),
        stockReservationOperationId: String(row.stockReservationOperationId ?? ""),
        stockRestorationOperationId: String(row.stockRestorationOperationId ?? ""),
        stockRestoredAt: String(row.stockRestoredAt ?? ""),
        stockReservations: Array.isArray(row.stockReservations) ? row.stockReservations.map((reservation) => ({
          marketId: String(reservation?.marketId ?? row.marketId ?? "external-market"),
          offerId: String(reservation?.offerId ?? ""),
          qty: Math.max(0, Math.floor(toNumber(reservation?.qty, 0))),
          baseStock: Math.max(0, Math.floor(toNumber(reservation?.baseStock, 0))),
          reservationOperationId: String(reservation?.reservationOperationId ?? row.stockReservationOperationId ?? row.parentOperationId ?? row.operationId ?? id)
        })).filter((reservation) => reservation.offerId && reservation.qty > 0).slice(0, 500) : [],
        subtotalCopper: Math.max(0, toNumber(row.subtotalCopper, 0)),
        deliveryCopper: Math.max(0, toNumber(row.deliveryCopper, 0)),
        totalCopper: Math.max(0, toNumber(row.totalCopper, 0)),
        lines: Array.isArray(row.lines) ? row.lines.map((line) => ({
          offerId: String(line?.offerId ?? ""),
          stockOfferId: String(line?.stockOfferId ?? line?.sourceOfferId ?? line?.offerId ?? ""),
          sourceType: String(line?.sourceType ?? (line?.itemUuid ? "item" : "resource")) === "item" ? "item" : "resource",
          resourceId: String(line?.resourceId ?? "custom"),
          itemUuid: String(line?.itemUuid ?? ""),
          providerId: String(line?.providerId ?? ""),
          providerLabel: String(line?.providerLabel ?? ""),
          name: String(line?.name ?? "Товар"),
          qty: Math.max(0, toNumber(line?.qty, 0)),
          unitPriceCopper: Math.max(0, toNumber(line?.unitPriceCopper, 0))
        })).filter((line) => line.qty > 0) : [],
        cargo: Array.isArray(row.cargo) ? row.cargo.map((cargo) => normalizeMarketCargoRow(cargo, targetRoomId)).filter(Boolean) : []
      };
    });
  merged.special.market.orders = retainNormalizedMarketOrders(merged.special.market.orders);
  if (!Array.isArray(merged.storage.resources)) merged.storage.resources = [];
  if (!Array.isArray(merged.storage.items)) merged.storage.items = [];
  merged.storage.moneyCopper = Math.max(0, toNumber(merged.storage.moneyCopper ?? merged.storage.money ?? merged.storage.coinsCopper ?? 0, 0));
  const normalizedResources = merged.storage.resources.map((row) => normalizeResourceRow(row, { compactBatches: false }));
  const regularResources = [];
  const regularResourceIndex = new Map();
  for (const row of normalizedResources) {
    if (normalizeResourceId(row.resourceId, row.name) === "money") merged.storage.moneyCopper += toNumber(row.qty, 0);
    else {
      const key = storageResourceKey(row);
      const existing = regularResourceIndex.get(key);
      if (!existing) {
        regularResourceIndex.set(key, row);
        regularResources.push(row);
      } else {
        remapOutboundStorageRowId(merged, row.id, existing.id);
        addResourceBatches(existing, { batches: row.batches }, { holding: merged, makeId });
        existing.forSale = existing.forSale || row.forSale;
      }
    }
  }
  for (const row of regularResources) {
    syncResourceRowBatches(row, { protectedBatchIds: protectedResourceBatchIds(merged, row) });
  }
  merged.storage.resources = regularResources;
  merged.storage.items = merged.storage.items.map((row) => normalizeStorageItemRow(row)).filter(Boolean);
  if (!Array.isArray(merged.storage.log)) merged.storage.log = [];
  merged.storage.log = merged.storage.log.map((row) => normalizeStorageLogRow(row)).filter(Boolean).slice(-250);
  merged.log = normalizeHoldingOperationLog(merged.log);
  merged.finance = normalizeFinanceObligationsState(merged.finance);
  merged.politics = normalizePoliticsState(merged.politics);
  if (!isPlainObject(merged.gm)) merged.gm = {};
  if (!isPlainObject(merged.gm.economy)) merged.gm.economy = {};
  merged.gm.economy.internalDemand = normalizeInternalDemandConfig(merged.gm.economy.internalDemand);
  if (!isPlainObject(merged.gm.food)) merged.gm.food = {};
  const rationUnits = Math.floor(toNumber(merged.gm.food.rationUnitsPerResident, 10));
  merged.gm.food.rationUnitsPerResident = [5, 10, 15].includes(rationUnits) ? rationUnits : 10;
  merged.gm.food.hungerLevel = Math.max(0, Math.min(10, Math.floor(toNumber(merged.gm.food.hungerLevel, 0))));
  merged.gm.food.hungerAcuteDays = Math.max(0, Math.min(10, toNumber(merged.gm.food.hungerAcuteDays, merged.gm.food.hungerLevel)));
  merged.gm.food.nutritionDeficitDays = Math.max(0, Math.min(55, toNumber(merged.gm.food.nutritionDeficitDays, 0)));
  merged.gm.playersCanUseStorage = toBoolean(merged.gm.playersCanUseStorage, false);
  merged.gm.playersCanEditOverview = toBoolean(merged.gm.playersCanEditOverview, true);
  merged.gm.playersCanEditBuildings = toBoolean(merged.gm.playersCanEditBuildings, false);
  merged.gm.playersCanEditResidents = toBoolean(merged.gm.playersCanEditResidents, false);
  merged.gm.playersCanEditDefense = toBoolean(merged.gm.playersCanEditDefense, false);
  merged.gm.playersCanEditBattle = toBoolean(merged.gm.playersCanEditBattle, false);
  merged.gm.playersCanEditSpecial = toBoolean(merged.gm.playersCanEditSpecial, false);
  merged.gm.playersCanManageShips = toBoolean(merged.gm.playersCanManageShips, false);
  merged.gm.playersCanViewPolitics = toBoolean(merged.gm.playersCanViewPolitics, true);
  merged.gm.playersCanUseDirectives = toBoolean(merged.gm.playersCanUseDirectives, false);
  merged.gm.playersCanIssueDecrees = toBoolean(merged.gm.playersCanIssueDecrees, false);
  merged.gm.politicsCultureThreshold = politicsCultureThreshold(merged);
  merged.gm.politicsIgnoreInstitutionRequirement = toBoolean(merged.gm.politicsIgnoreInstitutionRequirement, false);
  if (!isPlainObject(merged.gm.politicsBalance)) merged.gm.politicsBalance = { version: 1, core: {}, rows: {}, custom: [] };
  if (!isPlainObject(merged.gm.politicsBalance.core)) merged.gm.politicsBalance.core = {};
  if (!isPlainObject(merged.gm.politicsBalance.rows)) merged.gm.politicsBalance.rows = {};
  if (!Array.isArray(merged.gm.politicsBalance.custom)) merged.gm.politicsBalance.custom = [];
  merged.gm.loadingImage = String(merged.gm.loadingImage ?? "");
  merged.gm.eventTables = normalizeRandomEventTables(holding?.gm?.eventTables);
  merged.gm.eventHistory = normalizeEventHistory(holding?.gm?.eventHistory);
  merged.gm.eventSchedule = normalizeEventSchedule(holding?.gm?.eventSchedule);
  merged.gm.eventArchive = normalizeEventArchive(holding?.gm?.eventArchive);
  merged.gm.lastRoll = normalizeLastEventRoll(holding?.gm?.lastRoll ?? merged.gm.lastRoll);
  merged.gm.moraleSnapshot = normalizeMoraleSnapshot(holding?.gm?.moraleSnapshot ?? merged.gm.moraleSnapshot, merged.people.list);
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

  merged.gm.massCombat = normalizeMassCombatState(holding?.gm?.massCombat, normalize);

  return merged;
}
