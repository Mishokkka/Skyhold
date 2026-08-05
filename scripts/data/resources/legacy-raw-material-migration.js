const LEGACY_RAW_MATERIAL_COMPENDIUM_PREFIX = "Compendium.world.resursy.Item.";

export function isLegacyRawMaterialItemBinding(row = {}) {
  return String(row?.itemUuid ?? "").trim().startsWith(LEGACY_RAW_MATERIAL_COMPENDIUM_PREFIX);
}
