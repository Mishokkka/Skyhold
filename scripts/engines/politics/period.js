import { politicsCatalogRow } from "../../data/politics-balance.js";
import { normalizePoliticsState, POLITICS_STATE_VERSION } from "../../data/politics-state.js";
import { vacatePoliticsRepresentative } from "../../data/resident-assignments.js";
import { makeFinanceObligation } from "../economy/finance-obligations.js";
import { advancePoliticsStateForPeriods, politicsAllowedSlots, politicsEffects,
  politicsRepresentativeArchetype, politicsRepresentativeStatus, politicsAppliedDirective } from "./rules.js";
import { setPoliticsRuntimeEffects } from "./runtime-effects.js";

function catalogId(id = "") { return id.startsWith("custom-") ? id : `directive:${id}`; }

export function politicsPeriodTracked(holding, context = {}) {
  const state = normalizePoliticsState(holding?.politics);
  return context.available === true || state.lastProcessedPeriodIndex > 0
    || Boolean(state.representative.residentId) || state.activeDecrees.length > 0
    || state.history.some((entry) => entry.type !== "period")
    || state.charter.tributeStartPeriodIndex > 0;
}

/** A charter debt is independent of the current directive and political availability. */
export function politicsTributeObligation(holding, { periodKey = "", periodIndex = 0, operationId = "", createdAt = "" } = {}) {
  const charter = normalizePoliticsState(holding?.politics).charter;
  const start = charter.tributeStartPeriodIndex;
  const end = charter.tributeEndPeriodIndex;
  if (!start || periodIndex < start || (end && periodIndex > end) || !charter.tributeCopper) return null;
  return makeFinanceObligation({
    kind: "politics-tribute", recipientKind: "patron", recipientId: String(holding?.id ?? ""),
    sourceId: "charter", periodKey, periodIndex, dueCopper: charter.tributeCopper,
    gmPriority: 450, createdAt, operationId,
    meta: { recipientName: String(holding?.politics?.patronName ?? "").trim() || "Патрон", source: "Хартия" }
  });
}

/** Called on the isolated tenday draft after priority wages and building maintenance. */
export function preparePoliticsPeriod(holding, { context = {}, periodIndex = 1, periods = 1 } = {}) {
  const state = normalizePoliticsState(holding.politics);
  if (state.version > POLITICS_STATE_VERSION) throw new Error("Данные Политики записаны более новой версией модуля.");
  const balance = holding?.gm?.politicsBalance ?? {};
  const tracked = politicsPeriodTracked(holding, context);
  const charges = [];
  const unpaidDirectiveIds = [];
  if (context.available === true) {
    for (const slot of politicsAllowedSlots(state, holding?.gm?.politicsBalance)) {
      const directiveId = state.directives?.[slot];
      if (!directiveId) continue;
      const row = politicsAppliedDirective(holding, state, slot, { ...context, periodIndex });
      if (!row) continue;
      const copper = Math.max(0, row.upkeepCopper * periods);
      if (!copper) continue;
      const treasury = Math.max(0, Math.floor(Number(holding?.storage?.moneyCopper) || 0));
      if (treasury < copper) { unpaidDirectiveIds.push(directiveId); continue; }
      holding.storage.moneyCopper = treasury - copper;
      charges.push({ slot, directiveId, label: row.label, copper });
    }
  }
  const networkRow = politicsAppliedDirective(holding, state, "external", { ...context, periodIndex });
  const networkPaid = context.available === true && state.directives?.external === "external-network"
    && Boolean(networkRow) && networkRow.enabled !== false
    && !unpaidDirectiveIds.includes("external-network");
  const effectiveContext = { ...context, periodIndex, networkPaid, unpaidDirectiveIds };
  const effects = politicsEffects(holding, effectiveContext);
  setPoliticsRuntimeEffects(holding, effects);
  return { ...effectiveContext, effects, charges, balance, tracked };
}

/** Food security is known only after the normal food phase. */
export function refreshPoliticsPeriodEffects(holding, prepared, { rationFullySupplied = prepared.rationFullySupplied ?? false, context = {} } = {}) {
  Object.assign(prepared, context, { rationFullySupplied });
  const effects = politicsEffects(holding, prepared);
  prepared.effects = effects;
  setPoliticsRuntimeEffects(holding, effects);
  return effects;
}

export function finishPoliticsPeriod(holding, prepared, { periods = 1, operationId = "" } = {}) {
  let state = normalizePoliticsState(holding.politics);
  if (state.version > POLITICS_STATE_VERSION) return { ok: false, reason: "Данные Политики записаны более новой версией модуля." };
  if (!prepared.tracked) return { ok: true, skipped: true, results: [] };
  if (state.representative.residentId && politicsRepresentativeStatus(state, holding, prepared.periodIndex).vacant) {
    const vacancyDraft = { ...holding, politics: state };
    vacatePoliticsRepresentative(vacancyDraft, state.representative.residentId, "назначенный житель погиб или больше не принадлежит владению");
    state = vacancyDraft.politics;
  }
  const contexts = Array.from({ length: periods }, (_, offset) => {
    const periodIndex = prepared.periodIndex + offset;
    const effects = politicsEffects(holding, { ...prepared, periodIndex });
    return { periodIndex, available: prepared.available, townHallActive: prepared.townHallActive,
      culture: prepared.culture, networkPaid: effects.networkPaid,
      representativeCulture: effects.representativeCulture,
      representativeExpired: effects.representativeExpired, perkCap: effects.influenceCap,
      influenceBlocked: effects.influenceBlocked,
      balance: prepared.balance, operationId };
  });
  const result = advancePoliticsStateForPeriods(state, contexts);
  if (!result.ok) return result;
  if (prepared.effects.networkPaid) result.state.lastNetworkPaidPeriodIndex = prepared.periodIndex + periods - 1;
  const nextPeriodIndex = prepared.periodIndex + periods;
  const beforeTerm = politicsRepresentativeStatus(state, holding, prepared.periodIndex);
  const afterTerm = politicsRepresentativeStatus(result.state, holding, nextPeriodIndex);
  const warnings = [];
  if (result.results.some((entry) => !entry.replay)) {
    if (!beforeTerm.vacant && !beforeTerm.expired && afterTerm.expired) warnings.push(`Срок представителя ${beforeTerm.resident.name || "поселения"} истёк: требуется переизбрание.`);
    else if (afterTerm.expiringSoon && beforeTerm.remainingPeriods > 2) warnings.push(`Срок представителя ${afterTerm.resident.name || "поселения"} заканчивается в десятнике ${afterTerm.expiresPeriodIndex}: осталось два десятника.`);
  }
  for (const summary of warnings) result.state.history.push({ type: "representative-term", operationId, periodIndex: nextPeriodIndex, summary });
  const archetypeId = politicsRepresentativeArchetype(holding, result.state, nextPeriodIndex);
  for (const slot of politicsAllowedSlots(result.state, prepared.balance)) {
    const directiveId = result.state.directives?.[slot];
    const row = directiveId && politicsCatalogRow(prepared.balance, catalogId(directiveId));
    if (!row?.archetypeId || row.archetypeId === archetypeId) continue;
    result.state.directives[slot] = "";
    result.state.history.push({ type: "directive-cleared", operationId,
      periodIndex: nextPeriodIndex, slot, directiveId,
      summary: `Личная директива «${row.label}» снята: представитель больше не соответствует её типажу.` });
  }
  result.state.history = result.state.history.slice(-250);
  holding.politics = result.state;
  return { ok: true, results: result.results, state: result.state, warnings };
}
