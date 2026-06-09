export const BUILDING_TEMPLATES_TECHNOLOGY = [
  {
    "id": "lumbermill",
    "compendiumId": "QMq9l9vvf5ljDu52",
    "name": "Лесоповал",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-tree",
    "img": "",
    "unlocked": true,
    "description": "Заготовка древесины.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 12,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Силач, Механик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Силач": 1,
      "Механик": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Древесина",
        "mode": "Древесина",
        "source": "workers",
        "period": "qd",
        "resourceId": "wood",
        "resource": "Wood",
        "outputQty": 2,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "effect": "Каждый работник производит Wood за Quarter Day.",
    "notes": "Каждый работник производит Wood за Quarter Day.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "quarry",
    "compendiumId": "QQIw0miIcc7885qZ",
    "name": "Каменоломня",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-cubes-stacked",
    "img": "",
    "unlocked": true,
    "description": "Добыча камня для строительства.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 12,
    "suitableWorkerTypes": "Все с СИЛ, Силач, Строитель",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Силач": 1,
      "Строитель": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Камень",
        "mode": "Камень",
        "source": "workers",
        "period": "qd",
        "resourceId": "stone",
        "resource": "Stone",
        "outputQty": 2,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "effect": "Каждый работник производит Stone за Quarter Day.",
    "notes": "Каждый работник производит Stone за Quarter Day.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "mine",
    "compendiumId": "EhcqfI6CS3CXMZzt",
    "name": "Шахта",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-mountain",
    "img": "",
    "unlocked": true,
    "description": "Добыча железной руды. Опасно, но выгодно.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "60 Wood",
    "specialRequirements": "Требуется строитель с Builder. Риск обвала оставлен как событие.",
    "requirements": {
      "food": 0,
      "technology": 8,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 4,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": -2,
    "buildTarget": 6,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 60
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 2,
    "workersMax": 12,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Силач, Механик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Силач": 1,
      "Механик": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Железная руда",
        "mode": "Железная руда",
        "source": "workers",
        "period": "qd",
        "resourceId": "iron-ore",
        "resource": "Iron Ore",
        "outputQty": 2,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Каждый шахтер производит Iron Ore за Quarter Day.",
    "notes": "Каждый шахтер производит Iron Ore за Quarter Day.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "forge",
    "compendiumId": "0D9Ze0Y61oDDMrzb",
    "name": "Кузня",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-hammer",
    "img": "",
    "unlocked": true,
    "description": "Переработка руды и основа металлообработки.",
    "sourceRequirement": "the BUILDER talent",
    "sourceRawMaterials": "60 Iron and 400 Stone",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 0,
      "technology": 10,
      "culture": 0,
      "war": 3
    },
    "bonuses": {
      "food": 0,
      "technology": 7,
      "culture": 0,
      "war": 2
    },
    "buildDifficulty": -2,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-iron",
        "name": "Iron",
        "resourceId": "iron",
        "qty": 60
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 400
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 6,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Механик, Силач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Механик": 1,
      "Силач": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Железо",
        "mode": "Железо",
        "source": "workers",
        "period": "qd",
        "resourceId": "iron",
        "resource": "Iron",
        "outputQty": 12,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Iron Ore 12",
        "costsText": "Iron Ore 12",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 3,
    "effect": "Iron Ore превращается в Iron.",
    "notes": "Iron Ore превращается в Iron.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "tannery",
    "compendiumId": "2enb2fCdJdkX9lSS",
    "name": "Кожевенная мастерская",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-boot",
    "img": "",
    "unlocked": true,
    "description": "Выделка шкур в кожу.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 3,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 0
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
        "qty": 100
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЛОВ, Все с РАЗ, Ремесленник, Умелец",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с РАЗ": 0.5,
      "Ремесленник": 1,
      "Умелец": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Кожа",
        "mode": "Кожа",
        "source": "workers",
        "period": "qd",
        "resourceId": "leather",
        "resource": "Leather",
        "outputQty": 12,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Pelt 12",
        "costsText": "Pelt 12",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "effect": "Pelt превращается в Leather.",
    "notes": "Pelt превращается в Leather.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "agility"
  },
  {
    "id": "tailor-shop",
    "compendiumId": "Fl3bTBAoc0QfFyyv",
    "name": "Ателье",
    "type": "Производство",
    "primaryDev": "technology",
    "icon": "fa-solid fa-shirt",
    "img": "",
    "unlocked": true,
    "description": "Ткачество и пошив одежды.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 0,
      "technology": 5,
      "culture": 3,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 2,
      "war": 0
    },
    "buildDifficulty": -1,
    "buildTarget": 2,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 100
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЛОВ, Все с РАЗ, Ремесленник, Умелец",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с РАЗ": 0.5,
      "Ремесленник": 1,
      "Умелец": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Сукно",
        "mode": "Сукно",
        "source": "workers",
        "period": "qd",
        "resourceId": "cloth-wool",
        "resource": "Cloth, Wool",
        "outputQty": 12,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Wool 12",
        "costsText": "Wool 12",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
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
    "effect": "Wool превращается в Cloth, Wool. Бонус к Crafting одежды.",
    "notes": "Wool превращается в Cloth, Wool. Бонус к Crafting одежды.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "agility"
  },
  {
    "id": "vault",
    "compendiumId": "KKbXurGl409qyLAd",
    "name": "Хранилище",
    "type": "Складские",
    "primaryDev": "technology",
    "icon": "fa-solid fa-vault",
    "img": "",
    "unlocked": true,
    "description": "Защищенный склад для ценностей.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "200 Stone, 100 Wood, 10 Iron",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 0,
      "technology": 10,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 4,
      "culture": 0,
      "war": 1
    },
    "buildDifficulty": -2,
    "buildTarget": 4,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 200
      },
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 100
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
    "workersMax": 1,
    "suitableWorkerTypes": "Все с РАЗ, Все с ЭМП, Управленец, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с ЭМП": 0.5,
      "Управленец": 1,
      "Переговорщик": 1
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
      "capacity": 800,
      "security": 5,
      "quality": 3
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 1,
    "effect": "Ценности хранятся за железной дверью.",
    "notes": "Ценности хранятся за железной дверью.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "stables",
    "compendiumId": "1UBu2Z0I7W9YPdmX",
    "name": "Конюшня",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-horse",
    "img": "",
    "unlocked": true,
    "description": "Защита и содержание ездовых животных.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "400 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 6,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 3,
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
        "qty": 400
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЭМП, Все с ЛОВ, Переговорщик, Ловкач",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с ЛОВ": 0.5,
      "Переговорщик": 1,
      "Ловкач": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
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
    "effect": "Protects and feeds riding animals.",
    "notes": "Protects and feeds riding animals.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "construction-center",
    "compendiumId": "TfA3XW0W29Om9at4",
    "name": "Центр Строительства",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-person-digging",
    "img": "",
    "unlocked": true,
    "description": "Организует крупные проекты и сложное строительство.",
    "sourceRequirement": "Builder у жителя, 10 workers",
    "sourceRawMaterials": "150 Wood",
    "specialRequirements": "Требуется житель с Builder и 10 работников.",
    "requirements": {
      "food": 0,
      "technology": 8,
      "culture": 4,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 7,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": -2,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 150
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 10,
    "suitableWorkerTypes": "Все с СИЛ, Все с РАЗ, Строитель, Механик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с РАЗ": 0.5,
      "Строитель": 1,
      "Механик": 1
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
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Открывает сложные строительные проекты и усиливает строительную организацию.",
    "notes": "Открывает сложные строительные проекты и усиливает строительную организацию.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "personnel-office",
    "compendiumId": "PRldqU7L83qKA3WX",
    "name": "Управление кадров",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-clipboard-list",
    "img": "",
    "unlocked": true,
    "description": "Учет работников и снижение расходов на рабочую силу.",
    "sourceRequirement": "5 suitable workers",
    "sourceRawMaterials": "200 Wood",
    "specialRequirements": "Требуется 5 подходящих работников.",
    "requirements": {
      "food": 0,
      "technology": 10,
      "culture": 8,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 4,
      "culture": 2,
      "war": 0
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
    "workersMin": 5,
    "workersMax": 8,
    "suitableWorkerTypes": "Все с ЭМП, Все с РАЗ, Переговорщик, Управленец",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с РАЗ": 0.5,
      "Переговорщик": 1,
      "Управленец": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": true,
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
    "effect": "Уменьшает оплату рабочей силы на 10%.",
    "notes": "Уменьшает оплату рабочей силы на 10%.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "pier",
    "compendiumId": "ZlIOZIPDz5o84Bxv",
    "name": "Пирс",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-anchor",
    "img": "",
    "unlocked": true,
    "description": "Позволяет принимать корабли и грузы.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "Нужен берег, портовая площадка или подходящее место.",
    "requirements": {
      "food": 0,
      "technology": 4,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 3,
      "culture": 1,
      "war": 0
    },
    "buildDifficulty": -1,
    "buildTarget": 3,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 100
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЛОВ, Все с СИЛ, Ловкач, Силач",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с СИЛ": 0.5,
      "Ловкач": 1,
      "Силач": 1
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
    "effect": "Позволяет принимать корабли на базе.",
    "notes": "Позволяет принимать корабли на базе.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "lighthouse",
    "compendiumId": "lC8EF6GgNp2e5ATS",
    "name": "Маяк",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-tower-broadcast",
    "img": "",
    "unlocked": true,
    "description": "Навигационный ориентир и знак присутствия.",
    "sourceRequirement": "1 worker, 3 silver/week fuel",
    "sourceRawMaterials": "-",
    "specialRequirements": "Требует Пирс или иной морской доступ. Содержание топлива: 3 Silver/неделю.",
    "requirements": {
      "food": 0,
      "technology": 12,
      "culture": 6,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 4,
      "culture": 2,
      "war": 0
    },
    "buildDifficulty": -2,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [
      "pier"
    ],
    "workersMin": 1,
    "workersMax": 3,
    "suitableWorkerTypes": "Все с РАЗ, Умелец",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
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
    "upkeep": 3,
    "effect": "Маяк. Функция ясна: навигация и морская безопасность.",
    "notes": "Маяк. Функция ясна: навигация и морская безопасность.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "dovecote",
    "compendiumId": "61t4iFt7lUEtqb4x",
    "name": "Голубятня",
    "type": "Инфраструктура",
    "primaryDev": "technology",
    "icon": "fa-solid fa-dove",
    "img": "",
    "unlocked": true,
    "description": "Быстрая связь с владением через почтовых голубей.",
    "sourceRequirement": "Successful Animal Handling roll",
    "sourceRawMaterials": "30 Wood",
    "specialRequirements": "Требуется успешная проверка Animal Handling для поимки и приручения голубей.",
    "requirements": {
      "food": 0,
      "technology": 5,
      "culture": 4,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 2,
      "war": 0
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
        "qty": 30
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с ЛОВ, Все с ЭМП, Посыльный, Переговорщик",
    "workerTypeEffects": {
      "Все с ЛОВ": 0.5,
      "Все с ЭМП": 0.5,
      "Посыльный": 1,
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
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Позволяет выпускать голубей, которые летят домой в Голубятню.",
    "notes": "Позволяет выпускать голубей, которые летят домой в Голубятню.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "agility"
  },
  {
    "id": "warehouse",
    "compendiumId": "",
    "name": "Склад",
    "type": "Складские",
    "primaryDev": "technology",
    "icon": "fa-solid fa-warehouse",
    "img": "",
    "unlocked": true,
    "description": "Универсальное складское помещение для материалов и товаров.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 2,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 3,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 4,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 160
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 60
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
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
      "capacity": 1000,
      "security": 2,
      "quality": 2
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Универсальное складское помещение для материалов и товаров.",
    "notes": "Универсальное складское помещение для материалов и товаров.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  }
];
