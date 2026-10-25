import { MAX_MARKET_LINKS_PER_REGION, normalizeEventRegionOptions } from "../../data/random-events.js";
import { normalizeMarketRouteMap } from "../../data/market/route-map.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { routeEdgeKey } from "./route-graph-model.js";

const FORMAT = "fbl-skyhold-trade-network";
const ECONOMY_LISTS = ["baseOffers", "sizeProfiles", "conditions", "specialties", "countries", "organizations"];

export function exportRouteNetwork(catalog = {}) {
  const eventRegions = normalizeEventRegionOptions(catalog.eventRegions, { fallback: false });
  return { format: FORMAT, version: 1, eventRegions,
    marketRouteMap: normalizeMarketRouteMap(catalog.marketRouteMap),
    marketEconomy: normalizeMarketEconomy(catalog.marketEconomy, { locations: eventRegions }) };
}

export function parseRouteNetwork(source) {
  if (source?.format !== FORMAT || source.version !== 1 || !Array.isArray(source.eventRegions)) {
    throw new Error("Неизвестный формат торговой сети.");
  }
  if (!source.marketRouteMap || typeof source.marketRouteMap !== "object" || Array.isArray(source.marketRouteMap)) {
    throw new Error("В файле отсутствуют настройки карты.");
  }
  if (!source.marketEconomy || typeof source.marketEconomy !== "object" || Array.isArray(source.marketEconomy)) {
    throw new Error("Отсутствует справочник экономики рынков.");
  }
  const ids = new Set();
  const routes = new Set();
  for (const row of source.eventRegions) {
    if (!row || typeof row.value !== "string" || !row.value.trim() || row.value !== row.value.trim() || ids.has(row.value)) {
      throw new Error("Пустой или повторяющийся ID рынка.");
    }
    ids.add(row.value);
    if (!Array.isArray(row.marketLinks) || row.marketLinks.length > MAX_MARKET_LINKS_PER_REGION) {
      throw new Error("Некорректные связи или превышен лимит 300 связей рынка.");
    }
    for (const link of row.marketLinks) {
      if (!link || typeof link.regionId !== "string" || link.regionId === row.value) throw new Error("Некорректный адрес связи.");
      if ((link.pathPoints?.length ?? 0) > 100 || String(link.routeId ?? "").length > 128) throw new Error("Превышен лимит геометрии или ID маршрута.");
      const key = routeEdgeKey(row.value, link.regionId, link.routeId);
      // Symmetric legacy records are allowed; duplicate directed records are not.
      const directedKey = row.value + "::" + key;
      if (routes.has(directedKey)) throw new Error("Повторяющийся ID маршрута.");
      routes.add(directedKey);
    }
  }
  for (const row of source.eventRegions) {
    for (const link of row.marketLinks) if (!ids.has(link.regionId)) throw new Error("Связь ссылается на отсутствующий рынок.");
  }
  const result = exportRouteNetwork(source);
  for (const key of ECONOMY_LISTS) {
    if (!Array.isArray(source.marketEconomy[key]) || result.marketEconomy[key].length !== source.marketEconomy[key].length) {
      throw new Error("Некорректный справочник или превышен лимит: " + key);
    }
  }
  return result;
}

export function mergeRouteNetwork(catalog, source) {
  const network = parseRouteNetwork(source);
  const existing = normalizeEventRegionOptions(catalog.eventRegions, { fallback: false });
  const importedEdges = new Set(network.eventRegions.flatMap((row) => row.marketLinks.map((link) => routeEdgeKey(row.value, link.regionId, link.routeId))));
  const byId = new Map(existing.map((row) => [row.value, { ...row,
    marketLinks: row.marketLinks.filter((link) => !importedEdges.has(routeEdgeKey(row.value, link.regionId, link.routeId))) }]));
  for (const row of network.eventRegions) {
    const links = [...(byId.get(row.value)?.marketLinks ?? []), ...row.marketLinks];
    if (links.length > MAX_MARKET_LINKS_PER_REGION) throw new Error("Объединение превышает лимит 300 связей рынка. Данные не изменены.");
    byId.set(row.value, { ...byId.get(row.value), ...row, marketLinks: links });
  }
  const eventRegions = [...byId.values()];
  const economy = normalizeMarketEconomy(catalog.marketEconomy, { locations: existing });
  for (const key of ECONOMY_LISTS) {
    const rows = new Map(economy[key].map((row) => [row.id, row]));
    for (const row of network.marketEconomy[key]) rows.set(row.id, row);
    economy[key] = [...rows.values()];
  }
  economy.settings = network.marketEconomy.settings;
  const marketEconomy = normalizeMarketEconomy(economy, { locations: eventRegions });
  for (const key of ECONOMY_LISTS) {
    if (marketEconomy[key].length !== economy[key].length) throw new Error("Объединение превышает лимит справочника рынков: " + key);
  }
  return { eventRegions, marketRouteMap: network.marketRouteMap, marketEconomy };
}
