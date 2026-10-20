import {
  availableResourceBatchInventory,
  internalDemandBatchClockQd,
  resourceBatchAvailableToInternalDemand,
  takeResourceBatchById
} from "../../../core/resource-batches.js";
import {
  normalizeResourceId,
  resourceBasePriceCopper,
  resourceCategoryTag,
  resourceDef,
  resourceLabel
} from "../../../core/resources.js";
import {
  applyInternalDemandPlan,
  buildInternalDemandPools,
  planInternalDemand
} from "../../../engines/economy/internal-demand.js";
import { appendEconomyLedger } from "../../../engines/economy/ledger.js";
import { perishableStorageExpiresInQd } from "../../../engines/economy/perishable-storage.js";
import { settlementHungerFactor } from "../../../engines/economy/hunger.js";
import { normalizeInternalDemandConfig, normalizeInternalDemandTrade } from "../../../data/economy/internal-demand.js";
import { isResidentInPopulation } from "../../../data/resident-presence.js";
import { politicsRuntimeEffects } from "../../../engines/politics/runtime-effects.js";

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value = "") {
  return String(value ?? "").trim();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, finite(value, min)));
}

export const FinanceInternalDemandDomain = {
_internalDemandConfig(holding = {}) {
  return normalizeInternalDemandConfig(holding?.gm?.economy?.internalDemand);
},

_internalDemandSatisfactionFactor(holding, config = this._internalDemandConfig(holding)) {
  let satisfaction = config.satisfactionOverrideFactor;
  if (satisfaction === null) {
    const living = (holding?.people?.list ?? []).filter((person) => person && isResidentInPopulation(person, holding));
    if (!living.length) satisfaction = 1;
    else {
      const total = living.reduce((sum, person) => {
        const calculated = this._calculatePersonMorale?.(person, holding);
        return sum + finite(calculated?.total ?? person?.moraleDelta, 0);
      }, 0);
      const average = total / living.length;
      satisfaction = clamp(1 + average / config.moraleScale, config.minimumSatisfactionFactor, config.maximumSatisfactionFactor);
    }
  }
  return clamp(satisfaction * settlementHungerFactor(holding), 0, config.maximumSatisfactionFactor);
},

_internalDemandWagePaymentRatio(financeContext = null) {
  const wages = (financeContext?.result?.currentObligations ?? []).filter((row) => row?.kind === "wage");
  const due = wages.reduce((sum, row) => sum + whole(row?.dueCopper), 0);
  if (!due) return 1;
  const paid = wages.reduce((sum, row) => sum + Math.min(whole(row?.dueCopper), whole(row?.paidCopper)), 0);
  return clamp(paid / due, 0, 1);
},

_internalDemandChannels(holding, financeContext = null, tendayCount = 1, workerContext = null) {
  const channels = [];
  const innVisitorSources = [];
  const marketFlowSources = [];
  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    if (!this._buildingFunctions(building).income || !this._financeFunctionAllowed(financeContext, building, "income")) continue;
    const trade = normalizeInternalDemandTrade(building?.income?.trade, { building });
    if (!trade.enabled) continue;
    const assignedPeople = this._activeAssignedBuildingPeople(holding, building, workerContext, "income");
    const assigned = assignedPeople.length;
    if (!assigned) continue;
    const normalCapacityQd = 20 * Math.max(1, tendayCount);
    const workerShares = assignedPeople.map((person) => {
      const plannedQd = workerContext?.financeContext
        ? Math.max(0, finite(this._plannedWorkerFunctionQd(person, workerContext, building?.id, "income"), 0))
        : normalCapacityQd;
      return Math.min(1.5, plannedQd / normalCapacityQd);
    });
    const staffedWorkers = workerShares.reduce((sum, share) => sum + share, 0);
    const sellerWorkerEfficiency = assignedPeople.reduce((sum, person, index) => (
      sum + Math.max(0, finite(this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "trade" }), 0)) * workerShares[index]
    ), 0);
    const maintenanceFactor = this._maintenanceEfficiencyFactor?.(building) ?? 1;
    const effectiveWorkers = sellerWorkerEfficiency * maintenanceFactor;
    if (!effectiveWorkers) continue;
    const sellerEfficiency = staffedWorkers > 0 ? sellerWorkerEfficiency / staffedWorkers : 0;
    const buildingId = text(building.id);
    channels.push({
      id: `internal-demand:${buildingId}`,
      buildingId,
      label: text(building.name || "Торговая точка"),
      sourceIds: trade.sourceIds,
      allowedTags: trade.allowedTags,
      allowedKinds: trade.kind === "resources" ? ["resource"] : (trade.kind === "items" ? ["item"] : ["resource", "item", "service"]),
      roomId: trade.roomId,
      throughputUnits: Math.floor(effectiveWorkers * trade.throughputUnitsPerWorker * tendayCount),
      sellerEfficiency,
      sellerName: assigned === 1 ? text(assignedPeople[0]?.name || "торговец") : `${assigned} торговцев`,
      priority: trade.gmPriority,
      diminishingFactor: 1
    });
    const demandBudget = Math.floor((trade.demandBudgetBaseCopper + trade.demandBudgetPerWorkerCopper * effectiveWorkers) * tendayCount);
    const sourceRow = { id: buildingId, budgetCopper: demandBudget, priority: trade.gmPriority, active: demandBudget > 0 };
    if (trade.demandSource === "inn-visitors") innVisitorSources.push(sourceRow);
    if (trade.demandSource === "market-flow") marketFlowSources.push(sourceRow);
    if (trade.service.enabled && trade.service.categoryTag && trade.service.basePriceCopper > 0 && trade.service.unitsPerWorker > 0) {
      channels[channels.length - 1].service = trade.service;
      channels[channels.length - 1].serviceQty = Math.floor(effectiveWorkers * trade.service.unitsPerWorker * tendayCount);
    }
  }
  return { channels, innVisitorSources, marketFlowSources };
},

_internalDemandCandidates(holding, channels = []) {
  const candidates = [];
  for (const row of holding?.storage?.resources ?? []) {
    if (!row?.forSale) continue;
    const batches = availableResourceBatchInventory(row, holding)
      .filter((batch) => resourceBatchAvailableToInternalDemand(batch, holding));
    if (!batches.length) continue;
    const resourceId = normalizeResourceId(row.resourceId, row.name);
    const definition = resourceId === "custom" ? row : resourceDef(resourceId);
    const basePriceCopper = resourceBasePriceCopper(definition);
    if (!basePriceCopper) continue;
    for (const batch of batches) {
      candidates.push({
        id: `resource:${text(row.id)}:${text(batch.id)}`,
        kind: "resource",
        name: resourceId === "custom" ? text(row.name || "Ресурс") : resourceLabel(resourceId),
        qty: whole(batch.qty),
        basePriceCopper,
        categoryTag: resourceCategoryTag(definition),
        marketTags: definition?.marketTags ?? [],
        expiresInQd: perishableStorageExpiresInQd(holding, row, batch.ageQd),
        ageQd: whole(batch.ageQd),
        roomId: text(row.roomId ?? row.storageRoomId ?? "outdoors"),
        resourceId,
        storageRowId: text(row.id),
        batchId: text(batch.id),
        snapshot: row
      });
    }
  }
  for (const row of holding?.storage?.items ?? []) {
    if (!row?.forSale) continue;
    if (whole(row.internalDemandAvailableFromQd) > internalDemandBatchClockQd(holding)) continue;
    const qty = whole(this._itemQuantity(row));
    const basePriceCopper = whole(this._itemPriceCopper(row));
    if (!qty || !basePriceCopper) continue;
    candidates.push({
      id: `item:${text(row.id)}`,
      kind: "item",
      name: text(row.name ?? row.itemData?.name ?? "Предмет"),
      qty,
      basePriceCopper,
      categoryTag: "item",
      marketTags: [text(row.itemData?.type ?? row.itemType ?? "item")],
      roomId: text(row.roomId ?? row.storageRoomId ?? "outdoors"),
      itemId: text(row.id),
      snapshot: row
    });
  }
  for (const channel of channels) {
    if (!channel.service || !whole(channel.serviceQty)) continue;
    candidates.push({
      id: `service:${channel.id}`,
      kind: "service",
      name: `${channel.label}: ночлег и развлечения`,
      qty: whole(channel.serviceQty),
      basePriceCopper: whole(channel.service.basePriceCopper),
      categoryTag: text(channel.service.categoryTag),
      tags: [text(channel.service.categoryTag), "service"],
      sourceIds: ["inn-visitors"],
      channelId: channel.id,
      snapshot: { ephemeral: true }
    });
  }
  return candidates;
},

_runInternalDemandForQd(holding, qd = 40, report = null, financeContext = null, { operationId = "", workerContext = null } = {}) {
  const tendayCount = Math.floor(whole(qd) / 40);
  if (!tendayCount) return { ok: true, skipped: true, plan: null };
  const config = this._internalDemandConfig(holding);
  const channelData = this._internalDemandChannels(holding, financeContext, tendayCount, workerContext);
  const livingCount = (holding?.people?.list ?? []).filter((person) => person && isResidentInPopulation(person, holding)).length;
  const pools = buildInternalDemandPools({
    populationCount: livingCount,
    populationBudgetPerResidentCopper: config.populationBudgetPerResidentCopper * tendayCount,
    satisfactionFactor: this._internalDemandSatisfactionFactor(holding, config),
    wagePaymentRatio: this._internalDemandWagePaymentRatio(financeContext),
    innVisitorSources: channelData.innVisitorSources,
    marketFlowSources: channelData.marketFlowSources,
    priorities: config.priorities
  });
  const flowPercent = politicsRuntimeEffects(holding)?.externalFlowPercent ?? 0;
  const flowPool = pools.find((pool) => pool.id === "market-flow");
  if (flowPool && flowPercent) flowPool.budgetCopper = Math.max(0,
    Math.floor(flowPool.budgetCopper * Math.max(0, 1 + flowPercent / 100)));
  const candidates = this._internalDemandCandidates(holding, channelData.channels);
  const plan = planInternalDemand({ pools, channels: channelData.channels, candidates, operationId });
  const applied = applyInternalDemandPlan({
    plan,
    candidates,
    report,
    dependencies: {
      candidateQuantity: (candidate) => {
        if (candidate.kind === "service") return whole(candidate.qty);
        if (candidate.kind === "item") {
          if (whole(candidate.snapshot?.internalDemandAvailableFromQd) > internalDemandBatchClockQd(holding)) return 0;
          return whole(this._itemQuantity(candidate.snapshot));
        }
        const batch = availableResourceBatchInventory(candidate.snapshot, holding)
          .find((row) => text(row.id) === text(candidate.batchId));
        return batch && resourceBatchAvailableToInternalDemand(batch, holding) ? whole(batch.qty) : 0;
      },
      takeCandidate: (candidate, amount) => {
        if (candidate.kind === "service") {
          const taken = Math.min(whole(candidate.qty), whole(amount));
          candidate.qty -= taken;
          return taken;
        }
        if (candidate.kind === "item") return this._reduceTradeCandidate({ kind: "item", row: candidate.snapshot }, amount);
        return takeResourceBatchById(candidate.snapshot, candidate.batchId, amount, { holding })?.qty ?? 0;
      },
      addMoney: (amount) => this._addMoney(holding, amount),
      appendLedger: (targetReport, entries) => appendEconomyLedger(targetReport, entries)
    }
  });
  if (!applied.ok) return { ...applied, plan };
  if (report) {
    report.trade ??= { buyers: 0, sold: 0, revenue: 0, purchases: [] };
    report.trade.demandSources = plan.pools.filter((pool) => pool.spentCopper > 0).length;
    report.trade.sold += applied.soldUnits;
    report.trade.revenue += applied.revenueCopper;
    report.trade.purchases.push(...plan.sales);
    report.work?.push?.(`Внутренний спрос: продано ${applied.soldUnits} ед., выручка ${applied.revenueCopper} ММ; неиспользованный спрос сгорел.`);
  }
  return { ok: true, plan, applied, pools, channels: channelData.channels, candidates };
}
};
