import { SkyholdData } from "./store.js";
import { findReadableHoldingEntry } from "./access-guard.js";

function normalizeHoldingId(holdingId) {
  return String(holdingId ?? "");
}

function findHoldingIndex(data, holdingId, { fallback = false } = {}) {
  const holdings = Array.isArray(data?.holdings) ? data.holdings : [];
  const id = normalizeHoldingId(holdingId);
  const exact = id ? holdings.findIndex((holding) => String(holding?.id ?? "") === id) : -1;
  if (exact >= 0) return exact;
  return fallback && holdings.length ? 0 : -1;
}

export class HoldingService {
  static getData() {
    return SkyholdData.get();
  }

  static async saveData(data) {
    return SkyholdData.set(data);
  }

  static getHoldingEntry(holdingId, { fallback = false, data = null } = {}) {
    const source = data ?? this.getData();
    const index = findHoldingIndex(source, holdingId, { fallback });
    const holding = index >= 0 ? source.holdings[index] : null;
    return { data: source, holding, index };
  }

  static getReadableHoldingEntry(holdingId, { fallback = false, data = null, user = globalThis.game?.user } = {}) {
    const source = data ?? this.getData();
    return findReadableHoldingEntry(source, holdingId, { fallback, user });
  }

  static getHolding(holdingId, options = {}) {
    return this.getHoldingEntry(holdingId, options).holding;
  }

  static getReadableHolding(holdingId, options = {}) {
    return this.getReadableHoldingEntry(holdingId, options).holding;
  }

  static async updateData(updater) {
    const data = this.getData();
    const result = await updater?.(data);
    const saved = await this.saveData(data);
    return result === undefined ? saved : result;
  }

  static async patchData(path, value) {
    return SkyholdData.update(path, value);
  }

  static async updateHolding(holdingId, updater, { fallback = false } = {}) {
    const data = this.getData();
    const index = findHoldingIndex(data, holdingId, { fallback });
    if (index < 0) return null;
    const holding = data.holdings[index];
    const result = await updater?.(holding, data, index);
    await this.saveData(data);
    return result === undefined ? { data, holding: data.holdings[index], index } : result;
  }

  static async patchHolding(holdingId, patch = {}, { fallback = false } = {}) {
    return this.updateHolding(holdingId, (holding) => {
      for (const [path, value] of Object.entries(patch ?? {})) {
        if (path.includes(".")) foundry.utils.setProperty(holding, path, value);
        else holding[path] = value;
      }
    }, { fallback });
  }

  static async updateMassCombatState(holdingId, patch = {}, { fallback = false } = {}) {
    return this.updateHolding(holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      Object.assign(holding.gm.massCombat, patch ?? {});
      return holding.gm.massCombat;
    }, { fallback });
  }

  static findHoldingIndex(data, holdingId, options = {}) {
    return findHoldingIndex(data, holdingId, options);
  }
}
