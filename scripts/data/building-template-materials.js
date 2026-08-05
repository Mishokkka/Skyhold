const MATERIAL_LABELS = Object.freeze({
  wood: "Wood",
  stone: "Stone",
  iron: "Iron",
  glass: "Glass",
  "cloth-wool": "Cloth, Wool",
  straw: "Straw",
  herbs: "Herbs",
  parchment: "Parchment",
  gold: "Gold"
});

const LEGACY_RESOURCE_ALIASES = Object.freeze({
  wood: "wood",
  "дерево": "wood",
  "древесина": "wood",
  stone: "stone",
  "камень": "stone",
  iron: "iron",
  "железо": "iron",
  glass: "glass",
  "стекло": "glass",
  "cloth, wool": "cloth-wool",
  "шерстяная ткань": "cloth-wool",
  straw: "straw",
  "солома": "straw",
  herbs: "herbs",
  "травы": "herbs",
  parchment: "parchment",
  "пергамент": "parchment",
  gold: "gold",
  "золото": "gold"
});

function material(resourceId, qty) {
  return Object.freeze({
    id: `mat-${resourceId}`,
    name: MATERIAL_LABELS[resourceId] ?? resourceId,
    resourceId,
    qty
  });
}

function calibration(scale, rationale, rows = []) {
  return Object.freeze({
    scale,
    rationale,
    materialCosts: Object.freeze(rows.map(([resourceId, qty]) => material(resourceId, qty)))
  });
}

/**
 * Legacy campaign calibration retained only to fingerprint worlds created while
 * the manager replaced the source Forbidden Lands recipes with physical-scale
 * estimates. These figures are campaign-specific estimates, not canonical
 * Forbidden Lands material costs and not defaults for new buildings.
 */
export const LEGACY_CAMPAIGN_BUILDING_MATERIAL_CALIBRATION = Object.freeze({
  well: calibration("small", "Кладка шахты, оголовок, ворот и крепёж.", [["stone", 80], ["wood", 10], ["iron", 2]]),
  "grain-field": calibration("bootstrap", "Межевые колья, простая ограда и водоотвод; земляные работы оплачиваются трудом.", [["wood", 12], ["iron", 1]]),
  garden: calibration("bootstrap", "Грядки, ограда и малые каменные борта.", [["wood", 10], ["stone", 4]]),
  pasture: calibration("small", "Протяжённая деревянная изгородь и ворота.", [["wood", 80]]),
  pigsty: calibration("small", "Закрытый хлев с моющимся каменным низом.", [["wood", 100], ["stone", 10], ["iron", 2]]),
  sheepfold: calibration("small", "Ограда, навес и сухое основание.", [["wood", 80], ["stone", 8]]),
  "goat-pen": calibration("small", "Ограда, навес и каменное сухое основание для небольшого молочного стада.", [["wood", 70], ["stone", 8]]),
  "poultry-yard": calibration("small", "Закрытый птичник, гнёзда, выгул и сухая подстилка.", [["wood", 55], ["stone", 5], ["straw", 12]]),
  rabbitry: calibration("small", "Деревянные клети, сетчатый крепёж и сухая подстилка.", [["wood", 45], ["iron", 2], ["straw", 10]]),
  mill: calibration("large", "Тяжёлый деревянный корпус, фундамент, жернова и металлический привод.", [["wood", 600], ["stone", 240], ["iron", 20]]),
  bakery: calibration("medium", "Каменная печь и дымоход, рабочий корпус и железная фурнитура.", [["stone", 180], ["wood", 80], ["iron", 10]]),
  inn: calibration("large", "Постоялый дом с кухней, фундаментом, окнами и спальными местами.", [["wood", 450], ["stone", 120], ["iron", 10], ["glass", 6], ["cloth-wool", 12]]),
  "root-cellar": calibration("medium", "Каменная подземная камера, перекрытия и дверь.", [["stone", 180], ["wood", 50], ["iron", 4]]),

  lumbermill: calibration("bootstrap", "Навес, козлы, направляющие и несъёмные железные детали; лес заготавливается на месте.", [["wood", 20], ["iron", 4]]),
  quarry: calibration("bootstrap", "Подмости, рычаги и несъёмные железные детали; выемка породы оплачивается трудом.", [["wood", 20], ["iron", 4]]),
  mine: calibration("large", "Крепь шахты, настилы, лестницы и металлические соединения.", [["wood", 300], ["iron", 20]]),
  forge: calibration("large", "Массивная кладка горна, рабочий корпус и стационарная металлическая оснастка.", [["stone", 300], ["wood", 80], ["iron", 30]]),
  tannery: calibration("medium", "Навесы, чаны, каменный сток и крепёж.", [["wood", 150], ["stone", 30], ["iron", 6]]),
  "tailor-shop": calibration("medium", "Мастерская, неподвижные станки и первичное оснащение тканью.", [["wood", 120], ["stone", 20], ["cloth-wool", 20]]),
  vault: calibration("large", "Тяжёлая кладка, внутренний деревянный корпус и решётки с замками.", [["stone", 300], ["wood", 100], ["iron", 80]]),
  stables: calibration("large", "Стойла, перекрытия, твёрдый пол, ворота и крепёж.", [["wood", 500], ["stone", 80], ["iron", 20]]),
  "construction-center": calibration("large", "Просторный двор, мастерские, склады оснастки и подъёмные приспособления.", [["wood", 350], ["stone", 100], ["iron", 20]]),
  "personnel-office": calibration("medium", "Административный дом с фундаментом, окнами и архивной мебелью.", [["wood", 180], ["stone", 50], ["glass", 4]]),
  "hiring-agency": calibration("medium", "Небольшая контора с приёмной и защищённым архивом.", [["wood", 120], ["stone", 30], ["glass", 2]]),
  pier: calibration("large", "Силовой деревянный настил, опоры, причальные тумбы и железные связи.", [["wood", 600], ["stone", 100], ["iron", 40]]),
  lighthouse: calibration("monumental", "Высокая каменная башня, лестницы, фонарная камера и остекление.", [["stone", 1200], ["wood", 200], ["iron", 40], ["glass", 10]]),
  dovecote: calibration("small", "Приподнятый деревянный домик на каменном основании.", [["wood", 60], ["stone", 10]]),

  "tent-camp": calibration("small", "Тридцать мест требуют стоек, настилов и значительного запаса палаточного полотна.", [["wood", 60], ["cloth-wool", 100]]),
  cemetery: calibration("small", "Ограда, ворота и каменные надгробные знаки; могилы создаются трудом.", [["stone", 60], ["wood", 10]]),
  market: calibration("medium", "Крытые торговые ряды, прилавки, настилы и запираемые секции.", [["wood", 250], ["stone", 40], ["iron", 10], ["cloth-wool", 20]]),
  bathhouse: calibration("large", "Влагостойкая кладка, деревянные помещения, котлы и окна.", [["stone", 200], ["wood", 180], ["iron", 20], ["glass", 4]]),
  library: calibration("large", "Сухой корпус, стеллажи, окна и исходное справочное собрание.", [["wood", 240], ["stone", 100], ["glass", 6], ["parchment", 30]]),
  scriptorium: calibration("large", "Защищённые мастерские, архив, остекление и запас дорогих письменных материалов.", [["wood", 300], ["stone", 160], ["glass", 10], ["parchment", 80], ["gold", 2]]),
  shrine: calibration("medium", "Ритуальный зал, каменное основание, световые проёмы и фурнитура.", [["wood", 120], ["stone", 80], ["iron", 4], ["glass", 2]]),
  "hall-of-fame": calibration("monumental", "Большой каменный мемориал с перекрытиями, витринами и умеренной позолотой.", [["stone", 800], ["wood", 300], ["iron", 30], ["glass", 12], ["gold", 20]]),
  spire: calibration("monumental", "Особо высокая каменная конструкция с силовым каркасом, окнами и символической отделкой.", [["stone", 1400], ["wood", 250], ["iron", 60], ["glass", 20], ["gold", 30]]),

  "shooting-range": calibration("bootstrap", "Мишени, навес и безопасные деревянные улавливатели.", [["wood", 40], ["cloth-wool", 5]]),
  "training-camp": calibration("small", "Навесы, ограждения, учебные снаряды и крепёж.", [["wood", 100], ["cloth-wool", 15], ["iron", 3]]),
  ramparts: calibration("monumental", "Главная долговременная линия обороны с массивной кладкой и деревянными боевыми площадками.", [["stone", 2500], ["wood", 800], ["iron", 60]]),
  moat: calibration("large", "Земляная выемка создаётся трудом; материалы идут на откосы, настилы и водопропуск.", [["wood", 120], ["stone", 100]]),
  portcullis: calibration("large", "Тяжёлая железная решётка, направляющие, ворот и каменная рама.", [["iron", 120], ["wood", 80], ["stone", 60]]),
  "guard-tower": calibration("large", "Высокая деревянная башня на каменном основании с железными связями.", [["wood", 400], ["stone", 120], ["iron", 20]]),
  dungeon: calibration("large", "Каменные камеры, тяжёлые двери, решётки и малый объём перекрытий.", [["stone", 400], ["iron", 60], ["wood", 30]]),
  gallows: calibration("small", "Помост, стойки и железный крепёж.", [["wood", 60], ["iron", 2]]),
  bunkhouse: calibration("large", "Плотный жилой корпус на шестнадцать мест с общими постелями.", [["wood", 300], ["stone", 50], ["cloth-wool", 40]]),
  "common-house": calibration("large", "Постоянный дом для нескольких семей с фундаментом и окнами.", [["wood", 400], ["stone", 100], ["glass", 4]]),
  "boarding-house": calibration("large", "Крупный гостевой дом с отдельными спальными местами и остеклением.", [["wood", 600], ["stone", 140], ["cloth-wool", 60], ["glass", 8]]),
  barn: calibration("large", "Высокий сухой деревянный корпус, каменное основание и кровельная солома.", [["wood", 350], ["stone", 40], ["straw", 100]]),
  warehouse: calibration("large", "Универсальный силовой корпус с каменным основанием и запираемыми воротами.", [["wood", 600], ["stone", 160], ["iron", 20]]),
  "guarded-storehouse": calibration("monumental", "Усиленный склад с тяжёлой кладкой, караульной частью, решётками и замками.", [["wood", 550], ["stone", 260], ["iron", 80]]),
  barracks: calibration("large", "Прочный жилой корпус на двадцать солдат с общими постелями и оружейными стойками.", [["wood", 500], ["stone", 120], ["cloth-wool", 40], ["iron", 15]]),
  arsenal: calibration("large", "Огнестойкий склад с тяжёлыми дверями, стойками и большим объёмом металлической оснастки.", [["wood", 300], ["stone", 180], ["iron", 100]]),
  lazaret: calibration("large", "Проветриваемый лечебный корпус с моющимися поверхностями, койками и первичным запасом перевязочных средств.", [["wood", 250], ["stone", 80], ["cloth-wool", 80], ["herbs", 20], ["glass", 8]]),
  apothecary: calibration("medium", "Мастерская с сухим хранилищем, стеклянной тарой, крепежом и исходным запасом трав.", [["wood", 180], ["stone", 60], ["glass", 30], ["iron", 4], ["herbs", 40]]),
  "watch-post": calibration("small", "Малая закрытая караулка с каменным основанием.", [["wood", 80], ["stone", 20], ["iron", 3]]),
  "barricade-line": calibration("large", "Протяжённая съёмная линия тяжёлых деревянных препятствий и связей.", [["wood", 300], ["stone", 80], ["iron", 20]]),
  gatehouse: calibration("monumental", "Укреплённая каменная башня ворот, караулка и тяжёлый запирающий механизм.", [["stone", 700], ["wood", 350], ["iron", 100]]),
  "signal-tower": calibration("large", "Высокая башня, внутренние перекрытия, колокол, фонари и малое остекление.", [["stone", 300], ["wood", 300], ["iron", 30], ["glass", 4]]),
  "powder-magazine": calibration("large", "Толстая огнестойкая кладка, лёгкая внутренняя отделка и тяжёлая фурнитура.", [["stone", 400], ["wood", 120], ["iron", 40]]),
  "field-fort": calibration("monumental", "Земляной редут с частоколом, облицованными позициями и крепежом.", [["wood", 400], ["stone", 250], ["iron", 20]]),
  "artillery-platform": calibration("monumental", "Усиленное основание и силовой настил под тяжёлое орудие.", [["wood", 500], ["stone", 300], ["iron", 120]]),
  school: calibration("large", "Учебный корпус, мебель, окна и исходный набор учебных материалов.", [["wood", 350], ["stone", 100], ["glass", 10], ["parchment", 30]]),
  "fasti-shop": calibration("external", "Лавка открывается после отдельного денежного вклада; повторный материальный платёж не взимается.", [])
});

/**
 * @deprecated Compatibility export. This is a legacy campaign fingerprint, not
 * a canonical material catalog and must not be used for new defaults.
 */
export const BUILDING_MATERIAL_CALIBRATION = LEGACY_CAMPAIGN_BUILDING_MATERIAL_CALIBRATION;

export function legacyCampaignMaterialCosts(templateId) {
  const rows = LEGACY_CAMPAIGN_BUILDING_MATERIAL_CALIBRATION[String(templateId)]?.materialCosts ?? null;
  return rows ? rows.map((row) => ({ ...row })) : null;
}

/** @deprecated Use only when identifying the legacy campaign calibration. */
export const calibratedMaterialCosts = legacyCampaignMaterialCosts;

function normalizedResourceId(row = {}) {
  const explicit = String(row.resourceId ?? row.resource ?? row.resourceKey ?? "").trim().toLowerCase();
  if (explicit) return LEGACY_RESOURCE_ALIASES[explicit] ?? explicit;
  const name = String(row.name ?? row.material ?? row.label ?? "").trim().toLowerCase();
  return LEGACY_RESOURCE_ALIASES[name] ?? name;
}

/**
 * Adds stable resource ids to source rows without changing their quantities.
 * Some older catalog rows predate resourceId and identify the same material by
 * its localized name.
 */
export function canonicalMaterialCostRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row, index) => {
    const resourceId = normalizedResourceId(row);
    const qty = Number(row?.qty ?? row?.quantity ?? row?.count ?? 0);
    return {
      ...row,
      id: resourceId ? `mat-${resourceId}` : String(row?.id ?? `material-${index + 1}`),
      name: String(row?.name ?? row?.material ?? row?.label ?? MATERIAL_LABELS[resourceId] ?? resourceId),
      resourceId,
      qty
    };
  });
}

export function materialCostFingerprint(rows = []) {
  const totals = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const resourceId = normalizedResourceId(row);
    const qty = Number(row?.qty ?? row?.quantity ?? row?.count ?? 0) || 0;
    if (!resourceId || qty <= 0) continue;
    totals.set(resourceId, (totals.get(resourceId) ?? 0) + qty);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([resourceId, qty]) => `${resourceId}:${qty}`)
    .join("|");
}

export function materialCostsMatch(left = [], right = []) {
  return materialCostFingerprint(left) === materialCostFingerprint(right);
}
