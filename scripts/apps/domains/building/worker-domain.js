// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { ATTRIBUTE_META } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { normalizeResourceId, resourceIcon, resourceLabel, resourceOptions } from "../../../core/resources.js";

export const BuildingWorkerDomain = {
_workerTypeSelectOptions(current = "") {
  const selected = splitList(current);
  const selectedSet = new Set(selected.map((item) => item.toLowerCase()));
  return WORKER_TYPE_OPTIONS.map((name) => ({ name, selected: selectedSet.has(name.toLowerCase()) }));
},

_workerPrimaryAttributeOptions(current = "") {
  const selected = String(current ?? "");
  const items = [
    ["", "—"],
    ["strength", "Сила"],
    ["agility", "Ловкость"],
    ["wits", "Разум"],
    ["empathy", "Эмпатия"]
  ];
  return items.map(([value, label]) => ({ value, label, selected: value === selected }));
},

_workerBroadCriterionForAttribute(key = "") {
  const map = { strength: "Все с СИЛ", agility: "Все с ЛОВ", wits: "Все с РАЗ", empathy: "Все с ЭМП" };
  return map[String(key ?? "")] ?? "";
},

_effectiveWorkerCriteria(building = {}) {
  const criteria = splitList(building?.suitableWorkerTypes);
  const primaryCriterion = this._workerBroadCriterionForAttribute(building?.workerPrimaryAttribute);
  if (primaryCriterion && !criteria.some((item) => item.toLowerCase() === primaryCriterion.toLowerCase())) criteria.unshift(primaryCriterion);
  return criteria;
},

_workerTypeAttributeKeys(typeName = "") {
  const raw = String(typeName ?? "").trim();
  const broad = {
    "все с сил": ["strength"],
    "все с лов": ["agility"],
    "все с раз": ["wits"],
    "все с эмп": ["empathy"]
  };
  const low = raw.toLowerCase();
  if (broad[low]) return broad[low];
  const exact = {
    "Разнорабочий": [],
    "Силач": ["strength"],
    "Ловкач": ["agility"],
    "Умелец": ["wits"],
    "Переговорщик": ["empathy"],
    "Строитель": ["strength", "agility"],
    "Механик": ["strength", "wits"],
    "Бригадир": ["strength", "empathy"],
    "Ремесленник": ["agility", "wits"],
    "Посыльный": ["agility", "empathy"],
    "Управленец": ["wits", "empathy"],
    "Мастеровой": ["strength", "agility", "wits"],
    "Агент": ["agility", "wits", "empathy"],
    "Старшина": ["strength", "wits", "empathy"],
    "Полевой вожак": ["strength", "agility", "empathy"],
    "Мастер на все руки": ["strength", "agility", "wits", "empathy"]
  };
  return exact[raw] ?? [];

},

_workerTypeCriterionKind(typeName = "") {
  return /^Все с /i.test(String(typeName ?? "").trim()) ? "broad" : "exact";
},

_workerTypeMatchesCriterion(personType = "", criterion = "") {
  const typeName = String(personType ?? "").trim();
  const rule = String(criterion ?? "").trim();
  if (!typeName || !rule) return false;
  if (this._workerTypeCriterionKind(rule) === "exact") return typeName.toLowerCase() === rule.toLowerCase();
  const wanted = new Set(this._workerTypeAttributeKeys(rule));
  if (!wanted.size) return false;
  const actual = this._workerTypeAttributeKeys(typeName);
  return actual.some((key) => wanted.has(key));
},

_workerTypeChipStyle(typeName = "") {
  const keys = this._workerTypeAttributeKeys(typeName);
  if (!keys.length) return "";
  if (keys.length === 1) return `background: ${ATTRIBUTE_META[keys[0]].color}; color: #f6f0e8; border-color: rgba(255,255,255,0.20);`;
  const stops = keys.map((key, index) => `${ATTRIBUTE_META[key].color} ${Math.round((index / (keys.length - 1)) * 100)}%`).join(", ");
  return `background: linear-gradient(90deg, ${stops}); color: #f6f0e8; border-color: rgba(255,255,255,0.20);`;
},

_suitableTypeBadges(current = "", basePath = "", building = null) {
  const effects = building?.workerTypeEffects && typeof building.workerTypeEffects === "object" ? building.workerTypeEffects : {};
  return splitList(current).map((name) => ({
    name,
    path: basePath,
    style: this._workerTypeChipStyle(name),
    isBroad: this._workerTypeCriterionKind(name) === "broad",
    modifier: this._safeNumber(effects[name], 0.5),
    modifierPath: `${basePath.replace(/\.suitableWorkerTypes$/, "")}.workerTypeEffects.${name}`
  }));
},

_workerTypeEffect(building, typeName) {
  const name = String(typeName ?? "").trim();
  if (!name) return 0;
  const effects = building?.workerTypeEffects && typeof building.workerTypeEffects === "object" ? building.workerTypeEffects : {};
  const raw = effects[name];
  if (raw === undefined || raw === null || raw === "") return 0.5;
  return this._safeNumber(raw, 0.5);
},

_workerTypeEffectForPerson(building, personType) {
  const criteria = this._effectiveWorkerCriteria(building);
  const exact = criteria.filter((criterion) => this._workerTypeCriterionKind(criterion) === "exact" && this._workerTypeMatchesCriterion(personType, criterion));
  const broad = criteria.filter((criterion) => this._workerTypeCriterionKind(criterion) === "broad" && this._workerTypeMatchesCriterion(personType, criterion));
  const picked = exact.length ? exact : broad;
  if (!picked.length) return { value: 0, matched: "" };
  let best = picked[0];
  let bestValue = this._workerTypeEffect(building, best);
  for (const criterion of picked.slice(1)) {
    const value = this._workerTypeEffect(building, criterion);
    if (value > bestValue) { best = criterion; bestValue = value; }
  }
  return { value: bestValue, matched: best };
},

_workerTraitEffect(building = {}, person = {}) {
  const functions = this._buildingFunctions(building);
  const category = this._buildingCategory(building);
  const text = `${building?.name ?? ""} ${building?.type ?? ""} ${building?.notes ?? ""}`.toLowerCase();
  let value = 0;
  const reasons = [];
  const add = (trait, amount, condition = true) => {
    if (condition && this._hasTrait(person, trait)) {
      value += amount;
      reasons.push(`${trait} ${amount > 0 ? "+" : ""}${amount}`);
    }
  };
  add("Мастеровой", 0.5, functions.production || functions.storage || /мастер|кузн|мельниц|механизм|ремонт/.test(text));
  add("Грамотный", 0.5, functions.income || functions.culture || /библиот|скриптор|управ|маяк|голуб|кадр|агент|учет/.test(text));
  add("Бережливый", 0.5, functions.storage || functions.income || /рынок|торгов|склад|хранил|казн/.test(text));
  add("Крепкий", 0.5, category === "production" || category === "defense" || /шахт|лес|камен|вал|ров|поле|пастбищ/.test(text));
  add("Храбрец", 0.5, category === "defense" || /дозор|страж|башн|темниц|стрельбищ|лагер/.test(text));
  add("Суетливый", 0.5, /посыль|голуб|рынок|трактир|пирс|маяк/.test(text));
  add("Больная спина", -0.5, /шахт|лес|камен|вал|ров|перенос|тяжел|стро/.test(text));
  add("Рассеянный", -0.5, functions.production || /механизм|кузн|мельниц|маяк|склад/.test(text));
  add("Пьяница", -0.5);
  add("Трус", -0.5, category === "defense" || /дозор|страж|темниц|воен|оруж|башн/.test(text));
  return { value, reasons };
},

_workerBackgroundEffect(building = {}, person = {}) {
  const background = String(person?.background ?? "").trim().toLowerCase();
  if (!background) return { value: 0, reasons: [] };

  const functions = this._buildingFunctions(building);
  const category = this._buildingCategory(building);
  const lines = Array.isArray(building?.productionLines) ? building.productionLines : [];
  const text = [
    building?.name,
    building?.type,
    building?.effect,
    building?.notes,
    building?.workerRole,
    building?.productionResource,
    building?.production,
    ...lines.flatMap((line) => [line?.name, line?.mode, line?.resource, line?.resourceId])
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");

  const rules = [
    { bg: /строител|каменщик|плотник|землекоп|чернорабоч|грузчик|такелаж|возчик/, place: /стро|центр|стен|башн|дом|жиль|склад|пирс|колод|камен|лес|мост|ремонт/, value: 0.3 },
    { bg: /лесоруб|плотник/, place: /лес|древ|пилорам|мастер|плотн|дом|пирс|стро/, value: 0.3 },
    { bg: /шахтер|рудокоп|каменщик/, place: /шахт|руд|камен|карьер|кузн|стен|башн|колод/, value: 0.3 },
    { bg: /крестьянин|батрак|садовник|рыбак|сборщик/, place: /поле|сад|пастбищ|ферм|мельниц|пекар|колод|погреб|рыб|еда|зерн|пищ/, value: 0.2 },
    { bg: /повар|кок|трактирщик|пекарь|мельник/, place: /кухн|таверн|трактир|пекар|мельниц|пищ|еда|зерн/, value: 0.2 },
    { bg: /механик|инженер|оружейник|мастеровой|счетовод/, place: /механ|кузн|мастер|маяк|генератор|технолог|ремонт|инструмент|арсенал/, value: 0.3 },
    { bg: /писарь|учитель|картограф|счетовод|лавочник|мелкий торговец|торговец/, place: /управ|учет|канцел|библиот|скриптор|школ|рынок|лавк|торгов|маяк|голуб/, value: 0.2 },
    { bg: /лекарь|целител|банщик/, place: /леч|лекар|больн|бан|санитар|госпит/, value: 0.3 },
    { bg: /сакердот|жрец|паломник|могильщик/, place: /храм|свят|кладбищ|культ|религ|погреб|обряд/, value: 0.3 },
    { bg: /солдат|наемник|сторож|дезертир|канонир|дозорный/, place: /страж|дозор|башн|стен|ров|арсенал|оруж|гарнизон|стрельбищ|темниц|лагерь|воен|оборон/, value: 0.3 },
    { bg: /матрос|моряк|рулевой|боцман|навигатор|юнга|контрабандист/, place: /пирс|маяк|кораб|порт|причал|такелаж|навигац|груз|склад/, value: 0.3 },
    { bg: /слуга|ученик|ремесленник|сторож/, place: /мастер|дом|склад|таверн|рынок|служб|ремес|хозяй/, value: 0.1 }
  ];

  const matches = rules.filter((rule) => rule.bg.test(background) && rule.place.test(text));
  let value = matches.reduce((best, rule) => Math.max(best, rule.value), 0);
  if (!value) {
    if (functions.production && /ремесленник|мастеровой|крестьянин|батрак|рабоч|сборщик/.test(background)) value = 0.1;
    else if (functions.income && /торгов|лавочник|счетовод|писарь/.test(background)) value = 0.1;
    else if (functions.defense && /солдат|наемник|сторож|дезертир/.test(background)) value = 0.1;
    else if (functions.culture && /учитель|писарь|сакердот|паломник|жрец/.test(background)) value = 0.1;
    else if (category === "housing" && /слуга|сторож|плотник|каменщик/.test(background)) value = 0.1;
  }
  if (!value) return { value: 0, reasons: [] };
  const rounded = 0.2;
  return { value: rounded, reasons: [`прошлое ${rounded > 0 ? "+" : ""}${rounded}`] };
},

_workerEfficiencyForPerson(holding, building, person) {
  if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0) return { value: 0, suitable: false, traitBonus: 0, matchedType: "", details: [] };
  let value = 1;
  let traitBonus = 0;
  let suitable = false;
  let matchedType = "";
  const details = [];
  const originalType = this._workerType(person);
  const match = this._workerTypeEffectForPerson(building, originalType);
  if (match.value) {
    value += match.value;
    suitable = true;
    matchedType = `${person.name || "работник"}: ${match.matched} ${match.value > 0 ? "+" : ""}${match.value}`;
  }
  const traitEffect = this._workerTraitEffect(building, person);
  if (traitEffect.value) {
    value += traitEffect.value;
    traitBonus += traitEffect.value;
    details.push(`${person.name || "работник"}: ${traitEffect.reasons.join(", ")}`);
  }
  const backgroundEffect = this._workerBackgroundEffect(building, person);
  if (backgroundEffect.value) {
    value += backgroundEffect.value;
    details.push(`${person.name || "работник"}: ${backgroundEffect.reasons.join(", ")}`);
  }
  const globalEffect = this._buildingEfficiencyModifier(holding, building);
  if (globalEffect.value) {
    value += globalEffect.value;
    details.push(`${person.name || "работник"}: ${globalEffect.reasons.join(", ")}`);
  }
  const clean = Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  return { value: clean, suitable, traitBonus, matchedType, details };
},

_buildingEffectiveWorkers(holding, building) {
  const assignedIds = (building?.assignedWorkerIds ?? []).filter(Boolean).map((id) => String(id));
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && this._safeNumber(person?.injuredDays, 0) <= 0);
  let total = 0;
  let suitableCount = 0;
  let traitBonus = 0;
  const matchedTypes = [];
  const details = [];
  for (const id of assignedIds) {
    const person = people.find((row) => String(row.id) === id);
    if (!person) continue;
    const result = this._workerEfficiencyForPerson(holding, building, person);
    total += result.value;
    if (result.suitable) suitableCount += 1;
    if (result.matchedType) matchedTypes.push(result.matchedType);
    if (result.traitBonus) traitBonus += result.traitBonus;
    details.push(...result.details);
  }
  const leaderBonus = assignedIds.length > 1 && assignedIds.some((id) => {
    const person = people.find((row) => String(row.id) === id);
    return person && this._hasTrait(person, "Лидер");
  }) ? 1 : 0;
  total += leaderBonus;
  if (assignedIds.length) details.push(`${assignedIds.length} раб.`);
  if (suitableCount) details.push(`${suitableCount} эфф. тип.`);
  if (matchedTypes.length) details.push(matchedTypes.join("; "));
  if (traitBonus) details.push(`черты ${traitBonus > 0 ? "+" : ""}${traitBonus}`);
  if (leaderBonus) details.push("Лидер +1");
  if (!Number.isFinite(Number(total))) total = 0;
  return { assigned: assignedIds.length, total, suitableCount, traitBonus, leaderBonus, detail: details.join(" · ") || "нет работников" };
}
};
