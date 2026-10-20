import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { FinanceControlEventDomain } from "../apps/domains/events/finance-control-events.js";
import { FinanceControlsDomain } from "../apps/domains/finance/controls-domain.js";
import { SkyholdData } from "../data/store.js";
import { createDefaultFinanceObligationsState } from "../data/finance/obligations.js";
import { isPlayerWritablePath } from "../data/player-write-guard.js";
import {
  applyFinanceBuildingMothballControl,
  applyFinanceOrphanControl
} from "../workflows/economy/finance-controls.js";

function orphan(id, { recipientKind = "resident", recipientId = "missing", dueCopper = 5 } = {}) {
  return {
    id,
    kind: recipientKind === "building" ? "building-base-upkeep" : "wage",
    recipientKind,
    recipientId,
    sourceId: recipientId,
    functionId: "",
    periodKey: "tenday:1",
    periodIndex: 1,
    dueCopper,
    paidCopper: 0,
    waivedCopper: 0,
    outstandingCopper: dueCopper,
    status: "orphaned",
    gmPriority: 200,
    dependsOnObligationIds: [],
    payments: [],
    orphaned: true,
    orphanedAt: "2026-08-13T10:00:00.000Z",
    orphanedOperationId: `orphan:${id}`,
    orphanReason: "recipient-missing",
    orphanPreviousStatus: "due",
    orphanResolvedAt: "",
    orphanResolutionAction: "",
    orphanResolutionOperationId: "",
    orphanHistory: [{
      orphanedAt: "2026-08-13T10:00:00.000Z",
      operationId: `orphan:${id}`,
      reason: "recipient-missing",
      previousStatus: "due",
      resolution: null
    }],
    meta: {}
  };
}

function holdingFixture() {
  const finance = createDefaultFinanceObligationsState();
  finance.obligations = [
    orphan("resident-debt"),
    orphan("building-debt", { recipientKind: "building", recipientId: "missing-building", dueCopper: 7 })
  ];
  return {
    id: "laputa",
    log: [],
    finance,
    people: { list: [{ id: "heir", name: "Наследник" }] },
    buildings: { list: [{ id: "forge", name: "Кузница", constructionStatus: "built" }] }
  };
}

export async function checkFinanceControlsCharacterization() {
  const holding = holdingFixture();
  globalThis.game = { user: { id: "gm", isGM: true } };
  const controlsContext = FinanceControlsDomain._financeControlsContext.call({
    _formatCopperCurrency: (value) => `${value} ММ`
  }, holding);
  assert.equal(controlsContext.canManage, true);
  assert.equal(controlsContext.count, 2);
  assert.equal(controlsContext.rows.find((row) => row.id === "resident-debt")?.canTransfer, true);
  delete globalThis.game;

  const transferred = applyFinanceOrphanControl({
    holding,
    obligationId: "resident-debt",
    action: "transfer",
    recipientKind: "resident",
    recipientId: "heir",
    reason: "наследник трудового договора",
    operationId: "finance-transfer-1",
    resolvedAt: "2026-08-13T11:00:00.000Z"
  });
  assert.equal(transferred.ok, true);
  assert.equal(transferred.replay, false);
  assert.equal(transferred.obligation.id, "resident-debt", "a transfer must preserve the exact immutable obligation id");
  assert.equal(transferred.obligation.recipientId, "heir");
  assert.equal(transferred.obligation.outstandingCopper, 5, "a transfer must preserve the exact debt amount");
  assert.equal(holding.log.length, 1);
  assert.equal(holding.log[0].payload.obligationId, "resident-debt");
  assert.equal(holding.log[0].payload.reason, "наследник трудового договора");

  const transferReplay = applyFinanceOrphanControl({
    holding,
    obligationId: "resident-debt",
    action: "transfer",
    recipientKind: "resident",
    recipientId: "heir",
    reason: "наследник трудового договора",
    operationId: "finance-transfer-1",
    resolvedAt: "2026-08-13T11:05:00.000Z"
  });
  assert.equal(transferReplay.ok, true);
  assert.equal(transferReplay.replay, true, "the same operationId and exact payload must be a replay");
  assert.equal(holding.log.length, 1, "replay must not append a second audit row");
  assert.equal(transferred.obligation.orphanHistory.length, holding.finance.obligations[0].orphanHistory.length, "replay must not duplicate finance history");

  const retainedLog = holding.log;
  holding.log = [];
  const historyReplay = applyFinanceOrphanControl({
    holding,
    obligationId: "resident-debt",
    action: "transfer",
    recipientKind: "resident",
    recipientId: "heir",
    reason: "наследник трудового договора",
    operationId: "finance-transfer-1"
  });
  assert.equal(historyReplay.replay, true, "durable finance history must preserve idempotency after the bounded holding timeline is pruned");
  const historyConflict = applyFinanceOrphanControl({
    holding,
    obligationId: "building-debt",
    action: "waive",
    reason: "другая операция",
    operationId: "finance-transfer-1"
  });
  assert.equal(historyConflict.code, "operation-conflict", "durable finance history must reserve an operationId globally");
  holding.log = retainedLog;

  const conflict = applyFinanceOrphanControl({
    holding,
    obligationId: "building-debt",
    action: "waive",
    reason: "другая операция",
    operationId: "finance-transfer-1"
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "operation-conflict", "an operationId cannot be reused for another exact debt");

  const waived = applyFinanceOrphanControl({
    holding,
    obligationId: "building-debt",
    action: "waive",
    reason: "обязательство закрыто решением ГМа",
    operationId: "finance-waive-1",
    resolvedAt: "2026-08-13T11:10:00.000Z"
  });
  assert.equal(waived.ok, true);
  assert.equal(waived.obligation.status, "waived");
  assert.equal(waived.obligation.waivedCopper, 7);
  assert.equal(holding.log.at(-1).payload.outstandingCopper, 7);

  const mothballed = applyFinanceBuildingMothballControl({
    holding,
    buildingId: "forge",
    mothballed: true,
    reason: "сезонная остановка",
    operationId: "finance-mothball-1",
    changedAt: "2026-08-13T12:00:00.000Z"
  });
  assert.equal(mothballed.ok, true);
  assert.equal(holding.finance.buildingStates.forge.mothballed, true);
  assert.equal(holding.finance.buildingStates.forge.history.length, 1);
  assert.equal(holding.log.at(-1).payload.buildingId, "forge");

  const mothballReplay = applyFinanceBuildingMothballControl({
    holding,
    buildingId: "forge",
    mothballed: true,
    reason: "сезонная остановка",
    operationId: "finance-mothball-1",
    changedAt: "2026-08-13T12:05:00.000Z"
  });
  assert.equal(mothballReplay.replay, true);
  assert.equal(holding.finance.buildingStates.forge.history.length, 1, "mothball replay must not duplicate state history");

  const unmothballed = applyFinanceBuildingMothballControl({
    holding,
    buildingId: "forge",
    mothballed: false,
    reason: "сезон работ начался",
    operationId: "finance-unmothball-1",
    changedAt: "2026-08-13T12:10:00.000Z"
  });
  assert.equal(unmothballed.ok, true);
  assert.equal(holding.finance.buildingStates.forge.mothballed, false);
  assert.equal(holding.finance.buildingStates.forge.history.length, 2);

  const originalUpdateHolding = SkyholdData.updateHolding;
  let playerWriteCalls = 0;
  globalThis.game = { user: { id: "player", isGM: false } };
  SkyholdData.updateHolding = async () => {
    playerWriteCalls += 1;
    throw new Error("player finance control must not reach persistence");
  };
  try {
    const deniedOrphan = await FinanceControlEventDomain._executeFinanceOrphanControl({
      holdingId: "laputa",
      obligationId: "resident-debt",
      action: "waive",
      reason: "forbidden",
      operationId: "player-write-1"
    });
    const deniedMothball = await FinanceControlEventDomain._executeFinanceBuildingMothball({
      holdingId: "laputa",
      buildingId: "forge",
      mothballed: true,
      reason: "forbidden",
      operationId: "player-write-2"
    });
    assert.equal(deniedOrphan.code, "gm-only");
    assert.equal(deniedMothball.code, "gm-only");
    assert.equal(playerWriteCalls, 0, "a player command must be rejected before generic data patch or persistence");
  } finally {
    SkyholdData.updateHolding = originalUpdateHolding;
    delete globalThis.game;
  }

  const transactionalHolding = holdingFixture();
  let transactionHoldingId = "";
  let transactionOptions = null;
  globalThis.game = { user: { id: "gm", isGM: true } };
  SkyholdData.updateHolding = async (holdingId, updater, options) => {
    transactionHoldingId = holdingId;
    transactionOptions = options;
    return updater(transactionalHolding);
  };
  try {
    const gmResult = await FinanceControlEventDomain._executeFinanceBuildingMothball({
      holdingId: "laputa",
      buildingId: "forge",
      mothballed: true,
      reason: "транзакционная проверка",
      operationId: "gm-transaction-1",
      changedAt: "2026-08-13T13:00:00.000Z"
    });
    assert.equal(gmResult.ok, true);
    assert.equal(transactionHoldingId, "laputa", "the runtime command must update the exact holding id");
    assert.equal(transactionOptions?.fallback, false, "finance controls must never fall back to another holding");
    assert.match(transactionOptions?.reason ?? "", /^finance:building-mothball:/);
    assert.equal(transactionalHolding.finance.buildingStates.forge.mothballed, true);
  } finally {
    SkyholdData.updateHolding = originalUpdateHolding;
    delete globalThis.game;
  }

  const playerPatchData = {
    holdings: [{
      ...holdingFixture(),
      visibility: "players",
      gm: {
        playersCanEditOverview: true,
        playersCanEditBuildings: true,
        playersCanUseStorage: true,
        playersCanEditResidents: true,
        playersCanEditDefense: true,
        playersCanEditBattle: true,
        playersCanEditSpecial: true
      }
    }]
  };
  assert.equal(
    isPlayerWritablePath("holdings.0.finance.obligations.0.waivedCopper", playerPatchData, playerPatchData),
    false,
    "even a player with every ordinary holding permission must not patch finance controls directly"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkFinanceControlsCharacterization();
  console.log("FBL Skyhold finance controls characterization check passed.");
}
