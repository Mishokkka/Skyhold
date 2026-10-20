import { constructionLeaderQualification } from "../workers/construction-leadership.js";
import { isResidentPresent } from "../../data/resident-presence.js";

const CONSTRUCTION_MATERIAL_STATE_VERSION = 1;
const CONSTRUCTION_REFUND_NUMERATOR = 90;
const CONSTRUCTION_REFUND_DENOMINATOR = 100;
const TENDAY_QD = 40;

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finiteNumber(value, fallback)));
}

function wholeCost(value) {
  return Math.max(0, Math.ceil(finiteNumber(value, 0)));
}

function text(value) {
  return String(value ?? "").trim();
}

function cloneRow(row = {}) {
  const normalized = {
    resourceId: text(row.resourceId ?? row.id),
    resourceGroup: text(row.resourceGroup),
    name: text(row.name ?? row.label ?? row.resourceId ?? row.resourceGroup) || "Материал",
    qty: wholeCost(row.qty)
  };
  if (row.roomId !== undefined || row.storageRoomId !== undefined) {
    normalized.roomId = text(row.roomId ?? row.storageRoomId) || "outdoors";
  }
  return normalized;
}

export function normalizeConstructionCosts(costs = []) {
  return (Array.isArray(costs) ? costs : [])
    .map((row) => cloneRow(row))
    .filter((row) => row.qty > 0 && (row.resourceId || row.resourceGroup));
}

function costKey(row = {}) {
  const identity = row.resourceGroup
    ? `group:${text(row.resourceGroup)}`
    : `resource:${text(row.resourceId)}:${text(row.name).toLowerCase()}`;
  return `${identity}:room:${text(row.roomId)}`;
}

export function aggregateConstructionCosts(costs = []) {
  const rows = [];
  const byKey = new Map();
  for (const raw of normalizeConstructionCosts(costs)) {
    const key = costKey(raw);
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += raw.qty;
      continue;
    }
    const row = { ...raw };
    rows.push(row);
    byKey.set(key, row);
  }
  return rows;
}

function subtractConstructionCosts(source = [], spent = []) {
  const rows = aggregateConstructionCosts(source);
  const byKey = new Map(rows.map((row) => [costKey(row), row]));
  for (const cost of normalizeConstructionCosts(spent)) {
    const row = byKey.get(costKey(cost));
    if (!row) continue;
    row.qty = Math.max(0, row.qty - cost.qty);
  }
  return rows.filter((row) => row.qty > 0);
}

/**
 * Split an integer project cost into deterministic integer stages. Every early
 * stage receives floor(total / stages); the complete remainder is carried into
 * the final stage. This is the campaign's explicit C3 rule and keeps inventory
 * whole even when a material quantity is smaller than the stage count.
 */
export function constructionStageCosts(costs = [], target = 1, stage = 1) {
  const stages = Math.max(1, whole(target, 1));
  const stageNumber = Math.max(1, Math.min(stages, whole(stage, 1)));
  return normalizeConstructionCosts(costs)
    .map((row) => {
      const base = Math.floor(row.qty / stages);
      const remainder = row.qty % stages;
      return { ...row, qty: base + (stageNumber === stages ? remainder : 0) };
    })
    .filter((row) => row.qty > 0);
}

export function constructionCostsForStageRange(costs = [], target = 1, firstStage = 1, lastStage = target) {
  const stages = Math.max(1, whole(target, 1));
  const from = Math.max(1, Math.min(stages + 1, whole(firstStage, 1)));
  const to = Math.max(0, Math.min(stages, whole(lastStage, stages)));
  const rows = [];
  for (let stage = from; stage <= to; stage += 1) {
    rows.push(...constructionStageCosts(costs, stages, stage));
  }
  return aggregateConstructionCosts(rows);
}

function migrationMarksProjectPrepaid(holding = {}, building = {}) {
  const buildingId = text(building.id);
  const namespaces = holding?.gm?.migrationMetadata && typeof holding.gm.migrationMetadata === "object"
    ? Object.values(holding.gm.migrationMetadata)
    : [];
  return namespaces.some((marker) => Object.values(marker?.projects ?? {}).some((project) => (
    text(project?.buildingId) === buildingId
      && project?.materialsFullyPaid === true
      && project?.futureMaterialCharge === false
  )));
}

export function constructionHasLegacyPrepayment(holding = {}, building = {}) {
  return building?.materialsAllocated === true || migrationMarksProjectPrepaid(holding, building);
}

export function sourceMaterialState(holding = {}, building = {}) {
  const current = building?.constructionMaterials && typeof building.constructionMaterials === "object"
    ? building.constructionMaterials
    : null;
  const target = Math.max(1, whole(building?.buildTarget, 1));
  const progress = Math.min(target, whole(building?.buildProgress, 0));
  if (current) {
    return {
      version: CONSTRUCTION_MATERIAL_STATE_VERSION,
      mode: current.mode === "legacy-prepaid" ? "legacy-prepaid" : "staged",
      target: Math.max(1, whole(current.target, target)),
      totalCosts: normalizeConstructionCosts(current.totalCosts?.length ? current.totalCosts : building.materialCosts),
      spent: aggregateConstructionCosts(current.spent),
      prepaidRemaining: aggregateConstructionCosts(current.prepaidRemaining),
      cancelled: current.cancelled === true,
      cancelOperationId: text(current.cancelOperationId),
      refund: aggregateConstructionCosts(current.refund)
    };
  }

  const totalCosts = normalizeConstructionCosts(building?.materialCosts);
  const prepaid = constructionHasLegacyPrepayment(holding, building);
  return {
    version: CONSTRUCTION_MATERIAL_STATE_VERSION,
    mode: prepaid ? "legacy-prepaid" : "staged",
    target,
    totalCosts,
    spent: prepaid ? constructionCostsForStageRange(totalCosts, target, 1, progress) : [],
    prepaidRemaining: prepaid ? constructionCostsForStageRange(totalCosts, target, progress + 1, target) : [],
    cancelled: false,
    cancelOperationId: "",
    refund: []
  };
}

/** Read-only capital budget; recorded prepayment is distinct from material consumption. */
export function constructionCapitalBudget(holding = {}, building = {}) {
  const state = sourceMaterialState(holding, building);
  const remaining = constructionCostsForStageRange(state.totalCosts, state.target, whole(building.buildProgress) + 1, state.target);
  const unpaid = subtractConstructionCosts(remaining, state.prepaidRemaining);
  const money = unpaid.filter((row) => row.resourceId === "money").reduce((sum, row) => sum + row.qty, 0);
  return { spent: state.spent, prepaid: state.prepaidRemaining, unpaid, money,
    treasuryAfterMaterials: whole(holding.storage?.moneyCopper) - money };
}

function persistMaterialState(building, state) {
  building.constructionMaterials = {
    version: CONSTRUCTION_MATERIAL_STATE_VERSION,
    mode: state.mode,
    target: state.target,
    totalCosts: normalizeConstructionCosts(state.totalCosts),
    spent: aggregateConstructionCosts(state.spent),
    prepaidRemaining: aggregateConstructionCosts(state.prepaidRemaining),
    cancelled: state.cancelled === true,
    cancelOperationId: text(state.cancelOperationId),
    refund: aggregateConstructionCosts(state.refund)
  };
  return building.constructionMaterials;
}

function rawConstructionCrew(holding = {}, crewId = "") {
  const id = text(crewId);
  const rows = Array.isArray(holding?.constructionCrews) ? holding.constructionCrews : [];
  return rows.find((row) => text(row?.id) === id) ?? null;
}

function availableRawCrewMemberIds(holding = {}, crew = {}) {
  const leaderId = text(crew?.leaderId);
  const ids = new Set((Array.isArray(crew?.memberIds) ? crew.memberIds : []).map((id) => text(id)).filter((id) => id && id !== leaderId));
  const people = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  if (!people.length) return ids;
  const available = new Set(people
    .filter((person) => ids.has(text(person?.id)))
    .filter((person) => isResidentPresent(person) && !person?.dead && whole(person?.injuredDays, 0) <= 0)
    .map((person) => text(person.id)));
  return available;
}

export function constructionCrewEligibility({ holding, crewId = "", crew = null, minimumCrew = 2 } = {}) {
  const rawCrew = rawConstructionCrew(holding, crewId);
  if (!rawCrew) return { ok: false, code: "missing-crew", count: 0, minimumCrew, message: "Стройбригада не найдена." };
  const rawAvailableIds = availableRawCrewMemberIds(holding, rawCrew);
  const preparedMembers = Array.isArray(crew?.members)
    ? crew.members.filter((person) => isResidentPresent(person) && !person?.dead && whole(person?.injuredDays, 0) <= 0)
    : [];
  const count = preparedMembers.length
    ? preparedMembers.length
    : (Number.isFinite(Number(crew?.count)) ? whole(crew.count, 0) : rawAvailableIds.size);
  const required = Math.max(2, whole(minimumCrew, 2));
  if (count < required) {
    return {
      ok: false,
      code: "minimum-crew",
      count,
      minimumCrew: required,
      message: `Для строительства нужны минимум ${required} живых доступных рабочих и отдельный руководитель.`
    };
  }
  const leaderId = text(rawCrew.leaderId ?? crew?.leaderId);
  const rawLeader = (holding?.people?.list ?? []).find((person) => text(person?.id) === leaderId) ?? null;
  const preparedLeader = crew?.leader && text(crew.leader.id) === leaderId ? crew.leader : null;
  const leader = preparedLeader ?? rawLeader;
  const leaderQualification = isResidentPresent(leader) ? constructionLeaderQualification(leader) : { eligible: false, reason: "руководитель находится вне поселения" };
  if (!leaderId || !leader || !leaderQualification.eligible) {
    return {
      ok: false,
      code: "foreman",
      count,
      minimumCrew: required,
      message: `Для строительства назначь отдельного подходящего руководителя бригады${leaderQualification.reason ? `: ${leaderQualification.reason}` : "."}`
    };
  }
  return { ok: true, code: "ready", count, minimumCrew: required, leaderId, leader, leaderQualification, crew: rawCrew };
}

export function constructionPeriodForHolding(holding = {}, offset = 0) {
  const currentQd = whole(holding?.gm?.calendaria?.lastQd, 0);
  return Math.floor(currentQd / TENDAY_QD) + 1 + whole(offset, 0);
}

export function constructionAttemptGate({ holding, crewId = "", crew = null, minimumCrew = 2, period = null } = {}) {
  const targetPeriod = period === null || period === undefined
    ? constructionPeriodForHolding(holding)
    : whole(period, constructionPeriodForHolding(holding));
  const eligibility = constructionCrewEligibility({ holding, crewId, crew, minimumCrew });
  if (!eligibility.ok) return { ...eligibility, replay: false, period: targetPeriod };
  const rawCrew = eligibility.crew;
  const lastPeriod = whole(rawCrew.lastConstructionPeriod, 0);
  if (lastPeriod >= targetPeriod) {
    return {
      ok: false,
      replay: true,
      period: targetPeriod,
      lastPeriod,
      operationId: text(rawCrew.lastConstructionOperationId),
      message: "Эта стройбригада уже делала строительный бросок в этом десятнике."
    };
  }
  return { ...eligibility, ok: true, replay: false, period: targetPeriod, lastPeriod, crew: rawCrew };
}

function requireAttemptDependencies(dependencies = {}) {
  for (const name of ["buildingOperationalState", "advanceBuildingProject", "planStorageCosts", "payStorageCosts"]) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`construction stages require dependencies.${name}`);
    }
  }
  return dependencies;
}

function markConstructionAttempt(crew, period, operationId = "") {
  crew.lastConstructionPeriod = whole(period, 0);
  crew.lastConstructionOperationId = text(operationId);
}

function paymentMissingText(missing = []) {
  return (Array.isArray(missing) ? missing : [])
    .map((raw) => ({ ...cloneRow(raw), have: whole(raw?.have, 0) }))
    .filter((row) => row.qty > 0)
    .map((row) => `${row.name}: нужно ${row.qty}, есть ${row.have}`)
    .join("; ");
}

export function resolveConstructionAttempt({
  holding,
  building,
  crewId = "",
  crew = null,
  successes = 0,
  period = null,
  operationId = "",
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object" || !building || typeof building !== "object") {
    throw new TypeError("construction attempt requires a holding and building draft");
  }
  const assignedCrewId = text(building.constructionCrewId);
  const requestedCrewId = text(crewId);
  if (!assignedCrewId || assignedCrewId !== requestedCrewId) {
    return {
      attempted: false,
      replay: false,
      code: "crew-binding",
      message: assignedCrewId
        ? "На проект назначена другая стройбригада."
        : "Сначала назначь стройбригаду на проект."
    };
  }
  const deps = requireAttemptDependencies(dependencies);
  const gate = constructionAttemptGate({ holding, crewId, crew, period });
  if (!gate.ok) return { attempted: false, ...gate };

  const rolledSuccesses = whole(successes, 0);
  const operationalState = deps.buildingOperationalState(building);
  const repairActive = operationalState?.repairActive === true;
  const oldProgress = repairActive
    ? whole(building?.repair?.progress ?? building?.repairProgress, 0)
    : whole(building?.buildProgress, 0);
  const target = Math.max(1, repairActive
    ? whole(building?.repair?.target ?? building?.repairTarget, 1)
    : whole(building?.buildTarget, 1));
  const requestedStages = Math.min(rolledSuccesses, Math.max(0, target - oldProgress));
  const materialState = repairActive ? null : sourceMaterialState(holding, building);
  if (materialState?.cancelled) {
    return {
      attempted: false,
      replay: true,
      cancelled: true,
      period: gate.period,
      message: "Проект уже отменён."
    };
  }
  markConstructionAttempt(gate.crew, gate.period, operationId);

  if (repairActive) {
    const progress = deps.advanceBuildingProject(building, requestedStages);
    return {
      attempted: true,
      replay: false,
      kind: "repair",
      period: gate.period,
      rolledSuccesses,
      requestedStages,
      appliedStages: requestedStages,
      oldProgress: progress.oldProgress,
      nextProgress: progress.nextProgress,
      target: progress.target,
      completed: progress.completed,
      spent: [],
      missing: []
    };
  }

  materialState.target = target;
  const spent = [];
  const charged = [];
  let missing = [];
  let appliedStages = 0;

  for (let offset = 0; offset < requestedStages; offset += 1) {
    const stage = oldProgress + offset + 1;
    const stageCosts = constructionStageCosts(materialState.totalCosts, target, stage);
    if (materialState.mode === "legacy-prepaid") {
      materialState.prepaidRemaining = subtractConstructionCosts(materialState.prepaidRemaining, stageCosts);
      materialState.spent = aggregateConstructionCosts([...materialState.spent, ...stageCosts]);
      spent.push(...stageCosts);
      appliedStages += 1;
      continue;
    }

    const payment = deps.planStorageCosts(holding, stageCosts);
    if (!payment?.ok) {
      missing = Array.isArray(payment?.missing) ? payment.missing : stageCosts;
      break;
    }
    const concreteCosts = normalizeConstructionCosts(payment.costs);
    deps.payStorageCosts(holding, concreteCosts);
    materialState.spent = aggregateConstructionCosts([...materialState.spent, ...concreteCosts]);
    spent.push(...concreteCosts);
    charged.push(...concreteCosts);
    appliedStages += 1;
  }

  const progress = deps.advanceBuildingProject(building, appliedStages);
  persistMaterialState(building, materialState);
  const concreteSpent = aggregateConstructionCosts(spent);
  const chargedThisAttempt = aggregateConstructionCosts(charged);
  if (chargedThisAttempt.length && typeof deps.appendStorageLog === "function") {
    deps.appendStorageLog(holding, chargedThisAttempt.map((row) => ({
      kind: "construction-material",
      resourceId: row.resourceId,
      name: row.name,
      qty: -row.qty,
      roomId: row.roomId,
      source: building.name || "Строительство",
      note: `Стадии ${oldProgress + 1}-${oldProgress + appliedStages}`,
      operationId: text(operationId)
    })));
  }

  return {
    attempted: true,
    replay: false,
    kind: "construction",
    period: gate.period,
    rolledSuccesses,
    requestedStages,
    appliedStages,
    oldProgress: progress.oldProgress,
    nextProgress: progress.nextProgress,
    target: progress.target,
    completed: progress.completed,
    spent: concreteSpent,
    charged: chargedThisAttempt,
    missing: normalizeConstructionCosts(missing),
    missingText: paymentMissingText(missing),
    prepaid: materialState.mode === "legacy-prepaid"
  };
}

function cancellationRefundRows(state) {
  const spentRefund = normalizeConstructionCosts(state.spent).map((row) => ({
    ...row,
    qty: Math.floor((row.qty * CONSTRUCTION_REFUND_NUMERATOR) / CONSTRUCTION_REFUND_DENOMINATOR)
  }));
  return aggregateConstructionCosts([...spentRefund, ...normalizeConstructionCosts(state.prepaidRemaining)]);
}

function constructionMaterialStateKey(state = {}) {
  return JSON.stringify({
    mode: state.mode === "legacy-prepaid" ? "legacy-prepaid" : "staged",
    target: Math.max(1, whole(state.target, 1)),
    totalCosts: normalizeConstructionCosts(state.totalCosts),
    spent: aggregateConstructionCosts(state.spent),
    prepaidRemaining: aggregateConstructionCosts(state.prepaidRemaining),
    cancelled: state.cancelled === true
  });
}

function constructionLifecycleKey(building = {}) {
  return [
    text(building.lifecycle),
    text(building.constructionStatus),
    building?.repair?.active === true ? "repair" : "project"
  ].join(":");
}

export function planConstructionCancellation({ holding, building, operationId = "" } = {}) {
  if (!holding || typeof holding !== "object" || !building || typeof building !== "object") {
    throw new TypeError("construction cancellation requires a holding and building draft");
  }
  const state = sourceMaterialState(holding, building);
  if (state.cancelled) {
    return {
      ok: true,
      replay: true,
      buildingId: text(building.id),
      operationId: state.cancelOperationId,
      refund: aggregateConstructionCosts(state.refund),
      stateKey: constructionMaterialStateKey(state),
      state
    };
  }
  const lifecycle = text(building.lifecycle);
  const legacyStatus = text(building.constructionStatus);
  const progress = whole(building.buildProgress, 0);
  const target = Math.max(1, whole(building.buildTarget, 1));
  const activeProject = ["planned", "building"].includes(lifecycle)
    || ["planned", "building"].includes(legacyStatus);
  if (!activeProject || progress >= target || building?.repair?.active === true) {
    return {
      ok: false,
      replay: false,
      blocked: true,
      buildingId: text(building.id),
      operationId: text(operationId),
      refund: [],
      message: "Отменить с возвратом можно только незавершённый проект строительства."
    };
  }
  const refund = cancellationRefundRows(state);
  const unresolved = refund.filter((row) => row.resourceGroup && !row.resourceId);
  if (unresolved.length) {
    return {
      ok: false,
      replay: false,
      blocked: true,
      operationId: text(operationId),
      refund: [],
      unresolved,
      message: "Нельзя автоматически вернуть старую предоплату группой материалов: ГМ должен выбрать конкретные ресурсы."
    };
  }
  return {
    ok: true,
    replay: false,
    buildingId: text(building.id),
    operationId: text(operationId),
    refund,
    state,
    stateKey: constructionMaterialStateKey(state),
    lifecycleKey: constructionLifecycleKey(building),
    progress,
    target
  };
}

export function applyConstructionCancellation({ holding, building, plan, dependencies = {} } = {}) {
  if (!plan?.ok) return plan ?? { ok: false, message: "План отмены строительства не подготовлен." };
  if (text(building?.id) !== text(plan.buildingId)) {
    return { ok: false, stale: true, message: "План отмены подготовлен для другого проекта." };
  }
  const current = sourceMaterialState(holding, building);
  if (current.cancelled) {
    if (text(current.cancelOperationId) !== text(plan.operationId)) {
      return { ok: false, replay: false, conflict: true, message: "Проект уже отменён другой операцией." };
    }
    return {
      ok: true,
      replay: true,
      operationId: current.cancelOperationId,
      refund: aggregateConstructionCosts(current.refund)
    };
  }
  if (whole(building.buildProgress, 0) !== whole(plan.progress, 0)) {
    return { ok: false, stale: true, message: "Прогресс строительства изменился после подготовки отмены." };
  }
  if (Math.max(1, whole(building.buildTarget, 1)) !== Math.max(1, whole(plan.target, 1))
    || constructionMaterialStateKey(current) !== String(plan.stateKey ?? "")
    || constructionLifecycleKey(building) !== String(plan.lifecycleKey ?? "")) {
    return { ok: false, stale: true, message: "Стоимость или состояние материалов изменились после подготовки отмены." };
  }
  if (typeof dependencies.addStorageWithOverflow !== "function") {
    throw new TypeError("construction cancellation requires dependencies.addStorageWithOverflow");
  }

  const placements = [];
  for (const row of normalizeConstructionCosts(plan.refund)) {
    const added = dependencies.addStorageWithOverflow(holding, row, row.qty);
    placements.push(...(Array.isArray(added) ? added.map((placement) => ({ ...row, ...placement })) : []));
  }
  const state = {
    ...plan.state,
    cancelled: true,
    cancelOperationId: text(plan.operationId),
    refund: aggregateConstructionCosts(plan.refund),
    prepaidRemaining: []
  };
  persistMaterialState(building, state);
  if (state.refund.length && typeof dependencies.appendStorageLog === "function") {
    dependencies.appendStorageLog(holding, state.refund.map((row) => ({
      kind: "construction-refund",
      resourceId: row.resourceId,
      name: row.name,
      qty: row.qty,
      roomId: row.roomId,
      source: building.name || "Строительство",
      note: "Отмена проекта",
      operationId: text(plan.operationId)
    })));
  }
  return {
    ok: true,
    replay: false,
    operationId: text(plan.operationId),
    refund: state.refund,
    placements
  };
}
