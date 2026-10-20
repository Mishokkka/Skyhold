import { normalizeMarketRouteMap } from "../../data/market/route-map.js";
import { defaultRouteNodePosition, routeEdgeKey, routePointsAttribute, routePolylinePoints } from "../editors/route-graph-model.js";

function separateCoincidentNetworkLines(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!line.network) continue;
    const reverse = routePointsAttribute([...line.coordinates].reverse());
    const key = line.points < reverse ? line.points : reverse;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    group.forEach((line, index) => {
      line.label += ` · путь ${index + 1}/${group.length}`;
      const points = line.coordinates;
      const from = points[0], to = points.at(-1);
      let dx = to.x - from.x, dy = to.y - from.y;
      if (!Math.hypot(dx, dy)) {
        for (let pointIndex = 1; pointIndex < points.length; pointIndex++) {
          dx = points[pointIndex].x - points[pointIndex - 1].x;
          dy = points[pointIndex].y - points[pointIndex - 1].y;
          if (Math.hypot(dx, dy)) break;
        }
        if (!Math.hypot(dx, dy)) return;
      }
      const offset = (index - (group.length - 1) / 2) * 24 * (line.points === key ? 1 : -1);
      const length = Math.hypot(dx, dy);
      const shift = { x: -dy / length * offset, y: dx / length * offset };
      line.coordinates = points.length === 2
        ? [from, { x: (from.x + to.x) / 2 + shift.x, y: (from.y + to.y) / 2 + shift.y }, to]
        : points.map((point, pointIndex) => pointIndex === 0 || pointIndex === points.length - 1
          ? point : { x: point.x + shift.x, y: point.y + shift.y });
      line.points = routePointsAttribute(line.coordinates);
    });
  }
}

/** Read-only geometry shared by route viewers. Public transit points can join visible ship ports. */
export function shipRouteMapContext(plan, mapSource = {}) {
  const map = normalizeMarketRouteMap(mapSource);
  const regions = plan.world.regions;
  const visible = new Set([plan.world.home.regionId, ...plan.world.ports.map((port) => port.regionId), ...(plan.world.mapRegionIds ?? [])]);
  const byId = new Map(regions.map((region) => [region.value, region]));
  const positions = new Map();
  let schematic = false;
  regions.forEach((region, index) => {
    const saved = Number(region.marketMapX) > 0 || Number(region.marketMapY) > 0;
    const position = saved ? { x: Number(region.marketMapX), y: Number(region.marketMapY) }
      : defaultRouteNodePosition(index, regions.length, map);
    positions.set(region.value, { ...position, saved });
  });
  const links = new Map();
  for (const region of regions) {
    for (const link of region.marketLinks ?? []) {
      const key = routeEdgeKey(region.value, link.regionId, link.routeId);
      if (!links.has(key)) links.set(key, { from: region.value, link });
    }
  }
  const lines = [];
  const included = new Set(plan.stops.map((stop) => stop.point.regionId));
  if (plan.overview) for (const { from: id, link } of links.values()) {
    if (!visible.has(id) || !visible.has(link.regionId) || !link.modes.includes("airship")) continue;
    const from = positions.get(id), to = positions.get(link.regionId);
    if (!from || !to) continue;
    const points = routePolylinePoints(from, to, link.pathPoints, map);
    lines.push({ points: routePointsAttribute(points), coordinates: points, network: true, offerIds: "[]",
      label: `${byId.get(id)?.label} → ${byId.get(link.regionId)?.label}` });
    included.add(id); included.add(link.regionId);
  }
  if (plan.overview) separateCoincidentNetworkLines(lines);
  let incomplete = false;
  for (const [index, leg] of plan.legs.entries()) {
    if (!leg.route.path.every((id) => visible.has(id) && positions.has(id))) { incomplete = true; continue; }
    if (!leg.route.edges.length) incomplete = true;
    for (const edge of leg.route.edges) {
      const source = links.get(routeEdgeKey(edge.from, edge.to, edge.routeId));
      const from = positions.get(edge.from), to = positions.get(edge.to);
      if (!source || !from || !to) { incomplete = true; continue; }
      const bends = source.from === edge.from ? source.link.pathPoints : [...(source.link.pathPoints ?? [])].reverse();
      const points = routePolylinePoints(from, to, bends, map);
      if (!from.saved || !to.saved) schematic = true;
      lines.push({ points: routePointsAttribute(points), coordinates: points, legIndex: index,
        offerIds: JSON.stringify(leg.offerIds), label: `${index + 1}. ${leg.from.label} → ${leg.to.label}`, empty: !leg.offerIds.length });
      included.add(edge.from); included.add(edge.to);
    }
  }
  const nodes = [...included].filter((id) => visible.has(id) && positions.has(id)).map((id) => {
    const position = positions.get(id);
    if (!position.saved) schematic = true;
    const stops = plan.stops.map((stop, index) => ({ ...stop, index })).filter((stop) => stop.point.regionId === id);
    return { ...position, id, label: stops[0]?.point.label ?? byId.get(id)?.label,
      stopNumbers: stops.map((stop) => stop.index).join(" / "), isStop: stops.length > 0,
      start: id === plan.origin.regionId, final: !plan.overview && id === plan.finalPoint.regionId };
  });
  const points = [...nodes, ...lines.flatMap((line) => line.coordinates)];
  const minX = Math.min(...points.map((point) => point.x), map.worldWidth);
  const maxX = Math.max(...points.map((point) => point.x), 0);
  const minY = Math.min(...points.map((point) => point.y), map.worldHeight);
  const maxY = Math.max(...points.map((point) => point.y), 0);
  const span = Math.max(maxX - minX, (maxY - minY) * 1.8, 250);
  const fit = { x: (minX + maxX - span * 1.25) / 2, y: (minY + maxY - span * 1.25 / 1.8) / 2,
    width: span * 1.25, height: span * 1.25 / 1.8 };
  return { ...map, lines, nodes, schematic, incomplete, fit, overview: Boolean(plan.overview),
    viewBox: `${fit.x} ${fit.y} ${fit.width} ${fit.height}`,
    markerRadius: fit.width / 70, labelSize: fit.width / 45,
    key: JSON.stringify([map.background, map.worldWidth, map.worldHeight, lines.map((line) => line.points), nodes.map((node) => [node.x, node.y])]) };
}

/** Local viewport only: never saves world settings or installs document-level listeners. */
export function bindRouteMapView(root, model, state, signal) {
  const svg = root?.querySelector?.("[data-route-view]");
  if (!svg) return;
  if (state.key !== model.key) { state.key = model.key; state.box = { ...model.fit }; }
  const apply = () => {
    const box = state.box;
    svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    const { width, height } = svg.getBoundingClientRect();
    if (width > 0 && height > 0) {
      // Keep stop numbers legible in narrow windows and while zooming out.
      const unitsPerPixel = Math.max(box.width / width, box.height / height);
      for (const label of svg.querySelectorAll("text")) label.setAttribute("font-size", String(12 * unitsPerPixel));
      for (const label of svg.querySelectorAll("[data-route-node-label]")) label.setAttribute("dy", String(24 * unitsPerPixel));
      for (const node of svg.querySelectorAll("circle")) node.setAttribute("r", String(8 * unitsPerPixel));
    }
  };
  const zoom = (factor) => {
    const old = state.box;
    const width = Math.max(model.fit.width / 8, Math.min(model.worldWidth * 3, old.width * factor));
    const height = width / 1.8;
    state.box = { x: old.x + (old.width - width) / 2, y: old.y + (old.height - height) / 2, width, height };
    apply();
  };
  const listener = { signal };
  root.addEventListener("click", (event) => {
    const action = event.target.closest?.("[data-route-view-action]")?.dataset.routeViewAction;
    if (!action) return;
    if (action === "fit") state.box = { ...model.fit };
    if (action === "in") zoom(0.8);
    if (action === "out") zoom(1.25);
    if (action === "left") state.box.x -= state.box.width * 0.15;
    if (action === "right") state.box.x += state.box.width * 0.15;
    if (action === "up") state.box.y -= state.box.height * 0.15;
    if (action === "down") state.box.y += state.box.height * 0.15;
    apply();
  }, listener);
  let drag = null;
  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / state.box.width, rect.height / state.box.height);
    if (!(scale > 0)) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, box: { ...state.box }, scale };
    svg.setPointerCapture(event.pointerId);
  }, listener);
  svg.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    state.box = { ...drag.box, x: drag.box.x - (event.clientX - drag.x) / drag.scale, y: drag.box.y - (event.clientY - drag.y) / drag.scale };
    apply();
  }, listener);
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) svg.addEventListener(eventName, () => { drag = null; }, listener);
  const background = svg.querySelector("image");
  const unavailable = root.querySelector("[data-route-background-error]");
  background?.addEventListener("error", () => { background.remove(); if (unavailable) unavailable.hidden = false; }, listener);
  if (typeof globalThis.ResizeObserver === "function") {
    const resize = new ResizeObserver(apply);
    resize.observe(svg);
    signal?.addEventListener("abort", () => resize.disconnect(), { once: true });
  }
  apply();
}
