// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { BuildingDevelopmentDomain } from "./building/development-domain.js";
import { BuildingMetaDomain } from "./building/meta-domain.js";
import { BuildingProductionDomain } from "./building/production-domain.js";
import { BuildingRowsDomain } from "./building/rows-domain.js";
import { BuildingWorkerDomain } from "./building/worker-domain.js";

export const BuildingDomain = {
  ...BuildingMetaDomain,
  ...BuildingWorkerDomain,
  ...BuildingProductionDomain,
  ...BuildingDevelopmentDomain,
  ...BuildingRowsDomain
};
