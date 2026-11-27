import { clearPersonReferences } from "./normalizers.js";
import { assertAvailableEntityId } from "./entity-identity.js";
import { vacatePoliticsRepresentative } from "./resident-assignments.js";
import { applyBuildingDemolition, planBuildingDemolition } from "./building-demolition.js";

export function addCollectionRow(data, collectionPath, row) {
  const collection = foundry.utils.getProperty(data, collectionPath);

  if (!Array.isArray(collection)) {
    throw new Error(`FBL Skyhold | Collection is not an array: ${collectionPath}`);
  }

  assertAvailableEntityId(collection, row?.id);
  collection.push(row);
}

export function deleteCollectionRow(data, collectionPath, rowId) {
  const collection = foundry.utils.getProperty(data, collectionPath);

  if (!Array.isArray(collection)) {
    throw new Error(`FBL Skyhold | Collection is not an array: ${collectionPath}`);
  }

  const holdingMatch = collectionPath.match(/^holdings\.(\d+)\.(people\.list|buildings\.list)$/);
  const holding = holdingMatch ? data.holdings[Number(holdingMatch[1])] : null;
  if (holding && holdingMatch?.[2] === "buildings.list") {
    const plan = planBuildingDemolition(holding, rowId, data.meta?.transportV2);
    if (plan) {
      const result = applyBuildingDemolition(holding, plan);
      if (!result.ok) throw new Error(result.message);
    }
    return;
  }
  const removedRow = collection.find((row) => String(row?.id) === String(rowId));
  const nextCollection = collection.filter((row) => String(row?.id) !== String(rowId));
  foundry.utils.setProperty(data, collectionPath, nextCollection);

  if (holding && removedRow && holdingMatch?.[2] === "people.list") {
    clearPersonReferences(holding, rowId);
    vacatePoliticsRepresentative(holding, rowId, "житель удалён из владения");
  }
}
