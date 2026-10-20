const MAX_MONEY = 1_000_000_000;

function integer(value, name, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`Некорректное значение: ${name}.`);
  }
  return value;
}

function finiteRate(value, name, min = 0, max = 10) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`Некорректное значение: ${name}.`);
  }
  return value;
}

function moneyAdd(parts, name) {
  const total = parts.reduce((sum, value) => sum + integer(value, name), 0);
  return integer(total, name);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const SHIP_PROFILES = deepFreeze({
  "merchant-barque": {
    id: "merchant-barque",
    label: "Торговый барк",
    speedKmPerDay: 150,
    crewTarget: 36,
    capacityLoadPoints: 4000,
    cargoTonnes: 500,
    upkeepDailyCopper: 12,
    handlingLoadRateCopper: 1
  },
  schooner: {
    id: "schooner",
    label: "Торговая шхуна",
    speedKmPerDay: 170,
    crewTarget: 18,
    capacityLoadPoints: 2000,
    cargoTonnes: 250,
    upkeepDailyCopper: 6,
    handlingLoadRateCopper: 1
  },
  cutter: {
    id: "cutter",
    label: "Курьерский каттер",
    speedKmPerDay: 190,
    crewTarget: 8,
    capacityLoadPoints: 800,
    cargoTonnes: 80,
    upkeepDailyCopper: 3,
    handlingLoadRateCopper: 1
  }
});

export function getShipProfile(profileId) {
  const key = String(profileId ?? "").trim();
  if (!Object.prototype.hasOwnProperty.call(SHIP_PROFILES, key)) {
    throw new Error("Неизвестный профиль корабля.");
  }
  return SHIP_PROFILES[key];
}

/** Only an absent override uses the profile; an explicit zero closes the hold. */
export function shipCapacityLoadPoints(ship = {}) {
  return integer(Number(ship.capacityLoadPoints ?? getShipProfile(ship.profileId).capacityLoadPoints), "вместимость трюма", 0, 1_000_000);
}

/**
 * Calculate an owned ship's automatic costs for a quoted leg.
 * foodUnitCopper is one crew member's full daily ration. Wage inputs are daily.
 * Load capacity points and historical cargo tonnes deliberately remain separate units.
 */
export function calculateShipCosts(ship, {
  durationQd,
  crewCount = null,
  foodUnitCopper = 0,
  wageDailyCopper = 12,
  crewDailyCopper = null,
  portFeeFactor = 100,
  taxRate = 0,
  cargoValueCopper = 0,
  handlingLoadPoints = 0
} = {}) {
  const profile = getShipProfile(ship?.profileId);
  const duration = integer(durationQd, "длительность", 0, 100_000);
  const crew = integer(crewCount ?? ship?.crewTarget ?? profile.crewTarget, "численность команды", 0, 10_000);
  const ration = integer(foodUnitCopper, "стоимость дневного рациона");
  const dailyCrew = crewDailyCopper == null
    ? integer(integer(wageDailyCopper, "дневная плата") * crew, "дневная плата команды")
    : integer(crewDailyCopper, "дневная плата команды");
  const feeFactor = integer(portFeeFactor, "портовый коэффициент", 0, 10_000);
  const value = integer(cargoValueCopper, "стоимость груза");
  const load = integer(handlingLoadPoints, "погрузочный объём", 0, profile.capacityLoadPoints);
  const rate = finiteRate(taxRate, "ставка пошлины", 0, 1);

  const foodCopper = integer(Math.ceil(ration * crew * duration / 4), "провизия");
  const crewCopper = integer(Math.ceil(dailyCrew * duration / 4), "плата команды");
  const upkeepCopper = integer(Math.ceil(profile.upkeepDailyCopper * duration / 4), "содержание корабля");
  const baseHandling = Math.ceil(load * profile.handlingLoadRateCopper / 100);
  const handlingCopper = integer(Math.ceil(baseHandling * feeFactor / 100), "портовая обработка");
  const taxCopper = integer(Math.round(value * rate), "пошлина");
  const operatingCopper = moneyAdd(
    [foodCopper, crewCopper, upkeepCopper, handlingCopper, taxCopper],
    "расходы рейса"
  );

  return {
    foodCopper,
    crewCopper,
    upkeepCopper,
    handlingCopper,
    taxCopper,
    operatingCopper,
    totalCopper: operatingCopper
  };
}
