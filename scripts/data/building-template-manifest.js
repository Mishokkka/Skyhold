// Canonical v19 catalog. Earlier tables are retained as migration/generation input.
import { buildingCatalogV19Templates } from "./building-template-revision-v19.js";

export const APPROVED_BUILDING_TEMPLATE_MANIFEST_VERSION = 6;
export const APPROVED_BUILDING_TEMPLATE_MANIFEST = Object.freeze(buildingCatalogV19Templates()
  .filter((row) => !["fasti-shop", "laputa-excavated-crypt"].includes(row.id)));
