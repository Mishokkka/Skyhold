/** Presentation only: retain every selected value while keeping the closed field short. */
export function selectionSummary(values = [], empty = "Не выбрано") {
  const names = values.map(value => String(value ?? "").trim()).filter(Boolean);
  return {
    first: names[0] ?? empty,
    additional: Math.max(0, names.length - 1),
    label: names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}` : empty,
    tooltip: names.length ? names.join(", ") : empty
  };
}

export function syncSelectionSummary(root, values, empty) {
  const summary = root?.querySelector?.("[data-selection-summary]");
  if (!summary) return;
  const { first, additional, tooltip } = selectionSummary(values, empty);
  const text = summary.querySelector("[data-selection-label]");
  if (text) text.textContent = first;
  const count = summary.querySelector("[data-selection-count]");
  if (count) { count.textContent = `+${additional}`; count.hidden = !additional; }
  summary.dataset.fblsTooltip = tooltip;
  summary.setAttribute("aria-label", `Выбранные значения: ${tooltip}`);
}
