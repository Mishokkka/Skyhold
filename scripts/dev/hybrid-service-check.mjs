import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildingActiveWorkerSummary, buildingConfirmedSocialStatus, buildingServiceCapacity,
  buildingConfirmedServiceCapacity, buildingServiceEffectFactor, buildingConfirmedLeisureCapacity,
  buildingServiceFunctionId
} from "../engines/economy/building-service.js";
import { storageProfileEffectFactor } from "../engines/storage/specialization.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { applyApprovedBuildingLaborProfile } from "../data/building-labor-catalog.js";

function fixture({ mode = "qd", functionId = "culture", service = { capacity: 100 }, threshold = 20, times = [20] } = {}) {
  const building = { id: "service", name: "Учреждение", constructionStatus: "built", lifecycle: "active", condition: "intact",
    labor: { version: 1, mode, capacityQd: null }, workersMin: 0, workersMax: 10,
    functions: { culture: true, production: true, storage: true, defense: true },
    productionLines: [{ id: "kitchen", active: true, source: "workers" }],
    activation: { minWorkers: 0, minOperationalQd: threshold }, service,
    maintenance: { schemaVersion: 2, requiredPoints: 1, backlogTendays: 0 } };
  const people = times.map((qd, i) => ({ id: `worker${i}`, name: `Работник ${i}`, age: 30,
    workAssignment: building.id, workAllocationMode: "explicit",
    workAllocations: [{ sourceId: building.id, functionId, normalQd: qd, overtimeQd: 0 }],
    ...(mode === "staff" ? { staffAppointment: { version: 1, buildingId: building.id,
      primaryFunctionId: functionId, reserveFunctionId: "", overtimeQd: 0, wageDailyCopper: 12 } } : {}) }));
  building.assignedWorkerIds = people.map((p) => p.id);
  building.serviceState = { periodKey: "tenday:1", functionId, active: true,
    activeWorkerIds: people.map((p) => p.id), activeWorkerIdsByFunction: { [functionId]: people.map((p) => p.id) },
    workedQd: times.reduce((sum, qd) => sum + qd, 0), workedQdByFunction: { [functionId]: times.reduce((sum, qd) => sum + qd, 0) },
    workedQdByWorkerAndFunction: Object.fromEntries(people.map((p, i) => [p.id, { [functionId]: times[i] }])) };
  const holding = { people: { list: people }, buildings: { list: [building] }, finance: {}, gm: { calendaria: { lastQd: 40 } } };
  return { holding, building, people };
}

export function checkHybridService() {
  {
    const { holding, building } = fixture({ mode: "passive", times: [] });
    building.activation.requiresMeaningfulResult = true;
    building.serviceState = { periodKey: "tenday:1", functionId: "culture", active: false, reason: "Старый след" };
    assert.equal(buildingServiceEffectFactor(holding, building), 1, "Passive infrastructure cannot require a worker or production trace");
    assert.equal(buildingConfirmedSocialStatus(holding, building).active, true);
    building.condition = "damaged";
    assert.equal(buildingServiceEffectFactor(holding, building), 0, "Passive does not bypass physical condition");
  }
  {
    const { holding, building } = fixture({ mode: "staff", times: [1] });
    assert.equal(buildingConfirmedSocialStatus(holding, building).laborFactor, 0.05);
    assert.equal(buildingServiceEffectFactor(holding, building), 0.05);
    assert.equal(buildingServiceCapacity(holding, building), 5);
    assert.equal(buildingConfirmedServiceCapacity(holding, building), 5, "One QD cannot grant full fixed capacity");
    building.maintenance.backlogTendays = 2;
    assert.equal(buildingConfirmedServiceCapacity(holding, building), 2, "Labor and maintenance multiply once each");
  }
  {
    const f = fixture({ times: [10, 10], service: { capacityPerWorker: 10 } });
    assert.equal(buildingConfirmedServiceCapacity(f.holding, f.building), 10, "Two half-time people provide one worker-equivalent");
    const g = fixture({ times: [10], service: { capacityBase: 100, capacityPerWorker: 10 } });
    assert.equal(buildingConfirmedServiceCapacity(g.holding, g.building), 55, "Per-worker capacity must not be scaled twice");
    const h = fixture({ times: [20], service: { capacityBase: 20, capacityPerWorkerStep: 10, workerStep: 1 } });
    assert.equal(buildingConfirmedServiceCapacity(h.holding, h.building), 20, "Removing general minimum staff cannot add a free capacity step");
  }
  {
    for (const unavailable of ["dead", "away", "injured"]) {
      const { holding, building, people } = fixture({ times: [10, 10] });
      if (unavailable === "dead") people[0].dead = true;
      if (unavailable === "away") people[0].shipAssignment = { shipId: "ship", away: true };
      if (unavailable === "injured") people[0].injuredDays = 2;
      const workforce = buildingActiveWorkerSummary(holding, building, "culture");
      assert.equal(workforce.count, 1);
      assert.equal(workforce.qd, 10, `${unavailable} work cannot be borrowed by the remaining worker`);
      assert.equal(buildingServiceCapacity(holding, building), 50);
      assert.equal(buildingConfirmedServiceCapacity(holding, building), 50);
      people[1].dead = true;
      assert.equal(buildingServiceEffectFactor(holding, building), 0);
      assert.equal(buildingConfirmedServiceCapacity(holding, building), 0);
    }
    const f = fixture({ times: [10, 10] });
    delete f.building.serviceState.workedQdByWorkerAndFunction;
    f.people[0].dead = true;
    assert.equal(buildingActiveWorkerSummary(f.holding, f.building, "culture").qd, 0,
      "An old aggregate trace cannot identify the share of a removed worker");
  }
  {
    const f = fixture({ mode: "staff", functionId: "production:kitchen" });
    f.building.templateId = "inn";
    f.building.activation.anyWorkingFunction = true;
    f.building.activation.requiresMeaningfulResult = true;
    f.building.serviceState.meaningfulResult = true;
    f.building.service.leisure = { kind: "drinking", capacity: 15, qdPerCapacity: 1, functionId: "culture" };
    f.people[0].staffAppointment.reserveFunctionId = "culture";
    assert.equal(buildingServiceFunctionId(f.building), "culture");
    assert.equal(buildingServiceEffectFactor(f.holding, f.building), 0, "A meaningful kitchen result cannot lend its QD to the hall");
    assert.equal(buildingConfirmedLeisureCapacity(f.holding, f.building), 0, "Kitchen work cannot run the inn's hall");
    const target = applyApprovedBuildingLaborProfile(f.building);
    assert.equal(target.activation.anyWorkingFunction, false);
    const g = fixture({ mode: "staff", times: [10] });
    g.people[0].staffAppointment.primaryFunctionId = "production:kitchen";
    g.people[0].staffAppointment.reserveFunctionId = "culture";
    assert.equal(buildingConfirmedServiceCapacity(g.holding, g.building), 50, "Actual reserve service work is valid evidence");
    delete g.building.serviceState;
    assert.equal(buildingServiceCapacity(g.holding, g.building), 0, "An unexecuted reserve is not a second full shift");
  }
  {
    const f = fixture({ functionId: "storage", times: [1] });
    f.building.storage = { profileRequiresStaff: true, capacity: 1000, profileCapacityMultiplier: 0.5 };
    assert.equal(storageProfileEffectFactor(f.holding, f.building), 0.05);
    f.people[0].shipAssignment = { shipId: "ship", away: true };
    assert.equal(storageProfileEffectFactor(f.holding, f.building), 0);
    assert.equal(f.building.storage.capacity, 1000, "Loss of staff cannot delete the physical storage volume");
  }
  {
    const f = fixture({ times: [10, 10], service: {} });
    f.building.control = { generalPerWorker: 1, maximum: 10, capacity: 100 };
    assert.equal(settlementControlSummary(f.holding, { includePolitics: false }).generalControl, 1,
      "Control cannot count two half shifts as two full employees");
    const g = fixture({ functionId: "defense", times: [1, 1] });
    g.building.defense = { base: 2, perStep: 1, workerStep: 1 };
    const host = { ...BuildingProductionDomain, _buildingStatus: () => ({ value: "built" }),
      _safeNumber: (v, fallback = 0) => Number.isFinite(Number(v)) ? Number(v) : fallback };
    assert.equal(host._buildingDefenseSummary(g.building, g.holding).total, 2,
      "Short defense work cannot manufacture a full staffed defense step");
  }
  {
    const f = fixture({ times: [10] });
    delete f.building.labor;
    assert.equal(buildingConfirmedServiceCapacity(f.holding, f.building), 0, "Legacy service activation is unchanged");
    f.building.activation.minOperationalQd = 0;
    assert.equal(buildingConfirmedServiceCapacity(f.holding, f.building), 100);
  }
  return { partialCapacity: true, scopedStaffWork: true, passive: true, absentAndDead: true, storageAndControl: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkHybridService()));
}
