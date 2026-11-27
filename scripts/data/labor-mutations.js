import { reservedOccupation, residentLaborUnavailableReason } from "./labor-model.js";
import { allocationFunctionId, allocationNormalQd, allocationSourceId, allocationTotalQd } from "./labor-primitives.js";
import { syncResidentLaborRole } from "./labor-role.js";
import { clearPersonFromAssignments, clearResidentLaborAllocations,
  transferResidentBetweenHoldings as transferLegacyResident } from "./resident-assignments.js";
import { canonicalSignatureV1 } from "./sha256.js";
import { isPlainObject } from "./utils.js";
import { normalizeWorkAllocation, validateHoldingWorkAllocations } from "./work-allocations.js";
import { lockedAllocationChangeError } from "./workforce-plan.js";

const text = (value) => String(value ?? "").trim();
const rowsFor = (person) => Array.isArray(person.workAllocations) ? person.workAllocations : [];
const personFor = (holding, id) => (holding?.people?.list ?? []).find((person) => text(person.id) === id);
const lockKey = (personId, row) => JSON.stringify([text(personId), allocationSourceId(row), allocationFunctionId(row)]);
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
    return {
      ...check,
      orphanedOvertime: Boolean(orphanedOvertime),
      message: orphanedOvertime ? "Сначала уменьшите сверхурочные (OT) в оставшихся назначениях" : check.issues[0]?.message
    };
  }
  Object.assign(holding, draft);
  return check;
}

export function droppedWorkforceLocks(holding = {}, personId = "", nextAllocations = []) {
  const id = text(personId);
  if (!id) return [];
  const activeKeys = new Set((Array.isArray(nextAllocations) ? nextAllocations : [])
    .filter((row) => allocationTotalQd(row) > 0)
    .map((row) => lockKey(id, row)));
  return (holding?.workforcePlan?.locks ?? [])
    .filter((row) => text(row?.personId) === id && !activeKeys.has(lockKey(row.personId, row)));
}

export function droppedLocksForAllocationChange(holding = {}, personId = "", nextAllocations = [], removedRows = []) {
  const id = text(personId);
  if (!id) return [];
  const beforePerson = personFor(holding, id);
  const beforeActive = new Set(rowsFor(beforePerson ?? {}).filter((row) => allocationTotalQd(row) > 0)
    .map((row) => lockKey(id, row)));
  const removedKeys = new Set((Array.isArray(removedRows) ? removedRows : [])
    .filter((row) => allocationSourceId(row) && allocationFunctionId(row))
    .map((row) => lockKey(id, row)));
  return droppedWorkforceLocks(holding, id, nextAllocations)
    .filter((row) => beforeActive.has(lockKey(row.personId, row)) || removedKeys.has(lockKey(row.personId, row)));
}

function hasHiddenDroppedLock(holding, dropped = []) {
  if (!dropped.length) return false;
  const buildings = new Map((holding?.buildings?.list ?? []).map((row) => [text(row?.id), row]));
  const people = new Map((holding?.people?.list ?? []).map((row) => [text(row?.id), row]));
  return dropped.some((row) => row?.visibility === "gm"
    || buildings.get(text(row?.sourceId))?.visibility === "gm"
    || people.get(text(row?.personId))?.visibility === "gm");
}

function pruneDroppedLocks(beforeHolding, draft, personId, options = {}) {
  const id = text(personId);
  const afterPerson = personFor(draft, id);
  const dropped = droppedLocksForAllocationChange(
    { ...beforeHolding, workforcePlan: draft.workforcePlan },
    id,
    rowsFor(afterPerson ?? {}),
    options.removedRows
  );
  if (!dropped.length) return { ok: true, dropped: [] };
  if (options.isGM === false && hasHiddenDroppedLock(draft, dropped)) {
    return { ok: false, forbidden: true, droppedLocks: dropped, message: "Назначение недоступно. Обновите окно или обратитесь к ГМу." };
  }
  if (options.confirmedUnlock === false) {
    return { ok: false, requiresConfirmation: true, droppedLocks: dropped, message: "Удаление затронет закреплённое назначение." };
  }
  const droppedKeys = new Set(dropped.map((row) => lockKey(row.personId, row)));
  if (Array.isArray(draft.workforcePlan?.locks)) {
    draft.workforcePlan.locks = draft.workforcePlan.locks.filter((row) => !droppedKeys.has(lockKey(row.personId, row)));
  }
  return { ok: true, dropped };
}

function cleanAdmissionOverrides(holding, person, requested, preservedSources) {
  const personId = text(person.id);
  const active = new Set(rowsFor(person).filter((row) => allocationTotalQd(row) > 0).map(allocationSourceId));
  for (const building of holding.buildings?.list ?? []) {
    const id = text(building.id);
    if (preservedSources?.has(id)) continue;
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
  const occupation = reservedOccupation(holding, person);
  const hadOverrides = (holding.buildings?.list ?? []).filter((building) =>
    (building.workerAdmissionOverrideIds ?? []).some((id) => text(id) === text(person.id))).map((building) => text(building.id));
  const preservedSources = options.preserveAllocationSourceIds;
  const preserve = (row) => preservedSources?.has(allocationSourceId(row));
  const rows = nextAllocations.map((row, index) => preserve(row) ? structuredClone(row) : normalizeWorkAllocation(row, index));
  const active = rows.some((row) => allocationTotalQd(row) > 0);
  const replacing = active && occupation && occupation.kind !== "ship" && options.replaceOccupation === true
    && !residentLaborUnavailableReason(holding, person);
  if (replacing) {
    releaseOccupation(holding, person);
    replaced.push(text(person.id));
  }
  person.workAllocations = options.keepEmptyRows ? rows : rows.filter((row) => preserve(row) || allocationTotalQd(row) > 0);
  const requested = options.admissionOverrideBuildingIds ?? (replacing ? hadOverrides : null);
  cleanAdmissionOverrides(holding, person, requested ? new Set(requested.map(text)) : null, preservedSources);
  if (!occupation || replacing) syncResidentLaborRole(person, { isChild: asChild(person, options), clearServiceRole: Boolean(replacing) });
}

export function mutateResidentBuildingLabor(holding, {
  personId, buildingId, action, functionId, normalQd = 0, overtimeQd = 0, volunteer, volunteerReason,
  replaceOccupation = false, replaceAllocations = false, allowAdmissionOverride = false, ...options
} = {}) {
  const id = text(personId), source = text(buildingId), fn = text(functionId);
  const removing = action === "remove";
  if (!id || !source || !["add", "set", "remove"].includes(action) || (!fn && !removing)) return fail("Не выбрано назначение для изменения.");
  if (!removing && ![normalQd, overtimeQd].every(validQd)) return fail(INVALID_QD);
  const draft = structuredClone(holding);
  const person = personFor(draft, id);
  if (!person) return fail("Житель не найден.");
  const rows = rowsFor(person);
  const matches = (row) => allocationSourceId(row) === source && (!fn || allocationFunctionId(row) === fn);
  const replaced = [];
  const removedRows = [];
  const prepareOptions = { isChild: options.isChild, preserveAllocationSourceIds: options.preserveAllocationSourceIds };
  if (removing) {
    removedRows.push(...rows.filter(matches));
    if (source && fn) removedRows.push({ sourceId: source, functionId: fn });
    prepare(draft, person, rows.filter((row) => !matches(row)), prepareOptions, replaced);
  } else {
    const retained = replaceAllocations ? rows.filter(matches) : rows;
    if (replaceAllocations) {
      removedRows.push(...rows.filter((entry) => !matches(entry)));
    }
    const existing = retained.find(matches);
    const next = { ...existing, sourceId: source, functionId: fn,
      normalQd: normalQd + (action === "add" ? allocationNormalQd(existing) : 0),
      overtimeQd: overtimeQd + (action === "add" ? overtimeFor(existing) : 0),
      ...(volunteer !== undefined ? { volunteer, volunteerReason } : {}) };
    if (![next.normalQd, next.overtimeQd].every(Number.isSafeInteger)) return fail("Превышен допустимый размер QD.");
    const nextRows = existing ? retained.map((row) => row === existing ? next : row) : [...retained, next];
    prepare(draft, person, nextRows, { ...prepareOptions, replaceOccupation }, replaced);
    if (allowAdmissionOverride === true && allocationTotalQd(next) > 0) {
      const building = (draft.buildings?.list ?? []).find((row) => text(row.id) === source);
      if (building && !(building.workerAdmissionOverrideIds ?? []).some((value) => text(value) === id)) {
        building.workerAdmissionOverrideIds = [...(building.workerAdmissionOverrideIds ?? []), id];
      }
    }
  }
  const pruned = pruneDroppedLocks(holding, draft, id, { ...options, removedRows });
  if (!pruned.ok) return pruned;
  const lockError = lockedAllocationChangeError(holding, draft, draft.workforcePlan, { isGM: options.isGM !== false });
  if (lockError) return { ok: false, forbidden: true, message: lockError };
  return finish(holding, draft, options, replaced, { removing, conserving: removing, checkedPersonIds: [id] });
}

export function applyResidentEditorAllocations(holding, personId, options = {}) {
  const { nextAllocations, admissionOverrideBuildingIds, replaceOccupation = false, isChild } = options;
  if (!Array.isArray(nextAllocations)) return fail("Не задан план QD жителя.");
  if (!validAllocationRows(nextAllocations)) return fail(INVALID_QD);
  if (admissionOverrideBuildingIds != null && !Array.isArray(admissionOverrideBuildingIds)) return fail("Некорректный список допусков к работе.");
  const draft = structuredClone(holding);
  const person = personFor(draft, text(personId));
  if (!person) return fail("Житель не найден.");
  const nextIds = new Set(nextAllocations.map((row) => text(row?.id)).filter(Boolean));
  const removedRows = rowsFor(person).filter((row) => row?.id && !nextIds.has(text(row.id)));
  const replaced = [];
  prepare(draft, person, nextAllocations, { admissionOverrideBuildingIds, replaceOccupation, isChild, keepEmptyRows: true }, replaced);
  const pruned = pruneDroppedLocks(holding, draft, person.id, { ...options, removedRows });
  if (!pruned.ok) return pruned;
  const lockError = lockedAllocationChangeError(holding, draft, draft.workforcePlan, { isGM: options.isGM !== false });
  if (lockError) return { ok: false, forbidden: true, message: lockError };
  return finish(holding, draft, options, replaced, { checkedPersonIds: [person.id], conserving: options.conserving === true, removing: options.conserving === true });
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
  for (const keyFor of [allocationSourceId, allocationFunctionId, (row) => text(row.id)]) {
    const leftKey = keyFor(left), rightKey = keyFor(right);
    if (leftKey < rightKey) return -1;
    if (leftKey > rightKey) return 1;
  }
  return 0;
};

function trimOvertime(draft, personIds, { locks, ...options } = {}) {
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
      const trim = { personId: id, personName: person.name || "Житель", sourceId: allocationSourceId(row), functionId: allocationFunctionId(row),
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
  if (Array.isArray(draft.workforcePlan?.locks)) {
    draft.workforcePlan.locks = draft.workforcePlan.locks.filter((row) => !dropped.has(lockKey(row.personId, row)));
  }
  return { trims, lockedTrims };
}

export function trimExcessOvertimeForResidents(holding, personIds, { confirmLocked = false, ...options } = {}) {
  const draft = structuredClone(holding);
  const preview = trimOvertime(draft, personIds, options);
  const requiresConfirmation = preview.lockedTrims.length > 0 && !confirmLocked;
  if (requiresConfirmation || !preview.trims.length) return { ok: !requiresConfirmation, requiresConfirmation, ...preview };
  return { ...finish(holding, draft, options, [], { conserving: true }), requiresConfirmation, ...preview };
}

function prepareBuildingLaborWithdrawal(holding, buildingId, functionId) {
  const source = text(buildingId), fn = text(functionId);
  const targets = (row) => allocationSourceId(row) === source && (!fn || allocationFunctionId(row) === fn);
  const people = (holding.people?.list ?? []).filter((person) => rowsFor(person).some(targets));
  const affected = new Set(people.map((person) => text(person.id)));
  const locks = (holding.workforcePlan?.locks ?? []).filter((row) => targets(row) || affected.has(text(row.personId)));
  const removedLocks = locks.filter(targets);
  const draft = structuredClone(holding);
  for (const person of draft.people?.list ?? []) {
    if (!affected.has(text(person.id))) continue;
    if (fn) {
      person.workAllocations = rowsFor(person).filter((row) => !targets(row));
      cleanAdmissionOverrides(draft, person);
      syncResidentLaborRole(person, { isChild: asChild(person, {}) });
    } else clearResidentBuildingLabor(draft, person, source);
  }
  if (draft.workforcePlan) {
    draft.workforcePlan.locks = (draft.workforcePlan.locks ?? []).filter((row) => !targets(row));
    draft.workforcePlan.productionGoals = (draft.workforcePlan.productionGoals ?? []).filter((row) => !targets(row));
  }
  const { trims, lockedTrims } = trimOvertime(draft, affected, { locks });
  const preview = {
    buildingId: source, functionId: fn, personIds: [...affected], trims, lockedTrims, removedLocks,
    trimsHiddenLock: lockedTrims.some((row) => locks.some((lock) => lock.visibility === "gm" && lockKey(lock.personId, lock) === lockKey(row.personId, row))),
    token: canonicalSignatureV1([source, fn, people.map((person) => [person.id, person.visibility, rowsFor(person)]), locks, trims])
  };
  return { draft, preview };
}

export function planBuildingLaborWithdrawal(holding, buildingId, functionId = "") {
  return prepareBuildingLaborWithdrawal(holding, buildingId, functionId).preview;
}

export function applyBuildingLaborWithdrawal(holding, preview, { confirmed = false } = {}) {
  const { draft, preview: current } = prepareBuildingLaborWithdrawal(holding, preview.buildingId, preview.functionId);
  if (preview.token !== current.token) return { ...fail("Распределение труда изменилось. Обновите предпросмотр."), stale: true };
  if (!confirmed && (current.trims.length || current.removedLocks.length)) {
    return { ...fail("Уменьшение сверхурочных и снятие закреплений требуют подтверждения."), requiresConfirmation: true };
  }
  const check = validateDraft(holding, draft, {}, [], { conserving: true });
  if (!check.ok) return { ...check, message: check.issues[0]?.message };
  holding.people = draft.people;
  for (const [index, building] of (holding.buildings?.list ?? []).entries()) {
    building.workerAdmissionOverrideIds = draft.buildings.list[index].workerAdmissionOverrideIds;
  }
  if (draft.workforcePlan) holding.workforcePlan = draft.workforcePlan;
  return { ok: true, ...current };
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
