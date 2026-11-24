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
import { UNSUPPORTED_WORLD_DATA } from "../data/storage-format.js";
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
  // Reject v72 saves that have missing or disabled sharedMarkets without mutating input.
  for (const invalidShared of [undefined, { enabled: false, version: 1, clockTenday: 0, demand: {}, stock: {} }]) {
    const saved = {
      meta: v72BaseMeta(invalidShared ? { sharedMarkets: invalidShared } : {}),
      catalog: structuredClone(DEFAULT_SKYHOLD_DATA.catalog),
      holdings: [{ ...structuredClone(DEFAULT_SKYHOLD_DATA.holdings[0]), gm: { calendaria: { lastQd: 400 } } }]
    };
    const before = JSON.stringify(saved);
    assert.throws(() => normalizeSkyholdData(saved), { code: UNSUPPORTED_WORLD_DATA });
    for (const scope of ["holdings", "catalog", "both"]) {
      assert.throws(() => prepareSkyholdCommit(saved, { scope }), { code: UNSUPPORTED_WORLD_DATA });
    }
    assert.equal(JSON.stringify(saved), before, "rejected saves without sharedMarkets remain untouched");
  }

  // Enabled sharedMarkets without clockTenday derives initialSharedClockTenday on load and commit.
  const undated = {
    meta: v72BaseMeta({ sharedMarkets: { enabled: true } }),
    catalog: structuredClone(DEFAULT_SKYHOLD_DATA.catalog),
    holdings: [{ ...structuredClone(DEFAULT_SKYHOLD_DATA.holdings[0]), gm: { calendaria: { lastQd: 400 } } }]
  };
  const bound = bindSharedMarkets(structuredClone(undated));
  const normalized = normalizeSkyholdData(structuredClone(undated));
  assert.equal(normalized.meta.sharedMarkets.clockTenday, bound.meta.sharedMarkets.clockTenday);
  assert.equal(normalized.meta.sharedMarkets.clockTenday, 10, "undated enabled sharedMarkets derives clockTenday from holding lastQd");
  for (const scope of ["holdings", "catalog", "both"]) {
    const committed = prepareSkyholdCommit(structuredClone(undated), { scope }).data;
    assert.equal(committed.meta.sharedMarkets.clockTenday, 10, `${scope} commit derives clockTenday when omitted`);
  }

  // Explicit clockTenday: 0 with enabled: true stays 0 even when holding has lastQd 400.
  const explicitZero = normalizeSkyholdData({
    ...structuredClone(undated),
    meta: v72BaseMeta({ sharedMarkets: { enabled: true, version: 1, clockTenday: 0, demand: {}, stock: {} } })
  });
  assert.equal(explicitZero.meta.sharedMarkets.clockTenday, 0, "explicit enabled sharedMarkets keeps clockTenday: 0");

  // Fresh world defaults initialize sharedMarkets enabled with zero clock and empty books.
  const fresh = normalizeSkyholdData(null);
  assert.deepEqual(fresh.meta.sharedMarkets, { enabled: true, version: 1, clockTenday: 0, demand: {}, stock: {} });
}
console.log("Shared market: default-enabled shared state, conserved promises, common stock/demand, isolated previews and one recovery per game date passed.");

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkSharedMarkets();
