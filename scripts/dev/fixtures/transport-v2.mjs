import assert from "node:assert/strict";
import { worldMarketFixture } from "../world-ship-market-characterization-check.mjs";
import { prepareMarketAuthorityContext } from "../../apps/market/authority-context.js";
import { prepareTransportContext } from "../../apps/domains/transport-context.js";
import { createTransportOperationExecutor } from "../../apps/transport-operation-executor.js";
import { ensureTransportState } from "../../data/transport/state.js";
import { TRANSPORT_SERVICE_DEFAULTS } from "../../engines/transport/services.js";
import { advanceTransportShipments } from "../../workflows/transport/orders.js";

export function transportFixture() {
  const f = worldMarketFixture();
  f.holding.type = "village"; f.holding.visibility = "public";
  f.holding.gm.playersCanUseStorage = true; f.holding.gm.playersCanManageShips = true;
  f.holding.gm.modifiers.marketConnectionsLevel = 6;
  f.ship.crewTarget = 1;
  f.holding.storage.resources = [{ id: "sale-stock", resourceId: "test-freight", name: "Ткани", forSale: true,
    qty: 100, batches: [{ id: "sale-batch", qty: 100, ageQd: 0 }] }];
  f.data.catalog.transportV2 = { ...TRANSPORT_SERVICE_DEFAULTS, riskBps: 0 };
  ensureTransportState(f.data);
  return f;
}

export function transportRequest(f, regionId = "a", extra = {}, isGM = true) {
  const market = prepareMarketAuthorityContext({ ...f, isGM }).markets.find(row => row.regionId === regionId);
  assert.ok(market, "The market must be available to the requesting user");
  const context = prepareMarketAuthorityContext({ ...f, isGM, marketId: market.id });
  const offer = context.quote.offers.find(row => row.resourceId === "test-freight");
  assert.ok(offer, "The selected goods must be offered");
  const quantities = extra.direction === "outbound" ? { "test-freight": 10 } : { [offer.id]: 10 };
  return { marketId: market.id, direction: "inbound", quantities, insurance: false, ...extra };
}

export const transportWorkflow = {
  _appendStorageLog(holding, entries) { holding.storage.log.push(...entries); },
  _storageAddWithOverflow(holding, resource, qty) {
    holding.storage.resources.push({ ...resource, id: `arrival-${holding.storage.resources.length}`, qty });
  }
};

/** Exercise the real authority executor with an atomic in-memory transaction. */
export function transportHarness(f = transportFixture()) {
  let data = structuredClone(f.data);
  const execute = createTransportOperationExecutor({
    getUser: id => ({ id, isGM: id === "gm" }), workflow: () => transportWorkflow,
    transaction: async updater => {
      const draft = structuredClone(data);
      const result = await updater(draft, { skip: value => ({ skipped: true, value }) });
      if (result?.skipped) return result.value;
      draft.meta.revision++; data = draft;
      return result;
    }
  });
  const fixture = () => ({ data, holding: data.holdings.find(row => row.id === f.holding.id),
    ship: data.holdings.find(row => row.id === f.holding.id).special.ships.list.find(row => row.id === f.ship.id) });
  return {
    fixture, execute,
    get data() { return data; }, get holding() { return fixture().holding; }, get ship() { return fixture().ship; },
    async book(request, id, isGM = true) {
      const current = fixture(), preview = prepareTransportContext({ ...current, request, isGM });
      const operation = { type: "transport-book", operationId: id, holdingId: current.holding.id,
        expectedRevision: data.meta.revision, sourceToken: preview.sourceToken, planToken: preview.planToken, request };
      const result = await execute(operation, { userId: isGM ? "gm" : "player", remote: !isGM });
      assert.ok(result.ok);
      return { preview, operation, order: fixture().holding.special.transportV2.orders.find(row => row.id === id) };
    },
    advance(targetQd) {
      const { holding } = fixture();
      advanceTransportShipments(data, holding, targetQd, transportWorkflow);
      holding.gm.calendaria.lastQd = targetQd;
    }
  };
}
