// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { generatorOptionSets } from "../../generators/resident-generator.js";
import { socialBackgroundOptions } from "../../generators/resident-rules.js";
import { traitBadges } from "../../generators/trait-definitions.js";
import { isMoneyResource } from "../../core/resources.js";
import { prepareResourceCatalogEditor } from "../../data/resources/resource-editor.js";
import { marketEconomySummary } from "../../data/market/economy.js";
import { readableHoldings, warnNoHoldingAccess } from "../../data/access-guard.js";
import { EMPLOYMENT_MODE_IDS } from "../../data/labor/employment-terms.js";
import { WAGE_CATALOG } from "../../data/labor/wage-catalog.js";


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

function storageQuantityKey(identity = {}) {
  return `${identity.id ?? ""}\u0000${identity.name ?? ""}`;
}

function storageQuantityIndex(app, holding) {
  const totals = new Map();
  for (const row of holding?.storage?.resources ?? []) {
    if (isMoneyResource(row?.resourceId, row?.id, row?.name)) continue;
    const identity = app._storageResourceIdentity?.(row);
    if (!identity?.id) continue;
    const qty = app._safeNumber?.(row.qty, row.quantity ?? 0) ?? 0;
    if (Math.abs(qty) < 0.0001) continue;
    const key = storageQuantityKey(identity);
    totals.set(key, (totals.get(key) ?? 0) + qty);
  }
  return totals;
}

function storageCanPayFromIndex(app, holding, costs = [], storageTotals = new Map()) {
  const missing = [];
  for (const cost of costs) {
    const qty = Math.max(0, app._safeNumber?.(cost.qty, 0) ?? 0);
    if (!qty) continue;
    const have = isMoneyResource(cost.resourceId, cost.id, cost.name)
      ? (app._moneyCopper?.(holding) ?? 0)
      : (storageTotals.get(storageQuantityKey(app._storageResourceIdentity?.(cost))) ?? 0);
    if (have + 0.0001 < qty) missing.push({ ...cost, qty, have });
  }
  return { ok: missing.length === 0, missing };
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

_activeWritableHoldingId(data = SkyholdData.get()) {
  const visibleHoldings = this._getVisibleHoldings(data, Boolean(game.user?.isGM));
  const id = String(this.activeHoldingId ?? "");
  return visibleHoldings.some((holding) => String(holding?.id ?? "") === id) ? id : "";
},

_warnNoActiveHolding() {
  warnNoHoldingAccess();
  this.requestRender?.();
},

_resolveActiveHoldingScopedPath(data, path = "") {
  const suffix = String(path ?? "").match(/^holdings\.\d+\.(.+)$/)?.[1];
  if (!suffix) return "";
  const holdingId = this._activeWritableHoldingId(data);
  if (!holdingId) return "";
  const holdingIndex = (Array.isArray(data?.holdings) ? data.holdings : []).findIndex((holding) => String(holding?.id ?? "") === holdingId);
  if (holdingIndex < 0) return "";
  return `holdings.${holdingIndex}.${suffix}`;
},

async _updateActiveHolding(updater, { reason = "active-holding:update" } = {}) {
  const holdingId = this._activeWritableHoldingId(SkyholdData.get());
  if (!holdingId) {
    this._warnNoActiveHolding();
    return null;
  }
  return SkyholdData.updateHolding(holdingId, updater, { fallback: false, reason });
},

async _updateActiveHoldingPath(path, value, { reason = "active-holding:path" } = {}) {
  const updated = await SkyholdData.transaction((data) => {
    const scopedPath = this._resolveActiveHoldingScopedPath(data, path);
    if (!scopedPath) return SkyholdData.skipTransaction(false);
    foundry.utils.setProperty(data, scopedPath, value);
    return true;
  }, { reason });
  if (!updated) this._warnNoActiveHolding();
  return updated;
},

_prepareTabs(canEdit, holding, labelsArg = null) {
  const labels = labelsArg ?? this._contextLabels(holding);
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

_contextLabels(_holding) {
  return {
    peopleTab: "Жители",
    peopleTitle: "Жители",
    peopleHint: "Жители, специалисты, семьи, гости, наемники и проблемные персонажи.",
    buildingsTab: "Здания",
    buildingsTitle: "Здания",
    buildingsHint: "Постройки, рабочие места и явный порядок приоритета при дефиците сырья, бригад или общего спроса.",
    buildingsIcon: "fa-solid fa-building",
    storageTab: "Хранилище",
    storageTitle: "Хранилище",
    storageHint: "Ресурсы и имущество владения: производство, питание, резервы, рынок, грузовые очки и переполнение."
  };
},

_prepareGeneratorContext(holding) {
  const options = generatorOptionSets(this.generatorConfig);
  const preview = (Array.isArray(this.generatorPreview) ? this.generatorPreview : []).map((person, index) => {
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
      backgroundOptions: socialBackgroundOptions(person.background),
      wageClassOptions: [
        { value: "", label: "Без денежной ставки", selected: !person.wageClassId },
        ...WAGE_CATALOG.map((row) => ({ value: row.id, label: row.label, selected: row.id === person.wageClassId }))
      ],
      employmentModeOptions: EMPLOYMENT_MODE_IDS.map((value) => ({
        value,
        label: ({ permanent: "Постоянный", seasonal: "Сезонный", "day-labor": "Подённый" })[value] ?? value,
        selected: value === String(person.employmentMode ?? "permanent")
      }))
    };
  });

  const currentRegion = String(holding?.overview?.region ?? "").trim() || "Регион не указан";

  return {
    ...this.generatorConfig,
    options,
    preview,
    hasPreview: preview.length > 0,
    currentRegion
  };
},


_resourceCatalogContext(data, canEdit = false) {
  return prepareResourceCatalogEditor(data?.catalog?.resources, { canEdit });
},

_marketCatalogContext(data) {
  const summary = marketEconomySummary(data?.catalog?.marketEconomy, data?.catalog?.eventRegions ?? []);
  return {
    ...summary,
    marketCount: summary.locationCount,
    activeMarketCount: summary.locationCount,
    offerCount: summary.baseOfferCount
  };
},

_buildingTemplateContext(holding, data, options = {}) {
  const templates = Array.isArray(data?.catalog?.buildings) ? data.catalog.buildings : [];
  const devSummary = options?.developmentSummary ?? this._developmentSummary(holding);
  const development = devSummary.totals;
  const buildings = holding?.buildings?.list ?? [];
  const builderAvailable = crewHasBuilderTrait(holding);
  const storageTotals = storageQuantityIndex(this, holding);
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
    const payment = costs.length ? storageCanPayFromIndex(this, holding, costs, storageTotals) : { ok: true, missing: [] };
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
  const publicRows = [];
  const hiddenRows = [];
  const available = [];
  const locked = [];
  const byCategory = { food: [], technology: [], culture: [], war: [], housing: [], storage: [] };
  for (const row of prepared) {
    if (row.playerVisible === false) {
      hiddenRows.push(row);
      continue;
    }
    publicRows.push(row);
    if (row.unlocked) available.push(row);
    else locked.push(row);
    if (byCategory[row.templateCategory]) byCategory[row.templateCategory].push(row);
  }
  return {
    rows: prepared,
    publicRows,
    hiddenRows,
    available,
    locked,
    hasRows: prepared.length > 0,
    availableCount: available.length,
    lockedCount: locked.length,
    hiddenCount: hiddenRows.length,
    development: devSummary,
    byCategory
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
  const id = makeId("row", 12);

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
      compensationType: "dependent",
      baseWageDaily: 0,
      cashWageDaily: 0,
      boardFoodDaily: 1,
      foodProvisionMode: "settlement",
      housingProvided: false,
      shareRate: 0,
      employmentMode: "permanent",
      wageClassId: "",
      employmentSeasonMask: {
        spring: false,
        summer: false,
        autumn: false,
        winter: false
      },
      employmentContractStartQd: null,
      employmentContractEndQd: null,
      volunteerReason: "",
      volunteerTermStartQd: null,
      volunteerTermEndQd: null,
      coercionBasis: "",
      hungerStreakTendays: 0,
      compensationNote: "Новый член хозяйства находится на общем содержании.",
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
      defense: { base: 0, perStep: 0, workerStep: 0, combatTag: "garrison" },
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

  if (/\.gm\.eventTables\.(general|external)\.rows$/.test(collection)) {
    const kind = collection.match(/\.gm\.eventTables\.(general|external)\.rows$/)?.[1] ?? "general";
    return {
      id,
      weight: kind === "external" ? 3 : 4,
      title: "Новое событие",
      condition: "",
      text: "",
      effect: "",
      requirements: { logic: "all", rules: [] },
      boosts: { logic: "any", rules: [] },
      visibility: "public",
      gmText: "",
      cooldown: 0,
      chainId: "",
      nextEventId: "",
      combatPreset: ""
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
