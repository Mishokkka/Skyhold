import { laborWageRate } from "./labor-wage-rate.js";

const DEFAULT_PRIORITY_BY_KIND = Object.freeze({
  "loan-payment": 100,
  wage: 200,
  "building-base-upkeep": 300,
  "building-operating-upkeep": 400,
  other: 500
});

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function optionalWhole(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}

function stringList(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => text(entry))
    .filter(Boolean))];
}

function financeCopy(finance = {}) {
  const source = finance && typeof finance === "object" ? finance : {};
  return {
    ...cloneValue(source),
    schemaVersion: Math.max(1, whole(source.schemaVersion, 1)),
    obligations: (Array.isArray(source.obligations) ? source.obligations : []).map((row) => cloneValue(row)),
    buildingStates: cloneValue(source.buildingStates && typeof source.buildingStates === "object" ? source.buildingStates : {}),
    settlementRuns: (Array.isArray(source.settlementRuns) ? source.settlementRuns : []).map((row) => cloneValue(row))
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(",")}}`;
}

function encodedIdPart(value, fallback = "none") {
  return encodeURIComponent(text(value, fallback));
}

function periodRelation(obligation = {}, currentPeriodKey = "", currentPeriodIndex = null) {
  const currentKey = text(currentPeriodKey);
  const rowKey = text(obligation.periodKey);
  const currentIndex = optionalWhole(currentPeriodIndex);
  const rowIndex = optionalWhole(obligation.periodIndex);
  if (currentIndex !== null && rowIndex !== null) {
    if (rowIndex < currentIndex) return "old";
    if (rowIndex > currentIndex) return "future";
    return rowKey && currentKey && rowKey !== currentKey ? (rowKey < currentKey ? "old" : "future") : "current";
  }
  if (currentKey && rowKey === currentKey) return "current";
  return currentKey ? "old" : "current";
}

function isActivelyOrphaned(obligation = {}) {
  return Boolean(obligation.orphaned) && !text(obligation.orphanResolvedAt);
}

function derivedStatus(obligation = {}, { markUnpaid = false } = {}) {
  const outstandingCopper = financeObligationOutstandingCopper(obligation);
  if (isActivelyOrphaned(obligation) && outstandingCopper > 0) return "orphaned";
  if (outstandingCopper <= 0) return whole(obligation.waivedCopper) > 0 ? "waived" : "paid";
  if (whole(obligation.paidCopper) > 0 || whole(obligation.waivedCopper) > 0) return "partial";
  if (markUnpaid || obligation.status === "unpaid") return "unpaid";
  return "due";
}

function refreshObligation(obligation = {}, options = {}) {
  const row = cloneValue(obligation);
  row.dueCopper = whole(row.dueCopper);
  row.paidCopper = Math.min(row.dueCopper, whole(row.paidCopper));
  row.waivedCopper = Math.min(row.dueCopper - row.paidCopper, whole(row.waivedCopper));
  row.outstandingCopper = financeObligationOutstandingCopper(row);
  row.status = derivedStatus(row, options);
  return row;
}

function obligationTerms(obligation = {}) {
  return {
    kind: text(obligation.kind, "other"),
    recipientKind: text(obligation.recipientKind, "other"),
    recipientId: text(obligation.recipientId),
    sourceId: text(obligation.sourceId),
    functionId: text(obligation.functionId),
    periodKey: text(obligation.periodKey),
    periodIndex: whole(obligation.periodIndex),
    dueCopper: whole(obligation.dueCopper),
    gmPriority: financeObligationPriority(obligation),
    dependsOnObligationIds: stringList(obligation.dependsOnObligationIds),
    meta: cloneValue(obligation.meta ?? {})
  };
}

function makeObligation({
  kind,
  recipientKind,
  recipientId,
  sourceId = "",
  functionId = "",
  periodKey,
  periodIndex,
  dueCopper,
  gmPriority = null,
  dependsOnObligationIds = [],
  createdAt = "",
  operationId = "",
  meta = {}
} = {}) {
  const normalizedKind = text(kind, "other");
  const row = {
    id: financeObligationId({ kind: normalizedKind, recipientKind, recipientId, sourceId, functionId, periodKey }),
    kind: normalizedKind,
    recipientKind: text(recipientKind, "other"),
    recipientId: text(recipientId),
    sourceId: text(sourceId),
    functionId: text(functionId),
    periodKey: text(periodKey),
    periodIndex: whole(periodIndex),
    dueCopper: whole(dueCopper),
    paidCopper: 0,
    waivedCopper: 0,
    outstandingCopper: whole(dueCopper),
    status: "due",
    gmPriority: gmPriority === null || gmPriority === undefined
      ? financeObligationDefaultPriority(normalizedKind)
      : whole(gmPriority),
    dependsOnObligationIds: stringList(dependsOnObligationIds),
    createdAt: text(createdAt),
    createdOperationId: text(operationId),
    payments: [],
    orphaned: false,
    orphanHistory: [],
    meta: cloneValue(meta)
  };
  if (!row.recipientId) throw new TypeError("FBL Skyhold | A finance obligation requires recipientId.");
  if (!row.periodKey) throw new TypeError("FBL Skyhold | A finance obligation requires periodKey.");
  return row;
}

export const makeFinanceObligation = makeObligation;

function ensureWorkerBlock(target, recipientId) {
  if (!target[recipientId]) {
    target[recipientId] = { blocked: false, outstandingCopper: 0, obligationIds: [] };
  }
  return target[recipientId];
}

function ensureBuildingBlock(target, buildingId, finance = {}) {
  if (!target[buildingId]) {
    const state = finance?.buildingStates?.[buildingId] ?? {};
    target[buildingId] = {
      mothballed: Boolean(state.mothballed),
      baseDebtCopper: 0,
      baseObligationIds: [],
      operatingByFunction: {}
    };
  }
  return target[buildingId];
}

function ensureFunctionBlock(buildingBlock, functionId) {
  const key = text(functionId, "default");
  if (!buildingBlock.operatingByFunction[key]) {
    buildingBlock.operatingByFunction[key] = { debtCopper: 0, obligationIds: [] };
  }
  return buildingBlock.operatingByFunction[key];
}

function compareStableText(left, right) {
  const a = text(left);
  const b = text(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function applyPayment(obligation, amountCopper, operationId, paidAt) {
  const amount = Math.min(financeObligationOutstandingCopper(obligation), whole(amountCopper));
  if (!amount) return { obligation: refreshObligation(obligation), amountCopper: 0 };
  const row = cloneValue(obligation);
  row.payments = Array.isArray(row.payments) ? row.payments.map((entry) => cloneValue(entry)) : [];
  row.payments.push({ operationId: text(operationId), amountCopper: amount, paidAt: text(paidAt) });
  row.paidCopper = whole(row.paidCopper) + amount;
  const refreshed = refreshObligation(row);
  if (refreshed.outstandingCopper === 0) {
    refreshed.settledAt = text(paidAt);
    refreshed.settledOperationId = text(operationId);
  }
  return { obligation: refreshed, amountCopper: amount };
}

function registrySet(value) {
  if (value instanceof Set) return new Set([...value].map((entry) => text(entry)).filter(Boolean));
  return new Set((Array.isArray(value) ? value : []).map((entry) => text(entry)).filter(Boolean));
}

export function financeObligationDefaultPriority(kind = "other") {
  return DEFAULT_PRIORITY_BY_KIND[text(kind, "other")] ?? DEFAULT_PRIORITY_BY_KIND.other;
}

export function financeObligationId({ kind = "other", recipientKind = "other", recipientId = "", sourceId = "", functionId = "", periodKey = "" } = {}) {
  return [
    "finance-obligation",
    encodedIdPart(kind, "other"),
    encodedIdPart(recipientKind, "other"),
    encodedIdPart(recipientId),
    encodedIdPart(sourceId),
    encodedIdPart(functionId),
    encodedIdPart(periodKey)
  ].join(":");
}

export function financeObligationOutstandingCopper(obligation = {}) {
  return Math.max(0, whole(obligation.dueCopper) - whole(obligation.paidCopper) - whole(obligation.waivedCopper));
}

export function calculatePlannedWorkerWage(worker = {}) {
  const workerId = text(worker.id ?? worker.recipientId);
  const volunteer = worker.volunteer === true;
  const volunteerReason = text(worker.volunteerReason);
  const assignments = Array.isArray(worker.assignments) ? worker.assignments : [];
  const overrideRate = optionalWhole(worker.wageOverrideCopper);
  const issues = [];
  for (const issue of Array.isArray(worker?.planIssues) ? worker.planIssues : []) {
    issues.push({ ...issue, workerId, message: text(issue?.message, "Invalid worker plan.") });
  }
  const pricedAssignments = [];
  let normalQd = 0;
  let overtimeQd = 0;
  let halfCopperUnits = 0;

  if (!workerId) issues.push({ code: "worker-id", message: "Worker id is required." });

  for (const assignment of assignments) {
    const plannedNormalQd = whole(assignment?.normalQd ?? assignment?.plannedNormalQd ?? assignment?.qd);
    const plannedOvertimeQd = whole(assignment?.overtimeQd ?? assignment?.plannedOvertimeQd);
    if (!plannedNormalQd && !plannedOvertimeQd) continue;
    const assignmentVolunteer = volunteer || assignment?.volunteer === true;
    const wage = laborWageRate({ volunteer: assignmentVolunteer, wageOverrideCopper: overrideRate, dailyRateCopper: assignment?.dailyRateCopper });
    const effectiveDailyRateCopper = wage.effectiveDailyRateCopper;
    if (!wage.ok) {
      issues.push({
        code: "wage-rate",
        workerId,
        sourceId: text(assignment?.sourceId),
        functionId: text(assignment?.functionId),
        message: "Paid planned work requires a positive daily wage or an explicit volunteer flag."
      });
      continue;
    }
    normalQd += plannedNormalQd;
    overtimeQd += plannedOvertimeQd;
    const rate = assignmentVolunteer ? 0 : effectiveDailyRateCopper;
    halfCopperUnits += (plannedNormalQd * rate) + (plannedOvertimeQd * rate * 2);
    pricedAssignments.push({
      sourceId: text(assignment?.sourceId),
      functionId: text(assignment?.functionId),
      normalQd: plannedNormalQd,
      overtimeQd: plannedOvertimeQd,
      effectiveDailyRateCopper: rate,
      ...(assignmentVolunteer ? { volunteer: true, volunteerReason: text(assignment?.volunteerReason || volunteerReason) } : {})
    });
  }

  const maximumNormalQd = optionalWhole(worker?.maximumNormalQd);
  const maximumOvertimeQd = optionalWhole(worker?.maximumOvertimeQd);
  if (maximumNormalQd !== null && normalQd > maximumNormalQd) {
    issues.push({ code: "work-normal-cap", workerId, message: `Planned normal work exceeds ${maximumNormalQd} QD.` });
  }
  if (maximumOvertimeQd !== null && overtimeQd > maximumOvertimeQd) {
    issues.push({ code: "work-overtime-cap", workerId, message: `Planned overtime exceeds ${maximumOvertimeQd} QD.` });
  }
  if (overtimeQd > Math.floor(normalQd / 2)) {
    issues.push({ code: "work-overtime-days", workerId, message: "Each overtime QD requires two normal QD in the planned work period." });
  }

  return {
    ok: issues.length === 0,
    workerId,
    volunteer: volunteer || (pricedAssignments.length > 0 && pricedAssignments.every((row) => row.volunteer)),
    volunteerReason,
    usedOverride: overrideRate !== null,
    normalQd,
    overtimeQd,
    halfCopperUnits,
    dueCopper: issues.length || volunteer ? 0 : Math.ceil(halfCopperUnits / 2),
    assignments: pricedAssignments,
    issues
  };
}

export function financeObligationBlockers({ finance = {}, currentPeriodKey = "", currentPeriodIndex = null, includeCurrent = true } = {}) {
  const source = finance && typeof finance === "object" ? finance : {};
  const workers = {};
  const buildings = {};
  for (const buildingId of Object.keys(source.buildingStates ?? {})) ensureBuildingBlock(buildings, buildingId, source);

  for (const obligation of Array.isArray(source.obligations) ? source.obligations : []) {
    const outstandingCopper = financeObligationOutstandingCopper(obligation);
    if (!outstandingCopper) continue;
    const relation = periodRelation(obligation, currentPeriodKey, currentPeriodIndex);
    if (relation === "future" || (!includeCurrent && relation !== "old")) continue;
    if (obligation.kind === "wage") {
      const worker = ensureWorkerBlock(workers, text(obligation.recipientId));
      worker.blocked = true;
      worker.outstandingCopper += outstandingCopper;
      worker.obligationIds.push(text(obligation.id));
      continue;
    }
    if (obligation.kind === "building-base-upkeep") {
      const building = ensureBuildingBlock(buildings, text(obligation.recipientId), source);
      building.baseDebtCopper += outstandingCopper;
      building.baseObligationIds.push(text(obligation.id));
      continue;
    }
    if (obligation.kind === "building-operating-upkeep") {
      const building = ensureBuildingBlock(buildings, text(obligation.recipientId), source);
      const functionBlock = ensureFunctionBlock(building, text(obligation.functionId));
      functionBlock.debtCopper += outstandingCopper;
      functionBlock.obligationIds.push(text(obligation.id));
    }
  }

  for (const worker of Object.values(workers)) worker.obligationIds.sort(compareStableText);
  for (const building of Object.values(buildings)) {
    building.baseObligationIds.sort(compareStableText);
    for (const row of Object.values(building.operatingByFunction)) row.obligationIds.sort(compareStableText);
  }
  return { workers, buildings };
}

export function financeWorkerBlockState({ finance = {}, workerId = "", ...period } = {}) {
  const row = financeObligationBlockers({ finance, ...period }).workers[text(workerId)];
  return row ?? { blocked: false, outstandingCopper: 0, obligationIds: [] };
}

export function financeBuildingFunctionBlockState({ finance = {}, buildingId = "", functionId = "", ...period } = {}) {
  const building = financeObligationBlockers({ finance, ...period }).buildings[text(buildingId)];
  const direct = building?.operatingByFunction?.[text(functionId, "default")];
  const shared = text(functionId) === "operation" ? null : building?.operatingByFunction?.operation;
  const operating = { debtCopper: whole(direct?.debtCopper) + whole(shared?.debtCopper),
    obligationIds: [...(direct?.obligationIds ?? []), ...(shared?.obligationIds ?? [])] };
  const reasons = [];
  if (building?.mothballed) reasons.push("mothballed");
  if (building?.baseDebtCopper > 0) reasons.push("base-upkeep-debt");
  if (operating?.debtCopper > 0) reasons.push("operating-upkeep-debt");
  return {
    blocked: reasons.length > 0,
    reasons,
    mothballed: Boolean(building?.mothballed),
    baseDebtCopper: whole(building?.baseDebtCopper),
    operatingDebtCopper: whole(operating?.debtCopper),
    obligationIds: [...(building?.baseObligationIds ?? []), ...(operating?.obligationIds ?? [])]
  };
}

export function mergeFinanceObligations(finance = {}, obligations = []) {
  const next = financeCopy(finance);
  const byId = new Map(next.obligations.map((row, index) => [text(row.id), { row, index }]));
  const added = [];
  const existing = [];
  const conflicts = [];
  for (const candidate of Array.isArray(obligations) ? obligations : []) {
    const proposed = refreshObligation(candidate);
    const id = text(proposed.id);
    if (!id) {
      conflicts.push({ id: "", code: "missing-id", proposed });
      continue;
    }
    const match = byId.get(id);
    if (!match) {
      const index = next.obligations.push(proposed) - 1;
      byId.set(id, { row: proposed, index });
      added.push(id);
      continue;
    }
    if (stableSerialize(obligationTerms(match.row)) !== stableSerialize(obligationTerms(proposed))) {
      conflicts.push({ id, code: "immutable-terms", existing: cloneValue(match.row), proposed });
      continue;
    }
    existing.push(id);
  }
  return { ok: conflicts.length === 0, finance: next, added, existing, conflicts };
}

export function planCurrentFinanceObligations({
  finance = {},
  periodKey = "",
  periodIndex = 0,
  operationId = "",
  createdAt = "",
  workers = [],
  buildings = [],
  additionalObligations = []
} = {}) {
  const normalizedPeriodKey = text(periodKey);
  if (!normalizedPeriodKey) throw new TypeError("FBL Skyhold | Finance planning requires periodKey.");
  const normalizedPeriodIndex = whole(periodIndex);
  const normalizedOperationId = text(operationId, `finance-accrual:${normalizedPeriodKey}`);
  const oldBlockers = financeObligationBlockers({
    finance,
    currentPeriodKey: normalizedPeriodKey,
    currentPeriodIndex: normalizedPeriodIndex,
    includeCurrent: false
  });
  const obligations = [];
  const skipped = [];
  const issues = [];

  for (const worker of Array.isArray(workers) ? workers : []) {
    const workerId = text(worker?.id ?? worker?.recipientId);
    const block = oldBlockers.workers[workerId];
    if (block?.blocked) {
      skipped.push({ kind: "wage", recipientId: workerId, reason: "old-wage-debt", obligationIds: [...block.obligationIds] });
      continue;
    }
    const wage = calculatePlannedWorkerWage(worker);
    if (!wage.ok) {
      issues.push(...wage.issues);
      skipped.push({ kind: "wage", recipientId: workerId, reason: "invalid-wage" });
      continue;
    }
    if (!wage.dueCopper) {
      skipped.push({ kind: "wage", recipientId: workerId, reason: wage.volunteer ? "volunteer" : "no-planned-work" });
      continue;
    }
    obligations.push(makeObligation({
      kind: "wage",
      recipientKind: text(worker?.recipientKind, "resident"),
      recipientId: workerId,
      sourceId: workerId,
      periodKey: normalizedPeriodKey,
      periodIndex: normalizedPeriodIndex,
      dueCopper: wage.dueCopper,
      gmPriority: worker?.gmPriority,
      createdAt,
      operationId: normalizedOperationId,
      meta: {
        recipientName: text(worker?.name),
        volunteer: wage.volunteer,
        volunteerReason: wage.volunteerReason,
        wageOverrideCopper: optionalWhole(worker?.wageOverrideCopper),
        normalQd: wage.normalQd,
        overtimeQd: wage.overtimeQd,
        halfCopperUnits: wage.halfCopperUnits,
        assignments: wage.assignments
      }
    }));
  }

  for (const building of Array.isArray(buildings) ? buildings : []) {
    const buildingId = text(building?.id);
    if (!buildingId) {
      issues.push({ code: "building-id", message: "Building id is required." });
      continue;
    }
    if (building?.built !== true) {
      skipped.push({ kind: "building", recipientId: buildingId, reason: "not-built" });
      continue;
    }
    const oldBuildingBlock = oldBlockers.buildings[buildingId] ?? { mothballed: false, baseDebtCopper: 0, operatingByFunction: {} };
    if (oldBuildingBlock.mothballed) {
      skipped.push({ kind: "building", recipientId: buildingId, reason: "mothballed" });
      continue;
    }
    const baseUpkeepCopper = whole(building?.baseUpkeepCopper);
    let baseObligation = null;
    if (baseUpkeepCopper > 0) {
      baseObligation = makeObligation({
        kind: "building-base-upkeep",
        recipientKind: "building",
        recipientId: buildingId,
        sourceId: buildingId,
        periodKey: normalizedPeriodKey,
        periodIndex: normalizedPeriodIndex,
        dueCopper: baseUpkeepCopper,
        gmPriority: building?.baseGmPriority ?? building?.gmPriority,
        createdAt,
        operationId: normalizedOperationId,
        meta: { recipientName: text(building?.name) }
      });
      obligations.push(baseObligation);
    }

    for (const fn of Array.isArray(building?.functions) ? building.functions : []) {
      const functionId = text(fn?.id);
      if (!functionId || fn?.active === false) continue;
      const operatingUpkeepCopper = whole(fn?.operatingUpkeepCopper);
      if (!operatingUpkeepCopper) continue;
      const oldFunctionDebt = oldBuildingBlock.operatingByFunction?.[functionId]?.debtCopper ?? 0;
      if (oldBuildingBlock.baseDebtCopper > 0 || oldFunctionDebt > 0 || (oldBuildingBlock.operatingByFunction?.operation?.debtCopper ?? 0) > 0) {
        skipped.push({
          kind: "building-operating-upkeep",
          recipientId: buildingId,
          functionId,
          reason: oldBuildingBlock.baseDebtCopper > 0 ? "old-base-upkeep-debt" : "old-operating-upkeep-debt"
        });
        continue;
      }
      obligations.push(makeObligation({
        kind: "building-operating-upkeep",
        recipientKind: "building",
        recipientId: buildingId,
        sourceId: buildingId,
        functionId,
        periodKey: normalizedPeriodKey,
        periodIndex: normalizedPeriodIndex,
        dueCopper: operatingUpkeepCopper,
        gmPriority: fn?.gmPriority ?? building?.operatingGmPriority ?? building?.gmPriority,
        dependsOnObligationIds: [
          ...(baseObligation ? [baseObligation.id] : []),
          ...(functionId !== "operation" && (building?.functions ?? []).some((row) => row.id === "operation" && row.active !== false && whole(row.operatingUpkeepCopper) > 0)
            ? [financeObligationId({ kind: "building-operating-upkeep", recipientKind: "building", recipientId: buildingId, sourceId: buildingId, functionId: "operation", periodKey: normalizedPeriodKey })] : [])
        ],
        createdAt,
        operationId: normalizedOperationId,
        meta: { recipientName: text(building?.name), functionName: text(fn?.name) }
      }));
    }
  }

  obligations.push(...additionalObligations);
  const merged = mergeFinanceObligations(finance, obligations);
  if (merged.conflicts.length) {
    issues.push(...merged.conflicts.map((conflict) => ({ code: "obligation-conflict", obligationId: conflict.id })));
  }
  return {
    ok: issues.length === 0 && merged.ok,
    finance: merged.finance,
    obligations,
    added: merged.added,
    existing: merged.existing,
    conflicts: merged.conflicts,
    skipped,
    issues
  };
}

export function compareFinanceObligationPriority(left = {}, right = {}, { currentPeriodKey = "", currentPeriodIndex = null } = {}) {
  const relationRank = { old: 0, current: 1, future: 2 };
  const leftRelation = periodRelation(left, currentPeriodKey, currentPeriodIndex);
  const rightRelation = periodRelation(right, currentPeriodKey, currentPeriodIndex);
  if (relationRank[leftRelation] !== relationRank[rightRelation]) return relationRank[leftRelation] - relationRank[rightRelation];
  const periodDifference = whole(left.periodIndex) - whole(right.periodIndex);
  if (periodDifference) return periodDifference;
  const keyDifference = compareStableText(left.periodKey, right.periodKey);
  if (keyDifference) return keyDifference;
  const priorityDifference = financeObligationPriority(left) - financeObligationPriority(right);
  if (priorityDifference) return priorityDifference;
  return compareStableText(left.id, right.id);
}

export function financeObligationPriority(obligation = {}) {
  return obligation.gmPriority === undefined || obligation.gmPriority === null
    ? financeObligationDefaultPriority(obligation.kind)
    : whole(obligation.gmPriority);
}

export function allocateFinanceObligations({
  finance = {},
  treasuryCopper = 0,
  currentPeriodKey = "",
  currentPeriodIndex = null,
  operationId = "",
  paidAt = ""
} = {}) {
  const normalizedOperationId = text(operationId);
  if (!normalizedOperationId) throw new TypeError("FBL Skyhold | Finance allocation requires operationId.");
  const next = financeCopy(finance);
  const priorRun = next.settlementRuns.find((run) => text(run.operationId) === normalizedOperationId);
  if (priorRun) {
    return {
      ok: true,
      replay: true,
      finance: next,
      treasuryCopper: whole(priorRun.treasuryAfterCopper),
      paidCopper: whole(priorRun.paidCopper),
      payments: cloneValue(priorRun.payments ?? []),
      skipped: cloneValue(priorRun.skipped ?? [])
    };
  }

  const treasuryBeforeCopper = whole(treasuryCopper);
  let availableCopper = treasuryBeforeCopper;
  const payments = [];
  const skipped = [];
  const rowById = new Map(next.obligations.map((row) => [text(row.id), row]));
  const pending = next.obligations
    .filter((row) => financeObligationOutstandingCopper(row) > 0)
    .filter((row) => periodRelation(row, currentPeriodKey, currentPeriodIndex) !== "future")
    .sort((left, right) => compareFinanceObligationPriority(left, right, { currentPeriodKey, currentPeriodIndex }));

  while (pending.length) {
    const readyIndex = pending.findIndex((candidate) => (
      isActivelyOrphaned(candidate)
      || stringList(candidate.dependsOnObligationIds).every((id) => (
        rowById.has(id) && financeObligationOutstandingCopper(rowById.get(id)) === 0
      ))
    ));
    if (readyIndex < 0) {
      for (const candidate of pending) {
        const index = next.obligations.indexOf(candidate);
        const dependencyIds = stringList(candidate.dependsOnObligationIds)
          .filter((id) => !rowById.has(id) || financeObligationOutstandingCopper(rowById.get(id)) > 0);
        next.obligations[index] = refreshObligation(candidate, { markUnpaid: true });
        rowById.set(text(candidate.id), next.obligations[index]);
        skipped.push({
          obligationId: text(candidate.id),
          reason: "dependency-unpaid",
          dependencyIds,
          outstandingCopper: financeObligationOutstandingCopper(candidate)
        });
      }
      break;
    }
    const [candidate] = pending.splice(readyIndex, 1);
    const index = next.obligations.indexOf(candidate);
    const relation = periodRelation(candidate, currentPeriodKey, currentPeriodIndex);
    if (isActivelyOrphaned(candidate)) {
      next.obligations[index] = refreshObligation(candidate, { markUnpaid: true });
      skipped.push({ obligationId: text(candidate.id), reason: "orphaned", outstandingCopper: financeObligationOutstandingCopper(candidate) });
      continue;
    }

    const outstandingCopper = financeObligationOutstandingCopper(candidate);
    const amountCopper = relation === "old"
      ? Math.min(availableCopper, outstandingCopper)
      : (availableCopper >= outstandingCopper ? outstandingCopper : 0);
    if (!amountCopper) {
      next.obligations[index] = refreshObligation(candidate, { markUnpaid: true });
      rowById.set(text(candidate.id), next.obligations[index]);
      skipped.push({
        obligationId: text(candidate.id),
        reason: relation === "old" ? "no-money" : "current-atomic",
        outstandingCopper
      });
      continue;
    }
    const paid = applyPayment(candidate, amountCopper, normalizedOperationId, paidAt);
    next.obligations[index] = paid.obligation;
    rowById.set(text(candidate.id), paid.obligation);
    availableCopper -= paid.amountCopper;
    payments.push({
      obligationId: text(candidate.id),
      amountCopper: paid.amountCopper,
      partial: paid.obligation.outstandingCopper > 0
    });
  }

  const paidCopper = treasuryBeforeCopper - availableCopper;
  const settlementRun = {
    operationId: normalizedOperationId,
    periodKey: text(currentPeriodKey),
    periodIndex: optionalWhole(currentPeriodIndex),
    paidAt: text(paidAt),
    treasuryBeforeCopper,
    treasuryAfterCopper: availableCopper,
    paidCopper,
    payments: cloneValue(payments),
    skipped: cloneValue(skipped)
  };
  next.settlementRuns.push(settlementRun);
  return { ok: true, replay: false, finance: next, treasuryCopper: availableCopper, paidCopper, payments, skipped };
}

export function setFinanceBuildingMothball({ finance = {}, buildingId = "", mothballed = true, changedAt = "", operationId = "", reason = "" } = {}) {
  const id = text(buildingId);
  const op = text(operationId);
  const explanation = text(reason);
  if (!id) throw new TypeError("FBL Skyhold | Mothball change requires buildingId.");
  if (!op) throw new TypeError("FBL Skyhold | Mothball change requires operationId.");
  if (mothballed && !explanation) throw new TypeError("FBL Skyhold | Mothballing requires an explicit reason.");
  const next = financeCopy(finance);
  const prior = next.buildingStates[id] && typeof next.buildingStates[id] === "object"
    ? cloneValue(next.buildingStates[id])
    : { mothballed: false, history: [] };
  prior.history = Array.isArray(prior.history) ? prior.history : [];
  if (prior.history.some((entry) => text(entry.operationId) === op)) {
    return { ok: true, replay: true, finance: next, state: prior };
  }
  const state = {
    ...prior,
    mothballed: Boolean(mothballed),
    changedAt: text(changedAt),
    changedOperationId: op,
    reason: explanation,
    history: [...prior.history, { operationId: op, mothballed: Boolean(mothballed), changedAt: text(changedAt), reason: explanation }]
  };
  next.buildingStates[id] = state;
  return { ok: true, replay: false, finance: next, state };
}

export function reconcileFinanceObligationOrphans({ finance = {}, recipientIdsByKind = {}, reconciledAt = "", operationId = "" } = {}) {
  const next = financeCopy(finance);
  const op = text(operationId);
  if (!op) throw new TypeError("FBL Skyhold | Orphan reconciliation requires operationId.");
  const registries = Object.fromEntries(Object.entries(recipientIdsByKind ?? {}).map(([kind, ids]) => [kind, registrySet(ids)]));
  const orphanedIds = [];
  next.obligations = next.obligations.map((obligation) => {
    const row = refreshObligation(obligation);
    if (!row.outstandingCopper || isActivelyOrphaned(row)) return row;
    if ((Array.isArray(row.orphanHistory) ? row.orphanHistory : []).some((entry) => text(entry.operationId) === op)) return row;
    if (!Object.prototype.hasOwnProperty.call(registries, row.recipientKind)) return row;
    if (registries[row.recipientKind].has(text(row.recipientId))) return row;
    const history = Array.isArray(row.orphanHistory) ? row.orphanHistory.map((entry) => cloneValue(entry)) : [];
    history.push({
      orphanedAt: text(reconciledAt),
      operationId: op,
      reason: "recipient-missing",
      previousStatus: row.status,
      resolution: null
    });
    orphanedIds.push(row.id);
    return {
      ...row,
      orphaned: true,
      orphanedAt: text(reconciledAt),
      orphanedOperationId: op,
      orphanReason: "recipient-missing",
      orphanPreviousStatus: row.status,
      orphanResolvedAt: "",
      orphanResolutionAction: "",
      orphanResolutionOperationId: "",
      orphanHistory: history,
      status: "orphaned"
    };
  });
  return { ok: true, finance: next, orphanedIds };
}

export function resolveFinanceObligationOrphan({
  finance = {},
  obligationId = "",
  action = "",
  recipientKind = "",
  recipientId = "",
  resolvedAt = "",
  operationId = "",
  reason = ""
} = {}) {
  const next = financeCopy(finance);
  const id = text(obligationId);
  const op = text(operationId);
  const normalizedAction = text(action).toLowerCase();
  const index = next.obligations.findIndex((row) => text(row.id) === id);
  if (index < 0) return { ok: false, code: "not-found", finance: next };
  if (!op) throw new TypeError("FBL Skyhold | Orphan resolution requires operationId.");
  const existing = next.obligations[index];
  if (text(existing.orphanResolutionOperationId) === op) {
    return { ok: true, replay: true, action: text(existing.orphanResolutionAction), finance: next, obligation: existing };
  }
  if (!isActivelyOrphaned(existing)) return { ok: false, code: "not-orphaned", finance: next, obligation: existing };
  if (!new Set(["transfer", "waive"]).has(normalizedAction)) return { ok: false, code: "action", finance: next, obligation: existing };
  const explanation = text(reason);
  if (!explanation) return { ok: false, code: "reason", finance: next, obligation: existing };
  if (normalizedAction === "transfer" && (!text(recipientKind) || !text(recipientId))) {
    return { ok: false, code: "recipient", finance: next, obligation: existing };
  }

  let row = cloneValue(existing);
  const outstandingCopper = financeObligationOutstandingCopper(row);
  if (normalizedAction === "transfer") {
    row.previousRecipientKind = text(row.recipientKind);
    row.previousRecipientId = text(row.recipientId);
    row.recipientKind = text(recipientKind);
    row.recipientId = text(recipientId);
    row.transferredAt = text(resolvedAt);
    row.transferOperationId = op;
  } else {
    row.waivedCopper = whole(row.waivedCopper) + outstandingCopper;
    row.waivedAt = text(resolvedAt);
    row.waiverReason = explanation;
    row.waiverOperationId = op;
    row.settledAt = text(resolvedAt);
    row.settledOperationId = op;
  }
  row.orphaned = false;
  row.orphanResolvedAt = text(resolvedAt);
  row.orphanResolutionAction = normalizedAction;
  row.orphanResolutionOperationId = op;
  const history = Array.isArray(row.orphanHistory) ? row.orphanHistory.map((entry) => cloneValue(entry)) : [];
  if (history.length) {
    history[history.length - 1] = {
      ...history[history.length - 1],
      resolution: {
        action: normalizedAction,
        resolvedAt: text(resolvedAt),
        operationId: op,
        reason: explanation,
        recipientKind: normalizedAction === "transfer" ? text(recipientKind) : "",
        recipientId: normalizedAction === "transfer" ? text(recipientId) : "",
        amountCopper: normalizedAction === "waive" ? outstandingCopper : 0
      }
    };
  }
  row.orphanHistory = history;
  row = refreshObligation(row);
  next.obligations[index] = row;
  return { ok: true, replay: false, action: normalizedAction, finance: next, obligation: row };
}
