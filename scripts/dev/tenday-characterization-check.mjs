import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareTendayRandomEvents } from "../apps/domains/events/gm-events.js";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import { normalizeLastEventRoll } from "../data/event-automation.js";
import {
  advanceTendayClock,
  applyPreparedTenday,
  dueTendaySchedule,
  normalizeTendayQd,
  preparedTendayReplay,
  tendayDependencySnapshot
} from "../apps/domains/events/tenday-preview.js";
import { buildTendayChangeSet } from "../engines/tenday/change-set.js";
import { buildTendayOperationPayload, compactTendayRows } from "../engines/tenday/operation-payload.js";

function copy(value) {
  return structuredClone(value);
}

function hash(value) {
  return JSON.stringify(value);
}

function changeSetFixture() {
  return {
    id: "tenday-holding",
    overview: { development: { food: 1, technology: 0, culture: 0, war: 0 } },
    people: {
      list: [{
        id: "resident-1",
        name: "Раненый житель",
        dead: false,
        age: 25,
        ageGroup: "Вз",
        injuredDays: 5,
        status: "Ранен",
        attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
        traitsText: "",
        notes: ""
      }]
    },
    buildings: {
      list: [{
        id: "building-1",
        name: "Стройка",
        constructionStatus: "building",
        buildProgress: 1,
        buildTarget: 4,
        productionLines: []
      }]
    },
    storage: {
      moneyCopper: 100,
      resources: [
        { id: "food-row", resourceId: "food", name: "Пища", qty: 10, roomId: "pantry" },
        { id: "wood-row", resourceId: "wood", name: "Древесина", qty: 2, roomId: "yard" }
      ],
      items: []
    },
    special: { market: { orders: [] } },
    gm: {
      modifiers: { food: 0, technology: 0, culture: 0, war: 0, defense: 0, reputation: 0, morale: 0 },
      calendaria: { lastQd: 0, lastDateText: "" }
    }
  };
}

function checkPreparedSnapshotContract() {
  assert.equal(normalizeTendayQd(1), 40, "a tenday run must never advance by less than 40 QD");
  assert.equal(normalizeTendayQd(79), 40, "partial tendays must be normalized down to a whole tenday");
  assert.equal(normalizeTendayQd(80), 80, "multiple whole tendays must be retained");

  const clockHolding = {
    gm: {
      calendaria: { lastQd: 40 },
      eventSchedule: [
        { id: "due", status: "scheduled", dueQd: 80 },
        { id: "later", status: "scheduled", dueQd: 120 },
        { id: "done", status: "resolved", dueQd: 40 }
      ]
    }
  };
  const clock = advanceTendayClock(clockHolding, 40);
  assert.deepEqual(clock, { before: 40, after: 80, delta: 40, beforePeriod: 1, afterPeriod: 2 }, "the internal tenday clock must advance with the prepared snapshot");
  assert.deepEqual(dueTendaySchedule(clockHolding).map((row) => row.id), ["due"], "only scheduled rows due at the resulting clock must be surfaced");

  const data = {
    holdings: [{ id: "one" }, { id: "two" }],
    catalog: {
      resources: [{ id: "food" }],
      eventRegions: [{ id: "north" }],
      markets: [{ id: "unrelated-market" }]
    }
  };
  assert.deepEqual(tendayDependencySnapshot(data, "two"), {
    holding: data.holdings[1],
    normalLaborQdPerTenday: 20,
    catalog: {
      resources: data.catalog.resources,
      marketEconomy: {},
      eventRegions: data.catalog.eventRegions
    }
  }, "stale protection must cover the holding, labor norm and catalogs used by a tenday forecast");

  const current = { id: "one", value: 1 };
  const prepared = { id: "one", value: 2, nested: { exact: true } };
  const sourceHash = hash(current);
  assert.equal(applyPreparedTenday(current, prepared, sourceHash, { hash, clone: copy }).ok, true, "an unchanged source must accept its exact prepared snapshot");
  assert.deepEqual(current, prepared, "apply must commit the prepared snapshot instead of rerunning random calculations");
  const stale = { id: "one", value: 9 };
  assert.equal(applyPreparedTenday(stale, prepared, sourceHash, { hash, clone: copy }).stale, true, "a changed source must reject a prepared snapshot");

  const appliedHolding = copy(prepared);
  appliedHolding.log = [{ operationId: "tenday-replay", type: "tenday" }];
  assert.equal(preparedTendayReplay(appliedHolding, "tenday-replay")?.type, "tenday", "a persisted tenday operation must make an identical Apply retry replay-safe");
  assert.equal(preparedTendayReplay(appliedHolding, "other"), null, "an unrelated operation must not mask a stale prepared tenday");
}

function checkExactChangeSet() {
  const before = changeSetFixture();
  const after = copy(before);
  after.storage.moneyCopper = 135;
  after.storage.resources[0].qty = 4;
  after.storage.resources[1].qty = 7;
  after.people.list[0].injuredDays = 0;
  after.people.list[0].status = "";
  after.buildings.list[0].buildProgress = 3;
  after.overview.development.food = 2;
  after.gm.calendaria.lastQd = 40;

  const changes = buildTendayChangeSet(before, after, {
    isFoodResource: (row) => row?.resourceId === "food",
    roomLabel: (_holding, roomId) => `room:${roomId}`
  });
  assert.equal(changes.money.delta, 35, "money delta must be calculated from persisted values");
  assert.equal(changes.food.delta, -6, "food delta must be calculated from all food resource rows");
  assert.equal(changes.resources.length, 2, "resource diff must contain every changed resource row");
  assert.equal(changes.resources[0].roomLabel.startsWith("room:"), true, "resource diff must preserve storage location context");
  assert.equal(changes.buildings.length, 1, "construction progress must be present in the exact diff");
  assert.equal(changes.residents[0].recovered, true, "resident recovery must be explicit in the exact diff");
  assert.equal(changes.development.length, 1, "development changes must be explicit in the exact diff");
  assert.equal(changes.clock.delta, 40, "internal time must be part of the exact diff");
  assert.equal(changes.hasChanges, true, "a non-empty snapshot diff must be marked as changed");
}

function checkBoundedOperationPayload() {
  const rows = Array.from({ length: 100 }, (_value, index) => ({ index, nested: { value: index } }));
  const compact = compactTendayRows(rows, 3);
  rows[0].nested.value = 999;
  assert.equal(compact.rows.length, 3, "operation payload rows must respect their bound");
  assert.equal(compact.total, 100, "operation payload must retain the original row count");
  assert.equal(compact.truncated, true, "operation payload must disclose truncation");
  assert.equal(compact.rows[0].nested.value, 0, "operation payload rows must be detached from the prepared report");

  const payload = buildTendayOperationPayload({
    qd: 40,
    report: { produced: rows, consumed: rows, income: rows, work: rows, skipped: rows },
    changeSet: { resources: rows, totals: { resourceRows: rows.length } },
    events: { events: rows },
    dueEvents: rows
  });
  assert.equal(payload.economy.produced.rows.length, 60, "production history in a tenday operation must be bounded");
  assert.equal(payload.changes.resources.rows.length, 80, "exact diff history in a tenday operation must be bounded");
  assert.equal(payload.events.rows.length, 40, "event snapshots in a tenday operation must be bounded");
  assert.equal(payload.dueEvents.rows.length, 40, "scheduled event snapshots in a tenday operation must be bounded");

  const normalizedRoll = normalizeLastEventRoll({
    kind: "tenday",
    eventId: "tenday:bounded",
    events: rows.map((row) => ({ ...row, eventId: `event-${row.index}`, title: `Event ${row.index}` }))
  });
  assert.equal(normalizedRoll.events.length, 40, "the current composite tenday roll must keep a bounded event bundle");
  assert.equal(normalizedRoll.eventCount, 100, "the current composite tenday roll must retain its complete event count");
  assert.equal(normalizedRoll.eventsTruncated, true, "the current composite tenday roll must disclose event truncation");
}

function checkSequentialEventCooldown() {
  const holding = {
    id: "event-holding",
    overview: { region: "", development: { food: 0, technology: 0, culture: 0, war: 0 }, reputation: 0 },
    people: { list: [] },
    buildings: { list: [] },
    storage: { resources: [], items: [] },
    gm: {
      modifiers: {},
      eventHistory: [],
      eventTables: {
        general: {
          version: 999,
          rows: [{
            id: "once-per-two-runs",
            title: "Редкое событие",
            text: "Происходит только один раз подряд.",
            weight: 1,
            cooldown: 1,
            effects: [{ type: "money", amount: 10 }]
          }]
        },
        external: { version: 999, rows: [] }
      }
    }
  };
  const app = {
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    _calculateMorale: () => 0,
    _reputationSummary: () => ({ total: 0 })
  };
  const result = prepareTendayRandomEvents(app, holding, { periods: 2, operationId: "operation-1" });
  assert.equal(result.events.length, 1, "the first event must enter history before the next tenday is rolled");
  assert.equal(result.warnings.length, 1, "the next tenday must report that cooldown left no eligible event");
  assert.deepEqual(holding.gm.eventHistory.map((row) => row.id), ["once-per-two-runs"], "event history must be updated period by period");
  assert.equal(result.lastRoll.eventId, "tenday:operation-1", "the composite tenday roll must be addressable by its operation id");
  assert.equal(result.lastRoll.effects.length, 1, "declarative event effects must survive in the composite result");
  assert.equal(result.lastRoll.effectStatus, "pending", "non-empty tenday effects must remain available for explicit GM application");
  assert.equal(result.events[0].decisionId, "operation-1:event:1", "every tenday event must receive a stable decision id");
  assert.equal(result.events[0].effectStatus, "pending", "an event with effects must enter the decision queue as pending");
  const pending = normalizeLastEventRoll(result.lastRoll);
  assert.equal(pending.canApplyEffects, true, "a pending decision bundle must remain actionable");
  result.lastRoll.events[0].effectStatus = "scheduled";
  const scheduled = normalizeLastEventRoll(result.lastRoll);
  assert.equal(scheduled.canApplyEffects, false, "scheduled decisions must not remain in the bulk apply set");
  assert.equal(scheduled.events[0].effectStatus, "scheduled", "decision state must survive holding normalization");
}

function checkSchoolResolutionMilestone() {
  const attributes = { strength: 3, agility: 3, wits: 3, empathy: 3 };
  const holding = {
    people: { list: [
      { id: "child", name: "Ученик", age: 5, race: "Человек", dead: false, attributes: { ...attributes }, educationMilestones: [], notes: "" },
      { id: "teacher", name: "Учитель", age: 30, race: "Человек", dead: false, injuredDays: 0 }
    ] },
    buildings: { list: [{ id: "school-1", templateId: "school", constructionStatus: "built", workersMin: 1, assignedWorkerIds: ["teacher"], functions: { culture: true } }] },
    finance: {},
    log: []
  };
  const harness = {
    ...EconomyEventDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  };
  const result = harness._advanceResidentAges(holding, 1);
  assert.equal(result.educated, 1, "a working paid School must create one GM resolution at the first human childhood milestone");
  assert.deepEqual(holding.people.list[0].attributes, attributes, "School must never mutate attributes or traits automatically");
  assert.deepEqual(holding.people.list[0].educationMilestones, ["child-third-1"]);
  assert.equal(holding.log.length, 1);
  assert.equal(holding.log[0].payload?.needsResolution, true);
  assert.equal(holding.log[0].payload?.resolutionKind, "school-milestone");
}

function checkResidentAgeAttributeBudgets() {
  const holding = {
    people: { list: [{
      id: "growing-child",
      name: "Взрослеющий",
      age: 17,
      race: "Человек",
      dead: false,
      attributes: { strength: 3, agility: 3, wits: 2, empathy: 2 },
      educationMilestones: [],
      notes: ""
    }] },
    buildings: { list: [] },
    finance: {},
    log: []
  };
  const harness = {
    ...EconomyEventDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  };
  const originalRandom = Math.random;
  Math.random = () => 0;
  try {
    const young = harness._advanceResidentAges(holding, 1);
    assert.equal(young.changed, 1, "crossing into youth must count as one changed resident");
    assert.equal(holding.people.list[0].ageGroup, "Мл");
    assert.equal(Object.values(holding.people.list[0].attributes).reduce((sum, value) => sum + value, 0), 15, "a naturally grown young resident must receive the young attribute budget");

    harness._advanceResidentAges(holding, 37);
    assert.equal(holding.people.list[0].age, 55);
    assert.equal(holding.people.list[0].ageGroup, "Ст");
    assert.equal(Object.values(holding.people.list[0].attributes).reduce((sum, value) => sum + value, 0), 13, "crossing several later age groups must reach the old attribute budget");
    assert.match(holding.people.list[0].notes, /Ре → Мл/);
    assert.match(holding.people.list[0].notes, /Мл → Вз/);
    assert.match(holding.people.list[0].notes, /Вз → Ст/);
  } finally {
    Math.random = originalRandom;
  }
}

export function checkTendayCharacterization() {
  checkPreparedSnapshotContract();
  checkExactChangeSet();
  checkBoundedOperationPayload();
  checkSequentialEventCooldown();
  checkSchoolResolutionMilestone();
  checkResidentAgeAttributeBudgets();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTendayCharacterization();
  console.log("FBL Skyhold tenday characterization checks passed.");
}
