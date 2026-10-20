import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  attentionLabel, attentionLevel, contractGuidance, generateShipOffers, resolveContractOutcome
} from "../engines/ships/contracts.js";
import { adjustShipFunds, advanceShipVoyages, departShip, resolveShipContract } from "../engines/ships/runtime.js";

function fixture(attention = 0) {
  const ship = {
    id: "magnifique", name: "Магнифик", status: "docked", condition: "ready", onboardCopper: 0,
    speedKmPerDay: 150,
    routePlan: {
      destination: "Восточная гавань", directionKey: "east", distanceKm: 150, portDays: 1,
      preparationCopper: 20, upkeepPerDayCopper: 10, rewardCopper: 150
    },
    attentionByDirection: { east: { level: attention } }, activeVoyage: null
  };
  return {
    holding: {
      storage: { moneyCopper: 1000 }, gm: { calendaria: { lastQd: 0 } },
      special: { ships: { list: [ship], history: [] } }
    },
    ship
  };
}

export function checkShipContractsCharacterization() {
  assert.equal(attentionLevel({ attentionByDirection: { east: 7 } }, "east"), 7);
  assert.equal(attentionLevel({ attentionByDirection: Object.create({ east: 10 }) }, "east"), 0);
  assert.equal(attentionLabel(10), "Центр внимания");

  const low = fixture(0).ship;
  const high = fixture(10).ship;
  const lowOffers = generateShipOffers(low, { period: "882-1", random: () => 0.3 });
  const highOffers = generateShipOffers(high, { period: "882-1", random: () => 0.3 });
  assert.equal(lowOffers.length, 4);
  assert.equal(new Set(lowOffers.map((offer) => offer.id)).size, 4);
  assert.equal(lowOffers.filter((offer) => offer.kind === "smuggling").length, 0);
  assert.equal(highOffers.filter((offer) => offer.kind === "smuggling").length, 2);
  assert.ok(highOffers.filter((offer) => offer.kind === "smuggling").every((offer) => offer.rewardCopper > low.routePlan.rewardCopper));
  assert.ok(Object.isFrozen(lowOffers) && Object.isFrozen(lowOffers[0]) && Object.isFrozen(lowOffers[0].routePlan));
  assert.equal(lowOffers[0].speedKmPerDay, 150);
  assert.equal(lowOffers[0].durationQd, 12);
  assert.match(lowOffers[0].directionKey, /^east$/);

  const fallback = structuredClone(low);
  delete fallback.routePlan.directionKey;
  assert.match(generateShipOffers(fallback, { period: "882-2", random: () => 0.3 })[0].directionKey, /^destination:/);

  const styles = ["cautious", "normal", "bold"];
  const kinds = ["freight", "commission", "smuggling"];
  for (const attention of [0, 10]) {
    for (const kind of kinds) {
      const contract = structuredClone(generateShipOffers(fixture(attention).ship, { period: `matrix-${attention}`, random: () => 0.3 })[0]);
      contract.kind = kind;
      for (const style of styles) {
        const guidance = contractGuidance(contract, style);
        let maximumExpense = 0;
        let hasLoss = false;
        let minimumReward = Number.MAX_SAFE_INTEGER;
        let maximumReward = 0;
        for (let first = 1; first <= 6; first++) {
          for (let second = 1; second <= 6; second++) {
            for (let incidentRoll = 1; incidentRoll <= 12; incidentRoll++) {
              const outcome = resolveContractOutcome(contract, style, { commercialDice: [first, second], incidentRoll });
              assert.ok(Number.isSafeInteger(outcome.rewardCopper) && outcome.rewardCopper >= 0);
              assert.ok(Number.isSafeInteger(outcome.expenseCopper) && outcome.expenseCopper >= 0);
              assert.ok(outcome.delayQd >= 0 && outcome.attentionDelta >= -4 && outcome.attentionDelta <= 4);
              maximumExpense = Math.max(maximumExpense, outcome.expenseCopper);
              minimumReward = Math.min(minimumReward, outcome.rewardCopper);
              maximumReward = Math.max(maximumReward, outcome.rewardCopper);
              hasLoss ||= outcome.rewardCopper < outcome.expenseCopper;
            }
          }
        }
        assert.ok(hasLoss, `${kind}/${style}/${attention} must include a real loss`);
        assert.ok(guidance.suggestedBudgetCopper - guidance.operatingCopper >= maximumExpense, `${kind}/${style}/${attention} reserve must cover catalogued outcomes`);
        assert.ok(guidance.rewardRangeCopper.min <= minimumReward);
        assert.ok(guidance.rewardRangeCopper.max >= maximumReward);
      }
      const cautiousBest = resolveContractOutcome(contract, "cautious", { commercialDice: [6, 6], incidentRoll: 12 });
      const boldBest = resolveContractOutcome(contract, "bold", { commercialDice: [6, 6], incidentRoll: 12 });
      assert.ok(boldBest.rewardCopper > cautiousBest.rewardCopper, `${kind} bold must have more upside`);
      const cautiousWorst = resolveContractOutcome(contract, "cautious", { commercialDice: [1, 1], incidentRoll: 1 });
      const boldWorst = resolveContractOutcome(contract, "bold", { commercialDice: [1, 1], incidentRoll: 1 });
      const normalWorst = resolveContractOutcome(contract, "normal", { commercialDice: [1, 1], incidentRoll: 1 });
      assert.ok(boldWorst.rewardCopper <= cautiousWorst.rewardCopper && boldWorst.expenseCopper > normalWorst.expenseCopper, `${kind} bold must add a loss surcharge after a severe incident`);
      const cautiousWithoutIncident = resolveContractOutcome(contract, "cautious", { commercialDice: [1, 1], incidentRoll: 1, commercialOnly: true });
      const normalWithoutIncident = resolveContractOutcome(contract, "normal", { commercialDice: [1, 1], incidentRoll: 1, commercialOnly: true });
      assert.ok(cautiousWithoutIncident.expenseCopper > normalWithoutIncident.expenseCopper, `${kind} precautions must have a known extra cost`);
      const cleanCompanion = resolveContractOutcome(contract, "bold", { commercialDice: [6, 6], incidentRoll: 12,
        commercialOnly: true, sharedPassageAllowsBonus: true });
      const delayedCompanion = resolveContractOutcome(contract, "bold", { commercialDice: [6, 6], incidentRoll: 12,
        commercialOnly: true, sharedPassageAllowsBonus: false });
      assert.ok(cleanCompanion.rewardCopper > delayedCompanion.rewardCopper,
        `${kind} a companion order cannot earn the fast-delivery bonus after a shared incident`);
    }
  }
  const allIncidents = new Set();
  const neutral = structuredClone(lowOffers[0]);
  for (let incidentRoll = 1; incidentRoll <= 12; incidentRoll++) {
    allIncidents.add(resolveContractOutcome(neutral, "normal", { commercialDice: [3, 4], incidentRoll }).eventId);
  }
  assert.equal(allIncidents.size, 12);
  assert.throws(() => resolveContractOutcome(neutral, "normal", { commercialDice: [0, 7], incidentRoll: 1 }), /кубик/);

  const first = fixture(0);
  const accepted = generateShipOffers(first.ship, { period: "882-3", random: () => 0.3 })[0];
  departShip(first.holding, first.ship, { operationId: "voyage", budgetCopper: 100, clockQd: 0, offer: accepted, style: "normal" });
  first.ship.routePlan.rewardCopper = 999999;
  assert.equal(advanceShipVoyages(first.holding, 12).awaiting.length, 1);
  assert.equal(first.ship.activeVoyage.awaitingOutcome, true);
  assert.equal(first.ship.onboardCopper, 70);
  let draws = 0;
  const pending = resolveShipContract(first.holding, first.ship, { operationId: "resolve-1", random: () => { draws++; return 0; } });
  assert.equal(draws, 3);
  assert.equal(pending.pending, true);
  assert.equal(pending.waitingFunds, true);
  assert.equal(first.ship.activeVoyage.outcome.expenseCopper, 90);
  const frozenOutcome = structuredClone(first.ship.activeVoyage.outcome);
  assert.equal(advanceShipVoyages(first.holding, 100).awaiting[0].waitingFunds, true);
  assert.deepEqual(first.ship.activeVoyage.outcome, frozenOutcome);
  adjustShipFunds(first.holding, first.ship, { operationId: "rescue", voyageId: "voyage", kind: "income", amountCopper: 20, reason: "Резерв капитана" });
  const applied = resolveShipContract(first.holding, first.ship, { operationId: "resolve-2", random: () => { throw new Error("outcome rerolled"); } });
  assert.equal(applied.pending, false);
  assert.equal(applied.delayQd, 8);
  assert.equal(applied.returned, null);
  assert.deepEqual(applied.outcome, frozenOutcome);
  assert.equal(first.ship.activeVoyage.remainingQd, 8);
  assert.equal(first.ship.activeVoyage.lastProcessedQd, 100);
  assert.equal(first.ship.attentionByDirection.east.level, 3);
  const completion = advanceShipVoyages(first.holding, 108);
  assert.equal(completion.returned.length, 1);
  assert.equal(first.ship.activeVoyage, null);
  assert.equal(first.holding.special.ships.history.length, 1);
  assert.equal(first.holding.special.ships.history[0].outcome.eventId, "shipment-rejected");
  const balanceAfterReturn = first.holding.storage.moneyCopper;
  assert.equal(advanceShipVoyages(first.holding, 200).returned.length, 0);
  assert.equal(first.holding.storage.moneyCopper, balanceAfterReturn);

  const direct = fixture(0);
  const directOffer = generateShipOffers(direct.ship, { period: "882-4", random: () => 0.3 })[0];
  departShip(direct.holding, direct.ship, { operationId: "direct", budgetCopper: 300, clockQd: 0, offer: directOffer, style: "normal" });
  advanceShipVoyages(direct.holding, 12);
  const immediate = resolveShipContract(direct.holding, direct.ship, { operationId: "direct-resolution", random: () => 0.999 });
  assert.equal(immediate.pending, false);
  assert.ok(immediate.returned);
  assert.equal(direct.ship.status, "docked");

  const chunked = fixture(0);
  const batched = fixture(0);
  const chunkOffer = generateShipOffers(chunked.ship, { period: "same", random: () => 0.3 })[0];
  const batchOffer = generateShipOffers(batched.ship, { period: "same", random: () => 0.3 })[0];
  departShip(chunked.holding, chunked.ship, { operationId: "same", budgetCopper: 300, clockQd: 0, offer: chunkOffer });
  departShip(batched.holding, batched.ship, { operationId: "same", budgetCopper: 300, clockQd: 0, offer: batchOffer });
  advanceShipVoyages(chunked.holding, 4);
  advanceShipVoyages(chunked.holding, 12);
  advanceShipVoyages(batched.holding, 12);
  assert.deepEqual(chunked, batched);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkShipContractsCharacterization();
  console.log("Ship contracts passed: offers, attention, exhaustive outcomes, frozen pending results, delays and idempotent return.");
}
