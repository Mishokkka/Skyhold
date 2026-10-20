import assert from "node:assert/strict";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { APPROVED_BONUS_DECISIONS, APPROVED_REQUIREMENT_DECISIONS } from "./building-development-approved-data.mjs";
import { preparationRoute } from "./building-preparation-revision-check.mjs";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { planBuildingCatalogMigration, applyBuildingCatalogMigration } from "../workflows/buildings/catalog-migration.js";

const keys = ["food", "technology", "culture", "war"];
const v = (row) => keys.map((key) => row[key]).join("/");
const parse = (value) => Object.fromEntries(keys.map((key, i) => [key, Number(value.split("/")[i])]));

export function checkApprovedBuildingDevelopment() {
  const rows = DEFAULT_BUILDING_TEMPLATES;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const leisureDevelopment = { inn: "2/0/1/0", "city-theatre": "0/0/3/0", museum: "0/1/3/0" };
  for (const [, id, , , after] of APPROVED_BONUS_DECISIONS) assert.equal(v(byId.get(id).bonuses), leisureDevelopment[id] ?? after, id);
  for (const [id, , , after] of APPROVED_REQUIREMENT_DECISIONS) assert.equal(v(byId.get(id).requirements), after, id);
  const overrides = { gallows: "0/0/0/1", dungeon: "0/0/1/1", "sheriff-post": "0/0/2/1", "guard-house": "0/0/2/2", waterworks: "3/2/2/0" };
  for (const [id, expected] of Object.entries(overrides)) assert.equal(v(byId.get(id).bonuses), expected, "User override must win over the audit suggestion");
  const retained = { bunkhouse: "0/0/1/1", inn: "2/0/1/0", school: "0/3/3/0", spire: "0/0/5/0", "hall-of-fame": "0/1/5/2", mansion: "0/0/3/0", "hiring-agency": "0/1/2/0", warehouse: "0/2/1/0", vineyard: "2/0/1/0", winery: "3/0/2/0" };
  for (const [id, expected] of Object.entries(retained)) assert.equal(v(byId.get(id).bonuses), expected, "Explicitly retained bonuses must not drift");
  assert.equal(APPROVED_BONUS_DECISIONS.filter(([, , , before, after]) => before !== after).length, 50);
  const ordinary = rows.filter((row) => Number.isInteger(row.developmentStage));
  for (const row of ordinary) {
    const route = preparationRoute(ordinary, [row.id]);
    assert.ok(route.order.length <= 60, `${row.id}: route must not require almost the entire catalog`);
    assert.equal(route.order.at(-1), row.id);
  }
  assert.equal(v(byId.get("meeting-house").requirements), "8/6/10/0");
  for (const row of ordinary.filter((r) => r.developmentStage === 0)) assert.equal(v(row.requirements), "0/0/0/0");

  // Existing v15 worlds must receive the revised rules through the explicit
  // replacement workflow too, without relying on a version-number downgrade.
  const old = structuredClone(rows);
  for (const [, id, , before] of APPROVED_BONUS_DECISIONS) old.find((r) => r.id === id).bonuses = parse(before);
  for (const [id, , before] of APPROVED_REQUIREMENT_DECISIONS) old.find((r) => r.id === id).requirements = parse(before);
  const source = normalizeSkyholdData({ meta: { templateCatalogVersion: 15, revision: 9 }, catalog: { buildings: old },
    holdings: [{ id: "test", buildings: { list: old.map((r) => ({ ...structuredClone(r), id: `instance-${r.id}`, templateId: r.id, constructionStatus: "built", buildProgress: r.buildTarget })) } }] });
  const snapshot = structuredClone(source);
  const plan = planBuildingCatalogMigration({ currentData: source, operationId: "approved-development-v15", replaceCatalog: true });
  assert.deepEqual(plan.blockingIssues, []);
  const applied = applyBuildingCatalogMigration({ currentData: source, plan });
  assert.equal(applied.commitRequired, true);
  assert.deepEqual(source, snapshot);
  for (const [, id, , , after] of APPROVED_BONUS_DECISIONS) assert.equal(v(applied.data.holdings[0].buildings.list.find((r) => r.templateId === id).bonuses), leisureDevelopment[id] ?? after);
  assert.equal(planBuildingCatalogMigration({ currentData: normalizeSkyholdData(applied.data), operationId: "repeat-approved", replaceCatalog: true }).hasChanges, false);
}
