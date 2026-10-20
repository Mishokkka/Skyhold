import { normalizeResourceId, resourceDef, resourceShelfLifeQd } from "../../core/resources.js";
import { isPerishableFoodDefinition } from "../../core/perishable-food.js";
import { buildingOperationalState } from "../../core/building-state.js";
import { maintenanceEfficiencyFactor } from "../../data/economy/maintenance.js";
import { financeBuildingFunctionBlockState, financeWorkerBlockState } from "../economy/finance-obligations.js";

function normalizedList(value) {
  return (Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/))
    .map((entry) => String(entry ?? "").trim().toLocaleLowerCase("ru"))
    .filter(Boolean);
}

function definitionFor(resource = {}) {
  const id = normalizeResourceId(resource?.resourceId, resource?.id, resource?.name);
  return { id, definition: id === "custom" ? resource : (resourceDef(id) ?? resource) };
}

export function storageProfileMatches(storage = {}, resource = {}) {
  const profileIds = normalizedList(storage.profileResourceIds);
  const profileCategories = normalizedList(storage.profileCategoryTags);
  const profileTags = normalizedList(storage.profileMarketTags);
  const hasProfile = profileIds.length || profileCategories.length || profileTags.length || storage.profilePerishableFood === true;
  if (!hasProfile) return false;

  const { id, definition } = definitionFor(resource);
  const category = String(definition?.categoryTag ?? resource?.categoryTag ?? "").trim().toLocaleLowerCase("ru");
  const tags = new Set([
    ...normalizedList(definition?.marketTags),
    ...normalizedList(resource?.marketTags),
    ...normalizedList(definition?.materialGroups),
    ...normalizedList(resource?.materialGroups)
  ]);
  if (profileIds.includes(String(id).toLocaleLowerCase("ru"))) return true;
  if (category && profileCategories.includes(category)) return true;
  if (profileTags.some((tag) => tags.has(tag))) return true;
  if (storage.profilePerishableFood === true) {
    return isPerishableFoodDefinition({ ...resource, ...definition, shelfLifeQd: definition?.shelfLifeQd ?? resourceShelfLifeQd(resource) });
  }
  return false;
}

export function storageProfileEffectFactor(holding = {}, building = {}) {
  if (!buildingOperationalState(building).operational) return 0;
  const block = financeBuildingFunctionBlockState({
    finance: holding?.finance,
    buildingId: String(building?.id ?? ""),
    functionId: "storage"
  });
  if (block.blocked) return 0;

  const storage = building?.storage ?? {};
  if (storage.profileRequiresStaff === true) {
    const people = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
    const staffed = (building?.assignedWorkerIds ?? []).filter((workerId) => {
      const id = String(workerId ?? "");
      const person = people.get(id);
      return id
        && person
        && !person.dead
        && Math.max(0, Number(person?.injuredDays) || 0) <= 0
        && !financeWorkerBlockState({ finance: holding?.finance, workerId: id }).blocked;
    }).length;
    if (staffed < Math.max(1, Math.floor(Number(building?.workersMin) || 0))) return 0;
  }
  return Math.max(0, Math.min(1, maintenanceEfficiencyFactor(building?.maintenance)));
}

export function storageProfileLoadMultiplier(room = {}, resource = {}) {
  if (!storageProfileMatches(room, resource)) return 1;
  const target = Math.max(0.01, Math.min(1, Number(room?.profileCapacityMultiplier) || 1));
  const effect = Math.max(0, Math.min(1, Number(room?.profileEffectFactor) || 0));
  return 1 - ((1 - target) * effect);
}

export function storageEffectiveRowLoad(room = {}, resource = {}, rawLoad = 0) {
  return Math.max(0, Number(rawLoad) || 0) * storageProfileLoadMultiplier(room, resource);
}

export function storageEffectiveShelfLifeMultiplier(room = {}, resource = {}) {
  const target = Math.max(1, Number(room?.shelfLifeMultiplier) || 1);
  const { definition } = definitionFor(resource);
  const genericPerishableFood = target > 1 && isPerishableFoodDefinition({
    ...resource, ...definition, shelfLifeQd: definition?.shelfLifeQd ?? resourceShelfLifeQd(resource)
  });
  if (!storageProfileMatches(room, resource) && !genericPerishableFood) return 1;
  const effect = Math.max(0, Math.min(1, Number(room?.profileEffectFactor) || 0));
  return 1 + ((target - 1) * effect);
}
