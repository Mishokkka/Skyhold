import { stableDataHash } from "../../data/storage-commit.js";
import { proposedBuildingLaborProfile } from "../../data/building-labor-catalog.js";
import { applyStaffAppointment, buildingLaborMode, normalizeBuildingLabor, staffAppointmentFor, staffAppointmentWorkFunctions } from "../../data/hybrid-labor.js";
import { buildWorkAllocationTargets, validateHoldingWorkAllocations, workAllocationTargetKey } from "../../data/work-allocations.js";
import { workforceUnavailable } from "../../data/workforce-plan.js";
import { workerAdmission } from "../../engines/workers/building-qualification.js";

const clone = (value) => structuredClone(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const active = (row) => Number(row?.normalQd) > 0 || Number(row?.overtimeQd) > 0;
const contains = (ids, id) => (ids ?? []).some((value) => String(value) === id);

/** Do not recommend disabling a customized productive function just from its template id. */
export function recommendedHybridLaborProfile(building, templateId = building?.templateId) {
  const profile = proposedBuildingLaborProfile(templateId);
  if (profile?.mode === "passive") {
    const tasks = buildWorkAllocationTargets({ buildings: { list: [{ ...building,
      labor: { version: 1, mode: "qd", capacityQd: null } }] } }, { includeMaintenance: false });
    if (tasks.some((task) => ["production", "agriculture", "livestock", "income", "medical"].includes(task.kind))) return null;
  }
  return profile;
}

function migrationPlanReferenceIssues(holding, targets) {
  const issues = [];
  const people = new Set((holding.people?.list ?? []).map((person) => String(person.id)));
  for (const kind of ["goals", "locks"]) {
    const seen = new Set();
    for (const row of holding.workforcePlan?.[kind] ?? []) {
      const targetKey = workAllocationTargetKey(row?.sourceId, row?.functionId);
      const key = kind === "locks" ? JSON.stringify([row?.personId, targetKey]) : targetKey;
      if (seen.has(key)) issues.push({ code: "labor-plan-reference-collision", kind, ...row,
        message: "После сопоставления несколько целей или закреплений ссылаются на одну работу. Выберите, какую запись сохранить, до перехода." });
      seen.add(key);
      if (!targets.has(targetKey) || kind === "locks" && !people.has(String(row?.personId))) {
        issues.push({ code: "labor-plan-reference", kind, ...row,
          message: "Цель или закрепление относится к недоступной работе или отсутствующему жителю; требуется явное решение." });
      }
    }
  }
  return issues;
}

function migrationStaffAdmissionIssues(before, after, targets) {
  const issues = [];
  for (const person of after.people?.list ?? []) {
    const appointment = staffAppointmentFor(person);
    if (!appointment) continue;
    const prior = (before.people?.list ?? []).find((row) => String(row.id) === String(person.id));
    const priorAppointment = staffAppointmentFor(prior);
    if (JSON.stringify(appointment) === JSON.stringify(priorAppointment)) continue;
    const building = (after.buildings?.list ?? []).find((row) => row.id === appointment.buildingId);
    if (!building) continue;
    const functions = staffAppointmentWorkFunctions(appointment);
    const admission = workerAdmission(building, person);
    if (admission?.hard && !admission.eligible && !admission.overridden && functions.some((id) => id !== "maintenance")) {
      issues.push({ code: "labor-staff-admission", personId: person.id, buildingId: building.id,
        message: `${person.name || "Житель"}: не выполнен обязательный допуск к выбранной штатной работе.` });
    }
    const previousBuilding = (before.buildings?.list ?? []).find((row) => row.id === building.id);
    const continuingJob = priorAppointment?.buildingId === building.id || previousBuilding
      && (contains(previousBuilding.assignedWorkerIds, String(person.id)) || [previousBuilding.id, previousBuilding.name].includes(prior?.workAssignment));
    if (!continuingJob) {
      const unavailable = prior && workforceUnavailable(before, prior);
      if (unavailable || functions.some((id) => targets.get(workAllocationTargetKey(building.id, id))?.available === false)) {
        issues.push({ code: "labor-staff-unavailable", personId: person.id, buildingId: building.id,
          message: `${person.name || "Житель"}: новое штатное назначение сейчас недоступно${unavailable ? ` — ${unavailable}` : ""}.` });
      }
    }
  }
  return issues;
}

function remapReference(row, mappings) {
  const key = workAllocationTargetKey(row.sourceId, row.functionId);
  if (!owns(mappings, key)) return row;
  const replacement = mappings[key];
  if (typeof replacement !== "string" || !replacement) throw new Error(`Неоднозначное соответствие работы ${key}.`);
  // A mapping changes a function inside the same building, never moves a worker to another employer.
  return { ...row, functionId: replacement };
}

/**
 * Read-only preview of an explicit transition. No settings, Actors or world state are touched.
 * Existing assignments require a concrete resident decision; a line is never chosen by order.
 * `staffAppointments[id] = null` explicitly releases the old job.
 * `workAllocations[id] = []` explicitly clears the old QD plan.
 */
export function planHybridLaborMigration({
  holding, profiles = {}, staffAppointments = {}, workAllocations = {}, lineMappings = {}, clearUnavailablePlanReferences = false
} = {}) {
  if (!holding || typeof holding !== "object") throw new Error("Поселение для перехода не найдено.");
  const targetHolding = clone(holding), issues = [], changes = [], touchedBuildings = new Set();
  const add = (code, message, details = {}) => issues.push({ code, message, ...details });
  for (const building of targetHolding.buildings?.list ?? []) {
    const supplied = owns(profiles, building.id);
    if (!supplied && buildingLaborMode(building) !== "legacy") continue;
    const profile = supplied ? profiles[building.id] : recommendedHybridLaborProfile(building);
    if (!profile) {
      add("labor-profile-choice", `${building.name || "Здание"}: выберите способ работы. Рекомендация отсутствует или отключит производственные работы изменённого здания.`, { buildingId: building.id });
      continue;
    }
    building.labor = normalizeBuildingLabor(profile);
    building.workersMin = 0;
    if (building.workerProfile) building.workerProfile.workersMin = 0;
    if (building.activation) building.activation.minWorkers = 0;
    if (building.labor?.mode === "passive") {
      building.activation = { ...building.activation, minOperationalQd: 0, requiresMeaningfulResult: false };
      building.minOperationalQd = 0;
    }
    touchedBuildings.add(building.id);
    changes.push({ buildingId: building.id, name: building.name, mode: building.labor.mode });
  }
  const affectedResidents = new Set();
  for (const person of targetHolding.people?.list ?? []) {
    const id = String(person.id);
    const oldBuilding = (holding.buildings?.list ?? []).find((building) => touchedBuildings.has(building.id)
      && (contains(building.assignedWorkerIds, id) || [building.id, building.name].filter(Boolean).includes(person.workAssignment)));
    const oldRows = (person.workAllocations ?? []).filter((row) => active(row) && touchedBuildings.has(row.sourceId));
    if (oldBuilding || oldRows.length) affectedResidents.add(id);
  }
  // Release selected contracts first so a simultaneous swap does not fail due to an occupied slot.
  for (const person of targetHolding.people?.list ?? []) {
    const id = String(person.id), appointment = staffAppointmentFor(person);
    if (!owns(staffAppointments, id) && !owns(workAllocations, id)) {
      if (affectedResidents.has(id) && !appointment) add("labor-assignment-choice", `${person.name || "Житель"}: подтвердите постоянную работу или конкретные задания QD.`, { personId: id });
      continue;
    }
    if (owns(staffAppointments, id) && staffAppointments[id] && owns(workAllocations, id) && workAllocations[id]?.some(active)) {
      add("labor-assignment-conflict", `${person.name || "Житель"}: нельзя одновременно подтвердить штат и внешние QD.`, { personId: id });
      continue;
    }
    if (appointment) applyStaffAppointment(targetHolding, id, null);
    for (const building of targetHolding.buildings?.list ?? []) {
      if (Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
    }
    const oldAssignment = String(person.workAssignment ?? "");
    if ((holding.buildings?.list ?? []).some((building) => [building.id, building.name].filter(Boolean).includes(oldAssignment))) person.workAssignment = "";
    if (owns(workAllocations, id)) {
      if (!Array.isArray(workAllocations[id])) { add("labor-assignment-format", "Назначения QD должны быть списком.", { personId: id }); continue; }
      person.workAllocationMode = "explicit";
      person.workAllocations = clone(workAllocations[id]);
      person.role = person.workAllocations.some(active) ? "План QD" : "Свободен";
    } else if (owns(staffAppointments, id)) {
      person.workAllocations = [];
      person.workAllocationMode = "explicit";
      person.role = "Свободен";
    }
  }
  for (const [id, appointment] of Object.entries(staffAppointments)) {
    if (!appointment) continue;
    try { applyStaffAppointment(targetHolding, id, appointment); }
    catch (error) { add("labor-appointment", error.message, { personId: id }); }
  }
  try {
    for (const person of targetHolding.people?.list ?? []) {
      if (Array.isArray(person.workAllocations)) person.workAllocations = person.workAllocations.map((row) => remapReference(row, lineMappings));
      const appointment = staffAppointmentFor(person);
      if (appointment) {
        for (const field of ["primaryFunctionId", "reserveFunctionId"]) {
          if (!appointment[field]) continue;
          appointment[field] = remapReference({ sourceId: appointment.buildingId, functionId: appointment[field] }, lineMappings).functionId;
        }
      }
    }
    for (const kind of ["goals", "locks", "productionGoals"]) {
      if (Array.isArray(targetHolding.workforcePlan?.[kind])) targetHolding.workforcePlan[kind] = targetHolding.workforcePlan[kind].map((row) => remapReference(row, lineMappings));
    }
  } catch (error) { add("labor-line-mapping", error.message); }
  const targets = new Map(buildWorkAllocationTargets(targetHolding).map((row) => [row.key, row]));
  if (clearUnavailablePlanReferences) {
    for (const kind of ["goals", "locks", "productionGoals"]) if (Array.isArray(targetHolding.workforcePlan?.[kind])) {
      targetHolding.workforcePlan[kind] = targetHolding.workforcePlan[kind].filter((row) => targets.has(workAllocationTargetKey(row.sourceId, row.functionId)));
    }
  }
  issues.push(...migrationPlanReferenceIssues(targetHolding, targets));
  issues.push(...migrationStaffAdmissionIssues(holding, targetHolding, targets));
  issues.push(...validateHoldingWorkAllocations(targetHolding).issues);
  return { version: 1, sourceHash: stableDataHash(holding), targetHash: stableDataHash(targetHolding),
    targetHolding, issues, changes, ok: issues.length === 0 };
}

/** Pure application to a caller-owned copy; a separate authorized GM transaction must persist it. */
export function applyHybridLaborMigration({ holding, plan } = {}) {
  if (plan?.version !== 1 || !plan.ok || plan.issues?.length || !plan.targetHolding) throw new Error("Сначала разрешите конфликты перехода.");
  if (stableDataHash(holding) !== plan.sourceHash) throw new Error("Поселение изменилось после просмотра перехода. Обновите расчёт.");
  if (stableDataHash(plan.targetHolding) !== plan.targetHash) throw new Error("Подготовленный переход изменён; повторите предварительный просмотр.");
  const check = validateHoldingWorkAllocations(plan.targetHolding);
  if (!check.ok) throw new Error(check.issues[0]?.message || "Переход содержит некорректные назначения.");
  const references = migrationPlanReferenceIssues(plan.targetHolding, new Map(check.targets.map((row) => [row.key, row])));
  if (references.length) throw new Error(references[0].message);
  const admissions = migrationStaffAdmissionIssues(holding, plan.targetHolding, new Map(check.targets.map((row) => [row.key, row])));
  if (admissions.length) throw new Error(admissions[0].message);
  return clone(plan.targetHolding);
}

/** Catalog transition changes employment settings only; saved recipes and custom parameters survive. */
export function planHybridLaborCatalogMigration({ catalog, profiles = {} } = {}) {
  const targetCatalog = clone(catalog ?? {}), issues = [], changes = [];
  for (const template of targetCatalog.buildings ?? []) {
    if (!owns(profiles, template.id) && buildingLaborMode(template) !== "legacy") continue;
    const profile = owns(profiles, template.id) ? profiles[template.id] : recommendedHybridLaborProfile(template, template.id);
    if (!profile) {
      issues.push({ code: "catalog-labor-profile", templateId: template.id, message: `${template.name || "Шаблон"}: выберите способ работы. Рекомендация отсутствует или отключит производственные работы изменённого шаблона.` });
      continue;
    }
    template.labor = normalizeBuildingLabor(profile);
    template.workersMin = 0;
    if (template.workerProfile) template.workerProfile.workersMin = 0;
    template.activation = { ...template.activation, minWorkers: 0 };
    if (template.labor.mode === "passive") {
      template.activation.minOperationalQd = 0;
      template.activation.requiresMeaningfulResult = false;
    }
    const check = validateHoldingWorkAllocations({ buildings: { list: [{ ...template, assignedWorkerIds: [] }] }, people: { list: [] } });
    issues.push(...check.issues.map((issue) => ({ ...issue, templateId: template.id })));
    changes.push({ templateId: template.id, name: template.name, mode: template.labor.mode });
  }
  return { version: 1, sourceHash: stableDataHash(catalog ?? {}), targetHash: stableDataHash(targetCatalog),
    targetCatalog, issues, changes, ok: issues.length === 0 };
}

export function applyHybridLaborCatalogMigration({ catalog, plan } = {}) {
  if (plan?.version !== 1 || !plan.ok || plan.issues?.length || !plan.targetCatalog) throw new Error("Сначала выберите способы работы всех шаблонов.");
  if (stableDataHash(catalog ?? {}) !== plan.sourceHash || stableDataHash(plan.targetCatalog) !== plan.targetHash) {
    throw new Error("Каталог изменился после просмотра перехода. Обновите расчёт.");
  }
  return clone(plan.targetCatalog);
}
