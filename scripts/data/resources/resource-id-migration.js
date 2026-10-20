import { RESOURCE_BASE_DEFINITIONS } from "./resource-base-definitions.js";

const CANONICAL_RESOURCE_IDS = new Set(RESOURCE_BASE_DEFINITIONS.map((row) => row.id));

export const LEGACY_LIVESTOCK_RESOURCE_IDS = Object.freeze({
  cattle: "cattle",
  pigs: "pigs",
  sheep: "sheep",
  goats: "goats",
  horses: "horses",
  chickens: "poultry",
  geese: "poultry",
  rabbits: "rabbits",
  pigeons: "pigeons"
});

// One explicit owner for the destructive economy-v1 cutover. Several old
// market commodities intentionally collapse into one manager-facing stock.
export const LEGACY_RESOURCE_ID_MAP = Object.freeze({
  "black-coal": "fuel-solid",
  charcoal: "fuel-solid",
  coke: "fuel-solid",
  coal: "fuel-solid",
  peat: "fuel-solid",
  firewood: "wood",

  "cloth-silk": "silk",
  "cloth-wool": "cloth",
  flax: "plant-fiber",
  hemp: "plant-fiber",
  cotton: "plant-fiber",
  "linen-cloth": "cloth",
  "cotton-cloth": "cloth",
  felt: "cloth",
  canvas: "cloth",
  sailcloth: "cloth",
  hides: "pelt",

  "food-meat": "food-protein",
  "prepared-food": "food-grain",
  barley: "grain",
  oats: "grain",
  rye: "grain",
  rice: "grain",
  maize: "grain",
  potatoes: "vegetables",
  peas: "vegetables",
  beans: "vegetables",
  poultry: "meat",
  pork: "meat",
  butter: "food-dairy",
  cheese: "aged-cheese",
  "salted-fish": "preserved-meat",
  "canned-food": "preserved-meat",
  "olive-oil": "cooking-oil",

  beer: "alcohol-brewed-cheap-weak",
  wine: "alcohol-wine-fine-weak",
  spirits: "alcohol-general-cheap-strong",

  hardwood: "wood",
  planks: "wood",
  beams: "wood",
  ironwood: "rare-wood",
  limestone: "stone",
  slate: "stone",
  sand: "stone",
  gravel: "stone",
  clay: "bricks",
  lime: "bricks",
  cement: "bricks",
  nails: "components-simple",
  pitch: "chemicals-simple",
  tar: "chemicals-simple",
  glue: "chemicals-simple",
  resin: "chemicals-simple",

  "lamp-oil": "fuel-liquid",
  "whale-oil": "fuel-liquid",
  kerosene: "fuel-liquid",
  "fish-oil": "fuel-liquid",

  "pig-iron": "iron",
  "wrought-iron": "iron",
  tin: "nonferrous-metals",
  lead: "nonferrous-metals",
  zinc: "nonferrous-metals",
  mercury: "chemicals-complex",
  brass: "light-alloys",
  bronze: "light-alloys",

  saltpeter: "explosives",
  sulfur: "explosives",
  gunpowder: "explosives",
  cartridges: "military-supplies-complex",
  "copper-wire": "components-high-tech",
  "telegraph-components": "components-high-tech",
  "electrical-parts": "components-high-tech",
  tools: "tools-simple",
  "machine-parts": "components-complex",
  glassware: "tools-complex",

  "sulfuric-acid": "chemicals-complex",
  "soda-ash": "chemicals-simple",
  alum: "chemicals-simple",
  turpentine: "chemicals-simple",
  indigo: "chemicals-simple",
  madder: "chemicals-simple",
  "art-pigments": "art-goods",
  soap: "household-goods-simple",
  candles: "household-goods-simple",
  ceramics: "household-goods-simple",
  paper: "parchment",
  ink: "parchment",
  beeswax: "tallow",

  bandages: "medical-supplies",
  "medicinal-alcohol": "medical-supplies",
  disinfectant: "medical-supplies",
  "quinine-bark": "medicines",
  opium: "medicines",

  "inert-crystal": "crystal-inert",
  "lift-crystal": "crystal-active",
  "aether-crystal": "crystal-active",
  "crystal-core-small": "crystal-core",
  "crystal-core-medium": "crystal-core",
  "crystal-core-large": "crystal-core",

  feathers: "household-goods-simple"
});

export function canonicalResourceId(value, { allowLivestock = false } = {}) {
  const id = String(value ?? "").trim();
  if (!id) return "";
  if (CANONICAL_RESOURCE_IDS.has(id)) return id;
  const mapped = LEGACY_RESOURCE_ID_MAP[id];
  if (mapped) return mapped;
  if (allowLivestock && LEGACY_LIVESTOCK_RESOURCE_IDS[id]) return "";
  return id;
}

export function resourceMigrationTarget(value) {
  const id = String(value ?? "").trim();
  if (!id) return { kind: "unknown", sourceId: "", targetId: "" };
  if (CANONICAL_RESOURCE_IDS.has(id)) return { kind: "resource", sourceId: id, targetId: id };
  if (LEGACY_RESOURCE_ID_MAP[id]) return { kind: "resource", sourceId: id, targetId: LEGACY_RESOURCE_ID_MAP[id] };
  if (LEGACY_LIVESTOCK_RESOURCE_IDS[id]) {
    return { kind: "livestock", sourceId: id, speciesId: LEGACY_LIVESTOCK_RESOURCE_IDS[id], targetId: "" };
  }
  return { kind: "unknown", sourceId: id, targetId: "" };
}

export function isCanonicalResourceId(value) {
  return CANONICAL_RESOURCE_IDS.has(String(value ?? "").trim());
}
