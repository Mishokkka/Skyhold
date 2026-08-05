import { COMMAND_ERROR, commandFailure, commandSuccess } from "./command-result.js";
import { applyEconomyV2Activation, planEconomyV2Activation } from "./economy-v2-activation.js";
import { validateEconomyV2Backup } from "./economy-v2-backup.js";
import { getSkyholdAuthorityState } from "./authority.js";
import { SkyholdData } from "./store.js";
import { clone, toNumber } from "./utils.js";

function isCurrentUserGm(value) {
  return value === undefined ? Boolean(globalThis.game?.user?.isGM) : Boolean(value);
}

function isCurrentAuthority(value) {
  return value === undefined ? Boolean(getSkyholdAuthorityState().isAuthorityGm) : Boolean(value);
}

function activationFailure({ operationId = "", code = COMMAND_ERROR.EXECUTION_FAILED, message, revision = null, ...extra } = {}) {
  return { ...commandFailure({ operationId, code, message, revision }), ...extra };
}

export function previewEconomyV2Activation({ resolutions = {}, operationId = "", now = null } = {}, {
  getData = () => SkyholdData.get(),
  isGM,
  isAuthority
} = {}) {
  if (!isCurrentUserGm(isGM) || !isCurrentAuthority(isAuthority)) {
    return activationFailure({ operationId, code: COMMAND_ERROR.FORBIDDEN, message: "Активировать Economy V2 может только authority GM." });
  }
  const plan = planEconomyV2Activation({ data: getData(), resolutions, operationId, now });
  return { ...commandSuccess({ operationId: plan.operationId, revision: plan.baseRevision }), plan };
}

export async function executeEconomyV2ActivationCommand({ plan, backup } = {}, {
  isGM,
  isAuthority,
  transaction = (updater, options) => SkyholdData.transaction(updater, options)
} = {}) {
  const operationId = String(plan?.operationId ?? "").trim();
  if (!isCurrentUserGm(isGM) || !isCurrentAuthority(isAuthority)) {
    return activationFailure({ operationId, code: COMMAND_ERROR.FORBIDDEN, message: "Активировать Economy V2 может только authority GM." });
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    return activationFailure({ operationId, code: COMMAND_ERROR.INVALID, message: "Некорректный operationId активации Economy V2." });
  }
  const backupValidation = validateEconomyV2Backup(backup, plan);
  if (!backupValidation.ok) {
    return activationFailure({
      operationId,
      code: backupValidation.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID,
      message: backupValidation.message,
      stale: Boolean(backupValidation.stale)
    });
  }

  return transaction((draft, { skip } = {}) => {
    const currentRevision = Math.max(0, Math.floor(toNumber(draft?.meta?.revision, 0)));
    const applied = applyEconomyV2Activation({ data: draft, plan });
    if (!applied.ok) {
      const result = activationFailure({
        operationId,
        code: applied.stale ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID,
        message: applied.message,
        revision: currentRevision,
        stale: Boolean(applied.stale),
        invalid: Boolean(applied.invalid),
        blockers: clone(applied.blockers ?? [])
      });
      return typeof skip === "function" ? skip(result) : result;
    }
    const result = {
      ...commandSuccess({ operationId, revision: applied.replay ? currentRevision : currentRevision + 1 }),
      replay: Boolean(applied.replay),
      changed: Boolean(applied.changed),
      before: clone(plan.before ?? {}),
      after: clone(plan.after ?? {}),
      backup: clone(backupValidation.receipt)
    };
    return applied.replay && typeof skip === "function" ? skip(result) : result;
  }, { reason: `economy-v2:activate:${operationId}`, scope: "both" });
}
