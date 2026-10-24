import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  MODULE_ID,
  SETTING_CATALOG,
  SETTING_DATA,
  SETTING_HOLDINGS,
  SETTING_META
} from "../data/constants.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { migrateData } from "../data/normalizers.js";
import { createSkyholdSplitStorage } from "../data/split-storage.js";
import { inspectStorageCommit, makeStorageCommitMeta, stableDataHash } from "../data/storage-commit.js";
import { clone } from "../data/utils.js";

function committedRoot({ revision = 1, holdingName = "Committed Holding", catalogName = "" } = {}) {
  const root = migrateData(clone(DEFAULT_SKYHOLD_DATA));
  root.meta.revision = revision;
  root.holdings[0].name = holdingName;
  if (catalogName && root.catalog.buildings[0]) root.catalog.buildings[0].name = catalogName;
  root.meta = makeStorageCommitMeta(root.meta, {
    writeId: `fixture-${revision}`,
    previousRevision: Math.max(0, revision - 1),
    previousHoldingsHash: stableDataHash(root.holdings),
    previousCatalogHash: stableDataHash(root.catalog),
    holdings: root.holdings,
    catalog: root.catalog,
    complete: true,
    now: "2026-07-10T00:00:00.000Z"
  });
  return root;
}

function committedDefaultRoot({ revision = 0 } = {}) {
  const root = clone(DEFAULT_SKYHOLD_DATA);
  root.meta.revision = revision;
  root.meta = makeStorageCommitMeta(root.meta, {
    writeId: `default-fixture-${revision}`,
    previousRevision: Math.max(0, revision - 1),
    previousHoldingsHash: stableDataHash(root.holdings),
    previousCatalogHash: stableDataHash(root.catalog),
    holdingsHash: stableDataHash(root.holdings),
    catalogHash: stableDataHash(root.catalog),
    complete: true,
    now: "2026-07-10T00:00:00.000Z"
  });
  return root;
}

function settingsHarness(root, { legacy = DEFAULT_SKYHOLD_DATA, failWriteKey = "" } = {}) {
  const values = new Map([
    [SETTING_META, clone(root.meta)],
    [SETTING_HOLDINGS, clone(root.holdings)],
    [SETTING_CATALOG, clone(root.catalog)],
    [SETTING_DATA, clone(legacy)]
  ]);
  const writes = [];
  return {
    values,
    writes,
    settings: {
      get(moduleId, key) {
        assert.equal(moduleId, MODULE_ID, "split storage must read only its own module settings");
        return clone(values.get(key));
      },
      async set(moduleId, key, value) {
        assert.equal(moduleId, MODULE_ID, "split storage must write only its own module settings");
        writes.push(key);
        if (key === failWriteKey) throw new Error(`blocked setting write: ${key}`);
        values.set(key, clone(value));
        return clone(value);
      }
    }
  };
}

function interruptedMeta(previous, next, { writeId = "interrupted" } = {}) {
  return makeStorageCommitMeta(next.meta, {
    writeId,
    previousRevision: previous.meta.revision,
    previousHoldingsHash: stableDataHash(previous.holdings),
    previousCatalogHash: stableDataHash(previous.catalog),
    holdings: next.holdings,
    catalog: next.catalog,
    complete: false,
    now: "2026-07-10T00:00:00.000Z"
  });
}

/** Checks partition caching, write scopes and coherent metadata recovery using settings fixtures with injected write failures. */
export async function checkSplitStorageCharacterization() {
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    const initial = committedRoot({ revision: 7 });
    const harness = settingsHarness(initial);
    const storage = createSkyholdSplitStorage({ settings: harness.settings });
    const first = storage.getData();
    assert.equal(first.meta.revision, 7, "the split store must load the committed revision");
    const view = storage.getDataView();
    assert.equal(storage.getDataView(), view, "read-only views must reuse the normalized cache root");
    const isolatedRead = storage.getData();
    isolatedRead.holdings[0].name = "Caller mutation";
    assert.equal(view.holdings[0].name, "Committed Holding", "ordinary reads must remain isolated from the internal read-only view");

    const guardedHoldings = [...initial.holdings];
    guardedHoldings[0] = new Proxy(initial.holdings[0], {
      ownKeys() {
        throw new Error("inspectStorageCommit traversed holdings despite receiving their precomputed hash");
      }
    });
    assert.doesNotThrow(() => inspectStorageCommit({
      meta: initial.meta,
      holdings: guardedHoldings,
      catalog: initial.catalog
    }, {
      holdingsHash: stableDataHash(initial.holdings),
      catalogHash: stableDataHash(initial.catalog)
    }), "commit inspection must reuse hashes already computed by split storage");

    storage.resetMetrics();
    const second = storage.getData();
    const cacheMetrics = storage.getMetrics();
    assert.equal(second.meta.revision, 7, "a cache hit must preserve the committed root");
    assert.equal(cacheMetrics.cacheHits, 1, "the second read of a completed revision must hit the revision cache");
    assert.equal(cacheMetrics.normalizations, 0, "a revision cache hit must not normalize the root again");
    assert.equal(cacheMetrics.readsByKey[SETTING_META], 1, "a revision cache hit must read only commit meta");
    assert.equal(cacheMetrics.readsByKey[SETTING_HOLDINGS] ?? 0, 0, "a revision cache hit must not clone holdings settings");
    assert.equal(cacheMetrics.readsByKey[SETTING_CATALOG] ?? 0, 0, "a revision cache hit must not clone catalog settings");
    assert.equal(cacheMetrics.readsByKey[SETTING_DATA] ?? 0, 0, "a revision cache hit must not read the legacy snapshot");

    const holdingsOnly = clone(second);
    holdingsOnly.meta.revision += 1;
    holdingsOnly.holdings[0].name = "Holding-only update";
    storage.resetMetrics();
    await storage.persistData(holdingsOnly);
    const holdingsMetrics = storage.getMetrics();
    assert.equal(holdingsMetrics.writesByKey[SETTING_META], 2, "a commit must bracket partition writes with start and complete meta");
    assert.equal(holdingsMetrics.writesByKey[SETTING_HOLDINGS], 1, "a holding update must write the holdings partition once");
    assert.equal(holdingsMetrics.writesByKey[SETTING_CATALOG] ?? 0, 0, "a holding update must not rewrite an unchanged catalog");
    assert.equal(holdingsMetrics.writesByKey[SETTING_DATA] ?? 0, 0, "a recoverable one-partition update must not rewrite the legacy snapshot");
    assert.equal(inspectStorageCommit({
      meta: harness.values.get(SETTING_META),
      holdings: harness.values.get(SETTING_HOLDINGS),
      catalog: harness.values.get(SETTING_CATALOG)
    }).ok, true, "a dirty-partition commit must preserve commit integrity");

    const destructive = storage.getData();
    const beforeDestructive = clone(destructive);
    destructive.meta.revision += 1;
    destructive.holdings[0].name = "Destructive holding migration";
    storage.resetMetrics();
    await storage.persistData(destructive, { forceRollbackSnapshot: true });
    const destructiveMetrics = storage.getMetrics();
    assert.equal(destructiveMetrics.writesByKey[SETTING_DATA], 1, "an explicitly destructive one-partition commit must preserve a coherent rollback root");
    assert.equal(stableDataHash(harness.values.get(SETTING_DATA)), stableDataHash(beforeDestructive), "the forced rollback root must equal the exact logical state before the destructive commit");

    const catalogOnly = storage.getData();
    catalogOnly.meta.revision += 1;
    catalogOnly.catalog.buildings[0].name = "Catalog-only update";
    storage.resetMetrics();
    await storage.persistData(catalogOnly);
    const catalogMetrics = storage.getMetrics();
    assert.equal(catalogMetrics.writesByKey[SETTING_HOLDINGS] ?? 0, 0, "a catalog update must not rewrite unchanged holdings");
    assert.equal(catalogMetrics.writesByKey[SETTING_CATALOG], 1, "a catalog update must write the catalog partition once");
    assert.equal(catalogMetrics.writesByKey[SETTING_DATA] ?? 0, 0, "a recoverable catalog-only update must not rewrite the legacy snapshot");

    const noOp = storage.getData();
    noOp.meta.revision += 1;
    noOp.meta.lastUpdated = "2026-07-11T00:00:00.000Z";
    storage.resetMetrics();
    const noOpResult = await storage.persistData(noOp, { normalized: true, scope: "holdings", withStatus: true });
    const noOpMetrics = storage.getMetrics();
    assert.equal(noOpResult.changed, false, "a scoped no-op must report that no logical data changed");
    assert.equal(noOpMetrics.settingWrites, 0, "a scoped no-op must not write meta or world partitions");
    assert.equal(noOpMetrics.noOpWrites, 1, "a scoped no-op must remain observable in performance metrics");
    assert.equal(noOpMetrics.hashesByPartition.holdings, 1, "a holdings commit must hash only its declared partition");
    assert.equal(noOpMetrics.hashesByPartition.catalog, 0, "a holdings commit must reuse the cached catalog hash");

    const beforeMetaOnly = storage.getData();
    const metaOnly = clone(beforeMetaOnly);
    metaOnly.meta.revision += 1;
    metaOnly.meta.templateCatalogVersion += 1;
    metaOnly.meta.buildingCatalogMigration = {
      operationId: "metadata-only-migration",
      version: metaOnly.meta.templateCatalogVersion
    };
    storage.resetMetrics();
    const metaOnlyResult = await storage.persistData(metaOnly, {
      normalized: true, scope: "both", withStatus: true, forceRollbackSnapshot: true
    });
    assert.equal(metaOnlyResult.changed, true, "migration metadata must persist even when both world partitions are unchanged");
    assert.deepEqual(harness.values.get(SETTING_META).buildingCatalogMigration, metaOnly.meta.buildingCatalogMigration, "metadata-only commits must preserve the operation marker");
    assert.equal(harness.values.get(SETTING_META).templateCatalogVersion, metaOnly.meta.templateCatalogVersion, "metadata-only commits must preserve the catalog version");
    assert.equal(storage.getMetrics().writesByKey[SETTING_META], 2, "metadata-only commits must retain the start/complete marker protocol");
    assert.equal(storage.getMetrics().writesByKey[SETTING_HOLDINGS] ?? 0, 0, "metadata-only commits must not rewrite holdings");
    assert.equal(storage.getMetrics().writesByKey[SETTING_CATALOG] ?? 0, 0, "metadata-only commits must not rewrite the catalog");
    assert.equal(stableDataHash(harness.values.get(SETTING_DATA)), stableDataHash(beforeMetaOnly), "a metadata-only migration must preserve the exact rollback root when requested");
    const metaOnlyReloaded = createSkyholdSplitStorage({ settings: harness.settings }).getData();
    assert.equal(metaOnlyReloaded.meta.revision, metaOnly.meta.revision, "metadata-only commits must survive a fresh storage instance");
    assert.deepEqual(metaOnlyReloaded.meta.buildingCatalogMigration, metaOnly.meta.buildingCatalogMigration, "a fresh storage instance must retain the migration operation marker");

    const both = storage.getData();
    both.meta.revision += 1;
    both.holdings[0].name = "Dual update";
    both.catalog.buildings[0].name = "Dual catalog update";
    const beforeDual = storage.getData();
    storage.resetMetrics();
    await storage.persistData(both);
    const dualMetrics = storage.getMetrics();
    assert.equal(dualMetrics.writesByKey[SETTING_HOLDINGS], 1, "a dual update must write changed holdings");
    assert.equal(dualMetrics.writesByKey[SETTING_CATALOG], 1, "a dual update must write changed catalog");
    assert.equal(dualMetrics.writesByKey[SETTING_DATA], 1, "a dual-partition update must preserve one coherent rollback snapshot");
    assert.equal(harness.values.get(SETTING_DATA).meta.revision, beforeDual.meta.revision, "the rollback snapshot must preserve the previous committed revision");

    const recoveryPrevious = committedRoot({ revision: 20, holdingName: "Before interrupted write", catalogName: "Before catalog" });
    const recoveryNext = clone(recoveryPrevious);
    recoveryNext.meta.revision = 21;
    recoveryNext.holdings[0].name = "After interrupted write";
    recoveryNext.meta = interruptedMeta(recoveryPrevious, recoveryNext, { writeId: "forward-recovery" });
    const forwardHarness = settingsHarness({
      meta: recoveryNext.meta,
      holdings: recoveryNext.holdings,
      catalog: recoveryNext.catalog
    });
    const forwardRecovered = createSkyholdSplitStorage({ settings: forwardHarness.settings }).getData();
    assert.equal(forwardRecovered.meta.revision, 21, "a completed single partition payload must recover forward after an interrupted final meta write");
    assert.equal(forwardRecovered.holdings[0].name, "After interrupted write", "forward recovery must retain the fully written target partition");

    const rollbackNext = clone(recoveryPrevious);
    rollbackNext.meta.revision = 21;
    rollbackNext.holdings[0].name = "Never written";
    const rollbackMeta = interruptedMeta(recoveryPrevious, rollbackNext, { writeId: "rollback-recovery" });
    const rollbackHarness = settingsHarness({
      meta: rollbackMeta,
      holdings: recoveryPrevious.holdings,
      catalog: recoveryPrevious.catalog
    });
    const rolledBack = createSkyholdSplitStorage({ settings: rollbackHarness.settings }).getData();
    assert.equal(rolledBack.meta.revision, 20, "an interrupted commit before its partition write must recover the previous revision");
    assert.equal(rolledBack.holdings[0].name, "Before interrupted write", "rollback recovery must retain the previous partition payload");

    const metadataHarness = settingsHarness(recoveryPrevious, { failWriteKey: SETTING_HOLDINGS });
    const metadataStorage = createSkyholdSplitStorage({ settings: metadataHarness.settings });
    const beforeMetadataWrite = metadataStorage.getData();
    const metadataNext = clone(beforeMetadataWrite);
    metadataNext.meta.revision += 1;
    metadataNext.meta.lastImport = { source: "interrupted-import", holdingId: metadataNext.holdings[0].id };
    metadataNext.holdings[0].name = "Import that did not persist";
    await assert.rejects(metadataStorage.persistData(metadataNext, { normalized: true, scope: "holdings" }), /blocked setting write/);
    const metadataRecovered = createSkyholdSplitStorage({ settings: metadataHarness.settings }).getData();
    assert.deepEqual(metadataRecovered.meta.lastImport, beforeMetadataWrite.meta.lastImport,
      "rollback before a single-partition write must not retain logical metadata from the rejected commit");
    assert.equal(metadataRecovered.meta.revision, beforeMetadataWrite.meta.revision);
    assert.equal(metadataRecovered.holdings[0].name, beforeMetadataWrite.holdings[0].name);
    assert.equal(stableDataHash(metadataHarness.values.get(SETTING_DATA)), stableDataHash(beforeMetadataWrite),
      "a partition commit that changes logical metadata must snapshot the complete previous root");

    const pristinePrevious = committedDefaultRoot({ revision: 20 });
    const pristineNext = clone(pristinePrevious);
    pristineNext.meta.revision = 21;
    pristineNext.meta.lastImport = { source: "unwritten-pristine-import" };
    pristineNext.holdings[0].name = "Unwritten pristine holding";
    const pristineMeta = interruptedMeta(pristinePrevious, pristineNext, { writeId: "pristine-metadata-rollback" });
    const pristineHarness = settingsHarness({ meta: pristineMeta,
      holdings: pristinePrevious.holdings, catalog: pristinePrevious.catalog }, { legacy: pristinePrevious });
    const pristineRecovered = createSkyholdSplitStorage({ settings: pristineHarness.settings }).getData();
    assert.equal(pristineRecovered.meta.lastImport, undefined,
      "a matching pristine rollback snapshot must restore previous metadata even without customized partitions");
    assert.equal(pristineRecovered.meta.revision, 20);

    const stalePristine = clone(pristinePrevious);
    stalePristine.meta.revision = 19;
    const stalePristineHarness = settingsHarness({ meta: pristineMeta,
      holdings: pristinePrevious.holdings, catalog: pristinePrevious.catalog }, { legacy: stalePristine });
    assert.equal(createSkyholdSplitStorage({ settings: stalePristineHarness.settings }).getData().meta.revision, 20,
      "a stale pristine snapshot must not replace the rollback revision");
    const unrelatedPristineHarness = settingsHarness({ meta: rollbackMeta,
      holdings: recoveryPrevious.holdings, catalog: recoveryPrevious.catalog }, { legacy: pristinePrevious });
    assert.equal(createSkyholdSplitStorage({ settings: unrelatedPristineHarness.settings }).getData().holdings[0].name,
      recoveryPrevious.holdings[0].name, "same-revision defaults must not replace unrelated non-default rollback partitions");

    const mixedNext = clone(recoveryPrevious);
    mixedNext.meta.revision = 21;
    mixedNext.holdings[0].name = "Mixed holding";
    mixedNext.catalog.buildings[0].name = "Mixed catalog";
    const mixedMeta = interruptedMeta(recoveryPrevious, mixedNext, { writeId: "mixed-recovery" });
    const mixedHarness = settingsHarness({
      meta: mixedMeta,
      holdings: mixedNext.holdings,
      catalog: recoveryPrevious.catalog
    }, { legacy: recoveryPrevious });
    const mixedRecovered = createSkyholdSplitStorage({ settings: mixedHarness.settings }).getData();
    assert.equal(mixedRecovered.meta.revision, 20, "a mixed interrupted dual-partition commit must use the coherent rollback snapshot");
    assert.equal(mixedRecovered.holdings[0].name, "Before interrupted write", "mixed recovery must not expose half of a dual-partition commit");

    const equalRevisionLegacy = committedDefaultRoot({ revision: 0 });
    delete equalRevisionLegacy.meta.storageCommit;
    equalRevisionLegacy.holdings[0].name = "Used legacy at equal revision";
    const equalRevisionDefaultSplit = committedDefaultRoot({ revision: 0 });
    const equalRevisionHarness = settingsHarness(equalRevisionDefaultSplit, { legacy: equalRevisionLegacy });
    const equalRevisionResult = createSkyholdSplitStorage({ settings: equalRevisionHarness.settings }).getData();
    assert.equal(equalRevisionResult.holdings[0].name, "Used legacy at equal revision", "an untouched default split must defer to used legacy data at the same revision");

    const equalRevisionCustomSplit = committedRoot({ revision: 12, holdingName: "Used split at equal revision" });
    const equalRevisionCustomLegacy = committedRoot({ revision: 12, holdingName: "Stale legacy at equal revision" });
    delete equalRevisionCustomLegacy.meta.storageCommit;
    const equalRevisionCustomHarness = settingsHarness(equalRevisionCustomSplit, { legacy: equalRevisionCustomLegacy });
    const equalRevisionCustomResult = createSkyholdSplitStorage({ settings: equalRevisionCustomHarness.settings }).getData();
    assert.equal(equalRevisionCustomResult.holdings[0].name, "Used split at equal revision", "a valid non-default split must win over used legacy data at the same revision");

    const corruptSplit = committedRoot({ revision: 25, holdingName: "Hash-protected split" });
    corruptSplit.holdings[0].name = "Corrupted after commit";
    const corruptFallback = committedRoot({ revision: 24, holdingName: "Coherent legacy fallback" });
    delete corruptFallback.meta.storageCommit;
    const corruptHarness = settingsHarness(corruptSplit, { legacy: corruptFallback });
    const corruptResult = createSkyholdSplitStorage({ settings: corruptHarness.settings }).getData();
    assert.equal(corruptResult.meta.revision, 24, "a completed split with a corrupt partition hash must fall back to coherent used legacy data");
    assert.equal(corruptResult.holdings[0].name, "Coherent legacy fallback", "hash mismatch recovery must not expose the corrupt split payload");

    const corruptCatalogSplit = committedRoot({ revision: 27, holdingName: "Catalog hash-protected split", catalogName: "Committed catalog" });
    corruptCatalogSplit.catalog.buildings[0].name = "Corrupted catalog after commit";
    const corruptCatalogFallback = committedRoot({ revision: 26, holdingName: "Catalog legacy fallback", catalogName: "Coherent legacy catalog" });
    delete corruptCatalogFallback.meta.storageCommit;
    const corruptCatalogHarness = settingsHarness(corruptCatalogSplit, { legacy: corruptCatalogFallback });
    const corruptCatalogResult = createSkyholdSplitStorage({ settings: corruptCatalogHarness.settings }).getData();
    assert.equal(corruptCatalogResult.meta.revision, 26, "a completed split with a corrupt catalog hash must fall back to coherent used legacy data");
    assert.equal(corruptCatalogResult.catalog.buildings[0].name, "Coherent legacy catalog", "catalog hash mismatch recovery must not expose the corrupt catalog payload");

    const legacyRoot = committedRoot({ revision: 30, holdingName: "Legacy source", catalogName: "Legacy catalog" });
    delete legacyRoot.meta.storageCommit;
    const defaultSplit = committedRoot({ revision: 0 });
    const legacyHarness = settingsHarness(defaultSplit, { legacy: legacyRoot });
    const legacyStorage = createSkyholdSplitStorage({ settings: legacyHarness.settings });
    const migratedLegacy = legacyStorage.getData();
    assert.equal(migratedLegacy.holdings[0].name, "Legacy source", "a newer legacy root must remain readable before split hydration");
    migratedLegacy.meta.revision = 31;
    migratedLegacy.holdings[0].name = "Hydrated split";
    legacyStorage.resetMetrics();
    await legacyStorage.persistData(migratedLegacy);
    assert.equal(legacyStorage.getMetrics().writesByKey[SETTING_DATA], 1, "legacy hydration must preserve its logical source before changing split settings");
    assert.equal(inspectStorageCommit({
      meta: legacyHarness.values.get(SETTING_META),
      holdings: legacyHarness.values.get(SETTING_HOLDINGS),
      catalog: legacyHarness.values.get(SETTING_CATALOG)
    }).ok, true, "legacy hydration must finish as a coherent split commit");

    const blockedHarness = settingsHarness(initial, { failWriteKey: SETTING_DATA });
    const blockedStorage = createSkyholdSplitStorage({ settings: blockedHarness.settings });
    const blockedNext = blockedStorage.getData();
    blockedNext.meta.revision += 1;
    blockedNext.holdings[0].name = "Blocked dual holding";
    blockedNext.catalog.buildings[0].name = "Blocked dual catalog";
    await assert.rejects(blockedStorage.persistData(blockedNext), /blocked setting write/, "a dual commit must stop if its rollback snapshot cannot be preserved");
    assert.deepEqual(blockedHarness.writes, [SETTING_DATA], "a failed rollback snapshot must abort before start meta or partition writes");

    const marketPrevious = committedRoot({ revision: 40 });
    marketPrevious.meta.sharedMarkets = { enabled: true, version: 1, clockTenday: 1,
      stock: { wood: { availableStock: 10 } }, demand: {} };
    marketPrevious.holdings[0].storage.moneyCopper = 100;
    marketPrevious.meta = makeStorageCommitMeta(marketPrevious.meta, {
      writeId: "shared-market-before", previousRevision: 39,
      holdings: marketPrevious.holdings, catalog: marketPrevious.catalog, complete: true
    });
    const marketHarness = settingsHarness(marketPrevious, { failWriteKey: SETTING_HOLDINGS });
    const marketStorage = createSkyholdSplitStorage({ settings: marketHarness.settings });
    const marketNext = marketStorage.getData();
    marketNext.meta.revision += 1;
    marketNext.meta.sharedMarkets.stock.wood.availableStock = 9;
    marketNext.holdings[0].storage.moneyCopper = 90;
    await assert.rejects(marketStorage.persistData(marketNext, { normalized: true, scope: "holdings" }), /blocked setting write/);
    const marketRecovered = createSkyholdSplitStorage({ settings: marketHarness.settings }).getData();
    assert.equal(marketRecovered.meta.revision, 40, "failed purchases must roll back to the previous revision");
    assert.equal(marketRecovered.holdings[0].storage.moneyCopper, 100, "failed purchases must preserve the previous treasury");
    assert.deepEqual(marketRecovered.meta.sharedMarkets, marketPrevious.meta.sharedMarkets,
      "rollback must restore shared stock metadata together with the holding, not retain an uncommitted reservation");
  } finally {
    console.warn = previousWarn;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkSplitStorageCharacterization();
  console.log("FBL Skyhold split storage characterization passed.");
}
