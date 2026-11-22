// Pure voyage calculations: constant daily speed, no night/core-rest mechanics.
function natural(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function sum(left, right, name) {
  return natural(left + right, name);
}

/** Each leg rounds up to whole QD, the existing manager time unit (4 per day). */
export function planShipVoyage({ legs, startQd, speedKmPerDay = 150 }) {
  natural(startQd, "startQd");
  natural(speedKmPerDay, "speedKmPerDay");
  if (!speedKmPerDay) throw new RangeError("speedKmPerDay must be positive");
  const metersPerQd = natural(speedKmPerDay * 250, "metersPerQd");
  if (!Array.isArray(legs) || !legs.length) throw new TypeError("legs must be a non-empty array");
  let cursor = startQd;
  let totalDistanceMeters = 0;
  let totalFlightQd = 0;
  let totalPortQd = 0;
  const schedule = legs.map((leg) => {
    const beginsQd = cursor;
    if (leg.type === "flight") {
      const distanceMeters = natural(leg.distanceMeters, "distanceMeters");
      const flightQd = Math.ceil(distanceMeters / metersPerQd);
      cursor = sum(cursor, flightQd, "arrivalQd");
      totalDistanceMeters = sum(totalDistanceMeters, distanceMeters, "totalDistanceMeters");
      totalFlightQd = sum(totalFlightQd, flightQd, "totalFlightQd");
      return { type: "flight", startQd: beginsQd, endQd: cursor, distanceMeters, flightQd };
    }
    if (leg.type !== "port") throw new TypeError("leg.type must be flight or port");
    const durationQd = natural(leg.durationQd, "durationQd");
    totalPortQd = sum(totalPortQd, durationQd, "totalPortQd");
    cursor = sum(cursor, durationQd, "port endQd");
    return { type: "port", startQd: beginsQd, endQd: cursor, durationQd };
  });
  return {
    startQd, endQd: cursor, durationQd: cursor - startQd, speedKmPerDay,
    totalDistanceMeters, totalFlightQd, totalPortQd,
    legs: schedule
  };
}
