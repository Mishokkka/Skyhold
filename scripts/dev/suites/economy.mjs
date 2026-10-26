import path from "node:path";
import { checkApprovedEconomy } from "../economy-approved-check.mjs";
import { pathToFileURL } from "node:url";
import { checkAgricultureCharacterization } from "../agriculture-characterization-check.mjs";
import { checkConstructionStageCharacterization } from "../construction-stage-characterization-check.mjs";
import { checkEconomyCharacterization } from "../economy-characterization-check.mjs";
import { checkEconomyBalanceScenario } from "../economy-balance-scenario-check.mjs";
import { checkTendayCharacterization } from "../tenday-characterization-check.mjs";
import { checkTimeAdvancement } from "../time-advancement-check.mjs";
import { checkFoodBatchCharacterization } from "../food-batch-characterization-check.mjs";
import { checkFinanceRuntimeCharacterization } from "../finance-runtime-characterization-check.mjs";
import { checkFinanceControlsCharacterization } from "../finance-controls-characterization-check.mjs";
import { checkLivestockCharacterization } from "../livestock-characterization-check.mjs";
import { checkLivestockRuntimeCharacterization } from "../livestock-runtime-characterization-check.mjs";
import { checkMaintenanceCharacterization } from "../maintenance-characterization-check.mjs";
import { checkReputationCharacterization } from "../reputation-characterization-check.mjs";
import { checkShipContractsCharacterization } from "../ships-contracts-characterization-check.mjs";
import { checkWorldShipMarketCharacterization } from "../world-ship-market-characterization-check.mjs";
import { checkWorldShipCharacterization } from "../world-ship-characterization-check.mjs";
import { checkShipCrewPresenceCharacterization } from "../ship-crew-presence-characterization-check.mjs";
import { checkPoliticsPeriod } from "../politics-period-check.mjs";
import { checkPoliticsRegressions } from "../politics-regression-check.mjs";
import { checkPoliticsProduction } from "../politics-production-check.mjs";
import { checkPoliticsCompletion } from "../politics-completion-check.mjs";

import { checkEconomyPeriodBoundaries } from "../economy-period-boundaries-check.mjs";

import { checkBankCharacterization } from "../bank-characterization-check.mjs";
import { checkSharedMarkets } from "../shared-market-check.mjs";
import { checkMarketCargoAging } from "../market-cargo-aging-check.mjs";
import { checkMarketAuditFixes } from "../market-audit-fixes-check.mjs";
import { checkMarketDemandCharacterization } from "../market-demand-characterization-check.mjs";
import { checkMarketRouteSelection } from "../market-route-selection-check.mjs";
import { checkShipCapacityConsistency } from "../ship-capacity-consistency-check.mjs";

import { checkProductionReview } from "../production-review-regression-check.mjs";
import { checkProductionCapacity } from "../production-capacity-check.mjs";
import { checkProductionTime } from "../production-time-check.mjs";
import { checkProductionWorkerBudgets } from "../production-worker-budget-check.mjs";
import { checkInternalDemandCharacterization } from "../internal-demand-characterization-check.mjs";
import { checkPreparationYear } from "../economy-preparation-year-check.mjs";
import { checkPreparationSpecializations } from "../economy-preparation-specialization-check.mjs";
import { checkMaintenanceProposal } from "../building-maintenance-proposal-check.mjs";
import { checkPreparationRevision } from "../building-preparation-revision-check.mjs";
import { checkArrivalProposal } from "../newcomer-arrival-proposal-check.mjs";

/** Runs economy, production, market, ship and politics contracts without mutating a live Foundry world. */
export async function runEconomySuite() {
  checkInternalDemandCharacterization();
  checkPreparationYear();
  checkPreparationSpecializations();
  checkMaintenanceProposal();
  checkPreparationRevision();
  checkArrivalProposal();
  await checkBankCharacterization();
  checkSharedMarkets();
  checkMarketCargoAging();
  await checkMarketAuditFixes();
  checkMarketDemandCharacterization();
  checkMarketRouteSelection();
  await checkShipCapacityConsistency();
  checkEconomyPeriodBoundaries();
  checkApprovedEconomy();
  await checkProductionReview();
  await checkProductionTime();
  await checkProductionWorkerBudgets();
  await checkProductionCapacity();
  checkAgricultureCharacterization();
  await checkConstructionStageCharacterization();
  checkFoodBatchCharacterization();
  checkLivestockCharacterization();
  checkLivestockRuntimeCharacterization();
  await checkMaintenanceCharacterization();
  await checkFinanceRuntimeCharacterization();
  await checkFinanceControlsCharacterization();
  await checkEconomyCharacterization();
  checkReputationCharacterization();
  checkEconomyBalanceScenario();
  checkTendayCharacterization();
  await checkTimeAdvancement();
  checkPoliticsPeriod();
  await checkPoliticsRegressions();
  await checkPoliticsProduction();
  await checkPoliticsCompletion();
  await checkShipContractsCharacterization();
  checkWorldShipMarketCharacterization();
  checkWorldShipCharacterization();
  checkShipCrewPresenceCharacterization();
  return { suite: "economy" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runEconomySuite();
  console.log("FBL Skyhold suite: economy passed.");
}
