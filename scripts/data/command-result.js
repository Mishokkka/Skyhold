export const COMMAND_ERROR = Object.freeze({
  AUTHORITY_OFFLINE: "authority-offline",
  SOCKET_UNAVAILABLE: "socket-unavailable",
  TIMEOUT: "timeout",
  CONFLICT: "conflict",
  FORBIDDEN: "forbidden",
  INVALID: "invalid",
  EXECUTION_FAILED: "execution-failed"
});

function operationId(value = "") {
  return String(value ?? "").trim();
}

function commandRevision(value) {
  if (value === null || value === undefined || value === "") return null;
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
}

export function commandSuccess({ operationId: id = "", revision = null } = {}) {
  const normalizedRevision = commandRevision(revision);
  return {
    ok: true,
    operationId: operationId(id),
    code: "ok",
    message: "",
    retryable: false,
    revision: normalizedRevision
  };
}

export function commandFailure({
  operationId: id = "",
  code = COMMAND_ERROR.EXECUTION_FAILED,
  message = "FBL Skyhold | Command failed.",
  retryable = false,
  revision = null
} = {}) {
  const normalizedRevision = commandRevision(revision);
  return {
    ok: false,
    operationId: operationId(id),
    code: String(code || COMMAND_ERROR.EXECUTION_FAILED),
    message: String(message || "FBL Skyhold | Command failed."),
    retryable: Boolean(retryable),
    revision: normalizedRevision
  };
}

export function commandResultFromPayload(payload = {}, fallback = {}) {
  if (payload?.command && typeof payload.command === "object") {
    return payload.command.ok
      ? commandSuccess(payload.command)
      : commandFailure(payload.command);
  }
  const id = payload?.operationId ?? payload?.requestId ?? fallback?.operationId ?? "";
  if (payload?.ok) {
    return commandSuccess({ operationId: id, revision: payload?.revision ?? fallback?.revision });
  }
  return commandFailure({
    operationId: id,
    code: payload?.code ?? fallback?.code,
    message: payload?.error ?? payload?.message ?? fallback?.message,
    retryable: payload?.retryable ?? fallback?.retryable,
    revision: payload?.revision ?? fallback?.revision
  });
}

export function commandError(result, fallbackMessage = "FBL Skyhold | Command failed.") {
  const normalized = result?.ok === false ? result : commandFailure({ message: fallbackMessage });
  const error = new Error(normalized.message || fallbackMessage);
  error.name = "SkyholdCommandError";
  error.code = normalized.code;
  error.operationId = normalized.operationId;
  error.retryable = normalized.retryable;
  error.revision = normalized.revision;
  return error;
}
