// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { FinanceAgricultureDomain } from "./finance/agriculture-domain.js";
import { FinanceControlsDomain } from "./finance/controls-domain.js";
import { FinanceEconomyDomain } from "./finance/economy-domain.js";
import { FinanceInternalDemandDomain } from "./finance/internal-demand-domain.js";
import { FinanceLivestockDomain } from "./finance/livestock-domain.js";
import { FinanceMaintenanceDomain } from "./finance/maintenance-domain.js";
import { FinanceStorageDomain } from "./finance/storage-domain.js";
import { FinanceTradeDomain } from "./finance/trade-domain.js";
import { FinanceTreasuryDomain } from "./finance/treasury-domain.js";
import { composeDomainGroup } from "./compose-domain.js";

export const FinanceDomain = composeDomainGroup("FinanceDomain", [
  ["FinanceTreasuryDomain", FinanceTreasuryDomain],
  ["FinanceControlsDomain", FinanceControlsDomain],
  ["FinanceTradeDomain", FinanceTradeDomain],
  ["FinanceStorageDomain", FinanceStorageDomain],
  ["FinanceAgricultureDomain", FinanceAgricultureDomain],
  ["FinanceLivestockDomain", FinanceLivestockDomain],
  ["FinanceMaintenanceDomain", FinanceMaintenanceDomain],
  ["FinanceInternalDemandDomain", FinanceInternalDemandDomain],
  ["FinanceEconomyDomain", FinanceEconomyDomain]
]);
