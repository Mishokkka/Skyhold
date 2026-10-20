// Expense expressions remain stored in the existing line.expenses string.
export function scaleProductionCosts(costs, multiplier) {
  const count = Math.max(0, Number(multiplier) || 0);
  return costs.map((cost) => ({ ...cost, qty: Math.ceil(Math.max(0, Number(cost.qty) || 0) * count),
    ...(Array.isArray(cost.alternatives) ? { alternatives: scaleProductionCosts(cost.alternatives, count) } : {})
  })).filter((cost) => cost.qty > 0);
}

export function appendProductionExpense(expression, resourceId, qty = 1, operator = "and") {
  const text = String(expression ?? "").trim();
  const newline = text.lastIndexOf("\n");
  const comment = text.indexOf("#", newline + 1);
  const prefix = comment < 0 ? text : text.slice(0, comment).trimEnd();
  const suffix = comment < 0 ? "" : ` ${text.slice(comment)}`;
  const item = `${resourceId} ${Math.max(1, Math.floor(Number(qty) || 1))}`;
  return `${prefix}${prefix ? operator === "or" ? " ИЛИ " : "; " : ""}${item}${suffix}`;
}
