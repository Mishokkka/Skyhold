import {
  ACCESS_MODES,
  ATTACK_METHODS,
  DEFENSE_MODES,
  DEFENSE_PLANS,
  ROUND_THREATS,
  SCALES,
  STRATEGIES,
  asInt,
  asNumber,
  commandPercentFromEffectiveness,
  toSigned
} from "./rules.js";
import { damageTrack, lossTrack, objectiveTrack } from "./tracks.js";
import { applyWeatherModifiers, weatherBattleModifier } from "./weather.js";
import {
  FULL_UNIT_EFFICIENCY,
  attackerSourcesFromState,
  autoDefenderProfile,
  buildManualDefenderSources,
  collectTags,
  defenseGarrisonProfile,
  finalizeSources,
  fortificationProfile,
  pooledDiceFromSources,
  riskSlotsFromSources,
  riskSummaryFromSlots,
  sourceDice,
  sourceRows
} from "./sources.js";
import {
  applyCommanderToSources,
  applyTagCounters,
  applyTagModifiers,
  defenseCommanderBonus,
  externalDice
} from "./modifiers.js";

export { damageContext } from "./tracks.js";
export { damageTrack, lossTrack, objectiveTrack };
export { weatherRulesCatalog } from "./weather.js";
export { commanderEffectiveness, defenseCommanderBonus } from "./modifiers.js";
export {
  autoDefenderProfile,
  builtBuildings,
  defenseGarrisonProfile,
  defenseSquadProfile,
  fortificationProfile,
  isDefenseBuilding
} from "./sources.js";
export {
  hasResidentWords,
  isAdultResident,
  isCommanderCandidate,
  isInjuredResident,
  isMilitaryBackgroundResident,
  isMilitaryResident,
  isSergeantCandidate,
  isSoldierResident,
  isSuitableForSquadType,
  personAssignmentText,
  personText,
  residentCombatTrait,
  soldierEfficiency,
  squadTypeProfile
} from "./residents.js";

function round1(value) { return Math.round(asNumber(value, 0) * 10) / 10; }
function round2(value) { return Math.round(asNumber(value, 0) * 100) / 100; }
function safeJoin(values = [], fallback = "нет") {
  const clean = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  return clean.length ? clean.join("; ") : fallback;
}
function pushBreakdown(parts, label, value, hint = "") {
  parts.push({ label, value, signed: value > 0 ? `+${round2(value)}` : String(round2(value)), hint });
}

export function inferRoundThreatKey(state = {}, attackerStrategy = {}) {
  const explicit = String(state.roundThreat ?? "");
  if (ROUND_THREATS[explicit]) return explicit;
  const strategyKey = String(state.attackerStrategy ?? "");
  if (strategyKey === "raidWithdraw" || attackerStrategy?.raid) return "raid";
  if (strategyKey === "sabotage") return "sabotage";
  if (strategyKey === "bombardment") return "fire";
  if (strategyKey === "breakthrough") return "assault";
  return "assault";
}

function calculationStepsFrom({ fieldDiceDefender, rawGarrisonDice, fieldDiceAttacker, defenderFieldPool, attackerFieldPool, defenderExternal, attackerExternal, defenderCommander, attackerCommandPercent, fortification, roundThreat, defenderCounterRows, attackerCounterRows, defenderPool, attackerPool }) {
  return [
    { key: "sources", label: "1. Источники", text: `отряды З ${fieldDiceDefender}к6 (${defenderFieldPool?.text ?? "нет"}), гарнизоны З ${rawGarrisonDice}к6, отряды В ${fieldDiceAttacker}к6 (${attackerFieldPool?.text ?? "нет"})` },
    { key: "threat", label: "2. Угроза раунда", text: roundThreat?.modifierHint ?? roundThreat?.hint ?? "без теговых модификаторов" },
    { key: "command", label: "3. Командиры", text: `защитники ${Math.round(asNumber(defenderCommander?.percent, 0) * 100)}%, враг ${Math.round(asNumber(attackerCommandPercent, 0) * 100)}% к эффективности` },
    { key: "counters", label: "4. Контры тегов", text: `${defenderCounterRows.length + attackerCounterRows.length} активных контр; базовая/сильная/полная контра режет на 25%/50%/75%, но не ниже 25% эффективности` },
    { key: "fort", label: "5. Укрепления", text: fortification?.text ?? "нет укреплений" },
    { key: "external", label: "6. Внешние кубы", text: `защитники ${toSigned(defenderExternal.dice)} (${safeJoin(defenderExternal.parts)}), враг ${toSigned(attackerExternal.dice)} (${safeJoin(attackerExternal.parts)})` },
    { key: "pool", label: "7. Итоговый пул", text: `защитники ${defenderPool}к6, нападающие ${attackerPool}к6` }
  ];
}

export function calculateBattle(holding, state = {}, {
  defenseTotal = 0,
  buildingEffectiveWorkers = null,
  calculateMorale = null
} = {}) {
  const defenderStrategyKey = state.defenderStrategy || "holdFortifications";
  const attackerStrategyKey = state.attackerStrategy || "frontalAssault";
  const defenderStrategy = { ...(STRATEGIES[defenderStrategyKey] ?? DEFENSE_PLANS.holdFortifications), key: defenderStrategyKey };
  const attackerStrategy = { ...(STRATEGIES[attackerStrategyKey] ?? ATTACK_METHODS.frontalAssault), key: attackerStrategyKey };
  const defenseMode = DEFENSE_MODES[state.defenseMode] ?? DEFENSE_MODES.behindWalls;
  const accessMode = ACCESS_MODES[state.accessMode] ?? ACCESS_MODES.normal;
  const scale = SCALES[state.scale] ?? SCALES.raid;
  const roundThreatKey = inferRoundThreatKey(state, attackerStrategy);
  const roundThreat = ROUND_THREATS[roundThreatKey] ?? ROUND_THREATS.assault;

  const autoDefenders = autoDefenderProfile(holding, state, { defenseTotal, buildingEffectiveWorkers, calculateMorale });
  const garrisonProfile = autoDefenders.garrisonProfile ?? defenseGarrisonProfile(holding, { buildingEffectiveWorkers });
  const manualDefenderSources = autoDefenders.manual ? buildManualDefenderSources(state) : [];
  let defenderFieldSources = autoDefenders.manual ? manualDefenderSources : [...(autoDefenders.sources ?? [])];
  let defenderGarrisonSources = [...(garrisonProfile.sources ?? [])];
  let attackerSources = attackerSourcesFromState(state);

  const hasOrganizedDefense = defenderFieldSources.length > 0 || defenderGarrisonSources.length > 0;
  const breachProgress = Math.max(0, asInt(state.breachProgress, 0));
  const breachThreshold = Math.max(2, Math.ceil((garrisonProfile.dice || 0) / 2) + 2);
  const breachOpen = breachProgress >= breachThreshold;
  const fortification = fortificationProfile(holding, state, { defenseTotal, hasDefenders: hasOrganizedDefense, breachOpen, garrisonProfile, defensePlan: defenderStrategy, attackMethod: attackerStrategy });

  applyTagModifiers(defenderFieldSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(defenderGarrisonSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(attackerSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(defenderFieldSources, defenderStrategy.tagMods, `План: ${defenderStrategy.label}`);
  applyTagModifiers(defenderGarrisonSources, defenderStrategy.tagMods, `План: ${defenderStrategy.label}`);
  applyTagModifiers(attackerSources, attackerStrategy.tagMods, `Метод: ${attackerStrategy.label}`);
  applyTagModifiers(defenderFieldSources, roundThreat.defenderTagMods, `Угроза: ${roundThreat.label}`);
  applyTagModifiers(defenderGarrisonSources, roundThreat.defenderTagMods, `Угроза: ${roundThreat.label}`);
  applyTagModifiers(attackerSources, roundThreat.attackerTagMods, `Угроза: ${roundThreat.label}`);

  const weather = weatherBattleModifier(holding, { defenderStrategy, attackerStrategy });
  applyWeatherModifiers(defenderFieldSources, weather, "defender", defenderStrategy);
  applyWeatherModifiers(defenderGarrisonSources, weather, "defender", defenderStrategy);
  applyWeatherModifiers(attackerSources, weather, "attacker", attackerStrategy);

  const defenderCommander = defenseCommanderBonus(holding, 0);
  applyCommanderToSources(defenderFieldSources, defenderCommander.percent, defenderCommander.label);
  applyCommanderToSources(defenderGarrisonSources, defenderCommander.percent, defenderCommander.label);
  const attackerCommandPercent = commandPercentFromEffectiveness(asNumber(state.attackerCommand, 0));
  applyCommanderToSources(attackerSources, attackerCommandPercent, `Командир врага +${Math.round(attackerCommandPercent * 100)}%`);

  for (const source of [...defenderFieldSources, ...defenderGarrisonSources, ...attackerSources]) source.preCounterEfficiency = Math.max(0, asNumber(source.currentEfficiency, 0));
  const defenderCounterRows = applyTagCounters([...defenderFieldSources, ...defenderGarrisonSources], attackerSources);
  const attackerCounterRows = applyTagCounters(attackerSources, [...defenderFieldSources, ...defenderGarrisonSources]);
  finalizeSources(defenderFieldSources);
  finalizeSources(defenderGarrisonSources);
  finalizeSources(attackerSources);

  // Полевые кубы считаются не по каждому отряду отдельно, а из суммы округленной эффективности.
  // Так два отряда с 3 и 2 эффективности дают один общий куб, а риск этого куба делится между вкладчиками.
  const defenderFieldPool = pooledDiceFromSources(defenderFieldSources, { side: "defender", threshold: FULL_UNIT_EFFICIENCY });
  const attackerFieldPool = pooledDiceFromSources(attackerSources, { side: "attacker", threshold: FULL_UNIT_EFFICIENCY });
  const fieldDiceDefender = defenderFieldPool.dice;
  const fieldDiceAttacker = attackerFieldPool.dice;
  const rawGarrisonDice = defenderGarrisonSources.reduce((sum, source) => sum + (source.dice ?? sourceDice(source)), 0);
  const garrisonDice = Math.min(rawGarrisonDice, fortification.dice);

  const defenderExternal = externalDice(state, "defender");
  const attackerExternal = externalDice(state, "attacker", accessMode, attackerSources);
  const defenderPool = Math.max(0, fieldDiceDefender + garrisonDice + defenderExternal.dice);
  const attackerPool = Math.max(0, fieldDiceAttacker + attackerExternal.dice);

  const defenderEffective = round2([...defenderFieldSources, ...defenderGarrisonSources].reduce((sum, source) => sum + source.currentEfficiency, 0));
  const attackerEffective = round2(attackerSources.reduce((sum, source) => sum + source.currentEfficiency, 0));
  const defenderBaseEffective = round2([...defenderFieldSources, ...defenderGarrisonSources].reduce((sum, source) => sum + source.baseEfficiency, 0));
  const attackerBaseEffective = round2(attackerSources.reduce((sum, source) => sum + source.baseEfficiency, 0));

  const effectiveState = { ...state };
  Object.assign(effectiveState, {
    defenderUnits: defenderFieldSources.length,
    defenderBS: defenderBaseEffective,
    defenderCommand: round1(defenderCommander.effectiveness),
    defenderMorale: asInt(state.defenderMorale, autoDefenders.morale ?? 0),
    attackerUnits: attackerSources.length,
    attackerBS: attackerBaseEffective
  });
  for (const [key, value] of Object.entries(collectTags([...defenderFieldSources, ...defenderGarrisonSources]))) effectiveState[`defender${key[0].toUpperCase()}${key.slice(1)}`] = value;
  for (const [key, value] of Object.entries(collectTags(attackerSources))) effectiveState[`attacker${key[0].toUpperCase()}${key.slice(1)}`] = value;

  const defenderParts = [];
  pushBreakdown(defenderParts, "Отряды", fieldDiceDefender, defenderFieldPool.text);
  pushBreakdown(defenderParts, "Гарнизоны", garrisonDice, fortification.text);
  pushBreakdown(defenderParts, "Внешнее", defenderExternal.dice, defenderExternal.parts.join(", ") || "нет");
  const attackerParts = [];
  pushBreakdown(attackerParts, "Отряды", fieldDiceAttacker, attackerFieldPool.text);
  pushBreakdown(attackerParts, "Внешнее", attackerExternal.dice, attackerExternal.parts.join(", ") || "нет");

  const sourceCards = [
    { key: "field", label: "Полевые отряды", icon: "fa-solid fa-people-group", defender: fieldDiceDefender, attacker: fieldDiceAttacker, defenderText: `${fieldDiceDefender}к6`, attackerText: `${fieldDiceAttacker}к6`, hint: `Округленная эффективность полевых отрядов суммируется: З ${defenderFieldPool.text}; В ${attackerFieldPool.text}.` },
    { key: "garrison", label: "Гарнизоны", icon: "fa-solid fa-tower-observation", defender: garrisonDice, attacker: 0, defenderText: `${garrisonDice}к6`, attackerText: "-", hint: fortification.text },
    { key: "command", label: "Командиры", icon: "fa-solid fa-user-tie", defender: defenderCommander.percent, attacker: attackerCommandPercent, defenderText: `${Math.round(defenderCommander.percent * 100)}%`, attackerText: `${Math.round(attackerCommandPercent * 100)}%`, hint: "Командиры дают процент к эффективности, а не сырые кубы." },
    { key: "external", label: "Внешнее", icon: "fa-solid fa-sliders", defender: defenderExternal.dice, attacker: attackerExternal.dice, defenderText: toSigned(defenderExternal.dice), attackerText: toSigned(attackerExternal.dice), hint: `Герои, мораль, позиция, особое, доступ врага. Погода меняет эффективность: ${weather.tooltip}` },
    { key: "counters", isCounters: true, label: "Контры тегов", icon: "fa-solid fa-tags", defender: defenderCounterRows.length, attacker: attackerCounterRows.length, defenderText: `${defenderCounterRows.length}`, attackerText: `${attackerCounterRows.length}`, hint: [...defenderCounterRows, ...attackerCounterRows].map((row) => row.text).join("; ") || "активных контр нет" }
  ];

  const calculationSteps = calculationStepsFrom({ fieldDiceDefender, rawGarrisonDice, garrisonDice, fieldDiceAttacker, defenderFieldPool, attackerFieldPool, defenderExternal, attackerExternal, defenderCommander, attackerCommandPercent, fortification, roundThreat, defenderCounterRows, attackerCounterRows, defenderPool, attackerPool });
  const garrisonRiskSlots = riskSlotsFromSources(defenderGarrisonSources).slice(0, garrisonDice);
  const partialMilitiaIds = Array.isArray(autoDefenders?.militiaPartialIds) ? autoDefenders.militiaPartialIds.map((id) => String(id ?? "")).filter(Boolean) : [];
  const partialMilitiaRiskSlot = partialMilitiaIds.length ? [{
    sourceId: "militia-partial",
    sourceLabel: `Неполное ополчение (${partialMilitiaIds.length} чел.)`,
    type: "militia",
    participantIds: partialMilitiaIds,
    weight: Math.max(1, asNumber(autoDefenders?.militiaThreshold, 20) / 10),
    exposure: "civilian",
    partial: true
  }] : [];
  const reserveIds = breachOpen && Array.isArray(autoDefenders?.militiaReserveIds)
    ? autoDefenders.militiaReserveIds.map((id) => String(id ?? "")).filter(Boolean)
    : [];
  const reserveRiskSlot = reserveIds.length ? [{
    sourceId: "militia-reserve",
    sourceLabel: `Резерв под угрозой (${reserveIds.length} чел.)`,
    type: "reserve",
    participantIds: reserveIds,
    weight: 0.5,
    exposure: "reserve"
  }] : [];
  const defenderRiskSlots = [...defenderFieldPool.slots, ...garrisonRiskSlots, ...partialMilitiaRiskSlot, ...reserveRiskSlot];
  const attackerRiskSlots = attackerFieldPool.slots;
  const defenderRiskSummary = riskSummaryFromSlots(defenderRiskSlots);
  const attackerRiskSummary = riskSummaryFromSlots(attackerRiskSlots);

  const scaleBase = Math.max(1, asInt(scale.loss, 1));
  const lossModel = {
    attackerToDefender: asNumber(attackerStrategy.inflictedImpact, 1) * asNumber(defenderStrategy.takenImpact, 1) * scaleBase,
    defenderToAttacker: asNumber(defenderStrategy.inflictedImpact, 1) * asNumber(attackerStrategy.takenImpact, 1) * scaleBase,
    building: asNumber(attackerStrategy.buildingImpact, 1) * asNumber(defenderStrategy.buildingRisk, 1) * Math.max(1, asNumber(scale.damage, 1)),
    protectCivilians: asNumber(defenderStrategy.protectCivilians, 0)
  };
  const impactPreview = [
    { label: "Успехи врага", value: `×${round2(lossModel.attackerToDefender)}`, text: "каждый успех нападающих превращается в Impact по защитникам, затем выбираются слоты риска" },
    { label: "Успехи защитников", value: `×${round2(lossModel.defenderToAttacker)}`, text: "каждый успех защитников превращается в Impact по врагу" },
    { label: "Урон владению", value: `×${round2(lossModel.building)}`, text: "применяется, когда метод/исход раунда бьёт по зданиям, укреплениям или цели" },
    { label: "Защита гражданских", value: `${Math.round(asNumber(lossModel.protectCivilians, 0) * 100)}%`, text: "план защиты может переводить риск с гражданских на боевые источники" }
  ];

  const defenderLossTrack = lossTrack("Защитники", state.defenderLossSteps ?? state.defenderLosses, Math.max(1, defenderFieldSources.length + defenderGarrisonSources.length));
  const attackerLossTrack = lossTrack("Нападающие", state.attackerLossSteps ?? state.attackerLosses, Math.max(1, attackerSources.length));
  const currentDamageTrack = damageTrack(holding, state, { fortificationDice: garrisonDice, attackerStrategy, breachOpen });
  const currentObjectiveTrack = objectiveTrack(state, scale);

  return {
    defenderPool,
    attackerPool,
    defenderUnits: defenderFieldSources.length,
    attackerUnits: attackerSources.length,
    defenderBS: defenderBaseEffective,
    attackerBS: attackerBaseEffective,
    defenderEffective,
    attackerEffective,
    defenderFieldDice: fieldDiceDefender,
    defenderGarrisonDice: garrisonDice,
    attackerFieldDice: fieldDiceAttacker,
    fortificationDice: garrisonDice,
    fullFortressDice: rawGarrisonDice,
    fieldSources: { defender: defenderFieldSources, attacker: attackerSources },
    garrisonSources: defenderGarrisonSources,
    allDefenderSources: [...defenderFieldSources, ...defenderGarrisonSources],
    defenderRiskSlots,
    attackerRiskSlots,
    defenderFieldPool,
    attackerFieldPool,
    defenderRiskSummary,
    attackerRiskSummary,
    attackerSources,
    defenderSourceRows: sourceRows([...defenderFieldSources, ...defenderGarrisonSources]),
    attackerSourceRows: sourceRows(attackerSources),
    calculationSteps,
    impactPreview,
    defenderCounterRows,
    attackerCounterRows,
    counterRows: [...defenderCounterRows, ...attackerCounterRows],
    weather,
    sourceCards,
    defenderParts,
    attackerParts,
    defenderStrategy,
    attackerStrategy,
    defenseMode,
    accessMode,
    scale,
    roundThreatKey,
    roundThreat,
    autoDefenders,
    garrisonProfile,
    fortification,
    defenseCommander: defenderCommander,
    attackerCommand: { percent: attackerCommandPercent, effectiveness: asNumber(state.attackerCommand, 0), label: `Командир врага: +${Math.round(attackerCommandPercent * 100)}%` },
    lossModel,
    defenderLossTrack,
    attackerLossTrack,
    damageTrack: currentDamageTrack,
    objectiveTrack: currentObjectiveTrack,
    breachProgress,
    breachThreshold,
    breachOpen,
    effectiveState,
    deterrence: deterrenceText(fieldDiceDefender + garrisonDice, fieldDiceAttacker, garrisonDice)
  };
}

export function deterrenceText(defenderCombatDice, attackerCombatDice, fortificationDice) {
  const defender = asInt(defenderCombatDice, 0);
  const attacker = asInt(attackerCombatDice, 0);
  const fort = asInt(fortificationDice, 0);
  if (!defender && !attacker) return "Силы не выставлены.";
  if (defender >= attacker + 3) return `Оборона выглядит сильной: ${defender}к6 против ${attacker}к6, укрепления ${fort}к6.`;
  if (attacker >= defender + 3) return `Нападающие давят числом/качеством: ${attacker}к6 против ${defender}к6.`;
  return `Раунд близкий: ${defender}к6 против ${attacker}к6. Решат планы, теги и удача.`;
}
