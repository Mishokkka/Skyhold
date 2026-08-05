import { HOLDING_TYPES } from "./schema/base-holding.js";
import { mergeHoldingDefaults } from "./normalizers.js";
import { makeId } from "./utils.js";

export function createHolding({ name = "Новое владение", type = "settlement" } = {}) {
  const id = makeId("holding");
  return mergeHoldingDefaults({
    id,
    name: String(name || "Новое владение").trim() || "Новое владение",
    type: HOLDING_TYPES[type] ? type : "settlement"
  });
}

export function getHoldingTypeLabel(type) {
  return HOLDING_TYPES[type] ?? type ?? "Владение";
}
