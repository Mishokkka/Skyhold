import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { templateBranchVisible, templateBrowserScope, filterTemplateRows, templatePassport, templateSearchText, templateListBonusChips, templateListPresentation } from "../apps/domains/building/template-browser-model.js";

export function checkTemplateBrowser() {
  const center = { id: "construction-center", name: "Центр", developmentStage: 3 };
  const early = { id: "mill", name: "Мельница", primaryDev: "food", developmentStage: 1, unlocked: true, functions: { production: true }, materialCosts: [{ qty: 1 }], wageDailyCopper: 18 };
  const late = { id: "factory", name: "Фабрика", developmentStage: 4, unlocked: true };
  const hidden = { id: "secret", name: "Секрет", visibility: "gm", playerVisible: false, developmentStage: 1 };
  const catalog = { rows: [early, late, center, hidden] };
  const snapshot = JSON.stringify(catalog);
  const baseBonus = { icon: "food", text: "+2" };
  const chips = templateListBonusChips({ bonusChips: [baseBonus], reputation: 2, moraleDelta: -1, workerMoraleDelta: 4 });
  assert.deepEqual(chips.map((chip) => chip.text), ["2", "2", "1"], "list shows settlement reputation and morale, without substituting worker morale");
  assert.equal(chips[2].negative, true);
  assert.equal(templateListPresentation({ hasBuilt: true, unlocked: false }).listState, "built", "built appearance takes priority over current admission requirements");
  assert.equal(templateListPresentation({ hasBuilt: true }).showBuiltCheck, true);
  assert.equal(templateListPresentation({ hasBuilt: true, repeatSettlementEffects: true }).showBuiltCheck, false);
  const leisureRepeat = templateListPresentation({ hasBuilt: true, bonusChips: [baseBonus], reputation: 2, moraleDelta: 99,
    service: { leisure: { kind: "games", capacity: 20 } } });
  assert.equal(leisureRepeat.showBuiltCheck, false, "A built leisure venue can still contribute repeated morale");
  assert.deepEqual(leisureRepeat.listBonusChips.map((chip) => chip.text), ["20"], "Repeated leisure shows its capacity, not repeated development or reputation");
  assert.equal(templateListPresentation({ unlocked: false }).listState, "locked");
  assert.equal(templateListPresentation({ unlocked: true }).listState, "available");
  assert.deepEqual(templateListBonusChips({ reputation: 0, moraleDelta: 0 }), []);
  const holding = (lifecycle, condition = "intact", repair = {}) => ({ buildings: { list: [{ templateId: center.id, lifecycle, condition, repair }] } });
  for (const canEdit of [false, true]) {
    for (const lifecycle of ["planned", "building", "abandoned"]) {
      const scope = templateBrowserScope(catalog, holding(lifecycle), canEdit, "all");
      assert.deepEqual(scope.publicRows.map((row) => row.id), [early.id, center.id], "unbuilt Center branch must be absent before search and counters, for GM and player");
      assert.equal(scope.hiddenRows.some((row) => row.id === late.id), false);
    }
    assert.equal(templateBrowserScope(catalog, holding("active"), canEdit, "all").publicRows.length, 3);
  }
  assert.equal(templateBranchVisible(late, holding("active", "damaged", { active: true })), true);
  assert.equal(templateBranchVisible(late, holding("disabled")), true);
  assert.equal(templateBranchVisible(late, holding("active", "destroyed")), false);
  assert.equal(templateBranchVisible({ requiredBuildingIds: [center.id] }, {}), false, "explicit Center dependency also hides custom early templates");
  assert.equal(templateBranchVisible(center, {}), true);
  assert.equal(templateBrowserScope(catalog, {}, false, "hidden").scopedRows.some((row) => row.id === hidden.id), false);
  assert.equal(templateBrowserScope({ rows: [{ ...late, visibility: "gm" }] }, {}, true, "hidden").hiddenRows.length, 0);
  assert.deepEqual(templateBrowserScope(catalog, {}, true, "hidden").scopedRows, [hidden]);
  assert.deepEqual(filterTemplateRows(catalog.rows, { purpose: "production", category: "food", stage: "1", availability: "available" }), [early]);
  assert.deepEqual(filterTemplateRows([{ ...early, hasBuilt: true }, late], { availability: "built" }).map((row) => row.id), [early.id]);
  assert.deepEqual(filterTemplateRows([late, early], { sort: "stage" }), [early, late]);
  assert.equal(templatePassport(null, []), null);
  const passport = templatePassport({ ...early, requiredBuildingIds: ["secret"] }, [early], [{ id: "recipe", mode: "Мука", active: true, totalPreview: "6 за 1 QD", resource: "Мука", expenses: "grain 6", expenseMode: "unit" }]);
  assert.equal(passport.dependenciesText, "Все: Недоступный чертёж", "passport must not leak private template names");
  assert.equal(passport.wageText, "1 СМ 8 ММ");
  assert.equal(passport.recipes[0].cycleText, "6 за 1 QD", "passport must use shared production cycle formatting");
  assert.equal(passport.recipes[0].expensePeriod, "за единицу выпуска");
  const duplicatedRules = { siteRequirementsText: "Рыбный водоём и безопасный берег.", specialRequirements: "Рыбный водоём и безопасный берег. Нужен доступ к дороге.", effect: "Рыбный водоём и безопасный берег. Даёт рыбу.", notes: "Нужен доступ к дороге. Особая заметка." };
  const rulesSnapshot = JSON.stringify(duplicatedRules);
  const cleaned = templatePassport(duplicatedRules, []);
  assert.equal(cleaned.siteRequirementsText, duplicatedRules.siteRequirementsText);
  assert.equal(cleaned.specialRequirements, "Нужен доступ к дороге.");
  assert.equal(cleaned.effect, "Даёт рыбу.");
  assert.equal(cleaned.notes, "Особая заметка.");
  assert.equal(JSON.stringify(duplicatedRules), rulesSnapshot, "deduplication must not rewrite authored rules");
  assert.equal(templatePassport({ siteRequirementsText: "Безопасный берег.", specialRequirements: "Безопасный берег и причал." }, []).specialRequirements, "Безопасный берег и причал.", "distinct requirements must survive without fuzzy matching");
  assert.equal(templatePassport({ siteRequirementsText: " Рыбный водоём. ", specialRequirements: "РЫБНЫЙ   ВОДОЕМ" }, []).specialRequirements, "");
  const search = templateSearchText({ name: "Жильё", productionLines: [{ expenses: "grain 2 ИЛИ wood 1", resourceId: "flour" }] });
  assert.match(search, /жилье/);
  assert.match(search, /grain/);
  assert.match(search, /flour/);
  assert.match(templateSearchText({ productionLines: [{ expenses: "Особая руда 2", resource: "Слиток" }] }), /особая руда/);
  const template = readFileSync(new URL("../../templates/building-template-browser.hbs", import.meta.url), "utf8");
  assert.equal((template.match(/data-template-passport/g) ?? []).length, 1, "only selected template has a full passport");
  assert.match(template, /data-render-scroll-key="template-detail-\{\{id\}\}"/, "passport scroll is preserved per template by the shared scheduler");
  assert.match(template, /data-render-scroll-key="template-list"/, "catalog scroll uses the shared scheduler");
  const appSource = readFileSync(new URL("../apps/editors/template-browser.js", import.meta.url), "utf8");
  assert.doesNotMatch(template, /Чертежи поселения|holding\.name/, "inner heading must not consume catalog space");
  assert.match(template, /data-template-search-disclosure[\s\S]*searchExpanded/, "search expansion is preserved across renders");
  assert.match(template, /\{\{deficit\}\}/, "list must show deficits, not full requirements");
  const actionBlock = appSource.match(/const TEMPLATE_BROWSER_ACTIONS = \{([\s\S]*?)\n\};/)[1];
  const actions = new Map([...actionBlock.matchAll(/"([^"]+)": "([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const usedActions = new Set([...template.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...actions.keys()].sort(), [...usedActions].sort(), "every browser action must have exactly one mapped handler");
  for (const handler of actions.values()) assert.ok(appSource.includes(`${handler}(event)`), `missing browser handler ${handler}`);
  assert.equal(JSON.stringify(catalog), snapshot, "browsing must not mutate the catalog");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkTemplateBrowser();
  console.log(`Template browser model passed (${fileURLToPath(import.meta.url)}).`);
}
