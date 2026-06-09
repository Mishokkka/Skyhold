// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, ageThresholdsFor, normalizeBelief, raceKeyFromResident } from "../../../generators/resident-rules.js";
import { TRAIT_POOLS } from "../../../generators/trait-definitions.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const EconomyEventDomain = {
async _onRunEconomyPeriod(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;

  const qd = Math.max(1, this._safeNumber(event.currentTarget?.dataset?.qd, 40));
  try {
    const data = SkyholdData.get();
    const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
    if (holdingIndex < 0) return;
    const holding = data.holdings[holdingIndex];
    const calendariaGate = this._checkCalendariaEconomyAdvance(holding, qd);
    if (!calendariaGate.ok) {
      ui.notifications.warn(calendariaGate.message);
      return;
    }
    const report = await this._runEconomyForQd(holding, qd);
    const recovery = this._advanceResidentRecovery(holding, Math.floor(qd / 4));
    if (recovery.recovered) report.work.push(`Выздоровело жителей: ${recovery.recovered}.`);
    if (!calendariaGate.snapshot?.available && qd >= 1460) {
      const aging = this._advanceResidentAges(holding, Math.floor(qd / 1460));
      if (aging.changed) report.work.push(`Возрастные категории изменились: ${aging.changed}.`);
      if (aging.educated) report.work.push(`Школа дала развитие детям: ${aging.educated}.`);
    }
    this._commitCalendariaEconomyAdvance(holding, calendariaGate);
    const summarizedReport = this._appendEconomyStorageLog(holding, report);
    await SkyholdData.set(data);
    await this._postEconomyChat(holding, summarizedReport);
    this.activeTab = "storage";
    this.render({ force: true, focus: false });
    ui.notifications.info(`Производство за ${report.periodLabel || `${qd} QD`} проведено.`);
  } catch (error) {
    console.error("FBL Skyhold | Failed to run economy period", error);
    ui.notifications.error("Не удалось провести производство. Подробности в консоли.");
  }
},

_advanceResidentRecovery(holding, days = 0) {
  const delta = Math.max(0, Math.floor(this._safeNumber(days, 0)));
  if (!delta) return { recovered: 0 };
  let recovered = 0;
  for (const person of holding?.people?.list ?? []) {
    const current = Math.max(0, Math.floor(this._safeNumber(person?.injuredDays, 0)));
    if (!current) continue;
    const next = Math.max(0, current - delta);
    person.injuredDays = next;
    if (next <= 0) {
      recovered += 1;
      if (/^Ранен/i.test(String(person.status ?? ""))) person.status = "";
    } else {
      person.status = `Ранен (${next} дн.)`;
    }
  }
  return { recovered };
},

_advanceResidentAges(holding, years = 1) {
  const count = Math.max(0, Math.floor(this._safeNumber(years, 0)));
  if (!count) return { aged: 0, changed: 0 };
  const attrs = ["strength", "agility", "wits", "empathy"];
  const school = this._schoolEducationContext(holding);
  let aged = 0;
  let changed = 0;
  let educated = 0;
  for (const person of holding?.people?.list ?? []) {
    if (!person || person.dead) continue;
    const oldAge = Math.max(0, Math.floor(this._safeNumber(person.age, 0)));
    const oldGroup = ageGroupFromAge(person.age, person.race, person.subrace);
    const newAge = Math.max(0, oldAge + count);
    if (school.active) educated += this._applySchoolEducation(holding, person, oldAge, newAge, school);
    person.age = newAge;
    const newGroup = ageGroupFromAge(person.age, person.race, person.subrace);
    person.ageGroup = newGroup;
    aged += 1;
    if (oldGroup !== newGroup) {
      changed += 1;
      if (!(oldGroup === "Ре" && newGroup === "Мл")) {
        const available = attrs.filter((key) => this._safeNumber(person?.attributes?.[key], 0) > 1);
        if (available.length) {
          const key = available[Math.floor(Math.random() * available.length)];
          person.attributes[key] = Math.max(1, this._safeNumber(person.attributes[key], 0) - 1);
          const names = { strength: "Сила", agility: "Ловкость", wits: "Разум", empathy: "Эмпатия" };
          person.notes = [String(person.notes ?? "").trim(), `Возрастная категория изменилась: ${oldGroup} → ${newGroup}; ${names[key]} -1.`].filter(Boolean).join("\n");
        }
      } else {
        person.notes = [String(person.notes ?? "").trim(), `Вырос: ${oldGroup} → ${newGroup}.`].filter(Boolean).join("\n");
      }
    }
  }
  return { aged, changed, educated };
},

_schoolEducationContext(holding) {
  const buildings = (holding?.buildings?.list ?? []).filter((building) => {
    const id = String(building?.id ?? building?.templateId ?? "").toLowerCase();
    const name = String(building?.name ?? "").toLowerCase();
    const status = String(building?.constructionStatus ?? "built");
    return status === "built" && (id === "school" || id.includes("school") || name.includes("школ"));
  });
  const peopleById = new Map((holding?.people?.list ?? []).map((person) => [String(person?.id ?? ""), person]));
  const teachers = [];
  for (const building of buildings) {
    for (const id of Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : []) {
      const person = peopleById.get(String(id));
      if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0) continue;
      const group = ageGroupFromAge(person.age, person.race, person.subrace);
      if (group === "Ре") continue;
      teachers.push(person);
    }
  }
  const teacherCount = teachers.length;
  return { active: teacherCount > 0, teacherCount, chance: Math.min(0.55, 0.20 + teacherCount * 0.07) };
},

_childEducationMilestones(person = {}) {
  const thresholds = ageThresholdsFor(raceKeyFromResident(person));
  const young = Math.max(1, Math.floor(this._safeNumber(thresholds?.young, 18)));
  return [
    { key: "child-third-1", age: Math.max(1, Math.floor(young / 3)), label: "первая треть детства" },
    { key: "child-third-2", age: Math.max(1, Math.floor((young * 2) / 3)), label: "вторая треть детства" },
    { key: "child-end", age: young, label: "выход из детства" }
  ];
},

_applySchoolEducation(holding, person = {}, oldAge = 0, newAge = 0, school = {}) {
  const oldGroup = ageGroupFromAge(oldAge, person.race, person.subrace);
  if (oldGroup !== "Ре") return 0;
  if (!Array.isArray(person.educationMilestones)) person.educationMilestones = [];
  const done = new Set(person.educationMilestones.map((value) => String(value)));
  let successes = 0;
  const attrLabels = { strength: "Сила", agility: "Ловкость", wits: "Разум", empathy: "Эмпатия" };
  for (const milestone of this._childEducationMilestones(person)) {
    if (done.has(milestone.key)) continue;
    if (!(oldAge < milestone.age && newAge >= milestone.age)) continue;
    person.educationMilestones.push(milestone.key);
    if (Math.random() >= school.chance) continue;
    if (!person.attributes || typeof person.attributes !== "object") person.attributes = {};
    const attr = ["strength", "agility", "wits", "empathy"][Math.floor(Math.random() * 4)];
    person.attributes[attr] = Math.min(6, this._safeNumber(person.attributes[attr], 0) + 1);
    const currentTraits = String(person.traitsText ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
    const currentLow = new Set(currentTraits.map((item) => item.toLowerCase()));
    const traitPool = (TRAIT_POOLS.soft ?? []).filter((name) => !currentLow.has(String(name).toLowerCase()));
    const trait = traitPool[Math.floor(Math.random() * traitPool.length)] ?? "Грамотный";
    if (trait && !currentLow.has(String(trait).toLowerCase())) currentTraits.push(trait);
    person.traitsText = currentTraits.join(", ");
    person.notes = [String(person.notes ?? "").trim(), `Школа: ${milestone.label}; ${attrLabels[attr]} +1; черта «${trait}».`].filter(Boolean).join("\n");
    successes += 1;
  }
  return successes;
},

_checkCalendariaEconomyAdvance(holding, qd = 0) {
  const snapshot = getCalendariaSnapshot();
  if (!snapshot.available) return { ok: true, snapshot, targetDateTime: null, targetTimestamp: null };
  const calendar = holding?.gm?.calendaria ?? {};
  const lastDateTime = calendar.lastDateTime && typeof calendar.lastDateTime === "object" ? calendar.lastDateTime : null;
  const lastTimestamp = Number(calendar.lastTimestamp);
  if (!lastDateTime || !Number.isFinite(lastTimestamp) || snapshot.timestamp === null || snapshot.timestamp === undefined) {
    return { ok: true, snapshot, targetDateTime: null, targetTimestamp: null };
  }
  const targetDateTime = addCalendariaQd(lastDateTime, qd);
  const targetTimestamp = timestampForCalendariaDate(targetDateTime);
  if (Number.isFinite(targetTimestamp) && Number.isFinite(Number(snapshot.timestamp)) && targetTimestamp > Number(snapshot.timestamp) + 0.0001) {
    return {
      ok: false,
      snapshot,
      targetDateTime,
      targetTimestamp,
      message: `Нельзя обновить владение дальше текущей даты Calendaria. Последнее обновление: ${formatCalendariaDateTime(lastDateTime)}; попытка: ${formatCalendariaDateTime(targetDateTime)}; сейчас: ${snapshot.text}.`
    };
  }
  return { ok: true, snapshot, targetDateTime, targetTimestamp };
},

_commitCalendariaEconomyAdvance(holding, gate = {}) {
  const snapshot = gate.snapshot ?? getCalendariaSnapshot();
  if (!snapshot.available) return;
  if (!holding.gm) holding.gm = {};
  if (!holding.gm.calendaria || typeof holding.gm.calendaria !== "object") holding.gm.calendaria = {};
  const previous = holding.gm.calendaria.lastDateTime && typeof holding.gm.calendaria.lastDateTime === "object" ? holding.gm.calendaria.lastDateTime : null;
  const dateTime = gate.targetDateTime ?? snapshot.dateTime;
  if (previous && dateTime && Number.isFinite(Number(previous.year)) && Number.isFinite(Number(dateTime.year)) && Number(dateTime.year) > Number(previous.year)) {
    this._advanceResidentAges(holding, Math.max(1, Math.floor(Number(dateTime.year) - Number(previous.year))));
  }
  const timestamp = Number.isFinite(Number(gate.targetTimestamp)) ? Number(gate.targetTimestamp) : snapshot.timestamp;
  holding.gm.calendaria.lastDateTime = dateTime ? (foundry?.utils?.deepClone?.(dateTime) ?? JSON.parse(JSON.stringify(dateTime))) : null;
  holding.gm.calendaria.lastTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
  holding.gm.calendaria.lastDateKey = dateTime ? [dateTime.year, dateTime.month, dateTime.day].map((value) => String(value ?? "")).join("-") : "";
  holding.gm.calendaria.lastDateText = dateTime ? formatCalendariaDateTime(dateTime) : "";
},

async _onCalendariaLastDateChange(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const value = String(event.currentTarget?.value ?? "").trim();
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    if (!holding) return;
    if (!holding.gm) holding.gm = {};
    if (!holding.gm.calendaria || typeof holding.gm.calendaria !== "object") holding.gm.calendaria = {};
    const snapshot = getCalendariaSnapshot();
    const parsed = parseCalendariaDateInput(value, snapshot.dateTime);
    if (!parsed && value) {
      holding.gm.calendaria.lastDateText = value;
      holding.gm.calendaria.lastDateTime = null;
      holding.gm.calendaria.lastTimestamp = null;
      holding.gm.calendaria.lastDateKey = value;
      ui.notifications.warn("Дата сохранена как текст. Для защиты от перегонки времени используй формат ГГГГ-ММ-ДД ЧЧ:ММ.");
    } else if (parsed) {
      const timestamp = timestampForCalendariaDate(parsed);
      holding.gm.calendaria.lastDateTime = parsed;
      holding.gm.calendaria.lastTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : null;
      holding.gm.calendaria.lastDateKey = [parsed.year, parsed.month, parsed.day].map((part) => String(part ?? "")).join("-");
      holding.gm.calendaria.lastDateText = formatCalendariaDateTime(parsed);
    } else {
      holding.gm.calendaria.lastDateText = "";
      holding.gm.calendaria.lastDateTime = null;
      holding.gm.calendaria.lastTimestamp = null;
      holding.gm.calendaria.lastDateKey = "";
    }
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to set Calendaria last update date", error);
    ui.notifications.error("Не удалось сохранить дату последнего обновления. Подробности в консоли.");
  }
},

async _onRunTenDayEconomy(event) {
  return this._onRunEconomyPeriod(event);
}
};
