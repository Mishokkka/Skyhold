import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { bundleOperatingShares, bundleOutcomeReserves } from "../engines/ships/bundle-accounting.js";
import { generateWorldShipOffers, quoteWorldShipBundle, quoteWorldShipHomeUpkeep, quoteWorldShipSale } from "../engines/ships/world-market.js";
import { departWorldShipBundle, advanceWorldShips } from "../engines/ships/world-voyage.js";
import { shipMoneySummary } from "../engines/ships/summary.js";
import { shipRemovalBlocker } from "../engines/ships/removal.js";
import { applyShipHomePlacement, shipHomeLocationContext } from "../apps/domains/ship-home-location.js";
import { normalizeMarketOutboundState } from "../data/market/outbound-state.js";
import { planMarketOutboundSale, preflightMarketOutboundBooking, applyMarketOutboundDispatch } from "../engines/market/outbound.js";
import { visibleActiveShipments } from "../apps/market/shipment-list.js";
import { transferResidentBetweenHoldings } from "../data/resident-assignments.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { createStorageOperationExecutor } from "../apps/storage-operation-executor.js";
import { createSkyholdSocketApi } from "../data/socket.js";
import { createShipViewState } from "../apps/ships-view-state.js";
import { validateOwnShipOutboundFunding } from "../apps/market/authority-context.js";
import { applyShipFundsOperation, createShipFunds } from "../engines/ships/funds.js";

const clone = (value) => structuredClone(value);

// Sale funding previews include the home bill that the command will settle first.
{
  const { holding, ship } = worldMarketFixture();
  holding.gm.calendaria.lastQd = 40;
  ship.portBilling = { scope: "home", dailyCopper: 10, sinceQd: 0, lastCalculatedQd: 0, chargedCopper: 0, carriedCopper: 0 };
  const ownShip = { voyageOffer: { shipId: ship.id, quote: { recommendedBudgetCopper: 200, preparationCopper: 10 } } };
  for (const wallet of [0, 60, 150, 400]) {
    ship.onboardCopper = wallet;
    const required = 20 + 10 + Math.max(0, 100 - wallet) + Math.max(0, 200 - Math.max(0, wallet - 100));
    holding.storage.moneyCopper = required - 1;
    assert.equal(validateOwnShipOutboundFunding(holding, { plan: { ok: true, upfrontCopper: 20 } }, ownShip).plan.ok, false);
    holding.storage.moneyCopper = required;
    assert.equal(validateOwnShipOutboundFunding(holding, { plan: { ok: true, upfrontCopper: 20 } }, ownShip).plan.ok, true);
  }
  const full = applyShipFundsOperation(createShipFunds(1_000_000_000), { id: "depart", kind: "depart", amountCopper: 1_000_000_000 }).state;
  const before = JSON.stringify(full);
  assert.throws(() => applyShipFundsOperation(full, { id: "overflow", kind: "income", amountCopper: 1 }), /1000000000/);
  assert.equal(JSON.stringify(full), before, "an overflowing operation must leave both balances untouched");
}

// Allocation conserves every copper, including tiny totals and reordered input.
for (const weights of [[1, 1], [1, 1, 1], [1, 7, 3], [4000, 200, 800]]) {
  const offers = weights.map((loadPoints, index) => ({ id: `offer-${index}`, contract: { cargo: { loadPoints } } }));
  for (const total of [0, 1, 2, 7, 2660, 999999999]) {
    const shares = bundleOperatingShares(offers, total);
    assert.equal(shares.reduce((sum, value) => sum + value, 0), total);
    assert.ok(shares.every((value) => Number.isInteger(value) && value >= 0));
    assert.deepEqual(bundleOperatingShares([...offers].reverse(), total).reverse(), shares);
  }
}
{
  const { data, holding, ship } = worldMarketFixture();
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.4 }).slice(0, 2);
  const plan = quoteWorldShipBundle(data, holding, ship, offers);
  assert.equal(departWorldShipBundle(holding, ship, { operationId: "reserve", plan, clockQd: 0 }).ok, true);
  const saved = JSON.parse(JSON.stringify(ship));
  const before = JSON.stringify(saved);
  const summary = shipMoneySummary(holding, saved);
  assert.equal(summary.incidentReserveCopper, plan.outcomeReserveCopper);
  assert.equal(summary.remainingOperatingCopper, plan.totalOperatingCopper - plan.stops[0].legOffer.quote.operatingCopper);
  assert.equal(summary.reserveCopper, plan.recommendedBudgetCopper - plan.stops[0].legOffer.quote.operatingCopper);
  assert.equal(summary.freeCopper, 0, "the recommended departure budget has no uncommitted cash");
  assert.equal(JSON.stringify(saved), before, "a summary must never alter the accepted snapshot");
  const perOrder = bundleOutcomeReserves(offers, plan.totalOperatingCopper);
  saved.orderBundle.orders[0].outcome = { expenseCopper: 19 };
  assert.equal(shipMoneySummary(holding, saved).incidentReserveCopper, plan.outcomeReserveCopper - perOrder[0]);
  assert.equal(shipMoneySummary(holding, saved).outcomeDueCopper, 19);
  saved.orderBundle.orders[0].outcomeApplied = true;
  assert.equal(shipMoneySummary(holding, saved).outcomeDueCopper, 0);
  saved.onboardCopper = Infinity;
  assert.equal(shipMoneySummary(holding, saved).reserveKnown, false);
}

// Placement carries the old bill through the explicit change date without charging twice.
{
  const { data, holding, ship } = worldMarketFixture();
  Object.assign(data.catalog.eventRegions[1], { marketMapX: 100, marketMapY: 100 });
  Object.assign(data.catalog.eventRegions[2], { marketMapX: 500, marketMapY: 300 });
  holding.gm.calendaria.lastQd = 40;
  ship.portBilling = { scope: "home", dailyCopper: 17, sinceQd: 0, lastCalculatedQd: 0, chargedCopper: 5, carriedCopper: 3 };
  ship.lastOuting = { version: 1, expenseCopper: 123 };
  const balance = holding.storage.moneyCopper;
  applyShipHomePlacement(data, holding, shipHomeLocationContext(data, holding).routes[0].key, 50);
  const rate = quoteWorldShipHomeUpkeep(data, holding, ship).homeUpkeepCopperPerDay;
  assert.equal(ship.homeUpkeepCopperPerDay, rate);
  assert.equal(ship.portBilling.dailyCopper, rate);
  assert.equal(ship.portBilling.sinceQd, 40);
  assert.equal(ship.portBilling.carriedCopper, 168);
  assert.equal(holding.storage.moneyCopper, balance);
  assert.deepEqual(ship.lastOuting, { version: 1, expenseCopper: 123 });
  advanceWorldShips(holding, 44);
  assert.equal(holding.storage.moneyCopper, balance - 168 - rate);
  advanceWorldShips(holding, 44);
  assert.equal(holding.storage.moneyCopper, balance - 168 - rate);
}

// New oversized shipments fail before booking; old intact manifests survive normalization/dispatch.
{
  const resources = Array.from({ length: 1008 }, (_, index) => ({ id: `row-${index}`, resourceId: "wood", qty: 1,
    batches: [{ id: `batch-${index}`, qty: 1, ageQd: index }] }));
  const input = { resources, lines: [{ resourceId: "wood", qty: 1008, unitPriceCopper: 3 }],
    routes: [{ id: "route", deliveryQd: 4, freightCopper: 0 }], treasuryCopper: 10000 };
  const plan = planMarketOutboundSale(input);
  assert.equal(plan.ok, false);
  assert.match(plan.reasons.join(" "), /1000/);
  assert.equal(plan.cargoReservations.length, 1008);
  assert.equal(preflightMarketOutboundBooking({ resources, cargoReservations: plan.cargoReservations }).ok, false);
  const smaller = planMarketOutboundSale({ ...input, lines: [{ resourceId: "wood", qty: 1000, unitPriceCopper: 3 }] });
  assert.equal(smaller.ok, true);
  assert.equal(preflightMarketOutboundBooking({ resources, cargoReservations: smaller.cargoReservations }).ok, true);
  const normalized = normalizeMarketOutboundState({ orders: [{ id: "existing", status: "booked",
    cargoReservations: plan.cargoReservations, cargo: plan.cargoReservations, revenueCopper: plan.revenueCopper }] }).orders[0];
  assert.equal(normalized.cargo.length, 1008);
  assert.equal(normalized.cargo.reduce((sum, row) => sum + row.cargoValueCopper, 0), normalized.revenueCopper);
  const dispatched = applyMarketOutboundDispatch({ resources, cargoReservations: normalized.cargoReservations });
  assert.equal(dispatched.dispatchedQty, 1008);
  assert.equal(resources.reduce((sum, row) => sum + row.qty, 0), 0);
  const fixture = worldMarketFixture();
  assert.doesNotThrow(() => quoteWorldShipSale(fixture.data, fixture.holding, fixture.ship, "a", { loadPoints: 0, valueCopper: 30 }));
  fixture.holding.special.market.outbound = { orders: [{ ownShipId: fixture.ship.id, status: "needsResolution" }] };
  assert.match(shipRemovalBlocker(fixture.holding, fixture.ship), /продажи/);
}

for (const limit of [12, 20]) {
  const normal = Array.from({ length: 25 }, (_, index) => ({ id: `normal-${index}`, status: "in-transit" }));
  const blocked = Array.from({ length: 25 }, (_, index) => ({ id: `blocked-${index}`, status: "needsResolution" }));
  const source = [...normal, ...blocked];
  assert.deepEqual(visibleActiveShipments(source, limit), blocked, "every blocked decision is reachable above the ordinary display limit");
  assert.equal(source[0], normal[0], "selection does not reorder persisted orders");
}

{
  const { holding, ship } = worldMarketFixture();
  const person = holding.people.list[0];
  Object.assign(person, { workAssignment: "building", home: "house", workAllocations: [{ targetId: "building", normalQd: 1 }],
    shipAssignment: { shipId: ship.id, away: true } });
  ship.commanderResidentId = person.id;
  ship.coCommanderResidentIds = [person.id];
  holding.constructionCrews = [{ id: "crew", memberIds: [person.id], distributedIds: [person.id], distributedLeaderId: person.id }];
  const target = { id: "target", people: { list: [] } };
  const before = JSON.stringify({ holding, target });
  assert.equal(transferResidentBetweenHoldings(holding, target, person.id).ok, false);
  assert.equal(JSON.stringify({ holding, target }), before);
  person.shipAssignment.away = false;
  assert.equal(transferResidentBetweenHoldings(holding, target, person.id).ok, true);
  assert.deepEqual(ship.crewResidentIds, []);
  assert.deepEqual(ship.coCommanderResidentIds, []);
  assert.equal(ship.commanderResidentId, "");
  assert.equal(person.shipAssignment, undefined);
  assert.deepEqual(person.workAllocations, []);
  assert.deepEqual(holding.constructionCrews[0].distributedIds, []);
  assert.equal(holding.constructionCrews[0].distributedLeaderId, "");
  assert.equal(target.people.list[0].id, "sailor");
}

{
  const { data, holding } = worldMarketFixture();
  holding.visibility = "public";
  Object.assign(holding.gm, { playersCanEditDefense: true, playersCanEditSpecial: true });
  holding.special.ships.list = [];
  holding.gm.defense = { commanderId: "", squads: [] };
  holding.special.list = [{ id: "note", name: "Запись", type: "Заметка", notes: "", visibility: "public" }];
  const validate = (mutate) => { const next = clone(data); mutate(next.holdings[0]); return validatePlayerPatch(data, buildPlayerPatch(data, next), "player"); };
  assert.equal(validate((h) => { h.special.list[0].notes = "Текст игрока"; }).ok, true);
  assert.equal(validate((h) => { h.special.list.push({ id: "effect", type: "модификатор довольствия", value: 999999, visibility: "public" }); }).ok, false);
  const squad = (id, members, sergeantId = "") => ({ id, memberIds: members, sergeantId });
  assert.equal(validate((h) => { h.gm.defense.squads = [squad("a", ["sailor"])]; }).ok, true);
  for (const change of [
    (h) => { h.gm.defense.squads = [squad("a", ["sailor", "sailor"])]; },
    (h) => { h.gm.defense.squads = [squad("a", ["sailor"]), squad("b", ["sailor"])]; },
    (h) => { h.gm.defense.squads = [squad("a", ["sailor"], "sailor")]; },
    (h) => { h.gm.defense.commanderId = "sailor"; h.gm.defense.squads = [squad("a", ["sailor"])]; }
  ]) assert.equal(validate(change).ok, false);
  const next = clone(data); next.holdings[0].special.notes = "new";
  const patch = buildPlayerPatch(data, next); patch.baseRevision++;
  assert.equal(validatePlayerPatch(data, patch).ok, false, "future revisions cannot bypass base-value checks");
}

// Persisted storage receipts and cache identity cover the full intent and requester.
{
  let holding = { id: "holding", visibility: "public", gm: { playersCanUseStorage: true }, storage: { log: [] } };
  const users = [{ id: "gm", isGM: true }, { id: "player", isGM: false }];
  const options = { getUser: (id) => users.find((user) => user.id === id), skipTransaction: (value) => value,
    updateHolding: async (_id, callback) => { const draft = clone(holding); const result = await callback(draft, { meta: { revision: 0 } }); holding = draft; return result; },
    logic: { _applyManualStorageChange(h, op) { h.storage.log.push({ operationId: op.operationId }); return { ok: true, message: "added" }; } } };
  const execute = createStorageOperationExecutor(options);
  const operation = { type: "addResourceRow", operationId: "storage", holdingId: "holding", resourceId: "wood", qty: 1 };
  await assert.rejects(execute(operation, { userId: "player", remote: true }), /Только ГМ/);
  await execute(operation, { userId: "gm" });
  for (const changed of [{ ...operation, qty: 2 }, { ...operation, holdingId: "other" }]) {
    await assert.rejects(execute(changed, { userId: "gm" }), /another/);
  }
  await assert.rejects(execute(operation, { userId: "player" }), /another/);
  const restarted = createStorageOperationExecutor(options);
  assert.equal((await restarted(operation, { userId: "gm" })).replay, true);
  await assert.rejects(createStorageOperationExecutor(options)({ ...operation, qty: 2 }, { userId: "gm" }), /another/);
  assert.equal(holding.storage.log.length, 1);
}

// The sender is independent transport metadata; neither requests nor replies can forge it.
{
  const previousGame = globalThis.game;
  try {
    const users = [{ id: "gm", active: true, isGM: true }, { id: "gm2", active: true, isGM: true },
      { id: "player", active: true, isGM: false }, { id: "attacker", active: true, isGM: false }];
    const emitted = [];
    globalThis.game = { user: users[0], users: { contents: users, get: (id) => users.find((user) => user.id === id) },
      socket: { emit: (_channel, payload) => emitted.push(payload) } };
    let executions = 0;
    const execute = async () => { executions++; return { ok: true }; };
    const api = createSkyholdSocketApi({ getData: () => ({ meta: { revision: 1 } }), executeShipOperation: execute,
      executeMarketOperation: execute, executeStorageOperation: execute, executeConstructionOperation: execute });
    for (const type of ["Ship", "Market", "Storage", "Construction"]) {
      const request = { type: `player${type}OperationRequest`, userId: "player", targetGmId: "gm", requestId: type,
        operationId: type, expectedRevision: 1, sourceToken: "token", operation: { operationId: type, expectedRevision: 1, sourceToken: "token" } };
      const before = executions;
      await api.handleSkyholdSocketPayload(request);
      await api.handleSkyholdSocketPayload(request, "attacker");
      await api.handleSkyholdSocketPayload({ ...request, targetGmId: "" }, "player");
      game.user = users[1];
      await api.handleSkyholdSocketPayload({ ...request, targetGmId: "gm2" }, "player");
      assert.equal(executions, before);
      game.user = users[0];
      await api.handleSkyholdSocketPayload(request, "player");
      assert.equal(executions, before + 1);
    }
    game.user = users[2];
    const pending = api.requestStorageOperation({ operationId: "reply-test", type: "batchMove" });
    let resolved = false; pending.then(() => { resolved = true; });
    const reply = { type: "playerStorageOperationResponse", requestId: "reply-test", operationId: "reply-test",
      userId: "player", gmId: "gm", ok: true, result: { ok: true } };
    await api.handleSkyholdSocketPayload(reply, "attacker");
    await api.handleSkyholdSocketPayload(reply);
    await api.handleSkyholdSocketPayload({ ...reply, gmId: "gm2" }, "gm2");
    assert.equal(resolved, false);
    await api.handleSkyholdSocketPayload(reply, "gm");
    assert.equal((await pending).ok, true);
  } finally { globalThis.game = previousGame; }
}

{
  const state = createShipViewState();
  const listeners = new Map();
  const field = { value: "12.50", dataset: { shipDraft: "amount" }, closest(selector) {
    if (selector === "[data-ship-draft]") return this;
    if (selector === "[data-ship-draft-scope]") return { dataset: { shipDraftScope: "funds:ship" } };
    return { dataset: { shipHoldingRoot: "holding" } };
  } };
  const root = { querySelectorAll: (selector) => selector === "[data-ship-draft]" ? [field] : [],
    addEventListener: (type, callback) => listeners.set(type, callback) };
  state.bind(root); listeners.get("input")({ target: field });
  field.value = ""; state.bind(root); assert.equal(field.value, "12.50");
  state.clearOperation({ type: "adjust", holdingId: "holding", shipId: "ship", voyageId: "voyage" });
  field.value = ""; state.bind(root); assert.equal(field.value, "");
}

console.log("Ship audit regressions passed: exact money, home-rate transition, manifest retention, resident transfer, permissions, socket identity, retries and finance drafts.");
