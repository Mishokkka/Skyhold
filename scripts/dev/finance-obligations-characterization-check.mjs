import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allocateFinanceObligations,
  calculatePlannedWorkerWage,
  financeBuildingFunctionBlockState,
  financeObligationOutstandingCopper,
  financeWorkerBlockState,
  mergeFinanceObligations,
  planCurrentFinanceObligations,
  reconcileFinanceObligationOrphans,
  resolveFinanceObligationOrphan,
  setFinanceBuildingMothball
} from "../engines/economy/finance-obligations.js";
import {
  createDefaultFinanceObligationsState,
  normalizeFinanceObligationsState
} from "../data/finance/obligations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const engineSource = readFileSync(path.join(root, "scripts/engines/economy/finance-obligations.js"), "utf8");
assert.deepEqual([...engineSource.matchAll(/^import.*from "([^"]+)";/gm)].map((match) => match[1]), ["./labor-wage-rate.js"], "finance shares the pure canonical wage rule and must not import runtime or storage services");
assert.doesNotMatch(engineSource, /\b(?:game|canvas|ui)\./, "finance must remain independent of Foundry globals");

function obligation({
  id,
  kind = "wage",
  recipientKind = "resident",
  recipientId = "worker",
  functionId = "",
  periodKey = "period-1",
  periodIndex = 1,
  dueCopper = 10,
  paidCopper = 0,
  waivedCopper = 0,
  gmPriority = 200,
  dependsOnObligationIds = []
} = {}) {
  return {
    id,
    kind,
    recipientKind,
    recipientId,
    sourceId: recipientId,
    functionId,
    periodKey,
    periodIndex,
    dueCopper,
    paidCopper,
    waivedCopper,
    outstandingCopper: Math.max(0, dueCopper - paidCopper - waivedCopper),
    status: paidCopper || waivedCopper ? "partial" : "due",
    gmPriority,
    dependsOnObligationIds,
    payments: [],
    orphaned: false,
    orphanHistory: [],
    meta: {}
  };
}

{
  const halfCopper = calculatePlannedWorkerWage({
    id: "half-copper",
    assignments: [{ sourceId: "mill", functionId: "grind", normalQd: 1, dailyRateCopper: 1 }]
  });
  assert.equal(halfCopper.ok, true);
  assert.equal(halfCopper.halfCopperUnits, 1);
  assert.equal(halfCopper.dueCopper, 1, "a 0.5 copper mandatory wage must round up once to 1 copper");

  const roundOnce = calculatePlannedWorkerWage({
    id: "split-worker",
    assignments: [
      { sourceId: "mill", normalQd: 1, dailyRateCopper: 1 },
      { sourceId: "bakery", normalQd: 1, dailyRateCopper: 1 }
    ]
  });
  assert.equal(roundOnce.dueCopper, 1, "split assignments must be summed before the one per-worker rounding step");

  const normalAndOvertime = calculatePlannedWorkerWage({
    id: "overtime-worker",
    assignments: [{ normalQd: 20, overtimeQd: 10, dailyRateCopper: 3 }]
  });
  assert.equal(normalAndOvertime.dueCopper, 60, "normal QD cost half a daily rate and overtime QD cost a full daily rate");

  const override = calculatePlannedWorkerWage({
    id: "override-worker",
    wageOverrideCopper: 5,
    assignments: [
      { normalQd: 2, dailyRateCopper: 99 },
      { overtimeQd: 1, dailyRateCopper: 1 }
    ]
  });
  assert.equal(override.dueCopper, 10, "a resident override must replace every workplace rate, not add to it");
  assert.equal(override.assignments.every((row) => row.effectiveDailyRateCopper === 5), true);

  assert.equal(calculatePlannedWorkerWage({ id: "free", volunteer: true, volunteerReason: "семейная помощь", assignments: [{ normalQd: 20 }] }).dueCopper, 0);
  assert.equal(calculatePlannedWorkerWage({ id: "hidden-free", assignments: [{ normalQd: 1, dailyRateCopper: 0 }] }).ok, false, "zero-price labor needs the explicit volunteer contract");
  const unexplainedVolunteer = calculatePlannedWorkerWage({ id: "unexplained-free", volunteer: true, assignments: [{ normalQd: 1 }] });
  assert.equal(unexplainedVolunteer.ok, true, "the explicit volunteer flag must be a complete visible labor contract by itself");
  assert.equal(unexplainedVolunteer.dueCopper, 0);
}

{
  const finance = {
    ...createDefaultFinanceObligationsState(),
    obligations: [
      obligation({ id: "old-newer", periodKey: "p2", periodIndex: 2, dueCopper: 2, gmPriority: 0 }),
      obligation({ id: "old-oldest-z", periodKey: "p1", periodIndex: 1, dueCopper: 2, gmPriority: 1 }),
      obligation({ id: "old-oldest-a", periodKey: "p1", periodIndex: 1, dueCopper: 2, gmPriority: 1 }),
      obligation({ id: "current", periodKey: "p3", periodIndex: 3, dueCopper: 2, gmPriority: 0 })
    ]
  };
  const paid = allocateFinanceObligations({
    finance,
    treasuryCopper: 8,
    currentPeriodKey: "p3",
    currentPeriodIndex: 3,
    operationId: "priority-payment",
    paidAt: "2026-08-11T10:00:00.000Z"
  });
  assert.deepEqual(paid.payments.map((row) => row.obligationId), ["old-oldest-a", "old-oldest-z", "old-newer", "current"], "payment order must be old, oldest period, GM priority, then stable id");
}

{
  const finance = {
    ...createDefaultFinanceObligationsState(),
    obligations: [
      obligation({ id: "current-expensive", periodKey: "p2", periodIndex: 2, dueCopper: 8, gmPriority: 1 }),
      obligation({ id: "current-cheap", periodKey: "p2", periodIndex: 2, dueCopper: 3, gmPriority: 2 })
    ]
  };
  const paid = allocateFinanceObligations({
    finance,
    treasuryCopper: 5,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "atomic-current"
  });
  assert.deepEqual(paid.payments, [{ obligationId: "current-cheap", amountCopper: 3, partial: false }], "an unaffordable current bill must be skipped so a later affordable bill can be paid");
  assert.equal(paid.finance.obligations.find((row) => row.id === "current-expensive").status, "unpaid");
  assert.equal(paid.treasuryCopper, 2);
  const replay = allocateFinanceObligations({
    finance: paid.finance,
    treasuryCopper: 999,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "atomic-current"
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.treasuryCopper, 2, "the settlement operation must replay its recorded treasury result instead of paying again");
  assert.equal(replay.finance.obligations.find((row) => row.id === "current-cheap").payments.length, 1);
}

{
  const finance = {
    ...createDefaultFinanceObligationsState(),
    obligations: [obligation({ id: "old-partial", periodKey: "p1", periodIndex: 1, dueCopper: 10 })]
  };
  const paid = allocateFinanceObligations({
    finance,
    treasuryCopper: 4,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "partial-old"
  });
  const debt = paid.finance.obligations[0];
  assert.equal(debt.paidCopper, 4, "old debt may accept a partial payment");
  assert.equal(debt.outstandingCopper, 6);
  assert.equal(debt.status, "partial");
}

{
  const finance = {
    ...createDefaultFinanceObligationsState(),
    obligations: [
      obligation({ id: "worker-old", recipientId: "worker-debtor", periodKey: "p1", periodIndex: 1, dueCopper: 4 }),
      obligation({ id: "base-old", kind: "building-base-upkeep", recipientKind: "building", recipientId: "base-debtor", periodKey: "p1", periodIndex: 1, dueCopper: 5, gmPriority: 300 }),
      obligation({ id: "op-old", kind: "building-operating-upkeep", recipientKind: "building", recipientId: "op-debtor", functionId: "forge", periodKey: "p1", periodIndex: 1, dueCopper: 6, gmPriority: 400 })
    ]
  };
  const planned = planCurrentFinanceObligations({
    finance,
    periodKey: "p2",
    periodIndex: 2,
    operationId: "plan-p2",
    workers: [
      { id: "worker-debtor", assignments: [{ normalQd: 2, dailyRateCopper: 2 }] },
      { id: "worker-clear", assignments: [{ normalQd: 2, dailyRateCopper: 2 }] }
    ],
    buildings: [
      { id: "base-debtor", built: true, baseUpkeepCopper: 3, functions: [{ id: "market", operatingUpkeepCopper: 2 }] },
      { id: "op-debtor", built: true, baseUpkeepCopper: 3, functions: [{ id: "forge", operatingUpkeepCopper: 2 }, { id: "store", operatingUpkeepCopper: 2 }] },
      { id: "clear-building", built: true, baseUpkeepCopper: 3, functions: [{ id: "mill", operatingUpkeepCopper: 2 }] },
      { id: "unfinished", built: false, baseUpkeepCopper: 100, functions: [{ id: "ghost", operatingUpkeepCopper: 100 }] }
    ]
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.obligations.some((row) => row.kind === "wage" && row.recipientId === "worker-debtor"), false, "a worker with old wage debt must not accrue another wage or produce new work");
  assert.equal(planned.obligations.some((row) => row.kind === "wage" && row.recipientId === "worker-clear"), true);
  assert.equal(planned.obligations.some((row) => row.kind === "building-base-upkeep" && row.recipientId === "base-debtor"), true, "active base upkeep must continue accruing despite an old base debt");
  assert.equal(planned.obligations.some((row) => row.kind === "building-operating-upkeep" && row.recipientId === "base-debtor"), false, "base debt must stop all economic functions and their new operating accrual");
  assert.equal(planned.obligations.some((row) => row.kind === "building-base-upkeep" && row.recipientId === "op-debtor"), true, "operating debt must not suppress active base upkeep");
  assert.equal(planned.obligations.some((row) => row.kind === "building-operating-upkeep" && row.recipientId === "op-debtor" && row.functionId === "forge"), false);
  assert.equal(planned.obligations.some((row) => row.kind === "building-operating-upkeep" && row.recipientId === "op-debtor" && row.functionId === "store"), true, "operating debt must block only its own function");
  assert.equal(planned.obligations.some((row) => row.recipientId === "unfinished"), false, "an unbuilt project has no upkeep");
  const cleanBase = planned.obligations.find((row) => row.kind === "building-base-upkeep" && row.recipientId === "clear-building");
  const cleanOperating = planned.obligations.find((row) => row.kind === "building-operating-upkeep" && row.recipientId === "clear-building");
  assert.deepEqual(cleanOperating.dependsOnObligationIds, [cleanBase.id], "base and operating costs must remain separate bills connected by an explicit execution dependency");
  assert.equal(financeWorkerBlockState({ finance, workerId: "worker-debtor" }).blocked, true);
  assert.deepEqual(financeBuildingFunctionBlockState({ finance, buildingId: "op-debtor", functionId: "forge" }).reasons, ["operating-upkeep-debt"]);
  assert.equal(financeBuildingFunctionBlockState({ finance, buildingId: "op-debtor", functionId: "store" }).blocked, false);

  const dependencyPayment = allocateFinanceObligations({
    finance: {
      ...createDefaultFinanceObligationsState(),
      obligations: [cleanBase, cleanOperating]
    },
    treasuryCopper: 2,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "base-dependency"
  });
  assert.equal(dependencyPayment.payments.length, 0, "a cheap operating bill must not bypass its unaffordable current base bill");
  assert.equal(dependencyPayment.treasuryCopper, 2);
  assert.equal(dependencyPayment.skipped.find((row) => row.obligationId === cleanOperating.id).reason, "dependency-unpaid");

  const invertedPriorities = allocateFinanceObligations({
    finance: {
      ...createDefaultFinanceObligationsState(),
      obligations: [
        { ...cleanBase, gmPriority: 999 },
        { ...cleanOperating, gmPriority: 1 }
      ]
    },
    treasuryCopper: 5,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "dependency-before-priority"
  });
  assert.deepEqual(invertedPriorities.payments.map((row) => row.obligationId), [cleanBase.id, cleanOperating.id], "an explicit dependency must be settled before its dependent even when GM priorities are inverted");

  const currentNotPaid = allocateFinanceObligations({
    finance: planned.finance,
    treasuryCopper: 0,
    currentPeriodKey: "p2",
    currentPeriodIndex: 2,
    operationId: "no-current-money"
  });
  assert.equal(financeWorkerBlockState({ finance: currentNotPaid.finance, workerId: "worker-clear" }).blocked, true, "an unpaid current wage must gate this period's worker output");
  assert.equal(financeBuildingFunctionBlockState({ finance: currentNotPaid.finance, buildingId: "clear-building", functionId: "mill" }).blocked, true);
}

{
  const existingDebt = obligation({
    id: "mothball-debt",
    kind: "building-operating-upkeep",
    recipientKind: "building",
    recipientId: "mothballed-building",
    functionId: "shop",
    periodKey: "p1",
    periodIndex: 1,
    dueCopper: 7
  });
  const mothballed = setFinanceBuildingMothball({
    finance: { ...createDefaultFinanceObligationsState(), obligations: [existingDebt] },
    buildingId: "mothballed-building",
    mothballed: true,
    reason: "закрыто владельцами",
    operationId: "mothball-on",
    changedAt: "2026-08-11T11:00:00.000Z"
  });
  assert.equal(mothballed.finance.obligations.length, 1, "mothballing must preserve existing debts");
  const replay = setFinanceBuildingMothball({ finance: mothballed.finance, buildingId: "mothballed-building", mothballed: true, reason: "ignored replay payload", operationId: "mothball-on" });
  assert.equal(replay.replay, true);
  const whileClosed = planCurrentFinanceObligations({
    finance: mothballed.finance,
    periodKey: "p2",
    periodIndex: 2,
    buildings: [{ id: "mothballed-building", built: true, baseUpkeepCopper: 4, functions: [{ id: "shop", operatingUpkeepCopper: 2 }] }]
  });
  assert.equal(whileClosed.obligations.length, 0, "explicit mothballing suppresses both new base and operating upkeep");
  assert.deepEqual(financeBuildingFunctionBlockState({ finance: mothballed.finance, buildingId: "mothballed-building", functionId: "shop" }).reasons, ["mothballed", "operating-upkeep-debt"]);
  const reopened = setFinanceBuildingMothball({ finance: mothballed.finance, buildingId: "mothballed-building", mothballed: false, operationId: "mothball-off" });
  const afterOpen = planCurrentFinanceObligations({
    finance: reopened.finance,
    periodKey: "p2",
    periodIndex: 2,
    buildings: [{ id: "mothballed-building", built: true, baseUpkeepCopper: 4, functions: [{ id: "shop", operatingUpkeepCopper: 2 }] }]
  });
  assert.equal(afterOpen.obligations.filter((row) => row.kind === "building-base-upkeep").length, 1, "unmothballing resumes base upkeep immediately");
  assert.equal(afterOpen.obligations.filter((row) => row.kind === "building-operating-upkeep").length, 0, "the preserved operating debt still blocks its function after reopening");
}

{
  const source = {
    ...createDefaultFinanceObligationsState(),
    obligations: [
      obligation({ id: "orphan-transfer", recipientId: "departed", dueCopper: 5 }),
      obligation({ id: "orphan-waive", recipientId: "dead", dueCopper: 6, paidCopper: 2 })
    ]
  };
  const reconciled = reconcileFinanceObligationOrphans({
    finance: source,
    recipientIdsByKind: { resident: ["present"] },
    reconciledAt: "2026-08-11T12:00:00.000Z",
    operationId: "reconcile-residents"
  });
  assert.deepEqual(reconciled.orphanedIds, ["orphan-transfer", "orphan-waive"]);
  assert.equal(reconciled.finance.obligations.length, 2, "missing recipients must never silently delete debt rows");
  const cannotPayOrphan = allocateFinanceObligations({
    finance: reconciled.finance,
    treasuryCopper: 20,
    currentPeriodKey: "period-1",
    currentPeriodIndex: 1,
    operationId: "orphan-payment"
  });
  assert.equal(cannotPayOrphan.paidCopper, 0);

  const transferred = resolveFinanceObligationOrphan({
    finance: reconciled.finance,
    obligationId: "orphan-transfer",
    action: "transfer",
    recipientKind: "resident",
    recipientId: "heir",
    reason: "наследник договора",
    resolvedAt: "2026-08-11T13:00:00.000Z",
    operationId: "transfer-orphan"
  });
  assert.equal(transferred.obligation.id, "orphan-transfer", "recipient transfer must preserve the immutable debt id and audit trail");
  assert.equal(transferred.obligation.recipientId, "heir");
  assert.equal(transferred.obligation.outstandingCopper, 5);
  assert.equal(transferred.obligation.orphanHistory.at(-1).resolution.action, "transfer");
  const reconcileReplay = reconcileFinanceObligationOrphans({
    finance: transferred.finance,
    recipientIdsByKind: { resident: ["present"] },
    reconciledAt: "2026-08-11T13:05:00.000Z",
    operationId: "reconcile-residents"
  });
  assert.equal(reconcileReplay.finance.obligations.find((row) => row.id === "orphan-transfer").orphaned, false, "the same reconciliation operation must not orphan a debt again after GM transfer");

  const waived = resolveFinanceObligationOrphan({
    finance: transferred.finance,
    obligationId: "orphan-waive",
    action: "waive",
    reason: "GM закрыл наследство",
    resolvedAt: "2026-08-11T13:10:00.000Z",
    operationId: "waive-orphan"
  });
  assert.equal(waived.obligation.waivedCopper, 4);
  assert.equal(waived.obligation.status, "waived");
  assert.equal(financeObligationOutstandingCopper(waived.obligation), 0);
  const waiverReplay = resolveFinanceObligationOrphan({
    finance: waived.finance,
    obligationId: "orphan-waive",
    action: "waive",
    reason: "GM закрыл наследство",
    operationId: "waive-orphan"
  });
  assert.equal(waiverReplay.replay, true);

  const normalized = normalizeFinanceObligationsState(waived.finance);
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.obligations.find((row) => row.id === "orphan-transfer").orphanHistory.at(-1).resolution.recipientId, "heir");
  assert.equal(normalized.obligations.find((row) => row.id === "orphan-waive").status, "waived", "the full orphan lifecycle must survive normalization");
  assert.equal(normalizeFinanceObligationsState({ obligations: [{ id: "future-kind", kind: "custom-contract" }] }).obligations[0].kind, "custom-contract", "safe normalization must preserve future obligation kinds");
}

{
  const planned = planCurrentFinanceObligations({
    periodKey: "stable-period",
    periodIndex: 7,
    workers: [{ id: "stable-worker", assignments: [{ normalQd: 2, dailyRateCopper: 4 }] }]
  });
  const repeated = planCurrentFinanceObligations({
    finance: planned.finance,
    periodKey: "stable-period",
    periodIndex: 7,
    workers: [{ id: "stable-worker", assignments: [{ normalQd: 2, dailyRateCopper: 4 }] }]
  });
  assert.equal(repeated.added.length, 0);
  assert.equal(repeated.existing.length, 1, "stable IDs must make repeated planning idempotent");
  assert.equal(repeated.finance.obligations.length, 1);
  const conflict = mergeFinanceObligations(planned.finance, [{ ...planned.obligations[0], dueCopper: 999 }]);
  assert.equal(conflict.ok, false, "a stable obligation id must not permit silent mutation of its financial terms");
  assert.equal(conflict.finance.obligations[0].dueCopper, 4);
}

console.log("FBL Skyhold finance obligations characterization check passed.");
