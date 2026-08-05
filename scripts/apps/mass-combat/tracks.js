import {
  ATTACK_METHODS,
  DEFENSE_MODES,
  OBJECTIVE_THRESHOLDS,
  ROUND_LIMITS,
  SCALES,
  STRATEGIES,
  asInt
} from "./rules.js";
import { buildingOperationalState } from "../../core/building-state.js";

function builtBuildingCount(holding) {
  return (holding?.buildings?.list ?? []).filter((building) => buildingOperationalState(building).operational).length;
}

export function lossTrack(label, steps, units, fallbackUnits = 1) {
  const totalUnits = Math.max(0, asInt(units, 0));
  const effectiveUnits = Math.max(1, totalUnits || fallbackUnits);
  const value = Math.max(0, asInt(steps, 0));
  const threshold = Math.max(3, effectiveUnits * 3);
  const percentValue = threshold ? value / threshold : 0;
  let state = "Боеспособны";
  let severity = "ok";
  if (value >= threshold) { state = "Сломлены"; severity = "critical"; }
  else if (percentValue >= 0.75) { state = "На грани"; severity = "danger"; }
  else if (percentValue >= 0.5) { state = "Тяжелые потери"; severity = "warning"; }
  else if (percentValue > 0) { state = "Потрясены"; severity = "low"; }
  return { label, value, threshold, units: effectiveUnits, broken: Math.floor(value / 3), shaken: value % 3, fresh: Math.max(0, effectiveUnits - Math.floor(value / 3)), state, severity, percent: Math.min(100, Math.round(percentValue * 100)), text: `${value}/${threshold}: ${state}.` };
}

export function damageContext(holding, state = {}, calcBase = {}) {
  const defenseMode = DEFENSE_MODES[state.defenseMode] ?? DEFENSE_MODES.behindWalls;
  const attackerStrategy = calcBase.attackerStrategy ?? STRATEGIES[state.attackerStrategy] ?? ATTACK_METHODS.frontalAssault;
  let target = "укрепления и окраина";
  let appliesTo = "выбери поврежденное место по цели врага";
  if (attackerStrategy.raid) { target = "склад, ворота, поле, причал, пленники или отдельное здание"; appliesTo = "сначала цель рейда, затем ближайшие здания и ресурсы"; }
  else if (attackerStrategy.breach) { target = "ворота, стены, башни, баррикады"; appliesTo = "сначала оборонные здания и укрепления"; }
  else if (defenseMode.factor <= 0) { target = "отряды и люди вне стен"; appliesTo = "меньше зданий, больше участников боя"; }
  return { target, appliesTo, participants: state.raiseMilitia === true ? "ополчение участвует: рискуют только реально поднятые ополченцы" : "рискуют отряды, гарнизоны и военные жители", defenseMode: defenseMode.label, mobilization: state.raiseMilitia === true ? "Стража + ополчение" : "Стража" };
}

export function damageTrack(holding, state = {}, calcBase = {}) {
  const damage = Math.max(0, asInt(state.settlementDamage, 0));
  const builtCount = builtBuildingCount(holding);
  const context = damageContext(holding, state, calcBase);
  const threshold = Math.max(4, 4 + Math.ceil((calcBase.fortificationDice ?? calcBase.fullFortressDice ?? 0) / 2) + Math.ceil(builtCount / 12));
  let stateLabel = "Цело";
  let severity = "ok";
  let instruction = `Урона нет. Зона риска: ${context.target}.`;
  if (damage >= threshold) { stateLabel = "Критический ущерб"; severity = "critical"; instruction = `Критический ущерб: ${context.appliesTo}.`; }
  else if (damage >= 4) { stateLabel = "Серьезный ущерб"; severity = "danger"; instruction = `Серьезное последствие: ${context.appliesTo}.`; }
  else if (damage >= 2) { stateLabel = "Малый ущерб"; severity = "warning"; instruction = `Малое последствие: ${context.target}.`; }
  else if (damage >= 1) { stateLabel = "Локальная проблема"; severity = "low"; instruction = `Один очаг проблемы: ${context.target}.`; }
  return { damage, threshold, minor: Math.floor(damage / 2), major: Math.floor(damage / 4), critical: Math.floor(damage / 6), state: stateLabel, severity, instruction, context, percent: Math.min(100, Math.round((damage / threshold) * 100)) };
}

export function objectiveTrack(state = {}, scale = SCALES.raid) {
  const key = String(state.scale || "raid");
  const value = Math.max(0, asInt(state.objectiveProgress, 0));
  const threshold = Math.max(1, asInt(state.objectiveThreshold, OBJECTIVE_THRESHOLDS[key] ?? 3));
  const round = Math.max(1, asInt(state.round, 1));
  const roundLimit = Math.max(1, asInt(state.roundLimit, ROUND_LIMITS[key] ?? 4));
  const done = value >= threshold;
  const outOfTime = round > roundLimit;
  const stateLabel = done ? "Цель достигнута" : outOfTime ? "Время вышло" : "В процессе";
  const instruction = done ? "Цель врага выполнена. Реши, что именно удалось: захват, грабеж, пожар, пленник, прорыв." : outOfTime ? "Раундов больше нормы. Враг отступает, меняет цель или идет на последний риск." : "Цель двигается только при победе атакующих в раунде. Базово: 1 + margin, затем метод атаки и план защиты.";
  return { value, threshold, round, roundLimit, done, outOfTime, state: stateLabel, instruction, percent: Math.min(100, Math.round((value / threshold) * 100)), scaleLabel: scale?.label ?? "" };
}
