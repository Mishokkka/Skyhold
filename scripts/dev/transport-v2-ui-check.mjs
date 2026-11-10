import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdData, registerMarketOperationExecutor } from "../data/store.js";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { bookTransportOrder } from "../engines/transport/runtime.js";
import { ensureTransportState } from "../data/transport/state.js";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { transportRiskLabel, transportStageRiskLabel, transportStageSchedule } from "../apps/domains/transport-view.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { readFileSync } from "node:fs";

const applications = new Map();
globalThis.foundry = { applications: { api: {
  ApplicationV2: class {
    constructor(options) { this.id = options.id; }
    render() { applications.set(this.id, this); }
    async close() { if (applications.get(this.id) === this) applications.delete(this.id); }
    async _prepareContext() { return {}; }
  },
  HandlebarsApplicationMixin: (base) => base
} } };
const gm = { id: "gm", isGM: true, active: true }, player = { id: "player", isGM: false, active: true };
globalThis.game = { user: gm, users: [gm, player], socket: { emit() {} }, settings: { get() {} }, modules: new Map() };
const { SkyholdTransportApp } = await import("../apps/transport-app.js");
const { data, holding } = worldMarketFixture();
holding.type = "village"; holding.visibility = "public"; holding.gm.playersCanUseStorage = true;
holding.gm.modifiers.marketConnectionsLevel = 6;
ensureTransportState(data);
SkyholdData.view = () => data;
const market = prepareMarketAuthorityContext({ data, holding, isGM: true }).markets.find((row) => row.regionId === "a");
const offer = prepareMarketAuthorityContext({ data, holding, marketId: market.id, isGM: true }).quote.offers.find((row) => row.resourceId === "test-freight");
const request = { marketId: market.id, quantities: { [offer.id]: 2 }, insurance: false };
let app = SkyholdTransportApp.open({ holdingId: holding.id, request });
const other = SkyholdTransportApp.open({ holdingId: "other-holding" });
assert.notEqual(app.id, other.id, "Application V2 registry keys are unique per holding");
assert.equal(applications.size, 2);
await other.close();
assert.equal(applications.get(app.id), app, "closing one holding leaves the other window registered");
SkyholdTransportApp.rerenderOpen();
assert.equal((await app._prepareContext({})).canConfirm, true);
game.user = player;
assert.equal((await app._prepareContext({})).canConfirm, true, "authorized players can request an authority-GM booking");
// The quote exposes actual departure risks before either role can confirm.
// Seasonal departures can differ; their probabilities must never be added.
{
  const configuration = data.catalog.transportV2;
  const original = structuredClone(data);
  for (const user of [gm, player]) for (const riskBps of [0, 123, 10000]) {
    game.user = user;
    data.catalog.transportV2 = { riskBps };
    const preview = prepareTransportContext({ data, holding, request, isGM: user.isGM });
    const view = await app._prepareContext({});
    for (const [index, stage] of preview.plan.stages.entries()) {
      assert.equal(view.selected.stages[index].risk, transportStageRiskLabel(stage));
      assert.deepEqual(view.selected.stages[index].departures.map(row => row.risk),
        stage.runs.map(run => transportRiskLabel(run.riskBps)));
    }
    assert.equal(view.canConfirm, true);
  }
  assert.equal(transportRiskLabel(0), "0%");
  assert.equal(transportRiskLabel(123), "1,23%");
  assert.equal(transportRiskLabel(10000), "100%");
  assert.equal(transportStageRiskLabel({ runs: [{ riskBps: 250 }, { riskBps: 1000 }, { riskBps: 250 }] }), "2,5%–10%");
  assert.equal(transportStageRiskLabel({ runs: [{ riskBps: 1000 }, { riskBps: 1000 }] }), "10%");
  assert.equal(transportStageRiskLabel({ runs: [] }), "Нет отправлений");
  const template = readFileSync(new URL("../../templates/transport-app.hbs", import.meta.url), "utf8");
  assert.match(template, /риск происшествия на отправление: {{risk}}/);
  assert.match(template, /риск происшествия: {{risk}}/);
  if (configuration === undefined) delete data.catalog.transportV2;
  else data.catalog.transportV2 = configuration;
  assert.deepEqual(data, original, "risk presentation never rewrites the quote source or a saved agreement");
  game.user = player;
}
game.socket = null;
assert.equal((await app._prepareContext({})).canConfirm, false, "offline authority disables confirmation");
game.socket = { emit() {} };
const quote = prepareTransportContext({ data, holding, request, isGM: true });
const order = bookTransportOrder({ state: data.meta.transportV2, holding, plan: quote.plan, services: quote.services,
  id: "visibility-order", direction: "inbound", commercial: quote.commercial });
assert.equal((await app._prepareContext({})).orders[0].stages[0].departures?.length, order.stages[0].runs.length,
  "accepted orders retain their departure schedule after checkout");
order.status = "waitingCarrier";
assert.equal((await app._prepareContext({})).orders[0].canCancel, true, "an unstarted hired order may be cancelled while waiting for a vehicle");
order.status = "booked";
const cancellationRun = data.meta.transportV2.runs.find(run => run.id === order.stages[0].runs[0].id);
for (const user of [gm, player]) {
  game.user = user;
  data.meta.transportV2.clockQd = cancellationRun.departureQd - 1;
  assert.equal((await app._prepareContext({})).orders[0].canCancel, true, "cancellation remains available before the common departure");
  data.meta.transportV2.clockQd = cancellationRun.departureQd;
  assert.equal((await app._prepareContext({})).orders[0].canCancel, false, "a lagging window cannot offer cancellation at the common departure");
  assert.equal(order.history.some(row => row.kind === "departed"), false);
}
data.meta.transportV2.clockQd = 0;
order.lostQty = 1; order.spoiledQty = 2; order.insurancePaidCopper = 34;
const quantities = (await app._prepareContext({})).orders[0];
assert.equal(quantities.lost, 1); assert.equal(quantities.spoiled, 2); assert.ok(quantities.insurancePaid);
// Local endpoint labels must not leak implementation IDs or evade visibility.
const localEndpoint = order.stages[0].to;
order.stages[0].to = "home:holding";
data.catalog.marketEconomy.countries[0].visibility = "gm";
holding.special.market.orders = [{ id: "historical", status: "delivered", countryId: data.catalog.marketEconomy.countries[0].id,
  marketLabel: "PRIVATE MARKET", cargo: [{ name: "Cloth", qty: 2 }] }];
const hidden = await app._prepareContext({});
assert.equal(hidden.orders[0].market, "Скрытый рынок");
assert.ok(hidden.orders[0].stages.every((stage) => stage.path === "Скрытый участок"));
assert.equal(hidden.archive[0].market, "Скрытый рынок");
assert.deepEqual(Object.keys(hidden.archive[0]).sort(), ["cargo", "direction", "market", "status"], "legacy history is read-only");
order.stages[0].to = localEndpoint;
game.user = gm;
assert.equal((await app._prepareContext({})).orders[0].market, order.commercial.marketLabel);
assert.equal((await app._prepareContext({})).archive[0].market, "PRIVATE MARKET");
// Replacing a catalogue cannot make an unknown archived market public.
const savedCountries = data.catalog.marketEconomy.countries, savedRegions = data.catalog.eventRegions;
data.catalog.marketEconomy.countries = [];
data.catalog.eventRegions = [];
game.user = player;
assert.equal((await app._prepareContext({})).archive[0].market, "Скрытый рынок");
assert.ok((await app._prepareContext({})).orders[0].stages.every(stage => stage.path === "Скрытый участок"),
  "unknown saved ports must also stay hidden in the ordinary route disclosure");
game.user = gm;
assert.equal((await app._prepareContext({})).archive[0].market, "PRIVATE MARKET");
assert.ok((await app._prepareContext({})).orders[0].stages.every(stage => stage.path !== "Скрытый участок"),
  "GM retains the accepted route labels after catalog replacement");
data.catalog.marketEconomy.countries = savedCountries;
data.catalog.eventRegions = savedRegions;
data.catalog.marketEconomy.countries[0].visibility = "public";
const savedCompany = order.stages[0].service.companyId;
order.stages[0].service.companyId = "removed-private-carrier";
game.user = player;
assert.equal((await app._prepareContext({})).orders[0].stages[0].path, "Скрытый участок",
  "removing a carrier cannot make its accepted private labels public");
game.user = gm;
assert.notEqual((await app._prepareContext({})).orders[0].stages[0].path, "Скрытый участок");
order.stages[0].service.companyId = savedCompany;
const physical = data.meta.transportV2.runs[0];
physical.incident = { status: "pending" };
physical.claims.push({ holdingId: holding.id, orderId: "incoming", stage: 1, manifestReady: false, load: 1 });
assert.equal((await app._prepareContext({})).incidents[0].awaitingCargo, holding.name,
  "GM sees which holding must resolve its connecting cargo before a shared loss");
physical.claims.at(-1).stage = 0;
assert.equal((await app._prepareContext({})).incidents[0].awaitingCargo, holding.name,
  "an outbound first leg must also read actual warehouse cargo before loss allocation");
game.user = player;
assert.deepEqual((await app._prepareContext({})).incidents, [], "incident coordination remains GM-only");
game.user = gm;
physical.incident = null; physical.claims.pop();
await app._prepareContext({});
let resolve, calls = 0;
registerMarketOperationExecutor(() => { calls++; return new Promise((done) => { resolve = done; }); });
app._pending = { type: "transport-book", operationId: "late-receipt", holdingId: holding.id };
SkyholdTransportApp.sessions.set(holding.id, app._pending);
const pending = app._submit();
await app.close();
app = SkyholdTransportApp.open({ holdingId: holding.id, request });
assert.equal((await app._prepareContext({})).pending, true);
await app._submit();
assert.equal(calls, 1, "reopening and retrying an in-flight request cannot dispatch another command");
resolve({ ok: true }); await pending;
const settled = await app._prepareContext({});
assert.equal(settled.pending, false); assert.equal(settled.busy, false);
assert.equal(app.request, null, "late success clears the reopened checkout");
await app.close();
// A real accepted own-ship sale also renders its release port outside the
// route disclosure. Unknown endpoint IDs must not leak through that sentence.
{
  const f = transportFixture(), h = transportHarness(f);
  await h.book(transportRequest(f, "a", { direction: "outbound", ownShipId: f.ship.id, returnHome: false }), "unknown-release-port");
  h.data.catalog.eventRegions = []; h.data.catalog.marketEconomy.countries = [];
  const before = structuredClone(h.data), ownApp = new SkyholdTransportApp({ holdingId: h.holding.id });
  SkyholdData.view = () => h.data;
  game.user = player;
  const hidden = await ownApp._prepareContext({});
  assert.match(hidden.orders[0].shipTiming, /скрытый порт/);
  assert.ok(hidden.orders[0].stages.every(stage => stage.path === "Скрытый участок"));
  game.user = gm;
  assert.doesNotMatch((await ownApp._prepareContext({})).orders[0].shipTiming, /скрытый порт/);
  assert.deepEqual(h.data, before, "GM/player projection preserves the accepted labels, cargo and accounts");
  await ownApp.close();
}
// Accepted split shipments remain inspectable after checkout, incidents and shared-run pruning.
{
  const f = transportFixture();
  const request = transportRequest(f);
  const initial = prepareTransportContext({ ...f, request, isGM: true });
  const service = initial.services.find(row => row.kind === "regular" && row.from === initial.from && row.to === initial.to);
  assert.ok(service);
  request.serviceIds = [service.id];
  f.data.catalog.transportV2.overrides = { [service.id]: { capacity: 20000, loadingQd: 1, unloadingQd: 1,
    travelQd: 2, firstQd: 2, intervalQd: 8, riskBps: 10000 } };
  const h = transportHarness(f);
  const booked = await h.book(request, "schedule-authority");
  const accepted = structuredClone(booked.order.plan);
  const runs = booked.order.stages[0].runs;
  assert.equal(runs.length, 2);
  const scheduleApp = new SkyholdTransportApp({ holdingId: h.holding.id });
  let viewData = h.data;
  SkyholdData.view = () => viewData;
  const inspect = async () => {
    const before = structuredClone(viewData);
    let schedule;
    for (const user of [gm, player]) {
      game.user = user;
      const view = await scheduleApp._prepareContext({});
      assert.equal(view.hasRequest, false, "accepted schedules survive closing the original checkout");
      const current = view.orders[0].stages[0].departures;
      if (schedule) assert.deepEqual(current, schedule, "GM and player see the same shipment dates and quantities");
      schedule = current;
    }
    assert.deepEqual(viewData, before, "schedule preparation never changes physical runs, local receipts or funds");
    return schedule;
  };
  let schedule = await inspect();
  assert.deepEqual(schedule.map(row => row.qty), [5, 5]);
  assert.equal(schedule[0].arrivalQd, 5);
  assert.equal(schedule[0].departure, "через 0,5 дн.");
  h.advance(5);
  assert.equal((await inspect())[0].status, "Ожидает решения ГМ");
  const decide = async (id, outcome, delayQd = 0) => {
    const command = { type: "transport-incident", operationId: `schedule-${id}`, holdingId: h.holding.id,
      expectedRevision: h.data.meta.revision, sourceToken: transportSourceToken(h.data, h.holding),
      runId: id, resolution: { outcome, delayQd } };
    game.user = gm;
    assert.equal((await h.execute(command, { userId: "gm" })).ok, true);
    viewData = h.data;
    const before = structuredClone(h.data);
    assert.equal((await h.execute(command, { userId: "gm" })).replay, true);
    assert.deepEqual(h.data, before);
  };
  await decide(runs[0].id, "delay", 12);
  schedule = await inspect();
  assert.equal(schedule[0].arrivalQd, 17, "the live delayed arrival overrides the accepted estimate");
  assert.equal(schedule[0].arrival, "через 3 дн.");
  assert.equal(schedule[0].status, "В пути");
  h.advance(13);
  await decide(runs[1].id, "success");
  schedule = await inspect();
  assert.equal(schedule[1].recorded, true);
  assert.equal(schedule[1].received, 5);
  assert.equal(schedule[0].recorded, false, "an earlier delayed part does not inherit a later part's receipt");
  assert.equal(schedule[0].arrival, "через 1 дн.");
  h.advance(17);
  assert.equal(h.data.meta.transportV2.runs.length, 0, "completed physical runs may be safely pruned");
  viewData = normalizeSkyholdData(JSON.parse(JSON.stringify(h.data)));
  schedule = await inspect();
  assert.equal(schedule[0].arrivalQd, 17, "the local receipt preserves the delayed date after cleanup and loading");
  assert.equal(schedule[0].arrival, "сейчас");
  assert.equal(schedule[1].arrival, "1 дн. назад");
  assert.ok(schedule.every(row => row.recorded && row.status === "Разгружено"));
  assert.deepEqual(h.holding.special.transportV2.orders[0].plan, accepted, "tracking never rewrites accepted terms");
  const stage = h.holding.special.transportV2.orders[0].stages[0];
  const shared = new Map([[runs[0].id, { ...runs[0], status: "arrived", arrivalQd: 17 }]]);
  const lagging = transportStageSchedule({ ...stage, receipts: [], received: [] }, shared, 17);
  assert.equal(lagging[0].status, "Прибыл; ожидает проведения поселения");
  assert.equal(lagging[0].recorded, false);
  assert.equal(lagging[0].provisional, false, "a known physical arrival is not a tentative booking");
  assert.equal(transportStageSchedule(stage, shared, 17, { cancelled: true })[0].status, "Отменено");
  assert.deepEqual(transportStageSchedule({ ...stage, runs: [] }, shared, 17), []);
  const template = readFileSync(new URL("../../templates/transport-app.hbs", import.meta.url), "utf8");
  assert.match(template, /Маршрут и расписание заказа/);
  assert.match(template, /Отправка: {{departure}}; прибытие: {{arrival}}/);
  assert.match(template, /{{#each departures}}/);
  await scheduleApp.close();
}
console.log("transport-v2 UI: GM/player permissions, accepted split schedules/delays/receipts/reload, offline authority, hidden routes and late receipt after reopening passed");
