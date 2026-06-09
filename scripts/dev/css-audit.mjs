import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  const cssFiles = walk(path.join(root, "styles"), (file) => file.endsWith(".css"));
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

  const exactDuplicates = [...exactRules.entries()]
    .filter(([, locations]) => new Set(locations).size > 1)
    .map(([rule, locations]) => ({ rule, files: [...new Set(locations)].sort(), count: locations.length }))
    .sort((a, b) => b.files.length - a.files.length || b.count - a.count || a.rule.localeCompare(b.rule));

  importantByFile.sort((a, b) => b.important - a.important);

  console.log("FBL Skyhold CSS audit");
  console.log("=====================");
  console.log(`CSS files: ${cssFiles.length}`);
  console.log(`!important total: ${totalImportant}`);
  console.log(`Duplicate selectors across files: ${duplicateSelectors.length}`);
  console.log(`Exact duplicate rules across files: ${exactDuplicates.length}`);
  console.log(`Maybe unused Skyhold classes: ${maybeUnused.length}`);
  console.log("");

  if (importantByFile.length) {
    console.log("Top !important files:");
    for (const entry of importantByFile.slice(0, 12)) console.log(`  ${entry.important.toString().padStart(4)}  ${rel(entry.file)}`);
    console.log("");
  }

  if (duplicateSelectors.length) {
    console.log("Top duplicate selectors:");
    for (const entry of duplicateSelectors.slice(0, 12)) {
      console.log(`  ${entry.files.length} files / ${entry.count} rules  ${entry.selector}`);
      for (const file of entry.files.slice(0, 4)) console.log(`      ${file}`);
      if (entry.files.length > 4) console.log(`      ... ${entry.files.length - 4} more`);
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
}

main();
