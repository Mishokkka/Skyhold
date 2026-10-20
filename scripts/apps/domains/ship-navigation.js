import { SkyholdData } from "../../data/store.js";
import { findReadableHoldingEntry } from "../../data/access-guard.js";
import { isResidentRestingOnShip } from "../../data/resident-presence.js";
import { getSkyholdAppClass } from "../registry.js";
import { rememberApplicationFocusReturn } from "../common/window-focus-keeper.js";

/** Resolve stable references again at click time; navigation never writes world data. */
export function shipNavigationTarget(data, holdingId, shipId, { residentId = "", sale = false, market = false } = {}) {
  const { holding } = findReadableHoldingEntry(data, holdingId, { fallback: false });
  const ship = holding?.special?.ships?.list?.find((row) => String(row.id) === String(shipId));
  if (!ship) throw new Error("Корабль больше не найден или владение недоступно.");
  if (market) {
    if (ship.location?.kind !== "home" || ship.activeVoyage || ship.orderBundle) throw new Error("Продажа складского груза доступна кораблю дома между рейсами.");
    return { holdingId: holding.id, ownShipId: ship.id };
  }
  if (sale) {
    const order = (holding.special?.market?.outbound?.orders ?? []).find((row) => row.ownShipId === ship.id
      && !["delivered", "lost", "cancelled"].includes(row.status));
    if (!order) throw new Error("Продажа уже завершена. Обновите окно корабля.");
    return { holdingId: holding.id, outboundOrderId: order.id };
  }
  if (!(ship.crewResidentIds ?? []).some((id) => String(id) === String(residentId))) throw new Error("Житель больше не входит в экипаж этого корабля.");
  const person = holding.people?.list?.find((row) => String(row.id) === String(residentId));
  if (!person || person.dead) throw new Error("Житель больше недоступен в списке действующего экипажа.");
  return { holdingId: holding.id, residentId: person.id, search: person.name || "",
    peopleTab: isResidentRestingOnShip(person, holding) ? "ship-crew" : "living" };
}

export async function navigateFromShip(app, event) {
  event.preventDefault();
  const button = event.currentTarget;
  try {
    const target = shipNavigationTarget(SkyholdData.view(), app.holdingId, app.shipId, {
      sale: button.dataset.action === "ship-open-sale", market: button.dataset.action === "ship-open-market", residentId: button.dataset.residentId
    });
    if (target.outboundOrderId || target.ownShipId) {
      const { openMarketApp } = await import("../lazy-apps.js");
      const market = await openMarketApp(target);
      rememberApplicationFocusReturn(market, button);
      return market;
    }
    const Manager = getSkyholdAppClass();
    if (!Manager) throw new Error("Менеджер поселения недоступен.");
    if (!Manager.instance) await Manager.open();
    const manager = Manager.instance;
    if (!manager) throw new Error("Не удалось открыть менеджер поселения.");
    manager.activeHoldingId = target.holdingId;
    manager.activeTab = "people";
    manager.activePeopleTab = target.peopleTab;
    manager.residentFilters = { search: target.search, type: "all", work: "all", home: "all", morale: "all" };
    await manager.render({ force: true, focus: true });
    const row = [...(manager.element?.querySelectorAll?.(".fbls-person-row[data-id]") ?? [])]
      .find((node) => node.dataset.id === String(target.residentId));
    row?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const control = row?.querySelector?.("button, input, select") ?? manager.element?.querySelector?.("[data-resident-filter='search']");
    control?.focus?.({ preventScroll: true });
  } catch (error) {
    globalThis.ui?.notifications?.warn?.(error.message || "Не удалось открыть связанную запись.");
  }
}
