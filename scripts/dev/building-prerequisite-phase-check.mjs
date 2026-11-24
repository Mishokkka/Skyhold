import assert from "node:assert/strict";
import { buildingActiveWorkerSummary, buildingConstructionPrerequisitesMet, buildingServiceBlockReasons } from "../engines/economy/building-service.js";

export function checkBuildingPrerequisitePhases() {
  const provider = { id: "water", templateId: "waterworks", constructionStatus: "built", functions: { culture: true }, wageDailyCopper: 12,
    workersMax: 1, labor: { version: 2, capacityQd: 20 }, activation: { minOperationalQd: 2 }, workerProfile: { source: "test", composition: [] } };
  const consumer = { id: "sewer", constructionStatus: "built", functions: { culture: true },
    requiredBuildingIds: ["waterworks"], prerequisiteModes: { waterworks: "service" } };
  const holding = { buildings: { list: [provider, consumer] }, people: { list: [
    { id: "operator", workAllocations: [{ sourceId: "water", functionId: "culture", normalQd: 2 }] }
  ] } };
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), true);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true);
  holding.people.list[0].workAllocations = [];
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, false, "A standing but unstaffed provider cannot deliver an ongoing service");
  consumer.prerequisiteModes.waterworks = "construction";
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true, "A construction prerequisite cannot disable an existing building");
  delete consumer.prerequisiteModes;
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true, "Legacy presence dependencies retain their behavior");
  consumer.prerequisiteModes = { waterworks: "service" };
  holding.people.list[0].workAllocations = [{ sourceId: "water", functionId: "culture", normalQd: 2 }];
  provider.requiredBuildingIds = ["sewer"];
  provider.prerequisiteModes = { sewer: "service" };
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, false, "Cycles fail closed without recursion overflow");
  delete provider.requiredBuildingIds;
  consumer.requiredBuildingIds = [];
  consumer.requiredAnyBuildingIds = ["missing", "waterworks"];
  consumer.prerequisiteModes = { missing: "construction", waterworks: "construction" };
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), true, "An active alternative satisfies an OR prerequisite");
  holding.people.list[0].workAllocations = [{ sourceId: "water", functionId: "production:line", normalQd: 2 }];
  assert.equal(buildingActiveWorkerSummary(holding, provider, "culture").count, 0, "Wrong-function allocations never count as service staff");
  assert.equal(buildingActiveWorkerSummary(holding, provider, "culture").qd, 0);
  holding.people.list[0].workAllocations = [{ sourceId: "water", functionId: "culture", normalQd: 1 }];
  assert.equal(buildingActiveWorkerSummary(holding, provider, "culture").qd, 1);
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false, "Provider below minOperationalQd fails service prerequisite");
  return { construction: true, ongoingService: true, legacy: true, cycles: true, technicianExcluded: true };
}
