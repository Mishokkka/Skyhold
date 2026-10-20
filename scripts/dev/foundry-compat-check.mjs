import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function runtimeJsFiles(directory) {
  const rows = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dev") rows.push(...runtimeJsFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith(".js")) rows.push(absolute);
  }
  return rows;
}

function runtimeTemplateFiles(directory) {
  const rows = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) rows.push(...runtimeTemplateFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".hbs")) rows.push(absolute);
  }
  return rows;
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

const adapterPath = path.join(root, "scripts/integrations/foundry-runtime.js");
const files = runtimeJsFiles(path.join(root, "scripts"));
const templates = runtimeTemplateFiles(path.join(root, "templates"));
const forbidden = [
  [/globalThis\.(?:FilePicker|Dialog|AudioHelper|ChatMessage|fromUuid|Actor|Item|Roll)\b/, "deprecated Foundry global redirect"],
  [/\bnew\s+Dialog\s*\(/, "ApplicationV1 Dialog"],
  [/\bChatMessage\s*\./, "global ChatMessage"],
  [/\bAudioHelper\s*\.\s*play\s*\(/, "global AudioHelper"],
  [/\bnew\s+Roll\s*\(/, "global Roll"],
  [/foundry\.appv1\b/, "ApplicationV1 namespace"],
  [/\.sheet\.render\s*\(\s*(?:true|false)\s*\)/, "ApplicationV1-only sheet render signature"],
  [/\bChatLog\.MESSAGE_PATTERNS\b/, "V14-deprecated ChatLog.MESSAGE_PATTERNS"],
  [/\bTile\.createPreview\b/, "V14-deprecated Tile.createPreview"],
  [/\bPlaceableObject\.clear\b/, "V14-deprecated PlaceableObject.clear"],
  [/\bMeasuredTemplate(?:Document)?\b/, "V14-removed MeasuredTemplate API"],
  [/\.evaluate\s*\(\s*\{\s*async\s*:\s*true\s*\}\s*\)/, "obsolete Roll.evaluate async option"],
  [/\.bringToTop\s*\(/, "V14-removed ApplicationV2.bringToTop"],
  [/\bAudioContainer\b/, "V14-removed AudioContainer"],
  [/\bfoundry\.prosemirror\.defaultPlugins\b/, "V14-deprecated ProseMirror defaultPlugins"],
  [/\bfoundry\.utils\.objectsEqual\b/, "V14-removed objectsEqual helper"],
  [/\bfoundry\.data\.regionShapes\.RegionPolygonTree\b/, "V14-removed RegionPolygonTree namespace"],
  [/\bCONFIG\.[A-Za-z0-9_]+\.layerClass\b/, "V14-deprecated Canvas CONFIG layerClass"],
  [/\bCONST\.(?:CHAT_MESSAGE_TYPES|DOCUMENT_TYPES)\b/, "V14-removed legacy document/chat constants"],
  [/\bCONST\.CHAT_MESSAGE_STYLES\.(?:ROLL|WHISPER)\b/, "V14-removed legacy chat styles"],
  [/\bgame(?:\.system)?\.template\b/, "V14-removed game/system template data"],
  [/\bnew\s+TextureData\s*\(\s*["']/, "V14-removed TextureData string constructor"],
  [/[{,]\s*["'](?:-=|==)[^"']*["']\s*:/, "V14-deprecated DataModel special operation keys"],
  [/globalThis\.(?:AmbientLightConfig|AmbientSoundConfig|BaseGrid|Coin|DarknessSource|DiceTerm|Die|FateDie|GlobalLightSource|GridHex|HexagonalGrid|LightSource|MathTerm|MersenneTwister|MovementSource|NumericTerm|OperatorTerm|ParentheticalTerm|PermissionConfig|PoolTerm|RollTerm|Sound|SoundSource|SquareGrid|StringTerm|UserConfig|VisionSource|WordTree|twist)\b/, "V14-removed V12 global redirect"]
];

for (const file of files) {
  if (file === adapterPath) continue;
  const source = readFileSync(file, "utf8");
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(source, pattern, `${relative(file)} must not use ${label}`);
  }
}

const forbiddenTemplateHelpers = [
  [/\{\{\s*#\s*select\b/i, "V14-removed {{#select}} helper"],
  [/\{\{\s*colorPicker\b/i, "V14-removed colorPicker helper"],
  [/\{\{\s*filePicker\b/i, "deprecated filePicker helper"],
  [/\{\{\s*selectOptions\b[^}]*\bnameAttr\s*=/i, "V14-removed selectOptions nameAttr parameter"]
];

for (const file of templates) {
  const source = readFileSync(file, "utf8");
  for (const [pattern, label] of forbiddenTemplateHelpers) {
    assert.doesNotMatch(source, pattern, `${relative(file)} must not use ${label}`);
  }
}

const mainSource = readFileSync(path.join(root, "scripts/main.js"), "utf8");
const templatePreloadSource = readFileSync(path.join(root, "scripts/apps/template-preload.js"), "utf8");
const lazyAppsSource = readFileSync(path.join(root, "scripts/apps/lazy-apps.js"), "utf8");
const uniqueBuildingBaseSource = readFileSync(path.join(root, "scripts/apps/unique-buildings/base-app.js"), "utf8");
const templateBrowserSource = readFileSync(path.join(root, "scripts/apps/editors/template-browser.js"), "utf8");
assert.doesNotMatch(mainSource, /\bloadTemplates\s*\(/, "main.js must not use the deprecated loadTemplates global");
assert.match(mainSource, /ensureSkyholdTemplateGroup\("core"\)/, "main.js must eagerly preload only the core template group");
assert.match(templatePreloadSource, /preloadFoundryTemplates\(paths\)/, "template groups must load through the V13/V14 adapter");
assert.doesNotMatch(templatePreloadSource, /\bglobalThis\.loadTemplates\b|\bwindow\.loadTemplates\b/, "template groups must not use a deprecated global loader");
assert.match(lazyAppsSource, /loadBuildingEditorClass[\s\S]{0,300}ensureSkyholdTemplateGroup\("buildingEditor"\)/, "building editor must load its partials before first render");
assert.match(lazyAppsSource, /openMassCombatApp[\s\S]{0,360}ensureSkyholdTemplateGroup\("massCombat"\)/, "mass combat must load its partials before first render");
assert.match(uniqueBuildingBaseSource, /_prepareContext\(options\)[\s\S]{0,120}ensureSkyholdTemplateGroup\("uniqueBuilding"\)/, "unique building windows must load their partials before first render");
assert.match(templateBrowserSource, /class SkyholdBuildingTemplateEditor[\s\S]{0,500}_prepareContext\(options\)[\s\S]{0,120}ensureSkyholdTemplateGroup\("buildingEditor"\)/, "building template editor must load shared editor partials before first render");

const sceneNotesSource = readFileSync(path.join(root, "scripts/integrations/scene-notes.js"), "utf8");
assert.doesNotMatch(sceneNotesSource, /Hooks\.on\("clickNote"/, "scene notes must not register the undocumented clickNote hook");
assert.match(sceneNotesSource, /Hooks\.on\("dropCanvasData"/, "scene-note drops must use the public V13/V14 dropCanvasData hook");
assert.match(sceneNotesSource, /Hooks\.on\("hoverNote"/, "scene-note hover behavior must use the public placeable hook");
assert.match(sceneNotesSource, /clientCoordinatesFromCanvas/, "scene-note tooltips must use the public Canvas coordinate adapter");
assert.doesNotMatch(sceneNotesSource, /\bcanvas\?*\.app\b|globalThis\.PIXI\b|\bnote\?*\.controlIcon\b|\._icon\b|\.worldTransform\b/, "scene notes must not depend on private PIXI/Canvas internals");
const noteDataBlock = sceneNotesSource.match(/const noteData = \{([\s\S]*?)\n\s*\};/)?.[1] ?? "";
assert.ok(noteDataBlock, "scene notes must declare a Note document payload");
assert.match(noteDataBlock, /\btexture\s*:\s*\{\s*src\s*:\s*texture\s*\}/, "scene notes must use the V13/V14 Note texture schema");
assert.match(noteDataBlock, /\bglobal\s*:\s*false\b/, "scene notes must keep building notes scene-local");
assert.doesNotMatch(noteDataBlock, /^\s*(?:icon|hidden|locked)\s*:/m, "scene notes must not write unsupported Note document fields");
const paletteSource = readFileSync(path.join(root, "styles/parts/skyhold-variables.css"), "utf8");
const strongTextColor = paletteSource.match(/--fbls-text-strong:\s*(#[\da-f]{6})\s*;/i)?.[1];
const noteTextColor = noteDataBlock.match(/\btextColor:\s*"(#[\da-f]{6})"/i)?.[1];
assert.ok(strongTextColor, "the shared strong-text color must be defined in the palette");
assert.equal(noteTextColor?.toLowerCase(), strongTextColor.toLowerCase(), "new building Notes must use the shared strong-text color");

const manifest = JSON.parse(readFileSync(path.join(root, "module.json"), "utf8"));
assert.equal(Number.parseInt(manifest.compatibility?.minimum, 10), 13, "module must keep Foundry V13 as its minimum");
assert.ok(Number.parseInt(manifest.compatibility?.verified, 10) >= 14, "module must declare V14 verification after the compatibility pass");
const forbiddenLands = manifest.relationships?.systems?.find((entry) => entry?.id === "forbidden-lands");
assert.ok(forbiddenLands, "module must declare its Forbidden Lands system relationship");
assert.equal(Number.parseInt(forbiddenLands.compatibility?.minimum, 10), 13, "module must keep Forbidden Lands 13 as its minimum system version");
assert.ok(Number.parseInt(forbiddenLands.compatibility?.verified, 10) >= 14, "module must declare verification against the V14-compatible Forbidden Lands system");
assert.equal(forbiddenLands.compatibility?.maximum, undefined, "module must not block either supported Forbidden Lands generation with a maximum");

const calls = [];
class MockApplicationV2 {
  render(options) { calls.push(["sheet-v2", options]); return this; }
}
class MockApplicationV1 {
  render(force) { calls.push(["sheet-v1", force]); return this; }
}
class MockFilePicker {
  constructor(options) { this.options = options; }
  render(options) { calls.push(["picker", options]); return this; }
}
class MockActor {}
MockActor.implementation = { fromDropData: async () => "actor" };
class MockItem {}
MockItem.implementation = { fromDropData: async () => "item" };
class MockRoll {}
const MockChatMessage = {
  create: async (data, options) => ({ data, options }),
  getSpeaker: (options) => ({ alias: options.alias }),
  getWhisperRecipients: () => [{ id: "gm" }]
};

const previousFoundry = globalThis.foundry;
const templateLoadCalls = [];
globalThis.foundry = {
  applications: {
    api: { ApplicationV2: MockApplicationV2, DialogV2: { confirm: async () => true } },
    apps: { FilePicker: MockFilePicker },
    handlebars: { loadTemplates: async (paths) => { templateLoadCalls.push([...paths]); return paths; } }
  },
  audio: { AudioHelper: { play: (data, socketOptions) => ({ data, socketOptions }) } },
  dice: { Roll: MockRoll },
  documents: { Actor: MockActor, ChatMessage: MockChatMessage, Item: MockItem },
  utils: { fromUuid: async (uuid) => ({ uuid }) }
};

try {
  const api = await import(`${pathToFileURL(adapterPath).href}?compat-check=${Date.now()}`);
  assert.equal(api.foundryDialogV2(), globalThis.foundry.applications.api.DialogV2);
  assert.equal(api.foundryFilePicker(), MockFilePicker);
  api.renderFoundryFilePicker({ type: "image" });
  assert.deepEqual(calls, [["picker", { force: true }]]);
  api.renderFoundryDocumentSheet({ sheet: new MockApplicationV2() });
  api.renderFoundryDocumentSheet({ sheet: new MockApplicationV1() });
  assert.deepEqual(calls, [
    ["picker", { force: true }],
    ["sheet-v2", { force: true, focus: true }],
    ["sheet-v1", true]
  ]);
  assert.equal(api.renderFoundryDocumentSheet(null), null);
  assert.deepEqual(await api.preloadFoundryTemplates(["one.hbs"]), ["one.hbs"]);
  const templatePreload = await import(`${pathToFileURL(path.join(root, "scripts/apps/template-preload.js")).href}?compat-check=${Date.now()}`);
  const assertTemplateClosure = (group, rootTemplates) => {
    const registered = new Set(templatePreload.SKYHOLD_TEMPLATE_GROUPS[group]);
    const queue = [...rootTemplates];
    const visited = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (visited.has(file)) continue;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/{{>\s*["']([^"']+)["']/g)) {
        const spec = match[1];
        assert.ok(registered.has(spec), `${group} template group must preload transitive partial ${spec}`);
        const relativeSpec = spec.replace(/^modules\/fbl-skyhold\//, "");
        queue.push(path.join(root, relativeSpec));
      }
    }
  };
  assertTemplateClosure("core", [path.join(root, "templates/skyhold-app.hbs")]);
  assertTemplateClosure("buildingEditor", [path.join(root, "templates/building-editor.hbs")]);
  assertTemplateClosure("uiReview", [path.join(root, "templates/ui-review-app.hbs")]);
  assertTemplateClosure("uniqueBuilding", [
    path.join(root, "templates/unique-buildings/medical.hbs"),
    path.join(root, "templates/unique-buildings/fasti-shop.hbs")
  ]);
  assertTemplateClosure("massCombat", [path.join(root, "templates/mass-combat.hbs")]);
  await templatePreload.ensureSkyholdTemplateGroup("buildingEditor");
  await templatePreload.ensureSkyholdTemplateGroup("buildingEditor");
  assert.equal(templateLoadCalls.length, 2, "a lazy template group must load once in addition to the direct adapter fixture");
  assert.ok(templateLoadCalls[1].every((entry) => entry.includes("/templates/parts/building-editor/")
    || entry === "modules/fbl-skyhold/templates/parts/save-status.hbs"), "building editor lazy preload must contain only its own partials and the shared save chip");
  assert.deepEqual(api.foundryChatSpeaker({ alias: "Skyhold" }), { alias: "Skyhold" });
  assert.deepEqual(api.foundryWhisperRecipients("GM"), [{ id: "gm" }]);
  assert.deepEqual(await api.createFoundryChatMessage({ content: "ok" }), { data: { content: "ok" }, options: {} });
  assert.deepEqual(await api.resolveFoundryUuid("Actor.one"), { uuid: "Actor.one" });
  assert.equal(api.foundryActorClass(), MockActor);
  assert.equal(api.foundryItemClass(), MockItem);
  assert.equal(api.foundryRollClass(), MockRoll);
  assert.deepEqual(api.playFoundryAudio({ src: "sound.ogg" }, false), { data: { src: "sound.ogg" }, socketOptions: false });
} finally {
  if (previousFoundry === undefined) delete globalThis.foundry;
  else globalThis.foundry = previousFoundry;
}

console.log(`FBL Skyhold Foundry compatibility: ${files.length} runtime JS files and ${templates.length} HBS templates; Foundry V13 minimum/V14 verified; Forbidden Lands 13-14. All checks passed.`);
