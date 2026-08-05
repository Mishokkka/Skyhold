import { MODULE_ID, SETTING_ROUTE_GRAPH_VIEW } from "../../data/constants.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function normalizeRouteGraphViewport(view = {}, map = {}) {
  const worldWidth = Math.max(1, Number(map.worldWidth) || 1000);
  const worldHeight = Math.max(1, Number(map.worldHeight) || 600);
  return {
    centerX: clamp(view.centerX ?? map.centerX ?? worldWidth / 2, 0, worldWidth),
    centerY: clamp(view.centerY ?? map.centerY ?? worldHeight / 2, 0, worldHeight),
    zoom: clamp(view.zoom ?? map.zoom ?? 1, 0.1, 4)
  };
}

export function routeGraphViewportsEqual(left, right) {
  return Boolean(left && right)
    && left.centerX === right.centerX
    && left.centerY === right.centerY
    && left.zoom === right.zoom;
}

export function readRouteGraphViewport(map = {}, settings = globalThis.game?.settings) {
  let stored = {};
  try {
    stored = settings?.get?.(MODULE_ID, SETTING_ROUTE_GRAPH_VIEW) ?? {};
  } catch (_error) {
    // Settings can be unavailable in isolated previews and early app setup.
  }
  return normalizeRouteGraphViewport(stored, map);
}

export async function writeRouteGraphViewport(view, map = {}, settings = globalThis.game?.settings) {
  if (typeof settings?.set !== "function") return false;
  const normalized = normalizeRouteGraphViewport(view, map);
  await settings.set(MODULE_ID, SETTING_ROUTE_GRAPH_VIEW, normalized);
  return true;
}
