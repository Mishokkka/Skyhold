function userRows(users = globalThis.game?.users) {
  if (Array.isArray(users?.contents)) return users.contents;
  if (Array.isArray(users)) return users;
  try { return Array.from(users ?? []); }
  catch (_error) { return []; }
}

export function activeSkyholdGm(users = globalThis.game?.users) {
  return userRows(users)
    .filter((user) => user?.active && user?.isGM)
    .sort((left, right) => String(left?.id ?? "").localeCompare(String(right?.id ?? "")))[0] ?? null;
}

export function isSkyholdAuthorityGm({
  user = globalThis.game?.user,
  users = globalThis.game?.users
} = {}) {
  if (!user?.isGM) return false;
  const activeGm = activeSkyholdGm(users);
  // During early Foundry startup the active-user collection may not be ready.
  // A local GM remains usable then; as soon as active users are known, the
  // deterministic first GM becomes the only world-settings writer.
  return !activeGm || String(activeGm.id ?? "") === String(user?.id ?? "");
}

export function getSkyholdAuthorityState({
  user = globalThis.game?.user,
  users = globalThis.game?.users,
  socket = globalThis.game?.socket
} = {}) {
  const isGM = Boolean(user?.isGM);
  const activeGm = activeSkyholdGm(users);
  const isAuthorityGm = isSkyholdAuthorityGm({ user, users });
  const socketAvailable = Boolean(socket && typeof socket.emit === "function");
  const hasActiveGm = Boolean(activeGm);
  const writeAvailable = isGM ? isAuthorityGm : (socketAvailable && hasActiveGm);
  const status = isGM
    ? (isAuthorityGm ? "local-gm" : "secondary-gm")
    : !socketAvailable
      ? "socket-unavailable"
      : hasActiveGm
        ? "online"
        : "offline";

  return {
    status,
    isGM,
    isAuthorityGm,
    activeGm,
    activeGmId: String(activeGm?.id ?? ""),
    activeGmName: String(activeGm?.name ?? ""),
    hasActiveGm,
    socketAvailable,
    requiresActiveGm: !isGM,
    writeAvailable
  };
}
