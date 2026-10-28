/** One storage load = four ship points. Persist thousandths of a point. */
export const TRANSPORT_LOAD_SCALE = 4000;
export const TRANSPORT_LIMITS = Object.freeze({ runs: 512, paths: 256, stages: 8, horizonQd: 1440 });

export function transportInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`Некорректно: ${label}.`);
  return value;
}

export function transportLoad(value) {
  const scaled = Number(value) * TRANSPORT_LOAD_SCALE;
  const rounded = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - rounded) > 0.000001) throw new RangeError("Объём требует точности выше 0,001 грузового пункта.");
  return transportInteger(rounded, "объём");
}

export function cargoLoad(cargo) {
  return transportInteger(cargo.reduce((sum, lot) => sum + transportInteger(lot.qty, "количество", 1)
    * transportInteger(lot.unitLoad, "объём единицы"), 0), "объём груза");
}

export function cargoValue(cargo) {
  return transportInteger(cargo.reduce((sum, lot) => sum + lot.qty * transportInteger(lot.unitCopper, "цена единицы"), 0), "стоимость груза");
}

/** Deterministic oldest-first packing; indivisible inventory units never become fractional. */
export function takeTransportCargo(cargo, capacity) {
  let free = transportInteger(capacity, "вместимость");
  const taken = [], remaining = [];
  for (const lot of cargo) {
    const qty = lot.unitLoad === 0 ? lot.qty : Math.min(lot.qty, Math.floor(free / lot.unitLoad));
    if (qty) taken.push({ ...lot, qty });
    if (qty < lot.qty) remaining.push({ ...lot, qty: lot.qty - qty });
    free -= qty * lot.unitLoad;
  }
  return { taken, remaining };
}

export function transportMoney(parts) {
  return transportInteger(parts.reduce((sum, value) => sum + transportInteger(value, "сумма"), 0), "итоговая сумма", 0, 1000000000);
}

export function transportRateCharge(amount, milliCopper, scale = 1000) {
  const numerator = BigInt(transportInteger(amount, "объём тарифа")) * BigInt(transportInteger(milliCopper, "тариф"));
  const divisor = BigInt(transportInteger(scale, "масштаб тарифа", 1));
  return transportInteger(Number((numerator + divisor - 1n) / divisor), "начисление", 0, 1000000000);
}

export function shipTransportFunding({ expensesCopper, reserveCopper = 0, onboardCopper = 0 }) {
  const requiredCopper = transportMoney([expensesCopper, reserveCopper]);
  const fromShipCopper = Math.min(requiredCopper, transportInteger(onboardCopper, "деньги на борту"));
  return { expensesCopper, reserveCopper, requiredCopper, fromShipCopper, treasuryCopper: requiredCopper - fromShipCopper };
}

/** Shared owned-vessel operating costs; each named component rounds once per physical leg. */
export function transportPeriodCosts(durationQd, { foodCopper = 0, crewCopper = 0, upkeepCopper = 0 } = {}) {
  const result = { foodCopper: transportRateCharge(durationQd, foodCopper * 1000, 4000),
    crewCopper: transportRateCharge(durationQd, crewCopper * 1000, 4000), upkeepCopper: transportRateCharge(durationQd, upkeepCopper * 1000, 4000) };
  return { ...result, totalCopper: transportMoney(Object.values(result)) };
}

export function transportOperatingCharge(service, durationQd, returning = false) {
  const costs = returning ? service.returnDailyCosts ?? service.dailyCosts : service.dailyCosts;
  if (costs) return transportPeriodCosts(durationQd, costs).totalCopper;
  const rate = returning ? service.returnOperatingMilliCopperPerQd ?? service.operatingMilliCopperPerQd : service.operatingMilliCopperPerQd;
  return transportRateCharge(durationQd, rate ?? (service.operatingCopperPerQd ?? 0) * 1000);
}

export function transportWaitingCharge(service, durationQd) {
  if (service.waitingMilliCopperPerQd === 0) return 0;
  return service.dailyCosts ? transportPeriodCosts(durationQd, service.dailyCosts).totalCopper
    : transportRateCharge(durationQd, service.waitingMilliCopperPerQd ?? service.operatingMilliCopperPerQd ?? 0);
}

/** One loading/unloading operation per physical endpoint; transit-only points have no handling. */
export function transportHandlingTerms(profiles = []) {
  return {
    handlingFlatCopper: transportMoney(profiles.map(profile => Math.ceil(profile?.deliveryFlatCopper ?? 0))),
    handlingMilliCopper: transportInteger(profiles.reduce((sum, profile) => sum + Math.ceil((profile?.deliveryLoadCopper ?? 0) * 1000), 0), "обработка груза")
  };
}
