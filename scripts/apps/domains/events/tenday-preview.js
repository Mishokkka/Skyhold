import { normalLaborQdPerTenday } from "../../../data/labor-budget.js";

export const TENDAY_QD = 40;

export function normalizeTendayQd(value = TENDAY_QD) {
  const parsed = Number(value);
  const requested = Number.isFinite(parsed) ? parsed : TENDAY_QD;
  return Math.max(1, Math.floor(Math.max(TENDAY_QD, requested) / TENDAY_QD)) * TENDAY_QD;
}

export function applyPreparedTenday(current, prepared, sourceHash, { hash, clone } = {}) {
  if (typeof hash !== "function" || typeof clone !== "function") throw new TypeError("Tenday apply requires hash and clone dependencies.");
  if (!current || !prepared || hash(current) !== String(sourceHash ?? "")) return { ok: false, stale: true };
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, clone(prepared));
  return { ok: true, stale: false };
}

export function preparedTendayReplay(current, operationId = "") {
  const id = String(operationId ?? "").trim();
  if (!id) return null;
  return (current?.log ?? []).find((row) => (
    String(row?.operationId ?? row?.id ?? "") === id
      && String(row?.type ?? "") === "tenday"
  )) ?? null;
}

export function tendayDependencySnapshot(data = {}, holdingId = "") {
  const id = String(holdingId ?? "");
  const holding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === id) ?? null;
  if (!holding) return null;
  return {
    holding,
    normalLaborQdPerTenday: normalLaborQdPerTenday(),
    ...(data?.meta?.sharedMarkets ? { sharedMarkets: data.meta.sharedMarkets } : {}),
    catalog: {
      resources: data?.catalog?.resources ?? [],
      marketEconomy: data?.catalog?.marketEconomy ?? {},
      eventRegions: data?.catalog?.eventRegions ?? []
    }
  };
}

export function advanceTendayClock(holding, qd = TENDAY_QD) {
  if (!holding || typeof holding !== "object") return { before: 0, after: 0, delta: 0 };
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.calendaria || typeof holding.gm.calendaria !== "object") holding.gm.calendaria = {};
  const before = Math.max(0, Number(holding.gm.calendaria.lastQd) || 0);
  const delta = normalizeTendayQd(qd);
  const after = before + delta;
  holding.gm.calendaria.lastQd = after;
  return { before, after, delta, beforePeriod: Math.floor(before / TENDAY_QD), afterPeriod: Math.floor(after / TENDAY_QD) };
}

export function dueTendaySchedule(holding, targetQd = null) {
  const currentQd = targetQd === null || targetQd === undefined
    ? Math.max(0, Number(holding?.gm?.calendaria?.lastQd) || 0)
    : Math.max(0, Number(targetQd) || 0);
  return (holding?.gm?.eventSchedule ?? [])
    .filter((row) => String(row?.status ?? "scheduled") === "scheduled")
    .filter((row) => Math.max(0, Number(row?.dueQd) || 0) <= currentQd)
    .map((row) => ({ ...row }))
    .sort((left, right) => (Number(left?.dueQd) || 0) - (Number(right?.dueQd) || 0));
}
