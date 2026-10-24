import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { marketDemandKey, normalizeMarketDemandState } from "../data/market/demand-state.js";
import {
  overlayMarketQuoteDemand,
  recoverMarketDemand,
  reserveMarketDemand,
  settleMarketDemandReservations
} from "../engines/market/demand.js";

function holding() {
  return {
    gm: { calendaria: { lastQd: 0 } },
    special: { market: { demand: {} } }
  };
}

function line(qty, revision = 0, overrides = {}) {
  return {
    id: "provider-offer",
    offerId: "provider-offer",
    resourceId: "wood",
    demandId: "wood",
    demand: 10,
    demandBaseDemand: 10,
    demandStateRevision: revision,
    qty,
    ...overrides
  };
}

/** Verifies shared demand reservation, atomic multi-order settlement, replay and delayed recovery of consumed demand. */
export function checkMarketDemandCharacterization() {
  const draft = holding();
  const first = reserveMarketDemand({ holding: draft, marketId: "region", lines: [line(4)], operationId: "reserve-a", currentTenday: 0 });
  assert.equal(first.ok, true);
  assert.equal(first.replay, false);
  const key = marketDemandKey("region", "wood");
  assert.equal(draft.special.market.demand[key].availableDemand, 6);
  assert.equal(draft.special.market.demand[key].reservedDemand, 4);
  assert.equal(draft.special.market.demand[key].consumedOutstanding, 0);

  const replay = reserveMarketDemand({ holding: draft, marketId: "region", lines: [line(4)], operationId: "reserve-a", currentTenday: 0 });
  assert.equal(replay.ok, true);
  assert.equal(replay.replay, true);
  assert.equal(draft.special.market.demand[key].availableDemand, 6);

  const noPrematureRecovery = recoverMarketDemand({ holding: draft, currentTenday: 99 });
  assert.equal(noPrematureRecovery.recoveredQty, 0, "reserved demand must not recover while cargo is still travelling");
  assert.equal(draft.special.market.demand[key].availableDemand, 6);

  const consumed = settleMarketDemandReservations({
    holding: draft,
    reservations: first.reservations,
    outcome: "consumed",
    operationId: "delivered-a",
    currentTenday: 100
  });
  assert.equal(consumed.ok, true);
  assert.equal(draft.special.market.demand[key].reservedDemand, 0);
  assert.equal(draft.special.market.demand[key].consumedOutstanding, 4);
  assert.equal(draft.special.market.demand[key].availableDemand, 6);

  const sameBoundary = recoverMarketDemand({ holding: draft, currentTenday: 100 });
  assert.equal(sameBoundary.recoveredQty, 0, "delivery and recovery at the same tenday boundary must not restore demand immediately");
  assert.equal(draft.special.market.demand[key].consumedOutstanding, 4);

  const duration = draft.special.market.demand[key].recoveryDurationTendays;
  recoverMarketDemand({ holding: draft, currentTenday: 100 + duration });
  assert.equal(draft.special.market.demand[key].consumedOutstanding, 0);
  assert.equal(draft.special.market.demand[key].availableDemand, 10, "consumed demand must recover fully inside its deterministic 2-6 tenday cycle");

  const restoredDraft = holding();
  const reserved = reserveMarketDemand({ holding: restoredDraft, marketId: "region", lines: [line(3)], operationId: "reserve-b", currentTenday: 0 });
  const restored = settleMarketDemandReservations({
    holding: restoredDraft,
    reservations: reserved.reservations,
    outcome: "restored",
    operationId: "cancel-b",
    currentTenday: 1
  });
  assert.equal(restored.ok, true);
  assert.equal(restoredDraft.special.market.demand[key].availableDemand, 10, "cancel or GM-confirmed loss must restore buyer demand immediately");
  const restoreReplay = settleMarketDemandReservations({
    holding: restoredDraft,
    reservations: reserved.reservations,
    outcome: "restored",
    operationId: "cancel-b",
    currentTenday: 1
  });
  assert.equal(restoreReplay.replay, true);
  assert.equal(restoredDraft.special.market.demand[key].availableDemand, 10);

  const shared = holding();
  const sharedReservation = reserveMarketDemand({
    holding: shared,
    marketId: "region",
    lines: [
      line(2, 0, { id: "merchant-a", offerId: "merchant-a" }),
      line(3, 0, { id: "merchant-b", offerId: "merchant-b" })
    ],
    operationId: "shared"
  });
  assert.equal(sharedReservation.ok, true);
  assert.equal(shared.special.market.demand[key].availableDemand, 5, "organization identities must share one resource demand pool");

  const quote = overlayMarketQuoteDemand({
    holding: shared,
    quote: { marketId: "region", offers: [{ id: "third-provider", resourceId: "wood", demand: 10 }] }
  });
  assert.equal(quote.offers[0].demand, 5);
  assert.equal(quote.offers[0].demandId, "wood");

  const stale = reserveMarketDemand({ holding: shared, marketId: "region", lines: [line(1, 0)], operationId: "stale" });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);

  const normalized = normalizeMarketDemandState({ entries: shared.special.market.demand });
  assert.equal(normalized[key].availableDemand, 5);
  assert.equal(normalized[key].reservedDemand, 5);

  for (const outcome of ["consumed", "restored"]) {
    const combinedDraft = holding();
    const a = reserveMarketDemand({ holding: combinedDraft, marketId: "region", lines: [line(3)], operationId: "order-a" });
    const b = reserveMarketDemand({ holding: combinedDraft, marketId: "region", lines: [line(4, 1)], operationId: "order-b" });
    const reservations = [...a.reservations, ...b.reservations];
    const beforeSettlement = structuredClone(combinedDraft);
    const invalid = settleMarketDemandReservations({ holding: combinedDraft, reservations: [
      ...a.reservations, { ...b.reservations[0], qty: 5 }
    ], outcome, operationId: `invalid-${outcome}` });
    assert.equal(invalid.ok, false);
    assert.deepEqual(combinedDraft, beforeSettlement, "all reservations must validate before any settlement is written");

    const settlement = settleMarketDemandReservations({ holding: combinedDraft, reservations, outcome, operationId: `combined-${outcome}` });
    assert.equal(settlement.ok, true);
    assert.equal(settlement.qty, 7);
    const state = combinedDraft.special.market.demand[key];
    assert.deepEqual(state.reservations, {}, "settling several orders in one resource pool must release every reservation");
    assert.equal(state.reservedDemand, 0);
    assert.equal(state.consumedOutstanding, outcome === "consumed" ? 7 : 0);
    assert.equal(state.availableDemand, outcome === "consumed" ? 3 : 10);
    const afterSettlement = structuredClone(combinedDraft);
    const repeated = settleMarketDemandReservations({ holding: combinedDraft, reservations, outcome, operationId: `combined-${outcome}` });
    assert.equal(repeated.replay, true);
    assert.deepEqual(combinedDraft, afterSettlement, "replaying a combined settlement must not change demand");
  }

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkMarketDemandCharacterization();
  console.log("FBL Skyhold market demand: shared reservation, delivery consumption, cancel/loss restore, no in-transit recovery and 2-6 tenday recovery passed.");
}
