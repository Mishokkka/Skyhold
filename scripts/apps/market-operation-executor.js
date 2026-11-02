import { COMMAND_ERROR } from "../data/command-result.js";
import { findHoldingOperation } from "../data/operations.js";
import { resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { SkyholdData } from "../data/store.js";

const MARKET_OPERATION_TYPES = new Set(["purchase", "outbound"]);
const MARKET_SERVICE_LEVELS = new Set(["standard", "express", "charter"]);
const MARKET_UUID_RESOLVE_CONCURRENCY = 4;

function marketOperationError(message, code = COMMAND_ERROR.EXECUTION_FAILED, extra = {}) {
  const error = new Error(`FBL Skyhold | ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizedQuantities(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(source)
    .slice(0, 1_000)
    .map(([key, qty]) => [String(key ?? "").trim().slice(0, 300), Math.max(0, Math.min(1_000_000, Math.floor(Number(qty) || 0)))])
    .filter(([key, qty]) => key && qty > 0));
}

function normalizeMarketOperation(raw = {}) {
  const type = String(raw?.type ?? "").trim();
  if (!MARKET_OPERATION_TYPES.has(type)) throw marketOperationError("Unknown market operation.", COMMAND_ERROR.INVALID);
  const operationId = String(raw?.operationId ?? "").trim();
  const holdingId = String(raw?.holdingId ?? "").trim();
  const expectedRevision = Number(raw?.expectedRevision);
  const sourceToken = String(raw?.sourceToken ?? "").trim();
  const planToken = String(raw?.planToken ?? "");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw marketOperationError("Market operation id is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!holdingId) throw marketOperationError("Market operation holding id is missing.", COMMAND_ERROR.INVALID);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw marketOperationError("Market operation expected revision is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!sourceToken || sourceToken.length > 200) {
    throw marketOperationError("Market operation source token is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!planToken || planToken.length > 100_000) {
    throw marketOperationError("Market operation plan token is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  return {
    type,
    operationId,
    holdingId,
    expectedRevision,
    sourceToken,
    planToken,
    marketId: String(raw?.marketId ?? "").trim().slice(0, 300),
    carrierId: String(raw?.carrierId ?? "").trim().slice(0, 300),
    ownShipId: type === "outbound" ? String(raw?.ownShipId ?? "").trim().slice(0, 128) : "",
    targetRoomId: String(raw?.targetRoomId ?? "outdoors").trim().slice(0, 300) || "outdoors",
    serviceLevel: MARKET_SERVICE_LEVELS.has(String(raw?.serviceLevel ?? "")) ? String(raw.serviceLevel) : "standard",
    quantities: normalizedQuantities(raw?.quantities),
    insuranceEnabled: raw?.insuranceEnabled !== false
  };
}

function getUserById(userId) {
  return globalThis.game?.users?.get?.(userId)
    ?? (Array.isArray(globalThis.game?.users?.contents)
      ? globalThis.game.users.contents.find((user) => String(user?.id ?? "") === String(userId ?? ""))
      : null);
}

function holdingAllowsMarketOperation(holding, user) {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  return holding.visibility !== "gm" && holding?.gm?.playersCanUseStorage === true;
}

function operationLogType(type) {
  return type === "outbound" ? "market-outbound" : "market-purchase";
}

function replayResult(holding, operation, userId) {
  const existing = findHoldingOperation(holding, operation.operationId);
  if (!existing) return null;
  if (existing.type !== operationLogType(operation.type)) {
    throw marketOperationError("Market operation id is already used by another operation.", COMMAND_ERROR.INVALID);
  }
  const payload = existing.payload && typeof existing.payload === "object" ? existing.payload : {};
  const order = operation.type === "outbound"
    ? (holding.special?.market?.outbound?.orders ?? []).find((row) => row.operationId === operation.operationId || row.parentOperationId === operation.operationId)
    : null;
  if (order && String(order.ownShipId ?? "") !== operation.ownShipId) {
    throw marketOperationError("Market operation id is already used by another carrier.", COMMAND_ERROR.INVALID);
  }
  if (payload.signature !== JSON.stringify(operation) || payload.userId !== String(userId)) {
    throw marketOperationError("Market operation id is already used by another or unverifiable operation.", COMMAND_ERROR.CONFLICT);
  }
  return {
    ok: true,
    replay: true,
    duplicate: true,
    operationId: operation.operationId,
    ...payload
  };
}

export async function resolveMarketItemDocuments(lines = [], resolveUuid = resolveFoundryUuid) {
  const itemLines = lines.filter((line) => line.sourceType === "item");
  const uuids = [];
  const seenUuids = new Set();
  for (const line of itemLines) {
    const uuid = String(line.itemUuid ?? "").trim();
    if (!uuid) throw marketOperationError(`Item UUID is missing for ${line.name || line.id}.`, COMMAND_ERROR.INVALID);
    if (!seenUuids.has(uuid)) {
      seenUuids.add(uuid);
      uuids.push(uuid);
    }
  }

  const resolvedByUuid = new Map();
  let cursor = 0;
  const workerCount = Math.min(MARKET_UUID_RESOLVE_CONCURRENCY, uuids.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < uuids.length) {
      const uuid = uuids[cursor++];
      let document = null;
      try {
        document = await resolveUuid(uuid);
      } catch (_error) {}
      resolvedByUuid.set(uuid, document);
    }
  }));

  const documents = new Map();
  for (const line of itemLines) {
    const uuid = String(line.itemUuid ?? "").trim();
    const document = resolvedByUuid.get(uuid) ?? null;
    const documentName = document?.documentName ?? document?.constructor?.documentName;
    if (!document || documentName !== "Item") {
      throw marketOperationError(`Market Item was not found: ${uuid}.`, COMMAND_ERROR.CONFLICT, { stale: true });
    }
    documents.set(line.id, document);
  }
  return documents;
}


/** Only acknowledge already committed historical commands; every new booking uses transport-operation-executor. */
export function createMarketOperationExecutor({ getUser = getUserById, getData = () => SkyholdData.view() } = {}) {
  return async (raw, { userId = "", remote = false } = {}) => {
    const operation = normalizeMarketOperation(raw), user = getUser(userId);
    const holding = getData().holdings?.find((row) => row.id === operation.holdingId);
    if (!holdingAllowsMarketOperation(holding, user) || remote && user?.isGM) throw marketOperationError("Нет доступа к заказу.", COMMAND_ERROR.FORBIDDEN);
    const replay = replayResult(holding, operation, userId);
    if (replay) return replay;
    throw marketOperationError("Откройте расчёт перевозки: прежняя форма заказа больше не используется.", COMMAND_ERROR.CONFLICT);
  };
}
export const executeMarketOperation = createMarketOperationExecutor();
