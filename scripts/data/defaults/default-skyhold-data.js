import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../building-templates.js";
import { DEFAULT_EVENT_REGION_OPTIONS } from "../random-events.js";
import { LAPUTA_IMPORT } from "../presets/laputa.js";
import { MAGNIFIC_PRESET } from "../presets/magnific.js";
import { RESTORATION_SETTLEMENT_PRESET } from "../presets/restoration-settlement.js";
import { SKYHOLD_SCHEMA_VERSION } from "../schema-version.js";
import { DEFAULT_MARKET_ROUTE_MAP } from "../market/route-map.js";
import { createDefaultMarketEconomy } from "../market/economy.js";
import { clone } from "../utils.js";

export const DEFAULT_SKYHOLD_DATA = {
  meta: {
    schemaVersion: SKYHOLD_SCHEMA_VERSION,
    templateCatalogVersion: TEMPLATE_CATALOG_VERSION,
    buildingCatalogMigration: null,
    lastUpdated: null,
    revision: 0,
    storageCommit: null
  },
  holdings: [
    clone(LAPUTA_IMPORT.holding),
    clone(RESTORATION_SETTLEMENT_PRESET),
    clone(MAGNIFIC_PRESET)
  ],
  catalog: {
    buildings: DEFAULT_BUILDING_TEMPLATES,
    deletedBuildingTemplateIds: [],
    resources: [],
    markets: [],
    marketEconomy: createDefaultMarketEconomy(DEFAULT_EVENT_REGION_OPTIONS),
    marketRouteMap: DEFAULT_MARKET_ROUTE_MAP,
    eventRegions: DEFAULT_EVENT_REGION_OPTIONS,
    combatDoctrines: []
  }
};
