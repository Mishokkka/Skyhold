// Fixed examples for the GM review; no world data, calculations or mutations.
const base = {
  unlocked: true, hasDisplayMetrics: true, name: "Мельница у северных ворот", icon: "fa-solid fa-industry",
  categoryIcon: "fa-solid fa-industry", categoryLabel: "Производство", statusClass: "built",
  statusIcon: "fa-solid fa-check", statusLabel: "Построено", hasTitleTooltip: true,
  titleTooltip: "Мельница у северных ворот", hasUpkeep: true, upkeepLine: "12 ММ",
  hasWorkerCapacity: true, workerCountLine: "2/4", hasCardStatParts: true,
  cardStatParts: [{ css: "food", icon: "fa-solid fa-wheat-awn", tone: "positive", signed: "+2", label: "Пища +2" }]
};
const recipe = (id, resource, outputText, expenseItems) => ({ id, resource, outputText,
  resourceIcon: "fa-solid fa-wheat-awn", mode: "Ручное", cycleText: "За декаду",
  hasExpenses: true, expenseItems });
const costs = [{ resourceId: "grain", icon: "fa-solid fa-wheat-awn", qty: 4, label: "Зерно: 4" }];
const capacity = { usedText: "68", capacityText: "100", freeText: "32", fillPercent: 68, quality: 2, security: 3, comfort: 2 };

export function createReviewBuildingCases() {
  return [
    { ...base, id: "mill", label: "Производство", hasCardBody: true, hasCardProductionRows: true,
      hasManyCardProductionRows: true, cardProductionRows: [recipe("flour", "Мука", "8 / декаду", costs), recipe("feed", "Корм", "6 / декаду", costs), recipe("malt", "Солод", "4 / декаду", costs)],
      hasCardProductionSeasonBadges: true, cardProductionSeasonBadges: [{ label: "Все сезоны", tooltip: "Производство доступно круглый год" }],
      hasPendingProduction: true, pendingProductionRows: [{ resource: "Мука", qty: 8, lineIndex: 0 }], functionLabel: "3 рецепта · за декаду", isProduction: true },
    { ...base, id: "warehouse", label: "Склад", name: "Большой склад строительных материалов", titleTooltip: "Большой склад строительных материалов",
      categoryLabel: "Хранение", icon: "fa-solid fa-warehouse", categoryIcon: "fa-solid fa-warehouse", showStorageStrip: true,
      storage: { ...capacity, usedText: "68 кг", capacityText: "100 кг", freeText: "32 кг" }, functionLabel: "68 / 100 кг", isStorage: true },
    { ...base, id: "housing", label: "Жильё", name: "Дом ремесленников", titleTooltip: "Дом ремесленников", categoryLabel: "Жильё",
      icon: "fa-solid fa-house", categoryIcon: "fa-solid fa-house", showHousingStrip: true, hasWorkerCapacity: false,
      housing: { ...capacity, usedText: "6", capacityText: "10", freeText: "4", fillPercent: 60 }, functionLabel: "6 / 10 жильцов", isHousing: true },
    { ...base, id: "construction", label: "Стройка", name: "Каменоломня на восточном склоне", titleTooltip: "Каменоломня на восточном склоне",
      statusClass: "building", statusLabel: "Строится", statusIcon: "fa-solid fa-hammer", hasCardStatParts: false,
      hasDisplayMetrics: false, hasUpkeep: false, hasWorkerCapacity: false, hasCardBody: true, showProjectNeeds: true,
      requirementsText: "Техника 2 · Пища 1", materialCostsLine: "Камень 20 · Древесина 10",
      showBuildProgress: true, progressPercent: 60, remainingBuildSuccesses: 8, buildActionTooltip: "Строительный бросок, осталось 8 успехов",
      constructionCrewOptions: [{ id: "crew", label: "Бригада Руны · 6к6", selected: true }], functionLabel: "12 / 20 успехов · 60%", isConstruction: true },
    { ...base, id: "medical", label: "Повреждённый лазарет", name: "Лазарет", titleTooltip: "Лазарет", flavorClass: "medical-building",
      statusClass: "damaged", statusLabel: "Повреждено", statusIcon: "fa-solid fa-triangle-exclamation", isMedicalBuilding: true,
      categoryLabel: "Медицина", icon: "fa-solid fa-bed-pulse", categoryIcon: "fa-solid fa-bed-pulse",
      medicalSummary: { used: 3, capacity: 8 }, functionLabel: "Койки 3 / 8", attention: "Повреждено · требуется ремонт", isMedical: true },
    { ...base, id: "destroyed", label: "Разрушенное здание", name: "Сторожевая башня", titleTooltip: "Сторожевая башня", categoryLabel: "Оборона",
      statusClass: "destroyed", statusLabel: "Разрушено", statusIcon: "fa-solid fa-house-crack", icon: "fa-solid fa-tower-observation",
      hasDisplayMetrics: false, hasUpkeep: false, hasWorkerCapacity: false, hasCardStatParts: false, headOnly: true, attention: "Разрушено · функции недоступны", functionLabel: "Оборона не учитывается" }
  ];
}

export function reviewCardSamples(kind) {
  const cases = createReviewBuildingCases();
  if (kind === "header") return { headerCases: [cases[0], cases[1], cases[4]].map(row => ({ ...row, headerOnly: true, currentBuildings: [{ ...row, headOnly: true,
    hasCardBody: false, showStorageStrip: false, showHousingStrip: false }], canEditBuildings: true })) };
  if (kind === "details") return { detailCases: cases.map((row, index) => ({ ...row, selected: index === 0,
    currentBuildings: [row], canEditBuildings: true })) };
  return { currentBuildings: [cases[4], cases[1], cases[3], cases[0]], proposedBuildings: [cases[4], cases[1], cases[3], cases[0]], canEditBuildings: true };
}
