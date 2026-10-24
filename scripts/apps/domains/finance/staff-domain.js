import { staffAppointmentWorkFunctions } from "../../../data/hybrid-labor.js";
import { normalizeLivestockBuilding } from "../../../data/livestock.js";
import { livestockHeadcount, planLivestockTenday } from "../../../engines/economy/livestock.js";
import { appendStaffWork, recordStaffWork } from "../../../engines/workers/staff-runtime.js";
import { appendEconomyLedger } from "../../../engines/economy/ledger.js";

const number = (value) => Math.max(0, Number(value) || 0);

export const FinanceStaffDomain = {
_recordStaffWorkQd(workerContext, entry, functionId, qd) {
  recordStaffWork(workerContext?.financeContext, entry, functionId, qd);
  workerContext?.financeContext?.staffCollectionBudgetCache?.delete(entry?.workerId);
},

_consumeStaffWorkerQd(workerContext, entry, functionId, needed = 1) {
  const qd = number(needed);
  if (!entry?.staff || entry.available + 0.0001 < qd) return { ok: false, spent: 0 };
  entry.available = Math.max(0, entry.available - qd);
  entry.spent += qd;
  this._recordStaffWorkQd(workerContext, entry, functionId, qd);
  return { ok: true, spent: qd };
},

/** Period adapters may reserve future funded slots before the per-step executor. */
_reserveStaffWorkQd(holding, building, functionId, needed, financeContext, {
  normalOnly = true, startStep = 0, endStep = financeContext?.periodQd ?? 40, personId = ""
} = {}) {
  let remaining = number(needed);
  const rows = [];
  const id = String(building?.id ?? "");
  const staff = [...(financeContext?.staffAppointmentsByWorkerId ?? [])].sort(([left], [right]) => left.localeCompare(right));
  for (const [workerId, appointment] of staff) {
    if (!(remaining > 0)) break;
    if (personId && workerId !== String(personId) || String(appointment.buildingId) !== id
      || !staffAppointmentWorkFunctions(appointment).includes(functionId)) continue;
    const reserved = financeContext.staffReservedStepsByWorkerId.get(workerId) ?? new Set();
    for (const [step, slot] of financeContext.plannedWorkSlotsByWorkerId.get(workerId) ?? []) {
      if (remaining < 1 || step < startStep || step >= endStep || reserved.has(step)
        || slot.functionId !== "staff" || normalOnly && slot.overtime) continue;
      if (slot.overtime && !financeContext.staffOvertimeFunctionsByWorkerId?.get(workerId)?.has(functionId)) continue;
      reserved.add(step);
      remaining -= 1;
      appendStaffWork(financeContext, workerId, id, functionId, 1, step, slot.overtime);
      rows.push({ workerId, sourceId: id, functionId, step, normalQd: slot.overtime ? 0 : 1, overtimeQd: slot.overtime ? 1 : 0 });
    }
    financeContext.staffReservedStepsByWorkerId.set(workerId, reserved);
  }
  return { ok: remaining <= 0.0001, spent: number(needed) - remaining, rows };
},

_staffSelectedForFunction(person, building, functionId, workerContext) {
  const finance = workerContext?.financeContext;
  const id = String(person?.id ?? "");
  if (!finance?.staffAppointmentsByWorkerId?.has(id)) return true;
  return finance.staffAppointmentsByWorkerId.get(id).buildingId === String(building?.id ?? "")
    && finance.staffCurrentFunctionByWorkerId.get(id) === functionId;
},

_staffLivestockWorkRemaining(holding, building, workerContext, step) {
  const livestock = normalizeLivestockBuilding(building?.livestock, { building });
  if (!livestock?.enabled || !livestockHeadcount(livestock.state)) return 0;
  const offset = Math.floor(step / 4) * 4;
  const season = this._livestockSeasonContext(holding, offset / 40);
  const desired = planLivestockTenday({
    state: livestock.state, profile: livestock.profile, elapsedQd: 4,
    seasonId: season.seasonId, seasonKey: season.seasonKey,
    availableFeedUnits: this._storageQuantity(holding, { resourceId: livestock.profile.feedResourceId }),
    availableWorkQd: 1_000_000, feedPriority: livestock.operations.feedPriority,
    operations: livestock.operations
  }).workQdUsed;
  return Math.max(0, desired - this._livestockAvailableWorkQd(holding, building, 4, workerContext, offset));
},

_canCollectStaffProductionInputs(holding, building, costs, workerContext, consumerLine) {
  if (!costs?.length) return false;
  const finance = workerContext?.financeContext;
  const functionId = this._financeLineFunctionId(consumerLine, (building.productionLines ?? []).indexOf(consumerLine));
  const available = this._staffDailyCollectionBudget(building, functionId, workerContext);
  const pending = [], blocked = [];
  let pendingMoney = 0;
  const ingredients = costs.flatMap((cost) => cost.alternatives ?? [cost]);
  for (const source of holding.buildings?.list ?? []) {
    if (this._buildingStatus(source).value !== "built") continue;
    for (const line of source.productionLines ?? []) {
      if (!line.requiresCollection || line.autoCollect !== "worker" || !number(line.pendingQty)) continue;
      if (!this._financeFunctionAllowed(finance, source, this._financeLineFunctionId(line))) continue;
      const resource = this._productionCollectionResource(line);
      if (!ingredients.some((cost) => this._productionInputMatches(resource, cost))) continue;
      const needed = Math.ceil(number(line.collectQd));
      if (needed > available) blocked.push({ source, line, needed });
      else if (resource.resourceId === "money") pendingMoney += number(line.pendingQty);
      else pending.push({ ...resource, qty: number(line.pendingQty) });
    }
  }
  // Let the inventory planner resolve the complete AND/OR recipe and material
  // groups. A failed quote's first missing alternative is not the whole recipe.
  const projected = { ...holding, storage: { ...holding.storage,
    moneyCopper: number(holding.storage?.moneyCopper) + pendingMoney,
    resources: [...(holding.storage?.resources ?? []), ...pending] } };
  if (this._storageCanPay(projected, costs).ok) return true;
  if (finance.staffCollectionProbe) return false;
  const warningAvailable = this._staffDailyCollectionBudget(building, functionId, workerContext, { priorityOffers: true });
  finance.staffCollectionWarnings ??= new Map();
  for (const { source, line, needed } of blocked) {
    if (needed <= warningAvailable) continue;
    const key = `input:${building.id}::${functionId}::${source.id}::${line.id}`;
    if (finance.staffCollectionWarnings.has(key)) continue;
    finance.staffCollectionWarnings.set(key, { line, message: `${building.name || "Здание"}: сбор сырья у ${source.name || "здания"} требует ${needed} QD за один день, доступно не больше ${warningAvailable}; не хватает ${needed - warningAvailable} QD. Проверьте бригаду или сверхурочные; сотрудник может выполнять резервную работу.` });
  }
  return false;
},

/** Unspent funded slots, including today's accrued time; past days cannot fund collection. */
_staffDailyCollectionBudget(building, functionId, workerContext, options = {}) {
  const finance = workerContext?.financeContext;
  const priorityOffers = options.priorityOffers ?? finance?.staffCollectionProbe === true;
  const firstDay = Math.floor(number(finance?.staffStep) / 4);
  const daily = new Map();
  for (const [workerId, appointment] of finance?.staffAppointmentsByWorkerId ?? []) {
    if (String(appointment.buildingId) !== String(building.id)) continue;
    let cached = finance.staffCollectionBudgetCache?.get(workerId);
    if (!cached) {
      cached = { functions: staffAppointmentWorkFunctions(appointment) };
      finance.staffCollectionBudgetCache?.set(workerId, cached);
    }
    if (!cached.functions.includes(functionId)) continue;
    // A reserve role is not a promise to help: its owner may spend the whole
    // day on a different primary job. Use this step's priority selection.
    const selected = finance.staffCollectionCandidates ? finance.staffCollectionCandidates.get(workerId) : appointment.primaryFunctionId;
    if (finance.staffSelectingWorkerId !== workerId) {
      if (priorityOffers) {
        const functions = cached.functions, priority = functions.indexOf(selected);
        // A worker offering a fallback may still join a higher-priority task;
        // a worker with a viable primary never promises a lower reserve job.
        if (priority >= 0 && functions.indexOf(functionId) > priority) continue;
      } else if (selected !== functionId) continue;
    }
    if (!cached.days) {
      cached.days = new Map();
      for (const [step, slot] of finance.plannedWorkSlotsByWorkerId.get(workerId) ?? []) {
        const day = Math.floor(step / 4);
        if (day < firstDay || slot.functionId !== "staff" || finance.staffReservedStepsByWorkerId.get(workerId)?.has(step)) continue;
        const counts = cached.days.get(day) ?? [0, 0];
        counts[slot.overtime ? 1 : 0] += 1;
        cached.days.set(day, counts);
      }
    }
    const overtime = finance.staffOvertimeFunctionsByWorkerId.get(workerId)?.has(functionId);
    for (const [day, [normal, extra]] of cached.days) {
      daily.set(day, (daily.get(day) ?? 0) + normal + (overtime ? extra : 0));
    }
  }
  return Math.max(0, ...daily.values());
},

_staffCanCollectLine(building, line, workerContext) {
  const needed = Math.ceil(number(line?.collectQd));
  if (!needed) return true;
  const finance = workerContext?.financeContext;
  const functionId = this._financeLineFunctionId(line, (building.productionLines ?? []).indexOf(line));
  const key = `${building.id}::${functionId}`;
  const available = this._staffDailyCollectionBudget(building, functionId, workerContext);
  if (available >= needed) {
    if (!finance.staffCollectionProbe) finance.staffCollectionWarnings?.delete(key);
    return true;
  }
  if (finance.staffCollectionProbe) return false;
  const warningAvailable = this._staffDailyCollectionBudget(building, functionId, workerContext, { priorityOffers: true });
  if (warningAvailable >= needed) return false;
  finance.staffCollectionWarnings ??= new Map();
  if (!finance.staffCollectionWarnings.has(key)) {
    finance.staffCollectionWarnings.set(key, { line, message: `${building.name || "Здание"}: сбор требует ${needed} QD за один день, доступно не больше ${warningAvailable}; не хватает ${needed - warningAvailable} QD. Нужны дополнительные сборщики или разрешённые сверхурочные; незавершённый сбор между днями не переносится.` });
  }
  return false;
},

async _staffFunctionNeedsWork(holding, building, functionId, person, workerContext, step, lineCanWork) {
  const finance = workerContext.financeContext;
  if (!this._financeFunctionAllowed(finance, building, functionId)) return false;
  if (functionId === "maintenance") return false; // The period adapter reserves these slots before equipment starts.
  if (!this._technicalMaintenanceReady(building, finance, step)) return false;
  if (functionId === "agriculture") {
    return this._staffAgricultureWorkAvailable?.(holding, building, workerContext, step) === true;
  }
  if (functionId === "livestock") return this._staffLivestockWorkRemaining(holding, building, workerContext, step) > 0;
  if (functionId.startsWith("production:")) {
    const line = (building.productionLines ?? []).find((value, index) => this._financeLineFunctionId(value, index) === functionId);
    return Boolean(line && await lineCanWork(building, line, this._assignedBuildingPeople(holding, building, workerContext, functionId), step));
  }
  if (functionId === "culture" && building.fuelAlternatives?.length) {
    if (finance.staffCollectionProbe) {
      const fuel = building.fuelAlternatives.find((row) => String(row.resourceId) === String(building.fuelChoice)) ?? building.fuelAlternatives[0];
      return this._storageCanPay(holding, [{ resourceId: fuel.resourceId, qty: Math.max(1, Math.ceil(number(fuel.qty))) }]).ok;
    }
    finance.staffConsumablesStarted ??= new Set();
    const id = String(building.id);
    if (!finance.staffConsumablesStarted.has(id)) {
      finance.staffConsumablesStarted.add(id);
      this._runInstitutionConsumables(holding, 40, finance.staffReport, workerContext, finance, { staffStartBuildingId: id });
    }
    if (!this._financeFunctionAllowed(finance, building, functionId)) return false;
  }
  return ["culture", "income", "defense", "storage", "medical", "housing"].includes(functionId);
},

async _prepareStaffWorkerStep(holding, budgets, workerContext, step, { lineCanWork, report } = {}) {
  const finance = workerContext?.financeContext;
  if (!finance?.staffAppointmentsByWorkerId?.size) return;
  finance.staffStep = step;
  finance.staffReport = report;
  finance.staffCurrentFunctionByWorkerId.clear();
  const people = workerContext.activePeopleById;
  const ordered = [...finance.staffAppointmentsByWorkerId].sort(([left], [right]) => left.localeCompare(right));
  const select = async (commit) => {
    for (const [workerId, appointment] of ordered) {
      if (!commit) finance.staffCollectionCandidates.set(workerId, null);
      const person = people.get(workerId);
      const building = workerContext.buildingsByAssignment.get(String(appointment.buildingId));
      if (!person || !building || this._buildingStatus(building).value !== "built") continue;
      finance.staffSelectingWorkerId = workerId;
      for (const functionId of staffAppointmentWorkFunctions(appointment)) {
        const entry = this._workerBudgetEntry(holding, person, budgets, workerContext, building, functionId);
        if (entry.available + 0.0001 < 1) continue;
        if (!await this._staffFunctionNeedsWork(holding, building, functionId, person, workerContext, step, lineCanWork)) continue;
        (commit ? finance.staffCurrentFunctionByWorkerId : finance.staffCollectionCandidates).set(workerId, functionId);
        if (commit && ["culture", "income", "defense", "storage", "medical", "housing", "livestock"].includes(functionId)) {
          this._consumeStaffWorkerQd(workerContext, entry, functionId, 1);
        }
        break;
      }
    }
  };
  finance.staffCollectionCandidates = new Map(ordered.map(([id, appointment]) => [id, appointment.primaryFunctionId]));
  finance.staffCollectionBudgetCache = new Map();
  try {
    // Propagate fallback offers before spending: several workers must be able
    // to leave an impossible primary collection and form a reserve team.
    finance.staffCollectionProbe = true;
    const seen = new Set();
    for (let attempt = 0; attempt <= ordered.length * 2; attempt++) {
      const before = JSON.stringify([...finance.staffCollectionCandidates]);
      if (seen.has(before)) break;
      seen.add(before);
      await select(false);
      if (before === JSON.stringify([...finance.staffCollectionCandidates])) break;
    }
    finance.staffCollectionProbe = false;
    await select(true);
  } finally {
    finance.staffCollectionProbe = false;
    delete finance.staffSelectingWorkerId;
    delete finance.staffCollectionCandidates;
    delete finance.staffCollectionBudgetCache;
  }
},

_settleStaffPersonnelCashback(holding, report, financeContext) {
  if (!financeContext?.staffAppointmentsByWorkerId?.size) return;
  const result = this._personnelOfficeCashback(holding, financeContext.result,
    financeContext.personnelOfficeInputs, financeContext);
  const additional = Math.max(0, result.copper - number(financeContext.personnelOfficeCashbackCopper));
  if (!additional) return;
  financeContext.personnelOfficeCashbackCopper = result.copper;
  this._addMoney(holding, additional);
  if (report.finance) {
    report.finance.personnelOfficeCashbackCopper = result.copper;
    report.finance.personnelOfficeCashbackBaseCopper = result.baseCopper;
    report.finance.personnelOfficeNetSavingCopper = result.copper - number(result.officePaidCopper);
  }
  report.income.push(`Управление кадров: возмещение за фактическую работу +${additional} ММ.`);
  appendEconomyLedger(report, {
    domain: "income", kind: "money", resourceId: "money", name: "Деньги", qty: additional,
    roomId: "treasury", source: "Управление кадров",
    operationId: `${financeContext.financeOperationId}:staff-personnel-cashback`
  });
},

_finishStaffExecution(holding, report, financeContext) {
  if (!financeContext?.staffAppointmentsByWorkerId?.size) return;
  financeContext.staffExecutionComplete = true;
  for (const { line, message } of financeContext.staffCollectionWarnings?.values() ?? []) {
    if (line.pendingQty > 0) report.skipped.push(message);
  }
  for (const [workerId, appointment] of financeContext.staffAppointmentsByWorkerId) {
    const rows = financeContext.staffWorkByWorkerId.get(workerId) ?? [];
    const worked = rows.reduce((sum, row) => sum + row.normalQd + row.overtimeQd, 0);
    const planned = (financeContext.plannedAssignmentsByWorkerId.get(workerId) ?? [])
      .reduce((sum, row) => sum + row.normalQd + row.overtimeQd, 0);
    const person = (holding.people?.list ?? []).find((row) => String(row.id) === workerId);
    const building = (holding.buildings?.list ?? []).find((row) => String(row.id) === appointment.buildingId);
    report.work.push(`${person?.name || workerId} · ${building?.name || appointment.buildingId}: выполнено ${worked} QD, оплачиваемый простой ${Math.max(0, planned - worked)} QD; ставка ${appointment.wageDailyCopper} ММ/день.`);
  }
}
};
