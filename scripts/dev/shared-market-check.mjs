import assert from "node:assert/strict";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { bindSharedMarkets, bindSharedMarketHolding, marketStateFor } from "../data/market/shared-context.js";
import { previewSharedMarketMigration, applySharedMarketMigration } from "../data/market/shared-migration.js";
import { reserveMarketStock, recoverMarketStock } from "../engines/market/stock.js";
import { reserveMarketDemand, settleMarketDemandReservations, recoverMarketDemand } from "../engines/market/demand.js";
import { marketStockKey } from "../data/market/stock-state.js";
import { marketDemandKey } from "../data/market/demand-state.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { pathToFileURL } from "node:url";
export function checkSharedMarkets() {
const holding = (id) => ({ id, gm: { calendaria: { lastQd: 0 } }, special: { market: {} } });
{
  const data = { meta: {}, catalog: {}, holdings: [holding("a"), holding("b")] };
  const before = JSON.stringify(data);
  const preview = previewSharedMarketMigration(data);
  assert.equal(JSON.stringify(data), before, "preview never mutates world data");
  applySharedMarketMigration(data, preview.sourceToken);
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
  const data = { meta: {}, catalog: {}, holdings: [holding("a"), holding("b")] };
  const [a, b] = data.holdings;
  const reserve = (target, id, qty) => reserveMarketDemand({ holding: target, marketId: "port", operationId: id,
    lines: [{ demandId: "wood", qty, demandBaseDemand: 10, demandStateRevision: 0 }] });
  const ra = reserve(a, "a-sale", 3), rb = reserve(b, "b-sale", 4);
  const preview = previewSharedMarketMigration(data);
  assert.equal(preview.ok, true);
  applySharedMarketMigration(data, preview.sourceToken);
  const key = marketDemandKey("port", "wood");
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
  const data = { meta: {}, holdings: [holding("a"), holding("b")] };
  for (const h of data.holdings) reserveMarketDemand({ holding: h, marketId: "port", operationId: h.id,
    lines: [{ demandId: "wood", qty: 8, demandBaseDemand: 10, demandStateRevision: 0 }] });
  const preview = previewSharedMarketMigration(data);
  assert.equal(preview.ok, false, "merging must not erase excessive existing promises");
  assert.match(preview.blockers.join(" "), /16/);
  assert.throws(() => applySharedMarketMigration(data, preview.sourceToken));
  assert.equal(data.meta.sharedMarkets, undefined);
}
{
  const data = { meta: {}, holdings: [holding("dated")] };
  data.holdings[0].gm.calendaria.lastDateTime = { year: 2, month: 1, day: 1 };
  const preview = previewSharedMarketMigration(data);
  applySharedMarketMigration(data, preview.sourceToken);
  const first = data.meta.sharedMarkets.clockTenday;
  reserveMarketStock({ holding: data.holdings[0], marketId: "port", operationId: "dated-buy",
    lines: [{ id: "wood", qty: 1, stockBaseStock: 10, stockStateRevision: 0 }] });
  assert.equal(data.meta.sharedMarkets.clockTenday, first, "absolute calendar time must not be added twice");
}
{
  const data = { meta: {}, holdings: [holding("a"), holding("b")] };
  for (const h of data.holdings) h.gm.calendaria.lastDateTime = { year: 2, month: 1, day: 1 };
  applySharedMarketMigration(data, previewSharedMarketMigration(data).sourceToken);
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
console.log("Shared market: explicit migration, conserved promises, common stock/demand, isolated previews and one recovery per game date passed.");

}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) checkSharedMarkets();
