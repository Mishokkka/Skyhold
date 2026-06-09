import { LAPUTA_IMPORT } from "./laputa-import.js";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "./building-templates.js";
import { clone } from "./utils.js";

export const CANONICAL_WORKER_TYPES = new Set([
  "Все с СИЛ", "Все с ЛОВ", "Все с РАЗ", "Все с ЭМП",
  "Разнорабочий",
  "Силач", "Ловкач", "Умелец", "Переговорщик",
  "Строитель", "Механик", "Бригадир", "Ремесленник", "Посыльный", "Управленец",
  "Мастеровой", "Агент", "Старшина", "Полевой вожак", "Мастер на все руки"
]);

export const LEGACY_WORKER_TYPE_MAP = {
  "Тягловик": "Силач",
  "Тяжелый рабочий": "Силач",
  "Проворник": "Ловкач",
  "Распорядитель": "Переговорщик",
  "Эмпат": "Переговорщик",
  "Землекоп": "Силач",
  "Лесоруб": "Силач",
  "Шахтер": "Силач",
  "Палач": "Силач",
  "Травник": "Умелец",
  "Кожевник": "Умелец",
  "Мельник": "Умелец",
  "Пекарь": "Умелец",
  "Писарь": "Умелец",
  "Ученый": "Умелец",
  "Архитектор": "Умелец",
  "Земледелец": "Механик",
  "Каменщик": "Механик",
  "Кузнец": "Механик",
  "Стражник": "Механик",
  "Плотник": "Механик",
  "Портной": "Ремесленник",
  "Стрелок": "Ремесленник",
  "Разведчик": "Ремесленник",
  "Зверолов": "Ремесленник",
  "Банщик": "Бригадир",
  "Могильщик": "Бригадир",
  "Конюх": "Бригадир",
  "Тюремщик": "Бригадир",
  "Воин": "Строитель",
  "Моряк": "Строитель",
  "Такелажник": "Строитель",
  "Пастух": "Управленец",
  "Повар": "Управленец",
  "Торговец": "Управленец",
  "Жрец": "Управленец",
  "Летописец": "Управленец",
  "Лекарь": "Управленец",
  "Смотритель": "Управленец",
  "Авиарабочий": "Мастеровой"
};

export const BROAD_WORKER_TYPE_MAP = {
  "все с сил": "Все с СИЛ",
  "все с лов": "Все с ЛОВ",
  "все с раз": "Все с РАЗ",
  "все с эмп": "Все с ЭМП"
};

export const HOLDING_TYPES = {
  "sky-island": "Остров-летяга",
  settlement: "Поселение",
  ship: "Корабль",
  outpost: "Аванпост",
  organization: "Организация"
};

export const BASE_HOLDING = {
  id: "",
  name: "Новое владение",
  type: "settlement",
  owner: "",
  visibility: "public",
  linkedSceneId: "",
  constructionCrewIds: [],
  constructionCrews: [],
  overview: {
    status: "Стабильно",
    period: "Неделя 1",
    description: "Краткое описание владения появится здесь.",
    publicNotes: "Публичные заметки для игроков.",
    population: 0,
    morale: 0,
    moraleBase: 0,
    reputation: 0,
    defense: 0,
    altitude: "",
    drift: "",
    mechanisms: "",
    weather: "",
    development: {
      food: 0,
      technology: 0,
      culture: 0,
      war: 0
    }
  },
  people: {
    notes: "Здесь будут жители, экипаж, специалисты, наемники, гости и проблемные персонажи.",
    list: []
  },
  buildings: {
    notes: "Здесь будут построенные объекты этого владения. Это экземпляры, а не шаблоны из каталога.",
    list: []
  },
  special: {
    notes: "Уникальные свойства, маршруты, договоры, странности, артефакты и секреты.",
    list: []
  },
  storage: {
    notes: "Ресурсы, припасы, груз и имущество.",
    resources: [],
    items: [],
    moneyCopper: 0,
    log: []
  },
  gm: {
    notes: "Скрытые заметки ГМа, заготовки событий и служебные пометки.",
    lastRoll: null,
    playersCanUseStorage: false,
    playersCanEditOverview: true,
    playersCanEditBuildings: false,
    playersCanEditResidents: false,
    playersCanEditDefense: false,
    playersCanEditBattle: false,
    playersCanEditSpecial: false,
    loadingImage: "",
    modifiers: {
      food: 0,
      technology: 0,
      culture: 0,
      war: 0,
      defense: 0,
      reputation: 0,
      morale: 0
    },
    efficiencyModifiers: {
      all: 0,
      production: 0,
      constructionCrew: 0
    },
    defense: {
      militiaTrained: false,
      militiaEquipped: false,
      militiaLeader: false,
      commanderId: "",
      victorySound: "",
      defeatSound: "",
      drawSound: "",
      notes: "",
      squads: []
    },
    calendaria: { enabled: false, lastTimestamp: null, lastDateKey: "", lastDateText: "", lastDateTime: null, lastQd: 0 },
    massCombat: {
      title: "",
      enemyName: "Нападающие",
      objective: "Налет",
      roundThreat: "assault",
      scale: "raid",
      defenseMode: "behindWalls",
      accessMode: "normal",
      defenderMobilization: "watch",
      useDefenseSquads: true,
      raiseMilitia: false,
      attackerPreset: "custom",
      defenderUnits: 0,
      defenderBS: 0,
      defenderCommand: 0,
      defenderHero: 0,
      defenderMorale: 0,
      defenderSpecial: 0,
      defenderPosition: 0,
      defenderStrategy: "holdFortifications",
      attackerUnits: 3,
      attackerBS: 15,
      attackerCommand: 0,
      attackerHero: 0,
      attackerSpecial: 0,
      attackerPosition: 0,
      attackerStrategy: "frontalAssault",
      defenderInfantry: 0,
      defenderShooters: 0,
      defenderMobile: 0,
      defenderHeavy: 0,
      defenderSappers: 0,
      defenderSiege: 0,
      defenderSkirmishers: 0,
      defenderMonsters: 0,
      defenderSacred: 0,
      attackerInfantry: 3,
      attackerShooters: 0,
      attackerMobile: 0,
      attackerHeavy: 0,
      attackerSappers: 0,
      attackerSiege: 0,
      attackerSkirmishers: 0,
      attackerMonsters: 0,
      attackerSacred: 0,
      round: 1,
      roundLimit: 3,
      breachProgress: 0,
      objectiveProgress: 0,
      objectiveThreshold: 3,
      defenderLossSteps: 0,
      attackerLossSteps: 0,
      settlementDamage: 0,
      defenderShaken: 0,
      defenderBroken: 0,
      attackerShaken: 0,
      attackerBroken: 0,
      notes: "",
      log: []
    }
  },
  log: []
};

export const DEFAULT_SKYHOLD_DATA = {
  meta: {
    schemaVersion: 46,
    templateCatalogVersion: TEMPLATE_CATALOG_VERSION,
    lastUpdated: null,
    revision: 0,
    storageCommit: null
  },
  holdings: [
    {
      ...clone(LAPUTA_IMPORT.holding)
    },
    {
      ...clone(BASE_HOLDING),
      id: "restoration-settlement",
      name: "Восстанавливаемое поселение",
      type: "settlement",
      owner: "Игроки",
      visibility: "public",
      overview: {
        ...clone(BASE_HOLDING.overview),
        status: "Восстановление",
        period: "Не задано",
        description: "Будущее поселение игроков. Сейчас это заготовка под восстановление.",
        publicNotes: "Здесь позже появятся руины, пригодное жилье, рабочие руки и угрозы территории."
      }
    },
    {
      ...clone(BASE_HOLDING),
      id: "magnific",
      name: "Магнифик",
      type: "ship",
      owner: "Адмирал Элина Траззмар",
      visibility: "public",
      overview: {
        ...clone(BASE_HOLDING.overview),
        status: "В строю",
        period: "Не задано",
        description: "Летающий корабль адмирала Элины Траззмар. Может вести экипаж, груз, рейсы и доходы.",
        publicNotes: "На следующих этапах сюда можно добавить контрабандистские заплывы, риск, доход и состояние корпуса.",
        mechanisms: "Корабельные системы",
        weather: "По маршруту"
      },
      people: {
        ...clone(BASE_HOLDING.people),
        notes: "Экипаж, офицеры, специалисты, пассажиры и наемники Магнифика."
      },
      buildings: {
        ...clone(BASE_HOLDING.buildings),
        notes: "Для корабля эта вкладка может хранить отсеки, узлы, вооружение и улучшения."
      },
      storage: {
        ...clone(BASE_HOLDING.storage),
        notes: "Груз, припасы, контрабанда, топливо, деньги и корабельное имущество."
      }
    }
  ],
  catalog: {
    buildings: DEFAULT_BUILDING_TEMPLATES,
    deletedBuildingTemplateIds: [],
    resources: []
  }
};
