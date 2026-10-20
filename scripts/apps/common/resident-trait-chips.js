export function residentTraitTooltip({ name = "", description = "" } = {}) {
  return [name, description].map(value => String(value ?? "").trim()).filter(Boolean).join("\n");
}

export function residentTraitVisibleCount(widths, availableWidth, gap, overflowWidth) {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= availableWidth + 0.1) return widths.length;
  let visible = 0;
  let prefixWidth = 0;
  for (let count = 0; count < widths.length; count += 1) {
    if (prefixWidth + count * gap + overflowWidth(widths.length - count) <= availableWidth + 0.1) visible = count;
    prefixWidth += widths[count];
  }
  return visible;
}

/** Fit presentation only; hidden chips retain their complete names and tooltips. */
export function fitResidentTraitChips(cells) {
  const prepared = [];
  const active = globalThis.document?.activeElement;
  for (const cell of cells) {
    if (!cell?.isConnected) continue;
    const list = cell.querySelector("[data-resident-traits]");
    const more = list?.querySelector("[data-resident-traits-more]");
    const badges = Array.from(list?.querySelectorAll("[data-resident-trait]") ?? []);
    if (!list || !more || !badges.length) continue;
    more.hidden = true;
    for (const badge of badges) {
      badge.hidden = false;
      badge.classList.remove("compact-trait");
      const name = String(badge.dataset.fullLabel ?? "").trim();
      if (badge.textContent !== name) badge.textContent = name;
    }
    prepared.push({ list, more, badges });
  }

  const compact = [];
  for (const entry of prepared) {
    const width = entry.list.clientWidth;
    if (width > 0 && entry.list.scrollWidth > width + 1) compact.push(entry);
  }
  for (const { badges } of compact) {
    for (const badge of badges) {
      badge.classList.add("compact-trait");
      badge.textContent = String(badge.dataset.shortLabel ?? badge.dataset.fullLabel ?? "?").slice(0, 1).toUpperCase() || "?";
    }
  }

  for (const { list, more, badges } of compact) {
    const available = list.clientWidth;
    const gap = Number.parseFloat(globalThis.getComputedStyle(list).columnGap) || 0;
    const widths = badges.map(badge => badge.getBoundingClientRect().width);
    const counterWidths = new Map();
    const measureCounter = count => {
      const digits = String(count).length;
      if (!counterWidths.has(digits)) {
        more.hidden = false;
        more.textContent = `+${count}`;
        counterWidths.set(digits, more.getBoundingClientRect().width);
      }
      return counterWidths.get(digits);
    };
    const visible = residentTraitVisibleCount(widths, available, gap, measureCounter);
    const hidden = badges.slice(visible);
    for (const badge of hidden) badge.hidden = true;
    more.hidden = hidden.length === 0;
    if (hidden.length) {
      const names = hidden.map(badge => badge.dataset.fullLabel).join(", ");
      more.textContent = `+${hidden.length}`;
      more.dataset.fblsTooltip = `Скрытые черты:\n${names}`;
      more.setAttribute("aria-label", `Ещё ${hidden.length} черт: ${names}`);
    }
  }

  for (const { more, badges } of prepared) {
    if (active === more || badges.includes(active)) {
      const target = active.hidden ? (more.hidden ? badges.at(-1) : more) : active;
      target?.focus?.({ preventScroll: true });
    }
  }
}
