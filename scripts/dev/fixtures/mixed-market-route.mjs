import { normalizeEventRegionOptions } from "../../data/random-events.js";

export function mixedMarketRouteFixture() {
  const regions = normalizeEventRegionOptions([
    { value: "sky-home", marketLandmassId: "island", marketTransportModes: ["airship"], marketLinks: [{ regionId: "relay-a", modes: ["airship"] }] },
    { value: "relay-a", marketLandmassId: "island", marketTransportModes: ["airship"], marketLinks: [{ regionId: "relay-b", modes: ["airship"] }] },
    { value: "relay-b", marketLandmassId: "mainland", marketTransportModes: ["airship"], marketLinks: [{ regionId: "transfer", modes: ["airship"] }] },
    { value: "transfer", marketLandmassId: "mainland", marketTransportModes: ["caravan", "airship"], marketLinks: [{ regionId: "ground-market", modes: ["caravan"] }] },
    { value: "ground-market", marketLandmassId: "mainland", marketTransportModes: ["caravan"] }
  ], { fallback: false });
  return { regions, holding: { type: "sky-island", overview: { region: "sky-home" }, gm: { modifiers: { marketConnectionsLevel: 4 } } },
    market: { regionId: "ground-market", transportModes: ["caravan"] } };
}
