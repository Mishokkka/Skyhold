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

export function getSkyholdAuthorityState({
  user = globalThis.game?.user,
  users = globalThis.game?.users,
  socket = globalThis.game?.socket
} = {}) {
  const isGM = Boolean(user?.isGM);
  const activeGm = activeSkyholdGm(users);
  const socketAvailable = Boolean(socket && typeof socket.emit === "function");
  const hasActiveGm = Boolean(activeGm);
  const writeAvailable = isGM || (socketAvailable && hasActiveGm);
  const status = isGM
    ? "local-gm"
    : !socketAvailable
      ? "socket-unavailable"
      : hasActiveGm
        ? "online"
        : "offline";

  return {
    status,
    isGM,
    activeGm,
    activeGmId: String(activeGm?.id ?? ""),
    activeGmName: String(activeGm?.name ?? ""),
    hasActiveGm,
    socketAvailable,
    requiresActiveGm: !isGM,
    writeAvailable
  };
}
