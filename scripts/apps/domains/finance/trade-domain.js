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

_tradeEfficiencySummary(holding, building) {
  const assigned = this._assignedBuildingPeople?.(holding, building) ?? [];
  const traders = assigned.length ? assigned : [null];
  const values = traders.map((person) => person ? Math.max(0, this._personBuildingEfficiency(holding, building, person)) : 1);
  const clean = values.length ? values : [1];
  const total = clean.reduce((sum, value) => sum + value, 0);
  const average = total / clean.length;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const text = Math.abs(min - max) < 0.0001
    ? this._formatNumber(average)
    : `${this._formatNumber(min)}–${this._formatNumber(max)}`;
  const title = assigned.length
    ? `Эффективность берется от случайного назначенного торговца. Среднее: ${this._formatNumber(average)}. 1 = 50% цены FL, 2 = 100%, 3 = 150%.`
    : "Торговцы не назначены: используется эффективность 1, то есть 50% цены Forbidden Lands.";
  return { value: average, min, max, text, title, assigned: assigned.length };
},

_tradeUnitSalePrice(baseCopper = 0, efficiency = 1) {
  const base = Math.max(0, Math.floor(this._safeNumber(baseCopper, 0)));
  if (!base) return 0;
  const eff = Math.max(0, this._safeNumber(efficiency, 1));
  return Math.max(1, Math.floor(base * 0.5 * eff));
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
    const qty = Math.max(0, Math.floor(this._safeNumber(row.qty, 0)));
    if (!qty) continue;
    const basePrice = this._resourcePriceCopper(row);
    if (!basePrice) continue;
    const id = normalizeResourceId(row.resourceId, row.name);
    const candidate = { kind: "resource", row, name: id === "custom" ? (row.name || "Ресурс") : resourceLabel(id), qty, basePrice, roomId: this._normalizeStorageRoomId(row.roomId ?? row.storageRoomId) };
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

_reduceTradeCandidate(candidate, qty = 1) {
  const amount = Math.max(0, Math.floor(this._safeNumber(qty, 0)));
  if (!candidate?.row || !amount) return 0;
  if (candidate.kind === "resource") {
    const have = Math.max(0, Math.floor(this._safeNumber(candidate.row.qty, 0)));
    const take = Math.min(have, amount);
    candidate.row.qty = have - take;
    return take;
  }
  const have = this._itemQuantity(candidate.row);
  const take = Math.min(have, amount);
  if (have > take) {
    candidate.row.qty = have - take;
    if (candidate.row.itemData?.system) candidate.row.itemData.system.quantity = have - take;
  } else candidate.row.qty = 0;
  return take;
}
};
