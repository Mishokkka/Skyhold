import { marketRandomUnit } from "../market/pricing.js";
import { holdingMarketAccessLevel, MARKET_TRANSPORT_TARIFFS, shortestMarketRoute } from "../market/logistics.js";
import {
  FLEET_CARGO_POINTS_PER_LEGACY_LOAD,
  FLEET_LEGACY_LOAD_PER_CUBIC_METRE,
  FLEET_LEGACY_LOAD_PER_TONNE,
  fleetVesselAvailableCopper
} from "../../data/normalizers/fleet.js";
import { fleetVoyageCostQuote, quoteFleetContractEconomy } from "./finance.js";

export const FLEET_OWNED_DELIVERY_SERVICE = "owned";
export const FLEET_MARKET_LOAD_PER_TONNE = FLEET_LEGACY_LOAD_PER_TONNE;
export const FLEET_MARKET_LOAD_PER_CUBIC_METRE = FLEET_LEGACY_LOAD_PER_CUBIC_METRE;
export const FLEET_MARKET_CARGO_POINTS_PER_LOAD = FLEET_CARGO_POINTS_PER_LEGACY_LOAD;
export const FLEET_MARKET_OPERATING_COPPER_PER_QD = 355;
export const FLEET_MARKET_REPLACEMENT_COPPER_PER_QD = 67;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function viewerIsGm(value) {
  if (typeof value === "boolean") return value;
  return globalThis.game?.user?.isGM === true;
}

function regionByValue(value = "", regions = []) {
  const source = String(value ?? "").trim().toLocaleLowerCase("ru");
  if (!source) return null;
  return (regions ?? []).find((row) => [row?.value, row?.label, ...(row?.aliases ?? [])]
    .some((candidate) => String(candidate ?? "").trim().toLocaleLowerCase("ru") === source)) ?? null;
}

function vesselSpeedFactor(vessel = {}) {
  const speedClass = String(vessel?.profile?.speedClass ?? "").trim().toLocaleLowerCase("ru");
  if (["fast", "fast-clipper", "быстрый", "клипер"].some((token) => speedClass.includes(token))) return 0.85;
  if (["slow", "heavy", "медленный", "тяжёлый"].some((token) => speedClass.includes(token))) return 1.2;
  return 1;
}

function airshipRoute(fromId = "", toId = "", regions = []) {
  return shortestMarketRoute(fromId, toId, regions, { mode: "airship", metric: "distance" });
}

function routeQd(route = null, vessel = {}) {
  if (!route) return 0;
  const qdPerDistance = Math.max(0.1, finite(MARKET_TRANSPORT_TARIFFS.airship?.qdPerDistance, 1.5));
  return Math.max(1, Math.ceil(Math.max(0.5, finite(route.distance, 0.5)) * qdPerDistance * vesselSpeedFactor(vessel)));
}

function routePathJoin(first = [], second = []) {
  const left = Array.isArray(first) ? first : [];
  const right = Array.isArray(second) ? second : [];
  return [...left, ...right.slice(left.at(-1) === right[0] ? 1 : 0)];
}

function vesselRates(vessel = {}) {
  const cost = fleetVoyageCostQuote({ vessel, durationQd: 1, portCalls: 0 });
  return {
    operatingCopperPerQd: Math.max(1, whole(cost.operatingCostCopper, FLEET_MARKET_OPERATING_COPPER_PER_QD)),
    replacementCopperPerQd: Math.max(0, whole(cost.replacementReserveCopper, FLEET_MARKET_REPLACEMENT_COPPER_PER_QD))
  };
}

export function fleetVesselMarketCapacity(vessel = {}) {
  const capacityTonnes = whole(vessel?.profile?.legalCapacityTonnes ?? vessel?.profile?.legalCapacityLoad, 0);
  const capacityVolumeM3 = whole(vessel?.profile?.legalCapacityVolumeM3, capacityTonnes * 2);
  const capacityMassKg = capacityTonnes * 1000;
  const capacityVolumeL = capacityVolumeM3 * 1000;
  const legacyCapacityLoad = Math.min(
    capacityTonnes * FLEET_MARKET_LOAD_PER_TONNE,
    capacityVolumeM3 * FLEET_MARKET_LOAD_PER_CUBIC_METRE
  );
  const explicitCargoPoints = vessel?.profile?.legalCapacityCargoPoints;
  const hasExplicitCargoPoints = explicitCargoPoints !== undefined && explicitCargoPoints !== null && explicitCargoPoints !== "";
  const capacityCargoPoints = hasExplicitCargoPoints
    ? whole(explicitCargoPoints, 0)
    : legacyCapacityLoad * FLEET_MARKET_CARGO_POINTS_PER_LOAD;
  const capacityLoad = capacityCargoPoints / FLEET_MARKET_CARGO_POINTS_PER_LOAD;
  return {
    capacityTonnes,
    capacityVolumeM3,
    capacityMassKg,
    capacityVolumeL,
    capacityCargoPoints,
    capacityLoad,
    legacyCapacityLoad
  };
}

export function fleetVesselMarketCapacityLoad(vessel = {}) {
  return fleetVesselMarketCapacity(vessel).capacityLoad;
}

export function matchedExternalCharterLogistics(referenceLogistics = {}, ownedLogistics = {}) {
  const capacityCargoPoints = whole(
    ownedLogistics?.capacityCargoPoints,
    whole(ownedLogistics?.capacityLoad, 0) * FLEET_MARKET_CARGO_POINTS_PER_LOAD
  );
  if (!capacityCargoPoints) return { ...referenceLogistics };
  const capacityLoad = capacityCargoPoints / FLEET_MARKET_CARGO_POINTS_PER_LOAD;
  return {
    ...referenceLogistics,
    baseCapacityLoad: capacityLoad,
    capacityLoad,
    baseCapacityCargoPoints: capacityCargoPoints,
    capacityCargoPoints,
    baseCapacityMassKg: finite(ownedLogistics?.capacityMassKg, capacityLoad * 10),
    capacityMassKg: finite(ownedLogistics?.capacityMassKg, capacityLoad * 10),
    baseCapacityVolumeL: finite(ownedLogistics?.capacityVolumeL, capacityLoad * 20),
    capacityVolumeL: finite(ownedLogistics?.capacityVolumeL, capacityLoad * 20),
    comparisonCapacityLoad: capacityLoad,
    comparisonCapacityTonnes: finite(ownedLogistics?.ownedCapacityTonnes, capacityLoad / FLEET_MARKET_LOAD_PER_TONNE),
    comparisonCapacityVolumeM3: finite(ownedLogistics?.ownedCapacityVolumeM3, capacityLoad / FLEET_MARKET_LOAD_PER_CUBIC_METRE)
  };
}

export function fleetOwnedCarrierId(vesselId = "") {
  return `fleet:${String(vesselId ?? "").trim()}`;
}

export function fleetVesselIdFromCarrier(carrierId = "") {
  const source = String(carrierId ?? "");
  return source.startsWith("fleet:") ? source.slice(6) : "";
}

export function quoteOwnedFleetDelivery({ holding = {}, vessel = {}, market = {}, regions = [], baseLogistics = {}, isGM = undefined } = {}) {
  const reasons = [];
  const canSeeGmContent = viewerIsGm(isGM);
  const shipRegion = regionByValue(vessel?.position?.regionId, regions);
  const pickupRegion = regionByValue(market?.regionId ?? baseLogistics?.originRegionId, regions);
  const destinationRegion = regionByValue(baseLogistics?.destinationRegionId ?? holding?.overview?.region, regions);
  const marketActive = market?.active !== false && market?.marketEnabled !== false && baseLogistics?.marketActive !== false;
  const marketAvailable = market?.available !== false && baseLogistics?.marketAvailable !== false;
  const marketVisibility = market?.visibility === "gm" || baseLogistics?.marketVisibility === "gm" ? "gm" : "known";
  const marketVisible = baseLogistics?.marketVisible !== false && (marketVisibility !== "gm" || canSeeGmContent);
  if (!marketActive) reasons.push("Рынок сейчас не активен.");
  if (!marketAvailable) reasons.push("Рынок сейчас недоступен для новых доставок.");
  if (!marketVisible) reasons.push("Рынок скрыт от пользователя.");
  if (vessel?.visibility === "gm" && !canSeeGmContent) reasons.push("Корабль скрыт от пользователя.");
  if (vessel?.available === false) reasons.push("Корабль сейчас недоступен для новых рейсов.");
  if (vessel?.activeVoyage) reasons.push("Корабль уже занят другим рейсом.");
  if (["crisis", "archived"].includes(String(vessel?.status ?? ""))) reasons.push("Корабль сейчас недоступен для доставки.");
  if (!shipRegion) reasons.push("Для корабля не выбрана точка на карте рынка.");
  if (!pickupRegion) reasons.push("Точка забора груза отсутствует в графе рынка.");
  if (!destinationRegion) reasons.push("Точка доставки поселения отсутствует в графе рынка.");
  const accessLevel = holdingMarketAccessLevel(holding).level;
  const requiredAccessLevel = Math.max(
    whole(baseLogistics?.requiredAccessLevel, 0),
    whole(baseLogistics?.routeAccessLevel, 0),
    whole(baseLogistics?.routeAccessCost, 0),
    whole(market?.accessLevelOverride, 0)
  );
  if (accessLevel < requiredAccessLevel) {
    reasons.push(`Для рынка нужен УРС ${requiredAccessLevel}, у поселения УРС ${accessLevel}.`);
  }

  const pickupRoute = shipRegion && pickupRegion ? airshipRoute(shipRegion.value, pickupRegion.value, regions) : null;
  const deliveryRoute = pickupRegion && destinationRegion ? airshipRoute(pickupRegion.value, destinationRegion.value, regions) : null;
  if (shipRegion && pickupRegion && !pickupRoute) reasons.push("Нет воздушного маршрута от корабля до точки забора груза.");
  if (pickupRegion && destinationRegion && !deliveryRoute) reasons.push("Нет воздушного маршрута от точки забора до поселения.");

  const pickupQd = routeQd(pickupRoute, vessel);
  const cargoQd = routeQd(deliveryRoute, vessel);
  const handlingQd = Math.max(1, whole(market?.baseDeliveryQd, 2));
  const totalQd = pickupQd + cargoQd + handlingQd;
  const rates = vesselRates(vessel);
  const costQuote = fleetVoyageCostQuote({
    vessel,
    durationQd: totalQd,
    portCalls: 2,
    residentCrewMemberIds: vessel?.crew?.memberIds ?? []
  });
  const operatingCostCopper = costQuote.operatingCostCopper;
  const replacementReserveCopper = costQuote.replacementReserveCopper;
  const requiredCashCopper = operatingCostCopper;
  const availableCopper = fleetVesselAvailableCopper(vessel);
  if (vessel && availableCopper < requiredCashCopper) reasons.push(`Доступная касса корабля не покрывает эксплуатацию: нужно ${requiredCashCopper}, доступно после резервов ${availableCopper} медных.`);

  const totalDistanceKm = finite(pickupRoute?.distanceKm, 0) + finite(deliveryRoute?.distanceKm, 0);
  const totalDistance = totalDistanceKm / 40;
  const routePath = routePathJoin(pickupRoute?.path, deliveryRoute?.path);
  const carrierId = fleetOwnedCarrierId(vessel?.id);
  const capacity = fleetVesselMarketCapacity(vessel);
  const capacityTonnes = capacity.capacityTonnes;
  const capacityVolumeM3 = capacity.capacityVolumeM3;
  const capacityLoad = capacity.capacityLoad;
  const capacityCargoPoints = capacity.capacityCargoPoints;
  if (!(capacityCargoPoints > 0)) reasons.push("У корабля не задана положительная вместимость трюма в грузовых очках.");
  return {
    ...baseLogistics,
    ok: reasons.length === 0,
    reasons,
    marketActive,
    marketAvailable,
    marketVisibility,
    marketVisible,
    accessLevel,
    requiredAccessLevel,
    carrierId,
    carrierLabel: `Свой корабль «${String(vessel?.name ?? "Корабль") }»`,
    carrierPriceFactor: 1,
    carrierTimeFactor: 1,
    carrierRiskFactor: 1,
    carrierCapacityFactor: 1,
    transportMode: "airship",
    transportLabel: `Свой воздушный корабль «${String(vessel?.name ?? "Корабль") }»`,
    capacityModes: ["airship"],
    capacityLoad,
    baseCapacityLoad: capacityLoad,
    capacityCargoPoints,
    baseCapacityCargoPoints: capacityCargoPoints,
    capacityMassKg: capacity.capacityMassKg,
    baseCapacityMassKg: capacity.capacityMassKg,
    capacityVolumeL: capacity.capacityVolumeL,
    baseCapacityVolumeL: capacity.capacityVolumeL,
    distance: totalDistance,
    distanceKm: totalDistanceKm,
    distanceText: `${Number.isInteger(totalDistanceKm) ? totalDistanceKm : Number(totalDistanceKm.toFixed(1))} км`,
    hops: whole(pickupRoute?.hops, 0) + whole(deliveryRoute?.hops, 0),
    routePath,
    routeModes: routePath.length > 1 ? Array(Math.max(0, routePath.length - 1)).fill("airship") : [],
    travelQd: pickupQd + cargoQd,
    distanceFlatCopper: operatingCostCopper + replacementReserveCopper,
    distanceLoadCopper: 0,
    routeFlatBeforeFactorCopper: operatingCostCopper + replacementReserveCopper,
    routeLoadBeforeFactorCopper: 0,
    routeDistanceCopper: 0,
    configuredDistanceFlatCopper: 0,
    configuredDistanceLoadCopper: 0,
    dispatchCopper: 0,
    airshipHireCopper: 0,
    operatingTimeCopper: operatingCostCopper,
    routeOperatingTimeCopper: operatingCostCopper,
    ownedVesselId: String(vessel?.id ?? ""),
    ownedVesselName: String(vessel?.name ?? "Корабль"),
    ownedCapacityTonnes: capacityTonnes,
    ownedCapacityVolumeM3: capacityVolumeM3,
    ownedCapacityLoad: capacityLoad,
    ownedCapacityCargoPoints: capacityCargoPoints,
    ownedPickupRegionId: String(pickupRegion?.value ?? ""),
    ownedPickupLabel: String(pickupRegion?.label ?? market?.label ?? "Точка забора"),
    ownedDestinationRegionId: String(destinationRegion?.value ?? ""),
    ownedDestinationLabel: String(destinationRegion?.label ?? holding?.name ?? "Поселение"),
    ownedPickupDistanceKm: finite(pickupRoute?.distanceKm, 0),
    ownedDeliveryDistanceKm: finite(deliveryRoute?.distanceKm, 0),
    ownedPickupQd: pickupQd,
    ownedCargoQd: cargoQd,
    ownedHandlingQd: handlingQd,
    ownedTotalQd: totalQd,
    ownedOperatingCopperPerQd: rates.operatingCopperPerQd,
    ownedReplacementCopperPerQd: rates.replacementCopperPerQd,
    ownedOperatingCostCopper: operatingCostCopper,
    ownedCostBreakdown: costQuote.costBreakdown,
    ownedReplacementReserveCopper: replacementReserveCopper,
    ownedRequiredCashCopper: requiredCashCopper
  };
}

export function ownedFleetCarriersForMarket({ holding = {}, market = {}, regions = [], baseLogistics = {}, isGM = undefined } = {}) {
  const canSeeGmContent = viewerIsGm(isGM);
  return (holding?.special?.fleet?.vessels ?? [])
    .filter((vessel) => vessel?.status !== "archived" && (canSeeGmContent || vessel?.visibility !== "gm"))
    .map((vessel) => {
      const logistics = quoteOwnedFleetDelivery({ holding, vessel, market, regions, baseLogistics, isGM: canSeeGmContent });
      return {
        id: fleetOwnedCarrierId(vessel.id),
        label: `Свой корабль «${vessel.name}»`,
        vesselId: vessel.id,
        vesselName: vessel.name,
        ownFleet: true,
        available: logistics.ok,
        reason: (logistics.reasons ?? []).join(" "),
        capacityLoad: logistics.capacityLoad,
        capacityCargoPoints: logistics.capacityCargoPoints,
        capacityTonnes: logistics.ownedCapacityTonnes,
        capacityVolumeM3: logistics.ownedCapacityVolumeM3,
        pickupQd: logistics.ownedPickupQd,
        cargoQd: logistics.ownedCargoQd,
        totalQd: logistics.ownedTotalQd,
        operatingCostCopper: logistics.ownedOperatingCostCopper,
        replacementReserveCopper: logistics.ownedReplacementReserveCopper,
        logistics
      };
    });
}

export function generateFleetMarketOffers({ vessel = {}, markets = [], regions = [], quoteKey = "", createdAt = "", limit = 5, isGM = undefined } = {}) {
  const canSeeGmContent = viewerIsGm(isGM);
  if (vessel?.visibility === "gm" && !canSeeGmContent) return [];
  const origin = regionByValue(vessel?.position?.regionId, regions);
  if (!origin) return [];
  const capacity = fleetVesselMarketCapacity(vessel);
  if (!(capacity.capacityCargoPoints > 0)) return [];
  const consumedOfferIds = new Set(
    (Array.isArray(vessel?.history) ? vessel.history : [])
      .filter((row) => String(row?.type ?? "") === "voyage-accepted")
      .map((row) => String(row?.offerId ?? ""))
      .filter(Boolean)
  );
  const activeOfferId = String(vessel?.activeVoyage?.offerId ?? "");
  if (activeOfferId) consumedOfferIds.add(activeOfferId);
  const candidates = [];
  for (const market of markets ?? []) {
    if (market?.active === false || market?.available === false || market?.marketEnabled === false) continue;
    if (market?.visibility === "gm" && !canSeeGmContent) continue;
    const destination = regionByValue(market?.regionId, regions);
    if (!destination || destination.value === origin.value) continue;
    const outbound = airshipRoute(origin.value, destination.value, regions);
    const returning = airshipRoute(destination.value, origin.value, regions);
    if (!outbound || !returning) continue;
    const portQd = Math.max(2, whole(market?.baseDeliveryQd, 2) * 2);
    const durationQd = routeQd(outbound, vessel) + routeQd(returning, vessel) + portQd;
    const seed = `${quoteKey}|${vessel.id}|${market.id}|${origin.value}|${destination.value}`;
    const express = marketRandomUnit(`${seed}|kind`) > 0.72;
    const distanceKm = finite(outbound.distanceKm, 0) + finite(returning.distanceKm, 0);
    const riskPercent = Math.min(35, Math.max(3, Math.round(3 + Math.sqrt(Math.max(0, distanceKm) / 40) * (express ? 2.2 : 1.4))));
    const outboundUtilization = 0.5 + marketRandomUnit(`${seed}|cargo`) * 0.45;
    const returnUnit = marketRandomUnit(`${seed}|return-cargo`);
    const returnUtilization = returnUnit < 0.25 ? 0 : 0.15 + returnUnit * 0.6;
    const outboundCargoPoints = Math.floor(capacity.capacityCargoPoints * outboundUtilization);
    const returnCargoPoints = Math.floor(capacity.capacityCargoPoints * returnUtilization);
    const capacityReservationCargoPoints = Math.max(outboundCargoPoints, returnCargoPoints);
    const scarcity = Math.max(0.5, Math.min(2, 1 / Math.max(0.5, finite(market?.availabilityFactor ?? market?.stockFactor, 1))));
    const quotedDemand = Math.max(0.5, Math.min(2, finite(market?.priceFactor, 1) * scarcity * (0.8 + marketRandomUnit(`${seed}|demand`) * 0.5)));
    const requiredUrs = Math.max(
      whole(outbound?.accessCost, 0),
      whole(returning?.accessCost, 0),
      whole(market?.accessLevelOverride, 0)
    );
    const economy = quoteFleetContractEconomy({
      vessel,
      cargoPoints: outboundCargoPoints,
      returnCargoPoints,
      outboundDemandCargoPoints: outboundCargoPoints,
      returnDemandCargoPoints: returnCargoPoints,
      outboundDistanceKm: finite(outbound.distanceKm, 0),
      returnDistanceKm: finite(returning.distanceKm, 0),
      durationQd,
      demandFactor: quotedDemand,
      returnDemandFactor: Math.max(0.5, Math.min(2, 0.75 + marketRandomUnit(`${seed}|return-demand`) * 0.7)),
      urgencyFactor: express ? 1.25 : 1,
      riskPercent,
      portCalls: 2,
      residentCrewMemberIds: vessel?.crew?.memberIds ?? []
    });
    const offerId = `market-fleet:${vessel.id}:${market.id}:${quoteKey}`;
    if (consumedOfferIds.has(offerId)) continue;
    candidates.push({
      id: offerId,
      source: "market-generated",
      active: true,
      available: true,
      visibility: market?.visibility === "gm" ? "gm" : "known",
      requiredUrs,
      marketId: String(market?.id ?? ""),
      quoteKey,
      kind: express ? "express" : "regular",
      title: express ? `Срочный рейс: ${destination.label}` : `Фрахт до ${destination.label}`,
      clientName: String(market?.countryLabel ?? market?.label ?? "Торговый дом"),
      originRegionId: String(origin.value),
      originLabel: String(origin.label ?? origin.value),
      destinationRegionId: String(destination.value),
      destinationLabel: String(destination.label ?? market?.label ?? destination.value),
      completionRegionId: String(origin.value),
      completionLabel: String(origin.label ?? origin.value),
      routePath: outbound.path,
      returnRoutePath: returning.path,
      distanceKm,
      durationQd,
      ...economy,
      reservedCapacityCargoPoints: capacityReservationCargoPoints,
      reservedCapacityLoad: capacityReservationCargoPoints / FLEET_MARKET_CARGO_POINTS_PER_LOAD,
      riskPercent,
      notes: `Сформировано из графа рынка. Оборот ${Math.round(distanceKm)} км; возвращение в ${origin.label ?? origin.value}.`,
      createdAt
    });
  }
  return candidates
    .sort((a, b) => a.distanceKm - b.distanceKm || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, whole(limit, 5)));
}
