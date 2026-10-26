const MODE_BITS = { caravan: 1, rail: 2, airship: 4 };
const MAX_SEARCH_LABELS = 20_000;

// Keep the nondominated transport alternatives. Price depends on access,
// distance, mode, operating time, load and insurance, so a single shortest
// path cannot stand in for the eventual quote of a real consignment.
export function marketTransportRoutes({ graph, from, to, maxAccess, modesForEdge, termsForEdge, preserveFirstMode = false,
  servicesForEdge = null } = {}) {
  if (from === to) return { routes: [], limited: false };
  const risks = servicesForEdge ? new Set() : new Set([...graph.values()].flatMap((edges) => edges.map((edge) => termsForEdge(edge, "caravan").risk)));
  const uniformRisk = risks.size <= 1;
  const labels = new Map();
  const queue = [{ path: [from], edges: [], distanceKm: 0, accessCost: 0, mask: 0,
    flat: 0, load: 0, time: 0, operating: 0, risk: 0, capacity: Infinity, curves: {}, valueCost: 0 }];
  const routes = [];
  let generated = 1;
  const dominates = (a, b) => {
    if (!a.path.every((node) => b.path.includes(node))) return false;
    if (servicesForEdge) return a.time <= b.time + 1e-9 && a.accessCost <= b.accessCost && a.risk <= b.risk
      && a.valueCost <= b.valueCost + 1e-9
      && [...new Set([...Object.keys(a.curves), ...Object.keys(b.curves)])]
        .every((capacity) => (a.curves[capacity] ?? 0) <= (b.curves[capacity] ?? 0) + 1e-9);
    return ["distanceKm", "accessCost", "flat", "load", "time", "operating"].every((key) => a[key] <= b[key] + 1e-9)
    // With varying seasonal risk, a shorter prefix can dilute a later risk
    // differently. Only equal distances allow that prefix to be discarded.
      && (uniformRisk || (Math.abs(a.distanceKm - b.distanceKm) < 1e-9 && a.risk <= b.risk + 1e-9));
  };
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.discarded) continue;
    const node = current.path.at(-1);
    if (node === to) { routes.push(current); continue; }
    for (const edge of graph.get(node) ?? []) {
      if (current.path.includes(edge.to) || current.accessCost + edge.ursCost > maxAccess) continue;
      for (const mode of modesForEdge(node, edge)) {
        for (const service of servicesForEdge ? servicesForEdge(node, edge, mode) : [null]) {
          const terms = termsForEdge({ from: node, ...edge }, mode, service, current);
          const curves = { ...current.curves };
          for (const [capacity, amount] of Object.entries(terms.curves ?? {})) curves[capacity] = (curves[capacity] ?? 0) + amount;
          const next = { path: [...current.path, edge.to], edges: [...current.edges, { from: node, ...edge, selectedMode: mode, ...(service ? { service } : {}) }],
            distanceKm: current.distanceKm + edge.distanceKm, accessCost: current.accessCost + edge.ursCost,
            mask: current.mask | MODE_BITS[mode], flat: current.flat + terms.flat, load: current.load + terms.load,
            time: current.time + terms.time, operating: current.operating + terms.operating,
            risk: servicesForEdge ? Math.max(current.risk, terms.risk) : current.risk + edge.distanceKm * terms.risk,
            capacity: Math.min(current.capacity, terms.capacity ?? Infinity), curves, valueCost: current.valueCost + (terms.valueCost ?? 0) };
          // A floating holding's first leg changes feasibility and last-mile charges.
          // Exact capacity and distance keep nonlinear booking floors and weighted freight factors comparable.
          const serviceKey = servicesForEdge ? [mode, service.carrier.id,
            service.carrier.independent ? service.carrier.dispatchCountryId : "", next.capacity, next.distanceKm] : [];
          const key = JSON.stringify([edge.to, next.mask, preserveFirstMode ? next.edges[0].selectedMode : "", ...serviceKey]);
          const bucket = labels.get(key) ?? [];
          if (bucket.some((previous) => !previous.discarded && dominates(previous, next))) continue;
          for (const previous of bucket) if (dominates(next, previous)) previous.discarded = true;
          bucket.push(next);
          labels.set(key, bucket);
          queue.push(next);
          if (++generated > MAX_SEARCH_LABELS) return { routes: [], limited: true };
        }
      }
    }
  }
  return { routes: routes.filter((route) => !route.discarded).map((route) => ({ ...route,
    distance: route.distanceKm / 40, hops: route.edges.length })), limited: false };
}
