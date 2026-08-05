import { isSkyholdDebugLoggingEnabled } from "./debug.js";

const MAX_TIMING_SAMPLES = 240;
const timingRows = new Map();
const counters = new Map();
let activeScenario = null;

function clockNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function rounded(value) {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

export function isSkyholdPerformanceEnabled() {
  return globalThis.fblSkyholdPerformance === true || isSkyholdDebugLoggingEnabled();
}

export function startSkyholdPerformanceTimer() {
  return isSkyholdPerformanceEnabled() ? clockNow() : null;
}

export function recordSkyholdPerformance(name, durationMs) {
  if (!isSkyholdPerformanceEnabled()) return;
  const key = String(name ?? "").trim();
  const duration = Math.max(0, Number(durationMs) || 0);
  if (!key) return;

  const row = timingRows.get(key) ?? { count: 0, total: 0, max: 0, last: 0, samples: [] };
  row.count += 1;
  row.total += duration;
  row.max = Math.max(row.max, duration);
  row.last = duration;
  row.samples.push(duration);
  if (row.samples.length > MAX_TIMING_SAMPLES) row.samples.splice(0, row.samples.length - MAX_TIMING_SAMPLES);
  timingRows.set(key, row);
}

export function finishSkyholdPerformanceTimer(name, startedAt) {
  if (startedAt === null || startedAt === undefined) return;
  recordSkyholdPerformance(name, clockNow() - Number(startedAt));
}

export function countSkyholdPerformance(name, amount = 1) {
  if (!isSkyholdPerformanceEnabled()) return;
  const key = String(name ?? "").trim();
  if (!key) return;
  counters.set(key, (counters.get(key) ?? 0) + (Number(amount) || 0));
}

export function measureSkyholdPerformance(name, operation) {
  if (typeof operation !== "function") throw new TypeError("FBL Skyhold | performance operation must be a function.");
  const startedAt = startSkyholdPerformanceTimer();
  if (startedAt === null) return operation();

  try {
    const result = operation();
    if (result && typeof result.then === "function") {
      return result.then(
        (value) => {
          finishSkyholdPerformanceTimer(name, startedAt);
          return value;
        },
        (error) => {
          finishSkyholdPerformanceTimer(name, startedAt);
          countSkyholdPerformance(`${name}.errors`);
          throw error;
        }
      );
    }
    finishSkyholdPerformanceTimer(name, startedAt);
    return result;
  } catch (error) {
    finishSkyholdPerformanceTimer(name, startedAt);
    countSkyholdPerformance(`${name}.errors`);
    throw error;
  }
}

export function resetSkyholdPerformance() {
  timingRows.clear();
  counters.clear();
}

export function getSkyholdPerformanceSnapshot(extra = {}) {
  const timings = {};
  for (const [name, row] of timingRows) {
    timings[name] = {
      count: row.count,
      averageMs: rounded(row.total / Math.max(1, row.count)),
      p50Ms: rounded(percentile(row.samples, 0.5)),
      p95Ms: rounded(percentile(row.samples, 0.95)),
      maxMs: rounded(row.max),
      lastMs: rounded(row.last),
      sampled: row.samples.length
    };
  }

  return {
    enabled: isSkyholdPerformanceEnabled(),
    scenario: activeScenario ? { name: activeScenario.name, startedAt: activeScenario.startedAt, metadata: { ...activeScenario.metadata } } : null,
    timings,
    counters: Object.fromEntries(counters),
    ...extra
  };
}

export function startSkyholdPerformanceScenario(name = "manual", metadata = {}) {
  if (activeScenario) throw new Error(`FBL Skyhold | performance scenario ${activeScenario.name} is already active.`);
  const previousOverride = globalThis.fblSkyholdPerformance;
  globalThis.fblSkyholdPerformance = true;
  resetSkyholdPerformance();
  activeScenario = {
    name: String(name || "manual"),
    metadata: metadata && typeof metadata === "object" ? { ...metadata } : {},
    startedAt: new Date().toISOString(),
    startedClock: clockNow(),
    previousOverride
  };
  return getSkyholdPerformanceSnapshot();
}

export function stopSkyholdPerformanceScenario(extra = {}) {
  if (!activeScenario) return getSkyholdPerformanceSnapshot(extra);
  const scenario = activeScenario;
  const elapsedMs = clockNow() - scenario.startedClock;
  const snapshot = getSkyholdPerformanceSnapshot({ elapsedMs: rounded(elapsedMs), ...extra });
  activeScenario = null;
  if (scenario.previousOverride === undefined) delete globalThis.fblSkyholdPerformance;
  else globalThis.fblSkyholdPerformance = scenario.previousOverride;
  return snapshot;
}
