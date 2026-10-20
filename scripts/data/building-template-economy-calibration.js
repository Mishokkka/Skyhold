import { AGRICULTURE_CROP_OUTPUT_V1 } from "./agriculture.js";

const MONEY_FLOW_SCALE_V2 = 6;

const basic = (baseUpkeepMonthlyCopper, operatingUpkeepMonthlyCopper = 3, maintenanceRequiredPoints = 1) => ({
  wageDailyCopper: 12,
  baseUpkeepMonthlyCopper: baseUpkeepMonthlyCopper * MONEY_FLOW_SCALE_V2,
  operatingUpkeepMonthlyCopper: operatingUpkeepMonthlyCopper * MONEY_FLOW_SCALE_V2,
  maintenanceRequiredPoints
});

const skilled = (baseUpkeepMonthlyCopper, operatingUpkeepMonthlyCopper = 6, maintenanceRequiredPoints = 1) => ({
  wageDailyCopper: 18,
  baseUpkeepMonthlyCopper: baseUpkeepMonthlyCopper * MONEY_FLOW_SCALE_V2,
  operatingUpkeepMonthlyCopper: operatingUpkeepMonthlyCopper * MONEY_FLOW_SCALE_V2,
  maintenanceRequiredPoints
});

const line = (wageDailyCopper, operatingUpkeepMonthlyCopper, overrides = {}) => ({
  wageDailyCopper: wageDailyCopper * MONEY_FLOW_SCALE_V2,
  operatingUpkeepMonthlyCopper: operatingUpkeepMonthlyCopper * MONEY_FLOW_SCALE_V2,
  ...overrides
});

/**
 * Integer economy calibration v2.
 *
 * Money is copper (MM): basic work costs 12/day, skilled/hazardous/trade work
 * costs 18/day. Base upkeep preserves the Stronghold-relative `upkeep` scale as
 * 18 * max(1, legacy upkeep); operating upkeep is charged only while the
 * corresponding function works. These are template defaults and remain fully
 * editable by the GM after a building is created.
 */
export const ECONOMIC_TEMPLATE_CALIBRATION_V1 = Object.freeze({
  "grain-field": basic(3),
  garden: basic(3),
  pasture: basic(3),
  pigsty: basic(3),
  sheepfold: basic(3),
  stables: basic(3),
  mill: {
    ...skilled(3),
    productionLines: {
      line: line(3, 6, { outputQty: 6, expenses: "Grain 6", costsText: "Grain 6" })
    },
    additionalProductionLines: [{
      id: "line-feed",
      active: true,
      name: "Корм для животных",
      mode: "Корм для животных",
      source: "workers",
      period: "qd",
      resourceId: "animal-feed",
      resource: "Animal Feed",
      outputQty: 2,
      workQd: 1,
      expenseMode: "cycle",
      expenses: "Grain 2",
      costsText: "Grain 2",
      requiresCollection: false,
      collectQd: 0,
      pendingQty: 0,
      storageRoomId: "outdoors",
      autoCollect: "none",
      wageDailyCopper: 18,
      operatingUpkeepMonthlyCopper: 36
    }]
  },
  bakery: {
    ...skilled(3),
    productionLines: {
      line: line(3, 6, { outputQty: 6, expenses: "Flour 6", costsText: "Flour 6" })
    }
  },
  inn: {
    ...skilled(9),
    productionLines: {
      line: line(3, 6, { outputQty: 3, expenses: "Белковое сырьё 3", costsText: "Белковое сырьё 3" }),
      "line-2": line(3, 6, { name: "Готовая пища (растительная)", mode: "Готовая пища (растительная)", outputQty: 3, expenses: "Плодовое сырьё 3", costsText: "Овощи или фрукты 3" }),
      "line-3": line(3, 6, { outputQty: 3, expenses: "Milk 3", costsText: "Milk 3" }),
      "line-4": line(3, 6, { outputQty: 3, expenses: "Eggs 2, Flour 1", costsText: "Eggs 2, Flour 1" })
    },
    income: line(3, 6)
  },
  lumbermill: {
    ...basic(3),
    productionLines: { line: line(2, 3) },
    additionalProductionLines: [{ id: "line-rare-wood", active: false, requiresGmConfirmation: true, name: "Редкая древесина", mode: "Подтверждённый редкий лес", source: "workers", period: "qd", resourceId: "rare-wood", resource: "Редкая древесина", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 12, operatingUpkeepMonthlyCopper: 18, storageRoomId: "outdoors", autoCollect: "none" }],
    template: { productionSelection: { exclusive: true, gmConfirmed: false } }
  },
  quarry: {
    ...basic(3),
    productionLines: { line: line(2, 3) },
    additionalProductionLines: [{ id: "line-marble", active: false, requiresGmConfirmation: true, name: "Мрамор", mode: "Подтверждённый мраморный пласт", source: "workers", period: "qd", resourceId: "marble", resource: "Мрамор", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 12, operatingUpkeepMonthlyCopper: 18, storageRoomId: "outdoors", autoCollect: "none" }],
    template: { productionSelection: { exclusive: true, gmConfirmed: false } }
  },
  mine: {
    ...skilled(6, 9, 2),
    productionLines: { line: line(3, 9) },
    additionalProductionLines: [
      { id: "mine-solid-fuel", active: false, name: "Твёрдое топливо", mode: "Месторождение: твёрдое топливо", source: "workers", period: "qd", resourceId: "fuel-solid", resource: "Твёрдое топливо", outputQty: 2, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "mine-copper", active: false, name: "Медь", mode: "Месторождение: медь", source: "workers", period: "qd", resourceId: "copper", resource: "Медь", outputQty: 2, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "mine-nonferrous", active: false, name: "Цветные металлы", mode: "Месторождение: цветные металлы", source: "workers", period: "qd", resourceId: "nonferrous-metals", resource: "Цветные металлы", outputQty: 2, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "mine-salt", active: false, name: "Соль", mode: "Месторождение: соль", source: "workers", period: "qd", resourceId: "salt", resource: "Соль", outputQty: 2, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "mine-rare-earth", active: false, requiresGmConfirmation: true, name: "Редкоземельные металлы", mode: "Сюжетное месторождение: редкоземельные металлы", source: "workers", period: "qd", resourceId: "rare-earth-metals", resource: "Редкоземельные металлы", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "mine-crystal-dust", active: false, requiresGmConfirmation: true, name: "Кристаллическая пыль", mode: "Сюжетное месторождение: кристаллическая пыль", source: "workers", period: "qd", resourceId: "crystal-dust", resource: "Кристаллическая пыль", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "", costsText: "", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, storageRoomId: "outdoors", autoCollect: "none" }
    ],
    template: { productionSelection: { exclusive: true, gmConfirmed: false }, effect: "ГМ выбирает одно месторождение. Обычная добыча даёт 2 ед./QD; сюжетная редкая — 1 ед./QD." }
  },
  forge: {
    ...skilled(9, 9, 2),
    productionLines: {
      line: line(3, 9, { outputQty: 1, expenses: "Iron Ore 1", costsText: "Iron Ore 1" })
    }
  },
  tannery: {
    ...skilled(3),
    productionLines: {
      line: line(3, 6, { outputQty: 2, expenses: "Pelt 2", costsText: "Pelt 2" })
    }
  },
  "tailor-shop": {
    ...skilled(3),
    productionLines: {
      line: line(3, 6, { outputQty: 2, expenses: "Wool 2", costsText: "Wool 2" })
    }
  },
  "personnel-office": {
    ...skilled(3),
    income: line(3, 6)
  },
  market: {
    ...skilled(6, 9),
    income: line(3, 9)
  },
  apothecary: {
    ...skilled(3),
    additionalProductionLines: [
      { id: "line-medical-supplies", active: true, name: "Медицинские припасы", mode: "Медицинские припасы", source: "workers", period: "qd", resourceId: "medical-supplies", resource: "Медицинские припасы", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "Herbs 2, Cloth 1", costsText: "Травы 2, ткань 1", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, storageRoomId: "outdoors", autoCollect: "none" },
      { id: "line-medicines", active: true, name: "Лекарства", mode: "Лекарства", source: "workers", period: "qd", resourceId: "medicines", resource: "Лекарства", outputQty: 1, workQd: 1, expenseMode: "cycle", expenses: "Herbs 4, Complex Chemicals 1", costsText: "Травы 4, сложные химические материалы 1", wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, storageRoomId: "outdoors", autoCollect: "none" }
    ]
  }
});

export const ECONOMIC_TEMPLATE_IDS_V1 = Object.freeze(Object.keys(ECONOMIC_TEMPLATE_CALIBRATION_V1));

export const ECONOMIC_TEMPLATE_CALIBRATION_V2 = Object.freeze({
  well: { template: { workersMin: 0, workersMax: 0 } },
  "root-cellar": { template: { workersMin: 0, workersMax: 0, storage: { profileLabel: "Скоропортящаяся пища", profilePerishableFood: true, profileCapacityMultiplier: 0.5, profileRequiresStaff: false } } },
  vault: { template: { workersMin: 0, workersMax: 0, storage: { profileLabel: "Ценности и дорогие товары", profileResourceIds: ["silver", "gold", "gemstones", "art-goods", "parchment", "tsukami-paper", "household-goods-fine", "silk"], profileCapacityMultiplier: 0.5, profileRequiresStaff: false } } },
  stables: { wageDailyCopper: 12, operatingUpkeepMonthlyCopper: 18, maintenanceRequiredPoints: 1, template: { functions: { production: true }, effect: "Содержит до 12 лошадей. Разведение не автоматизируется; вне бесплатного выпаса каждая лошадь потребляет 2 корма за десятник." } },
  "construction-center": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 2 },
  "hiring-agency": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  pier: { template: { workersMin: 0, workersMax: 0 } },
  lighthouse: {
    wageDailyCopper: 18,
    operatingUpkeepMonthlyCopper: 36,
    maintenanceRequiredPoints: 2,
    template: {
      materialCosts: [
        { id: "mat-stone", name: "Камень", resourceId: "stone", qty: 200 },
        { id: "mat-glass", name: "Стекло", resourceId: "glass", qty: 20 },
        { id: "mat-iron", name: "Железо", resourceId: "iron", qty: 20 }
      ],
      fuelAlternatives: [{ resourceId: "fuel-liquid", qty: 1, label: "1 Жидкое топливо" }, { resourceId: "wood", qty: 2, label: "2 Древесина" }],
      fuelChoice: "fuel-liquid",
      effect: "При работающем смотрителе поддерживает навигационный огонь. За десятник ГМ выбирает расход: 1 Жидкое топливо или 2 Древесина."
    }
  },
  bathhouse: {
    wageDailyCopper: 18,
    operatingUpkeepMonthlyCopper: 600,
    maintenanceRequiredPoints: 1
  },
  dovecote: {
    wageDailyCopper: 0,
    operatingUpkeepMonthlyCopper: 0,
    maintenanceRequiredPoints: 1,
    template: { workersMin: 0, workersMax: 0 }
  },
  "tent-camp": { template: { workersMin: 0, workersMax: 0 } },
  cemetery: { template: { workersMin: 0, workersMax: 0 } },
  library: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1, template: { materialCosts: [{ id: "mat-wood", name: "Древесина", resourceId: "wood", qty: 100 }, { id: "mat-written", name: "Письменные материалы", resourceId: "parchment", qty: 20 }] } },
  scriptorium: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 2 },
  shrine: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  "hall-of-fame": { template: { workersMin: 0, workersMax: 0, materialCosts: [{ id: "mat-stone", name: "Камень", resourceId: "stone", qty: 200 }, { id: "mat-money", name: "Деньги", resourceId: "money", qty: 40000 }] } },
  spire: { template: { workersMin: 0, workersMax: 0, materialCosts: [{ id: "mat-stone", name: "Камень", resourceId: "stone", qty: 150 }, { id: "mat-money", name: "Деньги", resourceId: "money", qty: 20000 }] } },
  "shooting-range": { template: { workersMin: 0, workersMax: 0 } },
  "training-camp": { template: { workersMin: 0, workersMax: 0 } },
  ramparts: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 2 },
  moat: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 2 },
  portcullis: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  "guard-tower": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  dungeon: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  gallows: { template: { workersMin: 0, workersMax: 0 } },
  bunkhouse: { template: { workersMin: 0, workersMax: 0 } },
  "common-house": { template: { workersMin: 0, workersMax: 0 } },
  "boarding-house": { template: { workersMin: 0, workersMax: 0 } },
  barn: { template: { workersMin: 0, workersMax: 0, storage: { profileLabel: "Сухие сельскохозяйственные запасы", profileResourceIds: ["grain", "flour", "animal-feed", "straw", "hops"], profileMarketTags: ["agriculture", "fodder", "grain"], profileCapacityMultiplier: 0.5, profileRequiresStaff: false } } },
  warehouse: { template: { workersMin: 0, workersMax: 0 } },
  "guarded-storehouse": {
    wageDailyCopper: 18,
    operatingUpkeepMonthlyCopper: 36,
    maintenanceRequiredPoints: 1,
    template: { workersMin: 1, storage: { profileLabel: "Универсальный охраняемый склад", profileCapacityMultiplier: 1, profileRequiresStaff: true } }
  },
  barracks: { template: { workersMin: 0, workersMax: 0 } },
  arsenal: {
    wageDailyCopper: 18,
    operatingUpkeepMonthlyCopper: 36,
    maintenanceRequiredPoints: 1,
    template: { workersMin: 1, storage: { profileLabel: "Вооружение", profileCategoryTags: ["armament"], profileCapacityMultiplier: 0.5, profileRequiresStaff: true }, effect: "Хранит комплекты вооружения отрядов. Ориентир за комплект пяти человек: 1 200 ММ (простое), 2 400 ММ (сложное), 7 200 ММ (элитное)." }
  },
  lazaret: {
    wageDailyCopper: 18,
    operatingUpkeepMonthlyCopper: 36,
    maintenanceRequiredPoints: 1
  },
  apothecary: { template: { workersMin: 1, functions: { production: true, income: false, storage: true, culture: true }, storage: { profileLabel: "Медицина и химия", profileResourceIds: ["herbs", "medical-supplies", "medicines", "chemicals-simple", "chemicals-complex"], profileCapacityMultiplier: 0.5, profileRequiresStaff: false } } },
  "watch-post": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 18, maintenanceRequiredPoints: 1 },
  "barricade-line": { wageDailyCopper: 12, operatingUpkeepMonthlyCopper: 18, maintenanceRequiredPoints: 1 },
  gatehouse: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 2 },
  "signal-tower": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1 },
  "powder-magazine": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1, template: { storage: { profileLabel: "Боеприпасы и взрывчатка", profileResourceIds: ["military-supplies-simple", "military-supplies-complex", "explosives"], profileCapacityMultiplier: 0.5, profileRequiresStaff: true } } },
  "field-fort": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, maintenanceRequiredPoints: 2 },
  "artillery-platform": { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 54, maintenanceRequiredPoints: 2 },
  school: { wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 36, maintenanceRequiredPoints: 1, template: { effect: "Оплаченный учитель создаёт предложение решения ГМа при возрастной вехе ребёнка; характеристики и черты не меняются автоматически." } },
  "laputa-excavated-crypt": { template: { storage: { profileLabel: "Скоропортящаяся пища", profilePerishableFood: true, profileCapacityMultiplier: 0.5, profileRequiresStaff: false, shelfLifeMultiplier: 2 } } }
});

export function applyEconomicTemplateCalibration(templates = []) {
  return (templates ?? []).map((template) => {
    const id = String(template?.id ?? "");
    const calibration = {
      ...(ECONOMIC_TEMPLATE_CALIBRATION_V1[id] ?? {}),
      ...(ECONOMIC_TEMPLATE_CALIBRATION_V2[id] ?? {})
    };

    const lineOverrides = calibration.productionLines ?? {};
    const productionLines = (template.productionLines ?? []).map((productionLine) => ({
      ...productionLine,
      ...(lineOverrides[String(productionLine?.id ?? "")] ?? {})
    }));
    for (const additional of calibration.additionalProductionLines ?? []) {
      if (!productionLines.some((productionLine) => productionLine.id === additional.id)) productionLines.push({ ...additional });
    }
    const agriculture = template.agriculture ? {
      ...template.agriculture,
      crops: (template.agriculture.crops ?? []).map((crop) => ({
        ...crop,
        outputQty: AGRICULTURE_CROP_OUTPUT_V1[crop.id] ?? crop.outputQty
      }))
    } : template.agriculture;

    const templateOverrides = calibration.template ?? {};
    return {
      ...template,
      ...templateOverrides,
      functions: templateOverrides.functions ? { ...(template.functions ?? {}), ...templateOverrides.functions } : template.functions,
      storage: templateOverrides.storage ? { ...(template.storage ?? {}), ...templateOverrides.storage } : template.storage,
      wageDailyCopper: calibration.wageDailyCopper ?? template.wageDailyCopper ?? 0,
      baseUpkeepMonthlyCopper: calibration.baseUpkeepMonthlyCopper ?? (id === "laputa-excavated-crypt" ? 0 : 18 * Math.max(1, Number(template.upkeep) || 0)),
      operatingUpkeepMonthlyCopper: calibration.operatingUpkeepMonthlyCopper ?? template.operatingUpkeepMonthlyCopper ?? 0,
      maintenance: {
        ...(template.maintenance ?? {}),
        requiredPoints: calibration.maintenanceRequiredPoints ?? template.maintenance?.requiredPoints ?? 1
      },
      agriculture,
      productionLines,
      income: calibration.income ? { ...(template.income ?? {}), ...calibration.income } : template.income
    };
  });
}
