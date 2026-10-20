import assert from "node:assert/strict";

const DEVELOPMENT_KEYS = ["food", "technology", "culture", "war"];
const FUNCTION_KEYS = ["production", "income", "defense", "housing", "storage", "culture"];
const PRODUCTION_SOURCES = new Set(["workers", "time", "content"]);
const PRODUCTION_PERIODS = new Set(["qd", "day", "tenday"]);
const EXPENSE_MODES = new Set(["cycle", "unit"]);
const AUTO_COLLECT_MODES = new Set(["none", "building", "worker"]);
const CONSTRUCTION_STATUSES = new Set(["planned", "building", "paused", "damaged", "heavilyDamaged", "destroyed", "built"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function templateLabel(entry) {
  const id = String(entry?.template?.id ?? "").trim() || "<missing-id>";
  return `${entry?.file ?? "scripts/data/building-templates.js"} template "${id}"`;
}

function assertTemplate(value, entry, message) {
  assert.ok(value, `${templateLabel(entry)}: ${message}`);
}

function assertExactKeys(value, expectedKeys, entry, field) {
  assertTemplate(isRecord(value), entry, `${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  assert.deepEqual(actual, expected, `${templateLabel(entry)}: ${field} must contain exactly ${expected.join(", ")}`);
}

function assertUniqueRows(rows, entry, field) {
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    assertTemplate(id, entry, `${field} row is missing id`);
    assertTemplate(ID_PATTERN.test(id), entry, `${field} row has invalid id "${id}"`);
    assertTemplate(!seen.has(id), entry, `${field} contains duplicate id "${id}"`);
    seen.add(id);
  }
}

function assertFiniteNumber(value, entry, field, { min = null } = {}) {
  assertTemplate(Number.isFinite(value), entry, `${field} must be a finite number`);
  if (min !== null) assertTemplate(value >= min, entry, `${field} must be at least ${min}`);
}

function assertKnownResource(resourceId, entry, field, resourceById, capability) {
  const id = String(resourceId ?? "").trim();
  assertTemplate(id, entry, `${field} is missing resourceId`);
  if (id.startsWith("group:")) {
    const categoryTag = id.slice("group:".length);
    const candidates = [...resourceById.values()].filter((resource) => String(resource?.categoryTag ?? "") === categoryTag);
    assertTemplate(candidates.length > 0, entry, `${field} references unknown resource category "${categoryTag}"`);
    if (capability) assertTemplate(candidates.some((resource) => resource[capability] !== false), entry, `${field} category "${categoryTag}" has no resource enabled for this use`);
    return;
  }
  const resource = resourceById.get(id);
  assertTemplate(resource, entry, `${field} references unknown resourceId "${id}"`);
  if (capability) assertTemplate(resource[capability] !== false, entry, `${field} references resource "${id}" disabled for this use`);
}

function checkRawTemplate(entry, resourceById) {
  const template = entry.template;
  assertTemplate(isRecord(template), entry, "catalog row must be an object");

  const id = String(template?.id ?? "").trim();
  assertTemplate(id, entry, "id is required");
  assertTemplate(ID_PATTERN.test(id), entry, `id "${id}" must use lowercase latin letters, digits, and hyphens`);
  assertTemplate(String(template.name ?? "").trim(), entry, "name is required");
  assertTemplate(String(template.type ?? "").trim(), entry, "type/category is required");
  assertTemplate(DEVELOPMENT_KEYS.includes(String(template.primaryDev ?? "")), entry, `primaryDev must be one of ${DEVELOPMENT_KEYS.join(", ")}`);
  for (const field of ["workerPrimaryAttribute", "primaryWorkerAttribute", "suitableWorkerTypes", "workerTypeEffects", "workerTypes"]) {
    assertTemplate(!Object.hasOwn(template, field), entry, `legacy worker field ${field} must be removed from the source catalog`);
  }

  assertExactKeys(template.functions, FUNCTION_KEYS, entry, "functions");
  for (const key of FUNCTION_KEYS) assertTemplate(typeof template.functions[key] === "boolean", entry, `functions.${key} must be boolean`);

  if (template.materialCosts !== undefined) {
    assertTemplate(Array.isArray(template.materialCosts), entry, "materialCosts must be an array");
    assertUniqueRows(template.materialCosts, entry, "materialCosts");
    for (const cost of template.materialCosts) {
      assertTemplate(String(cost?.name ?? "").trim(), entry, `materialCosts "${cost?.id}" is missing name`);
      assertFiniteNumber(cost?.qty, entry, `materialCosts "${cost?.id}".qty`, { min: 0 });
      if (String(cost?.resourceId ?? "").trim()) {
        assertKnownResource(cost.resourceId, entry, `materialCosts "${cost.id}"`, resourceById, "useInConstruction");
      }
    }
  }

  if (template.productionLines !== undefined) {
    assertTemplate(Array.isArray(template.productionLines), entry, "productionLines must be an array");
    assertUniqueRows(template.productionLines, entry, "productionLines");
    for (const line of template.productionLines) {
      assertKnownResource(line?.resourceId, entry, `productionLines "${line?.id}"`, resourceById, "useInProduction");
    }
  }
}

function checkNormalizedTemplate(entry, resourceById, templateIds, parseResourceCosts, catalogVersion) {
  const template = entry.template;
  assertTemplate(template.templateVersion === catalogVersion, entry, `templateVersion must equal catalog version ${catalogVersion}`);
  assertTemplate(["public", "gm"].includes(template.visibility), entry, "visibility must be public or gm");
  assertTemplate(CONSTRUCTION_STATUSES.has(template.constructionStatus), entry, `unknown constructionStatus "${template.constructionStatus}"`);
  for (const field of ["workerPrimaryAttribute", "primaryWorkerAttribute", "suitableWorkerTypes", "workerTypeEffects", "workerTypes"]) {
    assertTemplate(!Object.hasOwn(template, field), entry, `legacy worker field ${field} must not survive normalization`);
  }
  assertTemplate(isRecord(template.workerProfile), entry, "approved workerProfile is required");
  assertTemplate(template.workerProfile.templateId === template.id, entry, "workerProfile.templateId must match the template id");

  assertExactKeys(template.functions, FUNCTION_KEYS, entry, "normalized functions");
  for (const key of FUNCTION_KEYS) assertTemplate(typeof template.functions[key] === "boolean", entry, `normalized functions.${key} must be boolean`);
  for (const group of ["requirements", "bonuses"]) {
    assertExactKeys(template[group], DEVELOPMENT_KEYS, entry, group);
    for (const key of DEVELOPMENT_KEYS) assertFiniteNumber(template[group][key], entry, `${group}.${key}`);
  }

  assertFiniteNumber(template.workersMin, entry, "workersMin", { min: 0 });
  assertFiniteNumber(template.workersMax, entry, "workersMax", { min: template.workersMin });
  assertTemplate(template.workerProfile.workersMin === template.workersMin, entry, "workerProfile.workersMin must match workersMin");
  assertTemplate(template.workerProfile.workersMax === template.workersMax, entry, "workerProfile.workersMax must match workersMax");

  assertTemplate(Array.isArray(template.materialCosts), entry, "normalized materialCosts must be an array");
  assertUniqueRows(template.materialCosts, entry, "normalized materialCosts");
  for (const cost of template.materialCosts) {
    assertTemplate(String(cost.name ?? "").trim(), entry, `materialCosts "${cost.id}" is missing name`);
    assertFiniteNumber(cost.qty, entry, `materialCosts "${cost.id}".qty`, { min: 0 });
    assertKnownResource(cost.resourceId, entry, `materialCosts "${cost.id}"`, resourceById, "useInConstruction");
  }

  assertTemplate(Array.isArray(template.productionLines), entry, "normalized productionLines must be an array");
  assertUniqueRows(template.productionLines, entry, "normalized productionLines");
  for (const line of template.productionLines) {
    const field = `productionLines "${line.id}"`;
    assertTemplate(typeof line.active === "boolean", entry, `${field}.active must be boolean`);
    assertTemplate(PRODUCTION_SOURCES.has(line.source), entry, `${field} has unknown source "${line.source}"`);
    assertTemplate(PRODUCTION_PERIODS.has(line.period), entry, `${field} has unknown period "${line.period}"`);
    assertTemplate(EXPENSE_MODES.has(line.expenseMode), entry, `${field} has unknown expenseMode "${line.expenseMode}"`);
    assertTemplate(AUTO_COLLECT_MODES.has(line.autoCollect), entry, `${field} has unknown autoCollect "${line.autoCollect}"`);
    assertKnownResource(line.resourceId, entry, field, resourceById, "useInProduction");
    assertFiniteNumber(line.outputQty, entry, `${field}.outputQty`, { min: 0 });
    assertFiniteNumber(line.workQd, entry, `${field}.workQd`, { min: 1 });
    assertFiniteNumber(line.collectQd, entry, `${field}.collectQd`, { min: 0 });
    assertFiniteNumber(line.pendingQty, entry, `${field}.pendingQty`, { min: 0 });
    if (line.source === "content") assertTemplate(String(line.contentId ?? "").trim(), entry, `${field} with source=content requires contentId`);

    const expenses = String(line.expenses ?? "").trim();
    if (expenses) {
      const costs = parseResourceCosts(expenses);
      assertTemplate(costs.length > 0, entry, `${field}.expenses could not be parsed`);
      for (const cost of costs) assertKnownResource(cost.resourceId, entry, `${field}.expenses`, resourceById, "useInProduction");
    }
  }

  for (const field of ["requiredBuildingIds", "requiredAnyBuildingIds"]) {
    assertTemplate(Array.isArray(template[field]), entry, `${field} must be an array`);
    const requirements = new Set();
    for (const requiredId of template[field]) {
      const id = String(requiredId ?? "").trim();
      assertTemplate(id, entry, `${field} contains an empty id`);
      assertTemplate(id !== template.id, entry, "template cannot require itself");
      assertTemplate(!requirements.has(id), entry, `${field} contains duplicate "${id}"`);
      assertTemplate(templateIds.has(id), entry, `${field} references missing template "${id}"`);
      requirements.add(id);
    }
  }
}

export function checkBuildingTemplateCatalog({
  sources,
  templateOrder,
  defaultTemplates,
  catalogVersion,
  deprecatedIds,
  normalizedTemplates,
  builtinResources,
  parseResourceCosts,
  migrateData,
  defaultData
}) {
  assert.ok(Array.isArray(sources) && sources.length, "building catalog validation requires source arrays");
  assert.ok(Array.isArray(templateOrder), "scripts/data/building-templates.js: TEMPLATE_ORDER must be an array");
  assert.ok(Array.isArray(defaultTemplates), "scripts/data/building-templates.js: DEFAULT_BUILDING_TEMPLATES must be an array");
  assert.ok(Array.isArray(normalizedTemplates), "normalized building catalog must be an array");

  const resourceById = new Map();
  for (const resource of builtinResources ?? []) {
    const id = String(resource?.id ?? "").trim();
    assert.ok(id, "scripts/core/resources.js: builtin resource is missing id");
    assert.ok(!resourceById.has(id), `scripts/core/resources.js: duplicate builtin resource id "${id}"`);
    resourceById.set(id, resource);
  }

  const entries = [];
  for (const source of sources) {
    assert.ok(Array.isArray(source.templates), `${source.file}: building template export must be an array`);
    for (const template of source.templates) entries.push({ file: source.file, template });
  }

  const sourceById = new Map();
  for (const entry of entries) {
    checkRawTemplate(entry, resourceById);
    const id = String(entry.template.id);
    const previous = sourceById.get(id);
    assert.ok(!previous, `${templateLabel(entry)}: duplicate top-level id; first declared in ${previous?.file ?? "another catalog file"}`);
    sourceById.set(id, entry);
  }

  const orderIds = new Set();
  for (const rawId of templateOrder) {
    const id = String(rawId ?? "").trim();
    assert.ok(id && ID_PATTERN.test(id), `scripts/data/building-templates.js: TEMPLATE_ORDER contains invalid id "${id}"`);
    assert.ok(!orderIds.has(id), `scripts/data/building-templates.js: TEMPLATE_ORDER contains duplicate "${id}"`);
    assert.ok(sourceById.has(id), `scripts/data/building-templates.js: TEMPLATE_ORDER references missing template "${id}"`);
    orderIds.add(id);
  }
  for (const [id, entry] of sourceById) {
    assert.ok(orderIds.has(id), `${templateLabel(entry)}: template is missing from TEMPLATE_ORDER`);
  }

  assert.deepEqual(
    defaultTemplates.map((template) => String(template?.id ?? "")),
    templateOrder,
    "scripts/data/building-templates.js: DEFAULT_BUILDING_TEMPLATES must exactly follow TEMPLATE_ORDER without missing rows"
  );
  for (const template of defaultTemplates) {
    const source = sourceById.get(String(template?.id ?? ""))?.template;
    assert.notEqual(
      template,
      source,
      `scripts/data/building-templates.js: default template "${template?.id}" must not reuse the mutable catalog object`
    );
  }
  assert.deepEqual(
    normalizedTemplates.map((template) => String(template?.id ?? "")),
    templateOrder,
    "normalized building catalog must exactly follow TEMPLATE_ORDER"
  );

  const templateIds = new Set(templateOrder);
  for (const template of normalizedTemplates) {
    const source = sourceById.get(String(template?.id ?? ""));
    checkNormalizedTemplate({ file: source?.file, template }, resourceById, templateIds, parseResourceCosts, catalogVersion);
  }

  assert.ok(deprecatedIds instanceof Set, "scripts/data/building-templates.js: DEPRECATED_TEMPLATE_IDS must be a Set");
  for (const deprecatedId of deprecatedIds) {
    assert.ok(ID_PATTERN.test(deprecatedId), `scripts/data/building-templates.js: invalid deprecated template id "${deprecatedId}"`);
  }

  const staleDeprecatedIds = [...deprecatedIds].filter((id) => !templateIds.has(id));
  const migrationProbe = JSON.parse(JSON.stringify(defaultData));
  migrationProbe.catalog.buildings.push(...staleDeprecatedIds.map((id) => ({
    id,
    name: `Deprecated ${id}`,
    type: "Deprecated",
    primaryDev: "technology",
    functions: Object.fromEntries(FUNCTION_KEYS.map((key) => [key, false]))
  })));
  const migratedProbe = migrateData(migrationProbe);
  const migratedIds = new Set(migratedProbe.catalog.buildings.map((template) => template.id));
  for (const id of staleDeprecatedIds) {
    assert.ok(migratedIds.has(id), `scripts/data/building-templates.js: ordinary loading must preserve deprecated template "${id}" until an explicit operation`);
  }
  const repairedProbe = migrateData(migrationProbe, { mode: "repair", destructive: true });
  const repairedIds = new Set(repairedProbe.catalog.buildings.map((template) => template.id));
  for (const id of staleDeprecatedIds) {
    assert.ok(!repairedIds.has(id), `scripts/data/building-templates.js: explicit repair must remove deprecated template "${id}"`);
  }
  for (const id of [...deprecatedIds].filter((value) => templateIds.has(value))) {
    assert.ok(migratedIds.has(id), `scripts/data/building-templates.js: active legacy template "${id}" must not be removed during migration`);
  }
}
