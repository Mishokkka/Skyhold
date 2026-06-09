import { asInt, asNumber, STRATEGIES } from "./rules.js";
import { casualtySummaryFromRecords } from "./casualties.js";

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

export function escalateBuildingBattleDamage(building, amount = 1) {
  const current = String(building?.constructionStatus ?? "built");
  const order = ["built", "damaged", "heavilyDamaged", "destroyed"];
  const index = Math.max(0, order.indexOf(current));
  const step = amount >= 4 ? 2 : 1;
  const next = order[Math.min(order.length - 1, index + step)];
  building.constructionStatus = next;
  building.status = battleBuildingStatusLabel(next);
  building.battleDamage = Math.max(0, asInt(building.battleDamage, 0) + Math.max(1, asInt(amount, 1)));
  building.repairTarget = next === "damaged" ? 3 : next === "heavilyDamaged" ? 6 : next === "destroyed" ? 10 : 0;
  building.repairProgress = 0;
  return next;
}

export function applySettlementBattleDamage(app, holding, state = {}, delta = 0, calc = {}) {
  const amount = Math.max(0, asInt(delta, 0));
  if (!amount) return { text: "", damaged: [] };
  const candidates = (holding?.buildings?.list ?? []).filter((building) => ["built", "damaged", "heavilyDamaged"].includes(String(building?.constructionStatus ?? "built")));
  if (!candidates.length) return { text: "Урон владению есть, но подходящих зданий для повреждения не найдено.", damaged: [] };

  const attackerStrategy = calc?.attackerStrategy ?? STRATEGIES.attack;
  const defenseTargets = candidates.filter((building) => app._isDefenseBuilding(building));
  const storageTargets = candidates.filter((building) => /(склад|хранил|погреб|warehouse|storage|depot)/i.test(`${building?.name ?? ""} ${building?.type ?? ""} ${building?.category ?? ""}`));
  const housingTargets = candidates.filter((building) => /(жиль|дом|казарм|barrack|house)/i.test(`${building?.name ?? ""} ${building?.type ?? ""} ${building?.category ?? ""}`));

  let pool = [];
  if (attackerStrategy?.breach && defenseTargets.length) pool = defenseTargets;
  else if (attackerStrategy?.raid && storageTargets.length) pool = storageTargets;
  else if (calc?.breachOpen && housingTargets.length) pool = housingTargets;
  else pool = [...defenseTargets, ...storageTargets, ...candidates];

  const hits = amount >= 5 ? 2 : 1;
  const damaged = [];
  const records = [];
  const round = Math.max(1, asInt(state.round, 1));
  const battleId = state.battleId || (state.battleId = foundry.utils.randomID?.(10) ?? `battle-${Date.now()}`);

  for (let i = 0; i < hits; i += 1) {
    const available = pool.filter((item) => !damaged.includes(item));
    const target = available[Math.floor(Math.random() * available.length)] ?? candidates[0];
    if (!target) continue;

    const next = escalateBuildingBattleDamage(target, amount);
    const label = battleBuildingStatusLabel(next);
    const stamp = `${label} в бою за владение (${holdingBattleDateText(holding)}), урон +${amount}.`;
    target.notes = [String(target.notes ?? "").trim(), stamp].filter(Boolean).join("\n");
    damaged.push(target);
    records.push({ id: foundry.utils.randomID?.(10) ?? `bd-${Date.now()}-${i}`, battleId, round, buildingId: String(target.id ?? ""), name: target.name || "Здание", status: label, amount });
  }

  if (records.length) {
    if (!Array.isArray(state.buildingDamageLog)) state.buildingDamageLog = [];
    state.buildingDamageLog.push(...records);
    state.buildingDamageLog = state.buildingDamageLog.slice(-40);
  }

  return { damaged, records, text: records.length ? records.map((row) => `${row.name}: ${row.status}`).join("; ") : "" };
}

export function battleAftermathRows(app, holding, state = {}) {
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
    peopleText: casualtySummaryFromRecords(latestCasualties, (names) => app._compactNameList(names)),
    buildingText
  };
}

export function startBattleRepairs(holding) {
  const targets = (holding?.buildings?.list ?? []).filter((building) => ["damaged", "heavilyDamaged"].includes(String(building?.constructionStatus ?? "")));
  for (const building of targets) {
    const old = String(building.constructionStatus ?? "damaged");
    building.repairOf = old;
    building.constructionStatus = "building";
    building.status = "Ремонтируется";
    building.buildProgress = 0;
    building.buildTarget = old === "heavilyDamaged" ? Math.max(6, asInt(building.repairTarget, 6)) : Math.max(3, asInt(building.repairTarget, 3));
    building.notes = [String(building.notes ?? "").trim(), `Начат ремонт после боя (${holdingBattleDateText(holding)}). Нужно успехов: ${building.buildTarget}.`].filter(Boolean).join("\n");
  }
  return targets;
}
