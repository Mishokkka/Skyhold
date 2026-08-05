import { ageGroupFromAge } from "../../generators/resident-rules.js";

export const LABOR_POOL_SCHEMA_VERSION = 1;
export const LABOR_QD_PER_WORKDAY = 2;
export const WORKDAYS_PER_TENDAY = 10;

const ASSIGNMENT_PRIORITY = Object.freeze({
  defense: 0,
  fleet: 1,
  construction: 2,
  building: 3,
  legacy: 4,
  unassigned: 5
});

const FREE_ASSIGNMENTS = new Set(["", "free", "unassigned", "свободен", "без работы", "ребенок", "ребёнок"]);

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.floor(numeric) : fallback;
}

function positiveWhole(value, fallback = 0) {
  return Math.max(0, whole(value, fallback));
}

function hashText(value = "") {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableTargetId(kind, row = {}, index = 0) {
  const explicit = text(row?.id);
  if (explicit) return explicit;
  const signature = [kind, row?.name, row?.templateId, row?.type, index].map(text).join("|");
  return `legacy-${hashText(signature)}`;
}

function stableResidentId(person = {}, index = 0) {
  const explicit = text(person?.id);
  if (explicit) return explicit;
  return `legacy-resident-${hashText([person?.name, person?.age, person?.race, index].map(text).join("|"))}`;
}

function assignmentId(kind, targetId) {
  return `${text(kind) || "legacy"}:${text(targetId) || "unknown"}`;
}

function assignmentOrder(left = {}, right = {}) {
  const leftPriority = ASSIGNMENT_PRIORITY[left.kind] ?? 99;
  const rightPriority = ASSIGNMENT_PRIORITY[right.kind] ?? 99;
  return leftPriority - rightPriority || String(left.id).localeCompare(String(right.id), "ru");
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function failure(code, message, issues = []) {
  return { ok: false, code, message, issues };
}

function residentAvailability(person = {}, maximumQd = LABOR_QD_PER_WORKDAY * WORKDAYS_PER_TENDAY) {
  if (positiveWhole(person?.injuredDays, 0) > 0) return { capacityQd: 0, reason: "injured" };
  const group = text(person?.ageGroup) || ageGroupFromAge(person?.age, person?.race, person?.subrace);
  if (group === "Ре" && positiveWhole(person?.age, 0) < 12) return { capacityQd: 0, reason: "child" };
  return { capacityQd: maximumQd, reason: "available" };
}

function normalizeCapacityResult(result, maximumQd) {
  if (result && typeof result === "object") {
    return {
      capacityQd: Math.min(maximumQd, positiveWhole(result.capacityQd ?? result.qd, 0)),
      reason: text(result.reason) || "custom"
    };
  }
  return { capacityQd: Math.min(maximumQd, positiveWhole(result, 0)), reason: "custom" };
}

function buildPeriod(holding = {}, options = {}) {
  const laborQdPerDay = Math.max(1, positiveWhole(options.laborQdPerDay, LABOR_QD_PER_WORKDAY));
  const workdays = Math.max(1, positiveWhole(options.workdays, WORKDAYS_PER_TENDAY));
  const inferredIndex = Math.floor(positiveWhole(holding?.gm?.calendaria?.lastQd, 0) / 40) + 1;
  const explicitStart = positiveWhole(options.startQd, 0);
  const tendayIndex = explicitStart
    ? Math.floor((explicitStart - 1) / 40) + 1
    : Math.max(1, positiveWhole(options.tendayIndex, inferredIndex));
  const startQd = explicitStart || ((tendayIndex - 1) * 40) + 1;
  const endQd = startQd + 39;
  const firstDay = Math.floor((startQd - 1) / 4) + 1;
  const days = Array.from({ length: workdays }, (_, offset) => ({
    key: `day:${firstDay + offset}`,
    day: firstDay + offset,
    startQd: startQd + offset * 4,
    endQd: startQd + offset * 4 + 3
  }));
  return {
    key: `tenday:${tendayIndex}:${startQd}-${endQd}`,
    tendayIndex,
    startQd,
    endQd,
    laborQdPerDay,
    workdays,
    capacityQdPerResident: laborQdPerDay * workdays,
    dayKeys: days.map((row) => row.key),
    days
  };
}

function normalizeAssignment(kind, targetId, label) {
  return {
    id: assignmentId(kind, targetId),
    kind: text(kind) || "legacy",
    targetId: text(targetId),
    label: text(label) || text(targetId) || "Назначение"
  };
}

function registerAssignment(registry, assignment) {
  const current = registry.get(assignment.id);
  if (!current) registry.set(assignment.id, { ...assignment });
  else if (!current.label && assignment.label) current.label = assignment.label;
  return registry.get(assignment.id);
}

function collectAssignmentClaims(holding, livingById, knownResidentIds, assignments, ignoredReferences) {
  const claimsByResident = new Map([...livingById.keys()].map((id) => [id, new Map()]));
  const buildingLookup = new Map();
  const constructionLookup = new Map();
  const fleetLookup = new Map();
  const ignoredKeys = new Set();

  const addIgnoredReference = (residentId, assignment, source) => {
    const reason = knownResidentIds.has(residentId) ? "dead-resident" : "missing-resident";
    const key = `${reason}|${residentId}|${assignment.id}|${source}`;
    if (ignoredKeys.has(key)) return;
    ignoredKeys.add(key);
    ignoredReferences.push({ residentId, assignmentId: assignment.id, source, reason });
  };

  const addClaim = (residentIdRaw, assignment, source) => {
    const residentId = text(residentIdRaw);
    if (!residentId) return;
    registerAssignment(assignments, assignment);
    const claims = claimsByResident.get(residentId);
    if (!claims) {
      addIgnoredReference(residentId, assignment, source);
      return;
    }
    const current = claims.get(assignment.id) ?? { ...assignment, sources: [] };
    if (!current.sources.includes(source)) current.sources.push(source);
    current.sources.sort((left, right) => left.localeCompare(right, "ru"));
    claims.set(assignment.id, current);
  };

  for (const [index, building] of (holding?.buildings?.list ?? []).entries()) {
    const targetId = stableTargetId("building", building, index);
    const assignment = normalizeAssignment("building", targetId, building?.name || targetId);
    registerAssignment(assignments, assignment);
    buildingLookup.set(targetId, assignment);
    const name = text(building?.name);
    if (name && !buildingLookup.has(name)) buildingLookup.set(name, assignment);
    for (const residentId of building?.assignedWorkerIds ?? []) addClaim(residentId, assignment, "building.roster");
  }

  for (const [index, crew] of (holding?.constructionCrews ?? []).entries()) {
    const targetId = stableTargetId("construction", crew, index);
    const assignment = normalizeAssignment("construction", targetId, crew?.name || targetId);
    registerAssignment(assignments, assignment);
    constructionLookup.set(targetId, assignment);
    const name = text(crew?.name);
    if (name && !constructionLookup.has(name)) constructionLookup.set(name, assignment);
    const members = new Set([crew?.leaderId, ...(crew?.memberIds ?? [])].map(text).filter(Boolean));
    for (const residentId of members) addClaim(residentId, assignment, "construction.roster");
  }

  const defense = holding?.gm?.defense ?? {};
  const command = normalizeAssignment("defense", "command", "Командование обороной");
  if (text(defense?.commanderId)) addClaim(defense.commanderId, command, "defense.commander");
  for (const [index, squad] of (defense?.squads ?? []).entries()) {
    const targetId = `squad:${stableTargetId("defense-squad", squad, index)}`;
    const assignment = normalizeAssignment("defense", targetId, squad?.name || `Отряд ${index + 1}`);
    const members = new Set([squad?.sergeantId, ...(squad?.memberIds ?? [])].map(text).filter(Boolean));
    for (const residentId of members) addClaim(residentId, assignment, "defense.squad");
  }

  for (const [index, vessel] of (holding?.special?.fleet?.vessels ?? []).entries()) {
    const targetId = stableTargetId("fleet", vessel, index);
    const assignment = normalizeAssignment("fleet", targetId, vessel?.name || targetId);
    registerAssignment(assignments, assignment);
    fleetLookup.set(targetId, assignment);
    const name = text(vessel?.name);
    if (name && !fleetLookup.has(name)) fleetLookup.set(name, assignment);
    for (const residentId of vessel?.crew?.memberIds ?? []) addClaim(residentId, assignment, "fleet.roster");
  }

  const resolveDeclared = (person, residentId) => {
    const raw = text(person?.workAssignment);
    const normalized = raw.toLocaleLowerCase("ru");
    const current = [...(claimsByResident.get(residentId)?.values() ?? [])];
    if (FREE_ASSIGNMENTS.has(normalized)) return { preferredId: "", assignment: null };
    if (buildingLookup.has(raw)) return { preferredId: buildingLookup.get(raw).id, assignment: buildingLookup.get(raw) };
    if (constructionLookup.has(raw)) return { preferredId: constructionLookup.get(raw).id, assignment: constructionLookup.get(raw) };
    if (fleetLookup.has(raw)) return { preferredId: fleetLookup.get(raw).id, assignment: fleetLookup.get(raw) };
    if (normalized === "defensecommander") return { preferredId: command.id, assignment: command };
    if (normalized === "soldier") {
      const existing = current.filter((claim) => claim.kind === "defense").sort(assignmentOrder)[0];
      const assignment = existing ?? normalizeAssignment("defense", "unrostered", "Нераспределённая оборона");
      return { preferredId: assignment.id, assignment: existing ? null : assignment };
    }
    const prefixes = [
      ["construction:", "construction", constructionLookup],
      ["building:", "building", buildingLookup],
      ["fleet:", "fleet", fleetLookup]
    ];
    for (const [prefix, kind, lookup] of prefixes) {
      if (!normalized.startsWith(prefix)) continue;
      const targetId = raw.slice(prefix.length).trim();
      const assignment = lookup.get(targetId) ?? normalizeAssignment(kind, targetId, targetId);
      return { preferredId: assignment.id, assignment };
    }
    const explicitAssignment = assignments.get(raw);
    if (explicitAssignment) return { preferredId: explicitAssignment.id, assignment: explicitAssignment };
    const assignment = normalizeAssignment("legacy", raw, person?.role || raw);
    return { preferredId: assignment.id, assignment };
  };

  const preferredByResident = new Map();
  for (const [residentId, person] of livingById) {
    const declared = resolveDeclared(person, residentId);
    preferredByResident.set(residentId, declared.preferredId);
    if (declared.assignment) addClaim(residentId, declared.assignment, "resident.workAssignment");
  }

  return { claimsByResident, preferredByResident };
}

function refreshTotals(pool) {
  for (const budget of pool.budgets ?? []) {
    budget.reservedQd = positiveWhole(budget.reservedQd, 0);
    budget.spentQd = positiveWhole(budget.spentQd, 0);
    budget.availableQd = Math.max(0, budget.capacityQd - budget.reservedQd - budget.spentQd);
    budget.workedDayKeys = [...new Set(budget.workedDayKeys ?? [])].sort((left, right) => left.localeCompare(right, "en"));
  }
  pool.totals = {
    residentCount: pool.residents.length,
    capacityQd: pool.budgets.reduce((sum, row) => sum + row.capacityQd, 0),
    reservedQd: pool.budgets.reduce((sum, row) => sum + row.reservedQd, 0),
    spentQd: pool.budgets.reduce((sum, row) => sum + row.spentQd, 0),
    availableQd: pool.budgets.reduce((sum, row) => sum + row.availableQd, 0),
    workedDays: pool.workLog.length
  };
  return pool;
}

export function buildTendayLaborPool(holding = {}, options = {}) {
  const period = buildPeriod(holding, options);
  const holdingId = text(holding?.id) || "holding";
  const people = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  const knownResidentIds = new Set(people.map((person, index) => stableResidentId(person, index)));
  const livingRows = [];
  const livingById = new Map();
  const duplicateResidentIds = [];
  const deadResidentIds = [];

  for (const [index, person] of people.entries()) {
    const baseId = stableResidentId(person, index);
    if (person?.dead) {
      deadResidentIds.push(baseId);
      continue;
    }
    let residentId = baseId;
    if (livingById.has(residentId)) {
      let duplicateIndex = 2;
      while (livingById.has(`${baseId}#${duplicateIndex}`)) duplicateIndex += 1;
      residentId = `${baseId}#${duplicateIndex}`;
      duplicateResidentIds.push({ residentId: baseId, syntheticResidentId: residentId });
    }
    livingById.set(residentId, person);
    livingRows.push({ residentId, person });
  }

  const assignments = new Map();
  const ignoredReferences = [];
  const { claimsByResident, preferredByResident } = collectAssignmentClaims(
    holding,
    livingById,
    knownResidentIds,
    assignments,
    ignoredReferences
  );
  const conflicts = [];
  const residents = [];
  const budgets = [];
  const maximumQd = period.capacityQdPerResident;

  for (const { residentId, person } of livingRows.sort((left, right) => left.residentId.localeCompare(right.residentId, "ru"))) {
    const claims = [...(claimsByResident.get(residentId)?.values() ?? [])].sort(assignmentOrder);
    const preferredId = preferredByResident.get(residentId);
    let primary = claims.find((claim) => claim.id === preferredId) ?? claims[0] ?? null;
    if (!primary) {
      primary = normalizeAssignment("unassigned", residentId, "Свободный труд");
      registerAssignment(assignments, primary);
    }
    const conflict = claims.length > 1
      ? {
          id: `labor-conflict:${period.key}:${residentId}`,
          residentId,
          primaryAssignmentId: primary.id,
          assignmentIds: claims.map((claim) => claim.id),
          kinds: [...new Set(claims.map((claim) => claim.kind))].sort(),
          sources: [...new Set(claims.flatMap((claim) => claim.sources ?? []))].sort(),
          message: `${person?.name || residentId}: одновременно назначен(а) в ${claims.length} мест.`
        }
      : null;
    if (conflict) conflicts.push(conflict);

    const defaultAvailability = residentAvailability(person, maximumQd);
    const availability = typeof options.capacityForResident === "function"
      ? normalizeCapacityResult(options.capacityForResident(person, { residentId, period: copy(period), defaultAvailability: copy(defaultAvailability) }), maximumQd)
      : defaultAvailability;
    const budgetId = `labor-budget:${holdingId}:${period.key}:${residentId}`;
    const readinessReasons = [];
    if (conflict) readinessReasons.push("assignment-conflict");
    if (availability.capacityQd <= 0) readinessReasons.push(availability.reason || "unavailable");
    residents.push({
      id: residentId,
      name: text(person?.name) || residentId,
      budgetId,
      primaryAssignmentId: primary.id,
      assignmentIds: claims.length ? claims.map((claim) => claim.id) : [primary.id],
      claimCount: claims.length,
      conflictId: conflict?.id ?? "",
      readiness: {
        ready: readinessReasons.length === 0,
        canSpend: readinessReasons.length === 0,
        reasons: readinessReasons
      }
    });
    budgets.push({
      id: budgetId,
      residentId,
      primaryAssignmentId: primary.id,
      capacityQd: availability.capacityQd,
      availabilityReason: availability.reason,
      reservedQd: 0,
      spentQd: 0,
      availableQd: availability.capacityQd,
      workedDayKeys: []
    });
  }

  const residentRowsById = new Map(residents.map((row) => [row.id, row]));
  const assignmentRows = [...assignments.values()].sort(assignmentOrder).map((assignment) => {
    const claimedResidentIds = residents
      .filter((resident) => resident.assignmentIds.includes(assignment.id))
      .map((resident) => resident.id);
    return {
      ...assignment,
      residentIds: claimedResidentIds,
      primaryResidentIds: claimedResidentIds.filter((residentId) => residentRowsById.get(residentId)?.primaryAssignmentId === assignment.id),
      conflictResidentIds: claimedResidentIds.filter((residentId) => Boolean(residentRowsById.get(residentId)?.conflictId))
    };
  });

  const blockers = [
    ...conflicts.map((row) => ({ code: "assignment-conflict", residentId: row.residentId, conflictId: row.id })),
    ...duplicateResidentIds.map((row) => ({ code: "duplicate-resident-id", ...row }))
  ];
  const pool = {
    schemaVersion: LABOR_POOL_SCHEMA_VERSION,
    holdingId,
    period,
    residents,
    assignments: assignmentRows,
    budgets,
    conflicts,
    readiness: {
      ready: blockers.length === 0,
      blockers,
      conflictCount: conflicts.length,
      duplicateResidentIdCount: duplicateResidentIds.length,
      ignoredReferenceCount: ignoredReferences.length
    },
    ignoredReferences: ignoredReferences.sort((left, right) => `${left.residentId}|${left.assignmentId}|${left.source}`.localeCompare(`${right.residentId}|${right.assignmentId}|${right.source}`, "ru")),
    excludedResidents: { deadResidentIds: deadResidentIds.sort((left, right) => left.localeCompare(right, "ru")) },
    reservations: [],
    spendOperations: [],
    workLog: [],
    totals: {}
  };
  return refreshTotals(pool);
}

export const buildLaborPoolSnapshot = buildTendayLaborPool;

function normalizeAllocations(raw = []) {
  if (!Array.isArray(raw) || !raw.length) return failure("empty-allocations", "Нужно указать хотя бы одну долю труда.");
  const allocations = new Map();
  const issues = [];
  for (const [index, row] of raw.entries()) {
    const residentId = text(row?.residentId ?? row?.id);
    const laborQd = positiveWhole(row?.laborQd ?? row?.qd, 0);
    if (!residentId || laborQd <= 0) {
      issues.push({ index, residentId, laborQd, code: "invalid-allocation" });
      continue;
    }
    allocations.set(residentId, (allocations.get(residentId) ?? 0) + laborQd);
  }
  if (issues.length) return failure("invalid-allocations", "Доли труда должны содержать жителя и целое положительное число QD.", issues);
  return {
    ok: true,
    allocations: [...allocations.entries()]
      .map(([residentId, laborQd]) => ({ residentId, laborQd }))
      .sort((left, right) => left.residentId.localeCompare(right.residentId, "ru"))
  };
}

export function reserveLabor(pool, request = {}) {
  const reservationId = text(request?.reservationId ?? request?.id);
  const assignment = text(request?.assignmentId);
  if (!reservationId) return failure("missing-reservation-id", "Резерв труда требует стабильный reservationId.");
  if (!assignment) return failure("missing-assignment-id", "Резерв труда требует assignmentId.");
  const normalized = normalizeAllocations(request?.allocations);
  if (!normalized.ok) return normalized;
  const requestHash = JSON.stringify({ assignmentId: assignment, allocations: normalized.allocations });
  const existing = (pool?.reservations ?? []).find((row) => row.id === reservationId);
  if (existing) {
    if (existing.requestHash === requestHash) return { ok: true, replayed: true, reservation: copy(existing) };
    return failure("reservation-id-conflict", "Этот reservationId уже использован для другого резерва.");
  }
  if (!(pool?.assignments ?? []).some((row) => row.id === assignment)) {
    return failure("unknown-assignment", `Назначение ${assignment} отсутствует в снимке труда.`);
  }

  const budgets = new Map((pool?.budgets ?? []).map((row) => [row.residentId, row]));
  const residents = new Map((pool?.residents ?? []).map((row) => [row.id, row]));
  const issues = [];
  for (const allocation of normalized.allocations) {
    const budget = budgets.get(allocation.residentId);
    const resident = residents.get(allocation.residentId);
    if (!budget || !resident) issues.push({ residentId: allocation.residentId, code: "unknown-resident" });
    else if (resident.conflictId) issues.push({ residentId: allocation.residentId, code: "assignment-conflict", conflictId: resident.conflictId });
    else if (budget.primaryAssignmentId !== assignment) issues.push({ residentId: allocation.residentId, code: "assignment-mismatch", primaryAssignmentId: budget.primaryAssignmentId });
    else if (allocation.laborQd > budget.availableQd) issues.push({ residentId: allocation.residentId, code: "insufficient-budget", requestedQd: allocation.laborQd, availableQd: budget.availableQd });
  }
  if (issues.length) return failure("labor-reservation-rejected", "Резерв труда отклонён: назначение или бюджет жителя не готовы.", issues);

  const reservation = {
    id: reservationId,
    assignmentId: assignment,
    requestHash,
    status: "active",
    reservedQd: normalized.allocations.reduce((sum, row) => sum + row.laborQd, 0),
    spentQd: 0,
    remainingQd: normalized.allocations.reduce((sum, row) => sum + row.laborQd, 0),
    allocations: normalized.allocations.map((row) => ({ ...row, spentQd: 0, remainingQd: row.laborQd }))
  };
  pool.reservations.push(reservation);
  for (const allocation of reservation.allocations) budgets.get(allocation.residentId).reservedQd += allocation.laborQd;
  refreshTotals(pool);
  return { ok: true, replayed: false, reservation: copy(reservation) };
}

function normalizeWork(raw = [], validDayKeys = []) {
  if (!Array.isArray(raw) || !raw.length) return failure("empty-work", "Списание труда требует рабочие дни.");
  const validDays = new Set(validDayKeys);
  const work = new Map();
  const issues = [];
  for (const [index, row] of raw.entries()) {
    const residentId = text(row?.residentId ?? row?.id);
    const dayKey = typeof row?.dayKey === "number" ? `day:${whole(row.dayKey)}` : text(row?.dayKey);
    const laborQd = positiveWhole(row?.laborQd ?? row?.qd, 0);
    if (!residentId || !validDays.has(dayKey) || laborQd <= 0) {
      issues.push({ index, residentId, dayKey, laborQd, code: "invalid-work-row" });
      continue;
    }
    const key = `${residentId}\u0000${dayKey}`;
    const current = work.get(key) ?? { residentId, dayKey, laborQd: 0 };
    current.laborQd += laborQd;
    work.set(key, current);
  }
  if (issues.length) return failure("invalid-work", "Работа должна ссылаться на жителя, день текущего десятника и целые положительные QD.", issues);
  return {
    ok: true,
    work: [...work.values()].sort((left, right) => left.dayKey.localeCompare(right.dayKey, "en") || left.residentId.localeCompare(right.residentId, "ru"))
  };
}

export function spendLabor(pool, request = {}) {
  const reservationId = text(request?.reservationId);
  const operationId = text(request?.operationId ?? request?.id);
  if (!reservationId) return failure("missing-reservation-id", "Списание труда требует reservationId.");
  if (!operationId) return failure("missing-operation-id", "Списание труда требует стабильный operationId.");
  const reservation = (pool?.reservations ?? []).find((row) => row.id === reservationId);
  if (!reservation) return failure("unknown-reservation", "Резерв труда не найден.");
  const normalized = normalizeWork(request?.work, pool?.period?.dayKeys ?? []);
  if (!normalized.ok) return normalized;
  const requestHash = JSON.stringify({ reservationId, work: normalized.work });
  const existing = (pool?.spendOperations ?? []).find((row) => row.id === operationId);
  if (existing) {
    if (existing.requestHash === requestHash) return { ok: true, replayed: true, operation: copy(existing), reservation: copy(reservation) };
    return failure("operation-id-conflict", "Этот operationId уже использован для другого списания труда.");
  }

  const allocations = new Map(reservation.allocations.map((row) => [row.residentId, row]));
  const budgets = new Map((pool?.budgets ?? []).map((row) => [row.residentId, row]));
  const requestedByResident = new Map();
  const requestedByDay = new Map();
  const issues = [];
  for (const row of normalized.work) {
    requestedByResident.set(row.residentId, (requestedByResident.get(row.residentId) ?? 0) + row.laborQd);
    const dayKey = `${row.residentId}\u0000${row.dayKey}`;
    requestedByDay.set(dayKey, (requestedByDay.get(dayKey) ?? 0) + row.laborQd);
    if (!allocations.has(row.residentId)) issues.push({ residentId: row.residentId, code: "resident-not-reserved" });
  }
  for (const [residentId, requestedQd] of requestedByResident) {
    const allocation = allocations.get(residentId);
    if (allocation && requestedQd > allocation.remainingQd) {
      issues.push({ residentId, code: "reservation-exceeded", requestedQd, remainingQd: allocation.remainingQd });
    }
  }
  for (const [key, requestedQd] of requestedByDay) {
    const [residentId, dayKey] = key.split("\u0000");
    const loggedQd = (pool?.workLog ?? []).find((row) => row.residentId === residentId && row.dayKey === dayKey)?.laborQd ?? 0;
    if (loggedQd + requestedQd > pool.period.laborQdPerDay) {
      issues.push({ residentId, dayKey, code: "daily-capacity-exceeded", requestedQd, loggedQd, capacityQd: pool.period.laborQdPerDay });
    }
  }
  if (issues.length) return failure("labor-spend-rejected", "Списание труда превышает резерв или дневную ёмкость.", issues);

  const totalQd = normalized.work.reduce((sum, row) => sum + row.laborQd, 0);
  const operation = { id: operationId, reservationId, assignmentId: reservation.assignmentId, requestHash, laborQd: totalQd, work: copy(normalized.work) };
  for (const row of normalized.work) {
    const allocation = allocations.get(row.residentId);
    const budget = budgets.get(row.residentId);
    allocation.spentQd += row.laborQd;
    allocation.remainingQd -= row.laborQd;
    budget.reservedQd -= row.laborQd;
    budget.spentQd += row.laborQd;
    if (!budget.workedDayKeys.includes(row.dayKey)) budget.workedDayKeys.push(row.dayKey);
    const logId = `labor-work:${pool.period.key}:${row.residentId}:${row.dayKey}`;
    let log = pool.workLog.find((entry) => entry.id === logId);
    if (!log) {
      log = {
        id: logId,
        residentId: row.residentId,
        dayKey: row.dayKey,
        assignmentId: reservation.assignmentId,
        laborQd: 0,
        reservationIds: [],
        operationIds: []
      };
      pool.workLog.push(log);
    }
    log.laborQd += row.laborQd;
    if (!log.reservationIds.includes(reservationId)) log.reservationIds.push(reservationId);
    if (!log.operationIds.includes(operationId)) log.operationIds.push(operationId);
    log.reservationIds.sort((left, right) => left.localeCompare(right, "en"));
    log.operationIds.sort((left, right) => left.localeCompare(right, "en"));
  }
  reservation.spentQd += totalQd;
  reservation.remainingQd -= totalQd;
  reservation.status = reservation.remainingQd > 0 ? "active" : "spent";
  pool.spendOperations.push(operation);
  pool.workLog.sort((left, right) => left.dayKey.localeCompare(right.dayKey, "en") || left.residentId.localeCompare(right.residentId, "ru"));
  refreshTotals(pool);
  return { ok: true, replayed: false, operation: copy(operation), reservation: copy(reservation) };
}

export function laborWorkLog(pool, filters = {}) {
  const residentId = text(filters?.residentId);
  const assignment = text(filters?.assignmentId);
  return copy((pool?.workLog ?? []).filter((row) => {
    if (residentId && row.residentId !== residentId) return false;
    if (assignment && row.assignmentId !== assignment) return false;
    return true;
  }));
}

export const readLaborWorkLog = laborWorkLog;
