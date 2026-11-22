import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { customerTransportFare } from "../engines/ships/customer-fares.js";
import { contractGuidance, resolveContractOutcome } from "../engines/ships/contracts.js";
import { buildShipWorldContext, generateWorldShipOffers, quoteWorldShipBundle, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { referenceTransportCosts, transportRiskBps } from "../engines/transport/economics.js";
import { validateTransportConfiguration } from "../engines/transport/services.js";
import { getShipProfile } from "../engines/ships/profiles.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";

export function checkShipFreightTerms() {
  const { data, holding, ship } = worldMarketFixture();
  data.catalog.marketEconomy.baseOffers[0].priceOverrideCopper = 300;
  const home = data.catalog.eventRegions.find(row => row.value === "home");
  for (const [id, distanceKm] of [["c", 120], ["d", 800], ["e", 1500]]) {
    data.catalog.eventRegions.push({ ...home, value: id, label: id, marketLinks: [] });
    home.marketLinks.push({ regionId: id, distanceKm, modes: ["airship"] });
  }
  const context = buildShipWorldContext(data, holding);
  const board = random => generateWorldShipOffers(data, holding, ship, { context, period: 1, random });
  const distant = board(() => 0.96);
  assert.ok(distant.length && distant.some(row => row.to.id === "e"));
  assert.ok(distant.every(row => ["a", "b", "c"].includes(row.contract.pickup.id)), "a distant consignee does not force a distant pickup");
  const orders = board(() => 0.4), freight = orders[0], mail = orders.find(row => row.kind === "commission");
  assert.equal(freight.kind, "freight");
  assert.deepEqual(mail.contract.pickup, freight.contract.pickup);
  assert.deepEqual(mail.to, freight.to);
  assert.ok(mail.contract.cargo.loadPoints > 0 && mail.contract.cargo.loadPoints + freight.contract.cargo.loadPoints <= ship.capacityLoadPoints);
  assert.equal(quoteWorldShipBundle(data, holding, ship, [freight, mail], { context }).stops.length, 2);

  const earlierOffers = structuredClone([freight, mail]);
  for (const row of earlierOffers) {
    delete row.contract.economics.boldRiskPercent;
    delete row.contract.economics.taxCopper;
    row.contract.economics.cleanPassageBonusPercent = 12;
  }
  const earlierBundle = quoteWorldShipBundle(data, holding, ship, earlierOffers, { context });
  for (const stop of earlierBundle.stops) {
    const physicalTerms = { kind: "freight", rewardCopper: 0, economics: stop.economics };
    assert.equal(contractGuidance(physicalTerms, "bold").riskBps, Math.min(10000, Math.ceil(stop.economics.riskBps * 1.5)),
      "a board saved before the second captain rebalance retains its physical risk");
  }
  assert.throws(() => quoteWorldShipBundle(data, holding, ship, [freight, earlierOffers[1]], { context }), /разные условия капитана/);
  const oldMail = structuredClone(mail);
  delete oldMail.contract.economics.cautiousReductionPercent;
  delete oldMail.contract.economics.boldRiskPercent;
  delete oldMail.contract.economics.cleanPassageBonusPercent;
  assert.throws(() => quoteWorldShipBundle(data, holding, ship, [freight, oldMail], { context }), /разные условия капитана/);

  // Remote pickups from an external port also stay within the 3 nearest ports.
  const portShip = structuredClone(ship);
  portShip.location = { kind: "market", id: "a", regionId: "a", label: "a" };
  const fromPort = generateWorldShipOffers(data, holding, portShip, { context, period: 2, random: () => 0.1 });
  assert.equal(fromPort[0].kind, "freight", "slot 0 generates freight first so companion mail can attach");
  const remoteFromPort = generateWorldShipOffers(data, holding, portShip, { context, period: 3, random: () => 0.34 });
  for (const row of remoteFromPort) {
    if (row.contract.pickup) assert.notEqual(row.contract.pickup.id, "e", "external remote pickup avoids far ports");
  }

  // Smuggling excludes low value-density bulk raw materials and prefers valuable cargo.
  const smugData = structuredClone(data);
  smugData.catalog.resources.push(
    { id: "cheap-logs", label: "Брёвна", basePriceCopper: 4, loadPoints: 4 },
    { id: "cheap-grain", label: "Зерно", basePriceCopper: 8, loadPoints: 4 },
    { id: "luxury-silk", label: "Шёлк", basePriceCopper: 240, loadPoints: 2 }
  );
  smugData.catalog.marketEconomy.baseOffers.push(
    { id: "cheap-logs", resourceId: "cheap-logs", name: "Брёвна", kind: "resource", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 4, active: true },
    { id: "cheap-grain", resourceId: "cheap-grain", name: "Зерно", kind: "resource", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 8, active: true },
    { id: "luxury-silk", resourceId: "luxury-silk", name: "Шёлк", kind: "resource", ubiquity: "essential", baseStock: 2000, baseDemand: 2000, priceOverrideCopper: 240, active: true }
  );
  const smugHolding = smugData.holdings[0], smugShip = smugHolding.special.ships.list[0];
  smugShip.attentionByDirection = { "port:a": { level: 9 }, "port:b": { level: 9 }, "port:c": { level: 9 }, "port:d": { level: 9 }, "port:e": { level: 9 } };
  const smugContext = buildShipWorldContext(smugData, smugHolding);
  const smugBoard = generateWorldShipOffers(smugData, smugHolding, smugShip, { context: smugContext, period: 4, random: () => 0.5 });
  const smugOffer = smugBoard.find(row => row.kind === "smuggling");
  assert.ok(smugOffer, "expected smuggling offer on high-attention board");
  assert.ok(["luxury-silk", "test-freight"].includes(smugOffer.contract.cargo.resourceId),
    "smuggling excludes bottom-half cheap bulk commodities");
  for (const row of smugData.catalog.marketEconomy.baseOffers) {
    if (["luxury-silk", "test-freight"].includes(row.resourceId)) row.baseStock = 1;
  }
  const scarceBoard = generateWorldShipOffers(smugData, smugHolding, smugShip, { period: 5, random: () => 0.5 });
  const scarceOffer = scarceBoard.find(row => row.kind === "smuggling");
  assert.ok(["luxury-silk", "test-freight"].includes(scarceOffer?.contract.cargo.resourceId),
    "scarce valuable stock is eligible even when it cannot fill the hiding spaces");
  for (const row of smugData.catalog.resources) {
    if (["luxury-silk", "test-freight"].includes(row.id)) row.shelfLifeQd = 1;
  }
  const spoiledBoard = generateWorldShipOffers(smugData, smugHolding, smugShip, { period: 6, random: () => 0.5 });
  assert.ok(!spoiledBoard.some(row => row.kind === "smuggling"), "unsuitable valuable lots do not fall back to the cheaper half");

  // UI context marks companion commission offers and barque extra-watch risk reduction.
  const uiData = structuredClone(data);
  uiData.holdings[0].special.ships.offers = orders.map(row => ({ ...structuredClone(row), period: 0 }));
  const uiContext = prepareShipWindowContext(uiData.holdings[0], { data: uiData, shipId: ship.id });
  const uiMail = uiContext.rows[0].offers.find(row => row.kind === "commission");
  assert.equal(uiMail?.isCompanion, true, "companion commission is flagged in ship window context");
  assert.match(uiMail?.companionHint ?? "", /Попутно к фрахту/);
  const ordersTemplate = readFileSync(new URL("../../templates/parts/ship-window/orders.hbs", import.meta.url), "utf8");
  assert.match(ordersTemplate, /<label[^>]+data-fbls-tooltip="\{\{#if isCompanion\}\}\{\{companionHint\}\}/,
    "the order label bubbles focus from the checkbox to the floating tooltip");
  assert.match(ordersTemplate, /<input[^>]+data-ship-bundle-select[^>]+aria-description="\{\{companionHint\}\}"/,
    "the focused chooser carries the companion explanation for assistive technology");
  checkPerishableCompanion();

  const unitCost = id => {
    const profile = getShipProfile(id), capacity = profile.capacityLoadPoints / 4;
    return referenceTransportCosts("airship", capacity).dailyCopper / (capacity * profile.speedKmPerDay);
  };
  assert.ok(unitCost("merchant-barque") < Math.min(unitCost("schooner"), unitCost("cutter")));
  ship.name = "Watch test";
  const quoteWatch = count => {
    ship.crewTarget = count;
    return repriceWorldShipOffer(data, holding, ship, freight, { context });
  };
  const single = quoteWatch(18), double = quoteWatch(36);
  const baseRisk = validateTransportConfiguration(data.catalog?.transportV2).riskBps;
  assert.equal(double.contract.rewardCopper, single.contract.rewardCopper);
  assert.ok(double.quote.costs.crewCopper > single.quote.costs.crewCopper);
  assert.equal(single.contract.economics.riskBps, transportRiskBps(single.quote.riskExposureQd, baseRisk),
    "18 ready watchkeepers keep full base risk");
  assert.equal(double.contract.economics.riskBps, transportRiskBps(double.quote.riskExposureQd, Math.round(baseRisk * 0.75)),
    "36 ready watchkeepers reduce base risk by 25% (leaving 75%)");
  assert.equal(quoteWatch(54).contract.economics.riskBps, double.contract.economics.riskBps);

  const origin = context.ports.find(row => row.id === "a"), destination = context.ports.find(row => row.id === "b");
  const price = (kind, loadPoints, valueCopper = 0, attention = 0, riskBps = 0) => customerTransportFare({
    cargo: { kind, loadPoints, valueCopper }, attention, origin, destination, resources: context.resources,
    referenceRoute: profile => ({ distanceKm: 1000, durationQd: Math.ceil(4000 / profile.speedKmPerDay), riskExposureQd: 16 }),
    configuration: validateTransportConfiguration({ riskBps }) });
  assert.equal(price("freight", 480).specialPremiumCopper, 0);
  assert.ok(price("freight", 600).specialPremiumCopper > 0);
  for (const boundary of [800, 2000]) assert.ok(price("freight", boundary + 1).rewardCopper >= price("freight", boundary).rewardCopper);
  const seasonalFare = (loadPoints, riskierProfile, taxCopper = 0) => customerTransportFare({
    cargo: { kind: "freight", loadPoints }, origin, destination, resources: context.resources, taxCopper,
    referenceRoute: profile => ({ distanceKm: 1000, durationQd: Math.ceil(4000 / profile.speedKmPerDay),
      riskExposureQd: profile.id === riskierProfile ? 24 : 0 }),
    configuration: validateTransportConfiguration({ riskBps: 300 })
  });
  for (const [boundary, riskierProfile] of [[800, "cutter"], [2000, "schooner"]]) {
    const smaller = seasonalFare(boundary, riskierProfile, 111);
    const larger = seasonalFare(boundary + 1, riskierProfile, 111);
    assert.ok(smaller.riskPremiumCopper > larger.riskPremiumCopper, "mismatched seasonal exposure at the size boundary");
    assert.ok(larger.rewardCopper >= smaller.rewardCopper, "the loaded freight tariff stays monotone after the risk premium");
    assert.equal(larger.rewardCopper - seasonalFare(boundary + 1, riskierProfile).rewardCopper, 111, "customs are added once");
  }
  const contraband = price("smuggling", 20, 10000, 0, 300);
  assert.equal(contraband.specialPremiumCopper, 3500);
  assert.equal(price("smuggling", 20, 20000).specialPremiumCopper, 7000);
  assert.equal(price("smuggling", 20, 10000, 10).specialPremiumCopper, 5500);
  const luxuryContraband = price("smuggling", 20, 1_000_000, 0);
  assert.ok(luxuryContraband.specialPremiumCopper < 350_000 && luxuryContraband.specialPremiumCopper > 7000,
    "smuggling premium caps ultra-expensive cargo relative to route charter scale");
  assert.ok(price("smuggling", 20, 1_000_000, 10).specialPremiumCopper > luxuryContraband.specialPremiumCopper,
    "higher attention raises the smuggling premium ceiling");
  assert.ok(contraband.riskPremiumCopper > price("smuggling", 20, 10000).riskPremiumCopper);

  const clean = { commercialDice: [3, 4], incidentRoll: 12, passageRoll: 10000 };
  const terms = { ...single.contract, rewardCopper: 1000, economics: { ...single.contract.economics, taxCopper: 0, riskBps: 4000 } };
  const old = structuredClone(terms);
  delete old.economics.cleanPassageBonusPercent;
  delete old.economics.cautiousReductionPercent;
  delete old.economics.boldRiskPercent;
  assert.deepEqual([terms, old].map(row => contractGuidance(row, "cautious").riskBps), [1800, 3000]);
  assert.deepEqual([terms, old].map(row => contractGuidance(row, "bold").riskBps), [8000, 6000]);
  for (const [row, expected] of [[terms, 1060], [old, 1020]]) {
    assert.equal(contractGuidance(row, "bold").rewardRangeCopper.max, expected);
    assert.equal(resolveContractOutcome(row, "bold", clean).rewardCopper, expected);
    assert.equal(resolveContractOutcome(row, "bold", { ...clean, passageRoll: 1 }).rewardCopper, 1000);
  }
  const taxed = { ...terms, rewardCopper: 5000, economics: { ...terms.economics, taxCopper: 4000 } };
  assert.equal(contractGuidance(taxed, "bold").rewardRangeCopper.max, 5060, "bold clean-passage bonus excludes reimbursed customs taxes");
  assert.equal(resolveContractOutcome(taxed, "bold", clean).rewardCopper, 5060);

  function bestStyle(riskBps, rewardCopper = 350) {
    const order = { ...terms, rewardCopper, economics: { ...terms.economics, riskBps, approachRiskBps: 0,
      taxCopper: 0, repairCopper: 1800, precautionCopper: 60, delayDailyCopper: 438 } };
    const styles = ["normal", "cautious", "bold"].map(style => {
      const chance = contractGuidance(order, style).riskBps / 10000;
      const net = roll => {
        const outcome = resolveContractOutcome(order, style, roll);
        return outcome.rewardCopper - outcome.expenseCopper;
      };
      const incidentNet = Array.from({ length: 12 }, (_, index) => net({ ...clean, passageRoll: 1, incidentRoll: index + 1 }));
      return { style, expected: (1 - chance) * net(clean) + chance * incidentNet.reduce((sum, value) => sum + value, 0) / 12 };
    });
    return styles.sort((left, right) => right.expected - left.expected)[0].style;
  }
  assert.deepEqual([200, 1000, 4500].map(risk => bestStyle(risk, 350)), ["bold", "normal", "cautious"]);
  assert.deepEqual([300, 2000].map(risk => bestStyle(risk, 4000)), ["bold", "cautious"],
    "on realistic 40Z barque freight, bold wins on safe routes while cautious wins on dangerous routes");
}

function checkPerishableCompanion() {
  const { data, holding, ship } = worldMarketFixture();
  data.catalog.marketEconomy.baseOffers[0].priceOverrideCopper = 300;
  data.catalog.resources[0].shelfLifeQd = 15;
  holding.visibility = "public";
  holding.gm.playersCanManageShips = true;
  const draws = [0.4, 0.4, 0.4, 0.4, 0.4, 0.9];
  const offers = generateWorldShipOffers(data, holding, ship, { period: 0, random: () => draws.shift() ?? 0.4 });
  const freight = offers.find(row => row.kind === "freight");
  const mail = offers.find(row => row.kind === "commission");
  assert.ok(freight && mail, "mail can still be offered independently");
  assert.notEqual(mail.to.id, freight.to.id, "generation falls back to the originally drawn standalone destination");
  const savedMail = { ...mail, to: freight.to, contract: { ...mail.contract, pickup: freight.contract.pickup } };
  assert.throws(() => quoteWorldShipBundle(data, holding, ship, [freight, savedMail]), /нет совместимого маршрута/);
  holding.special.ships.offers = [freight, savedMail];
  const previousGame = globalThis.game;
  try {
    for (const isGM of [true, false]) {
      globalThis.game = { user: { id: isGM ? "gm" : "player", isGM }, users: [{ id: "gm", isGM: true, active: true }] };
      const row = prepareShipWindowContext(holding, { data, shipId: ship.id }).rows[0].offers.find(offer => offer.id === savedMail.id);
      assert.ok(row, "incompatible mail remains available separately");
      assert.ok(!row.isCompanion, "both roles see companion availability from the same route plan, including additional handling time");
    }
  } finally {
    globalThis.game = previousGame;
  }
}
