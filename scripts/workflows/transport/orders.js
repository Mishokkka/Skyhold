import { advanceTransportOrders, cancelTransportOrder } from "../../engines/transport/runtime.js";
import { applyMarketOutboundDispatch } from "../../engines/market/outbound.js";
import { restoreMarketStockReservations } from "../../engines/market/stock.js";
import { settleMarketDemandReservations } from "../../engines/market/demand.js";
import { internalDemandBatchClockQd } from "../../core/resource-batches.js";
import { cargoValue } from "../../engines/transport/quantities.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { beginTransportShip, advanceTransportShip, recordTransportShipIncome } from "./ships.js";

function check(result) { if (!result?.ok) throw new Error(result?.message || "Не удалось исполнить рыночную операцию."); return result; }

export function startTransportShip(data, holding, order) {
  if (order.ownShipId) beginTransportShip(data, holding, order);
}

export function cancelTransportShipment(data, holding, order) {
  return cancelTransportOrder({ state: data.meta.transportV2, holding, order, refundCommercial: () => {
    if (order.direction === "inbound") check(restoreMarketStockReservations({ holding, reservations: order.stockReservations,
      operationId: `${order.id}:stock-restore` }));
    else check(settleMarketDemandReservations({ holding, reservations: order.demandReservations, outcome: "restored", operationId: `${order.id}:demand-restore` }));
  } });
}

export function advanceTransportShipments(data, holding, targetQd, workflow, { log = true } = {}) {
  const state = data?.meta?.transportV2;
  const entries = [];
  const cashBefore = holding.storage.moneyCopper;
  const before = new Map((holding.special?.transportV2?.orders ?? []).map((order) => [order.id,
    { spent: order.money.spentCopper, insurance: order.insurancePaidCopper }]));
  const advanceShip = (order) => {
    const result = advanceTransportShip(data, holding, order, targetQd);
    for (const expense of result?.expenses ?? []) {
      for (const [roomId, amount] of [["treasury", expense.treasuryPaidCopper], [`ship:${expense.shipId}`, expense.onboardPaidCopper]]) {
        if (amount) entries.push({ kind: "expense", resourceId: "money", name: "Содержание корабля после перевозки", qty: -amount,
          roomId, source: expense.name, operationId: order.id });
      }
    }
    return result;
  };
  const report = advanceTransportOrders({ state, holding, targetQd, dependencies: {
    dispatchCargo(order, cargo, atQd) {
      const available = cargo.map((lot) => {
        const spoiled = Math.min(lot.qty, order.sourceSpoiledPending?.[lot.lotId] ?? 0);
        if (spoiled) { order.sourceSpoiledPending[lot.lotId] -= spoiled; lot.spoiledQty = spoiled; }
        return { ...lot, qty: lot.qty - spoiled };
      }).filter((lot) => lot.qty > 0);
      const dispatched = check(applyMarketOutboundDispatch({ resources: holding.storage.resources, cargoReservations: available }));
      // Warehouse batches already reflect all completed economy periods. Add only the open interval.
      for (const lot of cargo) {
        const actual = dispatched.cargo.find((row) => row.lotId === lot.lotId);
        if (actual) lot.ageQd = actual.ageQd + Math.max(0, atQd - Number(holding.gm?.calendaria?.lastQd ?? 0));
        lot.ageAtQd = atQd;
        entries.push({ kind: "transport", resourceId: lot.resourceId, name: lot.name, qty: -lot.qty,
          roomId: lot.roomId ?? "outdoors", source: "Отправление груза", operationId: order.id });
      }
    },
    receiveCargo(order, cargo, atQd) {
      if (order.direction === "outbound") {
        const revenue = cargoValue(cargo);
        if (order.commercial.revenueOnBoard) recordTransportShipIncome(holding, order, revenue, atQd);
        else holding.storage.moneyCopper += revenue;
        entries.push({ kind: "transport-sale", resourceId: "money", name: "Продажа доставленного груза", qty: revenue,
          roomId: order.commercial.revenueOnBoard ? `ship:${order.ownShipId}` : "treasury", source: order.commercial.marketLabel, operationId: order.id });
        return;
      }
      for (const lot of cargo) {
        const availableFromQd = internalDemandBatchClockQd(holding);
        if (lot.sourceType === "item") {
          if (!lot.item) throw new Error("В договоре отсутствует сохранённый предмет.");
          holding.storage.items ??= [];
          const item = structuredClone(lot.item);
          const rooms = workflow._storageRooms?.(holding, { includeUnavailable: true });
          const target = order.commercial.targetRoomId;
          const roomId = rooms && !rooms.some((room) => room.id === target && room.available) ? "outdoors" : target;
          if (item.itemData && typeof workflow._setItemQuantityData === "function") item.itemData = workflow._setItemQuantityData(item.itemData, lot.qty);
          holding.storage.items.push({ ...item, id: `transport-item-${stableDataHash([order.id, lot.lotId, lot.deliveryRunId])}`, qty: lot.qty,
            roomId, internalDemandAvailableFromQd: availableFromQd });
          entries.push({ kind: "transport-purchase", resourceId: "custom", name: lot.name, qty: lot.qty,
            roomId, source: order.commercial.marketLabel, operationId: order.id });
        } else {
          const placements = workflow._storageAddWithOverflow(holding, { ...lot, roomId: order.commercial.targetRoomId,
            arrivalShelfLifeQd: lot.shelfLifeQd,
            batches: [{ qty: lot.qty, ageQd: lot.ageQd + Math.max(0, targetQd - atQd), internalDemandAvailableFromQd: availableFromQd }] }, lot.qty);
          for (const placement of placements ?? [{ qty: lot.qty, roomId: order.commercial.targetRoomId }]) {
            if (placement.qty) entries.push({ kind: "transport-purchase", resourceId: lot.resourceId, name: lot.name, qty: placement.qty,
              roomId: placement.roomId, source: order.commercial.marketLabel, operationId: order.id });
            if (placement.spoiledQty) entries.push({ kind: "market-spoilage", resourceId: lot.resourceId, name: lot.name, qty: -placement.spoiledQty,
              roomId: placement.roomId, source: order.commercial.marketLabel, note: "Груз прибыл, но испортился до конца расчётного периода.", operationId: order.id });
          }
          continue;
        }
      }
    },
    completeOrder(order) {
      if (order.ownShipId) advanceShip(order);
      if (order.direction !== "outbound") return;
      const received = new Map();
      for (const lot of order.received) received.set(lot.resourceId, (received.get(lot.resourceId) ?? 0) + lot.qty);
      check(settleMarketDemandReservations({ holding,
        reservations: order.demandReservations.map((row) => ({ ...row, consumedQty: received.get(row.demandId) ?? 0 })),
        outcome: "consumed", operationId: `${order.id}:demand-settle` }));
    }
  } });
  for (const order of holding.special?.transportV2?.orders ?? []) {
    if (order.ownShipId && order.status !== "cancelled") advanceShip(order);
    if (["delivered", "lost"].includes(order.status) && !order.fundingNeededCopper) {
      const refund = Math.max(0, order.money.escrowCopper - order.money.reserveCopper);
      holding.storage.moneyCopper += refund;
      order.money.escrowCopper -= refund; order.money.refundedCopper += refund;
    }
    const previous = before.get(order.id);
    const spent = order.money.spentCopper - (previous?.spent ?? 0), insurance = order.insurancePaidCopper - (previous?.insurance ?? 0);
    if (spent) entries.push({ kind: "expense", resourceId: "money", name: "Исполнение перевозки из резерва", qty: -spent,
      roomId: `transport:${order.id}`, source: "Перевозки", note: "Оплачено из ранее зарезервированных денег; повторного списания из казны нет.", operationId: order.id });
    if (insurance) entries.push({ kind: "transport-insurance", resourceId: "money", name: "Страховая выплата", qty: insurance,
      roomId: "treasury", source: "Перевозки", operationId: order.id });
  }
  const explained = entries.filter((entry) => entry.resourceId === "money" && entry.roomId === "treasury").reduce((sum, entry) => sum + entry.qty, 0);
  const transfer = holding.storage.moneyCopper - cashBefore - explained;
  if (transfer) entries.push({ kind: "transfer", resourceId: "money", name: "Возврат транспортного резерва и бортовых денег", qty: transfer,
    roomId: "treasury", source: "Перевозки", note: "Внутренний перевод, не торговая прибыль." });
  if (log && entries.length) workflow._appendStorageLog(holding, entries);
  report.entries = entries;
  return report;
}
