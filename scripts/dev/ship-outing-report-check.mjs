import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  beginShipOuting,
  completeShipOutingLeg,
  ensurePartialShipOuting,
  planShipOutingLeg,
  recordShipOutingFunds,
  SHIP_OUTING_DETAIL_LIMIT
} from "../engines/ships/outing-report.js";

function voyage(id, from, to, startedAtQd, { operating = 100, preparation = 0, reward = 200, durationQd = 4 } = {}) {
  return {
    id,
    startedAtQd,
    quote: {
      from: { kind: from === "Дом" ? "home" : "market", id: from, label: from },
      to: { kind: to === "Дом" ? "home" : "market", id: to, label: to },
      operatingCopper: operating,
      preparationCopper: preparation,
      rewardCopper: reward,
      durationQd
    }
  };
}

function summary(leg, arrivedAtQd, returnedCopper = 0) {
  return { id: leg.id, from: leg.quote.from, to: leg.quote.to, arrivedAtQd, returnedCopper };
}

export function checkShipOutingReport() {
  const ship = {};
  const legA = voyage("leg-a", "Дом", "A", 0, { operating: 200, preparation: 50, reward: 500, durationQd: 8 });
  const legB = voyage("leg-b", "A", "B", 12, { operating: 120, reward: 350, durationQd: 4 });
  const home = voyage("leg-home", "B", "Дом", 20, { operating: 80, reward: 0, durationQd: 4 });

  const first = beginShipOuting(ship, { voyageId: legA.id, clockQd: 0, budgetCopper: 1_000, preparationCopper: 50 });
  assert.equal(first.fundingCopper, 1_050);
  assert.equal(beginShipOuting(ship, { voyageId: legA.id, clockQd: 0, budgetCopper: 1_000, preparationCopper: 50 }), first, "repeated begin must preserve the active report");
  recordShipOutingFunds(ship, { id: "leg-a", kind: "depart", externalDeltaCopper: -50, transferToShipCopper: 1_000 }, { clockQd: 0, reason: "Подготовка" });
  planShipOutingLeg(ship, legA);
  planShipOutingLeg(ship, legA);
  recordShipOutingFunds(ship, { id: "leg-a:operating", kind: "expense", externalDeltaCopper: -200, transferToShipCopper: 0 }, { clockQd: 0, reason: "Расходы пути" });
  recordShipOutingFunds(ship, { id: "leg-a:reward", kind: "income", externalDeltaCopper: 500, transferToShipCopper: 0 }, { clockQd: 8, reason: "Оплата заказа" });
  completeShipOutingLeg(ship, summary(legA, 8));

  recordShipOutingFunds(ship, { id: "idle-a", kind: "expense", externalDeltaCopper: -30, transferToShipCopper: 0 }, { clockQd: 12, reason: "Стоянка A", category: "port" });
  planShipOutingLeg(ship, legB);
  recordShipOutingFunds(ship, { id: "leg-b:operating", kind: "expense", externalDeltaCopper: -120, transferToShipCopper: 0 }, { clockQd: 12, reason: "Расходы пути" });
  recordShipOutingFunds(ship, { id: "leg-b:reward", kind: "income", externalDeltaCopper: 350, transferToShipCopper: 0 }, { clockQd: 16, reason: "Оплата заказа" });
  completeShipOutingLeg(ship, summary(legB, 16));

  recordShipOutingFunds(ship, { id: "ship:idle:market:16:20:0", kind: "expense", externalDeltaCopper: -20, transferToShipCopper: 0 }, { clockQd: 20, reason: "Стоянка B" });
  planShipOutingLeg(ship, home);
  recordShipOutingFunds(ship, { id: "leg-home:operating", kind: "expense", externalDeltaCopper: -80, transferToShipCopper: 0 }, { clockQd: 20, reason: "Возвращение" });
  recordShipOutingFunds(ship, { id: "leg-home:return", kind: "return", externalDeltaCopper: 0, transferToShipCopper: -1_400 }, { clockQd: 24, reason: "Возврат бортовой казны" });
  const completed = completeShipOutingLeg(ship, summary(home, 24, 1_400));
  assert.equal(ship.currentOuting, undefined);
  assert.equal(ship.lastOuting, completed);
  assert.deepEqual({
    funding: completed.fundingCopper,
    income: completed.incomeCopper,
    expense: completed.expenseCopper,
    port: completed.portExpenseCopper,
    returned: completed.returnedCopper,
    plannedOperating: completed.plannedOperatingCopper,
    plannedPreparation: completed.plannedPreparationCopper,
    plannedReward: completed.plannedRewardCopper,
    plannedDuration: completed.plannedDurationQd,
    started: completed.startedLegs,
    finished: completed.completedLegs
  }, {
    funding: 1_050,
    income: 850,
    expense: 500,
    port: 50,
    returned: 1_400,
    plannedOperating: 400,
    plannedPreparation: 50,
    plannedReward: 850,
    plannedDuration: 16,
    started: 3,
    finished: 3
  });
  assert.equal(completed.fundingCopper + completed.incomeCopper - completed.expenseCopper, completed.returnedCopper, "funding + external income - actual expenses must reconcile with the returned balance");
  assert.equal(completed.incomeCopper, 850, "returning onboard cash is an internal transfer, not income");

  const oldLast = structuredClone(ship.lastOuting);
  beginShipOuting(ship, { voyageId: "next", clockQd: 40, budgetCopper: 100, preparationCopper: 0 });
  assert.deepEqual(ship.lastOuting, oldLast, "starting a new outing must not replace the last completed report");
  const next = voyage("next", "Дом", "Дом", 40, { operating: 0, reward: 0, durationQd: 1 });
  planShipOutingLeg(ship, next);
  completeShipOutingLeg(ship, summary(next, 41, 100));
  assert.equal(ship.lastOuting.id, "next", "only completion at home replaces lastOuting");

  const crowded = {};
  beginShipOuting(crowded, { voyageId: "many", clockQd: 0, budgetCopper: 1_000, preparationCopper: 0 });
  const many = voyage("many", "Дом", "A", 0, { operating: 0, reward: 0, durationQd: 1 });
  planShipOutingLeg(crowded, many);
  for (let index = 0; index < 250; index += 1) {
    recordShipOutingFunds(crowded, { id: `expense-${index}`, kind: "expense", externalDeltaCopper: -1, transferToShipCopper: 0 }, { clockQd: index, reason: `Расход ${index}` });
  }
  assert.equal(crowded.currentOuting.expenseCopper, 250, "bounded details must not truncate exact aggregates");
  assert.equal(crowded.currentOuting.details.length, SHIP_OUTING_DETAIL_LIMIT);
  assert.equal(crowded.currentOuting.omittedDetails, 212);

  const legacy = { lastOuting: { version: 1, id: "older-complete" }, activeVoyage: { id: "legacy-leg" } };
  const partial = ensurePartialShipOuting(legacy, { voyageId: "tracking-start", clockQd: 100 });
  assert.equal(partial.partial, true);
  assert.equal(partial.scopeLabel, "С момента начала учёта");
  assert.equal(partial.fundingCopper, 0);
  assert.equal(partial.lastLegId, "legacy-leg");
  assert.equal(partial.startedLegs, 1, "an active legacy leg is tracked without inventing its plan values");
  assert.equal(partial.plannedOperatingCopper, 0);
  recordShipOutingFunds(legacy, { id: "legacy-income", kind: "income", externalDeltaCopper: 30, transferToShipCopper: 0 }, { clockQd: 101, reason: "Известная оплата" });
  completeShipOutingLeg(legacy, { id: "legacy-leg", from: { label: "A" }, to: { kind: "home", label: "Дом" }, arrivedAtQd: 104, returnedCopper: 30 });
  assert.equal(legacy.lastOuting.partial, true);
  assert.equal(legacy.lastOuting.startedLegs, 1);
  assert.equal(legacy.lastOuting.completedLegs, 1);
  assert.equal(legacy.lastOuting.incomeCopper, 30);
  assert.equal(legacy.lastOuting.returnedCopper, 30);

  const legacyIdle = {};
  const idlePartial = ensurePartialShipOuting(legacyIdle, { voyageId: "idle-tracking", clockQd: 120 });
  assert.equal(idlePartial.lastLegId, "", "an idle legacy ship must not invent an active leg");
  assert.equal(idlePartial.startedLegs, 0);
  const idleHome = voyage("idle-home", "A", "Дом", 121, { operating: 10, reward: 0, durationQd: 3 });
  planShipOutingLeg(legacyIdle, idleHome);
  assert.equal(legacyIdle.currentOuting.startedLegs, 1);
  completeShipOutingLeg(legacyIdle, summary(idleHome, 124, 0));
  assert.equal(legacyIdle.currentOuting, undefined);
  assert.equal(legacyIdle.lastOuting.id, "idle-tracking");
  assert.equal(legacyIdle.lastOuting.completedLegs, 1);

  return { chainLegs: completed.completedLegs, boundedDetails: crowded.currentOuting.details.length, partial: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkShipOutingReport();
  console.log("FBL Skyhold ship outing report check passed.");
}
