import { DEFAULT_BUILDING_TEMPLATES, DEPRECATED_TEMPLATE_IDS, TEMPLATE_CATALOG_VERSION } from "./building-templates.js";
import {
  BASE_HOLDING,
  BROAD_WORKER_TYPE_MAP,
  CANONICAL_WORKER_TYPES,
  DEFAULT_SKYHOLD_DATA,
  HOLDING_TYPES,
  LEGACY_WORKER_TYPE_MAP
} from "./schema.js";
import { ageGroupFromAge, clampAgeForRace, normalizeBelief, representativeAgeForGroup } from "../generators/resident-rules.js";
import { normalizeProductionLine, normalizeResourceCatalogRow, normalizeResourceRow, normalizeResourceId } from "../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../core/building-specials.js";
import { clone, isPlainObject, makeId, mergeDefaults, toBoolean, toNumber } from "./utils.js";

export const SKYHOLD_SCHEMA_VERSION = 46;

function normalizeOptions(options = {}) {
  return {
    mode: String(options.mode ?? "load"),
    destructive: toBoolean(options.destructive, false)
  };
}

export function normalizeSkyholdData(stored, options = {}) {
  return migrateData(stored, { mode: "load", destructive: false, ...options });
}

export function repairSkyholdData(stored, options = {}) {
  return migrateData(stored, { mode: "repair", destructive: true, ...options });
}

export function migrateData(stored, options = {}) {
  const normalize = normalizeOptions(options);
  if (!stored || typeof stored !== "object") return migrateData(clone(DEFAULT_SKYHOLD_DATA), normalize);

  if (Array.isArray(stored.holdings)) {
    const migrated = mergeDefaults(clone(DEFAULT_SKYHOLD_DATA), stored);
    migrated.meta.schemaVersion = SKYHOLD_SCHEMA_VERSION;
    migrated.holdings = stored.holdings.map((holding) => mergeHoldingDefaults(holding, normalize));
    if (!migrated.holdings.length) migrated.holdings = clone(DEFAULT_SKYHOLD_DATA.holdings);
    if (!migrated.catalog) migrated.catalog = { buildings: [], resources: [] };
    if (!Array.isArray(migrated.catalog.buildings)) migrated.catalog.buildings = [];
    if (!Array.isArray(migrated.catalog.deletedBuildingTemplateIds)) migrated.catalog.deletedBuildingTemplateIds = [];
    migrated.catalog.buildings = mergeBuildingTemplateCatalog(migrated.catalog.buildings, migrated.catalog.deletedBuildingTemplateIds, normalize);
    migrated.meta.templateCatalogVersion = TEMPLATE_CATALOG_VERSION;
    migrated.meta.revision = Math.max(0, toNumber(migrated.meta.revision, 0));
    if (!Array.isArray(migrated.catalog.resources)) migrated.catalog.resources = [];
    migrated.catalog.resources = migrated.catalog.resources.map((row) => normalizeResourceCatalogRow(row));
    return migrated;
  }

  return migrateLegacySettlement(stored, normalize);
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
      templateCatalogVersion: TEMPLATE_CATALOG_VERSION,
      lastUpdated: stored?.meta?.lastUpdated ?? null,
      revision: Math.max(0, toNumber(stored?.meta?.revision, 0)),
      storageCommit: null
    },
    holdings: [legacyHolding],
    catalog: {
      buildings: clone(DEFAULT_BUILDING_TEMPLATES),
      deletedBuildingTemplateIds: [],
      resources: []
    }
  };
}


function normalizeWorkerTypeName(name = "") {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  const broad = BROAD_WORKER_TYPE_MAP[raw.toLowerCase()];
  if (broad) return broad;
  if (CANONICAL_WORKER_TYPES.has(raw)) return raw;
  return LEGACY_WORKER_TYPE_MAP[raw] ?? "";
}

function normalizeWorkerTypeSet(value = "", effects = {}) {
  const list = [];
  const nextEffects = {};
  const sourceEffects = isPlainObject(effects) ? effects : {};
  for (const part of String(value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)) {
    const name = normalizeWorkerTypeName(part);
    if (!name) continue;
    if (!list.includes(name)) list.push(name);
    const raw = sourceEffects[part] ?? sourceEffects[name];
    const current = nextEffects[name];
    const parsed = raw === undefined ? 0.5 : toNumber(raw, 0.5);
    nextEffects[name] = current === undefined ? parsed : Math.max(current, parsed);
  }
  for (const name of list) if (nextEffects[name] === undefined) nextEffects[name] = 0.5;
  return { line: list.join(", "), effects: nextEffects };
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
    if (DEPRECATED_TEMPLATE_IDS?.has?.(id) && !defaultIds.has(id)) continue;
    const base = map.get(id) ?? {};
    const merged = mergeDefaults(base, row);
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
    map.set(id, normalizeBuildingTemplate(merged, normalize));
  }
  return Array.from(map.values());
}

function normalizeBuildingTemplate(template = {}, options = {}) {
  const normalize = normalizeOptions(options);
  const row = clone(template ?? {});
  normalizeBuilding(row, normalize);
  row.templateVersion = Math.max(2, toNumber(row.templateVersion, TEMPLATE_CATALOG_VERSION));
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

export function mergeHoldingDefaults(holding, options = {}) {
  const normalize = normalizeOptions(options);
  const type = HOLDING_TYPES[holding?.type] ? holding.type : "settlement";
  const base = clone(BASE_HOLDING);
  base.id = holding?.id || makeId("holding");
  base.type = type;

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
  if (!Array.isArray(merged.buildings.list)) merged.buildings.list = [];
  merged.buildings.list = merged.buildings.list.filter((building) => {
    const id = String(building?.id ?? building?.templateId ?? "").toLowerCase();
    const name = String(building?.name ?? "").trim().toLowerCase();
    return id !== "fireplace" && name !== "камин";
  });
  for (const building of merged.buildings.list) {
    if (Array.isArray(building.requiredBuildingIds)) building.requiredBuildingIds = building.requiredBuildingIds.filter((id) => String(id) !== "fireplace");
  }
  if (!isPlainObject(merged.overview.development)) merged.overview.development = {};
  merged.overview.development.food = toNumber(merged.overview.development.food, 0);
  merged.overview.development.technology = toNumber(merged.overview.development.technology, 0);
  merged.overview.development.culture = toNumber(merged.overview.development.culture, 0);
  merged.overview.development.war = toNumber(merged.overview.development.war, 0);

  for (const building of merged.buildings.list) normalizeBuilding(building, normalize);
  if (!Array.isArray(merged.special.list)) merged.special.list = [];
  if (!Array.isArray(merged.storage.resources)) merged.storage.resources = [];
  if (!Array.isArray(merged.storage.items)) merged.storage.items = [];
  merged.storage.moneyCopper = Math.max(0, toNumber(merged.storage.moneyCopper ?? merged.storage.money ?? merged.storage.coinsCopper ?? 0, 0));
  const normalizedResources = merged.storage.resources.map((row) => normalizeResourceRow(row));
  const regularResources = [];
  for (const row of normalizedResources) {
    if (normalizeResourceId(row.resourceId, row.name) === "money") merged.storage.moneyCopper += toNumber(row.qty, 0);
    else regularResources.push(row);
  }
  merged.storage.resources = regularResources;
  merged.storage.items = merged.storage.items.map((row) => normalizeStorageItemRow(row)).filter(Boolean);
  if (!Array.isArray(merged.storage.log)) merged.storage.log = [];
  merged.storage.log = merged.storage.log.map((row) => normalizeStorageLogRow(row)).filter(Boolean).slice(-250);
  if (!Array.isArray(merged.log)) merged.log = [];
  if (!isPlainObject(merged.gm)) merged.gm = {};
  merged.gm.playersCanUseStorage = toBoolean(merged.gm.playersCanUseStorage, false);
  merged.gm.playersCanEditOverview = toBoolean(merged.gm.playersCanEditOverview, true);
  merged.gm.playersCanEditBuildings = toBoolean(merged.gm.playersCanEditBuildings, false);
  merged.gm.playersCanEditResidents = toBoolean(merged.gm.playersCanEditResidents, false);
  merged.gm.playersCanEditDefense = toBoolean(merged.gm.playersCanEditDefense, false);
  merged.gm.playersCanEditBattle = toBoolean(merged.gm.playersCanEditBattle, false);
  merged.gm.playersCanEditSpecial = toBoolean(merged.gm.playersCanEditSpecial, false);
  merged.gm.loadingImage = String(merged.gm.loadingImage ?? "");
  if (!isPlainObject(merged.gm.modifiers)) merged.gm.modifiers = {};
  for (const key of ["food", "technology", "culture", "war", "defense", "reputation", "morale"]) merged.gm.modifiers[key] = toNumber(merged.gm.modifiers[key], 0);
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

  merged.gm.massCombat = normalizeMassCombatState(merged.gm.massCombat);

  return merged;
}


function normalizeDefenseSquad(row = {}) {
  if (!isPlainObject(row)) return null;
  const id = String(row.id || makeId("squad"));
  const sourceMemberIds = Array.isArray(row.memberIds) ? row.memberIds.map((value) => String(value ?? "")) : [];
  let sergeantId = String(row.sergeantId ?? "");
  let memberIds = sourceMemberIds;
  // До 1.1.6 отряд был "сержант + 5 солдат". Теперь первый слот общий:
  // сержант или обычный солдат, всего 5 бойцов. Если старый отряд не имел
  // сержанта, первый солдат переносится в общий первый слот.
  if (!sergeantId && sourceMemberIds.length > 4) {
    sergeantId = String(sourceMemberIds[0] ?? "");
    memberIds = sourceMemberIds.slice(1);
  }
  return {
    id,
    name: String(row.name ?? "Отряд"),
    type: String(row.type ?? "line") === "militia" ? "line" : String(row.type ?? "line"),
    sergeantId,
    equipped: toBoolean(row.equipped, false),
    memberIds: Array.from({ length: 4 }, (_, index) => String(memberIds[index] ?? "")),
    notes: String(row.notes ?? "")
  };
}

function normalizeMassCombatState(state = {}) {
  const source = isPlainObject(state) ? state : {};
  const base = clone(BASE_HOLDING.gm.massCombat);
  const merged = mergeDefaults(base, source);
  delete merged.defenderSupply;
  delete merged.attackerSupply;

  // Legacy 1.0.13 field migration. Old values stay readable instead of being discarded.
  if (source.defenderBS === undefined && source.defenderForce !== undefined) merged.defenderBS = source.defenderForce;
  if (source.attackerBS === undefined && source.attackerForce !== undefined) merged.attackerBS = source.attackerForce;
  if (source.defenderCommand === undefined && source.defenderCommander !== undefined) merged.defenderCommand = source.defenderCommander;
  if (source.attackerCommand === undefined && source.attackerCommander !== undefined) merged.attackerCommand = source.attackerCommander;
  if (source.defenderPosition === undefined && source.defenderTerrain !== undefined) merged.defenderPosition = source.defenderTerrain;
  if (source.attackerSiege !== undefined && source.attackerSiege > 0) merged.attackerSiege = source.attackerSiege;
  if (source.defenderLossSteps === undefined && source.defenderLosses !== undefined) merged.defenderLossSteps = source.defenderLosses;
  if (source.attackerLossSteps === undefined && source.attackerLosses !== undefined) merged.attackerLossSteps = source.attackerLosses;

  const numericKeys = [
    "defenderUnits", "defenderBS", "defenderCommand", "defenderHero", "defenderMorale", "defenderSpecial", "defenderPosition",
    "attackerUnits", "attackerBS", "attackerCommand", "attackerHero", "attackerSpecial", "attackerPosition",
    "defenderInfantry", "defenderShooters", "defenderMobile", "defenderHeavy", "defenderSappers", "defenderSiege", "defenderSkirmishers", "defenderMonsters", "defenderSacred",
    "attackerInfantry", "attackerShooters", "attackerMobile", "attackerHeavy", "attackerSappers", "attackerSiege", "attackerSkirmishers", "attackerMonsters", "attackerSacred",
    "defenderFire", "defenderRecon", "defenderCavalry", "defenderEngineering", "defenderMonstrous",
    "attackerFire", "attackerRecon", "attackerCavalry", "attackerEngineering", "attackerMonstrous",
    "round", "roundLimit", "breachProgress", "objectiveProgress", "objectiveThreshold", "defenderLossSteps", "attackerLossSteps", "settlementDamage",
    "defenderShaken", "defenderBroken", "attackerShaken", "attackerBroken"
  ];
  for (const key of numericKeys) merged[key] = toNumber(merged[key], base[key] ?? 0);
  for (const key of Object.keys(merged)) {
    if (/^(defender|attacker)[A-Z][A-Za-z0-9_]*-[A-Za-z0-9_-]*$/.test(key)) merged[key] = Math.max(0, toNumber(merged[key], 0));
  }
  const tagMigrations = [
    ["Fire", "Shooters"],
    ["Recon", "Skirmishers"],
    ["Cavalry", "Mobile"],
    ["Engineering", "Sappers"],
    ["Monstrous", "Monsters"]
  ];
  for (const side of ["defender", "attacker"]) {
    for (const [legacy, modern] of tagMigrations) {
      const legacyKey = `${side}${legacy}`;
      const modernKey = `${side}${modern}`;
      if ((!source || source[modernKey] === undefined) && source?.[legacyKey] !== undefined) merged[modernKey] = Math.max(0, toNumber(source[legacyKey], 0));
    }
  }
  merged.round = Math.max(1, Math.floor(merged.round || 1));
  merged.defenderPosition = Math.max(0, Math.min(3, Math.floor(merged.defenderPosition || 0)));
  merged.attackerPosition = Math.max(0, Math.min(3, Math.floor(merged.attackerPosition || 0)));
  for (const key of ["title", "enemyName", "objective", "roundThreat", "notes", "attackerPreset", "defenderMobilization", "accessMode"]) merged[key] = String(merged[key] ?? "");
  merged.useDefenseSquads = toBoolean(merged.useDefenseSquads, true);
  merged.raiseMilitia = toBoolean(merged.raiseMilitia, false);
  merged.scale = ["raid", "skirmish", "battle", "siege"].includes(String(merged.scale)) ? String(merged.scale) : "raid";
  merged.defenseMode = ["behindWalls", "outerWorks", "surprised", "outside"].includes(String(merged.defenseMode)) ? String(merged.defenseMode) : "behindWalls";
  merged.accessMode = ["normal", "airborne", "water", "cliff", "portal"].includes(String(merged.accessMode)) ? String(merged.accessMode) : "normal";
  merged.roundThreat = ["assault", "fire", "arson", "sabotage", "panic", "breach", "raid"].includes(String(merged.roundThreat)) ? String(merged.roundThreat) : "assault";
  merged.defenderMobilization = ["watch", "militia", "manual"].includes(String(merged.defenderMobilization)) ? String(merged.defenderMobilization) : "watch";
  if (!merged.attackerPreset) merged.attackerPreset = "custom";
  merged.roundLimit = Math.max(1, Math.floor(merged.roundLimit || 3));
  merged.objectiveThreshold = Math.max(1, Math.floor(merged.objectiveThreshold || 2));

  const legacyStrategyMap = {
    cautious: "deepDefense",
    balanced: "frontalAssault",
    aggressive: "frontalAssault",
    desperate: "frontalAssault",
    defense: "holdFortifications",
    allOutDefense: "holdFortifications",
    sally: "counterattack",
    rally: "deepDefense",
    retreat: "fightingWithdrawal",
    attack: "frontalAssault",
    allOutAssault: "frontalAssault",
    deliberateAssault: "bombardment",
    skirmish: "probingAdvance",
    raid: "raidWithdraw"
  };
  const defenderStrategies = ["holdFortifications", "deepDefense", "counterattack", "protectCivilians", "protectObjective", "fightingWithdrawal", "parley"];
  const attackerStrategies = ["frontalAssault", "probingAdvance", "raidWithdraw", "sabotage", "bombardment", "breakthrough", "parley"];
  merged.defenderStrategy = legacyStrategyMap[String(merged.defenderStrategy)] ?? String(merged.defenderStrategy);
  merged.attackerStrategy = legacyStrategyMap[String(merged.attackerStrategy)] ?? String(merged.attackerStrategy);
  if (!defenderStrategies.includes(merged.defenderStrategy)) merged.defenderStrategy = "holdFortifications";
  if (!attackerStrategies.includes(merged.attackerStrategy)) merged.attackerStrategy = "frontalAssault";

  if (!Array.isArray(merged.log)) merged.log = [];
  merged.log = merged.log.filter((row) => row && typeof row === "object").map((row) => ({
    id: String(row.id || makeId("battle-log")),
    createdAt: String(row.createdAt ?? new Date().toISOString()),
    round: Math.max(1, Math.floor(toNumber(row.round, 1))),
    title: String(row.title ?? "Раунд боя"),
    result: String(row.result ?? ""),
    defenderPool: Math.max(0, Math.floor(toNumber(row.defenderPool, 0))),
    attackerPool: Math.max(0, Math.floor(toNumber(row.attackerPool, 0))),
    defenderSuccesses: Math.max(0, Math.floor(toNumber(row.defenderSuccesses, 0))),
    attackerSuccesses: Math.max(0, Math.floor(toNumber(row.attackerSuccesses, 0))),
    margin: Math.floor(toNumber(row.margin, 0)),
    defenderLossDelta: Math.max(0, Math.floor(toNumber(row.defenderLossDelta, 0))),
    attackerLossDelta: Math.max(0, Math.floor(toNumber(row.attackerLossDelta, 0))),
    settlementDamageDelta: Math.max(0, Math.floor(toNumber(row.settlementDamageDelta, 0))),
    breachDelta: Math.max(0, Math.floor(toNumber(row.breachDelta, 0))),
    objectiveDelta: Math.floor(toNumber(row.objectiveDelta, 0)),
    defenderPositionDelta: Math.floor(toNumber(row.defenderPositionDelta, 0)),
    attackerPositionDelta: Math.floor(toNumber(row.attackerPositionDelta, 0)),
    casualtyText: String(row.casualtyText ?? ""),
    damageText: String(row.damageText ?? "")
  })).slice(-20);
  return merged;
}

function normalizeStorageItemRow(row) {
  if (!row || typeof row !== "object") return null;
  const itemData = isPlainObject(row.itemData) ? clone(row.itemData) : {};
  const system = isPlainObject(itemData.system) ? itemData.system : (isPlainObject(row.system) ? clone(row.system) : {});
  const qty = Math.max(0, toNumber(row.qty ?? row.quantity ?? system.quantity ?? 1, 1));
  return {
    id: String(row.id || makeId("sitem")),
    name: String(row.name ?? itemData.name ?? "Предмет"),
    type: String(row.type ?? itemData.type ?? "gear"),
    img: String(row.img ?? itemData.img ?? "icons/svg/item-bag.svg"),
    qty,
    weight: String(row.weight ?? system.weight ?? ""),
    roomId: String(row.roomId ?? row.storageRoomId ?? "outdoors") || "outdoors",
    sourceActorId: String(row.sourceActorId ?? ""),
    sourceActorName: String(row.sourceActorName ?? ""),
    itemUuid: String(row.itemUuid ?? ""),
    itemData: {
      ...itemData,
      name: String(itemData.name ?? row.name ?? "Предмет"),
      type: String(itemData.type ?? row.type ?? "gear"),
      img: String(itemData.img ?? row.img ?? "icons/svg/item-bag.svg"),
      system
    },
    notes: String(row.notes ?? ""),
    forSale: toBoolean(row.forSale ?? row.sale ?? row.markedForSale, false)
  };
}

function normalizeStorageLogRow(row) {
  if (!row || typeof row !== "object") return null;
  const ts = String(row.ts ?? row.createdAt ?? row.date ?? new Date().toISOString());
  const qty = toNumber(row.qty ?? row.amount ?? 0, 0);
  const resourceId = String(row.resourceId ?? row.resource ?? "custom");
  const name = String(row.name ?? row.resourceName ?? row.label ?? "");
  return {
    id: String(row.id || makeId("slog")),
    ts,
    kind: String(row.kind ?? row.type ?? "manual"),
    resourceId,
    name,
    qty,
    source: String(row.source ?? ""),
    note: String(row.note ?? row.reason ?? ""),
    period: String(row.period ?? "")
  };
}


function normalizeBuilding(building, options = {}) {
  const normalize = normalizeOptions(options);
  building.id = String(building.id || makeId("building"));
  building.templateId = String(building.templateId ?? "");
  building.name = String(building.name ?? "Новый объект");
  building.type = String(building.type ?? "Постройка");
  building.status = String(building.status ?? "Построено");
  building.location = String(building.location ?? "");
  building.effect = String(building.effect ?? "");
  building.production = String(building.production ?? building.produces ?? "");
  building.productionResource = String(building.productionResource ?? "");
  building.productionAmount = toNumber(building.productionAmount, 0);
  building.productionPerWorker = toNumber(building.productionPerWorker, 0);
  building.productionFormula = String(building.productionFormula ?? "");
  building.productionPerDay = toNumber(building.productionPerDay, 0);

  const rawFunctions = isPlainObject(building.functions) ? building.functions : {};
  const hadFunctionFlag = {};
  for (const key of ["production", "income", "defense", "housing", "storage", "culture"]) {
    hadFunctionFlag[key] = Object.prototype.hasOwnProperty.call(rawFunctions, key);
  }
  if (!isPlainObject(building.functions)) building.functions = {};
  for (const key of ["production", "income", "defense", "housing", "storage", "culture"]) building.functions[key] = toBoolean(building.functions[key], false);
  delete building.functions.special;

  if (!Array.isArray(building.productionLines)) {
    const resource = String(building.productionResource ?? "").trim();
    const legacy = String(building.production ?? "").trim();
    building.productionLines = resource ? [{ id: makeId("prod"), active: true, mode: "Всегда", resource, base: building.productionAmount, perWorker: building.productionPerWorker, formula: building.productionFormula, expenses: "" }] : [];
    if (!resource && legacy && !/нет|—|-/.test(legacy.toLowerCase())) building.productionLines = [{ id: makeId("prod"), active: true, mode: "Всегда", resource: legacy, base: 0, perWorker: 0, formula: "", expenses: "" }];
  }
  if (!Array.isArray(building.contents)) building.contents = [];
  building.contents = building.contents.map((item) => ({
    id: String(item?.id || makeId("content")),
    name: String(item?.name ?? item?.label ?? "Содержимое"),
    qty: Math.max(0, toNumber(item?.qty ?? item?.quantity ?? item?.count, 0)),
    capacity: Math.max(0, toNumber(item?.capacity ?? item?.max ?? 0)),
    notes: String(item?.notes ?? "")
  }));

  building.productionLines = building.productionLines.map((line) => {
    const normalized = normalizeProductionLine(line, makeId);
    normalized.active = toBoolean(line?.active, true);
    normalized.base = toNumber(line?.base, 0);
    normalized.perWorker = toNumber(line?.perWorker, 0);
    normalized.source = ["workers", "time", "content"].includes(String(normalized.source ?? "")) ? normalized.source : "workers";
    normalized.period = ["qd", "day", "tenday"].includes(String(normalized.period ?? "")) ? normalized.period : "day";
    normalized.contentId = String(line?.contentId ?? line?.contentKey ?? normalized.contentId ?? "");
    normalized.outputQty = Math.max(0, toNumber(line?.outputQty ?? line?.output ?? line?.quantity ?? normalized.outputQty, (normalized.outputQty || 1)));
    normalized.workQd = Math.max(1, toNumber(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD ?? normalized.workQd, normalized.workQd || 1));
    normalized.expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? normalized.expenseMode ?? "cycle")) ? String(line?.expenseMode ?? normalized.expenseMode ?? "cycle") : "cycle";
    normalized.requiresCollection = toBoolean(line?.requiresCollection ?? line?.collect ?? normalized.requiresCollection, false);
    normalized.collectQd = Math.max(0, toNumber(line?.collectQd ?? line?.collectionQd ?? normalized.collectQd, normalized.collectQd || 0));
    normalized.autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? normalized.autoCollect ?? "none")) ? String(line?.autoCollect ?? normalized.autoCollect ?? "none") : "none";
    normalized.overtime = toBoolean(line?.overtime ?? line?.overwork ?? normalized.overtime, false);
    normalized.pendingQty = Math.max(0, toNumber(line?.pendingQty ?? line?.storedQty ?? line?.readyQty ?? normalized.pendingQty, normalized.pendingQty || 0));
    normalized.storageRoomId = String(line?.storageRoomId ?? line?.roomId ?? normalized.storageRoomId ?? "outdoors") || "outdoors";
    return normalized;
  });

  if (!isPlainObject(building.storage)) building.storage = {};
  building.storage.capacity = Math.max(0, toNumber(building.storage.capacity ?? building.storageCapacity ?? 0, 0));
  building.storage.security = Math.max(0, toNumber(building.storage.security ?? building.storageSecurity ?? 0, 0));
  building.storage.quality = Math.max(0, toNumber(building.storage.quality ?? building.storageQuality ?? 0, 0));

  if (!isPlainObject(building.housing)) building.housing = {};
  building.housing.capacity = Math.max(0, toNumber(building.housing.capacity ?? building.housingCapacity ?? 0, 0));
  building.housing.comfort = toNumber(building.housing.comfort ?? building.housingComfort ?? 0, 0);
  building.housing.quality = Math.max(0, toNumber(building.housing.quality ?? building.housingQuality ?? 0, 0));
  building.housing.notes = String(building.housing.notes ?? "");

  if (!isPlainObject(building.income)) building.income = {};
  building.income.base = toNumber(building.income.base, 0);
  building.income.perWorker = toNumber(building.income.perWorker, 0);
  building.income.formula = String(building.income.formula ?? "");
  building.income.risk = toNumber(building.income.risk, 0);
  building.income.illegal = toBoolean(building.income.illegal, false);
  if (!isPlainObject(building.income.trade)) building.income.trade = {};
  building.income.trade.enabled = toBoolean(building.income.trade.enabled, false);
  building.income.trade.priceEfficiency = Math.max(0, toNumber(building.income.trade.priceEfficiency, 1));
  building.income.trade.budgetFormula = String(building.income.trade.budgetFormula ?? "2d6*10");
  building.income.trade.maxLotsPerBuyer = Math.max(1, Math.floor(toNumber(building.income.trade.maxLotsPerBuyer, 1)));
  building.income.trade.roomId = String(building.income.trade.roomId ?? building.income.trade.storageRoomId ?? "all") || "all";
  building.income.trade.kind = ["all", "resources", "items"].includes(String(building.income.trade.kind ?? building.income.trade.saleKind ?? "all")) ? String(building.income.trade.kind ?? building.income.trade.saleKind ?? "all") : "all";
  building.income.trade.notes = String(building.income.trade.notes ?? "");
  if (!hadFunctionFlag.income && (building.income.base || building.income.perWorker || /деньг|монет|money|coin/i.test(`${building.productionResource} ${building.production}`))) building.functions.income = true;

  if (!isPlainObject(building.defense)) building.defense = {};
  building.defense.base = toNumber(building.defense.base, 0);
  building.defense.perStep = toNumber(building.defense.perStep, 0);
  building.defense.workerStep = toNumber(building.defense.workerStep, 0);
  if (!hadFunctionFlag.defense && (building.defense.base || building.defense.perStep || /стен|башн|гарнизон|оборон|форт|дозор|арсенал|воен|казарм/i.test(`${building.type} ${building.name} ${building.effect}`))) building.functions.defense = true;
  building.reputation = toNumber(building.reputation, 0);
  building.moraleDelta = toNumber(building.moraleDelta, 0);
  building.workerMoraleDelta = toNumber(building.workerMoraleDelta, 0);
  building.upkeep = toNumber(building.upkeep, 0);
  building.notes = String(building.notes ?? "");

  if (!isPlainObject(building.religion)) building.religion = {};
  building.religion.religious = toBoolean(building.religion.religious ?? building.religious, false);
  building.religion.faith = String(building.religion.faith ?? building.religion.name ?? building.faith ?? building.religionFaith ?? "");
  building.religion.customFaith = String(building.religion.customFaith ?? building.religion.custom ?? building.religion.other ?? "");
  building.religion.notes = String(building.religion.notes ?? building.religion.description ?? "");
  if (!hadFunctionFlag.culture && building.religion.religious) building.functions.culture = true;

  if (!Array.isArray(building.materialCosts)) {
    const raw = String(building.rawMaterials ?? "").trim();
    building.materialCosts = raw ? [{ id: makeId("mat"), name: raw, qty: 0 }] : [];
  }
  building.materialCosts = building.materialCosts.map((item) => {
    const name = String(item?.name ?? item?.material ?? "Материал");
    return {
      id: String(item?.id || makeId("mat")),
      resourceId: String(item?.resourceId ?? item?.resource ?? item?.resourceKey ?? normalizeResourceId(name)),
      name,
      qty: toNumber(item?.qty ?? item?.quantity ?? item?.count, 0)
    };
  });

  if (!Array.isArray(building.requiredBuildingIds)) {
    const legacy = Array.isArray(building.requiredBuildings) ? building.requiredBuildings : [];
    building.requiredBuildingIds = legacy.map((item) => String(item?.id ?? item ?? "")).filter(Boolean);
  }
  building.requiredBuildingIds = building.requiredBuildingIds.map((id) => String(id ?? ""));

  if (!isPlainObject(building.requirements)) building.requirements = {};
  building.requirements.food = toNumber(building.requirements.food, 0);
  building.requirements.technology = toNumber(building.requirements.technology, 0);
  building.requirements.culture = toNumber(building.requirements.culture, 0);
  building.requirements.war = toNumber(building.requirements.war, 0);

  if (!isPlainObject(building.bonuses)) building.bonuses = {};
  building.bonuses.food = toNumber(building.bonuses.food, 0);
  building.bonuses.technology = toNumber(building.bonuses.technology, 0);
  building.bonuses.culture = toNumber(building.bonuses.culture, 0);
  building.bonuses.war = toNumber(building.bonuses.war, 0);

  building.workersMin = toNumber(building.workersMin, 0);
  building.workersMax = Math.max(building.workersMin, toNumber(building.workersMax, toNumber(building.workersAssigned, 0) || 1));
  const specialKind = inferBuildingSpecialKind(building);
  if (specialKind) {
    if (!isPlainObject(building.special)) building.special = {};
    building.special.kind = specialKind;
  }
  if (isMedicalBuilding(building)) {
    const def = SPECIAL_BUILDING_KINDS.medical;
    const existingMedical = isPlainObject(building.medical) ? building.medical : {};
    building.medical = {
      ...existingMedical,
      enabled: toBoolean(existingMedical.enabled, true),
      patientsPerEfficiency: Math.max(1, toNumber(existingMedical.patientsPerEfficiency, def.patientsPerEfficiency) || def.patientsPerEfficiency),
      maxPatients: Math.max(0, toNumber(existingMedical.maxPatients ?? existingMedical.capacity, def.defaultMaxPatients) || def.defaultMaxPatients)
    };

    // Normal load must not erase a GM's custom building configuration. The old
    // medical migration force-disabled every normal building function and clamped
    // workers to the curated medical profile. Keep that only for explicit repair.
    if (normalize.destructive) {
      building.workersMin = def.workersMin;
      building.workersMax = Math.min(def.workersMax, Math.max(def.workersMin, toNumber(building.workersMax, def.workersMax) || def.workersMax));
      if (!building.functions || typeof building.functions !== "object") building.functions = {};
      for (const key of ["production", "income", "defense", "housing", "storage", "culture"]) building.functions[key] = false;
    } else {
      building.workersMin = toNumber(building.workersMin, def.workersMin);
      building.workersMax = Math.max(building.workersMin, toNumber(building.workersMax, def.workersMax));
    }

    if (!building.workerRole) building.workerRole = def.workerRole;
    if (!building.workerPrimaryAttribute) building.workerPrimaryAttribute = def.workerPrimaryAttribute;
    if (!Array.isArray(building.productionLines)) building.productionLines = [];
  }
  building.workersAssigned = toNumber(building.workersAssigned, 0);
  if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
  building.assignedWorkerIds = building.assignedWorkerIds.slice(0, Math.max(0, building.workersMax)).map((id) => String(id ?? ""));
  while (building.assignedWorkerIds.length < building.workersMax) building.assignedWorkerIds.push("");

  const workerTypes = normalizeWorkerTypeSet(building.suitableWorkerTypes ?? building.workerTypes ?? "", building.workerTypeEffects);
  building.suitableWorkerTypes = workerTypes.line;
  building.workerTypeEffects = workerTypes.effects;
  building.workerRole = String(building.workerRole ?? "");
  const workerPrimaryAttribute = String(building.workerPrimaryAttribute ?? building.primaryWorkerAttribute ?? "");
  building.workerPrimaryAttribute = ["", "strength", "agility", "wits", "empathy"].includes(workerPrimaryAttribute) ? workerPrimaryAttribute : "";
  building.modifiers = String(building.modifiers ?? "");
  building.buildDifficulty = toNumber(building.buildDifficulty, 0);
  building.buildTarget = Math.max(1, toNumber(building.buildTarget, 6));
  building.buildProgress = Math.max(0, toNumber(building.buildProgress, 0));
  building.constructionStatus = String(building.constructionStatus ?? guessConstructionStatus(building.status));
  if (!["planned", "building", "paused", "damaged", "heavilyDamaged", "destroyed", "built"].includes(building.constructionStatus)) building.constructionStatus = guessConstructionStatus(building.status);
  building.battleDamage = Math.max(0, toNumber(building.battleDamage, 0));
  building.repairTarget = Math.max(0, toNumber(building.repairTarget, 0));
  building.repairProgress = Math.max(0, toNumber(building.repairProgress, 0));
  building.repairOf = String(building.repairOf ?? "");
  building.constructionCrewId = String(building.constructionCrewId ?? building.crewId ?? "");
  if (building.constructionStatus === "building" && building.buildProgress >= building.buildTarget) {
    building.constructionStatus = "built";
    building.status = "Построено";
    building.repairOf = "";
    building.repairProgress = 0;
    building.repairTarget = 0;
  }
}


export function clearPersonReferences(holding, personId) {
  const id = String(personId ?? "");
  if (!id) return;

  for (const building of holding?.buildings?.list ?? []) {
    if (!Array.isArray(building.assignedWorkerIds)) continue;
    building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
  }

  for (const person of holding?.people?.list ?? []) {
    if (String(person?.id ?? "") === id) person.home = "";
  }

  for (const crew of holding?.constructionCrews ?? []) {
    if (Array.isArray(crew.memberIds)) crew.memberIds = crew.memberIds.filter((value) => String(value) !== id);
    if (Array.isArray(crew.distributedIds)) crew.distributedIds = crew.distributedIds.filter((value) => String(value) !== id);
    if (String(crew.leaderId ?? "") === id) crew.leaderId = "";
  }

  if (Array.isArray(holding?.constructionCrewIds)) {
    holding.constructionCrewIds = holding.constructionCrewIds.filter((value) => String(value) !== id);
  }

  const defense = holding?.gm?.defense;
  if (defense && typeof defense === "object") {
    if (String(defense.commanderId ?? "") === id) defense.commanderId = "";
    for (const squad of defense.squads ?? []) {
      if (!squad || typeof squad !== "object") continue;
      if (String(squad.sergeantId ?? "") === id) squad.sergeantId = "";
      if (Array.isArray(squad.memberIds)) squad.memberIds = squad.memberIds.map((value) => String(value ?? "") === id ? "" : value);
    }
  }
}

export function clearBuildingReferences(holding, building) {
  const id = String(building?.id ?? "");
  const name = String(building?.name ?? "");
  if (!id && !name) return;

  for (const person of holding?.people?.list ?? []) {
    const assigned = String(person?.workAssignment ?? "");
    if (assigned === id || (name && assigned === name)) {
      person.workAssignment = "";
      person.role = "Свободен";
    }
    const home = String(person?.home ?? "");
    if (home === id || (name && home === name)) person.home = "";
  }

  for (const candidate of holding?.buildings?.list ?? []) {
    if (!Array.isArray(candidate.requiredBuildingIds)) continue;
    candidate.requiredBuildingIds = candidate.requiredBuildingIds.filter((value) => {
      const text = String(value ?? "");
      return text !== id && (!name || text !== name);
    });
  }
}

function normalizeConstructionCrew(crew, index = 0) {
  const normalized = isPlainObject(crew) ? crew : {};
  normalized.id = String(normalized.id || makeId("crew"));
  normalized.name = String(normalized.name || (index ? `Стройбригада ${index + 1}` : "Стройбригада"));
  normalized.leaderId = String(normalized.leaderId ?? "");
  normalized.suitableWorkerTypes = normalizeWorkerTypeSet(normalized.suitableWorkerTypes ?? "").line;
  if (!Array.isArray(normalized.memberIds)) normalized.memberIds = Array.isArray(normalized.ids) ? normalized.ids : [];
  normalized.memberIds = normalized.memberIds.map((id) => String(id ?? "")).filter(Boolean);
  normalized.distributed = toBoolean(normalized.distributed, false);
  if (!Array.isArray(normalized.distributedIds)) normalized.distributedIds = [];
  normalized.distributedIds = normalized.distributedIds.map((id) => String(id ?? "")).filter(Boolean);
  return normalized;
}

function guessConstructionStatus(status) {
  const text = String(status ?? "").toLowerCase();
  if (/разруш|destroy|ruin/.test(text)) return "destroyed";
  if (/сильно\s*повреж|тяжел|heavy|severe/.test(text)) return "heavilyDamaged";
  if (/повреж|damage/.test(text)) return "damaged";
  if (/постро|работ|готов|active|built/.test(text)) return "built";
  if (/стро|ремонт|repair|construction|building/.test(text)) return "building";
  if (/пауза|paused/.test(text)) return "paused";
  if (/план|проект|planned/.test(text)) return "planned";
  return "built";
}

function normalizePerson(person) {
  person.id = String(person.id || makeId("person"));
  person.name = String(person.name ?? "");
  person.role = String(person.role ?? person.workplace ?? person.work ?? "");
  person.workAssignment = String(person.workAssignment ?? "");
  person.skill = String(person.skill ?? "");
  person.sex = String(person.sex ?? "");
  person.race = String(person.race ?? "");
  person.subrace = String(person.subrace ?? "");
  person.ageGroup = String(person.ageGroup ?? "Вз");
  person.age = person.age === undefined || person.age === null || person.age === ""
    ? representativeAgeForGroup(person.ageGroup, person.race, person.subrace)
    : clampAgeForRace(person.age, person.race, person.subrace);
  person.ageGroup = ageGroupFromAge(person.age, person.race, person.subrace);
  person.culture = String(person.culture ?? "");
  person.belief = normalizeBelief(person.belief ?? "");
  person.background = String(person.background ?? "");
  person.appearance = String(person.appearance ?? "");
  person.traitsText = String(person.traitsText ?? (Array.isArray(person.traits) ? person.traits.join(", ") : ""));
  delete person.workerTypeOverride;
  person.home = String(person.home ?? "");
  person.salary = toNumber(person.salary, 0);
  person.salaryModifier = toNumber(person.salaryModifier, 0);

  const hadAttributes = isPlainObject(person.attributes);
  if (!hadAttributes) person.attributes = {};
  const attributeFallback = hadAttributes ? 3 : 0;
  person.attributes.strength = toNumber(person.attributes.strength, attributeFallback);
  person.attributes.agility = toNumber(person.attributes.agility, attributeFallback);
  person.attributes.wits = toNumber(person.attributes.wits, attributeFallback);
  person.attributes.empathy = toNumber(person.attributes.empathy, attributeFallback);

  const oldMorale = toNumber(person.moraleDelta, null);
  if (person.moraleBase === undefined) person.moraleBase = -1;
  person.moraleBase = toNumber(person.moraleBase, -1);
  person.moraleWork = toNumber(person.moraleWork, 0);
  person.moraleHome = toNumber(person.moraleHome, 0);
  person.moraleManual = person.moraleManual === undefined
    ? (oldMorale === null ? 0 : oldMorale - person.moraleBase - person.moraleWork - person.moraleHome)
    : toNumber(person.moraleManual, 0);
  person.moraleDelta = person.moraleBase + person.moraleWork + person.moraleHome + person.moraleManual;

  const status = String(person.status ?? "").trim();
  const notes = String(person.notes ?? "").trim();
  person.dead = toBoolean(person.dead ?? person.isDead ?? /погиб|мертв|мёртв|dead|deceased/i.test(status), false);
  person.deathDate = String(person.deathDate ?? "");
  person.deathNote = String(person.deathNote ?? "");
  person.injuredDays = Math.max(0, Math.floor(toNumber(person.injuredDays, 0)));
  if (!Array.isArray(person.educationMilestones)) person.educationMilestones = [];
  person.educationMilestones = person.educationMilestones.map((value) => String(value ?? "").trim()).filter(Boolean);
  person.actorUuid = String(person.actorUuid ?? "");
  person.status = person.dead && !status ? "Погиб" : (person.injuredDays > 0 && !/ранен/i.test(status) ? `Ранен (${person.injuredDays} дн.)` : status);
  person.notes = notes;
}
