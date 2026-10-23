import assert from "node:assert/strict";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { SkyholdData } from "../data/store.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { buildWorkAllocationTargets } from "../data/work-allocations.js";
import { buildingHousingComfort } from "../engines/economy/building-service.js";
import { BuildingEventDomain } from "../apps/domains/events/building-events.js";
import { planHybridLaborMigration, planHybridLaborCatalogMigration } from "../workflows/buildings/hybrid-labor-migration.js";

const quantity = (holding, id) => (holding.storage.resources ?? []).filter((row) => row.resourceId === id).reduce((sum, row) => sum + row.qty, 0);
const template = (id) => structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === id));
async function run(fixture, operationId) {
  SkyholdData.view = () => ({ holdings: [fixture.holding], catalog: {} });
  return fixture.harness._runEconomyForQd(fixture.holding, 40, { operationId });
}

export async function checkHybridLaborFunctional() {
  const prior = { game: globalThis.game, view: SkyholdData.view };
  globalThis.game = { settings: { get: () => undefined } };
  try {
    for (const row of DEFAULT_BUILDING_TEMPLATES) {
      if (!["staff", "qd"].includes(row.labor?.mode)) continue;
      const building = { ...structuredClone(row), constructionStatus: "built", status: "Построено" };
      assert.ok(buildWorkAllocationTargets({ buildings: { list: [building] } }, { includeMaintenance: false }).length,
        `${row.id}: an approved labor mode must expose at least one operational task`);
    }
    for (const sourceKind of ["output", "ingredient"]) for (const helper of ["busy", "primary", "reserve"]) {
      const f = hybridRuntimeFixture({ count: 2, goal: null });
      const appointment = f.holding.people.list[1].staffAppointment;
      if (helper === "busy") {
        f.building.functions.culture = true;
        appointment.primaryFunctionId = "culture";
        appointment.reserveFunctionId = "production:main";
      } else if (helper === "reserve") {
        f.building.productionLines.push({ id: "paused", source: "workers", active: false });
        appointment.primaryFunctionId = "production:paused";
        appointment.reserveFunctionId = "production:main";
      }
      let source;
      if (sourceKind === "output") {
        source = f.building.productionLines[0];
        Object.assign(source, { active: false, requiresCollection: true, pendingQty: 4, collectQd: 3, autoCollect: "none" });
      } else {
        Object.assign(f.building.productionLines[0], { resourceId: "grain", expenses: "wood 2" });
        source = { id: "stock", source: "workers", active: false, resourceId: "wood", pendingQty: 2,
          requiresCollection: true, collectQd: 3, autoCollect: "worker" };
        f.holding.buildings.list.push({ id: "supplier", name: "Supplier", constructionStatus: "built",
          functions: { production: true }, productionLines: [source] });
      }
      const report = await run(f, `collection-${sourceKind}-${helper}`);
      if (helper === "busy") {
        assert.equal(quantity(f.holding, "stone"), 20, "A busy reserve helper must not trap the primary worker in paid idle time");
        assert.equal(f.building.serviceState.workedQdByFunction.culture, 20);
        assert.ok(source.pendingQty > 0);
        assert.equal(report.skipped.length, 1, "The shortfall should be explained once, without repeated missing-input messages");
        assert.match(report.skipped[0], /не хватает 1 QD/);
      } else assert.equal(source.pendingQty, 0, "A team actually selecting primary or reserve collection can still collect together");
    }

    for (const mode of ["staff", "qd"]) {
      const f = hybridRuntimeFixture({ goal: null });
      f.building.agriculture = template("grain-field").agriculture;
      Object.assign(f.building.agriculture, {
        crops: [{ id: "grain", resourceId: "grain", outputQty: 8, sowingSeasons: ["spring"], sowingWorkQd: 1,
          growingQd: 8, harvestWorkQd: 2, expiryRule: "qd", readyExpiryQd: 120, annualHarvestLimit: 1 }],
        activeCropId: "grain", operations: { sow: false, harvest: true },
        state: { phase: "growing", cropId: "grain", growingElapsedQd: 7, harvestYear: "1" }
      });
      f.building.labor.mode = mode; f.building.wageDailyCopper = 12;
      if (mode === "staff") {
        f.building.functions.culture = true;
        Object.assign(f.person.staffAppointment, { primaryFunctionId: "agriculture", reserveFunctionId: "culture" });
      } else {
        delete f.person.staffAppointment; delete f.person.wageDailyOverrideCopper;
        f.building.assignedWorkerIds = []; f.person.workAssignment = ""; f.person.workAllocationMode = "explicit";
        f.person.workAllocations = [{ sourceId: f.building.id, functionId: "agriculture", normalQd: 20, overtimeQd: 0 }];
      }
      f.harness._agricultureCalendarContext = () => ({ year: "1", seasonId: "spring", seasonKey: "1:spring" });
      await run(f, `mid-period-harvest-${mode}`);
      assert.equal(quantity(f.holding, "grain"), 8, `${mode}: finance must retain the assigned harvest that becomes available inside the period`);
      assert.equal(f.building.agriculture.state.phase, "empty");
      assert.equal(f.holding.storage.moneyCopper, 9880, "The funded assignment keeps its existing wage contract");
    }

    for (const id of ["worker-dormitory", "mansion"]) {
      const f = hybridRuntimeFixture({ goal: null });
      Object.assign(f.building, template(id), { id: "workshop", templateId: id, constructionStatus: "built", status: "Построено" });
      assert.ok(buildWorkAllocationTargets(f.holding).some((row) => row.functionId === "housing"), `${id}: caretaker work must be assignable`);
      if (id === "worker-dormitory") {
        delete f.person.staffAppointment; delete f.person.wageDailyOverrideCopper;
        f.building.assignedWorkerIds = []; f.person.workAssignment = ""; f.person.workAllocationMode = "explicit";
        f.person.workAllocations = [{ sourceId: f.building.id, functionId: "housing", normalQd: 10, overtimeQd: 0 }];
        assert.equal(buildingHousingComfort(f.holding, f.building), -1, "An assignment alone cannot grant confirmed comfort");
        await run(f, "caretaker-qd"); f.holding.gm.calendaria.lastQd = 40;
        assert.equal(f.building.serviceState.workedQdByFunction.housing, 10);
        assert.equal(buildingHousingComfort(f.holding, f.building), 0, "Ten funded caretaker QD grant the catalog's staffed comfort");
        f.person.workAllocations = [];
        assert.equal(buildingHousingComfort(f.holding, f.building), -1, "Releasing the caretaker invalidates the old service trace");
      } else {
        f.building.assignedWorkerIds = [f.person.id];
        Object.assign(f.person.staffAppointment, { primaryFunctionId: "housing", reserveFunctionId: "" });
        await run(f, "caretaker-staff");
        assert.equal(f.building.serviceState.workedQdByFunction.housing, 20);
      }
    }

    const warehouse = template("warehouse"); delete warehouse.labor;
    Object.assign(warehouse, { id: "custom-warehouse", templateId: "warehouse", constructionStatus: "built", workersMax: 1,
      functions: { ...warehouse.functions, production: true }, assignedWorkerIds: [],
      productionLines: [{ id: "custom", source: "workers", active: true, resourceId: "wood", outputQty: 1, workQd: 1 }] });
    const holding = { buildings: { list: [warehouse] }, people: { list: [] } };
    const before = structuredClone(holding), automatic = planHybridLaborMigration({ holding });
    assert.equal(automatic.ok, false, "A known template id cannot silently disable custom production");
    assert.ok(automatic.issues.some((row) => row.code === "labor-profile-choice"));
    const explicit = planHybridLaborMigration({ holding, profiles: { [warehouse.id]: { version: 1, mode: "qd", capacityQd: null } } });
    assert.equal(explicit.ok, true);
    assert.deepEqual(explicit.targetHolding.buildings.list[0].productionLines, warehouse.productionLines);
    assert.deepEqual(holding, before, "Transition previews cannot mutate world data");
    assert.equal(planHybridLaborCatalogMigration({ catalog: { buildings: [{ ...warehouse, id: "warehouse" }] } }).ok, false);

    const clearFixture = hybridRuntimeFixture({ count: 2 });
    clearFixture.holding.workforcePlan.locks = [{ personId: "worker-1", sourceId: "workshop", functionId: "production:main" }];
    const cleared = BuildingEventDomain._clearBuildingWorkers.call({}, clearFixture.holding, "workshop");
    assert.equal(cleared.cleared, 1);
    assert.equal(clearFixture.person.staffAppointment, undefined);
    assert.ok(clearFixture.holding.people.list[1].staffAppointment, "A context action must preserve locked staff contracts");
    const qdPerson = { id: "qd-worker", workAllocationMode: "explicit", workAllocations: [
      { sourceId: "workshop", functionId: "production:main", normalQd: 4, overtimeQd: 0 },
      { sourceId: "workshop", functionId: "production:reserve", normalQd: 2, overtimeQd: 0 },
      { sourceId: "other", functionId: "production:other", normalQd: 6, overtimeQd: 0 }
    ] };
    const qdHolding = { buildings: { list: [{ id: "workshop", labor: { version: 1, mode: "qd", capacityQd: null }, assignedWorkerIds: [] }] },
      people: { list: [qdPerson] }, workforcePlan: { locks: [{ personId: qdPerson.id, sourceId: "workshop", functionId: "production:reserve" }] } };
    assert.equal(BuildingEventDomain._clearBuildingWorkers.call({}, qdHolding, "workshop").cleared, 1);
    assert.deepEqual(qdPerson.workAllocations.map((row) => [row.sourceId, row.functionId]),
      [["workshop", "production:reserve"], ["other", "production:other"]], "Clearing QD must preserve external assignments and the exact locked task");
  } finally { globalThis.game = prior.game; SkyholdData.view = prior.view; }
}
