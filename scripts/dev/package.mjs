import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(path.join(root, "module.json"), "utf8"));
const moduleId = String(manifest.id ?? "").trim();
const version = String(manifest.version ?? "").trim();

const RUNTIME_FILES = ["module.json", "README.md"];
const RUNTIME_DIRS = ["assets", "docs", "examples", "lang", "scripts", "styles", "templates"];
const EXCLUDED_RUNTIME_PREFIXES = ["scripts/dev/"];
const FORBIDDEN_ARCHIVE_SEGMENTS = new Set([
  ".agents",
  ".codex",
  ".git",
  "dist",
  "node_modules"
]);
const FORBIDDEN_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const FORBIDDEN_FILE_SUFFIXES = [".bak", ".log", ".tmp"];

function normalizeRelative(file) {
  return file.replaceAll("\\", "/").replace(/^\/+/, "");
}

function assertSafeMetadata() {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(moduleId)) throw new Error(`Unsafe or missing module id: ${moduleId || "<empty>"}`);
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) throw new Error(`Unsafe or missing module version: ${version || "<empty>"}`);
}

function isExcludedRuntimePath(relative) {
  const normalized = normalizeRelative(relative);
  return EXCLUDED_RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function assertRuntimePathAllowed(relative) {
  const normalized = normalizeRelative(relative);
  const segments = normalized.split("/");
  const fileName = segments.at(-1) ?? "";
  const forbiddenSegment = segments.find((segment) => FORBIDDEN_ARCHIVE_SEGMENTS.has(segment));
  if (forbiddenSegment) throw new Error(`Forbidden path segment "${forbiddenSegment}" in runtime file: ${normalized}`);
  if (FORBIDDEN_FILE_NAMES.has(fileName)) throw new Error(`Forbidden runtime file: ${normalized}`);
  if (FORBIDDEN_FILE_SUFFIXES.some((suffix) => fileName.toLowerCase().endsWith(suffix))) {
    throw new Error(`Forbidden temporary runtime file: ${normalized}`);
  }
}

function collectDirectoryFiles(directory, relativeBase, output) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = normalizeRelative(path.join(relativeBase, entry.name));
    if (isExcludedRuntimePath(relative)) continue;
    if (entry.isSymbolicLink() || lstatSync(absolute).isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in the release package: ${relative}`);
    }
    if (entry.isDirectory()) collectDirectoryFiles(absolute, relative, output);
    else if (entry.isFile()) {
      assertRuntimePathAllowed(relative);
      output.push(relative);
    }
  }
}

function collectRuntimeFiles() {
  const files = [];
  for (const relative of RUNTIME_FILES) {
    const absolute = path.join(root, relative);
    if (!statSync(absolute).isFile()) throw new Error(`Missing required runtime file: ${relative}`);
    assertRuntimePathAllowed(relative);
    files.push(relative);
  }
  for (const relative of RUNTIME_DIRS) {
    const absolute = path.join(root, relative);
    if (!statSync(absolute).isDirectory()) throw new Error(`Missing required runtime directory: ${relative}`);
    collectDirectoryFiles(absolute, relative, files);
  }
  return files.sort();
}

function copyRuntimeFiles(files, moduleStage) {
  for (const relative of files) {
    const source = path.join(root, relative);
    const target = path.join(moduleStage, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}

function runPowerShell(script, environment = {}) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...environment }
    }
  );
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(`PowerShell packaging command failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function createArchive(moduleStage, archivePath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$source = [System.IO.Path]::GetFullPath($env:FBLS_PACKAGE_SOURCE).TrimEnd('\\', '/')",
    "$baseName = [System.IO.Path]::GetFileName($source)",
    "$archive = [System.IO.Compression.ZipFile]::Open($env:FBLS_PACKAGE_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Create)",
    "try {",
    "  foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse) {",
    "    $relative = $file.FullName.Substring($source.Length).TrimStart('\\', '/') -replace '\\\\', '/'",
    "    $entryName = $baseName + '/' + $relative",
    "    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(",
    "      $archive,",
    "      $file.FullName,",
    "      $entryName,",
    "      [System.IO.Compression.CompressionLevel]::Optimal",
    "    ) | Out-Null",
    "  }",
    "} finally {",
    "  $archive.Dispose()",
    "}"
  ].join("\n");
  runPowerShell(script, {
    FBLS_PACKAGE_SOURCE: moduleStage,
    FBLS_PACKAGE_ARCHIVE: archivePath
  });
}

function archiveEntries(archivePath) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    "$archive = [System.IO.Compression.ZipFile]::OpenRead($env:FBLS_PACKAGE_ARCHIVE)",
    "try {",
    "  foreach ($entry in $archive.Entries) {",
    "    if ($entry.Name) { [Console]::Out.WriteLine($entry.FullName) }",
    "  }",
    "} finally {",
    "  $archive.Dispose()",
    "}"
  ].join("\n");
  return runPowerShell(script, { FBLS_PACKAGE_ARCHIVE: archivePath })
    .split(/\r?\n/)
    .map((entry) => normalizeRelative(entry.trim()))
    .filter(Boolean)
    .sort();
}

function verifyArchive(archivePath, runtimeFiles) {
  const entries = archiveEntries(archivePath);
  const expected = runtimeFiles.map((relative) => `${moduleId}/${relative}`).sort();
  const expectedSet = new Set(expected);
  const entrySet = new Set(entries);
  const missing = expected.filter((entry) => !entrySet.has(entry));
  const unexpected = entries.filter((entry) => !expectedSet.has(entry));

  if (missing.length || unexpected.length) {
    const details = [
      missing.length ? `Missing entries:\n  ${missing.join("\n  ")}` : "",
      unexpected.length ? `Unexpected entries:\n  ${unexpected.join("\n  ")}` : ""
    ].filter(Boolean).join("\n");
    throw new Error(`Release archive does not match the runtime allowlist.\n${details}`);
  }

  for (const entry of entries) {
    const relative = entry.slice(`${moduleId}/`.length);
    assertRuntimePathAllowed(relative);
    if (isExcludedRuntimePath(relative)) throw new Error(`Excluded dev path entered the archive: ${entry}`);
  }

  const manifestRuntimePaths = [
    ...(Array.isArray(manifest.esmodules) ? manifest.esmodules : []),
    ...(Array.isArray(manifest.styles) ? manifest.styles : []),
    ...(Array.isArray(manifest.languages) ? manifest.languages.map((language) => language?.path) : [])
  ].map((relative) => normalizeRelative(String(relative ?? ""))).filter(Boolean);
  const requiredEntries = [
    `${moduleId}/module.json`,
    `${moduleId}/templates/skyhold-app.hbs`,
    ...manifestRuntimePaths.map((relative) => `${moduleId}/${relative}`)
  ];
  for (const required of requiredEntries) {
    if (!entrySet.has(required)) throw new Error(`Release archive is missing Foundry runtime entry: ${required}`);
  }

  return entries;
}

function main() {
  assertSafeMetadata();
  const runtimeFiles = collectRuntimeFiles();
  const distRoot = path.join(root, "dist");
  const stageRoot = path.join(distRoot, ".package-stage");
  const moduleStage = path.join(stageRoot, moduleId);
  const archivePath = path.join(distRoot, `${moduleId}-${version}.zip`);

  mkdirSync(distRoot, { recursive: true });
  rmSync(stageRoot, { recursive: true, force: true });
  rmSync(archivePath, { force: true });

  try {
    mkdirSync(moduleStage, { recursive: true });
    copyRuntimeFiles(runtimeFiles, moduleStage);
    createArchive(moduleStage, archivePath);
    const entries = verifyArchive(archivePath, runtimeFiles);
    const sizeMiB = (statSync(archivePath).size / (1024 * 1024)).toFixed(2);
    console.log(`FBL Skyhold package created: ${path.relative(root, archivePath)} (${entries.length} files, ${sizeMiB} MiB).`);
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
  }
}

main();
