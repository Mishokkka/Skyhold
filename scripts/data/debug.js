import { MODULE_ID, SETTING_DEBUG_LOGS } from "./constants.js";

export function isSkyholdDebugLoggingEnabled() {
  if (globalThis.fblSkyholdDebug === true) return true;
  try {
    return game?.settings?.get?.(MODULE_ID, SETTING_DEBUG_LOGS) === true;
  } catch (_error) {
    return false;
  }
}

export function debugSkyholdLog(...args) {
  if (isSkyholdDebugLoggingEnabled()) console.log(...args);
}
