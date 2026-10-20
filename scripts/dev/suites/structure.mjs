import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const skipped = new Set([".git", ".agents", ".codex", ".codex-tmp", "node_modules", "dist"]);

function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    if (skipped.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, output);
    else if (/\.(?:js|mjs|css|hbs|json|md)$/.test(full)) output.push(full);
  }
  return output;
}

function relativeImportTarget(file, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(file), specifier);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch (_error) {}
  }
  return null;
}

function assertNoImportCycles(files) {
  const fileSet = new Set(files.map((file) => path.resolve(file)));
  const edges = new Map();
  for (const file of fileSet) {
    const source = readFileSync(file, "utf8");
    const imports = [...source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)]
      .map((match) => relativeImportTarget(file, match[1]))
      .filter((target) => target && fileSet.has(path.resolve(target)));
    edges.set(file, imports.map((target) => path.resolve(target)));
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (file, stack = []) => {
    if (visiting.has(file)) throw new Error(`Import cycle: ${[...stack, file].map((entry) => path.relative(root, entry)).join(" -> ")}`);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const target of edges.get(file) ?? []) visit(target, [...stack, file]);
    visiting.delete(file);
    visited.add(file);
  };
  for (const file of fileSet) visit(file);
}

export function runStructureSuite() {
  const textFiles = walk(root);
  const files = textFiles.filter((file) => /\.(?:js|mjs)$/.test(file));
  for (const file of textFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\r\n/, `${path.relative(root, file)} must use LF line endings`);
  }
  for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  assertNoImportCycles(files.filter((file) => !file.includes(`${path.sep}dev${path.sep}`)));
  return { suite: "structure", files: files.length };
}

if (process.argv[1] && (import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href || /[\\/]structure\.mjs$/i.test(process.argv[1]))) {
  const result = runStructureSuite();
  console.log(`FBL Skyhold suite: structure passed (${result.files} JS files).`);
}
