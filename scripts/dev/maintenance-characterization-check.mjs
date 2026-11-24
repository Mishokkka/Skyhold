import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { normalizePerson } from "../data/normalizers/resident.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { buildWorkAllocationTargets } from "../data/work-allocations.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";

export async function checkMaintenanceCharacterization() {
  const building = {
    id: "mill",
    name: "Мельница",
    constructionStatus: "built",
    lifecycle: "active",
    condition: "intact",
    workersMax: 2,
    maintenance: { schemaVersion: 2, requiredPoints: 3, priority: 90, backlogTendays: 4, needsResolution: true },
    functions: { production: true },
    productionLines: [{ id: "flour", active: true, source: "workers", workQd: 1, resourceId: "flour", resource: "Мука", outputQty: 4, expenses: "" }]
  };
  normalizeBuilding(building);
  assert.equal(Object.hasOwn(building, "maintenance"), false, "normal load must strip legacy maintenance state from buildings");

  const person = {
    id: "worker",
    name: "Работник",
    maintenancePointsPerTenday: 5,
    workAllocations: [
      { sourceId: "mill", functionId: "production:flour", normalQd: 20, overtimeQd: 0 }
    ]
  };
  normalizePerson(person);
  assert.equal(Object.hasOwn(person, "maintenancePointsPerTenday"), false, "normal load must strip legacy maintenance points from residents");

  const holding = {
    people: { list: [person] },
    buildings: { list: [building] },
    storage: { resources: [] }
  };
  const targets = buildWorkAllocationTargets(holding);
  assert.equal(targets.some((row) => row.functionId === "maintenance" || row.sourceId === "maintenance"), false,
    "work allocation targets must expose no technical maintenance jobs");

  const report = { produced: [], consumed: [], skipped: [], formulas: [], ledger: [] };
  await runProductionCycle({
    holding,
    qd: 1,
    report,
    buildings: [building],
    budgets: new Map([["worker", { available: 1, spent: 0 }]]),
    workerContext: {},
    dependencies: {
      safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback),
      resetWorkerBudgets: () => {},
      accrueWorkerBudgets: () => {},
      getSeasonSnapshot: () => null,
      buildingStatus: () => ({ value: "built" }),
      buildingFunctions: () => ({ production: true }),
      lineFinanceAllowed: () => true,
      lineSeasonAllowed: () => true,
      periodDueOnStep: () => false,
      normalizeResourceId: (value) => value,
      resourceLabel: (value) => value,
      lineContentQuantity: () => 0,
      buildingEffectiveWorkers: () => ({ total: 1 }),
      lineOutputForCycle: async () => ({ qty: 4, formula: "" }),
      parseResourceCosts: () => [],
      costsForUnits: () => [],
      scaledCosts: () => [],
      storageCanPay: () => ({ ok: true, costs: [] }),
      storagePay: () => ({ costs: [] }),
      normalizeStorageRoomId: () => "outdoors",
      storageAddWithOverflow: (targetHolding, resource, qty) => {
        targetHolding.storage.resources.push({ resourceId: resource.resourceId, qty });
        return [{ roomId: "outdoors", qty }];
      },
      pushProductionPlacement: () => {},
      appendLedger: () => {},
      autoCollectBuilding: async () => {},
      assignedBuildingPeople: () => [person],
      workerBudgetEntry: (_h, _p, budgets) => budgets.get("worker"),
      personBuildingEfficiency: () => 1,
      buildingCompositionStatus: () => ({ met: true, text: "—" }),
      storageQuantity: () => 0,
      tryCollectResourceForConsumer: async () => 0,
      formatNumber: String
    }
  });
  assert.equal(holding.storage.resources[0]?.qty, 4, "production operates at 100% with no technical maintenance gate or penalty");
  assert.equal(building.productionLines[0].workProgressUnits, 0);

  const mainTemplate = fs.readFileSync(new URL("../../templates/parts/building-editor/main.hbs", import.meta.url), "utf8");
  const residentTemplate = fs.readFileSync(new URL("../../templates/parts/skyhold-resident-editor.hbs", import.meta.url), "utf8");
  assert.doesNotMatch(mainTemplate, /building\.maintenance\./, "building editor template must not expose removed maintenance controls");
  assert.doesNotMatch(residentTemplate, /maintenancePointsPerTenday/, "resident editor template must not expose removed maintenance points");

  const current = {
    meta: { revision: 1 },
    holdings: [{
      id: "laputa",
      visibility: "public",
      gm: { playersCanEditBuildings: true },
      buildings: { list: [{ id: "forge" }] },
      people: { list: [] }
    }]
  };
  const forgedMaintenance = structuredClone(current);
  forgedMaintenance.holdings[0].buildings.list[0].maintenance = { requiredPoints: 1, needsResolution: true };
  const patch = buildPlayerPatch(current, forgedMaintenance);
  assert.equal(validatePlayerPatch(current, patch, "player-1").ok, false, "players cannot write legacy maintenance fields through patches");

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkMaintenanceCharacterization();
  console.log("FBL Skyhold maintenance removal contract: stripping, zero targets, 100% production, UI cleanup and guard rejection passed.");
}
