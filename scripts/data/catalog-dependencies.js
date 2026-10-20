import { BUILTIN_RESOURCE_DEFS } from "./resources/builtin-resources.js";
import { normalizeResourceId, parseResourceCosts, withResourceCatalog } from "../core/resources.js";

const BUILTIN_IDS = new Set(BUILTIN_RESOURCE_DEFS.map((row) => row.id));

/** Inspect references, not free-text labels. Historical records are retained too. */
function references(root, kind, ids, path = "", found = []) {
  if (!root || typeof root !== "object" || !ids.size) return found;
  for (const [key, value] of Object.entries(root)) {
    const location = path ? `${path}.${key}` : key;
    const resourceField = /^(resource|resourceIds?|fuelChoice)$|ResourceIds?$/.test(key);
    const regionField = key === "region" || key === "regionId" || key.endsWith("RegionId")
      || (key === "value" && root.type === "region")
      || (key === "id" && ["region", "location", "market"].includes(root.kind));
    const dictionaryField = {
      resource: resourceField,
      region: regionField || /^(marketId|portId)$|PortId$/.test(key),
      market: /^(marketId)$|MarketId$/.test(key),
      country: /^(countryId)$|CountryId$/.test(key),
      organization: /^(organizationId|providerId|merchantId|carrierId|buyerId)$/.test(key),
      specialty: /^(specialtyIds?)$|SpecialtyIds?$/.test(key),
      sizeProfile: /^(sizeProfileId|marketSizeId|marketSize)$/.test(key),
      condition: /^(conditionId|marketConditionId|marketStatus)$/.test(key)
    }[kind];
    if (dictionaryField) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string") continue;
        const resolvedId = kind === "resource" ? normalizeResourceId(id) : id;
        if (ids.has(resolvedId)) found.push({ kind, id: resolvedId, path: location });
      }
    }
    if (kind === "resource" && key === "expenses" && typeof value === "string") {
      references(parseResourceCosts(value), kind, ids, location, found);
    }
    if (kind === "resource" && ids.has(key) && typeof value === "number") found.push({ kind, id: key, path: location });
    references(value, kind, ids, location, found);
  }
  return found;
}

export function resourceCatalogReferences(data, id) {
  return withResourceCatalog(data?.catalog?.resources ?? [], () =>
    references({ holdings: data?.holdings, catalog: { ...data?.catalog, resources: [] } }, "resource", new Set([id])));
}

export function assertResourceCatalogUnused(data, id) {
  const usages = resourceCatalogReferences(data, id);
  if (!usages.length) return;
  const error = new Error(`Ресурс «${id}» используется (${usages[0].path}). Сначала замените ссылки; ресурс можно скрыть вместо удаления.`);
  error.code = "conflict";
  throw error;
}

/** Only flag references newly broken by this edit, without repairing saved customization. */
export function removedCatalogDependencies(previous, next) {
  const resourceIds = new Set((next?.catalog?.resources ?? []).map((row) => row.id));
  const removedResources = new Set((previous?.catalog?.resources ?? []).map((row) => row.id)
    .filter((id) => !resourceIds.has(id) && !BUILTIN_IDS.has(id)));
  const regionIds = new Set((next?.catalog?.eventRegions ?? []).map((row) => row.value));
  const removedRegions = new Set((previous?.catalog?.eventRegions ?? []).map((row) => row.value).filter((id) => !regionIds.has(id)));
  const found = withResourceCatalog(previous?.catalog?.resources ?? [], () => references(next, "resource", removedResources));
  references(next, "region", removedRegions, "", found);
  const dictionaries = [
    ["market", previous?.catalog?.markets, next?.catalog?.markets],
    ...[["country", "countries"], ["organization", "organizations"], ["specialty", "specialties"], ["sizeProfile", "sizeProfiles"], ["condition", "conditions"]]
      .map(([kind, key]) => [kind, previous?.catalog?.marketEconomy?.[key], next?.catalog?.marketEconomy?.[key]])
  ];
  for (const [kind, before, after] of dictionaries) {
    const kept = new Set((after ?? []).map((row) => row.id));
    references(next, kind, new Set((before ?? []).map((row) => row.id).filter((id) => !kept.has(id))), "", found);
  }
  return found;
}
