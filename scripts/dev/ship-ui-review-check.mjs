import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createShipReviewState, shipReviewContext, formatShipReviewSummary, inertShipReviewHtml, SHIP_REVIEW_VARIANTS } from "../apps/domains/ui-review-ships.js";

const draft = createShipReviewState();
assert.equal(SHIP_REVIEW_VARIANTS.length, 4, "current view plus three alternatives");
assert.ok(Object.values(draft.decisions).every(row => row.choice === "compact"), "all five sections reflect the user's explicit approval of A");
const decisionsBeforeVariantChange = JSON.stringify(draft.decisions);
shipReviewContext({ ...draft, variant: "steps" });
assert.equal(JSON.stringify(draft.decisions), decisionsBeforeVariantChange, "previewing another layout never changes the approved decisions");
for (const permission of ["gm", "edit", "view"]) {
  for (const scenario of ["home", "blocked", "sailing", "port", "sale", "empty"]) {
    const context = shipReviewContext({ ...draft, permission, scenario, panel: "settings" });
    assert.equal(context.isGM, permission === "gm");
    assert.equal(context.tabs.some(row => row.id === "settings"), permission === "gm");
    assert.equal(context.ship.canAdjust, permission === "gm", "financial adjustments remain GM-only");
    if (permission !== "gm") assert.equal(context.panel, "orders", "a previously selected GM panel cannot survive a permission switch");
    if (permission === "view") assert.equal(context.canDepart, false);
    if (["blocked", "sailing", "sale", "empty"].includes(scenario)) assert.equal(context.canDepart, false);
    if (["sailing", "sale"].includes(scenario)) assert.equal(context.ship.offers.length, 0, "active shipments do not become new-order selection");
    assert.equal(context.ship.moneySummary.freeCopper,
      context.ship.moneySummary.balanceCopper - context.ship.moneySummary.obligationsCopper - context.ship.moneySummary.reserveCopper,
      "pending receipts are excluded and reserves are not counted as paid expenses");
  }
}
assert.equal(shipReviewContext(draft).canDepart, true);
assert.equal(shipReviewContext({ ...draft, selected: [] }).canDepart, false);
assert.equal(shipReviewContext({ ...draft, selected: ["grain", "timber", "spice"] }).capacityReady, false);
assert.equal(shipReviewContext({ ...draft, scenario: "empty" }).ship.crewRoster.length, 0);
assert.ok(shipReviewContext({ ...draft, scenario: "empty" }).crewOptions.every(row => !row.selected));
const before = JSON.stringify(draft);
shipReviewContext(draft);
assert.equal(JSON.stringify(draft), before, "preparing a sample does not mutate decisions or draft selections");
draft.decisions.crew = { choice: "compact", note: "Строки плотнее" };
assert.match(formatShipReviewSummary(draft), /Экипаж: А · Компактные вкладки — Строки плотнее/);
assert.doesNotMatch(formatShipReviewSummary(draft), /Редактор здания|Основное:|Строительство:/, "only this batch appears in the copyable text");
const inert = inertShipReviewHtml('<button data-action="ship-delete" data-ship-bundle-select data-field="name" data-fbls-tooltip="Help" draggable="true">Delete</button>');
assert.doesNotMatch(inert, /\s(?:data-action|data-field|data-ship-bundle-select|draggable)[\s=>]/);
assert.match(inert, /data-fbls-tooltip="Help"/);
assert.match(inert, /data-review-source-action="ship-delete"/);
const source = readFileSync(new URL("../apps/domains/ui-review-ships.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /(?:SkyholdData|game\.settings|socket\.emit|ShipEventDomain|fetch\()/, "review has no world persistence or network commands");
const template = readFileSync(new URL("../../templates/parts/ui-review-ships.hbs", import.meta.url), "utf8");
assert.doesNotMatch(template, /\sdata-(?:action|field|ship-crew|ship-bundle-select)[\s=>]/, "proposal markup cannot be caught by production handlers");
console.log("Ship UI review: three alternatives, independent decisions, GM/player/view fixtures, money semantics and inert action hooks passed.");
