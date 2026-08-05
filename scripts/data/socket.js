import { MODULE_ID } from "./constants.js";
import { activeSkyholdGm } from "./authority.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";
import { prepareSkyholdCommit } from "./commit-preparation.js";
import { applyPlayerPatch, buildPlayerPatch, validatePlayerPatch } from "./player-write-guard.js";
import { makeId, toNumber } from "./utils.js";

const PENDING_PLAYER_WRITES = new Map();
const PENDING_STORAGE_OPERATIONS = new Map();
const GM_WRITE_TIMEOUT_MS = 8_000;
const COMPLETED_PLAYER_OPERATION_LIMIT = 256;

function resultForError(error, { operationId = "", revision = null } = {}) {
  return commandFailure({
    operationId,
    code: error?.code ?? COMMAND_ERROR.EXECUTION_FAILED,
    message: error?.message ?? String(error),
    retryable: Boolean(error?.retryable),
    revision
  });
}

export function createSkyholdSocketApi({
  getData,
  enqueueWrite,
  persistData,
  notifyChanged,
  executeStorageOperation,
  writeTimeoutMs = GM_WRITE_TIMEOUT_MS
} = {}) {
  const completedPlayerOperations = new Map();

  function rememberPlayerOperation(key, result) {
    if (!key || !result?.ok) return;
    completedPlayerOperations.delete(key);
    completedPlayerOperations.set(key, result);
    while (completedPlayerOperations.size > COMPLETED_PLAYER_OPERATION_LIMIT) {
      completedPlayerOperations.delete(completedPlayerOperations.keys().next().value);
    }
  }

  function requestGmDataPatch(data, { action = "" } = {}) {
    const current = getData();
    const patch = buildPlayerPatch(current, data, { action });
    if (!patch.changes.length) return Promise.resolve(current);
    if (!game.socket) {
      ui.notifications?.warn?.("Не удалось отправить изменение: socket Foundry недоступен.");
      return Promise.reject(commandError(commandFailure({
        code: COMMAND_ERROR.SOCKET_UNAVAILABLE,
        message: "FBL Skyhold | Socket is not available for player write request.",
        retryable: true
      })));
    }

    const targetGm = activeSkyholdGm();
    if (!targetGm) {
      ui.notifications?.warn?.("Изменения игроков сохраняет активный ГМ. Сейчас в мире нет активного ГМа.");
      return Promise.reject(commandError(commandFailure({
        code: COMMAND_ERROR.AUTHORITY_OFFLINE,
        message: "FBL Skyhold | No active GM is available for player write request.",
        retryable: true
      })));
    }

    const operationId = makeId("data-op", 20);
    const requestId = operationId;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, attempts: 0, proposed: data };
      const emitAttempt = () => {
        const authorityGm = activeSkyholdGm();
        if (!authorityGm) {
          PENDING_PLAYER_WRITES.delete(requestId);
          reject(commandError(commandFailure({
            operationId,
            code: COMMAND_ERROR.AUTHORITY_OFFLINE,
            message: "FBL Skyhold | No active GM is available for player write request retry.",
            retryable: true
          })));
          return;
        }
        pending.attempts += 1;
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "playerDataPatchRequest",
          requestId,
          operationId,
          expectedRevision: patch.baseRevision,
          userId: game.user?.id ?? null,
          targetGmId: authorityGm.id,
          patch
        });
        pending.timeout = setTimeout(() => {
          if (pending.attempts < 2) {
            emitAttempt();
            return;
          }
          PENDING_PLAYER_WRITES.delete(requestId);
          reject(commandError(commandFailure({
            operationId,
            code: COMMAND_ERROR.TIMEOUT,
            message: "FBL Skyhold | GM write request timed out.",
            retryable: true
          })));
        }, writeTimeoutMs);
      };

      PENDING_PLAYER_WRITES.set(requestId, pending);
      emitAttempt();
    });
  }

  function requestStorageOperation(rawOperation = {}) {
    const operation = {
      ...rawOperation,
      operationId: String(rawOperation?.operationId ?? "").trim() || makeId("storage-op", 20)
    };
    const operationLabel = String(operation.type ?? "").startsWith("market") ? "рыночную операцию" : "операцию с хранилищем";
    if (game.user?.isGM) {
      const authorityGm = activeSkyholdGm();
      if (authorityGm && String(authorityGm.id ?? "") !== String(game.user?.id ?? "")) {
        const error = new Error(`FBL Skyhold | Storage mutation rejected: authority GM is ${String(authorityGm.name ?? authorityGm.id ?? "another GM")}.`);
        error.code = COMMAND_ERROR.AUTHORITY_OFFLINE;
        error.retryable = true;
        ui.notifications?.warn?.(`Не удалось выполнить ${operationLabel}: другой активный GM является единственным writer этого мира.`);
        return Promise.reject(error);
      }
      if (typeof executeStorageOperation !== "function") {
        return Promise.reject(new Error("FBL Skyhold | Storage operation executor is not configured."));
      }
      return executeStorageOperation(operation, { userId: game.user?.id ?? null });
    }
    if (!game.socket) {
      ui.notifications?.warn?.(`Не удалось отправить ${operationLabel}: socket Foundry недоступен.`);
      return Promise.reject(new Error("FBL Skyhold | Socket is not available for storage operation."));
    }
    if (!activeSkyholdGm()) {
      ui.notifications?.warn?.(`Требуется активный authority-GM, чтобы выполнить ${operationLabel}. Сейчас активного ГМа нет.`);
      return Promise.reject(new Error("FBL Skyhold | No active GM is available for storage operation."));
    }

    const requestId = operation.operationId;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, attempts: 0 };
      const emitAttempt = () => {
        const targetGm = activeSkyholdGm();
        if (!targetGm) {
          PENDING_STORAGE_OPERATIONS.delete(requestId);
          reject(new Error("FBL Skyhold | No active GM is available for storage operation retry."));
          return;
        }
        pending.attempts += 1;
        game.socket.emit(`module.${MODULE_ID}`, {
          type: "playerStorageOperationRequest",
          requestId,
          userId: game.user?.id ?? null,
          targetGmId: targetGm.id,
          operation
        });
        pending.timeout = setTimeout(() => {
          if (pending.attempts < 2) {
            emitAttempt();
            return;
          }
          PENDING_STORAGE_OPERATIONS.delete(requestId);
          reject(new Error("FBL Skyhold | GM storage operation timed out."));
        }, writeTimeoutMs);
      };

      PENDING_STORAGE_OPERATIONS.set(requestId, pending);
      emitAttempt();
    });
  }

  async function handleSkyholdSocketPayload(payload) {
    if (!payload || typeof payload !== "object") return false;

    if (payload.type === "playerStorageOperationResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const pending = PENDING_STORAGE_OPERATIONS.get(payload.requestId);
      if (!pending) return true;
      clearTimeout(pending.timeout);
      PENDING_STORAGE_OPERATIONS.delete(payload.requestId);
      const command = commandResultFromPayload(payload, {
        operationId: payload.requestId,
        message: "FBL Skyhold | GM storage operation failed."
      });
      if (command.ok) pending.resolve(payload.result ?? { ok: true, operationId: command.operationId });
      else pending.reject(commandError(command, "FBL Skyhold | GM storage operation failed."));
      return true;
    }

    if (payload.type === "playerDataPatchResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const pending = PENDING_PLAYER_WRITES.get(payload.requestId);
      if (!pending) return true;
      clearTimeout(pending.timeout);
      PENDING_PLAYER_WRITES.delete(payload.requestId);
      const command = commandResultFromPayload(payload, {
        operationId: payload.requestId,
        message: "FBL Skyhold | GM write request failed."
      });
      if (command.ok) pending.resolve(pending.proposed ?? getData());
      else pending.reject(commandError(command, "FBL Skyhold | GM write request failed."));
      return true;
    }

    if (payload.type === "playerStorageOperationRequest") {
      if (!game.user?.isGM) return true;
      if (payload.targetGmId && payload.targetGmId !== game.user?.id) return true;
      try {
        if (typeof executeStorageOperation !== "function") {
          throw new Error("FBL Skyhold | Storage operation executor is not configured.");
        }
        const result = await executeStorageOperation(payload.operation, { userId: payload.userId, remote: true });
        const command = commandSuccess({ operationId: payload.requestId });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerStorageOperationResponse",
          requestId: payload.requestId,
          operationId: payload.requestId,
          userId: payload.userId ?? null,
          ok: true,
          command,
          result
        });
      } catch (error) {
        console.error("FBL Skyhold | Failed to apply player storage operation", error);
        const command = resultForError(error, { operationId: payload.requestId });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerStorageOperationResponse",
          requestId: payload.requestId,
          operationId: payload.requestId,
          userId: payload.userId ?? null,
          ok: false,
          code: command.code,
          error: command.message,
          retryable: command.retryable,
          command
        });
      }
      return true;
    }

    if (payload.type === "playerDataPatchRequest") {
      if (!game.user?.isGM) return true;
      if (payload.targetGmId && payload.targetGmId !== game.user?.id) return true;

      const operationId = String(payload.operationId ?? payload.requestId ?? "").trim();
      const operationKey = `${String(payload.userId ?? "anonymous")}:${operationId}`;
      try {
        const command = await enqueueWrite(async () => {
          const completed = completedPlayerOperations.get(operationKey);
          if (completed) return completed;

          const current = getData();
          const currentRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
          const patchRevision = Math.max(0, toNumber(payload?.patch?.baseRevision, 0));
          const expectedRevision = Math.max(0, toNumber(payload?.expectedRevision, patchRevision));
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
            const error = new Error("FBL Skyhold | Player patch operation id is missing or invalid.");
            error.code = COMMAND_ERROR.INVALID;
            throw error;
          }
          if (expectedRevision !== patchRevision) {
            const error = new Error("FBL Skyhold | Player patch expected revision does not match its base revision.");
            error.code = COMMAND_ERROR.INVALID;
            throw error;
          }

          const validation = validatePlayerPatch(current, payload.patch, payload.userId);
          if (!validation.ok) {
            const error = new Error(validation.error);
            error.code = currentRevision > patchRevision ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.FORBIDDEN;
            error.revision = currentRevision;
            throw error;
          }

          const prepared = prepareSkyholdCommit(applyPlayerPatch(current, payload.patch), {
            scope: "holdings",
            baseRevision: currentRevision
          });
          const next = prepared.data;
          await persistData(next, { normalized: true, scope: prepared.scope });
          notifyChanged();
          const success = commandSuccess({ operationId, revision: next.meta.revision });
          rememberPlayerOperation(operationKey, success);
          return success;
        });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerDataPatchResponse",
          requestId: payload.requestId,
          operationId,
          userId: payload.userId ?? null,
          ok: true,
          revision: command.revision,
          command
        });
      } catch (error) {
        console.error("FBL Skyhold | Failed to apply player patch request", error);
        const command = resultForError(error, {
          operationId,
          revision: error?.revision ?? Math.max(0, toNumber(getData()?.meta?.revision, 0))
        });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerDataPatchResponse",
          requestId: payload.requestId,
          operationId,
          userId: payload.userId ?? null,
          ok: false,
          code: command.code,
          error: command.message,
          retryable: command.retryable,
          revision: command.revision,
          command
        });
      }
      return true;
    }

    return false;
  }

  return {
    handleSkyholdSocketPayload,
    requestGmDataPatch,
    requestStorageOperation
  };
}
