import { resourceUnitNote } from "./resource-unit-notes.js";

export const ECONOMY_RESOURCE_CATALOG_VERSION = 5;
export const ECONOMY_RESOURCE_CATALOG_SIZE = 100;

// One neutral wholesale price list owns every built-in resource. Regional rules,
// delivery, scarcity and the seller modifier are applied later by the market.
export const ECONOMY_RESOURCE_PRICE_COPPER = Object.freeze({
  money: 1,
  wood: 4,
  stone: 4,
  bricks: 8,
  glass: 80,
  straw: 3,
  rope: 24,
  marble: 120,
  "rare-wood": 180,
  "iron-ore": 7,
  iron: 18,
  steel: 32,
  copper: 60,
  "nonferrous-metals": 45,
  "rare-earth-metals": 900,
  "light-alloys": 90,
  "complex-alloys": 180,
  silver: 600,
  gold: 9000,
  wool: 8,
  "plant-fiber": 6,
  cloth: 14,
  pelt: 12,
  leather: 18,
  silk: 180,
  tallow: 6,
  parchment: 12,
  grain: 2,
  flour: 4,
  vegetables: 4,
  fruits: 4,
  meat: 6,
  fish: 6,
  eggs: 5,
  milk: 3,
  honey: 10,
  herbs: 14,
  "animal-feed": 7,
  water: 1,
  salt: 2,
  sugar: 5,
  spices: 18,
  hops: 4,
  grapes: 3,
  "cooking-oil": 8,
  bread: 6,
  "food-grain": 9,
  "food-protein": 10,
  "food-dairy": 7,
  "food-fruit": 8,
  "food-vegetables": 8,
  "preserved-meat": 15,
  "aged-cheese": 12,
  "dried-fruit": 10,
  "canned-protein": 15,
  "canned-fruit": 9,
  "canned-vegetables": 9,
  "alcohol-brewed-cheap-weak": 18,
  "alcohol-brewed-fine-weak": 42,
  "alcohol-brewed-cheap-strong": 48,
  "alcohol-brewed-fine-strong": 96,
  "alcohol-wine-cheap-weak": 30,
  "alcohol-wine-fine-weak": 72,
  "alcohol-wine-cheap-strong": 84,
  "alcohol-wine-fine-strong": 180,
  "alcohol-general-cheap-weak": 24,
  "alcohol-general-fine-weak": 54,
  "alcohol-general-cheap-strong": 72,
  "alcohol-general-fine-strong": 150,
  "components-simple": 48,
  "components-complex": 144,
  "components-high-tech": 480,
  "tools-simple": 120,
  "tools-complex": 480,
  "fuel-solid": 10,
  "fuel-liquid": 24,
  "chemicals-simple": 36,
  "chemicals-complex": 120,
  explosives: 90,
  "military-supplies-simple": 60,
  "military-supplies-complex": 150,
  "armament-simple": 1200,
  "armament-complex": 2400,
  "armament-elite": 7200,
  "medical-supplies": 60,
  medicines: 240,
  "household-goods-simple": 120,
  "household-goods-fine": 600,
  tea: 60,
  coffee: 48,
  cocoa: 54,
  tobacco: 42,
  gemstones: 1200,
  "art-goods": 1200,
  "tsukami-fiber": 14,
  "tsukami-paper": 18,
  "crystal-dust": 240,
  "crystal-inert": 900,
  "crystal-active": 2400,
  "crystal-core": 100000
});

const CATEGORY = Object.freeze({
  ALCOHOL: "alcohol",
  ANIMAL_FEED: "animal.feed",
  ARMAMENT: "armament",
  CHEMICAL: "chemical",
  COMPONENT: "component",
  CONSUMER: "consumer",
  FERROUS: "ferrous",
  FUEL: "fuel",
  GRAIN_INPUT: "ingredient.grain",
  FRUIT_INPUT: "ingredient.fruit",
  MEDICINE: "medicine",
  MEDICINE_RAW: "medicine.raw",
  MILITARY: "military",
  MASONRY: "masonry",
  NONFERROUS: "nonferrous",
  PRECIOUS: "precious",
  PREPARED_FOOD: "food.prepared",
  PROTEIN_INPUT: "ingredient.protein",
  SWEET_INPUT: "ingredient.sweet",
  TEXTILE: "textile",
  TOOL: "tool",
  LUXURY: "luxury"
});

const ICON = Object.freeze({
  alcohol: "fa-solid fa-wine-bottle",
  chemical: "fa-solid fa-flask",
  component: "fa-solid fa-gears",
  construction: "fa-solid fa-cubes-stacked",
  crystal: "fa-solid fa-gem",
  food: "fa-solid fa-bowl-food",
  fuel: "fa-solid fa-fire-flame-simple",
  household: "fa-solid fa-box-open",
  luxury: "fa-solid fa-gem",
  medicine: "fa-solid fa-kit-medical",
  metal: "fa-solid fa-cubes",
  military: "fa-solid fa-shield-halved",
  rawFood: "fa-solid fa-basket-shopping",
  textile: "fa-solid fa-shirt",
  tool: "fa-solid fa-hammer"
});

function resource(id, label, {
  category,
  categoryTag = "",
  marketTags = [],
  aliases = [],
  icon = "fa-solid fa-cube",
  basePriceCopper = 0,
  loadPoints = 4,
  shelfLifeQd = 0,
  noAutoConsume = false,
  foodEdible = false,
  foodType = "",
  useInConstruction = false,
  useInProduction = true,
  marketAccessDifficulty = 0,
  notes = ""
} = {}) {
  return {
    id,
    label,
    unit: "ед.",
    icon,
    category,
    categoryTag,
    marketTags,
    aliases,
    basePriceCopper: ECONOMY_RESOURCE_PRICE_COPPER[id] ?? basePriceCopper,
    loadPoints,
    shelfLifeQd,
    noAutoConsume,
    foodEdible,
    foodType,
    useInConstruction,
    useInProduction,
    marketAccessDifficulty,
    notes: [notes, resourceUnitNote(id, { foodEdible, category })].filter(Boolean).join(" ")
  };
}

function construction(id, label, price, loadPoints = 4, options = {}) {
  return resource(id, label, {
    category: "Строительство",
    icon: ICON.construction,
    basePriceCopper: price,
    loadPoints,
    useInConstruction: true,
    marketTags: ["construction", ...(options.marketTags ?? [])],
    ...options
  });
}

function metal(id, label, price, options = {}) {
  return resource(id, label, {
    category: "Металлы",
    icon: ICON.metal,
    basePriceCopper: price,
    loadPoints: 4,
    useInConstruction: true,
    marketTags: ["metal", ...(options.marketTags ?? [])],
    ...options
  });
}

function rawFood(id, label, price, shelfLifeQd, options = {}) {
  return resource(id, label, {
    category: "Пищевое сырьё",
    icon: ICON.rawFood,
    basePriceCopper: price,
    loadPoints: 1,
    shelfLifeQd,
    foodEdible: false,
    ...options,
    marketTags: [...new Set(["food", "food.raw", ...(options.marketTags ?? [])])]
  });
}

function preparedFood(id, label, foodType, price, shelfLifeQd, options = {}) {
  return resource(id, label, {
    category: "Готовая пища",
    categoryTag: CATEGORY.PREPARED_FOOD,
    icon: ICON.food,
    basePriceCopper: price,
    loadPoints: 1,
    shelfLifeQd,
    foodEdible: true,
    foodType,
    marketTags: ["food", "food.prepared", foodType, ...(options.marketTags ?? [])],
    ...options
  });
}

function alcohol(id, label, price, family, strength, quality, shelfLifeQd = 0) {
  return resource(id, label, {
    category: "Алкоголь",
    categoryTag: CATEGORY.ALCOHOL,
    icon: ICON.alcohol,
    basePriceCopper: price,
    loadPoints: 2,
    shelfLifeQd,
    marketTags: ["alcohol", family, strength, quality],
    aliases: [label.replace("Зерновой/хмельной", "Хмельной")]
  });
}

export const RESOURCE_BASE_DEFINITIONS = [
  resource("money", "Деньги", {
    category: "Системное",
    icon: "fa-solid fa-coins",
    basePriceCopper: 1,
    loadPoints: 0,
    useInConstruction: true,
    useInProduction: false,
    aliases: ["money", "coins", "деньги", "монеты"],
    notes: "Единственная расчётная валюта; количество хранится отдельно от ресурсного склада."
  }),

  construction("wood", "Wood", 3, 4, { aliases: ["wood", "древесина", "дерево", "лес", "брёвна", "бревна", "доски"], marketTags: ["wood", "lumber"] }),
  construction("stone", "Stone", 2, 4, { categoryTag: CATEGORY.MASONRY, aliases: ["stone", "камень", "камни"], marketTags: ["stone", "masonry"] }),
  construction("bricks", "Bricks", 4, 4, { categoryTag: CATEGORY.MASONRY, aliases: ["bricks", "кирпич", "кирпичи"], marketTags: ["stone", "masonry"] }),
  construction("glass", "Glass", 80, 2, { aliases: ["glass", "стекло"], marketTags: ["glass", "fragile"] }),
  construction("straw", "Straw", 1, 2, { aliases: ["straw", "солома"], marketTags: ["agriculture", "thatch"] }),
  construction("rope", "Rope", 10, 2, { aliases: ["rope", "канат", "верёвка", "веревка"], marketTags: ["shipbuilding", "ship-supply", "rigging"] }),
  construction("marble", "Marble", 38, 8, { aliases: ["marble", "мрамор", "белый мрамор"], marketTags: ["stone", "luxury"], noAutoConsume: true }),
  construction("rare-wood", "Rare Wood", 75, 4, { aliases: ["rare wood", "ironwood", "редкая древесина", "железная древесина"], marketTags: ["wood", "lumber", "shipbuilding", "rare", "luxury"], noAutoConsume: true, marketAccessDifficulty: 2 }),

  metal("iron-ore", "Iron Ore", 4, { aliases: ["iron ore", "ore", "железная руда", "руда"], marketTags: ["ore", "ferrous"] }),
  metal("iron", "Iron", 10, { categoryTag: CATEGORY.FERROUS, aliases: ["iron", "железо", "чугун", "ковкое железо"], marketTags: ["ferrous", "ingot", "metalwork"] }),
  metal("steel", "Steel", 20, { categoryTag: CATEGORY.FERROUS, aliases: ["steel", "сталь"], marketTags: ["ferrous", "ingot", "metalwork", "industrial"] }),
  metal("copper", "Copper", 20, { categoryTag: CATEGORY.NONFERROUS, aliases: ["copper", "медь", "медный слиток"], marketTags: ["nonferrous", "conductor"] }),
  metal("nonferrous-metals", "Цветные металлы", 24, { categoryTag: CATEGORY.NONFERROUS, aliases: ["цветные металлы", "олово", "свинец", "цинк", "никель"], marketTags: ["nonferrous", "ingot"] }),
  metal("rare-earth-metals", "Редкоземельные металлы", 140, { aliases: ["редкоземельные металлы", "редкие металлы"], marketTags: ["rare", "technology"], noAutoConsume: true, marketAccessDifficulty: 3 }),
  metal("light-alloys", "Сплавы (лёгкие)", 55, { aliases: ["легкие сплавы", "лёгкие сплавы", "бронза", "латунь"], marketTags: ["alloy", "light", "technology"] }),
  metal("complex-alloys", "Сплавы (сложные)", 110, { aliases: ["сложные сплавы", "специальные сплавы"], marketTags: ["alloy", "complex", "technology"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  metal("silver", "Silver", 100, { categoryTag: CATEGORY.PRECIOUS, aliases: ["silver", "серебро", "серебряный слиток"], marketTags: ["precious", "currency", "luxury"], loadPoints: 1, noAutoConsume: true }),
  metal("gold", "Gold", 1000, { categoryTag: CATEGORY.PRECIOUS, aliases: ["gold", "золото", "золотой слиток"], marketTags: ["precious", "currency", "luxury"], loadPoints: 1, noAutoConsume: true }),

  resource("wool", "Wool", { category: "Текстиль и ремесло", categoryTag: CATEGORY.TEXTILE, icon: ICON.textile, basePriceCopper: 4, loadPoints: 2, aliases: ["wool", "шерсть"], marketTags: ["textile", "fiber", "livestock"] }),
  resource("plant-fiber", "Plant Fiber", { category: "Текстиль и ремесло", categoryTag: CATEGORY.TEXTILE, icon: ICON.textile, basePriceCopper: 3, loadPoints: 2, aliases: ["plant fiber", "растительное волокно", "лён", "лен", "пенька", "хлопок"], marketTags: ["textile", "fiber", "textile-input", "agriculture"] }),
  resource("cloth", "Cloth", { category: "Текстиль и ремесло", categoryTag: CATEGORY.TEXTILE, icon: ICON.textile, basePriceCopper: 8, loadPoints: 2, useInConstruction: true, aliases: ["cloth", "ткань", "сукно", "парусина", "войлок"], marketTags: ["textile", "cloth", "ship-supply"] }),
  resource("pelt", "Pelt", { category: "Текстиль и ремесло", categoryTag: CATEGORY.TEXTILE, icon: ICON.textile, basePriceCopper: 8, loadPoints: 2, aliases: ["pelt", "шкура", "шкуры", "мех"], marketTags: ["textile", "hide", "livestock"] }),
  resource("leather", "Leather", { category: "Текстиль и ремесло", categoryTag: CATEGORY.TEXTILE, icon: ICON.textile, basePriceCopper: 12, loadPoints: 2, aliases: ["leather", "кожа"], marketTags: ["textile", "hide", "processed"] }),
  resource("silk", "Silk", { category: "Текстиль и ремесло", categoryTag: CATEGORY.LUXURY, icon: ICON.textile, basePriceCopper: 100, loadPoints: 1, aliases: ["silk", "шёлк", "шелк", "шелковая ткань"], marketTags: ["textile", "fiber", "luxury", "rare"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  resource("tallow", "Tallow", { category: "Текстиль и ремесло", icon: "fa-solid fa-droplet", basePriceCopper: 6, loadPoints: 2, aliases: ["tallow", "жир", "сало"], marketTags: ["organic", "craft", "livestock"] }),
  resource("parchment", "Письменные материалы", { category: "Текстиль и ремесло", icon: "fa-solid fa-scroll", basePriceCopper: 10, loadPoints: 1, useInConstruction: true, aliases: ["parchment", "пергамент", "бумага", "чернила", "writing materials", "письменные материалы"], marketTags: ["paper", "writing", "administration"] }),

  rawFood("grain", "Grain", 2, 1440, { categoryTag: CATEGORY.GRAIN_INPUT, aliases: ["grain", "зерно", "ячмень", "овёс", "овес", "рожь", "рис", "кукуруза"], marketTags: ["grain", "agriculture"] }),
  rawFood("flour", "Flour", 3, 240, { categoryTag: CATEGORY.GRAIN_INPUT, aliases: ["flour", "мука"], marketTags: ["grain", "processed"] }),
  rawFood("vegetables", "Vegetables", 4, 80, { categoryTag: CATEGORY.FRUIT_INPUT, aliases: ["vegetables", "овощи", "картофель", "горох", "фасоль"], marketTags: ["vegetable", "agriculture"] }),
  rawFood("fruits", "Fruits", 4, 40, { categoryTag: CATEGORY.FRUIT_INPUT, aliases: ["fruits", "fruit", "фрукты", "плоды"], marketTags: ["fruit", "agriculture"] }),
  rawFood("meat", "Meat", 6, 20, { categoryTag: CATEGORY.PROTEIN_INPUT, aliases: ["meat", "мясо", "свинина", "птица"], marketTags: ["protein", "livestock"] }),
  rawFood("fish", "Fish", 6, 12, { categoryTag: CATEGORY.PROTEIN_INPUT, aliases: ["fish", "рыба", "свежая рыба"], marketTags: ["protein", "fish", "fishery"] }),
  rawFood("eggs", "Eggs", 5, 40, { categoryTag: CATEGORY.PROTEIN_INPUT, aliases: ["eggs", "яйца", "яйцо"], marketTags: ["protein", "livestock", "poultry"] }),
  rawFood("milk", "Milk", 3, 8, { aliases: ["milk", "молоко"], marketTags: ["dairy", "livestock"] }),
  rawFood("honey", "Honey", 40, 0, { categoryTag: CATEGORY.SWEET_INPUT, aliases: ["honey", "мёд", "мед"], marketTags: ["sweetener", "beekeeping"] }),
  rawFood("herbs", "Herbs", 20, 160, { categoryTag: CATEGORY.MEDICINE_RAW, useInConstruction: true, aliases: ["herbs", "травы", "лекарственные травы"], marketTags: ["medicine", "herbal", "agriculture"] }),
  rawFood("animal-feed", "Animal Feed", 2, 0, { categoryTag: CATEGORY.ANIMAL_FEED, loadPoints: 4, aliases: ["animal feed", "feed", "fodder", "корм", "фураж"], marketTags: ["livestock", "fodder", "agriculture"] }),
  rawFood("water", "Water", 1, 0, { loadPoints: 4, aliases: ["water", "вода"], marketTags: ["water", "siege"] }),
  rawFood("salt", "Salt", 5, 0, { aliases: ["salt", "соль"], marketTags: ["preservative", "mineral"] }),
  rawFood("sugar", "Sugar", 12, 0, { categoryTag: CATEGORY.SWEET_INPUT, aliases: ["sugar", "сахар"], marketTags: ["sweetener", "colonial-goods"] }),
  rawFood("spices", "Spices", 30, 0, { aliases: ["spices", "пряности", "специи"], marketTags: ["colonial-goods", "luxury"] }),
  rawFood("hops", "Hops", 6, 160, { aliases: ["hops", "хмель"], marketTags: ["beverage-input", "brewing", "agriculture"], noAutoConsume: true }),
  rawFood("grapes", "Grapes", 5, 40, { aliases: ["grapes", "виноград"], marketTags: ["beverage-input", "wine", "agriculture"], noAutoConsume: true }),
  rawFood("cooking-oil", "Cooking Oil", 15, 0, { aliases: ["cooking oil", "пищевое масло", "оливковое масло"], marketTags: ["food", "oil", "organic"] }),

  preparedFood("bread", "Bread", "grain", 4, 40, { aliases: ["bread", "хлеб"] }),
  preparedFood("food-grain", "Готовая пища (зерновая)", "grain", 5, 20, { aliases: ["grain food", "зерновая пища", "каша", "лепёшки", "лепешки"] }),
  preparedFood("food-protein", "Готовая пища (белковая)", "protein", 8, 40, { aliases: ["protein food", "белковая пища", "мясная пища", "food meat"] }),
  preparedFood("food-dairy", "Готовая пища (молочная)", "dairy", 5, 80, { aliases: ["dairy food", "молочная пища"] }),
  preparedFood("food-fruit", "Готовая пища (плодовая)", "fruit", 6, 80, { aliases: ["fruit food", "плодовая пища"] }),
  preparedFood("food-vegetables", "Готовая пища (овощная)", "vegetable", 8, 80, { aliases: ["vegetable food", "овощное блюдо"] }),
  preparedFood("preserved-meat", "Белковые заготовки", "protein", 17, 720, { aliases: ["preserved meat", "солонина", "солёная рыба", "соленая рыба", "консервы"], marketTags: ["preserved-food", "ship-supply", "military-supply"] }),
  preparedFood("canned-protein", "Белковые консервы", "protein", 15, 1920, { aliases: ["canned protein"], marketTags: ["preserved-food", "ship-supply", "military-supply"] }),
  preparedFood("canned-fruit", "Фруктовые консервы", "fruit", 9, 1920, { aliases: ["canned fruit"], marketTags: ["preserved-food", "ship-supply"] }),
  preparedFood("canned-vegetables", "Овощные консервы", "vegetable", 9, 1920, { aliases: ["canned vegetables"], marketTags: ["preserved-food", "ship-supply"] }),
  preparedFood("aged-cheese", "Aged Cheese", "dairy", 12, 480, { aliases: ["aged cheese", "выдержанный сыр", "сыр"], marketTags: ["preserved-food", "dairy", "luxury"] }),
  preparedFood("dried-fruit", "Dried Fruit", "fruit", 10, 720, { aliases: ["dried fruit", "сухофрукты"], marketTags: ["preserved-food", "fruit", "ship-supply"] }),

  alcohol("alcohol-brewed-cheap-weak", "Зерновой/хмельной алкоголь (дешёвый слабый)", 4, "brewed", "weak", "cheap", 120),
  alcohol("alcohol-brewed-fine-weak", "Зерновой/хмельной алкоголь (дорогой слабый)", 10, "brewed", "weak", "fine", 240),
  alcohol("alcohol-brewed-cheap-strong", "Зерновой/хмельной алкоголь (дешёвый крепкий)", 12, "brewed", "strong", "cheap"),
  alcohol("alcohol-brewed-fine-strong", "Зерновой/хмельной алкоголь (дорогой крепкий)", 24, "brewed", "strong", "fine"),
  alcohol("alcohol-wine-cheap-weak", "Винный алкоголь (дешёвый слабый)", 8, "wine", "weak", "cheap", 480),
  alcohol("alcohol-wine-fine-weak", "Винный алкоголь (дорогой слабый)", 20, "wine", "weak", "fine"),
  alcohol("alcohol-wine-cheap-strong", "Винный алкоголь (дешёвый крепкий)", 18, "wine", "strong", "cheap"),
  alcohol("alcohol-wine-fine-strong", "Винный алкоголь (дорогой крепкий)", 40, "wine", "strong", "fine"),
  alcohol("alcohol-general-cheap-weak", "Общий алкоголь (дешёвый слабый)", 6, "general", "weak", "cheap", 240),
  alcohol("alcohol-general-fine-weak", "Общий алкоголь (дорогой слабый)", 15, "general", "weak", "fine", 480),
  alcohol("alcohol-general-cheap-strong", "Общий алкоголь (дешёвый крепкий)", 15, "general", "strong", "cheap"),
  alcohol("alcohol-general-fine-strong", "Общий алкоголь (дорогой крепкий)", 35, "general", "strong", "fine"),

  resource("components-simple", "Простые компоненты", { category: "Промышленность", categoryTag: CATEGORY.COMPONENT, icon: ICON.component, basePriceCopper: 10, loadPoints: 2, useInConstruction: true, aliases: ["simple components", "простые компоненты", "крепёж", "крепеж", "гвозди"], marketTags: ["component", "craft", "construction", "machine-parts"] }),
  resource("components-complex", "Сложные компоненты", { category: "Промышленность", categoryTag: CATEGORY.COMPONENT, icon: ICON.component, basePriceCopper: 40, loadPoints: 2, useInConstruction: true, aliases: ["complex components", "сложные компоненты", "машинные детали"], marketTags: ["component", "machine-parts", "industrial", "technology"] }),
  resource("components-high-tech", "Высокотехнологичные компоненты", { category: "Промышленность", categoryTag: CATEGORY.COMPONENT, icon: "fa-solid fa-microchip", basePriceCopper: 120, loadPoints: 1, useInConstruction: true, aliases: ["high-tech components", "высокотехнологичные компоненты", "телеграфное оборудование", "электротехнические детали"], marketTags: ["component", "technology", "electrical", "telegraph"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  resource("tools-simple", "Простые инструменты", { category: "Промышленность", categoryTag: CATEGORY.TOOL, icon: ICON.tool, basePriceCopper: 20, loadPoints: 2, useInConstruction: true, aliases: ["simple tools", "простые инструменты", "ручной инструмент"], marketTags: ["tools", "craft", "industrial"] }),
  resource("tools-complex", "Сложные инструменты", { category: "Промышленность", categoryTag: CATEGORY.TOOL, icon: ICON.tool, basePriceCopper: 80, loadPoints: 2, useInConstruction: true, aliases: ["complex tools", "сложные инструменты", "лабораторная посуда"], marketTags: ["tools", "machine-parts", "industrial", "technology"], noAutoConsume: true }),
  resource("fuel-solid", "Твёрдое топливо", { category: "Промышленность", categoryTag: CATEGORY.FUEL, icon: ICON.fuel, basePriceCopper: 8, loadPoints: 4, aliases: ["solid fuel", "твёрдое топливо", "твердое топливо", "уголь", "каменный уголь", "древесный уголь", "кокс", "торф"], marketTags: ["fuel", "industrial-fuel", "mineral"] }),
  resource("fuel-liquid", "Жидкое топливо", { category: "Промышленность", categoryTag: CATEGORY.FUEL, icon: ICON.fuel, basePriceCopper: 12, loadPoints: 2, aliases: ["liquid fuel", "жидкое топливо", "керосин", "ламповое масло", "китовый жир", "рыбий жир"], marketTags: ["fuel", "industrial-fuel", "oil", "chemical"] }),
  resource("chemicals-simple", "Простые химические материалы", { category: "Промышленность", categoryTag: CATEGORY.CHEMICAL, icon: ICON.chemical, basePriceCopper: 16, loadPoints: 2, aliases: ["simple chemicals", "простые химические материалы", "смола", "дёготь", "деготь", "клей", "квасцы", "красители"], marketTags: ["chemical", "chemical-input", "craft"] }),
  resource("chemicals-complex", "Сложные химические материалы", { category: "Промышленность", categoryTag: CATEGORY.CHEMICAL, icon: ICON.chemical, basePriceCopper: 40, loadPoints: 2, aliases: ["complex chemicals", "сложные химические материалы", "серная кислота", "растворители", "ртуть"], marketTags: ["chemical", "chemical-input", "industrial", "dangerous"], noAutoConsume: true, marketAccessDifficulty: 1 }),
  resource("explosives", "Explosives", { category: "Промышленность", icon: "fa-solid fa-bomb", basePriceCopper: 32, loadPoints: 2, aliases: ["explosives", "взрывчатка", "порох", "селитра", "сера"], marketTags: ["explosive", "mining", "siege", "military-supply", "dangerous"], noAutoConsume: true, marketAccessDifficulty: 2 }),

  resource("military-supplies-simple", "Военные припасы (простые)", { category: "Военная экономика", categoryTag: CATEGORY.MILITARY, icon: ICON.military, basePriceCopper: 15, loadPoints: 2, aliases: ["simple military supplies", "простые военные припасы", "стрелы", "болты"], marketTags: ["military-supply", "ammunition", "weapon"] }),
  resource("military-supplies-complex", "Военные припасы (сложные)", { category: "Военная экономика", categoryTag: CATEGORY.MILITARY, icon: ICON.military, basePriceCopper: 32, loadPoints: 2, aliases: ["complex military supplies", "сложные военные припасы", "патроны", "артиллерийские припасы"], marketTags: ["military-supply", "ammunition", "weapon", "technology"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  resource("armament-simple", "Вооружение (простое)", { category: "Военная экономика", categoryTag: CATEGORY.ARMAMENT, icon: "fa-solid fa-swords", basePriceCopper: 60, loadPoints: 4, aliases: ["simple armament", "простое вооружение"], marketTags: ["armament", "weapon", "military-supply"], notes: "Одна единица снабжает один отряд из пяти человек." }),
  resource("armament-complex", "Вооружение (сложное)", { category: "Военная экономика", categoryTag: CATEGORY.ARMAMENT, icon: "fa-solid fa-gun", basePriceCopper: 180, loadPoints: 6, aliases: ["complex armament", "сложное вооружение"], marketTags: ["armament", "weapon", "military-supply", "technology"], noAutoConsume: true, marketAccessDifficulty: 2, notes: "Одна единица снабжает один отряд из пяти человек." }),
  resource("armament-elite", "Вооружение (элитное)", { category: "Военная экономика", categoryTag: CATEGORY.ARMAMENT, icon: "fa-solid fa-shield-halved", basePriceCopper: 500, loadPoints: 6, aliases: ["elite armament", "элитное вооружение"], marketTags: ["armament", "weapon", "military-supply", "elite", "rare"], noAutoConsume: true, marketAccessDifficulty: 4, notes: "Одна единица снабжает один отряд из пяти человек." }),

  resource("medical-supplies", "Медицинские припасы", { category: "Медицина", categoryTag: CATEGORY.MEDICINE, icon: ICON.medicine, basePriceCopper: 20, loadPoints: 1, useInConstruction: true, aliases: ["medical supplies", "медицинские припасы", "бинты", "медицинский спирт", "дезинфекция"], marketTags: ["medicine", "medical-supply", "sanitation"] }),
  resource("medicines", "Лекарства", { category: "Медицина", categoryTag: CATEGORY.MEDICINE, icon: "fa-solid fa-pills", basePriceCopper: 60, loadPoints: 1, aliases: ["medicines", "лекарства", "снадобья", "хинная кора", "опиум"], marketTags: ["medicine", "medical-supply", "rare"], noAutoConsume: true, marketAccessDifficulty: 1 }),

  resource("household-goods-simple", "Простые бытовые товары", { category: "Бытовые товары", categoryTag: CATEGORY.CONSUMER, icon: ICON.household, basePriceCopper: 8, loadPoints: 2, aliases: ["simple household goods", "простые бытовые товары", "посуда", "мыло", "свечи", "простая мебель"], marketTags: ["consumer", "household", "craft"] }),
  resource("household-goods-fine", "Дорогие бытовые товары", { category: "Бытовые товары", categoryTag: CATEGORY.CONSUMER, icon: ICON.household, basePriceCopper: 30, loadPoints: 2, useInConstruction: true, aliases: ["fine household goods", "дорогие бытовые товары", "дорогая мебель", "дорогая одежда"], marketTags: ["consumer", "household", "luxury", "craft"] }),

  resource("tea", "Tea", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: ICON.luxury, basePriceCopper: 20, loadPoints: 1, aliases: ["tea", "чай"], marketTags: ["luxury", "colonial-goods", "beverage"] }),
  resource("coffee", "Coffee", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: ICON.luxury, basePriceCopper: 25, loadPoints: 1, aliases: ["coffee", "кофе"], marketTags: ["luxury", "colonial-goods", "beverage"] }),
  resource("cocoa", "Cocoa", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: ICON.luxury, basePriceCopper: 22, loadPoints: 1, aliases: ["cocoa", "какао"], marketTags: ["luxury", "colonial-goods", "beverage"] }),
  resource("tobacco", "Tobacco", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: "fa-solid fa-smoking", basePriceCopper: 18, loadPoints: 1, aliases: ["tobacco", "табак"], marketTags: ["luxury", "colonial-goods"] }),
  resource("gemstones", "Драгоценности", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: ICON.luxury, basePriceCopper: 180, loadPoints: 1, aliases: ["gemstones", "драгоценности", "самоцветы", "ювелирные изделия"], marketTags: ["luxury", "precious", "gem"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  resource("art-goods", "Предметы искусства", { category: "Торговля и роскошь", categoryTag: CATEGORY.LUXURY, icon: "fa-solid fa-palette", basePriceCopper: 100, loadPoints: 2, useInConstruction: true, aliases: ["art goods", "предметы искусства", "картины", "скульптуры"], marketTags: ["luxury", "art", "culture"], noAutoConsume: true, marketAccessDifficulty: 2 }),
  resource("tsukami-fiber", "Волокно тсуками", { category: "Торговля и роскошь", icon: "fa-solid fa-leaf", basePriceCopper: 14, loadPoints: 1, aliases: ["tsukami fiber", "волокно тсуками"], marketTags: ["tsukami", "fiber", "textile-input", "paper"], noAutoConsume: true, marketAccessDifficulty: 1 }),
  resource("tsukami-paper", "Бумага тсуками", { category: "Торговля и роскошь", icon: "fa-solid fa-file-lines", basePriceCopper: 16, loadPoints: 1, aliases: ["tsukami paper", "бумага тсуками"], marketTags: ["tsukami", "paper", "writing", "art"], noAutoConsume: true, marketAccessDifficulty: 1 }),

  resource("crystal-dust", "Кристаллическая пыль", { category: "Кристаллы", icon: ICON.crystal, basePriceCopper: 50, loadPoints: 1, aliases: ["crystal dust", "кристаллическая пыль"], marketTags: ["crystal", "strategic"], noAutoConsume: true, marketAccessDifficulty: 3 }),
  resource("crystal-inert", "Инертный кристалл", { category: "Кристаллы", icon: ICON.crystal, basePriceCopper: 150, loadPoints: 4, aliases: ["inert crystal", "инертный кристалл"], marketTags: ["crystal", "strategic"], noAutoConsume: true, marketAccessDifficulty: 3 }),
  resource("crystal-active", "Активный кристалл", { category: "Кристаллы", icon: ICON.crystal, basePriceCopper: 300, loadPoints: 4, aliases: ["active crystal", "активный кристалл", "подъёмный кристалл", "подъемный кристалл", "эфирный кристалл"], marketTags: ["crystal", "strategic", "technology"], noAutoConsume: true, marketAccessDifficulty: 4 }),
  resource("crystal-core", "Кристаллическое ядро", { category: "Кристаллы", icon: ICON.crystal, basePriceCopper: 850, loadPoints: 32, aliases: ["crystal core", "кристаллическое ядро", "корабельное кристаллическое ядро"], marketTags: ["crystal", "strategic", "shipbuilding", "restricted"], noAutoConsume: true, marketAccessDifficulty: 4 })
];

if (RESOURCE_BASE_DEFINITIONS.length !== ECONOMY_RESOURCE_CATALOG_SIZE) {
  throw new Error(`FBL Skyhold | Economy resource catalog expected ${ECONOMY_RESOURCE_CATALOG_SIZE} rows, got ${RESOURCE_BASE_DEFINITIONS.length}.`);
}

if (Object.keys(ECONOMY_RESOURCE_PRICE_COPPER).length !== ECONOMY_RESOURCE_CATALOG_SIZE
  || RESOURCE_BASE_DEFINITIONS.some((row) => !Object.hasOwn(ECONOMY_RESOURCE_PRICE_COPPER, row.id))) {
  throw new Error("FBL Skyhold | Every economy resource must own one canonical neutral wholesale price.");
}
