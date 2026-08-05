export const HOLDING_TYPES = {
  "sky-island": "Остров-летяга",
  settlement: "Поселение",
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
    region: "",
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
    list: [],
    market: {
      schemaVersion: 2,
      preferredRoomId: "outdoors",
      orders: [],
      // Legacy import reservations remain readable during migration. New
      // Market V2 operations use the single bid/ask liquidity ledger below.
      stockReservations: [],
      liquidity: {
        schemaVersion: 1,
        lines: [],
        reservations: [],
        receipts: []
      },
      exportBook: {
        version: 1,
        orders: [],
        advanceRuns: []
      }
    },
    fleet: {
      schemaVersion: 3,
      activeVesselId: "",
      vessels: [],
      transferMethods: {
        physical: { id: "physical", label: "Физическая передача", enabled: true, feePercent: 0, etaQd: 0, requiresDock: true, trace: "none" },
        bank: { id: "bank", label: "Банковский перевод через СТЛ", enabled: true, feePercent: 2, etaQd: 40, requiresDock: false, trace: "paper" },
        shadow: { id: "shadow", label: "Теневой перевод", enabled: true, feePercent: 6, etaQd: 20, requiresDock: false, trace: "discreet" }
      },
      transfers: []
    }
  },
  storage: {
    notes: "Ресурсы, припасы, груз и имущество.",
    resources: [],
    rationBuffer: {
      version: 1,
      entries: []
    },
    items: [],
    moneyCopper: 0,
    log: []
  },
  gm: {
    notes: "Скрытые заметки ГМа, заготовки событий и служебные пометки.",
    lastRoll: null,
    eventTables: null,
    eventHistory: [],
    eventTagThresholds: {
      food: { lowMax: 0, highMin: 3 },
      technology: { lowMax: 0, highMin: 3 },
      culture: { lowMax: 0, highMin: 3 },
      war: { lowMax: 0, highMin: 3 },
      population: { lowMax: 5, highMin: 15 },
      morale: { lowMax: -0.001, highMin: 1.501 },
      reputation: { lowMax: 0, highMin: 3 }
    },
    playersCanUseStorage: false,
    playersCanEditOverview: true,
    playersCanEditBuildings: false,
    playersCanEditResidents: false,
    playersCanEditDefense: false,
    playersCanEditBattle: false,
    playersCanEditSpecial: false,
    playersCanManageMarkets: false,
    loadingImage: "",
    modifiers: {
      food: 0,
      technology: 0,
      culture: 0,
      war: 0,
      defense: 0,
      reputation: 0,
      morale: 0,
      marketConnectionsLevel: 1
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
    economy: {
      landRightsProvided: false,
      commonTable: {
        activeMoraleBonus: 0,
        pendingMoraleBonus: 0
      },
      foodAllocation: {
        cursorResidentId: "",
        receipts: []
      },
      labor: {
        wageIndex: 1,
        payroll: {
          version: 1,
          accounts: {},
          receipts: []
        }
      },
      treasury: {
        upkeepThirdRemainder: 0,
        salaryArrearsCopper: 0,
        upkeepArrearsCopper: 0,
        upkeepOverdueTendays: 0
      }
    },
    massCombat: {
      schemaVersion: 2,
      phase: "setup",
      outcome: "active",
      terminalReason: "",
      pendingRound: null,
      startedAt: "",
      resolvedAt: "",
      resolvedBy: "",
      archive: [],
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
