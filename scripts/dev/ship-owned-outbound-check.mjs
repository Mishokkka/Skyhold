import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { prepareMarketAuthorityContext, marketAuthoritySourceToken } from "../apps/market/authority-context.js";
import { createMarketOperationExecutor } from "../apps/market-operation-executor.js";
import { advanceWorldShips, departWorldShip } from "../engines/ships/world-voyage.js";
import { quoteWorldShipReturn } from "../engines/ships/world-market.js";
import { shipMoneySummary, shipOutingSummary } from "../engines/ships/summary.js";
import { prepareShipFinancePresentation } from "../apps/domains/ship-finance-presentation.js";
import { advanceMarketOutboundShipments, resolveMarketOutboundShipmentRisk } from "../workflows/market/outbound-shipment.js";

export async function checkShipOwnedOutbound() {
  let { data } = worldMarketFixture();
  let holding = data.holdings[0];
  let ship = holding.special.ships.list[0];
  for (let index = 1; index < 36; index++) {
    const id = `sale-sailor-${index}`;
    holding.people.list.push({ id, name: id, wageDailyOverrideCopper: 12 });
    ship.crewResidentIds.push(id);
  }
  holding.visibility = "public";
  holding.gm.playersCanUseStorage = true;
  holding.gm.playersCanManageShips = false;
  holding.storage.resources = [{
    id: "sale-row", resourceId: "test-freight", name: "Ткани", forSale: true, qty: 50,
    batches: [{ id: "sale-batch", qty: 50, ageQd: 0 }]
  }];
  const preview = prepareMarketAuthorityContext({
    data, holding, marketId: "a", outboundQuantities: { "test-freight": 10 },
    outboundInsuranceEnabled: false, ownShipId: ship.id, isGM: true
  });
  assert.equal(preview.outbound.plan.ok, true);
  assert.equal(preview.outbound.plan.route.ownShipId, ship.id);
  assert.equal(preview.outbound.plan.freightCopper, 0, "the settlement does not hire its own ship");
  const underfunded = structuredClone(data);
  underfunded.holdings[0].storage.moneyCopper = preview.outbound.plan.upfrontCopper + 1;
  const noBudget = prepareMarketAuthorityContext({
    data: underfunded, holding: underfunded.holdings[0], marketId: "a",
    outboundQuantities: { "test-freight": 10 }, outboundInsuranceEnabled: false,
    ownShipId: ship.id, isGM: true
  });
  assert.equal(noBudget.outbound.plan.ok, false, "the preview accounts for both market charges and the ship transfer");
  assert.match(noBudget.outbound.plan.reasons.join(" "), /казне поселения/);
  const smallHold = structuredClone(data);
  smallHold.holdings[0].special.ships.list[0].capacityLoadPoints = 20;
  const noSpace = prepareMarketAuthorityContext({
    data: smallHold, holding: smallHold.holdings[0], marketId: "a",
    outboundQuantities: { "test-freight": 10 }, outboundInsuranceEnabled: false,
    ownShipId: ship.id, isGM: true
  });
  assert.equal(noSpace.outbound.plan.ok, false, "a full hold cannot silently use the hired carrier's capacity");

  const dependencies = {
    addMoney: (target, amount) => { target.storage.moneyCopper += amount; },
    appendStorageLog: (target, rows) => { target.storage.log ??= []; target.storage.log.push(...rows); },
    formatCurrency: String
  };
  const workflow = { _addMoney: dependencies.addMoney, _appendStorageLog: dependencies.appendStorageLog };
  const execute = createMarketOperationExecutor({
    getUser: (id) => ({ id, isGM: id === "gm" }),
    getWorkflow: () => workflow,
    now: () => "2026-01-01T00:00:00.000Z",
    updateHolding: async (_id, updater) => {
      const draft = structuredClone(data);
      const result = await updater(draft.holdings[0], draft);
      draft.meta.revision++;
      data = draft;
      return result;
    }
  });
  const operation = {
    type: "outbound", operationId: "owned-sale", holdingId: holding.id,
    expectedRevision: data.meta.revision,
    sourceToken: marketAuthoritySourceToken({ data, holding, marketId: "a" }),
    planToken: preview.outbound.plan.planToken,
    marketId: "a", ownShipId: ship.id, quantities: { "test-freight": 10 }, insuranceEnabled: false
  };
  await assert.rejects(execute(operation, { userId: "player", remote: true }), /permission to send/);
  assert.equal(data.meta.revision, 1, "a storage-only player cannot launch a ship");
  const initialTreasuryCopper = holding.storage.moneyCopper;
  const accepted = await execute(operation, { userId: "gm" });
  assert.equal(accepted.ok, true);
  holding = data.holdings[0];
  ship = holding.special.ships.list[0];
  let order = holding.special.market.outbound.orders[0];
  const finance = (targetHolding, targetShip, sale) => {
    const before = JSON.stringify(targetHolding);
    const money = shipMoneySummary(targetHolding, targetShip, { clockQd: targetShip.timelineQd });
    const outingReport = shipOutingSummary(targetShip, { clockQd: targetShip.timelineQd, obligationsCopper: money.obligationsCopper });
    const result = prepareShipFinancePresentation(targetHolding, targetShip, { money, outingReport, ownSale: sale });
    assert.equal(JSON.stringify(targetHolding), before, "sale finance is a read-only projection of existing records");
    return result;
  };
  assert.ok(order.upfrontCopper > 0, "the sale has paid market costs outside the ship ledger");
  const departedFinance = finance(holding, ship, order);
  assert.equal(departedFinance.outing.netCopper, ship.currentOuting.incomeCopper - ship.currentOuting.expenseCopper - order.upfrontCopper);
  assert.equal(departedFinance.outing.plannedIncomeCopper, order.revenueCopper);
  assert.equal(departedFinance.outing.marketExpenseCopper, order.upfrontCopper);
  assert.equal(order.ownShipId, ship.id, "the ship link survives dispatch normalization");
  assert.equal(order.status, "in-transit");
  assert.equal(holding.storage.resources[0].qty, 40, "the exact batch leaves storage only once");
  assert.equal(ship.activeVoyage.id, operation.operationId);
  assert.equal(ship.activeVoyage.arrivalQd, order.deliveryQd);
  assert.equal((await execute(operation, { userId: "gm" })).replay, true);
  assert.equal(holding.storage.resources[0].qty, 40);
  await assert.rejects(execute({ ...operation, ownShipId: "" }, { userId: "gm" }), /another target/,
    "a replay id cannot silently switch from an owned ship to a hired carrier");
  const restartedExecutor = createMarketOperationExecutor({
    getUser: (id) => ({ id, isGM: true }),
    updateHolding: async (_id, updater) => updater(data.holdings[0], data)
  });
  await assert.rejects(restartedExecutor({ ...operation, ownShipId: "" }, { userId: "gm" }), /another carrier/,
    "persistent replay validation uses the linked order after the executor restarts");
  const lostHolding = structuredClone(holding);
  const lostShip = lostHolding.special.ships.list[0];
  const lostOrder = lostHolding.special.market.outbound.orders[0];
  lostOrder.status = "needsResolution";
  lostOrder.riskStatus = "needsResolution";
  lostOrder.riskProposal = { outcome: "lost" };
  lostOrder.insuranceCoverageRate = 0.5;
  lostOrder.maximumInsurancePayoutCopper = lostOrder.insuredValueCopper;
  const lostWalletBefore = lostShip.onboardCopper;
  const lostTreasuryBefore = lostHolding.storage.moneyCopper;
  const loss = resolveMarketOutboundShipmentRisk({
    holding: lostHolding, orderId: lostOrder.id, outcome: "lost", operationId: "lost-owned-sale", dependencies
  });
  assert.equal(loss.ok, true);
  assert.equal(lostHolding.special.market.outbound.orders[0].status, "lost");
  assert.equal(lostShip.onboardCopper - lostWalletBefore, loss.payoutCopper, "insurance pays the ship wallet");
  assert.equal(lostHolding.storage.moneyCopper, lostTreasuryBefore);
  assert.equal(lostHolding.storage.log.at(-1).roomId, `ship:${lostShip.id}`);
  const lossFinance = finance(lostHolding, lostShip, lostHolding.special.market.outbound.orders[0]);
  assert.equal(lossFinance.pendingPayments.length, 0, "lost cargo cannot promise a future sale payment");
  assert.equal(lossFinance.outing.incomeCopper, loss.payoutCopper, "insurance already credited to the wallet is an actual receipt");
  assert.equal(lossFinance.outing.netCopper, loss.payoutCopper - lostShip.currentOuting.expenseCopper - lostOrder.upfrontCopper);
  assert.equal(resolveMarketOutboundShipmentRisk({
    holding: lostHolding, orderId: lostOrder.id, outcome: "lost", operationId: "lost-owned-sale", dependencies
  }).replay, true);
  assert.equal(lostShip.onboardCopper - lostWalletBefore, loss.payoutCopper, "insurance replay cannot pay twice");
  const clearHolding = structuredClone(holding);
  const clearShip = clearHolding.special.ships.list[0];
  const clearOrder = clearHolding.special.market.outbound.orders[0];
  advanceWorldShips(clearHolding, clearShip.activeVoyage.arrivalQd);
  clearOrder.status = "needsResolution";
  clearOrder.riskStatus = "needsResolution";
  clearOrder.riskProposal = { outcome: "clear" };
  clearOrder.remainingQd = 0;
  const clearResult = resolveMarketOutboundShipmentRisk({
    holding: clearHolding, orderId: clearOrder.id, outcome: "clear", operationId: "clear-arrived-sale", dependencies
  });
  assert.equal(clearResult.delivered?.ok, true, "clearing the risk at the arrived port settles within the current date");
  assert.equal(clearHolding.special.market.outbound.orders[0].status, "delivered");
  assert.equal(clearShip.onboardCopper, clearResult.delivered.revenueCopper + ship.onboardCopper);

  const arrivalQd = ship.activeVoyage.arrivalQd;
  const midpointQd = Math.floor(arrivalQd / 2);
  if (midpointQd > 0) {
    advanceWorldShips(holding, midpointQd);
    holding.gm.calendaria.lastQd = midpointQd;
    advanceMarketOutboundShipments({ holding, elapsedQd: midpointQd, dependencies });
    order = holding.special.market.outbound.orders[0];
    if (order.status === "needsResolution") {
      assert.equal(resolveMarketOutboundShipmentRisk({
        holding, orderId: order.id, outcome: "clear", operationId: "clear-midflight-sale", dependencies
      }).ok, true);
    }
    assert.notEqual(order.status, "delivered", "market time alone cannot deliver before the ship arrives");
    assert.equal(order.remainingQd, ship.activeVoyage.remainingQd);
  }
  advanceWorldShips(holding, arrivalQd);
  holding.gm.calendaria.lastQd = arrivalQd;
  const walletBeforeSale = ship.onboardCopper;
  const treasuryBeforeSale = holding.storage.moneyCopper;
  advanceMarketOutboundShipments({ holding, elapsedQd: arrivalQd - midpointQd, dependencies });
  order = holding.special.market.outbound.orders[0];
  if (order.status === "needsResolution") {
    const resolved = resolveMarketOutboundShipmentRisk({
      holding, orderId: order.id, outcome: "clear", operationId: "clear-owned-sale", dependencies
    });
    assert.equal(resolved.ok, true);
    advanceMarketOutboundShipments({ holding, elapsedQd: order.deliveryQd, dependencies });
    order = holding.special.market.outbound.orders[0];
  }
  assert.equal(order.status, "delivered");
  assert.equal(ship.onboardCopper - walletBeforeSale, order.revenueCopper, "sale revenue belongs to the ship wallet");
  assert.equal(holding.storage.moneyCopper, treasuryBeforeSale, "delivery does not duplicate revenue in the treasury");
  assert.equal(holding.storage.log.at(-1).roomId, `ship:${ship.id}`);
  advanceMarketOutboundShipments({ holding, elapsedQd: 40, dependencies });
  assert.equal(ship.onboardCopper - walletBeforeSale, order.revenueCopper, "repeated processing cannot pay twice");
  assert.equal(finance(holding, ship, order).pendingPayments.length, 0, "a paid sale disappears from expected receipts");
  const returnOffer = quoteWorldShipReturn(data, holding, ship);
  assert.equal(departWorldShip(holding, ship, { operationId: "owned-sale-return", offer: returnOffer, clockQd: ship.timelineQd }).ok, true);
  holding.gm.calendaria.lastQd = ship.activeVoyage.arrivalQd;
  advanceWorldShips(holding, holding.gm.calendaria.lastQd);
  const finalFinance = finance(holding, ship, order).outing;
  assert.equal(finalFinance.ongoing, false);
  assert.equal(finalFinance.canComparePlan, true);
  assert.equal(finalFinance.netCopper, holding.storage.moneyCopper - initialTreasuryCopper,
    "cash result after return reconciles with treasury, including market fees paid before departure");
  assert.notEqual(finalFinance.balanceCopper, finalFinance.netCopper, "returned budget is not profit");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkShipOwnedOutbound();
  console.log("Own-ship outbound sale: booking, ship launch, FIFO cargo, GM/player rights, replay and wallet settlement passed.");
}
