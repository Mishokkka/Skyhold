/**
 * Reviewed defaults for new standard buildings. This module never reads world
 * data or changes an existing building in place. Existing buildings transition
 * only through the explicit labor-migration preview/apply workflow.
 *
 * QD limits describe work or equipment, not workersMax * personal labor norm.
 * Keeping steady production as staff avoids silently inventing new throughput.
 */
const GROUPS = [
  {
    mode: "passive", capacityQd: 0, limitKind: "passive",
    ids: [
      "well", "tent-camp", "cemetery", "shooting-range", "training-camp",
      "bunkhouse", "barracks", "root-cellar", "pier", "gallows", "common-house",
      "barn", "warehouse", "family-house", "dovecote", "boarding-house", "vault",
      "hall-of-fame", "spire", "ramparts", "moat", "portcullis",
      "urban-tenement", "comfortable-house", "fasti-shop", "laputa-excavated-crypt"
    ],
    reason: "Сооружение, жильё или сюжетная функция без самостоятельной регулярной работы."
  },
  {
    mode: "qd", capacityQd: null, limitKind: "agriculture",
    ids: ["grain-field", "garden", "apiary", "vineyard", "hop-yard"],
    reason: "Конечные сезонные этапы; пределы заданы трудом этапа, урожаем и календарём."
  },
  {
    mode: "qd", capacityQd: null, limitKind: "livestock",
    ids: ["animal-pen", "pasture", "pigsty", "sheepfold", "stables"],
    reason: "Труд по фактическому стаду и операциям; ежедневный уход не заменяется общей суммой."
  },
  {
    mode: "qd", capacityQd: null, limitKind: "batch-capacity",
    ids: ["tannery", "brewery", "winery", "brickworks"],
    reason: "Все производственные линии ограничены вместимостью партий и календарной выдержкой."
  },
  {
    mode: "qd", capacityQd: 20, limitKind: "leisure-capacity",
    ids: ["festival-square", "promenade-garden"],
    reason: "Полный объём услуги: вместимость досуга × установленный труд на одного посетителя."
  },
  {
    mode: "qd", capacityQd: 10, limitKind: "housing-service",
    ids: ["worker-dormitory"],
    reason: "Установленные 10 QD ухода дают предусмотренное улучшение комфорта; жильё сохраняется без него."
  },
  {
    mode: "staff", capacityQd: null, limitKind: "staff-places",
    ids: [
      "lumbermill", "quarry", "fishing-pier", "mill", "bakery", "oil-press",
      "cheesery", "smokehouse", "distillery", "weaving-workshop",
      "carpentry-workshop", "soapworks", "writing-workshop", "tailor-shop",
      "apothecary", "mine", "glassworks", "tool-workshop", "forge",
      "printing-house", "cannery", "machine-works", "chemical-plant", "steelworks",
      "greenhouse-complex", "high-tech-components-plant", "military-factory"
    ],
    reason: "Рабочая смена мастерской или производства; отдельный предел оборудования для всех линий не задан."
  },
  {
    mode: "staff", capacityQd: null, limitKind: "staff-places",
    ids: [
      "watch-post", "barricade-line", "signal-tower", "sheriff-post",
      "guard-tower", "dungeon", "field-fort", "guard-house", "gatehouse",
      "artillery-platform", "militia-headquarters", "guard-precinct",
      "garrison-administration", "military-academy", "bastion",
      "main-headquarters", "citadel"
    ],
    reason: "Дежурство, охрана или командование; отсутствие происшествий не освобождает назначенного сотрудника."
  },
  {
    mode: "staff", capacityQd: null, limitKind: "staff-places",
    ids: ["arsenal", "guarded-storehouse", "powder-magazine", "grain-elevator", "industrial-icehouse"],
    reason: "Профиль хранения или защита требуют действующего обслуживания; базовый объём склада сохраняется."
  },
  {
    mode: "staff", capacityQd: null, limitKind: "staff-places",
    ids: [
      "market", "alehouse", "school", "inn", "game-house", "hiring-agency",
      "bathhouse", "shrine", "lazaret", "construction-center", "library",
      "lighthouse", "personnel-office", "scriptorium", "performance-house",
      "waterworks", "fire-station", "telegraph-station", "sewer-system", "gasworks",
      "railway-depot", "irrigation-system", "food-distribution-center",
      "town-hall", "hospital", "bank-exchange", "city-theatre", "museum",
      "mansion", "court", "airship-yard", "university", "agronomic-institute",
      "meeting-house"
    ],
    reason: "Регулярная услуга, учреждение или дежурство; фактические задачи и профессиональные допуски сохраняются."
  }
];

const profiles = {};
const notes = {};
for (const group of GROUPS) {
  for (const id of group.ids) {
    if (Object.hasOwn(profiles, id)) throw new Error(`Duplicate building labor profile: ${id}`);
    profiles[id] = Object.freeze({ version: 1, mode: group.mode, capacityQd: group.capacityQd });
    notes[id] = Object.freeze({ limitKind: group.limitKind, reason: group.reason });
  }
}

export const BUILDING_LABOR_CATALOG_PROPOSALS = Object.freeze(profiles);
export const BUILDING_LABOR_CATALOG_NOTES = Object.freeze(notes);

/** Unknown/custom templates must be reviewed, never inferred from their name. */
export function proposedBuildingLaborProfile(templateId) {
  const id = String(templateId ?? "");
  return Object.hasOwn(profiles, id) ? { ...profiles[id] } : null;
}

/**
 * Called only while constructing the new standard catalog, or explicitly
 * preparing a migration target. Not a normalizer for saved/customized buildings.
 */
export function applyApprovedBuildingLaborProfile(template) {
  const labor = proposedBuildingLaborProfile(template?.templateId || template?.id);
  if (!labor) return { ...template };
  const passive = labor.mode === "passive";
  const workersMax = passive ? 0 : template.workersMax;
  const activation = {
    ...template.activation,
    minWorkers: 0,
    ...(["inn", "tavern"].includes(template?.templateId || template?.id) && template.functions?.culture === true
      ? { anyWorkingFunction: false } : {}),
    ...(passive ? { minOperationalQd: 0, requiresMeaningfulResult: false } : {})
  };
  const activationConditionText = passive
    ? "Пассивный объект: постоянные работники и регулярные QD не требуются. Состояние сооружения и специальные условия сохраняются."
    : labor.mode === "staff"
      ? "Работы выполняет постоянный штат. Общего минимума людей нет; допуски, требуемая работа и условия каждой услуги сохраняются."
      : "Работы выполняются по выделенным QD. Число разных исполнителей не ограничено прежними штатными местами; учитываются труд задачи, квалификация и вместимость оборудования.";
  return {
    ...template,
    labor,
    workersMin: 0,
    workersMax,
    ...(passive ? { workerRole: "" } : {}),
    ...(template.workerProfile ? {
      workerProfile: { ...template.workerProfile, workersMin: 0, workersMax }
    } : {}),
    activation,
    activationConditionText
  };
}
