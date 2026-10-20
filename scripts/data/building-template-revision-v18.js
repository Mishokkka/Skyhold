import { buildingCatalogV17Templates } from "./building-template-revision-v17.js";

// Approved production review, 11 October 2026. Applied only through catalog migration.
const ADVANCED_WAGE_IDS = new Set(["steelworks", "chemical-plant", "machine-works", "high-tech-components-plant", "military-factory"]);
const HEATED_BATCH_IDS = new Set(["bakery", "inn", "cheesery", "smokehouse", "brewery", "distillery"]);
const IMPORT_LABELS = { sugar: "сахар", spices: "специи", silk: "шёлк", "rare-earth-metals": "редкие металлы",
  "alcohol-general-cheap-weak": "покупной общий слабый алкоголь", "alcohol-general-fine-weak": "покупной дорогой общий слабый алкоголь" };
const note = (row, text) => { row.notes = [row.notes, text].filter(Boolean).join(" "); };

function recipe(line, expenses, outputQty, workQd) {
  Object.assign(line, { expenses, outputQty, workQd, expenseMode: "cycle" });
}

function heatedBatch(line) {
  const costs = String(line.expenses).split(/\s*,\s*/).filter(Boolean).map((part) => {
    const match = /^([a-z0-9-]+)\s+(\d+)$/.exec(part);
    if (!match) throw new Error(`Unsupported approved recipe: ${part}`);
    return `${match[1]} ${Number(match[2]) * 4}`;
  });
  recipe(line, [...costs, "fuel-solid 1"].join(", "), line.outputQty * 4, line.workQd * 4 - 1);
}

export function buildingCatalogV18Templates() {
  return buildingCatalogV17Templates().map((source) => {
    const row = structuredClone(source);
    row.templateVersion = 18;
    const lines = row.productionLines ?? [];
    const find = (id) => lines.find((line) => line.id === id);
    if (ADVANCED_WAGE_IDS.has(row.id)) {
      row.wageDailyCopper = 24;
      for (const line of lines) line.wageDailyCopper = 0; // Inherit the professional rate.
      note(row, "Ставка продвинутого промышленного труда: 24 ММ в день сверх пайка. Индивидуальная оплата и добровольная работа задаются отдельно.");
    }
    if (HEATED_BATCH_IDS.has(row.id)) {
      for (const line of lines) heatedBatch(line);
      note(row, "Тепловая обработка расходует твёрдое топливо на полную партию; обычная эксплуатация оплачивается отдельно один раз на здание.");
    }
    if (row.id === "apothecary") {
      delete row.special;
      delete row.medical;
      note(row, "Производство перевязочных материалов и лекарств. Лечение пациентов выполняется в Лазарете или Больнице.");
    }
    if (row.id === "mill") recipe(find("line-feed"), "grain 6", 6, 2);
    if (row.id === "bakery") row.productionLines = lines.filter((line) => line.resourceId !== "food-grain");
    if (row.id === "inn") {
      row.moraleDelta = 15;
      delete row.service;
      row.activation = { minWorkers: 2, minOperationalQd: 40, requiresMeaningfulResult: false, anyWorkingFunction: true };
      row.activationConditionText = "2 работающих сотрудника и 40 QD работы кухни, торговли или обслуживания за десятник дают поселению +15 довольства.";
      row.notes = "Работающий трактир даёт +15 довольства. Отдельная бригада досуга не нужна: учитывается работа кухни, торговли и обслуживания, без повторного счёта QD. Производственные назначения распределяются между конкретными блюдами. Топливо списывается на партию. Простая каша и мучная похлёбка готовятся здесь без пекарни.";
      const flour = find("line-4");
      recipe(flour, "flour 8, fuel-solid 1", 10, 2);
      flour.mode = "Мучная похлёбка";
      lines.push({ ...structuredClone(flour), id: "line-grain-porridge", mode: "Каша из зерна", expenses: "grain 12, fuel-solid 1" });
      const vegetables = find("line-2");
      vegetables.resourceId = "food-vegetables";
      vegetables.resource = "Готовая пища (овощная)";
      vegetables.mode = "Овощное блюдо";
      lines.push({ ...structuredClone(vegetables), id: "line-vegetables-oil", mode: "Овощи с маслом",
        expenses: "vegetables 12, cooking-oil 1, fuel-solid 1", outputQty: 14, workQd: 3 });
    }
    if (row.id === "oil-press") {
      recipe(find("line-1-cooking-oil"), "grain 6", 5, 2);
      find("line-1-cooking-oil").mode = "Масло из масличных семян";
      find("line-2-cooking-oil").mode = "Масло из масличных плодов";
      note(row, "Категории зерна и плодов здесь означают подходящие масличные семена и плоды. Обычная пшеница и яблоки не являются их буквальной заменой; состав партии определяет ГМ. Масло используется в отдельном овощном блюде трактира, остальные блюда его не требуют.");
    }
    if (row.id === "smokehouse") for (const line of lines) {
      if (line.resourceId === "preserved-meat") line.mode = line.mode.replace("Консервы", "Белковые заготовки");
    }
    if (row.id === "cannery") for (const line of lines) {
      line.expenses += ", fuel-solid 1";
      if (line.resourceId === "canned-protein") line.outputQty = 20;
      if (line.resourceId === "canned-vegetables") line.expenses = "vegetables 24, salt 4, iron 1, fuel-solid 1";
    }
    if (row.id === "forge") {
      recipe(find("line"), "iron-ore 4, fuel-solid 1", 4, 3);
      find("line-2-armament-simple").expenses += ", fuel-solid 2";
      find("line-3-military-supplies-simple").expenses += ", fuel-solid 1";
    }
    if (row.id === "greenhouse-complex") {
      row.activationConditionText = "Минимум 2 работника. Дорогая зимняя страховка: овощи, фрукты и обычные лекарственные травы круглый год.";
      row.description = "Тепличный комплекс обеспечивает зимние поставки обычных культур. Отдельных уникальных растений не производит; себестоимость выше сезонного хозяйства.";
      note(row, "Особенность трав — доступность зимой, а не отдельный редкий вид. Прибыль от обычных культур не является основной задачей теплицы.");
    }
    if (row.id === "pigsty") {
      row.livestock.profile = { ...row.livestock.profile, headsPerFeedUnit: 2, maturityQd: 720 };
      note(row, "Молодняк созревает за 180 дней. Одна кормовая единица обеспечивает две головы за десятник; уход, забой и свободные места для приплода учитываются отдельно. Для воспроизводства оставляют племенное ядро и места для молодняка.");
    }
    if (row.id === "sheepfold") {
      row.livestock.profile = { ...row.livestock.profile, capacity: 24, headsPerFeedUnit: 2, woolPerHead: 6, maturityQd: 720 };
      row.livestock.state = { ...row.livestock.state, capacity: 24 };
      note(row, "Вместимость — 24 головы вместе с молодняком; 180 дней до взрослого поголовья. Стрижка даёт 6 ЕД. шерсти с головы. Одна кормовая единица обеспечивает две головы за десятник без выпаса. Хозяйство рассчитано на шерсть и приплод, а не только на шерсть.");
    }
    if (row.id === "steelworks") {
      recipe(find("line-1-steel"), "iron 4, fuel-solid 1", 4, 2);
      find("line-2-light-alloys").workQd = 3;
      recipe(find("line-3-complex-alloys"), "steel 2, nonferrous-metals 1, light-alloys 1, chemicals-simple 1, fuel-solid 2", 2, 6);
    }
    if (row.id === "chemical-plant") {
      recipe(find("line-1-chemicals-simple"), "tallow 3, salt 4, fuel-solid 1", 2, 2);
      recipe(find("line-2-chemicals-complex"), "chemicals-simple 3, salt 4, fuel-solid 2", 2, 6);
      recipe(find("line-3-explosives"), "chemicals-complex 1, fuel-solid 1, salt 2", 2, 2);
      recipe(find("line-4-fuel-liquid"), "tallow 4, chemicals-simple 1, fuel-solid 1", 5, 2);
      note(row, "Простая химия — подготовленный промышленный ассортимент солей, щелочных, связующих и органических составов под заказ. Жир является органической частью смеси, а не универсальной заменой всех реактивов. Местные минеральные добавки и вода входят в условия площадки и труд. Жидкое топливо из жира — ламповый состав, не нефтепереработка.");
    }
    if (row.id === "machine-works") {
      recipe(find("line-1-components-complex"), "iron 1, steel 1, copper 1, components-simple 2", 2, 4);
      recipe(find("line-2-tools-complex"), "steel 4, copper 2, components-complex 3", 2, 8);
    }
    if (row.id === "high-tech-components-plant") recipe(find("line-1-components-high-tech"), "components-complex 2, copper 2, complex-alloys 1, rare-earth-metals 1, glass 1", 4, 10);
    if (row.id === "military-factory") {
      find("line-1-military-supplies-complex").workQd = 3;
      note(row, "Стратегическое самообеспечение гарнизона. Узкая денежная маржа не означает отсутствия военной пользы; экспорт требует подходящего покупателя и цены.");
    }
    if (row.id === "soapworks") {
      const soap = find("line-1-chemicals-simple");
      Object.assign(soap, { resourceId: "household-goods-simple", resource: "Бытовые изделия (простые)", mode: "Мыло и средства ухода" });
      recipe(soap, "tallow 8, chemicals-simple 1, fuel-solid 1", 1, 2);
      find("line-2-household-goods-simple").expenses += ", fuel-solid 1";
      find("line-2-household-goods-simple").mode = "Свечи и бытовые восковые составы";
      note(row, "Мыловарня выпускает бытовые изделия, а не взаимозаменяемые промышленные реактивы. Простая химия во входе означает подходящий щелочной/технологический состав.");
    }
    if (["brickworks", "glassworks"].includes(row.id)) {
      const site = row.id === "brickworks" ? "Доступный участок подходящей глины и воды" : "Доступный источник стекольного песка и минеральных добавок";
      row.siteRequirementsText = [row.siteRequirementsText, site].filter(Boolean).join(". ");
      row.specialRequirements = [row.specialRequirements, site].filter(Boolean).join(". ");
      note(row, "Доступность местного минерального сырья подтверждает ГМ при выборе участка. Его добыча включена в труд рецепта; отдельная складская строка не требуется.");
    }
    if (row.id === "weaving-workshop") note(row, "Волокно и шерсть дают одну укрупнённую ткань. Шерстяная линия полезна при собственном овцеводстве или доступной шерсти; равная прибыль двух линий не обещается.");
    if (row.id === "writing-workshop" || row.id === "printing-house") note(row, "Письменные материалы включают бумагу, чернила и подготовленные листы. Растительное волокно идёт на бумажную основу, а не на животный пергамент.");
    const imported = new Set(lines.flatMap((line) => (line.expenses ?? "").split(/\s*,\s*/).map((cost) => cost.split(" ")[0]))
      .filter((id) => ["sugar", "spices", "silk", "rare-earth-metals", "alcohol-general-cheap-weak", "alcohol-general-fine-weak"].includes(id)));
    if (imported.size) note(row, `Внешнее или сюжетное сырьё: ${[...imported].map((id) => IMPORT_LABELS[id]).join(", ")}. Стандартное дерево поселения не производит эти входы.`);
    return row;
  });
}
