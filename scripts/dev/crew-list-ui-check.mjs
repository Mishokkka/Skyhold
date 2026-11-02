import assert from "node:assert/strict";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { ResidentEventDomain } from "../apps/domains/events/resident-events.js";
import { SkyholdData } from "../data/store.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

const { data, holding, ship } = worldMarketFixture();
const sailor = holding.people.list[0];
holding.people.list.push({ id: "resident", name: "Житель" }, { id: "dead", dead: true });
const tabs = () => ResidentDomain._preparePeopleTabs.call({ activePeopleTab: "ship-crew" }, holding);
assert.deepEqual(tabs().map(({ id, count }) => [id, count]), [["living", 1], ["ship-crew", 1]]);
assert.equal(ResidentDomain._homeLabel(sailor, holding), ship.name);
const ui = { ...ResidentEventDomain, _canManagePeople: () => true, activeHoldingId: holding.id };
assert.equal(ui._canReturnResidentToShip(sailor, holding), false, "resting crew is already aboard");
sailor.shipAssignment = { shipId: ship.id, away: false, shoreDuty: true };
assert.deepEqual(tabs().map(({ id, count }) => [id, count]), [["living", 2]]);
assert.equal(ui._canReturnResidentToShip(sailor, holding), true, "shore-duty crew can return even before receiving a job");
assert.equal(ui._canReturnResidentToShip(holding.people.list[1], holding), false);
assert.equal(ui._canReturnResidentToShip({ ...sailor, dead: true }, holding), false);
assert.equal(ui._canReturnResidentToShip({ ...sailor, shipAssignment: { shipId: ship.id, away: true } }, holding), false);
ship.activeVoyage = { id: "flight" };
assert.equal(ui._canReturnResidentToShip(sailor, holding), false);
ship.activeVoyage = null;
ship.transportOrderId = "transport-returned-awaiting-payment";
assert.equal(ui._canReturnResidentToShip(sailor, holding), false, "a physically returned ship still needs to complete its transport assignment");
delete ship.transportOrderId;
ui._canManagePeople = () => false;
assert.equal(ui._canReturnResidentToShip(sailor, holding), false);
ui._canManagePeople = () => true;

const previousGet = SkyholdData.get;
let forwarded = null;
try {
  SkyholdData.get = () => data;
  ui._onCrewShoreDuty = async (event, type) => { forwarded = { ...event.currentTarget.dataset, type }; };
  await ui._executeResidentContextAction(sailor.id, "return-to-ship");
  assert.deepEqual(forwarded, { residentId: sailor.id, shipId: ship.id, holdingId: holding.id, revision: data.meta.revision, type: "return-to-ship" });
} finally { SkyholdData.get = previousGet; }
console.log("Crew list: counts, ship housing label, return action eligibility and authority command routing passed.");
