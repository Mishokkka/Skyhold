import { clone, makeId } from "../../data/utils.js";
import { stableDataHash } from "../../data/storage-commit.js";
import { applyDefenderResidentCasualties } from "./casualties.js";
import { calculateBattle } from "./calculator.js";
import { applySettlementBattleDamage } from "./damage.js";
import { roundConsequences } from "./round.js";
import { asInt, clamp, successCount } from "./rules.js";
import { battleTerminalState } from "./terminal.js";
import { consumeDefenderMilitarySupplies } from "./supplies.js";

export const PENDING_ROUND_SCHEMA_VERSION = 1;

function d6(random) {
  return Math.floor(Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * 6) + 1;
}

function dicePool(count, random) {
  return Array.from({ length: Math.max(0, asInt(count, 0)) }, () => d6(random));
}

export function createRandomDecisionRecorder(random = Math.random) {
  const values = [];
  return {
    values,
    random() {
      const value = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
      values.push(value);
      return value;
    }
  };
}

export function createRandomDecisionReplay(values = []) {
  const trace = Array.isArray(values) ? values.map((value) => Math.max(0, Math.min(0.999999999999, Number(value) || 0))) : [];
  let index = 0;
  return {
    random() {
      if (index >= trace.length) throw new Error("FBL Skyhold | Pending battle random trace is exhausted.");
      return trace[index++];
    },
    consumed() {
      return index;
    },
    complete() {
      return index === trace.length;
    }
  };
}

function signatureState(state = {}) {
  const clean = clone(state);
  delete clean.pendingRound;
  delete clean.phase;
  delete clean.outcome;
  delete clean.terminalReason;
  return clean;
}

export function battleRoundSignature(holding = {}, state = holding?.gm?.massCombat ?? {}) {
  const root = clone(holding);
  if (!root.gm || typeof root.gm !== "object") root.gm = {};
  root.gm.massCombat = signatureState(state);
  return stableDataHash(root);
}

function resultFingerprint(result = {}) {
  return stableDataHash({
    round: result.round,
    defenderRolls: result.defenderRolls,
    attackerRolls: result.attackerRolls,
    defenderSuccesses: result.defenderSuccesses,
    attackerSuccesses: result.attackerSuccesses,
    margin: result.margin,
    consequences: result.consequences,
    casualties: (result.casualtyResult?.records ?? []).map((row) => ({
      personId: row.personId,
      condition: row.condition,
      treated: row.treated,
      supplied: row.supplied,
      medicineUsed: row.medicineUsed,
      sourceId: row.sourceId
    })),
    medicalSuppliesUsed: result.casualtyResult?.medicalSuppliesUsed ?? 0,
    medicinesUsed: result.casualtyResult?.medicinesUsed ?? 0,
    militarySuppliesUsed: result.militarySupplyResult?.used ?? 0,
    damage: (result.damageResult?.records ?? []).map((row) => ({
      buildingId: row.buildingId,
      status: row.status,
      amount: row.amount
    })),
    terminal: result.terminal
  });
}

export function resolveBattleRound({
  holding,
  state = holding?.gm?.massCombat ?? {},
  calc,
  defenseTotal = 0,
  calculationDependencies = {},
  random = Math.random,
  compactNameList
} = {}) {
  const militarySupplyResult = consumeDefenderMilitarySupplies(holding, state, calculationDependencies);
  if (!militarySupplyResult.ok) throw new Error(`FBL Skyhold | ${militarySupplyResult.text}`);
  const defenderRolls = dicePool(calc?.defenderPool, random);
  const attackerRolls = dicePool(calc?.attackerPool, random);
  const defenderSuccesses = successCount(defenderRolls);
  const attackerSuccesses = successCount(attackerRolls);
  const margin = defenderSuccesses - attackerSuccesses;
  const round = Math.max(1, asInt(state.round, 1));
  const consequences = roundConsequences({ defenderSuccesses, attackerSuccesses, margin }, calc, state, { random });

  state.defenderLossSteps = Math.max(0, asInt(state.defenderLossSteps ?? state.defenderLosses, 0) + consequences.defenderLossDelta);
  state.attackerLossSteps = Math.max(0, asInt(state.attackerLossSteps ?? state.attackerLosses, 0) + consequences.attackerLossDelta);
  state.settlementDamage = Math.max(0, asInt(state.settlementDamage, 0) + consequences.settlementDamageDelta);
  state.breachProgress = Math.max(0, asInt(state.breachProgress, 0) + consequences.breachDelta);
  state.objectiveProgress = Math.max(0, asInt(state.objectiveProgress, 0) + consequences.objectiveDelta);
  state.defenderPosition = clamp(asInt(state.defenderPosition, 0) + consequences.defenderPositionDelta, 0, 3);
  state.attackerPosition = clamp(asInt(state.attackerPosition, 0) + consequences.attackerPositionDelta, 0, 3);

  const battleLostForMedicine = asInt(state.defenderLossSteps ?? state.defenderLosses, 0) >= asInt(calc?.defenderLossTrack?.threshold, 999)
    || asInt(state.objectiveProgress, 0) >= asInt(calc?.objectiveTrack?.threshold, 999);
  const casualtyResult = applyDefenderResidentCasualties(
    holding,
    state,
    consequences.defenderLossDelta,
    { ...calc, defenderRoundLost: battleLostForMedicine },
    {
      random,
      compactNameList,
      medicalAssignments: calculationDependencies.medicalAssignments,
      medicalCapacityForBuilding: calculationDependencies.medicalCapacityForBuilding,
      resourceQuantity: calculationDependencies.resourceQuantity,
      consumeResource: calculationDependencies.consumeResource
    }
  );
  const damageResult = applySettlementBattleDamage(holding, state, consequences.settlementDamageDelta, calc, { random });
  state.round = round + 1;
  const postCalc = calculateBattle(holding, state, { defenseTotal, ...calculationDependencies });
  const terminal = battleTerminalState(state, postCalc);

  const result = {
    round,
    defenderRolls,
    attackerRolls,
    defenderSuccesses,
    attackerSuccesses,
    margin,
    consequences,
    militarySupplyResult,
    casualtyResult,
    damageResult,
    terminal,
    postCalc
  };
  result.fingerprint = resultFingerprint(result);
  return result;
}

export function createPendingBattleRound({
  holding,
  state = holding?.gm?.massCombat ?? {},
  calc,
  defenseTotal = 0,
  calculationDependencies = {},
  random = Math.random,
  compactNameList
} = {}) {
  const signature = battleRoundSignature(holding, state);
  const draftHolding = clone(holding);
  const draftState = draftHolding.gm.massCombat;
  const recorder = createRandomDecisionRecorder(random);
  const preview = resolveBattleRound({
    holding: draftHolding,
    state: draftState,
    calc,
    defenseTotal,
    calculationDependencies,
    random: () => recorder.random(),
    compactNameList
  });
  const pendingRound = {
    schemaVersion: PENDING_ROUND_SCHEMA_VERSION,
    roundId: makeId("battle-round", 20),
    battleId: String(state.battleId ?? ""),
    round: preview.round,
    createdAt: new Date().toISOString(),
    stateSignature: signature,
    rollFormula: `${calc?.defenderPool ?? 0}d6 vs ${calc?.attackerPool ?? 0}d6`,
    rollMode: "recorded-d6",
    defenderPool: Math.max(0, asInt(calc?.defenderPool, 0)),
    attackerPool: Math.max(0, asInt(calc?.attackerPool, 0)),
    defenderRolls: preview.defenderRolls,
    attackerRolls: preview.attackerRolls,
    defenderSuccesses: preview.defenderSuccesses,
    attackerSuccesses: preview.attackerSuccesses,
    margin: preview.margin,
    consequences: clone(preview.consequences),
    casualtyText: String(preview.casualtyResult?.text ?? ""),
    militarySupplyText: String(preview.militarySupplyResult?.text ?? ""),
    damageText: String(preview.damageResult?.text ?? ""),
    casualtyPreview: (preview.casualtyResult?.records ?? []).map((row) => ({
      personId: String(row.personId ?? ""),
      name: String(row.name ?? ""),
      condition: String(row.condition ?? ""),
      label: String(row.label ?? ""),
      treated: Boolean(row.treated),
      supplied: Boolean(row.supplied),
      medicineUsed: Boolean(row.medicineUsed),
      sourceLabel: String(row.sourceLabel ?? "")
    })),
    damagePreview: (preview.damageResult?.records ?? []).map((row) => ({
      buildingId: String(row.buildingId ?? ""),
      name: String(row.name ?? ""),
      status: String(row.status ?? ""),
      amount: Math.max(0, asInt(row.amount, 0))
    })),
    terminal: clone(preview.terminal),
    randomTrace: recorder.values,
    fingerprint: preview.fingerprint
  };
  return { pendingRound, preview };
}

export function applyPendingBattleRound({
  holding,
  state = holding?.gm?.massCombat ?? {},
  pendingRound = state?.pendingRound,
  calc,
  defenseTotal = 0,
  calculationDependencies = {},
  compactNameList
} = {}) {
  if (!pendingRound || typeof pendingRound !== "object") return { ok: false, reason: "missing" };
  if (battleRoundSignature(holding, state) !== String(pendingRound.stateSignature ?? "")) return { ok: false, reason: "stale" };
  const replay = createRandomDecisionReplay(pendingRound.randomTrace);
  const result = resolveBattleRound({
    holding,
    state,
    calc,
    defenseTotal,
    calculationDependencies,
    random: () => replay.random(),
    compactNameList
  });
  if (!replay.complete() || result.fingerprint !== pendingRound.fingerprint) {
    return { ok: false, reason: "trace-mismatch", consumed: replay.consumed() };
  }
  return { ok: true, roundId: String(pendingRound.roundId ?? ""), ...result };
}

export function pendingBattleRoundContext(pendingRound = null) {
  if (!pendingRound || typeof pendingRound !== "object") return null;
  const signed = (value) => `${asInt(value, 0) > 0 ? "+" : ""}${asInt(value, 0)}`;
  return {
    ...pendingRound,
    defenderRollText: (pendingRound.defenderRolls ?? []).join(", ") || "—",
    attackerRollText: (pendingRound.attackerRolls ?? []).join(", ") || "—",
    marginText: signed(pendingRound.margin),
    deltaText: [
      `потери З +${asInt(pendingRound.consequences?.defenderLossDelta, 0)}`,
      `В +${asInt(pendingRound.consequences?.attackerLossDelta, 0)}`,
      `урон +${asInt(pendingRound.consequences?.settlementDamageDelta, 0)}`,
      `брешь +${asInt(pendingRound.consequences?.breachDelta, 0)}`,
      `цель ${signed(pendingRound.consequences?.objectiveDelta)}`
    ].join("; ")
  };
}
