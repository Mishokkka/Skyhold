// Approved morale/leisure catalog revision. v15 remains an immutable historical baseline.
import { buildingCatalogV15Templates } from "./building-template-revision-v15.js";

export const BUILDING_CATALOG_V16_VERSION = 16;

const DEV_ZERO = Object.freeze({ food: 0, technology: 0, culture: 0, war: 0 });
const EMPTY_FUNCTIONS = Object.freeze({ production: false, income: false, defense: false, housing: false, storage: false, culture: true });

function material(resourceId, name, qty) {
  return { id: `mat-${resourceId}`, resourceId, name, qty };
}

function neutralWorkerProfile({ id, name, stage, workersMin, workersMax, reason }) {
  return {
    version: 1,
    source: "approved",
    templateId: id,
    name,
    stage,
    workersMin,
    workersMax,
    admission: { text: "Любой трудоспособный", hard: false, clauses: [] },
    suitableSelectors: [],
    optimalSelectors: [],
    staffingClass: "B",
    composition: [],
    production: null,
    reason
  };
}

function leisureTemplate(base, {
  id,
  name,
  stage,
  requirements,
  bonuses,
  icon,
  description,
  effect,
  buildTarget,
  buildDifficulty,
  materialCosts,
  workers,
  wageDailyCopper,
  baseUpkeepMonthlyCopper,
  operatingUpkeepMonthlyCopper,
  leisure,
  requiredBuildingIds = [],
  siteRequirementsText = ""
}) {
  const fullQd = leisure.capacity * leisure.qdPerCapacity;
  return {
    ...structuredClone(base),
    id,
    name,
    type: "Инфраструктура",
    primaryDev: "culture",
    icon,
    img: "",
    description,
    effect,
    notes: "Довольство определяется фактически обеспеченной мощностью досуга; одинаковые виды имеют убывающую отдачу. Расходные материалы программы включены в денежное эксплуатационное содержание; отдельного списания напитков или реквизита со склада нет.",
    requirements,
    bonuses,
    developmentStage: stage,
    requiresConstructionCenter: stage >= 4,
    sourceRequirement: [requirements.food, requirements.technology, requirements.culture, requirements.war].join("/"),
    sourceRawMaterials: materialCosts.map((row) => `${row.name} ${row.qty}`).join("; "),
    buildTarget,
    buildDifficulty,
    buildProgress: 0,
    constructionStatus: "planned",
    materialCosts,
    requiredBuildingIds,
    requiredAnyBuildingIds: [],
    siteRequirementsText,
    specialRequirements: siteRequirementsText,
    activationConditionText: `${workers.min} фактически работающих сотрудников; минимум ${workers.min * 4} QD, ${fullQd} QD на полную мощность досуга за десятник`,
    activation: { minWorkers: workers.min, minOperationalQd: workers.min * 4, requiresMeaningfulResult: false },
    workersMin: workers.min,
    workersMax: workers.max,
    workerRole: "Работник досуга",
    wageDailyCopper,
    baseUpkeepMonthlyCopper,
    operatingUpkeepMonthlyCopper,
    upkeep: Math.ceil((baseUpkeepMonthlyCopper + operatingUpkeepMonthlyCopper) / 18),
    maintenance: { schemaVersion: 2, requiredPoints: 0, priority: 0, backlogTendays: 0, needsResolution: false, lastOperationId: "" },
    functions: { ...EMPTY_FUNCTIONS },
    productionLines: [],
    income: { base: 0, perWorker: 0, formula: "", risk: 0, illegal: false },
    defense: { base: 0, perStep: 0, workerStep: 0 },
    housing: { capacity: 0, comfort: 0, quality: 0, notes: "" },
    storage: { capacity: 0, security: 0, quality: 0 },
    service: {
      capacity: leisure.capacity,
      coverageKind: "population",
      coveredBuildingIds: [],
      leisure: { ...leisure, functionId: "culture", minWorkers: workers.min }
    },
    upgradesFromTemplateIds: [],
    repeatSettlementEffects: false,
    reputation: 0,
    moraleDelta: leisure.capacity,
    workerMoraleDelta: 0,
    workerProfile: neutralWorkerProfile({
      id,
      name,
      stage,
      workersMin: workers.min,
      workersMax: workers.max,
      reason: "Обслуживание посетителей и проведение программы досуга"
    }),
    templateVersion: BUILDING_CATALOG_V16_VERSION
  };
}

const BASE_ROWS = buildingCatalogV15Templates();
const SCHOOL_BASE = BASE_ROWS.find((row) => row.id === "school");

const NEW_TEMPLATES = Object.freeze([
  leisureTemplate(SCHOOL_BASE, {
    id: "festival-square",
    name: "Площадь гуляний",
    stage: 1,
    requirements: { food: 0, technology: 1, culture: 1, war: 0 },
    bonuses: { food: 0, technology: 0, culture: 1, war: 0 },
    icon: "fa-solid fa-people-group",
    description: "Открытая площадь для общих игр, встреч и праздников.",
    effect: "До 10 мест общего досуга за десятник",
    buildTarget: 2,
    buildDifficulty: 0,
    materialCosts: [material("wood", "Wood", 40), material("stone", "Stone", 20), material("cloth", "Cloth", 10)],
    workers: { min: 1, max: 1 },
    wageDailyCopper: 12,
    baseUpkeepMonthlyCopper: 18,
    operatingUpkeepMonthlyCopper: 18,
    leisure: { kind: "gathering", capacity: 10, qdPerCapacity: 2 },
    siteRequirementsText: "Открытая безопасная площадка, доступная жителям; проверка GM"
  }),
  leisureTemplate(SCHOOL_BASE, {
    id: "alehouse",
    name: "Пивная",
    stage: 1,
    requirements: { food: 3, technology: 1, culture: 2, war: 0 },
    bonuses: { ...DEV_ZERO },
    icon: "fa-solid fa-beer-mug-empty",
    description: "Небольшое питейное заведение без жилья и полноценной кухни.",
    effect: "До 12 мест питейного досуга за десятник",
    buildTarget: 3,
    buildDifficulty: 0,
    materialCosts: [material("wood", "Wood", 100), material("stone", "Stone", 40), material("cloth", "Cloth", 10)],
    workers: { min: 1, max: 1 },
    wageDailyCopper: 18,
    baseUpkeepMonthlyCopper: 18,
    operatingUpkeepMonthlyCopper: 54,
    leisure: { kind: "drinking", capacity: 12, qdPerCapacity: 5 / 3 }
  }),
  leisureTemplate(SCHOOL_BASE, {
    id: "game-house",
    name: "Дом игр",
    stage: 2,
    requirements: { food: 0, technology: 7, culture: 8, war: 0 },
    bonuses: { food: 0, technology: 0, culture: 1, war: 0 },
    icon: "fa-solid fa-dice",
    description: "Крытые настольные игры, состязания и общение без обязательной продажи алкоголя.",
    effect: "До 20 мест игрового досуга за десятник",
    buildTarget: 4,
    buildDifficulty: -1,
    materialCosts: [material("wood", "Wood", 160), material("stone", "Stone", 80), material("cloth", "Cloth", 20), material("parchment", "Письменные материалы", 10)],
    workers: { min: 2, max: 2 },
    wageDailyCopper: 18,
    baseUpkeepMonthlyCopper: 36,
    operatingUpkeepMonthlyCopper: 54,
    leisure: { kind: "games", capacity: 20, qdPerCapacity: 2 }
  }),
  leisureTemplate(SCHOOL_BASE, {
    id: "performance-house",
    name: "Дом представлений",
    stage: 3,
    requirements: { food: 0, technology: 16, culture: 26, war: 0 },
    bonuses: { food: 0, technology: 0, culture: 2, war: 0 },
    icon: "fa-solid fa-masks-theater",
    description: "Малая постоянная сцена для музыкантов, рассказчиков и актёров.",
    effect: "До 30 мест зрелищного досуга за десятник",
    buildTarget: 6,
    buildDifficulty: -2,
    materialCosts: [material("wood", "Wood", 240), material("stone", "Stone", 120), material("bricks", "Bricks", 60), material("glass", "Glass", 20), material("cloth", "Cloth", 40)],
    workers: { min: 3, max: 3 },
    wageDailyCopper: 18,
    baseUpkeepMonthlyCopper: 54,
    operatingUpkeepMonthlyCopper: 72,
    leisure: { kind: "performance", capacity: 30, qdPerCapacity: 2 }
  }),
  leisureTemplate(SCHOOL_BASE, {
    id: "promenade-garden",
    name: "Сад прогулок",
    stage: 3,
    requirements: { food: 12, technology: 14, culture: 22, war: 0 },
    bonuses: { food: 0, technology: 0, culture: 1, war: 0 },
    icon: "fa-solid fa-tree",
    description: "Ухоженный общественный сад для отдыха, прогулок и спокойных встреч.",
    effect: "До 20 мест прогулочного досуга за десятник",
    buildTarget: 5,
    buildDifficulty: -1,
    materialCosts: [material("wood", "Wood", 80), material("stone", "Stone", 120), material("straw", "Straw", 20), material("money", "ММ", 1000)],
    workers: { min: 1, max: 1 },
    wageDailyCopper: 12,
    baseUpkeepMonthlyCopper: 36,
    operatingUpkeepMonthlyCopper: 36,
    leisure: { kind: "promenade", capacity: 20, qdPerCapacity: 1 },
    requiredBuildingIds: ["well"],
    siteRequirementsText: "Свободный безопасный участок с доступом к воде; проверка GM"
  })
]);

const PASSIVE_SOCIAL_STAFFING = Object.freeze({
  well: { qd: 2, role: "Смотритель колодца" },
  cemetery: { qd: 4, role: "Смотритель кладбища" },
  pier: { qd: 4, role: "Смотритель пирса" },
  gallows: { qd: 4, role: "Служитель эшафота" },
  dovecote: { qd: 4, role: "Смотритель голубятни" },
  "boarding-house": { qd: 4, role: "Смотритель постоялого дома" },
  "hall-of-fame": { qd: 4, role: "Смотритель зала" },
  spire: { qd: 4, role: "Смотритель шпиля" },
  ramparts: { qd: 4, role: "Смотритель укреплений" }
});

const PATCHES = Object.freeze({
  inn: {
    bonuses: { food: 2, technology: 0, culture: 1, war: 0 },
    activationConditionText: "2 фактически работающих сотрудника досуга; от 40 QD культуры за десятник",
    activation: { minWorkers: 2, minOperationalQd: 40, requiresMeaningfulResult: false },
    service: {
      capacity: 100,
      coverageKind: "population",
      coveredBuildingIds: [],
      leisure: { kind: "drinking", capacity: 30, qdPerCapacity: 8 / 3, functionId: "culture", minWorkers: 2 }
    },
    moraleDelta: 30,
    notes: "Первые 40 QD досуга обеспечивают 15 мест; 80 QD — полную мощность 30. Кухня использует тот же общий предел в 10 работников, но отдельные QD производства. Расходы программы досуга включены в денежное содержание; кухня расходует материалы своих рецептов отдельно."
  },
  "city-theatre": {
    bonuses: { food: 0, technology: 0, culture: 3, war: 0 },
    activationConditionText: "6 фактически работающих сотрудников; от 24 QD культуры, 120 QD на полную программу за десятник",
    activation: { minWorkers: 6, minOperationalQd: 24, requiresMeaningfulResult: false },
    service: {
      capacity: 100,
      coverageKind: "population",
      coveredBuildingIds: [],
      leisure: { kind: "performance", capacity: 60, qdPerCapacity: 2, functionId: "culture", minWorkers: 6 }
    },
    moraleDelta: 60
  },
  museum: {
    bonuses: { food: 0, technology: 1, culture: 3, war: 0 },
    activationConditionText: "4 фактически работающих сотрудника; от 16 QD культуры, 80 QD на полную программу за десятник",
    activation: { minWorkers: 4, minOperationalQd: 16, requiresMeaningfulResult: false },
    service: {
      capacity: 100,
      coverageKind: "population",
      coveredBuildingIds: [],
      leisure: { kind: "museum", capacity: 40, qdPerCapacity: 2, functionId: "culture", minWorkers: 4 }
    },
    moraleDelta: 40
  },
  stables: { workerMoraleDelta: -1 },
  lazaret: { workerMoraleDelta: -1 },
  hospital: { workerMoraleDelta: -1 },
  soapworks: { moraleDelta: -1 },
  "industrial-icehouse": { workerMoraleDelta: -1 },
  "high-tech-components-plant": { moraleDelta: 0, workerMoraleDelta: 0 }
});

function patchTemplate(row) {
  const staffing = PASSIVE_SOCIAL_STAFFING[row.id];
  const patch = PATCHES[row.id] ?? {};
  const next = { ...structuredClone(row), ...structuredClone(patch), templateVersion: BUILDING_CATALOG_V16_VERSION };
  if (!staffing) return next;
  return {
    ...next,
    workersMin: 1,
    workersMax: 1,
    workerRole: staffing.role,
    activationConditionText: `1 фактически работающий сотрудник; ${staffing.qd} QD профильной службы за десятник`,
    activation: { minWorkers: 1, minOperationalQd: staffing.qd, requiresMeaningfulResult: false,
      ...(row.id === "gallows" ? { harmWhileOperational: true } : {}) },
    functions: { ...next.functions, culture: true },
    workerProfile: next.workerProfile ? { ...next.workerProfile, workersMin: 1, workersMax: 1, reason: staffing.role } : next.workerProfile
  };
}

export function buildingCatalogV16Templates() {
  return [...BASE_ROWS.map(patchTemplate), ...NEW_TEMPLATES.map((row) => structuredClone(row))];
}
