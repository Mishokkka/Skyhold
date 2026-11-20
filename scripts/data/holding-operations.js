import { findHoldingIndex } from "./access-guard.js";
import { mergeHoldingDefaults } from "./normalizers.js";
import { assertAvailableEntityId } from "./entity-identity.js";
import { legacyActiveMarketOrders, pruneCompletedTransportRuns, transportOrderHasObligations, transportOrders } from "./transport/state.js";

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
  if (legacyActiveMarketOrders(holding).length) {
    throw Object.assign(new Error("Перед удалением сверите незавершённые заказы прежней версии в окне «Перевозки»."), { code: "transport-obligations" });
  }
  const unfinished = transportOrders(holding).some(transportOrderHasObligations);
  const transport = data.meta?.transportV2;
  const committedRun = (transport?.runs ?? []).some((run) => run.claims.some((claim) => claim.holdingId === holdingId)
    && (run.status === "booked" || run.incident?.status === "pending" || run.releaseQd > transport.clockQd));
  if (unfinished || committedRun) throw Object.assign(new Error("Сначала завершите перевозки поселения, расчёты и возвращение транспорта либо отмените ещё не начатые заказы."), { code: "transport-obligations" });
  // Detach known completed owners, retaining used capacity until the safe
  // pruning boundary: a lagging replan can still inspect this past departure.
  // Unknown references retain the recovery guard in pruneCompletedTransportRuns.
  const completedIds = new Set(transportOrders(holding).map(order => order.id));
  for (const run of transport?.runs ?? []) {
    run.claims = run.claims.filter(claim => {
      if (claim.holdingId !== holdingId || !completedIds.has(claim.orderId)) return true;
      return false;
    });
  }
  data.holdings = data.holdings.filter((row) => row.id !== holdingId);
  pruneCompletedTransportRuns(data);
}

export async function updateHoldingInData(data, holdingId, updater, { fallback = false, skip = null } = {}) {
  const index = findHoldingIndex(data, holdingId, { fallback });
  if (index < 0) return typeof skip === "function" ? skip(null) : null;
  const holding = data.holdings[index];
  const result = await updater?.(holding, data, index);
  return result === undefined ? { data, holding: data.holdings[index], index } : result;
}
