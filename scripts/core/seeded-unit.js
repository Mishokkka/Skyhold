/** Stable unit interval draw; preserving this algorithm preserves saved incident outcomes. */
export function deterministicUnit(seed = "") {
  let value = 2166136261;
  for (const char of String(seed ?? "")) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967295;
}
