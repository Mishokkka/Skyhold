import { buildingOperationalState } from "../../core/building-state.js";
import { moraleBandForScore } from "../../engines/morale/morale-snapshot.js";
import {
  ATTACK_METHODS,
  DEFENDER_MOBILIZATIONS,
  DEFENSE_MODES,
  DEFENSE_PLANS,
  asInt,
  asNumber,
  militiaQualityText,
  militiaThreshold,
  tagValue
} from "./rules.js";
import { getMassCombatRelationTags, getMassCombatTags, getMassCombatUnitTagKeys, tagLabel } from "./tag-config.js";
import {
  isAdultResident,
  isInjuredResident,
  isMilitaryResident,
  isSergeantCandidate,
  isSoldierResident,
  soldierEfficiency,
  squadTypeProfile
} from "./residents.js";

export const FULL_UNIT_EFFICIENCY = 5;
const DEFAULT_GARRISON_THRESHOLD = 4;
const SOURCE_TYPE_LABELS = {
  regular: "Отряд",
  militia: "Ополчение",
  garrison: "Гарнизон",
  manual: "Ручной отряд",
  mixed: "Сводный куб"
};

function round1(value) {
  return Math.round(asNumber(value, 0) * 10) / 10;
}

function round2(value) {
  return Math.round(asNumber(value, 0) * 100) / 100;
}

function roundEff(value) {
  return Math.max(0, Math.round(asNumber(value, 0)));
}

function sourceTypeLabel(type = "regular") {
  return SOURCE_TYPE_LABELS[String(type)] ?? "Источник";
}

function sourceStatus(source = {}) {
  if (source.type === "garrison") return source.dice > 0 ? { label: "даёт кубы", css: "ok" } : { label: "не укомплектован", css: "low" };
  if (!source.full) return { label: "ниже 5 эфф.", css: "low" };
  if (asNumber(source.counterLoss, 0) > 0) return { label: "законтрен", css: "warning" };
  return { label: "полный", css: "ok" };
}

function tagsText(tags = {}) {
  return Object.entries(tags ?? {})
    .filter(([, value]) => asNumber(value, 0) > 0)
    .map(([key, value]) => `${tagLabel(key)}${asNumber(value, 0) > 1 ? ` ×${round1(value)}` : ""}`)
    .join(", ") || "-";
}

function safeJoin(values = [], fallback = "нет") {
  const clean = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  return clean.length ? clean.join("; ") : fallback;
}

function pct(value) {
  return `${Math.round(asNumber(value, 0) * 100)}%`;
}

function singleTag(tags = {}, fallback = "") {
  const activeTags = getMassCombatRelationTags();
  const ranked = Object.entries(tags ?? {})
    .map(([key, value], order) => ({ key, value: Math.max(0, asNumber(value, 0)), order }))
    .filter((row) => activeTags[row.key] && row.value > 0)
    .sort((a, b) => b.value - a.value || a.order - b.order);
  const key = ranked[0]?.key ?? (activeTags[fallback] ? fallback : "");
  return key ? { [key]: 1 } : {};
}

function cloneTags(tags = {}, fallback = "") {
  return singleTag(tags, fallback);
}

export function hasTag(source, tag) {
  return asNumber(source?.tags?.[tag], 0) > 0;
}

function primaryTag(tags = {}) {
  let best = "infantry";
  let bestValue = -1;
  for (const [key, value] of Object.entries(tags ?? {})) {
    const number = asNumber(value, 0);
    if (number > bestValue) {
      best = key;
      bestValue = number;
    }
  }
  return best;
}

function tagsWithManualPrimary(templateTags = {}, manualPrimaryTag = "") {
  const template = cloneTags(templateTags, "infantry");
  const manual = String(manualPrimaryTag ?? "").trim();
  if (!manual || !getMassCombatTags()[manual]) return template;
  return { [manual]: 1 };
}

export function builtBuildings(holding) {
  return (holding?.buildings?.list ?? []).filter((building) => buildingOperationalState(building).operational);
}

export function isDefenseBuilding(building) {
  const functions = building?.functions && typeof building.functions === "object" ? building.functions : {};
  const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
  const base = asNumber(defense.base, 0);
  const perStep = asNumber(defense.perStep, 0);
  const maxDice = asNumber(defense.maxDice, 0);
  return Boolean(functions.defense || base > 0 || perStep > 0 || maxDice > 0);
}

export function makeSource({ side, type, id, label, baseEfficiency = 0, tags = {}, participantIds = [], threshold = FULL_UNIT_EFFICIENCY, buildingId = "", buildingName = "", damageWeight = 1 }) {
  const base = Math.max(0, asNumber(baseEfficiency, 0));
  return {
    side,
    type,
    id: String(id || `${side}-${type}-${Math.random()}`),
    label: String(label || type),
    baseEfficiency: base,
    currentEfficiency: base,
    modifierBaseEfficiency: base,
    modifierPercent: 0,
    roundedEfficiency: roundEff(base),
    preCounterEfficiency: base,
    tags: cloneTags(tags),
    participantIds: Array.isArray(participantIds) ? participantIds.map((value) => String(value ?? "")).filter(Boolean) : [],
    threshold: Math.max(1, asNumber(threshold, FULL_UNIT_EFFICIENCY)),
    full: base >= FULL_UNIT_EFFICIENCY || type === "garrison",
    counterLoss: 0,
    modifiers: [],
    buildingId: String(buildingId ?? ""),
    buildingName: String(buildingName ?? ""),
    damageWeight: Math.max(0.25, asNumber(damageWeight, 1))
  };
}

export function sourceDice(source) {
  if (!source?.full && source?.type !== "garrison") return 0;
  const value = source?.type === "garrison" ? Math.max(0, asNumber(source?.currentEfficiency, 0)) : roundEff(source?.currentEfficiency);
  return Math.max(0, Math.floor(value / Math.max(1, asNumber(source?.threshold, FULL_UNIT_EFFICIENCY))));
}

export function pooledDiceFromSources(sources = [], { threshold = FULL_UNIT_EFFICIENCY, side = "side" } = {}) {
  const eligible = (sources ?? []).filter((source) => source?.full && source?.type !== "garrison" && roundEff(source.currentEfficiency) > 0);
  for (const source of sources ?? []) {
    source.roundedEfficiency = roundEff(source.currentEfficiency);
    source.poolDiceShare = 0;
    source.poolRemainder = 0;
  }
  const safeThreshold = Math.max(1, asNumber(threshold, FULL_UNIT_EFFICIENCY));
  const roundedTotal = eligible.reduce((sum, source) => sum + roundEff(source.currentEfficiency), 0);
  const rawTotal = round2(eligible.reduce((sum, source) => sum + asNumber(source.currentEfficiency, 0), 0));
  const dice = Math.max(0, Math.floor(roundedTotal / safeThreshold));
  const pool = eligible.map((source, index) => ({ source, index, remaining: roundEff(source.currentEfficiency) }));
  const slots = [];
  for (let die = 0; die < dice; die += 1) {
    let need = safeThreshold;
    const contributors = [];
    while (need > 0) {
      pool.sort((a, b) => b.remaining - a.remaining || a.index - b.index);
      const item = pool.find((row) => row.remaining > 0);
      if (!item) break;
      const take = Math.min(need, item.remaining);
      item.remaining -= take;
      need -= take;
      contributors.push({ source: item.source, take });
    }
    const participantIds = [...new Set(contributors.flatMap((row) => row.source.participantIds ?? []).map((id) => String(id ?? "")).filter(Boolean))];
    const labels = contributors.map((row) => row.source.label).filter(Boolean);
    const sourceIds = contributors.map((row) => row.source.id).filter(Boolean);
    const mixed = contributors.length > 1;
    for (const row of contributors) row.source.poolDiceShare = asInt(row.source.poolDiceShare, 0) + 1;
    slots.push({
      sourceId: mixed ? `${side}-pooled-${die + 1}` : String(sourceIds[0] ?? `${side}-die-${die + 1}`),
      sourceIds,
      sourceLabel: mixed ? `Сводный куб ${die + 1}: ${labels.join(" + ")}` : (labels[0] ?? `Куб ${die + 1}`),
      type: mixed ? "mixed" : (contributors[0]?.source?.type ?? "regular"),
      participantIds,
      weight: 1,
      contributorLabels: labels,
      contributors: contributors.map((row) => ({ sourceId: row.source.id, sourceLabel: row.source.label, efficiency: row.take }))
    });
  }
  for (const item of pool) item.source.poolRemainder = item.remaining;
  return { dice, roundedTotal, rawTotal, threshold: safeThreshold, slots, text: `${roundedTotal} округл. эфф. / ${safeThreshold} = ${dice}к6` };
}

export function collectTags(sources = []) {
  const tags = {};
  const tagKeys = getMassCombatUnitTagKeys();
  for (const key of tagKeys) tags[key] = 0;
  for (const source of sources) {
    for (const key of tagKeys) {
      if (asNumber(source?.tags?.[key], 0) > 0 && source.full) tags[key] += 1;
    }
  }
  return tags;
}

export function defenseSquadProfile(holding, state = {}) {
  if (state.useDefenseSquads === false) return { enabled: false, squads: [], units: 0, bs: 0, dice: 0, tags: {}, effective: 0, sources: [], details: "отряды поселения отключены" };
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !isInjuredResident(person));
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const squads = Array.isArray(holding?.gm?.defense?.squads) ? holding.gm.defense.squads : [];
  const counted = [];
  const sources = [];
  let effectiveTotal = 0;
  for (const squad of squads) {
    if (!squad?.equipped) continue;
    const profile = squadTypeProfile(squad.type);
    const memberIds = (Array.isArray(squad.memberIds) ? squad.memberIds : []).slice(0, 4).map((id) => String(id ?? ""));
    const sergeantId = String(squad.sergeantId ?? "");
    const combatantIds = [...new Set([sergeantId, ...memberIds].filter(Boolean))];
    const combatants = combatantIds.map((id) => byId.get(id)).filter(Boolean);
    let effective = combatants.reduce((sum, person) => sum + soldierEfficiency(person, squad.type), 0);
    const sergeant = byId.get(sergeantId);
    const sergeantBonus = sergeant && isSergeantCandidate(sergeant) ? 0.10 : 0;
    if (sergeantBonus) effective *= 1 + sergeantBonus;
    effective = round2(effective);
    if (effective < FULL_UNIT_EFFICIENCY) continue;
    const source = makeSource({
      side: "defender",
      type: "regular",
      id: squad.id,
      label: squad.name || profile.label,
      baseEfficiency: effective,
      tags: profile.tags,
      participantIds: combatantIds,
      threshold: FULL_UNIT_EFFICIENCY
    });
    source.sergeantBonus = sergeantBonus;
    sources.push(source);
    effectiveTotal += effective;
    counted.push({ id: String(squad.id ?? ""), name: squad.name || profile.label, type: profile.label, effective, dice: sourceDice(source), tags: profile.tags });
  }
  const tags = collectTags(sources);
  const dice = sources.reduce((sum, source) => sum + sourceDice(source), 0);
  const units = counted.length;
  return { enabled: true, squads: counted, units, bs: round1(effectiveTotal), dice, tags, effective: round2(effectiveTotal), sources, details: counted.length ? `${counted.length} полных отрядов, ${round1(effectiveTotal)} эфф., ${dice}к6.` : "полных экипированных отрядов нет" };
}

function buildingCombatTag(building) {
  const requested = String(building?.defense?.combatTag ?? "garrison").trim();
  const tags = getMassCombatRelationTags();
  return requested !== "militia" && tags[requested] ? requested : "garrison";
}

export function defenseGarrisonProfile(holding, { buildingEffectiveWorkers = null } = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !isInjuredResident(person));
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const buildings = builtBuildings(holding).filter((building) => isDefenseBuilding(building));
  const ids = new Set();
  const details = [];
  const buildingsHeld = [];
  const sources = [];
  let effective = 0;
  for (const building of buildings) {
    const assigned = (Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : []).map((id) => String(id ?? "")).filter(Boolean);
    const combatants = assigned.map((id) => byId.get(id)).filter(Boolean);
    for (const person of combatants) ids.add(String(person.id));
    const effSummary = typeof buildingEffectiveWorkers === "function" ? buildingEffectiveWorkers(holding, building) : null;
    let buildingEffective = Number.isFinite(Number(effSummary?.total)) ? Math.max(0, Number(effSummary.total)) : 0;
    if (!buildingEffective && combatants.length) buildingEffective = combatants.reduce((sum, person) => sum + (soldierEfficiency(person, "line") || 0.75), 0);
    buildingEffective = round2(buildingEffective);
    effective += buildingEffective;
    const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
    const threshold = Math.max(1, asNumber(defense.workerStep, DEFAULT_GARRISON_THRESHOLD) || DEFAULT_GARRISON_THRESHOLD);
    const maxDice = Math.max(0, asInt(defense.maxDice ?? defense.base ?? 0, 0)) || 99;
    const rawDice = Math.min(maxDice, Math.floor(buildingEffective / threshold));
    const active = rawDice > 0;
    const combatTag = buildingCombatTag(building);
    const tags = { [combatTag]: 1 };
    const source = makeSource({
      side: "defender",
      type: "garrison",
      id: `garrison-${building.id}`,
      label: building.name || "Гарнизон",
      baseEfficiency: buildingEffective,
      tags,
      participantIds: combatants.map((person) => String(person.id)),
      threshold,
      buildingId: building.id,
      buildingName: building.name,
      damageWeight: 1.25
    });
    source.full = active;
    source.baseDice = rawDice;
    source.currentDice = rawDice;
    if (active) sources.push(source);
    buildingsHeld.push({ id: String(building?.id ?? ""), name: building?.name || "Оборонное здание", people: combatants.length, effective: buildingEffective, threshold, rawDice, heldScore: rawDice, active, tags });
    if (active) details.push(`${building?.name || "Оборонное здание"}: ${round1(buildingEffective)} эфф. / ${threshold} = ${rawDice}к6`);
  }
  const combatants = Array.from(ids).map((id) => byId.get(id)).filter(Boolean);
  const tags = collectTags(sources);
  return {
    count: combatants.length,
    activeCount: buildingsHeld.filter((item) => item.active).length,
    effective: round2(effective),
    dice: sources.reduce((sum, source) => sum + sourceDice(source), 0),
    ids,
    buildings: buildingsHeld,
    sources,
    heldScore: sources.reduce((sum, source) => sum + sourceDice(source), 0),
    tags,
    details: details.length ? details.join(" · ") : "укомплектованных гарнизонов нет"
  };
}

export function fortificationProfile(holding, state = {}, { defenseTotal = 0, hasDefenders = false, breachOpen = false, garrisonProfile = null, defensePlan = null, attackMethod = null } = {}) {
  const mode = DEFENSE_MODES[String(state.defenseMode ?? "behindWalls")] ?? DEFENSE_MODES.behindWalls;
  const plan = defensePlan ?? DEFENSE_PLANS.holdFortifications;
  const method = attackMethod ?? ATTACK_METHODS.frontalAssault;
  const garrison = garrisonProfile ?? defenseGarrisonProfile(holding);
  const modeFactor = asNumber(mode.factor, 1);
  const planFactor = asNumber(plan.fortFactor, 1);
  const methodFactor = asNumber(method.fortDiceFactor, 1);
  const rawDice = Math.max(0, asInt(garrison?.dice, 0));
  const fullDice = hasDefenders ? Math.floor(rawDice * modeFactor * planFactor * methodFactor) : 0;
  const dice = breachOpen ? Math.ceil(fullDice / 2) : fullDice;
  const activeBuildings = (garrison?.buildings ?? []).filter((row) => row.active);
  const emptyBuildings = (garrison?.buildings ?? []).filter((row) => !row.active);
  const details = activeBuildings.slice(0, 5).map((row) => `${row.name}: ${row.rawDice}к6`).join(", ");
  const emptyText = emptyBuildings.length ? ` Пустые/недоукомплектованные: ${emptyBuildings.slice(0, 4).map((row) => row.name).join(", ")}.` : "";
  return {
    rawScore: Math.max(0, asNumber(defenseTotal, 0)),
    mannedScore: rawDice,
    heldScore: dice,
    fullDice,
    dice,
    mode,
    noFortress: dice <= 0,
    factors: { modeFactor, planFactor, methodFactor },
    details: details || "гарнизон не дает кубов",
    text: hasDefenders ? `Гарнизонные кубы ${rawDice} × режим ${pct(modeFactor)} × план ${pct(planFactor)} × метод ${pct(methodFactor)} → ${dice}к6.${emptyText}` : "Укрепления не удерживаются: нет людей, которые держат позицию."
  };
}

function militiaSources(holding, state = {}, militaryIds = new Set()) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !isInjuredResident(person));
  const adults = people.filter((person) => isAdultResident(person));
  const civilians = adults.filter((person) => !militaryIds.has(String(person.id)) && !isSoldierResident(person) && !isMilitaryResident(person));
  const defenseConfig = holding?.gm?.defense ?? {};
  const threshold = militiaThreshold(defenseConfig);
  const raise = state.raiseMilitia === true;
  const units = raise ? Math.floor(civilians.length / threshold) : 0;
  const sources = [];
  for (let i = 0; i < units; i += 1) {
    const start = i * threshold;
    const ids = civilians.slice(start, start + threshold).map((person) => String(person.id));
    sources.push(makeSource({
      side: "defender",
      type: "militia",
      id: `militia-${i + 1}`,
      label: `Ополчение ${i + 1}`,
      baseEfficiency: FULL_UNIT_EFFICIENCY,
      tags: { militia: 1 },
      participantIds: ids,
      threshold: FULL_UNIT_EFFICIENCY,
      damageWeight: threshold / 10
    }));
  }
  const used = units * threshold;
  const partial = raise && units === 0 && civilians.length > 0 ? civilians.slice(0, threshold).map((person) => String(person.id)) : [];
  const reserve = raise && units > 0 ? civilians.slice(used).map((person) => String(person.id)) : [];
  return { sources, civilians, threshold, units, raise, pool: civilians.length, partialIds: partial, reserveIds: reserve, defenseConfig };
}

export function autoDefenderProfile(holding, state = {}, {
  defenseTotal = 0,
  buildingEffectiveWorkers = null,
  calculateMorale = null
} = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !isInjuredResident(person));
  const adults = people.filter((person) => isAdultResident(person));
  const squadProfile = defenseSquadProfile(holding, state);
  const garrisonProfile = defenseGarrisonProfile(holding, { buildingEffectiveWorkers });
  const militaryIds = new Set();
  for (const source of [...(squadProfile.sources ?? []), ...(garrisonProfile.sources ?? [])]) {
    for (const id of source.participantIds ?? []) militaryIds.add(String(id));
  }
  for (const id of garrisonProfile.ids ?? []) militaryIds.add(String(id));
  for (const person of adults) {
    if (isMilitaryResident(person)) militaryIds.add(String(person.id));
  }
  const militia = militiaSources(holding, state, militaryIds);
  const sources = [...(squadProfile.sources ?? []), ...(militia.sources ?? [])];
  const regularEffective = sources.reduce((sum, source) => sum + source.baseEfficiency, 0);
  const moraleResult = typeof calculateMorale === "function" ? calculateMorale(holding) : 0;
  const moraleValue = asNumber(moraleResult?.score ?? moraleResult?.value ?? moraleResult, 0);
  const moraleBand = moraleBandForScore(moraleValue);
  const morale = moraleBand.id === "riot" || moraleBand.id === "discontent"
    ? -2
    : (moraleBand.id === "apathy" ? -1 : (moraleBand.id === "hope" ? 1 : (moraleBand.id === "home" ? 2 : 0)));
  const manualRequested = String(state.defenderMobilization ?? "") === "manual";
  const tags = collectTags([...sources, ...(garrisonProfile.sources ?? [])]);
  const details = [
    `${adults.length} взрослых`,
    `${militaryIds.size} военных/занятых обороной`,
    `отряды: ${squadProfile.details}`,
    `гарнизоны: ${garrisonProfile.details}`,
    `ополчение: ${militia.pool} доступных гражданских; ${militiaQualityText(militia.defenseConfig)}; ${militia.raise ? `${militia.units} отряд${militia.partialIds?.length ? `, неполное ополчение ${militia.partialIds.length} чел.` : ""}.` : "не поднято."}`,
    `DR ${defenseTotal} — справочный рейтинг; сам не даёт кубов, кубы укреплений дают только укомплектованные гарнизоны`
  ];
  return {
    mode: manualRequested ? "manual" : (militia.raise ? "militia" : "watch"),
    label: DEFENDER_MOBILIZATIONS[militia.raise ? "militia" : "watch"]?.label ?? "Защитники",
    manual: manualRequested,
    units: sources.length,
    bs: round1(regularEffective),
    command: 0,
    morale,
    tags,
    fire: tags.shooters ?? 0,
    recon: tags.skirmishers ?? 0,
    cavalry: tags.mobile ?? 0,
    siege: tags.siege ?? 0,
    engineering: tags.sappers ?? 0,
    monstrous: tags.monsters ?? 0,
    sacred: tags.sacred ?? 0,
    militiaThreshold: militia.threshold,
    militiaUnits: militia.units,
    militiaIds: militia.sources.flatMap((source) => source.participantIds),
    militiaPartialIds: militia.partialIds ?? [],
    militiaReserveIds: militia.reserveIds ?? [],
    raiseMilitia: militia.raise,
    watchUnits: squadProfile.units,
    defenseConfig: militia.defenseConfig,
    details: details.join(" · "),
    squadProfile,
    garrisonProfile,
    sources
  };
}

export function sourceEfficiencies(totalEfficiency = 0, units = 0) {
  const total = Math.max(0, asNumber(totalEfficiency, 0));
  const count = Math.max(0, asInt(units, 0));
  if (!count || total <= 0) return [];
  if (total >= count * FULL_UNIT_EFFICIENCY) return Array.from({ length: count }, () => total / count);
  let remaining = total;
  return Array.from({ length: count }, () => {
    const value = Math.min(FULL_UNIT_EFFICIENCY, remaining);
    remaining = Math.max(0, remaining - value);
    return value;
  });
}

export function sourceTagSetsFromState(state = {}, side = "attacker", units = 0) {
  const count = Math.max(0, asInt(units, 0));
  if (!count) return [];
  const entries = getMassCombatUnitTagKeys()
    .map((key, order) => ({ key, order, count: Math.min(count, Math.max(0, asInt(tagValue(state, side, key), 0))) }))
    .filter((row) => row.count > 0)
    .sort((a, b) => Number(a.key === "infantry") - Number(b.key === "infantry") || b.count - a.count || a.order - b.order);
  const assigned = [];
  for (const entry of entries) {
    for (let index = 0; index < entry.count && assigned.length < count; index += 1) {
      assigned.push(entry.key);
    }
  }
  while (assigned.length < count) assigned.push("infantry");
  return assigned.map((key) => ({ [key]: 1 }));
}

export function attackerSourcesFromState(state = {}) {
  const explicitUnits = Math.max(0, asInt(state.attackerUnits, 0));
  const totalEff = Math.max(0, asNumber(state.attackerBS, 0));
  const units = explicitUnits || (totalEff >= FULL_UNIT_EFFICIENCY ? Math.max(1, Math.floor(totalEff / FULL_UNIT_EFFICIENCY)) : 0);
  if (!units || totalEff <= 0) return [];
  const efficiencies = sourceEfficiencies(totalEff, units);
  const sourceTags = sourceTagSetsFromState(state, "attacker", units);
  const sources = [];
  const activeTags = getMassCombatTags();
  for (let i = 0; i < units; i += 1) {
    const efficiencyField = `attackerSourceEfficiency${i + 1}`;
    const hasManualEfficiency = Object.hasOwn(state, efficiencyField)
      && state[efficiencyField] !== ""
      && state[efficiencyField] !== null
      && state[efficiencyField] !== undefined;
    const autoBaseEfficiency = efficiencies[i];
    const baseEfficiency = hasManualEfficiency
      ? Math.max(0, asNumber(state[efficiencyField], autoBaseEfficiency))
      : autoBaseEfficiency;
    const templateTags = sourceTags[i];
    const templatePrimaryTag = primaryTag(templateTags);
    const manualPrimaryTag = String(
      state?.[`attackerSourcePrimaryTag${i + 1}`]
      ?? state?.[`attackerSourceTag${i + 1}`]
      ?? ""
    ).trim();
    const validManualPrimaryTag = activeTags[manualPrimaryTag] ? manualPrimaryTag : "";
    const tags = tagsWithManualPrimary(templateTags, validManualPrimaryTag);
    const source = makeSource({
      side: "attacker",
      type: "regular",
      id: `attacker-${i + 1}`,
      label: `Отряд ${i + 1}`,
      baseEfficiency,
      tags,
      threshold: FULL_UNIT_EFFICIENCY
    });
    source.templateTags = cloneTags(templateTags, "infantry");
    source.templatePrimaryTag = templatePrimaryTag;
    source.manualPrimaryTag = validManualPrimaryTag;
    source.autoBaseEfficiency = autoBaseEfficiency;
    source.hasManualEfficiency = hasManualEfficiency;
    if (hasManualEfficiency) source.full = baseEfficiency > 0;
    sources.push(source);
  }
  return sources;
}

export function buildManualDefenderSources(state = {}) {
  const efficiency = Math.max(0, asNumber(state.defenderBS, 0));
  const units = Math.max(0, asInt(state.defenderUnits, efficiency >= FULL_UNIT_EFFICIENCY ? Math.floor(efficiency / FULL_UNIT_EFFICIENCY) : 0));
  if (!units || efficiency <= 0) return [];
  const efficiencies = sourceEfficiencies(efficiency, units);
  const sourceTags = sourceTagSetsFromState(state, "defender", units);
  return Array.from({ length: units }, (_, index) => makeSource({
    side: "defender",
    type: "regular",
    id: `manual-def-${index + 1}`,
    label: `Ручной отряд ${index + 1}`,
    baseEfficiency: efficiencies[index],
    tags: sourceTags[index],
    threshold: FULL_UNIT_EFFICIENCY
  }));
}

export function finalizeSources(sources = []) {
  for (const source of sources) {
    source.currentEfficiency = round2(source.currentEfficiency);
    source.roundedEfficiency = roundEff(source.currentEfficiency);
    source.dice = sourceDice(source);
    source.primaryTag = source.manualPrimaryTag || source.templatePrimaryTag || primaryTag(source.tags);
  }
  return sources;
}

export function riskSlotsFromSources(sources = []) {
  const slots = [];
  for (const source of sources) {
    const dice = Math.max(1, asInt(source.dice ?? sourceDice(source), 0));
    if (!Array.isArray(source.participantIds) || !source.participantIds.length) continue;
    for (let i = 0; i < dice; i += 1) {
      const exposure = source.type === "garrison" ? "fortified" : source.type === "militia" ? "civilian" : "frontline";
      const exposureWeight = exposure === "fortified" ? 0.75 : exposure === "civilian" ? 1.75 : 1.25;
      slots.push({
        sourceId: source.id,
        sourceLabel: source.label,
        type: source.type,
        participantIds: source.participantIds.slice(),
        buildingId: source.buildingId || "",
        exposure,
        weight: Math.max(0.5, asNumber(source.damageWeight, 1) * exposureWeight)
      });
    }
  }
  return slots;
}

export function sourceRows(sources = []) {
  return sources.map((source) => {
    const status = sourceStatus(source);
    const base = round1(source.baseEfficiency);
    const current = round1(source.currentEfficiency);
    const dice = source.dice ?? sourceDice(source);
    const threshold = Math.max(1, asNumber(source.threshold, FULL_UNIT_EFFICIENCY));
    const counterLoss = round1(source.counterLoss ?? 0);
    const modifiers = Array.isArray(source.modifiers) ? source.modifiers.filter(Boolean) : [];
    const modifierText = safeJoin(modifiers, "без модификаторов");
    const manualPrimaryTag = String(source.manualPrimaryTag ?? "");
    const primary = source.primaryTag || primaryTag(source.tags);
    const sourceIndex = source.side === "attacker" && /^attacker-\d+$/.test(String(source.id ?? ""))
      ? String(source.id).split("-")[1]
      : "";
    return {
      id: source.id,
      label: source.label,
      type: source.type,
      typeLabel: sourceTypeLabel(source.type),
      base,
      current,
      baseText: `${base} эфф.`,
      currentText: `${current} эфф.`,
      roundedEfficiency: asInt(source.roundedEfficiency, roundEff(current)),
      roundedText: `окр. ${asInt(source.roundedEfficiency, roundEff(current))}`,
      dice,
      diceText: source.type === "garrison" ? `${dice}к6` : `${asInt(source.poolDiceShare, 0)} сл.`,
      threshold,
      thresholdText: source.type === "garrison" ? `порог ${threshold}` : `пул: ${asInt(source.poolDiceShare, 0)} сл., остаток ${asInt(source.poolRemainder, 0)}`,
      full: Boolean(source.full),
      tags: tagsText(source.tags),
      tagText: tagsText(source.tags),
      tagBadges: Object.entries(source.tags ?? {}).map(([key]) => ({
        key,
        label: tagLabel(key),
        icon: getMassCombatRelationTags()[key]?.icon ?? "fa-solid fa-tag",
        primary: key === primary,
        manual: Boolean(manualPrimaryTag && key === manualPrimaryTag)
      })),
      primaryTag: primary,
      primaryTagLabel: tagLabel(primary),
      manualPrimaryTag,
      hasManualPrimary: Boolean(manualPrimaryTag),
      usesTemplatePrimary: !manualPrimaryTag,
      tagField: sourceIndex ? `attackerSourcePrimaryTag${sourceIndex}` : "",
      restoreTagField: sourceIndex ? `attackerSourcePrimaryTag${sourceIndex}` : "",
      tagOptions: Object.entries(getMassCombatTags()).map(([value, tag]) => ({ value, label: tag.label, selected: value === manualPrimaryTag })),
      autoBaseEfficiency: round2(source.autoBaseEfficiency ?? source.baseEfficiency),
      hasManualEfficiency: Boolean(source.hasManualEfficiency),
      efficiencyField: sourceIndex ? `attackerSourceEfficiency${sourceIndex}` : "",
      counterLoss,
      counterText: counterLoss > 0 ? `-${counterLoss} эфф.` : "-",
      status: status.label,
      statusClass: status.css,
      participantCount: Array.isArray(source.participantIds) ? source.participantIds.length : 0,
      buildingId: source.buildingId || "",
      buildingName: source.buildingName || "",
      modifiers,
      modifierText,
      hint: modifierText
    };
  });
}

export function riskSummaryFromSlots(slots = []) {
  const rowsByKey = new Map();
  for (const slot of slots ?? []) {
    const key = `${slot.type || "source"}:${slot.sourceId || slot.sourceLabel || "?"}`;
    const previous = rowsByKey.get(key) ?? {
      sourceLabel: slot.sourceLabel || "Источник",
      type: slot.type || "source",
      typeLabel: sourceTypeLabel(slot.type),
      slots: 0,
      weight: 0,
      people: new Set(),
      buildingId: slot.buildingId || "",
      exposure: slot.exposure || "frontline"
    };
    previous.slots += 1;
    previous.weight += Math.max(0.5, asNumber(slot.weight, 1));
    for (const id of slot.participantIds ?? []) {
      if (id) previous.people.add(String(id));
    }
    rowsByKey.set(key, previous);
  }
  const rows = Array.from(rowsByKey.values()).map((row) => ({
    sourceLabel: row.sourceLabel,
    type: row.type,
    typeLabel: row.typeLabel,
    exposure: row.exposure,
    slots: row.slots,
    weight: round1(row.weight),
    people: row.people.size,
    text: `${row.sourceLabel}: ${row.slots} слот., ${row.people.size} чел.`
  })).sort((a, b) => b.weight - a.weight || b.slots - a.slots || a.sourceLabel.localeCompare(b.sourceLabel));
  const totalSlots = rows.reduce((sum, row) => sum + row.slots, 0);
  const totalWeight = round1(rows.reduce((sum, row) => sum + row.weight, 0));
  return {
    rows,
    totalSlots,
    totalWeight,
    text: rows.length ? `${totalSlots} слотов риска, вес ${totalWeight}` : "слотов риска нет",
    compact: rows.slice(0, 4).map((row) => row.text).join("; ") || "нет участников риска"
  };
}
