import { getSkyholdManager } from "../registry.js";
import { ageGroupFromAge } from "../../generators/resident-rules.js";
import { getCalendariaSnapshot } from "../../integrations/calendaria-bridge.js";
import {
  ACCESS_MODES,
  ATTACK_METHODS,
  DEFENDER_MOBILIZATIONS,
  DEFENSE_MODES,
  DEFENSE_PLANS,
  OBJECTIVE_THRESHOLDS,
  ROUND_LIMITS,
  ROUND_THREATS,
  SCALES,
  STRATEGIES,
  asInt,
  asNumber,
  clamp,
  commandPercentFromEffectiveness,
  militiaQualityText,
  militiaThreshold,
  poolDiceFromStrength,
  stateValue,
  tagValue,
  toSigned
} from "./rules.js";
import { getMassCombatTagCounters, getMassCombatTags, getMassCombatUnitTagKeys, tagLabel } from "./tag-config.js";

const FULL_UNIT_EFFICIENCY = 5;
const DEFAULT_GARRISON_THRESHOLD = 4;
const MAX_SOURCE_TAGS = 1;

function round1(value) { return Math.round(asNumber(value, 0) * 10) / 10; }
function round2(value) { return Math.round(asNumber(value, 0) * 100) / 100; }
function roundEff(value) { return Math.max(0, Math.round(asNumber(value, 0))); }
const SOURCE_TYPE_LABELS = { regular: "Отряд", militia: "Ополчение", garrison: "Гарнизон", manual: "Ручной отряд", mixed: "Сводный куб" };
function sourceTypeLabel(type = "regular") { return SOURCE_TYPE_LABELS[String(type)] ?? "Источник"; }
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
function safeManager() { try { return getSkyholdManager?.(); } catch (_error) { return null; } }
function pct(value) { return `${Math.round(asNumber(value, 0) * 100)}%`; }
function limitTags(tags = {}, limit = MAX_SOURCE_TAGS) {
  const activeTags = getMassCombatTags();
  const ranked = Object.entries(tags ?? {})
    .map(([key, value]) => [key, Math.max(0, asNumber(value, 0))])
    .filter(([key, value]) => activeTags[key] && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.max(0, asInt(limit, MAX_SOURCE_TAGS)));
  const next = {};
  for (const [key, value] of ranked) next[key] = value;
  return next;
}

function cloneTags(tags = {}) {
  return limitTags(tags, MAX_SOURCE_TAGS);
}
function hasTag(source, tag) {
  if (tag === "garrison") return source?.type === "garrison";
  if (tag === "militia") return source?.type === "militia";
  return asNumber(source?.tags?.[tag], 0) > 0;
}
function primaryTag(tags = {}) {
  let best = "infantry";
  let bestValue = -1;
  for (const [key, value] of Object.entries(tags ?? {})) {
    const number = asNumber(value, 0);
    if (number > bestValue) { best = key; bestValue = number; }
  }
  return best;
}
function pushBreakdown(parts, label, value, hint = "") {
  parts.push({ label, value, signed: value > 0 ? `+${round2(value)}` : String(round2(value)), hint });
}

export function builtBuildings(app, holding) {
  return (holding?.buildings?.list ?? []).filter((building) => String(building?.constructionStatus ?? "built") === "built");
}

export function isDefenseBuilding(app, building) {
  const functions = building?.functions && typeof building.functions === "object" ? building.functions : {};
  const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
  const base = asNumber(defense.base, 0);
  const perStep = asNumber(defense.perStep, 0);
  const maxDice = asNumber(defense.maxDice, 0);
  return Boolean(functions.defense || base > 0 || perStep > 0 || maxDice > 0);
}

export function personText(app, person = {}) {
  return [person.role, person.skill, person.background, person.traitsText, person.traits, person.status, person.notes, person.workerTypeLabel, person.type].map((v) => String(v ?? "").toLowerCase()).join(" ");
}

export function personAssignmentText(app, person = {}) {
  return [person.workAssignment, person.role, person.skill, person.status].map((v) => String(v ?? "").toLowerCase()).join(" ");
}

export function isInjuredResident(app, person = {}) {
  return asNumber(person?.injuredDays, 0) > 0 || /ранен|тяжело|сломлен|injured|wound/i.test(String(person?.status ?? ""));
}

export function isAdultResident(app, person) {
  if (!person || person.dead || app._isInjuredResident(person)) return false;
  const group = String(person.ageGroup ?? ageGroupFromAge(person.age, person.race, person.subrace) ?? "");
  return group && group !== "Ре";
}

export function isMilitaryResident(app, person = {}) {
  const text = `${app._personAssignmentText(person)} ${app._personText(person)}`;
  if (String(person?.workAssignment ?? "") === "soldier") return true;
  return /(guard|soldier|veteran|mercenary|militia|ranger|scout|musketeer|gunner|sapper|warden|bodyguard|страж|солдат|ветеран|наемник|наёмник|ополчен|дозор|егерь|разведчик|мушкетер|мушкетёр|канонир|сап[её]р|тюремщик|телохранитель|охран)/i.test(text);
}

export function hasResidentWords(app, person = {}, pattern) { return pattern.test(app._personText(person)); }

export function residentCombatTrait(app, person = {}) {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const strength = asNumber(attrs.strength, 0);
  const agility = asNumber(attrs.agility, 0);
  const wits = asNumber(attrs.wits, 0);
  return { military: app._isMilitaryResident(person) ? 1 : 0, strong: strength >= 5 || agility >= 5 ? 1 : 0, competent: strength >= 4 || agility >= 4 || wits >= 4 ? 1 : 0 };
}

export function isSoldierResident(app, person = {}) {
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const strongEnough = asNumber(attrs.strength, 0) >= 3 && asNumber(attrs.agility, 0) >= 3;
  if (!strongEnough) return false;
  return /(солдат|страж|гвард|мушкет[её]р|фузил[её]р|егерь|ветеран|наемник|наёмник|канонир|артиллер|сап[её]р|guard|soldier|musketeer|fusilier|jaeger|rifle|veteran|mercenary|gunner|sapper)/i.test(app._personText(person)) || app._isMilitaryResident(person);
}

export function isMilitaryBackgroundResident(app, person = {}) {
  const text = `${person?.background ?? ""} ${person?.role ?? ""} ${person?.skill ?? ""}`.toLowerCase();
  return /(солдат|ветеран|на[её]мник|страж|сторож|дозор|егерь|дезертир|канонир|артиллер|сап[её]р|тюремщик|палач|телохранитель|ополчен|мушкет|развед|офицер|сержант)/i.test(text);
}

export function isSergeantCandidate(app, person = {}) {
  if (!app._isSoldierResident(person) || app._isInjuredResident(person) || person?.dead) return false;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return app._isMilitaryBackgroundResident(person) && [attrs.strength, attrs.agility, attrs.wits, attrs.empathy].some((value) => asNumber(value, 0) >= 5);
}

export function isCommanderCandidate(app, person = {}) {
  if (app._isInjuredResident(person) || person?.dead) return false;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  return asNumber(attrs.wits, 0) >= 4 && (app._isMilitaryBackgroundResident(person) || app._isSoldierResident(person));
}

export function squadTypeProfile(app, type = "line") {
  const profiles = {
    line: { label: "Линейная пехота", tags: { infantry: 1 }, attrs: ["strength", "agility"], min: { strength: 3, agility: 3 }, salary: 10, note: "СИЛ 3+, ЛОВ 3+" },
    fusiliers: { label: "Фузилеры", tags: { shooters: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 12, note: "стрелки: ЛОВ 4+" },
    jaegers: { label: "Егеря", tags: { skirmishers: 1 }, attrs: ["agility", "wits"], min: { strength: 3, agility: 4, wits: 3 }, salary: 14, note: "застрельщики: ЛОВ 4+, РАЗ 3+" },
    grenadiers: { label: "Гренадеры", tags: { heavy: 1 }, attrs: ["strength", "agility"], min: { strength: 4, agility: 3 }, salary: 14, note: "тяжелые: СИЛ 4+" },
    sappers: { label: "Саперы", tags: { sappers: 1 }, attrs: ["wits", "strength"], min: { strength: 3, agility: 3, wits: 4 }, salary: 12, note: "саперы: РАЗ 4+" },
    artillery: { label: "Артиллерийская команда", tags: { siege: 1 }, attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, salary: 15, note: "осадные: РАЗ 4+" },
    cavalry: { label: "Драгуны / конные", tags: { mobile: 1 }, attrs: ["agility"], min: { strength: 3, agility: 4 }, salary: 16, note: "мобильность: ЛОВ 4+" },
    militia: { label: "Ополчение", tags: { infantry: 1 }, attrs: ["strength", "agility"], min: {}, salary: 0, note: "виртуальный гражданский отряд" }
  };
  return profiles[String(type)] ?? profiles.line;
}

export function isSuitableForSquadType(app, person = {}, type = "line") {
  const profile = app._squadTypeProfile(type);
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  for (const [key, min] of Object.entries(profile.min ?? {})) if (asNumber(attrs[key], 0) < asNumber(min, 0)) return false;
  return true;
}

export function soldierEfficiency(app, person = {}, type = "line") {
  if (!app._isSuitableForSquadType(person, type)) return 0;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const profile = app._squadTypeProfile(type);
  const keys = Array.isArray(profile.attrs) && profile.attrs.length ? profile.attrs : ["strength", "agility"];
  let value = 1;
  for (const key of keys) {
    const score = asNumber(attrs[key], 0);
    value += score >= 5 ? 0.25 : score >= 4 ? 0.15 : 0;
  }
  if (app._isMilitaryBackgroundResident(person)) value += 0.10;
  return Number.isFinite(Number(value)) ? Math.min(1.7, round2(value)) : 0;
}

function makeSource({ side, type, id, label, baseEfficiency = 0, tags = {}, participantIds = [], threshold = FULL_UNIT_EFFICIENCY, buildingId = "", buildingName = "", damageWeight = 1 }) {
  const base = Math.max(0, asNumber(baseEfficiency, 0));
  return {
    side,
    type,
    id: String(id || `${side}-${type}-${Math.random()}`),
    label: String(label || type),
    baseEfficiency: base,
    currentEfficiency: base,
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

function sourceDice(source) {
  if (!source?.full && source?.type !== "garrison") return 0;
  const value = source?.type === "garrison" ? Math.max(0, asNumber(source?.currentEfficiency, 0)) : roundEff(source?.currentEfficiency);
  return Math.max(0, Math.floor(value / Math.max(1, asNumber(source?.threshold, FULL_UNIT_EFFICIENCY))));
}

function pooledDiceFromSources(sources = [], { threshold = FULL_UNIT_EFFICIENCY, side = "side" } = {}) {
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

function collectTags(sources = []) {
  const tags = {};
  const tagKeys = getMassCombatUnitTagKeys();
  for (const key of tagKeys) tags[key] = 0;
  for (const source of sources) for (const key of tagKeys) if (asNumber(source?.tags?.[key], 0) > 0 && source.full) tags[key] += 1;
  return tags;
}

export function defenseSquadProfile(app, holding, state = {}) {
  if (state.useDefenseSquads === false) return { enabled: false, squads: [], units: 0, bs: 0, dice: 0, tags: {}, effective: 0, sources: [], details: "отряды поселения отключены" };
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !app._isInjuredResident(person));
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const squads = Array.isArray(holding?.gm?.defense?.squads) ? holding.gm.defense.squads : [];
  const counted = [];
  const sources = [];
  let effectiveTotal = 0;
  for (const squad of squads) {
    if (!squad?.equipped) continue;
    const profile = app._squadTypeProfile(squad.type);
    const memberIds = (Array.isArray(squad.memberIds) ? squad.memberIds : []).slice(0, 4).map((id) => String(id ?? ""));
    const sergeantId = String(squad.sergeantId ?? "");
    const combatantIds = [...new Set([sergeantId, ...memberIds].filter(Boolean))];
    const combatants = combatantIds.map((id) => byId.get(id)).filter(Boolean);
    let effective = combatants.reduce((sum, person) => sum + app._soldierEfficiency(person, squad.type), 0);
    const sergeant = byId.get(sergeantId);
    const sergeantBonus = sergeant && app._isSergeantCandidate(sergeant) ? 0.10 : 0;
    if (sergeantBonus) effective *= 1 + sergeantBonus;
    effective = round2(effective);
    const full = effective >= FULL_UNIT_EFFICIENCY;
    if (!full) continue;
    const source = makeSource({ side: "defender", type: "regular", id: squad.id, label: squad.name || profile.label, baseEfficiency: effective, tags: profile.tags, participantIds: combatantIds, threshold: FULL_UNIT_EFFICIENCY });
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

export function commanderEffectiveness(app, person = {}) {
  if (!person || person.dead || app._isInjuredResident(person)) return 0;
  const attrs = person?.attributes && typeof person.attributes === "object" ? person.attributes : {};
  const wits = asNumber(attrs.wits, 0);
  const empathy = asNumber(attrs.empathy, 0);
  let value = (wits + empathy) / 2;
  if (app._isMilitaryBackgroundResident(person)) value += 1;
  if (/(лидер|командир|офицер|тактик|стратег|харизмат|авторитет|leader|commander|officer|tactician|strategist)/i.test(app._personText(person))) value += 1;
  return clamp(round2(value), 0, 5);
}

export function defenseCommanderBonus(app, holding, armyDice = 0) {
  const id = String(holding?.gm?.defense?.commanderId ?? "");
  if (!id) return { value: 0, raw: 0, cap: 0, percent: 0, effectiveness: 0, label: "командир не назначен" };
  const commander = (holding?.people?.list ?? []).find((person) => String(person.id) === id && !person?.dead && !app._isInjuredResident(person));
  if (!commander) return { value: 0, raw: 0, cap: 0, percent: 0, effectiveness: 0, label: "командир недоступен" };
  const effectiveness = app._commanderEffectiveness(commander);
  const percent = commandPercentFromEffectiveness(effectiveness);
  const value = Math.max(0, Math.ceil(asNumber(armyDice, 0) * percent - 1e-9));
  return { value, raw: value, cap: value, percent, effectiveness, label: `${commander.name || "Командир"}: ${round1(effectiveness)}/5, +${Math.round(percent * 100)}% к эффективности армии` };
}

function buildingTags(app, building, combatants = []) {
  const text = `${building?.name ?? ""} ${building?.type ?? ""} ${building?.effect ?? ""} ${building?.notes ?? ""}`.toLowerCase();
  const tags = {};
  if (/(башн|стрел|мушкет|руж|амбраз|лук|арбалет|tower|gun|cannon|artillery|firing|shooter)/i.test(text)) tags.shooters = 1;
  if (/(пуш|артиллер|оруд|cannon|artillery|mortar|осад)/i.test(text)) tags.siege = 1;
  if (/(ворот|стен|баррикад|редут|ров|gate|wall|barricade|redoubt)/i.test(text)) tags.heavy = 1;
  if (/(сап|механ|инжен|engineer|sapper|workshop)/i.test(text)) tags.sappers = 1;
  if (!Object.keys(tags).length) tags.infantry = 1;
  const shooters = combatants.filter((p) => app._hasResidentWords(p, /(стрел|мушкет|руж|арбалет|лучник|gun|musk|rifle|archer|crossbow)/i)).length;
  if (shooters >= 2) tags.shooters = Math.max(asNumber(tags.shooters, 0), 1);
  return limitTags(tags, MAX_SOURCE_TAGS);
}

export function defenseGarrisonProfile(app, holding) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !app._isInjuredResident(person));
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const buildings = app._builtBuildings(holding).filter((building) => app._isDefenseBuilding(building));
  const ids = new Set();
  const details = [];
  const buildingsHeld = [];
  const sources = [];
  let effective = 0;
  for (const building of buildings) {
    const assigned = (Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : []).map((id) => String(id ?? "")).filter(Boolean);
    const combatants = assigned.map((id) => byId.get(id)).filter(Boolean);
    for (const p of combatants) ids.add(String(p.id));
    const manager = safeManager();
    const effSummary = manager?._buildingEffectiveWorkers?.(holding, building);
    let buildingEffective = Number.isFinite(Number(effSummary?.total)) ? Math.max(0, Number(effSummary.total)) : 0;
    if (!buildingEffective && combatants.length) buildingEffective = combatants.reduce((sum, person) => sum + (app._soldierEfficiency(person, "line") || 0.75), 0);
    buildingEffective = round2(buildingEffective);
    effective += buildingEffective;
    const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
    const threshold = Math.max(1, asNumber(defense.workerStep, DEFAULT_GARRISON_THRESHOLD) || DEFAULT_GARRISON_THRESHOLD);
    const maxDice = Math.max(0, asInt(defense.maxDice ?? defense.base ?? 0, 0)) || 99;
    const rawDice = Math.min(maxDice, Math.floor(buildingEffective / threshold));
    const active = rawDice > 0;
    const tags = buildingTags(app, building, combatants);
    const source = makeSource({ side: "defender", type: "garrison", id: `garrison-${building.id}`, label: building.name || "Гарнизон", baseEfficiency: buildingEffective, tags, participantIds: combatants.map((p) => String(p.id)), threshold, buildingId: building.id, buildingName: building.name, damageWeight: 1.25 });
    source.full = active;
    source.baseDice = rawDice;
    source.currentDice = rawDice;
    if (active) sources.push(source);
    buildingsHeld.push({ id: String(building?.id ?? ""), name: building?.name || "Оборонное здание", people: combatants.length, effective: buildingEffective, threshold, rawDice, heldScore: rawDice, active, tags });
    if (active) details.push(`${building?.name || "Оборонное здание"}: ${round1(buildingEffective)} эфф. / ${threshold} = ${rawDice}к6`);
  }
  const combatants = Array.from(ids).map((id) => byId.get(id)).filter(Boolean);
  const tags = collectTags(sources);
  return { count: combatants.length, activeCount: buildingsHeld.filter((item) => item.active).length, effective: round2(effective), dice: sources.reduce((sum, source) => sum + sourceDice(source), 0), ids, buildings: buildingsHeld, sources, heldScore: sources.reduce((sum, source) => sum + sourceDice(source), 0), tags, details: details.length ? details.join(" · ") : "укомплектованных гарнизонов нет" };
}

export function fortificationProfile(app, holding, state = {}, { defenseTotal = 0, hasDefenders = false, breachOpen = false, garrisonProfile = null, defensePlan = null, attackMethod = null } = {}) {
  const mode = DEFENSE_MODES[String(state.defenseMode ?? "behindWalls")] ?? DEFENSE_MODES.behindWalls;
  const plan = defensePlan ?? DEFENSE_PLANS.holdFortifications;
  const method = attackMethod ?? ATTACK_METHODS.frontalAssault;
  const garrison = garrisonProfile ?? app._defenseGarrisonProfile(holding);
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
  return { rawScore: Math.max(0, asNumber(defenseTotal, 0)), mannedScore: rawDice, heldScore: dice, fullDice, dice, mode, noFortress: dice <= 0, factors: { modeFactor, planFactor, methodFactor }, details: details || "гарнизон не дает кубов", text: hasDefenders ? `Гарнизонные кубы ${rawDice} × режим ${pct(modeFactor)} × план ${pct(planFactor)} × метод ${pct(methodFactor)} → ${dice}к6.${emptyText}` : "Укрепления не удерживаются: нет людей, которые держат позицию." };
}

function militiaSources(app, holding, state = {}, militaryIds = new Set()) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !app._isInjuredResident(person));
  const adults = people.filter((person) => app._isAdultResident(person));
  const civilians = adults.filter((person) => !militaryIds.has(String(person.id)) && !app._isSoldierResident(person) && !app._isMilitaryResident(person));
  const defenseConfig = holding?.gm?.defense ?? {};
  const threshold = militiaThreshold(defenseConfig);
  const raise = state.raiseMilitia === true;
  const units = raise ? Math.floor(civilians.length / threshold) : 0;
  const sources = [];
  for (let i = 0; i < units; i += 1) {
    const start = i * threshold;
    const ids = civilians.slice(start, start + threshold).map((p) => String(p.id));
    sources.push(makeSource({ side: "defender", type: "militia", id: `militia-${i + 1}`, label: `Ополчение ${i + 1}`, baseEfficiency: FULL_UNIT_EFFICIENCY, tags: { infantry: 1 }, participantIds: ids, threshold: FULL_UNIT_EFFICIENCY, damageWeight: threshold / 10 }));
  }
  const used = units * threshold;
  const partial = raise && units === 0 && civilians.length > 0 ? civilians.slice(0, threshold).map((p) => String(p.id)) : [];
  const reserve = raise && units > 0 ? civilians.slice(used).map((p) => String(p.id)) : [];
  return { sources, civilians, threshold, units, raise, pool: civilians.length, partialIds: partial, reserveIds: reserve, defenseConfig };
}

export function autoDefenderProfile(app, holding, state = {}, { defenseTotal = 0 } = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !app._isInjuredResident(person));
  const adults = people.filter((person) => app._isAdultResident(person));
  const squadProfile = app._defenseSquadProfile(holding, state);
  const garrisonProfile = app._defenseGarrisonProfile(holding);
  const militaryIds = new Set();
  for (const source of [...(squadProfile.sources ?? []), ...(garrisonProfile.sources ?? [])]) for (const id of source.participantIds ?? []) militaryIds.add(String(id));
  for (const person of adults) if (app._isMilitaryResident(person)) militaryIds.add(String(person.id));
  const militia = militiaSources(app, holding, state, militaryIds);
  const sources = [...(squadProfile.sources ?? []), ...(militia.sources ?? [])];
  const regularEffective = sources.reduce((sum, source) => sum + source.baseEfficiency, 0);
  const manager = safeManager();
  const moraleState = manager?._moraleState?.(manager?._calculateMorale?.(holding) ?? 0) ?? { value: 0, label: "" };
  const moraleValue = asNumber(moraleState.value, 0);
  const morale = moraleValue > 30 ? 2 : moraleValue > 15 ? 1 : moraleValue < -15 ? -2 : moraleValue < 0 ? -1 : 0;
  const manualRequested = String(state.defenderMobilization ?? "") === "manual";
  const tags = collectTags([...sources, ...(garrisonProfile.sources ?? [])]);
  const details = [
    `${adults.length} взрослых`,
    `${militaryIds.size} военных/занятых обороной`,
    `отряды: ${squadProfile.details}`,
    `гарнизоны: ${garrisonProfile.details}`,
    `ополчение: ${militia.pool} доступных гражданских; ${militiaQualityText(militia.defenseConfig)}; ${militia.raise ? `${militia.units} отряд${militia.partialIds?.length ? `, неполное ополчение ${militia.partialIds.length} чел.` : ""}.` : "не поднято."}`,
    `DR ${defenseTotal} справочно, кубы дают только гарнизоны`
  ];
  return { mode: manualRequested ? "manual" : (militia.raise ? "militia" : "watch"), label: DEFENDER_MOBILIZATIONS[militia.raise ? "militia" : "watch"]?.label ?? "Защитники", manual: manualRequested, units: sources.length, bs: round1(regularEffective), command: 0, morale, tags, fire: tags.shooters ?? 0, recon: tags.skirmishers ?? 0, cavalry: tags.mobile ?? 0, siege: tags.siege ?? 0, engineering: tags.sappers ?? 0, monstrous: tags.monsters ?? 0, sacred: tags.sacred ?? 0, militiaThreshold: militia.threshold, militiaUnits: militia.units, militiaIds: militia.sources.flatMap((source) => source.participantIds), militiaPartialIds: militia.partialIds ?? [], militiaReserveIds: militia.reserveIds ?? [], raiseMilitia: militia.raise, watchUnits: squadProfile.units, defenseConfig: militia.defenseConfig, details: details.join(" · "), squadProfile, garrisonProfile, sources };
}

function tagsForSourceIndex(tagQueue = [], index = 0, units = 1) {
  const selected = [];
  if (Array.isArray(tagQueue) && tagQueue.length) {
    for (let offset = 0; offset < tagQueue.length && selected.length < MAX_SOURCE_TAGS; offset += 1) {
      const tag = tagQueue[(index + offset * Math.max(1, units)) % tagQueue.length];
      if (tag && !selected.includes(tag)) selected.push(tag);
    }
  }
  if (!selected.length) selected.push("infantry");
  const tags = {};
  for (const tag of selected.slice(0, MAX_SOURCE_TAGS)) tags[tag] = 1;
  return tags;
}

function attackerSourcesFromState(state = {}) {
  const explicitUnits = Math.max(0, asInt(state.attackerUnits, 0));
  const totalEff = Math.max(0, asNumber(state.attackerBS, 0));
  const units = explicitUnits || (totalEff >= FULL_UNIT_EFFICIENCY ? Math.max(1, Math.floor(totalEff / FULL_UNIT_EFFICIENCY)) : 0);
  if (!units || totalEff <= 0) return [];
  const perUnit = Math.max(FULL_UNIT_EFFICIENCY, totalEff / units);
  const tagQueue = [];
  for (const key of getMassCombatUnitTagKeys()) for (let i = 0; i < asInt(tagValue(state, "attacker", key), 0); i += 1) tagQueue.push(key);
  const sources = [];
  const activeTags = getMassCombatTags();
  for (let i = 0; i < units; i += 1) {
    const overrideTag = String(state?.[`attackerSourceTag${i + 1}`] ?? "").trim();
    const tags = activeTags[overrideTag] ? { [overrideTag]: 1 } : tagsForSourceIndex(tagQueue, i, units);
    sources.push(makeSource({ side: "attacker", type: "regular", id: `attacker-${i + 1}`, label: `Отряд ${i + 1}`, baseEfficiency: perUnit, tags, threshold: FULL_UNIT_EFFICIENCY }));
  }
  return sources;
}

function applyTagModifiers(sources = [], modifiers = {}, reason = "") {
  for (const source of sources) {
    let total = 0;
    const applied = [];
    for (const [tag, mod] of Object.entries(modifiers ?? {})) {
      if (!hasTag(source, tag)) continue;
      total += asNumber(mod, 0);
      applied.push(`${tagLabel(tag)} ${pct(mod)}`);
    }
    if (!total) continue;
    source.currentEfficiency = Math.max(0, source.currentEfficiency * (1 + total));
    source.modifiers.push(`${reason}: ${applied.join(", ")}`);
  }
}

function applyCommanderToSources(sources = [], percent = 0, label = "Командир") {
  const mod = asNumber(percent, 0);
  if (!mod) return;
  for (const source of sources) {
    source.currentEfficiency = Math.max(0, source.currentEfficiency * (1 + mod));
    source.modifiers.push(`${label}: ${pct(mod)}`);
  }
}

function applyTagCounters(ownSources = [], enemySources = []) {
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
        for (const [tag, pctValue] of Object.entries(matrix)) {
          if (!hasTag(enemy, tag)) continue;
          const value = enemy.currentEfficiency * pctValue;
          if (value > reduction) { reduction = value; targetTag = tag; }
        }
        if (reduction > 0) candidates.push({ own, enemy, ownTag, targetTag, reduction });
      }
    }
  }
  candidates.sort((a, b) => b.reduction - a.reduction);
  for (const c of candidates) {
    if (usedCounters.has(c.own.id)) continue;
    const beforeCounter = c.enemy.preCounterEfficiency || c.enemy.currentEfficiency;
    const maxLoss = beforeCounter * 0.75;
    const already = c.enemy.counterLoss || 0;
    const allowed = Math.max(0, maxLoss - already);
    const amount = Math.min(allowed, c.reduction);
    if (amount <= 0) continue;
    c.enemy.currentEfficiency = Math.max(beforeCounter * 0.25, c.enemy.currentEfficiency - amount);
    c.enemy.counterLoss = already + amount;
    c.enemy.modifiers.push(`Контра: ${tagLabel(c.ownTag)} против ${tagLabel(c.targetTag)}, -${round1(amount)} эфф.`);
    usedCounters.add(c.own.id);
    rows.push({ source: c.own.label, target: c.enemy.label, sourceTag: c.ownTag, targetTag: c.targetTag, percent: Math.round((amount / Math.max(0.0001, beforeCounter)) * 100), amount: round2(amount), text: `${c.own.label}: ${tagLabel(c.ownTag)} снижает ${c.enemy.label} (${tagLabel(c.targetTag)}) на ${round1(amount)} эфф. (${Math.round((amount / Math.max(0.0001, beforeCounter)) * 100)}%).` });
  }
  return rows;
}

function finalizeSources(sources = []) {
  for (const source of sources) {
    source.currentEfficiency = round2(source.currentEfficiency);
    source.roundedEfficiency = roundEff(source.currentEfficiency);
    source.dice = sourceDice(source);
    source.primaryTag = primaryTag(source.tags);
  }
  return sources;
}


function stableHash(text = "") {
  let hash = 0;
  for (const ch of String(text ?? "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function normalizeWeatherText(raw = "") {
  const text = String(raw ?? "").trim();
  if (!text || /^(не указано|по маршруту|system|систем)/i.test(text)) return "";
  const cleaned = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/calendaria/ig, " ")
    .replace(/common/ig, " ")
    .replace(/^weather[._:-]?/i, " ");
  const key = cleaned.toLowerCase().replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim();
  const aliases = {
    clear: "ясно",
    sunny: "ясно",
    sun: "ясно",
    cloudy: "облачно",
    clouds: "облачно",
    "partly cloudy": "переменная облачность",
    "partly cloud": "переменная облачность",
    "partly-cloudy": "переменная облачность",
    partlycloudy: "переменная облачность",
    "common partly cloudy": "переменная облачность",
    "partly cloudy weather": "переменная облачность",
    overcast: "пасмурно",
    rain: "дождь",
    rainy: "дождь",
    drizzle: "дождь",
    fog: "туман",
    mist: "туман",
    snow: "снег",
    storm: "шторм",
    thunderstorm: "шторм",
    windy: "ветер",
    wind: "ветер",
    dust: "пыль",
    heat: "жара",
    hot: "жара"
  };
  if (aliases[key]) return aliases[key];
  if (/(partly|partial)/i.test(key) && /cloud/i.test(key)) return "переменная облачность";
  return cleaned.replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim();
}

function weatherTextFromHolding(holding = {}) {
  const explicit = normalizeWeatherText(holding?.overview?.weather);
  if (explicit) return explicit;
  const snap = getCalendariaSnapshot?.();
  const weather = snap?.weather;
  if (typeof weather === "string") {
    const normalized = normalizeWeatherText(weather);
    if (normalized) return normalized;
  }
  if (weather && typeof weather === "object") {
    const normalized = normalizeWeatherText(weather.name ?? weather.label ?? weather.title ?? weather.text ?? weather.id ?? weather.key ?? "");
    if (normalized) return normalized;
  }
  const place = `${holding?.overview?.drift ?? ""} ${holding?.overview?.altitude ?? ""} ${holding?.overview?.region ?? ""} ${holding?.name ?? ""}`.toLowerCase();
  const key = `${snap?.dateKey ?? ""}|${place}`;
  const mountain = /гор|mount|хреб|скал|снег|лед|л[её]д|высот/.test(place);
  const sea = /порт|море|берег|кораб|океан|причал|залив/.test(place);
  const desert = /пустын|жар|сух|пес/.test(place);
  const swamp = /болот|туман|дряг|дрыг|топ/.test(place);
  const pools = mountain ? ["ясно и ветрено", "низкая облачность", "снег", "ледяной ветер", "буря"]
    : sea ? ["ясно", "морской ветер", "дождь", "туман", "шторм"]
    : desert ? ["ясно", "сухой ветер", "жара", "пыль", "песчаная буря"]
    : swamp ? ["пасмурно", "сырость", "туман", "дождь", "густой туман"]
    : ["ясно", "облачно", "ветер", "дождь", "туман"];
  return pools[stableHash(key) % pools.length];
}

function weatherProfile(text = "") {
  const low = String(text ?? "").toLowerCase();
  if (/шторм|буря|ураган|метел|песчаная буря/.test(low)) return { key: "storm", label: "Шторм", tagMods: { shooters: -0.20, siege: -0.20, mobile: -0.15, skirmishers: -0.10 }, planMods: { holdFortifications: 0.05, fightingWithdrawal: -0.05 }, summary: "Плохая видимость и срыв маневра. Удержание укреплений немного надежнее, отход тяжелее." };
  if (/густой туман|туман|низкая облачность/.test(low)) return { key: "fog", label: "Туман", tagMods: { shooters: -0.25, siege: -0.15, mobile: 0.10, skirmishers: 0.10, sappers: 0.05 }, planMods: { raidWithdraw: 0.10, sabotage: 0.10, bombardment: -0.10 }, summary: "Дальняя стрельба хуже. Скрытные и быстрые действия лучше." };
  if (/дождь|сырость/.test(low)) return { key: "rain", label: "Дождь", tagMods: { shooters: -0.15, siege: -0.10, infantry: 0.05, heavy: 0.05, sappers: -0.05 }, planMods: { holdFortifications: 0.05, raidWithdraw: -0.05 }, summary: "Стрельба и механика хуже. Плотный строй держится лучше." };
  if (/переменная облачность|облач|пасмур/.test(low)) return { key: "cloudy", label: "Переменная облачность", tagMods: { shooters: 0.02, skirmishers: 0.02 }, planMods: {}, summary: "Мягкий свет и нормальная видимость. Легкий плюс огневым отрядам и егерям." };
  if (/снег|ледяной/.test(low)) return { key: "snow", label: "Снег", tagMods: { mobile: -0.15, shooters: -0.10, siege: -0.10, infantry: -0.05, heavy: -0.05, skirmishers: 0.05 }, planMods: { deepDefense: 0.05, breakthrough: -0.10 }, summary: "Движение и строй хуже. Глубокая оборона выигрывает от медленного темпа." };
  if (/пыль|песчан/.test(low)) return { key: "dust", label: "Пыль", tagMods: { shooters: -0.20, siege: -0.15, mobile: -0.10, skirmishers: 0.10, sappers: 0.05 }, planMods: { sabotage: 0.10, bombardment: -0.10 }, summary: "Видимость плохая. Диверсанты и застрельщики получают окно." };
  if (/жара|сухой/.test(low)) return { key: "heat", label: "Жара", tagMods: { heavy: -0.10, infantry: -0.05, mobile: -0.05, skirmishers: 0.05, sacred: 0.05 }, planMods: { frontalAssault: -0.05, probingAdvance: 0.05 }, summary: "Тяжелым и плотному строю хуже. Осторожная работа лучше лобового давления." };
  if (/ветер/.test(low)) return { key: "wind", label: "Ветер", tagMods: { shooters: -0.10, siege: -0.10, mobile: 0.05, skirmishers: 0.05 }, planMods: { bombardment: -0.05 }, summary: "Стрельба и осадный огонь хуже. Маневренные группы чувствуют себя лучше." };
  if (/ясно/.test(low)) return { key: "clear", label: "Ясно", tagMods: { shooters: 0.05, siege: 0.05 }, planMods: {}, summary: "Хорошая видимость помогает дальнему и осадному огню." };
  return { key: "neutral", label: text || "Обычная погода", tagMods: {}, planMods: {}, summary: "Боевых модификаторов нет." };
}

export function weatherRulesCatalog() {
  const samples = ["ясно", "переменная облачность", "ветер", "дождь", "туман", "снег", "пыль", "жара", "шторм"];
  return samples.map((sample) => {
    const profile = weatherProfile(sample);
    return {
      key: profile.key,
      label: profile.label,
      summary: profile.summary,
      tagRows: Object.entries(profile.tagMods ?? {}).map(([tag, mod]) => ({ tag, label: tagLabel(tag), percent: mod, text: `${tagLabel(tag)}: ${pct(mod)}`, tone: mod >= 0 ? "positive" : "negative" })),
      planRows: Object.entries(profile.planMods ?? {}).map(([key, mod]) => ({ key, label: STRATEGIES[key]?.label ?? key, percent: mod, text: `${STRATEGIES[key]?.label ?? key}: ${pct(mod)}`, tone: mod >= 0 ? "positive" : "negative" }))
    };
  });
}

function weatherBattleModifier(holding = {}, { defenderStrategy = null, attackerStrategy = null } = {}) {
  const text = weatherTextFromHolding(holding);
  const profile = weatherProfile(text);
  const rows = Object.entries(profile.tagMods ?? {}).map(([tag, mod]) => ({ tag, label: tagLabel(tag), percent: mod, text: `${tagLabel(tag)}: ${pct(mod)}` }));
  const defenderPlan = profile.planMods?.[defenderStrategy?.key] ?? profile.planMods?.[defenderStrategy?.aliasOf] ?? 0;
  const attackerPlan = profile.planMods?.[attackerStrategy?.key] ?? profile.planMods?.[attackerStrategy?.aliasOf] ?? 0;
  const planRows = [];
  if (defenderPlan) planRows.push({ side: "defender", percent: defenderPlan, text: `план защитников: ${pct(defenderPlan)}` });
  if (attackerPlan) planRows.push({ side: "attacker", percent: attackerPlan, text: `метод нападающих: ${pct(attackerPlan)}` });
  const effectsText = [...rows.map((row) => row.text), ...planRows.map((row) => row.text)].filter(Boolean).join("; ");
  const tooltip = [`${text || profile.label}: ${profile.summary}`, effectsText].filter(Boolean).join("; ");
  return { text: text || profile.label, label: tooltip, tooltip, tagMods: profile.tagMods, defenderPlan, attackerPlan, rows, planRows, catalog: weatherRulesCatalog() };
}

function applyWeatherModifiers(sources = [], weather = {}, side = "defender", strategy = null) {
  applyTagModifiers(sources, weather.tagMods ?? {}, `Погода: ${weather.text}`);
  const planMod = side === "defender" ? asNumber(weather.defenderPlan, 0) : asNumber(weather.attackerPlan, 0);
  if (!planMod) return;
  for (const source of sources) {
    source.currentEfficiency = Math.max(0, source.currentEfficiency * (1 + planMod));
    source.modifiers.push(`Погода + ${strategy?.label ?? "план"}: ${pct(planMod)}`);
  }
}

function externalDice(state = {}, side = "defender", access = null) {
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
    dice += asInt(access.penalty, 0);
    parts.push(`доступ ${toSigned(access.penalty)}`);
  }
  return { dice, parts };
}

export function inferRoundThreatKey(app, state = {}, attackerStrategy = {}) {
  const explicit = String(state.roundThreat ?? "");
  if (ROUND_THREATS[explicit]) return explicit;
  const strategyKey = String(state.attackerStrategy ?? "");
  if (strategyKey === "raidWithdraw" || attackerStrategy?.raid) return "raid";
  if (strategyKey === "sabotage") return "sabotage";
  if (strategyKey === "bombardment") return "fire";
  if (strategyKey === "breakthrough") return "assault";
  return "assault";
}

export function lossTrack(app, label, steps, units, fallbackUnits = 1) {
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

export function damageContext(app, holding, state = {}, calcBase = {}) {
  const defenseMode = DEFENSE_MODES[state.defenseMode] ?? DEFENSE_MODES.behindWalls;
  const attackerStrategy = calcBase.attackerStrategy ?? STRATEGIES[state.attackerStrategy] ?? ATTACK_METHODS.frontalAssault;
  let target = "укрепления и окраина";
  let appliesTo = "выбери поврежденное место по цели врага";
  if (attackerStrategy.raid) { target = "склад, ворота, поле, причал, пленники или отдельное здание"; appliesTo = "сначала цель рейда, затем ближайшие здания и ресурсы"; }
  else if (attackerStrategy.breach) { target = "ворота, стены, башни, баррикады"; appliesTo = "сначала оборонные здания и укрепления"; }
  else if (defenseMode.factor <= 0) { target = "отряды и люди вне стен"; appliesTo = "меньше зданий, больше участников боя"; }
  return { target, appliesTo, participants: state.raiseMilitia === true ? "ополчение участвует: рискуют только реально поднятые ополченцы" : "рискуют отряды, гарнизоны и военные жители", defenseMode: defenseMode.label, mobilization: state.raiseMilitia === true ? "Стража + ополчение" : "Стража" };
}

export function damageTrack(app, holding, state = {}, calcBase = {}) {
  const damage = Math.max(0, asInt(state.settlementDamage, 0));
  const builtCount = app._builtBuildings(holding).length;
  const context = app._damageContext(holding, state, calcBase);
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

export function objectiveTrack(app, state = {}, scale = SCALES.raid) {
  const key = String(state.scale || "raid");
  const value = Math.max(0, asInt(state.objectiveProgress, 0));
  const threshold = Math.max(1, asInt(state.objectiveThreshold, OBJECTIVE_THRESHOLDS[key] ?? 3));
  const round = Math.max(1, asInt(state.round, 1));
  const roundLimit = Math.max(1, asInt(state.roundLimit, ROUND_LIMITS[key] ?? 4));
  const done = value >= threshold;
  const outOfTime = round > roundLimit;
  let stateLabel = done ? "Цель достигнута" : outOfTime ? "Время вышло" : "В процессе";
  const instruction = done ? "Цель врага выполнена. Реши, что именно удалось: захват, грабеж, пожар, пленник, прорыв." : outOfTime ? "Раундов больше нормы. Враг отступает, меняет цель или идет на последний риск." : `Цель двигается только при победе атакующих в раунде. Базово: 1 + margin, затем метод атаки и план защиты.`;
  return { value, threshold, round, roundLimit, done, outOfTime, state: stateLabel, instruction, percent: Math.min(100, Math.round((value / threshold) * 100)), scaleLabel: scale?.label ?? "" };
}

function buildManualDefenderSources(state = {}) {
  const eff = Math.max(0, asNumber(state.defenderBS, 0));
  const units = Math.max(0, asInt(state.defenderUnits, eff >= FULL_UNIT_EFFICIENCY ? Math.floor(eff / FULL_UNIT_EFFICIENCY) : 0));
  if (!units || eff <= 0) return [];
  const per = Math.max(FULL_UNIT_EFFICIENCY, eff / units);
  const tags = {};
  for (const key of getMassCombatUnitTagKeys()) tags[key] = tagValue(state, "defender", key);
  if (!Object.values(tags).some((v) => v > 0)) tags.infantry = 1;
  return Array.from({ length: units }, (_, i) => makeSource({ side: "defender", type: "regular", id: `manual-def-${i + 1}`, label: `Ручной отряд ${i + 1}`, baseEfficiency: per, tags, threshold: FULL_UNIT_EFFICIENCY }));
}


function riskSlotsFromSources(sources = []) {
  const slots = [];
  for (const source of sources) {
    const dice = Math.max(1, asInt(source.dice ?? sourceDice(source), 0));
    if (!Array.isArray(source.participantIds) || !source.participantIds.length) continue;
    for (let i = 0; i < dice; i += 1) {
      slots.push({
        sourceId: source.id,
        sourceLabel: source.label,
        type: source.type,
        participantIds: source.participantIds.slice(),
        buildingId: source.buildingId || "",
        weight: source.type === "militia" ? Math.max(1, asNumber(source.damageWeight, 1)) : 1
      });
    }
  }
  return slots;
}

function sourceRows(sources = []) {
  return sources.map((source) => {
    const status = sourceStatus(source);
    const base = round1(source.baseEfficiency);
    const current = round1(source.currentEfficiency);
    const dice = source.dice ?? sourceDice(source);
    const threshold = Math.max(1, asNumber(source.threshold, FULL_UNIT_EFFICIENCY));
    const counterLoss = round1(source.counterLoss ?? 0);
    const modifiers = Array.isArray(source.modifiers) ? source.modifiers.filter(Boolean) : [];
    const modifierText = safeJoin(modifiers, "без модификаторов");
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
      tagField: source.side === "attacker" && /^attacker-\d+$/.test(String(source.id ?? "")) ? `attackerSourceTag${String(source.id).split("-")[1]}` : "",
      tagOptions: Object.entries(getMassCombatTags()).map(([value, tag]) => ({ value, label: tag.label, selected: value === source.primaryTag })),
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

function riskSummaryFromSlots(slots = []) {
  const rowsByKey = new Map();
  for (const slot of slots ?? []) {
    const key = `${slot.type || "source"}:${slot.sourceId || slot.sourceLabel || "?"}`;
    const prev = rowsByKey.get(key) ?? { sourceLabel: slot.sourceLabel || "Источник", type: slot.type || "source", typeLabel: sourceTypeLabel(slot.type), slots: 0, weight: 0, people: new Set(), buildingId: slot.buildingId || "" };
    prev.slots += 1;
    prev.weight += Math.max(1, asNumber(slot.weight, 1));
    for (const id of slot.participantIds ?? []) if (id) prev.people.add(String(id));
    rowsByKey.set(key, prev);
  }
  const rows = Array.from(rowsByKey.values()).map((row) => ({
    sourceLabel: row.sourceLabel,
    type: row.type,
    typeLabel: row.typeLabel,
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

function calculationStepsFrom({ fieldDiceDefender, rawGarrisonDice, garrisonDice, fieldDiceAttacker, defenderFieldPool, attackerFieldPool, defenderExternal, attackerExternal, defenderCommander, attackerCommandPercent, fortification, defenderCounterRows, attackerCounterRows, defenderPool, attackerPool }) {
  return [
    { key: "sources", label: "1. Источники", text: `отряды З ${fieldDiceDefender}к6 (${defenderFieldPool?.text ?? "нет"}), гарнизоны З ${rawGarrisonDice}к6, отряды В ${fieldDiceAttacker}к6 (${attackerFieldPool?.text ?? "нет"})` },
    { key: "command", label: "2. Командиры", text: `защитники ${Math.round(asNumber(defenderCommander?.percent, 0) * 100)}%, враг ${Math.round(asNumber(attackerCommandPercent, 0) * 100)}% к эффективности` },
    { key: "counters", label: "3. Контры тегов", text: `${defenderCounterRows.length + attackerCounterRows.length} активных контр; базовая/сильная/полная контра режет на 25%/50%/75%, но не ниже 25% эффективности` },
    { key: "fort", label: "4. Укрепления", text: fortification?.text ?? "нет укреплений" },
    { key: "external", label: "5. Внешние кубы", text: `защитники ${toSigned(defenderExternal.dice)} (${safeJoin(defenderExternal.parts)}), враг ${toSigned(attackerExternal.dice)} (${safeJoin(attackerExternal.parts)})` },
    { key: "pool", label: "6. Итоговый пул", text: `защитники ${defenderPool}к6, нападающие ${attackerPool}к6` }
  ];
}

export function calculateBattle(app, holding, state = {}, { defenseTotal = 0 } = {}) {
  const defenderStrategyKey = state.defenderStrategy || "holdFortifications";
  const attackerStrategyKey = state.attackerStrategy || "frontalAssault";
  const defenderStrategy = { ...(STRATEGIES[defenderStrategyKey] ?? DEFENSE_PLANS.holdFortifications), key: defenderStrategyKey };
  const attackerStrategy = { ...(STRATEGIES[attackerStrategyKey] ?? ATTACK_METHODS.frontalAssault), key: attackerStrategyKey };
  const defenseMode = DEFENSE_MODES[state.defenseMode] ?? DEFENSE_MODES.behindWalls;
  const accessMode = ACCESS_MODES[state.accessMode] ?? ACCESS_MODES.normal;
  const scale = SCALES[state.scale] ?? SCALES.raid;
  const roundThreatKey = app._inferRoundThreatKey(state, attackerStrategy);
  const roundThreat = ROUND_THREATS[roundThreatKey] ?? ROUND_THREATS.assault;

  const autoDefenders = app._autoDefenderProfile(holding, state, { defenseTotal });
  const garrisonProfile = autoDefenders.garrisonProfile ?? app._defenseGarrisonProfile(holding);
  const manualDefenderSources = autoDefenders.manual ? buildManualDefenderSources(state) : [];
  let defenderFieldSources = autoDefenders.manual ? manualDefenderSources : [...(autoDefenders.sources ?? [])];
  let defenderGarrisonSources = [...(garrisonProfile.sources ?? [])];
  let attackerSources = attackerSourcesFromState(state);

  const hasOrganizedDefense = defenderFieldSources.length > 0 || defenderGarrisonSources.length > 0;
  const breachProgress = Math.max(0, asInt(state.breachProgress, 0));
  const breachThreshold = Math.max(2, Math.ceil((garrisonProfile.dice || 0) / 2) + 2);
  const breachOpen = breachProgress >= breachThreshold;
  const fortification = app._fortificationProfile(holding, state, { defenseTotal, hasDefenders: hasOrganizedDefense, breachOpen, garrisonProfile, defensePlan: defenderStrategy, attackMethod: attackerStrategy });

  applyTagModifiers(defenderFieldSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(defenderGarrisonSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(attackerSources, scale.tagMods, `Масштаб: ${scale.label}`);
  applyTagModifiers(defenderFieldSources, defenderStrategy.tagMods, `План: ${defenderStrategy.label}`);
  applyTagModifiers(defenderGarrisonSources, defenderStrategy.tagMods, `План: ${defenderStrategy.label}`);
  applyTagModifiers(attackerSources, attackerStrategy.tagMods, `Метод: ${attackerStrategy.label}`);

  const weather = weatherBattleModifier(holding, { defenderStrategy, attackerStrategy });
  applyWeatherModifiers(defenderFieldSources, weather, "defender", defenderStrategy);
  applyWeatherModifiers(defenderGarrisonSources, weather, "defender", defenderStrategy);
  applyWeatherModifiers(attackerSources, weather, "attacker", attackerStrategy);

  const defenderCommander = app._defenseCommanderBonus(holding, 0);
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
  const attackerExternal = externalDice(state, "attacker", accessMode);
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

  const calculationSteps = calculationStepsFrom({ fieldDiceDefender, rawGarrisonDice, garrisonDice, fieldDiceAttacker, defenderFieldPool, attackerFieldPool, defenderExternal, attackerExternal, defenderCommander, attackerCommandPercent, fortification, defenderCounterRows, attackerCounterRows, defenderPool, attackerPool });
  const garrisonRiskSlots = riskSlotsFromSources(defenderGarrisonSources).slice(0, garrisonDice);
  const partialMilitiaIds = Array.isArray(autoDefenders?.militiaPartialIds) ? autoDefenders.militiaPartialIds.map((id) => String(id ?? "")).filter(Boolean) : [];
  const partialMilitiaRiskSlot = partialMilitiaIds.length ? [{
    sourceId: "militia-partial",
    sourceLabel: `Неполное ополчение (${partialMilitiaIds.length} чел.)`,
    type: "militia",
    participantIds: partialMilitiaIds,
    weight: Math.max(1, asNumber(autoDefenders?.militiaThreshold, 20) / 10),
    partial: true
  }] : [];
  const defenderRiskSlots = [...defenderFieldPool.slots, ...garrisonRiskSlots, ...partialMilitiaRiskSlot];
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

  const defenderLossTrack = app._lossTrack("Защитники", state.defenderLossSteps ?? state.defenderLosses, Math.max(1, defenderFieldSources.length + defenderGarrisonSources.length));
  const attackerLossTrack = app._lossTrack("Нападающие", state.attackerLossSteps ?? state.attackerLosses, Math.max(1, attackerSources.length));
  const damageTrack = app._damageTrack(holding, state, { fortificationDice: garrisonDice, attackerStrategy, breachOpen });
  const objectiveTrack = app._objectiveTrack(state, scale);

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
    damageTrack,
    objectiveTrack,
    breachProgress,
    breachThreshold,
    breachOpen,
    effectiveState,
    deterrence: app._deterrenceText(fieldDiceDefender + garrisonDice, fieldDiceAttacker, garrisonDice)
  };
}

export function deterrenceText(app, defenderCombatDice, attackerCombatDice, fortificationDice) {
  const defender = asInt(defenderCombatDice, 0);
  const attacker = asInt(attackerCombatDice, 0);
  const fort = asInt(fortificationDice, 0);
  if (!defender && !attacker) return "Силы не выставлены.";
  if (defender >= attacker + 3) return `Оборона выглядит сильной: ${defender}к6 против ${attacker}к6, укрепления ${fort}к6.`;
  if (attacker >= defender + 3) return `Нападающие давят числом/качеством: ${attacker}к6 против ${defender}к6.`;
  return `Раунд близкий: ${defender}к6 против ${attacker}к6. Решат планы, теги и удача.`;
}
