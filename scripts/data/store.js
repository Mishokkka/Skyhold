import { bindSharedMarkets } from "./market/shared-context.js";
import { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
import { importLaputaHolding } from "./laputa-service.js";
import { addCollectionRow, deleteCollectionRow } from "./collection-operations.js";
import { addHoldingToData, deleteHoldingFromData, updateHoldingInData } from "./holding-operations.js";
import { clone, toNumber } from "./utils.js";
import { notifySkyholdChanged } from "./notifications.js";
import { createSkyholdSplitStorage } from "./split-storage.js";
import { createSkyholdSocketApi } from "./socket.js";
import { createWriteQueue } from "./write-queue.js";
import { measureSkyholdPerformance } from "./performance-observer.js";
import { COMMIT_SCOPES, normalizeCommitScope, prepareSkyholdCommit } from "./commit-preparation.js";
import { MODULE_ID, SETTING_DATA } from "./constants.js";
import { stableDataHash } from "./storage-commit.js";
import { createGmWriteAuthority } from "./gm-write-authority.js";
import { assertNoNewEntityCollisions } from "./entity-identity.js";

export { clone } from "./utils.js";
export { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
export { HOLDING_TYPES } from "./schema/base-holding.js";
export {
  MODULE_ID,
  SETTING_CATALOG,
  SETTING_DATA,
  SETTING_DEBUG_LOGS,
  SETTING_HOLDINGS,
  SETTING_MASS_COMBAT_TAGS,
  SETTING_META,
  SETTING_PLAYERS_CAN_OPEN,
  SETTING_ROUTE_GRAPH_VIEW
} from "./constants.js";
export { canCurrentUserOpenSkyhold, registerSettings } from "./settings.js";
export { debugSkyholdLog, isSkyholdDebugLoggingEnabled } from "./debug.js";
export { createHolding, getHoldingTypeLabel } from "./holding-factory.js";
export { notifySkyholdChanged } from "./notifications.js";
export { inspectStorageCommit, makeStorageCommitMeta, recoverStorageCommit, stableDataHash } from "./storage-commit.js";

const splitStorage = createSkyholdSplitStorage({ assertWriteAuthority: () => gmWrites.assertAuthority() });
const enqueueSkyholdWrite = createWriteQueue();
let storageOperationExecutor = null;
let marketOperationExecutor = null;
let constructionOperationExecutor = null;

const SKIP_TRANSACTION = Symbol("fbl-skyhold-skip-transaction");

/**
 * Return this value from a SkyholdData transaction updater to skip persistence.
 * The wrapped value becomes the resolved transaction result.
 *
 * @template T
 * @param {T} value
 * @returns {{ value: T }}
 */
export function skipTransaction(value = null) {
  return { [SKIP_TRANSACTION]: true, value };
}

function isSkippedTransaction(value) {
  return Boolean(value && typeof value === "object" && value[SKIP_TRANSACTION]);
}

async function persistSkyholdData(data, options = {}) {
  gmWrites.assertAuthority();
  assertNoNewEntityCollisions(SkyholdData.view(), data);
  return measureSkyholdPerformance("SkyholdData.persist", () => splitStorage.persistData(data, options));
}

async function commitSkyholdData(data, {
  scope = COMMIT_SCOPES.BOTH,
  baseRevision = data?.meta?.revision,
  forceRollbackSnapshot = false
} = {}) {
  return measureSkyholdPerformance("SkyholdData.commit", async () => {
    assertNoNewEntityCollisions(SkyholdData.view(), data);
    const prepared = measureSkyholdPerformance("SkyholdData.normalize", () => prepareSkyholdCommit(data, { scope, baseRevision }));
    const next = prepared.data;
    if (!game.user?.isGM) return requestGmDataPatch(next);
    return gmWrites.requestCommit(next, {
      baseRevision,
      scope: prepared.scope,
      forceRollbackSnapshot
    });
  });
}

export class SkyholdData {
  static get() {
    return measureSkyholdPerformance("SkyholdData.get", () => bindSharedMarkets(splitStorage.getData()));
  }

  /**
   * Return the normalized storage cache as a read-only view. This avoids a
   * full world clone in render/forecast code; clone a branch before mutation.
   */
  static view() {
    return measureSkyholdPerformance("SkyholdData.view", () => bindSharedMarkets(splitStorage.getDataView()));
  }

  static skipTransaction(value = null) {
    return skipTransaction(value);
  }

  static async set(data, { reason = "set", baseRevision = data?.meta?.revision } = {}) {
    const draft = clone(data);
    return enqueueSkyholdWrite(() => commitSkyholdData(draft, { reason, baseRevision }));
  }

  /**
   * Run a serialized update against a mutable draft and persist it unless the
   * updater returns `skip(value)` or `skipTransaction(value)`.
   *
   * @template T
   * @param {(draft: object, context: { reason: string, skip: typeof skipTransaction }) => (T | Promise<T>)} updater
   * @param {{ reason?: string, scope?: "holdings" | "catalog" | "both", forceRollbackSnapshot?: boolean }} options
   * @returns {Promise<T | object>}
   *
   * @example
   * await SkyholdData.transaction((draft, { skip }) => {
   *   const holding = draft.holdings.find((row) => row.id === holdingId);
   *   if (!holding) return skip(null);
   *   holding.name = "New name";
   * });
   */
  static async transaction(updater, {
    reason = "transaction",
    scope = COMMIT_SCOPES.BOTH,
    forceRollbackSnapshot = false
  } = {}) {
    if (typeof updater !== "function") {
      throw new Error("FBL Skyhold | SkyholdData.transaction requires an updater function.");
    }

    return enqueueSkyholdWrite(async () => {
      const draft = SkyholdData.get();
      const baseRevision = Math.max(0, toNumber(draft?.meta?.revision, 0));
      const result = await updater(draft, { reason, skip: skipTransaction });
      if (isSkippedTransaction(result)) return result.value;
      const saved = await commitSkyholdData(draft, {
        reason,
        scope: normalizeCommitScope(scope),
        baseRevision,
        forceRollbackSnapshot
      });
      return result === undefined ? saved : result;
    });
  }

  static getRollbackSnapshotInfo({ expectedDataHash = "" } = {}) {
    if (!game.user?.isGM) return { ok: false, reason: "gm-only" };
    const snapshot = game.settings.get(MODULE_ID, SETTING_DATA);
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.holdings) || !snapshot.catalog) {
      return { ok: false, reason: "missing" };
    }
    const dataHash = stableDataHash(snapshot);
    const expected = String(expectedDataHash ?? "");
    if (expected && dataHash !== expected) return { ok: false, reason: "hash-mismatch", dataHash };
    return {
      ok: true,
      reason: "ready",
      dataHash,
      revision: Math.max(0, toNumber(snapshot?.meta?.revision, 0)),
      holdingIds: (snapshot.holdings ?? []).map((holding) => String(holding?.id ?? "")).filter(Boolean)
    };
  }

  static async restoreRollbackSnapshot({ expectedDataHash = "" } = {}) {
    if (!game.user?.isGM) return { ok: false, reason: "gm-only" };
    return enqueueSkyholdWrite(async () => {
      const info = this.getRollbackSnapshotInfo({ expectedDataHash });
      if (!info.ok) return info;
      const snapshot = clone(game.settings.get(MODULE_ID, SETTING_DATA));
      const current = SkyholdData.view();
      const saved = await commitSkyholdData(snapshot, {
        scope: COMMIT_SCOPES.BOTH,
        baseRevision: current?.meta?.revision,
        forceRollbackSnapshot: true
      });
      return { ok: true, restored: true, previousRevision: info.revision, data: saved };
    });
  }

  static async update(path, value) {
    return this.transaction((data) => {
      foundry.utils.setProperty(data, path, value);
    }, { reason: `update:${path}`, scope: String(path).startsWith("catalog.") ? COMMIT_SCOPES.CATALOG : String(path).startsWith("holdings.") ? COMMIT_SCOPES.HOLDINGS : COMMIT_SCOPES.BOTH });
  }

  static async addRow(collectionPath, row) {
    return this.transaction((data) => {
      addCollectionRow(data, collectionPath, row);
    }, { reason: `add-row:${collectionPath}`, scope: String(collectionPath).startsWith("catalog.") ? COMMIT_SCOPES.CATALOG : String(collectionPath).startsWith("holdings.") ? COMMIT_SCOPES.HOLDINGS : COMMIT_SCOPES.BOTH });
  }

  static async deleteRow(collectionPath, rowId) {
    return this.transaction((data) => {
      deleteCollectionRow(data, collectionPath, rowId);
    }, { reason: `delete-row:${collectionPath}`, scope: String(collectionPath).startsWith("catalog.") ? COMMIT_SCOPES.CATALOG : String(collectionPath).startsWith("holdings.") ? COMMIT_SCOPES.HOLDINGS : COMMIT_SCOPES.BOTH });
  }

  static async addHolding(holding) {
    return this.transaction((data) => {
      addHoldingToData(data, holding);
    }, { reason: "add-holding", scope: COMMIT_SCOPES.HOLDINGS });
  }

  static async deleteHolding(holdingId) {
    return this.transaction((data) => {
      deleteHoldingFromData(data, holdingId);
    }, { reason: "delete-holding", scope: COMMIT_SCOPES.HOLDINGS });
  }

  static async updateHolding(holdingId, updater, { fallback = false, reason = "update-holding" } = {}) {
    return this.transaction(async (data) => {
      return updateHoldingInData(data, holdingId, updater, { fallback, skip: skipTransaction });
    }, { reason, scope: COMMIT_SCOPES.HOLDINGS });
  }

  static async importLaputa() {
    return this.transaction((data) => {
      return importLaputaHolding(data);
    }, { reason: "import-laputa", scope: COMMIT_SCOPES.BOTH, forceRollbackSnapshot: true });
  }

  static async reset() {
    return this.set(clone(DEFAULT_SKYHOLD_DATA), { reason: "reset", baseRevision: this.view()?.meta?.revision });
  }
}

const gmWrites = createGmWriteAuthority({ getData: () => SkyholdData.view(), enqueueWrite: enqueueSkyholdWrite,
  persistData: persistSkyholdData, notifyChanged: notifySkyholdChanged });

const socketApi = createSkyholdSocketApi({
  executePoliticsOperation: async (operation, context) => {
    const { executePoliticsOperation } = await import("../apps/politics-operation-executor.js");
    return executePoliticsOperation(operation, context);
  },
  executeShipOperation: async (operation, context) => {
    const { executeShipOperation } = await import("../apps/ship-operation-executor.js");
    return executeShipOperation(operation, context);
  },
  getData: () => SkyholdData.get(),
  enqueueWrite: enqueueSkyholdWrite,
  persistData: persistSkyholdData,
  notifyChanged: notifySkyholdChanged,
  executeStorageOperation: (operation, context) => {
    if (typeof storageOperationExecutor !== "function") {
      throw new Error("FBL Skyhold | Storage operation executor is not registered.");
    }
    return storageOperationExecutor(operation, context);
  },
  executeMarketOperation: (operation, context) => {
    if (typeof marketOperationExecutor !== "function") {
      throw new Error("FBL Skyhold | Market operation executor is not registered.");
    }
    return marketOperationExecutor(operation, context);
  },
  executeConstructionOperation: (operation, context) => {
    if (typeof constructionOperationExecutor !== "function") {
      throw new Error("FBL Skyhold | Construction operation executor is not registered.");
    }
    return constructionOperationExecutor(operation, context);
  }
});

function requestGmDataPatch(data) {
  return socketApi.requestGmDataPatch(data);
}

export function registerStorageOperationExecutor(executor) {
  if (typeof executor !== "function") {
    throw new TypeError("FBL Skyhold | Storage operation executor must be a function.");
  }
  storageOperationExecutor = executor;
}

export function registerMarketOperationExecutor(executor) {
  if (typeof executor !== "function") {
    throw new TypeError("FBL Skyhold | Market operation executor must be a function.");
  }
  marketOperationExecutor = executor;
}

export function registerConstructionOperationExecutor(executor) {
  if (typeof executor !== "function") {
    throw new TypeError("FBL Skyhold | Construction operation executor must be a function.");
  }
  constructionOperationExecutor = executor;
}

export function requestMarketOperation(operation) {
  return socketApi.requestMarketOperation(operation);
}

export function requestShipOperation(operation) {
  return socketApi.requestShipOperation(operation);
}

export function requestPoliticsOperation(operation) {
  return socketApi.requestPoliticsOperation(operation);
}

export function requestStorageOperation(operation) {
  return socketApi.requestStorageOperation(operation);
}

export function requestConstructionOperation(operation) {
  return socketApi.requestConstructionOperation(operation);
}

export function getSkyholdDataPerformanceMetrics() {
  return splitStorage.getMetrics();
}

export function resetSkyholdDataPerformanceMetrics() {
  splitStorage.resetMetrics();
}

export async function handleSkyholdSocketPayload(payload, senderId) {
  if (await gmWrites.handle(payload, senderId)) return true;
  return socketApi.handleSkyholdSocketPayload(payload, senderId);
}
