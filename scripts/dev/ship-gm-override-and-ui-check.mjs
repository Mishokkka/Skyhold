import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatShipMoneyHtml, formatShipMoneySigned } from "../core/ship-gold.js";
import { generateWorldShipOffers, quoteWorldShipReturn } from "../engines/ships/world-market.js";
import { advanceWorldShips, departWorldShip, worldShipPortDebtCopper } from "../engines/ships/world-voyage.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { findHoldingOperation } from "../data/operations.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function makeExecutor(state) {
  const users = new Map([
    ["gm", { id: "gm", isGM: true }],
    ["player", { id: "player", isGM: false }]
  ]);
  const skipTag = Symbol("skip");
  return createShipOperationExecutor({
    getUser: (id) => users.get(id),
    skip: (result) => ({ [skipTag]: true, result }),
    updateHolding: async (holdingId, callback) => {
      const draft = structuredClone(state.data);
      const holding = draft.holdings.find((row) => row.id === holdingId);
      if (!holding) return null;
      const result = callback(holding, draft);
      if (result && typeof result === "object" && result[skipTag]) return result.result;
      draft.meta.revision += 1;
      state.data = draft;
      return result;
    }
  });
}

// 1. Coin color-coding HTML helper contract.
{
  const full = formatShipMoneyHtml(1234);
  assert.match(full, /aria-label="12 З 3 С 4 М"/);
  assert.match(full, /<span class="fbls-coin is-gold"><b>12<\/b><i>З<\/i><\/span>/);
  assert.match(full, /<span class="fbls-coin is-silver"><b>3<\/b><i>С<\/i><\/span>/);
  assert.match(full, /<span class="fbls-coin is-copper"><b>4<\/b><i>М<\/i><\/span>/);
  assert.doesNotMatch(full, /fbls-money-sign/);

  const signedPos = formatShipMoneyHtml(505, { signed: true });
  assert.match(signedPos, /<span class="fbls-money-sign">\+<\/span>/);
  assert.match(signedPos, /aria-label="\+5 З 5 М"/);

  const neg = formatShipMoneyHtml(-230, { signed: true });
  assert.match(neg, /<span class="fbls-money-sign">−<\/span>/);
  assert.match(neg, /aria-label="−2 З 3 С"/);

  const zero = formatShipMoneyHtml(0, { signed: true });
  assert.match(zero, /aria-label="0 М"/);
  assert.doesNotMatch(zero, /fbls-money-sign/);

  assert.equal(formatShipMoneyHtml(null), "—");
  assert.equal(formatShipMoneyHtml(Number.NaN), "—");
  assert.equal(formatShipMoneyHtml(1.5), "—");
  assert.equal(formatShipMoneySigned(150), "+1 З 5 С");
  assert.equal(formatShipMoneySigned(-50), "−5 С");
  assert.equal(formatShipMoneySigned(0), "0 М");
}

// 2. Freight/smuggling cargo headlines & profit/loss row presentation (including legacy blank cargo.name saves).
{
  const f = worldMarketFixture();
  f.holding.visibility = "public";
  // Simulate baseOffers without explicit offer.name (reproducing the blank Перевозка title bug).
  for (const offer of f.data.catalog.marketEconomy.baseOffers) offer.name = "";
  const generated = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  assert.ok(generated.length > 0, "fixture generates world offers");
  for (const offer of generated) {
    assert.ok(String(offer.contract?.cargo?.name ?? "").trim().length > 0,
      `generated ${offer.kind} offer must carry a non-empty cargo name`);
    assert.ok(!String(offer.title ?? "").startsWith(":") && !String(offer.title ?? "").startsWith("→"),
      `generated offer title must not start blank: ${offer.title}`);
  }

  // Also test legacy already-persisted offers whose cargo.name was saved blank + profit/loss/zero classification.
  const baseOffer = structuredClone(generated[0]);
  const profitOffer = structuredClone(baseOffer);
  profitOffer.id = "legacy-blank-profit";
  profitOffer.title = ": a → b";
  profitOffer.contract.kind = "freight";
  profitOffer.contract.cargo.name = "";
  profitOffer.contract.cargo.resourceId = "grain";
  profitOffer.contract.rewardCopper = baseOffer.quote.operatingCopper + 450;
  profitOffer.quote.rewardCopper = profitOffer.contract.rewardCopper;

  const lossOffer = structuredClone(baseOffer);
  lossOffer.id = "legacy-blank-loss";
  lossOffer.title = " → b";
  lossOffer.contract.kind = "smuggling";
  lossOffer.contract.cargo.name = "";
  lossOffer.contract.cargo.resourceId = "unknown-id";
  lossOffer.contract.cargo.loadPoints = 10;
  f.ship.hiddenCapacityLoadPoints = 50;
  lossOffer.contract.rewardCopper = Math.max(0, baseOffer.quote.operatingCopper - 300);
  lossOffer.quote.rewardCopper = lossOffer.contract.rewardCopper;

  const zeroOffer = structuredClone(baseOffer);
  zeroOffer.id = "legacy-even";
  zeroOffer.contract.rewardCopper = baseOffer.quote.operatingCopper;
  zeroOffer.quote.rewardCopper = zeroOffer.contract.rewardCopper;

  f.holding.special.ships.offers = [profitOffer, lossOffer, zeroOffer];
  globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }] };
  const detail = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
  const byId = new Map(detail.offers.map((row) => [row.id, row]));

  const p = byId.get("legacy-blank-profit");
  const expectedGrainLabel = f.data.catalog.resources.find((row) => row.id === "grain")?.label ?? "Grain";
  assert.equal(p.cargoTitle, expectedGrainLabel, "blank freight cargo.name resolves from catalog resource label");
  assert.equal(p.contract.cargo.name, expectedGrainLabel, "reprice fills blank cargo.name on returned copy for planner and confirmation dialogs");
  assert.equal(profitOffer.contract.cargo.name, "", "reprice does not mutate the saved offer object");
  assert.ok(!p.title.startsWith(":"), "malformed saved title is cleaned in presentation");
  assert.equal(p.profitCopper, p.rewardCopper - p.costs.totalCopper);
  assert.equal(p.isProfitable, true);
  assert.equal(p.isLoss, false);
  assert.equal(p.profitLabel, "Прибыль");

  const l = byId.get("legacy-blank-loss");
  assert.equal(l.cargoTitle, "Контрабандный груз", "unknown smuggling resource falls back to descriptive Russian title");
  assert.equal(l.isProfitable, false);
  assert.equal(l.isLoss, true);
  assert.equal(l.profitLabel, "Убыль");

  const z = byId.get("legacy-even");
  assert.equal(z.profitCopper, 0);
  assert.equal(z.isProfitable, false);
  assert.equal(z.isLoss, false);
  assert.equal(z.profitLabel, "В ноль");

  const ordersTemplate = readFileSync(new URL("../../templates/parts/ship-window/orders.hbs", import.meta.url), "utf8");
  const summaryMatch = ordersTemplate.match(/<details class="fbls-ship-order[\s\S]*?<summary>([\s\S]*?)<\/summary>/);
  assert.ok(summaryMatch, "orders template renders collapsible order summary");
  assert.match(summaryMatch[0], /is-profitable/);
  assert.match(summaryMatch[0], /is-loss/);
  assert.match(summaryMatch[1], /\{\{cargoTitle\}\}/);
  assert.match(summaryMatch[1], /\{\{profitLabel\}\}/);
  assert.match(summaryMatch[1], /\{\{\{fblsShipMoneyHtml profitCopper signed=true\}\}\}/);
  assert.doesNotMatch(summaryMatch[1], /<strong>Плата/, "collapsed order row shows profit/loss instead of Плата/Расходы");

  const shipWindowCss = readFileSync(new URL("../../styles/parts/ships/ship-window.css", import.meta.url), "utf8");
  assert.doesNotMatch(shipWindowCss, /> summary\s+span\b/, "summary span rules must target direct children so inline coin spans stay horizontal");
  assert.doesNotMatch(shipWindowCss, /\.fbls-order-legs\s+span\b/, "order leg span rules must target direct children so inline coin spans stay horizontal");
  const uiKitCss = readFileSync(new URL("../../styles/parts/skyhold-ui-kit.css", import.meta.url), "utf8");
  assert.match(uiKitCss, /\.fbls-coin\.is-gold\s*>\s*b/, "coin colors apply to numeric values");
  assert.match(uiKitCss, /\.fbls-coin\s*>\s*i\s*\{[^}]*color:\s*var\(--fbls-text\)[^}]*font-weight:\s*700/s, "coin denominations stay neutral bold text");
}

// 3. GM manual ship overrides: strict GM-only security, revision/idempotency, invariants & UI intent.
{
  const f = worldMarketFixture();
  f.holding.visibility = "public";
  f.holding.gm.playersCanManageShips = true;
  f.data.catalog.eventRegions.push({ value: "secret-cove", label: "Тайная бухта", marketEnabled: false, marketLinks: [] });
  const state = { data: f.data };
  const execute = makeExecutor(state);
  const shipId = f.ship.id;
  const holdingId = f.holding.id;

  // Player cannot see gmControl and cannot execute any GM override even with playersCanManageShips=true.
  globalThis.game = { user: { id: "player", isGM: false }, users: [{ id: "gm", isGM: true, active: true }] };
  const playerRow = prepareShipWindowContext(state.data.holdings[0], { data: state.data, shipId }).rows[0];
  assert.equal(playerRow.gmControl, null, "players must not receive GM manual override context");

  for (const op of [
    { type: "gm-move", destinationKind: "market", destinationId: "a" },
    { type: "gm-condition", condition: "damaged" },
    { type: "gm-funds", fundsMode: "set", amountCopper: 500 },
    { type: "gm-arrive" },
    { type: "gm-cancel-voyage" },
    { type: "gm-clear-bills" },
    { type: "gm-sync-clock" }
  ]) {
    await assert.rejects(
      execute({ ...op, holdingId, shipId, operationId: `player-${op.type}`, expectedRevision: state.data.meta.revision }, { userId: "player", remote: true }),
      (error) => error.code === COMMAND_ERROR.FORBIDDEN,
      `player must be forbidden from ${op.type}`
    );
  }

  // GM sees gmControl with all regions (including closed/non-open ones).
  globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }] };
  const gmRow = prepareShipWindowContext(state.data.holdings[0], { data: state.data, shipId }).rows[0];
  assert.ok(gmRow.gmControl.destinations.some((row) => row.value === `home:${holdingId}`));
  assert.ok(gmRow.gmControl.destinations.some((row) => row.value === "market:secret-cove"));

  // Stale revision rejected.
  await assert.rejects(
    execute({ type: "gm-condition", holdingId, shipId, condition: "damaged", operationId: "stale-cond", expectedRevision: 0 }, { userId: "gm" }),
    (error) => error.code === COMMAND_ERROR.CONFLICT
  );

  // GM moves docked ship directly to a closed region (secret-cove), embarking crew and keeping onboard copper.
  state.data.holdings[0].special.ships.list[0].onboardCopper = 750;
  const movedOut = await execute({
    type: "gm-move", holdingId, shipId, destinationKind: "market", destinationId: "secret-cove",
    operationId: "gm-move-1", expectedRevision: state.data.meta.revision
  }, { userId: "gm" });
  assert.equal(movedOut.ok, true);
  assert.equal(movedOut.location.id, "secret-cove");
  assert.equal(state.data.holdings[0].special.ships.list[0].status, "away");
  assert.equal(state.data.holdings[0].special.ships.list[0].onboardCopper, 750, "GM move preserves onboard wallet");
  assert.equal(state.data.holdings[0].people.list[0].shipAssignment.away, true, "crew embarked on GM move to foreign port");

  // Idempotent replay does not mutate again.
  const replay = await execute({
    type: "gm-move", holdingId, shipId, destinationKind: "market", destinationId: "secret-cove",
    operationId: "gm-move-1", expectedRevision: state.data.meta.revision - 1
  }, { userId: "gm" });
  assert.equal(replay.replay, true);

  // GM changes condition and sets/adjusts onboard wallet without touching settlement treasury.
  const treasuryBefore = state.data.holdings[0].storage.moneyCopper;
  await execute({ type: "gm-condition", holdingId, shipId, condition: "damaged", operationId: "gm-cond-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].condition, "damaged");
  await execute({ type: "gm-funds", holdingId, shipId, fundsMode: "set", amountCopper: 1200, reason: "Трофей", operationId: "gm-funds-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].onboardCopper, 1200);
  assert.equal(state.data.holdings[0].storage.moneyCopper, treasuryBefore, "GM wallet override does not modify settlement treasury");
  await execute({ type: "gm-funds", holdingId, shipId, fundsMode: "income", amountCopper: 300, operationId: "gm-funds-2", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].onboardCopper, 1500);
  await execute({ type: "gm-funds", holdingId, shipId, fundsMode: "expense", amountCopper: 200, operationId: "gm-funds-3", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].onboardCopper, 1300);
  await assert.rejects(
    execute({ type: "gm-funds", holdingId, shipId, fundsMode: "expense", amountCopper: 9999, operationId: "gm-funds-over", expectedRevision: state.data.meta.revision }, { userId: "gm" }),
    /Нельзя списать больше/
  );

  // GM clears port debt & syncs a reversed ship clock.
  state.data.holdings[0].special.ships.list[0].pendingPortBillCopper = 420;
  state.data.holdings[0].special.ships.list[0].timelineQd = 80;
  state.data.holdings[0].gm.calendaria.lastQd = 20;
  await execute({ type: "gm-clear-bills", holdingId, shipId, operationId: "gm-clear-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].pendingPortBillCopper, 0);
  await execute({ type: "gm-sync-clock", holdingId, shipId, operationId: "gm-clock-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].timelineQd, 20);

  // GM moves ship back home -> crew disembarked, status docked.
  await execute({ type: "gm-condition", holdingId, shipId, condition: "ready", operationId: "gm-cond-2", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  await execute({ type: "gm-move", holdingId, shipId, destinationKind: "home", operationId: "gm-move-home", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].status, "docked");
  assert.equal(state.data.holdings[0].special.ships.list[0].location.kind, "home");
  assert.equal(state.data.holdings[0].people.list[0].shipAssignment.away, false, "crew disembarked when GM moves ship home");

  // Launch a real contract voyage, then test gm-arrive (jumps to awaitingOutcome) and gm-cancel-voyage (restores port & outing invariant).
  const offers = generateWorldShipOffers(state.data, state.data.holdings[0], state.data.holdings[0].special.ships.list[0], { period: 0, random: () => 0.4 });
  state.data.holdings[0].special.ships.offers = offers;
  departWorldShip(state.data.holdings[0], state.data.holdings[0].special.ships.list[0], { operationId: "live-voyage", offer: offers[0], clockQd: 20 });
  assert.ok(state.data.holdings[0].special.ships.list[0].activeVoyage);
  await execute({ type: "gm-arrive", holdingId, shipId, operationId: "gm-arrive-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].activeVoyage.awaitingOutcome, true, "gm-arrive opens outcome resolution on a contract voyage");
  assert.equal(state.data.holdings[0].special.ships.list[0].activeVoyage.remainingQd, 0);

  // Cancel voyage mid-outcome -> returns ship cleanly and reconciles outing leg so next leg works!
  await execute({ type: "gm-cancel-voyage", holdingId, shipId, operationId: "gm-cancel-1", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(state.data.holdings[0].special.ships.list[0].activeVoyage, null);
  const cancelledShip = state.data.holdings[0].special.ships.list[0];
  assert.equal(cancelledShip.status, "away");
  assert.equal(cancelledShip.currentOuting.lastCompletedLegId, cancelledShip.currentOuting.lastLegId, "cancelled voyage reconciles outing leg invariant");

  // Starting a return leg after GM cancel + finishing with gm-arrive works end-to-end without outing errors!
  const returnOffer = quoteWorldShipReturn(state.data, state.data.holdings[0], cancelledShip);
  cancelledShip.onboardCopper = Math.max(cancelledShip.onboardCopper, returnOffer.quote.operatingCopper + 500);
  departWorldShip(state.data.holdings[0], cancelledShip, { operationId: "return-after-cancel", offer: returnOffer, clockQd: 20 });
  const arrivedHome = await execute({ type: "gm-arrive", holdingId, shipId, operationId: "gm-arrive-home", expectedRevision: state.data.meta.revision }, { userId: "gm" });
  assert.equal(arrivedHome.home, true);
  assert.equal(state.data.holdings[0].special.ships.list[0].activeVoyage, null);
  assert.equal(state.data.holdings[0].special.ships.list[0].status, "docked");
  assert.equal(state.data.holdings[0].special.ships.list[0].currentOuting, undefined, "returning home closes currentOuting to lastOuting");
  assert.ok(state.data.holdings[0].special.ships.list[0].lastOuting);

  // External transport binding blocks structural GM movement.
  state.data.holdings[0].special.ships.list[0].transportOrderId = "tr-1";
  await assert.rejects(
    execute({ type: "gm-move", holdingId, shipId, destinationKind: "market", destinationId: "a", operationId: "gm-move-blocked", expectedRevision: state.data.meta.revision }, { userId: "gm" }),
    (error) => error.code === COMMAND_ERROR.CONFLICT
  );
  delete state.data.holdings[0].special.ships.list[0].transportOrderId;

  // Intent parsing for GM controls.
  const card = {
    querySelector: (selector) => ({
      "[data-ship-gm-destination]": { value: "market:secret-cove" },
      "[data-ship-gm-condition]": { value: "maintenance" },
      "[data-ship-gm-funds-mode]": { value: "income" },
      "[data-ship-gm-funds-amount]": { value: "12.50" },
      "[data-ship-gm-funds-reason]": { value: "Награда" }
    })[selector] ?? null
  };
  const button = { closest: () => null };
  assert.deepEqual(shipOperationIntent({ type: "gm-move", holding: state.data.holdings[0], ship: state.data.holdings[0].special.ships.list[0], card, button }), {
    type: "gm-move", holdingId, shipId, destinationKind: "market", destinationId: "secret-cove"
  });
  assert.deepEqual(shipOperationIntent({ type: "gm-condition", holding: state.data.holdings[0], ship: state.data.holdings[0].special.ships.list[0], card, button }), {
    type: "gm-condition", holdingId, shipId, condition: "maintenance"
  });
  assert.deepEqual(shipOperationIntent({ type: "gm-funds", holding: state.data.holdings[0], ship: state.data.holdings[0].special.ships.list[0], card, button }), {
    type: "gm-funds", holdingId, shipId, fundsMode: "income", amountCopper: 1250, reason: "Награда"
  });
}

function launchVoyageForGmControls(clockQd = 0) {
  const { data, holding, ship } = worldMarketFixture();
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  holding.gm.calendaria.lastQd = clockQd;
  ship.timelineQd = clockQd;
  const [offer] = generateWorldShipOffers(data, holding, ship, { period: Math.floor(clockQd / 40), clockQd, random: () => 0.4 });
  const departure = departWorldShip(holding, ship, { operationId: "control-voyage", offer, clockQd });
  assert.equal(departure.ok, true);
  const state = { data };
  const execute = makeExecutor(state);
  const command = (type, params = {}) => execute({
    type, holdingId: holding.id, shipId: ship.id, operationId: `${type}-${state.data.meta.revision}`,
    expectedRevision: state.data.meta.revision, ...params
  }, { userId: "gm" });
  return { state, holding, ship, departure, command };
}

// GM movement notes remain safe to display after the ship leaves the hidden port and the report is saved.
{
  const { state, ship, command } = launchVoyageForGmControls();
  const privateRegion = state.data.catalog.eventRegions.find((row) => row.value === "secret");
  privateRegion.label = "Бухта Тихой Короны";
  await command("gm-move", { destinationKind: "market", destinationId: privateRegion.value });
  await command("gm-move", { destinationKind: "home" });
  state.data = JSON.parse(JSON.stringify(state.data));
  const readReport = (isGM) => {
    globalThis.game.user = { id: isGM ? "gm" : "player", isGM };
    const window = prepareShipWindowContext(state.data.holdings[0], { data: state.data, shipId: ship.id });
    return window.rows[0].financePresentation.outing;
  };
  const playerReport = readReport(false);
  const gmReport = readReport(true);
  assert.equal(playerReport.ongoing, false);
  assert.ok(playerReport.details.some((row) => row.kind === "gm-override"), "player still sees that the GM intervened");
  assert.ok(gmReport.details.some((row) => row.reason.includes(privateRegion.label)), "GM retains the saved destination");
  assert.ok(playerReport.details.every((row) => !row.reason.includes(privateRegion.label)), "saved GM notes must not reveal a hidden port in the player journal");
}

// Cancel and move both preserve the accrued bill, even before it has been posted as pending debt.
for (const action of ["gm-move", "gm-cancel-voyage"]) {
  const { state, holding, ship, departure, command } = launchVoyageForGmControls();
  const clockQd = departure.arrivalQd + 40;
  holding.gm.calendaria.lastQd = clockQd;
  assert.equal(advanceWorldShips(holding, clockQd).awaiting.length, 1);
  assert.equal(ship.pendingPortBillCopper, 0);
  const due = worldShipPortDebtCopper(ship, clockQd);
  const wallet = ship.onboardCopper;
  assert.ok(due > 0 && wallet > due);
  await command(action, action === "gm-move" ? { destinationKind: "market", destinationId: "b" } : {});
  assert.equal(worldShipPortDebtCopper(state.data.holdings[0].special.ships.list[0], clockQd), due, action);
  await command("gm-move", { destinationKind: "home" });
  const homeHolding = state.data.holdings[0];
  const homeShip = homeHolding.special.ships.list[0];
  assert.equal(worldShipPortDebtCopper(homeShip, clockQd), due, "moving again neither waives nor doubles the unpaid balance");
  assert.equal(homeShip.onboardCopper, wallet);
  assert.deepEqual(advanceWorldShips(homeHolding, clockQd).expenses.map((row) => row.amountCopper), [due]);
  assert.equal(homeShip.onboardCopper, wallet - due);
  assert.deepEqual(advanceWorldShips(homeHolding, clockQd).expenses, [], "normal settlement pays the carried bill once");
}

{
  const { state, holding, ship, command } = launchVoyageForGmControls(80);
  holding.gm.calendaria.lastQd = 0;
  const before = structuredClone(state.data);
  const { gmControl } = prepareShipWindowContext(holding, { data: state.data, shipId: ship.id }).rows[0];
  assert.match(gmControl.moveBlockedReason, /Дата поселения раньше/);
  assert.deepEqual([gmControl.canSyncClock, gmControl.canArrive, gmControl.canCancelVoyage, gmControl.canMove], [false, false, false, false]);
  for (const action of ["gm-sync-clock", "gm-arrive", "gm-cancel-voyage", "gm-move"]) {
    const params = action === "gm-move" ? { destinationKind: "home" } : {};
    await assert.rejects(command(action, params), /Дата поселения раньше/);
  }
  assert.deepEqual(state.data, before, "a rejected calendar correction does not change either the voyage or the holding");

  advanceWorldShips(holding, 84);
  holding.gm.calendaria.lastQd = 82;
  const remainingQd = ship.activeVoyage.remainingQd;
  await command("gm-sync-clock");
  const syncedHolding = state.data.holdings[0];
  const syncedShip = syncedHolding.special.ships.list[0];
  assert.equal(syncedShip.activeVoyage.startedAtQd, 80);
  assert.equal(syncedShip.activeVoyage.remainingQd, remainingQd);
  assert.equal(syncedShip.activeVoyage.arrivalQd, 82 + remainingQd);
  const arrivalQd = syncedShip.activeVoyage.arrivalQd;
  assert.equal(advanceWorldShips(syncedHolding, arrivalQd).awaiting.length, 1);
  syncedHolding.gm.calendaria.lastQd = arrivalQd - 1;
  await assert.rejects(command("gm-sync-clock"), /Дата поселения раньше/, "a recorded arrival also anchors the clock");
  delete syncedShip.activeVoyage.arrivedAtQd;
  await assert.rejects(command("gm-sync-clock"), /Дата поселения раньше/, "an older awaiting voyage can use its stored arrival time");
}

// The same ordinary player command can recover its receipt from either pre-existing signature.
{
  const { data, holding, ship } = worldMarketFixture();
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  const state = { data };
  const execute = makeExecutor(state);
  const actor = { userId: "player", remote: true };
  const command = { type: "adjust", operationId: "deposit-retry", holdingId: holding.id, shipId: ship.id,
    expectedRevision: data.meta.revision, kind: "deposit", amountCopper: 120, locationKind: "home", locationId: holding.id };
  const mainSignature = {
    type: command.type, operationId: command.operationId, holdingId: command.holdingId, shipId: command.shipId,
    expectedRevision: command.expectedRevision, budgetCopper: 0, voyageId: "", amountCopper: 120, kind: "deposit", reason: "",
    offerId: "", offerIds: [], style: "normal", profileId: "", shipName: "", crewResidentIds: [], residentId: "",
    locationKind: "home", locationId: holding.id, destinationId: ""
  };
  const { destinationId, ...commonFields } = mainSignature;
  const savedOnFirstOverrideBuild = { ...commonFields, destinationKind: "", destinationId, condition: "", fundsMode: "" };
  const result = await execute(command, actor);
  assert.equal(result.ok, true);
  const saved = state.data.holdings[0];
  const logged = findHoldingOperation(saved, command.operationId);
  assert.equal(logged.payload.signature, JSON.stringify(mainSignature), "new ordinary commands retain the signature used on main");
  const nextRevision = state.data.meta.revision;
  for (const signature of [mainSignature, savedOnFirstOverrideBuild]) {
    logged.payload.signature = JSON.stringify(signature);
    assert.deepEqual(await execute(command, actor), { ...result, replay: true });
    await assert.rejects(execute({ ...command, amountCopper: 121 }, actor), (error) => error.code === COMMAND_ERROR.CONFLICT);
  }
  assert.equal(state.data.meta.revision, nextRevision);
  assert.equal(saved.special.ships.list[0].onboardCopper, 120);
  assert.equal(state.data.holdings[0], saved);
}

console.log("Ship GM overrides, journal privacy, port debts, voyage chronology, saved replays and order presentation passed.");
