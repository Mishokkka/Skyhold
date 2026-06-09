export const BUILDING_TEMPLATES_FOOD = [
  {
    "id": "well",
    "compendiumId": "jua1yTNmTQf6Sb7z",
    "name": "Колодец",
    "type": "Инфраструктура",
    "primaryDev": "food",
    "icon": "fa-solid fa-water",
    "img": "",
    "unlocked": true,
    "description": "Дает надежный доступ к воде и открывает санитарные постройки.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "50 Stone",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 2,
      "technology": 1,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 2,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 50
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с СИЛ, Силач",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Силач": 1
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
    "moraleDelta": 1,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Everyone in the stronghold has free access to water. Зависимость для Бани.",
    "notes": "Everyone in the stronghold has free access to water. Зависимость для Бани.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "grain-field",
    "compendiumId": "3u0Z6d4TRX42SHq1",
    "name": "Поле зерна",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-wheat-awn",
    "img": "",
    "unlocked": true,
    "description": "Пашня, дающая массовый урожай зерна.",
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
      "food": 4,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": -1,
    "buildTarget": 4,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 8,
    "suitableWorkerTypes": "Все с СИЛ, Все с ЭМП, Силач, Переговорщик",
    "workerTypeEffects": {
      "Все с СИЛ": 0.5,
      "Все с ЭМП": 0.5,
      "Силач": 1,
      "Переговорщик": 1
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
        "name": "Зерно",
        "mode": "Зерно",
        "source": "time",
        "period": "tenday",
        "resourceId": "grain",
        "resource": "Grain",
        "outputQty": 20,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "worker"
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
    "effect": "Осенью можно собрать крупный урожай Grain. В менеджере оформлено как накопление урожая за десятник с ручным сбором.",
    "notes": "Осенью можно собрать крупный урожай Grain. В менеджере оформлено как накопление урожая за десятник с ручным сбором.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "garden",
    "compendiumId": "8gvZgN6Av4xVjoYg",
    "name": "Сад",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-seedling",
    "img": "",
    "unlocked": true,
    "description": "Огород, травы и овощи для стола и лекарского дела.",
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
      "food": 4,
      "technology": 0,
      "culture": 1,
      "war": 0
    },
    "buildDifficulty": -1,
    "buildTarget": 3,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЭМП, Все с РАЗ, Переговорщик, Умелец",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с РАЗ": 0.5,
      "Переговорщик": 1,
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
        "name": "Овощи",
        "mode": "Овощи",
        "source": "workers",
        "period": "day",
        "resourceId": "vegetables",
        "resource": "Vegetables",
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
      },
      {
        "id": "line",
        "active": true,
        "name": "Травы",
        "mode": "Травы",
        "source": "workers",
        "period": "day",
        "resourceId": "herbs",
        "resource": "Herbs",
        "outputQty": 1,
        "workQd": 2,
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
    "effect": "Весной и летом дает Vegetables или Herbs.",
    "notes": "Весной и летом дает Vegetables или Herbs.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "pasture",
    "compendiumId": "V0mykZvGnQ1iJ7P5",
    "name": "Пастбище",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-cow",
    "img": "",
    "unlocked": true,
    "description": "Место для коров: молоко, мясо и приплод.",
    "sourceRequirement": "Up to a dozen cows, bought or stolen separately",
    "sourceRawMaterials": "20 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 4,
      "technology": 1,
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
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЭМП, Все с СИЛ, Переговорщик, Силач",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с СИЛ": 0.5,
      "Переговорщик": 1,
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
        "name": "Молоко",
        "mode": "Молоко",
        "source": "workers",
        "period": "day",
        "resourceId": "milk",
        "resource": "Milk",
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
    "effect": "Коровы дают Milk раз в день. Забой и приплод оставлены как ручная/событийная операция.",
    "notes": "Коровы дают Milk раз в день. Забой и приплод оставлены как ручная/событийная операция.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "pigsty",
    "compendiumId": "jwhOIGSYM6HbM17O",
    "name": "Свинарник",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-piggy-bank",
    "img": "",
    "unlocked": true,
    "description": "Свиньи дают мясо и приплод.",
    "sourceRequirement": "Up to a dozen pigs, bought or stolen separately",
    "sourceRawMaterials": "50 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 2,
      "technology": 0,
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
        "qty": 50
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 3,
    "suitableWorkerTypes": "Все с ЭМП, Все с СИЛ, Переговорщик, Силач",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с СИЛ": 0.5,
      "Переговорщик": 1,
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
        "name": "Мясо со свиней",
        "mode": "Мясо со свиней",
        "source": "workers",
        "period": "tenday",
        "resourceId": "meat",
        "resource": "Meat",
        "outputQty": 2,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "worker"
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
    "effect": "Свиней можно забивать на Meat, приплод идет событием раз в год.",
    "notes": "Свиней можно забивать на Meat, приплод идет событием раз в год.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "sheepfold",
    "compendiumId": "qfOHHggk0UbOA4iC",
    "name": "Овчарня",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-sheep",
    "img": "",
    "unlocked": true,
    "description": "Овцы дают шерсть, мясо и приплод.",
    "sourceRequirement": "Up to a dozen sheep, bought or stolen separately",
    "sourceRawMaterials": "20 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 2,
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
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЭМП, Все с СИЛ, Переговорщик, Силач",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с СИЛ": 0.5,
      "Переговорщик": 1,
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
        "name": "Шерсть",
        "mode": "Шерсть",
        "source": "workers",
        "period": "tenday",
        "resourceId": "wool",
        "resource": "Wool",
        "outputQty": 4,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "worker"
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
    "effect": "Стрижка дает Wool, забой дает Meat, приплод идет событием.",
    "notes": "Стрижка дает Wool, забой дает Meat, приплод идет событием.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "mill",
    "compendiumId": "r5ulf3PnezgJGGzt",
    "name": "Мельница",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-fan",
    "img": "",
    "unlocked": true,
    "description": "Перемалывает зерно в муку.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "400 Wood, 10 Stone",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 6,
      "technology": 5,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 4,
      "technology": 3,
      "culture": 0,
      "war": 0
    },
    "buildDifficulty": -1,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 400
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 10
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с РАЗ, Все с СИЛ, Умелец, Механик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с СИЛ": 0.5,
      "Умелец": 1,
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
        "name": "Мука",
        "mode": "Мука",
        "source": "workers",
        "period": "qd",
        "resourceId": "flour",
        "resource": "Flour",
        "outputQty": 12,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Grain 12",
        "costsText": "Grain 12",
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
    "effect": "Grain превращается в Flour по Quarter Day.",
    "notes": "Grain превращается в Flour по Quarter Day.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "bakery",
    "compendiumId": "MM6XpW90ZYVSv9Hj",
    "name": "Пекарня",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-bread-slice",
    "img": "",
    "unlocked": true,
    "description": "Печь для хлеба и сухарей.",
    "sourceRequirement": "the BUILDER talent",
    "sourceRawMaterials": "200 Stone, 40 Wood",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 8,
      "technology": 5,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 4,
      "technology": 0,
      "culture": 1,
      "war": 0
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
        "qty": 200
      },
      {
        "id": "mat-wood",
        "name": "Wood",
        "resourceId": "wood",
        "qty": 40
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 3,
    "suitableWorkerTypes": "Все с ЭМП, Все с РАЗ, Переговорщик, Умелец",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с РАЗ": 0.5,
      "Переговорщик": 1,
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
        "name": "Хлеб",
        "mode": "Хлеб",
        "source": "workers",
        "period": "qd",
        "resourceId": "bread",
        "resource": "Bread",
        "outputQty": 12,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Flour 12",
        "costsText": "Flour 12",
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
    "effect": "Flour превращается в Bread/Food.",
    "notes": "Flour превращается в Bread/Food.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "root-cellar",
    "compendiumId": "lt2Pb1z96vYs3qaZ",
    "name": "Погреб",
    "type": "Складские",
    "primaryDev": "food",
    "icon": "fa-solid fa-boxes-stacked",
    "img": "",
    "unlocked": true,
    "description": "Подземное хранение еды.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "200 Stone",
    "specialRequirements": "Требуется строитель с Builder.",
    "requirements": {
      "food": 5,
      "technology": 5,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 2,
      "technology": 2,
      "culture": 0,
      "war": 0
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
        "qty": 200
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с РАЗ, Все с СИЛ, Умелец, Силач",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с СИЛ": 0.5,
      "Умелец": 1,
      "Силач": 1
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
      "capacity": 400,
      "security": 1,
      "quality": 4
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Еда хранится значительно дольше. В менеджере это склад с высоким качеством хранения.",
    "notes": "Еда хранится значительно дольше. В менеджере это склад с высоким качеством хранения.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "barn",
    "compendiumId": "",
    "name": "Амбар",
    "type": "Складские",
    "primaryDev": "food",
    "icon": "fa-solid fa-wheat-awn",
    "img": "",
    "unlocked": true,
    "description": "Сухой склад для зерна, еды и хозяйственных припасов.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 3,
      "technology": 1,
      "culture": 0,
      "war": 0
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
        "qty": 100
      },
      {
        "id": "mat-straw",
        "name": "Straw",
        "resourceId": "straw",
        "qty": 30
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
      "capacity": 600,
      "security": 1,
      "quality": 3
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Сухой склад для зерна, еды и хозяйственных припасов.",
    "notes": "Сухой склад для зерна, еды и хозяйственных припасов.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  }
];
