import { SkyholdData } from "./store.js";
import { findHoldingIndex, findReadableHoldingEntry } from "./access-guard.js";
import { clone, isPlainObject } from "./utils.js";

export class HoldingService {
  static getData() {
    return SkyholdData.get();
  }

  static getDataView() {
    return SkyholdData.view();
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
    return SkyholdData.transaction(updater, { reason: "holding-service:update-data", scope: "both" });
  }

  static async updateHolding(holdingId, updater, { fallback = false } = {}) {
    return SkyholdData.updateHolding(holdingId, updater, {
      fallback,
      reason: "holding-service:update-holding"
    });
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

  static async replaceMassCombatState(holdingId, state = {}, { fallback = false } = {}) {
    const next = isPlainObject(state) ? clone(state) : {};
    return this.updateHolding(holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      holding.gm.massCombat = next;
      return holding.gm.massCombat;
    }, { fallback });
  }

  static findHoldingIndex(data, holdingId, options = {}) {
    return findHoldingIndex(data, holdingId, options);
  }
}
