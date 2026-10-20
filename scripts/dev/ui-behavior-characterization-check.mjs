import assert from "node:assert/strict";
import "./ship-ui-review-check.mjs";
import { readFileSync } from "node:fs";
import { UI_AUDIT_PROPOSALS, UI_ROW_CARD_PROPOSALS, UI_BUILDING_EDITOR_PROPOSALS, createUiReviewDraft, countUiReviewDecisions, formatUiReviewSummary } from "../apps/domains/ui-review-proposals.js";
import { createReviewBuildingCases } from "../apps/domains/ui-review-building-samples.js";
import { createEditorReviewContext, inertEditorReviewHtml, renderEditorReviewSample } from "../apps/domains/ui-review-editor-samples.js";
import { buildingPickerValues, editorListPicker, prepareTradePickers, projectParticipantPicker, tradeCategoryOptions } from "../apps/domains/building-editor-pickers.js";
import { ShipOrderPlanner } from "../apps/ship-order-planner.js";
import { selectionSummary, syncSelectionSummary } from "../apps/common/selection-summary.js";
import { DisclosureState } from "../apps/common/disclosure-state.js";
import { workerProfileEditorContext } from "../apps/editors/worker-profile-editor.js";
import { residentTraitTooltip, residentTraitVisibleCount } from "../apps/common/resident-trait-chips.js";

assert.equal(residentTraitTooltip({ name: " Лидер ", description: " Ведёт за собой. " }), "Лидер\nВедёт за собой.");
assert.equal(residentTraitTooltip({ name: "<Пользовательская черта>" }), "<Пользовательская черта>", "custom names remain text, including names without a description");
assert.equal(residentTraitTooltip(), "");
const traitWidths = [19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19];
const counterWidth = count => String(count).length * 7 + 20;
assert.equal(residentTraitVisibleCount(traitWidths, 250, 2, counterWidth), 12, "all fitting traits remain visible without a counter");
assert.equal(residentTraitVisibleCount(traitWidths, 100, 2, counterWidth), 3, "the counter must reserve its own width and the intervening gap");
assert.equal(residentTraitVisibleCount(traitWidths, 34, 2, counterWidth), 0, "an indicator alone must still expose all hidden traits");
assert.equal(residentTraitVisibleCount(traitWidths, 48, 2, counterWidth), 0, "a two-digit hidden count cannot overlap the last visible chip");
assert.equal(residentTraitVisibleCount(traitWidths, 90, 2, counterWidth), 3, "crossing from ten hidden traits to nine must use the actual counter width");
assert.equal(residentTraitVisibleCount([19], 19, 2, counterWidth), 1);
assert.equal(residentTraitVisibleCount([19], 10, 2, counterWidth), 0);
assert.equal(residentTraitVisibleCount([], 0, 2, counterWidth), 0);
assert.deepEqual(traitWidths, Array(12).fill(19), "fitting must not change source trait order or values");

const selectedNames = ["Лидер", "Прирождённый строитель", "<Нестандартная черта>"];
assert.deepEqual(selectionSummary(selectedNames), { first: "Лидер", additional: 2, label: "Лидер +2", tooltip: selectedNames.join(", ") });
assert.equal(selectedNames.length, 3, "compact presentation must retain the complete list");
const summaryText = {};
const summaryCount = {};
const summaryNode = { dataset: {}, querySelector: selector => selector.includes("count") ? summaryCount : summaryText, setAttribute(key, value) { this[key] = value; } };
const summaryRoot = { querySelector: () => summaryNode };
syncSelectionSummary(summaryRoot, selectedNames.slice(1), "Черт нет");
assert.equal(summaryText.textContent, "Прирождённый строитель");
assert.equal(summaryCount.textContent, "+1", "the count stays separate so truncation cannot hide it");
assert.equal(summaryCount.hidden, false);
assert.match(summaryNode.dataset.fblsTooltip, /<Нестандартная черта>/);
assert.match(summaryNode["aria-label"], /Прирождённый строитель/);
syncSelectionSummary(summaryRoot, [], "Черт нет");
assert.equal(summaryText.textContent, "Черт нет", "removing the last chip must update the closed field too");
assert.equal(summaryCount.hidden, true);
syncSelectionSummary(null, selectedNames);
const profileSummary = workerProfileEditorContext({ workerProfile: { source: "custom", composition: [{ backgrounds: selectedNames, count: 2 }] } }).compositionRows[0];
assert.equal(profileSummary.selectedSummary.label, "Лидер +2");
assert.equal(profileSummary.selectedText, selectedNames.join(", "));
assert.equal(profileSummary.count, 2, "the compact label cannot change the required headcount");
class SelectedDisclosure extends globalThis.EventTarget {
  constructor(key) { super(); this.dataset = { fblsDisclosure: key }; this.open = false; }
}
const selectionDisclosures = new DisclosureState();
const oldSelectedField = new SelectedDisclosure("resident-traits-person-1");
selectionDisclosures.bind({ querySelectorAll: () => [oldSelectedField] });
oldSelectedField.open = true;
const newSelectedField = new SelectedDisclosure("resident-traits-person-1");
const differentPersonField = new SelectedDisclosure("resident-traits-person-2");
selectionDisclosures.bind({ querySelectorAll: () => [newSelectedField, differentPersonField] });
assert.equal(newSelectedField.open, true, "rerender retains expansion even before the native toggle event");
assert.equal(differentPersonField.open, false, "expansion must not leak between residents");
oldSelectedField.open = false;
oldSelectedField.dispatchEvent(new Event("toggle"));
assert.equal(selectionDisclosures.states.get("resident-traits-person-1"), true, "stale render listeners are removed");
selectionDisclosures.close();

const draft = createUiReviewDraft();
const participantPicker = projectParticipantPicker({ participantIds: ["dead", "external", "external"] }, { people: { list: [
  { id: "alive", name: "Руна" }, { id: "dead", name: "Хальвард", dead: true }, { id: "other-dead", name: "Бёрн", dead: true }
] } }, "holdings.0.buildings.list.0.serviceProjects.0.participantIds");
assert.deepEqual(participantPicker.choices.filter(row => row.selected).map(row => row.value).sort(), ["dead", "external"]);
assert.ok(participantPicker.choices.some(row => row.value === "alive"));
assert.ok(!participantPicker.choices.some(row => row.value === "other-dead"));
const categoryChoices = tradeCategoryOptions([{ categoryTag: "food.raw", marketTags: ["custom-tag"] }], [{ income: { trade: { allowedTags: ["old-tag"] } } }], ["unknown-tag"]);
for (const value of ["all", "food.raw", "custom-tag", "old-tag", "unknown-tag"]) assert.ok(categoryChoices.some(row => row.value === value));
const tradeExample = { basePath: "catalog.buildings.0", income: { trade: { allowedTagsText: "unknown-tag", sourceIdsText: "external", service: { categoryTag: "legacy-service" } } } };
prepareTradePickers(tradeExample, categoryChoices);
assert.ok(tradeExample.income.trade.serviceCategoryOptions.some(row => row.value === "legacy-service" && row.selected));
assert.ok(tradeExample.income.trade.sourceIdsPicker.choices.some(row => row.value === "external" && row.selected));
assert.deepEqual(editorListPicker("demo", [], [], { all: true }).choices.map(row => row.value), ["all"]);
const allPicker = { dataset: { buildingListAll: "true" }, querySelectorAll: () => [{ value: "all" }, { value: "food.raw" }] };
assert.deepEqual(buildingPickerValues({ value: "food.raw", checked: true, closest: () => allPicker }), ["food.raw"], "specific categories must remove unrestricted all");
assert.deepEqual(buildingPickerValues({ value: "all", checked: true, closest: () => allPicker }), ["all"], "selecting all must clear specific categories");
allPicker.querySelectorAll = () => [];
assert.deepEqual(buildingPickerValues({ value: "food.raw", checked: false, closest: () => allPicker }), ["all"], "clearing the final restriction preserves unrestricted trade semantics");
assert.deepEqual(buildingPickerValues({ value: "runa, halvard", closest: () => null }), ["runa", "halvard"], "manual target-ID lists retain their existing parser");
assert.equal(countUiReviewDecisions(draft), 13, "explicit approval of every editor tab is recorded");
assert.ok(UI_ROW_CARD_PROPOSALS.every(({ id }) => draft.decisions[id].choice === (id.startsWith("cards-") ? "keep" : "agree")));
assert.match(draft.decisions["rows-chips"].note, /контрастном фоне/);
assert.match(draft.decisions["behavior-save"].note, /правом верхнем углу.*без отдельной строки/);
assert.equal(UI_AUDIT_PROPOSALS.length, 10);
assert.equal(draft.decisions["audit-type"].choice, "custom", "previous user decisions must survive the new batch");
assert.match(draft.decisions["audit-type"].note, /Светлый/);
assert.equal(draft.decisions["behavior-save"].choice, "agree", "approved saving feedback remains in the archive");
assert.match(formatUiReviewSummary(draft), /Карточки зданий: прежний вид сохранён/);
assert.doesNotMatch(formatUiReviewSummary(draft), /отложены|Состояние сохранения:/);
draft.decisions[UI_BUILDING_EDITOR_PROPOSALS[0].id] = { choice: "custom", note: "Ряды\nкомпактнее" };
assert.equal(countUiReviewDecisions(draft), 13);
assert.match(formatUiReviewSummary(draft), /Свой вариант — Ряды компактнее/);
assert.doesNotMatch(formatUiReviewSummary(draft), /Поля остальных редакторов:/, "copied decisions must belong to the current batch");
assert.doesNotMatch(formatUiReviewSummary(draft), /Списки чипов рядом с вводом:/, "archived approvals cannot leak into the new approval text");
assert.equal(UI_BUILDING_EDITOR_PROPOSALS.length, 13);
assert.equal(new Set(UI_BUILDING_EDITOR_PROPOSALS.map(row => row.id)).size, 13);
for (const proposal of UI_BUILDING_EDITOR_PROPOSALS) {
  const sample = createEditorReviewContext(proposal.tab);
  assert.equal(sample.building.editorTabs.length, 12);
  assert.equal(sample.canEdit, true);
  const view = createEditorReviewContext(proposal.tab, { permission: "view", kind: "template" });
  assert.equal(view.canEdit, false);
  assert.equal(view.isGM, false);
  assert.equal(view.building.isTemplate, true);
}
const sourceHookExample = '<select data-field="demo.name"><option>Имя &lt;чужое&gt;</option></select><select data-building-housing-field></select><i data-fbls-tooltip="Полное имя"></i><button data-action="roll" draggable="true"></button>';
const inertHookExample = inertEditorReviewHtml(sourceHookExample);
assert.doesNotMatch(inertHookExample, /\sdata-field=|\sdata-action=|\sdata-building-housing-field\b|\sdraggable=/);
assert.match(inertHookExample, /data-review-source-building-housing-field/);
assert.match(inertHookExample, /data-fbls-tooltip="Полное имя"/);
assert.match(inertHookExample, /Имя &lt;чужое&gt;/);
assert.equal(renderEditorReviewSample("housing", {}, { partials: { "modules/fbl-skyhold/templates/parts/building-editor/housing.hbs": () => sourceHookExample } }), inertHookExample);
const poultrySample = createEditorReviewContext("livestock", { flock: "hens" }).building.livestockView;
assert.equal(poultrySample.producesEggs, true);
assert.equal(poultrySample.producesMilk, false);
assert.equal(poultrySample.producesWool, false);
assert.equal(poultrySample.headcount, 11);
assert.ok(poultrySample.enabledPath);
const cattleSample = createEditorReviewContext("livestock", { flock: "cows" }).building.livestockView;
assert.equal(cattleSample.producesMilk, true);
assert.equal(cattleSample.producesWool, false);
const buildingsTemplate = readFileSync(new URL("../../templates/parts/skyhold-tab-buildings.hbs", import.meta.url), "utf8");
const cardStart = buildingsTemplate.indexOf('            <article class="fbls-building-card ');
const currentCard = buildingsTemplate.slice(cardStart, buildingsTemplate.indexOf("          {{else}}", cardStart))
  .replaceAll("data-action=", "data-review-inert-action=")
  .replaceAll("data-building-construction-crew", "data-review-inert-building-construction-crew")
  .replaceAll('draggable="true"', 'data-review-inert-draggable="true"').replace(/^            /gm, "").replaceAll("\r\n", "\n").trim();
const beforeSample = readFileSync(new URL("../../templates/parts/ui-review-building-current.hbs", import.meta.url), "utf8");
// The snapshot contains nested loops: compare the complete outer-loop body.
assert.equal(beforeSample.replace(/^[\s\S]*?{{#each currentBuildings}}\n/, "").replace(/{{\/each}}\s*$/, "").replaceAll("\r\n", "\n").trim(), currentCard,
  "the current-card comparison must match production markup, with only inert hooks changed");
assert.doesNotMatch(beforeSample, /\sdata-action=|\sdraggable=|\sdata-building-construction-crew\b/,
  "review samples must not dispatch building mutations or drag operations");

const previous = { foundry: globalThis.foundry, game: globalThis.game, Handlebars: globalThis.Handlebars,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
try {
  class Base { async _prepareContext() { return {}; } }
  globalThis.Handlebars = { partials: {}, registerHelper() {} };
  globalThis.foundry = { applications: { api: { ApplicationV2: Base, HandlebarsApplicationMixin: Parent => Parent }, handlebars: {
    loadTemplates: async paths => { for (const path of paths) globalThis.Handlebars.partials[path] = () => '<label>Пример<input data-field="demo.value"></label>'; }
  } } };
  globalThis.game = { user: { isGM: false } };
  const { SkyholdUiReviewApp } = await import("../apps/ui-review-app.js");
  const { SkyholdBuildingEditor } = await import("../apps/editors/building-editor.js");
  const realEditor = new SkyholdBuildingEditor();
  let scopedSaves = 0;
  realEditor._canEditBuilding = () => false;
  realEditor._saveTransaction = async () => { scopedSaves++; return true; };
  await realEditor._onBuildingStringListChange({ preventDefault() {}, currentTarget: {} });
  assert.equal(scopedSaves, 0, "read-only clients cannot save a picker selection");
  globalThis.foundry.utils = { setProperty: (data, path, value) => { data[path] = value; } };
  realEditor._canEditBuilding = () => true;
  realEditor._resolveBuildingScopedPath = (_data, path) => path;
  realEditor.requestRender = () => {};
  const localData = {};
  realEditor._saveTransaction = async (updater, options) => {
    scopedSaves++;
    assert.equal(options.scope, "holdings");
    assert.equal(options.reason, "building-editor:string-list:holdings.0.buildings.list.0.serviceProjects.0.participantIds");
    await updater(localData);
    return true;
  };
  const pickerField = { value: "astrid", checked: true, dataset: {}, closest: () => ({
    dataset: { buildingListPicker: "holdings.0.buildings.list.0.serviceProjects.0.participantIds" },
    querySelectorAll: () => [{ value: "runa" }, { value: "astrid" }],
    querySelector: selector => selector === "[data-building-list-search]" ? { value: "аст" } : { scrollTop: 12 }
  }) };
  await realEditor._onBuildingStringListChange({ preventDefault() {}, currentTarget: pickerField });
  assert.equal(scopedSaves, 1, "editable clients use the existing scoped save path once");
  assert.deepEqual(localData["holdings.0.buildings.list.0.serviceProjects.0.participantIds"], ["runa", "astrid"]);
  assert.equal(realEditor._pickerRestore.query, "аст");
  assert.equal(realEditor._pickerRestore.scroll, 12);
  SkyholdBuildingEditor.instances.delete(realEditor);
  assert.equal(SkyholdUiReviewApp.open(), null, "player clients must not open the GM review window");
  globalThis.game.user.isGM = true;
  const app = new SkyholdUiReviewApp();
  const context = await app._prepareContext({});
  assert.equal(context.proposalCount, 13);
  assert.equal(context.approvedAudits.length, 10);
  assert.equal(context.approvedBehaviors.length, 2);
  assert.ok(context.approvedBehaviors.every(row => row.status === "Внесено"));
  assert.ok(context.proposals.every(row => row.choices.filter(choice => choice.selected).length === 1));
  assert.ok(context.proposals.every(row => row.status === "Внесено"));
  assert.ok(context.proposals.every(row => row.sampleHtml.includes("data-review-source-field") && !row.sampleHtml.includes(" data-field=")));
  assert.equal(context.approvedRows.length, 6);
  assert.ok(context.approvedRows.every(row => row.status === (row.id.startsWith("cards-") ? "Оставлено" : "Внесено")));
  assert.ok(context.approvedRows.every(row => row.choices.filter(choice => choice.selected).length === 1));
  const cases = createReviewBuildingCases();
  assert.equal(new Set(cases.map(row => row.id)).size, 6);
  assert.ok(cases.some(row => row.isMedical && row.attention), "damaged medical buildings retain an explicit warning");
  assert.ok(cases.some(row => row.showBuildProgress && row.constructionCrewOptions.length), "construction keeps crew selection and progress");
  assert.ok(cases.some(row => row.hasPendingProduction), "pending production must be visible without opening details");

  const timers = new Map();
  let nextTimer = 0;
  globalThis.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
  globalThis.clearTimeout = id => timers.delete(id);
  const status = { dataset: {}, setAttribute(name, value) { this[name] = value; } };
  const save = {};
  const sample = { dataset: { reviewSaveMode: "auto" }, isConnected: true, querySelector: selector => selector.includes("status") ? status : save };
  app._setSaveDemoState(sample, "dirty");
  assert.equal(save.disabled, false);
  app._runSaveDemo(sample);
  assert.equal(save.disabled, true);
  assert.equal(status.textContent, "Авто · Сохраняется…");
  const complete = timers.get(nextTimer);
  timers.delete(nextTimer);
  complete();
  assert.equal(status.textContent, "Авто · Сохранено");
  app._runSaveDemo(sample);
  app._setSaveDemoState(sample, "error");
  assert.equal(timers.size, 0, "an earlier success must not overwrite a displayed failure");
  assert.equal(save.disabled, false, "the example must permit retry after a failure");
  app._runSaveDemo(sample);
  app._clearSaveDemoTimers();
  assert.equal(timers.size, 0, "closing/rerendering the review must cancel simulations");

  const output = { querySelectorAll: () => [], contains: () => false };
  const root = { querySelector: selector => selector === "[data-ship-planner-preview]" ? output : null, querySelectorAll: () => [] };
  const template = "modules/fbl-skyhold/templates/parts/ship-window/order-preview.hbs";
  globalThis.Handlebars = { partials: { [template]: () => '<button title="Новый план">План</button>' } };
  let rebound = 0;
  const planner = new ShipOrderPlanner({ holdingId: "missing", shipId: "missing", getData: () => ({ holdings: [] }),
    onPreviewRendered: updatedRoot => { assert.equal(updatedRoot, root); assert.match(output.innerHTML, /Новый план/); rebound++; } });
  planner.root = root;
  planner.update();
  planner.update();
  assert.equal(rebound, 2, "each dynamic preview replacement must rebind through the window owner");
  assert.equal(planner.selected.size, 0, "rebinding must not alter order selections");
  const mapPanel = { hidden: true };
  const mapButton = { setAttribute(key, value) { this[key] = value; } };
  root.querySelector = selector => ({ "[data-ship-planner-preview]": output, "[data-ship-planner-map]": mapPanel, "[data-ship-planner-map-toggle]": mapButton })[selector] ?? null;
  let renderedMapOpen = null;
  globalThis.Handlebars.partials[template] = context => { renderedMapOpen = context.mapOpen; return '<button title="Новый план">План</button>'; };
  planner.toggleMap();
  assert.equal(mapPanel.hidden, false);
  assert.equal(mapButton["aria-expanded"], "true");
  planner.update();
  assert.equal(renderedMapOpen, true, "quote refreshes preserve the expanded map independently of order selections");
  planner.clear();
  planner.update();
  assert.equal(renderedMapOpen, true, "clearing orders keeps the map open for the route overview");
  planner.toggleMap();
  assert.equal(mapPanel.hidden, true);
  assert.equal(mapButton["aria-expanded"], "false");
  planner.close();
  console.log("UI behavior: 13 approved building-editor proposals, inert GM/read-only examples, preserved row/card decisions, selection/disclosure lifecycle, GM gate, save cleanup and dynamic ship tooltip rebinding passed.");
} finally {
  Object.assign(globalThis, previous);
}
