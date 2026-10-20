import { normalizeEventRegionOption, normalizeRandomEventRow, normalizeRandomEventTables } from "./random-events.js";
import { clone, toNumber } from "./utils.js";
import { normalizeMarketOffer } from "./market/market-catalog.js";
import { normalizeMarketCondition, normalizeMarketCountry, normalizeMarketEconomy, normalizeMarketOrganization, normalizeMarketSizeProfile, normalizeMarketSpecialty } from "./market/economy.js";
import { normalizeMarketRouteMap } from "./market/route-map.js";
import { normalizeResourceCatalogRow } from "../core/resources.js";
import { removedCatalogDependencies } from "./catalog-dependencies.js";

export const CONTENT_PACK_SCHEMA = "fbl-skyhold.content-pack";
export const CONTENT_PACK_FORMAT_VERSION = 1;
const CONTENT_KINDS = new Set(["buildings", "resources", "events.general", "events.external", "regions", "market.routeMap", "market.baseOffers", "market.countries", "market.specialties", "market.organizations", "market.sizeProfiles", "market.conditions", "doctrines"]);
const RETIRABLE_CONTENT_KINDS = new Set([...CONTENT_KINDS].filter((kind) => kind !== "market.routeMap"));
const ROUTE_MAP_CONTENT_ID = "world-market-route-map";

function boundedVersion(value, fallback = 1) {
  return Math.max(1, Math.min(1_000_000, Math.floor(toNumber(value, fallback))));
}

function contentMetadata(row = {}, source = "", fallbackVersion = 1) {
  return {
    contentVersion: boundedVersion(row?.contentVersion ?? row?.version ?? row?.templateVersion, fallbackVersion),
    contentSource: String(row?.contentSource ?? row?.source ?? source).trim().slice(0, 300)
  };
}

function normalizeBuildingEntry(row = {}, source = "", version = 1) {
  const id = String(row?.id ?? row?.templateId ?? "").trim();
  if (!id) return null;
  return { ...clone(row), id, ...contentMetadata(row, source, version) };
}

function normalizeEventEntry(row = {}, source = "", version = 1) {
  const normalized = normalizeRandomEventRow(row);
  return normalized ? { ...normalized, ...contentMetadata(row, source, version) } : null;
}

function normalizeResourceEntry(row = {}, source = "", version = 1) {
  const normalized = normalizeResourceCatalogRow(row);
  return normalized?.id ? { ...normalized, ...contentMetadata(row, source, version) } : null;
}

function normalizeRegionEntry(row = {}, index = 0, source = "", version = 1) {
  const normalized = normalizeEventRegionOption(row, index);
  return { ...normalized, ...contentMetadata(row, source, version) };
}

function normalizeDoctrineEntry(row = {}, source = "", version = 1) {
  const id = String(row?.id ?? row?.key ?? "").trim();
  if (!id) return null;
  return {
    ...clone(row),
    id,
    name: String(row?.name ?? row?.label ?? id).slice(0, 300),
    description: String(row?.description ?? "").slice(0, 4000),
    ...contentMetadata(row, source, version)
  };
}

function normalizeMarketEconomyEntry(kind = "", row = {}, index = 0, source = "", version = 1) {
  const normalizers = {
    baseOffers: normalizeMarketOffer,
    countries: normalizeMarketCountry,
    specialties: normalizeMarketSpecialty,
    organizations: normalizeMarketOrganization,
    sizeProfiles: normalizeMarketSizeProfile,
    conditions: normalizeMarketCondition
  };
  const normalized = normalizers[kind]?.(row, index);
  return normalized?.id ? { ...normalized, ...contentMetadata(row, source, version) } : null;
}

function normalizeRouteMapEntry(row = null, source = "", version = 1) {
  if (!row || typeof row !== "object") return null;
  return {
    id: ROUTE_MAP_CONTENT_ID,
    ...normalizeMarketRouteMap(row),
    ...contentMetadata(row, source, version)
  };
}

function normalizeRetirementEntry(row = null) {
  if (!row || typeof row !== "object") return null;
  const kind = String(row.kind ?? "").trim();
  const id = String(row.id ?? "").trim();
  if (!RETIRABLE_CONTENT_KINDS.has(kind) || !id) return null;
  return {
    kind,
    id,
    sources: [...new Set((Array.isArray(row.sources) ? row.sources : [row.source]).map((value) => String(value ?? "").trim()).filter(Boolean))]
  };
}

export function normalizeContentPack(raw = {}) {
  if (!raw || typeof raw !== "object") throw new TypeError("FBL Skyhold | Content pack must be an object.");
  const schema = String(raw.schema ?? "");
  if (schema !== CONTENT_PACK_SCHEMA) throw new Error(`FBL Skyhold | Unsupported content pack schema: ${schema || "missing"}.`);
  const formatVersion = boundedVersion(raw.formatVersion, CONTENT_PACK_FORMAT_VERSION);
  if (formatVersion !== CONTENT_PACK_FORMAT_VERSION) throw new Error(`FBL Skyhold | Unsupported content pack format version: ${formatVersion}.`);
  const id = String(raw.id ?? "").trim();
  const source = String(raw.source ?? id).trim();
  if (!id || !source) throw new Error("FBL Skyhold | Content pack id and source are required.");
  const version = boundedVersion(raw.version, 1);
  const content = raw.content && typeof raw.content === "object" ? raw.content : {};
  const installSource = raw.install && typeof raw.install === "object" ? raw.install : {};
  const events = content.events && typeof content.events === "object" ? content.events : {};
  const marketEconomy = content.marketEconomy && typeof content.marketEconomy === "object" ? content.marketEconomy : {};
  const normalizedEconomySettings = normalizeMarketEconomy({
    settings: marketEconomy.settings,
    baseOffers: [],
    countries: [],
    specialties: [],
    organizations: [],
    sizeProfiles: [],
    conditions: []
  }, { locations: [] }).settings;
  const mapRows = (rows, normalizer) => (Array.isArray(rows) ? rows : []).slice(0, 500).map(normalizer).filter(Boolean);
  return {
    schema: CONTENT_PACK_SCHEMA,
    formatVersion,
    id,
    source,
    version,
    name: String(raw.name ?? id).slice(0, 300),
    description: String(raw.description ?? "").slice(0, 4000),
    install: {
      replaceMarket: installSource.replaceMarket === true,
      replaceResources: installSource.replaceResources === true,
      overwriteResources: installSource.overwriteResources === true
    },
    content: {
      buildings: mapRows(content.buildings, (row) => normalizeBuildingEntry(row, source, version)),
      resources: mapRows(content.resources, (row) => normalizeResourceEntry(row, source, version)),
      events: {
        general: mapRows(events.general, (row) => normalizeEventEntry(row, source, version)),
        external: mapRows(events.external, (row) => normalizeEventEntry(row, source, version))
      },
      regions: mapRows(content.regions, (row, index) => normalizeRegionEntry(row, index, source, version)),
      marketRouteMap: normalizeRouteMapEntry(content.marketRouteMap ?? content.routeMap, source, version),
      marketEconomy: {
        settings: normalizedEconomySettings,
        baseOffers: mapRows(marketEconomy.baseOffers, (row, index) => normalizeMarketEconomyEntry("baseOffers", row, index, source, version)),
        countries: mapRows(marketEconomy.countries, (row, index) => normalizeMarketEconomyEntry("countries", row, index, source, version)),
        specialties: mapRows(marketEconomy.specialties, (row, index) => normalizeMarketEconomyEntry("specialties", row, index, source, version)),
        organizations: mapRows(marketEconomy.organizations, (row, index) => normalizeMarketEconomyEntry("organizations", row, index, source, version)),
        sizeProfiles: mapRows(marketEconomy.sizeProfiles, (row, index) => normalizeMarketEconomyEntry("sizeProfiles", row, index, source, version)),
        conditions: mapRows(marketEconomy.conditions, (row, index) => normalizeMarketEconomyEntry("conditions", row, index, source, version))
      },
      doctrines: mapRows(content.doctrines, (row) => normalizeDoctrineEntry(row, source, version)),
      retire: mapRows(content.retire, (row) => normalizeRetirementEntry(row))
    }
  };
}

function existingRows(data, holding, kind) {
  if (kind === "buildings") return data?.catalog?.buildings ?? [];
  if (kind === "resources") return data?.catalog?.resources ?? [];
  if (kind === "regions") return data?.catalog?.eventRegions ?? [];
  if (kind === "market.routeMap") {
    const routeMap = data?.catalog?.marketRouteMap;
    return routeMap && typeof routeMap === "object" ? [{ id: ROUTE_MAP_CONTENT_ID, ...routeMap }] : [];
  }
  if (kind.startsWith("market.")) {
    const collection = kind.slice(7);
    const storedEconomy = data?.catalog?.marketEconomy;
    return storedEconomy && Array.isArray(storedEconomy[collection]) ? storedEconomy[collection] : [];
  }
  if (kind === "doctrines") return data?.catalog?.combatDoctrines ?? [];
  const tables = normalizeRandomEventTables(holding?.gm?.eventTables);
  return kind === "events.external" ? tables.external.rows : tables.general.rows;
}

function incomingRows(pack, kind) {
  if (kind === "buildings") return pack.content.buildings;
  if (kind === "resources") return pack.content.resources;
  if (kind === "regions") return pack.content.regions;
  if (kind === "market.routeMap") return pack.content.marketRouteMap ? [pack.content.marketRouteMap] : [];
  if (kind.startsWith("market.")) return pack.content.marketEconomy[kind.slice(7)] ?? [];
  if (kind === "doctrines") return pack.content.doctrines;
  return kind === "events.external" ? pack.content.events.external : pack.content.events.general;
}

function rowId(row = {}, kind = "") {
  return String(kind === "regions" ? row?.value ?? row?.id ?? "" : row?.id ?? "");
}

function changeFor(existing, incoming) {
  if (!existing) return { status: "add", reason: "Новый id" };
  const incomingVersion = boundedVersion(incoming?.contentVersion, 1);
  const existingVersion = boundedVersion(existing?.contentVersion ?? existing?.version ?? existing?.templateVersion, 1);
  const incomingSource = String(incoming?.contentSource ?? "");
  const existingSource = String(existing?.contentSource ?? existing?.source ?? "");
  if (incomingSource && existingSource && incomingSource !== existingSource) return { status: "conflict", reason: `Другой source: ${existingSource}` };
  if (!existingSource && incomingSource) return { status: "conflict", reason: "Существующая запись не имеет source" };
  if (incomingVersion > existingVersion) return { status: "update", reason: `${existingVersion} → ${incomingVersion}` };
  return { status: "skip", reason: incomingVersion === existingVersion ? "Та же версия" : `Установлена более новая версия ${existingVersion}` };
}

export function planContentPackImport({ data, holdingId = "", rawPack } = {}) {
  const pack = normalizeContentPack(rawPack);
  const holding = holdingId
    ? (data?.holdings ?? []).find((row) => String(row?.id ?? "") === String(holdingId))
    : data?.holdings?.[0];
  if (!holding) throw new Error("FBL Skyhold | Content pack target holding was not found.");
  const changes = [];
  if (pack.install.replaceMarket) {
    changes.push({
      key: "reset:market",
      kind: "market.reset",
      id: "market-reset",
      label: "Текущая экономика, локации и маршруты",
      status: "remove",
      reason: "Полная чистая установка этого пакета",
      resetScope: "market",
      existing: null,
      incoming: null
    });
  }
  if (pack.install.replaceResources) {
    changes.push({
      key: "reset:resources",
      kind: "resources.reset",
      id: "resources-reset",
      label: "Текущий пользовательский каталог материалов",
      status: "remove",
      reason: "Полная чистая установка материалов этого пакета",
      resetScope: "resources",
      existing: null,
      incoming: null
    });
  }
  for (const kind of CONTENT_KINDS) {
    const replaceKind = (pack.install.replaceMarket && (kind === "regions" || kind === "market.routeMap" || kind.startsWith("market.")))
      || (pack.install.replaceResources && kind === "resources");
    const existing = replaceKind ? [] : existingRows(data, holding, kind);
    const byId = new Map(existing.map((row) => [rowId(row, kind), row]).filter(([id]) => Boolean(id)));
    for (const incoming of incomingRows(pack, kind)) {
      const id = rowId(incoming, kind);
      if (!id) continue;
      const current = byId.get(id) ?? null;
      const decision = kind === "resources" && pack.install.overwriteResources && current
        ? { status: "update", reason: "Пакет заменяет одноимённый ресурс своей версией" }
        : changeFor(current, incoming);
      changes.push({
        key: `${kind}:${id}`,
        kind,
        id,
        label: String(incoming?.name ?? incoming?.title ?? incoming?.label ?? id),
        ...decision,
        incoming: clone(incoming),
        existing: current ? clone(current) : null
      });
    }
  }
  for (const retirement of pack.install.replaceMarket ? [] : (pack.content.retire ?? [])) {
    const existing = existingRows(data, holding, retirement.kind);
    const current = existing.find((row) => rowId(row, retirement.kind) === retirement.id) ?? null;
    if (!current) {
      changes.push({ key: `retire:${retirement.kind}:${retirement.id}`, kind: retirement.kind, id: retirement.id, label: retirement.id, status: "skip", reason: "Запись уже отсутствует", retire: true, existing: null, incoming: null });
      continue;
    }
    const existingSource = String(current?.contentSource ?? current?.source ?? "").trim();
    const sourceAllowed = retirement.sources.length === 0 || retirement.sources.includes(existingSource);
    changes.push({
      key: `retire:${retirement.kind}:${retirement.id}`,
      kind: retirement.kind,
      id: retirement.id,
      label: String(current?.name ?? current?.title ?? current?.label ?? retirement.id),
      status: sourceAllowed ? "remove" : "conflict",
      reason: sourceAllowed ? "Устаревшая запись пакета" : `Другой source: ${existingSource || "без source"}`,
      retire: true,
      existing: clone(current),
      incoming: null
    });
  }
  const counts = changes.reduce((result, row) => ({ ...result, [row.status]: (result[row.status] ?? 0) + 1 }), { add: 0, update: 0, remove: 0, skip: 0, conflict: 0 });
  return {
    pack,
    holdingId: String(holding.id),
    baseRevision: Math.max(0, toNumber(data?.meta?.revision, 0)),
    changes,
    counts,
    hasChanges: counts.add + counts.update + counts.remove + counts.conflict > 0
  };
}

function targetRows(data, holding, kind) {
  if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
  if (kind === "buildings") return data.catalog.buildings ??= [];
  if (kind === "resources") return data.catalog.resources ??= [];
  if (kind === "regions") return data.catalog.eventRegions ??= [];
  if (kind.startsWith("market.")) {
    data.catalog.markets = [];
    data.catalog.marketEconomy = normalizeMarketEconomy(data.catalog.marketEconomy, { locations: data.catalog.eventRegions ?? [] });
    return data.catalog.marketEconomy[kind.slice(7)] ??= [];
  }
  if (kind === "doctrines") return data.catalog.combatDoctrines ??= [];
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  holding.gm.eventTables = normalizeRandomEventTables(holding.gm.eventTables);
  return kind === "events.external" ? holding.gm.eventTables.external.rows : holding.gm.eventTables.general.rows;
}

export function applyContentPackImport({ data, plan, resolutions = {} } = {}) {
  const draft = clone(data);
  const result = applyContentPackToDraft({ data: draft, plan, resolutions });
  if (!result.ok) return result;
  const dependencies = removedCatalogDependencies(data, draft);
  if (dependencies.length) return { ok: false, dependencies,
    message: `Импорт удаляет используемые записи: ${dependencies.slice(0, 5).map((row) => `${row.id} (${row.path})`).join("; ")}. Сначала замените ссылки или используйте пакет без полной замены.` };
  Object.assign(data, draft);
  return result;
}

function applyContentPackToDraft({ data, plan, resolutions = {} } = {}) {
  if (!data || typeof data !== "object" || !plan?.pack) throw new TypeError("FBL Skyhold | A current data root and import plan are required.");
  const currentRevision = Math.max(0, toNumber(data?.meta?.revision, 0));
  if (currentRevision !== Math.max(0, toNumber(plan.baseRevision, 0))) return { ok: false, stale: true, message: "Данные изменились после предпросмотра импорта." };
  const holding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === String(plan.holdingId ?? ""));
  if (!holding) return { ok: false, message: "Целевое владение не найдено." };
  const applied = [];
  for (const change of plan.changes ?? []) {
    const resolution = change.status === "conflict" ? String(resolutions[change.key] ?? "existing") : change.status;
    if (["skip", "existing"].includes(resolution)) continue;
    if (change.resetScope === "market") {
      data.catalog ??= {};
      data.catalog.markets = [];
      data.catalog.eventRegions = [];
      delete data.catalog.marketRouteMap;
      data.catalog.marketEconomy = {
        schemaVersion: 2,
        settings: clone(plan.pack.content.marketEconomy.settings),
        baseOffers: [],
        countries: [],
        specialties: [],
        organizations: [],
        sizeProfiles: [],
        conditions: []
      };
      applied.push({ key: change.key, kind: change.kind, id: change.id, resolution: "remove" });
      continue;
    }
    if (change.resetScope === "resources") {
      data.catalog ??= {};
      data.catalog.resources = [];
      applied.push({ key: change.key, kind: change.kind, id: change.id, resolution: "remove" });
      continue;
    }
    if (change.retire) {
      if (!["remove", "incoming"].includes(resolution)) continue;
      const rows = targetRows(data, holding, change.kind);
      const index = rows.findIndex((row) => rowId(row, change.kind) === change.id);
      if (index >= 0) rows.splice(index, 1);
      applied.push({ key: change.key, kind: change.kind, id: change.id, resolution: "remove" });
      continue;
    }
    if (!["add", "update", "incoming"].includes(resolution)) continue;
    if (change.kind === "market.routeMap") {
      data.catalog ??= {};
      data.catalog.marketRouteMap = { ...normalizeMarketRouteMap(change.incoming), ...contentMetadata(change.incoming, plan.pack.source, plan.pack.version) };
      applied.push({ key: change.key, kind: change.kind, id: change.id, resolution });
      continue;
    }
    const rows = targetRows(data, holding, change.kind);
    const index = rows.findIndex((row) => rowId(row, change.kind) === change.id);
    if (index >= 0) rows[index] = clone(change.incoming);
    else rows.push(clone(change.incoming));
    applied.push({ key: change.key, kind: change.kind, id: change.id, resolution });
  }
  return { ok: true, applied, count: applied.length, packId: plan.pack.id, packVersion: plan.pack.version };
}

export function normalizeContentDoctrines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => normalizeDoctrineEntry(row, String(row?.contentSource ?? row?.source ?? ""), row?.contentVersion ?? row?.version ?? 1)).filter(Boolean).slice(0, 500);
}
