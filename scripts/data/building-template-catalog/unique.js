export const BUILDING_TEMPLATES_UNIQUE = [
  {
    "id": "fasti-shop",
    "compendiumId": "",
    "name": "Лавка редкостей Фасти ди Ото",
    "type": "Особые",
    "primaryDev": "culture",
    "icon": "fa-solid fa-book-sparkles",
    "img": "",
    "unlocked": true,
    "description": "Закрытая лавка редкостей. Откроется после общего вклада в 3999.9 ЗМ.",
    "sourceRequirement": "Сюжетное здание кампании Лапуты.",
    "sourceRawMaterials": "-",
    "specialRequirements": "Скрытый шаблон: показывать игрокам только после решения ГМа.",
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
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 0,
    "workerRole": "",
    "special": {
      "kind": "fasti-shop",
      "data": {
        "unlockCostCopper": 399990,
        "contributedCopper": 0,
        "unlocked": false,
        "gallery": [],
        "contributionLog": []
      }
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
      "illegal": false
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
    "religion": {
      "religious": false,
      "faith": "",
      "customFaith": "",
      "notes": ""
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "ЛАВКА РЕДКОСТЕЙ ФАСТИ ДИ ОТО ОТКРОЕТСЯ ПОСЛЕ ВКЛАДА В 3999.9 ЗМ",
    "notes": "Особое здание кампании Лапуты. Вклад берётся из денег владения.",
    "templateVersion": 12,
    "visibility": "gm"
  },
  {
    "id": "laputa-excavated-crypt",
    "compendiumId": "",
    "name": "Раскопанный склеп",
    "type": "Складские",
    "primaryDev": "technology",
    "icon": "fa-solid fa-dungeon",
    "img": "",
    "unlocked": true,
    "description": "Небольшое каменное помещение, приспособленное под общий склад.",
    "sourceRequirement": "Сюжетное здание кампании Лапуты.",
    "sourceRawMaterials": "-",
    "specialRequirements": "Существующий склеп; отдельно не строится.",
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
      "war": 0
    },
    "buildDifficulty": 0,
    "buildTarget": 1,
    "buildProgress": 0,
    "constructionStatus": "planned",
    "materialCosts": [],
    "requiredBuildingIds": [],
    "workersMin": 0,
    "workersMax": 0,
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
      "illegal": false
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
      "capacity": 200,
      "security": 2,
      "quality": 1
    },
    "religion": {
      "religious": false,
      "faith": "",
      "customFaith": "",
      "notes": ""
    },
    "reputation": 0,
    "moraleDelta": 0,
    "workerMoraleDelta": 0,
    "upkeep": 0,
    "effect": "Небольшой общий склад без производства, дохода и развития.",
    "notes": "Сюжетное хранилище Лапуты. Характеристики хранения задаёт этот шаблон.",
    "templateVersion": 12,
    "visibility": "public"
  }
];
