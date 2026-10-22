import {
  allocateFinanceObligations,
  financeObligationBlockers,
  financeObligationOutstandingCopper,
  planCurrentFinanceObligations
} from "./finance-obligations.js";
import { DEFAULT_NORMAL_LABOR_QD } from "../../data/labor-budget.js";

function cloneValue(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function text(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
}

function financeCopy(finance = {}) {
  const source = finance && typeof finance === "object" ? finance : {};
  return {
    ...cloneValue(source),
    schemaVersion: Math.max(1, whole(source.schemaVersion, 1)),
    obligations: (Array.isArray(source.obligations) ? source.obligations : []).map((row) => cloneValue(row)),
    buildingStates: cloneValue(source.buildingStates && typeof source.buildingStates === "object" ? source.buildingStates : {}),
    settlementRuns: (Array.isArray(source.settlementRuns) ? source.settlementRuns : []).map((row) => cloneValue(row))
  };
}

function carryRow(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    remainderThirds: Math.min(2, whole(source.remainderThirds)),
    lastPeriodKey: text(source.lastPeriodKey),
    lastOperationId: text(source.lastOperationId),
    lastDueCopper: whole(source.lastDueCopper),
    monthlyCopper: whole(source.monthlyCopper)
  };
}

function accrueCarry(value, monthlyCopper, periods, periodKey, operationId) {
  const row = carryRow(value);
  if (row.lastPeriodKey === periodKey) return { row, dueCopper: row.lastDueCopper, replay: true };
  const numerator = row.remainderThirds + (whole(monthlyCopper) * whole(periods));
  const dueCopper = Math.floor(numerator / 3);
  return {
    row: {
      remainderThirds: numerator % 3,
      lastPeriodKey: periodKey,
      lastOperationId: operationId,
      lastDueCopper: dueCopper,
      monthlyCopper: whole(monthlyCopper)
    },
    dueCopper,
    replay: false
  };
}

export function plannedWorkerQd(periodQd = 40, { overtime = false, normalQdPerDay = 2, overtimeQdPerDay = 1,
  normalQdPerTenday = DEFAULT_NORMAL_LABOR_QD } = {}) {
  const qd = whole(periodQd);
  const fullDays = Math.floor(qd / 4);
  const rest = qd % 4;
  const normalDaily = Math.max(0, Math.min(2, whole(normalQdPerDay, 2)));
  const overtimeDaily = overtime && normalDaily >= 2
    ? Math.max(0, Math.min(1, whole(overtimeQdPerDay, 1)))
    : 0;
  const physicalNormalQd = (fullDays * normalDaily) + Math.min(rest, normalDaily);
  const physicalOvertimeQd = (fullDays * overtimeDaily) + Math.min(Math.max(0, rest - normalDaily), overtimeDaily);
  const adultBudget = Math.min(DEFAULT_NORMAL_LABOR_QD, whole(normalQdPerTenday, DEFAULT_NORMAL_LABOR_QD));
  const normalBudget = Math.floor(adultBudget * normalDaily / 2);
  const normalQd = normalDaily ? Math.floor(physicalNormalQd * normalBudget / (normalDaily * 10)) : 0;
  const overtimeQd = Math.min(Math.floor(normalQd / 2), Math.floor(physicalOvertimeQd * Math.floor(adultBudget / 2) / 10));
  return { normalQd, overtimeQd, totalQd: normalQd + overtimeQd };
}

export function financePeriodIdentity(holding = {}, periodQd = 40) {
  const beforeQd = whole(holding?.gm?.calendaria?.lastQd);
  const periods = Math.max(1, Math.floor(Math.max(40, whole(periodQd, 40)) / 40));
  const firstPeriodIndex = Math.floor(beforeQd / 40) + 1;
  const lastPeriodIndex = firstPeriodIndex + periods - 1;
  return {
    beforeQd,
    periods,
    periodIndex: firstPeriodIndex,
    lastPeriodIndex,
    periodKey: firstPeriodIndex === lastPeriodIndex
      ? `tenday:${firstPeriodIndex}`
      : `tenday:${firstPeriodIndex}-${lastPeriodIndex}`
  };
}

export function accrueFinanceUpkeepPeriods({
  finance = {},
  buildings = [],
  periods = 1,
  periodKey = "",
  periodIndex = 0,
  operationId = ""
} = {}) {
  const key = text(periodKey);
  if (!key) throw new TypeError("FBL Skyhold | Upkeep accrual requires periodKey.");
  const op = text(operationId, `finance-upkeep:${key}`);
  const next = financeCopy(finance);
  const blockers = financeObligationBlockers({
    finance: next,
    currentPeriodKey: key,
    currentPeriodIndex: whole(periodIndex),
    includeCurrent: false
  });
  const plannedBuildings = [];
  const skipped = [];

  for (const building of Array.isArray(buildings) ? buildings : []) {
    const buildingId = text(building?.id);
    if (!buildingId || building?.built !== true) continue;
    const state = next.buildingStates[buildingId] && typeof next.buildingStates[buildingId] === "object"
      ? next.buildingStates[buildingId]
      : {};
    if (!state.upkeepAccrual || typeof state.upkeepAccrual !== "object") state.upkeepAccrual = {};
    if (!state.upkeepAccrual.operating || typeof state.upkeepAccrual.operating !== "object") state.upkeepAccrual.operating = {};
    next.buildingStates[buildingId] = state;
    const blocker = blockers.buildings[buildingId] ?? { mothballed: Boolean(state.mothballed), baseDebtCopper: 0, operatingByFunction: {} };
    if (blocker.mothballed) {
      skipped.push({ buildingId, reason: "mothballed" });
      continue;
    }

    const base = accrueCarry(
      state.upkeepAccrual.base,
      building?.baseUpkeepMonthlyCopper,
      periods,
      key,
      op
    );
    state.upkeepAccrual.base = base.row;
    const functions = [];
    for (const fn of Array.isArray(building?.functions) ? building.functions : []) {
      const functionId = text(fn?.id);
      if (!functionId || fn?.active === false) continue;
      const operatingDebt = blocker.operatingByFunction?.[functionId]?.debtCopper ?? 0;
      if (blocker.baseDebtCopper > 0 || operatingDebt > 0 || (blocker.operatingByFunction?.operation?.debtCopper ?? 0) > 0) {
        skipped.push({
          buildingId,
          functionId,
          reason: blocker.baseDebtCopper > 0 ? "old-base-upkeep-debt" : "old-operating-upkeep-debt"
        });
        continue;
      }
      const operating = accrueCarry(
        state.upkeepAccrual.operating[functionId],
        fn?.operatingUpkeepMonthlyCopper,
        periods,
        key,
        op
      );
      state.upkeepAccrual.operating[functionId] = operating.row;
      functions.push({ ...cloneValue(fn), operatingUpkeepCopper: operating.dueCopper });
    }
    plannedBuildings.push({
      ...cloneValue(building),
      baseUpkeepCopper: base.dueCopper,
      functions
    });
  }
  return { finance: next, buildings: plannedBuildings, skipped };
}

export function prepareFinancePeriod({
  finance = {},
  treasuryCopper = 0,
  workers = [],
  buildings = [],
  additionalObligations = [],
  periods = 1,
  periodKey = "",
  periodIndex = 0,
  operationId = "",
  createdAt = ""
} = {}) {
  const key = text(periodKey);
  const op = text(operationId, `finance-period:${key}`);
  const upkeep = accrueFinanceUpkeepPeriods({
    finance,
    buildings,
    periods,
    periodKey: key,
    periodIndex,
    operationId: op
  });
  const planned = planCurrentFinanceObligations({
    finance: upkeep.finance,
    periodKey: key,
    periodIndex,
    operationId: op,
    createdAt,
    workers,
    buildings: upkeep.buildings,
    additionalObligations
  });
  if (planned.conflicts.length) {
    const error = new Error(`FBL Skyhold | Finance obligation terms changed inside period "${key}".`);
    error.code = "finance-obligation-conflict";
    error.conflicts = cloneValue(planned.conflicts);
    throw error;
  }
  const allocation = allocateFinanceObligations({
    finance: planned.finance,
    treasuryCopper,
    currentPeriodKey: key,
    currentPeriodIndex: periodIndex,
    operationId: `${op}:settlement`,
    paidAt: createdAt
  });
  const currentRows = new Map(allocation.finance.obligations.map((row) => [text(row.id), row]));
  const currentObligations = planned.obligations.map((row) => currentRows.get(text(row.id)) ?? row);
  const outstandingCopper = allocation.finance.obligations
    .reduce((sum, row) => sum + financeObligationOutstandingCopper(row), 0);
  const invalidWorkerIds = [...new Set(planned.issues
    .map((issue) => text(issue?.workerId))
    .filter(Boolean))];
  return {
    ok: planned.ok,
    finance: allocation.finance,
    treasuryCopper: allocation.treasuryCopper,
    paidCopper: allocation.paidCopper,
    outstandingCopper,
    currentObligations,
    planned,
    allocation,
    upkeep,
    invalidWorkerIds,
    blockers: financeObligationBlockers({ finance: allocation.finance })
  };
}
