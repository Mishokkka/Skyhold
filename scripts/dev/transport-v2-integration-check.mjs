import assert from "node:assert/strict";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { prepareMarketAuthorityContext } from "../apps/market/authority-context.js";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";
import { createTransportOperationExecutor } from "../apps/transport-operation-executor.js";
import { advanceTransportShipments } from "../workflows/transport/orders.js";
import { TRANSPORT_SERVICE_DEFAULTS } from "../engines/transport/services.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { reservedResourceBatchQuantities } from "../core/resource-batches.js";
import { ensureTransportState } from "../data/transport/state.js";

function fixture() {
  const { data, holding, ship } = worldMarketFixture();
  holding.type = "village"; holding.visibility = "public";
  holding.gm.playersCanUseStorage = true; holding.gm.playersCanManageShips = true;
  holding.gm.modifiers.marketConnectionsLevel = 6;
  ensureTransportState(data);
  data.catalog.transportV2 = { ...TRANSPORT_SERVICE_DEFAULTS, riskBps: 0 };
  return { data, holding, ship };
}
const workflow = {
  _storageAddWithOverflow(holding, resource, qty) { holding.storage.resources.push({ ...resource, id: `received-${holding.storage.resources.length}`, qty }); },
  _appendStorageLog(holding, entries) { holding.storage.log.push(...entries); },
  _snapshotItemForStorage(item, qty, roomId) { return { name: item.name, qty, roomId, itemUuid: item.uuid }; }
};
const { data, holding } = fixture();
const market = prepareMarketAuthorityContext({ data, holding, isGM: true }).markets.find((row) => row.regionId === "a");
assert.ok(market);
const quote = prepareMarketAuthorityContext({ data, holding, marketId: market.id, isGM: true }).quote;
const offer = quote.offers.find((row) => row.resourceId === "test-freight");
assert.ok(offer);
const request = { direction: "inbound", marketId: market.id, quantities: { [offer.id]: 10 }, priority: "cost", insurance: false };
const preview = prepareTransportContext({ data, holding, request, isGM: true });
assert.ok(preview.plan.totalCopper > 0);
assert.equal(preview.plan.cargo[0].qty, 10);
assert.equal(preview.plan.stages[0].from, "a");
assert.equal(preview.plan.stages.at(-1).to, "home");
let stored = structuredClone(data);
const user = { id: "gm", isGM: true };
const execute = createTransportOperationExecutor({ getUser: (id) => id === user.id ? user : { id: "player", isGM: false }, workflow: () => workflow,
  transaction: async (updater) => {
    const draft = structuredClone(stored), result = await updater(draft, { skip: (value) => ({ skipped: true, value }) });
    if (result?.skipped) return result.value;
    draft.meta.revision++; stored = draft; return result;
  }
});
const operation = { type: "transport-book", operationId: "transport-test-purchase", holdingId: holding.id,
  expectedRevision: data.meta.revision, sourceToken: preview.sourceToken, planToken: preview.planToken,
  request: { ...request, serviceIds: preview.plan.stages.map((stage) => stage.service.id) } };
const booked = await execute(operation, { userId: "gm" });
assert.ok(booked.ok);
const afterBooking = structuredClone(stored);
assert.equal((await execute(operation, { userId: "gm" })).replay, true);
assert.deepEqual(stored, afterBooking, "command replay changes neither cash nor revision");
await assert.rejects(execute({ ...operation, operationId: "transport-stale" }, { userId: "gm" }), /изменились/);
const reloaded = normalizeSkyholdData(stored);
assert.deepEqual(reloaded.meta.transportV2, stored.meta.transportV2);
assert.deepEqual(reloaded.catalog.transportV2, stored.catalog.transportV2);
assert.deepEqual(reloaded.holdings[0].special.transportV2, stored.holdings[0].special.transportV2);
const destination = stored.holdings[0];
stored.catalog.transportV2 = { ...stored.catalog.transportV2, riskBps: 10000, regularIntervalQd: 400 };
stored.catalog.marketEconomy.settings = { handlingFlatCopper: 10000, handlingLoadCopper: 1000 };
advanceTransportShipments(stored, destination, preview.plan.arrivalQd, workflow);
assert.equal(destination.special.transportV2.orders[0].status, "delivered");
assert.deepEqual(destination.special.transportV2.orders[0].plan, preview.plan,
  "catalog edits after authoritative booking cannot change accepted prices, handling, dates or incident risk");
assert.equal(destination.special.transportV2.orders[0].money.spentCopper, preview.plan.totalCopper);
assert.equal(destination.storage.resources.filter((row) => row.resourceId === "test-freight").reduce((sum, row) => sum + row.qty, 0), 10);
advanceTransportShipments(stored, destination, preview.plan.arrivalQd, workflow);
assert.equal(destination.storage.resources.filter((row) => row.resourceId === "test-freight").reduce((sum, row) => sum + row.qty, 0), 10);

const outbound = fixture();
outbound.holding.storage.resources = [{ id: "cargo", resourceId: "test-freight", name: "Ткани", forSale: true, qty: 20,
  batches: [{ id: "old", qty: 20, ageQd: 4 }] }];
const saleRequest = { direction: "outbound", marketId: market.id, quantities: { "test-freight": 10 }, insurance: false };
const sale = prepareTransportContext({ ...outbound, request: saleRequest, isGM: true });
assert.equal(sale.plan.cargo[0].batchId, "old");
stored = structuredClone(outbound.data);
await execute({ type: "transport-book", operationId: "transport-test-sale", holdingId: outbound.holding.id,
  expectedRevision: stored.meta.revision, sourceToken: sale.sourceToken, planToken: sale.planToken, request: saleRequest }, { userId: "player", remote: true });
assert.equal(reservedResourceBatchQuantities(stored.holdings[0], { id: "cargo" }).get("old"), 10);
advanceTransportShipments(stored, stored.holdings[0], sale.plan.arrivalQd, workflow);
assert.equal(stored.holdings[0].storage.resources[0].qty, 10);
assert.equal(stored.holdings[0].special.transportV2.orders[0].status, "delivered");

const own = fixture();
own.ship.crewTarget = 1;
const ownRequest = { ...request, ownShipId: own.ship.id, returnHome: true, reserveCopper: 100 };
const ownPreview = prepareTransportContext({ ...own, request: ownRequest, isGM: true });
assert.equal(ownPreview.plan.ownShipId, own.ship.id);
stored = structuredClone(own.data);
await execute({ type: "transport-book", operationId: "transport-test-owned", holdingId: own.holding.id,
  expectedRevision: stored.meta.revision, sourceToken: ownPreview.sourceToken, planToken: ownPreview.planToken, request: ownRequest }, { userId: "gm" });
const ownedHolding = stored.holdings[0], ownedShip = ownedHolding.special.ships.list[0];
assert.ok(ownedShip.transportOrderId);
assert.equal(normalizeSkyholdData(stored).holdings[0].special.ships.list[0].transportOrderId, ownedShip.transportOrderId,
  "normal loading preserves the ship assignment and prevents a second departure");
advanceTransportShipments(stored, ownedHolding, ownPreview.plan.shipReleaseQd, workflow);
assert.equal(ownedHolding.special.transportV2.orders[0].status, "delivered");
assert.equal(ownedShip.transportOrderId, undefined);
assert.equal(ownedShip.location.kind, "home");
assert.equal(ownedShip.lastOuting.expenseCopper, ownPreview.plan.ownExpensesCopper);
assert.equal(ownedHolding.special.transportV2.orders[0].money.escrowCopper, 0);
await assert.rejects(execute({ type: "transport-configure", operationId: "transport-forbidden", holdingId: ownedHolding.id,
  expectedRevision: stored.meta.revision, sourceToken: transportSourceToken(stored, ownedHolding), configuration: {} }, { userId: "player", remote: true }), /ГМ/);
for (const holdingType of ["village", "sky-island", "ship"]) {
  const local = fixture(); local.holding.type = holdingType;
  local.holding.storage.resources = [{ id: "local-cargo", resourceId: "test-freight", name: "Ткани", forSale: true, qty: 20,
    batches: [{ id: "local-batch", qty: 20, ageQd: 0 }] }];
  for (const destination of ["home", "a"]) {
    const authority = prepareMarketAuthorityContext({ ...local, isGM: true });
    const selected = authority.markets.find((row) => row.regionId === destination);
    const offers = prepareMarketAuthorityContext({ ...local, marketId: selected.id, isGM: true }).quote.offers;
    const selectedOffer = offers.find((row) => row.resourceId === "test-freight");
    for (const direction of ["inbound", "outbound"]) {
      const context = prepareTransportContext({ ...local, isGM: true, request: { marketId: selected.id, direction,
        quantities: { [direction === "inbound" ? selectedOffer.id : "test-freight"]: 2 } } });
      assert.ok(context.plan.stages.length, `${holdingType}/${destination}/${direction}: physical route exists`);
      assert.equal(context.plan.stages[0].from, context.from);
      assert.equal(context.plan.stages.at(-1).to, context.to);
    }
  }
}
console.log("transport-v2 integration: stock/demand, authority/replay, reload, warehouse, owned return, local/floating routes and fleet accounting passed");
