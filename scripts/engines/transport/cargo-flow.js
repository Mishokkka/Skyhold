/** Remove quantities already forwarded, keeping each receipt's availability and source metadata. */
export function remainingCargoArrivals(arrivals, used = []) {
  const forwarded = new Map();
  for (const lot of used) forwarded.set(lot.lotId, (forwarded.get(lot.lotId) ?? 0) + lot.qty);
  return [...arrivals].sort((a, b) => a.arrivalQd - b.arrivalQd).flatMap(arrival => {
    const cargo = arrival.cargo.flatMap(lot => {
      const consumed = Math.min(lot.qty, forwarded.get(lot.lotId) ?? 0);
      forwarded.set(lot.lotId, (forwarded.get(lot.lotId) ?? 0) - consumed);
      return lot.qty > consumed ? [{ ...lot, qty: lot.qty - consumed }] : [];
    });
    return cargo.length ? [{ ...arrival, cargo }] : [];
  });
}

/** Keep dated, committed departures supplied without consuming earlier stock needed by other trips. */
export function unreservedCargoArrivals(arrivals, reservations = []) {
  const remaining = arrivals.map(row => ({ ...row, cargo: row.cargo.map(lot => ({ ...lot })) }))
    .sort((a, b) => a.arrivalQd - b.arrivalQd);
  for (const reservation of [...reservations].sort((a, b) => a.startQd - b.startQd)) for (const lot of reservation.cargo) {
    let qty = lot.qty;
    for (let index = remaining.length - 1; index >= 0 && qty; index--) {
      const arrival = remaining[index];
      if (arrival.arrivalQd > reservation.startQd) continue;
      for (const available of arrival.cargo) {
        if (available.lotId !== lot.lotId) continue;
        const take = Math.min(qty, available.qty);
        available.qty -= take; qty -= take;
      }
    }
    if (qty) throw new Error("Не найден входящий груз подтверждённого рейса. Сначала обработайте его предыдущие участки.");
  }
  return remaining.map(row => ({ ...row, cargo: row.cargo.filter(lot => lot.qty > 0) })).filter(row => row.cargo.length);
}

export function ageTransportCargo(lot, atQd, fallbackQd) {
  return { ...lot, ageQd: (lot.ageQd ?? 0) + Math.max(0, atQd - (lot.ageAtQd ?? fallbackQd)), ageAtQd: atQd };
}

/** Loading needs cargo at its start; future receipts cannot fill a departure retrospectively. */
export function availableTransportCargo(arrivals, used, atQd, { age = true } = {}) {
  const merged = new Map();
  for (const arrival of remainingCargoArrivals(arrivals, used)) {
    if (arrival.arrivalQd > atQd) continue;
    for (const source of arrival.cargo) {
      const lot = age ? ageTransportCargo(source, atQd, arrival.arrivalQd) : { ...source };
      const previous = merged.get(lot.lotId);
      if (previous) {
        previous.qty += lot.qty;
        if (age) previous.ageQd = Math.max(previous.ageQd, lot.ageQd);
        else if ((lot.ageAtQd ?? 0) - (lot.ageQd ?? 0) < (previous.ageAtQd ?? 0) - (previous.ageQd ?? 0)) {
          previous.ageQd = lot.ageQd;
          if (lot.ageAtQd === undefined) delete previous.ageAtQd; else previous.ageAtQd = lot.ageAtQd;
        }
      }
      else merged.set(lot.lotId, lot);
    }
  }
  return [...merged.values()];
}

export function allArrivalCargo(arrivals, used = []) {
  return availableTransportCargo(arrivals, used, Math.max(0, ...arrivals.map(row => row.arrivalQd)));
}

export function cargoQuantitiesMatch(left, right) {
  const quantities = lots => lots.reduce((map, lot) => map.set(lot.lotId, (map.get(lot.lotId) ?? 0) + lot.qty), new Map());
  const a = quantities(left), b = quantities(right);
  return a.size === b.size && [...a].every(([id, qty]) => b.get(id) === qty);
}
