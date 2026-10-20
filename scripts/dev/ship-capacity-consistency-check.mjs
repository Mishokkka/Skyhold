import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { shipCapacityLoadPoints } from "../engines/ships/profiles.js";
import { generateWorldShipOffers, repriceWorldShipOffer, quoteWorldShipSale, quoteWorldShipBundle } from "../engines/ships/world-market.js";
import { previewShipOrders } from "../engines/ships/order-preview.js";
import { departWorldShip, departWorldShipBundle } from "../engines/ships/world-voyage.js";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";

export async function checkShipCapacityConsistency() {
  for (const capacity of [undefined, null, 0, 8000]) {
    const { data, holding, ship } = worldMarketFixture();
    ship.capacityLoadPoints = capacity;
    assert.equal(shipCapacityLoadPoints(ship), capacity ?? 4000);
    const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.3 });
    if (capacity === 0) {
      assert.deepEqual(offers, []);
      assert.throws(() => quoteWorldShipSale(data, holding, ship, "a", { loadPoints: 1, valueCopper: 100 }), /трюм/);
    } else {
      assert.ok(offers.length > 0);
      assert.ok(offers.every((offer) => offer.contract.cargo.loadPoints <= shipCapacityLoadPoints(ship)));
      assert.ok(quoteWorldShipSale(data, holding, ship, "a", { loadPoints: capacity === 8000 ? 6000 : 1000, valueCopper: 10000 }));
    }
  }
  for (const bad of [-1, 0.5, NaN, Infinity]) assert.throws(() => shipCapacityLoadPoints({ capacityLoadPoints: bad, profileId: "merchant-barque" }), /вместимость/);
  for (const isGM of [true, false]) {
    const { data, holding, ship } = worldMarketFixture();
    for (let index = 1; index < 36; index++) {
      const id = `sailor-${index}`;
      holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
      ship.crewResidentIds.push(id);
    }
    holding.gm.playersCanManageShips = true;
    const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => 0.3 });
    holding.special.ships.offers = offers;
    const bundle = quoteWorldShipBundle(data, holding, ship, offers.slice(0, 2));
    ship.capacityLoadPoints = 0;
    const before = JSON.stringify(holding);
    assert.throws(() => repriceWorldShipOffer(data, holding, ship, offers[0]), /вместимости/);
    assert.throws(() => previewShipOrders(data, holding, ship, { offerIds: [offers[0].id] }), /вместимости/);
    assert.throws(() => quoteWorldShipBundle(data, holding, ship, offers.slice(0, 2)), /вместимость/);
    assert.throws(() => departWorldShip(holding, ship, { operationId: "direct-zero", clockQd: 0, offer: offers[0] }), /вместимости/);
    assert.throws(() => departWorldShipBundle(holding, ship, { operationId: "direct-zero-bundle", clockQd: 0, plan: bundle }), /вместимости/);
    assert.equal(JSON.stringify(holding), before, "capacity fails before billing, funding or contract mutation");
    const user = { id: isGM ? "gm" : "player", isGM };
    const execute = createShipOperationExecutor({ getUser: () => user,
      updateHolding: async (_id, updater) => updater(holding, data) });
    await assert.rejects(execute({ type: "depart-world", operationId: `zero-${user.id}`, holdingId: holding.id, shipId: ship.id,
      expectedRevision: data.meta.revision, offerId: offers[0].id, locationKind: "home", locationId: holding.id },
    { userId: user.id, remote: !isGM }), /вместимости/);
    assert.equal(ship.activeVoyage, null);
    assert.equal(holding.storage.moneyCopper, 500000);
  }
  console.log("Ship capacity: missing overrides, explicit zero, enlarged hold, planner, bundle and authoritative GM/player departure passed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkShipCapacityConsistency();
