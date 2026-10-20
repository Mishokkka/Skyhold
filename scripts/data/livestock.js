export const LIVESTOCK_SCHEMA_VERSION = 1;
export const LIVESTOCK_SPECIES_IDS = Object.freeze(["poultry", "rabbits", "goats", "cattle", "pigs", "sheep", "horses"]);
export const LIVESTOCK_BUILDING_CAPACITY = 24;
export const LIVESTOCK_MARKET_PRICES_COPPER = Object.freeze({
  cattle: 1200,
  pigs: 360,
  sheep: 240,
  goats: 180,
  horses: 3600,
  poultry: 24,
  rabbits: 12,
  pigeons: 6
});

const PROFILE_BY_SPECIES = Object.freeze({
  poultry: Object.freeze({
    speciesId: "poultry",
    label: "Птица и гуси",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.poultry,
    capacity: 24,
    grazingSeasons: [],
    breedingSeasonId: "",
    shearingSeasonId: "",
    maturityQd: 240,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 2,
    feedUnitsPerHead: 1,
    offspringNumerator: 0,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: true,
    eggResourceId: "eggs",
    eggPerFullFlockDay: 6,
    producesMilk: false,
    milkResourceId: "milk",
    milkPerHeadDay: 0,
    milkPerFullFlockDay: 0,
    producesWool: false,
    woolResourceId: "wool",
    woolPerHead: 0,
    meatResourceId: "meat",
    meatPerAdult: 1,
    peltResourceId: "pelt",
    peltPerAdult: 0,
    tallowResourceId: "tallow",
    tallowPerAdult: 0,
    slaughterWorkQdPerHead: 1
  }),
  rabbits: Object.freeze({
    speciesId: "rabbits",
    label: "Кролики",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.rabbits,
    capacity: 24,
    grazingSeasons: [],
    breedingSeasonId: "spring",
    shearingSeasonId: "",
    maturityQd: 240,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 2,
    feedUnitsPerHead: 1,
    offspringNumerator: 4,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: false,
    producesWool: false,
    meatResourceId: "meat",
    meatPerAdult: 2,
    peltResourceId: "pelt",
    peltPerAdult: 0,
    tallowResourceId: "tallow",
    tallowPerAdult: 0,
    slaughterWorkQdPerHead: 1
  }),
  goats: Object.freeze({
    speciesId: "goats",
    label: "Козы",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.goats,
    capacity: 12,
    grazingSeasons: ["spring", "summer", "autumn"],
    breedingSeasonId: "spring",
    shearingSeasonId: "",
    maturityQd: 960,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 1,
    feedUnitsPerHead: 1,
    offspringNumerator: 1,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: true,
    milkResourceId: "milk",
    milkPerHeadDay: 0,
    milkPerFullFlockDay: 6,
    producesWool: false,
    woolResourceId: "wool",
    woolPerHead: 0,
    meatResourceId: "meat",
    meatPerAdult: 20,
    peltResourceId: "pelt",
    peltPerAdult: 1,
    tallowResourceId: "tallow",
    tallowPerAdult: 7,
    slaughterWorkQdPerHead: 1
  }),
  cattle: Object.freeze({
    speciesId: "cattle",
    label: "Крупный рогатый скот",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.cattle,
    capacity: 12,
    grazingSeasons: ["spring", "summer", "autumn"],
    breedingSeasonId: "spring",
    shearingSeasonId: "",
    maturityQd: 1920,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 1,
    feedUnitsPerHead: 2,
    offspringNumerator: 1,
    offspringDenominator: 2,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: true,
    milkResourceId: "milk",
    milkPerHeadDay: 1,
    milkPerFullFlockDay: 0,
    milkWorkQdPerHeadDay: 1,
    milkBatchWorkQdPerDay: 1,
    producesWool: false,
    woolResourceId: "wool",
    woolPerHead: 0,
    shearWorkQdPerHead: 1,
    shearBatchWorkQd: 1,
    meatResourceId: "meat",
    meatPerAdult: 180,
    peltResourceId: "pelt",
    peltPerAdult: 1,
    tallowResourceId: "tallow",
    tallowPerAdult: 12,
    slaughterWorkQdPerHead: 1
  }),
  pigs: Object.freeze({
    speciesId: "pigs",
    label: "Свиньи",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.pigs,
    capacity: 12,
    grazingSeasons: [],
    breedingSeasonId: "spring",
    shearingSeasonId: "",
    maturityQd: 960,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 1,
    feedUnitsPerHead: 1,
    offspringNumerator: 6,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: false,
    milkResourceId: "milk",
    milkPerHeadDay: 0,
    milkWorkQdPerHeadDay: 1,
    producesWool: false,
    woolResourceId: "wool",
    woolPerHead: 0,
    shearWorkQdPerHead: 1,
    meatResourceId: "meat",
    meatPerAdult: 55,
    peltResourceId: "pelt",
    peltPerAdult: 1,
    tallowResourceId: "tallow",
    tallowPerAdult: 2,
    slaughterWorkQdPerHead: 1
  }),
  sheep: Object.freeze({
    speciesId: "sheep",
    label: "Овцы",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.sheep,
    capacity: 12,
    grazingSeasons: ["spring", "summer", "autumn"],
    breedingSeasonId: "spring",
    shearingSeasonId: "spring",
    maturityQd: 960,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 1,
    feedUnitsPerHead: 1,
    offspringNumerator: 1,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: false,
    milkResourceId: "milk",
    milkPerHeadDay: 0,
    milkWorkQdPerHeadDay: 1,
    producesWool: true,
    woolResourceId: "wool",
    woolPerHead: 1,
    shearWorkQdPerHead: 1,
    shearBatchWorkQd: 1,
    meatResourceId: "meat",
    meatPerAdult: 30,
    peltResourceId: "pelt",
    peltPerAdult: 1,
    tallowResourceId: "tallow",
    tallowPerAdult: 6,
    slaughterWorkQdPerHead: 1
  }),
  horses: Object.freeze({
    speciesId: "horses",
    label: "Лошади",
    marketPriceCopper: LIVESTOCK_MARKET_PRICES_COPPER.horses,
    capacity: 12,
    grazingSeasons: ["spring", "summer", "autumn"],
    breedingSeasonId: "",
    shearingSeasonId: "",
    maturityQd: 1920,
    feedResourceId: "animal-feed",
    headsPerFeedUnit: 1,
    feedUnitsPerHead: 2,
    offspringNumerator: 0,
    offspringDenominator: 1,
    careWorkQdPerDay: 1,
    producesEggs: false,
    producesMilk: false,
    milkResourceId: "milk",
    milkPerHeadDay: 0,
    milkWorkQdPerHeadDay: 1,
    milkBatchWorkQdPerDay: 1,
    producesWool: false,
    woolResourceId: "wool",
    woolPerHead: 0,
    shearWorkQdPerHead: 1,
    shearBatchWorkQd: 1,
    meatResourceId: "meat",
    meatPerAdult: 0,
    peltResourceId: "pelt",
    peltPerAdult: 0,
    tallowResourceId: "tallow",
    tallowPerAdult: 0,
    slaughterWorkQdPerHead: 1
  })
});

const BUILDING_SPECIES = Object.freeze({
  "animal-pen": "poultry",
  pasture: "cattle",
  pigsty: "pigs",
  sheepfold: "sheep",
  stables: "horses"
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value = "", fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || String(fallback ?? "").trim();
}

function whole(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, Math.floor(parsed))) : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "да"].includes(value.trim().toLocaleLowerCase("ru"));
  return Boolean(value);
}

function stringList(value = []) {
  return [...new Set((Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/))
    .map((row) => text(row))
    .filter(Boolean))];
}

function speciesForBuilding(building = {}) {
  const explicit = text(building?.livestock?.speciesId ?? building?.livestockSpeciesId);
  if (LIVESTOCK_SPECIES_IDS.includes(explicit)) return explicit;
  const templateId = text(building?.templateId) || text(building?.id);
  return BUILDING_SPECIES[templateId] ?? "";
}

export function livestockProfileForSpecies(speciesId = "") {
  return clone(PROFILE_BY_SPECIES[text(speciesId)] ?? null);
}

export function livestockSpeciesForBuilding(building = {}) {
  return speciesForBuilding(building);
}

export function normalizeLivestockBuilding(value = {}, { building = {} } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const speciesId = LIVESTOCK_SPECIES_IDS.includes(text(source.speciesId)) ? text(source.speciesId) : speciesForBuilding(building);
  if (!speciesId) return null;
  const defaults = livestockProfileForSpecies(speciesId);
  const suppliedProfile = source.profile && typeof source.profile === "object" ? source.profile : {};
  const rawProfile = text(suppliedProfile.speciesId) && text(suppliedProfile.speciesId) !== speciesId ? {} : suppliedProfile;
  const profile = {
    ...defaults,
    ...clone(rawProfile),
    speciesId,
    label: text(rawProfile.label, defaults.label),
    marketPriceCopper: whole(rawProfile.marketPriceCopper, defaults.marketPriceCopper),
    capacity: Math.min(
      LIVESTOCK_BUILDING_CAPACITY,
      // The v18 sheepfold explicitly provides room for breeders and lambs.
      // A saved 12-head profile keeps its capacity until manual catalog update.
      speciesId === "sheep" ? LIVESTOCK_BUILDING_CAPACITY : defaults.capacity,
      Math.max(1, whole(rawProfile.capacity ?? source.capacity, defaults.capacity))
    ),
    grazingSeasons: stringList(rawProfile.grazingSeasons ?? defaults.grazingSeasons).filter((row) => ["spring", "summer", "autumn", "winter"].includes(row)),
    breedingSeasonId: text(rawProfile.breedingSeasonId ?? defaults.breedingSeasonId),
    shearingSeasonId: text(rawProfile.shearingSeasonId ?? defaults.shearingSeasonId),
    maturityQd: Math.max(1, whole(rawProfile.maturityQd, defaults.maturityQd)),
    feedResourceId: text(rawProfile.feedResourceId, defaults.feedResourceId),
    headsPerFeedUnit: Math.max(1, whole(rawProfile.headsPerFeedUnit, defaults.headsPerFeedUnit)),
    feedUnitsPerHead: Math.max(1, whole(rawProfile.feedUnitsPerHead, defaults.feedUnitsPerHead ?? 1)),
    offspringNumerator: whole(rawProfile.offspringNumerator, defaults.offspringNumerator),
    offspringDenominator: Math.max(1, whole(rawProfile.offspringDenominator, defaults.offspringDenominator)),
    careWorkQdPerDay: Math.max(1, whole(rawProfile.careWorkQdPerDay, defaults.careWorkQdPerDay ?? 1)),
    producesEggs: bool(rawProfile.producesEggs, defaults.producesEggs),
    eggResourceId: text(rawProfile.eggResourceId, defaults.eggResourceId ?? "eggs"),
    eggPerFullFlockDay: whole(rawProfile.eggPerFullFlockDay, defaults.eggPerFullFlockDay ?? 0),
    producesMilk: bool(rawProfile.producesMilk, defaults.producesMilk),
    milkResourceId: text(rawProfile.milkResourceId, defaults.milkResourceId ?? "milk"),
    milkPerHeadDay: whole(rawProfile.milkPerHeadDay, defaults.milkPerHeadDay ?? 0),
    milkPerFullFlockDay: whole(rawProfile.milkPerFullFlockDay, defaults.milkPerFullFlockDay ?? 0),
    milkWorkQdPerHeadDay: Math.max(1, whole(rawProfile.milkWorkQdPerHeadDay, defaults.milkWorkQdPerHeadDay ?? 1)),
    milkBatchWorkQdPerDay: Math.max(1, whole(rawProfile.milkBatchWorkQdPerDay, defaults.milkBatchWorkQdPerDay ?? 1)),
    producesWool: bool(rawProfile.producesWool, defaults.producesWool),
    woolResourceId: text(rawProfile.woolResourceId, defaults.woolResourceId ?? "wool"),
    woolPerHead: whole(rawProfile.woolPerHead, defaults.woolPerHead ?? 0),
    shearWorkQdPerHead: Math.max(1, whole(rawProfile.shearWorkQdPerHead, defaults.shearWorkQdPerHead ?? 1)),
    shearBatchWorkQd: Math.max(1, whole(rawProfile.shearBatchWorkQd, defaults.shearBatchWorkQd ?? 1)),
    meatResourceId: text(rawProfile.meatResourceId, defaults.meatResourceId ?? "meat"),
    meatPerAdult: whole(rawProfile.meatPerAdult, defaults.meatPerAdult ?? 0),
    peltResourceId: text(rawProfile.peltResourceId, defaults.peltResourceId ?? "pelt"),
    peltPerAdult: whole(rawProfile.peltPerAdult, defaults.peltPerAdult ?? 0),
    tallowResourceId: text(rawProfile.tallowResourceId, defaults.tallowResourceId ?? "tallow"),
    tallowPerAdult: whole(rawProfile.tallowPerAdult, defaults.tallowPerAdult ?? 0),
    slaughterWorkQdPerHead: Math.max(1, whole(rawProfile.slaughterWorkQdPerHead, defaults.slaughterWorkQdPerHead ?? 1))
  };
  const rawState = source.state && typeof source.state === "object" ? source.state : source;
  const adults = Math.min(profile.capacity, whole(rawState.adults ?? rawState.qty));
  const breedingMales = Math.min(adults, whole(rawState.breedingMales ?? rawState.breedingMaleCount));
  let availablePlaces = Math.max(0, profile.capacity - adults);
  const young = [];
  for (const [index, cohort] of (Array.isArray(rawState.young ?? rawState.youngCohorts) ? (rawState.young ?? rawState.youngCohorts) : []).entries()) {
    if (!availablePlaces) break;
    const qty = Math.min(availablePlaces, whole(cohort?.qty));
    if (!qty) continue;
    young.push({
      id: text(cohort?.id, `young-${index + 1}`),
      qty,
      ageQd: whole(cohort?.ageQd),
      bornSeasonKey: text(cohort?.bornSeasonKey)
    });
    availablePlaces -= qty;
  }
  const state = {
    version: 1,
    speciesId,
    capacity: profile.capacity,
    adults,
    breedingMales,
    young,
    woolReady: Math.min(adults, whole(rawState.woolReady)),
    lastBirthSeasonKey: text(rawState.lastBirthSeasonKey),
    lastWoolSeasonKey: text(rawState.lastWoolSeasonKey),
    productionRemainders: { eggs: Math.min(9999, whole(rawState.productionRemainders?.eggs)), milk: Math.min(9999, whole(rawState.productionRemainders?.milk)) },
    shortagePeriods: whole(rawState.shortagePeriods),
    shortageQd: whole(rawState.shortageQd, whole(rawState.shortagePeriods) * 40),
    feedCreditNumerator: whole(rawState.feedCreditNumerator)
  };
  const rawOperations = source.operations && typeof source.operations === "object" ? source.operations : {};
  return {
    schemaVersion: LIVESTOCK_SCHEMA_VERSION,
    enabled: bool(source.enabled, true),
    speciesId,
    speciesOptions: [...new Set([speciesId, ...(Array.isArray(source.speciesOptions) ? source.speciesOptions : [])]
      .map((id) => text(id))
      .filter((id) => LIVESTOCK_SPECIES_IDS.includes(id)))],
    outputRoomId: text(source.outputRoomId, "outdoors"),
    profile,
    state,
    operations: {
      milk: bool(rawOperations.milk, profile.producesMilk),
      eggs: bool(rawOperations.eggs, profile.producesEggs),
      shearQty: whole(rawOperations.shearQty),
      slaughterQty: whole(rawOperations.slaughterQty),
      slaughterBreedingMales: whole(rawOperations.slaughterBreedingMales),
      feedPriority: rawOperations.feedPriority === "young" ? "young" : "adults"
    },
    gmPriority: whole(source.gmPriority, 500)
  };
}

export const LIVESTOCK_PROFILES = PROFILE_BY_SPECIES;
