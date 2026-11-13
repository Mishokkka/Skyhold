import assert from "node:assert/strict";
import { defenderCasualtyCandidates, applyDefenderResidentCasualties, medicalSupport } from "../apps/mass-combat/casualties.js";
import { defenseSquadProfile } from "../apps/mass-combat/sources.js";
import { defenseCommanderBonus } from "../apps/mass-combat/modifiers.js";
import { BuildingRowsDomain } from "../apps/domains/building/rows-domain.js";
import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { ResidentDomain } from "../apps/domains/resident-domain.js";
import { AssignmentDomain } from "../apps/domains/assignment-domain.js";
import { applyDefenseOperation } from "../apps/domains/defense-operation-domain.js";
import { stableDataHash } from "../data/storage-commit.js";

const soldier = (id, away = false) => ({ id, name: id, age: 30, ageGroup: "Вз", role: "Солдат", workAssignment: "soldier",
  injuredDays: 0, attributes: { strength: 5, agility: 5, wits: 5, empathy: 5 },
  ...(away ? { shipAssignment: { shipId: "ship", away: true } } : {}) });
const holding = { people: { list: [soldier("voyager", true), soldier("home")] }, buildings: { list: [] }, gm: { defense: { squads: [] } } };
assert.deepEqual(defenderCasualtyCandidates(holding).map(row => row.id), ["home"], "absent crew cannot suffer settlement casualties");
const result = applyDefenderResidentCasualties(holding, { battleId: "presence", round: 1 }, 3, {}, { random: () => 0 });
assert.deepEqual(result.records.map(row => row.personId), ["home"], "losses beyond local combatants must stop before reaching absent residents");
assert.equal(holding.people.list[0].injuredDays, 0);
assert.equal(holding.people.list[0].dead, undefined);

const squadHolding = { people: { list: [soldier("absent", true), ...Array.from({ length: 5 }, (_, i) => soldier(`present-${i}`))] },
  gm: { defense: { squads: [{ id: "squad", equipped: true, armamentResourceId: "armament-simple", type: "line", sergeantId: "absent",
    memberIds: ["present-0", "present-1", "present-2", "present-3"] }] } } };
const profile = defenseSquadProfile(squadHolding);
assert.ok(profile.sources.length, "fixture must retain a fighting squad");
assert.ok(profile.sources.every(source => !source.participantIds.includes("absent")), "risk sources must contain actual combatants only");
const roster = { ...ResidentDomain, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
assert.equal(roster._defenseContext(squadHolding).squads[0].memberCount, 4);
assert.equal(roster._defenseContext(squadHolding).squads[0].effective, profile.effective,
  "defense and mass combat must use the same available roster and base efficiency");
const marginal = structuredClone(squadHolding);
for (const person of marginal.people.list) person.attributes = { strength: 3, agility: 3 };
assert.equal(roster._defenseContext(marginal).effectiveUnits, 0, "four ordinary fighters must not be shown as a full unit");
assert.equal(defenseSquadProfile(marginal).units, 0);
const options = roster._defenseContext(marginal).squads[0].memberSlots[0].options;
assert.ok(options.every(({ value }) => value !== "absent"), "an absent soldier cannot be offered as a new assignment");

const trained = { people: { list: [] }, gm: { defense: { squads: [] } } };
for (let index = 0; index < 2; index++) {
  const people = Array.from({ length: 5 }, (_, slot) => ({ ...soldier(`v${index}-${slot}`), background: "Ветеран" }));
  trained.people.list.push(...people);
  trained.gm.defense.squads.push({ id: `veterans-${index}`, type: "line", equipped: true,
    armamentResourceId: "armament-elite", sergeantId: people[0].id, memberIds: people.slice(1).map(({ id }) => id) });
}
const trainingProfile = defenseSquadProfile(trained);
assert.equal(trainingProfile.sources[0].sergeantBonus, 0.10);
assert.equal(roster._defenseContext(trained).effectiveUnits, 2, "high efficiency never creates a third squad");
assert.equal(roster._defenseContext(trained).squads[0].effective, trainingProfile.squads[0].effective);
const trainedByTitleOnly = structuredClone(trained);
for (const person of trainedByTitleOnly.people.list) delete person.background;
assert.equal(defenseSquadProfile(trainedByTitleOnly).sources[0].sergeantBonus, 0,
  "assigning a role does not create the military past needed for a sergeant bonus");

const thresholdSquad = marginal.gm.defense.squads[0];
thresholdSquad.sergeantId = thresholdSquad.memberIds.pop();
const thresholdSergeant = marginal.people.list.find(({ id }) => id === thresholdSquad.sergeantId);
thresholdSergeant.attributes = { strength: 5, agility: 5 };
thresholdSergeant.role = "Сержант";
assert.equal(defenseSquadProfile(marginal).units, 0, "four residents below five effective fighters cannot field a unit");
const suppliedEarlier = { battleId: "ongoing", militarySupplyBattleId: "ongoing", militarySuppliedSquadIds: [thresholdSquad.id] };
assert.equal(defenseSquadProfile(marginal, suppliedEarlier).units, 0,
  "after a casualty a previous supply plan cannot keep an understrength squad in the fight");
for (const background of ["Бывший офицер", "Сержант гарнизона"]) {
  thresholdSergeant.background = background;
  const profile = defenseSquadProfile(marginal);
  assert.equal(profile.units, 1, `${background}: recognized military training takes the squad across the threshold`);
  assert.equal(profile.sources[0].sergeantBonus, 0.10);
  assert.equal(profile.effective, 5.06);
  assert.equal(roster._defenseContext(marginal).effectiveUnits, profile.units);
}

{
  const veterans = Array.from({ length: 5 }, (_, i) => ({ ...soldier(`vet-${i}`), background: "Ветеран",
    attributes: { strength: 3, agility: 3 } }));
  const recruits = Array.from({ length: 5 }, (_, i) => ({ ...soldier(`recruit-${i}`), workAssignment: "", role: "Свободен" }));
  const squad = { id: "best", type: "line", sergeantId: "", memberIds: ["", "", "", ""], armamentResourceId: "armament-simple", equipped: true };
  const draft = { people: { list: [...veterans, ...recruits] }, gm: { defense: { squads: [squad] } } };
  const fill = () => applyDefenseOperation(draft, { type: "fillDefenseSquad", squadId: squad.id, expectedSquadHash: stableDataHash(squad) },
    { requester: { isGM: true }, logic: { ...roster, ...AssignmentDomain } });
  assert.equal(fill().ok, true);
  assert.equal(defenseSquadProfile(draft).effective, 7.5, "prefer the actual stronger formation over double-weighting a military label");
  const officer = { ...soldier("officer"), background: "Офицер", attributes: { strength: 4, agility: 4, empathy: 5 } };
  draft.people.list.push(officer);
  assert.equal(fill().ok, true);
  assert.equal(squad.sergeantId, "officer");
  assert.equal(defenseSquadProfile(draft).effective, 8.14, "a lower personal score can still make the strongest leader");
}

const medical = { people: { list: [{ id: "doctor", injuredDays: 0, shipAssignment: { shipId: "ship", away: true } }] },
  buildings: { list: [{ id: "hospital", specialKind: "medical", constructionStatus: "built", assignedWorkerIds: ["doctor"] }] } };
assert.equal(medicalSupport(medical).capacity, 0, "absent doctors cannot treat settlement casualties");
assert.equal(medicalSupport(medical).workers, 0);
const capacityApp = { ...BuildingRowsDomain, ...BuildingWorkerDomain,
  _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback };
for (const unavailable of [{ shipAssignment: { shipId: "ship", away: true } }, { dead: true }, { injuredDays: 2 }]) {
  const unavailableDoctor = structuredClone(medical);
  unavailableDoctor.people.list = [{ id: "doctor", injuredDays: 0, ...unavailable }];
  const assignments = capacityApp._medicalAssignments(unavailableDoctor);
  for (const provider of [assignments, h => capacityApp._medicalAssignments(h)]) {
    const support = medicalSupport(unavailableDoctor, { medicalAssignments: provider });
    assert.equal(support.capacity, 0, "real medical assignments must exclude away, dead and injured doctors");
    assert.equal(support.workers, 0);
  }
  assert.equal(medicalSupport(unavailableDoctor, {
    medicalCapacityForBuilding: (h, b) => capacityApp._medicalCapacityForBuilding(h, b)
  }).capacity, 0, "the capacity callback must apply the same doctor availability rule");
}
const mixedDoctors = structuredClone(medical);
mixedDoctors.people.list.push({ id: "home-doctor", injuredDays: 0 }, { id: "patient", injuredDays: 2 });
mixedDoctors.buildings.list[0].assignedWorkerIds.push("home-doctor");
mixedDoctors.buildings.list[0].medical = { patientsPerEfficiency: 9, maxPatients: 13 };
for (const maxPatients of [13, 7]) {
  mixedDoctors.buildings.list[0].medical.maxPatients = maxPatients;
  const assignments = capacityApp._medicalAssignments(mixedDoctors);
  for (const provider of [assignments, h => capacityApp._medicalAssignments(h)]) {
    const support = medicalSupport(mixedDoctors, { medicalAssignments: provider });
    assert.equal(support.workers, 1);
    assert.equal(support.workerEfficiency, 1);
    assert.equal(support.capacity, Math.min(9, maxPatients) - 1,
      "mixed staffing must preserve the configured capacity, building limit and occupied patient bed");
  }
}
const command = { ...squadHolding, gm: { defense: { commanderId: "absent" } } };
assert.equal(defenseCommanderBonus(command, 10).percent, 0, "absent commanders cannot lead a settlement battle");
command.gm.defense.commanderId = "present-0";
assert.ok(defenseCommanderBonus(command, 10).percent > 0, "present commanders retain their bonus");
const ordinaryCommander = { ...soldier("officer"), attributes: { strength: 3, agility: 3, wits: 4, empathy: 2 } };
const commandHolding = { people: { list: [ordinaryCommander] }, gm: { defense: { commanderId: ordinaryCommander.id, squads: [] } } };
assert.match(roster._defenseContext(commandHolding).commanderOptions.find(row => row.value === ordinaryCommander.id)?.label, /3\/5 · \+15%/);
const baseCommand = defenseCommanderBonus(commandHolding).percent;
ordinaryCommander.role = "Командир обороны: 5 солд.";
ordinaryCommander.workAssignment = "defenseCommander";
assert.equal(defenseCommanderBonus(commandHolding).percent, baseCommand, "appointment does not turn the derived title into leadership training");
assert.equal(Math.round(baseCommand * 100), 15);
const patients = { people: { list: [{ id: "away-patient", injuredDays: 5, shipAssignment: { shipId: "ship", away: true } },
  { id: "home-patient", injuredDays: 5 }] }, buildings: { list: [{ id: "hospital" }] } };
const medicalApp = { ...BuildingRowsDomain, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  _isMedicalBuildingRecord: () => true, _medicalCapacityForBuilding: () => ({ capacity: 1, efficiency: 1 }) };
assert.deepEqual(medicalApp._medicalAssignments(patients).get("hospital").patients.map(row => row.id), ["home-patient"],
  "absent patients cannot occupy local beds or receive local treatment");
console.log("Combat presence: absent combatants/patients, casualty exhaustion, squad risk and real medical providers with unavailable/mixed doctors and configured beds passed.");
