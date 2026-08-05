import { BUILDING_TEMPLATES_FOOD } from "./building-template-catalog/food.js";
import { BUILDING_TEMPLATES_LIVESTOCK } from "./building-template-catalog/livestock.js";
import { BUILDING_TEMPLATES_CULTURE } from "./building-template-catalog/culture.js";
import { BUILDING_TEMPLATES_TECHNOLOGY } from "./building-template-catalog/technology.js";
import { BUILDING_TEMPLATES_WAR } from "./building-template-catalog/war.js";
import { BUILDING_TEMPLATES_UNIQUE } from "./building-template-catalog/unique.js";
import { canonicalMaterialCostRows } from "./building-template-materials.js";
import { enterpriseCapitalForTemplate } from "./building-template-capital.js";
import { buildingMaintenanceForTemplate } from "./building-template-maintenance.js";

export const TEMPLATE_CATALOG_VERSION = 29;
export const DEPRECATED_TEMPLATE_IDS = new Set(["campfire","hut","storehouse","field","garden","lumberyard","mine","smithy","bakery","tavern","market","watchtower","shrine","fireplace"]);

export const TEMPLATE_ORDER = ["well","grain-field","garden","pasture","pigsty","sheepfold","goat-pen","poultry-yard","rabbitry","mill","bakery","inn","root-cellar","lumbermill","quarry","mine","forge","tannery","tailor-shop","vault","stables","construction-center","personnel-office","hiring-agency","pier","lighthouse","dovecote","tent-camp","cemetery","market","bathhouse","library","scriptorium","shrine","hall-of-fame","spire","shooting-range","training-camp","ramparts","moat","portcullis","guard-tower","dungeon","gallows","bunkhouse","common-house","boarding-house","barn","warehouse","guarded-storehouse","barracks","arsenal","lazaret","apothecary","watch-post","barricade-line","gatehouse","signal-tower","powder-magazine","field-fort","artillery-platform","school","fasti-shop"];
const TEMPLATE_ROWS = [
  ...BUILDING_TEMPLATES_FOOD,
  ...BUILDING_TEMPLATES_LIVESTOCK,
  ...BUILDING_TEMPLATES_CULTURE,
  ...BUILDING_TEMPLATES_TECHNOLOGY,
  ...BUILDING_TEMPLATES_WAR,
  ...BUILDING_TEMPLATES_UNIQUE
];
const TEMPLATE_BY_ID = new Map(TEMPLATE_ROWS.map((template) => [String(template.id), template]));

export const FBL_SOURCE_BUILDING_MATERIAL_COSTS = Object.freeze(Object.fromEntries(
  TEMPLATE_ROWS.map((template) => [
    String(template.id),
    Object.freeze(canonicalMaterialCostRows(template.materialCosts).map((row) => Object.freeze(row)))
  ])
));

/**
 * @deprecated Historical name retained for import compatibility. The values are
 * the source/FBL recipes, not the later campaign calibration.
 */
export const LEGACY_BUILDING_MATERIAL_COSTS = FBL_SOURCE_BUILDING_MATERIAL_COSTS;

export const LEGACY_BUILDING_UPKEEP = Object.freeze(Object.fromEntries(
  TEMPLATE_ROWS.map((template) => [String(template.id), Number(template.upkeep) || 0])
));

export const DEFAULT_BUILDING_TEMPLATES = TEMPLATE_ORDER
  .map((id) => TEMPLATE_BY_ID.get(id))
  .filter(Boolean)
  .map((template) => {
    const maintenance = buildingMaintenanceForTemplate(template.id, template.upkeep);
    return {
      ...template,
      materialCosts: (FBL_SOURCE_BUILDING_MATERIAL_COSTS[template.id] ?? []).map((row) => ({ ...row })),
      enterpriseCapital: enterpriseCapitalForTemplate(template.id) ?? template.enterpriseCapital,
      maintenance,
      upkeep: maintenance.operatingCopperMonthly + maintenance.repairReserveCopperMonthly
    };
  });
