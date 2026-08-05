import { RESOURCE_BASE_DEFINITIONS } from "./resource-base-definitions.js";
import { normalizeResourceEconomy } from "./resource-economy-contract.js";
import { RESOURCE_PRESENTATION } from "./resource-presentation.js";

// Canonical Economy V2 reference prices. Existing explicit market offers may
// still apply regional prices; these values are the single resource-level
// reference used by production, valuation and generated offers.
export const BUILTIN_RESOURCE_REFERENCE_PRICES = Object.freeze({
  money: 0,
  cattle: 1200,
  pigs: 480,
  sheep: 200,
  goats: 160,
  horses: 2500,
  chickens: 8,
  geese: 20,
  rabbits: 12,
  pigeons: 6,
  "black-coal": 5,
  bread: 6,
  charcoal: 2,
  "cloth-silk": 100,
  "cloth-wool": 18,
  coke: 4,
  copper: 20,
  eggs: 6,
  feathers: 8,
  flour: 6,
  fruits: 4,
  glass: 80,
  gold: 1000,
  grain: 4,
  herbs: 20,
  honey: 40,
  iron: 10,
  "iron-ore": 4,
  leather: 12,
  meat: 6,
  milk: 3,
  "prepared-food": 0,
  parchment: 10,
  pelt: 8,
  silver: 100,
  stone: 2,
  straw: 2,
  tallow: 6,
  vegetables: 4,
  wood: 3,
  wool: 4,
  water: 2
});

export const BUILTIN_RESOURCE_SHELF_LIFE_TENDAYS = Object.freeze({
  bread: 1,
  eggs: 1,
  flour: 18,
  fruits: 1,
  grain: 36,
  meat: 1,
  milk: 1,
  "prepared-food": 1,
  vegetables: 1
});

export const BUILTIN_RESOURCE_DEFS = RESOURCE_BASE_DEFINITIONS.map((definition) => {
  const presentation = RESOURCE_PRESENTATION[definition.id] ?? {};
  const referencePriceCopper = BUILTIN_RESOURCE_REFERENCE_PRICES[definition.id] ?? 0;
  const source = {
    ...definition,
    ...presentation,
    economyVersion: 2,
    quantityStep: 1,
    referencePriceCopper,
    shelfLifeTendays: BUILTIN_RESOURCE_SHELF_LIFE_TENDAYS[definition.id] ?? 0,
    tradable: definition.id !== "money" && definition.id !== "prepared-food",
    ...(definition.id === "prepared-food" ? { tradeDisabledReason: "Legacy-запас готовой пищи не создаёт отдельный рыночный товар." } : {})
  };
  return {
    ...source,
    ...normalizeResourceEconomy(source, { isMoney: definition.id === "money" || definition.isMoney === true }),
    aliases: [...(presentation.aliases ?? [])]
  };
});

// Compatibility name retained for consumers of the former core/resources.js data export.
export const RESOURCE_DEFS = BUILTIN_RESOURCE_DEFS;
