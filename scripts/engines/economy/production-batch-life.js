import { resourceDef, normalizeResourceId } from "../../core/resources.js";
import { productionWaitQd } from "./production-timing.js";

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** A processing deadline, separate from the shelf life of raw milk or finished cans. */
export function productionBatchShelfLifeQd(line = {}) {
  const id = normalizeResourceId(line.resourceId, line.resource);
  const definition = resourceDef(id);
  if (!definition?.foodEdible || !(definition.shelfLifeQd > 0)) return 0;
  const workingLimit = id === "aged-cheese" ? 120
    : ["preserved-meat", "dried-fruit", "canned-protein", "canned-fruit", "canned-vegetables"].includes(id) ? 28
      : Math.min(12, whole(definition.shelfLifeQd));
  // Planned fermentation/maturation is part of processing, not an idle delay.
  // Freeze this full deadline on opening; later recipe edits cannot extend it.
  return workingLimit + productionWaitQd(line);
}

export function productionBatchLife(holding, line, step = 0) {
  const receipt = line?.workReservedInputs;
  const limit = whole(receipt?.processingShelfLifeQd) || productionBatchShelfLifeQd(line);
  const now = whole(holding?.gm?.calendaria?.lastQd) + whole(step);
  // Old receipts predate the processing clock. Their oldest ingredient gives a
  // conservative age; do not grant an ancient reserved batch a fresh deadline.
  const legacyAge = Math.max(0, ...(receipt?.entries ?? []).flatMap((entry) =>
    (entry.batches ?? []).map((batch) => whole(batch.ageQd))));
  const age = Number.isFinite(receipt?.openedAtQd)
    ? Math.max(0, now - receipt.openedAtQd) : legacyAge + whole(step);
  return { ageQd: age, shelfLifeQd: limit, expired: Boolean(line?.workInputsReserved && limit && age >= limit) };
}

export function clearProductionBatch(line) {
  line.workInputsReserved = false;
  line.workProgressUnits = 0;
  line.workReservedOutputQty = 0;
  line.workReservedFormula = "";
  delete line.workReservedInputs;
}
