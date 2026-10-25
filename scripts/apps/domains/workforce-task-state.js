import { normalizeAgricultureBuilding } from "../../data/agriculture.js";
import { normalizeLivestockBuilding } from "../../data/livestock.js";
import { livestockHeadcount } from "../../engines/economy/livestock.js";
import { productionTiming, productionTimingText, PRODUCTION_WORK_UNITS } from "../../engines/economy/production-timing.js";
import { productionCapacity, productionOccupiedQty, waitingProductionBatches, productionBatchCosts, affordableProductionBatch } from "../../engines/economy/production-capacity.js";
import { buildingServiceFunctionId } from "../../engines/economy/building-service.js";
import { buildingLaborMode } from "../../data/hybrid-labor.js";

/** Deterministic estimate for worker selection; execution owns actual starts and results. */
export function workforceProductionGoalState(building, functionId, preparedUnits = 0) {
  const line = (building?.productionLines ?? []).find((row) => `production:${row.id}` === functionId);
  const formula = String(line?.formula ?? "").trim();
  const fullQty = formula ? /^\d+$/.test(formula) ? Number(formula) : 0 : Number(line?.outputQty ?? line?.output ?? line?.quantity ?? 1);
  const allowed = ["staff", "qd"].includes(buildingLaborMode(building))
    && line?.source === "workers" && Number.isSafeInteger(fullQty) && fullQty > 0;
  if (!allowed || !preparedUnits) return { allowed, effectiveNeed: 0, warning: "" };
  const timing = productionTiming(line);
  const ongoing = line.workInputsReserved && timing?.phase !== "waiting" ? Math.max(0, Number(line.workReservedOutputQty) || 0) : 0;
  const remaining = Math.max(0, preparedUnits - ongoing);
  const currentWork = ongoing ? Math.max(0, (timing?.workTargetUnits ?? Number(line.workQd) * 10000) - Number(line.workProgressUnits || 0)) / 10000 : 0;
  const partial = productionCapacity(line) > 0;
  const minimum = partial ? Math.max(1, Number(line.batchStartQty) || 1) : fullQty;
  const maximum = partial ? Math.min(fullQty, productionCapacity(line)) : fullQty;
  if (remaining && maximum < minimum) return { allowed, effectiveNeed: currentWork,
    warning: `Максимальная загрузка ${maximum} ЕД. меньше порога запуска ${minimum} ЕД.; новая партия не запустится.` };
  const residual = remaining % maximum;
  const unsupportedRemainder = residual > 0 && residual < minimum;
  const targetUnits = Math.max(1, Math.ceil(Number(line.workQd) || 1)) * PRODUCTION_WORK_UNITS;
  // Match each possible equipment load, including the executor's integer-unit
  // rounding. The recipe's full output can exceed the equipment's capacity.
  const fullBatches = Math.floor(remaining / maximum);
  const workUnits = fullBatches * Math.ceil(targetUnits * maximum / fullQty)
    + (residual && !unsupportedRemainder ? Math.ceil(targetUnits * residual / fullQty) : 0);
  return { allowed, effectiveNeed: currentWork + workUnits / PRODUCTION_WORK_UNITS,
    warning: unsupportedRemainder ? `Остаток цели ${residual} ЕД. меньше допустимой загрузки ${minimum} ЕД.; новая партия для него не запустится.`
      : ongoing > preparedUnits ? `Начатая партия на ${ongoing} ЕД. превышает цель; она будет завершена целиком.` : "" };
}

/** Share the effect's scope between its display and opt-in worker selection. */
export function workforceOperationalMinimum(building, tasks) {
  if (!building) return null;
  const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
  const activation = building.activation ?? {};
  const functionId = buildingLaborMode(building) === "legacy" && activation.requiresMeaningfulResult ? "" : buildingServiceFunctionId(building);
  const relevant = tasks.filter((task) => task.kind !== "maintenance" && task.assignable
    && (!functionId || task.functionId === functionId || functionId === "production" && task.functionId?.startsWith("production:")));
  const minQd = whole(activation.minOperationalQd ?? building.minOperationalQd);
  const qd = relevant.reduce((sum, task) => sum + Number(task.normalQd || 0) + Number(task.overtimeQd || 0), 0);
  return { minQd, minWorkers: buildingLaborMode(building) === "legacy" ? Math.max(whole(building.workersMin), whole(activation.minWorkers)) : 0, functionId, relevant, qd,
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
    if (phase === "growing") {
      state.effectiveNeed = Math.max(0, Number(crop?.harvestWorkQd) || 0);
      state.note = `Предстоящий сбор: ${state.effectiveNeed} эффективных QD. Урожай созревает в течение десятника; ранние слоты до созревания не выполняют сбор. Подбор оценивает объём труда, точные сроки проверяет расчёт десятника.`;
      return state;
    }
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
    state.effectiveNeed = state.dailyNeed * 10;
    state.note = `${heads} животных; уход ежедневно по ${state.dailyNeed} эффективных QD. Фактическое время зависит от производительности работников. Доение / яйца следуют правилам ухода; стрижка и убой требуют дополнительного труда. Нужны также корм и исправное здание.`;
    return state;
  }
  if (target.kind === "production") {
    const line = (building.productionLines ?? []).find((row, index) => target.functionId === `production:${row.id || `line-${index + 1}`}`);
    if (!line) return state;
    if (target.paused) {
      state.idle = !target.collectionAvailable;
      state.certainIdle = state.idle;
      state.category = target.collectionAvailable ? "chosen" : "optional";
      state.need = target.collectionAvailable ? Math.max(1, Number(line.collectQd) || 1) : 0;
      state.note = target.collectionAvailable ? `Линия приостановлена; готово к сбору ${line.pendingQty} ЕД., сбор требует ${state.need} QD.`
        : "Линия приостановлена. Назначение сохранено; подготовка возобновится после включения линии.";
      return state;
    }
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
  state.note = buildingLaborMode(building) === "staff"
    ? "Постоянная служба. Сотрудник занят весь десятник по одной ставке; работа другой службы учитывается отдельно."
    : buildingLaborMode(building) === "qd"
      ? "Служба по выбору поселения. Результат зависит от выделенного ей труда; число прежних мест не ограничивает исполнителей."
      : "Служба по выбору поселения. Минимум людей относится ко всему зданию; назначение на одну функцию не оплачивает вторую автоматически.";
  return state;
}
