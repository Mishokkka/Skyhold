import { clone, makeId } from "../../data/utils.js";
import { asInt } from "./rules.js";

export const BATTLE_ARCHIVE_LIMIT = 20;

function archiveSnapshot(state = {}) {
  const snapshot = clone(state);
  delete snapshot.archive;
  delete snapshot.pendingRound;
  return snapshot;
}

export function archiveBattle(state = {}, {
  outcome = state.outcome ?? "active",
  terminalReason = state.terminalReason ?? "",
  resolvedBy = globalThis.game?.user?.id ?? "",
  resolvedAt = new Date().toISOString(),
  reason = "resolved"
} = {}) {
  const battleId = String(state.battleId ?? "");
  const hasBattle = Boolean(battleId || (state.log ?? []).length || asInt(state.round, 1) > 1);
  if (!hasBattle) return null;
  if (!Array.isArray(state.archive)) state.archive = [];
  const existing = battleId ? state.archive.find((entry) => String(entry?.battleId ?? "") === battleId) : null;
  if (existing) return existing;

  const entry = {
    id: makeId("battle-archive", 20),
    battleId: battleId || makeId("battle", 20),
    title: String(state.title || "Битва за владение"),
    enemyName: String(state.enemyName || "Нападающие"),
    objective: String(state.objective || ""),
    scale: String(state.scale || "raid"),
    outcome: String(outcome || "active"),
    terminalReason: String(terminalReason || ""),
    reason: String(reason || "resolved"),
    startedAt: String(state.startedAt || state.log?.[0]?.createdAt || ""),
    resolvedAt: String(resolvedAt || ""),
    resolvedBy: String(resolvedBy || ""),
    roundsPlayed: Math.max(0, asInt(state.round, 1) - 1),
    casualtyCount: (state.casualtyLog ?? []).filter((row) => !battleId || String(row?.battleId ?? "") === battleId).length,
    damagedBuildingCount: new Set((state.buildingDamageLog ?? [])
      .filter((row) => !battleId || String(row?.battleId ?? "") === battleId)
      .map((row) => String(row?.buildingId ?? ""))
      .filter(Boolean)).size,
    snapshot: archiveSnapshot(state)
  };
  state.archive.push(entry);
  state.archive = state.archive.slice(-BATTLE_ARCHIVE_LIMIT);
  return entry;
}

export function battleArchiveContext(entries = []) {
  return (Array.isArray(entries) ? entries : []).slice().reverse().map((entry) => ({
    ...entry,
    resolvedText: String(entry.resolvedAt ?? "").replace("T", " ").slice(0, 16),
    outcomeLabel: entry.outcome === "attacker-victory"
      ? "Победа нападающих"
      : entry.outcome === "defender-victory"
        ? "Победа защитников"
        : entry.outcome === "contested"
          ? "Спорный исход"
          : entry.reason === "aborted"
            ? "Бой прерван"
            : "Завершён"
  }));
}
