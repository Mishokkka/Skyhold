import assert from "node:assert/strict";
import { transportFixture, transportRequest } from "./transport-v2.mjs";
import { prepareTransportContext } from "../../apps/domains/transport-context.js";
import { planTransportChain } from "../../engines/transport/planner.js";
import { bookTransportOrder, advanceTransportOrders } from "../../engines/transport/runtime.js";
import { pruneCompletedTransportRuns } from "../../data/transport/state.js";

export function transportHistoryFixture() {
  const f = transportFixture(), request = transportRequest(f);
  const quote = prepareTransportContext({ ...f, request, isGM: true });
  const services = quote.plan.stages.map(stage => stage.service), state = f.data.meta.transportV2;
  let count = 0;
  return { ...f, request, append(target) {
    while (count < target) {
      f.holding.storage.moneyCopper = 100000000;
      const plan = planTransportChain({ cargo: quote.plan.cargo, services, runs: state.runs, startQd: state.clockQd });
      const order = bookTransportOrder({ state, holding: f.holding, plan, services, id: `history-${count++}`,
        direction: "inbound", commercial: quote.commercial });
      advanceTransportOrders({ state, holding: f.holding, targetQd: plan.arrivalQd, dependencies: { receiveCargo() {} } });
      f.holding.gm.calendaria.lastQd = state.clockQd;
      assert.equal(order.status, "delivered");
      pruneCompletedTransportRuns(f.data);
      assert.equal(state.runs.length, 0);
    }
  } };
}

export async function transportHistoryApp(f) {
  globalThis.foundry = { applications: { api: {
    ApplicationV2: class { constructor(options) { this.id = options.id; } async _prepareContext() { return {}; } render() {} },
    HandlebarsApplicationMixin: Base => Base
  } } };
  const gm = { id: "gm", isGM: true, active: true };
  globalThis.game = { user: gm, users: [gm], settings: { get() {} }, modules: new Map(), socket: { emit() {} } };
  const { SkyholdData } = await import("../../data/store.js");
  const { SkyholdTransportApp } = await import("../../apps/transport-app.js");
  SkyholdData.view = () => f.data;
  const app = new SkyholdTransportApp({ holdingId: f.holding.id });
  app.requestRender = () => {};
  return app;
}
