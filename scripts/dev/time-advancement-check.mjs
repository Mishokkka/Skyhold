import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import { SkyholdData } from "../data/store.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { stableDataHash } from "../data/storage-commit.js";
import { addCalendariaQd, timestampForCalendariaDate } from "../integrations/calendaria-bridge.js";
import { combineTendayReports } from "../engines/tenday/sequential.js";
import { createEconomyHarness, makeHolding } from "./economy-characterization-check.mjs";
import { hybridRuntimeFixture } from "./hybrid-labor-runtime-check.mjs";
import { BANK_PRESETS } from "../data/banks.js";
import { issueBankLoan } from "../engines/economy/banking.js";
import { openBankDeposit } from "../engines/economy/bank-deposits.js";
import { createShipRecord } from "../data/ships.js";
import { departShip } from "../engines/ships/runtime.js";
import { previewSharedMarketMigration, applySharedMarketMigration } from "../data/market/shared-migration.js";
import { reserveMarketStock } from "../engines/market/stock.js";
import { reserveMarketDemand, settleMarketDemandReservations } from "../engines/market/demand.js";
import { buildTendayOperationPayload, hydrateTendayOperation } from "../engines/tenday/operation-payload.js";

function calendarFixture(hoursPerDay = 24) {
  const months = ["Хладоход", "Теплорост", "Теплоход", "Зноерост", "Зноеход", "Дождерост", "Дождеход", "Хладорост"];
  const dateToTimestamp = (date) => ((date.year * 240 + (date.month - 1) * 30 + date.day - 1) * hoursPerDay + (date.hour ?? 0)) * 3600 + (date.minute ?? 0) * 60;
  const timestampToDate = (timestamp) => {
    const days = Math.floor(timestamp / (hoursPerDay * 3600));
    const year = Math.floor(days / 240);
    const dayOfYear = days - year * 240;
    return { year, month: Math.floor(dayOfYear / 30) + 1, day: dayOfYear % 30 + 1,
      hour: Math.floor(timestamp / 3600) - days * hoursPerDay, minute: Math.floor(timestamp / 60) % 60 };
  };
  const state = { now: { year: 1, month: 2, day: 21, hour: 0, minute: 0 } };
  const api = {
    getActiveCalendar: () => ({ days: { hoursPerDay }, monthsArray: months.map((name) => ({ name, days: 30 })) }),
    getCurrentDateTime: () => state.now, dateToTimestamp, timestampToDate,
    addHours: (date, hours) => timestampToDate(dateToTimestamp(date) + hours * 3600)
  };
  globalThis.CALENDARIA = { api };
  return { state, api };
}

function owner(overrides = {}) {
  return { ...createEconomyHarness(), ...EconomyEventDomain,
    _tendayReadinessContext: async () => ({}), _schoolEducationContext: () => ({ active: false }),
    _prepareTendayRandomEvents: () => ({ entries: [], events: [], warnings: [] }),
    requestRender() {}, _postTendaySummaryChat: async () => {}, ...overrides };
}

function dataFor(holding) {
  return { meta: { revision: 1 }, holdings: [mergeHoldingDefaults(holding)], catalog: { resources: [], eventRegions: [] } };
}

async function withData(data, callback) {
  const oldView = SkyholdData.view;
  SkyholdData.view = () => data;
  try { return await callback(); } finally { SkyholdData.view = oldView; }
}

async function prepare(app, data, qd = 40, operationId = "time") {
  return withData(data, () => app._prepareTendayOperation({ holdingId: data.holdings[0].id,
    qd, dataView: data, operationId, preparedAt: "2026-10-25T00:00:00.000Z" }));
}

function checkCalendarConversion() {
  for (const hours of [24, 30]) {
    calendarFixture(hours);
    const start = { year: 1, month: 8, day: 21, hour: 0, minute: 0 };
    assert.deepEqual(addCalendariaQd(start, 40), { year: 2, month: 1, day: 1, hour: 0, minute: 0 });
    assert.deepEqual(addCalendariaQd(start, -40), { ...start, day: 11 });
    assert.deepEqual(addCalendariaQd(start, 1), { ...start, hour: Math.floor(hours / 4), minute: hours % 4 * 15 });
  }
  const { api } = calendarFixture();
  api.dateToTimestamp = () => 0;
  assert.equal(timestampForCalendariaDate({ year: 0, month: 1, day: 1 }), 0, "the real epoch remains a valid date");
  api.dateToTimestamp = () => null;
  assert.equal(timestampForCalendariaDate({ year: 1, month: 1, day: 1 }), null,
    "an unavailable conversion is not timestamp zero");
  delete api.addHours;
  assert.equal(addCalendariaQd({ year: 1, month: 1, day: 1 }, 40), null,
    "a failed conversion cannot fabricate a date from the epoch or overflow its hour");
}

function checkCalendarGate() {
  const { state } = calendarFixture();
  const app = owner();
  const holding = makeHolding();
  const first = app._checkCalendariaEconomyAdvance(holding, 40);
  assert.equal(first.ok, true);
  app._commitCalendariaEconomyAdvance(holding, first);
  assert.equal(holding.gm.calendaria.lastTimestamp, timestampForCalendariaDate(state.now),
    "initial synchronization records the actual date timestamp");
  assert.equal(app._checkCalendariaEconomyAdvance(holding, 40).ok, false, "cannot run ahead of Calendaria");
  state.now = addCalendariaQd(state.now, 40);
  assert.equal(app._checkCalendariaEconomyAdvance(holding, 40).ok, true);
}

async function checkBatches() {
  delete globalThis.CALENDARIA;
  for (const mode of ["staff", "qd", "passive"]) {
    const { holding, harness } = hybridRuntimeFixture({ goal: null });
    holding.buildings.list[0].labor.mode = mode;
    const data = dataFor(holding);
    const before = stableDataHash(data);
    const app = owner(harness);
    const batch = await prepare(app, data, 120, "batch");
    assert.equal(batch.ok, true, mode);
    assert.equal(stableDataHash(data), before, "preparation must not mutate source data");
    let singleData = data;
    for (let index = 0; index < 3; index++) {
      const single = await prepare(app, singleData, 40, `batch-p${index + 1}`);
      assert.equal(single.ok, true);
      singleData = { ...singleData, holdings: [single.preparedHolding] };
    }
    const after = batch.preparedHolding;
    const expected = singleData.holdings[0];
    assert.equal(after.gm.calendaria.lastQd, 120);
    assert.equal(after.storage.moneyCopper, expected.storage.moneyCopper);
    assert.deepEqual(after.storage.resources.map(({ resourceId, qty }) => ({ resourceId, qty })),
      expected.storage.resources.map(({ resourceId, qty }) => ({ resourceId, qty })));
    assert.deepEqual(after.finance, expected.finance, "wage periods and upkeep remainders must match separate tendays");
    const passports = new Set(batch.report.finance.obligations.map((row) => row.id));
    assert.ok(batch.report.finance.payments.every((row) => passports.has(row.obligationId)), "every payment in the batch retains its obligation details");
    assert.equal(batch.report.finance.obligations.reduce((sum, row) => sum + row.paidCopper, 0), batch.report.finance.paidCopper,
      "for a fresh payroll the detailed rows and batch total must agree");
    const saved = buildTendayOperationPayload(batch);
    assert.equal(saved.economy.finance.obligations.length, batch.report.finance.obligations.length, "history retains every period's financial details");
    const history = hydrateTendayOperation({ operationId: batch.operationId, payload: saved });
    assert.deepEqual(history.report.finance.obligations, batch.report.finance.obligations, "reopened history preserves complete obligation passports");
  }
}

async function checkCalendarPeriods() {
  const { state, api } = calendarFixture();
  state.now.weekdayLabel = "World-only display metadata";
  const data = dataFor(makeHolding());
  const starts = [];
  const app = owner();
  const run = app._runEconomyForQd;
  app._runEconomyForQd = function (holding, ...args) {
    starts.push(structuredClone(holding.gm.calendaria.lastDateTime));
    return run.call(this, holding, ...args);
  };
  const initial = await prepare(app, data, 120);
  assert.equal(initial.ok, true, initial.message);
  assert.deepEqual(starts.map(({ month, day }) => [month, day]), [[1, 21], [2, 1], [2, 11]],
    "an undated batch ends now and supplies each production period with its own start date");
  assert.equal(initial.preparedHolding.gm.calendaria.lastTimestamp, api.dateToTimestamp(state.now));
  assert.equal(initial.sourceHash, stableDataHash(data.holdings[0]), "initial date anchoring stays inside the preview");
  assert.equal(app._isPreparedTendayCurrent(initial, data), true);
  state.now = addCalendariaQd(state.now, 4);
  assert.equal(app._isPreparedTendayCurrent(initial, data), false, "undated previews depend on the initial date");
  const anchored = { ...data, holdings: [initial.preparedHolding] };
  state.now = addCalendariaQd(initial.preparedHolding.gm.calendaria.lastDateTime, 40);
  const prepared = await prepare(app, anchored);
  assert.equal(prepared.ok, true);
  state.now = addCalendariaQd(state.now, 40);
  assert.equal(app._isPreparedTendayCurrent(prepared, anchored), true, "later world time does not reroll a fixed period");
  state.now = addCalendariaQd(state.now, -41);
  assert.equal(app._isPreparedTendayCurrent(prepared, anchored), false, "world rewind invalidates a future period");
  api.dateToTimestamp = () => { throw new Error("offline calendar failure"); };
  assert.equal((await prepare(app, anchored)).blocked, true, "calendar errors cannot bypass the date gate");
}

async function checkPhysicalTime() {
  delete globalThis.CALENDARIA;
  const outcomes = [];
  for (const efficiency of [0.5, 1, 2, 4]) {
    const { holding, harness } = hybridRuntimeFixture({ goal: null });
    harness._personBuildingEfficiency = () => efficiency;
    const data = dataFor(holding);
    data.catalog.banks = [structuredClone(BANK_PRESETS[0])];
    const source = data.holdings[0];
    issueBankLoan({ data, holding: source, bankId: "merchant", offerId: "working-capital", amountCopper: 1000, operationId: "loan" });
    openBankDeposit({ data, holding: source, bankId: "merchant", offerId: "term", amountCopper: 1000, operationId: "deposit" });
    source.special.banking.loans[0].termDays = 5;
    source.special.banking.deposits[0].termDays = 15;
    const ship = createShipRecord("time-ship");
    ship.routePlan = { destination: "Port", distanceKm: 150, portDays: 1, upkeepPerDayCopper: 10, preparationCopper: 20, rewardCopper: 150 };
    source.special.ships.list = [ship];
    departShip(source, ship, { operationId: "voyage", budgetCopper: 300, clockQd: 0 });
    const prepared = await prepare(owner(harness), data, 80);
    assert.equal(prepared.ok, true);
    const after = prepared.preparedHolding;
    const bank = after.special.banking;
    assert.equal(after.gm.calendaria.lastQd, 80);
    assert.equal(bank.loans[0].elapsedQd, 80);
    assert.equal(bank.loans[0].overduePeriods, 2);
    assert.equal(bank.deposits[0].elapsedQd, 60, "term deposits stop accruing at their 15-day maturity");
    assert.equal(bank.deposits[0].status, "matured");
    assert.equal(after.special.ships.history.length, 1, "a returning voyage is settled only once across the batch");
    outcomes.push({ bank, returnedAtQd: after.special.ships.history[0].returnedAtQd,
      treasury: after.storage.moneyCopper });
  }
  for (const result of outcomes.slice(1)) assert.deepEqual(result, outcomes[0],
    "efficiency changes output, never bank time, voyage time or the price of the same physical work");

  const injured = hybridRuntimeFixture({ goal: null });
  injured.person.injuredDays = 5;
  injured.person.status = "Ранен";
  const healed = await prepare(owner(injured.harness), dataFor(injured.holding), 80);
  assert.equal(healed.preparedHolding.people.list[0].injuredDays, 0);
  assert.equal(healed.recovery.recovered, 1);
  assert.equal(healed.preparedHolding.storage.resources.find((row) => row.resourceId === "wood")?.qty, 20,
    "a worker recovered at the first boundary participates in the second period");

  const aging = makeHolding();
  aging.gm.calendaria.lastQd = 920;
  aging.people.list = [{ id: "adult", name: "Adult", age: 30, race: "Человек" }];
  const aged = await prepare(owner(), dataFor(aging), 80);
  assert.equal(aged.preparedHolding.people.list[0].age, 31, "a 240-day year is crossed once");
}

async function checkSharedClock() {
  const { state } = calendarFixture();
  const data = dataFor(makeHolding());
  data.holdings[0].gm.calendaria.lastDateTime = addCalendariaQd(state.now, -40);
  data.holdings.push({ ...structuredClone(data.holdings[0]), id: "second-settlement" });
  applySharedMarketMigration(data, previewSharedMarketMigration(data).sourceToken);
  const first = data.holdings[0];
  assert.equal(reserveMarketStock({ holding: first, marketId: "port", operationId: "buy",
    lines: [{ id: "wood", qty: 10, stockBaseStock: 10, stockStateRevision: 0 }] }).ok, true);
  const demand = reserveMarketDemand({ holding: first, marketId: "port", operationId: "sell",
    lines: [{ demandId: "wood", qty: 10, demandBaseDemand: 10, demandStateRevision: 0 }] });
  assert.equal(demand.ok, true);
  assert.equal(settleMarketDemandReservations({ holding: first, reservations: demand.reservations,
    outcome: "consumed", operationId: "sold" }).ok, true);
  const before = stableDataHash(data);
  const app = owner();
  const prepared = await prepare(app, data);
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(stableDataHash(data), before, "shared stock remains isolated during preparation");
  const nextData = { ...data, meta: { ...data.meta, sharedMarkets: prepared.preparedSharedMarkets },
    holdings: [data.holdings[1], prepared.preparedHolding] };
  const second = await prepare(app, nextData);
  assert.equal(second.ok, true, second.message);
  assert.deepEqual(second.preparedSharedMarkets, prepared.preparedSharedMarkets,
    "a second settlement reaching the same date cannot recover the common market twice");
}

async function checkEventRetention() {
  delete globalThis.CALENDARIA;
  const holding = makeHolding();
  const effect = { type: "money", amount: 10 };
  holding.gm.lastRoll = { kind: "tenday", eventId: "old", events: [{ decisionId: "old:1",
    title: "Pending", effects: [effect], effectStatus: "pending" }], effects: [effect] };
  const data = dataFor(holding);
  const app = owner();
  assert.equal((await prepare(app, data)).blocked, true, "the next tenday cannot erase an unresolved decision");
  data.holdings[0].gm.lastRoll.events[0].effectStatus = "scheduled";
  data.holdings[0].gm.lastRoll.events[0].scheduleId = "scheduled";
  data.holdings[0].gm.eventSchedule = [{ id: "scheduled", status: "scheduled", dueQd: 40, effects: [effect] }];
  const prepared = await prepare(app, data);
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.dueEvents.length, 1, "scheduled events remain visible and are not applied automatically");
  assert.equal(prepared.preparedHolding.storage.moneyCopper, 0);
  const crowded = owner({ _prepareTendayRandomEvents: () => ({ events: Array.from({ length: 41 }, () => ({ effects: [effect] })) }) });
  assert.equal((await prepare(crowded, data)).blocked, true, "a single period cannot silently truncate its decisions");
}

async function checkFailedBatch() {
  delete globalThis.CALENDARIA;
  const data = dataFor(makeHolding());
  const before = stableDataHash(data);
  const app = owner();
  const run = app._runEconomyForQd;
  app._runEconomyForQd = function (holding, ...args) {
    if (holding.gm.calendaria.lastQd === 40) throw new Error("second period failure");
    return run.call(this, holding, ...args);
  };
  await assert.rejects(prepare(app, data, 120), /second period failure/);
  assert.equal(stableDataHash(data), before, "a later failure cannot commit an earlier period of the batch");
}

async function checkApply() {
  const { state } = calendarFixture();
  let data = dataFor(makeHolding());
  data.holdings[0].gm.calendaria.lastDateTime = addCalendariaQd(state.now, -40);
  let commits = 0, chats = 0, failWrite = false;
  let queue = Promise.resolve();
  const oldUpdate = SkyholdData.updateHolding, oldSkip = SkyholdData.skipTransaction, oldError = console.error;
  SkyholdData.skipTransaction = (value) => ({ skippedTransaction: true, value });
  SkyholdData.updateHolding = (id, updater) => {
    const task = queue.then(async () => {
      const draft = structuredClone(data);
      const result = await updater(draft.holdings.find((row) => row.id === id), draft);
      if (result?.skippedTransaction) return result.value;
      if (failWrite) throw new Error("simulated write failure");
      data = draft;
      commits++;
      return result;
    });
    queue = task.catch(() => {});
    return task;
  };
  try {
    const app = owner({ _postTendaySummaryChat: async () => { chats++; throw new Error("simulated chat failure"); } });
    const prepared = await prepare(app, data);
    assert.equal(prepared.ok, true);
    const before = stableDataHash(data);
    const now = state.now;
    state.now = addCalendariaQd(now, -1);
    assert.equal((await app._applyPreparedTendayOperation(prepared)).stale, true);
    assert.equal(commits, 0, "Apply rechecks world time inside the transaction");
    state.now = now;
    game.user.isGM = false;
    assert.equal((await app._applyPreparedTendayOperation(prepared)).ok, false);
    game.user.isGM = true;
    failWrite = true;
    await assert.rejects(app._applyPreparedTendayOperation(prepared), /write failure/);
    assert.equal(stableDataHash(data), before, "failed persistence leaves the source unchanged");
    failWrite = false;
    console.error = () => {};
    const [first, replay] = await Promise.all([app._applyPreparedTendayOperation(prepared), app._applyPreparedTendayOperation(prepared)]);
    assert.equal(first.ok, true);
    assert.equal(first.chatPosted, false, "a chat failure does not undo a successful commit");
    assert.equal(replay.replay, true);
    assert.equal(commits, 1);
    assert.equal(chats, 1);
    assert.equal(data.holdings[0].gm.calendaria.lastQd, 40);
    assert.equal(data.holdings[0].log.filter((row) => row.type === "tenday").length, 1);
    state.now = addCalendariaQd(now, -80);
    assert.equal((await app._applyPreparedTendayOperation(prepared)).replay, true,
      "a committed retry remains a replay even after external time changes");
  } finally {
    SkyholdData.updateHolding = oldUpdate;
    SkyholdData.skipTransaction = oldSkip;
    console.error = oldError;
  }
}

function checkReportFlows() {
  const reports = [1, 2].map((value) => ({ clock: { beforePeriod: value - 1 },
    report: { food: { needed: 10, eaten: 10, expiredQty: value, lines: [] },
      finance: { planned: 10, paidCopper: value, lines: [] },
      market: { delivered: [{ orderId: `in-${value}` }], inTransit: [{ orderId: "still-travelling", remainingQd: 80 - value * 40 }] },
      marketOutbound: { delivered: [{ orderId: `out-${value}` }], inTransit: [] },
      marketDemandRecovery: { recoveredQty: value, recovered: [{ qty: value }] },
      work: [], ledger: [] } }));
  const combined = combineTendayReports(reports);
  assert.equal(combined.food.expiredQty, 3, "spoilage is a flow over every period");
  assert.equal(combined.market.delivered.length, 2, "earlier deliveries must remain in the batch report");
  assert.equal(combined.marketOutbound.delivered.length, 2);
  assert.equal(combined.market.inTransit.length, 1, "a final transit snapshot must not duplicate the same order per period");
  assert.equal(combined.marketDemandRecovery.recoveredQty, 3);
  assert.equal(combined.marketDemandRecovery.recovered.length, 2);
  const debtPeriods = [
    { report: { work: [], ledger: [], finance: { obligations: [{ id: "old-debt", paidCopper: 0, outstandingCopper: 10 }, { id: "first-period", paidCopper: 5, outstandingCopper: 0 }] } } },
    { report: { work: [], ledger: [], finance: { obligations: [{ id: "old-debt", paidCopper: 10, outstandingCopper: 0 }, { id: "last-period", paidCopper: 7, outstandingCopper: 0 }] } } }
  ];
  const finance = combineTendayReports(debtPeriods).finance;
  assert.equal(finance.obligations.length, 3, "a carried obligation is represented once, alongside both periods");
  assert.equal(finance.obligations.find((row) => row.id === "old-debt").outstandingCopper, 0, "the latest settlement of carried debt wins");
}

export async function checkTimeAdvancement() {
  const globals = new Map(["game", "foundry", "CALENDARIA", "ui"].map((key) => [key, { exists: Object.hasOwn(globalThis, key), value: globalThis[key] }]));
  globalThis.game = { user: { id: "gm", isGM: true }, settings: { get: () => undefined } };
  globalThis.foundry = { utils: { deepClone: structuredClone } };
  globalThis.ui = { notifications: { warn() {}, info() {} } };
  try {
    checkCalendarConversion();
    checkCalendarGate();
    await checkBatches();
    await checkCalendarPeriods();
    await checkPhysicalTime();
    await checkSharedClock();
    await checkEventRetention();
    await checkFailedBatch();
    await checkApply();
    checkReportFlows();
  } finally {
    for (const [key, { exists, value }] of globals) if (exists) globalThis[key] = value; else delete globalThis[key];
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkTimeAdvancement();
  console.log("Time advancement: calendar, sequential tendays and report flows passed.");
}
