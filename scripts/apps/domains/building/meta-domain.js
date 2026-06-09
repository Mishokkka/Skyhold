// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { ATTRIBUTE_META } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { normalizeResourceId, resourceIcon, resourceLabel, resourceOptions } from "../../../core/resources.js";
import { inferBuildingSpecialKind } from "../../../core/building-specials.js";
import { RELIGION_OPTIONS } from "./building-constants.js";

export const BuildingMetaDomain = {
_religionOptions(current = "") {
  const selected = String(current ?? "");
  const selectedLower = selected.toLowerCase();
  return RELIGION_OPTIONS.map(([value, label]) => ({
    value,
    label,
    selected: value === selected || label.toLowerCase() === selectedLower
  }));
},

_religionLabel(current = "", custom = "") {
  const selected = String(current ?? "").trim();
  const customText = String(custom ?? "").trim();
  if (!selected) return "—";
  if (selected === "other") return customText || "Другое";
  const item = RELIGION_OPTIONS.find(([value, label]) => value === selected || label.toLowerCase() === selected.toLowerCase());
  return item?.[1] ?? selected;
},

_gmSettlementModifiers(holding) {
  const source = holding?.gm?.modifiers && typeof holding.gm.modifiers === "object" ? holding.gm.modifiers : {};
  const value = (key) => this._safeNumber(source?.[key], 0);
  return {
    food: value("food"),
    technology: value("technology"),
    culture: value("culture"),
    war: value("war"),
    defense: value("defense"),
    reputation: value("reputation"),
    morale: value("morale")
  };
},

_gmEfficiencyModifiers(holding) {
  const source = holding?.gm?.efficiencyModifiers && typeof holding.gm.efficiencyModifiers === "object" ? holding.gm.efficiencyModifiers : {};
  return {
    all: this._safeNumber(source?.all, 0),
    production: this._safeNumber(source?.production, 0),
    constructionCrew: this._safeNumber(source?.constructionCrew, 0)
  };
},

_moraleProductionEfficiencyModifier(holding) {
  const state = this._moraleState(this._calculateMorale(holding));
  if (state.label === "Бунты" || state.label === "Недовольство") return { value: -0.5, reason: `${state.label}: производство -0.5` };
  if (state.label === "Апатия") return { value: -0.2, reason: "Апатия: производство -0.2" };
  if (state.label === "Надежда" || state.label === "Дом") return { value: 0.2, reason: `${state.label}: производство +0.2` };
  return { value: 0, reason: "" };
},

_buildingEfficiencyModifier(holding, building) {
  const gm = this._gmEfficiencyModifiers(holding);
  let value = gm.all;
  const reasons = [];
  if (gm.all) reasons.push(`ГМ все здания ${gm.all > 0 ? "+" : ""}${gm.all}`);
  if (this._buildingFunctions(building).production) {
    if (gm.production) { value += gm.production; reasons.push(`ГМ производство ${gm.production > 0 ? "+" : ""}${gm.production}`); }
    const morale = this._moraleProductionEfficiencyModifier(holding);
    if (morale.value) { value += morale.value; reasons.push(morale.reason); }
  }
  return { value, reasons };
},

_buildingFunctions(building) {
  const specialKind = inferBuildingSpecialKind(building);
  if (specialKind === "medical") return { production: false, income: false, defense: false, housing: false, storage: false, culture: false };
  const functions = building?.functions && typeof building.functions === "object" ? building.functions : {};
  const hasExplicit = (key) => Object.prototype.hasOwnProperty.call(functions, key);
  const explicit = (key, fallback) => hasExplicit(key) ? Boolean(functions[key]) : Boolean(fallback);
  const religious = Boolean(building?.religion?.religious) || Boolean(building?.religious);
  const text = [building?.type, building?.name, building?.effect, building?.productionResource, building?.production, building?.notes, building?.religion?.faith, building?.religion?.customFaith, building?.religion?.notes]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");
  const hasProduction = Array.isArray(building?.productionLines) && building.productionLines.length > 0;
  return {
    production: explicit("production", hasProduction || String(building?.productionResource ?? "").trim() || /производ|кузн|ферм|сад|шахт|рудник|лесоповал|пастбищ|мастерск/.test(text)),
    income: explicit("income", this._isMoneyResource(`${building?.productionResource ?? ""} ${building?.production ?? ""}`) || this._safeNumber(building?.income?.base, 0) || this._safeNumber(building?.income?.perWorker, 0)),
    defense: explicit("defense", this._safeNumber(building?.defense?.base, 0) || this._safeNumber(building?.defense?.perStep, 0) || /стен|башн|гарнизон|оборон|форт|дозор|арсенал|воен|казарм/.test(text)),
    housing: explicit("housing", /дом|жиль|казарм|барак|палаточ|общежит|кают/.test(text)),
    storage: explicit("storage", /склад|хранил|амбар|кладов/.test(text)),
    culture: explicit("culture", religious || /храм|скриптор|школ|театр|площад|кладбищ|рынок|культур|святилищ|церк|религ|культ/.test(text))
  };
},

_functionOptions(building, buildingIndex, holdingIndexArg = null, basePathArg = "") {
  const functions = this._buildingFunctions(building);
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndexForBuilding(building);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  const base = `${recordPath}.functions`;
  const defs = [
    ["production", "Производство", "fa-solid fa-industry", "Открывает блок производственных линий: какие ресурсы здание создает, сколько дает база и сколько добавляет эффективность работников."],
    ["income", "Доход", "fa-solid fa-coins", "Открывает блок доходности. Это деньги за десятник, которые попадут в бухгалтерию."],
    ["defense", "Оборона", "fa-solid fa-shield-halved", "Открывает блок реальной Защищенности. Это не развитие Войны, а кубы против угроз."],
    ["housing", "Жилье", "fa-solid fa-house", "Открывает жилой блок: места проживания, комфорт и заполненность жильцами."],
    ["storage", "Склад", "fa-solid fa-box-archive", "Помечает здание как складское помещение. Построенное складское здание появляется в списке мест хранения и может принимать продукцию."],
    ["culture", "Культура/Религия", "fa-solid fa-music", "Помечает культурное или религиозное влияние: довольство, вера, репутация, события."]
  ];
  return defs.map(([key, label, icon, tooltip]) => ({ key, label, icon, tooltip, checked: Boolean(functions[key]), path: `${base}.${key}` }));
},

_expenseModeOptions(selected = "cycle") {
  const value = String(selected ?? "cycle");
  return [
    { value: "cycle", label: "За цикл", selected: value === "cycle" },
    { value: "unit", label: "За единицу выхода", selected: value === "unit" }
  ];
},

_autoCollectOptions(selected = "none") {
  const value = String(selected ?? "none");
  return [
    { value: "none", label: "Не собирать", selected: value === "none" },
    { value: "building", label: "Работником этого здания", selected: value === "building" },
    { value: "worker", label: "Работником потребителя", selected: value === "worker" }
  ];
},

_periodName(value = "day") {
  const text = String(value ?? "day");
  if (text === "qd") return "QD";
  if (text === "tenday") return "десятник";
  return "день";
},

_sourceName(value = "workers") {
  const text = String(value ?? "workers");
  if (text === "time") return "Время";
  if (text === "content") return "Содержимое";
  return "Рабочие";
},

_buildingCategoryOptions() {
  return [
    { id: "all", label: "Все", icon: "fa-solid fa-layer-group" },
    { id: "housing", label: "Жилые", icon: "fa-solid fa-house" },
    { id: "storage", label: "Складские", icon: "fa-solid fa-box-archive" },
    { id: "production", label: "Производство", icon: "fa-solid fa-industry" },
    { id: "infrastructure", label: "Инфраструктура", icon: "fa-solid fa-road" },
    { id: "defense", label: "Военные", icon: "fa-solid fa-shield-halved" },
    { id: "culture", label: "Культурные", icon: "fa-solid fa-music" },
    { id: "special", label: "Особые", icon: "fa-solid fa-star" }
  ];
},

_buildingCategoryLabel(category) {
  return this._buildingCategoryOptions().find((item) => item.id === category)?.label ?? "Особые";
},

_buildingCategory(building) {
  const type = String(building?.type ?? "").trim().toLowerCase();
  for (const item of this._buildingCategoryOptions()) {
    if (item.id !== "all" && type === item.label.toLowerCase()) return item.id;
    if (item.id !== "all" && type === item.id.toLowerCase()) return item.id;
  }

  const text = [building?.name, building?.type, building?.effect, building?.production, building?.notes]
    .map((value) => String(value ?? "").toLowerCase())
    .join(" ");

  if (/(дом|жиль|жил|палаточ|лагер|казарм|барак|общежит|хижин|комнат|кают|таверн|постоял)/i.test(text)) return "housing";
  const functions = this._buildingFunctions(building);
  if (functions.storage || /(склад|хранил|амбар|погреб|кладов|схрон)/i.test(text)) return "storage";
  if (/(лесоповал|каменолом|рудник|шахт|пастбищ|сад|ферм|поле|охот|рыб|колодец|водосбор|кузн|мастерск|производ|добыч)/i.test(text)) return "production";
  if (/(пирс|док|маяк|дорог|мост|центр|управлен|кадров|голубят|связь|шпиль|порт|верфь|механизм|навигац)/i.test(text)) return "infrastructure";
  if (/(стен|башн|дозор|страж|гарнизон|арсенал|укреп|форт|пушк|оруж|оборон|воен|казарм)/i.test(text)) return "defense";
  if (/(храм|святилищ|скриптор|школ|библиот|театр|рынок|площад|культур|кладбищ|музей|сад)/i.test(text)) return "culture";
  return "special";
},

_devLabel(key = "") {
  const value = String(key ?? "");
  if (value === "food") return "Еда";
  if (value === "technology") return "Технология";
  if (value === "culture") return "Культура";
  if (value === "war") return "Война";
  return "—";
},

_devObject(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    food: this._safeNumber(source.food, 0),
    technology: this._safeNumber(source.technology, 0),
    culture: this._safeNumber(source.culture, 0),
    war: this._safeNumber(source.war, 0)
  };
},

_workMorale(person, holding = null) {
  const selected = String(person?.workAssignment ?? "");
  if (!selected || selected === "other" || selected === "construction" || selected.startsWith("construction:")) return { value: 0, reason: "" };
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === selected || String(item.name) === selected);
  if (!building) return { value: 0, reason: "" };
  const raw = this._safeNumber(building.workerMoraleDelta, 0);
  const overtime = this._buildingHasOvertimeProduction(building);
  const value = overtime && raw < 0 ? raw * 2 : raw;
  const note = overtime && raw < 0 ? `, переработка удваивает ${raw}` : "";
  return { value, reason: value ? `${building.name || "здание"}: ${value > 0 ? "+" : ""}${value}${note}` : "" };
}
};
