const CLASS_GROUPS = Object.freeze({
  minimal: Object.freeze([
    "well", "grain-field", "garden", "pasture", "pigsty", "sheepfold", "goat-pen", "poultry-yard", "rabbitry", "root-cellar", "lumbermill", "quarry", "tannery", "tailor-shop", "stables", "dovecote", "tent-camp", "cemetery", "shooting-range", "moat", "gallows", "bunkhouse", "barn", "watch-post", "barricade-line"
  ]),
  standard: Object.freeze([
    "mill", "bakery", "inn", "mine", "forge", "vault", "construction-center", "personnel-office", "hiring-agency", "pier", "market", "bathhouse", "library", "shrine", "training-camp", "guard-tower", "dungeon", "common-house", "boarding-house", "warehouse", "barracks", "lazaret", "apothecary", "signal-tower", "school"
  ]),
  heavy: Object.freeze([
    "lighthouse", "scriptorium", "guarded-storehouse", "arsenal", "portcullis", "gatehouse", "powder-magazine", "field-fort", "artillery-platform"
  ]),
  monumental: Object.freeze(["hall-of-fame", "spire"]),
  exceptional: Object.freeze(["ramparts"]),
  none: Object.freeze(["fasti-shop"])
});

const CLASS_BY_TEMPLATE = Object.freeze(Object.fromEntries(
  Object.entries(CLASS_GROUPS).flatMap(([maintenanceClass, ids]) => ids.map((id) => [id, maintenanceClass]))
));

const OPERATING_COPPER_MONTHLY = Object.freeze({
  inn: 2,
  mine: 1,
  forge: 2,
  "construction-center": 1,
  "hiring-agency": 1,
  lighthouse: 2,
  market: 1,
  bathhouse: 1,
  scriptorium: 1,
  "hall-of-fame": 1,
  spire: 1,
  "signal-tower": 1,
  "powder-magazine": 1,
  "artillery-platform": 1,
  school: 1
});

const CLASS_NOTES = Object.freeze({
  none: "Объект не создаёт регулярного обязательства владения.",
  minimal: "Мелкое содержание ограды, кровли, крепежа и простого инвентаря.",
  standard: "Регулярное обслуживание корпуса и стационарной оснастки.",
  heavy: "Сложная или опасная инфраструктура требует постоянного обслуживания.",
  monumental: "Крупная конструкция требует распределённого ухода за кладкой, перекрытиями и доступом.",
  exceptional: "Исключительно крупный объект требует отдельной постоянной службы содержания.",
  custom: "Пользовательское распределение содержания."
});

const CLASS_COPPER_PER_TENDAY = Object.freeze({
  none: 0,
  minimal: 2,
  standard: 5,
  heavy: 10,
  monumental: 20,
  exceptional: 40
});

export const BUILDING_MAINTENANCE_TEMPLATE_IDS = Object.freeze(Object.keys(CLASS_BY_TEMPLATE));

export function buildingMaintenanceForTemplate(templateId = "", legacyUpkeep = 0) {
  const id = String(templateId ?? "");
  const maintenanceClass = CLASS_BY_TEMPLATE[id] ?? "custom";
  if (!Object.hasOwn(CLASS_COPPER_PER_TENDAY, maintenanceClass)) return legacyBuildingMaintenanceForTemplate(id, legacyUpkeep);
  const copperPerTenday = CLASS_COPPER_PER_TENDAY[maintenanceClass];
  return {
    version: 2,
    class: maintenanceClass,
    billingMode: "fixed-tenday",
    copperPerTenday,
    operatingCopperMonthly: copperPerTenday * 3,
    repairReserveCopperMonthly: 0,
    notes: CLASS_NOTES[maintenanceClass] ?? CLASS_NOTES.custom
  };
}

export function legacyBuildingMaintenanceForTemplate(templateId = "", legacyUpkeep = 0) {
  const id = String(templateId ?? "");
  const maintenanceClass = CLASS_BY_TEMPLATE[id] ?? "custom";
  const total = maintenanceClass === "none" ? 0 : Math.max(1, Number(legacyUpkeep) || 0);
  const operatingCopperMonthly = Math.min(total, Math.max(0, Number(OPERATING_COPPER_MONTHLY[id]) || 0));
  return {
    version: 1,
    class: maintenanceClass,
    billingMode: "legacy-monthly",
    copperPerTenday: null,
    operatingCopperMonthly,
    repairReserveCopperMonthly: total - operatingCopperMonthly,
    notes: CLASS_NOTES[maintenanceClass] ?? CLASS_NOTES.custom
  };
}
