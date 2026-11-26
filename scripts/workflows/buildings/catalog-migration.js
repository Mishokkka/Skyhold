import {
  DEFAULT_BUILDING_TEMPLATES,
  BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION,
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
import { buildWorkAllocationTargets } from "../../data/work-allocations.js";
import { buildingLaborMode, validateHybridLaborHolding } from "../../data/hybrid-labor.js";
import { normalizeCatalogPartition } from "../../data/normalizers.js";
import { normalizeBuilding } from "../../data/normalizers/building.js";

export const BUILDING_CATALOG_MIGRATION_NAMESPACE = "fbl-skyhold.buildings.catalog";
export const BUILDING_CATALOG_MIGRATION_VERSION = TEMPLATE_CATALOG_VERSION;
const EMPTY_MIGRATION_COUNTS = Object.freeze({ direct: 0, custom: 0, deprecatedUnmapped: 0, changed: 0, unchanged: 0 });

export const PRODUCTION_STATE_FIELDS = Object.freeze([
  "active", "autoCollect", "storageRoomId", "pendingQty", "workProgressUnits",
  "workInputsReserved", "workReservedOutputQty", "workReservedFormula", "workReservedInputs", "productionBonusRemainder", "waitingBatches"
]);

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
const LABOR_DEPENDENT_FIELDS = ["workersMin", "workersMax", "workerProfile", "activation", "minOperationalQd", "activationConditionText", "workerRole"];
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

function preserveLaborConfiguration(source, target, legacyDefaults) {
  const sourceMode = buildingLaborMode(source);
  if (sourceMode !== buildingLaborMode(target)) {
    const laborFields = sourceMode === "legacy" ? legacyDefaults : source;
    if (laborFields) {
      for (const field of LABOR_DEPENDENT_FIELDS) {
        if (own(laborFields, field)) target[field] = clone(laborFields[field]);
        else delete target[field];
      }
    }
  }
  // Recipe refresh and employment changes have separate previews.
  if (own(source, "labor")) target.labor = clone(source.labor);
  else delete target.labor;
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
    normalizeBuilding(building, { mode: "load", preserveTemplateMechanics: true });
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

function agricultureCycleConflict(prior, next) {
  const { phase, cropId } = prior.state;
  if (phase === "empty") return "";
  const crop = prior.crops.find((row) => row.id === cropId);
  const replacement = next?.crops.find((row) => row.id === cropId);
  if (!crop || !replacement || next.activeCropId !== cropId) return "культура цикла недоступна в новом профиле";
  if (replacement.resourceId !== crop.resourceId) {
    return `ресурс урожая меняется с «${crop.resourceId}» на «${replacement.resourceId}»`;
  }
  if (replacement.expiryRule !== "never" && (
    replacement.expiryRule !== crop.expiryRule
    || (crop.expiryRule === "qd" && replacement.readyExpiryQd < crop.readyExpiryQd)
  )) return "новое правило срока может привести к преждевременной гибели урожая";
  if ((phase === "sowing" || phase === "growing") && (
    replacement.growingQd !== crop.growingQd
    || replacement.outputQty !== crop.outputQty
    || replacement.harvestWorkQd !== crop.harvestWorkQd
  )) return "меняются сроки созревания, объём урожая или труд на сбор";
  if (phase === "sowing" && (
    replacement.sowingWorkQd !== crop.sowingWorkQd || replacement.perennial !== crop.perennial
    || crop.sowingSeasons.some((season) => !replacement.sowingSeasons.includes(season))
  )) return "меняются условия незавершённого посева";
  return "";
}

function migrateAgriculture(source, target, issues, label) {
  const saved = source.agriculture;
  const prior = saved && normalizeAgricultureBuilding(saved, { building: source, includeInactive: true });
  if (prior && source.functions?.production === false && target.functions?.production === false) return prior;
  const canonical = target.agriculture;
  const activeCropId = text(saved?.activeCropId);
  const next = canonical && normalizeAgricultureBuilding({
    ...canonical,
    enabled: saved?.enabled ?? canonical.enabled,
    activeCropId: canonical.crops?.some((crop) => crop.id === activeCropId) ? activeCropId : canonical.activeCropId,
    outputRoomId: text(saved?.outputRoomId) || canonical.outputRoomId,
    gmPriority: saved?.gmPriority ?? canonical.gmPriority,
    operations: saved?.operations ?? canonical.operations,
    state: prior?.state ?? canonical.state
  }, { building: target, includeInactive: true });
  const conflict = prior && agricultureCycleConflict(prior, target.functions?.production === false ? null : next);
  if (conflict) {
    issues.push({
      code: "agriculture-cycle-incompatible",
      buildingId: text(source.id),
      buildingName: label,
      detail: `Сезонный цикл «${prior.state.cropId}» нельзя перенести: ${conflict}. Завершите цикл и обновите расчёт.`
    });
  }
  return next;
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

function migrateBuildingInstance(source, targetTemplate, targetId, people, issues, legacyDefaults) {
  const next = clone(targetTemplate);
  next.id = text(source?.id);
  next.templateId = targetId;
  copyOwn(next, source, USER_INSTANCE_FIELDS);
  preserveLaborConfiguration(source, next, legacyDefaults);
  next.name = text(source?.name) || text(targetTemplate?.name) || "Здание";
  preserveConstructionState(source, next);
  preserveSpecialConfiguration(source, next);
  preserveTradeSelection(source, next);
  next.productionLines = migrateProductionLines(source, next, issues, next.name);
  next.agriculture = migrateAgriculture(source, next, issues, next.name);
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
  normalizeBuilding(next, { mode: "load", preserveTemplateMechanics: true, people });
  // Contents are player inventory, not part of the catalog revision.
  if (own(source, "contents")) next.contents = clone(source.contents);
  return next;
}

function catalogTarget(currentCatalog = {}, targetById) {
  const sourceRows = Array.isArray(currentCatalog?.buildings) ? currentCatalog.buildings : [];
  const sourceById = new Map(sourceRows.map((row) => [text(row?.id), row]));
  const defaultIds = new Set(targetById.keys());
  const defaults = [...targetById.values()].map((template) => clone(sourceById.get(text(template.id)) ?? template));
  const custom = sourceRows
    .filter((row) => {
      const id = text(row?.id);
      return id && !defaultIds.has(id);
    })
    .map(clone);
  return {
    ...clone(currentCatalog ?? {}),
    buildings: [...defaults, ...custom],
    deletedBuildingTemplateIds: (currentCatalog?.deletedBuildingTemplateIds ?? [])
      .map(text)
      .filter((id) => id && !defaultIds.has(id))
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

export function planBuildingCatalogMigration({
  currentData = {},
  operationId = "",
  createdAt = new Date().toISOString(),
  replaceCatalog = false
} = {}) {
  invariant(currentData && typeof currentData === "object", "source-data", "Данные мира для Preview отсутствуют.");
  invariant(text(operationId), "operation-id", "Preview миграции требует operationId.");
  const source = rootDependency(currentData);
  const targetVersion = TEMPLATE_CATALOG_VERSION;
  invariant(source.templateCatalogVersion <= targetVersion, "source-version-newer", "Каталог мира новее этой версии модуля; перенос на старые правила запрещён.");
  invariant(source.templateCatalogVersion === targetVersion, "source-version-older",
    `Для каталога v${source.templateCatalogVersion} откройте мир в прежней версии Skyhold с поддержкой перехода на v${targetVersion}.`);
  const targetTemplates = DEFAULT_BUILDING_TEMPLATES;
  const legacyTargets = new Map(BUILDING_TEMPLATES_BEFORE_LABOR_TRANSITION.map((row) => [row.id, row]));
  const targetById = new Map(targetTemplates.map((template) => [text(template?.id), template]));
  invariant(targetById.size === targetTemplates.length, "target-catalog", "Целевой каталог содержит пустые или повторные ID.");

  const targetData = clone(currentData);
  targetData.catalog = replaceCatalog
    ? { ...clone(currentData.catalog ?? {}), buildings: clone(targetTemplates), deletedBuildingTemplateIds: [] }
    : catalogTarget(currentData.catalog, targetById);
  const issues = [];
  const savedById = new Map((currentData.catalog?.buildings ?? []).map((row) => [text(row.id), row]));
  for (const target of targetData.catalog.buildings) {
    const id = text(target.id);
    if (!targetById.has(id)) continue;
    const saved = savedById.get(id);
    if (replaceCatalog && saved) preserveLaborConfiguration(saved, target, legacyTargets.get(id));
    targetById.set(id, target);
  }
  const rows = [];
  const normalizedTemplates = normalizeCatalogPartition({ buildings: [...targetById.values()] }).buildings;
  for (const template of normalizedTemplates) targetById.set(text(template.id), template);
  targetData.catalog.buildings = targetData.catalog.buildings.map((row) => targetById.get(text(row.id)) ?? row);
  const counts = { ...EMPTY_MIGRATION_COUNTS };
  for (const holding of targetData.holdings ?? []) {
    const people = holding?.people?.list ?? [];
    for (let index = 0; index < (holding?.buildings?.list ?? []).length; index += 1) {
      const prior = holding.buildings.list[index];
      const templateId = text(prior.templateId);
      const template = targetById.get(templateId);
      if (!template) {
        const deprecated = DEPRECATED_TEMPLATE_IDS.has(templateId);
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
          targetTemplateId: "",
          changed: false
        });
        continue;
      }
      counts.direct += 1;
      let updated = prior;
      if (replaceCatalog) {
        const firstIssue = issues.length;
        updated = migrateBuildingInstance(prior, template, templateId, people, issues, legacyTargets.get(templateId));
        for (const issue of issues.slice(firstIssue)) Object.assign(issue, { holdingId: text(holding.id), holdingName: text(holding.name) });
      }
      const changed = replaceCatalog && stableDataHash(prior) !== stableDataHash(updated);
      counts[changed ? "changed" : "unchanged"] += 1;
      holding.buildings.list[index] = updated;
      rows.push({
        holdingId: text(holding?.id),
        holdingName: text(holding?.name),
        buildingId: text(prior?.id),
        buildingName: updated.name,
        targetTemplateId: templateId,
        changed
      });
    }
  }

  for (const holding of targetData.holdings ?? []) {
    for (const issue of validateHybridLaborHolding(holding, { targets: buildWorkAllocationTargets(holding) }).issues) {
      issues.push({ ...issue, holdingId: text(holding.id), holdingName: text(holding.name), detail: issue.message });
    }
  }
  return completeMigrationPreview({ source, targetData, targetVersion, operationId, createdAt, counts, rows, issues });
}

function completeMigrationPreview({ source, targetData, targetVersion, operationId, createdAt, counts,
  rows = [], issues = [] }) {
  const targetCatalogHash = stableDataHash(targetData.catalog ?? {});
  const targetHoldingsHash = stableDataHash(targetData.holdings ?? []);
  const catalogChanged = source.catalogHash !== targetCatalogHash;
  const holdingsChanged = source.holdingsHash !== targetHoldingsHash;
  const hasChanges = catalogChanged || holdingsChanged;
  const marker = {
    namespace: BUILDING_CATALOG_MIGRATION_NAMESPACE,
    version: BUILDING_CATALOG_MIGRATION_VERSION,
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
    version: BUILDING_CATALOG_MIGRATION_VERSION,
    operationId: text(operationId),
    createdAt: text(createdAt),
    source,
    target: { templateCatalogVersion: targetVersion, catalogHash: targetCatalogHash, holdingsHash: targetHoldingsHash },
    hasChanges,
    canApply: hasChanges && blockingIssues.length === 0,
    blockingIssues,
    rows,
    counts,
    preview: {
      sourceTemplateCatalogVersion: source.templateCatalogVersion,
      targetTemplateCatalogVersion: targetVersion,
      catalogTemplates: DEFAULT_BUILDING_TEMPLATES.length,
      customCatalogTemplates: targetData.catalog.buildings.length - DEFAULT_BUILDING_TEMPLATES.length,
      holdings: (targetData.holdings ?? []).length,
      instances: rows.length,
      changedInstances: counts.changed,
      unchangedInstances: counts.unchanged,
      directInstances: counts.direct,
      customInstances: counts.custom,
      unresolvedInstances: counts.deprecatedUnmapped,
      blockingIssues: blockingIssues.length,
      catalogChanged,
      holdingsChanged
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
  const targetVersion = TEMPLATE_CATALOG_VERSION;
  invariant(whole(plan?.target?.templateCatalogVersion) === targetVersion,
    "target-version-disabled", "Целевая версия каталога не совпадает с текущей версией модуля.");
  invariant(stableDataHash(plan?.targetData?.catalog ?? {}) === text(plan?.target?.catalogHash)
    && stableDataHash(plan?.targetData?.holdings ?? []) === text(plan?.target?.holdingsHash),
  "prepared-data-changed", "Подготовленные данные изменились после Preview; требуется новый расчёт.");
  const current = rootDependency(currentData);
  invariant(current.revision === whole(plan?.source?.revision), "target-revision", "Данные мира изменились после Preview.", { expected: plan?.source?.revision, actual: current.revision });
  invariant(current.templateCatalogVersion === targetVersion, "target-catalog-version", "Версия каталога изменилась после Preview.");
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
