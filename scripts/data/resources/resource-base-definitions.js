function materialResource(id, label, physical = {}) {
  const definition = {
    id,
    label,
    unit: "ед.",
    unitLabel: "партия",
    quantityStep: 0.1,
    priceBasis: "за партию",
    packageMassKg: 0,
    packageVolumeL: 0,
    foodValue: 0,
    dietGroup: "",
    nutritionTags: [],
    shelfLifeDays: 0,
    qualityTier: "common",
    icon: "fa-solid fa-cube",
    category: "Материалы",
    useInProduction: true,
    useInConstruction: true,
    ...physical
  };
  return {
    ...definition,
    load: physical.load ?? (Math.max(definition.packageMassKg / 10, definition.packageVolumeL / 20) || 1)
  };
}

function foodMaterial(id, label, physical = {}) {
  return materialResource(id, label, {
    category: "Food",
    useInConstruction: false,
    quantityStep: physical.quantityStep ?? (physical.foodValue > 0 ? 1 / physical.foodValue : 0.1),
    ...physical
  });
}

function livestock(id, label, physical = {}) {
  return materialResource(id, label, {
    category: "Животные",
    unit: "гол.",
    unitLabel: "голова",
    quantityStep: 1,
    priceBasis: "за голову",
    foodValue: 0,
    dietGroup: "",
    nutritionTags: [],
    shelfLifeDays: 0,
    useInConstruction: false,
    marketTags: ["livestock"],
    ...physical
  });
}

function independentResource(id, label, icon, { useInConstruction = true, notes } = {}) {
  return {
    id,
    label,
    unit: "ед.",
    unitLabel: "партия",
    quantityStep: 0.1,
    priceBasis: "за партию",
    packageMassKg: 0,
    packageVolumeL: 0,
    load: 1,
    foodValue: 0,
    dietGroup: "",
    nutritionTags: [],
    shelfLifeDays: 0,
    qualityTier: "common",
    icon,
    category: "Материалы",
    useInProduction: true,
    useInConstruction,
    notes
  };
}

export const RESOURCE_BASE_DEFINITIONS = [
  { id: "money", label: "Деньги", unit: "медн.", unitLabel: "монета", quantityStep: 1, priceBasis: "за монету", packageMassKg: 0.01, packageVolumeL: 0.001, load: 0, foodValue: 0, nutritionTags: [], shelfLifeDays: 0, qualityTier: "common", icon: "fa-solid fa-coins", category: "Деньги", isMoney: true },
  livestock("cattle", "Крупный рогатый скот", { packageMassKg: 400, packageVolumeL: 800, load: 40, icon: "fa-solid fa-cow", marketTags: ["livestock", "cattle", "dairy", "meat"] }),
  livestock("pigs", "Свиньи", { packageMassKg: 100, packageVolumeL: 180, load: 10, icon: "fa-solid fa-piggy-bank", marketTags: ["livestock", "pig", "meat"] }),
  livestock("sheep", "Овцы", { packageMassKg: 60, packageVolumeL: 120, load: 6, icon: "fa-solid fa-paw", marketTags: ["livestock", "sheep", "wool", "meat"] }),
  livestock("goats", "Козы", { packageMassKg: 50, packageVolumeL: 100, load: 5, icon: "fa-solid fa-paw", marketTags: ["livestock", "goat", "dairy", "meat"] }),
  livestock("horses", "Лошади", { packageMassKg: 450, packageVolumeL: 900, load: 45, icon: "fa-solid fa-horse", marketTags: ["livestock", "horse", "riding", "draft"] }),
  livestock("chickens", "Куры", { packageMassKg: 2, packageVolumeL: 4, load: 0.2, icon: "fa-solid fa-kiwi-bird", marketTags: ["livestock", "poultry", "chicken", "eggs", "meat"] }),
  livestock("geese", "Гуси", { packageMassKg: 5, packageVolumeL: 10, load: 0.5, icon: "fa-solid fa-crow", marketTags: ["livestock", "poultry", "goose", "eggs", "feathers", "meat"] }),
  livestock("rabbits", "Кролики", { packageMassKg: 2.5, packageVolumeL: 4, load: 0.25, icon: "fa-solid fa-paw", marketTags: ["livestock", "rabbit", "meat", "pelt"] }),
  livestock("pigeons", "Почтовые голуби", { packageMassKg: 0.5, packageVolumeL: 1, load: 0.05, icon: "fa-solid fa-dove", marketTags: ["livestock", "pigeon", "messenger"] }),
  materialResource("black-coal", "Black Coal", { unitLabel: "мешок", priceBasis: "за мешок", packageMassKg: 10, packageVolumeL: 15 }),
  foodMaterial("bread", "Bread", { unitLabel: "свёрток", priceBasis: "за свёрток", packageMassKg: 2.5, packageVolumeL: 10, foodValue: 4, dietGroup: "staple", nutritionTags: ["staple", "prepared"], shelfLifeDays: 5 }),
  materialResource("charcoal", "Charcoal", { unitLabel: "мешок", priceBasis: "за мешок", packageMassKg: 5, packageVolumeL: 20 }),
  materialResource("cloth-silk", "Cloth, Silk", { unitLabel: "отрез", priceBasis: "за отрез", packageMassKg: 1.5, packageVolumeL: 10, qualityTier: "luxury" }),
  materialResource("cloth-wool", "Cloth, Wool", { unitLabel: "отрез", priceBasis: "за отрез", packageMassKg: 1.5, packageVolumeL: 10 }),
  materialResource("coke", "Coke", { unitLabel: "мешок", priceBasis: "за мешок", packageMassKg: 10, packageVolumeL: 15 }),
  materialResource("copper", "Copper", { unitLabel: "слиток", priceBasis: "за слиток", packageMassKg: 3, packageVolumeL: 1 }),
  foodMaterial("eggs", "Яйца", { unitLabel: "корзина", priceBasis: "за корзину", packageMassKg: 2.5, packageVolumeL: 5, foodValue: 3, dietGroup: "protein", nutritionTags: ["protein", "fresh"], shelfLifeDays: 14 }),
  materialResource("feathers", "Перо и пух", { unitLabel: "связка", priceBasis: "за связку", packageMassKg: 0.5, packageVolumeL: 10 }),
  foodMaterial("flour", "Flour", { unitLabel: "малый мешок", priceBasis: "за мешок", packageMassKg: 2.5, packageVolumeL: 5, foodValue: 5, dietGroup: "staple", nutritionTags: ["staple", "ingredient"], shelfLifeDays: 180 }),
  foodMaterial("fruits", "Fruits", { unitLabel: "корзина", priceBasis: "за корзину", packageMassKg: 2.5, packageVolumeL: 10, foodValue: 3, dietGroup: "produce", nutritionTags: ["fresh"], shelfLifeDays: 10 }),
  materialResource("glass", "Glass", { unitLabel: "партия заготовок", priceBasis: "за партию", packageMassKg: 5, packageVolumeL: 4 }),
  materialResource("gold", "Gold", { unitLabel: "малый слиток", priceBasis: "за слиток", packageMassKg: 0.1, packageVolumeL: 0.1, qualityTier: "luxury" }),
  foodMaterial("grain", "Grain", { unitLabel: "малый мешок", priceBasis: "за мешок", packageMassKg: 2.5, packageVolumeL: 5, foodValue: 5, dietGroup: "staple", nutritionTags: ["staple"], shelfLifeDays: 360 }),
  materialResource("herbs", "Herbs", { unitLabel: "связка", priceBasis: "за связку", packageMassKg: 0.5, packageVolumeL: 1 }),
  foodMaterial("honey", "Honey", { unitLabel: "горшок", priceBasis: "за горшок", packageMassKg: 2, packageVolumeL: 2, foodValue: 2, nutritionTags: ["sweetener"] }),
  materialResource("iron", "Iron", { unitLabel: "крица или пакет прутков", priceBasis: "за партию", packageMassKg: 3, packageVolumeL: 1 }),
  materialResource("iron-ore", "Iron Ore", { unitLabel: "мешок", priceBasis: "за мешок", packageMassKg: 10, packageVolumeL: 6 }),
  materialResource("leather", "Leather", { unitLabel: "часть шкуры", priceBasis: "за часть шкуры", packageMassKg: 2, packageVolumeL: 10 }),
  foodMaterial("meat", "Meat", { unitLabel: "продовольственная партия", priceBasis: "за партию", packageMassKg: 2.5, packageVolumeL: 5, foodValue: 4, dietGroup: "protein", nutritionTags: ["protein"], shelfLifeDays: 4 }),
  foodMaterial("milk", "Milk", { unitLabel: "кувшин", priceBasis: "за кувшин", packageMassKg: 3, packageVolumeL: 3, foodValue: 2, dietGroup: "dairy", nutritionTags: ["dairy", "protein"], shelfLifeDays: 3 }),
  foodMaterial("prepared-food", "Готовая пища", { unitLabel: "партия порций", priceBasis: "за партию", packageMassKg: 2.5, packageVolumeL: 5, foodValue: 3, nutritionTags: ["prepared"], shelfLifeDays: 3 }),
  materialResource("parchment", "Parchment", {
    unitLabel: "пачка листов",
    priceBasis: "за пачку",
    packageMassKg: 1,
    packageVolumeL: 3,
    icon: "fa-solid fa-scroll",
    notes: "Учётная пачка подготовленных листов для письма, учёта и ремесленного производства."
  }),
  materialResource("pelt", "Pelt", { unitLabel: "сложенная шкура", priceBasis: "за шкуру", packageMassKg: 2.5, packageVolumeL: 25 }),
  materialResource("silver", "Silver", { unitLabel: "малый слиток", priceBasis: "за слиток", packageMassKg: 0.1, packageVolumeL: 0.1, qualityTier: "quality" }),
  materialResource("stone", "Stone", { unitLabel: "обработанный блок", priceBasis: "за блок", packageMassKg: 40, packageVolumeL: 16, quantityStep: 1 }),
  materialResource("straw", "Straw", {
    unitLabel: "малая кипа",
    priceBasis: "за кипу",
    packageMassKg: 10,
    packageVolumeL: 100,
    icon: "fa-solid fa-wheat-awn",
    notes: "Малая перевязанная кипа для корма, подстилки и строительства; расчётная плотность 100 кг/м³."
  }),
  materialResource("tallow", "Tallow", { unitLabel: "брусок или горшок", priceBasis: "за партию", packageMassKg: 2, packageVolumeL: 3 }),
  foodMaterial("vegetables", "Vegetables", { unitLabel: "корзина", priceBasis: "за корзину", packageMassKg: 2.5, packageVolumeL: 10, foodValue: 3, dietGroup: "produce", nutritionTags: ["fresh"], shelfLifeDays: 14 }),
  materialResource("wood", "Wood", { unitLabel: "связка пиломатериала", priceBasis: "за связку", packageMassKg: 10, packageVolumeL: 20 }),
  materialResource("wool", "Wool", { unitLabel: "спрессованная кипа", priceBasis: "за кипу", packageMassKg: 1, packageVolumeL: 20 }),
  independentResource("water", "Water", "fa-solid fa-droplet", {
    useInConstruction: false,
    notes: "Собственный ресурс Skyhold для питья и производственных расходов."
  })
];
