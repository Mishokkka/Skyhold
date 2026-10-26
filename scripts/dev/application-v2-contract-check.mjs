import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Linter } from "eslint";

// Getter-only instance properties in ApplicationV2 / HandlebarsApplicationMixin.
// Verified against the installed Foundry 13.351 implementation; retained in V14.
const READ_ONLY = new Set(["window", "classList", "id", "title", "element", "form", "minimized", "rendered", "state", "hasFrame", "parts"]);
const CLASS_TYPES = new Set(["ClassDeclaration", "ClassExpression"]);
const linter = new Linter();
function nodes(root) {
  const result = [];
  const visit = (node) => {
    if (!node?.type) return;
    result.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value?.type) visit(value);
    }
  };
  visit(root); return result;
}
function parse(source, file) {
  let tree;
  const messages = linter.verify(source, [{ languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: { capture: { rules: { ast: { create: () => ({ "Program:exit": (node) => { tree = node; } }) } } } },
    rules: { "capture/ast": "error" } }]);
  assert.equal(messages.length, 0, `${file}: ${messages.map((row) => row.message).join("; ")}`);
  return tree;
}
const nameOf = (node) => node?.type === "Identifier" ? node.name : node?.type === "Literal" ? node.value : "";
const namesIn = (node) => nodes(node).filter((entry) => entry.type === "Identifier").map((entry) => entry.name);
function audit(sources) {
  const entries = sources.map(({ file, source }) => ({ file, all: nodes(parse(source, file)) }));
  const classes = entries.flatMap(({ all }) => all.filter((node) => CLASS_TYPES.has(node.type)));
  const applicationNames = new Set(["ApplicationV2"]), applicationClasses = new Set();
  let changed;
  do {
    changed = false;
    for (const cls of classes) {
      if (applicationClasses.has(cls) || !namesIn(cls.superClass).some((name) => applicationNames.has(name))) continue;
      applicationClasses.add(cls); if (cls.id) applicationNames.add(cls.id.name); changed = true;
    }
  } while (changed);
  // Shared mixins also execute on these applications, even when their local base is named Base.
  const mixins = new Set([...applicationClasses].flatMap((cls) => namesIn(cls.superClass)));
  for (const cls of classes) {
    for (let parent = cls.parent; parent; parent = parent.parent) {
      if (parent.type === "FunctionDeclaration" && mixins.has(parent.id?.name)) applicationClasses.add(cls);
    }
  }
  const findings = [];
  for (const { file, all } of entries) {
    const report = (node, name) => { if (READ_ONLY.has(name)) findings.push(`${file}:${node.loc.start.line}: read-only ApplicationV2.${name}`); };
    const target = (node) => {
      if (node?.type === "MemberExpression" && node.object.type === "ThisExpression") report(node, nameOf(node.property));
      else if (node?.type === "ObjectPattern") node.properties.forEach((row) => target(row.value ?? row.argument));
      else if (node?.type === "ArrayPattern") node.elements.forEach(target);
      else if (node?.type === "AssignmentPattern") target(node.left);
    };
    for (const node of all) {
      let owner = node.parent;
      while (owner && !CLASS_TYPES.has(owner.type)) owner = owner.parent;
      if (!applicationClasses.has(owner)) continue;
      if (node.type === "AssignmentExpression") target(node.left);
      if (node.type === "UpdateExpression") target(node.argument);
      if (node.type === "PropertyDefinition" && !node.static) report(node, nameOf(node.key));
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.name === "Object" && node.arguments[0]?.type === "ThisExpression") {
        if (nameOf(node.callee.property) === "assign") for (const value of node.arguments.slice(1)) {
          if (value.type === "ObjectExpression") for (const property of value.properties) report(property, nameOf(property.key));
        }
        if (nameOf(node.callee.property) === "defineProperty") report(node, nameOf(node.arguments[1]));
      }
    }
  }
  return { classes: applicationClasses.size, findings };
}
for (const assignment of ["this.state = {}", "this['element'] = null", "Object.assign(this, {title: 'x'})", "Object.defineProperty(this, 'parts', {})"]) {
  assert.equal(audit([{ file: "regression", source: `class App extends Mixin(ApplicationV2) { constructor() { super(); ${assignment}; } }` }]).findings.length, 1);
}
assert.equal(audit([{ file: "field-regression", source: "class App extends ApplicationV2 { state = {}; }" }]).findings.length, 1);
assert.equal(audit([{ file: "model", source: "class Model { constructor() { this.state = {}; this.id = 'x'; } }" }]).findings.length, 0);
assert.equal(audit([{ file: "parent", source: "class Parent extends ApplicationV2 {}" }, { file: "child", source: "class Child extends Parent { constructor() { super(); this.form = null; } }" }]).findings.length, 1);
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.name.endsWith(".js") ? [file] : [];
  });
}
const result = audit(files("scripts/apps").map((file) => ({ file, source: readFileSync(file, "utf8") })));
assert.ok(result.classes > 20, "the audit must discover the actual application inheritance graph");
assert.deepEqual(result.findings, [], result.findings.join("\n"));
console.log(`ApplicationV2 contract: ${result.classes} application/mixin classes; getter assignments, shadow fields and direct Object writes checked.`);
