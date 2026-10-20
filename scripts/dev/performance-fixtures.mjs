import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { clone } from "../data/utils.js";

export const PERFORMANCE_SCENARIOS = Object.freeze([
  Object.freeze({ key: "medium", residents: 100, buildings: 50, storageRows: 100, logRows: 250 }),
  Object.freeze({ key: "large", residents: 500, buildings: 200, storageRows: 500, logRows: 500 }),
  Object.freeze({ key: "extreme", residents: 1000, buildings: 200, storageRows: 1000, logRows: 1000 })
]);

function resident(index) {
  return {
    id: `perf-resident-${index}`,
    name: `Resident ${index}`,
    age: 18 + (index % 48),
    gender: index % 2 ? "f" : "m",
    role: index % 5 === 0 ? "soldier" : "worker",
    workAssignment: index % 5 === 0 ? "soldier" : "",
    home: `perf-building-${index % 20}`,
    status: "active",
    salaryCopper: index % 7,
    attributes: {
      strength: 2 + (index % 4),
      agility: 2 + ((index + 1) % 4),
      wits: 2 + ((index + 2) % 4),
      empathy: 2 + ((index + 3) % 4)
    },
    skills: {},
    talents: [],
    gear: [],
    notes: `Performance fixture resident ${index}`
  };
}

function building(index) {
  return {
    id: `perf-building-${index}`,
    templateId: "",
    name: `Building ${index}`,
    type: index % 4 === 0 ? "storage" : "production",
    constructionStatus: "built",
    status: "built",
    workersMin: 1,
    workersMax: 4,
    assignedWorkerIds: [],
    functions: {
      production: index % 4 !== 0,
      income: index % 8 === 0,
      defense: index % 10 === 0,
      housing: index % 3 === 0,
      storage: index % 4 === 0,
      culture: index % 11 === 0
    },
    storage: { capacity: 20 + (index % 30), security: index % 4, quality: index % 3, notes: "" },
    productionLines: [{
      id: `perf-production-${index}`,
      active: true,
      mode: "fixture",
      source: "workers",
      period: "day",
      resourceId: `resource-${index % 20}`,
      resource: `Resource ${index % 20}`,
      outputQty: 1 + (index % 4),
      workQd: 1,
      expenses: "",
      requiresCollection: false,
      pendingQty: 0
    }],
    notes: `Performance fixture building ${index}`
  };
}

function storageResource(index) {
  return {
    id: `perf-resource-row-${index}`,
    resourceId: `resource-${index % 20}`,
    name: `Resource ${index % 20}`,
    qty: 10 + (index % 90),
    unit: "unit",
    roomId: index % 4 === 0 ? `perf-building-${index % 50}` : "outdoors",
    weight: [0, 0.5, 1, 2][index % 4]
  };
}

function storageLogRow(index) {
  return {
    id: `perf-log-${index}`,
    ts: new Date(Date.UTC(2026, 0, 1, 0, index % 60)).toISOString(),
    kind: index % 2 ? "manual-add" : "manual-spend",
    resourceId: `resource-${index % 20}`,
    name: `Resource ${index % 20}`,
    qty: index % 2 ? 1 : -1,
    roomId: "outdoors",
    source: "performance-fixture",
    note: `Log row ${index}`
  };
}

export function makeLargeSettlementFixture(scenario = PERFORMANCE_SCENARIOS[1]) {
  const config = {
    residents: Math.max(0, Number(scenario?.residents) || 0),
    buildings: Math.max(0, Number(scenario?.buildings) || 0),
    storageRows: Math.max(0, Number(scenario?.storageRows) || 0),
    logRows: Math.max(0, Number(scenario?.logRows) || 0)
  };
  const root = clone(DEFAULT_SKYHOLD_DATA);
  const holding = clone(BASE_HOLDING);
  holding.id = `performance-${scenario?.key ?? "custom"}`;
  holding.name = `Performance ${scenario?.key ?? "custom"}`;
  holding.overview.population = config.residents;
  holding.people.list = Array.from({ length: config.residents }, (_, index) => resident(index));
  holding.buildings.list = Array.from({ length: config.buildings }, (_, index) => building(index));
  holding.storage.resources = Array.from({ length: config.storageRows }, (_, index) => storageResource(index));
  holding.storage.log = Array.from({ length: config.logRows }, (_, index) => storageLogRow(index));
  root.meta.revision = 1;
  root.holdings = [holding];
  return root;
}
