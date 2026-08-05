import { normalizeProductionLine, normalizeResourceId } from "../../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../../core/building-specials.js";
import { normalizeBuildingOperationalState } from "../../core/building-state.js";
import { normalizeEnterpriseCapital } from "../../core/enterprise-capital.js";
import { normalizeBuildingMaintenance } from "../../core/building-maintenance.js";
import { BROAD_WORKER_TYPE_MAP, CANONICAL_WORKER_TYPES, LEGACY_WORKER_TYPE_MAP } from "../worker-types.js";
import { normalizeConstructionReservation, validConstructionReservation } from "../construction-reservation.js";
import { isPlainObject, makeId, toBoolean, toNumber } from "../utils.js";

function normalizeOptions(options = {}) {
  return { ...options, destructive: toBoolean(options.destructive, false) };
}

function normalizeWorkerTypeName(name = "") {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  const broad = BROAD_WORKER_TYPE_MAP[raw.toLowerCase()];
  if (broad) return broad;
  if (CANONICAL_WORKER_TYPES.has(raw)) return raw;
  return LEGACY_WORKER_TYPE_MAP[raw] ?? "";
}

export function normalizeWorkerTypeSet(value = "", effects = {}) {
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

function ensureUniqueRowIds(rows = [], prefix = "row") {
  const used = new Set();
  return rows.map((row, index) => {
    const base = String(row?.id || `${prefix}-${index + 1}`);
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return id === row?.id ? row : { ...row, id };
  });
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

export function normalizeBuilding(building, options = {}) {
  const normalize = normalizeOptions(options);
  building.id = String(building.id || makeId("building"));
  building.templateId = String(building.templateId ?? "");
  building.name = String(building.name ?? "Новый объект");
  building.type = String(building.type ?? "Постройка");
  building.status = String(building.status ?? "Построено");
  building.location = String(building.location ?? "");
  building.effect = String(building.effect ?? "");
  if (!isPlainObject(building.audio)) building.audio = {};
  {
    const legacyTrack = String(building.audio.track ?? building.audio.src ?? building.soundTrack ?? building.audioTrack ?? "");
    let mode = String(building.audio.mode ?? building.audio.type ?? "").trim();
    if (!["file", "playlist-sound", "playlist"].includes(mode)) {
      if (building.audio.playlistId && building.audio.soundId) mode = "playlist-sound";
      else if (building.audio.playlistId) mode = "playlist";
      else mode = "file";
    }
    building.audio.mode = mode;
    building.audio.track = String(building.audio.track ?? legacyTrack);
    building.audio.src = String(building.audio.src ?? (mode === "file" ? legacyTrack : ""));
    building.audio.playlistId = String(building.audio.playlistId ?? "");
    building.audio.soundId = String(building.audio.soundId ?? "");
    building.audio.volume = Math.min(1, Math.max(0, toNumber(building.audio.volume, 0.45)));
    building.audio.loop = toBoolean(building.audio.loop, true);
  }
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
  building.marketAccessLevel = Math.max(0, Math.min(4, Math.floor(toNumber(building.marketAccessLevel, 0))));
  delete building.functions.special;
  delete building.functions.trade;

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
    resourceId: String(item?.resourceId ?? ""),
    qty: Math.max(0, toNumber(item?.qty ?? item?.quantity ?? item?.count, 0)),
    capacity: Math.max(0, toNumber(item?.capacity ?? item?.max ?? 0)),
    notes: String(item?.notes ?? "")
  }));

  building.productionLines = ensureUniqueRowIds(building.productionLines.map((line) => {
    const normalized = normalizeProductionLine(line, makeId);
    normalized.active = toBoolean(line?.active, true);
    normalized.base = toNumber(line?.base, 0);
    normalized.perWorker = toNumber(line?.perWorker, 0);
    normalized.source = ["workers", "time", "content"].includes(String(normalized.source ?? "")) ? normalized.source : "workers";
    normalized.cadence = ["qd", "day", "tenday", "season", "year"].includes(String(normalized.cadence ?? "")) ? normalized.cadence : "day";
    normalized.cadenceEvery = Math.max(1, Math.floor(toNumber(line?.cadenceEvery ?? normalized.cadenceEvery, normalized.cadenceEvery || 1)));
    normalized.laborQdPerBatch = normalized.source === "workers"
      ? Math.max(1, toNumber(line?.laborQdPerBatch ?? normalized.laborQdPerBatch, normalized.laborQdPerBatch || 1))
      : Math.max(0, toNumber(line?.laborQdPerBatch ?? normalized.laborQdPerBatch, normalized.laborQdPerBatch || 0));
    normalized.maxBatchesPerCadence = Math.max(0, Math.floor(toNumber(line?.maxBatchesPerCadence ?? normalized.maxBatchesPerCadence, normalized.maxBatchesPerCadence || 0)));
    normalized.cadenceKey = String(line?.cadenceKey ?? normalized.cadenceKey ?? "");
    normalized.batchesInCadence = Math.max(0, Math.floor(toNumber(line?.batchesInCadence ?? normalized.batchesInCadence, normalized.batchesInCadence || 0)));
    normalized.period = normalized.cadence;
    normalized.contentId = String(line?.contentId ?? line?.contentKey ?? normalized.contentId ?? "");
    normalized.contentUnitsPerBatch = line?.contentUnitsPerBatch === undefined || line?.contentUnitsPerBatch === null || line?.contentUnitsPerBatch === ""
      ? Math.max(0, Math.floor(toNumber(normalized.contentUnitsPerBatch, 1)))
      : Math.max(0, Math.floor(toNumber(line.contentUnitsPerBatch, 0)));
    normalized.outputQty = Math.max(0, toNumber(line?.outputQty ?? line?.output ?? line?.quantity ?? normalized.outputQty, (normalized.outputQty || 1)));
    normalized.workQd = normalized.source === "workers" ? normalized.laborQdPerBatch : normalized.cadenceEvery;
    normalized.expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? normalized.expenseMode ?? "cycle")) ? String(line?.expenseMode ?? normalized.expenseMode ?? "cycle") : "cycle";
    normalized.requiresCollection = toBoolean(line?.requiresCollection ?? line?.collect ?? normalized.requiresCollection, false);
    normalized.passive = normalized.source !== "workers" && toBoolean(line?.passive, normalized.passive);
    normalized.collectQd = Math.max(0, toNumber(line?.collectQd ?? line?.collectionQd ?? normalized.collectQd, normalized.collectQd || 0));
    normalized.autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? normalized.autoCollect ?? "none")) ? String(line?.autoCollect ?? normalized.autoCollect ?? "none") : "none";
    normalized.overtime = toBoolean(line?.overtime ?? line?.overwork ?? normalized.overtime, false);
    normalized.pendingQty = Math.max(0, toNumber(line?.pendingQty ?? line?.storedQty ?? line?.readyQty ?? normalized.pendingQty, normalized.pendingQty || 0));
    normalized.storageRoomId = String(line?.storageRoomId ?? line?.roomId ?? normalized.storageRoomId ?? "outdoors") || "outdoors";
    return normalized;
  }), "prod");

  if (!isPlainObject(building.storage)) building.storage = {};
  building.storage.capacity = Math.max(0, toNumber(building.storage.capacity ?? building.storageCapacity ?? 0, 0));
  if (building.storage.capacityCargoPoints !== undefined && building.storage.capacityCargoPoints !== null && building.storage.capacityCargoPoints !== "") {
    building.storage.capacityCargoPoints = Math.max(0, Math.floor(toNumber(building.storage.capacityCargoPoints, 0)));
  }
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
  building.income.trade.demandModel = String(building.income.trade.demandModel ?? "legacy") === "settlement" ? "settlement" : "legacy";
  building.income.trade.localDemandPerResident = Math.max(0, toNumber(building.income.trade.localDemandPerResident, 0.08));
  building.income.trade.visitorDemandPerReputation = Math.max(0, toNumber(building.income.trade.visitorDemandPerReputation, 1));
  building.income.trade.visitorDemandPerConnection = Math.max(0, toNumber(building.income.trade.visitorDemandPerConnection, 1));
  building.income.trade.buyersPerWorker = Math.max(0, toNumber(building.income.trade.buyersPerWorker, 8));
  building.income.trade.priceEfficiency = Math.max(0, toNumber(building.income.trade.priceEfficiency, 1));
  building.income.trade.budgetFormula = String(building.income.trade.budgetFormula ?? "2d6*10");
  building.income.trade.maxLotsPerBuyer = Math.max(1, Math.floor(toNumber(building.income.trade.maxLotsPerBuyer, 1)));
  building.income.trade.roomId = String(building.income.trade.roomId ?? building.income.trade.storageRoomId ?? "all") || "all";
  building.income.trade.kind = ["all", "resources", "items"].includes(String(building.income.trade.kind ?? building.income.trade.saleKind ?? "all")) ? String(building.income.trade.kind ?? building.income.trade.saleKind ?? "all") : "all";
  building.income.trade.notes = String(building.income.trade.notes ?? "");
  if (!isPlainObject(building.income.service)) building.income.service = {};
  building.income.service.enabled = toBoolean(building.income.service.enabled, false);
  building.income.service.demandPool = String(building.income.service.demandPool ?? "hospitality").trim() || "hospitality";
  building.income.service.label = String(building.income.service.label ?? "Платные услуги").trim() || "Платные услуги";
  building.income.service.localDemandPerResident = Math.max(0, toNumber(building.income.service.localDemandPerResident, 0.2));
  building.income.service.visitorDemandPerReputation = Math.max(0, toNumber(building.income.service.visitorDemandPerReputation, 2));
  building.income.service.visitorDemandPerConnection = Math.max(0, toNumber(building.income.service.visitorDemandPerConnection, 2));
  building.income.service.servicesPerWorker = Math.max(0, toNumber(building.income.service.servicesPerWorker, 20));
  building.income.service.foodPersonDaysPerService = Math.max(0, toNumber(building.income.service.foodPersonDaysPerService, 0.5));
  building.income.service.visitorRequiresHousing = building.income.service.visitorRequiresHousing === undefined
    ? true
    : toBoolean(building.income.service.visitorRequiresHousing, true);
  building.income.service.inputResourceId = String(building.income.service.inputResourceId ?? "").trim();
  building.income.service.inputQtyPerService = Math.max(0, toNumber(building.income.service.inputQtyPerService, 0));
  building.income.service.priceCopper = Math.max(0, toNumber(building.income.service.priceCopper, 8));
  building.income.service.notes = String(building.income.service.notes ?? "");
  if (!hadFunctionFlag.income && (building.income.base || building.income.perWorker || /деньг|монет|money|coin/i.test(`${building.productionResource} ${building.production}`))) building.functions.income = true;

  if (!isPlainObject(building.defense)) building.defense = {};
  building.defense.base = toNumber(building.defense.base, 0);
  building.defense.perStep = toNumber(building.defense.perStep, 0);
  building.defense.workerStep = toNumber(building.defense.workerStep, 0);
  building.defense.combatTag = String(building.defense.combatTag ?? "garrison").trim() || "garrison";
  if (!hadFunctionFlag.defense && (building.defense.base || building.defense.perStep || /стен|башн|гарнизон|оборон|форт|дозор|арсенал|воен|казарм/i.test(`${building.type} ${building.name} ${building.effect}`))) building.functions.defense = true;
  building.reputation = toNumber(building.reputation, 0);
  building.moraleDelta = toNumber(building.moraleDelta, 0);
  building.workerMoraleDelta = toNumber(building.workerMoraleDelta, 0);
  building.maintenance = normalizeBuildingMaintenance(building.maintenance, building.upkeep, toNumber);
  building.upkeep = building.maintenance.operatingCopperMonthly + building.maintenance.repairReserveCopperMonthly;
  building.notes = String(building.notes ?? "");
  building.enterpriseCapital = normalizeEnterpriseCapital(building.enterpriseCapital, toNumber);

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
  building.materialCosts = ensureUniqueRowIds(building.materialCosts.map((item) => {
    const name = String(item?.name ?? item?.material ?? "Материал");
    return {
      id: String(item?.id || makeId("mat")),
      resourceId: normalizeResourceId(item?.resourceId, item?.resource, item?.resourceKey, name),
      name,
      qty: toNumber(item?.qty ?? item?.quantity ?? item?.count, 0)
    };
  }), "mat");
  const hasMaterialAllocationState = ["materialsAllocated", "materialsAllocatedAt", "materialsAllocatedLine", "constructionReservation"]
    .some((key) => Object.hasOwn(building, key));
  if (hasMaterialAllocationState) {
    building.materialsAllocated = toBoolean(building.materialsAllocated, false);
    building.materialsAllocatedAt = String(building.materialsAllocatedAt ?? "");
    building.materialsAllocatedLine = String(building.materialsAllocatedLine ?? "");
  }
  if (isPlainObject(building.constructionReservation)) {
    building.constructionReservation = normalizeConstructionReservation(building.constructionReservation);
    if (validConstructionReservation(building)) building.materialsAllocated = true;
  } else if (building.constructionReservation !== undefined) {
    building.constructionReservation = null;
  }

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
    if (!isPlainObject(building.special.data)) building.special.data = {};
  }
  if (specialKind === "fasti-shop") {
    building.workersMin = 0;
    building.workersMax = 0;
    const shop = building.special.data;
    shop.unlockCostCopper = Math.max(1, Math.floor(toNumber(shop.unlockCostCopper, 399990)));
    shop.contributedCopper = Math.max(0, Math.min(shop.unlockCostCopper, Math.floor(toNumber(shop.contributedCopper, 0))));
    shop.unlocked = toBoolean(shop.unlocked, false) || shop.contributedCopper >= shop.unlockCostCopper;
    shop.gallery = Array.isArray(shop.gallery) ? shop.gallery.map((value) => String(value ?? "")).filter(Boolean).slice(0, 12) : [];
    const contributionLog = Array.isArray(shop.contributionLog) ? shop.contributionLog : [];
    const retainedContributionLog = normalize.destructive ? contributionLog.slice(-100) : contributionLog;
    shop.contributionLog = retainedContributionLog.map((entry) => ({
      id: String(entry?.id ?? makeId("fasti-log")),
      operationId: String(entry?.operationId ?? ""),
      userId: String(entry?.userId ?? ""),
      userName: String(entry?.userName ?? ""),
      amountCopper: Math.max(0, Math.floor(toNumber(entry?.amountCopper, 0))),
      at: String(entry?.at ?? "")
    }));
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
  normalizeBuildingOperationalState(building);
  building.status = building.constructionStatus === "built" ? "Построено" : building.status;
}

export function normalizeUniqueBuildingWorkers(holding) {
  const buildings = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const people = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
  const workerlessSpecialAssignments = new Set(buildings
    .filter((building) => inferBuildingSpecialKind(building) === "fasti-shop")
    .flatMap((building) => [String(building?.id ?? ""), String(building?.name ?? "")])
    .filter(Boolean));
  for (const person of people.values()) {
    if (!workerlessSpecialAssignments.has(String(person?.workAssignment ?? ""))) continue;
    person.workAssignment = "";
    person.role = "Свободен";
  }
  const occurrences = new Map();
  for (const building of buildings) {
    for (let slot = 0; slot < (building?.assignedWorkerIds ?? []).length; slot += 1) {
      const id = String(building.assignedWorkerIds[slot] ?? "");
      if (!id) continue;
      const rows = occurrences.get(id) ?? [];
      rows.push({ building, slot });
      occurrences.set(id, rows);
    }
  }
  for (const [id, rows] of occurrences) {
    if (rows.length <= 1) continue;
    const preferredBuildingId = String(people.get(id)?.workAssignment ?? "");
    const keep = rows.find((row) => String(row.building?.id ?? "") === preferredBuildingId) ?? rows[0];
    for (const row of rows) {
      if (row === keep) continue;
      row.building.assignedWorkerIds[row.slot] = "";
    }
    const person = people.get(id);
    if (person) person.workAssignment = String(keep.building?.id ?? "");
  }
}
