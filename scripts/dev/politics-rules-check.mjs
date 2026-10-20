import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizePoliticsState } from "../data/politics-state.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { clone } from "../data/utils.js";
import { isPlayerWritablePath } from "../data/player-write-guard.js";
import { applyPoliticsAct } from "../engines/politics/acts.js";
import {
  advancePoliticsStateForPeriod,
  advancePoliticsStateForPeriods,
  changePoliticsDirective,
  politicsActiveDecrees,
  politicsAllowedSlots,
  politicsDecreePreflight,
  politicsDecreeQuote,
  politicsEffects,
  politicsInfluenceGain,
  politicsPeriodIndex,
  politicsRepresentativeStatus,
  politicsSystemPermitted,
  validatePoliticsCompetencies
} from "../engines/politics/rules.js";

export function checkPoliticsRules() {
  const holding = mergeHoldingDefaults({ id: "politics-rules", people: { list: [{ id: "speaker", name: "Спикер" }] } });
  holding.politics = normalizePoliticsState();
  assert.equal(holding.politics.version, 1);
  assert.equal(isPlayerWritablePath("holdings.0.politics.influence", { holdings: [holding] }, { holdings: [holding] }), false);
  assert.equal(isPlayerWritablePath("holdings.0.politics.activeDecrees.0", { holdings: [holding] }, { holdings: [holding] }), false);
  assert.deepEqual(politicsAllowedSlots(holding.politics), ["supply", "order", "external"]);
  assert.equal(politicsPeriodIndex(0), 1);
  assert.equal(politicsPeriodIndex(39), 1);
  assert.equal(politicsPeriodIndex(40), 2);

  const preserved = normalizePoliticsState({
    stage: "charter",
    charter: { allowedSlots: ["labor", "order"] },
    directives: { labor: "future-directive" },
    activeDecrees: [{ decreeId: "future-decree", issuedPeriodIndex: 1, expiresPeriodIndex: 3 }],
    history: [{ id: "existing", type: "unknown-event" }]
  });
  assert.deepEqual(politicsAllowedSlots(preserved), ["order", "labor"]);
  assert.equal(preserved.directives.labor, "future-directive", "unknown catalog IDs must survive normal loading");
  assert.equal(preserved.activeDecrees[0].decreeId, "future-decree");
  assert.equal(politicsActiveDecrees(preserved, 1).length, 0, "unknown decrees must have no effect");
  assert.equal(advancePoliticsStateForPeriod(preserved, { periodIndex: 2 }).state.activeDecrees.length, 0,
    "a disabled or unknown decree still expires at its paid boundary");
  assert.equal(preserved.history[0].id, "existing", "normal loading must retain history");
  const reloaded = mergeHoldingDefaults({ id: "politics-reload", politics: { ...preserved, version: 2, futureField: { enabled: true } } });
  assert.equal(reloaded.politics.version, 2, "loading must not downgrade a future politics version");
  assert.equal(reloaded.politics.directives.labor, "future-directive");
  assert.deepEqual(reloaded.politics.futureField, { enabled: true });
  const draft = clone(DEFAULT_SKYHOLD_DATA);
  draft.holdings[0].politics = preserved;
  const committed = prepareSkyholdCommit(draft, { scope: "holdings", baseRevision: 0 }).data;
  assert.equal(committed.holdings[0].politics.directives.labor, "future-directive", "a holdings commit must retain politics data");
  assert.equal(committed.holdings[0].politics.history[0].id, "existing");
  assert.equal(politicsSystemPermitted({ stage: "selfRule", system: "governor" }), false);
  assert.equal(politicsSystemPermitted({ stage: "selfRule", system: "governor", governorInvited: true }), true);

  assert.equal(validatePoliticsCompetencies({ economy: 3, war: 1, diplomacy: -2, culture: 0 }).ok, true);
  assert.equal(validatePoliticsCompetencies({ economy: 3, war: 2, diplomacy: -2, culture: 0 }).ok, false);
  assert.equal(validatePoliticsCompetencies({ economy: 0, war: 0, diplomacy: -3, culture: 0 }).ok, false);

  const state = normalizePoliticsState({
    stage: "selfRule",
    system: "elected-head",
    representative: { residentId: "speaker", appointedPeriodIndex: 1, competencies: { economy: 3, war: -1, diplomacy: 0, culture: 1 } },
    directives: { supply: "ration-generous", order: "gates-open", labor: "labor-festivals", external: "external-network" },
    influence: 5,
    activeDecrees: [{ decreeId: "fair", issuedPeriodIndex: 1, expiresPeriodIndex: 3 }]
  });
  holding.politics = state;
  assert.equal(politicsRepresentativeStatus(state, holding, 12).expired, false);
  assert.equal(politicsRepresentativeStatus(state, holding, 13).expired, true);
  const effects = politicsEffects(holding, { available: true, periodIndex: 2, marketActive: true, networkPaid: true, rationFullySupplied: false });
  assert.equal(effects.morale, 5, "system, representative and rest apply; generous food requires full supply");
  assert.equal(effects.reputation, 2, "open gates and fair add once each");
  assert.equal(effects.productionPercent, 1, "representative production and rest penalty are separate percentage points");
  assert.equal(effects.foodMultiplier, 1.15);
  assert.equal(effects.networkPaid, true);
  const invalidSkills = { ...state, representative: { ...state.representative, competencies: { economy: 3, war: 3, diplomacy: 0, culture: 0 } } };
  assert.equal(politicsEffects({ ...holding, politics: invalidSkills }, { available: true, periodIndex: 2 }).productionPercent, -5, "invalid stored skills cannot grant bonuses");
  assert.equal(politicsEffects(holding, { available: false, periodIndex: 2 }).morale, 0, "suspension disables bonuses");
  assert.equal(politicsActiveDecrees(state, 3).length, 0, "the original paid term ends at the boundary");
  assert.deepEqual(politicsDecreeQuote("festival", 20), { decreeId: "festival", copper: 200, influence: 0, food: 40, duration: 1 });
  assert.equal(politicsDecreeQuote("unknown", 20), null);

  const rest = politicsInfluenceGain(state, { available: true, networkPaid: true, representativeCulture: 2 });
  assert.equal(rest.gained, 0, "days of rest suppress regular Influence");
  state.directives.labor = "";
  const gain = politicsInfluenceGain(state, { available: true, networkPaid: true, representativeCulture: 2 });
  assert.equal(gain.nominal, 2, "two bonus sources still yield only one extra Influence");
  assert.equal(gain.gained, 1, "gain respects the cap");
  assert.equal(gain.overlappingSources, true);
  assert.equal(politicsInfluenceGain({ ...state, influence: 9 }, { available: true, townHallActive: true, culture: 30 }).gained, 1);
  assert.equal(politicsInfluenceGain({ ...state, influence: 9 }, { available: false, townHallActive: true, culture: 30 }).gained, 0);

  const directive = changePoliticsDirective(holding.politics, { slot: "order", directiveId: "gates-permits", periodIndex: 2, available: true });
  assert.equal(directive.ok, true);
  assert.equal(changePoliticsDirective(directive.state, { slot: "order", directiveId: "gates-permits", periodIndex: 2, available: true }).noop, true);
  assert.equal(changePoliticsDirective(directive.state, { slot: "order", directiveId: "gates-closed", periodIndex: 2, available: true }).ok, false);
  assert.equal(changePoliticsDirective(directive.state, { slot: "order", directiveId: "outside-catalog", periodIndex: 3, available: true }).ok, false);

  const paid = normalizePoliticsState({ influence: 1, activeDecrees: [{ decreeId: "fair", issuedPeriodIndex: 1, expiresPeriodIndex: 3 }], decreeCooldownUntil: { fair: 3 } });
  assert.equal(politicsDecreePreflight(paid, { decreeId: "fair", periodIndex: 2, available: true, marketActive: true, moneyCopper: 300 }).ok, false);
  const cancelled = { ...paid, activeDecrees: [] };
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "fair", periodIndex: 2, available: true, marketActive: true, moneyCopper: 300 }).ok, false, "cancellation cannot bypass the original term");
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "fair", periodIndex: 3, available: true, marketActive: true, moneyCopper: 300 }).ok, true);
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "fair", periodIndex: 3, available: true, marketActive: true, moneyCopper: 299 }).reason, "Недостаточно медных монет в казне.");
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "fair", periodIndex: 3, available: true, marketActive: true, moneyCopper: 300, population: 20, foodAvailable: 0 }).ok, true);
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "festival", periodIndex: 3, available: true, moneyCopper: 200, population: 20, foodAvailable: 39 }).ok, false);
  assert.equal(politicsDecreePreflight(cancelled, { decreeId: "festival", periodIndex: 3, available: true, moneyCopper: 200, population: 20, foodAvailable: 40 }).ok, true);

  const beforePeriod = normalizePoliticsState({ influence: 5, activeDecrees: [{ decreeId: "fair", issuedPeriodIndex: 1, expiresPeriodIndex: 2 }] });
  const period1 = advancePoliticsStateForPeriod(beforePeriod, { periodIndex: 1, available: true, networkPaid: true });
  assert.equal(period1.gained, 1, "the regular cap applies at the end of period one");
  assert.deepEqual(period1.expiredDecreeIds, ["fair"]);
  assert.equal(advancePoliticsStateForPeriod(period1.state, { periodIndex: 1, available: true }).replay, true);
  const period2 = advancePoliticsStateForPeriod(period1.state, { periodIndex: 2, available: false });
  assert.equal(period2.gained, 0, "suspension does not grant Influence");
  assert.equal(period2.state.lastProcessedPeriodIndex, 2);
  assert.equal(advancePoliticsStateForPeriod(period2.state, { periodIndex: 4, available: true }).ok, false);
  const contexts = [
    { periodIndex: 1, available: true, networkPaid: true },
    { periodIndex: 2, available: false },
    { periodIndex: 3, available: true }
  ];
  const batch = advancePoliticsStateForPeriods(beforePeriod, contexts);
  const sequential = contexts.reduce((current, context) => advancePoliticsStateForPeriod(current, context).state, beforePeriod);
  assert.deepEqual(batch.state, sequential, "batch and sequential politics periods must produce the same state");

  const actHolding = mergeHoldingDefaults({
    id: "politics-acts",
    people: { list: [{ id: "speaker", name: "Спикер" }, { id: "gone", name: "Бывший", dead: true }] },
    politics: { stage: "selfRule", system: "elected-head", directives: { labor: "labor-festivals" } }
  });
  const stageAct = applyPoliticsAct(actHolding, { action: "stage", payload: { stage: "charter", reason: "Совет принял хартию" }, operationId: "stage-1", actorId: "gm" });
  assert.equal(stageAct.ok, true);
  assert.equal(stageAct.state.stage, "charter");
  assert.equal(stageAct.state.system, "governor");
  assert.equal(stageAct.state.directives.labor, "", "stage change clears unavailable directives");
  assert.equal(stageAct.state.history[0].clearedSlots[0].slot, "labor");
  assert.equal(actHolding.politics.stage, "selfRule", "acts must not mutate stored source before transaction commit");
  assert.equal(applyPoliticsAct(actHolding, { action: "stage", payload: { stage: "unknown", reason: "Story" } }).ok, false);
  const charterAct = applyPoliticsAct({ ...actHolding, politics: stageAct.state }, {
    action: "charter", payload: { patronName: "Барон", terms: "Общий совет", allowedSlots: ["order", "labor"], approvalRequired: true, tributeCopper: 50, tributeStartPeriodIndex: 3 }
  });
  assert.equal(charterAct.ok, true);
  assert.deepEqual(charterAct.state.charter.allowedSlots, ["order", "labor"]);
  assert.equal(applyPoliticsAct(actHolding, { action: "charter", payload: { allowedSlots: [], tributeCopper: 50 } }).ok, false, "tribute needs a start period");
  assert.equal(applyPoliticsAct(actHolding, { action: "representative", payload: { residentId: "gone" } }).ok, false, "dead residents cannot be appointed");
  assert.equal(applyPoliticsAct(actHolding, { action: "representative", payload: { residentId: "speaker", competencies: { economy: 3, war: 2, diplomacy: 0, culture: 0 } } }).ok, false, "competency budget is enforced");
  const appointment = applyPoliticsAct(actHolding, { action: "representative", payload: { residentId: "speaker", title: "Староста", competencies: { economy: 2, war: 1, diplomacy: 0, culture: 1 } } });
  assert.equal(appointment.ok, true);
  assert.equal(appointment.state.representative.appointedPeriodIndex, 1);
  assert.equal(appointment.state.representative.title, "Староста");
  assert.equal(applyPoliticsAct(actHolding, { action: "influence", payload: { delta: -1, reason: "Расход" } }).ok, false, "Influence cannot be negative");
  assert.equal(applyPoliticsAct(actHolding, { action: "influence", payload: { delta: 2, reason: "Сюжетное событие" } }).state.influence, 2);
  assert.equal(applyPoliticsAct({ ...actHolding, politics: { version: 2 } }, { action: "influence", payload: { delta: 1, reason: "Событие" } }).ok, false, "future state is read-only to v1 acts");
  const firstSystem = applyPoliticsAct(actHolding, { action: "system", payload: { system: "elder-council" },
    context: { available: true, culture: 18 } });
  assert.equal(firstSystem.ok, true);
  assert.equal(firstSystem.state.influence, 0, "first system choice is free");
  assert.equal(applyPoliticsAct({ ...actHolding, politics: firstSystem.state }, { action: "system",
    payload: { system: "elected-head" }, context: { available: true, culture: 20, reputation: 3 } }).ok, false,
  "cooldown applies to a second system change");
  const exceptionSystem = applyPoliticsAct({ ...actHolding, politics: firstSystem.state }, { action: "system",
    payload: { system: "elected-head", exception: true, reason: "Решение совета" },
    context: { available: true, culture: 20, reputation: 3 } });
  assert.equal(exceptionSystem.ok, true);
  assert.equal(exceptionSystem.state.system, "elected-head");
  const chosenDirective = applyPoliticsAct({ ...actHolding, politics: exceptionSystem.state }, { action: "directive",
    payload: { slot: "order", directiveId: "gates-permits" }, context: { available: true } });
  assert.equal(chosenDirective.ok, true);
  assert.equal(chosenDirective.state.directives.order, "gates-permits");
  assert.equal(applyPoliticsAct({ ...actHolding, politics: chosenDirective.state }, { action: "directive",
    payload: { slot: "order", directiveId: "gates-closed" }, context: { available: true } }).ok, false,
  "a slot changes only once per period");
  const festivalHolding = mergeHoldingDefaults({ id: "festival-holding", people: { list: [{ id: "one" }, { id: "two" }] },
    storage: { moneyCopper: 200, resources: [{ id: "bread-1", resourceId: "bread", qty: 5 }] },
    politics: { influence: 0 } });
  const festival = applyPoliticsAct(festivalHolding, { action: "decree", payload: { decreeId: "festival" },
    context: { available: true } });
  assert.equal(festival.ok, true);
  assert.equal(festival.storage.moneyCopper, 0);
  assert.equal(festival.storage.resources[0].qty, 1);
  assert.equal(festivalHolding.storage.moneyCopper, 200, "preparing a paid decree must not mutate the source holding");
  assert.equal(festival.state.activeDecrees[0].expiresPeriodIndex, 2);
  assert.equal(applyPoliticsAct({ ...festivalHolding, politics: festival.state }, { action: "decree",
    payload: { decreeId: "festival" }, context: { available: true } }).ok, false,
  "a paid decree cannot be repeated during its term");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkPoliticsRules();
  console.log("Politics rules check passed.");
}
