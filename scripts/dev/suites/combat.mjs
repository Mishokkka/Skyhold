import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { archiveBattle } from "../../apps/mass-combat/archive.js";
import { applyDefenderResidentCasualties } from "../../apps/mass-combat/casualties.js";
import { createRandomDecisionRecorder, createRandomDecisionReplay } from "../../apps/mass-combat/round-resolution.js";
import { resetMassCombatState } from "../../apps/mass-combat/state.js";
import { battleTerminalState } from "../../apps/mass-combat/terminal.js";
import { defenseSquadProfile } from "../../apps/mass-combat/sources.js";
import { consumeDefenderMilitarySupplies, prepareDefenderMilitarySupplyPlan } from "../../apps/mass-combat/supplies.js";
import * as massCombatResidents from "../../apps/mass-combat/residents.js";
import { ResidentDomain } from "../../apps/domains/resident-domain.js";

export function runCombatSuite() {
  const state = resetMassCombatState({ archive: [] });
  state.battleId = "battle-suite-1";
  state.title = "Проверка боя";
  state.round = 3;
  const active = battleTerminalState(state, {
    defenderLossTrack: { value: 1, threshold: 3 },
    attackerLossTrack: { value: 0, threshold: 3 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  assert.equal(active.finished, false, "battle must remain active below every terminal threshold");
  const terminal = battleTerminalState(state, {
    defenderLossTrack: { value: 3, threshold: 3 },
    attackerLossTrack: { value: 0, threshold: 3 },
    objectiveTrack: { done: false, outOfTime: false }
  });
  assert.equal(terminal.outcome, "attacker-victory", "broken defenders must produce the canonical attacker victory");

  const recorder = createRandomDecisionRecorder(() => 0.42);
  const recorded = [recorder.random(), recorder.random()];
  const replay = createRandomDecisionReplay(recorder.values);
  assert.deepEqual([replay.random(), replay.random()], recorded, "recorded random decisions must replay exactly");

  const firstArchive = archiveBattle(state, { outcome: terminal.outcome, terminalReason: terminal.reason, resolvedBy: "suite", resolvedAt: "2026-07-12T12:00:00.000Z" });
  const secondArchive = archiveBattle(state, { outcome: terminal.outcome, terminalReason: terminal.reason, resolvedBy: "suite", resolvedAt: "2026-07-12T12:01:00.000Z" });
  assert.equal(firstArchive, secondArchive, "battle archive must be idempotent by battle id");
  assert.equal(state.archive.length, 1, "battle archive must not duplicate a resolved battle");

  const medicalHolding = () => ({
    people: { list: [
      { id: "soldier", name: "Soldier", workAssignment: "soldier", dead: false, injuredDays: 0 },
      { id: "doctor", name: "Doctor", role: "Doctor", dead: false, injuredDays: 0 }
    ] },
    buildings: { list: [{ id: "lazaret", specialKind: "medical", constructionStatus: "built", assignedWorkerIds: ["doctor"] }] }
  });
  const heavyWithDeathRoll = (deathRoll) => {
    const values = [0.1, 0.6, 0.1, 0.1, (deathRoll - 0.5) / 6];
    let index = 0;
    return () => values[index++] ?? 0.1;
  };
  const medicalDependencies = (resources) => ({
    resourceQuantity: (_holding, id) => resources[id] ?? 0,
    consumeResource: (_holding, id, qty) => {
      if ((resources[id] ?? 0) < qty) return false;
      resources[id] -= qty;
      return true;
    }
  });

  const suppliesHolding = medicalHolding();
  const supplies = { "medical-supplies": 1, medicines: 0 };
  const suppliedResult = applyDefenderResidentCasualties(
    suppliesHolding,
    { battleId: "medical-supplies", round: 1, useMedicalSupplies: true },
    1,
    {},
    { random: heavyWithDeathRoll(2), ...medicalDependencies(supplies) }
  );
  assert.equal(suppliesHolding.people.list[0].dead, false, "doctor plus Medical Supplies must save a heavy casualty on death roll 2");
  assert.equal(suppliedResult.records[0]?.deathChance, 1, "doctor and supplies must lower heavy mortality from 3 to 1");
  assert.equal(suppliedResult.medicalSuppliesUsed, 1, "one Medical Supplies must be consumed when the option is enabled");

  const medicinesHolding = medicalHolding();
  const medicines = { "medical-supplies": 1, medicines: 1 };
  const medicinesResult = applyDefenderResidentCasualties(
    medicinesHolding,
    { battleId: "medicines", round: 1, useMedicalSupplies: true, useMedicinesForHeavyCasualties: true },
    1,
    {},
    { random: heavyWithDeathRoll(1), ...medicalDependencies(medicines) }
  );
  assert.equal(medicinesHolding.people.list[0].dead, false, "doctor, supplies and Medicines must guarantee survival for a heavy casualty");
  assert.equal(medicinesResult.records[0]?.deathChance, 0, "the complete medical ladder must reduce heavy mortality to zero");
  assert.deepEqual(medicines, { "medical-supplies": 0, medicines: 0 }, "the complete medical ladder must spend both opted-in resources");

  const militaryHolding = {
    people: { list: Array.from({ length: 5 }, (_value, index) => ({
      id: `fusilier-${index + 1}`,
      dead: false,
      injuredDays: 0,
      attributes: { strength: 3, agility: 4, wits: 3, empathy: 3 }
    })) },
    gm: { defense: { squads: [{
      id: "fusiliers",
      name: "Фузилеры",
      type: "fusiliers",
      equipped: true,
      armamentResourceId: "armament-complex",
      sergeantId: "fusilier-1",
      memberIds: ["fusilier-2", "fusilier-3", "fusilier-4", "fusilier-5"]
    }] } },
    storage: { resources: [{ resourceId: "military-supplies-complex", qty: 1 }] }
  };
  const militaryState = { battleId: "battle-supplies", useDefenseSquads: true };
  const unscheduledProfile = defenseSquadProfile(militaryHolding, militaryState);
  const supplyPlan = prepareDefenderMilitarySupplyPlan(militaryHolding, militaryState, ["fusiliers"]);
  assert.deepEqual(supplyPlan.suppliedSquadIds, ["fusiliers"], "a participating complex-armament squad must reserve one complex Military Supplies");
  const suppliedProfile = defenseSquadProfile(militaryHolding, militaryState);
  assert.equal(suppliedProfile.effective, Math.round(unscheduledProfile.effective * 1.2 * 100) / 100, "battle supply must grant the explicit 20% firearm bonus");
  assert.equal(suppliedProfile.tags.shooters, 1, "a supplied fusilier squad keeps its firearm tag");
  let militaryStock = 1;
  const consumedMilitary = consumeDefenderMilitarySupplies(militaryHolding, militaryState, {
    consumeResource: (_holding, resourceId, qty) => {
      assert.equal(resourceId, "military-supplies-complex");
      if (militaryStock < qty) return false;
      militaryStock -= qty;
      return true;
    }
  });
  assert.equal(consumedMilitary.used, 1);
  assert.equal(militaryStock, 0);
  assert.equal(consumeDefenderMilitarySupplies(militaryHolding, militaryState, { consumeResource: () => false }).duplicate, true, "one battle must never consume squad ammunition twice");

  const noSupplyState = { battleId: "battle-no-supplies", useDefenseSquads: true };
  militaryHolding.storage.resources[0].qty = 0;
  prepareDefenderMilitarySupplyPlan(militaryHolding, noSupplyState, ["fusiliers"]);
  const noSupplyProfile = defenseSquadProfile(militaryHolding, noSupplyState);
  assert.equal(noSupplyProfile.effective, unscheduledProfile.effective, "an unsupplied squad remains in battle at its non-firearm effectiveness");
  assert.equal(noSupplyProfile.tags.shooters, 0, "an unsupplied fusilier squad loses the firearm tag without being removed from battle");

  const residentHarness = {
    ...ResidentDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  };
  const veteran = {
    id: "veteran",
    workAssignment: "soldier",
    role: "Солдат",
    background: "ветеран",
    injuredDays: 0,
    attributes: { strength: 4, agility: 3, wits: 4, empathy: 3 }
  };
  for (const type of ["line", "fusiliers", "jaegers", "grenadiers", "sappers", "artillery", "cavalry"]) {
    assert.deepEqual(residentHarness._squadTypeDefs()[type], massCombatResidents.squadTypeProfile(type), `${type}: manager and mass combat must use one squad profile`);
    assert.equal(residentHarness._soldierEfficiency(veteran, type), massCombatResidents.soldierEfficiency(veteran, type), `${type}: manager and mass combat must use one soldier-efficiency formula`);
  }
  assert.equal(residentHarness._isCommanderCandidate(veteran), true, "manager commanders must use the canonical Wits 4 threshold");
  assert.equal(massCombatResidents.isCommanderCandidate(veteran), true, "mass-combat commanders must use the canonical Wits 4 threshold");
  return { suite: "combat" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCombatSuite();
  console.log("FBL Skyhold suite: combat passed.");
}
