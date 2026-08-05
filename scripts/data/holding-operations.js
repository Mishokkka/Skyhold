import { findHoldingIndex } from "./access-guard.js";
import { mergeHoldingDefaults } from "./normalizers.js";

export function addHoldingToData(data, holding) {
  if (!Array.isArray(data.holdings)) data.holdings = [];
  data.holdings.push(mergeHoldingDefaults(holding));
}

export function deleteHoldingFromData(data, holdingId) {
  if (!Array.isArray(data.holdings) || data.holdings.length <= 1) {
    throw new Error("FBL Skyhold | Cannot delete the last holding.");
  }

  data.holdings = data.holdings.filter((holding) => holding.id !== holdingId);
}

export async function updateHoldingInData(data, holdingId, updater, { fallback = false, skip = null } = {}) {
  const index = findHoldingIndex(data, holdingId, { fallback });
  if (index < 0) return typeof skip === "function" ? skip(null) : null;
  const holding = data.holdings[index];
  const result = await updater?.(holding, data, index);
  return result === undefined ? { data, holding: data.holdings[index], index } : result;
}
