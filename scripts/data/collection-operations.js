import { clearBuildingReferences, clearPersonReferences } from "./normalizers.js";
import { assertAvailableEntityId } from "./entity-identity.js";
import { vacatePoliticsRepresentative } from "./resident-assignments.js";

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
  const removedRow = collection.find((row) => String(row?.id) === String(rowId));
  const nextCollection = collection.filter((row) => String(row?.id) !== String(rowId));
  foundry.utils.setProperty(data, collectionPath, nextCollection);

  if (holding && removedRow && holdingMatch?.[2] === "people.list") {
    clearPersonReferences(holding, rowId);
    vacatePoliticsRepresentative(holding, rowId, "житель удалён из владения");
  }
  if (holding && removedRow && holdingMatch?.[2] === "buildings.list") clearBuildingReferences(holding, removedRow);
}
