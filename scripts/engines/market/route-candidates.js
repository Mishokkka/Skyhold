const MODE_BITS = { caravan: 1, rail: 2, airship: 4 };
const MAX_SEARCH_LABELS = 20_000;

// Keep the nondominated transport alternatives. Price depends on access,
// distance, mode, operating time, load and insurance, so a single shortest
// path cannot stand in for the eventual quote of a real consignment.
export function marketTransportRoutes({ graph, from, to, maxAccess, modesForEdge, termsForEdge } = {}) {
  if (from === to) return { routes: [], limited: false };
  const risks = new Set([...graph.values()].flatMap((edges) => edges.map((edge) => termsForEdge(edge, "caravan").risk)));
  const uniformRisk = risks.size <= 1;
  const labels = new Map();
  const queue = [{ path: [from], edges: [], distanceKm: 0, accessCost: 0, mask: 0,
    flat: 0, load: 0, time: 0, operating: 0, risk: 0 }];
  const routes = [];
  let generated = 1;
  const dominates = (a, b) => a.path.every((node) => b.path.includes(node))
    && ["distanceKm", "accessCost", "flat", "load", "time", "operating"].every((key) => a[key] <= b[key] + 1e-9)
    // With varying seasonal risk, a shorter prefix can dilute a later risk
    // differently. Only equal distances allow that prefix to be discarded.
    && (uniformRisk || (Math.abs(a.distanceKm - b.distanceKm) < 1e-9 && a.risk <= b.risk + 1e-9));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (current.discarded) continue;
    const node = current.path.at(-1);
    if (node === to) { routes.push(current); continue; }
    for (const edge of graph.get(node) ?? []) {
      if (current.path.includes(edge.to) || current.accessCost + edge.ursCost > maxAccess) continue;
      for (const mode of modesForEdge(node, edge)) {
        const terms = termsForEdge(edge, mode);
        const next = { path: [...current.path, edge.to], edges: [...current.edges, { from: node, ...edge, selectedMode: mode }],
          distanceKm: current.distanceKm + edge.distanceKm, accessCost: current.accessCost + edge.ursCost,
          mask: current.mask | MODE_BITS[mode], flat: current.flat + terms.flat, load: current.load + terms.load,
          time: current.time + terms.time, operating: current.operating + terms.operating,
          risk: current.risk + edge.distanceKm * terms.risk };
        const key = `${edge.to}:${next.mask}`;
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
  return { routes: routes.filter((route) => !route.discarded).map((route) => ({ ...route,
    distance: route.distanceKm / 40, hops: route.edges.length })), limited: false };
}
