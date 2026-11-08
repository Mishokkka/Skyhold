import { SHIP_PROFILES } from "../ships/profiles.js";
import { transportInteger, transportPeriodCosts, transportMoney, transportRateCharge, transportOperatingCharge, TRANSPORT_LOAD_SCALE } from "./quantities.js";

export const TRANSPORT_ECONOMICS = Object.freeze({
  profitBps: 2000, commercialLoadBps: 6500, referenceRiskQd: 16,
  meanLossBps: 2500, insuranceLoadingBps: 2500, minimumPolicyCopper: 1
});

/** Published preparation and distance supplements, shared by hired routes and reference customer fares. */
export function configuredTransportCharges({ mode, distanceKm, settings = {}, dispatchCopper = 0, priceFactor = 1, deliveryFactor = 1 }) {
  const rate = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
  const distance = rate(distanceKm) / 40;
  return {
    dispatchCopper: dispatchCopper * priceFactor,
    hireCopper: mode === "airship" ? rate(settings.airshipHireCopper, 120) * priceFactor : 0,
    distanceCopper: distance * rate(settings.deliveryDistanceCopper) * priceFactor * deliveryFactor,
    loadCopperPerUnit: distance * rate(settings.deliveryLoadDistanceCopper) * priceFactor * deliveryFactor
  };
}

/** One invoice rule for reference carriers, customer jobs and actual owned transport. */
export function transportServiceCharge(service, load, occupiedQd, returnQd = 0) {
  const dispatchCopper = service.dispatchCopper ?? 0;
  const loadCopper = transportRateCharge(load, service.loadMilliCopper ?? (service.loadCopper ?? 0) * 1000, TRANSPORT_LOAD_SCALE * 1000);
  const operatingCopper = service.kind === "regular" ? 0 : transportOperatingCharge(service, occupiedQd - returnQd)
    + transportOperatingCharge(service, returnQd, true);
  const handlingCopper = (service.handlingFlatCopper ?? 0)
    + transportRateCharge(load, service.handlingMilliCopper ?? (service.handlingCopper ?? 0) * 1000, TRANSPORT_LOAD_SCALE * 1000);
  const gross = transportMoney([dispatchCopper, loadCopper, operatingCopper, handlingCopper]);
  const discountBps = transportInteger(service.discountBps ?? 0, "скидка", 0, 10000);
  const discountCopper = Math.floor((dispatchCopper + loadCopper) * discountBps / 10000);
  const profitBps = transportInteger(service.profitBps ?? 0, "надбавка перевозчика", 0, 10000);
  const profitCopper = Math.ceil((dispatchCopper + loadCopper + operatingCopper - discountCopper) * profitBps / 10000);
  return { dispatchCopper, loadCopper, operatingCopper, handlingCopper, discountCopper,
    ...(profitBps ? { profitCopper } : {}), totalCopper: transportMoney([gross - discountCopper, profitCopper]) };
}

/** Same daily ration basket for reference carriers and actual ship crews. */
export function transportRationPrice(resources, port = {}) {
  const edible = resources.filter(row => row.foodEdible === true && row.noAutoConsume !== true && row.basePriceCopper > 0);
  const ids = new Set(edible.map(row => row.id));
  const local = (port.offers ?? []).filter(row => ids.has(row.resourceId) && row.baseStock > 0)
    .map(row => row.basePriceCopper * (port.factors?.price ?? 1));
  const prices = (local.length ? local : edible.map(row => row.basePriceCopper * (port.factors?.price ?? 1))).sort((a, b) => a - b);
  if (!prices.length) throw new Error("В каталоге нет готовой пищи с ценой для расчёта снабжения.");
  return Math.ceil(prices[Math.floor((prices.length - 1) / 2)]);
}

/** Capacity is in storage loads, never the decorative historical tonnage. */
export function referenceTransportCosts(mode, capacityLoad, foodUnitCopper = 9) {
  if (!Number.isFinite(capacityLoad) || capacityLoad <= 0 || capacityLoad > 10000000) throw new Error("Некорректная вместимость перевозчика.");
  transportInteger(foodUnitCopper, "цена рациона");
  let crew, upkeep;
  if (mode === "airship") {
    const profile = [SHIP_PROFILES.cutter, SHIP_PROFILES.schooner, SHIP_PROFILES["merchant-barque"]]
      .find(row => row.capacityLoadPoints / 4 >= capacityLoad) ?? SHIP_PROFILES["merchant-barque"];
    const scale = (capacityLoad / (profile.capacityLoadPoints / 4)) ** 0.85;
    crew = Math.max(2, Math.ceil(profile.crewTarget * scale));
    upkeep = Math.max(1, Math.ceil(profile.upkeepDailyCopper * scale));
  } else if (mode === "caravan") {
    // A wagon's team, feed and maintenance scale with the actual caravan.
    const wagons = Math.max(1, Math.ceil(capacityLoad / 40));
    crew = wagons * 2;
    upkeep = wagons * 24;
  } else if (mode === "rail") {
    crew = 4 + Math.ceil(capacityLoad / 2000);
    upkeep = 60 + Math.ceil(capacityLoad / 100) * 2;
  } else throw new Error("Неизвестный способ перевозки.");
  const dailyCosts = { foodCopper: crew * foodUnitCopper, crewCopper: crew * 12, upkeepCopper: upkeep };
  return { crew, dailyCosts, dailyCopper: transportMoney(Object.values(dailyCosts)) };
}

/** Full round trip, with paid load on both directions; handling fees are passed through separately. */
export function regularTransportRate({ capacityLoad, travelQd, loadingQd, unloadingQd, dailyCosts, returnDailyCosts = dailyCosts,
  fixedCopper = 0, loadMilliCopper = 0, commercialLoadBps = TRANSPORT_ECONOMICS.commercialLoadBps }) {
  transportInteger(commercialLoadBps, "коммерческая загрузка", 1, 10000);
  const occupied = travelQd + loadingQd + unloadingQd;
  const cycleCopper = transportMoney([transportPeriodCosts(occupied, dailyCosts).totalCopper,
    transportPeriodCosts(occupied, returnDailyCosts).totalCopper, fixedCopper * 2]);
  return Math.ceil(cycleCopper * 1000 / (2 * capacityLoad * commercialLoadBps / 10000)) + loadMilliCopper;
}

/** Exposure is time weighted by local danger; splitting an edge does not change its probability. */
export function transportRiskBps(exposureQd, baseRiskBps = 300) {
  if (!Number.isFinite(exposureQd) || exposureQd < 0) throw new Error("Некорректная длительность риска.");
  transportInteger(baseRiskBps, "исходный риск", 0, 10000);
  if (exposureQd === 0 || baseRiskBps === 0) return 0;
  return Math.min(10000, Math.round((1 - (1 - baseRiskBps / 10000) ** (exposureQd / TRANSPORT_ECONOMICS.referenceRiskQd)) * 10000));
}

/** Weight parallel departures by lot quantity; only consecutive legs compound losses. */
export function transportInsuranceCopper(plan, configuration) {
  let expectedLossCopper = 0;
  for (const lot of plan.cargo) {
    let survival = 1;
    for (const stage of plan.stages) {
      let exposure = 0;
      for (const run of stage.runs) {
        const qty = run.cargo.filter(row => row.lotId === lot.lotId).reduce((sum, row) => sum + row.qty, 0);
        exposure += qty / lot.qty * (run.riskBps ?? 0) / 10000;
      }
      survival *= 1 - exposure * TRANSPORT_ECONOMICS.meanLossBps / 10000;
    }
    expectedLossCopper += lot.qty * lot.unitCopper * (1 - survival);
  }
  const value = plan.cargo.reduce((sum, lot) => sum + lot.qty * lot.unitCopper, 0);
  if (!value) return 0;
  const covered = expectedLossCopper * configuration.insuranceCoverageBps / 10000;
  return transportInteger(Math.max(TRANSPORT_ECONOMICS.minimumPolicyCopper,
    Math.ceil(value * (configuration.insuranceBps ?? 0) / 10000),
    Math.ceil(covered * (1 + TRANSPORT_ECONOMICS.insuranceLoadingBps / 10000))), "страховая премия");
}

const PORT_CAPACITY = new Map([["outpost", 0.5], ["local", 0.75], ["town", 1], ["regional", 1.5], ["metropolis", 2], ["world-hub", 2.5]]);
export function transportPortCapacity(port = {}) {
  return Math.max(1, Math.floor(250 * (PORT_CAPACITY.get(port.sizeProfileId) ?? 1)
    / Math.max(0.01, Number(port.factors?.time ?? 1)) * TRANSPORT_LOAD_SCALE));
}
export function transportPortHandlingQd(port, loadPoints) {
  return loadPoints > 0 ? Math.max(1, Math.ceil(loadPoints * 1000 / transportPortCapacity(port))) : 0;
}

/** Old holdings need no rewrite: only an explicitly edited local distance replaces the fallback. */
export function localMarketDistanceKm(holding) {
  const value = Number(holding?.gm?.modifiers?.marketLocalDistanceKm ?? 20);
  if (!Number.isFinite(value) || value < 0 || value > 100000) throw new Error("Расстояние до местного рынка должно быть от 0 до 100000 км.");
  return value;
}
