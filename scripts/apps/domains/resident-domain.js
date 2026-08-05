// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { traitBadges, traitMorale, traitOptions } from "../../generators/trait-definitions.js";
import { CULTURE_NAMES } from "../../generators/name-pools.js";
import { ageGroupFromAge, ageThresholdsFor, attributeSummary, normalizeBelief, raceKeyFromResident, socialBackgroundOptions, workerTypeFromAttributes, workerTypeStyleFromAttributes } from "../../generators/resident-rules.js";
import { buildingOperationalState } from "../../core/building-state.js";
import { compensationContractWarning, compensationTypeLabel, compensationTypeOptions, personBoardFoodDaily, personCashWageDaily, personShareRate } from "../../core/compensation.js";
import { fleetVesselAvailableCopper, VESSEL_STATUSES } from "../../data/normalizers/fleet.js";
import { calculateMoraleSnapshot, moraleBandForScore } from "../../engines/morale/morale-snapshot.js";
import { EMPLOYMENT_MODE_IDS, EMPLOYMENT_SEASON_IDS } from "../../data/labor/employment-terms.js";
import { WAGE_CATALOG, normalizeWageIndex, wageCopperPerTenday } from "../../data/labor/wage-catalog.js";
import { normalizePayrollState } from "../../data/labor/payroll-state.js";
import { assessNextTendayLabor } from "../../engines/labor/labor-consequences.js";
import { foodProvisionModeOptions, foodProvisionWarning, normalizeFoodProvisionMode } from "../../data/food-provision.js";

const EMPLOYMENT_MODE_LABELS = Object.freeze({
  permanent: "Постоянный",
  seasonal: "Сезонный",
  "day-labor": "Подённый"
});

const EMPLOYMENT_SEASON_LABELS = Object.freeze({
  spring: "Весна",
  summer: "Лето",
  autumn: "Осень",
  winter: "Зима"
});

const FREE_RESIDENT_ASSIGNMENTS = new Set(["", "free", "unassigned", "child", "свободен", "без работы", "ребенок", "ребёнок"]);

const LABOR_CONTRACT_REASON_LABELS = Object.freeze({
  active: "Договор активен",
  dependent: "Иждивение: труд не предусмотрен",
  "missing-wage-class": "Не выбран класс ставки Economy V2",
  "invalid-contract-term": "Неверный срок оплачиваемого договора",
  "missing-current-qd": "Не определена дата следующего десятника",
  "missing-season": "Не определён сезон следующего десятника",
  "before-contract": "Договор ещё не начался",
  "after-contract": "Договор завершён",
  "inactive-season": "Сезонный договор сейчас неактивен",
  "missing-share-rate": "Не задана положительная доля результата",
  "volunteer-missing-reason": "Не указана причина добровольной работы",
  "volunteer-missing-term": "Не задан конечный срок добровольной работы",
  "volunteer-invalid-term": "Неверный срок добровольной работы",
  "volunteer-not-started": "Добровольная работа ещё не началась",
  "volunteer-expired": "Срок добровольной работы завершён",
  "coerced-missing-basis": "Не указано основание принудительного труда",
  "unknown-compensation-type": "Неизвестный тип договора"
});

const LABOR_EVENT_RISK_DESCRIPTIONS = Object.freeze({
  "volunteer-fatigue": "Усталость добровольца: возможны просьба об отдыхе или отказ продолжать работу.",
  "coerced-labor-unrest": "Принудительный труд: высок риск сопротивления, побега или открытого конфликта.",
  "payroll-arrears-unrest": "Долгая просрочка оплаты: возможен трудовой спор, отказ от работы или уход.",
  "hunger-crisis": "Продолжительный голод: возможны болезнь, уход жителей или продовольственный конфликт."
});

const LABOR_RISK_LEVEL_LABELS = Object.freeze({ low: "низкий", medium: "средний", high: "высокий" });

function laborPercent(value) {
  const numeric = Number(value);
  return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(numeric) ? numeric : 0)) * 100)}%`;
}

function signedLaborValue(value) {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : 0;
  return `${safe > 0 ? "+" : ""}${String(safe).replace(".", ",")}`;
}

function contractStateText(assessment = {}) {
  const reason = String(assessment?.contract?.reason ?? "");
  const label = LABOR_CONTRACT_REASON_LABELS[reason] ?? `Состояние договора: ${reason || "не определено"}`;
  if (assessment?.blocked) return `Заблокировано: ${label}`;
  if (!assessment?.contractValid) return `Нужно исправить: ${label}`;
  if (!assessment?.contractActive) return label;
  if (assessment?.physicalReason && assessment.physicalReason !== "available") return `${label}; житель физически недоступен`;
  if (!assessment?.assignedAsWorker) return `${label}; рабочего назначения нет`;
  return label;
}

function laborRiskRows(risks = []) {
  return risks.map((risk) => {
    const id = String(risk?.id ?? "");
    const level = String(risk?.level ?? "low");
    const levelLabel = LABOR_RISK_LEVEL_LABELS[level] ?? level;
    const description = LABOR_EVENT_RISK_DESCRIPTIONS[id] ?? `Социальный риск: ${id || "не определён"}.`;
    return { ...risk, id, level, levelLabel, description: `${description} Уровень: ${levelLabel}.` };
  });
}

export const ResidentDomain = {
_prepareRows(holding, canEdit, activeTab = "overview", options = {}) {
  if (!holding) return { people: [], buildings: [], special: [], cemetery: [], storage: [] };

  const rows = { people: [], buildings: [], special: [], cemetery: [], storage: [] };
  const tab = String(activeTab ?? "overview");
  const canEditBuildings = Boolean(options?.canEditBuildings ?? canEdit);

  // The manager can contain hundreds of residents/resources and many production
  // lines. Preparing every tab on every render was the main source of UI lag.
  // Only prepare the rows that the active template branch can actually render.
  if (tab === "people") {
    rows.people = this._preparePersonRows(holding, canEdit, "living", true);
  }

  if (tab === "buildings") rows.buildings = this._prepareBuildingRows(holding, canEditBuildings, options);

  if (tab === "special" || tab === "defense") {
    const decorate = (sourceRows) => (sourceRows ?? []).map((row, index) => ({ ...row, _index: index }));
    rows.special = decorate(holding.special?.list).filter((row) => {
      if (canEdit) return true;
      return row.visibility !== "gm";
    }).map((row) => ({ ...row, isGmOnly: row.visibility === "gm" }));
    rows.cemetery = this._preparePersonRows(holding, canEdit, "cemetery", false);
  }

  return rows;
},

_preparePersonRows(holding, canEdit = false, mode = "living", applyFilters = true) {
  const housingIndex = this._residentHousingIndex(holding);
  const workOptionsContext = this._residentWorkOptionsContext(holding);
  const workAssignments = this._peopleWorkAssignments(holding, workOptionsContext);
  const laborState = holding?.gm?.economy?.labor ?? {};
  const wageIndex = normalizeWageIndex(laborState.wageIndex);
  const payrollState = normalizePayrollState(laborState.payroll);
  const lastQd = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)));
  let laborPeriod = { targetQd: lastQd + 40, season: "" };
  try {
    const localPeriod = this._employmentPeriodContext?.(holding, 40) ?? null;
    if (localPeriod) {
      laborPeriod = {
        targetQd: Math.max(0, Math.floor(this._safeNumber(localPeriod.targetQd, lastQd + 40))),
        season: String(localPeriod.targetSeason ?? localPeriod.currentSeason ?? "").trim().toLocaleLowerCase("en")
      };
    }
  } catch (_error) {}
  const medicalIds = new Set();
  try {
    const assignments = this._medicalAssignments?.(holding);
    for (const entry of assignments?.values?.() ?? []) {
      for (const patient of entry?.patients ?? []) medicalIds.add(String(patient?.id ?? ""));
    }
  } catch (_error) {}
  const people = (holding?.people?.list ?? []).map((row, index) => {
    const morale = this._calculatePersonMorale(row, holding, { housingIndex });
    const traits = this._parseTraits(row.traitsText ?? row.traits);
    const badges = this._traitBadges(row.traitsText ?? row.traits);
    const noteTooltip = this._personNote(row);
    const displayBadges = badges.map((badge) => {
      const name = String(badge?.name ?? "").trim();
      return {
        ...badge,
        shortLabel: name.slice(0, 1).toUpperCase() || "?"
      };
    });
    const isChild = this._isChildResident(row);
    const rawWorkLabel = workAssignments.get(String(row.id)) || row.role || "";
    const workLabel = rawWorkLabel && !["Свободен", "Без работы"].includes(String(rawWorkLabel)) ? rawWorkLabel : (isChild ? "Ребенок" : (rawWorkLabel || "Без работы"));
    const injuredDays = Math.max(0, this._safeNumber(row.injuredDays, 0));
    const isInjured = this._isResidentInjured(row);
    const inMedicalCare = injuredDays > 0 && medicalIds.has(String(row.id ?? ""));
    const compensationWarning = compensationContractWarning(row);
    const provisionWarning = foodProvisionWarning(row);
    const personId = String(row.id ?? "");
    const payrollAccount = payrollState.accounts[personId] ?? null;
    const assignmentKey = String(row.workAssignment ?? "").trim().toLocaleLowerCase("ru");
    const assignedAsWorker = !FREE_RESIDENT_ASSIGNMENTS.has(assignmentKey);
    const laborAssessment = assessNextTendayLabor(row, {
      currentQd: laborPeriod.targetQd,
      season: laborPeriod.season,
      payrollAccount,
      hungerStreak: row.hungerStreakTendays,
      assignedAsWorker,
      living: !row.dead,
      child: isChild,
      injured: isInjured
    });
    const arrearsComponent = laborAssessment.components.find((component) => component.id === "arrears");
    const hungerComponent = laborAssessment.components.find((component) => component.id === "hunger");
    const laborRisks = laborRiskRows(laborAssessment.eventRisks);
    const laborProjectionAttention = laborAssessment.blocked
      || laborAssessment.contractValid === false
      || (assignedAsWorker && laborAssessment.laborFactor < 1)
      || (arrearsComponent?.streakTendays ?? 0) > 0
      || (hungerComponent?.streakTendays ?? 0) > 0
      || laborRisks.length > 0;
    const laborProjectionClass = laborAssessment.blocked
      ? "is-blocked"
      : (laborProjectionAttention ? "has-risk" : "is-ready");
    const laborProjectionBadgeClass = laborAssessment.blocked
      ? "is-danger"
      : (laborProjectionAttention ? "is-warning" : "is-success");
    const wageClass = WAGE_CATALOG.find((entry) => entry.id === String(row.wageClassId ?? "")) ?? null;
    const wageClassOptions = [
      { value: "", label: "Не выбран (старый договор)", selected: !wageClass },
      ...WAGE_CATALOG.map((entry) => ({
        value: entry.id,
        label: `${entry.label} — ${this._formatCopperCurrency(wageCopperPerTenday(entry.id, { wageIndex }))} / десятник`,
        selected: entry.id === wageClass?.id
      }))
    ];
    return {
      ...row,
      _index: index,
      ageGroup: this._ageGroup(row),
      ageLine: this._ageLine(row),
      raceLine: this._raceLine(row),
      workLabel,
      dead: Boolean(row.dead),
      injured: isInjured,
      injuredDays,
      injuredBadgeClass: inMedicalCare ? "in-care" : "untreated",
      injuredText: injuredDays > 0 ? String(injuredDays) : "",
      injuredTitle: inMedicalCare ? `Лежит в лазарете: ${injuredDays} дн.` : `Ранен: ${injuredDays} дн.`,
      deadClass: row.dead ? "dead" : (isInjured ? "injured" : "living"),
      deathLine: row.dead ? (row.deathDate ? `Погиб: ${row.deathDate}` : "Погиб") : "",
      homeLabel: this._homeLabel(row, holding, housingIndex),
      homeOptions: this._homeOptions(holding, row.home, housingIndex),
      workOptions: this._workOptions(holding, row, workOptionsContext),
      isCustomWork: this._isCustomWork(row, holding, workOptionsContext),
      cultureOptions: this._cultureOptions(row.culture),
      beliefOptions: this._beliefOptions(row.belief),
      backgroundOptions: socialBackgroundOptions(row.background),
      compensationOptions: compensationTypeOptions(row.compensationType),
      compensationTypeLabel: compensationTypeLabel(row.compensationType),
      cashWageDaily: personCashWageDaily(row),
      boardFoodDaily: personBoardFoodDaily(row),
      foodProvisionMode: normalizeFoodProvisionMode(row.foodProvisionMode, { boardFoodDaily: row.boardFoodDaily }),
      foodProvisionOptions: foodProvisionModeOptions(row),
      foodProvisionWarning: provisionWarning,
      hasFoodProvisionWarning: Boolean(provisionWarning),
      shareRate: personShareRate(row),
      baseWageDailyText: this._formatNumber?.(row.baseWageDaily ?? 0) ?? String(row.baseWageDaily ?? 0),
      compensationWarning,
      hasCompensationWarning: Boolean(compensationWarning),
      wageClassOptions,
      wageClassLabel: wageClass?.label ?? "Старый договор",
      employmentModeOptions: EMPLOYMENT_MODE_IDS.map((value) => ({
        value,
        label: EMPLOYMENT_MODE_LABELS[value] ?? value,
        selected: value === String(row.employmentMode ?? "permanent")
      })),
      employmentSeasonOptions: EMPLOYMENT_SEASON_IDS.map((key) => ({
        key,
        label: EMPLOYMENT_SEASON_LABELS[key] ?? key,
        checked: row.employmentSeasonMask?.[key] === true
      })),
      employmentContractStartQdValue: row.employmentContractStartQd ?? "",
      employmentContractEndQdValue: row.employmentContractEndQd ?? "",
      employmentTariffText: wageClass
        ? this._formatCopperCurrency(wageCopperPerTenday(wageClass.id, { wageIndex }))
        : "—",
      wageIndexText: this._formatNumber?.(wageIndex) ?? String(wageIndex),
      payrollArrearsCopper: payrollAccount?.arrearsCopper ?? 0,
      payrollArrearsText: this._formatCopperCurrency(payrollAccount?.arrearsCopper ?? 0),
      payrollOverdueTendays: payrollAccount?.overdueTendays ?? 0,
      hasPayrollArrears: (payrollAccount?.arrearsCopper ?? 0) > 0,
      isVolunteerContract: String(row.compensationType ?? "") === "volunteer",
      isCoercedContract: String(row.compensationType ?? "") === "coerced",
      volunteerTermStartQdValue: row.volunteerTermStartQd ?? "",
      volunteerTermEndQdValue: row.volunteerTermEndQd ?? "",
      hungerStreakTendays: Math.max(0, Math.floor(this._safeNumber(row.hungerStreakTendays, 0))),
      laborAssessment,
      laborContractStateId: String(laborAssessment.contract?.reason ?? ""),
      laborContractStateText: contractStateText(laborAssessment),
      laborProjectionClass,
      laborProjectionBadgeClass,
      laborProjectionAttention,
      laborProjectionBadgeText: laborAssessment.blocked ? "труд забл." : laborPercent(laborAssessment.laborFactor),
      laborProjectionFactorText: laborPercent(laborAssessment.laborFactor),
      laborProjectionMoraleText: signedLaborValue(laborAssessment.moraleDelta),
      laborProjectionDescription: laborAssessment.description,
      laborProjectionQd: laborAssessment.evaluationQd,
      laborProjectionSeasonText: EMPLOYMENT_SEASON_LABELS[laborAssessment.season] ?? (laborAssessment.season || "не определён"),
      laborAssignmentText: assignedAsWorker ? "есть основное назначение" : "нет рабочего назначения",
      laborArrearsStepText: arrearsComponent?.description ?? "Просрочка оплаты: труд 100%, довольство +0.",
      laborHungerStepText: hungerComponent?.description ?? "Голод: труд 100%, довольство +0.",
      laborProjectionBlockers: laborAssessment.blockers,
      hasLaborProjectionBlockers: laborAssessment.blockers.length > 0,
      laborProjectionRisks: laborRisks,
      hasLaborProjectionRisks: laborRisks.length > 0,
      traitsBrief: traits.length ? traits.join(", ") : "—",
      traitBadges: displayBadges,
      traitOptions: traitOptions(traits),
      hasTraitBadges: badges.length > 0,
      noteTooltip,
      workerTypeLabel: this._workerType(row),
      workerTypeStyle: this._workerTypeStyle(row),
      attributeSummary: this._attributeSummary(row),
      moraleValue: morale.total,
      moraleTooltip: morale.breakdown.join("\n"),
      searchText: [row.name, this._raceLine(row), row.culture, this._workerType(row), workLabel, this._homeLabel(row, holding, housingIndex), traits.join(" "), row.belief, row.background, compensationTypeLabel(row.compensationType), row.compensationNote, row.volunteerReason, row.coercionBasis, contractStateText(laborAssessment)]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" "),
      editing: canEdit && row.id === this.editingPersonId
    };
  }).filter((row) => mode === "cemetery" ? Boolean(row.dead) : !row.dead);
  return applyFilters ? this._filterPeopleRows(people) : people;
},

_prepareSpecialTabs(holding) {
  const people = holding?.people?.list ?? [];
  const dead = people.filter((person) => person?.dead).length;
  const records = holding?.special?.list?.length ?? 0;
  const vessels = holding?.special?.fleet?.vessels?.filter((vessel) => vessel?.status !== "archived" && (game.user?.isGM || vessel?.visibility !== "gm"))?.length ?? 0;
  const active = ["records", "fleet", "cemetery"].includes(this.activeSpecialTab) ? this.activeSpecialTab : "records";
  return [
    { id: "records", label: "Записи", icon: "fa-solid fa-sparkles", count: records, tabCount: records, active: active === "records" },
    { id: "fleet", label: "Корабли", icon: "fa-solid fa-ship", count: vessels, tabCount: vessels, active: active === "fleet" },
    { id: "cemetery", label: "Кладбище", icon: "fa-solid fa-skull", count: dead, tabCount: dead, active: active === "cemetery" }
  ];
},

_prepareFleetCards(holding) {
  const activeVesselId = String(holding?.special?.fleet?.activeVesselId ?? "");
  return (holding?.special?.fleet?.vessels ?? [])
    .filter((vessel) => vessel?.status !== "archived" && (game.user?.isGM || vessel?.visibility !== "gm"))
    .map((vessel) => {
      const voyage = vessel?.activeVoyage ?? null;
      const gross = Math.max(0, Number(voyage?.outboundRevenueCopper) || 0) + Math.max(0, Number(voyage?.returnRevenueCopper) || 0);
      const cost = Math.max(0, Number(voyage?.operatingCostCopper) || 0);
      const location = String(vessel?.position?.locationLabel ?? "").trim()
        || (String(vessel?.position?.dockedAtHoldingId ?? "") === String(holding?.id ?? "") ? holding.name : "Местоположение не указано");
      const condition = Math.min(
        Math.max(0, Number(vessel?.condition?.hull) || 0),
        Math.max(0, Number(vessel?.condition?.lift) || 0),
        Math.max(0, Number(vessel?.condition?.machinery) || 0)
      );
      return {
        ...vessel,
        active: String(vessel.id ?? "") === activeVesselId,
        statusLabel: VESSEL_STATUSES[vessel.status] ?? vessel.status,
        location,
        condition,
        cashText: this._formatCopperCurrency(vessel?.finances?.cashCopper ?? 0),
        availableText: this._formatCopperCurrency(fleetVesselAvailableCopper(vessel)),
        hasVoyage: Boolean(voyage),
        voyageTitle: voyage?.title ?? "",
        voyageEta: voyage ? `ETA QD ${voyage.etaQd}` : "",
        voyageResultText: voyage ? this._formatCopperCurrency(gross - cost - Math.max(0, Number(voyage?.replacementReserveCopper) || 0)) : ""
      };
    });
},

_squadTypeDefs() {
  return {
    line: { label: "Линейная пехота", tag: "Пехота", icon: "fa-solid fa-person-rifle", counterTag: "infantry", attrs: ["strength", "agility"], min: { strength: 3, agility: 3 }, hint: "Универсальный строй. Нужны Сила 3+ и Ловкость 3+. Эффективность идет от Силы и Ловкости." },
    fusiliers: { label: "Фузилеры", tag: "Огневые", icon: "fa-solid fa-bullseye", counterTag: "shooters", attrs: ["agility"], min: { strength: 3, agility: 4 }, hint: "Линейный стрелковый отряд. Нужны Сила 3+ и Ловкость 4+. Эффективность идет от Ловкости." },
    jaegers: { label: "Егеря", tag: "Егеря", icon: "fa-solid fa-eye", counterTag: "skirmishers", attrs: ["agility", "wits"], min: { strength: 3, agility: 4, wits: 3 }, hint: "Легкая пехота, разведчики и охотники. Нужны Сила 3+, Ловкость 4+ и Разум 3+. Эффективность идет от Ловкости и Разума." },
    grenadiers: { label: "Гренадеры", tag: "Тяжелые", icon: "fa-solid fa-shield-halved", counterTag: "heavy", attrs: ["strength"], min: { strength: 4, agility: 3 }, hint: "Отборные штурмовики. Нужны Сила 4+ и Ловкость 3+. Эффективность идет от Силы." },
    sappers: { label: "Саперы", tag: "Саперы", icon: "fa-solid fa-hammer", counterTag: "sappers", attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, hint: "Инженерный отряд. Нужны Сила 3+, Ловкость 3+ и Разум 4+. Эффективность идет от Разума." },
    artillery: { label: "Артиллерийская команда", tag: "Осадные", icon: "fa-solid fa-tower-observation", counterTag: "siege", attrs: ["wits"], min: { strength: 3, agility: 3, wits: 4 }, hint: "Расчет тяжелого оружия. Нужны Сила 3+, Ловкость 3+ и Разум 4+. Эффективность идет от Разума." },
    cavalry: { label: "Драгуны / конные", tag: "Мобильные", icon: "fa-solid fa-horse", counterTag: "mobile", attrs: ["agility"], min: { strength: 3, agility: 4 }, hint: "Быстрый отряд для вылазок и погони. Нужны Сила 3+ и Ловкость 4+. Эффективность идет от Ловкости." }
  };
},

_isMilitaryBackgroundResident(person = {}) {
  const text = String(person?.background ?? "").toLowerCase();
  return /(солдат|ветеран|на[её]мник|страж|сторож|дозор|егерь|дезертир|канонир|артиллер|сап[её]р|тюремщик|палач|телохранитель|ополчен|мушкет|развед)/i.test(text);
},

_isCommanderCandidate(person = {}) {
  if (!this._isSoldierResident(person) || this._isResidentInjured(person) || person?.dead) return false;
  const attrs = person?.attributes ?? {};
  return this._safeNumber(attrs.wits, 0) >= 5 && this._isMilitaryBackgroundResident(person);
},

_defenseRenderContext(holding) {
  const livingPeople = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const activePeople = livingPeople.filter((person) => !this._isResidentInjured(person));
  return {
    livingPeople,
    activePeople,
    peopleById: new Map(livingPeople.map((person) => [String(person?.id ?? ""), person])),
    filteredCache: new Map(),
    efficiencyCache: new Map()
  };
},

_cachedSoldierEfficiency(person, squadType = "line", renderContext = null) {
  const id = String(person?.id ?? "");
  const key = `${id}|${String(squadType ?? "line")}`;
  if (id && renderContext?.efficiencyCache?.has(key)) return renderContext.efficiencyCache.get(key);
  const value = this._soldierEfficiency(person, squadType);
  if (id && renderContext?.efficiencyCache) renderContext.efficiencyCache.set(key, value);
  return value;
},

_defensePersonOptions(holding, selected = "", { soldiersOnly = false, sergeantsOnly = false, commandersOnly = false, excludedIds = [], squadType = "line", renderContext = null } = {}) {
  const current = String(selected ?? "");
  const excluded = new Set((excludedIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  renderContext = renderContext ?? this._defenseRenderContext(holding);
  const cacheKey = `${soldiersOnly ? 1 : 0}|${sergeantsOnly ? 1 : 0}|${commandersOnly ? 1 : 0}|${String(squadType ?? "line")}`;
  if (!renderContext.filteredCache.has(cacheKey)) {
    renderContext.filteredCache.set(cacheKey, renderContext.activePeople.filter((person) => {
      const hasProfession = this._hasSoldierProfession?.(person) === true;
      if (commandersOnly) return hasProfession && !this._isChildResident?.(person);
      if (sergeantsOnly) return hasProfession && this._isSergeantCandidate(person) && this._isSuitableForSquadType(person, squadType);
      if (soldiersOnly) return hasProfession && this._isSuitableForSquadType(person, squadType);
      return this._isSuitableForSquadType(person, squadType);
    }));
  }
  const filtered = renderContext.filteredCache.get(cacheKey);
  const options = [{ value: "", label: "—", selected: !current }];
  for (const person of filtered) {
    const id = String(person.id);
    if (excluded.has(id) && current !== id) continue;
    const attrs = person?.attributes ?? {};
    const eff = this._cachedSoldierEfficiency(person, squadType, renderContext);
    const text = [person?.type, person?.workerType, person?.role, person?.background, person?.traits, person?.notes].map((value) => String(value ?? "").toLowerCase()).join(" ");
    const commanderEff = commandersOnly
      ? Math.min(3, Math.max(0,
        (this._safeNumber(attrs.wits, 0) >= 5 || /команд|началь|офиц|тактик|стратег|разум|мыслител|писарь|уч[её]н|воевод|капитан/i.test(text) ? 1 : 0)
        + (this._isMilitaryBackgroundResident(person) || this._isSoldierResident(person) ? 1 : 0)
        + (/лидер|вожд|команд|офиц|капитан|тактик|стратег|авторитет|харизм|дисциплин/i.test(text) ? 1 : 0)))
      : 0;
    const label = commandersOnly
      ? `${person.name || "Без имени"} · ком. ${commanderEff}/3 · +${commanderEff * 7}%`
      : `${person.name || "Без имени"} · эфф. ${this._formatNumber ? this._formatNumber(eff) : eff}${this._isSergeantCandidate(person) ? " · сержант" : ""}`;
    options.push({ value: id, label, selected: current === id, disabled: false });
  }
  if (current && !options.some((item) => item.value === current) && !(soldiersOnly || sergeantsOnly || commandersOnly)) {
    const person = renderContext.peopleById.get(current);
    options.push({ value: current, label: `${person?.name || current} (недоступен для типа отряда)`, selected: true });
  }
  return options;
},

_defenseAssignmentIds(holding) {
  const ids = [];
  const defense = holding?.gm?.defense ?? {};
  if (defense.commanderId) ids.push(String(defense.commanderId));
  for (const squad of Array.isArray(defense.squads) ? defense.squads : []) {
    if (squad?.sergeantId) ids.push(String(squad.sergeantId));
    for (const id of (Array.isArray(squad?.memberIds) ? squad.memberIds : []).slice(0, 4)) if (id) ids.push(String(id));
  }
  return ids;
},

_sanitizeDefenseAssignments(holding) {
  const defense = holding?.gm?.defense;
  if (!defense || !Array.isArray(defense.squads)) return false;
  let changed = false;
  const people = new Map((holding?.people?.list ?? []).map((person) => [String(person.id), person]));
  const used = new Set();
  const commanderId = String(defense.commanderId ?? "");
  if (commanderId) {
    const commander = people.get(commanderId);
    if (!commander || !this._hasSoldierProfession?.(commander) || this._isChildResident?.(commander) || this._isResidentInjured(commander) || commander.dead) {
      defense.commanderId = "";
      changed = true;
    } else used.add(commanderId);
  }
  for (const squad of defense.squads) {
    let squadType = String(squad?.type ?? "line");
    if (squadType === "militia") { squadType = "line"; squad.type = "line"; changed = true; }
    const isAllowed = (id) => {
      const person = people.get(String(id));
      return person && this._hasSoldierProfession?.(person) && this._isSuitableForSquadType(person, squadType) && !this._isChildResident?.(person) && !this._isResidentInjured(person) && !person.dead;
    };
    const first = String(squad?.sergeantId ?? "");
    if (first && (!isAllowed(first) || used.has(first))) { squad.sergeantId = ""; changed = true; }
    else if (first) used.add(first);
    const members = (Array.isArray(squad.memberIds) ? squad.memberIds : []).slice(0, 4);
    while (members.length < 4) members.push("");
    for (let i = 0; i < members.length; i += 1) {
      const id = String(members[i] ?? "");
      if (!id) { members[i] = ""; continue; }
      if (!isAllowed(id) || used.has(id)) { members[i] = ""; changed = true; }
      else { used.add(id); members[i] = id; }
    }
    squad.memberIds = members;
  }
  return changed;
},

_defenseContext(holding) {
  const defense = holding?.gm?.defense ?? {};
  const renderContext = this._defenseRenderContext(holding);
  const peopleById = renderContext.peopleById;
  const typeDefs = this._squadTypeDefs();
  const soldierCount = renderContext.activePeople.filter((person) => this._isSoldierResident(person)).length;
  const commanderId = String(defense.commanderId ?? "");
  const commander = peopleById.get(commanderId);
  const allAssignedIds = this._defenseAssignmentIds(holding);
  const squadsSource = Array.isArray(defense.squads) ? defense.squads : [];
  const squads = squadsSource.map((squad, index) => {
    const memberIds = (Array.isArray(squad.memberIds) ? squad.memberIds : []).slice(0, 4);
    const firstSlotId = String(squad.sergeantId ?? "");
    const combatantIds = [firstSlotId, ...memberIds.map((id) => String(id ?? ""))].filter(Boolean);
    const uniqueCombatantIds = [...new Set(combatantIds)];
    const combatants = uniqueCombatantIds.map((id) => peopleById.get(id)).filter(Boolean);
    const squadType = String(squad.type ?? "line") === "militia" ? "line" : String(squad.type ?? "line");
    let effective = combatants.reduce((sum, person) => sum + this._cachedSoldierEfficiency(person, squadType, renderContext), 0);
    const firstSlotPerson = peopleById.get(firstSlotId);
    const hasSergeant = Boolean(firstSlotPerson && this._isSergeantCandidate(firstSlotPerson));
    if (hasSergeant) effective += 0.5;
    if (!Number.isFinite(Number(effective))) effective = 0;
    const equipped = Boolean(squad.equipped);
    const full = combatants.length >= 5 || effective >= 5;
    const counted = equipped && full && effective >= 5;
    const type = typeDefs[squadType] ?? typeDefs.line;
    const excludedForSquad = allAssignedIds.filter((id) => !combatantIds.includes(String(id)));
    return {
      ...squad,
      _index: index,
      label: squad.name || `${index + 1}-й ${type.label.toLowerCase()}`,
      typeLabel: type.label,
      typeTag: type.tag,
      typeIcon: type.icon ?? "fa-solid fa-shield-halved",
      typeKey: type.counterTag ?? "infantry",
      typeHint: type.hint,
      typeOptions: Object.entries(typeDefs).map(([value, data]) => ({ value, label: data.label, selected: squadType === value })),
      firstSlotOptions: this._defensePersonOptions(holding, squad.sergeantId, { soldiersOnly: true, excludedIds: excludedForSquad, squadType, renderContext }),
      firstSlotName: firstSlotPerson?.name ?? "—",
      firstSlotRoleLabel: hasSergeant ? "Сержант" : "Солдат",
      memberSlots: Array.from({ length: 4 }, (_, slot) => {
        const id = String(memberIds[slot] ?? "");
        const person = peopleById.get(id);
        const excludedForSlot = allAssignedIds.filter((assignedId) => String(assignedId) !== id);
        return { slot, slotNo: slot + 2, id, personName: person?.name ?? "", options: this._defensePersonOptions(holding, id, { soldiersOnly: true, excludedIds: excludedForSlot, squadType, renderContext }) };
      }),
      memberCount: combatants.length,
      effectiveText: this._formatNumber ? this._formatNumber(effective) : String(Math.round(effective * 10) / 10),
      effective,
      hasSergeant,
      equipped,
      full,
      counted,
      statusText: counted ? (hasSergeant ? "учитывается, сержант" : "учитывается") : (!equipped ? "нет вооружения" : (!full ? "неполный" : "эффективность < 5")),
      statusClass: counted ? "ok" : "warning"
    };
  });
  const countedEffective = squads.filter((s) => s.counted).reduce((sum, s) => sum + Number(s.effective || 0), 0);
  const effectiveUnits = Math.floor(countedEffective / 5);
  return {
    commanderId,
    commanderName: commander?.name ?? "—",
    commanderOptions: this._defensePersonOptions(holding, commanderId, { commandersOnly: true, excludedIds: allAssignedIds.filter((id) => String(id) !== commanderId), renderContext }),
    squads,
    hasSquads: squads.length > 0,
    soldierCount,
    countedEffectiveText: this._formatNumber ? this._formatNumber(countedEffective) : String(Math.round(countedEffective * 10) / 10),
    effectiveUnits,
    squadTypeSummary: Object.values(typeDefs).map((item) => `${item.label}: ${item.tag}`).join(" · "),
    equipmentCostText: "Ориентир: 1 отряд из 5 человек = 60–90 СМ за простое оружие и амуницию; фузилеры/ружья = 150–250 СМ; артиллерийская команда с орудием = от 600 СМ.",
    defenseHelpText: `Командир выбирается отдельно от отрядов: любой живой взрослый житель. Он не дает плоских кубов; его эффективность 0-3 дает +7%/+14%/+21% к боевой мощи армии. Эффективность: Разум/управленческий тип, военное прошлое, лидерские черты. Сержантом считается только солдат с военным социальным прошлым и любой характеристикой 5+. ${Object.values(typeDefs).map((item) => `${item.label}: ${item.tag}`).join(" · ")}. Первый слот отряда — сержант или обычный солдат; всего в отряде 5 бойцов. Один житель не может занимать несколько слотов. Недоукомплектованные и неэкипированные отряды не считаются.`
  };
},

_preparePeopleTabs(holding) {
  const people = holding?.people?.list ?? [];
  const living = people.filter((person) => !person?.dead).length;
  return [
    { id: "living", label: "Жители", icon: "fa-solid fa-users", count: living, active: true }
  ];
},

_filterPeopleRows(people) {
  const filters = this.residentFilters ?? {};
  const type = String(filters.type ?? "all");
  const work = String(filters.work ?? "all");
  const home = String(filters.home ?? "all");
  const morale = String(filters.morale ?? "all");

  return people.filter((person) => {
    if (type !== "all" && person.workerTypeLabel !== type) return false;
    if (work === "free" && !["Без работы", "Свободен", "Ребенок"].includes(person.workLabel)) return false;
    if (work === "assigned" && ["Без работы", "Свободен", "Ребенок"].includes(person.workLabel)) return false;
    if (home === "homeless" && !this._isNoHome(person.homeLabel)) return false;
    if (home === "housed" && this._isNoHome(person.homeLabel)) return false;
    if (morale === "negative" && this._safeNumber(person.moraleValue, 0) >= 0) return false;
    if (morale === "neutral" && this._safeNumber(person.moraleValue, 0) !== 0) return false;
    if (morale === "positive" && this._safeNumber(person.moraleValue, 0) <= 0) return false;
    return true;
  });
},

_cultureOptions(current = "") {
  const selected = String(current ?? "");
  const options = ["", ...CULTURE_NAMES].map((value) => ({
    value,
    label: value || "Не указано",
    selected: value === selected
  }));
  if (selected && !options.some((item) => item.value === selected)) options.push({ value: selected, label: selected, selected: true });
  return options;
},

_beliefOptions(current = "") {
  const selected = String(current ?? "");
  const values = ["", "Ржавый", "Младой", "Тримунэлия", "Рамбар", "Багровая Щука", "Народные святыни", "Скепсис", "Культ предков", "Народные духи", "Культ предков", "Другое"];
  const unique = Array.from(new Set(values));
  const options = unique.map((value) => ({ value, label: value || "Не указано", selected: value === selected }));
  if (selected && !options.some((item) => item.value === selected)) options.push({ value: selected, label: selected, selected: true });
  return options;
},

_residentWorkOptionsContext(holding) {
  const allBuildings = holding?.buildings?.list ?? [];
  const crews = this._constructionCrews(holding);
  const vessels = (holding?.special?.fleet?.vessels ?? []).filter((vessel) => vessel?.status !== "archived");
  const availableBuildingIds = new Set();
  const availableVesselIds = new Set();
  const buildingRoleNames = new Set();

  for (const building of allBuildings) {
    const id = String(building?.id ?? "");
    const name = String(building?.name ?? "").trim();
    if (name) buildingRoleNames.add(name);
    const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
    const assigned = Array.isArray(building?.assignedWorkerIds)
      ? building.assignedWorkerIds.reduce((count, value) => count + (value ? 1 : 0), 0)
      : 0;
    if (id && max > 0 && assigned < max) availableBuildingIds.add(id);
  }

  for (const vessel of vessels) {
    const id = String(vessel?.id ?? "");
    const target = Math.max(0, this._safeNumber(vessel?.profile?.crewTarget, 0));
    const assigned = new Set((vessel?.crew?.memberIds ?? []).map((value) => String(value ?? "")).filter(Boolean)).size;
    if (id && target > 0 && assigned < target) availableVesselIds.add(id);
  }

  return { allBuildings, crews, vessels, availableBuildingIds, availableVesselIds, buildingRoleNames, buildingOptionsCache: new Map() };
},

_residentWorkOptionBuildings(context, selected = "") {
  const key = String(selected ?? "");
  if (context.buildingOptionsCache.has(key)) return context.buildingOptionsCache.get(key);
  const buildings = context.allBuildings.filter((building) => {
    const id = String(building?.id ?? "");
    return id && (key === id || context.availableBuildingIds.has(id));
  });
  context.buildingOptionsCache.set(key, buildings);
  return buildings;
},

_workOptions(holding, person = {}, workContext = null) {
  const selected = String(person?.workAssignment ?? "");
  const role = String(person?.role ?? "").trim();
  const context = workContext ?? this._residentWorkOptionsContext(holding);
  const isChild = this._isChildResident(person);
  const canWork = this._canResidentWork(person);
  const freeLabel = isChild ? "Ребенок" : "Свободен";
  const buildings = canWork ? this._residentWorkOptionBuildings(context, selected) : [];
  const crews = canWork ? context.crews : [];
  const vessels = canWork ? (context.vessels ?? []).filter((vessel) => {
    const id = String(vessel?.id ?? "");
    return selected === `fleet:${id}` || context.availableVesselIds?.has(id);
  }) : [];
  const options = [
    { value: "", label: freeLabel, selected: !selected && (!role || role === "Свободен" || role === "Без работы" || role === "Ребенок") },
    ...crews.map((crew) => ({
      value: `construction:${crew.id}`,
      label: crew.name || "Стройбригада",
      selected: selected === `construction:${crew.id}` || (selected === "construction" && crew.isDefault)
    })),
    ...vessels.map((vessel) => ({
      value: `fleet:${vessel.id}`,
      label: `Экипаж: ${vessel.name || "корабль"}`,
      selected: selected === `fleet:${vessel.id}`
    })),
    ...buildings.map((building) => ({
      value: String(building.id),
      label: building.name || "Без названия",
      selected: selected === String(building.id)
    }))
  ];
  if (canWork) options.push({ value: "soldier", label: "Солдат", selected: selected === "soldier" || (!selected && /^солдат$/i.test(role)) });
  if (canWork || selected === "other") options.push({ value: "other", label: "Другое", selected: selected === "other" || (!selected && role && !["Свободен", "Без работы", "Ребенок"].includes(role) && !/^солдат$/i.test(role) && !context.buildingRoleNames.has(role)) });
  return options;
},

_isCustomWork(person = {}, holding = null, workContext = null) {
  const selected = String(person?.workAssignment ?? "");
  if (selected === "other") return true;
  if (selected) return false;
  const role = String(person?.role ?? "").trim();
  if (!role || role === "Свободен" || role === "Без работы" || role === "Ребенок") return false;
  const context = workContext ?? this._residentWorkOptionsContext(holding);
  return !context.buildingRoleNames.has(role);
},

_beliefSummary(holding) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const counts = new Map();
  for (const person of people) {
    const belief = normalizeBelief(person?.belief || "Не указано") || "Не указано";
    counts.set(belief, (counts.get(belief) ?? 0) + 1);
  }
  const total = people.length || 0;
  const entries = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  const top = entries[0] ?? ["Нет данных", 0];
  const topPercent = total ? Math.round((top[1] / total) * 100) : 0;
  const label = total && topPercent >= 60 ? top[0] : (total ? "Смешанная" : "Нет данных");
  const tooltip = entries.length
    ? entries.map(([name, count]) => `${name}: ${count}/${total} (${Math.round((count / total) * 100)}%)`).join("\n")
    : "Жителей нет.";
  return { label, tooltip, total, topPercent };
},

_residentFilterOptions(holding) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const types = Array.from(new Set(people.map((person) => this._workerType(person)).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ru"));
  const currentType = this.residentFilters?.type ?? "all";
  return {
    types: [
      { value: "all", label: "Все типы", selected: currentType === "all" },
      ...types.map((type) => ({ value: type, label: type, selected: currentType === type }))
    ],
    work: [
      { value: "all", label: "Любая работа", selected: (this.residentFilters?.work ?? "all") === "all" },
      { value: "free", label: "Свободные", selected: this.residentFilters?.work === "free" },
      { value: "assigned", label: "Назначенные", selected: this.residentFilters?.work === "assigned" }
    ],
    home: [
      { value: "all", label: "Любое жилье", selected: (this.residentFilters?.home ?? "all") === "all" },
      { value: "housed", label: "С домом", selected: this.residentFilters?.home === "housed" },
      { value: "homeless", label: "Без дома", selected: this.residentFilters?.home === "homeless" }
    ],
    morale: [
      { value: "all", label: "Любое довольство", selected: (this.residentFilters?.morale ?? "all") === "all" },
      { value: "negative", label: "Минус", selected: this.residentFilters?.morale === "negative" },
      { value: "neutral", label: "Ноль", selected: this.residentFilters?.morale === "neutral" },
      { value: "positive", label: "Плюс", selected: this.residentFilters?.morale === "positive" }
    ]
  };
},

_peopleWorkAssignments(holding, workContext = null) {
  const map = new Map();
  const buildings = workContext?.allBuildings ?? (holding?.buildings?.list ?? []);
  const buildingsById = new Map(buildings.map((building) => [String(building.id), building]));
  const crews = workContext?.crews ?? this._constructionCrews(holding);
  const crewsById = new Map(crews.map((crew) => [String(crew.id), crew]));
  const vessels = workContext?.vessels ?? (holding?.special?.fleet?.vessels ?? []);
  const vesselsById = new Map(vessels.map((vessel) => [String(vessel?.id ?? ""), vessel]));
  for (const person of holding?.people?.list ?? []) {
    if (person?.dead) continue;
    const id = String(person?.id ?? "");
    const selected = String(person?.workAssignment ?? "");
    if (!id) continue;
    if (selected === "construction") map.set(id, crews[0]?.name || "Стройбригада");
    else if (selected.startsWith("construction:")) {
      const crewId = selected.split(":")[1] || "";
      map.set(id, crewsById.get(crewId)?.name || "Стройбригада");
    }
    else if (selected === "other") map.set(id, String(person?.role ?? "").trim() || "Другое");
    else if (selected.startsWith("fleet:")) {
      const vesselId = selected.slice("fleet:".length);
      map.set(id, `Экипаж: ${vesselsById.get(vesselId)?.name || vesselId || "корабль"}`);
    }
    else if (selected && buildingsById.has(selected)) map.set(id, buildingsById.get(selected)?.name || "Здание");
    else if (person?.role) map.set(id, String(person.role));
  }
  for (const crew of crews) {
    const name = String(crew?.name ?? "Стройбригада").trim() || "Стройбригада";
    for (const id of crew?.memberIds ?? []) if (id) map.set(String(id), name);
  }
  for (const building of buildings) {
    const name = String(building?.name ?? "").trim();
    if (!name) continue;
    for (const id of building?.assignedWorkerIds ?? []) {
      if (id) map.set(String(id), name);
    }
  }
  for (const vessel of vessels) {
    const name = `Экипаж: ${String(vessel?.name ?? "корабль").trim() || "корабль"}`;
    for (const id of vessel?.crew?.memberIds ?? []) if (id) map.set(String(id), name);
  }
  return map;
},

_raceLine(person) {
  const race = String(person?.race ?? "").trim();
  const subrace = String(person?.subrace ?? "").trim();
  if (race && subrace && subrace !== "-") return `${race} / ${subrace}`;
  return race || subrace || "—";
},

_ageGroup(person) {
  return ageGroupFromAge(person?.age, person?.race, person?.subrace);
},

_ageLine(person) {
  const age = this._safeNumber(person?.age, null);
  const group = this._ageGroup(person);
  return age === null ? group : `${age} · ${group}`;
},

_isResidentInjured(person = {}) {
  return this._safeNumber(person?.injuredDays, 0) > 0;
},

_isChildResident(person = {}) {
  return String(person?.ageGroup ?? ageGroupFromAge(person?.age, person?.race, person?.subrace) ?? "") === "Ре";
},

_canResidentWork(person = {}) {
  if (!person || person.dead || this._isResidentInjured(person)) return false;
  if (!this._isChildResident(person)) return true;
  return this._safeNumber(person?.age, 0) >= 12;
},

_childWorkThreshold(person = {}) {
  const thresholds = ageThresholdsFor(raceKeyFromResident(person));
  return Math.min(Math.max(0, Math.floor(this._safeNumber(thresholds?.young, 18)) - 1), 12);
},

_isMilitaryResidentLike(person = {}) {
  const text = [person?.role, person?.skill, person?.background, person?.traitsText, person?.status, person?.notes]
    .map((value) => String(value ?? "").toLowerCase()).join(" ");
  return /(солдат|сержант|командир|офицер|страж|ветеран|наемник|наёмник|ополчен|дозор|егерь|разведчик|мушкет|канонир|сап[её]р|тюремщик|охран|guard|soldier|sergeant|officer|veteran|mercenary|ranger|scout|musketeer|gunner|sapper)/i.test(text);
},

_hasSoldierProfession(person = {}) {
  return String(person?.workAssignment ?? "") === "soldier" || /^\s*(солдат|сержант)\b/i.test(String(person?.role ?? ""));
},

_isSoldierResident(person = {}) {
  if (this._hasSoldierProfession?.(person)) return true;
  const text = [person?.role, person?.skill, person?.background, person?.traitsText, person?.status, person?.notes]
    .map((value) => String(value ?? "").toLowerCase()).join(" ");
  return /(солдат|страж|гвард|мушкет[её]р|фузил[её]р|егерь|ветеран|наемник|наёмник|канонир|сап[её]р|guard|soldier|musketeer|fusilier|jaeger|rifle|veteran|mercenary|gunner|sapper)/i.test(text);
},

_isSergeantCandidate(person = {}) {
  if (!this._isSoldierResident(person) || this._isResidentInjured(person) || person?.dead) return false;
  if (!this._isMilitaryBackgroundResident(person)) return false;
  const attrs = person?.attributes ?? {};
  return [attrs.strength, attrs.agility, attrs.wits, attrs.empathy].some((value) => this._safeNumber(value, 0) >= 5);
},

_isSuitableForSquadType(person = {}, squadType = "line") {
  const profile = this._squadTypeDefs()[String(squadType)] ?? this._squadTypeDefs().line;
  const attrs = person?.attributes ?? {};
  for (const [key, min] of Object.entries(profile.min ?? {})) {
    if (this._safeNumber(attrs[key], 0) < this._safeNumber(min, 0)) return false;
  }
  return true;
},

_soldierEfficiency(person = {}, squadType = "line") {
  if (!this._isSuitableForSquadType(person, squadType)) return 0;
  const profile = this._squadTypeDefs()[String(squadType)] ?? this._squadTypeDefs().line;
  const attrs = person?.attributes ?? {};
  const keys = Array.isArray(profile.attrs) && profile.attrs.length ? profile.attrs : ["strength", "agility"];
  let value = 1;
  for (const key of keys) {
    const score = this._safeNumber(attrs[key], 0);
    value += score >= 5 ? 0.35 : score >= 4 ? 0.15 : 0;
  }
  const clean = Math.min(1.7, Number(value));
  return Number.isFinite(clean) ? clean : 0;
},

_attributeSummary(person) {
  return attributeSummary(person?.attributes ?? {});
},

_workerType(person) {
  return workerTypeFromAttributes(person?.attributes ?? {});
},

_workerTypeStyle(person) {
  return workerTypeStyleFromAttributes(person?.attributes ?? {});
},

_personNote(person) {
  const notes = String(person?.notes ?? "").trim();
  const appearance = String(person?.appearance ?? "").trim();
  const background = String(person?.background ?? "").trim();
  const culture = String(person?.culture ?? "").trim();
  const belief = String(person?.belief ?? "").trim();
  const hiddenBits = [];
  if (culture) hiddenBits.push(`Культура: ${culture}`);
  if (belief) hiddenBits.push(`Верование: ${belief}`);
  if (this._safeNumber(person?.injuredDays, 0) > 0) hiddenBits.push(`Ранен: ${this._safeNumber(person.injuredDays, 0)} дн.`);
  if (background) hiddenBits.push(`Прошлое: ${background}`);
  if (appearance) hiddenBits.push(`Внешность: ${appearance}`);
  if (notes) hiddenBits.push(notes);
  return hiddenBits.join("\n");
},

_personDetails(person) {
  const details = [];
  const push = (label, value) => {
    const text = String(value ?? "").trim();
    if (text) details.push({ label, value: text });
  };

  push("Статус", person?.dead ? "Погиб" : person?.status);
  if (person?.dead) {
    push("Дата гибели", person?.deathDate);
    push("Причина гибели", person?.deathNote);
  }
  push("Верование", person?.belief);
  push("Социальное прошлое", person?.background);
  push("Культура", person?.culture);
  push("Характеристики", this._attributeSummary(person));
  push("Внешность", person?.appearance);
  push("Actor", person?.actorUuid);
  push("Заметки", person?.notes);
  return details;
},

_isNoHome(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || ["без жилья", "без дома", "нет дома", "нет жилья", "—", "-"].includes(text);
},

_homeLabel(person, holding = null, housingIndex = null) {
  if (this._isNoHome(person?.home)) return "Без дома";
  const match = this._findHomeBuilding(holding, person?.home, housingIndex);
  return match?.name ? String(match.name) : String(person?.home ?? "").trim();
},

_housingMorale(person, holding = null, housingIndex = null) {
  if (person?.dead) return { value: 0, reason: "погиб" };
  if (this._isNoHome(person?.home)) return { value: -3, reason: "без дома" };
  const home = this._findHomeBuilding(holding, person?.home, housingIndex);
  if (!home) return { value: -1, reason: "жилье не найдено" };
  let comfort = this._safeNumber(home?.housing?.comfort, 0);
  const homeText = `${home?.name ?? ""} ${home?.type ?? ""} ${home?.notes ?? ""} ${home?.effect ?? ""}`;
  if (comfort < 0 && /казарм|barrack/i.test(homeText) && this._isMilitaryResidentLike(person)) comfort = 0;
  const capacity = this._safeNumber(home?.housing?.capacity, 0);
  const occupied = this._housingOccupants(holding, home, housingIndex).length;
  const crowding = capacity > 0 && occupied > capacity ? -1 : 0;
  const parts = [];
  if (comfort) parts.push(`комфорт ${comfort > 0 ? "+" : ""}${comfort}`);
  if (crowding) parts.push("переполнено");
  return { value: comfort + crowding, reason: parts.join(", ") };
},

_homeOptions(holding, currentHome = "", housingIndex = null) {
  const current = String(currentHome ?? "").trim();
  const byValue = new Map();
  byValue.set("", { value: "", label: "Без дома", selected: this._isNoHome(current) });

  const hasIndexedBuildings = Array.isArray(housingIndex?.residentialBuildings);
  const buildings = hasIndexedBuildings ? housingIndex.residentialBuildings : (holding?.buildings?.list ?? []);
  for (const building of buildings) {
    if (!hasIndexedBuildings && !this._isResidentialBuilding(building)) continue;
    const id = String(building?.id ?? "").trim();
    const name = String(building?.name ?? "").trim();
    if (!id || !name || byValue.has(id)) continue;
    const capacity = this._safeNumber(building?.housing?.capacity, 0);
    const occupied = this._housingOccupants(holding, building, housingIndex).length;
    const isSelected = current === id || current === name;
    if (capacity > 0 && occupied >= capacity && !isSelected) continue;
    const load = capacity > 0 ? ` ${occupied}/${capacity}` : ` ${occupied}/∞`;
    byValue.set(id, { value: id, label: `${name}${load}`, selected: isSelected });
  }

  if (current && !this._isNoHome(current) && !Array.from(byValue.values()).some((item) => item.selected)) {
    byValue.set(current, { value: current, label: `${current} (вне списка)`, selected: true });
  }

  return Array.from(byValue.values());
},

_isResidentialBuilding(building) {
  if (!buildingOperationalState(building).operational) return false;
  if (building?.functions?.housing) return true;

  const text = [
    building?.name,
    building?.type,
    building?.status,
    building?.effect,
    building?.notes,
    building?.location
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");

  if (/строится|руин|разруш|снесен|не постро/i.test(text)) return false;
  return /(дом|жиль|жил|палаточ|лагер|казарм|барак|общежит|хижин|комнат|кают)/i.test(text);
},

_residentHousingIndex(holding) {
  const buildingsByKey = new Map();
  const residentialBuildings = [];
  const occupantsByBuildingKey = new Map();

  const buildingKey = (building) => String(building?.id ?? "").trim() || String(building?.name ?? "").trim();
  for (const building of holding?.buildings?.list ?? []) {
    const id = String(building?.id ?? "").trim();
    const name = String(building?.name ?? "").trim();
    if (id && !buildingsByKey.has(id)) buildingsByKey.set(id, building);
    if (name && !buildingsByKey.has(name)) buildingsByKey.set(name, building);
    if (this._isResidentialBuilding(building)) residentialBuildings.push(building);
  }

  for (const person of holding?.people?.list ?? []) {
    if (person?.dead) continue;
    const home = String(person?.home ?? "").trim();
    if (!home) continue;
    const building = buildingsByKey.get(home);
    if (!building) continue;
    const key = buildingKey(building);
    if (!key) continue;
    if (!occupantsByBuildingKey.has(key)) occupantsByBuildingKey.set(key, []);
    occupantsByBuildingKey.get(key).push(person);
  }

  return { buildingsByKey, residentialBuildings, occupantsByBuildingKey };
},

_findHomeBuilding(holding, value = "", housingIndex = null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const indexed = housingIndex?.buildingsByKey?.get(text);
  if (indexed) return indexed;
  return (holding?.buildings?.list ?? []).find((building) => String(building?.id ?? "") === text || String(building?.name ?? "") === text) ?? null;
},

_housingOccupants(holding, building, housingIndex = null) {
  const id = String(building?.id ?? "");
  const name = String(building?.name ?? "");
  const key = String(id).trim() || String(name).trim();
  if (key && housingIndex?.occupantsByBuildingKey) return housingIndex.occupantsByBuildingKey.get(key) ?? [];
  return (holding?.people?.list ?? []).filter((person) => !person?.dead && (String(person?.home ?? "") === id || String(person?.home ?? "") === name));
},

_moraleSnapshot(holding) {
  if (!holding) return calculateMoraleSnapshot();

  const housingIndex = this._residentHousingIndex(holding);
  const settlementModifiers = [];

  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    const scale = String(building?.moraleScale ?? "legacy").trim().toLocaleLowerCase("en") === "normalized" ? 1 : 0.1;
    const value = this._safeNumber(building?.moraleDelta, 0) * scale;
    if (!value) continue;
    settlementModifiers.push({
      id: `building:${String(building?.id ?? building?.name ?? settlementModifiers.length)}`,
      label: String(building?.name ?? "Здание"),
      value
    });
  }

  for (const row of holding?.special?.list ?? []) {
    const type = String(row?.type ?? "").toLowerCase();
    const name = String(row?.name ?? "").toLowerCase();
    const isModifier = (type.includes("модификатор") || name.includes("модификатор")) && (type.includes("доволь") || name.includes("доволь"));
    if (!isModifier && row?.includeInMorale !== true && row?.countsForMorale !== true) continue;
    const scale = String(row?.moraleScale ?? "legacy").trim().toLocaleLowerCase("en") === "normalized" ? 1 : 0.1;
    const value = this._safeNumber(row?.value ?? row?.moraleDelta, 0) * scale;
    if (!value) continue;
    settlementModifiers.push({
      id: `special:${String(row?.id ?? row?.name ?? settlementModifiers.length)}`,
      label: String(row?.name ?? "Особый модификатор"),
      value
    });
  }

  const gmMoraleScale = String(holding?.gm?.modifiers?.moraleScale ?? "legacy").trim().toLocaleLowerCase("en") === "normalized" ? 1 : 0.1;
  const gmMorale = (this._gmSettlementModifiers?.(holding)?.morale ?? this._safeNumber(holding?.gm?.modifiers?.morale, 0)) * gmMoraleScale;
  if (gmMorale) settlementModifiers.push({ id: "gm", label: "Модификатор ГМ", value: gmMorale });

  const commonTableMorale = this._safeNumber(holding?.gm?.economy?.commonTable?.activeMoraleBonus, 0) > 0 ? 1 : 0;
  if (commonTableMorale) settlementModifiers.push({ id: "common-table", label: "Общий стол", value: commonTableMorale });

  return calculateMoraleSnapshot({
    residents: holding?.people?.list ?? [],
    residentScore: (person) => this._calculatePersonMorale(person, holding, { housingIndex }),
    settlementModifiers
  });
},

_calculateMorale(holding) {
  return this._moraleSnapshot(holding).score;
},

_calculatePersonMorale(person, holding = null, options = {}) {
  if (person?.dead) return { total: 0, breakdown: ["Погиб: довольство не считается"] };
  const housingIndex = options?.housingIndex ?? null;
  const base = this._safeNumber(person?.moraleBase, -1);
  const workManual = this._safeNumber(person?.moraleWork, 0);
  const workAuto = this._workMorale(person, holding);
  const work = workManual + workAuto.value;
  const homeManual = this._safeNumber(person?.moraleHome, 0);
  const homeAuto = this._housingMorale(person, holding, housingIndex);
  const home = homeManual + homeAuto.value;
  const manual = this._safeNumber(person?.moraleManual, 0);
  const traits = this._traitMoraleModifier(person);
  const contract = this._compensationMorale(person, holding);
  const total = base + work + home + traits.value + manual + contract.value;

  const breakdown = [
    `Итог: ${total}`,
    `База: ${base}`,
    `Работа: ${work}${workAuto.reason ? ` (${workAuto.reason})` : ""}`,
    `Жилье: ${home}${homeAuto.reason ? ` (${homeAuto.reason})` : ""}`
  ];
  if (traits.value) breakdown.push(`Черты: ${traits.value} (${traits.reasons.join(", ")})`);
  else breakdown.push("Черты: 0");
  if (manual) breakdown.push(`Ручной модификатор: ${manual}`);
  if (contract.value) breakdown.push(`Договор: ${contract.value} (${contract.reasons.join(", ")})`);
  else breakdown.push("Договор: 0");

  return { total, breakdown };
},

_compensationMorale(person = {}, holding = null) {
  let value = 0;
  const reasons = [];
  const laborState = holding?.gm?.economy?.labor ?? {};
  const payrollState = normalizePayrollState(laborState.payroll);
  const personId = String(person?.id ?? "");
  const lastQd = Math.max(0, Math.floor(this._safeNumber(holding?.gm?.calendaria?.lastQd, 0)));
  let targetQd = lastQd + 40;
  let season = "";
  try {
    const period = this._employmentPeriodContext?.(holding, 40) ?? null;
    if (period) {
      targetQd = Math.max(0, Math.floor(this._safeNumber(period.targetQd, targetQd)));
      season = String(period.targetSeason ?? period.currentSeason ?? "").trim().toLocaleLowerCase("en");
    }
  } catch (_error) {}
  const assignment = String(person?.workAssignment ?? "").trim().toLocaleLowerCase("ru");
  const assessment = assessNextTendayLabor(person, {
    currentQd: targetQd,
    season,
    payrollAccount: payrollState.accounts[personId] ?? null,
    hungerStreak: person?.hungerStreakTendays,
    assignedAsWorker: !FREE_RESIDENT_ASSIGNMENTS.has(assignment),
    living: !person?.dead,
    child: this._isChildResident(person),
    injured: this._isResidentInjured(person)
  });
  value += assessment.moraleDelta;
  for (const component of assessment.components ?? []) {
    if (!component.moraleDelta) continue;
    reasons.push(`${component.label}: ${component.moraleDelta > 0 ? "+" : ""}${component.moraleDelta}`);
  }
  const home = String(person.home ?? "").trim();
  if (person.housingProvided && (!home || /без жилья|нет жилья|homeless/i.test(home))) {
    value -= 1;
    reasons.push("обещанное жильё не предоставлено");
  }
  return { value, reasons };
},

_traitMoraleModifier(person) {
  return traitMorale(person?.traitsText ?? person?.traits);
},

_traitBadges(value) {
  return traitBadges(value);
},

_hasTrait(person, name) {
  const needle = String(name ?? "").trim().toLowerCase();
  return this._parseTraits(person?.traitsText ?? person?.traits).some((trait) => trait.toLowerCase() === needle);
},

_parseTraits(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "")
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
},

_moraleState(value) {
  const snapshot = value && typeof value === "object" ? value : null;
  const morale = Number(snapshot?.score ?? snapshot?.value ?? value ?? 0);
  if (!Number.isFinite(morale)) {
    return { value: "?", label: "Неизвестно", range: "", notes: "Значение довольства не распознано." };
  }
  const band = snapshot?.band ?? moraleBandForScore(morale);
  const formula = snapshot
    ? `Среднее ${snapshot.livingCount ?? 0} живых жителей: ${snapshot.residentAverage ?? 0}; общие эффекты: ${snapshot.settlementModifier >= 0 ? "+" : ""}${snapshot.settlementModifier ?? 0}; итог: ${morale}.`
    : `Итог: ${morale}.`;
  return {
    value: morale,
    score: morale,
    bandId: band.id,
    label: band.label,
    range: band.range,
    icon: band.icon,
    css: band.css,
    notes: band.notes,
    formula,
    tooltip: `${band.label} (${band.range}). ${formula} ${band.notes}`,
    modifiers: band.modifiers,
    residentAverage: snapshot?.residentAverage,
    settlementModifier: snapshot?.settlementModifier,
    livingCount: snapshot?.livingCount
  };
}
};
