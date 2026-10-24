export const SPECIAL_BUILDING_KINDS = {
  medical: {
    key: "medical",
    label: "Лазарет / лечебное здание",
    icon: "fa-solid fa-kit-medical",
    cssClass: "medical-building",
    workerRole: "Лекарь",
    workersMin: 1,
    workersMax: 3,
    defaultMaxPatients: 15,
    patientsPerEfficiency: 5,
    disablesFunctionToggles: true,
    editorMode: "medical"
  },
  "fasti-shop": {
    key: "fasti-shop",
    label: "Лавка редкостей Фасти ди Ото",
    icon: "fa-solid fa-book-sparkles",
    cssClass: "fasti-shop-building",
    disablesFunctionToggles: true,
    editorMode: "fasti-shop"
  }
};

export function inferBuildingSpecialKind(building = {}) {
  const explicit = String(building?.special?.kind ?? building?.specialKind ?? building?.uniqueKind ?? building?.kind ?? "").trim().toLowerCase();
  if (SPECIAL_BUILDING_KINDS[explicit]) return explicit;
  if (building?.medical?.enabled === true) return "medical";
  const text = `${building?.id ?? ""} ${building?.templateId ?? ""} ${building?.name ?? ""} ${building?.type ?? ""} ${building?.effect ?? ""} ${building?.notes ?? ""}`.toLowerCase();
  if (/fasti-shop|fasti|\u0444\u0430\u0441\u0442\u0438|\u0434\u0438\s+\u043e\u0442\u043e|\u043b\u0430\u0432\u043a\u0430\s+\u0440\u0435\u0434\u043a\u043e\u0441\u0442\u0435\u0439/.test(text)) return "fasti-shop";
  // A workshop's description may mention medicine without offering treatment.
  // Keep compatibility with named medical templates, not arbitrary prose.
  const medicalIds = new Set(["lazaret", "hospital"]);
  if ([building?.id, building?.templateId].some((id) => medicalIds.has(String(id ?? "").toLowerCase()))) return "medical";
  if (["medical", "лечебное", "лечебное здание"].includes(String(building?.type ?? "").trim().toLowerCase())) return "medical";
  return "";
}

export function isSpecialBuilding(building = {}) {
  return Boolean(inferBuildingSpecialKind(building));
}

export function isMedicalBuilding(building = {}) {
  return inferBuildingSpecialKind(building) === "medical";
}
