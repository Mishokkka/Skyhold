import assert from "node:assert/strict";
import { transportHistoryFixture, transportHistoryApp } from "./fixtures/transport-history.mjs";
import { transportSourceToken } from "../apps/domains/transport-context.js";
import { marketAuthoritySourceToken } from "../apps/market/authority-context.js";
import { transportRelevantHolding } from "../data/transport/state.js";
import { transportHistoryPage, TRANSPORT_HISTORY_PAGE_SIZE } from "../apps/domains/transport-view.js";
import { transportHarness, transportRequest } from "./fixtures/transport-v2.mjs";

const f = transportHistoryFixture();
f.append(1000);
const orders = f.holding.special.transportV2.orders;
assert.equal(orders.length, 1000);
const snapshot = JSON.stringify(orders);
const tokens = () => [transportSourceToken(f.data, f.holding), marketAuthoritySourceToken(f)];
const original = tokens();
orders[0].history.push({ kind: "view-only-archive-note" });
assert.deepEqual(tokens(), original, "completed transport history is irrelevant to both market and transport previews");
orders[0].history.pop();
const stages = orders[0].stages;
Object.defineProperty(orders[0], "stages", { configurable: true, get() { throw new Error("Old history must not be traversed."); } });
assert.deepEqual(tokens(), original);
const app = await transportHistoryApp(f);
let context = await app._prepareContext({});
assert.equal(context.orders.length, TRANSPORT_HISTORY_PAGE_SIZE);
assert.equal(context.history.pages, 50);
assert.equal(context.orders[0].id, "history-999");
Object.defineProperty(orders[0], "stages", { configurable: true, writable: true, value: stages });
const seen = new Set();
for (let page = 0; page < 50; page++) {
  context = await app._prepareContext({});
  assert.equal(context.history.page, page + 1);
  for (const row of context.orders) { assert.ok(!seen.has(row.id)); seen.add(row.id); }
  if (context.history.next) await app._action(null, { dataset: { action: "transport-history-next" } });
}
assert.equal(seen.size, 1000, "all saved orders remain accessible by normal page actions");
await app._action(null, { dataset: { action: "transport-history-previous" } });
assert.equal((await app._prepareContext({})).history.page, 49);
assert.equal(JSON.stringify(orders), snapshot, "reading and pagination never rewrite the archive");

const unfinished = [
  { id: "active", status: "travelling" },
  { id: "return", status: "delivered", ownShipId: "ship", shipReleased: false, shipCostsReconciled: true },
  { id: "bill", status: "lost", ownShipId: "ship", shipReleased: false, shipCostsReconciled: false, fundingNeededCopper: 5 }
].map(extra => ({ ...structuredClone(orders[0]), ...extra }));
orders.push(...unfinished);
for (const page of [0, 25, 49]) {
  const view = transportHistoryPage(orders, page);
  for (const row of unfinished) assert.ok(view.orders.includes(row), "active cargo, return and unpaid adjustments stay on every page");
}
assert.deepEqual(transportRelevantHolding(f.holding).special.transportV2.orders.map(row => row.id), ["active", "return", "bill"]);
const prior = tokens();
unfinished[1].plan.shipReleaseQd = 99999;
assert.notDeepEqual(tokens(), prior, "an outstanding vessel return is still part of the validation token");
const mutations = [
  () => { f.holding.storage.moneyCopper++; },
  () => { f.holding.storage.resources[0].qty++; },
  () => { f.holding.gm.playersCanUseStorage = false; },
  () => { f.ship.onboardCopper++; },
  () => { f.data.meta.transportV2.runs.push({ id: "other-holding-booking", reservedLoad: 100 }); },
  () => { f.data.catalog.transportV2.regularIntervalQd++; },
  () => { f.data.meta.sharedMarkets = { version: 1, stock: { test: 2 } }; }
];
for (const mutate of mutations) { const before = tokens(); mutate(); assert.notDeepEqual(tokens(), before); }

// The separate revision check still rejects stale commands even when only archive data changed.
const h = transportHarness(), request = transportRequest(h.fixture());
const { operation } = await h.book(request, "history-revision-baseline");
const next = { ...operation, operationId: "history-stale-archive", expectedRevision: h.data.meta.revision,
  sourceToken: transportSourceToken(h.data, h.holding) };
h.data.meta.revision++;
const unchanged = structuredClone(h.data);
await assert.rejects(h.execute(next, { userId: "gm" }), /Данные изменились/);
assert.deepEqual(h.data, unchanged);
console.log("Transport history: 1000 real completed orders, no physical runs, bounded page preparation, full archive access, active obligations and stale-command protection passed.");
