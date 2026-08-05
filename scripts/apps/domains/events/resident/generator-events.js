import { SkyholdData } from "../../../../data/store.js";
import { makeId } from "../../../../data/utils.js";
import { generateResidents } from "../../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../../generators/resident-rules.js";
import { fieldValue } from "../../../../core/helpers.js";
import { foundryActorClass, resolveFoundryUuid } from "../../../../integrations/foundry-runtime.js";

export const ResidentGeneratorEventDomain = {
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
  this.requestRender();
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
  this.requestRender();
},

_onGeneratedPersonFieldChange(event) {
  event.preventDefault();
  if (!game.user?.isGM) return;
  const field = event.currentTarget;
  const index = Number(field?.dataset?.generatorPersonIndex);
  const key = String(field?.dataset?.generatorPersonField ?? "");
  if (!Number.isInteger(index) || index < 0 || !key || !this.generatorPreview?.[index]) return;
  let value = fieldValue(field);
  if (["age", "salary", "boardFoodDaily", "shareRate", "moraleBase", "moraleWork", "moraleHome", "moraleManual", "attributes.strength", "attributes.agility", "attributes.wits", "attributes.empathy"].includes(key)) {
    const parsed = Number(value);
    value = Number.isFinite(parsed) ? parsed : 0;
  }
  if (key === "_selected") value = Boolean(value);
  if (key.includes(".")) foundry.utils.setProperty(this.generatorPreview[index], key, value);
  else this.generatorPreview[index][key] = value;
  if (key === "belief") this.generatorPreview[index].belief = normalizeBelief(value);
  this.requestRender();
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
    const copyPerson = (person) => {
      const copy = foundry.utils.deepClone ? foundry.utils.deepClone(person) : JSON.parse(JSON.stringify(person));
      delete copy._selected;
      return copy;
    };
    const people = selected.map((person) => copyPerson(person));
    const added = selected.length;
    const accepted = await this._updateActiveHolding((holding) => {
      if (!holding.people) holding.people = { notes: "", list: [] };
      if (!Array.isArray(holding.people.list)) holding.people.list = [];
      holding.people.list.push(...people);
      return true;
    }, { reason: "resident:accept-generated" });
    if (!accepted) return;
    this.generatorPreview = [];
    this.activeGeneratedPersonIndex = null;
    this.activeTab = "people";
    this.requestRender();
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
  this.requestRender();
},

_onToggleGeneratedPersonEditor(event) {
  event.preventDefault();
  event.stopPropagation();
  const target = event.target;
  if (target?.closest?.("input, textarea, select")) return;
  const index = Number(event.currentTarget?.dataset?.generatorPersonIndex);
  if (!Number.isInteger(index) || index < 0) return;
  this.activeGeneratedPersonIndex = this.activeGeneratedPersonIndex === index ? null : index;
  this.requestRender();
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

_residentFromActorGenerated(actor, holding = null) {
  const generated = generateResidents({
    quantity: 1,
    culture: "current",
    arrival: "settlers",
    ageMode: "normal",
    traitMode: "normal",
    holding
  })[0] ?? {};
  const valueToText = (value) => {
    if (Array.isArray(value)) return value.map((item) => valueToText(item)).filter(Boolean).join(", ");
    if (value && typeof value === "object") {
      const candidate = value.name ?? value.label ?? value.value ?? value.id ?? "";
      return typeof candidate === "object" ? "" : String(candidate ?? "").trim();
    }
    return String(value ?? "").trim();
  };
  const actorString = (...paths) => {
    for (const path of paths) {
      const value = valueToText(foundry.utils.getProperty(actor, path));
      if (value) return value;
    }
    return "";
  };
  const actorNumber = (...paths) => {
    for (const path of paths) {
      const value = Number(foundry.utils.getProperty(actor, path));
      if (Number.isFinite(value) && value > 0) return Math.floor(value);
    }
    return null;
  };
  const generatedAttrs = generated.attributes ?? {};
  const attrs = {
    strength: generatedAttrs.strength,
    agility: generatedAttrs.agility,
    wits: generatedAttrs.wits,
    empathy: generatedAttrs.empathy
  };
  for (const key of Object.keys(attrs)) {
    const actorValue = this._actorAttribute(actor, key);
    if (Number.isFinite(Number(actorValue)) && Number(actorValue) > 0) attrs[key] = Math.floor(Number(actorValue));
  }

  const age = actorNumber("system.age", "system.details.age");
  const race = actorString("system.race", "system.details.race") || generated.race || "Человек";
  const subrace = actorString("system.kin", "system.details.kin", "system.subrace", "system.details.subrace") || generated.subrace || "";
  const traitsText = actorString("system.traitsText", "system.traits", "system.details.traits", "system.bio.traits");
  const actorNote = `Создан из Actor ${actor?.name ?? ""}.`;
  const notes = [generated.notes, actorNote].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");

  return {
    ...generated,
    id: makeId("person", 12),
    name: String(actor?.name ?? generated.name ?? "Новый житель"),
    sex: actorString("system.sex", "system.gender", "system.details.sex", "system.details.gender") || generated.sex || "",
    age: age ?? generated.age ?? 30,
    ageGroup: age ? ageGroupFromAge(age, race, subrace) : generated.ageGroup,
    culture: actorString("system.culture", "system.details.culture") || generated.culture || "",
    belief: normalizeBelief(actorString("system.belief", "system.faith", "system.details.belief", "system.details.faith") || generated.belief || ""),
    background: actorString("system.background", "system.details.background", "system.profession", "system.details.profession") || generated.background || "",
    race,
    subrace,
    attributes: attrs,
    traitsText: traitsText || generated.traitsText || "",
    appearance: actorString("system.appearance", "system.description.appearance", "system.details.appearance") || generated.appearance || "",
    notes,
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
    if (uuid) actor = await resolveFoundryUuid(uuid);
    if (!actor) actor = await foundryActorClass().implementation.fromDropData(dropData);
  } catch (error) {
    console.warn("FBL Skyhold | Failed to resolve dropped actor", dropData, error);
  }
  const documentName = actor?.documentName ?? actor?.constructor?.documentName;
  if (!actor || documentName !== "Actor") { ui.notifications.warn("Перетащи сюда Actor Foundry."); return; }
  const person = await this._updateActiveHolding((holding) => {
    if (!holding.people) holding.people = { notes: "", list: [] };
    if (!Array.isArray(holding.people.list)) holding.people.list = [];
    const created = this._residentFromActorGenerated(actor, holding);
    holding.people.list.push(created);
    return created;
  }, { reason: "resident:actor-drop" });
  if (!person) return;
  this.activeTab = "people";
  this.editingPersonId = person.id;
  this.requestRender();
  ui.notifications.info(`${person.name} добавлен как житель.`);
}
};
