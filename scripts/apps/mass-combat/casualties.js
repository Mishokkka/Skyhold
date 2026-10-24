import { makeId } from "../../data/utils.js";
import { clearPersonFromAssignments } from "../../data/resident-assignments.js";
import { isMedicalBuilding } from "../../core/building-specials.js";
import { asInt, clamp, militiaThreshold } from "./rules.js";
import {
  isAdultResident,
  isInjuredResident,
  isMilitaryResident,
  isSoldierResident
} from "./residents.js";
import { builtBuildings, isDefenseBuilding } from "./sources.js";

/**
 * Roll a positive-sided die from a [0, 1) draw, including one at the zero endpoint.
 * @returns {number} Integer result from one through sides.
 */
function rollDie(random, sides = 6) {
  return Math.max(1, Math.ceil(random() * sides));
}

export function medicalSupport(holding, { battleLost = false, medicalAssignments = null, medicalCapacityForBuilding = null } = {}) {
  const built = builtBuildings(holding);
  const medicalBuildings = built.filter((building) => isMedicalBuilding(building));
  const workers = new Map();
  for (const building of medicalBuildings) {
    for (const id of (Array.isArray(building.assignedWorkerIds) ? building.assignedWorkerIds : [])) {
      const person = (holding?.people?.list ?? []).find((row) => String(row.id) === String(id) && !row.dead && !isInjuredResident(row));
      if (person) workers.set(String(person.id), person);
    }
  }
  let capacity = 0;
  let workerEfficiency = 0;
  if (!battleLost) {
    const assignments = typeof medicalAssignments === "function" ? medicalAssignments(holding) : medicalAssignments;
    for (const building of medicalBuildings) {
      const assigned = assignments instanceof Map ? assignments.get(String(building?.id ?? "")) : null;
      if (assigned) {
        capacity += Math.max(0, asInt(assigned.capacity, 0) - (assigned.patients?.length ?? 0));
        workerEfficiency += Math.max(0, Number(assigned.efficiency ?? 0) || 0);
      } else if (typeof medicalCapacityForBuilding === "function") {
        const stats = medicalCapacityForBuilding(holding, building);
        capacity += Math.max(0, asInt(stats?.capacity, 0));
        workerEfficiency += Math.max(0, Number(stats?.efficiency ?? 0) || 0);
      } else {
        const assignedWorkers = (building.assignedWorkerIds ?? []).filter((id) => workers.has(String(id))).length;
        capacity += assignedWorkers * 5;
      }
    }
  }
  return {
    capacity,
    used: 0,
    workers: workers.size,
    workerEfficiency,
    buildings: medicalBuildings.length,
    available: capacity > 0,
    text: capacity > 0
      ? `медмест ${capacity} (${workers.size} врачей, эфф. ${Math.round(workerEfficiency * 10) / 10}), риск смерти снижается на 1 шаг`
      : (battleLost ? "бой проигран: лечебные здания не успевают принять раненых" : "нет свободных медмест")
  };
}

export function defenderCasualtyCandidates(holding, state = {}, calc = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !isInjuredResident(person));
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

  for (const building of builtBuildings(holding).filter((building) => isDefenseBuilding(building))) {
    for (const id of (Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [])) add(id);
  }

  for (const person of people) {
    if (isSoldierResident(person) || isMilitaryResident(person)) add(person.id);
  }

  if (state.raiseMilitia === true) {
    const auto = calc?.autoDefenders ?? {};
    const autoMilitiaIds = [
      ...(Array.isArray(auto.militiaIds) ? auto.militiaIds : []),
      ...(Array.isArray(auto.militiaPartialIds) ? auto.militiaPartialIds : [])
    ].map((id) => String(id ?? "")).filter(Boolean);
    if (autoMilitiaIds.length) {
      for (const id of autoMilitiaIds) add(id);
      if (calc?.breachOpen) {
        for (const id of (Array.isArray(auto.militiaReserveIds) ? auto.militiaReserveIds : [])) add(id);
      }
    } else {
      const fallbackThreshold = militiaThreshold(holding?.gm?.defense ?? {});
      const threshold = Math.max(1, asInt(auto.militiaThreshold, fallbackThreshold));
      const militiaUnits = Math.max(0, asInt(auto.militiaUnits, 0));
      const limit = Math.max(0, militiaUnits * threshold);
      const civilians = people.filter((person) => isAdultResident(person) && !isSoldierResident(person) && !isMilitaryResident(person));
      for (const person of civilians.slice(0, limit)) add(person.id);
    }
  }

  return Array.from(ids).map((id) => byId.get(id)).filter(Boolean);
}

export function applyBattleConditionToPerson(holding, person, condition = "injured", { days = 1, note = "" } = {}) {
  if (!person) return "";
  if (condition === "dead") {
    person.dead = true;
    person.status = "Погиб";
    person.deathDate = person.deathDate || new Date().toISOString().slice(0, 10);
    person.deathNote = [String(person.deathNote ?? "").trim(), note || "Погиб при защите поселения."].filter(Boolean).join("\n");
    clearPersonFromAssignments(holding, person.id);
    return `${person.name || "Житель"} погиб`;
  }
  const safeDays = Math.max(1, asInt(days, 1));
  person.injuredDays = Math.max(asInt(person.injuredDays, 0), safeDays);
  if (condition === "broken") person.status = `Сломлен (${person.injuredDays} дн.)`;
  else if (condition === "heavy") person.status = `Тяжело ранен (${person.injuredDays} дн.)`;
  else person.status = `Ранен (${person.injuredDays} дн.)`;
  person.battleCondition = condition;
  person.battleNote = [String(person.battleNote ?? "").trim(), note].filter(Boolean).join("\n");
  clearPersonFromAssignments(holding, person.id);
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

/**
 * Apply up to lossSteps casualties to distinct eligible defenders on a holding draft.
 * Mutates resident conditions/assignments and the battle log; medical adapters may
 * consume supplies. The caller owns authority checks and persistence of the draft.
 * @returns {object} Casualty counts, records, consumed medicine totals, and summary text.
 */
export function applyDefenderResidentCasualties(holding, state = {}, lossSteps = 0, calc = {}, {
  random = Math.random,
  compactNameList = defaultCompactNameList,
  medicalAssignments = null,
  medicalCapacityForBuilding = null,
  resourceQuantity = null,
  consumeResource = null
} = {}) {
  const steps = Math.max(0, asInt(lossSteps, 0));
  if (!steps) return { text: "", injured: 0, dead: 0, broken: 0, records: [] };
  const candidates = defenderCasualtyCandidates(holding, state, calc);
  if (!candidates.length) return { text: "Потери есть, но конкретные жители-участники не найдены.", injured: 0, dead: 0, broken: 0, records: [] };
  const candidateById = new Map(candidates.map((person) => [String(person.id), person]));
  const riskSlots = Array.isArray(calc?.defenderRiskSlots) ? calc.defenderRiskSlots.filter((slot) => (slot?.participantIds ?? []).some((id) => candidateById.has(String(id)))) : [];
  const weightedSlots = [];
  for (const slot of riskSlots) {
    const weight = Math.max(1, asInt(slot.weight, 1));
    for (let i = 0; i < weight; i += 1) weightedSlots.push(slot);
  }
  const medical = medicalSupport(holding, {
    battleLost: calc?.defenderRoundLost === true,
    medicalAssignments,
    medicalCapacityForBuilding
  });
  let injured = 0;
  let dead = 0;
  let broken = 0;
  const records = [];
  const round = Math.max(1, asInt(state.round, 1));
  const battleId = state.battleId || (state.battleId = makeId("battle"));
  const conditions = ["broken", "injured", "injured", "heavy", "heavy", "heavy"];
  const labels = { broken: "Сломлен", injured: "Ранен", heavy: "Тяжело ранен", dead: "Погиб" };
  const baseDeathChance = { broken: 1, injured: 2, heavy: 3 };
  const medicalSuppliesEnabled = state.useMedicalSupplies === true;
  const medicinesEnabled = state.useMedicinesForHeavyCasualties === true;
  let medicalSuppliesAvailable = typeof resourceQuantity === "function"
    ? Math.max(0, asInt(resourceQuantity(holding, "medical-supplies"), 0))
    : 0;
  let medicinesAvailable = typeof resourceQuantity === "function"
    ? Math.max(0, asInt(resourceQuantity(holding, "medicines"), 0))
    : 0;
  let medicalSupplyCoverage = 0;
  let medicalSuppliesUsed = 0;
  let medicinesUsed = 0;

  for (let i = 0; i < steps; i += 1) {
    const alive = candidates.filter((person) => !person.dead && !isInjuredResident(person));
    if (!alive.length) break;
    let pool = alive;
    let selectedSlot = null;
    if (weightedSlots.length) {
      const slot = weightedSlots[Math.floor(random() * weightedSlots.length)];
      const slotPeople = (slot?.participantIds ?? []).map((id) => candidateById.get(String(id))).filter((person) => person && !person.dead && !isInjuredResident(person));
      if (slotPeople.length) {
        pool = slotPeople;
        selectedSlot = slot;
      }
    }
    const person = pool[Math.floor(random() * pool.length)] ?? alive[Math.floor(random() * alive.length)];
    const injuryRoll = rollDie(random);
    let condition = conditions[clamp(injuryRoll - 1, 0, 5)] ?? "injured";
    const days = condition === "heavy" ? rollDie(random) + rollDie(random) + 5 : condition === "injured" ? rollDie(random) + 2 : rollDie(random, 3);
    const treated = medical.used < medical.capacity;
    if (treated) medical.used += 1;
    let supplied = false;
    let medicineUsed = false;
    if (treated && medicalSuppliesEnabled) {
      if (medicalSupplyCoverage <= 0 && medicalSuppliesAvailable > 0) {
        const consumed = typeof consumeResource === "function"
          ? consumeResource(holding, "medical-supplies", 1, `Бой ${battleId}, раунд ${round}: помощь раненым`)
          : false;
        if (consumed !== false) {
          medicalSuppliesAvailable -= 1;
          medicalSuppliesUsed += 1;
          medicalSupplyCoverage = 5;
        }
      }
      if (medicalSupplyCoverage > 0) {
        supplied = true;
        medicalSupplyCoverage -= 1;
      }
    }
    if (treated && supplied && condition === "heavy" && medicinesEnabled && medicinesAvailable > 0) {
      const consumed = typeof consumeResource === "function"
        ? consumeResource(holding, "medicines", 1, `Бой ${battleId}, раунд ${round}: тяжелый раненый`)
        : false;
      if (consumed !== false) {
        medicinesAvailable -= 1;
        medicinesUsed += 1;
        medicineUsed = true;
      }
    }
    const deathRoll = rollDie(random);
    const deathChance = Math.max(0, (baseDeathChance[condition] ?? 2) - (treated ? 1 : 0) - (supplied ? 1 : 0) - (medicineUsed ? 1 : 0));
    const sourceText = selectedSlot?.sourceLabel ? ` Источник риска: ${selectedSlot.sourceLabel}.` : "";
    const treatmentText = [
      treated ? "помещен в лазарет" : medical.text,
      supplied ? "использованы медицинские припасы" : "",
      medicineUsed ? "использованы лекарства" : ""
    ].filter(Boolean).join(", ");
    const note = `Раунд ${round}, бой ${battleId}.${sourceText} Травма d6=${injuryRoll}, смерть d6=${deathRoll}; ${treatmentText}.`;
    if (deathChance > 0 && deathRoll <= deathChance) condition = "dead";

    if (condition === "dead") dead += 1;
    else if (condition === "broken") broken += 1;
    else injured += 1;

    applyBattleConditionToPerson(holding, person, condition, { days, note });
    records.push({
      id: makeId("cas"),
      battleId,
      round,
      personId: String(person.id ?? ""),
      name: person.name || "Житель",
      condition,
      label: labels[condition] ?? "Ранен",
      treated,
      supplied,
      medicineUsed,
      deathChance,
      sourceId: String(selectedSlot?.sourceId ?? ""),
      sourceLabel: selectedSlot?.sourceLabel || "",
      sourceType: selectedSlot?.type || "",
      exposure: selectedSlot?.exposure || "frontline",
      note
    });
  }
  if (records.length) {
    if (!Array.isArray(state.casualtyLog)) state.casualtyLog = [];
    state.casualtyLog.push(...records);
    state.casualtyLog = state.casualtyLog.slice(-60);
  }
  const summary = casualtySummaryFromRecords(records, compactNameList);
  const sourceCounts = new Map();
  for (const record of records) {
    const label = String(record.sourceLabel || "прочие участники");
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1);
  }
  const sourceText = sourceCounts.size ? ` Риск: ${Array.from(sourceCounts.entries()).slice(0, 4).map(([label, count]) => `${label} ×${count}`).join(", ")}.` : "";
  const medicalText = medical.capacity ? ` Лазарет: ${Math.min(medical.used, medical.capacity)}/${medical.capacity} мест использовано.` : "";
  const resourceText = medicalSuppliesUsed || medicinesUsed
    ? ` Расход медицины: припасы ${medicalSuppliesUsed}, лекарства ${medicinesUsed}.`
    : "";
  return { injured, dead, broken, records, medicalSuppliesUsed, medicinesUsed, text: `${summary}${sourceText}${medicalText}${resourceText}`.trim() };
}

function defaultCompactNameList(names = [], limit = 4) {
  const clean = names.map((name) => String(name ?? "").trim()).filter(Boolean);
  if (clean.length <= limit) return clean.join(", ");
  return `${clean.slice(0, limit).join(", ")} и еще ${clean.length - limit}`;
}
