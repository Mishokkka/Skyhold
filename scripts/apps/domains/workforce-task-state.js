import { normalizeAgricultureBuilding } from "../../data/agriculture.js";
import { normalizeLivestockBuilding } from "../../data/livestock.js";
import { livestockHeadcount } from "../../engines/economy/livestock.js";
import { productionTiming, productionTimingText } from "../../engines/economy/production-timing.js";
import { productionCapacity, productionOccupiedQty, waitingProductionBatches, productionBatchCosts, affordableProductionBatch } from "../../engines/economy/production-capacity.js";
import { buildingServiceFunctionId } from "../../engines/economy/building-service.js";

/** Share the effect's scope between its display and opt-in worker selection. */
export function workforceOperationalMinimum(building, tasks) {
  if (!building) return null;
  const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const activation = building.activation ?? {};
  const functionId = activation.requiresMeaningfulResult ? "" : buildingServiceFunctionId(building);
  const relevant = tasks.filter((task) => task.kind !== "maintenance" && task.assignable
    && (!functionId || task.functionId === functionId || functionId === "production" && task.functionId?.startsWith("production:")));
  const minQd = whole(activation.minOperationalQd ?? building.minOperationalQd);
  const qd = relevant.reduce((sum, task) => sum + Number(task.normalQd || 0) + Number(task.overtimeQd || 0), 0);
  return { minQd, minWorkers: Math.max(whole(building.workersMin), whole(activation.minWorkers)), functionId, relevant, qd,
    workers: new Set(relevant.flatMap((task) => task.assignments.map((row) => row.personId))).size, gap: Math.max(0, minQd - qd) };
}

/** Describe present work, not a promise that all inputs or future daily events will cooperate. */
export function workforceTaskState(holding, target, building, service, availableFunction) {
  const state = { category: "optional", need: 0, effectiveNeed: 0, dailyNeed: 0, idle: false,
    note: "Работа по желанию. Свободные места не создают потребность в труде.", finite: false };
  if (target.kind === "maintenance") {
    state.note = "Обслуживание: объём и покрытие проверяются в расчёте десятника. Цель QD задаётся вручную.";
    return state;
  }
  if (target.kind === "agriculture") {
    const agriculture = normalizeAgricultureBuilding(building.agriculture, { building });
    const crop = agriculture.crops.find((row) => row.id === (agriculture.state.cropId || agriculture.activeCropId));
    const phase = agriculture.state.phase;
    if (!availableFunction) {
      state.idle = true;
      state.certainIdle = phase === "growing" && Number(crop?.growingQd) - agriculture.state.growingElapsedQd > 40;
      state.note = phase === "growing" ? "Растёт; сейчас труд не нужен. В течение десятника может созреть."
        : "Нет активного этапа: проверьте культуру, сезон и переключатели посева / сбора.";
      return state;
    }
    state.category = "chosen"; state.finite = true;
    state.effectiveNeed = ["ready", "harvesting"].includes(phase)
      ? Math.max(0, agriculture.state.harvestWorkQdTotal - agriculture.state.harvestProgressQd)
      : Math.max(0, Number(crop?.sowingWorkQd ?? 0) - agriculture.state.sowingProgressQd);
    state.note = `${["ready", "harvesting"].includes(phase) ? "Сбор" : "Посев"}: осталось ${state.effectiveNeed} эффективных QD. Проверяется текущий этап; смена сезона и созревание уточняются в расчёте десятника.`;
    return state;
  }
  if (target.kind === "livestock") {
    const livestock = normalizeLivestockBuilding(building.livestock, { building });
    const heads = livestockHeadcount(livestock.state);
    if (!heads) { state.note = "Стадо пусто: обязательного ухода нет."; return state; }
    state.category = "required";
    state.dailyNeed = Math.max(1, Number(livestock.profile.careWorkQdPerDay) || 1);
    state.need = state.dailyNeed * 10;
    state.note = `${heads} животных; уход ежедневно по ${state.dailyNeed} QD. Доение / яйца следуют правилам ухода; стрижка и убой требуют дополнительного труда. Нужны также корм и исправное здание.`;
    return state;
  }
  if (target.kind === "production") {
    const line = (building.productionLines ?? []).find((row, index) => target.functionId === `production:${row.id || `line-${index + 1}`}`);
    if (!line) return state;
    const timing = productionTiming(line), capacity = productionCapacity(line), occupied = productionOccupiedQty(line);
    const waiting = waitingProductionBatches(line);
    const waitingDays = [...waiting.map((batch) => productionTiming(batch)), timing]
      .filter((row) => row?.phase === "waiting").map((row) => Math.max(0, row.waitQd - row.elapsedQd) / 4);
    state.note = productionTimingText(line) || "Повторяемая линия: объём зависит от сырья, вместимости и выделенного труда.";
    if (timing?.phase === "work" || line.workInputsReserved && timing?.phase !== "waiting") {
      state.category = "chosen";
      state.effectiveNeed = Math.max(0, ((timing?.workTargetUnits ?? Number(line.workQd) * 10000) - Number(line.workProgressUnits || 0)) / 10000);
      state.note += ` До завершения текущей подготовки: ${state.effectiveNeed} эффективных QD; затем возможна следующая партия.`;
    }
    if (capacity > 0) state.note += ` Занято ${occupied} из ${capacity} ед.; запуск от ${line.batchStartQty || 1} ед.`;
    if (waitingDays.length) state.note += ` Ближайшая выдержка: ${Math.min(...waitingDays)} дн. Ожидание не расходует рабочие QD.`;
    if ((capacity > 0 && capacity - occupied < Math.max(1, Number(line.batchStartQty) || 1) || waiting.length && (!capacity || line.repeat === false)) && timing?.phase !== "work") {
      // Report only certain present unavailability. Do not free future QD automatically.
      state.idle = true;
      state.certainIdle = waitingDays.length > 0 && Math.min(...waitingDays) > 10 && !line.pendingQty;
      state.note += " Сейчас нет места для подготовки. Освобождение вместимости может вернуть работу в этом десятнике.";
    }
    const formula = String(line.formula ?? "").trim();
    const fullQty = formula ? (/^\d+(?:\.\d+)?$/.test(formula) ? Math.floor(Number(formula)) : null)
      : Math.floor(Number(line.outputQty ?? line.output ?? line.quantity ?? 1));
    if (!line.workInputsReserved && !state.idle && fullQty > 0) {
      const costsFor = (qty) => productionBatchCosts(line, service._parseResourceCosts(line.expenses), service._parseResourceCosts(line.fixedExpenses), qty, fullQty);
      const free = capacity ? Math.min(fullQty, capacity - occupied) : fullQty;
      const affordable = capacity ? affordableProductionBatch(free, costsFor, (costs) => service._storageCanPay(holding, costs))
        : service._storageCanPay(holding, costsFor(fullQty)).ok ? fullQty : 0;
      const minimum = capacity ? Math.max(1, Number(line.batchStartQty) || 1) : fullQty;
      if (affordable < minimum) {
        state.inputBlocked = true;
        state.note += " Сейчас на складе не хватает сырья / денег для старта. Помощник пропустит эту задачу; запланированные поставки учитываются при расчёте десятника.";
      }
    }
    return state;
  }
  state.note = "Служба по выбору поселения. Минимум людей относится ко всему зданию; назначение на одну функцию не оплачивает вторую автоматически.";
  return state;
}
