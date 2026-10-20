import { performance } from "node:perf_hooks";
import {
  MODULE_ID,
  SETTING_CATALOG,
  SETTING_DATA,
  SETTING_HOLDINGS,
  SETTING_META
} from "../data/constants.js";
import { migrateData } from "../data/normalizers.js";
import { prepareSkyholdCommit } from "../data/commit-preparation.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { makeStorageCommitMeta, stableDataHash } from "../data/storage-commit.js";
import { clone } from "../data/utils.js";
import { makeLargeSettlementFixture, PERFORMANCE_SCENARIOS } from "./performance-fixtures.mjs";

const CHECK_BUDGETS = process.argv.includes("--check");
const PERFORMANCE_BUDGETS = {
  medium: { cloneP95Ms: 35, normalizeP95Ms: 450, hashP95Ms: 35, cachedReadP95Ms: 25, viewReadP95Ms: 5, holdingWriteP95Ms: 350, catalogWriteP95Ms: 300, noOpWriteP95Ms: 300, minimumSpeedup: 4 },
  large: { cloneP95Ms: 55, normalizeP95Ms: 900, hashP95Ms: 75, cachedReadP95Ms: 60, viewReadP95Ms: 5, holdingWriteP95Ms: 900, catalogWriteP95Ms: 400, noOpWriteP95Ms: 850, minimumSpeedup: 4 },
  extreme: { cloneP95Ms: 60, normalizeP95Ms: 1300, hashP95Ms: 100, cachedReadP95Ms: 55, viewReadP95Ms: 5, holdingWriteP95Ms: 1400, catalogWriteP95Ms: 350, noOpWriteP95Ms: 1300, minimumSpeedup: 4 }
};

function percentile(rows, fraction) {
  const sorted = [...rows].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0;
}

function measure(operation, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation();
    samples.push(performance.now() - started);
  }
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95)
  };
}

async function measureAsync(operation, iterations) {
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    await operation(index);
    samples.push(performance.now() - started);
  }
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95)
  };
}

function committedFixture(scenario) {
  const root = migrateData(makeLargeSettlementFixture(scenario));
  root.meta = makeStorageCommitMeta(root.meta, {
    writeId: `performance-${scenario.key}`,
    previousRevision: 0,
    previousHoldingsHash: stableDataHash(root.holdings),
    previousCatalogHash: stableDataHash(root.catalog),
    holdings: root.holdings,
    catalog: root.catalog,
    complete: true,
    now: "2026-07-10T00:00:00.000Z"
  });
  return root;
}

function settingsFor(root) {
  const values = new Map([
    [SETTING_META, clone(root.meta)],
    [SETTING_HOLDINGS, clone(root.holdings)],
    [SETTING_CATALOG, clone(root.catalog)],
    [SETTING_DATA, clone(root)]
  ]);
  return {
    get(moduleId, key) {
      if (moduleId !== MODULE_ID) return null;
      return clone(values.get(key));
    },
    async set(moduleId, key, value) {
      if (moduleId === MODULE_ID) values.set(key, clone(value));
      return value;
    }
  };
}

function legacyRead(settings, cachedRoot) {
  const split = {
    meta: clone(settings.get(MODULE_ID, SETTING_META)),
    holdings: clone(settings.get(MODULE_ID, SETTING_HOLDINGS)),
    catalog: clone(settings.get(MODULE_ID, SETTING_CATALOG))
  };
  const legacy = settings.get(MODULE_ID, SETTING_DATA);
  // Characterize the pre-fast-path getData flow: default/legacy/commit hashing
  // happened before the revision cache could return its already normalized root.
  stableDataHash(split.holdings);
  stableDataHash(split.catalog);
  stableDataHash(legacy?.holdings ?? []);
  stableDataHash(legacy?.catalog ?? {});
  stableDataHash(split.holdings);
  stableDataHash(split.catalog);
  return clone(cachedRoot);
}

const rows = [];
for (const scenario of PERFORMANCE_SCENARIOS) {
  const root = committedFixture(scenario);
  const settings = settingsFor(root);
  const storage = createSkyholdSplitStorage({ settings });
  storage.getData();
  storage.resetMetrics();
  const iterations = scenario.key === "extreme" ? 8 : 12;
  const cloneResult = measure(() => clone(root), iterations);
  const normalizeResult = measure(() => migrateData(root), iterations);
  const hashResult = measure(() => stableDataHash(root.holdings), iterations);
  const legacyResult = measure(() => legacyRead(settings, root), iterations);
  const cachedResult = measure(() => storage.getData(), iterations);
  const viewResult = measure(() => storage.getDataView(), iterations);
  const metrics = storage.getMetrics();
  const writeIterations = scenario.key === "extreme" ? 3 : 4;

  storage.resetMetrics();
  const holdingWrite = await measureAsync(async (index) => {
    const draft = storage.getData();
    const prepared = prepareSkyholdCommit(draft, { scope: "holdings", baseRevision: draft.meta.revision });
    prepared.data.holdings[0].name = `Performance holding ${index}`;
    await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope, withStatus: true });
  }, writeIterations);
  const holdingWriteMetrics = storage.getMetrics();

  storage.resetMetrics();
  const catalogWrite = await measureAsync(async (index) => {
    const draft = storage.getData();
    draft.catalog.marketRouteMap.nodeMode = index % 2 ? "card" : "compact";
    const prepared = prepareSkyholdCommit(draft, { scope: "catalog", baseRevision: draft.meta.revision });
    await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope, withStatus: true });
  }, writeIterations);
  const catalogWriteMetrics = storage.getMetrics();

  storage.resetMetrics();
  const noOpWrite = await measureAsync(async () => {
    const draft = storage.getData();
    const prepared = prepareSkyholdCommit(draft, { scope: "holdings", baseRevision: draft.meta.revision });
    await storage.persistData(prepared.data, { normalized: true, scope: prepared.scope, withStatus: true });
  }, writeIterations);
  const noOpWriteMetrics = storage.getMetrics();
  rows.push({
    scenario: scenario.key,
    residents: scenario.residents,
    buildings: scenario.buildings,
    storageRows: scenario.storageRows,
    logRows: scenario.logRows,
    cloneP95Ms: cloneResult.p95Ms,
    normalizeP95Ms: normalizeResult.p95Ms,
    hashP95Ms: hashResult.p95Ms,
    legacyReadP95Ms: legacyResult.p95Ms,
    cachedReadP95Ms: cachedResult.p95Ms,
    viewReadP95Ms: viewResult.p95Ms,
    holdingWriteP95Ms: holdingWrite.p95Ms,
    catalogWriteP95Ms: catalogWrite.p95Ms,
    noOpWriteP95Ms: noOpWrite.p95Ms,
    holdingWorldWrites: holdingWriteMetrics.settingWrites,
    catalogWorldWrites: catalogWriteMetrics.settingWrites,
    noOpWorldWrites: noOpWriteMetrics.settingWrites,
    noOpWrites: noOpWriteMetrics.noOpWrites,
    speedup: cachedResult.p95Ms > 0 ? legacyResult.p95Ms / cachedResult.p95Ms : 0,
    cacheHits: metrics.cacheHits,
    normalizations: metrics.normalizations,
    settingReads: metrics.settingReads
  });
}

console.log("FBL Skyhold performance benchmark (milliseconds, lower is better)");
console.table(rows.map((row) => ({
  scenario: row.scenario,
  residents: row.residents,
  buildings: row.buildings,
  storage: row.storageRows,
  "clone p95": row.cloneP95Ms.toFixed(2),
  "normalize p95": row.normalizeP95Ms.toFixed(2),
  "hash p95": row.hashP95Ms.toFixed(2),
  "old read p95": row.legacyReadP95Ms.toFixed(2),
  "cached read p95": row.cachedReadP95Ms.toFixed(2),
  "view p95": row.viewReadP95Ms.toFixed(2),
  "holding write p95": row.holdingWriteP95Ms.toFixed(2),
  "catalog write p95": row.catalogWriteP95Ms.toFixed(2),
  "no-op p95": row.noOpWriteP95Ms.toFixed(2),
  "no-op world writes": row.noOpWorldWrites,
  speedup: `${row.speedup.toFixed(1)}x`
})));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));

if (CHECK_BUDGETS) {
  const failures = [];
  for (const row of rows) {
    const budget = PERFORMANCE_BUDGETS[row.scenario];
    if (!budget) continue;
    for (const key of ["cloneP95Ms", "normalizeP95Ms", "hashP95Ms", "cachedReadP95Ms", "viewReadP95Ms", "holdingWriteP95Ms", "catalogWriteP95Ms", "noOpWriteP95Ms"]) {
      if (row[key] > budget[key]) failures.push(`${row.scenario} ${key}: ${row[key].toFixed(2)} ms > ${budget[key]} ms`);
    }
    if (row.speedup < budget.minimumSpeedup) failures.push(`${row.scenario} speedup: ${row.speedup.toFixed(1)}x < ${budget.minimumSpeedup}x`);
    if (row.normalizations !== 0) failures.push(`${row.scenario} cache-hit normalizations: ${row.normalizations} !== 0`);
    if (row.holdingWorldWrites !== 3 * (row.scenario === "extreme" ? 3 : 4)) failures.push(`${row.scenario} holdings world writes: ${row.holdingWorldWrites} must be one partition plus two meta writes per commit`);
    if (row.catalogWorldWrites !== 3 * (row.scenario === "extreme" ? 3 : 4)) failures.push(`${row.scenario} catalog world writes: ${row.catalogWorldWrites} must be one partition plus two meta writes per commit`);
    if (row.noOpWorldWrites !== 0) failures.push(`${row.scenario} no-op world writes: ${row.noOpWorldWrites} !== 0`);
  }
  if (failures.length) {
    console.error("FBL Skyhold performance budget failed:\n- " + failures.join("\n- "));
    process.exitCode = 1;
  } else {
    console.log("FBL Skyhold performance budgets passed.");
  }
}
