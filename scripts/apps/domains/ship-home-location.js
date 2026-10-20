import { normalizeEventRegionOptions, normalizeEventRegionOption } from "../../data/random-events.js";
import { normalizeMarketRouteMap, marketRoutePolylineLength } from "../../data/market/route-map.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { routeEdgeKey, routePolylinePoints, upsertRouteEdge } from "../editors/route-graph-model.js";
import { buildShipWorldContext, configureWorldShipEconomy } from "../../engines/ships/world-market.js";

const sourceKey = (holding) => `fbl-skyhold:ship-home:${holding.id}`;

export function shipHomePlacementBlocker(holding) {
  if ((holding.special?.ships?.list ?? []).some((ship) => ship.activeVoyage || ship.orderBundle
    || ship.status !== "docked" || (ship.navigationMode === "world" && ship.location?.kind !== "home"))) {
    return "Верните все корабли домой и завершите их рейсы перед переносом домашней точки.";
  }
  const market = holding.special?.market ?? {};
  if ([...(market.orders ?? []), ...(market.outbound?.orders ?? [])].some((order) => !["delivered", "lost", "cancelled"].includes(order.status))) {
    return "Сначала завершите входящие доставки и продажи во Внешней торговле.";
  }
  return "";
}

/** Uses the existing location/link schema; never places or moves anything on read. */
export function shipHomeLocationContext(data, holding) {
  const world = buildShipWorldContext(data, holding, { offerLocationIds: [] });
  const ports = new Set(world.ports.map((port) => port.regionId));
  const current = world.regions.find((region) => region.value === world.home.regionId);
  const seen = new Set(), routes = [];
  for (const from of world.regions) for (const link of from.marketLinks ?? []) {
    const to = world.regions.find((region) => region.value === link.regionId);
    const key = routeEdgeKey(from.value, link.regionId, link.routeId);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!to || !ports.has(from.value) || !ports.has(to.value) || !link.modes.includes("airship")) continue;
    // A schematic circle cannot establish a geographical position on an imported map.
    if (!(from.marketMapX || from.marketMapY) || !(to.marketMapX || to.marketMapY)) continue;
    routes.push({ key, from, to, link, label: `${from.label} → ${to.label} · ${link.distanceKm} км${link.routeId ? ` · ${link.routeId}` : ""}` });
  }
  const blocker = shipHomePlacementBlocker(holding);
  return { routes, blocker, canPlace: !blocker && routes.length > 0,
    dedicated: current?.contentSource === sourceKey(holding),
    locationLabel: current?.label ?? "Не задана", x: current?.marketMapX, y: current?.marketMapY };
}

export function previewShipHomePlacement(data, holding, routeKey, percent) {
  const context = shipHomeLocationContext(data, holding);
  if (context.blocker) throw new Error(context.blocker);
  const route = context.routes.find((row) => row.key === routeKey);
  if (!route) throw new Error("Выберите существующую воздушную связь между размещёнными на карте портами.");
  const fraction = Number(percent) / 100;
  if (!Number.isFinite(fraction) || fraction < 0.01 || fraction > 0.99) throw new Error("Положение на связи должно быть от 1 до 99 процентов.");
  const map = normalizeMarketRouteMap(data.catalog?.marketRouteMap);
  const points = routePolylinePoints({ x: route.from.marketMapX, y: route.from.marketMapY },
    { x: route.to.marketMapX, y: route.to.marketMapY }, route.link.pathPoints, map);
  const total = marketRoutePolylineLength(points);
  if (!total) throw new Error("Концы связи совпадают. Исправьте геометрию в карте маршрутов.");
  const target = total * fraction;
  let passed = 0, position, splitIndex;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length && passed + length >= target) {
      const t = (target - passed) / length;
      position = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      splitIndex = index;
      break;
    }
    passed += length;
  }
  if (!position) throw new Error("Не удалось определить точку на связи.");
  if (position.x === 0 && position.y === 0) throw new Error("Точка 0,0 обозначает неразмещённую локацию. Немного сдвиньте положение вдоль связи.");
  const fromKm = Math.max(1, Math.ceil(route.link.distanceKm * fraction));
  const toKm = Math.max(1, Math.ceil(route.link.distanceKm * (1 - fraction)));
  return { route, position, fromKm, toKm, percent: fraction * 100,
    fromBends: points.slice(1, splitIndex).reverse(), toBends: points.slice(splitIndex, -1) };
}

/** Call only inside an explicit GM transaction after a reviewed placement. */
export function applyShipHomePlacement(data, holding, routeKey, percent) {
  const preview = previewShipHomePlacement(data, holding, routeKey, percent);
  const regions = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
  const owned = regions.filter((row) => row.contentSource === sourceKey(holding));
  if (owned.length > 1) throw new Error("Найдены несколько домашних точек. Устраните дубли в редакторе локаций.");
  const id = owned[0]?.value ?? `ship-home-${stableDataHash(holding.id)}`;
  if (!owned.length && regions.some((row) => row.value === id)) throw new Error("Идентификатор домашней точки уже занят другой локацией.");
  if ((data.holdings ?? []).some((row) => row.id !== holding.id && row.overview?.region === id)) {
    throw new Error("Этой домашней точкой пользуется другое владение. Сначала разделите их локации.");
  }
  const home = normalizeEventRegionOption({ ...owned[0], value: id, label: holding.name,
    countryId: owned[0]?.countryId ?? regions.find((row) => [row.value, row.label, ...row.aliases].includes(holding.overview.region))?.countryId ?? preview.route.from.countryId,
    marketEnabled: false, marketAirshipOnly: true,
    marketTransportModes: ["airship"], marketMapX: preview.position.x, marketMapY: preview.position.y,
    marketLinks: [], contentSource: sourceKey(holding) });
  const next = regions.filter((row) => row.value !== id);
  // Only this explicitly moved node's incident links are replaced; the selected trade link survives intact.
  for (const row of next) row.marketLinks = row.marketLinks.filter((link) => link.regionId !== id);
  next.push(home);
  for (const [endpoint, distanceKm, pathPoints] of [[preview.route.from, preview.fromKm, preview.fromBends], [preview.route.to, preview.toKm, preview.toBends]]) {
    if (!upsertRouteEdge(next, id, endpoint.value, { ...preview.route.link, routeId: "", distanceKm,
      distanceMode: "manual", pathPoints, modes: ["airship"] })) throw new Error("Не удалось подключить домашнюю точку к маршруту.");
  }
  data.catalog.eventRegions = next;
  holding.overview.region = id;
  const ships = holding.special?.ships;
  for (const ship of ships?.list ?? []) if (ship.navigationMode === "world") {
    ship.location = { kind: "home", id: holding.id, regionId: id, label: holding.name };
    ship.timelineQd = Math.max(Number(ship.timelineQd ?? 0), Number(holding.gm?.calendaria?.lastQd ?? 0));
    configureWorldShipEconomy(data, holding, ship);
  }
  // Quotes from the old departure point are invalid. Accepted contracts/history are never rewritten.
  if (ships) {
    ships.offers = (ships.offers ?? []).filter((offer) => offer.consumedBy || offer.mode !== "world");
    ships.worldOfferLocks = {};
  }
  return preview;
}
