/** Shared visual identity for a building card and references to that building. */
export function buildingAppearance(building = {}, template = null, categoryIcon = "fa-solid fa-building") {
  return {
    icon: String(building.icon ?? template?.icon ?? categoryIcon).trim() || "fa-solid fa-building",
    img: String(building.img ?? building.image ?? template?.img ?? template?.image ?? "").trim()
  };
}
