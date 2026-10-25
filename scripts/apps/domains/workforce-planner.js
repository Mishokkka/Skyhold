import { buildWorkAllocationTargets, buildPlannedWorkSlots, validateHoldingWorkAllocations } from "../../data/work-allocations.js";
import { isResidentInPopulation } from "../../data/resident-presence.js";
import { DEFAULT_NORMAL_LABOR_QD, residentLaborCapacity } from "../../data/labor-budget.js";
import { workforcePlan, workforceKey, workforceLockKey, workforceCapacity, workforceUnavailable, workforceChangeError } from "../../data/workforce-plan.js";
import { workerAdmission, buildingCompositionStatus } from "../../engines/workers/building-qualification.js";
import { financePeriodIdentity } from "../../engines/economy/finance-period.js";
import { calculatePlannedWorkerWage } from "../../engines/economy/finance-obligations.js";
import { workforceTaskState, workforceOperationalMinimum, workforceProductionGoalState } from "./workforce-task-state.js";
import { politicsRuntimeEffects } from "../../engines/politics/runtime-effects.js";
import { applyStaffAppointment, buildingLaborMode, buildingLaborCapacityQd, productionPreparationGoal, staffWorkerIdsForBuilding } from "../../data/hybrid-labor.js";
import { staffDraftAppointment, staffPlanningRows, setWorkforceStaff, staffWorkDescription } from "./workforce-staff.js";

const clone = (value) => structuredClone(value);
const sum = (rows, field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
const shown = (row, isGM) => isGM || row.visibility !== "gm";
const hasWork = (row) => row.normalQd > 0 || row.overtimeQd > 0;

function effectiveLabor(service, holding, task, person) {
  if (!task.building || !["production", "agriculture", "livestock"].includes(task.kind)) return 1;
  const line = task.kind === "production" && (task.building.productionLines ?? [])
    .find((row, index) => task.functionId === `production:${row.id || `line-${index + 1}`}`);
  if (line && ["time", "content"].includes(line.source)) return 1; // This task is collection, not preparation.
  let units = Math.round(service._personBuildingEfficiency(holding, task.building, person) * 10000);
  if (["agriculture", "livestock"].includes(task.kind)) units = Math.round(units * Math.max(0, 1 + (politicsRuntimeEffects(holding)?.productionPercent ?? 0) / 100));
  return Math.floor(units * Math.round((service._maintenanceEfficiencyFactor?.(task.building) ?? 1) * 10000) / 10000) / 10000;
}

export function createWorkforceDraft(holding, service) {
  const inputs = service._financePlanInputs(holding, 40, financePeriodIdentity(holding, 40));
  const workers = new Map(inputs.workers.map((row) => [String(row.id), row]));
  return { plan: clone(workforcePlan(holding)), edited: [],
    staffAppointments: Object.fromEntries((holding.people?.list ?? []).map((person) => [String(person.id), clone(person.staffAppointment ?? null)])),
    allocations: Object.fromEntries((holding.people?.list ?? []).map((person) => {
    const rows = person.staffAppointment ? [] : person.workAllocationMode === "explicit" ? clone(person.workAllocations ?? [])
      : (workers.get(String(person.id))?.assignments ?? []).map((row, index) => ({
        schemaVersion: 1, id: `planner-${person.id}-${index}`, sourceId: row.sourceId, functionId: row.functionId,
        normalQd: row.normalQd, overtimeQd: row.overtimeQd
      }));
    return [String(person.id), rows];
  })) };
}

/** Touch only edited civilians. Preserve GM admission exceptions, ships, salaries and all other assignments. */
export function applyWorkforceDraft(holding, draft) {
  holding.workforcePlan = clone(draft.plan);
  // Release edited contracts first, so a deliberate swap does not depend on resident order.
  for (const id of draft.edited) {
    const person = (holding.people?.list ?? []).find((row) => String(row.id) === id);
    if (person?.staffAppointment) applyStaffAppointment(holding, id, null);
  }
  for (const id of draft.edited) {
    const person = (holding.people?.list ?? []).find((row) => String(row.id) === id);
    if (!person) throw new Error("Житель плана больше не существует.");
    if (draft.staffAppointments?.[id]) {
      applyStaffAppointment(holding, id, draft.staffAppointments[id]);
      continue;
    }
    person.workAllocationMode = "explicit";
    person.workAssignment = "";
    person.workAllocations = clone(draft.allocations[id] ?? []);
    for (const building of holding.buildings?.list ?? []) {
      if (!(building.assignedWorkerIds ?? []).some((value) => String(value) === id)) continue;
      building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
    }
  }
  return holding;
}

export function workforceDraftError(holding, draft, { isGM = false } = {}) {
  if ((draft.edited ?? []).some((id) => draft.staffAppointments?.[id] && (draft.allocations?.[id] ?? []).some(hasWork))) {
    return "Постоянная работа несовместима с отдельными заданиями QD.";
  }
  let next;
  try { next = applyWorkforceDraft(clone(holding), draft); } catch (error) { return error.message; }
  const error = workforceChangeError(holding, next, { isGM });
  if (error) return error;
  const validation = validateHoldingWorkAllocations(next, { previousHolding: holding });
  return validation.ok ? "" : isGM ? validation.issues[0].message : "План конфликтует с назначениями или вместимостью здания. Проверьте выделенные QD; скрытые назначения может проверить ГМ.";
}

export function buildWorkforceModel(holding, draft, service, { isGM = false, presenceHolding = holding } = {}) {
  const working = applyWorkforceDraft(clone(holding), draft);
  const inputs = service._financePlanInputs(working, 40, financePeriodIdentity(working, 40));
  const financeWorkers = new Map(inputs.workers.map((row) => [String(row.id), row]));
  const functionMap = new Map(inputs.buildings.flatMap((building) => building.functions.map((fn) => [`${building.id}::${fn.id}`, fn])));
  const buildingMap = new Map((holding.buildings?.list ?? []).map((row) => [String(row.id), row]));
  const locks = new Set(draft.plan.locks.map(workforceLockKey));
  const targets = buildWorkAllocationTargets(working).filter((target) => !target.buildingId || shown(buildingMap.get(target.buildingId), isGM));
  const tasks = targets.map((target) => {
    const building = buildingMap.get(target.buildingId);
    const fn = functionMap.get(target.key);
    const state = workforceTaskState(working, target, building, service, fn);
    const debt = inputs.oldBlockers.buildings[target.sourceId];
    const blocked = debt?.mothballed || debt?.baseDebtCopper > 0 || debt?.operatingByFunction?.operation?.debtCopper > 0
      || debt?.operatingByFunction?.[target.functionId]?.debtCopper > 0;
    const supported = !building || fn?.source === "workers" || fn?.workerCollection || target.kind === "agriculture";
    const goal = draft.plan.goals.find((row) => workforceKey(row) === target.key)?.normalQd ?? 0;
    const laborMode = buildingLaborMode(building);
    const preparedUnits = productionPreparationGoal(working, target.sourceId, target.functionId) ?? 0;
    const preparation = workforceProductionGoalState(building, target.functionId, preparedUnits);
    if (preparation.allowed && preparedUnits) state.effectiveNeed = Math.max(state.effectiveNeed, preparation.effectiveNeed);
    return { ...target, ...state, building, name: building?.name || "Поселение", functionName: fn?.name || target.label.split(" · ")[1] || "Трудовое обслуживание",
      laborMode, isStaff: laborMode === "staff" && target.kind !== "maintenance", capacityQd: buildingLaborCapacityQd(building),
      preparedUnits, hasProductionGoal: preparation.allowed, preparationWarning: preparation.warning,
      preparationWorkQd: Math.round(preparation.effectiveNeed * 100) / 100,
      dailyRateCopper: target.buildingId ? target.dailyRateCopper : 12,
      goal, category: (goal || preparedUnits) && state.category === "optional" ? "chosen" : state.category,
      blocked: target.available === false ? target.blockedReason : blocked ? "Работа остановлена финансовыми обязательствами" : !supported ? "Функция отключена в здании" : "",
      assignable: target.available !== false && supported && !blocked, normalQd: 0, overtimeQd: 0, effectiveQd: 0,
      assignments: [], daily: Array(10).fill(0), effectiveDaily: Array(10).fill(0), staff: 0, minimum: laborMode === "legacy" ? Number(building?.workersMin || 0) : 0, warnings: [] };
  });
  const taskMap = new Map(tasks.map((row) => [row.key, row]));
  const slotsByPerson = new Map();
  // A retained draft must not bring back residents who have since died or left.
  const presentIds = new Set((presenceHolding.people?.list ?? []).filter((person) => isResidentInPopulation(person, presenceHolding)).map((person) => String(person.id)));
  const people = (holding.people?.list ?? []).filter((person) => shown(person, isGM) && presentIds.has(String(person.id))).map((person) => {
    const id = String(person.id), appointment = staffDraftAppointment(draft, person);
    const allRows = appointment ? staffPlanningRows(person, appointment) : draft.allocations[id] ?? [];
    const hiddenWork = !isGM && (allRows.some((row) => hasWork(row) && !taskMap.has(workforceKey(row)) && buildingMap.get(row.sourceId)?.visibility === "gm")
      || [...buildingMap.values()].some((building) => building.visibility === "gm"
        && ((building.assignedWorkerIds ?? []).includes(id) || [building.id, building.name].includes(person.workAssignment))));
    const legacy = !appointment && person.workAllocationMode !== "explicit" && !draft.edited.includes(id);
    const unresolvedLegacy = legacy && allRows.some((row) => hasWork(row) && !taskMap.has(workforceKey(row)));
    const legacyBuilding = legacy && [...buildingMap.values()].some((building) =>
      (building.assignedWorkerIds ?? []).includes(id) || [building.id, building.name].includes(person.workAssignment));
    const unavailable = workforceUnavailable(holding, person) || (hiddenWork ? "Есть скрытые назначения; нужен ГМ" : "")
      || (unresolvedLegacy || legacyBuilding && !allRows.length ? "Старое назначение недоступно; проверьте карточку" : "")
      || (inputs.oldBlockers.workers[id]?.blocked ? "Долг по оплате труда" : "");
    const capacity = workforceCapacity(person);
    const rows = hiddenWork ? [] : allRows.map((row) => ({ ...row, key: workforceKey(row), locked: locks.has(workforceLockKey({ ...row, personId: id })),
      label: taskMap.get(workforceKey(row))?.label || "Работа недоступна — снимите назначение", known: taskMap.has(workforceKey(row)) }));
    const normalQd = sum(rows, "normalQd"), overtimeQd = sum(rows, "overtimeQd");
    const priced = calculatePlannedWorkerWage(!unavailable && financeWorkers.get(id) || { id, assignments: [] });
    const candidate = { id, person, appointment: hiddenWork ? null : appointment, isStaff: !hiddenWork && Boolean(appointment), staffDescription: hiddenWork ? "" : staffWorkDescription(appointment, taskMap),
      name: person.name || "Житель", capacity, normalQd, overtimeQd, allocations: rows,
      unavailable, free: unavailable || appointment ? 0 : Math.max(0, capacity.normalQd - normalQd), wage: priced.dueCopper,
      wageValid: priced.ok, wageIssue: priced.ok ? "" : "Проверьте ставку оплаты, QD или договорённость о бесплатной работе",
      legacy };
    if (!unavailable) {
      // Daily windows are independent of the personal tenday budget: 16 QD
      // must not become floor(16 / 10) = one QD per day.
      const dailyWindows = residentLaborCapacity(person, DEFAULT_NORMAL_LABOR_QD);
      const slots = buildPlannedWorkSlots(rows, 40, { normalQdPerDay: dailyWindows.normalQd / 10, overtimeQdPerDay: dailyWindows.overtimeQd / 10 });
      slotsByPerson.set(id, priced.ok ? slots : new Map());
      for (const row of rows) {
        const task = taskMap.get(row.key);
        if (!task || !hasWork(row)) continue;
        const efficiency = priced.ok ? effectiveLabor(service, working, task, person) : 0;
        task.normalQd += row.normalQd; task.overtimeQd += row.overtimeQd;
        task.effectiveQd += (row.normalQd + row.overtimeQd) * efficiency;
        task.assignments.push({ ...row, personId: id, name: candidate.name, efficiency, isStaff: Boolean(appointment) });
      }
      for (const [step, row] of slots) {
        const task = taskMap.get(workforceKey(row));
        if (task) {
          task.daily[Math.floor(step / 4)] += 1;
          if (priced.ok) task.effectiveDaily[Math.floor(step / 4)] += effectiveLabor(service, working, task, person);
        }
      }
    }
    return candidate;
  });
  const staffByBuilding = new Map();
  for (const building of working.buildings?.list ?? []) {
    if (buildingLaborMode(building) === "staff") staffByBuilding.set(building.id, new Set(staffWorkerIdsForBuilding(working, building.id)));
  }
  for (const task of tasks) {
    if (!task.buildingId || task.kind === "maintenance") continue;
    const ids = staffByBuilding.get(task.buildingId) ?? new Set();
    task.assignments.forEach((row) => ids.add(row.personId)); staffByBuilding.set(task.buildingId, ids);
  }
  for (const task of tasks) {
    task.reserveNames = people.filter((person) => person.appointment?.buildingId === task.buildingId
      && person.appointment.reserveFunctionId === task.functionId).map((person) => person.name).join(", ");
    task.staff = staffByBuilding.get(task.buildingId)?.size ?? 0;
    task.remaining = Math.max(0, task.goal - task.normalQd, task.need - task.normalQd - task.overtimeQd);
    task.effectiveRemaining = Math.max(0, task.effectiveNeed - task.effectiveQd);
    task.missedDays = task.dailyNeed ? task.effectiveDaily.filter((value) => Math.floor(value + 0.00001) < task.dailyNeed).length : 0;
    task.careGap = task.dailyNeed ? task.effectiveDaily.reduce((sum, value) => sum + Math.max(0, task.dailyNeed - Math.floor(value + 0.00001)), 0) : 0;
    task.categoryLabel = { required: "Обязательный уход", chosen: "Выбранная задача", optional: "По желанию" }[task.category];
    if (task.blocked) task.warnings.push(task.blocked);
    if (task.preparationWarning) task.warnings.push(task.preparationWarning);
    if (task.inputBlocked && (task.goal || task.assignments.length)) task.warnings.push("Нет сырья для запуска по текущим запасам");
    if (task.isStaff && task.staff > 0 && task.assignable && !["production", "maintenance"].includes(task.kind)
      && !people.some((person) => !person.unavailable && person.appointment?.buildingId === task.buildingId
        && [person.appointment.primaryFunctionId, person.appointment.reserveFunctionId].includes(task.functionId))) {
      task.warnings.push("Эта служба не назначена никому в штате: ни как основная, ни как резервная работа");
    }
    const collectionLine = task.kind === "production" && (task.building?.productionLines ?? [])
      .find((line, index) => task.functionId === `production:${line.id || `line-${index + 1}`}`);
    if (["staff", "qd"].includes(task.laborMode) && collectionLine?.requiresCollection && collectionLine.pendingQty > 0 && collectionLine.collectQd > 0) {
      const daily = task.isStaff ? Array(10).fill(0) : task.daily;
      const primaryDaily = Array(10).fill(0);
      if (task.isStaff) for (const person of people) {
        const appointment = person.appointment;
        if (appointment?.buildingId !== task.buildingId
          || ![appointment.primaryFunctionId, appointment.reserveFunctionId].includes(task.functionId)) continue;
        for (const [step, slot] of slotsByPerson.get(person.id) ?? []) {
          if (!slot.overtime || collectionLine.overtime === true) {
            daily[Math.floor(step / 4)] += 1;
            if (appointment.primaryFunctionId === task.functionId) primaryDaily[Math.floor(step / 4)] += 1;
          }
        }
      }
      const needed = Math.ceil(collectionLine.collectQd), available = Math.max(0, ...daily);
      if (needed > available) task.warnings.push(`Сбор требует ${needed} QD за один день; доступно не больше ${available}, не хватает ${needed - available} QD. Добавьте сборщиков или разрешённые сверхурочные.`);
      else if (task.isStaff && needed > Math.max(0, ...primaryDaily)) task.warnings.push("Сбор зависит от резервных работников: их основные задачи могут занять всё время. Проверьте фактическую бригаду в прогнозе десятника.");
    }
    if (task.assignments.length && task.staff < task.minimum && task.kind !== "maintenance") task.warnings.push(`Минимум здания: ${task.staff} / ${task.minimum} жителей`);
    if (task.assignments.length && task.building && task.kind !== "maintenance") {
      const assignedPeople = people.filter((person) => staffByBuilding.get(task.buildingId)?.has(person.id)).map((row) => row.person);
      if (!buildingCompositionStatus(task.building, assignedPeople).met) task.warnings.push("Не выполнен обязательный состав специалистов");
    }
    if (task.kind === "production" && task.assignments.length) {
      let unsupported = 0;
      for (let step = 0; step < 40; step += 1) {
        const scheduled = people.filter((person) => {
          const slot = slotsByPerson.get(person.id)?.get(step);
          return slot?.sourceId === task.sourceId && slot.functionId !== "maintenance";
        });
        const lineSlots = scheduled.filter((person) => slotsByPerson.get(person.id).get(step).functionId === task.functionId).length;
        if (lineSlots && (scheduled.length < task.minimum || !buildingCompositionStatus(task.building, scheduled.map((person) => person.person), { excludeGroups: ["ЧУДОТВОРЕЦ"] }).met)) unsupported += lineSlots;
      }
      if (unsupported) task.warnings.push(`${unsupported} QD без одновременного минимального состава: измените распределение между людьми`);
    }
    if (task.assignments.length && task.idle) task.warnings.push("Выделены QD, но сейчас работы нет; проверьте события десятника");
    if (task.missedDays) task.warnings.push(`Уход: не покрыто дней — ${task.missedDays} из 10`);
    task.attention = Boolean(task.warnings.length || task.remaining > 0 || task.effectiveRemaining > 0);
    task.totalQd = task.normalQd + task.overtimeQd;
    const activation = task.building?.activation;
    if (activation?.minOperationalQd > 0) {
      const peopleMinimum = task.laborMode === "legacy" ? `${activation.minWorkers || task.minimum} жителей и ` : "";
      task.note += task.laborMode === "legacy"
        ? ` Условие эффекта здания: не менее ${peopleMinimum}${activation.minOperationalQd} QD${activation.anyWorkingFunction ? " суммарно по рабочим функциям" : " по функции эффекта"}.`
        : ` Для полного эффекта нужно ${activation.minOperationalQd} QD соответствующей службы; неполная работа уменьшает эффект.`;
      if (activation.anyWorkingFunction && task.staff > 0) {
        const total = tasks.filter((row) => row.buildingId === task.buildingId && row.kind !== "maintenance").reduce((sum, row) => sum + row.normalQd + row.overtimeQd, 0);
        if (total < activation.minOperationalQd) task.warnings.push(`Для эффекта здания выделено ${total} из ${activation.minOperationalQd} QD`);
      }
    }
    task.attention ||= Boolean(task.warnings.length);
  }
  // Pure time/content lines are informational; assigning labor would never advance them.
  for (const building of holding.buildings?.list ?? []) {
    if (!shown(building, isGM)) continue;
    for (const [index, line] of (building.productionLines ?? []).entries()) {
      if (!["time", "content"].includes(line.source)) continue;
      if (taskMap.has(`${building.id}::production:${line.id || `line-${index + 1}`}`)) continue;
      tasks.push({ key: `${building.id}::info-${line.id || index}`, building, buildingId: String(building.id), name: building.name, functionName: line.mode || line.resource || line.resourceId,
        assignable: false, category: "optional", categoryLabel: line.source === "time" ? "Время без труда" : "Содержимое",
        note: "Эта линия не расходует QD жителей; управляйте ею в карточке здания.", assignments: [], warnings: [], normalQd: 0, overtimeQd: 0, totalQd: 0 });
    }
  }
  return { holding, draft, people, tasks, taskMap, staffByBuilding,
    free: sum(people, "free"), normalQd: sum(people.filter((row) => !row.unavailable), "normalQd"),
    overtimeQd: sum(people.filter((row) => !row.unavailable), "overtimeQd"), wage: sum(people.filter((row) => !row.unavailable), "wage"),
    requiredGap: sum(tasks.filter((row) => row.category === "required"), "careGap"),
    chosenGap: sum(tasks.filter((row) => row.category === "chosen"), "remaining"),
    warnings: tasks.filter((row) => row.attention).length, invalidWages: people.filter((row) => !row.unavailable && !row.wageValid).length };
}

export function workforceCandidate(model, person, task, service) {
  const existing = person.allocations.find((row) => row.key === task.key);
  const admission = task.building && task.kind !== "maintenance" ? workerAdmission(task.building, person.person) : null;
  const efficiency = task.building && task.kind !== "maintenance" ? service._workerEfficiencyForPerson(model.holding, task.building, person.person).value : 1;
  const occupies = task.buildingId && model.staffByBuilding.get(task.buildingId)?.has(person.id);
  const rate = calculatePlannedWorkerWage({ id: person.id, volunteer: person.appointment?.volunteer ?? person.person.volunteerLabor,
    wageOverrideCopper: person.appointment?.wageDailyCopper ?? person.person.wageDailyOverrideCopper,
    assignments: [{ normalQd: 2, overtimeQd: 0, dailyRateCopper: task.isStaff ? task.building.wageDailyCopper : task.dailyRateCopper, volunteer: existing?.volunteer }] });
  const reason = person.unavailable || (existing?.locked ? "Назначение закреплено" : "") || task.blocked
    || (!task.assignable ? "На этой линии нельзя назначить труд" : "")
    || (person.isStaff && (!task.isStaff || person.appointment.buildingId !== task.buildingId) ? "Постоянный сотрудник занят весь десятник; сначала снимите его из штата" : "")
    || (task.isStaff && !person.isStaff && person.allocations.some(hasWork) ? "Сначала снимите задания QD: найм занимает весь десятник" : "")
    || (admission?.hard && !admission.eligible && !admission.overridden ? "Нет обязательного допуска" : "")
    || (task.kind !== "maintenance" && ["legacy", "staff"].includes(task.laborMode) && !occupies && task.staff >= task.workersMax ? "Все места здания заняты" : "")
    || (task.laborMode === "qd" && task.capacityQd !== null && !existing
      && model.tasks.filter((row) => row.buildingId === task.buildingId && row.kind !== "maintenance").reduce((sum, row) => sum + row.totalQd, 0) >= task.capacityQd ? "Предел труда здания исчерпан" : "")
    || (!rate.ok ? "Нужна ставка или договорённость о бесплатной работе" : "");
  const productiveLabor = effectiveLabor(service, model.holding, task, person.person);
  return { ...person, reason, efficiency, effectiveLabor: productiveLabor, efficiencyText: `${Math.round(efficiency * 100)}%`,
    effectiveLaborText: `${productiveLabor.toLocaleString("ru-RU", { maximumFractionDigits: 4 })} эфф. QD / QD`, dailyRate: rate.dueCopper,
    existingNormal: existing?.normalQd ?? 0, existingOvertime: existing?.overtimeQd ?? 0,
    assignmentText: person.allocations.filter(hasWork).map((row) => `${row.label.split(" · ").slice(0, 2).join(" · ")}: ${row.normalQd}+${row.overtimeQd}`).join("; ") };
}

export function setWorkforceAllocation(draft, personId, task, normalQd, overtimeQd = 0) {
  if (draft.staffAppointments?.[personId] || task.isStaff) throw new Error("Для постоянной работы выберите основную и резервную задачи в назначении сотрудника.");
  if (![normalQd, overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Введите целое неотрицательное число QD.");
  const rows = draft.allocations[personId] ?? [];
  const previous = rows.find((row) => workforceKey(row) === task.key);
  if (draft.plan.locks.some((row) => row.personId === personId && workforceKey(row) === task.key)) throw new Error("Сначала снимите закрепление назначения.");
  const row = { ...(previous ?? { schemaVersion: 1, id: `planner-${personId}-${task.key}`, sourceId: task.sourceId, functionId: task.functionId }), normalQd, overtimeQd };
  draft.allocations[personId] = previous ? rows.map((value) => value === previous ? row : value) : [...rows, row];
  draft.allocations[personId] = draft.allocations[personId].filter(hasWork);
  if (!draft.edited.includes(personId)) draft.edited.push(personId);
}

/** One reversible edit: move only the requested QD, validate the complete result. */
export function reviseWorkforceAssignment(holding, draft, service, { personId, targetKey, fromKey = "", normalQd, overtimeQd = 0, add = false, ...options }) {
  const next = clone(draft);
  let model = buildWorkforceModel(holding, next, service, options);
  let person = model.people.find((row) => row.id === personId);
  if (!person) throw new Error("Житель недоступен для распределения.");
  if (person.unavailable) throw new Error(person.unavailable);
  if (![normalQd, overtimeQd].every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("Введите целое неотрицательное число QD.");
  if (fromKey) {
    if (fromKey === targetKey) throw new Error("Для переноса выберите другую работу.");
    const source = person.allocations.find((row) => row.key === fromKey);
    if (!source || normalQd > source.normalQd || overtimeQd > source.overtimeQd || normalQd + overtimeQd === 0) throw new Error("Для переноса не хватает QD в исходном назначении.");
    setWorkforceAllocation(next, personId, source, source.normalQd - normalQd, source.overtimeQd - overtimeQd);
    model = buildWorkforceModel(holding, next, service, options);
    person = model.people.find((row) => row.id === personId);
  }
  const task = model.taskMap.get(targetKey);
  if (!task) throw new Error("Работа недоступна для назначения.");
  const candidate = workforceCandidate(model, person, task, service);
  if (candidate.reason) throw new Error(candidate.reason);
  setWorkforceAllocation(next, personId, task,
    normalQd + (fromKey || add ? candidate.existingNormal : 0),
    overtimeQd + (fromKey || add ? candidate.existingOvertime : 0));
  const error = workforceDraftError(holding, next, options);
  if (error) throw new Error(error);
  return next;
}

/** Incremental, opt-in helper. It never removes existing work and never fills optional capacities. */
export function proposeWorkforceAssignments(holding, draft, service, { isGM = false, presenceHolding = holding, taskKeys = null, personIds = null, qd = null, useBuildingMinimum = false } = {}) {
  if (qd !== null && qd !== "all" && (!Number.isSafeInteger(qd) || qd < 1 || qd > 20)) throw new Error("Для массового назначения укажите от 1 до 20 обычных QD.");
  const proposed = clone(draft), changes = [], skipped = [];
  let model = buildWorkforceModel(holding, proposed, service, { isGM, presenceHolding });
  const unavailableSummary = (task) => {
    const reasons = new Map();
    for (const person of model.people.filter((row) => !personIds || personIds.includes(row.id))) {
      const candidate = workforceCandidate(model, person, task, service);
      const reason = candidate.reason || (!candidate.free ? "все обычные QD заняты" : "");
      if (reason) reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }
    return [...reasons].map(([reason, count]) => `${reason}: ${count}`).join("; ");
  };
  const chosen = model.tasks.filter((task) => taskKeys ? taskKeys.includes(task.key) : task.category !== "optional")
    .sort((a, b) => (a.category === "required" ? 0 : 1) - (b.category === "required" ? 0 : 1));
  if (!chosen.length) skipped.push("Нет обязательного ухода или задач с целью QD. Выберите работу и задайте её объём; свободные места сами по себе не требуют работников.");
  for (const initial of chosen) {
    let task = model.taskMap.get(initial.key);
    const readMinimum = () => workforceOperationalMinimum(task.building, model.tasks.filter((row) => row.buildingId === task.buildingId));
    const minimum = useBuildingMinimum && taskKeys ? readMinimum() : null;
    const effectMinimum = minimum?.minQd > 0 && minimum.relevant.some((row) => row.key === task.key) ? minimum : null;
    const effectGap = () => effectMinimum ? readMinimum().gap : 0;
    const workerMinimum = Math.max(task.minimum, effectMinimum?.minWorkers || 0);
    if (!task?.assignable || task.idle || task.inputBlocked) { skipped.push(`${initial.name}: ${initial.blocked || (task.inputBlocked ? "нет сырья по текущим запасам" : "сейчас нет доступного труда")}`); continue; }
    if (qd === null && !task.goal && !task.need && !task.effectiveNeed && !effectMinimum) {
      skipped.push(`${task.name}: сначала задайте цель труда в QD`); continue;
    }
    if (task.isStaff) {
      const candidates = model.people.filter((person) => !person.isStaff && (!personIds || personIds.includes(person.id)))
        .map((person) => workforceCandidate(model, person, task, service))
        .sort((a, b) => a.dailyRate - b.dailyRate || b.efficiency - a.efficiency || a.id.localeCompare(b.id));
      // Specialists belong to the building's simultaneous shift. Reserve-only
      // promises and unavailable employees cannot substitute for actual staff.
      const existingTeam = model.people.filter((person) => person.isStaff && !person.unavailable && person.wageValid
        && person.appointment.buildingId === task.buildingId
        && person.allocations.some((row) => hasWork(row) && row.functionId !== "maintenance")).map((row) => row.person);
      const composition = (team) => buildingCompositionStatus(task.building, team,
        { excludeGroups: ["production", "agriculture", "livestock"].includes(task.kind) ? ["ЧУДОТВОРЕЦ"] : [] });
      let core = candidates.filter((person) => !person.reason && person.free > 0);
      if (!composition([...existingTeam, ...core.map((row) => row.person)]).met) {
        skipped.push(`${task.name}: не хватает специалистов обязательного состава (${composition([]).text})`); continue;
      }
      for (const candidate of [...core].reverse()) {
        const without = core.filter((row) => row.id !== candidate.id);
        if (composition([...existingTeam, ...without.map((row) => row.person)]).met) core = without;
      }
      if (core.length > Math.max(0, task.workersMax - task.staff)) {
        skipped.push(`${task.name}: для обязательного состава нужно свободных мест: ${core.length}; доступно: ${Math.max(0, task.workersMax - task.staff)}`); continue;
      }
      // Validate the whole core first: a rejected second hire must not leave an
      // unusable, paid half-team in the suggestion.
      const coreDraft = clone(proposed);
      let coreError = "";
      try {
        for (const candidate of core) setWorkforceStaff(coreDraft, candidate.person, task);
        coreError = workforceDraftError(holding, coreDraft, { isGM });
      } catch (error) { coreError = error.message; }
      if (coreError) { skipped.push(`${task.name}: ${coreError}`); continue; }
      const coreIds = new Set(core.map((row) => row.id));
      candidates.sort((a, b) => Number(coreIds.has(b.id)) - Number(coreIds.has(a.id)));
      for (const candidate of candidates) {
        task = model.taskMap.get(initial.key);
        const missing = Math.max(task.remaining, effectGap(), task.effectiveRemaining, task.careGap);
        if (qd === null && !missing && !coreIds.size) break;
        const current = model.people.find((row) => row.id === candidate.id);
        const admission = workforceCandidate(model, current, task, service);
        if (admission.reason || !admission.free) {
          if (personIds) skipped.push(`${candidate.name}: ${admission.reason || "нет свободного времени"}`);
          continue;
        }
        const attempt = clone(proposed);
        setWorkforceStaff(attempt, current.person, task);
        const error = workforceDraftError(holding, attempt, { isGM });
        if (error) { skipped.push(`${candidate.name}: ${error}`); continue; }
        Object.assign(proposed, attempt);
        coreIds.delete(candidate.id);
        changes.push({ personId: candidate.id, name: candidate.name, task: `${task.name} · ${task.functionName}`,
          before: "нет постоянной работы", after: `весь десятник (${candidate.capacity.normalQd} QD)`, free: 0 });
        model = buildWorkforceModel(holding, proposed, service, { isGM, presenceHolding });
      }
      task = model.taskMap.get(initial.key);
      if (Math.max(task.remaining, effectGap(), task.effectiveRemaining, task.careGap) > 0) skipped.push(`${task.name}: штат не закрывает выбранный объём. ${unavailableSummary(task)}`);
      continue;
    }
    const candidates = model.people.filter((person) => !personIds || personIds.includes(person.id))
      .map((person) => workforceCandidate(model, person, task, service))
      .sort((a, b) => a.dailyRate - b.dailyRate || b.efficiency - a.efficiency || a.id.localeCompare(b.id));
    let coreIds = new Set();
    if (qd === null && task.building && task.kind !== "maintenance") {
      const existingTeam = model.people.filter((person) => model.staffByBuilding.get(task.buildingId)?.has(person.id)).map((row) => row.person);
      const composition = (team) => buildingCompositionStatus(task.building, team, { excludeGroups: ["production", "agriculture", "livestock"].includes(task.kind) ? ["ЧУДОТВОРЕЦ"] : [] });
      let core = candidates.filter((person) => !person.reason && person.free > 0 && !existingTeam.some((row) => row.id === person.id));
      if (existingTeam.length + core.length < workerMinimum) {
        skipped.push(`${task.name}: для работы нужно ${workerMinimum} работников; доступно ${existingTeam.length + core.length}. ${unavailableSummary(task)}. Проверьте свободные QD, оплату и допуски во вкладке «Жители».`); continue;
      }
      if (!composition([...existingTeam, ...core.map((row) => row.person)]).met) {
        skipped.push(`${task.name}: не хватает специалистов обязательного состава (${composition([]).text})`); continue;
      }
      // Remove dispensable candidates starting with the expensive/less effective.
      // Keep the engine's distinct-person matching for overlapping specialties.
      for (const candidate of [...core].reverse()) {
        const without = core.filter((row) => row.id !== candidate.id);
        if (composition([...existingTeam, ...without.map((row) => row.person)]).met) core = without;
      }
      coreIds = new Set(core.map((row) => row.id));
      candidates.sort((a, b) => Number(coreIds.has(b.id)) - Number(coreIds.has(a.id))
        || (task.staff < workerMinimum ? Number(existingTeam.some((row) => row.id === a.id)) - Number(existingTeam.some((row) => row.id === b.id)) : 0));
    }
    for (const person of candidates) {
      const livePerson = model.people.find((row) => row.id === person.id);
      const candidate = workforceCandidate(model, livePerson, task, service);
      if (candidate.reason || !candidate.free) { if (personIds) skipped.push(`${candidate.name}: ${candidate.reason || "нет свободных QD"}`); continue; }
      const needed = qd === "all" ? candidate.free : qd !== null ? Number(qd)
        : Math.max(task.remaining, effectGap(), task.missedDays * task.dailyNeed, Math.ceil(task.effectiveRemaining / Math.max(0.01, candidate.effectiveLabor)),
          Math.max(0, workerMinimum - task.staff), coreIds.size);
      if (!needed) continue;
      let add = Math.min(candidate.free, needed);
      if (task.laborMode === "qd" && task.capacityQd !== null && task.kind !== "maintenance") {
        const allocated = model.tasks.filter((row) => row.buildingId === task.buildingId && row.kind !== "maintenance").reduce((sum, row) => sum + row.totalQd, 0);
        add = Math.min(add, Math.max(0, task.capacityQd - allocated));
      }
      const missingTeam = Math.max(workerMinimum - task.staff, coreIds.size);
      if (qd === null && !task.dailyNeed && missingTeam > 0) add = Math.min(add, Math.max(1, Math.ceil(needed / missingTeam)));
      // Daily care depends on both proficiency and the actual shared schedule.
      // Find the smallest addition with the best daily coverage, not a fixed 10 QD.
      if (task.dailyNeed && qd === null && task.careGap) {
        let bestGap = task.careGap, bestAdd = 0;
        for (let amount = 1; amount <= candidate.free; amount += 1) {
          const trial = clone(proposed);
          setWorkforceAllocation(trial, candidate.id, task, candidate.existingNormal + amount, candidate.existingOvertime);
          const gap = buildWorkforceModel(holding, trial, service, { isGM, presenceHolding }).taskMap.get(task.key).careGap;
          if (gap < bestGap) { bestGap = gap; bestAdd = amount; }
          if (!gap) break;
        }
        if (!bestAdd) continue;
        add = Math.max(bestAdd, Math.min(candidate.free, task.remaining));
      }
      if (task.laborMode === "qd" && task.capacityQd !== null && task.kind !== "maintenance") {
        const allocated = model.tasks.filter((row) => row.buildingId === task.buildingId && row.kind !== "maintenance").reduce((sum, row) => sum + row.totalQd, 0);
        add = Math.min(add, Math.max(0, task.capacityQd - allocated));
      }
      if (!add) continue;
      const attempt = clone(proposed);
      setWorkforceAllocation(attempt, candidate.id, task, candidate.existingNormal + add, candidate.existingOvertime);
      const error = workforceDraftError(holding, attempt, { isGM });
      if (error) { skipped.push(`${candidate.name}: ${error}`); continue; }
      Object.assign(proposed, attempt);
      coreIds.delete(candidate.id);
      changes.push({ personId: candidate.id, name: candidate.name, task: `${task.name} · ${task.functionName}`,
        before: candidate.existingNormal, after: candidate.existingNormal + add, free: candidate.free - add });
      if (qd !== null && task.laborMode !== "qd") {
        // A bulk edit has independent per-person amounts. Avoid 200 full model
        // rebuilds; keep only the shared seat count up to date until the end.
        if (task.buildingId && task.kind !== "maintenance") {
          const ids = model.staffByBuilding.get(task.buildingId) ?? new Set(); ids.add(candidate.id);
          model.staffByBuilding.set(task.buildingId, ids); task.staff = ids.size;
        }
      } else {
        model = buildWorkforceModel(holding, proposed, service, { isGM, presenceHolding });
        task = model.taskMap.get(initial.key);
      }
    }
    if (qd !== null) model = buildWorkforceModel(holding, proposed, service, { isGM, presenceHolding });
    const left = Math.max(task.remaining, effectGap(), task.effectiveRemaining, task.careGap);
    if (qd === null && (left > 0 || task.staff < workerMinimum)) {
      skipped.push(`${task.name} · ${task.functionName}: план не закрыт${left ? `, остаток ${Number(left.toFixed(2))} QD` : ""}. ${unavailableSummary(task) || "Оставшегося труда не хватает для этой задачи"}. Для переноса занятого времени откройте вкладку «Жители».`);
    }
  }
  if (!changes.length && !skipped.length) skipped.push("Выбранные задачи уже обеспечены трудом. Дополнительных назначений не требуется.");
  return { draft: proposed, changes, skipped, model };
}

export function proposeWorkforceIdleReview(holding, draft, service, { isGM = false, presenceHolding = holding } = {}) {
  const proposed = clone(draft), model = buildWorkforceModel(holding, draft, service, { isGM, presenceHolding }), changes = [], skipped = [];
  for (const task of model.tasks.filter((row) => row.certainIdle)) {
    for (const assignment of task.assignments) {
      if (assignment.isStaff) { skipped.push(`${assignment.name}: постоянный сотрудник остаётся в здании; можно выбрать резервную работу.`); continue; }
      if (assignment.locked) { skipped.push(`${assignment.name}: назначение закреплено`); continue; }
      const attempt = clone(proposed);
      setWorkforceAllocation(attempt, assignment.personId, task, 0, 0);
      const error = workforceDraftError(holding, attempt, { isGM });
      if (error) { skipped.push(`${assignment.name}: ${error}`); continue; }
      Object.assign(proposed, attempt);
      changes.push({ name: assignment.name, task: `${task.name} · ${task.functionName}`, before: `${assignment.normalQd} + ${assignment.overtimeQd}`, after: "0 + 0 QD" });
    }
  }
  skipped.push("Сняты только назначения при ожидании дольше всего десятника. Конечные этапы, поставки и возможные поломки требуют проверки в расчёте; их QD автоматически не снимаются.");
  return { draft: proposed, changes, skipped, model: buildWorkforceModel(holding, proposed, service, { isGM, presenceHolding }) };
}
