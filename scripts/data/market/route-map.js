import { toNumber } from "../utils.js";

export const DEFAULT_MARKET_ROUTE_MAP = Object.freeze({
  background: "",
  backgroundOpacity: 0.8,
  worldWidth: 1000,
  worldHeight: 600,
  centerX: 500,
  centerY: 300,
  zoom: 1,
  nodeMode: "card",
  kmPerPixel: 0,
  calibration: null
});

function bounded(value, fallback, min, max) {
  return Math.min(max, Math.max(min, toNumber(value, fallback)));
}

function normalizePoint(value = null, worldWidth = 1000, worldHeight = 600) {
  if (!value || typeof value !== "object") return null;
  const x = bounded(value.x, 0, 0, worldWidth);
  const y = bounded(value.y, 0, 0, worldHeight);
  return { x, y };
}

export function marketRoutePolylineLength(points = []) {
  const rows = Array.isArray(points) ? points : [];
  let length = 0;
  for (let index = 1; index < rows.length; index += 1) {
    length += Math.hypot(Number(rows[index]?.x) - Number(rows[index - 1]?.x), Number(rows[index]?.y) - Number(rows[index - 1]?.y));
  }
  return Number.isFinite(length) ? length : 0;
}

export function marketRouteDistanceKm(points = [], mapSource = {}) {
  const map = normalizeMarketRouteMap(mapSource);
  const length = marketRoutePolylineLength(points);
  return map.kmPerPixel > 0 && length > 0 ? Math.max(1, Math.round(length * map.kmPerPixel)) : 0;
}

export function normalizeMarketRouteMap(source = {}) {
  const row = source && typeof source === "object" ? source : {};
  const worldWidth = Math.round(bounded(row.worldWidth, DEFAULT_MARKET_ROUTE_MAP.worldWidth, 600, 12000));
  const worldHeight = Math.round(bounded(row.worldHeight, DEFAULT_MARKET_ROUTE_MAP.worldHeight, 400, 8000));
  const pointA = normalizePoint(row.calibration?.pointA ?? row.calibration?.a, worldWidth, worldHeight);
  const pointB = normalizePoint(row.calibration?.pointB ?? row.calibration?.b, worldWidth, worldHeight);
  const calibrationDistanceKm = bounded(row.calibration?.distanceKm, 0, 0, 1_000_000);
  const kmPerPixel = bounded(row.kmPerPixel ?? row.scaleKmPerPixel, 0, 0, 10000);
  return {
    background: String(row.background ?? row.backgroundImage ?? "").trim().slice(0, 1000),
    backgroundOpacity: bounded(row.backgroundOpacity, DEFAULT_MARKET_ROUTE_MAP.backgroundOpacity, 0.1, 1),
    worldWidth,
    worldHeight,
    centerX: bounded(row.centerX, worldWidth / 2, 0, worldWidth),
    centerY: bounded(row.centerY, worldHeight / 2, 0, worldHeight),
    zoom: bounded(row.zoom, DEFAULT_MARKET_ROUTE_MAP.zoom, 0.1, 4),
    nodeMode: String(row.nodeMode ?? "") === "compact" ? "compact" : "card",
    kmPerPixel,
    calibration: pointA && pointB && calibrationDistanceKm > 0 ? { pointA, pointB, distanceKm: calibrationDistanceKm } : null,
    contentVersion: Math.max(1, Math.floor(toNumber(row.contentVersion ?? row.version, 1))),
    contentSource: String(row.contentSource ?? row.source ?? "").trim().slice(0, 300)
  };
}
