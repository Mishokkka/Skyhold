import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  applyInternalDemandPlan,
  buildInternalDemandPools,
  diminishingDemandBudget,
  internalDemandDiminishingFactor,
  internalDemandSellerPriceFactor,
  internalDemandUnitPrice,
  planInternalDemand
} from "../engines/economy/internal-demand.js";
import { FinanceInternalDemandDomain } from "../apps/domains/finance/internal-demand-domain.js";
import { DEFAULT_INTERNAL_DEMAND_CONFIG, internalDemandTradeDefaults } from "../data/economy/internal-demand.js";
import { normalizeStorageItemRow } from "../data/normalizers/storage.js";

function candidate(id, overrides = {}) {
  return {
    id,
    kind: "resource",
    name: id,
    qty: 10,
    basePriceCopper: 10,
    categoryTag: "food.prepared",
    tags: ["food.prepared"],
    ...overrides
  };
}

function channel(id, overrides = {}) {
  return {
    id,
    label: id,
    sourceIds: ["population"],
    allowedTags: ["all"],
    throughputUnits: 10,
    sellerEfficiency: 2,
    priority: 0,
    ...overrides
  };
}

export function checkInternalDemandCharacterization() {
  assert.equal(DEFAULT_INTERNAL_DEMAND_CONFIG.populationBudgetPerResidentCopper, 12, "population demand must use the approved sixfold money-flow scale");
  assert.deepEqual(internalDemandTradeDefaults({ templateId: "inn" }), {
    sourceIds: ["population", "inn-visitors"],
    allowedTags: ["food.prepared", "alcohol", "beverage", "service.inn"],
    demandSource: "inn-visitors",
    demandBudgetBaseCopper: 240,
    demandBudgetPerWorkerCopper: 60,
    throughputUnitsPerWorker: 5,
    service: { enabled: true, categoryTag: "service.inn", basePriceCopper: 30, unitsPerWorker: 2 }
  });
  assert.equal(internalDemandTradeDefaults({ templateId: "market" }).demandBudgetBaseCopper, 480);
  assert.equal(internalDemandTradeDefaults({ templateId: "market" }).demandBudgetPerWorkerCopper, 90);
  assert.equal(internalDemandSellerPriceFactor(0), 0.5);
  assert.equal(internalDemandSellerPriceFactor(1), 0.5);
  assert.equal(internalDemandSellerPriceFactor(2), 1);
  assert.equal(internalDemandSellerPriceFactor(3), 1.5);
  assert.equal(internalDemandSellerPriceFactor(99), 1.5);
  assert.equal(internalDemandUnitPrice(9, 1), 5);
  assert.equal(internalDemandUnitPrice(10, 2), 10);
  assert.equal(internalDemandUnitPrice(10, 3), 15);

  assert.equal(internalDemandDiminishingFactor(0), 1);
  assert.equal(internalDemandDiminishingFactor(1), 0.5);
  assert.equal(diminishingDemandBudget([
    { id: "first", budgetCopper: 100, priority: 2 },
    { id: "second", budgetCopper: 100, priority: 1 },
    { id: "third", budgetCopper: 90, priority: 0 }
  ]), 180, "repeated visitor sources must add 100% + 50% + 33% instead of linear demand");

  const pools = buildInternalDemandPools({
    populationCount: 10,
    populationBudgetPerResidentCopper: 10,
    satisfactionFactor: 0.8,
    wagePaymentRatio: 0.5,
    innVisitorSources: [{ id: "inn", budgetCopper: 70 }],
    marketFlowSources: [{ id: "market", budgetCopper: 120 }]
  });
  assert.deepEqual(pools.map((row) => [row.id, row.budgetCopper]), [
    ["population", 40],
    ["inn-visitors", 70],
    ["market-flow", 120]
  ], "resident wage ratio must not reduce independent guest demand");

  const sharedPoolPlan = planInternalDemand({
    operationId: "demand-1",
    pools: [{ id: "population", budgetCopper: 50, allowedTags: ["all"], priority: 1 }],
    channels: [
      channel("high", { priority: 10, throughputUnits: 3 }),
      channel("low", { priority: 1, throughputUnits: 10 })
    ],
    candidates: [candidate("goods", { qty: 10, basePriceCopper: 10 })]
  });
  assert.equal(sharedPoolPlan.soldUnits, 5, "one settlement demand pool must not be cloned for each channel");
  assert.equal(sharedPoolPlan.revenueCopper, 50);
  assert.deepEqual(sharedPoolPlan.sales.map((row) => [row.channelId, row.qty]), [["high", 3], ["low", 2]]);

  const orderedPlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 20, allowedTags: ["all"] }],
    channels: [channel("shop", { throughputUnits: 2 })],
    candidates: [
      candidate("expensive", { basePriceCopper: 10, expiresInQd: 3 }),
      candidate("fresh-cheap", { basePriceCopper: 2, expiresInQd: 20 }),
      candidate("old-cheap", { basePriceCopper: 2, expiresInQd: 3, gmPriority: 2 })
    ]
  });
  assert.equal(orderedPlan.sales[0].candidateId, "old-cheap", "expiry, then lower canonical price, then GM priority must be deterministic");

  const durableFifoPlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 10, allowedTags: ["all"] }],
    channels: [channel("durable-shop", { throughputUnits: 1 })],
    candidates: [
      candidate("a-new", { ageQd: 0 }),
      candidate("z-old", { ageQd: 20 })
    ]
  });
  assert.equal(durableFifoPlan.sales[0].candidateId, "z-old", "durable batches tied on expiry, price and priority must remain FIFO before stable-id fallback");

  const perishableBeforeDurablePlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 10, allowedTags: ["all"] }],
    channels: [channel("expiry-shop", { throughputUnits: 1 })],
    candidates: [
      candidate("durable", { expiresInQd: null }),
      candidate("perishable", { expiresInQd: 5 })
    ]
  });
  assert.equal(perishableBeforeDurablePlan.sales[0].candidateId, "perishable", "durable null expiry must sort after a finite perishable shelf-life instead of masquerading as zero QD");

  const imported = candidate("imported", { origin: "market-arrival", qty: 1, basePriceCopper: 10 });
  const importedPlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 10, allowedTags: ["all"] }],
    channels: [channel("shop", { throughputUnits: 1 })],
    candidates: [imported]
  });
  assert.equal(importedPlan.soldUnits, 1, "the pure allocator must not infer arrival cooldown from a keyword; the storage batch boundary filters candidates");

  const boundaryHolding = {
    gm: { calendaria: { lastQd: 0 } },
    buildings: { list: [] },
    storage: {
      resources: [{
        id: "bread-row",
        resourceId: "bread",
        name: "Bread",
        roomId: "outdoors",
        forSale: true,
        batches: [
          { id: "local-production", qty: 2, ageQd: 0 },
          { id: "instant-between-periods", qty: 1, ageQd: 0, internalDemandAvailableFromQd: 0 },
          { id: "scheduled-current-apply", qty: 3, ageQd: 0, internalDemandAvailableFromQd: 40 }
        ]
      }],
      items: [
        { id: "instant-item", name: "Instant item", qty: 1, forSale: true, internalDemandAvailableFromQd: 0 },
        { id: "scheduled-item", name: "Scheduled item", qty: 1, forSale: true, internalDemandAvailableFromQd: 40 }
      ]
    }
  };
  const demandDomain = {
    ...FinanceInternalDemandDomain,
    _itemQuantity: (row) => row.qty,
    _itemPriceCopper: () => 10
  };
  assert.equal(
    normalizeStorageItemRow({ id: "deferred-item", qty: 1, internalDemandAvailableFromQd: 40 }).internalDemandAvailableFromQd,
    40,
    "stored Item arrival cooldown must survive normalization"
  );
  const currentCandidates = demandDomain._internalDemandCandidates(boundaryHolding);
  assert.deepEqual(
    currentCandidates.map((row) => row.id).sort(),
    ["item:instant-item", "resource:bread-row:instant-between-periods", "resource:bread-row:local-production"].sort(),
    "scheduled resource batches and Item cargo arriving in the current Apply must be excluded without blocking local production or instant receipts already present between periods"
  );
  boundaryHolding.gm.calendaria.lastQd = 40;
  const nextCandidates = demandDomain._internalDemandCandidates(boundaryHolding);
  assert.deepEqual(
    nextCandidates.map((row) => row.id).sort(),
    [
      "item:instant-item",
      "item:scheduled-item",
      "resource:bread-row:instant-between-periods",
      "resource:bread-row:local-production",
      "resource:bread-row:scheduled-current-apply"
    ].sort(),
    "the next tenday boundary must release only the deferred external cargo"
  );

  const applyHolding = {
    gm: {
      calendaria: { lastQd: 0 },
      economy: { internalDemand: { populationBudgetPerResidentCopper: 100, satisfactionOverrideFactor: 1 } }
    },
    people: { list: [{ id: "seller", name: "Seller", dead: false }] },
    buildings: { list: [{ id: "market-1", templateId: "market", income: { trade: { enabled: true } } }] },
    storage: {
      moneyCopper: 0,
      resources: [{
        id: "sale-row",
        resourceId: "bread",
        name: "Bread",
        roomId: "outdoors",
        forSale: true,
        batches: [
          { id: "sale-local", qty: 2, ageQd: 0 },
          { id: "sale-scheduled", qty: 3, ageQd: 0, internalDemandAvailableFromQd: 40 }
        ]
      }],
      items: []
    }
  };
  const runtimeDemandDomain = {
    ...demandDomain,
    _buildingStatus: () => ({ value: "built" }),
    _buildingFunctions: () => ({ income: true }),
    _financeFunctionAllowed: () => true,
    _activeAssignedBuildingPeople: (holding) => [holding.people.list[0]],
    _personBuildingEfficiency: () => 2,
    _maintenanceEfficiencyFactor: () => 1,
    _calculatePersonMorale: () => ({ total: 0 }),
    _addMoney: (holding, amount) => { holding.storage.moneyCopper += amount; },
    _reduceTradeCandidate: () => 0
  };
  const currentReport = { trade: { buyers: 0, sold: 0, revenue: 0, purchases: [] }, work: [], ledger: [] };
  const currentApply = runtimeDemandDomain._runInternalDemandForQd(applyHolding, 40, currentReport, null, { operationId: "demand-current" });
  assert.equal(currentApply.ok, true);
  assert.equal(currentApply.applied.soldUnits, 2, "actual apply must sell the eligible local batch only");
  assert.deepEqual(applyHolding.storage.resources[0].batches.map((row) => [row.id, row.qty]), [["sale-scheduled", 3]], "actual apply must take by eligible batch id and preserve deferred cargo");
  applyHolding.gm.calendaria.lastQd = 40;
  const nextReport = { trade: { buyers: 0, sold: 0, revenue: 0, purchases: [] }, work: [], ledger: [] };
  const nextApply = runtimeDemandDomain._runInternalDemandForQd(applyHolding, 40, nextReport, null, { operationId: "demand-next" });
  assert.equal(nextApply.applied.soldUnits, 3, "the next Apply must sell the released scheduled batch without a second cooldown");
  assert.equal(applyHolding.storage.resources[0].qty, 0);

  const servicePlan = planInternalDemand({
    pools: [{ id: "inn-visitors", budgetCopper: 30, allowedTags: ["service.inn"] }],
    channels: [channel("inn", { sourceIds: ["inn-visitors"], allowedTags: ["service.inn"], throughputUnits: 3, sellerEfficiency: 3 })],
    candidates: [candidate("lodging", { kind: "service", channelId: "inn", sourceIds: ["inn-visitors"], categoryTag: "service.inn", tags: ["service.inn"], qty: 2, basePriceCopper: 10 })]
  });
  assert.equal(servicePlan.soldUnits, 2);
  assert.equal(servicePlan.revenueCopper, 30, "services create revenue only when visitor budget and staffed capacity both exist");

  const channelFilterPlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 100, allowedTags: ["all"] }],
    channels: [channel("restricted", { roomId: "shop-room", allowedKinds: ["resource"], throughputUnits: 10 })],
    candidates: [
      candidate("wrong-room", { roomId: "outdoors" }),
      candidate("wrong-kind", { kind: "item", roomId: "shop-room" }),
      candidate("allowed", { roomId: "shop-room" })
    ]
  });
  assert.deepEqual(channelFilterPlan.sales.map((row) => row.candidateId), ["allowed"], "channel room and kind filters must remain enforceable under the shared demand pool");

  const applyCandidates = [candidate("apply", { qty: 3, basePriceCopper: 10 })];
  const applyPlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 20, allowedTags: ["all"] }],
    channels: [channel("shop", { throughputUnits: 2 })],
    candidates: applyCandidates,
    operationId: "apply"
  });
  let money = 0;
  const applied = applyInternalDemandPlan({
    plan: applyPlan,
    candidates: applyCandidates,
    dependencies: {
      candidateQuantity: (row) => row.qty,
      takeCandidate: (row, qty) => {
        const taken = Math.min(row.qty, qty);
        row.qty -= taken;
        return taken;
      },
      addMoney: (qty) => { money += qty; }
    }
  });
  assert.equal(applied.ok, true);
  assert.equal(applyCandidates[0].qty, 1);
  assert.equal(money, 20);

  const staleCandidates = [candidate("stale", { qty: 1, basePriceCopper: 10 })];
  const stalePlan = planInternalDemand({
    pools: [{ id: "population", budgetCopper: 20 }],
    channels: [channel("shop", { throughputUnits: 2 })],
    candidates: [candidate("stale", { qty: 2, basePriceCopper: 10 })]
  });
  let staleMoney = 0;
  const stale = applyInternalDemandPlan({
    plan: stalePlan,
    candidates: staleCandidates,
    dependencies: {
      candidateQuantity: (row) => row.qty,
      takeCandidate: () => { throw new Error("must not mutate stale plan"); },
      addMoney: (qty) => { staleMoney += qty; }
    }
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(staleMoney, 0, "stale Preview must fail before any partial money or inventory mutation");

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkInternalDemandCharacterization();
  console.log("FBL Skyhold internal demand: finite source budgets, diminishing channels, deterministic allocation, seller ×0.5–×1.5, services and atomic apply passed.");
}
