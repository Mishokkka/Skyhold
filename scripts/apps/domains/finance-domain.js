// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { FinanceEconomyDomain } from "./finance/economy-domain.js";
import { FinanceStorageDomain } from "./finance/storage-domain.js";
import { FinanceTradeDomain } from "./finance/trade-domain.js";
import { FinanceTreasuryDomain } from "./finance/treasury-domain.js";
import { composeDomainGroup } from "./compose-domain.js";

export const FinanceDomain = composeDomainGroup("FinanceDomain", [
  ["FinanceTreasuryDomain", FinanceTreasuryDomain],
  ["FinanceTradeDomain", FinanceTradeDomain],
  ["FinanceStorageDomain", FinanceStorageDomain],
  ["FinanceEconomyDomain", FinanceEconomyDomain]
]);
