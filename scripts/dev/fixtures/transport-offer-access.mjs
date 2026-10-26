import { worldMarketFixture } from "../world-ship-market-characterization-check.mjs";
import { normalizeEventRegionOptions } from "../../data/random-events.js";

/** URS 3 admits difficult goods on the direct route (1 + 2), but not the detour (2 + 2). */
export function transportOfferAccessFixture() {
  const { data, holding } = worldMarketFixture();
  holding.type = "village";
  holding.visibility = "public";
  holding.gm.playersCanUseStorage = true;
  holding.gm.modifiers.marketConnectionsLevel = 3;
  holding.storage.resources = [{ id: "stock", resourceId: "test-freight", forSale: true, qty: 20,
    batches: [{ id: "lot", qty: 20, ageQd: 0 }] }];
  data.catalog.resources[0].marketAccessDifficulty = 2;
  data.catalog.eventRegions = normalizeEventRegionOptions([
    { value: "home", countryId: "public", marketTransportModes: ["airship"], marketLinks: [
      { regionId: "a", routeId: "direct", modes: ["airship"], distanceKm: 80, ursCost: 1 },
      { regionId: "relay", modes: ["airship"], distanceKm: 40, ursCost: 1 }
    ] },
    { value: "relay", countryId: "public", marketTransportModes: ["airship"], marketLinks: [
      { regionId: "a", modes: ["airship"], distanceKm: 60, ursCost: 1 }
    ] },
    { value: "a", countryId: "public", marketTransportModes: ["airship"], marketLinks: [] }
  ], { fallback: false });
  return { data, holding };
}
