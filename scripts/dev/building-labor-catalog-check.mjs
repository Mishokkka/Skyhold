import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import {
  BUILDING_LABOR_CATALOG_PROPOSALS,
  BUILDING_LABOR_CATALOG_NOTES,
  applyApprovedBuildingLaborProfile,
  proposedBuildingLaborProfile
} from "../data/building-labor-catalog.js";
import { normalizeCatalogPartition } from "../data/normalizers.js";

export function checkBuildingLaborCatalog() {
  const ids = DEFAULT_BUILDING_TEMPLATES.map((template) => template.id).sort();
  assert.deepEqual(Object.keys(BUILDING_LABOR_CATALOG_PROPOSALS).sort(), ids, "Every standard and story template has an explicit reviewed mode");
  assert.equal(ids.length, 126);
  const counts = { passive: 0, qd: 0, staff: 0 };
  for (const template of DEFAULT_BUILDING_TEMPLATES) {
    const labor = proposedBuildingLaborProfile(template.id);
    assert.deepEqual(template.labor, labor);
    counts[labor.mode]++;
    assert.equal(template.workersMin, 0);
    assert.equal(template.activation.minWorkers, 0, "A general headcount minimum cannot survive in activation");
    assert.equal(template.workerProfile.workersMin, 0);
    const kind = BUILDING_LABOR_CATALOG_NOTES[template.id].limitKind;
    if (labor.mode === "passive") {
      assert.equal(template.workersMax, 0);
      assert.equal(template.activation.minOperationalQd, 0);
      assert.equal(template.activation.requiresMeaningfulResult, false);
      assert.equal(template.productionLines.length, 0, "A passive classification cannot hide a worker recipe");
      assert.equal(template.livestock?.enabled ?? false, false);
      assert.equal(template.agriculture?.enabled ?? false, false);
    } else if (labor.mode === "staff") {
      assert.ok(template.workersMax > 0, "A staff building needs explicit staff places");
      assert.equal(labor.capacityQd, null);
    } else if (kind === "batch-capacity") {
      assert.ok(template.productionLines.length > 0);
      for (const line of template.productionLines) {
        assert.ok(line.waitDays > 0 && line.batchCapacity > 0, "Every QD production line needs its reviewed equipment constraint");
      }
    } else if (kind === "agriculture") {
      assert.ok(template.agriculture.enabled && template.agriculture.crops.length > 0);
    } else if (kind === "livestock") {
      assert.ok(template.livestock.enabled && template.livestock.speciesOptions.length > 0);
    } else if (kind === "leisure-capacity") {
      assert.equal(labor.capacityQd, template.service.leisure.capacity * template.service.leisure.qdPerCapacity);
    } else if (kind === "housing-service") {
      assert.equal(labor.capacityQd, template.activation.minOperationalQd);
      assert.ok(template.housing.staffedComfort > template.housing.comfort);
    } else assert.fail(`Unreviewed QD capacity: ${template.id}`);
  }
  assert.deepEqual(counts, { passive: 26, qd: 17, staff: 83 });
  assert.equal(proposedBuildingLaborProfile("well").mode, "passive");
  assert.equal(proposedBuildingLaborProfile("inn").mode, "staff");
  assert.equal(proposedBuildingLaborProfile("custom-building"), null);
  assert.equal(proposedBuildingLaborProfile("__proto__"), null);

  const copy = proposedBuildingLaborProfile("grain-field");
  copy.mode = "staff";
  assert.equal(proposedBuildingLaborProfile("grain-field").mode, "qd", "A caller cannot mutate shared defaults");
  const raw = {
    id: "well", workersMin: 3, workersMax: 7,
    workerProfile: { workersMin: 3, workersMax: 7, composition: [] },
    activation: { minWorkers: 3, minOperationalQd: 9 },
    wageDailyCopper: 33, storage: { capacity: 99 }
  };
  const before = structuredClone(raw);
  const target = applyApprovedBuildingLaborProfile(raw);
  assert.deepEqual(raw, before, "Preparing a reviewed target never changes the source");
  assert.equal(target.wageDailyCopper, 33);
  assert.equal(target.storage.capacity, 99);
  assert.equal(target.labor.mode, "passive");
  const instanceTarget = applyApprovedBuildingLaborProfile({ ...raw, id: "well-instance", templateId: "well" });
  assert.equal(instanceTarget.id, "well-instance");
  assert.equal(instanceTarget.labor.mode, "passive");
  const loaded = normalizeCatalogPartition({ buildings: [raw] }).buildings[0];
  assert.equal(Object.hasOwn(loaded, "labor"), false, "Loading an existing catalog cannot opt in to the new mechanics");
  assert.equal(loaded.workersMax, 7);
  assert.equal(loaded.workersMin, 3);
  assert.equal(loaded.activation.minOperationalQd, 9);
  assert.equal(loaded.wageDailyCopper, 33);
  return { templates: ids.length, ...counts, savedCatalogPreserved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkBuildingLaborCatalog()));
}
