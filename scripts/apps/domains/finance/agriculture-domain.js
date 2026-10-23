import { normalizeAgricultureBuilding } from "../../../data/agriculture.js";
import { buildingLaborMode } from "../../../data/hybrid-labor.js";
import { planAgriculturePlot } from "../../../engines/economy/agriculture.js";
import {
  applyAgriculturePeriodPlan,
  planAgriculturePeriod
} from "../../../engines/economy/agriculture-period.js";
import { appendEconomyLedger } from "../../../engines/economy/ledger.js";
import { settlementHungerFactor } from "../../../engines/economy/hunger.js";
import { politicsRuntimeEffects } from "../../../engines/politics/runtime-effects.js";
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

function agricultureReasonLabel(reason = "") {
  if (reason === "not-operational") return "участок не введён в эксплуатацию";
  if (reason === "finance-blocked") return "функция остановлена из-за неоплаченных обязательств или консервации";
  if (reason === "no-crop") return "не выбрана культура";
  return "функция недоступна";
}

export const FinanceAgricultureDomain = {
_isAgricultureBuilding(building = {}) {
  return Boolean(normalizeAgricultureBuilding(building?.agriculture, { building }));
},

_nonAgricultureProductionBuildings(buildings = []) {
  return (Array.isArray(buildings) ? buildings : []).filter((building) => !this._isAgricultureBuilding(building));
},

_agricultureNeedsLabor(agriculture = {}, holding = {}) {
  const phase = text(agriculture?.state?.phase || "empty");
  if (["ready", "harvesting"].includes(phase)) return agriculture?.operations?.harvest === true && whole(agriculture?.state?.readyQty) > 0;
  if (phase === "growing") return false;
  if (agriculture?.operations?.sow !== true) return false;
  const crop = (agriculture?.crops ?? []).find((row) => row.id === agriculture.activeCropId);
  if (!crop) return false;
  const calendar = this._agricultureCalendarContext?.(holding, 0) ?? {};
  if (!crop.sowingSeasons.includes(text(calendar.seasonId))) return false;
  if (phase === "sowing" && agriculture.state.sowingSeasonKey && agriculture.state.sowingSeasonKey !== calendar.seasonKey) return false;
  return true;
},

_agricultureFinanceFunction(building = {}, holding = {}, periodQd = 40) {
  const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
  if (!agriculture?.enabled) return null;
  if (!this._agricultureNeedsLabor(agriculture, holding)) {
    const crop = agriculture.crops.find((row) => row.id === agriculture.activeCropId);
    const upcoming = crop && planAgriculturePlot({
      state: agriculture.state, crop, operations: agriculture.operations,
      elapsedQd: whole(periodQd), availableWorkQd: 1_000_000,
      calendarContextForOffset: (offset) => this._agricultureCalendarContext(holding, offset)
    });
    if (!(upcoming?.workQdUsed > 0)) return null;
  }
  return {
    id: "agriculture",
    name: `Сезонные работы: ${String(building?.name ?? agriculture.kind)}`,
    active: true,
    source: "workers",
    overtime: false,
    wageDailyCopper: Math.max(0, whole(building?.wageDailyCopper)),
    operatingUpkeepMonthlyCopper: 0,
    gmPriority: agriculture.gmPriority
  };
},

_agricultureCalendarContext(holding = {}, offsetQd = 0) {
  const calendar = holding?.gm?.calendaria ?? {};
  const baseDateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object"
    ? calendar.lastDateTime
    : null;
  // lastDateTime is the already-settled boundary. Offset zero represents the
  // first elapsed QD after it, while offset elapsedQd - 1 reaches the target.
  const dateTime = baseDateTime ? addCalendariaQd(baseDateTime, whole(offsetQd) + 1) : null;
  const snapshot = getCalendariaSeasonSnapshot(dateTime, calendar.lastDateText ?? calendar.lastDateKey)
    ?? getCalendariaSnapshot?.()
    ?? null;
  const seasonId = this._currentProductionSeasonKey?.(snapshot) ?? text(snapshot?.season?.id ?? snapshot?.season?.key);
  const year = snapshot?.dateTime?.year;
  const seasonKey = seasonId && year !== undefined && year !== null && text(year)
    ? `${text(year)}:${seasonId}`
    : "";
  return {
    seasonId,
    seasonKey,
    year,
    dateKey: text(snapshot?.dateKey),
    snapshot
  };
},

_agricultureAvailableWorkQd(holding, building, periodQd = 40, workerContext = null) {
  const people = this._activeAssignedBuildingPeople?.(holding, building, workerContext, "agriculture") ?? [];
  if (this._buildingMinimumStaffStatus?.(holding, building, workerContext)?.met === false) return 0;
  if (!(this._buildingCompositionStatus?.(holding, building, people, { excludeGroups: ["ЧУДОТВОРЕЦ"] })?.met ?? true)) return 0;
  const workUnits = people.reduce((sum, person) => {
    const realQd = workerContext?.financeContext
      ? (this._plannedWorkerFunctionQd?.(person, workerContext, building?.id, "agriculture") ?? 0)
      : workQdForLimit(periodQd, this._personDailyWorkQdLimit?.(holding, person, workerContext) ?? 2);
    return sum + this._agricultureWorkUnitsPerQd(holding, building, person, workerContext) * realQd;
  }, 0);
  return Math.floor(workUnits / 10_000);
},

_agricultureWorkUnitsPerQd(holding, building, person, workerContext = null) {
  const efficiency = this._personBuildingEfficiency
    ? this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "production" })
    : settlementHungerFactor(holding);
  const politicalFactor = Math.max(0, 1 + (politicsRuntimeEffects(holding)?.productionPercent ?? 0) / 100);
  const qualificationWorkUnits = Math.max(0, Math.round(efficiency * politicalFactor * 10_000));
  const maintenanceBasisPoints = Math.max(0, Math.round((this._maintenanceEfficiencyFactor?.(building) ?? 1) * 10_000));
  return Math.floor((qualificationWorkUnits * maintenanceBasisPoints) / 10_000);
},

_agriculturePeriodDependencies(holding, { workerContext = null, financeContext = null } = {}) {
  const calendarByOffset = new Map();
  return {
    isOperational: (building) => (
      this._buildingStatus(building).value === "built"
      && this._buildingFunctions(building).production
    ),
    isFunctionAllowed: (building, functionId) => this._financeFunctionAllowed(financeContext, building, functionId),
    workQdForBuilding: (building, qd) => this._agricultureAvailableWorkQd(holding, building, qd, workerContext),
    calendarContextForOffset: (offsetQd) => {
      const key = whole(offsetQd);
      if (!calendarByOffset.has(key)) calendarByOffset.set(key, this._agricultureCalendarContext(holding, key));
      return calendarByOffset.get(key);
    }
  };
},

_planAgricultureForQd(holding, qd = 40, { operationId = "", workerContext = null, financeContext = null } = {}) {
  return planAgriculturePeriod({
    buildings: (holding?.buildings?.list ?? []).filter((building) => buildingLaborMode(building) !== "staff"),
    elapsedQd: qd,
    operationId,
    dependencies: this._agriculturePeriodDependencies(holding, { workerContext, financeContext })
  });
},

_staffAgricultureStepPlan(holding, building, step, availableWorkQd = 0, operationId = "") {
  const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
  if (!agriculture?.enabled) return null;
  const crop = agriculture.crops.find((row) => row.id === agriculture.activeCropId);
  if (!crop) return null;
  return planAgriculturePlot({
    state: agriculture.state,
    crop,
    operations: agriculture.operations,
    elapsedQd: 1,
    availableWorkQd,
    operationId,
    calendarContextForOffset: () => this._agricultureCalendarContext(holding, step)
  });
},

_staffAgricultureWorkAvailable(holding, building, workerContext = null, step = 0) {
  if (buildingLaborMode(building) !== "staff" || !this._isAgricultureBuilding(building)
    || this._buildingStatus(building).value !== "built"
    || !this._buildingFunctions(building).production
    || !this._financeFunctionAllowed(workerContext?.financeContext, building, "agriculture")
    || this._technicalMaintenanceReady?.(building, workerContext?.financeContext, step) === false) return false;
  // This is a pure probe of the real operation, including season changes,
  // expiry and annual limits. Its event offsets are not a future schedule.
  return (this._staffAgricultureStepPlan(holding, building, step, 1_000_000)?.workQdUsed ?? 0) > 0;
},

_runStaffAgricultureStep(holding, step, _report = null, {
  operationId = "", workerContext = null, financeContext = workerContext?.financeContext, budgets = new Map()
} = {}) {
  if (!financeContext) return { ok: true, entries: 0 };
  financeContext.staffAgricultureRuntime ??= new Map();
  let entries = 0;
  for (const building of holding?.buildings?.list ?? []) {
    if (buildingLaborMode(building) !== "staff" || !this._isAgricultureBuilding(building)
      || this._buildingStatus(building).value !== "built" || !this._buildingFunctions(building).production) continue;
    const id = text(building.id);
    let runtime = financeContext.staffAgricultureRuntime.get(id);
    if (!runtime) {
      runtime = { units: 0, steps: new Set(), plans: [], flushed: false };
      financeContext.staffAgricultureRuntime.set(id, runtime);
    }
    if (runtime.steps.has(step)) continue;
    const agriculture = normalizeAgricultureBuilding(building.agriculture, { building });
    const stepOperationId = `${text(operationId) || `staff-agriculture:${whole(holding?.gm?.calendaria?.lastQd)}`}:step:${step}`;
    if (agriculture.state.lastOperationId === `${stepOperationId}:${id}`) {
      runtime.steps.add(step);
      continue;
    }
    const allowed = this._financeFunctionAllowed(financeContext, building, "agriculture");
    const ready = this._staffAgricultureWorkAvailable(holding, building, workerContext, step);
    const probe = ready ? this._staffAgricultureStepPlan(holding, building, step, 1_000_000) : null;
    const workKind = probe?.events?.find((event) => event.workQd > 0)?.kind ?? "";
    const needUnits = whole(probe?.workQdUsed) * 10_000;
    if (!needUnits) runtime.units = 0;
    const people = this._activeAssignedBuildingPeople?.(holding, building, workerContext, "agriculture") ?? [];
    const compositionMet = this._buildingCompositionStatus?.(holding, building, people, { excludeGroups: ["ЧУДОТВОРЕЦ"] })?.met !== false;
    if (ready && compositionMet) {
      for (const person of people) {
        if (runtime.units >= needUnits) break;
        if (financeContext.staffCurrentFunctionByWorkerId?.get(text(person.id)) !== "agriculture") continue;
        const entry = this._workerBudgetEntry(holding, person, budgets, workerContext, building, "agriculture");
        const workUnits = this._agricultureWorkUnitsPerQd(holding, building, person, workerContext);
        if (!entry?.staff || workUnits <= 0) continue;
        // A paid quarter is indivisible between tasks. High efficiency may
        // finish the stage early, but does not manufacture a second free QD.
        while (entry.available >= 1 && runtime.units < needUnits) {
          const consumed = this._consumeStaffWorkerQd(workerContext, entry, "agriculture", 1);
          if (!consumed.ok || consumed.spent !== 1) break;
          runtime.units += workUnits;
        }
      }
    }
    const dependencies = this._agriculturePeriodDependencies(holding, { workerContext, financeContext });
    const plan = planAgriculturePeriod({
      buildings: [building], elapsedQd: 1,
      operationId: stepOperationId,
      dependencies: {
        ...dependencies,
        workQdForBuilding: () => allowed ? Math.floor(runtime.units / 10_000) : 0,
        calendarContextForOffset: () => this._agricultureCalendarContext(holding, step)
      }
    });
    const applied = this._applyAgriculturePeriodPlan(holding, plan);
    if (!applied.ok) return { ...applied, plan };
    runtime.steps.add(step);
    if (!applied.replay) {
      runtime.units = Math.max(0, runtime.units - whole(plan.totals.workQdUsed) * 10_000);
      const after = normalizeAgricultureBuilding(building.agriculture, { building });
      const sameUnfinishedStage = workKind === "sowing-work"
        ? ["empty", "sowing"].includes(after.state.phase)
        : workKind === "harvest-work" && ["ready", "harvesting"].includes(after.state.phase);
      if (!sameUnfinishedStage) runtime.units = 0;
      runtime.plans.push(plan);
    }
    entries++;
  }
  return { ok: true, entries };
},

_flushStaffAgricultureReport(holding, report, financeContext) {
  for (const runtime of financeContext?.staffAgricultureRuntime?.values?.() ?? []) {
    if (runtime.flushed || !runtime.plans.length) continue;
    const plans = runtime.plans;
    const entries = plans.flatMap((plan) => plan.entries);
    if (!entries.length) { runtime.flushed = true; continue; }
    const first = entries[0], last = entries.at(-1);
    const entry = {
      ...first, stateAfter: last.stateAfter,
      workQdAvailable: entries.reduce((sum, row) => sum + row.workQdAvailable, 0),
      workQdUsed: entries.reduce((sum, row) => sum + row.workQdUsed, 0),
      resourceChanges: entries.flatMap((row) => row.resourceChanges),
      events: entries.flatMap((row) => row.events),
      warnings: [...new Set(entries.flatMap((row) => row.warnings))]
    };
    const plan = {
      operationId: plans[0].operationId, entries: [entry],
      skipped: plans.flatMap((row) => row.skipped),
      totals: {
        producedQty: plans.reduce((sum, row) => sum + row.totals.producedQty, 0),
        expiredQty: plans.reduce((sum, row) => sum + row.totals.expiredQty, 0),
        workQdUsed: entry.workQdUsed,
        readyPlots: ["ready", "harvesting"].includes(last.stateAfter.phase) ? 1 : 0
      }
    };
    this._appendAgricultureReport(holding, report, plan, { ok: true, replay: false });
    runtime.flushed = true;
  }
},

_applyAgriculturePeriodPlan(holding, plan) {
  const buildings = new Map((holding?.buildings?.list ?? []).map((building) => [text(building?.id), building]));
  return applyAgriculturePeriodPlan({
    plan,
    dependencies: {
      getBuilding: (buildingId) => buildings.get(text(buildingId)) ?? null,
      addResource: (resourceId, qty, entry) => {
        const building = buildings.get(text(entry?.buildingId));
        const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
        const roomId = this._normalizeStorageRoomId(agriculture?.outputRoomId ?? "outdoors");
        return this._storageAddWithOverflow(holding, { resourceId, roomId }, qty);
      },
      setAgriculture: (building, agriculture) => {
        building.agriculture = agriculture;
      }
    }
  });
},

_appendAgricultureReport(holding, report, plan, applied) {
  if (!report) return applied;
  report.agriculture ??= {
    buildings: [],
    producedQty: 0,
    expiredQty: 0,
    workQdUsed: 0,
    readyPlots: 0,
    warnings: []
  };
  const target = report.agriculture;
  target.producedQty += whole(plan?.totals?.producedQty);
  target.expiredQty += whole(plan?.totals?.expiredQty);
  target.workQdUsed += whole(plan?.totals?.workQdUsed);
  target.readyPlots += whole(plan?.totals?.readyPlots);

  for (const skipped of plan?.skipped ?? []) {
    report.skipped?.push?.(`${skipped.buildingName || "Участок"}: ${agricultureReasonLabel(skipped.reason)}.`);
  }
  for (const entry of plan?.entries ?? []) {
    const produced = entry.resourceChanges.reduce((sum, change) => sum + whole(change.qty), 0);
    const expired = entry.events.filter((event) => event.kind === "expired").reduce((sum, event) => sum + whole(event.qty), 0);
    const row = {
      buildingId: entry.buildingId,
      name: entry.buildingName,
      cropId: entry.cropId,
      cropLabel: entry.cropLabel,
      resourceId: entry.resourceId,
      phase: entry.stateAfter?.phase ?? "empty",
      readyQty: whole(entry.stateAfter?.readyQty),
      produced,
      expired,
      workQdUsed: entry.workQdUsed,
      warnings: entry.warnings
    };
    target.buildings.push(row);
    target.warnings.push(...entry.warnings.map((warning) => `${entry.buildingName}: ${warning}`));
    if (produced > 0) report.produced?.push?.(`${entry.buildingName}: ${entry.cropLabel || entry.resourceId} +${produced}.`);
    if (entry.workQdUsed > 0) report.work?.push?.(`${entry.buildingName}: посев и сбор заняли ${entry.workQdUsed} QD.`);
    if (["ready", "harvesting"].includes(entry.stateAfter?.phase)) report.work?.push?.(`${entry.buildingName}: на участке ждёт сбора ${whole(entry.stateAfter.readyQty)} ед. ${entry.cropLabel}.`);
    for (const warning of entry.warnings) report.skipped?.push?.(`${entry.buildingName}: ${warning}`);
    appendEconomyLedger(report, entry.resourceChanges.map((change) => ({
      domain: "agriculture",
      kind: "resource",
      resourceId: change.resourceId,
      name: entry.cropLabel || change.resourceId,
      qty: whole(change.qty),
      sourceId: entry.buildingId,
      source: entry.buildingName,
      operationId: plan.operationId,
      note: "Сбор урожая"
    })));
  }
  return applied;
},

_runAgricultureForQd(holding, qd = 40, report = null, { operationId = "", workerContext = null, financeContext = null } = {}) {
  const plan = this._planAgricultureForQd(holding, qd, { operationId, workerContext, financeContext });
  const applied = this._applyAgriculturePeriodPlan(holding, plan);
  if (!applied.ok) return { ...applied, plan };
  this._appendAgricultureReport(holding, report, plan, applied);
  return { ok: true, replay: applied.replay, plan, applied };
}
};

export { workQdForLimit };
