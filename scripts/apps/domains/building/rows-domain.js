// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { ATTRIBUTE_META } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { normalizeResourceId, resourceIcon, resourceImage, resourceLabel, resourceOptions } from "../../../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../../../core/building-specials.js";

export const BuildingRowsDomain = {
_buildingSpecialKind(building = {}) {
  return inferBuildingSpecialKind(building);
},

_isSpecialBuildingRecord(building = {}) {
  return Boolean(this._buildingSpecialKind(building));
},

_isMedicalBuildingRecord(building = {}) {
  return isMedicalBuilding(building);
},

_isMedicalPatient(person = {}) {
  if (!person || person.dead) return false;
  const injured = this._safeNumber(person?.injuredDays, 0) > 0;
  const text = `${person?.status ?? ""} ${person?.notes ?? ""} ${person?.deathNote ?? ""}`.toLowerCase();
  return injured || /болен|больн|лихорад|жар|ранен|карантин|инфекц|травм/.test(text);
},

_medicalPatientLabel(person = {}) {
  const parts = [];
  const injured = this._safeNumber(person?.injuredDays, 0);
  if (injured > 0) parts.push(`ранен ${injured} дн.`);
  const status = String(person?.status ?? "").trim();
  if (status && !/погиб/i.test(status)) parts.push(status);
  return parts.join("; ") || "требует ухода";
},

_medicalBuildingBaseRows(holding) {
  return (holding?.buildings?.list ?? []).filter((building) => this._isMedicalBuildingRecord(building));
},

_medicalCapacityForBuilding(holding, building) {
  const def = SPECIAL_BUILDING_KINDS.medical;
  const built = ["built", "damaged"].includes(String(building?.constructionStatus ?? "built"));
  const efficiency = this._buildingEffectiveWorkers?.(holding, building) ?? { assigned: 0, total: 0 };
  const assigned = Math.max(0, this._safeNumber(efficiency.assigned, 0));
  const total = Math.max(0, this._safeNumber(efficiency.total, 0));
  const perEfficiency = Math.max(1, this._safeNumber(building?.medical?.patientsPerEfficiency, def.patientsPerEfficiency) || def.patientsPerEfficiency);
  const maxPatients = Math.max(0, this._safeNumber(building?.medical?.maxPatients ?? building?.medical?.capacity, def.defaultMaxPatients) || def.defaultMaxPatients);
  const rawCapacity = built && assigned > 0 ? Math.floor(total * perEfficiency) : 0;
  const capacity = Math.min(maxPatients, rawCapacity);
  return { assigned, efficiency: total, perEfficiency, maxPatients, rawCapacity, capacity, built };
},

_medicalAssignments(holding) {
  const patients = (holding?.people?.list ?? []).filter((person) => this._isMedicalPatient(person));
  const buildings = this._medicalBuildingBaseRows(holding);
  const result = new Map();
  let cursor = 0;
  for (const building of buildings) {
    const stats = this._medicalCapacityForBuilding(holding, building);
    const assignedPatients = stats.capacity > 0 ? patients.slice(cursor, cursor + stats.capacity) : [];
    cursor += assignedPatients.length;
    result.set(String(building?.id ?? ""), { ...stats, patients: assignedPatients });
  }
  const overflow = patients.slice(cursor);
  for (const building of buildings) {
    const key = String(building?.id ?? "");
    const row = result.get(key) ?? this._medicalCapacityForBuilding(holding, building);
    result.set(key, { ...row, overflow, totalPatients: patients.length });
  }
  return result;
},

_medicalBuildingSummary(holding, building, workerEfficiency = null) {
  const assignments = this._medicalAssignments(holding);
  const own = assignments.get(String(building?.id ?? "")) ?? { patients: [], overflow: [], totalPatients: 0, capacity: 0, assigned: 0, efficiency: 0, perEfficiency: 5, built: false };
  const efficiency = workerEfficiency ? Math.max(0, this._safeNumber(workerEfficiency.totalRaw ?? workerEfficiency.total, own.efficiency)) : own.efficiency;
  const assigned = workerEfficiency ? Math.max(0, this._safeNumber(workerEfficiency.assigned, own.assigned)) : own.assigned;
  const capacity = own.capacity;
  const used = own.patients.length;
  const free = Math.max(0, capacity - used);
  const patientRows = own.patients.map((person) => ({
    id: person.id,
    name: person.name || "Без имени",
    label: this._medicalPatientLabel(person),
    injuredDays: this._safeNumber(person?.injuredDays, 0),
    status: String(person?.status ?? ""),
    notes: String(person?.notes ?? "")
  }));
  const overflowRows = own.overflow.map((person) => ({ id: person.id, name: person.name || "Без имени", label: this._medicalPatientLabel(person) }));
  const tooltip = patientRows.length
    ? patientRows.map((person) => `${person.name}: ${person.label}`).join("; ")
    : (capacity ? "Свободные койки есть, пациентов нет." : (assigned ? "Эффективности врачей не хватает для палат." : "Без врачей лазарет не работает."));
  return {
    enabled: true,
    doctors: assigned,
    doctorEfficiency: efficiency,
    doctorEfficiencyText: this._formatNumber ? this._formatNumber(efficiency) : String(Math.round(efficiency * 100) / 100),
    perEfficiency: own.perEfficiency,
    maxPatients: own.maxPatients ?? SPECIAL_BUILDING_KINDS.medical.defaultMaxPatients,
    rawCapacity: own.rawCapacity ?? capacity,
    maxPatientsPath: `${String(building?.basePath ?? "")}.medical.maxPatients`,
    capacity,
    used,
    free,
    totalPatients: own.totalPatients ?? 0,
    overflow: overflowRows.length,
    patientRows,
    overflowRows,
    hasPatients: patientRows.length > 0,
    hasOverflow: overflowRows.length > 0,
    active: capacity > 0,
    statusText: capacity > 0 ? `${used}/${capacity} пациентов` : "нет рабочих медмест",
    text: capacity > 0 ? `${used}/${capacity}` : "0/0",
    tooltip
  };
},

_prepareBuildingRows(holding, canEdit) {
  const rows = holding?.buildings?.list ?? [];
  const storageRooms = this._storageRooms?.(holding, { includeUnavailable: true }) ?? [];
  const prepared = rows.map((row, index) => this._prepareBuildingRow(holding, row, index, canEdit, storageRooms));
  const category = this.activeBuildingCategory || "all";
  return category === "all" ? prepared : prepared.filter((row) => row.category === category);
},

_prepareBuildingRow(holding, row, index, canEdit, storageRoomsArg = null, options = {}) {
  const holdingIndex = this._holdingIndex(holding);
  const recordPath = options?.basePath || `holdings.${holdingIndex}.buildings.list.${index}`;
  const isTemplate = Boolean(options?.isTemplate);
  const development = this._developmentSummary(holding);
  const requirements = this._devObject(row.requirements);
  const bonuses = this._devObject(row.bonuses);
  const functions = this._buildingFunctions(row);
  const workerEfficiency = this._buildingEffectiveWorkers(holding, row);
  const status = this._buildingStatus(row);
  const workerSlots = this._buildingWorkerSlots(holding, row, index);
  const assignedCount = workerSlots.filter((slot) => slot.selectedId).length;
  const productionLines = this._prepareProductionLines(row, index, holding, storageRoomsArg, holdingIndex, recordPath);
  const incomeSummary = this._buildingIncomeSummary(row, holding);
  const defenseSummary = this._buildingDefenseSummary(row, holding);
  const progress = Math.max(0, this._safeNumber(row.buildProgress, 0));
  const target = Math.max(1, this._safeNumber(row.buildTarget, 6));
  const category = this._buildingCategory(row);
  const categoryInfo = this._buildingCategoryOptions().find((item) => item.id === category);
  const dataForTemplateLookup = this._contextData ?? SkyholdData.get();
  const templateKey = String(row.templateId ?? "").trim().toLowerCase();
  const rowNameKey = String(row.name ?? "").trim().toLowerCase();
  const templateSource = (dataForTemplateLookup?.catalog?.buildings ?? []).find((item) => {
    if (templateKey && String(item?.id ?? "").trim().toLowerCase() === templateKey) return true;
    return rowNameKey && String(item?.name ?? "").trim().toLowerCase() === rowNameKey;
  }) ?? null;
  const icon = String(row.icon ?? templateSource?.icon ?? categoryInfo?.icon ?? "fa-solid fa-building").trim() || "fa-solid fa-building";
  const img = String(row.img ?? row.image ?? templateSource?.img ?? templateSource?.image ?? "").trim();
  const devUnlocked = this._requirementsMet(requirements, development.totals);
  const requiredBuildings = this._prepareRequiredBuildingRows(holding, row, index, holdingIndex, recordPath, options);
  const buildingsUnlocked = requiredBuildings.every((item) => item.met || !item.value);
  const unlocked = devUnlocked && buildingsUnlocked;
  const showBuildProgress = status.value !== "built";
  const showProjectNeeds = false;
  const developmentDuplicate = this._isDuplicateDevelopmentBuilding?.(holding, row) ?? false;
  const materialCosts = this._prepareMaterialCosts(row, index, holdingIndex, recordPath);
  const materialCostsRequired = materialCosts.filter((item) => this._safeNumber(item.qty, 0) > 0);
  const materialAllocated = Boolean(row.materialsAllocated);
  const canAllocateMaterials = status.value !== "built" && materialCostsRequired.length > 0 && !materialAllocated;
  const materialAllocationLine = materialCostsRequired.length
    ? `${materialAllocated ? "Выделено" : "Нужно"}: ${materialCostsRequired.map((item) => `${item.qty} ${item.name || item.resourceId || "рес."}`).join(" · ")}`
    : "";
  const storageData = row.storage && typeof row.storage === "object" ? row.storage : {};
  const storageCapacity = Math.max(0, this._safeNumber(storageData.capacity, 0));
  const storageSecurity = Math.max(0, this._safeNumber(storageData.security, 0));
  const storageQuality = Math.max(0, this._safeNumber(storageData.quality, 0));
  const storageRoomSummary = (Array.isArray(storageRoomsArg) ? storageRoomsArg : [])
    .find((room) => String(room.id) === String(row.id));
  const storageUsedText = storageRoomSummary?.usedText ?? this._formatStorageLoad?.(storageRoomSummary?.used ?? 0) ?? "0";
  const storageFreeText = storageRoomSummary?.freeText ?? (storageCapacity > 0 ? this._formatNumber(storageCapacity) : "∞");
  const storageCapacityText = storageRoomSummary?.capacityText ?? (storageCapacity > 0 ? this._formatNumber(storageCapacity) : "∞");
  const storageFillClass = storageRoomSummary?.fillClass ?? "unlimited-capacity";
  const storageFillPercent = storageRoomSummary?.fillPercent ?? 0;
  const housingData = row.housing && typeof row.housing === "object" ? row.housing : {};
  const housingCapacity = Math.max(0, this._safeNumber(housingData.capacity, 0));
  const housingComfort = this._safeNumber(housingData.comfort, 0);
  const housingQuality = Math.max(0, this._safeNumber(housingData.quality, 0));
  const housingOccupants = this._housingOccupants?.(holding, row) ?? [];
  const housingSlots = this._buildingHousingSlots?.(holding, row, index, housingCapacity, housingOccupants) ?? [];
  const housingUsed = housingOccupants.length;
  const housingFree = housingCapacity > 0 ? Math.max(0, housingCapacity - housingUsed) : Infinity;
  const housingFillClass = housingCapacity <= 0 ? "unlimited-capacity" : (housingUsed >= housingCapacity ? "full-capacity" : (housingUsed / Math.max(1, housingCapacity) >= 0.75 ? "near-capacity" : "ok-capacity"));
  const housingFillPercent = housingCapacity <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((housingUsed / Math.max(1, housingCapacity)) * 100)));
  const specialKind = this._buildingSpecialKind(row);
  const isSpecialBuilding = Boolean(specialKind);
  const specialDefinition = specialKind ? SPECIAL_BUILDING_KINDS[specialKind] : null;
  const isMedicalBuilding = specialKind === "medical";
  const medicalSummary = isMedicalBuilding ? this._medicalBuildingSummary(holding, row, workerEfficiency) : null;
  if (medicalSummary) medicalSummary.maxPatientsPath = `${recordPath}.medical.maxPatients`;
  const buildingFlavorClass = isMedicalBuilding ? (specialDefinition?.cssClass || "medical-building") : "";
  const categoryOptions = this._buildingCategoryOptions().filter((item) => item.id !== "all").map((item) => ({
    value: item.label,
    label: item.label,
    selected: category === item.id || String(row.type ?? "") === item.label
  }));
  const selectedCrewId = String(row.constructionCrewId ?? "");
  const constructionCrewOptions = [{ id: "", label: "Без бригады", selected: !selectedCrewId }].concat(this._constructionCrews(holding).map((crew) => ({
    id: crew.id,
    label: crew.name || "Стройбригада",
    selected: String(crew.id) === selectedCrewId
  })));
  const visibility = row.visibility === "gm" ? "gm" : "public";
  const playerVisible = visibility !== "gm";
  const religionData = row.religion && typeof row.religion === "object" ? row.religion : {};
  const religionReligious = Boolean(religionData.religious);
  const religionFaith = String(religionData.faith ?? religionData.name ?? "");
  const religionCustomFaith = String(religionData.customFaith ?? religionData.custom ?? religionData.other ?? "");

  const cleanWorkerEfficiencyTotal = Math.max(0, this._safeNumber(workerEfficiency.total, 0));
  const preparedWorkerEfficiency = {
    ...workerEfficiency,
    totalRaw: cleanWorkerEfficiencyTotal,
    total: this._formatNumber ? this._formatNumber(cleanWorkerEfficiencyTotal) : String(Math.round(cleanWorkerEfficiencyTotal * 100) / 100)
  };
  const formatSigned = (value) => `${value > 0 ? "+" : ""}${this._formatNumber ? this._formatNumber(value) : String(value)}`;
  const cardDevParts = this._developmentParts(bonuses).filter((part) => this._safeNumber(part.value, 0) !== 0).map((part) => {
    const value = this._safeNumber(part.value, 0);
    return { ...part, signed: formatSigned(value), tone: value >= 0 ? "positive" : "negative" };
  });
  const cardImpactParts = [
    { key: "morale", label: "Довольство", icon: "fa-solid fa-face-smile", css: "morale", value: this._safeNumber(row.moraleDelta, 0) },
    { key: "reputation", label: "Репутация", icon: "fa-solid fa-crown", css: "reputation", value: this._safeNumber(row.reputation, 0) }
  ].filter((part) => part.value !== 0).map((part) => ({ ...part, signed: formatSigned(part.value), tone: part.value >= 0 ? "positive" : "negative" }));
  const cardStatParts = [...cardDevParts, ...cardImpactParts];
  const cardProductionRows = productionLines
    .filter((line) => line.active && line.resource)
    .map((line) => {
      const expenseText = String(line.expenses ?? "").trim();
      const expenseItems = expenseText
        ? (this._parseResourceCosts?.(expenseText) ?? []).map((item) => {
            const id = normalizeResourceId(item?.resourceId, item?.name);
            return {
              ...item,
              icon: resourceIcon(id),
              img: resourceImage(id),
              label: resourceLabel(id)
            };
          })
        : [];
      return {
        ...line,
        outputText: String(line.totalPreview ?? line.cycleText ?? line.total ?? "").trim(),
        expenseText,
        expenseItems,
        hasExpenses: expenseItems.length > 0,
        resourceImg: resourceImage(line.resourceId, line.resource),
        hasResourceImg: Boolean(resourceImage(line.resourceId, line.resource)),
        hasSeasonHint: Boolean(line.hasSeasonHint),
        seasonShort: line.seasonShort,
        seasonTooltip: line.seasonTooltip
      };
    });
  const effectText = String(row.effect ?? "").trim();
  const notesText = String(row.notes ?? "").trim();
  const titleTooltip = [effectText, notesText].filter(Boolean).join("\n\n");
  const hasEffect = Boolean(effectText);
  const showStorageStrip = Boolean(functions.storage);
  const showHousingStrip = Boolean(functions.housing);
  const hasCardBody = Boolean(cardProductionRows.length || showProjectNeeds || showBuildProgress || this._pendingProductionRows(row, holding, index).length);
  const headOnly = !hasCardBody && !showStorageStrip && !showHousingStrip;

  return {
    ...row,
    _index: index,
    category,
    categoryLabel: this._buildingCategoryLabel(category),
    categoryOptions,
    flavorClass: buildingFlavorClass,
    specialKind,
    isSpecialBuilding,
    specialDefinition,
    showFunctionToggles: !isSpecialBuilding,
    isMedicalBuilding,
    medicalSummary: medicalSummary ?? { patients: 0, capacity: 0, text: "", tooltip: "" },
    cardStatParts,
    hasCardStatParts: cardStatParts.length > 0,
    cardProductionRows,
    hasCardProductionRows: cardProductionRows.length > 0,
    effectText,
    notesText,
    titleTooltip,
    hasTitleTooltip: Boolean(titleTooltip),
    hasEffect,
    showStorageStrip,
    showHousingStrip,
    hasCardBody,
    headOnly,
    icon,
    img,
    hasImage: Boolean(img),
    expanded: row.id === this.expandedBuildingId,
    requirements,
    bonuses,
    developmentParts: this._developmentParts(requirements, `${recordPath}.requirements`),
    bonusParts: this._developmentParts(bonuses, `${recordPath}.bonuses`),
    moraleDelta: this._safeNumber(row.moraleDelta, 0),
    reputation: this._safeNumber(row.reputation, 0),
    impactParts: [
      { key: "morale", label: "Довольство", icon: "fa-solid fa-face-smile", css: "morale", value: this._safeNumber(row.moraleDelta, 0), path: `${recordPath}.moraleDelta` },
      { key: "reputation", label: "Репутация", icon: "fa-solid fa-crown", css: "reputation", value: this._safeNumber(row.reputation, 0), path: `${recordPath}.reputation` }
    ],
    requirementsText: this._devText(requirements, "Нет"),
    bonusesText: this._devText(bonuses, "Нет"),
    functions,
    storage: {
      capacity: storageCapacity,
      security: storageSecurity,
      quality: storageQuality,
      used: storageRoomSummary?.used ?? 0,
      usedText: storageUsedText,
      freeText: storageFreeText,
      capacityText: storageCapacityText,
      fillClass: storageFillClass,
      fillPercent: storageFillPercent,
      fillTitle: storageRoomSummary?.fillTitle ?? "",
      hasCapacity: storageCapacity > 0,
      capacityPath: `${recordPath}.storage.capacity`,
      securityPath: `${recordPath}.storage.security`,
      qualityPath: `${recordPath}.storage.quality`
    },
    housing: {
      capacity: housingCapacity,
      comfort: housingComfort,
      quality: housingQuality,
      used: housingUsed,
      free: housingFree,
      usedText: String(housingUsed),
      capacityText: housingCapacity > 0 ? String(housingCapacity) : "∞",
      freeText: housingCapacity > 0 ? String(housingFree) : "∞",
      fillClass: housingFillClass,
      fillPercent: housingFillPercent,
      hasCapacity: housingCapacity > 0,
      occupants: housingOccupants.map((person) => person.name || "Без имени").join(", "),
      slotRows: housingSlots,
      hasSlotRows: housingSlots.length > 0,
      notes: String(housingData.notes ?? ""),
      capacityPath: `${recordPath}.housing.capacity`,
      comfortPath: `${recordPath}.housing.comfort`,
      qualityPath: `${recordPath}.housing.quality`,
      notesPath: `${recordPath}.housing.notes`
    },
    cultureReligion: {
      religious: religionReligious,
      faith: religionFaith,
      faithLabel: this._religionLabel(religionFaith, religionCustomFaith),
      faithOptions: this._religionOptions(religionFaith),
      customFaith: religionCustomFaith,
      showCustomFaith: religionFaith === "other",
      notes: String(religionData.notes ?? religionData.description ?? ""),
      religiousPath: `${recordPath}.religion.religious`,
      faithPath: `${recordPath}.religion.faith`,
      customFaithPath: `${recordPath}.religion.customFaith`,
      notesPath: `${recordPath}.religion.notes`
    },
    functionOptions: this._functionOptions(row, index, holdingIndex, recordPath),
    showProductionBlock: !isSpecialBuilding && Boolean(functions.production),
    showIncomeBlock: !isSpecialBuilding && Boolean(functions.income),
    showDefenseBlock: !isSpecialBuilding && Boolean(functions.defense),
    showHousingBlock: !isSpecialBuilding && Boolean(functions.housing),
    unlocked,
    unlockLabel: unlocked ? "Открыто" : "Не открыто",
    statusLabel: status.label,
    statusClass: [status.css, developmentDuplicate ? "dev-duplicate" : ""].filter(Boolean).join(" "),
    developmentDuplicate,
    developmentUniqueText: developmentDuplicate ? "Повторное здание: развитие не дублируется" : "Уникальный вклад развития",
    statusOptions: this._buildingStatusOptions(status.value),
    constructionStatus: row.constructionStatus || status.value,
    constructionCrewId: selectedCrewId,
    visibility,
    playerVisible,
    visibilityText: playerVisible ? "видно игрокам" : "скрыто от игроков",
    constructionCrewOptions,
    workerSlots,
    assignedCount,
    workersLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMin, 0))}-${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    workerCountLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    hasWorkerCapacity: Math.max(0, this._safeNumber(row.workersMax, 0)) > 0,
    progress,
    target,
    progressText: `${progress}/${target}`,
    progressPercent: Math.max(0, Math.min(100, Math.round((progress / target) * 100))),
    isBuilt: status.value === "built",
    showProjectNeeds,
    showBuildProgress,
    productionLine: this._productionLine(row),
    contents: this._prepareBuildingContents(row, index, holding, holdingIndex, recordPath),
    hasContents: Array.isArray(row.contents) && row.contents.length > 0,
    productionLines,
    hasProductionLines: productionLines.length > 0,
    productionLinesText: this._productionLinesText(row, holding),
    pendingProductionRows: this._pendingProductionRows(row, holding, index),
    hasPendingProduction: this._pendingProductionRows(row, holding, index).length > 0,
    productionSummary: this._buildingProductionSummary(row, assignedCount, holding),
    income: incomeSummary,
    incomeSummary,
    defense: defenseSummary,
    defenseSummary,
    workerEfficiency: preparedWorkerEfficiency,
    modifierLine: String(row.modifiers ?? "").trim() || "—",
    workerRoleLine: String(row.workerRole ?? "").trim() || "—",
    suitableLine: String(row.suitableWorkerTypes ?? "").trim() || "—",
    suitableTypeOptions: this._workerTypeSelectOptions(row.suitableWorkerTypes),
    workerPrimaryAttributeOptions: this._workerPrimaryAttributeOptions(row.workerPrimaryAttribute),
    workerPrimaryAttributeLabel: this._workerPrimaryAttributeOptions(row.workerPrimaryAttribute).find((item) => item.selected)?.label ?? "—",
    suitableTypeBadges: this._suitableTypeBadges(row.suitableWorkerTypes, `${recordPath}.suitableWorkerTypes`, row),
    hasSuitableTypeBadges: splitList(row.suitableWorkerTypes).length > 0,
    upkeep: this._safeNumber(row.upkeep, 0),
    hasUpkeep: this._safeNumber(row.upkeep, 0) !== 0,
    upkeepLine: this._safeNumber(row.upkeep, 0) ? String(this._safeNumber(row.upkeep, 0)) : "—",
    materialCosts,
    materialCostsLine: materialCosts.length ? materialCosts.map((item) => `${item.qty} ${item.name}`.trim()).join(" · ") : "—",
    materialCostsRequired,
    materialAllocated,
    canAllocateMaterials,
    materialAllocationLine,
    requiredBuildings,
    requiredBuildingsLine: requiredBuildings.length ? requiredBuildings.map((item) => item.label).join(" · ") : "—",
    prerequisiteOptions: this._buildingPrerequisiteOptions(holding, row),
    canRollConstruction: canEdit && !isTemplate && status.value !== "built",
    isTemplate,
    basePath: recordPath,
    primaryDev: String(row.primaryDev ?? ""),
    primaryDevLabel: this._devLabel(row.primaryDev),
    specialRequirements: String(row.specialRequirements ?? ""),
    sourceRequirement: String(row.sourceRequirement ?? ""),
    sourceRawMaterials: String(row.sourceRawMaterials ?? "")
  };
},

_prepareBuildingTabs(holding) {
  const rows = holding?.buildings?.list ?? [];
  const counts = new Map([["all", rows.length]]);
  for (const building of rows) {
    const category = this._buildingCategory(building);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return this._buildingCategoryOptions().map((tab) => {
    const count = counts.get(tab.id) ?? 0;
    return {
      ...tab,
      count,
      tabCount: count,
      active: (this.activeBuildingCategory || "all") === tab.id
    };
  });
},

_holdingIndexForBuilding(building) {
  const data = this._contextData ?? SkyholdData.get();
  return data.holdings.findIndex((holding) => (holding.buildings?.list ?? []).some((item) => item.id === building?.id));
},

_buildingStatus(building) {
  const value = String(building?.constructionStatus ?? "built");
  if (value === "planned") return { value, label: "Проект", css: "planned" };
  if (value === "building") return { value, label: building?.repairOf ? "Ремонт" : "Строится", css: "building" };
  if (value === "paused") return { value, label: "Пауза", css: "paused" };
  if (value === "damaged") return { value, label: "Повреждено", css: "damaged" };
  if (value === "heavilyDamaged") return { value, label: "Сильно повреждено", css: "heavilyDamaged" };
  if (value === "destroyed") return { value, label: "Разрушено", css: "destroyed" };
  return { value: "built", label: "Построено", css: "built" };
},

_buildingStatusOptions(current) {
  return [
    { value: "planned", label: "Проект", selected: current === "planned" },
    { value: "building", label: "Строится", selected: current === "building" },
    { value: "paused", label: "Пауза", selected: current === "paused" },
    { value: "damaged", label: "Повреждено", selected: current === "damaged" },
    { value: "heavilyDamaged", label: "Сильно повреждено", selected: current === "heavilyDamaged" },
    { value: "destroyed", label: "Разрушено", selected: current === "destroyed" },
    { value: "built", label: "Построено", selected: current === "built" }
  ];
},

_buildingHousingSlots(holding, building, buildingIndex, capacity = null, occupantsArg = null) {
  const buildingId = String(building?.id ?? "");
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const occupants = Array.isArray(occupantsArg) ? occupantsArg : (this._housingOccupants?.(holding, building) ?? []);
  const selectedIds = occupants.map((person) => String(person?.id ?? "")).filter(Boolean);
  const cap = Math.max(0, this._safeNumber(capacity ?? building?.housing?.capacity, 0));
  const slotCount = cap > 0 ? Math.max(cap, selectedIds.length) : Math.max(1, selectedIds.length + 1);
  const slots = [];
  for (let slot = 0; slot < slotCount; slot += 1) {
    const selectedId = String(selectedIds[slot] ?? "");
    const selectedPerson = people.find((person) => String(person.id) === selectedId);
    const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
    for (const person of people) {
      const personId = String(person?.id ?? "");
      if (!personId) continue;
      const home = String(person?.home ?? "");
      const alreadyHere = selectedIds.includes(personId) && personId !== selectedId;
      if (alreadyHere) continue;
      const currentHome = this._homeLabel?.(person, holding) ?? home;
      const hint = home && home !== buildingId && currentHome !== "Без жилья" ? currentHome : this._workerType(person);
      options.push({
        id: personId,
        name: person.name || "Без имени",
        selected: personId === selectedId,
        disabled: false,
        hint
      });
    }
    slots.push({
      slot,
      slotNo: slot + 1,
      selectedId,
      label: selectedPerson?.name ?? "Пусто",
      options
    });
  }
  return slots;
},

_buildingWorkerSlots(holding, building, buildingIndex) {
  const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
  const assigned = Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [];
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  const occupied = this._assignedWorkerSet(holding, building?.id);
  const slots = [];
  for (let slot = 0; slot < max; slot += 1) {
    const rawSelectedId = String(assigned[slot] ?? "");
    const selectedPerson = people.find((person) => String(person.id) === rawSelectedId);
    const selectedId = selectedPerson ? rawSelectedId : "";
    const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
    for (const person of people) {
      const personId = String(person.id ?? "");
      if (!personId) continue;
      const alreadyElsewhere = occupied.has(personId) && personId !== selectedId;
      if (alreadyElsewhere) continue;
      if (this._canResidentWork && !this._canResidentWork(person) && personId !== selectedId) continue;
      options.push({
        id: personId,
        name: person.name || "Без имени",
        selected: personId === selectedId,
        disabled: false,
        hint: this._workerType(person)
      });
    }
    slots.push({
      slot,
      slotNo: slot + 1,
      label: selectedPerson?.name ?? "Пусто",
      selectedId,
      path: `holdings.${this._holdingIndex(holding)}.buildings.list.${buildingIndex}.assignedWorkerIds.${slot}`,
      options
    });
  }
  return slots;
},

_findHoldingForBuilding(building) {
  const data = SkyholdData.get();
  return data.holdings.find((holding) => (holding.buildings?.list ?? []).some((item) => item.id === building?.id)) ?? null;
}
};
