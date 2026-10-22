// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { DEFAULT_NORMAL_LABOR_QD, normalLaborQdPerTenday } from "../../../data/labor-budget.js";
import { buildingLaborMode, staffAppointmentFor, staffAppointmentWorkFunctions, productionPreparationGoal } from "../../../data/hybrid-labor.js";
import { minimumStaffStatus } from "../../../engines/workers/minimum-staff.js";
import { staffBudgetView } from "../../../engines/workers/staff-runtime.js";
import { militaryDailyWage } from "../../../engines/economy/military-wages.js";
import { sellerQualification } from "../../../engines/workers/seller-qualification.js";
import { rollD6Pool } from "../../../core/helpers.js";
import { scaleProductionCosts } from "../../../core/production-expenses.js";
import { advanceBuildingProject, buildingOperationalState } from "../../../core/building-state.js";
import { isMedicalBuilding } from "../../../core/building-specials.js";
import { evaluateArithmeticExpression, rollInlineDice } from "../../../core/formula.js";
import {
  normalizeResourceId,
  resourceDef,
  resourceLabel
} from "../../../core/resources.js";
import {
  availableResourceBatchInventory,
  availableResourceRowQuantity,
  internalDemandBatchClockQd,
  isResourceBatchPeriodActive,
  nextInternalDemandBatchAvailabilityQd,
  syncResourceRowBatches,
  setResourceBatchPeriodStep,
  takeResourceBatchById
} from "../../../core/resource-batches.js";
import {
  summarizeConstructionReport,
  summarizeEconomyReport,
  summarizeFoodReport,
  summarizeSignedLines,
  summarizeSkippedLines,
  summarizeTradeReport,
  summarizeTreasuryReport
} from "../../../engines/economy/report.js";
import { runConstruction } from "../../../engines/economy/construction.js";
import { constructionCenterSuccessBonus } from "../../../engines/economy/construction-center.js";
import {
  constructionAttemptGate,
  constructionPeriodForHolding,
  resolveConstructionAttempt
} from "../../../engines/economy/construction-stages.js";
import { isFoodResource, runFoodConsumption } from "../../../engines/economy/food-consumption.js";
import { foodRationTierLabel, normalizeFoodRationUnits, resolveFoodRation } from "../../../engines/economy/food-rations.js";
import { isResidentInPopulation } from "../../../data/resident-presence.js";
import {
  applySettlementHunger,
  hungerPenaltyFactor,
  normalizeHungerLevel,
  settlementHungerFactor
} from "../../../engines/economy/hunger.js";
import { runProductionCycle } from "../../../engines/economy/production-cycle.js";
import { refundProductionInputs } from "../../../engines/economy/production-inputs.js";
import {
  CONSTRUCTION_LEADER_WAGE_DAILY_COPPER,
  CONSTRUCTION_WORKER_WAGE_DAILY_COPPER
} from "../../../engines/workers/construction-leadership.js";
import { buildingCompositionStatus, holdingWorkerAdmissionIssues } from "../../../engines/workers/building-qualification.js";
import { normalizeBuildingMaintenance, usesTechnicalMaintenance } from "../../../data/economy/maintenance.js";
import { runTrade } from "../../../engines/economy/trade.js";
import { foundryRollClass } from "../../../integrations/foundry-runtime.js";
import { runTreasuryCosts } from "../../../engines/economy/treasury-costs.js";
import {
  financeObligationBlockers,
  financeObligationOutstandingCopper,
  reconcileFinanceObligationOrphans
} from "../../../engines/economy/finance-obligations.js";
import { financePeriodIdentity, plannedWorkerQd, prepareFinancePeriod } from "../../../engines/economy/finance-period.js";
import { appendEconomyLedger, economyLedgerTotals, normalizeEconomyLedger } from "../../../engines/economy/ledger.js";
import { advanceMarketShipments } from "../../../engines/market/shipment.js";
import { recoverMarketDemand } from "../../../engines/market/demand.js";
import { advanceMarketOutboundShipments } from "../../../workflows/market/outbound-shipment.js";
import { addCalendariaQd, getCalendariaSeasonSnapshot, getCalendariaSnapshot } from "../../../integrations/calendaria-bridge.js";
import { clone } from "../../../data/utils.js";
import { beginPerishableStoragePeriod, cancelPerishableStoragePeriod, expireProductionIngredients } from "../../../engines/economy/perishable-storage.js";
import { politicsPeriodIndex } from "../../../engines/politics/rules.js";
import { finishPoliticsPeriod, politicsTributeObligation, preparePoliticsPeriod, refreshPoliticsPeriodEffects } from "../../../engines/politics/period.js";
import { politicsDecisionContext } from "../../politics-decision-context.js";
import { appendHoldingOperation } from "../../../data/operations.js";
import {
  buildPlannedWorkSlots,
  explicitWorkerIdsForBuilding,
  MAINTENANCE_WORK_FUNCTION_ID,
  MAINTENANCE_WORK_SOURCE_ID,
  plannedAssignmentQd,
  validateHoldingWorkAllocations,
  WORK_ALLOCATION_MODE_EXPLICIT
} from "../../../data/work-allocations.js";

export const FinanceEconomyDomain = {
async _tendayReadinessContext(holding, { foodProjection: suppliedFoodProjection = null } = {}) {
  if (!holding) return { ready: false, alerts: [], alertCount: 0 };
  const living = (holding?.people?.list ?? []).filter((person) => isResidentInPopulation(person, holding));
  const foodStored = (holding?.storage?.resources ?? [])
    .filter((row) => this._isFoodResource(row))
    .reduce((sum, row) => sum + Math.max(0, Math.floor(this._safeNumber(row?.qty, 0))), 0);
  const foodProjection = suppliedFoodProjection ?? await this._projectTendayFood(holding);
  const foodAvailable = foodProjection.available;
  const foodProduced = Math.max(0, foodAvailable - foodStored);
  const foodNeeded = living.length * 10;
  const injured = living.filter((person) => this._safeNumber(person?.injuredDays, 0) > 0).length;
  const buildings = holding?.buildings?.list ?? [];
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
    if (buildingLaborMode(building) !== "legacy" || !buildingOperationalState(building).operational) return false;
    const minimum = Math.max(0, this._safeNumber(building?.workersMin, 0));
    const assigned = (building?.assignedWorkerIds ?? []).filter(Boolean).length;
    return minimum > assigned;
  });
  const alerts = [];
  if (foodAvailable < foodNeeded) alerts.push({ key: "food", severity: "danger", icon: "fa-solid fa-bowl-food", title: "Не хватает пищи", text: `${foodAvailable}/${foodNeeded} с учётом прогнозируемого производства${foodProduced ? ` (+${foodProduced})` : ""}; дефицит ${foodNeeded - foodAvailable}.` });
  if (projectsWithoutCrew.length) alerts.push({ key: "projects", severity: "danger", icon: "fa-solid fa-person-digging", title: "Проекты без бригады", text: `${projectsWithoutCrew.length}: ${projectsWithoutCrew.slice(0, 3).map((row) => row.name || "Объект").join(", ")}.` });
  if (understaffed.length) alerts.push({ key: "workers", severity: "warning", icon: "fa-solid fa-user-clock", title: "Не хватает работников", text: understaffed.slice(0, 5).map((building) => `${building.name || "Здание"} ${(building.assignedWorkerIds ?? []).filter(Boolean).length}/${Math.max(0, this._safeNumber(building.workersMin, 0))}`).join(" · ") + (understaffed.length > 5 ? ` · ещё ${understaffed.length - 5}` : "") + "." });
  if (damaged.length) alerts.push({ key: "damage", severity: "warning", icon: "fa-solid fa-house-crack", title: "Повреждённые здания", text: `${damaged.length} зданий повреждено или разрушено.` });
  if (injured) alerts.push({ key: "injured", severity: "info", icon: "fa-solid fa-user-injured", title: "Раненые жители", text: `${injured} жителей продолжат восстановление в течение десятника.` });
  return {
    ready: !alerts.some((alert) => alert.severity === "danger"),
    alerts,
    alertCount: alerts.length,
    foodAvailable,
    foodStored,
    foodProduced,
    foodNeeded,
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

async _projectTendayFood(holding) {
  const preview = clone(holding);
  const report = { produced: [], consumed: [], skipped: [], formulas: [], work: [], ledger: [] };
  const workerContext = this._economyWorkerContext(preview);
  beginPerishableStoragePeriod(preview);
  try {
    await this._runProductionAndLivestockForQd(preview, 40, report, {
      buildings: preview?.buildings?.list ?? [],
      budgets: new Map(),
      workerContext,
      lineOutputForCycle: (line, context) => this._expectedLineOutputForCycle(line, context)
    });
  } finally {
    cancelPerishableStoragePeriod(preview);
  }
  const available = (preview?.storage?.resources ?? [])
    .filter((row) => this._isFoodResource(row))
    .reduce((sum, row) => sum + Math.max(0, Math.floor(this._safeNumber(row?.qty, 0))), 0);
  return { available, report };
},

_tradeDependencies({ random = () => Math.random(), financeContext = null } = {}) {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    random,
    buildingStatus: (building) => this._buildingStatus(building),
    buildingFunctions: (building) => {
      const functions = this._buildingFunctions(building);
      return { ...functions, income: functions.income && this._financeFunctionAllowed(financeContext, building, "income") };
    },
    reputationTotal: (holding) => this._reputationSummary(holding).total,
    tradeCandidateFilters: (building) => this._tradeCandidateFilters(building),
    tradeCandidates: (holding, filters) => this._tradeCandidates(holding, filters),
    tradeCandidateQuantity: (candidate) => this._tradeCandidateQuantity(candidate),
    tradeUnitSalePrice: (basePrice, efficiency) => this._tradeUnitSalePrice(basePrice, efficiency),
    assignedBuildingPeople: (holding, building, workerContext) => this._activeAssignedBuildingPeople(holding, building, workerContext, "income"),
    personBuildingEfficiency: (holding, building, person, workerContext) => this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "service" }),
    rollFormulaTotal: (formula, context) => this._rollFormulaTotal(formula, context),
    reduceTradeCandidate: (candidate, amount) => this._reduceTradeCandidate(candidate, amount),
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    itemQuantity: (row) => this._itemQuantity(row),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

async _runTradeForQd(holding, qd = 0, report = null, workerContext = null, { random = () => Math.random(), financeContext = null } = {}) {
  const context = workerContext ?? this._economyWorkerContext(holding);
  return runTrade({
    holding,
    qd,
    report,
    workerContext: context,
    dependencies: this._tradeDependencies({ random, financeContext })
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

_financeFunctionKey(buildingId = "", functionId = "") {
  return `${String(buildingId ?? "")}::${String(functionId ?? "")}`;
},

_financeLineFunctionId(line = {}, index = 0) {
  return `production:${String(line?.id ?? `line-${index + 1}`)}`;
},

_buildingBaseUpkeepMonthlyCopper(holding, building = {}) {
  const templateId = String(building?.templateId ?? building?.id ?? "").trim();
  if (templateId !== "laputa-excavated-crypt") {
    return Math.max(0, Math.floor(this._safeNumber(building?.baseUpkeepMonthlyCopper, 0)));
  }
  const roomId = String(building?.id ?? "").trim();
  const occupied = [...(holding?.storage?.resources ?? []), ...(holding?.storage?.items ?? [])].some((row) => (
    String(row?.roomId ?? row?.storageRoomId ?? "") === roomId
    && this._safeNumber(row?.qty ?? row?.quantity ?? row?.count, 0) > 0
  ));
  return occupied ? 18 : 0;
},

_financeFunctionAllowed(financeContext = null, building = {}, functionId = "") {
  if (!financeContext) return true;
  const buildingId = String(building?.id ?? "");
  if (financeContext.mothballedBuildingIds?.has(buildingId)) return false;
  if (financeContext.baseBlockedBuildingIds?.has(buildingId)) return false;
  return !financeContext.operatingBlockedFunctionKeys?.has(this._financeFunctionKey(buildingId, "operation"))
    && !financeContext.operatingBlockedFunctionKeys?.has(this._financeFunctionKey(buildingId, functionId));
},

_financePlanInputs(holding, periodQd, identity) {
  const normalLaborBudget = normalLaborQdPerTenday();
  const finance = holding?.finance ?? {};
  const oldBlockers = financeObligationBlockers({
    finance,
    currentPeriodKey: identity.periodKey,
    currentPeriodIndex: identity.periodIndex,
    includeCurrent: false
  });
  const people = (holding?.people?.list ?? []).filter((person) => (
    person && isResidentInPopulation(person, holding) && this._safeNumber(person?.injuredDays, 0) <= 0
    && (!this._canResidentWork || this._canResidentWork(person, holding))
  ));
  const peopleById = new Map(people.map((person) => [String(person.id ?? ""), person]));
  const buildingsByAssignment = new Map();
  const buildingAssignmentByWorkerId = new Map();
  const buildingPlans = [];

  for (const building of holding?.buildings?.list ?? []) {
    const buildingId = String(building?.id ?? "");
    if (!buildingId || this._buildingStatus(building).value !== "built") continue;
    buildingsByAssignment.set(buildingId, building);
    if (building?.name) buildingsByAssignment.set(String(building.name), building);
    for (const workerId of building?.assignedWorkerIds ?? []) {
      const id = String(workerId ?? "");
      if (id && !buildingAssignmentByWorkerId.has(id)) buildingAssignmentByWorkerId.set(id, building);
    }
    const rawFunctions = this._buildingFunctions(building);
    const functions = [];
    if (rawFunctions.production) {
      const lines = this._isAgricultureBuilding(building)
        ? []
        : (Array.isArray(building?.productionLines) ? building.productionLines : []);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const pendingCollection = ["staff", "qd"].includes(buildingLaborMode(building))
          && line?.requiresCollection === true && this._safeNumber(line?.pendingQty, 0) > 0;
        if (line?.active === false && !pendingCollection) continue;
        functions.push({
          id: this._financeLineFunctionId(line, index),
          name: String(line?.mode ?? line?.resource ?? `Линия ${index + 1}`),
          active: true,
          source: String(line?.source ?? "workers"),
          workerCollection: line?.requiresCollection === true && this._safeNumber(line?.collectQd, 0) > 0,
          overtime: Boolean(line?.overtime),
          wageDailyCopper: Math.max(0, Math.floor(this._safeNumber(line?.wageDailyCopper, 0))),
          operatingUpkeepMonthlyCopper: Math.max(0, Math.floor(this._safeNumber(
            line?.operatingUpkeepMonthlyCopper,
            0
          )))
        });
      }
      const livestockFunction = this._livestockFinanceFunction(building);
      if (livestockFunction) functions.push(livestockFunction);
      const agricultureFunction = this._agricultureFinanceFunction(building, holding);
      if (agricultureFunction) functions.push(agricultureFunction);
    }
    if (rawFunctions.income) {
      functions.push({
        id: "income",
        name: "Доход и внутренняя торговля",
        active: true,
        source: "workers",
        overtime: false,
        wageDailyCopper: Math.max(0, Math.floor(this._safeNumber(building?.income?.wageDailyCopper, 0))),
        operatingUpkeepMonthlyCopper: Math.max(0, Math.floor(this._safeNumber(
          building?.income?.operatingUpkeepMonthlyCopper,
          0
        )))
      });
    }
    const staffedFunctions = [
      [rawFunctions.defense, "defense", "Оборона"],
      [rawFunctions.culture, "culture", "Услуги учреждения"],
      [rawFunctions.storage, "storage", "Охрана и работа склада"],
      [isMedicalBuilding(building), "medical", "Медицинская помощь"]
    ];
    for (const [enabled, id, name] of staffedFunctions) {
      if (!enabled || functions.some((fn) => fn.id === id)) continue;
      if (buildingLaborMode(building) === "legacy" && this._safeNumber(building?.workersMin, 0) <= 0
        && this._safeNumber(building?.wageDailyCopper, 0) <= 0
        && this._safeNumber(building?.operatingUpkeepMonthlyCopper, 0) <= 0) continue;
      functions.push({
        id,
        name,
        active: true,
        source: "workers",
        overtime: false,
        wageDailyCopper: Math.max(0, Math.floor(this._safeNumber(building?.wageDailyCopper, 0))),
        operatingUpkeepMonthlyCopper: 0
      });
    }
    if (usesTechnicalMaintenance(building) && normalizeBuildingMaintenance(building.maintenance).requiredPoints > 0) {
      functions.push({ id: MAINTENANCE_WORK_FUNCTION_ID, name: "Техобслуживание", active: true, source: "workers", overtime: false,
        wageDailyCopper: 18, operatingUpkeepMonthlyCopper: 0 });
    }
    functions.push({ id: "operation", name: "Общая эксплуатация здания", active: false, source: "shared",
      operatingUpkeepMonthlyCopper: Math.max(0, Math.floor(this._safeNumber(building?.operatingUpkeepMonthlyCopper, 0))) });
    buildingPlans.push({
      id: buildingId,
      name: String(building?.name ?? "Здание"),
      built: true,
      baseUpkeepMonthlyCopper: this._buildingBaseUpkeepMonthlyCopper(holding, building),
      gmPriority: building?.financePriority,
      functions
    });
  }

  const crews = new Map((holding?.constructionCrews ?? []).map((crew) => [String(crew?.id ?? ""), crew]));
  const activeCrewIds = new Set((holding?.buildings?.list ?? [])
    .filter((building) => {
      const state = buildingOperationalState(building);
      return state.repairActive || ["planned", "building"].includes(state.lifecycle);
    })
    .map((building) => String(building?.constructionCrewId ?? ""))
    .filter(Boolean));
  const workAllocationCheck = validateHoldingWorkAllocations(holding);
  const workAdmissionIssues = holdingWorkerAdmissionIssues(holding);
  const buildingPlanById = new Map(buildingPlans.map((building) => [String(building.id), building]));
  const workers = [];
  for (const person of people) {
    const workerId = String(person?.id ?? "");
    if (!workerId || oldBlockers.workers[workerId]?.blocked) continue;
    const childWorker = this._isChildResident?.(person) === true;
    // Protected posts still use separate service/roll systems. Do not discount
    // their pay while leaving their work unchanged during the QD transition.
    const post = String(person?.workAssignment ?? "");
    const protectedAssignment = post.startsWith("construction") || ["soldier", "defenseCommander", "other"].includes(post);
    const normalQdPerTenday = protectedAssignment ? DEFAULT_NORMAL_LABOR_QD : normalLaborBudget;
    const normalQdPerDay = childWorker ? 1 : 2;
    const overtimeQdPerDay = childWorker ? 0 : 1;
    const periodCapacity = plannedWorkerQd(periodQd, {
      overtime: overtimeQdPerDay > 0,
      normalQdPerDay,
      overtimeQdPerDay,
      normalQdPerTenday
    });
    const workerBase = {
      id: workerId,
      name: String(person?.name ?? "Житель"),
      recipientKind: "resident",
      wageOverrideCopper: person?.wageDailyOverrideCopper,
      volunteer: person?.volunteerLabor === true,
      volunteerReason: String(person?.volunteerReason ?? ""),
      gmPriority: person?.financePriority,
      maximumNormalQd: periodCapacity.normalQd,
      maximumOvertimeQd: periodCapacity.overtimeQd,
      normalQdPerDay,
      overtimeQdPerDay
    };
    const staffAppointment = staffAppointmentFor(person);
    if (staffAppointment) {
      const buildingId = String(staffAppointment.buildingId ?? "");
      const building = buildingsByAssignment.get(buildingId)
        ?? (holding?.buildings?.list ?? []).find((row) => String(row.id) === buildingId);
      const planIssues = [...workAllocationCheck.issues, ...workAdmissionIssues].filter((issue) => (
        String(issue?.personId ?? "") === workerId || String(issue?.buildingId ?? "") === buildingId
      ));
      if (!building || buildingLaborMode(building) !== "staff") {
        planIssues.push({ code: "staff-building", personId: workerId, message: "Постоянное назначение относится к недоступному штатному зданию." });
      }
      workers.push({
        ...workerBase,
        wageOverrideCopper: staffAppointment.wageDailyCopper,
        volunteer: staffAppointment.volunteer === true,
        volunteerReason: String(staffAppointment.volunteerReason ?? ""),
        staffAppointment: clone(staffAppointment),
        staffOvertimeFunctions: (buildingPlanById.get(buildingId)?.functions ?? []).filter((fn) => fn.overtime).map((fn) => fn.id),
        planIssues,
        assignments: [{
          sourceId: buildingId, functionId: "staff",
          normalQd: periodCapacity.normalQd,
          overtimeQd: Math.max(0, Math.floor(this._safeNumber(staffAppointment.overtimeQd, 0))),
          dailyRateCopper: staffAppointment.wageDailyCopper
        }]
      });
      continue;
    }
    if (String(person?.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT) {
      const validation = workAllocationCheck.plans.get(workerId) ?? { rows: [], issues: [] };
      const planIssues = [...workAllocationCheck.issues, ...workAdmissionIssues].filter((issue) => (
        String(issue?.personId ?? "") === workerId
        || (issue?.buildingId && validation.rows.some((row) => String(row?.sourceId ?? "") === String(issue.buildingId)))
      ));
      const assignments = [];
      for (const allocation of validation.rows) {
        const normalQd = Math.max(0, Math.floor(this._safeNumber(allocation?.normalQd, 0)));
        const overtimeQd = Math.max(0, Math.floor(this._safeNumber(allocation?.overtimeQd, 0)));
        if (!normalQd && !overtimeQd) continue;
        const sourceId = String(allocation?.sourceId ?? "");
        const functionId = String(allocation?.functionId ?? "");
        if (sourceId === MAINTENANCE_WORK_SOURCE_ID && functionId === MAINTENANCE_WORK_FUNCTION_ID) {
          assignments.push({ sourceId, functionId, normalQd, overtimeQd, dailyRateCopper: 12,
            volunteer: allocation.volunteer === true, volunteerReason: allocation.volunteerReason });
          continue;
        }
        const buildingPlan = buildingPlanById.get(sourceId);
        const building = buildingsByAssignment.get(sourceId);
        const fn = buildingPlan?.functions?.find((row) => String(row?.id ?? "") === functionId && (row?.source === "workers" || row.workerCollection));
        if (!buildingPlan || !building || !fn) continue;
        const blocker = oldBlockers.buildings[sourceId] ?? {};
        if (blocker.mothballed || blocker.baseDebtCopper > 0 || blocker.operatingByFunction?.operation?.debtCopper > 0 || blocker.operatingByFunction?.[functionId]?.debtCopper > 0) continue;
        assignments.push({
          sourceId,
          functionId,
          normalQd,
          overtimeQd,
          volunteer: allocation.volunteer === true, volunteerReason: allocation.volunteerReason,
          dailyRateCopper: Math.max(0, Math.floor(this._safeNumber(fn?.wageDailyCopper, 0)))
            || Math.max(0, Math.floor(this._safeNumber(building?.wageDailyCopper, 0)))
        });
      }
      if (assignments.length || planIssues.length) workers.push({ ...workerBase, assignments, planIssues });
      continue;
    }
    const slottedBuilding = buildingAssignmentByWorkerId.get(workerId);
    const assignment = String(person?.workAssignment ?? slottedBuilding?.id ?? "").trim()
      || String(slottedBuilding?.id ?? "");
    if (!assignment || ["Свободен", "Без работы", "Ребенок"].includes(assignment)) continue;
    let sourceId = assignment;
    let functionId = assignment;
    let dailyRateCopper = 0;
    let overtime = false;
    const building = buildingsByAssignment.get(assignment);
    if (building) {
      const buildingPlan = buildingPlans.find((row) => row.id === String(building.id));
      const blocker = oldBlockers.buildings[String(building.id)] ?? {};
      const eligibleFunctions = (buildingPlan?.functions ?? []).filter((fn) => (
        !blocker.mothballed
        && !(blocker.baseDebtCopper > 0)
        && !(blocker.operatingByFunction?.operation?.debtCopper > 0)
        && !(blocker.operatingByFunction?.[fn.id]?.debtCopper > 0)
      ));
      if (!eligibleFunctions.length) continue;
      const workerFunction = eligibleFunctions.find((fn) => fn.source === "workers") ?? eligibleFunctions[0];
      sourceId = String(building.id);
      functionId = workerFunction.id;
      dailyRateCopper = workerFunction.wageDailyCopper
        || Math.max(0, Math.floor(this._safeNumber(building?.wageDailyCopper, 0)))
        || dailyRateCopper;
      overtime = eligibleFunctions.some((fn) => fn.source === "workers" && fn.overtime);
    } else if (["soldier", "defenseCommander"].includes(assignment)) {
      dailyRateCopper = militaryDailyWage(holding, person);
    } else if (assignment === "other") {
      dailyRateCopper = Math.max(0, Math.floor(this._safeNumber(person?.salary, 0)));
    } else if (assignment.startsWith("construction-leader:")) {
      const crewId = assignment.slice("construction-leader:".length);
      if (!activeCrewIds.has(crewId)) continue;
      sourceId = crewId;
      functionId = "construction-leader";
      dailyRateCopper = CONSTRUCTION_LEADER_WAGE_DAILY_COPPER;
    } else if (assignment.startsWith("construction:")) {
      const crewId = assignment.slice("construction:".length);
      if (!activeCrewIds.has(crewId)) continue;
      const crew = crews.get(crewId);
      sourceId = crewId;
      functionId = "construction";
      dailyRateCopper = Math.max(0, Math.floor(this._safeNumber(crew?.wageDailyCopper, 0))) || CONSTRUCTION_WORKER_WAGE_DAILY_COPPER;
    } else if (assignment === "construction") {
      const crew = [...crews.values()][0];
      if (!crew || !activeCrewIds.has(String(crew.id))) continue;
      sourceId = String(crew.id);
      functionId = "construction";
      dailyRateCopper = Math.max(0, Math.floor(this._safeNumber(crew?.wageDailyCopper, 0))) || CONSTRUCTION_WORKER_WAGE_DAILY_COPPER;
    }
    const plannedQd = plannedWorkerQd(periodQd, {
      overtime: overtime && overtimeQdPerDay > 0,
      normalQdPerDay,
      overtimeQdPerDay,
      normalQdPerTenday
    });
    if (!plannedQd.totalQd) continue;
    workers.push({
      ...workerBase,
      assignments: [{
        sourceId,
        functionId,
        normalQd: plannedQd.normalQd,
        overtimeQd: plannedQd.overtimeQd,
        dailyRateCopper
      }]
    });
  }
  const plannedFunctionKeys = new Set(workers.flatMap((worker) => {
    const validLaborContract = worker.volunteer
      ? true
      : (worker.assignments ?? []).some((assignment) => assignment?.volunteer === true || this._safeNumber(assignment?.dailyRateCopper, 0) > 0 || this._safeNumber(worker?.wageOverrideCopper, 0) > 0);
    if (!validLaborContract) return [];
    if (worker.staffAppointment) {
      if (!(worker.assignments ?? []).some((row) => row.normalQd + row.overtimeQd > 0)) return [];
      return staffAppointmentWorkFunctions(worker.staffAppointment)
        .map((functionId) => this._financeFunctionKey(worker.staffAppointment.buildingId, functionId));
    }
    return (worker.assignments ?? []).map((assignment) => this._financeFunctionKey(assignment.sourceId, assignment.functionId));
  }));
  for (const building of buildingPlans) {
    for (const fn of building.functions) {
      if (fn.source !== "workers") continue;
      fn.active = plannedFunctionKeys.has(this._financeFunctionKey(building.id, fn.id));
    }
    const shared = building.functions.find((fn) => fn.id === "operation");
    if (shared) shared.active = building.functions.some((fn) => fn.id !== "operation" && fn.active !== false);
  }
  return { workers, buildings: buildingPlans, oldBlockers, peopleById };
},

_financeExecutionContext(result = {}, { oldBlockers = null, plannedWorkers = [], periodQd = 40 } = {}) {
  const blockers = result.blockers ?? { workers: {}, buildings: {} };
  const blockedWorkerIds = new Set([
    ...Object.entries(blockers.workers ?? {}).filter(([, row]) => row?.blocked).map(([id]) => id),
    ...Object.entries(oldBlockers?.workers ?? {}).filter(([, row]) => row?.blocked).map(([id]) => id),
    ...(result.invalidWorkerIds ?? [])
  ]);
  const mothballedBuildingIds = new Set();
  const baseBlockedBuildingIds = new Set();
  const operatingBlockedFunctionKeys = new Set();
  const mergeBuildingBlockers = (source = {}) => {
    for (const [buildingId, row] of Object.entries(source)) {
      if (row?.mothballed) mothballedBuildingIds.add(buildingId);
      if (this._safeNumber(row?.baseDebtCopper, 0) > 0) baseBlockedBuildingIds.add(buildingId);
      for (const [functionId, debt] of Object.entries(row?.operatingByFunction ?? {})) {
        if (this._safeNumber(debt?.debtCopper, 0) > 0) operatingBlockedFunctionKeys.add(this._financeFunctionKey(buildingId, functionId));
      }
    }
  };
  mergeBuildingBlockers(oldBlockers?.buildings);
  mergeBuildingBlockers(blockers.buildings);
  const plannedAssignmentsByWorkerId = new Map();
  const plannedWorkSlotsByWorkerId = new Map();
  const staffAppointmentsByWorkerId = new Map();
  const staffOvertimeFunctionsByWorkerId = new Map();
  for (const worker of plannedWorkers ?? []) {
    const workerId = String(worker?.id ?? "");
    if (!workerId || blockedWorkerIds.has(workerId)) continue;
    if (worker.staffAppointment) {
      staffAppointmentsByWorkerId.set(workerId, clone(worker.staffAppointment));
      staffOvertimeFunctionsByWorkerId.set(workerId, new Set(worker.staffOvertimeFunctions ?? []));
    }
    const assignments = (worker?.assignments ?? []).map((assignment) => ({
      sourceId: String(assignment?.sourceId ?? ""),
      functionId: String(assignment?.functionId ?? ""),
      normalQd: Math.max(0, Math.floor(this._safeNumber(assignment?.normalQd, 0))),
      overtimeQd: Math.max(0, Math.floor(this._safeNumber(assignment?.overtimeQd, 0))),
      ...(assignment?.volunteer === true ? { volunteer: true, volunteerReason: String(assignment.volunteerReason ?? "") } : {})
    })).filter((assignment) => assignment.sourceId && assignment.functionId && (assignment.normalQd > 0 || assignment.overtimeQd > 0));
    if (assignments.length) {
      plannedAssignmentsByWorkerId.set(workerId, assignments);
      const scheduledAssignments = [...assignments].sort((left, right) => {
        const technical = (row) => row.functionId === MAINTENANCE_WORK_FUNCTION_ID && row.sourceId !== MAINTENANCE_WORK_SOURCE_ID;
        return Number(technical(right)) - Number(technical(left));
      });
      const spreadStaffCare = worker.staffAppointment && staffAppointmentWorkFunctions(worker.staffAppointment).includes("livestock");
      const slots = buildPlannedWorkSlots(spreadStaffCare ? scheduledAssignments.map((row) => ({ ...row, functionId: "livestock" })) : scheduledAssignments, periodQd, {
        normalQdPerDay: worker?.normalQdPerDay,
        overtimeQdPerDay: worker?.overtimeQdPerDay
      });
      if (spreadStaffCare) for (const slot of slots.values()) slot.functionId = "staff";
      plannedWorkSlotsByWorkerId.set(workerId, slots);
    }
  }
  return {
    blockedWorkerIds,
    mothballedBuildingIds,
    baseBlockedBuildingIds,
    operatingBlockedFunctionKeys,
    plannedAssignmentsByWorkerId,
    plannedWorkSlotsByWorkerId,
    staffAppointmentsByWorkerId,
    staffOvertimeFunctionsByWorkerId,
    staffWorkByWorkerId: new Map(),
    staffCurrentFunctionByWorkerId: new Map(),
    staffWorkLedger: [],
    staffReservedStepsByWorkerId: new Map(),
    staffExecutionComplete: false,
    periodQd: Math.max(0, Math.floor(this._safeNumber(periodQd, 40))),
    result
  };
},

_personnelOfficeCashback(holding, result = {}, inputs = {}, financeContext = null) {
  const offices = (holding?.buildings?.list ?? []).filter((building) => (
    String(building?.templateId ?? building?.id ?? "") === "personnel-office"
    && buildingOperationalState(building).operational
  ));
  if (!offices.length) return { copper: 0, baseCopper: 0, officeIds: [] };
  const officeIds = new Set(offices.map((building) => String(building?.id ?? "")));
  const coverage = Math.max(0, ...offices.map((building) => {
    if (!this._financeFunctionAllowed(financeContext, building, "income")) return 0;
    const staffMode = buildingLaborMode(building) === "staff";
    if (staffMode && !financeContext?.staffExecutionComplete) return 0;
    const assignmentsFor = (worker) => staffMode
      ? financeContext?.staffWorkByWorkerId?.get(String(worker.id)) ?? []
      : worker?.assignments ?? [];
    const workers = (inputs?.workers ?? []).filter((worker) => (
      !financeContext?.blockedWorkerIds?.has(String(worker?.id ?? ""))
      && assignmentsFor(worker).some((assignment) => (
        String(assignment?.sourceId ?? "") === String(building?.id ?? "")
        && String(assignment?.functionId ?? "") === "income"
        && this._safeNumber(assignment?.normalQd, 0) + this._safeNumber(assignment?.overtimeQd, 0) > 0
      ))
    ));
    if (buildingLaborMode(building) === "legacy") {
      return workers.length >= Math.max(1, Math.floor(this._safeNumber(building?.workersMin, 1))) ? 1 : 0;
    }
    const qd = workers.reduce((sum, worker) => sum + plannedAssignmentQd(assignmentsFor(worker), String(building.id), "income"), 0);
    const required = Math.max(1, this._safeNumber(building.activation?.minOperationalQd ?? building.minOperationalQd, 0) || 20);
    return Math.min(1, qd / required);
  }));

  const obligations = new Map((result?.finance?.obligations ?? []).map((row) => [String(row?.id ?? ""), row]));
  let baseCopper = 0;
  let officePaidCopper = 0;
  for (const payment of result?.allocation?.payments ?? []) {
    const obligation = obligations.get(String(payment?.obligationId ?? ""));
    const paid = Math.max(0, Math.floor(this._safeNumber(payment?.amountCopper, 0)));
    if (!obligation || !paid) continue;
    if (["building-operating-upkeep", "building-base-upkeep"].includes(obligation.kind)) {
      if (officeIds.has(String(obligation.recipientId ?? ""))) officePaidCopper += paid;
      else if (obligation.kind === "building-operating-upkeep") baseCopper += paid;
      continue;
    }
    if (obligation.kind !== "wage") continue;
    const assignments = obligation?.meta?.assignments ?? [];
    const totalUnits = assignments.reduce((sum, row) => sum
      + (this._safeNumber(row?.normalQd, 0) * this._safeNumber(row?.effectiveDailyRateCopper, 0))
      + (this._safeNumber(row?.overtimeQd, 0) * this._safeNumber(row?.effectiveDailyRateCopper, 0) * 2), 0);
    const eligibleUnits = assignments.filter((row) => !officeIds.has(String(row?.sourceId ?? ""))).reduce((sum, row) => sum
      + (this._safeNumber(row?.normalQd, 0) * this._safeNumber(row?.effectiveDailyRateCopper, 0))
      + (this._safeNumber(row?.overtimeQd, 0) * this._safeNumber(row?.effectiveDailyRateCopper, 0) * 2), 0);
    const eligiblePaid = totalUnits > 0 ? Math.floor(paid * eligibleUnits / totalUnits) : paid;
    baseCopper += eligiblePaid;
    officePaidCopper += paid - eligiblePaid;
  }
  return { copper: Math.floor(baseCopper * 0.1 * coverage), baseCopper: coverage > 0 ? baseCopper : 0, officePaidCopper, officeIds: [...officeIds] };
},

_prepareFinanceForQd(holding, periodQd, report, { operationId = "", createdAt = "" } = {}) {
  const identity = financePeriodIdentity(holding, periodQd);
  const financeOperationId = operationId || `finance:${identity.periodKey}`;
  const reconciled = reconcileFinanceObligationOrphans({
    finance: holding?.finance,
    recipientIdsByKind: {
      resident: (holding?.people?.list ?? []).map((person) => String(person?.id ?? "")).filter(Boolean),
      building: (holding?.buildings?.list ?? []).map((building) => String(building?.id ?? "")).filter(Boolean)
    },
    reconciledAt: createdAt,
    operationId: `${financeOperationId}:orphans`
  });
  holding.finance = reconciled.finance;
  const inputs = this._financePlanInputs(holding, periodQd, identity);
  const tribute = identity.periods === 1
    ? politicsTributeObligation(holding, { ...identity, operationId: financeOperationId, createdAt })
    : null;
  const result = prepareFinancePeriod({
    finance: holding?.finance,
    treasuryCopper: this._moneyCopper(holding),
    workers: inputs.workers,
    buildings: inputs.buildings,
    additionalObligations: tribute ? [tribute] : [],
    periods: identity.periods,
    periodKey: identity.periodKey,
    periodIndex: identity.periodIndex,
    operationId: financeOperationId,
    createdAt
  });
  holding.finance = result.finance;
  const executionContext = this._financeExecutionContext(result, { oldBlockers: inputs.oldBlockers, plannedWorkers: inputs.workers, periodQd });
  executionContext.periodIdentity = identity;
  executionContext.technicalRestartIds = new Set((holding?.buildings?.list ?? [])
    .filter((building) => usesTechnicalMaintenance(building)
      && normalizeBuildingMaintenance(building.maintenance).requiredPoints > 0
      && (building?.serviceState?.active !== true || Number(building?.serviceState?.workedQd ?? 0) <= 0))
    .map((building) => String(building.id)));
  const cashback = this._personnelOfficeCashback(holding, result, inputs, executionContext);
  executionContext.personnelOfficeInputs = inputs;
  executionContext.personnelOfficeCashbackCopper = cashback.copper;
  executionContext.financeOperationId = financeOperationId;
  this._setMoneyCopper(holding, result.treasuryCopper + cashback.copper);
  const currentOutstanding = result.currentObligations.reduce((sum, row) => sum + financeObligationOutstandingCopper(row), 0);
  const financeDetailIds = new Set([
    ...result.currentObligations.map((row) => String(row?.id ?? "")),
    ...result.allocation.payments.map((row) => String(row?.obligationId ?? "")),
    ...result.allocation.skipped.map((row) => String(row?.obligationId ?? "")),
    ...reconciled.orphanedIds.map((id) => String(id ?? ""))
  ].filter(Boolean));
  const financeDetails = result.finance.obligations
    .filter((row) => financeDetailIds.has(String(row?.id ?? "")))
    .map((row) => clone(row));
  report.treasury.spent += result.paidCopper;
  report.treasury.deficit = result.outstandingCopper;
  report.treasury.lines.push(`Обязательства: оплачено ${this._formatCopperCurrency(result.paidCopper)}, текущая недоплата ${this._formatCopperCurrency(currentOutstanding)}, общий остаток долга ${this._formatCopperCurrency(result.outstandingCopper)}.`);
  report.finance = {
    periodKey: identity.periodKey,
    periodIndex: identity.periodIndex,
    planned: result.currentObligations.length,
    paidCopper: result.paidCopper,
    currentOutstandingCopper: currentOutstanding,
    oldOutstandingCopper: Math.max(0, result.outstandingCopper - currentOutstanding),
    outstandingCopper: result.outstandingCopper,
    invalidWorkerIds: [...result.invalidWorkerIds],
    orphanedObligationIds: [...reconciled.orphanedIds],
    obligations: financeDetails,
    payments: clone(result.allocation.payments),
    skipped: clone(result.allocation.skipped),
    planningSkipped: clone(result.planned.skipped),
    upkeepSkipped: clone(result.upkeep.skipped),
    issues: clone(result.planned.issues)
  };
  report.finance.personnelOfficeCashbackCopper = cashback.copper;
  report.finance.personnelOfficeCashbackBaseCopper = cashback.baseCopper;
  report.finance.personnelOfficeCostCopper = cashback.officePaidCopper ?? 0;
  report.finance.personnelOfficeNetSavingCopper = cashback.copper - (cashback.officePaidCopper ?? 0);
  if (cashback.officeIds.length) report.work.push(`Управление кадров: административное возмещение ${cashback.copper} ММ; оплаченные расходы самого учреждения ${cashback.officePaidCopper ?? 0} ММ; чистая денежная экономия ${report.finance.personnelOfficeNetSavingCopper} ММ.`);
  if (cashback.copper > 0) {
    report.income.push(`Управление кадров: административное возмещение 10% от фактически оплаченных внешних зарплат и операционных расходов +${cashback.copper}.`);
    appendEconomyLedger(report, {
      domain: "income",
      kind: "money",
      resourceId: "money",
      name: "Административное возмещение Управления кадров",
      qty: cashback.copper,
      roomId: "treasury",
      source: "Управление кадров",
      operationId: `${financeOperationId}:personnel-cashback`,
      note: `10% от ${cashback.baseCopper} ММ; чистая стоимость этой базы после возмещения ${cashback.baseCopper - cashback.copper} ММ; собственные расходы и базовое содержание исключены`
    });
  }
  if (result.paidCopper > 0) appendEconomyLedger(report, {
    domain: "treasury",
    kind: "money",
    resourceId: "money",
    name: "Оплата обязательств",
    qty: -result.paidCopper,
    roomId: "treasury",
    source: "Казна",
    operationId: `${financeOperationId}:settlement`,
    note: `Зарплаты и содержание; период ${identity.periodKey}`
  });
  for (const workerId of result.invalidWorkerIds) {
    const person = inputs.peopleById.get(workerId);
    const reasons = (result.planned?.issues ?? []).filter((issue) => String(issue.workerId) === workerId)
      .map((issue) => String(issue.message ?? "").trim()).filter(Boolean);
    report.skipped.push(`${person?.name || "Работник"}: работа остановлена — ${reasons.join("; ") || "проверьте назначения и согласованную оплату"}.`);
  }
  return executionContext;
},

_runInstitutionConsumables(holding, qd, report, workerContext, financeContext, { staffStartBuildingId = "" } = {}) {
  const cycles = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 40);
  if (!cycles) return;
  for (const building of holding?.buildings?.list ?? []) {
    const staffMode = buildingLaborMode(building) === "staff";
    if (staffStartBuildingId ? !staffMode || String(building.id) !== staffStartBuildingId : staffMode) continue;
    const alternatives = Array.isArray(building?.fuelAlternatives) ? building.fuelAlternatives : [];
    if (!alternatives.length || this._buildingStatus(building).value !== "built") continue;
    const functionId = "culture";
    const key = this._financeFunctionKey(building?.id, functionId);
    const block = (reason) => {
      financeContext?.operatingBlockedFunctionKeys?.add(key);
      building.serviceState = {
        functionId,
        active: false,
        periodKey: String(financeContext?.periodIdentity?.periodKey ?? ""),
        reason
      };
      report.skipped.push(`${building.name || "Здание"}: ${reason}`);
    };
    if (!this._financeFunctionAllowed(financeContext, building, functionId)) {
      building.serviceState = {
        functionId,
        active: false,
        periodKey: String(financeContext?.periodIdentity?.periodKey ?? ""),
        reason: "активная услуга остановлена финансовыми обязательствами."
      };
      continue;
    }
    const workers = this._activeAssignedBuildingPeople(holding, building, workerContext, functionId);
    const minimum = buildingLaborMode(building) === "legacy" ? Math.max(1, Math.floor(this._safeNumber(building?.workersMin, 1))) : 1;
    if (workers.length < minimum) {
      block("активная услуга не работает — нет оплаченного минимального штата.");
      continue;
    }
    const selected = alternatives.find((row) => String(row?.resourceId ?? "") === String(building?.fuelChoice ?? "")) ?? alternatives[0];
    const cost = [{ resourceId: selected.resourceId, qty: Math.max(1, Math.ceil(this._safeNumber(selected.qty, 1))) * cycles }];
    const payment = this._storageCanPay(holding, cost);
    if (!payment.ok) {
      block(`не хватает выбранного топлива (${selected.label || `${cost[0].qty} ${selected.resourceId}`}); автоматически другой вариант не подставляется.`);
      continue;
    }
    this._storagePay(holding, payment.costs);
    building.serviceState = {
      functionId,
      active: true,
      periodKey: String(financeContext?.periodIdentity?.periodKey ?? ""),
      reason: ""
    };
    report.consumed.push(`${building.name || "Здание"}: ${selected.label || selected.resourceId} × ${cycles}`);
    appendEconomyLedger(report, payment.costs.map((row) => ({
      domain: "services",
      kind: "resource",
      resourceId: row.resourceId,
      name: row.name || resourceLabel(row.resourceId),
      qty: -Math.max(0, Math.ceil(this._safeNumber(row.qty, 0))),
      roomId: row.roomId ?? "",
      sourceId: building.id,
      source: building.name || "Здание",
      note: "Выбранный расход активной услуги"
    })));
  }
},

_runInstitutionResolutions(holding, report, workerContext, financeContext, { operationId = "", createdAt = "", staffOnly = false } = {}) {
  const identity = financeContext?.periodIdentity;
  if (!identity) return;
  const monthIndexes = [];
  for (let index = identity.periodIndex; index <= identity.lastPeriodIndex; index += 1) if (index % 3 === 0) monthIndexes.push(index / 3);
  if (!monthIndexes.length) return;
  for (const agency of holding?.buildings?.list ?? []) {
    if ((buildingLaborMode(agency) === "staff") !== staffOnly) continue;
    if (String(agency?.templateId ?? agency?.id ?? "") !== "hiring-agency" || this._buildingStatus(agency).value !== "built") continue;
    if (!this._financeFunctionAllowed(financeContext, agency, "culture")) continue;
    const workers = this._activeAssignedBuildingPeople(holding, agency, workerContext, "culture");
    if (buildingLaborMode(agency) === "legacy") {
      if (workers.length < Math.max(1, Math.floor(this._safeNumber(agency?.workersMin, 1)))) continue;
    } else {
      const actual = workers.reduce((sum, person) => sum + this._plannedWorkerFunctionQd(person, workerContext, agency.id, "culture"), 0);
      if (actual < Math.max(1, this._safeNumber(agency.activation?.minOperationalQd ?? agency.minOperationalQd, 0) || 20)) continue;
    }
    for (const monthIndex of monthIndexes) {
      const resolutionId = `${operationId || "economy"}:hiring-agency:${agency.id}:month-${monthIndex}`;
      appendHoldingOperation(holding, {
        operationId: resolutionId,
        type: "system",
        createdAt,
        title: "Решение ГМа: кандидаты Агентства Найма",
        summary: `${agency.name || "Агентство Найма"} отработало месяц. ГМ определяет доступных кандидатов ролевым решением; жители автоматически не создаются.`,
        payload: { needsResolution: true, resolutionKind: "hiring-agency", buildingId: agency.id, monthIndex }
      });
      report.work.push(`${agency.name || "Агентство Найма"}: за месяц создана подсказка для решения ГМа о кандидатах.`);
    }
  }
},

_economyWorkerContext(holding, { financeContext = null } = {}) {
  const peopleById = new Map();
  const activePeopleById = new Map();
  for (const person of holding?.people?.list ?? []) {
    const id = String(person?.id ?? "");
    if (!id) continue;
    peopleById.set(id, person);
    if (isResidentInPopulation(person, holding)
      && this._safeNumber(person?.injuredDays, 0) <= 0
      && (!this._canResidentWork || this._canResidentWork(person, holding))) activePeopleById.set(id, person);
  }

  const buildingsByAssignment = new Map();
  const buildingWorkers = new Map();
  const overtimeByBuilding = new Map();
  for (const building of holding?.buildings?.list ?? []) {
    const id = String(building?.id ?? "").trim();
    const name = String(building?.name ?? "").trim();
    if (id) buildingsByAssignment.set(id, building);
    if (name) buildingsByAssignment.set(name, building);

    const legacyAssignedIds = (building?.assignedWorkerIds ?? []).filter(Boolean).map((workerId) => String(workerId))
      .filter((workerId) => activePeopleById.get(workerId)?.workAllocationMode !== WORK_ALLOCATION_MODE_EXPLICIT);
    const plannedAssignedIds = financeContext
      ? [...(financeContext?.plannedAssignmentsByWorkerId?.entries?.() ?? [])]
        .filter(([, assignments]) => assignments.some((assignment) => String(assignment?.sourceId ?? "") === id && assignment?.functionId !== MAINTENANCE_WORK_FUNCTION_ID))
        .map(([workerId]) => String(workerId))
      : explicitWorkerIdsForBuilding(holding, id);
    const staffIds = [...(financeContext?.staffAppointmentsByWorkerId ?? [])]
      .filter(([, appointment]) => String(appointment.buildingId) === id)
      .map(([workerId]) => workerId);
    const assignedIds = [...new Set([...legacyAssignedIds, ...plannedAssignedIds, ...staffIds])];
    const economyAssignedPeople = assignedIds
      .map((workerId) => activePeopleById.get(workerId))
      .filter((person) => person && !financeContext?.blockedWorkerIds?.has(String(person.id)));
    buildingWorkers.set(building, {
      assignedIds,
      assignedPeople: assignedIds.map((workerId) => peopleById.get(workerId)).filter(Boolean),
      activeAssignedPeople: assignedIds.map((workerId) => activePeopleById.get(workerId)).filter(Boolean),
      economyAssignedPeople
    });
    overtimeByBuilding.set(building, Boolean(this._buildingHasOvertimeProduction?.(building)));
  }

  return {
    peopleById,
    activePeopleById,
    buildingsByAssignment,
    buildingWorkers,
    overtimeByBuilding,
    assignedWorkerIds: this._assignedWorkerSet?.(holding) ?? new Set(),
    personBuildingEfficiency: new Map(),
    effectiveWorkers: new Map(),
    financeContext
  };
},

_scaledCosts(costs = [], cycles = 1) {
  const multiplier = Math.max(0, this._safeNumber(cycles, 0));
  return scaleProductionCosts(costs, multiplier);
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
  return Math.max(0, Math.floor(this._safeNumber(item?.qty ?? item?.quantity ?? item?.count, 0)));
},

_collectProductionLine(holding, building, line, { ignoreWorkTime = false } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return { ok: false, message: "Нечего собирать." };
  const collectQd = Math.max(0, Math.ceil(this._safeNumber(line?.collectQd, 0)));
  if (collectQd > 0 && ["staff", "qd"].includes(buildingLaborMode(building))
    && !(ignoreWorkTime && globalThis.game?.user?.isGM === true)) {
    return { ok: false, message: `Для сбора нужно ${collectQd} QD. Назначьте сбор в плане работ и проведите десятник.` };
  }
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

_personBuildingEfficiency(holding, building, person, workerContext = null, options = { purpose: "production" }) {
  const number = (value, fallback = 0) => this._safeNumber?.(value, fallback) ?? (Number.isFinite(Number(value)) ? Number(value) : fallback);
  if (!person || person.dead || number(person?.injuredDays, 0) > 0) return 0;
  if (options?.purpose === "trade") {
    const bonus = this._buildingEfficiencyModifier?.(holding, building)?.value ?? 0;
    return Math.max(0, sellerQualification(person).efficiency * settlementHungerFactor(holding) * Math.max(0, 1 + bonus));
  }
  if (options?.purpose !== "production") return 1;
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
  const qualification = this._workerEfficiencyForPerson?.(holding, building, person) ?? { workUnits: 10_000 };
  let workUnits = Math.max(0, Math.floor(number(qualification.workUnits, 0)));
  const applyBasisFactor = (factor) => {
    const basisPoints = Math.max(0, Math.round(number(factor, 0) * 10_000));
    workUnits = Math.floor((workUnits * basisPoints) / 10_000);
  };
  applyBasisFactor(settlementHungerFactor(holding));
  const globalEffect = this._buildingEfficiencyModifier?.(holding, building);
  if (globalEffect?.value) applyBasisFactor(Math.max(0, 1 + globalEffect.value));
  const result = workUnits / 10_000;
  if (buildingCache && personId) buildingCache.set(personId, result);
  return result;
},

_assignedBuildingPeople(holding, building, workerContext = null, functionId = "") {
  if (workerContext?.financeContext) {
    const people = workerContext?.buildingWorkers?.get(building)?.economyAssignedPeople ?? [];
    const selectedFunctionId = String(functionId ?? "");
    if (!selectedFunctionId) return people;
    const buildingId = String(building?.id ?? "");
    return people.filter((person) => {
      const id = String(person?.id ?? "");
      const staff = workerContext.financeContext.staffAppointmentsByWorkerId?.get(id);
      if (staff) {
        if (String(staff.buildingId) !== buildingId) return false;
        return workerContext.financeContext.staffExecutionComplete
          ? (workerContext.financeContext.staffWorkByWorkerId?.get(id) ?? []).some((row) => row.functionId === selectedFunctionId && row.normalQd + row.overtimeQd > 0)
          : staffAppointmentWorkFunctions(staff).includes(selectedFunctionId);
      }
      return (workerContext.financeContext.plannedAssignmentsByWorkerId?.get(id) ?? [])
        .some((assignment) => assignment.sourceId === buildingId && assignment.functionId === selectedFunctionId);
    });
  }
  const cached = workerContext?.buildingWorkers?.get(building)?.assignedPeople;
  if (cached) return cached.filter((person) => isResidentInPopulation(person, holding));
  const ids = (building?.assignedWorkerIds ?? []).filter(Boolean).map((id) => String(id));
  const people = holding?.people?.list ?? [];
  return ids.map((id) => people.find((person) => String(person.id) === id)).filter((person) => person && isResidentInPopulation(person, holding));
},

_buildingMinimumStaffStatus(holding, building, workerContext = null) {
  const people = this._activeAssignedBuildingPeople(holding, building, workerContext).filter((person) => {
    if (!workerContext?.financeContext) return true;
    return (workerContext.financeContext.plannedAssignmentsByWorkerId?.get(String(person.id)) ?? [])
      .some((row) => row.sourceId === String(building.id) && row.functionId !== MAINTENANCE_WORK_FUNCTION_ID
        && row.normalQd + row.overtimeQd > 0);
  });
  return minimumStaffStatus(buildingLaborMode(building) === "legacy" ? building : { ...building, workersMin: 0 }, people);
},

_activeAssignedBuildingPeople(holding, building, workerContext = null, functionId = "") {
  if (workerContext?.financeContext) return this._assignedBuildingPeople(holding, building, workerContext, functionId);
  const cached = workerContext?.buildingWorkers?.get(building)?.activeAssignedPeople;
  if (cached) return cached;
  return this._assignedBuildingPeople(holding, building, workerContext)
    .filter((person) => isResidentInPopulation(person, holding) && this._safeNumber(person?.injuredDays, 0) <= 0);
},

_plannedWorkerFunctionQd(person, workerContext = null, sourceId = "", functionId = "") {
  if (!workerContext?.financeContext) return 0;
  const workerId = String(person?.id ?? "");
  if (workerContext.financeContext.staffAppointmentsByWorkerId?.has(workerId)) {
    return plannedAssignmentQd(workerContext.financeContext.staffWorkByWorkerId?.get(workerId) ?? [], sourceId, functionId);
  }
  return plannedAssignmentQd(
    workerContext.financeContext.plannedAssignmentsByWorkerId?.get(String(person?.id ?? "")) ?? [],
    sourceId,
    functionId
  );
},

_workerBudgetKey(personId = "", sourceId = "", functionId = "") {
  return `${String(personId ?? "")}::${String(sourceId ?? "")}::${String(functionId ?? "")}`;
},

_workerBudgetEntry(holding, person, budgets, workerContext = null, building = null, functionId = "") {
  const id = String(person?.id ?? "");
  const sourceId = String(building?.id ?? "");
  const selectedFunctionId = String(functionId ?? "");
  const staff = workerContext?.financeContext?.staffAppointmentsByWorkerId?.get(id);
  const key = staff
    ? this._workerBudgetKey(id, staff.buildingId, "staff")
    : workerContext?.financeContext && sourceId && selectedFunctionId
    ? this._workerBudgetKey(id, sourceId, selectedFunctionId)
    : id;
  const raw = budgets.get(key);
  const view = (entry) => staff ? staffBudgetView(entry, selectedFunctionId,
    workerContext.financeContext.staffOvertimeFunctionsByWorkerId?.get(id)?.has(selectedFunctionId)) : entry;
  if (raw && typeof raw === "object") return view(raw);
  const limit = this._personDailyWorkQdLimit(holding, person, workerContext);
  const entry = { available: this._safeNumber(raw, 0), spent: 0, limit, workerId: id,
    sourceId: staff?.buildingId ?? sourceId, functionId: staff ? "staff" : selectedFunctionId,
    ...(staff ? { staff: true, tokens: [] } : {}) };
  budgets.set(key, entry);
  return view(entry);
},

_workerBudgetEntriesForBuilding(person, budgets, building, workerContext = null, functionId = "") {
  if (!workerContext?.financeContext) return [this._workerBudgetEntry(null, person, budgets, workerContext)];
  const workerId = String(person?.id ?? "");
  const sourceId = String(building?.id ?? "");
  const selectedFunctionId = String(functionId ?? "");
  const staff = workerContext.financeContext.staffAppointmentsByWorkerId?.get(workerId);
  if (staff) {
    if (String(staff.buildingId) !== sourceId || selectedFunctionId && !staffAppointmentWorkFunctions(staff).includes(selectedFunctionId)) return [];
    const entry = budgets.get(this._workerBudgetKey(workerId, sourceId, "staff"));
    const currentFunction = selectedFunctionId || workerContext.financeContext.staffCurrentFunctionByWorkerId?.get(workerId);
    if (Number.isInteger(workerContext.financeContext.staffStep)
      && workerContext.financeContext.staffCurrentFunctionByWorkerId.get(workerId) !== currentFunction) return [];
    return entry && currentFunction ? [staffBudgetView(entry, currentFunction,
      workerContext.financeContext.staffOvertimeFunctionsByWorkerId?.get(workerId)?.has(currentFunction))] : [];
  }
  const assignments = workerContext.financeContext.plannedAssignmentsByWorkerId?.get(workerId) ?? [];
  const functionIds = [...new Set(assignments
    .filter((assignment) => assignment.sourceId === sourceId && (!selectedFunctionId || assignment.functionId === selectedFunctionId))
    .map((assignment) => assignment.functionId))];
  return functionIds.map((fn) => budgets.get(this._workerBudgetKey(workerId, sourceId, fn))).filter(Boolean);
},

_personDailyWorkQdLimit(holding, person, workerContext = null) {
  if (!isResidentInPopulation(person, holding) || this._canResidentWork?.(person, holding) === false) return 0;
  if (this._isChildResident?.(person) === true) return 1;
  const assigned = String(person?.workAssignment ?? "");
  const building = workerContext?.buildingsByAssignment?.get(assigned)
    ?? (holding?.buildings?.list ?? []).find((item) => String(item.id) === assigned || String(item.name) === assigned);
  const overtime = workerContext?.overtimeByBuilding?.has(building)
    ? workerContext.overtimeByBuilding.get(building)
    : this._buildingHasOvertimeProduction?.(building);
  if (building && overtime) return 3;
  return 2;
},

_resetWorkerBudgets(holding, budgets, workerContext = null) {
  budgets.clear();
  if (workerContext?.financeContext) return;
  const people = workerContext?.peopleById?.values?.() ?? holding?.people?.list ?? [];
  for (const person of people) {
    budgets.set(String(person.id), { available: 0, spent: 0, limit: this._personDailyWorkQdLimit(holding, person, workerContext) });
  }
},

_accrueWorkerBudgets(holding, budgets, workerContext = null, step = 0) {
  if (workerContext?.financeContext) {
    for (const [workerId, slots] of workerContext.financeContext.plannedWorkSlotsByWorkerId ?? []) {
      const slot = slots.get(Math.max(0, Math.floor(this._safeNumber(step, 0))));
      if (!slot) continue;
      if (workerContext.financeContext.staffReservedStepsByWorkerId?.get(workerId)?.has(step)) continue;
      const key = this._workerBudgetKey(workerId, slot.sourceId, slot.functionId);
      const entry = budgets.get(key) ?? { available: 0, spent: 0, limit: slot.overtime ? 3 : 2, workerId, sourceId: slot.sourceId, functionId: slot.functionId };
      if (workerContext.financeContext.staffAppointmentsByWorkerId?.has(workerId)) {
        entry.staff = true;
        entry.tokens ??= [];
        entry.tokens.push({ step, overtime: slot.overtime, qd: 1 });
      }
      entry.available += 1;
      budgets.set(key, entry);
    }
    return;
  }
  // Внутри дня житель получает по 1 рабочему QD за прошедший QD,
  // но суммарно не больше дневного лимита: 2 QD обычно, 3 QD при переработке.
  const people = workerContext?.peopleById?.values?.() ?? holding?.people?.list ?? [];
  for (const person of people) {
    const entry = this._workerBudgetEntry(holding, person, budgets, workerContext);
    entry.limit = this._personDailyWorkQdLimit(holding, person, workerContext);
    const room = Math.max(0, entry.limit - entry.spent - entry.available);
    if (room > 0) entry.available += Math.min(1, room);
  }
},

_availableEffectiveWorkQd(holding, building, budgets, workerContext = null, functionId = "") {
  let total = 0;
  for (const person of this._assignedBuildingPeople(holding, building, workerContext, functionId)) {
    const budget = this._workerBudgetEntriesForBuilding(person, budgets, building, workerContext, functionId)
      .reduce((sum, entry) => sum + this._safeNumber(entry.available, 0), 0);
    if (budget <= 0) continue;
    total += this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "production" }) * budget;
  }
  return Math.max(0, total);
},

_spendBuildingWorkerQd(holding, building, budgets, needed = 0, workerContext = null, functionId = "") {
  // Реальное рабочее время. Используется для сбора: 1 QD сбора всегда стоит 1 QD времени,
  // независимо от производственной эффективности работника.
  let rest = Math.max(0, this._safeNumber(needed, 0));
  let spent = 0;
  if (!rest) return { ok: true, spent: 0 };
  // Collection has no stored partial progress. Do not consume a partial shift
  // when the complete collection cannot be funded by the allowed assignments.
  const entries = [...new Set(this._assignedBuildingPeople(holding, building, workerContext, functionId)
    .flatMap((person) => this._workerBudgetEntriesForBuilding(person, budgets, building, workerContext, functionId)))];
  const available = entries.reduce((sum, entry) => sum + Math.max(0, this._safeNumber(entry.available, 0)), 0);
  if (available + 0.0001 < rest) return { ok: false, spent: 0 };
  for (const entry of entries) {
    if (rest <= 0) break;
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    const take = Math.min(budget, rest);
    entry.available = budget - take;
    entry.spent += take;
    if (entry.staff) this._recordStaffWorkQd?.(workerContext, entry, functionId || entry.selectedFunctionId, take);
    rest -= take;
    spent += take;
  }
  return { ok: rest <= 0.0001, spent };
},

_spendBuildingEffectiveWorkQd(holding, building, budgets, needed = 0, workerContext = null, functionId = "") {
  // Производственное время. Эффективные работники покрывают больше эффективных QD
  // тем же реальным временем.
  let rest = Math.max(0, this._safeNumber(needed, 0));
  let spentReal = 0;
  let spentEffective = 0;
  if (!rest) return { ok: true, spent: 0, spentEffective: 0 };
  for (const person of this._assignedBuildingPeople(holding, building, workerContext, functionId)) {
    if (rest <= 0) break;
    for (const entry of this._workerBudgetEntriesForBuilding(person, budgets, building, workerContext, functionId)) {
      if (rest <= 0) break;
      const budget = this._safeNumber(entry.available, 0);
      if (budget <= 0) continue;
      const efficiency = Math.max(0.0001, this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "production" }));
      const realNeeded = rest / efficiency;
      const takeReal = Math.min(budget, realNeeded);
      const takeEffective = takeReal * efficiency;
      entry.available = budget - takeReal;
      entry.spent += takeReal;
      rest -= takeEffective;
      spentReal += takeReal;
      spentEffective += takeEffective;
    }
  }
  return { ok: rest <= 0.0001, spent: spentReal, spentEffective };
},

_periodDueOnStep(period = "day", stepIndex = 0, cyclesPerTrigger = 1) {
  const p = String(period ?? "day");
  const unit = p === "qd" ? 1 : p === "tenday" ? 40 : 4;
  const cycle = Math.max(1, Math.floor(this._safeNumber(cyclesPerTrigger, 1)));
  const span = unit * cycle;
  // stepIndex is zero-based and represents an elapsed QD.
  // A daily line must not fire on the first QD of the day; it fires when a full day has elapsed.
  return (stepIndex + 1) % span === 0;
},

_costsForUnits(costs = [], units = 0) {
  const count = Math.max(0, Math.floor(this._safeNumber(units, 0)));
  return scaleProductionCosts(costs, count);
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
    return { qty: Math.max(0, Math.floor(rolled.total)), formula: `${line.formula} → ${rolled.result} = ${rolled.total}` };
  }
  return { qty: Math.max(0, Math.floor(base)), formula: "" };
},

async _collectLineToStorage(holding, building, line, budgets, report, { by = "building", neededResource = "", workerContext = null } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return 0;
  const collectQd = Math.max(0, Math.ceil(this._safeNumber(line?.collectQd, 0)));
  if (collectQd > 0) {
    const payer = by === "worker" ? building : building;
    const functionId = this._financeLineFunctionId(line, (building?.productionLines ?? []).indexOf(line));
    const spent = this._spendBuildingWorkerQd(holding, payer, budgets, collectQd, workerContext, functionId);
    if (!spent.ok) {
      report.skipped.push(`${building.name || "Здание"}: не хватает рабочих QD для сбора (${spent.spent}/${collectQd}).`);
      return 0;
    }
  }
  const resourceId = normalizeResourceId(line.resourceId, line.resource);
  if (neededResource && normalizeResourceId(neededResource) !== resourceId) return 0;
  const resourceName = resourceId === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(resourceId);
  const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
  const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, pending);
  line.pendingQty = 0;
  this._pushProductionPlacement(report, holding, building.name || "Здание", resourceName, placements, by === "worker" ? " собрано работником-потребителем" : " собрано", resourceId);
  return pending;
},

async _autoCollectBuilding(holding, building, budgets, report, workerContext = null, financeContext = null) {
  for (const line of building?.productionLines ?? []) {
    if (!line?.requiresCollection) continue;
    const functionId = this._financeLineFunctionId(line, (building.productionLines ?? []).indexOf(line));
    const selectedStaff = [...(workerContext?.financeContext?.staffAppointmentsByWorkerId ?? [])].some(([workerId, appointment]) => (
      String(appointment.buildingId) === String(building.id)
      && workerContext.financeContext.staffCurrentFunctionByWorkerId?.get(workerId) === functionId
    ));
    const selectedQd = buildingLaborMode(building) === "qd"
      && this._assignedBuildingPeople(holding, building, workerContext, functionId).some((person) =>
        this._workerBudgetEntriesForBuilding(person, budgets, building, workerContext, functionId).some((entry) => entry.available > 0));
    if (String(line.autoCollect ?? "none") !== "building" && !selectedStaff && !selectedQd) continue;
    if (!this._financeFunctionAllowed(financeContext, building, this._financeLineFunctionId(line))) continue;
    await this._collectLineToStorage(holding, building, line, budgets, report, { by: "building", workerContext });
  }
},

async _tryCollectResourceForConsumer(holding, consumerBuilding, resourceId, budgets, report, workerContext = null, financeContext = null, consumerFunctionId = "") {
  const wanted = normalizeResourceId(resourceId);
  let collected = 0;
  for (const sourceBuilding of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(sourceBuilding).value !== "built") continue;
    for (const line of sourceBuilding?.productionLines ?? []) {
      if (!line?.requiresCollection || String(line.autoCollect ?? "none") !== "worker") continue;
      if (!this._financeFunctionAllowed(financeContext, sourceBuilding, this._financeLineFunctionId(line))) continue;
      if (normalizeResourceId(line.resourceId, line.resource) !== wanted) continue;
      // В этом режиме рабочий здания-потребителя тратит время, чтобы забрать готовый ресурс из другого здания.
      const pending = Math.max(0, Math.floor(this._safeNumber(line.pendingQty, 0)));
      if (!pending) continue;
      const collectQd = Math.max(0, Math.ceil(this._safeNumber(line.collectQd, 0)));
      if (collectQd > 0) {
        const functionId = buildingLaborMode(consumerBuilding) === "legacy" ? "" : consumerFunctionId;
        const spent = this._spendBuildingWorkerQd(holding, consumerBuilding, budgets, collectQd, workerContext, functionId);
        if (!spent.ok) continue;
      }
      const resourceName = wanted === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(wanted);
      const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
      const placements = this._storageAddWithOverflow(holding, { resourceId: wanted, name: resourceName, roomId }, pending);
      line.pendingQty = 0;
      collected += pending;
      this._pushProductionPlacement(report, holding, consumerBuilding.name || "Здание", resourceName, placements, ` собрано у ${sourceBuilding.name || "здания"}`, wanted);
    }
  }
  return collected;
},

_productionCycleDependencies({ holding: sourceHolding = null, lineOutputForCycle = null, financeContext = null } = {}) {
  return {
    beforeStep: (holding, step, report) => {
      setResourceBatchPeriodStep(holding, step);
      expireProductionIngredients(holding, step, report, appendEconomyLedger);
    },
    afterPeriod: (holding) => setResourceBatchPeriodStep(holding),
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    resetWorkerBudgets: (holding, budgets, workerContext, step) => this._resetWorkerBudgets(holding, budgets, workerContext, step),
    accrueWorkerBudgets: (holding, budgets, workerContext, step) => this._accrueWorkerBudgets(holding, budgets, workerContext, step),
    getSeasonSnapshot: (holding, step = 0) => {
      const calendar = holding?.gm?.calendaria ?? {};
      const lastDateTime = calendar.lastDateTime;
      if (!lastDateTime || typeof lastDateTime !== "object") {
        return getCalendariaSeasonSnapshot(null, calendar.lastDateText ?? calendar.lastDateKey)
          ?? getCalendariaSnapshot?.()
          ?? null;
      }
      const dateTime = step > 0 ? addCalendariaQd(lastDateTime, step) : lastDateTime;
      return getCalendariaSeasonSnapshot(dateTime, calendar.lastDateText ?? calendar.lastDateKey);
    },
    buildingStatus: (building) => this._buildingStatus(building),
    buildingFunctions: (building) => {
      const functions = this._buildingFunctions(building);
      return {
        ...functions,
        production: functions.production
          && !financeContext?.mothballedBuildingIds?.has(String(building?.id ?? ""))
          && !financeContext?.baseBlockedBuildingIds?.has(String(building?.id ?? ""))
      };
    },
    lineFinanceAllowed: (building, line) => this._financeFunctionAllowed(
      financeContext,
      building,
      this._financeLineFunctionId(line)
    ),
    buildingTechnicalReady: (building, step) => this._technicalMaintenanceReady(building, financeContext, step),
    lineSeasonAllowed: (line, snapshot) => this._lineSeasonAllowed ? this._lineSeasonAllowed(line, snapshot) : true,
    periodDueOnStep: (period, step, cycles) => this._periodDueOnStep(period, step, cycles),
    normalizeResourceId,
    resourceLabel,
    lineContentQuantity: (building, line) => this._lineContentQuantity(building, line),
    buildingEffectiveWorkers: (holding, building, workerContext) => this._buildingEffectiveWorkers(holding, building, workerContext),
    lineOutputForCycle: lineOutputForCycle ?? ((line, context) => this._lineOutputForCycle(line, context)),
    parseResourceCosts: (text) => this._parseResourceCosts(text),
    costsForUnits: (costs, units) => this._costsForUnits(costs, units),
    scaledCosts: (costs, cycles) => this._scaledCosts(costs, cycles),
    storageCanPay: (holding, costs) => this._storageCanPay(holding, costs),
    storagePay: (holding, costs) => this._storagePay(holding, costs, { captureReceipt: true }),
    refundProductionInputs: (holding, receipt, lost, qty) => refundProductionInputs(holding, receipt, lost, qty, {
      addMoney: (draft, amount) => this._addMoney(draft, amount),
      addResource: (draft, resource, amount) => this._restoreProductionResource(draft, resource, amount)
    }),
    normalizeStorageRoomId: (roomId) => this._normalizeStorageRoomId(roomId),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    pushProductionPlacement: (report, holding, source, resource, placements, extra, resourceId) => this._pushProductionPlacement(report, holding, source, resource, placements, extra, resourceId),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries),
    autoCollectBuilding: (holding, building, budgets, report, workerContext) => this._autoCollectBuilding(holding, building, budgets, report, workerContext, financeContext),
    assignedBuildingPeople: (holding, building, workerContext, line) => {
      const functionId = this._financeLineFunctionId(line, (building?.productionLines ?? []).indexOf(line));
      return this._assignedBuildingPeople(holding, building, workerContext, functionId)
        .filter((person) => this._staffSelectedForFunction(person, building, functionId, workerContext));
    },
    workerBudgetEntry: (holding, person, budgets, workerContext, building, line) => this._workerBudgetEntry(
      holding,
      person,
      budgets,
      workerContext,
      building,
      this._financeLineFunctionId(line, (building?.productionLines ?? []).indexOf(line))
    ),
    personBuildingEfficiency: (holding, building, person, workerContext) => this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "production" }),
    linePreparationGoal: (building, line) => productionPreparationGoal(
      sourceHolding ?? {}, String(building?.id ?? ""),
      this._financeLineFunctionId(line, (building?.productionLines ?? []).indexOf(line))
    ),
    prepareStaffWorkerStep: (holding, budgets, workerContext, step, options) => this._prepareStaffWorkerStep(holding, budgets, workerContext, step, options),
    canCollectProductionInputs: (holding, building, missing, workerContext) => this._canCollectStaffProductionInputs(holding, building, missing, workerContext),
    staffCanCollectLine: (building, line, workerContext) => this._staffCanCollectLine(building, line, workerContext),
    recordWorkerWork: (workerContext, entry, building, line, qd) => this._recordStaffWorkQd(workerContext, entry,
      this._financeLineFunctionId(line, (building.productionLines ?? []).indexOf(line)), qd),
    minimumStaffStatus: (holding, building, workerContext, budgets, step) => {
      const people = this._activeAssignedBuildingPeople(holding, building, workerContext).filter((person) => {
        if (workerContext?.financeContext) {
          const slot = workerContext.financeContext.plannedWorkSlotsByWorkerId?.get(String(person.id))?.get(step);
          return slot?.sourceId === String(building.id) && slot.functionId !== MAINTENANCE_WORK_FUNCTION_ID;
        }
        return this._workerBudgetEntriesForBuilding(person, budgets, building, workerContext)
          .some((entry) => entry.available >= 1);
      });
      return { ...minimumStaffStatus(buildingLaborMode(building) === "legacy" ? building : { ...building, workersMin: 0 }, people), people };
    },
    buildingCompositionStatus: (building, people, options) => buildingCompositionStatus(building, people, options),
    maintenanceEfficiencyFactor: (building) => this._maintenanceEfficiencyFactor?.(building) ?? 1,
    storageQuantity: (holding, resource) => this._storageQuantity(holding, resource),
    tryCollectResourceForConsumer: (holding, building, resourceId, budgets, report, workerContext, line) => this._tryCollectResourceForConsumer(
      holding, building, resourceId, budgets, report, workerContext, financeContext,
      this._financeLineFunctionId(line, (building.productionLines ?? []).indexOf(line))),
    affordableUnitsForCosts: (holding, costs, units) => this._affordableUnitsForCosts(holding, costs, units),
    formatNumber: (value) => this._formatNumber(value)
  };
},

async _runProductionCycleForQd(holding, qd, report, { buildings = holding?.buildings?.list ?? [], budgets = new Map(), workerContext = null, lineOutputForCycle = null, financeContext = null, afterStep = null } = {}) {
  return runProductionCycle({
    holding,
    qd,
    report,
    buildings,
    budgets,
    workerContext,
    afterStep,
    dependencies: this._productionCycleDependencies({ holding, lineOutputForCycle, financeContext })
  });
},

_recordBuildingServiceActivity(holding, report, financeContext = null) {
  const periodKey = String(financeContext?.periodIdentity?.periodKey ?? "");
  const assignments = [...(financeContext?.plannedAssignmentsByWorkerId?.entries?.() ?? [])].flatMap(([workerId, rows]) => (
    (financeContext.staffAppointmentsByWorkerId?.has(workerId) ? financeContext.staffWorkByWorkerId?.get(workerId) ?? [] : rows ?? [])
      .filter((assignment) => assignment?.functionId !== MAINTENANCE_WORK_FUNCTION_ID)
      .map((assignment) => ({ ...assignment, workerId: String(workerId ?? "") }))
  ));
  const positiveLedgerSourceIds = new Set(report?.positiveLedgerSourceIds ?? (report?.ledger ?? [])
    .filter((entry) => Number(entry?.qty) > 0)
    .map((entry) => String(entry?.sourceId ?? ""))
    .filter(Boolean));
  for (const building of holding?.buildings?.list ?? []) {
    const buildingId = String(building?.id ?? "");
    const readyAssignments = buildingLaborMode(building) === "staff" ? assignments
      : financeContext?.technicalServiceAssignments?.get(buildingId)
        ?? (this._technicalMaintenanceReady(building, financeContext, financeContext?.periodQd ?? 40) ? assignments : []);
    const workedQd = readyAssignments.reduce((sum, assignment) => (
      String(assignment?.sourceId ?? "") === buildingId
        ? sum + Math.max(0, Math.floor(this._safeNumber(assignment?.normalQd, 0))) + Math.max(0, Math.floor(this._safeNumber(assignment?.overtimeQd, 0)))
        : sum
    ), 0);
    const buildingAssignments = readyAssignments.filter((assignment) => String(assignment?.sourceId ?? "") === buildingId);
    const activeWorkerIds = [...new Set(buildingAssignments.map((assignment) => String(assignment?.workerId ?? "")).filter(Boolean))];
    const workedQdByFunction = {};
    const workedQdByWorkerAndFunction = {};
    const workerIdsByFunction = {};
    for (const assignment of buildingAssignments) {
      const functionId = String(assignment?.functionId ?? "");
      if (!functionId) continue;
      const assignmentQd = Math.max(0, Math.floor(this._safeNumber(assignment?.normalQd, 0)))
        + Math.max(0, Math.floor(this._safeNumber(assignment?.overtimeQd, 0)));
      if (assignmentQd <= 0) continue;
      const workerId = String(assignment.workerId ?? "");
      if (workerId) {
        const work = workedQdByWorkerAndFunction[workerId] ??= {};
        work[functionId] = (work[functionId] ?? 0) + assignmentQd;
        if (functionId.startsWith("production:")) work.production = (work.production ?? 0) + assignmentQd;
      }
      workedQdByFunction[functionId] = (workedQdByFunction[functionId] ?? 0) + assignmentQd;
      if (!workerIdsByFunction[functionId]) workerIdsByFunction[functionId] = new Set();
      if (assignment?.workerId) workerIdsByFunction[functionId].add(String(assignment.workerId));
      if (functionId.startsWith("production:")) {
        workedQdByFunction.production = (workedQdByFunction.production ?? 0) + assignmentQd;
        if (!workerIdsByFunction.production) workerIdsByFunction.production = new Set();
        if (assignment?.workerId) workerIdsByFunction.production.add(String(assignment.workerId));
      }
    }
    const activeWorkerIdsByFunction = Object.fromEntries(Object.entries(workerIdsByFunction)
      .map(([functionId, ids]) => [functionId, [...ids]]));
    const meaningfulResult = positiveLedgerSourceIds.has(buildingId);
    const functions = this._buildingFunctions(building);
    const functionId = building?.activation?.requiresMeaningfulResult === true && functions.production ? "production"
      : functions.culture ? "culture"
      : functions.income ? "income"
        : functions.defense ? "defense"
          : functions.production ? "production"
            : functions.storage ? "storage"
              : "culture";
    const previous = building?.serviceState && typeof building.serviceState === "object" ? building.serviceState : {};
    const externallyStopped = previous.active === false
      && String(previous.periodKey ?? "") === periodKey
      && Boolean(String(previous.reason ?? "").trim());
    const minWorkers = buildingLaborMode(building) === "legacy"
      ? Math.max(0, Math.floor(this._safeNumber(building?.workersMin, 0)), Math.floor(this._safeNumber(building?.activation?.minWorkers, 0)))
      : 0;
    const minOperationalQd = Math.max(0, Math.floor(this._safeNumber(building?.activation?.minOperationalQd ?? building?.minOperationalQd, 0)));
    const mode = buildingLaborMode(building);
    const laborActive = mode === "passive" || (mode === "legacy"
      ? activeWorkerIds.length >= minWorkers && workedQd >= minOperationalQd
      : workedQd > 0);
    const resultActive = building?.activation?.requiresMeaningfulResult !== true || meaningfulResult;
    const meaningfulResultByFunction = {
      ...(previous.periodKey === periodKey && previous?.meaningfulResultByFunction && typeof previous.meaningfulResultByFunction === "object"
        ? previous.meaningfulResultByFunction : {})
    };
    for (const recordedFunction of Object.keys(workedQdByFunction)) meaningfulResultByFunction[recordedFunction] = false;
    if (meaningfulResult && functions.production) meaningfulResultByFunction.production = true;
    building.serviceState = {
      ...previous,
      functionId,
      active: !externallyStopped && laborActive && resultActive,
      periodKey,
      workedQd,
      workedQdByFunction,
      activeWorkerIds,
      activeWorkerIdsByFunction,
      workedQdByWorkerAndFunction,
      meaningfulResult,
      meaningfulResultByFunction,
      reason: externallyStopped ? String(previous.reason ?? "")
        : !laborActive ? "За период не выполнен порог фактического труда."
        : !resultActive ? "За период нет содержательного результата функции."
          : ""
    };
  }
},

async _runProductionAndLivestockForQd(holding, qd, report, { operationId = "", buildings = holding?.buildings?.list ?? [], budgets = new Map(), workerContext = null, financeContext = null, lineOutputForCycle = null } = {}) {
  await this._runProductionCycleForQd(holding, qd, report, {
    buildings: this._nonAgricultureProductionBuildings(buildings),
    budgets,
    workerContext,
    financeContext,
    lineOutputForCycle,
    // The day's feed can be milled before the herd is fed. Milk and eggs are
    // delivered at day end and available to the next day's processing shift.
    afterStep: (step) => {
      this._runStaffAgricultureStep?.(holding, step, report, { operationId, workerContext, financeContext, budgets });
      if ((step + 1) % 4) return;
      const livestockResult = this._runLivestockForQd(holding, 4, report, {
        operationId: operationId ? `${operationId}:livestock:day-${(step + 1) / 4}` : "",
        workerContext, financeContext, stepOffset: step - 3, cycleQd: 4
      });
      if (!livestockResult.ok) throw new Error(livestockResult.message || "Не удалось рассчитать животноводство.");
    }
  });
  this._flushStaffAgricultureReport?.(holding, report, financeContext);
  this._finishStaffExecution(holding, report, financeContext);
},

async _runEconomyForQd(holding, periodQd = 40, { operationId = "", createdAt = "", data = null } = {}) {
  const qd = Math.max(1, Math.floor(this._safeNumber(periodQd, 40)));
  if (qd !== 40 && (holding?.buildings?.list ?? []).some((building) => ["staff", "qd", "passive"].includes(buildingLaborMode(building)))) {
    throw new Error("Новая система труда рассчитывается по одному десятнику. Проведите каждый десятник отдельно.");
  }
  const label = this._periodLabel(qd);
  const report = { periodQd: qd, periodLabel: label, produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [], food: { needed: 0, eaten: 0, hungryResidentDays: 0, availableBeforeConsumption: 0, lines: [] }, construction: { attempts: 0, completed: 0, lines: [] }, trade: { buyers: 0, sold: 0, revenue: 0, purchases: [] }, treasury: { spent: 0, deficit: 0, lines: [] } };
  if (holding.special?.banking?.loans?.some((loan) => loan.status !== "paid")) {
    const { advanceBankLoans } = await import("../../../engines/economy/banking.js");
    for (const row of advanceBankLoans(holding, qd)) {
      const text = `${row.bankName}: начислено ${row.interestCopper} ММ процентов; долг ${row.balanceCopper} ММ${row.overdue ? "; просрочен" : ""}.`;
      report.treasury.lines.push(text);
      appendEconomyLedger(report, { domain: "bank", kind: "notice", name: "Состояние займа", note: text,
        status: row.overdue ? "pending" : "", meta: { loanId: row.loanId } });
    }
  }
  const buildings = holding?.buildings?.list ?? [];
  const budgets = new Map();

  const worldShips = (holding.special?.ships?.list ?? []).some((ship) => ship.navigationMode === "world")
    ? await import("../../../engines/ships/world-economy.js") : null;
  const periodStartQd = holding.gm?.calendaria?.lastQd ?? 0;
  if (worldShips && data) worldShips.refreshWorldShipHomeEconomy(data, holding, { report });
  const residentPresenceDaysById = worldShips?.worldShipPresenceDays(holding, periodStartQd, periodStartQd + qd) ?? null;

  // Logistics is resolved at the boundary of the elapsed period. Cargo that
  // reaches the settlement during that period is therefore available to the
  // production, food, construction, and trade phases resolved below.
  this._advanceMarketShipmentsForQd(holding, qd, report);
  // Own outbound consignments must observe the ship at this boundary. Other
  // world ships keep their usual end-of-period economy phase below.
  if (worldShips) {
    const ownSaleShipIds = new Set((holding.special?.market?.outbound?.orders ?? [])
      .filter((order) => order.ownShipId && !["delivered", "lost", "cancelled"].includes(order.status))
      .map((order) => order.ownShipId));
    for (const shipId of ownSaleShipIds) {
      worldShips.advanceWorldShipEconomy(holding, periodStartQd + qd, report, appendEconomyLedger, { shipId });
    }
  }
  this._advanceMarketOutboundForQd(holding, qd, report, { advancedAt: createdAt });
  if ((holding.special?.ships?.list ?? []).some((ship) => ship?.activeVoyage)) {
    const { advanceShipVoyages } = await import("../../../engines/ships/runtime.js");
    const ships = advanceShipVoyages(holding, (holding.gm?.calendaria?.lastQd ?? 0) + qd);
    for (const row of ships.returned) {
      report.work.push(`${row.shipName}: рейс завершён, в казну возвращено ${row.returnedCopper} ММ, результат ${row.netCopper} ММ.`);
      appendEconomyLedger(report, {
        domain: "treasury", kind: "money", resourceId: "money", name: "Возврат бортовой казны",
        qty: row.returnedCopper, roomId: "treasury", source: row.shipName, operationId: `${row.id}:return`,
        note: "Перевод включает остаток бюджета; это не повторная торговая выручка.",
        meta: { internalTransfer: true, storageKind: "transfer", voyageNetCopper: row.netCopper }
      });
    }
    for (const row of ships.awaiting) {
      report.work.push(row.waitingFunds
        ? `${row.name}: исход рейса сохранён; для завершения требуется ${row.expenseCopper} ММ в бортовой казне.`
        : `${row.name}: корабль прибыл и ожидает подведения итогов рейса.`);
    }
    for (const row of ships.blocked) report.skipped.push(`${row.name}: ${row.message}`);
  }
  const financeContext = this._prepareFinanceForQd(holding, qd, report, { operationId, createdAt });
  const maintenanceResult = this._runMaintenanceForQd(holding, qd, report, {
    operationId: operationId ? `${operationId}:maintenance` : "",
    financeContext
  });
  if (!maintenanceResult.ok) throw new Error(maintenanceResult.message || "Не удалось рассчитать трудовое обслуживание зданий.");
  this._prepareTechnicalServiceRestarts(holding, financeContext, report);
  const workerContext = this._economyWorkerContext(holding, { financeContext });
  this._runInstitutionConsumables(holding, qd, report, workerContext, financeContext);
  this._runInstitutionResolutions(holding, report, workerContext, financeContext, { operationId, createdAt });
  const politicsContext = politicsDecisionContext(holding, this, { data });
  const politicsPeriod = preparePoliticsPeriod(holding, {
    context: politicsContext, periodIndex: politicsPeriodIndex(periodStartQd), periods: Math.floor(qd / 40)
  });
  report.politics = { effects: politicsPeriod.effects, charges: politicsPeriod.charges,
    unpaidDirectiveIds: politicsPeriod.unpaidDirectiveIds, influenceGained: 0, expiredDecreeIds: [] };
  for (const charge of politicsPeriod.charges) {
    report.treasury.spent += charge.copper;
    report.treasury.lines.push(`${charge.label}: содержание −${charge.copper} ММ.`);
    appendEconomyLedger(report, { domain: "politics", kind: "money", resourceId: "money", name: "Деньги",
      qty: -charge.copper, roomId: "treasury", source: charge.label,
      note: "Содержание политической директивы" });
  }
  for (const id of politicsPeriod.unpaidDirectiveIds) report.skipped.push(`Политика: содержание директивы ${id} не оплачено.`);
  const agricultureResult = this._runAgricultureForQd(holding, qd, report, {
    operationId: operationId ? `${operationId}:agriculture` : "",
    workerContext,
    financeContext
  });
  if (!agricultureResult.ok) throw new Error(agricultureResult.message || "Не удалось рассчитать сельское хозяйство.");
  await this._runProductionAndLivestockForQd(holding, qd, report, { operationId, buildings, budgets, workerContext, financeContext });
  this._settleStaffPersonnelCashback(holding, report, financeContext);
  this._runInstitutionResolutions(holding, report, workerContext, financeContext, { operationId, createdAt, staffOnly: true });

  // Доходность пока остается старым блоком “за десятник”. Для меньших периодов она
  // не начисляется, чтобы трактиры и рейсы не дробились странными частями.
  for (const building of buildings) {
    if (this._buildingStatus(building).value !== "built") continue;
    const functions = this._buildingFunctions(building);
    if (!functions.income) continue;
    // Торговые здания получают деньги только из конечного бюджета внутреннего
    // спроса и фактически проданного stock/service capacity. Их старый
    // фиксированный доход нельзя начислять параллельно: это удваивало выручку и
    // позволяло печатать деньги без покупателя.
    if (building?.income?.trade?.enabled) continue;
    if (!this._financeFunctionAllowed(financeContext, building, "income")) {
      report.skipped.push(`${building.name || "Здание"}: доход остановлен из-за неоплаченных обязательств или консервации.`);
      continue;
    }
    const incomePeriods = Math.floor(qd / 40);
    if (incomePeriods <= 0) continue;
    const assignedPeople = this._activeAssignedBuildingPeople(holding, building, workerContext, "income");
    if (!this._buildingMinimumStaffStatus(holding, building, workerContext).met) {
      report.skipped.push(`${building.name || "Здание"}: доход остановлен — не набран минимальный штат.`);
      continue;
    }
    const assigned = assignedPeople.length;
    if (!assigned) {
      report.skipped.push(`${building.name || "Здание"}: доход не получен — работник не назначен.`);
      continue;
    }
    const normalCapacityQd = 20 * incomePeriods;
    const workerShares = assignedPeople.map((person) => {
      const plannedQd = workerContext?.financeContext
        ? this._plannedWorkerFunctionQd(person, workerContext, building?.id, "income")
        : normalCapacityQd;
      return Math.min(1.5, Math.max(0, this._safeNumber(plannedQd, 0)) / normalCapacityQd);
    });
    const workerEquivalents = workerShares.reduce((sum, share) => sum + share, 0);
    const eff = assignedPeople.reduce((sum, person, index) => (
      sum + this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "service" }) * workerShares[index]
    ), 0);
    const income = building.income ?? {};
    const base = this._safeNumber(income.base, 0);
    const perWorker = this._safeNumber(income.perWorker, 0);
    const maintenanceFactor = this._maintenanceEfficiencyFactor?.(building) ?? 1;
    let total = (base * Math.min(1, workerEquivalents) + perWorker * eff) * incomePeriods * maintenanceFactor;
    let formulaResult = "";
    if (String(income.formula ?? "").trim()) {
      total = 0;
      for (let i = 0; i < incomePeriods; i += 1) {
        const rolled = await this._rollFormulaTotal(income.formula, { eff, workers: workerEquivalents, base, cycles: incomePeriods, qd, workqd: workerEquivalents * normalCapacityQd });
        total += Math.floor(rolled.total * maintenanceFactor);
        formulaResult = rolled.result;
        report.formulas.push(`${building.name || "Здание"} / Доход ${i + 1}/${incomePeriods}: ${income.formula} → ${rolled.result} = ${rolled.total}`);
      }
    }
    total = Math.max(0, Math.floor(total));
    if (total) {
      this._addMoney(holding, total);
      report.income.push(`${building.name || "Здание"}: Деньги +${total}${formulaResult ? ` (${formulaResult})` : ""}`);
      appendEconomyLedger(report, {
        domain: "income",
        kind: "money",
        resourceId: "money",
        name: "Деньги",
        qty: total,
        roomId: "treasury",
        sourceId: building.id,
        source: building.name || "Здание",
        note: formulaResult ? `Формула: ${formulaResult}` : "Пассивный доход"
      });
    }
  }

  report.food.availableBeforeConsumption = (holding?.storage?.resources ?? [])
    .filter((row) => this._isFoodResource(row))
    .reduce((sum, row) => sum + Math.max(0, Math.floor(this._safeNumber(row?.qty, 0))), 0);
  this._runFoodConsumptionForQd(holding, qd, report, { residentPresenceDaysById });
  const fullyFed = report.food.needed > 0 && report.food.effectiveTier === report.food.selectedTier && !report.food.fallback
    && report.food.eaten >= report.food.needed;
  report.politics.effects = refreshPoliticsPeriodEffects(holding, politicsPeriod, { rationFullySupplied: fullyFed });
  this._runConstructionCrewsForQd(holding, qd, report, { blockedWorkerIds: financeContext.blockedWorkerIds });
  this._runInternalDemandForQd(holding, qd, report, financeContext, {
    operationId: operationId ? `${operationId}:internal-demand` : "",
    workerContext
  });
  this._recordBuildingServiceActivity(holding, report, financeContext);
  // Final political rewards observe the services that actually worked this period.
  const finalPoliticsContext = politicsDecisionContext(holding, this, { data });
  delete finalPoliticsContext.networkPaid;
  report.politics.effects = refreshPoliticsPeriodEffects(holding, politicsPeriod, {
    context: finalPoliticsContext, rationFullySupplied: fullyFed
  });
  const moraleSnapshot = this._recordTendayMoraleSnapshot?.(holding, report, financeContext, { operationId, createdAt });
  if (moraleSnapshot) {
    moraleSnapshot.rawMorale = this._calculateMorale?.(holding) ?? 0;
    moraleSnapshot.control = this._controlSummary?.(holding, moraleSnapshot.rawMorale) ?? null;
    report.morale = clone(moraleSnapshot);
  }

  if (worldShips) {
    worldShips.advanceWorldShipEconomy(holding, periodStartQd + qd, report, appendEconomyLedger);
    if (data) worldShips.refreshWorldShipHomeEconomy(data, holding, { report });
  }
  const politicsResult = finishPoliticsPeriod(holding, politicsPeriod, { periods: Math.floor(qd / 40), operationId });
  if (!politicsResult.ok) throw new Error(politicsResult.reason || "Не удалось завершить политический период.");
  report.politics.influenceGained = politicsResult.results.reduce((sum, row) => sum + row.gained, 0);
  report.politics.expiredDecreeIds = politicsResult.results.flatMap((row) => row.expiredDecreeIds);
  for (const warning of politicsResult.warnings ?? []) report.work.push(`Политика: ${warning}`);
  if (report.politics.influenceGained) report.work.push(`Политика: Влияние +${report.politics.influenceGained}.`);
  if (report.politics.expiredDecreeIds.length) report.work.push(`Политика: закончились указы ${report.politics.expiredDecreeIds.join(", ")}.`);
  return report;
},

_marketShipmentDependencies({ deferInternalDemand = false } = {}) {
  return {
    addMoney: (holding, amount) => this._addMoney(holding, amount),
    storageAddWithOverflow: (holding, resource, qty) => this._storageAddWithOverflow(holding, resource, qty),
    appendStorageLog: (holding, entries) => this._appendStorageLog(holding, entries),
    formatCurrency: (value) => this._formatCopperCurrency(value),
    internalDemandAvailableFromQd: (holding) => deferInternalDemand
      ? nextInternalDemandBatchAvailabilityQd(holding)
      : internalDemandBatchClockQd(holding)
  };
},

_advanceMarketOutboundForQd(holding, qd = 0, report = null, { advancedAt = "" } = {}) {
  const timestamp = String(advancedAt ?? "").trim() || new Date().toISOString();
  const completedTendays = Math.max(0, Math.floor(this._safeNumber(qd, 0) / 40));
  const targetTenday = Math.max(0, Math.floor((Number(holding.gm?.calendaria?.lastQd) || 0) / 40)) + completedTendays;
  // Сначала восстанавливаем спрос, который был потреблён до начала этого
  // периода. Поставка, доставленная на текущей границе, затем запускает свой
  // новый цикл и не получает бесплатный тик восстановления в тот же Apply.
  const demandRecovery = recoverMarketDemand({
    holding,
    currentTenday: targetTenday,
    updatedAt: timestamp
  });
  if (!demandRecovery.ok) throw new Error(demandRecovery.message || "Не удалось восстановить внешний спрос.");
  const outboundReport = advanceMarketOutboundShipments({
    holding,
    elapsedQd: qd,
    currentTenday: targetTenday,
    advancedAt: timestamp,
    dependencies: this._marketShipmentDependencies()
  });
  if (!outboundReport.ok) throw new Error(outboundReport.message || "Не удалось обработать исходящие рыночные поставки.");
  if (report) {
    report.marketOutbound = outboundReport;
    report.marketDemandRecovery = demandRecovery;
    for (const dispatch of outboundReport.dispatched ?? []) {
      report.work.push(`Рынок: исходящий груз ${dispatch.orderId} отправлен, ${dispatch.qty} ед. снято с точных FIFO-партий.`);
    }
    for (const incident of outboundReport.needsResolution ?? []) {
      if (incident.newEvent) appendHoldingOperation(holding, {
        operationId: incident.operationId,
        type: "market-outbound",
        createdAt: timestamp,
        title: "Событие с исходящей поставкой",
        summary: "Эта партия ожидает отдельного решения GM; остальные операции периода продолжаются.",
        payload: { orderId: incident.orderId, needsResolution: true, automatic: true }
      });
      report.work.push(`Рынок: исходящая поставка ${incident.orderId} ожидает решения GM.`);
      if (incident.newEvent) appendEconomyLedger(report, {
        domain: "market",
        kind: "shipment",
        name: "Исходящая поставка",
        qty: 0,
        sourceId: incident.orderId,
        status: "needsResolution",
        operationId: incident.operationId,
        note: "Событие ожидает решения GM"
      });
    }
    for (const delivery of outboundReport.delivered ?? []) {
      const deliveryOperationId = String(delivery.operationId ?? `${delivery.orderId}:revenue`);
      appendHoldingOperation(holding, {
        operationId: deliveryOperationId,
        type: "market-outbound",
        createdAt: timestamp,
        title: `Доставлена исходящая продажа: ${delivery.marketLabel || "внешний рынок"}`,
        summary: `Выручка ${this._formatCopperCurrency(delivery.revenueCopper)} поступила ${delivery.ownShipId ? "на борт корабля" : "в казну"}; внешний спрос потреблён.`,
        payload: { orderId: delivery.orderId, revenueCopper: delivery.revenueCopper, demandQty: delivery.demandQty, ownShipId: delivery.ownShipId, automatic: true }
      });
      report.work.push(`Рынок: исходящая продажа ${delivery.orderId} доставлена; выручка ${this._formatCopperCurrency(delivery.revenueCopper)}.`);
      if (!delivery.ownShipId) appendEconomyLedger(report, {
        domain: "market",
        kind: "money",
        resourceId: "money",
        name: "Выручка исходящей продажи",
        qty: delivery.revenueCopper,
        roomId: "treasury",
        sourceId: delivery.orderId,
        status: "delivered",
        operationId: deliveryOperationId,
        note: "Оплата после доставки",
        meta: { alreadyLogged: true, storageKind: "market-outbound-revenue" }
      });
    }
    for (const blocked of outboundReport.blocked ?? []) report.skipped.push(`Исходящая поставка ${blocked.orderId}: ${blocked.message || "операция устарела"}.`);
    if (demandRecovery.recoveredQty > 0) report.work.push(`Внешний спрос восстановился на ${demandRecovery.recoveredQty} ед.`);
  }
  return { outbound: outboundReport, demandRecovery };
},

_advanceMarketShipmentsForQd(holding, qd = 0, report = null) {
  const shipmentReport = advanceMarketShipments({
    holding,
    elapsedQd: qd,
    deliveredAt: new Date().toISOString(),
    dependencies: this._marketShipmentDependencies({ deferInternalDemand: true })
  });
  if (!shipmentReport.ok) throw new Error(shipmentReport.message || "Не удалось обработать прибытие рыночной поставки.");
  if (report) {
    report.market = shipmentReport;
    for (const incident of shipmentReport.needsResolution ?? []) {
      if (incident.newEvent) appendHoldingOperation(holding, {
        operationId: incident.operationId,
        type: "market-purchase",
        createdAt: incident.proposedAt,
        title: `Событие с поставкой: ${incident.marketLabel}`,
        summary: "Эта партия остановлена и ожидает отдельного решения GM. Остальные поставки и расчёт периода продолжаются.",
        payload: { orderId: incident.orderId, orderOperationId: incident.orderOperationId, needsResolution: true, automatic: true }
      });
      report.work.push(`Рынок: с поставкой «${incident.marketLabel}» произошло событие; только эта партия ожидает решения GM.`);
      if (incident.newEvent) appendEconomyLedger(report, {
        domain: "market",
        kind: "shipment",
        name: incident.marketLabel,
        qty: 0,
        sourceId: incident.orderOperationId,
        source: incident.marketLabel,
        status: "needsResolution",
        operationId: incident.operationId,
        note: "Событие ожидает решения GM"
      });
    }
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

async _runTenDayEconomy(holding) {
  return this._runEconomyForQd(holding, 40);
},

_foodConsumptionDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    normalizeResourceId,
    resourceDef,
    resourceLabel,
    normalizeFoodRationUnits,
    resolveFoodRation,
    foodRationTierLabel,
    isResourceBatchPeriodActive,
    syncResourceRowBatches,
    availableResourceRowQuantity,
    availableResourceBatchInventory,
    takeResourceBatchById,
    applySettlementHunger,
    hungerPenaltyFactor,
    normalizeHungerLevel,
    formatNumber: (value) => this._formatNumber(value),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runFoodConsumptionForQd(holding, qd = 0, report = null, { residentPresenceDaysById = null } = {}) {
  return runFoodConsumption({
    holding,
    qd,
    report,
    residentPresenceDaysById,
    dependencies: this._foodConsumptionDependencies()
  });
},

_isFoodResource(row = {}) {
  return isFoodResource(row, this._foodConsumptionDependencies());
},

_constructionDependencies({ rollDice = rollD6Pool, blockedWorkerIds = new Set() } = {}) {
  const blocked = blockedWorkerIds instanceof Set ? blockedWorkerIds : new Set(blockedWorkerIds ?? []);
  const eligibleHolding = (holding) => ({
    ...holding,
    people: {
      ...(holding?.people ?? {}),
      list: (holding?.people?.list ?? []).filter((person) => !blocked.has(String(person?.id ?? "")))
    }
  });
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    buildingStatus: (building) => this._buildingStatus(building),
    buildingOperationalState,
    advanceBuildingProject,
    constructionCrew: (holding, crewId) => this._constructionCrew(eligibleHolding(holding), crewId),
    constructionAttemptGate: (args = {}) => constructionAttemptGate({ ...args, holding: eligibleHolding(args.holding) }),
    constructionPeriodForHolding,
    resolveConstructionAttempt: (args = {}) => resolveConstructionAttempt({ ...args, holding: eligibleHolding(args.holding) }),
    planStorageCosts: (holding, costs) => this._storageCanPay(holding, costs),
    payStorageCosts: (holding, costs) => this._storagePay(holding, costs),
    constructionSuccessBonus: (holding, crewId) => constructionCenterSuccessBonus(holding, crewId),
    rollDice,
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runConstructionCrewsForQd(holding, qd = 0, report = null, { rollDice = rollD6Pool, blockedWorkerIds = new Set() } = {}) {
  return runConstruction({
    holding,
    qd,
    report,
    dependencies: this._constructionDependencies({ rollDice, blockedWorkerIds })
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

_summarizeConstructionReport(construction = {}) {
  return summarizeConstructionReport(construction);
},

_treasuryCostDependencies() {
  return {
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback),
    readMoney: (holding) => this._moneyCopper(holding),
    writeMoney: (holding, value) => this._setMoneyCopper(holding, value),
    formatCopperCurrency: (value) => this._formatCopperCurrency(value),
    appendLedger: (report, entries) => appendEconomyLedger(report, entries)
  };
},

_runTreasuryCostsForQd(holding, qd = 0, report = null, workerContext = null) {
  const totals = this._prepareLegacyTreasuryTotals(holding, workerContext);
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
