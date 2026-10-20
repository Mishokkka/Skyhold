import assert from "node:assert/strict";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { buildingConfirmedSocialStatus, buildingConfirmedLeisureCapacity, buildingConfirmedHarmActive } from "../engines/economy/building-service.js";
import { confirmSocialWork } from "./social-effects-fixtures.mjs";

export function checkBuildingSocialEffects() {
  const app = { ...ResidentDomain, ...BuildingProductionDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _buildingStatus: (building) => ({ value: building.constructionStatus }),
    _gmSettlementModifiers: () => ({ morale: 0, reputation: 0 }) };
  const people = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, volunteerLabor: true,
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } }));
  const venue = (id, kind = "drinking", capacity = 15) => ({ id, templateId: "tavern", name: id,
    constructionStatus: "built", lifecycle: "active", condition: "intact", moraleDelta: capacity, reputation: 1,
    functions: { culture: true }, workersMax: 4, activation: { minWorkers: 1, minOperationalQd: 4 },
    service: { leisure: { kind, capacity, qdPerCapacity: 1, minWorkers: 1 } } });
  const holding = { people: { list: people }, buildings: { list: [] }, finance: {}, gm: { calendaria: { lastQd: 40 } } };
  for (const [count, expected] of [[1, 15], [2, 26], [4, 36], [10, 54]]) {
    holding.buildings.list = Array.from({ length: count }, (_, i) => venue(`venue${i}`));
    for (const [i, b] of holding.buildings.list.entries()) confirmSocialWork(holding, b, [people[i].id]);
    const before = structuredClone(holding);
    const result = app._buildingMoraleSummary(holding);
    assert.equal(result.total, expected);
    assert.equal(result.sources.reduce((sum, row) => sum + row.value, 0), expected);
    assert.equal(app._reputationSummary(holding).total, 1, "Leisure repeats do not repeat reputation");
    holding.buildings.list.reverse();
    assert.equal(app._buildingMoraleSummary(holding).total, expected, "Card order cannot change the total");
    holding.buildings.list.reverse();
    assert.deepEqual(holding, before, "Social calculations are read-only");
  }
  holding.buildings.list = [venue("a", "drinking", 15), venue("b", "gathering", 10), venue("c", "games", 20), venue("d", "performance", 30)];
  for (const [i, b] of holding.buildings.list.entries()) confirmSocialWork(holding, b, [people[2 * i].id, people[2 * i + 1].id]);
  assert.equal(app._buildingMoraleSummary(holding).total, 75, "Leisure can exceed the population of 60");
  const building = holding.buildings.list[0];
  delete building.serviceState;
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 0, "Assignments are only a forecast");
  confirmSocialWork(holding, building, [people[0].id], 10);
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 10, "Partial work yields partial capacity");
  building.serviceState.periodKey = "tenday:0";
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 0, "Stale work cannot keep a service active");
  confirmSocialWork(holding, building, [people[0].id, people[1].id], 10);
  building.assignedWorkerIds = [people[0].id];
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 10, "Departed workers cannot lend their old QD to the remaining worker");
  people[0].shipAssignment = { shipId: "ship", away: true };
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 0, "Away workers cannot keep a service active");
  delete people[0].shipAssignment;
  confirmSocialWork(holding, building, [people[0].id], 20, "production");
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 0, "Kitchen work cannot satisfy culture staffing or QD");
  confirmSocialWork(holding, building, [people[0].id], 20);
  people[0].workAllocationMode = "explicit";
  people[0].workAllocations = [{ sourceId: building.id, functionId: "maintenance", normalQd: 20 }];
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 0, "Technical maintenance is not leisure work");
  people[0].workAllocations = [{ sourceId: building.id, functionId: "culture", normalQd: 20 }];
  assert.equal(buildingConfirmedLeisureCapacity(holding, building), 15);
  building.lifecycle = "disabled";
  assert.equal(buildingConfirmedSocialStatus(holding, building).active, false);
  building.lifecycle = "active";
  holding.finance = { obligations: [{ id: "debt", kind: "building-base-upkeep", recipientId: building.id,
    status: "unpaid", dueCopper: 10, paidCopper: 0, periodIndex: 1 }] };
  assert.equal(buildingConfirmedSocialStatus(holding, building).active, false, "Unpaid upkeep blocks the positive service");
  assert.equal(buildingConfirmedHarmActive(holding, building), true, "Debt does not erase actual harmful work");
  holding.finance = {};
  const noStaff = { ...venue("passive"), service: undefined, workersMax: 0, activation: { minWorkers: 0, minOperationalQd: 0 },
    serviceState: { periodKey: "tenday:1", functionId: "culture", workedQd: 20, activeWorkerIds: [] } };
  assert.equal(buildingConfirmedSocialStatus(holding, noStaff).active, false, "Even an old passive positive requires a real worker");
  const inactive = venue("first-but-closed");
  holding.buildings.list = [inactive, building];
  assert.equal(app._buildingMoraleSummary(holding).total, 15, "Inactive venues never occupy repeat ranks");
  const industry = { ...venue("factory"), moraleDelta: -2, service: undefined };
  confirmSocialWork(holding, industry, [people[2].id]);
  const industry2 = structuredClone(industry); industry2.id = "factory2";
  holding.buildings.list = [industry, industry2];
  assert.equal(app._buildingMoraleSummary(holding).total, -4, "Harmful repeats are not diminished");
  // Exercise the production trace writer: per-function staff and per-worker QD
  // must originate in execution, not merely be invented by social fixtures.
  const traceApp = { ...FinanceEconomyDomain, _safeNumber: app._safeNumber,
    _technicalMaintenanceReady: () => true, _buildingFunctions: (b) => b.functions };
  const mixed = { ...venue("mixed"), functions: { production: true, culture: true } };
  const traceHolding = { buildings: { list: [mixed] } };
  traceApp._recordBuildingServiceActivity(traceHolding, { ledger: [{ sourceId: "mixed", qty: 1 }] }, {
    periodIdentity: { periodKey: "tenday:1" }, plannedAssignmentsByWorkerId: new Map([
      ["cook", [{ sourceId: "mixed", functionId: "production:food", normalQd: 20 }]],
      ["host", [{ sourceId: "mixed", functionId: "culture", normalQd: 10 }]]
    ])
  });
  assert.deepEqual(mixed.serviceState.activeWorkerIdsByFunction.culture, ["host"]);
  assert.deepEqual(mixed.serviceState.activeWorkerIdsByFunction.production, ["cook"]);
  assert.equal(mixed.serviceState.workedQdByWorkerAndFunction.host.culture, 10);
  assert.equal(mixed.serviceState.workedQdByWorkerAndFunction.cook.production, 20);
  return { leisure: [15, 26, 36, 54], diverse: 75, confirmedWork: true };
}
