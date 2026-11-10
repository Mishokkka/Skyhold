import assert from "node:assert/strict";
import { transportFixture } from "./transport-v2.mjs";
import { mergeHoldingDefaults, normalizeSkyholdData } from "../../data/normalizers.js";
import { planTransportChain } from "../../engines/transport/planner.js";
import { bookTransportOrder } from "../../engines/transport/runtime.js";
import { transportSourceToken } from "../../apps/domains/transport-context.js";
import { createTransportOperationExecutor } from "../../apps/transport-operation-executor.js";
import { SkyholdWorkflowService } from "../../workflows/skyhold-workflow-service.js";
import { SkyholdData } from "../../data/store.js";

globalThis.game = { user: { id: "gm", isGM: true }, users: [{ id: "gm", isGM: true, active: true }],
  settings: { get: () => undefined }, modules: new Map(), time: { worldTime: 0 } };
globalThis.foundry = { utils: { deepClone: structuredClone } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

export function fixture({ two = false, kind = "charter", vehicles = 1, travelQd = 4, riskBps = 0 } = {}) {
  const f = transportFixture();
  f.data.catalog.resources.push({ id: "bread", label: "Bread", foodReady: true, shelfLifeQd: 240, loadPoints: 4, basePriceCopper: 5 });
  f.data.holdings = (two ? ["first", "second"] : ["first"]).map(id => mergeHoldingDefaults({ ...f.holding, id, name: id,
    people: { list: [{ id: `person-${id}`, name: id, age: 30 }] }, storage: { moneyCopper: 500000, resources: [] },
    special: { ...f.holding.special, ships: { ...f.holding.special.ships, list: [] }, transportV2: { version: 2, orders: [] } } }));
  f.data.meta.transportV2 = { version: 2, clockQd: 0, runs: [] };
  f.holding = f.data.holdings[0];
  f.carrier = { id: "finite-carrier", kind, from: "b", to: "home", firstQd: 1, intervalQd: 10,
    capacity: 40000, vehicles, loadingQd: 1, travelQd, unloadingQd: 1, returnQd: 4, dispatchCopper: 1, riskBps };
  return f;
}

export function book(f, holding, id, services, { resourceId = "bread", direction = "inbound", qty = 10 } = {}) {
  const cargo = [{ lotId: id, resourceId, name: resourceId, qty, unitLoad: 4000, unitCopper: 5,
    ageQd: 0, shelfLifeQd: resourceId === "bread" ? 240 : 0 }];
  if (direction === "outbound") {
    Object.assign(cargo[0], { rowId: `stock-${id}`, batchId: `batch-${id}` });
    holding.storage.resources.push({ id: cargo[0].rowId, resourceId, name: resourceId, qty, forSale: true,
      batches: [{ id: cargo[0].batchId, qty, ageQd: 0 }] });
  }
  const order = bookTransportOrder({ state: f.data.meta.transportV2, holding, services,
    plan: planTransportChain({ cargo, services, runs: f.data.meta.transportV2.runs, startQd: f.data.meta.transportV2.clockQd }), id, direction,
    clockOffsetQd: holding.special.transportV2.clockOffsetQd ?? 0,
    commercial: { marketId: services[0].from, marketLabel: services[0].from, targetRoomId: "outdoors" } });
  if (direction === "outbound") order.demandReservations = [];
  return order;
}

export function harness(initial) {
  let stored = structuredClone(initial), sequence = 0;
  const key = Symbol("skip"), skip = value => ({ [key]: true, value });
  const transaction = async updater => {
    const draft = structuredClone(stored), result = await updater(draft, { skip });
    if (result?.[key]) return result.value;
    draft.meta.revision++; stored = draft; return result;
  };
  SkyholdData.view = () => stored; SkyholdData.skipTransaction = skip;
  SkyholdData.updateHolding = (id, updater) => transaction(draft => updater(draft.holdings.find(row => row.id === id), draft));
  const workflow = new SkyholdWorkflowService(); workflow._postTendaySummaryChat = async () => {}; workflow.requestRender = () => {};
  const execute = createTransportOperationExecutor({ transaction, workflow: () => workflow, getUser: id => ({ id, isGM: id === "gm" }) });
  return { workflow, execute, get data() { return stored; }, holding: (id = "first") => stored.holdings.find(row => row.id === id),
    reload() { stored = normalizeSkyholdData(JSON.parse(JSON.stringify(stored))); },
    async prepare(id = "first", qd = 40, options = {}) {
      const before = structuredClone(stored);
      const result = await workflow._prepareTendayOperation({ holdingId: id, qd, dataView: stored, operationId: `carrier-period-${++sequence}`, pendingEventsCollected: true, ...options });
      assert.deepEqual(stored, before, "forecast does not change either holding or shared runs");
      return result;
    },
    async apply(prepared) {
      assert.equal(prepared.ok, true, prepared.message);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).ok, true);
      const after = structuredClone(stored);
      assert.equal((await workflow._applyPreparedTendayOperation(prepared)).replay, true);
      assert.deepEqual(stored, after, "Apply replay cannot duplicate food, cargo or charges");
    },
    async decide(prepared, resolution) {
      const row = prepared.transportReview.find(row => row.canResolve);
      assert.ok(row, "only actual incidents offer a decision");
      const operation = { type: "transport-incident", operationId: `carrier-decision-${++sequence}`, holdingId: prepared.holdingId,
        expectedRevision: stored.meta.revision, sourceToken: transportSourceToken(stored, this.holding(prepared.holdingId)),
        reviewQd: prepared.qd, rationUnitsPerResident: prepared.rationUnitsPerResident, runId: row.runId, resolution };
      await execute(operation, { userId: "gm" });
      const after = structuredClone(stored);
      assert.equal((await execute(operation, { userId: "gm" })).replay, true);
      assert.deepEqual(stored, after);
    }
  };
}
