import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { normalizePoliticsBalance, politicsCatalogRow } from "../data/politics-balance.js";
import { applyPoliticsBalanceEdit } from "../engines/politics/balance-edit.js";
import { applyPoliticsAct } from "../engines/politics/acts.js";
import { changePoliticsDirective, politicsDecreeQuote, politicsEffects, politicsInfluenceGain } from "../engines/politics/rules.js";
import { executePoliticsBalanceOperation } from "../apps/politics-balance-executor.js";

export async function checkPoliticsBalance() {
  const holding = mergeHoldingDefaults({ id: "balance", gm: { politicsIgnoreInstitutionRequirement: true },
    politics: { stage: "selfRule", system: "elected-head", directives: { order: "gates-open" } } });
  const unchanged = JSON.stringify(holding);
  const core = applyPoliticsBalanceEdit(holding.gm.politicsBalance, "core", { fields: { influenceBaseGain: 3, influenceBaseCap: 9 } });
  assert.equal(core.ok, true);
  assert.equal(politicsInfluenceGain({ influence: 0 }, { available: true, balance: core.balance }).gained, 3);
  assert.equal(JSON.stringify(holding), unchanged, "balance edits must not mutate a stored source before commit");
  assert.equal(applyPoliticsBalanceEdit(core.balance, "core", { fields: { influenceBaseCap: -1 } }).ok, false);

  const tuned = applyPoliticsBalanceEdit(core.balance, "row", { id: "directive:gates-open",
    fields: { "effects.control": 4, "effects.reputation": 2 } });
  assert.equal(tuned.ok, true);
  holding.gm.politicsBalance = tuned.balance;
  const effects = politicsEffects(holding, { available: true, periodIndex: 1 });
  assert.equal(effects.control, 4);
  assert.equal(effects.reputation, 2);
  assert.equal(applyPoliticsBalanceEdit(tuned.balance, "reset", { id: "directive:gates-open" }).balance.rows["directive:gates-open"], undefined);
  const alteredFair = applyPoliticsBalanceEdit(tuned.balance, "row", { id: "decree:fair", fields: { copper: 125 },
    requires: [], enabled: false });
  assert.equal(politicsCatalogRow(alteredFair.balance, "decree:fair").copper, 125);
  assert.deepEqual(politicsCatalogRow(alteredFair.balance, "decree:fair").requires, []);
  assert.equal(politicsCatalogRow(alteredFair.balance, "decree:fair").enabled, false);
  assert.equal(politicsDecreeQuote("fair", 0, alteredFair.balance), null);

  const id = "custom-directive-abcdef";
  const created = applyPoliticsBalanceEdit(tuned.balance, "create", { id, kind: "directive", label: "Свой курс", slot: "order" });
  assert.equal(created.ok, true);
  const custom = applyPoliticsBalanceEdit(created.balance, "row", { id, label: "Свой курс", slot: "order", enabled: true,
    fields: { "effects.control": 3, "effects.foodMultiplierPercent": 90 } });
  assert.equal(custom.ok, true);
  assert.equal(politicsCatalogRow(custom.balance, id).effects.control, 3);
  assert.equal(changePoliticsDirective(holding.politics, { slot: "order", directiveId: id, available: true,
    periodIndex: 1, balance: custom.balance }).ok, true);
  assert.equal(changePoliticsDirective(holding.politics, { slot: "supply", directiveId: id, available: true,
    periodIndex: 1, balance: custom.balance }).ok, false, "custom directives must respect their slot");
  holding.gm.politicsBalance = custom.balance;
  holding.politics.directives.order = id;
  assert.equal(politicsEffects(holding, { available: true }).control, 3);
  assert.equal(politicsEffects(holding, { available: true }).foodMultiplier, 0.9);

  const decree = applyPoliticsBalanceEdit(custom.balance, "create", { id: "custom-decree-abcdef", kind: "decree", label: "Свой указ" });
  const priced = applyPoliticsBalanceEdit(decree.balance, "row", { id: "custom-decree-abcdef", label: "Свой указ", enabled: true,
    fields: { copper: 123, influence: 2, duration: 3, foodPerResident: 1 } });
  assert.deepEqual(politicsDecreeQuote("custom-decree-abcdef", 5, priced.balance), {
    decreeId: "custom-decree-abcdef", copper: 123, influence: 2, food: 5, duration: 3
  });
  const customHolding = mergeHoldingDefaults({ id: "custom-decree-holding", gm: { politicsBalance: priced.balance },
    storage: { moneyCopper: 123, resources: [{ id: "bread", resourceId: "bread", qty: 5 }] },
    people: { list: Array.from({ length: 5 }, (_, index) => ({ id: `person-${index}` })) }, politics: { influence: 2 } });
  const customIssued = applyPoliticsAct(customHolding, { action: "decree",
    payload: { decreeId: "custom-decree-abcdef" }, context: { available: true } });
  assert.equal(customIssued.ok, true);
  assert.equal(customIssued.state.influence, 0);
  assert.equal(customIssued.storage.moneyCopper, 0);
  assert.equal(customIssued.storage.resources[0].qty, 0);
  assert.equal(applyPoliticsBalanceEdit(priced.balance, "row", { id: "custom-decree-abcdef",
    fields: { duration: 0 } }).ok, false);
  const future = normalizePoliticsBalance({ ...priced.balance, version: 2, future: { retained: true } });
  assert.deepEqual(future.future, { retained: true });
  assert.equal(applyPoliticsBalanceEdit(future, "reset", { id: "system:governor" }).ok, false);

  let user = { id: "gm", isGM: true };
  let writes = 0;
  const data = { meta: { revision: 1 }, holdings: [mergeHoldingDefaults({ id: "commit" })] };
  const store = { skipTransaction: (value) => ({ skip: true, value }), async updateHolding(holdingId, updater) {
    const result = updater(data.holdings.find((row) => row.id === holdingId), data);
    if (result?.skip) return result.value;
    writes++; data.meta.revision++; return result;
  } };
  const deps = { store, getUser: () => user };
  const command = { operationId: "balance-1", holdingId: "commit", expectedRevision: 1, action: "core",
    payload: { fields: { influenceBaseCap: 8 } } };
  user = { id: "player", isGM: false };
  assert.equal((await executePoliticsBalanceOperation(command, deps)).ok, false);
  user = { id: "gm", isGM: true };
  assert.equal((await executePoliticsBalanceOperation(command, deps)).ok, true);
  assert.equal(data.holdings[0].gm.politicsBalance.core.influenceBaseCap, 8);
  assert.equal((await executePoliticsBalanceOperation(command, deps)).replay, true);
  assert.equal(writes, 1);
  assert.equal((await executePoliticsBalanceOperation({ ...command, operationId: "balance-2", expectedRevision: 1 }, deps)).conflict, true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPoliticsBalance();
  console.log("Politics balance check passed.");
}
