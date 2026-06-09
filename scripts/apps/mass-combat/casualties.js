import { getSkyholdManager } from "../registry.js";
import { asInt, clamp, militiaThreshold } from "./rules.js";

export function medicalSupport(app, holding, { battleLost = false } = {}) {
  const built = app._builtBuildings(holding);
  const medicalBuildings = built.filter((building) => {
    const text = `${building.name ?? ""} ${building.type ?? ""} ${building.effect ?? ""} ${building.notes ?? ""} ${building.category ?? ""}`.toLowerCase();
    return /(лазарет|больниц|госпит|аптек|infirmary|hospital|healer|apothecary|medicine|медиц)/i.test(text);
  });
  const workers = [];
  for (const building of medicalBuildings) {
    for (const id of (Array.isArray(building.assignedWorkerIds) ? building.assignedWorkerIds : [])) {
      const person = (holding?.people?.list ?? []).find((row) => String(row.id) === String(id) && !row.dead && !app._isInjuredResident(row));
      if (person) workers.push(person);
    }
  }
  let capacity = 0;
  let workerEfficiency = 0;
  if (!battleLost) {
    for (const building of medicalBuildings) {
      if (typeof app._medicalCapacityForBuilding === "function") {
        const stats = app._medicalCapacityForBuilding(holding, building);
        capacity += Math.max(0, asInt(stats?.capacity, 0));
        workerEfficiency += Math.max(0, Number(stats?.efficiency ?? 0) || 0);
      } else {
        capacity += workers.length * 5;
        break;
      }
    }
  }
  return {
    capacity,
    used: 0,
    workers: workers.length,
    workerEfficiency,
    buildings: medicalBuildings.length,
    available: capacity > 0,
    text: capacity > 0
      ? `медмест ${capacity} (${workers.length} врачей, эфф. ${Math.round(workerEfficiency * 10) / 10}), риск смерти снижается на 1 шаг`
      : (battleLost ? "бой проигран: лечебные здания не успевают принять раненых" : "нет свободных медмест")
  };
}

export function defenderCasualtyCandidates(app, holding, state = {}, calc = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !app._isInjuredResident(person));
  const byId = new Map(people.map((person) => [String(person.id), person]));
  const ids = new Set();
  const add = (id) => {
    const key = String(id ?? "");
    if (key && byId.has(key)) ids.add(key);
  };

  if (state.useDefenseSquads !== false) {
    for (const squad of holding?.gm?.defense?.squads ?? []) {
      if (!squad?.equipped) continue;
      add(squad.sergeantId);
      for (const id of (squad.memberIds ?? []).slice(0, 4)) add(id);
    }
  }

  for (const building of app._builtBuildings(holding).filter((building) => app._isDefenseBuilding(building))) {
    for (const id of (Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [])) add(id);
  }

  for (const person of people) {
    if (app._isSoldierResident(person) || app._isMilitaryResident(person)) add(person.id);
  }

  if (state.raiseMilitia === true) {
    const auto = calc?.autoDefenders ?? {};
    const fallbackThreshold = militiaThreshold(holding?.gm?.defense ?? {});
    const threshold = Math.max(1, asInt(auto.militiaThreshold, fallbackThreshold));
    const militiaUnits = Math.max(0, asInt(auto.militiaUnits, 0));
    const limit = Math.max(0, militiaUnits * threshold);
    const civilians = people.filter((person) => app._isAdultResident(person) && !app._isSoldierResident(person) && !app._isMilitaryResident(person));
    for (const person of civilians.slice(0, limit)) add(person.id);
    for (const id of (Array.isArray(auto.militiaPartialIds) ? auto.militiaPartialIds : [])) add(id);
  }

  return Array.from(ids).map((id) => byId.get(id)).filter(Boolean);
}

export function applyBattleConditionToPerson(app, holding, person, condition = "injured", { days = 1, note = "" } = {}) {
  if (!person) return "";
  if (condition === "dead") {
    person.dead = true;
    person.status = "Погиб";
    person.deathDate = person.deathDate || new Date().toISOString().slice(0, 10);
    person.deathNote = [String(person.deathNote ?? "").trim(), note || "Погиб при защите поселения."].filter(Boolean).join("\n");
    getSkyholdManager()?._clearPersonFromAssignments?.(holding, person.id);
    return `${person.name || "Житель"} погиб`;
  }
  const safeDays = Math.max(1, asInt(days, 1));
  person.injuredDays = Math.max(asInt(person.injuredDays, 0), safeDays);
  if (condition === "broken") person.status = `Сломлен (${person.injuredDays} дн.)`;
  else if (condition === "heavy") person.status = `Тяжело ранен (${person.injuredDays} дн.)`;
  else person.status = `Ранен (${person.injuredDays} дн.)`;
  person.battleCondition = condition;
  person.battleNote = [String(person.battleNote ?? "").trim(), note].filter(Boolean).join("\n");
  getSkyholdManager()?._clearPersonFromAssignments?.(holding, person.id);
  return `${person.name || "Житель"}: ${person.status}`;
}

export function casualtySummaryFromRecords(records = [], compactNameList = defaultCompactNameList) {
  if (!records.length) return "Новых потерь жителей не записано.";
  const rank = { broken: 1, injured: 2, heavy: 3, dead: 4 };
  const bestByPerson = new Map();
  for (const record of records) {
    const key = String(record.personId || record.name || record.id || Math.random());
    const condition = String(record.condition ?? "injured");
    const prev = bestByPerson.get(key);
    if (!prev || (rank[condition] ?? 2) >= (rank[String(prev.condition)] ?? 2)) bestByPerson.set(key, record);
  }
  const by = { dead: [], heavy: [], injured: [], broken: [] };
  for (const record of bestByPerson.values()) {
    const key = String(record.condition ?? "injured");
    if (!by[key]) by[key] = [];
    by[key].push(record.name || "Житель");
  }
  const parts = [];
  if (by.dead.length) parts.push(`погибли ${by.dead.length}: ${compactNameList(by.dead)}`);
  if (by.heavy.length) parts.push(`тяжело ранены ${by.heavy.length}: ${compactNameList(by.heavy)}`);
  if (by.injured.length) parts.push(`ранены ${by.injured.length}: ${compactNameList(by.injured)}`);
  if (by.broken.length) parts.push(`сломлены ${by.broken.length}: ${compactNameList(by.broken)}`);
  return parts.join("; ") || "Новых потерь жителей не записано.";
}

export function applyDefenderResidentCasualties(app, holding, state = {}, lossSteps = 0, calc = {}) {
  const steps = Math.max(0, asInt(lossSteps, 0));
  if (!steps) return { text: "", injured: 0, dead: 0, broken: 0, records: [] };
  const candidates = defenderCasualtyCandidates(app, holding, state, calc);
  if (!candidates.length) return { text: "Потери есть, но конкретные жители-участники не найдены.", injured: 0, dead: 0, broken: 0, records: [] };
  const candidateById = new Map(candidates.map((person) => [String(person.id), person]));
  const riskSlots = Array.isArray(calc?.defenderRiskSlots) ? calc.defenderRiskSlots.filter((slot) => (slot?.participantIds ?? []).some((id) => candidateById.has(String(id)))) : [];
  const weightedSlots = [];
  for (const slot of riskSlots) {
    const weight = Math.max(1, asInt(slot.weight, 1));
    for (let i = 0; i < weight; i += 1) weightedSlots.push(slot);
  }
  const medical = medicalSupport(app, holding, { battleLost: calc?.defenderRoundLost === true });
  let injured = 0;
  let dead = 0;
  let broken = 0;
  const records = [];
  const round = Math.max(1, asInt(state.round, 1));
  const battleId = state.battleId || (state.battleId = foundry.utils.randomID?.(10) ?? `battle-${Date.now()}`);
  const conditions = ["broken", "injured", "injured", "heavy", "heavy", "heavy"];
  const labels = { broken: "Сломлен", injured: "Ранен", heavy: "Тяжело ранен", dead: "Погиб" };
  const baseDeathChance = { broken: 1, injured: 2, heavy: 3 };

  for (let i = 0; i < steps; i += 1) {
    const alive = candidates.filter((person) => !person.dead && !app._isInjuredResident(person));
    if (!alive.length) break;
    let pool = alive;
    let selectedSlot = null;
    if (weightedSlots.length) {
      const slot = weightedSlots[Math.floor(Math.random() * weightedSlots.length)];
      const slotPeople = (slot?.participantIds ?? []).map((id) => candidateById.get(String(id))).filter((person) => person && !person.dead && !app._isInjuredResident(person));
      if (slotPeople.length) {
        pool = slotPeople;
        selectedSlot = slot;
      }
    }
    const person = pool[Math.floor(Math.random() * pool.length)] ?? alive[Math.floor(Math.random() * alive.length)];
    const injuryRoll = Math.ceil(Math.random() * 6);
    let condition = conditions[clamp(injuryRoll - 1, 0, 5)] ?? "injured";
    const days = condition === "heavy" ? Math.ceil(Math.random() * 6) + Math.ceil(Math.random() * 6) + 5 : condition === "injured" ? Math.ceil(Math.random() * 6) + 2 : Math.ceil(Math.random() * 3);
    const treated = medical.used < medical.capacity;
    if (treated) medical.used += 1;
    const deathRoll = Math.ceil(Math.random() * 6);
    const deathChance = Math.max(0, (baseDeathChance[condition] ?? 2) - (treated ? 1 : 0));
    const sourceText = selectedSlot?.sourceLabel ? ` Источник риска: ${selectedSlot.sourceLabel}.` : "";
    const note = `Раунд ${round}, бой ${battleId}.${sourceText} Травма d6=${injuryRoll}, смерть d6=${deathRoll}; ${treated ? "помещен в лазарет" : medical.text}.`;
    if (deathChance > 0 && deathRoll <= deathChance) condition = "dead";

    if (condition === "dead") dead += 1;
    else if (condition === "broken") broken += 1;
    else injured += 1;

    applyBattleConditionToPerson(app, holding, person, condition, { days, note });
    records.push({
      id: foundry.utils.randomID?.(10) ?? `cas-${Date.now()}-${i}`,
      battleId,
      round,
      personId: String(person.id ?? ""),
      name: person.name || "Житель",
      condition,
      label: labels[condition] ?? "Ранен",
      treated,
      sourceId: String(selectedSlot?.sourceId ?? ""),
      sourceLabel: selectedSlot?.sourceLabel || "",
      sourceType: selectedSlot?.type || "",
      note
    });
  }
  if (records.length) {
    if (!Array.isArray(state.casualtyLog)) state.casualtyLog = [];
    state.casualtyLog.push(...records);
    state.casualtyLog = state.casualtyLog.slice(-60);
  }
  const summary = casualtySummaryFromRecords(records, (names) => app._compactNameList(names));
  const sourceCounts = new Map();
  for (const record of records) {
    const label = String(record.sourceLabel || "прочие участники");
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
  }
  const sourceText = sourceCounts.size ? ` Риск: ${Array.from(sourceCounts.entries()).slice(0, 4).map(([label, count]) => `${label} ×${count}`).join(", ")}.` : "";
  const medicalText = medical.capacity ? ` Лазарет: ${Math.min(medical.used, medical.capacity)}/${medical.capacity} мест использовано.` : "";
  return { injured, dead, broken, records, text: `${summary}${sourceText}${medicalText}`.trim() };
}

function defaultCompactNameList(names = [], limit = 4) {
  const clean = names.map((name) => String(name ?? "").trim()).filter(Boolean);
  if (clean.length <= limit) return clean.join(", ");
  return `${clean.slice(0, limit).join(", ")} и еще ${clean.length - limit}`;
}
