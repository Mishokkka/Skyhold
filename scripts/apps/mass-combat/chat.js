import { escapeHtml } from "../../core/helpers.js";
import { asInt, asNumber } from "./rules.js";

export function shortDiceLine(rolls = [], successes = 0) {
  const count = Array.isArray(rolls) ? rolls.length : 0;
  const n = asInt(successes, 0);
  const word = n === 1 ? "успех" : (n >= 2 && n <= 4 ? "успеха" : "успехов");
  return `${n} ${word}${count ? ` из ${count}к6` : ""}`;
}

function rollList(rolls = []) {
  if (!Array.isArray(rolls) || !rolls.length) return "-";
  return rolls.map((value) => Number(value) === 6 ? `<b>${value}</b>` : String(value)).join(", ");
}

function compactCounters(calc = {}) {
  const rows = Array.isArray(calc.counterRows) ? calc.counterRows : [];
  if (!rows.length) return "";
  return `<p class="fbls-battle-chat-counters"><strong>Контры:</strong> ${rows.slice(0, 4).map((row) => escapeHtml(row.text ?? "")).join("; ")}${rows.length > 4 ? `; ещё ${rows.length - 4}` : ""}.</p>`;
}

export function compactSources(calc = {}) {
  return (calc.sourceCards ?? [])
    .filter((row) => asNumber(row.defender, 0) || asNumber(row.attacker, 0))
    .map((row) => `<span title="${escapeHtml(row.hint ?? "")}"><i class="${escapeHtml(row.icon ?? "fa-solid fa-circle")}"></i> ${escapeHtml(row.label)} <b>${escapeHtml(row.defenderText)} / ${escapeHtml(row.attackerText)}</b></span>`)
    .join("");
}

export function roundChatContent(app, holding, state, calc, result) {
  const title = state.title || `Битва за владение: ${holding.name || "владение"}`;
  const breachLine = calc.breachThreshold > 0 ? `${asInt(state.breachProgress, 0)}/${calc.breachThreshold}` : "-";
  const defenderLossTrack = app._lossTrack("Защитники", state.defenderLossSteps ?? state.defenderLosses, calc.defenderUnits);
  const attackerLossTrack = app._lossTrack("Нападающие", state.attackerLossSteps ?? state.attackerLosses, calc.attackerUnits);
  const damageTrack = app._damageTrack(holding, state, calc);
  const objectiveTrack = app._objectiveTrack(state, calc.scale);
  const sources = compactSources(calc);
  return `
    <div class="fbls-chat-card fbls-battle-chat">
      <h3>${escapeHtml(title)} · раунд ${result.round}</h3>
      <p><strong>${escapeHtml(calc.roundThreat?.label ?? "Штурм")}</strong> · цель: ${escapeHtml(state.objective || "не задана")} · ${escapeHtml(calc.scale.label)}</p>
      <div class="fbls-battle-chat-pools">
        <div><strong>Защитники</strong><b>${calc.defenderPool}к6</b><span>${shortDiceLine(result.defenderRolls, result.defenderSuccesses)}</span><em>${rollList(result.defenderRolls)}</em></div>
        <div><strong>${escapeHtml(state.enemyName || "Нападающие")}</strong><b>${calc.attackerPool}к6</b><span>${shortDiceLine(result.attackerRolls, result.attackerSuccesses)}</span><em>${rollList(result.attackerRolls)}</em></div>
      </div>
      ${sources ? `<p class="fbls-battle-chat-sources">${sources}</p>` : ""}
      ${compactCounters(calc)}
      <p><strong>Impact:</strong> по защитникам ${asInt(result.defenderImpact ?? result.defenderLossDelta, 0)}, по врагу ${asInt(result.attackerImpact ?? result.attackerLossDelta, 0)}. Итоговые потери меняются методами, планами и масштабом.</p>
      <p><strong>Итог:</strong> ${result.margin > 0 ? "+" : ""}${result.margin}. ${escapeHtml(result.result)}</p>
      <p><strong>Сдвиги:</strong> потери З +${result.defenderLossDelta}, В +${result.attackerLossDelta}; урон +${result.settlementDamageDelta}; брешь +${result.breachDelta}; часы цели ${result.objectiveDelta > 0 ? "+" : ""}${result.objectiveDelta}.</p>
      ${result.casualtyText ? `<p><strong>Потери жителей:</strong> ${escapeHtml(result.casualtyText)}</p>` : ""}
      ${result.damageText ? `<p><strong>Повреждения:</strong> ${escapeHtml(result.damageText)}</p>` : ""}
      <p class="fbls-battle-chat-foot"><strong>Треки:</strong> З ${asInt(state.defenderLossSteps ?? state.defenderLosses, 0)}/${defenderLossTrack.threshold}; В ${asInt(state.attackerLossSteps ?? state.attackerLosses, 0)}/${attackerLossTrack.threshold}; урон ${asInt(state.settlementDamage, 0)}/${damageTrack.threshold}; брешь ${breachLine}; цель ${asInt(state.objectiveProgress, 0)}/${objectiveTrack.threshold}.</p>
    </div>
  `;
}
