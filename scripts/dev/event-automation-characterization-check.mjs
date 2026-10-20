import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRandomEventEffect, normalizeRandomEventEffects } from "../data/random-event-effects.js";
import { normalizeEventArchive, normalizeEventSchedule, normalizeLastEventRoll } from "../data/event-automation.js";
import { appendHoldingOperation } from "../data/operations.js";
import { buildHoldingOperationTimeline } from "../data/operation-timeline.js";
import { applyRandomEventEffects } from "../engines/events/effect-executor.js";

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
  const find = (holding, resource) => holding.storage.resources.find((row) => row.resourceId === resource.resourceId && room(row.roomId) === room(resource.roomId));
  return {
    safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeStorageRoomId: room,
    storageQuantity: (holding, resource) => Number(find(holding, resource)?.qty ?? 0),
    storageAdd: (holding, resource, qty) => {
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

  const schedule = normalizeEventSchedule([{ id: "schedule-1", eventId: "event-1", effects, dueQd: 40 }]);
  assert.equal(schedule[0].canApplyEffects, true, "scheduled events with effects must expose an apply action");
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkEventAutomationCharacterization();
  console.log("FBL Skyhold event automation: schema, atomic effects, schedule/archive and timeline passed.");
}
