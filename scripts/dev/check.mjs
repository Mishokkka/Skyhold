import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function walk(dir, predicate = () => true, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, predicate, output);
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

function checkSyntax(jsFiles) {
  for (const file of jsFiles) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}



function extractSimpleCssRules(text) {
  const rules = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  for (const match of clean.matchAll(ruleRe)) {
    const selector = match[1].trim().replace(/\s+/g, " ");
    const declarations = match[2].trim().replace(/\s+/g, " ");
    if (selector && declarations) rules.push(`${selector} { ${declarations} }`);
  }
  return rules;
}

function checkCssHygiene(cssFiles) {
  const cssAudit = auditCss(cssFiles);
  assert.ok(cssAudit.totalImportant <= 100, `CSS !important budget exceeded: ${cssAudit.totalImportant} > 100`);
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

function checkImportCycles(jsFiles) {
  const files = new Set(jsFiles.map((file) => path.resolve(file)));
  const graph = new Map();
  const importRe = /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g;

  for (const file of jsFiles) {
    const text = readFileSync(file, "utf8");
    const edges = [];
    for (const match of text.matchAll(importRe)) {
      const spec = match[1];
      if (!spec.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), spec);
      const normalized = target.endsWith(".js") || target.endsWith(".mjs") ? target : `${target}.js`;
      if (files.has(normalized)) edges.push(normalized);
    }
    graph.set(path.resolve(file), edges);
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(file) {
    if (visited.has(file)) return;
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      const cycle = [...stack.slice(start), file].map(rel).join(" -> ");
      throw new Error(`Import cycle: ${cycle}`);
    }
    visiting.add(file);
    stack.push(file);
    for (const next of graph.get(file) ?? []) visit(next);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }

  for (const file of graph.keys()) visit(file);
}

function checkTemplatePartials(hbsFiles) {
  const mainFile = path.join(root, "scripts/main.js");
  const mainText = readFileSync(mainFile, "utf8");
  const partialRe = /{{>\s*["']([^"']+)["']/g;

  for (const file of hbsFiles) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(partialRe)) {
      const spec = match[1];
      assert.ok(spec.startsWith("modules/fbl-skyhold/"), `Unexpected partial path in ${rel(file)}: ${spec}`);

      const targetRel = spec.slice("modules/fbl-skyhold/".length);
      const target = path.join(root, targetRel);
      assert.equal(existsSync(target), true, `Missing Handlebars partial target: ${targetRel} (referenced from ${rel(file)})`);

      if (targetRel.startsWith("templates/parts/")) {
        assert.ok(mainText.includes(targetRel), `Handlebars partial is not preloaded in scripts/main.js: ${targetRel}`);
      }
    }
  }
}

async function run() {
  const jsFiles = walk(root, (file) => /\.(js|mjs)$/.test(file));
  const cssFiles = walk(root, (file) => /\.css$/.test(file));
  const hbsFiles = walk(root, (file) => /\.hbs$/.test(file));
  checkSyntax(jsFiles);
  checkImportCycles(jsFiles);
  checkTemplatePartials(hbsFiles);
  checkCssImports(cssFiles);
  checkCssBalance(cssFiles);
  checkCssNoNestedStyleRules(cssFiles);

  const normalizers = await import(pathToFileURL(path.join(root, "scripts/data/normalizers.js")));
  const schema = await import(pathToFileURL(path.join(root, "scripts/data/schema.js")));
  const guard = await import(pathToFileURL(path.join(root, "scripts/data/player-write-guard.js")));
  const store = await import(pathToFileURL(path.join(root, "scripts/data/store.js")));

  const normalizedOnce = normalizers.migrateData(clone(schema.DEFAULT_SKYHOLD_DATA));
  const normalizedTwice = normalizers.migrateData(normalizedOnce);
  assertJsonEqual(normalizedTwice, normalizedOnce, "normalizers must be idempotent");
  assert.equal(normalizedOnce.meta.schemaVersion, normalizers.SKYHOLD_SCHEMA_VERSION, "schema version must be current");

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

  current.holdings[0].gm.playersCanEditBuildings = true;
  current.holdings[0].buildings.list = [{ id: "b1", templateId: "", name: "Палисад", type: "Оборона" }];
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
  assert.equal(guard.validatePlayerPatch(current, publicTemplatePatch, "player-1").ok, true, "players may create buildings from available public templates");

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
  assert.equal(guard.validatePlayerPatch(current, appendLogPatch, "player-1").ok, true, "players may append storage log entries while making valid storage changes");

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

  console.log(`FBL Skyhold dev-check: ${jsFiles.length} JS files checked; ${hbsFiles.length} HBS files checked; ${cssAudit.totalFiles} CSS files checked; ${cssAudit.totalImportant} !important total. Largest CSS files: ${cssAudit.largest.join(", ")}. All tests passed.`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
