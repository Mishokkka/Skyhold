const whole = (value, fallback = 0) => Math.max(0, Math.ceil(Number.isFinite(Number(value)) ? Number(value) : fallback));

export const PRODUCTION_WORK_UNITS = 10_000;

export function productionTimeQd(line = {}) {
  const period = line.period === "qd" ? 1 : line.period === "tenday" ? 40 : 4;
  return Math.max(1, whole(line.workQd, 1)) * period;
}

export function productionWaitQd(line = {}) {
  return line.source === "time" ? productionTimeQd(line)
    : line.source === "content" ? 0 : whole(line.waitDays * 4);
}

/** Stored inside the existing funded-input receipt; absent on legacy batches. */
export function productionTiming(line = {}) {
  return line.workInputsReserved ? line.workReservedInputs?.timing ?? null : null;
}

export function validProductionTiming(timing) {
  return Boolean(timing && ["workers", "time"].includes(timing.source)
    && ["work", "waiting"].includes(timing.phase)
    && (timing.source !== "time" || timing.phase === "waiting")
    && Number.isSafeInteger(timing.workTargetUnits) && timing.workTargetUnits > 0
    && Number.isSafeInteger(timing.waitQd) && timing.waitQd >= 0
    && Number.isSafeInteger(timing.elapsedQd) && timing.elapsedQd >= 0
    && (timing.phase !== "work" || timing.elapsedQd === 0)
    && (timing.phase !== "waiting" || timing.elapsedQd < timing.waitQd)
    && typeof timing.resourceId === "string" && typeof timing.resourceName === "string");
}

export function productionIdentityLocked(line = {}) {
  return Boolean(line.workInputsReserved || line.workProgressUnits || line.pendingQty || line.waitingBatches?.length);
}

export function assertProductionIdentityUnchanged(before = [], after = []) {
  for (const previous of before) {
    const next = after.find((line) => line.id === previous.id);
    if (!next || !productionIdentityLocked(previous)) continue;
    if ((previous.source ?? "workers") !== (next.source ?? "workers")
      || previous.resourceId !== next.resourceId
      || (previous.resourceId === "custom" && previous.resource !== next.resource)) {
      throw new Error("Сначала завершите или отмените партию и соберите готовый выпуск: источник и ресурс занятой линии менять нельзя.");
    }
  }
}

export function createProductionTiming(line, resourceId, resourceName) {
  return {
    source: line.source === "time" ? "time" : "workers",
    phase: line.source === "time" ? "waiting" : "work",
    workTargetUnits: Math.max(1, whole(line.workQd, 1)) * PRODUCTION_WORK_UNITS,
    waitQd: productionWaitQd(line), elapsedQd: 0,
    resourceId, resourceName
  };
}

export function productionTimingText(line = {}) {
  const timing = productionTiming(line);
  const format = (value) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value);
  if (timing?.phase === "waiting") {
    return `Ожидание: ${format(timing.elapsedQd / 4)} / ${format(timing.waitQd / 4)} дн.; осталось ${format(Math.max(0, timing.waitQd - timing.elapsedQd) / 4)} дн.${line.active === false ? " · пауза" : ""}`;
  }
  if (line.workInputsReserved) {
    return `Работа: ${format((line.workProgressUnits || 0) / PRODUCTION_WORK_UNITS)} / ${format((timing?.workTargetUnits ?? line.workQd * PRODUCTION_WORK_UNITS) / PRODUCTION_WORK_UNITS)} QD${line.active === false ? " · пауза" : ""}`;
  }
  return "";
}
