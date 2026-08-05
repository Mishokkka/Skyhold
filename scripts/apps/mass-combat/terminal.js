import { asInt } from "./rules.js";

function reached(track = {}) {
  const threshold = Math.max(1, asInt(track?.threshold, 1));
  return asInt(track?.value, 0) >= threshold;
}

export function battleTerminalState(_state = {}, calc = {}) {
  const defenderBroken = reached(calc?.defenderLossTrack);
  const attackerBroken = reached(calc?.attackerLossTrack);
  const objectiveDone = Boolean(calc?.objectiveTrack?.done);
  const outOfTime = Boolean(calc?.objectiveTrack?.outOfTime);
  const attackerWon = defenderBroken || objectiveDone;
  const defenderWon = attackerBroken || (outOfTime && !attackerWon);
  const finished = attackerWon || defenderWon;

  const reasons = [];
  if (objectiveDone) reasons.push({ key: "objective", label: "цель нападающих достигнута" });
  if (defenderBroken) reasons.push({ key: "defender-broken", label: "защитники сломлены" });
  if (attackerBroken) reasons.push({ key: "attacker-broken", label: "нападающие сломлены" });
  if (outOfTime && !attackerWon) reasons.push({ key: "out-of-time", label: "лимит раундов исчерпан" });

  let outcome = "active";
  let label = "Бой продолжается";
  let severity = "active";
  if (attackerWon && defenderWon) {
    outcome = "contested";
    label = "Спорный исход";
    severity = "contested";
  } else if (attackerWon) {
    outcome = "attacker-victory";
    label = "Победа нападающих";
    severity = "attacker";
  } else if (defenderWon) {
    outcome = "defender-victory";
    label = "Победа защитников";
    severity = "defender";
  }

  const reason = reasons.map((entry) => entry.label).join("; ");
  return {
    finished,
    outcome,
    label,
    severity,
    reason,
    reasons,
    defenderBroken,
    attackerBroken,
    objectiveDone,
    outOfTime,
    title: finished
      ? `${label}${reason ? `: ${reason}` : ""}. Новый раунд заблокирован; скорректируйте треки или сбросьте бой.`
      : "Бросить текущий раунд и применить последствия."
  };
}
