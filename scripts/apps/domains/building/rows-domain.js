// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { splitList } from "../../../core/helpers.js";
import { normalizeResourceId, resourceDef, resourceIcon, resourceImage, resourceLabel } from "../../../core/resources.js";
import { inferBuildingSpecialKind, isMedicalBuilding, SPECIAL_BUILDING_KINDS } from "../../../core/building-specials.js";
import { buildingOperationalState } from "../../../core/building-state.js";
import { enterpriseCapitalState as getEnterpriseCapitalState } from "../../../core/enterprise-capital.js";
import { buildingMaintenanceClassOptions, buildingMaintenanceState } from "../../../core/building-maintenance.js";
import { validConstructionReservation } from "../../../engines/economy/construction-reservation.js";

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

export function structuralMaterialCapitalCopper(materialCosts = [], { safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
} } = {}) {
  return (Array.isArray(materialCosts) ? materialCosts : []).reduce((sum, item) => {
    const quantity = Math.max(0, safeNumber(item?.qty, 0));
    const referencePrice = Number(resourceDef(item?.resourceId, item?.name)?.referencePriceCopper);
    const unitPrice = Number.isFinite(referencePrice) && referencePrice > 0 ? Math.floor(referencePrice) : 0;
    return sum + quantity * unitPrice;
  }, 0);
}

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
  const visibleRows = sourceRows
    .map((row, index) => ({ row, index }))
    .filter((entry) => game.user?.isGM || entry.row?.visibility !== "gm" || String(entry.row?.templateId ?? "").trim());
  const storageRooms = this._storageRooms?.(holding, { includeUnavailable: true }) ?? [];
  const dataForTemplateLookup = this._contextData ?? SkyholdData.get();
  const workerContext = options?.workerContext ?? this._economyWorkerContext?.(holding) ?? null;
  const housingIndex = this._residentHousingIndex?.(holding) ?? null;
  const prepareOptions = {
    holdingIndex: this._holdingIndex(holding),
    workerContext,
    housingIndex,
    livingPeople: (holding?.people?.list ?? []).filter((person) => !person?.dead),
    development: (holding?.id && this._contextHoldingId === holding.id ? this._contextDevelopment : null) ?? this._developmentSummary(holding),
    categoryOptions: this._buildingCategoryOptions(),
    constructionCrews: this._constructionCrews(holding),
    medicalAssignments: sourceRows.some((row) => this._isMedicalBuildingRecord(row)) ? this._medicalAssignments(holding, workerContext) : null,
    templateLookup: buildingTemplateLookup(dataForTemplateLookup)
  };
  const prepared = visibleRows.map((entry) => this._prepareBuildingRow(holding, entry.row, entry.index, canEdit, storageRooms, prepareOptions));
  const category = this.activeBuildingCategory || "all";
  return category === "all" ? prepared : prepared.filter((row) => row.category === category);
},

_prepareBuildingRow(holding, row, index, canEdit, storageRoomsArg = null, options = {}) {
  const holdingIndex = Number.isInteger(options?.holdingIndex) ? options.holdingIndex : this._holdingIndex(holding);
  const recordPath = options?.basePath || `holdings.${holdingIndex}.buildings.list.${index}`;
  const isTemplate = Boolean(options?.isTemplate);
  const development = options?.development ?? this._developmentSummary(holding);
  const requirements = this._devObject(row.requirements);
  const bonuses = this._devObject(row.bonuses);
  const functions = this._buildingFunctions(row);
  const workerContext = options?.workerContext ?? null;
  const housingIndex = options?.housingIndex ?? null;
  const workerEfficiency = this._buildingEffectiveWorkers(holding, row, workerContext);
  const status = this._buildingStatus(row);
  const workerSlots = this._buildingWorkerSlots(holding, row, index, workerContext, recordPath);
  const assignedCount = workerSlots.filter((slot) => slot.selectedId).length;
  const productionLines = this._prepareProductionLines(row, index, holding, storageRoomsArg, holdingIndex, recordPath);
  const incomeSummary = this._buildingIncomeSummary(row, holding, workerContext, workerEfficiency);
  const defenseSummary = this._buildingDefenseSummary(row, holding, workerContext, status, workerEfficiency);
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
    templateSource = (dataForTemplateLookup?.catalog?.buildings ?? []).find((item) => {
      if (templateKey && String(item?.id ?? "").trim().toLowerCase() === templateKey) return true;
      return rowNameKey && String(item?.name ?? "").trim().toLowerCase() === rowNameKey;
    }) ?? null;
  }
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
  const landRightsProvided = Boolean(holding?.gm?.economy?.landRightsProvided);
  const capitalState = getEnterpriseCapitalState(
    row,
    (value, fallback = 0) => this._safeNumber(value, fallback),
    { landRightsProvided }
  );
  const structuralCapitalCopper = structuralMaterialCapitalCopper(materialCostsRequired, {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback)
  });
  const fullCashCapitalCopper = structuralCapitalCopper + capitalState.requiredCopper;
  const fullReferenceCapitalCopper = structuralCapitalCopper + capitalState.nominalRequiredCopper;
  const treasuryCopper = Math.max(0, this._safeNumber(holding?.storage?.moneyCopper, 0));
  const fundAmountCopper = Math.min(treasuryCopper, capitalState.shortfallCopper);
  const canConfigureCapital = canEdit && Boolean(globalThis.game?.user?.isGM);
  const canManageFunding = canConfigureCapital && !isTemplate;
  const manualFundingEditable = canManageFunding && ["manual", "legacy"].includes(capitalState.fundingProvenance) && !capitalState.grandfathered;
  const fundingProvenanceLabels = {
    treasury: "Казна",
    manual: "Ручная сверка ГМ",
    legacy: "Legacy — требуется сверка",
    mixed: "Смешанное финансирование",
    "legacy-grandfathered": "Legacy — готовность сохранена"
  };
  const enterpriseCapital = {
    ...capitalState,
    structuralCapitalCopper,
    fullCashCapitalCopper,
    fullReferenceCapitalCopper,
    treasuryCopper,
    fundAmountCopper,
    requiresCapital: capitalState.enabled && capitalState.nominalRequiredCopper > 0,
    landRightsProvided,
    canConfigureCapital,
    canManageFunding,
    manualFundingEditable,
    hasLegacyFunded: capitalState.legacyFundedCopper > 0,
    canChangeFundingMode: canManageFunding && !capitalState.grandfathered,
    canFund: canManageFunding
      && capitalState.enabled
      && !capitalState.legacyFundingNeedsReview
      && capitalState.shortfallCopper > 0
      && fundAmountCopper > 0,
    stateLabel: !capitalState.enabled
      ? "Не учитывается"
      : (capitalState.grandfathered
        ? "Legacy: введено"
        : (capitalState.ready
          ? "Готово"
          : (capitalState.legacyFundingNeedsReview
            ? "Нужна сверка legacy"
            : (!capitalState.landRightReady && capitalState.shortfallCopper <= 0 ? "Нужно право" : "Не готово")))),
    stateClass: !capitalState.enabled ? "muted" : (capitalState.ready ? "positive" : "negative"),
    fundedPercentText: `${this._formatNumber(capitalState.fundedPercent)}%`,
    landText: this._formatCopperCurrency(capitalState.landCopper),
    equipmentText: this._formatCopperCurrency(capitalState.equipmentCopper),
    workingCapitalText: this._formatCopperCurrency(capitalState.workingCapitalCopper),
    requiredText: this._formatCopperCurrency(capitalState.requiredCopper),
    nominalRequiredText: this._formatCopperCurrency(capitalState.nominalRequiredCopper),
    commissioningPaidText: this._formatCopperCurrency(capitalState.commissioningPaidCopper),
    commissioningShortfallText: this._formatCopperCurrency(capitalState.commissioningShortfallCopper),
    reserveText: this._formatCopperCurrency(capitalState.workingCapitalReserveCopper),
    reserveShortfallText: this._formatCopperCurrency(capitalState.reserveShortfallCopper),
    committedText: this._formatCopperCurrency(capitalState.committedCopper),
    legacyFundedText: this._formatCopperCurrency(capitalState.legacyFundedCopper),
    shortfallText: this._formatCopperCurrency(capitalState.shortfallCopper),
    structuralText: this._formatCopperCurrency(structuralCapitalCopper),
    fullCashCapitalText: this._formatCopperCurrency(fullCashCapitalCopper),
    fullReferenceCapitalText: this._formatCopperCurrency(fullReferenceCapitalCopper),
    annualRenewalText: this._formatCopperCurrency(capitalState.annualRenewalCopper),
    treasuryText: this._formatCopperCurrency(treasuryCopper),
    fundAmountText: this._formatCopperCurrency(fundAmountCopper),
    landRightLabel: capitalState.landRightRequired
      ? (capitalState.landRightReady ? "Право предоставлено" : "Право не предоставлено")
      : "Отдельное право не требуется",
    commissioningStatusText: capitalState.grandfathered
      ? "Legacy-ввод признан"
      : (capitalState.commissioningReady ? "Ввод оплачен" : `Не хватает ${this._formatCopperCurrency(capitalState.commissioningShortfallCopper)}`),
    reserveStatusText: capitalState.grandfathered
      ? "Резерв не создавался"
      : (capitalState.reserveReady ? "Резерв собран" : `Не хватает ${this._formatCopperCurrency(capitalState.reserveShortfallCopper)}`),
    fundingProvenanceLabel: fundingProvenanceLabels[capitalState.fundingProvenance] ?? capitalState.fundingProvenance,
    fundingProvenanceOptions: [
      { value: "treasury", label: "Казна — только атомарная операция", selected: capitalState.fundingProvenance === "treasury" },
      { value: "manual", label: "Ручная сверка ГМ — казна не меняется", selected: capitalState.fundingProvenance === "manual" },
      ...(capitalState.fundingProvenance === "legacy" ? [{ value: "legacy", label: "Legacy — распределить старое fundedCopper", selected: true }] : []),
      ...(capitalState.fundingProvenance === "mixed" ? [{ value: "mixed", label: "Смешанное — ручная сверка + казна", selected: true }] : [])
    ],
    enabledPath: `${recordPath}.enterpriseCapital.enabled`,
    landPath: `${recordPath}.enterpriseCapital.landCopper`,
    equipmentPath: `${recordPath}.enterpriseCapital.equipmentCopper`,
    workingCapitalPath: `${recordPath}.enterpriseCapital.workingCapitalCopper`,
    commissioningPaidPath: `${recordPath}.enterpriseCapital.commissioningPaidCopper`,
    reservePath: `${recordPath}.enterpriseCapital.workingCapitalReserveCopper`,
    fundingProvenancePath: `${recordPath}.enterpriseCapital.fundingProvenance`,
    renewalPercentPath: `${recordPath}.enterpriseCapital.renewalPercentAnnual`,
    notesPath: `${recordPath}.enterpriseCapital.notes`
  };
  const hasConstructionReservation = validConstructionReservation(row);
  const hasInvalidConstructionReservation = Boolean(row?.constructionReservation) && !hasConstructionReservation;
  const hasLegacyMaterialAllocation = !row?.constructionReservation && Boolean(row.materialsAllocated);
  const materialAllocated = hasConstructionReservation || hasLegacyMaterialAllocation;
  const hasFractionalMaterialRecipe = materialCosts.some((item) => item.quantityBlocked);
  const canAllocateMaterials = status.value !== "built" && materialCostsRequired.length > 0 && !materialAllocated && !hasFractionalMaterialRecipe;
  const reservedRecipe = hasConstructionReservation ? row.constructionReservation.recipe : [];
  const allocationRecipe = reservedRecipe.length ? reservedRecipe : materialCostsRequired;
  const materialAllocationLine = allocationRecipe.length
    ? `${materialAllocated ? "Выделено" : "Нужно"}: ${allocationRecipe.map((item) => `${item.qty} ${item.name || item.resourceId || "рес."}`).join(" · ")}`
    : "";
  const constructionReservationSourceLine = hasConstructionReservation
    ? row.constructionReservation.sources.map((source) => `${source.qty} ${source.name || source.resourceId || "рес."} · ${source.roomId || "склад"}`).join("; ")
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
  const housingOccupants = this._housingOccupants?.(holding, row, housingIndex) ?? [];
  const housingSlots = this._buildingHousingSlots?.(holding, row, index, housingCapacity, housingOccupants, housingIndex, options?.livingPeople) ?? [];
  const housingUsed = housingOccupants.length;
  const housingFree = housingCapacity > 0 ? Math.max(0, housingCapacity - housingUsed) : Infinity;
  const housingFillClass = housingCapacity <= 0 ? "unlimited-capacity" : (housingUsed >= housingCapacity ? "full-capacity" : (housingUsed / Math.max(1, housingCapacity) >= 0.75 ? "near-capacity" : "ok-capacity"));
  const housingFillPercent = housingCapacity <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((housingUsed / Math.max(1, housingCapacity)) * 100)));
  const specialKind = this._buildingSpecialKind(row);
  const isSpecialBuilding = Boolean(specialKind);
  const specialDefinition = specialKind ? SPECIAL_BUILDING_KINDS[specialKind] : null;
  const isMedicalBuilding = specialKind === "medical";
  const medicalSummary = isMedicalBuilding ? this._medicalBuildingSummary(holding, row, workerEfficiency, options?.medicalAssignments) : null;
  if (medicalSummary) medicalSummary.maxPatientsPath = `${recordPath}.medical.maxPatients`;
  const buildingFlavorClass = isMedicalBuilding ? (specialDefinition?.cssClass || "medical-building") : "";
  const categoryOptions = categoryOptionsAll.filter((item) => item.id !== "all").map((item) => ({
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
  const activeProductionLines = productionLines.filter((line) => line.active);
  const productionOverview = {
    totalLines: productionLines.length,
    activeLines: activeProductionLines.length,
    inactiveLines: productionLines.length - activeProductionLines.length,
    contents: Array.isArray(row?.contents) ? row.contents.length : 0,
    workerLines: activeProductionLines.filter((line) => line.isWorkers).length,
    timedLines: activeProductionLines.filter((line) => line.isTime).length,
    contentLines: activeProductionLines.filter((line) => line.isContent).length,
    pendingLines: activeProductionLines.filter((line) => line.hasPending).length,
    wipLines: activeProductionLines.filter((line) => line.hasWorkInProgress).length,
    workerEfficiencyText: preparedWorkerEfficiency.total
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
  const cardProductionSeasonBadges = Array.from(new Map(cardProductionRows
    .filter((line) => line.hasSeasonHint && String(line.seasonShort ?? "").trim())
    .map((line) => {
      const label = String(line.seasonShort ?? "").trim();
      const tooltip = String(line.seasonTooltip ?? "").trim() || label;
      return [`${label}\u0000${tooltip}`, { label, tooltip }];
    })).values());
  const effectText = String(row.effect ?? "").trim();
  const notesText = String(row.notes ?? "").trim();
  const titleTooltip = [effectText, notesText].filter(Boolean).join("\n\n");
  const hasEffect = Boolean(effectText);
  const showStorageStrip = Boolean(functions.storage);
  const showHousingStrip = Boolean(functions.housing);
  const pendingProductionRows = this._pendingProductionRows(row, holding, index, productionLines);
  const hasCardBody = Boolean(cardProductionRows.length || showProjectNeeds || showBuildProgress || pendingProductionRows.length);
  const headOnly = !hasCardBody && !showStorageStrip && !showHousingStrip;
  const workerPrimaryAttributeOptions = this._workerPrimaryAttributeOptions(row.workerPrimaryAttribute);
  const remainingBuildSuccesses = Math.max(0, target - progress);
  const maintenance = buildingMaintenanceState(row, (value, fallback = 0) => this._safeNumber(value, fallback));
  const maintenanceClassOptions = buildingMaintenanceClassOptions(maintenance.class);

  return {
    ...row,
    _index: index,
    economyPriority: index + 1,
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
    moraleDelta: this._safeNumber(row.moraleDelta, 0),
    reputation: this._safeNumber(row.reputation, 0),
    marketAccessLevel: Math.max(0, Math.min(4, Math.floor(this._safeNumber(row.marketAccessLevel, 0)))),
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
      occupantRows: housingOccupants.map((person) => ({
        id: String(person?.id ?? ""),
        name: person?.name || "Без имени"
      })),
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
    assignedCount,
    workersLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMin, 0))}-${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    workerCountLine: `${assignedCount}/${Math.max(0, this._safeNumber(row.workersMax, 0))}`,
    hasWorkerCapacity: Math.max(0, this._safeNumber(row.workersMax, 0)) > 0,
    progress,
    target,
    progressText: `${progress}/${target}`,
    remainingBuildSuccesses,
    buildActionTooltip: `Строить. Осталось успехов: ${remainingBuildSuccesses} из ${target}`,
    progressPercent: Math.max(0, Math.min(100, Math.round((progress / target) * 100))),
    isBuilt: status.value === "built",
    showProjectNeeds,
    showBuildProgress,
    productionLine: this._productionLine(row, holding, productionLines),
    contents: this._prepareBuildingContents(row, index, holding, holdingIndex, recordPath),
    hasContents: Array.isArray(row.contents) && row.contents.length > 0,
    productionLines,
    hasProductionLines: productionLines.length > 0,
    productionOverview,
    productionLinesText: this._productionLinesText(row, holding, productionLines),
    pendingProductionRows,
    hasPendingProduction: pendingProductionRows.length > 0,
    productionSummary: this._buildingProductionSummary(row, assignedCount, holding, workerContext, workerEfficiency),
    income: incomeSummary,
    incomeSummary,
    enterpriseCapital,
    defense: defenseSummary,
    defenseSummary,
    workerEfficiency: preparedWorkerEfficiency,
    modifierLine: String(row.modifiers ?? "").trim() || "—",
    workerRoleLine: String(row.workerRole ?? "").trim() || "—",
    suitableLine: String(row.suitableWorkerTypes ?? "").trim() || "—",
    suitableTypeOptions: this._workerTypeSelectOptions(row.suitableWorkerTypes),
    workerPrimaryAttributeOptions,
    workerPrimaryAttributeLabel: workerPrimaryAttributeOptions.find((item) => item.selected)?.label ?? "—",
    suitableTypeBadges: this._suitableTypeBadges(row.suitableWorkerTypes, `${recordPath}.suitableWorkerTypes`, row),
    hasSuitableTypeBadges: splitList(row.suitableWorkerTypes).length > 0,
    maintenance: {
      ...maintenance,
      classLabel: maintenanceClassOptions.find((item) => item.selected)?.label ?? "Пользовательское",
      classOptions: maintenanceClassOptions,
      classPath: `${recordPath}.maintenance.class`,
      operatingPath: `${recordPath}.maintenance.operatingCopperMonthly`,
      reservePath: `${recordPath}.maintenance.repairReserveCopperMonthly`,
      notesPath: `${recordPath}.maintenance.notes`
    },
    upkeep: maintenance.totalCopperMonthly,
    hasUpkeep: maintenance.totalCopperMonthly !== 0,
    upkeepLine: maintenance.totalCopperMonthly ? String(maintenance.totalCopperMonthly) : "—",
    materialCosts,
    materialCostsLine: materialCosts.length ? materialCosts.map((item) => `${item.qty} ${item.name}`.trim()).join(" · ") : "—",
    materialCostsRequired,
    materialAllocated,
    hasConstructionReservation,
    hasInvalidConstructionReservation,
    hasLegacyMaterialAllocation,
    hasFractionalMaterialRecipe,
    canEditMaterialRecipe: canEdit && (isTemplate || !materialAllocated),
    constructionReservationSourceLine,
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
  const people = Array.isArray(livingPeopleArg) ? livingPeopleArg : (holding?.people?.list ?? []).filter((person) => !person?.dead);
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

_buildingWorkerSlots(holding, building, buildingIndex, workerContext = null, basePathArg = "") {
  const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
  const assigned = Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [];
  const people = Array.from(workerContext?.activePeopleById?.values?.() ?? (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0));
  const peopleById = workerContext?.activePeopleById ?? new Map(people.map((person) => [String(person?.id ?? ""), person]));
  const occupied = workerContext?.assignedWorkerIds ? new Set(workerContext.assignedWorkerIds) : this._assignedWorkerSet(holding, building?.id);
  if (workerContext?.assignedWorkerIds) {
    for (const id of assigned) if (id) occupied.delete(String(id));
  }
  const basePath = basePathArg || `holdings.${this._holdingIndex(holding)}.buildings.list.${buildingIndex}`;
  const slots = [];
  for (let slot = 0; slot < max; slot += 1) {
    const rawSelectedId = String(assigned[slot] ?? "");
    const selectedPerson = peopleById.get(rawSelectedId);
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
