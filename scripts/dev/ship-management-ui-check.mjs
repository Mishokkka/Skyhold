import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareShipsContext, prepareShipWindowContext } from "../apps/ships-context.js";
import { shipNavigationTarget, navigateFromShip } from "../apps/domains/ship-navigation.js";
import { focusMarketOutboundOrder } from "../apps/market/outbound-focus.js";
import { previewShipOrders, withShipOrderBudget } from "../engines/ships/order-preview.js";
import { generateWorldShipOffers } from "../engines/ships/world-market.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";
import { SkyholdData } from "../data/store.js";
import { registerSkyholdAppClass } from "../apps/registry.js";

function fixture() {
  const result = worldMarketFixture();
  result.holding.visibility = "public";
  result.holding.gm.playersCanManageShips = true;
  result.ship.id = "management-ship";
  result.ship.name = "Проверка";
  result.ship.crewTarget = 1;
  return result;
}

function user({ gm = true, allowed = true, online = true } = {}, holding) {
  holding.gm.playersCanManageShips = allowed;
  globalThis.game = { user: { id: gm ? "gm" : "player", isGM: gm },
    users: online ? [{ id: "gm", isGM: true, active: true }] : [], socket: { emit() {} } };
}

function freeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

function parity(f, expected) {
  const before = JSON.stringify(f.data);
  freeze(f.data);
  const overview = prepareShipsContext(f.holding, { data: f.data }).rows[0];
  const detail = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
  assert.equal(overview.statusLabel, detail.statusLabel);
  assert.equal(overview.nextAction, detail.nextAction);
  assert.equal(overview.permissionReason, detail.permissionReason);
  assert.match(detail.nextAction, expected);
  assert.equal(JSON.stringify(f.data), before, "presentation must not settle bills or repair a state");
  return { overview, detail };
}

for (const gm of [true, false]) {
  let f = fixture(); user({ gm }, f.holding);
  f.holding.special.ships.worldOfferLocks = { [`${f.ship.id}|home:${f.holding.id}|0`]: { period: 0, shipId: f.ship.id } };
  const empty = parity(f, /дождаться следующей декады/);
  assert.equal(empty.detail.canGenerateWorld, false);

  f = fixture(); user({ gm }, f.holding);
  f.ship.location = { kind: "market", id: "a", regionId: "a", label: "Порт А" };
  f.ship.status = "away";
  f.holding.special.market.outbound.orders = [{ id: "sale", ownShipId: f.ship.id, status: "needsResolution", cargo: [], revenueCopper: 1000 }];
  const sale = parity(f, /решение ГМа/);
  assert.equal(sale.detail.statusLabel, "Ожидает исхода продажи");
  assert.equal(sale.detail.canGenerateWorld, false);
  assert.equal(sale.detail.canReturnHome, false);
  assert.deepEqual(shipNavigationTarget(f.data, f.holding.id, f.ship.id, { sale: true }), { holdingId: f.holding.id, outboundOrderId: "sale" });

  f = fixture(); user({ gm }, f.holding);
  f.ship.location = { kind: "market", id: "a", regionId: "a", label: "Порт А" };
  f.ship.orderBundle = { id: "bundle", status: "at-port", orders: [], stops: [], nextStopIndex: 0, delayUntilQd: 20, totalOperatingCopper: 0 };
  const delay = parity(f, /окончания задержки/);
  assert.equal(delay.detail.statusLabel, "Задержан в порту");
  assert.equal(delay.detail.canContinueBundle, false);
}

for (const [allowed, online, reason] of [[false, true, /не разрешил/], [true, false, /активный ГМ/], [true, true, /^$/]]) {
  const f = fixture(); user({ gm: false, allowed, online }, f.holding);
  f.holding.gm.playersCanEditResidents = allowed;
  const { detail } = parity(f, /предложения/);
  assert.match(detail.permissionReason, reason);
  assert.match(detail.residentPermissionReason, !allowed ? /отдельное разрешение/ : !online ? /активный ГМ/ : /^$/);
}

{
  const f = fixture(); user({}, f.holding);
  f.ship.navigationMode = "";
  f.ship.activeVoyage = { awaitingOutcome: true };
  assert.equal(prepareShipsContext(f.holding, { data: f.data }).rows[0].statusLabel, "Ожидает итога", "legacy voyage labels must be preserved");
}

{
  const f = fixture(); user({}, f.holding);
  f.ship.crewTarget = 36; f.ship.crewResidentIds = [];
  const { overview, detail } = parity(f, /предложения/);
  assert.equal(overview.abstractCrewCount, 36);
  assert.equal(detail.readiness.warnings[0].code, "abstract-crew");
}

{
  const f = fixture(); user({}, f.holding);
  f.ship.attentionByDirection = { "port:a": { level: 3 }, "port:removed": { level: 2 } };
  const detail = prepareShipWindowContext(f.holding, { data: f.data, shipId: f.ship.id }).rows[0];
  assert.equal(detail.attentionRecords[0].direction, "a");
  assert.equal(detail.attentionRecords[1].direction, "Неизвестный порт");
  assert.equal(detail.crewRoster[0].canOpenResident, true);
}

{
  const f = fixture(); user({}, f.holding);
  f.holding.special.ships.offers = generateWorldShipOffers(f.data, f.holding, f.ship, { period: 0, random: () => 0.4 });
  assert.ok(f.holding.special.ships.offers.length);
  const before = JSON.stringify(f.data);
  for (const style of ["normal", "cautious", "bold"]) {
    const plan = previewShipOrders(f.data, f.holding, f.ship, { offerIds: [f.holding.special.ships.offers[0].id], style });
    assert.equal(plan.nominalExitCopper, plan.rewardCopper - plan.totalOperatingCopper - plan.returnReserveCopper);
    assert.equal(plan.settlementWithdrawalCopper, plan.transferCopper + plan.homeDebtCopper);
    const custom = withShipOrderBudget(plan, plan.recommendedBudgetCopper + 123);
    assert.equal(custom.settlementWithdrawalCopper, custom.transferCopper + custom.homeDebtCopper);
    assert.equal(custom.nominalExitCopper, plan.nominalExitCopper, "moving a budget is not an expense");
  }
  assert.equal(JSON.stringify(f.data), before);
}

{
  const f = fixture(); user({ gm: false, allowed: false, online: false }, f.holding);
  f.holding.people.list[0].shipAssignment = { shipId: f.ship.id, away: false, shoreDuty: true };
  const before = JSON.stringify(f.data);
  assert.equal(shipNavigationTarget(f.data, f.holding.id, f.ship.id, { residentId: "sailor" }).peopleTab, "living");
  assert.deepEqual(shipNavigationTarget(f.data, f.holding.id, f.ship.id, { market: true }), { holdingId: f.holding.id, ownShipId: f.ship.id });
  f.holding.people.list[0].shipAssignment = { shipId: f.ship.id, away: false };
  assert.equal(shipNavigationTarget(f.data, f.holding.id, f.ship.id, { residentId: "sailor" }).peopleTab, "ship-crew");
  f.holding.people.list[0].shipAssignment = { shipId: f.ship.id, away: false, shoreDuty: true };
  assert.throws(() => shipNavigationTarget(f.data, f.holding.id, f.ship.id, { residentId: "other" }), /не входит/);
  assert.throws(() => shipNavigationTarget(f.data, f.holding.id, f.ship.id, { sale: true }), /завершена/);
  f.holding.visibility = "gm";
  assert.throws(() => shipNavigationTarget(f.data, f.holding.id, f.ship.id, { residentId: "sailor" }), /недоступно/);
  f.holding.visibility = "public";
  assert.equal(JSON.stringify(f.data), before);
  const originalView = SkyholdData.view;
  const log = [];
  const manager = { residentFilters: { work: "old" }, element: { querySelectorAll: () => [{ dataset: { id: "sailor" },
    scrollIntoView: () => log.push("scroll"), querySelector: () => ({ focus: () => log.push("focus") }) }] },
  render: async () => { log.push("render"); } };
  class Manager { static instance = manager; }
  registerSkyholdAppClass(Manager);
  SkyholdData.view = () => f.data;
  freeze(f.data);
  try {
    await navigateFromShip({ holdingId: f.holding.id, shipId: f.ship.id }, { preventDefault() {},
      currentTarget: { dataset: { action: "ship-open-resident", residentId: "sailor" } } });
    assert.equal(manager.activeHoldingId, f.holding.id);
    assert.equal(manager.activeTab, "people");
    assert.equal(manager.residentFilters.search, "Матрос");
    assert.deepEqual(log, ["render", "scroll", "focus"]);
    assert.equal(JSON.stringify(f.data), before, "read-only navigation works without a GM and cannot write world data");
  } finally { SkyholdData.view = originalView; registerSkyholdAppClass(null); }
}

{
  const log = [];
  const disclosure = { tagName: "DETAILS", open: false, parentElement: null };
  const row = { dataset: { marketOutboundOrder: 'sale:"[]' }, parentElement: disclosure,
    scrollIntoView: () => log.push("scroll"), focus: () => log.push("focus") };
  const root = { contains: () => true, querySelectorAll: () => [row], querySelector: () => row };
  assert.equal(focusMarketOutboundOrder(root, 'sale:"[]'), true, "ids must not be interpolated into selectors");
  assert.equal(disclosure.open, true);
  assert.deepEqual(log, ["scroll", "focus"]);
  assert.equal(focusMarketOutboundOrder(root, "missing"), false);
  assert.equal(focusMarketOutboundOrder(root, ""), true);
}

globalThis.foundry = { applications: { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: (Base) => Base } } };
const { SkyholdMarketApp } = await import("../apps/market-app.js");
class TestMarket extends SkyholdMarketApp { render() { return Promise.resolve(this); } }
{
  const existing = new TestMarket({ holdingId: "holding" });
  existing.quantities = { purchase: 3 }; existing.outboundQuantities = { cargo: 4 }; existing.marketId = "b"; existing.ownShipId = "other";
  TestMarket.instances.set("holding", existing);
  assert.equal(TestMarket.open({ holdingId: "holding", outboundOrderId: "sale" }), existing);
  assert.equal(existing._focusOutboundOrderId, "sale");
  assert.equal(existing.ownShipId, "other");
  assert.equal(existing.marketId, "b");
  assert.deepEqual(existing.quantities, { purchase: 3 });
  assert.deepEqual(existing.outboundQuantities, { cargo: 4 });
  TestMarket.open({ holdingId: "holding", ownShipId: "selected" });
  assert.equal(existing.ownShipId, "selected");
  assert.equal(existing._focusOutboundOrderId, "", "a newer navigation request replaces an older pending target");
  assert.equal(existing._focusOutbound, true);
  TestMarket.instances.clear();
}

const preview = readFileSync("templates/parts/ship-window/order-preview.hbs", "utf8");
assert.ok(preview.indexOf("nominalExitCopper") < preview.indexOf("data-ship-plan-details"), "full nominal result must be visible before the disclosures");
assert.ok(preview.indexOf("settlementWithdrawalCopper") < preview.indexOf("data-ship-plan-details"));
assert.match(readFileSync("templates/parts/ship-window/crew.hbs", "utf8"), /readiness\.warnings/);
console.log("Ship management UI: GM/player state parity, empty boards, sales, delays, permissions, full-exit budget, read-only links and preserved market drafts passed.");
