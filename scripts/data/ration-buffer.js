export const RATION_BUFFER_VERSION = 1;

const DIET_GROUPS = new Set(["staple", "protein", "dairy", "produce"]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function wholePoints(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

function normalizedDietGroup(value) {
  const group = cleanText(value).toLowerCase();
  return DIET_GROUPS.has(group) ? group : "";
}

function normalizedTags(value) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/);
  return [...new Set(source
    .map((tag) => cleanText(tag).toLowerCase())
    .filter(Boolean))]
    .sort();
}

export function rationBufferEntryKey(entry = {}) {
  return [
    cleanText(entry.resourceId).toLowerCase() || "custom",
    cleanText(entry.sourceRowId),
    cleanText(entry.sourceRoomId),
    normalizedDietGroup(entry.dietGroup),
    wholePoints(entry.unitRationPoints),
    wholePoints(entry.shelfLifeTendays),
    wholePoints(entry.shelfLifeDays),
    wholePoints(entry.expiresQd),
    normalizedTags(entry.nutritionTags).join(",")
  ].join("|");
}

export function normalizeRationBufferEntry(entry = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const points = wholePoints(entry.points);
  if (!points) return null;
  const resourceId = cleanText(entry.resourceId).toLowerCase() || "custom";
  const openedQd = Math.max(0, Math.floor(Number.isFinite(Number(entry.openedQd)) ? Number(entry.openedQd) : 0));
  const shelfLifeTendays = wholePoints(entry.shelfLifeTendays);
  const shelfLifeDays = wholePoints(entry.shelfLifeDays) || (shelfLifeTendays * 10);
  const configuredExpiry = wholePoints(entry.expiresQd);
  const normalized = {
    id: cleanText(entry.id),
    points,
    resourceId,
    name: cleanText(entry.name) || resourceId,
    dietGroup: normalizedDietGroup(entry.dietGroup),
    nutritionTags: normalizedTags(entry.nutritionTags),
    sourceRowId: cleanText(entry.sourceRowId),
    sourceRoomId: cleanText(entry.sourceRoomId),
    unitRationPoints: Math.max(1, wholePoints(entry.unitRationPoints)),
    openedQd,
    shelfLifeTendays,
    shelfLifeDays,
    expiresQd: shelfLifeTendays > 0 ? (configuredExpiry || openedQd + (shelfLifeTendays * 40)) : 0
  };
  if (!normalized.id) normalized.id = `ration:${encodeURIComponent(rationBufferEntryKey(normalized))}`;
  return normalized;
}

/**
 * Normalize the durable remainder of opened Economy V2 food packages.
 *
 * Invalid and zero-point entries are discarded. Equal provenance entries are
 * merged without changing their first-seen order, which makes normal loading
 * and repeated tenday previews deterministic.
 */
export function normalizeRationBuffer(value = null) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const entries = [];
  const byKey = new Map();
  for (const candidate of Array.isArray(source.entries) ? source.entries : []) {
    const entry = normalizeRationBufferEntry(candidate);
    if (!entry) continue;
    const key = rationBufferEntryKey(entry);
    const existing = byKey.get(key);
    if (existing) {
      existing.points = Math.min(Number.MAX_SAFE_INTEGER, existing.points + entry.points);
      existing.openedQd = Math.min(existing.openedQd, entry.openedQd);
      continue;
    }
    entries.push(entry);
    byKey.set(key, entry);
  }
  return { version: RATION_BUFFER_VERSION, entries };
}

export function totalRationBufferPoints(value = null) {
  return normalizeRationBuffer(value).entries.reduce((sum, entry) => sum + entry.points, 0);
}
