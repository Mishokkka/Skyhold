// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../data/store.js";
import { generatorOptionSets } from "../../generators/resident-generator.js";
import { socialBackgroundOptions } from "../../generators/resident-rules.js";
import { traitBadges } from "../../generators/trait-definitions.js";
import { BUILTIN_RESOURCE_DEFS, normalizeResourceCatalogRow } from "../../core/resources.js";
import { readableHoldings } from "../../data/access-guard.js";


function normalizeSpecialSkill(value = "") {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (/(builder|строител|строитель)/i.test(raw)) return "Builder";
  if (/(trader|торгов)/i.test(raw)) return "Trader";
  if (/(scribe|писар|летопис|грамот)/i.test(raw)) return "Scribe";
  if (/(healer|лекар|целител)/i.test(raw)) return "Healer";
  if (/(priest|жрец|свящ)/i.test(raw)) return "Priest";
  if (/(guard|страж|охран)/i.test(raw)) return "Guard";
  if (/(sailor|моряк|навиг)/i.test(raw)) return "Sailor";
  if (/(engineer|механик|инженер)/i.test(raw)) return "Engineer";
  return String(value ?? "").trim();
}

function specialSkillLabel(value = "") {
  const key = normalizeSpecialSkill(value);
  const labels = {
    Builder: "Builder / Строитель",
    Trader: "Trader / Торговец",
    Scribe: "Scribe / Писарь",
    Healer: "Healer / Лекарь",
    Priest: "Priest / Жрец",
    Guard: "Guard / Стражник",
    Sailor: "Sailor / Моряк",
    Engineer: "Engineer / Механик"
  };
  return labels[key] ?? key;
}

function templateSpecialSkillRequirements(template = {}) {
  const explicit = Array.isArray(template.requiredSpecialSkills) ? template.requiredSpecialSkills : [];
  const text = `${template.specialRequirements ?? ""} ${template.sourceRequirement ?? ""}`;
  const required = new Set(explicit.map(normalizeSpecialSkill).filter(Boolean));
  if (/(builder|the\s+builder\s+talent|\bBUILDER\b|строител|строитель)/i.test(text)) required.add("Builder");
  if (/(торговец|trader)/i.test(text)) required.add("Trader");
  if (/(писарь|scribe)/i.test(text)) required.add("Scribe");
  if (/(лекарь|healer)/i.test(text)) required.add("Healer");
  if (/(жрец|priest)/i.test(text)) required.add("Priest");
  if (/(стражник|guard)/i.test(text)) required.add("Guard");
  if (/(моряк|sailor)/i.test(text)) required.add("Sailor");
  if (/(механик|инженер|engineer)/i.test(text)) required.add("Engineer");
  return [...required].map((value) => ({ value, label: specialSkillLabel(value) }));
}


function hasTraitText(value = "", name = "") {
  const target = String(name ?? "").trim().toLowerCase();
  if (!target) return false;
  return traitBadges(value).some((trait) => String(trait.name ?? "").trim().toLowerCase() === target);
}

function crewHasBuilderTrait(holding = {}) {
  const people = new Map((holding?.people?.list ?? []).map((person) => [String(person.id), person]));
  for (const crew of holding?.constructionCrews ?? []) {
    const ids = new Set([String(crew?.leaderId ?? ""), ...(Array.isArray(crew?.memberIds) ? crew.memberIds.map((id) => String(id ?? "")) : [])].filter(Boolean));
    for (const id of ids) {
      const person = people.get(id);
      if (person && !person.dead && hasTraitText(person.traitsText ?? person.traits, "Builder")) return true;
    }
  }
  return false;
}

function templateRequiresBuilder(template = {}) {
  const explicit = Array.isArray(template.requiredSpecialSkills) ? template.requiredSpecialSkills : [];
  const text = `${template.specialRequirements ?? ""} ${template.sourceRequirement ?? ""} ${explicit.join(" ")}`;
  return /(builder|the\s+builder\s+talent|\bBUILDER\b|строител|строитель)/i.test(text);
}

function materialCostRows(template = {}) {
  return (Array.isArray(template.materialCosts) ? template.materialCosts : [])
    .map((item) => ({
      resourceId: String(item?.resourceId ?? item?.id ?? item?.name ?? "custom"),
      name: String(item?.name ?? item?.resourceId ?? "Материал"),
      qty: Number(item?.qty ?? item?.quantity ?? 0) || 0
    }))
    .filter((item) => item.qty > 0);
}

export const HoldingDomain = {
_getVisibleHoldings(data, canEdit) {
  if (canEdit) return Array.isArray(data.holdings) ? data.holdings : [];
  return readableHoldings(data);
},

_resolveActiveHolding(data, visibleHoldings) {
  if (!visibleHoldings.length) {
    this.activeHoldingId = null;
    return null;
  }

  const active = visibleHoldings.find((holding) => holding.id === this.activeHoldingId) ?? visibleHoldings[0];
  this.activeHoldingId = active.id;
  return data.holdings.find((holding) => holding.id === active.id) ?? active;
},

_prepareTabs(canEdit, holding) {
  const labels = this._contextLabels(holding);
  const tabs = [
    { id: "overview", label: "Обзор", icon: "fa-solid fa-compass" },
    { id: "people", label: labels.peopleTab, icon: "fa-solid fa-people-group" },
    { id: "buildings", label: labels.buildingsTab, icon: labels.buildingsIcon },
    { id: "defense", label: "Оборона", icon: "fa-solid fa-shield-halved" },
    { id: "special", label: "Особое", icon: "fa-solid fa-sparkles" },
    { id: "storage", label: labels.storageTab, icon: "fa-solid fa-box-archive" }
  ];

  if (canEdit) tabs.push({ id: "gm", label: "ГМ", icon: "fa-solid fa-user-shield" });
  return tabs;
},

_contextLabels(holding) {
  if (holding?.type === "ship") {
    return {
      peopleTab: "Экипаж",
      peopleTitle: "Экипаж",
      peopleHint: "Офицеры, матросы, специалисты, пассажиры и наемники.",
      buildingsTab: "Узлы",
      buildingsTitle: "Узлы и отсеки",
      buildingsHint: "Отсеки, вооружение, улучшения, поврежденные системы и важные корабельные объекты.",
      buildingsIcon: "fa-solid fa-ship",
      storageTab: "Груз",
      storageTitle: "Груз и припасы",
      storageHint: "Груз, припасы, контрабанда, топливо, деньги и корабельное имущество."
    };
  }

  return {
    peopleTab: "Жители",
    peopleTitle: "Жители",
    peopleHint: "Жители, специалисты, семьи, гости, наемники и проблемные персонажи.",
    buildingsTab: "Здания",
    buildingsTitle: "Здания",
    buildingsHint: "Постройки, уровни, статусы, рабочие места и будущие механические эффекты.",
    buildingsIcon: "fa-solid fa-building",
    storageTab: "Хранилище",
    storageTitle: "Хранилище",
    storageHint: "Ресурсы и имущество владения. Пока без автоматической экономики."
  };
},

_prepareGeneratorContext(holding) {
  const options = generatorOptionSets(this.generatorConfig);
  const preview = (this.generatorPreview ?? []).map((person, index) => {
    const badges = this._traitBadges(person.traitsText ?? person.traits);
    return {
      ...person,
      _index: index,
      ageGroup: this._ageGroup(person),
      ageLine: this._ageLine(person),
      raceLine: this._raceLine(person),
      workerTypeLabel: this._workerType(person),
      workerTypeStyle: this._workerTypeStyle(person),
      attributeSummary: this._attributeSummary(person),
      moraleValue: this._calculatePersonMorale(person, holding).total,
      traitBadges: badges,
      hasTraitBadges: badges.length > 0,
      traitsBrief: badges.map((trait) => trait.name).join(", ") || "—",
      selected: person._selected !== false,
      editing: this.activeGeneratedPersonIndex === index,
      cultureOptions: this._cultureOptions?.(person.culture) ?? [{ value: person.culture || "", label: person.culture || "—", selected: true }],
      beliefOptions: this._beliefOptions?.(person.belief) ?? [{ value: person.belief || "", label: person.belief || "—", selected: true }],
      backgroundOptions: socialBackgroundOptions(person.background)
    };
  });

  const currentRegion = String(holding?.overview?.region ?? holding?.overview?.currentRegion ?? holding?.overview?.drift ?? "").trim() || "Нованд";

  return {
    ...this.generatorConfig,
    options,
    preview,
    hasPreview: preview.length > 0,
    currentRegion
  };
},


_resourceCatalogContext(data, canEdit = false) {
  const rows = Array.isArray(data?.catalog?.resources) ? data.catalog.resources : [];
  const prepared = rows.map((row, index) => {
    const normalized = normalizeResourceCatalogRow(row);
    return {
      ...normalized,
      _index: index,
      aliasesText: Array.isArray(row.aliases) ? row.aliases.join(", ") : String(row.aliases ?? normalized.aliases.join(", ")),
      canEdit
    };
  });
  return {
    rows: prepared,
    builtins: BUILTIN_RESOURCE_DEFS.map((resource) => resource.label).join(", "),
    builtinCount: BUILTIN_RESOURCE_DEFS.length,
    hasRows: prepared.length > 0
  };
},

_buildingTemplateContext(holding, data) {
  const templates = Array.isArray(data?.catalog?.buildings) ? data.catalog.buildings : [];
  const development = this._developmentSummary(holding).totals;
  const buildings = holding?.buildings?.list ?? [];
  const builderAvailable = crewHasBuilderTrait(holding);
  const builtRows = buildings.filter((building) => this._buildingStatus?.(building)?.value === "built");
  const projectRows = buildings.filter((building) => this._buildingStatus?.(building)?.value !== "built");
  const builtIds = new Set(builtRows.map((building) => String(building.templateId ?? building.id ?? "")));
  const builtNames = new Set(builtRows.map((building) => String(building.name ?? "").toLowerCase()));
  const projectIds = new Set(projectRows.map((building) => String(building.templateId ?? building.id ?? "")));
  const projectNames = new Set(projectRows.map((building) => String(building.name ?? "").toLowerCase()));
  const prepared = templates.map((template, index) => {
    const req = this._devObject(template.requirements);
    const unlockedByDev = this._requirementsMet(req, development);
    const missingDevelopmentChips = this._missingDevChips(req, development);
    const explicitUnlocked = template.unlocked !== false;
    const dependencies = Array.isArray(template.requiredBuildingIds) ? template.requiredBuildingIds : [];
    const depsOk = dependencies.every((id) => builtIds.has(String(id)) || builtNames.has(String(id).toLowerCase()));
    const costs = materialCostRows(template);
    const payment = this._storageCanPay ? this._storageCanPay(holding, costs) : { ok: true, missing: [] };
    const materialsOk = Boolean(payment.ok);
    const builderRequired = templateRequiresBuilder(template);
    const requiredSpecialSkills = builderRequired ? [{ value: "Builder", label: "Builder / Строитель в стройбригаде" }] : [];
    const missingSpecialSkills = builderRequired && !builderAvailable ? requiredSpecialSkills : [];
    const specialSkillsOk = missingSpecialSkills.length === 0;
    // Материалы больше не закрывают шаблон: проект можно начать как blueprint и довезти ресурсы позже.
    const unlocked = explicitUnlocked && unlockedByDev && depsOk && specialSkillsOk;
    const bonuses = this._devObject(template.bonuses);
    const bonusChips = this._devChips(bonuses, "bonus");
    const requirementChips = this._devChips(req, "requirement");
    const materialCosts = Array.isArray(template.materialCosts) ? template.materialCosts : [];
    const missingMaterialsText = materialsOk ? "" : (payment.missing ?? []).map((m) => `${m.name} ${Math.max(0, (m.qty ?? 0) - (m.have ?? 0))}`).join(", ");
    const reason = [];
    if (!explicitUnlocked) reason.push("закрыто решением ГМа");
    if (!unlockedByDev) reason.push(`нужно развитие: ${this._devText(req)}`);
    if (!depsOk) reason.push("нужны зависимые здания");
    if (!specialSkillsOk) reason.push(`нужна черта в стройбригаде: ${missingSpecialSkills.map((skill) => skill.label).join(", ")}`);
    const primaryDev = String(template.primaryDev ?? this._dominantDevKey(bonuses));
    const lines = Array.isArray(template.productionLines) ? template.productionLines.filter((line) => line?.active !== false) : [];
    const functions = this._buildingFunctions(template);
    const buildingCategory = this._buildingCategory?.(template) ?? "special";
    const templateCategory = functions.storage ? "storage" : (functions.housing ? "housing" : primaryDev);
    const functionLabels = [];
    if (functions.production) functionLabels.push("Производство");
    if (functions.income) functionLabels.push("Доход");
    if (functions.defense) functionLabels.push("Оборона");
    if (functions.housing) functionLabels.push("Жилье");
    if (functions.storage) functionLabels.push("Склад");
    if (functions.culture) functionLabels.push("Культура");
    const hasBuilt = builtIds.has(String(template.id)) || builtNames.has(String(template.name ?? "").toLowerCase());
    const hasProject = projectIds.has(String(template.id)) || projectNames.has(String(template.name ?? "").toLowerCase());
    const visibility = template.visibility === "gm" ? "gm" : "public";
    const playerVisible = visibility !== "gm";
    return {
      ...template,
      _index: index,
      visibility,
      playerVisible,
      visibilityText: playerVisible ? "видно игрокам" : "скрыто от игроков",
      unlocked,
      locked: !unlocked,
      hasBuilt,
      hasProject,
      duplicateStateText: hasBuilt ? "построено" : (hasProject ? "в проекте" : ""),
      css: [unlocked ? "available" : "locked", hasBuilt ? "built" : "", hasProject ? "planned" : "", playerVisible ? "" : "hidden-template"].filter(Boolean).join(" "),
      primaryDev,
      primaryDevLabel: templateCategory === "housing" ? "Жилье" : (templateCategory === "storage" ? "Склады" : (this._devLabel?.(primaryDev) ?? primaryDev)),
      primaryDevCss: templateCategory,
      templateCategory,
      buildingCategory,
      requirementsText: this._devText(req, "нет"),
      bonusesText: this._devText(bonuses, "нет"),
      bonusChips,
      requirementChips,
      missingDevelopmentChips,
      missingDevelopmentText: missingDevelopmentChips.length ? missingDevelopmentChips.map((item) => `${item.label}: не хватает ${item.deficit} (нужно ${item.required}, есть ${item.current})`).join(" · ") : "",
      showDevelopmentWarning: missingDevelopmentChips.length > 0,
      hasBonusChips: bonusChips.length > 0,
      hasRequirementChips: requirementChips.length > 0,
      materialCostsText: materialCosts.length ? materialCosts.map((item) => `${item.qty} ${item.name || item.resourceId || "рес."}`).join(" · ") : "нет",
      buildText: `${this._safeNumber(template.buildProgress, 0) || 0}/${Math.max(1, this._safeNumber(template.buildTarget, 6))}, сложн. ${this._safeNumber(template.buildDifficulty, 0)}`,
      dependenciesText: dependencies.length ? dependencies.join(" · ") : "нет",
      specialRequirements: String(template.specialRequirements ?? ""),
      requiredSpecialSkills,
      missingSpecialSkills,
      specialSkillRequirementsText: requiredSpecialSkills.length ? requiredSpecialSkills.map((skill) => skill.label).join(" · ") : "—",
      sourceRequirement: String(template.sourceRequirement ?? ""),
      sourceRawMaterials: String(template.sourceRawMaterials ?? ""),
      functionLabels: functionLabels.join(" · ") || "—",
      materialsOk,
      missingMaterialsText,
      productionLinesText: lines.length ? lines.map((line) => `${line.name || line.mode || line.resource || "Линия"}: ${line.outputQty ?? line.base ?? 1} ${line.resource || line.resourceId || "рес."}`).join("; ") : "—",
      reasonText: reason.join("; ") || (materialsOk ? "доступно" : `доступно, но не хватает материалов: ${missingMaterialsText}`)
    };
  });
  const publicRows = prepared.filter((item) => item.playerVisible !== false);
  const hiddenRows = prepared.filter((item) => item.playerVisible === false);
  const devSummary = this._developmentSummary(holding);
  return {
    rows: prepared,
    publicRows,
    hiddenRows,
    available: publicRows.filter((item) => item.unlocked),
    locked: publicRows.filter((item) => !item.unlocked),
    hasRows: prepared.length > 0,
    availableCount: publicRows.filter((item) => item.unlocked).length,
    lockedCount: publicRows.filter((item) => !item.unlocked).length,
    hiddenCount: hiddenRows.length,
    development: devSummary,
    byCategory: {
      food: publicRows.filter((item) => item.templateCategory === "food"),
      technology: publicRows.filter((item) => item.templateCategory === "technology"),
      culture: publicRows.filter((item) => item.templateCategory === "culture"),
      war: publicRows.filter((item) => item.templateCategory === "war"),
      housing: publicRows.filter((item) => item.templateCategory === "housing"),
      storage: publicRows.filter((item) => item.templateCategory === "storage")
    }
  };
},


_missingDevChips(requirements = {}, totals = {}) {
  return this._developmentParts(requirements)
    .map((item) => {
      const required = this._safeNumber(item.value, 0);
      const current = this._safeNumber(totals?.[item.key], 0);
      const deficit = Math.max(0, required - current);
      return {
        ...item,
        value: deficit,
        required,
        current,
        deficit,
        tooltip: `Не хватает: ${deficit}; нужно ${required}; есть ${current}`
      };
    })
    .filter((item) => item.value > 0 && item.deficit > 0);
},

_devChips(dev = {}, kind = "bonus") {
  return this._developmentParts(dev)
    .filter((item) => this._safeNumber(item.value, 0) !== 0)
    .map((item) => {
      const value = this._safeNumber(item.value, 0);
      const sign = kind === "bonus" && value > 0 ? "+" : "";
      const prefix = kind === "bonus" ? "Бонус" : "Требование";
      return {
        ...item,
        kind,
        text: `${sign}${value}`,
        tooltip: `${prefix}: ${item.label} ${sign}${value}`
      };
    });
},

_dominantDevKey(dev = {}) {
  const entries = ["food", "technology", "culture", "war"].map((key) => [key, this._safeNumber(dev?.[key], 0)]);
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0]?.[1] ? entries[0][0] : "technology";
},

_holdingIndex(holding) {
  if (holding?.id && this._contextHoldingId === holding.id && Number.isInteger(this._contextHoldingIndex)) {
    return this._contextHoldingIndex;
  }
  const data = this._contextData ?? SkyholdData.get();
  return data.holdings.findIndex((item) => item.id === holding?.id);
},

_emptyRowFor(collection) {
  const id = foundry.utils.randomID(12);

  if (collection.endsWith(".people.list")) {
    return {
      id,
      name: "Новый житель",
      role: "Без работы",
      skill: "",
      sex: "",
      age: 30,
      ageGroup: "Вз",
      culture: "",
      belief: "",
      background: "",
      race: "Человек",
      subrace: "Гвирл",
      salary: 0,
      salaryModifier: 0,
      moraleBase: -1,
      moraleWork: 0,
      moraleHome: 0,
      moraleManual: 0,
      moraleDelta: -1,
      home: "Без жилья",
      attributes: {
        strength: 3,
        agility: 3,
        wits: 3,
        empathy: 3
      },
      traitsText: "",
      appearance: "",
      status: "",
      notes: ""
    };
  }

  if (collection.endsWith(".buildings.list")) {
    return {
      id,
      templateId: "",
      name: "Новая постройка",
      type: "Особые",
      status: "Проект",
      constructionStatus: "planned",
      constructionCrewId: "",
      location: "",
      requirements: { food: 0, technology: 0, culture: 0, war: 0 },
      bonuses: { food: 0, technology: 0, culture: 0, war: 0 },
      workersMin: 1,
      workersMax: 2,
      assignedWorkerIds: ["", ""],
      suitableWorkerTypes: "Силач, Умелец, Механик",
      effect: "",
      production: "",
      functions: { production: false, income: false, defense: false, housing: false, storage: false, culture: false },
      productionResource: "",
      productionAmount: 0,
      productionPerWorker: 0,
      productionFormula: "",
      productionLines: [],
      income: { base: 0, perWorker: 0, formula: "", risk: 0, illegal: false },
      defense: { base: 0, perStep: 0, workerStep: 0 },
      housing: { capacity: 0, comfort: 0, quality: 0, notes: "" },
      storage: { capacity: 0, security: 0, quality: 0 },
      productionPerDay: 0,
      workerRole: "",
      modifiers: "",
      reputation: 0,
      moraleDelta: 0,
      upkeep: 0,
      materialCosts: [],
      requiredBuildingIds: [],
      icon: "fa-solid fa-building",
      img: "",
      buildDifficulty: 0,
      buildTarget: 6,
      buildProgress: 0,
      notes: ""
    };
  }

  if (collection.endsWith(".special.list")) {
    return {
      id,
      name: "Новая особенность",
      type: "Тип",
      visibility: "public",
      notes: ""
    };
  }



  if (collection === "catalog.resources" || collection.endsWith(".catalog.resources")) {
    return {
      id,
      label: "Новый ресурс",
      unit: "ед.",
      icon: "fa-solid fa-cube",
      category: "Пользовательское",
      aliases: "",
      itemUuid: "",
      useInProduction: true,
      useInConstruction: true,
      isMoney: false,
      hidden: false,
      notes: ""
    };
  }

  if (collection.endsWith(".storage.resources")) {
    return {
      id,
      resourceId: "wood",
      name: "Древесина",
      qty: 1,
      unit: "ед.",
      notes: ""
    };
  }

  return { id, name: "Новая запись", notes: "" };
}
};
