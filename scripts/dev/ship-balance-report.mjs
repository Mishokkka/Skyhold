import { getShipProfile } from "../engines/ships/profiles.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle } from "../engines/ships/world-market.js";
import { resolveContractOutcome } from "../engines/ships/contracts.js";
import { bundleOperatingShares } from "../engines/ships/bundle-accounting.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOARDS = 240;

function randomSeed(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function fixture({ wage = 12, attention = 0, distanceFactor = 1, profileId = "merchant-barque" } = {}) {
  const { data, holding, ship } = worldMarketFixture();
  const profile = getShipProfile(profileId);
  Object.assign(ship, { profileId, crewTarget: profile.crewTarget, capacityLoadPoints: profile.capacityLoadPoints, speedKmPerDay: profile.speedKmPerDay,
    hiddenCapacityLoadPoints: Math.floor(profile.capacityLoadPoints * 0.05) });
  holding.people.list[0].wageDailyOverrideCopper = wage;
  for (let index = 1; index < profile.crewTarget; index++) {
    const id = `crew-${index}`;
    holding.people.list.push({ id, name: id, wageDailyOverrideCopper: wage });
    ship.crewResidentIds.push(id);
  }
  ship.attentionByDirection = {
    "port:a": { level: attention }, "port:b": { level: attention }
  };
  if (distanceFactor !== 1) {
    for (const region of data.catalog.eventRegions) {
      for (const link of region.marketLinks ?? []) link.distanceKm *= distanceFactor;
    }
  }
  return { data, holding, ship, context: buildShipWorldContext(data, holding) };
}

function expectedAdditionalNet(contract, commercialOnly = false, style = "normal", { fixedIncidentRoll = null, sharedPassageAllowsBonus = true } = {}) {
  let total = 0;
  const incidentRolls = fixedIncidentRoll == null ? Array.from({ length: 12 }, (_, index) => index + 1) : [fixedIncidentRoll];
  for (let first = 1; first <= 6; first++) {
    for (let second = 1; second <= 6; second++) {
      for (const incidentRoll of incidentRolls) {
        const outcome = resolveContractOutcome(contract, style, { commercialDice: [first, second], incidentRoll,
          commercialOnly, sharedPassageAllowsBonus });
        total += outcome.rewardCopper - outcome.expenseCopper;
      }
    }
  }
  return total / (36 * incidentRolls.length);
}

function soloLossChance(offer) {
  const cost = offer.quote.operatingCopper + offer.quote.returnReserveCopper;
  let losses = 0;
  for (let first = 1; first <= 6; first++) {
    for (let second = 1; second <= 6; second++) {
      for (let incidentRoll = 1; incidentRoll <= 12; incidentRoll++) {
        const outcome = resolveContractOutcome(offer.contract, "normal", { commercialDice: [first, second], incidentRoll });
        if (outcome.rewardCopper - outcome.expenseCopper - cost < 0) losses++;
      }
    }
  }
  return losses / 432;
}

function bundleDeliveries(stop, offers, totalOperatingCopper) {
  const shares = bundleOperatingShares(offers, totalOperatingCopper);
  return stop.deliveryOfferIds.map((id) => offers.find((offer) => offer.id === id))
    .sort((left, right) => Number(right.contract.kind === "smuggling") - Number(left.contract.kind === "smuggling")
      || left.id.localeCompare(right.id))
    .map((offer) => ({
      ...offer,
      contract: {
        ...offer.contract,
        guidance: { ...offer.contract.guidance,
          operatingCopper: shares[offers.indexOf(offer)], preparationCopper: 0 }
      }
    }));
}

function pairLossChance(plan, offers, seed) {
  const draw = randomSeed(seed);
  let losses = 0;
  for (let sample = 0; sample < 144; sample++) {
    let net = -plan.totalOperatingCopper - plan.returnReserveCopper;
    for (const stop of plan.stops) {
      const incidentRoll = 1 + Math.floor(draw() * 12);
      let sharedPassageAllowsBonus = true;
      bundleDeliveries(stop, offers, plan.totalOperatingCopper).forEach((offer, index) => {
        const outcome = resolveContractOutcome(offer.contract, "normal", {
          commercialDice: [1 + Math.floor(draw() * 6), 1 + Math.floor(draw() * 6)],
          incidentRoll, commercialOnly: index > 0, sharedPassageAllowsBonus
        });
        if (index === 0) sharedPassageAllowsBonus = outcome.effectiveIncidentRoll >= 8;
        net += outcome.rewardCopper - outcome.expenseCopper;
      });
    }
    if (net < 0) losses++;
  }
  return losses / 144;
}

function scoreBoard({ data, holding, ship, context }, random, period) {
  const offers = generateWorldShipOffers(data, holding, ship, { period, random, context });
  const solo = offers.map((offer) => {
    const cost = offer.quote.operatingCopper + offer.quote.returnReserveCopper;
    const expectedByStyle = Object.fromEntries(["cautious", "normal", "bold"].map((style) =>
      [style, expectedAdditionalNet(offer.contract, false, style) - cost]));
    return {
      kind: offer.kind, fee: offer.contract.rewardCopper,
      operating: offer.quote.operatingCopper, returning: offer.quote.returnReserveCopper,
      nominal: offer.contract.rewardCopper - cost,
      expected: expectedByStyle.normal, expectedByStyle, bestStyleExpected: Math.max(...Object.values(expectedByStyle)),
      bestStyle: Object.entries(expectedByStyle).sort((a, b) => b[1] - a[1])[0][0]
    };
  });
  let bestPair = null;
  let bestPairExpected = null;
  let bestPairPlan = null;
  let bestPairOffers = null;
  for (let first = 0; first < offers.length; first++) {
    for (let second = first + 1; second < offers.length; second++) {
      try {
        const plan = quoteWorldShipBundle(data, holding, ship, [offers[first], offers[second]], { context });
        const nominal = offers[first].contract.rewardCopper + offers[second].contract.rewardCopper
          - plan.totalOperatingCopper - plan.returnReserveCopper;
        bestPair = Math.max(bestPair ?? -Infinity, nominal);
        let expected = -plan.totalOperatingCopper - plan.returnReserveCopper;
        for (const stop of plan.stops) {
          const deliveries = bundleDeliveries(stop, [offers[first], offers[second]], plan.totalOperatingCopper);
          if (!deliveries.length) continue;
          for (let incidentRoll = 1; incidentRoll <= 12; incidentRoll++) {
            const firstOutcome = resolveContractOutcome(deliveries[0].contract, "normal", { commercialDice: [3, 4], incidentRoll });
            const sharedPassageAllowsBonus = firstOutcome.effectiveIncidentRoll >= 8;
            deliveries.forEach((offer, index) => {
              expected += expectedAdditionalNet(offer.contract, index > 0, "normal", {
                fixedIncidentRoll: incidentRoll, sharedPassageAllowsBonus
              }) / 12;
            });
          }
        }
        if (bestPairExpected === null || expected > bestPairExpected) {
          bestPairExpected = expected;
          bestPairPlan = plan;
          bestPairOffers = [offers[first], offers[second]];
        }
      } catch (_error) { /* This pair cannot share the hold or route. */ }
    }
  }
  const bestPositiveSolo = offers.map((offer, index) => ({ offer, expected: solo[index].expected }))
    .sort((a, b) => b.expected - a.expected)[0];
  return {
    offers: offers.length, solo, bestPair, bestPairExpected,
    positiveSoloLossChance: bestPositiveSolo?.expected > 0 ? soloLossChance(bestPositiveSolo.offer) : null,
    positivePairLossChance: bestPairExpected > 0 ? pairLossChance(bestPairPlan, bestPairOffers, period * 101 + 17) : null
  };
}

function percent(part, total) { return Math.round(100 * part / total); }
function average(values) { return +(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(1); }
function chancePercent(values) { return values.length ? percent(values.reduce((sum, value) => sum + value, 0), values.length) : null; }

export function shipBalanceReport({ boards = BOARDS, profileId = "merchant-barque" } = {}) {
  const scenarios = [
    ["обычный экипаж", {}],
    ["дорогой экипаж", { wage: 24 }],
    ["внимание 8", { attention: 8 }],
    ["дальний маршрут", { distanceFactor: 3 }]
  ];
  return scenarios.map(([name, options], scenarioIndex) => {
    const prepared = fixture({ ...options, profileId });
    const rows = Array.from({ length: boards }, (_, index) => scoreBoard(prepared,
      randomSeed(0x51a7 + scenarioIndex * 100003 + index * 997), index));
    const solos = rows.flatMap((row) => row.solo);
    const commissions = solos.filter((row) => row.kind === "commission");
    const freight = solos.filter((row) => row.kind === "freight");
    const smuggling = solos.filter((row) => row.kind === "smuggling");
    const pairs = rows.filter((row) => row.bestPair !== null);
    return {
      scenario: name, boards,
      meanOffers: +(solos.length / boards).toFixed(2), emptyBoards: percent(rows.filter((row) => row.offers === 0).length, boards),
      meanSoloNominal: average(solos.map((offer) => offer.nominal)),
      meanSoloExpected: average(solos.map((offer) => offer.expected)),
      meanCautiousExpected: average(solos.map((offer) => offer.expectedByStyle.cautious)),
      meanBoldExpected: average(solos.map((offer) => offer.expectedByStyle.bold)),
      meanSoloFee: average(solos.map((offer) => offer.fee)),
      meanSoloOperating: average(solos.map((offer) => offer.operating)),
      meanSoloReturn: average(solos.map((offer) => offer.returning)),
      boardsWithPositiveSoloExpected: percent(rows.filter((row) => row.solo.some((offer) => offer.expected > 0)).length, boards),
      lossChanceOnPositiveSolo: chancePercent(rows.map((row) => row.positiveSoloLossChance).filter((value) => value !== null)),
      boardsWithPositiveAnyStyle: percent(rows.filter((row) => row.solo.some((offer) => offer.bestStyleExpected > 0)).length, boards),
      boldBestShare: percent(solos.filter((offer) => offer.bestStyle === "bold").length, Math.max(1, solos.length)),
      cautiousBestShare: percent(solos.filter((offer) => offer.bestStyle === "cautious").length, Math.max(1, solos.length)),
      positiveSoloExpected: percent(solos.filter((offer) => offer.expected > 0).length, Math.max(1, solos.length)),
      positiveFreightExpected: percent(freight.filter((offer) => offer.expected > 0).length, Math.max(1, freight.length)),
      positiveSmugglingExpected: percent(smuggling.filter((offer) => offer.expected > 0).length, Math.max(1, smuggling.length)),
      meanSmugglingFee: average(smuggling.map((offer) => offer.fee)),
      meanSmugglingExpected: average(smuggling.map((offer) => offer.expected)),
      meanCommissionNominal: average(commissions.map((offer) => offer.nominal)),
      positiveCommissionExpected: percent(commissions.filter((offer) => offer.expected > 0).length, Math.max(1, commissions.length)),
      feasiblePairs: percent(pairs.length, boards), meanBestPairNominal: average(pairs.map((row) => row.bestPair)),
      positivePairNominal: percent(pairs.filter((row) => row.bestPair > 0).length, Math.max(1, pairs.length)),
      meanBestPairExpected: average(pairs.map((row) => row.bestPairExpected)),
      positivePairExpected: percent(pairs.filter((row) => row.bestPairExpected > 0).length, Math.max(1, pairs.length)),
      lossChanceOnPositivePair: chancePercent(rows.map((row) => row.positivePairLossChance).filter((value) => value !== null))
    };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const row of shipBalanceReport()) console.log(JSON.stringify(row));
}
