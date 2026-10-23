import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  agricultureDefaultCrops,
  normalizeAgricultureBuilding
} from "../data/agriculture.js";
import { BUILDING_TEMPLATES_FOOD } from "../data/building-template-catalog/food.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import {
  agricultureStateSignature,
  planAgriculturePlot
} from "../engines/economy/agriculture.js";
import {
  applyAgriculturePeriodPlan,
  planAgriculturePeriod
} from "../engines/economy/agriculture-period.js";
import { FinanceAgricultureDomain } from "../apps/domains/finance/agriculture-domain.js";

function calendar(seasonId = "spring", seasonKey = `1165:${seasonId}`) {
  return { seasonId, seasonKey, year: 1165, dateKey: `${seasonKey}:01` };
}

function fastCrop(overrides = {}) {
  return {
    id: "vegetables",
    label: "Овощи",
    resourceId: "vegetables",
    outputQty: 7,
    sowingSeasons: ["spring"],
    sowingWorkQd: 2,
    growingQd: 3,
    harvestWorkQd: 5,
    expiryRule: "qd",
    readyExpiryQd: 20,
    ...overrides
  };
}

export function checkAgricultureCharacterization() {

{
  const field = normalizeAgricultureBuilding(undefined, { building: { id: "field-1", templateId: "grain-field", name: "Поле зерна" } });
  const garden = normalizeAgricultureBuilding(undefined, { building: { id: "garden", templateId: "garden", name: "Сад" } });
  assert.equal(field.kind, "field", "grain-field must receive canonical field agriculture defaults");
  assert.equal(field.activeCropId, "grain", "field default crop must remain Grain");
  assert.deepEqual(garden.crops.map((crop) => crop.id), ["vegetables", "herbs"], "garden must expose editable Vegetables and Herbs choices");
  assert.equal(field.crops.find((crop) => crop.id === "grain")?.outputQty, 960, "one campaign Field harvest must equal roughly four person-years of prepared food");
  assert.equal(garden.crops.find((crop) => crop.id === "vegetables")?.outputQty, 480, "one campaign vegetable Garden harvest must equal roughly two person-years of prepared food");
  assert.equal(garden.crops.find((crop) => crop.id === "herbs")?.outputQty, 80, "the non-food herb alternative must keep a smaller specialty harvest");
  assert.equal(agricultureDefaultCrops("field").some((crop) => Object.keys(crop).some((key) => /seed/i.test(key))), false, "seeds must remain abstract rather than a resource/config input");
  assert.ok([...field.crops, ...garden.crops].every((crop) => [crop.outputQty, crop.sowingWorkQd, crop.growingQd, crop.harvestWorkQd, crop.readyExpiryQd].every(Number.isInteger)), "all canonical crop quantities and QD values must be integers");

  const oldGarden = { id: "old-garden", templateId: "garden", name: "Сад", productionLines: [{ id: "legacy", resourceId: "vegetables" }] };
  normalizeBuilding(oldGarden);
  assert.equal(oldGarden.agriculture.kind, "garden", "safe normal load must add canonical agriculture state to an old Garden instance");
  assert.equal(oldGarden.productionLines.length, 1, "safe agriculture normalization must preserve legacy data instead of destructively deleting it");
}

{
  const first = planAgriculturePlot({
    state: { phase: "empty" },
    crop: fastCrop(),
    operations: { sow: true, harvest: true },
    elapsedQd: 3,
    availableWorkQd: 3,
    operationId: "plot-one",
    calendarContextForOffset: () => calendar()
  });
  assert.equal(first.stateAfter.phase, "harvesting", "a ready crop with partial collection work must stay on the plot");
  assert.equal(first.workQdUsed, 3, "sowing and harvesting must consume only allocated worker QD");
  assert.deepEqual(first.resourceChanges, [{ resourceId: "vegetables", qty: 1 }], "partial harvest must transfer only the whole cumulative share");
  assert.equal(first.stateAfter.readyQty, 6, "the uncollected whole harvest must remain on the plot");

  const second = planAgriculturePlot({
    state: first.stateAfter,
    crop: fastCrop(),
    operations: { sow: true, harvest: true },
    elapsedQd: 1,
    availableWorkQd: 4,
    operationId: "plot-two",
    calendarContextForOffset: () => calendar()
  });
  assert.equal(second.stateAfter.phase, "empty", "the plot must return to empty after collection completes");
  assert.deepEqual(second.resourceChanges, [{ resourceId: "vegetables", qty: 6 }], "later collection must transfer the exact whole remainder without fractions");
  assert.equal(first.resourceChanges[0].qty + second.resourceChanges[0].qty, 7, "gradual transfers must sum to the configured integer yield");
}

{
  const noWorkerGrowth = planAgriculturePlot({
    state: { phase: "growing", cropId: "vegetables", growingElapsedQd: 2, lastSownSeasonKey: "1165:spring" },
    crop: fastCrop(),
    operations: { sow: true, harvest: true },
    elapsedQd: 1,
    availableWorkQd: 0,
    operationId: "growth-without-worker",
    calendarContextForOffset: () => calendar()
  });
  assert.equal(noWorkerGrowth.stateAfter.phase, "ready", "growth must advance with calendar time and no permanent worker");
  assert.equal(noWorkerGrowth.stateAfter.readyQty, 7, "ready yield must stay on the plot rather than entering storage");
  assert.deepEqual(noWorkerGrowth.resourceChanges, [], "becoming ready must not create warehouse resources");

  const missed = planAgriculturePlot({
    state: { phase: "sowing", cropId: "vegetables", sowingProgressQd: 1, sowingSeasonKey: "1165:spring", lastSownSeasonKey: "1165:spring" },
    crop: fastCrop(),
    operations: { sow: true, harvest: true },
    elapsedQd: 1,
    availableWorkQd: 10,
    operationId: "missed-season",
    calendarContextForOffset: () => calendar("summer")
  });
  assert.equal(missed.stateAfter.phase, "empty", "unfinished sowing must be lost after its allowed season");
  assert.equal(missed.events.some((event) => event.kind === "missed-sowing"), true, "missed sowing must be explicit in Preview");
  assert.deepEqual(missed.resourceChanges, [], "missed sowing must never create a crop");

  const outOfSeason = planAgriculturePlot({
    state: { phase: "empty" },
    crop: fastCrop(),
    operations: { sow: true, harvest: true },
    elapsedQd: 40,
    availableWorkQd: 40,
    operationId: "out-of-season",
    calendarContextForOffset: () => calendar("autumn")
  });
  assert.equal(outOfSeason.stateAfter.phase, "empty", "work cannot create a crop outside configured sowing seasons");
  assert.deepEqual(outOfSeason.resourceChanges, [], "out-of-season work must produce nothing");
}

{
  const qdExpired = planAgriculturePlot({
    state: {
      phase: "ready",
      cropId: "vegetables",
      readyAgeQd: 1,
      harvestProgressQd: 0,
      harvestWorkQdTotal: 5,
      harvestTotalQty: 4,
      harvestedQty: 0,
      readyQty: 4,
      readySeasonKey: "1165:spring",
      lastSownSeasonKey: "1165:spring"
    },
    crop: fastCrop({ outputQty: 4, readyExpiryQd: 2 }),
    operations: { sow: false, harvest: false },
    elapsedQd: 1,
    availableWorkQd: 0,
    operationId: "qd-expiry",
    calendarContextForOffset: () => calendar()
  });
  assert.equal(qdExpired.stateAfter.phase, "empty", "ready crop must die at its configured QD boundary");
  assert.equal(qdExpired.events.find((event) => event.kind === "expired")?.qty, 4, "Preview must show the whole lost harvest");

  const seasonExpired = planAgriculturePlot({
    state: {
      phase: "ready",
      cropId: "herbs",
      harvestWorkQdTotal: 2,
      harvestTotalQty: 3,
      readyQty: 3,
      readySeasonKey: "1165:spring",
      lastSownSeasonKey: "1165:spring"
    },
    crop: fastCrop({ id: "herbs", resourceId: "herbs", outputQty: 3, expiryRule: "season-end", readyExpiryQd: 0 }),
    operations: { sow: false, harvest: false },
    elapsedQd: 1,
    availableWorkQd: 0,
    operationId: "season-expiry",
    calendarContextForOffset: () => calendar("summer")
  });
  assert.equal(seasonExpired.stateAfter.phase, "empty", "season-end expiry must follow the calendar season key");
  assert.equal(seasonExpired.events.some((event) => event.kind === "expired"), true, "season-end loss must be visible in the plan");
}

{
  const building = {
    id: "garden-1",
    templateId: "garden",
    name: "Сад",
    agriculture: {
      enabled: true,
      kind: "garden",
      activeCropId: "vegetables",
      outputRoomId: "outdoors",
      gmPriority: 500,
      operations: { sow: true, harvest: true },
      crops: [fastCrop({ outputQty: 4, sowingWorkQd: 1, growingQd: 1, harvestWorkQd: 1 })],
      state: { phase: "empty" }
    }
  };
  const dependencies = {
    isOperational: () => true,
    isFunctionAllowed: () => true,
    workQdForBuilding: () => 2,
    calendarContextForOffset: () => calendar()
  };
  const plan = planAgriculturePeriod({ buildings: [building], elapsedQd: 1, operationId: "tenday-one", dependencies });
  assert.deepEqual(plan.resourceChanges, [{ resourceId: "vegetables", qty: 4 }], "period plan must aggregate only whole resource output");
  let received = 0;
  const applyDependencies = {
    getBuilding: () => building,
    addResource: (_resourceId, qty) => { received += qty; return { qty }; },
    setAgriculture: (target, agriculture) => { target.agriculture = agriculture; }
  };
  const firstApply = applyAgriculturePeriodPlan({ plan, dependencies: applyDependencies });
  assert.equal(firstApply.ok, true, "unchanged Preview must apply");
  assert.equal(firstApply.replay, false, "first Apply is not a replay");
  assert.equal(received, 4, "first Apply must transfer the planned harvest once");
  const stateAfterFirstApply = agricultureStateSignature(building.agriculture.state);
  const replay = applyAgriculturePeriodPlan({ plan, dependencies: applyDependencies });
  assert.equal(replay.ok, true, "repeating the exact plan must be accepted idempotently");
  assert.equal(replay.replay, true, "second Apply with the same operationId must be marked replay");
  assert.equal(received, 4, "replay must not duplicate resources");
  assert.equal(agricultureStateSignature(building.agriculture.state), stateAfterFirstApply, "replay must not mutate plot state");

  const stalePlan = planAgriculturePeriod({ buildings: [building], elapsedQd: 1, operationId: "tenday-two", dependencies });
  building.agriculture.crops[0].outputQty = 99;
  const stale = applyAgriculturePeriodPlan({ plan: stalePlan, dependencies: applyDependencies });
  assert.equal(stale.ok, false, "changed crop config must invalidate Preview");
  assert.equal(stale.stale, true, "changed crop config must be reported as stale");
}

{
  const blockedBuilding = {
    id: "blocked-garden",
    templateId: "garden",
    name: "Законсервированный сад",
    agriculture: {
      enabled: true,
      kind: "garden",
      activeCropId: "vegetables",
      operations: { sow: true, harvest: true },
      crops: [fastCrop({ outputQty: 4, growingQd: 3 })],
      state: { phase: "growing", cropId: "vegetables", growingElapsedQd: 2, lastSownSeasonKey: "1165:spring" }
    }
  };
  const blocked = planAgriculturePeriod({
    buildings: [blockedBuilding],
    elapsedQd: 1,
    operationId: "blocked-calendar",
    dependencies: {
      isOperational: () => true,
      isFunctionAllowed: () => false,
      workQdForBuilding: () => { throw new Error("blocked agriculture must not receive labour"); },
      calendarContextForOffset: () => calendar()
    }
  });
  assert.equal(blocked.entries[0].stateAfter.phase, "ready", "finance blocking must not freeze calendar growth and create a crop-preservation exploit");
  assert.equal(blocked.entries[0].workQdUsed, 0, "blocked agriculture may not spend worker QD");
  assert.equal(blocked.skipped[0]?.reason, "finance-blocked", "Preview must still explain why labour and harvest are blocked");
}

{
  const engineSource = fs.readFileSync(new URL("../engines/economy/agriculture.js", import.meta.url), "utf8");
  assert.doesNotMatch(engineSource, /Math\.random|game\.|foundry\.|Date\.now/, "pure agriculture planning must remain deterministic and Foundry-independent");

  const fieldTemplate = BUILDING_TEMPLATES_FOOD.find((row) => row.id === "grain-field");
  const gardenTemplate = BUILDING_TEMPLATES_FOOD.find((row) => row.id === "garden");
  assert.equal(fieldTemplate.productionLines.length, 0, "Field must not retain the legacy passive tenday line beside the agriculture cycle");
  assert.equal(gardenTemplate.productionLines.length, 0, "Garden must not retain legacy daily production beside the agriculture cycle");
  assert.equal(fieldTemplate.agriculture.activeCropId, "grain", "Field template must persist its canonical crop config");
  assert.deepEqual(gardenTemplate.agriculture.crops.map((crop) => crop.id), ["vegetables", "herbs"], "Garden template must persist both current crop choices without Reforged content");
  assert.deepEqual(
    fieldTemplate.agriculture.crops.map((crop) => crop.outputQty),
    agricultureDefaultCrops("field").map((crop) => crop.outputQty),
    "Field template and fallback defaults must share one campaign yield scale"
  );
  assert.deepEqual(
    gardenTemplate.agriculture.crops.map((crop) => crop.outputQty),
    agricultureDefaultCrops("garden").map((crop) => crop.outputQty),
    "Garden template and fallback defaults must share one campaign yield scale"
  );

  const templateSource = fs.readFileSync(new URL("../../templates/parts/building-editor/agriculture.hbs", import.meta.url), "utf8");
  const editorSource = fs.readFileSync(new URL("../apps/editors/building-editor.js", import.meta.url), "utf8");
  const buildingShell = fs.readFileSync(new URL("../../templates/building-editor.hbs", import.meta.url), "utf8");
  const financeCompositionSource = fs.readFileSync(new URL("../apps/domains/finance-domain.js", import.meta.url), "utf8");
  const economyRuntimeSource = fs.readFileSync(new URL("../apps/domains/finance/economy-domain.js", import.meta.url), "utf8");
  assert.match(buildingShell, /building-editor\/agriculture\.hbs/, "building editor shell must include the agriculture tab partial");
  assert.match(templateSource, /data-agriculture-field=/, "agriculture configuration and correction state must be editable in-world");
  for (const action of ["add-agriculture-crop", "delete-agriculture-crop", "pick-agriculture-resource", "toggle-agriculture-season"]) {
    assert.match(templateSource, new RegExp(`data-action=["']${action}["']`), `agriculture UI must expose ${action}`);
    assert.match(editorSource, new RegExp(`["']${action}["']\\s*:`), `building editor must wire ${action}`);
  }
  assert.doesNotMatch(`${templateSource}\n${JSON.stringify(fieldTemplate.agriculture)}\n${JSON.stringify(gardenTemplate.agriculture)}`, /seed(?:s|Resource|Qty)/i, "agriculture UI and persisted template config must not introduce a seed resource");
  assert.match(financeCompositionSource, /FinanceAgricultureDomain/, "the agriculture adapter must be composed into the real FinanceDomain");
  assert.match(economyRuntimeSource, /_agricultureFinanceFunction\(building, holding, periodQd\)/, "canonical agriculture labour must participate in wage and upkeep planning for the whole requested period");
  const agricultureRunIndex = economyRuntimeSource.indexOf("_runAgricultureForQd(holding");
  const productionRunIndex = economyRuntimeSource.indexOf("_runProductionAndLivestockForQd(holding, qd", agricultureRunIndex);
  assert.ok(agricultureRunIndex >= 0 && productionRunIndex > agricultureRunIndex, "tenday runtime must apply agriculture before generic production");
  assert.match(economyRuntimeSource, /_nonAgricultureProductionBuildings\(buildings\)/, "generic production must exclude Field/Garden even when an old saved line remains");
}

{
  const holding = {
    buildings: {
      list: [{
        id: "garden-runtime",
        templateId: "garden",
        name: "Сад",
        constructionStatus: "built",
        functions: { production: true },
        assignedWorkerIds: ["worker-1"],
        agriculture: {
          enabled: true,
          kind: "garden",
          activeCropId: "vegetables",
          outputRoomId: "outdoors",
          operations: { sow: true, harvest: true },
          crops: [fastCrop({ outputQty: 4, sowingWorkQd: 1, growingQd: 1, harvestWorkQd: 1 })],
          state: { phase: "empty" }
        }
      }]
    },
    people: { list: [{ id: "worker-1", name: "Садовник" }] },
    received: 0
  };
  const host = {
    ...FinanceAgricultureDomain,
    _buildingStatus: () => ({ value: "built" }),
    _buildingFunctions: () => ({ production: true }),
    _financeFunctionAllowed: () => true,
    _activeAssignedBuildingPeople: () => holding.people.list,
    _personDailyWorkQdLimit: () => 2,
    _agricultureCalendarContext: () => calendar(),
    _normalizeStorageRoomId: (value) => value,
    _storageAddWithOverflow: (target, _resource, qty) => { target.received += qty; return { qty }; }
  };
  const report = { produced: [], consumed: [], skipped: [], work: [], ledger: [] };
  const first = host._runAgricultureForQd(holding, 4, report, { operationId: "runtime-tenday", workerContext: {} });
  assert.equal(first.ok, true, "finance domain adapter must plan and apply the canonical plot cycle");
  assert.equal(holding.received, 4, "finance domain adapter must place the harvested whole units into storage");
  assert.equal(report.ledger[0]?.domain, "agriculture", "harvest must enter the unified economy ledger");
  const replay = host._runAgricultureForQd(holding, 4, report, { operationId: "runtime-tenday", workerContext: {} });
  assert.equal(replay.ok, true, "finance adapter must accept exact-operation replay");
  assert.equal(replay.replay, true, "finance adapter must expose replay status");
  assert.equal(holding.received, 4, "finance adapter replay must never add harvest twice");
  assert.equal(host._agricultureFinanceFunction(holding.buildings.list[0], holding).id, "agriculture", "finance obligations must have one canonical agriculture function id when sowing labour is planned");
  holding.buildings.list[0].agriculture.state = { phase: "growing", cropId: "vegetables", growingElapsedQd: 1 };
  holding.buildings.list[0].agriculture.crops[0].growingQd = 80;
  assert.equal(host._agricultureFinanceFunction(holding.buildings.list[0], holding), null, "growth that cannot reach labour during the period must not create wages or an operating labour obligation");
  assert.deepEqual(host._nonAgricultureProductionBuildings([
    holding.buildings.list[0],
    { id: "sawmill", templateId: "lumbermill", productionLines: [{ id: "wood" }] }
  ]).map((building) => building.id), ["sawmill"], "legacy production runner must exclude Field/Garden to prevent duplicate output from old saved lines");
}

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkAgricultureCharacterization();
  console.log("FBL Skyhold agriculture characterization checks passed.");
}
