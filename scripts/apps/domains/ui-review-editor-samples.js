// Fixed examples, independent of SkyholdData and world settings.
import { workerProfileEditorContext } from "../editors/worker-profile-editor.js";
import { prepareTradePickers, projectParticipantPicker, tradeCategoryOptions } from "./building-editor-pickers.js";
import { BUILDING_EDITOR_TABS } from "./building-editor-tabs.js";

const options = (labels, selected = 0) => labels.map((label, index) => ({ value: String(index), id: String(index), name: label, label, selected: index === selected }));
const seasons = () => ["Весна", "Лето", "Осень", "Зима"].map((label, index) => ({ label, short: label.slice(0, 3), selected: index < 3, seasonId: String(index), path: `demo.seasons.${index}` }));
const rooms = () => options(["Под открытым небом", "Склад у северных ворот"], 1);
const withPaths = (values, prefix) => ({ ...values, ...Object.fromEntries(Object.keys(values).map(key => [`${key}Path`, `${prefix}.${key}`])) });

function productionLine(source, index) {
  const workers = source === "workers";
  return {
    ...withPaths({ source, mode: ["Помол зерна", "Сезонная заготовка", "Молоко"][index], active: index !== 1, period: "tenday", outputQty: 8,
      workQd: 2, pendingQty: workers ? 0 : 6, resource: workers ? "Мука" : "Молоко", contentId: "cows", storageRoomId: "warehouse",
      formula: "", overtime: false, wageDailyCopper: 2, requiresCollection: !workers, collectQd: 1,
      autoCollect: "worker", expenses: "Зерно 4", expenseMode: "cycle", operatingUpkeepMonthlyCopper: 12 }, `demo.production.${index}`),
    _index: index, isWorkers: workers, isContent: source === "content", sourceLabel: workers ? "Рабочие" : source === "content" ? "Содержимое" : "Время",
    sourceOptions: options(["Рабочие", "Время", "Содержимое"], index), periodOptions: options(["За десятник", "За день"]),
    contentOptions: options(["Коровы"]), contentName: "Коровы", periodLabel: "За десятник", resourceIcon: "fa-solid fa-wheat-awn",
    periodCycleLabel: workers ? "QD / цикл" : "Циклов", periodCycleTooltip: workers ? "Рабочие QD на один цикл" : "Число циклов за период",
    storageRoomOptions: rooms(), storageRoomLabel: "Склад у северных ворот", seasonOptions: seasons().map(season => ({ ...season, path: `demo.production.${index}.seasons.${season.seasonId}` })), autoCollectOptions: options(["Работник здания", "Без автосбора"]),
    autoCollectLabel: "Работник здания", expenseModeOptions: options(["За цикл", "За единицу выхода"]), expenseModeLabel: "За цикл",
    requiresGmConfirmation: source === "time", canCancelBatch: workers, cycleText: workers ? "Цикл: 2 QD → 8 муки" : "Готово к сбору: 6 ед."
  };
}

export function createEditorReviewContext(tab, { permission = "gm", kind = "building", flock = "sheep" } = {}) {
  const canEdit = permission !== "view";
  const building = {
    id: "demo-building", basePath: "demo.building", name: "Мельница у северных ворот", categoryLabel: "Производство", lifecycleLabel: "Постоянное",
    conditionLabel: "Исправно", isTemplate: kind === "template", primaryDev: "technology", primaryDevLabel: "Технология", playerVisible: true,
    visibilityText: "Видно", categoryOptions: options(["Производство", "Услуги"]), lifecycleOptions: options(["Постоянное", "Временное"]),
    conditionOptions: options(["Исправно", "Повреждено"]), wageDailyCopper: 2, baseUpkeepMonthlyCopper: 30, operatingUpkeepMonthlyCopper: 12,
    maintenance: withPaths({ technical: true, requiredPoints: 2, priority: 10, backlogTendays: 1, efficiencyPercent: 100, needsResolution: false }, "demo.maintenance"),
    showFunctionToggles: true, functionOptions: BUILDING_EDITOR_TABS.slice(4).map(({ id, label, icon }) => ({ path: `demo.functions.${id}`, label, icon, checked: true, tooltip: `Функция: ${label}` })),
    effect: "Поддерживает выпуск муки для поселения.", notes: "У северных ворот; доступ со двора.", workersMin: 1, workersMax: 4, workerMoraleDelta: 0,
    workerRole: "Мельники", workerRoleLine: "Мельники", workerEfficiency: { total: 2, productionEquivalentText: "2", detail: "Два назначенных работника" },
    assignedCount: 2, hasPlannedWorkers: true, plannedWorkerRows: [{ name: "Руна", qdLine: "12 QD", functionCount: 1 }],
    workerSlots: [1, 2, 3, 4].map(slotNo => ({ slotNo, path: `demo.workers.${slotNo}`, options: options(["—", "Руна", "Хальвард"], slotNo < 3 ? slotNo : 0), label: slotNo < 3 ? "Руна" : "—" })),
    workerProfile: { source: "custom", admission: { hard: true, clauses: [[{ attribute: "strength", minimum: 3 }, { attribute: "wits", minimum: 2 }]] },
      composition: [{ count: 1, backgrounds: ["Фермер", "Каменщик"] }], modifiers: { types: [{ match: "СИЛ", percent: 20 }], backgrounds: [{ match: "Фермер", percent: 10 }], traits: [{ match: "Трудолюбивый", percent: 10 }] } },
    buildTarget: 6, buildProgress: 2, buildDifficulty: 1, canRollConstruction: canEdit && kind !== "template",
    developmentParts: ["Пища", "Технология", "Культура", "Война"].map((label, index) => ({ label, css: ["food", "technology", "culture", "war"][index],
      icon: ["fa-solid fa-utensils", "fa-solid fa-wrench", "fa-solid fa-music", "fa-solid fa-shield-halved"][index], value: 999, path: `demo.development.${index}` })),
    materialCosts: ["Древесина", "Камень"].map((name, index) => ({ name, qty: 12, _index: index, qtyPath: `demo.materials.${index}.qty` })),
    requiredBuildings: [{ label: "Мастерская", met: true, editable: true, _index: 0, path: "demo.required.0", options: options(["Мастерская", "Кузница"]) }],
    requiredAnyBuildings: [{ label: "Склад", met: false, _index: 0, path: "demo.any.0", options: options(["Склад", "Амбар"]) }],
    sourceRawMaterials: "Древесина 12, Камень 12", sourceRequirement: "Технология 5", specialRequirements: "Требуется доступ к воде.",
    rulesView: { siteRequirementsText: "У реки или ручья.", activationConditionText: "Построено и обеспечено обслуживанием.",
      activation: { minWorkers: 1, minOperationalQd: 4, requiresMeaningfulResult: true }, repeatSettlementEffects: false,
      service: { capacityBase: 10, capacity: 0, capacityPerWorker: 2, capacityPerWorkerStep: 4, workerStep: 2, maximumCapacity: 30,
        coverageKindOptions: options(["Жители", "Выбранные здания"]), coverageKind: "population", coveredBuildingIdsText: "mill, workshop" },
      control: { generalPerWorker: 1, generalFlat: 2, unrestOnlyPerWorker: 1, unrestOnlyFlat: 0, maximum: 8, capacity: 20, ceilingValue: -1 },
      leisure: { kind: "Питейный досуг", capacity: 6, minWorkers: 1, qdPerCapacity: 2, functionIdOptions: options(["Культура и услуги", "Доход"]) }, upgradesFromTemplateIdsText: "small-mill" },
    serviceProjectRows: [{ title: "Исследование старой мельницы", kind: "Исследование", status: "planned", progressQd: 4, targetQd: 12,
      gmDecisionStatus: "none", projectIndex: 0, statusOptions: options(["План", "В работе", "Готово"]), decisionOptions: options(["Не решено", "Одобрено"]),
      participantIdsText: "runa, halvard", targetIdsText: "old-mill", notes: "Выяснить происхождение механизма.",
      resourceCosts: [{ label: "Бумага", icon: "fa-solid fa-scroll", projectIndex: 0, costIndex: 0, qty: 2, qtyPath: "demo.projects.0.costs.0.qty" }] }],
    contents: [{ name: "Коровы", qty: 3, capacity: 6, _index: 0, namePath: "demo.contents.0.name", qtyPath: "demo.contents.0.qty", capacityPath: "demo.contents.0.capacity", line: "3 / 6" }],
    productionSelection: withPaths({ exclusive: false, gmConfirmed: true }, "demo.selection"), productionLines: ["workers", "time", "content"].map(productionLine),
    hasPendingProduction: true, pendingProductionRows: [{ resource: "Молоко", qty: 6, lineIndex: 2 }],
    defense: { base: 2, perStep: 1, workerStep: 2 }, defenseSummary: { total: 3, detail: "База 2, вклад работников 1" }, defenseCombatTagLabel: "Гарнизон",
    housing: { ...withPaths({ capacity: 4, comfort: 2, quality: 3, notes: "Тёплая общая комната." }, "demo.housing"), usedText: "2", capacityText: "4", freeText: "2", occupants: "Руна, Хальвард",
      slotRows: [1, 2, 3, 4].map(slotNo => ({ slotNo, slot: slotNo - 1, options: options(["—", "Руна", "Хальвард"], slotNo < 3 ? slotNo : 0) })) },
    storage: { ...withPaths({ capacity: 100, security: 2, quality: 3, shelfLifeMultiplier: 1.5, profileLabel: "Зерно", profileCapacityMultiplier: 0.5,
      profileResourceIds: "grain, flour", profileCategoryTags: "food.raw", profileMarketTags: "grain", profilePerishableFood: false, profileRequiresStaff: true }, "demo.storage"),
      profileResourceIdsText: "grain, flour", profileCategoryTagsText: "food.raw", profileMarketTagsText: "grain", usedText: "68 кг", capacityText: "100 кг", freeText: "32 кг" },
    fuel: { enabled: true, choicePath: "demo.fuel.choice", options: options(["Древесина 2", "Уголь 1"]) },
    cultureReligion: withPaths({ religious: true, faith: "custom", faithLabel: "Свой культ", showCustomFaith: true, customFaith: "Хранители реки", notes: "Праздники и обряды поселения." }, "demo.religion")
  };
  building.cultureReligion.faithOptions = options(["Свой культ", "Ржавый брат"]);
  building.workerProfileEditor = workerProfileEditorContext(building);
  building.income = { base: 12, perWorker: 2, formula: "1d6 + @workers", risk: 1, wageDailyCopper: 2, operatingUpkeepMonthlyCopper: 12, illegal: false,
    trade: { enabled: true, roomOptions: rooms(), roomId: "warehouse", kindOptions: options(["Ресурсы", "Предметы", "Всё"]), kind: "resources", throughputUnitsPerWorker: 8,
      gmPriority: 5, demandBudgetBaseCopper: 20, demandBudgetPerWorkerCopper: 4, priceEfficiencyTitle: "Справочная эффективность цены", priceEfficiencyText: "×1,10",
      sourceIdsText: "population, market-flow", allowedTagsText: "food.raw, food.ready", service: { enabled: true, basePriceCopper: 3, unitsPerWorker: 4, categoryTag: "inn" }, notes: "Продажи из выбранного склада." } };
  building.incomeSummary = { total: 16 };
  const crop = withPaths({ label: "Рожь", resourceId: "grain", outputQty: 24, sowingWorkQd: 4, growingQd: 40, harvestWorkQd: 8, expiryRule: "qd", readyExpiryQd: 12 }, "demo.crops.0");
  building.agricultureView = { ...withPaths({ enabled: true, activeCropId: "rye", outputRoomId: "warehouse", gmPriority: 5, sow: true, harvest: true,
    phase: "ready", sowingProgressQd: 4, growingElapsedQd: 40, readyAgeQd: 2, harvestProgressQd: 2, harvestWorkQdTotal: 8,
    harvestTotalQty: 24, harvestedQty: 6, sowingSeasonKey: "spring", readySeasonKey: "summer", lastSownSeasonKey: "spring" }, "demo.agriculture"),
    kindLabel: "Поле", phaseLabel: "Готово", statusText: "Урожай готов к постепенному сбору", hasActiveCrop: true, activeCrop: { label: "Рожь" }, isReady: true,
    activeCropOptions: options(["Рожь", "Ячмень"]), outputRoomOptions: rooms(), phaseOptions: options(["Готово", "Рост", "Посев"]),
    cropRows: [{ ...crop, index: 0, active: true, expiryLabel: "Через 12 QD", expiryOptions: options(["Через QD", "В конце сезона"]), usesQdExpiry: true, seasonOptions: seasons() }],
    state: { sowingProgressQd: 4, growingElapsedQd: 40, readyAgeQd: 2, harvestProgressQd: 2, harvestWorkQdTotal: 8, harvestTotalQty: 24,
      harvestedQty: 6, readyQty: 18, sowingSeasonKey: "spring", readySeasonKey: "summer", lastSownSeasonKey: "spring" } };
  building.livestockView = { ...withPaths({ enabled: true, speciesId: "sheep", adults: 8, breedingMales: 2, feedPriority: "adults", gmPriority: 5, outputRoomId: "warehouse",
    eggs: true, milk: true, shearQty: 6, slaughterQty: 1, slaughterBreedingMales: 0 }, "demo.livestock"),
    speciesLabel: "Овцы", capacity: 20, free: 9, headcount: 11, marketPriceLabel: "12 ММ", maturityDays: 30, maturityQd: 120,
    breedingSeasonLabel: "Весна", shearingSeasonLabel: "Лето", feedRuleText: "Корм требуется каждый день; при нехватке действует выбранный приоритет.",
    canSelectSpecies: true, speciesOptions: options(["Овцы", "Козы"]), adultsMaximum: 20, youngTotal: 3, woolReady: 6, feedPriorityAdults: true,
    outputRoomOptions: rooms(), hasYoung: true, canAddYoung: true, youngRows: [1, 2].map(number => ({ id: `cohort-${number}`, number, qty: number,
      ageDays: number * 3, ageQd: number * 12, bornSeasonKey: "spring", qtyPath: `demo.young.${number}.qty`, ageQdPath: `demo.young.${number}.ageQd` })),
    producesWool: true, producesMilk: true, producesEggs: false, careWorkQdPerDay: 1, milkPerHeadDay: 1, woolPerHead: 2,
    meatPerAdult: 3, tallowPerAdult: 1, slaughterWorkQdPerHead: 1 };
  building.livestockView.speciesLabel = { sheep: "Овцы", cows: "Коровы", hens: "Куры" }[flock] ?? "Овцы";
  building.livestockView.speciesOptions = options(["Овцы", "Коровы", "Куры"], ["sheep", "cows", "hens"].indexOf(flock));
  building.livestockView.producesEggs = flock === "hens";
  building.livestockView.producesMilk = flock !== "hens";
  building.livestockView.producesWool = flock === "sheep";
  building.livestockView.eggPerFullFlockDay = 8;
  for (const project of building.serviceProjectRows) project.participantPicker = projectParticipantPicker({ participantIds: ["runa", "halvard"] },
    { people: { list: [{ id: "runa", name: "Руна" }, { id: "halvard", name: "Хальвард" }, { id: "astrid", name: "Астрид" }] } }, `demo.serviceProjects.${project.projectIndex}.participantIds`);
  prepareTradePickers(building, tradeCategoryOptions([{ categoryTag: "food.raw", marketTags: ["food.prepared"] }], [], ["inn"]));
  building.editorTabs = BUILDING_EDITOR_TABS.map(item => ({ ...item, active: item.id === (tab === "navigation" ? "production" : tab) }));
  building[`showEditor${tab[0].toUpperCase()}${tab.slice(1)}`] = true;
  return { building, canEdit, isGM: permission === "gm", combatTagOptions: options(["Гарнизон", "Ополчение"]) };
}

// Change hook names in the rendered, escaped production HTML, not in source templates.
export function inertEditorReviewHtml(html) {
  return String(html).replace(/\sdata-(?!fbls-tooltip(?:-delay)?\b)([\w-]+)(?=[\s=>])/g, " data-review-source-$1")
    .replace(/\sdraggable=/g, " data-review-source-draggable=");
}

export function renderEditorReviewSample(tab, view = {}, handlebars = globalThis.Handlebars) {
  const context = createEditorReviewContext(tab, view);
  const parts = tab === "navigation" ? ["tabs"] : tab === "main" ? ["main", "rules"] : [tab];
  return inertEditorReviewHtml(parts.map(part => {
    const path = `modules/fbl-skyhold/templates/parts/building-editor/${part}.hbs`;
    const partial = handlebars?.partials?.[path];
    if (!partial) throw new Error(`FBL Skyhold | Building review partial unavailable: ${path}`);
    return (typeof partial === "function" ? partial : handlebars.compile(partial))(context);
  }).join("\n"));
}
