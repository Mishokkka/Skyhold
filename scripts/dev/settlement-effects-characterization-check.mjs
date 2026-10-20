import assert from "node:assert/strict";
import { checkBuildingSocialEffects } from "./building-social-effects-check.mjs";
import { confirmSocialWork } from "./social-effects-fixtures.mjs";
import { checkBuildingPrerequisitePhases } from "./building-prerequisite-phase-check.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BuildingMetaDomain } from "../apps/domains/building/meta-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { clone } from "../data/utils.js";
import { settlementControlSummary } from "../engines/settlement/control.js";

function canonicalBuilding(templateId, id, extra = {}) {
  const template = clone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === templateId));
  return {
    ...template,
    id,
    templateId,
    constructionStatus: "built",
    lifecycle: "active",
    condition: "intact",
    assignedWorkerIds: [],
    ...extra
  };
}

function operationalDependency(templateId, id = `${templateId}-dependency`) {
  return {
    id,
    templateId,
    name: templateId,
    constructionStatus: "built",
    lifecycle: "active",
    condition: "intact"
  };
}

function person(id, extra = {}) {
  return {
    id,
    name: id,
    dead: false,
    injuredDays: 0,
    volunteerLabor: true,
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
    traitsText: "",
    ...extra
  };
}

function moraleHarness() {
  return {
    ...BuildingMetaDomain,
    ...ResidentDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    _buildingStatus(building = {}) {
      return { value: String(building.constructionStatus ?? "built") };
    },
    _gmSettlementModifiers(holding = {}) {
      return { morale: this._safeNumber(holding?.gm?.modifiers?.morale, 0) };
    },
    _buildingHasOvertimeProduction() {
      return false;
    }
  };
}

export function checkSettlementEffectsCharacterization() {
  checkBuildingSocialEffects();
  checkBuildingPrerequisitePhases();
  const harness = moraleHarness();
  const worker = person("split-worker");
  const splitHolding = {
    people: { list: [worker] },
    buildings: { list: [
      { id: "hard-job", name: "Тяжёлая работа", workerMoraleDelta: -2, wageDailyCopper: 18 },
      { id: "good-job", name: "Престижная работа", workerMoraleDelta: 1, wageDailyCopper: 18 }
    ] },
    constructionCrews: [],
    finance: {}
  };
  const weighted = harness._workMoraleForPeriod(worker, splitHolding, {
    assignments: [
      { sourceId: "hard-job", functionId: "production", normalQd: 10, overtimeQd: 0 },
      { sourceId: "good-job", functionId: "culture", normalQd: 10, overtimeQd: 0 }
    ]
  });
  assert.equal(weighted.conditions, -1, "split work conditions use a QD-weighted symmetric whole-number average");
  assert.equal(weighted.pay, 0, "volunteer status is evaluated once after all assignments");
  assert.equal(weighted.value, -1);

  const residents = Array.from({ length: 150 }, (_value, index) => person(`resident-${index + 1}`));
  const bathWorkersA = [residents[0].id, residents[1].id];
  const bathWorkersB = [residents[2].id, residents[3].id];
  const bathA = canonicalBuilding("bathhouse", "bath-a", { assignedWorkerIds: bathWorkersA });
  const well = operationalDependency("well");
  const oneBathHolding = { people: { list: residents }, buildings: { list: [well, bathA] }, finance: {}, gm: { modifiers: {} }, special: { list: [] } };
  confirmSocialWork(oneBathHolding, bathA, bathWorkersA);
  const oneBath = harness._buildingMoraleSummary(oneBathHolding);
  assert.equal(oneBath.total, 2, "a +3 service covering 100 of 150 residents rounds to +2");
  const bathB = canonicalBuilding("bathhouse", "bath-b", { assignedWorkerIds: bathWorkersB });
  const twoBathHolding = { ...oneBathHolding, buildings: { list: [well, bathA, bathB] } };
  confirmSocialWork(twoBathHolding, bathB, bathWorkersB);
  const twoBath = harness._buildingMoraleSummary(twoBathHolding);
  assert.equal(twoBath.total, 3, "a repeated service adds capacity but not a second fixed +3 bonus");
  assert.equal(twoBath.sources.find((row) => row.id === "bath-b")?.value, 0);
  assert.equal(twoBath.sources.find((row) => row.id === "bath-a")?.capacity, 200);

  const unpleasant = [
    canonicalBuilding("gallows", "gallows-a", { moraleDelta: -2 }),
    canonicalBuilding("gallows", "gallows-b", { moraleDelta: -2 })
  ];
  const unpleasantSummary = harness._buildingMoraleSummary({ people: { list: residents.slice(0, 10) }, buildings: { list: unpleasant }, finance: {} });
  assert.equal(unpleasantSummary.total, -4, "every active repeated negative building stacks its penalty");

  const sheriff = person("sheriff", { name: "Шериф", role: "Шериф", workAssignment: "sheriff-post-instance", background: "солдат" });
  const deputy = person("deputy");
  const population = [sheriff, deputy, ...Array.from({ length: 23 }, (_value, index) => person(`citizen-${index + 1}`))];
  const sheriffPost = canonicalBuilding("sheriff-post", "sheriff-post-instance", { assignedWorkerIds: [sheriff.id, deputy.id, ""] });
  const controlled = settlementControlSummary({ people: { list: population }, buildings: { list: [sheriffPost] }, finance: {} }, { rawMorale: -12 });
  assert.equal(controlled.population, 25);
  assert.equal(controlled.orderRequirement, 3, "one point of general Control is required per ten residents, rounded up");
  assert.equal(controlled.generalControl, 3, "the standalone Sheriff and two staffed Post positions contribute general Control");
  assert.equal(controlled.crimeDeficit, 0);
  assert.equal(controlled.institutionalCeiling, -10, "the Sheriff/Post tier reaches its ceiling only when pooled capacity covers everybody");
  assert.equal(controlled.disorderMorale, -10, "Control suppresses expressed unrest only up to the institutional ceiling");

  const uncovered = settlementControlSummary({ people: { list: [...population, ...Array.from({ length: 20 }, (_value, index) => person(`extra-${index + 1}`))] }, buildings: { list: [sheriffPost] }, finance: {} }, { rawMorale: -12 });
  assert.equal(uncovered.institutionalCeiling, null, "partial institutional coverage cannot impose a settlement-wide ceiling");
  assert.equal(uncovered.disorderMorale, -12, "without full institutional coverage Control reduces the incident pool but cannot suppress settlement-wide discontent");

  for (const row of population.slice(0, 6)) row.attributes = { ...row.attributes, wits: 4 };
  population[0].background = "солдат";
  population[1].background = "ветеран";
  population[2].background = "сторож";
  population[3].background = "писарь";
  const headquartersWorkers = population.slice(0, 6).map((row) => row.id);
  const headquarters = canonicalBuilding("main-headquarters", "hq", { assignedWorkerIds: [...headquartersWorkers, ...Array(12).fill("")] });
  const headquartersDependencies = [
    operationalDependency("garrison-administration"),
    operationalDependency("military-academy"),
    operationalDependency("telegraph-station"),
    operationalDependency("construction-center")
  ];
  const hqControl = settlementControlSummary({ people: { list: population }, buildings: { list: [...headquartersDependencies, headquarters] }, finance: {} }, { rawMorale: -20 });
  assert.equal(hqControl.generalControl, 1, "the appointed Sheriff remains the only general-control source in this fixture");
  assert.equal(hqControl.unrestOnlyControl, 2, "Main Headquarters contributes only against unrest");
  assert.equal(hqControl.crimeDeficit, 2, "unrest-only Control never prevents theft checks");

  const normalized = normalizeSkyholdData({
    meta: { schemaVersion: 71, templateCatalogVersion: 14 },
    catalog: { buildings: [] },
    holdings: [{
      id: "snapshot-holding",
      name: "Snapshot",
      type: "settlement",
      people: { list: [person("living"), { ...person("dead"), dead: true }] },
      buildings: { list: [] },
      gm: {
        moraleSnapshot: {
          schema: 99,
          operationId: "op",
          periodKey: "period",
          ration: { tier: "enhanced", modifier: 99, diversityBonus: 99 },
          residents: {
            living: { ration: { tier: "hunger", value: -99 }, work: { value: 99, pay: 99, overtime: 99, conditions: 99, totalQd: 20, reason: "ok" } },
            dead: { ration: { tier: "enhanced", value: 1 }, work: { value: 1 } },
            missing: { ration: { tier: "normal", value: 0 }, work: { value: 0 } }
          }
        }
      }
    }]
  });
  const snapshot = normalized.holdings[0].gm.moraleSnapshot;
  assert.equal(snapshot.schema, 1);
  assert.equal(snapshot.ration.modifier, 3, "enhanced rations plus the approved diversity bonus allow a total of +3");
  assert.equal(snapshot.ration.diversityBonus, 2, "the diversity component remains bounded separately");
  assert.equal(snapshot.residents.living.ration.value, -2);
  assert.equal(snapshot.residents.living.work.value, 3);
  assert.equal(snapshot.residents.living.work.pay, 2);
  assert.equal(snapshot.residents.living.work.overtime, 0);
  assert.deepEqual(Object.keys(snapshot.residents), ["living"], "snapshot normalization removes dead and missing resident rows");
  assert.deepEqual(normalizeSkyholdData(normalized).holdings[0].gm.moraleSnapshot, snapshot, "valid morale snapshot limits survive a reload");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkSettlementEffectsCharacterization();
  console.log("FBL Skyhold settlement effects: QD-weighted work morale, pooled service coverage, negative repeats, Control ceilings and morale snapshots passed.");
}
