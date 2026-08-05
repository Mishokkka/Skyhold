function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isWholeEconomyQuantity(value, { allowZero = false } = {}) {
  const parsed = numeric(value);
  if (!Number.isSafeInteger(parsed)) return false;
  return allowZero ? parsed >= 0 : parsed > 0;
}

export function validateProductionRecipe(line = {}, { parseResourceCosts } = {}) {
  const issues = [];
  const rawOutput = line?.outputQty ?? line?.output ?? line?.quantity;
  if (!isWholeEconomyQuantity(rawOutput, { allowZero: true })) {
    issues.push({ code: "fractional-output", field: "outputQty", value: rawOutput });
  }
  const costs = typeof parseResourceCosts === "function" ? parseResourceCosts(line?.expenses) : [];
  for (const [index, cost] of costs.entries()) {
    if (!isWholeEconomyQuantity(cost?.qty)) {
      issues.push({ code: "fractional-input", field: `expenses.${index}.qty`, value: cost?.qty });
    }
  }
  const wip = line?.workInProgress;
  if (wip && typeof wip === "object" && !Array.isArray(wip)) {
    if (!isWholeEconomyQuantity(wip?.outputQty, { allowZero: true })) {
      issues.push({ code: "fractional-output", field: "workInProgress.outputQty", value: wip?.outputQty });
    }
    for (const [index, cost] of (Array.isArray(wip?.inputCosts) ? wip.inputCosts : []).entries()) {
      if (!isWholeEconomyQuantity(cost?.qty)) {
        issues.push({ code: "fractional-input", field: `workInProgress.inputCosts.${index}.qty`, value: cost?.qty });
      }
    }
  }
  return { ok: issues.length === 0, issues, costs };
}

export function validateConstructionRecipe(rows = []) {
  const issues = [];
  for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const raw = row?.qty ?? row?.quantity;
    if (Number(raw) <= 0) continue;
    if (!isWholeEconomyQuantity(raw)) {
      issues.push({ code: "fractional-material", field: `materialCosts.${index}.qty`, value: raw });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function productionRecipeBlockerText(validation = {}) {
  if (validation?.ok !== false) return "";
  const hasOutput = validation.issues?.some((issue) => issue.code === "fractional-output");
  const hasInput = validation.issues?.some((issue) => issue.code === "fractional-input");
  if (hasOutput && hasInput) return "Выпуск и сырьё должны быть заданы целыми единицами. Линия остановлена до исправления ГМ.";
  if (hasOutput) return "Выпуск должен быть задан целым числом единиц. Линия остановлена до исправления ГМ.";
  return "Сырьё должно быть задано целыми единицами. Линия остановлена до исправления ГМ.";
}
