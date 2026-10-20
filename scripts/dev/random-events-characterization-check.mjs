import assert from "node:assert/strict";
import {
  contextualRandomEventWeight,
  eventRequirementFacts,
  evaluateEventRequirement,
  holdingRandomEventTags,
  normalizeEventTagThresholds,
  randomEventContext,
  rollRandomEventTable
} from "../data/random-events.js";
import { newEventRow, newRequirement } from "../apps/editors/random-event/draft.js";
import {
  eventPreviewFromFacts,
  prepareRowContext,
  prepareTableControls,
  prepareTableSummary,
  rowSearchText,
  tagsFromEventFacts
} from "../apps/editors/random-event/context.js";

function baseHolding() {
  return {
    type: "skyhold",
    overview: {
      region: "",
      development: { food: 0, technology: 0, culture: 0, war: 0 },
      reputation: 0
    },
    people: { list: [{ id: "p1", dead: false }] },
    buildings: { list: [] },
    storage: { resources: [], items: [] },
    gm: { modifiers: {}, defense: { squads: [] } },
    __eventMorale: 0,
    __eventReputation: 0
  };
}

export function checkRandomEventsCharacterization() {
  const holding = baseHolding();
  const tags = holdingRandomEventTags(holding);
  assert.equal(tags.has("people"), false, "living residents must not create a redundant people event tag");
  assert.equal(tags.has("sky-island"), true, "skyhold event context must expose the sky-island tag");
  assert.equal(tags.has("low-culture"), true, "zero culture must expose the low-culture dependency tag");

  const lowCultureRow = { weight: 10, tags: "+low-culture", text: "Low culture event" };
  assert.ok(contextualRandomEventWeight(lowCultureRow, holding) > 0, "events requiring low culture must roll for culture 0");
  const culturedHolding = baseHolding();
  culturedHolding.overview.development.culture = 1;
  assert.equal(contextualRandomEventWeight(lowCultureRow, culturedHolding), 0, "events requiring low culture must not roll for culture 1+");

  const tunedCultureHolding = baseHolding();
  tunedCultureHolding.gm.eventTagThresholds = { culture: { lowMax: 2, highMin: 6 } };
  tunedCultureHolding.overview.development.culture = 2;
  assert.equal(holdingRandomEventTags(tunedCultureHolding).has("low-culture"), true, "custom low culture threshold must expose low-culture through the configured value");
  assert.ok(contextualRandomEventWeight(lowCultureRow, tunedCultureHolding) > 0, "events requiring low culture must use the configured low threshold");
  tunedCultureHolding.overview.development.culture = 3;
  assert.equal(contextualRandomEventWeight(lowCultureRow, tunedCultureHolding), 0, "events requiring low culture must stop after the configured low threshold");
  tunedCultureHolding.overview.development.culture = 6;
  assert.equal(holdingRandomEventTags(tunedCultureHolding).has("high-culture"), true, "custom high culture threshold must expose high-culture from the configured value");
  assert.equal(normalizeEventTagThresholds({ culture: { lowMax: 5, highMin: 3 } }).culture.highMin, 6, "high threshold must stay above the low threshold");

  const operatorHolding = baseHolding();
  operatorHolding.overview.development.culture = 2;
  assert.equal(evaluateEventRequirement({ type: "development", key: "culture", operator: "lte", number: 1 }, operatorHolding).ok, false, "lte must not behave like gte");
  assert.equal(evaluateEventRequirement({ type: "development", key: "culture", operator: "lte", number: 2 }, operatorHolding).ok, true, "lte must pass when the actual value equals the threshold");
  assert.equal(evaluateEventRequirement({ type: "development", key: "culture", operator: "gte", number: 3 }, operatorHolding).ok, false, "gte must not behave like lte");
  assert.equal(evaluateEventRequirement({ type: "development", key: "culture", operator: "gte", number: 2 }, operatorHolding).ok, true, "gte must pass when the actual value equals the threshold");

  const anyLogicRow = {
    weight: 10,
    requirements: {
      logic: "any",
      rules: [
        { type: "development", key: "culture", operator: "gte", number: 99 },
        { type: "population", operator: "gte", number: 1 }
      ]
    },
    text: "Any logic event"
  };
  assert.equal(randomEventContext(anyLogicRow, operatorHolding).eligible, true, "any logic must pass when at least one requirement is true");
  const allLogicRow = { ...anyLogicRow, requirements: { ...anyLogicRow.requirements, logic: "all" } };
  assert.equal(randomEventContext(allLogicRow, operatorHolding).eligible, false, "all logic must require every requirement");

  const storageRow = { weight: 10, tags: "storage", text: "Storage event" };
  assert.equal(randomEventContext(storageRow, holding).eligible, true, "soft storage matches must not block an event without storage context");
  assert.equal(contextualRandomEventWeight(storageRow, holding), 10, "soft storage matches must keep base weight without storage context");

  const holdingWithStorage = baseHolding();
  holdingWithStorage.buildings.list.push({
    id: "storehouse",
    constructionStatus: "built",
    functions: { storage: true },
    storage: { capacity: 12 }
  });
  assert.ok(contextualRandomEventWeight(storageRow, holdingWithStorage) > 10, "soft storage matches must increase weight when a storage building exists");
  const noStorageRow = { weight: 10, tags: "!storage", text: "No storage event" };
  assert.equal(contextualRandomEventWeight(noStorageRow, holdingWithStorage), 0, "blocked tags must suppress events when the holding has that tag");

  const blackDesertRow = { weight: 10, tags: "+black-desert,monster", text: "Black desert event" };
  assert.equal(randomEventContext(blackDesertRow, holding).eligible, false, "world-specific events must not roll without a matching world tag");

  const blackDesertHolding = baseHolding();
  blackDesertHolding.overview.region = "black-desert";
  assert.equal(randomEventContext(blackDesertRow, blackDesertHolding).eligible, true, "world-specific events must roll when the matching region is present");

  const customRegionRow = {
    weight: 10,
    requirements: { logic: "all", rules: [{ type: "region", operator: "is", value: "custom-region" }] },
    text: "Custom region event"
  };
  const customRegionHolding = baseHolding();
  customRegionHolding.overview.region = "custom-region";
  const customRegionOptions = [{ value: "custom-region", label: "Custom Region", aliases: "" }];
  assert.equal(randomEventContext(customRegionRow, customRegionHolding, { regionOptions: customRegionOptions }).eligible, true, "custom catalog regions must satisfy structured region requirements");

  const table = {
    id: "general",
    rows: [
      storageRow,
      { weight: 1, tags: "people", text: "Ignored people event" }
    ]
  };
  assert.equal(rollRandomEventTable(table, holding, { random: () => 0 })?.row?.text, "Storage event", "soft context rows must remain in the roll pool");

  const cooldownHolding = baseHolding();
  cooldownHolding.gm.eventHistory = [{ id: "cool-row" }];
  const cooldownRow = { id: "cool-row", weight: 10, cooldown: 1, text: "Cooldown event" };
  assert.equal(randomEventContext(cooldownRow, cooldownHolding).eligible, false, "cooldown must block recently rolled events");

  const newExternalRow = newEventRow("external");
  assert.equal(newExternalRow.weight, 3, "external event drafts must keep their lower default weight");
  assert.equal(newExternalRow.requirements.logic, "all", "new event drafts must start with all requirement logic");
  const customRegionRequirement = newRequirement("region", [], customRegionOptions);
  assert.equal(customRegionRequirement.value, "custom-region", "new region requirements must select the first configured region");

  const editorFacts = eventRequirementFacts(holdingWithStorage);
  const previewRow = {
    id: "editor-preview",
    weight: 10,
    title: "Storage pressure",
    text: "Inspect the stores",
    requirements: { logic: "all", rules: [{ type: "population", operator: "gte", number: 1 }] },
    boosts: { logic: "any", rules: [{ type: "feature", operator: "has", value: "storage" }] }
  };
  const editorPreview = eventPreviewFromFacts(previewRow, editorFacts);
  assert.equal(editorPreview.eligible, true, "editor preview must preserve requirement eligibility");
  assert.equal(editorPreview.matches, 1, "editor preview must preserve contextual boost matches");
  assert.ok(editorPreview.weight > previewRow.weight, "editor preview must apply contextual weight boosts");
  assert.equal(tagsFromEventFacts(editorFacts).has("storage"), true, "editor fact tags must include storage features");
  assert.match(rowSearchText(previewRow), /storage pressure/, "editor search text must include the event title");

  const preparedRow = prepareRowContext(previewRow, 2, { full: true, facts: editorFacts });
  assert.equal(preparedRow.displayIndex, 3, "prepared editor rows must expose one-based display indexes");
  assert.equal(preparedRow.requirementRules.length, 1, "full editor rows must expose prepared requirement controls");
  assert.equal(preparedRow.boostRules.length, 1, "full editor rows must expose prepared boost controls");
  assert.equal(prepareTableSummary("general", { rows: [previewRow] }, "general").active, true, "table summaries must preserve the active table");
  assert.ok(prepareTableControls([], customRegionOptions).regionOptions.some((option) => option.selected), "table controls must select a configured region default");
}
