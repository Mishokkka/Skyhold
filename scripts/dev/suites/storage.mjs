import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkSplitStorageCharacterization } from "../split-storage-characterization-check.mjs";
import { checkStorageBatchCharacterization } from "../storage-batch-characterization-check.mjs";
import { checkStorageCharacterization } from "../storage-characterization-check.mjs";
import { checkStorageOperationCharacterization } from "../storage-operation-characterization-check.mjs";
import { checkFoodBatchCharacterization } from "../food-batch-characterization-check.mjs";
import { checkTransactionScopeCharacterization } from "../transaction-scope-characterization-check.mjs";
import { checkBuildingEditorPersistence } from "../building-editor-persistence-check.mjs";
import { checkReadOnlyViewCharacterization } from "../read-only-view-characterization-check.mjs";
import { checkShipRuntimeCharacterization } from "../ships-runtime-characterization-check.mjs";
import { checkShipWorldAuthorityCharacterization } from "../ships-world-authority-check.mjs";
import { checkPoliticsOperation } from "../politics-operation-check.mjs";
import { checkPoliticsBalance } from "../politics-balance-check.mjs";
import { checkUiOwnership } from "../ui-ownership-characterization-check.mjs";
import { checkControlTab } from "../control-tab-check.mjs";

export async function runStorageSuite() {
  checkStorageCharacterization();
  checkFoodBatchCharacterization();
  await checkStorageOperationCharacterization();
  await checkStorageBatchCharacterization();
  await checkSplitStorageCharacterization();
  checkTransactionScopeCharacterization();
  await checkBuildingEditorPersistence();
  checkReadOnlyViewCharacterization();
  await checkShipRuntimeCharacterization();
  await checkShipWorldAuthorityCharacterization();
  await checkPoliticsOperation();
  await checkPoliticsBalance();
  await checkControlTab();
  await checkUiOwnership();
  return { suite: "storage" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runStorageSuite();
  console.log("FBL Skyhold suite: storage passed.");
}
