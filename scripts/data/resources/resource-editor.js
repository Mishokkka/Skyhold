import { normalizeResourceCatalogRow } from "../../core/resources.js";
import { materialGroupHelpText } from "../../core/material-groups.js";
import { BUILTIN_RESOURCE_DEFS } from "./builtin-resources.js";

function economyEditorFlags(row = {}) {
  const cargoClass = String(row.cargoClass ?? "10");
  return {
    economyLegacy: row.legacyEconomy === true,
    economyCurrent: row.legacyEconomy !== true,
    cargoClass1: cargoClass === "1",
    cargoClass2: cargoClass === "2",
    cargoClass5: cargoClass === "5",
    cargoClass10: cargoClass === "10",
    cargoClass20: cargoClass === "20",
    cargoClass40: cargoClass === "40",
    cargoClassLivestock: cargoClass === "livestock",
    cargoClassOversized: cargoClass === "oversized",
    cargoPointsManual: cargoClass === "livestock" || cargoClass === "oversized"
  };
}

export function prepareResourceCatalogEditor(catalogRows = [], { canEdit = false } = {}) {
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  const overrides = rows.map((row, index) => {
    const normalized = normalizeResourceCatalogRow(row);
    return {
      ...normalized,
      ...economyEditorFlags(normalized),
      _index: index,
      basePath: `catalog.resources.${index}`,
      aliasesText: Array.isArray(row.aliases) ? row.aliases.join(", ") : String(row.aliases ?? normalized.aliases.join(", ")),
      materialGroupsText: normalized.materialGroups.join(", "),
      marketTagsText: normalized.marketTags.join(", "),
      nutritionTagsText: normalized.nutritionTags.join(", "),
      dietGroupNone: !normalized.dietGroup,
      dietGroupStaple: normalized.dietGroup === "staple",
      dietGroupProtein: normalized.dietGroup === "protein",
      dietGroupDairy: normalized.dietGroup === "dairy",
      dietGroupProduce: normalized.dietGroup === "produce",
      loadAuto: normalized.loadMode === "auto",
      loadManual: normalized.loadMode === "manual",
      materialGroupHelpText: materialGroupHelpText(),
      isOverride: true,
      canEdit
    };
  });
  const overrideById = new Map(overrides.map((row) => [row.id, row]));
  const builtinIds = new Set(BUILTIN_RESOURCE_DEFS.map((row) => row.id));
  const builtinRows = BUILTIN_RESOURCE_DEFS.map((builtin) => {
    const override = overrideById.get(builtin.id);
    const effective = normalizeResourceCatalogRow(override ? { ...builtin, ...override } : builtin);
    return {
      ...effective,
      ...economyEditorFlags(effective),
      ...(override ?? {}),
      id: builtin.id,
      isBuiltin: true,
      isOverride: Boolean(override),
      aliasesText: (override?.aliases ?? effective.aliases ?? []).join(", "),
      materialGroupsText: (override?.materialGroups ?? effective.materialGroups ?? []).join(", "),
      marketTagsText: (override?.marketTags ?? effective.marketTags ?? []).join(", "),
      nutritionTagsText: (override?.nutritionTags ?? effective.nutritionTags ?? []).join(", "),
      dietGroupNone: !(override?.dietGroup ?? effective.dietGroup),
      dietGroupStaple: (override?.dietGroup ?? effective.dietGroup) === "staple",
      dietGroupProtein: (override?.dietGroup ?? effective.dietGroup) === "protein",
      dietGroupDairy: (override?.dietGroup ?? effective.dietGroup) === "dairy",
      dietGroupProduce: (override?.dietGroup ?? effective.dietGroup) === "produce",
      loadAuto: (override?.loadMode ?? effective.loadMode) === "auto",
      loadManual: (override?.loadMode ?? effective.loadMode) === "manual",
      materialGroupHelpText: materialGroupHelpText(),
      searchText: [builtin.id, override?.label ?? effective.label, override?.category ?? effective.category, override?.dietGroup ?? effective.dietGroup, ...(override?.aliases ?? effective.aliases ?? []), ...(override?.materialGroups ?? effective.materialGroups ?? []), ...(override?.marketTags ?? effective.marketTags ?? [])].join(" ").toLocaleLowerCase("ru"),
      canEdit
    };
  });
  const customRows = overrides.filter((row) => !builtinIds.has(row.id)).map((row) => ({
    ...row,
    isBuiltin: false,
    searchText: [row.id, row.label, row.category, row.dietGroup, ...(row.aliases ?? []), ...(row.materialGroups ?? []), ...(row.marketTags ?? [])].join(" ").toLocaleLowerCase("ru")
  }));
  return {
    rows: [...builtinRows, ...customRows],
    builtinCount: BUILTIN_RESOURCE_DEFS.length,
    overrideCount: overrides.filter((row) => builtinIds.has(row.id)).length,
    customCount: customRows.length,
    hasRows: builtinRows.length + customRows.length > 0
  };
}
