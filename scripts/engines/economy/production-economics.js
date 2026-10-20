import { allResourceDefs, parseResourceCosts, resourceBasePriceCopper, resourceDef } from "../../core/resources.js";
import { resourceMatchesMaterialGroup } from "../../core/material-groups.js";
import { sellerUnitSalePrice } from "../workers/seller-qualification.js";
import { productionCapacity } from "./production-capacity.js";

const amount = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;

function costRange(cost, multiplier) {
  if (cost.alternatives) {
    const alternatives = cost.alternatives.map((row) => costRange(row, multiplier));
    if (alternatives.some((row) => !row)) return null;
    return { min: Math.min(...alternatives.map((row) => row.min)), max: Math.max(...alternatives.map((row) => row.max)) };
  }
  const definitions = cost.resourceGroup
    ? allResourceDefs().filter((definition) => resourceMatchesMaterialGroup(definition, cost.resourceGroup, definition))
    : [resourceDef(cost.resourceId, cost.name)].filter(Boolean);
  if (!definitions.length) return null;
  const prices = definitions.map((definition) => resourceBasePriceCopper(definition.id));
  const qty = Math.ceil(amount(cost.qty) * multiplier);
  return { min: Math.min(...prices) * qty, max: Math.max(...prices) * qty };
}

/** A transparent recipe estimate, never a sale order or guaranteed cash income. */
export function productionLineEconomics(line = {}, building = {}, options = {}) {
  if (String(line.formula ?? "").trim()) return { available: false, reason: "Формульный выпуск: фиксированную партию оценить нельзя." };
  const fullQty = Math.floor(amount(line.outputQty));
  const capacity = productionCapacity(line);
  const qty = capacity ? Math.min(fullQty, Math.floor(amount(options.batchQty, fullQty)), capacity) : fullQty;
  const fraction = qty / Math.max(1, fullQty);
  const costs = [...parseResourceCosts(line.expenses).map((cost) => costRange(cost, line.expenseMode === "unit" ? qty : fraction)),
    ...parseResourceCosts(line.source === "content" ? "" : line.fixedExpenses).map((cost) => costRange(cost, 1))];
  if (costs.some((cost) => !cost)) return { available: false, reason: "Для части сырья не задана каталожная цена." };
  const base = resourceBasePriceCopper(line.resourceId, line.resource);
  const channel = options.channel ?? "base";
  const price = channel === "contract" ? Math.floor(amount(options.unitPrice, base))
    : ["ordinary", "seller"].includes(channel) ? sellerUnitSalePrice(base, channel === "ordinary" ? 1 : amount(options.sellerEfficiency, 1)) : base;
  const wage = amount(line.wageDailyCopper) || amount(building.wageDailyCopper);
  const labor = (line.source ?? "workers") === "workers"
    ? amount(line.workQd, 1) * fraction * wage / (2 * Math.max(0.01, amount(options.productionEfficiency, 1))) : 0;
  const inputMin = costs.reduce((sum, cost) => sum + cost.min, 0);
  const inputMax = costs.reduce((sum, cost) => sum + cost.max, 0);
  return { available: true, qty, unitPrice: price, revenue: qty * price, inputMin, inputMax, labor,
    marginMin: qty * price - inputMax - labor, marginMax: qty * price - inputMin - labor,
    upkeepMonthly: amount(building.baseUpkeepMonthlyCopper) + amount(building.operatingUpkeepMonthlyCopper) + amount(line.operatingUpkeepMonthlyCopper) };
}
