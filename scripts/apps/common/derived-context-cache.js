export function createDerivedContextCache({ limit = 12 } = {}) {
  const rows = new Map();
  const maxEntries = Math.max(1, Number(limit) || 1);
  const metrics = { hits: 0, misses: 0 };
  let generation;
  let hasGeneration = false;

  function getOrCreate(key, builder) {
    const normalizedKey = String(key ?? "");
    if (rows.has(normalizedKey)) {
      const value = rows.get(normalizedKey);
      rows.delete(normalizedKey);
      rows.set(normalizedKey, value);
      metrics.hits += 1;
      return value;
    }
    metrics.misses += 1;
    const value = builder();
    rows.set(normalizedKey, value);
    while (rows.size > maxEntries) rows.delete(rows.keys().next().value);
    return value;
  }

  function clear() {
    rows.clear();
  }

  function setGeneration(value) {
    if (hasGeneration && Object.is(generation, value)) return false;
    generation = value;
    hasGeneration = true;
    clear();
    return true;
  }

  function getMetrics() {
    return { ...metrics, size: rows.size };
  }

  function resetMetrics() {
    metrics.hits = 0;
    metrics.misses = 0;
  }

  return { clear, getMetrics, getOrCreate, resetMetrics, setGeneration };
}

export function derivedContextKey(parts = {}) {
  return JSON.stringify(parts, (_key, value) => {
    if (value instanceof Set) return [...value];
    if (value instanceof Map) return [...value.entries()];
    return value;
  });
}
