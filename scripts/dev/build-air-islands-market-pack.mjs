import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDefaultMarketEconomy, DEFAULT_MARKET_BASE_OFFERS, DEFAULT_MARKET_CONDITIONS, DEFAULT_MARKET_SIZE_PROFILES, DEFAULT_MARKET_SPECIALTIES } from "../data/market/economy.js";
import { parseCurrencyCopper } from "../core/currency.js";
import { BUILTIN_RESOURCE_DEFS, normalizeResourceCatalogRow } from "../core/resources.js";
import { canonicalResourceId } from "../data/resources/resource-id-migration.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const libraryPath = path.join(root, "examples/content-packs/air-islands-materials-and-country-markets.json");
const networkPath = path.join(root, "examples/content-packs/air-islands-trade-network-template.json");
const library = JSON.parse(readFileSync(libraryPath, "utf8"));
const previousNetwork = JSON.parse(readFileSync(networkPath, "utf8"));
const LIBRARY_SOURCE = "fbl-skyhold.air-islands-market-library";
const NETWORK_SOURCE = "fbl-skyhold.air-islands-trade-template";
const CONTENT_VERSION = 14;
const KM_PER_PIXEL = 600 / 874;

const hasOwn = (row, key) => Object.prototype.hasOwnProperty.call(row ?? {}, key);
const optionalNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const legacyOfferLoadPoints = (offer = {}) => {
  if (hasOwn(offer, "loadOverridePoints")) return optionalNumber(offer.loadOverridePoints);
  const unitLoad = optionalNumber(offer.load) ?? optionalNumber(offer.weight);
  return unitLoad === null ? null : Math.max(0, Math.round(unitLoad * 4));
};
const builtinResourcesById = new Map(BUILTIN_RESOURCE_DEFS.map((row) => {
  const normalized = normalizeResourceCatalogRow(row);
  return [normalized.id, normalized];
}));
const resourcesById = new Map([...builtinResourcesById]
  .filter(([id]) => id !== "money")
  .map(([id, row]) => [id, { ...row, contentSource: LIBRARY_SOURCE, contentVersion: CONTENT_VERSION }]));
library.content.resources = [...resourcesById.values()];

const historicSource = (resourceId) => {
  if (["crystal-core", "lift-crystal", "aether-crystal", "crystal-dust", "rare-wood"].includes(resourceId)) return "Фэнтезийный аналог отсутствует; цена выведена из редкости, стратегической роли и трудоёмкости.";
  if (["coal", "coke", "pig-iron", "wrought-iron", "steel", "copper", "lead", "zinc", "tin"].includes(resourceId)) return "NBER Macrohistory IV: coal, pig iron and non-ferrous metal price series, 1842–1916.";
  if (["rye", "rice", "barley", "oats", "potatoes", "wine", "grapes", "fish", "preserved-meat", "canned-food"].includes(resourceId)) return "NBER Macrohistory IV food and grain series; BLS historical wholesale-price framework, 1840–1901.";
  if (["cotton", "silk", "flax", "hemp", "linen-cloth", "cotton-cloth", "tsukami-fiber"].includes(resourceId)) return "NBER Macrohistory IV textile import/export and cotton-yarn price series, 1870–1913.";
  if (["machine-parts", "tools", "telegraph-components", "copper-wire", "electrical-parts", "cartridges"].includes(resourceId)) return "BLS Wholesale Prices 1840–1901 manufactured-goods framework; game-scaled industrial baseline.";
  return "NBER Macrohistory IV commodity-price series and BLS Wholesale Prices 1840–1901; game-scaled baseline.";
};

const ABSTRACT_PRICE_BASIS = "Цена указана за одну абстрактную ед. игрового ресурса.";
const abstractOfferUnit = (offer = {}) => ({ ...offer, unit: "ед.", priceBasis: ABSTRACT_PRICE_BASIS });

const canonicalResourcesById = new Map(builtinResourcesById);
for (const resource of resourcesById.values()) canonicalResourcesById.set(resource.id, resource);

const priceOf = (resourceId, fallback = 20) => {
  const resource = canonicalResourcesById.get(resourceId);
  const direct = optionalNumber(resource?.basePriceCopper);
  return direct === null ? parseCurrencyCopper(resource?.cost, fallback) : Math.max(0, Math.round(direct));
};
const RESOURCE_OFFER_TARGETS = new Map([
  ["specialty-crystal-ship-core", "crystal-core"]
]);
const mappedResourceId = (value) => canonicalResourceId(value);
const canonicalizeMarketOffer = (offer = {}, { baseOffer = false } = {}) => {
  const sourceType = offer.sourceType === "item" ? "item" : "resource";
  const resourceId = sourceType === "resource"
    ? mappedResourceId(RESOURCE_OFFER_TARGETS.get(String(offer.id ?? "")) ?? offer.resourceId)
    : offer.resourceId;
  const explicitPrice = hasOwn(offer, "priceOverrideCopper")
    ? optionalNumber(offer.priceOverrideCopper)
    : (optionalNumber(offer.basePriceCopper) ?? optionalNumber(offer.priceCopper));
  const explicitLoadPoints = hasOwn(offer, "loadOverridePoints")
    ? optionalNumber(offer.loadOverridePoints)
    : legacyOfferLoadPoints(offer);
  const result = abstractOfferUnit({
    ...offer,
    sourceType,
    resourceId,
    priceFactor: optionalNumber(offer.priceFactor) ?? 1
  });
  delete result.basePriceCopper;
  delete result.priceCopper;
  delete result.load;
  delete result.weight;
  delete result.loadPoints;
  delete result.priceOverrideCopper;
  delete result.loadOverridePoints;
  if (baseOffer) result.baseDemand = Math.max(0, Math.floor(optionalNumber(offer.baseDemand) ?? optionalNumber(offer.demand) ?? optionalNumber(offer.baseStock) ?? 0));

  if (sourceType === "item") {
    result.priceOverrideCopper = Math.max(1, Math.round(explicitPrice ?? 1));
    result.loadOverridePoints = Math.max(0, Math.round(explicitLoadPoints ?? 4));
    return result;
  }
  if (baseOffer) return result;

  const canonicalPrice = priceOf(result.resourceId, 0);
  if (explicitPrice !== null && Math.max(1, Math.round(explicitPrice)) !== canonicalPrice) {
    result.priceOverrideCopper = Math.max(1, Math.round(explicitPrice));
  }
  return result;
};
const offerTags = (resourceId) => {
  const canonicalId = mappedResourceId(resourceId);
  const resource = resourcesById.get(canonicalId);
  return [...new Set([canonicalId, resource?.categoryTag, ...(resource?.marketTags ?? [])].filter(Boolean))];
};
const offerKind = (resourceId) => {
  const resource = resourcesById.get(mappedResourceId(resourceId));
  if (resource?.foodEdible || resource?.marketTags?.some((tag) => ["medicine", "consumer", "alcohol"].includes(tag))) return "consumable";
  if (resource?.marketTags?.some((tag) => ["fuel", "ore", "food.raw"].includes(tag))) return "resource";
  return "material";
};
const makeOffer = (countryId, resourceId, options = {}) => canonicalizeMarketOffer({
  id: `${countryId}-${mappedResourceId(resourceId)}`,
  resourceId: mappedResourceId(resourceId),
  active: true,
  visibility: options.visibility ?? "public",
  sourceType: "resource",
  kind: options.kind ?? offerKind(resourceId),
  ubiquity: options.ubiquity ?? "ordinary",
  forceAvailable: options.forceAvailable ?? false,
  unit: "ед.",
  icon: resourcesById.get(mappedResourceId(resourceId))?.icon ?? "fa-solid fa-box",
  tags: options.tags ?? offerTags(resourceId),
  basePriceCopper: options.price ?? priceOf(resourceId),
  priceFactor: options.priceFactor ?? 1,
  baseStock: options.stock ?? 60,
  baseDemand: options.demand ?? options.stock ?? 60,
  volatility: options.volatility ?? 0.24,
  load: options.load ?? 1,
  priceBasis: ABSTRACT_PRICE_BASIS,
  historicalSource: options.historicalSource ?? historicSource(resourceId),
  availabilityNotes: options.notes ?? "Характерный товар государственного рынка; итоговый запас зависит от размера и специализации локации."
});

const ESSENTIAL_RESOURCE_IDS = new Set(["wood", "stone", "grain", "flour", "vegetables", "water", "bread", "animal-feed"]);
const baseAvailability = (resource) => {
  if (ESSENTIAL_RESOURCE_IDS.has(resource.id)) return { ubiquity: "essential", stock: 180, volatility: 0.2 };
  const difficulty = Number(resource.marketAccessDifficulty ?? 0);
  if (difficulty >= 4) return { ubiquity: "restricted", stock: 8, volatility: 0.42 };
  if (difficulty >= 2) return { ubiquity: "specialized", stock: 24, volatility: 0.34 };
  if (difficulty >= 1) return { ubiquity: "ordinary", stock: 55, volatility: 0.28 };
  return { ubiquity: "common", stock: 100, volatility: 0.24 };
};
const preparedBaseOffersByResourceId = new Map();
for (const offer of DEFAULT_MARKET_BASE_OFFERS) {
  const prepared = canonicalizeMarketOffer({
    ...offer,
    contentSource: LIBRARY_SOURCE,
    contentVersion: CONTENT_VERSION,
    priceBasis: offer.priceBasis || "Одна стандартная рыночная партия.",
    historicalSource: offer.historicalSource || historicSource(offer.resourceId),
    availabilityNotes: offer.availabilityNotes || "Потенциально встречается на большинстве рынков; размер локации ограничивает редкость."
  }, { baseOffer: true });
  preparedBaseOffersByResourceId.set(prepared.resourceId, prepared);
}
for (const resource of resourcesById.values()) {
  if (preparedBaseOffersByResourceId.has(resource.id)) continue;
  const { ubiquity, stock, volatility } = baseAvailability(resource);
  const prepared = canonicalizeMarketOffer(makeOffer("market", resource.id, { ubiquity, stock, volatility }), { baseOffer: true });
  preparedBaseOffersByResourceId.set(resource.id, prepared);
}
const preparedBaseOffers = [...preparedBaseOffersByResourceId.values()];

const rule = (id, label, mode, targetTags, stockFactor, priceFactor, volatilityFactor = 1) => ({ id, label, mode, targetTags, resourceIds: [], stockFactor, priceFactor, volatilityFactor, active: true });
const countryMeta = {
  sirosten: {
    conditionId: "reconstruction", tradeRegime: "regulated-open", taxRate: 0.06, priceFactor: 1.02, stockFactor: 1.08, deliveryFactor: 0.95, timeFactor: 0.9, riskFactor: 0.95,
    description: "882 П.П.: восстановившаяся парламентская республика, крупнейший военный рынок Гристона. Регулярная армия массово закупает казнозарядное оружие, порох, металл и провиант.",
    rules: [rule("siro-arms", "Республиканские арсеналы", "produce", ["gunpowder", "cartridges", "lead", "steel", "military-supply"], 1.8, 0.86, 0.9), rule("siro-rebuild", "Восстановление после войн", "consume", ["construction", "tools", "machine-parts"], 1.25, 1.08, 1.15)],
    extras: [["gunpowder", 28, 150], ["cartridges", 34, 130], ["steel", 42, 120], ["machine-parts", 68, 80], ["telegraph-components", 135, 45]]
  },
  izuaver: {
    conditionId: "stable", tradeRegime: "free-hub", taxRate: 0.08, priceFactor: 0.98, stockFactor: 1.3, deliveryFactor: 0.86, timeFactor: 0.82, riskFactor: 1.08,
    description: "Мировой торговый и банковский центр. Изуавер почти не кормит себя, зато перерабатывает кристаллы, хранит грузы и сводит покупателей со всех островов.",
    rules: [rule("izu-import-food", "Продовольственная зависимость мегаполиса", "consume", ["edible", "food"], 0.8, 1.12, 1.15), rule("izu-crystals", "Кристаллические мастерские", "produce", ["crystal", "glass", "luxury"], 1.55, 0.9, 0.9)],
    extras: [["crystal-dust", 42, 160], ["lift-crystal", 180, 35], ["silk", 85, 90], ["spices", 32, 150], ["gemstones", 195, 45]]
  },
  lezhnizem: {
    conditionId: "stable", tradeRegime: "feudal-customs", taxRate: 0.04, priceFactor: 0.94, stockFactor: 1.15, deliveryFactor: 1.04, timeFactor: 1.08, riskFactor: 1.05,
    description: "Лоскутная конфедерация полей, лесов и клановых рынков. Главные товары — рожь, лён, древесина, мёд, скот и изделия местных мастеров.",
    rules: [rule("lezh-fields", "Лоскутные поля", "produce", ["rye", "grain", "flax", "hemp", "organic"], 1.7, 0.84, 0.9), rule("lezh-forest", "Лесные уделы", "produce", ["wood", "beeswax", "honey"], 1.45, 0.9, 0.9)],
    extras: [["rye", 5, 320], ["flax", 11, 200], ["linen-cloth", 26, 120], ["hardwood", 24, 180], ["beeswax", 18, 100], ["firewood", 7, 280]]
  },
  dihtbeir: {
    conditionId: "strained", tradeRegime: "theocratic-restrictions", taxRate: 0.03, priceFactor: 1.08, stockFactor: 0.72, deliveryFactor: 1.18, timeFactor: 1.2, riskFactor: 1.25,
    description: "Теократия ручного труда и технологических запретов. Допускает простую пищу, древесину, свечи и ремесленные изделия; механизмы, электричество и сложная химия запрещены.",
    rules: [rule("dih-simple", "Святость простого труда", "produce", ["edible", "wood", "candles", "cloth", "fish"], 1.2, 0.94, 0.9), rule("dih-machines", "Запрет кавтурской скверны", "restrict", ["technology", "machine-parts", "electrical", "chemical", "telegraph"], 0.02, 4, 1.8)],
    extras: [["barley", 7, 170], ["fish", 11, 150], ["candles", 12, 130], ["firewood", 8, 190], ["preserved-meat", 21, 65]]
  },
  tiribor: {
    conditionId: "stable", tradeRegime: "licensed-guilds", taxRate: 0.07, priceFactor: 1.06, stockFactor: 1.05, deliveryFactor: 1.1, timeFactor: 1.12, riskFactor: 0.9,
    description: "Закрытый клановый рынок руды, металлов, камня, драгоценностей и точного оружейного ремесла. Продажа иностранцам идёт через лицензированные гильдии.",
    rules: [rule("tir-metals", "Глубинные шахты", "produce", ["metal", "ore", "gem", "coal"], 1.8, 0.82, 0.8), rule("tir-guilds", "Гильдейская лицензия", "adjust", ["tools", "machine-parts", "gunpowder"], 0.75, 1.2, 0.8)],
    extras: [["pig-iron", 24, 240], ["wrought-iron", 38, 150], ["steel", 48, 90], ["coal", 9, 260], ["gemstones", 160, 55], ["tools", 48, 120]]
  },
  yaknizem: {
    conditionId: "war-mobilization", tradeRegime: "open-air-corridor", taxRate: 0.05, priceFactor: 1.04, stockFactor: 1.08, deliveryFactor: 0.84, timeFactor: 0.76, riskFactor: 1.14,
    description: "Воинственное ханство и свободный воздушный коридор. Рада Купаловых поддерживает перевалку грузов, пока уделы покупают оружие, картофель, мясо и спирт.",
    rules: [rule("yak-food", "Хуторской избыток", "produce", ["potatoes", "pork", "spirits", "meat"], 1.55, 0.86, 1), rule("yak-war", "Ежегодная борьба за ханство", "consume", ["gunpowder", "cartridges", "steel", "military-supply"], 1.35, 1.15, 1.25)],
    extras: [["potatoes", 4, 340], ["pork", 15, 180], ["spirits", 20, 140], ["gunpowder", 34, 120], ["cartridges", 39, 90], ["rope", 24, 190]]
  },
  "horslia-ontakva": {
    conditionId: "thriving", tradeRegime: "dual-monarchy", taxRate: 0.07, priceFactor: 0.98, stockFactor: 1.2, deliveryFactor: 0.9, timeFactor: 0.88, riskFactor: 0.88,
    description: "Алмазная Корона: шахты Хорслии дополняются хлебными долинами и конными заводами Онтаквы. Электричество и телеграф уже используются в рудниках, тоннеле и столицах.",
    rules: [rule("ho-mines", "Алмазные Пики", "produce", ["precious", "metal", "gem", "copper"], 1.8, 0.8, 0.85), rule("ho-valleys", "Хлебные долины", "produce", ["grain", "wine", "edible"], 1.35, 0.9, 0.9), rule("ho-electric", "Электрификация шахт", "produce", ["electrical", "telegraph", "conductor"], 1.25, 0.96, 1)],
    extras: [["gold", 620, 35], ["silver", 82, 95], ["gemstones", 150, 100], ["copper", 41, 140], ["copper-wire", 67, 80], ["wine", 19, 150]]
  },
  fletchenrand: {
    conditionId: "strained", tradeRegime: "patent-industrial", taxRate: 0.09, priceFactor: 1.06, stockFactor: 1.25, deliveryFactor: 0.92, timeFactor: 0.86, riskFactor: 1.08,
    description: "Промышленная и научная фабрика Островов. Экспортирует машины, химию, оружейные припасы, телеграф и электротехнику, но критически зависит от ввоза пищи и чистой воды.",
    rules: [rule("fletch-industry", "Патентная промышленность", "produce", ["technology", "machine-parts", "chemical", "electrical", "telegraph", "ammunition"], 2, 0.82, 0.8), rule("fletch-hunger", "Городская продовольственная зависимость", "consume", ["edible", "food", "water"], 0.48, 1.45, 1.45)],
    extras: [["coal", 7, 420], ["coke", 11, 300], ["machine-parts", 58, 220], ["sulfuric-acid", 22, 180], ["telegraph-components", 118, 100], ["electrical-parts", 98, 65], ["cartridges", 30, 200]]
  },
  sangren: {
    conditionId: "thriving", tradeRegime: "royal-ports", taxRate: 0.05, priceFactor: 0.95, stockFactor: 1.2, deliveryFactor: 0.88, timeFactor: 0.88, riskFactor: 0.82,
    description: "Стабильное традиционное королевство, крупный аграрный, винодельческий, художественный и кораблестроительный рынок с сильными портовыми гильдиями.",
    rules: [rule("sangren-farms", "Королевские земли", "produce", ["grain", "wine", "grapes", "olive-oil", "edible"], 1.65, 0.82, 0.8), rule("sangren-ports", "Побережье Амальфи", "produce", ["shipbuilding", "rope", "sailcloth", "marble", "luxury"], 1.4, 0.9, 0.9)],
    extras: [["wine", 17, 260], ["grapes", 8, 260], ["olive-oil", 14, 190], ["marble", 35, 150], ["sailcloth", 29, 150], ["rope", 23, 210]]
  },
  novand: {
    conditionId: "systemic-collapse", tradeRegime: "fragmented-humanitarian-crisis", taxRate: 0.02, priceFactor: 1.45, stockFactor: 0.42, deliveryFactor: 1.8, timeFactor: 1.55, riskFactor: 2.35,
    description: "882 П.П.: две трети денег оказались магической фальшивкой; экономика рухнула. Зараза убила почти четверть населения, гражданская война продолжается. Вино и Риюдская верфь остаются главными источниками настоящего дохода.",
    rules: [rule("novand-hunger", "Гуманитарный дефицит", "consume", ["edible", "medicine", "sanitation", "construction", "tools"], 0.3, 1.9, 1.75), rule("novand-wine", "Последний экспорт королей", "produce", ["wine", "grapes", "alcohol"], 1.65, 1.15, 1.6), rule("novand-shipyard", "Риюдская верфь", "produce", ["crystal-core", "crystal", "shipbuilding"], 0.8, 1.35, 1.45)],
    extras: [["wine", 26, 190], ["grapes", 12, 150], ["crystal-core", 1100, 8, 0.5, 8, "restricted"], ["canned-food", 38, 25], ["disinfectant", 65, 18], ["bandages", 32, 30], ["fish", 18, 80]]
  },
  kaldvelg: {
    conditionId: "resource-scarcity", tradeRegime: "pirate-ports", taxRate: 0.03, priceFactor: 1.18, stockFactor: 0.68, deliveryFactor: 1.35, timeFactor: 1.25, riskFactor: 1.85,
    description: "Пиратское воеводство вечного холода. Продаёт железную древесину, горные материалы, услуги верфей и переменчивые партии захваченного груза; пища и топливо постоянно в дефиците.",
    rules: [rule("kald-ironwood", "Морозные леса", "produce", ["rare-wood", "stone", "ore", "shipbuilding"], 1.7, 0.88, 1.1), rule("kald-plunder", "Захваченные товары", "adjust", ["all"], 0.8, 1.05, 1.65), rule("kald-hunger", "Украденное тепло", "consume", ["edible", "fuel"], 0.28, 1.85, 1.5)],
    extras: [["ironwood", 68, 120], ["slate", 18, 140], ["machine-parts", 75, 70], ["preserved-meat", 34, 45], ["coal", 19, 60], ["fish", 16, 90]]
  },
  naerder: {
    conditionId: "permit-only-isolation", tradeRegime: "permit-or-smuggling", taxRate: 0.1, priceFactor: 1.28, stockFactor: 0.6, deliveryFactor: 1.45, timeFactor: 1.35, riskFactor: 1.55,
    description: "Изолированное жаркое княжество. Законная торговля требует особого разрешения; без него остаётся контрабанда. Экспортирует кристаллы, редкие минералы, специи и пустынные находки.",
    rules: [rule("naer-crystal", "Кристаллический лес", "produce", ["crystal", "rare", "medicine", "spices"], 1.5, 0.9, 1.35), rule("naer-permit", "Разрешение на торговлю", "adjust", ["all"], 0.62, 1.28, 1.25)],
    extras: [["crystal-dust", 55, 100], ["aether-crystal", 240, 22, 0.45, 3, "restricted"], ["spices", 28, 100], ["mercury", 58, 45], ["opium", 75, 28], ["glassware", 48, 35]]
  },
  boltrask: {
    conditionId: "thriving", tradeRegime: "industrial-mercantilist", taxRate: 0.07, priceFactor: 0.96, stockFactor: 1.35, deliveryFactor: 0.86, timeFactor: 0.82, riskFactor: 0.88,
    description: "Крупная индустриально-аграрная конституционная монархия. Экспортирует зерно, текстиль, уголь, металл, железнодорожное оборудование и массовые промышленные изделия.",
    rules: [rule("bolt-industry", "Стальной пояс", "produce", ["coal", "steel", "machine-parts", "textile", "technology"], 1.8, 0.82, 0.8), rule("bolt-grain", "Зерновые равнины", "produce", ["grain", "edible", "canned-food"], 1.7, 0.8, 0.8)],
    extras: [["coal", 7, 440], ["steel", 39, 230], ["machine-parts", 56, 210], ["cotton-cloth", 23, 260], ["canned-food", 16, 180], ["telegraph-components", 125, 70]]
  },
  sarroyo: {
    conditionId: "stable", tradeRegime: "oligarchic-free-market", taxRate: 0.03, priceFactor: 0.94, stockFactor: 1.15, deliveryFactor: 1.02, timeFactor: 1, riskFactor: 1.38,
    description: "Бумажная и художественная республика под властью Пяти Семей. Дешёвое сырьё и культурные товары соседствуют с криминальными пошлинами, контрабандой и частной охраной.",
    rules: [rule("sar-paper", "Белые луга", "produce", ["paper", "tsukami", "art", "ink", "silk"], 1.9, 0.76, 0.85), rule("sar-syndicates", "Пять Семей", "adjust", ["luxury", "art", "spices"], 1.2, 1.12, 1.35)],
    extras: [["tsukami-fiber", 12, 340], ["tsukami-paper", 14, 420], ["paper", 19, 240], ["ink", 18, 190], ["art-pigments", 34, 120], ["silk", 78, 85]]
  },
  "royu-sageki": {
    conditionId: "sealed-borders", tradeRegime: "closed-sanctions", taxRate: 0.12, priceFactor: 1.22, stockFactor: 0.82, deliveryFactor: 1.7, timeFactor: 1.5, riskFactor: 2,
    description: "882 П.П.: границы закрыты. Государство угрожает возмездием перевозчикам и покупателям грузов из Ройу Мидеки. Внутренний рынок милитаризован и недоступен обычной внешней торговле.",
    rules: [rule("sageki-war", "Государственный военный заказ", "produce", ["steel", "gunpowder", "cartridges", "weapons", "military-supply"], 1.9, 0.9, 0.7), rule("sageki-closed", "Закрытые границы", "restrict", ["all"], 0, 5, 2)],
    extras: [["steel", 44, 180], ["gunpowder", 31, 220], ["cartridges", 31, 190], ["machine-parts", 62, 100], ["rice", 9, 280]]
  },
  "royu-mideki": {
    conditionId: "war-mobilization", tradeRegime: "decentralized-open", taxRate: 0.02, priceFactor: 1.04, stockFactor: 0.92, deliveryFactor: 1.22, timeFactor: 1.1, riskFactor: 1.55,
    description: "Децентрализованная каррия свободных семей. Торговля открыта, но война, частные заставы и угроза санкций Сагеки делают перевозки дорогими и опасными.",
    rules: [rule("mideki-farms", "Свободные коммуны", "produce", ["rice", "edible", "tea"], 1.45, 0.88, 1), rule("mideki-workshops", "Пороховой берег", "produce", ["gunpowder", "cartridges", "tools", "machine-parts"], 1.55, 0.92, 1.3)],
    extras: [["rice", 8, 320], ["gunpowder", 33, 160], ["cartridges", 35, 140], ["tools", 49, 130], ["machine-parts", 66, 90], ["tea", 18, 150]]
  }
};

const oldCountries = new Map((library.content.marketEconomy?.countries ?? []).map((row) => [row.id, row]));
const countries = Object.entries(countryMeta).map(([id, meta]) => {
  const previous = oldCountries.get(id) ?? { id, label: id, offers: [] };
  const offers = new Map((previous.offers ?? []).map((offer) => {
    const resourceId = mappedResourceId(offer.resourceId);
    return [resourceId, canonicalizeMarketOffer({ ...offer, id: `${id}-${resourceId}`, resourceId, tags: offerTags(resourceId) })];
  }));
  for (const [resourceId, price, stock, volatility = 0.24, load = 1, ubiquity = "ordinary"] of meta.extras) {
    const canonicalId = mappedResourceId(resourceId);
    offers.set(canonicalId, makeOffer(id, canonicalId, { price, stock, volatility, load, ubiquity, forceAvailable: ubiquity === "restricted" }));
  }
  return {
    ...previous,
    ...meta,
    id,
    active: true,
    visibility: "public",
    offers: [...offers.values()],
    tags: [...new Set([...(previous.tags ?? []), "air-islands", "year-882"])],
    contentSource: LIBRARY_SOURCE,
    contentVersion: CONTENT_VERSION
  };
});

const conditions = [
  ["systemic-collapse", "Системный коллапс", "Крах доверия к деньгам, массовая смертность и война одновременно.", 1.55, 0.45, 1.55, 1.45, 1.85, 1.8],
  ["plague-depopulation", "Эпидемия и нехватка людей", "Рабочих рук мало; медицина, пища и санитарные товары особенно дороги.", 1.25, 0.58, 1.25, 1.3, 1.45, 1.5],
  ["bombed-contested", "Разбомблен и оспаривается", "Инфраструктура разрушена, власть и склады переходят из рук в руки.", 1.45, 0.28, 1.65, 1.7, 2, 1.7],
  ["resource-scarcity", "Природная скудость", "Местность почти не производит пищу и топливо, но может иметь редкие экспортные товары.", 1.22, 0.68, 1.3, 1.2, 1.25, 1.25],
  ["permit-only-isolation", "Торговля по разрешению", "Обычная торговля закрыта; разрешённые сделки дороги, контрабанда рискованна.", 1.24, 0.62, 1.35, 1.3, 1.55, 1.25],
  ["sealed-borders", "Закрытые границы", "Внешняя торговля прекращена государственным решением.", 1.5, 0.05, 2, 2, 2.5, 1.5],
  ["criminal-control", "Криминальный контроль", "Торговля работает, но пошлины и безопасность зависят от местных синдикатов.", 1.12, 0.9, 1.18, 1.08, 1.5, 1.35],
  ["labor-shortage", "Нехватка рабочих рук", "Производство сохранено, но объёмы и скорость поставок упали.", 1.15, 0.65, 1.2, 1.35, 1.2, 1.25],
  ["humanitarian-relief", "Гуманитарные поставки", "Редкий защищённый канал жизненно важных товаров.", 0.95, 0.42, 1.05, 1.15, 1.35, 1.2]
].map(([id, label, description, priceFactor, stockFactor, deliveryFactor, timeFactor, riskFactor, volatilityFactor]) => ({ id, label, description, active: true, priceFactor, stockFactor, deliveryFactor, timeFactor, riskFactor, volatilityFactor, contentSource: NETWORK_SOURCE, contentVersion: CONTENT_VERSION }));

const specialty = (id, label, category, description, rules) => ({
  id, label, category, description, active: true, rules, offers: [], contentSource: NETWORK_SOURCE, contentVersion: CONTENT_VERSION
});
const produce = (id, tags, stockFactor = 1.8, priceFactor = 0.88, volatilityFactor = 0.95) => ({ id: `${id}-output`, label: "Местная продукция", mode: "produce", targetTags: tags, resourceIds: [], stockFactor, priceFactor, volatilityFactor, active: true });
const consume = (id, tags, stockFactor = 0.72, priceFactor = 1.2, volatilityFactor = 1.15) => ({ id: `${id}-input`, label: "Местный спрос", mode: "consume", targetTags: tags, resourceIds: [], stockFactor, priceFactor, volatilityFactor, active: true });
const customSpecialties = [
  specialty("art-market", "Художественный рынок", "Культура", "Картины, пигменты, бумага и предметы роскоши.", [produce("art-market", ["art", "paper", "dye", "luxury"], 1.55, 0.92)]),
  specialty("artillery", "Артиллерийское производство", "Военная промышленность", "Орудия, боеприпасы и тяжёлая металлообработка.", [produce("artillery", ["weapon", "ammunition", "cartridges", "military-supply"], 1.7, 0.9), consume("artillery", ["metal", "fuel", "chemical"])]),
  specialty("bombed-capital", "Разбомбленный столичный рынок", "Кризис", "Руины дают лом, но жизненно важные товары и стройматериалы в дефиците.", [produce("bombed-capital", ["metalwork", "masonry"], 1.9, 0.78, 1.6), consume("bombed-capital", ["construction", "food", "edible", "medicine", "fuel"], 0.42, 1.45, 1.6)]),
  specialty("captured-goods", "Захваченные товары", "Нерегулярная торговля", "Трофеи и конфискованные грузы: дёшево, непредсказуемо и с правовым риском.", [produce("captured-goods", ["captured-goods", "salvage", "metal", "tools", "weapon"], 1.45, 0.82, 1.8)]),
  specialty("cartridges", "Патронное производство", "Военная промышленность", "Серийный выпуск унитарных патронов для казнозарядного оружия.", [produce("cartridges", ["cartridges", "ammunition"], 2.1, 0.82), consume("cartridges", ["lead", "copper", "gunpowder", "metal"])]),
  specialty("electrical-industry", "Электротехническая промышленность", "Передовая технология", "Провод, элементы, изоляторы и редкие электрические приборы.", [produce("electrical-industry", ["electrical", "conductor", "telegraph"], 1.8, 0.88), consume("electrical-industry", ["copper", "glass", "chemical", "machine-parts"])]),
  specialty("fish-oil", "Вытапливание рыбьего жира", "Пищевая переработка", "Технический, ламповый и лекарственный рыбий жир.", [produce("fish-oil", ["fish-oil", "oil", "lamp-fuel"], 1.9, 0.84), consume("fish-oil", ["fish", "fuel", "barrel"])]),
  specialty("gem-mines", "Самоцветные копи", "Добыча", "Малые партии драгоценных и поделочных камней.", [produce("gem-mines", ["gem", "precious", "luxury"], 1.55, 0.9, 1.25), consume("gem-mines", ["tools", "fuel", "food"])]),
  specialty("geothermal", "Геотермальные промыслы", "Добыча", "Сера, тепло и минералы горячих разломов.", [produce("geothermal", ["sulfur", "chemical", "fuel", "mineral"], 1.7, 0.88, 1.2), consume("geothermal", ["tools", "metal"])]),
  specialty("humanitarian-depot", "Гуманитарный склад", "Кризис", "Защищённый, но маломощный канал пищи, лекарств и санитарных расходников.", [produce("humanitarian-depot", ["food", "edible", "medicine", "sanitation", "preserved-food"], 1.25, 0.92, 0.8)]),
  specialty("ironwood", "Промысел редкой древесины", "Редкое сырьё", "Заготовка и обработка редкой прочной древесины Кальдвельга.", [produce("ironwood", ["rare-wood", "wood"], 2.25, 0.78), consume("ironwood", ["tools", "food", "fuel"])]),
  specialty("marble", "Мраморные разработки", "Добыча", "Добыча, первичная разделка и художественная обработка мрамора.", [produce("marble", ["marble", "stone", "luxury"], 1.9, 0.84), consume("marble", ["tools", "fuel"])]),
  specialty("observatory", "Обсерватории и навигационные станции", "Наука", "Спрос на точные приборы, стекло, карты и бумагу.", [produce("observatory", ["paper", "writing", "technology"], 1.3, 0.95), consume("observatory", ["instrument", "glass", "paper", "electrical"])]),
  specialty("olive-groves", "Оливковые рощи", "Сельское хозяйство", "Масличные плоды для пищи, мыла и ламп.", [produce("olive-groves", ["olive", "organic", "oil"], 2, 0.84), consume("olive-groves", ["tools", "barrel"])]),
  specialty("olive-oil", "Маслобойни", "Пищевая переработка", "Пищевое, ламповое и мыловаренное масло.", [produce("olive-oil", ["olive-oil", "oil", "edible"], 1.8, 0.86), consume("olive-oil", ["olive", "glass", "barrel"])]),
  specialty("permit-market", "Лицензионный рынок", "Торговый режим", "Покупка возможна лишь через разрешённого фактора; ассортимент узок и дорог.", [produce("permit-market", ["all"], 0.48, 1.28, 0.75)]),
  specialty("refugee-market", "Рынок беженцев", "Кризис", "Сильный спрос на дешёвую пищу, одежду, лекарства и временное жильё.", [consume("refugee-market", ["food", "edible", "cloth", "medicine", "construction"], 0.5, 1.32, 1.35)]),
  specialty("tea", "Чайные хозяйства", "Сельское хозяйство", "Чайный лист и сушёные смеси для внутреннего и внешнего рынка.", [produce("tea", ["tea"], 2, 0.84), consume("tea", ["paper", "wood", "tools"])]),
  specialty("telegraph", "Телеграфный узел", "Связь", "Распространённая сеть связи создаёт запас провода, реле и линейных инструментов.", [produce("telegraph", ["telegraph", "copper-wire"], 1.55, 0.91), consume("telegraph", ["copper", "glass", "electrical"])]),
  specialty("tsukami", "Плантации цуками", "Сельское хозяйство", "Волокно для дешёвой бумаги и ткани Сарройо.", [produce("tsukami", ["tsukami", "paper", "textile"], 2.25, 0.8), consume("tsukami", ["tools", "dye"])])
];

const specialtyAliases = {
  "coal-depot": "railway-junction", customs: "transshipment-port", dyes: "dyehouses", "fruit-district": "orchards",
  herbalism: "herb-gathering", hunting: "fur-trade", jewelers: "luxury-quarter", livestock: "livestock-market",
  "luxury-market": "luxury-quarter", "machine-tools": "machinery", mills: "mills-bakeries", monastery: "monastery-workshops",
  paper: "paper-parchment", peat: "peat-bogs", resins: "forestry", salvage: "salvage-yard", smithies: "forges",
  smuggling: "black-market", steelworks: "foundry-cluster", sulfur: "chemical-industry", textiles: "textile-district", "wool-market": "wool-center"
};

const countryLabels = Object.fromEntries(countries.map((row) => [row.id, row.label]));
const locationStatus = (conditionId) => ({
  "bombed-contested": "ruined",
  "systemic-collapse": "ruined",
  "plague-depopulation": "disrupted",
  "humanitarian-relief": "disrupted",
  "labor-shortage": "strained",
  "sealed-borders": "blockaded",
  "permit-only-isolation": "blockaded",
  "criminal-control": "strained",
  "war-mobilization": "strained"
})[conditionId] ?? "stable";

// id, label, country, x, y, size, specialties, condition, modes, notes, enabled
const locationRows = [
  ["sirosten-nikery", "Никерий", "sirosten", 1850, 1160, "capital", ["capital-market", "financial-center", "weapons", "university"], "reconstruction", ["caravan", "rail", "airship"], "Столица и главный государственный рынок республики."],
  ["sirosten-arsenal-ridge", "Арсенальный кряж", "sirosten", 1990, 1020, "city", ["arms-manufacture", "explosives", "steelworks", "military-depot"], "war-mobilization", ["caravan", "rail", "airship"], "Казённые арсеналы, патронные и орудийные заводы."],
  ["sirosten-free-tract", "Свободный тракт", "sirosten", 2220, 1240, "town", ["rail-junction", "warehouses", "wholesale-hub"], "stable", ["caravan", "rail"], "Сухопутный перевалочный рынок восточного направления."],
  ["sirosten-old-damia", "Старая Дамия", "sirosten", 1650, 1030, "town", ["grain-district", "livestock", "tanneries"], "reconstruction", ["caravan", "rail"], "Сельскохозяйственный рынок на восстанавливаемых землях."],

  ["izuaver-cradle", "Колыбель", "izuaver", 2520, 1510, "metropolis", ["capital-market", "financial-center", "wholesale-hub", "warehouses", "book-market"], "stable", ["caravan", "rail", "airship"], "Крупнейший биржевой и складской узел островов."],
  ["izuaver-south-ports", "Южные воздушные порты", "izuaver", 2540, 1650, "city", ["air-harbor", "repair-docks", "warehouses", "customs"], "stable", ["airship"], "Дальние воздушные рейсы и перегрузка межконтинентальных товаров."],
  ["izuaver-stone-spires", "Каменные шпили", "izuaver", 2440, 1450, "city", ["crystal-refining", "glassworks", "jewelers", "university-town"], "stable", ["caravan", "rail", "airship"], "Кристаллические, стекольные и ювелирные мастерские."],
  ["izuaver-dark-zones", "Тёмные кварталы", "izuaver", 2640, 1430, "town", ["black-market", "ship-salvage", "warehouses"], "criminal-control", ["caravan", "airship"], "Серый импорт, скупка груза и неофициальный кредит."],

  ["lezhnizem-ispol", "Исполь", "lezhnizem", 3580, 1650, "capital", ["capital-market", "timber-district", "sawmills", "wholesale-hub"], "stable", ["caravan", "rail", "airship"], "Столица кланового государства и центр древесной торговли."],
  ["lezhnizem-patchwork-fields", "Лоскутные поля", "lezhnizem", 3400, 1530, "town", ["grain-district", "livestock", "wool-market"], "stable", ["caravan", "rail"], "Раздробленные хозяйства зерна, шерсти и скота."],
  ["lezhnizem-miracle-ridge", "Хребет Чудес", "lezhnizem", 3160, 1470, "town", ["rare-minerals", "herbalism", "university-town"], "stable", ["caravan", "airship"], "Редкие минералы и сбор необычного лекарственного сырья."],
  ["lezhnizem-deepwood", "Глубоколесье", "lezhnizem", 3870, 1470, "town", ["forestry", "timber-district", "resins", "hunting"], "stable", ["caravan"], "Лесные артели, смолы, дичь и строительная древесина."],

  ["dihtbeir-domigrad", "Домиград", "dihtbeir", 2980, 950, "capital", ["capital-market", "university", "printing-quarter", "chemical-industry"], "stable", ["caravan", "rail", "airship"], "Учёный и административный рынок Дихтбейра."],
  ["dihtbeir-world-throat", "Горло Мира", "dihtbeir", 2860, 780, "town", ["observatory", "rare-minerals", "crystal-mines"], "stable", ["caravan", "airship"], "Высокогорные шахты и научные станции."],
  ["dihtbeir-fisher-coast", "Рыбацкий берег", "dihtbeir", 2760, 1050, "town", ["coastal-fishery", "canning", "fish-oil"], "stable", ["caravan", "airship"], "Рыба, консервы и технический жир."],
  ["dihtbeir-lands-of-silence", "Земли Тишины", "dihtbeir", 3120, 1020, "village", ["monastery", "herbalism", "paper-parchment"], "stable", ["caravan"], "Монастырские хозяйства, травы и рукописные материалы."],

  ["tiribor-kergotog", "Керготог", "tiribor", 4200, 1370, "capital", ["capital-market", "steelworks", "machine-tools", "rail-junction"], "stable", ["caravan", "rail", "airship"], "Столица тяжёлой промышленности и инженерных гильдий."],
  ["tiribor-kemphermen", "Кемпхермен", "tiribor", 4060, 1140, "city", ["chemical-industry", "glassworks", "explosives"], "stable", ["caravan", "rail", "airship"], "Химические, стекольные и пороховые заводы."],
  ["tiribor-thunder-anvil", "Громовая Наковальня", "tiribor", 4300, 1260, "city", ["arms-manufacture", "artillery", "machine-tools"], "war-mobilization", ["caravan", "rail"], "Орудийное производство и тяжёлое машиностроение."],
  ["tiribor-genfen-mines", "Генфенские копи", "tiribor", 4410, 1180, "town", ["iron-mines", "coal-mines", "nonferrous-mines"], "stable", ["caravan", "rail"], "Рудная база тироборской металлургии."],

  ["yaknizem-gulyai-grad", "Гуляй-Град", "yaknizem", 4490, 1750, "capital", ["capital-market", "wholesale-hub", "air-harbor", "weapons"], "stable", ["caravan", "rail", "airship"], "Столица и шумный рынок пограничного государства."],
  ["yaknizem-drygva", "Дрыгва", "yaknizem", 4660, 1980, "town", ["peat", "herbalism", "livestock"], "stable", ["caravan"], "Болотное топливо, травы и выносливый скот."],
  ["yaknizem-sky-tract", "Небесный тракт", "yaknizem", 4410, 1620, "city", ["air-harbor", "warehouses", "customs"], "stable", ["caravan", "rail", "airship"], "Восточный перевалочный порт между континентами."],
  ["yaknizem-iron-winds", "Железные Ветры", "yaknizem", 4270, 1800, "town", ["iron-mines", "smithies", "repair-docks"], "stable", ["caravan", "rail", "airship"], "Руда, кузницы и ремонт караванного транспорта."],

  ["ho-zratog", "Зратог", "horslia-ontakva", 4250, 2250, "capital", ["capital-market", "financial-center", "electrical-industry", "telegraph"], "stable", ["caravan", "rail", "airship"], "Финансовый и электротехнический центр двойной державы."],
  ["ho-tsoshnya", "Цошня", "horslia-ontakva", 4460, 2230, "city", ["steelworks", "machine-tools", "railway-junction"], "stable", ["caravan", "rail", "airship"], "Металлургия и железнодорожное машиностроение."],
  ["ho-diamond-peaks", "Алмазные пики", "horslia-ontakva", 4110, 2110, "town", ["precious-metals", "gem-mines", "rare-minerals"], "stable", ["caravan", "rail", "airship"], "Драгоценные камни и цветные металлы."],
  ["ho-bread-valleys", "Хлебные долины", "horslia-ontakva", 4370, 2370, "town", ["grain-belt", "mills", "livestock"], "stable", ["caravan", "rail"], "Зерновой и мясной экспорт государства."],
  ["ho-transcarpathian-tunnel", "Транскарпатский тоннель", "horslia-ontakva", 4200, 2190, "city", ["rail-junction", "warehouses", "coal-depot"], "stable", ["rail", "caravan"], "Стратегический сухопутный коридор и железнодорожный склад."],

  ["fletch-graturin", "Гратурин", "fletchenrand", 3210, 1930, "capital", ["capital-market", "electrical-industry", "telegraph", "university"], "stable", ["caravan", "rail", "airship"], "Столица передовой электротехники и государственной науки."],
  ["fletch-gut", "Гут", "fletchenrand", 3370, 2000, "city", ["arms-manufacture", "cartridges", "machine-tools"], "war-mobilization", ["caravan", "rail", "airship"], "Казнозарядное оружие, патроны и точные станки."],
  ["fletch-shakhtgraben", "Шахтграбен", "fletchenrand", 3450, 1890, "city", ["coal-mines", "iron-mines", "steelworks"], "stable", ["caravan", "rail"], "Уголь, железо и коксующие печи."],
  ["fletch-rust-coast", "Ржавый Берег", "fletchenrand", 3250, 2250, "city", ["shipyard", "repair-docks", "air-harbor", "canning"], "stable", ["rail", "airship"], "Воздушные верфи, доки и дальнее снабжение."],
  ["fletch-gedenken", "Геденкен", "fletchenrand", 3100, 2050, "town", ["chemical-industry", "pharmaceuticals", "glassworks"], "stable", ["caravan", "rail"], "Химия, лекарства и лабораторная посуда."],

  ["sangren-mekto-merde", "Мекто-Мерде", "sangren", 2390, 1800, "capital", ["capital-market", "luxury-market", "financial-center", "wineries"], "stable", ["caravan", "rail", "airship"], "Королевская столица, роскошь и винная торговля."],
  ["sangren-amalfi", "Амальфи", "sangren", 2600, 2030, "city", ["air-harbor", "wholesale-hub", "olive-oil", "warehouses"], "stable", ["airship"], "Главный воздушный порт и купеческая биржа Сангрена."],
  ["sangren-umi-valley", "Долина Уми", "sangren", 2450, 2110, "town", ["vineyards", "olive-groves", "fruit-district"], "stable", ["caravan", "rail"], "Вино, масло и фрукты."],
  ["sangren-royal-pasture", "Королевские пастбища", "sangren", 2260, 1950, "town", ["livestock", "wool-market", "tanneries"], "stable", ["caravan", "rail"], "Скот, шерсть, кожа и сыр."],
  ["sangren-marble-hills", "Мраморные холмы", "sangren", 2740, 1900, "town", ["quarries", "marble", "art-market"], "stable", ["caravan", "airship"], "Белый камень, скульптура и художественные товары."],

  ["novand-alberve", "Альберве", "novand", 2700, 2380, "city", ["bombed-capital", "salvage", "humanitarian-depot", "black-market"], "bombed-contested", ["caravan", "airship"], "Разбомбленная и многократно переходившая из рук в руки столица."],
  ["novand-vensel", "Венсель", "novand", 2600, 2470, "city", ["hospital", "textiles", "warehouses"], "plague-depopulation", ["caravan", "airship"], "Почти не затронут войной, но выкошен Заразой."],
  ["novand-riud", "Риюд", "novand", 2810, 2300, "city", ["crystal-shipyard", "crystal-refining", "repair-docks", "strategic-licenses"], "labor-shortage", ["airship"], "Действующая кристаллическая верфь; не хватает людей и надёжных денег."],
  ["novand-aulater", "Аулатер", "novand", 2980, 2440, "town", ["coastal-fishery", "deep-fishery", "canning", "fish-oil"], "plague-depopulation", ["airship"], "Рыбацкий город, поддерживающий продовольственные поставки."],
  ["novand-wine-country", "Виноградные земли", "novand", 2780, 2510, "town", ["vineyards", "wineries", "wine-cellars"], "labor-shortage", ["caravan", "airship"], "Работающий экспортный сектор и главный источник денег воюющих королей."],
  ["novand-lisserdo", "Лиссердо", "novand", 2840, 2600, "town", ["humanitarian-depot", "grain-district", "refugee-market"], "humanitarian-relief", ["caravan", "airship"], "Южный канал гуманитарных поставок и рынок беженцев."],

  ["kald-pyatiy", "Пятый", "kaldvelg", 3560, 410, "capital", ["capital-market", "state-monopoly", "strategic-licenses"], "resource-scarcity", ["caravan", "airship"], "Административный рынок сурового северного государства."],
  ["kald-sky-shipyards", "Северные верфи", "kaldvelg", 3620, 560, "city", ["shipyard", "ironwood", "repair-docks"], "resource-scarcity", ["airship"], "Верфи, использующие железную древесину и горный металл."],
  ["kald-frost-forests", "Морозные леса", "kaldvelg", 3750, 400, "town", ["forestry", "ironwood", "hunting"], "resource-scarcity", ["caravan", "airship"], "Главный источник железной древесины и пушнины."],
  ["kald-prize-port", "Призовой порт", "kaldvelg", 3440, 520, "town", ["captured-goods", "ship-salvage", "black-market"], "criminal-control", ["airship"], "Продажа захваченных и спасённых грузов с неясным происхождением."],

  ["naer-ungva", "Унгва", "naerder", 4310, 750, "capital", ["capital-market", "permit-market", "state-monopoly", "crystal-refining"], "permit-only-isolation", ["caravan", "airship"], "Единственный крупный лицензируемый внешний рынок Наэрдера."],
  ["naer-crystal-forest", "Кристаллический лес", "naerder", 4400, 600, "town", ["crystal-mines", "rare-minerals", "strategic-licenses"], "permit-only-isolation", ["caravan", "airship"], "Охраняемая добыча редких кристаллов."],
  ["naer-peklo", "Пекло", "naerder", 4570, 760, "town", ["geothermal", "chemical-industry", "sulfur"], "permit-only-isolation", ["caravan"], "Сера, минералы и опасные химические промыслы."],
  ["naer-crystal-quarters", "Кристальные кварталы", "naerder", 4240, 650, "town", ["jewelers", "glassworks", "black-market"], "criminal-control", ["caravan", "airship"], "Лицензионные мастерские и скрытый рынок контрабанды."],

  ["bolt-tarriya", "Таррия", "boltrask", 1410, 2340, "capital", ["capital-market", "arms-manufacture", "financial-center"], "stable", ["caravan", "rail", "airship"], "Имперская столица и центр военных контрактов."],
  ["bolt-pembridge", "Пембридж", "boltrask", 1500, 2150, "city", ["air-harbor", "shipyard", "warehouses"], "stable", ["rail", "airship"], "Западные верфи и межконтинентальная торговля."],
  ["bolt-steel-belt", "Стальной пояс", "boltrask", 1670, 2030, "city", ["coal-mines", "iron-mines", "steelworks", "machine-tools"], "stable", ["caravan", "rail"], "Основная промышленная область империи."],
  ["bolt-greenvale", "Зелёная долина", "boltrask", 1250, 2050, "town", ["grain-belt", "livestock", "mills"], "stable", ["caravan", "rail", "airship"], "Зерно, мясо и мука западных земель."],
  ["bolt-wild-north", "Дикий Север", "boltrask", 1650, 1850, "town", ["forestry", "hunting", "nonferrous-mines"], "stable", ["caravan", "airship"], "Лес, меха и небольшие горные промыслы."],

  ["sar-nagotaro", "Наготаро", "sarroyo", 600, 560, "capital", ["capital-market", "printing-quarter", "art-market", "wholesale-hub"], "criminal-control", ["caravan", "airship"], "Столица Пяти Семей, издательский и художественный рынок."],
  ["sar-white-meadows", "Белые луга", "sarroyo", 720, 700, "town", ["tsukami", "paper", "textiles"], "stable", ["caravan", "airship"], "Волокно цуками, бумага и дешёвые ткани."],
  ["sar-iron-vortex", "Железный Вихрь", "sarroyo", 600, 900, "town", ["ship-salvage", "smithies", "black-market"], "criminal-control", ["caravan", "airship"], "Разбор судов, переделка металла и серые сделки."],
  ["sar-dritrikh", "Дритрих", "sarroyo", 780, 420, "town", ["dyes", "art-market", "luxury-market"], "stable", ["caravan", "airship"], "Красители, пигменты, живопись и предметы роскоши."],

  ["sageki-shikuta", "Шикута", "royu-sageki", 560, 1400, "capital", ["capital-market", "state-monopoly", "arms-manufacture"], "sealed-borders", ["caravan", "airship"], "Закрытая столица; внешний рынок недоступен.", false],
  ["sageki-shiguchi", "Шигучи", "royu-sageki", 680, 1250, "city", ["steelworks", "cartridges", "military-depot"], "sealed-borders", ["caravan", "airship"], "Военно-промышленный узел закрытого государства.", false],
  ["sageki-tears-front", "Фронт Слёз", "royu-sageki", 700, 1600, "town", ["fortress", "military-depot", "black-market"], "sealed-borders", ["caravan"], "Пограничная зона войны и санкционного контроля.", false],

  ["mideki-assur", "Ассур", "royu-mideki", 800, 2150, "capital", ["capital-market", "wholesale-hub", "weapons"], "war-mobilization", ["caravan", "airship"], "Крупнейший рынок свободных семей Мидеки."],
  ["mideki-green-belt", "Зелёный пояс", "royu-mideki", 620, 1950, "town", ["rice-belt", "tea", "livestock"], "stable", ["caravan", "airship"], "Рис, чай и продовольствие коммун."],
  ["mideki-gunpowder-coast", "Пороховой берег", "royu-mideki", 500, 2150, "city", ["explosives", "cartridges", "shipyard"], "war-mobilization", ["caravan", "airship"], "Пороховые мастерские и вооружение частных судов."],
  ["mideki-nakabayashi", "Накабаяси", "royu-mideki", 650, 1750, "town", ["warehouses", "black-market", "smuggling"], "criminal-control", ["caravan", "airship"], "Пограничный рынок под угрозой возмездия Сагеки."]
];

const canonicalMarketSizeIds = Object.freeze({
  village: "local",
  town: "town",
  city: "regional",
  capital: "metropolis",
  metropolis: "metropolis"
});

const regions = locationRows.map(([id, label, countryId, marketMapX, marketMapY, marketSizeId, marketSpecialtyIds, marketConditionId, marketTransportModes, marketNotes, marketEnabled = true]) => ({
  id,
  value: id,
  label,
  aliases: [],
  countryId,
  countryLabel: countryLabels[countryId] ?? countryId,
  marketSizeId: canonicalMarketSizeIds[marketSizeId] ?? "town",
  marketSpecialtyIds: [...new Set(marketSpecialtyIds.map((id) => specialtyAliases[id] ?? id))],
  marketConditionId,
  marketTags: [countryId, ...marketSpecialtyIds],
  marketProfile: marketTransportModes.length === 1 && marketTransportModes[0] === "airship" ? "aerial" : "connected",
  marketStatus: locationStatus(marketConditionId),
  marketEnabled,
  marketLandmassId: countryId,
  marketAirshipOnly: marketTransportModes.length === 1 && marketTransportModes[0] === "airship",
  marketTransportModes,
  marketLinks: [],
  marketMapX,
  marketMapY,
  marketNotes,
  contentSource: NETWORK_SOURCE,
  contentVersion: CONTENT_VERSION
}));

const shares = (countryIds, sharePct, modeShares = null) => countryIds.map((countryId) => ({ countryId, sharePct, active: true, ...(modeShares ? { modeShares } : {}) }));
const org = (id, label, description, countriesForMerchant = [], merchantTags = [], carrierCountries = [], modes = []) => ({
  id, label, description, active: true, visibility: "public", icon: carrierCountries.length ? "fa-solid fa-truck-fast" : "fa-solid fa-building-columns", tags: ["air-islands", "year-882"],
  merchant: { enabled: countriesForMerchant.length > 0, countryShares: shares(countriesForMerchant, countriesForMerchant.length > 8 ? 18 : 34), includeTags: merchantTags, excludeTags: [], priceFactor: 1, priceVolatility: 0.05, stockStability: 1.05 },
  buyer: { enabled: countriesForMerchant.length > 0, countryShares: shares(countriesForMerchant, countriesForMerchant.length > 8 ? 18 : 34), includeTags: merchantTags, excludeTags: [] },
  carrier: { enabled: carrierCountries.length > 0, countryShares: shares(carrierCountries, carrierCountries.length > 8 ? 16 : 36), modes, priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1 },
  contentSource: NETWORK_SOURCE, contentVersion: CONTENT_VERSION
});

const openCountries = Object.keys(countryMeta).filter((id) => id !== "royu-sageki");
const organizations = [
  org("free-trade-league", "Свободная Торговая Лига", "Межгосударственная сеть независимых факторов, страховщиков и перевозчиков. Сильнее всего представлена в открытых портах; в Сагеки не работает.", openCountries, [], openCountries, ["caravan", "rail", "airship"]),
  org("sirosten-republican-arsenals", "Республиканские арсеналы Сиростьена", "Казённые и подрядные оружейные заводы регулярной армии.", ["sirosten"], ["weapons", "gunpowder", "cartridges", "steel", "military-supply"]),
  org("izuaver-merchant-chamber", "Изуаверская купеческая палата", "Банкиры, оптовики и складские дома мирового торгового центра.", ["izuaver", "dihtbeir", "lezhnizem", "sangren"], ["luxury", "crystal", "spices", "textile"], ["izuaver", "sangren"], ["airship"]),
  org("lezhnizem-clan-convoys", "Клановые обозы Лежниземья", "Договорная сеть лесных кланов и сухопутных перевозчиков.", ["lezhnizem"], ["wood", "organic", "livestock"], ["lezhnizem", "tiribor", "dihtbeir"], ["caravan"]),
  org("dihtbeir-monastery-markets", "Монастырские рынки Дихтбейра", "Учёные и монастырские хозяйства продают книги, травы, лекарства и простые припасы.", ["dihtbeir"], ["medicine", "paper", "herbal", "edible"]),
  org("tiribor-trade-guilds", "Тироборские промышленные гильдии", "Объединения шахт, металлургии, химиков и машиностроителей.", ["tiribor"], ["metal", "fuel", "chemical", "machine-parts"], ["tiribor", "yaknizem", "lezhnizem"], ["rail", "caravan"]),
  org("kupalov-air-carriers", "Воздушные перевозчики Купаловых", "Крупный частный воздушный флот дальних и опасных маршрутов.", [], [], ["izuaver", "sirosten", "sangren", "novand", "kaldvelg", "naerder", "boltrask", "sarroyo", "royu-mideki"], ["airship"]),
  org("zratog-ingot-house", "Слитковый Дом Зратога", "Финансирует металл, самоцветы, телеграф и электротехнические товары.", ["horslia-ontakva", "fletchenrand", "tiribor"], ["metal", "precious", "electrical", "telegraph"]),
  org("transcarpathian-rail-company", "Транскарпатская железнодорожная компания", "Сухопутные перевозки между промышленными районами востока.", [], [], ["horslia-ontakva", "fletchenrand", "tiribor", "yaknizem"], ["rail"]),
  org("fletchen-mining-conglomerate", "Флеченский горнопромышленный концерн", "Уголь, кокс, руда, сталь и машиностроительное сырьё.", ["fletchenrand"], ["coal", "coke", "ore", "metal", "fuel"]),
  org("rust-coast-consortium", "Консорциум Ржавого Берега", "Верфи, ремонтные доки и поставщики электрического оборудования.", ["fletchenrand", "horslia-ontakva"], ["shipbuilding", "machine-parts", "electrical"], ["fletchenrand", "horslia-ontakva", "novand"], ["airship"]),
  org("amalfi-merchant-guilds", "Купеческие гильдии Амальфи", "Вино, масло, мрамор, дорогие ткани и портовая торговля.", ["sangren", "izuaver", "novand"], ["wine", "oil", "marble", "luxury"], ["sangren", "izuaver", "novand", "boltrask"], ["airship"]),
  org("novand-wine-syndicate", "Новандский винный синдикат", "Раздробленные хозяйства, чьи валютные поступления финансируют воюющих королей.", ["novand"], ["wine", "grapes", "barrel"]),
  org("riud-crystal-shipyard-board", "Правление кристаллической верфи Риюда", "Оставшиеся специалисты верфи продают ремонт, детали и лицензированные корабельные ядра.", ["novand"], ["crystal", "shipbuilding", "strategic"]),
  org("kaldvelg-prize-council", "Призовой совет Кальдвельга", "Государственные факторы железной древесины, горных материалов и захваченных грузов.", ["kaldvelg"], ["ironwood", "stone", "ore", "captured-goods"]),
  org("naerder-licensed-factors", "Лицензированные факторы Наэрдера", "Узкий круг торговцев с разрешением на операции в изолированном государстве.", ["naerder"], ["crystal", "chemical", "rare", "luxury"], ["naerder"], ["airship", "caravan"]),
  { ...org("zulfia-smugglers", "Контрабандисты Зульфии", "Скрытая сеть, обходящая разрешения Наэрдера и санкционные границы.", ["naerder", "sarroyo", "royu-mideki"], ["restricted", "weapons", "crystal", "luxury"], ["naerder", "sarroyo", "royu-mideki"], ["airship", "caravan"]), visibility: "gm" },
  org("boltrask-imperial-industrial", "Болтраскская имперская промышленная компания", "Сталь, уголь, оружие, сельскохозяйственные машины и колониальные контракты.", ["boltrask"], ["metal", "fuel", "weapons", "machine-parts"]),
  org("sarroyo-five-families", "Торговые дома Пяти Семей", "Семейные монополии на бумагу, искусство, импорт и частную охрану.", ["sarroyo"], ["paper", "art", "luxury", "textile"]),
  org("sarroyo-tsukami-cooperative", "Кооператив цуками", "Сельские производители волокна, бумаги и дешёвых тканей.", ["sarroyo"], ["tsukami", "paper", "textile"]),
  org("sageki-state-arsenal", "Государственный арсенал Сагеки", "Внутренняя милитаризованная система снабжения; для внешнего покупателя недоступна.", ["royu-sageki"], ["weapons", "cartridges", "steel", "military-supply"]),
  org("mideki-free-factors", "Свободные факторы Мидеки", "Разрозненные торговые дома коммун, принимающие высокий санкционный риск.", ["royu-mideki"], ["rice", "tea", "gunpowder", "tools"], ["royu-mideki", "boltrask", "sarroyo"], ["caravan", "airship"])
];

// Keep a meaningful residual for independent merchants and carriers. The runtime
// also normalizes overcommitted shares, but prepared data should be legible in the editor.
const capCountryShares = (role, cap) => {
  const totals = {};
  for (const organization of organizations) {
    for (const presence of organization[role]?.countryShares ?? []) totals[presence.countryId] = (totals[presence.countryId] ?? 0) + presence.sharePct;
  }
  for (const organization of organizations) {
    for (const presence of organization[role]?.countryShares ?? []) {
      const total = totals[presence.countryId] ?? 0;
      if (total > cap) presence.sharePct = Math.round((presence.sharePct * cap / total) * 10) / 10;
    }
  }
};
capCountryShares("merchant", 82);
capCountryShares("buyer", 82);
capCountryShares("carrier", 78);

const routeMap = {
  background: "modules/fbl-skyhold/assets/maps/air-islands-world.jpg",
  backgroundOpacity: 0.78,
  worldWidth: 5000,
  worldHeight: 2750,
  centerX: 2500,
  centerY: 1375,
  zoom: 0.32,
  nodeMode: "compact",
  kmPerPixel: KM_PER_PIXEL,
  calibration: { pointA: { x: 3670, y: 2678 }, pointB: { x: 4544, y: 2678 }, distanceKm: 600 },
  contentSource: NETWORK_SOURCE,
  contentVersion: CONTENT_VERSION
};

const obsoleteRegionIds = ["sirosten", "izuaver", "pai-orgul", "lezhnizem", "dihtbeir", "tiribor", "yaknizem", "horslia-ontakva", "fletchenrand", "sangren", "novand", "kaldvelg", "naerder", "boltrask", "sarroyo", "royu-sageki", "royu-mideki"];
const retire = [
  { kind: "market.countries", id: "pai-orgul", sources: [LIBRARY_SOURCE, "fbl-skyhold.air-islands-material-market-library"] },
  ...obsoleteRegionIds.map((id) => ({ kind: "regions", id, sources: [NETWORK_SOURCE] })),
  { kind: "market.organizations", id: "elbow-guilds", sources: [NETWORK_SOURCE] }
];

const marketSettings = createDefaultMarketEconomy([]).settings;
const withSharedMetadata = (row) => ({ ...row, contentSource: LIBRARY_SOURCE, contentVersion: CONTENT_VERSION });
const sharedConditions = [
  ...DEFAULT_MARKET_CONDITIONS.filter((row) => !conditions.some((condition) => condition.id === row.id)),
  ...conditions
].map(withSharedMetadata);
const sharedSpecialties = [
  ...DEFAULT_MARKET_SPECIALTIES.filter((row) => !customSpecialties.some((specialty) => specialty.id === row.id)),
  ...customSpecialties
].map((row) => ({ ...withSharedMetadata(row), offers: (row.offers ?? []).map((offer) => canonicalizeMarketOffer(offer)) }));
const sharedSizeProfiles = DEFAULT_MARKET_SIZE_PROFILES.map(withSharedMetadata);

library.id = "air-islands-materials-and-country-markets";
library.name = "Воздушные Острова: материалы и рынки 882 П.П.";
library.description = `Полный редактируемый каталог: ${library.content.resources.length} материалов и характерные рынки ${countries.length} доступных государств. Пай Оргул исключён.`;
library.version = CONTENT_VERSION;
library.content.resources = library.content.resources;
library.content.marketEconomy = {
  settings: marketSettings,
  baseOffers: preparedBaseOffers,
  countries,
  conditions: sharedConditions,
  specialties: sharedSpecialties,
  sizeProfiles: sharedSizeProfiles,
  organizations: []
};
library.content.retire = retire.filter((row) => row.kind === "market.countries");

const network = {
  ...previousNetwork,
  id: "air-islands-trade-network-template",
  name: "Воздушные Острова: торговая сеть 882 П.П.",
  description: `Чистая установка экономики 882 года: ${regions.length} расставленных рынков-локаций и ${organizations.length} организаций. Связи намеренно не заданы — GM строит их самостоятельно.`,
  version: CONTENT_VERSION,
  install: { replaceMarket: true, replaceResources: true, overwriteResources: true },
  content: {
    ...previousNetwork.content,
    resources: library.content.resources,
    regions,
    marketRouteMap: routeMap,
    marketEconomy: {
      settings: marketSettings,
      baseOffers: preparedBaseOffers,
      countries,
      conditions: sharedConditions,
      organizations,
      specialties: sharedSpecialties,
      sizeProfiles: sharedSizeProfiles
    },
    retire: []
  }
};

writeFileSync(libraryPath, `${JSON.stringify(library, null, 2)}\n`, "utf8");
writeFileSync(networkPath, `${JSON.stringify(network, null, 2)}\n`, "utf8");
console.log(`Built ${library.content.resources.length} resources, ${preparedBaseOffers.length} base offers, ${countries.length} countries, ${regions.length} unlinked locations, ${sharedSpecialties.length} specialties and ${organizations.length} organizations.`);
