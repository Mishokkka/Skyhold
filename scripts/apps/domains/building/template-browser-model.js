import { buildingRequiresConstructionCenter, CONSTRUCTION_CENTER_TEMPLATE_ID } from "../../../data/building-development-tree.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { parseResourceCosts, resourceLabel } from "../../../core/resources.js";
import { formatCopperCurrency } from "../../../core/currency.js";
import { buildingNominalMorale } from "../../../engines/economy/building-service.js";

export function normalizeTemplateSearch(value = "") {
  const text = String(value ?? "")
    .toLowerCase()
    .replace(/ё/g, "е");
  const normalized = typeof text.normalize === "function" ? text.normalize("NFKD") : text;
  return normalized.replace(/[\u0300-\u036f]/g, "");
}

export function templateListBonusChips(row) {
  const social = [
    ["reputation", "Репутация", "fa-solid fa-crown"],
    ["moraleDelta", "Довольство", "fa-solid fa-face-smile"]
  ].flatMap(([key, label, icon]) => {
    const value = key === "moraleDelta" ? buildingNominalMorale(row) : Number(row[key]) || 0;
    if (!value) return [];
    const text = `${value > 0 ? "+" : ""}${value}`;
    return [{ icon, text, tooltip: `${label}: ${text}`, negative: value < 0 }];
  });
  return [...(row.bonusChips ?? []), ...social].map((chip) => ({
    ...chip, negative: chip.negative || /^[-−]/.test(String(chip.text)),
    text: String(chip.text).replace(/^[+−-]/, "")
  }));
}

export function templateListPresentation(row) {
  const built = Boolean(row.hasBuilt);
  const repeatLeisure = Boolean(row.service?.leisure?.kind) && buildingNominalMorale(row) > 0;
  const leisureOnly = built && row.repeatSettlementEffects !== true && repeatLeisure;
  return {
    listState: built ? "built" : (row.unlocked ? "available" : "locked"),
    showBuiltCheck: built && row.repeatSettlementEffects !== true && !repeatLeisure,
    listBonusChips: leisureOnly
      ? templateListBonusChips({ ...row, bonusChips: [], reputation: 0 })
      : templateListBonusChips(row)
  };
}

export function templateSearchText(row = {}) {
  return [
    row.name,
    row.label,
    row.type,
    row.description,
    row.primaryDevLabel,
    row.templateCategory,
    row.functionLabels,
    row.productionLinesText,
    row.specialRequirements,
    row.sourceRequirement,
    row.sourceRawMaterials, row.effect,
    ...(row.productionLines ?? []).map((line) => `${line.expenses ?? ""} ${line.resource ?? ""} ${line.resourceId ?? ""}`),
    ...(row.materialCosts ?? []).map((cost) => `${cost.name ?? ""} ${cost.resourceId ?? ""} ${resourceLabel(cost)}`),
    ...(row.productionLines ?? []).map((line) => `${resourceLabel(line.resourceId || line.resource)} ${JSON.stringify(parseResourceCosts(line.expenses))}`)
  ].map(normalizeTemplateSearch).join("\u241f");
}

/** A completed Center reveals its branch even during repairs or a temporary shutdown. */
export function templateBranchVisible(row, holding) {
  const required = buildingRequiresConstructionCenter(row)
    || (row.requiredBuildingIds ?? []).includes(CONSTRUCTION_CENTER_TEMPLATE_ID);
  if (!required) return true;
  return (holding?.buildings?.list ?? []).some((building) => {
    const state = buildingOperationalState(building);
    return String(building.templateId ?? building.id) === CONSTRUCTION_CENTER_TEMPLATE_ID
      && ["active", "disabled"].includes(state.lifecycle) && state.condition !== "destroyed";
  });
}

export function templateBrowserScope(catalog, holding, canEdit, availability) {
  const visible = (catalog.rows ?? []).filter((row) => templateBranchVisible(row, holding));
  const publicRows = visible.filter((row) => row.playerVisible !== false && row.visibility !== "gm");
  const hiddenRows = canEdit ? visible.filter((row) => row.playerVisible === false || row.visibility === "gm") : [];
  return { publicRows, hiddenRows, scopedRows: canEdit && availability === "hidden" ? hiddenRows : publicRows };
}

export function filterTemplateRows(rows, { category = "all", availability = "all", purpose = "all", stage = "all", sort = "name" } = {}) {
  return rows.filter((row) => (category === "all" || String(row.templateCategory ?? row.primaryDev) === category)
    && (availability !== "available" || row.unlocked)
    && (availability !== "locked" || !row.unlocked)
    && (availability !== "built" || row.hasBuilt)
    && (purpose === "all" || row.functions?.[purpose])
    && (stage === "all" || String(row.developmentStage ?? 0) === stage))
    .sort((a, b) => (sort === "stage" ? Number(a.developmentStage ?? 0) - Number(b.developmentStage ?? 0) : 0)
      || String(a.name).localeCompare(String(b.name), "ru") || String(a.id).localeCompare(String(b.id)));
}

// Presentation only: preserve authored fields while avoiding repeated rule sentences.
export function templatePassportRuleText(row = {}) {
  const seen = new Set();
  const fields = ["siteRequirementsText", "specialRequirements", "effect", "activationConditionText", "notes"];
  return Object.fromEntries(fields.map((field) => {
    const parts = String(row[field] ?? "").trim().split(/\n+|(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u).filter(Boolean);
    const text = parts.filter((part) => {
      const key = normalizeTemplateSearch(part).replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join("\n");
    return [field, text];
  }));
}

export function templatePassport(row, rows, productionLines = []) {
  if (!row) return null;
  const names = new Map(rows.map((item) => [String(item.id), item.name]));
  const all = [...(row.requiredBuildingIds ?? [])];
  if (buildingRequiresConstructionCenter(row) && !all.includes(CONSTRUCTION_CENTER_TEMPLATE_ID)) all.push(CONSTRUCTION_CENTER_TEMPLATE_ID);
  const label = (id) => names.get(String(id)) ?? "Недоступный чертёж";
  return {
    ...row,
    ...templatePassportRuleText(row),
    displayBonusChips: templateListBonusChips(row),
    hasDependencies: all.length > 0 || Boolean(row.requiredAnyBuildingIds?.length),
    dependenciesText: [all.length ? `Все: ${all.map(label).join(", ")}` : "",
      row.requiredAnyBuildingIds?.length ? `Одно из: ${row.requiredAnyBuildingIds.map(label).join(" или ")}` : ""].filter(Boolean).join(". ") || "Нет",
    staffingText: `${row.workersMin ?? 0}–${row.workersMax ?? 0}`,
    wageText: formatCopperCurrency(row.wageDailyCopper ?? 0),
    baseUpkeepText: formatCopperCurrency(row.baseUpkeepMonthlyCopper ?? 0),
    operatingUpkeepText: formatCopperCurrency(row.operatingUpkeepMonthlyCopper ?? 0),
    maintenanceText: `${row.maintenance?.requiredPoints ?? 0} QD / десятник`,
    recipes: productionLines.filter((line) => line.active !== false).map((line) => ({
      name: row.productionLines?.find((item) => String(item.id) === line.id)?.name || line.mode || "Производство",
      inputs: line.expenses || "Без материалов",
      output: line.resource,
      cycleText: line.totalPreview,
      seasonText: line.hasSeasonHint ? line.seasonLabel : "",
      expensePeriod: line.expenseMode === "unit" ? "за единицу выпуска" : "за цикл"
    }))
  };
}
