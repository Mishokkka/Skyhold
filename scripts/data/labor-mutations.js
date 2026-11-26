import { reservedOccupation, residentLaborUnavailableReason } from "./labor-model.js";
import { allocationNormalQd, allocationTotalQd, residentActiveQd } from "./labor-primitives.js";
import { syncResidentLaborRole } from "./labor-role.js";
import { clearPersonFromAssignments, clearResidentLaborAllocations,
  transferResidentBetweenHoldings as transferLegacyResident } from "./resident-assignments.js";
import { isPlainObject } from "./utils.js";
import { normalizeWorkAllocation, validateHoldingWorkAllocations,
  WORK_ALLOCATION_MODE_EXPLICIT } from "./work-allocations.js";

const text = (value) => String(value ?? "").trim();
const rowsFor = (person) => Array.isArray(person.workAllocations) ? person.workAllocations : [];
const personFor = (holding, id) => (holding?.people?.list ?? []).find((person) => text(person.id) === id);
const lockKey = (personId, row) => JSON.stringify([text(personId), text(row?.sourceId), text(row?.functionId)]);
const overtimeFor = (row) => allocationTotalQd(row) - allocationNormalQd(row);
const asChild = (person, options) => options.isChild ?? (person?.ageGroup === "Ре");
const fail = (message) => ({ ok: false, message });
const INVALID_QD = "QD должны быть целыми неотрицательными числами.";
const QD_FIELDS = ["normalQd", "overtimeQd", "plannedNormalQd", "plannedOvertimeQd", "qd"];
const validQd = (value) => Number.isSafeInteger(value) && value >= 0;

function validAllocationRows(rows) {
  for (const row of rows) {
    if (!isPlainObject(row)) return false;
    const prototype = Object.getPrototypeOf(row);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const field of QD_FIELDS) {
      const value = row[field];
      if (value !== undefined && !validQd(value)) return false;
    }
  }
  return true;
}

function validateDraft(holding, draft, options, replacedPersonId, { checkedPersonIds, conserving } = {}) {
  return validateHoldingWorkAllocations(draft, {
    baseNormalQd: options.baseNormalQd, workingDays: options.workingDays,
    useDaysOffBudget: options.useDaysOffBudget ?? true, allowMedicalOvertime: options.allowMedicalOvertime,
    previousHolding: holding, replacedPersonId, strictWageCheck: true, checkedPersonIds, conserving
  });
}

function finish(holding, draft, options, replaced, context = {}) {
  const check = validateDraft(holding, draft, options, replaced, context);
  if (!check.ok) {
    const orphanedOvertime = context.removing && check.issues.some((issue) => issue.code === "allocation-overtime-days");
    return { ...check, message: orphanedOvertime ? "Сначала уменьшите сверхурочные (OT) в оставшихся назначениях" : check.issues[0]?.message };
  }
  Object.assign(holding, draft);
  return check;
}

function cleanAdmissionOverrides(holding, person, requested) {
  const personId = text(person.id);
  const active = new Set(rowsFor(person).filter((row) => allocationTotalQd(row) > 0).map((row) => text(row.sourceId)));
  for (const building of holding.buildings?.list ?? []) {
    const id = text(building.id);
    const existing = building.workerAdmissionOverrideIds ?? [];
    const has = existing.some((value) => text(value) === personId);
    const keep = active.has(id) && (requested ? requested.has(id) : has);
    if (keep && !has) building.workerAdmissionOverrideIds = [...existing, personId];
    if (!keep && has) building.workerAdmissionOverrideIds = existing.filter((value) => text(value) !== personId);
  }
}

function releaseOccupation(holding, person) {
  clearPersonFromAssignments(holding, text(person.id));
  person.workAssignment = "";
}

function prepare(holding, person, nextAllocations, options, replaced) {
  const occupation = reservedOccupation(holding, person) || person.staffAppointment?.buildingId;
  const hadOverrides = (holding.buildings?.list ?? []).filter((building) =>
    (building.workerAdmissionOverrideIds ?? []).some((id) => text(id) === text(person.id))).map((building) => text(building.id));
  person.workAllocations = nextAllocations.map((row, index) => normalizeWorkAllocation(row, index));
  const active = residentActiveQd(person) > 0;
  if (active) person.workAllocationMode = WORK_ALLOCATION_MODE_EXPLICIT;
  const replacing = active && occupation && occupation.kind !== "ship" && options.replaceOccupation === true
    && !residentLaborUnavailableReason(holding, person);
  if (replacing) {
    releaseOccupation(holding, person);
    replaced.push(text(person.id));
  }
  const requested = options.admissionOverrideBuildingIds ?? (replacing ? hadOverrides : null);
  cleanAdmissionOverrides(holding, person, requested ? new Set(requested.map(text)) : null);
  if (!occupation || replacing) syncResidentLaborRole(person, { isChild: asChild(person, options), clearServiceRole: Boolean(replacing) });
}

export function mutateResidentBuildingLabor(holding, {
  personId, buildingId, action, functionId, normalQd = 0, overtimeQd = 0, volunteer, volunteerReason,
  replaceOccupation = false, allowAdmissionOverride = false, ...options
} = {}) {
  const id = text(personId), source = text(buildingId), fn = text(functionId);
  if (!id || !source || !["add", "set", "remove"].includes(action) || (!fn && action !== "remove")) return fail("Не выбрано назначение для изменения.");
  if (action !== "remove" && ![normalQd, overtimeQd].every(validQd)) return fail(INVALID_QD);
  const draft = structuredClone(holding);
  const person = personFor(draft, id);
  if (!person) return fail("Житель не найден.");
  const rows = rowsFor(person);
  const matches = (row) => text(row?.sourceId) === source && (!fn || text(row?.functionId) === fn);
  const replaced = [];
  if (action === "remove") {
    prepare(draft, person, rows.filter((row) => !matches(row)), { isChild: options.isChild }, replaced);
  } else {
    const existing = rows.find(matches);
    const next = { ...existing, sourceId: source, functionId: fn,
      normalQd: normalQd + (action === "add" ? allocationNormalQd(existing) : 0),
      overtimeQd: overtimeQd + (action === "add" ? overtimeFor(existing) : 0),
      ...(volunteer !== undefined ? { volunteer, volunteerReason } : {}) };
    if (![next.normalQd, next.overtimeQd].every(Number.isSafeInteger)) return fail("Превышен допустимый размер QD.");
    const nextRows = existing ? rows.map((row) => row === existing ? next : row) : [...rows, next];
    prepare(draft, person, nextRows, { isChild: options.isChild, replaceOccupation }, replaced);
    if (allowAdmissionOverride === true && allocationTotalQd(next) > 0) {
      const building = (draft.buildings?.list ?? []).find((row) => text(row.id) === source);
      if (building && !(building.workerAdmissionOverrideIds ?? []).some((value) => text(value) === id)) {
        building.workerAdmissionOverrideIds = [...(building.workerAdmissionOverrideIds ?? []), id];
      }
    }
  }
  return finish(holding, draft, options, replaced, { removing: action === "remove", checkedPersonIds: [id] });
}

export function applyResidentEditorAllocations(holding, personId, options = {}) {
  const { nextAllocations, admissionOverrideBuildingIds, replaceOccupation = false, isChild } = options;
  if (!Array.isArray(nextAllocations)) return fail("Не задан план QD жителя.");
  if (!validAllocationRows(nextAllocations)) return fail(INVALID_QD);
  if (admissionOverrideBuildingIds != null && !Array.isArray(admissionOverrideBuildingIds)) return fail("Некорректный список допусков к работе.");
  const draft = structuredClone(holding);
  const person = personFor(draft, text(personId));
  if (!person) return fail("Житель не найден.");
  const replaced = [];
  prepare(draft, person, nextAllocations, { admissionOverrideBuildingIds, replaceOccupation, isChild }, replaced);
  return finish(holding, draft, options, replaced, { checkedPersonIds: [person.id] });
}

export function applyWorkforcePlanAllocations(holding, { updates, ...options } = {}) {
  if (!Array.isArray(updates)) return fail("Не задан общий план QD.");
  const draft = structuredClone(holding);
  const seen = new Set(), plan = [], replaced = [];
  for (const update of updates) {
    const id = text(update?.personId);
    const allocations = update?.nextAllocations ?? update?.workAllocations;
    const person = id && personFor(draft, id);
    if (!person || !Array.isArray(allocations) || seen.has(id)
      || (update.admissionOverrideBuildingIds != null && !Array.isArray(update.admissionOverrideBuildingIds))) return fail("Некорректная строка общего плана QD.");
    if (!validAllocationRows(allocations)) return fail(INVALID_QD);
    seen.add(id);
    plan.push({ person, allocations, update });
  }
  for (const { person, allocations, update } of plan) {
    prepare(draft, person, allocations, { ...options, ...update }, replaced);
  }
  return finish(holding, draft, options, replaced, { checkedPersonIds: [...seen] });
}

export function clearResidentBuildingLabor(holding, person, buildingId, { isChild } = {}) {
  if (text(buildingId)) clearResidentLaborAllocations(holding, person, { buildingId, isChild });
}

export function clearResidentAllBuildingLabor(holding, person, { isChild } = {}) {
  clearResidentLaborAllocations(holding, person, { isChild });
}

const compareRows = (left, right) => {
  for (const field of ["sourceId", "functionId", "id"]) {
    if (text(left[field]) < text(right[field])) return -1;
    if (text(left[field]) > text(right[field])) return 1;
  }
  return 0;
};

export function trimExcessOvertimeForResidents(holding, personIds, { confirmLocked = false, locks, ...options } = {}) {
  const draft = structuredClone(holding);
  const lockedKeys = new Set([...(draft.workforcePlan?.locks ?? []), ...(Array.isArray(locks) ? locks : [])]
    .map((row) => lockKey(row.personId, row)));
  const trims = [], lockedTrims = [];
  const dropped = new Set();
  for (const id of [...new Set([...personIds].map(text))].sort()) {
    const person = personFor(draft, id);
    if (!person) continue;
    const rows = rowsFor(person);
    let remaining = rows.reduce((sum, row) => sum + overtimeFor(row), 0)
      - Math.floor(rows.reduce((sum, row) => sum + allocationNormalQd(row), 0) / 2);
    if (remaining <= 0) continue;
    const ordered = rows.filter((row) => overtimeFor(row) > 0).sort(compareRows);
    const isRowLocked = (row) => lockedKeys.has(lockKey(id, row));
    for (const row of [...ordered.filter((row) => !isRowLocked(row)), ...ordered.filter(isRowLocked)]) {
      if (!remaining) break;
      const overtimeBefore = overtimeFor(row), overtimeAfter = Math.max(0, overtimeBefore - remaining);
      remaining -= overtimeBefore - overtimeAfter;
      row.overtimeQd = overtimeAfter;
      const locked = isRowLocked(row);
      const trim = { personId: id, personName: person.name || "Житель", sourceId: row.sourceId, functionId: row.functionId,
        overtimeBefore, overtimeAfter, locked };
      trims.push(trim);
      if (locked) lockedTrims.push(trim);
    }
    person.workAllocations = rows.filter((row) => allocationTotalQd(row) > 0);
    const remainingKeys = new Set(person.workAllocations.map((row) => lockKey(id, row)));
    for (const row of rows) if (!remainingKeys.has(lockKey(id, row))) dropped.add(lockKey(id, row));
    cleanAdmissionOverrides(draft, person);
    syncResidentLaborRole(person, { isChild: asChild(person, options) });
  }
  const requiresConfirmation = lockedTrims.length > 0 && confirmLocked !== true;
  if (requiresConfirmation || !trims.length) return { ok: !requiresConfirmation, requiresConfirmation, trims, lockedTrims };
  if (Array.isArray(draft.workforcePlan?.locks)) {
    draft.workforcePlan.locks = draft.workforcePlan.locks.filter((row) => !dropped.has(lockKey(row.personId, row)));
  }
  return { ...finish(holding, draft, options, [], { conserving: true }), requiresConfirmation, trims, lockedTrims };
}

export function transferResidentBetweenHoldings(sourceHolding, targetHolding, personId, options = {}) {
  const id = text(personId);
  if (!sourceHolding || !targetHolding || sourceHolding === targetHolding
    || (sourceHolding.id && sourceHolding.id === targetHolding.id)) return fail("Житель или целевое владение не найдены.");
  const source = structuredClone(sourceHolding), target = structuredClone(targetHolding);
  const person = personFor(source, id);
  if (!person) return fail("Житель не найден.");
  const isChild = asChild(person, options);
  clearResidentAllBuildingLabor(source, person, { isChild });
  const transfer = transferLegacyResident(source, target, id);
  if (!transfer.ok) return transfer;
  if (isChild) person.role = "Ребенок";
  const sourceCheck = validateDraft(sourceHolding, source, options, []);
  if (!sourceCheck.ok) return { ...sourceCheck, message: sourceCheck.issues[0]?.message };
  const targetCheck = validateDraft(targetHolding, target, options, []);
  if (!targetCheck.ok) return { ...targetCheck, message: targetCheck.issues[0]?.message };
  Object.assign(sourceHolding, source);
  Object.assign(targetHolding, target);
  return transfer;
}
