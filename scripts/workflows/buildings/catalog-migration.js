import {
  DEFAULT_BUILDING_TEMPLATES,
  DEPRECATED_TEMPLATE_IDS,
  TEMPLATE_CATALOG_VERSION
} from "../../data/building-templates.js";
import { normalizeAgricultureBuilding } from "../../data/agriculture.js";
import { normalizeLivestockBuilding } from "../../data/livestock.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { clone } from "../../data/utils.js";
import { workerAdmission } from "../../engines/workers/building-qualification.js";
import { sourceMaterialState } from "../../engines/economy/construction-stages.js";
import { validProductionTiming } from "../../engines/economy/production-timing.js";
import { usesTechnicalMaintenance } from "../../data/economy/maintenance.js";
import { MAINTENANCE_WORK_SOURCE_ID, MAINTENANCE_WORK_FUNCTION_ID } from "../../data/work-allocations.js";
import { BUILDING_CATALOG_V14_TEMPLATES } from "../../data/building-template-v14-catalog.js";
import { buildingCatalogV18Templates } from "../../data/building-template-revision-v18.js";
import { buildingCatalogV17Templates } from "../../data/building-template-revision-v17.js";
import { buildingCatalogV16Templates } from "../../data/building-template-revision-v16.js";
import { buildingCatalogV15Templates } from "../../data/building-template-revision-v15.js";
import { resolveCatalogMechanicalConflicts, PRODUCTION_STATE_FIELDS } from "./catalog-conflicts.js";
import { normalizeCatalogPartition } from "../../data/normalizers.js";
import { normalizeBuilding } from "../../data/normalizers/building.js";

export const BUILDING_CATALOG_MIGRATION_NAMESPACE = "fbl-skyhold.buildings.catalog";
export const BUILDING_CATALOG_MIGRATION_VERSION = TEMPLATE_CATALOG_VERSION;

// Only true identifier replacements belong here. Development-tree upgrades
// are deliberately excluded: upgradesFromTemplateIds is a future player
// action and must never grant a free building during migration.
export const BUILDING_TEMPLATE_ID_ALIASES = Object.freeze({
  field: "grain-field",
  lumberyard: "lumbermill",
  smithy: "forge",
  storehouse: "warehouse",
  tavern: "inn"
});

// The oldest bundled Laputa preset predates templateId. These stable instance
// IDs are an unambiguous identity map, unlike fuzzy matching by a mutable name.
export const KNOWN_LEGACY_BUILDING_INSTANCE_IDS = Object.freeze({
  "laputa-building-house-1": "common-house",
  "laputa-building-house-2": "common-house",
  "laputa-building-well": "well",
  "laputa-building-pigeon-house": "dovecote",
  "laputa-building-pier": "pier",
  "laputa-building-lighthouse": "lighthouse",
  "laputa-building-tavern": "inn",
  "laputa-building-lumbermill": "lumbermill",
  "laputa-building-garden": "garden",
  "laputa-building-pasture": "pasture",
  "laputa-building-quarry": "quarry",
  "laputa-building-tent-camp": "tent-camp",
  "laputa-building-cemetery": "cemetery",
  "laputa-building-warehouse": "warehouse",
  "Ej5bOslhDjKy": "laputa-excavated-crypt",
  "ATr70vKA4na0": "cemetery",
  "7hWwH1qpdroI": "warehouse",
  "b-KurQ68YZNWsg": "fasti-shop"
});

const USER_INSTANCE_FIELDS = Object.freeze([
  "name",
  "visibility",
  "notes",
  "img",
  "image",
  "media",
  "audio",
  "contents",
  "residents",
  "workerAdmissionOverrideIds",
  "serviceProjects"
]);
const LIFECYCLE_FIELDS = Object.freeze([
  "status",
  "constructionStatus",
  "lifecycle",
  "condition",
  "battleDamage",
  "repair",
  "repairOf",
  "repairProgress",
  "repairTarget",
  "constructionCrewId"
]);
const COMPLETE_CONSTRUCTION_STATES = new Set(["built", "damaged", "heavilyDamaged", "destroyed"]);

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object ?? {}, key);
}

function copyOwn(target, source, fields) {
  for (const field of fields) if (own(source, field)) target[field] = clone(source[field]);
}

function rootDependency(data = {}) {
  return {
    revision: whole(data?.meta?.revision),
    templateCatalogVersion: whole(data?.meta?.templateCatalogVersion),
    holdingsHash: stableDataHash(data?.holdings ?? []),
    catalogHash: stableDataHash(data?.catalog ?? {})
  };
}

function productionLineStateful(line = {}) {
  return (line.waitingBatches?.length ?? 0) > 0 || whole(line?.pendingQty) > 0
    || whole(line?.productionBonusRemainder?.units) > 0
    || whole(line?.workProgressUnits) > 0
    || line?.workInputsReserved === true
    || whole(line?.workReservedOutputQty) > 0;
}

// Compare normalized mechanics, ignoring only identity and saved runtime state.
// This is intentionally conservative: a changed recipe must finish before migration.
function canCarryProductionWork(prior, target) {
  if (!target) return false;
  const normalized = [prior, target].map((line) => {
    const building = { productionLines: [clone(line)] };
    normalizeBuilding(building, { mode: "load", destructive: false, preserveTemplateMechanics: true });
    return building.productionLines[0];
  });
  const waiting = prior.waitingBatches ?? [];
  const ids = new Set();
  const states = [...(prior.workInputsReserved || prior.workProgressUnits || prior.workReservedOutputQty ? [prior] : []), ...waiting];
  if (!states.length) return false;
  for (const batch of states) {
    if (batch.workInputsReserved !== true || !Number.isSafeInteger(batch.workReservedOutputQty) || batch.workReservedOutputQty <= 0) return false;
    if (batch.workReservedInputs && batch.workReservedInputs.version !== 1) return false;
    const progress = batch.workProgressUnits ?? 0;
    const timing = batch.workReservedInputs?.timing;
    const id = batch.workReservedInputs?.batchId;
    if (batch !== prior && (!id || batch.id !== id || timing?.phase !== "waiting")) return false;
    if (id && ids.has(id)) return false;
    if (id) ids.add(id);
    if (!Number.isSafeInteger(progress) || progress < 0) return false;
    if (timing) {
      if (!validProductionTiming(timing) || timing.source !== normalized[0].source
        || timing.resourceId !== normalized[0].resourceId
        || progress > timing.workTargetUnits
        || (timing.source === "time" && progress !== 0)
        || (timing.source === "workers" && timing.phase === "waiting" && progress !== timing.workTargetUnits)
        || (timing.phase === "work" && progress >= timing.workTargetUnits)) return false;
    } else if (normalized[0].source !== "workers" || progress >= normalized[0].workQd * 10_000) return false;
  }
  const mechanics = (line) => Object.fromEntries(Object.entries(line).filter(([key]) => key !== "id" && !PRODUCTION_STATE_FIELDS.includes(key)));
  return stableDataHash(mechanics(normalized[0])) === stableDataHash(mechanics(normalized[1]));
}

function matchingProductionLine(sourceLines, targetLine, consumed) {
  const targetId = text(targetLine?.id);
  const sameResource = (line) => text(line?.resourceId) === text(targetLine?.resourceId)
    && (text(targetLine?.resourceId) !== "custom" || text(line?.resource) === text(targetLine?.resource));
  const index = sourceLines.findIndex((line, candidateIndex) => !consumed.has(candidateIndex) && targetId && text(line?.id) === targetId && sameResource(line));
  if (index >= 0) return index;
  const resourceId = text(targetLine?.resourceId);
  const candidates = sourceLines
    .map((line, candidateIndex) => ({ line, candidateIndex }))
    .filter(({ line, candidateIndex }) => !consumed.has(candidateIndex) && resourceId && sameResource(line));
  return candidates.length === 1 ? candidates[0].candidateIndex : -1;
}

function migrateProductionLines(source = {}, target = {}, issues = [], label = "Здание") {
  const sourceLines = Array.isArray(source?.productionLines) ? source.productionLines : [];
  const targetLines = Array.isArray(target?.productionLines) ? clone(target.productionLines) : [];
  const consumed = new Set();
  const matchedLines = new Map();
  for (const line of targetLines) {
    const index = matchingProductionLine(sourceLines, line, consumed);
    if (index < 0) continue;
    consumed.add(index);
    matchedLines.set(index, line);
    const prior = sourceLines[index];
    for (const field of PRODUCTION_STATE_FIELDS) if (own(prior, field)) line[field] = clone(prior[field]);
  }
  for (const [index, line] of sourceLines.entries()) {
    if (!productionLineStateful(line)) continue;
    const matched = consumed.has(index);
    const hasReservedWork = (line.waitingBatches?.length ?? 0) > 0 || whole(line?.workProgressUnits) > 0
      || line?.workInputsReserved === true
      || whole(line?.workReservedOutputQty) > 0;
    if (!matched || (hasReservedWork && !canCarryProductionWork(line, matchedLines.get(index)))) {
      issues.push({
        code: hasReservedWork ? "production-in-progress" : "unmatched-pending-output",
        buildingId: text(source?.id),
        buildingName: label,
        detail: hasReservedWork
          ? `линия «${text(line?.resource) || text(line?.resourceId) || text(line?.id) || "производство"}» имеет незавершённый цикл, который нельзя безопасно перенести: рецепт изменился, линия не найдена или состояние партии неполно. Завершите цикл по прежним правилам и обновите расчёт.`
          : `готовый выпуск линии «${text(line?.resource) || text(line?.resourceId) || text(line?.id) || "производство"}» некуда однозначно перенести`
      });
    }
  }
  return targetLines;
}

function migrateAgriculture(source = {}, target = {}, issues = [], label = "Здание") {
  if (!target?.agriculture) return undefined;
  const prior = source?.agriculture && typeof source.agriculture === "object" ? source.agriculture : {};
  const cropIds = new Set((target.agriculture.crops ?? []).map((crop) => text(crop?.id)).filter(Boolean));
  const activeCropId = cropIds.has(text(prior.activeCropId)) ? text(prior.activeCropId) : text(target.agriculture.activeCropId);
  const stateCropId = text(prior?.state?.cropId);
  const statePhase = text(prior?.state?.phase);
  if (stateCropId && !cropIds.has(stateCropId) && statePhase && statePhase !== "idle") {
    issues.push({
      code: "agriculture-cycle-unmapped",
      buildingId: text(source?.id),
      buildingName: label,
      detail: `сезонный цикл культуры «${stateCropId}» отсутствует в новом профиле`
    });
  }
  return normalizeAgricultureBuilding({
    ...clone(target.agriculture),
    enabled: own(prior, "enabled") ? prior.enabled : target.agriculture.enabled,
    activeCropId,
    outputRoomId: text(prior.outputRoomId) || text(target.agriculture.outputRoomId),
    gmPriority: own(prior, "gmPriority") ? prior.gmPriority : target.agriculture.gmPriority,
    operations: prior.operations ?? target.agriculture.operations,
    state: prior.state ?? target.agriculture.state
  }, { building: target });
}

function livestockHeadcount(value = {}) {
  return whole(value?.state?.adults ?? value?.adults)
    + (value?.state?.young ?? value?.young ?? []).reduce((sum, cohort) => sum + whole(cohort?.qty), 0);
}

function migrateLivestock(source = {}, target = {}, issues = [], label = "Здание") {
  if (!target?.livestock) return undefined;
  const prior = source?.livestock && typeof source.livestock === "object" ? source.livestock : {};
  const targetSpecies = text(target.livestock.speciesId);
  const allowedSpecies = new Set((target.livestock.speciesOptions ?? [targetSpecies]).map(text).filter(Boolean));
  const priorSpecies = text(prior.speciesId);
  if (priorSpecies && !allowedSpecies.has(priorSpecies) && livestockHeadcount(prior) > 0) {
    issues.push({
      code: "livestock-species-unmapped",
      buildingId: text(source?.id),
      buildingName: label,
      detail: `поголовье «${priorSpecies}» несовместимо с новым профилем «${targetSpecies}»`
    });
  }
  const speciesId = allowedSpecies.has(priorSpecies) ? priorSpecies : targetSpecies;
  return normalizeLivestockBuilding({
    ...clone(target.livestock),
    speciesId,
    enabled: own(prior, "enabled") ? prior.enabled : target.livestock.enabled,
    outputRoomId: text(prior.outputRoomId) || text(target.livestock.outputRoomId),
    gmPriority: own(prior, "gmPriority") ? prior.gmPriority : target.livestock.gmPriority,
    operations: prior.operations ?? target.livestock.operations,
    state: prior.state ?? target.livestock.state
  }, { building: target });
}

function preserveConstructionState(source = {}, target = {}) {
  copyOwn(target, source, LIFECYCLE_FIELDS);
  const oldTarget = Math.max(1, whole(source?.buildTarget, 1));
  const newTarget = Math.max(1, whole(target?.buildTarget, 1));
  const oldProgress = Math.min(oldTarget, whole(source?.buildProgress));
  const state = text(source?.constructionStatus || source?.lifecycle);
  if (COMPLETE_CONSTRUCTION_STATES.has(state)) target.buildProgress = newTarget;
  else {
    // An unfinished project keeps its original material contract and stage scale.
    // New template prices never manufacture paid inventory or refundable credit.
    target.buildTarget = oldTarget;
    target.buildProgress = oldProgress;
    target.constructionMaterials = clone(sourceMaterialState({}, source));
    // Material-credit rows have no editor IDs. Supply deterministic IDs here;
    // otherwise normalization invents new IDs on every Preview/Apply replay.
    target.materialCosts = clone(target.constructionMaterials.totalCosts).map((cost, index) => ({
      ...cost, id: `${text(target.id) || "building"}-construction-material-${index + 1}`
    }));
    target.materialsAllocated = source?.materialsAllocated === true;
  }
  if (COMPLETE_CONSTRUCTION_STATES.has(state)) {
    delete target.constructionMaterials;
    delete target.materialsAllocated;
  }
}

function preserveMaintenanceState(source = {}, target = {}) {
  const prior = source?.maintenance && typeof source.maintenance === "object" ? source.maintenance : {};
  const canonical = target?.maintenance && typeof target.maintenance === "object" ? target.maintenance : {};
  target.maintenance = {
    ...clone(canonical),
    priority: own(prior, "priority") ? prior.priority : canonical.priority,
    backlogTendays: whole(prior.backlogTendays),
    needsResolution: prior.needsResolution === true,
    lastOperationId: text(prior.lastOperationId)
  };
}

function preserveSpecialConfiguration(source = {}, target = {}) {
  if (target?.special && typeof target.special === "object") {
    target.special = {
      ...clone(target.special),
      data: {
        ...clone(target.special?.data ?? {}),
        ...clone(source?.special?.data ?? {})
      }
    };
  }
  if (target?.medical?.enabled && source?.medical && typeof source.medical === "object") {
    target.medical = { ...clone(target.medical ?? {}), ...clone(source.medical) };
  }
  if (source?.religion && typeof source.religion === "object") target.religion = clone(source.religion);
}

function preserveTradeSelection(source = {}, target = {}) {
  const prior = source?.income?.trade;
  if (!prior || !target?.income?.trade) return;
  for (const field of ["roomId", "storageRoomId", "kind", "saleKind"]) {
    if (own(prior, field)) target.income.trade[field] = clone(prior[field]);
  }
}

function migrateBuildingInstance(source, targetTemplate, targetId, people, issues) {
  const next = clone(targetTemplate);
  next.id = text(source?.id);
  next.templateId = targetId;
  copyOwn(next, source, USER_INSTANCE_FIELDS);
  next.name = text(source?.name) || text(targetTemplate?.name) || "Здание";
  preserveConstructionState(source, next);
  preserveMaintenanceState(source, next);
  preserveSpecialConfiguration(source, next);
  preserveTradeSelection(source, next);
  next.productionLines = migrateProductionLines(source, next, issues, next.name);
  if (next.agriculture) next.agriculture = migrateAgriculture(source, next, issues, next.name);
  if (next.livestock) next.livestock = migrateLivestock(source, next, issues, next.name);
  if (source?.productionSelection && typeof source.productionSelection === "object") {
    next.productionSelection = { ...clone(next.productionSelection ?? {}), ...clone(source.productionSelection) };
  }
  if (text(source?.fuelChoice) && (next.fuelAlternatives ?? []).some((row) => text(row?.resourceId) === text(source.fuelChoice))) {
    next.fuelChoice = text(source.fuelChoice);
  }
  delete next.serviceState;

  const assigned = Array.isArray(source?.assignedWorkerIds) ? source.assignedWorkerIds.map((id) => text(id)) : [];
  const occupiedPastMaximum = assigned.slice(Math.max(0, whole(next.workersMax))).filter(Boolean);
  if (occupiedPastMaximum.length) {
    issues.push({
      code: "worker-capacity",
      buildingId: next.id,
      buildingName: next.name,
      detail: `назначено ${assigned.filter(Boolean).length} работников при новом максимуме ${whole(next.workersMax)}`
    });
  }
  next.assignedWorkerIds = assigned.slice(0, Math.max(0, whole(next.workersMax)));
  while (next.assignedWorkerIds.length < whole(next.workersMax)) next.assignedWorkerIds.push("");
  const peopleById = new Map((people ?? []).map((person) => [text(person?.id), person]));
  const overrides = new Set((next.workerAdmissionOverrideIds ?? []).map(text).filter(Boolean));
  for (const workerId of next.assignedWorkerIds.filter(Boolean)) {
    const person = peopleById.get(workerId);
    if (!person || !workerAdmission(next, person).eligible) overrides.add(workerId);
  }
  next.workerAdmissionOverrideIds = [...overrides];
  normalizeBuilding(next, { mode: "load", destructive: false, preserveTemplateMechanics: true, people });
  // Contents are player inventory, not part of the catalog revision.
  if (own(source, "contents")) next.contents = clone(source.contents);
  return next;
}

function resolvedTemplateId(building, targetById) {
  const sourceId = text(building?.templateId);
  if (targetById.has(sourceId)) return { targetId: sourceId, mode: "direct" };
  const alias = BUILDING_TEMPLATE_ID_ALIASES[sourceId];
  if (alias && targetById.has(alias)) return { targetId: alias, mode: "alias" };
  if (!sourceId) {
    const known = KNOWN_LEGACY_BUILDING_INSTANCE_IDS[text(building?.id)];
    if (known && targetById.has(known)) return { targetId: known, mode: "known-instance" };
  }
  return { targetId: "", mode: sourceId && DEPRECATED_TEMPLATE_IDS.has(sourceId) ? "deprecated-unmapped" : "custom" };
}

function catalogTarget(currentCatalog = {}, targetById) {
  const sourceRows = Array.isArray(currentCatalog?.buildings) ? currentCatalog.buildings : [];
  const sourceById = new Map(sourceRows.map((row) => [text(row?.id), row]));
  const defaultIds = new Set(targetById.keys());
  const aliasIds = new Set(Object.keys(BUILDING_TEMPLATE_ID_ALIASES));
  const defaults = [...targetById.values()].map((template) => {
    const row = clone(template);
    const prior = sourceById.get(text(row.id));
    if (whole(prior?.templateVersion) >= TEMPLATE_CATALOG_VERSION) return clone(prior);
    if (prior) {
      for (const field of ["unlocked", "visibility"]) if (own(prior, field)) row[field] = clone(prior[field]);
    }
    return row;
  });
  const custom = sourceRows
    .filter((row) => {
      const id = text(row?.id);
      return id && !defaultIds.has(id) && !aliasIds.has(id);
    })
    .map(clone);
  return {
    ...clone(currentCatalog ?? {}),
    buildings: [...defaults, ...custom],
    deletedBuildingTemplateIds: (currentCatalog?.deletedBuildingTemplateIds ?? [])
      .map(text)
      .filter((id) => id && !defaultIds.has(id) && !aliasIds.has(id))
  };
}

function migrationError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "BuildingCatalogMigrationError";
  error.code = code;
  error.details = clone(details);
  return error;
}

function invariant(condition, code, message, details = {}) {
  if (!condition) throw migrationError(code, message, details);
}

export function technicalMaintenanceMigrationIssues(before = {}, after = {}) {
  const prior = new Map((before?.buildings?.list ?? []).map((building) => [text(building.id), building]));
  const converted = (after?.buildings?.list ?? []).filter((building) => usesTechnicalMaintenance(building)
    && prior.has(text(building.id)) && !usesTechnicalMaintenance(prior.get(text(building.id))));
  if (!converted.length) return [];
  return (before?.people?.list ?? []).filter((person) => person?.workAllocationMode === "explicit"
    && (person.workAllocations ?? []).some((assignment) => assignment.sourceId === MAINTENANCE_WORK_SOURCE_ID
      && assignment.functionId === MAINTENANCE_WORK_FUNCTION_ID
      && Number(assignment.normalQd || 0) + Number(assignment.overtimeQd || 0) > 0))
    .map((person) => ({ code: "legacy-maintenance-assignment", holdingId: text(before.id), workerId: text(person.id),
      resolutionKey: stableDataHash({ holdingId: before.id, workerId: person.id, assignments: person.workAllocations,
        targets: converted.map((building) => [building.id, building.maintenance]) }),
      canReleaseMaintenance: true,
      buildingId: text(converted[0].id), buildingName: text(converted[0].name),
      detail: `${text(person.name) || text(person.id)}: общее назначение обслуживания требует явного перераспределения QD по зданиям перед переходом на техническую модель` }));
}

export function planBuildingCatalogMigration({
  currentData = {},
  operationId = "",
  createdAt = new Date().toISOString(),
  resolutions = {},
  replaceCatalog = false
} = {}) {
  invariant(currentData && typeof currentData === "object", "source-data", "Данные мира для Preview отсутствуют.");
  invariant(text(operationId), "operation-id", "Preview миграции требует operationId.");
  const source = rootDependency(currentData);
  const targetTemplates = DEFAULT_BUILDING_TEMPLATES;
  const targetVersion = TEMPLATE_CATALOG_VERSION;
  invariant(source.templateCatalogVersion <= targetVersion, "source-version-newer", "Каталог мира новее этой версии модуля; перенос на старые правила запрещён.");
  const baselineTemplates = source.templateCatalogVersion < 15 ? BUILDING_CATALOG_V14_TEMPLATES
    : source.templateCatalogVersion === 15 ? buildingCatalogV15Templates()
      : source.templateCatalogVersion === 16 ? buildingCatalogV16Templates()
        : source.templateCatalogVersion === 17 ? buildingCatalogV17Templates()
          : source.templateCatalogVersion === 18 ? buildingCatalogV18Templates() : DEFAULT_BUILDING_TEMPLATES;
  const targetById = new Map(targetTemplates.map((template) => [text(template?.id), template]));
  invariant(targetById.size === targetTemplates.length, "target-catalog", "Целевой каталог содержит пустые или повторные ID.");

  const targetData = clone(currentData);
  targetData.catalog = catalogTarget(currentData.catalog, targetById);
  if (replaceCatalog) {
    targetData.catalog.buildings = clone(targetTemplates);
    targetData.catalog.deletedBuildingTemplateIds = [];
  }
  const issues = [];
  const decisions = [];
  {
    for (const target of targetData.catalog.buildings) {
      const saved = (currentData?.catalog?.buildings ?? []).find((row) => text(row.id) === text(target.id));
      const baseline = baselineTemplates.find((row) => row.id === target.id);
      if (replaceCatalog || !saved || !baseline) continue;
      if (whole(saved.templateVersion) >= targetVersion) {
        targetById.set(text(target.id), target);
        continue;
      }
      resolveCatalogMechanicalConflicts({ source: saved, baseline, target,
        scope: { kind: "catalog", id: target.id, name: `Шаблон ${saved.name || saved.id}` }, resolutions, issues, decisions });
      targetById.set(text(target.id), target);
    }
  }
  const rows = [];
  const normalizedTemplates = normalizeCatalogPartition({ buildings: [...targetById.values()] }).buildings;
  for (const template of normalizedTemplates) targetById.set(text(template.id), template);
  targetData.catalog.buildings = targetData.catalog.buildings.map((row) => targetById.get(text(row.id)) ?? row);
  const counts = { direct: 0, alias: 0, knownInstance: 0, custom: 0, deprecatedUnmapped: 0, changed: 0, unchanged: 0 };
  for (const holding of targetData.holdings ?? []) {
    const people = holding?.people?.list ?? [];
    for (let index = 0; index < (holding?.buildings?.list ?? []).length; index += 1) {
      const prior = holding.buildings.list[index];
      const resolution = resolvedTemplateId(prior, targetById);
      if (!resolution.targetId) {
        const deprecated = resolution.mode === "deprecated-unmapped";
        if (replaceCatalog && !deprecated) issues.push({ code: "custom-instance-unmapped",
          holdingId: text(holding.id), holdingName: text(holding.name), buildingId: text(prior.id), buildingName: text(prior.name),
          detail: "У этой постройки нет однозначного шаблона нового дерева. Укажите templateId перед заменой каталога; сама постройка сохранена." });
        counts[deprecated ? "deprecatedUnmapped" : "custom"] += 1;
        if (deprecated) issues.push({
          code: "deprecated-template-unmapped",
          holdingId: text(holding?.id),
          holdingName: text(holding?.name),
          buildingId: text(prior?.id),
          buildingName: text(prior?.name) || text(prior?.id) || "Здание",
          detail: `устаревший templateId «${text(prior?.templateId)}» не имеет безопасного прямого соответствия`
        });
        rows.push({
          holdingId: text(holding?.id),
          holdingName: text(holding?.name),
          buildingId: text(prior?.id),
          buildingName: text(prior?.name) || "Здание",
          sourceTemplateId: text(prior?.templateId),
          targetTemplateId: "",
          mode: resolution.mode,
          changed: false
        });
        continue;
      }
      if (resolution.mode === "direct") counts.direct += 1;
      else if (resolution.mode === "alias") counts.alias += 1;
      else counts.knownInstance += 1;
      const firstIssue = issues.length;
      const selectedTemplate = clone(targetById.get(resolution.targetId));
      // A catalog migration is not a repair of already migrated custom rules.
      if (!replaceCatalog && whole(prior.templateVersion) < targetVersion) resolveCatalogMechanicalConflicts({ source: prior,
        baseline: (currentData?.catalog?.buildings ?? []).find((row) => text(row.id) === (text(prior.templateId) || resolution.targetId))
          ?? baselineTemplates.find((row) => row.id === resolution.targetId),
        target: selectedTemplate, scope: { kind: "instance", holdingId: holding.id, id: prior.id, name: prior.name || prior.id },
        resolutions, issues, decisions });
      const migrated = !replaceCatalog && whole(prior.templateVersion) >= targetVersion
        ? clone(prior)
        : migrateBuildingInstance(prior, selectedTemplate, resolution.targetId, people, issues);
      for (const issue of issues.slice(firstIssue)) Object.assign(issue, { holdingId: text(holding.id), holdingName: text(holding.name) });
      const changed = stableDataHash(prior) !== stableDataHash(migrated);
      counts[changed ? "changed" : "unchanged"] += 1;
      holding.buildings.list[index] = migrated;
      rows.push({
        holdingId: text(holding?.id),
        holdingName: text(holding?.name),
        buildingId: text(prior?.id),
        buildingName: migrated.name,
        sourceTemplateId: text(prior?.templateId),
        targetTemplateId: resolution.targetId,
        mode: resolution.mode,
        changed
      });
    }
  }

  for (const holding of targetData.holdings ?? []) {
    const before = (currentData.holdings ?? []).find((row) => text(row.id) === text(holding.id));
    for (const issue of technicalMaintenanceMigrationIssues(before, holding)) {
      if (replaceCatalog || resolutions[issue.resolutionKey] === "release-maintenance") {
        const person = holding.people.list.find((row) => text(row.id) === issue.workerId);
        const removed = person.workAllocations.filter((row) => row.sourceId === MAINTENANCE_WORK_SOURCE_ID && row.functionId === MAINTENANCE_WORK_FUNCTION_ID);
        person.workAllocations = person.workAllocations.filter((row) => !removed.includes(row));
        decisions.push({ resolutionKey: issue.resolutionKey,
          detail: `${text(person.name) || text(person.id)}: старое общее обслуживание снято в проекте переноса; освобождено ${removed.reduce((sum, row) => sum + whole(row.normalQd) + whole(row.overtimeQd), 0)} QD. Новые технические назначения потребуются отдельно.` });
      } else issues.push(issue);
    }
  }
  const targetCatalogHash = stableDataHash(targetData.catalog);
  const targetHoldingsHash = stableDataHash(targetData.holdings ?? []);
  const catalogChanged = source.catalogHash !== targetCatalogHash;
  const holdingsChanged = source.holdingsHash !== targetHoldingsHash;
  const versionChanged = source.templateCatalogVersion !== targetVersion;
  const hasChanges = catalogChanged || holdingsChanged || versionChanged;
  const marker = {
    namespace: BUILDING_CATALOG_MIGRATION_NAMESPACE,
    version: targetVersion,
    operationId: text(operationId),
    createdAt: text(createdAt),
    sourceTemplateCatalogVersion: source.templateCatalogVersion,
    targetTemplateCatalogVersion: targetVersion,
    sourceRevision: source.revision,
    targetCatalogHash,
    targetHoldingsHash,
    counts: clone(counts)
  };
  targetData.meta = {
    ...clone(targetData.meta ?? {}),
    templateCatalogVersion: targetVersion,
    buildingCatalogMigration: marker
  };
  const blockingIssues = issues.map((issue) => ({ ...issue }));
  return {
    version: targetVersion,
    operationId: text(operationId),
    createdAt: text(createdAt),
    source,
    target: { templateCatalogVersion: targetVersion, catalogHash: targetCatalogHash, holdingsHash: targetHoldingsHash },
    hasChanges,
    canApply: hasChanges && blockingIssues.length === 0,
    blockingIssues,
    decisions,
    rows,
    counts,
    preview: {
      sourceTemplateCatalogVersion: source.templateCatalogVersion,
      targetTemplateCatalogVersion: targetVersion,
      catalogTemplates: targetTemplates.length,
      customCatalogTemplates: targetData.catalog.buildings.length - targetTemplates.length,
      holdings: (targetData.holdings ?? []).length,
      instances: rows.length,
      changedInstances: counts.changed,
      unchangedInstances: counts.unchanged,
      directInstances: counts.direct,
      aliasInstances: counts.alias,
      knownLegacyInstances: counts.knownInstance,
      customInstances: counts.custom,
      unresolvedInstances: counts.deprecatedUnmapped,
      blockingIssues: blockingIssues.length,
      catalogChanged,
      holdingsChanged,
      versionChanged
    },
    targetData
  };
}

export function applyBuildingCatalogMigration({ currentData = {}, plan = null, operationId = "" } = {}) {
  invariant(plan && typeof plan === "object", "plan-missing", "Preview миграции отсутствует.");
  const normalizedOperationId = text(operationId || plan.operationId);
  invariant(normalizedOperationId && normalizedOperationId === text(plan.operationId), "operation-mismatch", "operationId не совпадает с Preview.");
  const existing = currentData?.meta?.buildingCatalogMigration;
  if (text(existing?.operationId) === normalizedOperationId && whole(existing?.version) === BUILDING_CATALOG_MIGRATION_VERSION) {
    return { ok: true, alreadyApplied: true, commitRequired: false, data: clone(currentData) };
  }
  invariant(plan.canApply === true, "plan-blocked", "Preview содержит блокирующие проблемы.", { issues: plan.blockingIssues ?? [] });
  invariant((plan.blockingIssues ?? []).length === 0, "plan-blocked", "Не все решения Preview приняты.");
  invariant(whole(plan?.target?.templateCatalogVersion) === TEMPLATE_CATALOG_VERSION, "target-version-disabled", "Применение этой редакции каталога ещё не включено.");
  invariant(stableDataHash(plan?.targetData?.catalog) === text(plan?.target?.catalogHash)
    && stableDataHash(plan?.targetData?.holdings ?? []) === text(plan?.target?.holdingsHash),
  "prepared-data-changed", "Подготовленные данные изменились после Preview; требуется новый расчёт.");
  const current = rootDependency(currentData);
  invariant(current.revision === whole(plan?.source?.revision), "target-revision", "Данные мира изменились после Preview.", { expected: plan?.source?.revision, actual: current.revision });
  invariant(current.catalogHash === text(plan?.source?.catalogHash), "target-catalog-hash", "Каталог изменился после Preview.");
  invariant(current.holdingsHash === text(plan?.source?.holdingsHash), "target-holdings-hash", "Поселения изменились после Preview.");
  return {
    ok: true,
    alreadyApplied: false,
    commitRequired: true,
    data: clone(plan.targetData),
    marker: clone(plan.targetData?.meta?.buildingCatalogMigration ?? null),
    preview: clone(plan.preview)
  };
}
