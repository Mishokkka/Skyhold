import { MODULE_ID } from "./constants.js";
import { activeSkyholdGm } from "./authority.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";
import { prepareSkyholdCommit } from "./commit-preparation.js";
import { applyPlayerPatch, buildPlayerPatch, validatePlayerPatch } from "./player-write-guard.js";
import { makeId, toNumber } from "./utils.js";
import { createShipSocketApi } from "./ship-socket.js";
import { createPoliticsSocketApi } from "./politics-socket.js";
import { acceptsGmSocketResponse, acceptsPlayerSocketRequest } from "./socket-auth.js";
import { appendHoldingOperation, findHoldingOperation } from "./operations.js";

const PENDING_PLAYER_WRITES = new Map();
const PENDING_STORAGE_OPERATIONS = new Map();
const PENDING_MARKET_OPERATIONS = new Map();
const PENDING_CONSTRUCTION_OPERATIONS = new Map();
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

/**
 * Build player command transport and authenticated GM handlers around the injected store.
 * Player mutations travel as patches or operations; the GM validates and persists them.
 * @param {object} [options={}] Store callbacks, operation executors and response timeout.
 * @returns {object} Request methods and a socket payload handler.
 */
export function createSkyholdSocketApi({
  getData,
  enqueueWrite,
  persistData,
  notifyChanged,
  executeStorageOperation,
  executeMarketOperation,
  executeConstructionOperation,
  executeShipOperation,
  executePoliticsOperation,
  writeTimeoutMs = GM_WRITE_TIMEOUT_MS
} = {}) {
  const completedPlayerOperations = new Map();
  const ships = createShipSocketApi({ executeShipOperation, getData, writeTimeoutMs });
  const politics = createPoliticsSocketApi({ executePoliticsOperation, getData, writeTimeoutMs });

  /**
   * Emit one pending request, rejecting its caller and releasing its ID on transport failure.
   * @returns {boolean} Whether emit completed without a synchronous error, not a GM acknowledgement.
   */
  function emitRequest(pendingRequests, requestId, payload) {
    try {
      game.socket.emit(`module.${MODULE_ID}`, payload);
      return true;
    } catch (error) {
      const pending = pendingRequests.get(requestId);
      pendingRequests.delete(requestId);
      clearTimeout(pending?.timeout);
      pending?.reject(commandError(commandFailure({ operationId: requestId,
        code: COMMAND_ERROR.SOCKET_UNAVAILABLE, message: error?.message, retryable: true })));
      return false;
    }
  }

  function rememberPlayerOperation(key, result) {
    if (!key || !result?.ok) return;
    completedPlayerOperations.delete(key);
    completedPlayerOperations.set(key, result);
    while (completedPlayerOperations.size > COMPLETED_PLAYER_OPERATION_LIMIT) {
      completedPlayerOperations.delete(completedPlayerOperations.keys().next().value);
    }
  }

  /**
   * Diff a proposed player root and ask the authority GM to validate the resulting patch.
   * A no-op resolves locally; retries retain the operation ID and never write player settings.
   * @param {object} data Proposed root based on the player's current snapshot.
   * @returns {Promise<object>} Current or acknowledged data; rejects on transport or GM failure.
   */
  function requestGmDataPatch(data) {
    const current = getData();
    const patch = buildPlayerPatch(current, data);
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
      const pending = { resolve, reject, timeout: null, attempts: 0, authorities: new Set(), proposed: data };
      /** Send the same patch ID to the current authority and arm its bounded retry timeout. */
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
        pending.authorities.add(authorityGm.id);
        if (!emitRequest(PENDING_PLAYER_WRITES, requestId, {
          type: "playerDataPatchRequest",
          requestId,
          operationId,
          expectedRevision: patch.baseRevision,
          userId: game.user?.id ?? null,
          targetGmId: authorityGm.id,
          patch
        })) return;
        /** Retry once after a missed acknowledgement, then reject and release the pending ID. */
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

  /**
   * Execute a GM storage command locally or send a player command to the authority GM.
   * Duplicate pending IDs reject without replacing the first caller; retries reuse that ID.
   * @param {object} [rawOperation={}] Storage command, optionally carrying an operationId.
   * @returns {Promise<object>} Executor result or matching GM acknowledgement.
   */
  function requestStorageOperation(rawOperation = {}) {
    const operation = {
      ...rawOperation,
      operationId: String(rawOperation?.operationId ?? "").trim() || makeId("storage-op", 20)
    };
    if (game.user?.isGM) {
      if (typeof executeStorageOperation !== "function") {
        return Promise.reject(new Error("FBL Skyhold | Storage operation executor is not configured."));
      }
      return executeStorageOperation(operation, { userId: game.user?.id ?? null });
    }
    if (!game.socket) {
      ui.notifications?.warn?.("Не удалось отправить операцию: socket Foundry недоступен.");
      return Promise.reject(new Error("FBL Skyhold | Socket is not available for storage operation."));
    }
    if (!activeSkyholdGm()) {
      ui.notifications?.warn?.("Операции с хранилищем выполняет активный ГМ. Сейчас в мире нет активного ГМа.");
      return Promise.reject(new Error("FBL Skyhold | No active GM is available for storage operation."));
    }

    const requestId = operation.operationId;
    if (PENDING_STORAGE_OPERATIONS.has(requestId)) return Promise.reject(commandError(commandFailure({
      operationId: requestId, code: COMMAND_ERROR.CONFLICT, message: "Операция уже ожидает ответа."
    })));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, attempts: 0, authorities: new Set() };
      /** Send this storage command to the current GM, retaining its ID across one retry. */
      const emitAttempt = () => {
        const targetGm = activeSkyholdGm();
        if (!targetGm) {
          PENDING_STORAGE_OPERATIONS.delete(requestId);
          reject(new Error("FBL Skyhold | No active GM is available for storage operation retry."));
          return;
        }
        pending.attempts += 1;
        pending.authorities.add(targetGm.id);
        if (!emitRequest(PENDING_STORAGE_OPERATIONS, requestId, {
          type: "playerStorageOperationRequest",
          requestId,
          userId: game.user?.id ?? null,
          targetGmId: targetGm.id,
          operation
        })) return;
        /** Retry a missed storage acknowledgement once, then reject and release the caller. */
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

  /**
   * Submit a market command with its revision/source token, using the local executor for a GM.
   * A player keeps one pending caller per operation ID and receives protocol errors on failure.
   * @param {object} [rawOperation={}] Market command and its concurrency metadata.
   * @returns {Promise<object>} Executor result or matching authority acknowledgement.
   */
  function requestMarketOperation(rawOperation = {}) {
    const operation = {
      ...rawOperation,
      operationId: String(rawOperation?.operationId ?? "").trim() || makeId("market-op", 20)
    };
    if (game.user?.isGM) {
      if (typeof executeMarketOperation !== "function") {
        return Promise.reject(commandError(commandFailure({
          operationId: operation.operationId,
          code: COMMAND_ERROR.EXECUTION_FAILED,
          message: "FBL Skyhold | Market operation executor is not configured."
        })));
      }
      return executeMarketOperation(operation, { userId: game.user?.id ?? null });
    }
    if (!game.socket) {
      ui.notifications?.warn?.("Не удалось отправить рыночную операцию: socket Foundry недоступен.");
      return Promise.reject(commandError(commandFailure({
        operationId: operation.operationId,
        code: COMMAND_ERROR.SOCKET_UNAVAILABLE,
        message: "FBL Skyhold | Socket is not available for market operation.",
        retryable: true
      })));
    }
    if (!activeSkyholdGm()) {
      ui.notifications?.warn?.("Рыночные операции подтверждает активный ГМ. Сейчас в мире нет активного ГМа.");
      return Promise.reject(commandError(commandFailure({
        operationId: operation.operationId,
        code: COMMAND_ERROR.AUTHORITY_OFFLINE,
        message: "FBL Skyhold | No active GM is available for market operation.",
        retryable: true
      })));
    }

    const requestId = operation.operationId;
    if (PENDING_MARKET_OPERATIONS.has(requestId)) return Promise.reject(commandError(commandFailure({
      operationId: requestId, code: COMMAND_ERROR.CONFLICT, message: "Операция уже ожидает ответа."
    })));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, attempts: 0, authorities: new Set() };
      /** Resend unchanged market metadata to the selected authority and arm its timeout. */
      const emitAttempt = () => {
        const targetGm = activeSkyholdGm();
        if (!targetGm) {
          PENDING_MARKET_OPERATIONS.delete(requestId);
          reject(commandError(commandFailure({
            operationId: operation.operationId,
            code: COMMAND_ERROR.AUTHORITY_OFFLINE,
            message: "FBL Skyhold | No active GM is available for market operation retry.",
            retryable: true
          })));
          return;
        }
        pending.attempts += 1;
        pending.authorities.add(targetGm.id);
        if (!emitRequest(PENDING_MARKET_OPERATIONS, requestId, {
          type: "playerMarketOperationRequest",
          requestId,
          operationId: operation.operationId,
          expectedRevision: operation.expectedRevision,
          sourceToken: operation.sourceToken,
          userId: game.user?.id ?? null,
          targetGmId: targetGm.id,
          operation
        })) return;
        /** Allow one identical retry before rejecting a market command without an acknowledgement. */
        pending.timeout = setTimeout(() => {
          if (pending.attempts < 2) {
            emitAttempt();
            return;
          }
          PENDING_MARKET_OPERATIONS.delete(requestId);
          reject(commandError(commandFailure({
            operationId: operation.operationId,
            code: COMMAND_ERROR.TIMEOUT,
            message: "FBL Skyhold | GM market operation timed out.",
            retryable: true
          })));
        }, writeTimeoutMs);
      };

      PENDING_MARKET_OPERATIONS.set(requestId, pending);
      emitAttempt();
    });
  }

  /**
   * Route construction rolls through the GM executor without replacing an existing pending ID.
   * Player retries preserve the operation and expected revision so the executor can detect replay.
   * @param {object} [rawOperation={}] Construction command and its expected revision.
   * @returns {Promise<object>} Executor result or matching GM acknowledgement.
   */
  function requestConstructionOperation(rawOperation = {}) {
    const operation = {
      ...rawOperation,
      operationId: String(rawOperation?.operationId ?? "").trim() || makeId("construction-op", 20)
    };
    if (game.user?.isGM) {
      if (typeof executeConstructionOperation !== "function") {
        return Promise.reject(commandError(commandFailure({
          operationId: operation.operationId,
          code: COMMAND_ERROR.EXECUTION_FAILED,
          message: "FBL Skyhold | Construction operation executor is not configured."
        })));
      }
      return executeConstructionOperation(operation, { userId: game.user?.id ?? null });
    }
    if (!game.socket) {
      ui.notifications?.warn?.("Не удалось отправить строительную операцию: socket Foundry недоступен.");
      return Promise.reject(commandError(commandFailure({
        operationId: operation.operationId,
        code: COMMAND_ERROR.SOCKET_UNAVAILABLE,
        message: "FBL Skyhold | Socket is not available for construction operation.",
        retryable: true
      })));
    }
    if (!activeSkyholdGm()) {
      ui.notifications?.warn?.("Строительные броски подтверждает активный ГМ. Сейчас в мире нет активного ГМа.");
      return Promise.reject(commandError(commandFailure({
        operationId: operation.operationId,
        code: COMMAND_ERROR.AUTHORITY_OFFLINE,
        message: "FBL Skyhold | No active GM is available for construction operation.",
        retryable: true
      })));
    }

    const requestId = operation.operationId;
    if (PENDING_CONSTRUCTION_OPERATIONS.has(requestId)) return Promise.reject(commandError(commandFailure({
      operationId: requestId, code: COMMAND_ERROR.CONFLICT, message: "Операция уже ожидает ответа."
    })));
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timeout: null, attempts: 0, authorities: new Set() };
      /** Send this construction ID to the current authority and allow one timed retry. */
      const emitAttempt = () => {
        const targetGm = activeSkyholdGm();
        if (!targetGm) {
          PENDING_CONSTRUCTION_OPERATIONS.delete(requestId);
          reject(commandError(commandFailure({
            operationId: operation.operationId,
            code: COMMAND_ERROR.AUTHORITY_OFFLINE,
            message: "FBL Skyhold | No active GM is available for construction operation retry.",
            retryable: true
          })));
          return;
        }
        pending.attempts += 1;
        pending.authorities.add(targetGm.id);
        if (!emitRequest(PENDING_CONSTRUCTION_OPERATIONS, requestId, {
          type: "playerConstructionOperationRequest",
          requestId,
          operationId: operation.operationId,
          expectedRevision: operation.expectedRevision,
          userId: game.user?.id ?? null,
          targetGmId: targetGm.id,
          operation
        })) return;
        /** Retry once with the original revision, then reject and remove the pending command. */
        pending.timeout = setTimeout(() => {
          if (pending.attempts < 2) {
            emitAttempt();
            return;
          }
          PENDING_CONSTRUCTION_OPERATIONS.delete(requestId);
          reject(commandError(commandFailure({
            operationId: operation.operationId,
            code: COMMAND_ERROR.TIMEOUT,
            message: "FBL Skyhold | GM construction operation timed out.",
            retryable: true
          })));
        }, writeTimeoutMs);
      };

      PENDING_CONSTRUCTION_OPERATIONS.set(requestId, pending);
      emitAttempt();
    });
  }

  async function handleSkyholdSocketPayload(payload, senderId) {
    if (!payload || typeof payload !== "object") return false;
    if (await ships.handleShipPayload(payload, senderId)) return true;
    if (await politics.handlePoliticsPayload(payload, senderId)) return true;
    if (["playerStorageOperationRequest", "playerMarketOperationRequest", "playerConstructionOperationRequest", "playerDataPatchRequest"].includes(payload.type)
      && !acceptsPlayerSocketRequest(payload, senderId)) return true;

    if (payload.type === "playerMarketOperationResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const pending = PENDING_MARKET_OPERATIONS.get(payload.requestId);
      if (!acceptsGmSocketResponse(payload, senderId, pending)) return true;
      clearTimeout(pending.timeout);
      PENDING_MARKET_OPERATIONS.delete(payload.requestId);
      const command = commandResultFromPayload(payload, {
        operationId: payload.requestId,
        message: "FBL Skyhold | GM market operation failed."
      });
      if (command.ok) pending.resolve(payload.result ?? { ok: true, operationId: command.operationId });
      else pending.reject(commandError(command, "FBL Skyhold | GM market operation failed."));
      return true;
    }

    if (payload.type === "playerStorageOperationResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const pending = PENDING_STORAGE_OPERATIONS.get(payload.requestId);
      if (!acceptsGmSocketResponse(payload, senderId, pending)) return true;
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

    if (payload.type === "playerConstructionOperationResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const requestId = payload.requestId ?? payload.operationId;
      const pending = PENDING_CONSTRUCTION_OPERATIONS.get(requestId);
      if (!acceptsGmSocketResponse(payload, senderId, pending)) return true;
      clearTimeout(pending.timeout);
      PENDING_CONSTRUCTION_OPERATIONS.delete(requestId);
      const command = commandResultFromPayload(payload);
      if (command.ok) pending.resolve(payload.result ?? command);
      else pending.reject(commandError(command));
      return true;
    }

    if (payload.type === "playerDataPatchResponse") {
      if (payload.userId && payload.userId !== game.user?.id) return true;
      const pending = PENDING_PLAYER_WRITES.get(payload.requestId);
      if (!acceptsGmSocketResponse(payload, senderId, pending)) return true;
      clearTimeout(pending.timeout);
      PENDING_PLAYER_WRITES.delete(payload.requestId);
      const command = commandResultFromPayload(payload, {
        operationId: payload.requestId,
        message: "FBL Skyhold | GM write request failed."
      });
      if (command.ok) {
        const current = getData();
        if (current?.meta?.revision >= command.revision) pending.resolve(current);
        else {
          const saved = pending.proposed ?? current;
          if (payload.holding?.id) saved.holdings = saved.holdings.map((row) => row.id === payload.holding.id ? payload.holding : row);
          saved.meta = { ...saved.meta, ...(payload.meta ?? {}), revision: command.revision };
          pending.resolve(saved);
        }
      }
      else pending.reject(commandError(command, "FBL Skyhold | GM write request failed."));
      return true;
    }

    if (payload.type === "playerStorageOperationRequest") {
      if (!game.user?.isGM) return true;
      if (payload.targetGmId && payload.targetGmId !== game.user?.id) return true;
      try {
        if (!payload.requestId || payload.requestId !== payload.operation?.operationId) {
          throw commandError(commandFailure({ operationId: payload.requestId, code: COMMAND_ERROR.INVALID,
            message: "Storage operation transport metadata does not match its payload." }));
        }
        if (typeof executeStorageOperation !== "function") {
          throw new Error("FBL Skyhold | Storage operation executor is not configured.");
        }
        const result = await executeStorageOperation(payload.operation, { userId: senderId, remote: true });
        const command = commandSuccess({ operationId: payload.requestId });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerStorageOperationResponse",
          requestId: payload.requestId,
          operationId: payload.requestId,
          userId: senderId,
          gmId: game.user.id,
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
          userId: senderId,
          gmId: game.user.id,
          ok: false,
          code: command.code,
          error: command.message,
          retryable: command.retryable,
          command
        });
      }
      return true;
    }

    if (payload.type === "playerMarketOperationRequest") {
      if (!game.user?.isGM) return true;
      if (payload.targetGmId && payload.targetGmId !== game.user?.id) return true;
      const operationId = String(payload.operationId ?? payload.requestId ?? "").trim();
      try {
        if (typeof executeMarketOperation !== "function") {
          const error = new Error("FBL Skyhold | Market operation executor is not configured.");
          error.code = COMMAND_ERROR.EXECUTION_FAILED;
          throw error;
        }
        if (String(payload?.operation?.operationId ?? "") !== operationId
          || Number(payload?.operation?.expectedRevision) !== Number(payload?.expectedRevision)
          || String(payload?.operation?.sourceToken ?? "") !== String(payload?.sourceToken ?? "")) {
          const error = new Error("FBL Skyhold | Market operation transport metadata does not match its payload.");
          error.code = COMMAND_ERROR.INVALID;
          throw error;
        }
        const result = await executeMarketOperation(payload.operation, { userId: senderId, remote: true });
        const revision = Math.max(0, toNumber(getData()?.meta?.revision, 0));
        const command = commandSuccess({ operationId, revision });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerMarketOperationResponse",
          requestId: payload.requestId,
          operationId,
          userId: senderId,
          gmId: game.user.id,
          ok: true,
          revision,
          command,
          result
        });
      } catch (error) {
        console.error("FBL Skyhold | Failed to apply player market operation", error);
        const command = resultForError(error, {
          operationId,
          revision: error?.revision ?? Math.max(0, toNumber(getData()?.meta?.revision, 0))
        });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerMarketOperationResponse",
          requestId: payload.requestId,
          operationId,
          userId: senderId,
          gmId: game.user.id,
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

    if (payload.type === "playerConstructionOperationRequest") {
      if (!game.user?.isGM) return true;
      if (!payload.targetGmId || payload.targetGmId !== game.user?.id) return true;
      const operationId = String(payload.operationId ?? payload.requestId ?? "").trim();
      try {
        if (typeof executeConstructionOperation !== "function") {
          throw commandError(commandFailure({
            operationId,
            code: COMMAND_ERROR.EXECUTION_FAILED,
            message: "FBL Skyhold | Construction operation executor is not configured."
          }));
        }
        if (String(payload?.operation?.operationId ?? "") !== operationId
          || Number(payload?.operation?.expectedRevision) !== Number(payload?.expectedRevision)) {
          throw commandError(commandFailure({
            operationId,
            code: COMMAND_ERROR.INVALID,
            message: "FBL Skyhold | Construction operation transport metadata does not match its payload."
          }));
        }
        const result = await executeConstructionOperation(payload.operation, { userId: senderId, remote: true });
        const revision = Math.max(0, toNumber(getData()?.meta?.revision, 0));
        const command = commandSuccess({ operationId, revision });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerConstructionOperationResponse",
          requestId: payload.requestId,
          operationId,
          userId: senderId,
          gmId: game.user.id,
          ok: true,
          revision,
          command,
          result
        });
      } catch (error) {
        console.error("FBL Skyhold | Failed to apply player construction operation", error);
        const command = resultForError(error, {
          operationId,
          revision: error?.revision ?? Math.max(0, toNumber(getData()?.meta?.revision, 0))
        });
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerConstructionOperationResponse",
          requestId: payload.requestId,
          operationId,
          userId: senderId,
          gmId: game.user.id,
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

    if (payload.type === "playerDataPatchRequest") {
      if (!game.user?.isGM) return true;
      if (payload.targetGmId && payload.targetGmId !== game.user?.id) return true;

      const operationId = String(payload.operationId ?? payload.requestId ?? "").trim();
      const operationKey = `${String(payload.userId ?? "anonymous")}:${operationId}`;
      const signature = JSON.stringify([payload.expectedRevision, payload.patch]);
      try {
        if (payload.requestId !== operationId) throw commandError(commandFailure({ operationId,
          code: COMMAND_ERROR.INVALID, message: "ID запроса не совпадает с ID изменения." }));
        const command = await enqueueWrite(async () => {
          const completed = completedPlayerOperations.get(operationKey);
          if (completed) {
            if (completed.signature !== signature) throw commandError(commandFailure({ operationId,
              code: COMMAND_ERROR.CONFLICT, message: "Этот ID уже использован другим изменением." }));
            return completed.result;
          }

          const current = getData();
          const prior = current.holdings.map((holding) => findHoldingOperation(holding, operationId)).find(Boolean);
          if (prior) {
            if (prior.payload?.kind !== "player-patch" || prior.payload.signature !== signature || prior.payload.userId !== senderId) {
              throw commandError(commandFailure({ operationId, code: COMMAND_ERROR.CONFLICT,
                message: "Этот ID уже использован другим изменением." }));
            }
            return commandSuccess({ operationId, revision: current.meta.revision });
          }
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

          const validation = validatePlayerPatch(current, payload.patch, senderId);
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
          const holdingIndex = Number(validation.changes?.[0]?.match(/^holdings\.(\d+)/)?.[1]);
          const changedHolding = next.holdings[holdingIndex];
          if (changedHolding) appendHoldingOperation(changedHolding, { operationId, type: "system",
            title: "Изменение игрока", summary: validation.action,
            payload: { kind: "player-patch", signature, userId: senderId } });
          await persistData(next, { normalized: true, scope: prepared.scope });
          notifyChanged();
          const success = commandSuccess({ operationId, revision: next.meta.revision });
          rememberPlayerOperation(operationKey, { ok: true, signature, result: success });
          return success;
        });
        const saved = getData();
        const savedHolding = saved.holdings.find((holding) => findHoldingOperation(holding, operationId));
        game.socket?.emit?.(`module.${MODULE_ID}`, {
          type: "playerDataPatchResponse",
          requestId: payload.requestId,
          operationId,
          userId: senderId,
          gmId: game.user.id,
          ok: true,
          revision: command.revision,
          command,
          holding: savedHolding,
          meta: saved.meta
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
          userId: senderId,
          gmId: game.user.id,
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
    requestConstructionOperation,
    requestGmDataPatch,
    requestMarketOperation,
    requestShipOperation: ships.requestShipOperation,
    requestPoliticsOperation: politics.requestPoliticsOperation,
    requestStorageOperation
  };
}
