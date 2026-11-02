import { getShipProfile, calculateShipCosts } from "../engines/ships/profiles.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, quoteWorldShipRelocation, quoteWorldShipReturn } from "../engines/ships/world-market.js";
import { contractGuidance, resolveContractOutcome } from "../engines/ships/contracts.js";
import { resolveBundlePassages } from "../engines/ships/bundle-incidents.js";
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

function weightedOutcomes(contract, style = "normal", commercialOnly = false) {
  const probability = contractGuidance(contract, style).riskBps / 10000;
  const approachBps = Math.min(10000, Math.ceil((contract.economics.approachRiskBps ?? 0) * (style === "cautious" ? 0.75 : style === "bold" ? 1.5 : 1)));
  const outcomes = [];
  for (let first = 1; first <= 6; first++) for (let second = 1; second <= 6; second++) {
    for (let incidentRoll = 1; incidentRoll <= 12; incidentRoll++) {
      for (const [passageRoll, probabilityWeight] of [[1, approachBps / 10000],
        [Math.min(10000, approachBps + 1), probability - approachBps / 10000], [10000, 1 - probability]]) {
        if (!probabilityWeight) continue;
        outcomes.push({ weight: probabilityWeight / 432, outcome: resolveContractOutcome(contract, style,
          { commercialDice: [first, second], incidentRoll, passageRoll, commercialOnly }) });
      }
    }
  }
  return outcomes;
}

function expectedAdditionalNet(contract, commercialOnly = false, style = "normal") {
  return weightedOutcomes(contract, style, commercialOnly).reduce((sum, row) => sum + row.weight
    * (row.outcome.rewardCopper - row.outcome.expenseCopper), 0);
}

function soloLossChance(offer) {
  const cost = offer.quote.operatingCopper + offer.quote.returnReserveCopper;
  return weightedOutcomes(offer.contract).reduce((sum, row) => sum + (row.outcome.rewardCopper - row.outcome.expenseCopper < cost ? row.weight : 0), 0);
}

function pairExpectedNet(plan, offers) {
  let expected = -plan.totalOperatingCopper - plan.returnReserveCopper;
  for (const stop of plan.stops) {
    expected += expectedAdditionalNet({ kind: "freight", rewardCopper: 0, economics: stop.economics, guidance: {} });
  }
  for (const offer of offers) {
    let distribution = new Map([[10000, 1]]);
    for (const stop of plan.stops.filter(row => row.cargoOfferIds.includes(offer.id))) {
      const damageChance = stop.economics.riskBps / 10000 / 6;
      const next = new Map();
      for (const [bps, probability] of distribution) {
        for (const [key, weight] of [[bps, 1 - damageChance], [Math.floor(bps * 0.75), damageChance]]) {
          next.set(key, (next.get(key) ?? 0) + probability * weight);
        }
      }
      distribution = next;
    }
    for (let first = 1; first <= 6; first++) for (let second = 1; second <= 6; second++) {
      for (const [bps, probability] of distribution) expected += probability / 36 * resolveContractOutcome(offer.contract, "normal", {
        commercialDice: [first, second], incidentRoll: 12, passageRoll: 10000, commercialOnly: true,
        sharedIncident: { eventId: "shared-passage", eventLabel: "Shared", cargoRewardPercent: bps / 100, delayQd: 0, damagePercent: 0 }
      }).rewardCopper;
    }
  }
  return expected;
}

function pairLossChance(plan, offers, seed) {
  const draw = randomSeed(seed);
  let losses = 0;
  for (let sample = 0; sample < 144; sample++) {
    let net = -plan.totalOperatingCopper - plan.returnReserveCopper;
    const bundle = { stops: structuredClone(plan.stops), orders: offers.map(offer => ({ offerId: offer.id, offer, style: "normal" })) };
    for (const [index, stop] of bundle.stops.entries()) {
      bundle.nextStopIndex = index + 1;
      if (!stop.deliveryOfferIds.length) continue;
      const physical = resolveBundlePassages(bundle, stop, draw);
      net -= physical.expenseCopper;
      for (const order of bundle.orders.filter(row => stop.deliveryOfferIds.includes(row.offerId))) {
        const outcome = resolveContractOutcome(order.offer.contract, "normal", {
          commercialDice: [1 + Math.floor(draw() * 6), 1 + Math.floor(draw() * 6)], incidentRoll: 12, passageRoll: 10000,
          commercialOnly: true, sharedIncident: { eventId: "shared-passage", eventLabel: "Shared",
            cargoRewardPercent: (order.cargoRewardBps ?? 10000) / 100, delayQd: physical.delayQd, damagePercent: 0 }
        });
        order.outcomeApplied = true;
        net += outcome.rewardCopper;
      }
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
        const expected = pairExpectedNet(plan, [offers[first], offers[second]]);
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

/** One 240-day trading season: paid port-to-port work, unpaid approach/return and retained crew during idle time. */
export function shipTradingYearReport({ profileId = "merchant-barque", wage = 12, seed = 8192 } = {}) {
  const f = fixture({ profileId, wage }), draw = randomSeed(seed);
  const profile = getShipProfile(profileId);
  const move = quoteWorldShipRelocation(f.data, f.holding, f.ship, "a", { context: f.context });
  let clockQd = move.quote.durationQd, expenses = move.quote.operatingCopper, income = 0, idleQd = 0, jobs = 0;
  const boards = new Map(), consumed = new Set();
  f.ship.location = move.to; f.ship.timelineQd = clockQd;
  while (clockQd < 960) {
    const home = quoteWorldShipReturn(f.data, f.holding, f.ship, { context: f.context });
    const period = Math.floor(clockQd / 40), key = `${f.ship.location.id}:${period}`;
    if (!boards.has(key)) boards.set(key, generateWorldShipOffers(f.data, f.holding, f.ship, { period, random: draw, context: f.context }));
    const offers = boards.get(key).filter(offer => !consumed.has(offer.id));
    const available = offers.filter(offer => offer.quote.durationQd + home.quote.durationQd + clockQd + 20 <= 960)
      .map(offer => ({ offer, net: expectedAdditionalNet(offer.contract) - offer.quote.operatingCopper }))
      .filter(row => row.net > 0)
      .sort((a, b) => b.net / b.offer.quote.durationQd - a.net / a.offer.quote.durationQd);
    if (!available.length) {
      if (clockQd + 4 + home.quote.durationQd > 960) break;
      idleQd += 4; clockQd += 4; f.ship.timelineQd = clockQd; continue;
    }
    const offer = available[0].offer;
    consumed.add(offer.id);
    const outcome = resolveContractOutcome(offer.contract, "normal", {
      commercialDice: [1 + Math.floor(draw() * 6), 1 + Math.floor(draw() * 6)],
      incidentRoll: 1 + Math.floor(draw() * 12), passageRoll: 1 + Math.floor(draw() * 10000)
    });
    expenses += offer.quote.operatingCopper + outcome.expenseCopper; income += outcome.rewardCopper; jobs++;
    clockQd += offer.quote.durationQd + outcome.delayQd;
    f.ship.location = offer.to; f.ship.timelineQd = clockQd;
  }
  const home = quoteWorldShipReturn(f.data, f.holding, f.ship, { context: f.context });
  expenses += home.quote.operatingCopper; clockQd += home.quote.durationQd;
  if (clockQd > 960) throw new Error("Trading season exceeded its reserved return time");
  idleQd += 960 - clockQd;
  expenses += calculateShipCosts(f.ship, { durationQd: idleQd, crewCount: profile.crewTarget, foodUnitCopper: 9, wageDailyCopper: wage }).totalCopper;
  return { profileId, days: 240, jobs, idleDays: idleQd / 4, incomeCopper: income, expenseCopper: expenses, netCopper: income - expenses };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const row of shipBalanceReport()) console.log(JSON.stringify(row));
  for (const profileId of ["cutter", "schooner", "merchant-barque"]) console.log(JSON.stringify(shipTradingYearReport({ profileId })));
}
