import { buildingOperationalState } from "../../core/building-state.js";
import { CONSTRUCTION_CENTER_TEMPLATE_ID } from "../../data/building-development-tree.js";

/**
 * One operational Construction Center can support one selected crew. The
 * existing constructionCrewId field is reused as that selection after the
 * Center is built. Multiple Centers never stack for the same attempt.
 */
export function constructionCenterSuccessBonus(holding = {}, crewId = "") {
  const selectedCrewId = String(crewId ?? "").trim();
  if (!selectedCrewId) return 0;
  const supported = (holding?.buildings?.list ?? []).some((building) => (
    String(building?.templateId ?? building?.id ?? "") === CONSTRUCTION_CENTER_TEMPLATE_ID
    && String(building?.constructionCrewId ?? "") === selectedCrewId
    && buildingOperationalState(building).operational
  ));
  return supported ? 1 : 0;
}
