export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["false", "0", "no", "off", "нет", "не", "выкл"].includes(text)) return false;
  if (["true", "1", "yes", "on", "да", "вкл"].includes(text)) return true;
  return fallback;
}

export function mergeDefaults(defaultValue, storedValue) {
  if (Array.isArray(defaultValue)) {
    return Array.isArray(storedValue) ? clone(storedValue) : clone(defaultValue);
  }

  if (isPlainObject(defaultValue)) {
    const result = clone(defaultValue);
    if (!isPlainObject(storedValue)) return result;

    for (const [key, value] of Object.entries(storedValue)) {
      if (key in result) result[key] = mergeDefaults(result[key], value);
      else result[key] = clone(value);
    }

    return result;
  }

  return storedValue ?? defaultValue;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function makeId(prefix) {
  const randomPart = globalThis.foundry?.utils?.randomID?.(10) ?? Math.random().toString(36).slice(2, 12);
  return `${prefix}-${randomPart}`;
}
