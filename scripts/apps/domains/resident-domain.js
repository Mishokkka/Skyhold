// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { traitBadges, traitMorale, traitOptions } from "../../generators/trait-definitions.js";
import { CULTURE_NAMES } from "../../generators/name-pools.js";
import { ageGroupFromAge, ageThresholdsFor, attributeSummary, normalizeBelief, raceKeyFromResident, socialBackgroundOptions, workerTypeFromAttributes, workerTypeStyleFromAttributes } from "../../generators/resident-rules.js";

export const ResidentDomain = {
_prepareRows(holding, canEdit, activeTab = "overview", options = {}) {
  if (!holding) return { people: [], buildings: [], special: [], cemetery: [], storage: [] };

  const rows = { people: [], buildings: [], special: [], cemetery: [], storage: [] };
  const tab = String(activeTab ?? "overview");
  const canEditBuildings = Boolean(options?.canEditBuildings ?? canEdit);
  const activePeopleTab = String(options?.activePeopleTab ?? "living");

  // The manager can contain hundreds of residents/resources and many production
  // lines. Preparing every tab on every render was the main source of UI lag.
  // Only prepare the rows that the active template branch can actually render.
  if (tab === "people") {
    rows.people = this._preparePersonRows(holding, canEdit, "living", true);
  }

  if (tab === "buildings") rows.buildings = this._prepareBuildingRows(holding, canEditBuildings);

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
  const workAssignments = this._peopleWorkAssignments(holding);
  const medicalIds = new Set();
  try {
    const assignments = this._medicalAssignments?.(holding);
    for (const entry of assignments?.values?.() ?? []) {
      for (const patient of entry?.patients ?? []) medicalIds.add(String(patient?.id ?? ""));
    }
  } catch (_error) {}
  const people = (holding?.people?.list ?? []).map((row, index) => {
    const morale = this._calculatePersonMorale(row, holding);
    const traits = this._parseTraits(row.traitsText ?? row.traits);
    const badges = this._traitBadges(row.traitsText ?? row.traits);
    const noteTooltip = this._personNote(row);
    const detailsItems = this._personDetails(row);
    const isChild = this._isChildResident(row);
    const rawWorkLabel = workAssignments.get(String(row.id)) || row.role || "";
    const workLabel = rawWorkLabel && !["Свободен", "Без работы"].includes(String(rawWorkLabel)) ? rawWorkLabel : (isChild ? "Ребенок" : (rawWorkLabel || "Без работы"));
    const injuredDays = Math.max(0, this._safeNumber(row.injuredDays, 0));
    const inMedicalCare = injuredDays > 0 && medicalIds.has(String(row.id ?? ""));
    return {
      ...row,
      _index: index,
      ageGroup: this._ageGroup(row),
      ageLine: this._ageLine(row),
      raceLine: this._raceLine(row),
      workLabel,
      dead: Boolean(row.dead),
      injured: this._isResidentInjured(row),
      injuredDays,
      injuredBadgeClass: inMedicalCare ? "in-care" : "untreated",
      injuredText: injuredDays > 0 ? String(injuredDays) : "",
      injuredTitle: inMedicalCare ? `Лежит в лазарете: ${injuredDays} дн.` : `Ранен: ${injuredDays} дн.`,
      deadClass: row.dead ? "dead" : (this._isResidentInjured(row) ? "injured" : "living"),
      deathLine: row.dead ? (row.deathDate ? `Погиб: ${row.deathDate}` : "Погиб") : "",
      homeLabel: this._homeLabel(row, holding),
      homeOptions: this._homeOptions(holding, row.home),
      workOptions: this._workOptions(holding, row),
      isCustomWork: this._isCustomWork(row, holding),
      cultureOptions: this._cultureOptions(row.culture),
      beliefOptions: this._beliefOptions(row.belief),
      backgroundOptions: socialBackgroundOptions(row.background),
      traitsBrief: traits.length ? traits.join(", ") : "—",
      traitBadges: badges,
      traitOptions: traitOptions(traits),
      hasTraitBadges: badges.length > 0,
      noteTooltip,
      workerTypeLabel: this._workerType(row),
      workerTypeStyle: this._workerTypeStyle(row),
      attributeSummary: this._attributeSummary(row),
      moraleValue: morale.total,
      moraleTooltip: morale.breakdown.join("\n"),
      expanded: row.id === this.expandedPersonId,
      detailsItems,
      hasDetails: detailsItems.length > 0,
      editing: canEdit && row.id === this.editingPersonId
    };
  }).filter((row) => mode === "cemetery" ? Boolean(row.dead) : !row.dead);
  return applyFilters ? this._filterPeopleRows(people) : people;
},

_prepareSpecialTabs(holding) {
  const people = holding?.people?.list ?? [];
  const dead = people.filter((person) => person?.dead).length;
  const records = holding?.special?.list?.length ?? 0;
  const defense = holding?.gm?.defense ?? {};
  const defenseCount = (Array.isArray(defense.squads) ? defense.squads.length : 0) + (defense.commanderId ? 1 : 0);
  const active = ["records", "cemetery"].includes(this.activeSpecialTab) ? this.activeSpecialTab : "records";
  return [
    { id: "records", label: "Записи", icon: "fa-solid fa-sparkles", count: records, tabCount: records, active: active === "records" },
    { id: "cemetery", label: "Кладбище", icon: "fa-solid fa-skull", count: dead, tabCount: dead, active: active === "cemetery" }
  ];
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

_defensePersonOptions(holding, selected = "", { soldiersOnly = false, sergeantsOnly = false, commandersOnly = false, excludedIds = [], squadType = "line" } = {}) {
  const current = String(selected ?? "");
  const excluded = new Set((excludedIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead && !this._isResidentInjured(person));
  const filtered = people.filter((person) => {
    const hasProfession = this._hasSoldierProfession?.(person) === true;
    if (commandersOnly) return hasProfession && !this._isChildResident?.(person);
    if (sergeantsOnly) return hasProfession && this._isSergeantCandidate(person) && this._isSuitableForSquadType(person, squadType);
    if (soldiersOnly) return hasProfession && this._isSuitableForSquadType(person, squadType);
    return this._isSuitableForSquadType(person, squadType);
  });
  const options = [{ value: "", label: "—", selected: !current }];
  for (const person of filtered) {
    const id = String(person.id);
    if (excluded.has(id) && current !== id) continue;
    const attrs = person?.attributes ?? {};
    const eff = this._soldierEfficiency(person, squadType);
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
    const person = (holding?.people?.list ?? []).find((row) => String(row.id) === current);
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
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const typeDefs = this._squadTypeDefs();
  const soldierCount = people.filter((person) => this._isSoldierResident(person) && !this._isResidentInjured(person)).length;
  const commanderId = String(defense.commanderId ?? "");
  const commander = people.find((person) => String(person.id) === commanderId);
  const allAssignedIds = this._defenseAssignmentIds(holding);
  const squadsSource = Array.isArray(defense.squads) ? defense.squads : [];
  const squads = squadsSource.map((squad, index) => {
    const memberIds = (Array.isArray(squad.memberIds) ? squad.memberIds : []).slice(0, 4);
    const firstSlotId = String(squad.sergeantId ?? "");
    const combatantIds = [firstSlotId, ...memberIds.map((id) => String(id ?? ""))].filter(Boolean);
    const uniqueCombatantIds = [...new Set(combatantIds)];
    const combatants = uniqueCombatantIds.map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
    const squadType = String(squad.type ?? "line") === "militia" ? "line" : String(squad.type ?? "line");
    let effective = combatants.reduce((sum, person) => sum + this._soldierEfficiency(person, squadType), 0);
    const firstSlotPerson = people.find((person) => String(person.id) === firstSlotId);
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
      firstSlotOptions: this._defensePersonOptions(holding, squad.sergeantId, { soldiersOnly: true, excludedIds: excludedForSquad, squadType }),
      firstSlotName: firstSlotPerson?.name ?? "—",
      firstSlotRoleLabel: hasSergeant ? "Сержант" : "Солдат",
      memberSlots: Array.from({ length: 4 }, (_, slot) => {
        const id = String(memberIds[slot] ?? "");
        const person = people.find((row) => String(row.id) === id);
        const excludedForSlot = allAssignedIds.filter((assignedId) => String(assignedId) !== id);
        return { slot, slotNo: slot + 2, id, personName: person?.name ?? "", options: this._defensePersonOptions(holding, id, { soldiersOnly: true, excludedIds: excludedForSlot, squadType }) };
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
    commanderOptions: this._defensePersonOptions(holding, commanderId, { commandersOnly: true, excludedIds: allAssignedIds.filter((id) => String(id) !== commanderId) }),
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
  const search = String(filters.search ?? "").trim().toLowerCase();
  const type = String(filters.type ?? "all");
  const work = String(filters.work ?? "all");
  const home = String(filters.home ?? "all");
  const morale = String(filters.morale ?? "all");

  return people.filter((person) => {
    if (search) {
      const haystack = [person.name, person.raceLine, person.culture, person.workerTypeLabel, person.workLabel, person.homeLabel, person.traitsBrief, person.belief, person.background]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" ");
      if (!haystack.includes(search)) return false;
    }

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

_workOptions(holding, person = {}) {
  const selected = String(person?.workAssignment ?? "");
  const role = String(person?.role ?? "").trim();
  const allBuildings = holding?.buildings?.list ?? [];
  const isChild = this._isChildResident(person);
  const canWork = this._canResidentWork(person);
  const freeLabel = isChild ? "Ребенок" : "Свободен";
  const buildings = canWork ? allBuildings.filter((building) => {
    const buildingId = String(building?.id ?? "");
    const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
    if (selected === buildingId) return true;
    if (max <= 0) return false;
    const assigned = Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds.filter(Boolean).length : 0;
    return assigned < max;
  }) : [];
  const crews = canWork ? this._constructionCrews(holding) : [];
  const options = [
    { value: "", label: freeLabel, selected: !selected && (!role || role === "Свободен" || role === "Без работы" || role === "Ребенок") },
    ...crews.map((crew) => ({
      value: `construction:${crew.id}`,
      label: crew.name || "Стройбригада",
      selected: selected === `construction:${crew.id}` || (selected === "construction" && crew.isDefault)
    })),
    ...buildings.map((building) => ({
      value: String(building.id),
      label: building.name || "Без названия",
      selected: selected === String(building.id)
    }))
  ];
  if (canWork) options.push({ value: "soldier", label: "Солдат", selected: selected === "soldier" || (!selected && /^солдат$/i.test(role)) });
  if (canWork || selected === "other") options.push({ value: "other", label: "Другое", selected: selected === "other" || (!selected && role && !["Свободен", "Без работы", "Ребенок"].includes(role) && !/^солдат$/i.test(role) && !allBuildings.some((b) => b.name === role)) });
  return options;
},

_isCustomWork(person = {}, holding = null) {
  const selected = String(person?.workAssignment ?? "");
  if (selected === "other") return true;
  if (selected) return false;
  const role = String(person?.role ?? "").trim();
  if (!role || role === "Свободен" || role === "Без работы" || role === "Ребенок") return false;
  return !(holding?.buildings?.list ?? []).some((building) => building.name === role || String(building.id) === selected);
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

_peopleWorkAssignments(holding) {
  const map = new Map();
  const buildingsById = new Map((holding?.buildings?.list ?? []).map((building) => [String(building.id), building]));
  const crewsById = new Map(this._constructionCrews(holding).map((crew) => [String(crew.id), crew]));
  for (const person of holding?.people?.list ?? []) {
    if (person?.dead) continue;
    const id = String(person?.id ?? "");
    const selected = String(person?.workAssignment ?? "");
    if (!id) continue;
    if (selected === "construction") map.set(id, this._constructionCrews(holding)[0]?.name || "Стройбригада");
    else if (selected.startsWith("construction:")) {
      const crewId = selected.split(":")[1] || "";
      map.set(id, crewsById.get(crewId)?.name || "Стройбригада");
    }
    else if (selected === "other") map.set(id, String(person?.role ?? "").trim() || "Другое");
    else if (selected && buildingsById.has(selected)) map.set(id, buildingsById.get(selected)?.name || "Здание");
    else if (person?.role) map.set(id, String(person.role));
  }
  for (const crew of this._constructionCrews(holding)) {
    const name = String(crew?.name ?? "Стройбригада").trim() || "Стройбригада";
    for (const id of crew?.memberIds ?? []) if (id) map.set(String(id), name);
  }
  for (const building of holding?.buildings?.list ?? []) {
    const name = String(building?.name ?? "").trim();
    if (!name) continue;
    for (const id of building?.assignedWorkerIds ?? []) {
      if (id) map.set(String(id), name);
    }
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

_homeLabel(person, holding = null) {
  if (this._isNoHome(person?.home)) return "Без дома";
  const match = this._findHomeBuilding(holding, person?.home);
  return match?.name ? String(match.name) : String(person?.home ?? "").trim();
},

_housingMorale(person, holding = null) {
  if (person?.dead) return { value: 0, reason: "погиб" };
  if (this._isNoHome(person?.home)) return { value: -3, reason: "без дома" };
  const home = this._findHomeBuilding(holding, person?.home);
  if (!home) return { value: -1, reason: "жилье не найдено" };
  let comfort = this._safeNumber(home?.housing?.comfort, 0);
  const homeText = `${home?.name ?? ""} ${home?.type ?? ""} ${home?.notes ?? ""} ${home?.effect ?? ""}`;
  if (comfort < 0 && /казарм|barrack/i.test(homeText) && this._isMilitaryResidentLike(person)) comfort = 0;
  const capacity = this._safeNumber(home?.housing?.capacity, 0);
  const occupied = this._housingOccupants(holding, home).length;
  const crowding = capacity > 0 && occupied > capacity ? -1 : 0;
  const parts = [];
  if (comfort) parts.push(`комфорт ${comfort > 0 ? "+" : ""}${comfort}`);
  if (crowding) parts.push("переполнено");
  return { value: comfort + crowding, reason: parts.join(", ") };
},

_homeOptions(holding, currentHome = "") {
  const current = String(currentHome ?? "").trim();
  const byValue = new Map();
  byValue.set("", { value: "", label: "Без дома", selected: this._isNoHome(current) });

  for (const building of holding?.buildings?.list ?? []) {
    if (!this._isResidentialBuilding(building)) continue;
    const id = String(building?.id ?? "").trim();
    const name = String(building?.name ?? "").trim();
    if (!id || !name || byValue.has(id)) continue;
    const capacity = this._safeNumber(building?.housing?.capacity, 0);
    const occupied = this._housingOccupants(holding, building).length;
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
  const status = String(building?.constructionStatus ?? "").trim();
  if (status && status !== "built") return false;
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

_findHomeBuilding(holding, value = "") {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return (holding?.buildings?.list ?? []).find((building) => String(building?.id ?? "") === text || String(building?.name ?? "") === text) ?? null;
},

_housingOccupants(holding, building) {
  const id = String(building?.id ?? "");
  const name = String(building?.name ?? "");
  return (holding?.people?.list ?? []).filter((person) => !person?.dead && (String(person?.home ?? "") === id || String(person?.home ?? "") === name));
},

_calculateMorale(holding) {
  if (!holding) return 0;

  const people = holding.people?.list ?? [];
  const buildings = holding.buildings?.list ?? [];
  const special = holding.special?.list ?? [];

  const peopleMorale = people.reduce((sum, row) => sum + this._calculatePersonMorale(row, holding).total, 0);

  const buildingMorale = buildings.reduce((sum, row) => {
    if (this._buildingStatus(row).value !== "built") return sum;
    return sum + this._safeNumber(row.moraleDelta, 0);
  }, 0);

  const specialMorale = special.reduce((sum, row) => {
    const type = String(row.type ?? "").toLowerCase();
    const name = String(row.name ?? "").toLowerCase();
    const isModifier = (type.includes("модификатор") || name.includes("модификатор")) && (type.includes("доволь") || name.includes("доволь"));
    if (isModifier) return sum + this._safeNumber(row.value ?? row.moraleDelta, 0);
    if (row.includeInMorale === true || row.countsForMorale === true) return sum + this._safeNumber(row.value ?? row.moraleDelta, 0);
    return sum;
  }, 0);

  const gmMorale = this._gmSettlementModifiers?.(holding)?.morale ?? this._safeNumber(holding?.gm?.modifiers?.morale, 0);
  return peopleMorale + buildingMorale + specialMorale + gmMorale;
},

_calculatePersonMorale(person, holding = null) {
  if (person?.dead) return { total: 0, breakdown: ["Погиб: довольство не считается"] };
  const base = this._safeNumber(person?.moraleBase, -1);
  const workManual = this._safeNumber(person?.moraleWork, 0);
  const workAuto = this._workMorale(person, holding);
  const work = workManual + workAuto.value;
  const homeManual = this._safeNumber(person?.moraleHome, 0);
  const homeAuto = this._housingMorale(person, holding);
  const home = homeManual + homeAuto.value;
  const manual = this._safeNumber(person?.moraleManual, 0);
  const traits = this._traitMoraleModifier(person);
  const total = base + work + home + traits.value + manual;

  const breakdown = [
    `Итог: ${total}`,
    `База: ${base}`,
    `Работа: ${work}${workAuto.reason ? ` (${workAuto.reason})` : ""}`,
    `Жилье: ${home}${homeAuto.reason ? ` (${homeAuto.reason})` : ""}`
  ];
  if (traits.value) breakdown.push(`Черты: ${traits.value} (${traits.reasons.join(", ")})`);
  else breakdown.push("Черты: 0");
  if (manual) breakdown.push(`Ручной модификатор: ${manual}`);

  return { total, breakdown };
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
  const morale = Number(value ?? 0);
  if (!Number.isFinite(morale)) {
    return { value: "?", label: "Неизвестно", range: "", notes: "Значение довольства не распознано." };
  }

  if (morale < -30) {
    return { value: morale, label: "Бунты", range: "<-30", icon: "fa-solid fa-face-angry", css: "riot", notes: "В конце десятника возможны уход жителей или бунт. Строительство: -3." };
  }

  if (morale <= -15) {
    return { value: morale, label: "Недовольство", range: "-30 до -15", icon: "fa-solid fa-face-frown", css: "bad", notes: "Возможны уход жителей или кражи. Репутация и защищенность снижены. Строительство: -2. Уменьшите эффективность всех производящих зданий дополнительно на 0.3." };
  }

  if (morale < 0) {
    return { value: morale, label: "Апатия", range: "-14 до -1", icon: "fa-solid fa-face-meh", css: "low", notes: "Уменьшите защищенность и репутацию на 1. Уменьшите эффективность Стройбригад наполовину (округляя вверх). Уменьшите эффективность всех производящих зданий на 0.2." };
  }

  if (morale <= 15) {
    return { value: morale, label: "Без штрафов и бонусов", range: "0 до 15", icon: "fa-solid fa-face-smile", css: "neutral", notes: "Точка равновесия поселения." };
  }

  if (morale <= 30) {
    return { value: morale, label: "Надежда", range: "16 до 30", icon: "fa-solid fa-face-grin-stars", css: "hope", notes: "+1к8 раз за партию, +1 к найму, репутация и защищенность выше. Строительство: +1. Увеличьте эффективность всех производящих зданий на 0.2." };
  }

  return { value: morale, label: "Дом", range: ">30", icon: "fa-solid fa-face-laugh-beam", css: "home", notes: "Переброс строительства, снижение оплаты жителей, усиленная репутация и защищенность. Строительство: +2." };
}
};
