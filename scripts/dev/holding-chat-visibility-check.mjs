import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EconomyEventDomain } from "../apps/domains/events/economy-events.js";
import * as runtime from "../integrations/foundry-runtime.js";
import { SkyholdData } from "../data/store.js";
import { calculateBattle } from "../apps/mass-combat/calculator.js";
import { createPendingBattleRound } from "../apps/mass-combat/round-resolution.js";
import { resetMassCombatState } from "../apps/mass-combat/state.js";

const messages = [];
let recipients = [{ id: "gm-1" }, { id: "gm-2" }];
globalThis.game = { user: { id: "gm-1", isGM: true } };
globalThis.foundry = { documents: { ChatMessage: {
  getSpeaker: options => options, getWhisperRecipients: () => recipients,
  create: async data => { messages.push(data); return data; }
} } };
globalThis.foundry.applications = { api: { ApplicationV2: class {}, HandlebarsApplicationMixin: Base => Base } };
const app = { ...EconomyEventDomain, _safeNumber: (value, fallback = 0) => Number(value) || fallback, _formatCopperCurrency: String };
for (const visibility of ["gm", "public"]) {
  const holding = { id: "holding", name: "Holding", visibility };
  await app._postTendaySummaryChat(holding, { clock: { afterPeriod: 1 } });
  const message = messages.at(-1);
  assert.deepEqual(message.whisper, visibility === "gm" ? ["gm-1", "gm-2"] : undefined,
    "automatic tenday summaries must respect holding visibility");
}
assert.equal(typeof runtime.createHoldingChatMessage, "function");
await runtime.createHoldingChatMessage({ visibility: "public" }, { content: "Private event" }, { gmOnly: true });
assert.deepEqual(messages.at(-1).whisper, ["gm-1", "gm-2"], "GM-only events remain private inside public holdings");
recipients = [];
await runtime.createHoldingChatMessage({ visibility: "gm" }, { content: "Fallback" });
assert.deepEqual(messages.at(-1).whisper, ["gm-1"], "the posting GM is a safe fallback recipient");
globalThis.game.user = { id: "player", isGM: false };
const before = messages.length;
await assert.rejects(runtime.createHoldingChatMessage({ visibility: "gm" }, { content: "Must not publish" }), /GM/);
assert.equal(messages.length, before, "missing private recipients must never degrade to public chat");
const [{ BuildingEventDomain }, { NavigationEventDomain }, { GmEventDomain }, { SkyholdMassCombatApp }] = await Promise.all([
  import("../apps/domains/events/building-events.js"), import("../apps/domains/events/navigation-events.js"),
  import("../apps/domains/events/gm-events.js"), import("../apps/mass-combat.js")
]);
const original = { get: SkyholdData.get, updateHolding: SkyholdData.updateHolding, random: Math.random,
  createMessage: foundry.documents.ChatMessage.create, consoleError: console.error };
globalThis.game = { user: { id: "gm-1", isGM: true }, settings: { get: () => null } };
globalThis.ui = { notifications: { warn() {} } };
recipients = [{ id: "gm-1" }, { id: "gm-2" }];
const audio = [];
globalThis.foundry.audio = { AudioHelper: { play: (data, broadcast) => audio.push({ data, broadcast }) } };
try {
  Math.random = () => 0.1;
  for (const visibility of ["gm", "public"]) {
    const holding = { id: "holding", name: "Holding", visibility, gm: { massCombat: {}, defense: { victorySound: "victory.ogg" } },
      people: { list: [] }, buildings: { list: [] } };
    SkyholdData.get = () => ({ holdings: [holding] });
    SkyholdData.updateHolding = async (_id, updater) => updater(holding);
    const event = { preventDefault() {}, stopPropagation() {}, currentTarget: { dataset: { stat: "reputation" } } };
    const manager = { ...app, activeHoldingId: holding.id, requestRender() {}, _canEditBuildings: () => true,
      _updateActiveHolding: async updater => { const result = await updater(holding); return result?.value ?? result; },
      _constructionCrew: () => ({ count: 1, dice: 1, rawDice: 1, moraleMod: 0, members: [] }),
      _reputationSummary: () => ({ total: 1 }) };
    const publishers = [
      () => BuildingEventDomain._onRollConstructionCrew.call(manager, event),
      () => GmEventDomain._postReputationEventRoll.call(manager, holding),
      () => NavigationEventDomain._onRollHoldingStat.call({ ...manager, _postReputationEventRoll: null }, event),
      () => SkyholdMassCombatApp.prototype._onPostAftermath.call({ holdingId: holding.id }, event),
      () => SkyholdMassCombatApp.prototype._onPostSummary.call({ holdingId: holding.id }, event)
    ];
    for (const publish of publishers) {
      const count = messages.length;
      await publish();
      assert.equal(messages.length, count + 1, "each real card publisher must post exactly once");
      assert.deepEqual(messages.at(-1).whisper, visibility === "gm" ? ["gm-1", "gm-2"] : undefined,
        "construction, reputation and battle handlers must forward the actual holding visibility");
    }
    SkyholdMassCombatApp.prototype._playDefenseSound(holding, 1);
    assert.equal(audio.at(-1).broadcast, visibility !== "gm", "private battle sounds cannot broadcast a hidden battle to players");
  }
  for (const visibility of ["gm", "public"]) {
    const state = { ...resetMassCombatState(), battleId: "chat-failure", phase: "active", roundLimit: 1,
      defenderMobilization: "manual", defenderUnits: 2, defenderBS: 10, attackerUnits: 1, attackerBS: 5,
      defenseMode: "outside", useDefenseSquads: false };
    const holding = { id: "holding", name: "Holding", visibility, people: { list: [] }, buildings: { list: [] },
      gm: { defense: {}, massCombat: state } };
    const calc = calculateBattle(holding, state);
    const { pendingRound } = createPendingBattleRound({ holding, state, calc, random: () => 0.1 });
    state.pendingRound = pendingRound;
    let writes = 0, chatAttempts = 0, renders = 0, sounds = 0;
    const warnings = [], infos = [], errors = [], chatObservations = [];
    ui.notifications = { warn: text => warnings.push(text), info: text => infos.push(text), error: text => errors.push(text) };
    console.error = (...args) => errors.push(args);
    SkyholdData.updateHolding = async (_id, updater) => { writes += 1; return updater(holding); };
    foundry.documents.ChatMessage.create = async data => {
      chatAttempts += 1;
      chatObservations.push({ pendingRound: state.pendingRound, logLength: state.log.length, whisper: data.whisper });
      throw new Error("Simulated ChatMessage.create rejection");
    };
    const battleApp = { holdingId: holding.id, _compactNameList: names => names.join(", "),
      requestRender: () => { renders += 1; }, _playDefenseSound: () => { sounds += 1; } };
    const event = { preventDefault() {}, stopPropagation() {} };
    await SkyholdMassCombatApp.prototype._onApplyPendingRound.call(battleApp, event);
    assert.equal(writes, 1);
    assert.equal(chatAttempts, 1, "failed chat must not retry the round transaction or publication");
    assert.deepEqual(chatObservations, [{ pendingRound: null, logLength: 1,
      whisper: visibility === "gm" ? ["gm-1", "gm-2"] : undefined }],
    "publication must follow the authoritative round application and retain the correct audience");
    assert.equal(state.round, 2);
    assert.equal(state.phase, "terminal", "the real terminal result must survive a chat failure");
    assert.equal(renders, 1, "a saved round must refresh the window even if chat fails");
    assert.equal(sounds, 1);
    assert.equal(infos.length, 1, "the terminal battle notification must still be delivered");
    assert.match(warnings[0], /Раунд применён.*чат/);
    assert.equal(errors.length, 1, "the failed publication must be logged once");
    assert.match(errors[0][1].message, /Simulated ChatMessage.create rejection/);
    const saved = structuredClone(holding);
    await SkyholdMassCombatApp.prototype._onApplyPendingRound.call(battleApp, event);
    assert.deepEqual(holding, saved, "a repeated click after chat failure cannot apply consequences twice");
    assert.equal(chatAttempts, 1);
    const writesBeforePlayer = writes;
    game.user = { id: "player", isGM: false };
    await SkyholdMassCombatApp.prototype._onApplyPendingRound.call(battleApp, event);
    assert.equal(writes, writesBeforePlayer, "players cannot reach the round mutation");
    game.user = { id: "gm-1", isGM: true };
  }
} finally {
  SkyholdData.get = original.get;
  SkyholdData.updateHolding = original.updateHolding;
  Math.random = original.random;
  foundry.documents.ChatMessage.create = original.createMessage;
  console.error = original.consoleError;
}
for (const file of ["scripts/apps/mass-combat.js", ...["building-events", "navigation-events", "gm-events", "economy-events"]
  .map(name => `scripts/apps/domains/events/${name}.js`)]) {
  const source = readFileSync(file, "utf8");
  assert.doesNotMatch(source, /\bcreateFoundryChatMessage\s*\(/, `${file}: all holding cards must use the shared visibility boundary`);
}
console.log("Holding chat: real hidden/public publishers, private audio, GM fallback, no-recipient refusal and saved-round recovery after chat rejection passed.");
