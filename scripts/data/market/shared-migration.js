import { normalizeMarketStockState } from "./stock-state.js";
import { normalizeMarketDemandState } from "./demand-state.js";
import { economyDayIndex } from "../../core/economy-calendar.js";
import { stableDataHash } from "../storage-commit.js";
import { bindSharedMarkets } from "./shared-context.js";

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
const histories = (rows, key) => [...new Set(rows.flatMap((row) => row[key] ?? []))];
export function previewSharedMarketMigration(data = {}) {
  const holdings = data.holdings ?? [];
  const sourceToken = stableDataHash({ shared: data.meta?.sharedMarkets,
    holdings: holdings.map((holding) => ({ id: holding.id, clock: holding.gm?.calendaria, market: holding.special?.market })) });
  if (data.meta?.sharedMarkets?.enabled) return { ok: true, active: true, sourceToken, warnings: [], stockCount: Object.keys(data.meta.sharedMarkets.stock ?? {}).length, demandCount: Object.keys(data.meta.sharedMarkets.demand ?? {}).length };
  const clockTenday = Math.max(0, ...holdings.map((holding) => Math.floor((economyDayIndex(holding) ?? whole(holding.gm?.calendaria?.lastQd) / 4) / 10)));
  const stockGroups = new Map(), demandGroups = new Map();
  for (const holding of holdings) {
    for (const [key, row] of Object.entries(normalizeMarketStockState(holding.special?.market?.stock))) stockGroups.set(key, [...(stockGroups.get(key) ?? []), row]);
    for (const [key, row] of Object.entries(normalizeMarketDemandState(holding.special?.market?.demand))) demandGroups.set(key, [...(demandGroups.get(key) ?? []), row]);
  }
  const stock = {}, demand = {}, warnings = [], blockers = [];
  for (const [key, rows] of stockGroups) {
    const baseStock = Math.max(...rows.map((row) => row.baseStock));
    const spent = rows.reduce((sum, row) => sum + row.baseStock - row.availableStock, 0);
    const availableStock = Math.max(0, baseStock - spent);
    if (spent > baseStock) warnings.push(`${key}: старые поселения вместе выкупили больше единого запаса; общий остаток будет нулевым.`);
    stock[key] = { ...rows[0], baseStock, availableStock, revision: Math.max(...rows.map((row) => row.revision)) + 1,
      recoveryStartedTenday: clockTenday, recoveryStartStock: availableStock, lastRecoveryTenday: clockTenday,
      recoveryDurationTendays: Math.max(...rows.map((row) => row.recoveryDurationTendays)),
      reservationOperationIds: histories(rows, "reservationOperationIds"), restorationOperationIds: histories(rows, "restorationOperationIds") };
  }
  for (const [key, rows] of demandGroups) {
    const baseDemand = Math.max(...rows.map((row) => row.baseDemand)), reservations = {};
    for (const row of rows) for (const [id, reservation] of Object.entries(row.reservations ?? {})) {
      if (reservations[id]) blockers.push(`${key}: повторяется идентификатор действующей брони ${id}.`);
      reservations[id] = { ...reservation };
    }
    const reservedDemand = Object.values(reservations).reduce((sum, row) => sum + whole(row.qty), 0);
    if (reservedDemand > baseDemand) blockers.push(`${key}: обещано ${reservedDemand}, единый спрос ${baseDemand}. Завершите часть поставок перед объединением.`);
    const consumedOutstanding = Math.min(Math.max(0, baseDemand - reservedDemand), rows.reduce((sum, row) => sum + row.consumedOutstanding, 0));
    demand[key] = { ...rows[0], baseDemand, reservations, reservedDemand, consumedOutstanding,
      availableDemand: Math.max(0, baseDemand - reservedDemand - consumedOutstanding),
      recoveryStartedTenday: clockTenday, recoveryStartConsumed: consumedOutstanding, lastRecoveryTenday: clockTenday,
      recoveryDurationTendays: Math.max(...rows.map((row) => row.recoveryDurationTendays)),
      revision: Math.max(...rows.map((row) => row.revision)) + 1,
      reservationOperationIds: histories(rows, "reservationOperationIds"), consumptionOperationIds: histories(rows, "consumptionOperationIds"),
      restorationOperationIds: histories(rows, "restorationOperationIds") };
  }
  return { ok: !blockers.length, active: false, sourceToken, warnings, blockers,
    stockCount: stockGroups.size, demandCount: demandGroups.size,
    prepared: { enabled: true, version: 1, clockTenday, stock, demand } };
}
export function applySharedMarketMigration(data, sourceToken) {
  const preview = previewSharedMarketMigration(data);
  if (preview.active) return { ok: true, replay: true };
  if (!preview.ok || preview.sourceToken !== sourceToken) throw new Error(preview.blockers?.join("\n") || "Рынок изменился после предварительного просмотра.");
  data.meta ??= {};
  data.meta.sharedMarkets = preview.prepared;
  bindSharedMarkets(data);
  return { ok: true, stockCount: preview.stockCount, demandCount: preview.demandCount };
}
