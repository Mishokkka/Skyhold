import assert from "node:assert/strict";
import { defenderCasualtyCandidates, applyDefenderResidentCasualties, medicalSupport } from "../apps/mass-combat/casualties.js";
import { defenseSquadProfile } from "../apps/mass-combat/sources.js";
import { defenseCommanderBonus } from "../apps/mass-combat/modifiers.js";
import { BuildingRowsDomain } from "../apps/domains/building/rows-domain.js";

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
  gm: { defense: { squads: [{ id: "squad", equipped: true, type: "line", sergeantId: "absent",
    memberIds: ["present-0", "present-1", "present-2", "present-3"] }] } } };
const profile = defenseSquadProfile(squadHolding);
assert.ok(profile.sources.length, "fixture must retain a fighting squad");
assert.ok(profile.sources.every(source => !source.participantIds.includes("absent")), "risk sources must contain actual combatants only");

const medical = { people: { list: [{ id: "doctor", injuredDays: 0, shipAssignment: { shipId: "ship", away: true } }] },
  buildings: { list: [{ id: "hospital", specialKind: "medical", constructionStatus: "built", assignedWorkerIds: ["doctor"] }] } };
assert.equal(medicalSupport(medical).capacity, 0, "absent doctors cannot treat settlement casualties");
assert.equal(medicalSupport(medical).workers, 0);
const command = { ...squadHolding, gm: { defense: { commanderId: "absent" } } };
assert.equal(defenseCommanderBonus(command, 10).percent, 0, "absent commanders cannot lead a settlement battle");
command.gm.defense.commanderId = "present-0";
assert.ok(defenseCommanderBonus(command, 10).percent > 0, "present commanders retain their bonus");
const patients = { people: { list: [{ id: "away-patient", injuredDays: 5, shipAssignment: { shipId: "ship", away: true } },
  { id: "home-patient", injuredDays: 5 }] }, buildings: { list: [{ id: "hospital" }] } };
const medicalApp = { ...BuildingRowsDomain, _safeNumber: (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback,
  _isMedicalBuildingRecord: () => true, _medicalCapacityForBuilding: () => ({ capacity: 1, efficiency: 1 }) };
assert.deepEqual(medicalApp._medicalAssignments(patients).get("hospital").patients.map(row => row.id), ["home-patient"],
  "absent patients cannot occupy local beds or receive local treatment");
console.log("Combat presence: absent residents, casualty exhaustion, squad risk membership and absent doctors passed.");
