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
  const recordsTab = app._prepareSpecialTabs(holding).find(row => row.id === "records");
  assert.equal(recordsTab.count, rows.length, "the records badge must count only rows visible to this viewer");
  assert.equal(recordsTab.tabCount, rows.length);
  const hiddenOnly = { special: { list: holding.special.list.filter(row => row.visibility === "gm") } };
  const hiddenTab = app._prepareSpecialTabs(hiddenOnly).find(row => row.id === "records");
  assert.equal(hiddenTab.count, isGM ? 2 : 0, "all-hidden records must produce an empty player badge");
  assert.equal(hiddenTab.tabCount, isGM ? 2 : 0);
}
assert.deepEqual(holding, before, "visibility filtering is read-only");
console.log("Special visibility: GM/player, resident editing on/off, special/defense rows and badges, all-hidden records and original indexes passed.");
