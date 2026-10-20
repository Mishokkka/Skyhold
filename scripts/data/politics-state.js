import { clone, isPlainObject, mergeDefaults } from "./utils.js";

export const POLITICS_STATE_VERSION = 1;
export const POLITICS_SLOTS = ["supply", "order", "labor", "external"];
export const POLITICS_COMPETENCIES = ["economy", "war", "diplomacy", "culture"];

const DEFAULT_CHARTER_SLOTS = ["supply", "order", "external"];

export function createDefaultPoliticsState() {
  return {
    version: POLITICS_STATE_VERSION,
    stage: "protectorate",
    patronName: "",
    charter: {
      terms: "",
      allowedSlots: [...DEFAULT_CHARTER_SLOTS],
      approvalRequired: false,
      tributeCopper: 0,
      tributeStartPeriodIndex: null,
      tributeEndPeriodIndex: null
    },
    system: "governor",
    governorInvited: false,
    systemChange: { chosenForStage: false, lastChangedPeriodIndex: null },
    representative: {
      residentId: "",
      title: "",
      note: "",
      appointedPeriodIndex: null,
      competencies: { economy: 0, war: 0, diplomacy: 0, culture: 0 }
    },
    unresolvedRevolt: false,
    influence: 0,
    lastProcessedPeriodIndex: 0,
    lastNetworkPaidPeriodIndex: 0,
    directives: { supply: "", order: "", labor: "", external: "" },
    directiveChangedPeriodIndex: {},
    activeDecrees: [],
    decreeCooldownUntil: {},
    petitions: [],
    pendingApprovals: [],
    history: []
  };
}

function periodOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function nonnegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(0, number) : fallback;
}

/** Add missing v1 fields without discarding unknown catalog IDs or history. */
export function normalizePoliticsState(value) {
  const source = isPlainObject(value) ? value : {};
  const state = mergeDefaults(createDefaultPoliticsState(), source);
  state.version = Math.max(POLITICS_STATE_VERSION, nonnegativeInteger(source.version, POLITICS_STATE_VERSION));
  state.stage = String(state.stage ?? "protectorate");
  state.patronName = String(state.patronName ?? "");
  state.system = String(state.system ?? "governor");
  state.governorInvited = state.governorInvited === true;
  if (isPlainObject(source.systemChange)) {
    state.systemChange = { ...source.systemChange, chosenForStage: source.systemChange.chosenForStage === true,
      lastChangedPeriodIndex: periodOrNull(source.systemChange.lastChangedPeriodIndex) };
  } else {
    const history = Array.isArray(source.history) ? source.history : [];
    const stageIndex = history.findLastIndex((entry) => entry?.type === "stage");
    const systemIndex = history.findLastIndex((entry) => entry?.type === "system");
    const selected = state.system !== "governor" || state.governorInvited;
    state.systemChange = { chosenForStage: systemIndex > stageIndex || selected,
      lastChangedPeriodIndex: systemIndex > stageIndex ? periodOrNull(history[systemIndex].periodIndex) : null };
  }
  state.unresolvedRevolt = state.unresolvedRevolt === true;
  state.influence = nonnegativeInteger(state.influence);
  state.lastProcessedPeriodIndex = nonnegativeInteger(state.lastProcessedPeriodIndex);
  state.lastNetworkPaidPeriodIndex = nonnegativeInteger(state.lastNetworkPaidPeriodIndex);

  state.charter = mergeDefaults(createDefaultPoliticsState().charter, isPlainObject(source.charter) ? source.charter : {});
  state.charter.terms = String(state.charter.terms ?? "");
  state.charter.allowedSlots = Array.isArray(state.charter.allowedSlots)
    ? [...new Set(state.charter.allowedSlots.map(String).filter((slot) => POLITICS_SLOTS.includes(slot)))]
    : [...DEFAULT_CHARTER_SLOTS];
  state.charter.approvalRequired = state.charter.approvalRequired === true;
  state.charter.tributeCopper = nonnegativeInteger(state.charter.tributeCopper);
  state.charter.tributeStartPeriodIndex = periodOrNull(state.charter.tributeStartPeriodIndex);
  state.charter.tributeEndPeriodIndex = periodOrNull(state.charter.tributeEndPeriodIndex);

  state.representative = mergeDefaults(createDefaultPoliticsState().representative, isPlainObject(source.representative) ? source.representative : {});
  state.representative.residentId = String(state.representative.residentId ?? "");
  state.representative.title = String(state.representative.title ?? "");
  state.representative.note = String(state.representative.note ?? "");
  state.representative.appointedPeriodIndex = periodOrNull(state.representative.appointedPeriodIndex);
  for (const key of POLITICS_COMPETENCIES) {
    const number = Number(state.representative.competencies?.[key]);
    state.representative.competencies[key] = Number.isInteger(number) && number >= -2 && number <= 3 ? number : 0;
  }

  for (const slot of POLITICS_SLOTS) state.directives[slot] = String(state.directives?.[slot] ?? "");
  state.directiveChangedPeriodIndex = isPlainObject(state.directiveChangedPeriodIndex) ? clone(state.directiveChangedPeriodIndex) : {};
  state.decreeCooldownUntil = isPlainObject(state.decreeCooldownUntil) ? clone(state.decreeCooldownUntil) : {};
  for (const key of Object.keys(state.directiveChangedPeriodIndex)) {
    const period = periodOrNull(state.directiveChangedPeriodIndex[key]);
    if (period === null) delete state.directiveChangedPeriodIndex[key];
    else state.directiveChangedPeriodIndex[key] = period;
  }
  for (const key of Object.keys(state.decreeCooldownUntil)) {
    const period = periodOrNull(state.decreeCooldownUntil[key]);
    if (period === null) delete state.decreeCooldownUntil[key];
    else state.decreeCooldownUntil[key] = period;
  }
  for (const key of ["activeDecrees", "petitions", "pendingApprovals", "history"]) {
    state[key] = Array.isArray(state[key]) ? clone(state[key]).filter((row) => isPlainObject(row)) : [];
  }
  return state;
}
