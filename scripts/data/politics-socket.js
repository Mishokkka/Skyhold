import { activeSkyholdGm } from "./authority.js";
import { acceptsGmSocketResponse, acceptsPlayerSocketRequest } from "./socket-auth.js";
import { MODULE_ID } from "./constants.js";
import { makeId } from "./utils.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";

export function createPoliticsSocketApi({ executePoliticsOperation, getData, writeTimeoutMs = 8000 }) {
  const pending = new Map();
  const failure = (operationId, code, message) => commandError(commandFailure({ operationId, code, message, retryable: true }));
  function requestPoliticsOperation(raw = {}) {
    const operation = { ...raw, operationId: raw.operationId || makeId("politics", 20) };
    if (game.user?.isGM) return executePoliticsOperation(operation, { userId: game.user.id });
    if (!game.socket) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.SOCKET_UNAVAILABLE, "Socket недоступен."));
    if (!activeSkyholdGm()) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМа."));
    if (pending.has(operation.operationId)) return Promise.reject(failure(operation.operationId, COMMAND_ERROR.CONFLICT, "Действие уже ожидает ответа."));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, attempts: 0, timeout: null, authorities: new Set() };
      const stop = (error) => { pending.delete(operation.operationId); clearTimeout(entry.timeout); reject(error); };
      function emit() {
        const gm = activeSkyholdGm();
        if (!gm) return stop(failure(operation.operationId, COMMAND_ERROR.AUTHORITY_OFFLINE, "Нет активного ГМа."));
        entry.attempts++;
        entry.authorities.add(gm.id);
        entry.timeout = setTimeout(() => entry.attempts < 2 ? emit() : stop(failure(operation.operationId, COMMAND_ERROR.TIMEOUT, "ГМ не ответил на политическое действие.")), writeTimeoutMs);
        try {
          game.socket.emit(`module.${MODULE_ID}`, { type: "playerPoliticsOperationRequest", requestId: operation.operationId,
            operationId: operation.operationId, expectedRevision: operation.expectedRevision, userId: game.user.id, targetGmId: gm.id, operation });
        } catch (error) { stop(error); }
      }
      pending.set(operation.operationId, entry);
      emit();
    });
  }
  async function handlePoliticsPayload(payload, senderId) {
    if (payload.type === "playerPoliticsOperationResponse") {
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
    if (payload.type !== "playerPoliticsOperationRequest") return false;
    if (!acceptsPlayerSocketRequest(payload, senderId)) return true;
    let command;
    let result;
    try {
      if (payload.requestId !== payload.operationId || payload.operation?.operationId !== payload.operationId || payload.expectedRevision !== payload.operation?.expectedRevision) {
        throw Object.assign(new Error("Метаданные политического действия не совпадают."), { code: COMMAND_ERROR.INVALID });
      }
      result = await executePoliticsOperation(payload.operation, { userId: senderId, remote: true });
      command = result?.ok ? commandSuccess({ operationId: payload.operationId, revision: getData()?.meta?.revision })
        : commandFailure({ operationId: payload.operationId, code: result?.conflict ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.FORBIDDEN,
          message: result?.reason || "Политическое действие отклонено.", revision: getData()?.meta?.revision });
    } catch (error) {
      command = commandFailure({ operationId: payload.operationId, code: error.code ?? COMMAND_ERROR.EXECUTION_FAILED, message: error.message, revision: getData()?.meta?.revision });
    }
    game.socket?.emit?.(`module.${MODULE_ID}`, { type: "playerPoliticsOperationResponse", requestId: payload.requestId, operationId: payload.operationId,
      userId: payload.userId, gmId: game.user.id, ok: command.ok, command, result });
    return true;
  }
  return { requestPoliticsOperation, handlePoliticsPayload };
}
