// Compatibility facade. New internal code imports the canonical owner modules directly.
export { DEFAULT_SKYHOLD_DATA } from "./defaults/default-skyhold-data.js";
export { BASE_HOLDING, HOLDING_TYPES } from "./schema/base-holding.js";
export {
  BROAD_WORKER_TYPE_MAP,
  CANONICAL_WORKER_TYPES,
  LEGACY_WORKER_TYPE_MAP
} from "./worker-types.js";
