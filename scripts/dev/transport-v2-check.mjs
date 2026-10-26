import assert from "node:assert/strict";
import { cargoLoad, shipTransportFunding, transportLoad } from "../engines/transport/quantities.js";
import { findTransportPlans, planTransportChain, validateTransportPlan } from "../engines/transport/planner.js";

const lot = (qty = 4000) => [{ lotId: "ore-1", resourceId: "ore", qty, unitLoad: transportLoad(1), unitCopper: 5, ageQd: 17 }];
const service = (id, from, to, capacity, extra = {}) => ({ id, label: id, kind: "charter", from, to,
  capacity: transportLoad(capacity), travelQd: 4, returnQd: 4, vehicles: 10, dispatchCopper: 100, ...extra });
const services = [service("ship", "A", "B", 4000), service("caravan", "B", "C", 400), service("train", "C", "D", 6000)];
const plan = planTransportChain({ cargo: lot(), services });
assert.deepEqual(plan.stages.map((stage) => stage.runs.length), [1, 10, 1]);
assert.equal(plan.totalCopper, 1200, "one ship + ten caravans + one train");
for (const stage of plan.stages) {
  assert.equal(stage.runs.flatMap((run) => run.cargo).reduce((sum, row) => sum + row.qty, 0), 4000);
  assert.equal(stage.runs.flatMap((run) => run.cargo).every((row) => row.lotId === "ore-1" && row.ageQd === 17), true);
}
assert.equal(validateTransportPlan(plan, { services }).totalCopper, 1200);
assert.throws(() => validateTransportPlan(plan, { services: services.map((row) => ({ ...row, dispatchCopper: 200 })) }), /изменились/);
const regular = service("daily", "A", "B", 100, { kind: "regular", firstQd: 4, intervalQd: 4 });
const first = planTransportChain({ cargo: lot(60), services: [regular] });
const second = planTransportChain({ cargo: lot(60), services: [regular], runs: first.stages[0].runs });
assert.deepEqual(second.stages[0].runs.map((run) => run.cargo[0].qty), [40, 20]);
assert.deepEqual(second.stages[0].runs.map((run) => run.departureQd), [4, 8]);
const oneVehicle = service("one", "A", "B", 10, { vehicles: 1 });
assert.deepEqual(planTransportChain({ cargo: lot(20), services: [oneVehicle] }).stages[0].runs.map((run) => run.departureQd), [0, 8]);
const own = service("own", "A", "B", 10, { kind: "owned", shipId: "s1", vehicles: 1 });
const ownPlan = planTransportChain({ cargo: lot(20), services: [own] });
assert.equal(ownPlan.arrivalQd, 12);
assert.equal(ownPlan.shipReleaseQd, 12);
assert.equal(ownPlan.shipReleaseLocation, "B");
const returnPlan = planTransportChain({ cargo: lot(20), services: [{ ...own, returnAtEnd: true }] });
assert.equal(returnPlan.arrivalQd, 12);
assert.equal(returnPlan.shipReleaseQd, 16);
assert.equal(returnPlan.shipReleaseLocation, "A");
assert.deepEqual(shipTransportFunding({ expensesCopper: 300, reserveCopper: 100, onboardCopper: 150 }), {
  expensesCopper: 300, reserveCopper: 100, requiredCopper: 400, fromShipCopper: 150, treasuryCopper: 250
});
assert.equal(transportLoad(0.00025), 1);
assert.throws(() => transportLoad(0.00001), /точности/);
assert.equal(cargoLoad(lot(5)), 20000);
const slower = service("slow", "A", "B", 100, { dispatchCopper: 10, travelQd: 20 });
assert.equal(findTransportPlans({ from: "A", to: "B", cargo: lot(5), services: [regular, slower] }).plans[0].stages[0].service.id, "slow");
assert.equal(findTransportPlans({ from: "A", to: "B", cargo: lot(5), services: [regular, slower], priority: "time" }).plans[0].stages[0].service.id, "daily");
assert.equal(findTransportPlans({ from: "A", to: "B", cargo: lot(5), services: [regular, slower], pins: { A: "daily" } }).plans[0].stages[0].service.id, "daily");
assert.throws(() => planTransportChain({ cargo: lot(5), services: [regular, service("broken", "C", "D", 10)] }), /Разрыв/);
assert.throws(() => planTransportChain({ cargo: [{ ...lot(1)[0], unitLoad: transportLoad(101) }], services: [regular] }), /единица/);
assert.equal(findTransportPlans({ from: "A", to: "B", cargo: lot(5), ownShipId: "s1", maxPaths: 2,
  services: [...Array.from({ length: 300 }, (_, i) => ({ ...regular, id: `hired-${i}` })), own] }).plans[0]?.ownShipId, "s1",
"hired-only candidates cannot exhaust the search before the explicitly requested own ship is considered");
console.log("transport-v2: physical stages, shared slots, finite charter fleet, owned shuttles, funding, precision and independent confirmation passed");
