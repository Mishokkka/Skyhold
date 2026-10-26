import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeEventRegionOptions } from "../data/random-events.js";
import { normalizeMarketOrganization } from "../data/market/economy.js";
import { planMarketTransport } from "../engines/market/transport-planner.js";
import { planMarketPurchase } from "../engines/market/pricing.js";
import { exhaustivePlans } from "./transport-network-check.mjs";

const MODES = ["caravan", "rail", "airship"];

function transportFixture(rows, organizations, isGM) {
  return {
    holding: { id: "home", name: "Дом", type: "village", overview: { region: "h" },
      gm: { modifiers: { marketConnectionsLevel: 8 } }, storage: { moneyCopper: 1_000_000_000 } },
    market: { id: "m", regionId: "m", countryId: "C", transportModes: MODES, airshipHireCopper: 120 },
    regions: normalizeEventRegionOptions(rows, { fallback: false }), organizations, isGM
  };
}

/** Independent exhaustive paths/services, with a fixed seed and no production pruning helpers. */
export function checkTransportSearchOracle() {
  let randomState = 0x51a7c0de;
  const next = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = (values) => values[Math.floor(next() * values.length)];
  let checked = 0, enumerated = 0;
  for (let seed = 0; seed < 20; seed++) {
    const rows = [["h", "A"], ["x", "B"], ["y", "B"], ["z", "C"], ["m", "C"]]
      .map(([value, countryId]) => ({ value, label: value, countryId, marketLandmassId: "mainland",
        marketTransportModes: MODES, marketLinks: [] }));
    const add = (from, to, index, singleMode = false) => {
      const modes = singleMode ? [pick(MODES)] : MODES.filter(() => next() < 0.55);
      if (!modes.length) modes.push(pick(MODES));
      rows.find((row) => row.value === from).marketLinks.push({ regionId: to, modes,
        distanceKm: pick([20, 40, 60, 80, 100]), routeId: `r-${index}`, ursCost: pick([1, 1, 2]) });
    };
    add("h", "x", 0); add("x", "m", 1); add("h", "y", 2); add("y", "m", 3);
    if (seed % 2 === 0) add("x", "y", 4);
    if (seed % 3 === 0) { add("x", "z", 5); add("z", "m", 6); }
    if (seed % 4 === 0) add("x", "m", 7, true);
    const organizations = [];
    for (const country of ["A", "B", "C"]) for (let index = 0; index < 2; index++) {
      const organization = normalizeMarketOrganization({ id: `${country}-${index}`, label: `${country}-${index}`,
        active: true, visibility: "public", carrier: { enabled: true, modes: MODES,
          priceFactor: pick([0.5, 0.75, 1, 1.5, 2]), timeFactor: pick([0.5, 0.8, 1, 1.5]),
          capacityFactor: pick([0.1, 0.25, 0.5, 1, 2]), riskFactor: pick([0.5, 1, 1.5]),
          countryShares: [{ countryId: country, sharePct: 100 }] } });
      organization.carrier.countryShares[0].sharePct = index ? pick([20, 40, 60]) : 40;
      if (index && seed % 5 === 0) organization.visibility = "gm";
      organizations.push(organization);
    }
    const input = transportFixture(rows, organizations, seed % 2 === 0);
    input.holding.gm.modifiers.marketConnectionsLevel = pick([4, 5, 6]);
    for (const direction of ["inbound", "outbound"]) {
      const exhaustive = exhaustivePlans(input, direction);
      enumerated += exhaustive.length;
      const selected = planMarketTransport({ ...input, direction });
      assert.equal(selected.logistics.reasons?.some((reason) => reason.includes("слишком много альтернатив")), false,
        "the small oracle network must complete rather than compare a partial answer");
      for (const serviceLevel of ["standard", "express", "charter"]) for (const load of [0.01, 1, 35]) for (const price of [1, 5000]) {
        const qty = 3;
        const plan = (logistics) => planMarketPurchase({ holding: input.holding, serviceLevel, quantities: { cargo: qty }, quote: {
          offers: [{ id: "cargo", stock: qty, unitPriceCopper: price, load }], location: {}, logistics,
          deliveryMode: "scheduled", deliveryBaseQd: 1, deliveryQd: 1 + logistics.travelQd
        } });
        const expected = exhaustive.map(plan).filter((row) => row.ok)
          .sort((a, b) => a.totalCopper - b.totalCopper || a.deliveryQd - b.deliveryQd)[0];
        const actual = plan(selected.logistics), label = [seed, direction, serviceLevel, load, price].join("/");
        assert.equal(actual.ok, Boolean(expected), `${label}: preserve feasibility`);
        if (expected) assert.deepEqual([actual.totalCopper, actual.deliveryQd], [expected.totalCopper, expected.deliveryQd],
          `${label}: preserve the exact exhaustive monetary optimum and ETA tie-break`);
        checked++;
      }
    }
  }
  assert.equal(checked, 720);
  assert.equal(enumerated, 12_338, "the deterministic oracle must continue to exercise the same complete search space");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTransportSearchOracle();
  console.log("Transport search oracle: 20 deterministic networks, 12,338 complete paths/services and 720 GM/player directional service/load/value comparisons passed.");
}
