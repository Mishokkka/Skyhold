import { normalizeResourceCatalogRow } from "../../core/resources.js";
import { formatCopperCurrencyCompact } from "../../core/currency.js";
import { BUILTIN_RESOURCE_DEFS } from "./builtin-resources.js";

const FOOD_TYPE_OPTIONS = Object.freeze([
  { value: "", label: "Не задан" },
  { value: "grain", label: "Зерновая еда" },
  { value: "protein", label: "Белковая еда" },
  { value: "dairy", label: "Молочная еда" },
  { value: "fruit", label: "Фруктовая еда" },
  { value: "vegetable", label: "Овощная еда" }
]);

function loadValueText(loadPoints = 0) {
  const value = Math.max(0, Number(loadPoints) || 0) / 4;
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function editorPresentation(row = {}) {
  const builtin = BUILTIN_RESOURCE_DEFS.find((resource) => resource.id === row.id);
  const unitExplanation = builtin ? String(builtin.notes ?? "").match(/Смысл 1 ЕД\.:.*$/u)?.[0] ?? "" : "";
  const legacyFields = [
    row.materialGroups?.length ? `materialGroups: ${row.materialGroups.join(", ")}` : "",
    row.cost ? `cost: ${row.cost}` : "",
    row.shelfLife ? `shelfLife: ${row.shelfLife}` : ""
  ].filter(Boolean);
  const loadText = loadValueText(row.loadPoints);
  return {
    unitExplanation: unitExplanation && !String(row.notes ?? "").includes(unitExplanation) ? unitExplanation : "",
    priceText: formatCopperCurrencyCompact(row.basePriceCopper),
    loadValueText: loadText,
    loadTitle: `Нагрузка: ${loadText} (${row.loadPoints} пунктов, 1 пункт = 0,25)`,
    foodTypeOptions: FOOD_TYPE_OPTIONS.map((option) => ({ ...option, selected: option.value === row.foodType })),
    hasLegacyFields: legacyFields.length > 0,
    legacyFieldsText: legacyFields.join(" · ")
  };
}

export function prepareResourceCatalogEditor(catalogRows = [], { canEdit = false } = {}) {
  const rows = Array.isArray(catalogRows) ? catalogRows : [];
  const overrides = rows.map((row, index) => {
    const normalized = normalizeResourceCatalogRow(row);
    return {
      ...normalized,
      _index: index,
      basePath: `catalog.resources.${index}`,
      aliasesText: Array.isArray(row.aliases) ? row.aliases.join(", ") : String(row.aliases ?? normalized.aliases.join(", ")),
      materialGroupsText: normalized.materialGroups.join(", "),
      marketTagsText: normalized.marketTags.join(", "),
      ...editorPresentation(normalized),
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
      ...(override ?? {}),
      id: builtin.id,
      isBuiltin: true,
      isOverride: Boolean(override),
      aliasesText: (override?.aliases ?? effective.aliases ?? []).join(", "),
      materialGroupsText: (override?.materialGroups ?? effective.materialGroups ?? []).join(", "),
      marketTagsText: (override?.marketTags ?? effective.marketTags ?? []).join(", "),
      ...editorPresentation({ ...effective, ...(override ?? {}) }),
      searchText: [builtin.id, override?.label ?? effective.label, override?.category ?? effective.category, override?.categoryTag ?? effective.categoryTag, ...(override?.aliases ?? effective.aliases ?? []), ...(override?.materialGroups ?? effective.materialGroups ?? []), ...(override?.marketTags ?? effective.marketTags ?? [])].join(" ").toLocaleLowerCase("ru"),
      canEdit
    };
  });
  const customRows = overrides.filter((row) => !builtinIds.has(row.id)).map((row) => ({
    ...row,
    isBuiltin: false,
    searchText: [row.id, row.label, row.category, row.categoryTag, ...(row.aliases ?? []), ...(row.materialGroups ?? []), ...(row.marketTags ?? [])].join(" ").toLocaleLowerCase("ru")
  }));
  return {
    rows: [...builtinRows, ...customRows],
    builtinCount: BUILTIN_RESOURCE_DEFS.length,
    overrideCount: overrides.filter((row) => builtinIds.has(row.id)).length,
    customCount: customRows.length,
    hasRows: builtinRows.length + customRows.length > 0
  };
}
