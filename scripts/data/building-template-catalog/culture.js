export const BUILDING_TEMPLATES_CULTURE = [
  {
    "id": "inn",
    "compendiumId": "FufZdMqsTvhjYJxY",
    "name": "Трактир",
    "type": "Жилые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-beer-mug-empty",
    "img": "",
    "unlocked": true,
    "description": "Постоялый двор, еда, слухи и малый доход.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "250 Wood or 500 Stone",
    "specialRequirements": "Можно строить из 500 Stone вместо 250 Wood.",
    "requirements": {
      "food": 8,
      "technology": 0,
      "culture": 5,
      "war": 0
    },
    "bonuses": {
      "food": 2,
      "technology": 0,
      "culture": 4,
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
        "qty": 250
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 6,
    "suitableWorkerTypes": "Все с ЭМП, Переговорщик",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": true,
      "defense": false,
      "housing": true,
      "storage": false,
      "culture": true
    },
    "productionLines": [
      {
        "id": "line",
        "active": true,
        "name": "Пища из мяса",
        "mode": "Пища из мяса",
        "source": "workers",
        "period": "qd",
        "resourceId": "bread",
        "resource": "Bread",
        "outputQty": 6,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Meat 6",
        "costsText": "Meat 6",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      },
      {
        "id": "line",
        "active": true,
        "name": "Пища из овощей",
        "mode": "Пища из овощей",
        "source": "workers",
        "period": "qd",
        "resourceId": "bread",
        "resource": "Bread",
        "outputQty": 6,
        "workQd": 1,
        "expenseMode": "cycle",
        "expenses": "Vegetables 6",
        "costsText": "Vegetables 6",
        "requiresCollection": false,
        "collectQd": 0,
        "pendingQty": 0,
        "storageRoomId": "outdoors",
        "autoCollect": "none"
      }
    ],
    "income": {
      "base": 1,
      "perWorker": 1,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": true,
        "budgetFormula": "2d6*10",
        "maxLotsPerBuyer": 1,
        "roomId": "all",
        "kind": "all",
        "notes": "Покупатели трактирных услуг и мелких товаров."
      }
    },
    "defense": {
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 6,
      "comfort": 1,
      "quality": 1,
      "notes": "Комнаты для гостей и работников."
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": 2,
    "workerMoraleDelta": 0,
    "upkeep": 3,
    "effect": "Meat или Vegetables превращаются в Food.",
    "notes": "Meat или Vegetables превращаются в Food.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "hiring-agency",
    "compendiumId": "tAKfArx6pvy52Jdq",
    "name": "Агентство Найма",
    "type": "Инфраструктура",
    "primaryDev": "culture",
    "icon": "fa-solid fa-user-plus",
    "img": "",
    "unlocked": true,
    "description": "Привлекает новых работников и профессионалов.",
    "sourceRequirement": "3 suitable workers",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "Требуется 3 подходящих работника.",
    "requirements": {
      "food": 0,
      "technology": 6,
      "culture": 8,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 4,
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
    "workersMin": 3,
    "workersMax": 6,
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
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Раз в месяц предлагает новых работников.",
    "notes": "Раз в месяц предлагает новых работников.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "tent-camp",
    "compendiumId": "a3I5wPcA2kY9IqdS",
    "name": "Палаточный лагерь",
    "type": "Жилые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-campground",
    "img": "",
    "unlocked": true,
    "description": "Временное жилье на 30 жителей. Дешево, плохо, без защиты.",
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
      "technology": 0,
      "culture": -2,
      "war": 0
    },
    "buildDifficulty": 1,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 1,
    "suitableWorkerTypes": "Все с РАЗ, Все с ЭМП, Умелец, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с ЭМП": 0.5,
      "Умелец": 1,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
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
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 30,
      "comfort": -2,
      "quality": 0,
      "notes": "Временное жилье. Нельзя нормально защитить."
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": -1,
    "moraleDelta": -3,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Позволяет расположить до 30 жителей, но снижает довольство.",
    "notes": "Позволяет расположить до 30 жителей, но снижает довольство.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": ""
  },
  {
    "id": "cemetery",
    "compendiumId": "6mRVbENA8oiQe4pw",
    "name": "Кладбище",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-cross",
    "img": "",
    "unlocked": true,
    "description": "Место для похорон и памяти погибших.",
    "sourceRequirement": "Один работник",
    "sourceRawMaterials": "-",
    "specialRequirements": "Требуется один работник.",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 0,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 2,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 2,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с ЭМП, Все с РАЗ, Переговорщик, Умелец",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Все с РАЗ": 0.5,
      "Переговорщик": 1,
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
    "moraleDelta": 1,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Позволяет похоронить умерших согласно верованиям.",
    "notes": "Позволяет похоронить умерших согласно верованиям.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "market",
    "compendiumId": "3jNGpXfwpI7oz4Mk",
    "name": "Рынок",
    "type": "Инфраструктура",
    "primaryDev": "culture",
    "icon": "fa-solid fa-scale-balanced",
    "img": "",
    "unlocked": true,
    "description": "Торговые ряды и место приезжих купцов.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "60 Wood",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 5,
      "culture": 5,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 4,
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
        "qty": 60
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 8,
    "suitableWorkerTypes": "Все с ЭМП, Переговорщик",
    "workerTypeEffects": {
      "Все с ЭМП": 0.5,
      "Переговорщик": 1
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
      "base": 1,
      "perWorker": 1,
      "formula": "",
      "risk": 0,
      "illegal": false,
      "trade": {
        "enabled": true,
        "budgetFormula": "3d6*10",
        "maxLotsPerBuyer": 2,
        "roomId": "all",
        "kind": "all",
        "notes": "Обычная рыночная торговля."
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
    "moraleDelta": 3,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Supply как у обычной деревни. Довольство +3.",
    "notes": "Supply как у обычной деревни. Довольство +3.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "bathhouse",
    "compendiumId": "I1imr0PfejXCJK2J",
    "name": "Баня",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-hot-tub-person",
    "img": "",
    "unlocked": true,
    "description": "Гигиена, отдых и довольство.",
    "sourceRequirement": "Well, BUILDER",
    "sourceRawMaterials": "150 Wood",
    "specialRequirements": "Требуется Колодец и строитель с Builder. Содержание: 2 Silver/день.",
    "requirements": {
      "food": 0,
      "technology": 4,
      "culture": 6,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 4,
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
        "qty": 150
      }
    ],
    "requiredBuildingIds": [
      "well"
    ],
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
    "moraleDelta": 4,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Позволяет пользоваться баней, повышает довольство.",
    "notes": "Позволяет пользоваться баней, повышает довольство.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "library",
    "compendiumId": "UTz1ybELEm3w6wwN",
    "name": "Библиотека",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-book-open",
    "img": "",
    "unlocked": true,
    "description": "Книги, обучение, Lore и накопление знаний.",
    "sourceRequirement": "Sizable collection of books",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "Требуется значительная книжная коллекция.",
    "requirements": {
      "food": 0,
      "technology": 8,
      "culture": 10,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 4,
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
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 2,
    "effect": "Gear Bonus +2 to Lore and открытие знаний за опыт/деньги.",
    "notes": "Gear Bonus +2 to Lore and открытие знаний за опыт/деньги.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "scriptorium",
    "compendiumId": "t7EtPAiObBJHUFud",
    "name": "Скрипторий",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-book-sparkles",
    "img": "",
    "unlocked": true,
    "description": "Чудеса, переписывание знаний и безопасное обучение мистике.",
    "sourceRequirement": "Powerful artifact, book collection, BUILDER",
    "sourceRawMaterials": "100 Wood",
    "specialRequirements": "Требуется артефакт значительной силы, книжная коллекция и Builder.",
    "requirements": {
      "food": 0,
      "technology": 10,
      "culture": 16,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 2,
      "culture": 7,
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
        "qty": 100
      }
    ],
    "requiredBuildingIds": [
      "library"
    ],
    "workersMin": 1,
    "workersMax": 4,
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
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 3,
    "effect": "+2 к изучению чудотворства и чудес. Тяжесть Magic Mishap обучения ниже на 1.",
    "notes": "+2 к изучению чудотворства и чудес. Тяжесть Magic Mishap обучения ниже на 1.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "shrine",
    "compendiumId": "xgZ26MTw0nKAYKKy",
    "name": "Святилище",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-hands-praying",
    "img": "",
    "unlocked": true,
    "description": "Общее место веры и ритуалов.",
    "sourceRequirement": "The BUILDER talent",
    "sourceRawMaterials": "80 Wood or 80 Stone",
    "specialRequirements": "Можно строить из 80 Stone вместо 80 Wood. Требуется Builder.",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 5,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 4,
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
        "qty": 80
      }
    ],
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
    "moraleDelta": 4,
    "workerMoraleDelta": 0,
    "upkeep": 1,
    "effect": "PC получают +1 WP при возвращении из путешествия. Довольство +4.",
    "notes": "PC получают +1 WP при возвращении из путешествия. Довольство +4.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "hall-of-fame",
    "compendiumId": "VMhjAib9MwfLycOb",
    "name": "Зал славы",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-monument",
    "img": "",
    "unlocked": true,
    "description": "Память героев и наследие кампании.",
    "sourceRequirement": "BUILDER, one worker",
    "sourceRawMaterials": "200 Stone, 400 Gold",
    "specialRequirements": "Требуется Builder и один работник.",
    "requirements": {
      "food": 0,
      "technology": 0,
      "culture": 24,
      "war": 12
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 10,
      "war": 3
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
        "qty": 200
      },
      {
        "id": "mat-gold",
        "name": "Gold",
        "resourceId": "gold",
        "qty": 400
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
    "reputation": 2,
    "moraleDelta": 4,
    "workerMoraleDelta": 0,
    "upkeep": 4,
    "effect": "Новые персонажи получают +5 опыта, героически погибшие с Reputation >4 усиливают бонус.",
    "notes": "Новые персонажи получают +5 опыта, героически погибшие с Reputation >4 усиливают бонус.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "spire",
    "compendiumId": "rTPyKyehF7cesqmZ",
    "name": "Шпиль",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-tower-observation",
    "img": "",
    "unlocked": true,
    "description": "Монумент власти, репутации и мифа.",
    "sourceRequirement": "BUILDER",
    "sourceRawMaterials": "150 Stone, 200 Gold",
    "specialRequirements": "Требуется Builder.",
    "requirements": {
      "food": 0,
      "technology": 12,
      "culture": 28,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 0,
      "culture": 10,
      "war": 0
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
        "qty": 150
      },
      {
        "id": "mat-gold",
        "name": "Gold",
        "resourceId": "gold",
        "qty": 200
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с РАЗ, Все с ЭМП, Умелец, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с ЭМП": 0.5,
      "Умелец": 1,
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
    "reputation": 3,
    "moraleDelta": 6,
    "workerMoraleDelta": 0,
    "upkeep": 4,
    "effect": "Репутация +3, довольство +6, бонусный опыт в конце арки.",
    "notes": "Репутация +3, довольство +6, бонусный опыт в конце арки.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "bunkhouse",
    "compendiumId": "",
    "name": "Барак",
    "type": "Жилые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-house-chimney",
    "img": "",
    "unlocked": true,
    "description": "Плотное жилье для рабочих и охраны. Дешево, без особого комфорта.",
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
      "technology": 1,
      "culture": 1,
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
        "qty": 80
      },
      {
        "id": "mat-cloth",
        "name": "Cloth",
        "resourceId": "cloth",
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
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 16,
      "comfort": -1,
      "quality": 1,
      "notes": "Плотное жилье для рабочих и охраны. Дешево, без особого комфорта."
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 0,
    "moraleDelta": -1,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Плотное жилье для рабочих и охраны. Дешево, без особого комфорта.",
    "notes": "Плотное жилье для рабочих и охраны. Дешево, без особого комфорта.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "common-house",
    "compendiumId": "",
    "name": "Общий дом",
    "type": "Жилые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-house-chimney",
    "img": "",
    "unlocked": true,
    "description": "Постоянный дом для нескольких семей или небольшой артели.",
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
      "technology": 1,
      "culture": 3,
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
        "qty": 120
      },
      {
        "id": "mat-stone",
        "name": "Stone",
        "resourceId": "stone",
        "qty": 40
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
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 10,
      "comfort": 1,
      "quality": 2,
      "notes": "Постоянный дом для нескольких семей или небольшой артели."
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
    "effect": "Постоянный дом для нескольких семей или небольшой артели.",
    "notes": "Постоянный дом для нескольких семей или небольшой артели.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "strength"
  },
  {
    "id": "boarding-house",
    "compendiumId": "",
    "name": "Постоялый дом",
    "type": "Жилые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-house-chimney",
    "img": "",
    "unlocked": true,
    "description": "Жилье для гостей, работников и временных специалистов.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "-",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 0,
      "culture": 2,
      "war": 0
    },
    "bonuses": {
      "food": 1,
      "technology": 0,
      "culture": 3,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 5,
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
        "id": "mat-cloth",
        "name": "Cloth",
        "resourceId": "cloth",
        "qty": 30
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
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
      "base": 0,
      "perStep": 0,
      "workerStep": 0
    },
    "housing": {
      "capacity": 18,
      "comfort": 0,
      "quality": 2,
      "notes": "Жилье для гостей, работников и временных специалистов."
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
    "effect": "Увеличивает вместимость жилья и помогает принимать временных работников, гостей и специалистов.",
    "notes": "Увеличивает вместимость жилья и помогает принимать временных работников, гостей и специалистов.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "lazaret",
    "compendiumId": "",
    "name": "Лазарет",
    "type": "Культура",
    "primaryDev": "culture",
    "icon": "fa-solid fa-kit-medical",
    "img": "",
    "unlocked": true,
    "description": "Место для перевязок, ампутаций, ухода за ранеными и карантина.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "40 Wood; 25 Cloth; 10 Herbs",
    "specialRequirements": "",
    "requirements": {
      "food": 0,
      "technology": 2,
      "culture": 3,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 1,
      "culture": 2,
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
        "qty": 40
      },
      {
        "id": "mat-cloth",
        "name": "Cloth",
        "resourceId": "cloth",
        "qty": 25
      },
      {
        "id": "mat-herbs",
        "name": "Herbs",
        "resourceId": "herbs",
        "qty": 10
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 1,
    "workersMax": 3,
    "suitableWorkerTypes": "Все с РАЗ, Все с ЭМП, Умелец, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с ЭМП": 0.5,
      "Умелец": 1,
      "Переговорщик": 1
    },
    "workerRole": "Лекарь",
    "special": {
      "kind": "medical"
    },
    "medical": {
      "enabled": true,
      "patientsPerEfficiency": 5,
      "maxPatients": 15
    },
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
      "notes": "Пациенты распределяются автоматически через лечебный блок лазарета."
    },
    "storage": {
      "capacity": 0,
      "security": 0,
      "quality": 0
    },
    "reputation": 1,
    "moraleDelta": 1,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Лечебная поддержка: снижает смертность защитников после боя и ускоряет возвращение раненых решением ГМа.",
    "notes": "В Mass Combat считается медицинской поддержкой. Больше лекарей и лечебных зданий уменьшают шанс смерти и переводят часть смертей в ранения.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "empathy"
  },
  {
    "id": "apothecary",
    "compendiumId": "",
    "name": "Аптекарская",
    "type": "Культура",
    "primaryDev": "culture",
    "icon": "fa-solid fa-mortar-pestle",
    "img": "",
    "unlocked": true,
    "description": "Травы, настойки, обезболивающие, мази и учет медицинских запасов.",
    "sourceRequirement": "-",
    "sourceRawMaterials": "30 Wood; 10 Glass; 20 Herbs",
    "specialRequirements": "",
    "requirements": {
      "food": 2,
      "technology": 3,
      "culture": 3,
      "war": 0
    },
    "bonuses": {
      "food": 1,
      "technology": 1,
      "culture": 1,
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
        "qty": 30
      },
      {
        "id": "mat-glass",
        "name": "Glass",
        "resourceId": "glass",
        "qty": 10
      },
      {
        "id": "mat-herbs",
        "name": "Herbs",
        "resourceId": "herbs",
        "qty": 20
      }
    ],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 2,
    "suitableWorkerTypes": "Все с РАЗ, Все с ЭМП, Умелец, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Все с ЭМП": 0.5,
      "Умелец": 1,
      "Переговорщик": 1
    },
    "workerRole": "",
    "functions": {
      "production": true,
      "income": true,
      "defense": false,
      "housing": false,
      "storage": true,
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
      "capacity": 80,
      "security": 2,
      "quality": 2
    },
    "reputation": 1,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Медицинская поддержка и доход от лекарств. При наличии трав снижает риск смерти раненых после защиты поселения.",
    "notes": "В Mass Combat считается медицинской поддержкой. Подходит для аптекарей, лекарей и травников.",
    "templateVersion": 11,
    "visibility": "public",
    "workerPrimaryAttribute": "wits"
  },
  {
    "id": "school",
    "name": "Школа",
    "type": "Культурные",
    "primaryDev": "culture",
    "icon": "fa-solid fa-book-open-reader",
    "img": "",
    "unlocked": true,
    "description": "Учебная комната, доски, буквари и взрослый учитель. Помогает детям расти не просто лишними ртами.",
    "sourceRequirement": "Культура 2, Технология 1",
    "sourceRawMaterials": "45 Wood, 15 Stone, 5 Parchment",
    "specialRequirements": "Нужен хотя бы один взрослый работник-учитель.",
    "requirements": {
      "food": 0,
      "technology": 1,
      "culture": 2,
      "war": 0
    },
    "bonuses": {
      "food": 0,
      "technology": 1,
      "culture": 2,
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 5,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [
      {
        "id": "mat-wood",
        "name": "Дерево",
        "resourceId": "wood",
        "qty": 45
      },
      {
        "id": "mat-stone",
        "name": "Камень",
        "resourceId": "stone",
        "qty": 15
      },
      {
        "id": "mat-parchment",
        "name": "Пергамент",
        "resourceId": "parchment",
        "qty": 5
      }
    ],
    "workersMin": 1,
    "workersMax": 3,
    "workerRole": "Учитель",
    "functions": {
      "production": false,
      "income": false,
      "defense": false,
      "housing": false,
      "storage": false,
      "culture": true
    },
    "upkeep": 3,
    "reputation": 1,
    "moraleDelta": 1,
    "effect": "Если в школе назначен взрослый учитель, дети получают шанс развития при прохождении первой трети детства, второй трети детства и выхода из детского возраста.",
    "notes": "Механика работает при годовом старении: шанс небольшой, но может дать +1 к характеристике и положительную черту.",
    "visibility": "public",
    "workerPrimaryAttribute": "wits",
    "suitableWorkerTypes": "Все с РАЗ, Умелец, Все с ЭМП, Переговорщик",
    "workerTypeEffects": {
      "Все с РАЗ": 0.5,
      "Умелец": 1,
      "Все с ЭМП": 0.5,
      "Переговорщик": 1
    },
    "templateVersion": 11
  }
];
