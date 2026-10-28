import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marketShipmentRiskContext } from "../apps/market/shipment-context.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { advanceMarketShipments, createMarketShipment, deliverMarketShipmentNow, resolveMarketShipmentRisk } from "../engines/market/shipment.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function holding(moneyCopper = 1000) {
  return {
    id: "shipment-resolution-test",
    storage: { moneyCopper, resources: [], items: [], log: [] },
    special: { market: { orders: [] } }
  };
}

function plan({ deliveryQd = 3, lossChance = 0.08, delayChance = 0.4, maxDelayQd = 4 } = {}) {
  return {
    ok: true,
    deliveryMode: "scheduled",
    deliveryQd,
    standardDeliveryQd: deliveryQd,
    serviceLevel: "standard",
    marketId: "risk-market",
    marketLabel: "Рынок риска",
    quoteKey: "risk-quote-v1",
    targetRoomId: "outdoors",
    subtotalCopper: 80,
    deliveryCopper: 20,
    totalCopper: 100,
    totalLoad: 1,
    billableLoad: 1,
    insuranceCopper: 4,
    insuranceCoverageRate: 0.5,
    insuredValueCopper: 80,
    maximumInsurancePayoutCopper: 40,
    riskLossChance: lossChance,
    riskDelayChance: delayChance,
    riskMaxDelayQd: maxDelayQd,
    logistics: { originRegionId: "origin", destinationRegionId: "destination", distanceKm: 100 },
    lines: [{
      id: "wood-offer",
      stockOfferId: "wood-offer",
      sourceType: "resource",
      resourceId: "wood",
      name: "Древесина",
      qty: 1,
      unitPriceCopper: 80,
      load: 1
    }]
  };
}

const dependencies = {
  addMoney: (target, amount) => { target.storage.moneyCopper += Number(amount) || 0; },
  storageAddWithOverflow: (target, resource, qty) => {
    target.storage.resources.push({ ...resource, qty });
    return [{ roomId: resource.roomId, qty }];
  },
  snapshotItemForStorage: (item, qty, roomId) => ({ name: item.name, qty, roomId }),
  appendStorageLog: (target, entries) => { target.storage.log.push(...entries); },
  formatCurrency: (value) => `${value} ММ`,
  internalDemandAvailableFromQd: (target) => Math.max(0, Number(target?.gm?.calendaria?.lastQd) || 0) + 40
};
const manualDeliveryDependencies = {
  ...dependencies,
  internalDemandAvailableFromQd: (target) => Math.max(0, Number(target?.gm?.calendaria?.lastQd) || 0)
};

const lossRisk = { ...dependencies, riskUnit: (seed) => seed.endsWith("|loss") ? 0 : 0.99 };
const delayRisk = {
  ...dependencies,
  riskUnit: (seed) => seed.endsWith("|loss") ? 0.99 : (seed.endsWith("|delay") ? 0 : 0.49)
};
const clearRisk = { ...dependencies, riskUnit: () => 0.99 };

const isolated = holding();
const incident = createMarketShipment({ holding: isolated, plan: plan(), operationId: "incident", createdAt: "2026-08-11T00:00:00.000Z", dependencies });
const safe = createMarketShipment({ holding: isolated, plan: plan({ deliveryQd: 1, lossChance: 0, delayChance: 0 }), operationId: "safe", createdAt: "2026-08-11T00:00:00.000Z", dependencies });
assert.equal(incident.ok, true);
assert.equal(safe.ok, true);
assert.ok(incident.order.riskSeed, "shipment creation must persist the hidden deterministic seed before the first tick");
const fixedSeed = incident.order.riskSeed;
const isolatedTick = advanceMarketShipments({ holding: isolated, elapsedQd: 1, deliveredAt: "2026-08-11T01:00:00.000Z", dependencies: lossRisk });
assert.equal(isolatedTick.ok, true);
assert.equal(isolatedTick.needsResolution.length, 1);
assert.equal(isolatedTick.delivered.length, 1, "an unresolved incident must not block another shipment or the tenday transaction");
assert.equal(incident.order.status, "needsResolution");
assert.equal(incident.order.remainingQd, 3, "the affected shipment must stop without consuming its incident tick");
assert.equal(incident.order.riskSeed, fixedSeed, "risk evaluation must reuse the seed fixed at order creation");
assert.equal(isolated.storage.moneyCopper, 800, "an unresolved proposed loss must not pay insurance");
assert.equal(isolated.storage.log.some((row) => row.kind === "market-insurance"), false);
const waitingTick = advanceMarketShipments({ holding: isolated, elapsedQd: 40, deliveredAt: "2026-08-12T00:00:00.000Z", dependencies: clearRisk });
assert.equal(waitingTick.ok, true);
assert.equal(waitingTick.needsResolution.length, 1);
assert.equal(incident.order.remainingQd, 3, "no GM reaction must block only the affected shipment on later periods");
const forcedWhileBlocked = deliverMarketShipmentNow({ holding: isolated, orderId: "incident", dependencies });
assert.equal(forcedWhileBlocked.delivered.length, 0, "manual arrival must not bypass a pending GM risk resolution");

const manualHolding = holding(200);
const manualShipment = createMarketShipment({ holding: manualHolding, plan: plan(), operationId: "manual-arrival", createdAt: "2026-08-11T00:00:00.000Z", dependencies });
const manualArrival = deliverMarketShipmentNow({ holding: manualHolding, orderId: "manual-arrival", deliveredAt: "2026-08-11T00:30:00.000Z", dependencies: manualDeliveryDependencies });
assert.equal(manualArrival.delivered.length, 1);
assert.equal(manualArrival.delivered[0].riskWaived, true, "GM manual delivery must explicitly audit waiver of an unevaluated risk");
assert.equal(manualShipment.order.status, "delivered");
assert.equal(manualShipment.order.riskStatus, "waived");
assert.equal(manualHolding.storage.resources[0].batches[0].internalDemandAvailableFromQd, 0, "manual delivery between periods must be eligible when the next Apply starts");
assert.equal(manualShipment.order.riskOutcome, "waived");
assert.equal(manualShipment.order.riskResolutionChoice, "manual-delivery");
assert.equal(manualShipment.order.riskResolvedAt, "2026-08-11T00:30:00.000Z");
assert.equal(manualShipment.order.riskResolutionOperationId, "manual-arrival:risk:v2:manual-delivery");
assert.equal(manualHolding.storage.log.some((row) => row.kind === "market-insurance"), false, "manual risk waiver must never trigger insurance");
const normalizedManual = mergeHoldingDefaults(manualHolding).special.market.orders[0];
assert.equal(normalizedManual.riskResolutionChoice, "manual-delivery", "manual waiver audit fields must survive normalization");

const playerRisk = marketShipmentRiskContext(incident.order, { isGM: false });
assert.equal(playerRisk.genericEventText, "С поставкой произошло событие. Эта партия ожидает решения GM.");
assert.equal(playerRisk.canResolveRisk, false);
assert.equal(playerRisk.gmResolution, null, "player context must not reveal the proposed loss/delay or rolls");
assert.equal(JSON.stringify(playerRisk).includes("lost"), false);
const gmRisk = marketShipmentRiskContext(incident.order, { isGM: true, formatPercent: (value) => `${value}`, formatCurrency: (value) => `${value} ММ` });
assert.equal(gmRisk.canResolveRisk, true);
assert.equal(gmRisk.gmResolution.proposalOutcome, "lost");
assert.match(gmRisk.gmResolution.lossCheckText, /0/);
assert.match(gmRisk.gmResolution.insuranceText, /40 ММ/);

const cleared = resolveMarketShipmentRisk({ holding: isolated, orderId: "incident", outcome: "clear", operationId: "incident:gm", resolvedAt: "2026-08-12T01:00:00.000Z", dependencies });
assert.equal(cleared.ok, true);
assert.equal(cleared.outcome, "clear", "GM must be able to cancel a proposed loss");
assert.equal(incident.order.status, "in-transit");
assert.equal(incident.order.riskResolutionChoice, "cancelled");
assert.equal(isolated.storage.moneyCopper, 800);
const clearReplay = resolveMarketShipmentRisk({ holding: isolated, orderId: "incident", outcome: "lost", operationId: "incident:other", dependencies });
assert.equal(clearReplay.replay, true, "a resolved event must be immutable and replay-safe even under a different retry payload");
assert.equal(clearReplay.outcome, "clear");

const delayedHolding = holding(200);
const delayed = createMarketShipment({ holding: delayedHolding, plan: plan(), operationId: "delayed", dependencies });
advanceMarketShipments({ holding: delayedHolding, elapsedQd: 1, dependencies: delayRisk });
assert.equal(delayed.order.status, "needsResolution");
const appliedProposal = resolveMarketShipmentRisk({ holding: delayedHolding, orderId: "delayed", outcome: "proposal", operationId: "delayed:gm", dependencies });
assert.equal(appliedProposal.outcome, "delayed", "GM must be able to apply the deterministic proposal unchanged");
assert.equal(appliedProposal.delayQd, 2);
assert.equal(delayed.order.remainingQd, 5);

const changedHolding = holding(200);
createMarketShipment({ holding: changedHolding, plan: plan(), operationId: "changed", dependencies });
advanceMarketShipments({ holding: changedHolding, elapsedQd: 1, dependencies: delayRisk });
assert.equal(changedHolding.storage.moneyCopper, 100);
const changedToLoss = resolveMarketShipmentRisk({ holding: changedHolding, orderId: "changed", outcome: "lost", operationId: "changed:gm", resolvedAt: "2026-08-11T03:00:00.000Z", dependencies });
assert.equal(changedToLoss.outcome, "lost", "GM must be able to replace a proposed delay with loss");
assert.equal(changedToLoss.payoutCopper, 40);
assert.equal(changedHolding.storage.moneyCopper, 140, "insurance must pay only inside the GM loss resolution");
assert.equal(changedHolding.storage.log.filter((row) => row.kind === "market-insurance").length, 1);
const changedReplay = resolveMarketShipmentRisk({ holding: changedHolding, orderId: "changed", outcome: "lost", operationId: "changed:gm", dependencies });
assert.equal(changedReplay.replay, true);
assert.equal(changedHolding.storage.moneyCopper, 140);
assert.equal(changedHolding.storage.log.filter((row) => row.kind === "market-insurance").length, 1, "insurance payout must be idempotent");

const noEventHolding = holding(200);
const noEvent = createMarketShipment({ holding: noEventHolding, plan: plan({ deliveryQd: 1 }), operationId: "clear-route", dependencies });
const noEventTick = advanceMarketShipments({ holding: noEventHolding, elapsedQd: 1, dependencies: clearRisk });
assert.equal(noEventTick.needsResolution.length, 0, "a clear deterministic check must never create a GM event");
assert.equal(noEvent.order.riskOutcome, "clear");
assert.equal(noEvent.order.status, "delivered");
assert.equal(noEventHolding.storage.resources[0].batches[0].internalDemandAvailableFromQd, 40, "scheduled resource cargo must retain the next-boundary cooldown");

const scheduledItemHolding = holding(200);
scheduledItemHolding.special.market.orders.push({
  id: "scheduled-item",
  operationId: "scheduled-item",
  status: "in-transit",
  dispatchStatus: "departed",
  riskStatus: "clear",
  remainingQd: 0,
  targetRoomId: "outdoors",
  marketLabel: "Рынок риска",
  cargo: [{ sourceType: "item", qty: 1, targetRoomId: "outdoors", item: { id: "item-snapshot", name: "Item cargo", qty: 1 } }]
});
const scheduledItemTick = advanceMarketShipments({ holding: scheduledItemHolding, elapsedQd: 1, dependencies: clearRisk });
assert.equal(scheduledItemTick.delivered.length, 1);
assert.equal(scheduledItemHolding.storage.items[0].internalDemandAvailableFromQd, 40, "scheduled Item cargo must use the same next-tenday boundary as resources");

const unresolvedHolding = holding(200);
const unresolved = createMarketShipment({ holding: unresolvedHolding, plan: plan(), operationId: "normalize-event", dependencies });
advanceMarketShipments({ holding: unresolvedHolding, elapsedQd: 1, dependencies: lossRisk });
const normalized = mergeHoldingDefaults(unresolvedHolding).special.market.orders[0];
assert.equal(normalized.status, "needsResolution");
assert.equal(normalized.riskStatus, "needsResolution");
assert.equal(normalized.riskProposal.outcome, "lost");
assert.equal(normalized.riskSeed, unresolved.order.riskSeed);

// Runtime now resolves physical transport incidents rather than each old shipment separately.
const appSource = readFileSync(path.join(root, "scripts/apps/transport-app.js"), "utf8");
const executorSource = readFileSync(path.join(root, "scripts/apps/transport-operation-executor.js"), "utf8");
const template = readFileSync(path.join(root, "templates/transport-app.hbs"), "utf8");
assert.match(executorSource, /const gmOnly = \[[^\]]*"transport-incident"/, "physical incident resolution is GM-only");
assert.match(executorSource, /if \(gmOnly && !user\.isGM\) throw/, "authority rejects non-GM resolution");
assert.ok(executorSource.indexOf("return transaction(") < executorSource.indexOf("resolveTransportIncident("), "incident resolution is transactional");
assert.match(executorSource, /op\.expectedRevision !== data\.meta\.revision \|\| op\.sourceToken !== transportSourceToken/, "incident resolution rejects stale shared event state");
assert.match(appSource, /const incidents = permissions\.isGM \?/, "players never receive incident controls in their normal window context");
for (const outcome of ["success", "delay", "loss"]) {
  assert.ok(template.includes(`data-action="transport-incident-${outcome}"`), `GM UI must expose ${outcome} resolution`);
}

console.log("FBL Skyhold shipment resolution: deterministic proposal, isolated blocking, explicit manual-delivery waiver, hidden player context, GM overrides and deferred replay-safe insurance passed.");
