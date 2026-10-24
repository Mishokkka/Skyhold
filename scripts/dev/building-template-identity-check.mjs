import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { HoldingService } from "../data/holding-service.js";
import { MODULE_ID } from "../data/constants.js";

let runNumber = 0;

export async function checkBuildingTemplateIdentity() {
  const original = { game: globalThis.game, ui: globalThis.ui, canvas: globalThis.canvas, Hooks: globalThis.Hooks };
  const getData = HoldingService.getData;
  const hooks = new Map();
  const created = [];
  const warnings = [];
  const building = { id: "building", name: "Shared name", templateId: "exact" };
  const holding = { id: "holding", visibility: "public", buildings: { list: [building] } };
  const byName = { id: "other", name: "Shared name", img: "other.webp", visibility: "public" };
  const exact = { id: "exact", name: "Original name", img: "exact.webp", visibility: "gm" };
  const data = { holdings: [holding], catalog: { buildings: [byName, exact] } };
  const note = { flags: { [MODULE_ID]: { type: "building-note", holdingId: holding.id, buildingId: building.id } } };
  try {
    globalThis.game = { user: { id: "gm", isGM: true } };
    globalThis.ui = { notifications: { info() {}, warn: (message) => warnings.push(message), error() {} } };
    globalThis.canvas = { activeLayer: {}, notes: {}, scene: { createEmbeddedDocuments: async (type, rows) => {
      assert.equal(type, "Note");
      created.push(...rows);
      return rows;
    } } };
    globalThis.Hooks = { on: (name, callback) => hooks.set(name, callback) };
    HoldingService.getData = () => data;
    // A fresh module instance makes hook installation deterministic on repeated suite runs.
    const sceneNotes = await import(`../integrations/scene-notes.js?characterization=${++runNumber}`);
    sceneNotes.installSceneNotesIntegration();
    const activate = hooks.get("activateNote");
    assert.equal(activate({}), undefined, "ordinary journal notes must retain Foundry's default activation");
    globalThis.canvas.activeLayer = globalThis.canvas.notes;
    assert.equal(activate(note), undefined, "the Notes editing layer retains its native activation");
    globalThis.canvas.activeLayer = {};

    const drop = hooks.get("dropCanvasData");
    const payload = { type: "fbl-skyhold-building", moduleId: MODULE_ID, holdingId: holding.id, buildingId: building.id };
    drop(null, payload);
    await Promise.resolve();
    assert.equal(created.length, 0, "an earlier same-name public template must not override the exact hidden template");
    assert.equal(warnings.length, 1);

    globalThis.game.user = { id: "player", isGM: false };
    assert.equal(await sceneNotes.openBuildingNote(note), false, "player cannot open a building whose exact template is GM-only");
    assert.equal(activate(note), false, "managed building notes suppress native journal activation synchronously");
    drop(null, payload);
    assert.equal(created.length, 0, "players cannot create scene Notes");

    globalThis.game.user = { id: "gm", isGM: true };
    exact.visibility = "public";
    byName.visibility = "gm";
    drop(null, payload);
    await Promise.resolve();
    assert.equal(created.length, 1, "an unrelated hidden namesake must not hide the exact public template");
    assert.equal(created[0].texture.src, "exact.webp", "scene Notes use the exact template's appearance");

    building.templateId = "missing-old-template";
    byName.visibility = "public";
    drop(null, payload);
    await Promise.resolve();
    assert.equal(created.length, 2, "legacy name matching remains available when the ID no longer exists");
    assert.equal(created[1].texture.src, "other.webp");
  } finally {
    HoldingService.getData = getData;
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkBuildingTemplateIdentity();
  console.log("FBL Skyhold building template identity check passed.");
}
