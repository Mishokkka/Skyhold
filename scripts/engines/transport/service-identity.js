const unscaledServiceId = id => String(id).replace(/:x\d+$/, "");
const regionalServiceId = id => /^((?:regular|charter):[a-z0-9]+:route:[a-z0-9]+):holding:.+$/.exec(unscaledServiceId(id))?.[1] ?? unscaledServiceId(id);

/** New physical paths retain their former group ID as an explicit compatibility prefix. */
export function legacyTransportServiceId(id) {
  const regional = regionalServiceId(id);
  return /^(regular|charter):([a-z0-9]+):route:[a-z0-9]+$/.exec(String(regional))
    ?.slice(1, 3).join(":") ?? regional;
}

/** Most specific first: scaled, base warehouse, previous regional path, then the old path group. */
export function transportServiceCompatibilityIds(id) {
  return [...new Set([id, unscaledServiceId(id), regionalServiceId(id), legacyTransportServiceId(id)])];
}

/** An old ambiguous allocation conservatively occupies each possible successor fleet.
 * Two fully identified new paths have independent vehicles and regular departures.
 */
export function transportServicesShareFleet(a, b) {
  const baseA = unscaledServiceId(a), baseB = unscaledServiceId(b);
  return baseA === baseB || transportServiceCompatibilityIds(a).includes(baseB) || transportServiceCompatibilityIds(b).includes(baseA);
}

export function transportServiceExcluded(service, excluded = []) {
  excluded ??= [];
  return excluded.includes(service.companyId) || transportServiceCompatibilityIds(service.id).some(id => excluded.includes(id));
}

/** Single canonical eligibility predicate shared across route discovery, quoting and confirmation. */
export function isTransportServiceAllowed(service, { isGM = false, excluded = [] } = {}) {
  return Boolean(service)
    && service.enabled !== false
    && (isGM || service.visibility !== "gm")
    && !transportServiceExcluded(service, excluded);
}

/** Saved UI choices can follow an unambiguous old ID; never guess between physical paths. */
export function resolveTransportSelections(services, request) {
  const ambiguous = new Set();
  const resolve = id => {
    if (!id || services.some(service => service.id === id)) return id;
    const matches = services.filter(service => transportServiceCompatibilityIds(service.id).includes(id));
    if (matches.length > 1) ambiguous.add(id);
    return matches.length === 1 ? matches[0].id : id;
  };
  return { request: { ...request,
    pins: Object.fromEntries(Object.entries(request.pins ?? {}).map(([from, id]) => [from, resolve(id)])),
    ...(request.serviceIds ? { serviceIds: request.serviceIds.map(resolve) } : {}) }, ambiguous: [...ambiguous] };
}
