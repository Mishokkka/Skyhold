import { normalizeSkyholdData, normalizeCatalogPartition, normalizeHoldingsPartition, reconcileHoldingRegions } from "./normalizers.js";
import { ensureSharedMarketsState } from "./market/shared-context.js";
import { SKYHOLD_SCHEMA_VERSION } from "./schema-version.js";
import { assertSupportedWorldData } from "./storage-format.js";
import { clone, toNumber } from "./utils.js";

export const COMMIT_SCOPES = Object.freeze({
  HOLDINGS: "holdings",
  CATALOG: "catalog",
  BOTH: "both"
});

export function normalizeCommitScope(scope) {
  return scope === COMMIT_SCOPES.HOLDINGS || scope === COMMIT_SCOPES.CATALOG ? scope : COMMIT_SCOPES.BOTH;
}

export function prepareSkyholdCommit(data, {
  scope = COMMIT_SCOPES.BOTH,
  baseRevision = data?.meta?.revision,
  now = new Date().toISOString()
} = {}) {
  assertSupportedWorldData(data);
  const requestedScope = normalizeCommitScope(scope);
  let effectiveScope = requestedScope;
  let next;

  if (requestedScope === COMMIT_SCOPES.BOTH) {
    next = normalizeSkyholdData(data);
  } else if (requestedScope === COMMIT_SCOPES.HOLDINGS) {
    next = {
      ...data,
      meta: clone(data?.meta ?? {}),
      holdings: normalizeHoldingsPartition(data?.holdings, data?.catalog),
      catalog: data?.catalog
    };
  } else {
    const catalog = normalizeCatalogPartition(data?.catalog);
    const reconciliation = reconcileHoldingRegions(data?.holdings, catalog, { cloneOnWrite: true });
    effectiveScope = reconciliation.changed ? COMMIT_SCOPES.BOTH : COMMIT_SCOPES.CATALOG;
    next = {
      ...data,
      meta: clone(data?.meta ?? {}),
      holdings: reconciliation.holdings,
      catalog
    };
  }

  next.meta.schemaVersion = SKYHOLD_SCHEMA_VERSION;
  next.meta.templateCatalogVersion = Math.max(0, toNumber(
    next.meta.templateCatalogVersion,
    data?.meta?.templateCatalogVersion
  ));
  next.meta.lastUpdated = now;
  next.meta.revision = Math.max(0, toNumber(baseRevision, 0)) + 1;
  if (requestedScope !== COMMIT_SCOPES.BOTH) {
    ensureSharedMarketsState(next, data?.meta?.sharedMarkets ?? null);
  }
  return { data: next, scope: effectiveScope };
}
