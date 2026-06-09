import { asInt, asNumber, clamp } from "./rules.js";

function scaledImpact(successes, factor = 1) {
  const base = Math.max(0, asInt(successes, 0));
  if (!base) return 0;
  const value = base * Math.max(0, asNumber(factor, 1));
  const floor = Math.floor(value);
  const fraction = value - floor;
  return floor + (fraction > 0 && Math.random() < fraction ? 1 : 0);
}

function attackerHasObjectiveAccess(calc = {}, state = {}) {
  const method = calc.attackerStrategy ?? {};
  if (method.raid) return true;
  if (calc.breachOpen) return true;
  if (calc.defenseMode?.factor <= 0) return true;
  const objectiveText = String(state.objective ?? "").toLowerCase();
  if (/(рейд|граб|плен|подж|укра|развед|убить|похит|склад|поле|причал|окраин)/i.test(objectiveText)) return true;
  return false;
}

export function roundConsequences(resultOrMargin, calc = {}, state = {}) {
  const data = typeof resultOrMargin === "object" ? resultOrMargin : { margin: asInt(resultOrMargin, 0) };
  const margin = asInt(data.margin, 0);
  const defenderSuccesses = Math.max(0, asInt(data.defenderSuccesses, 0));
  const attackerSuccesses = Math.max(0, asInt(data.attackerSuccesses, 0));
  const lossModel = calc.lossModel ?? {};
  const attackerImpact = attackerSuccesses;
  const defenderImpact = defenderSuccesses;
  let defenderLossDelta = scaledImpact(attackerImpact, lossModel.attackerToDefender ?? 1);
  let attackerLossDelta = scaledImpact(defenderImpact, lossModel.defenderToAttacker ?? 1);

  const attackerWins = margin < 0;
  const defenderWins = margin > 0;
  const draw = margin === 0;
  const attackerMargin = Math.abs(Math.min(0, margin));
  const defenderMargin = Math.max(0, margin);
  const method = calc.attackerStrategy ?? {};
  const plan = calc.defenderStrategy ?? {};
  let objectiveDelta = 0;
  let breachDelta = 0;
  let settlementDamageDelta = 0;
  let defenderPositionDelta = 0;
  let attackerPositionDelta = 0;

  if (attackerWins) {
    const access = attackerHasObjectiveAccess(calc, state);
    const baseObjective = access ? 1 + attackerMargin : 0;
    objectiveDelta = Math.max(0, baseObjective + asInt(method.objectiveBonus, 0) - asInt(plan.objectiveResist, 0));
    if (method.objectiveCap !== undefined) objectiveDelta = Math.min(objectiveDelta, Math.max(0, asInt(method.objectiveCap, 0)));
    breachDelta = Math.max(0, (method.breach || !access) ? 1 + Math.max(0, attackerMargin - 1) + asInt(method.breachBonus, 0) : asInt(method.breachBonus, 0));
    settlementDamageDelta = scaledImpact(Math.max(1, Math.ceil(attackerImpact / 2)), lossModel.building ?? 1);
    defenderPositionDelta = -1;
    attackerPositionDelta = method.raid ? 0 : 1;
  } else if (defenderWins) {
    objectiveDelta = Math.min(0, asInt(plan.objectiveResist, 0) > 0 ? -1 : 0);
    breachDelta = 0;
    settlementDamageDelta = method.breach ? scaledImpact(Math.max(0, Math.floor(attackerImpact / 3)), lossModel.building ?? 1) : 0;
    defenderPositionDelta = plan.retreat ? -1 : 1;
    attackerPositionDelta = -1;
    attackerLossDelta += Math.max(0, Math.floor(defenderMargin / 2));
  } else if (draw) {
    settlementDamageDelta = method.breach || method.raid ? scaledImpact(Math.floor(attackerImpact / 3), lossModel.building ?? 1) : 0;
    breachDelta = method.breach ? 1 : 0;
  }

  if (plan.retreat && attackerWins) objectiveDelta += 1;
  if (state.raiseMilitia === true && defenderLossDelta > 0 && asNumber(lossModel.protectCivilians, 0) >= 0.9) defenderLossDelta = Math.max(1, Math.floor(defenderLossDelta * 0.75));

  const result = defenderWins
    ? `Защитники выигрывают раунд: враг получает ${attackerLossDelta} Impact и теряет темп.`
    : attackerWins
      ? `Нападающие выигрывают раунд: защитники получают ${defenderLossDelta} Impact, цель движется на ${objectiveDelta}.`
      : `Ничья: позиция удержана, но стороны обмениваются Impact.`;

  return {
    result,
    defenderLossDelta: Math.max(0, defenderLossDelta),
    attackerLossDelta: Math.max(0, attackerLossDelta),
    settlementDamageDelta: Math.max(0, settlementDamageDelta),
    breachDelta: Math.max(0, breachDelta),
    objectiveDelta,
    defenderPositionDelta: clamp(defenderPositionDelta, -1, 1),
    attackerPositionDelta: clamp(attackerPositionDelta, -1, 1),
    defenderImpact: attackerImpact,
    attackerImpact: defenderImpact
  };
}
