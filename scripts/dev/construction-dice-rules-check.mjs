import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { constructionContributionDetail, normalizeConstructionDiceRules } from "../engines/workers/construction-dice.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { workerTypeFromAttributes, workerTypeStyleFromAttributes } from "../generators/resident-rules.js";
import { mergeHoldingDefaults } from "../data/normalizers.js";
import { buildPlayerPatch, validatePlayerPatch } from "../data/player-write-guard.js";
import { SkyholdData } from "../data/store.js";
import { getSkyholdAppClass, registerSkyholdAppClass } from "../apps/registry.js";

export async function checkConstructionDiceRules() {
  const attributeKeys = ["strength", "agility", "wits", "empathy"];
  const paletteSource = readFileSync(new URL("../../styles/parts/skyhold-variables.css", import.meta.url), "utf8");
  for (const key of attributeKeys) {
    assert.match(paletteSource, new RegExp(`--fbls-worker-${key}:\\s*rgba\\(`), `${key}: worker hue belongs to the shared palette`);
  }
  for (let mask = 0; mask < 16; mask++) {
    const attributes = Object.fromEntries(attributeKeys.map((key, index) => [key, mask & (1 << index) ? 5 : 3]));
    const type = workerTypeFromAttributes(attributes);
    assert.equal(BuildingWorkerDomain._workerTypeChipStyle(type), workerTypeStyleFromAttributes(attributes), `${type}: crew chips must use the resident palette`);
    const style = workerTypeStyleFromAttributes(attributes);
    if (mask) {
      assert.match(style, /color: var\(--fbls-text-strong\)/, `${type}: worker text uses the shared strong color`);
      assert.doesNotMatch(style, /rgba\(|#[\da-f]{3,8}/i, `${type}: worker color literals belong to the CSS palette`);
    }
  }
  const calculate = (rules, type = "Мастеровой", traits = ["мастеровой", "крепкий"], suitableTypes = ["мастеровой"]) => constructionContributionDetail({
    rules, type, traits, suitableTypes,
    matchesType: (worker, criterion) => worker.toLowerCase() === criterion
  });
  assert.equal(calculate().dice, 5, "default type, suitable type and both traits stack with the base");
  assert.equal(calculate({ base: 4, professional: 3, suitable: 2, cap: 8 }).dice, 8, "custom cap applies after all bonuses");
  assert.equal(calculate({ professional: 0, suitable: 0, craftsman: 0, strong: 0 }).dice, 1, "zero disables individual bonuses");
  assert.equal(calculate({ base: 0, cap: 0 }).dice, 0, "zero base and zero cap are preserved");
  assert.equal(calculate({ professionalTypes: "" }, "Мастеровой", [], []).dice, 1, "empty professional list disables the type bonus");
  assert.equal(calculate({ professionalTypes: "Умелец; Силач", professional: 3 }, "Умелец", [], []).dice, 4, "custom professional types affect labor");
  assert.equal(calculate({ professionalTypes: "Мастер, Мастеровой" }, "Мастеровой", [], []).dice, 2, "matching several professional types does not duplicate the bonus");
  for (const [trait, expected] of [["больная спина", 0], ["рассеянный", 0], ["пьяница", 0], ["саботажник", 0]]) {
    assert.equal(calculate({}, "Разнорабочий", [trait], []).dice, expected, `${trait}: default penalty and zero floor`);
  }
  assert.equal(calculate({ badBack: 2 }, "Разнорабочий", ["больная спина"], []).dice, 3, "GM may change a trait modifier's sign");
  assert.equal(calculate({ traitRules: [{ name: "Грамотный", dice: 3 }] }, "Разнорабочий", ["грамотный", "крепкий"], []).dice, 4, "configured list adds new traits and excludes removed defaults");
  assert.equal(calculate({ traitRules: [] }).dice, 3, "empty list disables all trait contributions without disabling type bonuses");
  assert.deepEqual(normalizeConstructionDiceRules({ traitRules: [{ name: "Грамотный", dice: 2 }, { name: "грамотный", dice: 5 }] }).traitRules, [{ name: "Грамотный", dice: 2 }], "trait modifiers cannot be duplicated by letter case");
  assert.equal(normalizeConstructionDiceRules({ strong: 4 }).traitRules.find((row) => row.name === "Крепкий").dice, 4, "legacy custom trait amounts survive the editable list projection");
  const malformed = normalizeConstructionDiceRules({ base: null, cap: Infinity, suitable: "oops", strong: 999, saboteur: -999, coordination: "2.9" });
  assert.deepEqual([malformed.base, malformed.cap, malformed.suitable, malformed.strong, malformed.saboteur, malformed.coordination], [1, 6, 1, 20, -20, 2]);
  assert.equal(normalizeConstructionDiceRules(null).base, 1);
  const frozen = Object.freeze({ base: 3, professionalTypes: "Умелец" });
  assert.doesNotThrow(() => normalizeConstructionDiceRules(frozen), "reading rules does not mutate stored data");
  const stored = mergeHoldingDefaults({ id: "rules", gm: { constructionDiceRules: frozen } });
  assert.deepEqual(stored.gm.constructionDiceRules, frozen, "ordinary holding normalization preserves configured rules");
  assert.equal(Object.hasOwn(mergeHoldingDefaults({ id: "default" }).gm, "constructionDiceRules"), false, "loading a legacy holding does not write rule defaults");

  const manager = {
    ...AssignmentDomain,
    _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    _canResidentWork: (person) => !person.away,
    _workerType: (person) => person.workerType || "Разнорабочий",
    _attributeSummary: () => "",
    _traitBadges: (text = "") => text.split(",").map((name) => ({ name: name.trim() })),
    _workerTypeMatchesCriterion: (type, criterion) => type.toLowerCase() === criterion,
    _calculateMorale: () => 0,
    _moraleState: () => ({ label: "Апатия" })
  };
  const holding = {
    id: "rules", visibility: "public", gm: { playersCanEditBuildings: true, constructionDiceRules: { base: 2, suitable: 3, coordination: 4 }, efficiencyModifiers: { constructionCrew: 1 } },
    people: { list: [
      { id: "leader", name: "Лидер", workerType: "Умелец", attributes: { wits: 4, empathy: 4 }, traitsText: "Лидер" },
      { id: "one", workerType: "Умелец" }, { id: "two" }
    ] },
    buildings: { list: [] },
    constructionCrews: [{ id: "crew", memberIds: ["one", "two"], leaderId: "leader", suitableWorkerTypes: "Умелец" }]
  };
  const crew = holding.constructionCrews[0];
  const prepared = manager._prepareConstructionCrew(holding, crew);
  assert.deepEqual(prepared.members.map((person) => person.contribution), [5, 2]);
  assert.equal(prepared.leader.contribution, 5, "leader uses the same custom labor rules");
  assert.equal(prepared.leaderBonus, 4);
  assert.equal(prepared.rawDice, 17, "all labor, custom coordination and GM modifier feed the real pool");
  assert.equal(prepared.dice, 9, "morale applies after custom rules");
  assert.equal(manager._prepareConstructionCrew(holding, { ...crew, memberIds: ["one"] }).leaderBonus, 0, "custom coordination still requires two workers");

  const data = { meta: { revision: 1 }, holdings: [holding] };
  for (const mutate of [
    (draft) => { draft.holdings[0].gm.constructionDiceRules.base = 20; },
    (draft) => { draft.holdings[0].gm.constructionDiceRules.professionalTypes = "Все"; },
    (draft) => { draft.holdings[0].gm.constructionDiceRules.traitRules = [{ name: "Грамотный", dice: 20 }]; },
    (draft) => { delete draft.holdings[0].gm.constructionDiceRules; }
  ]) {
    const draft = structuredClone(data);
    mutate(draft);
    assert.equal(validatePlayerPatch(data, buildPlayerPatch(data, draft), "player").ok, false, "player cannot change or reset GM rules even with building edit permission");
  }

  const previous = { game: globalThis.game, foundry: globalThis.foundry, ui: globalThis.ui, view: SkyholdData.view, updateHolding: SkyholdData.updateHolding, appClass: getSkyholdAppClass() };
  try {
    globalThis.foundry = { applications: { api: { ApplicationV2: class { async _prepareContext() { return {}; } }, HandlebarsApplicationMixin: (base) => base } } };
    globalThis.game = { user: { id: "gm", isGM: true }, users: [], socket: { emit() {} } };
    const warnings = [];
    globalThis.ui = { notifications: { warn: (message) => warnings.push(message) } };
    const { SkyholdCrewEditor } = await import("../apps/editors/crew-editor.js");
    registerSkyholdAppClass(null);
    SkyholdData.view = () => data;
    let writes = 0;
    SkyholdData.updateHolding = async (id, update, options) => {
      assert.equal(id, holding.id);
      assert.equal(options.fallback, false);
      writes++;
      return update(holding);
    };
    const editor = new SkyholdCrewEditor({ holdingId: holding.id });
    editor.requestRender = () => Promise.resolve();
    const event = (key, value) => ({ preventDefault() {}, currentTarget: { dataset: { constructionRule: key }, value } });
    const gmContext = await editor._prepareContext({});
    assert.deepEqual(gmContext.ruleGroups.flatMap((group) => group.fields.map((field) => field.key)).sort(), gmContext.ruleFields.map((field) => field.key).sort(), "grouped UI preserves every setting exactly once");
    assert.equal(gmContext.canEditRules, true);
    assert.equal(gmContext.ruleFields.find((field) => field.key === "base").value, 2, "rules are visible even without an active manager or assigned residents");
    await editor._onConstructionRuleChange(event("base", "3"));
    assert.equal(holding.gm.constructionDiceRules.base, 3);
    assert.equal(holding.gm.constructionDiceRules.coordination, 4, "editing one field preserves other overrides");
    for (const value of ["", "1.5", "21", "abc"]) await editor._onConstructionRuleChange(event("base", value));
    await editor._onConstructionRuleChange(event("unknown", "1"));
    assert.equal(writes, 1, "invalid fields and values never reach persistence");
    assert.equal(warnings.length, 4);
    const renderContext = editor._crewRenderContext(holding, manager);
    const slots = editor._crewSlots(holding, manager, crew, renderContext);
    assert.match(slots[0].options.find((option) => option.id === "one").hint, /6к6/, "slot preview uses configured rules too");
    globalThis.game.user = { id: "player", isGM: false };
    const playerContext = await editor._prepareContext({});
    assert.equal(playerContext.canEditRules, false);
    assert.equal(playerContext.rules.base, 3, "player sees actual GM-configured values");
    await editor._onConstructionRuleChange(event("base", "10"));
    await editor._onResetConstructionRules(event("", ""));
    assert.equal(writes, 1, "forged player UI events cannot write or reset rules");
    await editor._changeConstructionTrait("Грамотный");
    await editor._changeConstructionTrait("Крепкий", true);
    await editor._onConstructionRuleChange(event("trait:Крепкий", "10"));
    assert.equal(writes, 1, "player cannot add, delete or change trait rules");
    globalThis.game.user.isGM = true;
    await editor._changeConstructionTrait("Грамотный");
    assert.equal(holding.gm.constructionDiceRules.traitRules.find((row) => row.name === "Грамотный").dice, 1);
    await editor._onConstructionRuleChange(event("trait:Грамотный", "-3"));
    assert.equal(holding.gm.constructionDiceRules.traitRules.find((row) => row.name === "Грамотный").dice, -3);
    await editor._changeConstructionTrait("Крепкий", true);
    assert.equal(holding.gm.constructionDiceRules.traitRules.some((row) => row.name === "Крепкий"), false);
    await editor._onConstructionRuleChange(event("base", "2"));
    assert.equal(holding.gm.constructionDiceRules.traitRules.some((row) => row.name === "Крепкий"), false, "editing other settings must not resurrect removed traits");
    assert.deepEqual(mergeHoldingDefaults(holding).gm.constructionDiceRules.traitRules, holding.gm.constructionDiceRules.traitRules, "custom trait rules survive holding normalization");
    await editor._onResetConstructionRules(event("", ""));
    assert.equal(Object.hasOwn(holding.gm, "constructionDiceRules"), false);
    assert.equal(holding.gm.efficiencyModifiers.constructionCrew, 1, "reset affects only dice rules");
    assert.equal(normalizeConstructionDiceRules(holding.gm.constructionDiceRules).base, 1);
  } finally {
    globalThis.game = previous.game;
    globalThis.foundry = previous.foundry;
    globalThis.ui = previous.ui;
    SkyholdData.view = previous.view;
    SkyholdData.updateHolding = previous.updateHolding;
    registerSkyholdAppClass(previous.appClass);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkConstructionDiceRules();
  console.log("Construction dice rules: calculation, persistence, player protection and editor checks passed.");
}
