import { findHoldingIndex } from "./access-guard.js";
import { mergeHoldingDefaults } from "./normalizers.js";
import { assertAvailableEntityId } from "./entity-identity.js";
import { activeTransportOrder, transportOrders } from "./transport/state.js";

export function addHoldingToData(data, holding) {
  if (!Array.isArray(data.holdings)) data.holdings = [];
  assertAvailableEntityId(data.holdings, holding?.id);
  const prepared = mergeHoldingDefaults(holding);
  if (data.meta?.transportV2 && !prepared.special.transportV2) prepared.special.transportV2 = { version: 2, orders: [],
    clockOffsetQd: data.meta.transportV2.clockQd - Number(prepared.gm?.calendaria?.lastQd ?? 0) };
  data.holdings.push(prepared);
}

export function deleteHoldingFromData(data, holdingId) {
  if (!Array.isArray(data.holdings) || data.holdings.length <= 1) {
    throw new Error("FBL Skyhold | Cannot delete the last holding.");
  }

  const holding = data.holdings.find((row) => row.id === holdingId);
  const unfinished = transportOrders(holding).some((order) => activeTransportOrder(order)
    || order.fundingNeededCopper > 0 || (order.ownShipId && order.status !== "cancelled" && !order.shipReleased));
  const transport = data.meta?.transportV2;
  const committedRun = (transport?.runs ?? []).some((run) => run.claims.some((claim) => claim.holdingId === holdingId)
    && (run.status === "booked" || run.incident?.status === "pending" || run.releaseQd > transport.clockQd));
  if (unfinished || committedRun) throw Object.assign(new Error("Сначала завершите перевозки поселения, расчёты и возвращение транспорта либо отмените ещё не начатые заказы."), { code: "transport-obligations" });
  data.holdings = data.holdings.filter((row) => row.id !== holdingId);
}

export async function updateHoldingInData(data, holdingId, updater, { fallback = false, skip = null } = {}) {
  const index = findHoldingIndex(data, holdingId, { fallback });
  if (index < 0) return typeof skip === "function" ? skip(null) : null;
  const holding = data.holdings[index];
  const result = await updater?.(holding, data, index);
  return result === undefined ? { data, holding: data.holdings[index], index } : result;
}
