import { clone, makeId, toNumber } from "./utils.js";

const STORAGE_COMMIT_VERSION = 2;

export function stableDataHash(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function makeStorageCommitMeta(meta = {}, {
  writeId,
  previousRevision = 0,
  previousHoldingsHash,
  previousCatalogHash,
  holdings,
  catalog,
  holdingsHash,
  catalogHash,
  complete = false,
  now = new Date().toISOString()
} = {}) {
  const revision = Math.max(0, toNumber(meta?.revision, 0));
  const commitId = String(writeId || makeId("commit"));
  const existingCommit = meta?.storageCommit?.writeId === commitId ? meta.storageCommit : {};
  return {
    ...clone(meta ?? {}),
    storageCommit: {
      version: STORAGE_COMMIT_VERSION,
      writeId: commitId,
      state: complete ? "complete" : "writing",
      writeComplete: Boolean(complete),
      previousRevision: Math.max(0, toNumber(previousRevision, 0)),
      revision,
      startedAt: String(existingCommit?.startedAt ?? now),
      completedAt: complete ? now : null,
      previousHoldingsHash: String(previousHoldingsHash ?? existingCommit?.previousHoldingsHash ?? ""),
      previousCatalogHash: String(previousCatalogHash ?? existingCommit?.previousCatalogHash ?? ""),
      holdingsHash: String(holdingsHash ?? stableDataHash(holdings ?? [])),
      catalogHash: String(catalogHash ?? stableDataHash(catalog ?? {}))
    }
  };
}

export function inspectStorageCommit(split = {}, {
  holdingsHash: providedHoldingsHash,
  catalogHash: providedCatalogHash
} = {}) {
  const commit = split?.meta?.storageCommit;
  if (!commit) return { ok: true, reason: "missing" };
  if (commit.writeComplete !== true || commit.state !== "complete") return { ok: false, reason: "incomplete", commit };

  const revision = Math.max(0, toNumber(split?.meta?.revision, 0));
  const commitRevision = Math.max(0, toNumber(commit.revision, 0));
  if (revision !== commitRevision) return { ok: false, reason: "revision-mismatch", commit };

  const holdingsHash = providedHoldingsHash ?? stableDataHash(split?.holdings ?? []);
  const catalogHash = providedCatalogHash ?? stableDataHash(split?.catalog ?? {});
  if (commit.holdingsHash && commit.holdingsHash !== holdingsHash) return { ok: false, reason: "holdings-hash-mismatch", commit };
  if (commit.catalogHash && commit.catalogHash !== catalogHash) return { ok: false, reason: "catalog-hash-mismatch", commit };
  return { ok: true, reason: "complete", commit };
}

export function recoverStorageCommit(split = {}, {
  inspection: providedInspection = null,
  holdingsHash: providedHoldingsHash,
  catalogHash: providedCatalogHash
} = {}) {
  const inspection = providedInspection ?? inspectStorageCommit(split, {
    holdingsHash: providedHoldingsHash,
    catalogHash: providedCatalogHash
  });
  if (inspection.ok) return { ok: true, mode: "complete", data: split, inspection };
  if (inspection.reason !== "incomplete") return { ok: false, mode: "unrecoverable", data: null, inspection };

  const commit = inspection.commit ?? {};
  const holdingsHash = providedHoldingsHash ?? stableDataHash(split?.holdings ?? []);
  const catalogHash = providedCatalogHash ?? stableDataHash(split?.catalog ?? {});
  const targetMatches = Boolean(commit.holdingsHash && commit.catalogHash)
    && commit.holdingsHash === holdingsHash
    && commit.catalogHash === catalogHash;
  if (targetMatches) {
    const recovered = clone(split);
    recovered.meta.storageCommit = {
      ...recovered.meta.storageCommit,
      state: "complete",
      writeComplete: true,
      recovered: "forward"
    };
    return { ok: true, mode: "forward", data: recovered, inspection };
  }

  const previousMatches = Boolean(commit.previousHoldingsHash && commit.previousCatalogHash)
    && commit.previousHoldingsHash === holdingsHash
    && commit.previousCatalogHash === catalogHash;
  if (previousMatches) {
    const recovered = clone(split);
    recovered.meta.revision = Math.max(0, toNumber(commit.previousRevision, 0));
    delete recovered.meta.storageCommit;
    return { ok: true, mode: "rollback", data: recovered, inspection };
  }

  return { ok: false, mode: "unrecoverable", data: null, inspection };
}
