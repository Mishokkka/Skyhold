import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";

const workflow = getSkyholdWorkflowService();
for (const method of [
  "_addMoney",
  "_storageAddWithOverflow",
  "_snapshotItemForStorage",
  "_appendStorageLog",
  "_prepareTendayOperation",
  "_applyPreparedTendayOperation",
  "_applyTendayEventDecision",
  "_scheduleTendayEventDecision"
]) assert.equal(typeof workflow[method], "function", `workflow service must expose ${method}`);

const marketSource = readFileSync(fileURLToPath(new URL("../apps/market-app.js", import.meta.url)), "utf8");
const tendaySource = readFileSync(fileURLToPath(new URL("../apps/tenday-app.js", import.meta.url)), "utf8");
assert.doesNotMatch(marketSource, /getSkyholdManager|manager\._/, "market workflow must not require an open manager");
assert.doesNotMatch(tendaySource, /getSkyholdManager|this\.owner/, "tenday workflow must not require an open manager");

console.log("FBL Skyhold workflow service: headless market/storage/tenday commands and manager independence passed.");
