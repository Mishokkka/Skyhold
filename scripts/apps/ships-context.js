import { fleetAccountingSummary } from "../engines/ships/fleet-accounting.js";
import { quoteShipDeparture } from "../engines/ships/runtime.js";
import { attentionLabel, contractGuidance } from "../engines/ships/contracts.js";
import { getShipProfile, SHIP_PROFILES } from "../engines/ships/profiles.js";
import { buildShipWorldContext, quoteWorldShipReturn, quoteWorldShipHomeUpkeep, repriceWorldShipOffer, worldShipTimeBreakdown } from "../engines/ships/world-market.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { MAGNIFIQUE_CREW_VERSION } from "../data/magnifique-crew.js";
import { isMagnifiqueShip } from "../engines/ships/crew-roster.js";
import { hasResidentSettlementWork, isResidentAway, isResidentRestingOnShip, residentShipAssignment } from "../data/resident-presence.js";
import { shipCrewReadiness } from "../engines/ships/crew-readiness.js";
import { shipMoneySummary, shipOutingSummary } from "../engines/ships/summary.js";
import { prepareShipManagementState } from "./domains/ship-management-state.js";
import { prepareShipVoyagePresentation } from "./domains/ship-voyage-presentation.js";
import { prepareShipFinancePresentation } from "./domains/ship-finance-presentation.js";
import { shipPresentationTimelineQd } from "./domains/ship-command-availability.js";
import { shipRemovalBlocker } from "../engines/ships/removal.js";
import { formatShipGold, shipGoldInput } from "../core/ship-gold.js";
import { shortestMarketRouteDistanceKm } from "../engines/market/logistics.js";
import { allResourceDefs } from "../core/resources.js";

const KIND_LABELS = Object.freeze({ freight: "Перевозка", commission: "Поручение", smuggling: "Контрабанда" });
const STYLE_HINTS = Object.freeze({
  cautious: "Дополнительные расходы на предосторожности: 30% базовой сметы; дорожное происшествие мягче на одну ступень.",
  normal: "Договорная плата и обычные расходы без поправки на подход.",
  bold: "Премия 25% только за успешное исполнение без задержки; тяжёлое происшествие добавит 25% базовой сметы к расходам."
});

function sameLocation(left, right) {
  return String(left?.kind ?? "") === String(right?.kind ?? "") && String(left?.id ?? "") === String(right?.id ?? "");
}

function preparedGuidance(contract) {
  return ["cautious", "normal", "bold"].map((style) => {
    const guidance = contractGuidance(contract, style);
    const riskLabel = guidance.incidentPressure <= 3 ? "низкий" : guidance.incidentPressure <= 6 ? "заметный" : guidance.incidentPressure <= 8 ? "высокий" : "крайний";
    return { ...guidance, riskLabel, styleHint: STYLE_HINTS[style] };
  });
}

function worldOfferRow(offer, worldContext) {
  const contract = offer?.contract ?? {};
  const quote = offer?.quote ?? {};
  const styles = offer?.contract ? preparedGuidance(contract) : [];
  const costs = quote.costs ?? {};
  const timing = worldShipTimeBreakdown(worldContext, offer);
  const durationDays = Number(quote.durationQd ?? 0) / 4;
  const difficultyScore = Number(styles[1]?.incidentPressure ?? 0) + (contract.pickup ? 2 : 0)
    + (durationDays >= 20 ? 2 : durationDays >= 10 ? 1 : 0);
  const difficultyLabel = difficultyScore >= 7 ? "Опасный" : difficultyScore >= 4 ? "Сложный" : "Обычный";
  const approachKm = contract.pickup
    ? shortestMarketRouteDistanceKm(offer.from.regionId, contract.pickup.regionId, worldContext.regions, { mode: "airship" }) : 0;
  return {
    ...offer,
    title: offer.title || `${KIND_LABELS[contract.kind] ?? "Заказ"}: ${offer?.to?.label ?? "порт"}`,
    destination: offer?.to?.label ?? "—", kindLabel: KIND_LABELS[contract.kind] ?? "Заказ",
    attention: contract.attention ?? { level: 0, label: attentionLabel(0) },
    durationDays, difficultyLabel,
    approachKm, deliveryKm: Math.max(0, Number(quote.distanceKm ?? 0) - Number(approachKm ?? 0)),
    difficultyHint: `Сложность объединяет риск происшествия, длительность рейса${contract.pickup ? " и подход к чужому порту погрузки" : ""}. Длительность влияет на расходы, но сама по себе не меняет бросок происшествия.`,
    timing: {
      flightDays: timing.flightQd / 4,
      loadingDays: timing.loadingQd / 4,
      unloadingDays: timing.unloadingQd / 4
    },
    rewardCopper: Number(quote.rewardCopper ?? contract.rewardCopper ?? 0),
    recommendedBudgetCopper: Number(quote.recommendedBudgetCopper ?? styles[1]?.suggestedBudgetCopper ?? quote.operatingCopper ?? 0),
    returnReserveCopper: Number(quote.returnReserveCopper ?? 0),
    idleReserveCopper: Number(quote.idleReserveCopper ?? 0),
    idleUpkeepCopperPerDay: Number(quote.idleUpkeepCopperPerDay ?? 0),
    pickupLabel: contract.pickup?.label || offer?.from?.label || "—",
    departureLabel: offer?.from?.label || "—",
    outcomeReserveCopper: Math.max(0, Number(quote.recommendedBudgetCopper ?? 0)
      - Number(costs.totalCopper ?? quote.operatingCopper ?? 0)
      - Number(quote.returnReserveCopper ?? 0) - Number(quote.idleReserveCopper ?? 0)),
    recommendedBudgetGoldInput: shipGoldInput(Number(quote.recommendedBudgetCopper ?? 0)),
    costs: {
      foodCopper: Number(costs.foodCopper ?? 0), crewCopper: Number(costs.crewCopper ?? 0),
      upkeepCopper: Number(costs.upkeepCopper ?? 0), handlingCopper: Number(costs.handlingCopper ?? 0),
      taxCopper: Number(costs.taxCopper ?? 0), totalCopper: Number(costs.totalCopper ?? quote.operatingCopper ?? 0)
    }, styles, normalGuidance: styles[1]
  };
}

function legacyOfferRow(offer) {
  const styles = preparedGuidance(offer);
  return { ...offer, durationDays: Number(offer.durationQd ?? 0) / 4, styles, normalGuidance: styles[1] };
}

function crewOptions(holding, ship) {
  const selected = new Set((ship.crewResidentIds ?? []).map(String));
  const assignedElsewhere = new Set((holding.special?.ships?.list ?? [])
    .filter((row) => String(row?.id ?? "") !== String(ship.id ?? ""))
    .flatMap((row) => (row?.crewResidentIds ?? []).map(String)));
  return (holding.people?.list ?? []).filter((person) => person && (!person.dead || selected.has(String(person.id)))).map((person) => {
    const assignment = person.shipAssignment;
    const occupied = assignedElsewhere.has(String(person.id))
      || Boolean(assignment?.away && String(assignment.shipId ?? "") !== String(ship.id));
    const dead = Boolean(person.dead);
    const injured = !dead && Number(person.injuredDays ?? 0) > 0;
    const isSelected = selected.has(String(person.id));
    return {
      id: String(person.id ?? ""), label: String(person.name || "Без имени"),
      selected: isSelected, disabled: !isSelected && (occupied || dead),
      selectedLabel: isSelected ? "Убрать из команды" : "Добавить в команду",
      statusLabel: occupied ? "Приписан к другому кораблю" : dead ? "Погиб" : injured ? `Ранен · ${person.injuredDays} дн.` : "Доступен",
      searchText: [person.name, person.shipCrewRank, person.shipCrewRole, occupied ? "другой корабль" : "", dead ? "погиб" : "", injured ? "ранен" : ""]
        .filter(Boolean).join(" ").toLocaleLowerCase("ru")
    };
  }).filter((row) => row.id).sort((left, right) => Number(right.selected) - Number(left.selected)
    || left.label.localeCompare(right.label, "ru"));
}

function shipAttention(ship, ports = []) {
  return Object.entries(ship.attentionByDirection ?? {}).map(([directionKey, entry]) => {
    const rawLevel = entry && typeof entry === "object" ? entry.level : entry;
    const level = Number.isSafeInteger(rawLevel) ? Math.max(0, Math.min(10, rawLevel)) : 0;
    const portId = directionKey.startsWith("port:") ? directionKey.slice(5) : "";
    const direction = portId ? ports.find((port) => String(port.id) === portId)?.label || "Неизвестный порт"
      : directionKey.replace(/^destination:/, "");
    return { directionKey, direction, level, label: attentionLabel(level) };
  });
}

function crewRoster(holding, ship) {
  const people = new Map((holding.people?.list ?? []).map((person) => [String(person.id), person]));
  return (ship.crewResidentIds ?? []).map((id) => {
    const person = people.get(String(id));
    if (!person) return { id, name: "Житель удалён", duty: "", status: "Требуется уточнить состав" };
    const name = String(person.name || "Без имени");
    const rank = String(person.shipCrewRank ?? "").trim();
    return {
      id: String(id), name: rank && !name.startsWith(`${rank} `) ? `${rank} ${name}` : name,
      canOpenResident: !person.dead,
      duty: String(person.shipCrewRole || "Обязанности не указаны"),
      status: person.dead ? "Погиб"
        : Number(person.injuredDays ?? 0) > 0 ? `Ранен · ${person.injuredDays} дн.`
          : isResidentAway(person) ? "В рейсе"
            : isResidentRestingOnShip(person, holding) ? "Отдыхает на борту"
              : residentShipAssignment(person)?.shoreDuty === true || hasResidentSettlementWork(person, holding) ? "Работает в поселении"
                : "В поселении"
    };
  });
}

function visibleWorldOfferLocations(ships, period) {
  const shipById = new Map((ships.list ?? []).filter((ship) => ship?.navigationMode === "world").map((ship) => [String(ship.id), ship]));
  const ids = new Set();
  for (const ship of shipById.values()) {
    if (ship.location?.kind === "market" && ship.location.id) ids.add(String(ship.location.id));
  }
  for (const offer of ships.offers ?? []) {
    if (offer?.mode !== "world" || offer?.consumedBy || String(offer?.period) !== String(period)) continue;
    const ship = shipById.get(String(offer.shipId));
    if (!ship || !sameLocation(offer.from, ship.location)) continue;
    if (offer.to?.kind === "market" && offer.to.id) ids.add(String(offer.to.id));
  }
  return { shipById, ids };
}

function periodForHolding(holding) {
  return Math.floor(Math.max(0, Number(holding.gm?.calendaria?.lastQd ?? 0)) / 40);
}

function currentOffersForShip(ships, ship, period) {
  return (ships.offers ?? []).filter((offer) => String(offer?.period) === String(period)
    && !offer?.consumedBy && String(offer?.shipId ?? "") === String(ship?.id ?? "")
    && (ship.navigationMode !== "world" || (offer.mode === "world" && sameLocation(offer.from, ship.location)))
    && (ship.navigationMode === "world" || offer.mode !== "world"));
}

function overviewShipRow(holding, ship, index, { permissions, period, data }) {
  const isWorld = ship.navigationMode === "world";
  const inTransit = Boolean(ship.activeVoyage);
  const awaitingOutcome = inTransit && ship.activeVoyage?.awaitingOutcome === true;
  const atHome = isWorld && ship.location?.kind === "home" && !inTransit;
  const readiness = isWorld ? shipCrewReadiness(holding, ship, { catalog: data?.catalog }) : null;
  let profile = null;
  try { profile = isWorld ? getShipProfile(ship.profileId) : null; } catch (_error) { profile = null; }
  const shipQd = isWorld ? shipPresentationTimelineQd(holding, ship) : Number(holding.gm?.calendaria?.lastQd ?? 0);
  const offers = currentOffersForShip(holding.special?.ships ?? {}, ship, isWorld ? Math.floor(shipQd / 40) : period);
  const moneySummary = isWorld
    ? shipMoneySummary(holding, ship, { clockQd: shipQd })
    : null;
  const management = isWorld ? prepareShipManagementState(holding, ship, { permissions, readiness, money: moneySummary, offers }) : null;
  return {
    id: ship.id,
    name: ship.name,
    commanderName: ship.commanderName,
    index,
    isWorld,
    isLegacy: !isWorld,
    inTransit,
    atHome,
    statusLabel: management?.statusLabel ?? (awaitingOutcome ? "Ожидает итога" : inTransit ? "В пути" : ship.status === "away" ? "В рейсе" : "В поселении"),
    conditionLabel: ship.condition === "ready" ? "Исправен" : "Требуется обслуживание",
    locationLabel: ship.location?.label || (atHome ? holding.name : inTransit ? "В пути" : "—"),
    profileLabel: profile?.label ?? ship.profileId ?? "Прежний ручной расчёт",
    remainingDays: Number(ship.activeVoyage?.remainingQd ?? 0) / 4,
    readiness,
    linkedCrewCount: readiness?.linkedCount ?? Number(ship.crewResidentIds?.length ?? 0),
    totalCrewCount: readiness?.totalCount ?? Number(ship.crewTarget ?? ship.crewRefs?.length ?? 0),
    abstractCrewCount: readiness?.abstractCount ?? 0,
    moneySummary,
    walletGold: formatShipGold(ship.onboardCopper ?? 0),
    nextAction: isWorld ? management.nextAction
      : ship.activeVoyage ? (awaitingOutcome ? "Подвести итог рейса" : "Дождаться возвращения") : "Открыть управление кораблём",
    permissionReason: management?.permissionReason ?? "",
    canOpen: permissions.canView
  };
}

export function prepareShipsContext(holding, { revision = 0, data = null } = {}) {
  const permissions = holdingPermissionContext(holding);
  const ships = holding.special?.ships ?? {};
  const period = periodForHolding(holding);
  const rows = (ships.list ?? []).map((ship, index) => overviewShipRow(holding, ship, index, { permissions, period, data }));
  return {
    revision,
    period,
    detailMode: false,
    profiles: SHIP_PROFILES,
    canCreateProfile: permissions.isGM,
    canGenerateOffers: permissions.isGM && rows.some((row) => row.isLegacy)
      && (ships.offerPeriod === null || ships.offerPeriod === undefined || ships.offerPeriod === "" || Number(ships.offerPeriod) < period),
    offersGenerated: String(ships.offerPeriod) === String(period),
    worldIssues: [],
    rows,
    history: []
  };
}

export function prepareShipWindowContext(holding, { revision = 0, data = null, shipId = "" } = {}) {
  const permissions = holdingPermissionContext(holding);
  const ships = holding.special?.ships ?? {};
  const resourceLoads = new Map(allResourceDefs({ catalogRows: data?.catalog?.resources ?? [] })
    .map((resource) => [resource.id, resource.loadPoints]));
  const selectedShips = (ships.list ?? []).filter((ship) => String(ship?.id ?? "") === String(shipId ?? ""));
  const settlementQd = Number(holding.gm?.calendaria?.lastQd ?? 0);
  const shipQd = selectedShips[0]?.navigationMode === "world" ? shipPresentationTimelineQd(holding, selectedShips[0]) : settlementQd;
  const period = Math.floor(Math.max(0, shipQd) / 40);
  let worldContext = { ports: [], home: null, issues: [] };
  const worldLocations = visibleWorldOfferLocations({ ...ships, list: selectedShips }, period);
  if (data && worldLocations.shipById.size > 0) {
    try { worldContext = buildShipWorldContext(data, holding, { offerLocationIds: worldLocations.ids }); }
    catch (error) { worldContext = { ports: [], home: null, issues: [error.message] }; }
  }
  const offersByShip = new Map();
  const offerErrorsByShip = new Map();
  for (const offer of ships.offers ?? []) {
    if (String(offer?.period) !== String(period) || offer?.consumedBy) continue;
    const ship = selectedShips.find((row) => row.id === offer.shipId);
    if (!ship) continue;
    if (ship.orderBundle) continue;
    if (ship.navigationMode === "world" && (offer.mode !== "world" || !sameLocation(offer.from, ship.location))) continue;
    if (ship.navigationMode !== "world" && offer.mode === "world") continue;
    try {
      const currentOffer = offer.mode === "world" && data
        ? repriceWorldShipOffer(data, holding, ship, offer, { context: worldContext })
        : offer;
      const row = offer.mode === "world" ? worldOfferRow(currentOffer, worldContext) : legacyOfferRow(currentOffer);
      const rows = offersByShip.get(offer.shipId) ?? [];
      rows.push(row);
      offersByShip.set(offer.shipId, rows);
    } catch (error) {
      offerErrorsByShip.set(offer.shipId, error.message || "Предложение больше нельзя рассчитать.");
    }
  }

  const rows = selectedShips.map((ship) => {
    const index = (ships.list ?? []).findIndex((row) => String(row?.id ?? "") === String(ship.id ?? ""));
    const isWorld = ship.navigationMode === "world";
    const isLegacy = !isWorld;
    const inTransit = Boolean(ship.activeVoyage);
    const awaitingOutcome = inTransit && ship.activeVoyage?.awaitingOutcome === true;
    const outcome = inTransit && ship.activeVoyage?.outcome
      ? { ...ship.activeVoyage.outcome, delayDays: Number(ship.activeVoyage.outcome.delayQd ?? 0) / 4 } : null;
    const shortageCopper = awaitingOutcome && outcome ? Math.max(0, Number(outcome.expenseCopper ?? 0) - Number(ship.onboardCopper ?? 0)) : 0;
    const atHome = isWorld && ship.location?.kind === "home" && !inTransit;
    const ownSale = (holding.special?.market?.outbound?.orders ?? []).find((order) => order.ownShipId === ship.id
      && !["delivered", "lost", "cancelled"].includes(order.status)) ?? null;
    const atForeignPort = isWorld && ship.location?.kind === "market" && !inTransit && !ship.orderBundle && !ownSale;
    const readiness = isWorld ? shipCrewReadiness(holding, ship, { catalog: data?.catalog }) : null;
    let profile = null;
    try { profile = isWorld ? getShipProfile(ship.profileId) : null; } catch (_error) { profile = null; }
    let returnOffer = null;
    let returnError = "";
    if (data && atForeignPort) {
      try { returnOffer = worldOfferRow(quoteWorldShipReturn(data, holding, ship, { context: worldContext }), worldContext); }
      catch (error) { returnError = error.message; }
    }
    let quote = null;
    let quoteError = "";
    if (isLegacy && ship.status === "docked") {
      try { quote = quoteShipDeparture(ship); } catch (error) { quoteError = error.message; }
    }
    const options = crewOptions(holding, ship);
    const magnifiqueRosterVersion = Number(ship.magnifiqueCrewRoster?.version ?? 0);
    const offerLockKey = `${ship.id}|${ship.location?.kind ?? ""}:${ship.location?.id ?? ""}|${period}`;
    const worldOffersGenerated = Boolean(ships.worldOfferLocks?.[offerLockKey]);
    const moneySummary = isWorld ? shipMoneySummary(holding, ship, { returnOffer, clockQd: shipQd }) : null;
    const availableOffers = offersByShip.get(ship.id) ?? [];
    const management = isWorld ? prepareShipManagementState(holding, ship, { permissions, readiness, money: moneySummary, offers: availableOffers, returnOffer }) : null;
    const relocationPorts = isWorld && !inTransit && !ship.orderBundle && !ownSale
      ? worldContext.ports.filter((port) => port.regionId !== ship.location?.regionId
        && port.regionId !== worldContext.home?.regionId)
        .map((port) => ({ id: port.id, label: port.label })) : [];
    const bundle = ship.orderBundle;
    const bundleCurrentStop = bundle?.stops?.[bundle.nextStopIndex - 1] ?? null;
    const bundleNextStop = bundle?.stops?.[bundle.nextStopIndex] ?? null;
    const outingReport = isWorld ? shipOutingSummary(ship, { clockQd: shipQd, obligationsCopper: moneySummary.obligationsCopper }) : null;
    let homeUpkeepCopperPerDay = ship.homeUpkeepEnabled === false ? 0 : ship.homeUpkeepCopperPerDay;
    if (data && atHome && worldContext.home) {
      try { homeUpkeepCopperPerDay = quoteWorldShipHomeUpkeep(data, holding, ship, { context: worldContext }).homeUpkeepCopperPerDay; }
      catch (_error) { /* Keep the last configured rate when the catalog is unavailable. */ }
    }
    return {
      ...ship, index, isWorld, isLegacy, inTransit, away: ship.status === "away",
      homeUpkeepCopperPerDay,
      homeUpkeepEnabled: ship.homeUpkeepEnabled !== false,
      atHome, atForeignPort, locationLabel: ship.location?.label || (atHome ? worldContext.home?.label : "В пути") || "—",
      profileLabel: profile?.label ?? ship.profileId ?? "—", linkedCrewCount: readiness?.linkedCount ?? 0,
      abstractCrewCount: readiness?.abstractCount ?? 0, totalCrewCount: readiness?.totalCount ?? 0,
      readiness, moneySummary,
      ...management,
      timelineQd: shipQd, settlementQd, catchUpDays: Math.max(0, settlementQd - shipQd) / 4,
      walletGold: formatShipGold(ship.onboardCopper ?? 0),
      ownSale, ownSaleCargoText: (ownSale?.cargo ?? []).map((row) => `${row.name || row.resourceId} ×${row.qty}`).slice(0, 5).join(" · "),
      ownSaleRemainingDays: Number(ownSale?.remainingQd ?? 0) / 4,
      ownSaleNeedsResolution: ownSale?.status === "needsResolution",
      voyagePresentation: prepareShipVoyagePresentation(holding, ship, { ownSale }),
      hasBundle: Boolean(bundle), bundleCurrentStop, bundleNextStop,
      bundleOrders: (bundle?.orders ?? []).map((order) => ({
        offerId: order.offerId, title: order.offer.title, destination: order.offer.to?.label,
        pickupLabel: order.offer.contract?.pickup?.label || order.offer.from?.label,
        cargoName: order.offer.contract?.cargo?.name || order.offer.title,
        stateLabel: order.state === "delivered" ? "Доставлен" : order.outcome && !order.outcomeApplied ? "Исход сохранён · ждёт оплаты" : order.state === "loaded" ? "На борту" : "Ожидает погрузки",
        loadPoints: order.offer.contract?.cargo?.loadPoints ?? 0, rewardCopper: order.offer.contract?.rewardCopper ?? 0,
        outcome: order.outcome
      })),
      canResolveBundle: Boolean(management?.commands.resolveBundle?.allowed),
      canContinueBundle: Boolean(management?.commands.continueBundle?.allowed),
      bundleDelayDays: Math.max(0, Number(bundle?.delayUntilQd ?? 0) - Number(holding.gm?.calendaria?.lastQd ?? 0)) / 4,
      outingReport,
      financePresentation: isWorld ? prepareShipFinancePresentation(holding, ship, { money: moneySummary, outingReport, ownSale }) : null,
      nextAction: management?.nextAction ?? "",
      statusLabel: management?.statusLabel ?? (ship.status === "away" ? "В рейсе" : "В поселении"),
      conditionLabel: ship.condition === "ready" ? "Исправен" : "Требуется обслуживание",
      occupiedLoadPoints: ownSale ? (ownSale.dispatchStatus === "booked" ? 0 : (ownSale.cargo ?? []).reduce((sum, row) => sum + Number(row.qty || 0)
        * Number(resourceLoads.get(row.resourceId) ?? 0), 0))
        : bundle ? bundle.orders.reduce((sum, order) => sum + (order.state === "loaded" ? Number(order.offer.contract?.cargo?.loadPoints ?? 0) : 0), 0)
        : Number(ship.activeVoyage?.quote?.contract?.cargo?.loadPoints ?? 0),
      crewOptions: options, hasCrewOptions: options.length > 0,
      crewRoster: crewRoster(holding, ship),
      canEditPlan: permissions.isGM && !inTransit && !bundle && !ownSale,
      canAdopt: permissions.isGM && isLegacy && ship.status === "docked" && !ship.activeVoyage,
      canConfigureCrew: permissions.isGM && atHome,
      canDelete: permissions.isGM && !ownSale && !shipRemovalBlocker(holding, ship),
      deleteReason: ownSale ? "Дождитесь исхода продажи собственного товара" : shipRemovalBlocker(holding, ship) || "Удалить корабль; жители и их работа сохранятся",
      canInstallMagnifiqueCrew: permissions.isGM && atHome && isMagnifiqueShip(ship)
        && magnifiqueRosterVersion < MAGNIFIQUE_CREW_VERSION,
      magnifiqueCrewInstalled: isMagnifiqueShip(ship) && magnifiqueRosterVersion >= MAGNIFIQUE_CREW_VERSION,
      canAdjust: isWorld ? (!management.commands.clockBlocked && (atHome
        ? permissions.canManageShips && ship.status === "docked" && !bundle && !ownSale
        : permissions.isGM && ship.status === "away" && Boolean(inTransit || ship.location?.kind === "market")))
        : permissions.isGM && ship.status === "away",
      canDepart: Boolean(permissions.canManageShips && isLegacy && ship.status === "docked" && ship.condition === "ready" && quote && !ship.activeVoyage),
      canDepartOffer: Boolean(permissions.canManageShips && !inTransit && !bundle && !ownSale && ship.condition === "ready" && (!isWorld || readiness.ready)),
      canDepartBundle: Boolean(permissions.canManageShips && isWorld && !inTransit && !bundle && !ownSale
        && ship.condition === "ready" && readiness.ready && availableOffers.length >= 2),
      canGenerateWorld: Boolean(permissions.canManageShips && isWorld && !management.commands.clockBlocked && !inTransit && !bundle && !ownSale && ship.condition === "ready" && !worldOffersGenerated),
      canRerollWorld: Boolean(permissions.isGM && isWorld && !management.commands.clockBlocked && !inTransit && !bundle && !ownSale && ship.condition === "ready" && worldOffersGenerated),
      worldOffersGenerated,
      canReturnHome: Boolean(management?.commands.returnHome?.allowed),
      canRelocate: Boolean(permissions.canManageShips && isWorld && !inTransit && !bundle && !ownSale
        && !management.commands.clockBlocked && ship.condition === "ready" && readiness.ready && relocationPorts.length),
      relocationPorts,
      canResolve: isWorld ? Boolean(management.commands.resolveWorld?.allowed) : Boolean(permissions.canManageShips && awaitingOutcome),
      awaitingOutcome, outcome, shortageCopper, attentionRecords: shipAttention(ship, worldContext.ports),
      offers: ownSale ? [] : availableOffers, quote, quoteError, returnOffer, returnError,
      worldOfferError: offerErrorsByShip.get(ship.id) ?? "",
      pendingPortBillCopper: Number(ship.pendingPortBillCopper ?? 0),
      durationDays: quote ? quote.durationQd / 4 : 0,
      remainingDays: Number(ship.activeVoyage?.remainingQd ?? 0) / 4
    };
  });

  return {
    revision, period, detailMode: true, profiles: SHIP_PROFILES, canCreateProfile: permissions.isGM,
    canGenerateOffers: permissions.isGM && rows.some((row) => row.isLegacy)
      && (ships.offerPeriod === null || ships.offerPeriod === undefined || ships.offerPeriod === "" || Number(ships.offerPeriod) < period),
    fleetAccounting: fleetAccountingSummary(holding),
    offersGenerated: String(ships.offerPeriod) === String(period), worldIssues: worldContext.issues ?? [], rows,
    history: (ships.history ?? []).filter((row) => String(row?.shipId ?? "") === String(shipId ?? "")).slice(-10).reverse().map((row) => ({
      ...row, destination: row.destination || row.to?.label || "—",
      outcome: row.outcome ? { ...row.outcome, delayDays: Number(row.outcome.delayQd ?? 0) / 4 } : null,
      historyTitle: row.contract
        ? `${row.contract.cargo?.name || "Заказ"}: ${row.contract.pickup?.label || row.from?.label || "Порт"} → ${row.to?.label || row.destination || "—"}`
        : `${row.from?.label || "Порт"} → ${row.to?.label || row.destination || "—"}`,
      ledger: (row.ledger ?? []).map((entry) => ({ ...entry, label: entry.reason || ({ depart: "Бортовой бюджет и подготовка", expense: "Снабжение", income: "Плата за рейс", return: "Возврат остатка" }[entry.kind] ?? "Операция") }))
    }))
  };
}
