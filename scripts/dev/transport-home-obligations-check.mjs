import assert from "node:assert/strict";
import { transportFixture, transportRequest, transportHarness } from "./fixtures/transport-v2.mjs";
import { applyShipHomePlacement, shipHomeLocationContext } from "../apps/domains/ship-home-location.js";
import { SkyholdData } from "../data/store.js";
import { holdingTransportLocationBlocker } from "../data/transport/state.js";

const previousGame = globalThis.game, previousFoundry = globalThis.foundry, transaction = SkyholdData.transaction;
globalThis.game = { user: { id: "gm", isGM: true }, settings: { get() {} }, modules: new Map() };
globalThis.foundry = { ...previousFoundry, utils: { ...previousFoundry?.utils,
  setProperty: (data, path, value) => {
    const keys = path.split("."), last = keys.pop();
    keys.reduce((row, key) => row[key], data)[last] = value;
  } } };
try {
  for (const isGM of [true, false]) for (const direction of ["inbound", "outbound"]) {
    const f = transportFixture();
    f.holding.type = "ship";
    for (const [i, region] of f.data.catalog.eventRegions.entries()) {
      region.marketMapX = 100 + i * 100; region.marketMapY = 100;
    }
    const route = shipHomeLocationContext(f.data, f.holding).routes[0];
    assert.ok(route);
    const h = transportHarness(f);
    await h.book(transportRequest(f, "a", { direction }, isGM), `home-${direction}-${isGM}`, isGM);
    let writes = 0;
    SkyholdData.transaction = async updater => {
      const draft = structuredClone(h.data);
      await updater(draft); writes++;
    };
    const blocked = async () => {
      const before = JSON.stringify(h.data);
      assert.ok(holdingTransportLocationBlocker(h.holding));
      assert.throws(() => applyShipHomePlacement(h.data, h.holding, route.key, 50), /завершите/);
      await assert.rejects(SkyholdData.update("holdings.0.overview.region", "b"), error => error.code === "transport-obligations");
      assert.equal(JSON.stringify(h.data), before, "both location writers leave orders, catalog and balances intact");
    };
    await blocked();
    assert.equal(writes, 0);
    await SkyholdData.update("holdings.0.overview.region", h.holding.overview.region);
    assert.equal(writes, 1, "saving the same location is harmless");
    h.advance(h.holding.special.transportV2.orders[0].plan.arrivalQd);
    const order = h.holding.special.transportV2.orders[0];
    assert.equal(order.status, "delivered");
    assert.equal(holdingTransportLocationBlocker(h.holding), "");
    order.fundingNeededCopper = 1;
    await blocked();
    order.fundingNeededCopper = 0;
    order.ownShipId = f.ship.id; order.shipReleased = false; order.shipCostsReconciled = false;
    await blocked();
    order.shipReleased = true;
    await blocked();
    order.shipCostsReconciled = true;
    assert.equal(holdingTransportLocationBlocker(h.holding), "");
    h.holding.special.market.outbound.orders.push({ status: "travelling" });
    await blocked();
    h.holding.special.market.outbound.orders.length = 0;
    h.ship.status = "away"; h.ship.location = { kind: "market", id: "a", regionId: "a" };
    await blocked();
    h.ship.status = "docked"; h.ship.location = { kind: "home", id: h.holding.id, regionId: "home" };
    applyShipHomePlacement(h.data, h.holding, route.key, 50);
    assert.notEqual(h.holding.overview.region, "home", "moving becomes available once every obligation is settled");
  }
  console.log("Transport home obligations: real GM/player inbound/outbound orders, unpaid delivery, ship return/reconciliation, legacy work, both location writers and atomic blockers passed.");
} finally {
  SkyholdData.transaction = transaction; globalThis.game = previousGame; globalThis.foundry = previousFoundry;
}
