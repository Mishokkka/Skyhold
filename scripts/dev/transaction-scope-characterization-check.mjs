import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";

const root = path.resolve(import.meta.dirname, "../..");
const productionRoot = path.join(root, "scripts");
const VALID_LITERAL_SCOPES = new Set(["holdings", "catalog", "both"]);
const VALID_CONSTANT_SCOPES = new Set(["HOLDINGS", "CATALOG", "BOTH"]);

function productionJavaScriptFiles(directory = productionRoot) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (absolute === path.join(productionRoot, "dev")) continue;
    if (statSync(absolute).isDirectory()) files.push(...productionJavaScriptFiles(absolute));
    else if (absolute.endsWith(".js")) files.push(absolute);
  }
  return files;
}

function isSkyholdTransaction(node) {
  return node?.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && node.callee.computed !== true
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === "SkyholdData"
    && node.callee.property?.name === "transaction";
}

function isKnownScopeExpression(node) {
  if (node?.type === "Literal") return VALID_LITERAL_SCOPES.has(node.value);
  if (node?.type === "MemberExpression" && node.computed !== true) {
    return node.object?.name === "COMMIT_SCOPES" && VALID_CONSTANT_SCOPES.has(node.property?.name);
  }
  if (node?.type === "ConditionalExpression") {
    return isKnownScopeExpression(node.consequent) && isKnownScopeExpression(node.alternate);
  }
  return false;
}

function scopeProperty(optionsNode) {
  if (optionsNode?.type !== "ObjectExpression") return null;
  return optionsNode.properties.find((property) => property?.type === "Property"
    && property.computed !== true
    && (property.key?.name === "scope" || property.key?.value === "scope")) ?? null;
}

function explicitTransactionScopeRule(context) {
  return {
    CallExpression(node) {
      if (!isSkyholdTransaction(node)) return;
      const property = scopeProperty(node.arguments[1]);
      if (!property) {
        context.report({ node, message: "SkyholdData.transaction must declare an explicit storage scope." });
        return;
      }
      if (!isKnownScopeExpression(property.value)) {
        context.report({ node: property.value, message: "Transaction scope must resolve locally to holdings, catalog, or both." });
      }
    }
  };
}

export function checkTransactionScopeCharacterization() {
  const linter = new Linter({ configType: "flat" });
  const config = [{
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: {
      skyhold: {
        rules: { "explicit-transaction-scope": { create: explicitTransactionScopeRule } }
      }
    },
    rules: { "skyhold/explicit-transaction-scope": "error" }
  }];
  const failures = [];
  let transactionCount = 0;

  for (const file of productionJavaScriptFiles()) {
    const source = readFileSync(file, "utf8");
    const messages = linter.verify(source, config, { filename: file });
    transactionCount += source.match(/\bSkyholdData\.transaction\s*\(/g)?.length ?? 0;
    for (const message of messages) {
      failures.push(`${path.relative(root, file)}:${message.line}:${message.column} ${message.message}`);
    }
  }

  assert.ok(transactionCount > 0, "transaction scope inventory must cover production callsites");
  assert.deepEqual(failures, [], `every direct SkyholdData transaction needs an explicit, locally auditable scope:\n${failures.join("\n")}`);

  const contentImporter = readFileSync(path.join(root, "scripts/apps/editors/content-pack-importer.js"), "utf8");
  const laputaImporter = readFileSync(path.join(root, "scripts/apps/editors/laputa-migration-importer.js"), "utf8");
  const holdingService = readFileSync(path.join(root, "scripts/data/holding-service.js"), "utf8");
  const store = readFileSync(path.join(root, "scripts/data/store.js"), "utf8");
  const regionEditor = readFileSync(path.join(root, "scripts/apps/editors/region-catalog-editor.js"), "utf8");
  assert.match(contentImporter, /content-pack:\$\{operationId\}`\s*,\s*scope:\s*["']both["']/, "content-pack import must retain both-partition scope");
  assert.match(laputaImporter, /reason:\s*`laputa-economy-migration:[^`]+`[\s\S]{0,160}scope:\s*["']both["']/, "Laputa migration must retain both-partition scope");
  assert.match(holdingService, /holding-service:update-data["']\s*,\s*scope:\s*["']both["']/, "generic HoldingService updates must retain both-partition scope");
  assert.match(store, /reason:\s*["']import-laputa["']\s*,\s*scope:\s*COMMIT_SCOPES\.BOTH/, "Laputa import must retain both-partition scope");
  assert.match(regionEditor, /reason:\s*["']region-catalog:delete["']\s*,\s*scope:\s*["']both["']/, "region deletion must retain both-partition scope because it rewrites holding references");
  assert.match(regionEditor, /scope:\s*key\s*===\s*["']value["']\s*\?\s*["']both["']\s*:\s*["']catalog["']/, "region id changes must retain conditional both-partition scope");

  return { transactionCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkTransactionScopeCharacterization();
  console.log(`FBL Skyhold transaction scope characterization passed (${result.transactionCount} direct transactions).`);
}
