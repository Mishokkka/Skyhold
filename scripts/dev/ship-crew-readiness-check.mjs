import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { shipCrewComposition, shipCrewReadiness } from "../engines/ships/crew-readiness.js";

function resident(id, extra = {}) {
  return { id, name: id, age: 30, race: "Человек", injuredDays: 0, dead: false, ...extra };
}

function holding(people) {
  return { people: { list: people }, buildings: { list: [] }, constructionCrews: [], gm: { defense: { squads: [] } } };
}

function ship(extra = {}) {
  return { id: "magnifique", name: "Магнифик", profileId: "merchant-barque", crewTarget: 36, crewResidentIds: [], ...extra };
}

export function checkShipCrewReadiness() {
  const healthyPeople = Array.from({ length: 36 }, (_, index) => resident(`crew-${index + 1}`));
  const healthyShip = ship({ crewResidentIds: healthyPeople.map((person) => person.id) });
  assert.deepEqual(shipCrewReadiness(holding(healthyPeople), healthyShip), {
    ready: true,
    issues: [],
    warnings: [],
    linkedCount: 36,
    readyCount: 36,
    abstractCount: 0,
    requiredCount: 36,
    totalCount: 36,
    departingAssignments: []
  });

  const brokenPeople = healthyPeople.map((person) => ({ ...person }));
  brokenPeople[0].injuredDays = 2;
  brokenPeople[1].dead = true;
  const brokenShip = ship({ crewResidentIds: [...healthyShip.crewResidentIds.slice(0, 35), "missing"] });
  const broken = shipCrewReadiness(holding(brokenPeople), brokenShip);
  const renamed = shipCrewReadiness(holding(brokenPeople), { ...brokenShip, name: "Новое имя", magnifiqueCrewRoster: { version: 1 } });
  assert.equal(renamed.abstractCount, 0, "renaming an installed named roster must not enable abstract replacements");
  assert.equal(renamed.ready, false);
  assert.equal(broken.ready, false);
  assert.equal(broken.abstractCount, 0, "the named Magnifique roster must never receive abstract replacements");
  assert.equal(broken.totalCount, 34, "injured living crew still count for food and wages; dead and missing crew do not");
  assert.equal(broken.readyCount, 33);
  assert.deepEqual(new Set(broken.issues.map((issue) => issue.code)), new Set(["injured", "dead", "missing", "crew-shortfall"]));

  const otherShipPeople = healthyPeople.map((person) => ({ ...person }));
  otherShipPeople[0].shipAssignment = { shipId: "cutter", away: true };
  const otherShip = shipCrewReadiness(holding(otherShipPeople), healthyShip);
  assert.equal(otherShip.ready, false);
  assert.equal(otherShip.totalCount, 36, "a living linked sailor remains an economic obligation even when roster state is inconsistent");
  assert.equal(otherShip.readyCount, 35);
  assert.ok(otherShip.issues.some((issue) => issue.code === "away-other-ship"));

  const workingPeople = healthyPeople.map((person) => ({ ...person }));
  workingPeople[0].workAssignment = "dockyard";
  workingPeople[0].workAllocations = [{ sourceId: "dockyard", normalQd: 10 }];
  const workingHolding = holding(workingPeople);
  workingHolding.buildings.list.push({ id: "dockyard", name: "Верфь", assignedWorkerIds: [workingPeople[0].id] });
  const working = shipCrewReadiness(workingHolding, healthyShip);
  assert.equal(working.ready, true, "settlement work at home must not prevent departure");
  assert.deepEqual(working.departingAssignments[0], {
    residentId: "crew-1",
    name: "crew-1",
    label: "работа: dockyard; план работ: 1; здание «Верфь»"
  });

  const genericHolding = holding([resident("sailor")]);
  const genericShip = ship({ id: "cutter", name: "Ласточка", profileId: "cutter", crewTarget: 8, crewResidentIds: ["sailor"] });
  const generic = shipCrewReadiness(genericHolding, genericShip);
  assert.equal(generic.ready, true);
  assert.equal(generic.linkedCount, 1);
  assert.equal(generic.abstractCount, 7);
  assert.equal(generic.readyCount, 8);
  assert.equal(generic.totalCount, 8);
  assert.equal(generic.warnings[0].code, "abstract-crew");

  const genericDead = shipCrewReadiness(holding([resident("sailor", { dead: true })]), genericShip);
  assert.equal(genericDead.abstractCount, 7, "a declared dead sailor must occupy their named slot rather than being hidden by abstraction");
  assert.equal(genericDead.totalCount, 7);
  assert.equal(genericDead.ready, false);

  const ageCases = [
    [resident("human-11", { age: 11, race: "Человек" }), false],
    [resident("human-12", { age: 12, race: "Человек" }), true],
    [resident("goblin-8", { age: 8, race: "Гоблин" }), false],
    [resident("goblin-9", { age: 9, race: "Гоблин" }), true],
    [resident("volkolak-11", { age: 11, race: "Волколак" }), false],
    [resident("volkolak-12", { age: 12, race: "Волколак" }), true]
  ];
  for (const [person, expectedFit] of ageCases) {
    const candidateShip = ship({ id: "age-test", name: "Ласточка", profileId: "cutter", crewTarget: 1, crewResidentIds: [person.id] });
    const result = shipCrewReadiness(holding([person]), candidateShip);
    assert.equal(result.ready, expectedFit, `${person.id} must follow the current race-aware child work threshold`);
    assert.equal(result.issues.some((issue) => issue.code === "underage"), !expectedFit);
  }

  const duplicate = shipCrewReadiness(holding([resident("same")]), ship({ name: "Ласточка", profileId: "cutter", crewTarget: 1, crewResidentIds: ["same", "same"] }));
  assert.ok(duplicate.issues.some((issue) => issue.code === "duplicate-resident"));
  assert.equal(duplicate.ready, false);

  const duplicateRecord = shipCrewReadiness(holding([resident("same"), resident("same", { name: "Другой" })]), ship({ name: "Ласточка", profileId: "cutter", crewTarget: 1, crewResidentIds: ["same"] }));
  assert.ok(duplicateRecord.issues.some((issue) => issue.code === "duplicate-resident-record"));
  assert.equal(duplicateRecord.ready, false);

  const profileFallback = shipCrewReadiness(holding([]), ship({ id: "empty-cutter", name: "Ласточка", profileId: "cutter", crewTarget: 0, crewResidentIds: [] }));
  assert.equal(profileFallback.requiredCount, 8);
  assert.equal(profileFallback.abstractCount, 8);
  assert.equal(profileFallback.ready, true);

  const composition = shipCrewComposition(holding([resident("injured", { injuredDays: 3, wageDailyOverrideCopper: 19 })]), ship({ crewResidentIds: ["injured"] }));
  assert.equal(composition.totalCount, 1, "living injured crew remain in the economic composition");
  assert.equal(composition.readyCount, 0);
  return { healthyNamedCrew: 36, genericAbstractCrew: 7, ageCases: ageCases.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkShipCrewReadiness();
  console.log("FBL Skyhold ship crew readiness check passed.");
}
