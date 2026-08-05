import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../building-templates.js";
import { DEFAULT_EVENT_REGION_OPTIONS } from "../random-events.js";
import { LAPUTA_IMPORT } from "../presets/laputa.js";
import { RESTORATION_SETTLEMENT_PRESET } from "../presets/restoration-settlement.js";
import { SKYHOLD_SCHEMA_VERSION } from "../schema-version.js";
import { DEFAULT_MARKET_ROUTE_MAP } from "../market/route-map.js";
import { createDefaultMarketEconomy } from "../market/economy.js";
import { RESOURCE_ECONOMY_VERSION } from "../resources/resource-economy-contract.js";
import { ECONOMY_V2_ACTIVATION_VERSION } from "../economy-v2-constants.js";
import { clone } from "../utils.js";

export const DEFAULT_SKYHOLD_DATA = {
  meta: {
    schemaVersion: SKYHOLD_SCHEMA_VERSION,
    economyVersion: RESOURCE_ECONOMY_VERSION,
    economyActivation: {
      version: ECONOMY_V2_ACTIVATION_VERSION,
      operationId: "default-economy-v2",
      fromVersion: RESOURCE_ECONOMY_VERSION,
      toVersion: RESOURCE_ECONOMY_VERSION,
      activatedAt: null,
      sourceHash: "",
      targetHash: "",
      activatedRevision: 0
    },
    templateCatalogVersion: TEMPLATE_CATALOG_VERSION,
    lastUpdated: null,
    revision: 0,
    storageCommit: null
  },
  holdings: [
    clone(LAPUTA_IMPORT.holding),
    clone(RESTORATION_SETTLEMENT_PRESET)
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
