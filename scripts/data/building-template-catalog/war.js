export const BUILDING_TEMPLATES_WAR = [
  {
    "id": "shooting-range",
    "compendiumId": "5tuKo0LKdDqQtB8E",
    "name": "Стрельбище",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-bullseye",
    "img": "",
    "unlocked": true,
    "description": "Площадка для обучения стрельбе.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "20 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 2
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с ЛОВ, Все с РАЗ, Ловкач, Умелец",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с РАЗ": 0.5,
      "Ловкач": 1,
      "Умелец": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Бонус +2 на прокачку Marksmanship, стоимость навыка и талантов ниже на 1.",
    "notes": "Бонус +2 на прокачку Marksmanship, стоимость навыка и талантов ниже на 1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "training-camp",
    "compendiumId": "JwC2JvLwfzcvCuPn",
    "name": "Тренировочный лагерь",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-dumbbell",
    "img": "",
    "unlocked": true,
    "description": "Место строевой и ближней боевой подготовки.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "40 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 2
    },
    "buildDifficulty": 0,
    "buildTarget": 2,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 40
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с СИЛ, Все с ЭМП, Силач, Переговорщик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЭМП": 0.5,
      "Силач": 1,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Бонус +2 на прокачку Melee, стоимость навыка и талантов ниже на 1.",
    "notes": "Бонус +2 на прокачку Melee, стоимость навыка и талантов ниже на 1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "ramparts",
    "compendiumId": "ZYxxUMGSgEtI9kw4",
    "name": "Крепостной вал",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-shield",
    "img": "",
    "unlocked": true,
    "description": "Главная линия обороны владения.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "600 Stone",
    "specialRequirements": "Требуется Builder.",
    "requirements": {
      "food": 0,
      "technology": 8,
      "culture": 0,
      "war": 8
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 7
    },
    "buildDifficulty": -3,
    "buildTarget": 6,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 600
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 8,
    "suitableWorkerTypes": "Все с СИЛ, Строитель",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Строитель": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 2,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Defense Rating +2.",
    "notes": "Defense Rating +2.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "moat",
    "compendiumId": "OlreS3dMiw0d5lTe",
    "name": "Ров",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-water",
    "img": "",
    "unlocked": true,
    "description": "Оборонительный ров перед валом.",
    "sourceRequirement": "RAMPARTS, the BUILDER talent",
    "sourceRawMaterials": "-",
    "specialRequirements": "Требуется Крепостной вал и Builder.",
    "requirements": {
      "food": 0,
      "technology": 8,
      "culture": 0,
      "war": 12
    },
    "bonuses": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 4
    },
    "buildDifficulty": -2,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [
      "ramparts"
    ],
    "workersMin": 1,
    "workersMax": 6,
    "suitableWorkerTypes": "Все с СИЛ, Все с ЛОВ, Силач, Ловкач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЛОВ": 0.5,
      "Силач": 1,
      "Ловкач": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 1,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Defense Rating +1.",
    "notes": "Defense Rating +1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "portcullis",
    "compendiumId": "Q75nBBfIWGfJx0IP",
    "name": "Решетка",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-dungeon",
    "img": "",
    "unlocked": true,
    "description": "Железная решетка ворот.",
    "sourceRequirement": "RAMPARTS, FORGE, the BUILDER talent",
    "sourceRawMaterials": "100 Iron",
    "specialRequirements": "Требуется Крепостной вал, Кузня и Builder.",
    "requirements": {
      "food": 0,
      "technology": 12,
      "culture": 0,
      "war": 14
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 4
    },
    "buildDifficulty": -2,
    "buildTarget": 3,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-iron",
        "name": "Iron",
        "resourceId": "iron",
        "qty": 100
      }
    ],
    "requiredBuildingIds": [
      "ramparts",
      "forge"
    ],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Механик, Силач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Механик": 1,
      "Силач": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 1,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Defense Rating +1.",
    "notes": "Defense Rating +1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "guard-tower",
    "compendiumId": "RW0AnPysqFKj2w8X",
    "name": "Охранная башня",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-tower-observation",
    "img": "",
    "unlocked": true,
    "description": "Дозор, наблюдение и раннее предупреждение.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "200 Wood or 400 Stone",
    "specialRequirements": "Можно строить из 400 Stone вместо 200 Wood. Требуется Builder.",
    "requirements": {
      "food": 0,
      "technology": 5,
      "culture": 0,
      "war": 5
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 4
    },
    "buildDifficulty": -1,
    "buildTarget": 4,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 200
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЛОВ, Все с РАЗ, Ловкач, Умелец",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с РАЗ": 0.5,
      "Ловкач": 1,
      "Умелец": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 1,
      "perStep": 1,
      "workerStep": 2
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Scouting +2 and Defense Rating +1.",
    "notes": "Scouting +2 and Defense Rating +1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "dungeon",
    "compendiumId": "kfLduHidHrttSPlc",
    "name": "Темница",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-lock",
    "img": "",
    "unlocked": true,
    "description": "Камеры для заключенных.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "50 Stone and 20 Iron",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 2,
      "war": 4
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 1,
      "war": 2
    },
    "buildDifficulty": -1,
    "buildTarget": 3,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 50
      },
      {
        "id": "mat-iron",
        "name": "Iron",
        "resourceId": "iron",
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с СИЛ, Все с ЭМП, Силач, Переговорщик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЭМП": 0.5,
      "Силач": 1,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 0,
      "perStep": 1,
      "workerStep": 1
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 1,
    "effect": "До четырех заключенных, если за ними следит тюремщик.",
    "notes": "До четырех заключенных, если за ними следит тюремщик.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "gallows",
    "compendiumId": "kJRbJDmeA8qxrggj",
    "name": "Эшафот",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-skull",
    "img": "",
    "unlocked": true,
    "description": "Публичные казни и запугивание нежелательных гостей.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "20 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 3,
      "war": 3
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": -1,
      "war": 2
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с ЭМП, Переговорщик",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": -1,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "После публичной казни риск нежелательных посетителей снижается.",
    "notes": "После публичной казни риск нежелательных посетителей снижается.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "guarded-storehouse",
    "compendiumId": "",
    "name": "Охраняемый склад",
    "type": "Складские",
    "primaryDev": "war",
    "icon": "fa-solid fa-box-archive",
    "img": "",
    "unlocked": true,
    "description": "Склад с замками, учетной комнатой и местом для караула.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 5,
      "culture": 0,
      "war": 2
    },
    "bonuses": {
      "food": 0,
      "technology": 3,
      "culture": 0,
      "war": 2
    },
    "buildDifficulty": 0,
    "buildTarget": 6,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 180
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 120
      },
      {
        "id": "mat-iron",
        "name": "Iron",
        "resourceId": "iron",
        "qty": 8
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Силач, Умелец",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Силач": 1,
      "Умелец": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": true,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 900,
      "security": 4,
      "quality": 2
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Склад с замками, учетной комнатой и местом для караула.",
    "notes": "Склад с замками, учетной комнатой и местом для караула.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "barracks",
    "compendiumId": "",
    "name": "Казарма",
    "type": "Жилье",
    "primaryDev": "war",
    "icon": "fa-solid fa-person-military-rifle",
    "img": "",
    "unlocked": true,
    "description": "Дешевое и вместительное жилье для солдат. Невоенным жителям в казарме тесно и неприятно.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "45 Wood; 10 Stone",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 1
    },
    "buildDifficulty": 0,
    "buildTarget": 2,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 45
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 10
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с СИЛ, Все с ЭМП, Силач, Переговорщик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЭМП": 0.5,
      "Силач": 1,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": true,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 1,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 20,
      "comfort": -2,
      "quality": -2,
      "notes": ""
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "20 мест. Жители с военной профессией не получают штраф довольства от казармы; остальные получают -2 от жилья.",
    "notes": "Казарма нужна для постоянной стражи, ротных комнат и дисциплины. Используется как дешевое жилье для солдатских отрядов.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "arsenal",
    "compendiumId": "",
    "name": "Арсенал",
    "type": "Оборона",
    "primaryDev": "war",
    "icon": "fa-solid fa-warehouse",
    "img": "",
    "unlocked": true,
    "description": "Склад оружия, пороха, доспехов и строевой амуниции.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "35 Wood; 20 Stone; 10 Iron",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 3,
      "culture": 0,
      "war": 4
    },
    "bonuses": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 2
    },
    "buildDifficulty": 0,
    "buildTarget": 3,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 35
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 20
      },
      {
        "id": "mat-iron",
        "name": "Iron",
        "resourceId": "iron",
        "qty": 10
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Механик, Силач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Механик": 1,
      "Силач": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": true,
      "culture": false
    },
    "productionLines": [],
    "income": {
      "base": 0,
      "perWorker": 0,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": false,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": ""
      }
    },
    "defense": {
      "base": 1,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 0,
      "comfort": 0,
      "quality": 0,
      "notes": ""
    },
    "storage": {
      "capacity": 120,
      "security": 4,
      "quality": 4
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Позволяет хранить вооружение отрядов. Ориентир закупки: простой отряд 5 человек 60-90 СМ; фузилеры 150-250 СМ; артиллерийская команда с орудием от 600 СМ.",
    "notes": "Покупку вооружения модуль пока не автоматизирует. Галочка экипировки у отряда остается решением ГМа.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "watch-post",
    "name": "Сторожевой пост",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-person-military-rifle",
    "unlocked": true,
    "description": "Малая охранная точка у ворот, склада или причала. Дает DR только при назначенной страже.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "25 Wood, 10 Stone",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 1
    },
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 25
      },
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 10
      }
    ],
    "workersMin": 1,
    "workersMax": 2,
    "workerRole": "Стража",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 0,
      "perStep": 1,
      "workerStep": 2
    },
    "upkeep": 1,
    "effect": "2 стражника дают +1 DR. Без людей пост почти не работает.",
    "notes": "Дешевое решение для складов, причалов и ворот.",
    "visibility": "public",
    "workerPrimaryAttribute": "agility",
    "suitableWorkerTypes": "Все с ЛОВ, Все с РАЗ, Ловкач, Умелец",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с РАЗ": 0.5,
      "Ловкач": 1,
      "Умелец": 1
    },
    "templateVersion": 11
  },
  {
    "id": "barricade-line",
    "name": "Линия баррикад",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-road-barrier",
    "unlocked": true,
    "description": "Съемные укрепления, мешки, телеги, ежи и завалы на подступах.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "40 Wood, 20 Stone, 10 Iron",
    "requirements": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 1
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 1
    },
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 40
      },
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 20
      },
      {
        "id": "mat-iron",
        "name": "Железо",
        "qty": 10
      }
    ],
    "workersMin": 1,
    "workersMax": 3,
    "workerRole": "Баррикадная команда",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 1,
      "perStep": 1,
      "workerStep": 3
    },
    "upkeep": 1,
    "effect": "+1 базовой DR и еще +1 DR при 3 назначенных работниках.",
    "notes": "Хорошо против рейда и уличного боя.",
    "visibility": "public",
    "workerPrimaryAttribute": "strength",
    "suitableWorkerTypes": "Все с СИЛ, Строитель",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Строитель": 1
    },
    "templateVersion": 11
  },
  {
    "id": "gatehouse",
    "name": "Надвратная башня",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-archway",
    "unlocked": true,
    "description": "Укрепленный вход с караулкой, бойницами и механизмом запирания.",
    "sourceRequirement": "Сторожевая башня или стены",
    "sourceRawMaterials": "90 Stone, 35 Wood, 25 Iron",
    "requirements": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 2
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 2
    },
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 90
      },
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 35
      },
      {
        "id": "mat-iron",
        "name": "Железо",
        "qty": 25
      }
    ],
    "workersMin": 2,
    "workersMax": 4,
    "workerRole": "Караул ворот",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 2,
      "perStep": 1,
      "workerStep": 2
    },
    "upkeep": 3,
    "effect": "+2 базовой DR, +1 DR за каждые 2 стражника.",
    "notes": "Ключевая точка для боев у входа.",
    "visibility": "public",
    "workerPrimaryAttribute": "wits",
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Механик, Силач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Механик": 1,
      "Силач": 1
    },
    "templateVersion": 11
  },
  {
    "id": "signal-tower",
    "name": "Сигнальная башня",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-tower-observation",
    "unlocked": true,
    "description": "Высокая точка наблюдения, флаги, фонари и тревожный колокол.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "60 Wood, 25 Stone, 5 Iron",
    "requirements": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 1
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 1
    },
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 60
      },
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 25
      },
      {
        "id": "mat-iron",
        "name": "Железо",
        "qty": 5
      }
    ],
    "workersMin": 1,
    "workersMax": 3,
    "workerRole": "Дозор",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 1,
      "perStep": 1,
      "workerStep": 3
    },
    "upkeep": 2,
    "effect": "+1 базовой DR и +1 DR при 3 дозорных. В Mass Combat усиливает разведку через работников и теги.",
    "notes": "Хороша против внезапных налетов.",
    "visibility": "public",
    "workerPrimaryAttribute": "wits",
    "suitableWorkerTypes": "Все с РАЗ, Умелец",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Умелец": 1
    },
    "templateVersion": 11
  },
  {
    "id": "powder-magazine",
    "name": "Пороховой погреб",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-boxes-stacked",
    "unlocked": true,
    "description": "Защищенное сухое хранилище для пороха, свинца, фитилей и боеприпасов.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "50 Stone, 25 Wood, 15 Iron",
    "requirements": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 1
    },
    "bonuses": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 1
    },
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 50
      },
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 25
      },
      {
        "id": "mat-iron",
        "name": "Железо",
        "qty": 15
      }
    ],
    "workersMin": 1,
    "workersMax": 2,
    "workerRole": "Смотритель погреба",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": true,
      "culture": false
    },
    "defense": {
      "base": 0,
      "perStep": 1,
      "workerStep": 2
    },
    "storage": {
      "capacity": 70,
      "security": 3,
      "quality": 3
    },
    "upkeep": 2,
    "effect": "Безопасное хранение боеприпасов. 2 смотрителя дают +1 DR за готовность оборонных запасов.",
    "notes": "Не создает бойцов, но помогает вооруженной обороне.",
    "visibility": "public",
    "workerPrimaryAttribute": "wits",
    "suitableWorkerTypes": "Все с РАЗ, Все с СИЛ, Умелец, Силач",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с СИЛ": 0.5,
      "Умелец": 1,
      "Силач": 1
    },
    "templateVersion": 11
  },
  {
    "id": "field-fort",
    "name": "Полевой редут",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-mountain-city",
    "unlocked": true,
    "description": "Вынесенная земляная позиция, ров, частокол и прикрытие для передового поста.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "70 Stone, 80 Wood",
    "requirements": {
      "food": 0,
      "technology": 1,
      "culture": 0,
      "war": 2
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 2
    },
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 70
      },
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 80
      }
    ],
    "workersMin": 2,
    "workersMax": 5,
    "workerRole": "Гарнизон редута",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 2,
      "perStep": 1,
      "workerStep": 3
    },
    "upkeep": 4,
    "effect": "+2 базовой DR, +1 DR при 3 и 5 назначенных бойцах.",
    "notes": "Лучше всего для обороны подступов и внешних складов.",
    "visibility": "public",
    "workerPrimaryAttribute": "strength",
    "suitableWorkerTypes": "Все с СИЛ, Все с ЛОВ, Силач, Ловкач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЛОВ": 0.5,
      "Силач": 1,
      "Ловкач": 1
    },
    "templateVersion": 11
  },
  {
    "id": "artillery-platform",
    "name": "Артиллерийская платформа",
    "type": "Военные",
    "primaryDev": "war",
    "icon": "fa-solid fa-bullseye",
    "unlocked": true,
    "description": "Усиленная площадка под пушку, мортиру, баллисту или крупное ружье.",
    "sourceRequirement": "Арсенал или пороховой погреб",
    "sourceRawMaterials": "90 Wood, 40 Stone, 30 Iron",
    "requirements": {
      "food": 0,
      "technology": 3,
      "culture": 0,
      "war": 3
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 3
    },
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Дерево",
        "qty": 90
      },
      {
        "id": "mat-stone",
        "name": "Камень",
        "qty": 40
      },
      {
        "id": "mat-iron",
        "name": "Железо",
        "qty": 30
      }
    ],
    "workersMin": 3,
    "workersMax": 5,
    "workerRole": "Расчет орудия",
    "functions": {
      "production": false,
      "income": false,
      "defense": true,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "defense": {
      "base": 1,
      "perStep": 2,
      "workerStep": 3
    },
    "upkeep": 5,
    "effect": "+1 базовой DR, +2 DR при 3 и 5 членах расчета. Для полноценного огня нужен отряд артиллеристов во вкладке Оборона.",
    "notes": "Дает сильную DR, но не заменяет артиллерийскую команду.",
    "visibility": "public",
    "workerPrimaryAttribute": "wits",
    "suitableWorkerTypes": "Все с РАЗ, Все с СИЛ, Умелец, Силач",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с СИЛ": 0.5,
      "Умелец": 1,
      "Силач": 1
    },
    "templateVersion": 11
  }
];
