import { SkyholdData } from "../data/store.js";
import { AssignmentDomain } from "./domains/assignment-domain.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { composeDomainGroup } from "./domains/compose-domain.js";
import { applyDefenseOperation, DEFENSE_OPERATIONS, normalizeDefenseOperation } from "./domains/defense-operation-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { ResidentDomain } from "./domains/resident-domain.js";
import { foundryActorOwnedBy, resolveFoundryActorReference, resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { hiddenStorageRoomIds } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { createWriteQueue } from "../data/write-queue.js";
import { isActorStorageTransfer } from "../data/constants.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { MAX_STORAGE_BATCH_ROWS, STORAGE_BATCH_TOO_LARGE } from "../engines/storage/row-identity.js";

const STORAGE_OPERATION_TYPES = new Set([
  "addResourceRow",
  "contributeUniqueBuilding",
  "batchMove"
]);

const StorageOperationLogic = composeDomainGroup("StorageOperationLogic", [
  ["ResidentDomain", ResidentDomain],
  ["BuildingDomain", BuildingDomain],
  ["AssignmentDomain", AssignmentDomain],
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

function unknownTransferOutcome(operationId, cause, detail = "") {
  const message = `Исход обмена ${operationId} не подтверждён. Сверьте склад и инвентарь персонажа перед повтором.`;
  return Object.assign(new Error(detail ? `${message} ${detail}` : message, { cause }),
    { code: COMMAND_ERROR.OUTCOME_UNKNOWN, operationId });
}

function actorMutationSummary(receipt) {
  const actor = receipt.actorUuid || receipt.actorId;
  const items = receipt.items ?? [{ id: receipt.itemId, name: receipt.previousData?.name, qty: receipt.previousQuantity }];
  const stacks = items.map(({ id, name, qty }) => [name, qty && `${qty} ед.`, id].filter(Boolean).join(", "));
  return [actor, ...stacks].filter(Boolean).join(" · ");
}

function normalizeOperation(raw = {}) {
  const type = String(raw?.type ?? "");
  const defense = DEFENSE_OPERATIONS.has(type);
  if (!defense && !isActorStorageTransfer(type) && !STORAGE_OPERATION_TYPES.has(type)) throw operationError("Unknown storage operation.");
  const operationId = String(raw?.operationId ?? "").trim();
  const holdingId = String(raw?.holdingId ?? "").trim();
  if (!operationId || operationId.length > 120) throw operationError("Storage operation id is missing or too long.");
  if (!holdingId) throw operationError("Storage operation holding id is missing.");
  if (defense) return normalizeDefenseOperation(raw, { type, operationId, holdingId });
  const batchMove = type === "batchMove";
  // Stored row IDs are opaque, including IDs from old or imported data.
  const rowIds = Array.from(new Set((Array.isArray(raw?.rowIds) ? raw.rowIds : [])
    .map((id) => String(id ?? ""))
    .filter(Boolean)));
  if (rowIds.length > MAX_STORAGE_BATCH_ROWS) throw operationError(STORAGE_BATCH_TOO_LARGE);
  const allowedRowIds = new Set(rowIds);
  const rowQuantities = Object.fromEntries(Object.entries(raw?.rowQuantities && typeof raw.rowQuantities === "object" ? raw.rowQuantities : {})
    .filter(([id]) => allowedRowIds.has(String(id)))
    .map(([id, qty]) => {
      const amount = Number(qty);
      if (batchMove && (!Number.isSafeInteger(amount) || amount < 1)) throw operationError("Некорректное количество для перемещения.");
      return [String(id), batchMove ? amount : Math.max(1, Math.min(1_000_000, Math.floor(amount || 1)))];
    }));
  return {
    type,
    operationId,
    holdingId,
    actorId: String(raw?.actorId ?? "").trim(),
    actorUuid: String(raw?.actorUuid ?? "").trim(),
    itemId: type === "giveStoredItem" ? String(raw?.itemId ?? "") : String(raw?.itemId ?? "").trim(),
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
    expectedRevision: raw?.expectedRevision != null && Number.isFinite(Number(raw.expectedRevision))
      ? Math.max(0, Math.floor(Number(raw.expectedRevision))) : null,
    qty: Math.max(1, Math.min(1_000_000, Math.floor(Number(raw?.qty) || 1)))
  };
}

function holdingAllowsOperation(holding, user) {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  return holding.visibility !== "gm" && holding?.gm?.playersCanUseStorage === true;
}

function storageOperationSignature(operation) {
  // Older receipts serialized an omitted revision as zero after normalizing twice.
  return JSON.stringify({ ...operation, expectedRevision: operation.expectedRevision ?? 0 });
}

function matchingStorageReceipt(receipt, signature, userId) {
  return receipt?.type === "system" && receipt.payload?.signature === signature && receipt.payload.userId === String(userId);
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

function recordStorageResult(holding, operation, applied, signature, userId) {
  const response = publicResult(applied, operation.operationId, operation.type === "batchMove" ? {
    moved: Math.max(0, Number(applied.moved) || 0),
    rowType: applied.rowType,
    placements: Array.isArray(applied.placements) ? applied.placements : []
  } : operation.type === "depositItem" && applied.roomId ? { roomId: applied.roomId } : {});
  appendHoldingOperation(holding, { operationId: operation.operationId, type: "system",
    title: DEFENSE_OPERATIONS.has(operation.type) ? "Операция обороны" : "Операция хранилища",
    summary: response.message, payload: { signature, userId: String(userId), result: response } });
  return response;
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
  resolveUuid = resolveFoundryUuid,
  readCommittedData = () => SkyholdData.view()
} = {}) {
  const operationResults = new Map();
  // A rejected settings write releases the world queue before its Actor can
  // be restored. Storage commands must not observe that temporary inventory.
  const enqueueOperation = createWriteQueue();

  async function compensateActorMutation(receipt) {
    if (!receipt) return;
    const restored = receipt.kind === "created"
      ? await logic._removeCreatedActorItems.call(logic, receipt)
      : receipt.ok ? await logic._restoreActorItemRemoval.call(logic, receipt) : false;
    if (restored === false) throw operationError("Не удалось восстановить инвентарь персонажа после ошибки записи.");
  }

  function readTransferOutcome(operation, signature, userId) {
    let committed;
    try { committed = readCommittedData(); }
    catch (error) { console.warn("FBL Skyhold | Cannot verify the storage transfer receipt.", error); }
    const holding = committed?.holdings?.find(row => row.id === operation.holdingId);
    const receipt = findHoldingOperation(holding, operation.operationId);
    return {
      revision: holding && Number.isSafeInteger(committed?.meta?.revision) ? committed.meta.revision : null,
      result: matchingStorageReceipt(receipt, signature, userId) ? { ...receipt.payload.result, replay: true } : null
    };
  }

  async function executeOnce(operation, { userId = "" } = {}) {
    const signature = storageOperationSignature(operation);
    const requester = getUser(userId);
    if (!requester) throw operationError("Storage operation requester was not found.");
    const defense = DEFENSE_OPERATIONS.has(operation.type);
    const actorTransfer = isActorStorageTransfer(operation.type);
    if (!requester.isGM && operation.type === "addResourceRow") {
      throw operationError("Только ГМ может вручную добавлять ресурсы на склад.");
    }
    if (!requester.isGM && actorTransfer) {
      throw operationError("Actor and Item storage transfers must be performed directly by a GM.");
    }

    let actorMutation = null;
    let transferRevision;
    try {
      const result = await updateHolding(operation.holdingId, async (holding, data) => {
        const allowed = defense ? holdingPermissionContext(holding, { user: requester }).mayEditDefense
          : holdingAllowsOperation(holding, requester);
        if (!allowed) {
          return skipTransaction({ ok: false, message: defense
            ? "Нет прав на управление обороной этого владения." : "Нет прав на операции с этим хранилищем." });
        }
        const prior = findHoldingOperation(holding, operation.operationId);
        if (prior || hasCompletedOperation(holding, operation.operationId)) {
          if (!matchingStorageReceipt(prior, signature, userId)) {
            throw operationError("Storage operation id is already used by another or unverifiable operation.");
          }
          return skipTransaction({ ...prior.payload.result, duplicate: true, replay: true });
        }
        if (defense) {
          const applied = applyDefenseOperation(holding, operation, { requester, logic });
          return !applied.ok || applied.unchanged ? skipTransaction(applied)
            : recordStorageResult(holding, operation, applied, signature, userId);
        }
        const checksRevision = operation.type === "batchMove"
          || (actorTransfer && operation.expectedRevision !== null);
        if (checksRevision && operation.expectedRevision !== Math.max(0, Number(data?.meta?.revision) || 0)) {
          return skipTransaction({
            ok: false,
            stale: true,
            operationId: operation.operationId,
            message: "Склад изменился после предпросмотра. Откройте действие заново."
          });
        }

        const actor = actorTransfer
          ? await resolveFoundryActorReference(operation, { getActor, resolveUuid }) : null;
        if (actorTransfer && !actor
          && (operation.type !== "depositItem" || operation.actorUuid || operation.actorId)) {
          return skipTransaction({ ok: false, message: "Персонаж-получатель не найден." });
        }
        if (actor && !foundryActorOwnedBy(actor, requester)) {
          return skipTransaction({ ok: false, message: "Нет прав владельца на выбранного персонажа." });
        }

        let applied;
        if (operation.type === "batchMove") {
          const hiddenRooms = hiddenStorageRoomIds(holding, requester.isGM);
          if (hiddenRooms.has(operation.fromRoomId) || hiddenRooms.has(operation.toRoomId)) {
            return skipTransaction({ ok: false, message: "Это помещение недоступно." });
          }
          applied = logic._applyStorageBatchMove.call(logic, holding, {
            rowType: operation.rowType,
            rowIds: operation.rowIds,
            rowQuantities: operation.rowQuantities,
            fromRoomId: operation.fromRoomId,
            toRoomId: operation.toRoomId,
            hiddenRooms,
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
            separateRow: operation.resourceId === "custom",
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
          const embedded = actor?.items?.get?.(operation.itemId) ?? null;
          const item = operation.itemUuid && embedded?.uuid !== operation.itemUuid
            ? await resolveUuid(operation.itemUuid) : embedded;
          const parent = item?.parent;
          if (!item || operation.itemUuid && item.uuid !== operation.itemUuid
            || actor && parent !== actor && (!actor.uuid || parent?.uuid !== actor.uuid)) {
            return skipTransaction({ ok: false, message: "Предмет для помещения в хранилище не найден у выбранного персонажа." });
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
            storageRowId: operation.rowIds[0],
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
        transferRevision = Math.max(0, Number(data?.meta?.revision) || 0);
        return recordStorageResult(holding, operation, applied, signature, userId);
      }, { fallback: false, localAuthority: true, reason: `storage-operation:${operation.type}` });

      if (!result) throw operationError("Storage operation holding was not found.");
      return result;
    } catch (error) {
      if (actorMutation) {
        const outcome = readTransferOutcome(operation, signature, userId);
        if (outcome.result) return outcome.result;
        if (error?.code === COMMAND_ERROR.OUTCOME_UNKNOWN || outcome.revision !== transferRevision) {
          throw unknownTransferOutcome(operation.operationId, error, actorMutationSummary(actorMutation));
        }
        try {
          await compensateActorMutation(actorMutation);
        } catch (compensationError) {
          console.error("FBL Skyhold | Storage operation compensation failed", {
            operationId: operation.operationId,
            error: compensationError
          });
          throw unknownTransferOutcome(operation.operationId, error, compensationError?.message ?? String(compensationError));
        }
      } else if (actorTransfer && error?.code === COMMAND_ERROR.OUTCOME_UNKNOWN) {
        throw unknownTransferOutcome(operation.operationId, error, error.message);
      }
      throw error;
    }
  }

  return async function executeStorageOperation(rawOperation, context = {}) {
    const operation = normalizeOperation(rawOperation);
    const signature = JSON.stringify([String(context.userId ?? ""), operation]);
    if (operationResults.has(operation.operationId)) {
      const cached = operationResults.get(operation.operationId);
      if (cached.signature !== signature) throw operationError("Storage operation id is already used by another operation.");
      try { return await cached.promise; }
      catch (error) {
        if (error?.code === COMMAND_ERROR.OUTCOME_UNKNOWN) {
          // A retry can acknowledge a late receipt without repeating the Actor mutation.
          const { result } = readTransferOutcome(operation, storageOperationSignature(operation), context.userId);
          if (result) return result;
        }
        throw error;
      }
    }
    const pending = enqueueOperation(() => executeOnce(operation, context));
    operationResults.set(operation.operationId, { signature, promise: pending });
    if (operationResults.size > 500) operationResults.delete(operationResults.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      if (error?.code !== COMMAND_ERROR.OUTCOME_UNKNOWN) operationResults.delete(operation.operationId);
      throw error;
    }
  };
}

export const executeStorageOperation = createStorageOperationExecutor();
