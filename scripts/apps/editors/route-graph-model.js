import { LEGACY_MARKET_ROUTE_UNIT_KM } from "../../data/random-events.js";
import { marketRouteDistanceKm, marketRoutePolylineLength, normalizeMarketRouteMap } from "../../data/market/route-map.js";

const MODES = new Set(["caravan", "rail", "airship"]);

export function clampRouteValue(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function routeEdgeKey(from = "", to = "") {
  return [String(from), String(to)].sort().join("::");
}

export function normalizeRoutePathPoints(points = [], map = {}) {
  return (Array.isArray(points) ? points : []).slice(0, 100).map((point) => ({
    x: clampRouteValue(point?.x, 0, Number(map.worldWidth) || 1000),
    y: clampRouteValue(point?.y, 0, Number(map.worldHeight) || 600)
  }));
}

export function routePolylinePoints(from, to, pathPoints = [], map = {}) {
  return [{ x: from.x, y: from.y }, ...normalizeRoutePathPoints(pathPoints, map), { x: to.x, y: to.y }];
}

export function routePointsAttribute(points = []) {
  return points.map((point) => `${Math.round(point.x * 100) / 100},${Math.round(point.y * 100) / 100}`).join(" ");
}

export function routePolylineMidpoint(points = []) {
  const total = marketRoutePolylineLength(points);
  if (points.length < 2 || total <= 0) return points[0] ?? { x: 0, y: 0 };
  const target = total / 2;
  let passed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (passed + length >= target) {
      const ratio = length > 0 ? (target - passed) / length : 0;
      return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
    }
    passed += length;
  }
  return points.at(-1);
}

export function defaultRouteNodePosition(index = 0, count = 1, map = {}) {
  const width = Number(map.worldWidth) || 1000;
  const height = Number(map.worldHeight) || 600;
  const angle = ((Math.PI * 2) / Math.max(1, count)) * index - Math.PI / 2;
  const radiusX = Math.min(width * 0.38, 145 + count * 13);
  const radiusY = Math.min(height * 0.38, 95 + count * 8);
  return {
    x: Math.round(width / 2 + Math.cos(angle) * radiusX),
    y: Math.round(height / 2 + Math.sin(angle) * radiusY)
  };
}

export function removeRouteEdge(regions, fromId, toId) {
  for (const region of regions) {
    if (region.value !== fromId && region.value !== toId) continue;
    const other = region.value === fromId ? toId : fromId;
    region.marketLinks = (region.marketLinks ?? []).filter((link) => String(link.regionId) !== String(other));
  }
}

export function upsertRouteEdge(regions, fromId, toId, patch = {}) {
  const source = regions.find((row) => row.value === fromId);
  const target = regions.find((row) => row.value === toId);
  if (!source || !target || source === target) return false;
  let previous = null;
  for (const region of [source, target]) {
    const otherId = region === source ? toId : fromId;
    previous ??= (region.marketLinks ?? []).find((link) => String(link.regionId) === String(otherId)) ?? null;
  }
  removeRouteEdge(regions, fromId, toId);
  const modes = Array.isArray(patch.modes) ? patch.modes.filter((mode) => MODES.has(mode)) : (previous?.modes ?? ["caravan", "airship"]);
  source.marketLinks ??= [];
  source.marketLinks.push({
    regionId: toId,
    ursCost: Math.min(99, Math.max(1, Math.floor(Number(patch.ursCost ?? previous?.ursCost ?? 1) || 1))),
    distanceKm: Math.max(1, Number(patch.distanceKm ?? previous?.distanceKm ?? LEGACY_MARKET_ROUTE_UNIT_KM) || LEGACY_MARKET_ROUTE_UNIT_KM),
    distanceMode: String(patch.distanceMode ?? previous?.distanceMode ?? "") === "scaled" ? "scaled" : "manual",
    pathPoints: normalizeRoutePathPoints(patch.pathPoints ?? previous?.pathPoints ?? [], { worldWidth: 12000, worldHeight: 8000 }),
    modes: modes.length ? modes : ["caravan"],
    seasonalModifiers: patch.seasonalModifiers && typeof patch.seasonalModifiers === "object"
      ? patch.seasonalModifiers
      : (previous?.seasonalModifiers ?? {})
  });
  return true;
}

export function recalculateScaledRouteDistances(regions = [], mapSource = {}) {
  const map = normalizeMarketRouteMap(mapSource);
  if (!(map.kmPerPixel > 0)) return;
  const positions = new Map(regions.map((region, index) => {
    const fallback = defaultRouteNodePosition(index, regions.length, map);
    const hasSaved = Number(region.marketMapX) > 0 || Number(region.marketMapY) > 0;
    return [region.value, {
      x: clampRouteValue(hasSaved ? region.marketMapX : fallback.x, 0, map.worldWidth),
      y: clampRouteValue(hasSaved ? region.marketMapY : fallback.y, 0, map.worldHeight)
    }];
  }));
  for (const region of regions) {
    for (const link of region.marketLinks ?? []) {
      if (String(link.distanceMode ?? "") !== "scaled") continue;
      const from = positions.get(region.value);
      const to = positions.get(String(link.regionId ?? ""));
      if (!from || !to) continue;
      const distance = marketRouteDistanceKm(routePolylinePoints(from, to, link.pathPoints, map), map);
      if (distance > 0) link.distanceKm = Math.min(100000, distance);
    }
  }
}
