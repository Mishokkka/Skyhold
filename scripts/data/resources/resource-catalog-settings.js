import { MODULE_ID, SETTING_CATALOG, SETTING_DATA, SETTING_META } from "../constants.js";

export function worldResourceCatalogCacheKey(settings = globalThis.game?.settings) {
  try {
    const meta = settings?.get?.(MODULE_ID, SETTING_META);
    if (!meta || typeof meta !== "object") return "";
    const revision = Number(meta.revision);
    if (!Number.isFinite(revision)) return "";
    const commit = meta.storageCommit && typeof meta.storageCommit === "object" ? meta.storageCommit : {};
    const catalogHash = String(commit.catalogHash ?? "");
    if (catalogHash && commit.writeComplete !== false) return `catalog:${catalogHash}`;
    return [
      "revision",
      Math.max(0, Math.floor(revision)),
      String(commit.writeId ?? ""),
      commit.writeComplete === false ? "writing" : "complete"
    ].join(":");
  } catch (_error) {
    return "";
  }
}

export function readWorldResourceCatalogRows(settings = globalThis.game?.settings) {
  try {
    const catalog = settings?.get?.(MODULE_ID, SETTING_CATALOG);
    if (Array.isArray(catalog?.resources)) return catalog.resources;
    const legacy = settings?.get?.(MODULE_ID, SETTING_DATA);
    return Array.isArray(legacy?.catalog?.resources) ? legacy.catalog.resources : [];
  } catch (_error) {
    return [];
  }
}
