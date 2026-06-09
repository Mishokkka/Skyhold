import { BUILDING_TEMPLATES_FOOD } from "./building-template-catalog/food.js";
import { BUILDING_TEMPLATES_CULTURE } from "./building-template-catalog/culture.js";
import { BUILDING_TEMPLATES_TECHNOLOGY } from "./building-template-catalog/technology.js";
import { BUILDING_TEMPLATES_WAR } from "./building-template-catalog/war.js";

export const TEMPLATE_CATALOG_VERSION = 11;
export const DEPRECATED_TEMPLATE_IDS = new Set(["campfire","hut","storehouse","field","garden","lumberyard","mine","smithy","bakery","tavern","market","watchtower","shrine","fireplace"]);

const TEMPLATE_ORDER = ["well","grain-field","garden","pasture","pigsty","sheepfold","mill","bakery","inn","root-cellar","lumbermill","quarry","mine","forge","tannery","tailor-shop","vault","stables","construction-center","personnel-office","hiring-agency","pier","lighthouse","dovecote","tent-camp","cemetery","market","bathhouse","library","scriptorium","shrine","hall-of-fame","spire","shooting-range","training-camp","ramparts","moat","portcullis","guard-tower","dungeon","gallows","bunkhouse","common-house","boarding-house","barn","warehouse","guarded-storehouse","barracks","arsenal","lazaret","apothecary","watch-post","barricade-line","gatehouse","signal-tower","powder-magazine","field-fort","artillery-platform","school"];
const TEMPLATE_ROWS = [
  ...BUILDING_TEMPLATES_FOOD,
  ...BUILDING_TEMPLATES_CULTURE,
  ...BUILDING_TEMPLATES_TECHNOLOGY,
  ...BUILDING_TEMPLATES_WAR
];
const TEMPLATE_BY_ID = new Map(TEMPLATE_ROWS.map((template) => [String(template.id), template]));

export const DEFAULT_BUILDING_TEMPLATES = TEMPLATE_ORDER
  .map((id) => TEMPLATE_BY_ID.get(id))
  .filter(Boolean);

for (const template of DEFAULT_BUILDING_TEMPLATES) {
  template.templateVersion = TEMPLATE_CATALOG_VERSION;
}
