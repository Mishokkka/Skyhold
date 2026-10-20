import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { createShipRecord } from "../data/ships.js";
import { advanceWorldShips, resolveWorldShip } from "../engines/ships/world-voyage.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function fixture() {
  return {
    meta: { revision: 1 },
    holdings: [{
      id: "holding", name: "Дом", visibility: "public", storage: { moneyCopper: 1000 },
      gm: { playersCanManageShips: true, calendaria: { lastQd: 0 } }, people: { list: [] },
      special: { ships: { list: [{
        id: "ship", name: "Магнифик", navigationMode: "world", profileId: "merchant-barque",
        condition: "ready", status: "away", activeVoyage: null, onboardCopper: 100,
        location: { kind: "market", id: "port-a", regionId: "a", label: "Порт А" }, crewResidentIds: []
      }], offers: [], history: [], worldOfferLocks: {} } }, operations: []
    }]
  };
}

export async function checkShipWorldAuthorityCharacterization() {
  const holding = { id: "holding" };
  const ship = { id: "ship", location: { kind: "market", id: "port-a" } };
  const offer = { dataset: { shipOffer: "offer" }, querySelector: (selector) => selector === "[data-ship-style]" ? { value: "bold" } : { value: "", dataset: {} } };
  const card = { dataset: { shipVoyage: "voyage" }, querySelector: () => null };
  assert.deepEqual(shipOperationIntent({ type: "depart-world", holding, ship, card, button: { closest: (selector) => selector === "[data-ship-offer]" ? offer : null } }), {
    type: "depart-world", holdingId: "holding", shipId: "ship", budgetCopper: null,
    offerId: "offer", style: "bold", locationKind: "market", locationId: "port-a"
  });
  assert.deepEqual(shipOperationIntent({ type: "relocate-world", holding, ship,
    card: { querySelector: () => ({ value: "port-b" }) }, button: { closest: () => null } }), {
    type: "relocate-world", holdingId: "holding", shipId: "ship", destinationId: "port-b",
    locationKind: "market", locationId: "port-a"
  });
  const crewControls = [{ value: "one", checked: true }, { value: "two", checked: true }, { value: "three", checked: false }];
  assert.deepEqual(shipOperationIntent({ type: "crew", holding, ship, card: { querySelectorAll: () => crewControls }, button: { closest: () => null } }), {
    type: "crew", holdingId: "holding", shipId: "ship", crewResidentIds: ["one", "two"]
  });

  const gm = { id: "gm", isGM: true };
  const player = { id: "player", isGM: false };
  let data = fixture();
  let commits = 0;
  const skipToken = Symbol("skip");
  const execute = createShipOperationExecutor({
    getUser: (id) => id === gm.id ? gm : id === player.id ? player : null,
    random: () => 0.4,
    skip: (value) => ({ [skipToken]: true, value }),
    updateHolding: async (id, updater) => {
      const draft = structuredClone(data);
      const target = draft.holdings.find((row) => row.id === id);
      const result = await updater(target, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision += 1; data = draft; commits += 1; return result;
    }
  });
  const base = { operationId: "op", holdingId: "holding", expectedRevision: 1 };
  await assert.rejects(execute({ ...base, type: "create-profile", profileId: "merchant-barque" }, { userId: player.id, remote: true }), /Нет права/);
  await assert.rejects(execute({ ...base, type: "crew", shipId: "ship", crewResidentIds: [] }, { userId: player.id, remote: true }), /Нет права/);
  assert.equal(commits, 0);

  await assert.rejects(execute({
    ...base, type: "adjust", shipId: "ship", kind: "income", amountCopper: 1,
    locationKind: "market", locationId: "stale-port"
  }, { userId: gm.id }), /другом месте/);
  assert.equal(commits, 0);

  await assert.rejects(execute({ ...base, type: "crew", shipId: "ship", crewResidentIds: ["same", "same"] }, { userId: gm.id }), /список команды/);
  assert.equal(commits, 0);

  await assert.rejects(execute({ ...base, type: "depart", shipId: "ship", budgetCopper: 100 }, { userId: player.id, remote: true }), /мирового рынка/);
  await assert.rejects(execute({ ...base, type: "resolve", shipId: "ship", voyageId: "forged" }, { userId: player.id, remote: true }), /мирового рейса/);
  await assert.rejects(execute({ ...base, type: "generate" }, { userId: gm.id }), /Нет готовых кораблей/);
  assert.equal(commits, 0);
  data.holdings[0].special.ships.worldOfferLocks.future = { period: 2 };
  await assert.rejects(execute({
    ...base, type: "generate-world", shipId: "ship", locationKind: "market", locationId: "port-a"
  }, { userId: player.id, remote: true }), /позже текущего времени/);
  assert.equal(commits, 0);

  const live = worldMarketFixture();
  // This permission/repricing fixture uses an ordinary ship with an abstract crew.
  // Named Magnifique readiness is checked explicitly below and in its roster suite.
  live.ship.name = "Тестовый барк";
  data = live.data;
  data.holdings[0].visibility = "public";
  data.holdings[0].gm.playersCanManageShips = true;
  data.holdings[0].people.list.push({ id: "volunteer", name: "Доброволец", dead: false, volunteerLabor: true });
  const legacy = createShipRecord("legacy");
  legacy.routePlan = { destination: "Старый порт", distanceKm: 150, portDays: 0, preparationCopper: 1, upkeepPerDayCopper: 1, rewardCopper: 20 };
  data.holdings[0].special.ships.list.push(legacy);
  commits = 0;

  const generatedOperation = {
    type: "generate-world", operationId: "world-offers", holdingId: "holding", shipId: "magnifique",
    expectedRevision: 1, locationKind: "home", locationId: "holding"
  };
  const generated = await execute(generatedOperation, { userId: player.id, remote: true });
  assert.equal(generated.ok, true);
  assert.ok(generated.offerCount > 0);
  assert.equal(commits, 1);
  assert.equal((await execute(generatedOperation, { userId: player.id, remote: true })).replay, true);
  assert.equal(commits, 1, "authority replay must not commit or reroll");
  await assert.rejects(execute({ ...generatedOperation, operationId: "world-reroll", expectedRevision: 2 }, { userId: player.id, remote: true }), /уже подготовлены/);

  const shipRow = data.holdings[0].special.ships.list.find((row) => row.id === "magnifique");
  const storedOffer = data.holdings[0].special.ships.offers.find((row) => row.mode === "world" && row.shipId === shipRow.id);
  const originalReward = storedOffer.quote.rewardCopper;
  const originalOperating = storedOffer.quote.operatingCopper;
  const crewChanged = await execute({
    type: "crew", operationId: "crew-change", holdingId: "holding", shipId: shipRow.id,
    expectedRevision: 2, crewResidentIds: ["sailor", "volunteer"]
  }, { userId: gm.id });
  assert.equal(crewChanged.crewCount, 2);

  const departureOperation = {
    type: "depart-world", operationId: "world-depart", holdingId: "holding", shipId: shipRow.id,
    expectedRevision: 3, offerId: storedOffer.id, style: "normal",
    locationKind: "home", locationId: "holding"
  };
  const settlementBefore = data.holdings[0].storage.moneyCopper;
  const beforeUnfit = structuredClone(data);
  data.holdings[0].people.list[0].injuredDays = 2;
  const unfitSnapshot = JSON.stringify(data);
  await assert.rejects(execute({ ...departureOperation, operationId: "unfit-depart" }, { userId: player.id, remote: true }), /ранение/);
  assert.equal(JSON.stringify(data), unfitSnapshot, "unfit crew must not consume the offer, clear jobs, write a report or charge money");
  assert.equal(commits, 2);
  data = structuredClone(beforeUnfit);
  data.holdings[0].special.ships.list.find((row) => row.id === shipRow.id).name = "Магнифик";
  const namedSnapshot = JSON.stringify(data);
  await assert.rejects(execute({ ...departureOperation, operationId: "understaffed-depart" }, { userId: gm.id }), /из 36/);
  assert.equal(JSON.stringify(data), namedSnapshot, "named crew shortfall must fail atomically for GM as well as player");
  data = beforeUnfit;
  const departed = await execute(departureOperation, { userId: player.id, remote: true });
  assert.equal(departed.ok, true);
  const accepted = data.holdings[0].special.ships.list.find((row) => row.id === shipRow.id);
  assert.equal(accepted.status, "away");
  assert.equal(accepted.activeVoyage.quote.rewardCopper, originalReward, "crew edits must not rewrite the customer's fee");
  assert.notEqual(accepted.activeVoyage.quote.operatingCopper, originalOperating, "acceptance must reprice actual current crew costs");
  assert.ok(data.holdings[0].storage.moneyCopper < settlementBefore);
  assert.ok(data.holdings[0].people.list.filter((row) => ["sailor", "volunteer"].includes(row.id)).every((row) => row.shipAssignment?.away));
  assert.equal(data.holdings[0].special.ships.offers.find((row) => row.id === storedOffer.id).consumedBy, "world-depart");
  const onboardAfterDeparture = accepted.onboardCopper;
  assert.equal((await execute(departureOperation, { userId: player.id, remote: true })).replay, true);
  assert.equal(accepted.onboardCopper, onboardAfterDeparture);
  assert.equal(commits, 3);

  const legacyGenerated = await execute({ type: "generate", operationId: "legacy-offers", holdingId: "holding", expectedRevision: 4 }, { userId: gm.id });
  assert.equal(legacyGenerated.offerCount, 4);
  assert.ok(data.holdings[0].special.ships.offers.some((row) => row.id === storedOffer.id), "legacy generation must retain world offers");

  const liveHolding = data.holdings[0];
  const activeShip = liveHolding.special.ships.list.find((row) => row.id === shipRow.id);
  advanceWorldShips(liveHolding, 40);
  liveHolding.gm.calendaria.lastQd = 40;
  resolveWorldShip(liveHolding, activeShip, { operationId: "pure-resolve", random: () => 0.99 });
  assert.equal(activeShip.location.kind, "market");
  assert.equal(activeShip.activeVoyage, null);
  const atPort = await execute({
    type: "generate-world", operationId: "port-offers", holdingId: "holding", shipId: activeShip.id,
    expectedRevision: 5, locationKind: activeShip.location.kind, locationId: activeShip.location.id
  }, { userId: player.id, remote: true });
  assert.ok(atPort.offerCount > 0, "a different port and period must allow a new market draw");

  const beforeCatchUp = structuredClone(data);
  const commitsBeforeCatchUp = commits;
  const waitingShip = data.holdings[0].special.ships.list.find((row) => row.id === shipRow.id);
  const nextOffer = data.holdings[0].special.ships.offers.find((row) => row.mode === "world" && row.shipId === waitingShip.id
    && row.from?.id === waitingShip.location.id && !row.consumedBy);
  assert.ok(nextOffer, "the arrived ship receives a new local contract");
  const nextStartQd = waitingShip.timelineQd;
  waitingShip.onboardCopper = 1_000_000;
  const nextDeparture = await execute({
    type: "depart-world", operationId: "catch-up-depart", holdingId: "holding", shipId: waitingShip.id,
    expectedRevision: data.meta.revision, offerId: nextOffer.id,
    locationKind: waitingShip.location.kind, locationId: waitingShip.location.id
  }, { userId: player.id, remote: true });
  assert.equal(nextDeparture.ok, true);
  const caughtUpShip = data.holdings[0].special.ships.list.find((row) => row.id === shipRow.id);
  assert.equal(caughtUpShip.activeVoyage.startedAtQd, nextStartQd, "the separate order starts at the ship's arrival, not tenday end");
  assert.ok(caughtUpShip.timelineQd <= 40, "command-side catch-up cannot overrun the settlement date");
  data = beforeCatchUp;
  commits = commitsBeforeCatchUp;

  const created = await execute({
    type: "create-profile", operationId: "create-cutter", holdingId: "holding", expectedRevision: 6,
    profileId: "cutter", shipName: "Ласточка"
  }, { userId: gm.id });
  assert.equal(created.profileId, "cutter");
  const cutter = data.holdings[0].special.ships.list.find((row) => row.id === "ship-create-cutter");
  assert.equal(cutter.speedKmPerDay, 190);
  assert.equal(cutter.crewTarget, 8);

  const idle = data.holdings[0].special.ships.list.find((row) => row.id === activeShip.id);
  idle.onboardCopper = 0;
  idle.pendingPortBillCopper = 20;
  idle.portBilling = { scope: "market", sinceQd: 40, lastCalculatedQd: 40, dailyCopper: 0, carriedCopper: 20, chargedCopper: 0 };
  const homeBeforeReceipt = data.holdings[0].storage.moneyCopper;
  const receipt = await execute({ type: "adjust", operationId: "port-income", holdingId: "holding", shipId: idle.id,
    expectedRevision: data.meta.revision, locationKind: idle.location.kind, locationId: idle.location.id,
    voyageId: "", kind: "income", amountCopper: 100, reason: "Оплата местного поручения"
  }, { userId: gm.id });
  assert.equal(receipt.onboardCopper, 80, "a GM receipt at an idle foreign port must settle its pending bill");
  assert.equal(receipt.pendingPortBillCopper, 0);
  assert.equal(data.holdings[0].storage.moneyCopper, homeBeforeReceipt, "port receipts never move home funds");

  data = fixture();
  const docked = data.holdings[0].special.ships.list[0];
  docked.status = "docked";
  docked.location = { kind: "home", id: "holding", regionId: "home", label: "Дом" };
  const transfer = { type: "adjust", operationId: "player-wallet", holdingId: "holding", shipId: "ship",
    expectedRevision: 1, locationKind: "home", locationId: "holding", kind: "deposit", amountCopper: 125 };
  assert.equal((await execute(transfer, { userId: player.id, remote: true })).onboardCopper, 225);
  assert.equal(data.holdings[0].storage.moneyCopper, 875);
  assert.equal((await execute(transfer, { userId: player.id, remote: true })).replay, true);
  await assert.rejects(execute({ ...transfer, operationId: "wrong-port", expectedRevision: 2, locationId: "other" }, { userId: player.id, remote: true }), /другом месте/);
  await assert.rejects(execute({ ...transfer, operationId: "manual-expense", expectedRevision: 2, kind: "expense" }, { userId: player.id, remote: true }), /Нет права/);
  data.holdings[0].gm.playersCanManageShips = false;
  await assert.rejects(execute({ ...transfer, operationId: "no-permission", expectedRevision: 2 }, { userId: player.id, remote: true }), /Нет права/);

  data = worldMarketFixture().data;
  data.holdings[0].visibility = "public";
  data.holdings[0].gm.playersCanManageShips = true;
  const relocator = data.holdings[0].special.ships.list[0];
  relocator.name = "Тестовый барк";
  const relocationOperation = {
    type: "relocate-world", operationId: "relocate-a", holdingId: "holding", shipId: relocator.id,
    expectedRevision: 1, locationKind: "home", locationId: "holding", destinationId: "a"
  };
  await assert.rejects(execute({ ...relocationOperation, destinationId: "secret" }, { userId: player.id, remote: true }), /недоступен/);
  await assert.rejects(execute({ ...relocationOperation, locationId: "stale" }, { userId: player.id, remote: true }), /другом месте/);
  const relocation = await execute(relocationOperation, { userId: player.id, remote: true });
  assert.equal(relocation.ok, true);
  assert.equal(data.holdings[0].special.ships.list[0].activeVoyage.quote.contract, null);
  assert.equal((await execute(relocationOperation, { userId: player.id, remote: true })).replay, true);
  assert.equal(data.meta.revision, 2, "replayed relocation cannot pay operating costs twice");
  data.holdings[0].gm.calendaria.lastQd = 4;
  advanceWorldShips(data.holdings[0], 4);
  assert.equal(data.holdings[0].special.ships.list[0].location.id, "a");
  assert.equal(data.holdings[0].special.ships.list[0].timelineQd, 4);

  data = worldMarketFixture().data;
  data.holdings[0].gm.calendaria.lastQd = 160;
  const first = data.holdings[0].special.ships.list[0];
  const second = structuredClone(first);
  second.id = "later-ship";
  second.timelineQd = 160;
  data.holdings[0].special.ships.list.push(second);
  const generateAt = (ship, operationId) => execute({
    type: "generate-world", operationId, holdingId: "holding", shipId: ship.id,
    expectedRevision: data.meta.revision, locationKind: ship.location.kind, locationId: ship.location.id
  }, { userId: gm.id });
  await generateAt(first, "early-board");
  const earlyOffers = data.holdings[0].special.ships.offers.filter((row) => row.shipId === first.id).map((row) => row.id);
  await generateAt(second, "late-board");
  assert.ok(earlyOffers.every((id) => data.holdings[0].special.ships.offers.some((row) => row.id === id)),
    "another ship's later period cannot erase this ship's open board");
  await assert.rejects(generateAt(first, "early-again"), /уже подготовлены/);

  data = worldMarketFixture().data;
  data.holdings[0].gm.calendaria.lastQd = 520;
  await generateAt(data.holdings[0].special.ships.list[0], "very-late-board");
  await assert.rejects(generateAt(data.holdings[0].special.ships.list[0], "very-late-again"),
    /уже подготовлены/, "a lagging ship cannot draw the same old period repeatedly");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkShipWorldAuthorityCharacterization();
  console.log("FBL Skyhold world ship authority characterization: passed.");
}
