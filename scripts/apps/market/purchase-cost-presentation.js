import { formatCopperCurrencyCompact } from "../../core/currency.js";
import { marketInsuranceLimitCopper, marketInsurancePayoutCopper } from "../../engines/market/cargo-aging.js";

function whole(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function weightsFor(lines, byLoad) {
  const weights = lines.map((line) => byLoad
    ? whole(line.qty) * Math.max(0, Number(line.load) || 0)
    : whole(line.lineCopper ?? whole(line.qty) * whole(line.unitPriceCopper)));
  return weights.some((weight) => weight > 0) ? weights : lines.map((line) => whole(line.qty));
}

/** Whole-copper shares; equal remainders use the stable offer ID. */
function allocate(total, lines, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (!lines.length || !totalWeight) return lines.map(() => 0);
  const rows = lines.map((line, index) => {
    const exact = whole(total) * weights[index] / totalWeight;
    return { id: String(line.id), index, amount: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let remainder = whole(total) - rows.reduce((sum, row) => sum + row.amount, 0);
  for (const row of [...rows].sort((a, b) => b.fraction - a.fraction || a.id.localeCompare(b.id))) {
    if (remainder <= 0) break;
    row.amount++;
    remainder--;
  }
  return rows.map((row) => row.amount);
}

/** Informational allocation only; the confirmed batch totals remain authoritative. */
export function marketPurchaseCostPresentation(plan = {}) {
  const batches = plan.shipmentBatches?.length ? plan.shipmentBatches : [plan];
  const rowsById = new Map();
  for (const batch of batches) {
    const lines = batch.lines ?? [];
    const valueWeights = weightsFor(lines, false);
    const loadWeights = weightsFor(lines, true);
    const route = allocate(batch.routeCopper, lines, Number(batch.operationalFreightCopper) > Number(batch.valueFreightCopper) ? loadWeights : valueWeights);
    const handling = allocate(batch.handlingCopper, lines, loadWeights);
    const insurance = allocate(batch.insuranceCopper, lines, valueWeights);
    const taxes = allocate(batch.taxCopper, lines, valueWeights);
    const express = allocate(batch.expressSurchargeCopper, lines, route.map((amount, index) => amount + handling[index]));
    const components = lines.map((_line, index) => route[index] + handling[index] + insurance[index] + taxes[index] + express[index]);
    // Old/minimal plans may omit component fields. Their total still reconciles.
    const unassigned = whole(batch.deliveryCopper) - components.reduce((sum, amount) => sum + amount, 0);
    const fallback = allocate(Math.max(0, unassigned), lines, valueWeights);
    for (const [index, line] of lines.entries()) {
      const id = String(line.id);
      const row = rowsById.get(id) ?? { id, name: String(line.name ?? "Товар"), providerLabel: String(line.providerLabel ?? ""), unit: String(line.unit || "ед."), qty: 0, goodsCopper: 0, deliveryCopper: 0 };
      row.qty += whole(line.qty);
      row.goodsCopper += whole(line.lineCopper ?? whole(line.qty) * whole(line.unitPriceCopper));
      row.deliveryCopper += components[index] + fallback[index];
      rowsById.set(id, row);
    }
  }
  const landedLines = [...rowsById.values()].filter((row) => row.qty > 0).map((row) => {
    const landedCopper = row.goodsCopper + row.deliveryCopper;
    const unitCopper = landedCopper / row.qty;
    return {
      ...row,
      landedCopper,
      totalText: formatCopperCurrencyCompact(landedCopper),
      deliveryText: formatCopperCurrencyCompact(row.deliveryCopper),
      unitText: Number.isInteger(unitCopper)
        ? `${formatCopperCurrencyCompact(unitCopper)} / ${row.unit}`
        : `≈${unitCopper.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ММ / ${row.unit}`
    };
  });
  const totalCopper = whole(plan.totalCopper);
  const allocationValid = landedLines.reduce((sum, row) => sum + row.landedCopper, 0) === totalCopper
    && landedLines.reduce((sum, row) => sum + row.deliveryCopper, 0) === whole(plan.deliveryCopper);
  const maximumPayoutCopper = Math.min(totalCopper, whole(plan.maximumInsurancePayoutCopper));
  return {
    landedLines,
    hasLandedLines: allocationValid && landedLines.length > 0,
    allocationValid,
    deliveryShareText: `${(totalCopper ? whole(plan.deliveryCopper) / totalCopper * 100 : 0).toFixed(1)}%`,
    hasInsuranceExposure: plan.deliveryMode === "scheduled" && totalCopper > 0,
    maximumPayoutText: formatCopperCurrencyCompact(maximumPayoutCopper),
    unrecoveredText: formatCopperCurrencyCompact(totalCopper - maximumPayoutCopper)
  };
}

/** Public saved coverage only; never expose a proposed hidden incident. */
export function marketShipmentFinancialRiskText(order = {}) {
  const maximum = marketInsuranceLimitCopper(order);
  const total = whole(order.totalCopper ?? (whole(order.revenueCopper) + whole(order.upfrontCopper)));
  const payout = Math.min(total, marketInsurancePayoutCopper(order));
  return `При новой утрате: выплата до ${formatCopperCurrencyCompact(payout)}; не покрываются ${formatCopperCurrencyCompact(Math.max(0, total - payout))}. Договорный предел: ${formatCopperCurrencyCompact(maximum)}.`;
}
