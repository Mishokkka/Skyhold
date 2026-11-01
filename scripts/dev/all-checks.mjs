import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const commands = new Map();
function collect(name, ancestors = new Set()) {
  assert.ok(typeof scripts[name] === "string", `Unknown check script: ${name}`);
  assert.ok(!ancestors.has(name), `Recursive check script: ${name}`);
  const stack = new Set([...ancestors, name]);
  const command = scripts[name];
  for (const segment of command.split("&&")) {
    const nested = segment.match(/^\s*npm\s+run\s+([\w:-]+)\s*$/);
    if (nested) { collect(nested[1], stack); continue; }
    const match = segment.match(/^\s*node\s+(scripts\/dev\/[\w/-]+\.mjs)([^&]*)$/);
    assert.ok(match, `${name}: unsupported check command: ${segment.trim()}`);
    const args = [match[1], ...match[2].trim().split(/\s+/).filter(Boolean)];
    assert.notEqual(args[0], "scripts/dev/all-checks.mjs", `${name}: all-checks must not invoke itself`);
    commands.set(JSON.stringify(args), args);
  }
}
for (const name of Object.keys(scripts)) if (name === "check" || name.endsWith(":check")) collect(name);

let completed = 0;
const failures = [];
for (const args of commands.values()) {
  console.log(`[${++completed}/${commands.size}] ${args.join(" ")}`);
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: "inherit" });
  } catch (error) {
    failures.push(args.join(" "));
    console.error(`Check failed (${error.status ?? error.code}): ${args.join(" ")}`);
  }
}
if (failures.length) {
  console.error(`FBL Skyhold all checks: ${failures.length}/${completed} failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`FBL Skyhold all checks passed: ${completed} distinct commands, including the combined suites.`);
}
