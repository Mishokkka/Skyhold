import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FinanceEconomyDomain } from "../apps/domains/finance/economy-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { ResidentGeneratorEventDomain } from "../apps/domains/events/resident/generator-events.js";
import { normalizePerson } from "../data/normalizers/resident.js";
import { buildPlannedWorkSlots, validateWorkAllocationPlan } from "../data/work-allocations.js";
import { plannedWorkerQd } from "../engines/economy/finance-period.js";
import { generateResidents } from "../generators/resident-generator.js";
import {
  getTraitDefinition,
  TRAIT_DEFINITIONS,
  TRAIT_POOLS,
  WONDERWORKER_TRAIT_CHANCE_PERCENT,
  WONDERWORKER_TRAIT_NAME
} from "../generators/trait-definitions.js";
import {
  AGE_GROUP_ATTRIBUTE_BUDGETS,
  normalizeResidentAttribute,
  outstandingAttributeKeys,
  workerTypeFromAttributes
} from "../generators/resident-rules.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = ((state * 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function withRandom(random, callback) {
  const original = Math.random;
  Math.random = random;
  try { return callback(); }
  finally { Math.random = original; }
}

function getProperty(source, propertyPath = "") {
  return String(propertyPath).split(".").reduce((value, key) => value?.[key], source);
}

function checkAttributeContracts() {
  assert.equal(normalizeResidentAttribute(99), 6);
  assert.equal(normalizeResidentAttribute(-4), 1);
  assert.equal(normalizeResidentAttribute(4.9), 4);
  assert.equal(normalizeResidentAttribute("bad", 3), 3);
  assert.equal(normalizeResidentAttribute(null, 3), 3);
  assert.equal(normalizeResidentAttribute("", 3), 3);
  assert.equal(workerTypeFromAttributes({ strength: 6, agility: 3, wits: 3, empathy: 3 }), "Силач");
  assert.equal(workerTypeFromAttributes({ strength: 5, agility: 5, wits: 5, empathy: 2 }), "Мастеровой", "manual bounded residents may retain story-only triple types");

  const missing = { id: "missing-attributes", age: 30, race: "Человек" };
  normalizePerson(missing);
  assert.deepEqual(missing.attributes, { strength: 3, agility: 3, wits: 3, empathy: 3 }, "legacy residents without attributes must receive a neutral usable profile");

  const extreme = { id: "extreme-attributes", age: 30, race: "Человек", attributes: { strength: 99, agility: -4, wits: 4.9, empathy: "bad" } };
  normalizePerson(extreme);
  assert.deepEqual(extreme.attributes, { strength: 6, agility: 1, wits: 4, empathy: 3 }, "stored resident attributes must be integer-clamped to 1..6");

  const obsoleteProfession = { id: "old-profession", age: 30, race: "Человек", background: "лекарь", skill: "Healer", traitsText: "Надежный" };
  normalizePerson(obsoleteProfession);
  assert.equal(Object.hasOwn(obsoleteProfession, "skill"), false, "the obsolete resident profession field must be removed during normalization");
  assert.equal(obsoleteProfession.traitsText, "Надежный", "derived profession markers must not be converted into duplicate traits");

  const customLegacySkill = { id: "old-custom-skill", age: 30, race: "Человек", skill: "Автономность", traitsText: "Надежный" };
  normalizePerson(customLegacySkill);
  assert.equal(Object.hasOwn(customLegacySkill, "skill"), false);
  assert.equal(customLegacySkill.traitsText, "Надежный, Автономность", "a non-profession legacy value must survive as a custom trait");
}

function checkGeneratedPopulation() {
  const arrivals = ["settlers", "workers", "refugees", "specialists", "crew"];
  const ageModes = ["normal", "adults", "families", "young"];
  withRandom(seededRandom(0x51a7c0de), () => {
    for (const arrival of arrivals) {
      for (const ageMode of ageModes) {
        for (let batch = 0; batch < 25; batch += 1) {
          const residents = generateResidents({ quantity: 20, culture: "Нованд", arrival, ageMode, traitMode: "normal" });
          for (const person of residents) {
            const values = Object.values(person.attributes);
            assert.equal(values.every((value) => Number.isInteger(value) && value >= 1 && value <= 6), true, `${arrival}/${ageMode}: generated attributes must stay in 1..6`);
            assert.equal(values.reduce((sum, value) => sum + value, 0), AGE_GROUP_ATTRIBUTE_BUDGETS[person.ageGroup], `${arrival}/${ageMode}: generated budget must match age group`);
            assert.equal(outstandingAttributeKeys(person.attributes).length <= 2, true, `${arrival}/${ageMode}: the built-in generator cannot create triple types`);
            assert.equal(values.filter((value) => value === 6).length <= 1, true, `${arrival}/${ageMode}: at most one generated attribute may reach 6`);
            assert.equal(Object.hasOwn(person, "skill"), false, `${arrival}/${ageMode}: generated residents must not recreate the removed profession field`);
          }
        }
      }
    }
  });
}

function checkWonderworkerTrait() {
  assert.equal(WONDERWORKER_TRAIT_CHANCE_PERCENT, 0.1, "the exceptional generator chance must remain exactly 0.1 percent");
  assert.equal(getTraitDefinition(WONDERWORKER_TRAIT_NAME)?.category, "Сюжетная");
  const forced = withRandom(() => 0, () => generateResidents({ quantity: 1, arrival: "specialists", ageMode: "adults", traitMode: "normal" })[0]);
  assert.equal(forced.traitsText.split(/[,;\n]/).map((value) => value.trim()).includes(WONDERWORKER_TRAIT_NAME), true, "the rare successful roll must add Wonderworker independently of the ordinary trait count");
  const missed = withRandom(() => 0.5, () => generateResidents({ quantity: 1, arrival: "specialists", ageMode: "adults", traitMode: "normal" })[0]);
  assert.equal(missed.traitsText.includes(WONDERWORKER_TRAIT_NAME), false);
  const giftedChild = withRandom(() => 0, () => generateResidents({ quantity: 1, arrival: "settlers", ageMode: "families", traitMode: "normal" })[0]);
  assert.equal(giftedChild.ageGroup, "Ре");
  assert.equal(giftedChild.traitsText, WONDERWORKER_TRAIT_NAME, "the exceptional 0.1-percent roll applies to children even though ordinary child traits stay disabled");
  const traitsDisabled = withRandom(() => 0, () => generateResidents({ quantity: 1, arrival: "specialists", ageMode: "adults", traitMode: "none" })[0]);
  assert.equal(traitsDisabled.traitsText.includes(WONDERWORKER_TRAIT_NAME), false, "the explicit no-traits mode must remain authoritative");
}

function checkTraitFlavor() {
  assert.equal(TRAIT_DEFINITIONS.every((trait) => String(trait.description ?? "").trim().length >= 20), true, "every built-in trait needs a useful player-facing description");
  assert.equal(TRAIT_DEFINITIONS.some((trait) => /[+-]\s*\d+\s*%|куб(?:а|ов)?|ед\.\s*работы|производственн\w*\s+профил/i.test(trait.description)), false, "trait tooltips must describe personality rather than expose worker-engine arithmetic");
  for (const name of ["Терпеливый", "Любознательный", "Зоркий", "Душа компании", "Неуклюжий", "Злопамятный"]) {
    assert.ok(getTraitDefinition(name), `${name} must remain available as a roleplay trait`);
  }
  const knownNames = new Set(TRAIT_DEFINITIONS.map((trait) => trait.name));
  assert.equal(Object.values(TRAIT_POOLS).flat().every((name) => knownNames.has(name)), true, "every generated trait pool entry must resolve to a definition");
}

function checkActorImport() {
  const oldFoundry = globalThis.foundry;
  globalThis.foundry = { utils: { getProperty } };
  try {
    const harness = { ...ResidentGeneratorEventDomain };
    const imported = withRandom(seededRandom(0xacc701), () => harness._residentFromActorGenerated({
      name: "Доктор",
      uuid: "Actor.doctor",
      system: {
        age: 30,
        race: "Человек",
        background: "лекарь",
        attributes: {
          strength: { max: 99 },
          wits: { value: 2.9 },
          empathy: { max: -4 }
        }
      }
    }));
    assert.deepEqual(imported.attributes, { strength: 6, agility: 3, wits: 2, empathy: 3 }, "Actor import must clamp discovered values and use neutral 3 for missing or invalid fields");
    assert.equal(Object.hasOwn(imported, "skill"), false, "Actor import must use background directly instead of recreating a profession field");
  } finally {
    globalThis.foundry = oldFoundry;
  }
}

function checkChildWork() {
  const harness = {
    ...ResidentDomain,
    ...FinanceEconomyDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    _buildingHasOvertimeProduction: () => true
  };
  const youngChild = { id: "child-11", age: 11, race: "Человек", injuredDays: 0 };
  const workingChild = { id: "child-12", age: 12, race: "Человек", injuredDays: 0, workAssignment: "workshop" };
  const goblinChild = { id: "goblin-9", age: 9, race: "Гоблин", injuredDays: 0 };
  const adult = { id: "adult", age: 30, race: "Человек", injuredDays: 0, workAssignment: "workshop" };
  const holding = { people: { list: [youngChild, workingChild, adult] }, buildings: { list: [{ id: "workshop" }] } };

  assert.equal(harness._canResidentWork(youngChild), false);
  assert.equal(harness._canResidentWork(workingChild), true);
  assert.equal(harness._canResidentWork(goblinChild), true, "short-lived kin may work during their final child year");
  assert.equal(harness._personDailyWorkQdLimit(holding, youngChild), 0);
  assert.equal(harness._personDailyWorkQdLimit(holding, workingChild), 1, "working children must be limited to one QD per day even at overtime buildings");
  assert.equal(harness._personDailyWorkQdLimit(holding, adult), 3, "adult overtime behavior must remain unchanged");

  assert.deepEqual(plannedWorkerQd(40, { overtime: true, normalQdPerDay: 1, overtimeQdPerDay: 0 }), { normalQd: 10, overtimeQd: 0, totalQd: 10 });
  const slots = buildPlannedWorkSlots([{ sourceId: "workshop", functionId: "production", normalQd: 10 }], 40, { normalQdPerDay: 1, overtimeQdPerDay: 0 });
  assert.deepEqual([...slots.keys()], [0, 4, 8, 12, 16, 20, 24, 28, 32, 36], "child work must be spread as one QD on each day rather than two QD on five days");
  assert.equal(validateWorkAllocationPlan([{ sourceId: "workshop", functionId: "production", normalQd: 11 }], { maximumNormalQd: 10, maximumOvertimeQd: 0 }).ok, false);

  const context = harness._economyWorkerContext(holding);
  assert.equal(context.activePeopleById.has("child-11"), false, "stale assignments must not make an underage child economically active");
  assert.equal(context.activePeopleById.has("child-12"), true);
  assert.equal(context.activePeopleById.has("adult"), true);
}

function checkConstructionLeaderWork() {
  const harness = { ...ResidentDomain, ...AssignmentDomain, _safeNumber: (value, fallback = 0) => Number(value) || fallback };
  const person = { id: "foreman", age: 30, race: "Человек", attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, traitsText: "Лидер" };
  const holding = { people: { list: [person] }, buildings: { list: [] }, constructionCrews: [{ id: "crew", name: "Каменщики", memberIds: [], leaderId: "" }] };
  assert.equal(harness._setCrewLeader(holding, "crew", person.id), true);
  assert.equal(harness._assignedWorkerSet(holding).has(person.id), true, "leadership is a real reserved job");
  const context = harness._residentWorkOptionsContext(holding);
  const label = harness._peopleWorkAssignments(holding, context).get(person.id);
  assert.equal(label, "Руководитель: Каменщики");
  for (const injuredDays of [0, 3]) {
    person.injuredDays = injuredDays;
    const inline = harness._residentInlineWorkOption(person, label, context);
    assert.equal(inline.value, "construction-leader:crew", "inline work must preserve leadership even during injury");
    assert.equal(inline.label, label);
    assert.deepEqual(harness._workOptions(holding, person, context).filter(option => option.selected), [
      { value: "construction-leader:crew", label, selected: true }
    ], "opening and saving the resident editor must retain the current leader option");
  }
  harness.residentFilters = { work: "free" };
  assert.equal(harness._personMatchesResidentFilters({ workLabel: label }), false);
  harness.residentFilters.work = "assigned";
  assert.equal(harness._personMatchesResidentFilters({ workLabel: label }), true);
  assert.equal(harness._residentWorkOptionCatalog(context).some(option => option.value.startsWith("construction-leader:")), false,
    "ordinary worker options must not bypass appointment and qualification in the crew editor");
}

function checkBoundedEditors() {
  for (const relativePath of ["templates/parts/skyhold-resident-editor.hbs", "templates/parts/skyhold-tab-gm.hbs"]) {
    const source = readFileSync(path.join(root, relativePath), "utf8");
    const boundedFields = source.match(/type="number" min="1" max="6" step="1"[^>]+attributes\.(?:strength|agility|wits|empathy)/g) ?? [];
    assert.equal(boundedFields.length, 4, `${relativePath}: every resident attribute editor must expose the 1..6 integer range`);
  }
}

export function checkResidentCharacterization() {
  checkAttributeContracts();
  checkGeneratedPopulation();
  checkWonderworkerTrait();
  checkTraitFlavor();
  checkActorImport();
  checkChildWork();
  checkConstructionLeaderWork();
  checkBoundedEditors();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkResidentCharacterization();
  console.log("FBL Skyhold residents: generation, attributes, backgrounds, rare traits, imports and child work passed.");
}
