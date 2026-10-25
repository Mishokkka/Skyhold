import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkBuildingTemplateCatalog } from "../building-catalog-check.mjs";
import { Linter } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SKIPPED_DIRS = new Set([".git", ".agents", ".codex", ".codex-tmp", "node_modules", "dist"]);

function walk(dir, predicate = () => true, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIPPED_DIRS.has(entry)) continue;
      walk(full, predicate, output);
    }
    else if (predicate(full)) output.push(full);
  }
  return output;
}

function rel(file) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertJsonEqual(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

const engineGlobals = ["globalThis", "game", "foundry", "ChatMessage", "document", "window", "ui", "SkyholdApp"];
const engineLinter = new Linter();

function assertNoEngineGlobals(source, message) {
  const errors = engineLinter.verify(source, {
    languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: Object.fromEntries(engineGlobals.map((name) => [name, "readonly"])) },
    rules: { "no-restricted-globals": ["error", ...engineGlobals] }
  });
  assert.deepEqual(errors.map(({ line, column, message: detail }) => `${line}:${column} ${detail}`), [], message);
}

function checkEngineGlobalAssertions() {
  assertNoEngineGlobals('const quote = `game:${1}`; // game, foundry and window are labels here', "literal labels must not count as platform access");
  for (const name of engineGlobals) {
    assert.throws(() => assertNoEngineGlobals(`${name}.settings;`, "platform access"), assert.AssertionError, `${name} access must be rejected`);
    assert.throws(() => assertNoEngineGlobals(`const label = \`quote:\${${name}.settings}\`;`, "platform access"), assert.AssertionError, `${name} in a template expression must be rejected`);
  }
}

function checkSchemaVersionSource(jsFiles) {
  const canonicalFile = path.join(root, "scripts/data/schema-version.js");
  const definitionPattern = /\b(?:export\s+)?const\s+SKYHOLD_SCHEMA_VERSION\s*=/;
  const definitions = jsFiles.filter((file) => definitionPattern.test(readFileSync(file, "utf8")));
  assert.deepEqual(definitions, [canonicalFile], "SKYHOLD_SCHEMA_VERSION must be defined only in scripts/data/schema-version.js");

  const canonicalSource = readFileSync(canonicalFile, "utf8");
  assert.match(canonicalSource, /export\s+const\s+SKYHOLD_SCHEMA_VERSION\s*=\s*[1-9]\d*\s*;/, "canonical schema version must be a positive integer");

  const defaultSource = readFileSync(path.join(root, "scripts/data/defaults/default-skyhold-data.js"), "utf8");
  assert.doesNotMatch(defaultSource, /\bschemaVersion\s*:\s*\d+/, "default data must not hardcode a schema version");
}

function checkDataModuleBoundaries(jsFiles) {
  const schemaFacade = readFileSync(path.join(root, "scripts/data/schema.js"), "utf8");
  const baseSchema = readFileSync(path.join(root, "scripts/data/schema/base-holding.js"), "utf8");
  const defaultData = readFileSync(path.join(root, "scripts/data/defaults/default-skyhold-data.js"), "utf8");
  const workerTypes = readFileSync(path.join(root, "scripts/data/worker-types.js"), "utf8");
  const laputaCompatibility = readFileSync(path.join(root, "scripts/data/laputa-import.js"), "utf8");
  const laputaPreset = readFileSync(path.join(root, "scripts/data/presets/laputa.js"), "utf8");

  assert.match(schemaFacade, /from "\.\/defaults\/default-skyhold-data\.js"/, "schema facade must preserve the default data compatibility export");
  assert.match(schemaFacade, /from "\.\/schema\/base-holding\.js"/, "schema facade must preserve base holding compatibility exports");
  assert.match(schemaFacade, /from "\.\/worker-types\.js"/, "schema facade must preserve worker type compatibility exports");
  assert.doesNotMatch(schemaFacade, /\b(?:const|let|var)\s+(?:BASE_HOLDING|DEFAULT_SKYHOLD_DATA|CANONICAL_WORKER_TYPES)\b/, "schema facade must not regain canonical data ownership");

  assert.match(baseSchema, /export const BASE_HOLDING\s*=/, "base holding schema must own BASE_HOLDING");
  assert.match(baseSchema, /export const HOLDING_TYPES\s*=/, "base holding schema must own HOLDING_TYPES");
  assert.doesNotMatch(baseSchema, /LAPUTA_IMPORT|DEFAULT_SKYHOLD_DATA|CANONICAL_WORKER_TYPES/, "base holding schema must stay campaign-agnostic");

  assert.match(workerTypes, /export const CANONICAL_WORKER_TYPES\s*=/, "worker-types.js must own canonical worker types");
  assert.match(workerTypes, /export const LEGACY_WORKER_TYPE_MAP\s*=/, "worker-types.js must own legacy worker aliases");
  assert.match(workerTypes, /export const BROAD_WORKER_TYPE_MAP\s*=/, "worker-types.js must own broad worker aliases");

  for (const presetPath of ["../presets/laputa.js", "../presets/restoration-settlement.js", "../presets/magnific.js"]) {
    assert.ok(defaultData.includes(`from "${presetPath}"`), `default root must assemble campaign data from ${presetPath}`);
  }
  assert.doesNotMatch(defaultData, /id:\s*"(?:laputa|restoration-settlement|magnific)"/, "default root must not inline campaign holdings");

  assert.match(laputaCompatibility, /export \{ LAPUTA_IMPORT \} from "\.\/presets\/laputa\.js"/, "laputa-import.js must remain a thin compatibility export");
  assert.doesNotMatch(laputaCompatibility, /source:\s*"Лапута\.xlsx"/, "Laputa campaign data must live only in presets/laputa.js");
  assert.match(laputaPreset, /export const LAPUTA_IMPORT\s*=/, "presets/laputa.js must own the Laputa campaign data");

  const compatibilityConsumers = jsFiles
    .filter((file) => file !== path.join(root, "scripts/data/schema.js"))
    .filter((file) => file !== path.join(root, "scripts/data.js"))
    .filter((file) => !rel(file).startsWith("scripts/dev/"));
  for (const file of compatibilityConsumers) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /from\s+["'][^"']*\/schema\.js["']/, `${rel(file)} must import canonical schema owners instead of the compatibility facade`);
    assert.doesNotMatch(text, /from\s+["'][^"']*\/laputa-import\.js["']/, `${rel(file)} must import the canonical Laputa preset instead of its compatibility export`);
  }
}

function checkNormalizerBoundaries() {
  const facade = readFileSync(path.join(root, "scripts/data/normalizers.js"), "utf8");
  const owners = new Map([
    ["building", ["normalizeWorkerTypeSet", "normalizeBuilding", "normalizeUniqueBuildingWorkers"]],
    ["combat", ["normalizeDefenseSquad", "normalizeMassCombatState"]],
    ["storage", ["normalizeStorageItemRow", "normalizeStorageLogRow"]],
    ["events", ["normalizeEventHistory"]],
    ["resident", ["clearPersonReferences", "clearBuildingReferences", "normalizeConstructionCrew", "normalizePerson"]]
  ]);

  for (const [owner, exports] of owners) {
    const source = readFileSync(path.join(root, `scripts/data/normalizers/${owner}.js`), "utf8");
    assert.match(facade, new RegExp(`from "\\.\\/normalizers\\/${owner}\\.js"`), `normalizers facade must consume its ${owner} owner`);
    assert.doesNotMatch(source, /\b(?:ApplicationV2|ChatMessage|document|foundry|game|ui|window)\b/, `${owner} normalizers must remain independent from Foundry and DOM globals`);
    for (const exportName of exports) {
      assert.match(source, new RegExp(`export function ${exportName}\\b`), `${owner} owner must export ${exportName}`);
      assert.doesNotMatch(facade, new RegExp(`(?:export\\s+)?function ${exportName}\\b`), `normalizers facade must not regain ${exportName}`);
    }
  }

  assert.match(facade, /export \{ clearBuildingReferences, clearPersonReferences \}/, "normalizers facade must preserve reference-cleanup compatibility exports");
}

function checkResourceDataBoundaries(jsFiles) {
  const lookupFile = path.join(root, "scripts/core/resources.js");
  const builtinFile = path.join(root, "scripts/data/resources/builtin-resources.js");
  const baseFile = path.join(root, "scripts/data/resources/resource-base-definitions.js");
  const bindingsFile = path.join(root, "scripts/data/resources/world-resource-bindings.js");
  const settingsFile = path.join(root, "scripts/data/resources/resource-catalog-settings.js");
  const lookup = readFileSync(lookupFile, "utf8");
  const builtin = readFileSync(builtinFile, "utf8");
  const base = readFileSync(baseFile, "utf8");
  const bindings = readFileSync(bindingsFile, "utf8");
  const settings = readFileSync(settingsFile, "utf8");

  assert.doesNotMatch(lookup, /Compendium\.world\.resursy|3_F00L\/Icons\/Items/, "resource lookup logic must not own world-specific bindings");
  assert.doesNotMatch(lookup, /globalThis\.game|game\?\.settings/, "resource lookup logic must delegate Foundry settings access");
  assert.match(lookup, /from "\.\.\/data\/resources\/builtin-resources\.js"/, "resource lookup must import canonical built-in definitions");
  assert.match(lookup, /from "\.\.\/data\/resources\/resource-catalog-settings\.js"/, "resource lookup must import the settings adapter");
  assert.match(lookup, /export \{ BUILTIN_RESOURCE_DEFS, RESOURCE_DEFS \}/, "resource lookup must preserve legacy data exports");

  assert.match(builtin, /export const BUILTIN_RESOURCE_DEFS\s*=/, "builtin-resources.js must own the assembled built-in catalog");
  assert.match(builtin, /RESOURCE_BASE_DEFINITIONS\.map/, "built-in resources must be assembled from base definitions");
  assert.match(builtin, /WORLD_RESOURCE_BINDINGS/, "built-in resources must merge world bindings");
  assert.doesNotMatch(base, /\b(?:img|itemUuid|itemId|itemType|cost)\b/, "base resource definitions must stay free of world compendium bindings");
  assert.match(bindings, /Compendium\.world\.resursy/, "world bindings must own compendium UUID metadata");
  assert.match(bindings, /3_F00L\/Icons\/Items/, "world bindings must own image metadata");
  assert.match(settings, /SETTING_CATALOG/, "resource settings adapter must use the canonical split catalog setting");
  assert.match(settings, /SETTING_DATA/, "resource settings adapter must retain the legacy catalog fallback");

  for (const file of jsFiles) {
    if (file === lookupFile || file === builtinFile || rel(file).startsWith("scripts/dev/")) continue;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /import\s*\{[^}]*\b(?:BUILTIN_RESOURCE_DEFS|RESOURCE_DEFS)\b[^}]*\}\s*from\s+["'][^"']*core\/resources\.js["']/,
      `${rel(file)} must import built-in resource data from its canonical data owner`
    );
  }
}

function checkEconomyEngineBoundaries() {
  const reportEngineFile = path.join(root, "scripts/engines/economy/report.js");
  const productionEngineFile = path.join(root, "scripts/engines/economy/production-cycle.js");
  const foodEngineFile = path.join(root, "scripts/engines/economy/food-consumption.js");
  const treasuryEngineFile = path.join(root, "scripts/engines/economy/treasury-costs.js");
  const tradeEngineFile = path.join(root, "scripts/engines/economy/trade.js");
  const constructionEngineFile = path.join(root, "scripts/engines/economy/construction.js");
  const domainFile = path.join(root, "scripts/apps/domains/finance/economy-domain.js");
  const eventDomainFile = path.join(root, "scripts/apps/domains/events/economy-events.js");
  const reportEngine = readFileSync(reportEngineFile, "utf8");
  const productionEngine = readFileSync(productionEngineFile, "utf8");
  const foodEngine = readFileSync(foodEngineFile, "utf8");
  const treasuryEngine = readFileSync(treasuryEngineFile, "utf8");
  const tradeEngine = readFileSync(tradeEngineFile, "utf8");
  const constructionEngine = readFileSync(constructionEngineFile, "utf8");
  const domain = readFileSync(domainFile, "utf8");
  const eventDomain = readFileSync(eventDomainFile, "utf8");

  for (const [name, engine] of [
    ["report", reportEngine],
    ["production cycle", productionEngine],
    ["food consumption", foodEngine],
    ["treasury costs", treasuryEngine],
    ["trade", tradeEngine],
    ["construction", constructionEngine]
  ]) {
    assertNoEngineGlobals(engine, `economy ${name} engine must not access Foundry or DOM globals`);
    // Batch identities and resource shelf lives use the shared data utilities;
    // Staffing, batch capacity/timing, shared preparation goals and nutrition own the calculations.
    // Keep this boundary exact rather than allowing arbitrary runtime/UI imports.
    const expectedImports = {
      "production cycle": [
        "../../data/utils.js", "../politics/runtime-effects.js", "../workers/minimum-staff.js",
        "./production-batch-life.js", "./production-capacity.js", "./production-goals.js", "./production-timing.js"
      ],
      "construction": ["../politics/runtime-effects.js"],
      "food consumption": ["../../data/resident-presence.js", "../politics/runtime-effects.js", "./nutrition.js"]
    }[name] ?? [];
    const imports = [...engine.matchAll(/^\s*import\s+[^;]+?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), expectedImports.sort(), `economy ${name} engine may only import its declared domain helpers`);
    assert.doesNotMatch(engine, /\bimport\s*\(/, `economy ${name} engine must not hide dynamic runtime dependencies`);
  }
  for (const helper of [
    "scripts/engines/politics/runtime-effects.js", "scripts/data/resident-presence.js",
    "scripts/engines/workers/minimum-staff.js", "scripts/engines/economy/production-timing.js",
    "scripts/engines/economy/production-goals.js", "scripts/engines/workers/staff-runtime.js",
    "scripts/engines/economy/nutrition.js", "scripts/core/production-expenses.js"
  ]) {
    const source = readFileSync(path.join(root, helper), "utf8");
    assertNoEngineGlobals(source, `${helper} must remain independent of platform globals`);
    assert.doesNotMatch(source, /^\s*import\s/m, `${helper} must remain a pure dependency-free helper`);
  }
  for (const exportName of [
    "summarizeSkippedLines",
    "summarizeSignedLines",
    "summarizeFoodReport",
    "summarizeConstructionReport",
    "summarizeTradeReport",
    "summarizeTreasuryReport",
    "summarizeEconomyReport"
  ]) {
    assert.match(reportEngine, new RegExp(`export function ${exportName}\\b`), `economy report engine must export ${exportName}`);
    assert.ok(domain.includes(exportName), `FinanceEconomyDomain must preserve its ${exportName} compatibility adapter`);
  }
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/report\.js"/, "FinanceEconomyDomain must consume the pure economy report engine");
  assert.match(domain, /_economyReportDependencies\(\)/, "FinanceEconomyDomain must pass explicit report formatting dependencies");
  assert.match(productionEngine, /export async function runProductionCycle\b/, "economy production engine must export runProductionCycle");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/production-cycle\.js"/, "FinanceEconomyDomain must consume the pure production cycle engine");
  assert.match(domain, /_productionCycleDependencies\(/, "FinanceEconomyDomain must pass explicit production cycle dependencies");
  assert.match(domain, /_runProductionCycleForQd\(/, "FinanceEconomyDomain must preserve a production cycle adapter");
  assert.doesNotMatch(domain, /for \(let step = 0; step < qd; step \+= 1\)/, "FinanceEconomyDomain must not regain production cycle orchestration");
  assert.match(foodEngine, /export function isFoodResource\b/, "economy food engine must export food recognition");
  assert.match(foodEngine, /export function runFoodConsumption\b/, "economy food engine must export runFoodConsumption");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/food-consumption\.js"/, "FinanceEconomyDomain must consume the pure food consumption engine");
  assert.match(domain, /_foodConsumptionDependencies\(\)/, "FinanceEconomyDomain must pass explicit food consumption dependencies");
  assert.match(domain, /return runFoodConsumption\(\{/, "FinanceEconomyDomain must preserve a food consumption adapter");
  assert.doesNotMatch(domain, /_runFoodConsumptionForQd[\s\S]{0,500}const days\s*=/, "FinanceEconomyDomain must not regain food consumption orchestration");
  assert.match(treasuryEngine, /export function runTreasuryCosts\b/, "economy treasury engine must export runTreasuryCosts");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/treasury-costs\.js"/, "FinanceEconomyDomain must consume the pure treasury costs engine");
  assert.match(domain, /_treasuryCostDependencies\(\)/, "FinanceEconomyDomain must pass explicit treasury dependencies");
  assert.match(domain, /return runTreasuryCosts\(\{/, "FinanceEconomyDomain must preserve a treasury costs adapter");
  assert.doesNotMatch(domain, /_runTreasuryCostsForQd[\s\S]{0,700}const salaryCost\s*=/, "FinanceEconomyDomain must not regain treasury cost orchestration");
  assert.match(tradeEngine, /export async function runTrade\b/, "economy trade engine must export runTrade");
  assert.match(tradeEngine, /deps\.random\(\)/, "economy trade engine must use its injected random source");
  assert.doesNotMatch(tradeEngine, /Math\.random/, "economy trade engine must not use global random");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/trade\.js"/, "FinanceEconomyDomain must consume the pure trade engine");
  assert.match(domain, /_tradeDependencies\(\{ random/, "FinanceEconomyDomain must pass an explicit trade random source");
  assert.match(domain, /return runTrade\(\{/, "FinanceEconomyDomain must preserve a trade adapter");
  assert.doesNotMatch(domain, /_runTradeForQd[\s\S]{0,1200}candidatePools/, "FinanceEconomyDomain must not regain trade orchestration");
  assert.match(constructionEngine, /export function runConstruction\b/, "economy construction engine must export runConstruction");
  assert.match(constructionEngine, /deps\.rollDice\(dicePool\)/, "economy construction engine must use its injected dice roller");
  assert.doesNotMatch(constructionEngine, /Math\.random|rollD6Pool/, "economy construction engine must not use global dice randomness");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/economy\/construction\.js"/, "FinanceEconomyDomain must consume the pure construction engine");
  assert.match(domain, /_constructionDependencies\(\{ rollDice/, "FinanceEconomyDomain must pass an explicit construction dice roller");
  assert.match(domain, /return runConstruction\(\{/, "FinanceEconomyDomain must preserve a construction adapter");
  assert.doesNotMatch(domain, /_runConstructionCrewsForQd[\s\S]{0,900}buildProgress\s*=/, "FinanceEconomyDomain must not regain construction orchestration");
  assert.doesNotMatch(domain, /\b(?:ChatMessage|ui\.notifications|requestRender|_updateActiveHolding)\b/, "FinanceEconomyDomain must not own UI or transaction orchestration");
  assert.doesNotMatch(domain, /async _postTendaySummaryChat\b/, "FinanceEconomyDomain must not own tenday chat rendering");
  assert.match(eventDomain, /async _postTendaySummaryChat\b/, "EconomyEventDomain must own compact tenday chat rendering");
  assert.match(eventDomain, /SkyholdData\.updateHolding\(/, "EconomyEventDomain must own the explicit prepared-holding transaction");
  assert.match(eventDomain, /ui\.notifications/, "EconomyEventDomain must own economy notifications");
  assert.match(eventDomain, /this\.requestRender\(\)/, "EconomyEventDomain must own economy rendering requests");
}

function checkStorageEngineBoundaries() {
  const capacityEngineFile = path.join(root, "scripts/engines/storage/capacity.js");
  const moveEngineFile = path.join(root, "scripts/engines/storage/move.js");
  const paymentEngineFile = path.join(root, "scripts/engines/storage/payment.js");
  const groupPaymentEngineFile = path.join(root, "scripts/engines/storage/group-payment.js");
  const placementEngineFile = path.join(root, "scripts/engines/storage/placement.js");
  const searchEngineFile = path.join(root, "scripts/engines/storage/search.js");
  const quantityEngineFile = path.join(root, "scripts/engines/storage/item-quantity.js");
  const batchEngineFile = path.join(root, "scripts/engines/storage/batch-move.js");
  const domainFile = path.join(root, "scripts/apps/domains/finance/storage-domain.js");
  const contextDomainFile = path.join(root, "scripts/apps/domains/finance/storage/context-domain.js");
  const itemDomainFile = path.join(root, "scripts/apps/domains/finance/storage/item-document-domain.js");
  const economyDomainFile = path.join(root, "scripts/apps/domains/finance/economy-domain.js");
  const navigationDomainFile = path.join(root, "scripts/apps/domains/events/navigation-events.js");
  const storageTabsTemplateFile = path.join(root, "templates/parts/storage/tabs.hbs");
  const storageSearchCssFile = path.join(root, "styles/parts/storage/storage-tools-compact.css");
  const capacityEngine = readFileSync(capacityEngineFile, "utf8");
  const moveEngine = readFileSync(moveEngineFile, "utf8");
  const paymentEngine = readFileSync(paymentEngineFile, "utf8");
  const groupPaymentEngine = readFileSync(groupPaymentEngineFile, "utf8");
  const placementEngine = readFileSync(placementEngineFile, "utf8");
  const searchEngine = readFileSync(searchEngineFile, "utf8");
  const quantityEngine = readFileSync(quantityEngineFile, "utf8");
  const batchEngine = readFileSync(batchEngineFile, "utf8");
  const domain = readFileSync(domainFile, "utf8");
  const contextDomain = readFileSync(contextDomainFile, "utf8");
  const itemDomain = readFileSync(itemDomainFile, "utf8");
  const economyDomain = readFileSync(economyDomainFile, "utf8");
  const navigationDomain = readFileSync(navigationDomainFile, "utf8");
  const storageTabsTemplate = readFileSync(storageTabsTemplateFile, "utf8");
  const storageSearchCss = readFileSync(storageSearchCssFile, "utf8");

  for (const [name, engine] of [
    ["capacity", capacityEngine],
    ["placement", placementEngine],
    ["move", moveEngine],
    ["payment", paymentEngine],
    ["group payment", groupPaymentEngine],
    ["search", searchEngine],
    ["item quantity", quantityEngine],
    ["batch move", batchEngine]
  ]) {
    assertNoEngineGlobals(engine, `storage ${name} engine must not access application or UI globals`);
    // Arrival spoilage and profile admission share the canonical storage rules.
    const expectedImports = name === "placement" ? ["./specialization.js"] : [];
    const imports = [...engine.matchAll(/^\s*import\s+[^;]+?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    assert.deepEqual(imports, expectedImports, `storage ${name} engine may only import its declared domain helpers`);
    assert.doesNotMatch(engine, /\bimport\s*\(/, `storage ${name} engine must not hide dynamic runtime dependencies`);
    assert.doesNotMatch(engine, /\bthis\./, `storage ${name} engine must not depend on a SkyholdApp receiver`);
  }
  for (const exportName of [
    "normalizeStorageRoomId",
    "storageUnitLoad",
    "storageRowLoad",
    "storageFillClass",
    "decorateStorageRoom",
    "buildStorageRooms",
    "storageRoomOptionsFromRooms",
    "storageRoomLabelFromRooms",
    "storageRoomsContext"
  ]) {
    assert.match(capacityEngine, new RegExp(`export function ${exportName}\\b`), `storage capacity engine must export ${exportName}`);
  }
  assert.match(domain, /from "\.\/storage\/context-domain\.js"/, "FinanceStorageDomain must consume its extracted context owner");
  assert.match(domain, /from "\.\/storage\/item-document-domain\.js"/, "FinanceStorageDomain must consume its Foundry Item adapter owner");
  assert.match(domain, /composeDomainGroup\("FinanceStorageDomain"/, "FinanceStorageDomain must compose owners with duplicate protection");
  assert.match(domain, /\["FinanceStorageContextDomain",\s*FinanceStorageContextDomain\]/, "FinanceStorageDomain must preserve context compatibility methods");
  assert.match(domain, /\["FinanceStorageItemDocumentDomain",\s*FinanceStorageItemDocumentDomain\]/, "FinanceStorageDomain must preserve Item compatibility methods");
  assert.doesNotMatch(domain, /_prepareStorageRows\b|_removeQuantityFromActorItem\b/, "FinanceStorageDomain facade must not regain extracted context or Item workflows");
  assert.match(contextDomain, /from "\.\.\/\.\.\/\.\.\/\.\.\/engines\/storage\/capacity\.js"/, "storage context owner must consume the pure capacity engine");
  assert.match(contextDomain, /_storageCapacityDependencies\(\)/, "storage context owner must pass explicit capacity dependencies");
  assert.match(contextDomain, /return buildStorageRooms\(\{/, "storage context owner must preserve a storage rooms adapter");
  assert.doesNotMatch(contextDomain, /_storageRooms[\s\S]{0,700}usedByRoom/, "storage context owner must not regain room capacity orchestration");
  assert.match(placementEngine, /export function addStorageWithOverflow\b/, "storage placement engine must export addStorageWithOverflow");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/storage\/placement\.js"/, "FinanceStorageDomain must consume the pure storage placement engine");
  assert.match(domain, /_storagePlacementDependencies\(\)/, "FinanceStorageDomain must pass explicit storage placement dependencies");
  assert.match(domain, /return addStorageWithOverflow\(\{/, "FinanceStorageDomain must preserve an add-with-overflow adapter");
  assert.doesNotMatch(domain, /_storageAddWithOverflow[\s\S]{0,700}fitAmount/, "FinanceStorageDomain must not regain add-with-overflow orchestration");
  assert.match(moveEngine, /export function moveStorageResource\b/, "storage move engine must export moveStorageResource");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/storage\/move\.js"/, "FinanceStorageDomain must consume the pure storage move engine");
  assert.match(domain, /_storageMoveDependencies\(\)/, "FinanceStorageDomain must pass explicit storage move dependencies");
  assert.match(domain, /return moveStorageResource\(\{/, "FinanceStorageDomain must preserve a storage move adapter");
  assert.doesNotMatch(domain, /_applyStorageMove[\s\S]{0,900}move-out/, "FinanceStorageDomain must not regain storage move orchestration");
  assert.match(paymentEngine, /export function canPayStorageCosts\b/, "storage payment engine must export canPayStorageCosts");
  assert.match(paymentEngine, /export function payStorageCosts\b/, "storage payment engine must export payStorageCosts");
  assert.match(groupPaymentEngine, /export function planStorageCosts\b/, "storage group payment engine must expose a concrete inventory plan");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/storage\/payment\.js"/, "FinanceStorageDomain must consume the pure storage payment engine");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/storage\/group-payment\.js"/, "FinanceStorageDomain must consume the pure group payment planner");
  assert.match(domain, /_storagePaymentDependencies\(\)/, "FinanceStorageDomain must pass explicit storage payment dependencies");
  assert.match(domain, /return planStorageCosts\(\{/, "FinanceStorageDomain must plan exact and semantic-group storage costs through one adapter");
  assert.doesNotMatch(
    economyDomain,
    /_(?:prepareStorageRows|prepareStorageItemRows|removeQuantityFromActorItem|withdrawResourceToActor|giveStoredItemToActor)\b/,
    "FinanceEconomyDomain must not regain storage presentation or Foundry transfer ownership"
  );
  assert.match(domain, /payStorageCosts\(\{/, "FinanceStorageDomain must preserve a storage pay adapter");
  assert.doesNotMatch(domain, /_storagePay[\s\S]{0,700}let rest/, "FinanceStorageDomain must not regain storage payment orchestration");
  assert.match(searchEngine, /export function buildStorageSearchRows\b/, "storage search engine must export buildStorageSearchRows");
  assert.match(searchEngine, /export function filterStorageSearchRows\b/, "storage search engine must expose bounded query projection");
  assert.match(contextDomain, /from "\.\.\/\.\.\/\.\.\/\.\.\/engines\/storage\/search\.js"/, "storage context owner must consume the pure search engine");
  assert.match(navigationDomain, /filterStorageSearchRows\(this\._storageSearchIndex/, "storage search UI must query its in-memory index");
  assert.match(navigationDomain, /list\.replaceChildren\(fragment\)/, "storage search UI must materialize only the bounded result window");
  assert.doesNotMatch(storageTabsTemplate, /each\s+storageContext\.searchRows/, "storage template must not pre-render the entire hidden global result set");
  assert.match(storageTabsTemplate, /data-storage-search-list/, "storage template must expose a bounded result mount point");
  assert.match(storageSearchCss, /\.fbls-storage-search-results\[hidden\][\s\S]{0,220}display:\s*none/, "storage search CSS must honor the hidden state despite component display rules");
  assert.match(quantityEngine, /FORBIDDEN_LANDS_ITEM_QUANTITY_ADAPTER/, "storage quantity engine must declare its system-specific contract");
  assert.match(quantityEngine, /path:\s*"system\.quantity"/, "Forbidden Lands quantity adapter must own its document path");
  assert.match(itemDomain, /from "\.\.\/\.\.\/\.\.\/\.\.\/engines\/storage\/item-quantity\.js"/, "Foundry Item adapter must consume the quantity contract");
  assert.match(batchEngine, /export function planStorageBatchMove\b/, "storage batch engine must expose a preview plan");
  assert.match(batchEngine, /export function applyStorageBatchMove\b/, "storage batch engine must expose deterministic apply");
  assert.match(domain, /from "\.\.\/\.\.\/\.\.\/engines\/storage\/batch-move\.js"/, "FinanceStorageDomain must consume the pure batch engine");
}

function checkMarketBoundaries() {
  const pricing = readFileSync(path.join(root, "scripts/engines/market/pricing.js"), "utf8");
  const delivery = readFileSync(path.join(root, "scripts/engines/market/delivery.js"), "utf8");
  const shipment = readFileSync(path.join(root, "scripts/engines/market/shipment.js"), "utf8");
  const logistics = readFileSync(path.join(root, "scripts/engines/market/logistics.js"), "utf8");
  const economy = readFileSync(path.join(root, "scripts/data/market/economy.js"), "utf8");
  const composition = readFileSync(path.join(root, "scripts/engines/market/composition.js"), "utf8");
  const providers = readFileSync(path.join(root, "scripts/engines/market/providers.js"), "utf8");
  const app = readFileSync(path.join(root, "scripts/apps/market-app.js"), "utf8");
  const marketOperationExecutor = readFileSync(path.join(root, "scripts/apps/market-operation-executor.js"), "utf8");
  const editor = readFileSync(path.join(root, "scripts/apps/editors/market-catalog-editor.js"), "utf8");
  const editorTemplate = readFileSync(path.join(root, "templates/market-catalog-editor.hbs"), "utf8");
  const editorCss = readFileSync(path.join(root, "styles/parts/market/market-catalog.css"), "utf8");
  const routeEditor = readFileSync(path.join(root, "scripts/apps/editors/route-graph-editor.js"), "utf8");
  const routeViewport = readFileSync(path.join(root, "scripts/apps/editors/route-graph-viewport.js"), "utf8");
  const routeTemplate = readFileSync(path.join(root, "templates/route-graph-editor.hbs"), "utf8");
  const routeEdgeTemplate = readFileSync(path.join(root, "templates/route-edge-editor.hbs"), "utf8");
  const marketTemplate = readFileSync(path.join(root, "templates/market-app.hbs"), "utf8");
  const marketCss = readFileSync(path.join(root, "styles/parts/market/market.css"), "utf8");
  const marketCheckoutCss = readFileSync(path.join(root, "styles/parts/market/market-checkout.css"), "utf8");
  const imageFallback = readFileSync(path.join(root, "scripts/apps/common/image-fallback.js"), "utf8");
  const buildingTemplate = readFileSync(path.join(root, "templates/parts/skyhold-tab-buildings.hbs"), "utf8");
  const skyholdApp = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  const routeCss = readFileSync(path.join(root, "styles/parts/market/route-graph.css"), "utf8");
  const economyDomain = readFileSync(path.join(root, "scripts/apps/domains/finance/economy-domain.js"), "utf8");
  const resourceCore = readFileSync(path.join(root, "scripts/core/resources.js"), "utf8");
  const gmTemplate = readFileSync(path.join(root, "templates/parts/skyhold-tab-gm.hbs"), "utf8");
  const tradePack = JSON.parse(readFileSync(path.join(root, "examples/content-packs/air-islands-trade-network-template.json"), "utf8"));
  for (const [name, engine] of [["pricing", pricing], ["delivery", delivery], ["shipment", shipment], ["logistics", logistics]]) {
    const imports = [...engine.matchAll(/^\s*import\s+[^;]+?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
    // These helpers own game-date quotes, bounded money, conserved purchase
    // receipts, dated cargo and alternative routes; they are active contracts.
    const expectedImports = {
      pricing: ["../../core/economy-calendar.js", "../../data/market/money-limits.js"],
      delivery: ["./purchase-payment.js"],
      shipment: ["./cargo-aging.js", "./shipment-schedule.js", "./purchase-payment.js"],
      logistics: ["../politics/runtime-effects.js", "./route-candidates.js"]
    }[name];
    assert.deepEqual(imports, expectedImports, `market ${name} engine may only import its declared domain helpers`);
    assert.doesNotMatch(engine, /\bimport\s*\(/, `market ${name} engine must not hide dynamic runtime dependencies`);
    assertNoEngineGlobals(engine, `market ${name} engine must not access Foundry or UI globals`);
  }
  for (const helper of [
    "scripts/core/economy-calendar.js", "scripts/data/market/money-limits.js",
    "scripts/engines/market/purchase-payment.js", "scripts/engines/market/route-candidates.js"
  ]) {
    const source = readFileSync(path.join(root, helper), "utf8");
    assertNoEngineGlobals(source, `${helper} must remain independent of platform globals`);
    assert.doesNotMatch(source, /^\s*import\s/m, `${helper} must remain a pure dependency-free helper`);
  }
  assert.match(pricing, /export function prepareMarketQuote\b/, "market pricing engine must expose deterministic quotes");
  assert.match(pricing, /export function planMarketPurchase\b/, "market pricing engine must expose purchase preview");
  assert.match(pricing, /deliveryBreakdown\s*=\s*\{/, "market purchase preview must expose a delivery calculation breakdown");
  assert.match(pricing, /export function marketShipmentRiskProfile\b/, "market pricing engine must expose the explainable shipment-risk profile");
  assert.match(pricing, /export function marketHistoricalFreightRate\b/, "market freight must expose its historically calibrated value-based rate");
  assert.match(pricing, /export function marketHistoricalInsuranceRate\b/, "market insurance must expose its route-sensitive historical calibration");
  assert.match(pricing, /MARKET_INSURANCE_COVERAGE_RATE\s*=\s*0\.84/, "market insurance must preserve the documented 16% deductible");
  assert.match(pricing, /MARKET_EXPRESS_SURCHARGE_RATE\s*=\s*0\.2/, "express delivery must use the documented clipper-era premium");
  assert.match(pricing, /export const MARKET_DELIVERY_SERVICES/, "market pricing must own the three delivery-service rules");
  assert.match(pricing, /standard:[^\n]+capacityFactor:\s*0\.2/, "rideshare delivery must reserve 20% of physical capacity per departure");
  assert.match(pricing, /express:[^\n]+capacityFactor:\s*0\.1/, "accelerated delivery must reserve a smaller 10% allotment");
  assert.match(pricing, /charter:[^\n]+capacityFactor:\s*1[^\n]+fullFixedFare:\s*true/, "charter must expose full vessel capacity and full fixed voyage cost");
  assert.match(pricing, /export function splitMarketShipmentLines\b/, "market pricing must split oversized orders into conserved physical cargo batches");
  assert.match(pricing, /service\.fullFixedFare\s*&&\s*hasCapacityLimit\s*\?\s*physicalCapacityLoad\s*:\s*batch\.totalLoad/, "charter operating cost must reserve the whole vessel instead of charging only its partial cargo mass");
  assert.match(delivery, /export function applyMarketDelivery\b/, "market delivery engine must expose atomic resource and Item placement");
  assert.match(shipment, /export function createMarketShipment\b/, "market shipment engine must expose debit-once shipment creation");
  assert.match(shipment, /parentOperationId/, "batched shipments must retain their parent purchase transaction");
  assert.match(shipment, /holding\.special\.market\.orders\.push\(\.\.\.preparedOrders\)/, "all physical cargo batches must be persisted as independent shipment records");
  assert.match(shipment, /export function retainMarketShipmentOrders\b/, "shipment retention must prune terminal history without dropping active batches");
  assert.match(shipment, /export function advanceMarketShipments\b/, "market shipment engine must expose replay-safe QD advancement");
  assert.match(shipment, /export function deterministicMarketShipmentUnit\b/, "market shipment incidents must use a stable deterministic source");
  assert.match(shipment, /export function resolveMarketShipmentRisk\b/, "market shipment engine must resolve delay, loss and insurance atomically");
  assert.match(shipment, /!order\.insurancePaidAt/, "market shipment insurance must guard against duplicate payouts");
  assert.match(shipment, /export function marketShipmentCancellationQuote\b/, "market shipment engine must expose an explainable cancellation preview");
  assert.match(shipment, /export function cancelMarketShipment\b/, "market shipment cancellation must remain a replay-safe engine operation");
  assert.match(logistics, /export function resolveMarketLogistics\b/, "market logistics engine must expose route, access and transport resolution");
  assert.match(logistics, /airship:[^\n]+loadDistanceCopper:\s*0\.02/, "airship bulk freight must retain the sea-like corrected distance tariff");
  assert.match(logistics, /export function holdingMarketAccessLevel\b/, "market logistics engine must expose the manually entered URS");
  assert.match(logistics, /gm\?\.modifiers\?\.marketConnectionsLevel/, "market access must read the GM settlement modifier");
  assert.match(logistics, /export function marketRegionAccessCostMap\b/, "market selection must reuse one weighted URS map instead of recalculating every route");
  assert.doesNotMatch(logistics, /Math\.min\(4,[^\n]*hops/, "four or more links must never collapse into universal access");
  assert.match(logistics, /marketTransportRoutes\(\{[\s\S]{0,200}maxAccess:\s*access\.level/, "market route alternatives must respect the settlement URS budget");
  assert.match(logistics, /search\.routes\.sort\(\(a, b\) => a\.accessCost - b\.accessCost/, "default market access route must minimize the summed URS difficulty of region links");
  assert.match(logistics, /holding\?\.overview\?\.region/, "market logistics must read the Basis region");
  assert.doesNotMatch(logistics, /overview\?\.(?:altitude|drift)/, "altitude and drift must not substitute for the Basis region");
  assert.match(logistics, /edgeSeasonalModifier\(/, "market logistics must apply editable seasonal factors at the route-edge owner");
  assert.match(app, /from "\.\.\/engines\/market\/pricing\.js"/, "market app must consume the pure pricing engine");
  assert.match(marketOperationExecutor, /from "\.\.\/engines\/market\/delivery\.js"/, "authority market executor must consume the pure delivery engine");
  assert.match(app, /from "\.\.\/engines\/market\/shipment\.js"/, "market app must consume the pure shipment engine");
  assert.doesNotMatch(app, /_marketComparisonRows\(/, "market app must not eagerly calculate every route while opening the location selector");
  assert.match(app, /marketOptions:\s*markets\.map\(/, "market app must retain the compact location selector without the removed comparison pass");
  assert.match(app, /from "\.\.\/engines\/market\/logistics\.js"/, "market app must consume the pure logistics engine");
  assert.match(app, /from "\.\.\/engines\/market\/composition\.js"/, "market app must compose markets from countries and location specialties");
  assert.match(app, /from "\.\.\/engines\/market\/providers\.js"/, "market app must allocate merchant stock and selectable carriers");
  assert.match(economyDomain, /from "\.\.\/\.\.\/\.\.\/engines\/market\/shipment\.js"/, "economy domain must consume shipment advancement through its pure engine");
  assert.match(economyDomain, /this\._advanceMarketShipmentsForQd\(holding, qd, report\)/, "confirmed QD economy flow must advance market shipments");
  const economyFlow = economyDomain.match(/async _runEconomyForQd\([\s\S]+?\n},/)?.[0] ?? "";
  const arrivalIndex = economyFlow.indexOf("this._advanceMarketShipmentsForQd(holding, qd, report)");
  const productionIndex = economyFlow.indexOf("await this._runProductionAndLivestockForQd");
  assert.ok(arrivalIndex >= 0 && productionIndex >= 0, "economy flow must retain both shipment advancement and production/livestock orchestration");
  assert.ok(
    arrivalIndex < productionIndex,
    "arriving market cargo must be available before the period production and consumption phases"
  );
  const productionFlow = economyDomain.match(/async _runProductionAndLivestockForQd\([\s\S]+?\n},/)?.[0] ?? "";
  assert.match(productionFlow, /await this\._runProductionCycleForQd/, "production/livestock orchestration must execute the production cycle");
  assert.match(economy, /export function normalizeMarketEconomy\b/, "market economy owner must normalize the layered editable model");
  assert.match(economy, /export const DEFAULT_MARKET_SPECIALTIES\b/, "market economy must expose a reusable specialty catalog");
  assert.match(composition, /export function composeMarketLocation\b/, "market composition must combine base, country and location layers");
  assert.match(composition, /resource\.marketAccessDifficulty/, "market composition must inherit canonical material access difficulty");
  assert.match(pricing, /requiredUrs\s*=\s*routeAccessCost\s*\+\s*accessDifficulty/, "offer visibility must combine weighted route URS with item difficulty");
  assert.match(gmTemplate, /gm\.modifiers\.marketConnectionsLevel/, "the GM tab must expose manual settlement URS");
  assert.match(resourceCore, /marketAccessDifficulty/, "resource catalog rows must own an editable market-access difficulty");
  assert.equal(tradePack.install?.replaceResources, true, "the clean trade-network import must clear the previous user resource catalog");
  assert.equal((tradePack.content?.regions ?? []).reduce((sum, row) => sum + (row.marketLinks?.length ?? 0), 0), 0, "the clean trade-network import must not invent route links");
  assert.ok((tradePack.content?.resources ?? []).every((row) => Number.isInteger(row.marketAccessDifficulty)), "every imported material must define URS difficulty");
  assert.match(providers, /export function allocateQuoteToMerchantProviders\b/, "provider engine must split stock between companies and independent merchants");
  assert.match(providers, /export function carrierProvidersForRoute\b/, "provider engine must resolve transport companies independently from merchants");
  assert.match(editor, /SkyholdData\.transaction\(/, "market catalog editor must persist through canonical transactions");
  assert.match(editor, /normalizeMarketEconomy\(/, "market editor must edit the canonical layered economy instead of legacy provider markets");
  assert.match(editor, /data\.catalog\.markets\s*=\s*\[\]/, "market editor must explicitly discard the retired legacy market catalog");
  assert.match(editor, /openRouteGraphApp\(/, "market catalog editor must expose the visual route graph through the lazy boundary");
  assert.doesNotMatch(editor, /game\.settings\.set/, "market catalog editor must not bypass the data store");
  assert.match(routeEditor, /SkyholdData\.transaction\(/, "route graph editor must persist positions and links through canonical transactions");
  assert.match(routeEdgeTemplate, /data-route-edge-field="ursCost"/, "route edge editor must expose per-link URS difficulty");
  assert.match(routeTemplate, /УРС \{\{ursCost\}\}/, "route graph labels must show the link URS difficulty");
  assert.doesNotMatch(marketTemplate, /\{\{quoteKey\}\}/, "the external market must not expose its internal quote identifier");
  assert.match(marketTemplate, /fbls-market-money[\s\S]{0,220}\{\{label\}\}/, "market prices must render compact colored denomination parts");
  assert.match(marketTemplate, /fbls-market-money[\s\S]{0,250}fbls-market-movement[\s\S]{0,180}movementTooltip/, "market movement percentage must follow the price on the same semantic row and explain itself on hover");
  assert.match(app, /bindFloatingTooltips\(this, root\)/, "market hover explanations must use the shared element-anchored tooltip surface without a mousemove hot path");
  assert.match(app, /_marketSnapshot\(\{ includePlan: false \}\)[\s\S]{0,1400}if \(quote\) plan = planMarketPurchase/, "market render context must defer purchase planning until the final enriched quote and corrected room are ready");
  assert.match(app, /addEventListener\("contextmenu"[\s\S]{0,5000}step > 0 \? stock : 0/, "right-clicking market steppers must set the selected provider to maximum or zero");
  assert.match(app, /capturePersistentImages\(this\.element\)/, "every market rerender must retain already loaded offer images, including delivery controls");
  assert.match(imageFallback, /export function restorePersistentImages[\s\S]{0,900}replaceWith\(previous\)/, "shared image continuity must transplant loaded image nodes instead of reloading them");
  assert.match(buildingTemplate, /data-fbls-persistent-image="building-production:/, "building production rows must identify resource images across manager rerenders");
  assert.match(skyholdApp, /restorePersistentImages\(root, this\._pendingPersistentImages\)/, "the holdings manager must restore persistent production resource images after rerender");
  assert.match(routeCss, /fbls-route-edge-editor-hero h2[^}]*color:\s*var\(--fbls-text\)/, "route edge names must keep explicit contrast in the dark editor");
  assert.match(routeEditor, /normalizeMarketRouteMap\(/, "route graph editor must persist semantic map fields through the canonical map normalizer");
  assert.match(routeViewport, /SETTING_ROUTE_GRAPH_VIEW/, "route graph viewport must use the dedicated client-local setting");
  assert.doesNotMatch(routeEditor.match(/async _persistViewport\(\)[\s\S]+?\n  }/)?.[0] ?? "", /SkyholdData\.transaction/, "route graph viewport persistence must never create a world-data transaction");
  assert.match(routeEditor, /requestAnimationFrame\(\(\) => this\._applyNodeDragFrame\(\)\)/, "route node dragging must coalesce pointer events into animation frames");
  assert.match(routeEditor, /incidentLines/, "route node dragging must cache incident edges instead of rescanning the whole graph per frame");
  assert.match(routeEditor, /seasonalModifiers/, "route editor must persist per-edge seasonal modifiers instead of using a global lore rule");
  assert.match(routeEditor, /marketRouteDistanceKm\(/, "route editor must calculate calibrated polyline distance through the shared map helper");
  assert.match(routeEditor, /this\.owner\?\.openRegion\?\.\(regionId\)/, "route graph must open a region card only through the explicit node double-click path");
  assert.doesNotMatch(routeEditor, /this\.owner\?\.requestRender/, "route graph writes must not unexpectedly summon or rerender the region editor");
  assert.match(routeEditor, /_onPointerDown\(event, root\)[\s\S]{0,500}\[data-route-tool-overlay\]"\)\) return;[\s\S]{0,500}setPointerCapture/, "route tool overlays must reject canvas pointer capture before interactive controls can lose their click");
  assert.match(routeTemplate, /data-route-calibration-distance/, "route map must expose two-point scale calibration");
  assert.match(routeTemplate, /<polyline[^>]+data-route-edge-path/, "route map must render indirect routes as editable polylines");
  assert.match(routeTemplate, /fbls-route-edge-list compact/, "route sidebar must keep large edge catalogs in a compact list");
  assert.match(routeEdgeTemplate, /route-edge-path-edit/, "route edge popout must expose waypoint editing");
  assert.match(marketTemplate, /data-market-provider/, "market UI must keep a compact market-location selector");
  assert.doesNotMatch(marketTemplate, /fbls-market-provider-comparison|Сравнение рынков-локаций/, "market UI must not spend vertical space on the removed location-comparison panel");
  assert.match(marketTemplate, /data-market-carrier/, "market UI must expose an independent carrier choice");
  assert.match(marketTemplate, /value="standard"[^>]*>Попутный груз<[\s\S]{0,300}value="express"[^>]*>Ускоренная<[\s\S]{0,300}value="charter"[^>]*>Выделенный рейс</, "market UI must expose all three delivery services");
  assert.match(marketTemplate, /Партии[\s\S]{0,500}\{\{batchCountText\}\}/, "market checkout must explain automatic multi-departure batching");
  assert.match(marketTemplate, /data-market-batch-preview/, "multi-departure checkout must let the user inspect an individual flight");
  assert.match(app, /\[data-market-batch-preview\][\s\S]{0,300}batchPreviewIndex/, "market batch selector must update the inspected flight without mutating the order");
  assert.match(marketTemplate, /providerLabel/, "market offers must identify the merchant provider that owns each stock share");
  assert.match(marketTemplate, /data-action="market-select-merchant"[^>]+data-source-offer-id[^>]+data-provider-id/, "market product rows must expose independent merchant chips without duplicating source offers");
  assert.match(marketTemplate, /fbls-market-merchant-chip[^>]+hasQuantity/, "merchant chips must expose per-provider ordered quantities");
  assert.match(marketTemplate, /fbls-market-offer-columns/, "market offers must expose compact table headings");
  assert.match(marketTemplate, /fbls-market-facts/, "market header must characterize the market in one compact fact grid");
  assert.doesNotMatch(marketTemplate, /\{\{locationText\}\}|title="Локация"/, "market header must never expose the settlement location");
  assert.match(marketTemplate, /title="Страна: {{marketCountryLabel}}"[\s\S]{0,300}title="Размер рынка: {{marketSizeLabel}}"[\s\S]{0,300}title="Состояние рынка: {{marketConditionLabel}}"/, "market header facts must preserve full country, size and state values in that order");
  assert.match(marketTemplate, /fbls-market-cart-section delivery[\s\S]+fbls-market-cart-section route[\s\S]+fbls-market-cart-section costs/, "market checkout must separate delivery, route and cost decisions");
  assert.match(marketTemplate, /fbls-market-cart-section costs[\s\S]{0,5000}data-market-delivery-breakdown/, "the expanded delivery formula must live directly beside the displayed delivery cost");
  assert.match(marketTemplate, /Итого доставка[\s\S]{0,180}totalFormulaText/, "the expanded delivery formula must visibly reconcile to the delivery total");
  assert.match(marketCss, /\.fbls-market-shell\s*\{[\s\S]{0,180}flex-direction:\s*column/, "market shell must tolerate a variable number of notices without overlapping content");
  assert.match(marketCss, /\.fbls-market-price\s*\{[^}]*display:\s*flex[^}]*font-size:\s*var\(--fbls-type-compact-sm\)/, "market price and movement percentage must share a row at the canonical compact text scale");
  assert.match(marketCheckoutCss, /\.fbls-market-delivery-help\s*\{[^}]*border:[^}]*background:/, "delivery calculation disclosure must be visually discoverable in the checkout");
  assert.doesNotMatch(marketCss, /\.fbls-market-provider-(?:comparison|card)/, "removed market-location comparison CSS must not remain in the active cascade");
  assert.match(marketCss, /--fbls-market-columns:[^;]+minmax\([^;]+;/, "market products must share one dense table grid contract");
  assert.match(marketCss, /\.fbls-market-offer-columns\s*\{[^}]*position:\s*sticky/, "market table headings must remain visible while long catalogs scroll");
  assert.match(marketCss, /button\.fbls-market-merchant-chip\.has-quantity\s*\{[^}]*background:\s*var\(--fbls-merchant-color\)/, "merchant chips with quantity must have a strong selected state");
  assert.match(editorTemplate, /data-economy-search="base"/, "market economy editor must provide a searchable base assortment");
  assert.match(editorTemplate, /fbls-economy-offer-actions/, "base-offer actions must stay grouped instead of overlapping the next card");
  assert.match(editorCss, /\.fbls-economy-offer-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)/, "base offers must use the full editor width instead of two undersized cards");
  assert.doesNotMatch(editorCss, /\.fbls-economy-offer-list\s*\{[^}]*minmax\(30rem/, "base-offer cards must not restore the overlapping two-column layout");
  assert.match(routeCss, /\.fbls-route-tool-overlay button\s*\{[^}]*color:\s*var\(--fbls-text\)[^}]*background:\s*var\(--fbls-surface-2\)[^}]*-webkit-text-fill-color:\s*var\(--fbls-text\)/, "route tool buttons must own explicit foreground, background and native text contrast");
  assert.match(routeCss, /\.fbls-route-tool-overlay input\s*\{[^}]*color:\s*var\(--fbls-text\)[^}]*background:\s*var\(--fbls-surface-0\)[^}]*-webkit-text-fill-color:\s*var\(--fbls-text\)/, "route tool inputs must own explicit foreground, background and native text contrast");
  assert.doesNotMatch(routeEditor, /_onPointerMove\(event\)[\s\S]{0,1400}querySelectorAll/, "route pointermove must not query all graph edges while dragging");
  assert.doesNotMatch(routeEditor, /game\.settings\.set/, "route graph editor must not bypass the data store");
}

function checkMassCombatCalculationBoundaries() {
  const calculationFiles = [
    "scripts/apps/mass-combat/calculator.js",
    "scripts/apps/mass-combat/casualties.js",
    "scripts/apps/mass-combat/round-resolution.js",
    "scripts/apps/mass-combat/sources.js"
  ];
  for (const relative of calculationFiles) {
    const source = readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*apps\/registry\.js["']|from\s+["']\.\.\/registry\.js["']/, `${relative} must not import the open application registry`);
    assert.doesNotMatch(source, /\b(?:ApplicationV2|ChatMessage|document|foundry|game|ui|window)\b/, `${relative} must not access Foundry or DOM globals`);
    assert.doesNotMatch(source, /\bgetSkyholdManager\b/, `${relative} must receive domain dependencies explicitly`);
  }

  const casualties = readFileSync(path.join(root, "scripts/apps/mass-combat/casualties.js"), "utf8");
  const sources = readFileSync(path.join(root, "scripts/apps/mass-combat/sources.js"), "utf8");
  const assignmentDomain = readFileSync(path.join(root, "scripts/apps/domains/assignment-domain.js"), "utf8");
  assert.match(casualties, /from "\.\.\/\.\.\/data\/resident-assignments\.js"/, "battle casualties must use the data-owned assignment cleanup operation");
  assert.match(sources, /buildingEffectiveWorkers = null/, "battle sources must expose explicit worker-efficiency injection");
  assert.match(sources, /calculateMorale = null/, "battle sources must expose explicit morale injection");
  assert.match(assignmentDomain, /return clearPersonFromAssignments\(holding, personId\)/, "AssignmentDomain must delegate canonical cleanup to its data owner");
}

function checkWorkerPlannerBoundaries() {
  const engine = readFileSync(path.join(root, "scripts/engines/workers/assignment-planner.js"), "utf8");
  const adapter = readFileSync(path.join(root, "scripts/apps/domains/events/building-events.js"), "utf8");
  const planner = readFileSync(path.join(root, "scripts/apps/workforce-planner-app.js"), "utf8");
  const plannerTemplate = readFileSync(path.join(root, "templates/workforce-planner.hbs"), "utf8");
  assert.doesNotMatch(engine, /\b(?:ApplicationV2|ChatMessage|document|foundry|game|ui|window)\b/, "worker assignment planner must remain independent from Foundry and DOM globals");
  for (const helper of ["isBuiltAssignableBuilding", "isCivilianWorkerCandidate", "workerAssignmentScore"]) {
    assert.match(engine, new RegExp(`export function ${helper}\\b`), `worker assignment must retain its live ${helper} helper`);
  }
  assert.match(adapter, /from "\.\.\/\.\.\/\.\.\/engines\/workers\/assignment-planner\.js"/, "building event adapter must consume the worker planner");
  assert.match(planner, /action === "accept-preview" && this\.preview/, "workforce proposals must require explicit acceptance into the draft");
  assert.match(planner, /async _save\(retry\)[\s\S]{0,200}this\.preview\) throw new Error/, "workforce saving must reject an unaccepted preview");
  assert.match(plannerTemplate, /data-action="workforce-accept-preview"/, "workforce UI must expose proposal acceptance");
  assert.match(plannerTemplate, /data-action="workforce-save" \{\{#unless canSave\}\}disabled/, "workforce UI must disable saving while review is incomplete");
  assert.doesNotMatch(adapter, /const buildings = \(holding\?\.buildings\?\.list[\s\S]{0,2500}candidateRows/, "building event adapter must not regain assignment planning");
}

function checkRandomEventEditorBoundaries() {
  const editorFile = path.join(root, "scripts/apps/editors/random-event-editor.js");
  const contextFile = path.join(root, "scripts/apps/editors/random-event/context.js");
  const draftFile = path.join(root, "scripts/apps/editors/random-event/draft.js");
  const formFile = path.join(root, "scripts/apps/editors/random-event/form.js");
  const contextEditorFile = path.join(root, "scripts/apps/editors/random-event/context-editor.js");
  const rowEditorFile = path.join(root, "scripts/apps/editors/random-event/row-editor.js");
  const windowFrameFile = path.join(root, "scripts/apps/editors/random-event/window-frame.js");
  const editor = readFileSync(editorFile, "utf8");
  const context = readFileSync(contextFile, "utf8");
  const draft = readFileSync(draftFile, "utf8");
  const form = readFileSync(formFile, "utf8");
  const contextEditor = readFileSync(contextEditorFile, "utf8");
  const rowEditor = readFileSync(rowEditorFile, "utf8");
  const windowFrame = readFileSync(windowFrameFile, "utf8");

  assert.match(editor, /from "\.\/random-event\/context\.js"/, "random event editor must consume its extracted context owner");
  assert.match(editor, /from "\.\/random-event\/draft\.js"/, "random event editor must consume its extracted draft owner");
  assert.match(editor, /from "\.\/random-event\/context-editor\.js"/, "random event editor must consume its context window adapter");
  assert.match(editor, /from "\.\/random-event\/row-editor\.js"/, "random event editor must consume its row window adapter");
  assert.match(editor, /from "\.\/random-event\/window-frame\.js"/, "random event editor must consume its titlebar adapter");
  assert.doesNotMatch(editor, /function eventPreviewFromFacts\b|function prepareRowContext\b|function newEventRow\b|class SkyholdRandomEventContextEditor\b|class SkyholdRandomEventRowEditor\b/, "random event editor must not regain extracted helpers or secondary windows");
  for (const [name, source] of [["context", context], ["draft", draft]]) {
    assert.doesNotMatch(source, /\b(?:ApplicationV2|ChatMessage|document|foundry|game|ui|window)\b/, `random event ${name} helper must stay independent from Foundry and DOM globals`);
    assert.doesNotMatch(source, /\bthis\./, `random event ${name} helper must not depend on an Application receiver`);
  }
  assert.match(context, /export function prepareRowContext\b/, "random event context owner must export row preparation");
  assert.match(draft, /export function newRequirement\b/, "random event draft owner must export requirement creation");
  assert.match(form, /export function buildRequirementFromEditor\b/, "random event form owner must export requirement extraction");
  assert.match(contextEditor, /export class SkyholdRandomEventContextEditor\b/, "random event context window must have a dedicated adapter");
  assert.match(rowEditor, /export class SkyholdRandomEventRowEditor\b/, "random event row window must have a dedicated adapter");
  assert.match(windowFrame, /export function syncEventContextHeaderButton\b/, "random event titlebar behavior must have a dedicated adapter");
}

function checkResidentEventBoundaries() {
  const facade = readFileSync(path.join(root, "scripts/apps/domains/events/resident-events.js"), "utf8");
  const generator = readFileSync(path.join(root, "scripts/apps/domains/events/resident/generator-events.js"), "utf8");
  const eventDomain = readFileSync(path.join(root, "scripts/apps/domains/event-domain.js"), "utf8");
  assert.doesNotMatch(facade, /resident-generator\.js|foundryActorClass|resolveFoundryUuid|(?:async\s+)?_onGenerateResidents\s*\(|(?:async\s+)?_onResidentActorDrop\s*\(/, "resident CRUD event owner must not regain generator or Foundry Actor workflows");
  assert.match(generator, /export const ResidentGeneratorEventDomain\s*=/, "resident generator and Actor adapter must have a dedicated event owner");
  assert.match(generator, /foundryActorClass\(\)\.implementation\.fromDropData/, "resident Actor adapter must use the V13/V14 document boundary");
  assert.match(eventDomain, /from "\.\/events\/resident\/generator-events\.js"/, "EventDomain must compose the resident generator owner");
}

function checkCheckboxRenderingStability() {
  const forms = readFileSync(path.join(root, "styles/parts/skyhold-forms.css"), "utf8");
  const bridge = readFileSync(path.join(root, "styles/parts/skyhold-foundry-bridge.css"), "utf8");
  const massCombat = readFileSync(path.join(root, "styles/parts/mass-combat/mass-combat-base.css"), "utf8");
  assert.match(forms, /input\[type="checkbox"\]::before,[\s\S]{0,150}input\[type="checkbox"\]::after[\s\S]{0,250}content:\s*none;[\s\S]{0,120}display:\s*none;/, "Skyhold forms must disable both Foundry checkbox pseudo-elements");
  assert.match(bridge, /input\[type="checkbox"\]::before,[\s\S]{0,500}input\[type="checkbox"\]::after[\s\S]{0,250}content:\s*none;[\s\S]{0,120}display:\s*none;/, "Foundry bridge must disable both checkbox pseudo-elements");
  assert.match(forms, /input\[type="checkbox"\]:checked[\s\S]{0,500}data:image\/svg\+xml/, "Skyhold checked state must render its mark as an input background");
  assert.match(bridge, /input\[type="checkbox"\]:checked[\s\S]{0,500}data:image\/svg\+xml/, "Foundry checkbox reset must render its mark as an input background");
  assert.match(forms, /input\[type="checkbox"\]:checked[\s\S]{0,500}var\(--fbls-accent\)/, "Skyhold checked state must use the shared accent palette");
  assert.match(bridge, /fbls-battle-check input\[type="checkbox"\][\s\S]{0,250}opacity:\s*1;[\s\S]{0,80}visibility:\s*visible;/, "the unlayered Foundry bridge must keep battle setup checkboxes visible over the setup-card layout");
  assert.match(massCombat, /fbls-battle-check input\[type="checkbox"\][\s\S]{0,650}width:\s*var\(--fbls-check-size\);[\s\S]{0,500}appearance:\s*none;/, "mass combat must locally reset checkbox geometry instead of inheriting its text-field capsule");
  assert.match(massCombat, /fbls-battle-check input\[type="checkbox"\]:checked[\s\S]{0,500}data:image\/svg\+xml/, "mass combat must locally own the visible checked mark");
}

function checkSettlementSeasonBoundaries() {
  const app = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  const economy = readFileSync(path.join(root, "scripts/apps/domains/finance/economy-domain.js"), "utf8");
  const production = readFileSync(path.join(root, "scripts/engines/economy/production-cycle.js"), "utf8");
  assert.match(app, /getCalendariaSeasonSnapshot\(lastDateTime,\s*lastText\)/, "Skyhold header season must use the settlement last-update date");
  assert.doesNotMatch(app, /_calendarSeasonText\(snapshot\.season\)/, "Skyhold header must not display the current world season as settlement season");
  assert.match(economy, /const calendar = holding\?\.gm\?\.calendaria \?\? \{\};[\s\S]{0,120}const lastDateTime = calendar\.lastDateTime;/, "economy production season must start from the settlement last-update date");
  assert.match(production, /deps\.getSeasonSnapshot\(holding, step\)/, "production cycle must resolve season for the settlement date at each step");
}



function extractSimpleCssRules(text) {
  const rules = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  let start = 0, quote = "", parentheses = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (char === "\\") { index += 1; continue; }
    if (quote) { if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") { parentheses += 1; continue; }
    if (char === ")") { parentheses -= 1; continue; }
    if (parentheses) continue;
    if (char === "{") {
      if (blocks.length) blocks.at(-1).children = true;
      blocks.push({ header: clean.slice(start, index).trim().replace(/\s+/g, " "), bodyStart: index + 1 });
      start = index + 1;
    } else if (char === "}") {
      const block = blocks.pop();
      if (block && !block.children) {
        const declarations = clean.slice(block.bodyStart, index).trim().replace(/\s+/g, " ");
        // Equal declarations under different media/container/layer conditions
        // can be necessary overrides, especially after an intervening rule.
        const context = blocks.map(({ header }) => header).join(" > ");
        if (block.header && declarations) rules.push(`${context ? `${context} :: ` : ""}${block.header} { ${declarations} }`);
      }
      start = index + 1;
    } else if (char === ";" && (!blocks.length || /^@(media|supports|container|layer)\b/.test(blocks.at(-1).header))) {
      start = index + 1;
    }
  }
  return rules;
}

function checkCssRuleExtraction() {
  const responsive = extractSimpleCssRules("@media (max-width: 1080px) { .icon { display: none; } } @media (max-width: 860px) { .icon { display: grid; } } @media (max-width: 600px) { .icon { display: none; } }");
  assert.equal(responsive.length, 3);
  assert.equal(new Set(responsive).size, 3, "different responsive breakpoints must not be mistaken for duplicate rules");
  for (const source of [".icon { display: none; } .icon { display: none; }", "@media (max-width: 600px) { .icon { display: none; } } @media (max-width: 600px) { .icon { display: none; } }"]) {
    const rules = extractSimpleCssRules(source);
    assert.equal(rules.length, 2);
    assert.equal(new Set(rules).size, 1, "real duplicates must still be detected within the same conditional context");
  }
  assert.equal(extractSimpleCssRules('@import url("theme.css"); .icon::after { content: "}"; }')[0], '.icon::after { content: "}"; }', "imports and quoted braces must not corrupt selector extraction");
}

function checkCssHygiene(cssFiles) {
  const cssAudit = auditCss(cssFiles);
  assert.equal(cssAudit.totalImportant, 0, `CSS !important declarations are not allowed: ${cssAudit.totalImportant} found`);
  for (const entry of cssAudit.stats) {
    assert.ok(entry.lines <= 700, `CSS file is too large: ${rel(entry.file)} (${entry.lines} lines > 700)`);
  }

  for (const file of cssFiles) {
    const seen = new Set();
    for (const rule of extractSimpleCssRules(readFileSync(file, "utf8"))) {
      assert.ok(!seen.has(rule), `Duplicate exact CSS rule in ${rel(file)}: ${rule.slice(0, 180)}`);
      seen.add(rule);
    }
  }

  return cssAudit;
}


function checkCssBalance(cssFiles) {
  for (const file of cssFiles) {
    const text = readFileSync(file, "utf8");
    let depth = 0;
    for (const char of text) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      assert.ok(depth >= 0, `CSS has an unmatched closing brace: ${rel(file)}`);
    }
    assert.equal(depth, 0, `CSS has unclosed braces: ${rel(file)}`);
  }
}


function checkCssNoNestedStyleRules(cssFiles) {
  for (const file of cssFiles) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stack = [];
    let tokenStart = 0;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === "{") {
        const head = text.slice(tokenStart, i).trim();
        const isAtRule = head.startsWith("@");
        const parent = stack[stack.length - 1];
        assert.ok(!parent || parent.isAtRule, `Nested CSS style rule in ${rel(file)} near: ${head.slice(0, 120)}`);
        stack.push({ isAtRule });
        tokenStart = i + 1;
      }
      if (char === "}") {
        stack.pop();
        tokenStart = i + 1;
      }
    }
  }
}

function checkCssCustomProperties(cssFiles) {
  const defined = new Set();
  const usedAt = new Map();
  const definitionRe = /(--fbls-[a-z0-9-]+)\s*:/gi;
  const usageRe = /var\(\s*(--fbls-[a-z0-9-]+)/gi;

  for (const file of cssFiles) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(definitionRe)) defined.add(match[1].toLowerCase());
    for (const match of text.matchAll(usageRe)) {
      const property = match[1].toLowerCase();
      if (!usedAt.has(property)) usedAt.set(property, new Set());
      usedAt.get(property).add(rel(file));
    }
  }

  const missing = [...usedAt.entries()]
    .filter(([property]) => !defined.has(property))
    .map(([property, files]) => `${property} (${[...files].sort().join(", ")})`)
    .sort();
  assert.deepEqual(missing, [], `Undefined internal CSS custom properties: ${missing.join("; ")}`);
}

function checkCssImports(cssFiles) {
  const importRe = /@import\s+url\((?:"|')(.+?)(?:"|')\)\s*;/g;
  for (const file of cssFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(importRe)) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.equal(statSync(target).isFile(), true, `Missing CSS import target: ${rel(target)} (imported from ${rel(file)})`);
    }
  }
}

function checkCurrentCssOwnerSplit() {
  const ownerIndex = readFileSync(path.join(root, "styles/parts/skyhold-current-owners.css"), "utf8");
  const orderedImports = [
    "./current/skyhold-current-building-editor.css",
    "./current/skyhold-current-building-editor-workers.css",
    "./current/skyhold-current-building-cards.css",
    "./current/skyhold-current-building-card-details.css",
    "./current/skyhold-current-economy.css"
  ];
  let previousIndex = -1;
  for (const importPath of orderedImports) {
    const index = ownerIndex.indexOf(`@import url("${importPath}");`);
    assert.ok(index > previousIndex, `Current CSS owner import order must preserve ${importPath}`);
    previousIndex = index;
  }

  const editorBase = readFileSync(path.join(root, "styles/parts/current/skyhold-current-building-editor.css"), "utf8");
  const editorWorkers = readFileSync(path.join(root, "styles/parts/current/skyhold-current-building-editor-workers.css"), "utf8");
  assert.doesNotMatch(editorBase, /\.fbls-worker-top-row\s*\{/, "building editor base owner must not reclaim worker layout");
  assert.match(editorWorkers, /\.fbls-worker-top-row\s*\{/, "building editor worker owner must contain worker layout");
  assert.match(editorBase, /container:\s*fbls-building-editor\s*\/\s*inline-size/, "building editor responsiveness must follow its Foundry window width");
  assert.match(editorWorkers, /@container fbls-building-editor \(max-width: 920px\)\s*\{\s*\.fbl-skyhold-building-editor \.fbls-worker-top-row\s*\{\s*grid-template-columns:\s*1fr 1fr;/, "building editor worker owner must retain its two-column layout for narrow windows");

  const cardsBase = readFileSync(path.join(root, "styles/parts/current/skyhold-current-building-cards.css"), "utf8");
  const cardDetails = readFileSync(path.join(root, "styles/parts/current/skyhold-current-building-card-details.css"), "utf8");
  assert.doesNotMatch(cardsBase, /\.fbls-building-storage-strip\.card-strip/, "building cards base owner must not reclaim capacity strips");
  assert.doesNotMatch(cardsBase, /\.fbls-building-production-list\s*\{/, "building cards base owner must not reclaim production rows");
  assert.match(cardDetails, /\.fbls-building-storage-strip\.card-strip/, "building card details owner must contain capacity strips");
  assert.match(cardDetails, /\.fbls-building-production-list\s*\{/, "building card details owner must contain production rows");
  assert.match(cardsBase, /column-count:\s*auto/, "building cards owner must size columns from the Foundry window width");
  assert.match(cardsBase, /column-width:\s*21rem/, "building cards owner must retain a readable automatic column width");
  assert.doesNotMatch(cardDetails, /\.fbls-building-cards\s*\{/, "building card details owner must not override the card collection layout");

  const ownership = readFileSync(path.join(root, "styles/README.md"), "utf8");
  for (const filename of [
    "skyhold-current-building-editor.css",
    "skyhold-current-building-editor-workers.css",
    "skyhold-current-building-cards.css",
    "skyhold-current-building-card-details.css"
  ]) {
    assert.ok(ownership.includes(filename), `styles/README.md must document CSS owner ${filename}`);
  }
}

function auditCss(cssFiles) {
  let totalImportant = 0;
  const stats = cssFiles.map((file) => {
    const text = readFileSync(file, "utf8");
    const important = (text.match(/!important/g) ?? []).length;
    totalImportant += important;
    return {
      file,
      lines: text.split(/\r?\n/).length,
      important
    };
  });
  stats.sort((a, b) => b.lines - a.lines);
  return {
    totalFiles: cssFiles.length,
    totalImportant,
    stats,
    largest: stats.slice(0, 5).map((entry) => `${rel(entry.file)} (${entry.lines} lines, ${entry.important} !important)`)
  };
}

function checkWriteApiHygiene(jsFiles) {
  for (const file of jsFiles) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/\bstatic\s+async\s+saveData\s*\(/.test(text), `Legacy full-save API must not be reintroduced: ${rel(file)}`);
    assert.ok(!/\bHoldingService\.saveData\s*\(/.test(text), `Legacy full-save API must not be used: ${rel(file)}`);
    assert.ok(!/\bstatic\s+async\s+patchData\s*\(/.test(text), `Legacy raw-path API must not be reintroduced: ${rel(file)}`);
    assert.ok(!/\bHoldingService\.patchData\s*\(/.test(text), `Legacy raw-path API must not be used: ${rel(file)}`);

    if (!rel(file).startsWith("scripts/apps/editors/")) continue;
    assert.ok(!/\bSkyholdData\.update\s*\(/.test(text), `Editors must resolve target objects by id inside a transaction instead of SkyholdData.update(path): ${rel(file)}`);
    assert.ok(!/\bfallback:\s*true\b/.test(text), `Specific editor windows must not silently fall back to another holding: ${rel(file)}`);
  }

  for (const file of jsFiles) {
    const fileRel = rel(file);
    const text = readFileSync(file, "utf8");
    if (fileRel.startsWith("scripts/apps/domains/events/")) {
      assert.ok(!/\bSkyholdData\.update\s*\(/.test(text), `Event domains must resolve active holding paths inside a transaction: ${fileRel}`);
      assert.ok(!/\bSkyholdData\.updateHolding\s*\(\s*this\.activeHoldingId\b/.test(text), `Event domains must use _updateActiveHolding for active holding writes: ${fileRel}`);
      assert.ok(!/\bfallback:\s*true\b/.test(text), `Active holding event handlers must not silently fall back to another holding: ${fileRel}`);
    }
    if (fileRel === "scripts/apps/mass-combat.js") {
      assert.ok(!/\bfallback:\s*true\b/.test(text), `Mass combat windows are holding-specific and must not silently fall back: ${fileRel}`);
    }
  }
}

function checkDomainComposition() {
  const domainRoot = path.join(root, "scripts/apps/domains");
  const candidateFiles = [
    ...walk(domainRoot, (file) => file.endsWith(".js")),
    path.join(root, "scripts/apps/skyhold-app.js")
  ];
  const aggregators = [];

  for (const file of candidateFiles) {
    const source = readFileSync(file, "utf8");
    const importedDomains = new Set();
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g)) {
      for (const item of match[1].split(",")) {
        const imported = item.trim().split(/\s+as\s+/)[0];
        if (/Domain$/.test(imported)) importedDomains.add(imported);
      }
    }
    if (importedDomains.size < 2) continue;

    const helper = file.endsWith("skyhold-app.js") ? "assignDomainGroup" : "composeDomainGroup";
    assert.match(source, new RegExp(`\\b${helper}\\s*\\(`), `${rel(file)} imports multiple domains and must use ${helper}`);
    for (const domainName of importedDomains) {
      const tuple = new RegExp(`\\[\\s*["']${domainName}["']\\s*,\\s*${domainName}\\s*\\]`);
      assert.match(source, tuple, `${rel(file)} must name ${domainName} explicitly in its collision-safe composition`);
    }
    aggregators.push(rel(file));
  }

  assert.deepEqual(
    aggregators.sort(),
    [
      "scripts/apps/domains/building-domain.js",
      "scripts/apps/domains/event-domain.js",
      "scripts/apps/domains/finance-domain.js",
      "scripts/apps/domains/finance/storage-domain.js",
      "scripts/apps/skyhold-app.js"
    ],
    "domain aggregator inventory changed; update collision-safe composition coverage"
  );
}

function checkFloatingTooltipConsumers() {
  const appRoot = path.join(root, "scripts/apps");
  const helperFile = path.join(appRoot, "common/floating-tooltip.js");
  const helperSource = readFileSync(helperFile, "utf8");
  assert.match(helperSource, /className\s*=\s*["']fbl-skyhold fbls-floating-tooltip["']/, "body-level tooltips must carry the Skyhold theme scope");
  assert.match(readFileSync(path.join(root, "scripts/integrations/scene-notes.js"), "utf8"), /className\s*=\s*["']fbl-skyhold fbls-building-note-tooltip["']/, "scene-note tooltips must carry the Skyhold theme scope");
  const buildingEventsSource = readFileSync(path.join(appRoot, "domains/events/building-events.js"), "utf8");
  assert.match(buildingEventsSource, /className\s*=\s*["']fbl-skyhold fbls-building-context-menu["']/, "building context menus must carry the Skyhold theme scope");
  assert.match(buildingEventsSource, /action:\s*["']cancel-project["'][\s\S]{0,250}Отменить проект/, "unfinished construction must expose a distinct project-cancellation action");
  assert.match(buildingEventsSource, /_confirmAction\?\.\([\s\S]{0,100}["']Отменить проект["']/, "project cancellation must use an explicit confirmation title");
  assert.match(buildingEventsSource, /_confirmAction\?\.\(["']Удалить здание["'][\s\S]{0,180}материалы не возвращаются/, "built-building deletion must remain an explicitly non-refundable destructive action");
  assert.match(readFileSync(path.join(root, "styles/parts/skyhold-core.css"), "utf8"), /\.fbls-floating-tooltip\s*\{[\s\S]{0,500}background:\s*var\(--fbls-surface-2\)/, "floating tooltips must use an opaque theme surface");
  assert.match(readFileSync(path.join(root, "styles/parts/current/skyhold-current-building.css"), "utf8"), /\.fbls-building-context-menu[\s\S]{0,500}background:\s*linear-gradient\([^;]*--fbls-surface-3[^;]*--fbls-surface-2/, "context menus must use an opaque theme surface");
  const appFiles = walk(appRoot, (file) => file.endsWith(".js") && file !== helperFile);
  const forbiddenImplementations = [
    /className\s*=\s*["']fbls-floating-tooltip["']/,
    /dataset\.fblsNativeTitle\s*=/,
    /window\.innerWidth\s*-\s*tooltip\.offsetWidth/
  ];
  for (const file of appFiles) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbiddenImplementations) {
      assert.doesNotMatch(source, pattern, `Floating tooltip implementation must stay centralized: ${rel(file)}`);
    }
  }

  const consumers = [
    ["scripts/apps/domains/ui-domain.js", /bindFloatingTooltips\(this,\s*root\)/],
    ["scripts/apps/editors/building-editor.js", /bindFloatingTooltips\(this,\s*root\)/],
    ["scripts/apps/editors/template-browser.js", /bindFloatingTooltips\(this,\s*root\)/],
    ["scripts/apps/unique-buildings/base-app.js", /bindFloatingTooltips\(this,\s*root\)/]
  ];
  for (const [fileRel, bindingPattern] of consumers) {
    const source = readFileSync(path.join(root, fileRel), "utf8");
    assert.match(source, /from\s+["'][^"']*common\/floating-tooltip\.js["']/, `${fileRel} must use the shared floating tooltip helper`);
    assert.match(source, bindingPattern, `${fileRel} must preserve its intended element-anchored tooltip mode`);
    assert.match(source, /hideFloatingTooltip\(this\)/, `${fileRel} must clean up its tooltip on close`);
  }
}

function checkUniqueBuildingCharacterization() {
  const mainSource = readFileSync(path.join(root, "scripts/main.js"), "utf8");
  const uniqueBaseSource = readFileSync(path.join(root, "scripts/apps/unique-buildings/base-app.js"), "utf8");
  const templateBrowserSource = readFileSync(path.join(root, "scripts/apps/editors/template-browser.js"), "utf8");
  const buildingRowsSource = readFileSync(path.join(root, "scripts/apps/domains/building/rows-domain.js"), "utf8");
  const buildingEventsSource = readFileSync(path.join(root, "scripts/apps/domains/events/building-events.js"), "utf8");
  const medicalTemplateSource = readFileSync(path.join(root, "templates/unique-buildings/medical.hbs"), "utf8");

  assert.match(uniqueBaseSource, /static\s+instances\s*=\s*new\s+Set\(\)/, "unique building windows must be tracked for external rerenders");
  assert.match(mainSource, /SkyholdUniqueBuildingApp\.rerenderOpen\(\{\s*skipFocused:\s*true\s*\}\)/, "data changes must rerender open unique building windows");
  assert.match(templateBrowserSource, /resolveUniqueBuilding\(template\)/, "unique building templates must route to their unique editor");
  assert.match(buildingRowsSource, /entry\.row\?\.visibility\s*!==\s*"gm"\s*\|\|\s*String\(entry\.row\?\.templateId/, "buildings created from hidden templates must remain visible once added to a holding");
  assert.match(buildingEventsSource, /visibility:\s*"public"/, "building instances copied from templates must not inherit hidden template visibility");
  assert.match(medicalTemplateSource, /{{#if canManageEditorTabs}}[\s\S]*data-action="pick-unique-building-image"/, "medical unique image controls must stay GM-only");
  assert.doesNotMatch(medicalTemplateSource, /\bcanEdit\b/, "medical unique tab must not expose controls through generic player edit mode");
}

function checkExternalRerenderCharacterization() {
  const focusSource = readFileSync(path.join(root, "scripts/apps/common/window-focus-keeper.js"), "utf8");
  const windowFrameSource = readFileSync(path.join(root, "scripts/apps/common/window-frame.js"), "utf8");
  const appSource = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  const mainSource = readFileSync(path.join(root, "scripts/main.js"), "utf8");
  const tendaySource = readFileSync(path.join(root, "scripts/apps/tenday-app.js"), "utf8");

  assert.match(focusSource, /\.fbl-skyhold:not\(\.fbl-skyhold-app\)/, "every secondary Skyhold window must protect the active focus from manager rerenders");
  assert.match(focusSource, /export function focusApplicationContent\b/, "secondary windows must share an initial focus helper");
  assert.match(focusSource, /export function focusApplicationContent\b[\s\S]{0,320}bringWindowFrameToFront\(frame\)/, "initial focus must raise the requested secondary window above the manager");
  assert.match(focusSource, /export function rememberApplicationFocusReturn\b/, "secondary windows must share a focus-return descriptor");
  assert.match(focusSource, /export function restoreApplicationFocus\b/, "secondary windows must restore focus through the shared helper");
  assert.match(focusSource, /new\s+globalThis\.WeakRef\(element\)/, "focus keeper must not strongly retain the last secondary-window DOM subtree");
  assert.match(focusSource, /export function forgetProtectedSkyholdWindow\b/, "focus keeper must expose explicit secondary-window cleanup");
  assert.match(focusSource, /!remembered\?\.frame\?\.isConnected[\s\S]{0,100}lastProtectedWindow\s*=\s*null/, "focus keeper must release a disconnected protected window");
  assert.match(focusSource, /now\(\)\s*-\s*Number\(remembered\.time[\s\S]{0,140}lastProtectedWindow\s*=\s*null/, "focus keeper must release an expired protected window");
  assert.match(windowFrameSource, /async _onClose\(options\)[\s\S]{0,220}finally\s*\{[\s\S]{0,100}forgetProtectedSkyholdWindow\(frame\)/, "secondary window close must forget its protected frame even when no manager render was pending");
  const buildingEditorSource = readFileSync(path.join(root, "scripts/apps/editors/building-editor.js"), "utf8");
  const uniqueBuildingSource = readFileSync(path.join(root, "scripts/apps/unique-buildings/base-app.js"), "utf8");
  assert.match(buildingEditorSource, /focusApplicationContent\(this,\s*\{[\s\S]{0,300}fbls-building-editor-tab/, "building editor must move initial keyboard focus into its active tab");
  assert.match(tendaySource, /focusApplicationContent\(this,\s*\{[\s\S]{0,360}tenday-tab/, "tenday window must claim initial focus before its background preparation rerender");
  assert.match(buildingEditorSource, /manager\?\._pendingExternalRerender[\s\S]{0,180}requestSkyholdAppRender\(\{\s*deferForActiveWindow:\s*false\s*\}\)/, "building editor close must refresh the manager only when an update was deferred");
  assert.match(buildingEditorSource, /restoreApplicationFocus\(this,\s*\{\s*root:\s*manager\?\.element\s*\}\)/, "building editor must return focus after any pending manager rerender");
  assert.match(uniqueBuildingSource, /manager\?\._pendingExternalRerender[\s\S]{0,120}requestSkyholdAppRender\(\{\s*deferForActiveWindow:\s*false\s*\}\)/, "unique building close must refresh the manager only when an update was deferred");
  const buildingEventsSource = readFileSync(path.join(root, "scripts/apps/domains/events/building-events.js"), "utf8");
  assert.match(buildingEventsSource, /rememberApplicationFocusReturn\(editor,\s*event\.currentTarget\)/, "building cards must register their focus-return target before opening an editor");
  assert.match(appSource, /activeManager !== app\.element \|\| activeControl/, "external manager rerenders must defer while another window or an editable control is active");
  assert.match(appSource, /addEventListener\("pointerdown"[\s\S]{0,500}_pendingExternalRerender/, "pending external data must refresh when the user deliberately returns to the manager surface");
  assert.match(mainSource, /Hooks\.on\("fblSkyholdDataChanged"[\s\S]{0,700}rerenderSkyhold\(\)/, "remote data changes must always reach the manager's defer-or-render policy");
  assert.doesNotMatch(mainSource, /active\?\.closest\?\.\("\.fbl-skyhold-app"\)[\s\S]{0,100}return/, "the global hook must not silently discard manager updates while a player is editing");
}

function checkResidentInputHotPath() {
  const appSource = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  const uiDomainSource = readFileSync(path.join(root, "scripts/apps/domains/ui-domain.js"), "utf8");
  const inputGuardSource = readFileSync(path.join(root, "scripts/utils/input-guards.js"), "utf8");
  assert.match(uiDomainSource, /textareaSanitizeOnInput:\s*false/, "manager textareas must defer full-block sanitation until commit/change");
  assert.match(inputGuardSource, /textareaSanitizeOnInput\s*\?\s*"input"\s*:\s*"change"/, "input guard must preserve opt-in immediate sanitation for existing editors");
  assert.match(appSource, /_scheduleResidentAppearanceTextarea\(target\)/, "resident appearance input must use its frame scheduler");
  assert.match(appSource, /_scheduleResidentAppearanceTextarea\(field\)[\s\S]{0,900}requestAnimationFrame\(apply\)/, "resident appearance autosize must coalesce layout work to one animation frame");
  assert.match(appSource, /_onClose\(options\)[\s\S]{0,1500}cancelAnimationFrame\?\.\(this\._residentAppearanceInputFrame\)/, "resident appearance input frame must be cancelled on close");
}

function checkBuildingAudioTrackCharacterization() {
  const helperSource = readFileSync(path.join(root, "scripts/apps/common/building-audio-track.js"), "utf8");
  const buildingEditorSource = readFileSync(path.join(root, "scripts/apps/editors/building-editor.js"), "utf8");
  const uniqueBaseSource = readFileSync(path.join(root, "scripts/apps/unique-buildings/base-app.js"), "utf8");
  const normalizerSource = readFileSync(path.join(root, "scripts/data/normalizers/building.js"), "utf8");
  const buildingEventsSource = readFileSync(path.join(root, "scripts/apps/domains/events/building-events.js"), "utf8");
  const blankTemplateSource = readFileSync(path.join(root, "scripts/apps/editors/helpers.js"), "utf8");
  const mainSource = readFileSync(path.join(root, "scripts/main.js"), "utf8");
  const audioEditorTemplate = readFileSync(path.join(root, "templates/building-audio-track-editor.hbs"), "utf8");

  assert.doesNotMatch(helperSource, /game\.socket\.emit|AUDIO_SOCKET_TYPE|handleBuildingAudioSocketPayload/, "building audio must not broadcast to every player in the world");
  assert.doesNotMatch(mainSource, /handleBuildingAudioSocketPayload\(payload\)/, "main socket handler must not globally route building audio playback");
  assert.match(helperSource, /playFoundryAudio\(\s*playData,\s*false\s*\)/, "building audio must play locally through the V13/V14 Foundry adapter");
  assert.match(helperSource, /loop:\s*payload\.loop|loop:\s*session\.loop|loop:\s*config\.loop/, "building audio config must preserve loop mode");
  assert.match(helperSource, /type:\s*"audio"/, "building audio track picker must use Foundry audio files");
  assert.match(audioEditorTemplate, /data-building-audio-field="mode"/, "building audio editor must expose the source mode selector");
  assert.match(audioEditorTemplate, /data-building-audio-field="playlistId"/, "building audio editor must expose Foundry playlist selection");
  assert.match(audioEditorTemplate, /data-building-audio-field="soundId"/, "building audio editor must expose Foundry playlist sound selection");
  assert.match(audioEditorTemplate, /data-building-audio-field="volume"/, "building audio editor must expose file volume control");
  assert.match(buildingEditorSource, /static\s+instances\s*=\s*new\s+Set\(\)/, "standard building editor windows must be tracked for external rerenders");
  assert.match(mainSource, /rerenderLoadedSkyholdApps\(\{\s*skipFocused:\s*true\s*\}\)/, "remote data changes must rerender already loaded building windows without eagerly importing their class");
  assert.match(buildingEditorSource, /syncBuildingAudioTrackPlayback\(this,\s*context\?\.building\)/, "standard building editor must synchronize track playback on render");
  assert.match(buildingEditorSource, /stopBuildingAudioTrack\(this\)/, "standard building editor must stop track playback on close");
  assert.match(uniqueBaseSource, /syncBuildingAudioTrackPlayback\(this,\s*context\?\.building\)/, "unique building windows must synchronize track playback on render");
  assert.match(uniqueBaseSource, /stopBuildingAudioTrack\(this\)/, "unique building windows must stop track playback on close");
  assert.match(normalizerSource, /building\.audio\.mode\s*=\s*mode/, "normalization must preserve building audio source mode");
  assert.match(normalizerSource, /building\.audio\.volume\s*=\s*Math\.min\(1,\s*Math\.max\(0,\s*toNumber/, "normalization must clamp building audio volume");
  assert.match(normalizerSource, /building\.audio\.loop\s*=\s*toBoolean\(building\.audio\.loop,\s*true\)/, "normalization must preserve building audio loop mode");
  assert.match(buildingEventsSource, /function\s+audioConfigFromTemplate/, "buildings created from templates must normalize audio config through a dedicated copier");
  assert.match(buildingEventsSource, /audio:\s*audioConfigFromTemplate\(templateCopy\)/, "buildings created from templates must inherit full audio config data");
  assert.match(blankTemplateSource, /audio:\s*\{\s*mode:\s*"file"[\s\S]*volume:\s*0\.45[\s\S]*loop:\s*true\s*\}/, "new custom building templates must include full audio config defaults");
}

function checkEditorDelegatedBindings() {
  const consumers = [
    {
      file: "scripts/apps/editors/template-browser.js",
      actionMap: "TEMPLATE_BROWSER_ACTIONS",
      preserved: [
        /querySelectorAll\("\[data-template-visibility\]"\).*addEventListener\("change"/,
        /querySelectorAll\("\[data-template-search\]"\).*addEventListener\("input"/
      ]
    },
    {
      file: "scripts/apps/editors/crew-editor.js",
      actionMap: "CREW_EDITOR_ACTIONS",
      preserved: [
        /querySelectorAll\("\[data-field\]"\).*addEventListener\("change"/,
        /querySelectorAll\("\[data-crew-slot\]"\).*addEventListener\("change"/,
        /querySelectorAll\("\[data-suitable-type-add-field\]"\).*addEventListener\("change"/
      ]
    },
    {
      file: "scripts/apps/editors/building-editor.js",
      actionMap: "BUILDING_EDITOR_ACTIONS",
      preserved: [
        /querySelectorAll\("\[data-field\]"\)[\s\S]{0,120}addEventListener\("change"/,
        /querySelectorAll\("\[data-building-worker-field\]"\)[\s\S]{0,120}addEventListener\("change"/,
        /querySelectorAll\("\[data-building-housing-field\]"\)[\s\S]{0,120}addEventListener\("change"/,
        /querySelectorAll\("textarea"\)[\s\S]{0,240}addEventListener\("input"/
      ]
    }
  ];

  for (const consumer of consumers) {
    const source = readFileSync(path.join(root, consumer.file), "utf8");
    assert.match(source, /from\s+["'][^"']*common\/delegated-events\.js["']/, `${consumer.file} must use the shared delegated event binder`);
    assert.match(source, new RegExp(`bindDelegatedActions\\(this,\\s*root,\\s*${consumer.actionMap}\\)`), `${consumer.file} must bind ${consumer.actionMap}`);
    assert.match(source, /unbindDelegatedActions\(this\)/, `${consumer.file} must abort delegated listeners on close`);
    assert.doesNotMatch(source, /querySelectorAll\([^)]*data-action[^)]*\)[\s\S]{0,160}addEventListener\("click"/, `${consumer.file} must not bind per-element action clicks`);
    for (const pattern of consumer.preserved) {
      assert.match(source, pattern, `${consumer.file} must preserve its specialized non-click event binding`);
    }
  }

  const buildingEditorSource = readFileSync(path.join(root, "scripts/apps/editors/building-editor.js"), "utf8");
  assert.doesNotMatch(buildingEditorSource, /data-suitable-type-add-field/, "building editor must not restore the removed legacy worker-type control; only construction crews retain that mechanic");

  const templateBrowserSource = readFileSync(path.join(root, "scripts/apps/editors/template-browser.js"), "utf8");
  const templateBrowserTemplate = readFileSync(path.join(root, "templates/building-template-browser.hbs"), "utf8");
  const searchHandler = templateBrowserSource.match(/\n\s*_onSearch\(event\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*_applySearchFilter/);
  assert.ok(searchHandler, "template browser must keep a focused search-input handler");
  assert.match(searchHandler[1], /this\._applySearchFilter\(this\.element,\s*this\.search\)/, "template browser search must filter the rendered cards locally");
  assert.doesNotMatch(searchHandler[1], /\b(?:render|requestRender)\s*\(/, "template browser search input must not trigger a full Application render");
  assert.match(templateBrowserSource, /querySelectorAll\?\.\("\[data-template-search-row\]"\)/, "template browser must use its precomputed DOM search index");
  assert.match(templateBrowserSource, /empty\.hidden\s*=\s*!search\s*\|\|\s*visible\s*>\s*0\s*\|\|\s*cards\.length\s*===\s*0/, "template browser must not duplicate its empty state when structural filters already returned no cards");
  assert.match(templateBrowserTemplate, /data-template-search-row="\{\{searchText\}\}"/, "template browser cards must expose their normalized search index");
  assert.match(templateBrowserTemplate, /data-template-search-empty\s+hidden/, "template browser must keep a local no-results state for live search");
}

function checkTemplatePartials(hbsFiles) {
  const mainFile = path.join(root, "scripts/main.js");
  const mainText = readFileSync(mainFile, "utf8");
  const preloadManifestText = readFileSync(path.join(root, "scripts/apps/template-preload.js"), "utf8");
  const partialRe = /{{>\s*["']([^"']+)["']/g;

  for (const file of hbsFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(partialRe)) {
      const spec = match[1];
      assert.ok(spec.startsWith("modules/fbl-skyhold/"), `Unexpected partial path in ${rel(file)}: ${spec}`);

      const targetRel = spec.slice("modules/fbl-skyhold/".length);
      const target = path.join(root, targetRel);
      assert.equal(existsSync(target), true, `Missing Handlebars partial target: ${targetRel} (referenced from ${rel(file)})`);

      if (targetRel.startsWith("templates/")) {
        const manifestRelativePath = targetRel.slice("templates/".length);
        assert.ok(
          mainText.includes(targetRel) || preloadManifestText.includes(`template("${manifestRelativePath}")`),
          `Handlebars partial is not registered in the template preload manifest: ${targetRel}`
        );
      }
    }
  }
}

function checkStorageTemplatePartials() {
  const shellFile = path.join(root, "templates/parts/skyhold-tab-storage.hbs");
  const storageRoot = path.join(root, "templates/parts/storage");
  const shellText = readFileSync(shellFile, "utf8");
  const expectedPartials = [
    "modules/fbl-skyhold/templates/parts/storage/tabs.hbs",
    "modules/fbl-skyhold/templates/parts/storage/resources.hbs",
    "modules/fbl-skyhold/templates/parts/storage/items.hbs",
    "modules/fbl-skyhold/templates/parts/storage/rooms.hbs",
    "modules/fbl-skyhold/templates/parts/storage/accounting.hbs",
    "modules/fbl-skyhold/templates/parts/storage/log.hbs"
  ];
  const partialCalls = [...shellText.matchAll(/{{>\s*["']([^"']+)["']([^}]*)}}/g)];

  assert.deepEqual(
    partialCalls.map((match) => match[1]),
    expectedPartials,
    "storage shell must include its own semantic partials once and in the canonical DOM order"
  );
  const externalMarketShell = readFileSync(path.join(root, "templates/parts/skyhold-tab-external-market.hbs"), "utf8");
  assert.match(externalMarketShell, /{{#if active\.externalMarket}}[\s\S]*{{> "modules\/fbl-skyhold\/templates\/parts\/storage\/market\.hbs"}}/, "market entry must remain available in its dedicated external-market tab");
  for (const match of partialCalls) {
    assert.equal(match[2].trim(), "", `storage partial must inherit the root context without arguments: ${match[1]}`);
  }

  assert.match(shellText, /{{#if active\.storage}}[\s\S]*<section class="fbls-panel fbls-storage-panel-modern[^"']*"[^>]*data-storage-drop-zone[\s\S]*<\/section>[\s\S]*{{\/if}}/, "storage shell must retain its root visibility guard and whole-panel drop surface");
  assert.doesNotMatch(shellText, /fbls-storage-(?:resource-grid|item-grid|room-grid|accounting-layout|log-card)/, "storage shell must not regain section markup");

  const contracts = [
    {
      file: "tabs.hbs",
      required: ["activeStorage.resources", "activeStorage.items", "activeStorage.accounting", "activeStorage.log", "canUseStorage", "storageContext.money", "data-storage-search", "data-action=\"add-storage-resource\""]
    },
    {
      file: "resources.hbs",
      required: ["{{#if activeStorage.resources}}", "storage/room-rail.hbs", "storageContext.activeRoomRows", "storageContext.activeRoomId", "data-storage-row-type=\"resources\"", "data-render-scroll-key=\"storage-resources-table\"", "../canUseStorage", "../holdingIndex"]
    },
    {
      file: "items.hbs",
      required: ["{{#if activeStorage.items}}", "storage/room-rail.hbs", "storageContext.activeItemRows", "storageContext.activeRoomId", "data-storage-row-type=\"items\"", "data-render-scroll-key=\"storage-items-table\"", "../canUseStorage", "../holdingIndex"]
    },
    {
      file: "rooms.hbs",
      required: ["{{#if activeStorage.warehouses}}", "storageContext.rooms.rows", "fbls-storage-room-grid"]
    },
    {
      file: "accounting.hbs",
      required: ["{{#if activeStorage.accounting}}", "finance.treasuryText", "finance.ledgerRows", "fbls-storage-accounting-layout"]
    },
    {
      file: "log.hbs",
      required: ["{{#if activeStorage.log}}", "canUseStorage", "storageContext.logRows", "fbls-storage-log-card"]
    }
  ];

  for (const contract of contracts) {
    const text = readFileSync(path.join(storageRoot, contract.file), "utf8");
    for (const token of contract.required) {
      assert.ok(text.includes(token), `${contract.file} must retain root-context contract token: ${token}`);
    }
  }

  const resourcesText = readFileSync(path.join(storageRoot, "resources.hbs"), "utf8");
  const itemsText = readFileSync(path.join(storageRoot, "items.hbs"), "utf8");
  const batchText = readFileSync(path.join(storageRoot, "batch-controls.hbs"), "utf8");
  const tabsText = readFileSync(path.join(storageRoot, "tabs.hbs"), "utf8");
  const roomRailText = readFileSync(path.join(storageRoot, "room-rail.hbs"), "utf8");
  const storageTabText = readFileSync(path.join(root, "templates", "parts", "skyhold-tab-storage.hbs"), "utf8");
  const storageCss = readFileSync(path.join(root, "styles", "parts", "current", "skyhold-current-storage.css"), "utf8");
  const storageEvents = readFileSync(path.join(root, "scripts", "apps", "domains", "events", "storage-events.js"), "utf8");
  const storageDialog = readFileSync(path.join(root, "scripts", "apps", "storage-action-dialog.js"), "utf8");
  const buildingCardsCss = readFileSync(path.join(root, "styles", "parts", "current", "skyhold-current-building-cards.css"), "utf8");
  const templateBrowserCss = readFileSync(path.join(root, "styles", "template-browser", "skyhold-template-browser-base.css"), "utf8");
  const templateBrowserCatalogCss = readFileSync(path.join(root, "styles", "template-browser", "skyhold-template-browser-catalog.css"), "utf8");
  const templateBrowserToolsCss = readFileSync(path.join(root, "styles", "template-browser", "skyhold-template-browser-tools.css"), "utf8");
  const cemeteryCss = readFileSync(path.join(root, "styles", "parts", "current", "skyhold-current-cemetery.css"), "utf8");
  const cemeteryTemplate = readFileSync(path.join(root, "templates", "parts", "skyhold-tab-special.hbs"), "utf8");
  const navigationEvents = readFileSync(path.join(root, "scripts", "apps", "domains", "events", "navigation-events.js"), "utf8");
  assert.doesNotMatch(resourcesText, /fbls-storage-(?:adjust|move|operations|tools-row)/, "resource register must not restore the removed operation deck");
  assert.doesNotMatch(resourcesText, /withdraw-storage-resource|fbls-storage-resource-notes|fbls-storage-row-delete/, "resource register actions and notes must stay in the context menu");
  assert.doesNotMatch(resourcesText, /fbls-storage-(?:drop-zone|target-actor|notes-card)/, "resource register must omit the retired local drop field and utility fields");
  assert.doesNotMatch(itemsText, /give-storage-item|fbls-storage-item-notes|fbls-storage-row-delete|>Описание</, "item register actions, notes and description column must stay removed");
  assert.doesNotMatch(itemsText, /fbls-storage-(?:drop-zone|target-actor|notes-card)/, "item register must omit the retired local drop field and utility fields");
  assert.match(storageTabText, /fbls-storage-panel-modern[^>]*data-storage-drop-zone/, "the entire Storage panel must be the canonical Item drop surface");
  assert.doesNotMatch(batchText, /data-storage-batch-move-to|batch-move-storage-room/, "batch selection bar must use the shared move dialog rather than the retired inline destination selector");
  assert.match(batchText, /data-action="storage-selection-move"/, "selected rows must expose a visible move action");
  for (const rows of [resourcesText, itemsText]) assert.match(rows, /data-action="storage-row-actions"[^>]*aria-label=/, "storage row menus must be reachable from a labeled keyboard button");
  assert.match(tabsText, /data-action="add-storage-resource"/, "storage resource addition must open the explicit catalog picker action");
  assert.doesNotMatch(tabsText, /data-action="add-row"[^>]+storage\.resources/, "storage resource addition must not create a placeholder row before selection");
  assert.match(storageEvents, /allowQuantity:\s*Boolean\(singleRow\)/, "single-row storage movement must expose a bounded quantity choice");
  assert.match(storageDialog, /return \{ destination, quantity: this\._readQuantity\(form\) \}/, "storage move dialog must return destination and chosen quantity together");
  assert.match(roomRailText, /toggle-storage-room-rail/, "shared storage room rail must expose its collapse control");
  assert.match(roomRailText, /storageContext\.resourceRooms/, "shared storage room rail must render canonical room rows");
  assert.match(roomRailText, /data-market-offer-image|fbls-storage-room-tab-icon[\s\S]{0,220}\{\{#if img\}\}/, "storage room navigation must render its building image with an icon fallback");
  assert.match(storageCss, /fbls-storage-resource-card\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+5\.6rem\s+2\.5rem\s+2rem/, "storage cards must retain a shrinking text track and a dedicated keyboard action column");
  assert.equal((storageEvents.match(/SkyholdStorageActionDialog\.open\(\{\s*anchor:\s*this,/g) ?? []).length, 4, "all storage context actions must anchor dialogs to the Skyhold window");
  assert.match(storageDialog, /_centerOnAnchor\(\)[\s\S]{0,900}anchor\?\._captureWindowFrame/, "storage action dialogs must center against the captured parent-window frame");
  assert.match(buildingCardsCss, /fbls-building-card\.planned,[\s\S]{0,220}background:\s*var\(--fbls-blueprint-bg\)/, "construction cards must own their blueprint background in the eagerly loaded current-building stylesheet");
  assert.doesNotMatch(templateBrowserCss, /fbls-building-card\.(?:planned|building)/, "opening the lazy template browser must not be required to style construction cards");
  assert.doesNotMatch(templateBrowserToolsCss, /(^|\n)\.fbls-crew-card\s*\{/, "opening the lazy template browser must not be required to style the construction crew");
  assert.match(navigationEvents, /button\.dataset\.storageTargetId\s*=\s*String\(row\.id/, "storage search results must carry the exact row target across the rerender");
  assert.match(navigationEvents, /_flashStorageSearchTarget[\s\S]{0,900}storage-search-hit[\s\S]{0,400}scrollIntoView/, "storage search navigation must reveal and pulse the selected row");
  assert.match(storageCss, /@keyframes fbls-storage-search-hit[\s\S]{0,500}var\(--fbls-accent-bg\)/, "storage search targets must pulse several times with the shared accent palette");
  assert.match(cemeteryTemplate, /fbls-cemetery-register[\s\S]{0,900}fbls-cemetery-entry/, "the cemetery must render as a full-width register instead of a nested table card");
  assert.match(cemeteryCss, /fbls-cemetery-register\s*\{[\s\S]{0,300}width:\s*100%;[\s\S]{0,500}overflow:\s*auto/, "the eager cemetery owner must keep compact rows across the full panel width");
  assert.doesNotMatch(`${templateBrowserCss}\n${templateBrowserCatalogCss}`, /fbls-cemetery-table|cemetery-only/, "cemetery layout must not depend on opening the lazy template browser");
}

function braceBody(text, openIndex, label) {
  assert.equal(text[openIndex], "{", `Expected object body for ${label}`);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openIndex + 1, index), start: openIndex + 1, end: index };
    }
  }
  throw new Error(`Unclosed object body for ${label}`);
}

function stringMapEntries(file, declarationName, propertyName = "") {
  const text = readFileSync(file, "utf8");
  const declarationRe = new RegExp(`(?:export\\s+)?const\\s+${declarationName}\\s*=\\s*`);
  const declaration = declarationRe.exec(text);
  assert.ok(declaration, `Missing action map ${declarationName} in ${rel(file)}`);
  const outerOpen = text.indexOf("{", declaration.index + declaration[0].length);
  const outer = braceBody(text, outerOpen, `${declarationName} in ${rel(file)}`);
  let body = outer.body;
  if (propertyName) {
    const propertyRe = new RegExp(`\\b${propertyName}\\s*:\\s*`);
    const property = propertyRe.exec(body);
    assert.ok(property, `Missing ${declarationName}.${propertyName} in ${rel(file)}`);
    const propertyOpen = text.indexOf("{", outer.start + property.index + property[0].length);
    body = braceBody(text, propertyOpen, `${declarationName}.${propertyName} in ${rel(file)}`).body;
  }

  const entries = [];
  const entryRe = /(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][A-Za-z0-9_$-]*))\s*:\s*(?:"([^"]+)"|'([^']+)')/g;
  for (const match of body.matchAll(entryRe)) {
    entries.push({
      action: match[1] ?? match[2] ?? match[3],
      handler: match[4] ?? match[5],
      source: rel(file)
    });
  }
  assert.ok(entries.length > 0, `No string action entries found in ${declarationName}${propertyName ? `.${propertyName}` : ""} (${rel(file)})`);
  return entries;
}

function stringArrayEntries(file, declarationName, propertyName) {
  const text = readFileSync(file, "utf8");
  const declarationRe = new RegExp(`(?:export\\s+)?const\\s+${declarationName}\\s*=\\s*`);
  const declaration = declarationRe.exec(text);
  assert.ok(declaration, `Missing action definition ${declarationName} in ${rel(file)}`);
  const outerOpen = text.indexOf("{", declaration.index + declaration[0].length);
  const outer = braceBody(text, outerOpen, `${declarationName} in ${rel(file)}`);
  const propertyRe = new RegExp(`\\b${propertyName}\\s*:\\s*\\[([\\s\\S]*?)\\]`);
  const property = propertyRe.exec(outer.body);
  if (!property) return [];
  return [...property[1].matchAll(/["']([^"']+)["']/g)].map((match) => ({
    action: match[1],
    source: rel(file)
  }));
}

function templateActions(files) {
  const actions = new Map();
  const actionRe = /data-action\s*=\s*["']([^"']+)["']/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(actionRe)) {
      if (!actions.has(match[1])) actions.set(match[1], new Set());
      actions.get(match[1]).add(rel(file));
    }
  }
  return actions;
}

function literalDatasetActions(files) {
  const actions = new Map();
  const actionRe = /\.dataset\.action\s*=\s*(?:[^;\n?]+\?\s*)?["']([^"']+)["'](?:\s*:\s*["']([^"']+)["'])?/g;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(actionRe)) {
      for (const action of match.slice(1).filter(Boolean)) {
        if (!actions.has(action)) actions.set(action, new Set());
        actions.get(action).add(rel(file));
      }
    }
  }
  return actions;
}

function actionHandlerNames(files) {
  const handlers = new Set();
  const handlerRe = /^\s*(?:async\s+)?(_on[A-Za-z0-9]+)\s*\(/gm;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(handlerRe)) handlers.add(match[1]);
  }
  return handlers;
}

function assertActionEntries(contextName, entries, handlerFiles) {
  const owners = new Map();
  for (const entry of entries) {
    assert.ok(entry.action && entry.handler, `${contextName} has an incomplete action entry in ${entry.source}`);
    if (owners.has(entry.action)) {
      const previous = owners.get(entry.action);
      throw new Error(`${contextName} registers duplicate action "${entry.action}" in ${previous.source} and ${entry.source}`);
    }
    owners.set(entry.action, entry);
  }

  const handlers = actionHandlerNames(handlerFiles);
  const missingHandlers = entries
    .filter((entry) => !handlers.has(entry.handler))
    .map((entry) => `${entry.action} -> ${entry.handler} (${entry.source})`);
  assert.deepEqual(missingHandlers, [], `${contextName} actions reference missing handlers: ${missingHandlers.join("; ")}`);
}

function assertExactActionCoverage(contextName, usedActions, entries, ignoredUsed = new Set()) {
  const registered = new Set(entries.map((entry) => entry.action));
  const used = new Set(usedActions.keys());
  const missing = [...used]
    .filter((action) => !ignoredUsed.has(action) && !registered.has(action))
    .map((action) => `${action} (${[...(usedActions.get(action) ?? [])].sort().join(", ")})`)
    .sort();
  const unused = [...registered].filter((action) => !used.has(action)).sort();
  assert.deepEqual(missing, [], `${contextName} templates use actions without handlers: ${missing.join("; ")}`);
  assert.deepEqual(unused, [], `${contextName} registers unused actions: ${unused.join(", ")}`);
}

function mergeActionLocations(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [action, locations] of map) {
      if (!merged.has(action)) merged.set(action, new Set());
      for (const location of locations) merged.get(action).add(location);
    }
  }
  return merged;
}

function checkActionCoverage() {
  const appRoot = path.join(root, "scripts/apps");
  const templateRoot = path.join(root, "templates");
  const eventRoot = path.join(appRoot, "domains/events");

  const mainTemplateFiles = [
    path.join(templateRoot, "skyhold-app.hbs"),
    ...readdirSync(path.join(templateRoot, "parts"))
      .filter((name) => /^skyhold-.*\.hbs$/.test(name))
      .map((name) => path.join(templateRoot, "parts", name)),
    ...walk(path.join(templateRoot, "parts/storage"), (file) => file.endsWith(".hbs"))
  ];
  const mainActionSources = [
    [path.join(appRoot, "skyhold-app.js"), "SkyholdAppActions"],
    [path.join(eventRoot, "navigation-events.js"), "NavigationEventActions"],
    [path.join(eventRoot, "resident-events.js"), "ResidentEventActions"],
    [path.join(eventRoot, "building-events.js"), "BuildingEventActions"],
    [path.join(eventRoot, "economy-events.js"), "EconomyEventActions"],
    [path.join(eventRoot, "finance-control-events.js"), "FinanceControlEventActions"],
    [path.join(eventRoot, "storage-events.js"), "StorageEventActions"],
    [path.join(eventRoot, "event-automation-events.js"), "EventAutomationActions"],
    [path.join(eventRoot, "ship-events.js"), "ShipEventActions"],
    [path.join(eventRoot, "gm-events.js"), "GmEventActions"]
  ];
  const mainEntries = mainActionSources.flatMap(([file, name]) => stringMapEntries(file, name, "click"));
  const mainPublicEntries = mainActionSources.flatMap(([file, name]) => stringArrayEntries(file, name, "publicClick"));
  const mainHandlerFiles = [
    path.join(appRoot, "skyhold-app.js"),
    path.join(appRoot, "domains/child-window-domain.js"),
    ...walk(eventRoot, (file) => file.endsWith(".js"))
  ];
  const shipWindowSource = readFileSync(path.join(appRoot, "ship-app.js"), "utf8");
  const shipTemplateActions = templateActions(walk(path.join(templateRoot, "parts/ship-window"), (file) => file.endsWith(".hbs")));
  // Navigation belongs to the separate ship window, outside the shared mutation registry.
  const shipNavigationBranch = shipWindowSource.match(/\[([^\]]+)\]\.includes\(button\.dataset\.action\)\)\s*\{\s*dispatchDelegatedAction\(this, event, button, \(delegated\) => navigateFromShip\(this, delegated\)\);/);
  assert.ok(shipNavigationBranch, "ship window navigation actions must dispatch through the navigation handler");
  const shipNavigationActions = new Set([...shipNavigationBranch[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]));
  assert.deepEqual([...shipNavigationActions].sort(), ["ship-open-market", "ship-open-resident", "ship-open-sale"], "ship window navigation must cover markets, residents and active sales");
  assert.match(shipWindowSource, /import\s*\{\s*navigateFromShip\s*\}\s*from\s*["']\.\/domains\/ship-navigation\.js["']/, "ship window navigation must resolve to its permission-aware domain handler");
  for (const action of shipNavigationActions) assert.ok(shipTemplateActions.has(action), `ShipWindow registers unused navigation action: ${action}`);
  const mainUsed = mergeActionLocations(
    templateActions(mainTemplateFiles),
    // ShipEventDomain is shared by the manager and its separate ship window.
    new Map([...shipTemplateActions]
      .filter(([action]) => action !== "ship-window-tab" && action !== "ship-place-home" && !shipNavigationActions.has(action))),
    literalDatasetActions([
      path.join(appRoot, "ship-order-planner.js"),
      path.join(appRoot, "domains/ui-domain.js"),
      path.join(eventRoot, "navigation-events.js")
    ])
  );
  assertActionEntries("SkyholdApp", mainEntries, mainHandlerFiles);
  const publicOwners = new Map();
  const registeredMainActions = new Set(mainEntries.map((entry) => entry.action));
  for (const entry of mainPublicEntries) {
    assert.ok(!publicOwners.has(entry.action), `SkyholdApp registers duplicate public action "${entry.action}" in ${publicOwners.get(entry.action)} and ${entry.source}`);
    assert.ok(registeredMainActions.has(entry.action), `SkyholdApp public action "${entry.action}" in ${entry.source} has no click handler`);
    publicOwners.set(entry.action, entry.source);
  }
  // The holding selector is a change action handled by a dedicated branch, not the click registry.
  assertExactActionCoverage("SkyholdApp", mainUsed, mainEntries, new Set(["select-holding"]));

  const buildingEditorFile = path.join(appRoot, "editors/building-editor.js");
  const buildingEntries = stringMapEntries(buildingEditorFile, "BUILDING_EDITOR_ACTIONS");
  const buildingTemplates = [
    path.join(templateRoot, "building-editor.hbs"),
    ...readdirSync(path.join(templateRoot, "parts/building-editor")).filter((name) => name.endsWith(".hbs")).map((name) => path.join(templateRoot, "parts/building-editor", name))
  ];
  assertActionEntries("BuildingEditor", buildingEntries, [buildingEditorFile]);
  assertExactActionCoverage("BuildingEditor", templateActions(buildingTemplates), buildingEntries);

  const crewEditorFile = path.join(appRoot, "editors/crew-editor.js");
  const crewEntries = stringMapEntries(crewEditorFile, "CREW_EDITOR_ACTIONS");
  assertActionEntries("CrewEditor", crewEntries, [crewEditorFile]);
  assertExactActionCoverage("CrewEditor", templateActions([path.join(templateRoot, "crew-editor.hbs")]), crewEntries);

  const templateBrowserFile = path.join(appRoot, "editors/template-browser.js");
  const templateBrowserEntries = stringMapEntries(templateBrowserFile, "TEMPLATE_BROWSER_ACTIONS");
  assertActionEntries("TemplateBrowser", templateBrowserEntries, [templateBrowserFile]);
  assertExactActionCoverage("TemplateBrowser", templateActions([path.join(templateRoot, "building-template-browser.hbs")]), templateBrowserEntries);

  const massCombatFile = path.join(appRoot, "mass-combat.js");
  const massCombatEntries = stringMapEntries(massCombatFile, "clickActions");
  const massCombatTemplates = [
    path.join(templateRoot, "mass-combat.hbs"),
    ...readdirSync(path.join(templateRoot, "parts/mass-combat")).filter((name) => name.endsWith(".hbs")).map((name) => path.join(templateRoot, "parts/mass-combat", name))
  ];
  assertActionEntries("MassCombat", massCombatEntries, [massCombatFile]);
  assertExactActionCoverage("MassCombat", templateActions(massCombatTemplates), massCombatEntries);

  const massTagEditorFile = path.join(appRoot, "editors/mass-combat-tag-editor.js");
  const massTagEntries = stringMapEntries(massTagEditorFile, "actions");
  assertActionEntries("MassCombatTagEditor", massTagEntries, [massTagEditorFile]);
  assertExactActionCoverage("MassCombatTagEditor", templateActions([path.join(templateRoot, "mass-combat-tag-editor.hbs")]), massTagEntries);
}

export async function runRepositoryContracts() {
  const jsFiles = walk(root, (file) => /\.(js|mjs)$/.test(file));
  const cssFiles = walk(root, (file) => /\.css$/.test(file));
  const hbsFiles = walk(root, (file) => /\.hbs$/.test(file));
  checkEngineGlobalAssertions();
  checkCssRuleExtraction();
  checkSchemaVersionSource(jsFiles);
  checkDataModuleBoundaries(jsFiles);
  checkNormalizerBoundaries();
  checkResourceDataBoundaries(jsFiles);
  checkEconomyEngineBoundaries();
  checkStorageEngineBoundaries();
  checkMarketBoundaries();
  checkMassCombatCalculationBoundaries();
  checkWorkerPlannerBoundaries();
  checkRandomEventEditorBoundaries();
  checkResidentEventBoundaries();
  checkCheckboxRenderingStability();
  checkSettlementSeasonBoundaries();
  checkWriteApiHygiene(jsFiles);
  checkDomainComposition();
  checkFloatingTooltipConsumers();
  checkUniqueBuildingCharacterization();
  checkExternalRerenderCharacterization();
  checkResidentInputHotPath();
  checkBuildingAudioTrackCharacterization();
  checkEditorDelegatedBindings();
  checkTemplatePartials(hbsFiles);
  checkStorageTemplatePartials();
  checkActionCoverage();
  checkCssImports(cssFiles);
  checkCurrentCssOwnerSplit();
  checkCssBalance(cssFiles);
  checkCssNoNestedStyleRules(cssFiles);
  checkCssCustomProperties(cssFiles);

  const normalizers = await import(pathToFileURL(path.join(root, "scripts/data/normalizers.js")));
  const schema = await import(pathToFileURL(path.join(root, "scripts/data/schema.js")));
  const baseSchema = await import(pathToFileURL(path.join(root, "scripts/data/schema/base-holding.js")));
  const defaultData = await import(pathToFileURL(path.join(root, "scripts/data/defaults/default-skyhold-data.js")));
  const workerTypes = await import(pathToFileURL(path.join(root, "scripts/data/worker-types.js")));
  const laputaCompatibility = await import(pathToFileURL(path.join(root, "scripts/data/laputa-import.js")));
  const laputaPreset = await import(pathToFileURL(path.join(root, "scripts/data/presets/laputa.js")));
  const restorationPreset = await import(pathToFileURL(path.join(root, "scripts/data/presets/restoration-settlement.js")));
  const magnificPreset = await import(pathToFileURL(path.join(root, "scripts/data/presets/magnific.js")));
  const schemaVersion = await import(pathToFileURL(path.join(root, "scripts/data/schema-version.js")));
  const settings = await import(pathToFileURL(path.join(root, "scripts/data/settings.js")));
  const dataConstants = await import(pathToFileURL(path.join(root, "scripts/data/constants.js")));
  const buildingTemplates = await import(pathToFileURL(path.join(root, "scripts/data/building-templates.js")));
  const buildingTemplateManifest = await import(pathToFileURL(path.join(root, "scripts/data/building-template-manifest.js")));
  const buildingTemplatesUnique = await import(pathToFileURL(path.join(root, "scripts/data/building-template-catalog/unique.js")));
  const authority = await import(pathToFileURL(path.join(root, "scripts/data/authority.js")));
  const commandResults = await import(pathToFileURL(path.join(root, "scripts/data/command-result.js")));
  const holdingPermissions = await import(pathToFileURL(path.join(root, "scripts/data/holding-permissions.js")));
  const guard = await import(pathToFileURL(path.join(root, "scripts/data/player-write-guard.js")));
  const store = await import(pathToFileURL(path.join(root, "scripts/data/store.js")));
  const formula = await import(pathToFileURL(path.join(root, "scripts/core/formula.js")));
  const buildingSpecials = await import(pathToFileURL(path.join(root, "scripts/core/building-specials.js")));
  const resources = await import(pathToFileURL(path.join(root, "scripts/core/resources.js")));
  const storageItemQuantity = await import(pathToFileURL(path.join(root, "scripts/engines/storage/item-quantity.js")));
  const builtinResources = await import(pathToFileURL(path.join(root, "scripts/data/resources/builtin-resources.js")));
  const resourceBaseDefinitions = await import(pathToFileURL(path.join(root, "scripts/data/resources/resource-base-definitions.js")));
  const worldResourceBindings = await import(pathToFileURL(path.join(root, "scripts/data/resources/world-resource-bindings.js")));
  const resourceCatalogSettings = await import(pathToFileURL(path.join(root, "scripts/data/resources/resource-catalog-settings.js")));
  const dataBarrel = await import(pathToFileURL(path.join(root, "scripts/data.js")));
  const renderScheduler = await import(pathToFileURL(path.join(root, "scripts/apps/common/render-scheduler.js")));
  const derivedContextCache = await import(pathToFileURL(path.join(root, "scripts/apps/common/derived-context-cache.js")));
  const delegatedEvents = await import(pathToFileURL(path.join(root, "scripts/apps/common/delegated-events.js")));
  const floatingTooltip = await import(pathToFileURL(path.join(root, "scripts/apps/common/floating-tooltip.js")));
  const actionRouter = await import(pathToFileURL(path.join(root, "scripts/apps/events/action-router.js")));
  const domainComposer = await import(pathToFileURL(path.join(root, "scripts/apps/domains/compose-domain.js")));
  const residentDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/resident-domain.js")));
  const financeDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance-domain.js")));
  const financeAgricultureDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/agriculture-domain.js")));
  const financeControlsDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/controls-domain.js")));
  const financeTreasuryDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/treasury-domain.js")));
  const financeTradeDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/trade-domain.js")));
  const financeStorageDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/storage-domain.js")));
  const financeInternalDemandDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/internal-demand-domain.js")));
  const financeLivestockDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/livestock-domain.js")));
  const financeMaintenanceDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/maintenance-domain.js")));
  const financeStaffDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/staff-domain.js")));
  const financeEconomyDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/finance/economy-domain.js")));
  const holdingDomainModule = await import(pathToFileURL(path.join(root, "scripts/apps/domains/holding-domain.js")));
  const buildingDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building-domain.js")));
  const buildingMetaDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/meta-domain.js")));

  assert.equal(storageItemQuantity.itemQuantity({ system: { quantity: 4 } }), 4, "Forbidden Lands Item quantity must read system.quantity");
  assert.equal(storageItemQuantity.itemQuantity({ qty: 2, system: { quantity: 4 } }), 2, "stored row quantity must be the stable snapshot authority");
  const quantitySource = { name: "Rope", system: { quantity: 1 } };
  const quantityCopy = storageItemQuantity.setItemQuantityData(quantitySource, 3);
  assert.equal(quantityCopy.system.quantity, 3, "Item quantity adapter must write system.quantity");
  assert.equal(quantitySource.system.quantity, 1, "Item quantity adapter must not mutate its source document data");
  assert.deepEqual(storageItemQuantity.itemQuantityUpdateData(5), { "system.quantity": 5 }, "Item quantity updates must expose the system-specific Foundry path");
  const buildingWorkerDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/worker-domain.js")));
  const buildingProductionDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/production-domain.js")));
  const buildingAgricultureDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/agriculture-domain.js")));
  const buildingLivestockDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/livestock-domain.js")));
  const buildingDevelopmentDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/development-domain.js")));
  const buildingRowsDomain = await import(pathToFileURL(path.join(root, "scripts/apps/domains/building/rows-domain.js")));
  const buildingState = await import(pathToFileURL(path.join(root, "scripts/core/building-state.js")));
  const tendayPreview = await import(pathToFileURL(path.join(root, "scripts/apps/domains/events/tenday-preview.js")));
  const storageCommit = await import(pathToFileURL(path.join(root, "scripts/data/storage-commit.js")));
  const storageSearch = await import(pathToFileURL(path.join(root, "scripts/engines/storage/search.js")));
  const housingAssignment = await import(pathToFileURL(path.join(root, "scripts/engines/housing/assignment.js")));
  const massCombatRules = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/rules.js")));
  const massCombatState = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/state.js")));
  const massCombatCalculator = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/calculator.js")));
  const massCombatResidents = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/residents.js")));
  const massCombatSources = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/sources.js")));
  const massCombatModifiers = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/modifiers.js")));
  const massCombatCasualties = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/casualties.js")));
  const massCombatRound = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/round.js")));
  const massCombatTracks = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/tracks.js")));
  const massCombatTerminal = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/terminal.js")));
  const massCombatRoundResolution = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/round-resolution.js")));
  const massCombatArchive = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/archive.js")));
  const massCombatDamage = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/damage.js")));
  const massCombatTargets = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/targets.js")));
  const massCombatWeather = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/weather.js")));
  const massCombatCounterGraph = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/counter-graph.js")));
  const massCombatIconCatalog = await import(pathToFileURL(path.join(root, "scripts/apps/mass-combat/icon-catalog.js")));
  const holdingServiceModule = await import(pathToFileURL(path.join(root, "scripts/data/holding-service.js")));
  const performanceFixtures = await import(pathToFileURL(path.join(root, "scripts/dev/performance-fixtures.mjs")));

  const housingFixture = {
    people: {
      list: [
        { id: "p1", name: "Анна", home: "home-a" },
        { id: "p2", name: "Борис", home: "" },
        { id: "p3", name: "Вера", home: "снесенный дом" },
        { id: "p4", name: "Глеб", home: "" },
        { id: "dead", name: "Мертвый", dead: true, home: "" }
      ]
    },
    buildings: {
      list: [
        { id: "home-a", name: "Дом А", operational: true, housing: { capacity: 2, comfort: 1, quality: 1 } },
        { id: "home-b", name: "Дом Б", operational: true, housing: { capacity: 1, comfort: 3, quality: 2 } },
        { id: "ruin", name: "Руины", operational: false, housing: { capacity: 20, comfort: 9, quality: 9 } }
      ]
    }
  };
  const housingResult = housingAssignment.assignResidentsToFreeHousing(housingFixture, {
    isResidentialBuilding: (building) => building.operational === true
  });
  assert.equal(housingResult.assigned, 2, "housing auto-assignment must fill only available operational housing slots");
  assert.equal(housingResult.remaining, 1, "housing auto-assignment must report residents left without a free slot");
  assert.equal(housingFixture.people.list[0].home, "home-a", "housing auto-assignment must preserve an existing valid home");
  assert.equal(housingFixture.people.list[1].home, "home-b", "housing auto-assignment must prefer the more comfortable free home");
  assert.equal(housingFixture.people.list[2].home, "home-a", "housing auto-assignment must repair an invalid home reference");
  assert.equal(housingFixture.people.list[3].home, "", "housing auto-assignment must leave overflow residents untouched");
  assert.equal(housingFixture.people.list[4].home, "", "housing auto-assignment must ignore deceased residents");

  for (const characterization of [
    "material-group-characterization-check.mjs",
    "market-characterization-check.mjs",
    "market-economy-characterization-check.mjs"
  ]) {
    execFileSync(process.execPath, [path.join(root, "scripts/dev", characterization)], { stdio: "inherit" });
  }

  assert.deepEqual(
    performanceFixtures.PERFORMANCE_SCENARIOS.map(({ residents, buildings }) => [residents, buildings]),
    [[100, 50], [500, 200], [1000, 200]],
    "performance scenarios must retain the roadmap settlement sizes"
  );
  const mediumPerformanceFixture = performanceFixtures.makeLargeSettlementFixture(performanceFixtures.PERFORMANCE_SCENARIOS[0]);
  assert.equal(mediumPerformanceFixture.holdings[0].people.list.length, 100, "the medium performance fixture must include 100 residents");
  assert.equal(mediumPerformanceFixture.holdings[0].buildings.list.length, 50, "the medium performance fixture must include 50 buildings");
  assert.equal(mediumPerformanceFixture.holdings[0].storage.resources.length, 100, "the performance fixture must include a large storage surface");
  assert.equal(mediumPerformanceFixture.holdings[0].storage.log.length, 250, "the performance fixture must include a populated storage log");
  const contextCache = derivedContextCache.createDerivedContextCache({ limit: 2 });
  let contextBuilds = 0;
  assert.equal(contextCache.setGeneration(4), true, "derived context cache must accept its first revision generation");
  const contextKey = derivedContextCache.derivedContextKey({ revision: 4, holdingId: "h1", tab: "people" });
  const firstContext = contextCache.getOrCreate(contextKey, () => ({ build: ++contextBuilds }));
  const cachedContext = contextCache.getOrCreate(contextKey, () => ({ build: ++contextBuilds }));
  assert.equal(cachedContext, firstContext, "derived context cache hits must reuse the prepared immutable context");
  assert.equal(contextBuilds, 1, "derived context cache hits must not rebuild an active tab context");
  contextCache.getOrCreate(derivedContextCache.derivedContextKey({ revision: 4, holdingId: "h1", tab: "storage" }), () => ({ build: ++contextBuilds }));
  assert.equal(contextCache.getMetrics().size, 2, "derived context cache must stay bounded");
  assert.equal(contextCache.setGeneration(5), true, "a new revision generation must invalidate derived contexts");
  assert.equal(contextCache.getMetrics().size, 0, "derived context cache must not retain entries from an obsolete revision");
  assert.equal(contextCache.setGeneration(5), false, "reusing the current revision generation must preserve cache entries");
  contextCache.getOrCreate(derivedContextCache.derivedContextKey({ revision: 5, holdingId: "h1", tab: "people" }), () => ({ build: ++contextBuilds }));
  assert.equal(contextCache.getMetrics().size, 1, "the current revision must start a fresh bounded cache generation");
  for (let revision = 6; revision <= 25; revision += 1) {
    contextCache.setGeneration(revision);
    contextCache.getOrCreate(derivedContextCache.derivedContextKey({ revision, holdingId: "h1", tab: "people" }), () => ({ revision }));
  }
  assert.equal(contextCache.getMetrics().size, 1, "twenty sequential revisions must retain only the current derived context generation");

  const residentDomainSource = readFileSync(path.join(root, "scripts/apps/domains/resident-domain.js"), "utf8");
  const residentEventSource = readFileSync(path.join(root, "scripts/apps/domains/events/resident-events.js"), "utf8");
  const peopleTemplateSource = readFileSync(path.join(root, "templates/parts/skyhold-tab-people.hbs"), "utf8");
  const residentEditorSource = readFileSync(path.join(root, "scripts/apps/editors/resident-editor.js"), "utf8");
  const residentEditorWindowTemplate = readFileSync(path.join(root, "templates/resident-editor.hbs"), "utf8");
  const skyholdAppSource = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  assert.doesNotMatch(residentDomainSource, /if \(search\)[\s\S]{0,500}haystack\.includes/, "resident search must not remove rows during full context preparation");
  assert.match(residentEventSource, /_applyResidentSearchFilter\([\s\S]{0,800}row\.hidden = !show/, "resident search must filter prepared rows locally");
  assert.match(peopleTemplateSource, /<template data-resident-work-option-catalog>[\s\S]*?#each rows\.residentWorkOptionCatalog/, "resident work choices must have one shared option catalog");
  assert.doesNotMatch(peopleTemplateSource, /fbls-person-edit-row|skyhold-resident-editor\.hbs/, "the resident table must not embed the editor below a row");
  assert.match(residentEventSource, /import \{ loadResidentEditorClass \} from "\.\.\/\.\.\/lazy-apps\.js";/, "resident editing must keep the standalone editor behind the lazy app boundary");
  assert.match(residentEventSource, /async _openResidentEditor\([\s\S]{0,600}ResidentEditor\.open/, "resident editing actions must open the standalone editor through one shared helper");
  assert.match(residentEditorSource, /export class SkyholdResidentEditor extends WindowFrameMixin\(RenderSchedulerMixin\(HandlebarsApplicationMixin\(ApplicationV2\)\)\)/, "the standalone resident editor must use the established ApplicationV2 window stack");
  assert.match(residentEditorSource, /focusApplicationContent\(this, \{ root, options/, "the standalone resident editor must restore explicit ApplicationV2 focus after rendering");
  assert.match(residentEditorWindowTemplate, /fbls-resident-editor-window[\s\S]*skyhold-resident-editor\.hbs/, "the standalone resident window must host the shared resident form");
  const inlineWorkSelect = peopleTemplateSource.match(/<select class="fbls-resident-work-select"[\s\S]*?<\/select>/)?.[0] ?? "";
  assert.ok(inlineWorkSelect, "the one-click inline resident work select must remain available");
  assert.doesNotMatch(inlineWorkSelect, /#each workOptions/, "inline resident rows must not duplicate the full building catalog");
  assert.match(inlineWorkSelect, /data-resident-work-select-lazy/, "inline resident work selects must opt into synchronous lazy hydration");
  assert.match(skyholdAppSource, /addEventListener\("pointerdown"[\s\S]*?_hydrateResidentWorkSelect/, "pointer interaction must hydrate resident work choices before the native select opens");
  assert.match(skyholdAppSource, /addEventListener\("focusin"[\s\S]*?_hydrateResidentWorkSelect/, "keyboard focus must hydrate resident work choices before selection keys are used");
  assert.match(skyholdAppSource, /_residentAppearanceResizeObserver\?\.disconnect\?\.\(\);[\s\S]{0,120}_residentAppearanceResizeObserver = null;/, "closing the manager must release its appearance observer");
  assert.match(skyholdAppSource, /_onClose\(options\)[\s\S]{0,1800}if \(SkyholdApp\.instance === this\) SkyholdApp\.instance = null;/, "closing the manager must release its singleton instance");
  assert.match(skyholdAppSource, /new ResizeObserver\(\(entries\) =>[\s\S]{0,500}entries[\s\S]{0,500}schedule/, "trait resize handling must batch only observer entries instead of rescanning every resident");

  const residentSubject = Object.assign({
    editingPersonId: null,
    residentFilters: { type: "all", work: "all", home: "all", morale: "all" },
    _constructionCrews: () => [{ id: "crew-a", name: "Стройбригада А", isDefault: true, memberIds: [] }],
    _medicalAssignments: () => new Map(),
    _safeNumber: (value, fallback = 0) => {
      if (value === null || value === undefined || value === "") return fallback;
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    },
    _workMorale: () => ({ value: 0, reason: "" })
  }, residentDomain.ResidentDomain);
  const residentHolding = {
    people: { list: [
      { id: "resident-full", name: "Занятый", age: 30, workAssignment: "building-full", role: "Рабочий", attributes: {} },
      { id: "resident-custom", name: "Особый", age: 30, workAssignment: "other", role: "Стеклодув", attributes: {} },
      { id: "resident-injured", name: "Раненый", age: 30, injuredDays: 2, workAssignment: "building-open", role: "Рабочий", attributes: {} },
      { id: "resident-drift", name: "Рассинхрон", age: 30, workAssignment: "building-drift-full", role: "Рабочий", attributes: {} }
    ] },
    buildings: { list: [
      { id: "building-open", name: "Свободная мастерская", status: "built", workersMax: 2, assignedWorkerIds: [], functions: {} },
      { id: "building-full", name: "Заполненная мастерская", status: "built", workersMax: 1, assignedWorkerIds: ["resident-full"], functions: {} },
      { id: "building-zero", name: "Без рабочих мест", status: "built", workersMax: 0, assignedWorkerIds: [], functions: {} },
      { id: "building-planned", name: "Только проект", constructionStatus: "planned", workersMax: 5, assignedWorkerIds: [], functions: {} },
      { id: "building-drift-full", name: "Занято по жителю", status: "built", workersMax: 1, assignedWorkerIds: [], functions: {} }
    ] },
    construction: { crews: [] }
  };
  const residentWorkContext = residentSubject._residentWorkOptionsContext(residentHolding);
  const sharedWorkCatalog = residentSubject._residentWorkOptionCatalog(residentWorkContext);
  assert.ok(sharedWorkCatalog.some((option) => option.value === "building-open"), "shared resident work catalog must include buildings with a free slot");
  for (const unavailableId of ["building-full", "building-zero", "building-planned", "building-drift-full"]) {
    assert.equal(sharedWorkCatalog.some((option) => option.value === unavailableId), false, `shared resident work catalog must omit unavailable building ${unavailableId}`);
  }
  assert.equal(residentSubject._residentInlineWorkOption(residentHolding.people.list[0], "Заполненная мастерская", residentWorkContext).value, "building-full", "the compact select must preserve a resident's selected full building");
  assert.equal(residentSubject._residentInlineWorkOption(residentHolding.people.list[1], "Стеклодув", residentWorkContext).value, "other", "custom work must remain represented by the existing 'other' choice");
  assert.equal(residentSubject._residentInlineWorkOption(residentHolding.people.list[2], "Свободная мастерская", residentWorkContext).value, "", "an injured resident must keep the previous non-working select semantics");
  for (const person of [
    ...residentHolding.people.list,
    { id: "resident-free", age: 30, role: "", workAssignment: "" },
    { id: "resident-soldier", age: 30, role: "Солдат", workAssignment: "" },
    { id: "resident-crew", age: 30, role: "Рабочий", workAssignment: "construction" },
    { id: "resident-missing", age: 30, role: "Рабочий", workAssignment: "missing-building" },
    { id: "resident-child", age: 8, role: "", workAssignment: "" },
    { id: "resident-child-custom", age: 8, role: "Помощник", workAssignment: "other" }
  ]) {
    const fullOptions = residentSubject._workOptions(residentHolding, person, residentWorkContext);
    const previousVisibleOption = fullOptions.find((option) => option.selected) ?? fullOptions[0];
    const compactOption = residentSubject._residentInlineWorkOption(person, previousVisibleOption?.label, residentWorkContext);
    assert.deepEqual(
      [compactOption.value, compactOption.label],
      [previousVisibleOption?.value ?? "", previousVisibleOption?.label ?? ""],
      `lazy resident work select must preserve the previous visible value and label for ${person.id}`
    );
  }

  const compactResidentRows = residentSubject._preparePersonRows(residentHolding, true, "living", true, { workOptionsContext: residentWorkContext });
  const residentEditorOnlyKeys = ["homeOptions", "workOptions", "workAllocationModeOptions", "workAllocations", "cultureOptions", "beliefOptions", "backgroundOptions", "traitOptions"];
  for (const key of residentEditorOnlyKeys) {
    assert.equal(compactResidentRows.filter((row) => Object.hasOwn(row, key)).length, 0, `compact resident rows must not materialize editor-only ${key}`);
  }
  const readOnlyResidentRows = residentSubject._preparePersonRows(residentHolding, false, "living", true, { workOptionsContext: residentWorkContext });
  assert.ok(readOnlyResidentRows.every((row) => !Object.hasOwn(row, "workInlineValue")), "read-only resident rows must not prepare mutation-only inline select state");
  const editedResidentRows = residentSubject._preparePersonRows(residentHolding, true, "living", false, { workOptionsContext: residentWorkContext, editorPersonId: "resident-full" });
  for (const key of residentEditorOnlyKeys) {
    assert.equal(editedResidentRows.filter((row) => Object.hasOwn(row, key)).length, 1, `only the open resident editor may receive ${key}`);
  }
  assert.ok(editedResidentRows.find((row) => row.id === "resident-full")?.workOptions?.some((option) => option.value === "building-full" && option.selected), "the editor must retain a selected building even when it is full");

  const extremeResidentHolding = performanceFixtures.makeLargeSettlementFixture(performanceFixtures.PERFORMANCE_SCENARIOS[2]).holdings[0];
  const extremeWorkContext = residentSubject._residentWorkOptionsContext(extremeResidentHolding);
  const extremeResidentRows = residentSubject._preparePersonRows(extremeResidentHolding, true, "living", true, { workOptionsContext: extremeWorkContext });
  assert.equal(extremeResidentRows.length, 1000, "the optimized resident projection must retain every extreme-fixture resident");
  assert.equal(extremeResidentRows.reduce((count, row) => count + (row.workOptions?.length ?? 0), 0), 0, "the compact extreme projection must not recreate P x B work choices");
  assert.ok(residentSubject._residentWorkOptionCatalog(extremeWorkContext).length <= extremeResidentHolding.buildings.list.length + extremeWorkContext.crews.length + 2, "the shared extreme work catalog must grow with buildings rather than residents times buildings");

  const activeGmA = { id: "gm-b", name: "Second GM", active: true, isGM: true };
  const activeGmB = { id: "gm-a", name: "Authority GM", active: true, isGM: true };
  const inactiveGm = { id: "gm-c", name: "Inactive GM", active: false, isGM: true };
  const playerUser = { id: "player-a", name: "Player", active: true, isGM: false };
  assert.equal(
    authority.activeSkyholdGm({ contents: [activeGmA, inactiveGm, activeGmB, playerUser] }),
    activeGmB,
    "authority selection must be deterministic across clients"
  );

  const onlineAuthority = authority.getSkyholdAuthorityState({
    user: playerUser,
    users: { contents: [playerUser, activeGmB] },
    socket: { emit() {} }
  });
  const offlineAuthority = authority.getSkyholdAuthorityState({
    user: playerUser,
    users: { contents: [playerUser, inactiveGm] },
    socket: { emit() {} }
  });
  const socketlessAuthority = authority.getSkyholdAuthorityState({
    user: playerUser,
    users: { contents: [playerUser, activeGmB] },
    socket: null
  });
  const localGmAuthority = authority.getSkyholdAuthorityState({
    user: activeGmB,
    users: { contents: [activeGmB] },
    socket: null
  });
  assert.equal(onlineAuthority.status, "online", "player writes must be available while the socket and an authority GM are online");
  assert.equal(onlineAuthority.writeAvailable, true, "an online authority GM must enable delegated writes");
  assert.equal(offlineAuthority.status, "offline", "the authority state must expose a missing active GM");
  assert.equal(offlineAuthority.writeAvailable, false, "player writes must be disabled without an active GM");
  assert.equal(socketlessAuthority.status, "socket-unavailable", "the authority state must distinguish a missing socket");
  assert.equal(socketlessAuthority.writeAvailable, false, "player writes must be disabled without a Foundry socket");
  assert.equal(localGmAuthority.status, "local-gm", "a GM must remain the local authority without a socket");
  assert.equal(localGmAuthority.writeAvailable, true, "GM writes must not depend on delegated socket authority");

  const publicHoldingWithPlayerWrites = {
    visibility: "public",
    gm: {
      playersCanEditOverview: true,
      playersCanEditBuildings: true,
      playersCanUseStorage: false,
      playersCanEditResidents: false,
      playersCanEditDefense: true,
      playersCanEditBattle: true,
      playersCanEditSpecial: false
    }
  };
  const onlinePlayerPermissions = holdingPermissions.holdingPermissionContext(publicHoldingWithPlayerWrites, {
    user: playerUser,
    authority: onlineAuthority
  });
  const offlinePlayerPermissions = holdingPermissions.holdingPermissionContext(publicHoldingWithPlayerWrites, {
    user: playerUser,
    authority: offlineAuthority
  });
  const hiddenPlayerPermissions = holdingPermissions.holdingPermissionContext({
    ...publicHoldingWithPlayerWrites,
    visibility: "gm"
  }, {
    user: playerUser,
    authority: onlineAuthority
  });
  const gmPermissions = holdingPermissions.holdingPermissionContext(publicHoldingWithPlayerWrites, {
    user: activeGmB,
    authority: localGmAuthority
  });
  assert.equal(onlinePlayerPermissions.canView, true, "public holdings must remain readable by players");
  assert.equal(onlinePlayerPermissions.canEditBuildings, true, "granted player building writes must be enabled with online authority");
  assert.equal(onlinePlayerPermissions.authorityStatus.show, false, "a healthy online GM connection must not consume manager space with a status strip");
  assert.equal(onlinePlayerPermissions.canUseStorage, false, "an online GM must not override a denied holding permission");
  assert.equal(onlinePlayerPermissions.canEditBattleSetup, true, "battle setup must follow the holding player permission");
  assert.equal(onlinePlayerPermissions.canResolveBattle, false, "only a GM may resolve a mass-combat round");
  assert.equal(offlinePlayerPermissions.mayEditBuildings, true, "the permission context must preserve the granted policy while authority is offline");
  assert.equal(offlinePlayerPermissions.canEditBuildings, false, "effective player writes must be disabled while authority is offline");
  assert.equal(offlinePlayerPermissions.authorityStatus.severity, "offline", "the UI status must explain an authority outage");
  assert.equal(hiddenPlayerPermissions.canView, false, "GM-only holdings must remain unreadable by players");
  assert.equal(hiddenPlayerPermissions.mayEditOverview, false, "holding write flags must never override GM-only visibility");
  assert.equal(gmPermissions.canResolveBattle, true, "GM authority must be able to resolve a mass-combat round");
  assert.equal(gmPermissions.canEditSpecial, true, "GM authority must have all holding write capabilities");

  const permissionGuardMatrix = [
    ["playersCanEditOverview", "canEditOverview", "holdings.0.overview.description"],
    ["playersCanEditBuildings", "canEditBuildings", "holdings.0.buildings.list.0.name"],
    ["playersCanUseStorage", "canUseStorage", "holdings.0.storage.notes"],
    ["playersCanEditResidents", "canEditResidents", "holdings.0.people.notes"],
    ["playersCanEditDefense", "canEditDefense", "holdings.0.gm.defense.notes"],
    ["playersCanEditBattle", "canEditBattleSetup", "holdings.0.gm.massCombat.defenderMorale"],
    ["playersCanEditSpecial", "canEditSpecial", "holdings.0.special.notes"]
  ];
  for (const [settingKey, contextKey, pathValue] of permissionGuardMatrix) {
    const matrixHolding = {
      id: `matrix-${settingKey}`,
      visibility: "public",
      gm: Object.fromEntries(permissionGuardMatrix.map(([key]) => [key, key === settingKey]))
    };
    const matrixData = { holdings: [matrixHolding] };
    const matrixPermissions = holdingPermissions.holdingPermissionContext(matrixHolding, {
      user: playerUser,
      authority: onlineAuthority
    });
    assert.equal(matrixPermissions[contextKey], true, `${settingKey} must enable its matching UI capability`);
    assert.equal(guard.isPlayerWritablePath(pathValue, matrixData, matrixData), true, `${settingKey} must enable its matching server guard path`);

    const deniedHolding = { ...matrixHolding, gm: { ...matrixHolding.gm, [settingKey]: false } };
    const deniedData = { holdings: [deniedHolding] };
    const deniedPermissions = holdingPermissions.holdingPermissionContext(deniedHolding, {
      user: playerUser,
      authority: onlineAuthority
    });
    assert.equal(deniedPermissions[contextKey], false, `${settingKey} must disable its matching UI capability`);
    assert.equal(guard.isPlayerWritablePath(pathValue, deniedData, deniedData), false, `${settingKey} must disable its matching server guard path`);
  }

  assert.throws(
    () => domainComposer.composeDomainGroup("TestDomain", [
      ["FirstDomain", { duplicateMember() {} }],
      ["SecondDomain", { duplicateMember() {} }]
    ]),
    /Duplicate TestDomain domain member "duplicateMember" in FirstDomain and SecondDomain/,
    "domain composition must reject duplicate members with both owner names"
  );

  const existingTarget = {
    existingMember() {}
  };
  assert.throws(
    () => domainComposer.assignDomainGroup(existingTarget, "TargetTest", [
      ["NewDomain", {
        addedMember() {},
        existingMember() {}
      }]
    ]),
    /Duplicate TargetTest target member "existingMember" already exists before domain assignment/,
    "domain assignment must reject members already declared on the target"
  );
  assert.equal(Object.hasOwn(existingTarget, "addedMember"), false, "failed domain assignment must be atomic");

  const cleanTarget = {};
  const assignedTarget = domainComposer.assignDomainGroup(cleanTarget, "CleanTargetTest", [
    ["FirstDomain", { firstMember() {} }],
    ["SecondDomain", { secondMember() {} }]
  ]);
  assert.equal(assignedTarget, cleanTarget, "domain assignment must preserve the target object");
  assert.deepEqual(Object.keys(cleanTarget), ["firstMember", "secondMember"], "domain assignment must add every non-conflicting member");

  const financeParts = [
    financeTreasuryDomain.FinanceTreasuryDomain,
    financeTradeDomain.FinanceTradeDomain,
    financeStorageDomain.FinanceStorageDomain,
    financeAgricultureDomain.FinanceAgricultureDomain,
    financeControlsDomain.FinanceControlsDomain,
    financeLivestockDomain.FinanceLivestockDomain,
    financeInternalDemandDomain.FinanceInternalDemandDomain,
    financeMaintenanceDomain.FinanceMaintenanceDomain,
    financeStaffDomain.FinanceStaffDomain,
    financeEconomyDomain.FinanceEconomyDomain
  ];
  assert.equal(
    Object.keys(financeDomain.FinanceDomain).length,
    financeParts.reduce((total, domain) => total + Object.keys(domain).length, 0),
    "FinanceDomain must contain every member without silent overrides"
  );
  assert.equal(
    financeDomain.FinanceDomain._tradeStorageRoomOptions,
    financeTradeDomain.FinanceTradeDomain._tradeStorageRoomOptions,
    "FinanceTradeDomain must own trade storage room options"
  );
  assert.equal(
    financeDomain.FinanceDomain._tradeKindOptions,
    financeTradeDomain.FinanceTradeDomain._tradeKindOptions,
    "FinanceTradeDomain must own trade kind options"
  );
  assert.equal(
    Object.hasOwn(financeTreasuryDomain.FinanceTreasuryDomain, "_tradeStorageRoomOptions"),
    false,
    "FinanceTreasuryDomain must not duplicate trade storage room options"
  );
  assert.equal(
    Object.hasOwn(financeTreasuryDomain.FinanceTreasuryDomain, "_tradeKindOptions"),
    false,
    "FinanceTreasuryDomain must not duplicate trade kind options"
  );

  const buildingParts = [
    buildingMetaDomain.BuildingMetaDomain,
    buildingWorkerDomain.BuildingWorkerDomain,
    buildingProductionDomain.BuildingProductionDomain,
    buildingAgricultureDomain.BuildingAgricultureDomain,
    buildingLivestockDomain.BuildingLivestockDomain,
    buildingDevelopmentDomain.BuildingDevelopmentDomain,
    buildingRowsDomain.BuildingRowsDomain
  ];
  assert.equal(
    Object.keys(buildingDomain.BuildingDomain).length,
    buildingParts.reduce((total, domain) => total + Object.keys(domain).length, 0),
    "BuildingDomain must contain every member without silent overrides"
  );

  const duplicateActionRegistry = new actionRouter.SkyholdActionRegistry();
  duplicateActionRegistry.register({ click: { duplicate: "_onFirst" } }, "FirstActions");
  assert.throws(
    () => duplicateActionRegistry.register({ click: { duplicate: "_onSecond" } }, "SecondActions"),
    /Duplicate action "duplicate" registered by FirstActions \(_onFirst\) and SecondActions \(_onSecond\)/,
    "action registries must reject duplicate action names with both owners"
  );
  const duplicatePublicRegistry = new actionRouter.SkyholdActionRegistry();
  duplicatePublicRegistry.register({ click: { shared: "_onShared" }, publicClick: ["shared"] }, "FirstPublicActions");
  assert.throws(
    () => duplicatePublicRegistry.register({ publicClick: ["shared"] }, "SecondPublicActions"),
    /Duplicate public action "shared" registered by FirstPublicActions and SecondPublicActions/,
    "action registries must reject duplicate public action declarations"
  );
  assert.throws(
    () => actionRouter.buildSkyholdActionRegistry([["MissingHandlerActions", { click: {}, publicClick: ["missing-handler"] }]]),
    /Public action "missing-handler" has no registered click handler/,
    "public actions must reference registered click handlers"
  );

  const hadDocument = Object.hasOwn(globalThis, "document");
  const previousDocument = globalThis.document;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const previousWindow = globalThis.window;
  const tooltipNodes = [];
  globalThis.window = { innerWidth: 300, innerHeight: 200 };
  globalThis.document = {
    createElement() {
      const node = {
        className: "",
        textContent: "",
        style: {},
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        offsetWidth: 80,
        offsetHeight: 20,
        removed: false,
        remove() {
          this.removed = true;
        }
      };
      tooltipNodes.push(node);
      return node;
    },
    body: {
      appendChild(node) {
        node.appended = true;
      }
    }
  };
  try {
    const attributes = new Map([["title", "Native tooltip"]]);
    const listeners = new Map();
    let tooltipRect = { left: 100, top: 50, bottom: 70, width: 20 };
    const tooltipTarget = {
      dataset: { fblsTooltipDelay: "0" },
      hasAttribute: (name) => attributes.has(name),
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: (name) => attributes.delete(name),
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      contains: (element) => element === tooltipTarget,
      getBoundingClientRect: () => tooltipRect
    };
    const tooltipOwner = {};
    floatingTooltip.bindFloatingTooltips(tooltipOwner, { querySelectorAll: () => [tooltipTarget] }, { followPointer: true });
    assert.equal(attributes.has("title"), false, "floating tooltips must suppress the native title");
    assert.equal(tooltipTarget.dataset.fblsTooltip, "Native tooltip", "native title text must become floating tooltip text");
    assert.equal(tooltipTarget.dataset.fblsNativeTitle, "Native tooltip", "native title text must remain available for diagnostics");
    assert.equal(attributes.get("aria-label"), "Native tooltip", "floating tooltips must preserve an accessible label");
    assert.deepEqual([...listeners.keys()].sort(), ["focusin", "focusout", "keydown", "mouseenter", "mouseleave", "mousemove"], "follow-pointer tooltips must bind pointer movement, keyboard focus and dismissal listeners");

    listeners.get("mouseenter")({ currentTarget: tooltipTarget });
    assert.equal(tooltipOwner._activeTooltip, tooltipNodes[0], "mouseenter must create and retain the active tooltip");
    assert.match(tooltipNodes[0].className, /\bfbls-floating-tooltip\b/, "floating tooltip must use the shared CSS class");
    assert.match(tooltipNodes[0].className, /\bfbl-skyhold\b/, "body-level floating tooltips must carry the Skyhold theme tokens");
    assert.equal(tooltipNodes[0].textContent, "Native tooltip", "floating tooltip must display the configured text");
    assert.equal(tooltipNodes[0].style.left, "70px", "tooltip must be centered over its target");
    assert.equal(tooltipNodes[0].style.top, "20px", "tooltip must prefer placement above its target");

    tooltipRect = { left: 280, top: 5, bottom: 25, width: 20 };
    listeners.get("mousemove")({ currentTarget: tooltipTarget });
    assert.equal(tooltipNodes[0].style.left, "210px", "tooltip must stay inside the horizontal viewport");
    assert.equal(tooltipNodes[0].style.top, "35px", "tooltip must move below a target near the top edge");

    listeners.get("mouseleave")();
    assert.equal(tooltipNodes[0].removed, true, "mouseleave must remove the tooltip node");
    assert.equal(tooltipOwner._activeTooltip, null, "mouseleave must clear the active tooltip reference");

    listeners.get("focusin")();
    const focusedNode = tooltipOwner._activeTooltip;
    assert.equal(focusedNode.getAttribute("role"), "tooltip", "keyboard focus must create an accessible tooltip");
    listeners.get("focusout")({ relatedTarget: tooltipTarget });
    assert.equal(tooltipOwner._activeTooltip, focusedNode, "focus within the same control must retain its explanation");
    listeners.get("keydown")({ key: "Escape" });
    assert.equal(focusedNode.removed, true, "Escape must remove a keyboard tooltip");
    assert.equal(tooltipOwner._activeTooltip, null, "Escape must clear the active tooltip reference");
    listeners.get("focusin")();
    listeners.get("focusout")({ relatedTarget: null });
    assert.equal(tooltipOwner._activeTooltip, null, "leaving keyboard focus must dismiss the tooltip");

    const fixedListeners = new Map();
    const fixedTarget = {
      dataset: { fblsTooltip: "Fixed tooltip", fblsTooltipDelay: "0" },
      hasAttribute: () => false,
      addEventListener(type, handler) {
        fixedListeners.set(type, handler);
      },
      getBoundingClientRect: () => ({ left: 20, top: 80, bottom: 100, width: 20 })
    };
    floatingTooltip.bindFloatingTooltips(tooltipOwner, { querySelectorAll: () => [fixedTarget] });
    assert.deepEqual([...fixedListeners.keys()].sort(), ["focusin", "focusout", "keydown", "mouseenter", "mouseleave"], "fixed tooltips must preserve keyboard access without binding mousemove");
    fixedListeners.get("mouseenter")({ currentTarget: fixedTarget });
    const fixedNode = tooltipOwner._activeTooltip;
    floatingTooltip.bindFloatingTooltips(tooltipOwner, { querySelectorAll: () => [] });
    assert.equal(fixedNode.removed, true, "rebinding after render must remove an existing tooltip");
    assert.equal(tooltipOwner._activeTooltip, null, "rebinding after render must clear the tooltip reference");
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
    if (hadWindow) globalThis.window = previousWindow;
    else delete globalThis.window;
  }

  const hadUi = Object.hasOwn(globalThis, "ui");
  const previousUi = globalThis.ui;
  const previousConsoleError = globalThis.console.error;
  const delegatedNotifications = [];
  const delegatedLogs = [];
  globalThis.ui = {
    ...(previousUi ?? {}),
    notifications: {
      ...(previousUi?.notifications ?? {}),
      error: (message) => delegatedNotifications.push(message)
    }
  };
  globalThis.console.error = (...args) => delegatedLogs.push(args);
  try {
    const delegatedListeners = new Map();
    const delegatedListenerOptions = new Map();
    let delegatedKeyboardClicks = 0;
    const delegatedElement = { dataset: { action: "nested-action" }, click: () => { delegatedKeyboardClicks += 1; } };
    const nestedClickTarget = { closest: (selector) => selector === "[data-action]" ? delegatedElement : null };
    const nestedKeyboardTarget = {
      closest: (selector) => selector === "[data-action][role='button']" ? delegatedElement : null
    };
    const delegatedOwner = {
      receivedElement: null,
      nestedHandler(delegated) {
        this.receivedElement = delegated.currentTarget;
      }
    };
    const delegatedRoot = {
      addEventListener(type, listener, options) {
        delegatedListeners.set(type, listener);
        delegatedListenerOptions.set(type, options);
      },
      contains(element) {
        return element === delegatedElement;
      }
    };
    const firstDelegatedController = delegatedEvents.bindDelegatedActions(delegatedOwner, delegatedRoot, {
      "nested-action": "nestedHandler"
    });
    assert.deepEqual([...delegatedListeners.keys()].sort(), ["click", "keydown"], "delegated action binder must install click and keyboard listeners");
    assert.equal(delegatedListenerOptions.get("click").signal, firstDelegatedController.signal, "delegated click listener must be tied to its abort controller");
    assert.equal(delegatedListenerOptions.get("keydown").signal, firstDelegatedController.signal, "delegated keyboard listener must be tied to its abort controller");
    delegatedListeners.get("click")({ type: "click", target: nestedClickTarget });
    assert.equal(delegatedOwner.receivedElement, delegatedElement, "delegated action binder must resolve nested click targets to the action element");
    let delegatedKeyboardPrevented = false;
    delegatedListeners.get("keydown")({ key: "Enter", target: nestedKeyboardTarget, preventDefault: () => { delegatedKeyboardPrevented = true; } });
    assert.equal(delegatedKeyboardPrevented, true, "delegated role buttons must prevent the native Enter default");
    assert.equal(delegatedKeyboardClicks, 1, "delegated role buttons must activate through Enter");

    const secondDelegatedController = delegatedEvents.bindDelegatedActions(delegatedOwner, delegatedRoot, {
      "nested-action": "nestedHandler"
    });
    assert.equal(firstDelegatedController.signal.aborted, true, "rebinding delegated actions must abort the previous listener");
    delegatedEvents.unbindDelegatedActions(delegatedOwner);
    assert.equal(secondDelegatedController.signal.aborted, true, "explicit delegated action cleanup must abort the active listener");
    assert.equal(delegatedOwner._delegatedActionAbortController, null, "delegated action cleanup must clear the controller reference");

    const element = { dataset: { action: "test-delegated-action" } };
    const event = { type: "click" };
    let receivedCurrentTarget = null;
    const syncResult = delegatedEvents.dispatchDelegatedAction({
      syncHandler(delegated) {
        receivedCurrentTarget = delegated.currentTarget;
      }
    }, event, element, "syncHandler");
    assert.equal(syncResult, true, "a synchronous delegated handler with no return value must report success");
    assert.equal(receivedCurrentTarget, element, "delegated events must expose the matched element as currentTarget");

    const syncFailure = new Error("synchronous delegated failure");
    const syncFailureResult = delegatedEvents.dispatchDelegatedAction({
      syncFailureHandler() {
        throw syncFailure;
      }
    }, event, element, "syncFailureHandler");
    assert.equal(syncFailureResult, false, "synchronous delegated failures must be contained");
    assert.equal(delegatedNotifications.length, 1, "synchronous delegated failures must notify the user once");
    assert.equal(delegatedLogs.length, 1, "synchronous delegated failures must be logged once");
    assert.match(String(delegatedLogs[0][0]), /test-delegated-action/, "delegated failure logs must identify the action");

    delegatedNotifications.length = 0;
    delegatedLogs.length = 0;
    const asyncFailureResult = await delegatedEvents.dispatchDelegatedAction({
      async asyncFailureHandler() {
        throw new Error("asynchronous delegated failure");
      }
    }, event, element, "asyncFailureHandler");
    assert.equal(asyncFailureResult, false, "asynchronous delegated failures must resolve as contained failures");
    assert.equal(delegatedNotifications.length, 1, "asynchronous delegated failures must notify the user once");
    assert.equal(delegatedLogs.length, 1, "asynchronous delegated failures must be logged once");

    delegatedNotifications.length = 0;
    delegatedLogs.length = 0;
    const locallyHandledResult = await delegatedEvents.dispatchDelegatedAction({
      async locallyHandledHandler() {
        try {
          throw new Error("expected local failure");
        } catch (_error) {
          globalThis.ui.notifications.error("Специализированное сообщение.");
        }
      }
    }, event, element, "locallyHandledHandler");
    assert.equal(locallyHandledResult, undefined, "locally handled async actions must preserve their resolved value");
    assert.deepEqual(delegatedNotifications, ["Специализированное сообщение."], "locally handled failures must not receive a generic duplicate notification");
    assert.equal(delegatedLogs.length, 0, "locally handled failures must not be reported as uncaught");

    delegatedNotifications.length = 0;
    delegatedLogs.length = 0;
    const notifiedFailureResult = await delegatedEvents.dispatchDelegatedAction({
      async notifiedFailureHandler() {
        const error = delegatedEvents.markDelegatedActionErrorNotified(new Error("already notified failure"));
        globalThis.ui.notifications.error("Сообщение уже показано.");
        throw error;
      }
    }, event, element, "notifiedFailureHandler");
    assert.equal(notifiedFailureResult, false, "re-thrown delegated failures must remain contained");
    assert.deepEqual(delegatedNotifications, ["Сообщение уже показано."], "marked failures must not receive a second notification");
    assert.equal(delegatedLogs.length, 1, "marked failures must still be logged for diagnostics");
  } finally {
    globalThis.console.error = previousConsoleError;
    if (hadUi) globalThis.ui = previousUi;
    else delete globalThis.ui;
  }

  assert.equal(massCombatCalculator.lossTrack, massCombatTracks.lossTrack, "calculator must preserve its legacy track exports");
  assert.equal(massCombatCalculator.damageContext, massCombatTracks.damageContext, "calculator must preserve its legacy damage context export");
  assert.equal(massCombatCalculator.weatherRulesCatalog, massCombatWeather.weatherRulesCatalog, "calculator must preserve its legacy weather catalog export");
  assert.equal(massCombatCalculator.isAdultResident, massCombatResidents.isAdultResident, "calculator must preserve its legacy resident exports");
  assert.equal(massCombatCalculator.soldierEfficiency, massCombatResidents.soldierEfficiency, "calculator must preserve its legacy soldier efficiency export");
  assert.equal(massCombatCalculator.builtBuildings, massCombatSources.builtBuildings, "calculator must preserve its legacy building source export");
  assert.equal(massCombatCalculator.defenseSquadProfile, massCombatSources.defenseSquadProfile, "calculator must preserve its legacy squad profile export");
  assert.equal(massCombatCalculator.fortificationProfile, massCombatSources.fortificationProfile, "calculator must preserve its legacy fortification profile export");
  assert.equal(massCombatCalculator.commanderEffectiveness, massCombatModifiers.commanderEffectiveness, "calculator must preserve its legacy commander export");
  assert.equal(massCombatCalculator.defenseCommanderBonus, massCombatModifiers.defenseCommanderBonus, "calculator must preserve its legacy commander bonus export");

  assert.equal(schema.BASE_HOLDING, baseSchema.BASE_HOLDING, "schema facade must preserve the base holding export");
  assert.equal(schema.HOLDING_TYPES, baseSchema.HOLDING_TYPES, "schema facade must preserve holding type exports");
  assert.equal(schema.DEFAULT_SKYHOLD_DATA, defaultData.DEFAULT_SKYHOLD_DATA, "schema facade must preserve the default root export");
  assert.equal(schema.CANONICAL_WORKER_TYPES, workerTypes.CANONICAL_WORKER_TYPES, "schema facade must preserve canonical worker types");
  assert.equal(schema.LEGACY_WORKER_TYPE_MAP, workerTypes.LEGACY_WORKER_TYPE_MAP, "schema facade must preserve legacy worker aliases");
  assert.equal(schema.BROAD_WORKER_TYPE_MAP, workerTypes.BROAD_WORKER_TYPE_MAP, "schema facade must preserve broad worker aliases");
  assert.equal(laputaCompatibility.LAPUTA_IMPORT, laputaPreset.LAPUTA_IMPORT, "Laputa compatibility export must preserve the canonical preset");
  assert.equal(dataBarrel.skipTransaction, store.skipTransaction, "public data barrel must expose the named transaction skip helper");
  assert.equal(dataBarrel.getSkyholdAuthorityState, authority.getSkyholdAuthorityState, "public data barrel must expose the authority state helper");
  assert.equal(dataBarrel.commandSuccess, commandResults.commandSuccess, "public data barrel must expose the command result contract");
  assert.equal(dataBarrel.holdingPermissionContext, holdingPermissions.holdingPermissionContext, "public data barrel must expose the permission context helper");
  const successfulCommand = commandResults.commandSuccess({ operationId: "command-1", revision: 7 });
  const failedCommand = commandResults.commandFailure({
    operationId: "command-2",
    code: commandResults.COMMAND_ERROR.CONFLICT,
    message: "conflict",
    retryable: true,
    revision: 8
  });
  assert.deepEqual(successfulCommand, {
    ok: true,
    operationId: "command-1",
    code: "ok",
    message: "",
    retryable: false,
    revision: 7
  }, "successful commands must use the stable result contract");
  assert.equal(failedCommand.ok, false, "failed commands must use the stable result contract");
  assert.equal(failedCommand.code, "conflict", "failed commands must expose a machine-readable code");
  assert.equal(commandResults.commandError(failedCommand).retryable, true, "command errors must preserve retry guidance");
  const previousFoundryForId = globalThis.foundry;
  const previousRandomForId = Math.random;
  try {
    delete globalThis.foundry;
    Math.random = () => 0.5;
    assert.equal(dataBarrel.makeId("probe", 10), "probe-iiiiiiiiii", "makeId fallback must always produce the requested length");
    assert.equal(dataBarrel.makeId("probe", 3.9), "probe-iii", "makeId must normalize fractional lengths to an integer");
  } finally {
    if (previousFoundryForId === undefined) delete globalThis.foundry;
    else globalThis.foundry = previousFoundryForId;
    Math.random = previousRandomForId;
  }

  const canonicalDefault = defaultData.DEFAULT_SKYHOLD_DATA;
  assertJsonEqual(JSON.parse(JSON.stringify(canonicalDefault)), canonicalDefault, "default data must remain fully JSON-serializable");
  assert.deepEqual(canonicalDefault.holdings.map((holding) => holding.id), ["laputa", "restoration-settlement", "magnific"], "default holdings must preserve campaign order");
  assertJsonEqual(canonicalDefault.holdings[0], laputaPreset.LAPUTA_IMPORT.holding, "default root must preserve the Laputa preset");
  assertJsonEqual(canonicalDefault.holdings[1], restorationPreset.RESTORATION_SETTLEMENT_PRESET, "default root must preserve the restoration settlement preset");
  assertJsonEqual(canonicalDefault.holdings[2], magnificPreset.MAGNIFIC_PRESET, "default root must preserve the Magnific preset");
  assert.notEqual(canonicalDefault.holdings[0], laputaPreset.LAPUTA_IMPORT.holding, "default root must clone the Laputa preset");
  assert.notEqual(canonicalDefault.holdings[1], restorationPreset.RESTORATION_SETTLEMENT_PRESET, "default root must clone the restoration preset");
  assert.notEqual(canonicalDefault.holdings[2], magnificPreset.MAGNIFIC_PRESET, "default root must clone the Magnific preset");

  const hadGame = Object.hasOwn(globalThis, "game");
  const previousGame = globalThis.game;
  const registeredSettings = new Map();
  globalThis.game = {
    settings: {
      register(moduleId, key, config) {
        assert.equal(moduleId, dataConstants.MODULE_ID, `setting ${key} must use the module id`);
        registeredSettings.set(key, config);
      }
    }
  };
  try {
    settings.registerSettings();
  } finally {
    if (hadGame) globalThis.game = previousGame;
    else delete globalThis.game;
  }
  assertJsonEqual(registeredSettings.get(dataConstants.SETTING_DATA)?.default, canonicalDefault, "legacy combined setting must register the canonical default root");
  assertJsonEqual(registeredSettings.get(dataConstants.SETTING_META)?.default, canonicalDefault.meta, "meta setting must register canonical defaults");
  assertJsonEqual(registeredSettings.get(dataConstants.SETTING_HOLDINGS)?.default, canonicalDefault.holdings, "holdings setting must register canonical defaults");
  assertJsonEqual(registeredSettings.get(dataConstants.SETTING_CATALOG)?.default, canonicalDefault.catalog, "catalog setting must register canonical defaults");
  assert.equal(registeredSettings.get(dataConstants.SETTING_ROUTE_GRAPH_VIEW)?.scope, "client", "route graph viewport must remain client-local");
  assert.notEqual(registeredSettings.get(dataConstants.SETTING_DATA)?.default, canonicalDefault, "registered combined defaults must be cloned");
  assert.notEqual(registeredSettings.get(dataConstants.SETTING_HOLDINGS)?.default, canonicalDefault.holdings, "registered holdings defaults must be cloned");

  assert.equal(resources.BUILTIN_RESOURCE_DEFS, builtinResources.BUILTIN_RESOURCE_DEFS, "resource facade must preserve the built-in catalog export");
  assert.equal(resources.RESOURCE_DEFS, builtinResources.RESOURCE_DEFS, "resource facade must preserve the legacy RESOURCE_DEFS export");
  assert.equal(resources.RESOURCE_DEFS, resources.BUILTIN_RESOURCE_DEFS, "legacy resource definitions must remain the built-in catalog");
  assert.equal(resourceBaseDefinitions.RESOURCE_BASE_DEFINITIONS.length, resourceBaseDefinitions.ECONOMY_RESOURCE_CATALOG_SIZE, "base resource catalog must match the approved economy catalog size");
  assert.deepEqual(
    builtinResources.BUILTIN_RESOURCE_DEFS.map((resource) => resource.id),
    resourceBaseDefinitions.RESOURCE_BASE_DEFINITIONS.map((resource) => resource.id),
    "assembled built-in resources must preserve base definition order"
  );
  assert.equal(new Set(builtinResources.BUILTIN_RESOURCE_DEFS.map((resource) => resource.id)).size, builtinResources.BUILTIN_RESOURCE_DEFS.length, "built-in resource IDs must remain unique");
  assert.ok(
    Object.keys(worldResourceBindings.WORLD_RESOURCE_BINDINGS).every((id) => builtinResources.BUILTIN_RESOURCE_DEFS.some((resource) => resource.id === id)),
    "every world resource binding must target a built-in resource"
  );
  for (const definition of resourceBaseDefinitions.RESOURCE_BASE_DEFINITIONS) {
    for (const key of ["img", "itemUuid", "itemId", "itemType", "cost"]) {
      assert.equal(Object.hasOwn(definition, key), false, `base resource ${definition.id} must not own world binding field ${key}`);
    }
  }
  const baseResourcesById = new Map(resourceBaseDefinitions.RESOURCE_BASE_DEFINITIONS.map((resource) => [resource.id, resource]));
  for (const rawFoodId of ["grain", "flour", "vegetables", "fruits", "meat", "fish", "eggs", "milk", "honey", "herbs", "animal-feed", "water", "salt", "sugar", "spices", "hops", "grapes", "cooking-oil"]) {
    assert.equal(baseResourcesById.get(rawFoodId)?.foodEdible, false, `${rawFoodId} must remain a non-edible production input`);
  }
  for (const [preparedFoodId, foodType] of [["bread", "grain"], ["food-grain", "grain"], ["food-protein", "protein"], ["food-dairy", "dairy"], ["food-fruit", "fruit"], ["preserved-meat", "protein"], ["aged-cheese", "dairy"], ["dried-fruit", "fruit"]]) {
    assert.equal(baseResourcesById.get(preparedFoodId)?.foodEdible, true, `${preparedFoodId} must be explicitly edible`);
    assert.equal(baseResourcesById.get(preparedFoodId)?.foodType, foodType, `${preparedFoodId} must preserve its prepared food type`);
    assert.equal(baseResourcesById.get(preparedFoodId)?.categoryTag, "food.prepared", `${preparedFoodId} must use the prepared-food category`);
  }
  const builtInWood = builtinResources.BUILTIN_RESOURCE_DEFS.find((resource) => resource.id === "wood");
  assert.equal(builtInWood.itemUuid, "Compendium.world.resursy.Item.zSA7X1QooILVS69A", "assembled resources must preserve world compendium UUIDs");
  assert.equal(builtInWood.img, "3_F00L/Icons/Items/Regular/Wood.png", "assembled resources must preserve world images");
  assert.equal(resources.normalizeResourceId("Древесина"), "wood", "assembled resources must preserve aliases");

  const explicitCatalogRows = [
    { id: "world-visible", label: "World Visible", aliases: ["visible alias"] },
    { id: "world-hidden", label: "World Hidden", hidden: true }
  ];
  assert.deepEqual(
    resources.getResourceCatalogRows({ rows: explicitCatalogRows }).map((resource) => resource.id),
    ["world-visible"],
    "explicit catalog lookup must omit hidden resources by default"
  );
  assert.deepEqual(
    resources.getResourceCatalogRows({ rows: explicitCatalogRows, includeHidden: true }).map((resource) => resource.id),
    ["world-visible", "world-hidden"],
    "explicit catalog lookup must support hidden resources without Foundry globals"
  );
  assert.equal(
    resources.allResourceDefs({ catalogRows: explicitCatalogRows }).some((resource) => resource.id === "world-visible"),
    true,
    "allResourceDefs must accept explicit world catalog rows"
  );

  let liveCatalogRows = [{ id: "live-one", label: "Live One" }];
  const liveSettings = {
    get(_moduleId, key) {
      if (key === dataConstants.SETTING_CATALOG) return { resources: liveCatalogRows };
      return null;
    }
  };
  assert.deepEqual(resourceCatalogSettings.readWorldResourceCatalogRows(liveSettings), liveCatalogRows, "settings adapter must read split catalog resources");
  liveCatalogRows = [{ id: "live-two", label: "Live Two" }];
  assert.deepEqual(resourceCatalogSettings.readWorldResourceCatalogRows(liveSettings), liveCatalogRows, "settings adapter must not cache stale catalog rows");
  const legacyRows = [{ id: "legacy-world", label: "Legacy World" }];
  assert.deepEqual(
    resourceCatalogSettings.readWorldResourceCatalogRows({
      get(_moduleId, key) {
        if (key === dataConstants.SETTING_CATALOG) return {};
        if (key === dataConstants.SETTING_DATA) return { catalog: { resources: legacyRows } };
        return null;
      }
    }),
    legacyRows,
    "settings adapter must preserve the legacy combined catalog fallback"
  );

  const resourceHadGame = Object.hasOwn(globalThis, "game");
  const resourcePreviousGame = globalThis.game;
  globalThis.game = { settings: liveSettings };
  try {
    liveCatalogRows = [{ id: "live-one", label: "Live One", aliases: ["live alias one"] }];
    assert.equal(resources.normalizeResourceId("live alias one"), "live-one", "lookup facade must read the current world catalog");
    liveCatalogRows = [{ id: "live-two", label: "Live Two", aliases: ["live alias two"] }];
    assert.equal(resources.normalizeResourceId("live alias two"), "live-two", "lookup facade must re-read world settings after catalog changes");
    assert.equal(resources.normalizeResourceId("live alias one"), "custom", "lookup facade must not retain removed world aliases in a cache");
  } finally {
    if (resourceHadGame) globalThis.game = resourcePreviousGame;
    else delete globalThis.game;
  }

  let resourceRevision = 1;
  let versionedRows = [{ id: "cached-one", label: "Cached One", aliases: ["cached alias one"] }];
  let versionedCatalogReads = 0;
  let versionedLegacyReads = 0;
  const versionedSettings = {
    get(_moduleId, key) {
      if (key === dataConstants.SETTING_META) return { revision: resourceRevision, storageCommit: { catalogHash: `catalog-${resourceRevision}`, writeId: `write-${resourceRevision}`, writeComplete: true } };
      if (key === dataConstants.SETTING_CATALOG) {
        versionedCatalogReads += 1;
        return { resources: versionedRows };
      }
      if (key === dataConstants.SETTING_DATA) {
        versionedLegacyReads += 1;
        return { catalog: { resources: [] } };
      }
      return null;
    }
  };
  globalThis.game = { settings: versionedSettings };
  try {
    assert.equal(resources.normalizeResourceId("cached alias one"), "cached-one", "versioned resource lookup must read the live catalog");
    for (let index = 0; index < 20; index += 1) resources.resourceLabel("cached-one");
    assert.equal(versionedCatalogReads, 1, "resource lookup must build the world index only once per committed catalog revision");
    assert.equal(versionedLegacyReads, 0, "split resource lookup must not read the large legacy world snapshot");
    resourceRevision = 2;
    versionedRows = [{ id: "cached-two", label: "Cached Two", aliases: ["cached alias two"] }];
    assert.equal(resources.normalizeResourceId("cached alias two"), "cached-two", "a committed catalog revision must invalidate the resource index");
    assert.equal(versionedCatalogReads, 2, "resource index invalidation must read the new catalog exactly once");
  } finally {
    if (resourceHadGame) globalThis.game = resourcePreviousGame;
    else delete globalThis.game;
  }

  const normalizedOnce = normalizers.migrateData(clone(canonicalDefault));
  const normalizedTwice = normalizers.migrateData(normalizedOnce);
  assertJsonEqual(normalizedTwice, normalizedOnce, "normalizers must be idempotent");
  assert.equal(canonicalDefault.meta.schemaVersion, schemaVersion.SKYHOLD_SCHEMA_VERSION, "default schema version must use the canonical schema version");
  assert.equal(normalizers.SKYHOLD_SCHEMA_VERSION, schemaVersion.SKYHOLD_SCHEMA_VERSION, "normalizers must preserve the canonical schema version export");
  assert.equal(normalizedOnce.meta.schemaVersion, schemaVersion.SKYHOLD_SCHEMA_VERSION, "schema version must be current");
  assert.equal(tendayPreview.normalizeTendayQd(1), 40, "settlement simulation must use a tenday as its minimum unit");
  assert.equal(tendayPreview.normalizeTendayQd(79), 40, "partial tendays must not create fractional simulation periods");
  assert.equal(tendayPreview.normalizeTendayQd(80), 80, "multiple complete tendays must remain available");
  const tendayCurrent = { id: "tenday", storage: { money: 10 }, marker: "source" };
  const tendaySourceHash = storageCommit.stableDataHash(tendayCurrent);
  const tendayPrepared = { id: "tenday", storage: { money: 15 }, marker: "prepared" };
  const tendayApplied = tendayPreview.applyPreparedTenday(tendayCurrent, tendayPrepared, tendaySourceHash, { hash: storageCommit.stableDataHash, clone });
  assert.equal(tendayApplied.ok, true, "an unchanged holding must accept its prepared tenday snapshot");
  assert.deepEqual(tendayCurrent, tendayPrepared, "tenday apply must commit the exact previewed snapshot");
  const staleTenday = { id: "tenday", storage: { money: 11 }, marker: "changed" };
  const staleTendayBefore = clone(staleTenday);
  const staleTendayResult = tendayPreview.applyPreparedTenday(staleTenday, tendayPrepared, tendaySourceHash, { hash: storageCommit.stableDataHash, clone });
  assert.equal(staleTendayResult.stale, true, "a changed holding must reject a prepared tenday snapshot");
  assert.deepEqual(staleTenday, staleTendayBefore, "stale tenday rejection must not mutate current data");
  const readiness = await financeEconomyDomain.FinanceEconomyDomain._tendayReadinessContext.call({
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _isFoodResource: (row) => row?.resourceId === "food"
  }, {
    people: { list: [{ id: "resident-1" }, { id: "resident-2", injuredDays: 3 }] },
    storage: { resources: [{ resourceId: "food", qty: 5 }] },
    buildings: { list: [
      { id: "farm", name: "Farm", lifecycle: "active", condition: "intact", workersMin: 2, assignedWorkerIds: ["resident-1"] },
      { id: "repair", name: "Repair", lifecycle: "active", condition: "damaged", repair: { active: true }, constructionCrewId: "" }
    ] }
  }, { foodProjection: { available: 5 } });
  assert.equal(readiness.ready, false, "food shortage or a project without a crew must block tenday readiness");
  assert.equal(readiness.foodNeeded, 20, "tenday readiness must reserve ten daily food units per living resident");
  assert.equal(readiness.alerts.some((alert) => alert.key === "food"), true, "tenday readiness must expose food shortages");
  assert.equal(readiness.alerts.some((alert) => alert.key === "projects"), true, "tenday readiness must expose projects without crews");
  assert.equal(readiness.alerts.some((alert) => alert.key === "workers"), true, "tenday readiness must expose understaffed operational buildings");
  const globalStorageRows = storageSearch.buildStorageSearchRows({
    resources: [
      { id: "resource-iron", resourceId: "iron", name: "Iron", qty: 4, roomId: "forge" },
      { id: "resource-wood", resourceId: "wood", name: "Wood", qty: 0, roomId: "yard" }
    ],
    items: [{ id: "item-key", name: "Ancient Key", type: "gear", qty: 1, roomId: "vault" }],
    dependencies: {
      safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
      itemQuantity: (item) => Number(item?.qty ?? 0),
      normalizeRoomId: (roomId) => String(roomId || "outdoors"),
      roomLabel: (roomId) => ({ forge: "Forge", yard: "Yard", vault: "Vault" })[roomId] ?? "Outside",
      resourceLabel: (row) => row.name
    }
  });
  assert.equal(globalStorageRows.length, 2, "global storage search must omit zero-quantity records");
  assert.equal(globalStorageRows.some((row) => row.subtab === "resources" && row.roomId === "forge"), true, "global storage search must retain resource location");
  assert.equal(globalStorageRows.some((row) => row.subtab === "items" && row.search.includes("ancient key")), true, "global storage search must index stored item names");
  assert.deepEqual(globalStorageRows.map((row) => row.id).sort(), ["item-key", "resource-iron"], "global storage search must retain exact row ids for post-navigation highlighting");
  const boundedStorageRows = storageSearch.filterStorageSearchRows(
    Array.from({ length: 80 }, (_value, index) => ({ id: `row-${index}`, search: `common row ${index}` })),
    "common"
  );
  assert.equal(boundedStorageRows.total, 80, "bounded storage search must report the full match count");
  assert.equal(boundedStorageRows.rows.length, storageSearch.STORAGE_SEARCH_RESULT_LIMIT, "bounded storage search must cap materialized result rows");
  assert.equal(boundedStorageRows.truncated, true, "bounded storage search must disclose truncated presentation");
  const resourceEditorContext = holdingDomainModule.HoldingDomain._resourceCatalogContext({
    catalog: { resources: [
      { id: "iron", label: "World Iron", img: "world/iron.webp", aliases: ["metal"] },
      { id: "moon-dust", label: "Moon Dust", img: "world/moon.webp" }
    ] }
  }, true);
  const storageData = { holdings: [{ storage: { resources: [{ resourceId: "wood", name: "Wood" }] } }] };
  const newStorageRow = holdingDomainModule.HoldingDomain._emptyRowFor("holdings.0.storage.resources", storageData);
  assert.notEqual(newStorageRow.resourceId, "wood", "a new storage row must not duplicate an existing Wood row");
  assert.notEqual(newStorageRow.resourceId, "custom", "a new storage row must select an unused catalog resource before falling back to a custom row");
  assert.ok(newStorageRow.name && newStorageRow.name !== "Новый материал");
  const ironEditorRow = resourceEditorContext.rows.find((row) => row.id === "iron");
  const builtinEditorRow = resourceEditorContext.rows.find((row) => row.id === "bread");
  const customEditorRow = resourceEditorContext.rows.find((row) => row.id === "moon-dust");
  assert.equal(resourceEditorContext.rows.length, builtinResources.BUILTIN_RESOURCE_DEFS.length + 1, "resource editor must show every builtin plus custom world resources");
  assert.equal(ironEditorRow.isBuiltin && ironEditorRow.isOverride, true, "resource editor must identify overridden builtin resources");
  assert.equal(ironEditorRow.img, "world/iron.webp", "resource editor must expose the effective world image override");
  assert.equal(ironEditorRow.basePath, "catalog.resources.0", "resource editor must expose a writable override path");
  assert.equal(builtinEditorRow.isOverride, false, "untouched builtin resources must remain read-only until customized");
  assert.equal(customEditorRow.isBuiltin, false, "custom world resources must remain editable custom rows");
  const resourceCatalogEditorSource = readFileSync(path.join(root, "scripts/apps/editors/resource-catalog-editor.js"), "utf8");
  const resourceCatalogTemplateSource = readFileSync(path.join(root, "templates/resource-catalog-editor.hbs"), "utf8");
  const resourceRowTemplateSource = readFileSync(path.join(root, "templates/resource-row-editor.hbs"), "utf8");
  assert.match(resourceCatalogTemplateSource, /fbls-resource-editor-list/, "resource catalog must use a compact vertical list");
  assert.match(resourceCatalogTemplateSource, /data-action="resource-edit"/, "every resource catalog row must open its dedicated editor window");
  assert.match(resourceCatalogTemplateSource, /data-action="resource-select"/, "resource catalog must expose its reusable picker action");
  assert.match(resourceCatalogEditorSource, /static pick\(/, "resource catalog must expose a reusable picker entrypoint");
  assert.doesNotMatch(resourceCatalogTemplateSource, /data-resource-path=/, "the catalog list must not render the full resource form inline");
  assert.match(resourceRowTemplateSource, /data-resource-field="img"/, "the dedicated resource editor must own image editing");
  assert.match(resourceRowTemplateSource, /data-resource-field="shelfLifeQd"/, "the dedicated resource editor must expose canonical shelf life in QD");
  assert.match(resourceCatalogEditorSource, /class SkyholdResourceRowEditor/, "resources must have a dedicated ApplicationV2 editor");
  assert.doesNotMatch(resourceCatalogEditorSource, /resource-row-editor:field:[\s\S]{0,500}this\.requestRender\(/, "saving a resource field must not rerender and move its active editor window");
  assert.match(resourceCatalogTemplateSource, /data-fbls-image-fallback/, "resource catalog images must expose a Font Awesome fallback");
  const productionTemplateSource = readFileSync(path.join(root, "templates/parts/building-editor/production.hbs"), "utf8");
  const buildingMainTemplateSource = readFileSync(path.join(root, "templates/parts/building-editor/main.hbs"), "utf8");
  const agricultureTemplateSource = readFileSync(path.join(root, "templates/parts/building-editor/agriculture.hbs"), "utf8");
  assert.doesNotMatch(buildingMainTemplateSource, /\.location|>Место</, "the retired building location field must not return to the editor");
  assert.match(buildingMainTemplateSource, />Пр\. об\.<\//, "maintenance priority must keep its compact label");
  assert.match(productionTemplateSource, /fbls-choice-toggle/, "production choices must use the shared active/inactive contract");
  assert.match(agricultureTemplateSource, /aria-pressed=/, "agriculture seasons must expose their active state semantically");
  assert.match(agricultureTemplateSource, /включён[\s\S]{0,80}выключен/, "agriculture seasons must name both active and inactive states");
  const constructionTemplateSource = readFileSync(path.join(root, "templates/parts/building-editor/construction.hbs"), "utf8");
  const marketCatalogTemplateSource = readFileSync(path.join(root, "templates/market-catalog-editor.hbs"), "utf8");
  const eventRowTemplateSource = readFileSync(path.join(root, "templates/random-event-row-editor.hbs"), "utf8");
  for (const [label, source] of [["production", productionTemplateSource], ["construction", constructionTemplateSource], ["market", marketCatalogTemplateSource], ["event", eventRowTemplateSource]]) {
    assert.match(source, /pick-(?:production-resource|building-material)|market-(?:offer|economy)-pick-resource|event-editor-pick-resource/, `${label} resource choice must open the shared catalog`);
  }
  const regionEditorSource = readFileSync(path.join(root, "scripts/apps/editors/region-catalog-editor.js"), "utf8");
  const regionTemplateSource = readFileSync(path.join(root, "templates/region-catalog-editor.hbs"), "utf8");
  const regionCssSource = readFileSync(path.join(root, "styles/parts/market/region-catalog.css"), "utf8");
  assert.match(regionTemplateSource, /fbls-region-card-list/, "region editor must use the compact master-detail card layout");
  assert.match(regionTemplateSource, /fbls-region-card[^\n]+is-disabled/, "trade-disabled regions must use a visual state that remains clickable");
  assert.doesNotMatch(regionTemplateSource, /fbls-region-card[^"\n]*\sdisabled(?:\s|")/, "trade-disabled region cards must not inherit Foundry's generic disabled interaction state");
  assert.match(regionTemplateSource, /(?:Как читать коэффициенты|Порядок расчёта)/, "trade factor editor must explain multiplier semantics with an example");
  assert.match(regionTemplateSource, /data-region-catalog-field="countryId"/, "market locations must explicitly belong to an editable country profile");
  assert.match(regionTemplateSource, /data-region-specialty-id/, "market locations must expose reusable specialty modifiers");
  assert.match(regionCssSource, /\.fbls-region-transport\s*\{[^}]*grid-template-columns:\s*auto/, "logistics transport cards must keep reset checkboxes inside their grid layout");
  assert.match(regionCssSource, /\.fbls-region-catalog-editor-shell\s*\{[^}]*--fbls-surface-0[^}]*--fbls-surface-1/s, "region editor shell must establish an opaque shared surface canvas");
  assert.doesNotMatch(regionCssSource, /\.fbls-region-catalog-editor-shell\s*\{[^}]*linear-gradient\([^)]*--fbls-info(?!-soft)/s, "region editor shell must not use a solid status accent as its canvas");
  assert.doesNotMatch(regionEditorSource, /region-catalog:\$\{key\}` \}\);[\s\S]{0,240}requestRender/, "ordinary region field writes must not rerender and reset editor scroll");
  const contentPackImporterSource = readFileSync(path.join(root, "scripts/apps/editors/content-pack-importer.js"), "utf8");
  const contentPackTemplateSource = readFileSync(path.join(root, "templates/content-pack-importer.hbs"), "utf8");
  const contentPackCssSource = readFileSync(path.join(root, "styles/parts/skyhold-content-pack.css"), "utf8");
  assert.match(contentPackImporterSource, /air-islands-materials-and-country-markets\.json/, "content pack importer must expose the bundled material and country-market library");
  assert.match(contentPackTemplateSource, /fbls-content-pack-native-file/, "content pack importer must replace the unthemeable native file row with an owned control");
  assert.match(contentPackCssSource, /\.fbls-content-pack-bundled\s*\{[^}]*height:\s*auto/, "bundled content cards must expand instead of overlapping their descriptions");
  const navigationEventSource = readFileSync(path.join(root, "scripts/apps/domains/events/navigation-events.js"), "utf8");
  assert.match(navigationEventSource, /\^catalog\\\.resources\\\.\\d\+/, "global resource catalog fields must have a dedicated GM write route");
  assert.match(navigationEventSource, /resource-catalog:field:/, "resource catalog fields must update the global catalog in an explicit transaction");
  const previousResourceGame = globalThis.game;
  const hadResourceGameForOverride = Object.hasOwn(globalThis, "game");
  globalThis.game = {
    settings: {
      get(_moduleId, key) {
        if (key === dataConstants.SETTING_CATALOG) return { resources: [{ id: "iron", label: "Iron", img: "world/iron-new.webp" }] };
        return null;
      }
    }
  };
  try {
    const normalizedStoredIron = resources.normalizeResourceRow({ resourceId: "iron", name: "Iron", img: "old/embedded-iron.webp", qty: 2 });
    assert.equal(normalizedStoredIron.img, "world/iron-new.webp", "catalog image overrides must replace stale images embedded in existing storage rows");
  } finally {
    if (hadResourceGameForOverride) globalThis.game = previousResourceGame;
    else delete globalThis.game;
  }
  checkBuildingTemplateCatalog({
    sources: [
      { file: "scripts/data/building-template-manifest.js", templates: buildingTemplateManifest.APPROVED_BUILDING_TEMPLATE_MANIFEST },
      { file: "scripts/data/building-template-catalog/unique.js", templates: buildingTemplatesUnique.BUILDING_TEMPLATES_UNIQUE }
    ],
    templateOrder: buildingTemplates.TEMPLATE_ORDER,
    defaultTemplates: buildingTemplates.DEFAULT_BUILDING_TEMPLATES,
    catalogVersion: buildingTemplates.TEMPLATE_CATALOG_VERSION,
    deprecatedIds: buildingTemplates.DEPRECATED_TEMPLATE_IDS,
    normalizedTemplates: normalizedOnce.catalog.buildings,
    builtinResources: builtinResources.BUILTIN_RESOURCE_DEFS,
    parseResourceCosts: resources.parseResourceCosts,
    migrateData: normalizers.migrateData,
    defaultData: canonicalDefault
  });
  const normalizedFastiTemplate = normalizedOnce.catalog.buildings.find((template) => template.id === "fasti-shop");
  assert.equal(normalizedFastiTemplate?.visibility, "gm", "Fasti shop template must stay hidden from players by default");
  assert.equal(normalizedFastiTemplate?.special?.kind, "fasti-shop", "Fasti shop template must keep its unique building kind");
  assert.equal(normalizedFastiTemplate?.workersMax, 0, "Fasti shop template must not expose worker assignment slots");
  assert.equal(buildingSpecials.inferBuildingSpecialKind({ id: "fasti-shop" }), "fasti-shop", "Fasti shop must be recognized by id fallback");
  assert.equal(buildingSpecials.inferBuildingSpecialKind({ name: "\u041b\u0430\u0432\u043a\u0430 \u0440\u0435\u0434\u043a\u043e\u0441\u0442\u0435\u0439 \u0424\u0430\u0441\u0442\u0438 \u0434\u0438 \u041e\u0442\u043e" }), "fasti-shop", "Fasti shop must be recognized by Russian name fallback");
  const fastiInstanceData = clone(canonicalDefault);
  fastiInstanceData.holdings[0].buildings.list.push({
    id: "fasti-instance",
    name: "Лавка редкостей Фасти ди Ото",
    special: { kind: "fasti-shop", data: {} },
    workersMin: 1,
    workersMax: 3,
    assignedWorkerIds: ["resident-a", "resident-b"]
  });
  fastiInstanceData.holdings[0].people.list.push({ id: "resident-a", name: "A", workAssignment: "fasti-instance", role: "Продавец" });
  const normalizedFastiInstance = normalizers.migrateData(fastiInstanceData).holdings[0].buildings.list.find((building) => building.id === "fasti-instance");
  assert.equal(normalizedFastiInstance.workersMin, 0, "Fasti shop instances must normalize away minimum staffing");
  assert.equal(normalizedFastiInstance.workersMax, 0, "Fasti shop instances must normalize away worker capacity");
  assert.deepEqual(normalizedFastiInstance.assignedWorkerIds, [], "Fasti shop instances must release stale worker slots");
  const releasedFastiWorker = normalizers.migrateData(fastiInstanceData).holdings[0].people.list.find((person) => person.id === "resident-a");
  assert.equal(releasedFastiWorker.workAssignment, "", "Fasti shop normalization must release stale resident work assignments");

  const duplicateCatalogRowsData = clone(canonicalDefault);
  duplicateCatalogRowsData.catalog.buildings.push({
    id: "duplicate-nested-row-test",
    name: "Duplicate nested row test",
    type: "Test",
    primaryDev: "technology",
    functions: { production: true, income: false, defense: false, housing: false, storage: false, culture: false },
    productionLines: [
      { id: "line", resourceId: "wood", outputQty: 1, workQd: 1 },
      { id: "line", resourceId: "stone", outputQty: 1, workQd: 1 }
    ],
    materialCosts: [
      { id: "material", name: "Cloth", resourceId: "cloth", qty: 1 },
      { id: "material", name: "Straw", resourceId: "straw", qty: 1 }
    ]
  });
  const normalizedDuplicateCatalogRows = normalizers.migrateData(duplicateCatalogRowsData);
  const normalizedDuplicateTemplate = normalizedDuplicateCatalogRows.catalog.buildings.find((template) => template.id === "duplicate-nested-row-test");
  assert.deepEqual(normalizedDuplicateTemplate.productionLines.map((line) => line.id), ["line", "line-2"], "normalization must repair duplicate production line ids deterministically");
  assert.deepEqual(normalizedDuplicateTemplate.materialCosts.map((cost) => cost.id), ["material", "material-2"], "normalization must repair duplicate construction cost ids deterministically");
  assert.deepEqual(normalizedDuplicateTemplate.materialCosts.map((cost) => cost.resourceId), ["cloth", "straw"], "normalization must canonicalize construction resource ids");

  assert.equal(normalizers.isBeforeSkyholdSchemaVersion({ fromVersion: normalizers.SKYHOLD_SCHEMA_VERSION - 1 }, normalizers.SKYHOLD_SCHEMA_VERSION), true, "migration context must identify older schema versions");
  assert.equal(normalizers.isBeforeSkyholdSchemaVersion({ fromVersion: normalizers.SKYHOLD_SCHEMA_VERSION }, normalizers.SKYHOLD_SCHEMA_VERSION), false, "migration context must not treat current schema as old");
  const legacyTagPatch = massCombatState.normalizeMassCombatPatch({ attackerFire: 2 });
  assert.deepEqual(legacyTagPatch, { attackerShooters: 2 }, "legacy mass-combat tag patches must migrate without retaining the old field");
  const mixedTagPatch = massCombatState.normalizeMassCombatPatch({ attackerShooters: 3, attackerFire: 2 });
  assert.deepEqual(mixedTagPatch, { attackerShooters: 3 }, "canonical mass-combat tag fields must win over legacy fields");
  assert.equal(massCombatRules.tagValue({ attackerFire: 2 }, "attacker", "shooters"), 2, "legacy tag values must remain readable before normalization");
  assert.equal(massCombatRules.tagValue({ attackerShooters: 3, attackerFire: 2 }, "attacker", "shooters"), 3, "legacy and canonical tag values must never be added together");
  const legacyTagMappings = [
    ["Fire", "Shooters", "shooters"],
    ["Recon", "Skirmishers", "skirmishers"],
    ["Cavalry", "Mobile", "mobile"],
    ["Engineering", "Sappers", "sappers"],
    ["Monstrous", "Monsters", "monsters"]
  ];
  for (const [legacySuffix, canonicalSuffix, tagKey] of legacyTagMappings) {
    const legacyKey = `defender${legacySuffix}`;
    const canonicalKey = `defender${canonicalSuffix}`;
    const normalizedTagPatch = massCombatState.normalizeMassCombatPatch({ [legacyKey]: 2 });
    assert.deepEqual(normalizedTagPatch, { [canonicalKey]: 2 }, `${legacyKey} must migrate to ${canonicalKey}`);
    assert.equal(massCombatRules.tagValue({ [legacyKey]: 2 }, "defender", tagKey), 2, `${legacyKey} must remain readable before normalization`);
    assert.equal(massCombatRules.tagValue({ [canonicalKey]: 3, [legacyKey]: 2 }, "defender", tagKey), 3, `${canonicalKey} must take precedence over ${legacyKey}`);
  }

  assert.deepEqual(
    massCombatState.normalizeMassCombatPatch({ scale: "siege" }),
    { scale: "siege", roundLimit: 8, objectiveThreshold: 8 },
    "changing mass-combat scale must apply that scale's default round and objective limits"
  );
  assert.deepEqual(
    massCombatState.normalizeMassCombatPatch({ scale: "battle", roundLimit: 9, objectiveThreshold: 10 }),
    { scale: "battle", roundLimit: 9, objectiveThreshold: 10 },
    "explicit mass-combat limits must survive a scale change"
  );
  assert.deepEqual(
    massCombatState.normalizeMassCombatPatch({ attackerSourceTag2: "sacred" }),
    { attackerSourcePrimaryTag2: "sacred" },
    "legacy source type patches must migrate to explicit primary-tag fields"
  );
  assert.equal(massCombatState.isAttackerPresetControlledField("attackerBS"), true, "preset-controlled attacker fields must be identifiable");
  assert.equal(massCombatState.isAttackerPresetControlledField("attackerSourcePrimaryTag1"), true, "manual source primary types must mark the preset custom");
  assert.equal(massCombatState.isAttackerPresetControlledField("defenderHero"), false, "defender fields must not mark the attacker preset custom");
  assert.deepEqual(
    massCombatState.normalizeManualMassCombatPatch({ attackerBS: 18 }),
    { attackerBS: 18, attackerPreset: "custom" },
    "manual attacker changes must switch the preset to custom"
  );
  assert.deepEqual(
    massCombatState.normalizeManualMassCombatPatch({ defenderHero: 1 }),
    { defenderHero: 1 },
    "manual defender changes must not alter the attacker preset"
  );
  assert.deepEqual(
    massCombatState.normalizeManualMassCombatPatch({ attackerSourceEfficiency2: 7.5 }),
    { attackerSourceEfficiency2: 7.5, attackerPreset: "custom" },
    "manual source efficiency must support decimals and switch the preset to custom"
  );
  const switchedPresetState = {
    ...massCombatState.resetMassCombatState(),
    attackerPreset: "skirmishers",
    attackerSourcePrimaryTag1: "shooters",
    attackerSourcePrimaryTag2: "sacred",
    attackerSourcePrimaryTag9: "monsters",
    attackerSourceEfficiency1: 8
  };
  massCombatState.applyAttackerPresetToState(switchedPresetState, "beastPack");
  assert.equal(switchedPresetState.attackerPreset, "beastPack", "applying an attacker preset must store the selected preset");
  assert.equal(
    Object.keys(switchedPresetState).some((key) => /^attackerSource(?:(?:Primary)?Tag|Efficiency)\d+$/.test(key)),
    false,
    "switching attacker presets must remove manual source overrides"
  );
  const customPresetState = { ...massCombatState.resetMassCombatState(), attackerSourcePrimaryTag1: "sacred" };
  massCombatState.applyAttackerPresetToState(customPresetState, "custom");
  assert.equal(customPresetState.attackerSourcePrimaryTag1, "sacred", "the custom attacker preset must preserve manual source primary types");
  const prunedSourceTypes = {
    attackerUnits: 3,
    attackerSourcePrimaryTag1: "infantry",
    attackerSourcePrimaryTag2: "shooters",
    attackerSourcePrimaryTag3: "sacred",
    attackerSourceEfficiency1: 6,
    attackerSourceEfficiency3: 9
  };
  massCombatState.pruneAttackerSourcePrimaryTags(prunedSourceTypes, 1);
  assert.deepEqual(
    prunedSourceTypes,
    { attackerUnits: 3, attackerSourcePrimaryTag1: "infantry", attackerSourceEfficiency1: 6 },
    "reducing attacker units must remove manual overrides for deleted sources"
  );

  const emptyBattleHolding = {
    id: "test-holding",
    name: "Test Holding",
    overview: {},
    people: { list: [] },
    buildings: { list: [] },
    gm: { defense: { squads: [] } }
  };
  const pendingFixtureRoot = clone(canonicalDefault);
  pendingFixtureRoot.holdings = [clone(baseSchema.BASE_HOLDING)];
  pendingFixtureRoot.holdings[0].id = "pending-holding";
  pendingFixtureRoot.holdings[0].name = "Pending Holding";
  const pendingRoundHolding = normalizers.migrateData(pendingFixtureRoot).holdings[0];
  pendingRoundHolding.gm.massCombat = {
    ...massCombatState.resetMassCombatState(),
    battleId: "pending-battle",
    defenseMode: "outside",
    useDefenseSquads: false,
    defenderUnits: 3,
    defenderBS: 15,
    attackerUnits: 3,
    attackerBS: 15
  };
  const pendingRoundCalc = massCombatCalculator.calculateBattle(pendingRoundHolding, pendingRoundHolding.gm.massCombat);
  let pendingRandomIndex = 0;
  const pendingRandomValues = [0.99, 0.15, 0.84, 0.32, 0.67, 0.05, 0.48, 0.91, 0.24, 0.73];
  const pendingCreated = massCombatRoundResolution.createPendingBattleRound({
    holding: pendingRoundHolding,
    state: pendingRoundHolding.gm.massCombat,
    calc: pendingRoundCalc,
    random: () => pendingRandomValues[pendingRandomIndex++ % pendingRandomValues.length]
  });
  assert.equal(pendingRoundHolding.gm.massCombat.round, 1, "previewing a battle round must not advance canonical state");
  assert.equal(pendingRoundHolding.gm.massCombat.defenderLossSteps, 0, "previewing a battle round must not apply losses");
  assert.equal(pendingCreated.pendingRound.randomTrace.length > 0, true, "a pending round must retain every random decision value");
  assert.equal(pendingCreated.pendingRound.rollMode, "recorded-d6", "a pending round must identify its reproducible roll mode");

  const pendingApplyHolding = clone(pendingRoundHolding);
  pendingApplyHolding.gm.massCombat.pendingRound = clone(pendingCreated.pendingRound);
  pendingApplyHolding.gm.massCombat.phase = "pending";
  const pendingApplyCalc = massCombatCalculator.calculateBattle(pendingApplyHolding, pendingApplyHolding.gm.massCombat);
  const pendingApplied = massCombatRoundResolution.applyPendingBattleRound({
    holding: pendingApplyHolding,
    state: pendingApplyHolding.gm.massCombat,
    pendingRound: pendingApplyHolding.gm.massCombat.pendingRound,
    calc: pendingApplyCalc
  });
  assert.equal(pendingApplied.ok, true, "applying an unchanged pending round must replay successfully");
  assert.deepEqual(pendingApplied.defenderRolls, pendingCreated.pendingRound.defenderRolls, "apply must reuse the previewed defender dice");
  assert.deepEqual(pendingApplied.attackerRolls, pendingCreated.pendingRound.attackerRolls, "apply must reuse the previewed attacker dice");
  assert.equal(pendingApplied.fingerprint, pendingCreated.pendingRound.fingerprint, "preview and apply must produce the same consequence fingerprint");
  assert.equal(pendingApplyHolding.gm.massCombat.round, 2, "applying a pending round must advance the round exactly once");

  const pendingPersistRoot = clone(canonicalDefault);
  pendingPersistRoot.holdings = [clone(pendingRoundHolding)];
  pendingPersistRoot.holdings[0].gm.massCombat.pendingRound = clone(pendingCreated.pendingRound);
  pendingPersistRoot.holdings[0].gm.massCombat.phase = "pending";
  const normalizedPendingRoot = normalizers.migrateData(pendingPersistRoot);
  const normalizedPendingHolding = normalizedPendingRoot.holdings[0];
  const normalizedPendingApply = massCombatRoundResolution.applyPendingBattleRound({
    holding: normalizedPendingHolding,
    state: normalizedPendingHolding.gm.massCombat,
    pendingRound: normalizedPendingHolding.gm.massCombat.pendingRound,
    calc: massCombatCalculator.calculateBattle(normalizedPendingHolding, normalizedPendingHolding.gm.massCombat)
  });
  assert.equal(normalizedPendingApply.ok, true, "a persisted and normalized pending round must retain its valid snapshot signature");

  const stalePendingHolding = clone(pendingRoundHolding);
  stalePendingHolding.gm.massCombat.pendingRound = clone(pendingCreated.pendingRound);
  stalePendingHolding.gm.massCombat.phase = "pending";
  stalePendingHolding.gm.massCombat.notes = "changed after preview";
  const stalePendingResult = massCombatRoundResolution.applyPendingBattleRound({
    holding: stalePendingHolding,
    state: stalePendingHolding.gm.massCombat,
    pendingRound: stalePendingHolding.gm.massCombat.pendingRound,
    calc: massCombatCalculator.calculateBattle(stalePendingHolding, stalePendingHolding.gm.massCombat)
  });
  assert.equal(stalePendingResult.ok, false, "a pending round must reject changed battle input");
  assert.equal(stalePendingResult.reason, "stale", "a changed pending round must expose a stale-input result");
  assert.equal(stalePendingHolding.gm.massCombat.round, 1, "a stale pending round must not mutate battle state");

  const legacyDamagedBuilding = { id: "damaged-building", constructionStatus: "damaged", buildTarget: 9, buildProgress: 9 };
  buildingState.normalizeBuildingOperationalState(legacyDamagedBuilding);
  assert.equal(legacyDamagedBuilding.lifecycle, "active", "legacy battle damage must migrate to an active building lifecycle");
  assert.equal(legacyDamagedBuilding.condition, "damaged", "legacy battle damage must migrate to a separate physical condition");
  assert.equal(legacyDamagedBuilding.constructionStatus, "damaged", "canonical building state must retain a legacy status projection");

  const legacyRepairBuilding = {
    id: "repair-building",
    constructionStatus: "building",
    repairOf: "heavilyDamaged",
    buildProgress: 2,
    buildTarget: 6,
    repairProgress: 2,
    repairTarget: 6
  };
  buildingState.normalizeBuildingOperationalState(legacyRepairBuilding);
  assert.equal(legacyRepairBuilding.lifecycle, "active", "repair must not masquerade as a construction lifecycle");
  assert.equal(legacyRepairBuilding.condition, "heavilyDamaged", "repair must preserve the condition being repaired");
  assert.equal(legacyRepairBuilding.repair.active, true, "legacy repair markers must migrate to an explicit repair process");
  const repairProgress = buildingState.advanceBuildingProject(legacyRepairBuilding, 4);
  assert.equal(repairProgress.completed, true, "enough repair successes must complete the repair process");
  assert.equal(legacyRepairBuilding.lifecycle, "active", "completed repair must preserve the building lifecycle");
  assert.equal(legacyRepairBuilding.condition, "intact", "completed repair must restore physical condition");
  assert.equal(legacyRepairBuilding.constructionStatus, "built", "completed repair must update the compatibility projection");

  const lifecycleMigrationRoot = clone(canonicalDefault);
  lifecycleMigrationRoot.meta.schemaVersion = 53;
  lifecycleMigrationRoot.holdings = [clone(baseSchema.BASE_HOLDING)];
  lifecycleMigrationRoot.holdings[0].buildings.list = [{
    id: "migrated-repair",
    name: "Migrated Repair",
    constructionStatus: "building",
    repairOf: "damaged",
    buildProgress: 1,
    buildTarget: 3,
    repairProgress: 1,
    repairTarget: 3
  }];
  const migratedRepair = normalizers.migrateData(lifecycleMigrationRoot).holdings[0].buildings.list[0];
  assert.equal(migratedRepair.lifecycle, "active", "schema 54 must migrate a legacy repair without changing lifecycle");
  assert.equal(migratedRepair.condition, "damaged", "schema 54 must migrate legacy damage into condition");
  assert.equal(migratedRepair.repair.active, true, "schema 54 must migrate legacy repair progress into an explicit process");

  const battleDamageBuilding = { id: "battle-damage-building", lifecycle: "active", condition: "intact", constructionStatus: "built", buildTarget: 6 };
  massCombatDamage.escalateBuildingBattleDamage(battleDamageBuilding, 2);
  assert.equal(battleDamageBuilding.lifecycle, "active", "battle damage must never change building lifecycle");
  assert.equal(battleDamageBuilding.condition, "damaged", "battle damage must change physical condition");

  const semanticWarehouse = { id: "semantic-storage", name: "Object 17", functions: { storage: true } };
  const misleadingWarehouse = { id: "misleading-storage", name: "Warehouse", functions: {} };
  assert.equal(massCombatTargets.buildingBattleRoles(semanticWarehouse).has("storage"), true, "battle target roles must use building function metadata");
  assert.equal(massCombatTargets.buildingBattleRoles(misleadingWarehouse).has("storage"), false, "battle target roles must not depend on localized building names");
  assert.equal(
    massCombatTargets.battleTargetWeight(semanticWarehouse, { attackerStrategy: { raid: true } }) > massCombatTargets.battleTargetWeight(misleadingWarehouse, { attackerStrategy: { raid: true } }),
    true,
    "raids must prioritize semantic storage targets"
  );
  const exposureSlots = massCombatSources.riskSlotsFromSources([
    { id: "garrison", label: "Garrison", type: "garrison", dice: 1, participantIds: ["a"], damageWeight: 1 },
    { id: "militia", label: "Militia", type: "militia", dice: 1, participantIds: ["b"], damageWeight: 1 }
  ]);
  assert.equal(exposureSlots[0].exposure, "fortified", "garrison participants must receive fortified exposure");
  assert.equal(exposureSlots[1].exposure, "civilian", "militia participants must retain civilian exposure");
  assert.equal(exposureSlots[1].weight > exposureSlots[0].weight, true, "civilian militia must carry more casualty exposure than a garrison");

  const archiveState = {
    ...massCombatState.resetMassCombatState(),
    battleId: "archive-battle",
    title: "Archive Battle",
    enemyName: "Raiders",
    round: 4,
    log: [{ round: 1, createdAt: "2026-07-11T08:00:00.000Z" }],
    casualtyLog: [{ battleId: "archive-battle", residentId: "resident-1" }],
    buildingDamageLog: [
      { battleId: "archive-battle", buildingId: "building-1" },
      { battleId: "archive-battle", buildingId: "building-1" },
      { battleId: "archive-battle", buildingId: "building-2" }
    ]
  };
  const archivedBattle = massCombatArchive.archiveBattle(archiveState, {
    outcome: "defender-victory",
    resolvedAt: "2026-07-11T09:00:00.000Z",
    resolvedBy: "gm-1"
  });
  assert.equal(archivedBattle.roundsPlayed, 3, "battle archive must record the number of completed rounds");
  assert.equal(archivedBattle.casualtyCount, 1, "battle archive must summarize casualties for its battle id");
  assert.equal(archivedBattle.damagedBuildingCount, 2, "battle archive must count unique damaged buildings");
  assert.equal(Object.hasOwn(archivedBattle.snapshot, "archive"), false, "an archived snapshot must not recursively contain the archive");
  assert.equal(Object.hasOwn(archivedBattle.snapshot, "pendingRound"), false, "an archived snapshot must not retain a pending round");
  assert.equal(massCombatArchive.archiveBattle(archiveState), archivedBattle, "archiving the same battle id twice must be idempotent");
  assert.equal(archiveState.archive.length, 1, "idempotent battle archival must not add duplicate entries");

  for (let index = 0; index < massCombatArchive.BATTLE_ARCHIVE_LIMIT + 3; index += 1) {
    archiveState.battleId = `archive-battle-${index}`;
    massCombatArchive.archiveBattle(archiveState, { resolvedAt: `2026-07-11T10:${String(index).padStart(2, "0")}:00.000Z` });
  }
  assert.equal(archiveState.archive.length, massCombatArchive.BATTLE_ARCHIVE_LIMIT, "battle archive must enforce its retention limit");
  assert.equal(archiveState.archive.some((entry) => entry.battleId === "archive-battle-22"), true, "battle archive must retain the newest entries");

  const archivePersistRoot = clone(canonicalDefault);
  archivePersistRoot.holdings = [clone(baseSchema.BASE_HOLDING)];
  archivePersistRoot.holdings[0].gm.massCombat = clone(archiveState);
  const normalizedArchive = normalizers.migrateData(archivePersistRoot).holdings[0].gm.massCombat.archive;
  assert.equal(normalizedArchive.length, massCombatArchive.BATTLE_ARCHIVE_LIMIT, "normalization must preserve the bounded battle archive");
  assert.equal(normalizedArchive.at(-1).snapshot.battleId, "archive-battle-22", "normalization must preserve replayable archive snapshots");

  const setupTemplateText = readFileSync(path.join(root, "templates/parts/mass-combat/setup.hbs"), "utf8");
  const progressTemplateText = readFileSync(path.join(root, "templates/parts/mass-combat/progress.hbs"), "utf8");
  const detailsTemplateText = readFileSync(path.join(root, "templates/parts/mass-combat/details.hbs"), "utf8");
  const counterReferenceTemplateText = readFileSync(path.join(root, "templates/mass-combat-counter-reference.hbs"), "utf8");
  const weatherReferenceTemplateText = readFileSync(path.join(root, "templates/mass-combat-weather-reference.hbs"), "utf8");
  const tagEditorTemplateText = readFileSync(path.join(root, "templates/mass-combat-tag-editor.hbs"), "utf8");
  const tagEditorAppText = readFileSync(path.join(root, "scripts/apps/editors/mass-combat-tag-editor.js"), "utf8");
  const massCombatAppText = readFileSync(path.join(root, "scripts/apps/mass-combat.js"), "utf8");
  const foundryBridgeText = readFileSync(path.join(root, "styles/parts/skyhold-foundry-bridge.css"), "utf8");
  const massCombatDialogsCss = readFileSync(path.join(root, "styles/parts/mass-combat/mass-combat-dialogs.css"), "utf8");
  const buildingDefenseTemplateText = readFileSync(path.join(root, "templates/parts/building-editor/defense.hbs"), "utf8");
  const settlementDefenseTemplateText = readFileSync(path.join(root, "templates/parts/skyhold-tab-defense.hbs"), "utf8");
  assert.match(setupTemplateText, /data-action="mass-finalize-battle"/, "terminal battles must expose an explicit archive action");
  assert.match(progressTemplateText, /fbls-battle-archive-list/, "mass-combat progress must expose archived battle summaries");
  assert.equal(
    setupTemplateText.includes('data-mass-field="attackerPreset"'),
    false,
    "selecting an attacker preset must not save or apply it before the apply button"
  );
  assert.equal(
    setupTemplateText.includes("data-attacker-preset-select"),
    true,
    "the attacker preset selector must remain available as a local draft selection"
  );
  assert.equal(setupTemplateText.includes('data-action="mass-apply-round"'), true, "the battle UI must require explicit application of a pending round");
  assert.equal(setupTemplateText.includes('data-action="mass-discard-round"'), true, "the battle UI must allow a pending round to be discarded without consequences");
  assert.equal(
    setupTemplateText.includes("Угроза раунда"),
    true,
    "round threat must be visibly presented as an active round modifier"
  );
  assert.equal(
    setupTemplateText.includes("DR {{defense.total}} · справ."),
    true,
    "Defence Rating must be visibly marked as a reference value"
  );
  assert.equal(
    buildingDefenseTemplateText.includes(".defense.combatTag"),
    true,
    "the building defense editor must expose the squad tag produced by the building"
  );
  assert.match(settlementDefenseTemplateText, /fbls-defense-workspace[\s\S]{0,1600}fbls-defense-overview/, "the settlement Defense tab must keep its compact overview workspace");
  assert.match(settlementDefenseTemplateText, /fbls-defense-member-grid[\s\S]{0,1800}memberIds/, "the Defense tab must keep a compact five-slot squad roster");
  assert.equal(detailsTemplateText.includes("Шаблон:"), false, "attacker source rows must not repeat the preset tag in a separate caption");
  assert.equal(detailsTemplateText.includes("Из шаблона:"), false, "the source tag selector must not repeat the preset tag name");
  assert.equal(counterReferenceTemplateText.includes("{{{graphHtml}}}"), true, "the counter graph must render in its own ApplicationV2 reference window");
  assert.equal(counterReferenceTemplateText.includes("Понятно"), false, "the counter reference window must not inherit a dialog footer button");
  assert.equal(weatherReferenceTemplateText.includes("fbls-weather-reference-list"), true, "weather rules must render in their own reference window");
  assert.equal(massCombatAppText.includes("_showSimpleDialog"), false, "mass-combat references must not use nested generic dialogs");
  assert.equal(
    foundryBridgeText.includes('[data-application-part="body"]::-webkit-scrollbar-track'),
    true,
    "the battle ApplicationV2 scroll owner must receive an explicit dark scrollbar track"
  );
  const counterGraphMarkup = massCombatCounterGraph.counterGraphHtml("regression-counter");
  assert.equal(counterGraphMarkup.includes("fbls-skyhold-dark-panel"), false, "the counter graph must not add a second framed panel inside its window");
  assert.equal(counterGraphMarkup.includes('role="button"'), true, "counter graph nodes must remain keyboard-accessible without inheriting Foundry button colors");
  assert.equal(counterGraphMarkup.includes("tone-red"), false, "the overview graph must not assign arbitrary red and green tones to unrelated edges");
  const graphPoints = Array.from(counterGraphMarkup.matchAll(/data-counter-x="(\d+)" data-counter-y="(\d+)"/g))
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]) }));
  const graphDistances = graphPoints.map((point, index) => {
    const next = graphPoints[(index + 1) % graphPoints.length];
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
  assert.equal(Math.max(...graphDistances) - Math.min(...graphDistances) < 2, true, "counter graph nodes must keep equal center-to-center spacing around the circle");
  assert.equal(graphPoints.filter((point) => point.y === Math.max(...graphPoints.map((item) => item.y))).length, 1, "odd tag counts must place one node at the bottom instead of a cramped pair");
  assert.equal(massCombatDialogsCss.includes("--edge-width: 7px"), true, "full counters must use a visibly heavier edge than base counters");
  assert.equal(massCombatDialogsCss.includes("height: var(--edge-width)"), true, "counter lines must use a solid centered body at every strength");
  assert.equal(massCombatDialogsCss.includes("clip-path: polygon(0 0, 100% 50%, 0 100%)"), true, "counter arrowheads must share the line center instead of relying on offset borders");
  assert.equal(massCombatDialogsCss.includes("border-top: var(--edge-width)"), false, "counter lines must not use a one-sided border that offsets thick arrows");
  assert.equal(
    massCombatDialogsCss.includes('.fbls-counter-pentagram:not([data-selected-tag="all"]) .fbls-counter-node.is-related'),
    true,
    "related graph nodes must override the dimmed-node state with sufficient CSS specificity"
  );
  assert.equal(massCombatDialogsCss.includes(".fbls-counter-node.is-source"), true, "countering nodes must have a dedicated visual state");
  assert.equal(massCombatDialogsCss.includes(".fbls-counter-node.is-target"), true, "countered nodes must have a dedicated visual state");
  assert.match(massCombatDialogsCss, /fbls-counter-node\.is-selected[\s\S]{0,240}color:\s*var\(--fbls-on-accent\)/, "selected counter nodes must keep readable foreground contrast");
  assert.match(massCombatDialogsCss, /fbls-counter-center[\s\S]{0,700}color:\s*var\(--fbls-on-accent\)/, "the selected counter center must keep readable foreground contrast");
  assert.equal(
    foundryBridgeText.includes(".application.fbl-skyhold-mass-tag-editor *::-webkit-scrollbar-track"),
    true,
    "the tag editor must own every nested scrollbar track instead of exposing the Foundry light gutter"
  );
  assert.equal(
    foundryBridgeText.includes(".application.fbl-skyhold-mass-combat .application-content") &&
      foundryBridgeText.includes("overflow: hidden") &&
      foundryBridgeText.includes('[data-application-part="body"]'),
    true,
    "the battle shell must stay non-scrolling and delegate vertical scrolling to the body part"
  );
  assert.equal(tagEditorTemplateText.includes('data-action="open-mass-tag-icon-picker"'), true, "the tag editor must expose a Font Awesome icon catalog");
  assert.equal(tagEditorTemplateText.includes("data-mass-icon-search"), true, "the Font Awesome icon catalog must be searchable");
  assert.equal(tagEditorTemplateText.includes('data-action="apply-mass-tag-icon"'), true, "the icon catalog must expose an explicit apply action");
  assert.equal(tagEditorAppText.includes('querySelectorAll?.(".fbls-mass-tag-table tbody tr[data-tag-key]")'), true, "icon application must target tag rows instead of matching the picker draft key");
  assert.equal(tagEditorAppText.includes("this._applyPendingIcon({ close: false });"), true, "saving the editor must commit an open pending icon choice");
  assert.equal(massCombatIconCatalog.massCombatIconOptions().length >= 40, true, "the Font Awesome picker must provide a useful curated catalog");
  const builtInPresetKeys = Object.keys(massCombatRules.ATTACKER_PRESETS).filter((key) => key !== "custom");
  for (const presetKey of builtInPresetKeys) {
    const presetState = {
      ...massCombatState.resetMassCombatState(),
      attackerSourcePrimaryTag1: "sacred",
      attackerSourcePrimaryTag20: "monsters",
      attackerSourceEfficiency1: 8
    };
    massCombatState.applyAttackerPresetToState(presetState, presetKey);
    assert.equal(presetState.attackerPreset, presetKey, `preset ${presetKey} must become the active preset`);
    assert.equal(
      Object.keys(presetState).some((key) => /^attackerSource(?:(?:Primary)?Tag|Efficiency)\d+$/.test(key)),
      false,
      `preset ${presetKey} must clear manual source overrides`
    );
    const presetBattle = massCombatCalculator.calculateBattle(emptyBattleHolding, {
      ...presetState,
      defenseMode: "outside",
      useDefenseSquads: false
    });
    assert.equal(presetBattle.attackerSources.length, presetState.attackerUnits, `preset ${presetKey} must build every declared source`);
    assert.equal(
      presetBattle.attackerSources.every((source) => Object.keys(source.tags ?? {}).length === 1),
      true,
      `every ${presetKey} source must have exactly one tag`
    );
    const expectedCounts = massCombatRules.ATTACKER_PRESET_TAG_REQUIREMENTS[presetKey] ?? {};
    const actualCounts = {};
    for (const source of presetBattle.attackerSources) {
      const tag = Object.keys(source.tags ?? {})[0];
      actualCounts[tag] = (actualCounts[tag] ?? 0) + 1;
    }
    assert.deepEqual(actualCounts, expectedCounts, `preset ${presetKey} must use its exact one-tag squad composition`);
  }
  for (const fromPreset of builtInPresetKeys) {
    for (const toPreset of builtInPresetKeys) {
      const transitionState = massCombatState.resetMassCombatState();
      massCombatState.applyAttackerPresetToState(transitionState, fromPreset);
      transitionState.attackerSourcePrimaryTag1 = "sacred";
      transitionState.attackerSourceEfficiency1 = 8;
      massCombatState.applyAttackerPresetToState(transitionState, toPreset);
      assert.equal(transitionState.attackerPreset, toPreset, `${fromPreset} -> ${toPreset} must store the destination preset`);
      assert.equal(
        Object.keys(transitionState).some((key) => /^attackerSource(?:(?:Primary)?Tag|Efficiency)\d+$/.test(key)),
        false,
        `${fromPreset} -> ${toPreset} must not retain manual source overrides`
      );
    }
  }
  const veteran = {
    id: "veteran",
    age: 35,
    background: "Ветеран гарнизона",
    role: "Сержант",
    attributes: { strength: 5, agility: 4, wits: 4, empathy: 3 }
  };
  assert.equal(massCombatResidents.isAdultResident({ age: 17 }), false, "children must not enter mass-combat resident pools");
  assert.equal(massCombatResidents.isAdultResident({ age: 18 }), true, "young non-child residents must enter mass-combat resident pools");
  assert.equal(massCombatResidents.isAdultResident({ age: 35, injuredDays: 2 }), false, "injured residents must not enter active combat pools");
  assert.equal(massCombatResidents.isInjuredResident({ age: 35, injuredDays: 0, status: "Ранен (0 дн.)" }), false, "explicit zero injury days must override stale injured status text");
  assert.equal(massCombatResidents.isInjuredResident({ age: 35, status: "Ранен" }), true, "legacy residents without an injury counter may still rely on injured status text");
  const medicalPatientContext = { _safeNumber: (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback) };
  assert.equal(
    buildingRowsDomain.BuildingRowsDomain._isMedicalPatient.call(medicalPatientContext, { injuredDays: 0, status: "Ранен (0 дн.)" }),
    false,
    "medical buildings must not keep recovered residents as patients because of stale injury status text"
  );
  assert.equal(
    buildingRowsDomain.BuildingRowsDomain._isMedicalPatient.call(medicalPatientContext, { injuredDays: 0, status: "Болен" }),
    true,
    "medical buildings must still accept illness statuses without injury days"
  );
  assert.equal(massCombatResidents.isMilitaryResident({ workAssignment: "soldier" }), true, "explicit soldier assignments must count as military");
  assert.equal(
    massCombatResidents.isSoldierResident({ workAssignment: "soldier", attributes: { strength: 2, agility: 3 } }),
    false,
    "soldier classification must preserve its minimum physical attributes"
  );
  assert.equal(massCombatResidents.isSergeantCandidate(veteran), true, "experienced soldiers with an outstanding attribute must qualify as sergeants");
  assert.equal(massCombatResidents.isCommanderCandidate(veteran), true, "military residents with sufficient wits must qualify as commanders");
  assert.equal(
    massCombatResidents.isSuitableForSquadType({ attributes: { strength: 3, agility: 3, wits: 3 } }, "artillery"),
    false,
    "specialist squad requirements must reject unsuitable residents"
  );
  assert.equal(
    massCombatResidents.soldierEfficiency({ ...veteran, attributes: { strength: 3, agility: 4, wits: 5 } }, "artillery"),
    1.35,
    "soldier efficiency must preserve attribute and military-background bonuses"
  );
  assert.equal(massCombatResidents.squadTypeProfile("unknown").label, "Линейная пехота", "unknown squad types must keep the line infantry fallback");

  assert.deepEqual(
    massCombatSources.sourceEfficiencies(7, 3),
    [5, 2, 0],
    "understrength effectiveness must fill complete sources before partial ones"
  );
  assert.deepEqual(
    massCombatSources.sourceEfficiencies(12, 2),
    [6, 6],
    "surplus effectiveness must be distributed evenly between declared sources"
  );
  const pooledSourceA = massCombatSources.makeSource({
    side: "defender",
    type: "regular",
    id: "pool-a",
    label: "A",
    baseEfficiency: 5,
    participantIds: ["a"]
  });
  const pooledSourceB = massCombatSources.makeSource({
    side: "defender",
    type: "regular",
    id: "pool-b",
    label: "B",
    baseEfficiency: 5,
    participantIds: ["b"]
  });
  pooledSourceA.currentEfficiency = 3;
  pooledSourceB.currentEfficiency = 2;
  const mixedPool = massCombatSources.pooledDiceFromSources([pooledSourceA, pooledSourceB], { side: "defender" });
  assert.equal(mixedPool.dice, 1, "partial effectiveness from full sources must combine into a field die");
  assert.equal(mixedPool.slots[0]?.type, "mixed", "a die assembled from several sources must keep a mixed risk slot");
  assert.deepEqual(mixedPool.slots[0]?.participantIds, ["a", "b"], "mixed risk slots must retain all contributing residents");
  const distributedTags = massCombatSources.sourceTagSetsFromState({
    attackerUnits: 2,
    attackerInfantry: 2,
    attackerShooters: 2,
    attackerSkirmishers: 2,
    attackerHeavy: 2
  }, "attacker", 2);
  assert.equal(
    distributedTags.every((tags) => Object.keys(tags).length === 1),
    true,
    "automatic source construction must give every source exactly one tag"
  );
  const manuallyTypedSources = massCombatSources.attackerSourcesFromState({
    ...massCombatRules.ATTACKER_PRESETS.pettyRaiders.patch,
    attackerSourcePrimaryTag1: "sacred"
  });
  massCombatSources.finalizeSources(manuallyTypedSources);
  assert.deepEqual(
    Object.keys(manuallyTypedSources[0]?.templateTags ?? {}).sort(),
    ["mobile"],
    "manual tags must retain the source's single template tag separately"
  );
  assert.deepEqual(
    Object.keys(manuallyTypedSources[0]?.tags ?? {}).sort(),
    ["sacred"],
    "manual tags must replace the template tag instead of being added to it"
  );
  assert.equal(manuallyTypedSources[0]?.primaryTag, "sacred", "manual primary types must become the displayed primary tag");
  const manuallyTypedRow = massCombatSources.sourceRows(manuallyTypedSources)[0];
  assert.equal(manuallyTypedRow.tagBadges.length, 1, "source rows must expose exactly one effective tag");
  assert.equal(manuallyTypedRow.tagField, "attackerSourcePrimaryTag1", "source rows must use explicit manual primary-tag fields");
  const individuallySkilledSources = massCombatSources.attackerSourcesFromState({
    attackerUnits: 3,
    attackerBS: 15,
    attackerInfantry: 3,
    attackerSourceEfficiency1: 8,
    attackerSourceEfficiency2: 4.5
  });
  assert.deepEqual(
    individuallySkilledSources.map((source) => source.baseEfficiency),
    [8, 4.5, 5],
    "individual source efficiency must override only the selected sources"
  );
  massCombatSources.finalizeSources(individuallySkilledSources);
  const individuallySkilledRows = massCombatSources.sourceRows(individuallySkilledSources);
  assert.equal(individuallySkilledRows[0].hasManualEfficiency, true, "source rows must mark manual efficiency");
  assert.equal(individuallySkilledRows[0].autoBaseEfficiency, 5, "source rows must retain the automatic efficiency for reset");
  assert.equal(individuallySkilledRows[2].hasManualEfficiency, false, "untouched sources must continue using automatic efficiency");
  const individualPool = massCombatSources.pooledDiceFromSources(individuallySkilledSources, { side: "attacker" });
  assert.equal(individualPool.dice, 3, "explicit low-professionalism sources must still contribute to the shared field pool");
  const individuallySkilledBattle = massCombatCalculator.calculateBattle(emptyBattleHolding, {
    ...massCombatState.resetMassCombatState(),
    defenseMode: "outside",
    useDefenseSquads: false,
    attackerUnits: 3,
    attackerBS: 15,
    attackerInfantry: 3,
    attackerSourceEfficiency1: 8,
    attackerSourceEfficiency2: 4.5
  });
  assert.equal(individuallySkilledBattle.attackerBS, 17.5, "the assembled battle must report the sum of individual base efficiency");
  assert.equal(massCombatModifiers.commanderEffectiveness(veteran), 4.5, "commander effectiveness must preserve attributes and military experience");
  const modifiedSource = massCombatSources.makeSource({
    side: "attacker",
    type: "regular",
    id: "modified",
    baseEfficiency: 10,
    tags: { shooters: 1 }
  });
  massCombatModifiers.applyTagModifiers([modifiedSource], { shooters: -0.2, infantry: 0.1 }, "Test");
  assert.equal(modifiedSource.currentEfficiency, 8, "tag modifiers must affect only matching source tags");
  massCombatModifiers.applyCommanderToSources([modifiedSource], 0.1, "Commander");
  assert.equal(modifiedSource.currentEfficiency, 9, "modifiers from different sources must stack additively against base efficiency");
  const simultaneousSource = massCombatSources.makeSource({
    side: "attacker",
    type: "regular",
    id: "simultaneous",
    baseEfficiency: 10,
    tags: { siege: 1 }
  });
  massCombatModifiers.applyTagModifiers([simultaneousSource], { siege: 0.15 }, "Scale");
  massCombatModifiers.applyTagModifiers([simultaneousSource], massCombatRules.ROUND_THREATS.breach.attackerTagMods, "Threat");
  massCombatModifiers.applyCommanderToSources([simultaneousSource], 0.10, "Commander");
  assert.equal(simultaneousSource.currentEfficiency, 14.5, "scale, threat, and commander modifiers must compose additively and simultaneously");
  assert.equal(simultaneousSource.modifiers.length, 3, "every simultaneous modifier source must remain visible in the source breakdown");

  const counterTarget = massCombatSources.makeSource({
    side: "defender",
    type: "regular",
    id: "counter-target",
    label: "Target",
    baseEfficiency: 10,
    tags: { infantry: 1 }
  });
  const counterSources = Array.from({ length: 3 }, (_, index) => massCombatSources.makeSource({
    side: "attacker",
    type: "regular",
    id: `counter-${index + 1}`,
    label: `Counter ${index + 1}`,
    baseEfficiency: 5,
    tags: { shooters: 1 }
  }));
  const counterRows = massCombatModifiers.applyTagCounters(counterSources, [counterTarget]);
  assert.equal(counterTarget.currentEfficiency, 2.5, "stacked counters must never reduce a source below 25% efficiency");
  assert.equal(counterRows.length, 2, "counters that exceed the 75% loss cap must stop producing rows");

  const accessMode = { penalty: -2, helps: ["mobile"] };
  const mobileSource = massCombatSources.makeSource({
    side: "attacker",
    type: "regular",
    id: "mobile-access",
    baseEfficiency: 5,
    tags: { mobile: 1 }
  });
  assert.equal(
    massCombatModifiers.externalDice({ attackerHero: 1 }, "attacker", accessMode, [mobileSource]).dice,
    1,
    "a helpful source tag must remove the special access penalty"
  );
  assert.equal(
    massCombatModifiers.externalDice({ attackerHero: 1 }, "attacker", accessMode, []).dice,
    -1,
    "special access penalties must apply when no helpful tag is present"
  );

  const garrisonHolding = {
    people: {
      list: [{
        id: "guard",
        name: "Guard",
        age: 30,
        workAssignment: "tower",
        role: "Страж",
        attributes: { strength: 4, agility: 4, wits: 3, empathy: 2 }
      }]
    },
    buildings: {
      list: [{
        id: "tower",
        name: "Tower",
        constructionStatus: "built",
        functions: { defense: true },
        assignedWorkerIds: ["guard"],
        defense: { base: 1, perStep: 1, workerStep: 1, combatTag: "shooters" }
      }]
    }
  };
  const taggedGarrison = massCombatSources.defenseGarrisonProfile(garrisonHolding);
  assert.deepEqual(taggedGarrison.sources[0]?.tags, { shooters: 1 }, "a defensive building must produce exactly its selected combat tag");
  garrisonHolding.buildings.list[0].defense.combatTag = "";
  const defaultGarrison = massCombatSources.defenseGarrisonProfile(garrisonHolding);
  assert.deepEqual(defaultGarrison.sources[0]?.tags, { garrison: 1 }, "a defensive building without a selected tag must default to Garrison");

  assert.equal(
    massCombatWeather.normalizeWeatherText("Weather.Common.PartlyCloudy"),
    "переменная облачность",
    "weather extraction must preserve Calendaria alias normalization"
  );
  assert.equal(
    massCombatWeather.weatherTextFromHolding(
      { ...emptyBattleHolding, overview: { weather: "По маршруту" } },
      { weather: "Rain", dateKey: "test-day" }
    ),
    "дождь",
    "weather extraction must accept an injected Calendaria snapshot"
  );
  const weatherSource = { type: "regular", tags: { shooters: 1 }, currentEfficiency: 10, modifiers: [] };
  massCombatWeather.applyWeatherModifiers([weatherSource], massCombatWeather.weatherBattleModifier(
    { ...emptyBattleHolding, overview: { weather: "дождь" } }
  ));
  assert.equal(weatherSource.currentEfficiency, 8.5, "weather extraction must keep tag efficiency modifiers unchanged");

  const threatBattle = massCombatCalculator.calculateBattle(
    { ...emptyBattleHolding, overview: { weather: "ясно" } },
    {
      ...massCombatState.resetMassCombatState(),
      defenseMode: "outside",
      useDefenseSquads: false,
      scale: "raid",
      roundThreat: "fire",
      attackerStrategy: "probingAdvance",
      attackerUnits: 1,
      attackerBS: 5,
      attackerCommand: 1,
      attackerInfantry: 0,
      attackerShooters: 1
    }
  );
  assert.equal(threatBattle.attackerSources[0]?.currentEfficiency, 6.5, "method, threat, weather, and commander bonuses must all affect a matching squad");
  assert.equal(
    threatBattle.attackerSources[0]?.modifiers.some((row) => row.startsWith("Угроза: Обстрел")),
    true,
    "round threat must be exposed in the source modifier breakdown"
  );

  const brokenTrack = massCombatTracks.lossTrack("Test", 6, 2);
  assert.equal(brokenTrack.threshold, 6, "loss tracks must keep three steps per unit");
  assert.equal(brokenTrack.state, "Сломлены", "loss tracks must mark units broken at the threshold");
  const completedObjective = massCombatTracks.objectiveTrack({
    scale: "raid",
    objectiveProgress: 3,
    objectiveThreshold: 3,
    round: 5,
    roundLimit: 4
  }, massCombatRules.SCALES.raid);
  assert.equal(completedObjective.done, true, "objective tracks must detect a completed objective");
  assert.equal(completedObjective.outOfTime, true, "objective tracks must detect an exceeded round limit");
  assert.equal(completedObjective.state, "Цель достигнута", "a completed objective must take precedence over the round limit label");

  const activeBattleTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 2, threshold: 6 },
    attackerLossTrack: { value: 1, threshold: 6 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  const attackerVictoryTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 6, threshold: 6 },
    attackerLossTrack: { value: 1, threshold: 6 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  const defenderVictoryTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 2, threshold: 6 },
    attackerLossTrack: { value: 6, threshold: 6 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  const timeoutTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 2, threshold: 6 },
    attackerLossTrack: { value: 1, threshold: 6 },
    objectiveTrack: { done: false, outOfTime: true }
  });
  const objectiveAtDeadlineTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 2, threshold: 6 },
    attackerLossTrack: { value: 1, threshold: 6 },
    objectiveTrack: { done: true, outOfTime: true }
  });
  const contestedTerminal = massCombatTerminal.battleTerminalState({}, {
    defenderLossTrack: { value: 6, threshold: 6 },
    attackerLossTrack: { value: 6, threshold: 6 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  assert.equal(activeBattleTerminal.finished, false, "an unfinished battle must keep round resolution enabled");
  assert.equal(activeBattleTerminal.outcome, "active", "an unfinished battle must expose the active outcome");
  assert.equal(attackerVictoryTerminal.outcome, "attacker-victory", "breaking the defenders must end in attacker victory");
  assert.equal(defenderVictoryTerminal.outcome, "defender-victory", "breaking the attackers must end in defender victory");
  assert.equal(timeoutTerminal.outcome, "defender-victory", "running out of rounds before the objective must end in defender victory");
  assert.equal(objectiveAtDeadlineTerminal.outcome, "attacker-victory", "completing the objective on the deadline must take precedence over timeout");
  assert.equal(contestedTerminal.outcome, "contested", "simultaneously broken sides must expose a contested outcome");
  assert.equal(contestedTerminal.finished, true, "a contested terminal result must block another round");

  const sparseArmy = massCombatCalculator.calculateBattle(emptyBattleHolding, {
    ...massCombatState.resetMassCombatState(),
    defenseMode: "outside",
    useDefenseSquads: false,
    attackerUnits: 3,
    attackerBS: 1,
    attackerInfantry: 3
  });
  const rainyArmy = massCombatCalculator.calculateBattle(
    { ...emptyBattleHolding, overview: { weather: "дождь" } },
    { ...massCombatState.resetMassCombatState(), defenseMode: "outside", useDefenseSquads: false }
  );
  assert.equal(rainyArmy.weather.text, "дождь", "the calculator must assemble weather data from weather.js");
  assert.equal(sparseArmy.attackerBS, 1, "declaring extra units must not create attacker effectiveness");
  assert.equal(sparseArmy.attackerPool, 0, "understrength attacker units must not create free dice");

  const singleTagArmy = massCombatCalculator.calculateBattle(emptyBattleHolding, {
    ...massCombatState.resetMassCombatState(),
    ...massCombatRules.ATTACKER_PRESETS.pettyRaiders.patch,
    defenseMode: "outside",
    useDefenseSquads: false
  });
  assert.deepEqual(
    Object.keys(singleTagArmy.attackerSources[0]?.tags ?? {}).sort(),
    ["mobile"],
    "an attacker source must retain only its configured squad tag"
  );
  const switchedPresetArmy = massCombatCalculator.calculateBattle(emptyBattleHolding, switchedPresetState);
  assert.equal(switchedPresetArmy.attackerSources.some((source) => source.primaryTag === "sacred"), false, "a new attacker preset must not inherit source types from the previous preset");
  assert.equal(switchedPresetArmy.attackerSources.some((source) => source.tags.monsters > 0), true, "a new attacker preset must assign its own source types");

  const accessBase = {
    ...massCombatState.resetMassCombatState(),
    defenseMode: "outside",
    useDefenseSquads: false,
    attackerUnits: 4,
    attackerBS: 20,
    attackerInfantry: 0,
    attackerMobile: 4
  };
  const normalAccessArmy = massCombatCalculator.calculateBattle(emptyBattleHolding, { ...accessBase, accessMode: "normal" });
  const airborneAccessArmy = massCombatCalculator.calculateBattle(emptyBattleHolding, { ...accessBase, accessMode: "airborne" });
  assert.equal(airborneAccessArmy.attackerPool, normalAccessArmy.attackerPool, "a helpful army tag must satisfy special access");

  const medicalHolding = {
    people: { list: [{ id: "healer", name: "Healer", dead: false, injuredDays: 0 }] },
    buildings: { list: [{ id: "hospital", name: "Лазарет", specialKind: "medical", constructionStatus: "built", assignedWorkerIds: ["healer"] }] }
  };
  const medicalManager = {
    _medicalAssignments: () => new Map([["hospital", { capacity: 2, patients: [{ id: "patient" }], efficiency: 2.5 }]])
  };
  const support = massCombatCasualties.medicalSupport(medicalHolding, { medicalAssignments: medicalManager._medicalAssignments });
  assert.equal(support.capacity, 1, "mass combat must use free medical capacity rather than a hard-coded per-worker fallback");
  assert.equal(support.workerEfficiency, 2.5, "mass combat must preserve medical worker efficiency");
  const dependencyGarrison = massCombatSources.defenseGarrisonProfile({
    people: { list: [{ id: "guard", name: "Guard", dead: false, injuredDays: 0 }] },
    buildings: { list: [{ id: "tower", name: "Tower", constructionStatus: "built", functions: { defense: true }, defense: { workerStep: 4, maxDice: 3 }, assignedWorkerIds: ["guard"] }] }
  }, {
    buildingEffectiveWorkers: () => ({ total: 8 })
  });
  assert.equal(dependencyGarrison.sources[0]?.baseEfficiency, 8, "battle garrisons must consume explicitly supplied worker efficiency");
  assert.equal(dependencyGarrison.dice, 2, "explicit worker efficiency must preserve garrison dice calculation");
  const dependencyMorale = massCombatSources.autoDefenderProfile({ people: { list: [] }, buildings: { list: [] }, gm: { defense: {} } }, {}, {
    calculateMorale: () => 31
  });
  assert.equal(dependencyMorale.morale, 2, "battle defender profile must consume explicitly supplied morale");
  const assignedCasualtyHolding = {
    people: { list: [{ id: "assigned", name: "Assigned", dead: false, injuredDays: 0 }] },
    buildings: { list: [{ assignedWorkerIds: ["assigned", "other"] }] },
    constructionCrews: [{ memberIds: ["assigned", "other"], leaderId: "assigned" }],
    gm: { defense: { commanderId: "assigned", squads: [{ memberIds: ["assigned", "other"], sergeantId: "assigned" }] } }
  };
  massCombatCasualties.applyBattleConditionToPerson(assignedCasualtyHolding, assignedCasualtyHolding.people.list[0], "injured", { days: 2 });
  assert.deepEqual(assignedCasualtyHolding.buildings.list[0].assignedWorkerIds, ["", "other"], "battle injury must clear building assignments through the data operation");
  assert.deepEqual(assignedCasualtyHolding.constructionCrews[0].memberIds, ["other"], "battle injury must clear construction crew membership");
  assert.equal(assignedCasualtyHolding.constructionCrews[0].leaderId, "", "battle injury must clear construction crew leadership");
  assert.deepEqual(assignedCasualtyHolding.gm.defense.squads[0].memberIds, ["", "other"], "battle injury must clear defense squad membership");
  assert.equal(assignedCasualtyHolding.gm.defense.squads[0].sergeantId, "", "battle injury must clear squad leadership");
  assert.equal(assignedCasualtyHolding.gm.defense.commanderId, "", "battle injury must clear defense command");
  const heavyDeathRandom = () => {
    const values = [0.1, 0.6, 0.1, 0.1, 0.5];
    let index = 0;
    return () => values[index++] ?? 0.1;
  };
  const casualtyBase = {
    people: {
      list: [
        { id: "soldier", name: "Soldier", workAssignment: "soldier", attributes: { strength: 3, agility: 3 }, dead: false, injuredDays: 0 },
        { id: "healer", name: "Healer", role: "Doctor", dead: false, injuredDays: 0 }
      ]
    },
    buildings: { list: [] }
  };
  const casualtyNoMedical = clone(casualtyBase);
  const casualtyNoMedicalState = { battleId: "battle-medical-check", round: 1 };
  const noMedicalResult = massCombatCasualties.applyDefenderResidentCasualties(casualtyNoMedical, casualtyNoMedicalState, 1, {}, { random: heavyDeathRandom() });
  assert.equal(casualtyNoMedical.people.list[0].dead, true, "an untreated heavy casualty can become a death");
  assert.equal(noMedicalResult.records[0]?.condition, "dead", "untreated death roll 3 must kill a heavy casualty");
  const casualtyWithMedical = clone(casualtyBase);
  casualtyWithMedical.buildings.list.push({ id: "hospital", name: "Лазарет", specialKind: "medical", constructionStatus: "built", assignedWorkerIds: ["healer"] });
  const casualtyWithMedicalState = { battleId: "battle-medical-check", round: 1 };
  const medicalResult = massCombatCasualties.applyDefenderResidentCasualties(casualtyWithMedical, casualtyWithMedicalState, 1, {}, { random: heavyDeathRandom() });
  assert.equal(casualtyWithMedical.people.list[0].dead, false, "a free medical bed must reduce death chance for a heavy casualty");
  assert.equal(medicalResult.records[0]?.condition, "heavy", "treated death roll 3 must remain a heavy injury");
  assert.equal(medicalResult.records[0]?.treated, true, "medical capacity must mark the casualty as treated");

  const partialMilitiaHolding = {
    people: {
      list: Array.from({ length: 5 }, (_, index) => ({ id: `civilian-${index + 1}`, name: `Civilian ${index + 1}`, ageGroup: "Adult", dead: false, injuredDays: 0 }))
    },
    buildings: { list: [] },
    gm: { defense: {} }
  };
  const partialMilitiaState = {
    ...massCombatState.resetMassCombatState(),
    defenseMode: "outside",
    useDefenseSquads: false,
    raiseMilitia: true,
    defenderHero: 0,
    defenderMorale: 0,
    defenderSpecial: 0
  };
  const partialMilitiaCalc = massCombatCalculator.calculateBattle(partialMilitiaHolding, partialMilitiaState);
  assert.equal(partialMilitiaCalc.defenderPool, 0, "incomplete militia must not add defender dice");
  assert.equal(partialMilitiaCalc.autoDefenders.militiaPartialIds.length, 5, "incomplete militia must still remember its participating residents");
  assert.equal(partialMilitiaCalc.defenderRiskSlots.some((slot) => slot.partial && slot.participantIds.length === 5), true, "incomplete militia must create a casualty risk slot");
  const partialMilitiaCasualties = massCombatCasualties.applyDefenderResidentCasualties(partialMilitiaHolding, { ...partialMilitiaState, battleId: "partial-militia", round: 1 }, 1, partialMilitiaCalc, { random: (() => {
    const values = [0.1, 0.1, 0.4, 0.1, 0.99];
    let index = 0;
    return () => values[index++] ?? 0.99;
  })() });
  assert.equal(partialMilitiaCasualties.records.length, 1, "incomplete militia must be able to suffer casualties from defender Impact");

  const garrisonMilitiaHolding = {
    people: {
      list: [
        { id: "civilian", name: "Civilian", ageGroup: "Adult", dead: false, injuredDays: 0 },
        { id: "soldier", name: "Soldier", ageGroup: "Adult", workAssignment: "soldier", role: "Soldier", attributes: { strength: 3, agility: 3 }, dead: false, injuredDays: 0 },
        { id: "garrison", name: "Garrison Worker", ageGroup: "Adult", attributes: { strength: 1, agility: 1 }, dead: false, injuredDays: 0 }
      ]
    },
    buildings: { list: [{ id: "watchtower", name: "Watchtower", constructionStatus: "built", functions: { defense: true }, defense: { workerStep: 20, maxDice: 1 }, assignedWorkerIds: ["garrison"] }] },
    gm: { defense: {} }
  };
  const garrisonMilitiaCalc = massCombatCalculator.calculateBattle(garrisonMilitiaHolding, partialMilitiaState);
  assert.deepEqual(garrisonMilitiaCalc.autoDefenders.militiaPartialIds, ["civilian"], "militia must exclude soldiers and residents assigned to garrison buildings");

  const roundedImpactUp = massCombatRound.roundConsequences(
    { defenderSuccesses: 0, attackerSuccesses: 1, margin: -1 },
    { lossModel: { attackerToDefender: 1.5, defenderToAttacker: 1, building: 0 }, attackerStrategy: { raid: true }, defenderStrategy: {} },
    {},
    { random: () => 0 }
  );
  const roundedImpactDown = massCombatRound.roundConsequences(
    { defenderSuccesses: 0, attackerSuccesses: 1, margin: -1 },
    { lossModel: { attackerToDefender: 1.5, defenderToAttacker: 1, building: 0 }, attackerStrategy: { raid: true }, defenderStrategy: {} },
    {},
    { random: () => 0.99 }
  );
  assert.equal(roundedImpactUp.defenderLossDelta, 2, "fractional impact rounding must be testable with an injected random source");
  assert.equal(roundedImpactDown.defenderLossDelta, 1, "fractional impact rounding must preserve the lower deterministic branch");

  const duplicateWorkerData = clone(schema.DEFAULT_SKYHOLD_DATA);
  const duplicateWorkerHolding = clone(schema.BASE_HOLDING);
  duplicateWorkerHolding.id = "duplicate-workers";
  duplicateWorkerHolding.people.list = [{ id: "worker", name: "Worker", workAssignment: "workshop", role: "Worker" }];
  duplicateWorkerHolding.buildings.list = [
    { id: "farm", name: "Farm", workersMin: 0, workersMax: 1, assignedWorkerIds: ["worker"] },
    { id: "workshop", name: "Workshop", workersMin: 0, workersMax: 1, assignedWorkerIds: ["worker"] }
  ];
  duplicateWorkerData.holdings = [duplicateWorkerHolding];
  const normalizedDuplicateWorkers = normalizers.migrateData(duplicateWorkerData);
  const normalizedWorkerBuildings = normalizedDuplicateWorkers.holdings[0].buildings.list;
  assert.deepEqual(
    normalizedWorkerBuildings.map((building) => building.assignedWorkerIds[0]),
    ["", "worker"],
    "normalization must keep a resident only in the building named by their work assignment"
  );
  assert.equal(
    normalizedWorkerBuildings.flatMap((building) => building.assignedWorkerIds).filter((id) => id === "worker").length,
    1,
    "a resident must never occupy worker slots in several buildings simultaneously"
  );

  const legacyMassCombatData = clone(schema.DEFAULT_SKYHOLD_DATA);
  legacyMassCombatData.holdings = [clone(schema.BASE_HOLDING)];
  legacyMassCombatData.meta.schemaVersion = normalizers.SKYHOLD_SCHEMA_VERSION - 1;
  delete legacyMassCombatData.holdings[0].gm.massCombat.attackerShooters;
  legacyMassCombatData.holdings[0].gm.massCombat.attackerFire = 2;
  legacyMassCombatData.holdings[0].gm.massCombat.attackerSourceTag1 = "sacred";
  legacyMassCombatData.holdings[0].gm.massCombat.attackerSourceEfficiency1 = 7.5;
  const migratedMassCombatData = normalizers.migrateData(legacyMassCombatData);
  assert.equal(migratedMassCombatData.holdings[0].gm.massCombat.attackerShooters, 2, "stored legacy mass-combat tags must migrate to canonical fields");
  assert.equal(Object.hasOwn(migratedMassCombatData.holdings[0].gm.massCombat, "attackerFire"), false, "stored legacy mass-combat tag fields must be removed after migration");
  assert.equal(migratedMassCombatData.holdings[0].gm.massCombat.attackerSourcePrimaryTag1, "sacred", "stored source types must migrate to explicit primary-tag fields");
  assert.equal(Object.hasOwn(migratedMassCombatData.holdings[0].gm.massCombat, "attackerSourceTag1"), false, "legacy source type fields must be removed after migration");
  assert.equal(migratedMassCombatData.holdings[0].gm.massCombat.attackerSourceEfficiency1, 7.5, "stored individual source efficiency must survive normalization");

  const mixedMassCombatData = clone(schema.DEFAULT_SKYHOLD_DATA);
  mixedMassCombatData.holdings = [clone(schema.BASE_HOLDING)];
  mixedMassCombatData.holdings[0].gm.massCombat.attackerShooters = 3;
  mixedMassCombatData.holdings[0].gm.massCombat.attackerFire = 2;
  const normalizedMixedMassCombatData = normalizers.migrateData(mixedMassCombatData);
  assert.equal(normalizedMixedMassCombatData.holdings[0].gm.massCombat.attackerShooters, 3, "stored canonical tag values must not be overwritten by legacy values");
  assert.equal(Object.hasOwn(normalizedMixedMassCombatData.holdings[0].gm.massCombat, "attackerFire"), false, "redundant legacy tag fields must be removed from current data");

  const holdingWithStaleBattleState = {
    gm: {
      massCombat: {
        ...massCombatState.resetMassCombatState(),
        attackerSourceTag1: "shooters",
        attackerCustomOne: 4,
        legacyUnknownField: "stale",
        battleId: "old-battle",
        casualtyLog: [{ id: "cas-1" }],
        buildingDamageLog: [{ id: "bd-1" }],
        log: [{ id: "round-1" }]
      }
    }
  };
  const originalUpdateHolding = holdingServiceModule.HoldingService.updateHolding;
  holdingServiceModule.HoldingService.updateHolding = async (_holdingId, updater) => updater(holdingWithStaleBattleState);
  try {
    const replacement = massCombatState.resetMassCombatState();
    const replacedState = await holdingServiceModule.HoldingService.replaceMassCombatState("test-holding", replacement);
    assert.deepEqual(replacedState, replacement, "mass-combat reset must replace the whole state");
    assert.equal(Object.hasOwn(replacedState, "attackerSourceTag1"), false, "mass-combat reset must remove per-source tag overrides");
    assert.equal(Object.hasOwn(replacedState, "attackerCustomOne"), false, "mass-combat reset must remove stale custom fields");
    assert.equal(Object.hasOwn(replacedState, "legacyUnknownField"), false, "mass-combat reset must remove unknown legacy fields");
    assert.notEqual(replacedState, replacement, "mass-combat replacement must clone the supplied state");
  } finally {
    holdingServiceModule.HoldingService.updateHolding = originalUpdateHolding;
  }
  const originalSkyholdSet = store.SkyholdData.set;
  const originalSkyholdView = store.SkyholdData.view;
  let resetPayload = null;
  let resetOptions = null;
  store.SkyholdData.view = () => ({ meta: { revision: 37 } });
  store.SkyholdData.set = async (data, options) => {
    resetPayload = data;
    resetOptions = options;
    return data;
  };
  try {
    await store.SkyholdData.reset();
  } finally {
    store.SkyholdData.set = originalSkyholdSet;
    store.SkyholdData.view = originalSkyholdView;
  }
  assertJsonEqual(resetPayload, canonicalDefault, "SkyholdData.reset must restore the canonical default root");
  assert.notEqual(resetPayload, canonicalDefault, "SkyholdData.reset must pass an independent default root clone");
  assert.notEqual(resetPayload.holdings, canonicalDefault.holdings, "SkyholdData.reset must clone nested holdings");
  assert.equal(resetOptions.baseRevision, 37, "reset must retain the revision guard against concurrent GM writes");

  assert.equal(dataBarrel.SkyholdData, store.SkyholdData, "data barrel must re-export SkyholdData");
  assert.equal(dataBarrel.DEFAULT_SKYHOLD_DATA, canonicalDefault, "data barrel must preserve default data export");
  assert.equal(typeof dataBarrel.validatePlayerPatch, "function", "data barrel must expose player write guard helpers");
  assert.equal(typeof dataBarrel.createSkyholdSplitStorage, "function", "data barrel must expose split storage helpers");
  assert.equal(typeof dataBarrel.createSkyholdSocketApi, "function", "data barrel must expose socket helpers");
  assert.equal(typeof dataBarrel.importLaputaHolding, "function", "data barrel must expose Laputa import helper");
  const queue = dataBarrel.createWriteQueue();
  const writeOrder = [];
  await assert.rejects(
    queue(async () => {
      writeOrder.push("failed");
      throw new Error("expected write failure");
    }),
    /expected write failure/,
    "write queue must surface operation failures"
  );
  await queue(async () => {
    writeOrder.push("next");
  });
  assert.deepEqual(writeOrder, ["failed", "next"], "write queue must continue after a failed operation");
  assert.equal(formula.evaluateArithmeticExpression("2 + 3 * (4 - 1)"), 11, "formula evaluator must respect arithmetic precedence");
  assert.equal(formula.evaluateArithmeticExpression("-2 + 6 / 3"), 0, "formula evaluator must support unary minus and division");
  assert.equal(formula.rollInlineDice("1d6 + 2d4", () => 0.5), "3 + 4", "inline dice roller must replace dice expressions deterministically when injected");

  const previousAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  try {
    const renderCalls = [];
    const app = {
      async render(options) {
        renderCalls.push(options);
        if (renderCalls.length === 1) renderScheduler.requestApplicationRender(app, { marker: "during-render", focus: true });
        return app;
      }
    };
    const renderResult = await renderScheduler.requestApplicationRender(app, { marker: "initial" });
    assert.equal(renderResult, app, "queued render must resolve with the last render result");
    assert.equal(renderCalls.length, 2, "render scheduler must flush requests queued during render");
    assert.equal(renderCalls[0].marker, "initial", "render scheduler must keep the first queued options");
    assert.equal(renderCalls[1].marker, "during-render", "render scheduler must apply options queued during render");
    assert.equal(renderCalls[1].focus, true, "render scheduler must preserve queued option overrides");

    const quietRenderCalls = [];
    const quietApp = {
      async render(options) {
        quietRenderCalls.push(options);
        return quietApp;
      }
    };
    const quietPromise = renderScheduler.requestApplicationRender(quietApp, { marker: "focus-request", focus: true });
    renderScheduler.requestApplicationRender(quietApp, { marker: "quiet-update" });
    await quietPromise;
    assert.equal(quietRenderCalls.length, 1, "render scheduler must merge pre-flush render requests");
    assert.equal(quietRenderCalls[0].marker, "quiet-update", "latest pre-flush render request must win");
    assert.equal(quietRenderCalls[0].focus, false, "quiet render requests must not inherit a previous focus:true");
  } finally {
    if (previousAnimationFrame) globalThis.requestAnimationFrame = previousAnimationFrame;
    else delete globalThis.requestAnimationFrame;
  }

  const medicalData = clone(schema.DEFAULT_SKYHOLD_DATA);
  medicalData.holdings = [clone(schema.BASE_HOLDING)];
  medicalData.holdings[0].id = "test-holding";
  medicalData.holdings[0].buildings.list = [{
    id: "med-1",
    name: "Лазарет со складом",
    type: "Лечебное",
    workersMin: 2,
    workersMax: 8,
    functions: { production: false, income: false, defense: false, housing: false, storage: true, culture: false },
    storage: { capacity: 10 }
  }];
  const softMedical = normalizers.migrateData(medicalData);
  const softBuilding = softMedical.holdings[0].buildings.list[0];
  assert.equal(softBuilding.functions.storage, true, "load normalization must not erase custom medical storage flag");
  assert.equal(softBuilding.workersMax, 8, "load normalization must not clamp custom medical worker max");

  const repairedMedical = normalizers.repairSkyholdData(medicalData);
  const repairedBuilding = repairedMedical.holdings[0].buildings.list[0];
  assert.equal(repairedBuilding.functions.storage, false, "repair mode may restore curated medical function flags");

  const religiousCustomData = clone(schema.DEFAULT_SKYHOLD_DATA);
  religiousCustomData.holdings = [clone(schema.BASE_HOLDING)];
  religiousCustomData.holdings[0].id = "religion-test";
  religiousCustomData.holdings[0].buildings.list = [{
    id: "well-1",
    name: "Колодец",
    type: "Инфраструктура",
    functions: { production: false, income: false, defense: false, housing: false, storage: false, culture: false },
    religion: { religious: true, faith: "local-cult", customFaith: "", notes: "" }
  }];
  const religiousNormalized = normalizers.migrateData(religiousCustomData);
  assert.equal(religiousNormalized.holdings[0].buildings.list[0].functions.culture, false, "explicit culture=false must not be restored by religion.religious");

  const seasonData = clone(schema.DEFAULT_SKYHOLD_DATA);
  seasonData.holdings = [clone(schema.BASE_HOLDING)];
  seasonData.holdings[0].id = "season-test";
  seasonData.holdings[0].buildings.list = [{
    id: "woodcutters",
    name: "Рубка дров",
    type: "Производственное",
    functions: { production: true },
    productionLines: [{
      id: "line-1",
      active: true,
      source: "workers",
      resourceId: "wood",
      outputQty: 2,
      workQd: 1,
      seasons: { spring: true, summer: false, autumn: true, winter: false }
    }]
  }];
  const seasonNormalized = normalizers.migrateData(seasonData);
  assert.deepEqual(seasonNormalized.holdings[0].buildings.list[0].productionLines[0].seasons, { spring: true, summer: false, autumn: true, winter: false }, "production line seasons must survive normalization");

  const currentFireplaceData = clone(schema.DEFAULT_SKYHOLD_DATA);
  currentFireplaceData.meta.schemaVersion = normalizers.SKYHOLD_SCHEMA_VERSION;
  currentFireplaceData.holdings = [clone(schema.BASE_HOLDING)];
  currentFireplaceData.holdings[0].id = "current-fireplace-test";
  currentFireplaceData.holdings[0].buildings.list = [{
    id: "custom-fireplace",
    name: "\u041a\u0430\u043c\u0438\u043d",
    type: "\u0418\u043d\u0442\u0435\u0440\u044c\u0435\u0440",
    workersMax: 1
  }];
  const currentFireplaceNormalized = normalizers.migrateData(currentFireplaceData);
  assert.equal(currentFireplaceNormalized.holdings[0].buildings.list.length, 1, "current schema must not delete a custom fireplace-like building on load");

  const legacyFireplaceData = clone(currentFireplaceData);
  legacyFireplaceData.meta.schemaVersion = 45;
  legacyFireplaceData.holdings[0].buildings.list = [
    { id: "fireplace", templateId: "fireplace", name: "\u041a\u0430\u043c\u0438\u043d", type: "\u0421\u0442\u0430\u0440\u044b\u0439 \u0448\u0430\u0431\u043b\u043e\u043d" },
    { id: "legacy-hall", name: "\u0417\u0430\u043b", type: "\u041e\u0431\u0449\u0435\u0435", requiredBuildingIds: ["fireplace", "other-building"] }
  ];
  const legacyFireplaceNormalized = normalizers.migrateData(legacyFireplaceData);
  assert.equal(legacyFireplaceNormalized.holdings[0].buildings.list.some((building) => building.id === "fireplace"), false, "old schema must remove deprecated fireplace template rows");
  assert.deepEqual(legacyFireplaceNormalized.holdings[0].buildings.list.find((building) => building.id === "legacy-hall").requiredBuildingIds, ["other-building"], "old schema must remove deprecated fireplace prerequisites");

  const current = normalizers.migrateData(clone(schema.DEFAULT_SKYHOLD_DATA));
  current.holdings[0].gm.playersCanUseStorage = true;
  current.holdings[0].gm.playersCanEditOverview = true;
  const mixedPatch = {
    baseRevision: current.meta.revision,
    action: "mixed",
    changes: [
      { path: "holdings.0.overview.description", value: "Игрок поправил описание" },
      { path: "holdings.0.storage.notes", value: "Игрок поправил склад" }
    ]
  };
  assert.equal(guard.validatePlayerPatch(current, mixedPatch, "player-1").ok, false, "mixed player patches must be rejected");

  const staleBase = clone(current);
  const staleProposal = clone(staleBase);
  staleProposal.holdings[0].overview.description = "Player overview edit";
  const stalePatch = guard.buildPlayerPatch(staleBase, staleProposal);
  assert.equal(stalePatch.changes[0]?.oldValue, staleBase.holdings[0].overview.description, "player patches must include oldValue for conflict checks");
  const unrelatedGmCurrent = clone(staleBase);
  unrelatedGmCurrent.meta.revision = staleBase.meta.revision + 1;
  unrelatedGmCurrent.holdings[0].storage.notes = "GM changed storage notes";
  assert.equal(guard.validatePlayerPatch(unrelatedGmCurrent, stalePatch, "player-1").ok, true, "stale player patches may apply when edited paths still match their old values");
  const conflictingGmCurrent = clone(staleBase);
  conflictingGmCurrent.meta.revision = staleBase.meta.revision + 1;
  conflictingGmCurrent.holdings[0].overview.description = "GM changed the same field";
  assert.equal(guard.validatePlayerPatch(conflictingGmCurrent, stalePatch, "player-1").ok, false, "stale player patches must reject changed paths with mismatched old values");

  current.holdings[0].gm.playersCanEditBuildings = true;
  current.holdings[0].buildings.list = [{
    id: "b1",
    templateId: "",
    name: "Палисад",
    type: "Оборона",
    productionLines: [{ id: "line-1", active: true, source: "workers", resourceId: "wood", outputQty: 1, workQd: 1 }],
    storage: { capacity: 0 }
  }];
  current.holdings[0].people.list = [{
    id: "worker-contract",
    name: "Работник",
    workAssignment: "",
    role: "Свободен",
    wageDailyOverrideCopper: null,
    volunteerLabor: false,
    volunteerReason: "",
    maintenancePointsPerTenday: 0
  }];
  const workerAssignmentProposal = clone(current);
  workerAssignmentProposal.holdings[0].people.list[0].workAssignment = "b1";
  workerAssignmentProposal.holdings[0].people.list[0].role = "Работает в здании";
  const workerAssignmentPatch = guard.buildPlayerPatch(current, workerAssignmentProposal);
  assert.equal(guard.validatePlayerPatch(current, workerAssignmentPatch, "player-1").ok, false, "legacy worker assignments require a dedicated authority command and cannot be forged as a generic patch");

  for (const [field, value] of [
    ["wageDailyOverrideCopper", 7],
    ["volunteerLabor", true],
    ["volunteerReason", "Бесплатно"],
    ["maintenancePointsPerTenday", 2]
  ]) {
    const forgedWorkerTerms = clone(workerAssignmentProposal);
    forgedWorkerTerms.holdings[0].people.list[0][field] = value;
    assert.equal(
      guard.validatePlayerPatch(current, guard.buildPlayerPatch(current, forgedWorkerTerms), "player-1").ok,
      false,
      `generic player patches must not change resident finance calibration: ${field}`
    );
  }

  for (const [path, value] of [
    ["effect", "+999 к эффективности"],
    ["notes", "salary 0"],
    ["income.base", 9999],
    ["productionLines.0.outputQty", 9999],
    ["materialCosts", []],
    ["bonuses.food", 999],
    ["baseUpkeepMonthlyCopper", 0],
    ["operatingUpkeepMonthlyCopper", 0],
    ["storage.capacity", 9999]
  ]) {
    const forgedBuilding = clone(current);
    const parts = path.split(".");
    let target = forgedBuilding.holdings[0].buildings.list[0];
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== "object") target[part] = {};
      target = target[part];
    }
    target[parts.at(-1)] = value;
    assert.equal(
      guard.validatePlayerPatch(current, guard.buildPlayerPatch(current, forgedBuilding), "player-1").ok,
      false,
      `generic player patches must not change building economy or calibration fields: ${path}`
    );
  }
  const buildingIdPatch = {
    baseRevision: current.meta.revision,
    action: "buildings",
    changes: [{ path: "holdings.0.buildings.list.0.id", value: "changed" }]
  };
  assert.equal(guard.validatePlayerPatch(current, buildingIdPatch, "player-1").ok, false, "players must not rewrite building ids");

  const wholeBuildingListReplacementPatch = {
    baseRevision: current.meta.revision,
    action: "buildings",
    changes: [{ path: "holdings.0.buildings.list", value: [{ id: "changed", templateId: "", name: "Палисад", type: "Оборона" }] }]
  };
  assert.equal(guard.validatePlayerPatch(current, wholeBuildingListReplacementPatch, "player-1").ok, false, "players must not replace existing building rows through a whole-array patch");

  current.catalog.buildings = [{ id: "secret-template", name: "Скрытый бастион", visibility: "gm", requirements: { food: 0, technology: 0, culture: 0, war: 0 } }];
  const hiddenTemplatePatch = {
    baseRevision: current.meta.revision,
    action: "buildings",
    changes: [{
      path: "holdings.0.buildings.list",
      value: [{ id: "b2", templateId: "secret-template", name: "Скрытый бастион", type: "Оборона" }]
    }]
  };
  assert.equal(guard.validatePlayerPatch(current, hiddenTemplatePatch, "player-1").ok, false, "players must not create buildings from hidden templates");

  current.catalog.buildings = [{ id: "public-template", name: "Амбар", visibility: "public", requirements: { food: 0, technology: 0, culture: 0, war: 0 } }];
  const publicTemplatePatch = {
    baseRevision: current.meta.revision,
    action: "buildings",
    changes: [{
      path: "holdings.0.buildings.list",
      value: [...current.holdings[0].buildings.list, { id: "b2", templateId: "public-template", name: "Амбар", type: "Склад" }]
    }]
  };
  assert.equal(guard.validatePlayerPatch(current, publicTemplatePatch, "player-1").ok, false, "players must create even public-template buildings through a dedicated authority operation, not a whole-array patch");

  current.holdings[0].storage.resources = [{ id: "res1", resourceId: "wood", name: "Древесина", qty: 5 }];
  current.holdings[0].storage.log = [{ id: "log1", kind: "manual-add", resourceId: "wood", name: "Древесина", qty: 5 }];
  const negativeStoragePatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [{ path: "holdings.0.storage.resources.0.qty", value: -999 }]
  };
  assert.equal(guard.validatePlayerPatch(current, negativeStoragePatch, "player-1").ok, false, "players must not make storage quantities negative");

  const clearLogPatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [{ path: "holdings.0.storage.log", value: [] }]
  };
  assert.equal(guard.validatePlayerPatch(current, clearLogPatch, "player-1").ok, false, "players must not clear storage log");

  const rewriteLogPatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [{ path: "holdings.0.storage.log.0.note", value: "подмена" }]
  };
  assert.equal(guard.validatePlayerPatch(current, rewriteLogPatch, "player-1").ok, false, "players must not rewrite existing storage log entries");

  const appendLogPatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [
      { path: "holdings.0.storage.resources.0.qty", value: 4 },
      { path: "holdings.0.storage.log", value: [...current.holdings[0].storage.log, { id: "log2", kind: "manual-spend", resourceId: "wood", name: "Древесина", qty: -1 }] }
    ]
  };
  assert.equal(guard.validatePlayerPatch(current, appendLogPatch, "player-1").ok, false, "players must use dedicated authority operations for resource and storage-log mutations");

  const moneyPatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [{ path: "holdings.0.storage.moneyCopper", value: 999999 }]
  };
  assert.equal(guard.validatePlayerPatch(current, moneyPatch, "player-1").ok, false, "generic player patches must not change treasury money");

  current.holdings[0].storage.items = [{ id: "stored-item", name: "Меч", qty: 1 }];
  const itemPatch = {
    baseRevision: current.meta.revision,
    action: "storage",
    changes: [{ path: "holdings.0.storage.items.0.qty", value: 2 }]
  };
  assert.equal(guard.validatePlayerPatch(current, itemPatch, "player-1").ok, false, "generic player patches must not change stored items");

  current.holdings[0].gm.playersCanEditResidents = true;
  for (const [field, value] of [
    ["dead", true],
    ["injuredDays", 0],
    ["deathDate", "сегодня"],
    ["salary", 9999],
    ["salaryModifier", 9999],
    ["wageDailyOverrideCopper", 0],
    ["maintenancePointsPerTenday", 999]
  ]) {
    const residentPatch = {
      baseRevision: current.meta.revision,
      action: "residents",
      changes: [{ path: `holdings.0.people.list.0.${field}`, value }]
    };
    assert.equal(
      guard.validatePlayerPatch(current, residentPatch, "player-1").ok,
      false,
      `generic player patches must not change resident death, injury, finance, or generated fields: ${field}`
    );
  }

  const unsafePathPatch = {
    baseRevision: current.meta.revision,
    action: "buildings",
    changes: [{ path: "holdings.0.buildings.list.0.__proto__.polluted", value: true }]
  };
  assert.equal(guard.validatePlayerPatch(current, unsafePathPatch, "player-1").ok, false, "player patches must reject unsafe object path segments");

  const split = {
    meta: { revision: 7 },
    holdings: [{ id: "h1", name: "Тест" }],
    catalog: { buildings: [], resources: [] }
  };
  split.meta = store.makeStorageCommitMeta(split.meta, {
    writeId: "commit-test",
    previousRevision: 6,
    holdings: split.holdings,
    catalog: split.catalog,
    complete: true,
    now: "2026-06-08T00:00:00.000Z"
  });
  assert.equal(store.inspectStorageCommit(split).ok, true, "complete storage commit must validate");

  const incomplete = clone(split);
  incomplete.meta = store.makeStorageCommitMeta({ revision: 8 }, {
    writeId: "commit-broken",
    previousRevision: 7,
    holdings: split.holdings,
    catalog: split.catalog,
    complete: false,
    now: "2026-06-08T00:00:00.000Z"
  });
  assert.equal(store.inspectStorageCommit(incomplete).ok, false, "incomplete storage commit must fail validation");

  const tampered = clone(split);
  tampered.holdings[0].name = "Подменено";
  assert.equal(store.inspectStorageCommit(tampered).ok, false, "storage commit hash mismatch must fail validation");

  const legacy = normalizers.migrateData({
    meta: { revision: 2 },
    overview: { settlementName: "Старый остров", week: 4, description: "legacy" },
    residents: { groups: [{ id: "old-resident", name: "Старик", count: 3, type: "Жители", status: "Работают" }] },
    storage: { resources: [], items: [], log: [] }
  });
  assert.equal(legacy.holdings[0].id, "legacy-skyhold", "legacy settlement must migrate into a holding");
  assert.equal(legacy.holdings[0].name, "Старый остров", "legacy settlement name must be preserved");
  assert.equal(legacy.holdings[0].overview.population, 3, "legacy resident count must become population");

  const cssAudit = checkCssHygiene(cssFiles);

  console.log(`FBL Skyhold repository contracts: ${jsFiles.length} JS files checked; ${hbsFiles.length} HBS files checked; ${cssAudit.totalFiles} CSS files checked; ${cssAudit.totalImportant} !important total. Largest CSS files: ${cssAudit.largest.join(", ")}. Repository contracts passed.`);
}
