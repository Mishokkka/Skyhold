import { DEFAULT_EXTERNAL_MARKET } from "./default-market.js";
import { normalizeMarketOffer } from "./market-catalog.js";
import { clone, toBoolean, toNumber } from "../utils.js";

const VISIBILITY = new Set(["public", "gm"]);
const TRANSPORT_MODES = new Set(["caravan", "rail", "airship"]);
const RULE_MODES = new Set(["produce", "consume", "adjust", "restrict"]);
const ACCESS_DIFFICULTY_BY_UBIQUITY = Object.freeze({ essential: 0, common: 0, ordinary: 1, specialized: 2, restricted: 4 });

function bounded(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function slug(value = "", fallback = "entry") {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^a-z0-9а-я]+/gi, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function stringList(value = [], limit = 80) {
  const rows = Array.isArray(value) ? value : String(value ?? "").split(/[,;|\n]+/);
  return [...new Set(rows.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, limit);
}

function normalizedModes(value = []) {
  return stringList(value).filter((mode) => TRANSPORT_MODES.has(mode));
}

function defaultOffer(offer, { ubiquity = "common", tags = [] } = {}) {
  return {
    ...offer,
    ubiquity,
    accessDifficulty: Math.max(0, Math.floor(Number(offer?.accessDifficulty ?? ACCESS_DIFFICULTY_BY_UBIQUITY[ubiquity] ?? 0) || 0)),
    tags: [...new Set([...(offer.tags ?? []), ...tags])]
  };
}

export const DEFAULT_MARKET_BASE_OFFERS = DEFAULT_EXTERNAL_MARKET.offers.map((offer) => {
  const definitions = {
    wood: { ubiquity: "essential", tags: ["wood", "organic", "construction", "fuel"] },
    stone: { ubiquity: "essential", tags: ["stone", "mineral", "construction"] },
    iron: { ubiquity: "ordinary", tags: ["iron", "metal", "ore", "construction"] },
    glass: { ubiquity: "ordinary", tags: ["glass", "mineral", "construction", "chemical-container"] },
    leather: { ubiquity: "common", tags: ["leather", "hide", "organic", "textile"] },
    cloth: { ubiquity: "common", tags: ["cloth", "textile"] },
    grain: { ubiquity: "essential", tags: ["grain", "edible", "food", "food.raw", "organic"] },
    flour: { ubiquity: "essential", tags: ["flour", "grain", "edible", "food", "food.processed"] },
    "fuel-solid": { ubiquity: "common", tags: ["coal", "charcoal", "coke", "fuel", "industrial-fuel", "mineral"] },
    herbs: { ubiquity: "ordinary", tags: ["herbs", "medicinal", "organic"] },
    water: { ubiquity: "essential", tags: ["water", "edible", "liquid"] },
    bread: { ubiquity: "essential", tags: ["bread", "grain", "edible", "food", "food.processed"] },
    meat: { ubiquity: "common", tags: ["meat", "edible", "food", "food.raw", "organic"] },
    milk: { ubiquity: "common", tags: ["milk", "dairy", "edible", "food", "liquid"] },
    honey: { ubiquity: "ordinary", tags: ["honey", "edible", "food", "organic"] },
    parchment: { ubiquity: "ordinary", tags: ["parchment", "paper", "organic", "administration"] },
    vegetables: { ubiquity: "essential", tags: ["vegetable", "edible", "food", "food.raw", "organic"] },
    fruits: { ubiquity: "essential", tags: ["fruit", "edible", "food", "food.raw", "organic"] },
    straw: { ubiquity: "essential", tags: ["straw", "organic", "fodder", "construction"] },
    wool: { ubiquity: "common", tags: ["wool", "textile", "organic"] },
    tallow: { ubiquity: "common", tags: ["tallow", "fat", "fuel", "organic"] },
    pelt: { ubiquity: "ordinary", tags: ["pelt", "fur", "hide", "organic"] },
    "iron-ore": { ubiquity: "ordinary", tags: ["iron", "ore", "metal", "mineral"] },
    copper: { ubiquity: "ordinary", tags: ["copper", "metal", "conductor"] },
    silver: { ubiquity: "specialized", tags: ["silver", "metal", "precious", "currency"] },
    gold: { ubiquity: "restricted", tags: ["gold", "metal", "precious", "luxury"] }
  };
  return defaultOffer(offer, definitions[offer.resourceId] ?? {});
});

export const DEFAULT_MARKET_SIZE_PROFILES = [
  { id: "outpost", label: "Торговый пост", description: "Только необходимые и наиболее обычные товары, малые партии.", maxUbiquity: "common", stockFactor: 0.3, priceFactor: 1.12, handlingFactor: 1.25 },
  { id: "local", label: "Местный рынок", description: "Небольшой рынок посёлка или сельской округи.", maxUbiquity: "ordinary", stockFactor: 0.55, priceFactor: 1.06, handlingFactor: 1.1 },
  { id: "town", label: "Городской рынок", description: "Устойчивый ассортимент и средние оптовые партии.", maxUbiquity: "ordinary", stockFactor: 1, priceFactor: 1, handlingFactor: 1 },
  { id: "regional", label: "Региональный рынок", description: "Крупная торговая точка, обслуживающая несколько округов.", maxUbiquity: "specialized", stockFactor: 1.75, priceFactor: 0.97, handlingFactor: 0.9 },
  { id: "metropolis", label: "Столичный рынок", description: "Очень широкий ассортимент и большие партии.", maxUbiquity: "specialized", stockFactor: 2.8, priceFactor: 0.94, handlingFactor: 0.82 },
  { id: "world-hub", label: "Международный торговый узел", description: "Мировой перевалочный рынок, где могут появляться ограниченные товары.", maxUbiquity: "restricted", stockFactor: 4, priceFactor: 0.92, handlingFactor: 0.75 }
];

export const DEFAULT_MARKET_CONDITIONS = [
  { id: "thriving", label: "Процветает", description: "Высокий оборот и надёжная логистика.", priceFactor: 0.95, stockFactor: 1.2, deliveryFactor: 0.9, timeFactor: 0.9, riskFactor: 0.8, volatilityFactor: 0.85 },
  { id: "stable", label: "Стабильно", description: "Нормальное состояние без общей надбавки.", priceFactor: 1, stockFactor: 1, deliveryFactor: 1, timeFactor: 1, riskFactor: 1, volatilityFactor: 1 },
  { id: "strained", label: "Напряжение", description: "Дефицит отдельных товаров и нестабильные поставки.", priceFactor: 1.08, stockFactor: 0.85, deliveryFactor: 1.15, timeFactor: 1.2, riskFactor: 1.25, volatilityFactor: 1.15 },
  { id: "disrupted", label: "Логистика нарушена", description: "Производство и пути сообщения работают с перебоями.", priceFactor: 1.2, stockFactor: 0.55, deliveryFactor: 1.4, timeFactor: 1.5, riskFactor: 1.6, volatilityFactor: 1.35 },
  { id: "ruined", label: "Разрушен", description: "Экономика почти уничтожена, доступно лишь четверть обычного предложения.", priceFactor: 1.45, stockFactor: 0.25, deliveryFactor: 1.8, timeFactor: 2, riskFactor: 2.2, volatilityFactor: 1.65 },
  { id: "blockaded", label: "Блокада", description: "Внешняя торговля почти остановлена.", priceFactor: 1.6, stockFactor: 0.15, deliveryFactor: 2.2, timeFactor: 2.5, riskFactor: 3, volatilityFactor: 1.9 },
  { id: "good-harvest", label: "Богатый урожай", description: "Временный избыток продовольствия.", priceFactor: 0.92, stockFactor: 1.35, deliveryFactor: 1, timeFactor: 1, riskFactor: 1, volatilityFactor: 0.9 },
  { id: "poor-harvest", label: "Неурожай", description: "Временный дефицит продовольствия и сырья.", priceFactor: 1.18, stockFactor: 0.68, deliveryFactor: 1.05, timeFactor: 1.1, riskFactor: 1.1, volatilityFactor: 1.35 },
  { id: "war-mobilization", label: "Военная мобилизация", description: "Стратегические товары поглощаются армией.", priceFactor: 1.16, stockFactor: 0.72, deliveryFactor: 1.25, timeFactor: 1.2, riskFactor: 1.55, volatilityFactor: 1.3 },
  { id: "reconstruction", label: "Восстановление", description: "Высокий спрос на материалы, инструмент и продовольствие.", priceFactor: 1.12, stockFactor: 0.82, deliveryFactor: 1.15, timeFactor: 1.15, riskFactor: 1.2, volatilityFactor: 1.2 }
];

function specialtyPreset(id, label, category, outputTags = [], inputTags = [], description = "", options = {}) {
  const rules = [];
  if (outputTags.length) rules.push({ id: `${id}-output`, label: "Местная продукция", mode: "produce", targetTags: outputTags, stockFactor: options.outputStockFactor ?? 2, priceFactor: options.outputPriceFactor ?? 0.88, volatilityFactor: options.outputVolatilityFactor ?? 0.95 });
  if (inputTags.length) rules.push({ id: `${id}-input`, label: "Производственное потребление", mode: "consume", targetTags: inputTags, stockFactor: options.inputStockFactor ?? 0.82, priceFactor: options.inputPriceFactor ?? 1.14, volatilityFactor: options.inputVolatilityFactor ?? 1.08 });
  return { id, label, category, description, active: true, rules, offers: options.offers ?? [] };
}

const S = specialtyPreset;
export const DEFAULT_MARKET_SPECIALTIES = [
  S("grain-district", "Зерновая округа", "Сельское хозяйство", ["grain", "flour"], ["tools", "wood"], "Массовое производство хлебных культур."),
  S("market-gardens", "Овощеводство", "Сельское хозяйство", ["vegetable", "edible", "food.raw"], ["tools", "fertilizer"], "Свежая продукция пригородных хозяйств."),
  S("orchards", "Фруктовые сады", "Сельское хозяйство", ["fruit"], ["wood", "tools"], "Фрукты, соки и сырьё для переработки."),
  S("vineyards", "Виноградники", "Сельское хозяйство", ["grapes", "wine"], ["wood", "glass"], "Виноград и местное виноделие."),
  S("cattle-country", "Скотоводство", "Сельское хозяйство", ["meat", "hide", "leather"], ["grain", "salt"], "Крупные стада дают мясо, кожу и тягловых животных."),
  S("sheep-country", "Овцеводство", "Сельское хозяйство", ["wool", "meat", "milk"], ["grain", "salt"], "Шерсть, овечье молоко и мясо."),
  S("dairy-farms", "Молочное хозяйство", "Сельское хозяйство", ["milk", "dairy"], ["grain", "salt"], "Молоко и сырьё для сыроварен."),
  S("poultry-farms", "Птицеводство", "Сельское хозяйство", ["poultry", "egg", "meat"], ["grain"], "Птица и яйца для городского рынка."),
  S("apiaries", "Пчеловодство", "Сельское хозяйство", ["honey", "beeswax"], ["wood"], "Мёд, воск и свечное сырьё."),
  S("coastal-fishery", "Рыболовный порт", "Промыслы", ["fish", "food.raw"], ["salt", "wood", "rope"], "Свежая рыба и высокий спрос на снасти и консерванты.", { offers: [{ id: "specialty-fresh-fish", resourceId: "fish", name: "Свежая рыба", kind: "consumable", basePriceCopper: 8, baseStock: 90, volatility: 0.38, load: 1, ubiquity: "specialized", forceAvailable: true, tags: ["fish", "edible", "food.raw"] }] }),
  S("deep-fishery", "Дальний рыбный промысел", "Промыслы", ["fish", "preserved-fish", "oil"], ["salt", "rope", "cloth", "wood"], "Крупные партии рыбы, жира и морских продуктов."),
  S("saltworks", "Солеварни", "Промыслы", ["salt", "mineral"], ["fuel", "wood"], "Массовая соль для пищи, кожевен и химии."),
  S("herb-gathering", "Сбор лекарственных трав", "Промыслы", ["herbs", "medicinal"], ["cloth", "glass"], "Травы, коренья и аптекарское сырьё."),
  S("forestry", "Лесной промысел", "Промыслы", ["wood", "resin"], ["tools", "food"], "Древесина, смола и лесные материалы."),
  S("charcoal-burning", "Углежжение", "Промыслы", ["charcoal", "fuel"], ["wood"], "Древесный уголь для кузниц и отопления."),
  S("peat-bogs", "Торфяники", "Промыслы", ["peat", "fuel"], ["tools"], "Дешёвое тяжёлое местное топливо."),

  S("quarries", "Каменоломни", "Добыча", ["stone", "construction"], ["tools", "fuel"], "Строительный и отделочный камень."),
  S("clay-pits", "Глиняные карьеры", "Добыча", ["clay", "mineral"], ["tools"], "Глина для кирпича и керамики."),
  S("sand-pits", "Песчаные разработки", "Добыча", ["sand", "glass"], ["tools"], "Песок для стекольного и строительного производства."),
  S("iron-mines", "Железные рудники", "Добыча", ["iron", "ore", "metal"], ["fuel", "tools", "wood"], "Железная руда и сырой металл."),
  S("nonferrous-mines", "Рудники цветных металлов", "Добыча", ["copper", "tin", "lead", "metal", "ore"], ["fuel", "tools", "wood"], "Медь, олово, свинец и сопутствующие руды."),
  S("precious-metals", "Добыча драгоценных металлов", "Добыча", ["gold", "silver", "precious-metal"], ["fuel", "tools", "food"], "Дорогой металл при высоком местном спросе на снабжение."),
  S("coal-mines", "Угольные шахты", "Добыча", ["coal", "fuel"], ["wood", "tools", "food"], "Каменный уголь для индустрии и транспорта."),
  S("crystal-mines", "Кристаллические месторождения", "Добыча", ["crystal", "mineral"], ["tools", "fuel", "explosive"], "Сырые кристаллы и кристаллическая пыль."),
  S("rare-minerals", "Редкие минералы", "Добыча", ["rare-mineral", "chemical", "mineral"], ["tools", "fuel"], "Редкое сырьё для химии и точной промышленности."),
  S("salvage-yard", "Разбор руин и обломков", "Добыча", ["salvage", "metal", "machine-parts"], ["tools"], "Вторичные материалы с высокой непредсказуемостью.", { outputVolatilityFactor: 1.45 }),

  S("mills-bakeries", "Мельницы и пекарни", "Пищевая переработка", ["flour", "bread", "food.processed"], ["grain", "fuel"], "Переработка зерна в муку и хлеб."),
  S("slaughterhouses", "Бойни", "Пищевая переработка", ["meat", "hide"], ["salt", "fuel"], "Мясо, кожа и животные жиры."),
  S("smokehouses", "Коптильни и засолка", "Пищевая переработка", ["preserved-food", "preserved-fish", "meat"], ["salt", "wood", "fuel", "barrel"], "Долгохранящиеся припасы для дальних маршрутов."),
  S("dairy-processing", "Молочная переработка", "Пищевая переработка", ["cheese", "butter", "dairy"], ["milk", "salt", "fuel"], "Сыры, масло и иные устойчивые молочные продукты."),
  S("breweries", "Пивоварение", "Пищевая переработка", ["beer", "alcohol"], ["grain", "hops", "water", "fuel", "barrel"], "Местное пиво и солодовые напитки."),
  S("wineries", "Виноделие", "Пищевая переработка", ["wine", "alcohol"], ["grapes", "glass", "barrel"], "Вино и виноградные продукты.", { offers: [{ id: "specialty-wine", resourceId: "alcohol-wine-fine-weak", name: "Местное вино", kind: "consumable", priceFactor: 1.2, baseStock: 70, volatility: 0.3, ubiquity: "specialized", forceAvailable: true, tags: ["wine", "alcohol", "fine"] }] }),
  S("distilleries", "Винокурение", "Пищевая переработка", ["spirits", "alcohol", "medicinal-alcohol"], ["grain", "fruit", "fuel", "glass"], "Крепкий алкоголь и технический спирт."),
  S("canning", "Консервное производство", "Пищевая переработка", ["preserved-food", "canned-food"], ["food.raw", "metal", "fuel"], "Индустриальная консервация продовольствия."),

  S("sawmills", "Лесопилки", "Промышленность", ["lumber", "wood", "construction"], ["wood", "tools", "fuel"], "Подготовленный строевой лес и доски."),
  S("carpentry", "Столярное производство", "Промышленность", ["furniture", "woodwork", "construction"], ["wood", "glue", "tools"], "Мебель, ящики, бочки и строительные детали."),
  S("tanneries", "Кожевни", "Промышленность", ["leather", "hide"], ["hide", "salt", "alum", "water"], "Обработанная кожа и ременные изделия."),
  S("wool-textiles", "Шерстяные мастерские", "Промышленность", ["wool", "cloth", "textile"], ["wool", "dye", "fuel"], "Шерстяные ткани и сукно."),
  S("linen-textiles", "Льняные мастерские", "Промышленность", ["linen", "cloth", "textile"], ["flax", "dye", "water"], "Полотно, нити и бытовая ткань."),
  S("silk-textiles", "Шёлковые мастерские", "Промышленность", ["silk", "luxury", "textile"], ["silk", "chemical"], "Дорогие лёгкие ткани."),
  S("dyehouses", "Красильни", "Промышленность", ["dyed-cloth", "dye", "textile"], ["cloth", "indigo", "madder", "alum", "fuel"], "Крашеные ткани и красильные составы."),
  S("rope-sailcloth", "Канатные и парусные мастерские", "Промышленность", ["rope", "sailcloth", "ship-supply"], ["hemp", "flax", "cloth", "tar"], "Снабжение флота и портов."),
  S("pottery", "Гончарное производство", "Промышленность", ["household", "masonry"], ["clay", "fuel"], "Посуда, трубы и хозяйственная керамика."),
  S("brickworks", "Кирпичные заводы", "Промышленность", ["brick", "construction"], ["clay", "fuel"], "Массовый строительный кирпич."),
  S("glassworks", "Стекольное производство", "Промышленность", ["glass", "chemical-container"], ["sand", "fuel", "ash"], "Оконное, бутылочное и лабораторное стекло."),
  S("paper-parchment", "Бумага и пергамент", "Промышленность", ["paper", "parchment", "administration"], ["wood", "cloth", "hide", "water"], "Письменные материалы для торговли и управления."),
  S("printing", "Типографии", "Промышленность", ["book", "printed", "administration"], ["paper", "ink", "metal"], "Книги, ведомости, карты и бланки."),
  S("forges", "Кузницы", "Промышленность", ["tools", "metalwork"], ["iron", "fuel", "wood"], "Обычный инструмент, крепёж и ремонт."),
  S("foundries", "Литейные мастерские", "Промышленность", ["metal", "machine-parts", "weapon"], ["ore", "iron", "coal", "charcoal"], "Крупное литьё и металлические заготовки."),
  S("toolworks", "Инструментальное производство", "Промышленность", ["tools", "precision-tools"], ["metal", "wood", "fuel"], "Ручной и специализированный инструмент."),
  S("machinery", "Машинные мастерские", "Промышленность", ["machine-parts", "machinery"], ["metal", "fuel", "tools"], "Механизмы, передачи и запасные части."),
  S("weapons", "Оружейное производство", "Промышленность", ["weapon", "ammunition"], ["metal", "wood", "fuel", "chemical"], "Вооружение и боеприпасы, часто лицензируемые."),
  S("chemical-industry", "Химическая отрасль", "Промышленность", ["chemical", "acid", "dye", "reagent"], ["fuel", "glass", "salt", "mineral", "herbs"], "Реактивы, кислоты, красители и технические составы."),
  S("pharmaceuticals", "Аптекарское производство", "Промышленность", ["medicine", "medicinal"], ["herbs", "alcohol", "glass", "chemical"], "Лекарства, перевязочные материалы и медицинские составы."),
  S("explosives", "Порох и взрывчатые вещества", "Промышленность", ["gunpowder", "explosive", "ammunition"], ["charcoal", "sulfur", "saltpeter", "chemical"], "Опасные и обычно контролируемые товары."),
  S("crystal-refining", "Обработка кристаллов", "Промышленность", ["crystal", "crystal-component"], ["crystal", "fuel", "chemical", "precision-tools"], "Огранка, очистка и подготовка кристаллов."),

  S("shipyard", "Обычная верфь", "Кораблестроение", ["ship-component", "ship-supply"], ["wood", "metal", "rope", "cloth", "resin"], "Строительство и оснащение обычных судов."),
  S("crystal-shipyard", "Кристаллическая верфь", "Кораблестроение", ["ship-core", "crystal", "shipbuilding"], ["crystal", "metal", "glass", "fuel", "chemical"], "Ядра и сложные узлы кристаллических кораблей.", { offers: [{ id: "specialty-crystal-ship-core", resourceId: "crystal-core", name: "Кристаллическое ядро", kind: "material", priceFactor: 1.25, baseStock: 3, volatility: 0.45, ubiquity: "restricted", forceAvailable: true, tags: ["ship-core", "crystal", "strategic", "shipbuilding"] }] }),
  S("naval-arsenal", "Военно-морской арсенал", "Кораблестроение", ["weapon", "ammunition", "ship-component"], ["metal", "fuel", "chemical", "wood"], "Военное снабжение и ремонт вооружённых кораблей."),
  S("repair-docks", "Ремонтные доки", "Кораблестроение", ["component", "shipbuilding"], ["wood", "metal", "rope", "tools"], "Ремонтные материалы и запасные части."),
  S("air-harbor", "Воздушная гавань", "Логистика", ["ship-supply", "travel-supply"], ["fuel", "food", "water", "rope"], "Регулярные воздушные рейсы и снабжение экипажей."),
  S("warehouses", "Складской квартал", "Логистика", ["all"], [], "Большие партии и более стабильные запасы.", { outputStockFactor: 1.25, outputPriceFactor: 0.98, outputVolatilityFactor: 0.8 }),
  S("wholesale-hub", "Оптовый распределительный центр", "Логистика", ["all"], [], "Широкий ассортимент привозных товаров.", { outputStockFactor: 1.45, outputPriceFactor: 0.96, outputVolatilityFactor: 0.85 }),
  S("rail-junction", "Железнодорожный узел", "Логистика", ["fuel", "metal", "machine-parts", "bulk"], [], "Высокая пропускная способность для тяжёлых грузов."),
  S("caravanserai", "Караванный двор", "Логистика", ["food", "water", "cloth", "leather", "travel-supply"], ["grain", "fodder"], "Снабжение сухопутной торговли."),
  S("transshipment-port", "Перевалочный порт", "Логистика", ["import", "ship-supply", "all"], [], "Транзитные и импортные партии.", { outputStockFactor: 1.3, outputPriceFactor: 0.98 }),
  S("ship-salvage", "Рынок корабельных обломков", "Логистика", ["salvage", "ship-component", "metal", "crystal"], ["tools"], "Непредсказуемые подержанные узлы и материалы.", { outputVolatilityFactor: 1.55 }),

  S("capital", "Столица", "Город и институты", ["administration", "luxury", "all"], ["food", "paper", "luxury"], "Широкий ассортимент и высокий городской спрос.", { outputStockFactor: 1.2, outputPriceFactor: 1 }),
  S("court", "Двор и знать", "Город и институты", ["luxury", "wine", "silk", "art"], ["food", "luxury"], "Рынок дорогих и демонстративных товаров."),
  S("garrison", "Военный гарнизон", "Город и институты", ["weapon", "ammunition", "uniform"], ["food", "cloth", "leather", "metal"], "Военный спрос и лицензируемое снабжение."),
  S("fortress", "Крепость", "Город и институты", ["weapon", "construction"], ["food", "fuel", "metal", "stone"], "Высокий спрос на припасы и укрепления."),
  S("university", "Университет", "Город и институты", ["book", "paper", "instrument", "chemical"], ["paper", "glass", "chemical"], "Книги, научные приборы и реактивы."),
  S("religious-center", "Религиозный центр", "Город и институты", ["candle", "incense", "art"], ["food", "wax", "cloth"], "Религиозные товары и устойчивый поток посетителей."),
  S("pilgrimage", "Место паломничества", "Город и институты", ["food", "souvenir", "candle"], ["food", "cloth"], "Сезонный массовый спрос на простые товары."),
  S("hospital", "Крупная больница", "Город и институты", ["medicine", "bandage"], ["medicinal", "cloth", "alcohol", "food"], "Медицинский спрос и подготовка расходников."),
  S("financial-center", "Финансовый центр", "Город и институты", ["paper", "luxury", "import"], [], "Кредит, страхование и крупные оптовые сделки."),
  S("border-town", "Пограничный город", "Город и институты", ["consumer", "ship-supply"], ["food", "weapon"], "Смешанный ассортимент и повышенная волатильность.", { outputVolatilityFactor: 1.25 }),
  S("boomtown", "Шахтёрский город", "Город и институты", ["ore", "mineral"], ["food", "tools", "cloth", "alcohol"], "Экспорт сырья и дорогие привозные товары."),
  S("frontier", "Фронтирное поселение", "Город и институты", ["hide", "herbs", "salvage"], ["food", "tools", "weapon"], "Узкий ассортимент, высокие риски и привозное снабжение."),

  S("free-port", "Свободный порт", "Торговый режим", ["all", "import"], [], "Пониженные барьеры и широкий импорт.", { outputStockFactor: 1.35, outputPriceFactor: 0.95 }),
  S("guild-regulation", "Гильдейское регулирование", "Торговый режим", ["all"], [], "Стабильное качество при умеренной гильдейской наценке.", { outputStockFactor: 0.95, outputPriceFactor: 1.05, outputVolatilityFactor: 0.75 }),
  S("state-monopoly", "Государственная монополия", "Торговый режим", ["all"], [], "Контролируемое предложение и административная наценка.", { outputStockFactor: 0.82, outputPriceFactor: 1.12, outputVolatilityFactor: 0.7 }),
  S("charter-monopoly", "Чартерная монополия", "Торговый режим", ["all"], [], "Выделенная организация контролирует основную часть торговли.", { outputStockFactor: 0.86, outputPriceFactor: 1.1, outputVolatilityFactor: 0.75 }),
  S("export-quota", "Экспортные квоты", "Торговый режим", ["strategic", "food", "fuel"], [], "Ограниченный внешний отпуск ключевых товаров.", { outputStockFactor: 0.65, outputPriceFactor: 1.18 }),
  S("strategic-licenses", "Лицензирование стратегических товаров", "Торговый режим", ["weapon", "explosive", "crystal", "ship-core"], [], "Стратегические товары доступны малыми партиями.", { outputStockFactor: 0.45, outputPriceFactor: 1.25 }),
  S("rationing", "Нормирование", "Торговый режим", ["food", "fuel", "medicine"], [], "Ограниченные партии предметов первой необходимости.", { outputStockFactor: 0.55, outputPriceFactor: 1.08 }),
  S("black-market", "Контрабандный рынок", "Торговый режим", ["restricted", "contraband", "weapon", "medicine"], [], "Редкие и запрещённые товары по высокой и нестабильной цене.", { outputStockFactor: 0.4, outputPriceFactor: 1.5, outputVolatilityFactor: 1.65 }),

  S("reconstruction-market", "Рынок восстановления", "Торговый режим", ["component", "masonry", "metalwork"], ["construction", "tools", "food", "fuel"], "Послевоенный рынок с высоким спросом на всё необходимое для восстановления.", { outputStockFactor: 1.2, inputStockFactor: 0.7, inputPriceFactor: 1.2 }),
  S("grain-belt", "Зерновой пояс", "Сельское хозяйство", ["grain", "flour", "food.raw"], ["tools", "fuel"], "Крупная зерновая специализация с устойчивыми оптовыми партиями.", { outputStockFactor: 2.5, outputPriceFactor: 0.82 }),
  S("rice-belt", "Рисовый пояс", "Сельское хозяйство", ["rice", "grain", "food.raw"], ["tools", "water"], "Заливное земледелие и большие партии риса.", { outputStockFactor: 2.4, outputPriceFactor: 0.84 }),
  S("livestock-market", "Скотный рынок", "Сельское хозяйство", ["meat", "hide", "leather", "livestock"], ["grain", "salt"], "Региональный оборот живого скота и продуктов животноводства."),
  S("horse-market", "Конный рынок", "Сельское хозяйство", ["horse", "livestock", "leather"], ["grain", "fodder", "metal"], "Лошади, упряжь, седельные и походные товары."),
  S("wool-center", "Центр шерстяной торговли", "Промышленность", ["wool", "cloth", "textile"], ["dye", "fuel"], "Сбор шерсти и производство массового сукна."),
  S("timber-district", "Лесопромышленный округ", "Промыслы", ["wood", "lumber", "resin"], ["tools", "food"], "Лесозаготовка, пиломатериалы и смолы."),
  S("fur-trade", "Пушная торговля", "Промыслы", ["fur", "hide", "luxury"], ["food", "tools", "weapon"], "Пушнина и выделанные шкуры дальних промыслов.", { outputVolatilityFactor: 1.15 }),
  S("coal-basin", "Угольный бассейн", "Добыча", ["coal", "fuel"], ["wood", "tools", "food"], "Крупный индустриальный район добычи каменного угля.", { outputStockFactor: 2.4, outputPriceFactor: 0.84 }),
  S("scrap-yards", "Рынки лома", "Добыча", ["salvage", "scrap", "metal", "machine-parts"], ["tools"], "Разбор техники, руин и корабельных обломков.", { outputVolatilityFactor: 1.5 }),
  S("foundry-cluster", "Литейный кластер", "Промышленность", ["metal", "ingot", "machine-parts"], ["ore", "coal", "charcoal"], "Группа домен, литейных и прокатных мастерских.", { outputStockFactor: 1.8, outputPriceFactor: 0.9 }),
  S("toolmaking", "Инструментальные мастерские", "Промышленность", ["tools", "precision-tools", "metalwork"], ["metal", "wood", "fuel"], "Центр изготовления обычного и точного инструмента."),
  S("instrument-making", "Приборостроение", "Промышленность", ["instrument", "precision-tools", "glass"], ["metal", "glass", "chemical"], "Научные, навигационные и измерительные приборы."),
  S("arms-manufacture", "Оружейный кластер", "Промышленность", ["weapon", "ammunition", "uniform"], ["metal", "wood", "chemical", "fuel"], "Серийное производство оружия и военного снаряжения."),
  S("textile-district", "Текстильный район", "Промышленность", ["cloth", "textile", "thread"], ["wool", "flax", "dye", "fuel"], "Разнообразные ткацкие, прядильные и красильные производства."),
  S("printing-quarter", "Печатный квартал", "Промышленность", ["book", "printed", "map", "administration"], ["paper", "ink", "metal"], "Типографии, переплётчики, картографы и торговцы печатной продукцией."),
  S("wine-cellars", "Винные погреба", "Пищевая переработка", ["wine", "alcohol", "luxury"], ["glass", "barrel"], "Выдержка, хранение и оптовая торговля вином.", { outputVolatilityFactor: 0.75 }),
  S("book-market", "Книжный рынок", "Город и институты", ["book", "paper", "printed", "map"], ["paper", "ink"], "Книготорговцы, переписчики, издатели и продавцы карт."),
  S("monastery-workshops", "Монастырские мастерские", "Город и институты", ["candle", "medicine", "book", "wine", "craft"], ["wax", "herbs", "paper", "food"], "Небольшое, но устойчивое производство при религиозных общинах."),
  S("pilgrimage-center", "Паломнический центр", "Город и институты", ["candle", "souvenir", "food", "lodging"], ["food", "cloth", "wax"], "Массовый поток паломников и сезонный спрос."),
  S("university-town", "Университетский город", "Город и институты", ["book", "instrument", "chemical", "paper"], ["food", "paper", "glass"], "Городская экономика вокруг обучения, исследований и студентов."),
  S("capital-market", "Столичный рынок", "Город и институты", ["administration", "luxury", "import", "all"], ["food", "fuel", "paper"], "Крупный административный рынок с широким импортом.", { outputStockFactor: 1.35, outputVolatilityFactor: 0.85 }),
  S("luxury-quarter", "Квартал роскоши", "Город и институты", ["luxury", "art", "wine", "silk", "jewelry"], ["luxury"], "Высокие цены и устойчивый спрос знати и богатых горожан.", { outputPriceFactor: 1.15 }),
  S("international-fair", "Международная ярмарка", "Город и институты", ["all", "import", "luxury"], [], "Периодический приток редких товаров и иностранных торговцев.", { outputStockFactor: 1.45, outputPriceFactor: 0.98, outputVolatilityFactor: 1.2 }),
  S("naval-base", "Военно-морская база", "Кораблестроение", ["ship-supply", "weapon", "ammunition", "repair-parts"], ["food", "fuel", "metal", "wood"], "Военный порт с ремонтом и снабжением флота."),
  S("military-depot", "Военный склад", "Город и институты", ["weapon", "ammunition", "uniform", "preserved-food"], ["food", "cloth", "metal", "chemical"], "Контролируемый оборот армейских запасов и реквизиционный спрос."),
  S("railway-junction", "Крупный железнодорожный узел", "Логистика", ["bulk", "fuel", "metal", "machine-parts", "all"], [], "Сортировочные станции и склады тяжёлых грузов.", { outputStockFactor: 1.35, outputPriceFactor: 0.96 }),
  S("remote-outpost", "Удалённый торговый пост", "Город и институты", ["fur", "hide", "herbs", "salvage"], ["food", "fuel", "tools", "medicine"], "Малый рынок на конце длинной и рискованной линии снабжения.", { inputStockFactor: 0.55, inputPriceFactor: 1.3 })
];

export function normalizeMarketRule(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const mode = RULE_MODES.has(String(source.mode ?? "")) ? String(source.mode) : "adjust";
  return {
    id: String(source.id ?? "").trim() || `market-rule-${index + 1}`,
    label: String(source.label ?? source.name ?? "Правило").trim().slice(0, 300) || "Правило",
    active: toBoolean(source.active, true),
    mode,
    targetTags: stringList(source.targetTags ?? source.tags),
    resourceIds: stringList(source.resourceIds ?? source.resources),
    stockFactor: bounded(source.stockFactor, mode === "produce" ? 2 : (mode === "consume" ? 0.82 : 1), 0, 20),
    priceFactor: bounded(source.priceFactor, mode === "produce" ? 0.88 : (mode === "consume" ? 1.14 : 1), 0.05, 20),
    volatilityFactor: bounded(source.volatilityFactor, 1, 0, 5),
    notes: String(source.notes ?? source.description ?? "").trim().slice(0, 2000)
  };
}

function normalizeRules(rows = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizeMarketRule(raw, result.length);
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result.slice(0, 200);
}

export function normalizeMarketSizeProfile(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const maxUbiquity = ["essential", "common", "ordinary", "specialized", "restricted"].includes(String(source.maxUbiquity ?? "")) ? String(source.maxUbiquity) : "ordinary";
  return {
    id: String(source.id ?? "").trim() || `market-size-${index + 1}`,
    label: String(source.label ?? source.name ?? "Размер рынка").trim().slice(0, 300),
    description: String(source.description ?? "").trim().slice(0, 2000),
    active: toBoolean(source.active, true),
    maxUbiquity,
    stockFactor: bounded(source.stockFactor, 1, 0.05, 20),
    priceFactor: bounded(source.priceFactor, 1, 0.05, 20),
    handlingFactor: bounded(source.handlingFactor, 1, 0.05, 20)
  };
}

export function normalizeMarketCondition(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  return {
    id: String(source.id ?? "").trim() || `market-condition-${index + 1}`,
    label: String(source.label ?? source.name ?? "Состояние рынка").trim().slice(0, 300),
    description: String(source.description ?? "").trim().slice(0, 2000),
    active: toBoolean(source.active, true),
    priceFactor: bounded(source.priceFactor, 1, 0.05, 20),
    stockFactor: bounded(source.stockFactor, 1, 0, 20),
    deliveryFactor: bounded(source.deliveryFactor, 1, 0.05, 20),
    timeFactor: bounded(source.timeFactor, 1, 0.05, 20),
    riskFactor: bounded(source.riskFactor, 1, 0.05, 20),
    volatilityFactor: bounded(source.volatilityFactor, 1, 0, 5)
  };
}

function normalizeOffers(rows = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const offer = normalizeMarketOffer(raw, result.length);
    if (seen.has(offer.id)) continue;
    seen.add(offer.id);
    result.push(offer);
  }
  return result.slice(0, 1000);
}

export function normalizeMarketSpecialty(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  return {
    id: String(source.id ?? "").trim() || `market-specialty-${index + 1}`,
    label: String(source.label ?? source.name ?? "Специализация").trim().slice(0, 300),
    category: String(source.category ?? "Прочее").trim().slice(0, 160),
    description: String(source.description ?? "").trim().slice(0, 3000),
    active: toBoolean(source.active, true),
    rules: normalizeRules(source.rules),
    offers: normalizeOffers(source.offers),
    contentVersion: Math.max(1, Math.floor(toNumber(source.contentVersion ?? source.version, 1))),
    contentSource: String(source.contentSource ?? source.source ?? "").trim().slice(0, 300)
  };
}

export function normalizeMarketCountry(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const label = String(source.label ?? source.name ?? source.id ?? `Государство ${index + 1}`).trim();
  return {
    id: String(source.id ?? source.value ?? "").trim() || slug(label, `country-${index + 1}`),
    label: label.slice(0, 300),
    active: toBoolean(source.active, true),
    visibility: VISIBILITY.has(String(source.visibility ?? "")) ? String(source.visibility) : "public",
    description: String(source.description ?? source.marketNotes ?? "").trim().slice(0, 4000),
    conditionId: String(source.conditionId ?? source.marketConditionId ?? source.marketStatus ?? "stable").trim() || "stable",
    tradeRegime: String(source.tradeRegime ?? "open").trim().slice(0, 120) || "open",
    taxRate: bounded(source.taxRate ?? source.marketTaxRate, 0, 0, 1),
    exportTaxRate: bounded(source.exportTaxRate, 0, 0, 1),
    priceFactor: bounded(source.priceFactor ?? source.marketPriceFactor, 1, 0.05, 20),
    stockFactor: bounded(source.stockFactor ?? source.marketAvailabilityFactor, 1, 0, 20),
    deliveryFactor: bounded(source.deliveryFactor ?? source.marketDeliveryFactor, 1, 0.05, 20),
    timeFactor: bounded(source.timeFactor ?? source.marketTimeFactor, 1, 0.05, 20),
    riskFactor: bounded(source.riskFactor ?? source.marketRiskFactor, 1, 0.05, 20),
    rules: normalizeRules(source.rules ?? source.characterRules),
    offers: normalizeOffers(source.offers),
    tags: stringList(source.tags),
    contentVersion: Math.max(1, Math.floor(toNumber(source.contentVersion ?? source.version, 1))),
    contentSource: String(source.contentSource ?? source.source ?? "").trim().slice(0, 300)
  };
}

function normalizeCountryShares(rows = []) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const source = raw && typeof raw === "object" ? raw : {};
    const countryId = String(source.countryId ?? source.regionId ?? source.id ?? "").trim();
    if (!countryId || seen.has(countryId)) continue;
    seen.add(countryId);
    const rawModeShares = source.modeShares && typeof source.modeShares === "object" ? source.modeShares : {};
    result.push({
      countryId,
      sharePct: bounded(source.sharePct ?? source.share ?? source.marketShare, 0, 0, 100),
      modeShares: Object.fromEntries(["caravan", "rail", "airship"].map((mode) => {
        const value = rawModeShares[mode] ?? source[`${mode}SharePct`];
        return [mode, value === undefined || value === null || value === "" ? null : bounded(value, 0, 0, 100)];
      })),
      active: toBoolean(source.active, true)
    });
  }
  return result.slice(0, 200);
}

export function normalizeMarketOrganization(row = {}, index = 0) {
  const source = row && typeof row === "object" ? row : {};
  const label = String(source.label ?? source.name ?? source.id ?? `Организация ${index + 1}`).trim();
  const merchantSource = source.merchant && typeof source.merchant === "object" ? source.merchant : {};
  const buyerSource = source.buyer && typeof source.buyer === "object" ? source.buyer : {};
  const carrierSource = source.carrier && typeof source.carrier === "object" ? source.carrier : {};
  return {
    id: String(source.id ?? "").trim() || slug(label, `organization-${index + 1}`),
    label: label.slice(0, 300),
    active: toBoolean(source.active, true),
    visibility: VISIBILITY.has(String(source.visibility ?? "")) ? String(source.visibility) : "public",
    description: String(source.description ?? "").trim().slice(0, 4000),
    icon: String(source.icon ?? "fa-solid fa-building-columns").trim().slice(0, 200),
    tags: stringList(source.tags),
    merchant: {
      enabled: toBoolean(merchantSource.enabled ?? source.merchantEnabled, false),
      countryShares: normalizeCountryShares(merchantSource.countryShares ?? source.merchantCountryShares ?? source.countryShares),
      includeTags: stringList(merchantSource.includeTags ?? merchantSource.specialtyTags),
      excludeTags: stringList(merchantSource.excludeTags),
      priceFactor: bounded(merchantSource.priceFactor, 1, 0.5, 2),
      priceVolatility: bounded(merchantSource.priceVolatility, 0.04, 0, 0.3),
      stockStability: bounded(merchantSource.stockStability, 1, 0.25, 2)
    },
    buyer: {
      enabled: toBoolean(buyerSource.enabled ?? source.buyerEnabled, false),
      countryShares: normalizeCountryShares(buyerSource.countryShares ?? source.buyerCountryShares),
      includeTags: stringList(buyerSource.includeTags ?? buyerSource.specialtyTags),
      excludeTags: stringList(buyerSource.excludeTags)
    },
    carrier: {
      enabled: toBoolean(carrierSource.enabled ?? source.carrierEnabled, false),
      countryShares: normalizeCountryShares(carrierSource.countryShares ?? source.carrierCountryShares),
      modes: normalizedModes(carrierSource.modes ?? source.transportModes),
      priceFactor: bounded(carrierSource.priceFactor, 1, 0.5, 3),
      timeFactor: bounded(carrierSource.timeFactor, 1, 0.5, 3),
      riskFactor: bounded(carrierSource.riskFactor, 1, 0.25, 3),
      capacityFactor: bounded(carrierSource.capacityFactor, 1, 0.1, 5)
    },
    contentVersion: Math.max(1, Math.floor(toNumber(source.contentVersion ?? source.version, 1))),
    contentSource: String(source.contentSource ?? source.source ?? "").trim().slice(0, 300)
  };
}

function uniqueRows(rows, normalizer, limit = 1000) {
  const result = [];
  const seen = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = normalizer(raw, result.length);
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row);
  }
  return result.slice(0, limit);
}

function derivedCountries(locations = []) {
  const result = [];
  const seen = new Set();
  for (const location of Array.isArray(locations) ? locations : []) {
    const id = String(location?.countryId ?? location?.value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(normalizeMarketCountry({
      id,
      label: String(location?.countryLabel ?? location?.label ?? id),
      conditionId: String(location?.marketStatus ?? "stable"),
      taxRate: location?.marketTaxRate,
      priceFactor: location?.marketPriceFactor,
      stockFactor: location?.marketAvailabilityFactor,
      deliveryFactor: location?.marketDeliveryFactor,
      timeFactor: location?.marketTimeFactor,
      riskFactor: location?.marketRiskFactor,
      description: location?.marketNotes
    }, result.length));
  }
  return result;
}

export function createDefaultMarketEconomy(locations = []) {
  return normalizeMarketEconomy({
    schemaVersion: 3,
    settings: {
      quotePeriodDays: 10,
      deliveryMode: "scheduled",
      baseDeliveryQd: 2,
      deliveryDistanceCopper: 0,
      deliveryLoadDistanceCopper: 0,
      airshipHireCopper: 120,
      caravanCapacityLoad: 400,
      railCapacityLoad: 8000,
      airshipCapacityLoad: 4000,
      handlingFlatCopper: 8,
      handlingSubtotalRate: 0.02,
      handlingLoadCopper: 1
    },
    baseOffers: clone(DEFAULT_MARKET_BASE_OFFERS),
    sizeProfiles: clone(DEFAULT_MARKET_SIZE_PROFILES),
    conditions: clone(DEFAULT_MARKET_CONDITIONS),
    specialties: clone(DEFAULT_MARKET_SPECIALTIES),
    countries: derivedCountries(locations),
    organizations: []
  }, { locations });
}

export function normalizeMarketEconomy(source = null, { locations = [] } = {}) {
  const hasSource = source && typeof source === "object" && !Array.isArray(source);
  const row = hasSource ? source : {};
  const settings = row.settings && typeof row.settings === "object" ? row.settings : {};
  const sourceSchemaVersion = Math.max(1, Math.floor(toNumber(row.schemaVersion, 1)));
  const hasLegacyCapacityDefaults = sourceSchemaVersion < 2
    && Number(settings.caravanCapacityLoad) === 80
    && Number(settings.railCapacityLoad) === 480
    && Number(settings.airshipCapacityLoad) === 200;
  const baseOffers = Array.isArray(row.baseOffers) ? row.baseOffers : DEFAULT_MARKET_BASE_OFFERS;
  const sizeProfiles = Array.isArray(row.sizeProfiles) ? row.sizeProfiles : DEFAULT_MARKET_SIZE_PROFILES;
  const conditions = Array.isArray(row.conditions) ? row.conditions : DEFAULT_MARKET_CONDITIONS;
  const specialties = Array.isArray(row.specialties) ? row.specialties : DEFAULT_MARKET_SPECIALTIES;
  const countries = Array.isArray(row.countries) && row.countries.length ? row.countries : derivedCountries(locations);
  return {
    schemaVersion: 3,
    settings: {
      quotePeriodDays: Math.floor(bounded(settings.quotePeriodDays, 10, 1, 365)),
      deliveryMode: String(settings.deliveryMode ?? "scheduled") === "instant" ? "instant" : "scheduled",
      baseDeliveryQd: Math.floor(bounded(settings.baseDeliveryQd, 2, 1, 1460)),
      deliveryDistanceCopper: bounded(settings.deliveryDistanceCopper, 0, 0, 1_000_000),
      deliveryLoadDistanceCopper: bounded(settings.deliveryLoadDistanceCopper, 0, 0, 1_000_000),
      airshipHireCopper: bounded(settings.airshipHireCopper, 120, 0, 10_000_000),
      caravanCapacityLoad: hasLegacyCapacityDefaults ? 400 : bounded(settings.caravanCapacityLoad, 400, 1, 1_000_000),
      railCapacityLoad: hasLegacyCapacityDefaults ? 8000 : bounded(settings.railCapacityLoad, 8000, 1, 1_000_000),
      airshipCapacityLoad: hasLegacyCapacityDefaults ? 4000 : bounded(settings.airshipCapacityLoad, 4000, 1, 1_000_000),
      handlingFlatCopper: bounded(settings.handlingFlatCopper, 8, 0, 1_000_000),
      handlingSubtotalRate: bounded(settings.handlingSubtotalRate, 0.02, 0, 0.4),
      handlingLoadCopper: bounded(settings.handlingLoadCopper, 1, 0, 1_000_000)
    },
    baseOffers: normalizeOffers(baseOffers),
    sizeProfiles: uniqueRows(sizeProfiles, normalizeMarketSizeProfile, 100),
    conditions: uniqueRows(conditions, normalizeMarketCondition, 100),
    specialties: uniqueRows(specialties, normalizeMarketSpecialty, 500),
    countries: uniqueRows(countries, normalizeMarketCountry, 300),
    organizations: uniqueRows(Array.isArray(row.organizations) ? row.organizations : [], normalizeMarketOrganization, 500)
  };
}

export function marketEconomySummary(source = null, locations = []) {
  const economy = normalizeMarketEconomy(source, { locations });
  return {
    baseOfferCount: economy.baseOffers.filter((row) => row.active).length,
    countryCount: economy.countries.filter((row) => row.active).length,
    locationCount: (locations ?? []).filter((row) => row?.marketEnabled !== false).length,
    specialtyCount: economy.specialties.filter((row) => row.active).length,
    organizationCount: economy.organizations.filter((row) => row.active).length,
    merchantCount: economy.organizations.filter((row) => row.active && row.merchant.enabled).length,
    buyerCount: economy.organizations.filter((row) => row.active && row.buyer.enabled).length,
    carrierCount: economy.organizations.filter((row) => row.active && row.carrier.enabled).length
  };
}
