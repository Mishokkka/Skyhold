import { isPlainObject, makeId, toNumber } from "../utils.js";

export const FLEET_SCHEMA_VERSION = 7;
export const FLEET_HISTORY_LIMIT = 120;
export const FLEET_LEDGER_LIMIT = 240;
export const FLEET_TRANSFER_LIMIT = 160;
export const FLEET_OFFER_LIMIT = 40;
export const FLEET_CARGO_POINTS_PER_LEGACY_LOAD = 10;
export const FLEET_LEGACY_LOAD_PER_TONNE = 100;
export const FLEET_LEGACY_LOAD_PER_CUBIC_METRE = 50;
export const FLEET_DEFAULT_LEGAL_CAPACITY_CARGO_POINTS = 425_000;
export const FLEET_DEFAULT_CONCEALED_CAPACITY_CARGO_POINTS = 35_000;
export const FLEET_DEFAULT_FREIGHT_COPPER_PER_100_CARGO_POINTS_100_KM = 15;

export const DEFAULT_FLEET_FINANCE_TERMS = Object.freeze({
  mooringCopperPerTenday: 600,
  basicMaintenanceCopperPerTenday: 800,
  suppliesCopperPerQd: 90,
  fuelCopperPerQd: 175,
  voyageMaintenanceCopperPerQd: 90,
  portFeeCopper: 240,
  replacementCopperPerQd: 67,
  freightCopperPerLoad100Km: 1.5
});

export const FLEET_TRANSFER_METHODS = Object.freeze({
  physical: Object.freeze({
    label: "Физическая передача",
    enabled: true,
    feePercent: 0,
    etaQd: 0,
    requiresDock: true,
    trace: "none"
  }),
  bank: Object.freeze({
    label: "Банковский перевод через СТЛ",
    enabled: true,
    feePercent: 2,
    etaQd: 40,
    requiresDock: false,
    trace: "paper"
  }),
  shadow: Object.freeze({
    label: "Теневой перевод",
    enabled: true,
    feePercent: 6,
    etaQd: 20,
    requiresDock: false,
    trace: "discreet"
  })
});

export const VESSEL_STATUSES = Object.freeze({
  docked: "В порту",
  idle: "Ожидает рейса",
  voyaging: "В рейсе",
  crisis: "Кризис",
  archived: "В архиве"
});

export const VOYAGE_STATUSES = Object.freeze({
  active: "В пути",
  crisis: "Требует решения",
  completed: "Завершён",
  cancelled: "Отменён"
});

export const FLEET_OFFER_KINDS = Object.freeze({
  regular: "Регулярный фрахт",
  express: "Срочный груз",
  story: "Сюжетный контракт"
});

export const FLEET_ACQUISITION_METHODS = Object.freeze({
  purchased: "Куплено",
  built: "Построено",
  storyAsset: "Получено по сюжету"
});

function nonNegativeInteger(value, fallback = 0) {
  return Math.max(0, Math.floor(toNumber(value, fallback)));
}

function nonNegativeNumber(value, fallback = 0) {
  return Math.max(0, toNumber(value, fallback));
}

function hasValue(source, key) {
  return source && Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null && source[key] !== "";
}

function cargoPointsFromLegacyLoad(value, fallback = 0) {
  return Math.max(0, Math.ceil(nonNegativeNumber(value, fallback) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD - Number.EPSILON));
}

function legacyLoadFromCargoPoints(value) {
  return nonNegativeInteger(value, 0) / FLEET_CARGO_POINTS_PER_LEGACY_LOAD;
}

function cargoPointsFromFields(source = {}, pointsKey = "cargoPoints", loadKey = "cargoLoad", fallback = 0) {
  if (hasValue(source, pointsKey)) return nonNegativeInteger(source[pointsKey], fallback);
  if (hasValue(source, loadKey)) return cargoPointsFromLegacyLoad(source[loadKey], legacyLoadFromCargoPoints(fallback));
  return nonNegativeInteger(fallback, 0);
}

function normalizeFleetCargoTerms(value = null) {
  if (!isPlainObject(value)) return null;
  const cargoPoints = cargoPointsFromFields(value, "cargoPoints", "cargoLoad", 0);
  const returnCargoPoints = cargoPointsFromFields(value, "returnCargoPoints", "returnCargoLoad", 0);
  const outboundDemandCargoPoints = cargoPointsFromFields(value, "outboundDemandCargoPoints", "outboundDemandLoad", cargoPoints);
  const returnDemandCargoPoints = cargoPointsFromFields(value, "returnDemandCargoPoints", "returnDemandLoad", returnCargoPoints);
  const reservedCapacityCargoPoints = Math.max(
    cargoPointsFromFields(value, "reservedCapacityCargoPoints", "reservedCapacityLoad", 0),
    cargoPoints,
    returnCargoPoints
  );
  return {
    ...value,
    cargoPoints,
    returnCargoPoints,
    outboundDemandCargoPoints,
    returnDemandCargoPoints,
    reservedCapacityCargoPoints,
    cargoLoad: legacyLoadFromCargoPoints(cargoPoints),
    returnCargoLoad: legacyLoadFromCargoPoints(returnCargoPoints),
    outboundDemandLoad: legacyLoadFromCargoPoints(outboundDemandCargoPoints),
    returnDemandLoad: legacyLoadFromCargoPoints(returnDemandCargoPoints),
    reservedCapacityLoad: legacyLoadFromCargoPoints(reservedCapacityCargoPoints)
  };
}

function percent(value, fallback = 0) {
  return Math.max(0, Math.min(100, toNumber(value, fallback)));
}

function precisePercent(value, fallback = 0) {
  return Math.round(percent(value, fallback) * 100) / 100;
}

function conditionPercent(value, fallback = 100) {
  return Math.max(0, Math.min(100, Math.round(toNumber(value, fallback))));
}

function stringMap(value) {
  if (!isPlainObject(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [String(key), toNumber(entry, 0)]));
}

function normalizeFleetAcquisition(row = {}, { holdingId = "" } = {}) {
  const raw = isPlainObject(row?.acquisition)
    ? row.acquisition
    : (isPlainObject(row?.provenance) ? row.provenance : {});
  const legacyProvenance = typeof row?.provenance === "string" ? String(row.provenance).trim() : "";
  const requestedMethod = String(raw.method ?? raw.type ?? row?.acquisitionMethod ?? legacyProvenance);
  const explicit = isPlainObject(row?.acquisition)
    || isPlainObject(row?.provenance)
    || Boolean(String(row?.acquisitionMethod ?? "").trim())
    || Boolean(legacyProvenance);
  const method = Object.hasOwn(FLEET_ACQUISITION_METHODS, requestedMethod) ? requestedMethod : "storyAsset";
  return {
    ...raw,
    schemaVersion: 1,
    method,
    grandfathered: explicit ? raw.grandfathered === true : true,
    acquiredAt: String(raw.acquiredAt ?? row?.acquiredAt ?? ""),
    acquisitionCopper: nonNegativeInteger(raw.acquisitionCopper ?? raw.priceCopper ?? row?.acquisitionCopper, 0),
    sourceHoldingId: String(raw.sourceHoldingId ?? (method === "built" ? holdingId : "")),
    sourceId: String(raw.sourceId ?? raw.purchaseId ?? raw.constructionId ?? ""),
    notes: String(raw.notes ?? "").slice(0, 2000)
  };
}

function normalizeFinanceTerms(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const normalized = Object.fromEntries(Object.entries(DEFAULT_FLEET_FINANCE_TERMS).map(([key, fallback]) => [
    key,
    key === "freightCopperPerLoad100Km"
      ? Math.max(0.01, Math.round(toNumber(source[key], fallback) * 100) / 100)
      : nonNegativeInteger(source[key], fallback)
  ]));
  const canonicalRate = hasValue(source, "freightCopperPer100CargoPoints100Km")
    ? Math.max(0.01, Math.round(toNumber(source.freightCopperPer100CargoPoints100Km, FLEET_DEFAULT_FREIGHT_COPPER_PER_100_CARGO_POINTS_100_KM) * 100) / 100)
    : Math.max(0.01, Math.round(normalized.freightCopperPerLoad100Km * FLEET_CARGO_POINTS_PER_LEGACY_LOAD * 100) / 100);
  normalized.freightCopperPer100CargoPoints100Km = canonicalRate;
  normalized.freightCopperPerLoad100Km = Math.max(0.01, Math.round((canonicalRate / FLEET_CARGO_POINTS_PER_LEGACY_LOAD) * 100) / 100);
  return normalized;
}

export function normalizeFleetCostBreakdown(value = {}, fallbackTotal = 0) {
  const source = isPlainObject(value) ? value : {};
  const rows = {
    suppliesCopper: nonNegativeInteger(source.suppliesCopper, 0),
    fuelCopper: nonNegativeInteger(source.fuelCopper, 0),
    portFeesCopper: nonNegativeInteger(source.portFeesCopper, 0),
    voyageMaintenanceCopper: nonNegativeInteger(source.voyageMaintenanceCopper ?? source.maintenanceCopper, 0),
    externalCrewCopper: nonNegativeInteger(source.externalCrewCopper, 0),
    otherCopper: nonNegativeInteger(source.otherCopper, 0)
  };
  const componentTotal = Object.values(rows).reduce((sum, amount) => sum + amount, 0);
  if (!componentTotal && nonNegativeInteger(fallbackTotal, 0) > 0) rows.otherCopper = nonNegativeInteger(fallbackTotal, 0);
  return {
    ...source,
    ...rows,
    totalCopper: Object.values(rows).reduce((sum, amount) => sum + amount, 0),
    residentCrewPayrollCopper: 0,
    residentCrewPayrollCoveredBySettlement: source.residentCrewPayrollCoveredBySettlement !== false,
    residentCrewMemberIds: Array.isArray(source.residentCrewMemberIds)
      ? [...new Set(source.residentCrewMemberIds.map((id) => String(id ?? "")).filter(Boolean))].slice(0, 500)
      : []
  };
}

export function normalizeFleetRevenueBreakdown(value = {}, {
  outboundRevenueCopper = 0,
  returnRevenueCopper = 0,
  internalTransferCopper = 0
} = {}) {
  const source = isPlainObject(value) ? value : {};
  const outboundCargoCopper = nonNegativeInteger(source.outboundCargoCopper, outboundRevenueCopper);
  const returnCargoCopper = nonNegativeInteger(source.returnCargoCopper, returnRevenueCopper);
  const bonusCopper = nonNegativeInteger(source.bonusCopper, 0);
  return {
    ...source,
    outboundCargoCopper,
    returnCargoCopper,
    bonusCopper,
    totalCopper: outboundCargoCopper + returnCargoCopper + bonusCopper,
    internalTransferCopper: nonNegativeInteger(source.internalTransferCopper, internalTransferCopper),
    internalTransferIsRevenue: false
  };
}

function normalizeFleetLedgerEntry(row = {}) {
  if (!row || typeof row !== "object") return null;
  return {
    ...row,
    id: String(row.id ?? row.operationId ?? makeId("fleet-ledger", 20)),
    operationId: String(row.operationId ?? row.id ?? ""),
    type: String(row.type ?? "note").slice(0, 80),
    at: String(row.at ?? row.createdAt ?? ""),
    qd: nonNegativeInteger(row.qd, 0),
    cashDeltaCopper: Math.trunc(toNumber(row.cashDeltaCopper, 0)),
    reserveDeltaCopper: Math.trunc(toNumber(row.reserveDeltaCopper, 0)),
    internalTransferCopper: Math.trunc(toNumber(row.internalTransferCopper, 0)),
    cashBalanceCopper: nonNegativeInteger(row.cashBalanceCopper, 0),
    reserveBalanceCopper: nonNegativeInteger(row.reserveBalanceCopper, 0),
    title: String(row.title ?? "Запись кассы").slice(0, 300),
    summary: String(row.summary ?? "").slice(0, 2000)
  };
}

function normalizeFleetRepair(row = null) {
  if (!isPlainObject(row)) return null;
  const startedQd = nonNegativeInteger(row.startedQd, 0);
  const durationQd = Math.max(1, nonNegativeInteger(row.durationQd, 1));
  return {
    ...row,
    schemaVersion: 1,
    id: String(row.id ?? row.operationId ?? makeId("fleet-repair", 20)),
    operationId: String(row.operationId ?? row.id ?? ""),
    status: row.status === "paused" ? "paused" : "active",
    startedQd,
    durationQd,
    completesQd: Math.max(startedQd + 1, nonNegativeInteger(row.completesQd, startedQd + durationQd)),
    wearSteps: Math.max(1, Math.min(100, nonNegativeInteger(row.wearSteps, 1))),
    moneyCopper: nonNegativeInteger(row.moneyCopper, 0),
    reserveSpentCopper: nonNegativeInteger(row.reserveSpentCopper, 0),
    materials: (Array.isArray(row.materials) ? row.materials : []).map((material) => ({
      resourceId: String(material?.resourceId ?? ""),
      name: String(material?.name ?? material?.resourceId ?? "Материал").slice(0, 200),
      qty: nonNegativeInteger(material?.qty, 0)
    })).filter((material) => material.resourceId && material.qty > 0),
    startedAt: String(row.startedAt ?? "")
  };
}

export function normalizeFleetOffer(row = {}) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id ?? row.offerId ?? makeId("fleet-offer", 20));
  const kind = Object.hasOwn(FLEET_OFFER_KINDS, String(row.kind ?? "")) ? String(row.kind) : "regular";
  const durationQd = Math.max(1, nonNegativeInteger(row.durationQd, 120));
  const outboundRevenueCopper = nonNegativeInteger(row.outboundRevenueCopper ?? row.revenueCopper, 0);
  const returnRevenueCopper = nonNegativeInteger(row.returnRevenueCopper, 0);
  const operatingCostCopper = nonNegativeInteger(row.operatingCostCopper, 0);
  const replacementReserveCopper = nonNegativeInteger(row.replacementReserveCopper, 0);
  const economyVersion = nonNegativeInteger(row.economyVersion, 0) >= 2 ? 2 : 1;
  const costBreakdown = normalizeFleetCostBreakdown(row.costBreakdown, operatingCostCopper);
  const revenueBreakdown = normalizeFleetRevenueBreakdown(row.revenueBreakdown, { outboundRevenueCopper, returnRevenueCopper });
  const termsSnapshot = normalizeFleetCargoTerms(row.termsSnapshot);
  const reservedCapacityCargoPoints = Math.max(
    cargoPointsFromFields(row, "reservedCapacityCargoPoints", "reservedCapacityLoad", 0),
    nonNegativeInteger(termsSnapshot?.reservedCapacityCargoPoints, 0),
    nonNegativeInteger(termsSnapshot?.cargoPoints, 0),
    nonNegativeInteger(termsSnapshot?.returnCargoPoints, 0)
  );
  return {
    ...row,
    id,
    kind,
    active: row.active !== false,
    available: row.available !== false,
    visibility: row.visibility === "gm" ? "gm" : "known",
    requiredUrs: nonNegativeInteger(row.requiredUrs ?? row.accessDifficulty, 0),
    marketId: String(row.marketId ?? ""),
    quoteKey: String(row.quoteKey ?? ""),
    title: String(row.title ?? FLEET_OFFER_KINDS[kind]).slice(0, 200),
    clientName: String(row.clientName ?? "").slice(0, 200),
    originRegionId: String(row.originRegionId ?? ""),
    destinationRegionId: String(row.destinationRegionId ?? ""),
    destinationLabel: String(row.destinationLabel ?? row.destinationRegionId ?? "Не указан").slice(0, 200),
    durationQd,
    economyVersion,
    outboundRevenueCopper: economyVersion >= 2 ? revenueBreakdown.outboundCargoCopper : outboundRevenueCopper,
    returnRevenueCopper: economyVersion >= 2 ? revenueBreakdown.returnCargoCopper : returnRevenueCopper,
    operatingCostCopper: economyVersion >= 2 ? costBreakdown.totalCopper : operatingCostCopper,
    replacementReserveCopper,
    costBreakdown,
    revenueBreakdown,
    termsSnapshot,
    reservedCapacityCargoPoints,
    reservedCapacityLoad: legacyLoadFromCargoPoints(reservedCapacityCargoPoints),
    wearSteps: Math.max(0, Math.min(20, nonNegativeInteger(row.wearSteps, 0))),
    riskPercent: percent(row.riskPercent, kind === "express" ? 15 : 5),
    notes: String(row.notes ?? "").slice(0, 2000),
    createdAt: String(row.createdAt ?? "")
  };
}

function normalizeFleetRiskResolution(value = null) {
  if (!isPlainObject(value)) return null;
  const outcome = ["clear", "delayed", "lost", "waived"].includes(String(value.outcome ?? ""))
    ? String(value.outcome)
    : "";
  const scenario = ["ordinary", "urgent", "loss"].includes(String(value.scenario ?? ""))
    ? String(value.scenario)
    : (outcome === "lost" ? "loss" : (value.urgent ? "urgent" : "ordinary"));
  const unit = (entry, fallback = 0) => Math.max(0, Math.min(0.999999999, toNumber(entry, fallback)));
  return {
    ...value,
    schemaVersion: 1,
    resolutionId: String(value.resolutionId ?? ""),
    resolutionVersion: Math.max(1, nonNegativeInteger(value.resolutionVersion, 1)),
    status: outcome ? "resolved" : "pending",
    outcome,
    scenario,
    urgent: scenario === "urgent" || value.urgent === true,
    riskPercent: percent(value.riskPercent, 0),
    incidentChance: unit(value.incidentChance),
    lossChance: unit(value.lossChance),
    delayChance: unit(value.delayChance),
    lossShare: unit(value.lossShare),
    incident: value.incident === true,
    incidentRoll: unit(value.incidentRoll, 0.999999999),
    severityRoll: unit(value.severityRoll, 0.999999999),
    delayDurationRoll: unit(value.delayDurationRoll),
    maximumDelayQd: nonNegativeInteger(value.maximumDelayQd, 0),
    delayQd: nonNegativeInteger(value.delayQd, 0),
    delayApplied: value.delayApplied === true,
    originalEtaQd: nonNegativeInteger(value.originalEtaQd, 0),
    delayedEtaQd: nonNegativeInteger(value.delayedEtaQd, 0),
    delayAppliedAtQd: nonNegativeInteger(value.delayAppliedAtQd, 0),
    resolvedAtQd: nonNegativeInteger(value.resolvedAtQd, 0),
    resolvedAt: String(value.resolvedAt ?? "")
  };
}

export function normalizeFleetVoyage(row = null) {
  if (!row || typeof row !== "object") return null;
  const status = Object.hasOwn(VOYAGE_STATUSES, String(row.status ?? "")) ? String(row.status) : "active";
  const departureQd = nonNegativeInteger(row.departureQd, 0);
  const etaQd = Math.max(departureQd + 1, nonNegativeInteger(row.etaQd, departureQd + 1));
  const economyVersion = nonNegativeInteger(row.economyVersion, 0) >= 2 ? 2 : 1;
  const outboundRevenueCopper = nonNegativeInteger(row.outboundRevenueCopper, 0);
  const returnRevenueCopper = nonNegativeInteger(row.returnRevenueCopper, 0);
  const operatingCostCopper = nonNegativeInteger(row.operatingCostCopper, 0);
  const costBreakdown = normalizeFleetCostBreakdown(row.costBreakdown, operatingCostCopper);
  const revenueBreakdown = normalizeFleetRevenueBreakdown(row.revenueBreakdown, {
    outboundRevenueCopper,
    returnRevenueCopper,
    internalTransferCopper: row.internalTransferCopper
  });
  const termsSnapshot = normalizeFleetCargoTerms(row.termsSnapshot);
  const reservedCapacityCargoPoints = Math.max(
    cargoPointsFromFields(row, "reservedCapacityCargoPoints", "reservedCapacityLoad", 0),
    nonNegativeInteger(termsSnapshot?.reservedCapacityCargoPoints, 0),
    nonNegativeInteger(termsSnapshot?.cargoPoints, 0),
    nonNegativeInteger(termsSnapshot?.returnCargoPoints, 0)
  );
  return {
    ...row,
    id: String(row.id ?? row.voyageId ?? makeId("fleet-voyage", 20)),
    offerId: String(row.offerId ?? ""),
    title: String(row.title ?? "Контрактный рейс").slice(0, 200),
    kind: Object.hasOwn(FLEET_OFFER_KINDS, String(row.kind ?? "")) ? String(row.kind) : "regular",
    status,
    originRegionId: String(row.originRegionId ?? ""),
    destinationRegionId: String(row.destinationRegionId ?? ""),
    destinationLabel: String(row.destinationLabel ?? row.destinationRegionId ?? "Не указан").slice(0, 200),
    departureQd,
    etaQd,
    lastProcessedQd: Math.max(departureQd, Math.min(etaQd, nonNegativeInteger(row.lastProcessedQd, departureQd))),
    economyVersion,
    outboundRevenueCopper: economyVersion >= 2 ? revenueBreakdown.outboundCargoCopper : outboundRevenueCopper,
    returnRevenueCopper: economyVersion >= 2 ? revenueBreakdown.returnCargoCopper : returnRevenueCopper,
    operatingCostCopper: economyVersion >= 2 ? costBreakdown.totalCopper : operatingCostCopper,
    replacementReserveCopper: nonNegativeInteger(row.replacementReserveCopper, 0),
    costBreakdown,
    revenueBreakdown,
    internalTransferCopper: nonNegativeInteger(row.internalTransferCopper ?? revenueBreakdown.internalTransferCopper, 0),
    termsSnapshot,
    reservedCapacityCargoPoints,
    reservedCapacityLoad: legacyLoadFromCargoPoints(reservedCapacityCargoPoints),
    wearSteps: Math.max(0, Math.min(20, nonNegativeInteger(row.wearSteps, 0))),
    riskPercent: percent(row.riskPercent, 0),
    riskResolution: normalizeFleetRiskResolution(row.riskResolution),
    notes: String(row.notes ?? "").slice(0, 2000),
    acceptedAt: String(row.acceptedAt ?? ""),
    completedAt: String(row.completedAt ?? ""),
    crewSnapshot: normalizeFleetCrewSnapshot(row.crewSnapshot)
  };
}

function normalizeFleetCrewSnapshot(value = null) {
  if (!isPlainObject(value)) return null;
  const crewTarget = Math.max(0, Math.min(500, nonNegativeInteger(value.crewTarget, 0)));
  const memberIds = Array.isArray(value.memberIds)
    ? [...new Set(value.memberIds.map((id) => String(id ?? "")).filter(Boolean))].slice(0, 500)
    : [];
  return {
    ...value,
    schemaVersion: 1,
    crewTarget,
    memberIds,
    residentCount: Math.min(crewTarget, nonNegativeInteger(value.residentCount, memberIds.length)),
    abstractComplementIgnored: true,
    capturedAtQd: nonNegativeInteger(value.capturedAtQd, 0)
  };
}

function normalizeFleetHistoryEntry(row = {}) {
  if (!row || typeof row !== "object") return null;
  return {
    ...row,
    id: String(row.id ?? row.operationId ?? makeId("fleet-history", 20)),
    operationId: String(row.operationId ?? row.id ?? ""),
    type: String(row.type ?? "note").slice(0, 80),
    at: String(row.at ?? row.createdAt ?? ""),
    title: String(row.title ?? "Запись флота").slice(0, 300),
    summary: String(row.summary ?? "").slice(0, 2000),
    amountCopper: Math.floor(toNumber(row.amountCopper, 0))
  };
}

export function normalizeFleetVessel(row = {}, { holdingId = "", index = 0, destructive = false } = {}) {
  const status = Object.hasOwn(VESSEL_STATUSES, String(row?.status ?? "")) ? String(row.status) : "docked";
  const finances = isPlainObject(row?.finances) ? row.finances : {};
  const profile = isPlainObject(row?.profile) ? row.profile : {};
  const {
    legalCapacityLoad: legacyLegalCapacityTonnes,
    concealedCapacityLoad: legacyConcealedCapacityTonnes,
    ...profileFields
  } = profile;
  const position = isPlainObject(row?.position) ? row.position : {};
  const condition = isPlainObject(row?.condition) ? row.condition : {};
  const legal = isPlainObject(row?.legal) ? row.legal : {};
  const crew = isPlainObject(row?.crew) ? row.crew : {};
  const legalCapacityTonnes = nonNegativeInteger(profile.legalCapacityTonnes ?? legacyLegalCapacityTonnes, 425);
  const legalCapacityVolumeM3 = nonNegativeInteger(profile.legalCapacityVolumeM3, 850);
  const concealedCapacityTonnes = nonNegativeInteger(profile.concealedCapacityTonnes ?? legacyConcealedCapacityTonnes, 35);
  const concealedCapacityVolumeM3 = nonNegativeInteger(profile.concealedCapacityVolumeM3, 70);
  const legacyLegalCargoPoints = Math.min(
    legalCapacityTonnes * FLEET_LEGACY_LOAD_PER_TONNE,
    legalCapacityVolumeM3 * FLEET_LEGACY_LOAD_PER_CUBIC_METRE
  ) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD;
  const legacyConcealedCargoPoints = Math.min(
    concealedCapacityTonnes * FLEET_LEGACY_LOAD_PER_TONNE,
    concealedCapacityVolumeM3 * FLEET_LEGACY_LOAD_PER_CUBIC_METRE
  ) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD;
  const abstractComplement = Math.max(0, Math.min(500, nonNegativeInteger(crew.abstractComplement ?? profile.crewTarget, 36)));
  const activeVoyage = normalizeFleetVoyage(row?.activeVoyage);
  return {
    ...row,
    id: String(row?.id ?? makeId(index === 0 ? "magnific" : "vessel", 20)),
    name: String(row?.name ?? (index === 0 ? "Магнифик" : "Новое судно")).slice(0, 200),
    ownerName: String(row?.ownerName ?? (index === 0 ? "Элина Траззмар" : "")).slice(0, 200),
    status: activeVoyage?.status === "active" ? "voyaging" : status,
    visibility: row?.visibility === "gm" ? "gm" : "known",
    notes: String(row?.notes ?? "").slice(0, 4000),
    revision: nonNegativeInteger(row?.revision, 0),
    acquisition: normalizeFleetAcquisition(row, { holdingId }),
    profile: {
      ...profileFields,
      crewTarget: Math.max(0, Math.min(500, nonNegativeInteger(profile.crewTarget, abstractComplement))),
      legalCapacityCargoPoints: hasValue(profile, "legalCapacityCargoPoints")
        ? nonNegativeInteger(profile.legalCapacityCargoPoints, legacyLegalCargoPoints)
        : legacyLegalCargoPoints,
      concealedCapacityCargoPoints: hasValue(profile, "concealedCapacityCargoPoints")
        ? nonNegativeInteger(profile.concealedCapacityCargoPoints, legacyConcealedCargoPoints)
        : legacyConcealedCargoPoints,
      legalCapacityTonnes,
      legalCapacityVolumeM3,
      concealedCapacityTonnes,
      concealedCapacityVolumeM3,
      speedClass: String(profile.speedClass ?? "fast-clipper").slice(0, 100),
      weaponNote: String(profile.weaponNote ?? "6–8 лёгких орудий").slice(0, 500),
      financeTerms: normalizeFinanceTerms(profile.financeTerms ?? profile)
    },
    position: {
      ...position,
      regionId: String(position.regionId ?? ""),
      locationId: String(position.locationId ?? ""),
      locationLabel: String(position.locationLabel ?? "").slice(0, 200),
      dockedAtHoldingId: String(position.dockedAtHoldingId ?? (status === "docked" ? holdingId : ""))
    },
    finances: {
      ...finances,
      cashCopper: nonNegativeInteger(finances.cashCopper, 0),
      operatingReserveCopper: nonNegativeInteger(finances.operatingReserveCopper, 0),
      emergencyReserveCopper: nonNegativeInteger(finances.emergencyReserveCopper, 0),
      replacementReserveCopper: nonNegativeInteger(finances.replacementReserveCopper, 0),
      idleCostArrearsCopper: nonNegativeInteger(finances.idleCostArrearsCopper, 0),
      lastRecurringCostQd: nonNegativeInteger(finances.lastRecurringCostQd, 0),
      ledger: (() => {
        const entries = (Array.isArray(finances.ledger) ? finances.ledger : []).map((entry) => normalizeFleetLedgerEntry(entry)).filter(Boolean);
        return destructive ? entries.slice(-FLEET_LEDGER_LIMIT) : entries;
      })()
    },
    condition: {
      ...condition,
      hull: conditionPercent(condition.hull, 100),
      lift: conditionPercent(condition.lift, 100),
      machinery: conditionPercent(condition.machinery, 100),
      wear: conditionPercent(condition.wear, 0)
    },
    legal: {
      ...legal,
      heatByCountry: stringMap(legal.heatByCountry),
      reputationByOrganization: stringMap(legal.reputationByOrganization)
    },
    crew: {
      ...crew,
      memberIds: Array.isArray(crew.memberIds) ? crew.memberIds.map((id) => String(id ?? "")).filter(Boolean).slice(0, 500) : [],
      abstractComplement
    },
    activeVoyage,
    activeRepair: normalizeFleetRepair(row?.activeRepair),
    offers: (Array.isArray(row?.offers) ? row.offers : []).map((offer) => normalizeFleetOffer(offer)).filter(Boolean).slice(-FLEET_OFFER_LIMIT),
    history: (() => {
      const entries = (Array.isArray(row?.history) ? row.history : []).map((entry) => normalizeFleetHistoryEntry(entry)).filter(Boolean);
      return destructive ? entries.slice(-FLEET_HISTORY_LIMIT) : entries;
    })()
  };
}

function normalizeFleetTransfer(row = {}) {
  if (!row || typeof row !== "object") return null;
  const direction = row.direction === "holding-to-vessel" ? "holding-to-vessel" : "vessel-to-holding";
  const method = Object.hasOwn(FLEET_TRANSFER_METHODS, String(row.method ?? "")) ? String(row.method) : "physical";
  const status = ["pending", "completed", "cancelled"].includes(String(row.status ?? ""))
    ? String(row.status)
    : (method === "physical" ? "completed" : "pending");
  const amountCopper = nonNegativeInteger(row.amountCopper, 0);
  const feeCopper = Math.min(amountCopper, nonNegativeInteger(row.feeCopper, 0));
  return {
    ...row,
    id: String(row.id ?? row.operationId ?? makeId("fleet-transfer", 20)),
    operationId: String(row.operationId ?? row.id ?? ""),
    vesselId: String(row.vesselId ?? ""),
    direction,
    amountCopper,
    feeCopper,
    netCopper: Math.min(amountCopper, nonNegativeInteger(row.netCopper, amountCopper - feeCopper)),
    refundedCopper: Math.min(amountCopper, nonNegativeInteger(row.refundedCopper, 0)),
    createdAt: String(row.createdAt ?? ""),
    completedAt: String(row.completedAt ?? ""),
    cancelledAt: String(row.cancelledAt ?? ""),
    createdQd: nonNegativeInteger(row.createdQd, 0),
    etaQd: nonNegativeInteger(row.etaQd, 0),
    completedQd: nonNegativeInteger(row.completedQd, 0),
    method,
    status,
    trace: String(row.trace ?? FLEET_TRANSFER_METHODS[method].trace).slice(0, 80),
    completionOperationId: String(row.completionOperationId ?? ""),
    cancelOperationId: String(row.cancelOperationId ?? "")
  };
}

function normalizeFleetTransferMethods(value = {}) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(Object.entries(FLEET_TRANSFER_METHODS).map(([id, defaults]) => {
    const row = isPlainObject(source[id]) ? source[id] : {};
    return [id, {
      ...row,
      id,
      label: String(row.label ?? defaults.label).slice(0, 200),
      enabled: id === "physical" ? true : row.enabled !== false,
      feePercent: id === "physical" ? 0 : precisePercent(row.feePercent, defaults.feePercent),
      etaQd: id === "physical" ? 0 : Math.max(1, nonNegativeInteger(row.etaQd, defaults.etaQd)),
      requiresDock: defaults.requiresDock,
      trace: defaults.trace
    }];
  }));
}

export function normalizeFleet(value = {}, { holdingId = "", destructive = false } = {}) {
  const source = isPlainObject(value) ? value : {};
  const sourceVessels = Array.isArray(source.vessels) && source.vessels.length
    ? source.vessels
    : (Array.isArray(source.ships) ? source.ships : []);
  const vessels = sourceVessels
    .filter((row) => row && typeof row === "object")
    .map((row, index) => normalizeFleetVessel(row, { holdingId, index, destructive }));
  const seen = new Set();
  for (const [index, vessel] of vessels.entries()) {
    const baseId = String(vessel.id || `vessel-${index + 1}`);
    let id = baseId;
    let suffix = 2;
    while (seen.has(id)) id = `${baseId}-${suffix++}`;
    vessel.id = id;
    seen.add(id);
  }
  const requestedActiveId = String(source.activeVesselId ?? "");
  const { ships: _legacyShips, ...currentSource } = source;
  return {
    ...currentSource,
    schemaVersion: FLEET_SCHEMA_VERSION,
    activeVesselId: vessels.some((vessel) => vessel.id === requestedActiveId) ? requestedActiveId : (vessels.find((vessel) => vessel.status !== "archived")?.id ?? vessels[0]?.id ?? ""),
    vessels,
    transferMethods: normalizeFleetTransferMethods(source.transferMethods),
    transfers: (() => {
      const entries = (Array.isArray(source.transfers) ? source.transfers : []).map((entry) => normalizeFleetTransfer(entry)).filter(Boolean);
      return destructive ? entries.slice(-FLEET_TRANSFER_LIMIT) : entries;
    })()
  };
}

export function createFleetVessel({
  holdingId = "",
  name = "Магнифик",
  ownerName = "Элина Траззмар",
  acquisitionMethod = "storyAsset",
  acquiredAt = "",
  acquisitionCopper = 0,
  acquisitionSourceId = ""
} = {}) {
  return normalizeFleetVessel({
    id: makeId("vessel", 20),
    name,
    ownerName,
    status: "docked",
    acquisition: {
      method: Object.hasOwn(FLEET_ACQUISITION_METHODS, acquisitionMethod) ? acquisitionMethod : "storyAsset",
      grandfathered: false,
      acquiredAt,
      acquisitionCopper,
      sourceHoldingId: acquisitionMethod === "built" ? holdingId : "",
      sourceId: acquisitionSourceId
    },
    position: { dockedAtHoldingId: holdingId },
    crew: { abstractComplement: 36 },
    profile: {
      crewTarget: 36,
      legalCapacityCargoPoints: FLEET_DEFAULT_LEGAL_CAPACITY_CARGO_POINTS,
      concealedCapacityCargoPoints: FLEET_DEFAULT_CONCEALED_CAPACITY_CARGO_POINTS,
      legalCapacityTonnes: 425,
      legalCapacityVolumeM3: 850,
      concealedCapacityTonnes: 35,
      concealedCapacityVolumeM3: 70
    }
  }, { holdingId });
}

export function fleetVesselAvailableCopper(vessel = {}) {
  const finances = vessel?.finances ?? {};
  const committed = nonNegativeInteger(vessel?.activeVoyage?.operatingCostCopper, 0);
  return Math.max(0,
    nonNegativeInteger(finances.cashCopper, 0)
      - nonNegativeInteger(finances.operatingReserveCopper, 0)
      - nonNegativeInteger(finances.emergencyReserveCopper, 0)
      - nonNegativeInteger(finances.replacementReserveCopper, 0)
      - committed
  );
}
