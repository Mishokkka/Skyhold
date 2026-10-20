// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { sellerUnitSalePrice } from "../../../engines/workers/seller-qualification.js";
import {
  isMoneyResource,
  normalizeResourceId,
  resourceLabel
} from "../../../core/resources.js";

export const FinanceTradeDomain = {
_tradeStorageRoomOptions(holding, selected = "all") {
  const current = String(selected ?? "all").trim() || "all";
  const options = [{ value: "all", label: "Все склады", selected: current === "all" }];
  for (const room of this._storageRooms(holding, { includeUnavailable: true })) {
    if (!room.available && room.source !== "base") continue;
    options.push({ value: room.id, label: room.label, selected: room.id === current });
  }
  if (current !== "all" && !options.some((option) => option.value === current)) options.push({ value: current, label: `${current} (нет в списке)`, selected: true });
  return options;
},

_tradeKindOptions(selected = "all") {
  const current = ["all", "resources", "items"].includes(String(selected ?? "all")) ? String(selected ?? "all") : "all";
  return [
    { value: "all", label: "Все", selected: current === "all" },
    { value: "resources", label: "Ресурсы", selected: current === "resources" },
    { value: "items", label: "Предметы", selected: current === "items" }
  ];
},

_tradeEfficiencySummary(holding, building, workerContext = null) {
  const assigned = this._activeAssignedBuildingPeople?.(holding, building, workerContext, "income")
    ?? this._assignedBuildingPeople?.(holding, building, workerContext, "income")
    ?? [];
  const values = assigned.map((person) => Math.max(0, this._personBuildingEfficiency(holding, building, person, workerContext, { purpose: "trade" })));
  const clean = values.length ? values : [0];
  const total = clean.reduce((sum, value) => sum + value, 0);
  const average = total / clean.length;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const text = Math.abs(min - max) < 0.0001
    ? this._formatNumber(average)
    : `${this._formatNumber(min)}–${this._formatNumber(max)}`;
  const title = assigned.length
    ? `Цена определяется средней эффективностью назначенных продавцов: ${this._formatNumber(average)}. 1 = 50% базовой цены, 2 = 100%, 3 = 150%; итог ограничен диапазоном ×0,5–×1,5.`
    : "Торговцы не назначены: здание не продаёт товары.";
  return { value: average, min, max, text, title, assigned: assigned.length };
},

_tradeUnitSalePrice(baseCopper = 0, efficiency = 1) {
  return sellerUnitSalePrice(baseCopper, efficiency);
},

_tradeCandidateFilters(building = {}) {
  const trade = building?.income?.trade && typeof building.income.trade === "object" ? building.income.trade : {};
  const roomId = String(trade.roomId ?? trade.storageRoomId ?? "all").trim() || "all";
  const kind = ["all", "resources", "items"].includes(String(trade.kind ?? trade.saleKind ?? "all")) ? String(trade.kind ?? trade.saleKind ?? "all") : "all";
  return { roomId, kind };
},

_tradeCandidateAllowed(candidate, filters = {}) {
  const roomId = String(filters.roomId ?? "all").trim() || "all";
  const kind = String(filters.kind ?? "all").trim() || "all";
  if (roomId !== "all" && this._normalizeStorageRoomId(candidate.roomId) !== this._normalizeStorageRoomId(roomId)) return false;
  if (kind === "resources" && candidate.kind !== "resource") return false;
  if (kind === "items" && candidate.kind !== "item") return false;
  return true;
},

_tradeCandidates(holding, filters = {}) {
  const candidates = [];
  for (const row of holding?.storage?.resources ?? []) {
    if (!row?.forSale) continue;
    if (isMoneyResource(row.resourceId, row.name)) continue;
    const qty = this._storageAvailableRowQuantity(holding, row);
    if (!qty) continue;
    const basePrice = this._resourcePriceCopper(row);
    if (!basePrice) continue;
    const id = normalizeResourceId(row.resourceId, row.name);
    const candidate = { kind: "resource", holding, row, name: id === "custom" ? (row.name || "Ресурс") : resourceLabel(id), qty, basePrice, roomId: this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) };
    if (this._tradeCandidateAllowed(candidate, filters)) candidates.push(candidate);
  }
  for (const row of holding?.storage?.items ?? []) {
    if (!row?.forSale) continue;
    const qty = this._itemQuantity(row);
    if (!qty) continue;
    const basePrice = this._itemPriceCopper(row);
    if (!basePrice) continue;
    const candidate = { kind: "item", row, name: row.name || row.itemData?.name || "Предмет", qty, basePrice, roomId: this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) };
    if (this._tradeCandidateAllowed(candidate, filters)) candidates.push(candidate);
  }
  return candidates;
},

_tradeCandidateQuantity(candidate = {}) {
  if (!candidate?.row) return 0;
  if (candidate.kind === "resource") {
    return this._storageQuantity(candidate.holding, {
      resourceId: candidate.row.resourceId,
      name: candidate.row.name,
      roomId: candidate.row.roomId ?? candidate.row.storageRoomId,
      storageRowId: candidate.row.id
    });
  }
  return Math.max(0, Math.floor(this._itemQuantity(candidate.row)));
},

_reduceTradeCandidate(candidate, qty = 1) {
  const amount = Math.max(0, Math.floor(this._safeNumber(qty, 0)));
  if (!candidate?.row || !amount) return 0;
  if (candidate.kind === "resource") {
    const have = this._tradeCandidateQuantity(candidate);
    const take = Math.min(have, amount);
    const receipt = this._storageTake(candidate.holding, {
      resourceId: candidate.row.resourceId,
      name: candidate.row.name,
      roomId: candidate.row.roomId ?? candidate.row.storageRoomId,
      storageRowId: candidate.row.id
    }, take);
    candidate.qty = this._tradeCandidateQuantity(candidate);
    return Math.max(0, Math.floor(this._safeNumber(receipt?.takenQty, 0)));
  }
  const have = this._tradeCandidateQuantity(candidate);
  const take = Math.min(have, amount);
  candidate.row.qty = have - take;
  if (candidate.row.itemData?.system) candidate.row.itemData.system.quantity = have - take;
  candidate.qty = Math.max(0, have - take);
  return take;
}
};
