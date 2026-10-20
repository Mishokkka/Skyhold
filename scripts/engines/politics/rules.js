import { normalizePoliticsState, POLITICS_COMPETENCIES, POLITICS_SLOTS, POLITICS_STATE_VERSION } from "../../data/politics-state.js";
import { POLITICS_ARCHETYPES, politicsCatalogRow, resolvedPoliticsCatalog, resolvedPoliticsCore } from "../../data/politics-balance.js";
import { workerTypeFromAttributes } from "../../generators/resident-rules.js";

const balanceOf = (holding) => holding?.gm?.politicsBalance ?? {};
const rowId = (kind, id) => String(id ?? "").startsWith("custom-") ? String(id) : `${kind}:${id}`;
const activeRow = (balance, kind, id, catalog = null) => {
  const row = catalog ? catalog.get(rowId(kind, id)) : politicsCatalogRow(balance, rowId(kind, id));
  return row?.kind === kind && row.enabled !== false ? row : null;
};

export function politicsRepresentativeArchetype(holding = {}, state = normalizePoliticsState(holding.politics), periodIndex = 1, catalog = null) {
  const status = politicsRepresentativeStatus(state, holding, periodIndex, catalog);
  if (status.vacant || status.expired) return "";
  const label = workerTypeFromAttributes(status.resident.attributes ?? {});
  return POLITICS_ARCHETYPES.find((row) => row.label === label)?.id ?? "";
}

export function politicsRequirementsMet(row, context = {}) {
  const flags = {
    market: context.marketActive, route: context.routeActive, guard: context.patrolServiceActive,
    project: context.projectActive, production: context.productionActive,
    institution: context.institutionActive, trialInstitution: context.publicTrialInstitutionActive,
    network: context.networkPaid, patron: context.patronAgreementActive, "food-full": context.rationFullySupplied
  };
  return (row?.requires ?? []).every((id) => flags[id] === true);
}

export function politicsRowUnlocked(row, { archetypeId = "", culture = 0, reputation = 0, technology = 0, ...requirements } = {}) {
  return politicsRowBlockReasons(row, { archetypeId, culture, reputation, technology, ...requirements }).length === 0;
}

/** Public explanations shared by preflight and the decision catalog. */
export function politicsRowBlockReasons(row, context = {}) {
  if (!row) return ["Решение отсутствует в каталоге."];
  const reasons = [];
  if (row.enabled === false) reasons.push("Решение отключено в каталоге.");
  if (row.archetypeId && row.archetypeId !== context.archetypeId) {
    reasons.push(`Нужен действующий представитель: ${POLITICS_ARCHETYPES.find((entry) => entry.id === row.archetypeId)?.label ?? row.archetypeId}.`);
  }
  for (const [key, label] of [["culture", "Культура"], ["reputation", "Репутация"], ["technology", "Технология"]]) {
    if ((Number(context[key]) || 0) < row[`${key}Min`]) reasons.push(`${label}: требуется ${row[`${key}Min`]}, сейчас ${Number(context[key]) || 0}.`);
  }
  const labels = { market: "Нужен работающий Рынок.", route: "Нет доступного внешнего торгового маршрута.",
    guard: "Нужна действующая служба охраны.", project: "Нужен проект с назначенной бригадой.",
    production: "Нужна действующая производственная линия.", institution: "Нужен работающий Дом собраний или Ратуша.",
    trialInstitution: "Нужен работающий Дом собраний или Суд.", network: "Информсеть не оплачена.",
    patron: "Нужно соглашение с патроном.", "food-full": "Фактический рацион не обеспечен полностью." };
  for (const id of row.requires ?? []) if (!politicsRequirementsMet({ requires: [id] }, context)) reasons.push(labels[id] ?? `Не выполнено условие: ${id}.`);
  return reasons;
}

/** Chosen directives retain their entry thresholds, but must meet working conditions. */
export function politicsAppliedDirective(holding, state, slot, context = {}, { catalog = null, archetypeId = null } = {}) {
  if (context.available !== true || !politicsAllowedSlots(state, balanceOf(holding)).includes(slot)) return null;
  const row = activeRow(balanceOf(holding), "directive", state.directives?.[slot], catalog);
  if (!row || (row.slot && row.slot !== slot)) return null;
  const representativeArchetype = archetypeId ?? politicsRepresentativeArchetype(holding, state, context.periodIndex ?? 1, catalog);
  return politicsRowUnlocked(row, { ...context, archetypeId: representativeArchetype,
    culture: Math.max(Number(context.culture) || 0, row.cultureMin),
    reputation: Math.max(Number(context.reputation) || 0, row.reputationMin),
    technology: Math.max(Number(context.technology) || 0, row.technologyMin) }) ? row : null;
}

function addRowEffects(target, row, { rationFullySupplied = false } = {}) {
  if (!row) return;
  for (const key of ["reputation", "control", "unrestControl", "defense", "morale", "marketAccess", "externalFlowPercent", "productionPercent", "constructionPercent", "influenceCap"]) {
    target[key] += row.effects[key] ?? 0;
  }
  if (rationFullySupplied) target.morale += row.effects.moraleIfFullyFed ?? 0;
  target.foodMultiplier += ((row.effects.foodMultiplierPercent ?? 100) - 100) / 100;
}

export const POLITICS_SYSTEMS = Object.freeze({
  governor: { label: "Наместник", slots: ["supply", "order", "external"], term: null },
  "elder-council": { label: "Совет общины", slots: ["supply", "order", "external"], term: 24 },
  "elected-head": { label: "Избранный глава", slots: [...POLITICS_SLOTS], term: 12 },
  "guild-council": { label: "Гильдейский совет", slots: [...POLITICS_SLOTS], term: 12 }
});

export const POLITICS_DIRECTIVES = Object.freeze({
  supply: ["", "ration-lean", "ration-generous"],
  order: ["", "gates-open", "gates-permits", "gates-closed"],
  labor: ["", "labor-mobilization", "labor-festivals"],
  external: ["", "external-patron", "external-trade", "external-network"]
});

export const POLITICS_DECREES = Object.freeze({
  fair: { label: "Ярмарка", copper: 300, influence: 1, duration: 2 },
  festival: { label: "Общинный праздник", copper: 200, influence: 0, duration: 1 },
  "patrol-surge": { label: "Усиленные патрули", copper: 400, influence: 0, duration: 3 },
  "construction-drive": { label: "Строительный аврал", copper: 300, influence: 1, duration: 2 },
  "public-trial": { label: "Публичное разбирательство", copper: 200, influence: 1, duration: 1 },
  "intel-support": { label: "Сведения", copper: 300, influence: 1, duration: 3 }
});

export function politicsPeriodIndex(lastQd = 0) {
  const qd = Number(lastQd);
  return Math.floor(Math.max(0, Number.isFinite(qd) ? qd : 0) / 40) + 1;
}

export function politicsAllowedSlots(state = {}, balance = {}) {
  if (state.stage === "protectorate") return ["supply", "order", "external"];
  if (state.stage === "charter") return POLITICS_SLOTS.filter((slot) => state.charter?.allowedSlots?.includes(slot));
  if (state.stage === "selfRule") {
    const row = activeRow(balance, "system", state.system);
    return POLITICS_SLOTS.filter((slot) => row?.slots?.includes(slot));
  }
  return [];
}

export function politicsSystemPermitted(state = {}) {
  if (state.stage === "protectorate" || state.stage === "charter") return state.system === "governor";
  if (state.stage !== "selfRule") return false;
  return state.system === "governor" ? state.governorInvited === true : Boolean(POLITICS_SYSTEMS[state.system]);
}

export function validatePoliticsCompetencies(competencies = {}) {
  const values = {};
  for (const key of POLITICS_COMPETENCIES) {
    const number = Number(competencies?.[key]);
    if (!Number.isInteger(number) || number < -2 || number > 3) return { ok: false, reason: `Некорректная компетенция: ${key}.` };
    values[key] = number;
  }
  if (Object.values(values).reduce((sum, value) => sum + Math.max(0, value), 0) > 4) {
    return { ok: false, reason: "Положительные компетенции не могут превышать 4 пункта." };
  }
  return { ok: true, values };
}

export function politicsRepresentativeStatus(state = {}, holding = {}, periodIndex = 1, catalog = null) {
  const residentId = String(state.representative?.residentId ?? "");
  const resident = residentId
    ? (holding?.people?.list ?? []).find((person) => String(person?.id ?? "") === residentId && !person.dead)
    : null;
  const systemRow = activeRow(balanceOf(holding), "system", state.system, catalog);
  const duration = systemRow?.duration || null;
  const start = Number(state.representative?.appointedPeriodIndex);
  const expired = Boolean(resident && duration !== null && Number.isInteger(start) && start >= 1 && periodIndex >= start + duration);
  const expiresPeriodIndex = duration !== null && start >= 1 ? start + duration : null;
  const remainingPeriods = resident && expiresPeriodIndex !== null ? Math.max(0, expiresPeriodIndex - periodIndex) : null;
  return { resident: resident ?? null, vacant: !resident, expired, duration, expiresPeriodIndex,
    remainingPeriods, expiringSoon: Boolean(resident && !expired && remainingPeriods !== null && remainingPeriods <= 2) };
}

export function politicsInfluenceCap({ townHallActive = false, culture = 0, balance = {}, perkCap = 0 } = {}) {
  const core = resolvedPoliticsCore(balance);
  return core.influenceBaseCap + (townHallActive ? core.townHallCapBonus : 0)
    + (Number(culture) >= core.highCultureThreshold ? core.highCultureCapBonus : 0) + perkCap;
}

export function politicsInfluenceGain(state = {}, {
  available = false, townHallActive = false, culture = 0,
  networkPaid = false, representativeCulture = 0, representativeExpired = false, balance = {}, perkCap = 0,
  influenceBlocked = null
} = {}) {
  const core = resolvedPoliticsCore(balance);
  const current = Math.max(0, Math.floor(Number(state.influence) || 0));
  const cap = politicsInfluenceCap({ townHallActive, culture, balance, perkCap });
  const resting = influenceBlocked ?? (state.directives?.labor === "labor-festivals" && politicsAllowedSlots(state, balance).includes("labor")
    && Boolean(activeRow(balance, "directive", "labor-festivals")));
  const representativeBonus = representativeCulture >= core.representativeInfluenceCultureMin && !representativeExpired;
  const bonus = networkPaid || representativeBonus;
  const nominal = available && !resting ? core.influenceBaseGain + (bonus ? core.influenceBonusGain : 0) : 0;
  return { current, cap, nominal, gained: Math.max(0, Math.min(nominal, cap - current)), overlappingSources: networkPaid && representativeBonus };
}

export function politicsActiveDecrees(state = {}, periodIndex = 1, balance = {}, catalog = null) {
  return (state.activeDecrees ?? []).filter((decree) => (
    activeRow(balance, "decree", decree?.decreeId, catalog)
    && !decree.cancelled
    && !decree.used
    && Number(decree.issuedPeriodIndex) <= periodIndex
    && periodIndex < Number(decree.expiresPeriodIndex)
  ));
}

export function politicsDecreeQuote(decreeId, population = 0, balance = {}) {
  const decree = activeRow(balance, "decree", decreeId);
  if (!decree) return null;
  return {
    decreeId,
    copper: decree.copper,
    influence: decree.influence,
    food: decree.foodPerResident * Math.max(0, Math.floor(Number(population) || 0)),
    duration: decree.duration
  };
}

export function politicsDecreePreflight(state = {}, {
  decreeId = "", periodIndex = 1, available = false, moneyCopper = 0, foodAvailable = 0,
  population = 0, marketActive = false, patrolServiceActive = false,
  projectActive = false, publicTrialInstitutionActive = false, networkPaid = false,
  routeActive = false, productionActive = false, institutionActive = false,
  patronAgreementActive = false, rationFullySupplied = false,
  archetypeId = "", culture = 0, reputation = 0, technology = 0, balance = {}
} = {}) {
  const row = activeRow(balance, "decree", decreeId);
  const quote = politicsDecreeQuote(decreeId, population, balance);
  if (!quote) return { ok: false, reason: "Указ отсутствует в каталоге." };
  if (!available) return { ok: false, quote, reason: "Политика приостановлена." };
  const blockReasons = politicsRowBlockReasons(row, { archetypeId, culture, reputation, technology, marketActive, routeActive,
    patrolServiceActive, projectActive, productionActive, institutionActive,
    publicTrialInstitutionActive, networkPaid, patronAgreementActive, rationFullySupplied });
  if (blockReasons.length) return { ok: false, quote, reason: blockReasons.join(" ") };
  if (row.archetypeId && (state.activeDecrees ?? []).some((entry) =>
    periodIndex < Number(entry.expiresPeriodIndex)
    && politicsCatalogRow(balance, rowId("decree", entry.decreeId))?.archetypeId)) {
    return { ok: false, quote, reason: "Личный указ уже действует." };
  }
  const cooldownUntil = Math.max(0, Number(state.decreeCooldownUntil?.[decreeId]) || 0);
  if (periodIndex < cooldownUntil || (state.activeDecrees ?? []).some((decree) => (
    decree.decreeId === decreeId && periodIndex < Number(decree.expiresPeriodIndex)
  ))) return { ok: false, quote, nextAllowedPeriodIndex: Math.max(cooldownUntil, ...(state.activeDecrees ?? []).filter((entry) => entry.decreeId === decreeId).map((entry) => Number(entry.expiresPeriodIndex) || 0)), reason: "Повторное издание возможно после окончания оплаченного срока." };
  if (Math.max(0, Number(state.influence) || 0) < quote.influence) return { ok: false, quote, reason: "Недостаточно Влияния." };
  if (Math.max(0, Number(moneyCopper) || 0) < quote.copper) return { ok: false, quote, reason: "Недостаточно медных монет в казне." };
  if (Math.max(0, Number(foodAvailable) || 0) < quote.food) return { ok: false, quote, reason: "Недостаточно пригодной готовой пищи." };
  return { ok: true, quote, expiresPeriodIndex: periodIndex + quote.duration };
}

export function appendPoliticsHistory(state, entry) {
  const next = normalizePoliticsState(state);
  next.history = [...next.history, { ...entry }].slice(-250);
  return next;
}

export function changePoliticsDirective(state, {
  slot = "", directiveId = "", periodIndex = 1, available = false,
  operationId = "", actorId = "", balance = {}, archetypeId = "",
  culture = 0, reputation = 0, technology = 0, requirements = {}
} = {}) {
  const next = normalizePoliticsState(state);
  if (!available) return { ok: false, reason: "Политика приостановлена." };
  if (!politicsAllowedSlots(next, balance).includes(slot)) return { ok: false, reason: "Слот недоступен при текущей власти." };
  const row = directiveId ? activeRow(balance, "directive", directiveId) : null;
  if (directiveId && !row) return { ok: false, reason: "Директива отсутствует в каталоге." };
  if (row && row.slot && row.slot !== slot) return { ok: false, reason: "Директива относится к другому направлению." };
  if (row && !politicsRowUnlocked(row, { archetypeId, culture, reputation, technology, ...requirements })) {
    return { ok: false, reason: politicsRowBlockReasons(row, { archetypeId, culture, reputation, technology, ...requirements }).join(" ") };
  }
  if (row?.archetypeId && POLITICS_SLOTS.some((other) => other !== slot && activeRow(balance, "directive", next.directives[other])?.archetypeId)) {
    return { ok: false, reason: "Можно выбрать только одну личную директиву." };
  }
  if (next.directives[slot] === directiveId) return { ok: true, noop: true, state: next };
  if (next.directiveChangedPeriodIndex[slot] === periodIndex) return { ok: false, reason: "Этот слот уже менялся в текущем десятнике." };
  const previousId = next.directives[slot];
  next.directives[slot] = directiveId;
  next.directiveChangedPeriodIndex[slot] = periodIndex;
  next.history = [...next.history, {
    type: "directive", operationId, actorId, periodIndex, slot, previousId, directiveId,
    summary: `Директива «${{ supply: "Снабжение", order: "Порядок", labor: "Труд", external: "Внешний курс" }[slot] ?? slot}»: ${row?.label ?? "Обычный порядок"}.`
  }].slice(-250);
  return { ok: true, state: next };
}

export function advancePoliticsStateForPeriod(state, {
  periodIndex = 1, available = false, townHallActive = false, culture = 0,
  networkPaid = false, representativeCulture = 0, representativeExpired = false,
  operationId = "", balance = {}, perkCap = 0, influenceBlocked = null
} = {}) {
  const next = normalizePoliticsState(state);
  if (!Number.isInteger(periodIndex) || periodIndex < 1) return { ok: false, reason: "Некорректный десятник." };
  if (next.version > POLITICS_STATE_VERSION) return { ok: false, reason: "Данные Политики записаны более новой версией модуля." };
  if (periodIndex <= next.lastProcessedPeriodIndex) return { ok: true, replay: true, state: next, gained: 0, expiredDecreeIds: [] };
  if (next.lastProcessedPeriodIndex > 0 && periodIndex !== next.lastProcessedPeriodIndex + 1) {
    return { ok: false, reason: "Политические десятники должны обрабатываться последовательно." };
  }
  const gain = politicsInfluenceGain(next, {
    available, townHallActive, culture, networkPaid, representativeCulture, representativeExpired, balance, perkCap, influenceBlocked
  });
  next.influence += gain.gained;
  const expiredDecreeIds = [];
  next.activeDecrees = next.activeDecrees.filter((decree) => {
    if (periodIndex + 1 < Number(decree.expiresPeriodIndex)) return true;
    expiredDecreeIds.push(decree.decreeId);
    return false;
  });
  next.lastProcessedPeriodIndex = periodIndex;
  next.history = [...next.history, {
    type: "period", operationId, periodIndex, influenceGained: gain.gained, expiredDecreeIds,
    summary: `Влияние +${gain.gained}.${expiredDecreeIds.length ? ` Завершились указы: ${expiredDecreeIds.join(", ")}.` : ""}`
  }].slice(-250);
  return { ok: true, state: next, gained: gain.gained, expiredDecreeIds };
}

export function advancePoliticsStateForPeriods(state, periods = []) {
  let current = normalizePoliticsState(state);
  const results = [];
  for (const context of periods) {
    const result = advancePoliticsStateForPeriod(current, context);
    if (!result.ok) return { ok: false, reason: result.reason, completed: results.length };
    current = result.state;
    results.push({ periodIndex: context.periodIndex, gained: result.gained, expiredDecreeIds: result.expiredDecreeIds, replay: result.replay === true });
  }
  return { ok: true, state: current, results };
}

export function politicsEffects(holding = {}, {
  available = false, periodIndex = 1, marketActive = false, projectActive = false,
  patronAgreementActive = false, patrolServiceActive = false,
  publicTrialInstitutionActive = false, networkPaid = false, rationFullySupplied = false,
  routeActive = false, productionActive = false, institutionActive = false,
  culture = 0, reputation = 0, technology = 0, unpaidDirectiveIds = []
} = {}) {
  const state = normalizePoliticsState(holding.politics);
  const balance = balanceOf(holding);
  const core = resolvedPoliticsCore(balance);
  const effects = {
    reputation: 0, control: 0, unrestControl: 0, defense: 0, morale: 0, marketAccess: 0,
    externalFlowPercent: 0, productionPercent: 0, constructionPercent: 0,
    foodMultiplier: 1, influenceCap: 0, networkRequested: false, networkPaid: false,
    representativeCulture: 0, representativeExpired: false, influenceBlocked: false,
    activeDecreeIds: []
  };
  if (!available || state.version > POLITICS_STATE_VERSION) return effects;
  const catalog = new Map(resolvedPoliticsCatalog(balance).map((row) => [row.id, row]));
  const requirements = { marketActive, projectActive, patronAgreementActive, patrolServiceActive,
    publicTrialInstitutionActive, networkPaid, rationFullySupplied, routeActive, productionActive, institutionActive };
  const archetypeId = politicsRepresentativeArchetype(holding, state, periodIndex, catalog);
  const applies = (row) => politicsRowUnlocked(row, { archetypeId, culture: Math.max(culture, row?.cultureMin ?? 0),
    reputation: Math.max(reputation, row?.reputationMin ?? 0), technology: Math.max(technology, row?.technologyMin ?? 0), ...requirements });
  if (politicsSystemPermitted(state)) {
    const row = activeRow(balance, "system", state.system, catalog);
    if (applies(row)) addRowEffects(effects, row, { rationFullySupplied });
  }
  const representative = politicsRepresentativeStatus(state, holding, periodIndex, catalog);
  if (!representative.vacant && validatePoliticsCompetencies(state.representative.competencies).ok) {
    const skills = state.representative.competencies;
    const halve = (value) => representative.expired ? Math.trunc(value / 2) : value;
    effects.productionPercent += halve(skills.economy * core.economySkillPercent);
    effects.constructionPercent += halve(skills.economy * core.economySkillPercent);
    effects.defense += halve(skills.war * core.warSkillDefense);
    effects.marketAccess += halve(Math.trunc(skills.diplomacy / core.diplomacySkillDivisor));
    effects.morale += halve(skills.culture * core.cultureSkillMorale);
    effects.representativeCulture = skills.culture;
    effects.representativeExpired = representative.expired;
  }
  if (archetypeId) {
    for (const perk of [...catalog.values()].filter((row) => row.kind === "perk" && (!row.archetypeId || row.archetypeId === archetypeId) && applies(row))) {
      addRowEffects(effects, perk, { rationFullySupplied });
    }
  }
  const allowed = politicsAllowedSlots(state, balance);
  const unpaid = new Set(unpaidDirectiveIds);
  for (const slot of allowed) {
    const id = state.directives?.[slot];
    const row = politicsAppliedDirective(holding, state, slot, { available, periodIndex, ...requirements, culture, reputation, technology }, { catalog, archetypeId });
    if (row && !unpaid.has(id)) {
      addRowEffects(effects, row, { rationFullySupplied });
      if (id === "labor-festivals") effects.influenceBlocked = true;
    }
  }
  effects.networkRequested = allowed.includes("external") && state.directives?.external === "external-network"
    && Boolean(politicsAppliedDirective(holding, state, "external", { available, periodIndex, ...requirements, culture, reputation, technology }, { catalog, archetypeId }));
  effects.networkPaid = effects.networkRequested && networkPaid && !unpaid.has("external-network");
  for (const decree of politicsActiveDecrees(state, periodIndex, balance, catalog)) {
    const row = activeRow(balance, "decree", decree.decreeId, catalog);
    if (row && politicsRowUnlocked(row, { archetypeId: row.archetypeId, culture: Math.max(culture, row.cultureMin),
      reputation: Math.max(reputation, row.reputationMin), technology: Math.max(technology, row.technologyMin), ...requirements })) {
      addRowEffects(effects, row, { rationFullySupplied });
    }
    effects.activeDecreeIds.push(decree.decreeId);
  }
  effects.foodMultiplier = Math.max(0.5, Math.min(2, effects.foodMultiplier));
  return effects;
}
