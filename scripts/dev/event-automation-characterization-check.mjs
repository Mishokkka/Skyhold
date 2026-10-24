import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRandomEventEffect, normalizeRandomEventEffects } from "../data/random-event-effects.js";
import { MAX_EVENT_SCHEDULE_ENTRIES, normalizeEventArchive, normalizeEventSchedule, normalizeLastEventRoll } from "../data/event-automation.js";
import { appendHoldingOperation } from "../data/operations.js";
import { buildHoldingOperationTimeline } from "../data/operation-timeline.js";
import { applyRandomEventEffects } from "../engines/events/effect-executor.js";
import { EventAutomationDomain } from "../apps/domains/events/event-automation-events.js";
import { SkyholdData } from "../data/store.js";
import { FinanceStorageDomain } from "../apps/domains/finance/storage-domain.js";
import { isMoneyResource } from "../core/resources.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function holdingFixture() {
  return {
    id: "holding-1",
    overview: { development: { food: 2, technology: 1, culture: 0, war: 0 } },
    gm: { modifiers: { morale: 0 }, massCombat: { archive: [] }, eventArchive: [] },
    storage: {
      moneyCopper: 20,
      resources: [{ id: "wood-source", resourceId: "wood", name: "Древесина", qty: 5, roomId: "outdoors" }],
      items: [],
      log: []
    },
    log: []
  };
}

function dependencies() {
  const room = (value) => String(value || "outdoors");
  const find = (holding, resource) => holding.storage.resources.find((row) =>
    FinanceStorageDomain._storageResourceMatches.call(FinanceStorageDomain, row, resource) && room(row.roomId) === room(resource.roomId));
  return {
    safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeStorageRoomId: room,
    storageResourceIdentity: FinanceStorageDomain._storageResourceIdentity,
    isMoneyResource: (resource) => isMoneyResource(resource.resourceId, resource.name),
    storageQuantity: (holding, resource) => isMoneyResource(resource.resourceId, resource.name)
      ? holding.storage.moneyCopper : Number(find(holding, resource)?.qty ?? 0),
    storageAdd: (holding, resource, qty) => {
      if (isMoneyResource(resource.resourceId, resource.name)) { holding.storage.moneyCopper += qty; return null; }
      const row = find(holding, resource) ?? { id: `${resource.resourceId}-${room(resource.roomId)}`, ...resource, qty: 0 };
      if (!holding.storage.resources.includes(row)) holding.storage.resources.push(row);
      row.qty += qty;
      return row;
    },
    storageAddWithOverflow: (holding, resource, qty) => {
      const row = find(holding, resource) ?? { id: `${resource.resourceId}-${room(resource.roomId)}`, ...resource, qty: 0 };
      if (!holding.storage.resources.includes(row)) holding.storage.resources.push(row);
      row.qty += qty;
      return [{ roomId: room(resource.roomId), qty }];
    },
    storageRoomLabel: (_holding, roomId) => roomId === "outdoors" ? "Снаружи" : roomId,
    formatNumber: (value) => String(value)
  };
}

export function checkEventAutomationCharacterization() {
  const normalized = normalizeRandomEventEffect({ type: "unknown", amount: 2_000_000, key: "bad" });
  assert.equal(normalized.type, "resource", "unknown effect types must fall back to the safe resource contract");
  assert.equal(normalized.amount, 1_000_000, "effect amount must be bounded");
  assert.equal(normalizeRandomEventEffects(new Array(50).fill({ type: "money", amount: 1 })).length, 40, "an event must have a bounded effect list");

  const holding = holdingFixture();
  const effects = normalizeRandomEventEffects([
    { id: "money", type: "money", amount: -4 },
    { id: "food", type: "development", key: "food", amount: 2 },
    { id: "morale", type: "modifier", key: "morale", amount: -1 },
    { id: "wood", type: "resource", resourceId: "wood", name: "Древесина", amount: -3, roomId: "outdoors" }
  ]);
  const result = applyRandomEventEffects({ holding, effects, dependencies: dependencies() });
  assert.equal(result.ok, true, "valid declarative effects must apply");
  assert.equal(holding.storage.moneyCopper, 16, "money effect must update treasury");
  assert.equal(holding.overview.development.food, 4, "development effect must update its canonical key");
  assert.equal(holding.gm.modifiers.morale, -1, "modifier effect must update GM modifiers");
  assert.equal(holding.storage.resources[0].qty, 2, "resource expense must use the selected room");
  assert.equal(result.changes.length, 4, "executor must return an auditable result row for every applied effect");

  const insufficient = holdingFixture();
  const rejected = applyRandomEventEffects({
    holding: insufficient,
    effects: [{ type: "development", key: "food", amount: 5 }, { type: "resource", resourceId: "wood", name: "Древесина", roomId: "outdoors", amount: -99 }],
    dependencies: dependencies()
  });
  assert.equal(rejected.ok, false, "executor must reject unaffordable resource effects");
  assert.equal(insufficient.overview.development.food, 2, "failed effect batches must not partially mutate earlier effects");

  for (const alias of [{ resourceId: "wood", name: "Дрова" }, { resourceId: "Древесина", name: "" }]) {
    const aliased = holdingFixture();
    const before = structuredClone(aliased);
    const result = applyRandomEventEffects({ holding: aliased, effects: [
      { type: "development", key: "food", amount: 5 },
      { type: "resource", resourceId: "wood", name: "Древесина", amount: -3 },
      { type: "resource", ...alias, amount: -3 }
    ], dependencies: dependencies() });
    assert.equal(result.ok, false, "resource aliases share one available stock in preflight");
    assert.deepEqual(result.changes, [], "unaffordable alias batches must be rejected before any changes");
    assert.deepEqual(aliased, before, "alias overdraw cannot partially apply development or consume stock");
  }
  {
    const mixedMoney = holdingFixture();
    const before = structuredClone(mixedMoney);
    const result = applyRandomEventEffects({ holding: mixedMoney, effects: [
      { type: "money", amount: -12 },
      { type: "resource", resourceId: "money", name: "Монеты", roomId: "vault", amount: -12 }
    ], dependencies: dependencies() });
    assert.equal(result.ok, false, "money effects and money resource aliases share one treasury");
    assert.deepEqual(mixedMoney, before, "mixed treasury overdraw is rejected atomically");
  }
  {
    const separate = holdingFixture();
    separate.storage.resources.push({ resourceId: "custom", name: "Красная краска", qty: 2, roomId: "outdoors" },
      { resourceId: "custom", name: "Синяя краска", qty: 2, roomId: "outdoors" },
      { resourceId: "wood", name: "Древесина", qty: 2, roomId: "warehouse" });
    const result = applyRandomEventEffects({ holding: separate, effects: [
      { type: "resource", resourceId: "custom", name: "Красная краска", amount: -2 },
      { type: "resource", resourceId: "custom", name: "Синяя краска", amount: -2 },
      { type: "resource", resourceId: "wood", amount: -5 },
      { type: "resource", resourceId: "wood", roomId: "warehouse", amount: -2 }
    ], dependencies: dependencies() });
    assert.equal(result.ok, true, "distinct custom names and storage rooms keep separate inventories");
    assert.ok(separate.storage.resources.every((row) => row.qty === 0));
  }

  const schedule = normalizeEventSchedule([{ id: "schedule-1", eventId: "event-1", effects, dueQd: 40 }]);
  assert.equal(schedule[0].canApplyEffects, true, "scheduled events with effects must expose an apply action");
  const oversizedSchedule = Array.from({ length: MAX_EVENT_SCHEDULE_ENTRIES + 1 }, (_, index) => ({
    id: `pending-${index}`, eventId: `event-${index}`, effects, dueQd: 40
  }));
  const loadedSchedule = normalizeEventSchedule(oversizedSchedule);
  assert.equal(loadedSchedule.length, oversizedSchedule.length, "loading an oversized legacy queue must preserve every pending event");
  assert.deepEqual(loadedSchedule.map((entry) => entry.id), oversizedSchedule.map((entry) => entry.id), "normalization must preserve the oldest and newest pending events in order");
  const archive = normalizeEventArchive([{ ...schedule[0], archivedAt: "2026-07-12T13:00:00.000Z" }]);
  assert.equal(archive[0].status, "archived", "event archive must force terminal archive status");
  const lastRoll = normalizeLastEventRoll({ eventId: "event-1", effects });
  assert.equal(lastRoll.canApplyEffects, true, "last roll must expose pending effects");
  assert.equal(lastRoll.canSchedule, true, "unscheduled event roll must expose scheduling");

  appendHoldingOperation(holding, { operationId: "event-effect-1", type: "event-effect", createdAt: "2026-07-12T12:00:00.000Z", title: "Эффекты события", summary: result.changes.map((row) => row.text).join("; ") });
  holding.gm.eventArchive = archive;
  holding.storage.log.push({ id: "storage-1", operationId: "storage-1", source: "Пакетное перемещение", name: "Камень", qty: 2, ts: "2026-07-12T11:00:00.000Z" });
  const timeline = buildHoldingOperationTimeline(holding);
  assert.ok(timeline.some((row) => row.type === "event-effect"), "operations timeline must include event effect audits");
  assert.ok(timeline.some((row) => row.type === "storage"), "operations timeline must include storage operations");
  assert.ok(timeline.some((row) => row.source === "events"), "operations timeline must include event archive rows");

  const engine = readFileSync(path.join(root, "scripts/engines/events/effect-executor.js"), "utf8");
  const editorTemplate = readFileSync(path.join(root, "templates/random-event-row-editor.hbs"), "utf8");
  const adapter = readFileSync(path.join(root, "scripts/apps/domains/events/event-automation-events.js"), "utf8");
  assert.doesNotMatch(engine, /\b(?:ApplicationV2|ChatMessage|document|foundry|game|ui|window)\b/, "event effect executor must remain independent from Foundry and DOM globals");
  assert.match(editorTemplate, /data-event-effect-field="type"/, "random event editor must expose effect type controls");
  assert.match(editorTemplate, /data-event-effect-field="amount"/, "random event editor must expose signed effect amounts");
  assert.match(adapter, /stableDataHash\(freshHolding\) !== sourceHash/, "event effect apply must reject stale previews");
  assert.match(adapter, /appendHoldingOperation\(holding/, "event effect apply must append an operations audit");
  assert.match(adapter, /foundryDialogV2\(\)\.confirm/, "event effects and archive actions must use the V13/V14 dialog adapter");
}

export async function checkEventScheduleCapacity() {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const originalGet = SkyholdData.get;
  const originalUpdate = SkyholdData.updateHolding;
  const originalSkip = SkyholdData.skipTransaction;
  const skipped = Symbol("skipped event transaction");
  let holding;
  let commits = 0;
  let attempts = 0;
  const warnings = [];
  const app = { ...EventAutomationDomain, activeHoldingId: "holding-1", requestRender() {} };
  const event = { preventDefault() {}, stopPropagation() {} };
  const fixture = (length) => {
    const next = holdingFixture();
    next.gm.eventSchedule = normalizeEventSchedule(Array.from({ length }, (_, index) => ({ id: `scheduled-${index}`, eventId: `old-${index}` })));
    next.gm.lastRoll = {
      eventId: "new-event", title: "Новое событие",
      events: ["first", "second"].map((decisionId) => ({ decisionId, eventId: decisionId, title: decisionId, effectStatus: "pending", effects: [{ type: "money", amount: 1 }] }))
    };
    return next;
  };
  try {
    globalThis.game = { user: { id: "gm", isGM: true } };
    globalThis.ui = { notifications: { warn: (message) => warnings.push(message), info() {} } };
    SkyholdData.get = () => ({ holdings: [structuredClone(holding)] });
    SkyholdData.skipTransaction = (value) => ({ [skipped]: true, value });
    SkyholdData.updateHolding = async (id, updater) => {
      attempts++;
      assert.equal(id, holding.id);
      const draft = structuredClone(holding);
      const result = updater(draft);
      if (result?.[skipped]) return result.value;
      commits++;
      holding = draft;
      return result;
    };

    holding = fixture(MAX_EVENT_SCHEDULE_ENTRIES - 1);
    const [accepted, rejected] = await Promise.all([
      app._scheduleTendayEventDecision({ holdingId: holding.id, decisionId: "first" }),
      app._scheduleTendayEventDecision({ holdingId: holding.id, decisionId: "second" })
    ]);
    assert.equal(accepted.ok, true, "the last available schedule slot must accept an event");
    assert.equal(rejected.capacityExceeded, true, "a second decision must recheck capacity inside its transaction");
    assert.equal(commits, 1, "capacity rejection must not commit a second draft");
    assert.equal(holding.gm.eventSchedule.length, MAX_EVENT_SCHEDULE_ENTRIES);
    assert.equal(holding.gm.eventSchedule[0].id, "scheduled-0", "scheduling must not evict the oldest pending event");
    assert.equal(holding.gm.lastRoll.events[1].effectStatus, "pending", "a rejected decision must remain available");

    holding = fixture(MAX_EVENT_SCHEDULE_ENTRIES);
    const before = structuredClone(holding);
    await app._onScheduleLastEvent(event);
    assert.deepEqual(holding, before, "the main-window scheduling action must preserve a full queue and its pending decisions");
    assert.equal(commits, 1);
    assert.match(warnings.at(-1), /Архивируйте/, "capacity feedback must explain how to free a slot");

    holding = fixture(MAX_EVENT_SCHEDULE_ENTRIES - 1);
    await app._onScheduleLastEvent(event);
    assert.equal(holding.gm.eventSchedule.length, MAX_EVENT_SCHEDULE_ENTRIES);
    assert.equal(commits, 2, "the main-window action must still schedule when capacity is available");
    assert.equal(holding.gm.lastRoll.events.every((decision) => decision.effectStatus === "scheduled"), true);

    holding = fixture(0);
    for (const decision of holding.gm.lastRoll.events) {
      decision.effects = normalizeRandomEventEffects(Array.from({ length: 21 }, () => ({ type: "money", amount: 1 })));
    }
    const beforeBundle = structuredClone(holding);
    await app._onScheduleLastEvent(event);
    assert.deepEqual(holding, beforeBundle, "a bundle exceeding one schedule entry's effect limit must not lose effects or mark decisions as scheduled");
    assert.equal(commits, 2, "an oversized effect bundle must not commit");
    assert.match(warnings.at(-1), /по отдельности/, "the GM must be told to schedule the decisions separately");
    const individual = await app._scheduleTendayEventDecision({ holdingId: holding.id, decisionId: "first" });
    assert.equal(individual.ok, true, "individual decisions remain schedulable after rejecting the oversized bundle");
    assert.equal(holding.gm.eventSchedule[0].effects.length, 21);

    globalThis.game.user = { id: "player", isGM: false };
    const beforePlayer = structuredClone(holding);
    const attemptsBeforePlayer = attempts;
    const playerResult = await app._scheduleTendayEventDecision({ holdingId: holding.id, decisionId: "first" });
    await app._onScheduleLastEvent(event);
    assert.equal(playerResult.ok, false, "players must remain unable to schedule GM events");
    assert.equal(attempts, attemptsBeforePlayer, "player scheduling must not enter persistence");
    assert.deepEqual(holding, beforePlayer);
  } finally {
    SkyholdData.get = originalGet;
    SkyholdData.updateHolding = originalUpdate;
    SkyholdData.skipTransaction = originalSkip;
    if (previousGame === undefined) delete globalThis.game; else globalThis.game = previousGame;
    if (previousUi === undefined) delete globalThis.ui; else globalThis.ui = previousUi;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkEventAutomationCharacterization();
  await checkEventScheduleCapacity();
  console.log("FBL Skyhold event automation: schema, atomic effects, schedule/archive, capacity preservation and timeline passed.");
}
