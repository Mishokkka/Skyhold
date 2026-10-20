import { canReadHolding } from "./access-guard.js";
import { getSkyholdAuthorityState } from "./authority.js";

export function politicsPermissionContext(holding, { user = globalThis.game?.user, authority = getSkyholdAuthorityState({ user }) } = {}) {
  const isGM = user?.isGM === true;
  const canView = canReadHolding(holding, user) && (isGM || holding?.gm?.playersCanViewPolitics !== false);
  const writable = isGM || authority?.writeAvailable === true;
  return { canView, writable,
    canPetition: canView && writable,
    canUseDirectives: canView && writable && (isGM || (holding?.gm?.playersCanUseDirectives === true && holding?.politics?.stage !== "protectorate")),
    canIssueDecrees: canView && writable && (isGM || (holding?.gm?.playersCanIssueDecrees === true && holding?.politics?.stage !== "protectorate")),
    canRequestIntel: canView && writable && (isGM || holding?.gm?.playersCanIssueDecrees === true)
  };
}

/** Authority executors must still check actual visibility and permissions at commit. */
export function politicsPlayerActionAllowed(holding, action, user) {
  if (user?.isGM) return true;
  const permission = politicsPermissionContext(holding, { user, authority: { writeAvailable: true } });
  if (action === "petition") return permission.canPetition;
  if (action === "directive") return permission.canUseDirectives;
  if (["decree", "request-decree"].includes(action)) return permission.canIssueDecrees;
  if (action === "request-intel") return permission.canRequestIntel;
  return false;
}
