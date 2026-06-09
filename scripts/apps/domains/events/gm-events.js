// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const GmEventDomain = {
async _onAddDefenseSquad(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding) return;
  if (!holding.gm) holding.gm = {};
  if (!holding.gm.defense) holding.gm.defense = {};
  if (!Array.isArray(holding.gm.defense.squads)) holding.gm.defense.squads = [];
  const number = holding.gm.defense.squads.length + 1;
  holding.gm.defense.squads.push({ id: foundry.utils.randomID?.(10) ?? `squad-${Date.now()}`, name: `${number}-й отряд`, type: "line", sergeantId: "", equipped: false, memberIds: ["", "", "", ""], notes: "" });
  await SkyholdData.set(data);
  this.activeTab = "defense";
  this.render({ force: true, focus: false });
},

async _onDeleteDefenseSquad(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const id = String(event.currentTarget?.dataset?.squadId ?? "");
  if (!id) return;
  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding?.gm?.defense?.squads) return;
  holding.gm.defense.squads = holding.gm.defense.squads.filter((row) => String(row.id) !== id);
  this._applyDefenseSalaries?.(holding);
  await SkyholdData.set(data);
  this.activeTab = "defense";
  this.render({ force: true, focus: false });
},

async _onFillDefenseSquadBest(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManageDefense?.()) return;
  const squadId = String(event.currentTarget?.dataset?.squadId ?? "");
  if (!squadId) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const squads = holding?.gm?.defense?.squads;
  const squad = Array.isArray(squads) ? squads.find((item) => String(item.id) === squadId) : null;
  if (!holding || !squad) return;

  const squadType = String(squad.type ?? "line") === "militia" ? "line" : String(squad.type ?? "line");
  const commanderId = String(holding?.gm?.defense?.commanderId ?? "");
  const otherSquadIds = new Set();
  for (const other of squads) {
    if (String(other.id) === squadId) continue;
    if (other?.sergeantId) otherSquadIds.add(String(other.sergeantId));
    for (const id of (Array.isArray(other?.memberIds) ? other.memberIds : []).slice(0, 4)) if (id) otherSquadIds.add(String(id));
  }

  const candidates = (holding?.people?.list ?? [])
    .filter((person) => person && !person.dead && !this._isResidentInjured?.(person))
    .filter((person) => !this._isChildResident?.(person))
    .filter((person) => this._isSuitableForSquadType?.(person, squadType))
    .filter((person) => String(person.id) !== commanderId)
    .filter((person) => !otherSquadIds.has(String(person.id)))
    .map((person) => {
      const efficiency = Number(this._soldierEfficiency?.(person, squadType) ?? 0);
      const sergeant = this._isSergeantCandidate?.(person) ? 0.35 : 0;
      const military = this._isMilitaryBackgroundResident?.(person) ? 0.35 : 0;
      const soldier = this._isSoldierResident?.(person) ? 0.25 : 0;
      const free = !String(person.workAssignment ?? "").trim() ? 0.05 : 0;
      return { person, score: (Number.isFinite(efficiency) ? efficiency : 0) + sergeant + military + soldier + free };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const sergeantCandidate = candidates.find((row) => this._isSergeantCandidate?.(row.person));
  const first = sergeantCandidate ?? candidates[0];
  if (first) selected.push(first.person);
  for (const row of candidates) {
    if (selected.length >= 5) break;
    if (selected.some((person) => String(person.id) === String(row.person.id))) continue;
    selected.push(row.person);
  }

  if (!selected.length) {
    ui.notifications.warn("Нет подходящих жителей для этого типа отряда.");
    return;
  }

  for (const person of selected) {
    this._clearPersonFromAssignments?.(holding, person.id);
    person.workAssignment = "soldier";
    if (!/^\s*(солдат|сержант)\b/i.test(String(person.role ?? ""))) person.role = "Солдат";
  }
  squad.equipped = true;
  squad.sergeantId = String(selected[0]?.id ?? "");
  squad.memberIds = selected.slice(1, 5).map((person) => String(person.id));
  while (squad.memberIds.length < 4) squad.memberIds.push("");
  this._sanitizeDefenseAssignments?.(holding);
  this._applyDefenseSalaries?.(holding);

  await SkyholdData.set(data);
  this.activeTab = "defense";
  this.render({ force: true, focus: false });
},

async _onGmRoll(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const holdingIndex = data.holdings.findIndex((item) => item.id === holding?.id);
  if (!holding || holdingIndex < 0) return;

  const kind = event.currentTarget?.dataset?.rollKind ?? "event";
  const table = GM_ROLLS[kind] ?? GM_ROLLS.event;
  const result = rollD66();
  const entry = gmRollEntry(table, result);

  data.holdings[holdingIndex].gm.lastRoll = {
    kind,
    title: table.title,
    result,
    entry,
    createdAt: new Date().toISOString()
  };
  await SkyholdData.set(data);

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
    content: `
      <div class="fbls-chat-card">
        <h3>${escapeHtml(table.title)}</h3>
        <p><strong>${escapeHtml(holding.name)}.</strong></p>
        <p><strong>d66:</strong> ${result}</p>
        <p>${escapeHtml(entry)}</p>
      </div>
    `
  });
  this.render({ force: true, focus: false });
},

async _onImportLaputa(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const confirmed = await this._confirmAction("Импорт Лапуты", "Импортировать данные Лапуты из встроенного снимка Лапута.xlsx? Текущие жители, здания, особое и хранилище Лапуты будут заменены. ID сцены, видимость и старые ГМ-заметки будут сохранены.");
  if (!confirmed) return;

  try {
    await SkyholdData.importLaputa();
    this.activeHoldingId = "laputa";
    this.activeTab = "overview";
    this.editingPersonId = null;
    this.render({ force: true, focus: false });
    ui.notifications.info("Лапута импортирована из встроенных данных.");
  } catch (error) {
    console.error("FBL Skyhold | Failed to import Laputa", error);
    ui.notifications.error("Не удалось импортировать Лапуту. Подробности в консоли.");
  }
},

async _onResetData(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const confirmed = await this._confirmAction("Сброс данных", "Сбросить все данные всех владений к стартовым значениям? Это нельзя отменить.");
  if (!confirmed) return;

  await SkyholdData.reset();
  this.activeHoldingId = null;
  this.activeTab = "overview";
  this.editingPersonId = null;
  this.render({ force: true, focus: false });
}
};
