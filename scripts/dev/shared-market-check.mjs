import assert from "node:assert/strict";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { bindSharedMarkets, bindSharedMarketHolding, marketStateFor } from "../data/market/shared-context.js";
import { reserveMarketStock, recoverMarketStock } from "../engines/market/stock.js";
import { reserveMarketDemand, settleMarketDemandReservations, recoverMarketDemand } from "../engines/market/demand.js";
import { marketStockKey } from "../data/market/stock-state.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { pathToFileURL } from "node:url";
export function checkSharedMarkets() {
const holding = (id) => ({ id, gm: { calendaria: { lastQd: 0 } }, special: { market: {} } });
{
  const data = bindSharedMarkets({ meta: structuredClone(DEFAULT_SKYHOLD_DATA.meta), catalog: {}, holdings: [holding("a"), holding("b")] });
  assert.equal(data.meta.sharedMarkets.enabled, true, "shared markets are enabled by default");
  const [a, b] = data.holdings;
  const lines = [{ id: "wood", qty: 7, stockBaseStock: 10, stockStateRevision: 0 }];
  assert.equal(reserveMarketStock({ holding: a, marketId: "port", operationId: "a-buy", lines }).ok, true);
  assert.equal(reserveMarketStock({ holding: b, marketId: "port", operationId: "b-buy", lines }).stale, true);
  const key = marketStockKey("port", "wood");
  assert.equal(marketStateFor(b, "stock")[key].availableStock, 3);
  a.gm.calendaria.lastQd = 40;
  recoverMarketStock({ holding: a, currentTenday: 1 });
  const once = JSON.stringify(data.meta.sharedMarkets.stock);
  b.gm.calendaria.lastQd = 40;
  recoverMarketStock({ holding: b, currentTenday: 1 });
  assert.equal(JSON.stringify(data.meta.sharedMarkets.stock), once, "two holdings at the same date cannot recover twice");
  const draftState = structuredClone(data.meta.sharedMarkets), draftHolding = structuredClone(a);
  bindSharedMarketHolding(draftHolding, draftState);
  recoverMarketStock({ holding: draftHolding, currentTenday: 2 });
  assert.equal(JSON.stringify(data.meta.sharedMarkets.stock), once, "tenday preview has an isolated shared-state draft");
  const reloaded = bindSharedMarkets(normalizeSkyholdData(JSON.parse(JSON.stringify(data))));
  assert.deepEqual(marketStateFor(reloaded.holdings[1], "stock"), data.meta.sharedMarkets.stock);
}
{
  const data = bindSharedMarkets({ meta: {}, catalog: {}, holdings: [holding("a"), holding("b")] });
  const [a, b] = data.holdings;
  const key = marketDemandKey("port", "wood");
  const reserve = (target, id, qty) => reserveMarketDemand({ holding: target, marketId: "port", operationId: id,
    lines: [{ demandId: "wood", qty, demandBaseDemand: 10, demandStateRevision: marketStateFor(target, "demand")?.[key]?.revision ?? 0 }] });
  const ra = reserve(a, "a-sale", 3), rb = reserve(b, "b-sale", 4);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.equal(marketStateFor(a, "demand")[key].reservedDemand, 7);
  assert.equal(marketStateFor(b, "demand")[key].availableDemand, 3);
  settleMarketDemandReservations({ holding: a, reservations: ra.reservations, operationId: "a-arrive", outcome: "consumed" });
  settleMarketDemandReservations({ holding: b, reservations: rb.reservations, operationId: "b-cancel", outcome: "restored" });
  assert.equal(data.meta.sharedMarkets.demand[key].consumedOutstanding, 3);
  assert.equal(data.meta.sharedMarkets.demand[key].availableDemand, 7);
  recoverMarketDemand({ holding: a, currentTenday: 1 });
  const once = JSON.stringify(data.meta.sharedMarkets.demand);
  recoverMarketDemand({ holding: b, currentTenday: 1 });
  assert.equal(JSON.stringify(data.meta.sharedMarkets.demand), once);
}
{
  const data = bindSharedMarkets({ meta: {}, holdings: [holding("a"), holding("b")] });
  const [a, b] = data.holdings;
  assert.equal(reserveMarketDemand({ holding: a, marketId: "port", operationId: a.id,
    lines: [{ demandId: "wood", qty: 8, demandBaseDemand: 10, demandStateRevision: 0 }] }).ok, true);
  assert.equal(reserveMarketDemand({ holding: b, marketId: "port", operationId: b.id,
    lines: [{ demandId: "wood", qty: 8, demandBaseDemand: 10, demandStateRevision: 0 }] }).stale, true,
    "shared demand prevents exceeding common capacity across holdings");
}
{
  const data = { meta: {}, holdings: [holding("dated")] };
  data.holdings[0].gm.calendaria.lastDateTime = { year: 2, month: 1, day: 1 };
  bindSharedMarkets(data);
  const first = data.meta.sharedMarkets.clockTenday;
  reserveMarketStock({ holding: data.holdings[0], marketId: "port", operationId: "dated-buy",
    lines: [{ id: "wood", qty: 1, stockBaseStock: 10, stockStateRevision: 0 }] });
  assert.equal(data.meta.sharedMarkets.clockTenday, first, "absolute calendar time must not be added twice");
}
{
  const data = { meta: {}, holdings: [holding("a"), holding("b")] };
  for (const h of data.holdings) h.gm.calendaria.lastDateTime = { year: 2, month: 1, day: 1 };
  bindSharedMarkets(data);
  const reserved = reserveMarketDemand({ holding: data.holdings[0], marketId: "port", operationId: "runtime-sale",
    lines: [{ demandId: "wood", qty: 10, demandBaseDemand: 10, demandStateRevision: 0 }] });
  settleMarketDemandReservations({ holding: data.holdings[0], reservations: reserved.reservations, outcome: "consumed", operationId: "runtime-arrive" });
  const clock = data.meta.sharedMarkets.clockTenday;
  for (const h of data.holdings) h.storage = { moneyCopper: 0 };
  const app = { _appendStorageLog() {} };
  advanceTransportShipments(data, data.holdings[0], 40, app);
  const once = data.meta.sharedMarkets.clockTenday;
  assert.equal(once, clock + 1, "runtime advances one period in absolute game time");
  advanceTransportShipments(data, data.holdings[1], 40, app);
  assert.equal(data.meta.sharedMarkets.clockTenday, once, "second holding at the same date cannot double global time");
}
const v72BaseMeta = (extra = {}) => ({
  schemaVersion: DEFAULT_SKYHOLD_DATA.meta.schemaVersion,
  templateCatalogVersion: DEFAULT_SKYHOLD_DATA.meta.templateCatalogVersion,
  revision: 1,
  ...extra
});
{
  const saved = {
    meta: v72BaseMeta(),
    catalog: structuredClone(DEFAULT_SKYHOLD_DATA.catalog),
    holdings: [{ ...structuredClone(DEFAULT_SKYHOLD_DATA.holdings[0]), gm: { calendaria: { lastQd: 400 } } }]
  };
  const bound = bindSharedMarkets(structuredClone(saved));
  const normalized = normalizeSkyholdData(structuredClone(saved));
  assert.equal(normalized.meta.sharedMarkets.clockTenday, bound.meta.sharedMarkets.clockTenday);
  assert.equal(normalized.meta.sharedMarkets.clockTenday, 10, "missing sharedMarkets initializes clock from holding lastQd");
  for (const scope of ["holdings", "both"]) {
    const committed = prepareSkyholdCommit(structuredClone(saved), { scope }).data;
    assert.equal(committed.meta.sharedMarkets.clockTenday, 10, `${scope} commit initializes clock from holding lastQd`);
  }

  const explicitZero = normalizeSkyholdData({
    ...structuredClone(saved),
    meta: v72BaseMeta({ sharedMarkets: { enabled: true, version: 1, clockTenday: 0, demand: {}, stock: {} } })
  });
  assert.equal(explicitZero.meta.sharedMarkets.clockTenday, 0, "explicit enabled sharedMarkets keeps clockTenday: 0");

  const disabled = normalizeSkyholdData({
    ...structuredClone(saved),
    meta: v72BaseMeta({ sharedMarkets: { enabled: false, version: 1, clockTenday: 0, demand: {}, stock: {} } })
  });
  assert.equal(disabled.meta.sharedMarkets.enabled, true);
  assert.equal(disabled.meta.sharedMarkets.clockTenday, 10, "disabled sharedMarkets advances clock to match holding date");
}
{
  const stockKey = marketStockKey("port", "wood");
  const demandKey = marketDemandKey("port", "wood");
  const baseHolding = structuredClone(DEFAULT_SKYHOLD_DATA.holdings[0]);
  baseHolding.gm = { ...(baseHolding.gm ?? {}), calendaria: { ...(baseHolding.gm?.calendaria ?? {}), lastQd: 400 } };
  baseHolding.special = {
    ...(baseHolding.special ?? {}),
    market: {
      stock: {
        [stockKey]: {
          marketId: "port", offerId: "wood", baseStock: 20, availableStock: 12,
          recoveryStartedTenday: 7, recoveryStartStock: 10, recoveryDurationTendays: 4,
          lastRecoveryTenday: 9, revision: 3, reservationOperationIds: ["buy-1"], restorationOperationIds: []
        }
      },
      demand: {
        [demandKey]: {
          marketId: "port", demandId: "wood", baseDemand: 25,
          reservations: { "res-single": { operationId: "res-single", qty: 5, createdTenday: 8, createdAt: "t0" } },
          consumedOutstanding: 4,
          recoveryLots: [{ qty: 4, startedTenday: 8, durationTendays: 3 }],
          recoveryStartedTenday: 8, recoveryStartConsumed: 4, recoveryDurationTendays: 3,
          lastRecoveryTenday: 9, revision: 4, reservationOperationIds: ["res-single"]
        }
      }
    }
  };
  const source = {
    meta: v72BaseMeta(),
    catalog: structuredClone(DEFAULT_SKYHOLD_DATA.catalog),
    holdings: [baseHolding]
  };
  const snapshot = JSON.stringify(source);
  const loaded = normalizeSkyholdData(source);
  assert.equal(JSON.stringify(source), snapshot, "single-holding carryover does not mutate source");
  assert.notEqual(loaded.meta.sharedMarkets.stock[stockKey], source.holdings[0].special.market.stock[stockKey]);
  assert.equal(loaded.meta.sharedMarkets.stock[stockKey].availableStock, 12);
  assert.equal(loaded.meta.sharedMarkets.stock[stockKey].recoveryStartedTenday, 7);
  assert.equal(loaded.meta.sharedMarkets.stock[stockKey].recoveryStartStock, 10);
  assert.equal(loaded.meta.sharedMarkets.stock[stockKey].revision, 3);
  assert.equal(loaded.meta.sharedMarkets.demand[demandKey].availableDemand, 16);
  assert.equal(loaded.meta.sharedMarkets.demand[demandKey].reservations["res-single"].qty, 5);
  assert.equal(loaded.meta.sharedMarkets.demand[demandKey].revision, 4);
  const reloadedTwice = normalizeSkyholdData(structuredClone(loaded));
  assert.deepEqual(reloadedTwice.meta.sharedMarkets, loaded.meta.sharedMarkets, "normalization is idempotent after activation");

  for (const scope of ["holdings", "catalog", "both"]) {
    const committed = prepareSkyholdCommit(structuredClone(source), { scope }).data;
    assert.equal(committed.meta.sharedMarkets.stock[stockKey].availableStock, 12, `${scope} commit keeps local stock`);
    assert.equal(committed.meta.sharedMarkets.demand[demandKey].reservations["res-single"].qty, 5, `${scope} commit keeps local demand reservation`);
    assert.equal(committed.meta.sharedMarkets.clockTenday, 10, `${scope} commit sets shared clock`);
  }
}
{
  const stockKey = marketStockKey("port", "wood");
  const demandKey = marketDemandKey("port", "wood");
  const makeLocalHolding = (id, { availableStock, baseStock = 20, buyOp, resId, resQty, baseDemand = 10, consumed = 2 }) => {
    const row = structuredClone(DEFAULT_SKYHOLD_DATA.holdings[0]);
    row.id = id;
    row.gm = { ...(row.gm ?? {}), calendaria: { ...(row.gm?.calendaria ?? {}), lastQd: 400 } };
    row.special = {
      ...(row.special ?? {}),
      market: {
        stock: {
          [stockKey]: {
            marketId: "port", offerId: "wood", baseStock, availableStock,
            revision: 2, reservationOperationIds: [buyOp], restorationOperationIds: []
          }
        },
        demand: {
          [demandKey]: {
            marketId: "port", demandId: "wood", baseDemand,
            reservations: { [resId]: { operationId: resId, qty: resQty, createdTenday: 8, createdAt: "t0" } },
            consumedOutstanding: consumed, revision: 2, reservationOperationIds: [resId]
          }
        }
      }
    };
    return row;
  };
  for (const sharedMarketsMeta of [undefined, { enabled: false, version: 1, clockTenday: 0, stock: {}, demand: {} }]) {
    const source = {
      meta: v72BaseMeta(sharedMarketsMeta ? { sharedMarkets: sharedMarketsMeta } : {}),
      catalog: structuredClone(DEFAULT_SKYHOLD_DATA.catalog),
      holdings: [
        makeLocalHolding("h1", { availableStock: 14, baseStock: 20, buyOp: "b1", resId: "r1", resQty: 7, baseDemand: 10, consumed: 2 }),
        makeLocalHolding("h2", { availableStock: 9, baseStock: 15, buyOp: "b2", resId: "r2", resQty: 6, baseDemand: 8, consumed: 1 })
      ]
    };
    const bound = bindSharedMarkets(normalizeSkyholdData(source));
    assert.equal(bound.meta.sharedMarkets.enabled, true);
    assert.equal(bound.meta.sharedMarkets.clockTenday, 10);
    assert.equal(bound.meta.sharedMarkets.stock[stockKey].baseStock, 20);
    assert.equal(bound.meta.sharedMarkets.stock[stockKey].availableStock, 8);
    assert.deepEqual(bound.meta.sharedMarkets.stock[stockKey].reservationOperationIds, ["b1", "b2"]);
    const sharedDemand = bound.meta.sharedMarkets.demand[demandKey];
    assert.equal(sharedDemand.baseDemand, 10);
    assert.equal(sharedDemand.availableDemand, 0);
    assert.equal(sharedDemand.reservations.r1.qty, 7);
    assert.equal(sharedDemand.reservations.r2.qty, 6);
    assert.equal(settleMarketDemandReservations({
      holding: bound.holdings[0],
      reservations: [{ marketId: "port", demandId: "wood", qty: 7, reservationOperationId: "r1" }],
      outcome: "consumed",
      operationId: "settle-r1"
    }).ok, true, "first holding reservation settles cleanly");
    assert.equal(settleMarketDemandReservations({
      holding: bound.holdings[1],
      reservations: [{ marketId: "port", demandId: "wood", qty: 6, reservationOperationId: "r2" }],
      outcome: "restored",
      operationId: "settle-r2"
    }).ok, true, "second holding reservation settles cleanly");

    bound.holdings[0].special.market.stock[stockKey] = { marketId: "port", offerId: "wood", baseStock: 999, availableStock: 999 };
    const beforeStale = structuredClone(bound.meta.sharedMarkets);
    const reloaded = normalizeSkyholdData(bound);
    const committed = prepareSkyholdCommit(bound, { scope: "holdings" }).data;
    assert.deepEqual(reloaded.meta.sharedMarkets, beforeStale, "enabled sharedMarkets ignores stale local market data on load");
    assert.equal(committed.meta.sharedMarkets.stock[stockKey].availableStock, beforeStale.stock[stockKey].availableStock,
      "enabled sharedMarkets ignores stale local market data on commit");
  }
}
console.log("Shared market: default-enabled shared state, conserved promises, common stock/demand, isolated previews and one recovery per game date passed.");

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkSharedMarkets();
