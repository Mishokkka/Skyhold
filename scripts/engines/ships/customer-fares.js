import { getShipProfile } from "./profiles.js";
import { regularTransportRate, referenceTransportCosts, transportServiceCharge, transportRationPrice,
  transportPortHandlingQd, transportRiskBps } from "../transport/economics.js";
import { transportHandlingTerms, transportMoney } from "../transport/quantities.js";

/** A customer buys space between cargo ports. The player's approach, crew and return are not part of the fare. */
export function customerTransportFare({ cargo, origin, destination, resources, configuration, referenceRoute, attention = 0, taxCopper = 0 }) {
  const profile = getShipProfile(cargo.loadPoints <= 800 ? "cutter" : cargo.loadPoints <= 2000 ? "schooner" : "merchant-barque");
  const route = referenceRoute(profile);
  const capacityLoad = profile.capacityLoadPoints / 4;
  const factor = Math.max(0.01, origin.factors?.delivery ?? 1);
  const costsAt = port => Object.fromEntries(Object.entries(referenceTransportCosts("airship", capacityLoad,
    transportRationPrice(resources, port)).dailyCosts).map(([key, amount]) => [key, Math.ceil(amount * factor)]));
  const service = { kind: "regular", dispatchCopper: 1, profitBps: configuration.carrierProfitBps,
    ...transportHandlingTerms([origin.locationProfile, destination.locationProfile]),
    loadMilliCopper: regularTransportRate({ capacityLoad, travelQd: route.durationQd,
      loadingQd: transportPortHandlingQd(origin, profile.capacityLoadPoints),
      unloadingQd: transportPortHandlingQd(destination, profile.capacityLoadPoints),
      dailyCosts: costsAt(origin), returnDailyCosts: costsAt(destination), fixedCopper: 140,
      commercialLoadBps: configuration.commercialLoadBps }) };
  const charge = transportServiceCharge(service, cargo.loadPoints * 1000, 0);
  const riskBps = transportRiskBps(route.riskExposureQd * (cargo.kind === "smuggling" ? 2 + attention / 10 : 1), configuration.riskBps);
  // Mail/passenger care and clandestine carriage are explicit services, never hidden cost reimbursement.
  const specialPremiumBps = cargo.kind === "commission" ? 2500 : cargo.kind === "smuggling" ? 10000 : 0;
  const specialPremiumCopper = Math.ceil((charge.totalCopper - charge.handlingCopper) * specialPremiumBps / 10000);
  const riskPremiumCopper = Math.ceil((charge.totalCopper - charge.handlingCopper) * riskBps / 10000 * 0.25);
  return { rewardCopper: transportMoney([charge.totalCopper, taxCopper, specialPremiumCopper, riskPremiumCopper]),
    marketFeeCopper: charge.totalCopper, specialPremiumCopper, riskPremiumCopper, riskBps,
    referenceProfileId: profile.id };
}

/** Consumers can pay a delivery allowance; profitable resale can justify more. This is not merchant profit. */
export function ordinaryFreightBudget(cargo, demand, destination) {
  const destinationValue = Math.floor(cargo.quantity * demand.basePriceCopper * (destination.factors?.price ?? 1));
  return Math.max(Math.floor(destinationValue * 0.4), Math.floor(destinationValue * 0.9 - cargo.valueCopper), 0);
}
