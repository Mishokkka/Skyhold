import { prepareTransportCommerce } from "../market/transport-commerce.js";
import { transportServicesFromRoutes, validateTransportConfiguration } from "../../engines/transport/services.js";
import { resolveTransportSelections, transportServiceExcluded } from "../../engines/transport/service-identity.js";
import { planTransportChain } from "../../engines/transport/planner.js";
import { diagnoseHiredRouteFailure, findOptimalHiredRoute, findOptimalOwnShipServices, resolveSettlementAccessLevel, scaleHiredServiceForCargo } from "../../engines/transport/router.js";
import { cargoLoad, cargoValue, shipTransportFunding, transportLoad, transportMoney } from "../../engines/transport/quantities.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { findHoldingRegion } from "../../engines/market/logistics.js";
import { marketLocationFactors } from "../../engines/market/composition.js";
import { cargoShelfLife } from "../../engines/market/cargo-aging.js";
import { buildShipWorldContext } from "../../engines/ships/world-market.js";
import { transportClockOffsetQd, transportHoldingQd } from "../../data/transport/clock.js";
import { transportRelevantHolding } from "../../data/transport/state.js";
import { transportInsuranceCopper } from "../../engines/transport/economics.js";
import { transportSeasonalCalendar } from "../../engines/transport/seasonal.js";
import { getCalendariaSeasonSnapshot } from "../../integrations/calendaria-bridge.js";

export function transportSourceToken(data, holding) {
  return stableDataHash({
    holding: transportRelevantHolding(holding),
    markets: data?.meta?.sharedMarkets,
    transport: data?.meta?.transportV2,
    catalog: data?.catalog
  });
}

function selectedCargo(context, request) {
  const outbound = request.direction === "outbound";
  const lines = outbound ? context.outbound?.plan?.lines ?? [] : context.plan?.lines ?? [];
  const quantities = request.quantities ?? {};
  for (const [id, qty] of Object.entries(quantities)) {
    if (!Number.isSafeInteger(qty) || qty < 0 || qty > 1000000) throw new Error("Количество должно быть целым неотрицательным числом.");
    if (qty && !lines.some((line) => (outbound ? line.resourceId === id : line.id === id) && line.qty === qty)) {
      throw new Error("Выбранное количество больше доступного предложения или запаса.");
    }
  }
  const definitions = new Map(context.resources.map((row) => [row.id, row]));
  const source = outbound ? context.outbound?.plan?.cargoReservations ?? [] : lines;
  const offers = new Map((context.outbound?.offers ?? []).map((row) => [row.resourceId, row]));
  const cargo = source.map((line, index) => {
    const resource = definitions.get(line.resourceId), offer = outbound ? offers.get(line.resourceId) : line;
    return {
      ...line,
      lotId: `${outbound ? `${line.rowId}:${line.batchId}` : line.id}:${index}`,
      qty: line.qty,
      unitLoad: transportLoad(offer?.load ?? (resource?.loadPoints ?? 4) / 4),
      unitCopper: line.unitPriceCopper,
      ageQd: line.ageQd ?? line.reservedAgeQd ?? 0,
      shelfLifeQd: cargoShelfLife(line),
      sourceType: line.sourceType ?? "resource"
    };
  });
  if (!cargo.length) throw new Error("Не выбраны товары для перевозки.");
  return { cargo, lines };
}

function resolveMode(request = {}) {
  if (request.mode === "owned" || request.mode === "charter" || request.mode === "regular") return request.mode;
  if (request.ownShipId) return "owned";
  return request.priority === "time" ? "charter" : "regular";
}

function finalizeQuote({ plan, services, ship, transferPortId = "", transferPortLabel = "", env, request }) {
  const { holding, context, direction, startQd, clockOffsetQd, configuration, access, cargo, lines, from, to, sourceToken } = env;
  const valueCopper = cargoValue(cargo);
  const taxCopper = Math.ceil(valueCopper * (access.importTaxRate + access.exportTaxRate));
  const insuranceCopper = request.insurance === false ? 0 : transportInsuranceCopper(plan, configuration);
  const funding = shipTransportFunding({
    expensesCopper: plan.ownExpensesCopper,
    reserveCopper: ship ? Math.max(0, Math.floor(Number(request.reserveCopper ?? 0) || 0)) : 0,
    onboardCopper: ship?.onboardCopper ?? 0
  });
  const totalCopper = transportMoney([plan.totalCopper, taxCopper, insuranceCopper]);
  const treasuryCopper = transportMoney([
    direction === "inbound" ? valueCopper : 0,
    taxCopper,
    insuranceCopper,
    plan.totalCopper - plan.ownExpensesCopper,
    funding.treasuryCopper
  ]);
  const commercial = {
    marketId: context.market.id,
    marketRegionId: context.market.regionId,
    marketLabel: context.quote.marketLabel ?? context.market.label ?? context.market.name,
    targetRoomId: request.targetRoomId ?? "outdoors",
    lines, taxCopper, insuranceCopper,
    insuranceCoverageBps: insuranceCopper ? configuration.insuranceCoverageBps : 0,
    reserveCopper: funding.reserveCopper,
    revenueOnBoard: direction === "outbound" && plan.stages.at(-1).service.kind === "owned"
  };
  return {
    ok: true,
    plan, services, commercial, ship, lines, transferPortId, transferPortLabel,
    search: { plans: [plan], limited: false, limits: { ports: false, routes: false, plans: false }, failures: [] },
    treasuryCopper, valueCopper, totalCopper, clockOffsetQd,
    warnings: cargo
      .filter((lot) => lot.shelfLifeQd > 0 && lot.ageQd + plan.arrivalQd - startQd >= lot.shelfLifeQd)
      .map((lot) => `${lot.name || lot.resourceId}: срок хранения истечёт до прибытия. Порча не покрывается страховкой.`),
    affordable: treasuryCopper <= (holding.storage.moneyCopper ?? 0),
    sourceToken,
    planToken: stableDataHash({ plan, commercial, treasuryCopper }),
    from, to
  };
}

function prepareEnvironment({ data, holding, request = {}, isGM = false }) {
  const direction = request.direction === "outbound" ? "outbound" : "inbound";
  const context = prepareTransportCommerce({ data, holding, request: { ...request, direction }, isGM });
  const { cargo, lines } = selectedCargo(context, { ...request, direction });
  const configuration = validateTransportConfiguration(data.catalog?.transportV2);
  const regions = data.catalog?.eventRegions ?? [];
  const home = findHoldingRegion(holding, regions)?.value;
  if (!home) throw new Error("У поселения не определена локация.");
  const endpoint = ["sky-island", "ship"].includes(holding.type) || context.market.regionId === home ? `${home}:holding` : home;
  const from = direction === "inbound" ? context.market.regionId : endpoint;
  const to = direction === "inbound" ? endpoint : context.market.regionId;
  const state = data.meta?.transportV2;
  const clockOffsetQd = transportClockOffsetQd(data, holding);
  const startQd = transportHoldingQd(data, holding);
  if (startQd < Number(state?.clockQd ?? 0)) {
    throw new Error("Дата поселения отстаёт от общей даты перевозок. Проведите недостающие периоды перед новым заказом.");
  }
  const difficulty = Math.max(0, ...lines.map((line) => Number(
    line.accessDifficulty ?? context.outbound?.offers?.find((offer) => offer.resourceId === line.resourceId)?.accessDifficulty ?? 0
  )));
  const seasonId = getCalendariaSeasonSnapshot(holding.gm?.calendaria?.lastDateTime, holding.gm?.calendaria?.lastDateText)?.season?.key ?? "";
  const regionFactors = (region) => marketLocationFactors(region, context.economy, regions, { normalizedEconomy: true });
  const access = resolveSettlementAccessLevel(holding, regions, context.market, {
    direction, seasonId, dependencies: { regionFactors }
  });
  const calendar = transportSeasonalCalendar(holding, startQd);
  const serviceEndpoints = {
    markets: context.markets, resources: context.resources,
    holdingId: holding.id, homeRegionId: home, homeEndpoint: endpoint, calendar
  };
  return {
    data, holding, context, direction, cargo, lines, totalLoad: cargoLoad(cargo),
    configuration, regions, home, endpoint, from, to, state, clockOffsetQd, startQd,
    difficulty, seasonId, regionFactors, access, calendar, serviceEndpoints, isGM,
    sourceToken: transportSourceToken(data, holding)
  };
}

function buildHiredOption(env, kind, request) {
  const { holding, context, regions, direction, access, difficulty, totalLoad, seasonId, regionFactors, isGM, configuration, serviceEndpoints, cargo, startQd, state } = env;
  const cargoAccessLimit = access.accessLevel - difficulty;
  if (cargoAccessLimit < 0) return { ok: false, error: `Для этого товара требуется УРС ${difficulty}, у поселения УРС ${access.accessLevel}.` };
  const route = findOptimalHiredRoute({
    holding, market: context.market, regions,
    organizations: context.economy?.organizations ?? [],
    countries: context.economy?.countries ?? [],
    seasonId, direction, accessLimit: cargoAccessLimit, cargoLoad: totalLoad,
    kind, metric: kind === "charter" ? "time" : "cost", regionFactors, isGM
  });
  if (!route?.ok) {
    return {
      ok: false,
      error: diagnoseHiredRouteFailure({
        holding, market: context.market, regions,
        organizations: context.economy?.organizations ?? [],
        countries: context.economy?.countries ?? [],
        direction, accessLimit: cargoAccessLimit, regionFactors, isGM
      })
    };
  }
  const rawServices = transportServicesFromRoutes([route], configuration, regions, serviceEndpoints)
    .filter((service) => isGM || service.visibility !== "gm")
    .map((service) => scaleHiredServiceForCargo(service, totalLoad, configuration.overrides));
  const resolved = resolveTransportSelections(rawServices, request);
  if (resolved.ambiguous.length) return { ok: false, error: "Выбранная служба неоднозначна. Выберите вариант доставки заново." };
  const allServices = request.excluded?.length
    ? rawServices.filter((service) => !transportServiceExcluded(service, request.excluded))
    : rawServices;
  const selected = resolved.request.serviceIds?.length
    ? resolved.request.serviceIds.map((id) => allServices.find((row) => row.id === id))
    : allServices.filter((service) => service.kind === kind);
  if (!selected.length || selected.some((row) => !row) || selected[0].from !== env.from || selected.at(-1).to !== env.to) {
    return { ok: false, error: "Для выбранного груза нет доступной перевозки." };
  }
  try {
    const plan = planTransportChain({ cargo, services: selected, startQd, runs: state?.runs ?? [] });
    return finalizeQuote({ plan, services: allServices, ship: null, env, request });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function buildOwnedOption(env, ship, request) {
  const { data, holding, context, regions, direction, access, difficulty, totalLoad, seasonId, regionFactors, isGM, configuration, serviceEndpoints, home, endpoint, cargo, startQd, clockOffsetQd, state, calendar } = env;
  if (!ship) return { ok: false, error: "У поселения нет корабля, доступного для мировых рейсов." };
  const world = buildShipWorldContext(data, holding, {
    offerLocationIds: [context.market.id, context.market.regionId, ship.location?.id, ship.location?.regionId].filter(Boolean)
  });
  const found = findOptimalOwnShipServices({
    data, holding, ship, world, market: context.market, regions,
    organizations: context.economy?.organizations ?? [],
    countries: context.economy?.countries ?? [],
    seasonId, direction, accessLimit: access.accessLevel, difficulty, cargoLoad: totalLoad,
    configuration, clockQd: startQd - clockOffsetQd, regionFactors, isGM,
    homeEndpoint: endpoint, homeRegionId: home, returnHome: request.returnHome === true,
    calendar, serviceEndpoints
  });
  if (!found.ok) return { ok: false, error: found.reason, needsTimeSync: Boolean(found.needsTimeSync) };
  if (!found.services?.length || found.services[0].from !== env.from || found.services.at(-1).to !== env.to) {
    return { ok: false, error: "Нет доступного воздушного маршрута для своего корабля (проверьте УРС и воздушные порты)." };
  }
  try {
    const plan = planTransportChain({ cargo, services: found.services, startQd, runs: state?.runs ?? [] });
    return finalizeQuote({
      plan, services: found.services, ship,
      transferPortId: found.transferPortId, transferPortLabel: found.transferPortLabel, env, request
    });
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Compute all three clean checkout options (regular, charter, own ship) in one fast pass. */
export function prepareTransportOptions({ data, holding, request = {}, isGM = false, canManageShips = true } = {}) {
  const env = prepareEnvironment({ data, holding, request, isGM });
  const worldShips = canManageShips
    ? (holding.special?.ships?.list ?? []).filter((ship) => ship.navigationMode === "world")
    : [];
  const chosenShip = (request.ownShipId ? worldShips.find((row) => row.id === request.ownShipId) : null)
    ?? worldShips.find((ship) => ship.condition === "ready" && !ship.activeVoyage && !ship.orderBundle && !ship.transportOrderId)
    ?? worldShips[0]
    ?? null;
  const regular = buildHiredOption(env, "regular", { ...request, mode: "regular", ownShipId: "" });
  const charter = buildHiredOption(env, "charter", { ...request, mode: "charter", ownShipId: "" });
  const owned = chosenShip ? buildOwnedOption(env, chosenShip, { ...request, mode: "owned", ownShipId: chosenShip.id }) : null;
  const explicitMode = request.mode === "owned" || request.mode === "charter" || request.mode === "regular" ? request.mode : "";
  const options = { regular, charter, owned };
  let activeMode;
  if (explicitMode) {
    activeMode = explicitMode === "owned" && owned ? "owned" : explicitMode === "charter" ? "charter" : "regular";
  } else if (request.ownShipId && owned) {
    activeMode = "owned";
  } else if (request.priority === "time") {
    activeMode = charter.ok ? "charter" : "regular";
  } else if (regular.ok && charter.ok) {
    activeMode = charter.totalCopper < regular.totalCopper ? "charter" : "regular";
  } else {
    activeMode = regular.ok ? "regular" : charter.ok ? "charter" : owned?.ok ? "owned" : "regular";
  }
  return {
    env,
    options,
    activeMode,
    active: options[activeMode],
    chosenShip,
    worldShips,
    sourceToken: env.sourceToken
  };
}

/** Authoritative single-plan builder used by checkout confirmation and the operation executor. */
export function prepareTransportContext({ data, holding, request = {}, isGM = false, allowIncomplete = false } = {}) {
  const env = prepareEnvironment({ data, holding, request, isGM });
  const mode = resolveMode(request);
  let result;
  if (mode === "owned") {
    const ship = holding.special?.ships?.list?.find((row) => row.id === request.ownShipId) ?? null;
    if (!ship) {
      if (allowIncomplete) return { plan: null, services: [], search: { plans: [], limited: false, limits: { ports: false, routes: false, plans: false }, failures: [] }, from: env.from, to: env.to, ship: null, lines: env.lines, error: "Выбранный корабль не найден.", affordable: false, sourceToken: env.sourceToken };
      throw new Error("Выбранный корабль не найден.");
    }
    result = buildOwnedOption(env, ship, request);
  } else {
    result = buildHiredOption(env, mode, request);
    if (!result.ok && !request.mode) {
      const fallback = buildHiredOption(env, mode === "regular" ? "charter" : "regular", request);
      if (fallback.ok) result = fallback;
    }
  }
  if (!result.ok) {
    if (allowIncomplete) {
      return {
        plan: null, services: [], from: env.from, to: env.to, ship: null, lines: env.lines,
        search: { plans: [], limited: false, limits: { ports: false, routes: false, plans: false }, failures: [result.error] },
        error: result.error, needsTimeSync: Boolean(result.needsTimeSync),
        affordable: false, sourceToken: env.sourceToken
      };
    }
    throw new Error(result.error);
  }
  return result;
}
