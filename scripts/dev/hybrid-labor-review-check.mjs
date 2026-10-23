import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BuildingEventDomain } from "../apps/domains/events/building-events.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { FinanceStaffDomain } from "../apps/domains/finance/staff-domain.js";
import { SkyholdData } from "../data/store.js";
import { validateHoldingWorkAllocations } from "../data/work-allocations.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { planAgriculturePlot } from "../engines/economy/agriculture.js";

export async function checkHybridLaborReview() {
  const fixture = hybridRuntimeFixture();
  fixture.holding.visibility = "public";
  fixture.holding.gm.playersCanEditBuildings = true;
  fixture.building.visibility = "public";
  fixture.person.visibility = "public";
  fixture.person.home = fixture.building.name;
  fixture.holding.buildings.list.push({ id: "other", name: "Other", constructionStatus: "built",
    labor: { version: 1, mode: "qd", capacityQd: null }, requiredBuildingIds: ["workshop", "retained"],
    functions: { production: true }, productionLines: [{ id: "other", source: "workers", resourceId: "stone", workQd: 1, outputQty: 1 }] });
  fixture.holding.people.list.push({ id: "part-time", age: 30, workAllocationMode: "explicit", workAllocations: [
    { sourceId: "workshop", functionId: "production:main", normalQd: 2, overtimeQd: 0 },
    { sourceId: "other", functionId: "production:other", normalQd: 2, overtimeQd: 0 }
  ] });
  fixture.holding.workforcePlan.goals = [{ sourceId: "workshop", functionId: "production:main", normalQd: 2 }];
  fixture.holding.workforcePlan.locks = [{ personId: "worker-0", sourceId: "workshop", functionId: "production:main" }];
  fixture.holding.workforcePlan.productionGoals.push({ sourceId: "other", functionId: "production:other", preparedUnits: 1 });
  const before = { holdings: [structuredClone(fixture.holding)] };
  const prior = { get: SkyholdData.get, updateHolding: SkyholdData.updateHolding, game: globalThis.game, ui: globalThis.ui };
  let writes = 0, confirmed = false;
  try {
    globalThis.game = { user: { isGM: true } };
    globalThis.ui = { notifications: { warn: assert.fail, info() {} } };
    SkyholdData.get = () => ({ holdings: [fixture.holding] });
    SkyholdData.updateHolding = async (_id, update) => { writes += 1; return update(fixture.holding); };
    const app = { activeHoldingId: fixture.holding.id, _confirmAction: async () => confirmed, requestRender() {} };
    await BuildingEventDomain._executeBuildingContextAction.call(app, "workshop", "delete");
    assert.equal(writes, 0, "Cancelling deletion cannot clear any assignments");
    confirmed = true;
    await BuildingEventDomain._executeBuildingContextAction.call(app, "workshop", "delete");
    assert.equal(writes, 1);
    assert.equal(fixture.person.staffAppointment, undefined, "Context deletion must release the permanent contract");
    assert.equal(fixture.person.workAssignment, "");
    assert.equal(fixture.person.home, "");
    assert.deepEqual(fixture.holding.people.list[1].workAllocations.map((row) => row.sourceId), ["other"]);
    assert.deepEqual(fixture.holding.buildings.list[0].requiredBuildingIds, ["retained"]);
    assert.deepEqual(fixture.holding.workforcePlan.goals, [], "Deleted building goals cannot block a later transition");
    assert.deepEqual(fixture.holding.workforcePlan.locks, []);
    assert.deepEqual(fixture.holding.workforcePlan.productionGoals.map((row) => row.sourceId), ["other"]);
    assert.equal(validateHoldingWorkAllocations(fixture.holding).ok, true);
    const patch = buildPlayerPatch(before, { holdings: [fixture.holding] });
    assert.equal(validatePlayerPatch(before, patch).ok, false,
      "Cleanup must preserve the existing GM-only deletion contract, even with player building-edit permission");
    before.holdings[0].gm.playersCanEditBuildings = false;
    assert.equal(validatePlayerPatch(before, patch).ok, false, "Reference cleanup does not bypass building permissions");
  } finally {
    SkyholdData.get = prior.get; SkyholdData.updateHolding = prior.updateHolding;
    globalThis.game = prior.game; globalThis.ui = prior.ui;
  }
  for (const mode of ["legacy", "staff", "qd", "passive"]) for (const collectQd of [0, 2]) {
    const building = mode === "legacy" ? {} : { labor: { version: 1, mode, capacityQd: null } };
    const rows = BuildingProductionDomain._pendingProductionRows.call({}, building, {}, 0, [
      { active: true, _index: 0, resource: "Wood", pendingQty: 2, collectQd }
    ]);
    assert.equal(rows[0].manualCollectionBlocked, ["staff", "qd"].includes(mode) && collectQd > 0);
    assert.ok(rows[0].collectionHint);
  }
  const crop = { id: "grain", resourceId: "grain", outputQty: 960, harvestWorkQd: 56,
    expiryRule: "qd", readyExpiryQd: 200 };
  let state = { phase: "ready", cropId: "grain", harvestTotalQty: 960, readyQty: 960,
    harvestWorkQdTotal: 56, harvestProgressQd: 0 };
  let produced = 0;
  for (const [index, availableWorkQd] of [20, 20, 16].entries()) {
    const result = planAgriculturePlot({ state, crop, operations: { harvest: true }, elapsedQd: 40, availableWorkQd,
      operationId: `field-period-${index}`, calendarContextForOffset: () => ({ year: "1", seasonId: "summer", seasonKey: "1:summer" }) });
    assert.equal(result.workQdUsed, availableWorkQd);
    produced += result.resourceChanges.reduce((sum, row) => sum + row.qty, 0);
    state = JSON.parse(JSON.stringify(result.stateAfter));
    if (index < 2) assert.equal(state.harvestProgressQd, (index + 1) * 20,
      "Agricultural harvest preserves progress across days and saved tendays");
  }
  assert.equal(produced, 960);
  assert.equal(state.phase, "empty");
  const financeContext = { staffStep: 0,
    staffAppointmentsByWorkerId: new Map([["worker", { buildingId: "employer", primaryFunctionId: "production:main", reserveFunctionId: "" }]]),
    plannedWorkSlotsByWorkerId: new Map([["worker", new Map([
      [0, { functionId: "production:main" }], [1, { functionId: "staff" }],
      [4, { functionId: "staff" }], [5, { functionId: "staff", overtime: true }]
    ])]]), staffReservedStepsByWorkerId: new Map([["worker", new Set([4])]]),
    staffOvertimeFunctionsByWorkerId: new Map([["worker", new Set()]]) };
  const dailyBudget = () => FinanceStaffDomain._staffDailyCollectionBudget({ id: "employer" }, "production:main", { financeContext });
  assert.equal(dailyBudget(), 1, "Consumed, reserved and forbidden overtime slots cannot fund collection again");
  financeContext.staffOvertimeFunctionsByWorkerId.get("worker").add("production:main");
  financeContext.staffReservedStepsByWorkerId.get("worker").clear();
  assert.equal(dailyBudget(), 2, "Only permitted overtime contributes to the daily collection budget");
  financeContext.staffStep = 8;
  assert.equal(dailyBudget(), 0, "Unspent slots from past days cannot carry into a later collection day");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkHybridLaborReview();
  console.log("Hybrid labor review: context deletion, player permissions and collection controls passed.");
}
