import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimePackagePath } from "./runtime-package-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ignored = new Set([".git", "node_modules", "dist", ".codex-tmp"]);
function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name)) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? markdownFiles(target) : entry.name.endsWith(".md") ? [target] : [];
  });
}

function withoutFences(text) {
  let fence = "";
  return text.split(/\r?\n/).map(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function anchors(text) {
  const result = new Set();
  const used = new Map();
  for (const match of text.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = match[1].toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s/g, "-");
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  return result;
}

const files = markdownFiles(root);
const texts = new Map(files.map(file => [file, withoutFences(readFileSync(file, "utf8"))]));
const failures = [];
const linkedDocs = new Set();
let checked = 0;
for (const [file, text] of texts) {
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const href = match[1].replace(/^<(.+)>$/, "$1");
    if (/^(?:https?:|mailto:|data:|codex:)/i.test(href)) continue;
    const [pathname, fragment] = href.split("#");
    const destination = path.resolve(path.dirname(file), decodeURIComponent(pathname || path.basename(file)));
    const label = `${path.relative(root, file)}: ${href}`;
    checked++;
    if (path.isAbsolute(pathname) || /^[a-z]:[/\\]/i.test(pathname) || path.relative(root, destination).startsWith(`..${path.sep}`)) {
      failures.push(`Non-portable local link: ${label}`);
      continue;
    }
    if (!existsSync(destination)) { failures.push(`Missing target: ${label}`); continue; }
    const sourcePath = path.relative(root, file).replaceAll("\\", "/");
    const targetPath = path.relative(root, destination).replaceAll("\\", "/");
    if (isRuntimePackagePath(sourcePath) && !isRuntimePackagePath(targetPath)) {
      failures.push(`Target excluded from release package: ${label}`);
    }
    if (file === path.join(root, "docs/README.md")) linkedDocs.add(destination);
    if (fragment && statSync(destination).isFile() && destination.endsWith(".md")) {
      const targetText = texts.get(destination) ?? withoutFences(readFileSync(destination, "utf8"));
      if (!anchors(targetText).has(decodeURIComponent(fragment))) failures.push(`Missing anchor: ${label}`);
    }
  }
}
for (const file of files.filter(file => path.dirname(file) === path.join(root, "docs") && path.basename(file) !== "README.md")) {
  if (!linkedDocs.has(file)) failures.push(`Document absent from docs/README.md: ${path.relative(root, file)}`);
}
const index = readFileSync(path.join(root, "docs/README.md"), "utf8");
for (const section of ["Действующие справочники", "Проекты — отдельно от реализации", "Исходные таблицы", "Проверки и доказательства"]) {
  assert.ok(index.includes(`## ${section}`), `Documentation index must separate ${section}`);
}
assert.deepEqual(failures, [], `Documentation links/index:\n${failures.join("\n")}`);
console.log(`Documentation: ${files.length} Markdown files, ${checked} local links/anchors, all docs indexed; release links included in package inventory.`);
