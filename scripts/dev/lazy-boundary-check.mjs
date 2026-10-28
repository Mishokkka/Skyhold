import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const normalize = (file) => path.relative(root, file).replaceAll(path.sep, "/");

function walk(directory, predicate, output = []) {
  for (const entry of readdirSync(directory)) {
    const file = path.join(directory, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) {
      if (entry !== "dev") walk(file, predicate, output);
    } else if (predicate(file)) output.push(file);
  }
  return output;
}

function resolveImport(parent, specifier, extension) {
  if (!specifier.startsWith(".")) return null;
  const candidate = path.resolve(path.dirname(parent), specifier);
  for (const file of [candidate, `${candidate}${extension}`, path.join(candidate, `index${extension}`)]) {
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

function staticJsImports(file) {
  const source = readFileSync(file, "utf8");
  const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  return [...source.matchAll(pattern)]
    .map((match) => resolveImport(file, match[1], ".js"))
    .filter(Boolean);
}

function literalDynamicSpecifiers(source) {
  return [...source.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g)]
    .map(match => match[2]).filter(specifier => !specifier.includes("${"));
}

function allJsImports(file) {
  return [...staticJsImports(file), ...literalDynamicSpecifiers(readFileSync(file, "utf8"))
    .map(specifier => resolveImport(file, specifier, ".js")).filter(Boolean)];
}

assert.deepEqual(literalDynamicSpecifiers("import('./one.js'); import(\"./two.mjs\"); import(`./three.js`); import(variable); import(`./${name}.js`);"),
  ["./one.js", "./two.mjs", "./three.js"]);
assert.ok(allJsImports(path.join(root, "scripts/apps/lazy-apps.js")).includes(path.join(root, "scripts/apps/transport-app.js")));
assert.ok(!staticJsImports(path.join(root, "scripts/apps/lazy-apps.js")).includes(path.join(root, "scripts/apps/transport-app.js")));

function cssImports(file) {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g)]
    .map((match) => resolveImport(file, match[1], ".css"))
    .filter(Boolean);
}

function reachable(entries, dependencies) {
  const visited = new Set();
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    pending.push(...dependencies(file));
  }
  return visited;
}

function bytes(files) {
  return [...files].reduce((sum, file) => sum + statSync(file).size, 0);
}

const manifest = JSON.parse(readFileSync(path.join(root, "module.json"), "utf8"));
const jsEntry = path.join(root, manifest.esmodules[0]);
const staticJs = reachable([jsEntry], staticJsImports);
const runtimeJs = walk(path.join(root, "scripts"), (file) => file.endsWith(".js"));
for (const file of runtimeJs) {
  assert.ok(allJsImports(file).every(imported => !normalize(imported).startsWith("scripts/dev/")),
    `${normalize(file)} must not import historical development fixtures`);
}
const transportRuntime = reachable([path.join(root, "scripts/engines/transport/runtime.js")], allJsImports);
assert.ok(![...transportRuntime].some(file => normalize(file) === "scripts/engines/market/shipment.js"),
  "the new transport executor must not load the retired shipment executor");

const lazyModules = [
  "scripts/apps/mass-combat.js",
  "scripts/apps/market-app.js",
  "scripts/apps/politics-app.js",
  "scripts/apps/tenday-app.js",
  "scripts/apps/editors/building-editor.js",
  "scripts/apps/editors/random-event-editor.js",
  "scripts/apps/editors/route-graph-editor.js",
  "scripts/apps/editors/template-browser.js"
];
for (const modulePath of lazyModules) {
  assert.equal(staticJs.has(path.join(root, modulePath)), false, `${modulePath} must remain outside the startup import graph`);
}

const manifestCssEntries = manifest.styles.map((file) => path.join(root, file));
const startupCss = reachable(manifestCssEntries, cssImports);
const lazyCss = [
  "styles/skyhold-secondary.css",
  "styles/skyhold-template-browser.css"
].map((file) => path.join(root, file));
for (const file of lazyCss) {
  assert.equal(startupCss.has(file), false, `${normalize(file)} must remain outside the manifest CSS graph`);
}

const jsPercent = Math.round((staticJs.size / runtimeJs.length) * 1000) / 10;
console.log(
  `Lazy boundary check passed: startup JS ${staticJs.size}/${runtimeJs.length} modules (${jsPercent}%, ${bytes(staticJs)} bytes); `
  + `startup CSS ${startupCss.size} files (${bytes(startupCss)} bytes); ${lazyModules.length} heavy windows remain lazy.`
);
