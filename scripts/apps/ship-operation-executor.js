import { SkyholdData } from "../data/store.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { stableDataHash } from "../data/storage-commit.js";
import { hasResidentSettlementWork, isResidentAway } from "../data/resident-presence.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { createShipRecord } from "../data/ships.js";
import { quoteShipDeparture, departShip, adjustShipFunds, resolveShipContract } from "../engines/ships/runtime.js";
import { generateShipOffers } from "../engines/ships/contracts.js";
import { getShipProfile } from "../engines/ships/profiles.js";
import { embarkShipCrew, disembarkShipCrew, returnCrewResidentToShip } from "../engines/ships/crew.js";
import { shipCrewReadiness } from "../engines/ships/crew-readiness.js";
import { removeSettlementShip } from "../engines/ships/removal.js";
import { installMagnifiqueCrewRoster, isMagnifiqueShip } from "../engines/ships/crew-roster.js";
import { buildShipWorldContext, configureWorldShipEconomy, generateWorldShipOffers, quoteWorldShipReturn, quoteWorldShipRelocation, quoteWorldShipBundle, repriceWorldShipOffer } from "../engines/ships/world-market.js";
import { initializeWorldShip, departWorldShip, departWorldShipBundle, continueWorldShipBundle, resolveWorldShip, resolveWorldShipBundleStop, adjustWorldShipFunds, advanceWorldShips, worldShipTimelineQd } from "../engines/ships/world-voyage.js";

const SHIP_OPERATION_TYPES = new Set([
  "create-profile", "adopt", "crew", "install-magnifique-crew", "generate-world", "reroll-world", "depart-world", "depart-bundle", "continue-bundle", "resolve-bundle", "return-home", "relocate-world", "resolve-world",
  "depart", "adjust", "generate", "resolve", "delete", "shore-duty", "return-to-ship"
]);
const CONTRACT_STYLES = new Set(["cautious", "normal", "bold"]);
const MAX_OFFERS_PER_PERIOD = 80;
const MAX_WORLD_LOCATION_LOCKS = 240;
const WORLD_LOCK_RETENTION_PERIODS = 12;

function fail(message, code = COMMAND_ERROR.INVALID) {
  throw Object.assign(new Error(message), { code });
}

function worldLockKey(ship, period) {
  return `${ship.id}|${ship.location?.kind ?? ""}:${ship.location?.id ?? ""}|${period}`;
}

function assertRenderedLocation(operation, ship) {
  if (String(operation.locationKind ?? "") !== String(ship.location?.kind ?? "")
    || String(operation.locationId ?? "") !== String(ship.location?.id ?? "")) {
    fail("Корабль уже находится в другом месте. Обновите окно и повторите действие.", COMMAND_ERROR.CONFLICT);
  }
}

function hasPendingOwnSale(holding, shipId) {
  return (holding.special?.market?.outbound?.orders ?? []).some((order) => order.ownShipId === shipId
    && !["delivered", "lost", "cancelled"].includes(order.status));
}

function pruneWorldLocks(holding, currentPeriod, replaceKey = "") {
  const ships = holding.special.ships;
  const locks = ships.worldOfferLocks && typeof ships.worldOfferLocks === "object" ? ships.worldOfferLocks : {};
  if (Object.values(locks).some((row) => Number.isFinite(Number(row?.period)) && Number(row.period) > currentPeriod)) {
    fail("Сохранённый торговый период кораблей позже текущего времени. Исправьте календарь перед новой подборкой.", COMMAND_ERROR.CONFLICT);
  }
  const shipPeriods = new Map((ships.list ?? []).map((ship) => [ship.id, Math.floor(worldShipTimelineQd(holding, ship) / 40)]));
  const retained = Object.entries(locks).filter(([, row]) => {
    const shipPeriod = shipPeriods.get(row?.shipId);
    return Number(row?.period) >= (shipPeriod ?? currentPeriod) - WORLD_LOCK_RETENTION_PERIODS;
  });
  const current = retained.filter(([, row]) => Number(row?.period) === currentPeriod);
  if (current.length >= MAX_WORLD_LOCATION_LOCKS && !current.some(([key]) => key === replaceKey)) fail("Слишком много корабельных рынков открыто в одном торговом периоде.");
  const older = retained.filter(([, row]) => Number(row?.period) !== currentPeriod)
    .sort((left, right) => Number(right[1]?.period ?? 0) - Number(left[1]?.period ?? 0))
    .slice(0, Math.max(0, MAX_WORLD_LOCATION_LOCKS - current.length));
  ships.worldOfferLocks = Object.fromEntries([...older, ...current]);
}

function worldResponse(operation, payload = {}) {
  return { operationId: operation.operationId, ...payload, ok: payload?.ok !== false };
}

function catchUpShip(holding, ship, settlementQd) {
  const result = advanceWorldShips(holding, settlementQd, { shipId: ship.id });
  if (result.blocked.length) throw new Error(result.blocked[0].message);
  for (const row of result.returned) disembarkShipCrew(holding, ship, row.arrivalQd);
  return result;
}

export function createShipOperationExecutor({
  updateHolding = (...args) => SkyholdData.updateHolding(...args),
  skip = (result) => SkyholdData.skipTransaction(result),
  getUser = (id) => globalThis.game?.users?.get?.(id),
  random = Math.random
} = {}) {
  return async (raw, { userId, remote = false } = {}) => {
    const operation = {
      type: raw?.type, operationId: raw?.operationId, holdingId: raw?.holdingId, shipId: raw?.shipId,
      expectedRevision: raw?.expectedRevision,
      budgetCopper: raw?.budgetCopper === null ? null : (raw?.budgetCopper ?? (["depart-world", "depart-bundle"].includes(raw?.type) ? null : 0)), voyageId: raw?.voyageId ?? "",
      amountCopper: raw?.amountCopper ?? 0, kind: raw?.kind ?? "", reason: String(raw?.reason ?? "").trim().slice(0, 300),
      offerId: raw?.offerId ?? "", offerIds: Array.isArray(raw?.offerIds) ? raw.offerIds : [], style: raw?.style ?? "normal",
      profileId: String(raw?.profileId ?? ""), shipName: String(raw?.shipName ?? "").trim().slice(0, 100),
      crewResidentIds: Array.isArray(raw?.crewResidentIds) ? raw.crewResidentIds.map(String) : [],
      residentId: ["shore-duty", "return-to-ship"].includes(raw?.type) ? String(raw?.residentId ?? "") : "",
      locationKind: String(raw?.locationKind ?? ""), locationId: String(raw?.locationId ?? ""),
      destinationId: String(raw?.destinationId ?? "")
    };
    if (!SHIP_OPERATION_TYPES.has(operation.type) || !/^[A-Za-z0-9_-]{1,128}$/.test(operation.operationId ?? "")) fail("Некорректная операция корабля.");
    if (typeof operation.holdingId !== "string" || !operation.holdingId || operation.holdingId.length > 128) fail("Не указано поселение.");
    const shipless = operation.type === "generate" || operation.type === "create-profile";
    if (!shipless && (typeof operation.shipId !== "string" || !operation.shipId || operation.shipId.length > 128)) fail("Не указан корабль.");
    if (shipless) operation.shipId = "";
    if (!Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0) fail("Не указана версия данных.");
    for (const value of [operation.budgetCopper, operation.amountCopper].filter((row) => row !== null)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) fail("Некорректная сумма операции.");
    }
    if (typeof operation.voyageId !== "string" || operation.voyageId.length > 128 || !["", "income", "expense", "deposit", "withdraw"].includes(operation.kind)) fail("Некорректные параметры рейса.");
    if (typeof operation.offerId !== "string" || operation.offerId.length > 128 || !CONTRACT_STYLES.has(operation.style)) fail("Некорректные параметры контракта.");
    if (operation.type === "relocate-world" && (!operation.destinationId || operation.destinationId.length > 128)) fail("Не указан порт назначения.");
    if (operation.type !== "relocate-world") operation.destinationId = "";
    if (operation.type === "depart-bundle") {
      if (operation.offerIds.length < 2 || operation.offerIds.length > 3
        || operation.offerIds.some((id) => typeof id !== "string" || !id || id.length > 128)
        || new Set(operation.offerIds).size !== operation.offerIds.length) fail("Выберите два или три разных заказа.");
    } else operation.offerIds = [];
    if (!["depart", "depart-world", "depart-bundle"].includes(operation.type)) { operation.offerId = ""; operation.style = "normal"; }
    if (operation.type !== "adjust") { operation.amountCopper = 0; operation.kind = ""; operation.reason = ""; }
    if (!["adjust", "resolve", "resolve-world", "continue-bundle", "resolve-bundle"].includes(operation.type)) operation.voyageId = "";
    if (!["adopt", "create-profile"].includes(operation.type)) operation.profileId = "";
    if (operation.type !== "create-profile") operation.shipName = "";
    if (operation.type !== "crew") operation.crewResidentIds = [];
    if (operation.crewResidentIds.length > 500 || new Set(operation.crewResidentIds).size !== operation.crewResidentIds.length
      || operation.crewResidentIds.some((id) => !id || id.length > 128)) fail("Некорректный список команды.");
    if (["shore-duty", "return-to-ship"].includes(operation.type) && (!operation.residentId || operation.residentId.length > 128)) fail("Не указан член экипажа.");
    if (!["generate-world", "reroll-world", "depart-world", "depart-bundle", "continue-bundle", "resolve-bundle", "return-home", "relocate-world", "adjust"].includes(operation.type)) {
      operation.locationKind = ""; operation.locationId = "";
    }
    const user = getUser(userId);
    if (!user || (remote && user.isGM)) fail("Недопустимый отправитель операции.", COMMAND_ERROR.FORBIDDEN);
    const signature = JSON.stringify(operation);
    const result = await updateHolding(operation.holdingId, (holding, data) => {
      const playerOperation = ["generate-world", "depart-world", "depart-bundle", "continue-bundle", "resolve-bundle", "return-home", "relocate-world", "resolve-world", "depart", "resolve"].includes(operation.type)
        || (operation.type === "adjust" && ["deposit", "withdraw"].includes(operation.kind));
      const playerAllowed = ["shore-duty", "return-to-ship"].includes(operation.type) ? holding.gm?.playersCanEditResidents === true
        : holding.gm?.playersCanManageShips === true && playerOperation;
      if (!user.isGM && (holding.visibility === "gm" || !playerAllowed)) fail("Нет права на эту операцию корабля.", COMMAND_ERROR.FORBIDDEN);
      const prior = findHoldingOperation(holding, operation.operationId);
      if (prior) {
        if (prior.type !== "ship-operation" || prior.payload.signature !== signature || prior.payload.userId !== userId) fail("Этот ID уже использован другой операцией.", COMMAND_ERROR.CONFLICT);
        return skip({ ...prior.payload.result, replay: true });
      }
      if (operation.expectedRevision !== data.meta.revision) fail("Данные изменились. Проверьте рейс и повторите отправку.", COMMAND_ERROR.CONFLICT);
      const ships = holding.special?.ships;
      if (!ships || !Array.isArray(ships.list)) fail("Данные кораблей повреждены.");
      let ship = null;
      let payload;
      if (operation.type === "create-profile") {
        const profile = getShipProfile(operation.profileId || "merchant-barque");
        ship = createShipRecord(`ship-${operation.operationId}`);
        ship.name = operation.shipName || profile.label;
        ship.speedKmPerDay = profile.speedKmPerDay;
        ship.crewTarget = profile.crewTarget;
        ship.capacityLoadPoints = profile.capacityLoadPoints;
        ship.cargoTonnes = profile.cargoTonnes;
        if (ship.name === "Магнифик") {
          ship.commanderName = "Элина Траззмар";
          ship.hiddenCapacityLoadPoints = 200;
          ship.traits = ["Тайники"];
        }
        ships.list.push(ship);
        const clockQd = holding.gm?.calendaria?.lastQd ?? 0;
        payload = initializeWorldShip(holding, ship, { profileId: profile.id, clockQd });
        if (isMagnifiqueShip(ship)) {
          payload = { ...payload, crewRoster: installMagnifiqueCrewRoster(holding, ship, { clockQd }) };
        }
        configureWorldShipEconomy(data, holding, ship);
      } else if (operation.type === "generate") {
        const period = Math.floor(Math.max(0, Number(holding.gm?.calendaria?.lastQd ?? 0)) / 40);
        if (ships.offerPeriod !== null && ships.offerPeriod !== undefined && ships.offerPeriod !== ""
          && Number.isFinite(Number(ships.offerPeriod)) && Number(ships.offerPeriod) >= period) {
          fail("Предложения этого периода уже подготовлены.", COMMAND_ERROR.CONFLICT);
        }
        const eligible = ships.list.filter((candidate) => candidate?.navigationMode !== "world" && candidate?.status === "docked" && candidate?.condition === "ready" && !candidate?.activeVoyage);
        const configured = eligible.filter((candidate) => {
          try { quoteShipDeparture(candidate); return true; }
          catch (_error) { return false; }
        });
        if (configured.length > MAX_OFFERS_PER_PERIOD / 4) fail("Слишком много готовых кораблей для одной подборки предложений.");
        const offers = [];
        for (const candidate of configured) {
          offers.push(...generateShipOffers(candidate, { period, random }).slice(0, MAX_OFFERS_PER_PERIOD - offers.length));
        }
        if (!offers.length) fail("Нет готовых кораблей с заполненными условиями рейса.");
        ships.offers = [...(ships.offers ?? []).filter((row) => row?.mode === "world" && Number(row?.period) >= period - 2), ...offers];
        ships.offerPeriod = period;
        payload = { period, offerCount: offers.length };
      } else {
        ship = ships.list.find((row) => row.id === operation.shipId);
        if (!ship) fail("Корабль не найден.");
        if (ship.transportOrderId) fail("Корабль занят транспортным заказом. Управляйте им в окне перевозок.", COMMAND_ERROR.CONFLICT);
        const clockQd = holding.gm?.calendaria?.lastQd ?? 0;
        const shipClockQd = ship.navigationMode === "world" ? worldShipTimelineQd(holding, ship) : clockQd;
        if (ship.navigationMode === "world" && shipClockQd > clockQd) {
          fail("Дата поселения раньше времени корабля. Исправьте календарь перед новым приказом.", COMMAND_ERROR.CONFLICT);
        }
        if (["delete", "generate-world", "reroll-world", "depart-world", "depart-bundle", "return-home", "relocate-world"].includes(operation.type)
          && hasPendingOwnSale(holding, ship.id)) {
          fail("Сначала завершите продажу груза собственного корабля в порту.", COMMAND_ERROR.CONFLICT);
        }
        if (operation.type === "delete") {
          payload = removeSettlementShip(holding, ship);
        } else if (operation.type === "shore-duty") {
          if (ship.navigationMode !== "world" || ship.location?.kind !== "home" || ship.activeVoyage || ship.status === "away") fail("Направить экипаж на работу можно только когда корабль дома.", COMMAND_ERROR.CONFLICT);
          const person = (holding.people?.list ?? []).find((row) => String(row.id) === operation.residentId);
          if (!person || person.dead || isResidentAway(person) || !(ship.crewResidentIds ?? []).map(String).includes(operation.residentId)) fail("Житель не находится в составе этого экипажа дома.", COMMAND_ERROR.CONFLICT);
          person.shipAssignment = { ...(person.shipAssignment ?? {}), shipId: ship.id, away: false, shoreDuty: true };
          configureWorldShipEconomy(data, holding, ship);
          payload = { residentId: person.id, shoreDuty: true };
        } else if (operation.type === "return-to-ship") {
          if (ship.navigationMode !== "world" || ship.location?.kind !== "home" || ship.activeVoyage || ship.status === "away") fail("Вернуть члена экипажа на корабль можно только когда корабль дома.", COMMAND_ERROR.CONFLICT);
          const person = (holding.people?.list ?? []).find((row) => String(row.id) === operation.residentId);
          if (!person || person.dead || isResidentAway(person) || !(ship.crewResidentIds ?? []).map(String).includes(operation.residentId)) fail("Житель не находится в составе этого экипажа дома.", COMMAND_ERROR.CONFLICT);
          payload = returnCrewResidentToShip(holding, ship, operation.residentId);
          configureWorldShipEconomy(data, holding, ship);
        } else if (operation.type === "adopt") {
          if (ship.navigationMode === "world" || ship.status !== "docked" || ship.activeVoyage) fail("Подключить к мировому рынку можно только корабль дома без активного рейса.", COMMAND_ERROR.CONFLICT);
          payload = initializeWorldShip(holding, ship, { profileId: operation.profileId, clockQd });
          configureWorldShipEconomy(data, holding, ship);
        } else if (operation.type === "crew") {
          if (ship.navigationMode !== "world" || ship.location?.kind !== "home" || ship.activeVoyage) fail("Состав команды меняется только дома между рейсами.", COMMAND_ERROR.CONFLICT);
          const residents = new Set((holding.people?.list ?? []).filter((person) => !person?.dead).map((person) => String(person.id)));
          if (operation.crewResidentIds.some((id) => !residents.has(id))) fail("В составе команды указан отсутствующий житель.");
          const occupied = new Set((ships.list ?? []).filter((row) => row.id !== ship.id).flatMap((row) => row.crewResidentIds ?? []).map(String));
          if (operation.crewResidentIds.some((id) => occupied.has(id))) fail("Один из жителей уже связан с другим кораблём.", COMMAND_ERROR.CONFLICT);
          const previousIds = new Set((ship.crewResidentIds ?? []).map(String));
          const nextIds = new Set(operation.crewResidentIds);
          if ((holding.people?.list ?? []).some((person) => isResidentAway(person)
            && (previousIds.has(String(person.id)) || nextIds.has(String(person.id))))) {
            fail("Член команды находится вне поселения. Сначала завершите возвращение его корабля.", COMMAND_ERROR.CONFLICT);
          }
          for (const person of holding.people?.list ?? []) {
            const id = String(person.id);
            if (previousIds.has(id) && !nextIds.has(id) && person.shipAssignment?.shipId === ship.id) delete person.shipAssignment;
            if (nextIds.has(id)) {
              const alreadyShore = person.shipAssignment?.shipId === ship.id && person.shipAssignment.shoreDuty === true;
              person.shipAssignment = { ...(person.shipAssignment ?? {}), shipId: ship.id, away: false };
              if (alreadyShore || hasResidentSettlementWork(person, holding)) person.shipAssignment.shoreDuty = true;
              else delete person.shipAssignment.shoreDuty;
            }
          }
          ship.crewResidentIds = [...operation.crewResidentIds];
          payload = { crewResidentIds: [...operation.crewResidentIds], crewCount: operation.crewResidentIds.length };
          configureWorldShipEconomy(data, holding, ship);
        } else if (operation.type === "install-magnifique-crew") {
          payload = installMagnifiqueCrewRoster(holding, ship, { clockQd });
          configureWorldShipEconomy(data, holding, ship);
        } else if (["generate-world", "reroll-world"].includes(operation.type)) {
          if (ship.navigationMode !== "world") fail("Корабль не подключён к мировому рынку.");
          assertRenderedLocation(operation, ship);
          const period = Math.floor(Math.max(0, Number(shipClockQd)) / 40);
          const lockKey = worldLockKey(ship, period);
          const reroll = operation.type === "reroll-world";
          pruneWorldLocks(holding, Math.floor(Math.max(0, Number(clockQd)) / 40), reroll ? lockKey : "");
          if (ships.worldOfferLocks[lockKey] && !reroll) fail("Предложения этого порта на текущий период уже подготовлены.", COMMAND_ERROR.CONFLICT);
          const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId] });
          configureWorldShipEconomy(data, holding, ship, { context });
          const offers = generateWorldShipOffers(data, holding, ship, { period, random, context });
          // Fresh identities prevent an old open offer from accepting a different
          // contract after the GM refreshes this port's board.
          if (reroll) offers.forEach((offer, index) => { offer.id = `reroll-${stableDataHash(operation.operationId)}-${stableDataHash([operation.operationId, ship.id])}-${index}`; });
          const offerPeriods = new Map(ships.list.map((candidate) => [candidate.id, Math.floor(worldShipTimelineQd(holding, candidate) / 40)]));
          const retainedOffers = (ships.offers ?? []).filter((row) => {
            if (row?.consumedBy) return true;
            if (Number(row?.period) < (offerPeriods.get(row?.shipId) ?? period) - 2) return false;
            return !reroll || row?.mode !== "world" || row.shipId !== ship.id
              || String(row.from?.kind ?? "") !== String(ship.location?.kind ?? "")
              || String(row.from?.id ?? "") !== String(ship.location?.id ?? "")
              || String(row.period) !== String(period);
          });
          ships.offers = [...retainedOffers, ...offers].slice(-1000);
          ships.worldOfferLocks[lockKey] = { period, shipId: ship.id, location: { ...ship.location }, offerIds: offers.map((row) => row.id) };
          payload = { period, offerCount: offers.length, location: { ...ship.location } };
        } else if (operation.type === "depart-bundle") {
          if (ship.navigationMode !== "world") fail("Корабль не подключён к мировому рынку.");
          assertRenderedLocation(operation, ship);
          const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
          if (!readiness.ready) fail(readiness.issues.map((row) => row.message).join(" "), COMMAND_ERROR.CONFLICT);
          const period = Math.floor(Math.max(0, Number(shipClockQd)) / 40);
          const offers = operation.offerIds.map((offerId) => (ships.offers ?? []).find((row) => row?.mode === "world" && row?.id === offerId
            && row?.shipId === ship.id && String(row?.period) === String(period) && !row?.consumedBy));
          if (offers.some((offer) => !offer || offer.from?.kind !== ship.location?.kind || offer.from?.id !== ship.location?.id)) {
            fail("Один из выбранных заказов устарел или уже использован.", COMMAND_ERROR.CONFLICT);
          }
          const locations = offers.flatMap((offer) => [offer.from?.id, offer.from?.regionId, offer.to?.id, offer.to?.regionId,
            offer.contract?.pickup?.id, offer.contract?.pickup?.regionId]).filter(Boolean);
          const context = buildShipWorldContext(data, holding, { offerLocationIds: locations });
          configureWorldShipEconomy(data, holding, ship, { context });
          const pricedOffers = offers.map((offer) => repriceWorldShipOffer(data, holding, ship, offer, { context }));
          const plan = quoteWorldShipBundle(data, holding, ship, pricedOffers, { context });
          payload = departWorldShipBundle(holding, ship, { operationId: operation.operationId, plan,
            style: operation.style, budgetCopper: operation.budgetCopper, clockQd: shipClockQd });
          if (payload?.ok !== false) {
            if (ship.location?.kind === "transit" && offers[0].from?.kind === "home") embarkShipCrew(holding, ship, shipClockQd);
            const chosen = new Set(operation.offerIds);
            ships.offers = ships.offers.map((row) => chosen.has(row?.id) ? { ...row, consumedBy: payload.bundleId } : row);
            catchUpShip(holding, ship, clockQd);
          }
        } else if (operation.type === "continue-bundle") {
          assertRenderedLocation(operation, ship);
          const departureQd = Math.max(shipClockQd, Number(ship.orderBundle?.delayUntilQd ?? 0));
          if (departureQd > clockQd) fail("Задержка в порту ещё не закончилась.", COMMAND_ERROR.CONFLICT);
          ship.timelineQd = departureQd;
          payload = continueWorldShipBundle(holding, ship, { operationId: operation.operationId,
            bundleId: operation.voyageId, clockQd: departureQd });
          if (payload?.ok !== false) catchUpShip(holding, ship, clockQd);
        } else if (operation.type === "resolve-bundle") {
          assertRenderedLocation(operation, ship);
          payload = resolveWorldShipBundleStop(holding, ship, { operationId: operation.operationId,
            bundleId: operation.voyageId, random });
        } else if (operation.type === "depart-world") {
          if (ship.navigationMode !== "world") fail("Корабль не подключён к мировому рынку.");
          assertRenderedLocation(operation, ship);
          const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
          if (!readiness.ready) fail(readiness.issues.map((row) => row.message).join(" "), COMMAND_ERROR.CONFLICT);
          const period = Math.floor(Math.max(0, Number(shipClockQd)) / 40);
          const offer = (ships.offers ?? []).find((row) => row?.mode === "world" && row?.id === operation.offerId
            && row?.shipId === ship.id && String(row?.period) === String(period) && !row?.consumedBy);
          if (!offer || String(offer.from?.kind ?? "") !== String(ship.location?.kind ?? "") || String(offer.from?.id ?? "") !== String(ship.location?.id ?? "")) {
            fail("Предложение устарело, уже использовано или относится к другому порту.", COMMAND_ERROR.CONFLICT);
          }
          const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId, offer.to?.id, offer.to?.regionId] });
          configureWorldShipEconomy(data, holding, ship, { context });
          const pricedOffer = repriceWorldShipOffer(data, holding, ship, offer, { context });
          payload = departWorldShip(holding, ship, { operationId: operation.operationId, offer: pricedOffer, style: operation.style, budgetCopper: operation.budgetCopper, clockQd: shipClockQd });
          if (payload?.ok !== false) {
            if (offer.from?.kind === "home") embarkShipCrew(holding, ship, shipClockQd);
            ships.offers = ships.offers.map((row) => row?.id === offer.id ? { ...row, consumedBy: payload?.voyageId ?? operation.operationId } : row);
            catchUpShip(holding, ship, clockQd);
          }
        } else if (operation.type === "return-home") {
          if (ship.navigationMode !== "world") fail("Корабль не подключён к мировому рынку.");
          assertRenderedLocation(operation, ship);
          const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId] });
          configureWorldShipEconomy(data, holding, ship, { context });
          const offer = quoteWorldShipReturn(data, holding, ship, { context });
          payload = departWorldShip(holding, ship, { operationId: operation.operationId, offer, style: "normal", budgetCopper: null, clockQd: shipClockQd });
          if (payload?.ok !== false) catchUpShip(holding, ship, clockQd);
        } else if (operation.type === "relocate-world") {
          if (ship.navigationMode !== "world") fail("Корабль не подключён к мировому рынку.");
          assertRenderedLocation(operation, ship);
          const readiness = shipCrewReadiness(holding, ship, { catalog: data.catalog });
          if (!readiness.ready) fail(readiness.issues.map((row) => row.message).join(" "), COMMAND_ERROR.CONFLICT);
          const context = buildShipWorldContext(data, holding, { offerLocationIds: [ship.location?.id, ship.location?.regionId] });
          configureWorldShipEconomy(data, holding, ship, { context });
          const offer = quoteWorldShipRelocation(data, holding, ship, operation.destinationId, { context });
          payload = departWorldShip(holding, ship, { operationId: operation.operationId, offer, style: "normal", budgetCopper: null, clockQd: shipClockQd });
          if (payload?.ok !== false) {
            if (offer.from.kind === "home") embarkShipCrew(holding, ship, shipClockQd);
            catchUpShip(holding, ship, clockQd);
          }
        } else if (operation.type === "resolve-world") {
          if (ship.navigationMode !== "world" || ship.activeVoyage?.id !== operation.voyageId || ship.activeVoyage?.awaitingOutcome !== true) fail("Рейс ещё не ожидает подведения итогов.", COMMAND_ERROR.CONFLICT);
          payload = resolveWorldShip(holding, ship, { operationId: operation.operationId, random });
          if (payload.returned) disembarkShipCrew(holding, ship, payload.returned.arrivedAtQd);
          if (!payload.pending && payload.delayQd > 0) catchUpShip(holding, ship, clockQd);
        } else if (operation.type === "depart") {
          if (ship.navigationMode === "world") fail("Для этого корабля выберите заказ мирового рынка.", COMMAND_ERROR.CONFLICT);
          const currentPeriod = Math.floor(Math.max(0, Number(holding.gm?.calendaria?.lastQd ?? 0)) / 40);
          const offer = operation.offerId
            ? (ships.offers ?? []).find((row) => row?.id === operation.offerId && row?.shipId === ship.id && String(row?.period) === String(currentPeriod) && !row?.consumedBy)
            : null;
          if (operation.offerId && !offer) fail("Предложение устарело или уже использовано.", COMMAND_ERROR.CONFLICT);
          payload = departShip(holding, ship, { ...operation, clockQd, offer, style: operation.style });
          if (offer) ships.offers = ships.offers.map((row) => row?.id === offer.id ? { ...row, consumedBy: payload.voyageId ?? operation.operationId } : row);
        } else if (operation.type === "adjust") {
          if (ship.navigationMode === "world") {
            assertRenderedLocation(operation, ship);
            payload = adjustWorldShipFunds(holding, ship, { ...operation, voyageId: operation.voyageId || null, clockQd });
          } else payload = adjustShipFunds(holding, ship, operation);
        } else {
          if (ship.navigationMode === "world") fail("Для этого корабля используется итог мирового рейса.", COMMAND_ERROR.CONFLICT);
          if (ship.activeVoyage?.id !== operation.voyageId || ship.activeVoyage?.awaitingOutcome !== true) fail("Рейс ещё не ожидает подведения итогов.", COMMAND_ERROR.CONFLICT);
          payload = resolveShipContract(holding, ship, { operationId: operation.operationId, random });
        }
      }
      const response = worldResponse(operation, payload);
      appendHoldingOperation(holding, {
        operationId: operation.operationId, type: "ship-operation", createdAt: new Date().toISOString(),
        title: response.ok === false ? `Приказ корабля не выполнен: ${ship.name}`
          : operation.type === "shore-duty" ? `Член экипажа направлен на работу в поселении: ${ship.name}`
          : operation.type === "return-to-ship" ? `Член экипажа вернулся на корабль: ${ship.name}`
          : operation.type === "reroll-world" ? `Обновлены заказы корабля: ${ship.name}`
          : ["generate", "generate-world"].includes(operation.type) ? "Подготовлены корабельные предложения"
          : operation.type === "delete" ? `Удалён корабль: ${ship.name}`
          : operation.type === "create-profile" ? `Добавлен корабль: ${ship.name}`
            : operation.type === "adopt" ? `Корабль подключён к мировому рынку: ${ship.name}`
              : operation.type === "install-magnifique-crew" ? `Добавлена команда «Магнифика»: ${payload.total} человек`
              : operation.type === "crew" ? `Обновлена команда: ${ship.name}`
                : ["depart", "depart-world", "depart-bundle", "continue-bundle", "return-home", "relocate-world"].includes(operation.type) ? `Отправлен корабль: ${ship.name}`
                  : ["resolve", "resolve-world", "resolve-bundle"].includes(operation.type) ? `Подведён итог рейса: ${ship.name}` : `Бортовая казна: ${ship.name}`,
        summary: operation.reason, payload: { signature, userId, result: response }
      });
      return response;
    }, { fallback: false, reason: `ship-${operation.type}` });
    if (!result) fail("Поселение не найдено.");
    return result;
  };
}

export const executeShipOperation = createShipOperationExecutor();
