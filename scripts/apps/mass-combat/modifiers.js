import {
  asInt,
  asNumber,
  clamp,
  commandPercentFromEffectiveness,
  toSigned
} from "./rules.js";
import { getMassCombatTagCounters, tagLabel } from "./tag-config.js";
import { isInjuredResident, isMilitaryBackgroundResident, personText } from "./residents.js";
import { hasTag } from "./sources.js";

function round1(value) {
  return Math.round(asNumber(value, 0) * 10) / 10;
}

function round2(value) {
  return Math.round(asNumber(value, 0) * 100) / 100;
}

function pct(value) {
  return `${Math.round(asNumber(value, 0) * 100)}%`;
}

export function commanderEffectiveness(person = {}) {
  if (!person || person.dead || isInjuredResident(person)) return 0;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const wits = asNumber(attrs.wits, 0);
  const empathy = asNumber(attrs.empathy, 0);
  let value = (wits + empathy) / 2;
  if (isMilitaryBackgroundResident(person)) value += 1;
  if (/(лидер|командир|офицер|тактик|стратег|харизмат|авторитет|leader|commander|officer|tactician|strategist)/i.test(personText(person))) value += 1;
  return clamp(round2(value), 0, 5);
}

export function defenseCommanderBonus(holding, armyDice = 0) {
  const id = String(holding?.gm?.defense?.commanderId ?? "");
  if (!id) return { value: 0, raw: 0, cap: 0, percent: 0, effectiveness: 0, label: "командир не назначен" };
  const commander = (holding?.people?.list ?? []).find((person) => String(person.id) === id && !person?.dead && !isInjuredResident(person));
  if (!commander) return { value: 0, raw: 0, cap: 0, percent: 0, effectiveness: 0, label: "командир недоступен" };
  const effectiveness = commanderEffectiveness(commander);
  const percent = commandPercentFromEffectiveness(effectiveness);
  const value = Math.max(0, Math.ceil(asNumber(armyDice, 0) * percent - 1e-9));
  return {
    value,
    raw: value,
    cap: value,
    percent,
    effectiveness,
    label: `${commander.name || "Командир"}: ${round1(effectiveness)}/5, +${Math.round(percent * 100)}% к эффективности армии`
  };
}

export function applyTagModifiers(sources = [], modifiers = {}, reason = "") {
  for (const source of sources) {
    let total = 0;
    const applied = [];
    for (const [tag, mod] of Object.entries(modifiers ?? {})) {
      if (!hasTag(source, tag)) continue;
      total += asNumber(mod, 0);
      applied.push(`${tagLabel(tag)} ${pct(mod)}`);
    }
    if (!total) continue;
    applyPercentModifier(source, total);
    source.modifiers.push(`${reason}: ${applied.join(", ")}`);
  }
  return sources;
}

export function applyPercentModifier(source, percent = 0) {
  if (!source) return source;
  const modifier = asNumber(percent, 0);
  if (!modifier) return source;
  if (!Number.isFinite(Number(source.modifierBaseEfficiency))) {
    source.modifierBaseEfficiency = Math.max(0, asNumber(source.baseEfficiency, source.currentEfficiency));
  }
  source.modifierPercent = asNumber(source.modifierPercent, 0) + modifier;
  source.currentEfficiency = Math.max(0, source.modifierBaseEfficiency * (1 + source.modifierPercent));
  return source;
}

export function applyCommanderToSources(sources = [], percent = 0, label = "Командир") {
  const modifier = asNumber(percent, 0);
  if (!modifier) return sources;
  for (const source of sources) {
    applyPercentModifier(source, modifier);
    source.modifiers.push(`${label}: ${pct(modifier)}`);
  }
  return sources;
}

export function applyTagCounters(ownSources = [], enemySources = []) {
  const rows = [];
  const usedCounters = new Set();
  const candidates = [];
  for (const own of ownSources) {
    if (!own.full || own.currentEfficiency <= 0) continue;
    const ownTags = Object.keys(own.tags ?? {}).filter((tag) => asNumber(own.tags[tag], 0) > 0);
    for (const ownTag of ownTags) {
      const matrix = getMassCombatTagCounters()[ownTag] ?? {};
      for (const enemy of enemySources) {
        if (!enemy.full || enemy.currentEfficiency <= 0) continue;
        let reduction = 0;
        let targetTag = "";
        for (const [tag, percent] of Object.entries(matrix)) {
          if (!hasTag(enemy, tag)) continue;
          const value = enemy.currentEfficiency * percent;
          if (value > reduction) {
            reduction = value;
            targetTag = tag;
          }
        }
        if (reduction > 0) candidates.push({ own, enemy, ownTag, targetTag, reduction });
      }
    }
  }
  candidates.sort((a, b) => b.reduction - a.reduction);
  for (const candidate of candidates) {
    if (usedCounters.has(candidate.own.id)) continue;
    const beforeCounter = candidate.enemy.preCounterEfficiency || candidate.enemy.currentEfficiency;
    const maxLoss = beforeCounter * 0.75;
    const already = candidate.enemy.counterLoss || 0;
    const allowed = Math.max(0, maxLoss - already);
    const amount = Math.min(allowed, candidate.reduction);
    if (amount <= 0) continue;
    candidate.enemy.currentEfficiency = Math.max(beforeCounter * 0.25, candidate.enemy.currentEfficiency - amount);
    candidate.enemy.counterLoss = already + amount;
    candidate.enemy.modifiers.push(`Контра: ${tagLabel(candidate.ownTag)} против ${tagLabel(candidate.targetTag)}, -${round1(amount)} эфф.`);
    usedCounters.add(candidate.own.id);
    rows.push({
      source: candidate.own.label,
      target: candidate.enemy.label,
      sourceTag: candidate.ownTag,
      targetTag: candidate.targetTag,
      percent: Math.round((amount / Math.max(0.0001, beforeCounter)) * 100),
      amount: round2(amount),
      text: `${candidate.own.label}: ${tagLabel(candidate.ownTag)} снижает ${candidate.enemy.label} (${tagLabel(candidate.targetTag)}) на ${round1(amount)} эфф. (${Math.round((amount / Math.max(0.0001, beforeCounter)) * 100)}%).`
    });
  }
  return rows;
}

export function externalDice(state = {}, side = "defender", access = null, sources = []) {
  const prefix = side === "defender" ? "defender" : "attacker";
  let dice = 0;
  dice += asInt(state?.[`${prefix}Hero`], 0);
  dice += side === "defender" ? asInt(state?.defenderMorale, 0) : 0;
  dice += asInt(state?.[`${prefix}Position`], 0);
  dice += asInt(state?.[`${prefix}Special`], 0);
  const parts = [];
  if (asInt(state?.[`${prefix}Hero`], 0)) parts.push(`герои ${toSigned(asInt(state?.[`${prefix}Hero`], 0))}`);
  if (side === "defender" && asInt(state?.defenderMorale, 0)) parts.push(`мораль ${toSigned(asInt(state?.defenderMorale, 0))}`);
  if (asInt(state?.[`${prefix}Position`], 0)) parts.push(`позиция ${toSigned(asInt(state?.[`${prefix}Position`], 0))}`);
  if (asInt(state?.[`${prefix}Special`], 0)) parts.push(`особое ${toSigned(asInt(state?.[`${prefix}Special`], 0))}`);
  if (side === "attacker" && access?.penalty) {
    const helpfulTags = (access.helps ?? []).filter((tag) => sources.some((source) => hasTag(source, tag)));
    const penalty = helpfulTags.length ? 0 : asInt(access.penalty, 0);
    dice += penalty;
    parts.push(helpfulTags.length
      ? `доступ обеспечен: ${helpfulTags.map((tag) => tagLabel(tag)).join(", ")}`
      : `доступ ${toSigned(penalty)}`);
  }
  return { dice, parts };
}
