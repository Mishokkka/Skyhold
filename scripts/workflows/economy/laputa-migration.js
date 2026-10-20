import { stableDataHash } from "../../data/storage-commit.js";
import { BASE_HOLDING } from "../../data/schema/base-holding.js";
import { clone } from "../../data/utils.js";
import { normalizeLivestockBuilding } from "../../data/livestock.js";
import { normalizeContentPack } from "../../data/content-packs.js";
import { ECONOMY_RESOURCE_CATALOG_SIZE, ECONOMY_RESOURCE_CATALOG_VERSION } from "../../data/resources/resource-base-definitions.js";
import { isCanonicalResourceId } from "../../data/resources/resource-id-migration.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { legacyResidentTraitFromSkill } from "../../data/normalizers/resident.js";

export const LAPUTA_SOURCE_SHA256 = "CBF86D1F0A7A629DF93DBAC1F5DB81526DD28CE19017370349B3F70252907B5E";
export const LAPUTA_MIGRATION_NAMESPACE = "fbl-skyhold.economy.laputa";
export const LAPUTA_MIGRATION_VERSION = 8;
export const LAPUTA_MARKET_PACK_ID = "air-islands-trade-network-template";
export const LAPUTA_MARKET_PACK_VERSION = 14;
export const LAPUTA_MARKET_PACK_PATH = "examples/content-packs/air-islands-trade-network-template.json";

export function isCurrentLaputaMigrationMarker(marker = null) {
  if (!marker || typeof marker !== "object") return false;
  return finiteInteger(marker.version, -1) === LAPUTA_MIGRATION_VERSION
    && String(marker?.target?.marketPackId ?? "") === LAPUTA_MARKET_PACK_ID
    // Updating the bundled pack must not re-enable an already completed reset.
    && [12, 13, LAPUTA_MARKET_PACK_VERSION].includes(finiteInteger(marker?.target?.marketPackVersion, -1))
    && String(marker?.runtimeContracts?.resourceCatalog ?? "") === `economy-v${ECONOMY_RESOURCE_CATALOG_VERSION}`;
}

const SOURCE_FORMAT = "fbl-skyhold-world-economy-snapshot";
const SOURCE_REVISION = 2719;
const SOURCE_SCHEMA_VERSION = 91;
const LAPUTA_ID = "laputa";
const OLIVA_ID = "holding-YqxVhKAEY4";
const HOUSE_ONE_ID = "laputa-building-house-1";
const HOUSE_TWO_ID = "laputa-building-house-2";
const CEMETERY_ID = "ATr70vKA4na0";
const PASTURE_ID = "laputa-building-pasture";
const LAZARET_ID = "cthR8Dn0ffub";
const WAREHOUSE_ID = "7hWwH1qpdroI";
const FASTI_ID = "b-KurQ68YZNWsg";
const MARKET_PACK_COUNTS = Object.freeze({
  resources: ECONOMY_RESOURCE_CATALOG_SIZE - 1,
  regions: 69,
  baseOffers: ECONOMY_RESOURCE_CATALOG_SIZE - 1,
  countries: 16,
  specialties: 135,
  organizations: 22,
  sizeProfiles: 6,
  conditions: 19
});

export const LAPUTA_BUILDING_MAPPING = Object.freeze([
  Object.freeze({ instanceId: HOUSE_ONE_ID, templateId: "common-house", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-well", templateId: "well", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-pigeon-house", templateId: "dovecote", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-pier", templateId: "pier", state: "built" }),
  Object.freeze({ instanceId: "Ej5bOslhDjKy", templateId: "laputa-excavated-crypt", state: "built" }),
  Object.freeze({ instanceId: HOUSE_TWO_ID, templateId: "common-house", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-lighthouse", templateId: "lighthouse", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-tavern", templateId: "inn", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-lumbermill", templateId: "lumbermill", state: "built" }),
  Object.freeze({ instanceId: CEMETERY_ID, templateId: "cemetery", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-garden", templateId: "garden", state: "built" }),
  Object.freeze({ instanceId: PASTURE_ID, templateId: "pasture", state: "built" }),
  Object.freeze({ instanceId: "laputa-building-quarry", templateId: "quarry", state: "built" }),
  Object.freeze({ instanceId: LAZARET_ID, templateId: "lazaret", state: "building" }),
  Object.freeze({ instanceId: WAREHOUSE_ID, templateId: "warehouse", state: "planned" }),
  Object.freeze({ instanceId: FASTI_ID, templateId: "fasti-shop", state: "built" })
]);

const EXPECTED_BUILDING_IDS = new Set(LAPUTA_BUILDING_MAPPING.map((row) => row.instanceId));
const RESIDENT_PRESERVE_FIELDS = Object.freeze([
  "id",
  "name",
  "role",
  "sex",
  "race",
  "subrace",
  "ageGroup",
  "age",
  "culture",
  "belief",
  "background",
  "appearance",
  "traitsText",
  "attributes",
  "notes",
  "actorUuid",
  "educationMilestones"
]);
const OVERVIEW_PRESERVE_FIELDS = Object.freeze([
  "status",
  "period",
  "description",
  "publicNotes",
  "region",
  "altitude",
  "drift",
  "mechanisms",
  "weather"
]);
const BUILDING_MEDIA_FIELDS = Object.freeze(["img", "image", "media", "audio"]);

export class LaputaMigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "LaputaMigrationError";
    this.code = String(code || "laputa-migration-error");
    this.details = clone(details ?? {});
  }
}

function invariant(condition, code, message, details = {}) {
  if (!condition) throw new LaputaMigrationError(code, message, details);
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function copyData(value) {
  return value === undefined ? undefined : clone(value);
}

function marketResourceReferences(value, ownerKey = "", result = []) {
  if (Array.isArray(value)) {
    if (ownerKey === "resourceIds") {
      for (const id of value) if (String(id ?? "").trim()) result.push(String(id).trim());
      return result;
    }
    for (const entry of value) marketResourceReferences(entry, "", result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "resourceId" || key.endsWith("ResourceId")) && typeof entry === "string" && entry.trim()) result.push(entry.trim());
    else marketResourceReferences(entry, key, result);
  }
  return result;
}

function auditCanonicalMarketPack(rawPack) {
  let pack;
  try {
    pack = normalizeContentPack(rawPack);
  } catch (error) {
    throw new LaputaMigrationError("target-market-pack", "The bundled market pack is invalid.", { message: error?.message ?? String(error) });
  }
  invariant(pack.id === LAPUTA_MARKET_PACK_ID && pack.version === LAPUTA_MARKET_PACK_VERSION,
    "target-market-pack",
    "The bundled market pack has an unexpected identity or version.",
    { expectedId: LAPUTA_MARKET_PACK_ID, expectedVersion: LAPUTA_MARKET_PACK_VERSION, actualId: pack.id, actualVersion: pack.version });
  invariant(pack.install.replaceMarket && pack.install.replaceResources && pack.install.overwriteResources,
    "target-market-pack",
    "The bundled market pack must request a clean market and resource replacement.");

  const economy = normalizeMarketEconomy({ schemaVersion: 3, ...pack.content.marketEconomy }, { locations: pack.content.regions });
  const counts = {
    resources: pack.content.resources.length,
    regions: pack.content.regions.length,
    baseOffers: economy.baseOffers.length,
    countries: economy.countries.length,
    specialties: economy.specialties.length,
    organizations: economy.organizations.length,
    sizeProfiles: economy.sizeProfiles.length,
    conditions: economy.conditions.length
  };
  invariant(Object.entries(MARKET_PACK_COUNTS).every(([key, expected]) => counts[key] === expected),
    "target-market-pack",
    "The bundled market pack does not match the approved clean-install counts.",
    { expected: MARKET_PACK_COUNTS, actual: counts });
  invariant(pack.content.marketRouteMap && typeof pack.content.marketRouteMap === "object",
    "target-market-pack",
    "The bundled market pack has no route map.");

  const resourceIds = pack.content.resources.map((row) => String(row?.id ?? ""));
  invariant(new Set(resourceIds).size === resourceIds.length && resourceIds.every((id) => id !== "money" && isCanonicalResourceId(id)),
    "target-market-pack",
    "The bundled market pack contains missing, duplicate or non-canonical resource rows.");
  const baseOfferIds = economy.baseOffers.map((row) => String(row?.resourceId ?? ""));
  invariant(new Set(baseOfferIds).size === resourceIds.length && resourceIds.every((id) => baseOfferIds.includes(id)),
    "target-market-pack",
    "The bundled market pack must contain exactly one base offer for every storable resource.");
  const invalidReferences = [...new Set(marketResourceReferences(economy).filter((id) => !isCanonicalResourceId(id)))];
  invariant(!invalidReferences.length,
    "target-market-pack",
    "The bundled market pack contains non-canonical resource references.",
    { invalidReferences });
  return {
    pack,
    economy,
    counts,
    hash: stableDataHash(pack)
  };
}

function buildTargetCatalog(currentCatalog = {}, marketPackAudit) {
  const catalog = clone(currentCatalog);
  catalog.resources = clone(marketPackAudit.pack.content.resources);
  catalog.markets = [];
  catalog.eventRegions = clone(marketPackAudit.pack.content.regions);
  catalog.marketRouteMap = clone(marketPackAudit.pack.content.marketRouteMap);
  catalog.marketEconomy = clone(marketPackAudit.economy);
  return catalog;
}

function finiteInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function sourcePartitions(snapshot) {
  invariant(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), "source-shape", "Source snapshot must be an object.");
  invariant(String(snapshot.format ?? "") === SOURCE_FORMAT, "source-format", `Expected source format ${SOURCE_FORMAT}.`, { actual: snapshot.format });
  const settings = snapshot.settings;
  invariant(settings && typeof settings === "object" && !Array.isArray(settings), "source-settings", "Source snapshot has no settings partition.");
  invariant(settings.skyholdMeta && typeof settings.skyholdMeta === "object", "source-meta", "Source snapshot has no skyholdMeta partition.");
  invariant(Array.isArray(settings.skyholdHoldings), "source-holdings", "Source snapshot has no skyholdHoldings partition.");
  invariant(settings.skyholdCatalog && typeof settings.skyholdCatalog === "object", "source-catalog", "Source snapshot has no skyholdCatalog partition.");
  return {
    meta: settings.skyholdMeta,
    holdings: settings.skyholdHoldings,
    catalog: settings.skyholdCatalog
  };
}

function sourceDead(person) {
  return person?.dead === true || person?.isDead === true;
}

function rowsById(rows, kind) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row?.id ?? "");
    invariant(id, `${kind}-id`, `${kind} row has no id.`);
    invariant(!byId.has(id), `${kind}-duplicate`, `Duplicate ${kind} id: ${id}.`, { id });
    byId.set(id, row);
  }
  return byId;
}

function canonicalHomeId(person, sourceBuildings) {
  if (sourceDead(person)) return "";
  const raw = String(person?.home ?? "").trim();
  const houseOneName = String(sourceBuildings.get(HOUSE_ONE_ID)?.name ?? "").trim();
  const houseTwoName = String(sourceBuildings.get(HOUSE_TWO_ID)?.name ?? "").trim();
  if (raw === HOUSE_ONE_ID || raw === houseOneName || raw === "Дом-1") return HOUSE_ONE_ID;
  if (raw === HOUSE_TWO_ID || raw === houseTwoName || raw === "Дом-2") return HOUSE_TWO_ID;
  return "";
}

function sourceLivestock(sourceBuildings) {
  const contents = Array.isArray(sourceBuildings.get(PASTURE_ID)?.contents)
    ? sourceBuildings.get(PASTURE_ID).contents
    : [];
  let cows = 0;
  let bulls = 0;
  for (const row of contents) {
    const qty = Math.max(0, finiteInteger(row?.qty ?? row?.quantity ?? row?.count, 0));
    const text = `${row?.resourceId ?? ""} ${row?.name ?? ""}`.toLocaleLowerCase("ru");
    if (/bull|бык/.test(text)) bulls += qty;
    else if (/cattle|cow|коров|скот/.test(text)) cows += qty;
  }
  return { cows, bulls, cattle: cows + bulls };
}

function validateSourceHash(sourceHash) {
  const normalized = String(sourceHash ?? "").trim().toUpperCase();
  invariant(normalized === LAPUTA_SOURCE_SHA256, "source-hash", "Source SHA-256 does not match the approved Laputa snapshot.", {
    expected: LAPUTA_SOURCE_SHA256,
    actual: normalized
  });
  return normalized;
}

export function auditLaputaMigrationSource({ snapshot, sourceHash } = {}) {
  const normalizedHash = validateSourceHash(sourceHash);
  const { meta, holdings, catalog } = sourcePartitions(snapshot);
  invariant(finiteInteger(meta.revision, -1) === SOURCE_REVISION, "source-revision", `Expected source revision ${SOURCE_REVISION}.`, { actual: meta.revision });
  invariant(finiteInteger(meta.schemaVersion, -1) === SOURCE_SCHEMA_VERSION, "source-schema", `Expected source schema ${SOURCE_SCHEMA_VERSION}.`, { actual: meta.schemaVersion });
  invariant(meta.storageCommit?.state === "complete" && meta.storageCommit?.writeComplete === true, "source-commit", "Source split-storage commit is not complete.");
  invariant(finiteInteger(meta.storageCommit?.revision, -1) === SOURCE_REVISION, "source-commit-revision", "Source commit revision does not match skyholdMeta.", {
    metaRevision: meta.revision,
    commitRevision: meta.storageCommit?.revision
  });

  const laputaRows = holdings.filter((holding) => String(holding?.id ?? "") === LAPUTA_ID);
  invariant(laputaRows.length === 1, "source-laputa", "Source must contain exactly one Laputa holding.", { count: laputaRows.length });
  invariant(holdings.some((holding) => String(holding?.id ?? "") === OLIVA_ID), "source-oliva", "Approved source holding Oliva is missing; the snapshot is not the expected source.");
  const holding = laputaRows[0];
  invariant(finiteInteger(holding?.storage?.moneyCopper, -1) === 7660, "source-money", "Laputa source treasury must be exactly 7660 copper.", { actual: holding?.storage?.moneyCopper });

  const people = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  rowsById(people, "resident");
  const live = people.filter((person) => !sourceDead(person));
  const dead = people.filter(sourceDead);
  invariant(people.length === 21 && live.length === 12 && dead.length === 9, "source-residents", "Laputa source resident counts must be 21 total, 12 living and 9 dead.", {
    total: people.length,
    live: live.length,
    dead: dead.length
  });

  const buildings = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const sourceBuildings = rowsById(buildings, "building");
  const actualBuildingIds = new Set(sourceBuildings.keys());
  const missingBuildingIds = [...EXPECTED_BUILDING_IDS].filter((id) => !actualBuildingIds.has(id));
  const extraBuildingIds = [...actualBuildingIds].filter((id) => !EXPECTED_BUILDING_IDS.has(id));
  invariant(buildings.length === LAPUTA_BUILDING_MAPPING.length && !missingBuildingIds.length && !extraBuildingIds.length,
    "source-building-map",
    "Laputa source building instances do not match the approved 16-row mapping.",
    { missingBuildingIds, extraBuildingIds, count: buildings.length });

  const homeCounts = { [HOUSE_ONE_ID]: 0, [HOUSE_TWO_ID]: 0, unresolved: 0 };
  for (const person of live) {
    const home = canonicalHomeId(person, sourceBuildings);
    if (home) homeCounts[home] += 1;
    else homeCounts.unresolved += 1;
  }
  invariant(homeCounts[HOUSE_ONE_ID] === 10 && homeCounts[HOUSE_TWO_ID] === 2 && homeCounts.unresolved === 0,
    "source-housing",
    "Laputa source housing must resolve to 10 living residents in House 1 and 2 in House 2.",
    { homeCounts });

  invariant(
    finiteInteger(sourceBuildings.get(LAZARET_ID)?.buildProgress, -1) === 2
      && finiteInteger(sourceBuildings.get(LAZARET_ID)?.buildTarget, -1) === 3,
    "source-lazaret",
    "Source Lazaret must be at progress 2 of 3."
  );
  invariant(finiteInteger(sourceBuildings.get(WAREHOUSE_ID)?.buildProgress, -1) === 0, "source-warehouse", "Source Warehouse must be at progress 0.");
  invariant(String(sourceBuildings.get(FASTI_ID)?.img ?? "") === "3_F00L/Other/Paintings/Fasti.png", "source-fasti-image", "Source Fasti image does not match the approved instance image.");
  invariant(sourceBuildings.get(FASTI_ID)?.audio && typeof sourceBuildings.get(FASTI_ID).audio === "object", "source-fasti-audio", "Source Fasti audio configuration is missing.");

  const livestock = sourceLivestock(sourceBuildings);
  invariant(livestock.cattle === 10 && livestock.bulls === 1, "source-livestock", "Source Pasture must contain nine cows and one bull.", livestock);

  return {
    ok: true,
    sourceHash: normalizedHash,
    revision: SOURCE_REVISION,
    schemaVersion: SOURCE_SCHEMA_VERSION,
    sourceDataHash: stableDataHash({ meta, holdings, catalog }),
    holding,
    sourceBuildings,
    counts: {
      holdings: holdings.length,
      residents: people.length,
      livingResidents: live.length,
      deadResidents: dead.length,
      buildings: buildings.length,
      houseOneResidents: homeCounts[HOUSE_ONE_ID],
      houseTwoResidents: homeCounts[HOUSE_TWO_ID],
      cattle: livestock.cattle,
      breedingBulls: livestock.bulls,
      moneyCopper: 7660
    }
  };
}

function targetTemplates(currentData) {
  invariant(currentData && typeof currentData === "object" && !Array.isArray(currentData), "target-shape", "Current normalized data must be an object.");
  invariant(currentData.meta && typeof currentData.meta === "object", "target-meta", "Current normalized data has no meta partition.");
  invariant(Array.isArray(currentData.holdings), "target-holdings", "Current normalized data has no holdings partition.");
  invariant(currentData.catalog && typeof currentData.catalog === "object", "target-catalog", "Current normalized data has no catalog partition.");
  invariant(Array.isArray(currentData.catalog.buildings), "target-building-catalog", "Current target catalog has no building templates.");
  const templates = rowsById(currentData.catalog.buildings, "target-template");
  const missing = [...new Set(LAPUTA_BUILDING_MAPPING.map((row) => row.templateId))].filter((id) => !templates.has(id));
  invariant(!missing.length, "target-templates", "Current target catalog is missing Laputa migration templates.", { missing });
  invariant(finiteInteger(templates.get("lazaret")?.buildTarget, -1) > 0, "target-lazaret", "Target Lazaret template has no valid buildTarget.", {
    actual: templates.get("lazaret")?.buildTarget
  });
  invariant(finiteInteger(templates.get("warehouse")?.buildTarget, -1) > 0, "target-warehouse", "Target Warehouse template has no valid buildTarget.");
  return templates;
}

function cleanResident(source, sourceBuildings) {
  const person = {};
  for (const key of RESIDENT_PRESERVE_FIELDS) {
    if (own(source, key)) person[key] = copyData(source[key]);
  }
  person.id = String(person.id ?? "");
  person.name = String(person.name ?? "");
  person.role = String(person.role ?? "");
  const legacyTrait = legacyResidentTraitFromSkill(source?.skill);
  if (legacyTrait) {
    const existingTraits = String(person.traitsText ?? "").split(/[,;\n]/).map((value) => value.trim()).filter(Boolean);
    if (!existingTraits.some((value) => value.toLowerCase() === legacyTrait.toLowerCase())) existingTraits.push(legacyTrait);
    person.traitsText = existingTraits.join(", ");
  }
  person.workAssignment = "";
  person.home = canonicalHomeId(source, sourceBuildings);
  person.salary = 0;
  person.salaryModifier = 0;
  person.moraleBase = -1;
  person.moraleWork = 0;
  person.moraleHome = 0;
  person.moraleManual = 0;
  person.moraleDelta = -1;
  person.dead = sourceDead(source);
  person.deathDate = person.dead ? String(source?.deathDate ?? "") : "";
  person.deathNote = person.dead ? String(source?.deathNote ?? "") : "";
  person.injuredDays = 0;
  const oldStatus = String(source?.status ?? "").trim();
  const injuryOnlyStatus = /ранен|ранен[аиы]?|тяжело|сломлен|injur|wound|broken/i.test(oldStatus);
  person.status = !person.dead && injuryOnlyStatus ? "" : oldStatus;
  if (person.dead) person.home = "";
  return person;
}

function setBuildingState(building, mapping, source = null) {
  const target = Math.max(1, finiteInteger(building.buildTarget, 1));
  building.condition = "intact";
  building.battleDamage = 0;
  building.repair = { active: false, fromCondition: "intact", progress: 0, target: 0, startedAt: "" };
  building.repairOf = "";
  building.repairProgress = 0;
  building.repairTarget = 0;
  building.constructionCrewId = "";
  building.workersAssigned = 0;
  const workerSlots = Math.max(0, finiteInteger(building.workersMax, 0));
  building.assignedWorkerIds = Array.from({ length: workerSlots }, () => "");

  if (mapping.instanceId === LAZARET_ID) {
    const sourceTarget = Math.max(1, finiteInteger(source?.buildTarget, 3));
    const sourceProgress = Math.min(sourceTarget, Math.max(0, finiteInteger(source?.buildProgress, 2)));
    const preservedProgress = Math.round((sourceProgress / sourceTarget) * target);
    building.lifecycle = "building";
    building.constructionStatus = "building";
    building.status = "Строится";
    building.buildProgress = Math.min(Math.max(0, target - 1), Math.max(0, preservedProgress));
    building.materialsAllocated = true;
    return;
  }
  if (mapping.instanceId === WAREHOUSE_ID) {
    building.lifecycle = "planned";
    building.constructionStatus = "planned";
    building.status = "Проект";
    building.buildProgress = 0;
    building.materialsAllocated = false;
    return;
  }
  building.lifecycle = "active";
  building.constructionStatus = "built";
  building.status = "Построено";
  building.buildProgress = target;
  delete building.materialsAllocated;
}

function buildTargetInstances(sourceHolding, sourceBuildings, templates) {
  const instances = [];
  for (const mapping of LAPUTA_BUILDING_MAPPING) {
    const source = sourceBuildings.get(mapping.instanceId);
    const building = clone(templates.get(mapping.templateId));
    building.id = mapping.instanceId;
    building.templateId = mapping.templateId;
    building.name = String(source?.name ?? building.name ?? "");
    for (const key of BUILDING_MEDIA_FIELDS) {
      if (own(source, key)) building[key] = copyData(source[key]);
    }
    building.contents = [];
    building.residents = mapping.instanceId === HOUSE_ONE_ID ? 10 : (mapping.instanceId === HOUSE_TWO_ID ? 2 : 0);
    if (mapping.instanceId === PASTURE_ID) {
      building.livestock = normalizeLivestockBuilding({
        enabled: true,
        speciesId: "cattle",
        state: {
          adults: 10,
          breedingMales: 1,
          young: [],
          woolReady: 0,
          lastBirthSeasonKey: ""
        },
        operations: { milk: true, shearQty: 0, slaughterQty: 0, slaughterBreedingMales: 0, feedPriority: "adults" }
      }, { building });
    }
    setBuildingState(building, mapping, source);
    instances.push(building);
  }
  return instances;
}

function migrationMetadata({ operationId, sourceAudit, currentData, targetCatalogHash, marketPackAudit, createdAt, residents }) {
  const deadResidentIds = residents.filter((person) => person.dead).map((person) => person.id);
  return {
    version: LAPUTA_MIGRATION_VERSION,
    operationId,
    createdAt,
    source: {
      sha256: sourceAudit.sourceHash,
      revision: SOURCE_REVISION,
      schemaVersion: SOURCE_SCHEMA_VERSION,
      dataHash: sourceAudit.sourceDataHash
    },
    target: {
      revision: Math.max(0, finiteInteger(currentData.meta?.revision, 0)),
      schemaVersion: Math.max(0, finiteInteger(currentData.meta?.schemaVersion, 0)),
      catalogHash: targetCatalogHash,
      marketPackId: marketPackAudit.pack.id,
      marketPackVersion: marketPackAudit.pack.version,
      marketPackHash: marketPackAudit.hash,
      rollbackDataHash: stableDataHash(currentData)
    },
    financialRegisters: {
      schemaVersion: 1,
      debts: [],
      loans: [],
      bankContracts: [],
      obligationOrder: ["bank-debt", "wages", "building-upkeep", "voluntary"]
    },
    projects: {
      lazaret: {
        buildingId: LAZARET_ID,
        progress: 2,
        target: 3,
        materialsFullyPaid: true,
        futureMaterialCharge: false,
        debtCopper: 0
      },
      warehouse: {
        buildingId: WAREHOUSE_ID,
        progress: 0,
        materialsFullyPaid: false,
        stagedMaterialCharges: true,
        cancellationRefundRate: 0.9
      }
    },
    livestock: {
      buildingId: PASTURE_ID,
      species: "cattle",
      count: 10,
      breedingBullCount: 1,
      narrative: "9 коров и 1 племенной бык."
    },
    cemetery: {
      buildingId: CEMETERY_ID,
      residentIds: deadResidentIds
    },
    runtimeContracts: {
      financeObligations: "canonical-ledger",
      construction: "staged-material-charges",
      assignments: "cleared-for-explicit-replan",
      resourceCatalog: `economy-v${ECONOMY_RESOURCE_CATALOG_VERSION}`,
      marketReferences: "canonical-resource-ids",
      marketInstall: `clean:${marketPackAudit.pack.id}:v${marketPackAudit.pack.version}`
    }
  };
}

function buildTargetHolding({ sourceAudit, templates, currentData, targetCatalogHash, marketPackAudit, operationId, createdAt }) {
  const source = sourceAudit.holding;
  const sourceBuildings = sourceAudit.sourceBuildings;
  const holding = clone(BASE_HOLDING);
  holding.id = String(source.id);
  holding.name = String(source.name ?? "");
  holding.type = String(source.type ?? holding.type);
  holding.owner = clone(source.owner ?? "");
  holding.visibility = String(source.visibility ?? holding.visibility);
  holding.linkedSceneId = String(source.linkedSceneId ?? "");

  for (const key of OVERVIEW_PRESERVE_FIELDS) {
    if (own(source.overview, key)) holding.overview[key] = copyData(source.overview[key]);
  }
  holding.overview.population = 12;
  holding.overview.morale = 0;
  holding.overview.moraleBase = 0;
  holding.overview.reputation = 0;
  holding.overview.defense = 0;
  holding.overview.development = { food: 0, technology: 0, culture: 0, war: 0 };

  const residents = source.people.list.map((person) => cleanResident(person, sourceBuildings));
  holding.people.list = residents;
  holding.buildings.list = buildTargetInstances(source, sourceBuildings, templates);
  holding.constructionCrewIds = [];
  holding.constructionCrews = [];
  holding.special.list = [];
  holding.special.market = {
    preferredRoomId: "outdoors",
    stock: {},
    demand: {},
    outbound: { version: 1, orders: [], operationIds: [], updatedAt: "" },
    orders: []
  };
  holding.storage.resources = [];
  holding.storage.items = [];
  holding.storage.moneyCopper = 7660;
  holding.storage.log = [];
  delete holding.storage.transaction;
  holding.log = [];
  holding.gm.defense.squads = [];
  holding.gm.defense.commanderId = "";
  holding.gm.eventTables = null;
  holding.gm.eventHistory = [];
  holding.gm.eventSchedule = [];
  holding.gm.eventArchive = [];
  holding.gm.lastRoll = null;
  holding.gm.massCombat.archive = [];
  holding.gm.massCombat.log = [];
  holding.gm.migrationMetadata = {
    [LAPUTA_MIGRATION_NAMESPACE]: migrationMetadata({
      operationId,
      sourceAudit,
      currentData,
      targetCatalogHash,
      marketPackAudit,
      createdAt,
      residents
    })
  };
  return holding;
}

function planPayload(plan) {
  const payload = clone(plan);
  delete payload.planHash;
  return payload;
}

function validatePlan(plan) {
  invariant(plan && typeof plan === "object" && !Array.isArray(plan), "plan-shape", "Laputa migration plan must be an object.");
  invariant(plan.kind === "fbl-skyhold-laputa-economy-migration", "plan-kind", "Unexpected Laputa migration plan kind.");
  invariant(finiteInteger(plan.version, -1) === LAPUTA_MIGRATION_VERSION, "plan-version", "Unsupported Laputa migration plan version.");
  invariant(String(plan.operationId ?? "").trim(), "plan-operation", "Laputa migration plan has no operationId.");
  invariant(String(plan.source?.sha256 ?? "") === LAPUTA_SOURCE_SHA256, "plan-source", "Laputa migration plan has an unexpected source hash.");
  invariant(String(plan.planHash ?? "") === stableDataHash(planPayload(plan)), "plan-hash", "Laputa migration plan was modified after planning.");
}

export function planLaputaEconomyMigration({ snapshot, sourceHash, currentData, canonicalMarketPack, operationId, createdAt = "" } = {}) {
  const normalizedOperationId = String(operationId ?? "").trim();
  invariant(normalizedOperationId, "operation-id", "A non-empty operationId is required for the Laputa migration.");
  const sourceAudit = auditLaputaMigrationSource({ snapshot, sourceHash });
  const templates = targetTemplates(currentData);
  const currentLaputa = currentData.holdings.find((holding) => String(holding?.id ?? "") === LAPUTA_ID);
  const existingMarker = currentLaputa?.gm?.migrationMetadata?.[LAPUTA_MIGRATION_NAMESPACE];
  invariant(!isCurrentLaputaMigrationMarker(existingMarker) || String(existingMarker.operationId ?? "") === normalizedOperationId,
    "already-applied",
    "Laputa economy migration was already applied with a different operationId.",
    { existingOperationId: existingMarker?.operationId });

  const marketPackAudit = auditCanonicalMarketPack(canonicalMarketPack);
  const currentCatalogHash = stableDataHash(currentData.catalog);
  const preparedCatalog = buildTargetCatalog(currentData.catalog, marketPackAudit);
  const targetCatalogHash = stableDataHash(preparedCatalog);
  const preparedHolding = buildTargetHolding({
    sourceAudit,
    templates,
    currentData,
    targetCatalogHash,
    marketPackAudit,
    operationId: normalizedOperationId,
    createdAt: String(createdAt ?? "")
  });
  const plan = {
    kind: "fbl-skyhold-laputa-economy-migration",
    version: LAPUTA_MIGRATION_VERSION,
    operationId: normalizedOperationId,
    source: {
      sha256: sourceAudit.sourceHash,
      revision: sourceAudit.revision,
      schemaVersion: sourceAudit.schemaVersion,
      dataHash: sourceAudit.sourceDataHash
    },
    target: {
      revision: Math.max(0, finiteInteger(currentData.meta.revision, 0)),
      currentDataHash: stableDataHash(currentData),
      currentCatalogHash,
      catalogHash: targetCatalogHash,
      marketPackId: marketPackAudit.pack.id,
      marketPackVersion: marketPackAudit.pack.version,
      marketPackHash: marketPackAudit.hash
    },
    preview: {
      holdingsRemoved: currentData.holdings.filter((holding) => String(holding?.id ?? "") !== LAPUTA_ID).map((holding) => String(holding?.id ?? "")),
      residents: 21,
      livingResidents: 12,
      deadResidents: 9,
      buildings: 16,
      houseOneResidents: 10,
      houseTwoResidents: 2,
      cattle: 10,
      breedingBulls: 1,
      moneyCopper: 7660,
      storageRows: 0,
      assignments: 0,
      resourceCatalogVersion: ECONOMY_RESOURCE_CATALOG_VERSION,
      resourceCatalogRows: preparedCatalog.resources.length,
      marketBaseOffers: preparedCatalog.marketEconomy.baseOffers.length,
      marketPackVersion: marketPackAudit.pack.version,
      marketLocations: preparedCatalog.eventRegions.length,
      marketCountries: preparedCatalog.marketEconomy.countries.length,
      marketSpecialties: preparedCatalog.marketEconomy.specialties.length,
      marketOrganizations: preparedCatalog.marketEconomy.organizations.length,
      resourceRowsReplaced: Array.isArray(currentData.catalog.resources) ? currentData.catalog.resources.length : 0,
      marketRowsReplaced: [
        ...(Array.isArray(currentData.catalog.markets) ? currentData.catalog.markets : []),
        ...(Array.isArray(currentData.catalog.eventRegions) ? currentData.catalog.eventRegions : []),
        ...(Array.isArray(currentData.catalog.marketEconomy?.baseOffers) ? currentData.catalog.marketEconomy.baseOffers : []),
        ...(Array.isArray(currentData.catalog.marketEconomy?.countries) ? currentData.catalog.marketEconomy.countries : []),
        ...(Array.isArray(currentData.catalog.marketEconomy?.specialties) ? currentData.catalog.marketEconomy.specialties : []),
        ...(Array.isArray(currentData.catalog.marketEconomy?.organizations) ? currentData.catalog.marketEconomy.organizations : [])
      ].length
    },
    preparedHolding,
    preparedCatalog
  };
  plan.planHash = stableDataHash(plan);
  return plan;
}

export function applyLaputaEconomyMigration({ currentData, plan, operationId } = {}) {
  validatePlan(plan);
  const normalizedOperationId = String(operationId ?? plan.operationId ?? "").trim();
  invariant(normalizedOperationId === plan.operationId, "operation-mismatch", "Apply operationId does not match the migration plan.", {
    expected: plan.operationId,
    actual: normalizedOperationId
  });

  invariant(currentData && typeof currentData === "object" && Array.isArray(currentData.holdings),
    "target-shape",
    "Current normalized data has no holdings partition.");
  const currentLaputa = currentData.holdings.find((holding) => String(holding?.id ?? "") === LAPUTA_ID);
  const existingMarker = currentLaputa?.gm?.migrationMetadata?.[LAPUTA_MIGRATION_NAMESPACE];
  if (isCurrentLaputaMigrationMarker(existingMarker)) {
    invariant(String(existingMarker.operationId ?? "") === normalizedOperationId,
      "already-applied",
      "Laputa economy migration was already applied with a different operationId.",
      { existingOperationId: existingMarker.operationId });
    return {
      ok: true,
      alreadyApplied: true,
      commitRequired: false,
      operationId: normalizedOperationId,
      data: clone(currentData)
    };
  }

  targetTemplates(currentData);
  invariant(Math.max(0, finiteInteger(currentData.meta?.revision, 0)) === plan.target.revision,
    "target-revision",
    "Current data revision changed after the Laputa migration preview.",
    { planned: plan.target.revision, actual: currentData.meta?.revision });
  invariant(stableDataHash(currentData.catalog) === plan.target.currentCatalogHash,
    "target-catalog-hash",
    "Current target catalog changed after the Laputa migration preview.");
  invariant(stableDataHash(currentData) === plan.target.currentDataHash,
    "target-data-hash",
    "Current normalized data changed after the Laputa migration preview.");

  const data = clone(currentData);
  data.holdings = [clone(plan.preparedHolding)];
  data.catalog = clone(plan.preparedCatalog);
  delete data.skyholdData;
  return {
    ok: true,
    alreadyApplied: false,
    commitRequired: true,
    operationId: normalizedOperationId,
    data,
    summary: clone(plan.preview)
  };
}
