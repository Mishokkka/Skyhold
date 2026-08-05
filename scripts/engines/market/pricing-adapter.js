import {
  cargoPointsFromLegacy,
  legacyLoadFromCargoPoints,
  resourceTradeReady
} from "../../data/resources/resource-economy-contract.js";
import { normalizeMarketLiquidityQuote } from "./liquidity.js";
import {
  planMarketPurchase as planMarketPurchaseEngine,
  prepareMarketQuote as prepareMarketQuoteEngine,
  splitMarketShipmentLines as splitMarketShipmentLinesEngine
} from "./pricing.js";

export * from "./pricing.js";

export const MARKET_PRICING_DEPENDENCIES = Object.freeze({
  cargoPointsFromLegacy,
  legacyLoadFromCargoPoints,
  normalizeMarketLiquidityQuote,
  resourceTradeReady
});

export function prepareMarketQuote(options = {}) {
  return prepareMarketQuoteEngine(options, MARKET_PRICING_DEPENDENCIES);
}

export function planMarketPurchase(options = {}) {
  return planMarketPurchaseEngine(options, MARKET_PRICING_DEPENDENCIES);
}

export function splitMarketShipmentLines(lines = [], capacityValue = 0) {
  return splitMarketShipmentLinesEngine(lines, capacityValue, MARKET_PRICING_DEPENDENCIES);
}
