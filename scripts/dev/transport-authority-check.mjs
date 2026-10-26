import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { createMarketOperationExecutor } from "../apps/market-operation-executor.js";
import { authorityMarketLogistics, marketAuthoritySourceToken, marketPurchasePlanToken, prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { AUTO_CARRIERS } from "../engines/market/transport-planner.js";

function fixture() {
  const { data, holding } = worldMarketFixture(); holding.type = "village"; holding.gm.modifiers.marketConnectionsLevel = 4;
  holding.visibility = "public"; holding.gm.playersCanUseStorage = true;
  holding.storage.resources = [{ id: "stock", resourceId: "test-freight", name: "Ткани", forSale: true, qty: 100,
    batches: [{ id: "stock-lot", qty: 100, ageQd: 0 }] }];
  holding.special.market.orders = [{ id: "legacy", operationId: "legacy", status: "in-transit", remainingQd: 17,
    carrierId: "old-firm", carrierLabel: "Старая компания", routePath: ["old-a", "old-b"], transportMode: "rail", totalCopper: 125 }];
  data.catalog.eventRegions = normalizeEventRegionOptions([
    { value: "home", label: "Дом", countryId: "A", marketTransportModes: ["rail", "caravan", "airship"], marketLinks: [
      { regionId: "relay", distanceKm: 80, modes: ["rail", "caravan"] }
    ] },
    { value: "relay", label: "Перевалка", countryId: "B", marketTransportModes: ["rail", "caravan", "airship"], marketLinks: [
      { regionId: "a", distanceKm: 80, modes: ["airship"] }
    ] }, { value: "a", label: "Рынок", countryId: "C", marketTransportModes: ["airship"] }
  ], { fallback: false });
  data.catalog.marketEconomy.countries = ["A", "B", "C"].map((id) => ({ id, label: id, active: true, visibility: "public" }));
  data.catalog.marketEconomy.organizations = ["A", "B", "C"].map((id) => ({ id: `firm-${id}`, label: `Компания ${id}`,
    active: true, visibility: "public", carrier: { enabled: true, modes: ["rail", "caravan", "airship"],
      countryShares: [{ countryId: id, sharePct: 100 }], priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1 } }));
  return data;
}

function harness(initial) {
  let data = structuredClone(initial), commits = 0;
  const calls = [], skipToken = Symbol("skip");
  const workflow = {
    _addMoney: (holding, amount) => { holding.storage.moneyCopper += amount; },
    _appendStorageLog: (holding, entries) => { holding.storage.log ??= []; holding.storage.log.push(...entries); },
    _storageAddWithOverflow: (holding, resource, qty) => {
      holding.storage.resources.push({ ...structuredClone(resource), qty }); return [{ roomId: resource.roomId, qty }];
    },
    _snapshotItemForStorage: () => { throw new Error("Resource-only authority fixture"); }
  };
  const makeExecutor = () => createMarketOperationExecutor({
    getUser: (id) => ({ id, isGM: id === "gm", active: true }), getWorkflow: () => workflow,
    now: () => "2026-10-26T00:00:00.000Z", skipTransaction: (value) => ({ [skipToken]: true, value }),
    prepareContext: (options) => { calls.push(options); return prepareMarketAuthorityContext(options); },
    updateHolding: async (_id, updater) => {
      const draft = structuredClone(data), result = await updater(draft.holdings[0], draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision++; data = draft; commits++; return result;
    }
  });
  return { get data() { return data; }, get commits() { return commits; }, calls, makeExecutor };
}

function preview(data, type, isGM, carrierId) {
  const holding = data.holdings[0], common = { data, holding, marketId: "a", isGM };
  if (type === "outbound") return prepareMarketAuthorityContext({ ...common, carrierId: AUTO_CARRIERS,
    outboundCarrierId: carrierId, outboundQuantities: { "test-freight": 2 }, outboundInsuranceEnabled: false });
  const initial = prepareMarketAuthorityContext({ ...common, carrierId });
  const offer = initial.quote.offers.find((row) => row.resourceId === "test-freight");
  return prepareMarketAuthorityContext({ ...common, carrierId, quantities: { [offer.id]: 2 } });
}
function operationFor(data, type, isGM, key, operationId) {
  const view = preview(data, type, isGM, key), plan = type === "purchase" ? view.plan : view.outbound.plan;
  assert.equal(plan.ok, true);
  return { view, operation: { type, operationId, holdingId: data.holdings[0].id, expectedRevision: data.meta.revision,
    sourceToken: marketAuthoritySourceToken({ data, holding: data.holdings[0], marketId: "a", carrierId: key }),
    planToken: type === "purchase" ? marketPurchasePlanToken(plan) : plan.planToken, marketId: "a", carrierId: key,
    quantities: type === "purchase" ? Object.fromEntries(plan.lines.map((row) => [row.id, row.qty])) : { "test-freight": 2 },
    targetRoomId: "outdoors", serviceLevel: "standard", insuranceEnabled: false } };
}
function explicitKey(data, type, isGM) {
  const view = preview(data, type, isGM, AUTO_CARRIERS), defaultKey = type === "purchase"
    ? view.plan.logistics.transportPlan.key : view.outbound.plan.route.transportPlan.key;
  const transport = authorityMarketLogistics({ data, holding: data.holdings[0], market: view.market,
    direction: type === "purchase" ? "inbound" : "outbound", isGM, economy: view.economy });
  const choices = transport.carriers.filter((row) => row.chain);
  assert.ok(choices.length > 1, "the authority fixture offers a genuine explicit alternative");
  return choices.find((row) => row.id !== defaultKey)?.id ?? choices[0].id;
}

export async function checkTransportAuthority() {
  for (const isGM of [true, false]) for (const type of ["purchase", "outbound"]) {
    const state = harness(fixture()), key = explicitKey(state.data, type, isGM);
    const { view, operation } = operationFor(state.data, type, isGM, key, `transport-${type}-${isGM}`);
    const expected = type === "purchase" ? view.plan.logistics.transportPlan : view.outbound.plan.route.transportPlan;
    assert.equal(expected.key, key);
    const legacy = JSON.stringify(state.data.holdings[0].special.market.orders[0]);
    const moneyBefore = state.data.holdings[0].storage.moneyCopper, execute = state.makeExecutor();
    const actor = { userId: isGM ? "gm" : "player", remote: !isGM };
    const result = await execute(operation, actor);
    assert.equal(result.ok, true);
    const call = state.calls.at(-1);
    assert.equal(call.carrierId, type === "purchase" ? key : AUTO_CARRIERS, "outbound route keys cannot restrict inbound quoting");
    assert.equal(call.outboundCarrierId, type === "outbound" ? key : AUTO_CARRIERS);
    assert.equal(call.isGM, isGM, "authority recomputation retains the requester's visibility");
    const holding = state.data.holdings[0], orders = type === "purchase" ? holding.special.market.orders : holding.special.market.outbound.orders;
    const accepted = orders.filter((row) => row.operationId === operation.operationId || row.parentOperationId === operation.operationId);
    assert.ok(accepted.length > 0);
    for (const order of accepted) assert.deepEqual(order.transportPlan, expected, "the user's exact chosen chain is frozen, including carrier/edge identities");
    const charged = type === "purchase" ? view.plan.totalCopper : view.outbound.plan.upfrontCopper;
    assert.equal(moneyBefore - holding.storage.moneyCopper, charged);
    assert.equal(JSON.stringify(holding.special.market.orders[0]), legacy, "booking a new route does not rewrite an old aggregate promise");
    const beforeReplay = JSON.stringify(state.data);
    assert.equal((await execute(operation, actor)).replay, true);
    assert.equal((await state.makeExecutor()(operation, actor)).replay, true, "persisted replay survives executor restart");
    assert.equal(JSON.stringify(state.data), beforeReplay); assert.equal(state.commits, 1);
    const frozen = JSON.stringify(accepted.map((row) => row.transportPlan));
    state.data.catalog.marketEconomy.organizations.forEach((row) => { row.carrier.priceFactor = 3; row.active = false; });
    assert.equal(JSON.stringify(accepted.map((row) => row.transportPlan)), frozen, "catalog edits cannot reprice accepted contracts");
  }
  for (const type of ["purchase", "outbound"]) {
    const state = harness(fixture()), key = explicitKey(state.data, type, false);
    const { operation } = operationFor(state.data, type, false, key, `stale-${type}`);
    state.data.catalog.marketEconomy.organizations.find((row) => row.id === "firm-B").carrier.priceFactor = 2;
    const before = JSON.stringify(state.data);
    await assert.rejects(state.makeExecutor()(operation, { userId: "player", remote: true }),
      (error) => error.code === "conflict" && error.stale === true, "changed intermediate terms invalidate stale intent before any write");
    assert.equal(JSON.stringify(state.data), before); assert.equal(state.commits, 0);
  }
  for (const isGM of [true, false]) {
    const initial = fixture();
    initial.catalog.marketEconomy.settings = { ...(initial.catalog.marketEconomy.settings ?? {}), deliveryMode: "instant" };
    const state = harness(initial), key = explicitKey(state.data, "purchase", isGM);
    const { view, operation } = operationFor(state.data, "purchase", isGM, key, `instant-transport-${isGM}`);
    assert.equal(view.plan.deliveryMode, "instant");
    await state.makeExecutor()(operation, { userId: isGM ? "gm" : "player", remote: !isGM });
    const order = state.data.holdings[0].special.market.orders.find((row) => row.operationId === operation.operationId);
    assert.equal(order.status, "delivered"); assert.equal(order.deliveryMode, "instant");
    assert.deepEqual(order.transportPlan, view.plan.logistics.transportPlan, "the GM instant-delivery mode also archives its exact quoted transport plan");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkTransportAuthority();
  console.log("Transport authority: GM/player explicit incoming/outgoing chains, exact frozen terms, payments, replay, stale intermediate changes and legacy promises passed.");
}
