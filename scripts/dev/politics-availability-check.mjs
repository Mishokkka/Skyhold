import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { politicsAvailability } from "../data/politics-availability.js";
import { isPlayerWritablePath } from "../data/player-write-guard.js";

export function checkPoliticsAvailability() {
  const activeHouse = { templateId: "meeting-house", lifecycle: "active", condition: "intact" };
  const holding = mergeHoldingDefaults({ id: "politics-gate", buildings: { list: [activeHouse] } });
  assert.equal(holding.gm.politicsCultureThreshold, 16);
  assert.equal(holding.gm.politicsIgnoreInstitutionRequirement, false);
  assert.equal(politicsAvailability(holding, 15).available, false);
  assert.equal(politicsAvailability(holding, 16).available, true);
  assert.equal(politicsAvailability({ ...holding, buildings: { list: [] } }, 30).available, false);
  assert.equal(politicsAvailability({ ...holding, buildings: { list: [{ ...activeHouse, lifecycle: "disabled" }] } }, 30).available, false);
  assert.equal(politicsAvailability({ ...holding, buildings: { list: [{ ...activeHouse, condition: "damaged" }] } }, 30).available, false);
  assert.equal(politicsAvailability({ ...holding, buildings: { list: [{ ...activeHouse, id: "house", activation: { minWorkers: 1, minOperationalQd: 20 }, functions: { culture: true }, assignedWorkerIds: [] }] } }, 30).available, false);
  assert.equal(politicsAvailability({ ...holding, buildings: { list: [{ ...activeHouse, templateId: "town-hall" }] } }, 16).available, true);
  const raised = mergeHoldingDefaults({ id: "raised-gate", gm: { politicsCultureThreshold: 22 }, buildings: { list: [activeHouse] } });
  assert.equal(politicsAvailability(raised, 21).available, false);
  assert.equal(politicsAvailability(raised, 22).available, true);
  const bypass = mergeHoldingDefaults({ id: "politics-bypass", gm: { politicsIgnoreInstitutionRequirement: true }, buildings: { list: [] } });
  assert.equal(politicsAvailability(bypass, 15).available, false, "bypassing the building must not bypass Culture");
  assert.equal(politicsAvailability(bypass, 16).available, true);
  assert.equal(politicsAvailability(bypass, 16).hasInstitution, false);
  assert.equal(politicsAvailability(mergeHoldingDefaults({ id: "politics-bypass-off", gm: { politicsIgnoreInstitutionRequirement: false }, buildings: { list: [] } }), 16).available, false);
  assert.equal(mergeHoldingDefaults({ gm: { politicsCultureThreshold: -3 } }).gm.politicsCultureThreshold, 0);
  assert.equal(mergeHoldingDefaults({ gm: { politicsCultureThreshold: 10000 } }).gm.politicsCultureThreshold, 1000);
  assert.equal(isPlayerWritablePath("holdings.0.gm.politicsCultureThreshold", { holdings: [holding] }, { holdings: [holding] }), false);
  assert.equal(isPlayerWritablePath("holdings.0.gm.politicsIgnoreInstitutionRequirement", { holdings: [holding] }, { holdings: [holding] }), false);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkPoliticsAvailability();
  console.log("Politics availability check passed.");
}
