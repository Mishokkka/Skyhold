import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { preparePoliticsPeriod, refreshPoliticsPeriodEffects, finishPoliticsPeriod, politicsTributeObligation } from "../engines/politics/period.js";
import { politicsRuntimeEffects } from "../engines/politics/runtime-effects.js";
import { resolveFoodRation } from "../engines/economy/food-rations.js";
import { prepareFinancePeriod } from "../engines/economy/finance-period.js";

export function checkPoliticsPeriod() {
  const holding = mergeHoldingDefaults({ id: "politics-period" });
  holding.storage.moneyCopper = 100;
  holding.politics.directives.external = "external-network";
  holding.politics.directives.supply = "ration-generous";
  holding.politics.activeDecrees = [{ decreeId: "festival", issuedPeriodIndex: 1, expiresPeriodIndex: 2 }];
  const context = { available: true, culture: 20, townHallActive: false };
  const prepared = preparePoliticsPeriod(holding, { context, periodIndex: 1 });
  assert.equal(holding.storage.moneyCopper, 40, "network upkeep is charged once on the draft");
  assert.equal(prepared.networkPaid, true);
  assert.equal(prepared.charges[0].copper, 60);
  assert.equal(politicsRuntimeEffects(holding).foodMultiplier, 1.15);
  assert.equal(politicsRuntimeEffects(clone(holding)), null, "preview effects must not persist in world data");
  const ration = resolveFoodRation({ residents: 20, days: 10, available: 500, multiplier: prepared.effects.foodMultiplier });
  assert.equal(ration.selectedTarget, 230, "political food need reaches the normal ration calculator");
  assert.equal(refreshPoliticsPeriodEffects(holding, prepared, { rationFullySupplied: true }).morale, 5);
  const finished = finishPoliticsPeriod(holding, prepared, { operationId: "first" });
  assert.equal(finished.ok, true);
  assert.equal(finished.results[0].gained, 2);
  assert.deepEqual(finished.results[0].expiredDecreeIds, ["festival"]);
  assert.equal(holding.politics.influence, 2);
  assert.equal(holding.politics.lastNetworkPaidPeriodIndex, 1);
  assert.equal(holding.politics.lastProcessedPeriodIndex, 1);
  assert.equal(finishPoliticsPeriod(holding, prepared, { operationId: "first" }).results[0].replay, true);

  const unpaid = preparePoliticsPeriod(holding, { context, periodIndex: 2 });
  assert.equal(holding.storage.moneyCopper, 40);
  assert.deepEqual(unpaid.unpaidDirectiveIds, ["external-network"]);
  assert.equal(unpaid.networkPaid, false);
  assert.equal(finishPoliticsPeriod(holding, unpaid, { operationId: "second" }).results[0].gained, 1);
  assert.equal(holding.politics.lastNetworkPaidPeriodIndex, 1, "unpaid network cannot refresh the access marker");

  const suspended = preparePoliticsPeriod(holding, { context: { ...context, available: false }, periodIndex: 3 });
  assert.equal(suspended.charges.length, 0);
  assert.equal(suspended.effects.foodMultiplier, 1);
  assert.equal(finishPoliticsPeriod(holding, suspended, { operationId: "third" }).results[0].gained, 0);

  const dormant = mergeHoldingDefaults({ id: "dormant" });
  const inactive = preparePoliticsPeriod(dormant, { context: { available: false }, periodIndex: 1 });
  assert.equal(finishPoliticsPeriod(dormant, inactive).skipped, true);
  assert.equal(dormant.politics.lastProcessedPeriodIndex, 0);

  const vacant = mergeHoldingDefaults({ id: "vacant" });
  vacant.politics.directives.order = "strong";
  const vacantPeriod = preparePoliticsPeriod(vacant, { context, periodIndex: 1 });
  finishPoliticsPeriod(vacant, vacantPeriod, { operationId: "vacant-period" });
  assert.equal(vacant.politics.directives.order, "", "an invalid personal directive is cleared after the period");
  assert.equal(vacant.politics.history.at(-1).type, "directive-cleared");
  assert.match(vacant.politics.history.at(-2).summary, /Влияние/);

  const charter = mergeHoldingDefaults({ id: "charter-debt" });
  charter.politics.charter.tributeCopper = 60;
  charter.politics.charter.tributeStartPeriodIndex = 2;
  charter.politics.charter.tributeEndPeriodIndex = 3;
  assert.equal(politicsTributeObligation(charter, { periodKey: "tenday:1", periodIndex: 1 }), null);
  const due = politicsTributeObligation(charter, { periodKey: "tenday:2", periodIndex: 2 });
  const firstFinance = prepareFinancePeriod({ finance: charter.finance, treasuryCopper: 30,
    periodKey: "tenday:2", periodIndex: 2, additionalObligations: [due] });
  assert.equal(firstFinance.paidCopper, 0, "current tribute uses the finance system's atomic payment rule");
  assert.equal(firstFinance.outstandingCopper, 60, "unpaid tribute survives as an ordinary finance debt");
  const replay = prepareFinancePeriod({ finance: firstFinance.finance, treasuryCopper: 0,
    periodKey: "tenday:2", periodIndex: 2, additionalObligations: [due] });
  assert.equal(replay.finance.obligations.length, 1, "the same charter period has one stable obligation");
  assert.equal(replay.outstandingCopper, 60);
  const nextDue = politicsTributeObligation(charter, { periodKey: "tenday:3", periodIndex: 3 });
  const nextFinance = prepareFinancePeriod({ finance: firstFinance.finance, treasuryCopper: 90,
    periodKey: "tenday:3", periodIndex: 3, additionalObligations: [nextDue] });
  assert.equal(nextFinance.paidCopper, 60, "old tribute debt is repaid before the current obligation");
  assert.equal(nextFinance.outstandingCopper, 60);
  assert.equal(politicsTributeObligation(charter, { periodKey: "tenday:4", periodIndex: 4 }), null);
  const lastFinance = prepareFinancePeriod({ finance: nextFinance.finance, treasuryCopper: 60,
    periodKey: "tenday:4", periodIndex: 4 });
  assert.equal(lastFinance.outstandingCopper, 0, "an expired charter retains its old debt until payment");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkPoliticsPeriod();
  console.log("Politics period check passed.");
}
