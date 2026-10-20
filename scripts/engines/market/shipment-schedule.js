import { MARKET_DELIVERY_SERVICES } from "./pricing.js";

function nonnegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

/** Recover the accepted queue from existing fields; never rewind departed cargo. */
export function marketShipmentSchedule(order = {}) {
  const deliveryQd = nonnegative(order.deliveryQd ?? order.etaQd);
  const remainingQd = nonnegative(order.remainingQd ?? deliveryQd);
  const service = MARKET_DELIVERY_SERVICES[String(order.serviceLevel ?? "standard")] ?? MARKET_DELIVERY_SERVICES.standard;
  const index = Math.max(0, Math.floor(nonnegative(order.batchIndex)));
  const standardQd = nonnegative(order.standardDeliveryQd);
  const acceptedTransportQd = Math.max(1, Math.ceil(standardQd * service.etaFactor));
  const acceptedDepartureQd = index * Math.max(1, Math.ceil(standardQd * service.intervalFactor));
  // Noncanonical/partial legacy orders have no reliable queue to reconstruct.
  const recoverable = Number(order.batchCount) > 1 && index > 0 && standardQd > 0
    && deliveryQd === acceptedTransportQd + acceptedDepartureQd;
  const transportQd = recoverable ? acceptedTransportQd : deliveryQd;
  const departureQd = recoverable ? acceptedDepartureQd : 0;
  const booked = order.dispatchStatus === "booked" && !String(order.dispatchedAt ?? "")
    && ["booked", "pending", "in-transit"].includes(String(order.status ?? ""))
    && ["pending", "waived"].includes(String(order.riskStatus ?? ""));
  const waitingQd = booked ? Math.min(departureQd, Math.max(0, remainingQd - transportQd)) : 0;
  return { deliveryQd, remainingQd, transportQd, departureQd, booked, waitingQd, isWaiting: waitingQd > 0 };
}
