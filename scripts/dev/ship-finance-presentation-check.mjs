import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareShipFinancePresentation } from "../apps/domains/ship-finance-presentation.js";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { shipMoneySummary, shipOutingSummary } from "../engines/ships/summary.js";
import { generateWorldShipOffers, quoteWorldShipBundle } from "../engines/ships/world-market.js";
import { departWorldShipBundle } from "../engines/ships/world-voyage.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

const f = worldMarketFixture();
const offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
const plan = quoteWorldShipBundle(f.data, f.holding, f.ship, offers.slice(0, 2));
departWorldShipBundle(f.holding, f.ship, { operationId: "finance-bundle", plan, clockQd: 0 });
f.holding.visibility = "public";
f.holding.gm.playersCanManageShips = true;
const before = JSON.stringify(f.data);
freeze(f.data);
let gmView;
for (const isGM of [true, false]) {
  globalThis.game = { user: { id: isGM ? "gm" : "player", isGM },
    users: [{ id: "gm", isGM: true, active: true }], socket: { emit() { throw new Error("Viewing finance sent a mutation"); } } };
  const overview = prepareShipsContext(f.holding, { data: f.data }).rows[0];
  const detail = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
  assert.equal(overview.financePresentation, undefined, "the fleet overview must not compose financial journals");
  const finance = detail.financePresentation;
  assert.equal(finance.outing.plannedExpenseCopper, plan.totalOperatingCopper,
    "the accepted bundle plan includes every unstarted leg, not only already prepaid travel");
  assert.equal(finance.outing.plannedIncomeCopper, plan.offers.reduce((sum, offer) => sum + offer.contract.rewardCopper, 0));
  assert.equal(finance.outing.plannedDays, plan.totalDurationQd / 4);
  assert.equal(finance.outing.canComparePlan, false, "unpaid promises must not look like realized deviations from a finished plan");
  assert.equal(finance.pendingPayments.length, 2);
  assert.equal(finance.outing.details.filter((row) => ["leg-start", "bundle-plan"].includes(row.kind)).every((row) => !row.hasAmount), true);
  assert.ok(finance.outing.details.find((row) => row.kind === "funding").isTransfer);
  assert.doesNotMatch(finance.outing.details.find((row) => row.kind === "bundle-plan").reason, /\d/,
    "internal copper totals in persisted plan notes must not masquerade as unlabeled player currency");
  if (isGM) gmView = finance;
  else assert.deepEqual(finance, gmView);
}
assert.equal(JSON.stringify(f.data), before, "GM/player finance views leave all ledgers, wallets, time and outcomes unchanged");

const holding = { storage: { moneyCopper: 1000 } };
const ship = { id: "ship", location: { kind: "market" }, onboardCopper: 20, pendingPortBillCopper: 30, idleUpkeepCopperPerDay: 10 };
let money = shipMoneySummary(holding, ship, { returnOffer: { quote: { operatingCopper: 100 } } });
let finance = prepareShipFinancePresentation(holding, ship, { money });
assert.equal(finance.mandatoryShortageCopper, 10);
assert.equal(finance.reserveShortageCopper, 120);
assert.equal(finance.mandatoryShortageCopper + finance.reserveShortageCopper, money.shortageCopper);
money = shipMoneySummary(holding, ship);
finance = prepareShipFinancePresentation(holding, ship, { money });
assert.equal(finance.reserveShortageCopper, null, "an unknown return cost cannot yield an exact reserve deficit");
money = shipMoneySummary(holding, { ...ship, onboardCopper: Infinity });
finance = prepareShipFinancePresentation(holding, ship, { money });
assert.equal(finance.mandatoryShortageCopper, null, "invalid money is not presented as an exact unpaid shortage");

const saved = {
  ...ship,
  activeVoyage: { quote: { contract: { cargo: { name: "Почта" }, rewardCopper: 500 } },
    outcome: { rewardCopper: 250, expenseCopper: 100 }, outcomeApplied: false }
};
finance = prepareShipFinancePresentation(holding, freeze(saved), { money });
assert.equal(finance.pendingPayments[0].amountCopper, 250, "saved outcomes replace nominal promises but are not received money");
assert.match(finance.pendingPayments[0].basisLabel, /сохранённому исходу/);
assert.equal(prepareShipFinancePresentation(holding, { ...saved, activeVoyage: { ...saved.activeVoyage, outcomeApplied: true } }, { money }).pendingPayments.length, 0);

const baseReport = {
  version: 1, id: "sale-start", knownSinceQd: 0, startedAtQd: 0, completedAtQd: 20,
  incomeCopper: 800, expenseCopper: 200, portExpenseCopper: 20, fundingCopper: 1000,
  plannedOperatingCopper: 180, plannedPreparationCopper: 0, plannedRewardCopper: 0, plannedDurationQd: 16,
  returnedCopper: 1600, startedLegs: 2, completedLegs: 2,
  details: [{ kind: "return", clockQd: 20, amountCopper: -1600, reason: "Возврат" },
    { kind: "outing-complete", clockQd: 20, amountCopper: 0, reason: "Дом" }]
};
const sale = { ownShipId: "ship", operationId: "sale-start", upfrontOperationId: "sale-start:upfront",
  upfrontCopper: 70, revenueCopper: 800, marketLabel: "Порт", status: "delivered" };
const finishedShip = { ...ship, activeVoyage: null, lastOuting: baseReport };
const saleHolding = { ...holding, special: { market: { outbound: { orders: [
  { ...sale, ownShipId: "another-ship", upfrontCopper: 900 },
  { ...sale, operationId: "older-sale", upfrontCopper: 999 }, sale
] } } } };
freeze(saleHolding);freeze(finishedShip);
const projected = shipOutingSummary(finishedShip);
finance = prepareShipFinancePresentation(saleHolding, finishedShip, { money, outingReport: projected });
assert.equal(finance.outing.marketExpenseCopper, 70, "only this ship and this outing's paid market receipt belongs to the result");
assert.equal(finance.outing.netCopper, 530);
assert.equal(finance.outing.totalExpenseCopper, 270);
assert.equal(finance.outing.plannedNetCopper, 550);
assert.equal(finance.outing.varianceCopper, -20);
assert.equal(finance.outing.balanceCopper, 1600, "returned cash retains allocated reserves and must remain distinct from earned money");
assert.equal(finance.outing.canComparePlan, true);
assert.equal(finance.outing.details.find((row) => row.kind === "return").displayAmountCopper, 1600);
assert.equal(finance.outing.details.find((row) => row.kind === "outing-complete").hasAmount, false);
assert.equal(projected.netCopper, 600, "the base ledger summary must not be rewritten by the cross-source presentation");
const again = prepareShipFinancePresentation(saleHolding, finishedShip, { money, outingReport: projected });
assert.deepEqual(again, finance, "repeat viewing never counts the market cost a second time");

const missingReceipt = { ...saleHolding, special: { market: { outbound: { orders: [{ ...sale, upfrontOperationId: "" }] } } } };
finance = prepareShipFinancePresentation(missingReceipt, finishedShip, { money, outingReport: projected });
assert.equal(finance.outing.netCopper, 600);
assert.equal(finance.outing.saleCostsUnknown, true, "a price snapshot alone is not evidence that it was paid");
assert.equal(finance.outing.canComparePlan, false);
const partialShip = { ...finishedShip, lastOuting: { ...baseReport, partial: true } };
finance = prepareShipFinancePresentation(saleHolding, partialShip, { money, outingReport: shipOutingSummary(partialShip) });
assert.equal(finance.outing.partial, true);
assert.equal(finance.outing.canComparePlan, false);

const template = readFileSync(new URL("../../templates/parts/ship-window/finance.hbs", import.meta.url), "utf8");
const adjustmentPosition = template.indexOf('data-ship-disclosure="funds:');
assert.ok(template.indexOf("Баланс и обязательства") < adjustmentPosition, "the approved compact balance summary precedes the manual adjustment form");
for (const amount of ["walletGold", "moneySummary.obligationsCopper", "moneySummary.reserveCopper", "moneySummary.freeCopper"]) {
  assert.ok(template.indexOf(amount) < adjustmentPosition, `${amount} is visible before a financial operation`);
}
assert.ok(template.indexOf("Неоплаченные обязательства") > adjustmentPosition, "the approved bill breakdown follows the operation, under a disclosure");
assert.match(template, /report.canComparePlan/);
assert.match(template, /#if hasAmount/);
assert.match(template, /Себестоимость складского груза/);
console.log("Ship finance presentation: full accepted bundle plan, saved versus received payments, bills/reserves, market-fee attribution, transfers, partial records and GM/player read-only parity passed.");
