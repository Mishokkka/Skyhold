const SPECIAL_NOTE_TEXT_FIELDS = new Set(["id", "name", "type", "notes", "visibility"]);

export function protectedSpecialRecordFields(row) {
  return {
    visibility: row?.visibility ?? "public",
    ...Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !SPECIAL_NOTE_TEXT_FIELDS.has(key)))
  };
}

export function isPublicSpecialNote(row) {
  const fields = protectedSpecialRecordFields(row);
  return Boolean(row) && fields.visibility === "public" && Object.keys(fields).length === 1;
}

/** Legacy GM-authored special morale effects, shared with the player write guard. */
export function specialMoraleModifier(row = {}) {
  const text = `${String(row.type ?? "")} ${String(row.name ?? "")}`.toLowerCase();
  if (!(text.includes("модификатор") && text.includes("доволь"))
    && row.includeInMorale !== true && row.countsForMorale !== true) return 0;
  const value = Number(row.value ?? row.moraleDelta);
  return Number.isFinite(value) ? value : 0;
}
