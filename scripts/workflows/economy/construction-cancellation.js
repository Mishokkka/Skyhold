import { appendHoldingOperation, findHoldingOperation } from "../../data/operations.js";
import {
  applyConstructionCancellation,
  planConstructionCancellation
} from "../../engines/economy/construction-stages.js";

const OPERATION_TYPE = "construction-cancellation";

function text(value) {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function cloneRefund(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    resourceId: text(row?.resourceId ?? row?.id),
    resourceGroup: text(row?.resourceGroup),
    name: text(row?.name ?? row?.label ?? row?.resourceId) || "Материал",
    qty: whole(row?.qty),
    ...(row?.roomId !== undefined ? { roomId: text(row.roomId) || "outdoors" } : {})
  })).filter((row) => row.qty > 0);
}

function refundSummary(rows = []) {
  const labels = cloneRefund(rows).map((row) => `${row.name}: ${row.qty}`);
  return labels.length ? labels.join("; ") : "без возврата материалов";
}

export function isCancellableConstructionProject(building = {}) {
  const lifecycle = text(building?.lifecycle);
  const legacyStatus = text(building?.constructionStatus);
  const progress = whole(building?.buildProgress);
  const target = Math.max(1, whole(building?.buildTarget, 1));
  return building?.repair?.active !== true
    && progress < target
    && (["planned", "building"].includes(lifecycle) || ["planned", "building"].includes(legacyStatus));
}

function replayResult(existing, buildingId, operationId) {
  if (!existing) return null;
  const existingBuildingId = text(existing?.payload?.buildingId);
  if (existing.type !== OPERATION_TYPE || existingBuildingId !== buildingId) {
    return {
      ok: false,
      replay: false,
      conflict: true,
      operationId,
      message: "Этот operationId уже принадлежит другой операции."
    };
  }
  return {
    ok: true,
    replay: true,
    operationId,
    buildingId,
    buildingName: text(existing?.payload?.buildingName),
    crewId: text(existing?.payload?.crewId),
    clearedWorkerIds: Array.isArray(existing?.payload?.clearedWorkerIds)
      ? existing.payload.clearedWorkerIds.map((id) => text(id)).filter(Boolean)
      : [],
    refund: cloneRefund(existing?.payload?.refund),
    operation: existing
  };
}

function releaseAssignedWorkers(holding, building, dependencies = {}) {
  const buildingId = text(building?.id);
  const assignedIds = [...new Set((Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [])
    .map((id) => text(id))
    .filter(Boolean))];
  const clearedWorkerIds = [];
  const people = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  for (const personId of assignedIds) {
    const person = people.find((row) => text(row?.id) === personId);
    if (!person || text(person.workAssignment) !== buildingId) continue;
    if (typeof dependencies.setPersonFree === "function") dependencies.setPersonFree(holding, personId);
    else {
      person.workAssignment = "";
      person.role = "Свободен";
      person.salary = 0;
    }
    clearedWorkerIds.push(personId);
  }
  building.assignedWorkerIds = [];
  return clearedWorkerIds;
}

/**
 * Apply the confirmed C1 lifecycle as one holding-draft transaction. The low
 * level material plan/apply pair remains the authority for the exact refund;
 * this workflow owns removal, assignment cleanup and the immutable audit row.
 */
export function applyConstructionProjectCancellation({
  holding,
  buildingId = "",
  operationId = "",
  createdAt = "",
  plan: preparedPlan = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") {
    throw new TypeError("construction project cancellation requires a holding draft");
  }
  const id = text(operationId);
  const targetId = text(buildingId);
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id) || !targetId) {
    return { ok: false, replay: false, invalid: true, operationId: id, message: "Некорректный operationId или id проекта." };
  }

  const replay = replayResult(findHoldingOperation(holding, id), targetId, id);
  if (replay) return replay;

  const buildings = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const buildingIndex = buildings.findIndex((row) => text(row?.id) === targetId);
  if (buildingIndex < 0) {
    return { ok: false, replay: false, missing: true, operationId: id, buildingId: targetId, message: "Проект строительства не найден." };
  }
  const building = buildings[buildingIndex];
  const plan = preparedPlan ?? planConstructionCancellation({ holding, building, operationId: id });
  if (!plan.ok) return plan;
  if (text(plan.operationId) !== id) {
    return {
      ok: false,
      replay: false,
      conflict: true,
      operationId: id,
      message: "Подготовленный Preview отмены принадлежит другой операции."
    };
  }
  if (plan.replay && text(plan.operationId) !== id) {
    return {
      ok: false,
      replay: false,
      conflict: true,
      operationId: id,
      existingOperationId: text(plan.operationId),
      message: "Проект уже отменён другой операцией."
    };
  }

  const crewId = text(building.constructionCrewId);
  const buildingName = text(building.name) || "Проект";
  const applied = applyConstructionCancellation({ holding, building, plan, dependencies });
  if (!applied.ok) return applied;

  const clearedWorkerIds = releaseAssignedWorkers(holding, building, dependencies);
  const refund = cloneRefund(applied.refund);
  const operation = appendHoldingOperation(holding, {
    id,
    operationId: id,
    type: OPERATION_TYPE,
    createdAt: text(createdAt),
    title: `Отмена проекта: ${buildingName}`,
    summary: `Проект удалён; возврат — ${refundSummary(refund)}.`,
    cleared: clearedWorkerIds.length,
    payload: {
      buildingId: targetId,
      buildingName,
      crewId,
      progress: whole(plan.progress),
      target: Math.max(1, whole(plan.target, 1)),
      clearedWorkerIds: [...clearedWorkerIds],
      refund
    }
  });

  buildings.splice(buildingIndex, 1);
  return {
    ok: true,
    replay: false,
    operationId: id,
    buildingId: targetId,
    buildingName,
    crewId,
    clearedWorkerIds,
    refund,
    placements: applied.placements ?? [],
    materialReplay: applied.replay === true,
    operation
  };
}
