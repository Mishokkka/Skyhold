// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { escapeHtml, rollD6Pool } from "../../../core/helpers.js";
import {
  isMoneyResource,
  normalizeResourceId,
  resourceDef,
  resourceIcon,
  resourceImage,
  resourceItemUuid,
  resourceLabel,
  resourceOptions,
  resourceUnit
} from "../../../core/resources.js";
import { decorateStorageRoom } from "../../../services/storage-service.js";

export const FinanceEconomyDomain = {
async _runTradeForQd(holding, qd = 0, report = null) {
  const days = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 4);
  if (!days) return { sold: 0, buyers: 0, revenue: 0 };
  const buildings = (holding?.buildings?.list ?? []).filter((building) => this._buildingStatus(building).value === "built" && this._buildingFunctions(building).income && building?.income?.trade?.enabled);
  if (!buildings.length) return { sold: 0, buyers: 0, revenue: 0 };

  if (!report.trade || typeof report.trade !== "object") report.trade = { buyers: 0, sold: 0, revenue: 0, purchases: [] };
  if (!Array.isArray(report.trade.purchases)) report.trade.purchases = [];

  let sold = 0;
  let buyersTotal = 0;
  let revenueTotal = 0;
  const rep = Math.max(0, Math.floor(this._safeNumber(this._reputationSummary(holding).total, 0)));
  if (!rep) {
    report?.skipped?.push?.("Торговля: нет Репутации для поиска покупателей.");
    return { sold, buyers: buyersTotal, revenue: revenueTotal };
  }

  const buildingFilters = new Map(buildings.map((building) => [building, this._tradeCandidateFilters(building)]));
  const eligibleShops = () => buildings.filter((building) => this._tradeCandidates(holding, buildingFilters.get(building)).length > 0);

  for (let day = 1; day <= days; day += 1) {
    const rolls = Array.from({ length: rep }, () => Math.ceil(Math.random() * 6));
    const buyers = rolls.filter((die) => die === 6).length;
    if (!buyers) continue;
    buyersTotal += buyers;
    report.trade.buyers += buyers;

    for (let buyer = 1; buyer <= buyers; buyer += 1) {
      const shops = eligibleShops();
      if (!shops.length) {
        report?.skipped?.push?.("Торговля: покупатель не нашел подходящих товаров с отметкой к продаже.");
        break;
      }

      const building = shops[Math.floor(Math.random() * shops.length)];
      const trade = building.income?.trade ?? {};
      const filters = buildingFilters.get(building) ?? this._tradeCandidateFilters(building);
      const assigned = this._assignedBuildingPeople(holding, building);
      const traders = assigned.length ? assigned : [null];
      const traderCount = Math.max(1, traders.length);
      const pickedTrader = traders[Math.floor(Math.random() * traders.length)] ?? null;
      const sellerEff = pickedTrader ? Math.max(0, this._personBuildingEfficiency(holding, building, pickedTrader)) : 1;
      const priceEfficiency = Math.max(0.1, sellerEff || 1);
      const budgetRoll = await this._rollFormulaTotal(String(trade.budgetFormula || "2d6*10"), {
        eff: priceEfficiency,
        workers: traderCount,
        reputation: rep,
        buyers,
        qd,
        days,
        day
      });
      let budget = Math.max(0, Math.floor(this._safeNumber(budgetRoll.total, 0)));
      const lots = Math.max(1, Math.floor(this._safeNumber(trade.maxLotsPerBuyer, 1))) * traderCount;
      let buyerSpent = 0;

      for (let lot = 0; lot < lots && budget > 0; lot += 1) {
        const candidates = this._tradeCandidates(holding, filters).filter((candidate) => this._tradeUnitSalePrice(candidate.basePrice, priceEfficiency) <= budget);
        if (!candidates.length) break;
        const candidate = candidates[Math.floor(Math.random() * candidates.length)];
        const unitPrice = this._tradeUnitSalePrice(candidate.basePrice, priceEfficiency);
        const amount = Math.min(candidate.qty, Math.floor(budget / Math.max(1, unitPrice)));
        if (!amount) break;
        const taken = this._reduceTradeCandidate(candidate, amount);
        if (!taken) break;
        const revenue = taken * unitPrice;
        this._addMoney(holding, revenue);
        budget -= revenue;
        buyerSpent += revenue;
        sold += taken;
        revenueTotal += revenue;
        report.trade.sold += taken;
        report.trade.revenue += revenue;
        report.trade.purchases.push({
          building: building.name || "Здание",
          item: candidate.name,
          qty: taken,
          revenue,
          unitPrice,
          trader: pickedTrader?.name || "",
          efficiency: priceEfficiency
        });
      }

      const traderText = pickedTrader ? `, торговец: ${pickedTrader.name || "житель"}` : ", торговец не назначен";
      if (!buyerSpent) report?.skipped?.push?.(`${building.name || "Здание"}: покупатель ничего не купил, бюджет ${budgetRoll.result} = ${budgetRoll.total}${traderText}.`);
    }
  }
  if (Array.isArray(holding?.storage?.items)) holding.storage.items = holding.storage.items.filter((row) => this._itemQuantity(row) > 0 && Math.max(0, this._safeNumber(row.qty ?? row.itemData?.system?.quantity ?? 1, 1)) > 0);
  return { sold, buyers: buyersTotal, revenue: revenueTotal };
},

_formatStorageLoad(value = 0) {
  const number = this._safeNumber(value, 0);
  if (Math.abs(number - Math.round(number)) < 0.0001) return this._formatNumber(Math.round(number));
  return this._formatNumber(Math.round(number * 100) / 100);
},

_decorateStorageRoom(room = {}) {
  return decorateStorageRoom(room, { formatLoad: (value) => this._formatStorageLoad(value) });
},

_prepareStorageRows(holding, canEdit = false, roomsArg = null, rawRowsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const roomOptionsCache = new Map();
  const optionsFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomOptionsCache.has(id)) roomOptionsCache.set(id, this._storageRoomOptionsFromRooms(rooms, id));
    return roomOptionsCache.get(id);
  };
  const rows = (Array.isArray(rawRowsArg) ? rawRowsArg : (holding?.storage?.resources ?? []))
    .filter((row) => !isMoneyResource(row?.resourceId, row?.name));
  return rows.map((row, index) => {
    const id = normalizeResourceId(row.resourceId, row.name);
    const def = id !== "custom" ? resourceDef(id) : null;
    const label = id === "custom" ? (row.name || "Ресурс") : resourceLabel(id);
    const qty = this._safeNumber(row.qty, 0);
    const roomId = this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
    return {
      ...row,
      _index: Number.isInteger(row.__storageIndex) ? row.__storageIndex : index,
      resourceId: id,
      label,
      icon: resourceIcon(id),
      img: row.img || resourceImage(id),
      itemUuid: row.itemUuid || resourceItemUuid(id),
      category: def?.category ?? "Пользовательское",
      unit: row.unit || resourceUnit(id),
      unitLoad: this._storageUnitLoad(row),
      loadText: this._formatStorageLoad(this._storageRowLoad(row)),
      resourceOptions: resourceOptions(id, row.name, { includeMoney: false }),
      roomId,
      roomLabel: this._storageRoomLabelFromRooms(rooms, roomId),
      roomOptions: optionsFor(roomId),
      priceCopper: this._resourcePriceCopper(row),
      canMarkForSale: this._resourcePriceCopper(row) > 0,
      forSale: this._resourcePriceCopper(row) > 0 && Boolean(row.forSale),
      saleTooltip: this._resourcePriceCopper(row) > 0 ? "Пометить ресурс как доступный для продажи торговцами." : "У ресурса нет цены, поэтому его нельзя отметить к продаже.",
      isCustomResource: id === "custom",
      qty,
      qtyText: this._formatNumber(qty),
      qtyClass: qty > 0 ? "positive" : qty < 0 ? "negative" : "zero",
      isZero: Math.abs(qty) < 0.0001,
      canEdit
    };
  }).sort((a, b) => String(a.roomLabel).localeCompare(String(b.roomLabel), "ru") || String(a.category).localeCompare(String(b.category), "ru") || String(a.label).localeCompare(String(b.label), "ru"));
},

_pushProductionPlacement(report, holding, sourceName, resourceName, placements = [], extra = "") {
  for (const item of placements) {
    const room = item.roomId ? this._storageRoomLabel(holding, item.roomId) : "Счетчик денег";
    const overflow = item.overflowFrom ? ` (переполнение: ${this._storageRoomLabel(holding, item.overflowFrom)})` : "";
    report.produced.push(`${sourceName}: ${resourceName} +${this._formatNumber(item.qty)}${extra} → ${room}${overflow}.`);
  }
},

_setItemQuantityData(itemData = {}, qty = 1) {
  const data = foundry?.utils?.deepClone?.(itemData) ?? JSON.parse(JSON.stringify(itemData));
  if (!data.system || typeof data.system !== "object") data.system = {};
  data.system.quantity = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
  return data;
},

_prepareStorageItemRows(holding, canEdit = false, roomsArg = null, rawRowsArg = null) {
  const rooms = Array.isArray(roomsArg) ? roomsArg : this._storageRooms(holding, { includeUnavailable: true });
  const roomOptionsCache = new Map();
  const optionsFor = (roomId) => {
    const id = this._normalizeStorageRoomId(roomId);
    if (!roomOptionsCache.has(id)) roomOptionsCache.set(id, this._storageRoomOptionsFromRooms(rooms, id));
    return roomOptionsCache.get(id);
  };
  const rows = Array.isArray(rawRowsArg) ? rawRowsArg : (holding?.storage?.items ?? []);
  return rows.map((row, index) => {
    const qty = this._itemQuantity(row);
    const roomId = this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId);
    return {
      ...row,
      _index: Number.isInteger(row.__storageIndex) ? row.__storageIndex : index,
      qty,
      qtyText: this._formatNumber(qty),
      typeLabel: this._itemTypeLabel(row.type ?? row.itemData?.type),
      img: row.img || row.itemData?.img || "icons/svg/item-bag.svg",
      roomId,
      roomLabel: this._storageRoomLabelFromRooms(rooms, roomId),
      roomOptions: optionsFor(roomId),
      loadText: this._formatStorageLoad(this._storageRowLoad(row)),
      priceCopper: this._itemPriceCopper(row),
      canMarkForSale: this._itemPriceCopper(row) > 0,
      forSale: this._itemPriceCopper(row) > 0 && Boolean(row.forSale),
      saleTooltip: this._itemPriceCopper(row) > 0 ? "Пометить предмет как доступный для продажи торговцами." : "У предмета нет цены, поэтому его нельзя отметить к продаже.",
      canEdit
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"));
},

async _removeQuantityFromActorItem(item, amount = 1) {
  const actor = item?.parent;
  const actorDocumentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (!actor || actorDocumentName !== "Actor" || !item.id) return false;
  if (!game.user?.isGM && !actor.isOwner) return false;
  const qty = this._itemQuantity(item);
  const take = Math.max(1, Math.floor(this._safeNumber(amount, 1)));
  if (qty > take && item.update) {
    await item.update({ "system.quantity": qty - take });
    return true;
  }
  if (actor.deleteEmbeddedDocuments) {
    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    return true;
  }
  return false;
},

async _foundryItemDataForResource(resourceId = "custom", name = "Ресурс", qty = 1) {
  const id = normalizeResourceId(resourceId, name);
  const def = id !== "custom" ? resourceDef(id) : null;
  let source = null;
  const uuid = def?.itemUuid || "";
  if (uuid && globalThis.fromUuid) {
    try {
      const doc = await globalThis.fromUuid(uuid);
      if (doc?.toObject) source = doc.toObject();
    } catch (_error) {}
  }
  if (!source) {
    source = {
      name: id === "custom" ? (name || "Ресурс") : resourceLabel(id),
      type: def?.itemType || "rawMaterial",
      img: def?.img || "icons/svg/item-bag.svg",
      system: { quantity: 1, cost: def?.cost || "" }
    };
  }
  return this._setItemQuantityData(source, qty);
},

async _withdrawResourceToActor(holding, { resourceId = "custom", name = "", qty = 1, roomId = "outdoors", actorId = "" } = {}) {
  const actor = actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor();
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  const amount = Math.max(1, Math.floor(this._safeNumber(qty, 1)));
  const id = normalizeResourceId(resourceId, name);
  const label = id === "custom" ? (String(name).trim() || "Ресурс") : resourceLabel(id);
  const room = this._normalizeStorageRoomId(roomId);
  const row = this._storageFind(holding, { resourceId: id, name: label, roomId: room });
  const have = Math.max(0, this._safeNumber(row?.qty, 0));
  if (have + 0.0001 < amount) return { ok: false, message: `В складе нет ${this._formatNumber(amount)} ${label}. Есть ${this._formatNumber(have)}.` };
  const itemData = await this._foundryItemDataForResource(id, label, amount);
  await actor.createEmbeddedDocuments("Item", [itemData]);
  this._storageAdd(holding, { resourceId: id, name: label, roomId: room }, -amount);
  this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: id, name: label, qty: -amount, roomId: room, source: "Выдача Foundry", note: `получатель: ${actor.name}` }]);
  return { ok: true, message: `${actor.name}: выдано ${this._formatNumber(amount)} ${label}.` };
},

async _giveStoredItemToActor(holding, { itemIndex = -1, qty = 1, actorId = "" } = {}) {
  const actor = actorId ? globalThis.game?.actors?.get?.(actorId) : this._storageDefaultActor();
  if (!actor) return { ok: false, message: "У текущего пользователя нет привязанного персонажа-получателя." };
  if (!Array.isArray(holding?.storage?.items)) return { ok: false, message: "В хранилище нет предметов." };
  const index = Number(itemIndex);
  const row = holding.storage.items[index];
  if (!row) return { ok: false, message: "Предмет не найден." };
  const have = this._itemQuantity(row);
  const amount = Math.max(1, Math.min(have, Math.floor(this._safeNumber(qty, 1))));
  const itemData = this._setItemQuantityData(row.itemData ?? row, amount);
  await actor.createEmbeddedDocuments("Item", [itemData]);
  if (have > amount) row.qty = have - amount;
  else row.qty = 0;
  this._appendStorageLog(holding, [{ kind: "manual-spend", resourceId: "custom", name: row.name, qty: -amount, roomId: row.roomId, source: "Выдача Foundry", note: `получатель: ${actor.name}` }]);
  return { ok: true, message: `${actor.name}: выдан предмет ${row.name} (${this._formatNumber(amount)}).` };
},

async _rollFormulaTotal(formula = "", data = {}) {
  const raw = String(formula ?? "").trim();
  if (!raw) return { total: null, result: "" };
  const substituted = raw
    .replace(/@eff\b/g, String(data.eff ?? 0))
    .replace(/@workers\b/g, String(data.workers ?? 0))
    .replace(/@base\b/g, String(data.base ?? 0))
    .replace(/@cycles\b/g, String(data.cycles ?? 0))
    .replace(/@qd\b/g, String(data.qd ?? 0))
    .replace(/@workqd\b/g, String(data.workqd ?? 0));
  try {
    if (globalThis.Roll) {
      const roll = new Roll(substituted);
      await roll.evaluate({ async: true });
      return { total: Number(roll.total) || 0, result: roll.result ?? substituted };
    }
  } catch (error) {
    console.warn("FBL Skyhold | Formula roll failed", raw, error);
  }
  const safe = substituted.replace(/[^0-9+\-*/().\s]/g, "");
  try {
    // Формула уже очищена от всего, кроме чисел и базовых операторов.
    const total = Function(`"use strict"; return (${safe || "0"});`)();
    return { total: Number(total) || 0, result: substituted };
  } catch (_error) {
    return { total: 0, result: `ошибка формулы: ${raw}` };
  }
},

_formatNumber(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  if (Number.isInteger(numeric)) return String(numeric);
  return String(Number(numeric.toFixed(2)));
},

_workQdPerWorker(periodQd = 0) {
  const qd = Math.max(0, Math.floor(this._safeNumber(periodQd, 0)));
  const fullDays = Math.floor(qd / 4);
  const rest = qd % 4;
  return fullDays * 2 + Math.min(rest, 2);
},

_periodLabel(periodQd = 0) {
  const qd = Math.max(0, Math.floor(this._safeNumber(periodQd, 0)));
  if (qd === 1) return "1 QD";
  if (qd === 4) return "1 день";
  if (qd === 40) return "десятник";
  return `${qd} QD`;
},

_scaledCosts(costs = [], cycles = 1) {
  return costs.map((cost) => ({ ...cost, qty: this._safeNumber(cost.qty, 0) * cycles })).filter((cost) => cost.qty > 0);
},

_affordableCycles(holding, costs = [], requestedCycles = 0) {
  let cycles = Math.max(0, Math.floor(requestedCycles));
  if (!cycles || !costs.length) return cycles;
  for (const cost of costs) {
    const perCycle = this._safeNumber(cost.qty, 0);
    if (perCycle <= 0) continue;
    const have = this._storageQuantity(holding, cost);
    cycles = Math.min(cycles, Math.floor(have / perCycle));
  }
  return Math.max(0, cycles);
},

_productionPeriodQd(period = "day") {
  const value = String(period ?? "day");
  if (value === "qd") return 1;
  if (value === "tenday") return 40;
  return 4;
},

_periodOccurrences(period = "day", qd = 0) {
  const step = Math.max(1, this._productionPeriodQd(period));
  return Math.max(0, Math.floor(this._safeNumber(qd, 0) / step));
},

_lineContentQuantity(building, line) {
  const id = String(line?.contentId ?? "");
  if (!id) return 0;
  const item = (building?.contents ?? []).find((row, index) => String(row?.id ?? `content-${index}`) === id);
  return Math.max(0, this._safeNumber(item?.qty ?? item?.quantity ?? item?.count, 0));
},

_collectProductionLine(holding, building, line, { ignoreWorkTime = false } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return { ok: false, message: "Нечего собирать." };
  const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
  if (!ignoreWorkTime && collectQd > 0) {
    const eff = this._safeNumber(this._buildingEffectiveWorkers(holding, building).total, 0);
    const available = Math.max(0, Math.floor(eff * this._workQdPerWorker(1)));
    if (available < collectQd) return { ok: false, message: `Не хватает рабочих QD для сбора (${available}/${collectQd}).` };
  }
  const resourceId = normalizeResourceId(line.resourceId, line.resource);
  const resourceName = resourceId === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(resourceId);
  const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
  const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, pending);
  line.pendingQty = 0;
  return { ok: true, message: `${resourceName}: собрано ${pending}; ${this._storagePlacementText(holding, placements)}.`, resourceId, resourceName, qty: pending, roomId, placements, source: building?.name || "Здание" };
},

_personBuildingEfficiency(holding, building, person) {
  if (!person) return 0;
  let value = 1;
  const originalType = this._workerType(person);
  const match = this._workerTypeEffectForPerson(building, originalType);
  if (match.value) value += match.value;
  const traitEffect = this._workerTraitEffect?.(building, person);
  if (traitEffect?.value) value += traitEffect.value;
  const backgroundEffect = this._workerBackgroundEffect?.(building, person);
  if (backgroundEffect?.value) value += backgroundEffect.value;
  const globalEffect = this._buildingEfficiencyModifier?.(holding, building);
  if (globalEffect?.value) value += globalEffect.value;
  return Math.max(0, value);
},

_assignedBuildingPeople(holding, building) {
  const ids = (building?.assignedWorkerIds ?? []).filter(Boolean).map((id) => String(id));
  const people = holding?.people?.list ?? [];
  return ids.map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
},

_workerBudgetEntry(holding, person, budgets) {
  const id = String(person?.id ?? "");
  const raw = budgets.get(id);
  if (raw && typeof raw === "object") return raw;
  const limit = this._personDailyWorkQdLimit(holding, person);
  const entry = { available: this._safeNumber(raw, 0), spent: 0, limit };
  budgets.set(id, entry);
  return entry;
},

_personDailyWorkQdLimit(holding, person) {
  const assigned = String(person?.workAssignment ?? "");
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === assigned || String(item.name) === assigned);
  if (building && this._buildingHasOvertimeProduction?.(building)) return 3;
  return 2;
},

_resetWorkerBudgets(holding, budgets) {
  budgets.clear();
  for (const person of holding?.people?.list ?? []) {
    budgets.set(String(person.id), { available: 0, spent: 0, limit: this._personDailyWorkQdLimit(holding, person) });
  }
},

_accrueWorkerBudgets(holding, budgets) {
  // Внутри дня житель получает по 1 рабочему QD за прошедший QD,
  // но суммарно не больше дневного лимита: 2 QD обычно, 3 QD при переработке.
  for (const person of holding?.people?.list ?? []) {
    const entry = this._workerBudgetEntry(holding, person, budgets);
    entry.limit = this._personDailyWorkQdLimit(holding, person);
    const room = Math.max(0, entry.limit - entry.spent - entry.available);
    if (room > 0) entry.available += Math.min(1, room);
  }
},

_availableEffectiveWorkQd(holding, building, budgets) {
  let total = 0;
  for (const person of this._assignedBuildingPeople(holding, building)) {
    const entry = this._workerBudgetEntry(holding, person, budgets);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    total += this._personBuildingEfficiency(holding, building, person) * budget;
  }
  return Math.max(0, total);
},

_spendBuildingWorkerQd(holding, building, budgets, needed = 0) {
  // Реальное рабочее время. Используется для сбора: 1 QD сбора всегда стоит 1 QD времени,
  // независимо от производственной эффективности работника.
  let rest = Math.max(0, this._safeNumber(needed, 0));
  let spent = 0;
  if (!rest) return { ok: true, spent: 0 };
  for (const person of this._assignedBuildingPeople(holding, building)) {
    if (rest <= 0) break;
    const entry = this._workerBudgetEntry(holding, person, budgets);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    const take = Math.min(budget, rest);
    entry.available = budget - take;
    entry.spent += take;
    rest -= take;
    spent += take;
  }
  return { ok: rest <= 0.0001, spent };
},

_spendBuildingEffectiveWorkQd(holding, building, budgets, needed = 0) {
  // Производственное время. Эффективные работники покрывают больше эффективных QD
  // тем же реальным временем.
  let rest = Math.max(0, this._safeNumber(needed, 0));
  let spentReal = 0;
  let spentEffective = 0;
  if (!rest) return { ok: true, spent: 0, spentEffective: 0 };
  for (const person of this._assignedBuildingPeople(holding, building)) {
    if (rest <= 0) break;
    const entry = this._workerBudgetEntry(holding, person, budgets);
    const budget = this._safeNumber(entry.available, 0);
    if (budget <= 0) continue;
    const efficiency = Math.max(0.0001, this._personBuildingEfficiency(holding, building, person));
    const realNeeded = rest / efficiency;
    const takeReal = Math.min(budget, realNeeded);
    const takeEffective = takeReal * efficiency;
    entry.available = budget - takeReal;
    entry.spent += takeReal;
    rest -= takeEffective;
    spentReal += takeReal;
    spentEffective += takeEffective;
  }
  return { ok: rest <= 0.0001, spent: spentReal, spentEffective };
},

_periodDueOnStep(period = "day", stepIndex = 0, cyclesPerTrigger = 1) {
  const p = String(period ?? "day");
  const unit = p === "qd" ? 1 : p === "tenday" ? 40 : 4;
  const cycle = Math.max(1, Math.floor(this._safeNumber(cyclesPerTrigger, 1)));
  const span = unit * cycle;
  // stepIndex is zero-based and represents an elapsed QD.
  // A daily line must not fire on the first QD of the day; it fires when a full day has elapsed.
  return (stepIndex + 1) % span === 0;
},

_costsForUnits(costs = [], units = 0) {
  const count = Math.max(0, Math.floor(this._safeNumber(units, 0)));
  return costs.map((cost) => ({ ...cost, qty: this._safeNumber(cost.qty, 0) * count })).filter((cost) => cost.qty > 0);
},

_affordableUnitsForCosts(holding, costs = [], requestedUnits = 0) {
  let units = Math.max(0, Math.floor(this._safeNumber(requestedUnits, 0)));
  if (!units || !costs.length) return units;
  for (const cost of costs) {
    const perUnit = this._safeNumber(cost.qty, 0);
    if (perUnit <= 0) continue;
    const have = this._storageQuantity(holding, cost);
    units = Math.min(units, Math.floor(have / perUnit));
  }
  return Math.max(0, units);
},

async _lineOutputForCycle(line, context = {}) {
  const base = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, 1));
  if (String(line?.formula ?? "").trim()) {
    const rolled = await this._rollFormulaTotal(line.formula, { ...context, base });
    return { qty: Math.max(0, Math.floor(rolled.total)), formula: `${line.formula} → ${rolled.result} = ${rolled.total}` };
  }
  return { qty: Math.max(0, Math.floor(base)), formula: "" };
},

async _collectLineToStorage(holding, building, line, budgets, report, { by = "building", neededResource = "" } = {}) {
  const pending = Math.max(0, Math.floor(this._safeNumber(line?.pendingQty, 0)));
  if (!pending) return 0;
  const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
  if (collectQd > 0) {
    const payer = by === "worker" ? building : building;
    const spent = this._spendBuildingWorkerQd(holding, payer, budgets, collectQd);
    if (!spent.ok) {
      report.skipped.push(`${building.name || "Здание"}: не хватает рабочих QD для сбора (${spent.spent}/${collectQd}).`);
      return 0;
    }
  }
  const resourceId = normalizeResourceId(line.resourceId, line.resource);
  if (neededResource && normalizeResourceId(neededResource) !== resourceId) return 0;
  const resourceName = resourceId === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(resourceId);
  const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
  const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, pending);
  line.pendingQty = 0;
  this._pushProductionPlacement(report, holding, building.name || "Здание", `${resourceName} собрано`, placements, by === "worker" ? " работником-потребителем" : "");
  return pending;
},

async _autoCollectBuilding(holding, building, budgets, report) {
  for (const line of building?.productionLines ?? []) {
    if (!line?.requiresCollection || String(line.autoCollect ?? "none") !== "building") continue;
    await this._collectLineToStorage(holding, building, line, budgets, report, { by: "building" });
  }
},

async _tryCollectResourceForConsumer(holding, consumerBuilding, resourceId, budgets, report) {
  const wanted = normalizeResourceId(resourceId);
  let collected = 0;
  for (const sourceBuilding of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(sourceBuilding).value !== "built") continue;
    for (const line of sourceBuilding?.productionLines ?? []) {
      if (!line?.requiresCollection || String(line.autoCollect ?? "none") !== "worker") continue;
      if (normalizeResourceId(line.resourceId, line.resource) !== wanted) continue;
      // В этом режиме рабочий здания-потребителя тратит время, чтобы забрать готовый ресурс из другого здания.
      const pending = Math.max(0, Math.floor(this._safeNumber(line.pendingQty, 0)));
      if (!pending) continue;
      const collectQd = Math.max(0, this._safeNumber(line.collectQd, 0));
      if (collectQd > 0) {
        const spent = this._spendBuildingWorkerQd(holding, consumerBuilding, budgets, collectQd);
        if (!spent.ok) continue;
      }
      const resourceName = wanted === "custom" ? (String(line.resource ?? "Ресурс") || "Ресурс") : resourceLabel(wanted);
      const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
      const placements = this._storageAddWithOverflow(holding, { resourceId: wanted, name: resourceName, roomId }, pending);
      line.pendingQty = 0;
      collected += pending;
      this._pushProductionPlacement(report, holding, consumerBuilding.name || "Здание", `${resourceName} собрано у ${sourceBuilding.name || "здания"}`, placements);
    }
  }
  return collected;
},

async _runEconomyForQd(holding, periodQd = 40) {
  const qd = Math.max(1, Math.floor(this._safeNumber(periodQd, 40)));
  const label = this._periodLabel(qd);
  const report = { periodQd: qd, periodLabel: label, produced: [], consumed: [], skipped: [], income: [], formulas: [], work: [], food: { needed: 0, eaten: 0, hungryResidentDays: 0, lines: [] }, construction: { attempts: 0, completed: 0, lines: [] }, trade: { buyers: 0, sold: 0, revenue: 0, purchases: [] }, treasury: { spent: 0, deficit: 0, lines: [] } };
  const buildings = holding?.buildings?.list ?? [];
  const budgets = new Map();

  for (let step = 0; step < qd; step += 1) {
    if (step % 4 === 0) this._resetWorkerBudgets(holding, budgets);
    this._accrueWorkerBudgets(holding, budgets);

    // 1. Время и содержимое: ресурс появляется по ходу таймскипа, а не в самом конце.
    const productionSeasonSnapshot = getCalendariaSnapshot?.() ?? null;
    for (const building of buildings) {
      if (this._buildingStatus(building).value !== "built") continue;
      if (!this._buildingFunctions(building).production) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false) continue;
        if (this._lineSeasonAllowed && !this._lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        const source = ["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers";
        if (source === "workers") continue;
        const period = ["qd", "day", "tenday"].includes(String(line.period ?? "")) ? String(line.period) : "day";
        const cycleDuration = Math.max(1, this._safeNumber(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1));
        if (!this._periodDueOnStep(period, step, cycleDuration)) continue;

        const resourceId = normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : resourceLabel(resourceId);
        const multiplier = source === "content" ? this._lineContentQuantity(building, line) : 1;
        if (multiplier <= 0) {
          report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, нет содержимого.`);
          continue;
        }
        const output = await this._lineOutputForCycle(line, { eff: this._safeNumber(this._buildingEffectiveWorkers(holding, building).total, 0), workers: (building.assignedWorkerIds ?? []).filter(Boolean).length, cycles: multiplier, qd: 1, workqd: 0 });
        if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula}`);
        let total = Math.max(0, Math.floor(output.qty * multiplier));
        if (!total) continue;

        const costsPer = this._parseResourceCosts(line.expenses);
        const expenseMode = String(line.expenseMode ?? "cycle") === "unit" ? "unit" : "cycle";
        let costs = [];
        if (costsPer.length) {
          costs = expenseMode === "unit" ? this._costsForUnits(costsPer, total) : this._scaledCosts(costsPer, multiplier);
          const canPay = this._storageCanPay(holding, costs);
          if (!canPay.ok) {
            report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, не хватает ${canPay.missing.map((m) => `${m.name} ${Math.max(0, m.qty - m.have)}`).join(", ")}.`);
            continue;
          }
          this._storagePay(holding, costs);
          report.consumed.push(`${building.name || "Здание"}: ${costs.map((item) => `${item.name} -${item.qty}`).join(", ")}`);
        }

        if (line.requiresCollection) {
          line.pendingQty = Math.max(0, this._safeNumber(line.pendingQty, 0)) + total;
          report.produced.push(`${building.name || "Здание"}: ${resourceName} +${total} готово к сбору.`);
        } else {
          const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
          const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, total);
          this._pushProductionPlacement(report, holding, building.name || "Здание", resourceName, placements);
        }
      }
    }

    // 2. Автосбор работником здания-источника.
    for (const building of buildings) {
      if (this._buildingStatus(building).value !== "built") continue;
      await this._autoCollectBuilding(holding, building, budgets, report);
    }

    // 3. Рабочие линии. Они могут использовать то, что появилось и было собрано выше в этом же QD.
    for (const building of buildings) {
      if (this._buildingStatus(building).value !== "built") continue;
      if (!this._buildingFunctions(building).production) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false) continue;
        if (this._lineSeasonAllowed && !this._lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        const source = ["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers";
        if (source !== "workers") continue;
        const workQd = Math.max(1, this._safeNumber(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1));
        const assignedPeople = this._assignedBuildingPeople(holding, building);
        if (!assignedPeople.length) continue;

        const resourceId = normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : resourceLabel(resourceId);
        const costsPer = this._parseResourceCosts(line.expenses);
        const expenseMode = String(line.expenseMode ?? "cycle") === "unit" ? "unit" : "cycle";

        for (const person of assignedPeople) {
          const entry = this._workerBudgetEntry(holding, person, budgets);
          const efficiency = Math.max(0, this._personBuildingEfficiency(holding, building, person));
          if (efficiency <= 0) continue;

          while (this._safeNumber(entry.available, 0) + 0.0001 >= workQd) {
            const output = await this._lineOutputForCycle(line, {
              eff: efficiency,
              workers: assignedPeople.length,
              cycles: 1,
              qd: 1,
              workqd: workQd
            });
            if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula}`);

            const baseOutput = Math.max(0, this._safeNumber(output.qty, 0));
            const total = String(line.formula ?? "").trim()
              ? Math.floor(baseOutput)
              : Math.floor(baseOutput * efficiency);
            if (!total) break;

            if (costsPer.length) {
              // Перед проверкой сырья пробуем автосбор потребителем для недостающих ресурсов.
              for (const cost of costsPer) {
                const need = expenseMode === "unit" ? cost.qty * total : cost.qty;
                if (this._storageQuantity(holding, cost) < need) await this._tryCollectResourceForConsumer(holding, building, cost.resourceId, budgets, report);
              }
            }

            let actualOutput = total;
            let costs = [];
            if (costsPer.length) {
              if (expenseMode === "unit") {
                actualOutput = this._affordableUnitsForCosts(holding, costsPer, total);
                if (!actualOutput) {
                  report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, не хватает сырья на единицу выхода.`);
                  break;
                }
                costs = this._costsForUnits(costsPer, actualOutput);
              } else {
                costs = this._scaledCosts(costsPer, 1);
                const canPay = this._storageCanPay(holding, costs);
                if (!canPay.ok) {
                  report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, не хватает ${canPay.missing.map((m) => `${m.name} ${Math.max(0, m.qty - m.have)}`).join(", ")}.`);
                  break;
                }
              }
              this._storagePay(holding, costs);
              report.consumed.push(`${building.name || "Здание"}: ${costs.map((item) => `${item.name} -${item.qty}`).join(", ")}`);
            }

            entry.available = this._safeNumber(entry.available, 0) - workQd;
            entry.spent += workQd;
            const roomId = this._normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
            const placements = this._storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, actualOutput);
            this._pushProductionPlacement(report, holding, building.name || "Здание", resourceName, placements, ` (${this._formatNumber(workQd)} QD)`);
          }
        }
      }
    }
  }

  // Доходность пока остается старым блоком “за десятник”. Для меньших периодов она
  // не начисляется, чтобы трактиры и рейсы не дробились странными частями.
  for (const building of buildings) {
    if (this._buildingStatus(building).value !== "built") continue;
    const functions = this._buildingFunctions(building);
    if (!functions.income) continue;
    const incomePeriods = Math.floor(qd / 40);
    if (incomePeriods <= 0) continue;
    const effSummary = this._buildingEffectiveWorkers(holding, building);
    const eff = this._safeNumber(effSummary.total, 0);
    const assigned = (building.assignedWorkerIds ?? []).filter(Boolean).length;
    const income = building.income ?? {};
    const base = this._safeNumber(income.base, 0);
    const perWorker = this._safeNumber(income.perWorker, 0);
    let total = (base + perWorker * eff) * incomePeriods;
    let formulaResult = "";
    if (String(income.formula ?? "").trim()) {
      total = 0;
      for (let i = 0; i < incomePeriods; i += 1) {
        const rolled = await this._rollFormulaTotal(income.formula, { eff, workers: assigned, base, cycles: incomePeriods, qd, workqd: eff * this._workQdPerWorker(qd) });
        total += rolled.total;
        formulaResult = rolled.result;
        report.formulas.push(`${building.name || "Здание"} / Доход ${i + 1}/${incomePeriods}: ${income.formula} → ${rolled.result} = ${rolled.total}`);
      }
    }
    total = Math.max(0, Math.floor(total));
    if (total) {
      this._addMoney(holding, total);
      report.income.push(`${building.name || "Здание"}: Деньги +${total}${formulaResult ? ` (${formulaResult})` : ""}`);
    }
  }

  this._runFoodConsumptionForQd(holding, qd, report);
  this._runConstructionCrewsForQd(holding, qd, report);
  await this._runTradeForQd(holding, qd, report);
  this._runTreasuryCostsForQd(holding, qd, report);

  return report;
},

async _runTenDayEconomy(holding) {
  return this._runEconomyForQd(holding, 40);
},

_runFoodConsumptionForQd(holding, qd = 0, report = null) {
  const days = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 4);
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  const needed = days * people.length;
  if (!needed) return { needed: 0, eaten: 0, hungryResidentDays: 0 };
  let remaining = needed;
  const taken = [];
  for (const row of holding?.storage?.resources ?? []) {
    if (remaining <= 0) break;
    if (!this._isFoodResource(row)) continue;
    const have = Math.max(0, this._safeNumber(row.qty, 0));
    if (!have) continue;
    const take = Math.min(have, remaining);
    row.qty = have - take;
    remaining -= take;
    taken.push(`${row.name || resourceLabel(row.resourceId)} -${this._formatNumber(take)}`);
  }
  const eaten = needed - remaining;
  const hungryResidentDays = Math.max(0, remaining);
  if (report?.food) {
    report.food.needed += needed;
    report.food.eaten += eaten;
    report.food.hungryResidentDays += hungryResidentDays;
    if (taken.length) report.food.lines.push(`Съедено: ${taken.join(", ")}.`);
    if (hungryResidentDays) report.food.lines.push(`Голод: ${hungryResidentDays} человеко-дней без пищи.`);
  }
  return { needed, eaten, hungryResidentDays };
},

_isFoodResource(row = {}) {
  const id = normalizeResourceId(row.resourceId, row.id, row.name);
  const def = resourceDef(id, row.name);
  const text = `${id} ${row.name ?? ""} ${row.category ?? ""} ${def?.category ?? ""} ${(def?.aliases ?? []).join(" ")}`.toLowerCase();
  if (/еда|пища|food|ration|meal/.test(text)) return true;
  return ["bread", "fruits", "grain", "honey", "meat", "milk", "vegetables", "flour"].includes(id);
},

_runConstructionCrewsForQd(holding, qd = 0, report = null) {
  const periods = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 40);
  if (!periods) return { attempts: 0, completed: 0 };
  let attempts = 0;
  let completed = 0;
  for (let period = 0; period < periods; period += 1) {
    for (const building of holding?.buildings?.list ?? []) {
      const status = this._buildingStatus(building).value;
      if (status === "built" || status === "damaged" || status === "paused") continue;
      const crewId = String(building.constructionCrewId ?? "");
      if (!crewId) continue;
      const crew = this._constructionCrew(holding, crewId);
      if (!crew?.count || !crew?.dice) {
        report?.construction?.lines?.push?.(`${building.name || "Здание"}: стройбригада пуста.`);
        continue;
      }
      const difficulty = this._safeNumber(building.buildDifficulty, 0);
      const dicePool = Math.max(1, crew.dice + difficulty);
      const rolls = rollD6Pool(dicePool);
      const successes = rolls.filter((value) => value >= 6).length;
      const oldProgress = this._safeNumber(building.buildProgress, 0);
      const target = Math.max(1, this._safeNumber(building.buildTarget, 6));
      const nextProgress = Math.min(target, oldProgress + successes);
      building.buildProgress = nextProgress;
      building.constructionStatus = nextProgress >= target ? "built" : "building";
      building.status = nextProgress >= target ? "Построено" : "Строится";
      attempts += 1;
      if (nextProgress >= target && oldProgress < target) completed += 1;
      report?.construction?.lines?.push?.(`${building.name || "Здание"}: ${crew.name || "Стройбригада"} ${successes} усп.; ${oldProgress} → ${nextProgress}/${target}.`);
    }
  }
  if (report?.construction) {
    report.construction.attempts += attempts;
    report.construction.completed += completed;
  }
  return { attempts, completed };
},

_summarizeFoodReport(food = {}) {
  const needed = Math.max(0, Math.floor(this._safeNumber(food.needed, 0)));
  const eaten = Math.max(0, Math.floor(this._safeNumber(food.eaten, 0)));
  const hungry = Math.max(0, Math.floor(this._safeNumber(food.hungryResidentDays, 0)));
  const lines = [];
  if (needed) lines.push(`Нужно пищи: ${needed}. Съедено: ${eaten}.`);
  for (const line of food.lines ?? []) if (line) lines.push(String(line));
  if (hungry && !lines.some((line) => /Голод/.test(line))) lines.push(`Голод: ${hungry} человеко-дней без пищи.`);
  return { needed, eaten, hungryResidentDays: hungry, lines, hasRows: lines.length > 0 };
},

_summarizeConstructionReport(construction = {}) {
  const lines = this._summarizeSkippedLines(construction.lines ?? []);
  if (construction.completed) lines.push(`Завершено построек: ${construction.completed}.`);
  return { attempts: construction.attempts ?? 0, completed: construction.completed ?? 0, lines, hasRows: lines.length > 0 };
},

_runTreasuryCostsForQd(holding, qd = 0, report = null) {
  const periods = Math.floor(Math.max(0, this._safeNumber(qd, 0)) / 40);
  if (!periods) return { spent: 0, deficit: 0 };
  const totals = this._prepareTotals(holding);
  const salaryCost = Math.max(0, Math.floor(this._safeNumber(totals.salaryTenDay, 0))) * periods;
  const upkeepCost = Math.max(0, Math.floor(this._safeNumber(totals.upkeepMonth, 0) / 3)) * periods;
  const totalCost = salaryCost + upkeepCost;
  if (!totalCost) return { spent: 0, deficit: 0 };

  const before = this._moneyCopper(holding);
  const spent = Math.min(before, totalCost);
  const deficit = Math.max(0, totalCost - before);
  this._setMoneyCopper(holding, before - spent);

  if (report?.treasury && typeof report.treasury === "object") {
    report.treasury.spent += spent;
    report.treasury.deficit += deficit;
    report.treasury.lines.push(`Расходы за десятник ×${periods}: зарплаты ${this._formatCopperCurrency(salaryCost)}, содержание ${this._formatCopperCurrency(upkeepCost)}.`);
  }
  return { spent, deficit, salaryCost, upkeepCost };
},

_summarizeTradeReport(trade = {}) {
  const buyers = Math.max(0, Math.floor(this._safeNumber(trade.buyers, 0)));
  const revenue = Math.max(0, Math.floor(this._safeNumber(trade.revenue, 0)));
  const purchases = Array.isArray(trade.purchases) ? trade.purchases : [];
  const map = new Map();
  for (const row of purchases) {
    const name = String(row?.item ?? "Товар");
    const current = map.get(name) ?? { name, qty: 0, revenue: 0 };
    current.qty += Math.max(0, this._safeNumber(row?.qty, 0));
    current.revenue += Math.max(0, this._safeNumber(row?.revenue, 0));
    map.set(name, current);
  }
  const soldLines = [...map.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ru"))
    .map((row) => `${row.name} ×${this._formatNumber(row.qty)} за ${this._formatCopperCurrency(row.revenue)}`);
  const lines = [];
  if (buyers || revenue || soldLines.length) {
    lines.push(`Покупателей: ${buyers}.`);
    if (soldLines.length) lines.push(`Куплено: ${soldLines.join("; ")}.`);
    lines.push(`В казну: ${this._formatCopperCurrency(revenue)}.`);
  }
  return { buyers, revenue, soldLines, lines, hasRows: lines.length > 0 };
},

_summarizeTreasuryReport(treasury = {}) {
  const spent = Math.max(0, Math.floor(this._safeNumber(treasury.spent, 0)));
  const deficit = Math.max(0, Math.floor(this._safeNumber(treasury.deficit, 0)));
  const lines = [];
  for (const line of treasury.lines ?? []) if (line) lines.push(String(line));
  if (spent || deficit) {
    lines.push(`Потрачено из казны: ${this._formatCopperCurrency(spent)}.`);
    if (deficit) lines.push(`Дефицит: ${this._formatCopperCurrency(deficit)}.`);
  }
  return { spent, deficit, lines, hasRows: lines.length > 0 };
},

_summarizeSignedLines(items = [], sign = "+") {
  const map = new Map();
  const passthrough = [];
  const signPattern = sign === "+" ? "\\+" : "-";
  const rx = new RegExp(`^(.+?):\\s*(.+?)\\s*${signPattern}\\s*([0-9]+(?:[.,][0-9]+)?)(.*)$`);
  for (const item of items) {
    const text = String(item ?? "");
    const match = text.match(rx);
    if (!match) {
      passthrough.push(text);
      continue;
    }
    const building = match[1].trim();
    const resource = match[2].trim();
    const qty = Number(String(match[3]).replace(",", ".")) || 0;
    const suffix = String(match[4] ?? "").trim();
    const qdMatch = suffix.match(/\(([-+]?\d+(?:[.,]\d+)?)\s*QD(?:;\s*эфф\.\s*([-+]?\d+(?:[.,]\d+)?))?\)/i);
    const cleanSuffix = qdMatch ? suffix.replace(qdMatch[0], "").replace(/[.\s]+$/g, "").trim() : suffix.replace(/[.\s]+$/g, "").trim();
    const key = `${building}|${resource}|${cleanSuffix}`;
    const row = map.get(key) ?? { building, resource, qty: 0, qd: 0, effectiveQd: 0, hasEffectiveQd: false, suffix: cleanSuffix };
    row.qty += qty;
    if (qdMatch) row.qd += Number(String(qdMatch[1]).replace(",", ".")) || 0;
    if (qdMatch?.[2] !== undefined) {
      row.effectiveQd += Number(String(qdMatch[2]).replace(",", ".")) || 0;
      row.hasEffectiveQd = true;
    }
    map.set(key, row);
  }
  const result = [...map.values()].map((row) => {
    const qty = this._formatNumber(row.qty);
    let qd = "";
    if (row.qd) {
      const real = this._formatNumber(row.qd);
      const eff = row.hasEffectiveQd ? `; эфф. ${this._formatNumber(row.effectiveQd)}` : "";
      qd = ` (${real} QD${eff})`;
    }
    const suffix = row.suffix ? ` ${row.suffix}` : "";
    return `${row.building}: ${row.resource} ${sign}${qty}${qd}${suffix}.`;
  });
  return [...result, ...passthrough];
},

_summarizeSkippedLines(items = []) {
  const counts = new Map();
  for (const item of items) {
    const key = String(item ?? "");
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([text, count]) => count > 1 ? `${text} ×${count}` : text);
},

_summarizeEconomyReport(report) {
  return {
    ...report,
    produced: this._summarizeSignedLines(report.produced ?? [], "+"),
    consumed: this._summarizeSignedLines(report.consumed ?? [], "-"),
    income: this._summarizeSignedLines(report.income ?? [], "+"),
    foodSummary: this._summarizeFoodReport(report.food ?? {}),
    constructionSummary: this._summarizeConstructionReport(report.construction ?? {}),
    tradeSummary: this._summarizeTradeReport(report.trade ?? {}),
    treasurySummary: this._summarizeTreasuryReport(report.treasury ?? {}),
    skipped: this._summarizeSkippedLines(report.skipped ?? []),
    formulas: this._summarizeSkippedLines(report.formulas ?? [])
  };
},

async _postEconomyChat(holding, report) {
  report = this._summarizeEconomyReport(report);
  const list = (items) => items.length ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : `<p class="fbls-muted-line">Нет.</p>`;
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>Производство за ${escapeHtml(report.periodLabel || "период")}: ${escapeHtml(holding.name || "Владение")}</h3>
        <p><strong>Период:</strong> ${this._safeNumber(report.periodQd, 0)} QD. Обычный лимит жителя: 2 рабочих QD в сутки; на линиях с переработкой — до 3 рабочих QD. Эффективность увеличивает результат, но не добавляет физическое рабочее время.</p>
        <h4>Пища</h4>${report.foodSummary?.hasRows ? list(report.foodSummary.lines) : `<p class="fbls-muted-line">Нет ежедневного потребления.</p>`}
        <h4>Произведено</h4>${list(report.produced)}
        <h4>Доход</h4>${list(report.income)}
        ${report.constructionSummary?.hasRows ? `<h4>Строительство</h4>${list(report.constructionSummary.lines)}` : ""}
        ${report.tradeSummary?.hasRows ? `<h4>Торговля</h4>${list(report.tradeSummary.lines)}` : ""}
        ${report.treasurySummary?.hasRows ? `<h4>Казна</h4>${list(report.treasurySummary.lines)}` : ""}
        <h4>Расходы производства</h4>${list(report.consumed)}
        ${report.formulas.length ? `<h4>Формулы</h4>${list(report.formulas)}` : ""}
        ${report.skipped.length ? `<h4>Не выполнено</h4>${list(report.skipped)}` : ""}
        <p><em>Доходность зданий и расходы казны считаются только за полные десятники внутри выбранного периода.</em></p>
      </div>
    `
  });
},

async _postTenDayEconomyChat(holding, report) {
  return this._postEconomyChat(holding, report);
}
};
