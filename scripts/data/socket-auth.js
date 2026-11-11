import { activeSkyholdGm } from "./authority.js";

/** Foundry supplies senderId as the second socket callback argument, outside the payload. */
export function socketSender(senderId) {
  if (typeof senderId !== "string" || !senderId) return null;
  const users = globalThis.game?.users;
  return users?.get?.(senderId) ?? (users?.contents ?? []).find((user) => user.id === senderId) ?? null;
}

function authoritySocketRequester(payload, senderId) {
  const sender = socketSender(senderId);
  const current = globalThis.game?.user;
  return sender && payload.userId === senderId && current?.isGM
    && payload.targetGmId === current.id && activeSkyholdGm()?.id === current.id ? sender : null;
}

export function acceptsPlayerSocketRequest(payload, senderId) {
  const sender = authoritySocketRequester(payload, senderId);
  return Boolean(sender && !sender.isGM);
}

export function acceptsStorageSocketRequest(payload, senderId) {
  return Boolean(authoritySocketRequester(payload, senderId));
}

export function acceptsGmSocketResponse(payload, senderId, pending) {
  return Boolean(socketSender(senderId)?.isGM && payload.gmId === senderId
    && payload.userId === globalThis.game?.user?.id && pending?.authorities?.has(senderId)
    && payload.operationId === payload.requestId);
}
