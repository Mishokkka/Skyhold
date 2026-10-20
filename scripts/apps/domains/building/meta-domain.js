// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { inferBuildingSpecialKind } from "../../../core/building-specials.js";
import {
  CONSTRUCTION_LEADER_WAGE_DAILY_COPPER,
  CONSTRUCTION_WORKER_WAGE_DAILY_COPPER
} from "../../../engines/workers/construction-leadership.js";
import { WORK_ALLOCATION_MODE_EXPLICIT } from "../../../data/work-allocations.js";
import { RELIGION_OPTIONS } from "./building-constants.js";

function whole(value, fallback = 0) {
  const parsed = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(parsed) ? parsed : fallback));
}

function signedRound(value = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !parsed) return 0;
  return Math.sign(parsed) * Math.round(Math.abs(parsed));
}

function clampWorkMorale(value = 0) {
  return Math.max(-3, Math.min(3, signedRound(value)));
}

function latestWageObligation(holding = {}, personId = "") {
  return (holding?.finance?.obligations ?? [])
    .filter((row) => row?.kind === "wage" && String(row?.recipientId ?? "") === String(personId ?? ""))
    .sort((left, right) => (
      whole(right?.periodIndex) - whole(left?.periodIndex)
      || String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? ""))
    ))[0] ?? null;
}

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

_buildingEfficiencyModifier(holding, building) {
  const gm = this._gmEfficiencyModifiers(holding);
  let value = gm.all;
  const reasons = [];
  if (gm.all) reasons.push(`ГМ все здания ${gm.all > 0 ? "+" : ""}${gm.all}`);
  if (this._buildingFunctions(building).production) {
    if (gm.production) { value += gm.production; reasons.push(`ГМ производство ${gm.production > 0 ? "+" : ""}${gm.production}`); }
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
    ["production", "Произв.", "fa-solid fa-industry", "Открывает блок производственных линий: какие ресурсы здание создает, сколько дает база и сколько добавляет эффективность работников."],
    ["income", "Доход", "fa-solid fa-coins", "Открывает блок доходности. Это деньги за десятник, которые попадут в бухгалтерию."],
    ["defense", "Оборона", "fa-solid fa-shield-halved", "Открывает блок реальной Защищенности. Это не развитие Войны, а кубы против угроз."],
    ["housing", "Жилье", "fa-solid fa-house", "Открывает жилой блок: места проживания, комфорт и заполненность жильцами."],
    ["storage", "Склад", "fa-solid fa-box-archive", "Помечает здание как складское помещение. Построенное складское здание появляется в списке мест хранения и может принимать продукцию."],
    ["culture", "Культ./рел.", "fa-solid fa-music", "Помечает культурное или религиозное влияние: довольство, вера, репутация, события."]
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
    { id: "all", label: "Все", shortLabel: "Все", icon: "fa-solid fa-layer-group" },
    { id: "housing", label: "Жилые", shortLabel: "Жил.", icon: "fa-solid fa-house" },
    { id: "storage", label: "Складские", shortLabel: "Склад", icon: "fa-solid fa-box-archive" },
    { id: "production", label: "Производство", shortLabel: "Произв.", icon: "fa-solid fa-industry" },
    { id: "infrastructure", label: "Инфраструктура", shortLabel: "Инфра", icon: "fa-solid fa-road" },
    { id: "defense", label: "Военные", shortLabel: "Воен.", icon: "fa-solid fa-shield-halved" },
    { id: "culture", label: "Культурные", shortLabel: "Культ.", icon: "fa-solid fa-music" },
    { id: "special", label: "Особые", shortLabel: "Особ.", icon: "fa-solid fa-star" }
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

_workMoraleForPeriod(person, holding = null, options = {}) {
  if (!person || person?.dead) return { value: 0, conditions: 0, pay: 0, overtime: 0, totalQd: 0, reason: "" };
  const buildings = holding?.buildings?.list ?? [];
  const buildingById = new Map(buildings.flatMap((building) => [
    [String(building?.id ?? ""), building],
    [String(building?.name ?? ""), building]
  ]).filter(([key]) => key));
  const crews = new Map((holding?.constructionCrews ?? []).map((crew) => [String(crew?.id ?? ""), crew]));
  const suppliedAssignments = Array.isArray(options?.assignments) ? options.assignments : null;
  let assignments = suppliedAssignments?.map((row) => ({
    sourceId: String(row?.sourceId ?? ""),
    functionId: String(row?.functionId ?? ""),
    normalQd: whole(row?.normalQd),
    overtimeQd: whole(row?.overtimeQd),
    volunteer: row?.volunteer === true
  })) ?? [];

  if (!suppliedAssignments && String(person?.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT) {
    assignments = (person?.workAllocations ?? []).map((row) => ({
      sourceId: String(row?.sourceId ?? ""),
      functionId: String(row?.functionId ?? ""),
      normalQd: whole(row?.normalQd),
      overtimeQd: whole(row?.overtimeQd),
      volunteer: row?.volunteer === true
    }));
  } else if (!suppliedAssignments) {
    const selected = String(person?.workAssignment ?? "").trim();
    const building = buildingById.get(selected);
    if (selected && !["other", "Свободен", "Без работы", "Ребенок"].includes(selected)) {
      const overtimeQd = building && this._buildingHasOvertimeProduction?.(building) ? 10 : 0;
      assignments = [{
        sourceId: selected,
        functionId: building ? "production" : selected,
        normalQd: 20,
        overtimeQd
      }];
    }
  }
  assignments = assignments.filter((row) => row.sourceId && row.normalQd + row.overtimeQd > 0);

  let weightedConditions = 0;
  let totalQd = 0;
  let overtimeQd = 0;
  let weightedBaseline = 0;
  let baselineQd = 0;
  const conditionParts = [];
  for (const assignment of assignments) {
    const qd = assignment.normalQd + assignment.overtimeQd;
    const building = buildingById.get(assignment.sourceId);
    const condition = building ? this._safeNumber(building?.workerMoraleDelta, 0) : 0;
    weightedConditions += condition * qd;
    totalQd += qd;
    overtimeQd += assignment.overtimeQd;
    if (building && condition) conditionParts.push(`${building.name || "здание"} ${condition > 0 ? "+" : ""}${condition} × ${qd} QD`);

    let baseline = building ? whole(building?.wageDailyCopper) : 0;
    if (!baseline && assignment.functionId === "construction-leader") baseline = CONSTRUCTION_LEADER_WAGE_DAILY_COPPER;
    if (!baseline && assignment.functionId === "construction") {
      baseline = whole(crews.get(assignment.sourceId)?.wageDailyCopper) || CONSTRUCTION_WORKER_WAGE_DAILY_COPPER;
    }
    if (!baseline && ["sheriff", "шериф"].includes(assignment.sourceId.toLocaleLowerCase("ru"))) baseline = 18;
    if (baseline > 0 && !assignment.volunteer) {
      weightedBaseline += baseline * qd;
      baselineQd += qd;
    }
  }
  const conditions = totalQd > 0 ? signedRound(weightedConditions / totalQd) : 0;

  let pay = 0;
  let payReason = "";
  const volunteer = person?.volunteerLabor === true || (assignments.length > 0 && assignments.every((row) => row.volunteer));
  const obligation = options?.wageObligation ?? latestWageObligation(holding, person?.id);
  if (assignments.length || obligation) {
    if (volunteer) {
      payReason = "добровольный труд";
    } else if (obligation && whole(obligation?.dueCopper) > 0 && whole(obligation?.paidCopper) < whole(obligation?.dueCopper)) {
      pay = -2;
      payReason = "зарплата не выплачена полностью";
    } else if (!obligation && baselineQd > 0) {
      pay = -2;
      payReason = "нет выплаченного договора за период";
    } else if (obligation && whole(obligation?.dueCopper) > 0) {
      const priced = (obligation?.meta?.assignments ?? []).filter((row) => !row.volunteer);
      const pricedQd = priced.reduce((sum, row) => sum + whole(row?.normalQd) + whole(row?.overtimeQd), 0);
      const effectiveRate = pricedQd > 0
        ? priced.reduce((sum, row) => sum + whole(row?.effectiveDailyRateCopper) * (whole(row?.normalQd) + whole(row?.overtimeQd)), 0) / pricedQd
        : 0;
      const baselineRate = baselineQd > 0 ? weightedBaseline / baselineQd : effectiveRate;
      const ratio = baselineRate > 0 ? effectiveRate / baselineRate : 1;
      pay = ratio >= 1.5 ? 2 : ratio >= 1.25 ? 1 : ratio >= 1 ? 0 : -1;
      payReason = baselineRate > 0 ? `ставка ${Math.round(ratio * 100)}% базовой` : "ставка выплачена";
    }
  }

  const overtime = overtimeQd >= 6 ? -2 : overtimeQd >= 1 ? -1 : 0;
  const value = clampWorkMorale(conditions + pay + overtime);
  const reasons = [];
  if (conditionParts.length) reasons.push(`условия: ${conditions > 0 ? "+" : ""}${conditions} (${conditionParts.join("; ")})`);
  else if (totalQd > 0) reasons.push("условия: 0");
  if (payReason) reasons.push(`оплата: ${pay > 0 ? "+" : ""}${pay} (${payReason})`);
  if (overtimeQd > 0) reasons.push(`переработка: ${overtime} (${overtimeQd} QD)`);
  if (reasons.length && value !== conditions + pay + overtime) reasons.push(`предел: ${value > 0 ? "+" : ""}${value}`);
  return { value, conditions, pay, overtime, totalQd, overtimeQd, reason: reasons.join(", ") };
},

_workMorale(person, holding = null) {
  const snapshot = holding?.gm?.moraleSnapshot?.residents?.[String(person?.id ?? "")]?.work;
  if (snapshot && typeof snapshot === "object") return { ...snapshot };
  return this._workMoraleForPeriod(person, holding);
},

_recordTendayMoraleSnapshot(holding, report = {}, financeContext = null, { operationId = "", createdAt = "" } = {}) {
  if (!holding?.gm || typeof holding.gm !== "object") holding.gm = {};
  const tier = String(report?.food?.effectiveTier ?? "normal");
  const rationModifier = this._safeNumber(report?.food?.rationModifier, tier === "enhanced" ? 1 : tier === "sparse" ? -1 : tier === "hunger" ? -2 : 0);
  const diversityBonus = Math.max(0, Math.min(2, this._safeNumber(report?.food?.diversityBonus, 0)));
  const residents = {};
  const obligations = new Map((report?.finance?.obligations ?? [])
    .filter((row) => row?.kind === "wage")
    .map((row) => [String(row?.recipientId ?? ""), row]));
  for (const person of holding?.people?.list ?? []) {
    if (person?.dead || !person?.id) continue;
    const assignments = financeContext?.plannedAssignmentsByWorkerId?.get?.(String(person.id));
    residents[String(person.id)] = {
      ration: { value: rationModifier + diversityBonus, tier, diversityBonus },
      work: this._workMoraleForPeriod(person, holding, {
        assignments: assignments ? [...assignments] : [],
        wageObligation: obligations.get(String(person.id)) ?? latestWageObligation(holding, person.id)
      })
    };
  }
  holding.gm.moraleSnapshot = {
    schema: 1,
    operationId: String(operationId ?? ""),
    periodKey: String(financeContext?.periodIdentity?.periodKey ?? report?.finance?.periodKey ?? ""),
    createdAt: String(createdAt ?? ""),
    ration: { tier, modifier: rationModifier + diversityBonus, diversityBonus,
      fullySupplied: Boolean(report?.food?.needed > 0 && report.food.effectiveTier === report.food.selectedTier
        && !report.food.fallback && report.food.eaten >= report.food.needed) },
    residents
  };
  return holding.gm.moraleSnapshot;
}
};
