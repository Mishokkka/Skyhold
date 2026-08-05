import { SkyholdData } from "../data/store.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { composeDomainGroup } from "./domains/compose-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { resolveFoundryUuid } from "../integrations/foundry-runtime.js";
import { acceptFleetOffer, applyFleetTransfer, cancelFleetTransfer } from "../engines/fleet/enterprise.js";

const STORAGE_OPERATION_TYPES = new Set([
  "depositItem",
  "withdrawResource",
  "giveStoredItem",
  "contributeUniqueBuilding",
  "batchMove",
  "fleetAcceptOffer",
  "fleetTransfer",
  "fleetCancelTransfer",
  "marketPurchase",
  "marketExport",
  "marketCancelShipment"
]);

const MARKET_OPERATION_TYPES = new Set(["marketPurchase", "marketExport", "marketCancelShipment"]);

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
  return {
    type,
    operationId,
    holdingId,
    actorId: String(raw?.actorId ?? "").trim(),
    actorUuid: String(raw?.actorUuid ?? "").trim(),
    itemId: String(raw?.itemId ?? "").trim(),
    itemUuid: String(raw?.itemUuid ?? "").trim(),
    buildingId: String(raw?.buildingId ?? "").trim(),
    vesselId: String(raw?.vesselId ?? "").trim(),
    transferId: String(raw?.transferId ?? "").trim(),
    offerId: String(raw?.offerId ?? "").trim(),
    marketId: String(raw?.marketId ?? "").trim().slice(0, 120),
    orderId: String(raw?.orderId ?? "").trim().slice(0, 120),
    targetRoomId: String(raw?.targetRoomId ?? "outdoors").trim().slice(0, 120) || "outdoors",
    serviceLevel: ["standard", "express", "charter", "owned-fleet"].includes(String(raw?.serviceLevel ?? "")) ? String(raw.serviceLevel) : "standard",
    carrierId: String(raw?.carrierId ?? "").trim().slice(0, 120),
    quantities: Object.fromEntries(Object.entries(raw?.quantities && typeof raw.quantities === "object" ? raw.quantities : {}).slice(0, 100).map(([id, qty]) => [String(id).slice(0, 120), Math.max(0, Math.min(1_000_000, Math.floor(Number(qty) || 0)))]).filter(([, qty]) => qty > 0)),
    expectedSourceHash: String(raw?.expectedSourceHash ?? "").trim().slice(0, 200),
    expectedQuoteKey: String(raw?.expectedQuoteKey ?? "").trim().slice(0, 200),
    expectedTotalCopper: Math.max(0, Math.floor(Number(raw?.expectedTotalCopper) || 0)),
    exportOfferId: String(raw?.exportOfferId ?? "").trim().slice(0, 120),
    exportQuantity: Math.max(0, Math.min(1_000_000, Math.floor(Number(raw?.exportQuantity) || 0))),
    exportCarrierId: String(raw?.exportCarrierId ?? "").trim().slice(0, 120),
    exportServiceLevel: ["standard", "express", "charter"].includes(String(raw?.exportServiceLevel ?? "")) ? String(raw.exportServiceLevel) : "charter",
    expectedFingerprint: String(raw?.expectedFingerprint ?? "").trim().slice(0, 200),
    direction: String(raw?.direction ?? "") === "holding-to-vessel" ? "holding-to-vessel" : "vessel-to-holding",
    method: String(raw?.method ?? "physical").trim() || "physical",
    resourceId: String(raw?.resourceId ?? "custom").trim() || "custom",
    name: String(raw?.name ?? "").trim().slice(0, 300),
    roomId: String(raw?.roomId ?? "outdoors").trim() || "outdoors",
    fromRoomId: String(raw?.fromRoomId ?? raw?.roomId ?? "outdoors").trim() || "outdoors",
    toRoomId: String(raw?.toRoomId ?? "outdoors").trim() || "outdoors",
    rowType: String(raw?.rowType ?? "") === "items" ? "items" : "resources",
    rowIds: Array.from(new Set((Array.isArray(raw?.rowIds) ? raw.rowIds : [])
      .map((id) => String(id ?? "").trim().slice(0, 120))
      .filter(Boolean))).slice(0, 200),
    expectedRevision: Number.isFinite(Number(raw?.expectedRevision)) ? Math.max(0, Math.floor(Number(raw.expectedRevision))) : null,
    qty: Math.max(1, Math.min(1_000_000, Math.floor(Number(raw?.qty ?? raw?.amountCopper) || 1)))
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

function holdingAllowsOperation(holding, user, operationType = "") {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  if (MARKET_OPERATION_TYPES.has(operationType)) {
    return holding.visibility !== "gm" && holding?.gm?.playersCanManageMarkets === true;
  }
  if (operationType === "fleetAcceptOffer") {
    return holding.visibility !== "gm" && holding?.gm?.playersCanEditSpecial === true;
  }
  if (["fleetTransfer", "fleetCancelTransfer"].includes(operationType)) {
    return holding.visibility !== "gm"
      && holding?.gm?.playersCanUseStorage === true
      && holding?.gm?.playersCanEditSpecial === true;
  }
  return holding.visibility !== "gm" && holding?.gm?.playersCanUseStorage === true;
}

function hasCompletedOperation(holding, operationId) {
  return (holding?.storage?.log ?? []).some((entry) => String(entry?.operationId ?? "") === operationId)
    || (holding?.log ?? []).some((entry) => String(entry?.operationId ?? entry?.id ?? "") === operationId)
    || (holding?.special?.fleet?.transfers ?? []).some((entry) => [
      entry?.operationId,
      entry?.id,
      entry?.completionOperationId,
      entry?.cancelOperationId
    ].map((value) => String(value ?? "")).includes(operationId))
    || (holding?.special?.fleet?.vessels ?? []).some((vessel) => (vessel?.history ?? []).some((entry) => String(entry?.operationId ?? entry?.id ?? "") === operationId));
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
    if (receipt.kind === "created") await logic._removeCreatedActorItems.call(logic, receipt);
    else if (receipt.ok) await logic._restoreActorItemRemoval.call(logic, receipt);
  }

  async function executeOnce(rawOperation, { userId = "", remote = false } = {}) {
    const operation = normalizeOperation(rawOperation);
    const requester = getUser(userId);
    if (!requester) throw operationError("Storage operation requester was not found.");
    if (remote && requester.isGM) {
      throw operationError("Remote storage operations cannot claim GM authority.");
    }

    let actorMutation = null;
    try {
      const result = await updateHolding(operation.holdingId, async (holding, data) => {
        if (!holdingAllowsOperation(holding, requester, operation.type)) {
          return skipTransaction({ ok: false, message: MARKET_OPERATION_TYPES.has(operation.type) ? "GM не делегировал управление внешним рынком." : "Нет прав на операции с этим хранилищем." });
        }
        if (hasCompletedOperation(holding, operation.operationId)) {
          return skipTransaction(publicResult({}, operation.operationId, {
            duplicate: true,
            message: "Операция уже была выполнена."
          }));
        }
        if (["batchMove", "fleetAcceptOffer", "fleetTransfer", "fleetCancelTransfer", ...MARKET_OPERATION_TYPES].includes(operation.type) && operation.expectedRevision !== Math.max(0, Number(data?.meta?.revision) || 0)) {
          return skipTransaction({
            ok: false,
            stale: true,
            operationId: operation.operationId,
            message: MARKET_OPERATION_TYPES.has(operation.type)
              ? "Рынок, казна или склад изменились после подтверждения. Открой расчёт заново."
              : ["fleetTransfer", "fleetCancelTransfer"].includes(operation.type)
              ? "Касса или резервы изменились после предпросмотра. Проверь сумму и повтори перевод."
              : operation.type === "fleetAcceptOffer"
                ? "Предложение или состояние корабля изменились. Открой расчёт заново."
              : "Склад изменился после предпросмотра. Повтори пакетную операцию."
          });
        }

        let actor = operation.actorId ? getActor(operation.actorId) : null;
        if (!actor && operation.actorUuid && typeof resolveUuid === "function") actor = await resolveUuid(operation.actorUuid);
        if (!["depositItem", "contributeUniqueBuilding", "batchMove", "fleetAcceptOffer", "fleetTransfer", "fleetCancelTransfer", ...MARKET_OPERATION_TYPES].includes(operation.type) && !actor) {
          return skipTransaction({ ok: false, message: "Персонаж-получатель не найден." });
        }
        if (actor && !userOwnsActor(actor, requester)) {
          return skipTransaction({ ok: false, message: "Нет прав владельца на выбранного персонажа." });
        }

        let applied;
        if (MARKET_OPERATION_TYPES.has(operation.type)) {
          const { applyMarketOperation } = await import("./market-operation-executor.js");
          applied = await applyMarketOperation({ operation, holding, data, requester, logic, resolveUuid });
        } else if (operation.type === "fleetAcceptOffer") {
          const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === operation.vesselId);
          const offer = vessel?.offers?.find((row) => String(row?.id ?? "") === operation.offerId);
          let currentQuoteKey = "";
          let marketOfferAvailable;
          if (offer?.source === "market-generated") {
            const [{ marketQuotePeriodKey }, { normalizeMarketEconomy }, { effectiveMarketLocations }] = await Promise.all([
              import("../engines/market/pricing.js"),
              import("../data/market/economy.js"),
              import("../engines/market/composition.js")
            ]);
            const regions = data?.catalog?.eventRegions ?? [];
            const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: regions });
            const availableMarkets = effectiveMarketLocations({
              economy,
              locations: regions,
              resources: [],
              isGM: true,
              normalizedEconomy: true
            });
            currentQuoteKey = marketQuotePeriodKey(holding, { quotePeriodDays: 10 });
            marketOfferAvailable = availableMarkets.some((market) => String(market?.id ?? "") === String(offer.marketId ?? ""));
          }
          applied = acceptFleetOffer(holding, {
            vesselId: operation.vesselId,
            offerId: operation.offerId,
            departureQd: Math.max(0, Math.floor(Number(holding?.gm?.calendaria?.lastQd) || 0)),
            operationId: operation.operationId,
            acceptedAt: new Date().toISOString(),
            currentQuoteKey,
            marketOfferAvailable,
            isGM: requester.isGM === true
          });
        } else if (operation.type === "fleetTransfer") {
          applied = applyFleetTransfer(holding, {
            vesselId: operation.vesselId,
            direction: operation.direction,
            amountCopper: operation.qty,
            operationId: operation.operationId,
            createdAt: new Date().toISOString(),
            method: operation.method
          });
        } else if (operation.type === "fleetCancelTransfer") {
          applied = cancelFleetTransfer(holding, {
            vesselId: operation.vesselId,
            transferId: operation.transferId,
            operationId: operation.operationId,
            cancelledAt: new Date().toISOString()
          });
        } else if (operation.type === "batchMove") {
          applied = logic._applyStorageBatchMove.call(logic, holding, {
            rowType: operation.rowType,
            rowIds: operation.rowIds,
            fromRoomId: operation.fromRoomId,
            toRoomId: operation.toRoomId,
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
        return publicResult(applied, operation.operationId, MARKET_OPERATION_TYPES.has(operation.type) ? {
          totalCopper: Math.max(0, Number(applied.totalCopper) || 0),
          refundCopper: Math.max(0, Number(applied.refundCopper) || 0),
          upfrontCostsCopper: Math.max(0, Number(applied.upfrontCostsCopper) || 0),
          qty: Math.max(0, Number(applied.qty) || 0),
          etaQd: Math.max(0, Number(applied.etaQd) || 0),
          scheduled: Boolean(applied.scheduled),
          serviceLevel: String(applied.serviceLevel ?? ""),
          batchCount: Math.max(0, Number(applied.batchCount) || 0),
          firstDeliveryQd: Math.max(0, Number(applied.firstDeliveryQd) || 0),
          deliveryQd: Math.max(0, Number(applied.deliveryQd) || 0),
          duplicate: Boolean(applied.duplicate || applied.replay)
        } : operation.type === "batchMove" ? {
          moved: Math.max(0, Number(applied.moved) || 0),
          rowType: applied.rowType,
          placements: Array.isArray(applied.placements) ? applied.placements : []
        } : operation.type === "fleetAcceptOffer" ? {
          voyageId: String(applied?.voyage?.id ?? ""),
          duplicate: Boolean(applied.duplicate)
        } : ["fleetTransfer", "fleetCancelTransfer"].includes(operation.type) ? {
          amountCopper: Math.max(0, Number(applied.amountCopper) || 0),
          refundedCopper: Math.max(0, Number(applied.refundedCopper) || 0),
          feeCopper: Math.max(0, Number(applied.feeCopper) || 0),
          pending: Boolean(applied.pending),
          direction: applied.direction,
          duplicate: Boolean(applied.duplicate)
        } : {});
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
    if (operationResults.has(operation.operationId)) return operationResults.get(operation.operationId);
    const pending = executeOnce(operation, context);
    operationResults.set(operation.operationId, pending);
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
