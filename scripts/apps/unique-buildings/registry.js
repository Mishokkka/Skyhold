import { inferBuildingSpecialKind } from "../../core/building-specials.js";
import { SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";

const registrations = new Map();

function normalizeKind(kind = "") {
  return String(kind ?? "").trim().toLowerCase();
}

export function registerUniqueBuilding(kind, definition = {}) {
  const key = normalizeKind(kind);
  const appClass = typeof definition === "function" ? definition : definition?.appClass;
  if (!key) throw new Error("Unique building kind is required.");
  if (typeof appClass !== "function") throw new Error(`Unique building "${key}" requires an appClass.`);
  const entry = {
    kind: key,
    appClass,
    label: String(definition?.label ?? key),
    source: String(definition?.source ?? "external")
  };
  registrations.set(key, entry);
  return entry;
}

export function unregisterUniqueBuilding(kind, appClass = null) {
  const key = normalizeKind(kind);
  const current = registrations.get(key);
  if (!current || (appClass && current.appClass !== appClass)) return false;
  return registrations.delete(key);
}

export function getUniqueBuildingRegistration(kind) {
  return registrations.get(normalizeKind(kind)) ?? null;
}

export function listUniqueBuildings() {
  return Array.from(registrations.values()).map((entry) => ({ ...entry }));
}

export function resolveUniqueBuilding(building = {}) {
  const kind = inferBuildingSpecialKind(building);
  return kind ? getUniqueBuildingRegistration(kind) : null;
}

export function openUniqueBuilding({ holdingId, buildingId } = {}) {
  const data = SkyholdData.view();
  const { holding } = findReadableHoldingEntry(data, holdingId, { fallback: false });
  const building = (holding?.buildings?.list ?? []).find((item) => String(item?.id ?? "") === String(buildingId ?? ""));
  if (!holding || !building) return null;
  const registration = resolveUniqueBuilding(building);
  if (!registration) return null;
  const app = new registration.appClass({ holdingId: holding.id, buildingId: building.id });
  app.render({ force: true, focus: true });
  return app;
}
