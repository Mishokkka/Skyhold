import assert from "node:assert/strict";
import { buildingActiveWorkerSummary, buildingConstructionPrerequisitesMet, buildingServiceBlockReasons } from "../engines/economy/building-service.js";

export function checkBuildingPrerequisitePhases() {
  const provider = { id: "water", templateId: "waterworks", constructionStatus: "built", functions: { culture: true },
    activation: { minWorkers: 1, minOperationalQd: 2 }, workerProfile: { source: "test", composition: [] }, assignedWorkerIds: ["operator"] };
  const consumer = { id: "sewer", constructionStatus: "built", functions: { culture: true },
    requiredBuildingIds: ["waterworks"], prerequisiteModes: { waterworks: "service" } };
  const holding = { buildings: { list: [provider, consumer] }, people: { list: [{ id: "operator" }] } };
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), true);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true);
  provider.assignedWorkerIds = [];
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, false, "A standing but unstaffed provider cannot deliver an ongoing service");
  consumer.prerequisiteModes.waterworks = "construction";
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false);
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true, "A construction prerequisite cannot disable an existing building");
  delete consumer.prerequisiteModes;
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, true, "Legacy presence dependencies retain their behavior");
  consumer.prerequisiteModes = { waterworks: "service" };
  provider.assignedWorkerIds = ["operator"];
  provider.requiredBuildingIds = ["sewer"];
  provider.prerequisiteModes = { sewer: "service" };
  assert.equal(buildingServiceBlockReasons(holding, consumer).active, false, "Cycles fail closed without recursion overflow");
  delete provider.requiredBuildingIds;
  consumer.requiredBuildingIds = [];
  consumer.requiredAnyBuildingIds = ["missing", "waterworks"];
  consumer.prerequisiteModes = { missing: "construction", waterworks: "construction" };
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), true, "An active alternative satisfies an OR prerequisite");
  holding.people.list[0] = { id: "operator", workAllocationMode: "explicit", workAllocations: [
    { sourceId: "water", functionId: "maintenance", normalQd: 2 }
  ] };
  assert.equal(buildingActiveWorkerSummary(holding, provider).count, 0, "Technical work never counts as primary service staff, including stale legacy assignments");
  assert.equal(buildingActiveWorkerSummary(holding, provider).qd, 0);
  assert.equal(buildingConstructionPrerequisitesMet(holding, consumer), false);
  return { construction: true, ongoingService: true, legacy: true, cycles: true, technicianExcluded: true };
}
