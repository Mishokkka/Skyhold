import { runCombatSuite } from "./suites/combat.mjs";
import { runDataSuite } from "./suites/data.mjs";
import { runEconomySuite } from "./suites/economy.mjs";
import { runRepositoryContracts } from "./suites/repository-contracts.mjs";
import { runStorageSuite } from "./suites/storage.mjs";
import { runStructureSuite } from "./suites/structure.mjs";
import { runUiContractSuite } from "./suites/ui-contract.mjs";
import { runHybridLaborSuite } from "./suites/hybrid-labor.mjs";
import { checkBuildingContextCharacterization } from "./building-context-characterization-check.mjs";

async function run() {
  runStructureSuite();
  runUiContractSuite();
  await runRepositoryContracts();
  await runEconomySuite();
  await runStorageSuite();
  await runDataSuite();
  runCombatSuite();
  await checkBuildingContextCharacterization();
  await runHybridLaborSuite();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
