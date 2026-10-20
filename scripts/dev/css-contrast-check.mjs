import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const STYLES_ROOT = path.join(ROOT, "styles");
const PALETTE_FILE = path.join(STYLES_ROOT, "parts", "skyhold-variables.css");
const MIN_CONTRAST = 4.5;

function collectCssFiles(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectCssFiles(fullPath, result);
    else if (entry.isFile() && entry.name.endsWith(".css")) result.push(fullPath);
  }
  return result;
}

function parseColor(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized.startsWith("#")) {
    let hex = normalized.slice(1);
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((character) => character + character).join("");
    if (hex.length !== 6 && hex.length !== 8) return null;
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1
    };
  }

  const match = normalized.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].replace(/\s*\/\s*/, ",").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (part) => part.endsWith("%") ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part);
  const alpha = (part) => !part ? 1 : part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part);
  const color = { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]), a: alpha(parts[3]) };
  return Object.values(color).every(Number.isFinite) ? color : null;
}

function blend(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: ((foreground.r * foreground.a) + (background.r * background.a * (1 - foreground.a))) / alpha,
    g: ((foreground.g * foreground.a) + (background.g * background.a * (1 - foreground.a))) / alpha,
    b: ((foreground.b * foreground.a) + (background.b * background.a * (1 - foreground.a))) / alpha,
    a: alpha
  };
}

function luminance(color) {
  const channel = (value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (0.2126 * channel(color.r)) + (0.7152 * channel(color.g)) + (0.0722 * channel(color.b));
}

function contrast(foreground, background) {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function readPalette() {
  const source = fs.readFileSync(PALETTE_FILE, "utf8");
  const variables = new Map();
  for (const match of source.matchAll(/(--fbls-[\w-]+)\s*:\s*([^;]+);/g)) variables.set(match[1], match[2].trim());

  const resolving = new Set();
  const resolve = (name) => {
    if (resolving.has(name)) throw new Error(`Cyclic palette variable: ${name}`);
    const value = variables.get(name);
    if (!value) throw new Error(`Missing palette variable: ${name}`);
    const direct = parseColor(value);
    if (direct) return direct;
    const alias = value.match(/^var\((--fbls-[\w-]+)\)$/);
    if (!alias) throw new Error(`Palette variable ${name} is not a simple color: ${value}`);
    resolving.add(name);
    const result = resolve(alias[1]);
    resolving.delete(name);
    return result;
  };
  return { source, resolve };
}

const files = collectCssFiles(STYLES_ROOT);
const failures = [];
const palette = readPalette();
const relative = (file) => path.relative(ROOT, file).replaceAll("\\", "/");

// The variables file is the only owner of literal colors. Domain CSS must use semantic tokens.
const literalPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
for (const file of files) {
  if (file === PALETTE_FILE) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(literalPattern)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    failures.push(`${relative(file)}:${line} uses literal color ${match[0]}`);
  }
  for (const match of source.matchAll(/\b(?:color|background(?:-color)?|border-color)\s*:\s*(white|black)\b/g)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    failures.push(`${relative(file)}:${line} uses literal color ${match[1]}`);
  }
}

const surfaces = ["--fbls-surface-0", "--fbls-surface-1", "--fbls-surface-2", "--fbls-surface-3"];
const raised = ["--fbls-surface-soft", "--fbls-panel", "--fbls-panel-strong"];
const readable = [
  "--fbls-text-strong", "--fbls-text", "--fbls-muted", "--fbls-dim", "--fbls-placeholder",
  "--fbls-accent", "--fbls-success", "--fbls-warning", "--fbls-danger", "--fbls-info", "--fbls-culture"
];

const backgrounds = [];
for (const surfaceName of surfaces) {
  const surface = palette.resolve(surfaceName);
  backgrounds.push({ name: surfaceName, color: surface });
  for (const raisedName of raised) {
    backgrounds.push({ name: `${raisedName} over ${surfaceName}`, color: blend(palette.resolve(raisedName), surface) });
  }
}

for (const foregroundName of readable) {
  const foreground = palette.resolve(foregroundName);
  if (foreground.a < 1) failures.push(`${foregroundName} must resolve to an opaque readable color`);
  for (const background of backgrounds) {
    const ratio = contrast(foreground, background.color);
    if (ratio < MIN_CONTRAST) failures.push(`${foregroundName} on ${background.name}: ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
  }
}

const onAccent = palette.resolve("--fbls-on-accent");
for (const backgroundName of ["--fbls-accent", "--fbls-success", "--fbls-warning", "--fbls-danger", "--fbls-info", "--fbls-culture"]) {
  const ratio = contrast(onAccent, palette.resolve(backgroundName));
  if (ratio < MIN_CONTRAST) failures.push(`--fbls-on-accent on ${backgroundName}: ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
}

for (const foregroundName of ["--fbls-text", "--fbls-text-strong"]) {
  const ratio = contrast(palette.resolve(foregroundName), palette.resolve("--fbls-danger-strong"));
  if (ratio < MIN_CONTRAST) failures.push(`${foregroundName} on --fbls-danger-strong: ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
}

// Worker badge hues are alpha colors rendered over several shared surfaces.
for (const workerName of ["strength", "agility", "wits", "empathy"]) {
  const token = `--fbls-worker-${workerName}`;
  for (const background of backgrounds) {
    const badge = blend(palette.resolve(token), background.color);
    const ratio = contrast(palette.resolve("--fbls-text-strong"), badge);
    if (ratio < MIN_CONTRAST) failures.push(`--fbls-text-strong on ${token} over ${background.name}: ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
  }
}

// Placeholders are a recurring regression surface, so require the dedicated token in every rule.
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/([^{}]*::placeholder[^{}]*)\{([^{}]*)\}/g)) {
    if (!/color\s*:\s*var\(--fbls-placeholder\)/.test(match[2])) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      failures.push(`${relative(file)}:${line} placeholder does not use --fbls-placeholder`);
    }
  }
}

const forbiddenTextTokens = /(?<![-\w])color\s*:\s*var\(--fbls-(?:surface(?:-[\w]+)?|panel(?:-strong)?|overlay(?:-soft|-strong)?|accent-(?:soft|bg|border)|success-soft|warning-soft|danger-(?:soft|border)|info-soft|culture-soft)\)/g;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(forbiddenTextTokens)) {
    const line = source.slice(0, match.index).split(/\r?\n/).length;
    failures.push(`${relative(file)}:${line} uses a background token as text color`);
  }
}

// Check actual native-control declarations too: a valid palette alone cannot
// prevent a component from pairing two individually valid, similar colors.
let nativeSelectPairs = 0;
for (const file of files) {
  const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/(?:^|[\s>+~,(])(?:select|option|optgroup)(?=[\s.:#[>,+~)]|$)/.test(match[1])) continue;
    const declarations = new Map([...match[2].matchAll(/(?:^|;)\s*([\w-]+)\s*:\s*([^;]+)/g)].map(row => [row[1], row[2].trim()]));
    const background = declarations.get("background-color") ?? declarations.get("background");
    const foregroundValues = [declarations.get("color"), declarations.get("-webkit-text-fill-color")].filter(Boolean);
    if (!background && !foregroundValues.length) continue;
    const backgroundToken = background ? background.match(/^var\((--fbls-[\w-]+)\)$/)?.[1] : "--fbls-surface-1";
    if (!backgroundToken) continue; // Gradients/aliases are covered by their palette owner.
    const foregroundTokens = [declarations.get("color"), declarations.get("-webkit-text-fill-color")]
      .map(value => value?.match(/^var\((--fbls-[\w-]+)\)$/)?.[1]).filter(Boolean);
    // A one-sided override must still be readable with the shared native base.
    if (!foregroundValues.length) foregroundTokens.push("--fbls-text", "--fbls-muted");
    for (const foregroundToken of new Set(foregroundTokens)) {
      let foreground, backgroundColor;
      try { foreground = palette.resolve(foregroundToken); backgroundColor = palette.resolve(backgroundToken); }
      catch { continue; } // Component aliases are not globally defined colors.
      for (const surface of backgrounds) {
        const renderedBackground = blend(backgroundColor, surface.color);
        const ratio = contrast(blend(foreground, renderedBackground), renderedBackground);
        if (ratio < MIN_CONTRAST) failures.push(`${relative(file)} native select: ${foregroundToken} on ${backgroundToken} over ${surface.name}: ${ratio.toFixed(2)} < ${MIN_CONTRAST}`);
      }
      nativeSelectPairs++;
    }
  }
}

// A standalone window shell must not depend on whichever Foundry/theme surface happens
// to sit behind it. Decorative alpha gradients are allowed only on top of an owned base.
const opaqueShellTokens = /var\(--fbls-(?:surface-[0-3]|bg|reference-bg|battle-shell-bg)/;
const standaloneShellClasses = new Set([
  "fbls-shell",
  "fbls-building-editor-shell",
  "fbls-crew-editor-shell",
  "fbls-building-audio-shell",
  "fbls-mass-reference-shell",
  "fbls-resource-editor-shell",
  "fbls-resource-row-editor-shell",
  "fbls-market-shell",
  "fbls-content-pack-shell",
  "fbls-random-event-editor-shell",
  "fbls-event-row-editor-shell",
  "fbls-event-context-editor-shell",
  "fbls-region-catalog-editor-shell",
  "fbls-battle-shell",
  "fbls-route-edge-editor-shell",
  "fbls-route-graph-shell",
  "fbls-mass-tag-editor-shell",
  "fbls-tenday-shell",
  "fbls-fasti-shop-shell"
]);
const ownedShells = new Set();
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2];
    if (!/background(?:-color)?\s*:/.test(body)) continue;
    for (const selector of match[1].split(",")) {
      const trimmed = selector.trim();
      const className = trimmed.match(/\.([\w-]+-shell)$/)?.[1];
      if (!className || !standaloneShellClasses.has(className)) continue;
      if (opaqueShellTokens.test(body)) ownedShells.add(className);
    }
  }
}
for (const className of standaloneShellClasses) {
  if (!ownedShells.has(className)) failures.push(`.${className} standalone shell has no opaque semantic base`);
}

console.log("FBL Skyhold contrast and palette check");
console.log("======================================");
console.log(`CSS files: ${files.length}`);
console.log(`Direct color owners: 1 (${relative(PALETTE_FILE)})`);
console.log(`Required contrast: ${MIN_CONTRAST}:1`);
console.log(`Native select foreground/background pairs: ${nativeSelectPairs}`);

if (failures.length) {
  console.error(`\nFailures: ${failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Palette ownership, placeholder policy, and contrast pairs: OK");
}
