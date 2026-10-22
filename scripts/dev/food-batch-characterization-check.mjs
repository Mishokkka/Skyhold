import assert from "node:assert/strict";
import {
  addResourceBatches,
  beginResourceBatchPeriod,
  compactResourceBatches,
  finishResourceBatchPeriod,
  availableResourceBatchInventory,
  availableResourceRowQuantity,
  internalDemandBatchClockQd,
  isResourceBatchPeriodActive,
  nextInternalDemandBatchAvailabilityQd,
  resourceBatchAvailableToInternalDemand,
  resourceBatchTotal,
  splitResourceBatchParts,
  syncResourceRowBatches,
  takeResourceBatchById,
  takeResourceBatches
} from "../core/resource-batches.js";
import {
  normalizeResourceId,
  normalizeResourceRow,
  resourceDef,
  resourceLabel
} from "../core/resources.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { clone } from "../data/utils.js";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { FinanceAgricultureDomain } from "../apps/domains/finance/agriculture-domain.js";
import { FinanceInternalDemandDomain } from "../apps/domains/finance/internal-demand-domain.js";
import { FinanceLivestockDomain } from "../apps/domains/finance/livestock-domain.js";
import { runFoodConsumption } from "../engines/economy/food-consumption.js";
import { foodRationTierLabel, normalizeFoodRationUnits, resolveFoodRation } from "../engines/economy/food-rations.js";
import {
  applySettlementHunger,
  hungerLevelForShortage,
  hungerPenaltyFactor,
  normalizeHungerLevel,
  settlementHungerFactor
} from "../engines/economy/hunger.js";
import {
  beginPerishableStoragePeriod,
  finishPerishableStoragePeriod,
  perishableStorageExpiresInQd
} from "../engines/economy/perishable-storage.js";
import { planStorageCosts } from "../engines/storage/group-payment.js";
import { addStorageWithOverflow } from "../engines/storage/placement.js";
import { storageProfileLoadMultiplier, storageProfileMatches } from "../engines/storage/specialization.js";

const foodDependencies = {
  safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  normalizeResourceId,
  resourceDef,
  resourceLabel,
  normalizeFoodRationUnits,
  resolveFoodRation,
  foodRationTierLabel,
  isResourceBatchPeriodActive,
  syncResourceRowBatches,
  availableResourceRowQuantity,
  availableResourceBatchInventory,
  takeResourceBatchById,
  applySettlementHunger,
  hungerPenaltyFactor,
  normalizeHungerLevel,
  formatNumber: (value) => String(value),
  appendLedger: (report, entries) => {
    if (!Array.isArray(report.ledger)) report.ledger = [];
    report.ledger.push(...(Array.isArray(entries) ? entries : [entries]));
  }
};

function foodReport() {
  return { ledger: [], food: { needed: 0, eaten: 0, hungryResidentDays: 0, availableBeforeConsumption: 0, lines: [] } };
}

function preparedRow(id, resourceId, roomId, batches) {
  return {
    id,
    resourceId,
    name: resourceLabel(resourceId),
    roomId,
    batches: clone(batches),
    qty: resourceBatchTotal(batches)
  };
}

export function checkFoodBatchCharacterization() {
  const arsenalProfile = {
    profileCategoryTags: ["armament"],
    profileCapacityMultiplier: 0.5,
    profileEffectFactor: 1
  };
  assert.equal(storageProfileMatches(arsenalProfile, { resourceId: "armament-simple" }), true, "an Arsenal profile must recognize every Armament tier by category");
  assert.equal(storageProfileLoadMultiplier(arsenalProfile, { resourceId: "armament-simple" }), 0.5, "compatible specialized cargo must occupy half capacity");
  assert.equal(storageProfileLoadMultiplier(arsenalProfile, { resourceId: "stone" }), 1, "incompatible cargo remains allowed but occupies full capacity");
  assert.equal(storageProfileLoadMultiplier({ ...arsenalProfile, profileEffectFactor: 0.5 }, { resourceId: "armament-simple" }), 0.75, "maintenance debt must halve the profile advantage rather than physical capacity");
  assert.equal(normalizeHungerLevel(3.9), 3, "Hunger must persist as a whole level");
  assert.equal(hungerLevelForShortage({ hungryResidentDays: 4, livingCount: 2 }), 2, "shortage severity must be measured as hungry days per living resident");
  assert.equal(hungerLevelForShortage({ hungryResidentDays: 99, livingCount: 2 }), 10, "Hunger must be capped at ten levels");
  assert.equal(hungerPenaltyFactor(4), 0.8, "each Hunger level must reduce worker efficiency and satisfaction by five percent");
  assert.equal(hungerPenaltyFactor(99), 0.5, "Hunger efficiency must never fall below fifty percent");
  assert.equal(mergeHoldingDefaults({ id: "hunger-default" }).gm.food.hungerLevel, 0, "holdings without Hunger state must normalize to zero");
  assert.equal(mergeHoldingDefaults({ id: "hunger-clamp", gm: { food: { hungerLevel: 99.8 } } }).gm.food.hungerLevel, 10, "persisted Hunger must clamp to the canonical range");
  for (const [id, shelfLifeQd] of [
    ["grain", 1440], ["flour", 240], ["meat", 20], ["milk", 8], ["fruits", 40], ["vegetables", 80], ["honey", 0],
    ["bread", 40], ["food-protein", 40], ["food-dairy", 80], ["food-fruit", 80]
  ]) assert.equal(resourceDef(id)?.shelfLifeQd, shelfLifeQd, `${id} shelf life must remain an explicit catalog value in QD`);
  for (const [id, basePriceCopper, loadPoints] of [
    ["bread", 6, 1], ["food-dairy", 7, 1], ["food-fruit", 8, 1], ["food-protein", 10, 1]
  ]) {
    assert.equal(resourceDef(id)?.basePriceCopper, basePriceCopper, `${id} must retain its approved canonical wholesale price`);
    assert.equal(resourceDef(id)?.loadPoints, loadPoints, `${id} must retain a canonical storage load`);
  }
  for (const id of ["grain", "flour", "fruits", "honey", "meat", "milk", "vegetables"]) {
    assert.equal(resourceDef(id)?.loadPoints, 1, `${id} must use the shared quarter-load food scale`);
  }
  const legacy = normalizeResourceRow({ id: "legacy", resourceId: "bread", qty: 3.9 });
  const legacyAgain = normalizeResourceRow({ id: "legacy", resourceId: "bread", qty: 3.9 });
  assert.equal(legacy.qty, 3, "legacy aggregate quantity must become a whole batch");
  assert.deepEqual(legacy.batches.map(({ qty, ageQd }) => ({ qty, ageQd })), [{ qty: 3, ageQd: 0 }]);
  assert.equal(legacy.batches[0].id, legacyAgain.batches[0].id, "legacy batch ids must be deterministic across normalization for outbound preflight");
  const generated = { id: "generated-row", resourceId: "bread", name: "Bread", roomId: "outdoors", qty: 0, batches: [] };
  addResourceBatches(generated, { qty: 2 }, { makeId: () => "generated-batch-id" });
  const generatedAgain = normalizeResourceRow(generated);
  assert.equal(generatedAgain.batches[0].id, "generated-batch-id", "a generated batch id must persist unchanged through normalization");
  const deferred = normalizeResourceRow({
    id: "deferred",
    resourceId: "bread",
    batches: [{ id: "market-arrival", qty: 2, ageQd: 0, internalDemandAvailableFromQd: 40 }]
  });
  assert.equal(deferred.batches[0].internalDemandAvailableFromQd, 40, "market-arrival availability must survive canonical resource normalization");
  assert.equal(internalDemandBatchClockQd({ gm: { calendaria: { lastQd: 0 } } }), 0);
  assert.equal(nextInternalDemandBatchAvailabilityQd({ gm: { calendaria: { lastQd: 0 } } }), 40);
  assert.equal(resourceBatchAvailableToInternalDemand(deferred.batches[0], { gm: { calendaria: { lastQd: 0 } } }), false);
  assert.equal(resourceBatchAvailableToInternalDemand(deferred.batches[0], { gm: { calendaria: { lastQd: 40 } } }), true);
  assert.equal(splitResourceBatchParts(deferred.batches, 1).batches[0].internalDemandAvailableFromQd, 40, "partial placement must preserve the cooldown boundary");
  const conservativeMerge = compactResourceBatches([
    { id: "eligible", qty: 1, ageQd: 0 },
    { id: "deferred", qty: 1, ageQd: 0, internalDemandAvailableFromQd: 40 }
  ], { maxBatches: 1 });
  assert.equal(conservativeMerge[0].internalDemandAvailableFromQd, 40, "batch compaction must never unlock deferred market cargo early");
  const explicitlyEmpty = normalizeResourceRow({ id: "spoiled", resourceId: "bread", qty: 99, batches: [] });
  assert.equal(explicitlyEmpty.qty, 0, "an explicit empty batch list must not resurrect stale aggregate quantity");

  const nine = Array.from({ length: 9 }, (_value, index) => ({ id: `b${index}`, qty: 1, ageQd: index * 10 }));
  const compacted = compactResourceBatches(nine);
  assert.equal(compacted.length, 8, "a resource and room may persist at most eight batches");
  assert.equal(resourceBatchTotal(compacted), 9, "batch compaction must conserve whole quantity");
  assert.equal(compacted.find((batch) => batch.id === "b8")?.qty, 2, "the closest-age overflow pair must merge deterministically");
  assert.equal(compacted.find((batch) => batch.id === "b8")?.ageQd, 80, "a merged batch must keep the older age");

  const reservedHolding = {
    special: { market: { outbound: { orders: [{
      status: "booked",
      dispatchStatus: "booked",
      cargoReservations: [{ resourceId: "bread", rowId: "reserved-row", batchId: "reserved", qty: 1 }]
    }] } } },
    storage: { resources: [preparedRow("reserved-row", "bread", "outdoors", [
      { id: "reserved", qty: 1, ageQd: 0 },
      ...Array.from({ length: 7 }, (_value, index) => ({ id: `far-${index}`, qty: 1, ageQd: 100 + (index * 100) }))
    ])] }
  };
  addResourceBatches(reservedHolding.storage.resources[0], { qty: 1, ageQd: 1 }, { holding: reservedHolding });
  assert.equal(reservedHolding.storage.resources[0].batches.length, 8);
  assert.equal(reservedHolding.storage.resources[0].batches.find((batch) => batch.id === "reserved")?.qty, 2, "compaction must preserve a booked outbound batch id when merging its closest unreserved neighbour");
  const reservedSpend = takeResourceBatches(reservedHolding.storage.resources[0], 8, { holding: reservedHolding });
  assert.equal(reservedSpend.shortfall, 0);
  assert.equal(reservedHolding.storage.resources[0].batches.find((batch) => batch.id === "reserved")?.qty, 1, "ordinary FIFO spending must leave the soft-reserved quantity in place");
  const normalizedReserved = mergeHoldingDefaults({
    ...clone(BASE_HOLDING),
    id: "reserved-normalization",
    special: clone(reservedHolding.special),
    storage: {
      ...clone(BASE_HOLDING.storage),
      resources: [preparedRow("reserved-row", "bread", "outdoors", [
        { id: "reserved", qty: 1, ageQd: 0 },
        { id: "new-neighbour", qty: 1, ageQd: 1 },
        ...Array.from({ length: 7 }, (_value, index) => ({ id: `normal-far-${index}`, qty: 1, ageQd: 100 + (index * 100) }))
      ])]
    }
  });
  assert.equal(normalizedReserved.storage.resources[0].batches.length, 8);
  assert.equal(normalizedReserved.storage.resources[0].batches.some((batch) => batch.id === "reserved"), true, "holding normalization must not invalidate a booked outbound batch id during max-eight compaction");
  const duplicateReserved = mergeHoldingDefaults({
    ...clone(BASE_HOLDING),
    id: "duplicate-reserved-normalization",
    special: { market: { outbound: { orders: [{
      status: "booked",
      dispatchStatus: "booked",
      cargoReservations: [{ resourceId: "bread", rowId: "duplicate-row", batchId: "duplicate-reserved", qty: 1 }]
    }] } } },
    storage: { resources: [
      preparedRow("canonical-row", "bread", "outdoors", [{ id: "canonical-batch", qty: 1, ageQd: 0 }]),
      preparedRow("duplicate-row", "bread", "outdoors", [{ id: "duplicate-reserved", qty: 1, ageQd: 10 }])
    ] }
  });
  assert.equal(duplicateReserved.storage.resources.length, 1, "normalization must continue consolidating duplicate resource-room rows");
  assert.equal(duplicateReserved.special.market.outbound.orders[0].cargoReservations[0].rowId, "canonical-row", "duplicate-row consolidation must remap outbound reservations to the surviving storage row");
  assert.equal(duplicateReserved.storage.resources[0].batches.some((batch) => batch.id === "duplicate-reserved"), true, "duplicate-row consolidation must preserve the reserved batch id");

  const fifo = preparedRow("fifo", "bread", "outdoors", [
    { id: "fresh", qty: 4, ageQd: 0 },
    { id: "old", qty: 3, ageQd: 30 }
  ]);
  const fifoReceipt = takeResourceBatches(fifo, 5);
  assert.deepEqual(fifoReceipt.batches.map(({ id, qty, ageQd }) => ({ id, qty, ageQd })), [
    { id: "old", qty: 3, ageQd: 30 },
    { id: "fresh", qty: 2, ageQd: 0 }
  ], "FIFO spending must take the oldest stock first without changing its age");
  assert.deepEqual(fifo.batches.map(({ id, qty, ageQd }) => ({ id, qty, ageQd })), [{ id: "fresh", qty: 2, ageQd: 0 }]);

  const periodHolding = clone(BASE_HOLDING);
  periodHolding.buildings.list = [{
    id: "cellar",
    name: "Погреб",
    constructionStatus: "built",
    functions: { storage: true },
    storage: { capacity: 100, shelfLifeMultiplier: 2 }
  }];
  periodHolding.storage.resources = [
    preparedRow("cellar-bread", "bread", "cellar", [{ id: "cellar-old", qty: 6, ageQd: 20 }]),
    preparedRow("outdoor-bread", "bread", "outdoors", [{ id: "outdoor-old", qty: 2, ageQd: 20 }])
  ];
  assert.equal(perishableStorageExpiresInQd(periodHolding, periodHolding.storage.resources[0], 20), 60, "an operational cellar must extend a perishable batch's effective remaining shelf life");
  assert.equal(perishableStorageExpiresInQd(periodHolding, periodHolding.storage.resources[1], 20), 20, "outdoor stock must use base shelf life");
  periodHolding.finance.buildingStates.cellar = { mothballed: true };
  assert.equal(perishableStorageExpiresInQd(periodHolding, periodHolding.storage.resources[0], 20), 20, "a mothballed cellar must not extend shelf life");
  periodHolding.finance.buildingStates.cellar = { mothballed: false };
  assert.equal(perishableStorageExpiresInQd(periodHolding, { resourceId: "custom", categoryTag: "luxury", shelfLifeQd: 1, roomId: "cellar" }, 0), Number.POSITIVE_INFINITY, "off-category stock must not enter perishable urgency sorting");
  beginPerishableStoragePeriod(periodHolding);
  addResourceBatches(periodHolding.storage.resources[0], { qty: 2 }, { holding: periodHolding });
  const eatenOld = takeResourceBatches(periodHolding.storage.resources[0], 4, { holding: periodHolding });
  assert.equal(eatenOld.batches[0].id, "cellar-old");
  const spoilReport = foodReport();
  const spoil = finishPerishableStoragePeriod({ holding: periodHolding, elapsedQd: 40, report: spoilReport });
  assert.equal(spoil.expiredQty, 2, "unprotected bread reaching its shelf life must be lost completely");
  assert.deepEqual(periodHolding.storage.resources[0].batches.map(({ qty, ageQd }) => ({ qty, ageQd })), [
    { qty: 2, ageQd: 60 },
    { qty: 2, ageQd: 0 }
  ], "cellar protection must age old residual stock while keeping current-period arrivals at age zero");
  assert.equal(periodHolding.storage.resources[1].qty, 0, "expired batches must leave no hidden aggregate stock");

  const offCategory = { storage: { resources: [preparedRow("luxury", "custom", "cellar", [{ id: "luxury-old", qty: 1, ageQd: 0 }])] } };
  beginResourceBatchPeriod(offCategory);
  const offCategorySpoil = finishResourceBatchPeriod(offCategory, {
    elapsedQd: 2,
    shelfLifeQdForRow: () => 2,
    categoryTagForRow: () => "luxury",
    roomMultiplierForRow: () => 10
  });
  assert.equal(offCategorySpoil.expiredQty, 1, "storage multipliers must not protect off-category goods");

  const rationHolding = clone(BASE_HOLDING);
  rationHolding.gm.food.rationUnitsPerResident = 15;
  rationHolding.people.list = [{ id: "one" }, { id: "two" }];
  rationHolding.storage.resources = [
    preparedRow("bread", "bread", "outdoors", [{ id: "bread-batch", qty: 10, ageQd: 5 }]),
    preparedRow("protein", "food-protein", "outdoors", [{ id: "protein-batch", qty: 15, ageQd: 20 }])
  ];
  const rationReport = foodReport();
  const ration = runFoodConsumption({ holding: rationHolding, qd: 40, report: rationReport, dependencies: foodDependencies });
  assert.equal(ration.effectiveTier, "normal", "an unaffordable enhanced ration must fall back to normal");
  assert.equal(ration.eaten, 25, "partial enhanced rations must consume the available food instead of rounding down to a tier");
  assert.equal(ration.rationModifier, 0.5);
  assert.equal(ration.diversityBonus, 1);
  assert.equal(ration.hungryResidentDays, 0, "fallback above the sparse threshold must not cause Hunger");
  assert.equal(rationHolding.storage.resources[0].qty, 0, "all available food is needed for the partial ration");
  assert.equal(rationHolding.storage.resources[1].qty, 0);
  assert.deepEqual(ration.dietTypes, ["protein", "grain"], "report consumed food groups");

  const hungerHolding = clone(BASE_HOLDING);
  hungerHolding.people.list = [{ id: "one" }, { id: "two" }];
  hungerHolding.storage.resources = [preparedRow("bread", "bread", "outdoors", [{ id: "short", qty: 8, ageQd: 0 }])];
  const hunger = runFoodConsumption({ holding: hungerHolding, qd: 40, report: foodReport(), dependencies: foodDependencies });
  assert.equal(hunger.effectiveTier, "hunger");
  assert.equal(hunger.eaten, 8);
  assert.equal(hunger.hungryResidentDays, 4, "Hunger must begin only below five ration units per resident");
  assert.equal(hungerHolding.gm.food.hungerLevel, 2, "an underfed tenday must persist the common Hunger level");
  assert.equal(hunger.hungerFactor, 0.9, "the food result must expose the resulting production and satisfaction factor");

  const efficiencyOwner = {
    _workerType: () => "",
    _workerTypeEffectForPerson: () => ({ value: 0 }),
    _workerTraitEffect: () => ({ value: 0 }),
    _workerBackgroundEffect: () => ({ value: 0 }),
    _buildingEfficiencyModifier: () => ({ value: 0 })
  };
  assert.equal(
    FinanceEconomyDomain._personBuildingEfficiency.call(efficiencyOwner, hungerHolding, {}, { id: "worker" }),
    0.9,
    "persisted Hunger must reduce worker production efficiency"
  );
  const demandConfig = {
    moraleScale: 40,
    minimumSatisfactionFactor: 0.5,
    maximumSatisfactionFactor: 1.5,
    satisfactionOverrideFactor: null
  };
  assert.equal(
    FinanceInternalDemandDomain._internalDemandSatisfactionFactor.call({ _calculatePersonMorale: () => ({ total: 0 }) }, hungerHolding, demandConfig),
    0.9,
    "persisted Hunger must reduce satisfaction and the population demand pool"
  );
  assert.equal(settlementHungerFactor(hungerHolding), 0.9);
  const seasonalOwner = {
    _agricultureWorkUnitsPerQd: FinanceAgricultureDomain._agricultureWorkUnitsPerQd,
    _activeAssignedBuildingPeople: () => [{ id: "worker" }],
    _personDailyWorkQdLimit: () => 2,
    _maintenanceEfficiencyFactor: () => 1
  };
  assert.equal(
    FinanceAgricultureDomain._agricultureAvailableWorkQd.call(seasonalOwner, hungerHolding, {}, 40),
    18,
    "Hunger must reduce effective agriculture QD"
  );
  assert.equal(
    FinanceLivestockDomain._livestockAvailableWorkQd.call(seasonalOwner, hungerHolding, {}, 40),
    18,
    "Hunger must reduce effective livestock QD"
  );

  hungerHolding.storage.resources = [preparedRow("recovery", "bread", "outdoors", [{ id: "recovery-batch", qty: 20, ageQd: 0 }])];
  const recovery = runFoodConsumption({ holding: hungerHolding, qd: 40, report: foodReport(), dependencies: foodDependencies });
  assert.equal(recovery.effectiveTier, "normal", "normal food supports recovery from accumulated underfeeding");
  assert.equal(hungerHolding.gm.food.hungerLevel, 0, "an adequate normal ration must clear this short deficit");
  assert.equal(recovery.hungerFactor, 1);

  const rawFoodHolding = clone(BASE_HOLDING);
  rawFoodHolding.people.list = [{ id: "one" }, { id: "two" }];
  rawFoodHolding.storage.resources = [preparedRow("raw-grain", "grain", "outdoors", [{ id: "grain-batch", qty: 10, ageQd: 0 }])];
  const rawFoodResult = runFoodConsumption({ holding: rawFoodHolding, qd: 40, report: foodReport(), dependencies: foodDependencies });
  assert.equal(rawFoodResult.eaten, 0, "raw food resources must not become settlement rations");
  assert.equal(rawFoodHolding.storage.resources[0].qty, 10, "raw ingredients must remain untouched by automatic food consumption");
  assert.equal(rawFoodHolding.gm.food.hungerLevel, 10, "raw ingredients alone must still produce the full food-shortage penalty");

  const paymentHolding = { storage: { resources: [
    preparedRow("mixed", "wood", "outdoors", [
      { id: "wood-old", qty: 1, ageQd: 100 },
      { id: "wood-fresh", qty: 10, ageQd: 0 }
    ]),
    preparedRow("middle", "fuel-solid", "outdoors", [{ id: "fuel-middle", qty: 2, ageQd: 50 }])
  ], moneyCopper: 0 } };
  const payment = planStorageCosts({
    holding: paymentHolding,
    costs: [{ resourceGroup: "fuel", qty: 3 }],
    dependencies: {
      safeNumber: foodDependencies.safeNumber,
      isMoneyResource: () => false,
      storageResourceMatches: () => false,
      resourceMatchesGroup: () => true,
      normalizeRoomId: (value) => String(value || "outdoors"),
      resourceBatches: (row) => clone(row.batches)
    }
  });
  assert.deepEqual(payment.costs.map(({ resourceId, qty }) => ({ resourceId, qty })), [
    { resourceId: "wood", qty: 1 },
    { resourceId: "fuel-solid", qty: 2 }
  ], "group payment must plan globally oldest batches before fresh stock in the same row");

  const placementHolding = { storage: { resources: [] } };
  const transfer = [
    { id: "transfer-old", qty: 2, ageQd: 20 },
    { id: "transfer-new", qty: 2, ageQd: 5 }
  ];
  addStorageWithOverflow({
    holding: placementHolding,
    resource: { resourceId: "bread", name: "Bread", roomId: "pantry", batches: transfer },
    qty: 4,
    dependencies: {
      safeNumber: foodDependencies.safeNumber,
      normalizeResourceId,
      isMoneyResource: () => false,
      normalizeStorageRoomId: (value) => String(value || "outdoors"),
      storageRooms: () => [
        { id: "pantry", available: true, unlimited: false, capacity: 2, used: 0 },
        { id: "outdoors", available: true, unlimited: true, capacity: 0, used: 0 }
      ],
      storageUnitLoad: () => 1,
      storageProfileLoadMultiplier: () => 1,
      splitTransferBatches: splitResourceBatchParts,
      storageAdd: (holding, resource, qty) => {
        let row = holding.storage.resources.find((candidate) => candidate.roomId === resource.roomId);
        if (!row) {
          row = { id: `row-${resource.roomId}`, resourceId: resource.resourceId, name: resource.name, roomId: resource.roomId, qty: 0, batches: [] };
          holding.storage.resources.push(row);
        }
        addResourceBatches(row, Object.prototype.hasOwnProperty.call(resource, "batches") ? { batches: resource.batches } : { qty });
      }
    }
  });
  assert.deepEqual(placementHolding.storage.resources.map((row) => ({ roomId: row.roomId, batches: row.batches.map(({ id, qty, ageQd }) => ({ id, qty, ageQd })) })), [
    { roomId: "pantry", batches: [{ id: "transfer-old", qty: 2, ageQd: 20 }] },
    { roomId: "outdoors", batches: [{ id: "transfer-new", qty: 2, ageQd: 5 }] }
  ], "overflow placement must split one age-preserving receipt without duplicating batches");

  const current = { meta: { revision: 1 }, holdings: [clone(BASE_HOLDING)] };
  current.holdings[0].id = "guard";
  current.holdings[0].visibility = "public";
  current.holdings[0].gm.playersCanUseStorage = true;
  current.holdings[0].storage.resources = [preparedRow("guard-row", "bread", "outdoors", Array.from({ length: 8 }, (_value, index) => ({ id: `guard-${index}`, qty: 1, ageQd: index })))];
  const forged = clone(current);
  forged.holdings[0].storage.resources[0].batches.push({ id: "guard-9", qty: 1, ageQd: 0 });
  forged.holdings[0].storage.resources[0].qty += 1;
  const forgedPatch = buildPlayerPatch(current, forged);
  assert.equal(validatePlayerPatch(current, forgedPatch, "player").ok, false, "authority validation must reject more than eight persisted batches");
  const rejuvenated = clone(current);
  rejuvenated.holdings[0].storage.resources[0].batches.find((batch) => batch.id === "guard-7").ageQd = 0;
  const rejuvenatedPatch = buildPlayerPatch(current, rejuvenated);
  assert.equal(validatePlayerPatch(current, rejuvenatedPatch, "player").ok, false, "authority validation must reject player-side batch rejuvenation");
  const replacedId = clone(current);
  replacedId.holdings[0].storage.resources[0].batches.find((batch) => batch.id === "guard-0").id = "fresh-forgery";
  const replacedIdPatch = buildPlayerPatch(current, replacedId);
  assert.equal(validatePlayerPatch(current, replacedIdPatch, "player").ok, false, "authority validation must reject replacement batch ids without an actual stock receipt");
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  checkFoodBatchCharacterization();
  console.log("FBL Skyhold food batches: FIFO, ration fallback, expiry and authority contracts passed.");
}
