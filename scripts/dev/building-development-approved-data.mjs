import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const keys = ["food", "technology", "culture", "war"];
const vector = (value) => Object.fromEntries(keys.map((key, index) => [key, Number(value.split("/")[index])]));
const text = readFileSync(new URL("../../docs/building-development-approved.md", import.meta.url), "utf8");
const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
export const APPROVED_BONUS_DECISIONS = text.split("## Бонусы")[1].split("## Требования")[0]
  .split(/\r?\n/).filter((line) => /^\| [ABCD]\d{2} \|/.test(line)).map(cells);
export const APPROVED_REQUIREMENT_DECISIONS = text.split("## Требования")[1].split(/\r?\n/)
  .filter((line) => /^\| [a-z][a-z-]+ \|/.test(line)).map(cells);

export function applyApprovedDevelopment(rows) {
  assert.equal(APPROVED_BONUS_DECISIONS.length, 60);
  assert.equal(APPROVED_REQUIREMENT_DECISIONS.length, 37);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [, id, , before, after] of APPROVED_BONUS_DECISIONS) {
    const row = byId.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.bonuses, vector(before), `${id}: bonus decision source has changed`);
    row.bonuses = vector(after);
    if (!(row.bonuses[row.primaryDev] > 0)) {
      const best = keys.reduce((a, b) => row.bonuses[b] > row.bonuses[a] ? b : a);
      if (row.bonuses[best] > 0) row.primaryDev = best;
    }
  }
  for (const [id, , before, after] of APPROVED_REQUIREMENT_DECISIONS) {
    const row = byId.get(id);
    assert.ok(row, id);
    assert.deepEqual(row.requirements, vector(before), `${id}: requirement decision source has changed`);
    row.requirements = vector(after);
  }
  return rows;
}
