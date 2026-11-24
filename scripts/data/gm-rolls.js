// Compatibility facade for older imports. The GM tab now uses editable random
// event tables stored on each holding under gm.eventTables.
export {
  DEFAULT_RANDOM_EVENT_TABLES as GM_ROLLS,
  normalizeRandomEventTables,
  rollRandomEventTable
} from "./random-events.js";
