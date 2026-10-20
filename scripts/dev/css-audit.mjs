import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWED_DUPLICATE_SELECTORS = new Set([
  ".fbl-skyhold-building-editor",
  ".fbl-skyhold-crew-editor",
  ".fbl-skyhold-resident-editor",
  ".fbl-skyhold-mass-combat",
  ".fbl-skyhold-mass-tag-editor",
  ".fbl-skyhold-route-edge-editor",
  ".fbl-skyhold-template-browser"
]);
const FOUNDRY_BRIDGE = "styles/parts/skyhold-foundry-bridge.css";
const LAZY_CSS_ENTRIES = ["styles/skyhold-secondary.css", "styles/skyhold-template-browser.css"];

function walk(dir, predicate = () => true, output = []) {
  for (const entry of readdirSync(dir)) {
    if ([".git", ".agents", ".codex", ".codex-tmp", "node_modules", "dist"].includes(entry)) continue;
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

function normalizeRel(file) {
  return file.replaceAll("\\", "/");
}

function cssImportsOf(file) {
  const text = readFileSync(file, "utf8");
  const importRe = /@import\s+url\((?:"|')(.+?)(?:"|')\)/g;
  const imports = [];
  for (const match of text.matchAll(importRe)) imports.push(path.resolve(path.dirname(file), match[1]));
  return imports;
}

function activeCssFiles() {
  const manifest = JSON.parse(readFileSync(path.join(root, "module.json"), "utf8"));
  const stack = [...(manifest.styles ?? []), ...LAZY_CSS_ENTRIES].map((file) => path.resolve(root, normalizeRel(file)));
  const active = new Set();
  while (stack.length) {
    const file = stack.pop();
    if (active.has(file)) continue;
    active.add(file);
    for (const imported of cssImportsOf(file)) stack.push(imported);
  }
  return active;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractRules(text) {
  const rules = [];
  const clean = stripComments(text);
  const ruleRe = /([^{}@][^{}]*)\{([^{}]*)\}/g;
  for (const match of clean.matchAll(ruleRe)) {
    const selectorText = match[1].trim().replace(/\s+/g, " ");
    const declarations = match[2].trim().replace(/\s+/g, " ");
    if (!selectorText || !declarations) continue;
    for (const selector of selectorText.split(",").map((part) => part.trim()).filter(Boolean)) {
      rules.push({ selector, declarations });
    }
  }
  return rules;
}

function extractClassNames(text) {
  const classNames = new Set();
  for (const match of text.matchAll(/\.([_a-zA-Z]+[_a-zA-Z0-9-]*)/g)) classNames.add(match[1]);
  return classNames;
}

function main() {
  const allCssFiles = walk(path.join(root, "styles"), (file) => file.endsWith(".css"));
  const active = activeCssFiles();
  const includeAll = process.argv.includes("--all");
  const strict = process.argv.includes("--strict");
  const cssFiles = includeAll ? allCssFiles : allCssFiles.filter((file) => active.has(file));
  const inactiveCssFiles = allCssFiles.filter((file) => !active.has(file));
  const nonCssFiles = walk(root, (file) => /\.(js|mjs|hbs|json|md)$/.test(file));

  let totalImportant = 0;
  const importantByFile = [];
  const selectorLocations = new Map();
  const exactRules = new Map();
  const cssClasses = new Set();

  for (const file of cssFiles) {
    const text = readFileSync(file, "utf8");
    const important = (text.match(/!important/g) ?? []).length;
    totalImportant += important;
    if (important) importantByFile.push({ file, important });

    for (const className of extractClassNames(text)) cssClasses.add(className);

    for (const rule of extractRules(text)) {
      const selectorKey = rule.selector;
      const exactKey = `${rule.selector} { ${rule.declarations} }`;
      if (!selectorLocations.has(selectorKey)) selectorLocations.set(selectorKey, []);
      selectorLocations.get(selectorKey).push(rel(file));
      if (!exactRules.has(exactKey)) exactRules.set(exactKey, []);
      exactRules.get(exactKey).push(rel(file));
    }
  }

  const projectText = nonCssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  const maybeUnused = [...cssClasses]
    .filter((className) => className.startsWith("fbls-") || className.startsWith("fbl-skyhold"))
    .filter((className) => !projectText.includes(className))
    .sort();

  const duplicateSelectors = [...selectorLocations.entries()]
    .filter(([, locations]) => new Set(locations).size > 1)
    .map(([selector, locations]) => ({ selector, files: [...new Set(locations)].sort(), count: locations.length }))
    .sort((a, b) => b.files.length - a.files.length || b.count - a.count || a.selector.localeCompare(b.selector));
  const allowedDuplicateSelectors = duplicateSelectors.filter((entry) => {
    return ALLOWED_DUPLICATE_SELECTORS.has(entry.selector) && entry.files.includes(FOUNDRY_BRIDGE);
  });
  const actionableDuplicateSelectors = duplicateSelectors.filter((entry) => !allowedDuplicateSelectors.includes(entry));

  const exactDuplicates = [...exactRules.entries()]
    .filter(([, locations]) => new Set(locations).size > 1)
    .map(([rule, locations]) => ({ rule, files: [...new Set(locations)].sort(), count: locations.length }))
    .sort((a, b) => b.files.length - a.files.length || b.count - a.count || a.rule.localeCompare(b.rule));

  importantByFile.sort((a, b) => b.important - a.important);

  console.log("FBL Skyhold CSS audit");
  console.log("=====================");
  console.log(`Scope: ${includeAll ? "all CSS files" : "manifest plus lazy runtime cascades"}`);
  console.log(`CSS files: ${cssFiles.length}${includeAll ? "" : ` active, ${inactiveCssFiles.length} inactive/archive`}`);
  console.log(`!important total: ${totalImportant}`);
  console.log(`Duplicate selectors across files: ${actionableDuplicateSelectors.length} actionable, ${allowedDuplicateSelectors.length} allowed`);
  console.log(`Exact duplicate rules across files: ${exactDuplicates.length}`);
  console.log(`Maybe unused Skyhold classes: ${maybeUnused.length}`);
  console.log("");

  if (importantByFile.length) {
    console.log("Top !important files:");
    for (const entry of importantByFile.slice(0, 12)) console.log(`  ${entry.important.toString().padStart(4)}  ${rel(entry.file)}`);
    console.log("");
  }

  if (actionableDuplicateSelectors.length) {
    console.log("Top actionable duplicate selectors:");
    for (const entry of actionableDuplicateSelectors.slice(0, 12)) {
      console.log(`  ${entry.files.length} files / ${entry.count} rules  ${entry.selector}`);
      for (const file of entry.files.slice(0, 4)) console.log(`      ${file}`);
      if (entry.files.length > 4) console.log(`      ... ${entry.files.length - 4} more`);
    }
    console.log("");
  }

  if (allowedDuplicateSelectors.length) {
    console.log("Allowed Foundry bridge duplicate selectors:");
    for (const entry of allowedDuplicateSelectors) {
      console.log(`  ${entry.files.length} files / ${entry.count} rules  ${entry.selector}`);
    }
    console.log("");
  }

  if (exactDuplicates.length) {
    console.log("Top exact duplicate rules:");
    for (const entry of exactDuplicates.slice(0, 8)) {
      console.log(`  ${entry.files.length} files / ${entry.count} rules  ${entry.rule.slice(0, 140)}${entry.rule.length > 140 ? "..." : ""}`);
      for (const file of entry.files.slice(0, 4)) console.log(`      ${file}`);
      if (entry.files.length > 4) console.log(`      ... ${entry.files.length - 4} more`);
    }
    console.log("");
  }

  if (maybeUnused.length) {
    console.log("Maybe unused classes, warning only:");
    for (const className of maybeUnused.slice(0, 80)) console.log(`  .${className}`);
    if (maybeUnused.length > 80) console.log(`  ... ${maybeUnused.length - 80} more`);
  }

  if (!includeAll && inactiveCssFiles.length) {
    console.log("");
    console.log("Inactive/archive CSS files:");
    for (const file of inactiveCssFiles.slice(0, 40)) console.log(`  ${rel(file)}`);
    if (inactiveCssFiles.length > 40) console.log(`  ... ${inactiveCssFiles.length - 40} more`);
    console.log("Use --all to include archived CSS in duplicate and !important counts.");
  }

  if (strict && (totalImportant || actionableDuplicateSelectors.length || exactDuplicates.length || maybeUnused.length)) {
    console.error("\nCSS audit failed in strict mode.");
    process.exitCode = 1;
  }
}

main();
