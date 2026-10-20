import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPlayerWritablePath } from "../data/player-write-guard.js";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { defaultProfileModifiers } from "../engines/workers/profile-modifiers.js";
import { normalizeBuildingWorkerProfile, workerProductionQualification, workerAdmission, buildingCompositionStatus, workerBackgroundGroupMembers } from "../engines/workers/building-qualification.js";
import { changeWorkerProfile, editableWorkerProfile, workerProfileEditorContext } from "../apps/editors/worker-profile-editor.js";

export function checkWorkerProfileEditor() {
  const grouped = { workerProfile: { production: { backgroundGroups: ["КАМЕНЬ"] } } };
  const snapshot = JSON.stringify(grouped);
  const editor = workerProfileEditorContext(grouped);
  const backgroundRow = editor.sections.find((section) => section.key === "backgrounds").rows[0];
  assert.deepEqual(editor.sections.find((section) => section.key === "backgrounds").rows.map((row) => row.match), workerBackgroundGroupMembers("КАМЕНЬ"));
  assert.ok(backgroundRow.choices.every((choice) => !choice.value.startsWith("group:")), "picker offers only concrete backgrounds");
  const expanded = changeWorkerProfile(grouped, { section: "backgrounds", index: 0, field: "percent", value: -20 });
  assert.equal(expanded.modifiers.backgrounds[0].percent, -20);
  assert.ok(expanded.modifiers.backgrounds.every((row) => !row.match.startsWith("group:")));
  assert.equal(expanded.modifiers.backgrounds[1].percent, 10, "individual background edits preserve the other percentages");
  assert.equal(JSON.stringify(grouped), snapshot, "presenting readable groups must not rewrite saved rules");
  const metrics = ["workUnits", "typeUnits", "backgroundUnits", "positiveTraitUnits", "negativeTraitUnits"];
  for (const building of DEFAULT_BUILDING_TEMPLATES) {
    const profile = editableWorkerProfile(building);
    const edited = { ...building, workerProfile: { ...profile, modifiers: defaultProfileModifiers(profile) } };
    for (let bits = 0; bits < 16; bits++) {
      const person = { attributes: Object.fromEntries(["strength", "agility", "wits", "empathy"].map((key, index) => [key, bits & (1 << index) ? 5 : 3])), background: "крестьянин", traits: [...(profile.production?.positiveTraits ?? []), ...(profile.production?.negativeTraits ?? [])] };
      const before = workerProductionQualification(building, person);
      const after = workerProductionQualification(edited, person);
      for (const key of metrics) assert.equal(after[key], before[key], `${building.id}: default editor conversion preserves ${key}`);
    }
  }
  let building = { workerProfile: { source: "custom", admission: {}, production: {}, modifiers: { types: [{ match: "type:Силач", percent: -30 }], backgrounds: [{ match: "мой кузнец", percent: 15 }], traits: [{ match: "Новая черта", percent: 20 }, { match: "Помеха", percent: -10 }] } } };
  const person = { attributes: { strength: 5, agility: 2, wits: 2, empathy: 2 }, background: "Мой кузнец", traits: "Новая черта; Помеха" };
  assert.equal(workerProductionQualification(building, person).workUnits, 9500);
  assert.deepEqual(normalizeBuildingWorkerProfile(building.workerProfile, building).modifiers, building.workerProfile.modifiers);
  building.workerProfile = changeWorkerProfile(building, { section: "types", index: 0, field: "percent", value: 60 });
  assert.equal(workerProductionQualification(building, person).workUnits, 18500);
  building.workerProfile = changeWorkerProfile(building, { section: "admission", operation: "add" });
  building.workerProfile = changeWorkerProfile(building, { section: "admission", index: 0, field: "minimum", value: 6 });
  assert.equal(workerAdmission(building, person).eligible, false);
  assert.match(workerAdmission(building, person).text, /6/);
  building.workerProfile = changeWorkerProfile(building, { section: "admission", operation: "add" });
  building.workerProfile = changeWorkerProfile(building, { section: "admission", index: 1, field: "group", value: 2 });
  assert.equal(workerAdmission(building, person).eligible, true, "independent admission groups are OR clauses");
  assert.equal(workerProductionQualification({ workerProfile: { modifiers: { types: [{ match: "СИЛ", percent: -100 }], backgrounds: [{ match: "мой кузнец", percent: -100 }], traits: [] } } }, person).workUnits, 0);
  building.workerProfile = changeWorkerProfile(building, { section: "composition", operation: "add" });
  building.workerProfile = changeWorkerProfile(building, { section: "composition", index: 0, field: "count", value: 2 });
  assert.equal(building.workerProfile.composition[0].count, 2);
  building.workerProfile = changeWorkerProfile(building, { section: "composition", index: 0, field: "background", value: "Лекарь" });
  building.workerProfile = changeWorkerProfile(building, { section: "composition", index: 0, field: "background", value: "Аптекарь" });
  assert.deepEqual(building.workerProfile.composition[0], { count: 2, backgrounds: ["Лекарь", "Аптекарь"] });
  assert.deepEqual(normalizeBuildingWorkerProfile(building.workerProfile, building).composition, building.workerProfile.composition);
  assert.equal(buildingCompositionStatus(building, [{ background: "лекарь" }, { background: "аптекарь" }]).met, true);
  assert.equal(buildingCompositionStatus(building, [{ background: "лекарь" }]).met, false);
  assert.equal(buildingCompositionStatus(building, [{ background: "лекарь" }, { background: "бывший лекарь" }]).met, false, "background matching is exact");
  assert.equal(buildingCompositionStatus(building, [{ background: "лекарь" }, { traits: "Грамотный", attributes: { wits: 5, empathy: 5 } }]).met, false, "traits cannot substitute for a selected background");
  building.workerProfile = changeWorkerProfile(building, { section: "composition", index: 0, field: "background", value: "ЛЕКАРЬ" });
  assert.deepEqual(building.workerProfile.composition[0].backgrounds, ["Аптекарь"]);
  const legacy = { workerProfile: { composition: [{ count: 1, group: "МЕДИЦИНА" }] } };
  const legacySnapshot = JSON.stringify(legacy);
  workerProfileEditorContext(legacy);
  assert.equal(JSON.stringify(legacy), legacySnapshot);
  const replacement = changeWorkerProfile(legacy, { section: "composition", index: 0, field: "background", value: "лекарь" });
  assert.ok(Array.isArray(replacement.composition[0].backgrounds));
  assert.equal(replacement.composition[0].group, undefined);
  assert.equal(buildingCompositionStatus({ workerProfile: { composition: [{ count: 1, backgrounds: ["Лекарь"] }, { count: 1, backgrounds: ["Лекарь", "Аптекарь"] }] } }, [{ background: "Лекарь" }]).met, false, "one person cannot fill two positions");
  const data = { holdings: [{ id: "h", gm: { playersCanEditBuildings: true }, buildings: { list: [building] } }] };
  for (const suffix of ["admission.hard", "admission.clauses.0.0.minimum", "modifiers.types.0.percent", "composition.0.count", "composition.0.backgrounds.0"]) {
    assert.equal(isPlayerWritablePath(`holdings.0.buildings.list.0.workerProfile.${suffix}`, data, data), false, "player authority path must reject profile edits");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkWorkerProfileEditor();
  console.log("Worker profile editor: default equivalence, signed modifiers, normalization, permissions and admission passed.");
}
