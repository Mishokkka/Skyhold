import { normalizePoliticsState, POLITICS_COMPETENCIES, POLITICS_SLOTS, POLITICS_STATE_VERSION } from "../../data/politics-state.js";
import { politicsCatalogRow, resolvedPoliticsCore } from "../../data/politics-balance.js";
import { appendPoliticsHistory, changePoliticsDirective, politicsAllowedSlots, politicsPeriodIndex,
  politicsDecreePreflight, politicsRepresentativeArchetype, politicsRepresentativeStatus, politicsRowUnlocked, validatePoliticsCompetencies } from "./rules.js";
import { politicsReadyFood, preparePoliticsDecreePayment } from "./decree-payment.js";
import { applyPoliticsWorkflow, POLITICS_WORKFLOW_ACTIONS } from "./requests.js";

const STAGES = new Set(["protectorate", "charter", "selfRule"]);
const STAGE_LABELS = { protectorate: "Протекторат", charter: "Хартия", selfRule: "Самоуправление" };

function boundedText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function periodOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function reject(reason) { return { ok: false, reason }; }

export function applyPoliticsAct(holding, { action, payload = {}, operationId = "", actorId = "", context = {} } = {}) {
  const state = normalizePoliticsState(holding?.politics);
  if (state.version > POLITICS_STATE_VERSION) return reject("Данные Политики записаны более новой версией модуля.");
  if (POLITICS_WORKFLOW_ACTIONS.has(action)) return applyPoliticsWorkflow(holding,
    { action, payload, operationId, actorId, context }, (intent) => applyPoliticsAct(holding, { ...intent, operationId, actorId, context }));
  const periodIndex = politicsPeriodIndex(holding?.gm?.calendaria?.lastQd);
  let summary = "";
  let detail = {};
  let storage = null;

  if (action === "stage") {
    const stage = String(payload.stage ?? "");
    const reason = boundedText(payload.reason, 500);
    if (!STAGES.has(stage)) return reject("Неизвестная стадия Политики.");
    if (!reason) return reject("Укажите сюжетную причину изменения стадии.");
    if (state.stage === stage) return reject("Эта стадия уже действует.");
    const previousStage = state.stage;
    state.stage = stage;
    state.systemChange = { chosenForStage: false, lastChangedPeriodIndex: null };
    if (stage !== "selfRule") {
      state.system = "governor";
      state.governorInvited = false;
    }
    summary = `Стадия: ${STAGE_LABELS[previousStage] ?? previousStage} → ${STAGE_LABELS[stage]}. ${reason}`;
    detail = { previousStage, stage, reason };
  } else if (action === "charter") {
    const rawSlots = Array.isArray(payload.allowedSlots) ? payload.allowedSlots : [];
    if (rawSlots.some((slot) => !POLITICS_SLOTS.includes(String(slot)))) return reject("Неизвестный слот хартии.");
    const tributeCopper = Number(payload.tributeCopper);
    if (!Number.isSafeInteger(tributeCopper) || tributeCopper < 0 || tributeCopper > 100000000) return reject("Укажите корректный размер дани в ММ.");
    const start = periodOrNull(payload.tributeStartPeriodIndex);
    const end = periodOrNull(payload.tributeEndPeriodIndex);
    if (payload.tributeStartPeriodIndex && start === null) return reject("Некорректный начальный десятник дани.");
    if (payload.tributeEndPeriodIndex && end === null) return reject("Некорректный конечный десятник дани.");
    if (end !== null && (start === null || end < start)) return reject("Конец дани должен быть не раньше её начала.");
    if (tributeCopper > 0 && start === null) return reject("Укажите первый десятник для дани.");
    const nextCharter = {
      ...state.charter,
      terms: boundedText(payload.terms, 2000),
      allowedSlots: [...new Set(rawSlots.map(String))],
      approvalRequired: payload.approvalRequired === true,
      tributeCopper,
      tributeStartPeriodIndex: start,
      tributeEndPeriodIndex: end
    };
    const patronName = boundedText(payload.patronName, 100);
    if (JSON.stringify(nextCharter) === JSON.stringify(state.charter) && patronName === state.patronName) return reject("Условия хартии не изменились.");
    state.charter = nextCharter;
    state.patronName = patronName;
    summary = "ГМ обновил условия хартии и покровительства.";
    detail = { patronName, allowedSlots: nextCharter.allowedSlots, approvalRequired: nextCharter.approvalRequired, tributeCopper, start, end };
  } else if (action === "representative") {
    const residentId = boundedText(payload.residentId, 100);
    const resident = residentId ? (holding?.people?.list ?? []).find((person) => String(person?.id ?? "") === residentId && !person?.dead) : null;
    if (residentId && !resident) return reject("Выберите живого жителя этого поселения.");
    const competencies = Object.fromEntries(POLITICS_COMPETENCIES.map((key) => [key, Number(payload.competencies?.[key]) ]));
    const validated = validatePoliticsCompetencies(competencies);
    if (residentId && !validated.ok) return reject(validated.reason);
    const previousResidentId = state.representative.residentId;
    const nextRepresentative = residentId ? {
      ...state.representative,
      residentId,
      title: boundedText(payload.title, 100),
      note: boundedText(payload.note, 1000),
      appointedPeriodIndex: previousResidentId === residentId ? state.representative.appointedPeriodIndex : periodIndex,
      competencies: validated.values
    } : {
      ...state.representative,
      residentId: "", title: "", note: "", appointedPeriodIndex: null,
      competencies: { economy: 0, war: 0, diplomacy: 0, culture: 0 }
    };
    if (JSON.stringify(nextRepresentative) === JSON.stringify(state.representative)) return reject("Назначение не изменилось.");
    state.representative = nextRepresentative;
    summary = residentId ? `Представитель: ${boundedText(resident.name, 100)}.` : "Должность представителя освобождена.";
    detail = { previousResidentId, residentId, title: nextRepresentative.title, competencies: nextRepresentative.competencies };
  } else if (action === "renew-representative") {
    const status = politicsRepresentativeStatus(state, holding, periodIndex);
    if (status.vacant || !status.expired) return reject("Переизбрание доступно живому представителю после окончания срока.");
    if (!validatePoliticsCompetencies(state.representative.competencies).ok) return reject("Сначала исправьте компетенции представителя.");
    const previousAppointedPeriodIndex = state.representative.appointedPeriodIndex;
    state.representative.appointedPeriodIndex = periodIndex;
    summary = `Представитель ${boundedText(status.resident.name, 100)} переизбран с десятника ${periodIndex}.`;
    detail = { residentId: state.representative.residentId, previousAppointedPeriodIndex };
  } else if (action === "system") {
    const system = String(payload.system ?? "");
    const balance = holding?.gm?.politicsBalance ?? {};
    const row = politicsCatalogRow(balance, `system:${system}`);
    if (context.available !== true) return reject("Политика приостановлена.");
    if (state.stage !== "selfRule") return reject("Систему можно выбрать на стадии самоуправления.");
    if (!row || !["governor", "elder-council", "elected-head", "guild-council"].includes(system)) return reject("Неизвестная система правления.");
    if (state.system === system && (system !== "governor" || state.governorInvited)) return reject("Эта система уже действует.");
    if (system === "governor" && payload.governorInvited !== true) return reject("Для наместника требуется явное приглашение ГМа.");
    if (!politicsRowUnlocked(row, context)) return reject("Условия системы правления не выполнены.");
    const firstForStage = !state.systemChange.chosenForStage;
    const core = resolvedPoliticsCore(balance);
    const exception = payload.exception === true;
    const reason = boundedText(payload.reason, 500);
    if (exception && !reason) return reject("Для сюжетного исключения укажите причину.");
    if (!firstForStage && !exception && state.systemChange.lastChangedPeriodIndex !== null
      && periodIndex < state.systemChange.lastChangedPeriodIndex + core.systemChangeCooldown) {
      return reject("Срок между сменами системы ещё не прошёл.");
    }
    const price = firstForStage || exception ? 0 : core.systemChangeInfluence;
    if (state.influence < price) return reject("Недостаточно Влияния для смены системы.");
    const previousSystem = state.system;
    state.influence -= price;
    state.system = system;
    state.governorInvited = system === "governor";
    state.systemChange = { chosenForStage: true, lastChangedPeriodIndex: periodIndex };
    summary = `Система правления: ${previousSystem} → ${row.label}${exception ? ` (исключение: ${reason})` : ""}.`;
    detail = { previousSystem, system, influenceSpent: price, exception, reason };
  } else if (action === "directive") {
    const slot = String(payload.slot ?? "");
    const directiveId = String(payload.directiveId ?? "");
    const changed = changePoliticsDirective(state, {
      slot, directiveId, periodIndex, available: context.available === true,
      operationId, actorId, balance: holding?.gm?.politicsBalance,
      archetypeId: politicsRepresentativeArchetype(holding, state, periodIndex),
      culture: context.culture ?? 0, reputation: context.reputation ?? 0,
      technology: context.technology ?? 0, requirements: context
    });
    if (!changed.ok) return changed;
    if (changed.noop) return { ok: true, noop: true, state, summary: "Директива уже выбрана." };
    summary = changed.state.history.at(-1).summary;
    return { ok: true, state: changed.state, summary };
  } else if (action === "decree") {
    const decreeId = String(payload.decreeId ?? "");
    const balance = holding?.gm?.politicsBalance ?? {};
    const row = politicsCatalogRow(balance, decreeId.startsWith("custom-") ? decreeId : `decree:${decreeId}`);
    const population = (holding?.people?.list ?? []).filter((person) => !person?.dead).length;
    const preflight = politicsDecreePreflight(state, {
      decreeId, periodIndex, available: context.available === true,
      moneyCopper: holding?.storage?.moneyCopper, foodAvailable: politicsReadyFood(holding), population,
      archetypeId: politicsRepresentativeArchetype(holding, state, periodIndex),
      culture: context.culture ?? 0, reputation: context.reputation ?? 0, technology: context.technology ?? 0,
      balance, ...context
    });
    if (!preflight.ok) return reject(preflight.reason);
    const payment = preparePoliticsDecreePayment(holding, preflight.quote);
    if (!payment) return reject("Не удалось зарезервировать оплату указа.");
    storage = payment.storage;
    state.influence -= preflight.quote.influence;
    state.activeDecrees.push({ decreeId, issuedPeriodIndex: periodIndex,
      expiresPeriodIndex: preflight.expiresPeriodIndex, operationId });
    state.decreeCooldownUntil[decreeId] = preflight.expiresPeriodIndex;
    summary = `Издан указ «${row.label}» до десятника ${preflight.expiresPeriodIndex}: −${preflight.quote.copper} ММ, −${preflight.quote.influence} Влияния${preflight.quote.food ? `, −${preflight.quote.food} пищи` : ""}.`;
    detail = { decreeId, quote: preflight.quote, expiresPeriodIndex: preflight.expiresPeriodIndex,
      foodTaken: payment.taken };
  } else if (action === "influence") {
    const delta = Number(payload.delta);
    const reason = boundedText(payload.reason, 500);
    if (!Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 1000) return reject("Изменение Влияния должно быть целым числом от −1000 до 1000, кроме нуля.");
    if (!reason) return reject("Укажите причину изменения Влияния.");
    if (state.influence + delta < 0) return reject("Влияние не может стать отрицательным.");
    state.influence += delta;
    summary = `ГМ изменил Влияние на ${delta > 0 ? "+" : ""}${delta}. ${reason}`;
    detail = { delta, reason, influence: state.influence };
  } else {
    return reject("Неизвестное политическое действие.");
  }

  const clearedSlots = [];
  const currentArchetypeId = politicsRepresentativeArchetype(holding, state, periodIndex);
  for (const slot of POLITICS_SLOTS) {
    const selected = state.directives[slot];
    const selectedRow = selected ? politicsCatalogRow(holding?.gm?.politicsBalance ?? {},
      selected.startsWith("custom-") ? selected : `directive:${selected}`) : null;
    if (selected && (!politicsAllowedSlots(state, holding?.gm?.politicsBalance).includes(slot)
      || (selectedRow?.archetypeId && selectedRow.archetypeId !== currentArchetypeId))) {
      clearedSlots.push({ slot, directiveId: state.directives[slot] });
      state.directives[slot] = "";
      delete state.directiveChangedPeriodIndex[slot];
    }
  }
  return {
    ok: true,
    state: appendPoliticsHistory(state, {
      type: action, operationId, actorId, periodIndex, summary, ...detail, clearedSlots
    }),
    summary,
    ...(storage ? { storage } : {})
  };
}
