import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { clearPersonFromAssignments, transferResidentBetweenHoldings, vacatePoliticsRepresentative } from "../data/resident-assignments.js";
import { applyPoliticsAct } from "../engines/politics/acts.js";
import { advancePoliticsStateForPeriod, politicsRepresentativeStatus } from "../engines/politics/rules.js";
import { preparePoliticsPeriod, refreshPoliticsPeriodEffects, finishPoliticsPeriod } from "../engines/politics/period.js";
import { politicsRuntimeEffects } from "../engines/politics/runtime-effects.js";
import { politicsDecisionContext } from "../apps/politics-decision-context.js";
import { registerSkyholdAppClass, getSkyholdAppClass } from "../apps/registry.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { FinanceStaffDomain } from "../apps/domains/finance/staff-domain.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { holdingMarketAccessLevel } from "../engines/market/logistics.js";
import { buildTendayOperationPayload, hydrateTendayOperation } from "../engines/tenday/operation-payload.js";

const holding = (extra = {}) => mergeHoldingDefaults({ id: "politics-regression", ...extra });
const available = { available: true, culture: 20 };

export async function checkPoliticsRegressions() {
  const owner = {
    ...BuildingProductionDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _developmentSummary: () => ({ totals: { culture: 20 } }),
    _buildingStatus: () => ({ value: "built" }), _buildingFunctions: (building) => building.functions ?? {},
    _gmSettlementModifiers: () => ({ reputation: 0, morale: 0, defense: 0 }),
    _residentHousingIndex: () => ({}), _calculatePersonMorale: () => ({ total: 0 }),
    _buildingMoraleSummary: () => ({ total: 0 }), _buildingDefenseSummary: () => ({ total: 0 }),
    _calculateMorale: ResidentDomain._calculateMorale, _moraleState: (value) => ({ value })
  };
  const previousClass = getSkyholdAppClass();
  class CalculationOwner {}
  Object.assign(CalculationOwner.prototype, owner);
  registerSkyholdAppClass(CalculationOwner);
  try {
    const source = holding({ gm: { politicsIgnoreInstitutionRequirement: true, modifiers: { marketConnectionsLevel: 3 } },
      politics: { directives: { order: "gates-closed" }, representative: { residentId: "speaker",
        competencies: { economy: 0, war: 1, diplomacy: 2, culture: 1 } } },
      people: { list: [{ id: "speaker" }] } });
    const saved = clone(source);
    const before = JSON.stringify(saved);
    assert.equal(settlementControlSummary(saved).generalControl, 2, "F01: a serialized holding still has political Control");
    assert.equal(holdingMarketAccessLevel(saved).level, 2, "F01: market operations see current political access");
    assert.equal(owner._reputationSummary(saved).total, 1);
    assert.equal(owner._calculateMorale(saved), 0, "closed gates -1 and Culture +1 reach ordinary morale");
    assert.equal(owner._defenseSummary(saved).total, 2);
    saved.politics.directives.order = "gates-open";
    assert.equal(settlementControlSummary(saved).generalControl, 0, "a changed directive must invalidate the previous result");
    assert.equal(owner._reputationSummary(saved).total, 2);
    saved.politics.directives.order = "gates-closed";
    assert.equal(JSON.stringify(saved), before, "derived political effects never write world data");
    saved.gm.politicsCultureThreshold = 30;
    assert.equal(politicsRuntimeEffects(saved).defense, 0, "suspension immediately removes current effects");
  } finally { registerSkyholdAppClass(previousClass); }

  const term = holding({ gm: { calendaria: { lastQd: 480 } }, people: { list: [{ id: "speaker", name: "Представитель" }] },
    politics: { stage: "selfRule", system: "elected-head", representative: { residentId: "speaker", appointedPeriodIndex: 1 } } });
  assert.equal(politicsRepresentativeStatus(term.politics, term, 13).expired, true);
  const edit = applyPoliticsAct(term, { action: "representative", payload: { residentId: "speaker", title: "Новый титул", competencies: term.politics.representative.competencies } });
  assert.equal(edit.state.representative.appointedPeriodIndex, 1, "editing a title does not silently renew the term");
  const renewed = applyPoliticsAct(term, { action: "renew-representative", operationId: "renew" });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.state.representative.appointedPeriodIndex, 13);
  assert.equal(politicsRepresentativeStatus(renewed.state, term, 13).expired, false);
  assert.equal(applyPoliticsAct({ ...term, politics: renewed.state }, { action: "renew-representative" }).ok, false);

  const changes = { report: { politics: { influenceGained: 2, charges: [{ copper: 60 }], effects: { control: 2 } } },
    changeSet: { politics: [{ key: "influence", before: 0, after: 2 }] } };
  const restored = hydrateTendayOperation({ payload: buildTendayOperationPayload(changes) });
  assert.deepEqual(restored.report.politics, changes.report.politics);
  assert.deepEqual(restored.changeSet.politics, changes.changeSet.politics);
  assert.deepEqual(hydrateTendayOperation({ payload: { schema: 1 } }).changeSet.politics, [], "old reports still load");

  const sheriff = holding({ people: { list: [{ id: "sheriff", role: "Шериф", volunteerLabor: true }] } });
  assert.equal(politicsDecisionContext(sheriff).patrolServiceActive, true);
  sheriff.people.list[0].injuredDays = 1;
  assert.equal(politicsDecisionContext(sheriff).patrolServiceActive, false);
  const post = holding({ buildings: { list: [{ id: "post", templateId: "sheriff-post", lifecycle: "active",
    functions: { defense: true }, control: { generalFlat: 1 } }] } });
  assert.equal(politicsDecisionContext(post).patrolServiceActive, true, "F05: real Control determines guard eligibility");

  const network = holding({ storage: { moneyCopper: 100 }, politics: { directives: { external: "external-network" } },
    gm: { politicsBalance: { rows: { "directive:external-network": { requires: ["market"] } } } } });
  const inactive = preparePoliticsPeriod(network, { context: { ...available, marketActive: false }, periodIndex: 1 });
  assert.equal(inactive.charges.length, 0);
  assert.equal(inactive.networkPaid, false);
  assert.equal(network.storage.moneyCopper, 100);
  assert.equal(finishPoliticsPeriod(network, inactive).results[0].gained, 1);
  const active = preparePoliticsPeriod(network, { context: { ...available, marketActive: true }, periodIndex: 2 });
  assert.equal(active.charges[0].copper, 60);
  assert.equal(active.networkPaid, true);
  assert.equal(finishPoliticsPeriod(network, active).results[0].gained, 2);

  const future = holding({ politics: { version: 2, activeDecrees: [{ decreeId: "future", futureExpiry: 8 }] } });
  const unchanged = JSON.stringify(future);
  assert.throws(() => preparePoliticsPeriod(future, { context: available }), /новой версией/);
  assert.equal(advancePoliticsStateForPeriod(future.politics, available).ok, false);
  assert.equal(finishPoliticsPeriod(future, { tracked: false }).ok, false);
  assert.equal(JSON.stringify(future), unchanged);

  const invalid = holding({ people: { list: [{ id: "speaker" }] }, politics: { representative: { residentId: "speaker",
    competencies: { economy: 3, war: 0, diplomacy: 0, culture: 3 } } } });
  const invalidPeriod = preparePoliticsPeriod(invalid, { context: available });
  assert.equal(finishPoliticsPeriod(invalid, invalidPeriod).results[0].gained, 1, "F08: invalid skill totals cannot grant Influence");
  const deceased = holding({ people: { list: [{ id: "speaker", dead: true }] }, politics: { representative: { residentId: "speaker" } } });
  const deathPeriod = preparePoliticsPeriod(deceased, { context: available });
  finishPoliticsPeriod(deceased, deathPeriod);
  assert.equal(deceased.politics.representative.residentId, "");
  assert.equal(deceased.politics.history.some((entry) => entry.type === "representative-vacant"), true);
  const moved = holding({ people: { list: [{ id: "speaker" }] }, politics: { representative: { residentId: "speaker" } } });
  clearPersonFromAssignments(moved, "speaker");
  assert.equal(moved.politics.representative.residentId, "speaker", "changing jobs retains political office");
  assert.equal(transferResidentBetweenHoldings(moved, holding({ id: "target" }), "speaker").ok, true);
  assert.equal(moved.politics.representative.residentId, "");
  assert.equal(vacatePoliticsRepresentative(moved, "speaker", "повтор"), false, "vacancy is not logged twice");

  const directive = applyPoliticsAct(holding(), { action: "directive", payload: { slot: "order", directiveId: "gates-closed" }, context: available });
  assert.match(directive.state.history.at(-1).summary, /Закрытые|Закрыт|ворота/i);
  assert.equal(directive.summary, directive.state.history.at(-1).summary);

  const food = holding({ people: { list: [{ id: "speaker", attributes: {} }] }, politics: { stage: "selfRule", system: "elected-head",
    representative: { residentId: "speaker" }, influence: 6 }, gm: { politicsBalance: { rows: { "perk:laborer": { effects: { influenceCap: 5 } } } } } });
  const fed = preparePoliticsPeriod(food, { context: available });
  assert.equal(fed.effects.influenceCap, 0);
  refreshPoliticsPeriodEffects(food, fed, { rationFullySupplied: true });
  assert.equal(fed.rationFullySupplied, true);
  assert.equal(finishPoliticsPeriod(food, fed).results[0].gained, 1, "F12: the actual food flag survives to final rewards");

  const services = holding({ buildings: { list: [{ id: "meeting", templateId: "meeting-house", lifecycle: "active", functions: { culture: true },
    fuelAlternatives: [{ resourceId: "wood", qty: 1 }] }] } });
  const pipelineHolding = clone(services);
  const serviceOwner = { ...owner, _financeFunctionKey: (id, fn) => `${id}:${fn}`, _financeFunctionAllowed: () => true,
    _activeAssignedBuildingPeople: () => [{ id: "worker" }], _storageCanPay: () => ({ ok: false }) };
  assert.equal(politicsDecisionContext(services, serviceOwner).available, true);
  FinanceEconomyDomain._runInstitutionConsumables.call(serviceOwner, services, 40, { skipped: [] }, {},
    { operatingBlockedFunctionKeys: new Set(), periodIdentity: { periodKey: "tenday:1" } });
  const afterService = politicsDecisionContext(services, serviceOwner);
  assert.equal(afterService.available, false);
  const stopped = preparePoliticsPeriod(services, { context: afterService });
  assert.equal(stopped.effects.reputation, 0);
  assert.equal(finishPoliticsPeriod(services, stopped).skipped, true);
  let productionEffects = null;
  const noop = () => {};
  const pipelineOwner = { ...serviceOwner, ...FinanceStaffDomain,
    _periodLabel: () => "десятник", _advanceMarketShipmentsForQd: noop, _advanceMarketOutboundForQd: noop,
    _prepareFinanceForQd: () => ({ operatingBlockedFunctionKeys: new Set(), blockedWorkerIds: new Set(), periodIdentity: { periodKey: "tenday:1" } }),
    _runMaintenanceForQd: () => ({ ok: true }), _prepareTechnicalServiceRestarts: noop, _economyWorkerContext: () => ({}),
    _runInstitutionConsumables: FinanceEconomyDomain._runInstitutionConsumables, _runInstitutionResolutions: noop,
    _runAgricultureForQd: () => ({ ok: true }), _nonAgricultureProductionBuildings: (buildings) => buildings,
    _runProductionAndLivestockForQd: FinanceEconomyDomain._runProductionAndLivestockForQd,
    _runProductionCycleForQd: (draft) => { productionEffects = politicsRuntimeEffects(draft); },
    _runLivestockForQd: () => ({ ok: true }), _isFoodResource: () => false, _runFoodConsumptionForQd: noop,
    _runConstructionCrewsForQd: noop, _runInternalDemandForQd: noop, _recordBuildingServiceActivity: noop
  };
  const pipelineReport = await FinanceEconomyDomain._runEconomyForQd.call(pipelineOwner, pipelineHolding, 40);
  assert.equal(productionEffects.reputation, 0, "F14: the real economy orchestrator applies the service shutdown before production");
  assert.equal(pipelineReport.politics.influenceGained, 0);
  const final = holding();
  const finalPeriod = preparePoliticsPeriod(final, { context: available });
  refreshPoliticsPeriodEffects(final, finalPeriod, { context: { available: false } });
  assert.equal(finishPoliticsPeriod(final, finalPeriod).results[0].gained, 0, "F14: final service shutdown removes reward eligibility");

  const priorFoundry = globalThis.foundry;
  const priorGame = globalThis.game;
  const hadFoundry = Object.hasOwn(globalThis, "foundry");
  const hadGame = Object.hasOwn(globalThis, "game");
  const { SkyholdData } = await import("../data/store.js");
  const priorView = SkyholdData.view;
  class FakeApplication { async _prepareContext() { return {}; } }
  globalThis.foundry = { applications: { api: { ApplicationV2: FakeApplication, HandlebarsApplicationMixin: (Base) => Base } } };
  globalThis.game = { user: { id: "gm", isGM: true } };
  try {
    const { SkyholdPoliticsApp } = await import("../apps/politics-app.js");
    const unknown = holding({ politics: { directives: { order: "unknown-directive" } } });
    SkyholdData.view = () => ({ meta: { revision: 1 }, holdings: [unknown] });
    const app = Object.assign(Object.create(SkyholdPoliticsApp.prototype), { holdingId: unknown.id, activeTab: "cabinet",
      owner: { _developmentSummary: () => ({ totals: { culture: 0 } }) } });
    const gm = await app._prepareContext({});
    assert.equal(gm.available, false);
    assert.equal(gm.showPoliticsPanels, true);
    assert.equal(gm.tabs.some((tab) => tab.id === "cabinet"), true);
    const order = gm.courseSlots.find((slot) => slot.id === "order");
    assert.match(order.selectedLabel, /unknown-directive/);
    assert.equal(order.options.find((row) => row.id === "unknown-directive").selected, true);
    globalThis.game.user = { id: "player", isGM: false };
    const player = await app._prepareContext({});
    assert.equal(player.canManagePolitics, false);
    assert.deepEqual(player.tabs.map((tab) => tab.id), ["control"]);
  } finally {
    SkyholdData.view = priorView;
    if (hadFoundry) globalThis.foundry = priorFoundry; else delete globalThis.foundry;
    if (hadGame) globalThis.game = priorGame; else delete globalThis.game;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPoliticsRegressions();
  console.log("Politics regressions F01/F03–F14 passed.");
}
