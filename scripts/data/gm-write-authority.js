import { activeSkyholdGm } from "./authority.js";
import { socketSender } from "./socket-auth.js";
import { MODULE_ID } from "./constants.js";
import { COMMAND_ERROR, commandError, commandFailure, commandResultFromPayload, commandSuccess } from "./command-result.js";
import { normalizeCommitScope } from "./commit-preparation.js";
import { stableDataHash } from "./storage-commit.js";
import { makeId } from "./utils.js";
import { assertNoNewEntityCollisions } from "./entity-identity.js";

function failure(code, message, revision = null) {
  return commandError(commandFailure({ code, message, revision, retryable: code === COMMAND_ERROR.CONFLICT }));
}

/** All GM commits share the authority client's existing player/GM write queue. */
export function createGmWriteAuthority({ getData, enqueueWrite, persistData, notifyChanged,
  user = () => globalThis.game?.user,
  authority = () => activeSkyholdGm() ?? globalThis.game?.user,
  sender = socketSender,
  socket = () => globalThis.game?.socket,
  timeoutMs = 8000
}) {
  const pending = new Map();
  const completed = new Map();

  function assertAuthority() {
    if (!user()?.isGM || authority()?.id !== user()?.id) {
      throw failure(COMMAND_ERROR.AUTHORITY_OFFLINE, "ГМ, отвечающий за запись, изменился. Повторите действие после обновления окна.");
    }
  }

  async function commitLocal(request) {
    assertAuthority();
    const requester = request.userId === user()?.id ? user() : sender(request.userId);
    if (!requester?.isGM) throw failure(COMMAND_ERROR.FORBIDDEN, "Запись GM-коммита доступна только ГМу.");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.operationId ?? "")
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
      || request.data?.meta?.revision !== request.expectedRevision + 1
      || !Array.isArray(request.data?.holdings) || !request.data?.catalog) {
      throw failure(COMMAND_ERROR.INVALID, "Некорректный GM-коммит.");
    }
    const signature = stableDataHash([request.userId, request.expectedRevision, request.scope, request.forceRollbackSnapshot, request.data]);
    const prior = completed.get(request.operationId);
    if (prior) {
      if (prior.signature !== signature) throw failure(COMMAND_ERROR.CONFLICT, "ID коммита уже использован другим изменением.");
      return prior.receipt;
    }
    const current = getData();
    const revision = Math.max(0, Number(current?.meta?.revision) || 0);
    if (revision !== request.expectedRevision) {
      throw failure(COMMAND_ERROR.CONFLICT, "Данные изменены другим ГМом. Обновите окно и повторите правку.", revision);
    }
    assertNoNewEntityCollisions(current, request.data);
    const result = await persistData(request.data, { normalized: true, scope: normalizeCommitScope(request.scope),
      forceRollbackSnapshot: Boolean(request.forceRollbackSnapshot), withStatus: true });
    if (result.changed) notifyChanged();
    const receipt = { meta: result.data.meta, changed: result.changed };
    completed.set(request.operationId, { signature, receipt });
    if (completed.size > 256) completed.delete(completed.keys().next().value);
    return receipt;
  }

  /**
   * Commit an already prepared GM draft locally or ask the current authority GM to commit it.
   * The caller already holds its write queue; remote retries retain one ID at the same authority.
   * @param {object} data Prepared root whose revision is one above baseRevision.
   * @param {object} [options={}] Commit scope, base revision and rollback-snapshot requirement.
   * @returns {Promise<object>} Draft with acknowledged metadata; rejects on conflict or transport failure.
   */
  function requestCommit(data, { scope, baseRevision, forceRollbackSnapshot = false } = {}) {
    if (!user()?.isGM) return Promise.reject(failure(COMMAND_ERROR.FORBIDDEN, "GM-коммит недоступен игроку."));
    const request = { operationId: makeId("gm-commit", 20), userId: user().id, data,
      scope: normalizeCommitScope(scope), expectedRevision: baseRevision, forceRollbackSnapshot };
    // Called from a transaction already holding this client's queue: never enqueue twice.
    if (authority()?.id === user().id) return commitLocal(request).then((receipt) => ({ ...data, meta: receipt.meta }));
    if (!socket()?.emit || !authority()?.isGM) {
      return Promise.reject(failure(COMMAND_ERROR.SOCKET_UNAVAILABLE, "Нет связи с ГМом, отвечающим за запись."));
    }
    return new Promise((resolve, reject) => {
      const state = { resolve, reject, request, attempts: 0, authorities: new Set(), timeout: null };
      /** Send the existing commit ID, releasing pending state if authority or transport is lost. */
      const send = () => {
        const target = authority();
        if (!target?.isGM) {
          pending.delete(request.operationId);
          reject(failure(COMMAND_ERROR.AUTHORITY_OFFLINE, "ГМ, отвечающий за запись, недоступен."));
          return;
        }
        state.authorities.add(target.id);
        state.attempts += 1;
        try {
          socket().emit(`module.${MODULE_ID}`, { ...request, type: "gmCommitRequest",
            requestId: request.operationId, targetGmId: target.id });
        } catch (error) {
          pending.delete(request.operationId);
          clearTimeout(state.timeout);
          reject(failure(COMMAND_ERROR.SOCKET_UNAVAILABLE, error?.message || "Нет связи с ГМом, отвечающим за запись."));
          return;
        }
        /** Retry once only at the same authority; a lost reply may already represent a completed write. */
        state.timeout = setTimeout(() => {
          // A timeout may mean a completed write. Retry the same ID only at the same authority.
          if (state.attempts < 2 && authority()?.id === target.id) return send();
          pending.delete(request.operationId);
          reject(failure(COMMAND_ERROR.TIMEOUT, "Нет подтверждения GM-коммита. Обновите данные перед повторным действием."));
        }, timeoutMs);
      };
      pending.set(request.operationId, state);
      send();
    });
  }

  async function handle(payload, senderId) {
    if (payload?.type === "gmCommitResponse") {
      const state = pending.get(payload.requestId);
      if (!state || !sender(senderId)?.isGM || payload.gmId !== senderId || payload.userId !== user()?.id
        || !state.authorities.has(senderId) || payload.operationId !== payload.requestId) return true;
      clearTimeout(state.timeout);
      pending.delete(payload.requestId);
      const result = commandResultFromPayload(payload);
      if (result.operationId !== payload.operationId || (result.ok && !Number.isSafeInteger(payload.meta?.revision))) {
        state.reject(failure(COMMAND_ERROR.INVALID, "Некорректное подтверждение GM-коммита."));
        return true;
      }
      if (result.ok) state.resolve({ ...state.request.data, meta: payload.meta });
      else state.reject(commandError(result));
      return true;
    }
    if (payload?.type !== "gmCommitRequest") return false;
    if (!sender(senderId)?.isGM || senderId !== payload.userId || !user()?.isGM
      || payload.targetGmId !== user().id || authority()?.id !== user().id) return true;
    let receipt;
    let command;
    try {
      if (payload.requestId !== payload.operationId) throw failure(COMMAND_ERROR.INVALID, "ID запроса не совпадает с коммитом.");
      receipt = await enqueueWrite(() => commitLocal(payload));
      command = commandSuccess({ operationId: payload.operationId, revision: receipt.meta.revision });
    } catch (error) {
      command = commandFailure({ operationId: payload.operationId, code: error.code,
        message: error.message, revision: error.revision, retryable: Boolean(error.retryable) });
    }
    socket()?.emit?.(`module.${MODULE_ID}`, { type: "gmCommitResponse", requestId: payload.requestId,
      operationId: payload.operationId, userId: senderId, gmId: user().id,
      ok: command.ok, command, meta: receipt?.meta });
    return true;
  }

  return { requestCommit, handle, assertAuthority };
}
