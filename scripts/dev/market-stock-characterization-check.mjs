import assert from "node:assert/strict";
import { transportFixture, transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";
import { transportSourceToken } from "../apps/domains/transport-context.js";
import { canCancelTransportOrder } from "../engines/transport/runtime.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { marketStockKey, marketStockRecoveryEvery, normalizeMarketStockState } from "../data/market/stock-state.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import {
  marketStockPlanToken,
  overlayMarketQuoteStock,
  recoverMarketStock,
  reserveMarketStock,
  restoreMarketStockReservations
} from "../engines/market/stock.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function stockHolding({ moneyCopper = 0 } = {}) {
  return {
    gm: { calendaria: { lastQd: 0 } },
    storage: { moneyCopper, resources: [], items: [], log: [] },
    special: { market: { orders: [], stock: {} } }
  };
}

const marketId = "north-market";
const offerId = "wood-offer";
const key = marketStockKey(marketId, offerId);
const holding = stockHolding();
const rawQuote = {
  marketId,
  offers: [{ id: "merchant-a:wood", sourceOfferId: offerId, resourceId: "wood", stock: 10.9, unitPriceCopper: 3, load: 0.25 }]
};
const beforeOverlay = clone(holding);
const firstQuote = overlayMarketQuoteStock({ holding, quote: rawQuote });

assert.deepEqual(holding, beforeOverlay, "stock overlay must be a read-only quote operation");
assert.equal(firstQuote.offers[0].stock, 10, "quoted stock must floor positive fractional units");
assert.equal(firstQuote.offers[0].stockBaseStock, 10, "base stock must use the same whole-unit policy");
assert.equal(firstQuote.offers[0].stockStateRevision, 0);

const firstReservation = reserveMarketStock({
  holding,
  marketId,
  lines: [{ ...firstQuote.offers[0], qty: 4.9 }],
  operationId: "reserve-1",
  currentTenday: 0,
  updatedAt: "reserve-1"
});
assert.equal(firstReservation.ok, true);
assert.equal(firstReservation.reservations[0].qty, 4, "reservation quantity must floor instead of creating a unit");
assert.equal(holding.special.market.stock[key].availableStock, 6);
assert.equal(holding.special.market.stock[key].baseStock, 10);
assert.equal(holding.special.market.stock[key].revision, 1);

const afterFirstReservation = clone(holding.special.market.stock);
const reservationReplay = reserveMarketStock({
  holding,
  marketId,
  lines: [{ ...firstQuote.offers[0], qty: 4.9 }],
  operationId: "reserve-1",
  currentTenday: 0
});
assert.equal(reservationReplay.replay, true, "same reservation operation must be an idempotent replay");
assert.deepEqual(holding.special.market.stock, afterFirstReservation, "reservation replay must not reduce stock again");

const staleReservation = reserveMarketStock({
  holding,
  marketId,
  lines: [{ ...firstQuote.offers[0], qty: 1 }],
  operationId: "reserve-stale",
  currentTenday: 0
});
assert.equal(staleReservation.stale, true, "a reservation built from an old stock revision must be rejected");
assert.deepEqual(holding.special.market.stock, afterFirstReservation);

const freshQuote = overlayMarketQuoteStock({ holding, quote: rawQuote });
assert.equal(freshQuote.offers[0].stock, 6, "a later quote must expose persisted availability");
assert.equal(freshQuote.offers[0].stockStateRevision, 1);
assert.equal(
  marketStockPlanToken([{ ...freshQuote.offers[0], qty: 1 }, { ...freshQuote.offers[0], id: "merchant-b:wood", qty: 2 }]),
  marketStockPlanToken([{ ...freshQuote.offers[0], qty: 3 }]),
  "merchant identities must share one stock revision token"
);

const restored = restoreMarketStockReservations({
  holding,
  reservations: firstReservation.reservations,
  operationId: "reserve-1:cancel",
  currentTenday: 0,
  updatedAt: "cancel-1"
});
assert.equal(restored.ok, true);
assert.equal(restored.restoredQty, 4);
assert.equal(holding.special.market.stock[key].availableStock, 10);
const afterRestore = clone(holding.special.market.stock);
const restoreReplay = restoreMarketStockReservations({
  holding,
  reservations: firstReservation.reservations,
  operationId: "reserve-1:cancel",
  currentTenday: 0
});
assert.equal(restoreReplay.replay, true, "same restoration operation must be an idempotent replay");
assert.deepEqual(holding.special.market.stock, afterRestore, "restoration replay must not add stock twice");

const normalized = normalizeMarketStockState({
  ignoredDictionaryKey: {
    marketId,
    offerId,
    availableStock: 4.9,
    baseStock: 9.9,
    lastRecoveryTenday: 2.9,
    recoveryEveryTendays: 4.9,
    revision: 3.9
  }
});
assert.equal(normalized[key].availableStock, 4);
assert.equal(normalized[key].baseStock, 9);
assert.equal(normalized[key].lastRecoveryTenday, 2);
assert.equal(normalized[key].recoveryDurationTendays, 4, "legacy interval field must normalize to the canonical full-cycle duration");
assert.equal(normalized[key].revision, 3);
const persistedHolding = mergeHoldingDefaults({ id: "stock-persistence", special: { market: { stock: normalized } } });
assert.deepEqual(persistedHolding.special.market.stock[key], normalized[key], "persistent stock state must survive holding normalization");

const recoveryHolding = stockHolding();
const recoveryQuote = overlayMarketQuoteStock({
  holding: recoveryHolding,
  quote: { marketId, offers: [{ id: offerId, stock: 20, unitPriceCopper: 1, load: 0.25 }] }
});
reserveMarketStock({
  holding: recoveryHolding,
  marketId,
  lines: [{ ...recoveryQuote.offers[0], qty: 10 }],
  operationId: "recovery-reservation",
  currentTenday: 0
});
const interval = marketStockRecoveryEvery(marketId, offerId);
assert.ok(interval >= 2 && interval <= 6, "stock recovery duration must stay inside the 2-6 tenday contract");
const beforeRecovery = clone(recoveryHolding);
const recoveryTwin = clone(beforeRecovery);
const firstRecovery = recoverMarketStock({ holding: recoveryHolding, currentTenday: 1, updatedAt: "recovery-step" });
const twinRecovery = recoverMarketStock({ holding: recoveryTwin, currentTenday: 1, updatedAt: "recovery-step" });
assert.ok(firstRecovery.recoveredQty > 0, "multi-unit stock should recover progressively during its cycle");
assert.ok(recoveryHolding.special.market.stock[key].availableStock < 20, "stock must not finish recovery before its duration");
assert.deepEqual(firstRecovery, twinRecovery, "same stock key and tenday must recover deterministically");
assert.deepEqual(recoveryHolding.special.market.stock, recoveryTwin.special.market.stock);
const recoveredAvailability = recoveryHolding.special.market.stock[key].availableStock;
recoverMarketStock({ holding: recoveryHolding, currentTenday: 1, updatedAt: "same-tenday-replay" });
assert.equal(recoveryHolding.special.market.stock[key].availableStock, recoveredAvailability, "same tenday must not recover twice");
recoverMarketStock({ holding: recoveryHolding, currentTenday: interval, updatedAt: "recovery-cap" });
assert.equal(recoveryHolding.special.market.stock[key].availableStock, 20, "stock must fully recover by its deterministic 2-6 tenday duration");
recoverMarketStock({ holding: recoveryHolding, currentTenday: interval * 100, updatedAt: "recovery-late" });
assert.equal(recoveryHolding.special.market.stock[key].availableStock, 20, "recovery must stay capped at base stock");

const rareOfferId = "single-rare-offer";
const rareKey = marketStockKey(marketId, rareOfferId);
const rareHolding = stockHolding();
const rareQuote = overlayMarketQuoteStock({
  holding: rareHolding,
  quote: { marketId, offers: [{ id: rareOfferId, stock: 1, unitPriceCopper: 100, load: 0.25 }] }
});
reserveMarketStock({ holding: rareHolding, marketId, lines: [{ ...rareQuote.offers[0], qty: 1 }], operationId: "rare-reservation", currentTenday: 0 });
const rareDuration = marketStockRecoveryEvery(marketId, rareOfferId);
recoverMarketStock({ holding: rareHolding, currentTenday: rareDuration - 1 });
assert.equal(rareHolding.special.market.stock[rareKey].availableStock, 0, "an indivisible rare unit must not appear before its recovery duration");
recoverMarketStock({ holding: rareHolding, currentTenday: rareDuration });
assert.equal(rareHolding.special.market.stock[rareKey].availableStock, 1, "an indivisible rare unit must return at the end of its 2-6 tenday cycle");

// Stock cancellation is exercised through the current authority command, never a copied old executor.
{
  const previousGame = globalThis.game;
  try {
    globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => undefined }, modules: new Map() };
    const f = transportFixture(); f.holding.special.ships.list = [];
    const h = transportHarness(f), request = transportRequest({ ...f, data: h.data, holding: h.holding });
    const money = h.holding.storage.moneyCopper;
    const { preview, order } = await h.book(request, "current-stocked-purchase");
    assert.equal(h.holding.storage.moneyCopper, money - preview.treasuryCopper);
    assert.ok(order.stockReservations.length);
    for (const row of order.stockReservations) assert.equal(h.holding.special.market.stock[marketStockKey(row.marketId, row.offerId)].availableStock,
      row.baseStock - row.qty, "the actual booking reserves its precise quantity");
    assert.equal(canCancelTransportOrder(h.data.meta.transportV2, order), true);
    const cancel = { type: "transport-cancel", operationId: "current-stock-cancel", holdingId: h.holding.id,
      orderId: order.id, expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding) };
    assert.equal((await h.execute(cancel, { userId: "gm" })).ok, true);
    assert.equal(h.holding.storage.moneyCopper, money, "pre-dispatch cancellation refunds the entire accepted payment");
    for (const row of order.stockReservations) assert.equal(h.holding.special.market.stock[marketStockKey(row.marketId, row.offerId)].availableStock,
      row.baseStock, "the actual cancellation restores every reserved unit");
    const after = structuredClone(h.data);
    assert.equal((await h.execute(cancel, { userId: "gm" })).replay, true);
    assert.deepEqual(h.data, after, "replay cannot restore money or stock twice");
    const next = transportRequest({ ...f, data: h.data, holding: h.holding });
    const { order: rebooked } = await h.book(next, "current-stocked-purchase-again");
    assert.deepEqual(rebooked.stockReservations.map(row => [row.marketId, row.offerId, row.qty]),
      order.stockReservations.map(row => [row.marketId, row.offerId, row.qty]),
      "the authority can actually reserve the restored stock for the same purchase again");
  } finally { globalThis.game = previousGame; }
}

const marketAppSource = readFileSync(fileURLToPath(new URL("../apps/market-app.js", import.meta.url)), "utf8");
const marketOperationExecutorSource = readFileSync(fileURLToPath(new URL("../apps/market-operation-executor.js", import.meta.url)), "utf8");
const buySource = marketAppSource.slice(marketAppSource.indexOf("async _onBuy()"));
const transportExecutor = readFileSync(new URL("../apps/transport-operation-executor.js", import.meta.url), "utf8");
const transportApp = readFileSync(new URL("../apps/transport-app.js", import.meta.url), "utf8");
assert.ok(buySource.includes("holdingPermissionContext(snapshot.holding).canUseStorage"), "market purchase UI must use the granted storage/market permission for players and GMs");
assert.doesNotMatch(marketAppSource, /_onCancelShipment|_onDeliverShipment/, "retired shipment mutations are removed from the goods browser");
assert.match(transportExecutor, /!user\.isGM && !holding\.gm\?\.playersCanUseStorage/, "transport cancellation retains the granted storage permission");
assert.match(transportApp, /requestMarketOperation\(/, "transport UI uses the dedicated authority-GM command");
assert.match(marketOperationExecutorSource, /if \(replay\) return replay/, "the old command adapter only acknowledges durable receipts");
assert.ok(transportExecutor.indexOf("return transaction(") < transportExecutor.indexOf("cancelTransportShipment(data, holding, order)"), "stock restoration must happen inside the authority transaction");
const economyEventsSource = readFileSync(fileURLToPath(new URL("../apps/domains/events/economy-events.js", import.meta.url)), "utf8");
const prepareTendayStart = economyEventsSource.indexOf("async _prepareTendayOperation");
const applyTendayStart = economyEventsSource.indexOf("async _applyPreparedTendayOperation", prepareTendayStart);
const recoverySource = economyEventsSource.slice(prepareTendayStart, applyTendayStart);
const applyTendaySource = economyEventsSource.slice(applyTendayStart, economyEventsSource.indexOf("_advanceResidentRecovery", applyTendayStart));
assert.match(recoverySource, /if \(!game\.user\?\.isGM\)/, "market recovery preview must be prepared only by a GM");
assert.ok(recoverySource.includes("recoverMarketStock({"), "tenday preview must include deterministic market recovery");
assert.match(applyTendaySource, /if \(!game\.user\?\.isGM\)/, "market recovery apply must reject a non-GM caller");
assert.ok(applyTendaySource.includes("SkyholdData.updateHolding"), "prepared market recovery must commit through the authority transaction");

console.log("Market stock characterization checks passed.");
