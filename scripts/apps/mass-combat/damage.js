import { asInt, STRATEGIES } from "./rules.js";
import { makeId } from "../../data/utils.js";
import { casualtySummaryFromRecords } from "./casualties.js";
import { buildingOperationalState, normalizeBuildingOperationalState, setBuildingCondition, startBuildingRepair } from "../../core/building-state.js";
import { weightedBattleTargets } from "./targets.js";

export function battleBuildingStatusLabel(status = "built") {
  const value = String(status || "built");
  if (value === "damaged") return "Повреждено";
  if (value === "heavilyDamaged") return "Сильно повреждено";
  if (value === "destroyed") return "Разрушено";
  if (value === "building") return "Ремонтируется";
  return "Построено";
}

function holdingBattleDateText(holding) {
  return String(holding?.gm?.calendaria?.lastDateText ?? holding?.gm?.calendaria?.lastDateKey ?? "").trim() || "игровая дата не указана";
}

function buildingRepairTarget(building, status = building?.constructionStatus ?? "built") {
  const baseTarget = Math.max(1, asInt(building?.originalBuildTarget ?? building?.baseBuildTarget ?? building?.buildTarget, 6));
  const value = String(status || "built");
  if (value === "damaged") return Math.ceil(baseTarget / 3);
  if (value === "heavilyDamaged") return Math.ceil((baseTarget * 2) / 3);
  if (value === "destroyed") return baseTarget;
  return 0;
}

export function escalateBuildingBattleDamage(building, amount = 1) {
  normalizeBuildingOperationalState(building);
  const current = building.condition;
  const order = ["intact", "damaged", "heavilyDamaged", "destroyed"];
  const index = Math.max(0, order.indexOf(current));
  const step = amount >= 4 ? 2 : 1;
  const next = order[Math.min(order.length - 1, index + step)];
  setBuildingCondition(building, next);
  building.status = battleBuildingStatusLabel(building.constructionStatus);
  building.battleDamage = Math.max(0, asInt(building.battleDamage, 0) + Math.max(1, asInt(amount, 1)));
  building.repairTarget = buildingRepairTarget(building, next);
  building.repairProgress = 0;
  return next;
}

export function applySettlementBattleDamage(holding, state = {}, delta = 0, calc = {}, { random = Math.random } = {}) {
  const amount = Math.max(0, asInt(delta, 0));
  if (!amount) return { text: "", damaged: [] };
  const candidates = (holding?.buildings?.list ?? []).filter((building) => {
    const state = buildingOperationalState(building);
    return state.lifecycle === "active" && state.condition !== "destroyed" && !state.repairActive;
  });
  if (!candidates.length) return { text: "Урон владению есть, но подходящих зданий для повреждения не найдено.", damaged: [] };

  const attackerStrategy = calc?.attackerStrategy ?? STRATEGIES.attack;
  const pool = weightedBattleTargets(candidates, { attackerStrategy, breachOpen: calc?.breachOpen });

  const hits = amount >= 5 ? 2 : 1;
  const damaged = [];
  const records = [];
  const round = Math.max(1, asInt(state.round, 1));
  const battleId = state.battleId || (state.battleId = makeId("battle"));

  for (let i = 0; i < hits; i += 1) {
    const available = pool.filter((item) => !damaged.includes(item));
    if (!available.length) break;
    const target = available[Math.floor(random() * available.length)] ?? available[0];
    if (!target) continue;

    const next = escalateBuildingBattleDamage(target, amount);
    const label = battleBuildingStatusLabel(next);
    const stamp = `${label} в бою за владение (${holdingBattleDateText(holding)}), урон +${amount}.`;
    target.notes = [String(target.notes ?? "").trim(), stamp].filter(Boolean).join("\n");
    damaged.push(target);
    records.push({ id: makeId("bd"), battleId, round, buildingId: String(target.id ?? ""), name: target.name || "Здание", status: label, amount });
  }

  if (records.length) {
    if (!Array.isArray(state.buildingDamageLog)) state.buildingDamageLog = [];
    state.buildingDamageLog.push(...records);
    state.buildingDamageLog = state.buildingDamageLog.slice(-40);
  }

  return { damaged, records, text: records.length ? records.map((row) => `${row.name}: ${row.status}`).join("; ") : "" };
}

export function battleAftermathRows(holding, state = {}, compactNameList) {
  const battleId = String(state.battleId ?? "");
  const casualtyLog = Array.isArray(state.casualtyLog) ? state.casualtyLog : [];
  const buildingLog = Array.isArray(state.buildingDamageLog) ? state.buildingDamageLog : [];
  const currentCasualties = battleId ? casualtyLog.filter((row) => String(row?.battleId ?? "") === battleId) : [];
  const currentBuildings = battleId ? buildingLog.filter((row) => String(row?.battleId ?? "") === battleId) : [];
  const latestCasualties = currentCasualties.slice(-24);
  const latestBuildings = currentBuildings.slice(-16);
  const buildingText = latestBuildings.length
    ? latestBuildings.map((row) => `${row.name || "Здание"}: ${row.status || "повреждено"}`).join("; ")
    : "Новых повреждений зданий в этом бою нет.";
  return {
    casualtyLog: latestCasualties,
    buildingLog: latestBuildings,
    peopleText: casualtySummaryFromRecords(latestCasualties, compactNameList),
    buildingText
  };
}

export function startBattleRepairs(holding) {
  const targets = (holding?.buildings?.list ?? []).filter((building) => {
    const state = buildingOperationalState(building);
    return state.lifecycle === "active" && state.condition !== "intact" && !state.repairActive;
  });
  for (const building of targets) {
    const old = buildingOperationalState(building).condition;
    const target = buildingRepairTarget(building, old);
    startBuildingRepair(building, target);
    building.status = "Ремонтируется";
    building.notes = [String(building.notes ?? "").trim(), `Начат ремонт после боя (${holdingBattleDateText(holding)}). Нужно успехов: ${target}.`].filter(Boolean).join("\n");
  }
  return targets;
}
