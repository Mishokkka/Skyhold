import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeCatalogPartition, normalizeSkyholdData } from "../data/normalizers.js";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";

export function checkCatalogLoadBoundary() {
  const stored = { buildings: [
    { id: "watch-post", templateVersion: 13, name: "Мой пост", reputation: 99, workersMin: 0, workersMax: 2 },
    { id: "private-template", templateVersion: 3, name: "Личное здание", bonuses: { culture: 7 }, requiredBuildingIds: ["private-dependency"] }
  ], deletedBuildingTemplateIds: ["mill"] };
  const before = structuredClone(stored);
  const loaded = normalizeCatalogPartition(stored);
  assert.deepEqual(stored, before, "Reading must not mutate the saved input");
  assert.deepEqual(loaded.buildings.map((row) => row.id), ["watch-post", "private-template"]);
  const post = loaded.buildings[0];
  assert.equal(post.templateVersion, 13);
  assert.equal(post.reputation, 99);
  assert.equal(post.control?.generalFlat ?? 0, 0);
  assert.equal(post.activation.minWorkers, 0);
  assert.equal(post.activation.minOperationalQd, 0);
  assert.equal(post.workersMax, 2);
  assert.equal(post.workerProfile.admission.hard, false);
  assert.equal(post.workerProfile.production, null);
  assert.deepEqual(post.requiredBuildingIds, []);
  assert.equal(loaded.buildings[1].bonuses.culture, 7);
  assert.deepEqual(loaded.buildings[1].requiredBuildingIds, ["private-dependency"]);
  assert.deepEqual(normalizeCatalogPartition(loaded).buildings, loaded.buildings, "Loading twice must be stable");
  assert.equal(normalizeCatalogPartition({ buildings: [] }).buildings.length, 0);
  assert.equal(normalizeCatalogPartition({}).buildings.length, 0);
  assert.equal(normalizeCatalogPartition({ buildings: [{ id: "unknown-version" }] }).buildings[0].templateVersion, 0);
  const root = normalizeSkyholdData({ meta: { templateCatalogVersion: 13 }, catalog: stored, holdings: [] });
  assert.equal(root.meta.templateCatalogVersion, 13);
  assert.deepEqual(root.holdings, [], "An intentionally empty saved world cannot recreate preset settlements");
  assert.deepEqual(root.catalog.buildings.map((row) => row.id), ["watch-post", "private-template"]);
  assert.equal(normalizeSkyholdData({ meta: {}, catalog: stored, holdings: [] }).meta.templateCatalogVersion, 0);
  const fresh = normalizeSkyholdData(null);
  const ancient = normalizeSkyholdData({ overview: { settlementName: "Legacy" }, buildings: { list: [] }, residents: { groups: [] } });
  assert.equal(ancient.holdings.length, 1, "The original single settlement remains available after format conversion");
  assert.equal(ancient.catalog.buildings.length, 0, "Converting an old storage shape cannot install current building mechanics");
  assert.equal(ancient.meta.templateCatalogVersion, 0);
  assert.equal(fresh.meta.templateCatalogVersion, TEMPLATE_CATALOG_VERSION);
  assert.equal(fresh.catalog.buildings.length, DEFAULT_BUILDING_TEMPLATES.length);
  assert.deepEqual(normalizeCatalogPartition(fresh.catalog), fresh.catalog, "A normalized built-in catalog must not change on its second load");
  for (const ceiling of [null, 0, -10]) {
    const result = normalizeCatalogPartition({ buildings: [{ id: "control-test", control: { generalFlat: 1, ceiling } }] });
    assert.equal(result.buildings[0].control.ceiling, ceiling, "No institutional ceiling is distinct from a zero ceiling");
  }
  const leisureSource = { buildings: [{ id: "custom-leisure", moraleDelta: 17, service: { leisure: {
    kind: "  Игры  ", capacity: 23.9, qdPerCapacity: 8 / 3, minWorkers: 2, functionId: "culture"
  } } }] };
  const leisureBefore = structuredClone(leisureSource);
  const leisureLoaded = normalizeCatalogPartition(leisureSource);
  assert.deepEqual(leisureSource, leisureBefore, "Leisure normalization cannot mutate stored input");
  assert.deepEqual(leisureLoaded.buildings[0].service.leisure,
    { kind: "Игры", capacity: 23, qdPerCapacity: 8 / 3, minWorkers: 2, functionId: "culture" });
  assert.equal(leisureLoaded.buildings[0].moraleDelta, 17, "Load preserves GM-authored nominal morale independently of leisure capacity");
  assert.deepEqual(normalizeCatalogPartition(leisureLoaded), leisureLoaded, "Leisure rules must survive repeated normalization");
  const oldService = normalizeCatalogPartition({ buildings: [{ id: "old-bath", service: { capacity: 100 }, moraleDelta: 3 }] });
  assert.equal(Object.hasOwn(oldService.buildings[0].service, "leisure"), false, "Loading an old fixed service must not convert it to leisure");
  return { savedTemplates: 2, newWorldTemplates: fresh.catalog.buildings.length, unknownVersion: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(checkCatalogLoadBoundary()));
