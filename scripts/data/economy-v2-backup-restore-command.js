import { COMMAND_ERROR, commandFailure, commandSuccess } from "./command-result.js";
import { applyEconomyV2BackupRestore, planEconomyV2BackupRestore } from "./economy-v2-backup.js";
import { getSkyholdAuthorityState } from "./authority.js";
import { SkyholdData } from "./store.js";
import { clone, toNumber } from "./utils.js";

function isCurrentUserGm(value) {
  return value === undefined ? Boolean(globalThis.game?.user?.isGM) : Boolean(value);
}

function isCurrentAuthority(value) {
  return value === undefined ? Boolean(getSkyholdAuthorityState().isAuthorityGm) : Boolean(value);
}

function restoreFailure({ operationId = "", code = COMMAND_ERROR.EXECUTION_FAILED, message, revision = null, ...extra } = {}) {
  return { ...commandFailure({ operationId, code, message, revision }), ...extra };
}

function validOperationId(value = "") {
  return /^[A-Za-z0-9_-]{1,128}$/.test(String(value ?? "").trim());
}

export function previewEconomyV2BackupRestoreCommand({ rawBackup = "", operationId = "" } = {}, {
  getData = () => SkyholdData.get(),
  isGM,
  isAuthority
} = {}) {
  if (!isCurrentUserGm(isGM) || !isCurrentAuthority(isAuthority)) {
    return restoreFailure({ operationId, code: COMMAND_ERROR.FORBIDDEN, message: "Восстановить backup может только authority GM." });
  }
  if (!validOperationId(operationId)) {
    return restoreFailure({ operationId, code: COMMAND_ERROR.INVALID, message: "Некорректный operationId восстановления backup." });
  }
  const plan = planEconomyV2BackupRestore({ currentData: getData(), rawBackup, operationId });
  if (!plan.ok) {
    return restoreFailure({
      operationId,
      code: plan.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID,
      message: plan.message,
      stale: Boolean(plan.stale)
    });
  }
  return { ...commandSuccess({ operationId, revision: plan.baseRevision }), plan };
}

export async function executeEconomyV2BackupRestoreCommand({ plan, rawBackup = "", confirmed = false } = {}, {
  isGM,
  isAuthority,
  transaction = (updater, options) => SkyholdData.transaction(updater, options)
} = {}) {
  const operationId = String(plan?.operationId ?? "").trim();
  if (!isCurrentUserGm(isGM) || !isCurrentAuthority(isAuthority)) {
    return restoreFailure({ operationId, code: COMMAND_ERROR.FORBIDDEN, message: "Восстановить backup может только authority GM." });
  }
  if (!validOperationId(operationId)) {
    return restoreFailure({ operationId, code: COMMAND_ERROR.INVALID, message: "Некорректный operationId восстановления backup." });
  }
  if (confirmed !== true) {
    return restoreFailure({ operationId, code: COMMAND_ERROR.INVALID, message: "Восстановление требует отдельного явного подтверждения GM." });
  }
  return transaction((draft, { skip } = {}) => {
    const currentRevision = Math.max(0, Math.floor(toNumber(draft?.meta?.revision, 0)));
    const applied = applyEconomyV2BackupRestore({ data: draft, plan, rawBackup });
    if (!applied.ok) {
      const result = restoreFailure({
        operationId,
        code: applied.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID,
        message: applied.message,
        revision: currentRevision,
        stale: Boolean(applied.stale),
        invalid: Boolean(applied.invalid)
      });
      return typeof skip === "function" ? skip(result) : result;
    }
    const result = {
      ...commandSuccess({ operationId, revision: applied.replay ? currentRevision : currentRevision + 1 }),
      replay: Boolean(applied.replay),
      changed: Boolean(applied.changed),
      summary: clone(plan.summary ?? {})
    };
    return applied.replay && typeof skip === "function" ? skip(result) : result;
  }, { reason: `economy-v2:restore-backup:${operationId}`, scope: "both" });
}
