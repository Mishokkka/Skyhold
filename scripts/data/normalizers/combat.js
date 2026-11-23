import { BASE_HOLDING } from "../schema/base-holding.js";
import { clone, isPlainObject, makeId, mergeDefaults, toBoolean, toNumber } from "../utils.js";

export function normalizeDefenseSquad(row = {}) {
  if (!isPlainObject(row)) return null;
  const id = String(row.id || makeId("squad"));
  const memberIds = Array.isArray(row.memberIds) ? row.memberIds.map((value) => String(value ?? "")) : [];
  const sergeantId = String(row.sergeantId ?? "");
  const armamentResourceId = ["armament-simple", "armament-complex", "armament-elite"].includes(String(row.armamentResourceId ?? ""))
    ? String(row.armamentResourceId)
    : "";
  return {
    id,
    name: String(row.name ?? "Отряд"),
    type: String(row.type ?? "line") === "militia" ? "line" : String(row.type ?? "line"),
    sergeantId,
    equipped: Boolean(armamentResourceId),
    armamentResourceId,
    armamentSourceRoomId: String(row.armamentSourceRoomId ?? "outdoors") || "outdoors",
    memberIds: Array.from({ length: 4 }, (_, index) => String(memberIds[index] ?? "")),
    notes: String(row.notes ?? "")
  };
}

function normalizePendingBattleRound(row) {
  if (!isPlainObject(row)) return null;
  const pending = clone(row);
  pending.schemaVersion = Math.max(1, Math.floor(toNumber(pending.schemaVersion, 1)));
  pending.roundId = String(pending.roundId ?? "").slice(0, 160);
  pending.battleId = String(pending.battleId ?? "").slice(0, 160);
  pending.round = Math.max(1, Math.floor(toNumber(pending.round, 1)));
  pending.createdAt = String(pending.createdAt ?? "");
  pending.stateSignature = String(pending.stateSignature ?? "").slice(0, 160);
  pending.rollFormula = String(pending.rollFormula ?? "").slice(0, 160);
  pending.rollMode = String(pending.rollMode ?? "recorded-d6").slice(0, 80);
  for (const key of ["defenderPool", "attackerPool", "defenderSuccesses", "attackerSuccesses"]) {
    pending[key] = Math.max(0, Math.floor(toNumber(pending[key], 0)));
  }
  pending.margin = Math.floor(toNumber(pending.margin, 0));
  pending.defenderRolls = (Array.isArray(pending.defenderRolls) ? pending.defenderRolls : []).slice(0, 1000).map((value) => Math.max(1, Math.min(6, Math.floor(toNumber(value, 1)))));
  pending.attackerRolls = (Array.isArray(pending.attackerRolls) ? pending.attackerRolls : []).slice(0, 1000).map((value) => Math.max(1, Math.min(6, Math.floor(toNumber(value, 1)))));
  pending.randomTrace = (Array.isArray(pending.randomTrace) ? pending.randomTrace : []).slice(0, 5000).map((value) => Math.max(0, Math.min(0.999999999999, toNumber(value, 0))));
  pending.consequences = isPlainObject(pending.consequences) ? clone(pending.consequences) : {};
  pending.terminal = isPlainObject(pending.terminal) ? clone(pending.terminal) : {};
  pending.casualtyPreview = (Array.isArray(pending.casualtyPreview) ? pending.casualtyPreview : []).slice(0, 100).map((entry) => clone(entry));
  pending.damagePreview = (Array.isArray(pending.damagePreview) ? pending.damagePreview : []).slice(0, 100).map((entry) => clone(entry));
  pending.casualtyText = String(pending.casualtyText ?? "");
  pending.damageText = String(pending.damageText ?? "");
  pending.fingerprint = String(pending.fingerprint ?? "").slice(0, 160);
  return pending.roundId && pending.stateSignature && pending.fingerprint ? pending : null;
}

function normalizeBattleArchive(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) => isPlainObject(entry)).slice(-20).map((entry) => ({
    id: String(entry.id || makeId("battle-archive")),
    battleId: String(entry.battleId ?? ""),
    title: String(entry.title ?? "Битва за владение"),
    enemyName: String(entry.enemyName ?? "Нападающие"),
    objective: String(entry.objective ?? ""),
    scale: String(entry.scale ?? "raid"),
    outcome: String(entry.outcome ?? "active"),
    terminalReason: String(entry.terminalReason ?? ""),
    reason: String(entry.reason ?? "resolved"),
    startedAt: String(entry.startedAt ?? ""),
    resolvedAt: String(entry.resolvedAt ?? ""),
    resolvedBy: String(entry.resolvedBy ?? ""),
    roundsPlayed: Math.max(0, Math.floor(toNumber(entry.roundsPlayed, 0))),
    casualtyCount: Math.max(0, Math.floor(toNumber(entry.casualtyCount, 0))),
    damagedBuildingCount: Math.max(0, Math.floor(toNumber(entry.damagedBuildingCount, 0))),
    snapshot: isPlainObject(entry.snapshot) ? clone(entry.snapshot) : {}
  }));
}

export function normalizeMassCombatState(state = {}) {
  const source = isPlainObject(state) ? state : {};
  const base = clone(BASE_HOLDING.gm.massCombat);
  const merged = mergeDefaults(base, source);
  delete merged.defenderSupply;
  delete merged.attackerSupply;

  for (const key of Object.keys(merged)) {
    if (/^attackerSourcePrimaryTag\d+$/.test(key)) merged[key] = String(merged[key] ?? "");
    else if (/^attackerSourceEfficiency\d+$/.test(key)) merged[key] = Math.max(0, toNumber(merged[key], 0));
  }

  const numericKeys = [
    "defenderUnits", "defenderBS", "defenderCommand", "defenderHero", "defenderMorale", "defenderSpecial", "defenderPosition",
    "attackerUnits", "attackerBS", "attackerCommand", "attackerHero", "attackerSpecial", "attackerPosition",
    "defenderInfantry", "defenderShooters", "defenderMobile", "defenderHeavy", "defenderSappers", "defenderSiege", "defenderSkirmishers", "defenderMonsters", "defenderSacred",
    "attackerInfantry", "attackerShooters", "attackerMobile", "attackerHeavy", "attackerSappers", "attackerSiege", "attackerSkirmishers", "attackerMonsters", "attackerSacred",
    "round", "roundLimit", "breachProgress", "objectiveProgress", "objectiveThreshold", "defenderLossSteps", "attackerLossSteps", "settlementDamage",
    "defenderShaken", "defenderBroken", "attackerShaken", "attackerBroken"
  ];
  for (const key of numericKeys) merged[key] = toNumber(merged[key], base[key] ?? 0);
  for (const key of Object.keys(merged)) {
    if (/^(defender|attacker)[A-Z][A-Za-z0-9_]*-[A-Za-z0-9_-]*$/.test(key)) merged[key] = Math.max(0, toNumber(merged[key], 0));
  }
  merged.round = Math.max(1, Math.floor(merged.round || 1));
  merged.defenderPosition = Math.max(0, Math.min(3, Math.floor(merged.defenderPosition || 0)));
  merged.attackerPosition = Math.max(0, Math.min(3, Math.floor(merged.attackerPosition || 0)));
  for (const key of ["title", "enemyName", "objective", "roundThreat", "notes", "attackerPreset", "defenderMobilization", "accessMode", "battleId", "terminalReason", "startedAt", "resolvedAt", "resolvedBy", "militarySupplyBattleId"]) merged[key] = String(merged[key] ?? "");
  merged.useDefenseSquads = toBoolean(merged.useDefenseSquads, true);
  merged.raiseMilitia = toBoolean(merged.raiseMilitia, false);
  merged.useMedicalSupplies = toBoolean(merged.useMedicalSupplies, false);
  merged.useMedicinesForHeavyCasualties = toBoolean(merged.useMedicinesForHeavyCasualties, false);
  merged.militarySuppliedSquadIds = (Array.isArray(merged.militarySuppliedSquadIds) ? merged.militarySuppliedSquadIds : []).map((id) => String(id ?? "")).filter(Boolean);
  merged.militaryUnsuppliedSquadIds = (Array.isArray(merged.militaryUnsuppliedSquadIds) ? merged.militaryUnsuppliedSquadIds : []).map((id) => String(id ?? "")).filter(Boolean);
  merged.militarySupplyCosts = (Array.isArray(merged.militarySupplyCosts) ? merged.militarySupplyCosts : []).map((cost) => ({
    resourceId: String(cost?.resourceId ?? ""),
    qty: Math.max(0, Math.floor(toNumber(cost?.qty, 0)))
  })).filter((cost) => cost.resourceId && cost.qty > 0);
  merged.militarySuppliesConsumed = toBoolean(merged.militarySuppliesConsumed, false);
  merged.scale = ["raid", "skirmish", "battle", "siege"].includes(String(merged.scale)) ? String(merged.scale) : "raid";
  merged.defenseMode = ["behindWalls", "outerWorks", "surprised", "outside"].includes(String(merged.defenseMode)) ? String(merged.defenseMode) : "behindWalls";
  merged.accessMode = ["normal", "airborne", "water", "cliff", "portal"].includes(String(merged.accessMode)) ? String(merged.accessMode) : "normal";
  merged.roundThreat = ["assault", "fire", "arson", "sabotage", "panic", "breach", "raid"].includes(String(merged.roundThreat)) ? String(merged.roundThreat) : "assault";
  merged.defenderMobilization = ["watch", "militia", "manual"].includes(String(merged.defenderMobilization)) ? String(merged.defenderMobilization) : "watch";
  if (!merged.attackerPreset) merged.attackerPreset = "custom";
  merged.roundLimit = Math.max(1, Math.floor(merged.roundLimit || 3));
  merged.objectiveThreshold = Math.max(1, Math.floor(merged.objectiveThreshold || 2));

  const defenderStrategies = ["holdFortifications", "deepDefense", "counterattack", "protectCivilians", "protectObjective", "fightingWithdrawal", "parley"];
  const attackerStrategies = ["frontalAssault", "probingAdvance", "raidWithdraw", "sabotage", "bombardment", "breakthrough", "parley"];
  merged.defenderStrategy = defenderStrategies.includes(String(merged.defenderStrategy)) ? String(merged.defenderStrategy) : "holdFortifications";
  merged.attackerStrategy = attackerStrategies.includes(String(merged.attackerStrategy)) ? String(merged.attackerStrategy) : "frontalAssault";

  merged.schemaVersion = 2;
  merged.pendingRound = normalizePendingBattleRound(merged.pendingRound);
  const inferredPhase = merged.pendingRound ? "pending" : (merged.battleId || (Array.isArray(merged.log) && merged.log.length) ? "active" : "setup");
  const sourcePhase = String(source.phase ?? "");
  merged.phase = ["setup", "active", "pending", "terminal", "aftermath", "archived"].includes(sourcePhase) ? sourcePhase : inferredPhase;
  if (merged.pendingRound) merged.phase = "pending";
  merged.outcome = ["active", "attacker-victory", "defender-victory", "contested"].includes(String(merged.outcome)) ? String(merged.outcome) : "active";
  merged.archive = normalizeBattleArchive(merged.archive);

  if (!Array.isArray(merged.log)) merged.log = [];
  merged.log = merged.log.filter((row) => row && typeof row === "object").map((row) => ({
    id: String(row.id || makeId("battle-log")),
    roundId: String(row.roundId ?? ""),
    battleId: String(row.battleId ?? ""),
    createdAt: String(row.createdAt ?? new Date().toISOString()),
    round: Math.max(1, Math.floor(toNumber(row.round, 1))),
    title: String(row.title ?? "Раунд боя"),
    result: String(row.result ?? ""),
    defenderPool: Math.max(0, Math.floor(toNumber(row.defenderPool, 0))),
    attackerPool: Math.max(0, Math.floor(toNumber(row.attackerPool, 0))),
    defenderRolls: (Array.isArray(row.defenderRolls) ? row.defenderRolls : []).slice(0, 1000).map((value) => Math.max(1, Math.min(6, Math.floor(toNumber(value, 1))))),
    attackerRolls: (Array.isArray(row.attackerRolls) ? row.attackerRolls : []).slice(0, 1000).map((value) => Math.max(1, Math.min(6, Math.floor(toNumber(value, 1))))),
    randomTrace: (Array.isArray(row.randomTrace) ? row.randomTrace : []).slice(0, 5000).map((value) => Math.max(0, Math.min(0.999999999999, toNumber(value, 0)))),
    resultFingerprint: String(row.resultFingerprint ?? "").slice(0, 160),
    defenderSuccesses: Math.max(0, Math.floor(toNumber(row.defenderSuccesses, 0))),
    attackerSuccesses: Math.max(0, Math.floor(toNumber(row.attackerSuccesses, 0))),
    margin: Math.floor(toNumber(row.margin, 0)),
    defenderLossDelta: Math.max(0, Math.floor(toNumber(row.defenderLossDelta, 0))),
    attackerLossDelta: Math.max(0, Math.floor(toNumber(row.attackerLossDelta, 0))),
    settlementDamageDelta: Math.max(0, Math.floor(toNumber(row.settlementDamageDelta, 0))),
    breachDelta: Math.max(0, Math.floor(toNumber(row.breachDelta, 0))),
    objectiveDelta: Math.floor(toNumber(row.objectiveDelta, 0)),
    defenderPositionDelta: Math.floor(toNumber(row.defenderPositionDelta, 0)),
    attackerPositionDelta: Math.floor(toNumber(row.attackerPositionDelta, 0)),
    defenderImpact: Math.max(0, Math.floor(toNumber(row.defenderImpact, 0))),
    attackerImpact: Math.max(0, Math.floor(toNumber(row.attackerImpact, 0))),
    casualtyText: String(row.casualtyText ?? ""),
    damageText: String(row.damageText ?? "")
  })).slice(-20);
  return merged;
}
