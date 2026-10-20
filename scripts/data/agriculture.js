export const AGRICULTURE_SCHEMA_VERSION = 1;
export const AGRICULTURE_PHASES = Object.freeze(["empty", "sowing", "growing", "ready", "harvesting"]);
export const AGRICULTURE_EXPIRY_RULES = Object.freeze(["never", "qd", "season-end"]);
export const AGRICULTURE_SEASONS = Object.freeze(["spring", "summer", "autumn", "winter"]);
export const AGRICULTURE_KINDS = Object.freeze(["field", "garden", "vineyard", "hop-yard", "apiary"]);

// Campaign calibration v1. One prepared-food unit is one settlement ration
// unit; at 10 units per resident/tenday and 24 tendays/year, these yields make
// one Grain Field roughly four person-years of food and one vegetable Garden
// roughly two. Herbs are a higher-value non-food alternative, so their harvest
// is intentionally smaller. Building instances remain GM-editable.
export const AGRICULTURE_CROP_OUTPUT_V1 = Object.freeze({
  grain: 960,
  vegetables: 480,
  herbs: 80
});

const DEFAULT_CROPS_BY_KIND = Object.freeze({
  field: Object.freeze([
    Object.freeze({
      id: "grain",
      label: "Зерно",
      resourceId: "grain",
      outputQty: AGRICULTURE_CROP_OUTPUT_V1.grain,
      sowingSeasons: ["spring"],
      sowingWorkQd: 8,
      growingQd: 480,
      harvestWorkQd: 20,
      expiryRule: "qd",
      readyExpiryQd: 120
    })
  ]),
  garden: Object.freeze([
    Object.freeze({
      id: "vegetables",
      label: "Овощи",
      resourceId: "vegetables",
      outputQty: AGRICULTURE_CROP_OUTPUT_V1.vegetables,
      sowingSeasons: ["spring", "summer"],
      sowingWorkQd: 4,
      growingQd: 120,
      harvestWorkQd: 10,
      expiryRule: "qd",
      readyExpiryQd: 80
    }),
    Object.freeze({
      id: "herbs",
      label: "Травы",
      resourceId: "herbs",
      outputQty: AGRICULTURE_CROP_OUTPUT_V1.herbs,
      sowingSeasons: ["spring", "summer"],
      sowingWorkQd: 4,
      growingQd: 80,
      harvestWorkQd: 10,
      expiryRule: "season-end",
      readyExpiryQd: 0
    })
  ])
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function text(value = "", fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || String(fallback ?? "").trim();
}

function whole(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(0, Math.floor(parsed))) : fallback;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") return ["1", "true", "yes", "on", "да"].includes(value.trim().toLocaleLowerCase("ru"));
  return Boolean(value);
}

function stringList(value = []) {
  return [...new Set((Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/))
    .map((row) => text(row))
    .filter(Boolean))];
}

function uniqueCropId(value = "", index = 0, used = new Set()) {
  const source = text(value, `crop-${index + 1}`);
  let candidate = source;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${source}-${suffix++}`;
  used.add(candidate);
  return candidate;
}

export function agricultureKindForBuilding(building = {}) {
  const explicit = text(building?.agriculture?.kind ?? building?.agricultureKind);
  if (AGRICULTURE_KINDS.includes(explicit)) return explicit;
  const templateId = text(building?.templateId ?? building?.id).toLocaleLowerCase("ru");
  if (["grain-field", "field"].includes(templateId)) return "field";
  if (templateId === "garden") return "garden";
  if (templateId === "vineyard") return "vineyard";
  if (templateId === "hop-yard") return "hop-yard";
  if (templateId === "apiary") return "apiary";
  const name = text(building?.name).toLocaleLowerCase("ru");
  if (/^поле(?:\s|$)/u.test(name)) return "field";
  if (/^сад(?:\s|$)/u.test(name)) return "garden";
  if (/^виноградник(?:\s|$)/u.test(name)) return "vineyard";
  if (/^хмельник(?:\s|$)/u.test(name)) return "hop-yard";
  if (/^пасека(?:\s|$)/u.test(name)) return "apiary";
  return "";
}

export function agricultureDefaultCrops(kind = "") {
  return clone(DEFAULT_CROPS_BY_KIND[text(kind)] ?? []);
}

export function normalizeAgricultureCrop(value = {}, index = 0, usedIds = new Set()) {
  const source = value && typeof value === "object" ? value : {};
  const id = uniqueCropId(source.id ?? source.resourceId, index, usedIds);
  const resourceId = text(source.resourceId, id);
  const expiryRule = AGRICULTURE_EXPIRY_RULES.includes(text(source.expiryRule)) ? text(source.expiryRule) : "qd";
  return {
    id,
    label: text(source.label ?? source.name, resourceId || `Культура ${index + 1}`),
    resourceId,
    outputQty: whole(source.outputQty ?? source.yieldQty, 1),
    sowingSeasons: stringList(source.sowingSeasons ?? source.seasons)
      .filter((season) => AGRICULTURE_SEASONS.includes(season)),
    sowingWorkQd: whole(source.sowingWorkQd ?? source.sowWorkQd, 1),
    growingQd: Math.max(1, whole(source.growingQd ?? source.growthQd, 40)),
    harvestWorkQd: Math.max(1, whole(source.harvestWorkQd ?? source.collectWorkQd, 1)),
    expiryRule,
    readyExpiryQd: expiryRule === "qd" ? Math.max(1, whole(source.readyExpiryQd ?? source.expiryQd, 40)) : 0,
    annualHarvestLimit: Math.max(1, whole(source.annualHarvestLimit, 1)),
    perennial: bool(source.perennial, false)
  };
}

export function normalizeAgricultureState(value = {}, { activeCropId = "" } = {}) {
  const source = value && typeof value === "object" ? value : {};
  const phase = AGRICULTURE_PHASES.includes(text(source.phase)) ? text(source.phase) : "empty";
  const cropId = phase === "empty" ? "" : text(source.cropId, activeCropId);
  const explicitHarvestTotalQty = whole(source.harvestTotalQty ?? source.yieldQty);
  const rawHarvestedQty = whole(source.harvestedQty);
  const rawReadyQty = whole(source.readyQty);
  const harvestTotalQty = explicitHarvestTotalQty || (rawHarvestedQty + rawReadyQty);
  const harvestedQty = Math.min(harvestTotalQty, rawHarvestedQty);
  const readyQty = phase === "ready" || phase === "harvesting" ? Math.max(0, harvestTotalQty - harvestedQty) : 0;
  return {
    version: AGRICULTURE_SCHEMA_VERSION,
    phase,
    cropId,
    sowingProgressQd: phase === "sowing" ? whole(source.sowingProgressQd) : 0,
    growingElapsedQd: phase === "growing" ? whole(source.growingElapsedQd) : 0,
    readyAgeQd: phase === "ready" || phase === "harvesting" ? whole(source.readyAgeQd) : 0,
    harvestProgressQd: phase === "ready" || phase === "harvesting" ? whole(source.harvestProgressQd) : 0,
    harvestWorkQdTotal: phase === "ready" || phase === "harvesting" ? Math.max(1, whole(source.harvestWorkQdTotal, 1)) : 0,
    harvestTotalQty: phase === "ready" || phase === "harvesting" ? harvestTotalQty : 0,
    harvestedQty: phase === "ready" || phase === "harvesting" ? harvestedQty : 0,
    readyQty,
    sowingSeasonKey: phase === "sowing" ? text(source.sowingSeasonKey) : "",
    readySeasonKey: phase === "ready" || phase === "harvesting" ? text(source.readySeasonKey) : "",
    lastSownSeasonKey: text(source.lastSownSeasonKey),
    harvestYear: text(source.harvestYear),
    harvestsThisYear: whole(source.harvestsThisYear),
    establishedCropId: text(source.establishedCropId),
    lastMissedSowingSeasonKey: text(source.lastMissedSowingSeasonKey),
    lastOperationId: text(source.lastOperationId)
  };
}

export function normalizeAgricultureBuilding(value = {}, { building = {} } = {}) {
  const kind = agricultureKindForBuilding({ ...building, agriculture: value });
  if (!kind) return null;
  const source = value && typeof value === "object" ? value : {};
  const hasExplicitCrops = Object.prototype.hasOwnProperty.call(source, "crops");
  const cropSource = hasExplicitCrops && Array.isArray(source.crops) ? source.crops : agricultureDefaultCrops(kind);
  const usedIds = new Set();
  const crops = cropSource.slice(0, 12).map((crop, index) => normalizeAgricultureCrop(crop, index, usedIds));
  const requestedActiveCropId = text(source.activeCropId);
  const activeCropId = crops.some((crop) => crop.id === requestedActiveCropId)
    ? requestedActiveCropId
    : (crops[0]?.id ?? "");
  return {
    schemaVersion: AGRICULTURE_SCHEMA_VERSION,
    enabled: bool(source.enabled, true),
    kind,
    activeCropId,
    outputRoomId: text(source.outputRoomId, "outdoors"),
    gmPriority: whole(source.gmPriority, 500),
    operations: {
      sow: bool(source?.operations?.sow, true),
      harvest: bool(source?.operations?.harvest, true)
    },
    crops,
    state: normalizeAgricultureState(source.state, { activeCropId })
  };
}

export const AGRICULTURE_DEFAULT_CROPS = DEFAULT_CROPS_BY_KIND;
