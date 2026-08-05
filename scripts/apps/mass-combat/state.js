import { ATTACKER_PRESETS, OBJECTIVE_THRESHOLDS, ROUND_LIMITS, SCALES, asInt, asNumber, clamp } from "./rules.js";
import { isMassCombatUnitTagField } from "./tag-config.js";

const NEW_TAG_FIELDS = [
  "Infantry", "Shooters", "Mobile", "Heavy", "Sappers", "Siege", "Skirmishers", "Monsters", "Sacred"
];
const LEGACY_TAG_FIELDS = ["Fire", "Recon", "Cavalry", "Engineering", "Monstrous"];

const NUMERIC_FIELDS = new Set([
  "schemaVersion",
  "defenderUnits", "defenderBS", "defenderCommand", "defenderHero", "defenderMorale", "defenderSpecial", "defenderPosition",
  "attackerUnits", "attackerBS", "attackerCommand", "attackerHero", "attackerSpecial", "attackerPosition",
  ...NEW_TAG_FIELDS.flatMap((suffix) => [`defender${suffix}`, `attacker${suffix}`]),
  ...LEGACY_TAG_FIELDS.flatMap((suffix) => [`defender${suffix}`, `attacker${suffix}`]),
  "round", "roundLimit", "breachProgress", "objectiveProgress", "objectiveThreshold", "defenderLossSteps", "attackerLossSteps", "settlementDamage",
  "defenderShaken", "defenderBroken", "attackerShaken", "attackerBroken"
]);

const BOOLEAN_FIELDS = new Set(["useDefenseSquads", "raiseMilitia"]);
const TEXT_FIELDS = new Set(["title", "enemyName", "objective", "roundThreat", "scale", "defenseMode", "accessMode", "defenderMobilization", "attackerPreset", "defenderStrategy", "attackerStrategy", "notes", "battleId", "phase", "outcome", "terminalReason", "startedAt", "resolvedAt", "resolvedBy"]);

const DEFENDER_STRATEGIES = new Set(["holdFortifications", "deepDefense", "counterattack", "protectCivilians", "protectObjective", "fightingWithdrawal", "defense", "allOutDefense", "sally", "rally", "parley", "retreat"]);
const ATTACKER_STRATEGIES = new Set(["frontalAssault", "probingAdvance", "raidWithdraw", "sabotage", "bombardment", "breakthrough", "attack", "allOutAssault", "deliberateAssault", "skirmish", "raid", "rally", "parley", "retreat"]);
const ROUND_THREATS = new Set(["assault", "fire", "arson", "sabotage", "panic", "breach", "raid"]);
const DEFENSE_MODES = new Set(["behindWalls", "outerWorks", "surprised", "outside"]);
const ACCESS_MODES = new Set(["normal", "airborne", "water", "cliff", "portal"]);
const MOBILIZATIONS = new Set(["watch", "militia", "manual"]);
const LEGACY_ATTACKER_SOURCE_TAG_PATTERN = /^attackerSourceTag(\d+)$/;
const ATTACKER_SOURCE_PRIMARY_TAG_PATTERN = /^attackerSourcePrimaryTag(\d+)$/;
const ATTACKER_SOURCE_EFFICIENCY_PATTERN = /^attackerSourceEfficiency(\d+)$/;

const STRATEGY_MIGRATION = {
  defense: "holdFortifications",
  allOutDefense: "holdFortifications",
  sally: "counterattack",
  rally: "deepDefense",
  retreat: "fightingWithdrawal",
  attack: "frontalAssault",
  allOutAssault: "frontalAssault",
  deliberateAssault: "bombardment",
  skirmish: "probingAdvance",
  raid: "raidWithdraw"
};

export const MASS_COMBAT_RESET_STATE = Object.freeze({
  schemaVersion: 2,
  phase: "setup",
  outcome: "active",
  terminalReason: "",
  pendingRound: null,
  startedAt: "",
  resolvedAt: "",
  resolvedBy: "",
  archive: [],
  title: "",
  enemyName: "Нападающие",
  objective: "Налет",
  roundThreat: "assault",
  scale: "raid",
  defenseMode: "behindWalls",
  accessMode: "normal",
  defenderMobilization: "watch",
  useDefenseSquads: true,
  raiseMilitia: false,
  attackerPreset: "custom",
  defenderUnits: 0,
  defenderBS: 0,
  defenderCommand: 0,
  defenderHero: 0,
  defenderMorale: 0,
  defenderSpecial: 0,
  defenderPosition: 0,
  defenderStrategy: "holdFortifications",
  attackerUnits: 3,
  attackerBS: 15,
  attackerCommand: 0,
  attackerHero: 0,
  attackerSpecial: 0,
  attackerPosition: 0,
  attackerStrategy: "frontalAssault",
  defenderInfantry: 0,
  defenderShooters: 0,
  defenderMobile: 0,
  defenderHeavy: 0,
  defenderSappers: 0,
  defenderSiege: 0,
  defenderSkirmishers: 0,
  defenderMonsters: 0,
  defenderSacred: 0,
  attackerInfantry: 3,
  attackerShooters: 0,
  attackerMobile: 0,
  attackerHeavy: 0,
  attackerSappers: 0,
  attackerSiege: 0,
  attackerSkirmishers: 0,
  attackerMonsters: 0,
  attackerSacred: 0,
  round: 1,
  roundLimit: 3,
  breachProgress: 0,
  objectiveProgress: 0,
  objectiveThreshold: 3,
  defenderLossSteps: 0,
  attackerLossSteps: 0,
  settlementDamage: 0,
  defenderShaken: 0,
  defenderBroken: 0,
  attackerShaken: 0,
  attackerBroken: 0,
  notes: "",
  battleId: "",
  casualtyLog: [],
  buildingDamageLog: [],
  log: []
});

function normalizeField(key, value) {
  if (BOOLEAN_FIELDS.has(key)) return Boolean(value);
  if (LEGACY_ATTACKER_SOURCE_TAG_PATTERN.test(key) || ATTACKER_SOURCE_PRIMARY_TAG_PATTERN.test(key)) return String(value ?? "");
  if (ATTACKER_SOURCE_EFFICIENCY_PATTERN.test(key)) return Math.max(0, asNumber(value, 0));
  if (isMassCombatUnitTagField(key) || isDynamicCustomTagField(key)) return asInt(value, 0);
  if (NUMERIC_FIELDS.has(key)) return asInt(value, 0);
  if (TEXT_FIELDS.has(key)) return String(value ?? "");
  return value;
}

function isDynamicCustomTagField(key = "") {
  return /^(defender|attacker)[A-Z][A-Za-z0-9_]*-[A-Za-z0-9_-]*$/.test(String(key ?? ""));
}

function migrateStrategy(key, side) {
  const value = String(key ?? "");
  if (STRATEGY_MIGRATION[value]) return STRATEGY_MIGRATION[value];
  if (side === "defender" && !DEFENDER_STRATEGIES.has(value)) return "holdFortifications";
  if (side === "attacker" && !ATTACKER_STRATEGIES.has(value)) return "frontalAssault";
  return value;
}

function migrateLegacyTags(next) {
  const pairs = [
    ["Fire", "Shooters"],
    ["Recon", "Skirmishers"],
    ["Cavalry", "Mobile"],
    ["Engineering", "Sappers"],
    ["Monstrous", "Monsters"]
  ];
  for (const side of ["defender", "attacker"]) {
    for (const [legacy, modern] of pairs) {
      const oldKey = `${side}${legacy}`;
      const newKey = `${side}${modern}`;
      if (next[newKey] === undefined && next[oldKey] !== undefined) next[newKey] = Math.max(0, asInt(next[oldKey], 0));
      delete next[oldKey];
    }
  }
}

function migrateLegacySourcePrimaryTags(next) {
  for (const key of Object.keys(next)) {
    const match = key.match(LEGACY_ATTACKER_SOURCE_TAG_PATTERN);
    if (!match) continue;
    const modernKey = `attackerSourcePrimaryTag${match[1]}`;
    if (next[modernKey] === undefined) next[modernKey] = String(next[key] ?? "");
    delete next[key];
  }
}

export function normalizeMassCombatPatch(patch = {}) {
  const next = {};
  for (const [key, value] of Object.entries(patch ?? {})) next[key] = normalizeField(key, value);
  migrateLegacyTags(next);
  migrateLegacySourcePrimaryTags(next);
  if ("scale" in next && !SCALES[next.scale]) next.scale = "raid";
  if ("scale" in next && !Object.hasOwn(next, "roundLimit")) next.roundLimit = ROUND_LIMITS[next.scale] ?? 3;
  if ("scale" in next && !Object.hasOwn(next, "objectiveThreshold")) next.objectiveThreshold = OBJECTIVE_THRESHOLDS[next.scale] ?? 3;
  if ("round" in next) next.round = Math.max(1, asInt(next.round, 1));
  if ("roundLimit" in next) next.roundLimit = Math.max(1, asInt(next.roundLimit, ROUND_LIMITS[next.scale] ?? 3));
  if ("objectiveThreshold" in next) next.objectiveThreshold = Math.max(1, asInt(next.objectiveThreshold, OBJECTIVE_THRESHOLDS[next.scale] ?? 3));
  if ("defenderPosition" in next) next.defenderPosition = clamp(next.defenderPosition, 0, 3);
  if ("attackerPosition" in next) next.attackerPosition = clamp(next.attackerPosition, 0, 3);
  if ("defenseMode" in next && !DEFENSE_MODES.has(next.defenseMode)) next.defenseMode = "behindWalls";
  if ("accessMode" in next && !ACCESS_MODES.has(next.accessMode)) next.accessMode = "normal";
  if ("roundThreat" in next && !ROUND_THREATS.has(next.roundThreat)) next.roundThreat = "assault";
  if ("defenderMobilization" in next && !MOBILIZATIONS.has(next.defenderMobilization)) next.defenderMobilization = "watch";
  if ("defenderStrategy" in next) next.defenderStrategy = migrateStrategy(next.defenderStrategy, "defender");
  if ("attackerStrategy" in next) next.attackerStrategy = migrateStrategy(next.attackerStrategy, "attacker");
  if ("attackerPreset" in next && !ATTACKER_PRESETS[next.attackerPreset]) next.attackerPreset = "custom";
  if ("schemaVersion" in next) next.schemaVersion = Math.max(2, asInt(next.schemaVersion, 2));
  if ("phase" in next && !["setup", "active", "pending", "terminal", "aftermath", "archived"].includes(next.phase)) next.phase = "setup";
  if ("outcome" in next && !["active", "attacker-victory", "defender-victory", "contested"].includes(next.outcome)) next.outcome = "active";
  for (const key of ["defenderLossSteps", "attackerLossSteps", "settlementDamage", "breachProgress", "objectiveProgress"]) if (key in next) next[key] = Math.max(0, asInt(next[key], 0));
  return next;
}

export function applyAttackerPresetToState(state = {}, presetKey = "custom") {
  const target = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const selected = ATTACKER_PRESETS[presetKey] ? String(presetKey) : "custom";
  const preset = ATTACKER_PRESETS[selected] ?? ATTACKER_PRESETS.custom;
  if (selected !== "custom") {
    for (const key of Object.keys(target)) {
      if (
        LEGACY_ATTACKER_SOURCE_TAG_PATTERN.test(key)
        || ATTACKER_SOURCE_PRIMARY_TAG_PATTERN.test(key)
        || ATTACKER_SOURCE_EFFICIENCY_PATTERN.test(key)
      ) delete target[key];
    }
  }
  Object.assign(target, normalizeMassCombatPatch({ attackerPreset: selected, ...(preset.patch ?? {}) }));
  return target;
}

const ATTACKER_PRESET_FIELDS = new Set(
  Object.values(ATTACKER_PRESETS).flatMap((preset) => Object.keys(preset?.patch ?? {}))
);

export function isAttackerPresetControlledField(key = "") {
  const field = String(key ?? "");
  return ATTACKER_PRESET_FIELDS.has(field)
    || isMassCombatUnitTagField(field, { side: "attacker" })
    || LEGACY_ATTACKER_SOURCE_TAG_PATTERN.test(field)
    || ATTACKER_SOURCE_PRIMARY_TAG_PATTERN.test(field)
    || ATTACKER_SOURCE_EFFICIENCY_PATTERN.test(field);
}

export function normalizeManualMassCombatPatch(patch = {}) {
  const next = normalizeMassCombatPatch(patch);
  if (Object.keys(patch ?? {}).some((key) => isAttackerPresetControlledField(key))) next.attackerPreset = "custom";
  return next;
}

export function pruneAttackerSourceOverrides(state = {}, units = state?.attackerUnits) {
  const target = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const count = Math.max(0, asInt(units, 0));
  for (const key of Object.keys(target)) {
    const match = key.match(ATTACKER_SOURCE_PRIMARY_TAG_PATTERN)
      ?? key.match(LEGACY_ATTACKER_SOURCE_TAG_PATTERN)
      ?? key.match(ATTACKER_SOURCE_EFFICIENCY_PATTERN);
    if (match && asInt(match[1], 0) > count) delete target[key];
  }
  return target;
}

export const pruneAttackerSourcePrimaryTags = pruneAttackerSourceOverrides;

export function resetMassCombatState() {
  return typeof structuredClone === "function" ? structuredClone(MASS_COMBAT_RESET_STATE) : JSON.parse(JSON.stringify(MASS_COMBAT_RESET_STATE));
}
