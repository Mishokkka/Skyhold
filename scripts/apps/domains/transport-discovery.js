import { marketRegionAccessCostMap } from "../../engines/market/logistics.js";

const MAX_OWN_POINTS = 24;

// Resolve only known endpoint IDs; region and ship IDs may themselves contain ":".
function requestedPoints(request, services, points) {
  const result = new Set(Object.keys(request.pins ?? {}).filter(id => points.has(id)));
  if (points.has(request.transferPortId)) result.add(request.transferPortId);
  const ids = new Set([...Object.values(request.pins ?? {}), ...(request.serviceIds ?? [])]);
  const byId = new Map(services.map(service => [service.id, service]));
  for (const id of ids) {
    const service = byId.get(id);
    if (service) {
      for (const point of [service.from, service.to]) if (points.has(point)) result.add(point);
      continue;
    }
    const prefix = `owned:${request.ownShipId}:`;
    if (typeof id !== "string" || !id.startsWith(prefix)) continue;
    for (const from of points) {
      const start = `${prefix}${from}:`;
      if (!id.startsWith(start)) continue;
      const tail = id.slice(start.length);
      for (const to of points) {
        const suffix = tail.slice(to.length);
        if (tail !== to && !(tail.startsWith(to) && /^:(?:access:\d+|route:[a-z0-9]+)$/.test(suffix))) continue;
        result.add(from);
        result.add(to);
      }
    }
  }
  return result;
}

export function discoverTransportPorts({ world, holding, marketRegionId, endpoint, accessLimit, request, services }) {
  // Ignoring modes gives a lower bound, not permission to travel. The complete
  // chain still checks carriers, flight paths, cargo difficulty and total URS.
  const regions = world.regions;
  const fromHome = marketRegionAccessCostMap({ holding, regions });
  const fromMarket = marketRegionAccessCostMap({
    holding: { overview: { region: marketRegionId } }, regions
  });
  const ports = world.ports.filter(port => (fromHome.get(port.regionId) ?? Infinity)
    + (fromMarket.get(port.regionId) ?? Infinity) <= accessLimit)
    .sort((a, b) => (fromHome.get(a.regionId) + fromMarket.get(a.regionId))
      - (fromHome.get(b.regionId) + fromMarket.get(b.regionId)) || a.regionId.localeCompare(b.regionId));
  const primary = [endpoint, marketRegionId];
  const candidates = new Set([...primary, ...ports.map(port => port.regionId)]);
  const forced = requestedPoints(request, services, candidates);
  const points = [...new Set([...primary, ...forced])];
  if (points.length > MAX_OWN_POINTS) throw new Error("Закреплено слишком много портов. Снимите часть закреплений участков.");
  for (const port of ports) {
    if (points.length >= MAX_OWN_POINTS) break;
    if (!points.includes(port.regionId)) points.push(port.regionId);
  }
  const selected = new Set(points);
  return {
    points, ports, requiredPoints: [...forced], transfers: ports.filter(port => selected.has(port.regionId)),
    limited: candidates.size > points.length,
    requestedUnavailable: Boolean(request.transferPortId && !ports.some(port => port.regionId === request.transferPortId))
  };
}
