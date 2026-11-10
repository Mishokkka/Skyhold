import assert from "node:assert/strict";
import { ResidentDomain } from "../apps/domains/resident-domain.js";

const holding = { special: { list: [{ id: "hidden-first", name: "Secret", visibility: "gm", notes: "GM text" },
  { id: "public", name: "Public", visibility: "public" }, { id: "hidden-last", visibility: "gm" }] } };
const before = structuredClone(holding), app = { ...ResidentDomain, _preparePersonRows: () => [] };
for (const isGM of [false, true]) for (const mayEditPeople of [false, true]) for (const tab of ["special", "defense"]) {
  globalThis.game = { user: { isGM } };
  const rows = app._prepareRows(holding, mayEditPeople, tab).special;
  assert.deepEqual(rows.map(row => row.id), isGM ? ["hidden-first", "public", "hidden-last"] : ["public"],
    "editing residents must not grant visibility of GM-only special records");
  if (!isGM) {
    assert.equal(rows[0]._index, 1, "filtering keeps original storage indexes for permitted edits");
    assert.ok(rows.every(row => !row.isGmOnly));
  }
}
assert.deepEqual(holding, before, "visibility filtering is read-only");
console.log("Special visibility: GM/player, resident editing on/off, special/defense tabs and original indexes passed.");
