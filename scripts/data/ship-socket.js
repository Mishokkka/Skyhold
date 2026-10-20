import { activeSkyholdGm } from "./authority.js";
import { acceptsGmSocketResponse, acceptsPlayerSocketRequest } from "./socket-auth.js";
import { MODULE_ID } from "./constants.js";
import { makeId } from "./utils.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";

export function createShipSocketApi({ executeShipOperation, getData, writeTimeoutMs = 8000 }) {
  const pending = new Map();
  function failure(operationId, code, message) {
    return commandError(commandFailure({ operationId, code, message, retryable: true }));
  }
  function requestShipOperation(raw) {
    const operation = { ...raw, operationId: raw.operationId || makeId("ship-op", 20) };
    if (game.user?.isGM) return executeShipOperation(operation, { userId: game.user.id });
    if (!game.socket) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.SOCKET_UNAVAILABLE, "Socket недоступен."));
    if (!activeSkyholdGm()) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМ."));
    if (pending.has(operation.operationId)) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.CONFLICT, "Операция уже ожидает ответа."));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, attempts: 0, timeout: null, authorities: new Set() };
      function stop(error) { pending.delete(operation.operationId); clearTimeout(entry.timeout); reject(error); }
      function emit() {
        const gm = activeSkyholdGm();
        if (!gm) return stop(failure(operation.operationId, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМ."));
        entry.attempts++;
        entry.authorities.add(gm.id);
        entry.timeout = setTimeout(() => {
          if (entry.attempts < 2) emit();
          else stop(failure(operation.operationId, COMMAND_ERROR.TIMEOUT, "ГМ не ответил на операцию корабля."));
        }, writeTimeoutMs);
        try {
          game.socket.emit(`module.${MODULE_ID}`, {
            type: "playerShipOperationRequest", requestId: operation.operationId,
            operationId: operation.operationId, expectedRevision: operation.expectedRevision,
            userId: game.user.id, targetGmId: gm.id, operation
          });
        } catch (error) { stop(error); }
      }
      pending.set(operation.operationId, entry);
      emit();
    });
  }
  async function handleShipPayload(payload, senderId) {
    if (payload.type === "playerShipOperationResponse") {
      if (payload.userId !== game.user?.id) return true;
      const entry = pending.get(payload.requestId);
      if (!acceptsGmSocketResponse(payload, senderId, entry)) return true;
      clearTimeout(entry.timeout);
      pending.delete(payload.requestId);
      const command = commandResultFromPayload(payload, { operationId: payload.requestId });
      if (command.ok) entry.resolve(payload.result);
      else entry.reject(commandError(command));
      return true;
    }
    if (payload.type !== "playerShipOperationRequest") return false;
    if (!acceptsPlayerSocketRequest(payload, senderId)) return true;
    let command;
    let result;
    try {
      if (payload.requestId !== payload.operationId || payload.operation?.operationId !== payload.operationId || payload.expectedRevision !== payload.operation?.expectedRevision) {
        throw Object.assign(new Error("Метаданные операции корабля не совпадают."), { code: COMMAND_ERROR.INVALID });
      }
      result = await executeShipOperation(payload.operation, { userId: senderId, remote: true });
      command = commandSuccess({ operationId: payload.operationId, revision: getData()?.meta?.revision });
    } catch (error) {
      command = commandFailure({ operationId: payload.operationId, code: error.code ?? COMMAND_ERROR.EXECUTION_FAILED, message: error.message, revision: getData()?.meta?.revision });
    }
    game.socket?.emit?.(`module.${MODULE_ID}`, {
      type: "playerShipOperationResponse", requestId: payload.requestId, operationId: payload.operationId,
      userId: payload.userId, gmId: game.user.id, ok: command.ok, command, result
    });
    return true;
  }
  return { requestShipOperation, handleShipPayload };
}
