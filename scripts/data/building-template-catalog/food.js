import { applyEconomicTemplateCalibration } from "../building-template-economy-calibration.js";

export const BUILDING_TEMPLATES_FOOD = applyEconomicTemplateCalibration([
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
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "agriculture": {
      "schemaVersion": 1,
      "enabled": true,
      "kind": "field",
      "activeCropId": "grain",
      "outputRoomId": "outdoors",
      "gmPriority": 500,
      "operations": {
        "sow": true,
        "harvest": true
      },
      "crops": [
        {
          "id": "grain",
          "label": "Зерно",
          "resourceId": "grain",
          "outputQty": 20,
          "sowingSeasons": ["spring"],
          "sowingWorkQd": 8,
          "growingQd": 480,
          "harvestWorkQd": 20,
          "expiryRule": "qd",
          "readyExpiryQd": 120
        }
      ],
      "state": {
        "version": 1,
        "phase": "empty"
      }
    },
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
    "effect": "Посев требует сезонного труда, рост идёт по календарю, готовый Grain остаётся на поле до постепенного сбора.",
    "notes": "Семена абстрактны; незавершённый посев после допустимого сезона не создаёт урожай.",
    "templateVersion": 11,
    "visibility": "public",
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
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "productionLines": [],
    "agriculture": {
      "schemaVersion": 1,
      "enabled": true,
      "kind": "garden",
      "activeCropId": "vegetables",
      "outputRoomId": "outdoors",
      "gmPriority": 500,
      "operations": {
        "sow": true,
        "harvest": true
      },
      "crops": [
        {
          "id": "vegetables",
          "label": "Овощи",
          "resourceId": "vegetables",
          "outputQty": 20,
          "sowingSeasons": ["spring", "summer"],
          "sowingWorkQd": 4,
          "growingQd": 120,
          "harvestWorkQd": 10,
          "expiryRule": "qd",
          "readyExpiryQd": 80
        },
        {
          "id": "herbs",
          "label": "Травы",
          "resourceId": "herbs",
          "outputQty": 10,
          "sowingSeasons": ["spring", "summer"],
          "sowingWorkQd": 4,
          "growingQd": 80,
          "harvestWorkQd": 10,
          "expiryRule": "season-end",
          "readyExpiryQd": 0
        }
      ],
      "state": {
        "version": 1,
        "phase": "empty"
      }
    },
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
    "effect": "Весной и летом можно посеять Vegetables или Herbs; урожай растёт по календарю и остаётся на участке до сбора.",
    "notes": "Семена абстрактны. Срок готового урожая и правило гибели настраиваются отдельно для каждой культуры.",
    "templateVersion": 11,
    "visibility": "public",
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
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "livestock": {
      "enabled": true,
      "speciesId": "cattle",
      "outputRoomId": "outdoors",
      "state": {
        "adults": 0,
        "breedingMales": 0,
        "young": [],
        "woolReady": 0,
        "lastBirthSeasonKey": ""
      },
      "operations": {
        "milk": true,
        "shearQty": 0,
        "slaughterQty": 0,
        "slaughterBreedingMales": 0,
        "feedPriority": "adults"
      }
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
    "effect": "До 12 коров. В пастбищные сезоны корм бесплатен, зимой нужен Animal Feed. Milk требует ежедневных рабочих QD; приплод рассчитывается один раз весной; забой задаётся явно.",
    "notes": "Каждое пастбище содержит отдельное стадо; животные не хранятся под открытым небом.",
    "templateVersion": 12,
    "visibility": "public",
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
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "livestock": {
      "enabled": true,
      "speciesId": "pigs",
      "outputRoomId": "outdoors",
      "state": {
        "adults": 0,
        "breedingMales": 0,
        "young": [],
        "woolReady": 0,
        "lastBirthSeasonKey": ""
      },
      "operations": {
        "milk": false,
        "shearQty": 0,
        "slaughterQty": 0,
        "slaughterBreedingMales": 0,
        "feedPriority": "adults"
      }
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
    "effect": "До 12 свиней. Animal Feed нужен круглый год; приплод рассчитывается один раз весной; забой целых взрослых задаётся явно.",
    "notes": "Каждый свинарник содержит отдельное стадо; при нехватке корма животные не производят и не размножаются, но не умирают автоматически.",
    "templateVersion": 12,
    "visibility": "public",
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
    "workerRole": "",
    "functions": {
      "production": true,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": false
    },
    "livestock": {
      "enabled": true,
      "speciesId": "sheep",
      "outputRoomId": "outdoors",
      "state": {
        "adults": 0,
        "breedingMales": 0,
        "young": [],
        "woolReady": 0,
        "lastBirthSeasonKey": ""
      },
      "operations": {
        "milk": false,
        "shearQty": 0,
        "slaughterQty": 0,
        "slaughterBreedingMales": 0,
        "feedPriority": "adults"
      }
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
    "effect": "До 12 овец. В пастбищные сезоны корм бесплатен, зимой нужен Animal Feed. Готовность Wool возникает один раз в сезон; приплод и забой рассчитываются явно.",
    "notes": "Каждая овчарня содержит отдельное стадо; неостриженная готовность сохраняется, но не накапливается выше числа взрослых.",
    "templateVersion": 12,
    "visibility": "public",
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
      "quality": 4,
      "shelfLifeMultiplier": 2
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Еда хранится значительно дольше. В менеджере это склад с высоким качеством хранения.",
    "notes": "Еда хранится значительно дольше. В менеджере это склад с высоким качеством хранения.",
    "templateVersion": 11,
    "visibility": "public",
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
  }
]);
