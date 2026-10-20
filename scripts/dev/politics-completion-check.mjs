import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clone } from "../data/utils.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizePoliticsState } from "../data/politics-state.js";
import { applyPoliticsAct } from "../engines/politics/acts.js";
import { applyPoliticsBalanceEdit } from "../engines/politics/balance-edit.js";
import { appendPoliticsHistory, politicsAllowedSlots, politicsEffects, politicsRepresentativeStatus } from "../engines/politics/rules.js";
import { preparePoliticsPeriod, finishPoliticsPeriod, politicsPeriodTracked } from "../engines/politics/period.js";
import { politicsRouteAvailable } from "../engines/politics/route-context.js";
import { politicsDecisionContext } from "../apps/politics-decision-context.js";
import { executePoliticsOperation } from "../apps/politics-operation-executor.js";
import { createPoliticsSocketApi } from "../data/politics-socket.js";
import { politicsPermissionContext } from "../data/politics-permissions.js";
import { FinanceAgricultureDomain } from "../apps/domains/finance/agriculture-domain.js";
import { FinanceLivestockDomain } from "../apps/domains/finance/livestock-domain.js";
import { setPoliticsRuntimeEffects, politicsProductionBonus } from "../engines/politics/runtime-effects.js";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import { stableDataHash } from "../data/storage-commit.js";
import { buildTendayOperationPayload, hydrateTendayOperation } from "../engines/tenday/operation-payload.js";

const context = { available: true, culture: 30, reputation: 10, technology: 30, marketActive: true, networkPaid: true };
const fixture = (extra = {}) => mergeHoldingDefaults({ id: "completion", gm: { politicsCultureThreshold: 0, politicsIgnoreInstitutionRequirement: true }, ...extra });
const act = (holding, action, payload, id = action) => applyPoliticsAct(holding, { action, payload, operationId: id, actorId: "gm", context });

function checkRules() {
  const holding = fixture({ politics: { stage: "selfRule", influence: 4 } });
  let result = act(holding, "system", { system: "elder-council" });
  assert.equal(result.state.influence, 4);
  for (let index = 0; index < 260; index++) result.state = appendPoliticsHistory(result.state, { type: "note", summary: String(index) });
  holding.politics = normalizePoliticsState(clone(result.state));
  assert.equal(holding.politics.history.some((entry) => entry.type === "system"), false);
  assert.equal(act(holding, "system", { system: "elected-head" }).ok, false, "trimming history does not reset the cooldown");
  holding.gm.calendaria.lastQd = 120;
  result = act(holding, "system", { system: "elected-head" });
  assert.equal(result.ok, true);
  assert.equal(result.state.influence, 2, "trimming history does not restore a free choice");
  const legacy = normalizePoliticsState({ stage: "selfRule", system: "elder-council", history: [] });
  assert.equal(legacy.systemChange.chosenForStage, true, "a legacy selected system cannot gain a free choice");
  const balance = applyPoliticsBalanceEdit({}, "row", { id: "system:elected-head", fields: { duration: 4 }, slots: ["supply"] });
  assert.equal(balance.ok, true);
  holding.politics = result.state;
  holding.gm.politicsBalance = balance.balance;
  assert.deepEqual(politicsAllowedSlots(holding.politics, balance.balance), ["supply"]);
  holding.politics.directives.labor = "labor-rush";
  assert.equal(politicsEffects(holding, context).constructionPercent, 0, "a closed catalog slot contributes nothing");
  holding.people.list = [{ id: "leader", name: "Председатель", attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 } }];
  holding.politics.representative = { residentId: "leader", appointedPeriodIndex: 1, competencies: {} };
  assert.equal(politicsRepresentativeStatus(holding.politics, holding, 3).expiringSoon, true);
  const period = preparePoliticsPeriod(holding, { context, periodIndex: 2 });
  const finished = finishPoliticsPeriod(holding, period);
  assert.equal(finished.warnings.length, 1, "one warning at the two-period boundary");
  assert.equal(finishPoliticsPeriod(holding, period).warnings.length, 0, "replaying a finished period does not duplicate the term warning");
  const second = preparePoliticsPeriod(holding, { context, periodIndex: 3 });
  assert.equal(finishPoliticsPeriod(holding, second).warnings.length, 0, "the warning does not repeat next period");

  const intel = fixture({ politics: { activeDecrees: [{ decreeId: "intel-support", issuedPeriodIndex: 1, expiresPeriodIndex: 4 }] } });
  const request = applyPoliticsAct(intel, { action: "request-intel", operationId: "intel-request", payload: { topic: "Кто контролирует северный рынок?" }, context: { available: false } });
  assert.equal(request.ok, true, "paid intel remains usable while Politics is suspended");
  intel.politics = request.state;
  const used = applyPoliticsAct(intel, { action: "resolve-request", operationId: "intel-answer", payload: { id: "intel-request", approved: true, response: "Поговорите с управляющим караванами." }, context: { available: false } });
  assert.equal(used.ok, true);
  assert.equal(used.state.activeDecrees[0].used, true);
  assert.equal(used.state.decreeCooldownUntil["intel-support"], 4);
  intel.politics = used.state;
  assert.equal(act(intel, "use-decree", { decreeId: "intel-support", topic: "Повтор", response: "Повтор" }).ok, false);
  const cancelled = fixture({ politics: { activeDecrees: [{ decreeId: "fair", issuedPeriodIndex: 1, expiresPeriodIndex: 3 }] } });
  assert.equal(act(cancelled, "cancel-decree", { decreeId: "fair" }).ok, false);
  const cancel = act(cancelled, "cancel-decree", { decreeId: "fair", reason: "Рынок закрыт" });
  assert.equal(cancel.ok, true);
  assert.equal(cancel.state.decreeCooldownUntil.fair, 3);
  assert.equal(cancelled.politics.activeDecrees[0].cancelled, undefined, "pure preflight never mutates input");
}

async function checkCommands() {
  const gm = { id: "gm", isGM: true, active: true };
  const player = { id: "player", isGM: false, active: true };
  const other = { id: "other", isGM: false, active: true };
  const users = new Map([[gm.id, gm], [player.id, player], [other.id, other]]);
  users.contents = [...users.values()];
  const emitted = [];
  globalThis.game = { user: gm, users, socket: { emit: (channel, payload) => emitted.push(payload) } };
  let data = { meta: { revision: 0 }, holdings: [fixture({ gm: { politicsCultureThreshold: 0, politicsIgnoreInstitutionRequirement: true,
    playersCanIssueDecrees: true, playersCanUseDirectives: true }, storage: { moneyCopper: 1000 },
    politics: { stage: "charter", charter: { approvalRequired: true } } })] };
  let writes = 0;
  const store = { skipTransaction: (value) => ({ skip: true, value }), async updateHolding(id, updater) {
    const draft = clone(data);
    const result = updater(draft.holdings[0], draft);
    if (result?.skip) return result.value;
    draft.meta.revision++;
    data = draft;
    writes++;
    return result;
  } };
  const deps = { store, getUser: (id) => id ? users.get(id) : game.user, getManager: () => null };
  const command = { operationId: "request-festival", holdingId: "completion", expectedRevision: 0, action: "decree", payload: { decreeId: "festival", copper: 0, influence: -100 } };
  const request = await executePoliticsOperation(command, { ...deps, userId: player.id, remote: true });
  assert.equal(request.ok, true);
  assert.equal(data.holdings[0].storage.moneyCopper, 1000, "a patron request never charges money");
  assert.equal(data.holdings[0].politics.activeDecrees.length, 0);
  assert.equal((await executePoliticsOperation(command, { ...deps, userId: player.id, remote: true })).replay, true);
  assert.equal((await executePoliticsOperation(command, { ...deps, userId: other.id, remote: true })).ok, false, "another user cannot replay an operation ID");
  const approve = { operationId: "approve-festival", holdingId: "completion", expectedRevision: 1, action: "resolve-request",
    payload: { id: "request-festival", approved: true, response: "Патрон согласен" } };
  data.holdings[0].storage.moneyCopper = 0;
  assert.equal((await executePoliticsOperation(approve, deps)).ok, false, "approval rechecks current treasury");
  assert.equal(data.holdings[0].politics.pendingApprovals[0].status, "pending");
  data.holdings[0].storage.moneyCopper = 1000;
  data.holdings[0].gm.playersCanIssueDecrees = false;
  assert.equal((await executePoliticsOperation(approve, deps)).ok, false, "revoked player rights block approval");
  data.holdings[0].gm.playersCanIssueDecrees = true;
  assert.equal((await executePoliticsOperation(approve, deps)).ok, true);
  assert.equal(data.holdings[0].storage.moneyCopper, 800, "GM prices ignore client-supplied prices");
  assert.equal((await executePoliticsOperation(approve, deps)).replay, true);
  assert.equal(writes, 2);
  assert.equal((await executePoliticsOperation({ ...command, operationId: "player-system", expectedRevision: 2, action: "system", payload: { system: "elected-head" } }, { ...deps, userId: player.id, remote: true })).ok, false);
  data.holdings[0].gm.playersCanViewPolitics = false;
  assert.equal(politicsPermissionContext(data.holdings[0], { user: player }).canView, false);
  assert.equal((await executePoliticsOperation({ ...command, operationId: "hidden-petition", expectedRevision: 2, action: "petition", payload: { message: "Просьба" } }, { ...deps, userId: player.id, remote: true })).ok, false);
  data.holdings[0].gm.playersCanViewPolitics = true;
  data.holdings[0].politics.stage = "protectorate";
  assert.equal((await executePoliticsOperation({ ...command, operationId: "petition", expectedRevision: 2, action: "petition", payload: { message: "Просим принять хартию" } }, { ...deps, userId: player.id, remote: true })).ok, true);
  assert.equal(data.holdings[0].storage.moneyCopper, 800);
  const api = createPoliticsSocketApi({ getData: () => data, executePoliticsOperation: (raw, options) => executePoliticsOperation(raw, { ...deps, ...options }) });
  const envelope = { type: "playerPoliticsOperationRequest", requestId: "socket-petition", operationId: "socket-petition", expectedRevision: 3,
    targetGmId: gm.id, userId: player.id, operation: { holdingId: "completion", operationId: "socket-petition", expectedRevision: 3, action: "petition", payload: { message: "Вопрос по маршрутам" } } };
  await api.handlePoliticsPayload(envelope, other.id);
  assert.equal(emitted.length, 0, "forged socket user ID is ignored");
  await api.handlePoliticsPayload(envelope, player.id);
  assert.equal(emitted.at(-1).command.ok, true);
  await api.handlePoliticsPayload({ ...envelope, expectedRevision: 999 }, player.id);
  assert.equal(emitted.at(-1).command.ok, false, "mismatched socket metadata is rejected");
  globalThis.game.user = player;
  const pending = api.requestPoliticsOperation({ ...envelope.operation, operationId: "client-response" });
  await api.handlePoliticsPayload({ type: "playerPoliticsOperationResponse", requestId: "client-response", operationId: "client-response",
    userId: player.id, gmId: gm.id, command: { ok: true }, result: { ok: true } }, other.id);
  await api.handlePoliticsPayload({ type: "playerPoliticsOperationResponse", requestId: "client-response", operationId: "client-response",
    userId: player.id, gmId: gm.id, command: { ok: true }, result: { ok: true } }, gm.id);
  assert.equal((await pending).ok, true);
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let timerIndex = 0;
  try {
    globalThis.setTimeout = (callback) => { timers.set(++timerIndex, callback); return timerIndex; };
    globalThis.clearTimeout = (id) => timers.delete(id);
    const retried = api.requestPoliticsOperation({ ...envelope.operation, operationId: "authority-retry", expectedRevision: 4 });
    const firstEnvelope = emitted.at(-1);
    const nextGm = { id: "next-gm", isGM: true, active: true };
    users.set(nextGm.id, nextGm);
    users.contents.push(nextGm);
    gm.active = false;
    const timeout = timers.get(timerIndex);
    timers.delete(timerIndex);
    timeout();
    const retryEnvelope = emitted.at(-1);
    assert.equal(retryEnvelope.targetGmId, nextGm.id);
    assert.equal(retryEnvelope.operationId, firstEnvelope.operationId, "authority failover keeps the operation ID");
    assert.equal(retryEnvelope.expectedRevision, firstEnvelope.expectedRevision);
    game.user = gm;
    const messages = emitted.length;
    await api.handlePoliticsPayload(firstEnvelope, player.id);
    assert.equal(emitted.length, messages, "the previous GM cannot execute after authority changes");
    game.user = nextGm;
    await api.handlePoliticsPayload(retryEnvelope, player.id);
    const response = emitted.at(-1);
    game.user = player;
    await api.handlePoliticsPayload(response, nextGm.id);
    assert.equal((await retried).ok, true);
    assert.equal(timers.size, 0);
  } finally { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; }
}

function checkEconomyContext() {
  const holding = fixture({ overview: { region: "a" } });
  const data = { catalog: { eventRegions: [{ value: "a", marketLinks: [{ regionId: "b", ursCost: 2, modes: ["caravan"] }], marketTransportModes: ["caravan"] },
    { value: "b", marketTransportModes: ["caravan"] }] } };
  setPoliticsRuntimeEffects(holding, { marketAccess: 0 });
  holding.gm.modifiers.marketConnectionsLevel = 1;
  assert.equal(politicsRouteAvailable(holding, data), false);
  holding.gm.modifiers.marketConnectionsLevel = 2;
  assert.equal(politicsRouteAvailable(holding, data), true);
  data.catalog.eventRegions[1].marketTransportModes = ["airship"];
  assert.equal(politicsRouteAvailable(holding, data), false, "transport restrictions are real requirements");
  data.catalog.eventRegions[1].marketTransportModes = ["caravan"];
  data.catalog.eventRegions[1].marketEnabled = false;
  assert.equal(politicsRouteAvailable(holding, data), false);
  const guild = fixture({ overview: { region: "a" }, politics: { stage: "selfRule", system: "guild-council" },
    buildings: { list: [{ id: "market", templateId: "market", constructionStatus: "built" }] } });
  guild.gm.modifiers.marketConnectionsLevel = 0;
  data.catalog.eventRegions[0].marketLinks[0].ursCost = 1;
  data.catalog.eventRegions[1].marketEnabled = true;
  const guildContext = politicsDecisionContext(guild, { _developmentSummary: () => ({ totals: { culture: 30, technology: 30 } }) }, { data });
  assert.equal(guildContext.routeActive, true, "non-route political URS can unlock a real route without resolver recursion");
  holding.gm.moraleSnapshot = { ration: { fullySupplied: false } };
  holding.log = [{ type: "tenday", payload: { economy: { food: { needed: 10, eaten: 10, effectiveTier: 10, selectedTier: 10 } } } }];
  assert.equal(politicsDecisionContext(holding, null, { data }).rationFullySupplied, false, "production uses the previous actual snapshot, not a new forecast");
  const workerOwner = { ...FinanceAgricultureDomain, ...FinanceLivestockDomain,
    _activeAssignedBuildingPeople: () => [{ id: "worker" }], _buildingCompositionStatus: () => ({ met: true }),
    _personBuildingEfficiency: () => 1, _maintenanceEfficiencyFactor: () => 1, _personDailyWorkQdLimit: () => 2 };
  for (const method of ["_agricultureAvailableWorkQd", "_livestockAvailableWorkQd"]) {
    setPoliticsRuntimeEffects(holding, { productionPercent: 5 });
    assert.equal(workerOwner[method](holding, {}, 40), 21);
    setPoliticsRuntimeEffects(holding, { productionPercent: -5 });
    assert.equal(workerOwner[method](holding, {}, 40), 19);
    setPoliticsRuntimeEffects(holding, { productionPercent: -100 });
    assert.equal(workerOwner[method](holding, {}, 40), 0);
  }
  let units = 0;
  let total = 0;
  for (let index = 0; index < 20; index++) { const bonus = politicsProductionBonus(1, 5, units); units = bonus.remainderUnits; total += bonus.total; }
  assert.equal(total, 21);
  assert.equal(units, 0);
}

async function checkSequential() {
  game.user = { id: "gm", isGM: true };
  const source = fixture({ storage: { moneyCopper: 180 }, politics: { influence: 0, directives: { external: "external-network" },
    activeDecrees: [{ decreeId: "festival", issuedPeriodIndex: 1, expiresPeriodIndex: 2 }] } });
  const data = { meta: { revision: 1 }, holdings: [source], catalog: { eventRegions: [], resources: [] } };
  const owner = { ...EconomyEventDomain, _safeNumber: (value, fallback = 0) => Number(value) || fallback,
    _developmentSummary: () => ({ totals: { culture: 30 } }), _formatNumber: String, _formatCopperCurrency: String,
    _isFoodResource: () => false, _storageRoomLabel: () => "Склад", _tendayReadinessContext: async () => ({}),
    _checkCalendariaEconomyAdvance: () => ({ ok: true, snapshot: { available: false } }),
    _commitCalendariaEconomyAdvance: () => ({}), _advanceResidentRecovery: () => ({ recovered: 0 }),
    _appendEconomyStorageLog: (holding, report) => report,
    _prepareTendayRandomEvents: () => ({ entries: [], events: [], warnings: [] }),
    async _runEconomyForQd(holding, qd, options) {
      const periodIndex = holding.gm.calendaria.lastQd / 40 + 1;
      const prepared = preparePoliticsPeriod(holding, { periodIndex, context: { ...context, available: !holding.politics.unresolvedRevolt } });
      const result = finishPoliticsPeriod(holding, prepared, { operationId: options.operationId });
      assert.equal(result.ok, true);
      return { produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], ledger: [],
        food: { needed: 10, eaten: 10, hungryResidentDays: 0, lines: [] }, treasury: { spent: prepared.charges.reduce((sum, row) => sum + row.copper, 0), lines: [] },
        politics: { effects: prepared.effects, charges: prepared.charges, influenceGained: result.results.reduce((sum, row) => sum + row.gained, 0), expiredDecreeIds: result.results.flatMap((row) => row.expiredDecreeIds) } };
    } };
  const before = stableDataHash(data);
  const batch = await owner._prepareTendayOperation({ holdingId: source.id, qd: 120, dataView: data, operationId: "batch", preparedAt: "fixed" });
  assert.equal(batch.ok, true);
  assert.equal(stableDataHash(data), before, "Preview does not write source world data");
  let sequential = data;
  for (let index = 0; index < 3; index++) {
    const period = await owner._prepareTendayOperation({ holdingId: source.id, qd: 40, dataView: sequential, operationId: `batch-p${index + 1}`, preparedAt: "fixed" });
    sequential = { ...data, holdings: [period.preparedHolding] };
  }
  assert.deepEqual(batch.preparedHolding, sequential.holdings[0], "batch draft equals three successive single-period drafts");
  assert.equal(batch.report.food.needed, 30);
  assert.equal(batch.report.politics.charges.length, 3);
  assert.equal(batch.preparedHolding.storage.moneyCopper, 0);
  assert.deepEqual(batch.report.politics.periods.map((period) => period.effects.morale), [3, 0, 0], "decree expiry is evaluated separately in each period");
  const historical = hydrateTendayOperation({ type: "tenday", operationId: batch.operationId, payload: buildTendayOperationPayload(batch) });
  assert.equal(historical.report.politics.periods.length, 3);
  const paused = clone(data);
  paused.holdings[0].politics.unresolvedRevolt = true;
  paused.holdings[0].politics.lastProcessedPeriodIndex = 1;
  paused.holdings[0].gm.calendaria.lastQd = 40;
  const noEffects = await owner._prepareTendayOperation({ holdingId: source.id, qd: 80, dataView: paused });
  assert.equal(noEffects.ok, true, "past politics and suspended effects no longer block batch preparation");
  assert.equal(politicsPeriodTracked(fixture({ politics: { representative: { residentId: "leader" } } })), true,
    "a suspended representative still requires per-period term processing");
  assert.equal(politicsPeriodTracked(fixture({ politics: { history: [{ type: "petition" }] } })), true);
  const eventOwner = { ...owner, _prepareTendayRandomEvents(holding, { operationId }) {
    const events = operationId.endsWith("-p1") ? [{ title: "Первое событие", effects: [{ type: "money", amount: 10 }],
      decisionId: `${operationId}:event:1`, effectStatus: "pending" }] : [];
    holding.gm.lastRoll = { kind: "tenday", events, effects: events.flatMap((event) => event.effects), effectStatus: events.length ? "pending" : "none" };
    return { events, entries: [], warnings: [], lastRoll: holding.gm.lastRoll };
  } };
  const eventBatch = await eventOwner._prepareTendayOperation({ holdingId: source.id, qd: 120, dataView: data, operationId: "events" });
  assert.equal(eventBatch.preparedHolding.gm.lastRoll.effectStatus, "pending", "an earlier period's event remains actionable after a quiet final period");
  assert.equal(eventBatch.preparedHolding.gm.lastRoll.events[0].decisionId, "events-p1:event:1");
  const crowded = { ...eventOwner, _prepareTendayRandomEvents: () => ({ events: Array.from({ length: 21 }, () => ({ effects: [] })), entries: [] }) };
  assert.equal((await crowded._prepareTendayOperation({ holdingId: source.id, qd: 80, dataView: data })).blocked, true,
    "a batch cannot silently drop events beyond the retained decision limit");
}

export async function checkPoliticsCompletion() {
  const previousGame = globalThis.game;
  try { checkRules(); await checkCommands(); checkEconomyContext(); await checkSequential(); }
  finally { if (previousGame === undefined) delete globalThis.game; else globalThis.game = previousGame; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPoliticsCompletion();
  console.log("Politics completion: durable systems, catalog slots, requests/cards, player commands, routes, work, food and sequential periods passed.");
}
