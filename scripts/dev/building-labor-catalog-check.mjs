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
import { LABOR_SCHEMA_VERSION, buildingLaborCapacityQd } from "../data/labor-model.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { normalizeCatalogPartition } from "../data/normalizers.js";

export function checkBuildingLaborCatalog() {
  const ids = DEFAULT_BUILDING_TEMPLATES.map((template) => template.id).sort();
  assert.deepEqual(Object.keys(BUILDING_LABOR_CATALOG_PROPOSALS).sort(), ids, "Every standard and story template has an explicit reviewed v2 profile");
  assert.equal(ids.length, 126);

  const counts = { passive: 0, limited: 0, unlimited: 0 };
  for (const template of DEFAULT_BUILDING_TEMPLATES) {
    assert.equal(template.labor?.version, LABOR_SCHEMA_VERSION, `${template.id}: template must use v2 labor schema`);
    assert.equal(Object.hasOwn(template.labor ?? {}, "mode"), false, `${template.id}: legacy labor.mode must be absent`);
    assert.equal(template.workersMin, 0);
    assert.equal(template.activation.minWorkers, 0, "A general headcount minimum cannot survive in activation");
    if (template.workerProfile) assert.equal(template.workerProfile.workersMin, 0);

    const cap = buildingLaborCapacityQd(template);
    const minQd = template.activation?.minOperationalQd ?? 0;
    const kind = BUILDING_LABOR_CATALOG_NOTES[template.id].limitKind;
    if (cap === 0) {
      counts.passive++;
      assert.equal(template.workersMax, 0);
      assert.equal(minQd, 0);
      assert.equal(template.activation.requiresMeaningfulResult, false);
      assert.equal(template.productionLines.length, 0, "A passive building cannot hide a worker recipe");
      assert.equal(template.livestock?.enabled ?? false, false);
      assert.equal(template.agriculture?.enabled ?? false, false);
    } else if (cap === null) {
      counts.unlimited++;
      assert.ok(["agriculture", "livestock", "batch-capacity"].includes(kind), `${template.id}: unexpected unlimited capacity kind ${kind}`);
      if (kind === "batch-capacity") {
        assert.ok(template.productionLines.length > 0);
        for (const line of template.productionLines) {
          assert.ok(line.waitDays > 0 && line.batchCapacity > 0, "Every batch production line needs equipment limits");
        }
      } else if (kind === "agriculture") {
        assert.ok(template.agriculture.enabled && template.agriculture.crops.length > 0);
      } else if (kind === "livestock") {
        assert.ok(template.livestock.enabled && template.livestock.speciesOptions.length > 0);
      }
    } else {
      counts.limited++;
      assert.ok(Number.isInteger(cap) && cap > 0, `${template.id}: finite capacityQd must be a positive integer`);
      assert.ok(minQd <= cap, `${template.id}: minOperationalQd (${minQd}) cannot exceed capacityQd (${cap})`);
      if (kind === "leisure-capacity") {
        assert.equal(cap, template.service.leisure.capacity * template.service.leisure.qdPerCapacity);
      } else if (kind === "housing-service") {
        assert.equal(cap, minQd);
        assert.ok(template.housing.staffedComfort > template.housing.comfort);
      } else if (kind === "staff-places") {
        assert.ok(template.workersMax > 0);
        assert.equal(cap, template.workersMax * 20);
      } else {
        assert.fail(`Unreviewed capacity kind for ${template.id}: ${kind}`);
      }
    }
  }

  assert.deepEqual(counts, { passive: 26, limited: 86, unlimited: 14 });
  assert.deepEqual(proposedBuildingLaborProfile("well"), { version: 2, capacityQd: 0 });
  assert.deepEqual(proposedBuildingLaborProfile("inn"), { version: 2, capacityQd: null });
  assert.equal(proposedBuildingLaborProfile("custom-building"), null);
  assert.equal(proposedBuildingLaborProfile("__proto__"), null);

  const copy = proposedBuildingLaborProfile("grain-field");
  copy.capacityQd = 999;
  assert.equal(proposedBuildingLaborProfile("grain-field").capacityQd, null, "A caller cannot mutate shared defaults");

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
  assert.deepEqual(target.labor, { version: 2, capacityQd: 0 });
  const instanceTarget = applyApprovedBuildingLaborProfile({ ...raw, id: "well-instance", templateId: "well" });
  assert.equal(instanceTarget.id, "well-instance");
  assert.deepEqual(instanceTarget.labor, { version: 2, capacityQd: 0 });

  const normalized = { id: "custom-old", workersMax: 3, assignedWorkerIds: ["p1"], maintenance: { requiredPoints: 4 } };
  normalizeBuilding(normalized);
  assert.deepEqual(normalized.labor, { version: 2, capacityQd: 60 }, "Normalizing a building initializes unified v2 QD capacity");
  assert.equal(Object.hasOwn(normalized, "assignedWorkerIds"), false);
  assert.equal(Object.hasOwn(normalized, "maintenance"), false);

  const loadedCatalog = normalizeCatalogPartition({ buildings: [raw] }).buildings[0];
  assert.equal(loadedCatalog.wageDailyCopper, 33);
  assert.deepEqual(loadedCatalog.labor, { version: 2, capacityQd: 140 });
  return { templates: ids.length, ...counts, catalogNormalizedToV2: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(checkBuildingLaborCatalog()));
}
