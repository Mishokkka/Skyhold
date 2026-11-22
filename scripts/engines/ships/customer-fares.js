import { getShipProfile } from "./profiles.js";
import { MARKET_TRANSPORT_TARIFFS } from "../market/logistics.js";
import { regularTransportRate, referenceTransportCosts, transportServiceCharge, transportRationPrice,
  transportPortHandlingQd, transportRiskBps, configuredTransportCharges } from "../transport/economics.js";
import { transportHandlingTerms, transportMoney } from "../transport/quantities.js";

function referenceCharge(profile, loadPoints, { cargo, origin, destination, resources, configuration, referenceRoute }) {
  const route = referenceRoute(profile);
  const capacityLoad = profile.capacityLoadPoints / 4;
  const factor = Math.max(0.01, origin.factors?.delivery ?? 1);
  const charges = configuredTransportCharges({ mode: "airship", distanceKm: route.distanceKm, settings: origin,
    dispatchCopper: MARKET_TRANSPORT_TARIFFS.airship.dispatchCopper, deliveryFactor: factor });
  const costsAt = (port, seasonalFactor = 1) => Object.fromEntries(Object.entries(referenceTransportCosts("airship", capacityLoad,
    transportRationPrice(resources, port)).dailyCosts).map(([key, amount]) => [key, Math.ceil(amount * factor * seasonalFactor)]));
  const dailyCosts = costsAt(origin, route.operatingFactor), returnDailyCosts = costsAt(destination, route.returnOperatingFactor);
  const loadingQd = transportPortHandlingQd(origin, profile.capacityLoadPoints);
  const unloadingQd = transportPortHandlingQd(destination, profile.capacityLoadPoints);
  const loadMilliCopper = Math.ceil(charges.loadCopperPerUnit * 1000);
  const service = { kind: "regular", dispatchCopper: 1, profitBps: configuration.carrierProfitBps,
    ...transportHandlingTerms([origin.locationProfile, destination.locationProfile]),
    loadMilliCopper: regularTransportRate({ capacityLoad, travelQd: route.durationQd, returnTravelQd: route.returnDurationQd,
      loadingQd, unloadingQd, dailyCosts, returnDailyCosts,
      fixedCopper: Math.ceil(charges.dispatchCopper + charges.hireCopper + charges.distanceCopper),
      loadMilliCopper,
      commercialLoadBps: configuration.commercialLoadBps }) };
  const charge = transportServiceCharge(service, loadPoints * 1000, 0);
  let carriageCopper = charge.totalCopper - charge.handlingCopper;
  const fill = loadPoints / profile.capacityLoadPoints;
  if (cargo.kind === "freight" && fill > 0.6) {
    const returnQd = route.returnDurationQd ?? route.durationQd;
    const occupiedQd = configuration.charterPreparationQd + transportPortHandlingQd(origin, loadPoints)
      + route.durationQd + transportPortHandlingQd(destination, loadPoints) + returnQd;
    const charter = transportServiceCharge({ ...service, kind: "charter", dailyCosts, returnDailyCosts, loadMilliCopper,
      dispatchCopper: Math.ceil(charges.dispatchCopper + charges.hireCopper + 2 * charges.distanceCopper) },
    loadPoints * 1000, occupiedQd, returnQd);
    carriageCopper += Math.round(Math.max(0, charter.totalCopper - charge.totalCopper) * Math.min(1, (fill - 0.6) / 0.4));
  }
  return { charge, carriageCopper, exposure: route.riskExposureQd };
}

/** A customer buys space between cargo ports, not the owner's crew or empty approach. */
export function customerTransportFare(request) {
  const { cargo, configuration, attention = 0, taxCopper = 0 } = request;
  const profiles = ["cutter", "schooner", "merchant-barque"].map(getShipProfile);
  const profile = profiles.find(row => cargo.loadPoints <= row.capacityLoadPoints) ?? profiles.at(-1);
  let freightFloor = 0;
  if (cargo.kind === "freight") for (const smaller of profiles) {
    if (smaller === profile) break;
    freightFloor = Math.max(freightFloor, referenceCharge(smaller, smaller.capacityLoadPoints, request).carriageCopper);
  }
  const { charge, carriageCopper, exposure } = referenceCharge(profile, cargo.loadPoints, request);
  const regularCopper = charge.totalCopper - charge.handlingCopper;
  let specialPremiumCopper;
  if (cargo.kind === "smuggling") {
    const fullCarriage = referenceCharge(profile, profile.capacityLoadPoints, request).carriageCopper;
    const capCopper = Math.ceil(fullCarriage * (400 + 20 * attention) / 100);
    specialPremiumCopper = Math.min(capCopper, Math.ceil(cargo.valueCopper * (35 + 2 * attention) / 100));
  } else if (cargo.kind === "commission") {
    specialPremiumCopper = Math.ceil(regularCopper * 0.25);
  } else {
    specialPremiumCopper = Math.max(freightFloor, carriageCopper) - regularCopper;
  }
  const riskBps = transportRiskBps(exposure * (cargo.kind === "smuggling" ? 2 + attention / 10 : 1), configuration.riskBps);
  const riskPremiumCopper = Math.ceil((regularCopper + specialPremiumCopper) * riskBps * 85 / 1_000_000);
  return { rewardCopper: transportMoney([charge.totalCopper, taxCopper, specialPremiumCopper, riskPremiumCopper]),
    marketFeeCopper: charge.totalCopper, specialPremiumCopper, riskPremiumCopper, taxCopper, riskBps, referenceProfileId: profile.id };
}

/** Consumers can pay a delivery allowance; profitable resale can justify more. This is not merchant profit. */
export function ordinaryFreightBudget(cargo, demand, destination) {
  const destinationValue = Math.floor(cargo.quantity * demand.basePriceCopper * (destination.factors?.price ?? 1));
  return Math.max(Math.floor(destinationValue * 0.4), Math.floor(destinationValue * 0.9 - cargo.valueCopper), 0);
}
