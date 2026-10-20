import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BuildingLivestockDomain } from "../apps/domains/building/livestock-domain.js";
import { FinanceLivestockDomain, workQdForLimit } from "../apps/domains/finance/livestock-domain.js";
import { applyLivestockPeriodPlan, planLivestockPeriod } from "../engines/economy/livestock-period.js";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function quantity(holding, resourceId) {
  return (holding.storage.resources ?? [])
    .filter((row) => row.resourceId === resourceId)
    .reduce((sum, row) => sum + Number(row.qty || 0), 0);
}

function take(holding, resourceId, requested) {
  let rest = requested;
  for (const row of holding.storage.resources ?? []) {
    if (row.resourceId !== resourceId || rest <= 0) continue;
    const amount = Math.min(rest, Number(row.qty || 0));
    row.qty -= amount;
    rest -= amount;
  }
  return requested - rest;
}

function add(holding, resourceId, qty, roomId = "outdoors") {
  let row = (holding.storage.resources ?? []).find((candidate) => candidate.resourceId === resourceId && candidate.roomId === roomId);
  if (!row) {
    row = { id: `resource-${resourceId}-${roomId}`, resourceId, roomId, qty: 0 };
    holding.storage.resources.push(row);
  }
  row.qty += qty;
  return [{ resourceId, roomId, qty }];
}

function livestockBuilding(id, speciesId, { adults = 0, breedingMales = 0, gmPriority = 500, operations = {}, assignedWorkerIds = [] } = {}) {
  return {
    id,
    name: id,
    templateId: speciesId === "cattle" ? "pasture" : speciesId === "pigs" ? "pigsty" : "sheepfold",
    constructionStatus: "built",
    functions: { production: true },
    assignedWorkerIds,
    livestock: {
      enabled: true,
      speciesId,
      gmPriority,
      outputRoomId: "root-cellar",
      state: { adults, breedingMales, young: [], woolReady: 0, lastBirthSeasonKey: "", lastWoolSeasonKey: "" },
      operations: { milk: speciesId === "cattle", shearQty: 0, slaughterQty: 0, slaughterBreedingMales: 0, feedPriority: "adults", ...operations }
    }
  };
}

export function checkLivestockRuntimeCharacterization() {
  assert.equal(workQdForLimit(40, 2), 20, "normal workers allocate exactly two QD per day");
  assert.equal(workQdForLimit(40, 3), 30, "overtime workers allocate exactly three QD per day");
  assert.equal(workQdForLimit(3, 2), 2, "work cannot be banked beyond the daily cap in a partial day");

  const highPriority = livestockBuilding("pig-high", "pigs", { adults: 3, breedingMales: 1, gmPriority: 900 });
  const lowPriority = livestockBuilding("pig-low", "pigs", { adults: 3, breedingMales: 1, gmPriority: 100 });
  const periodPlan = planLivestockPeriod({
    buildings: [lowPriority, highPriority],
    elapsedQd: 40,
    operationId: "livestock-priority",
    dependencies: {
      isOperational: () => true,
      isFunctionAllowed: () => true,
      resourceQuantity: (resourceId) => resourceId === "animal-feed" ? 3 : 0,
      workQdForBuilding: () => 20,
      seasonContextForCycle: () => ({ seasonId: "spring", seasonKey: "882:spring" })
    }
  });
  assert.deepEqual(periodPlan.entries.map((entry) => entry.buildingId), ["pig-high", "pig-low"], "limited feed must follow descending GM priority and stable IDs");
  assert.equal(periodPlan.entries[0].cycles[0].feeding.feedConsumed, 3);
  assert.equal(periodPlan.entries[0].born, 9, "a fed sow produces the approved six-young litter, capped by the twelve-head building capacity");
  assert.equal(periodPlan.entries[1].cycles[0].feeding.feedConsumed, 0);
  assert.equal(periodPlan.entries[1].born, 0, "unfed adults do not participate in breeding");
  assert.equal(periodPlan.entries[1].stateAfter.adults, 3, "lack of feed never kills livestock automatically");

  const staleBuildings = new Map([[highPriority.id, clone(highPriority)], [lowPriority.id, clone(lowPriority)]]);
  staleBuildings.get("pig-high").livestock.state.adults = 4;
  let staleMutations = 0;
  const stale = applyLivestockPeriodPlan({
    plan: periodPlan,
    dependencies: {
      getBuilding: (id) => staleBuildings.get(id),
      resourceQuantity: () => 999,
      consumeResource: () => { staleMutations += 1; },
      addResource: () => { staleMutations += 1; },
      setState: () => { staleMutations += 1; },
      resetOperations: () => { staleMutations += 1; }
    }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(staleMutations, 0, "the multi-building apply preflight must remain atomic on stale herd state");

  const pasture = livestockBuilding("pasture-1", "cattle", {
    adults: 3,
    breedingMales: 1,
    assignedWorkerIds: ["worker-1"],
    operations: { milk: true, slaughterQty: 1, slaughterBreedingMales: 0 }
  });
  const blocked = livestockBuilding("pasture-blocked", "cattle", { adults: 2, breedingMales: 1, assignedWorkerIds: ["worker-2"] });
  const holding = {
    id: "laputa",
    gm: { calendaria: { lastDateTime: { year: 882, month: 2, day: 1, hour: 0 }, lastDateText: "1 Теплороста 882" } },
    people: { list: [{ id: "worker-1", name: "Пастух" }, { id: "worker-2", name: "Без жалования" }] },
    buildings: { list: [pasture, blocked] },
    storage: { resources: [] }
  };
  const report = { produced: [], consumed: [], skipped: [], work: [], ledger: [] };
  const app = {
    ...FinanceLivestockDomain,
    _buildingStatus: () => ({ value: "built" }),
    _buildingFunctions: () => ({ production: true }),
    _financeFunctionAllowed: (_financeContext, building) => building.id !== "pasture-blocked",
    _currentProductionSeasonKey: (snapshot) => snapshot?.season?.key ?? "",
    _activeAssignedBuildingPeople: (target, building) => building.assignedWorkerIds.map((id) => target.people.list.find((person) => person.id === id)).filter(Boolean),
    _personDailyWorkQdLimit: () => 2,
    _storageQuantity: (target, resource) => quantity(target, resource.resourceId),
    _storageCanPay: (target, costs) => ({
      ok: costs.every((cost) => quantity(target, cost.resourceId) >= cost.qty),
      costs
    }),
    _storagePay: (target, costs) => {
      for (const cost of costs) assert.equal(take(target, cost.resourceId, cost.qty), cost.qty);
      return { ok: true, costs };
    },
    _normalizeStorageRoomId: (roomId) => String(roomId || "outdoors"),
    _storageAddWithOverflow: (target, resource, qty) => add(target, resource.resourceId, qty, resource.roomId)
  };
  const runtime = app._runLivestockForQd(holding, 40, report, { operationId: "laputa-882-01", financeContext: {} });
  assert.equal(runtime.ok, true);
  assert.equal(pasture.livestock.state.young[0].qty, 1, "spring breeding persists a young cohort");
  assert.equal(quantity(holding, "milk"), 20, "one daily QD milks every eligible cow in the building");
  assert.equal(quantity(holding, "meat"), 180, "batch milking leaves enough work for the approved slaughter order");
  assert.equal(quantity(holding, "pelt"), 1, "each slaughtered cow also produces one pelt");
  assert.equal(pasture.livestock.operations.slaughterQty, 0, "one-shot slaughter orders reset after Apply");
  assert.equal(pasture.livestock.operations.slaughterBreedingMales, 0);
  assert.equal(blocked.livestock.state.young.length, 0, "a finance-blocked livestock function remains unchanged");
  assert.equal(report.skipped.some((line) => line.includes("pasture-blocked") && line.includes("неоплаченных")), true);
  assert.equal(report.ledger.some((row) => row.domain === "livestock" && row.resourceId === "milk" && row.qty === 20), true);

  const view = BuildingLivestockDomain._prepareLivestockBuildingView.call({
    _normalizeStorageRoomId: (roomId) => String(roomId || "outdoors"),
    _storageRoomOptionsFromRooms: (_rooms, selected) => [{ value: selected, label: selected, selected: true }]
  }, holding, pasture, "holdings.0.buildings.list.0", []);
  assert.equal(view.headcount, 3);
  assert.equal(view.capacity, 12);
  assert.equal(view.adultsPath, "holdings.0.buildings.list.0.livestock.state.adults");
  assert.equal(view.youngRows[0].qtyPath, "holdings.0.buildings.list.0.livestock.state.young.0.qty");
  assert.equal(view.outputRoomOptions.find((row) => row.value === pasture.livestock.outputRoomId)?.selected, true);
  assert.ok(view.outputRoomOptions.some((row) => row.value === "auto"), "automatic destination is a separate explicit choice");

  const template = fs.readFileSync(new URL("../../templates/parts/building-editor/livestock.hbs", import.meta.url), "utf8");
  const editor = fs.readFileSync(new URL("../apps/editors/building-editor.js", import.meta.url), "utf8");
  assert.match(template, /data-action="add-livestock-cohort"/);
  assert.match(template, /data-action="delete-livestock-cohort"/);
  assert.match(template, /livestockView\.slaughterQtyPath/);
  assert.match(editor, /"add-livestock-cohort": "_onAddLivestockCohort"/);
  assert.match(editor, /"delete-livestock-cohort": "_onDeleteLivestockCohort"/);

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkLivestockRuntimeCharacterization();
  console.log("FBL Skyhold livestock runtime: priority feed, finance blocking, daily work, atomic apply, persisted operations and editor contracts passed.");
}
