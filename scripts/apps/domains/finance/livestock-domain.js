import { normalizeLivestockBuilding } from "../../../data/livestock.js";
import { appendEconomyLedger } from "../../../engines/economy/ledger.js";
import { settlementHungerFactor } from "../../../engines/economy/hunger.js";
import { politicsRuntimeEffects } from "../../../engines/politics/runtime-effects.js";
import {
  applyLivestockPeriodPlan,
  planLivestockPeriod
} from "../../../engines/economy/livestock-period.js";
import {
  addCalendariaQd,
  getCalendariaSeasonSnapshot,
  getCalendariaSnapshot
} from "../../../integrations/calendaria-bridge.js";

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function workQdForLimit(periodQd = 0, dailyLimit = 2) {
  const qd = whole(periodQd);
  const limit = Math.max(0, Math.min(4, whole(dailyLimit, 2)));
  return Math.floor(qd / 4) * limit + Math.min(qd % 4, limit);
}

function livestockReasonLabel(reason = "") {
  if (reason === "not-operational") return "здание не введено в эксплуатацию";
  if (reason === "finance-blocked") return "функция остановлена из-за неоплаченных обязательств или консервации";
  return "функция недоступна";
}

export const FinanceLivestockDomain = {
_livestockFinanceFunction(building = {}) {
  const livestock = normalizeLivestockBuilding(building?.livestock, { building });
  if (!livestock?.enabled) return null;
  return {
    id: "livestock",
    name: `Животноводство: ${livestock.profile.label}`,
    active: true,
    source: "workers",
    overtime: false,
    wageDailyCopper: Math.max(0, whole(building?.wageDailyCopper)),
    operatingUpkeepMonthlyCopper: 0,
    gmPriority: livestock.gmPriority
  };
},

_livestockSeasonContext(holding = {}, cycleIndex = 0) {
  const calendar = holding?.gm?.calendaria ?? {};
  const baseDateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object"
    ? calendar.lastDateTime
    : null;
  // The settled boundary precedes the first elapsed QD, including a daily
  // cycle beginning at a season change. Keep the known date if no calendar
  // API can advance it; a missing date still uses the live snapshot below.
  const dateTime = baseDateTime
    ? addCalendariaQd(baseDateTime, whole(cycleIndex * 40) + 1) ?? baseDateTime
    : null;
  const snapshot = getCalendariaSeasonSnapshot(dateTime, calendar.lastDateText ?? calendar.lastDateKey)
    ?? getCalendariaSnapshot?.()
    ?? null;
  const seasonId = this._currentProductionSeasonKey?.(snapshot) ?? text(snapshot?.season?.key);
  const year = snapshot?.dateTime?.year;
  const seasonKey = seasonId && year !== undefined && year !== null && text(year)
    ? `${text(year)}:${seasonId}`
    : "";
  return { seasonId, seasonKey, snapshot };
},

_livestockAvailableWorkQd(holding, building, periodQd = 40, workerContext = null, stepOffset = null) {
  const people = this._activeAssignedBuildingPeople?.(holding, building, workerContext, "livestock") ?? [];
  if (this._buildingMinimumStaffStatus?.(holding, building, workerContext)?.met === false) return 0;
  if (!(this._buildingCompositionStatus?.(holding, building, people, { excludeGroups: ["ЧУДОТВОРЕЦ"] })?.met ?? true)) return 0;
  const workUnits = people.reduce((sum, person) => {
    let realQd = workerContext?.financeContext
      ? (this._plannedWorkerFunctionQd?.(person, workerContext, building?.id, "livestock") ?? 0)
      : workQdForLimit(periodQd, this._personDailyWorkQdLimit?.(holding, person, workerContext) ?? 2);
    if (workerContext?.financeContext && stepOffset !== null) {
      const slots = workerContext.financeContext.plannedWorkSlotsByWorkerId?.get(String(person.id)) ?? new Map();
      realQd = [...slots].filter(([step, slot]) => step >= stepOffset && step < stepOffset + periodQd
        && slot.sourceId === String(building.id) && slot.functionId === "livestock").length;
    }
    const efficiency = this._personBuildingEfficiency
      ? this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "production" })
      : settlementHungerFactor(holding);
    const politicalFactor = Math.max(0, 1 + (politicsRuntimeEffects(holding)?.productionPercent ?? 0) / 100);
    const qualificationWorkUnits = Math.max(0, Math.round(efficiency * politicalFactor * 10_000));
    const maintenanceBasisPoints = Math.max(0, Math.round((this._maintenanceEfficiencyFactor?.(building) ?? 1) * 10_000));
    const workUnitsPerQd = Math.floor((qualificationWorkUnits * maintenanceBasisPoints) / 10_000);
    return sum + workUnitsPerQd * realQd;
  }, 0);
  return Math.floor(workUnits / 10_000);
},

_livestockPeriodDependencies(holding, { workerContext = null, financeContext = null, stepOffset = null, cycleQd = 40 } = {}) {
  return {
    isOperational: (building) => (
      this._buildingStatus(building).value === "built"
      && this._buildingFunctions(building).production
    ),
    isFunctionAllowed: (building, functionId) => this._financeFunctionAllowed(financeContext, building, functionId),
    resourceQuantity: (resourceId) => this._storageQuantity(holding, { resourceId }),
    workQdForBuilding: (building, qd, cycleIndex) => this._livestockAvailableWorkQd(holding, building, qd, workerContext,
      stepOffset === null ? null : stepOffset + cycleIndex * cycleQd),
    seasonContextForCycle: (cycleIndex) => this._livestockSeasonContext(holding, ((stepOffset ?? 0) + cycleIndex * cycleQd) / 40)
  };
},

_planLivestockForQd(holding, qd = 40, { operationId = "", workerContext = null, financeContext = null, stepOffset = null, cycleQd = 40 } = {}) {
  return planLivestockPeriod({
    buildings: holding?.buildings?.list ?? [],
    elapsedQd: qd,
    operationId,
    cycleQd,
    dependencies: this._livestockPeriodDependencies(holding, { workerContext, financeContext, stepOffset, cycleQd })
  });
},

_applyLivestockPeriodPlan(holding, plan) {
  const buildings = new Map((holding?.buildings?.list ?? []).map((building) => [text(building?.id), building]));
  return applyLivestockPeriodPlan({
    plan,
    dependencies: {
      getBuilding: (buildingId) => buildings.get(text(buildingId)) ?? null,
      resourceQuantity: (resourceId) => this._storageQuantity(holding, { resourceId }),
      consumeResource: (resourceId, qty) => {
        const payment = this._storageCanPay(holding, [{ resourceId, qty }]);
        if (!payment.ok) throw new RangeError(`FBL Skyhold | Planned livestock feed is unavailable: ${resourceId} ${qty}.`);
        return this._storagePay(holding, payment.costs);
      },
      addResource: (resourceId, qty, entry) => {
        const building = buildings.get(text(entry?.buildingId));
        const livestock = normalizeLivestockBuilding(building?.livestock, { building });
        const roomId = this._normalizeStorageRoomId(livestock?.outputRoomId ?? "outdoors");
        return this._storageAddWithOverflow(holding, { resourceId, roomId }, qty);
      },
      setState: (building, state) => {
        building.livestock ??= normalizeLivestockBuilding({}, { building });
        building.livestock.state = state;
      },
      resetOperations: (building, keys, remaining = {}) => {
        building.livestock.operations ??= {};
        for (const key of keys ?? []) building.livestock.operations[key] = whole(remaining?.[key]);
      }
    }
  });
},

_appendLivestockReport(holding, report, plan, applied) {
  if (!report) return;
  report.livestock ??= {
    buildings: [],
    born: 0,
    matured: 0,
    feedConsumed: 0,
    eggs: 0,
    milk: 0,
    wool: 0,
    meat: 0,
    tallow: 0,
    workQdUsed: 0,
    warnings: []
  };
  const target = report.livestock;
  Object.assign(target, {
    born: target.born + whole(plan?.totals?.born),
    matured: target.matured + whole(plan?.totals?.matured),
    feedConsumed: target.feedConsumed + whole(plan?.totals?.feedConsumed),
    eggs: target.eggs + whole(plan?.totals?.eggs),
    milk: target.milk + whole(plan?.totals?.milk),
    wool: target.wool + whole(plan?.totals?.wool),
    meat: target.meat + whole(plan?.totals?.meat),
    tallow: target.tallow + whole(plan?.totals?.tallow),
    workQdUsed: target.workQdUsed + whole(plan?.totals?.workQdUsed)
  });

  for (const skipped of plan?.skipped ?? []) {
    report.skipped?.push?.(`${skipped.buildingName || "Животноводство"}: ${livestockReasonLabel(skipped.reason)}.`);
  }
  if (plan?.ignoredQd > 0) report.skipped?.push?.(`Животноводство: неполный остаток ${plan.ignoredQd} QD не образует десятник и не рассчитан.`);

  for (const entry of plan?.entries ?? []) {
    const cycles = entry.cycles ?? [];
    const feeding = cycles.reduce((sum, cycle) => sum + whole(cycle?.feeding?.feedConsumed), 0);
    const eggs = cycles.reduce((sum, cycle) => sum + whole(cycle?.eggs?.outputQty), 0);
    const milk = cycles.reduce((sum, cycle) => sum + whole(cycle?.milk?.outputQty), 0);
    const wool = cycles.reduce((sum, cycle) => sum + whole(cycle?.wool?.outputQty), 0);
    const meat = cycles.reduce((sum, cycle) => sum + whole(cycle?.slaughter?.outputQty), 0);
    const tallow = entry.resourceChanges.filter((change) => change.resourceId === "tallow" && change.qty > 0).reduce((sum, change) => sum + whole(change.qty), 0);
    const line = {
      buildingId: entry.buildingId,
      name: entry.buildingName,
      speciesId: entry.speciesId,
      headcount: whole(entry.stateAfter?.adults) + (entry.stateAfter?.young ?? []).reduce((sum, cohort) => sum + whole(cohort?.qty), 0),
      born: entry.born,
      matured: entry.matured,
      feeding,
      eggs,
      milk,
      wool,
      meat,
      tallow,
      workQdUsed: entry.workQdUsed,
      warnings: entry.warnings
    };
    target.buildings.push(line);
    target.warnings.push(...entry.warnings.map((warning) => `${entry.buildingName}: ${warning}`));
    if (feeding > 0) report.consumed?.push?.(`${entry.buildingName}: Animal Feed -${feeding}.`);
    if (eggs > 0) report.produced?.push?.(`${entry.buildingName}: Eggs +${eggs}.`);
    if (milk > 0) report.produced?.push?.(`${entry.buildingName}: Milk +${milk}.`);
    if (wool > 0) report.produced?.push?.(`${entry.buildingName}: Wool +${wool}.`);
    if (meat > 0) report.produced?.push?.(`${entry.buildingName}: Meat +${meat}.`);
    if (tallow > 0) report.produced?.push?.(`${entry.buildingName}: Tallow +${tallow}.`);
    if (entry.born > 0 || entry.matured > 0) report.work?.push?.(`${entry.buildingName}: приплод +${entry.born}, повзрослело ${entry.matured}.`);
    if (entry.workQdUsed > 0) report.work?.push?.(`${entry.buildingName}: уход, дойка, стрижка и забой заняли ${entry.workQdUsed} QD.`);
    for (const warning of entry.warnings) report.skipped?.push?.(`${entry.buildingName}: ${warning}`);
    appendEconomyLedger(report, entry.resourceChanges.map((change) => ({
      domain: "livestock",
      kind: "resource",
      resourceId: change.resourceId,
      name: change.resourceId,
      qty: change.qty,
      sourceId: entry.buildingId,
      source: entry.buildingName,
      operationId: plan.operationId,
      note: change.qty < 0 ? "Кормление поголовья" : "Продукция животноводства"
    })));
  }
  return applied;
},

_runLivestockForQd(holding, qd = 40, report = null, { operationId = "", workerContext = null, financeContext = null, stepOffset = null, cycleQd = 40 } = {}) {
  const plan = this._planLivestockForQd(holding, qd, { operationId, workerContext, financeContext, stepOffset, cycleQd });
  const applied = this._applyLivestockPeriodPlan(holding, plan);
  if (!applied.ok) return { ...applied, plan };
  this._appendLivestockReport(holding, report, plan, applied);
  return { ok: true, plan, applied };
}
};

export { workQdForLimit };
