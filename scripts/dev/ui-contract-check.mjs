import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ICON_CONTROL_CLASS = /\b(?:fbls-icon-button|fbls-chip-remove|icon-only(?:-[\w-]+)?)\b/;

function walkTemplates(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) walkTemplates(file, output);
    else if (file.endsWith(".hbs")) output.push(file);
  }
  return output;
}

function walkSources(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = statSync(file);
    if (stat.isDirectory()) walkSources(file, output);
    else if (/\.(?:js|mjs)$/.test(file)) output.push(file);
  }
  return output;
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function sourceLabel(file, text, index, root) {
  const relative = path.relative(root, file).replaceAll(path.sep, "/");
  return `${relative}:${lineNumberAt(text, index)}`;
}

function attributeValue(attributes, name) {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? "";
}

function hasAccessibleName(attributes) {
  return /\baria-label\s*=\s*["'][^"']+?["']/i.test(attributes)
    || /\baria-labelledby\s*=\s*["'][^"']+?["']/i.test(attributes);
}

function hasVisibleButtonText(body) {
  const text = body
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|thinsp|ensp|emsp);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Boolean(text);
}

export function checkUiContract({ root = DEFAULT_ROOT, hbsFiles = null } = {}) {
  const files = hbsFiles ?? walkTemplates(path.join(root, "templates"));
  const failures = [];
  let buttonCount = 0;
  let iconOnlyCount = 0;
  let delegatedRoleCount = 0;
  let searchInputCount = 0;
  const scriptText = walkSources(path.join(root, "scripts")).map((file) => readFileSync(file, "utf8")).join("\n");

  for (const file of files) {
    const text = readFileSync(file, "utf8");

    for (const match of text.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      buttonCount += 1;
      const attributes = match[1] ?? "";
      const body = match[2] ?? "";
      const classes = attributeValue(attributes, "class");
      const iconOnly = ICON_CONTROL_CLASS.test(classes) || !hasVisibleButtonText(body);
      if (iconOnly) iconOnlyCount += 1;
      if (!/\btype\s*=\s*["']button["']/i.test(attributes)) {
        failures.push(`${sourceLabel(file, text, match.index, root)} button must declare type="button"`);
      }
      if (iconOnly && !hasAccessibleName(attributes)) {
        failures.push(`${sourceLabel(file, text, match.index, root)} icon-only button needs aria-label or aria-labelledby`);
      }
    }


    for (const match of text.matchAll(/<input\b([^>]*\btype\s*=\s*["']search["'][^>]*)>/gi)) {
      searchInputCount += 1;
      const attributes = match[1] ?? "";
      const dataAttribute = attributes.match(/\b(data-[\w-]+)(?:\s*=\s*(["']).*?\2)?/i)?.[1] ?? "";
      const label = sourceLabel(file, text, match.index, root);
      if (!dataAttribute) failures.push(`${label} search input needs a data-* handler hook`);
      else if (!scriptText.includes(dataAttribute)) failures.push(`${label} search hook ${dataAttribute} has no script-side handler`);
    }

    for (const match of text.matchAll(/<(?!button\b|input\b|select\b|textarea\b|a\b)([a-z][\w-]*)\b([^>]*\bdata-action\s*=\s*["'][^"']+["'][^>]*)>/gi)) {
      delegatedRoleCount += 1;
      const attributes = match[2] ?? "";
      const label = sourceLabel(file, text, match.index, root);
      if (!/\brole\s*=\s*["']button["']/i.test(attributes)) failures.push(`${label} non-button data-action needs role="button"`);
      if (!/\btabindex\s*=\s*["']0["']/i.test(attributes)) failures.push(`${label} non-button data-action needs tabindex="0"`);
      if (!hasAccessibleName(attributes)) failures.push(`${label} non-button data-action needs an accessible name`);
    }
  }


  const guardSource = readFileSync(path.join(root, "scripts/utils/input-guards.js"), "utf8");
  if (/field\.addEventListener\(eventName,\s*stop/.test(guardSource)) failures.push("scripts/utils/input-guards.js must not swallow delegated input events at the field");
  if (!/root\.addEventListener\(eventName,\s*stop/.test(guardSource)) failures.push("scripts/utils/input-guards.js must contain input events at the application root");

  const marketTemplate = readFileSync(path.join(root, "templates/market-app.hbs"), "utf8");
  const renderScheduler = readFileSync(path.join(root, "scripts/apps/common/render-scheduler.js"), "utf8");
  for (const key of ["market-offers", "market-cart"]) {
    if (!marketTemplate.includes(`data-render-scroll-key="${key}"`)) failures.push(`templates/market-app.hbs must preserve ${key} scroll position`);
  }
  if (!renderScheduler.includes("[data-render-scroll-key]")) failures.push("render scheduler must restore declared scroll regions after rerender");

  const routeCss = readFileSync(path.join(root, "styles/parts/market/route-graph.css"), "utf8");
  const foundryBridgeCss = readFileSync(path.join(root, "styles/parts/skyhold-foundry-bridge.css"), "utf8");
  const financeDialogs = readFileSync(path.join(root, "scripts/apps/domains/events/finance-control-events.js"), "utf8");
  if (!/prompt\(\{\s*classes: \["fbl-skyhold", "fbl-skyhold-finance-dialog"\],\s*window: \{ title: "Передать денежное обязательство"/.test(financeDialogs)) failures.push("the finance-transfer select must retain the common Skyhold theme and the financial dialog owner");
  const tendayWindowCss = readFileSync(path.join(root, "styles/parts/tenday/tenday-window.css"), "utf8");
  const residentEditorTemplate = readFileSync(path.join(root, "templates/parts/skyhold-resident-editor.hbs"), "utf8");
  const uniqueBuildingEditorTemplate = readFileSync(path.join(root, "templates/unique-buildings/parts/editor-tabs.hbs"), "utf8");
  const residentEditorWindowTemplate = readFileSync(path.join(root, "templates/resident-editor.hbs"), "utf8");
  const residentEditorSource = readFileSync(path.join(root, "scripts/apps/editors/resident-editor.js"), "utf8");
  const residentEditorCss = readFileSync(path.join(root, "styles/parts/skyhold-resident-editor-v2.css"), "utf8");
  const medicalBuildingCss = readFileSync(path.join(root, "styles/parts/unique-buildings/medical.css"), "utf8");
  // One shared native-select owner replaces the former per-window allowlist.
  for (const chrome of ['application', 'window-app']) {
    for (const target of ['select,', 'select :is(option, optgroup)', 'select:disabled', 'select optgroup:disabled option']) {
      if (!foundryBridgeCss.includes('.' + chrome + '.fbl-skyhold ' + target)) failures.push(chrome + ' native select coverage missing: ' + target);
    }
  }
  const nativeMenuRule = foundryBridgeCss.match(/\.application\.fbl-skyhold select,[\s\S]*?\{([^}]+)\}/)?.[1] ?? '';
  for (const declaration of ['color-scheme: dark', 'color: var(--fbls-text)', '-webkit-text-fill-color: var(--fbls-text)', 'background: var(--fbls-surface-1)', 'opacity: 1']) {
    if (!nativeMenuRule.includes(declaration)) failures.push('all native selects/options/optgroups need ' + declaration);
  }
  if (!/\.fbl-skyhold-route-edge-editor\s*\{[^}]*color-scheme:\s*dark/s.test(routeCss)) failures.push("route editor must declare a dark native-control color scheme");
  if (!/\.fbl-skyhold-tenday-app\s*\{[^}]*color-scheme:\s*dark/s.test(tendayWindowCss)) failures.push("tenday window must declare a dark native-control color scheme");
  if (!/\.fbls-tenday-contract-note select\s*\{[^}]*color:\s*var\(--fbls-text\)[^}]*background:\s*var\(--fbls-surface-1\)[^}]*-webkit-text-fill-color:\s*var\(--fbls-text\)/s.test(foundryBridgeCss)) failures.push("tenday ration select needs explicit readable foreground and background states in the Foundry bridge");
  if (!/\.fbls-tenday-contract-note select:disabled\s*\{[^}]*color:\s*var\(--fbls-muted\)[^}]*opacity:\s*1[^}]*-webkit-text-fill-color:\s*var\(--fbls-muted\)/s.test(foundryBridgeCss)) failures.push("disabled tenday ration select must remain readable");
  if (!residentEditorWindowTemplate.includes("fbls-resident-editor-window") || !residentEditorWindowTemplate.includes("skyhold-resident-editor.hbs")) failures.push("resident editor must render in its dedicated window shell");
  if (!/new this\([\s\S]{0,160}position:\s*\{[\s\S]{0,60}width:\s*1260,[\s\S]{0,60}height:\s*"auto"/.test(residentEditorSource) || !/position:\s*\{[\s\S]{0,60}width:\s*1260,[\s\S]{0,60}height:\s*"auto"/.test(residentEditorSource)) failures.push("resident editor must request a stable 1260px opening width with content-driven height");
  if (/globalThis\.inner(?:Width|Height)/.test(residentEditorSource)) failures.push("resident editor opening size must not depend on transient browser inner dimensions");
  if (!/app\.render\([\s\S]{0,100}\.then\(\(\)\s*=>\s*\{[\s\S]{0,160}app\.setPosition\(\{\s*width:\s*1260,\s*height:\s*"auto"\s*\}\);[\s\S]{0,100}app\._bindWindowFrameSync\(root\)/.test(residentEditorSource)) failures.push("resident editor must apply and capture its opening frame only after ApplicationV2 render fully resolves");
  if (!/if\s*\(!options\?\.isFirstRender\)\s*this\._bindWindowFrameSync\(root\)/.test(residentEditorSource)) failures.push("resident editor must not measure its intrinsic frame during the first _onRender lifecycle");
  if (!/fbl-skyhold-resident-editor \.fbls-person-editor\.v2 > fieldset[\s\S]{0,650}margin-block:\s*0/.test(foundryBridgeCss)) failures.push("resident editor needs an unlayered Foundry fieldset-margin reset");

  const residentWorkFieldOrder = [
    "person-work",
    "person-salary",
    "person-volunteer",
    "person-volunteer-reason",
    "person-custom-role",
    "person-home",
    "person-maintenance-points",
    "person-background"
  ];
  let previousResidentWorkField = -1;
  for (const className of residentWorkFieldOrder) {
    const index = residentEditorTemplate.search(new RegExp(`<label\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b`, "i"));
    if (index < 0) failures.push(`resident editor must retain the ${className} work-and-housing field`);
    else if (index <= previousResidentWorkField) failures.push("resident work-and-housing fields must retain their keyboard navigation order");
    previousResidentWorkField = Math.max(previousResidentWorkField, index);
  }

  const residentWorkSetRule = residentEditorCss.match(/\.work-set\.compact-resident-work\s*\{([^}]*)\}/s)?.[1] ?? "";
  const residentWorkSourceRule = residentEditorCss.match(/\.fbls-work-source-block\s*\{([^}]*)\}/s)?.[1] ?? "";
  if (!/container:\s*fbls-resident-editor\s*\/\s*inline-size/.test(residentEditorCss)) failures.push("resident editor responsiveness must follow the editor width, not only the viewport");
  if (!/grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/.test(residentWorkSetRule)) failures.push("resident work and housing must share one twelve-column wide layout");
  if (!/grid-column:\s*1\s*\/\s*-1/.test(residentWorkSourceRule) || !/grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/.test(residentWorkSourceRule)) failures.push("resident work source fields must occupy the full shared grid");
  if (!/grid-auto-rows:\s*max-content/.test(residentEditorCss) || !/align-content:\s*start/.test(residentEditorCss)) failures.push("resident editor sections must not stretch into artificial vertical gaps");
  if (/max-width:\s*320px|\b(?:54|34)px\b/.test(residentWorkSourceRule)) failures.push("resident work layout must not restore the cramped fixed-width columns from the overlapping layout");
  if ((residentEditorCss.match(/@container\s+fbls-resident-editor/g) ?? []).length < 3) failures.push("resident work-and-housing layout needs wide, compact, and narrow container fallbacks");
  if (!residentEditorTemplate.includes("fbls-volunteer-toggle") || residentEditorTemplate.includes(">Доброволец</span>")) failures.push("resident volunteer control must use the compact aligned checkbox shell");
  if (!/\.person-volunteer\s*\{\s*grid-column:\s*span\s*2;/.test(residentEditorCss)) failures.push("resident volunteer flag and text must occupy two compact wide-grid columns");
  if (!/label\.person-appearance,[\s\S]{0,120}display:\s*flex;[\s\S]{0,80}flex-direction:\s*column;/.test(residentEditorCss)) failures.push("resident appearance textarea must grow its label and fieldset instead of overflowing them");
  if (!residentEditorTemplate.includes("fbls-work-allocation-total-field")) failures.push("resident work allocation total must use a normal label/control field rhythm");
  if (/<em>\{\{moraleTooltip\}\}<\/em>/.test(residentEditorTemplate) || !/fbls-derived-box" data-fbls-tooltip="\{\{moraleTooltip\}\}"/.test(residentEditorTemplate)) failures.push("resident morale breakdown must stay in a tooltip instead of stretching the card");
  if (!residentEditorTemplate.includes("fbls-trait-current") || !residentEditorTemplate.includes("fbls-trait-add-field")) failures.push("resident traits must expose aligned current and add fields");
  if (!uniqueBuildingEditorTemplate.includes("fbls-unique-medical-development")
    || !uniqueBuildingEditorTemplate.includes("{{#each building.bonusParts}}")
    || !uniqueBuildingEditorTemplate.includes('data-field="{{path}}"')) {
    failures.push("medical unique-building editor must expose the shared settlement development bonus fields");
  }
  if (!/\.fbls-unique-medical-development-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s.test(medicalBuildingCss)) failures.push("medical development bonuses must stay on one compact four-column row");
  if (!/\.fbls-unique-medical\s*>\s*\.fbls-unique-editor-tab,[\s\S]{0,160}overflow-y:\s*auto/.test(medicalBuildingCss)) failures.push("medical editor tabs must scroll inside the fixed unique-building window");

  assert.deepEqual(failures, [], `UI contract violations:\n${failures.join("\n")}`);
  return { buttonCount, delegatedRoleCount, iconOnlyCount, searchInputCount, templateCount: files.length };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = checkUiContract();
  console.log(`FBL Skyhold UI contract: ${result.templateCount} templates; ${result.buttonCount} buttons; ${result.iconOnlyCount} icon-only controls; ${result.delegatedRoleCount} delegated role buttons; ${result.searchInputCount} wired search fields. All checks passed.`);
}
