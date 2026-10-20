import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { executePoliticsOperation } from "../apps/politics-operation-executor.js";

export async function checkPoliticsOperation() {
  const data = { meta: { revision: 4 }, holdings: [mergeHoldingDefaults({ id: "holding-politics" })] };
  let writes = 0;
  let user = { id: "gm", isGM: true };
  const store = {
    skipTransaction: (value) => ({ skipped: true, value }),
    async updateHolding(id, updater) {
      const holding = data.holdings.find((row) => row.id === id);
      if (!holding) return null;
      const result = updater(holding, data);
      if (result?.skipped) return result.value;
      writes++;
      data.meta.revision++;
      return result;
    }
  };
  const deps = { store, getUser: () => user };
  const command = {
    operationId: "politics-test-1", holdingId: "holding-politics", expectedRevision: 4,
    action: "stage", payload: { stage: "charter", reason: "Согласовано с патроном" }
  };
  user = { id: "player", isGM: false };
  assert.equal((await executePoliticsOperation(command, deps)).ok, false, "player cannot write politics");
  assert.equal(writes, 0);
  user = { id: "gm", isGM: true };
  assert.equal((await executePoliticsOperation({ ...command, expectedRevision: 3 }, deps)).conflict, true, "stale revision is rejected");
  assert.equal(writes, 0);
  const first = await executePoliticsOperation(command, deps);
  assert.equal(first.ok, true);
  assert.equal(data.holdings[0].politics.stage, "charter");
  assert.equal(data.holdings[0].politics.history.length, 1);
  assert.equal(data.holdings[0].log.at(-1).type, "politics");
  assert.equal(writes, 1);
  const replay = await executePoliticsOperation(command, deps);
  assert.equal(replay.replay, true, "same operation ID is replayed before revision check");
  assert.equal(writes, 1);
  const changedIntent = await executePoliticsOperation({ ...command, payload: { stage: "selfRule", reason: "Подмена" } }, deps);
  assert.equal(changedIntent.ok, false, "same ID with different intent is rejected");
  assert.equal(writes, 1);
  const invalid = await executePoliticsOperation({ ...command, operationId: "politics-test-2", expectedRevision: 5, payload: { stage: "unknown", reason: "Ошибка" } }, deps);
  assert.equal(invalid.ok, false);
  assert.equal(writes, 1, "invalid act never persists");
  data.holdings[0].storage.moneyCopper = 200;
  data.holdings[0].storage.resources = [{ id: "bread", resourceId: "bread", qty: 3 }];
  data.holdings[0].people.list = [{ id: "one", name: "Житель" }];
  data.holdings[0].gm.politicsCultureThreshold = 0;
  data.holdings[0].gm.politicsIgnoreInstitutionRequirement = true;
  const decree = { operationId: "politics-decree-1", holdingId: "holding-politics", expectedRevision: 5,
    action: "decree", payload: { decreeId: "festival" } };
  const issued = await executePoliticsOperation(decree, deps);
  assert.equal(issued.ok, true);
  assert.equal(data.holdings[0].storage.moneyCopper, 0);
  assert.equal(data.holdings[0].storage.resources[0].qty, 1);
  assert.equal(data.holdings[0].politics.activeDecrees.length, 1);
  assert.equal((await executePoliticsOperation(decree, deps)).replay, true);
  assert.equal(writes, 2, "replayed decree must not charge again");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPoliticsOperation();
  console.log("Politics operation check passed.");
}
