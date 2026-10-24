// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { constructionCapitalBudget } from "../../../engines/economy/construction-stages.js";
import { SkyholdData } from "../../../data/store.js";
import { normalizeResourceId, resourceIcon, resourceImage, resourceLabel } from "../../../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../../../core/building-specials.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { buildingAppearance } from "../../../core/building-appearance.js";
import { maintenanceEfficiencyFactor, normalizeBuildingMaintenance } from "../../../data/economy/maintenance.js";
import { buildingRequiresConstructionCenter } from "../../../data/building-development-tree.js";
import { buildingStaffingWorkerIds, explicitWorkAllocationsForBuilding } from "../../../data/work-allocations.js";
import { buildingConstructionPrerequisitesMet, buildingHousingComfort, buildingNominalMorale, buildingWonderworkingActive } from "../../../engines/economy/building-service.js";
import { isResidentInPopulation } from "../../../data/resident-presence.js";
import { buildingLaborMode } from "../../../data/hybrid-labor.js";

function cardSettlementEffects(app, holding) {
  return {
    morale: new Map((app._buildingMoraleSummary(holding).sources ?? []).map((source) => [String(source.id), source.value])),
    reputation: new Map((app._reputationSummary(holding).buildings ?? []).map((source) => [String(source.id), source.value]))
  };
}

function buildingTemplateLookup(data) {
  const byId = new Map();
  const byName = new Map();
  for (const template of data?.catalog?.buildings ?? []) {
    const id = String(template?.id ?? "").trim().toLowerCase();
    const name = String(template?.name ?? "").trim().toLowerCase();
    if (id && !byId.has(id)) byId.set(id, template);
    if (name && !byName.has(name)) byName.set(name, template);
  }
  return { byId, byName };
}

export const BuildingRowsDomain = {
_buildingSpecialKind(building = {}) {
  return inferBuildingSpecialKind(building);
},

_isMedicalBuildingRecord(building = {}) {
  return isMedicalBuilding(building);
},

_isMedicalPatient(person = {}) {
  if (!person || person.dead) return false;
  const hasExplicitCounter = Object.hasOwn(person ?? {}, "injuredDays");
  const injured = this._safeNumber(person?.injuredDays, 0);
  if (injured > 0) return true;
  const text = `${person?.status ?? ""} ${person?.notes ?? ""} ${person?.deathNote ?? ""}`.toLowerCase();
  if (/болен|больн|лихорад|жар|карантин|инфекц/.test(text)) return true;
  return !hasExplicitCounter && /ранен|тяжело|сломлен|травм|injured|wound/.test(text);
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

_medicalCapacityForBuilding(holding, building, workerContext = null) {
  const def = SPECIAL_BUILDING_KINDS.medical;
  const built = buildingOperationalState(building).operational;
  const efficiency = this._buildingEffectiveWorkers?.(holding, building, workerContext) ?? { assigned: 0, total: 0 };
  const assigned = Math.max(0, this._safeNumber(efficiency.assigned, 0));
  const total = Math.max(0, this._safeNumber(efficiency.total, 0));
  const perEfficiency = Math.max(1, this._safeNumber(building?.medical?.patientsPerEfficiency, def.patientsPerEfficiency) || def.patientsPerEfficiency);
  const maxPatients = Math.max(0, this._safeNumber(building?.medical?.maxPatients ?? building?.medical?.capacity, def.defaultMaxPatients) || def.defaultMaxPatients);
  const rawCapacity = built && assigned > 0 ? Math.floor(total * perEfficiency) : 0;
  const capacity = Math.min(maxPatients, rawCapacity);
  return { assigned, efficiency: total, perEfficiency, maxPatients, rawCapacity, capacity, built };
},

_medicalAssignments(holding, workerContext = null) {
  const patients = (holding?.people?.list ?? []).filter((person) => this._isMedicalPatient(person));
  const buildings = this._medicalBuildingBaseRows(holding);
  const result = new Map();
  let cursor = 0;
  for (const building of buildings) {
    const stats = this._medicalCapacityForBuilding(holding, building, workerContext);
    const assignedPatients = stats.capacity > 0 ? patients.slice(cursor, cursor + stats.capacity) : [];
    cursor += assignedPatients.length;
    result.set(String(building?.id ?? ""), { ...stats, patients: assignedPatients });
  }
  const overflow = patients.slice(cursor);
  for (const building of buildings) {
    const key = String(building?.id ?? "");
    const row = result.get(key) ?? this._medicalCapacityForBuilding(holding, building, workerContext);
    result.set(key, { ...row, overflow, totalPatients: patients.length });
  }
  return result;
},

_medicalBuildingSummary(holding, building, workerEfficiency = null, assignmentsArg = null) {
  const assignments = assignmentsArg instanceof Map ? assignmentsArg : this._medicalAssignments(holding);
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

_prepareBuildingRows(holding, canEdit, options = {}) {
  const sourceRows = holding?.buildings?.list ?? [];
  const category = this.activeBuildingCategory || "all";
  const visibleRows = sourceRows
    .map((row, index) => ({ row, index }))
    .filter((entry) => game.user?.isGM || entry.row?.visibility !== "gm" || String(entry.row?.templateId ?? "").trim())
    .filter((entry) => category === "all" || this._buildingCategory(entry.row) === category);
  if (!visibleRows.length) return [];
  const storageRooms = this._storageRooms?.(holding, { includeUnavailable: true }) ?? [];
  const dataForTemplateLookup = this._contextData ?? SkyholdData.get();
  const workerContext = options?.workerContext ?? this._economyWorkerContext?.(holding) ?? null;
  const housingIndex = this._residentHousingIndex?.(holding) ?? null;
  const buildingLookup = new Map();
  for (const building of sourceRows) {
    const id = String(building?.id ?? "");
    const templateId = String(building?.templateId ?? "");
    const name = String(building?.name ?? "");
    if (id && !buildingLookup.has(id)) buildingLookup.set(id, building);
    if (templateId && !buildingLookup.has(templateId)) buildingLookup.set(templateId, building);
    if (name && !buildingLookup.has(name)) buildingLookup.set(name, building);
  }
  const prepareOptions = {
    contextMode: "card",
    cardSettlementEffects: cardSettlementEffects(this, holding),
    holdingIndex: this._holdingIndex(holding),
    workerContext,
    housingIndex,
    buildingLookup,
    development: (holding?.id && this._contextHoldingId === holding.id ? this._contextDevelopment : null) ?? this._developmentSummary(holding),
    categoryOptions: this._buildingCategoryOptions(),
    constructionCrews: this._constructionCrews(holding),
    medicalAssignments: visibleRows.some((entry) => this._isMedicalBuildingRecord(entry.row)) ? this._medicalAssignments(holding, workerContext) : null,
    templateLookup: buildingTemplateLookup(dataForTemplateLookup)
  };
  return visibleRows.map((entry) => this._prepareBuildingRow(holding, entry.row, entry.index, canEdit, storageRooms, prepareOptions));
},

_prepareBuildingRow(holding, row, index, canEdit, storageRoomsArg = null, options = {}) {
  const cardOnly = options?.contextMode === "card";
  const holdingIndex = Number.isInteger(options?.holdingIndex) ? options.holdingIndex : this._holdingIndex(holding);
  const recordPath = options?.basePath || `holdings.${holdingIndex}.buildings.list.${index}`;
  const isTemplate = Boolean(options?.isTemplate);
  const development = options?.development ?? this._developmentSummary(holding);
  const requirements = this._devObject(row.requirements);
  const bonuses = this._devObject(row.bonuses);
  const functions = this._buildingFunctions(row);
  const workerContext = options?.workerContext ?? null;
  const housingIndex = options?.housingIndex ?? null;
  const storageRooms = Array.isArray(storageRoomsArg)
    ? storageRoomsArg
    : (this._storageRooms?.(holding, { includeUnavailable: true }) ?? []);
  const specialKind = this._buildingSpecialKind(row);
  const isSpecialBuilding = Boolean(specialKind);
  const specialDefinition = specialKind ? SPECIAL_BUILDING_KINDS[specialKind] : null;
  const isMedicalBuilding = specialKind === "medical";
  const workerEfficiency = cardOnly ? null : this._buildingEffectiveWorkers(holding, row, workerContext);
  const workerProfileSummary = cardOnly ? null : this._buildingWorkerProfileSummary(row);
  const status = this._buildingStatus(row);
  const workerSlots = cardOnly ? null : this._buildingWorkerSlots(holding, row, index, workerContext, recordPath, canEdit);
  const maxWorkers = Math.max(0, this._safeNumber(row.workersMax, 0));
  const peopleById = workerContext?.peopleById ?? new Map((holding?.people?.list ?? [])
    .map((person) => [String(person?.id ?? ""), person]));
  const staffingIds = buildingStaffingWorkerIds(holding, row?.id);
  const assignedCount = staffingIds.filter((personId) => peopleById.has(personId)).length;
  const plannedWorkerRows = cardOnly ? [] : (holding?.people?.list ?? []).map((person) => {
    const allocations = explicitWorkAllocationsForBuilding(person, row?.id);
    const normalQd = allocations.reduce((sum, allocation) => sum + Math.max(0, Math.floor(this._safeNumber(allocation?.normalQd, 0))), 0);
    const overtimeQd = allocations.reduce((sum, allocation) => sum + Math.max(0, Math.floor(this._safeNumber(allocation?.overtimeQd, 0))), 0);
    return {
      id: String(person?.id ?? ""),
      name: String(person?.name ?? "Житель"),
      normalQd,
      overtimeQd,
      qdLine: `${normalQd} QD${overtimeQd ? ` + ${overtimeQd} OT` : ""}`,
      functionCount: allocations.length
    };
  }).filter((worker) => worker.id && (worker.normalQd > 0 || worker.overtimeQd > 0));
  const productionLines = this._prepareProductionLines(row, index, holding, storageRooms, holdingIndex, recordPath, { includeEditorOptions: !cardOnly });
  const agricultureView = cardOnly ? null : (this._prepareAgricultureBuildingView?.(holding, row, recordPath, storageRooms) ?? null);
  const livestockView = cardOnly ? null : (this._prepareLivestockBuildingView?.(holding, row, recordPath, storageRooms) ?? null);
  const incomeStorageRooms = Array.isArray(storageRoomsArg) && storageRoomsArg.length === 0 ? null : storageRooms;
  const incomeSummary = cardOnly ? null : this._buildingIncomeSummary(row, holding, workerContext, workerEfficiency, incomeStorageRooms);
  const defenseSummary = cardOnly ? null : this._buildingDefenseSummary(row, holding, workerContext, status, workerEfficiency);
  const progress = Math.max(0, this._safeNumber(row.buildProgress, 0));
  const target = Math.max(1, this._safeNumber(row.buildTarget, 6));
  const category = this._buildingCategory(row);
  const categoryOptionsAll = Array.isArray(options?.categoryOptions) ? options.categoryOptions : this._buildingCategoryOptions();
  const categoryInfo = categoryOptionsAll.find((item) => item.id === category);
  const templateKey = String(row.templateId ?? "").trim().toLowerCase();
  const rowNameKey = String(row.name ?? "").trim().toLowerCase();
  const templateLookup = options?.templateLookup;
  let templateSource = templateKey && templateLookup?.byId instanceof Map ? templateLookup.byId.get(templateKey) : null;
  if (!templateSource && rowNameKey && templateLookup?.byName instanceof Map) templateSource = templateLookup.byName.get(rowNameKey);
  if (!templateSource) {
    const dataForTemplateLookup = this._contextData ?? SkyholdData.get();
    const templates = dataForTemplateLookup?.catalog?.buildings ?? [];
    templateSource = (templateKey ? templates.find((item) => String(item?.id ?? "").trim().toLowerCase() === templateKey) : null)
      ?? (rowNameKey ? templates.find((item) => String(item?.name ?? "").trim().toLowerCase() === rowNameKey) : null)
      ?? null;
  }
  const { icon, img } = buildingAppearance(row, templateSource, categoryInfo?.icon);
  const devUnlocked = this._requirementsMet(requirements, development.totals);
  const requiredBuildingIds = Array.isArray(row?.requiredBuildingIds) ? row.requiredBuildingIds : [];
  const requiredAnyBuildingIds = Array.isArray(row?.requiredAnyBuildingIds) ? row.requiredAnyBuildingIds : [];
  const constructionCenterRequired = isTemplate && buildingRequiresConstructionCenter(row);
  const requiredBuildings = cardOnly ? [] : this._prepareRequiredBuildingRows(holding, row, index, holdingIndex, recordPath, {
    ...options,
    mode: "all",
    includeConstructionCenterGate: constructionCenterRequired
  });
  const requiredAnyBuildings = cardOnly ? [] : this._prepareRequiredBuildingRows(holding, row, index, holdingIndex, recordPath, { ...options, mode: "any" });
  const allBuildingsUnlocked = cardOnly
    ? requiredBuildingIds.every((value) => {
        const text = String(value ?? "");
        if (!text) return true;
        const match = options?.buildingLookup?.get(text)
          ?? (holding?.buildings?.list ?? []).find((item) => item.id === text || item.templateId === text || item.name === text);
        return Boolean(match && this._buildingStatus(match).value === "built");
      })
    : requiredBuildings.every((item) => item.met || !item.value);
  const anyBuildingUnlocked = requiredAnyBuildingIds.length === 0 || (cardOnly
    ? requiredAnyBuildingIds.some((value) => {
        const text = String(value ?? "");
        const match = options?.buildingLookup?.get(text)
          ?? (holding?.buildings?.list ?? []).find((item) => item.id === text || item.templateId === text || item.name === text);
        return Boolean(match && this._buildingStatus(match).value === "built");
      })
    : requiredAnyBuildings.some((item) => item.met));
  // D1-A: development and prerequisites are admission rules for a new
  // blueprint. Once an instance exists, later losses never block its build.
  const unlocked = isTemplate ? devUnlocked && allBuildingsUnlocked && anyBuildingUnlocked && buildingConstructionPrerequisitesMet(holding, row) : true;
  const showBuildProgress = status.value !== "built";
  const showProjectNeeds = false;
  const developmentDuplicate = this._isDuplicateDevelopmentBuilding?.(holding, row) ?? false;
  const materialCosts = this._prepareMaterialCosts(row, index, holdingIndex, recordPath);
  const materialCostsRequired = materialCosts.filter((item) => this._safeNumber(item.qty, 0) > 0);
  const materialAllocated = Boolean(row.materialsAllocated);
  const materialAllocationLine = materialCostsRequired.length
    ? `${materialAllocated ? "Ранее оплачено целиком; остаток списывается из предоплаты" : "Списывается целыми долями за завершённые стадии"}: ${materialCostsRequired.map((item) => `${item.qty} ${item.name || item.resourceId || "рес."}`).join(" · ")}`
    : "";
  const storageData = row.storage && typeof row.storage === "object" ? row.storage : {};
  const storageCapacity = Math.max(0, this._safeNumber(storageData.capacity, 0));
  const storageSecurity = Math.max(0, this._safeNumber(storageData.security, 0));
  const storageQuality = Math.max(0, this._safeNumber(storageData.quality, 0));
  const storageShelfLifeMultiplier = Math.max(1, this._safeNumber(storageData.shelfLifeMultiplier, 1));
  const storageProfileLabel = String(storageData.profileLabel ?? "");
  const storageProfileResourceIdsText = (storageData.profileResourceIds ?? []).join(", ");
  const storageProfileCategoryTagsText = (storageData.profileCategoryTags ?? []).join(", ");
  const storageProfileMarketTagsText = (storageData.profileMarketTags ?? []).join(", ");
  const storageProfileCapacityMultiplier = Math.max(0.01, Math.min(1, this._safeNumber(storageData.profileCapacityMultiplier, 1)));
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
  const housingOccupants = this._housingOccupants?.(holding, row, housingIndex) ?? [];
  const housingSlots = cardOnly ? null : (this._buildingHousingSlots?.(holding, row, index, housingCapacity, housingOccupants, housingIndex, options?.livingPeople) ?? []);
  const housingUsed = housingOccupants.length;
  const housingFree = housingCapacity > 0 ? Math.max(0, housingCapacity - housingUsed) : Infinity;
  const housingFillClass = housingCapacity <= 0 ? "unlimited-capacity" : (housingUsed >= housingCapacity ? "full-capacity" : (housingUsed / Math.max(1, housingCapacity) >= 0.75 ? "near-capacity" : "ok-capacity"));
  const housingFillPercent = housingCapacity <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((housingUsed / Math.max(1, housingCapacity)) * 100)));
  const medicalSummary = isMedicalBuilding ? this._medicalBuildingSummary(holding, row, workerEfficiency, options?.medicalAssignments) : null;
  if (medicalSummary) medicalSummary.maxPatientsPath = `${recordPath}.medical.maxPatients`;
  const buildingFlavorClass = isMedicalBuilding ? (specialDefinition?.cssClass || "medical-building") : "";
  const categoryOptions = cardOnly ? null : categoryOptionsAll.filter((item) => item.id !== "all").map((item) => ({
    value: item.label,
    label: item.label,
    selected: category === item.id || String(row.type ?? "") === item.label
  }));
  const selectedCrewId = String(row.constructionCrewId ?? "");
  const constructionCrews = Array.isArray(options?.constructionCrews) ? options.constructionCrews : this._constructionCrews(holding);
  const constructionCrewOptions = [{ id: "", label: "Без бригады", selected: !selectedCrewId }].concat(constructionCrews.map((crew) => ({
    id: crew.id,
    label: crew.name || "Стройбригада",
    selected: String(crew.id) === selectedCrewId
  })));
  const capitalBudget = !cardOnly && showBuildProgress ? constructionCapitalBudget(holding, row) : null;
  const costText = (costs) => costs.map((cost) => `${cost.qty} ${cost.resourceGroup || resourceLabel(cost.resourceId, cost.name)}`).join(" · ") || "—";
  const selectedCrew = constructionCrews.find((crew) => String(crew.id) === selectedCrewId);
  const crewIds = new Set([...(selectedCrew?.memberIds ?? []), selectedCrew?.leaderId].filter(Boolean));
  const crewPeople = (holding.people?.list ?? []).filter((person) => crewIds.has(person.id)
    && isResidentInPopulation(person, holding) && !person.dead && !(Number(person.injuredDays) > 0));
  const crewQd = crewPeople.reduce((sum, person) => sum + (this._isChildResident?.(person) ? 10 : 20), 0);
  const capitalLines = capitalBudget ? [
    `Уже вложено в стадии: ${costText(capitalBudget.spent)}.`,
    `Неиспользованная предоплата: ${costText(capitalBudget.prepaid)}.`,
    `Ещё требуется оплатить материалами и деньгами: ${costText(capitalBudget.unpaid)}.`,
    `После денежных строк оставшейся сметы в казне: ${capitalBudget.treasuryAfterMaterials} ММ; зарплаты и другие расходы сюда не включены.`,
    selectedCrew ? `Бригада вместе с руководителем: ${crewPeople.length} доступных жителей, до ${crewQd} обычных рабочих QD за десятник на всю её очередь. Срок завершения зависит от бросков и снабжения.`
      : "Бригада не назначена; труд и срок строительства ещё не определены.",
    "Зарплата назначенной бригады оплачивается и при нехватке материалов. Перед ходом проверьте снабжение или измените её назначения."
  ] : [];
  const visibility = row.visibility === "gm" ? "gm" : "public";
  const playerVisible = visibility !== "gm";
  const religionData = !cardOnly && row.religion && typeof row.religion === "object" ? row.religion : {};
  const religionReligious = Boolean(religionData.religious);
  const religionFaith = String(religionData.faith ?? religionData.name ?? "");
  const religionCustomFaith = String(religionData.customFaith ?? religionData.custom ?? religionData.other ?? "");
  const fuelAlternatives = Array.isArray(row?.fuelAlternatives) ? row.fuelAlternatives : [];
  const fuelChoice = String(row?.fuelChoice ?? fuelAlternatives[0]?.resourceId ?? "");
  const productionSelection = row?.productionSelection && typeof row.productionSelection === "object" ? row.productionSelection : {};

  const cleanWorkerEfficiencyTotal = cardOnly ? 0 : Math.max(0, this._safeNumber(workerEfficiency.total, 0));
  const preparedWorkerEfficiency = cardOnly ? null : {
    ...workerEfficiency,
    totalRaw: cleanWorkerEfficiencyTotal,
    total: this._formatNumber ? this._formatNumber(cleanWorkerEfficiencyTotal) : String(Math.round(cleanWorkerEfficiencyTotal * 100) / 100),
    productionEquivalentText: this._formatNumber
      ? this._formatNumber(this._safeNumber(workerEfficiency.productionEquivalent, 0))
      : String(Math.round(this._safeNumber(workerEfficiency.productionEquivalent, 0) * 100) / 100)
  };
  const formatSigned = (value) => `${value > 0 ? "+" : ""}${this._formatNumber ? this._formatNumber(value) : String(value)}`;
  const activeBonuses = isTemplate || (buildingOperationalState(row).operational && !developmentDuplicate) ? bonuses : {};
  const settlementEffects = isTemplate ? null : (options.cardSettlementEffects ?? cardSettlementEffects(this, holding));
  const cardDevParts = this._developmentParts(activeBonuses).filter((part) => this._safeNumber(part.value, 0) !== 0).map((part) => {
    const value = this._safeNumber(part.value, 0);
    return { ...part, signed: formatSigned(value), tone: value >= 0 ? "positive" : "negative" };
  });
  const cardImpactParts = [
    { key: "morale", label: "Довольство", icon: "fa-solid fa-face-smile", css: "morale", value: isTemplate ? buildingNominalMorale(row) : (settlementEffects.morale.get(String(row.id)) ?? 0) },
    { key: "reputation", label: "Репутация", icon: "fa-solid fa-crown", css: "reputation", value: isTemplate ? this._safeNumber(row.reputation, 0) : (settlementEffects.reputation.get(String(row.id)) ?? 0) }
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
              label: item.alternatives ? item.name : resourceLabel(id),
              ...(item.alternatives ? { qty: "ИЛИ", icon: "fa-solid fa-code-branch", img: "" } : {})
            };
          })
        : [];
      return {
        ...line,
        outputText: line.isWorkers && !line.formula ? `${line.outputQty} / ${line.workQd} QD` : String(line.totalPreview ?? line.cycleText ?? line.total ?? "").split(" → ")[0].trim(),
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
  const cardProductionSeasonBadges = Array.from(new Map(cardProductionRows
    .filter((line) => line.hasSeasonHint && String(line.seasonShort ?? "").trim())
    .map((line) => {
      const label = String(line.seasonShort ?? "").trim();
      const tooltip = String(line.seasonTooltip ?? "").trim() || label;
      return [`${label}\u0000${tooltip}`, { label, tooltip }];
    })).values());
  const wonderworkingRequired = (row?.workerProfile?.composition ?? []).some((item) => String(item?.group ?? "").toUpperCase() === "ЧУДОТВОРЕЦ");
  const wonderworkingActive = wonderworkingRequired && buildingWonderworkingActive(holding, row);
  const rawEffectText = String(row.effect ?? "").trim();
  const effectText = wonderworkingRequired
    ? `${wonderworkingActive ? "Чудотворство активно" : "Чудотворство неактивно: нужен назначенный Чудотворец"}. ${rawEffectText}`.trim()
    : rawEffectText;
  const notesText = String(row.notes ?? "").trim();
  const titleTooltip = [effectText, notesText].filter(Boolean).join("\n\n");
  const hasEffect = Boolean(effectText);
  const showStorageStrip = Boolean(functions.storage);
  const showHousingStrip = Boolean(functions.housing);
  const pendingProductionRows = this._pendingProductionRows(row, holding, index, productionLines);
  const hasCardBody = Boolean(cardProductionRows.length || showProjectNeeds || showBuildProgress || pendingProductionRows.length);
  const headOnly = !hasCardBody && !showStorageStrip && !showHousingStrip;
  const remainingBuildSuccesses = Math.max(0, target - progress);
  const maintenanceData = normalizeBuildingMaintenance(row.maintenance);
  const maintenanceFactor = maintenanceEfficiencyFactor(maintenanceData);

  if (cardOnly) {
    return {
      _index: index,
      id: row?.id ?? "",
      laborLegacy: buildingLaborMode(row) === "legacy",
      name: row?.name ?? "Здание",
      category,
      categoryLabel: this._buildingCategoryLabel(category),
      categoryIcon: categoryInfo?.icon ?? "fa-solid fa-building",
      flavorClass: buildingFlavorClass,
      specialKind,
      isSpecialBuilding,
      isMedicalBuilding,
      medicalSummary: medicalSummary ?? { patients: 0, capacity: 0, text: "", tooltip: "" },
      cardStatParts,
      hasCardStatParts: cardStatParts.length > 0,
      cardProductionRows,
      hasManyCardProductionRows: cardProductionRows.length > 3,
      hasCardProductionRows: cardProductionRows.length > 0,
      cardProductionSeasonBadges,
      hasCardProductionSeasonBadges: cardProductionSeasonBadges.length > 0,
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
      unlocked,
      statusLabel: status.label,
      statusClass: [status.css, developmentDuplicate ? "dev-duplicate" : ""].filter(Boolean).join(" "),
      statusIcon: status.icon,
      storage: {
        capacity: storageCapacity,
        security: storageSecurity,
        quality: storageQuality,
        shelfLifeMultiplier: storageShelfLifeMultiplier,
        used: storageRoomSummary?.used ?? 0,
        usedText: storageUsedText,
        freeText: storageFreeText,
        capacityText: storageCapacityText,
        fillClass: storageFillClass,
        fillPercent: storageFillPercent,
        fillTitle: storageRoomSummary?.fillTitle ?? "",
        hasCapacity: storageCapacity > 0
      },
      housing: {
        capacity: housingCapacity,
        comfort: buildingHousingComfort(holding, row),
        quality: housingQuality,
        used: housingUsed,
        free: housingFree,
        usedText: String(housingUsed),
        capacityText: housingCapacity > 0 ? String(housingCapacity) : "∞",
        freeText: housingCapacity > 0 ? String(housingFree) : "∞",
        fillClass: housingFillClass,
        fillPercent: housingFillPercent,
        hasCapacity: housingCapacity > 0,
        occupants: housingOccupants.map((person) => person.name || "Без имени").join(", ")
      },
      constructionCrewId: selectedCrewId,
      constructionCrewOptions,
      assignedCount,
      workersLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMin, 0))}-${maxWorkers}`,
      workerCountLine: `${assignedCount}/${maxWorkers}`,
      hasWorkerCapacity: maxWorkers > 0,
      progress,
      target,
      progressText: `${progress}/${target}`,
      remainingBuildSuccesses,
      buildActionTooltip: `Строить: один бросок бригады за десятник. Осталось стадий: ${remainingBuildSuccesses} из ${target}. ${materialAllocationLine}`.trim(),
      progressPercent: Math.max(0, Math.min(100, Math.round((progress / target) * 100))),
      isBuilt: status.value === "built",
      showProjectNeeds,
      showBuildProgress,
      requirementsText: this._devText(requirements, "Нет"),
      materialCostsLine: materialCosts.length ? materialCosts.map((item) => `${item.qty} ${item.name}`.trim()).join(" · ") : "—",
      pendingProductionRows,
      hasPendingProduction: pendingProductionRows.length > 0,
      upkeep: this._safeNumber(row.upkeep, 0),
      hasUpkeep: this._safeNumber(row.upkeep, 0) !== 0,
      upkeepLine: this._safeNumber(row.upkeep, 0) ? String(this._safeNumber(row.upkeep, 0)) : "—",
      visibility,
      playerVisible
    };
  }

  return {
    ...row,
    laborLegacy: buildingLaborMode(row) === "legacy",
    _index: index,
    category,
    categoryLabel: this._buildingCategoryLabel(category),
    categoryIcon: categoryInfo?.icon ?? "fa-solid fa-building",
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
    hasManyCardProductionRows: cardProductionRows.length > 3,
    hasCardProductionRows: cardProductionRows.length > 0,
    cardProductionSeasonBadges,
    hasCardProductionSeasonBadges: cardProductionSeasonBadges.length > 0,
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
    moraleDelta: buildingNominalMorale(row),
    reputation: this._safeNumber(row.reputation, 0),
    marketAccessLevel: Math.max(0, Math.min(4, Math.floor(this._safeNumber(row.marketAccessLevel, 0)))),
    impactParts: [
      { key: "morale", label: "Довольство", icon: "fa-solid fa-face-smile", css: "morale", value: buildingNominalMorale(row), path: `${recordPath}.${row.service?.leisure?.kind ? "service.leisure.capacity" : "moraleDelta"}` },
      { key: "reputation", label: "Репутация", icon: "fa-solid fa-crown", css: "reputation", value: this._safeNumber(row.reputation, 0), path: `${recordPath}.reputation` }
    ],
    requirementsText: this._devText(requirements, "Нет"),
    bonusesText: this._devText(bonuses, "Нет"),
    functions,
    maintenance: {
      ...maintenanceData,
      technical: maintenanceData.schemaVersion === 2,
      efficiencyFactor: maintenanceFactor,
      efficiencyPercent: Math.round(maintenanceFactor * 100),
      requiredPointsPath: `${recordPath}.maintenance.requiredPoints`,
      priorityPath: `${recordPath}.maintenance.priority`,
      needsResolutionPath: `${recordPath}.maintenance.needsResolution`
    },
    storage: {
      capacity: storageCapacity,
      security: storageSecurity,
      quality: storageQuality,
      shelfLifeMultiplier: storageShelfLifeMultiplier,
      profileLabel: storageProfileLabel,
      profileResourceIdsText: storageProfileResourceIdsText,
      profileCategoryTagsText: storageProfileCategoryTagsText,
      profileMarketTagsText: storageProfileMarketTagsText,
      profilePerishableFood: storageData.profilePerishableFood === true,
      autoReceive: storageData.autoReceive === true,
      autoReceivePath: `${recordPath}.storage.autoReceive`,
      profileCapacityMultiplier: storageProfileCapacityMultiplier,
      profileRequiresStaff: storageData.profileRequiresStaff === true,
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
      qualityPath: `${recordPath}.storage.quality`,
      shelfLifeMultiplierPath: `${recordPath}.storage.shelfLifeMultiplier`,
      profileLabelPath: `${recordPath}.storage.profileLabel`,
      profileResourceIdsPath: `${recordPath}.storage.profileResourceIds`,
      profileCategoryTagsPath: `${recordPath}.storage.profileCategoryTags`,
      profileMarketTagsPath: `${recordPath}.storage.profileMarketTags`,
      profilePerishableFoodPath: `${recordPath}.storage.profilePerishableFood`,
      profileCapacityMultiplierPath: `${recordPath}.storage.profileCapacityMultiplier`,
      profileRequiresStaffPath: `${recordPath}.storage.profileRequiresStaff`
    },
    housing: {
      capacity: housingCapacity,
      comfort: housingComfort,
      effectiveComfort: buildingHousingComfort(holding, row),
      hasCaretakerComfort: Number.isFinite(housingData.staffedComfort) && housingData.staffedComfort !== housingComfort,
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
    fuel: {
      enabled: fuelAlternatives.length > 0,
      choice: fuelChoice,
      choicePath: `${recordPath}.fuelChoice`,
      options: fuelAlternatives.map((alternative) => {
        const resourceId = String(alternative?.resourceId ?? "");
        const qty = Math.max(1, Math.ceil(this._safeNumber(alternative?.qty, 1)));
        return {
          value: resourceId,
          label: String(alternative?.label ?? "").trim() || `${resourceLabel(resourceId)} × ${qty} / десятник`,
          selected: resourceId === fuelChoice
        };
      })
    },
    functionOptions: this._functionOptions(row, index, holdingIndex, recordPath),
    showProductionBlock: !isSpecialBuilding && Boolean(functions.production) && !agricultureView,
    hasAgriculture: !isSpecialBuilding && Boolean(agricultureView),
    hasLivestock: !isSpecialBuilding && Boolean(livestockView),
    showIncomeBlock: !isSpecialBuilding && Boolean(functions.income),
    showDefenseBlock: !isSpecialBuilding && Boolean(functions.defense),
    showHousingBlock: !isSpecialBuilding && Boolean(functions.housing),
    unlocked,
    unlockLabel: unlocked ? "Открыто" : "Не открыто",
    statusLabel: status.label,
    statusClass: [status.css, developmentDuplicate ? "dev-duplicate" : ""].filter(Boolean).join(" "),
    statusIcon: status.icon,
    developmentDuplicate,
    developmentUniqueText: developmentDuplicate ? "Повторное здание: развитие не дублируется" : "Уникальный вклад развития",
    statusOptions: this._buildingStatusOptions(status.value),
    lifecycleLabel: this._buildingLifecycleOptions(status.lifecycle).find((item) => item.selected)?.label ?? status.lifecycle,
    lifecycleOptions: this._buildingLifecycleOptions(status.lifecycle),
    conditionLabel: this._buildingConditionOptions(status.condition).find((item) => item.selected)?.label ?? status.condition,
    conditionOptions: this._buildingConditionOptions(status.condition),
    repairActive: status.repairActive,
    constructionStatus: row.constructionStatus || status.value,
    constructionCrewId: selectedCrewId,
    visibility,
    playerVisible,
    visibilityText: playerVisible ? "видно игрокам" : "скрыто от игроков",
    constructionCrewOptions,
    workerSlots,
    plannedWorkerRows,
    hasPlannedWorkers: plannedWorkerRows.length > 0,
    assignedCount,
    workersLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMin, 0))}-${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    workerCountLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    hasWorkerCapacity: Math.max(0, this._safeNumber(row.workersMax, 0)) > 0,
    progress,
    target,
    progressText: `${progress}/${target}`,
    remainingBuildSuccesses,
    buildActionTooltip: `Строить: один бросок бригады за десятник. Осталось стадий: ${remainingBuildSuccesses} из ${target}. ${materialAllocationLine}`.trim(),
    progressPercent: Math.max(0, Math.min(100, Math.round((progress / target) * 100))),
    isBuilt: status.value === "built",
    showProjectNeeds,
    showBuildProgress,
    productionLine: this._productionLine(row, holding, productionLines),
    contents: this._prepareBuildingContents(row, index, holding, holdingIndex, recordPath),
    hasContents: Array.isArray(row.contents) && row.contents.length > 0,
    productionLines,
    hasProductionLines: productionLines.length > 0,
    productionSelection: {
      exclusive: productionSelection.exclusive === true,
      gmConfirmed: productionSelection.gmConfirmed === true,
      exclusivePath: `${recordPath}.productionSelection.exclusive`,
      gmConfirmedPath: `${recordPath}.productionSelection.gmConfirmed`
    },
    productionLinesText: this._productionLinesText(row, holding, productionLines),
    pendingProductionRows,
    hasPendingProduction: pendingProductionRows.length > 0,
    productionSummary: this._buildingProductionSummary(row, assignedCount, holding, workerContext, workerEfficiency),
    agricultureView,
    livestockView,
    income: incomeSummary,
    incomeSummary,
    defense: defenseSummary,
    defenseSummary,
    workerEfficiency: preparedWorkerEfficiency,
    workerProfileSummary,
    modifierLine: String(row.modifiers ?? "").trim() || "—",
    workerRoleLine: String(row.workerRole ?? "").trim() || "—",
    upkeep: this._safeNumber(row.upkeep, 0),
    hasUpkeep: this._safeNumber(row.upkeep, 0) !== 0,
    upkeepLine: this._safeNumber(row.upkeep, 0) ? String(this._safeNumber(row.upkeep, 0)) : "—",
    wageDailyCopper: Math.max(0, Math.floor(this._safeNumber(row.wageDailyCopper, 0))),
    baseUpkeepMonthlyCopper: Math.max(0, Math.floor(this._safeNumber(row.baseUpkeepMonthlyCopper, 0))),
    operatingUpkeepMonthlyCopper: Math.max(0, Math.floor(this._safeNumber(row.operatingUpkeepMonthlyCopper, 0))),
    materialCosts,
    materialCostsLine: materialCosts.length ? materialCosts.map((item) => `${item.qty} ${item.name}`.trim()).join(" · ") : "—",
    materialCostsRequired,
    capitalLines,
    materialAllocated,
    materialAllocationLine,
    requiredBuildings,
    requiredBuildingsLine: requiredBuildings.length ? requiredBuildings.map((item) => item.label).join(" · ") : "—",
    requiredAnyBuildings,
    requiredAnyBuildingsLine: requiredAnyBuildings.length ? requiredAnyBuildings.map((item) => item.label).join(" · ") : "—",
    constructionCenterRequired,
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
  return buildingOperationalState(building);
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

_buildingLifecycleOptions(current) {
  return [
    { value: "planned", label: "Проект", selected: current === "planned" },
    { value: "building", label: "Строится", selected: current === "building" },
    { value: "active", label: "Действует", selected: current === "active" },
    { value: "disabled", label: "Не действует", selected: current === "disabled" },
    { value: "abandoned", label: "Заброшено", selected: current === "abandoned" }
  ];
},

_buildingConditionOptions(current) {
  return [
    { value: "intact", label: "Целое", selected: current === "intact" },
    { value: "damaged", label: "Повреждено", selected: current === "damaged" },
    { value: "heavilyDamaged", label: "Сильно повреждено", selected: current === "heavilyDamaged" },
    { value: "destroyed", label: "Разрушено", selected: current === "destroyed" }
  ];
},

_buildingHousingSlots(holding, building, buildingIndex, capacity = null, occupantsArg = null, housingIndex = null, livingPeopleArg = null) {
  const buildingId = String(building?.id ?? "");
  const people = (Array.isArray(livingPeopleArg) ? livingPeopleArg : (holding?.people?.list ?? []))
    .filter((person) => isResidentInPopulation(person, holding));
  const peopleById = new Map(people.map((person) => [String(person?.id ?? ""), person]));
  const occupants = Array.isArray(occupantsArg) ? occupantsArg : (this._housingOccupants?.(holding, building, housingIndex) ?? []);
  const selectedIds = occupants.map((person) => String(person?.id ?? "")).filter(Boolean);
  const selectedSet = new Set(selectedIds);
  const cap = Math.max(0, this._safeNumber(capacity ?? building?.housing?.capacity, 0));
  const slotCount = cap > 0 ? Math.max(cap, selectedIds.length) : Math.max(1, selectedIds.length + 1);
  const slots = [];
  for (let slot = 0; slot < slotCount; slot += 1) {
    const selectedId = String(selectedIds[slot] ?? "");
    const selectedPerson = peopleById.get(selectedId);
    const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
    for (const person of people) {
      const personId = String(person?.id ?? "");
      if (!personId) continue;
      const home = String(person?.home ?? "");
      const alreadyHere = selectedSet.has(personId) && personId !== selectedId;
      if (alreadyHere) continue;
      const currentHome = this._homeLabel?.(person, holding, housingIndex) ?? home;
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

_buildingWorkerSlots(holding, building, buildingIndex, workerContext = null, basePathArg = "", canEdit = true) {
  const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
  const staffingFull = buildingStaffingWorkerIds(holding, building?.id).length >= max;
  const assigned = Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [];
  const people = Array.from(workerContext?.activePeopleById?.values?.() ?? (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0));
  const peopleById = workerContext?.activePeopleById ?? new Map(people.map((person) => [String(person?.id ?? ""), person]));
  const occupied = workerContext?.assignedWorkerIds ? new Set(workerContext.assignedWorkerIds) : this._assignedWorkerSet(holding, building?.id);
  if (workerContext?.assignedWorkerIds) {
    for (const id of assigned) if (id) occupied.delete(String(id));
  }
  const basePath = basePathArg || `holdings.${this._holdingIndex(holding)}.buildings.list.${buildingIndex}`;
  const slots = [];
  let emptySlotAdded = false;
  for (let slot = 0; slot < max; slot += 1) {
    const rawSelectedId = String(assigned[slot] ?? "");
    const selectedPerson = peopleById.get(rawSelectedId);
    const selectedId = selectedPerson ? rawSelectedId : "";
    if (!selectedId) {
      if (!canEdit || emptySlotAdded || staffingFull) continue;
      emptySlotAdded = true;
    }
    const options = [{ id: "", name: "Пусто", selected: !selectedId, disabled: false, hint: "" }];
    for (const person of people) {
      const personId = String(person.id ?? "");
      if (!personId) continue;
      const alreadyElsewhere = occupied.has(personId) && personId !== selectedId;
      if (alreadyElsewhere) continue;
      if (this._canResidentWork && !this._canResidentWork(person, holding) && personId !== selectedId) continue;
      const admission = this._buildingWorkerAdmission?.(building, person) ?? { eligible: true, hard: false, overridden: false, text: "—" };
      const efficiency = this._workerEfficiencyForPerson?.(holding, building, person);
      const qualification = efficiency?.details?.length ? efficiency.details.join(", ") : "без производственного бонуса";
      const admissionHint = admission.eligible
        ? "допуск выполнен"
        : (admission.overridden ? "GM-допуск" : (admission.hard ? `нет допуска: ${admission.text}` : `рекомендация: ${admission.text}`));
      options.push({
        id: personId,
        name: person.name || "Без имени",
        selected: personId === selectedId,
        disabled: admission.hard && !admission.eligible && !admission.overridden && !game.user?.isGM,
        hint: `${this._workerType(person)} · ${admissionHint} · ${qualification}`
      });
    }
    slots.push({
      slot,
      slotNo: slot + 1,
      label: selectedPerson?.name ?? "Пусто",
      selectedId,
      path: `${basePath}.assignedWorkerIds.${slot}`,
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
