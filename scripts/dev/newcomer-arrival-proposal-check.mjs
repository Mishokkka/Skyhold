import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Mathematical reference for the proposed rule, not a runtime event source.
export function proposedArrivalOdds(reputation, {
  completedPeriod = false, normalFood = false, wagesCurrent = false,
  rawMorale = -1, housingVacancy = 0, hunger = false, unresolvedRiot = false
} = {}) {
  const r = Math.max(0, Math.floor(Number(reputation) || 0));
  const sides = r ? Math.max(1, Math.floor(r / 6)) : 0;
  const prosperous = completedPeriod && normalFood && wagesCurrent && rawMorale >= 0 && housingVacancy > 0;
  const chance = !r || hunger || unresolvedRiot ? 0 : prosperous ? 2 / 6 : 1 / 6;
  return { sides, chance, expectedCandidates: chance * (sides + 1) / 2 };
}

export function checkArrivalProposal() {
  const prosperous = { completedPeriod: true, normalFood: true, wagesCurrent: true, rawMorale: 0, housingVacancy: 1 };
  const source = readFileSync(new URL("../../docs/newcomer-arrival-proposal.md", import.meta.url), "utf8");
  const table = [...source.matchAll(/^\| (\d+) \| [^|]+ \| ([\d,]+) \| ([\d,]+) \|/gm)];
  assert.equal(table.length, 6);
  for (const [, r, normal, good] of table) {
    assert.equal(proposedArrivalOdds(r).expectedCandidates.toFixed(2), normal.replace(",", "."));
    assert.equal(proposedArrivalOdds(r, prosperous).expectedCandidates.toFixed(2), good.replace(",", "."));
  }
  assert.deepEqual([0, 1, 5, 6, 11, 12, 17, 18, 54].map((r) => proposedArrivalOdds(r).sides), [0, 1, 1, 1, 1, 2, 2, 3, 9]);
  assert.equal(proposedArrivalOdds(0, prosperous).chance, 0);
  for (const missing of [{ completedPeriod: false }, { normalFood: false }, { wagesCurrent: false }, { rawMorale: -1 }, { housingVacancy: 0 }]) {
    assert.equal(proposedArrivalOdds(18, { ...prosperous, ...missing }).chance, 1 / 6);
  }
  for (const blocked of [{ hunger: true }, { unresolvedRiot: true }]) assert.equal(proposedArrivalOdds(54, { ...prosperous, ...blocked }).chance, 0);
  assert.equal(proposedArrivalOdds(54, prosperous).sides, 9, "One vacant bed does not truncate the generated group");
  assert.equal(proposedArrivalOdds(18).expectedCandidates * 24, 8);
  return { rowsChecked: table.length, ordinaryYearAtRep18: 8, prosperousYearAtRep18: 16 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(checkArrivalProposal()));
