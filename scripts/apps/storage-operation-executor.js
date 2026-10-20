import { SkyholdData } from "../data/store.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { composeDomainGroup } from "./domains/compose-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";

const STORAGE_OPERATION_TYPES = new Set([
  "depositItem",
  "withdrawResource",
  "giveStoredItem",
  "addResourceRow",
  "contributeUniqueBuilding",
  "batchMove"
]);
const REMOTE_GM_ONLY_STORAGE_TYPES = new Set(["depositItem", "withdrawResource", "giveStoredItem"]);

const StorageOperationLogic = composeDomainGroup("StorageOperationLogic", [
  ["BuildingDomain", BuildingDomain],
  ["FinanceDomain", FinanceDomain],
  ["StorageOperationSupport", {
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }]
]);

function operationError(message) {
  return new Error(`FBL Skyhold | ${message}`);
}

function normalizeOperation(raw = {}) {
  const type = String(raw?.type ?? "");
  if (!STORAGE_OPERATION_TYPES.has(type)) throw operationError("Unknown storage operation.");
  const operationId = String(raw?.operationId ?? "").trim();
  const holdingId = String(raw?.holdingId ?? "").trim();
  if (!operationId || operationId.length > 120) throw operationError("Storage operation id is missing or too long.");
  if (!holdingId) throw operationError("Storage operation holding id is missing.");
  const rowIds = Array.from(new Set((Array.isArray(raw?.rowIds) ? raw.rowIds : [])
    .map((id) => String(id ?? "").trim().slice(0, 120))
    .filter(Boolean))).slice(0, 200);
  const allowedRowIds = new Set(rowIds);
  const rowQuantities = Object.fromEntries(Object.entries(raw?.rowQuantities && typeof raw.rowQuantities === "object" ? raw.rowQuantities : {})
    .filter(([id]) => allowedRowIds.has(String(id)))
    .map(([id, qty]) => [String(id), Math.max(1, Math.min(1_000_000, Math.floor(Number(qty) || 1)))]));
  return {
    type,
    operationId,
    holdingId,
    actorId: String(raw?.actorId ?? "").trim(),
    actorUuid: String(raw?.actorUuid ?? "").trim(),
    itemId: String(raw?.itemId ?? "").trim(),
    itemUuid: String(raw?.itemUuid ?? "").trim(),
    buildingId: String(raw?.buildingId ?? "").trim(),
    resourceId: String(raw?.resourceId ?? "custom").trim() || "custom",
    name: String(raw?.name ?? "").trim().slice(0, 300),
    roomId: String(raw?.roomId ?? "outdoors").trim() || "outdoors",
    fromRoomId: String(raw?.fromRoomId ?? raw?.roomId ?? "outdoors").trim() || "outdoors",
    toRoomId: String(raw?.toRoomId ?? "outdoors").trim() || "outdoors",
    rowType: String(raw?.rowType ?? "") === "items" ? "items" : "resources",
    rowIds,
    rowQuantities,
    expectedRevision: Number.isFinite(Number(raw?.expectedRevision)) ? Math.max(0, Math.floor(Number(raw.expectedRevision))) : null,
    qty: Math.max(1, Math.min(1_000_000, Math.floor(Number(raw?.qty) || 1)))
  };
}

function userOwnsActor(actor, user) {
  if (!actor || !user) return false;
  if (user.isGM) return true;
  const ownerLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  if (typeof actor.testUserPermission === "function") {
    try {
      return Boolean(actor.testUserPermission(user, ownerLevel));
    } catch (_error) {}
  }
  if (String(user.character?.id ?? "") === String(actor.id ?? "")) return true;
  const explicit = Number(actor.ownership?.[user.id] ?? actor.permission?.[user.id] ?? -1);
  const fallback = Number(actor.ownership?.default ?? actor.permission?.default ?? -1);
  return Math.max(explicit, fallback) >= ownerLevel;
}

function holdingAllowsOperation(holding, user) {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  return holding.visibility !== "gm" && holding?.gm?.playersCanUseStorage === true;
}

function hasCompletedOperation(holding, operationId) {
  return (holding?.storage?.log ?? []).some((entry) => String(entry?.operationId ?? "") === operationId);
}

function publicResult(result = {}, operationId, extra = {}) {
  return {
    ok: result?.ok !== false,
    operationId,
    message: String(result?.message ?? ""),
    ...extra
  };
}

export function createStorageOperationExecutor({
  logic = StorageOperationLogic,
  updateHolding = (holdingId, updater, options) => SkyholdData.updateHolding(holdingId, updater, options),
  skipTransaction = (value) => SkyholdData.skipTransaction(value),
  getUser = (userId) => globalThis.game?.users?.get?.(userId)
    ?? (Array.isArray(globalThis.game?.users?.contents)
      ? globalThis.game.users.contents.find((user) => String(user?.id ?? "") === String(userId ?? ""))
      : null),
  getActor = (actorId) => globalThis.game?.actors?.get?.(actorId),
  resolveUuid = resolveFoundryUuid
} = {}) {
  const operationResults = new Map();

  async function compensateActorMutation(receipt) {
    if (!receipt) return;
    const restored = receipt.kind === "created"
      ? await logic._removeCreatedActorItems.call(logic, receipt)
      : receipt.ok ? await logic._restoreActorItemRemoval.call(logic, receipt) : false;
    if (restored === false) throw operationError("Не удалось восстановить инвентарь персонажа после ошибки записи.");
  }

  async function executeOnce(rawOperation, { userId = "", remote = false } = {}) {
    const operation = normalizeOperation(rawOperation);
    const requester = getUser(userId);
    if (!requester) throw operationError("Storage operation requester was not found.");
    if (remote && requester.isGM) {
      throw operationError("Remote storage operations cannot claim GM authority.");
    }
    if (!requester.isGM && operation.type === "addResourceRow") {
      throw operationError("Только ГМ может вручную добавлять ресурсы на склад.");
    }
    if (remote && REMOTE_GM_ONLY_STORAGE_TYPES.has(operation.type)) {
      throw operationError("Actor and Item storage transfers must be performed directly by a GM.");
    }

    let actorMutation = null;
    try {
      const result = await updateHolding(operation.holdingId, async (holding, data) => {
        if (!holdingAllowsOperation(holding, requester)) {
          return skipTransaction({ ok: false, message: "Нет прав на операции с этим хранилищем." });
        }
        const prior = findHoldingOperation(holding, operation.operationId);
        if (prior || hasCompletedOperation(holding, operation.operationId)) {
          if (prior?.type !== "system" || prior.payload?.signature !== JSON.stringify(operation)
            || prior.payload?.userId !== String(userId)) {
            throw operationError("Storage operation id is already used by another or unverifiable operation.");
          }
          return skipTransaction({ ...prior.payload.result, duplicate: true, replay: true });
        }
        if (operation.type === "batchMove" && operation.expectedRevision !== Math.max(0, Number(data?.meta?.revision) || 0)) {
          return skipTransaction({
            ok: false,
            stale: true,
            operationId: operation.operationId,
            message: "Склад изменился после предпросмотра. Повтори пакетную операцию."
          });
        }

        let actor = operation.actorId ? getActor(operation.actorId) : null;
        if (!actor && operation.actorUuid && typeof resolveUuid === "function") actor = await resolveUuid(operation.actorUuid);
        if (!["depositItem", "contributeUniqueBuilding", "batchMove", "addResourceRow"].includes(operation.type) && !actor) {
          return skipTransaction({ ok: false, message: "Персонаж-получатель не найден." });
        }
        if (actor && !userOwnsActor(actor, requester)) {
          return skipTransaction({ ok: false, message: "Нет прав владельца на выбранного персонажа." });
        }

        let applied;
        if (operation.type === "batchMove") {
          applied = logic._applyStorageBatchMove.call(logic, holding, {
            rowType: operation.rowType,
            rowIds: operation.rowIds,
            rowQuantities: operation.rowQuantities,
            fromRoomId: operation.fromRoomId,
            toRoomId: operation.toRoomId,
            operationId: operation.operationId
          });
        } else if (operation.type === "addResourceRow") {
          applied = logic._applyManualStorageChange.call(logic, holding, {
            resourceId: operation.resourceId,
            name: operation.name,
            qty: operation.qty,
            roomId: operation.roomId,
            kind: "manual-add",
            note: "Выбрано из каталога",
            operationId: operation.operationId
          });
        } else if (operation.type === "contributeUniqueBuilding") {
          const building = (holding?.buildings?.list ?? []).find((item) => String(item?.id ?? "") === operation.buildingId);
          const shop = building?.special?.kind === "fasti-shop" ? building.special.data : null;
          if (!building || !shop) return skipTransaction({ ok: false, message: "Лавка Фасти не найдена." });
          if (shop.unlocked) return skipTransaction({ ok: false, message: "Лавка уже открыта." });
          const treasury = Math.max(0, Math.floor(Number(holding?.storage?.moneyCopper) || 0));
          const remaining = Math.max(0, Math.floor(Number(shop.unlockCostCopper) || 399990) - Math.floor(Number(shop.contributedCopper) || 0));
          const amount = Math.min(operation.qty, treasury, remaining);
          if (amount <= 0) return skipTransaction({ ok: false, message: treasury <= 0 ? "В казне нет денег для вклада." : "Вклад уже собран." });
          holding.storage.moneyCopper = treasury - amount;
          shop.contributedCopper = Math.min(shop.unlockCostCopper, Math.max(0, Number(shop.contributedCopper) || 0) + amount);
          shop.unlocked = shop.contributedCopper >= shop.unlockCostCopper;
          if (!Array.isArray(shop.contributionLog)) shop.contributionLog = [];
          shop.contributionLog.push({
            id: operation.operationId,
            operationId: operation.operationId,
            userId: String(requester.id ?? ""),
            userName: String(requester.name ?? ""),
            amountCopper: amount,
            at: new Date().toISOString()
          });
          if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
          holding.storage.log.push({
            id: operation.operationId,
            operationId: operation.operationId,
            kind: "expense",
            resourceId: "money",
            name: "Деньги",
            qty: -amount,
            source: "Лавка Фасти ди Ото",
            note: `Вклад ${requester.name ?? ""}`.trim(),
            at: new Date().toISOString()
          });
          applied = {
            ok: true,
            message: shop.unlocked ? "Лавка редкостей Фасти ди Ото открыта." : "Вклад принят.",
            amountCopper: amount,
            contributedCopper: shop.contributedCopper,
            unlocked: shop.unlocked
          };
        } else if (operation.type === "depositItem") {
          let item = actor?.items?.get?.(operation.itemId) ?? null;
          if (!item && operation.itemUuid && typeof resolveUuid === "function") item = await resolveUuid(operation.itemUuid);
          const parent = item?.parent;
          const parentDocumentName = parent?.documentName ?? parent?.constructor?.documentName;
          if (!item) return skipTransaction({ ok: false, message: "Предмет для помещения в хранилище не найден." });
          if (!requester.isGM) {
            if (!actor || parentDocumentName !== "Actor" || String(parent?.id ?? "") !== String(actor.id ?? "")) {
              return skipTransaction({ ok: false, message: "Игрок может класть только предметы принадлежащего ему персонажа." });
            }
          }
          applied = await logic._storageReceiveFoundryItem.call(logic, holding, item, {
            roomId: operation.roomId,
            operationId: operation.operationId
          });
        } else if (operation.type === "withdrawResource") {
          applied = await logic._withdrawResourceToActor.call(logic, holding, {
            actorId: String(actor?.id ?? operation.actorId),
            actor,
            resourceId: operation.resourceId,
            name: operation.name,
            roomId: operation.roomId,
            qty: operation.qty,
            operationId: operation.operationId
          });
        } else {
          applied = await logic._giveStoredItemToActor.call(logic, holding, {
            actorId: String(actor?.id ?? operation.actorId),
            actor,
            itemId: operation.itemId,
            qty: operation.qty,
            operationId: operation.operationId
          });
        }

        if (!applied?.ok) return skipTransaction(applied);
        actorMutation = applied.actorMutation ?? null;
        const response = publicResult(applied, operation.operationId, operation.type === "batchMove" ? {
          moved: Math.max(0, Number(applied.moved) || 0),
          rowType: applied.rowType,
          placements: Array.isArray(applied.placements) ? applied.placements : []
        } : {});
        appendHoldingOperation(holding, { operationId: operation.operationId, type: "system",
          title: "Операция хранилища", summary: response.message,
          payload: { signature: JSON.stringify(operation), userId: String(userId), result: response } });
        return response;
      }, { fallback: false, reason: `storage-operation:${operation.type}` });

      if (!result) throw operationError("Storage operation holding was not found.");
      return result;
    } catch (error) {
      if (actorMutation) {
        try {
          await compensateActorMutation(actorMutation);
        } catch (compensationError) {
          console.error("FBL Skyhold | Storage operation compensation failed", {
            operationId: operation.operationId,
            error: compensationError
          });
          throw operationError(`${error?.message ?? error}; compensation failed: ${compensationError?.message ?? compensationError}`);
        }
      }
      throw error;
    }
  }

  return async function executeStorageOperation(rawOperation, context = {}) {
    const operation = normalizeOperation(rawOperation);
    const signature = JSON.stringify([String(context.userId ?? ""), Boolean(context.remote), operation]);
    if (operationResults.has(operation.operationId)) {
      const cached = operationResults.get(operation.operationId);
      if (cached.signature !== signature) throw operationError("Storage operation id is already used by another operation.");
      return cached.promise;
    }
    const pending = executeOnce(operation, context);
    operationResults.set(operation.operationId, { signature, promise: pending });
    if (operationResults.size > 500) operationResults.delete(operationResults.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      operationResults.delete(operation.operationId);
      throw error;
    }
  };
}

export const executeStorageOperation = createStorageOperationExecutor();
