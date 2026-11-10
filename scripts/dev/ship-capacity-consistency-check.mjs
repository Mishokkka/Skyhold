import assert from "node:assert/strict";
import { transportFixture, transportRequest } from "./fixtures/transport-v2.mjs";
import { prepareTransportContext } from "../apps/domains/transport-context.js";
import { planTransportChain } from "../engines/transport/planner.js";
import { pathToFileURL } from "node:url";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { shipCapacityLoadPoints } from "../engines/ships/profiles.js";
import { generateWorldShipOffers, repriceWorldShipOffer, quoteWorldShipBundle } from "../engines/ships/world-market.js";
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
    } else {
      assert.ok(offers.length > 0);
      assert.ok(offers.every((offer) => offer.contract.cargo.loadPoints <= shipCapacityLoadPoints(ship)));
    }
  }
  for (const capacity of [undefined, null, 0, 8000]) {
    const f = transportFixture(); f.ship.capacityLoadPoints = capacity;
    const request = transportRequest(f, "a", { ownShipId: f.ship.id, direction: "outbound", insurance: false });
    if (capacity === 0) {
      assert.throws(() => prepareTransportContext({ ...f, request, isGM: true }), /вместимость|трюм|объём|Некорректно: capacity|нет доступной перевозки/i);
      continue;
    }
    const view = prepareTransportContext({ ...f, request, isGM: true });
    const service = view.services.find(row => row.kind === "owned" && row.from === view.from && row.to === view.to);
    assert.ok(service);
    assert.equal(service.capacity, shipCapacityLoadPoints(f.ship) * 1000, "the actual transport service uses the same effective vessel capacity");
    const cargo = [{ lotId: "large-unit", resourceId: "wood", qty: 1,
      unitLoad: (capacity === 8000 ? 6000 : 1000) * 1000, unitCopper: 10000 }];
    const planned = planTransportChain({ cargo, services: [service] });
    assert.equal(planned.stages[0].runs.length, 1);
    assert.ok(planned.stages[0].runs[0].reservedLoad <= service.capacity);
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
