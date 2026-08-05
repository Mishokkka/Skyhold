function productionLine({ id, name, contentId, contentUnitsPerBatch, resourceId, outputQty, cadence = "tenday", expenses = "", collectQd = 1, seasons = null }) {
  return {
    id, active: true, name, mode: name, source: "content", contentId, cadence, cadenceEvery: 1,
    contentUnitsPerBatch, resourceId, resource: resourceId, outputQty, laborQdPerBatch: 0, maxBatchesPerCadence: 1,
    expenseMode: "cycle", expenses, costsText: expenses, requiresCollection: true, collectQd,
    pendingQty: 0, storageRoomId: "outdoors", autoCollect: "building",
    ...(seasons ? { seasons, daylightProductionOnly: true } : {})
  };
}

function livestockTemplate({ id, name, icon, description, foodBonus, technologyBonus = 0, materialCosts, contents, productionLines, workersMax, effect, capital }) {
  return {
    id, compendiumId: "", name, type: "Производство", primaryDev: "food", icon, img: "", unlocked: true, description,
    sourceRequirement: "Животные приобретаются отдельно и размещаются со склада",
    sourceRawMaterials: materialCosts.map((row) => `${row.qty} ${row.name}`).join(", "),
    specialRequirements: "", requirements: { food: 2, technology: 0, culture: 0, war: 0 },
    bonuses: { food: foodBonus, technology: technologyBonus, culture: 0, war: 0 },
    buildDifficulty: 0, buildTarget: 2, buildProgress: 0, constructionStatus: "planned", materialCosts, requiredBuildingIds: [],
    workersMin: 0, workersMax,
    suitableWorkerTypes: "Все с ЭМП, Все с СИЛ, Переговорщик, Силач",
    workerTypeEffects: { "Все с ЭМП": 0.5, "Все с СИЛ": 0.5, "Переговорщик": 1, "Силач": 1 },
    workerRole: "Скотник", functions: { production: true, income: false, defense: false, housing: false, storage: false, culture: false },
    contents, productionLines,
    income: { base: 0, perWorker: 0, formula: "", risk: 0, illegal: false, trade: { enabled: false, budgetFormula: "2d6*10", maxLotsPerBuyer: 1, roomId: "all", kind: "all", notes: "" } },
    defense: { base: 0, perStep: 0, workerStep: 0 }, housing: { capacity: 0, comfort: 0, quality: 0, notes: "" },
    storage: { capacity: 0, security: 0, quality: 0 }, reputation: 0, moraleDelta: 0, workerMoraleDelta: 0, upkeep: 1,
    effect,
    notes: "Количество животных задаётся в «Содержимом здания» и прямо масштабирует выпуск. Покупка, приплод, падёж и расширение поголовья остаются управляемыми действиями или событиями.",
    templateVersion: 12, visibility: "public", workerPrimaryAttribute: "strength",
    enterpriseCapital: {
      version: 2,
      enabled: true,
      fundedCopper: 0,
      commissioningPaidCopper: 0,
      workingCapitalReserveCopper: 0,
      fundingProvenance: "treasury",
      legacyGrandfathered: false,
      ...capital
    }
  };
}

const SPRING = { spring: true, summer: false, autumn: false, winter: false };
const WARM = { spring: true, summer: true, autumn: false, winter: false };
const AUTUMN = { spring: false, summer: false, autumn: true, winter: false };

export const BUILDING_TEMPLATES_LIVESTOCK = [
  livestockTemplate({
    id: "goat-pen", name: "Козлятник", icon: "fa-solid fa-paw",
    description: "Небольшое молочное хозяйство для коз, пригодное для бедных и холодных пастбищ.", foodBonus: 3, technologyBonus: 1,
    materialCosts: [{ id: "mat-wood", name: "Wood", resourceId: "wood", qty: 70 }, { id: "mat-stone", name: "Stone", resourceId: "stone", qty: 8 }],
    contents: [{ id: "goats", name: "Козы", resourceId: "goats", qty: 0, capacity: 12, notes: "Козы поступают со склада и определяют выпуск молока." }],
    productionLines: [productionLine({ id: "goat-milk", name: "Козье молоко", contentId: "goats", contentUnitsPerBatch: 12, resourceId: "milk", outputQty: 1, cadence: "day", collectQd: 1 })],
    workersMax: 3, effect: "Полное стадо из двенадцати коз даёт 1 партию Milk в день; сбор требует 1 QD, а обычный корм обеспечивает выпас.",
    capital: { landCopper: 1000, equipmentCopper: 220, workingCapitalCopper: 400, renewalPercentAnnual: 8, notes: "Права на выпас, молочный инвентарь и резерв. Козы покупаются отдельно." }
  }),
  livestockTemplate({
    id: "poultry-yard", name: "Птичий двор", icon: "fa-solid fa-kiwi-bird",
    description: "Двор для кур и гусей, дающий яйца, мясо, перо и пух.", foodBonus: 3,
    materialCosts: [{ id: "mat-wood", name: "Wood", resourceId: "wood", qty: 55 }, { id: "mat-stone", name: "Stone", resourceId: "stone", qty: 5 }, { id: "mat-straw", name: "Straw", resourceId: "straw", qty: 12 }],
    contents: [
      { id: "chickens", name: "Куры", resourceId: "chickens", qty: 0, capacity: 24, notes: "Куры поступают со склада и дают основную часть яиц." },
      { id: "geese", name: "Гуси", resourceId: "geese", qty: 0, capacity: 12, notes: "Гуси поступают со склада и дают яйца, мясо, перо и пух." }
    ],
    productionLines: [
      productionLine({ id: "chicken-eggs", name: "Куриные яйца", contentId: "chickens", contentUnitsPerBatch: 24, resourceId: "eggs", outputQty: 12, expenses: "Grain 1" }),
      productionLine({ id: "goose-eggs", name: "Гусиные яйца", contentId: "geese", contentUnitsPerBatch: 12, resourceId: "eggs", outputQty: 2, expenses: "Grain 1", seasons: WARM }),
      productionLine({ id: "goose-feathers", name: "Перо и пух", contentId: "geese", contentUnitsPerBatch: 12, resourceId: "feathers", outputQty: 6, cadence: "year", seasons: SPRING }),
      productionLine({ id: "chicken-meat", name: "Выбраковка кур", contentId: "chickens", contentUnitsPerBatch: 24, resourceId: "meat", outputQty: 12, cadence: "year", expenses: "Grain 2", seasons: AUTUMN }),
      productionLine({ id: "goose-meat", name: "Выбраковка гусей", contentId: "geese", contentUnitsPerBatch: 12, resourceId: "meat", outputQty: 12, cadence: "year", expenses: "Grain 1", seasons: AUTUMN })
    ],
    workersMax: 3, effect: "Полная когорта из 24 кур даёт 12 Eggs за десятник; 12 гусей дают 2 Eggs за тёплый десятник. Весной собирают 6 Feathers, осенью получают целые партии мяса.",
    capital: { landCopper: 350, equipmentCopper: 180, workingCapitalCopper: 250, renewalPercentAnnual: 12, notes: "Малый двор, гнёзда, кормушки и запас зерна. Птица покупается отдельно." }
  }),
  livestockTemplate({
    id: "rabbitry", name: "Крольчатник", icon: "fa-solid fa-paw",
    description: "Компактное хозяйство для быстрого получения мяса и мелких шкурок.", foodBonus: 2,
    materialCosts: [{ id: "mat-wood", name: "Wood", resourceId: "wood", qty: 45 }, { id: "mat-iron", name: "Iron", resourceId: "iron", qty: 2 }, { id: "mat-straw", name: "Straw", resourceId: "straw", qty: 10 }],
    contents: [{ id: "rabbits", name: "Кролики", resourceId: "rabbits", qty: 0, capacity: 24, notes: "Кролики поступают со склада и определяют устойчивый выпуск мяса и шкурок." }],
    productionLines: [
      productionLine({ id: "rabbit-meat", name: "Крольчатина", contentId: "rabbits", contentUnitsPerBatch: 24, resourceId: "meat", outputQty: 6, expenses: "Grain 1", collectQd: 2 }),
      productionLine({ id: "rabbit-pelt", name: "Кроличьи шкурки", contentId: "rabbits", contentUnitsPerBatch: 24, resourceId: "pelt", outputQty: 2 })
    ],
    workersMax: 2, effect: "Полная когорта из двадцати четырёх кроликов даёт за десятник 6 Meat и 2 Pelt при устойчивом восстановлении поголовья.",
    capital: { landCopper: 250, equipmentCopper: 200, workingCapitalCopper: 300, renewalPercentAnnual: 15, notes: "Клети, кормушки и запас корма. Кролики покупаются отдельно." }
  })
];
