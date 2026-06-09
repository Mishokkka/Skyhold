// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const ResidentEventDomain = {
async _onWorkAssignmentChange(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;
  const field = event.currentTarget;
  const path = field.dataset.workAssignmentField;
  if (!path) return;
  const value = String(field.value ?? "");
  const parts = path.match(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
  try {
    const data = SkyholdData.get();
    if (!parts) {
      foundry.utils.setProperty(data, path, value);
      await SkyholdData.set(data);
      return;
    }
    const holding = data.holdings[Number(parts[1])];
    const person = holding?.people?.list?.[Number(parts[2])];
    if (!holding || !person) return;
    this._clearPersonFromAssignments(holding, person.id);
    person.workAssignment = value;
    if (!value) this._setPersonFree?.(holding, person.id);
    else if (value === "soldier") {
      person.workAssignment = "soldier";
      person.role = "Солдат";
      this._applyPersonSalaryForAssignment?.(holding, person, null);
    }
    else if (value === "other") {
      person.role = String(person.role ?? "") || "Другое";
      this._applyPersonSalaryForAssignment?.(holding, person, null);
    }
    else if (value === "construction") this._assignPersonToCrew(holding, person.id, this._constructionCrews(holding)[0]?.id);
    else if (value.startsWith("construction:")) this._assignPersonToCrew(holding, person.id, value.split(":")[1]);
    else {
      const ok = this._assignPersonToBuilding(holding, person.id, value);
      if (!ok) {
        person.workAssignment = "";
        this._setPersonFree?.(holding, person.id);
        ui.notifications.warn("В выбранном здании нет свободного рабочего слота.");
      }
    }
    await SkyholdData.set(data);
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to update work assignment", error);
    ui.notifications.error("Не удалось назначить работу. Подробности в консоли.");
  }
},

_onTogglePersonDetails(event) {
  const target = event.target;
  if (target?.closest?.("button, input, textarea, select, a, .fbls-note-tip, .fbls-trait-badge")) return;

  const rowId = event.currentTarget?.dataset?.id;
  if (!rowId) return;

  this.expandedPersonId = this.expandedPersonId === rowId ? null : rowId;
  this.render({ force: true, focus: false });
},

_onResidentFilterChange(event) {
  const field = event.currentTarget;
  const key = field?.dataset?.residentFilter;
  if (!key) return;
  this.residentFilters[key] = field.value ?? "";
  this.render({ force: true, focus: false });
},

async _onTogglePersonDead(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!this._canManagePeople()) return;
  const id = String(event.currentTarget?.dataset?.id ?? "");
  const dead = String(event.currentTarget?.dataset?.dead ?? "true") !== "false";
  if (!id) return;
  try {
    const data = SkyholdData.get();
    const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
    const person = (holding?.people?.list ?? []).find((row) => String(row.id) === id);
    if (!person) return;
    person.dead = dead;
    person.status = dead ? "Погиб" : "";
    if (dead) person.injuredDays = 0;
    if (dead && !person.deathDate) person.deathDate = new Date().toISOString().slice(0, 10);
    if (!dead) person.deathDate = "";
    if (dead) {
      this._clearPersonFromAssignments?.(holding, person.id);
      person.home = "";
    }
    await SkyholdData.set(data);
    this.activePeopleTab = "living";
    this.activeSpecialTab = dead ? "cemetery" : "records";
    this.activeTab = dead ? "special" : "people";
    this.editingPersonId = null;
    this.expandedPersonId = null;
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to mark resident death state", error);
    ui.notifications.error("Не удалось изменить состояние жителя. Подробности в консоли.");
  }
},

async _onTraitSelectChange(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const field = event.currentTarget;
  const path = field.dataset.traitsField;
  if (!path) return;

  const selected = Array.from(field.selectedOptions ?? []).map((option) => option.value).filter(Boolean);

  try {
    await SkyholdData.update(path, selected.join(", "));
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to update resident traits", error);
    ui.notifications.error("Не удалось сохранить черты жителя. Подробности в консоли.");
  }
},

async _onTraitAddChange(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const field = event.currentTarget;
  const path = field.dataset.traitAddField;
  const trait = String(field.value ?? "").trim();
  if (!path || !trait) return;

  const editor = field.closest?.(".fbls-person-editor.v2");
  if (editor) {
    const hidden = editor.querySelector?.("[data-resident-traits-value]");
    const existing = this._parseTraits(hidden?.value ?? "");
    const lowered = new Set(existing.map((item) => item.toLowerCase()));
    if (!lowered.has(trait.toLowerCase())) existing.push(trait);
    if (hidden) hidden.value = existing.join(", ");
    field.value = "";
    this._refreshResidentTraitEditor(editor);
    return;
  }

  try {
    const data = SkyholdData.get();
    const existing = this._parseTraits(foundry.utils.getProperty(data, path));
    const lowered = new Set(existing.map((item) => item.toLowerCase()));
    if (!lowered.has(trait.toLowerCase())) existing.push(trait);
    await SkyholdData.update(path, existing.join(", "));
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to add resident trait", error);
    ui.notifications.error("Не удалось добавить черту жителя. Подробности в консоли.");
  }
},

async _onRemoveTrait(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const button = event.currentTarget;
  const trait = String(button.dataset.traitName ?? "").trim().toLowerCase();
  if (!trait) return;

  const editor = button.closest?.(".fbls-person-editor.v2");
  if (editor) {
    const hidden = editor.querySelector?.("[data-resident-traits-value]");
    const filtered = this._parseTraits(hidden?.value ?? "").filter((item) => item.toLowerCase() !== trait);
    if (hidden) hidden.value = filtered.join(", ");
    this._refreshResidentTraitEditor(editor);
    return;
  }

  const path = button.dataset.traitsField;
  if (!path) return;

  try {
    const data = SkyholdData.get();
    const filtered = this._parseTraits(foundry.utils.getProperty(data, path)).filter((item) => item.toLowerCase() !== trait);
    await SkyholdData.update(path, filtered.join(", "));
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to remove resident trait", error);
    ui.notifications.error("Не удалось убрать черту жителя. Подробности в консоли.");
  }
},

_refreshResidentTraitEditor(editor) {
  if (!editor) return;
  const hidden = editor.querySelector?.("[data-resident-traits-value]");
  const list = editor.querySelector?.("[data-resident-trait-list]");
  const select = editor.querySelector?.("[data-trait-add-field]");
  const traits = this._parseTraits(hidden?.value ?? "");
  const lower = new Set(traits.map((item) => item.toLowerCase()));

  if (list) {
    list.innerHTML = "";
    if (!traits.length) {
      const empty = document.createElement("span");
      empty.className = "fbls-muted-text";
      empty.textContent = "Черт нет.";
      list.appendChild(empty);
    } else {
      const badges = this._traitBadges?.(traits.join(", ")) ?? traits.map((name) => ({ name, description: "" }));
      const path = hidden?.dataset?.field ?? "";
      for (const badge of badges) {
        const chip = document.createElement("span");
        chip.className = "fbls-trait-badge editor-chip fbls-note-tip";
        if (badge.description) chip.dataset.fblsTooltip = badge.description;
        chip.append(document.createTextNode(badge.name));

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "fbls-chip-remove";
        remove.dataset.action = "remove-trait";
        remove.dataset.traitsField = path;
        remove.dataset.traitName = badge.name;
        remove.title = "Убрать черту";
        remove.textContent = "×";
        remove.addEventListener("click", (event) => this._onRemoveTrait(event));
        chip.appendChild(remove);
        list.appendChild(chip);
      }
    }
  }

  if (select) {
    for (const option of Array.from(select.options ?? [])) {
      if (!option.value) {
        option.disabled = false;
        continue;
      }
      const selected = lower.has(String(option.value).toLowerCase());
      option.disabled = selected;
      const cleanLabel = String(option.textContent ?? "").replace(/\s+✓$/, "");
      option.textContent = selected ? `${cleanLabel} ✓` : cleanLabel;
    }
    select.value = "";
  }
},

_residentTransferContext(holding, data) {
  const currentId = String(holding?.id ?? "");
  const residents = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const targets = (data?.holdings ?? []).filter((item) => String(item.id) !== currentId);
  return {
    residentOptions: [
      { value: "", label: "Выбери жителя", selected: true },
      ...residents.map((person) => ({ value: String(person.id), label: person.name || "Без имени", selected: false }))
    ],
    targetOptions: [
      { value: "", label: "Куда переслать", selected: true },
      ...targets.map((item) => ({ value: String(item.id), label: item.name || "Владение", selected: false }))
    ],
    hasTargets: targets.length > 0,
    hasResidents: residents.length > 0
  };
},

async _onTransferResident(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  const root = event.currentTarget?.closest?.(".fbls-transfer-card");
  const residentId = String(root?.querySelector("[data-transfer-resident]")?.value ?? "");
  const targetId = String(root?.querySelector("[data-transfer-target]")?.value ?? "");
  if (!residentId || !targetId) { ui.notifications.warn("Выбери жителя и целевое владение."); return; }
  const data = SkyholdData.get();
  const source = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  const target = data.holdings.find((item) => String(item.id) === targetId);
  if (!source || !target || source === target) return;
  const index = (source.people?.list ?? []).findIndex((person) => String(person.id) === residentId);
  if (index < 0) { ui.notifications.warn("Житель не найден."); return; }
  const [person] = source.people.list.splice(index, 1);
  this._clearPersonFromAssignments?.(source, person.id);
  if (!target.people) target.people = { notes: "", list: [] };
  if (!Array.isArray(target.people.list)) target.people.list = [];
  person.workAssignment = "";
  person.role = "Свободен";
  person.home = "";
  target.people.list.push(person);
  await SkyholdData.set(data);
  this.render({ force: true, focus: false });
  ui.notifications.info(`${person.name || "Житель"} переслан в ${target.name || "другое владение"}.`);
},

async _onAddRow(event) {
  event.preventDefault();
  const collection = event.currentTarget?.dataset?.collection;
  if (!game.user?.isGM && !(this._canEditBuildings() && String(collection ?? "").endsWith(".buildings.list"))) return;

  if (!collection) return;

  try {
    const row = this._emptyRowFor(collection);
    await SkyholdData.addRow(collection, row);
    if (collection.endsWith(".people.list")) this.editingPersonId = row.id;
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to add row", error);
    ui.notifications.error("Не удалось добавить запись. Подробности в консоли.");
  }
},

async _onDeleteRow(event) {
  event.preventDefault();
  const button = event.currentTarget;
  const collection = button.dataset.collection;
  if (!game.user?.isGM && !(this._canEditBuildings() && String(collection ?? "").endsWith(".buildings.list"))) return;
  const rowId = button.dataset.id;
  if (!collection || !rowId) return;

  const confirmed = await this._confirmAction("Удалить запись", "Удалить эту запись из владения?");
  if (!confirmed) return;

  try {
    await SkyholdData.deleteRow(collection, rowId);
    if (this.editingPersonId === rowId) this.editingPersonId = null;
    this.render({ force: true, focus: false });
  } catch (error) {
    console.error("FBL Skyhold | Failed to delete row", error);
    ui.notifications.error("Не удалось удалить запись. Подробности в консоли.");
  }
},

_onEditPerson(event) {
  event.preventDefault();
  if (!this._canManagePeople()) return;

  const rowId = event.currentTarget?.dataset?.id;
  if (!rowId) return;

  this.editingPersonId = this.editingPersonId === rowId ? null : rowId;
  this.expandedPersonId = null;
  this.render({ force: true, focus: false });
},

async _savePersonEditorDraft(event) {
  const editor = event?.currentTarget?.closest?.(".fbls-person-editor.v2") ?? this.element?.querySelector?.(".fbls-person-editor.v2");
  if (!editor || !this._canManagePeople?.()) return false;

  const data = SkyholdData.get();
  const regularFields = Array.from(editor.querySelectorAll("[data-field]")).filter((field) => !/\.salary(?:Modifier)?$/.test(String(field.dataset.field ?? "")));
  const salaryFields = Array.from(editor.querySelectorAll("[data-field]")).filter((field) => /\.salary(?:Modifier)?$/.test(String(field.dataset.field ?? "")));
  const workField = editor.querySelector("[data-work-assignment-field]");

  for (const field of regularFields) {
    const path = field.dataset.field;
    if (!path || !this._canPlayerWriteFieldPath(path)) continue;
    let value = fieldValue(field);
    if (field instanceof HTMLTextAreaElement && this._sanitizeTextBlock) value = this._sanitizeTextBlock(value);
    if (path.endsWith(".belief")) value = normalizeBelief(value);
    foundry.utils.setProperty(data, path, value);
  }

  if (workField) {
    const path = workField.dataset.workAssignmentField;
    const value = String(workField.value ?? "");
    if (path && this._canPlayerWriteFieldPath(path)) {
      const parts = path.match(/holdings\.(\d+)\.people\.list\.(\d+)\.workAssignment$/);
      if (parts) {
        const holding = data.holdings?.[Number(parts[1])];
        const person = holding?.people?.list?.[Number(parts[2])];
        if (holding && person) {
          this._clearPersonFromAssignments?.(holding, person.id);
          person.workAssignment = value;
          if (!value) this._setPersonFree?.(holding, person.id);
          else if (value === "soldier") {
            person.workAssignment = "soldier";
            person.role = /^\s*(солдат|сержант)\b/i.test(String(person.role ?? "")) ? person.role : "Солдат";
            this._applyPersonSalaryForAssignment?.(holding, person, null);
          } else if (value === "other") {
            person.role = String(person.role ?? "") || "Другое";
            this._applyPersonSalaryForAssignment?.(holding, person, null);
          } else if (value === "construction") this._assignPersonToCrew?.(holding, person.id, this._constructionCrews?.(holding)?.[0]?.id);
          else if (value.startsWith("construction:")) this._assignPersonToCrew?.(holding, person.id, value.split(":")[1]);
          else {
            const ok = this._assignPersonToBuilding?.(holding, person.id, value);
            if (!ok) {
              person.workAssignment = "";
              this._setPersonFree?.(holding, person.id);
              ui.notifications.warn("В выбранном здании нет свободного рабочего слота.");
            }
          }
        }
      } else foundry.utils.setProperty(data, path, value);
    }
  }

  for (const field of salaryFields) {
    const path = field.dataset.field;
    if (!path || !this._canPlayerWriteFieldPath(path)) continue;
    let value = fieldValue(field);
    foundry.utils.setProperty(data, path, value);
    const match = path.match(/^holdings\.(\d+)\.people\.list\.(\d+)\.salaryModifier$/);
    if (match && this._applyPersonSalaryForAssignment) {
      const holding = data.holdings?.[Number(match[1])];
      const person = holding?.people?.list?.[Number(match[2])];
      const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(person?.workAssignment));
      if (holding && person) this._applyPersonSalaryForAssignment(holding, person, building ?? null);
    }
  }

  await SkyholdData.set(data);
  return true;
},

async _onClosePersonEditor(event) {
  event.preventDefault();
  try {
    await this._savePersonEditorDraft(event);
  } catch (error) {
    console.error("FBL Skyhold | Failed to save resident draft", error);
    ui.notifications.error("Не удалось сохранить жителя. Подробности в консоли.");
    return;
  }
  this.editingPersonId = null;
  this.render({ force: true, focus: false });
},

async _onPersonEditorWorkAssignmentChange(event) {
  event.preventDefault();

  const field = event.currentTarget;
  const workSet = field?.closest?.(".work-set.compact-resident-work");
  const customRole = workSet?.querySelector?.(".person-custom-role");
  const isCustom = String(field?.value ?? "") === "other";
  workSet?.classList?.toggle?.("has-custom-work", isCustom);
  customRole?.classList?.toggle?.("is-hidden", !isCustom);

  try {
    await this._savePersonEditorDraft(event);
  } catch (error) {
    console.error("FBL Skyhold | Failed to update resident work assignment from editor", error);
    ui.notifications.error("Не удалось обновить работу жителя. Подробности в консоли.");
    return;
  }
  this.render({ force: true, focus: false });
},

_onGeneratorFieldChange(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const field = event.currentTarget;
  const key = field.dataset.generatorField;
  if (!key) return;

  let value = field.value;
  if (key === "quantity") {
    const parsed = Number(value);
    value = Number.isFinite(parsed) ? Math.max(1, Math.min(20, Math.floor(parsed))) : 3;
  }

  this.generatorConfig[key] = value;
  this.generatorPreview = [];
  this.activeGeneratedPersonIndex = null;
  this.render({ force: true, focus: false });
},

_onGenerateResidents(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;

  const data = SkyholdData.get();
  const holding = data.holdings.find((item) => item.id === this.activeHoldingId) ?? data.holdings[0];
  this.generatorPreview = generateResidents({
    ...this.generatorConfig,
    holding
  }).map((person) => ({ ...person, _selected: true }));
  this.activeGeneratedPersonIndex = null;

  this.activeTab = "gm";
  this.render({ force: true, focus: false });
},

_onGeneratedPersonFieldChange(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;
  const field = event.currentTarget;
  const index = Number(field?.dataset?.generatorPersonIndex);
  const key = String(field?.dataset?.generatorPersonField ?? "");
  if (!Number.isInteger(index) || index < 0 || !key || !this.generatorPreview?.[index]) return;
  let value = fieldValue(field);
  if (["age", "salary", "moraleBase", "moraleWork", "moraleHome", "moraleManual", "attributes.strength", "attributes.agility", "attributes.wits", "attributes.empathy"].includes(key)) {
    const parsed = Number(value);
    value = Number.isFinite(parsed) ? parsed : 0;
  }
  if (key === "_selected") value = Boolean(value);
  if (key.includes(".")) foundry.utils.setProperty(this.generatorPreview[index], key, value);
  else this.generatorPreview[index][key] = value;
  if (key === "belief") this.generatorPreview[index].belief = normalizeBelief(value);
  this.render({ force: true, focus: false });
},

async _onAcceptGeneratedResidents(event) {
  event.preventDefault();
  if (!game.user?.isGM || !this.generatorPreview?.length) return;

  try {
    const selected = this.generatorPreview.filter((person) => person?._selected !== false);
    if (!selected.length) {
      ui.notifications.warn("Не выбрано ни одного сгенерированного жителя.");
      return;
    }
    const data = SkyholdData.get();
    const holdingIndex = data.holdings.findIndex((item) => item.id === this.activeHoldingId);
    if (holdingIndex < 0) return;
    const list = data.holdings[holdingIndex].people?.list;
    if (!Array.isArray(list)) data.holdings[holdingIndex].people.list = [];
    const copyPerson = (person) => {
      const copy = foundry.utils.deepClone ? foundry.utils.deepClone(person) : JSON.parse(JSON.stringify(person));
      delete copy._selected;
      return copy;
    };
    data.holdings[holdingIndex].people.list.push(...selected.map((person) => copyPerson(person)));
    const added = selected.length;
    this.generatorPreview = [];
    this.activeGeneratedPersonIndex = null;
    await SkyholdData.set(data);
    this.activeTab = "people";
    this.render({ force: true, focus: false });
    ui.notifications.info(`Добавлено жителей: ${added}.`);
  } catch (error) {
    console.error("FBL Skyhold | Failed to accept generated residents", error);
    ui.notifications.error("Не удалось добавить сгенерированных жителей. Подробности в консоли.");
  }
},

_onClearGeneratedResidents(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;
  this.generatorPreview = [];
  this.activeGeneratedPersonIndex = null;
  this.render({ force: true, focus: false });
},

_onToggleGeneratedPersonEditor(event) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.target;
  if (target?.closest?.("input, textarea, select")) return;
  const index = Number(event.currentTarget?.dataset?.generatorPersonIndex);
  if (!Number.isInteger(index) || index < 0) return;
  this.activeGeneratedPersonIndex = this.activeGeneratedPersonIndex === index ? null : index;
  this.render({ force: true, focus: false });
},

_actorAttribute(actor, key) {
  const paths = [
    `system.attributes.${key}.max`,
    `system.attributes.${key}.max.value`,
    `system.attributes.${key}.value`,
    `system.attributes.${key}.value.value`,
    `system.attribute.${key}.max`,
    `system.attribute.${key}.max.value`,
    `system.attribute.${key}.value`,
    `system.attribute.${key}.value.value`,
    `system.${key}.max`,
    `system.${key}.max.value`,
    `system.${key}.value`,
    `system.${key}.value.value`
  ];
  const aliases = { strength: ["str"], agility: ["agi"], wits: ["wit"], empathy: ["emp"] };
  for (const alias of aliases[key] ?? []) {
    paths.push(
      `system.attributes.${alias}.max`, `system.attributes.${alias}.max.value`, `system.attributes.${alias}.value`, `system.attributes.${alias}.value.value`,
      `system.attribute.${alias}.max`, `system.attribute.${alias}.max.value`, `system.attribute.${alias}.value`, `system.attribute.${alias}.value.value`,
      `system.${alias}.max`, `system.${alias}.max.value`, `system.${alias}.value`, `system.${alias}.value.value`
    );
  }
  for (const path of paths) {
    const value = foundry.utils.getProperty(actor, path);
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return null;
},

_residentFromActor(actor) {
  const attrs = {
    strength: this._actorAttribute(actor, "strength"),
    agility: this._actorAttribute(actor, "agility"),
    wits: this._actorAttribute(actor, "wits"),
    empathy: this._actorAttribute(actor, "empathy")
  };
  const missingAllStats = Object.values(attrs).every((value) => !Number.isFinite(Number(value)) || Number(value) <= 0);
  if (missingAllStats) {
    const generated = [3, 3, 3, 3];
    const up = Math.floor(Math.random() * generated.length);
    let down = Math.floor(Math.random() * generated.length);
    if (down === up) down = (down + 1) % generated.length;
    generated[up] += 1;
    generated[down] = Math.max(2, generated[down] - 1);
    attrs.strength = generated[0]; attrs.agility = generated[1]; attrs.wits = generated[2]; attrs.empathy = generated[3];
  }
  for (const key of Object.keys(attrs)) if (!Number.isFinite(Number(attrs[key])) || Number(attrs[key]) <= 0) attrs[key] = 3;
  const race = foundry.utils.getProperty(actor, "system.race") || foundry.utils.getProperty(actor, "system.details.race") || "Человек";
  const kin = foundry.utils.getProperty(actor, "system.kin") || foundry.utils.getProperty(actor, "system.details.kin") || "";
  const age = Number(foundry.utils.getProperty(actor, "system.age") ?? foundry.utils.getProperty(actor, "system.details.age"));
  return {
    id: foundry.utils.randomID?.(12) ?? `person-${Date.now()}`,
    name: String(actor?.name ?? "Новый житель"),
    role: "Свободен",
    skill: "",
    sex: "",
    age: Number.isFinite(age) && age > 0 ? Math.floor(age) : 30,
    culture: "",
    belief: "",
    background: "",
    race: String(race || "Человек"),
    subrace: String(kin || ""),
    salary: 0,
    moraleBase: -1,
    moraleWork: 0,
    moraleHome: 0,
    moraleManual: 0,
    moraleDelta: -1,
    home: "",
    attributes: attrs,
    traitsText: "",
    appearance: "",
    status: "",
    notes: `Создан из Actor ${actor?.name ?? ""}.`,
    actorUuid: actor?.uuid ?? ""
  };
},

async _onResidentActorDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!game.user?.isGM) return;
  event.currentTarget?.classList?.remove?.("dragover");
  let dropData = null;
  try { dropData = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}"); } catch (_error) {}
  const uuid = dropData?.uuid || dropData?.actorUuid || dropData?.documentUuid;
  let actor = null;
  try {
    if (uuid && globalThis.fromUuid) actor = await globalThis.fromUuid(uuid);
    if (!actor && globalThis.Actor?.implementation?.fromDropData) actor = await globalThis.Actor.implementation.fromDropData(dropData);
  } catch (error) {
    console.warn("FBL Skyhold | Failed to resolve dropped actor", dropData, error);
  }
  const documentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (!actor || documentName !== "Actor") { ui.notifications.warn("Перетащи сюда Actor Foundry."); return; }
  const data = SkyholdData.get();
  const holding = data.holdings.find((entry) => entry.id === this.activeHoldingId) ?? data.holdings[0];
  if (!holding) return;
  if (!holding.people) holding.people = { notes: "", list: [] };
  if (!Array.isArray(holding.people.list)) holding.people.list = [];
  const person = this._residentFromActor(actor);
  holding.people.list.push(person);
  await SkyholdData.set(data);
  this.activeTab = "people";
  this.editingPersonId = person.id;
  this.render({ force: true, focus: false });
  ui.notifications.info(`${person.name} добавлен как житель.`);
}
};
