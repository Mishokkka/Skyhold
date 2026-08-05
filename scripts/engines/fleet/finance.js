import { consumeAvailableStorageLots, storageAvailableQuantity } from "../storage/reservations.js";
import {
  DEFAULT_FLEET_FINANCE_TERMS,
  FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
  FLEET_DEFAULT_FREIGHT_COPPER_PER_100_CARGO_POINTS_100_KM,
  FLEET_LEDGER_LIMIT,
  normalizeFleetCostBreakdown,
  normalizeFleetRevenueBreakdown
} from "../../data/normalizers/fleet.js";
import { makeId, toNumber } from "../../data/utils.js";

export const FLEET_TENDAY_QD = 40;
export const FLEET_REPAIR_STEP_MAX = 20;

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(toNumber(value, fallback)));
}

function signedWhole(value, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function positiveRate(value, fallback = 0) {
  return Math.max(0, toNumber(value, fallback));
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function cargoPointsAmount(cargoPoints, legacyLoad = 0) {
  if (hasValue(cargoPoints)) return whole(cargoPoints, 0);
  return Math.max(0, Math.ceil(positiveRate(legacyLoad, 0) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD - Number.EPSILON));
}

function legacyLoadFromCargoPoints(cargoPoints = 0) {
  return whole(cargoPoints, 0) / FLEET_CARGO_POINTS_PER_LEGACY_LOAD;
}

function financeTerms(vessel = {}) {
  const source = vessel?.profile?.financeTerms ?? {};
  const freightCopperPer100CargoPoints100Km = hasValue(source.freightCopperPer100CargoPoints100Km)
    ? Math.max(0.01, positiveRate(source.freightCopperPer100CargoPoints100Km, FLEET_DEFAULT_FREIGHT_COPPER_PER_100_CARGO_POINTS_100_KM))
    : Math.max(0.01, positiveRate(source.freightCopperPerLoad100Km, DEFAULT_FLEET_FINANCE_TERMS.freightCopperPerLoad100Km) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD);
  return {
    mooringCopperPerTenday: whole(source.mooringCopperPerTenday, DEFAULT_FLEET_FINANCE_TERMS.mooringCopperPerTenday),
    basicMaintenanceCopperPerTenday: whole(source.basicMaintenanceCopperPerTenday, DEFAULT_FLEET_FINANCE_TERMS.basicMaintenanceCopperPerTenday),
    suppliesCopperPerQd: whole(source.suppliesCopperPerQd, DEFAULT_FLEET_FINANCE_TERMS.suppliesCopperPerQd),
    fuelCopperPerQd: whole(source.fuelCopperPerQd, DEFAULT_FLEET_FINANCE_TERMS.fuelCopperPerQd),
    voyageMaintenanceCopperPerQd: whole(source.voyageMaintenanceCopperPerQd, DEFAULT_FLEET_FINANCE_TERMS.voyageMaintenanceCopperPerQd),
    portFeeCopper: whole(source.portFeeCopper, DEFAULT_FLEET_FINANCE_TERMS.portFeeCopper),
    replacementCopperPerQd: whole(source.replacementCopperPerQd, DEFAULT_FLEET_FINANCE_TERMS.replacementCopperPerQd),
    freightCopperPer100CargoPoints100Km,
    freightCopperPerLoad100Km: freightCopperPer100CargoPoints100Km / FLEET_CARGO_POINTS_PER_LEGACY_LOAD
  };
}

export function fleetVoyageCostQuote({
  vessel = {},
  durationQd = 1,
  portCalls = 2,
  externalCrewCopper = 0,
  residentCrewMemberIds = []
} = {}) {
  const qd = Math.max(1, whole(durationQd, 1));
  const rates = financeTerms(vessel);
  const costBreakdown = normalizeFleetCostBreakdown({
    suppliesCopper: qd * rates.suppliesCopperPerQd,
    fuelCopper: qd * rates.fuelCopperPerQd,
    portFeesCopper: whole(portCalls, 2) * rates.portFeeCopper,
    voyageMaintenanceCopper: qd * rates.voyageMaintenanceCopperPerQd,
    externalCrewCopper: whole(externalCrewCopper, 0),
    otherCopper: 0,
    residentCrewPayrollCopper: 0,
    residentCrewPayrollCoveredBySettlement: true,
    residentCrewMemberIds
  });
  return {
    durationQd: qd,
    portCalls: whole(portCalls, 2),
    rates,
    costBreakdown,
    operatingCostCopper: costBreakdown.totalCopper,
    replacementReserveCopper: qd * rates.replacementCopperPerQd
  };
}

function fleetContractTimeFactor(durationQd = FLEET_TENDAY_QD) {
  const qd = Math.max(1, whole(durationQd, 1));
  return Math.round(Math.max(0.95, Math.min(1.5, 0.95 + qd / 800)) * 1000) / 1000;
}

function finiteDemandCargoPoints(value, legacyLoad, fallback = 0) {
  if (!hasValue(value) && !hasValue(legacyLoad)) return whole(fallback, 0);
  return cargoPointsAmount(value, legacyLoad);
}

function boundedUnit(value, fallback = 1) {
  const parsed = Number(value);
  return Math.max(0, Math.min(0.999999999, Number.isFinite(parsed) ? parsed : fallback));
}

export function deterministicFleetRiskUnit(seed = "") {
  let value = 2166136261;
  for (const char of String(seed ?? "")) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  value >>>= 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 4294967295;
}

export function quoteFleetVoyageRisk({ voyage = {}, resolvedAtQd = 0, resolvedAt = "", riskUnit = deterministicFleetRiskUnit } = {}) {
  const unit = typeof riskUnit === "function" ? riskUnit : deterministicFleetRiskUnit;
  const riskPercent = Math.round(Math.max(0, Math.min(100, positiveRate(voyage?.riskPercent ?? voyage?.termsSnapshot?.riskPercent, 0))) * 100) / 100;
  const urgencyFactor = positiveRate(voyage?.termsSnapshot?.urgencyFactor, voyage?.kind === "express" ? 1.25 : 1);
  const urgent = voyage?.kind === "express" || urgencyFactor > 1;
  const incidentChance = riskPercent / 100;
  const lossShare = urgent ? 0.35 : 0.25;
  const resolutionId = String(voyage?.riskResolution?.resolutionId || `fleet-voyage:${String(voyage?.id ?? "unknown")}:risk:v1`);
  const incidentRoll = boundedUnit(unit(`${resolutionId}|incident`));
  const severityRoll = boundedUnit(unit(`${resolutionId}|severity`));
  const delayDurationRoll = boundedUnit(unit(`${resolutionId}|delay-duration`), 0);
  const incident = incidentRoll < incidentChance;
  const outcome = !incident ? "clear" : (severityRoll < lossShare ? "lost" : "delayed");
  const durationQd = Math.max(1, whole(voyage?.durationQd ?? voyage?.termsSnapshot?.durationQd, 1));
  const maximumDelayQd = Math.max(1, Math.min(80, Math.ceil(durationQd * (urgent ? 0.3 : 0.2))));
  const delayQd = outcome === "delayed" ? 1 + Math.floor(delayDurationRoll * maximumDelayQd) : 0;
  return {
    schemaVersion: 1,
    resolutionId,
    resolutionVersion: 1,
    status: "resolved",
    outcome,
    scenario: outcome === "lost" ? "loss" : (urgent ? "urgent" : "ordinary"),
    urgent,
    riskPercent,
    incidentChance,
    lossChance: incidentChance * lossShare,
    delayChance: incidentChance * (1 - lossShare),
    lossShare,
    incident,
    incidentRoll,
    severityRoll,
    delayDurationRoll,
    maximumDelayQd,
    delayQd,
    delayApplied: false,
    resolvedAtQd: whole(resolvedAtQd, 0),
    resolvedAt: String(resolvedAt ?? "")
  };
}

function legRevenueCopper({ cargoPoints = 0, distanceKm = 0, rate = 1, demandFactor = 1, urgencyFactor = 1, timeFactor = 1, riskPercent = 0 } = {}) {
  const points = whole(cargoPoints, 0);
  if (!points) return 0;
  const distanceUnits = Math.max(0.25, positiveRate(distanceKm, 0) / 100);
  const demand = Math.max(0.25, Math.min(3, positiveRate(demandFactor, 1)));
  const urgency = Math.max(0.5, Math.min(2.5, positiveRate(urgencyFactor, 1)));
  const time = Math.max(0.5, Math.min(2, positiveRate(timeFactor, 1)));
  const riskPremium = 1 + Math.max(0, Math.min(100, positiveRate(riskPercent, 0))) / 200;
  return whole(Math.round((points / 100) * Math.max(0.01, rate) * distanceUnits * demand * urgency * time * riskPremium), 0);
}

export function quoteFleetContractRevenue({
  cargoPoints = undefined,
  returnCargoPoints = undefined,
  outboundDemandCargoPoints = undefined,
  returnDemandCargoPoints = undefined,
  cargoLoad = 0,
  returnCargoLoad = 0,
  outboundDemandLoad = undefined,
  returnDemandLoad = undefined,
  outboundDistanceKm = 0,
  returnDistanceKm = 0,
  durationQd = FLEET_TENDAY_QD,
  demandFactor = 1,
  returnDemandFactor = demandFactor,
  urgencyFactor = 1,
  riskPercent = 0,
  freightCopperPer100CargoPoints100Km = undefined,
  freightCopperPerLoad100Km = 1,
  bonusCopper = 0
} = {}) {
  const offeredOutboundCargoPoints = cargoPointsAmount(cargoPoints, cargoLoad);
  const offeredReturnCargoPoints = cargoPointsAmount(returnCargoPoints, returnCargoLoad);
  const finiteOutboundDemandCargoPoints = finiteDemandCargoPoints(outboundDemandCargoPoints, outboundDemandLoad, offeredOutboundCargoPoints);
  const finiteReturnDemandCargoPoints = finiteDemandCargoPoints(returnDemandCargoPoints, returnDemandLoad, offeredReturnCargoPoints);
  const billableOutboundCargoPoints = Math.min(offeredOutboundCargoPoints, finiteOutboundDemandCargoPoints);
  const billableReturnCargoPoints = Math.min(offeredReturnCargoPoints, finiteReturnDemandCargoPoints);
  const offeredOutboundLoad = legacyLoadFromCargoPoints(offeredOutboundCargoPoints);
  const offeredReturnLoad = legacyLoadFromCargoPoints(offeredReturnCargoPoints);
  const finiteOutboundDemandLoad = legacyLoadFromCargoPoints(finiteOutboundDemandCargoPoints);
  const finiteReturnDemandLoad = legacyLoadFromCargoPoints(finiteReturnDemandCargoPoints);
  const billableOutboundLoad = legacyLoadFromCargoPoints(billableOutboundCargoPoints);
  const billableReturnLoad = legacyLoadFromCargoPoints(billableReturnCargoPoints);
  const timeCommitmentFactor = fleetContractTimeFactor(durationQd);
  const canonicalFreightRate = hasValue(freightCopperPer100CargoPoints100Km)
    ? Math.max(0.01, positiveRate(freightCopperPer100CargoPoints100Km, 1))
    : Math.max(0.01, positiveRate(freightCopperPerLoad100Km, 1) * FLEET_CARGO_POINTS_PER_LEGACY_LOAD);
  const outboundCargoCopper = legRevenueCopper({
    cargoPoints: billableOutboundCargoPoints,
    distanceKm: outboundDistanceKm,
    rate: canonicalFreightRate,
    demandFactor,
    urgencyFactor,
    timeFactor: timeCommitmentFactor,
    riskPercent
  });
  const returnCargoCopper = legRevenueCopper({
    cargoPoints: billableReturnCargoPoints,
    distanceKm: returnDistanceKm,
    rate: canonicalFreightRate,
    demandFactor: returnDemandFactor,
    urgencyFactor: Math.max(0.75, urgencyFactor * 0.9),
    timeFactor: timeCommitmentFactor,
    riskPercent
  });
  const revenueBreakdown = normalizeFleetRevenueBreakdown({
    outboundCargoCopper,
    returnCargoCopper,
    bonusCopper: whole(bonusCopper, 0),
    internalTransferCopper: 0,
    internalTransferIsRevenue: false,
    offeredOutboundCargoPoints,
    offeredReturnCargoPoints,
    outboundDemandCargoPoints: finiteOutboundDemandCargoPoints,
    returnDemandCargoPoints: finiteReturnDemandCargoPoints,
    billableOutboundCargoPoints,
    billableReturnCargoPoints,
    offeredOutboundLoad,
    offeredReturnLoad,
    outboundDemandLoad: finiteOutboundDemandLoad,
    returnDemandLoad: finiteReturnDemandLoad,
    billableOutboundLoad,
    billableReturnLoad,
    timeCommitmentFactor
  });
  return {
    calculationModel: "finite-demand-cargo-points-v2",
    offeredOutboundCargoPoints,
    offeredReturnCargoPoints,
    outboundDemandCargoPoints: finiteOutboundDemandCargoPoints,
    returnDemandCargoPoints: finiteReturnDemandCargoPoints,
    billableOutboundCargoPoints,
    billableReturnCargoPoints,
    offeredOutboundLoad,
    offeredReturnLoad,
    outboundDemandLoad: finiteOutboundDemandLoad,
    returnDemandLoad: finiteReturnDemandLoad,
    billableOutboundLoad,
    billableReturnLoad,
    timeCommitmentFactor,
    outboundRevenueCopper: outboundCargoCopper,
    returnRevenueCopper: returnCargoCopper,
    grossRevenueCopper: revenueBreakdown.totalCopper,
    revenueBreakdown
  };
}

export function quoteFleetContractEconomy({
  vessel = {},
  cargoPoints = undefined,
  returnCargoPoints = undefined,
  outboundDemandCargoPoints = undefined,
  returnDemandCargoPoints = undefined,
  cargoLoad = 0,
  returnCargoLoad = 0,
  outboundDemandLoad = undefined,
  returnDemandLoad = undefined,
  outboundDistanceKm = 0,
  returnDistanceKm = 0,
  durationQd = 1,
  demandFactor = 1,
  returnDemandFactor = demandFactor,
  urgencyFactor = 1,
  riskPercent = 0,
  portCalls = 2,
  externalCrewCopper = 0,
  residentCrewMemberIds = [],
  bonusCopper = 0
} = {}) {
  const cost = fleetVoyageCostQuote({ vessel, durationQd, portCalls, externalCrewCopper, residentCrewMemberIds });
  const rate = cost.rates.freightCopperPer100CargoPoints100Km;
  const revenue = quoteFleetContractRevenue({
    cargoPoints,
    returnCargoPoints,
    outboundDemandCargoPoints,
    returnDemandCargoPoints,
    cargoLoad,
    returnCargoLoad,
    outboundDemandLoad,
    returnDemandLoad,
    outboundDistanceKm,
    returnDistanceKm,
    durationQd: cost.durationQd,
    freightCopperPer100CargoPoints100Km: rate,
    demandFactor,
    returnDemandFactor,
    urgencyFactor,
    riskPercent,
    bonusCopper
  });
  const totalDistanceKm = positiveRate(outboundDistanceKm, 0) + positiveRate(returnDistanceKm, 0);
  const timeWear = Math.ceil(cost.durationQd / FLEET_TENDAY_QD);
  const distanceWear = Math.ceil(totalDistanceKm / 800);
  const riskWear = Math.ceil(Math.max(0, Math.min(100, positiveRate(riskPercent, 0))) / 20);
  const wearSteps = Math.max(1, Math.min(FLEET_REPAIR_STEP_MAX, timeWear + distanceWear + riskWear));
  const grossRevenueCopper = revenue.grossRevenueCopper;
  return {
    economyVersion: 2,
    calculationModel: revenue.calculationModel,
    termsSnapshot: {
      cargoPoints: revenue.offeredOutboundCargoPoints,
      returnCargoPoints: revenue.offeredReturnCargoPoints,
      outboundDemandCargoPoints: revenue.outboundDemandCargoPoints,
      returnDemandCargoPoints: revenue.returnDemandCargoPoints,
      billableOutboundCargoPoints: revenue.billableOutboundCargoPoints,
      billableReturnCargoPoints: revenue.billableReturnCargoPoints,
      reservedCapacityCargoPoints: Math.max(revenue.offeredOutboundCargoPoints, revenue.offeredReturnCargoPoints),
      cargoLoad: revenue.offeredOutboundLoad,
      returnCargoLoad: revenue.offeredReturnLoad,
      outboundDemandLoad: revenue.outboundDemandLoad,
      returnDemandLoad: revenue.returnDemandLoad,
      billableOutboundLoad: revenue.billableOutboundLoad,
      billableReturnLoad: revenue.billableReturnLoad,
      outboundDistanceKm: Math.round(positiveRate(outboundDistanceKm, 0) * 100) / 100,
      returnDistanceKm: Math.round(positiveRate(returnDistanceKm, 0) * 100) / 100,
      durationQd: cost.durationQd,
      demandFactor: Math.round(Math.max(0.25, Math.min(3, positiveRate(demandFactor, 1))) * 1000) / 1000,
      returnDemandFactor: Math.round(Math.max(0.25, Math.min(3, positiveRate(returnDemandFactor, demandFactor))) * 1000) / 1000,
      urgencyFactor: Math.round(Math.max(0.5, Math.min(2.5, positiveRate(urgencyFactor, 1))) * 1000) / 1000,
      riskPercent: Math.round(Math.max(0, Math.min(100, positiveRate(riskPercent, 0))) * 100) / 100,
      portCalls: cost.portCalls,
      externalCrewCopper: whole(externalCrewCopper, 0),
      bonusCopper: whole(bonusCopper, 0),
      freightCopperPer100CargoPoints100Km: rate,
      freightCopperPerLoad100Km: rate / FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
      timeCommitmentFactor: revenue.timeCommitmentFactor,
      residentCrewPayrollCoveredBySettlement: true,
      residentCrewMemberIds: [...new Set((residentCrewMemberIds ?? []).map((id) => String(id ?? "")).filter(Boolean))]
    },
    costBreakdown: cost.costBreakdown,
    revenueBreakdown: revenue.revenueBreakdown,
    operatingCostCopper: cost.operatingCostCopper,
    replacementReserveCopper: cost.replacementReserveCopper,
    outboundRevenueCopper: revenue.outboundRevenueCopper,
    returnRevenueCopper: revenue.returnRevenueCopper,
    grossRevenueCopper,
    distributableResultCopper: grossRevenueCopper - cost.operatingCostCopper - cost.replacementReserveCopper,
    wearSteps
  };
}

export function appendFleetLedger(vessel = {}, entry = {}) {
  if (!vessel.finances || typeof vessel.finances !== "object") vessel.finances = {};
  if (!Array.isArray(vessel.finances.ledger)) vessel.finances.ledger = [];
  const operationId = String(entry.operationId ?? entry.id ?? makeId("fleet-ledger", 20));
  const existing = vessel.finances.ledger.find((row) => String(row?.operationId ?? row?.id ?? "") === operationId);
  if (existing) return existing;
  const normalized = {
    ...entry,
    id: operationId,
    operationId,
    type: String(entry.type ?? "note"),
    at: String(entry.at ?? ""),
    qd: whole(entry.qd, 0),
    cashDeltaCopper: signedWhole(entry.cashDeltaCopper, 0),
    reserveDeltaCopper: signedWhole(entry.reserveDeltaCopper, 0),
    internalTransferCopper: signedWhole(entry.internalTransferCopper, 0),
    cashBalanceCopper: whole(vessel.finances.cashCopper, 0),
    reserveBalanceCopper: whole(vessel.finances.replacementReserveCopper, 0),
    title: String(entry.title ?? "Запись кассы"),
    summary: String(entry.summary ?? "")
  };
  vessel.finances.ledger.push(normalized);
  vessel.finances.ledger = vessel.finances.ledger.slice(-FLEET_LEDGER_LIMIT);
  return normalized;
}

export function quoteFleetIdleCosts(vessel = {}, periods = 1) {
  const count = whole(periods, 0);
  const rates = financeTerms(vessel);
  const mooringCopper = count * rates.mooringCopperPerTenday;
  const basicMaintenanceCopper = count * rates.basicMaintenanceCopperPerTenday;
  return {
    periods: count,
    mooringCopper,
    basicMaintenanceCopper,
    currentDueCopper: mooringCopper + basicMaintenanceCopper,
    arrearsBeforeCopper: whole(vessel?.finances?.idleCostArrearsCopper, 0),
    totalDueCopper: mooringCopper + basicMaintenanceCopper + whole(vessel?.finances?.idleCostArrearsCopper, 0)
  };
}

export function chargeFleetIdleCosts(vessel = {}, {
  periods = 0,
  throughQd = 0,
  operationId = "",
  chargedAt = ""
} = {}) {
  const quote = quoteFleetIdleCosts(vessel, periods);
  if (!quote.periods && !quote.arrearsBeforeCopper) return { ok: true, charged: false, ...quote, paidCopper: 0, arrearsAfterCopper: quote.arrearsBeforeCopper };
  const finances = vessel.finances ?? (vessel.finances = {});
  const cashBefore = whole(finances.cashCopper, 0);
  const protectedCopper = whole(finances.operatingReserveCopper, 0)
    + whole(finances.emergencyReserveCopper, 0)
    + whole(finances.replacementReserveCopper, 0)
    + whole(vessel?.activeVoyage?.operatingCostCopper, 0);
  const spendableCopper = Math.max(0, cashBefore - protectedCopper);
  const paidCopper = Math.min(spendableCopper, quote.totalDueCopper);
  const arrearsAfterCopper = quote.totalDueCopper - paidCopper;
  finances.cashCopper = cashBefore - paidCopper;
  finances.idleCostArrearsCopper = arrearsAfterCopper;
  appendFleetLedger(vessel, {
    operationId,
    type: "idle-cost",
    at: chargedAt,
    qd: throughQd,
    cashDeltaCopper: -paidCopper,
    title: "Стоянка и базовое содержание",
    summary: `Периодов: ${quote.periods}; причал ${quote.mooringCopper}; обслуживание ${quote.basicMaintenanceCopper}; уплачено ${paidCopper}; долг ${arrearsAfterCopper}.`
  });
  return { ok: true, charged: true, ...quote, cashBefore, paidCopper, arrearsAfterCopper, cashAfter: finances.cashCopper };
}

function normalizedRepairMaterials(wearSteps = 1) {
  const steps = Math.max(1, Math.min(FLEET_REPAIR_STEP_MAX, whole(wearSteps, 1)));
  return [
    { resourceId: "wood", name: "Древесина", qty: Math.max(1, Math.ceil(steps / 2)) },
    { resourceId: "iron", name: "Железо", qty: Math.max(1, Math.ceil(steps / 5)) }
  ];
}

function materialAvailability(holding = {}, resourceId = "") {
  return (holding?.storage?.resources ?? []).reduce((sum, row) => (
    String(row?.resourceId ?? row?.id ?? "") === resourceId ? sum + storageAvailableQuantity(holding, row) : sum
  ), 0);
}

export function quoteFleetRepair(holding = {}, vessel = {}, { wearSteps = 5 } = {}) {
  const currentWear = Math.max(0, Math.min(100, whole(vessel?.condition?.wear, 0)));
  const steps = Math.min(currentWear, Math.max(1, Math.min(FLEET_REPAIR_STEP_MAX, whole(wearSteps, 5))));
  const materials = steps > 0 ? normalizedRepairMaterials(steps) : [];
  const moneyCopper = steps * 250;
  const durationQd = Math.max(4, steps * 4);
  const availableRepairCash = Math.max(0,
    whole(vessel?.finances?.cashCopper, 0)
      - whole(vessel?.finances?.operatingReserveCopper, 0)
      - whole(vessel?.finances?.emergencyReserveCopper, 0)
  );
  const missingMaterials = materials.map((material) => ({
    ...material,
    have: materialAvailability(holding, material.resourceId)
  })).filter((material) => material.have < material.qty);
  const dockedHere = String(vessel?.position?.dockedAtHoldingId ?? "") === String(holding?.id ?? "") && Boolean(String(holding?.id ?? ""));
  const reasons = [];
  if (!steps) reasons.push("Износ уже равен нулю.");
  if (!dockedHere) reasons.push("Ремонт возможен только у причала этого поселения.");
  if (vessel?.activeVoyage) reasons.push("Сначала нужно завершить рейс.");
  if (vessel?.activeRepair) reasons.push("На корабле уже идёт ремонт.");
  if (availableRepairCash < moneyCopper) reasons.push(`На ремонт доступно ${availableRepairCash} медных при необходимости ${moneyCopper}.`);
  if (missingMaterials.length) reasons.push(`Не хватает материалов: ${missingMaterials.map((row) => `${row.name} ${row.have}/${row.qty}`).join(", ")}.`);
  return {
    ok: reasons.length === 0,
    reasons,
    wearBefore: currentWear,
    wearSteps: steps,
    wearAfter: Math.max(0, currentWear - steps),
    moneyCopper,
    durationQd,
    materials,
    missingMaterials,
    availableRepairCash,
    dockedHere
  };
}

function consumeRepairMaterials(holding = {}, materials = [], currentQd = 0) {
  const consumed = [];
  for (const material of materials) {
    let remaining = whole(material.qty, 0);
    for (const [storageRowIndex, row] of (holding?.storage?.resources ?? []).entries()) {
      if (!remaining || String(row?.resourceId ?? row?.id ?? "") !== material.resourceId) continue;
      const amount = Math.min(remaining, storageAvailableQuantity(holding, row));
      if (!(amount > 0)) continue;
      const lots = consumeAvailableStorageLots(holding, row, amount, { currentQd });
      consumed.push({
        resourceId: material.resourceId,
        name: material.name,
        qty: amount,
        roomId: String(row?.roomId ?? row?.storageRoomId ?? "outdoors"),
        storageRowId: String(row?.id ?? ""),
        storageRowIndex,
        lots
      });
      remaining -= amount;
    }
  }
  return consumed;
}

export function startFleetRepair(holding = {}, vessel = {}, {
  wearSteps = 5,
  operationId = "",
  startedQd = 0,
  startedAt = ""
} = {}) {
  const opId = String(operationId ?? "").trim();
  if (!opId) return { ok: false, message: "Для ремонта требуется operationId." };
  const ledgerReplay = (vessel?.finances?.ledger ?? []).find((row) => String(row?.operationId ?? row?.id ?? "") === opId);
  if (ledgerReplay) return { ok: true, duplicate: true, operationId: opId, repair: vessel.activeRepair ?? null };
  const quote = quoteFleetRepair(holding, vessel, { wearSteps });
  if (!quote.ok) return { ok: false, message: quote.reasons.join(" "), quote };
  const finances = vessel.finances ?? (vessel.finances = {});
  const cashBefore = whole(finances.cashCopper, 0);
  const reserveBefore = whole(finances.replacementReserveCopper, 0);
  const reserveSpentCopper = Math.min(reserveBefore, quote.moneyCopper);
  finances.cashCopper = cashBefore - quote.moneyCopper;
  finances.replacementReserveCopper = reserveBefore - reserveSpentCopper;
  const qd = whole(startedQd, 0);
  const consumed = consumeRepairMaterials(holding, quote.materials, qd);
  const repair = {
    schemaVersion: 1,
    id: opId,
    operationId: opId,
    status: "active",
    startedQd: qd,
    durationQd: quote.durationQd,
    completesQd: qd + quote.durationQd,
    wearSteps: quote.wearSteps,
    moneyCopper: quote.moneyCopper,
    reserveSpentCopper,
    materials: quote.materials.map((row) => ({ ...row })),
    consumedSources: consumed,
    startedAt: String(startedAt ?? "")
  };
  vessel.activeRepair = repair;
  appendFleetLedger(vessel, {
    operationId: opId,
    type: "repair-started",
    at: startedAt,
    qd,
    cashDeltaCopper: -quote.moneyCopper,
    reserveDeltaCopper: -reserveSpentCopper,
    title: "Начат доковый ремонт",
    summary: `Износ −${quote.wearSteps}; срок ${quote.durationQd} QD; деньги ${quote.moneyCopper}; материалы ${quote.materials.map((row) => `${row.qty} ${row.name}`).join(", ")}.`
  });
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = {};
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  holding.storage.log.push(...consumed.map((row, index) => ({
    id: `${opId}:material:${index + 1}`,
    operationId: opId,
    ts: String(startedAt ?? ""),
    createdAt: String(startedAt ?? ""),
    domain: "fleet",
    kind: "fleet-repair",
    resourceId: row.resourceId,
    name: row.name,
    qty: -row.qty,
    roomId: row.roomId,
    source: String(vessel?.name ?? "Корабль"),
    note: "Материалы докового ремонта"
  })));
  holding.storage.log = holding.storage.log.slice(-250);
  return { ok: true, duplicate: false, operationId: opId, quote, repair };
}

export function advanceFleetRepair(holding = {}, vessel = {}, targetQd = 0, { completedAt = "" } = {}) {
  const repair = vessel?.activeRepair;
  if (!repair) return { ok: true, completed: false, ignored: true };
  const target = whole(targetQd, 0);
  if (target < whole(repair.completesQd, 0)) return { ok: true, completed: false, remainingQd: whole(repair.completesQd, 0) - target };
  const dockedHere = String(vessel?.position?.dockedAtHoldingId ?? "") === String(holding?.id ?? "") && Boolean(String(holding?.id ?? ""));
  if (!dockedHere) {
    repair.status = "paused";
    return { ok: false, completed: false, paused: true, message: "Ремонт остановлен: корабль покинул причал." };
  }
  const wearBefore = Math.max(0, Math.min(100, whole(vessel?.condition?.wear, 0)));
  const wearAfter = Math.max(0, wearBefore - Math.max(1, whole(repair.wearSteps, 1)));
  vessel.condition.wear = wearAfter;
  vessel.activeRepair = null;
  appendFleetLedger(vessel, {
    operationId: `${repair.operationId}:complete`,
    type: "repair-completed",
    at: completedAt,
    qd: target,
    title: "Доковый ремонт завершён",
    summary: `Износ ${wearBefore} → ${wearAfter}; деньги и материалы были списаны при постановке в док.`
  });
  return { ok: true, completed: true, repair: { ...repair, status: "completed", completedAt: String(completedAt ?? ""), completedQd: target }, wearBefore, wearAfter };
}

export function applyFleetWear(vessel = {}, wearSteps = 0) {
  const before = Math.max(0, Math.min(100, whole(vessel?.condition?.wear, 0)));
  const applied = Math.max(0, Math.min(FLEET_REPAIR_STEP_MAX, whole(wearSteps, 0)));
  const after = Math.min(100, before + applied);
  if (!vessel.condition || typeof vessel.condition !== "object") vessel.condition = {};
  vessel.condition.wear = after;
  return { before, requested: applied, applied: after - before, after };
}
