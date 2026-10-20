import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { prepareRowContext } from "../apps/editors/random-event/context.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { DEFAULT_SKYHOLD_DATA } from "../data/defaults/default-skyhold-data.js";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { migrateData } from "../data/normalizers.js";
import {
  eventRequirementFacts,
  normalizeEventRegionOptions,
  normalizeEventTagThresholds
} from "../data/random-events.js";
import { prepareResourceCatalogEditor } from "../data/resources/resource-editor.js";
import { stableDataHash } from "../data/storage-commit.js";
import { clone } from "../data/utils.js";

const root = path.resolve(import.meta.dirname, "../..");

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function source(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

export function checkReadOnlyViewCharacterization() {
  const data = deepFreeze(migrateData(clone(DEFAULT_SKYHOLD_DATA)));
  const beforeHash = stableDataHash(data);
  const holdingId = String(data.holdings[0]?.id ?? "");
  const { holding, index } = findReadableHoldingEntry(data, holdingId, { fallback: false });
  assert.equal(index, 0, "read-only holding lookup must preserve the requested holding");
  assert.ok(holding, "read-only holding lookup must return a visible holding");

  assert.doesNotThrow(() => prepareResourceCatalogEditor(data.catalog.resources, { canEdit: true }), "resource editor projection must accept a frozen storage view");
  const regionOptions = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
  assert.doesNotThrow(() => normalizeMarketEconomy(data.catalog.marketEconomy, { locations: regionOptions }), "region/economy projections must accept a frozen storage view");
  const eventFacts = eventRequirementFacts(holding, { regionOptions });
  assert.doesNotThrow(() => eventRequirementFacts(holding, { regionOptions }), "event facts must accept a frozen holding view");
  assert.doesNotThrow(() => normalizeEventTagThresholds(holding?.gm?.eventTagThresholds), "event threshold projection must accept a frozen holding view");
  const eventRow = holding?.gm?.eventTables?.general?.rows?.[0] ?? {};
  assert.doesNotThrow(() => prepareRowContext(eventRow, 0, {
    full: true,
    facts: eventFacts,
    buildingTemplates: data.catalog.buildings,
    regionOptions,
    holding
  }), "random-event row/editor projections must accept frozen catalog and holding views");

  const assignmentReader = {
    ...AssignmentDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback
  };
  assert.doesNotThrow(() => assignmentReader._constructionCrews(holding), "crew projection must accept a frozen holding view");
  assert.doesNotThrow(() => assignmentReader._assignedWorkerSet(holding), "assignment lookup must accept a frozen holding view");
  assert.equal(stableDataHash(data), beforeHash, "read-only projections must not alter the shared storage cache root");

  const crewEditor = source("scripts/apps/editors/crew-editor.js");
  const resourceEditor = source("scripts/apps/editors/resource-catalog-editor.js");
  const regionEditor = source("scripts/apps/editors/region-catalog-editor.js");
  const eventEditor = source("scripts/apps/editors/random-event-editor.js");
  const eventContextEditor = source("scripts/apps/editors/random-event/context-editor.js");
  const registry = source("scripts/apps/unique-buildings/registry.js");
  const holdingDomain = source("scripts/apps/domains/holding-domain.js");
  assert.doesNotMatch(crewEditor, /SkyholdData\.get\(\)/, "crew editor reads are projection-only and must not clone the full root");
  assert.doesNotMatch(resourceEditor, /SkyholdData\.get\(\)/, "resource editor reads are projection-only and must not clone the full root");
  assert.doesNotMatch(regionEditor, /SkyholdData\.get\(\)/, "region editor reads are projection-only and must not clone the full root");
  assert.doesNotMatch(eventEditor, /SkyholdData\.get\(\)/, "random-event editor cache refresh must clone only its editable draft branch");
  assert.doesNotMatch(eventContextEditor, /SkyholdData\.get\(\)/, "random-event context is a projection-only read");
  assert.doesNotMatch(registry, /SkyholdData\.get\(\)/, "unique building registry must only read ids from the storage view");
  assert.doesNotMatch(holdingDomain, /SkyholdData\.get\(\)/, "holding-domain lookups must not clone the full root before a separate transaction");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkReadOnlyViewCharacterization();
  console.log("FBL Skyhold read-only view characterization passed.");
}
