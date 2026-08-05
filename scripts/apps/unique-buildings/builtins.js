import { registerUniqueBuilding } from "./registry.js";
import { SkyholdMedicalBuildingApp } from "./medical-app.js";
import { SkyholdFastiShopApp } from "./fasti-shop-app.js";

let installed = false;

export function registerBuiltinUniqueBuildings() {
  if (installed) return;
  installed = true;
  registerUniqueBuilding("medical", {
    appClass: SkyholdMedicalBuildingApp,
    label: "Лазарет / лечебное здание",
    source: "fbl-skyhold"
  });
  registerUniqueBuilding("fasti-shop", {
    appClass: SkyholdFastiShopApp,
    label: "Лавка редкостей Фасти ди Ото",
    source: "fbl-skyhold"
  });
}
