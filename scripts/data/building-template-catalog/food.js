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
        "cadence": "tenday",
        "cadenceEvery": 1,
        "resourceId": "grain",
        "resource": "Grain",
        "outputQty": 40,
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "formula": "40*@eff",
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "daylightCollectionOnly": true,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "seasons": {
          "spring": false,
          "summer": true,
          "autumn": false,
          "winter": false
        }
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
    "effect": "Во второй половине Зарости поле каждые десять дней даёт 40 мешков зерна на эффективного работника. Сбор требует 2 QD и переносится с теньдня на светлый день.",
    "notes": "Урожайное окно: Зноерост и Зноеход. Вне этого окна зерно не создаётся; назначенные работники определяют объём урожая и выполняют сбор.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "garden",
    "compendiumId": "8gvZgN6Av4xVjoYg",
    "name": "Сад и огород",
    "type": "Производство",
    "primaryDev": "food",
    "icon": "fa-solid fa-seedling",
    "img": "",
    "unlocked": true,
    "description": "Смешанное хозяйство с овощными грядками, плодовыми деревьями и лекарственными травами.",
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
        "source": "time",
        "cadence": "tenday",
        "cadenceEvery": 1,
        "resourceId": "vegetables",
        "resource": "Vegetables",
        "outputQty": 12,
        "formula": "12*@eff",
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "daylightCollectionOnly": true,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "seasons": {
          "spring": true,
          "summer": true,
          "autumn": false,
          "winter": false
        }
      },
      {
        "id": "line-2",
        "active": true,
        "name": "Фрукты",
        "mode": "Фрукты",
        "source": "time",
        "cadence": "tenday",
        "cadenceEvery": 1,
        "resourceId": "fruits",
        "resource": "Fruits",
        "outputQty": 8,
        "formula": "8*@eff",
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "daylightCollectionOnly": true,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "seasons": {
          "spring": false,
          "summer": true,
          "autumn": false,
          "winter": false
        }
      },
      {
        "id": "line-3",
        "active": true,
        "name": "Травы",
        "mode": "Травы",
        "source": "time",
        "cadence": "tenday",
        "cadenceEvery": 1,
        "resourceId": "herbs",
        "resource": "Herbs",
        "outputQty": 3,
        "formula": "3*@eff",
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "daylightCollectionOnly": true,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "seasons": {
          "spring": true,
          "summer": true,
          "autumn": false,
          "winter": false
        }
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
    "effect": "Смешанное хозяйство даёт Vegetables, Fruits и Herbs только в Зарость; в Ухудно сад не производит урожай.",
    "notes": "Овощи и травы доступны в обе половины Зарости, фрукты — во второй половине Зарости. Каждая линия требует 2 QD сбора и переносится с теньдня.",
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
    "contents": [
      {
        "id": "cows",
        "name": "Коровы",
        "resourceId": "cattle",
        "qty": 0,
        "capacity": 12,
        "notes": "Коровы поступают со склада. Их количество сразу меняет выпуск молока."
      }
    ],
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Молоко",
        "mode": "Молоко",
        "source": "content",
        "contentId": "cows",
        "contentUnitsPerBatch": 12,
        "cadence": "day",
        "cadenceEvery": 1,
        "resourceId": "milk",
        "resource": "Milk",
        "outputQty": 2,
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building"
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
    "effect": "Полное стадо из двенадцати коров даёт 2 партии Milk в день; сбор требует 2 рабочих QD, а обычный корм обеспечивает выпас.",
    "notes": "Коровы задаются в «Содержимом здания». Выпуск начинается при полной когорте из 12 голов; право выпаса входит в работу пастбища, поэтому Grain не является обязательным входом.",
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
    "contents": [
      {
        "id": "pigs",
        "name": "Свиньи",
        "resourceId": "pigs",
        "qty": 0,
        "capacity": 12,
        "notes": "Свиньи поступают со склада. Их количество прямо меняет усреднённый выход мяса."
      }
    ],
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Мясо со свиней",
        "mode": "Мясо со свиней",
        "source": "content",
        "contentId": "pigs",
        "contentUnitsPerBatch": 12,
        "cadence": "tenday",
        "cadenceEvery": 1,
        "resourceId": "meat",
        "resource": "Meat",
        "outputQty": 11,
        "formula": "",
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "Grain 2",
        "costsText": "Grain 2",
        "requiresCollection": true,
        "collectQd": 2,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building"
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
    "effect": "Стадо из двенадцати свиней раз в десятник даёт в среднем 11 партий Meat, расходуя 2 мешка Grain; разделка требует 2 QD.",
    "notes": "Свиньи задаются в «Содержимом здания». Выпуск начинается при полной когорте из 12 голов; линия описывает устойчивую выбраковку и восстановление стада.",
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
    "description": "Стадо до двенадцати овец даёт годовой настриг; осенняя выбраковка приносит мясо и шкуры.",
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
    "workersMin": 0,
    "workersMax": 4,
    "suitableWorkerTypes": "Все с ЭМП, Все с СИЛ, Переговорщик, Силач",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с СИЛ": 0.5,
      "Переговорщик": 1,
      "Силач": 1
    },
    "workerRole": "Овчар",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "contents": [
      {
        "id": "sheep",
        "name": "Овцы",
        "resourceId": "sheep",
        "qty": 0,
        "capacity": 12,
        "notes": "Овцы поступают со склада. Количество масштабирует настриг и устойчивую выбраковку."
      }
    ],
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Шерсть",
        "mode": "Шерсть",
        "source": "content",
        "contentId": "sheep",
        "contentUnitsPerBatch": 12,
        "cadence": "year",
        "cadenceEvery": 1,
        "resourceId": "wool",
        "resource": "Wool",
        "outputQty": 36,
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 2,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "daylightProductionOnly": true,
        "seasons": {
          "spring": true,
          "summer": false,
          "autumn": false,
          "winter": false
        }
      },
      {
        "id": "line-cull-meat",
        "active": true,
        "name": "Осенняя выбраковка: мясо",
        "mode": "Выбраковка стада",
        "source": "content",
        "contentId": "sheep",
        "contentUnitsPerBatch": 12,
        "cadence": "year",
        "cadenceEvery": 1,
        "resourceId": "meat",
        "resource": "Meat",
        "outputQty": 48,
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "Grain 6",
        "costsText": "Grain 6",
        "requiresCollection": true,
        "collectQd": 1,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "daylightProductionOnly": true,
        "seasons": {
          "spring": false,
          "summer": false,
          "autumn": true,
          "winter": false
        }
      },
      {
        "id": "line-cull-pelt",
        "active": true,
        "name": "Осенняя выбраковка: шкуры",
        "mode": "Выбраковка стада",
        "source": "content",
        "contentId": "sheep",
        "contentUnitsPerBatch": 12,
        "cadence": "year",
        "cadenceEvery": 1,
        "resourceId": "pelt",
        "resource": "Pelt",
        "outputQty": 6,
        "laborQdPerBatch": 0,
        "maxBatchesPerCadence": 1,
        "expenseMode": "cycle",
        "expenses": "",
        "costsText": "",
        "requiresCollection": true,
        "collectQd": 1,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "building",
        "daylightProductionOnly": true,
        "seasons": {
          "spring": false,
          "summer": false,
          "autumn": true,
          "winter": false
        }
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
    "effect": "Двенадцать овец дают весной 36 Wool; осенняя выбраковка даёт 48 Meat и 6 Pelt. Сбор и разделка требуют суммарно 4 QD и 6 Grain.",
    "notes": "Овцы задаются в «Содержимом здания». Все три линии работают при полной когорте из 12 голов; работника можно назначать сезонно.",
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
        "cadence": "qd",
        "cadenceEvery": 1,
        "resourceId": "flour",
        "resource": "Flour",
        "outputQty": 10,
        "laborQdPerBatch": 1,
        "maxBatchesPerCadence": 0,
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
    "effect": "12 малых мешков зерна дают 10 малых мешков муки за 1 рабочий QD; разница отражает отруби, примеси и технологические потери.",
    "notes": "Выход муки составляет около 83% массы зерна. Побочные продукты пока не материализуются отдельным ресурсом.",
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
        "cadence": "qd",
        "cadenceEvery": 1,
        "resourceId": "bread",
        "resource": "Bread",
        "outputQty": 24,
        "laborQdPerBatch": 2,
        "maxBatchesPerCadence": 0,
        "expenseMode": "cycle",
        "expenses": "Flour 20, Горючее 1",
        "costsText": "Flour 20, Горючее 1",
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
    "effect": "20 малых мешков муки и 1 партия горючего дают 24 свёртка хлеба за 2 рабочих QD.",
    "notes": "Вода считается доступной хозяйственной частью процесса; топливо списывается явно. Пищевая ценность выхода не превышает пищевую ценность муки.",
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
