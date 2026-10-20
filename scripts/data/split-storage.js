import { SETTING_CATALOG, SETTING_DATA, SETTING_HOLDINGS, SETTING_META, MODULE_ID } from "./constants.js";
import { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
import { migrateData } from "./normalizers.js";
import { countSkyholdPerformance, measureSkyholdPerformance } from "./performance-observer.js";
import { inspectStorageCommit, makeStorageCommitMeta, recoverStorageCommit, stableDataHash } from "./storage-commit.js";
import { clone, makeId, toNumber } from "./utils.js";
import { COMMIT_SCOPES, normalizeCommitScope } from "./commit-preparation.js";

// World settings are JSON data. Hash their serializable shape so the legacy
// hydration fallback still recognizes untouched defaults containing undefined
// source properties after Foundry has round-tripped them.
const DEFAULT_HOLDINGS_HASH = stableDataHash(clone(DEFAULT_SKYHOLD_DATA.holdings));
const DEFAULT_CATALOG_HASH = stableDataHash(clone(DEFAULT_SKYHOLD_DATA.catalog));

function freezeDataView(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDataView(child);
  return Object.freeze(value);
}

function legacyHasRuntimeData(legacy, { holdingsHash, catalogHash } = {}) {
  if (!legacy || typeof legacy !== "object") return false;
  try {
    return (holdingsHash ?? stableDataHash(legacy?.holdings ?? [])) !== DEFAULT_HOLDINGS_HASH
      || (catalogHash ?? stableDataHash(legacy?.catalog ?? {})) !== DEFAULT_CATALOG_HASH;
  } catch (_error) {
    return true;
  }
}

function isDefaultSplitPayload({ holdingsHash = "", catalogHash = "" } = {}) {
  return holdingsHash === DEFAULT_HOLDINGS_HASH && catalogHash === DEFAULT_CATALOG_HASH;
}

function completeCommitToken(meta = {}) {
  const revision = Math.max(0, toNumber(meta?.revision, 0));
  const commit = meta?.storageCommit;
  if (!commit || commit.writeComplete !== true || commit.state !== "complete") return "";
  if (Math.max(0, toNumber(commit.revision, 0)) !== revision) return "";
  return [revision, commit.writeId, commit.holdingsHash, commit.catalogHash].map((value) => String(value ?? "")).join(":");
}

function logicalMetadataHash(meta = {}) {
  const logicalMeta = { ...meta };
  // Commit bookkeeping alone is a no-op; catalog versions and migration
  // operation markers remain persistent data even without partition changes.
  delete logicalMeta.revision;
  delete logicalMeta.lastUpdated;
  delete logicalMeta.storageCommit;
  return stableDataHash(logicalMeta);
}

export function createSkyholdSplitStorage({ settings = null, assertWriteAuthority = () => {} } = {}) {
  let cachedRevision = null;
  let cachedCommitToken = "";
  let cachedData = null;
  let cachedPartitionHashes = null;
  let persistedPartitionHashes = null;
  let warnedCommitProblem = "";
  const metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    normalizations: 0,
    settingReads: 0,
    settingWrites: 0,
    noOpWrites: 0,
    hashesByPartition: { holdings: 0, catalog: 0 },
    readsByKey: {},
    writesByKey: {}
  };

  function hashPartition(partition, value) {
    metrics.hashesByPartition[partition] = (metrics.hashesByPartition[partition] ?? 0) + 1;
    return stableDataHash(value);
  }

  function settingsApi() {
    const api = settings ?? globalThis.game?.settings;
    if (!api || typeof api.get !== "function" || typeof api.set !== "function") {
      throw new Error("FBL Skyhold | Foundry settings API is not available.");
    }
    return api;
  }

  function readSetting(key) {
    metrics.settingReads += 1;
    metrics.readsByKey[key] = (metrics.readsByKey[key] ?? 0) + 1;
    countSkyholdPerformance("Foundry.settings.read");
    countSkyholdPerformance(`Foundry.settings.read.${key}`);
    return settingsApi().get(MODULE_ID, key);
  }

  async function writeSetting(key, value) {
    assertWriteAuthority();
    metrics.settingWrites += 1;
    metrics.writesByKey[key] = (metrics.writesByKey[key] ?? 0) + 1;
    countSkyholdPerformance("Foundry.settings.write");
    countSkyholdPerformance(`Foundry.settings.write.${key}`);
    return settingsApi().set(MODULE_ID, key, value);
  }

  function warnCommitProblem(inspection, splitRevision, legacyRevision, recoveryMode = "") {
    const warningKey = `${inspection.reason}:${inspection.commit?.writeId ?? splitRevision}:${legacyRevision}:${recoveryMode}`;
    if (warningKey === warnedCommitProblem) return;
    warnedCommitProblem = warningKey;
    const recoveryText = recoveryMode ? `; recovery=${recoveryMode}` : "";
    console.warn(`FBL Skyhold | Split data commit is ${inspection.reason}${recoveryText}.`, inspection);
  }

  function readSettings(providedMeta) {
    const split = {
      meta: clone(providedMeta ?? readSetting(SETTING_META) ?? DEFAULT_SKYHOLD_DATA.meta),
      holdings: clone(readSetting(SETTING_HOLDINGS) ?? DEFAULT_SKYHOLD_DATA.holdings),
      catalog: clone(readSetting(SETTING_CATALOG) ?? DEFAULT_SKYHOLD_DATA.catalog)
    };
    persistedPartitionHashes = {
      holdings: hashPartition("holdings", split.holdings),
      catalog: hashPartition("catalog", split.catalog)
    };

    const splitRevision = Math.max(0, toNumber(split?.meta?.revision, 0));
    const commitInspection = inspectStorageCommit(split, {
      holdingsHash: persistedPartitionHashes.holdings,
      catalogHash: persistedPartitionHashes.catalog
    });
    const legacy = readSetting(SETTING_DATA);
    const legacyRevision = Math.max(0, toNumber(legacy?.meta?.revision, 0));

    if (!commitInspection.ok) {
      const recovery = recoverStorageCommit(split, {
        inspection: commitInspection,
        holdingsHash: persistedPartitionHashes.holdings,
        catalogHash: persistedPartitionHashes.catalog
      });
      if (recovery.ok) {
        if (recovery.mode === "rollback"
          && legacyRevision === recovery.data?.meta?.revision
          && legacyHasRuntimeData(legacy)) {
          warnCommitProblem(commitInspection, splitRevision, legacyRevision, "legacy-rollback");
          return legacy;
        }
        warnCommitProblem(commitInspection, splitRevision, legacyRevision, recovery.mode);
        return recovery.data;
      }
      if (legacyHasRuntimeData(legacy)) {
        warnCommitProblem(commitInspection, splitRevision, legacyRevision, "legacy-fallback");
        return legacy;
      }
      warnCommitProblem(commitInspection, splitRevision, legacyRevision, "unrecoverable-split");
      return split;
    }

    // Worlds that already have skyholdData keep working: the first write after this
    // version persists them into split settings. Revision wins after the split exists.
    // The equality fallback protects older saves that never had a revision bump.
    if (legacyRevision > splitRevision) return legacy;
    if (legacyRevision === splitRevision
      && isDefaultSplitPayload({
        holdingsHash: persistedPartitionHashes.holdings,
        catalogHash: persistedPartitionHashes.catalog
      })
      && legacyHasRuntimeData(legacy)) return legacy;
    return split;
  }

  function resolveData({ cloneResult = true } = {}) {
    const rawMeta = readSetting(SETTING_META) ?? DEFAULT_SKYHOLD_DATA.meta;
    const rawRevision = Math.max(0, toNumber(rawMeta?.revision, 0));
    const rawCommitToken = completeCommitToken(rawMeta);
    if (cachedData && cachedRevision === rawRevision && rawCommitToken && cachedCommitToken === rawCommitToken) {
      metrics.cacheHits += 1;
      return cloneResult ? clone(cachedData) : cachedData;
    }

    metrics.cacheMisses += 1;
    const stored = readSettings(rawMeta);
    metrics.normalizations += 1;
    const migrated = measureSkyholdPerformance("SkyholdData.normalize", () => migrateData(stored));
    cachedRevision = Math.max(0, toNumber(migrated?.meta?.revision, 0));
    cachedCommitToken = completeCommitToken(migrated?.meta);
    // `migrated` is a fresh private root. Cache it directly and clone only the
    // value crossing the storage boundary instead of cloning the same large
    // settlement twice on every cache miss.
    cachedData = freezeDataView(migrated);
    cachedPartitionHashes = {
      holdings: hashPartition("holdings", migrated.holdings),
      catalog: hashPartition("catalog", migrated.catalog)
    };
    return cloneResult ? clone(cachedData) : cachedData;
  }

  function getData() {
    return resolveData({ cloneResult: true });
  }

  // Read-only view for render and forecast code. Callers must clone any branch
  // before mutating it; writes still go through persistData/transactions.
  function getDataView() {
    return resolveData({ cloneResult: false });
  }

  async function persistData(data, {
    normalized = false,
    scope = COMMIT_SCOPES.BOTH,
    withStatus = false,
    forceRollbackSnapshot = false
  } = {}) {
    const commitScope = normalizeCommitScope(scope);
    const previous = cachedData ?? getDataView();
    if (!normalized) metrics.normalizations += 1;
    const next = normalized
      ? {
          ...data,
          meta: clone(data?.meta ?? {}),
          holdings: commitScope === COMMIT_SCOPES.CATALOG ? previous.holdings : clone(data?.holdings ?? []),
          catalog: commitScope === COMMIT_SCOPES.HOLDINGS ? previous.catalog : clone(data?.catalog ?? {})
        }
      : measureSkyholdPerformance("SkyholdData.normalize", () => migrateData(data));
    // The shared view is frozen; the previous root is only
    // hashed or cloned for rollback below. Avoid a full eager clone here.
    if (!persistedPartitionHashes) {
      const storedHoldings = readSetting(SETTING_HOLDINGS) ?? DEFAULT_SKYHOLD_DATA.holdings;
      const storedCatalog = readSetting(SETTING_CATALOG) ?? DEFAULT_SKYHOLD_DATA.catalog;
      persistedPartitionHashes = {
        holdings: hashPartition("holdings", storedHoldings),
        catalog: hashPartition("catalog", storedCatalog)
      };
    }

    const previousRevision = Math.max(0, toNumber(previous?.meta?.revision, 0));
    const logicalPreviousHashes = cachedPartitionHashes ?? {
      holdings: hashPartition("holdings", previous?.holdings ?? []),
      catalog: hashPartition("catalog", previous?.catalog ?? {})
    };
    const nextHashes = {
      holdings: commitScope === COMMIT_SCOPES.CATALOG ? logicalPreviousHashes.holdings : hashPartition("holdings", next.holdings),
      catalog: commitScope === COMMIT_SCOPES.HOLDINGS ? logicalPreviousHashes.catalog : hashPartition("catalog", next.catalog)
    };
    const holdingsDirty = nextHashes.holdings !== persistedPartitionHashes.holdings;
    const catalogDirty = nextHashes.catalog !== persistedPartitionHashes.catalog;
    const metaDirty = logicalMetadataHash(next.meta) !== logicalMetadataHash(previous.meta);
    const splitMatchesLogicalPrevious = persistedPartitionHashes.holdings === logicalPreviousHashes.holdings
      && persistedPartitionHashes.catalog === logicalPreviousHashes.catalog;
    if (!holdingsDirty && !catalogDirty && !metaDirty && splitMatchesLogicalPrevious) {
      metrics.noOpWrites += 1;
      const result = clone(previous);
      return withStatus ? { changed: false, data: result, scope: commitScope } : result;
    }
    const needsRollbackSnapshot = Boolean(forceRollbackSnapshot)
      || (holdingsDirty && catalogDirty)
      || !splitMatchesLogicalPrevious;

    // A one-partition write is recoverable from the previous/target hashes in meta.
    // When both partitions change (or legacy data has not hydrated split settings),
    // preserve the last coherent logical root before starting the commit.
    if (needsRollbackSnapshot) await writeSetting(SETTING_DATA, clone(previous));

    const writeId = makeId("commit");
    const startedAt = new Date().toISOString();
    const startedMeta = makeStorageCommitMeta(next.meta, {
      writeId,
      previousRevision,
      previousHoldingsHash: persistedPartitionHashes.holdings,
      previousCatalogHash: persistedPartitionHashes.catalog,
      holdings: next.holdings,
      catalog: next.catalog,
      holdingsHash: nextHashes.holdings,
      catalogHash: nextHashes.catalog,
      complete: false,
      now: startedAt
    });

    next.meta = clone(startedMeta);
    await writeSetting(SETTING_META, clone(next.meta));
    if (holdingsDirty) await writeSetting(SETTING_HOLDINGS, clone(next.holdings));
    if (catalogDirty) await writeSetting(SETTING_CATALOG, clone(next.catalog));

    next.meta = makeStorageCommitMeta(next.meta, {
      writeId,
      previousRevision,
      previousHoldingsHash: persistedPartitionHashes.holdings,
      previousCatalogHash: persistedPartitionHashes.catalog,
      holdings: next.holdings,
      catalog: next.catalog,
      holdingsHash: nextHashes.holdings,
      catalogHash: nextHashes.catalog,
      complete: true,
      now: new Date().toISOString()
    });
    await writeSetting(SETTING_META, clone(next.meta));

    persistedPartitionHashes = nextHashes;
    cachedPartitionHashes = nextHashes;
    cachedRevision = Math.max(0, toNumber(next?.meta?.revision, 0));
    cachedCommitToken = completeCommitToken(next.meta);
    cachedData = freezeDataView(next);
    const result = clone(next);
    return withStatus ? { changed: true, data: result, scope: commitScope } : result;
  }

  function getMetrics() {
    return clone(metrics);
  }

  function resetMetrics() {
    metrics.cacheHits = 0;
    metrics.cacheMisses = 0;
    metrics.normalizations = 0;
    metrics.settingReads = 0;
    metrics.settingWrites = 0;
    metrics.noOpWrites = 0;
    metrics.hashesByPartition = { holdings: 0, catalog: 0 };
    metrics.readsByKey = {};
    metrics.writesByKey = {};
  }

  return {
    getData,
    getDataView,
    getMetrics,
    persistData,
    readSettings,
    resetMetrics
  };
}
