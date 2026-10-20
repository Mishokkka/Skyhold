/** Legacy GM-authored special morale effects, shared with the player write guard. */
export function specialMoraleModifier(row = {}) {
  const text = `${String(row.type ?? "")} ${String(row.name ?? "")}`.toLowerCase();
  if (!(text.includes("модификатор") && text.includes("доволь"))
    && row.includeInMorale !== true && row.countsForMorale !== true) return 0;
  const value = Number(row.value ?? row.moraleDelta);
  return Number.isFinite(value) ? value : 0;
}
