import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { generateWorldShipOffers, quoteWorldShipBundle, quoteWorldShipReturn, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { advanceWorldShips, continueWorldShipBundle, departWorldShip, departWorldShipBundle,
  resolveWorldShip, resolveWorldShipBundleStop, adjustWorldShipFunds, worldShipPortDebtCopper } from "../engines/ships/world-voyage.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function fixture() {
  const f = worldMarketFixture();
  f.holding.visibility = "public";
  f.holding.gm.playersCanManageShips = true;
  f.ship.crewTarget = 1;
  return f;
}

function view(f, { gm = true, online = true } = {}) {
  globalThis.game = { user: { id: gm ? "gm" : "player", isGM: gm },
    users: online ? [{ id: "gm", isGM: true, active: true }] : [],
    socket: { emit() { throw new Error("Viewing command readiness sent a mutation"); } } };
  return prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function delivery(f, source, destination) {
  const offer = structuredClone(source);
  offer.id = `delivery-${destination}`;
  offer.to = { kind: "market", id: destination, regionId: destination, label: destination };
  offer.contract.destination = destination;
  offer.contract.directionKey = `port:${destination}`;
  delete offer.contract.pickup;
  offer.contract.cargo.quantity = 100;
  offer.contract.cargo.loadPoints = 400;
  offer.contract.cargo.valueCopper = 3000;
  return repriceWorldShipOffer(f.data, f.holding, f.ship, offer);
}

function bundleFixture() {
  const f = fixture();
  f.data.catalog.eventRegions.push({ ...structuredClone(f.data.catalog.eventRegions[0]), value: "base", label: "База",
    marketEnabled: false, marketLinks: [{ regionId: "home", distanceKm: 40, modes: ["airship"] }] });
  f.holding.overview.region = "base";
  f.ship.status = "away";
  f.ship.location = { kind: "market", id: "home", regionId: "home", label: "Порт отправителя" };
  f.ship.onboardCopper = 50000;
  f.ship.portBilling = { scope: "market", sinceQd: 0, dailyCopper: 20, carriedCopper: 0, chargedCopper: 0, lastCalculatedQd: 0 };
  return f;
}

function bundleAtPort() {
  const f = bundleFixture();
  const source = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 })[0];
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, [delivery(f, source, "a"), delivery(f, source, "b")]);
  departWorldShipBundle(f.holding, f.ship, { operationId: "command-bundle", plan, clockQd: 0 });
  const arrivalQd = f.ship.activeVoyage.arrivalQd;
  f.holding.gm.calendaria.lastQd = arrivalQd + 40;
  advanceWorldShips(f.holding, f.holding.gm.calendaria.lastQd);
  resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "command-stop", bundleId: "command-bundle", random: () => 0.99 });
  assert.equal(f.ship.orderBundle.status, "at-port");
  return f;
}

const accepted = bundleAtPort();
const nextCost = accepted.ship.orderBundle.stops[accepted.ship.orderBundle.nextStopIndex].legOffer.quote.operatingCopper;
for (const gm of [true, false]) {
  const f = structuredClone(accepted);
  f.ship.onboardCopper = nextCost - 1;
  const before = JSON.stringify(f.data);
  freeze(f.data);
  const row = view(f, { gm });
  assert.equal(row.canContinueBundle, false);
  assert.equal(row.commands.continueBundle.requiredCopper, nextCost);
  assert.equal(row.commands.continueBundle.shortageCopper, 1);
  assert.equal(row.canAdjust, gm, "a bundle waiting in port must retain the GM's authorized money form");
  assert.match(row.nextAction, /Пополнить бортовые/);
  const overview = prepareShipsContext(f.holding, { data: f.data }).rows[0];
  assert.equal(overview.nextAction, row.nextAction);
  assert.equal(JSON.stringify(f.data), before, "viewing cannot charge projected port bills, change time or reprice accepted legs");
}

{
  const f = structuredClone(accepted);
  f.ship.onboardCopper = nextCost;
  f.ship.orderBundle.stops[f.ship.orderBundle.nextStopIndex].legOffer.quote.recommendedBudgetCopper = nextCost * 10;
  f.data.catalog.eventRegions.find((region) => region.value === "b").label = "Changed catalog name";
  const row = view(f);
  assert.equal(row.canContinueBundle, true, "the next leg requires its operating cost, not a recommended reserve");
  assert.ok(row.moneySummary.portDebtCopper > row.commands.continueBundle.portBillCopper,
    "the settlement-date projection must not replace the bill at the pinned departure time");
  const result = continueWorldShipBundle(f.holding, f.ship, { operationId: "exact-leg", bundleId: f.ship.orderBundle.id, clockQd: f.ship.timelineQd });
  assert.equal(result.ok, true);
  assert.equal(f.ship.onboardCopper, 0);
  assert.equal(f.ship.activeVoyage.quote.operatingCopper, row.commands.continueBundle.operatingCopper);
}

{
  const f = structuredClone(accepted);
  f.ship.onboardCopper = nextCost - 1;
  assert.equal(view(f).canAdjust, true);
  const receipt = adjustWorldShipFunds(f.holding, f.ship, { operationId: "port-receipt", voyageId: f.ship.orderBundle.id,
    kind: "income", amountCopper: 10000, reason: "Фактическое поступление в порту" });
  assert.ok(receipt.paidPortBillCopper > 0);
  assert.equal(view(f).canContinueBundle, true, "a real GM receipt clears the shortage while preserving the accepted bundle");
}

for (const [change, reason] of [
  [(f) => { f.ship.condition = "maintenance"; }, /обслуживания/],
  [(f) => { f.ship.orderBundle.delayUntilQd = f.holding.gm.calendaria.lastQd + 4; }, /Задержка/],
  [(f) => { f.ship.location.id = "wrong-port"; }, /не соответствует порту/],
  [(f) => { f.ship.orderBundle.stops = []; }, /Сохранённый участок/],
  [(f) => { f.ship.orderBundle.stops[f.ship.orderBundle.nextStopIndex].legOffer.quote.durationQd = 0; }, /проверки ГМа/],
  [(f) => { f.ship.onboardCopper = Infinity; }, /деньги требуют/]
]) {
  const f = structuredClone(accepted);
  change(f);
  const row = view(f);
  assert.equal(row.canContinueBundle, false);
  assert.match(row.commands.continueBundle.reasonText, reason);
}

{
  const f = structuredClone(accepted);
  f.ship.timelineQd = "invalid-clock";
  const row = view(f);
  assert.equal(row.canContinueBundle, false);
  assert.equal(row.moneySummary.calculationValid, false, "unknown bill time must not produce exact free money");
  assert.equal(row.moneySummary.reserveKnown, false);
  assert.equal(row.financePresentation.mandatoryShortageCopper, null);
  assert.match(row.commands.continueBundle.reasonText, /Время корабля/);
}

for (const legacy of [false, true]) {
  const f = structuredClone(accepted);
  const futureQd = f.holding.gm.calendaria.lastQd + 4;
  if (legacy) { delete f.ship.timelineQd; f.ship.portBilling.lastCalculatedQd = futureQd; }
  else f.ship.timelineQd = futureQd;
  const row = view(f);
  assert.equal(row.timelineQd, futureQd);
  assert.equal(row.canContinueBundle, false);
  assert.equal(row.canAdjust, false);
  assert.match(row.commands.continueBundle.reasonText, /Дата поселения раньше/);
  assert.match(row.nextAction, /Проверить дату/);
}

for (const [allowed, online, reason] of [[false, true, /не разрешил/], [true, false, /активный ГМ/]]) {
  const f = structuredClone(accepted);
  f.holding.gm.playersCanManageShips = allowed;
  const row = view(f, { gm: false, online });
  assert.equal(row.canContinueBundle, false);
  assert.equal(row.canAdjust, false);
  assert.match(row.commands.continueBundle.reasonText, reason, "a disabled command retains a concrete permission/connection reason");
}

{
  const f = fixture();
  f.ship.status = "away";
  f.ship.location = { kind: "market", id: "a", regionId: "a", label: "Порт А" };
  f.ship.crewResidentIds = ["absent-sailor"];
  f.ship.timelineQd = 4;
  f.holding.gm.calendaria.lastQd = 80;
  f.ship.portBilling = { scope: "market", sinceQd: 0, dailyCopper: 20, carriedCopper: 40, chargedCopper: 0, lastCalculatedQd: 80 };
  const offer = quoteWorldShipReturn(f.data, f.holding, f.ship);
  const bill = worldShipPortDebtCopper(f.ship, 4);
  assert.equal(bill, 60);
  f.ship.onboardCopper = offer.quote.operatingCopper + bill - 1;
  assert.equal(view(f).canReturnHome, false);
  assert.equal(view(f).commands.returnHome.shortageCopper, 1);
  f.ship.onboardCopper++;
  for (const gm of [true, false]) {
    const row = view(f, { gm });
    assert.equal(row.readiness.ready, false);
    assert.equal(row.canReturnHome, true, "recovery home remains possible with an unready crew");
    assert.equal(row.commands.returnHome.requiredCopper, f.ship.onboardCopper);
  }
  const staffed = structuredClone(f);
  staffed.ship.crewResidentIds = ["sailor"];
  // The later-date projection can exceed the wallet even though an immediate return is affordable.
  const staffedOffer = quoteWorldShipReturn(staffed.data, staffed.holding, staffed.ship);
  staffed.ship.portBilling.dailyCopper = staffedOffer.quote.operatingCopper * 2;
  staffed.ship.onboardCopper = staffedOffer.quote.operatingCopper + worldShipPortDebtCopper(staffed.ship, 4);
  const staffedRow = view(staffed);
  assert.ok(staffedRow.moneySummary.obligationsCopper > staffedRow.moneySummary.balanceCopper);
  assert.equal(staffedRow.canReturnHome, true);
  assert.doesNotMatch(staffedRow.nextAction, /Не хватает/);
  assert.ok(staffedRow.departureIssues.every((issue) => !/оплаты счетов/.test(issue)));
  assert.equal(prepareShipsContext(staffed.holding, { data: staffed.data }).rows[0].nextAction, staffedRow.nextAction);
  const departure = departWorldShip(f.holding, f.ship, { operationId: "recovery-home", offer, clockQd: 4 });
  assert.equal(departure.ok, true);
  assert.equal(f.ship.onboardCopper, 0, "the command quote matches the real port bill and departure payment");
}

{
  const f = fixture();
  const offer = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 })[0];
  departWorldShip(f.holding, f.ship, { operationId: "unfunded-outcome", offer, clockQd: 0 });
  f.holding.gm.calendaria.lastQd = f.ship.activeVoyage.arrivalQd;
  advanceWorldShips(f.holding, f.holding.gm.calendaria.lastQd);
  f.ship.onboardCopper = 0;
  assert.equal(view(f, { gm: false }).canResolve, true, "an unknown outcome must still be rollable before its expense is known");
  const outcome = resolveWorldShip(f.holding, f.ship, { operationId: "save-outcome", random: () => 0 });
  assert.equal(outcome.waitingFunds, true);
  const before = JSON.stringify(f.data);
  freeze(f.data);
  assert.equal(view(f).canResolve, true, "a saved result retains its retry command without a new roll");
  assert.equal(JSON.stringify(f.data), before);
  const reversed = structuredClone(f);
  reversed.holding.gm.calendaria.lastQd--;
  assert.equal(view(reversed).canResolve, false);
  assert.match(view(reversed).commands.resolveWorld.reasonText, /Дата поселения раньше/);
}

{
  const f = bundleFixture();
  const source = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 })[0];
  const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, [delivery(f, source, "a"), delivery(f, source, "b")]);
  departWorldShipBundle(f.holding, f.ship, { operationId: "resolve-bundle", plan, clockQd: 0 });
  f.holding.gm.calendaria.lastQd = f.ship.activeVoyage.arrivalQd;
  advanceWorldShips(f.holding, f.holding.gm.calendaria.lastQd);
  f.ship.onboardCopper = 0;
  assert.equal(view(f, { gm: false }).canResolveBundle, true);
  const outcome = resolveWorldShipBundleStop(f.holding, f.ship, { operationId: "bundle-outcome", bundleId: f.ship.orderBundle.id, random: () => 0 });
  assert.equal(outcome.waitingFunds, true);
  assert.equal(view(f).canAdjust, true);
  f.ship.location.id = "wrong-port";
  assert.equal(view(f).canResolveBundle, false);
}

const template = readFileSync(new URL("../../templates/parts/ship-window/orders.hbs", import.meta.url), "utf8");
for (const flag of ["canContinueBundle", "canReturnHome", "canResolveBundle", "canResolve"]) {
  assert.ok(template.includes(`{{#unless ${flag}}}disabled{{/unless}}`), "unavailable commands remain visible with native disabled controls");
}
assert.doesNotMatch(template, /Требуется на борту.*recommendedBudgetCopper/);
console.log("Ship command availability: accepted leg costs, exact port-time billing, recovery home, GM port receipts, saved outcomes, legacy/reversed clocks and player permissions passed.");
