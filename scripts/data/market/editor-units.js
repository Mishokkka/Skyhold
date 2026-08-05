export const MARKET_CARGO_POINTS_PER_LEGACY_LOAD = 10;

const CAPACITY_EDITOR_FIELDS = Object.freeze({
  caravanCapacityCargoPoints: "caravanCapacityLoad",
  railCapacityCargoPoints: "railCapacityLoad",
  airshipCapacityCargoPoints: "airshipCapacityLoad"
});

function nonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Number.isFinite(parsed) ? parsed : fallback);
}

export function marketCargoPointsFromStoredLoad(value = 0) {
  return nonNegative(value, 0) * MARKET_CARGO_POINTS_PER_LEGACY_LOAD;
}

export function storedLoadFromMarketCargoPoints(value = 0) {
  return nonNegative(value, 0) / MARKET_CARGO_POINTS_PER_LEGACY_LOAD;
}

export function prepareMarketEconomySettingsForEditor(settings = {}) {
  return {
    ...settings,
    handlingCopperPer10CargoPoints: nonNegative(settings.handlingLoadCopper, 0),
    caravanCapacityCargoPoints: marketCargoPointsFromStoredLoad(settings.caravanCapacityLoad),
    railCapacityCargoPoints: marketCargoPointsFromStoredLoad(settings.railCapacityLoad),
    airshipCapacityCargoPoints: marketCargoPointsFromStoredLoad(settings.airshipCapacityLoad)
  };
}

export function marketEconomySettingFromEditor(inputKey = "", inputValue = 0) {
  if (inputKey === "handlingCopperPer10CargoPoints") {
    return { key: "handlingLoadCopper", value: nonNegative(inputValue, 0) };
  }
  const storedKey = CAPACITY_EDITOR_FIELDS[inputKey];
  if (storedKey) {
    return { key: storedKey, value: storedLoadFromMarketCargoPoints(inputValue) };
  }
  return { key: inputKey, value: inputValue };
}
