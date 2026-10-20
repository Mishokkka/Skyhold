import { normalizeProductionLine, normalizeResourceId } from "../../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../../core/building-specials.js";
import { normalizeBuildingOperationalState } from "../../core/building-state.js";
import { BROAD_WORKER_TYPE_MAP, CANONICAL_WORKER_TYPES, LEGACY_WORKER_TYPE_MAP } from "../worker-types.js";
import { normalizeAgricultureBuilding } from "../agriculture.js";
import { normalizeLivestockBuilding } from "../livestock.js";
import { normalizeInternalDemandTrade } from "../economy/internal-demand.js";
import { normalizeBuildingMaintenance } from "../economy/maintenance.js";
import { isPlainObject, makeId, toBoolean, toNumber } from "../utils.js";
import { normalizeBuildingWorkerProfile, workerAdmission } from "../../engines/workers/building-qualification.js";

function normalizeOptions(options = {}) {
  return { ...options, destructive: toBoolean(options.destructive, false) };
}

function floorNonNegativeQuantity(value, fallback = 0) {
  return Math.max(0, Math.floor(toNumber(value, fallback)));
}

function ceilNonNegativeQuantity(value, fallback = 0) {
  return Math.max(0, Math.ceil(toNumber(value, fallback)));
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
  const hadWorkerProfile = isPlainObject(building?.workerProfile);
  building.id = String(building.id || makeId("building"));
  building.templateId = String(building.templateId ?? "");
  building.name = String(building.name ?? "Новый объект");
  building.type = String(building.type ?? "Постройка");
  building.status = String(building.status ?? "Построено");
  delete building.location;
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
    qty: floorNonNegativeQuantity(item?.qty ?? item?.quantity ?? item?.count, 0),
    capacity: Math.max(0, toNumber(item?.capacity ?? item?.max ?? 0)),
    notes: String(item?.notes ?? "")
  }));
  const livestock = normalizeLivestockBuilding(building.livestock, { building });
  if (livestock) building.livestock = livestock;
  else delete building.livestock;
  const agriculture = normalizeAgricultureBuilding(building.agriculture, { building });
  if (agriculture) building.agriculture = agriculture;
  else delete building.agriculture;

  building.productionLines = ensureUniqueRowIds(building.productionLines.map((line) => {
    const normalized = normalizeProductionLine(line, makeId);
    normalized.active = toBoolean(line?.active, true);
    normalized.base = toNumber(line?.base, 0);
    normalized.perWorker = toNumber(line?.perWorker, 0);
    normalized.source = ["workers", "time", "content"].includes(String(normalized.source ?? "")) ? normalized.source : "workers";
    normalized.period = ["qd", "day", "tenday"].includes(String(normalized.period ?? "")) ? normalized.period : "day";
    normalized.contentId = String(line?.contentId ?? line?.contentKey ?? normalized.contentId ?? "");
    normalized.outputQty = floorNonNegativeQuantity(line?.outputQty ?? line?.output ?? line?.quantity ?? normalized.outputQty, normalized.outputQty || 1);
    normalized.workQd = Math.max(1, ceilNonNegativeQuantity(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD ?? normalized.workQd, normalized.workQd || 1));
    normalized.expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? normalized.expenseMode ?? "cycle")) ? String(line?.expenseMode ?? normalized.expenseMode ?? "cycle") : "cycle";
    normalized.requiresCollection = toBoolean(line?.requiresCollection ?? line?.collect ?? normalized.requiresCollection, false);
    normalized.collectQd = ceilNonNegativeQuantity(line?.collectQd ?? line?.collectionQd ?? normalized.collectQd, normalized.collectQd || 0);
    normalized.autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? normalized.autoCollect ?? "none")) ? String(line?.autoCollect ?? normalized.autoCollect ?? "none") : "none";
    normalized.overtime = toBoolean(line?.overtime ?? line?.overwork ?? normalized.overtime, false);
    normalized.workProgressUnits = floorNonNegativeQuantity(line?.workProgressUnits ?? normalized.workProgressUnits, 0);
    normalized.workInputsReserved = toBoolean(line?.workInputsReserved ?? normalized.workInputsReserved, false);
    normalized.workReservedOutputQty = floorNonNegativeQuantity(line?.workReservedOutputQty ?? normalized.workReservedOutputQty, 0);
    normalized.workReservedFormula = String(line?.workReservedFormula ?? normalized.workReservedFormula ?? "");
    if (isPlainObject(line?.workReservedInputs)) normalized.workReservedInputs = structuredClone(line.workReservedInputs);
    const timing = normalized.workReservedInputs?.timing;
    const workTargetUnits = timing?.workTargetUnits ?? normalized.workQd * 10_000;
    if (timing?.phase !== "waiting" && normalized.workProgressUnits >= workTargetUnits) normalized.workProgressUnits %= workTargetUnits;
    if (!normalized.workInputsReserved || normalized.workReservedOutputQty <= 0) {
      normalized.workInputsReserved = false;
      normalized.workProgressUnits = 0;
      normalized.workReservedOutputQty = 0;
      normalized.workReservedFormula = "";
      delete normalized.workReservedInputs;
    }
    normalized.requiresGmConfirmation = toBoolean(line?.requiresGmConfirmation ?? normalized.requiresGmConfirmation, false);
    normalized.wageDailyCopper = floorNonNegativeQuantity(line?.wageDailyCopper ?? normalized.wageDailyCopper, 0);
    normalized.operatingUpkeepMonthlyCopper = floorNonNegativeQuantity(line?.operatingUpkeepMonthlyCopper ?? normalized.operatingUpkeepMonthlyCopper, 0);
    normalized.pendingQty = floorNonNegativeQuantity(line?.pendingQty ?? line?.storedQty ?? line?.readyQty ?? normalized.pendingQty, normalized.pendingQty || 0);
    normalized.storageRoomId = String(line?.storageRoomId ?? line?.roomId ?? normalized.storageRoomId ?? "outdoors") || "outdoors";
    return normalized;
  }), "prod");
  if (!isPlainObject(building.productionSelection)) building.productionSelection = {};
  building.productionSelection.exclusive = toBoolean(building.productionSelection.exclusive, false);
  building.productionSelection.gmConfirmed = toBoolean(building.productionSelection.gmConfirmed, false);
  if (building.productionSelection.exclusive) {
    let foundActive = false;
    for (const line of building.productionLines) {
      if (line.active === false) continue;
      if (!foundActive) foundActive = true;
      else line.active = false;
    }
  }
  if (!building.productionSelection.gmConfirmed) {
    for (const line of building.productionLines) if (line.requiresGmConfirmation) line.active = false;
  }
  building.fuelAlternatives = (Array.isArray(building.fuelAlternatives) ? building.fuelAlternatives : [])
    .map((row) => ({
      resourceId: normalizeResourceId(row?.resourceId, row?.name),
      qty: ceilNonNegativeQuantity(row?.qty, 0),
      label: String(row?.label ?? row?.name ?? "")
    }))
    .filter((row) => row.resourceId !== "custom" && row.qty > 0);
  const fuelIds = new Set(building.fuelAlternatives.map((row) => row.resourceId));
  building.fuelChoice = String(building.fuelChoice ?? "");
  if (building.fuelAlternatives.length && !fuelIds.has(building.fuelChoice)) building.fuelChoice = building.fuelAlternatives[0].resourceId;

  if (!isPlainObject(building.storage)) building.storage = {};
  building.storage.capacity = Math.max(0, toNumber(building.storage.capacity ?? building.storageCapacity ?? 0, 0));
  building.storage.security = Math.max(0, toNumber(building.storage.security ?? building.storageSecurity ?? 0, 0));
  building.storage.quality = Math.max(0, toNumber(building.storage.quality ?? building.storageQuality ?? 0, 0));
  const shelfLifeMultiplierFallback = String(building.templateId ?? building.id ?? "") === "root-cellar" ? 2 : 1;
  building.storage.shelfLifeMultiplier = Math.max(1, toNumber(
    Object.hasOwn(building.storage, "shelfLifeMultiplier") ? building.storage.shelfLifeMultiplier : shelfLifeMultiplierFallback,
    shelfLifeMultiplierFallback
  ));
  building.storage.profileLabel = String(building.storage.profileLabel ?? "").trim();
  building.storage.profileResourceIds = (Array.isArray(building.storage.profileResourceIds)
    ? building.storage.profileResourceIds
    : String(building.storage.profileResourceIds ?? "").split(/[,;\n]/))
    .map((value) => String(value ?? "").trim()).filter(Boolean);
  building.storage.profileCategoryTags = (Array.isArray(building.storage.profileCategoryTags)
    ? building.storage.profileCategoryTags
    : String(building.storage.profileCategoryTags ?? "").split(/[,;\n]/))
    .map((value) => String(value ?? "").trim()).filter(Boolean);
  building.storage.profileMarketTags = (Array.isArray(building.storage.profileMarketTags)
    ? building.storage.profileMarketTags
    : String(building.storage.profileMarketTags ?? "").split(/[,;\n]/))
    .map((value) => String(value ?? "").trim()).filter(Boolean);
  building.storage.autoReceive = toBoolean(building.storage.autoReceive, false);
  building.storage.profilePerishableFood = toBoolean(building.storage.profilePerishableFood, false);
  building.storage.profileCapacityMultiplier = Math.max(0.01, Math.min(1, toNumber(building.storage.profileCapacityMultiplier, 1)));
  building.storage.profileRequiresStaff = toBoolean(building.storage.profileRequiresStaff, false);

  if (!isPlainObject(building.housing)) building.housing = {};
  building.housing.capacity = Math.max(0, toNumber(building.housing.capacity ?? building.housingCapacity ?? 0, 0));
  building.housing.comfort = toNumber(building.housing.comfort ?? building.housingComfort ?? 0, 0);
  building.housing.staffedComfort = toNumber(building.housing.staffedComfort, building.housing.comfort);
  building.housing.quality = Math.max(0, toNumber(building.housing.quality ?? building.housingQuality ?? 0, 0));
  building.housing.notes = String(building.housing.notes ?? "");

  if (!isPlainObject(building.income)) building.income = {};
  building.income.base = toNumber(building.income.base, 0);
  building.income.perWorker = toNumber(building.income.perWorker, 0);
  building.income.formula = String(building.income.formula ?? "");
  building.income.risk = toNumber(building.income.risk, 0);
  building.income.illegal = toBoolean(building.income.illegal, false);
  building.income.wageDailyCopper = floorNonNegativeQuantity(building.income.wageDailyCopper, 0);
  building.income.operatingUpkeepMonthlyCopper = floorNonNegativeQuantity(building.income.operatingUpkeepMonthlyCopper, 0);
  building.income.trade = normalizeInternalDemandTrade(building.income.trade, { building });
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
  building.developmentStage = Math.max(0, Math.min(7, Math.floor(toNumber(building.developmentStage, 0))));
  building.requiresConstructionCenter = toBoolean(building.requiresConstructionCenter, building.developmentStage >= 4);
  building.repeatSettlementEffects = toBoolean(building.repeatSettlementEffects, false);
  building.siteRequirementsText = String(building.siteRequirementsText ?? "");
  building.activationConditionText = String(building.activationConditionText ?? "");
  if (!isPlainObject(building.activation)) building.activation = {};
  building.activation.minWorkers = floorNonNegativeQuantity(building.activation.minWorkers, 0);
  building.activation.minOperationalQd = floorNonNegativeQuantity(
    building.activation.minOperationalQd ?? building.minOperationalQd,
    0
  );
  building.activation.requiresMeaningfulResult = toBoolean(building.activation.requiresMeaningfulResult, false);
  building.minOperationalQd = building.activation.minOperationalQd;
  if (!Array.isArray(building.upgradesFromTemplateIds)) building.upgradesFromTemplateIds = [];
  building.upgradesFromTemplateIds = [...new Set(building.upgradesFromTemplateIds
    .map((id) => String(id ?? "").trim())
    .filter(Boolean))];
  if (isPlainObject(building.service)) {
    building.service.capacity = floorNonNegativeQuantity(building.service.capacity, 0);
    building.service.capacityBase = floorNonNegativeQuantity(building.service.capacityBase, 0);
    building.service.capacityPerWorker = floorNonNegativeQuantity(building.service.capacityPerWorker, 0);
    building.service.capacityPerWorkerStep = floorNonNegativeQuantity(building.service.capacityPerWorkerStep, 0);
    building.service.workerStep = Math.max(1, floorNonNegativeQuantity(building.service.workerStep, 1));
    building.service.maximumCapacity = floorNonNegativeQuantity(building.service.maximumCapacity, 0);
    building.service.coverageKind = ["population", "buildings", "target-buildings", "patients"]
      .includes(String(building.service.coverageKind ?? ""))
      ? String(building.service.coverageKind)
      : "population";
    if (!Array.isArray(building.service.coveredBuildingIds)) building.service.coveredBuildingIds = [];
    building.service.coveredBuildingIds = [...new Set(building.service.coveredBuildingIds
      .map((id) => String(id ?? "").trim())
      .filter(Boolean))];
    if (isPlainObject(building.service.leisure)) {
      const leisure = building.service.leisure;
      leisure.kind = String(leisure.kind ?? "").trim();
      leisure.capacity = floorNonNegativeQuantity(leisure.capacity, 0);
      leisure.qdPerCapacity = Math.max(0.01, toNumber(leisure.qdPerCapacity, 1));
      if (Object.hasOwn(leisure, "minWorkers")) leisure.minWorkers = floorNonNegativeQuantity(leisure.minWorkers, 0);
      leisure.functionId = ["culture", "income", "production", "defense", "storage"]
        .includes(String(leisure.functionId ?? "")) ? String(leisure.functionId) : "culture";
    } else {
      delete building.service.leisure;
    }
  } else {
    delete building.service;
  }
  if (isPlainObject(building.control)) {
    for (const key of ["generalPerWorker", "generalFlat", "unrestOnlyPerWorker", "unrestOnlyFlat", "maximum", "capacity"]) {
      building.control[key] = floorNonNegativeQuantity(building.control[key], 0);
    }
    const ceiling = building.control.ceiling === null || building.control.ceiling === "" ? NaN : Number(building.control.ceiling);
    building.control.ceiling = Number.isFinite(ceiling) ? Math.max(-1000, Math.min(0, Math.floor(ceiling))) : null;
  } else {
    delete building.control;
  }
  if (!Array.isArray(building.serviceProjects)) building.serviceProjects = [];
  building.serviceProjects = building.serviceProjects.map((project) => ({
    id: String(project?.id || makeId("service-project")),
    kind: String(project?.kind ?? "project"),
    title: String(project?.title ?? "Проект"),
    status: ["planned", "active", "paused", "completed", "cancelled"].includes(String(project?.status ?? ""))
      ? String(project.status)
      : "planned",
    progressQd: floorNonNegativeQuantity(project?.progressQd, 0),
    targetQd: Math.max(1, floorNonNegativeQuantity(project?.targetQd, 1)),
    participantIds: [...new Set((Array.isArray(project?.participantIds) ? project.participantIds : [])
      .map((id) => String(id ?? "").trim()).filter(Boolean))],
    targetIds: [...new Set((Array.isArray(project?.targetIds) ? project.targetIds : [])
      .map((id) => String(id ?? "").trim()).filter(Boolean))],
    resourceCosts: (Array.isArray(project?.resourceCosts) ? project.resourceCosts : []).map((cost) => ({
      resourceId: normalizeResourceId(cost?.resourceId, cost?.name),
      qty: ceilNonNegativeQuantity(cost?.qty, 0)
    })).filter((cost) => cost.resourceId !== "custom" && cost.qty > 0),
    notes: String(project?.notes ?? ""),
    gmDecisionStatus: ["none", "pending", "approved", "rejected"].includes(String(project?.gmDecisionStatus ?? ""))
      ? String(project.gmDecisionStatus)
      : "none"
  }));
  // Reasons are derived from current workers, QD, finance, dependencies and
  // maintenance. Never persist a stale diagnostic snapshot on the building.
  delete building.blockReasons;
  building.upkeep = toNumber(building.upkeep, 0);
  building.wageDailyCopper = floorNonNegativeQuantity(building.wageDailyCopper, 0);
  building.baseUpkeepMonthlyCopper = floorNonNegativeQuantity(building.baseUpkeepMonthlyCopper, 0);
  building.operatingUpkeepMonthlyCopper = floorNonNegativeQuantity(building.operatingUpkeepMonthlyCopper, 0);
  building.maintenance = normalizeBuildingMaintenance(building.maintenance);
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
  building.materialCosts = ensureUniqueRowIds(building.materialCosts.map((item) => {
    const name = String(item?.name ?? item?.material ?? "Материал");
    return {
      id: String(item?.id || makeId("mat")),
      resourceId: normalizeResourceId(item?.resourceId, item?.resource, item?.resourceKey, name),
      resourceGroup: String(item?.resourceGroup ?? "").trim(),
      name,
      qty: ceilNonNegativeQuantity(item?.qty ?? item?.quantity ?? item?.count, 0)
    };
  }), "mat");

  if (!Array.isArray(building.requiredBuildingIds)) {
    const legacy = Array.isArray(building.requiredBuildings) ? building.requiredBuildings : [];
    building.requiredBuildingIds = legacy.map((item) => String(item?.id ?? item ?? "")).filter(Boolean);
  }
  building.requiredBuildingIds = building.requiredBuildingIds.map((id) => String(id ?? "").trim());
  if (!Array.isArray(building.requiredAnyBuildingIds)) building.requiredAnyBuildingIds = [];
  building.requiredAnyBuildingIds = building.requiredAnyBuildingIds.map((id) => String(id ?? "").trim());
  if (isPlainObject(building.prerequisiteModes)) {
    building.prerequisiteModes = Object.fromEntries(Object.entries(building.prerequisiteModes)
      .filter(([id, mode]) => String(id).trim() && ["construction", "service"].includes(mode))
      .map(([id, mode]) => [String(id).trim(), mode]));
  }

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
    // The story shop is deliberately workerless. Clear legacy slots before
    // worker-profile normalization so stale assignments cannot restore a
    // capacity that the special-building contract explicitly forbids.
    building.assignedWorkerIds = [];
    building.workerAdmissionOverrideIds = [];
    const shop = building.special.data;
    shop.unlockCostCopper = Math.max(1, Math.floor(toNumber(shop.unlockCostCopper, 399990)));
    shop.contributedCopper = Math.max(0, Math.min(shop.unlockCostCopper, Math.floor(toNumber(shop.contributedCopper, 0))));
    shop.unlocked = toBoolean(shop.unlocked, false) || shop.contributedCopper >= shop.unlockCostCopper;
    shop.gallery = Array.isArray(shop.gallery) ? shop.gallery.map((value) => String(value ?? "")).filter(Boolean).slice(0, 12) : [];
    shop.contributionLog = Array.isArray(shop.contributionLog) ? shop.contributionLog.slice(-100).map((entry) => ({
      id: String(entry?.id ?? makeId("fasti-log")),
      operationId: String(entry?.operationId ?? ""),
      userId: String(entry?.userId ?? ""),
      userName: String(entry?.userName ?? ""),
      amountCopper: Math.max(0, Math.floor(toNumber(entry?.amountCopper, 0))),
      at: String(entry?.at ?? "")
    })) : [];
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
    if (!Array.isArray(building.productionLines)) building.productionLines = [];
  }
  building.workersAssigned = toNumber(building.workersAssigned, 0);
  if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
  const introducedWorkerProfile = !hadWorkerProfile;
  // Catalog loading must not discover new admission rules by ID/name. An
  // explicit neutral profile also prevents consumers from falling back to the
  // newer built-in profile later. Explicit repair retains curated inference.
  const workerProfile = normalizeBuildingWorkerProfile(
    !hadWorkerProfile && normalize.preserveTemplateMechanics ? { source: "legacy" } : building.workerProfile, building
  );
  if (workerProfile) {
    building.workerProfile = workerProfile;
    if (introducedWorkerProfile) building.workersMin = workerProfile.workersMin;
    const lastOccupiedSlot = building.assignedWorkerIds.reduce((last, id, index) => String(id ?? "") ? index : last, -1) + 1;
    building.workersMax = Math.max(introducedWorkerProfile ? workerProfile.workersMax : building.workersMax, lastOccupiedSlot);
  } else {
    delete building.workerProfile;
  }
  building.assignedWorkerIds = building.assignedWorkerIds.slice(0, Math.max(0, building.workersMax)).map((id) => String(id ?? ""));
  while (building.assignedWorkerIds.length < building.workersMax) building.assignedWorkerIds.push("");
  if (!Array.isArray(building.workerAdmissionOverrideIds)) building.workerAdmissionOverrideIds = [];
  building.workerAdmissionOverrideIds = [...new Set(building.workerAdmissionOverrideIds.map((id) => String(id ?? "")).filter(Boolean))];
  if (introducedWorkerProfile && workerProfile?.admission?.hard) {
    // The worker migration is non-destructive: existing assignments remain in
    // place. When resident data is available, only workers who actually fail
    // the new hard gate receive a grandfathered GM override.
    const people = Array.isArray(normalize.people) ? normalize.people : null;
    const peopleById = people ? new Map(people.map((person) => [String(person?.id ?? ""), person])) : null;
    const grandfatheredIds = building.assignedWorkerIds.filter((id) => {
      const workerId = String(id ?? "");
      if (!workerId) return false;
      if (!peopleById) return true;
      const person = peopleById.get(workerId);
      return !person || !workerAdmission(building, person).eligible;
    });
    building.workerAdmissionOverrideIds = [...new Set([
      ...building.workerAdmissionOverrideIds,
      ...grandfatheredIds
    ])];
  }
  delete building.workerPrimaryAttribute;
  delete building.primaryWorkerAttribute;
  delete building.suitableWorkerTypes;
  delete building.workerTypeEffects;
  delete building.workerTypes;
  building.workerRole = String(building.workerRole ?? "");
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
