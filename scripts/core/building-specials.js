export const SPECIAL_BUILDING_KINDS = {
  medical: {
    key: "medical",
    label: "Лазарет / лечебное здание",
    icon: "fa-solid fa-kit-medical",
    cssClass: "medical-building",
    workerRole: "Лекарь",
    workerPrimaryAttribute: "empathy",
    workersMin: 1,
    workersMax: 3,
    defaultMaxPatients: 15,
    patientsPerEfficiency: 5,
    disablesFunctionToggles: true,
    editorMode: "medical"
  }
};

export function inferBuildingSpecialKind(building = {}) {
  const explicit = String(building?.special?.kind ?? building?.specialKind ?? building?.uniqueKind ?? building?.kind ?? "").trim().toLowerCase();
  if (SPECIAL_BUILDING_KINDS[explicit]) return explicit;
  if (building?.medical?.enabled === true) return "medical";
  const text = `${building?.id ?? ""} ${building?.templateId ?? ""} ${building?.name ?? ""} ${building?.type ?? ""} ${building?.effect ?? ""} ${building?.notes ?? ""}`.toLowerCase();
  if (/lazaret|лазарет|леч|медиц|больн|госпит|карантин/.test(text)) return "medical";
  return "";
}

export function getSpecialBuildingDefinition(building = {}) {
  const kind = inferBuildingSpecialKind(building);
  return kind ? SPECIAL_BUILDING_KINDS[kind] : null;
}

export function isSpecialBuilding(building = {}) {
  return Boolean(inferBuildingSpecialKind(building));
}

export function isMedicalBuilding(building = {}) {
  return inferBuildingSpecialKind(building) === "medical";
}
