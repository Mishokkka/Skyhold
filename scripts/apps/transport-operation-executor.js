import { SkyholdData } from "../data/store.js";
import { COMMIT_SCOPES } from "../data/commit-preparation.js";
import { canReadHolding } from "../data/access-guard.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { ensureTransportState } from "../data/transport/state.js";
import { prepareTransportContext, transportSourceToken } from "./domains/transport-context.js";
import { validateTransportConfiguration } from "../engines/transport/services.js";
import { bookTransportOrder, resolveTransportIncident } from "../engines/transport/runtime.js";
import { advanceTransportShipments, cancelTransportShipment, startTransportShip } from "../workflows/transport/orders.js";
import { reserveMarketStock } from "../engines/market/stock.js";
import { reserveMarketDemand } from "../engines/market/demand.js";
import { resolveMarketItemDocuments } from "./market-operation-executor.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { advanceWorldShips } from "../engines/ships/world-voyage.js";

const fail = (message, code = "invalid") => Object.assign(new Error(message), { code });
const types = new Set(["transport-book", "transport-cancel", "transport-advance", "transport-incident", "transport-configure", "transport-ship-sync", "transport-fund"]);
export function createTransportOperationExecutor({ transaction = (updater, options) => SkyholdData.transaction(updater, { ...options, scope: COMMIT_SCOPES.BOTH }),
  getUser = (id) => globalThis.game?.users?.get?.(id) ?? (globalThis.game?.user?.id === id ? globalThis.game.user : null),
  workflow = () => getSkyholdWorkflowService(), resolveItems = resolveMarketItemDocuments } = {}) {
  return async (raw, { userId = "", remote = false } = {}) => {
    const op = structuredClone(raw ?? {}), user = getUser(userId);
    if (!types.has(op.type) || !/^[a-zA-Z0-9:_-]{6,160}$/.test(op.operationId ?? "") || !op.holdingId
      || !Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 0 || typeof op.sourceToken !== "string") throw fail("Некорректная транспортная команда.");
    if (!user || remote && user.isGM) throw fail("Не удалось подтвердить пользователя.", "forbidden");
    const signature = JSON.stringify(op);
    return transaction(async (data, { skip }) => {
      const holding = data.holdings.find((row) => row.id === op.holdingId);
      if (!holding || !canReadHolding(holding, user) || !user.isGM && !holding.gm?.playersCanUseStorage) throw fail("Нет доступа к перевозкам поселения.", "forbidden");
      const previous = findHoldingOperation(holding, op.operationId);
      if (previous) {
        if (previous.type !== "transport-v2" || previous.payload.signature !== signature || previous.payload.userId !== userId) throw fail("Идентификатор уже использован другой командой.", "conflict");
        return skip({ ...previous.payload.result, replay: true });
      }
      if (op.expectedRevision !== data.meta.revision || op.sourceToken !== transportSourceToken(data, holding)) throw fail("Данные изменились. Обновите расчёт перевозки.", "conflict");
      const gmOnly = ["transport-configure", "transport-advance", "transport-incident", "transport-ship-sync"].includes(op.type);
      if (gmOnly && !user.isGM) throw fail("Эта операция доступна ГМ.", "forbidden");
      let result = { ok: true, operationId: op.operationId };
      ensureTransportState(data);
      if (op.type === "transport-configure") {
        const config = validateTransportConfiguration(op.configuration);
        data.catalog.transportV2 = config;
      } else {
        data.meta.transportV2.clockQd = Math.max(data.meta.transportV2.clockQd, Number(holding.gm?.calendaria?.lastQd ?? 0));
        const engine = workflow();
        if (op.type === "transport-book") {
          if (op.request?.ownShipId && !user.isGM && !holding.gm?.playersCanManageShips) throw fail("Нет права управлять кораблём.", "forbidden");
          const context = prepareTransportContext({ data, holding, request: op.request, isGM: user.isGM });
          if (context.planToken !== op.planToken) throw fail("План изменился. Подтвердите новый расчёт.", "conflict");
          const documents = await resolveItems(context.lines);
          for (const lot of context.plan.cargo) if (lot.sourceType === "item") {
            lot.item = engine._snapshotItemForStorage(documents.get(lot.id), lot.qty, context.commercial.targetRoomId);
            if (lot.configuredName) lot.item.name = lot.configuredName;
            if (lot.configuredImg) lot.item.img = lot.configuredImg;
          }
          // Runtime cargo snapshots are added after the authoritative price comparison, then included in every stage.
          for (const stage of context.plan.stages) for (const run of stage.runs) for (const lot of run.cargo) {
            const item = context.plan.cargo.find((row) => row.lotId === lot.lotId)?.item;
            if (item) lot.item = structuredClone(item);
          }
          const reserve = op.request.direction === "outbound" ? reserveMarketDemand : reserveMarketStock;
          const stock = reserve({ holding, marketId: context.commercial.marketId, lines: context.lines, operationId: `${op.operationId}:market` });
          if (!stock.ok) throw fail(stock.message || "Запасы или спрос рынка изменились.", "conflict");
          const order = bookTransportOrder({ state: data.meta.transportV2, holding, plan: context.plan, services: context.services,
            id: op.operationId, direction: op.request.direction === "outbound" ? "outbound" : "inbound", commercial: context.commercial, ship: context.ship });
          if (order.direction === "outbound") order.demandReservations = stock.reservations;
          else order.stockReservations = stock.reservations;
          startTransportShip(data, holding, order);
          engine._appendStorageLog(holding, [
            { kind: "market-purchase", resourceId: "money", name: "Товар, пошлины и страхование", qty: -order.money.commercialSpentCopper,
              roomId: "treasury", source: order.commercial.marketLabel, operationId: order.id },
            { kind: "transfer", resourceId: "money", name: "Деньги зарезервированы для перевозки", qty: -(order.money.treasuryCopper - order.money.commercialSpentCopper),
              roomId: "treasury", source: "Перевозки", note: "Внутренний перевод в защищённый резерв; это ещё не расход.", operationId: order.id }
          ].filter((entry) => entry.qty));
          result.orderId = order.id;
        } else if (op.type === "transport-fund") {
          const order = holding.special?.transportV2?.orders?.find((row) => row.id === op.orderId);
          if (!order?.fundingNeededCopper || !order.ownShipId) throw fail("Заказ не требует пополнения.");
          if (!user.isGM && !holding.gm?.playersCanManageShips) throw fail("Нет права управлять кораблём.", "forbidden");
          const amount = order.fundingNeededCopper;
          if (amount > holding.storage.moneyCopper) throw fail(`Для продолжения нужно ${amount} ММ в казне.`);
          holding.storage.moneyCopper -= amount;
          order.money.escrowCopper += amount; order.money.reserveCopper += amount; order.money.treasuryCopper += amount;
          engine._appendStorageLog(holding, [{ kind: "transfer", resourceId: "money", name: "Пополнение транспортного резерва", qty: -amount,
            roomId: "treasury", source: "Перевозки", note: "Внутренний перевод для оплаты дополнительных расходов.", operationId: op.operationId }]);
        } else if (op.type === "transport-cancel") {
          const order = holding.special?.transportV2?.orders?.find((row) => row.id === op.orderId);
          if (!order) throw fail("Заказ не найден.");
          if (order.ownShipId && !user.isGM && !holding.gm?.playersCanManageShips) throw fail("Нет права управлять кораблём.", "forbidden");
          cancelTransportShipment(data, holding, order);
          engine._appendStorageLog(holding, [{ kind: "transfer", resourceId: "money", name: "Возврат денег отменённого заказа", qty: order.money.treasuryCopper,
            roomId: "treasury", source: "Перевозки", note: "Возврат платежа и резерва, не торговая прибыль.", operationId: op.operationId }]);
        } else if (op.type === "transport-incident") {
          resolveTransportIncident(data.meta.transportV2, op.runId, { ...op.resolution, atQd: data.meta.transportV2.clockQd });
        } else if (op.type === "transport-ship-sync") {
          const ship = holding.special?.ships?.list?.find((row) => row.id === op.shipId);
          if (!ship || ship.activeVoyage || ship.orderBundle || ship.transportOrderId) throw fail("Сначала завершите текущий рейс корабля.");
          const advanced = advanceWorldShips(holding, Number(holding.gm?.calendaria?.lastQd ?? 0), { shipId: ship.id });
          if (advanced.blocked.length) throw fail(advanced.blocked.map((row) => row.message).join(" "));
        }
        if (op.type !== "transport-ship-sync") advanceTransportShipments(data, holding, Number(holding.gm?.calendaria?.lastQd ?? 0), engine);
      }
      appendHoldingOperation(holding, { type: "transport-v2", operationId: op.operationId, createdAt: new Date().toISOString(),
        title: "Перевозка", payload: { signature, userId, result } });
      return result;
    }, { reason: op.type });
  };
}
export const executeTransportOperation = createTransportOperationExecutor();
