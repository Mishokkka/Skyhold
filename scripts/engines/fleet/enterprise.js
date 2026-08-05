import { makeId, toNumber } from "../../data/utils.js";
import {
  FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
  FLEET_HISTORY_LIMIT,
  FLEET_OFFER_KINDS,
  FLEET_OFFER_LIMIT,
  FLEET_TRANSFER_METHODS,
  FLEET_TRANSFER_LIMIT,
  fleetVesselAvailableCopper,
  normalizeFleet,
  normalizeFleetOffer,
  normalizeFleetVoyage
} from "../../data/normalizers/fleet.js";
import {
  advanceFleetRepair,
  appendFleetLedger,
  applyFleetWear,
  chargeFleetIdleCosts,
  FLEET_TENDAY_QD,
  fleetVoyageCostQuote,
  quoteFleetContractEconomy,
  quoteFleetVoyageRisk,
  quoteFleetRepair as quoteFleetRepairTerms,
  startFleetRepair as startFleetRepairTerms
} from "./finance.js";
import { holdingMarketAccessLevel } from "../market/logistics.js";
import { fleetVesselMarketCapacity } from "./market-integration.js";

function copper(value) {
  return Math.max(0, Math.floor(toNumber(value, 0)));
}

function cargoPoints(value) {
  return Math.max(0, Math.ceil(toNumber(value, 0)));
}

function viewerIsGm(value) {
  if (typeof value === "boolean") return value;
  return globalThis.game?.user?.isGM === true;
}

function reservedCapacityCargoPoints(row = {}) {
  const terms = row?.termsSnapshot ?? {};
  const canonical = [
    cargoPoints(row?.reservedCapacityCargoPoints),
    cargoPoints(terms?.reservedCapacityCargoPoints),
    cargoPoints(terms?.cargoPoints),
    cargoPoints(terms?.returnCargoPoints)
  ];
  const hasCanonical = [
    [row, "reservedCapacityCargoPoints"],
    [terms, "reservedCapacityCargoPoints"],
    [terms, "cargoPoints"],
    [terms, "returnCargoPoints"]
  ].some(([source, key]) => source && Object.hasOwn(source, key) && source[key] !== undefined && source[key] !== null && source[key] !== "");
  if (hasCanonical) return Math.max(...canonical);
  return Math.max(
    cargoPoints(toNumber(row?.reservedCapacityLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD),
    cargoPoints(toNumber(terms?.reservedCapacityLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD),
    cargoPoints(toNumber(terms?.cargoLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD),
    cargoPoints(toNumber(terms?.returnCargoLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD)
  );
}

function ensureFleet(holding) {
  if (!holding.special || typeof holding.special !== "object") holding.special = {};
  if (!holding.special.fleet || typeof holding.special.fleet !== "object") {
    holding.special.fleet = normalizeFleet({}, { holdingId: holding.id });
  }
  if (!Array.isArray(holding.special.fleet.vessels)) holding.special.fleet.vessels = [];
  if (!Array.isArray(holding.special.fleet.transfers)) holding.special.fleet.transfers = [];
  return holding.special.fleet;
}

function vesselById(holding, vesselId) {
  const fleet = ensureFleet(holding);
  const id = String(vesselId ?? fleet.activeVesselId ?? "");
  return { fleet, vessel: fleet.vessels.find((row) => String(row?.id ?? "") === id) ?? null };
}

function currentFleetQd(holding) {
  return copper(holding?.gm?.calendaria?.lastQd);
}

function residentHasOtherLaborClaim(holding, vessel, residentId, person) {
  const id = String(residentId ?? "");
  const vesselId = String(vessel?.id ?? "");
  const declared = String(person?.workAssignment ?? "").trim();
  const allowedDeclared = new Set(["", vesselId, String(vessel?.name ?? ""), `fleet:${vesselId}`]);
  if (declared && !allowedDeclared.has(declared) && !/^(free|unassigned|свободен|без работы|ребенок|ребёнок)$/i.test(declared)) return true;
  if ((holding?.buildings?.list ?? []).some((building) => (building?.assignedWorkerIds ?? []).some((value) => String(value ?? "") === id))) return true;
  if ((holding?.constructionCrews ?? []).some((crew) => String(crew?.leaderId ?? "") === id || (crew?.memberIds ?? []).some((value) => String(value ?? "") === id))) return true;
  const defense = holding?.gm?.defense ?? {};
  if (String(defense?.commanderId ?? "") === id) return true;
  if ((defense?.squads ?? []).some((squad) => String(squad?.sergeantId ?? "") === id || (squad?.memberIds ?? []).some((value) => String(value ?? "") === id))) return true;
  return (holding?.special?.fleet?.vessels ?? []).some((candidate) => String(candidate?.id ?? "") !== vesselId
    && (candidate?.crew?.memberIds ?? []).some((value) => String(value ?? "") === id));
}

export function fleetCrewReadiness(holding, vessel, { crewTarget = null } = {}) {
  const target = Math.max(0, Math.min(500, copper(crewTarget ?? vessel?.profile?.crewTarget)));
  const livingById = new Map((holding?.people?.list ?? [])
    .filter((person) => {
      const age = Number(person?.age);
      return !person?.dead && Math.max(0, Number(person?.injuredDays) || 0) <= 0 && (!Number.isFinite(age) || age >= 12);
    })
    .map((person) => [String(person?.id ?? ""), person])
    .filter(([id]) => Boolean(id)));
  const rosterIds = [...new Set((vessel?.crew?.memberIds ?? [])
    .map((id) => String(id ?? ""))
    .filter(Boolean))];
  const conflictingMemberIds = rosterIds.filter((id) => livingById.has(id) && residentHasOtherLaborClaim(holding, vessel, id, livingById.get(id)));
  const memberIds = rosterIds.filter((id) => livingById.has(id) && !conflictingMemberIds.includes(id));
  const missing = Math.max(0, target - memberIds.length);
  return {
    ok: missing === 0,
    code: missing === 0 ? "ready" : "undercrewed",
    crewTarget: target,
    residentCount: memberIds.length,
    missing,
    memberIds,
    invalidMemberIds: rosterIds.filter((id) => !livingById.has(id)),
    conflictingMemberIds,
    ignoredAbstractComplement: copper(vessel?.crew?.abstractComplement),
    message: missing === 0
      ? `Экипаж укомплектован: ${memberIds.length}/${target}.`
      : `Для рейса не хватает экипажа: ${memberIds.length}/${target}. Поле abstractComplement не заменяет назначенных жителей без отдельного оплаченного контракта.`
  };
}

function fleetCrewSnapshot(readiness, capturedAtQd = 0) {
  return {
    schemaVersion: 1,
    crewTarget: readiness.crewTarget,
    residentCount: readiness.residentCount,
    memberIds: readiness.memberIds.slice(),
    abstractComplementIgnored: true,
    capturedAtQd: copper(capturedAtQd)
  };
}

function activeVoyageCrewReadiness(holding, vessel, voyage) {
  if (!voyage?.crewSnapshot || typeof voyage.crewSnapshot !== "object") {
    return { ok: true, legacySnapshot: true, code: "legacy-in-flight" };
  }
  return {
    ...fleetCrewReadiness(holding, vessel, { crewTarget: voyage.crewSnapshot.crewTarget }),
    legacySnapshot: false
  };
}

function ensureStorage(holding) {
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = { moneyCopper: 0, log: [] };
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  return holding.storage;
}

function fleetTransferMethod(fleet, method = "physical") {
  const id = Object.hasOwn(FLEET_TRANSFER_METHODS, String(method ?? "")) ? String(method) : "physical";
  const defaults = FLEET_TRANSFER_METHODS[id];
  const configured = fleet?.transferMethods?.[id] ?? {};
  return {
    ...defaults,
    ...configured,
    id,
    enabled: id === "physical" ? true : configured.enabled !== false,
    feePercent: id === "physical" ? 0 : Math.max(0, Math.min(100, toNumber(configured.feePercent, defaults.feePercent))),
    etaQd: id === "physical" ? 0 : Math.max(1, copper(configured.etaQd ?? defaults.etaQd)),
    requiresDock: defaults.requiresDock,
    trace: defaults.trace
  };
}

function appendStorageTransferLog(holding, {
  operationId = "",
  vesselName = "",
  qty = 0,
  createdAt = "",
  status = "completed",
  note = ""
} = {}) {
  const storage = ensureStorage(holding);
  storage.log.push({
    id: operationId,
    ts: createdAt,
    createdAt,
    domain: "fleet",
    kind: "fleet-transfer",
    name: vesselName,
    qty: Math.floor(toNumber(qty, 0)),
    roomId: "treasury",
    source: vesselName,
    status,
    operationId,
    note
  });
  storage.log = storage.log.slice(-250);
}

function appendHistory(vessel, entry = {}) {
  if (!Array.isArray(vessel.history)) vessel.history = [];
  const operationId = String(entry.operationId ?? entry.id ?? makeId("fleet-history", 20));
  const existing = vessel.history.find((row) => String(row?.operationId ?? row?.id ?? "") === operationId);
  if (existing) return existing;
  const normalized = {
    ...entry,
    id: operationId,
    operationId,
    type: String(entry.type ?? "note"),
    at: String(entry.at ?? ""),
    title: String(entry.title ?? "Запись флота"),
    summary: String(entry.summary ?? ""),
    amountCopper: Math.floor(toNumber(entry.amountCopper, 0))
  };
  vessel.history.push(normalized);
  vessel.history = vessel.history.slice(-FLEET_HISTORY_LIMIT);
  return normalized;
}

function markFleetMarketDeliveryDispatched(holding, voyage, { dispatchedAt = "" } = {}) {
  if (voyage?.sourceType !== "market-delivery") return 0;
  const linkedIds = new Set((voyage?.linkedMarketOrderIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  if (!linkedIds.size) return 0;
  const orders = holding?.special?.market?.orders;
  if (!Array.isArray(orders)) return 0;
  let marked = 0;
  for (const order of orders) {
    const id = String(order?.id ?? order?.operationId ?? "");
    if (!linkedIds.has(id) || !["pending", "in-transit", "delayed"].includes(String(order?.status ?? ""))) continue;
    if (String(order?.dispatchStatus ?? "booked") !== "booked") continue;
    order.status = order.status === "pending" ? "in-transit" : order.status;
    order.dispatchStatus = "departed";
    order.dispatchedAt = String(dispatchedAt || voyage?.acceptedAt || "");
    marked += 1;
  }
  return marked;
}

export function createContractOffer(raw = {}, { vessel = {} } = {}) {
  const kind = Object.hasOwn(FLEET_OFFER_KINDS, String(raw.kind ?? "")) ? String(raw.kind) : "regular";
  const contractTerms = raw?.contractTerms
    ?? raw?.terms
    ?? (raw?.economyVersion >= 2 && String(raw?.calculationModel ?? "").startsWith("finite-demand-") ? raw?.termsSnapshot : null);
  const terms = contractTerms ?? {};
  const economy = quoteFleetContractEconomy({
      vessel,
      cargoPoints: terms.cargoPoints,
      returnCargoPoints: terms.returnCargoPoints,
      outboundDemandCargoPoints: terms.outboundDemandCargoPoints,
      returnDemandCargoPoints: terms.returnDemandCargoPoints,
      cargoLoad: terms.cargoPoints === undefined ? (terms.cargoLoad ?? 24_000) : 0,
      returnCargoLoad: terms.returnCargoPoints === undefined ? (terms.returnCargoLoad ?? 8_000) : 0,
      outboundDemandLoad: terms.outboundDemandLoad ?? terms.cargoDemandLoad,
      returnDemandLoad: terms.returnDemandLoad ?? terms.returnCargoDemandLoad,
      outboundDistanceKm: terms.outboundDistanceKm ?? terms.distanceKm ?? 160,
      returnDistanceKm: terms.returnDistanceKm ?? terms.distanceKm ?? 160,
      durationQd: terms.durationQd ?? raw.durationQd ?? (kind === "express" ? 80 : 120),
      demandFactor: terms.demandFactor ?? 1,
      returnDemandFactor: terms.returnDemandFactor ?? terms.demandFactor ?? 1,
      urgencyFactor: terms.urgencyFactor ?? (kind === "express" ? 1.25 : 1),
      riskPercent: terms.riskPercent ?? raw.riskPercent ?? (kind === "express" ? 15 : 5),
      portCalls: terms.portCalls ?? 2,
      externalCrewCopper: terms.externalCrewCopper ?? 0,
      residentCrewMemberIds: vessel?.crew?.memberIds ?? [],
      bonusCopper: terms.bonusCopper ?? 0
    });
  return normalizeFleetOffer({
    id: String(raw.id ?? makeId("fleet-offer", 20)),
    kind,
    title: raw.title ?? FLEET_OFFER_KINDS[kind],
    clientName: raw.clientName ?? "Торговый дом",
    destinationLabel: raw.destinationLabel ?? "Соседний порт",
    durationQd: raw.durationQd ?? contractTerms?.durationQd ?? (kind === "express" ? 80 : 120),
    outboundRevenueCopper: raw.outboundRevenueCopper ?? 0,
    returnRevenueCopper: raw.returnRevenueCopper ?? 0,
    operatingCostCopper: raw.operatingCostCopper ?? 0,
    replacementReserveCopper: raw.replacementReserveCopper ?? 0,
    riskPercent: raw.riskPercent ?? contractTerms?.riskPercent ?? (kind === "express" ? 15 : 5),
    createdAt: raw.createdAt ?? "",
    ...raw,
    ...economy,
    durationQd: economy?.termsSnapshot?.durationQd ?? raw.durationQd ?? contractTerms?.durationQd ?? (kind === "express" ? 80 : 120),
    riskPercent: economy?.termsSnapshot?.riskPercent ?? raw.riskPercent ?? contractTerms?.riskPercent ?? (kind === "express" ? 15 : 5)
  });
}

export function addFleetOffer(holding, { vesselId = "", offer = {} } = {}) {
  const { vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const normalized = createContractOffer(offer, { vessel });
  if (!normalized) return { ok: false, message: "Предложение не удалось подготовить." };
  if (!Array.isArray(vessel.offers)) vessel.offers = [];
  const existing = vessel.offers.find((row) => String(row?.id ?? "") === normalized.id);
  if (existing) return { ok: true, duplicate: true, offer: existing };
  vessel.offers.push(normalized);
  vessel.offers = vessel.offers.slice(-FLEET_OFFER_LIMIT);
  vessel.revision = copper(vessel.revision) + 1;
  return { ok: true, offer: normalized };
}

export function quoteFleetOffer(offer = {}) {
  const normalized = normalizeFleetOffer(offer);
  if (!normalized) return null;
  const grossRevenueCopper = copper(normalized.outboundRevenueCopper) + copper(normalized.returnRevenueCopper);
  const operatingCostCopper = copper(normalized.operatingCostCopper);
  const replacementReserveCopper = copper(normalized.replacementReserveCopper);
  const distributableResultCopper = grossRevenueCopper - operatingCostCopper - replacementReserveCopper;
  const emptyReturnCostCopper = normalized.returnRevenueCopper > 0 ? 0 : Math.round(operatingCostCopper / 2);
  return {
    ...normalized,
    grossRevenueCopper,
    operatingCostCopper,
    replacementReserveCopper,
    distributableResultCopper,
    emptyReturn: normalized.returnRevenueCopper <= 0,
    emptyReturnCostCopper
  };
}

export function acceptFleetOffer(holding, {
  vesselId = "",
  offerId = "",
  departureQd = 0,
  operationId = "",
  acceptedAt = "",
  currentQuoteKey = "",
  marketOfferAvailable = undefined,
  isGM = undefined
} = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const canSeeGmContent = viewerIsGm(isGM);
  if (vessel.visibility === "gm" && !canSeeGmContent) return { ok: false, message: "Корабль недоступен пользователю." };
  const opId = String(operationId || makeId("fleet-accept", 20));
  const duplicate = (vessel.history ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === opId);
  if (duplicate) {
    if (duplicate.visibility === "gm" && !canSeeGmContent) return { ok: false, message: "Предложение недоступно пользователю." };
    return { ok: true, duplicate: true, operationId: opId, voyage: vessel.activeVoyage };
  }
  if (vessel.activeVoyage) return { ok: false, message: "У корабля уже есть активный рейс." };
  if (vessel.activeRepair) return { ok: false, message: "Корабль находится в доковом ремонте." };
  if (["crisis", "archived"].includes(vessel.status)) return { ok: false, message: "Корабль сейчас не может принять рейс." };
  const offerIndex = (vessel.offers ?? []).findIndex((row) => String(row?.id ?? "") === String(offerId ?? ""));
  if (offerIndex < 0) return { ok: false, message: "Предложение больше не доступно." };
  const storedOffer = vessel.offers[offerIndex];
  if (storedOffer.active === false || storedOffer.available === false) return { ok: false, message: "Предложение больше не активно." };
  if (storedOffer.visibility === "gm" && !canSeeGmContent) return { ok: false, message: "Предложение недоступно пользователю." };
  if (storedOffer.source === "market-generated") {
    const vesselRegionId = String(vessel?.position?.regionId ?? "");
    const originRegionId = String(storedOffer.originRegionId ?? "");
    if (!originRegionId || vesselRegionId !== originRegionId) {
      return { ok: false, code: "wrong-origin", message: "Рыночный контракт можно принять только в порту, где он был предложен." };
    }
    if (!currentQuoteKey || String(storedOffer.quoteKey ?? "") !== String(currentQuoteKey)) {
      return { ok: false, code: "stale-offer", message: "Рыночное предложение устарело. Обнови список контрактов." };
    }
    if (marketOfferAvailable !== true) {
      return { ok: false, code: "market-unavailable", message: "Рынок этого контракта больше не доступен." };
    }
  }
  const requiredUrs = copper(storedOffer.requiredUrs);
  const access = holdingMarketAccessLevel(holding);
  if (access.level < requiredUrs) {
    return { ok: false, code: "insufficient-urs", message: `Для контракта нужен УРС ${requiredUrs}, у поселения УРС ${access.level}.` };
  }
  const quote = quoteFleetOffer(storedOffer);
  if (!quote) return { ok: false, message: "Предложение повреждено." };
  if (quote.economyVersion < 2 || quote.calculationModel !== "finite-demand-cargo-points-v2") {
    return { ok: false, code: "legacy-offer", message: "Старое предложение нельзя принять по прежней оценке. Удали или пересоздай его в новой экономике." };
  }
  const capacity = fleetVesselMarketCapacity(vessel);
  const capacityReservationCargoPoints = reservedCapacityCargoPoints(quote);
  if (!(capacityReservationCargoPoints > 0)) {
    return { ok: false, code: "invalid-cargo-points", message: "Контракт не содержит положительного груза в cargo points." };
  }
  if (capacityReservationCargoPoints > capacity.capacityCargoPoints) {
    return { ok: false, code: "capacity-exceeded", message: `Груз контракта требует ${capacityReservationCargoPoints} грузовых очков, корабль вмещает ${capacity.capacityCargoPoints}.` };
  }
  const crew = fleetCrewReadiness(holding, vessel);
  if (!crew.ok) return { ok: false, code: crew.code, message: crew.message, crew };
  if (fleetVesselAvailableCopper(vessel) < quote.operatingCostCopper) {
    return { ok: false, message: "Доступной кассы корабля после защищённых резервов недостаточно на обязательные расходы рейса." };
  }
  const startQd = copper(departureQd);
  if (!copper(vessel?.finances?.lastRecurringCostQd)) vessel.finances.lastRecurringCostQd = startQd;
  const voyage = normalizeFleetVoyage({
    ...quote,
    id: makeId("fleet-voyage", 20),
    offerId: quote.id,
    status: "active",
    departureQd: startQd,
    etaQd: startQd + quote.durationQd,
    lastProcessedQd: startQd,
    reservedCapacityCargoPoints: capacityReservationCargoPoints,
    reservedCapacityLoad: capacityReservationCargoPoints / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
    crewSnapshot: fleetCrewSnapshot(crew, startQd),
    costBreakdown: quote.economyVersion >= 2 ? {
      ...quote.costBreakdown,
      residentCrewPayrollCopper: 0,
      residentCrewPayrollCoveredBySettlement: true,
      residentCrewMemberIds: crew.memberIds.slice()
    } : quote.costBreakdown,
    termsSnapshot: quote.termsSnapshot ? {
      ...structuredClone(quote.termsSnapshot),
      reservedCapacityCargoPoints: capacityReservationCargoPoints,
      reservedCapacityLoad: capacityReservationCargoPoints / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
      residentCrewPayrollCoveredBySettlement: true,
      residentCrewMemberIds: crew.memberIds.slice()
    } : null,
    acceptedAt
  });
  vessel.offers.splice(offerIndex, 1);
  vessel.activeVoyage = voyage;
  vessel.status = "voyaging";
  vessel.position.dockedAtHoldingId = "";
  vessel.revision = copper(vessel.revision) + 1;
  fleet.activeVesselId = vessel.id;
  appendHistory(vessel, {
    operationId: opId,
    type: "voyage-accepted",
    offerId: String(quote.id ?? ""),
    marketId: String(quote.marketId ?? ""),
    quoteKey: String(quote.quoteKey ?? ""),
    visibility: quote.visibility,
    at: acceptedAt,
    title: `Принят рейс: ${voyage.title}`,
    summary: `${voyage.destinationLabel}; ETA QD ${voyage.etaQd}; расходы ${voyage.operatingCostCopper}; резерв ${voyage.replacementReserveCopper}; расчёт допускает убыток.`
  });
  return { ok: true, operationId: opId, voyage, quote };
}

export function assignFleetMarketDelivery(holding, {
  vesselId = "",
  plan = {},
  orderIds = [],
  departureQd = 0,
  operationId = "",
  acceptedAt = "",
  isGM = undefined
} = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const canSeeGmContent = viewerIsGm(isGM);
  if (vessel.visibility === "gm" && !canSeeGmContent) return { ok: false, message: "Корабль недоступен пользователю." };
  const opId = String(operationId || makeId("fleet-market-delivery", 20));
  const duplicate = (vessel.history ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === opId);
  if (duplicate) {
    if (duplicate.visibility === "gm" && !canSeeGmContent) return { ok: false, message: "Рынок доставки недоступен пользователю." };
    return { ok: true, duplicate: true, operationId: opId, voyage: vessel.activeVoyage };
  }
  if (!plan?.ownedVesselDelivery || String(plan?.ownedVesselId ?? "") !== String(vessel.id ?? "")) {
    return { ok: false, message: "План доставки не принадлежит выбранному кораблю." };
  }
  if (plan.ok === false || plan.inaccessible === true || plan.capacityExceeded === true || plan?.logistics?.ok === false) {
    return { ok: false, message: "План собственной доставки недоступен или превышает ограничения маршрута." };
  }
  const marketVisibility = String(plan.marketVisibility ?? plan?.logistics?.marketVisibility ?? "known");
  if (marketVisibility === "gm" && !canSeeGmContent) return { ok: false, message: "Рынок доставки недоступен пользователю." };
  if (plan.marketVisible === false || plan?.logistics?.marketVisible === false) return { ok: false, message: "Рынок доставки скрыт от пользователя." };
  if (plan.marketActive === false || plan.marketAvailable === false || plan?.logistics?.marketActive === false || plan?.logistics?.marketAvailable === false) {
    return { ok: false, message: "Рынок доставки сейчас недоступен." };
  }
  const access = holdingMarketAccessLevel(holding);
  const requiredAccessLevel = Math.max(
    copper(plan.requiredAccessLevel),
    copper(plan?.logistics?.requiredAccessLevel),
    copper(plan?.logistics?.routeAccessLevel),
    copper(plan?.logistics?.routeAccessCost)
  );
  if (access.level < requiredAccessLevel) {
    return { ok: false, code: "insufficient-urs", message: `Для доставки нужен УРС ${requiredAccessLevel}, у поселения УРС ${access.level}.` };
  }
  if (vessel.activeVoyage) return { ok: false, message: "У корабля уже есть активный рейс." };
  if (vessel.activeRepair) return { ok: false, message: "Корабль находится в доковом ремонте." };
  if (["crisis", "archived"].includes(vessel.status)) return { ok: false, message: "Корабль сейчас не может принять доставку." };
  const capacity = fleetVesselMarketCapacity(vessel);
  const cargoMassKg = Math.max(0, Number(plan.totalMassKg) || 0);
  const cargoVolumeL = Math.max(0, Number(plan.totalVolumeL) || 0);
  const hasCanonicalCargoPoints = Object.hasOwn(plan ?? {}, "totalCargoPoints")
    && plan.totalCargoPoints !== undefined
    && plan.totalCargoPoints !== null
    && plan.totalCargoPoints !== "";
  const capacityReservationCargoPoints = hasCanonicalCargoPoints
    ? cargoPoints(plan.totalCargoPoints)
    : cargoPoints(toNumber(plan.totalLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD);
  if (!(capacityReservationCargoPoints > 0)) {
    return { ok: false, code: "invalid-cargo-points", message: "План доставки не содержит положительного груза в cargo points." };
  }
  if (capacityReservationCargoPoints > capacity.capacityCargoPoints) {
    return { ok: false, code: "capacity-exceeded", message: `Груз требует ${capacityReservationCargoPoints} грузовых очков, корабль вмещает ${capacity.capacityCargoPoints}.` };
  }
  const crew = fleetCrewReadiness(holding, vessel);
  if (!crew.ok) return { ok: false, code: crew.code, message: crew.message, crew };
  const operatingCostCopper = copper(plan.ownedOperatingCostCopper);
  const internalTransferCopper = copper(plan.routeCopper);
  if (fleetVesselAvailableCopper(vessel) + internalTransferCopper < operatingCostCopper) {
    return { ok: false, message: "Доступной кассы корабля после защищённых резервов недостаточно на эксплуатацию доставки." };
  }
  const startQd = copper(departureQd);
  if (!copper(vessel?.finances?.lastRecurringCostQd)) vessel.finances.lastRecurringCostQd = startQd;
  const durationQd = Math.max(1, copper(plan.deliveryQd));
  const ids = (Array.isArray(orderIds) ? orderIds : []).map((id) => String(id ?? "")).filter(Boolean);
  const originDockedAtHoldingId = String(vessel?.position?.dockedAtHoldingId ?? "");
  const economy = quoteFleetContractEconomy({
    vessel,
    cargoPoints: capacityReservationCargoPoints,
    returnCargoLoad: 0,
    outboundDistanceKm: Math.max(0, Number(plan?.logistics?.distanceKm) || 0),
    returnDistanceKm: 0,
    durationQd,
    demandFactor: 1,
    returnDemandFactor: 1,
    urgencyFactor: 1,
    riskPercent: 0,
    portCalls: 2,
    residentCrewMemberIds: crew.memberIds
  });
  const costBreakdown = plan?.ownedCostBreakdown && typeof plan.ownedCostBreakdown === "object"
    ? structuredClone(plan.ownedCostBreakdown)
    : fleetVoyageCostQuote({ vessel, durationQd, portCalls: 2, residentCrewMemberIds: crew.memberIds }).costBreakdown;
  const voyage = normalizeFleetVoyage({
    id: makeId("fleet-market-voyage", 20),
    offerId: "",
    title: `Доставка: ${String(plan.marketLabel ?? "Внешний рынок")} → ${String(plan.ownedDestinationLabel ?? holding.name ?? "поселение")}`,
    kind: "regular",
    sourceType: "market-delivery",
    status: "active",
    originRegionId: String(vessel?.position?.regionId ?? ""),
    originDockedAtHoldingId,
    pickupRegionId: String(plan.ownedPickupRegionId ?? ""),
    pickupLabel: String(plan.ownedPickupLabel ?? plan.marketLabel ?? "Точка забора"),
    destinationRegionId: String(plan.ownedDestinationRegionId ?? holding?.overview?.region ?? ""),
    destinationLabel: String(plan.ownedDestinationLabel ?? holding.name ?? "Поселение"),
    destinationHoldingId: String(holding.id ?? ""),
    departureQd: startQd,
    etaQd: startQd + durationQd,
    lastProcessedQd: startQd,
    reservedCapacityCargoPoints: capacityReservationCargoPoints,
    reservedCapacityLoad: capacityReservationCargoPoints / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
    crewSnapshot: fleetCrewSnapshot(crew, startQd),
    durationQd,
    pickupQd: copper(plan.ownedPickupQd),
    cargoQd: copper(plan.ownedCargoQd),
    handlingQd: copper(plan.ownedHandlingQd),
    economyVersion: 2,
    outboundRevenueCopper: 0,
    returnRevenueCopper: 0,
    operatingCostCopper,
    costBreakdown,
    revenueBreakdown: {
      outboundCargoCopper: 0,
      returnCargoCopper: 0,
      bonusCopper: 0,
      internalTransferCopper,
      internalTransferIsRevenue: false
    },
    internalTransferCopper,
    replacementReserveCopper: copper(plan.ownedReplacementReserveCopper),
    termsSnapshot: {
      ...economy.termsSnapshot,
      sourceType: "market-delivery",
      cargoPoints: capacityReservationCargoPoints,
      cargoLoad: capacityReservationCargoPoints / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
      cargoMassKg,
      cargoVolumeL,
      reservedCapacityCargoPoints: capacityReservationCargoPoints,
      reservedCapacityLoad: capacityReservationCargoPoints / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
      internalTransferCopper,
      internalTransferIsRevenue: false
    },
    wearSteps: economy.wearSteps,
    riskPercent: 0,
    linkedMarketOrderIds: ids,
    marketOperationId: opId,
    notes: `Собственная доставка; груз ${capacityReservationCargoPoints} грузовых очков; заказ ${ids.join(", ") || opId}.`,
    acceptedAt
  });
  vessel.finances.cashCopper = copper(vessel.finances.cashCopper) + internalTransferCopper;
  appendFleetLedger(vessel, {
    operationId: `${opId}:funding`,
    type: "settlement-transfer",
    at: acceptedAt,
    qd: startQd,
    cashDeltaCopper: internalTransferCopper,
    internalTransferCopper,
    title: "Финансирование собственной доставки",
    summary: `${internalTransferCopper} медных перенесено из уже оплаченного поселением заказа в кассу корабля; это внутренний перевод, не выручка.`
  });
  fleet.transfers.push({
    id: `${opId}:funding`,
    operationId: `${opId}:funding`,
    vesselId: vessel.id,
    direction: "holding-to-vessel",
    amountCopper: internalTransferCopper,
    feeCopper: 0,
    netCopper: internalTransferCopper,
    refundedCopper: 0,
    createdAt: String(acceptedAt ?? ""),
    completedAt: String(acceptedAt ?? ""),
    createdQd: startQd,
    etaQd: startQd,
    completedQd: startQd,
    method: "physical",
    status: "completed",
    trace: "none",
    completionOperationId: `${opId}:funding`,
    cancelOperationId: "",
    internal: true,
    sourceType: "market-order-allocation",
    externalRevenue: false
  });
  fleet.transfers = fleet.transfers.slice(-FLEET_TRANSFER_LIMIT);
  vessel.activeVoyage = voyage;
  vessel.status = "voyaging";
  vessel.position.dockedAtHoldingId = "";
  vessel.revision = copper(vessel.revision) + 1;
  fleet.activeVesselId = vessel.id;
  appendHistory(vessel, {
    operationId: opId,
    type: "market-delivery-accepted",
    visibility: marketVisibility,
    at: acceptedAt,
    title: `Принята собственная доставка: ${plan.marketLabel ?? "рынок"}`,
    summary: `До точки забора ${copper(plan.ownedPickupQd)} QD; с грузом ${copper(plan.ownedCargoQd)} QD; ETA QD ${voyage.etaQd}; внутреннее финансирование ${internalTransferCopper}, выручка 0.`
  });
  return { ok: true, operationId: opId, voyage };
}

export function cancelFleetMarketDelivery(holding, { vesselId = "", orderId = "", operationId = "", cancelledAt = "" } = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const requestedOperationId = String(operationId ?? "").trim();
  const duplicate = requestedOperationId
    ? (vessel.history ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === requestedOperationId && row?.type === "market-delivery-cancelled")
    : null;
  if (duplicate) return { ok: true, duplicate: true, operationId: requestedOperationId };
  const voyage = vessel.activeVoyage;
  const order = String(orderId ?? "");
  if (!voyage || voyage.sourceType !== "market-delivery" || !(voyage.linkedMarketOrderIds ?? []).map(String).includes(order)) {
    return { ok: false, message: "Связанный рейс уже отправлен или завершён; полный возврат за доставку недоступен." };
  }
  const opId = String(operationId || `${voyage.marketOperationId || voyage.id}:cancel`);
  const internalTransferCopper = copper(voyage.internalTransferCopper ?? voyage?.revenueBreakdown?.internalTransferCopper);
  if (internalTransferCopper > copper(vessel?.finances?.cashCopper)) {
    return { ok: false, message: "Касса корабля уже не покрывает возврат внутреннего финансирования доставки." };
  }
  if (internalTransferCopper > 0) {
    vessel.finances.cashCopper = copper(vessel.finances.cashCopper) - internalTransferCopper;
    appendFleetLedger(vessel, {
      operationId: `${opId}:funding-reversal`,
      type: "settlement-transfer-reversal",
      at: cancelledAt,
      qd: copper(voyage.departureQd),
      cashDeltaCopper: -internalTransferCopper,
      internalTransferCopper: -internalTransferCopper,
      title: "Возврат финансирования доставки",
      summary: `${internalTransferCopper} медных возвращаются в составе полного возврата рыночного заказа; это не расход предприятия.`
    });
    fleet.transfers.push({
      id: `${opId}:funding-reversal`,
      operationId: `${opId}:funding-reversal`,
      vesselId: vessel.id,
      direction: "vessel-to-holding",
      amountCopper: internalTransferCopper,
      feeCopper: 0,
      netCopper: internalTransferCopper,
      refundedCopper: 0,
      createdAt: String(cancelledAt ?? ""),
      completedAt: String(cancelledAt ?? ""),
      createdQd: copper(voyage.departureQd),
      etaQd: copper(voyage.departureQd),
      completedQd: copper(voyage.departureQd),
      method: "physical",
      status: "completed",
      trace: "none",
      completionOperationId: `${opId}:funding-reversal`,
      cancelOperationId: "",
      internal: true,
      sourceType: "market-order-refund",
      externalRevenue: false
    });
    fleet.transfers = fleet.transfers.slice(-FLEET_TRANSFER_LIMIT);
  }
  vessel.activeVoyage = null;
  vessel.position.dockedAtHoldingId = String(voyage.originDockedAtHoldingId ?? "");
  vessel.status = vessel.position.dockedAtHoldingId ? "docked" : "idle";
  vessel.revision = copper(vessel.revision) + 1;
  appendHistory(vessel, {
    operationId: opId,
    type: "market-delivery-cancelled",
    at: cancelledAt,
    title: `Отменена доставка: ${voyage.title}`,
    summary: `Рыночный заказ отменён до отправки; корабль освобождён, внутреннее финансирование ${internalTransferCopper} возвращено через рыночный возврат.`
  });
  return { ok: true, operationId: opId, voyage, internalTransferCopper };
}

function completeVoyage(vessel, targetQd, { completedAt = "", operationId = "", riskResolution = null } = {}) {
  const voyage = vessel.activeVoyage;
  const v2 = copper(voyage.economyVersion) >= 2;
  const expectedGrossRevenueCopper = v2
    ? copper(voyage?.revenueBreakdown?.totalCopper)
    : copper(voyage.outboundRevenueCopper) + copper(voyage.returnRevenueCopper);
  const commercialOutcome = String(riskResolution?.outcome ?? voyage?.riskResolution?.outcome ?? "clear");
  const commercialLoss = voyage?.sourceType !== "market-delivery" && commercialOutcome === "lost";
  const grossRevenueCopper = commercialLoss ? 0 : expectedGrossRevenueCopper;
  const lostRevenueCopper = Math.max(0, expectedGrossRevenueCopper - grossRevenueCopper);
  const operatingCostCopper = copper(voyage.operatingCostCopper);
  const cashBefore = copper(vessel.finances.cashCopper);
  if (cashBefore + grossRevenueCopper < operatingCostCopper) {
    voyage.status = "crisis";
    voyage.lastProcessedQd = targetQd;
    vessel.status = "crisis";
    vessel.revision = copper(vessel.revision) + 1;
    return {
      ok: false,
      crisis: true,
      lost: commercialLoss,
      outcome: commercialOutcome,
      scenario: String(riskResolution?.scenario ?? voyage?.riskResolution?.scenario ?? (commercialLoss ? "loss" : "ordinary")),
      vesselId: vessel.id,
      voyageId: voyage.id,
      expectedGrossRevenueCopper,
      grossRevenueCopper,
      lostRevenueCopper,
      operatingCostCopper,
      message: "Касса не покрывает обязательные расходы завершения рейса."
    };
  }
  const cashDeltaCopper = grossRevenueCopper - operatingCostCopper;
  const cashAfter = cashBefore + cashDeltaCopper;
  const reserveBefore = copper(vessel.finances.replacementReserveCopper);
  const otherProtected = copper(vessel.finances.operatingReserveCopper) + copper(vessel.finances.emergencyReserveCopper);
  const reserveCapacity = Math.max(0, cashAfter - otherProtected - reserveBefore);
  const reserveContribution = Math.min(copper(voyage.replacementReserveCopper), reserveCapacity);
  vessel.finances.cashCopper = cashAfter;
  vessel.finances.replacementReserveCopper = reserveBefore + reserveContribution;
  const wear = v2 ? applyFleetWear(vessel, voyage.wearSteps) : { before: copper(vessel?.condition?.wear), applied: 0, after: copper(vessel?.condition?.wear) };
  const completed = {
    ...voyage,
    status: "completed",
    lastProcessedQd: targetQd,
    completedAt,
    riskResolution: riskResolution ? structuredClone(riskResolution) : voyage.riskResolution,
    commercialOutcome,
    commercialScenario: String(riskResolution?.scenario ?? voyage?.riskResolution?.scenario ?? (commercialLoss ? "loss" : "ordinary")),
    expectedGrossRevenueCopper,
    grossRevenueCopper,
    lostRevenueCopper,
    cashDeltaCopper,
    reserveContributionCopper: reserveContribution,
    wearAppliedSteps: wear.applied,
    wearAfter: wear.after
  };
  vessel.activeVoyage = null;
  vessel.status = "docked";
  vessel.position.regionId = String(voyage.completionRegionId ?? voyage.destinationRegionId ?? vessel.position.regionId ?? "");
  vessel.position.locationLabel = String(voyage.completionLabel ?? voyage.destinationLabel ?? "");
  vessel.position.dockedAtHoldingId = String(voyage.destinationHoldingId ?? "");
  vessel.revision = copper(vessel.revision) + 1;
  const opId = String(operationId || `fleet-voyage:${voyage.id}:complete`);
  const completionTitle = commercialLoss ? `Рейс завершён с утратой груза: ${voyage.title}` : `Завершён рейс: ${voyage.title}`;
  const outcomeSummary = commercialLoss
    ? `Коммерческий груз утрачен; ожидаемая выручка ${expectedGrossRevenueCopper}, получено 0; `
    : (commercialOutcome === "delayed" ? `Рейс прибыл после задержки ${copper(riskResolution?.delayQd ?? voyage?.riskResolution?.delayQd)} QD; ` : "");
  appendFleetLedger(vessel, {
    operationId: opId,
    type: voyage.sourceType === "market-delivery" ? "owned-delivery-completed" : (commercialLoss ? "voyage-cargo-lost" : "voyage-completed"),
    at: completedAt,
    qd: targetQd,
    cashDeltaCopper,
    reserveDeltaCopper: reserveContribution,
    internalTransferCopper: 0,
    title: completionTitle,
    summary: `${outcomeSummary}Внешняя выручка ${grossRevenueCopper}; снабжение ${copper(voyage?.costBreakdown?.suppliesCopper)}; топливо ${copper(voyage?.costBreakdown?.fuelCopper)}; порт ${copper(voyage?.costBreakdown?.portFeesCopper)}; прочие расходы ${Math.max(0, operatingCostCopper - copper(voyage?.costBreakdown?.suppliesCopper) - copper(voyage?.costBreakdown?.fuelCopper) - copper(voyage?.costBreakdown?.portFeesCopper))}; резерв ${reserveContribution}; износ +${wear.applied}.`
  });
  appendHistory(vessel, {
    operationId: opId,
    type: commercialLoss ? "voyage-cargo-lost" : "voyage-completed",
    at: completedAt,
    title: completionTitle,
    summary: `${outcomeSummary}${voyage.sourceType === "market-delivery" ? `Внутренний перевод ${copper(voyage.internalTransferCopper)} (не выручка); ` : ""}выручка ${grossRevenueCopper}; расходы ${operatingCostCopper}; резерв ${reserveContribution}; износ +${wear.applied}; касса ${cashDeltaCopper >= 0 ? "+" : ""}${cashDeltaCopper}.`,
    amountCopper: cashDeltaCopper,
    voyage: completed
  });
  return {
    ok: true,
    completed: true,
    lost: commercialLoss,
    outcome: commercialOutcome,
    scenario: completed.commercialScenario,
    vesselId: vessel.id,
    voyage: completed,
    expectedGrossRevenueCopper,
    grossRevenueCopper,
    lostRevenueCopper,
    operatingCostCopper,
    cashDeltaCopper,
    reserveContributionCopper: reserveContribution,
    wear
  };
}

function chargeFleetIdleThroughQd(holding, vessel, targetQd, voyageAtStart = null, { chargedAt = "" } = {}) {
  const finances = vessel.finances ?? (vessel.finances = {});
  const target = copper(targetQd);
  let marker = copper(finances.lastRecurringCostQd);
  if (!marker) {
    const holdingQd = currentFleetQd(holding);
    marker = Math.max(holdingQd, Math.max(0, target - FLEET_TENDAY_QD));
  }
  if (target <= marker) {
    finances.lastRecurringCostQd = marker;
    return { ok: true, charged: false, periods: 0, throughQd: marker };
  }
  const elapsedPeriods = Math.floor((target - marker) / FLEET_TENDAY_QD);
  if (!elapsedPeriods) {
    finances.lastRecurringCostQd = marker;
    return { ok: true, charged: false, periods: 0, throughQd: marker };
  }
  const throughQd = marker + elapsedPeriods * FLEET_TENDAY_QD;
  finances.lastRecurringCostQd = throughQd;
  if (vessel.status === "archived") return { ok: true, charged: false, periods: 0, throughQd, archived: true };
  const departureQd = copper(voyageAtStart?.departureQd);
  const etaQd = copper(voyageAtStart?.etaQd);
  const billableBoundaries = Array.from({ length: elapsedPeriods }, (_, index) => marker + (index + 1) * FLEET_TENDAY_QD)
    .filter((boundaryQd) => !(voyageAtStart && boundaryQd > departureQd && boundaryQd <= etaQd));
  if (!billableBoundaries.length) return { ok: true, charged: false, periods: 0, throughQd, voyaging: true };
  const result = chargeFleetIdleCosts(vessel, {
    periods: billableBoundaries.length,
    throughQd,
    operationId: `fleet-idle:${vessel.id}:${billableBoundaries[0]}-${billableBoundaries.at(-1)}`,
    chargedAt
  });
  if (result.charged) appendHistory(vessel, {
    operationId: `fleet-idle-history:${vessel.id}:${billableBoundaries[0]}-${billableBoundaries.at(-1)}`,
    type: "idle-cost",
    at: chargedAt,
    title: "Списаны расходы стоянки",
    summary: `Причал ${result.mooringCopper}; базовое обслуживание ${result.basicMaintenanceCopper}; уплачено ${result.paidCopper}; долг ${result.arrearsAfterCopper}.`,
    amountCopper: -result.paidCopper
  });
  return { ...result, billableBoundaries, throughQd };
}

export function quoteFleetRepair(holding, { vesselId = "", wearSteps = 5 } = {}) {
  const { vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  return quoteFleetRepairTerms(holding, vessel, { wearSteps });
}

export function startFleetRepair(holding, {
  vesselId = "",
  wearSteps = 5,
  operationId = "",
  startedQd = null,
  startedAt = ""
} = {}) {
  const { vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const qd = startedQd === null || startedQd === undefined ? currentFleetQd(holding) : copper(startedQd);
  const result = startFleetRepairTerms(holding, vessel, { wearSteps, operationId, startedQd: qd, startedAt });
  if (!result.ok || result.duplicate) return result;
  vessel.revision = copper(vessel.revision) + 1;
  appendHistory(vessel, {
    operationId: result.operationId,
    type: "repair-started",
    at: startedAt,
    title: "Корабль поставлен в док",
    summary: `Ремонт на ${result.repair.wearSteps} шагов до QD ${result.repair.completesQd}; ${result.repair.moneyCopper} медных; ${result.repair.materials.map((row) => `${row.qty} ${row.name}`).join(", ")}.`,
    amountCopper: -result.repair.moneyCopper
  });
  return result;
}

export function advanceFleetToQd(holding, targetQd = 0, { completedAt = "", operationId = "", riskUnit = null } = {}) {
  const fleet = ensureFleet(holding);
  const target = copper(targetQd);
  const voyageAtStart = new Map(fleet.vessels.map((vessel) => [String(vessel?.id ?? ""), vessel?.activeVoyage ?? null]));
  const report = {
    ok: true,
    targetQd: target,
    advanced: [],
    delayed: [],
    losses: [],
    completed: [],
    crises: [],
    idleCosts: [],
    repairs: [],
    ignored: 0,
    completedTransfers: [],
    ignoredTransfers: 0
  };
  for (const vessel of fleet.vessels) {
    const voyage = vessel.activeVoyage;
    if (!voyage || !["active", "crisis"].includes(voyage.status)) {
      report.ignored += 1;
      continue;
    }
    const crew = activeVoyageCrewReadiness(holding, vessel, voyage);
    if (!crew.ok) {
      const firstCrewCrisis = voyage.crisisCode !== "undercrewed";
      voyage.status = "crisis";
      voyage.crisisCode = "undercrewed";
      voyage.crewCrisis = {
        crewTarget: crew.crewTarget,
        residentCount: crew.residentCount,
        missing: crew.missing,
        detectedAtQd: target
      };
      vessel.status = "crisis";
      if (firstCrewCrisis) vessel.revision = copper(vessel.revision) + 1;
      report.crises.push({
        ok: false,
        crisis: true,
        code: "undercrewed",
        vesselId: vessel.id,
        voyageId: voyage.id,
        crew,
        message: crew.message
      });
      continue;
    }
    if (voyage.status === "crisis") {
      if (voyage.crisisCode !== "undercrewed") {
        report.ignored += 1;
        continue;
      }
      voyage.status = "active";
      delete voyage.crisisCode;
      delete voyage.crewCrisis;
      vessel.status = "voyaging";
      vessel.revision = copper(vessel.revision) + 1;
    }
    if (target <= copper(voyage.lastProcessedQd)) {
      report.ignored += 1;
      continue;
    }
    if (target > copper(voyage.departureQd)) {
      markFleetMarketDeliveryDispatched(holding, voyage, { dispatchedAt: completedAt });
    }
    if (target < copper(voyage.etaQd)) {
      voyage.lastProcessedQd = target;
      vessel.revision = copper(vessel.revision) + 1;
      report.advanced.push({ vesselId: vessel.id, voyageId: voyage.id, targetQd: target, remainingQd: voyage.etaQd - target });
      continue;
    }
    let riskResolution = voyage.riskResolution?.status === "resolved" ? voyage.riskResolution : null;
    if (voyage.sourceType !== "market-delivery" && !riskResolution) {
      riskResolution = quoteFleetVoyageRisk({ voyage, resolvedAtQd: target, resolvedAt: completedAt, riskUnit });
      voyage.riskResolution = riskResolution;
    }
    if (riskResolution?.outcome === "delayed" && riskResolution.delayApplied !== true) {
      const originalEtaQd = copper(voyage.etaQd);
      const delayedEtaQd = originalEtaQd + Math.max(1, copper(riskResolution.delayQd));
      riskResolution.delayApplied = true;
      riskResolution.originalEtaQd = originalEtaQd;
      riskResolution.delayedEtaQd = delayedEtaQd;
      riskResolution.delayAppliedAtQd = target;
      voyage.etaQd = delayedEtaQd;
      vessel.revision = copper(vessel.revision) + 1;
      const delayResult = {
        ok: true,
        delayed: true,
        outcome: "delayed",
        scenario: riskResolution.scenario,
        vesselId: vessel.id,
        voyageId: voyage.id,
        delayQd: riskResolution.delayQd,
        originalEtaQd,
        etaQd: delayedEtaQd,
        riskResolution: structuredClone(riskResolution)
      };
      appendHistory(vessel, {
        operationId: `${riskResolution.resolutionId}:delay`,
        type: "voyage-delayed",
        at: completedAt,
        title: `Рейс задерживается: ${voyage.title}`,
        summary: `Коммерческий риск реализовался как задержка на ${riskResolution.delayQd} QD; новый ETA QD ${delayedEtaQd}.`
      });
      report.delayed.push(delayResult);
      if (target < delayedEtaQd) {
        voyage.lastProcessedQd = target;
        continue;
      }
    }
    const result = completeVoyage(vessel, target, {
      completedAt,
      operationId: operationId ? `${operationId}:${vessel.id}` : "",
      riskResolution
    });
    if (result.lost) report.losses.push(result);
    if (result.crisis) report.crises.push(result);
    else report.completed.push(result);
  }
  for (const vessel of fleet.vessels) {
    const repair = advanceFleetRepair(holding, vessel, target, { completedAt });
    if (repair.completed) {
      vessel.revision = copper(vessel.revision) + 1;
      appendHistory(vessel, {
        operationId: `${repair.repair.operationId}:complete`,
        type: "repair-completed",
        at: completedAt,
        title: "Доковый ремонт завершён",
        summary: `Износ ${repair.wearBefore} → ${repair.wearAfter}; повторного списания денег и материалов нет.`
      });
      report.repairs.push({ vesselId: vessel.id, ...repair });
    } else if (repair.paused) {
      report.repairs.push({ vesselId: vessel.id, ...repair });
    }
    const idle = chargeFleetIdleThroughQd(holding, vessel, target, voyageAtStart.get(String(vessel?.id ?? "")), { chargedAt: completedAt });
    if (idle.charged) {
      vessel.revision = copper(vessel.revision) + 1;
      report.idleCosts.push({ vesselId: vessel.id, ...idle });
    }
  }
  for (const transfer of fleet.transfers) {
    if (transfer?.status !== "pending" || target < copper(transfer.etaQd)) {
      report.ignoredTransfers += 1;
      continue;
    }
    const vessel = fleet.vessels.find((row) => String(row?.id ?? "") === String(transfer.vesselId ?? ""));
    if (!vessel) {
      report.ignoredTransfers += 1;
      continue;
    }
    const completionOperationId = String(transfer.completionOperationId || `${transfer.operationId}:complete`);
    const netCopper = copper(transfer.netCopper);
    if (transfer.direction === "vessel-to-holding") {
      const storage = ensureStorage(holding);
      storage.moneyCopper = copper(storage.moneyCopper) + netCopper;
      appendStorageTransferLog(holding, {
        operationId: completionOperationId,
        vesselName: vessel.name,
        qty: netCopper,
        createdAt: completedAt,
        note: `Завершён ${transfer.method === "bank" ? "банковский" : "теневой"} перевод из кассы корабля`
      });
    } else {
      vessel.finances.cashCopper = copper(vessel?.finances?.cashCopper) + netCopper;
    }
    transfer.status = "completed";
    transfer.completedAt = String(completedAt ?? "");
    transfer.completedQd = target;
    transfer.completionOperationId = completionOperationId;
    vessel.revision = copper(vessel.revision) + 1;
    appendFleetLedger(vessel, {
      operationId: completionOperationId,
      type: "transfer-completed",
      at: completedAt,
      qd: target,
      cashDeltaCopper: transfer.direction === "holding-to-vessel" ? netCopper : 0,
      internalTransferCopper: transfer.internal ? (transfer.direction === "holding-to-vessel" ? netCopper : -netCopper) : 0,
      title: transfer.direction === "vessel-to-holding" ? "Перевод поступил в поселение" : "Перевод поступил на корабль",
      summary: `Получено ${netCopper}; комиссия ${copper(transfer.feeCopper)}; канал ${transfer.method}.`
    });
    appendHistory(vessel, {
      operationId: completionOperationId,
      type: "transfer-completed",
      at: completedAt,
      title: transfer.direction === "vessel-to-holding" ? "Деньги поступили в казну" : "Деньги поступили в кассу корабля",
      summary: `${netCopper} медных после комиссии ${copper(transfer.feeCopper)}; ${transfer.method === "bank" ? "банковский канал" : "теневой посредник"}.`,
      amountCopper: transfer.direction === "holding-to-vessel" ? netCopper : 0
    });
    report.completedTransfers.push({ transferId: transfer.id, vesselId: vessel.id, netCopper, completionOperationId });
  }
  return report;
}

export function quoteFleetTransfer(holding, {
  vesselId = "",
  direction = "vessel-to-holding",
  amountCopper = 0,
  method = "physical",
  createdQd = null
} = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const normalizedDirection = direction === "holding-to-vessel" ? "holding-to-vessel" : "vessel-to-holding";
  const transferMethod = fleetTransferMethod(fleet, method);
  if (!transferMethod.enabled) return { ok: false, message: "Этот способ перевода отключён GM." };
  const amount = copper(amountCopper);
  if (amount <= 0) return { ok: false, message: "Сумма перевода должна быть больше нуля." };
  if (transferMethod.requiresDock && String(vessel?.position?.dockedAtHoldingId ?? "") !== String(holding?.id ?? "")) {
    return { ok: false, message: "Физическая передача доступна, только когда корабль пришвартован у этого поселения." };
  }
  const feeCopper = transferMethod.id === "physical" ? 0 : Math.ceil(amount * transferMethod.feePercent / 100);
  const netCopper = Math.max(0, amount - feeCopper);
  if (netCopper <= 0) return { ok: false, message: "Комиссия поглощает всю сумму перевода." };
  const availableCopper = normalizedDirection === "vessel-to-holding"
    ? fleetVesselAvailableCopper(vessel)
    : copper(holding?.storage?.moneyCopper);
  if (amount > availableCopper) {
    return {
      ok: false,
      message: normalizedDirection === "vessel-to-holding"
        ? `Доступно к распределению только ${availableCopper} медных.`
        : `В казне поселения только ${availableCopper} медных.`
    };
  }
  const startQd = createdQd === null ? currentFleetQd(holding) : copper(createdQd);
  return {
    ok: true,
    vessel,
    fleet,
    direction: normalizedDirection,
    method: transferMethod.id,
    methodLabel: transferMethod.label,
    amountCopper: amount,
    feeCopper,
    netCopper,
    feePercent: transferMethod.feePercent,
    createdQd: startQd,
    etaQd: startQd + transferMethod.etaQd,
    etaDurationQd: transferMethod.etaQd,
    trace: transferMethod.trace,
    immediate: transferMethod.id === "physical"
  };
}

export function applyFleetTransfer(holding, {
  vesselId = "",
  direction = "vessel-to-holding",
  amountCopper = 0,
  operationId = "",
  createdAt = "",
  method = "physical",
  createdQd = null
} = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const opId = String(operationId ?? "").trim();
  if (!opId) return { ok: false, message: "Для перевода требуется operationId." };
  const existing = (fleet.transfers ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === opId);
  if (existing) return { ok: true, duplicate: true, operationId: opId, transfer: existing };
  const quote = quoteFleetTransfer(holding, { vesselId, direction, amountCopper, method, createdQd });
  if (!quote.ok) return quote;
  const storage = ensureStorage(holding);
  if (quote.direction === "vessel-to-holding") {
    vessel.finances.cashCopper = copper(vessel.finances.cashCopper) - quote.amountCopper;
    if (quote.immediate) storage.moneyCopper = copper(storage.moneyCopper) + quote.netCopper;
  } else {
    storage.moneyCopper = copper(storage.moneyCopper) - quote.amountCopper;
    if (quote.immediate) vessel.finances.cashCopper = copper(vessel.finances.cashCopper) + quote.netCopper;
  }
  vessel.revision = copper(vessel.revision) + 1;
  const transfer = {
    id: opId,
    operationId: opId,
    vesselId: vessel.id,
    direction: quote.direction,
    amountCopper: quote.amountCopper,
    feeCopper: quote.feeCopper,
    netCopper: quote.netCopper,
    refundedCopper: 0,
    createdAt,
    completedAt: quote.immediate ? createdAt : "",
    cancelledAt: "",
    createdQd: quote.createdQd,
    etaQd: quote.etaQd,
    completedQd: quote.immediate ? quote.createdQd : 0,
    method: quote.method,
    status: quote.immediate ? "completed" : "pending",
    trace: quote.trace,
    completionOperationId: quote.immediate ? opId : "",
    cancelOperationId: ""
  };
  fleet.transfers.push(transfer);
  fleet.transfers = fleet.transfers.slice(-FLEET_TRANSFER_LIMIT);
  if (quote.immediate || quote.direction === "holding-to-vessel") {
    appendStorageTransferLog(holding, {
      operationId: opId,
      vesselName: vessel.name,
      qty: quote.direction === "vessel-to-holding" ? quote.netCopper : -quote.amountCopper,
      createdAt,
      status: quote.immediate ? "completed" : "pending",
      note: quote.immediate
        ? (quote.direction === "vessel-to-holding" ? "Передано из кассы корабля" : "Передано в кассу корабля")
        : `Зарезервировано для ${quote.method === "bank" ? "банковского" : "теневого"} перевода в кассу корабля`
    });
  }
  appendFleetLedger(vessel, {
    operationId: opId,
    type: "transfer",
    at: createdAt,
    qd: quote.createdQd,
    cashDeltaCopper: quote.direction === "vessel-to-holding" ? -quote.amountCopper : (quote.immediate ? quote.netCopper : 0),
    title: quote.direction === "vessel-to-holding" ? "Перевод из кассы корабля" : "Перевод в кассу корабля",
    summary: `Сумма ${quote.amountCopper}; комиссия ${quote.feeCopper}; чистое поступление ${quote.netCopper}; ${quote.immediate ? "завершён" : `ETA QD ${quote.etaQd}`}.`
  });
  appendHistory(vessel, {
    operationId: opId,
    type: "transfer",
    at: createdAt,
    title: quote.direction === "vessel-to-holding" ? "Перевод в казну поселения" : "Пополнение кассы корабля",
    summary: quote.immediate
      ? `${quote.amountCopper} медных, физическая передача без комиссии.`
      : `${quote.amountCopper} медных отправлено; комиссия ${quote.feeCopper}; поступит ${quote.netCopper} к QD ${quote.etaQd}; ${quote.methodLabel}.`,
    amountCopper: quote.direction === "vessel-to-holding" ? -quote.amountCopper : (quote.immediate ? quote.netCopper : 0)
  });
  return {
    ok: true,
    operationId: opId,
    transfer,
    amountCopper: quote.amountCopper,
    feeCopper: quote.feeCopper,
    netCopper: quote.netCopper,
    direction: quote.direction,
    pending: !quote.immediate
  };
}

export function cancelFleetTransfer(holding, {
  vesselId = "",
  transferId = "",
  operationId = "",
  cancelledAt = "",
  currentQd = null
} = {}) {
  const { fleet, vessel } = vesselById(holding, vesselId);
  if (!vessel) return { ok: false, message: "Корабль не найден." };
  const opId = String(operationId ?? "").trim();
  if (!opId) return { ok: false, message: "Для отмены требуется operationId." };
  const duplicate = (fleet.transfers ?? []).find((row) => String(row?.cancelOperationId ?? "") === opId);
  if (duplicate) return { ok: true, duplicate: true, operationId: opId, transfer: duplicate };
  const transfer = (fleet.transfers ?? []).find((row) => String(row?.id ?? "") === String(transferId ?? "")
    && String(row?.vesselId ?? "") === String(vessel.id ?? ""));
  if (!transfer) return { ok: false, message: "Перевод не найден." };
  if (transfer.status !== "pending") return { ok: false, message: "Отменить можно только ожидающий перевод." };
  const nowQd = currentQd === null ? currentFleetQd(holding) : copper(currentQd);
  if (nowQd >= copper(transfer.etaQd)) {
    return { ok: false, message: "Срок перевода уже наступил; сначала примени продвижение календаря." };
  }
  const refundedCopper = Math.max(0, copper(transfer.amountCopper) - copper(transfer.feeCopper));
  if (transfer.direction === "vessel-to-holding") {
    vessel.finances.cashCopper = copper(vessel?.finances?.cashCopper) + refundedCopper;
  } else {
    const storage = ensureStorage(holding);
    storage.moneyCopper = copper(storage.moneyCopper) + refundedCopper;
    appendStorageTransferLog(holding, {
      operationId: opId,
      vesselName: vessel.name,
      qty: refundedCopper,
      createdAt: cancelledAt,
      status: "cancelled",
      note: `Возврат отменённого перевода; удержана комиссия ${copper(transfer.feeCopper)}`
    });
  }
  transfer.status = "cancelled";
  transfer.cancelOperationId = opId;
  transfer.cancelledAt = String(cancelledAt ?? "");
  transfer.refundedCopper = refundedCopper;
  vessel.revision = copper(vessel.revision) + 1;
  appendFleetLedger(vessel, {
    operationId: opId,
    type: "transfer-cancelled",
    at: cancelledAt,
    qd: nowQd,
    cashDeltaCopper: transfer.direction === "vessel-to-holding" ? refundedCopper : 0,
    title: "Перевод отменён",
    summary: `Возвращено ${refundedCopper}; невозвратная комиссия ${copper(transfer.feeCopper)}.`
  });
  appendHistory(vessel, {
    operationId: opId,
    type: "transfer-cancelled",
    at: cancelledAt,
    title: "Перевод отменён",
    summary: `Возвращено ${refundedCopper} медных; комиссия ${copper(transfer.feeCopper)} не возвращается.`,
    amountCopper: transfer.direction === "vessel-to-holding" ? refundedCopper : 0
  });
  return { ok: true, operationId: opId, transfer, refundedCopper, feeCopper: copper(transfer.feeCopper) };
}
