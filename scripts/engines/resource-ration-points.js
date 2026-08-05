import { effectiveRationPointsPerUnit } from "../data/resources/resource-economy-contract.js";

function hasOwn(source, key) {
  return Boolean(source && typeof source === "object" && Object.hasOwn(source, key));
}

/**
 * Consumer adapter for the V2 ration contract.
 *
 * Canonical rationPoints keep the contract's definition-first precedence.
 * While neither source has migrated, the merged legacy view preserves the old
 * row-over-catalog foodValue behavior and the contract's edible-name fallback.
 */
export function effectiveConsumerRationPoints(resource = {}, definition = null) {
  if (hasOwn(definition, "rationPoints") || hasOwn(resource, "rationPoints")) {
    return effectiveRationPointsPerUnit(resource, definition);
  }
  return effectiveRationPointsPerUnit({ ...(definition ?? {}), ...resource }, null);
}
