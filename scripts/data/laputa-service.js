import { LAPUTA_IMPORT } from "./presets/laputa.js";
import { mergeHoldingDefaults } from "./normalizers.js";
import { BASE_HOLDING } from "./schema/base-holding.js";
import { clone } from "./utils.js";

export function importLaputaHolding(data = {}) {
  const imported = mergeHoldingDefaults(clone(LAPUTA_IMPORT.holding));
  if (!Array.isArray(data.holdings)) data.holdings = [];
  const existingIndex = data.holdings.findIndex((holding) => holding.id === imported.id || holding.name === imported.name);

  if (existingIndex >= 0) {
    const existing = mergeHoldingDefaults(data.holdings[existingIndex]);
    imported.visibility = existing.visibility ?? imported.visibility;
    imported.linkedSceneId = existing.linkedSceneId || imported.linkedSceneId;

    if (existing.gm?.notes && existing.gm.notes !== BASE_HOLDING.gm.notes) {
      imported.gm.notes = `${imported.gm.notes}\n\nСохраненные заметки до импорта:\n${existing.gm.notes}`;
    }

    data.holdings[existingIndex] = imported;
  } else {
    data.holdings.push(imported);
  }

  if (!data.meta) data.meta = {};
  data.meta.lastImport = {
    source: LAPUTA_IMPORT.source,
    holdingId: imported.id,
    importedAt: new Date().toISOString()
  };

  return { imported };
}
