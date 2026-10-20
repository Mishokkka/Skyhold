import { financeWorkerBlockState } from "../economy/finance-obligations.js";
import {
  buildingActiveWorkerSummary,
  buildingServiceBlockReasons,
  buildingServiceEffectFactor
} from "../economy/building-service.js";
import { isResidentInPopulation } from "../../data/resident-presence.js";
import { politicsRuntimeEffects } from "../politics/runtime-effects.js";
import { isSheriffAppointment } from "../../data/control-appointments.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function signedRound(value = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !parsed) return 0;
  return Math.sign(parsed) * Math.round(Math.abs(parsed));
}

function standaloneSheriff(holding = {}) {
  const candidates = (holding?.people?.list ?? []).filter((person) => {
    if (!isResidentInPopulation(person, holding) || whole(person?.injuredDays) > 0) return false;
    if (!isSheriffAppointment(person)) return false;
    return !financeWorkerBlockState({ finance: holding?.finance, workerId: text(person?.id) }).blocked;
  });
  return candidates[0] ?? null;
}

function controlValue(control = {}, workforce = {}, kind = "general", factor = 1) {
  const flat = whole(control?.[`${kind}Flat`]);
  const perWorker = whole(control?.[`${kind}PerWorker`]);
  const maximum = whole(control?.maximum);
  let value = flat + (perWorker * whole(workforce?.count));
  if (maximum > 0) value = Math.min(value, maximum);
  return Math.max(0, signedRound(value * Math.max(0, Math.min(1, Number(factor) || 0))));
}

/**
 * Control is derived state. It is deliberately never persisted as a settlement
 * total: workers, debts, maintenance and population can all change it.
 */
export function settlementControlSummary(holding = {}, { rawMorale = 0, includePolitics = true } = {}) {
  const population = (holding?.people?.list ?? []).filter((person) => isResidentInPopulation(person, holding)).length;
  const sources = [];
  let generalControl = 0;
  let unrestOnlyControl = 0;

  const sheriff = standaloneSheriff(holding);
  if (sheriff) {
    sources.push({
      id: `sheriff:${text(sheriff.id)}`,
      name: sheriff.name || "Шериф",
      general: 1,
      unrestOnly: 0,
      ceiling: -10,
      capacity: 10,
      sourceKind: "appointment"
    });
    generalControl += 1;
  }

  for (const building of holding?.buildings?.list ?? []) {
    const control = building?.control;
    if (!control || typeof control !== "object") continue;
    const status = buildingServiceBlockReasons(holding, building);
    if (!status.active) continue;
    const factor = buildingServiceEffectFactor(holding, building, status.functionId);
    const workforce = buildingActiveWorkerSummary(holding, building, status.functionId);
    const general = controlValue(control, workforce, "general", factor);
    const unrestOnly = controlValue(control, workforce, "unrestOnly", factor);
    if (!general && !unrestOnly) continue;
    const rawCapacity = whole(control.capacity);
    const capacity = rawCapacity > 0 ? Math.floor(rawCapacity * factor) : 0;
    const ceilingNumber = Number(control.ceiling);
    const ceiling = Number.isFinite(ceilingNumber) ? Math.max(-1000, Math.min(0, Math.floor(ceilingNumber))) : null;
    sources.push({
      id: text(building.id),
      templateId: text(building.templateId),
      name: building.name || "Здание",
      general,
      unrestOnly,
      ceiling,
      capacity,
      sourceKind: "building",
      workers: workforce.count,
      qd: workforce.qd
    });
    generalControl += general;
    unrestOnlyControl += unrestOnly;
  }

  const politics = includePolitics ? politicsRuntimeEffects(holding) : null;
  if (politics?.control || politics?.unrestControl) {
    sources.push({ id: "politics", name: "Политика", general: politics.control ?? 0,
      unrestOnly: politics.unrestControl ?? 0, ceiling: null, capacity: 0, sourceKind: "politics" });
    generalControl = Math.max(0, generalControl + (politics.control ?? 0));
    unrestOnlyControl += politics.unrestControl ?? 0;
  }

  // A stronger institution also supplies every weaker institutional ceiling.
  // The ceiling is settlement-wide only when the pooled capacity of this tier
  // and all stronger tiers covers the complete living population.
  let institutionalCeiling = null;
  const ceilingCoverage = [];
  for (const candidate of [-10, -5, -2, 0]) {
    const capacity = sources.reduce((sum, source) => (
      source.ceiling !== null && source.ceiling >= candidate ? sum + whole(source.capacity) : sum
    ), 0);
    const covered = population <= 0 || capacity >= population;
    ceilingCoverage.push({ ceiling: candidate, capacity, population, covered });
    if (covered) institutionalCeiling = candidate;
  }

  const numericRawMorale = Number.isFinite(Number(rawMorale)) ? Number(rawMorale) : 0;
  const disorderControl = Math.max(0, generalControl + unrestOnlyControl);
  const disorderMorale = institutionalCeiling === null || numericRawMorale >= institutionalCeiling
    ? numericRawMorale
    : Math.min(institutionalCeiling, numericRawMorale + disorderControl);
  const orderRequirement = Math.ceil(population / 10);
  const crimeDeficit = Math.max(0, orderRequirement - generalControl);
  const unrestDeficit = Math.max(0, orderRequirement - disorderControl);

  return {
    population,
    orderRequirement,
    generalControl,
    unrestOnlyControl,
    disorderControl,
    crimeDeficit,
    unrestDeficit,
    rawMorale: numericRawMorale,
    disorderMorale,
    institutionalCeiling,
    ceilingCoverage,
    sources
  };
}

export function controlIncidentSeverity(control = {}) {
  const morale = Number(control?.disorderMorale ?? control?.rawMorale ?? 0);
  if (morale < -30) return { level: 2, id: "riot", label: "бунт" };
  if (morale <= -15) return { level: 1, id: "sabotage", label: "саботаж" };
  return { level: 0, id: "theft", label: "кража или мелкое нарушение" };
}
