import assert from "node:assert/strict";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";

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

const original = { meta: { revision: 1 }, holdings: [mergeHoldingDefaults({
  id: "notes", gm: { playersCanEditSpecial: true }, special: { list: [
    { id: "legacy", name: "Старая заметка", notes: "Без поля видимости" },
    { id: "effect", name: "Модификатор довольства", value: 5, visibility: "public" },
    { id: "secret", name: "ГМ", visibility: "gm" }
  ] }
})] };
globalThis.game.user = { id: "player", isGM: false };
const noteRows = app._prepareRows(original.holdings[0], false, "special").special;
assert.deepEqual(noteRows.map(row => [row.id, row.canDeleteSpecialRecord]), [["legacy", true], ["effect", false]]);
const add = structuredClone(original);
add.holdings[0].special.list.push({ id: "new", name: "Новая заметка", visibility: "public", notes: "" });
assert.equal(validatePlayerPatch(original, buildPlayerPatch(original, add)).ok, true);
for (const id of ["legacy", "effect", "secret"]) {
  const remove = structuredClone(add);
  remove.holdings[0].special.list = remove.holdings[0].special.list.filter(row => row.id !== id);
  assert.equal(validatePlayerPatch(add, buildPlayerPatch(add, remove)).ok, id === "legacy",
    "only ordinary public notes may be removed with the special-record permission");
}
console.log("Special records: role visibility, counts, original indexes and permitted public-note creation and removal passed.");
