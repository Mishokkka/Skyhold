import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { resolveFoodRation } from "../engines/economy/food-rations.js";
import { nutritionBalance } from "../engines/economy/nutrition.js";
import { sellerQualification } from "../engines/workers/seller-qualification.js";
import { minimumStaffStatus } from "../engines/workers/minimum-staff.js";
import { militaryDailyWage } from "../engines/economy/military-wages.js";
import { calculatePlannedWorkerWage, financeBuildingFunctionBlockState } from "../engines/economy/finance-obligations.js";
import { prepareFinancePeriod } from "../engines/economy/finance-period.js";
import { normalizeWorkAllocation } from "../data/work-allocations.js";
import { planLivestockTenday } from "../engines/economy/livestock.js";
import { livestockProfileForSpecies } from "../data/livestock.js";
import { planAgriculturePlot } from "../engines/economy/agriculture.js";
import { appendEconomyLedger, economyLedgerTotals } from "../engines/economy/ledger.js";
import { summarizeEconomyReport } from "../engines/economy/report.js";
import { combineTendayReports } from "../engines/tenday/sequential.js";
import { marketQuotePeriodKey } from "../engines/market/pricing.js";
import { resourceDef } from "../core/resources.js";
import { isPerishableFoodDefinition } from "../core/perishable-food.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { planBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";
import { constructionCapitalBudget, planConstructionCancellation } from "../engines/economy/construction-stages.js";

export function checkApprovedEconomy() {
  const almostFull = resolveFoodRation({ residents: 20, days: 10, available: 199 });
  assert.equal(almostFull.consumeTarget, 199);
  assert.equal(almostFull.achievedUnits, 9.95);
  assert.equal(almostFull.moraleModifier, -0.01);
  let nutrition = nutritionBalance({ days: 10, effectiveUnits: 5 });
  assert.equal(nutrition.chronicHungerLevel, 0, "one sparse tenday is emergency use");
  nutrition = nutritionBalance({ days: 10, effectiveUnits: 5, deficitDays: nutrition.deficitDays });
  assert.equal(nutrition.chronicHungerLevel, 1, "repeated sparse meals cannot be sustained indefinitely");
  assert.equal(nutritionBalance({ days: 10, effectiveUnits: 10, deficitDays: nutrition.deficitDays }).chronicHungerLevel, 0);
  assert.equal(nutritionBalance({ effectiveUnits: 10, eaten: 100, foodGroups: { grain: 99, fruit: 1 } }).diversityBonus, 0);
  assert.equal(nutritionBalance({ effectiveUnits: 10, eaten: 100, foodGroups: { grain: 60, protein: 20, fruit: 20 } }).diversityBonus, 2);
  assert.equal(nutritionBalance({ effectiveUnits: 5, eaten: 100, foodGroups: { grain: 60, protein: 20, fruit: 20 } }).diversityBonus, 0);
  assert.equal(sellerQualification({ attributes: { wits: 3, empathy: 3 } }).efficiency, 1);
  assert.ok(sellerQualification({ attributes: { wits: 5, empathy: 5 }, traits: ["Бережливый", "Грамотный"] }).efficiency >= 2);
  assert.equal(minimumStaffStatus({ workersMin: 2 }, [{ id: "one" }, { id: "one" }]).met, false);
  assert.equal(minimumStaffStatus({ workersMin: 2 }, [{ id: "one" }, { id: "two", dead: true }]).met, false);
  assert.equal(minimumStaffStatus({ workersMin: 2 }, [{ id: "one" }, { id: "two" }]).met, true);

  const assignment = normalizeWorkAllocation({ id: "a", sourceId: "workshop", functionId: "production:a", normalQd: 10, volunteer: true, volunteerReason: "Спасение" });
  assert.equal(assignment.volunteer, true);
  const wage = calculatePlannedWorkerWage({ id: "worker", assignments: [
    { ...assignment, dailyRateCopper: 0 },
    { sourceId: "farm", functionId: "agriculture", normalQd: 10, dailyRateCopper: 12 }
  ] });
  assert.equal(wage.ok, true);
  assert.equal(wage.dueCopper, 60, "free work at one job must not erase or block paid work");
  assert.equal(calculatePlannedWorkerWage({ id: "w", assignments: [{ normalQd: 20, dailyRateCopper: 0 }] }).ok, false);
  const holding = { gm: { defense: { squads: [{ type: "cavalry", sergeantId: "s", memberIds: ["p"] }] } },
    people: { list: [{ id: "s", workAssignment: "soldier" }, { id: "p", workAssignment: "soldier" }] } };
  assert.equal(militaryDailyWage(holding, holding.people.list[0]), 24);
  assert.equal(militaryDailyWage(holding, holding.people.list[1]), 20);
  assert.equal(militaryDailyWage(holding, { workAssignment: "defenseCommander" }), 26);

  const buildings = [{ id: "factory", built: true, functions: [
    { id: "line", active: true, operatingUpkeepMonthlyCopper: 6 },
    { id: "operation", active: true, operatingUpkeepMonthlyCopper: 30 },
    { id: "second", active: true, operatingUpkeepMonthlyCopper: 0 }
  ] }];
  const finance = prepareFinancePeriod({ buildings, treasuryCopper: 100, periodKey: "p1", periodIndex: 1, operationId: "paid" });
  assert.equal(finance.paidCopper, 12, "common ten plus explicit line two, without multiplying the common cost");
  const blocked = prepareFinancePeriod({ buildings, treasuryCopper: 2, periodKey: "p1", periodIndex: 1, operationId: "blocked" });
  assert.equal(blocked.currentObligations.find((row) => row.functionId === "line").paidCopper, 0, "line extras cannot precede common operation");
  assert.equal(financeBuildingFunctionBlockState({ finance: blocked.finance, buildingId: "factory", functionId: "second" }).blocked, true);

  const poultry = livestockProfileForSpecies("poultry");
  const eggArgs = { profile: poultry, seasonId: "spring", seasonKey: "10:spring", operations: { eggs: true }, availableFeedUnits: 100, state: { adults: 3, breedingMales: 0 }, elapsedQd: 40 };
  const full = planLivestockTenday({ ...eggArgs, availableWorkQd: 10 });
  const half = planLivestockTenday({ ...eggArgs, availableWorkQd: 5 });
  assert.ok(Math.abs(half.eggs.outputQty * 2 - full.eggs.outputQty) <= 1, "care scales eggs once, not quadratically");
  let eggState = eggArgs.state;
  let dailyEggs = 0;
  for (let day = 0; day < 10; day++) {
    const result = planLivestockTenday({ ...eggArgs, state: eggState, elapsedQd: 4, availableWorkQd: 1 });
    dailyEggs += result.eggs.outputQty;
    eggState = result.stateAfter;
  }
  assert.equal(dailyEggs, full.eggs.outputQty, "fractional eggs survive period splitting");
  const cattle = livestockProfileForSpecies("cattle");
  const unfed = planLivestockTenday({ profile: cattle, state: { adults: 0, young: [{ id: "y", qty: 1, ageQd: cattle.maturityQd - 1 }] },
    seasonId: "winter", elapsedQd: 40, availableFeedUnits: 0, availableWorkQd: 10 });
  assert.equal(unfed.matured, 0, "young animals cannot grow to maturity without food");

  const crop = { id: "fruit", resourceId: "fruits", outputQty: 10, sowingSeasons: ["spring", "summer"], sowingWorkQd: 2, growingQd: 1,
    harvestWorkQd: 1, annualHarvestLimit: 1, perennial: true, expiryRule: "never" };
  const agriculturalArgs = { crop, operations: { sow: true, harvest: true }, elapsedQd: 3, availableWorkQd: 10 };
  const first = planAgriculturePlot({ ...agriculturalArgs, calendarContextForOffset: () => ({ year: 10, seasonId: "spring" }) });
  assert.equal(first.workQdUsed, 3);
  const second = planAgriculturePlot({ ...agriculturalArgs, state: first.stateAfter, calendarContextForOffset: () => ({ year: 10, seasonId: "summer" }) });
  assert.equal(second.resourceChanges.length, 0, "a second allowed season does not bypass the annual harvest limit");
  const nextYear = planAgriculturePlot({ ...agriculturalArgs, state: second.stateAfter, calendarContextForOffset: () => ({ year: 11, seasonId: "spring" }) });
  assert.equal(nextYear.workQdUsed, 1, "established perennial stock is harvested without paying establishment labor again");

  for (const id of ["milk", "meat", "fish", "vegetables", "grain", "bread"]) assert.equal(isPerishableFoodDefinition(resourceDef(id)), true, id);
  assert.equal(isPerishableFoodDefinition({ category: "luxury", shelfLifeQd: 4 }), false);
  assert.ok(resourceDef("canned-protein").shelfLifeQd > resourceDef("preserved-meat").shelfLifeQd * 2);
  const dateHolding = (day) => ({ gm: { calendaria: { lastDateTime: { year: 7, month: 1, day }, lastDateKey: `7-1-${day}` } } });
  assert.equal(marketQuotePeriodKey(dateHolding(1)), marketQuotePeriodKey(dateHolding(10)));
  assert.notEqual(marketQuotePeriodKey(dateHolding(10)), marketQuotePeriodKey(dateHolding(11)));
  assert.notEqual(marketQuotePeriodKey(dateHolding(6), { quotePeriodDays: 5 }), marketQuotePeriodKey(dateHolding(1), { quotePeriodDays: 5 }));

  const report = { ledger: [] };
  appendEconomyLedger(report, Array.from({ length: 700 }, (_, index) => ({ domain: "politics", kind: "money", qty: 1, id: `row-${index}` })));
  appendEconomyLedger(report, { domain: "treasury", kind: "money", qty: 999, meta: { internalTransfer: true } });
  assert.equal(report.ledger.length, 600);
  assert.equal(report.ledgerCount, 701);
  assert.equal(report.ledgerTruncated, true);
  assert.equal(summarizeEconomyReport(report).ledgerTotals.moneyIn, 700);
  assert.equal(economyLedgerTotals(Array.from({ length: 700 }, () => ({ kind: "money", qty: -2 }))).moneyOut, 1400);
  const combined = combineTendayReports([{ report: { ...report, treasury: { deficit: 10 } } }, { report: { ...report, treasury: { deficit: 15 } } }]);
  assert.equal(combined.ledgerTotals.moneyIn, 1400);
  assert.equal(combined.treasury.deficit, 15, "outstanding debt is a final balance, not a sum of balances");

  const template = structuredClone(DEFAULT_BUILDING_TEMPLATES.find((row) => row.id === "common-house"));
  const project = { ...template, id: "project", templateId: template.id, templateVersion: 16, constructionStatus: "building", lifecycle: "building", buildTarget: 8, buildProgress: 2,
    materialCosts: [{ resourceId: "wood", qty: 80 }], constructionMaterials: { version: 1, mode: "staged", target: 8,
      totalCosts: [{ resourceId: "wood", qty: 80 }], spent: [{ resourceId: "wood", qty: 20 }], prepaidRemaining: [] } };
  const data = { meta: { templateCatalogVersion: 16 }, catalog: { buildings: [template] },
    holdings: [{ id: "home", buildings: { list: [project] }, people: { list: [] }, gm: {} }] };
  const capital = constructionCapitalBudget(data.holdings[0], project);
  assert.equal(capital.spent[0].qty, 20);
  assert.equal(capital.unpaid[0].qty, 60, "capital summary must preserve actual completed material stages");
  const prepaid = constructionCapitalBudget({ storage: { moneyCopper: 100 } }, { buildTarget: 2, buildProgress: 0,
    materialCosts: [{ resourceId: "money", qty: 80 }], materialsAllocated: true });
  assert.equal(prepaid.money, 0, "already prepaid money is not budgeted twice");
  assert.equal(prepaid.treasuryAfterMaterials, 100);
  const initial = planBuildingCatalogMigration({ currentData: data, operationId: "migration" });
  const resolutions = Object.fromEntries(initial.blockingIssues.filter((row) => row.canResolveMechanics).map((row) => [row.resolutionKey, "replace-mechanics"]));
  const migrated = planBuildingCatalogMigration({ currentData: data, operationId: "migration", resolutions }).targetData.holdings[0].buildings.list[0];
  assert.equal(migrated.templateVersion, 19);
  assert.deepEqual(migrated.constructionMaterials.spent.map(({ resourceId, qty }) => ({ resourceId, qty })), project.constructionMaterials.spent);
  const refund = planConstructionCancellation({ holding: data.holdings[0], building: migrated, operationId: "cancel" });
  assert.ok(refund.refund.reduce((sum, row) => sum + row.qty, 0) <= 20, "catalog migration cannot refund unpaid materials");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkApprovedEconomy();
  console.log("Approved economy: nutrition, wages, staffing, livestock, crops, storage, calendar, ledger and material-credit checks passed.");
}
