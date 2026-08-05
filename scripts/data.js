/**
 * Supported compatibility entry point for macros and external integrations.
 * Runtime modules import their canonical owners directly to keep dependencies explicit.
 */
export * from "./data/store.js";
export * from "./data/access-guard.js";
export * from "./data/authority.js";
export * from "./data/building-templates.js";
export * from "./data/command-result.js";
export * from "./data/collection-operations.js";
export * from "./data/gm-rolls.js";
export * from "./data/holding-operations.js";
export * from "./data/holding-permissions.js";
export * from "./data/holding-service.js";
export * from "./data/laputa-import.js";
export * from "./data/laputa-service.js";
export * from "./data/normalizers.js";
export * from "./data/player-write-guard.js";
export * from "./data/socket.js";
export * from "./data/split-storage.js";
export * from "./data/write-queue.js";

export {
  BASE_HOLDING
} from "./data/schema/base-holding.js";

export {
  BROAD_WORKER_TYPE_MAP,
  CANONICAL_WORKER_TYPES,
  LEGACY_WORKER_TYPE_MAP
} from "./data/worker-types.js";

export {
  isPlainObject,
  makeId,
  mergeDefaults,
  toBoolean,
  toNumber
} from "./data/utils.js";
