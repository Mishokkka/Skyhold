// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { rollD6Pool } from "../../../core/helpers.js";
import { advanceBuildingProject, buildingOperationalState } from "../../../core/building-state.js";
import { upkeepOperationalFactor } from "../../../core/building-maintenance.js";
import { enterpriseCapitalReady, enterpriseCapitalState } from "../../../core/enterprise-capital.js";
import { evaluateArithmeticExpression, rollInlineDice } from "../../../core/formula.js";
import {
  allResourceDefs,
  normalizeResourceId,
  resourceDef,
  resourceLabel
} from "../../../core/resources.js";
import {
  summarizeConstructionReport,
  summarizeCapitalReport,
  summarizeEconomyReport,
  summarizeFoodReport,
  summarizeServicesReport,
  summarizeSignedLines,
  summarizeSkippedLines,
  summarizeTradeReport,
  summarizeTreasuryReport
} from "../../../engines/economy/report.js";
import { runConstruction } from "../../../engines/economy/construction.js";
import { validConstructionReservation } from "../../../engines/economy/construction-reservation.js";
import { foodValueForResource, isFoodResource, runFoodConsumption, totalBoardFoodDaily, totalHoldingFoodPersonDays, usesStandardRationUnits } from "../../../engines/economy/food-consumption.js";
import { effectiveConsumerRationPoints } from "../../../engines/resource-ration-points.js";
import { evaluateFoodReserve, nextGrainHarvest } from "../../../engines/economy/harvest-reserve.js";
import { runHospitalityServices } from "../../../engines/economy/hospitality-service.js";
import { residentMealCapacitySnapshot } from "../../../engines/economy/resident-meal-capacity.js";
import { settleResidentFood } from "../../../engines/economy/resident-food-allocation.js";
import { runProductionCycle } from "../../../engines/economy/production-cycle.js";
import { runTrade } from "../../../engines/economy/trade.js";
import { foundryRollClass } from "../../../integrations/foundry-runtime.js";
import { runTreasuryCosts } from "../../../engines/economy/treasury-costs.js";
import { appendEconomyLedger, economyLedgerTotals, normalizeEconomyLedger } from "../../../engines/economy/ledger.js";
import { advanceMarketShipments } from "../../../engines/market/shipment.js";
import { advanceMarketExports } from "../../../engines/market/export-runtime.js";
import { createMarketExportLiquidityDemandAdapter } from "../../../engines/market/export-liquidity-adapter.js";
import { advanceFleetToQd } from "../../../engines/fleet/enterprise.js";
import { addCalendariaQd, getCalendariaSeasonSnapshot, getCalendariaSnapshot } from "../../../integrations/calendaria-bridge.js";
import { clone } from "../../../data/utils.js";
import { appendHoldingOperation } from "../../../data/operations.js";
import { productionCadenceWindow } from "../../../core/production-cadence.js";
import { isWholeEconomyQuantity, productionRecipeBlockerText, validateProductionRecipe } from "../../../core/economy-quantity-contract.js";
import { ALBUGRIR_QD_PER_DAY, albugrirCalendarDay } from "../../../core/albugrir-calendar.js";
import { compensationContractWarning, isFixedWageCompensation, personCashWageDaily } from "../../../core/compensation.js";
import { foodProvisionDaily, foodProvisionReadiness } from "../../../data/food-provision.js";
import {
  normalizeRationBuffer,
  normalizeRationBufferEntry,
  rationBufferEntryKey,
  totalRationBufferPoints
} from "../../../data/ration-buffer.js";
import { buildTendayLaborPool, reserveLabor, spendLabor } from "../../../engines/labor/labor-pool.js";
import { assessNextTendayLabor } from "../../../engines/labor/labor-consequences.js";
import { employmentContractState, employmentTendayStatement } from "../../../data/labor/employment-terms.js";
import {
  calculateEnterpriseSharePayouts,
  normalizePayrollState,
  settlePayroll,
  validateEnterpriseShareContracts
} from "../../../engines/labor/payroll.js";

function laborPoolForHolding(holding = {}) {
  const parsed = Number(holding?.gm?.calendaria?.lastQd);
  const lastQd = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  const targetQd = lastQd + 40;
  const calendar = holding?.gm?.calendaria ?? {};
  let targetSeason = "";
  try {
    const targetDateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object"
      ? addCalendariaQd(calendar.lastDateTime, 40)
      : null;
    targetSeason = String(getCalendariaSeasonSnapshot(targetDateTime, calendar.lastDateText ?? calendar.lastDateKey)?.season?.key ?? "").trim().toLowerCase();
  } catch (_error) {
    targetSeason = "";
  }
  if (!targetSeason) {
    targetSeason = String(albugrirCalendarDay(Math.ceil(Math.max(1, targetQd) / ALBUGRIR_QD_PER_DAY))?.technicalSeasonKey ?? "").trim().toLowerCase();
  }
  const accounts = normalizePayrollState(holding?.gm?.economy?.labor?.payroll).accounts;
  return buildTendayLaborPool(holding, {
    startQd: lastQd + 1,
    capacityForResident: (person, { residentId, defaultAvailability }) => {
      if (defaultAvailability.capacityQd <= 0) return defaultAvailability;
      if (isFixedWageCompensation(person?.compensationType)) {
        const contractOptions = { currentQd: targetQd, season: targetSeason };
        const contract = employmentContractState(person, contractOptions);
        const temporalContract = contract.reason === "missing-wage-class"
          ? employmentContractState({ ...person, wageClassId: "common" }, contractOptions)
          : contract;
        if (["before-contract", "after-contract", "inactive-season"].includes(temporalContract.reason)) {
          return { capacityQd: 0, reason: `employment-${temporalContract.reason}` };
        }
        if (contract.reason !== "active") {
          // Readiness provides the visible blocker; zero capacity is the
          // defense-in-depth guarantee for direct or accidental bypasses.
          return { capacityQd: 0, reason: `employment-${contract.reason}` };
        }
      }
      const assessment = assessNextTendayLabor(person, {
        currentQd: targetQd,
        season: targetSeason,
        payrollAccount: accounts[String(person?.id ?? residentId ?? "")],
        hungerStreak: person?.hungerStreakTendays,
        assignedAsWorker: true
      });
      const hasExplicitContract = Boolean(String(person?.compensationType ?? "").trim());
      const applicableComponents = assessment.components.filter((component) => (
        hasExplicitContract || !String(component?.id ?? "").startsWith("contract:")
      ));
      const factor = assessment.blocked && hasExplicitContract
        ? 0
        : Math.min(1, ...applicableComponents.map((component) => Math.max(0, Number(component?.laborFactor) || 0)));
      const limiting = applicableComponents
        .filter((component) => Number(component?.laborFactor) === factor && factor < 1)
        .map((component) => String(component?.id ?? ""))
        .filter(Boolean);
      return {
        capacityQd: Math.floor(defaultAvailability.capacityQd * factor),
        reason: factor < 1 ? (limiting.join("+") || "labor-consequence") : defaultAvailability.reason
      };
    }
  });
}

function laborPoolStatus(laborPool = {}) {
  const residents = Array.isArray(laborPool?.residents) ? laborPool.residents : [];
  const residentsById = new Map(residents.map((row) => [String(row?.id ?? ""), row]));
  const budgets = Array.isArray(laborPool?.budgets) ? laborPool.budgets : [];
  const budgetsByResidentId = new Map(budgets.map((row) => [String(row?.residentId ?? ""), row]));
  const readyResidents = residents.filter((resident) => resident?.readiness?.canSpend === true
    && Math.max(0, Number(budgetsByResidentId.get(String(resident?.id ?? ""))?.availableQd) || 0) > 0);
  const conflicts = Array.isArray(laborPool?.conflicts) ? laborPool.conflicts : [];
  const duplicates = Math.max(0, Number(laborPool?.readiness?.duplicateResidentIdCount) || 0);
  const ignored = Math.max(0, Number(laborPool?.readiness?.ignoredReferenceCount) || 0);
  const availableQd = budgets.reduce((sum, budget) => {
    const resident = residentsById.get(String(budget?.residentId ?? ""));
    if (resident?.readiness?.canSpend !== true) return sum;
    return sum + Math.max(0, Number(budget?.availableQd) || 0);
  }, 0);
  const ready = laborPool?.readiness?.ready === true;
  const conflictExamples = conflicts.slice(0, 3).map((row) => String(row?.message ?? row?.residentId ?? "Житель")).filter(Boolean);
  const blockerParts = [];
  if (conflicts.length) blockerParts.push(`конфликтов назначений: ${conflicts.length}${conflictExamples.length ? ` (${conflictExamples.join("; ")})` : ""}`);
  if (duplicates) blockerParts.push(`повторяющихся id жителей: ${duplicates}`);
  const message = ready
    ? "Трудовые назначения готовы."
    : `Нельзя провести десятник: ${blockerParts.join("; ") || "трудовой пул не готов"}. Исправьте назначения жителей и подготовьте расчёт заново.`;
  const lines = [
    `Трудовой пул: готовы ${readyResidents.length}/${residents.length} жителей; доступно ${availableQd} QD.`,
    `Основных назначений: ${readyResidents.filter((resident) => !String(resident?.primaryAssignmentId ?? "").startsWith("unassigned:")).length}.`
  ];
  if (conflicts.length) lines.push(`Блокирующие конфликты назначений: ${conflicts.length}.`);
  if (duplicates) lines.push(`Блокирующие повторяющиеся id жителей: ${duplicates}.`);
  if (ignored) lines.push(`Устаревшие ссылки на отсутствующих или погибших жителей: ${ignored} (производительность не дают).`);
  const alerts = ready ? [] : [{
    key: "labor-assignments",
    severity: "danger",
    icon: "fa-solid fa-people-arrows-left-right",
    title: "Конфликт трудовых назначений",
    text: message
  }];
  return {
    ready,
    residentCount: residents.length,
    readyResidentCount: readyResidents.length,
    availableQd,
    conflictCount: conflicts.length,
    duplicateResidentIdCount: duplicates,
    ignoredReferenceCount: ignored,
    message,
    lines,
    alerts
  };
}

function laborText(value = "") {
  return String(value ?? "").trim();
}

function laborOperationPart(value = "") {
  return laborText(value).replace(/[^a-zA-Z0-9а-яА-ЯёЁ:_-]+/g, "-").replace(/^-+|-+$/g, "") || "work";
}

function laborDayOrder(dayKey = "") {
  const parsed = Number(String(dayKey ?? "").split(":").at(-1));
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export const FinanceEconomyDomain = {
async _tendayReadinessContext(holding, { foodProjection: suppliedFoodProjection = null, catalogRows = null, workerContext: suppliedWorkerContext = null } = {}) {
  if (!holding) return { ready: false, alerts: [], alertCount: 0 };
  const laborPool = suppliedWorkerContext?.laborPool
    ?? (typeof this._buildTendayLaborPool === "function" ? this._buildTendayLaborPool(holding) : laborPoolForHolding(holding));
  const workerContext = suppliedWorkerContext?.laborPool
    ? suppliedWorkerContext
    : (typeof this._economyWorkerContext === "function" ? this._economyWorkerContext(holding, laborPool) : (suppliedWorkerContext ?? null));
  const labor = typeof this._laborPoolStatus === "function" ? this._laborPoolStatus(laborPool) : laborPoolStatus(laborPool);
  const living = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const foodProvision = foodProvisionReadiness(living);
  const upkeepOverdueTendays = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.economy?.treasury?.upkeepOverdueTendays, 0)));
  const activeUpkeepOperationalFactor = upkeepOperationalFactor(upkeepOverdueTendays, (value, fallback = 0) => this._safeNumber(value, fallback));
  const foodStored = this._storedFoodPersonDays(holding);
  const foodProjection = suppliedFoodProjection ?? await this._projectTendayFood(holding, { laborPool, workerContext });
  const payroll = typeof this._payrollReadinessContext === "function"
    ? this._payrollReadinessContext(holding, { laborPool })
    : { ready: true, blockers: [], alerts: [], inactive: [], people: living, period: null, message: "Договоры оплаты труда не проверялись." };
  const foodAvailable = foodProjection.available;
  const foodProduced = Math.max(0, foodAvailable - foodStored);
  const boardFoodDaily = totalBoardFoodDaily(living, this._foodConsumptionDependencies());
  const foodNeeded = boardFoodDaily * 10;
  const commonTable = typeof this._residentMealCapacitySnapshot === "function"
    ? this._residentMealCapacitySnapshot(holding, workerContext)
    : { residentCount: living.length, totalCapacity: 0, coveredResidents: 0, uncoveredResidents: living.length, fullyCovered: living.length === 0 };
  const qualifyingDietGroupCount = Math.max(0, Math.floor(this._safeNumber(foodProjection?.qualifyingDietGroupCount, 0)));
  const projectedFullFed = foodProjection?.fullFed === undefined ? foodAvailable >= foodNeeded && foodNeeded > 0 : foodProjection.fullFed === true;
  const projectedRichDiet = foodProjection?.richDiet === true;
  const commonTableBonusReady = commonTable.residentCount > 0 && projectedFullFed && projectedRichDiet && commonTable.fullyCovered;
  const injured = living.filter((person) => this._safeNumber(person?.injuredDays, 0) > 0).length;
  const contractWarnings = living.filter((person) => compensationContractWarning(person));
  const promisedHousingMissing = living.filter((person) => person?.housingProvided && (!String(person?.home ?? "").trim() || /без жилья|нет жилья|homeless/i.test(String(person?.home ?? ""))));
  const salaryArrears = Math.max(0, this._safeNumber(holding?.gm?.economy?.treasury?.salaryArrearsCopper, 0));
  const cashWorkers = living.filter((person) => personCashWageDaily(person) > 0).length;
  const buildings = holding?.buildings?.list ?? [];
  const canProjectGrain = typeof this._buildingStatus === "function"
    && typeof this._buildingFunctions === "function"
    && typeof this._buildingEffectiveWorkers === "function"
    && typeof this._expectedFormulaTotal === "function";
  const grainFields = canProjectGrain ? buildings.flatMap((building) => {
    if (this._buildingStatus(building).value !== "built" || !this._buildingFunctions(building).production) return [];
    if (!enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) })) return [];
    const workers = this._buildingEffectiveWorkers(holding, building, workerContext);
    return (building?.productionLines ?? [])
      .filter((line) => normalizeResourceId(line?.resourceId, line?.resource) === "grain" && line?.active !== false)
      .map((line) => {
        const base = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, 1));
        const expectedQty = String(line?.formula ?? "").trim()
          ? Math.max(0, Math.floor(this._expectedFormulaTotal(line.formula, { eff: workers.total, workers: workers.assigned, base, cycles: 1, qd: 1, workqd: 0 })))
          : Math.max(0, Math.floor(base));
        return {
          id: `${building.id}:${line.id ?? "line"}`,
          name: building.name || "Поле",
          effectiveWorkers: workers.total,
          expectedQty,
          productionLines: [line]
        };
      });
  }) : [];
  const currentQd = Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0));
  const currentCalendarDay = albugrirCalendarDay(Math.ceil(Math.max(1, currentQd) / ALBUGRIR_QD_PER_DAY));
  const staffedGrainWorkers = grainFields.reduce((sum, field) => sum + Math.max(0, this._safeNumber(field?.effectiveWorkers, 0)), 0);
  const grainHarvest = nextGrainHarvest({
    currentQd,
    fields: grainFields,
    grainFoodValue: foodValueForResource({ resourceId: "grain" }, this._foodConsumptionDependencies())
  });
  const resourceDefinitions = allResourceDefs({ catalogRows: catalogRows ?? undefined });
  const reserve = evaluateFoodReserve({
    currentQd,
    targetQd: grainHarvest.hasHarvest ? grainHarvest.availableQd : null,
    boardFoodDaily,
    resources: holding?.storage?.resources ?? [],
    resourceDefinitions,
    rooms: typeof this._storageRooms === "function" ? this._storageRooms(holding, { includeUnavailable: true }) : []
  });
  const harvestReserve = {
    ...grainHarvest,
    ...reserve,
    sufficient: reserve.hasTarget
      ? reserve.sufficient
      : boardFoodDaily <= 0 || foodAvailable >= foodNeeded,
    hasDailyNeed: boardFoodDaily > 0,
    coverageDaysText: reserve.coverageDays === null ? "—" : this._formatNumber(reserve.coverageDays),
    daysUntilText: grainHarvest.hasHarvest ? this._formatNumber(grainHarvest.daysUntil) : "—",
    requiredText: reserve.hasTarget ? this._formatNumber(reserve.requiredPersonDays) : "—",
    usableText: reserve.hasTarget ? this._formatNumber(reserve.usablePersonDays) : this._formatNumber(reserve.grossPersonDays),
    balanceText: reserve.hasTarget ? this._formatNumber(Math.abs(reserve.balancePersonDays)) : "—",
    expectedHarvestText: grainHarvest.hasHarvest ? this._formatNumber(grainHarvest.expectedFoodPersonDays) : "—"
  };
  const damaged = buildings.filter((building) => {
    const state = buildingOperationalState(building);
    return state.lifecycle === "active" && state.condition !== "intact";
  });
  const projectsWithoutCrew = buildings.filter((building) => {
    const state = buildingOperationalState(building);
    const project = state.lifecycle === "planned" || state.lifecycle === "building" || state.repairActive;
    return project && !String(building?.constructionCrewId ?? "").trim();
  });
  const understaffed = buildings.filter((building) => {
    if (!buildingOperationalState(building).operational) return false;
    const minimum = Math.max(0, this._safeNumber(building?.workersMin, 0));
    const assigned = (building?.assignedWorkerIds ?? []).filter(Boolean).length;
    return minimum > assigned;
  });
  const undercapitalized = buildings.map((building) => ({
    building,
    state: enterpriseCapitalState(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) })
  })).filter(({ building, state }) => {
    const status = typeof this._buildingStatus === "function" ? this._buildingStatus(building) : buildingOperationalState(building);
    if (status.value !== "built" || state.ready) return false;
    const functions = typeof this._buildingFunctions === "function" ? this._buildingFunctions(building) : (building?.functions ?? {});
    return functions.production || functions.income;
  });
  const alerts = [];
  alerts.push(...labor.alerts);
  alerts.push(...payroll.alerts);
  if (!foodProvision.ready) {
    alerts.push({
      key: "food-provision-contracts",
      severity: "danger",
      icon: "fa-solid fa-bowl-rice",
      title: "Режимы пропитания не готовы",
      text: `${foodProvision.blockers.slice(0, 4).map((row) => row.message).join(" · ")}${foodProvision.blockers.length > 4 ? ` · ещё ${foodProvision.blockers.length - 4}` : ""}`
    });
  }
  if (foodAvailable < foodNeeded) alerts.push({ key: "food", severity: "danger", icon: "fa-solid fa-bowl-food", title: "Не хватает пищи", text: `${this._formatNumber(foodAvailable)}/${this._formatNumber(foodNeeded)} человеко-дней с учётом прогнозируемого производства${foodProduced ? ` (+${this._formatNumber(foodProduced)})` : ""}; дефицит ${this._formatNumber(foodNeeded - foodAvailable)}.` });
  if (commonTable.residentCount > 0 && !commonTable.fullyCovered) alerts.push({ key: "common-table-capacity", severity: "info", icon: "fa-solid fa-utensils", title: "Общий стол не охватывает всех", text: `Мест ${commonTable.coveredResidents}/${commonTable.residentCount}; это не мешает обычному питанию дома, но бонус довольства требует работающего профинансированного трактира и мест для всех.` });
  if (projectedFullFed && !projectedRichDiet) alerts.push({ key: "diet-variety", severity: "info", icon: "fa-solid fa-apple-whole", title: "Рацион можно разнообразить", text: `Порог выполняют ${qualifyingDietGroupCount}/3 пищевых групп. Для бонуса общего стола нужны любые три группы, каждая не менее 20% потребности; зерно не обязательно.` });
  const foodAfterTenday = Math.max(0, foodAvailable - foodNeeded);
  if (foodNeeded > 0 && foodAvailable >= foodNeeded && foodAfterTenday < foodNeeded && foodProduced < foodNeeded) {
    alerts.push({
      key: "food-reserve-low",
      severity: "warning",
      icon: "fa-solid fa-box-open",
      title: "Запас пищи почти исчерпан",
      text: `После предстоящего десятника останется около ${this._formatNumber(foodAfterTenday)} человеко-дней; прогнозируемый выпуск покрывает ${this._formatNumber(foodProduced)} из ${this._formatNumber(foodNeeded)}. Подойдёт любая съедобная продукция или торговля — зерно не обязательно.`
    });
  }
  if (reserve.hasTarget && !reserve.sufficient) {
    alerts.push({ key: "harvest-reserve", severity: "danger", icon: "fa-solid fa-hourglass-half", title: "Запаса не хватит до урожая", text: `До ${grainHarvest.dateLabel} осталось ${harvestReserve.daysUntilText} дн.; надёжно доступно ${harvestReserve.usableText} из ${harvestReserve.requiredText} человеко-дней, дефицит ${harvestReserve.balanceText}.` });
  }
  if (reserve.hasTarget && reserve.atRiskPersonDays > 0.001) {
    alerts.push({ key: "harvest-spoilage", severity: "warning", icon: "fa-solid fa-apple-whole", title: "Часть запаса не доживёт до урожая", text: `${this._formatNumber(reserve.atRiskPersonDays)} человеко-дней скоропортящейся пищи нельзя успеть съесть до истечения срока при текущем общем столе; расчёт достаточности уже исключает эту часть.` });
  }
  if (staffedGrainWorkers > 0.001 && currentCalendarDay.technicalSeasonKey !== "summer") {
    alerts.push({ key: "seasonal-field-assignment", severity: "warning", icon: "fa-solid fa-people-arrows-left-right", title: "Зерновые работники вне сезона", text: `${this._formatNumber(staffedGrainWorkers)} эффективных работников назначено на поле в ${currentCalendarDay.trilune.name}. По текущим правилам зерно создаётся только в Зноерост и Зноеход, но денежная ставка начисляется весь десятник; до сезона их выгоднее перевести на другую работу.` });
  }
  if (projectsWithoutCrew.length) alerts.push({ key: "projects", severity: "danger", icon: "fa-solid fa-person-digging", title: "Проекты без бригады", text: `${projectsWithoutCrew.length}: ${projectsWithoutCrew.slice(0, 3).map((row) => row.name || "Объект").join(", ")}.` });
  if (undercapitalized.length) alerts.push({ key: "enterprise-capital", severity: "danger", icon: "fa-solid fa-landmark", title: "Не обеспечен капитал предприятий", text: undercapitalized.slice(0, 4).map(({ building, state }) => `${building.name || "Здание"}: ${this._formatCopperCurrency(state.shortfallCopper)}`).join(" · ") + (undercapitalized.length > 4 ? ` · ещё ${undercapitalized.length - 4}` : "") + ". Производство и доход этих зданий остановлены." });
  if (understaffed.length) alerts.push({ key: "workers", severity: "warning", icon: "fa-solid fa-user-clock", title: "Не хватает работников", text: understaffed.slice(0, 5).map((building) => `${building.name || "Здание"} ${(building.assignedWorkerIds ?? []).filter(Boolean).length}/${Math.max(0, this._safeNumber(building.workersMin, 0))}`).join(" · ") + (understaffed.length > 5 ? ` · ещё ${understaffed.length - 5}` : "") + "." });
  if (damaged.length) alerts.push({ key: "damage", severity: "warning", icon: "fa-solid fa-house-crack", title: "Повреждённые здания", text: `${damaged.length} зданий повреждено или разрушено.` });
  if (injured) alerts.push({ key: "injured", severity: "info", icon: "fa-solid fa-user-injured", title: "Раненые жители", text: `${injured} жителей продолжат восстановление в течение десятника.` });
  if (salaryArrears > 0) alerts.push({ key: "salary-arrears", severity: "warning", icon: "fa-solid fa-money-bill-wave", title: "Просрочена оплата труда", text: `Долг ${this._formatCopperCurrency(salaryArrears)} затрагивает ${cashWorkers} жителей с денежной ставкой и снижает их довольство.` });
  if (activeUpkeepOperationalFactor < 1) alerts.push({
    key: "upkeep-overdue",
    severity: "warning",
    icon: "fa-solid fa-screwdriver-wrench",
    title: "Просрочено содержание зданий",
    text: `Просрочка ${upkeepOverdueTendays} десятн.; в предстоящем расчёте здания используют ${Math.round(activeUpkeepOperationalFactor * 100)}% обычной мощности. Погашение долга восстановит мощность со следующего десятника.`
  });
  if (contractWarnings.length) alerts.push({ key: "compensation", severity: "warning", icon: "fa-solid fa-file-signature", title: "Неполные договоры", text: `${contractWarnings.length}: ${contractWarnings.slice(0, 3).map((person) => person.name || "Житель").join(", ")}${contractWarnings.length > 3 ? ` · ещё ${contractWarnings.length - 3}` : ""}.` });
  if (promisedHousingMissing.length) alerts.push({ key: "contract-housing", severity: "warning", icon: "fa-solid fa-house-circle-exclamation", title: "Не выполнено обещание жилья", text: `${promisedHousingMissing.length}: ${promisedHousingMissing.slice(0, 3).map((person) => person.name || "Житель").join(", ")}.` });
  return {
    ready: !alerts.some((alert) => alert.severity === "danger"),
    alerts,
    alertCount: alerts.length,
    foodAvailable,
    foodStored,
    foodProduced,
    foodNeeded,
    boardFoodDaily,
    commonTable,
    qualifyingDietGroupCount,
    projectedFullFed,
    projectedRichDiet,
    commonTableBonusReady,
    harvestReserve,
    labor,
    payroll,
    foodProvision,
    upkeepOverdueTendays,
    activeUpkeepOperationalFactor,
    salaryArrears,
    undercapitalizedCount: undercapitalized.length,
    contractWarningCount: contractWarnings.length,
    statusLabel: alerts.length ? (alerts.some((alert) => alert.severity === "danger") ? "Требует внимания" : "Есть предупреждения") : "Готово к десятнику"
  };
},

_expectedFormulaTotal(formula = "", data = {}) {
  const substituted = String(formula ?? "").replace(/@([a-zA-Z0-9_]+)/g, (_match, key) => String(this._safeNumber(data?.[key], 0)));
  const averaged = substituted.replace(/(\d*)d(\d+)/gi, (_match, countText, sidesText) => {
    const count = Math.max(1, Number(countText) || 1);
    const sides = Math.max(1, Number(sidesText) || 1);
    return String(count * (sides + 1) / 2);
  });
  try { return Math.max(0, Number(evaluateArithmeticExpression(averaged || "0")) || 0); }
  catch (_error) { return 0; }
},

async _expectedLineOutputForCycle(line, context = {}) {
  const base = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, 1));
  if (!String(line?.formula ?? "").trim()) return { qty: Math.floor(base), formula: "" };
  const total = this._expectedFormulaTotal(line.formula, { ...context, base });
  return { qty: Math.max(0, Math.floor(total)), formula: "" };
},

async _projectTendayFood(holding, { laborPool = null, workerContext = null } = {}) {
  const preview = clone(holding);
  const report = { produced: [], consumed: [], skipped: [], formulas: [], work: [], ledger: [] };
  const snapshot = laborPool
    ?? (typeof this._buildTendayLaborPool === "function" ? this._buildTendayLaborPool(preview) : laborPoolForHolding(preview));
  const context = workerContext ?? this._economyWorkerContext(preview, snapshot);
  await this._runProductionCycleForQd(preview, 40, report, {
    buildings: preview?.buildings?.list ?? [],
    budgets: new Map(),
    workerContext: context,
    lineOutputForCycle: (line, context) => this._expectedLineOutputForCycle(line, context)
  });
  const targetQd = Math.max(0, this._safeNumber(preview?.gm?.calendaria?.lastQd, 0)) + 40;
  const available = this._usableFoodPersonDaysAtQd(preview, targetQd);
  report.food = {
    needed: 0,
    eaten: 0,
    hungryResidentDays: 0,
    nutritionTags: [],
    nutritionDiversity: 0,
    nutritionDiversityLabel: "Нет питания",
    dietGroupPersonDays: {},
    lines: []
  };
  const consumption = runFoodConsumption({ holding: preview, qd: 40, report, dependencies: this._foodConsumptionDependencies() });
  return {
    available,
    report,
    needed: consumption.needed,
    eaten: consumption.eaten,
    fullFed: report.food.fullFed === true,
    richDiet: report.food.richDiet === true,
    qualifyingDietGroupCount: Math.max(0, Math.floor(this._safeNumber(report.food.qualifyingDietGroupCount, 0))),
    qualifyingDietGroups: [...(report.food.qualifyingDietGroups ?? [])]
  };
},

_tradeDependencies({ random = () => Math.random() } = {}) {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    random,
    buildingStatus: (building) => this._buildingStatus(building),
    buildingFunctions: (building) => this._buildingFunctions(building),
    buildingEffectiveWorkers: (holding, building, workerContext) => this._buildingEffectiveWorkers(holding, building, workerContext),
    enterpriseCapitalReady: (building, holding) => enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) }),
    reputationTotal: (holding) => this._reputationSummary(holding).total,
    tradeCandidateFilters: (building) => this._tradeCandidateFilters(building),
    tradeCandidates: (holding, filters) => this._tradeCandidates(holding, filters),
    tradeCandidateQuantity: (candidate) => this._tradeCandidateQuantity(candidate),
    tradeUnitSalePrice: (basePrice, efficiency) => this._tradeUnitSalePrice(basePrice, efficiency),
    assignedBuildingPeople: (holding, building, workerContext) => this._assignedBuildingPeople(holding, building, workerContext),
    personBuildingEfficiency: (holding, building, person, workerContext) => this._personBuildingEfficiency(holding, building, person, workerContext),
    rollFormulaTotal: (formula, context) => this._rollFormulaTotal(formula, context),
    reduceTradeCandidate: (candidate, amount) => this._reduceTradeCandidate(candidate, amount),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    itemQuantity: (row) => this._itemQuantity(row),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries),
    buildingLaborCapacity: (holding, building, workerContext, options) => this._buildingLaborCapacity(holding, building, workerContext, options),
    spendBuildingLabor: (holding, building, workerContext, options) => this._spendBuildingLaborForUnits(holding, building, workerContext, options)
  };
},

async _runTradeForQd(holding, qd = 0, report = null, workerContext = null, { random = () => Math.random() } = {}) {
  const context = workerContext ?? this._economyWorkerContext(holding);
  return runTrade({
    holding,
    qd,
    report,
    workerContext: context,
    dependencies: this._tradeDependencies({ random })
  });
},

_hospitalityServiceDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    buildingStatus: (building) => this._buildingStatus(building),
    buildingFunctions: (building) => this._buildingFunctions(building),
    enterpriseCapitalReady: (building, holding) => enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) }),
    buildingEffectiveWorkers: (holding, building, workerContext) => this._buildingEffectiveWorkers(holding, building, workerContext),
    reputationTotal: (holding) => this._reputationSummary(holding).total,
    isFoodResource: (row) => isFoodResource(row, this._foodConsumptionDependencies()),
    foodValueForResource: (row) => foodValueForResource(row, this._foodConsumptionDependencies()),
    normalizeResourceId,
    resourceDef,
    resourceLabel,
    consumeStorageResource: (holding, row, qty, options) => this._storageTakeLots(holding, row, qty, options),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row),
    storageUsableQuantityAtQd: (holding, row, targetQd) => this._storageUsableQuantityAtQd(holding, row, targetQd),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    formatNumber: (value) => this._formatNumber(value),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries),
    buildingLaborCapacity: (holding, building, workerContext, options) => this._buildingLaborCapacity(holding, building, workerContext, options),
    spendBuildingLabor: (holding, building, workerContext, options) => this._spendBuildingLaborForUnits(holding, building, workerContext, options)
  };
},

_runHospitalityServicesForQd(holding, qd = 0, report = null, workerContext = null, commonTableSnapshot = null) {
  return runHospitalityServices({
    holding,
    qd,
    report,
    workerContext: workerContext ?? this._economyWorkerContext(holding),
    commonTableSnapshot,
    dependencies: this._hospitalityServiceDependencies()
  });
},

_commonTableMoraleState(holding) {
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.economy || typeof holding.gm.economy !== "object") holding.gm.economy = {};
  const source = holding.gm.economy.commonTable && typeof holding.gm.economy.commonTable === "object"
    ? holding.gm.economy.commonTable
    : {};
  holding.gm.economy.commonTable = {
    ...source,
    activeMoraleBonus: Number(source.activeMoraleBonus) > 0 ? 1 : 0,
    pendingMoraleBonus: Number(source.pendingMoraleBonus) > 0 ? 1 : 0
  };
  return holding.gm.economy.commonTable;
},

_residentMealCapacitySnapshot(holding, workerContext = null) {
  return residentMealCapacitySnapshot({
    holding,
    workerContext,
    dependencies: {
      buildingOperationalState,
      enterpriseCapitalReady: (building, sourceHolding) => enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(sourceHolding?.gm?.economy?.landRightsProvided) }),
      assignedBuildingPeople: (sourceHolding, building, sourceWorkerContext) => this._assignedBuildingPeople(sourceHolding, building, sourceWorkerContext),
      buildingLaborCapacity: (sourceHolding, building, sourceWorkerContext, options) => this._buildingLaborCapacity(sourceHolding, building, sourceWorkerContext, options)
    }
  });
},

_pushProductionPlacement(report, holding, sourceName, resourceName, placements = [], extra = "", resourceId = "") {
  const normalizedResourceId = normalizeResourceId(resourceId, resourceName);
  for (const item of placements) {
    const room = item.roomId ? this._storageRoomLabel(holding, item.roomId) : "Счетчик денег";
    const overflow = item.overflowFrom ? ` (переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)})` : "";
    report.produced.push(`${sourceName}: ${resourceName} +${this._formatNumber(item.qty)}${extra} → ${room}${overflow}.`);
    appendEconomyLedger(report, {
      domain: "production",
      kind: normalizedResourceId === "money" ? "money" : "resource",
      resourceId: normalizedResourceId,
      name: resourceName,
      qty: item.qty,
      roomId: item.roomId,
      source: sourceName,
      note: [extra.trim(), item.overflowFrom ? `переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)}` : ""].filter(Boolean).join("; ")
    });
  }
},

async _rollFormulaTotal(formula = "", data = {}) {
  const raw = String(formula ?? "").trim();
  if (!raw) return { total: null, result: "" };
  const substituted = raw.replace(/@([a-zA-Z0-9_]+)/g, (_match, key) => {
    return String(this._safeNumber(data?.[key], 0));
  });
  try {
    const roll = new (foundryRollClass())(substituted);
    await roll.evaluate();
    return { total: Number(roll.total) || 0, result: roll.result ?? substituted };
  } catch (error) {
    console.warn("FBL Skyhold | Formula roll failed", raw, error);
  }
  const arithmetic = rollInlineDice(substituted);
  try {
    // Формула уже очищена от всего, кроме чисел и базовых операторов.
    const total = evaluateArithmeticExpression(arithmetic || "0");
    const result = arithmetic === substituted ? substituted : `${substituted} = ${arithmetic}`;
    return { total: Number(total) || 0, result };
  } catch (_error) {
    return { total: 0, result: `ошибка формулы: ${raw}` };
  }
},

_formatNumber(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Number.isInteger(numeric)) return String(numeric);
  return String(Number(numeric.toFixed(2)));
},

_workQdPerWorker(periodQd = 0) {
  const qd = Math.max(0, Math.floor(this._safeNumber(periodQd, 0)));
  const fullDays = Math.floor(qd / 4);
  const rest = qd % 4;
  return fullDays * 2 + Math.min(rest, 2);
},

_periodLabel(periodQd = 0) {
  const qd = Math.max(0, Math.floor(this._safeNumber(periodQd, 0)));
  if (qd === 1) return "1 QD";
  if (qd === 4) return "1 день";
  if (qd === 40) return "десятник";
  return `${qd} QD`;
},

_buildTendayLaborPool(holding) {
  return laborPoolForHolding(holding);
},

_laborPoolStatus(laborPool = {}) {
  return laborPoolStatus(laborPool);
},

_employmentPeriodContext(holding, qd = 40) {
  const currentQd = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)));
  const periodQd = Math.max(0, Math.floor(this._safeNumber(qd, 40)));
  const targetQd = currentQd + periodQd;
  const calendar = holding?.gm?.calendaria ?? {};
  const snapshotForOffset = (offsetQd, absoluteQd) => {
    let snapshot = null;
    try {
      const dateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object"
        ? (offsetQd > 0 ? addCalendariaQd(calendar.lastDateTime, offsetQd) : calendar.lastDateTime)
        : null;
      snapshot = getCalendariaSeasonSnapshot(dateTime, calendar.lastDateText ?? calendar.lastDateKey) ?? null;
    } catch (_error) {
      snapshot = null;
    }
    const fallback = albugrirCalendarDay(Math.ceil(Math.max(1, absoluteQd) / ALBUGRIR_QD_PER_DAY));
    return {
      snapshot,
      season: String(snapshot?.season?.key ?? fallback?.technicalSeasonKey ?? "").trim().toLowerCase()
    };
  };
  const current = snapshotForOffset(0, currentQd);
  const target = snapshotForOffset(periodQd, targetQd);
  const periods = Math.floor(periodQd / 40);
  const tendays = Array.from({ length: periods }, (_value, index) => {
    const endQd = currentQd + (index + 1) * 40;
    const season = snapshotForOffset((index + 1) * 40, endQd);
    return {
      index: index + 1,
      startQd: currentQd + index * 40 + 1,
      endQd,
      season: season.season,
      seasonSnapshot: season.snapshot
    };
  });
  return {
    currentQd,
    targetQd,
    periodQd,
    periods,
    tendays,
    currentSeason: current.season,
    targetSeason: target.season,
    currentSeasonSnapshot: current.snapshot,
    targetSeasonSnapshot: target.snapshot
  };
},

_payrollReadinessContext(holding, { laborPool = null, period = null, qd = 40 } = {}) {
  const snapshot = laborPool ?? this._buildTendayLaborPool(holding);
  const periodContext = period ?? this._employmentPeriodContext(holding, qd);
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const buildings = holding?.buildings?.list ?? [];
  const buildingsById = new Map(buildings.map((building) => [String(building?.id ?? ""), building]));
  const residentsById = new Map((snapshot?.residents ?? []).map((row) => [String(row?.id ?? ""), row]));
  const blockers = [];
  const payrollPeople = [];
  const inactive = [];
  const inactiveReasons = new Set(["before-contract", "after-contract", "inactive-season"]);

  for (const person of people) {
    const personId = String(person?.id ?? "").trim();
    const name = String(person?.name ?? personId ?? "Житель") || "Житель";
    const resident = residentsById.get(personId);
    const primaryAssignmentId = String(resident?.primaryAssignmentId ?? "");
    const assigned = Boolean(primaryAssignmentId && !primaryAssignmentId.startsWith("unassigned:"));
    const compensationType = String(person?.compensationType ?? "").trim();
    const addBlocker = (code, message) => blockers.push({ code, personId, name, message });

    if (assigned && ["dependent", "volunteer", "coerced"].includes(compensationType)) {
      const assessment = assessNextTendayLabor(person, {
        currentQd: periodContext.targetQd,
        season: periodContext.targetSeason,
        hungerStreak: person?.hungerStreakTendays,
        assignedAsWorker: true
      });
      for (const blocker of assessment.blockers) {
        addBlocker(`labor-${blocker.code}`, `${name}: ${blocker.message}`);
      }
    }

    if (isFixedWageCompensation(compensationType)) {
      const contractSlices = (periodContext.tendays?.length ? periodContext.tendays : [{ endQd: periodContext.targetQd, season: periodContext.targetSeason }])
        .map((slice) => {
          const statementOptions = {
            currentQd: slice.endQd,
            season: slice.season,
            wageIndex: holding?.gm?.economy?.labor?.wageIndex,
            laborPool: snapshot,
            residentId: personId
          };
          const state = employmentContractState(person, statementOptions);
          const temporalState = state.reason === "missing-wage-class"
            ? employmentContractState({ ...person, wageClassId: "common" }, statementOptions)
            : state;
          return { state, temporalState };
        });
      const invalidSlice = contractSlices.find(({ temporalState }) => !inactiveReasons.has(temporalState.reason) && temporalState.reason !== "active");
      const hasActiveSlice = contractSlices.some(({ temporalState }) => temporalState.reason === "active");
      const missingWageSlice = hasActiveSlice ? contractSlices.find(({ state, temporalState }) => temporalState.reason === "active" && state.reason !== "active") : null;
      if (!hasActiveSlice && contractSlices.every(({ temporalState }) => inactiveReasons.has(temporalState.reason))) {
        inactive.push({ personId, name, reason: contractSlices.at(-1)?.temporalState?.reason ?? "inactive" });
      } else if (invalidSlice || missingWageSlice) {
        const reason = invalidSlice?.temporalState?.reason ?? missingWageSlice?.state?.reason ?? "invalid-contract";
        const messages = {
          "missing-wage-class": "не выбран тарифный класс Economy V2",
          "invalid-contract-term": "конец договора раньше начала",
          "missing-current-qd": "не определена дата договора",
          "missing-season": "не определён сезон сезонного договора"
        };
        addBlocker(`employment-${reason}`, `${name}: ${messages[reason] ?? "трудовой договор не готов"}.`);
      }
      payrollPeople.push({ ...person });
      continue;
    }

    if (compensationType === "share") {
      const rawRate = Number(person?.shareRate);
      const enterpriseId = primaryAssignmentId.startsWith("building:")
        ? primaryAssignmentId.slice("building:".length)
        : "";
      const enterprise = buildingsById.get(enterpriseId);
      const functions = enterprise && typeof this._buildingFunctions === "function"
        ? this._buildingFunctions(enterprise)
        : (enterprise?.functions ?? {});
      if (!Number.isFinite(rawRate) || rawRate <= 0 || rawRate > 1) {
        addBlocker("invalid-enterprise-share-rate", `${name}: доля результата должна быть больше 0% и не больше 100%.`);
      }
      if (!enterprise || (!functions?.production && !functions?.income)) {
        addBlocker("invalid-share-enterprise", `${name}: доля не привязана к существующему производственному или доходному предприятию.`);
      }
      payrollPeople.push({ ...person, workAssignment: enterpriseId });
      continue;
    }

    payrollPeople.push({ ...person });
  }

  const shareIssues = validateEnterpriseShareContracts(payrollPeople);
  blockers.push(...shareIssues.map((issue) => ({
    ...issue,
    code: issue.code,
    message: issue.message
  })));
  const payrollState = normalizePayrollState(holding?.gm?.economy?.labor?.payroll);
  const personalArrearsCopper = Object.values(payrollState.accounts)
    .reduce((sum, account) => sum + Math.max(0, Number(account?.arrearsCopper) || 0), 0);
  const aggregateArrearsCopper = Math.max(0, Math.floor(Number(holding?.gm?.economy?.treasury?.salaryArrearsCopper) || 0));
  if (aggregateArrearsCopper !== personalArrearsCopper) {
    blockers.push({
      code: "salary-arrears-ledger-mismatch",
      aggregateArrearsCopper,
      personalArrearsCopper,
      message: `Старый общий долг по зарплате (${aggregateArrearsCopper}) не совпадает с персональными счетами (${personalArrearsCopper}); сначала распределите или исправьте долг.`
    });
  }
  const ready = blockers.length === 0;
  const alerts = ready ? [] : [{
    key: "payroll-contracts",
    severity: "danger",
    icon: "fa-solid fa-file-invoice-dollar",
    title: "Договоры оплаты труда не готовы",
    text: `${blockers.slice(0, 4).map((row) => row.message).join(" · ")}${blockers.length > 4 ? ` · ещё ${blockers.length - 4}` : ""}`
  }];
  return {
    ready,
    blockers,
    alerts,
    people: payrollPeople,
    inactive,
    period: periodContext,
    message: ready ? "Договоры оплаты труда готовы." : alerts[0].text
  };
},

_fixedPayrollObligations(holding, payrollContext, laborPool) {
  const periods = Math.max(0, Math.floor(this._safeNumber(payrollContext?.period?.periods, 0)));
  if (!periods) return [];
  const wageIndex = holding?.gm?.economy?.labor?.wageIndex;
  return (payrollContext?.people ?? []).flatMap((person) => {
    if (!isFixedWageCompensation(person?.compensationType)) return [];
    const statements = (payrollContext.period.tendays?.length
      ? payrollContext.period.tendays
      : [{ endQd: payrollContext.period.targetQd, season: payrollContext.period.targetSeason }])
      .map((slice) => employmentTendayStatement(person, {
        currentQd: slice.endQd,
        season: slice.season,
        wageIndex,
        laborPool,
        residentId: person?.id
      }));
    const activeStatements = statements.filter((statement) => statement.active);
    const dueCopper = activeStatements.reduce((sum, statement) => sum + Math.max(0, Math.floor(statement.dueCopper)), 0);
    if (dueCopper <= 0) return [];
    const statement = activeStatements.at(-1);
    return [{
      personId: String(person?.id ?? ""),
      personName: String(person?.name ?? person?.id ?? "Житель"),
      kind: "fixed",
      employmentMode: statement.employmentMode,
      wageClassId: statement.wageClassId,
      tendayTariffCopper: statement.tendayTariffCopper,
      periods: activeStatements.length,
      workedDays: activeStatements.reduce((sum, row) => sum + row.workedDays, 0),
      dueCopper
    }];
  });
},

_payrollForecast(holding, { qd = 40, laborPool = null } = {}) {
  const snapshot = laborPool ?? this._buildTendayLaborPool(holding);
  const period = this._employmentPeriodContext(holding, qd);
  const context = this._payrollReadinessContext(holding, { laborPool: snapshot, period, qd });
  const fixedRows = context.ready ? this._fixedPayrollObligations(holding, context, snapshot) : [];
  const fixedDueCopper = fixedRows.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row?.dueCopper) || 0)), 0);
  return {
    ready: context.ready,
    blockers: context.blockers,
    period,
    fixedRows,
    fixedDueCopper,
    fixedPeopleCount: new Set(fixedRows.map((row) => String(row?.personId ?? "")).filter(Boolean)).size,
    // Enterprise shares are intentionally absent: the tenday runtime calculates
    // them from the realized enterprise ledger, which a preflight cannot invent.
    shareDueCopper: 0,
    shareForecastExcluded: context.people.some((person) => String(person?.compensationType ?? "") === "share")
  };
},

_runPayrollAndTreasuryCostsForQd(holding, qd = 0, report = null, {
  laborPool = null,
  payrollContext = null,
  operationId = "",
  workerContext = null
} = {}) {
  const period = payrollContext?.period ?? this._employmentPeriodContext(holding, qd);
  if (period.periods <= 0) return this._runTreasuryCostsForQd(holding, qd, report, workerContext);
  const context = payrollContext ?? this._payrollReadinessContext(holding, { laborPool, period, qd });
  if (!context.ready) {
    if (report) {
      report.blocked = true;
      report.payroll = { ready: false, blockers: context.blockers, rows: [], lines: [context.message] };
      report.skipped?.push?.(context.message);
    }
    return { ok: false, blocked: true, payrollBlocked: true, message: context.message };
  }

  const fixedRows = this._fixedPayrollObligations(holding, context, laborPool);
  const shares = calculateEnterpriseSharePayouts({
    people: context.people,
    report,
    resourcePriceCopper: (resourceId, row) => this._resourcePriceCopper({ ...row, resourceId }),
    itemPriceCopper: (row) => this._itemPriceCopper(row)
  });
  const shareRows = shares.payouts.map((row) => ({
    ...row,
    personName: String(context.people.find((person) => String(person?.id ?? "") === row.personId)?.name ?? row.personId),
    kind: "share"
  }));
  const obligations = [...fixedRows, ...shareRows];
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.economy || typeof holding.gm.economy !== "object") holding.gm.economy = {};
  if (!holding.gm.economy.labor || typeof holding.gm.economy.labor !== "object") holding.gm.economy.labor = {};
  if (!holding.gm.economy.treasury || typeof holding.gm.economy.treasury !== "object") holding.gm.economy.treasury = {};
  const previousState = normalizePayrollState(holding.gm.economy.labor.payroll);
  const previousArrearsCopper = Object.values(previousState.accounts).reduce((sum, account) => sum + Math.max(0, Number(account?.arrearsCopper) || 0), 0);
  const payrollOperationId = String(operationId ?? "").trim() || `payroll-qd-${period.targetQd}`;
  const settlement = settlePayroll({
    state: previousState,
    obligations,
    availableCopper: this._moneyCopper(holding),
    operationId: payrollOperationId
  });
  if (!settlement.ok) {
    const message = settlement.message || "Расчёт оплаты труда отклонён.";
    if (report) {
      report.blocked = true;
      report.payroll = { ready: false, conflict: Boolean(settlement.conflict), blockers: [], rows: [], lines: [message] };
      report.skipped?.push?.(message);
    }
    return { ...settlement, blocked: true, payrollBlocked: true };
  }

  holding.gm.economy.labor.payroll = settlement.state;
  holding.gm.economy.treasury.salaryArrearsCopper = settlement.receipt.arrearsCopper;
  const fixedDueCopper = fixedRows.reduce((sum, row) => sum + row.dueCopper, 0);
  const shareDueCopper = shareRows.reduce((sum, row) => sum + row.dueCopper, 0);
  const currentDueCopper = fixedDueCopper + shareDueCopper;
  const obligationByPerson = new Map(obligations.map((row) => [row.personId, row]));
  const payrollRows = settlement.receipt.rows.map((row) => ({
    ...row,
    personName: obligationByPerson.get(row.personId)?.personName
      ?? context.people.find((person) => String(person?.id ?? "") === row.personId)?.name
      ?? row.personId,
    kind: obligationByPerson.get(row.personId)?.kind ?? "arrears",
    enterpriseId: obligationByPerson.get(row.personId)?.enterpriseId ?? "",
    currentDueCopper: obligationByPerson.get(row.personId)?.dueCopper ?? 0
  }));
  if (report) {
    report.payroll = {
      ready: true,
      operationId: payrollOperationId,
      currentQd: period.currentQd,
      targetQd: period.targetQd,
      season: period.targetSeason,
      periods: period.periods,
      fixedDueCopper,
      shareDueCopper,
      currentDueCopper,
      previousArrearsCopper,
      dueCopper: settlement.receipt.dueCopper,
      paidCopper: settlement.receipt.paidCopper,
      arrearsCopper: settlement.receipt.arrearsCopper,
      treasuryBeforeCopper: settlement.receipt.treasuryBeforeCopper,
      treasuryAfterPayrollCopper: settlement.receipt.treasuryAfterCopper,
      rows: payrollRows,
      enterprises: shares.enterprises,
      issues: shares.issues,
      inactive: context.inactive,
      lines: [
        `Начислено: ставки ${this._formatCopperCurrency(fixedDueCopper)}, доли фактического результата ${this._formatCopperCurrency(shareDueCopper)}.`,
        `Выплачено ${this._formatCopperCurrency(settlement.receipt.paidCopper)}; долг после расчёта ${this._formatCopperCurrency(settlement.receipt.arrearsCopper)}.`
      ]
    };
  }

  const totals = this._prepareTotals(holding, workerContext);
  const treasury = runTreasuryCosts({
    holding,
    qd,
    totals,
    report,
    salarySettlement: {
      currentDueCopper,
      previousArrearsCopper,
      dueCopper: settlement.receipt.dueCopper,
      paidCopper: settlement.receipt.paidCopper,
      arrearsCopper: settlement.receipt.arrearsCopper,
      treasuryBeforeCopper: settlement.receipt.treasuryBeforeCopper,
      treasuryAfterCopper: settlement.receipt.treasuryAfterCopper,
      fixedDueCopper,
      shareDueCopper
    },
    dependencies: this._treasuryCostDependencies()
  });
  if (report?.payroll) report.payroll.treasuryAfterCopper = this._moneyCopper(holding);
  return { ok: true, payroll: report?.payroll ?? null, treasury, settlement };
},

_runtimeLaborAssignmentId(building, workerContext = null) {
  const cached = workerContext?.buildingWorkers?.get(building)?.assignmentId;
  if (cached) return String(cached);
  const buildingId = String(building?.id ?? "").trim();
  return buildingId ? `building:${buildingId}` : "";
},

_runtimeLaborSlots(holding, assignmentId, workerContext = null, { building = null, useEfficiency = true } = {}) {
  const pool = workerContext?.laborPool;
  const assignment = String(assignmentId ?? "").trim();
  if (!pool || !assignment) return [];
  const residentsById = workerContext?.laborResidentsById
    ?? new Map((pool?.residents ?? []).map((row) => [String(row?.id ?? ""), row]));
  const budgetsById = workerContext?.laborBudgetsByResidentId
    ?? new Map((pool?.budgets ?? []).map((row) => [String(row?.residentId ?? ""), row]));
  const peopleById = workerContext?.peopleById
    ?? new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
  const residentIds = (pool?.assignments ?? [])
    .find((row) => String(row?.id ?? "") === assignment)?.primaryResidentIds
    ?? [...(workerContext?.readyResidentIdsByAssignment?.get(assignment) ?? [])];
  const remainingByResident = new Map();
  const rows = [...new Set(residentIds.map(String).filter(Boolean))].flatMap((residentId) => {
    const resident = residentsById.get(residentId);
    const budget = budgetsById.get(residentId);
    const person = peopleById.get(residentId);
    const availableQd = Math.max(0, Math.floor(Number(budget?.availableQd) || 0));
    if (!person || resident?.readiness?.canSpend !== true || budget?.primaryAssignmentId !== assignment || availableQd <= 0) return [];
    remainingByResident.set(residentId, availableQd);
    const personEfficiency = useEfficiency && building
      ? Math.max(0, this._safeNumber(this._personBuildingEfficiency(holding, building, person, workerContext), 0))
      : 1;
    const infrastructureFactor = building
      ? Math.max(0, Math.min(1, this._safeNumber(workerContext?.maintenanceOperationalFactor, 1)))
      : 1;
    const efficiency = personEfficiency * infrastructureFactor;
    return efficiency > 0 ? [{ residentId, person, efficiency }] : [];
  }).sort((left, right) => right.efficiency - left.efficiency || left.residentId.localeCompare(right.residentId, "ru"));
  if (!rows.length) return [];

  const loggedByResidentDay = new Map();
  for (const log of pool?.workLog ?? []) {
    const key = `${String(log?.residentId ?? "")}\u0000${String(log?.dayKey ?? "")}`;
    loggedByResidentDay.set(key, (loggedByResidentDay.get(key) ?? 0) + Math.max(0, Math.floor(Number(log?.laborQd) || 0)));
  }
  const dayKeys = [...(pool?.period?.dayKeys ?? [])]
    .map(String)
    .sort((left, right) => laborDayOrder(left) - laborDayOrder(right) || left.localeCompare(right, "en"));
  const perDay = Math.max(1, Math.floor(Number(pool?.period?.laborQdPerDay) || 2));
  const slots = [];
  for (const dayKey of dayKeys) {
    for (const row of rows) {
      const totalRemaining = remainingByResident.get(row.residentId) ?? 0;
      if (totalRemaining <= 0) continue;
      const logged = loggedByResidentDay.get(`${row.residentId}\u0000${dayKey}`) ?? 0;
      const count = Math.min(totalRemaining, Math.max(0, perDay - logged));
      for (let index = 0; index < count; index += 1) {
        slots.push({ residentId: row.residentId, dayKey, laborQd: 1, efficiency: row.efficiency });
      }
      remainingByResident.set(row.residentId, totalRemaining - count);
    }
  }
  return slots;
},

_remainingBuildingEffectiveWorkers(holding, building, workerContext = null) {
  if (!workerContext?.laborPool) return null;
  const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
  const slots = this._runtimeLaborSlots(holding, assignmentId, workerContext, { building, useEfficiency: true });
  const effectiveQd = slots.reduce((sum, slot) => sum + slot.efficiency, 0);
  const capacityPerWorker = Math.max(1, Number(workerContext.laborPool?.period?.capacityQdPerResident) || 20);
  const residentIds = [...new Set(slots.map((slot) => slot.residentId))];
  return {
    assigned: residentIds.length,
    total: effectiveQd / capacityPerWorker,
    suitableCount: 0,
    traitBonus: 0,
    leaderBonus: 0,
    remainingLaborQd: slots.length,
    remainingEffectiveQd: effectiveQd,
    detail: residentIds.length
      ? `${residentIds.length} раб. · осталось ${slots.length} QD`
      : "нет свободных рабочих QD"
  };
},

_commitRuntimeLaborWork(assignmentId, work = [], workerContext = null, { purpose = "work" } = {}) {
  const pool = workerContext?.laborPool;
  const assignment = String(assignmentId ?? "").trim();
  const rows = Array.isArray(work) ? work.filter((row) => Math.max(0, Math.floor(Number(row?.laborQd) || 0)) > 0) : [];
  if (!pool || !assignment || !rows.length) return { ok: rows.length === 0, laborQd: 0, work: [] };
  if (!(workerContext.laborOperationSequence instanceof Map)) workerContext.laborOperationSequence = new Map();
  const sequenceKey = `${assignment}|${String(purpose ?? "work")}`;
  const sequence = (workerContext.laborOperationSequence.get(sequenceKey) ?? 0) + 1;
  workerContext.laborOperationSequence.set(sequenceKey, sequence);
  const root = laborOperationPart(workerContext.laborOperationId || pool?.period?.key || "tenday");
  const assignmentPart = laborOperationPart(assignment);
  const purposePart = laborOperationPart(purpose);
  const reservationId = `runtime-labor:${root}:${assignmentPart}:${purposePart}:${sequence}`;
  const allocationsByResident = new Map();
  for (const row of rows) {
    const residentId = String(row?.residentId ?? "").trim();
    const laborQd = Math.max(0, Math.floor(Number(row?.laborQd) || 0));
    if (!residentId || !laborQd) continue;
    allocationsByResident.set(residentId, (allocationsByResident.get(residentId) ?? 0) + laborQd);
  }
  const allocations = [...allocationsByResident.entries()].map(([residentId, laborQd]) => ({ residentId, laborQd }));
  const reserved = reserveLabor(pool, { reservationId, assignmentId: assignment, allocations });
  if (!reserved.ok) return { ...reserved, laborQd: 0, work: [] };
  const spent = spendLabor(pool, {
    reservationId,
    operationId: `${reservationId}:spend`,
    work: rows.map((row) => ({
      residentId: String(row.residentId),
      dayKey: String(row.dayKey),
      laborQd: Math.max(0, Math.floor(Number(row.laborQd) || 0))
    }))
  });
  if (!spent.ok) return { ...spent, laborQd: 0, work: [] };
  const laborQd = rows.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row?.laborQd) || 0)), 0);
  return { ok: true, laborQd, work: rows, reservation: reserved.reservation, operation: spent.operation };
},

_buildingLaborCapacity(holding, building, workerContext = null, {
  unitsPerWorker = 1,
  purpose = "work",
  useEfficiency = true
} = {}) {
  if (!workerContext?.laborPool) return null;
  const rate = Math.max(0, this._safeNumber(unitsPerWorker, 0));
  const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
  if (!assignmentId || rate <= 0) return { capacity: 0, laborQd: 0, effectiveQd: 0, assignmentId };
  if (!(workerContext.laborThroughput instanceof Map)) workerContext.laborThroughput = new Map();
  const key = `${assignmentId}|${String(purpose)}|${rate}|${useEfficiency ? 1 : 0}`;
  const tracker = workerContext.laborThroughput.get(key) ?? { effectiveQd: 0, laborQd: 0, usedUnits: 0 };
  const slots = this._runtimeLaborSlots(holding, assignmentId, workerContext, { building, useEfficiency });
  const effectiveQd = slots.reduce((sum, slot) => sum + slot.efficiency, 0);
  const perWorker = Math.max(1, Number(workerContext.laborPool?.period?.capacityQdPerResident) || 20);
  const totalCapacity = Math.max(0, Math.floor(((tracker.effectiveQd + effectiveQd) * rate + 1e-9) / perWorker));
  return {
    capacity: Math.max(0, totalCapacity - Math.max(0, Math.floor(tracker.usedUnits))),
    laborQd: slots.length,
    effectiveQd,
    assignmentId
  };
},

_spendBuildingLaborForUnits(holding, building, workerContext = null, {
  units = 0,
  unitsPerWorker = 1,
  purpose = "work",
  useEfficiency = true
} = {}) {
  const requested = Math.max(0, Math.floor(this._safeNumber(units, 0)));
  if (!workerContext?.laborPool) return { ok: true, legacy: true, units: requested, laborQd: 0, effectiveQd: 0 };
  const rate = Math.max(0, this._safeNumber(unitsPerWorker, 0));
  const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
  if (!requested) return { ok: true, units: 0, laborQd: 0, effectiveQd: 0, assignmentId };
  if (!assignmentId || rate <= 0) return { ok: false, code: "no-labor-throughput", units: 0, laborQd: 0, effectiveQd: 0, assignmentId };
  if (!(workerContext.laborThroughput instanceof Map)) workerContext.laborThroughput = new Map();
  const trackerKey = `${assignmentId}|${String(purpose)}|${rate}|${useEfficiency ? 1 : 0}`;
  const tracker = workerContext.laborThroughput.get(trackerKey) ?? { effectiveQd: 0, laborQd: 0, usedUnits: 0 };
  const perWorker = Math.max(1, Number(workerContext.laborPool?.period?.capacityQdPerResident) || 20);
  const targetUnits = tracker.usedUnits + requested;
  const selected = [];
  let addedEffectiveQd = 0;
  const slots = this._runtimeLaborSlots(holding, assignmentId, workerContext, { building, useEfficiency });
  for (const slot of slots) {
    const capacity = Math.floor(((tracker.effectiveQd + addedEffectiveQd) * rate + 1e-9) / perWorker);
    if (capacity >= targetUnits) break;
    selected.push(slot);
    addedEffectiveQd += slot.efficiency;
  }
  const capacity = Math.floor(((tracker.effectiveQd + addedEffectiveQd) * rate + 1e-9) / perWorker);
  if (capacity < targetUnits) {
    return { ok: false, code: "insufficient-labor", units: Math.max(0, capacity - tracker.usedUnits), laborQd: 0, effectiveQd: 0, assignmentId };
  }
  const workByResidentDay = new Map();
  for (const slot of selected) {
    const key = `${slot.residentId}\u0000${slot.dayKey}`;
    const row = workByResidentDay.get(key) ?? { residentId: slot.residentId, dayKey: slot.dayKey, laborQd: 0 };
    row.laborQd += 1;
    workByResidentDay.set(key, row);
  }
  const committed = selected.length
    ? this._commitRuntimeLaborWork(assignmentId, [...workByResidentDay.values()], workerContext, { purpose })
    : { ok: true, laborQd: 0, work: [] };
  if (!committed.ok) return { ...committed, units: 0, effectiveQd: 0, assignmentId };
  tracker.effectiveQd += addedEffectiveQd;
  tracker.laborQd += selected.length;
  tracker.usedUnits += requested;
  workerContext.laborThroughput.set(trackerKey, tracker);
  return {
    ok: true,
    units: requested,
    laborQd: selected.length,
    effectiveQd: addedEffectiveQd,
    assignmentId,
    work: committed.work,
    totalLaborQd: tracker.laborQd,
    totalEffectiveQd: tracker.effectiveQd
  };
},

_spendAssignmentAvailableLabor(holding, assignmentId, workerContext = null, {
  building = null,
  purpose = "work",
  useEfficiency = false
} = {}) {
  if (!workerContext?.laborPool) return { ok: true, legacy: true, laborQd: 0, effectiveQd: 0, work: [] };
  const slots = this._runtimeLaborSlots(holding, assignmentId, workerContext, { building, useEfficiency });
  if (!slots.length) return { ok: false, code: "insufficient-labor", laborQd: 0, effectiveQd: 0, work: [] };
  const workByResidentDay = new Map();
  for (const slot of slots) {
    const key = `${slot.residentId}\u0000${slot.dayKey}`;
    const row = workByResidentDay.get(key) ?? { residentId: slot.residentId, dayKey: slot.dayKey, laborQd: 0 };
    row.laborQd += 1;
    workByResidentDay.set(key, row);
  }
  const committed = this._commitRuntimeLaborWork(assignmentId, [...workByResidentDay.values()], workerContext, { purpose });
  if (!committed.ok) return { ...committed, laborQd: 0, effectiveQd: 0, work: [] };
  return {
    ok: true,
    laborQd: slots.length,
    effectiveQd: slots.reduce((sum, slot) => sum + slot.efficiency, 0),
    work: committed.work
  };
},

_spendCommonTableLabor(holding, snapshot, workerContext = null, report = null) {
  if (!workerContext?.laborPool || !snapshot) return snapshot;
  const buildingsById = new Map((holding?.buildings?.list ?? []).map((building) => [String(building?.id ?? building?.templateId ?? ""), building]));
  for (const row of snapshot?.contributingInns ?? []) {
    const residentUsed = Math.max(0, Math.floor(this._safeNumber(row?.residentUsed, 0)));
    if (!residentUsed) continue;
    const building = buildingsById.get(String(row?.buildingId ?? ""));
    if (!building) continue;
    const spent = this._spendBuildingLaborForUnits(holding, building, workerContext, {
      units: residentUsed,
      unitsPerWorker: Math.max(1, Math.floor(this._safeNumber(row?.capacityPerWorker, 20))),
      purpose: "common-table",
      useEfficiency: false
    });
    row.laborQd = Math.max(0, spent.laborQd ?? 0);
    if (spent.ok) {
      report?.work?.push?.(`${row.buildingName || "Трактир"}: общий стол ${residentUsed} жителей, труд ${row.laborQd} QD.`);
    } else {
      report?.skipped?.push?.(`${row.buildingName || "Трактир"}: общий стол не обслужен — трудовой резерв изменился.`);
    }
  }
  return snapshot;
},

_spendConstructionCrewLabor(holding, crew, workerContext = null, { purpose = "construction" } = {}) {
  if (!workerContext?.laborPool) return { ok: true, legacy: true, laborQd: 0, laborFactor: 1, work: [] };
  const crewId = String(crew?.id ?? "").trim();
  const assignmentId = crewId ? `construction:${crewId}` : "";
  if (!assignmentId) return { ok: false, code: "missing-construction-assignment", laborQd: 0, laborFactor: 0, work: [] };
  const assignment = (workerContext.laborPool?.assignments ?? []).find((row) => String(row?.id ?? "") === assignmentId);
  const participantCount = Math.max(0, assignment?.primaryResidentIds?.length ?? 0);
  if (!participantCount) return { ok: false, code: "empty-construction-assignment", laborQd: 0, laborFactor: 0, work: [] };
  const spent = this._spendAssignmentAvailableLabor(holding, assignmentId, workerContext, { purpose, useEfficiency: false });
  const standardQd = participantCount * Math.max(1, Number(workerContext.laborPool?.period?.capacityQdPerResident) || 20);
  return {
    ...spent,
    laborFactor: spent.ok ? Math.max(0, Math.min(1, spent.laborQd / standardQd)) : 0,
    participantCount,
    standardQd
  };
},

_economyWorkerContext(holding, laborPool = null) {
  const peopleById = new Map();
  for (const person of holding?.people?.list ?? []) {
    const id = String(person?.id ?? "");
    if (!id) continue;
    peopleById.set(id, person);
  }

  const laborResidentsById = new Map((laborPool?.residents ?? []).map((row) => [String(row?.id ?? ""), row]));
  const laborBudgetsByResidentId = new Map((laborPool?.budgets ?? []).map((row) => [String(row?.residentId ?? ""), row]));
  const readyResidentIdsByAssignment = new Map();
  const laborReadyPeopleById = new Map();
  const activePeopleById = new Map();
  if (laborPool) {
    for (const [residentId, resident] of laborResidentsById) {
      const person = peopleById.get(residentId);
      const budget = laborBudgetsByResidentId.get(residentId);
      if (!person || resident?.readiness?.canSpend !== true || Math.max(0, Number(budget?.availableQd) || 0) <= 0) continue;
      laborReadyPeopleById.set(residentId, person);
      activePeopleById.set(residentId, person);
      const assignmentId = String(resident?.primaryAssignmentId ?? "");
      if (!assignmentId) continue;
      const ids = readyResidentIdsByAssignment.get(assignmentId) ?? new Set();
      ids.add(residentId);
      readyResidentIdsByAssignment.set(assignmentId, ids);
    }
  } else {
    for (const [residentId, person] of peopleById) {
      if (!person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0) activePeopleById.set(residentId, person);
    }
  }

  const buildingsByAssignment = new Map();
  const buildingWorkers = new Map();
  const overtimeByBuilding = new Map();
  for (const building of holding?.buildings?.list ?? []) {
    const id = String(building?.id ?? "").trim();
    const name = String(building?.name ?? "").trim();
    if (id) buildingsByAssignment.set(id, building);
    if (name) buildingsByAssignment.set(name, building);

    const rosterAssignedIds = (building?.assignedWorkerIds ?? []).filter(Boolean).map((workerId) => String(workerId));
    const assignmentId = id ? `building:${id}` : "";
    const assignedIds = laborPool
      ? [...(readyResidentIdsByAssignment.get(assignmentId) ?? [])]
      : rosterAssignedIds;
    buildingWorkers.set(building, {
      assignedIds,
      rosterAssignedIds,
      assignmentId,
      assignedPeople: assignedIds.map((workerId) => peopleById.get(workerId)).filter(Boolean),
      activeAssignedPeople: assignedIds.map((workerId) => activePeopleById.get(workerId)).filter(Boolean)
    });
    overtimeByBuilding.set(building, Boolean(this._buildingHasOvertimeProduction?.(building)));
  }

  const maintenanceOverdueTendays = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.economy?.treasury?.upkeepOverdueTendays, 0)));
  const maintenanceOperationalFactor = upkeepOperationalFactor(maintenanceOverdueTendays, (value, fallback = 0) => this._safeNumber(value, fallback));
  const context = {
    laborPool,
    laborResidentsById,
    laborBudgetsByResidentId,
    readyResidentIdsByAssignment,
    laborReadyPeopleById,
    peopleById,
    activePeopleById,
    buildingsByAssignment,
    buildingWorkers,
    overtimeByBuilding,
    assignedWorkerIds: laborPool
      ? new Set([...readyResidentIdsByAssignment.entries()]
        .filter(([assignmentId]) => !assignmentId.startsWith("unassigned:"))
        .flatMap(([, ids]) => [...ids]))
      : (this._assignedWorkerSet?.(holding) ?? new Set()),
    personBuildingEfficiency: new Map(),
    effectiveWorkers: new Map(),
    laborOperationId: laborPool?.period?.key ?? "",
    laborOperationSequence: new Map(),
    laborThroughput: new Map(),
    maintenanceOverdueTendays,
    maintenanceOperationalFactor
  };
  if (laborPool) {
    context.dynamicEffectiveWorkers = (sourceHolding, building) => this._remainingBuildingEffectiveWorkers(sourceHolding, building, context);
  }
  return context;
},

_scaledCosts(costs = [], cycles = 1) {
  return costs.map((cost) => ({ ...cost, qty: this._safeNumber(cost.qty, 0) * cycles })).filter((cost) => cost.qty > 0);
},

_affordableCycles(holding, costs = [], requestedCycles = 0) {
  const requested = Math.max(0, Math.floor(requestedCycles));
  if (!requested || !costs.length) return requested;
  let low = 0;
  let high = requested;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const plan = this._storageCanPay(holding, this._scaledCosts(costs, candidate));
    if (plan.ok) low = candidate;
    else high = candidate - 1;
  }
  return low;
},

_productionPeriodQd(period = "day") {
  const value = String(period ?? "day");
  if (value === "qd") return 1;
  if (value === "tenday") return 40;
  return 4;
},

_periodOccurrences(period = "day", qd = 0) {
  const step = Math.max(1, this._productionPeriodQd(period));
  return Math.max(0, Math.floor(this._safeNumber(qd, 0) / step));
},

_lineContentQuantity(building, line) {
  const id = String(line?.contentId ?? "");
  if (!id) return 0;
  const item = (building?.contents ?? []).find((row, index) => String(row?.id ?? `content-${index}`) === id);
  return Math.max(0, this._safeNumber(item?.qty ?? item?.quantity ?? item?.count, 0));
},

_collectProductionLine(holding, building, line, { ignoreWorkTime = false } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return { ok: false, message: "Нечего собирать." };
  const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
  if (!ignoreWorkTime && collectQd > 0) {
    const eff = this._safeNumber(this._buildingEffectiveWorkers(holding, building).total, 0);
    const available = Math.max(0, Math.floor(eff * this._workQdPerWorker(1)));
    if (available < collectQd) return { ok: false, message: `Не хватает рабочих QD для сбора (${available}/${collectQd}).` };
  }
  const resourceId = normalizeResourceId(line.resourceId, line.resource);
  const resourceName = resourceId === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(resourceId);
  const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
  const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, pending);
  line.pendingQty = 0;
  return { ok: true, message: `${resourceName}: собрано ${pending}; ${this._storagePlacementText(holding, placements)}.`, resourceId, resourceName, qty: pending, roomId, placements, source: building?.name || "Здание" };
},

_personBuildingEfficiency(holding, building, person, workerContext = null) {
  if (!person) return 0;
  const personId = String(person?.id ?? "");
  const cacheRoot = workerContext?.personBuildingEfficiency;
  let buildingCache = null;
  if (cacheRoot && personId) {
    buildingCache = cacheRoot.get(building);
    if (!buildingCache) {
      buildingCache = new Map();
      cacheRoot.set(building, buildingCache);
    }
    if (buildingCache.has(personId)) return buildingCache.get(personId);
  }
  let value = 1;
  const originalType = this._workerType(person);
  const match = this._workerTypeEffectForPerson(building, originalType);
  if (match.value) value += match.value;
  const traitEffect = this._workerTraitEffect?.(building, person);
  if (traitEffect?.value) value += traitEffect.value;
  const backgroundEffect = this._workerBackgroundEffect?.(building, person);
  if (backgroundEffect?.value) value += backgroundEffect.value;
  const globalEffect = this._buildingEfficiencyModifier?.(holding, building);
  if (globalEffect?.value) value += globalEffect.value;
  const result = Math.max(0, value);
  if (buildingCache && personId) buildingCache.set(personId, result);
  return result;
},

_assignedBuildingPeople(holding, building, workerContext = null) {
  const cached = workerContext?.buildingWorkers?.get(building)?.assignedPeople;
  if (cached) return cached;
  if (workerContext?.laborPool) {
    const assignmentId = `building:${String(building?.id ?? "")}`;
    const readyIds = workerContext.readyResidentIdsByAssignment?.get(assignmentId) ?? new Set();
    return [...readyIds].map((id) => workerContext?.peopleById?.get(id)).filter(Boolean);
  }
  const ids = (building?.assignedWorkerIds ?? []).filter(Boolean).map((id) => String(id));
  const people = holding?.people?.list ?? [];
  return ids.map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
},

_workerBudgetEntry(holding, person, budgets, workerContext = null) {
  const id = String(person?.id ?? "");
  const raw = budgets.get(id);
  if (raw && typeof raw === "object") return raw;
  const limit = this._personDailyWorkQdLimit(holding, person, workerContext);
  const entry = { available: this._safeNumber(raw, 0), spent: 0, limit };
  budgets.set(id, entry);
  return entry;
},

_personDailyWorkQdLimit(holding, person, workerContext = null) {
  if (workerContext?.laborPool) {
    return Math.max(1, Math.floor(this._safeNumber(workerContext.laborPool?.period?.laborQdPerDay, 2)));
  }
  const assigned = String(person?.workAssignment ?? "");
  const building = workerContext?.buildingsByAssignment?.get(assigned)
    ?? (holding?.buildings?.list ?? []).find((item) => String(item.id) === assigned || String(item.name) === assigned);
  const overtime = workerContext?.overtimeByBuilding?.has(building)
    ? workerContext.overtimeByBuilding.get(building)
    : this._buildingHasOvertimeProduction?.(building);
  if (building && overtime) return 3;
  return 2;
},

_runtimeLaborDayKey(workerContext = null, absoluteQd = null) {
  const pool = workerContext?.laborPool;
  if (!pool) return "";
  const numericQd = Number(absoluteQd);
  const matching = Number.isFinite(numericQd)
    ? (pool?.period?.days ?? []).find((day) => numericQd >= Number(day?.startQd) && numericQd <= Number(day?.endQd))
    : null;
  return String(matching?.key ?? pool?.period?.dayKeys?.[0] ?? "");
},

_resetWorkerBudgets(holding, budgets, workerContext = null, { absoluteQd = null } = {}) {
  budgets.clear();
  const people = workerContext?.laborPool
    ? workerContext.laborReadyPeopleById?.values?.()
    : (workerContext?.peopleById?.values?.() ?? holding?.people?.list ?? []);
  const dayKey = this._runtimeLaborDayKey(workerContext, absoluteQd);
  const loggedByResident = new Map();
  if (workerContext?.laborPool && dayKey) {
    for (const row of workerContext.laborPool?.workLog ?? []) {
      if (String(row?.dayKey ?? "") !== dayKey) continue;
      const residentId = String(row?.residentId ?? "");
      loggedByResident.set(residentId, (loggedByResident.get(residentId) ?? 0) + Math.max(0, Math.floor(this._safeNumber(row?.laborQd, 0))));
    }
  }
  for (const person of people) {
    const residentId = String(person.id);
    const normalLimit = this._personDailyWorkQdLimit(holding, person, workerContext);
    const poolBudget = workerContext?.laborBudgetsByResidentId?.get(residentId);
    const totalRemaining = workerContext?.laborPool
      ? Math.max(0, Math.floor(this._safeNumber(poolBudget?.availableQd, 0)))
      : normalLimit;
    const dayRemaining = workerContext?.laborPool
      ? Math.max(0, normalLimit - (loggedByResident.get(residentId) ?? 0))
      : normalLimit;
    const limit = Math.min(normalLimit, totalRemaining, dayRemaining);
    budgets.set(residentId, { available: 0, spent: 0, chargedQd: 0, limit, dayKey });
  }
},

_accrueWorkerBudgets(holding, budgets, workerContext = null) {
  // Внутри дня житель получает по 1 рабочему QD за прошедший QD,
  // но суммарно не больше дневного лимита: 2 QD обычно, 3 QD при переработке.
  const people = workerContext?.laborPool
    ? workerContext.laborReadyPeopleById?.values?.()
    : (workerContext?.peopleById?.values?.() ?? holding?.people?.list ?? []);
  for (const person of people) {
    const entry = this._workerBudgetEntry(holding, person, budgets, workerContext);
    if (!workerContext?.laborPool) entry.limit = this._personDailyWorkQdLimit(holding, person, workerContext);
    const room = Math.max(0, entry.limit - entry.spent - entry.available);
    if (room > 0) entry.available += Math.min(1, room);
  }
},

_availableEffectiveWorkQd(holding, building, budgets, workerContext = null) {
  let total = 0;
  const infrastructureFactor = Math.max(0, Math.min(1, this._safeNumber(workerContext?.maintenanceOperationalFactor, 1)));
  for (const person of this._assignedBuildingPeople(holding, building, workerContext)) {
    const entry = this._workerBudgetEntry(holding, person, budgets, workerContext);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    total += this._personBuildingEfficiency(holding, building, person, workerContext) * infrastructureFactor * budget;
  }
  return Math.max(0, total);
},

_spendBuildingWorkerQd(holding, building, budgets, needed = 0, workerContext = null) {
  // Реальное рабочее время. Используется для сбора: 1 QD сбора всегда стоит 1 QD времени,
  // независимо от производственной эффективности работника.
  const infrastructureFactor = Math.max(0, Math.min(1, this._safeNumber(workerContext?.maintenanceOperationalFactor, 1)));
  const baseNeeded = Math.max(0, this._safeNumber(needed, 0));
  let rest = infrastructureFactor > 0 ? baseNeeded / infrastructureFactor : (baseNeeded > 0 ? Number.POSITIVE_INFINITY : 0);
  let spent = 0;
  if (!rest) return { ok: true, spent: 0 };
  const assigned = this._assignedBuildingPeople(holding, building, workerContext);
  const available = assigned.reduce((sum, person) => sum + Math.max(0, this._safeNumber(this._workerBudgetEntry(holding, person, budgets, workerContext).available, 0)), 0);
  // Сбор атомарен: частично списанное время без отдельного прогресса иначе
  // исчезало бы при следующей попытке и могло навсегда заблокировать строку.
  if (available + 0.0001 < rest) return { ok: false, spent: available };
  const planned = [];
  for (const person of assigned) {
    if (rest <= 0) break;
    const entry = this._workerBudgetEntry(holding, person, budgets, workerContext);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    const take = Math.min(budget, rest);
    const nextSpent = this._safeNumber(entry.spent, 0) + take;
    const nextCharged = Math.min(entry.limit, Math.ceil(nextSpent - 1e-9));
    planned.push({ person, entry, take, nextSpent, nextCharged, chargeQd: Math.max(0, nextCharged - Math.max(0, Math.floor(this._safeNumber(entry.chargedQd, 0)))) });
    rest -= take;
    spent += take;
  }
  if (rest > 0.0001) return { ok: false, spent: available };
  const chargeRows = planned.filter((row) => row.chargeQd > 0).map((row) => ({
    residentId: String(row.person?.id ?? ""),
    dayKey: String(row.entry?.dayKey ?? ""),
    laborQd: row.chargeQd
  }));
  if (workerContext?.laborPool && chargeRows.length) {
    const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
    const committed = this._commitRuntimeLaborWork(assignmentId, chargeRows, workerContext, { purpose: "production-collection" });
    if (!committed.ok) return { ok: false, spent: 0, laborError: committed };
  }
  for (const row of planned) {
    row.entry.available = Math.max(0, this._safeNumber(row.entry.available, 0) - row.take);
    row.entry.spent = row.nextSpent;
    row.entry.chargedQd = row.nextCharged;
  }
  return { ok: rest <= 0.0001, spent };
},

_spendBuildingEffectiveWorkQd(holding, building, budgets, needed = 0, workerContext = null) {
  // Производственное время. Эффективные работники покрывают больше эффективных QD
  // тем же реальным временем.
  let rest = Math.max(0, this._safeNumber(needed, 0));
  let spentReal = 0;
  let spentEffective = 0;
  const infrastructureFactor = Math.max(0, Math.min(1, this._safeNumber(workerContext?.maintenanceOperationalFactor, 1)));
  if (!rest) return { ok: true, spent: 0, spentEffective: 0 };
  const planned = [];
  for (const person of this._assignedBuildingPeople(holding, building, workerContext)) {
    if (rest <= 0) break;
    const entry = this._workerBudgetEntry(holding, person, budgets, workerContext);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    const efficiency = Math.max(0, this._personBuildingEfficiency(holding, building, person, workerContext)) * infrastructureFactor;
    if (efficiency <= 0.0001) continue;
    const realNeeded = rest / efficiency;
    const takeReal = Math.min(budget, realNeeded);
    const takeEffective = takeReal * efficiency;
    const nextSpent = this._safeNumber(entry.spent, 0) + takeReal;
    const nextCharged = Math.min(entry.limit, Math.ceil(nextSpent - 1e-9));
    planned.push({ person, entry, takeReal, takeEffective, nextSpent, nextCharged, chargeQd: Math.max(0, nextCharged - Math.max(0, Math.floor(this._safeNumber(entry.chargedQd, 0)))) });
    rest -= takeEffective;
    spentReal += takeReal;
    spentEffective += takeEffective;
  }
  const chargeRows = planned.filter((row) => row.chargeQd > 0).map((row) => ({
    residentId: String(row.person?.id ?? ""),
    dayKey: String(row.entry?.dayKey ?? ""),
    laborQd: row.chargeQd
  }));
  if (workerContext?.laborPool && chargeRows.length) {
    const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
    const committed = this._commitRuntimeLaborWork(assignmentId, chargeRows, workerContext, { purpose: "production" });
    if (!committed.ok) return { ok: false, spent: 0, spentEffective: 0, laborError: committed };
  }
  for (const row of planned) {
    row.entry.available = Math.max(0, this._safeNumber(row.entry.available, 0) - row.takeReal);
    row.entry.spent = row.nextSpent;
    row.entry.chargedQd = row.nextCharged;
  }
  return { ok: rest <= 0.0001, spent: spentReal, spentEffective };
},

_costsForUnits(costs = [], units = 0) {
  const count = Math.max(0, Math.floor(this._safeNumber(units, 0)));
  return costs.map((cost) => ({ ...cost, qty: this._safeNumber(cost.qty, 0) * count })).filter((cost) => cost.qty > 0);
},

_affordableUnitsForCosts(holding, costs = [], requestedUnits = 0) {
  const requested = Math.max(0, Math.floor(this._safeNumber(requestedUnits, 0)));
  if (!requested || !costs.length) return requested;
  let low = 0;
  let high = requested;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    const plan = this._storageCanPay(holding, this._costsForUnits(costs, candidate));
    if (plan.ok) low = candidate;
    else high = candidate - 1;
  }
  return low;
},

async _lineOutputForCycle(line, context = {}) {
  const base = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, 1));
  if (String(line?.formula ?? "").trim()) {
    const rolled = await this._rollFormulaTotal(line.formula, { ...context, base });
    // The production engine owns the whole-unit contract. Preserve the exact
    // formula result here so a fractional legacy formula is blocked visibly
    // instead of being silently rounded down.
    return { qty: Math.max(0, this._safeNumber(rolled.total, 0)), formula: `${line.formula} → ${rolled.result} = ${rolled.total}` };
  }
  return { qty: base, formula: "" };
},

async _collectLineToStorage(holding, building, line, budgets, report, { by = "building", neededResource = "", workerContext = null, receivedQd = null } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return 0;
  const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
  if (collectQd > 0) {
    const payer = by === "worker" ? building : building;
    const spent = this._spendBuildingWorkerQd(holding, payer, budgets, collectQd, workerContext);
    if (!spent.ok) {
      report.skipped.push(`${building.name || "Здание"}: не хватает рабочих QD для сбора (${spent.spent}/${collectQd}).`);
      return 0;
    }
  }
  const resourceId = normalizeResourceId(line.resourceId, line.resource);
  if (neededResource && normalizeResourceId(neededResource) !== resourceId) return 0;
  const resourceName = resourceId === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(resourceId);
  const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
  const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId, receivedQd, lotSource: "collection" }, pending);
  line.pendingQty = 0;
  this._pushProductionPlacement(report, holding, building.name || "Здание", resourceName, placements, by === "worker" ? " собрано работником-потребителем" : " собрано", resourceId);
  return pending;
},

async _autoCollectBuilding(holding, building, budgets, report, workerContext = null, { absoluteQd = null, shadowDay = false } = {}) {
  for (const line of building?.productionLines ?? []) {
    if (!line?.requiresCollection || String(line.autoCollect ?? "none") !== "building") continue;
    if (shadowDay && line?.daylightCollectionOnly) continue;
    await this._collectLineToStorage(holding, building, line, budgets, report, { by: "building", workerContext, receivedQd: absoluteQd });
  }
},

async _tryCollectResourceForConsumer(holding, consumerBuilding, resourceId, budgets, report, workerContext = null, { absoluteQd = null, shadowDay = false } = {}) {
  const wanted = normalizeResourceId(resourceId);
  let collected = 0;
  for (const sourceBuilding of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(sourceBuilding).value !== "built") continue;
    for (const line of sourceBuilding?.productionLines ?? []) {
      if (!line?.requiresCollection || String(line.autoCollect ?? "none") !== "worker") continue;
      if (shadowDay && line?.daylightCollectionOnly) continue;
      if (normalizeResourceId(line.resourceId, line.resource) !== wanted) continue;
      // В этом режиме рабочий здания-потребителя тратит время, чтобы забрать готовый ресурс из другого здания.
      const pending = Math.max(0, Math.floor(this._safeNumber(line.pendingQty, 0)));
      if (!pending) continue;
      const collectQd = Math.max(0, this._safeNumber(line.collectQd, 0));
      if (collectQd > 0) {
        const spent = this._spendBuildingWorkerQd(holding, consumerBuilding, budgets, collectQd, workerContext);
        if (!spent.ok) continue;
      }
      const resourceName = wanted === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(wanted);
      const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
      const placements = this._storageAddWithOverflow(holding, { resourceId: wanted, name: resourceName, roomId, receivedQd: absoluteQd, lotSource: "collection" }, pending);
      line.pendingQty = 0;
      collected += pending;
      this._pushProductionPlacement(report, holding, consumerBuilding.name || "Здание", resourceName, placements, ` собрано у ${sourceBuilding.name || "здания"}`, wanted);
    }
  }
  return collected;
},

_productionCycleDependencies({ lineOutputForCycle = null } = {}) {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    resetWorkerBudgets: (holding, budgets, workerContext, context) => this._resetWorkerBudgets(holding, budgets, workerContext, context),
    accrueWorkerBudgets: (holding, budgets, workerContext) => this._accrueWorkerBudgets(holding, budgets, workerContext),
    getSeasonSnapshot: (holding, step = 0) => {
      const calendar = holding?.gm?.calendaria ?? {};
      const lastDateTime = calendar.lastDateTime;
      if (!lastDateTime || typeof lastDateTime !== "object") {
        const currentSnapshot = getCalendariaSnapshot?.() ?? null;
        if (currentSnapshot?.available) return currentSnapshot;
        return getCalendariaSeasonSnapshot(null, calendar.lastDateText ?? calendar.lastDateKey) ?? null;
      }
      const dateTime = step > 0 ? addCalendariaQd(lastDateTime, step) : lastDateTime;
      return getCalendariaSeasonSnapshot(dateTime, calendar.lastDateText ?? calendar.lastDateKey);
    },
    isShadowDayQd: (absoluteQd = 1) => albugrirCalendarDay(Math.ceil(Math.max(1, this._safeNumber(absoluteQd, 1)) / ALBUGRIR_QD_PER_DAY)).shadowDay,
    buildingStatus: (building) => this._buildingStatus(building),
    buildingFunctions: (building) => this._buildingFunctions(building),
    enterpriseCapitalReady: (building, holding) => enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) }),
    lineSeasonAllowed: (line, snapshot) => this._lineSeasonAllowed ? this._lineSeasonAllowed(line, snapshot) : true,
    productionCadenceWindow,
    normalizeResourceId,
    resourceLabel,
    lineContentQuantity: (building, line) => this._lineContentQuantity(building, line),
    buildingOperationalFactor: (_holding, _building, workerContext) => Math.max(0, Math.min(1, this._safeNumber(workerContext?.maintenanceOperationalFactor, 1))),
    buildingEffectiveWorkers: (holding, building, workerContext) => this._buildingEffectiveWorkers(holding, building, workerContext),
    lineOutputForCycle: lineOutputForCycle ?? ((line, context) => this._lineOutputForCycle(line, context)),
    parseResourceCosts: (text) => this._parseResourceCosts(text),
    validateProductionRecipe,
    productionRecipeBlockerText,
    isWholeEconomyQuantity,
    costsForUnits: (costs, units) => this._costsForUnits(costs, units),
    scaledCosts: (costs, cycles) => this._scaledCosts(costs, cycles),
    storageCanPay: (holding, costs) => this._storageCanPay(holding, costs),
    storagePay: (holding, costs) => this._storagePay(holding, costs),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    pushProductionPlacement: (report, holding, source, resource, placements, extra, resourceId) => this._pushProductionPlacement(report, holding, source, resource, placements, extra, resourceId),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries),
    autoCollectBuilding: (holding, building, budgets, report, workerContext, context) => this._autoCollectBuilding(holding, building, budgets, report, workerContext, context),
    assignedBuildingPeople: (holding, building, workerContext) => this._assignedBuildingPeople(holding, building, workerContext),
    workerBudgetEntry: (holding, person, budgets, workerContext) => this._workerBudgetEntry(holding, person, budgets, workerContext),
    personBuildingEfficiency: (holding, building, person, workerContext) => this._personBuildingEfficiency(holding, building, person, workerContext),
    availableEffectiveWorkQd: (holding, building, budgets, workerContext) => this._availableEffectiveWorkQd(holding, building, budgets, workerContext),
    spendBuildingEffectiveWorkQd: (holding, building, budgets, needed, workerContext) => this._spendBuildingEffectiveWorkQd(holding, building, budgets, needed, workerContext),
    storageQuantity: (holding, resource) => this._storageQuantity(holding, resource),
    tryCollectResourceForConsumer: (holding, building, resourceId, budgets, report, workerContext, context) => this._tryCollectResourceForConsumer(holding, building, resourceId, budgets, report, workerContext, context),
    affordableUnitsForCosts: (holding, costs, units) => this._affordableUnitsForCosts(holding, costs, units),
    formatNumber: (value) => this._formatNumber(value)
  };
},

async _runProductionCycleForQd(holding, qd, report, { buildings = holding?.buildings?.list ?? [], budgets = new Map(), workerContext = null, lineOutputForCycle = null } = {}) {
  return runProductionCycle({
    holding,
    qd,
    report,
    buildings,
    budgets,
    workerContext,
    dependencies: this._productionCycleDependencies({ lineOutputForCycle })
  });
},

async _runPassiveIncomeForQd(holding, qd = 0, report = null, workerContext = null) {
  const periods = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 40);
  if (!periods) return { revenue: 0, buildings: 0 };
  let revenue = 0;
  let creditedBuildings = 0;
  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    if (!this._buildingFunctions(building).income) continue;
    if (!enterpriseCapitalReady(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) })) continue;
    const income = building.income ?? {};
    const base = this._safeNumber(income.base, 0);
    const perWorker = this._safeNumber(income.perWorker, 0);
    const formula = String(income.formula ?? "").trim();
    if (!formula && base === 0 && perWorker === 0) continue;

    let effectiveWorkerPeriods = 0;
    let assigned = 0;
    let laborQd = 0;
    if (workerContext?.laborPool) {
      const assignmentId = this._runtimeLaborAssignmentId(building, workerContext);
      const labor = this._spendAssignmentAvailableLabor(holding, assignmentId, workerContext, {
        building,
        purpose: "passive-income",
        useEfficiency: true
      });
      if (!labor.ok || labor.effectiveQd <= 0) {
        report?.skipped?.push?.(`${building.name || "Здание"}: пассивный доход не получен — после производства и обслуживания не осталось рабочих QD.`);
        continue;
      }
      const perWorkerQd = Math.max(1, Number(workerContext.laborPool?.period?.capacityQdPerResident) || 20);
      effectiveWorkerPeriods = labor.effectiveQd / perWorkerQd;
      laborQd = labor.laborQd;
      assigned = new Set(labor.work.map((row) => String(row?.residentId ?? "")).filter(Boolean)).size;
    } else {
      const workers = this._buildingEffectiveWorkers(holding, building, workerContext);
      effectiveWorkerPeriods = Math.max(0, this._safeNumber(workers.total, 0)) * periods;
      assigned = Math.max(0, this._safeNumber(workers.assigned, 0));
    }
    if (effectiveWorkerPeriods <= 0) continue;

    let total = (base * Math.min(periods, effectiveWorkerPeriods)) + (perWorker * effectiveWorkerPeriods);
    let formulaResult = "";
    if (formula) {
      total = 0;
      let remainingWorkerPeriods = effectiveWorkerPeriods;
      for (let index = 0; index < periods && remainingWorkerPeriods > 0.0001; index += 1) {
        const sliceWorkers = Math.min(Math.max(1, assigned), remainingWorkerPeriods);
        const coverage = Math.min(1, remainingWorkerPeriods);
        const rolled = await this._rollFormulaTotal(formula, {
          eff: sliceWorkers,
          workers: assigned,
          base,
          cycles: periods,
          qd,
          workqd: sliceWorkers * 20
        });
        total += rolled.total * coverage;
        formulaResult = rolled.result;
        report?.formulas?.push?.(`${building.name || "Здание"} / Доход ${index + 1}/${periods}: ${formula} → ${rolled.result} = ${rolled.total}; занятость ${this._formatNumber(coverage * 100)}%`);
        remainingWorkerPeriods = Math.max(0, remainingWorkerPeriods - Math.max(1, assigned));
      }
    }
    total = Math.max(0, Math.floor(total));
    if (!total) continue;
    this._addMoney(holding, total);
    revenue += total;
    creditedBuildings += 1;
    report?.income?.push?.(`${building.name || "Здание"}: Деньги +${total}${formulaResult ? ` (${formulaResult})` : ""}${laborQd ? `; труд ${laborQd} QD` : ""}`);
    appendEconomyLedger(report, {
      domain: "income",
      kind: "money",
      resourceId: "money",
      name: "Деньги",
      qty: total,
      roomId: "treasury",
      sourceId: building.id,
      source: building.name || "Здание",
      note: `${formulaResult ? `Формула: ${formulaResult}` : "Пассивный доход"}${laborQd ? `; труд ${laborQd} QD` : ""}`
    });
  }
  return { revenue, buildings: creditedBuildings };
},

async _runEconomyForQd(holding, periodQd = 40, { laborPool = null, operationId = "", payrollContext = null } = {}) {
  const qd = Math.max(1, Math.floor(this._safeNumber(periodQd, 40)));
  const label = this._periodLabel(qd);
  const snapshot = laborPool
    ?? (typeof this._buildTendayLaborPool === "function" ? this._buildTendayLaborPool(holding) : laborPoolForHolding(holding));
  const labor = typeof this._laborPoolStatus === "function" ? this._laborPoolStatus(snapshot) : laborPoolStatus(snapshot);
  const report = { periodQd: qd, periodLabel: label, produced: [], consumed: [], spoiled: [], skipped: [], income: [], formulas: [], work: [], ledger: [], labor, payroll: { ready: true, fixedDueCopper: 0, shareDueCopper: 0, currentDueCopper: 0, paidCopper: 0, arrearsCopper: 0, rows: [], lines: [] }, fleet: { targetQd: 0, advanced: [], completed: [], crises: [] }, food: { needed: 0, eaten: 0, hungryResidentDays: 0, availableBeforeConsumption: 0, nutritionTags: [], nutritionDiversity: 0, nutritionDiversityLabel: "Нет питания", lines: [] }, capital: { blocked: 0, shortfallCopper: 0, annualRenewalCopper: 0, lines: [] }, services: { demand: 0, capacity: 0, served: 0, unserved: 0, foodPersonDays: 0, revenue: 0, lines: [] }, construction: { attempts: 0, completed: 0, lines: [] }, trade: { buyers: 0, sold: 0, revenue: 0, demand: 0, capacity: 0, servedBuyers: 0, unserved: 0, capacityShortfall: 0, stockShortfall: 0, purchases: [], lines: [] }, treasury: { spent: 0, deficit: 0, lines: [] } };
  if (!labor.ready) {
    report.blocked = true;
    report.skipped.push(labor.message);
    return report;
  }
  const preparedOperationId = String(operationId ?? "").trim();
  const foodProvisionGate = preparedOperationId
    ? foodProvisionReadiness((holding?.people?.list ?? []).filter((person) => !person?.dead))
    : { ready: true, blockers: [], message: "Legacy direct call: food provision preflight skipped." };
  report.food.provision = foodProvisionGate;
  if (!foodProvisionGate.ready) {
    report.blocked = true;
    report.skipped.push(foodProvisionGate.message);
    return report;
  }
  const payrollGate = preparedOperationId
    ? (payrollContext ?? this._payrollReadinessContext(holding, { laborPool: snapshot, qd }))
    : null;
  if (payrollGate && !payrollGate.ready) {
    report.blocked = true;
    report.payroll = { ready: false, blockers: payrollGate.blockers, rows: [], lines: [payrollGate.message] };
    report.skipped.push(payrollGate.message);
    return report;
  }
  const commonTableMorale = this._commonTableMoraleState(holding);
  commonTableMorale.activeMoraleBonus = commonTableMorale.pendingMoraleBonus;
  commonTableMorale.pendingMoraleBonus = 0;
  report.food.activeMoraleBonus = commonTableMorale.activeMoraleBonus;
  report.food.pendingMoraleBonus = 0;
  report.food.earnedForNextTenday = false;
  const buildings = holding?.buildings?.list ?? [];
  const budgets = new Map();
  const workerContext = this._economyWorkerContext(holding, snapshot);
  workerContext.laborOperationId = preparedOperationId || snapshot?.period?.key || "tenday";
  report.treasury.activeUpkeepOverdueTendays = workerContext.maintenanceOverdueTendays;
  report.treasury.activeUpkeepOperationalFactor = workerContext.maintenanceOperationalFactor;
  if (workerContext.maintenanceOperationalFactor < 1) {
    report.treasury.lines.push(`В этом десятнике действует просрочка содержания ${workerContext.maintenanceOverdueTendays} дес.: мощность зданий ${Math.round(workerContext.maintenanceOperationalFactor * 100)}%.`);
  }

  for (const building of buildings) {
    if (this._buildingStatus(building).value !== "built") continue;
    const functions = this._buildingFunctions(building);
    if (!functions.production && !functions.income) continue;
    const state = enterpriseCapitalState(building, (value, fallback = 0) => this._safeNumber(value, fallback), { landRightsProvided: Boolean(holding?.gm?.economy?.landRightsProvided) });
    if (!state.enabled) continue;
    report.capital.annualRenewalCopper += state.annualRenewalCopper;
    if (state.ready) continue;
    report.capital.blocked += 1;
    report.capital.shortfallCopper += state.shortfallCopper;
    report.capital.lines.push(`${building.name || "Здание"}: работа остановлена, не обеспечено ${this._formatCopperCurrency(state.shortfallCopper)} капитала из ${this._formatCopperCurrency(state.requiredCopper)}.`);
  }

  // Logistics is resolved at the boundary of the elapsed period. Cargo that
  // reaches the settlement during that period is therefore available to the
  // production, food, construction, and trade phases resolved below.
  this._advanceFleetForQd(holding, qd, report);
  this._advanceMarketShipmentsForQd(holding, qd, report);
  this._advanceMarketExportsForQd(holding, qd, report, { operationId: preparedOperationId });
  await this._runProductionCycleForQd(holding, qd, report, { buildings, budgets, workerContext });

  report.food.availableBeforeConsumption = this._storedFoodPersonDays(holding);
  this._runFoodConsumptionForQd(holding, qd, report);
  const foodAllocation = settleResidentFood({
    holding,
    days: Math.floor(qd / ALBUGRIR_QD_PER_DAY),
    eatenPersonDays: report.food.eaten,
    targetQd: Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)) + qd,
    operationId: preparedOperationId ? `${preparedOperationId}:food-allocation` : ""
  });
  report.food.allocation = foodAllocation;
  report.food.hungryResidents = foodAllocation.hungryResidents;
  if (foodAllocation.hungryResidents > 0) {
    report.food.lines.push(`Личный паёк: ${foodAllocation.hungryResidents} жит. получили неполное питание; очередь полного пайка сдвинута на следующий десятник.`);
  } else if (foodAllocation.requiredPersonDays > 0) {
    report.food.lines.push(`Личный паёк: все ${foodAllocation.fullyFedResidents} жит. получили полный паёк.`);
  }
  const commonTableSnapshot = this._residentMealCapacitySnapshot(holding, workerContext);
  this._spendCommonTableLabor(holding, commonTableSnapshot, workerContext, report);
  const earnedForNextTenday = commonTableSnapshot.residentCount > 0
    && report.food.fullFed === true
    && report.food.richDiet === true
    && commonTableSnapshot.fullyCovered === true;
  commonTableMorale.pendingMoraleBonus = earnedForNextTenday ? 1 : 0;
  report.food.commonTable = commonTableSnapshot;
  report.food.pendingMoraleBonus = commonTableMorale.pendingMoraleBonus;
  report.food.earnedForNextTenday = earnedForNextTenday;
  if (report.food.activeMoraleBonus) {
    report.food.lines.push("Действует бонус прошлого общего стола: +1 к довольству поселения.");
  }
  if (commonTableSnapshot.residentCount > 0) {
    report.food.lines.push(`Общий стол: ${commonTableSnapshot.coveredResidents}/${commonTableSnapshot.residentCount} жителей, вместимость ${commonTableSnapshot.totalCapacity}.`);
    report.food.lines.push(earnedForNextTenday
      ? "Богатый рацион подан всем жителям: +1 к довольству в следующем десятнике."
      : "Бонус общего стола не получен: нужны полная сытость, богатый рацион и места для всех жителей.");
  }
  this._runHospitalityServicesForQd(holding, qd, report, workerContext, commonTableSnapshot);
  await this._runTradeForQd(holding, qd, report, workerContext);
  await this._runPassiveIncomeForQd(holding, qd, report, workerContext);
  this._runConstructionCrewsForQd(holding, qd, report, { workerContext });
  if (preparedOperationId) {
    this._runPayrollAndTreasuryCostsForQd(holding, qd, report, {
      laborPool: snapshot,
      payrollContext: payrollGate,
      operationId,
      workerContext
    });
  } else {
    // Characterization helpers and legacy direct callers retain the old
    // aggregate salary path. Prepared Economy V2 tendays always supply an id
    // and therefore cannot charge the old daily wage a second time.
    this._runTreasuryCostsForQd(holding, qd, report, workerContext);
  }

  report.labor = {
    ...laborPoolStatus(snapshot),
    spentQd: Math.max(0, Number(snapshot?.totals?.spentQd) || 0),
    remainingQd: Math.max(0, Number(snapshot?.totals?.availableQd) || 0),
    workedDays: Math.max(0, Number(snapshot?.totals?.workedDays) || 0)
  };

  return report;
},

_advanceFleetForQd(holding, qd = 0, report = null) {
  const targetQd = Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)) + Math.max(0, this._safeNumber(qd, 0));
  const fleetReport = advanceFleetToQd(holding, targetQd, {
    completedAt: new Date().toISOString(),
    operationId: `fleet-qd-${targetQd}`
  });
  if (report) {
    report.fleet = fleetReport;
    for (const progress of fleetReport.advanced) {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === String(progress.vesselId ?? ""));
      report.work.push(`Флот: «${vessel?.name ?? "Корабль"}» продолжает рейс, осталось ${progress.remainingQd} QD.`);
    }
    for (const arrival of fleetReport.completed) {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === String(arrival.vesselId ?? ""));
      report.work.push(`Флот: «${vessel?.name ?? "Корабль"}» завершил рейс; касса ${arrival.cashDeltaCopper >= 0 ? "+" : ""}${arrival.cashDeltaCopper} медных.`);
    }
    for (const transfer of fleetReport.completedTransfers) {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === String(transfer.vesselId ?? ""));
      report.work.push(`Флот: завершён перевод «${vessel?.name ?? "Корабль"}»; получено ${transfer.netCopper} медных после комиссии.`);
    }
    for (const crisis of fleetReport.crises) {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === String(crisis.vesselId ?? ""));
      report.work.push(`Флот: «${vessel?.name ?? "Корабль"}» остановлен кризисом: ${crisis.message}`);
    }
  }
  return fleetReport;
},

_marketShipmentDependencies({ receivedQd = null } = {}) {
  return {
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, { ...resource, receivedQd, lotSource: "market-arrival" }, qty),
    appendStorageLog: (holding, entries) => this._appendStorageLog(holding, entries),
    formatCurrency: (value) => this._formatCopperCurrency(value)
  };
},

_advanceMarketShipmentsForQd(holding, qd = 0, report = null) {
  const shipmentReport = advanceMarketShipments({
    holding,
    elapsedQd: qd,
    deliveredAt: new Date().toISOString(),
    dependencies: this._marketShipmentDependencies({ receivedQd: Math.max(0, this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)) + Math.max(0, this._safeNumber(qd, 0)) })
  });
  if (!shipmentReport.ok) throw new Error(shipmentReport.message || "Не удалось обработать прибытие рыночной поставки.");
  if (report) {
    report.market = shipmentReport;
    for (const delay of shipmentReport.delayed) {
      appendHoldingOperation(holding, {
        operationId: delay.operationId,
        type: "market-purchase",
        createdAt: delay.delayedAt,
        title: `Задержана поставка: ${delay.marketLabel}`,
        summary: `Маршрутное происшествие увеличило срок на ${delay.delayQd} QD. Груз продолжит движение автоматически.`,
        payload: { orderId: delay.orderId, orderOperationId: delay.orderOperationId, delayQd: delay.delayQd, automatic: true }
      });
      report.work.push(`Рынок: поставка «${delay.marketLabel}» задержана на ${delay.delayQd} QD.`);
      appendEconomyLedger(report, {
        domain: "market",
        kind: "shipment",
        name: delay.marketLabel,
        qty: delay.delayQd,
        sourceId: delay.orderOperationId,
        source: delay.marketLabel,
        status: "delayed",
        operationId: delay.operationId,
        note: `Задержка ${delay.delayQd} QD`
      });
    }
    for (const loss of shipmentReport.lost) {
      appendHoldingOperation(holding, {
        operationId: loss.operationId || `${loss.orderOperationId}:loss`,
        type: "market-purchase",
        createdAt: loss.lostAt,
        title: `Утрачена поставка: ${loss.marketLabel}`,
        summary: loss.payoutCopper > 0
          ? `Груз утрачен. Страховая выплата: ${this._formatCopperCurrency(loss.payoutCopper)}.`
          : "Груз утрачен без страховой выплаты.",
        payload: { orderId: loss.orderId, orderOperationId: loss.orderOperationId, payoutCopper: loss.payoutCopper, automatic: true }
      });
      report.work.push(`Рынок: поставка «${loss.marketLabel}» утрачена${loss.payoutCopper > 0 ? `, страховка ${this._formatCopperCurrency(loss.payoutCopper)}` : ""}.`);
      appendEconomyLedger(report, [{
        domain: "market",
        kind: "shipment",
        name: loss.marketLabel,
        qty: -Math.max(1, loss.cargoCount || 1),
        sourceId: loss.orderOperationId,
        source: loss.marketLabel,
        status: "lost",
        operationId: loss.operationId,
        note: "Груз утрачен"
      }, ...(loss.payoutCopper > 0 ? [{
        domain: "market",
        kind: "money",
        resourceId: "money",
        name: "Страховая выплата",
        qty: loss.payoutCopper,
        roomId: "treasury",
        source: loss.marketLabel,
        status: "paid",
        operationId: loss.operationId,
        note: "Выплата за утраченный груз",
        meta: { alreadyLogged: true, storageKind: "market-insurance" }
      }] : [])]);
    }
    for (const arrival of shipmentReport.delivered) {
      appendHoldingOperation(holding, {
        operationId: arrival.operationId,
        type: "market-purchase",
        createdAt: arrival.deliveredAt,
        title: `Прибыла поставка: ${arrival.marketLabel}`,
        summary: `${arrival.delivered.length} грузовых позиций доставлено после прохождения QD.`,
        payload: { orderId: arrival.orderId, orderOperationId: arrival.orderOperationId, automatic: true }
      });
      report.work.push(`Рынок: прибыла поставка «${arrival.marketLabel}», грузовых позиций ${arrival.delivered.length}.`);
      appendEconomyLedger(report, arrival.delivered.map((cargo) => ({
        domain: "market",
        kind: cargo.sourceType === "item" ? "item" : "resource",
        resourceId: cargo.sourceType === "item" ? "" : String(arrival.storageEntries?.find((entry) => entry.name === cargo.name && entry.roomId === cargo.roomId)?.resourceId ?? "custom"),
        name: cargo.name,
        qty: cargo.qty,
        roomId: cargo.roomId,
        sourceId: arrival.orderOperationId,
        source: arrival.marketLabel,
        status: "delivered",
        operationId: arrival.operationId,
        note: "Прибытие рыночной поставки",
        meta: { alreadyLogged: true, storageKind: "market-arrival" }
      })));
    }
  }
  return shipmentReport;
},

_advanceMarketExportsForQd(holding, qd = 0, report = null, { operationId = "" } = {}) {
  const market = holding?.special?.market;
  const exportBook = market?.exportBook;
  const inTransit = (exportBook?.orders ?? []).filter((order) => String(order?.status ?? "") === "in-transit");
  if (!inTransit.length) {
    const empty = { ok: true, replay: false, advancedQd: Math.max(0, Math.floor(this._safeNumber(qd, 0))), delivered: [], lost: [], inTransit: [], treasuryDeltaCopper: 0, recognizedGrossCopper: 0 };
    if (report) report.marketExports = empty;
    return empty;
  }
  if (!market?.liquidity || typeof market.liquidity !== "object") {
    throw new Error("Не найден единый реестр спроса для отправленных экспортных контрактов.");
  }
  const targetQd = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.calendaria?.lastQd, 0) + this._safeNumber(qd, 0)));
  const advanceOperationId = String(operationId ?? "").trim()
    ? `${String(operationId).trim()}:market-exports`
    : `market-export-advance:${String(holding?.id ?? "holding")}:${targetQd}`;
  const exportReport = advanceMarketExports({
    holding,
    exportBook,
    elapsedQd: Math.max(0, Math.floor(this._safeNumber(qd, 0))),
    operationId: advanceOperationId,
    resolvedAt: new Date().toISOString(),
    dependencies: { demand: createMarketExportLiquidityDemandAdapter(market.liquidity) }
  });
  if (!exportReport.ok) throw new Error(exportReport.message || "Не удалось обработать внешние экспортные контракты.");
  if (!report) return exportReport;
  report.marketExports = exportReport;
  const orderById = new Map((exportBook.orders ?? []).map((order) => [String(order?.id ?? order?.operationId ?? ""), order]));
  for (const result of exportReport.delivered ?? []) {
    const order = orderById.get(String(result?.orderId ?? "")) ?? {};
    const marketLabel = String(order?.quoteSnapshot?.market?.label ?? "Внешний рынок");
    const offerName = String(order?.quoteSnapshot?.offer?.name ?? order?.cargoSnapshot?.name ?? "Товар");
    const settlement = result?.settlement ?? order?.settlement ?? {};
    const cashDelta = Number(settlement?.cashDeltaCopper ?? settlement?.netCopper) || 0;
    appendHoldingOperation(holding, {
      operationId: String(result?.resolutionOperationId ?? `${advanceOperationId}:${result?.orderId}:delivered`),
      type: "market-export",
      createdAt: String(order?.deliveredAt ?? new Date().toISOString()),
      title: `Завершён экспорт: ${offerName}`,
      summary: `${marketLabel} принял ${Math.max(0, Number(order?.qty) || 0)} ед.; итог контракта ${this._formatCopperCurrency(settlement?.netCopper ?? 0)}.`,
      payload: { orderId: result?.orderId, outcome: "delivered", grossCopper: settlement?.grossCopper ?? 0, netCopper: settlement?.netCopper ?? 0, automatic: true }
    });
    report.work.push(`Экспорт: «${offerName}» принят рынком «${marketLabel}», чистый итог ${this._formatCopperCurrency(settlement?.netCopper ?? 0)}.`);
    appendEconomyLedger(report, {
      domain: "market",
      kind: "money",
      resourceId: "money",
      name: `Экспорт: ${offerName}`,
      qty: cashDelta,
      roomId: "treasury",
      sourceId: String(order?.operationId ?? result?.orderId ?? ""),
      source: marketLabel,
      status: "delivered",
      operationId: String(result?.resolutionOperationId ?? ""),
      note: `Получена выручка; полный итог контракта ${this._formatCopperCurrency(settlement?.netCopper ?? 0)}`,
      meta: { alreadyLogged: true, storageKind: "market-export-delivery" }
    });
  }
  for (const result of exportReport.lost ?? []) {
    const order = orderById.get(String(result?.orderId ?? "")) ?? {};
    const marketLabel = String(order?.quoteSnapshot?.market?.label ?? "Внешний рынок");
    const offerName = String(order?.quoteSnapshot?.offer?.name ?? order?.cargoSnapshot?.name ?? "Товар");
    const settlement = result?.settlement ?? order?.settlement ?? {};
    const cashDelta = Number(settlement?.cashDeltaCopper ?? settlement?.netCopper) || 0;
    appendHoldingOperation(holding, {
      operationId: String(result?.resolutionOperationId ?? `${advanceOperationId}:${result?.orderId}:lost`),
      type: "market-export",
      createdAt: String(order?.lostAt ?? new Date().toISOString()),
      title: `Утрачен экспорт: ${offerName}`,
      summary: settlement?.insurancePayoutCopper > 0
        ? `Груз утрачен; страховая выплата ${this._formatCopperCurrency(settlement.insurancePayoutCopper)}, итог контракта ${this._formatCopperCurrency(settlement?.netCopper ?? 0)}.`
        : `Груз утрачен без выплаты; итог контракта ${this._formatCopperCurrency(settlement?.netCopper ?? 0)}.`,
      payload: { orderId: result?.orderId, outcome: "lost", insurancePayoutCopper: settlement?.insurancePayoutCopper ?? 0, netCopper: settlement?.netCopper ?? 0, automatic: true }
    });
    report.work.push(`Экспорт: «${offerName}» утрачен по пути к рынку «${marketLabel}»${settlement?.insurancePayoutCopper > 0 ? `; страховка ${this._formatCopperCurrency(settlement.insurancePayoutCopper)}` : ""}.`);
    if (cashDelta) appendEconomyLedger(report, {
      domain: "market",
      kind: "money",
      resourceId: "money",
      name: `Страхование экспорта: ${offerName}`,
      qty: cashDelta,
      roomId: "treasury",
      sourceId: String(order?.operationId ?? result?.orderId ?? ""),
      source: marketLabel,
      status: "lost",
      operationId: String(result?.resolutionOperationId ?? ""),
      note: "Страховая выплата за утраченный экспорт",
      meta: { alreadyLogged: true, storageKind: "market-export-loss" }
    });
  }
  return exportReport;
},

async _runTenDayEconomy(holding) {
  return this._runEconomyForQd(holding, 40);
},

_foodConsumptionDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeResourceId,
    resourceDef,
    resourceLabel,
    effectiveConsumerRationPoints,
    normalizeRationBuffer,
    normalizeRationBufferEntry,
    rationBufferEntryKey,
    totalRationBufferPoints,
    foodProvisionDaily,
    formatNumber: (value) => this._formatNumber(value),
    consumeStorageResource: (holding, row, qty, options) => this._storageTakeLots(holding, row, qty, options),
    storageAvailableQuantity: (holding, row) => this._storageAvailableQuantity(holding, row),
    storageUsableQuantityAtQd: (holding, row, targetQd) => this._storageUsableQuantityAtQd(holding, row, targetQd),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runFoodConsumptionForQd(holding, qd = 0, report = null) {
  return runFoodConsumption({
    holding,
    qd,
    report,
    dependencies: this._foodConsumptionDependencies()
  });
},

_isFoodResource(row = {}) {
  return isFoodResource(row, this._foodConsumptionDependencies());
},

_storedFoodPersonDays(holding = {}) {
  return totalHoldingFoodPersonDays(holding, this._foodConsumptionDependencies());
},

_usableFoodPersonDaysAtQd(holding = {}, targetQd = 0) {
  const deps = this._foodConsumptionDependencies();
  const consumptionQd = Math.max(0, Math.floor(this._safeNumber(targetQd, 0)) - 1);
  const buffered = normalizeRationBuffer(holding?.storage?.rationBuffer).entries.reduce((sum, entry) => (
    entry.expiresQd > 0 && consumptionQd >= entry.expiresQd ? sum : sum + entry.points
  ), 0);
  const stored = (holding?.storage?.resources ?? []).reduce((sum, row) => {
    if (!isFoodResource(row, deps)) return sum;
    const qty = Math.max(0, this._storageUsableQuantityAtQd(holding, row, consumptionQd));
    const usableQty = usesStandardRationUnits(row, deps) ? Math.floor(qty + 1e-9) : qty;
    return sum + usableQty * Math.max(0, foodValueForResource(row, deps));
  }, 0);
  return buffered + stored;
},

_constructionDependencies({ rollDice = rollD6Pool, workerContext = null } = {}) {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    buildingStatus: (building) => this._buildingStatus(building),
    buildingOperationalState,
    advanceBuildingProject,
    validConstructionReservation,
    constructionCrew: (holding, crewId) => this._constructionCrew(holding, crewId, workerContext),
    spendConstructionLabor: (holding, crew, options) => this._spendConstructionCrewLabor(holding, crew, workerContext, options),
    rollDice,
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runConstructionCrewsForQd(holding, qd = 0, report = null, { rollDice = rollD6Pool, workerContext = null } = {}) {
  return runConstruction({
    holding,
    qd,
    report,
    dependencies: this._constructionDependencies({ rollDice, workerContext })
  });
},

_economyReportDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    formatNumber: (value) => this._formatNumber(value),
    formatCopperCurrency: (value) => this._formatCopperCurrency(value),
    normalizeLedger: (rows) => normalizeEconomyLedger(rows),
    ledgerTotals: (rows) => economyLedgerTotals(rows)
  };
},

_summarizeFoodReport(food = {}) {
  return summarizeFoodReport(food, this._economyReportDependencies());
},

_summarizeCapitalReport(capital = {}) {
  return summarizeCapitalReport(capital, this._economyReportDependencies());
},

_summarizeServicesReport(services = {}) {
  return summarizeServicesReport(services, this._economyReportDependencies());
},

_summarizeConstructionReport(construction = {}) {
  return summarizeConstructionReport(construction);
},

_treasuryCostDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    readMoney: (holding) => this._moneyCopper(holding),
    writeMoney: (holding, value) => this._setMoneyCopper(holding, value),
    formatCopperCurrency: (value) => this._formatCopperCurrency(value),
    upkeepOperationalFactor,
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runTreasuryCostsForQd(holding, qd = 0, report = null, workerContext = null) {
  const totals = this._prepareTotals(holding, workerContext);
  return runTreasuryCosts({
    holding,
    qd,
    totals,
    report,
    dependencies: this._treasuryCostDependencies()
  });
},

_summarizeTradeReport(trade = {}) {
  return summarizeTradeReport(trade, this._economyReportDependencies());
},

_summarizeTreasuryReport(treasury = {}) {
  return summarizeTreasuryReport(treasury, this._economyReportDependencies());
},

_summarizeSignedLines(items = [], sign = "+") {
  return summarizeSignedLines(items, sign, this._economyReportDependencies());
},

_summarizeSkippedLines(items = []) {
  return summarizeSkippedLines(items);
},

_summarizeEconomyReport(report) {
  return summarizeEconomyReport(report, this._economyReportDependencies());
}
};
