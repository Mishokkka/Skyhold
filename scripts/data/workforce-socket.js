import { activeSkyholdGm } from "./authority.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";
import { MODULE_ID } from "./constants.js";
import { acceptsGmSocketResponse, acceptsStorageSocketRequest } from "./socket-auth.js";
import { isPlainObject } from "./utils.js";
import { MAX_WORK_ALLOCATIONS_PER_PERSON, workAllocationTargetKey } from "./work-allocations.js";
import { workforceLockKey, workforceProductionGoalKey } from "./workforce-plan.js";

const REQUEST = "workforceOperationRequest";
const RESPONSE = "workforceOperationResponse";
const CHANNEL = `module.${MODULE_ID}`;
const MAX_PEOPLE = 250;
const MAX_JSON = 240_000;
const identifier = (value) => typeof value === "string" && value.length > 0 && value.length <= 200 && value === value.trim();
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function buildWorkforceCommand({ operationId, holdingId, expectedRevision, draft, initial }) {
  const tuple = ({ sourceId, functionId, normalQd, overtimeQd }) => [sourceId, functionId, normalQd, overtimeQd];
  const allocationsByPersonId = Object.fromEntries(draft.edited.flatMap((personId) => {
    const before = (initial.allocations[personId] ?? []).filter((row) => row.normalQd || row.overtimeQd).map(tuple);
    const after = (draft.allocations[personId] ?? []).filter((row) => row.normalQd || row.overtimeQd).map(tuple);
    return same(before, after) ? [] : [[personId, after]];
  }));
  const changes = (kind, keyFor) => {
    const before = new Map(initial.plan[kind].map((row) => [keyFor(row), row]));
    const after = new Map(draft.plan[kind].map((row) => [keyFor(row), row]));
    return [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
      const row = after.get(key) ?? before.get(key);
      if (same(before.get(key), after.get(key))) return [];
      return kind === "locks" ? [[row.personId, row.sourceId, row.functionId, after.has(key)]]
        : [[row.sourceId, row.functionId, after.get(key)?.preparedUnits ?? 0]];
    });
  };
  return { operationId, holdingId, expectedRevision, allocationsByPersonId,
    locks: changes("locks", workforceLockKey), productionGoals: changes("productionGoals", workforceProductionGoalKey) };
}

export function buildBuildingLaborWithdrawalCommand({ operationId, holdingId, expectedRevision, buildingId, functionId = "", token }) {
  return {
    kind: "withdraw-building-labor",
    operationId,
    holdingId,
    expectedRevision,
    buildingId,
    ...(functionId ? { functionId } : {}),
    token
  };
}

export function buildResidentAllocationRemovalCommand({ operationId, holdingId, expectedRevision, personId, buildingId, functionId = "" }) {
  return {
    kind: "remove-resident-allocation",
    operationId,
    holdingId,
    expectedRevision,
    personId,
    buildingId,
    ...(functionId ? { functionId } : {})
  };
}

export function buildResidentAllocationAddCommand({
  operationId,
  holdingId,
  expectedRevision,
  personId,
  buildingId,
  functionId,
  normalQd,
  overtimeQd = 0,
  allowAdmissionOverride = false
}) {
  return {
    kind: "add-resident-allocation",
    operationId,
    holdingId,
    expectedRevision,
    personId,
    buildingId,
    functionId,
    normalQd,
    overtimeQd,
    ...(allowAdmissionOverride ? { allowAdmissionOverride: true } : {})
  };
}

export function workforceCommandProblem(raw) {
  if (!isPlainObject(raw) || !identifier(raw.operationId) || raw.operationId.length > 100 || !identifier(raw.holdingId)
    || !whole(raw.expectedRevision)) return "Некорректная команда плана работ.";
  if (JSON.stringify(raw).length > MAX_JSON) {
    return "Дельта превышает лимит команды (250 жителей, 24 строки на жителя, 240 000 символов).";
  }
  const kind = raw.kind ?? "save-plan";
  if (kind === "withdraw-building-labor") {
    if (Object.keys(raw).some((field) => !["kind", "operationId", "holdingId", "expectedRevision", "buildingId", "functionId", "token"].includes(field))
      || !identifier(raw.buildingId)
      || (raw.functionId !== undefined && raw.functionId !== "" && !identifier(raw.functionId))
      || !identifier(raw.token)) {
      return "Некорректная команда освобождения работников.";
    }
    return "";
  }
  if (kind === "remove-resident-allocation") {
    if (Object.keys(raw).some((field) => !["kind", "operationId", "holdingId", "expectedRevision", "personId", "buildingId", "functionId"].includes(field))
      || !identifier(raw.personId) || !identifier(raw.buildingId)
      || (raw.functionId !== undefined && raw.functionId !== "" && !identifier(raw.functionId))) {
      return "Некорректная команда снятия назначения.";
    }
    return "";
  }
  if (kind === "add-resident-allocation") {
    if (Object.keys(raw).some((field) => !["kind", "operationId", "holdingId", "expectedRevision",
      "personId", "buildingId", "functionId", "normalQd", "overtimeQd", "allowAdmissionOverride"].includes(field))
      || !identifier(raw.personId) || !identifier(raw.buildingId) || !identifier(raw.functionId)
      || !whole(raw.normalQd) || !whole(raw.overtimeQd) || raw.normalQd + raw.overtimeQd <= 0
      || (raw.allowAdmissionOverride !== undefined && typeof raw.allowAdmissionOverride !== "boolean")) {
      return "Некорректная команда добавления назначения.";
    }
    return "";
  }
  if (kind !== "save-plan" || !isPlainObject(raw.allocationsByPersonId)
    || (raw.locks !== undefined && !Array.isArray(raw.locks))
    || (raw.productionGoals !== undefined && !Array.isArray(raw.productionGoals))
    || Object.keys(raw).some((field) => !["kind", "operationId", "holdingId", "expectedRevision", "allocationsByPersonId",
      "locks", "productionGoals", "admissionOverrideBuildingIds"].includes(field))) return "Некорректная команда плана работ.";
  const people = Object.entries(raw.allocationsByPersonId);
  if (people.length > MAX_PEOPLE
    || people.some(([, rows]) => Array.isArray(rows) && rows.length > MAX_WORK_ALLOCATIONS_PER_PERSON)) {
    return "Дельта превышает лимит команды (250 жителей, 24 строки на жителя, 240 000 символов).";
  }
  for (const [id, rows] of people) {
    if (!identifier(id) || !Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== 4
      || !identifier(row[0]) || !identifier(row[1]) || !whole(row[2]) || !whole(row[3]) || !(row[2] || row[3]))
      || new Set(rows.map(([source, fn]) => workAllocationTargetKey(source, fn))).size !== rows.length) {
      return "Некорректные строки распределения QD.";
    }
  }
  if (raw.locks?.some((row) => !Array.isArray(row) || row.length !== 4
    || !row.slice(0, 3).every(identifier) || typeof row[3] !== "boolean")
    || raw.productionGoals?.some((row) => !Array.isArray(row) || row.length !== 3
      || !identifier(row[0]) || !identifier(row[1]) || !whole(row[2]) || row[2] > 1_000_000)) return "Некорректные цели или закрепления.";
  const overrides = raw.admissionOverrideBuildingIds;
  if (overrides !== undefined && (!isPlainObject(overrides) || Object.entries(overrides).some(([id, buildings]) =>
    !Object.hasOwn(raw.allocationsByPersonId, id) || !Array.isArray(buildings) || !buildings.every(identifier)))) {
    return "Некорректные допуски к работам.";
  }
  return "";
}

export function createWorkforceSocketApi({ store, writeTimeoutMs = 8000 }) {
  const pending = new Map();
  const failure = (id, code, message, retryable = false) => commandError(commandFailure({ operationId: id, code, message, retryable }));
  async function requestWorkforceOperation(operation) {
    const id = operation?.operationId;
    const problem = workforceCommandProblem(operation);
    if (problem) throw failure(id, COMMAND_ERROR.INVALID, problem);
    const userId = game.user?.id;
    const authority = activeSkyholdGm();
    if (game.user?.isGM && (!authority || authority.id === userId)) {
      const { executeWorkforcePlan } = await import("../apps/workforce-plan-executor.js");
      return executeWorkforcePlan(operation, { senderId: userId, store });
    }
    if (!game.socket?.emit) throw failure(id, COMMAND_ERROR.SOCKET_UNAVAILABLE, "Socket недоступен.", true);
    if (!authority) throw failure(id, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМа.", true);
    if (pending.has(id)) throw failure(id, COMMAND_ERROR.CONFLICT, "Запрос уже ожидает ответа.");
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, attempts: 0, authorities: new Set(), currentGmId: "", timeout: null };
      const stop = (error) => { pending.delete(id); clearTimeout(entry.timeout); reject(error); };
      const unknown = () => failure(id, COMMAND_ERROR.OUTCOME_UNKNOWN,
        "Исход сохранения неизвестен. Проверьте общий план перед повторной отправкой того же запроса.", true);
      const emit = () => {
        const gm = activeSkyholdGm();
        if (!gm) return stop(entry.attempts ? unknown() : failure(id, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМа.", true));
        entry.attempts += 1;
        entry.currentGmId = gm.id;
        entry.authorities.add(gm.id);
        entry.timeout = setTimeout(() => entry.attempts < 2 ? emit() : stop(unknown()), writeTimeoutMs);
        try {
          game.socket.emit(CHANNEL, { type: REQUEST, requestId: id, operationId: id,
            expectedRevision: operation.expectedRevision, targetGmId: gm.id, userId, operation });
        } catch (error) {
          stop(entry.attempts > 1 ? unknown() : failure(id, COMMAND_ERROR.SOCKET_UNAVAILABLE, error.message, true));
        }
      };
      pending.set(id, entry);
      emit();
    });
  }

  async function handleWorkforcePayload(payload, senderId) {
    if (payload.type === RESPONSE) {
      const entry = pending.get(payload.requestId);
      if (!acceptsGmSocketResponse(payload, senderId, entry)) return true;
      const command = commandResultFromPayload(payload);
      if (!command.ok && senderId !== entry.currentGmId) return true;
      clearTimeout(entry.timeout);
      pending.delete(payload.requestId);
      if (command.ok) entry.resolve(payload.result);
      else entry.reject(commandError(command));
      return true;
    }
    if (payload.type !== REQUEST) return false;
    if (!acceptsStorageSocketRequest(payload, senderId)) return true;
    let command, result;
    try {
      if (payload.requestId !== payload.operationId || payload.operation?.operationId !== payload.operationId
        || payload.operation.expectedRevision !== payload.expectedRevision) {
        throw failure(payload.operationId, COMMAND_ERROR.INVALID, "Метаданные команды плана работ не совпадают.");
      }
      const { executeWorkforcePlan } = await import("../apps/workforce-plan-executor.js");
      result = await executeWorkforcePlan(payload.operation, { senderId, store });
      command = commandSuccess({ operationId: payload.operationId, revision: result.revision });
    } catch (error) {
      command = commandFailure({ operationId: payload.operationId, code: error.code, message: error.message,
        revision: error.revision, retryable: error.retryable });
    }
    game.socket?.emit?.(CHANNEL, { type: RESPONSE, requestId: payload.requestId,
      operationId: payload.operationId, userId: senderId, gmId: game.user.id, command, result });
    return true;
  }
  return { requestWorkforceOperation, handleWorkforcePayload };
}
