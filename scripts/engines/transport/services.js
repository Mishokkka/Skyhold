import { stableDataHash } from "../../data/storage-commit.js";
import { transportLoad, transportInteger } from "./quantities.js";

export const TRANSPORT_SERVICE_DEFAULTS = Object.freeze({
  regularIntervalQd: 40, regularFirstQd: 4, charterVehicles: 1, charterPreparationQd: 1,
  commercialLoadBps: 6500, storageMilliCopperPerLoadQd: 1, insuranceBps: 300, insuranceCoverageBps: 8400,
  riskBps: 300
});

export function validateTransportConfiguration(raw = {}) {
  const config = { ...TRANSPORT_SERVICE_DEFAULTS, ...raw };
  for (const field of ["regularIntervalQd", "charterVehicles", "commercialLoadBps"]) transportInteger(config[field], field, 1, 10000);
  for (const field of ["regularFirstQd", "charterPreparationQd", "storageMilliCopperPerLoadQd", "insuranceBps", "insuranceCoverageBps", "riskBps"]) transportInteger(config[field], field, 0, 10000);
  if (config.commercialLoadBps > 10000) throw new Error("Коммерческая загрузка не может превышать 100%.");
  config.overrides ??= {};
  return config;
}

/** Collapse transit-only nodes before rounding movement or charging dispatch. */
export function transportServicesFromRoutes(routes = [], rawConfiguration = {}, regions = []) {
  const config = validateTransportConfiguration(rawConfiguration), result = new Map();
  for (const route of routes) {
    const groups = [];
    for (const leg of route.transportPlan?.legs ?? []) {
      const source = regions.find((row) => row.value === leg.fromRegionId), destination = regions.find((row) => row.value === leg.toRegionId);
      const link = source?.marketLinks?.find((row) => row.regionId === leg.toRegionId && (!leg.routeId || row.routeId === leg.routeId))
        ?? destination?.marketLinks?.find((row) => row.regionId === leg.fromRegionId && (!leg.routeId || row.routeId === leg.routeId));
      const accessCost = leg.fromRegionId === leg.toRegionId ? 0 : Number(link?.ursCost ?? link?.accessCost ?? 1);
      const previous = groups.at(-1);
      const same = previous && previous.mode === leg.mode && previous.carrierId === leg.carrierId
        && previous.toRegionId === leg.fromRegionId && leg.kind !== "last-mile"
        && (leg.carrierId !== "independent-carriers" || previous.fromCountryId === leg.fromCountryId);
      if (same) {
        previous.toRegionId = leg.toRegionId; previous.toLabel = leg.toLabel;
        previous.capacityLoad = Math.min(previous.capacityLoad, leg.capacityLoad);
        for (const field of ["movementQd", "distanceKm", "distanceCopper", "operatingCopper", "loadCopperPerUnit"]) previous[field] += Number(leg[field] ?? 0);
        previous.routeIds.push(leg.routeId);
        previous.accessCost += accessCost;
      } else groups.push({ ...leg, routeIds: [leg.routeId], accessCost });
    }
    for (const group of groups) {
      const from = group.fromRegionId, to = group.toRegionId;
      // A local last mile is still a physical leg with two different endpoints.
      const outbound = route.transportPlan.direction === "outbound";
      const source = from === to && outbound ? `${from}:holding` : from;
      const destination = from === to && !outbound ? `${to}:holding` : to;
      const key = stableDataHash([source, destination, group.mode, group.carrierId, group.routeIds]);
      const travelQd = Math.max(1, Math.ceil(group.movementQd));
      const fullCopper = Math.ceil(group.dispatchCopper + group.hireCopper + group.distanceCopper + group.operatingCopper
        + group.capacityLoad * group.loadCopperPerUnit);
      const base = { from: source, to: destination, fromLabel: group.fromLabel, toLabel: group.toLabel, companyId: group.carrierId,
        label: `${group.carrierLabel} · ${group.modeLabel}`, mode: group.mode, visibility: group.visibility,
        capacity: transportLoad(group.capacityLoad), travelQd, loadingQd: 1, unloadingQd: 1,
        storageMilliCopperPerLoadQd: config.storageMilliCopperPerLoadQd, riskBps: Math.min(10000, Math.round(config.riskBps * (group.riskFactor ?? 1))),
        distanceKm: group.distanceKm, accessCost: group.accessCost };
      const regular = { ...base, id: `regular:${key}`, kind: "regular", firstQd: config.regularFirstQd,
        intervalQd: config.regularIntervalQd, dispatchCopper: 1, returnQd: 0,
        loadMilliCopper: Math.ceil(fullCopper * 1000 / Math.max(0.001, group.capacityLoad * config.commercialLoadBps / 10000)) };
      const charter = { ...base, id: `charter:${key}`, kind: "charter", firstQd: 0, loadingQd: base.loadingQd + config.charterPreparationQd,
        vehicles: config.charterVehicles, returnQd: travelQd,
        dispatchCopper: Math.ceil(group.dispatchCopper + group.hireCopper + 2 * group.distanceCopper),
        operatingMilliCopperPerQd: Math.ceil(group.operatingCopper * 1000 / Math.max(1, group.movementQd)),
        loadMilliCopper: Math.ceil(group.loadCopperPerUnit * 1000) };
      for (const service of [regular, charter]) result.set(service.id, { ...service, ...(config.overrides[service.id] ?? {}), id: service.id,
        from: service.from, to: service.to, kind: service.kind, companyId: service.companyId });
    }
  }
  return [...result.values()];
}
