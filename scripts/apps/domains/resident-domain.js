import { specialMoraleModifier } from "../../core/special-effects.js";
import { residentLaborCapacity } from "../../data/labor-budget.js";
import { selectionSummary } from "../common/selection-summary.js";
import { residentTraitTooltip } from "../common/resident-trait-chips.js";
// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { traitBadges, traitMorale, traitOptions } from "../../generators/trait-definitions.js";
import { CULTURE_NAMES } from "../../generators/name-pools.js";
import { ageGroupFromAge, ageThresholdsFor, attributeSummary, normalizeBelief, raceKeyFromResident, socialBackgroundOptions, workerTypeFromAttributes, workerTypeStyleFromAttributes } from "../../generators/resident-rules.js";
import { buildingOperationalState } from "../../core/building-state.js";
import { resourceLabel } from "../../core/resources.js";
import {
  buildingConfirmedHarmActive,
  buildingConfirmedLeisureCapacity,
  buildingConfirmedServiceCapacity,
  buildingConfirmedSocialStatus,
  buildingHousingComfort,
  scaleIntegerBuildingEffect
} from "../../engines/economy/building-service.js";
import { settlementControlSummary } from "../../engines/settlement/control.js";
import { politicsRuntimeEffects } from "../../engines/politics/runtime-effects.js";
import { isResidentAway, residentShipAssignment, shipForResident, isResidentRestingOnShip, isResidentInPopulation } from "../../data/resident-presence.js";
import {
  COMMANDER_MIN_WITS,
  MANAGER_SQUAD_TYPE_PROFILES,
  residentSoldierEfficiency,
  residentSuitableForSquadType
} from "../../data/military-resident-rules.js";
import {
  buildWorkAllocationTargets,
  validateWorkAllocationPlan,
  WORK_ALLOCATION_MODE_EXPLICIT,
  workAllocationTargetKey
} from "../../data/work-allocations.js";

export const ResidentDomain = {
_prepareRows(holding, canEdit, activeTab = "overview", options = {}) {
  if (!holding) return { people: [], residentWorkOptionCatalog: [], buildings: [], special: [], cemetery: [], storage: [] };

  const rows = { people: [], residentWorkOptionCatalog: [], buildings: [], special: [], cemetery: [], storage: [] };
  const tab = String(activeTab ?? "overview");
  const canEditBuildings = Boolean(options?.canEditBuildings ?? canEdit);

  // The manager can contain hundreds of residents/resources and many production
  // lines. Preparing every tab on every render was the main source of UI lag.
  // Only prepare the rows that the active template branch can actually render.
  if (tab === "people") {
    const workOptionsContext = this._residentWorkOptionsContext(holding);
    const hasRestingCrew = (holding.people?.list ?? []).some((person) => isResidentRestingOnShip(person, holding));
    const mode = options.activePeopleTab === "ship-crew" && hasRestingCrew ? "ship-crew" : "residents";
    rows.people = this._preparePersonRows(holding, canEdit, mode, true, { workOptionsContext, editorPersonId: "" });
    rows.residentWorkOptionCatalog = canEdit ? this._residentWorkOptionCatalog(workOptionsContext) : [];
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

_preparePersonRows(holding, canEdit = false, mode = "living", applyFilters = true, options = {}) {
  const housingIndex = this._residentHousingIndex(holding);
  const workOptionsContext = options?.workOptionsContext ?? this._residentWorkOptionsContext(holding);
  const workAssignments = this._peopleWorkAssignments(holding, workOptionsContext);
  const medicalIds = new Set();
  try {
    const assignments = this._medicalAssignments?.(holding);
    for (const entry of assignments?.values?.() ?? []) {
      for (const patient of entry?.patients ?? []) medicalIds.add(String(patient?.id ?? ""));
    }
  } catch (_error) {}
  const sourceRows = (holding?.people?.list ?? [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => mode === "cemetery" ? Boolean(row?.dead) : !row?.dead)
    .filter(({ row }) => mode === "ship-crew" ? isResidentRestingOnShip(row, holding)
      : mode === "residents" ? !isResidentRestingOnShip(row, holding) : true);
  const people = [];
  const shipsById = new Map((holding?.special?.ships?.list ?? [])
    .map((ship) => [String(ship?.id ?? ""), ship])
    .filter(([id]) => id));
  let workAllocationTargets = null;
  let workAllocationTargetMap = null;

  for (const { row, index } of sourceRows) {
    const morale = this._calculatePersonMorale(row, holding, { housingIndex });
    const isChild = this._isChildResident(row);
    const canWork = this._canResidentWork(row, holding);
    const shipAssignment = residentShipAssignment(row);
    const awayOnShip = isResidentAway(row);
    const assignedShip = shipForResident(row, holding) ?? (awayOnShip ? shipsById.get(String(shipAssignment?.shipId ?? "")) : null);
    const restingOnShip = isResidentRestingOnShip(row, holding);
    const shipPresenceLabel = awayOnShip
      ? `На корабле «${String(assignedShip?.name || shipAssignment?.shipId || "неизвестный корабль")}»`
      : restingOnShip ? `Отдых на корабле «${assignedShip?.name || "корабль"}»` : "";
    const rawWorkLabel = workAssignments.get(String(row.id)) || row.role || "";
    const settlementWorkLabel = rawWorkLabel && !["Свободен", "Без работы"].includes(String(rawWorkLabel)) ? rawWorkLabel : (isChild ? "Ребенок" : (rawWorkLabel || "Без работы"));
    const workLabel = shipPresenceLabel || settlementWorkLabel;
    const homeLabel = this._homeLabel(row, holding, housingIndex);
    const workerTypeLabel = this._workerType(row);
    const injuredDays = Math.max(0, this._safeNumber(row.injuredDays, 0));
    const isInjured = this._isResidentInjured(row);
    const inMedicalCare = injuredDays > 0 && medicalIds.has(String(row.id ?? ""));
    const filterRow = { workerTypeLabel, workLabel, homeLabel, moraleValue: morale.total, restingOnShip };
    if (applyFilters && !this._personMatchesResidentFilters(filterRow)) continue;

    const traits = this._parseTraits(row.traitsText ?? row.traits);
    const badges = this._traitBadges(row.traitsText ?? row.traits);
    const noteTooltip = this._personNote(row);
    const displayBadges = badges.map((badge) => {
      const name = String(badge?.name ?? "").trim();
      return {
        ...badge,
        tooltip: residentTraitTooltip(badge),
        shortLabel: name.slice(0, 1).toUpperCase() || "?"
      };
    });
    const raceLine = this._raceLine(row);
    const editorPersonId = Object.hasOwn(options ?? {}, "editorPersonId")
      ? String(options.editorPersonId ?? "")
      : String(this.editingPersonId ?? "");
    const editing = canEdit && String(row.id ?? "") === editorPersonId;
    const prepared = {
      ...row,
      _index: index,
      ageGroup: this._ageGroup(row),
      ageLine: this._ageLine(row),
      raceLine,
      workLabel,
      awayOnShip,
      restingOnShip,
      transportBusy: Boolean(assignedShip?.transportOrderId),
      onBoardOnly: restingOnShip || awayOnShip,
      assignedShipId: assignedShip?.id ?? "",
      assignedShipName: assignedShip?.name ?? "",
      shipPresenceLabel,
      dead: Boolean(row.dead),
      injured: isInjured,
      injuredDays,
      injuredBadgeClass: inMedicalCare ? "in-care" : "untreated",
      injuredText: injuredDays > 0 ? String(injuredDays) : "",
      injuredTitle: inMedicalCare ? `Лежит в лазарете: ${injuredDays} дн.` : `Ранен: ${injuredDays} дн.`,
      deadClass: row.dead ? "dead" : (isInjured ? "injured" : "living"),
      deathLine: row.dead ? (row.deathDate ? `Погиб: ${row.deathDate}` : "Погиб") : "",
      homeLabel,
      traitsBrief: traits.length ? traits.join(", ") : "—",
      traitBadges: displayBadges,
      traitSelection: selectionSummary(displayBadges.map(badge => badge.name), "Черт нет"),
      hasTraitBadges: badges.length > 0,
      noteTooltip,
      workerTypeLabel,
      workerTypeStyle: this._workerTypeStyle(row),
      attributeSummary: this._attributeSummary(row),
      moraleValue: morale.total,
      moraleTooltip: morale.breakdown.join("\n"),
      searchText: [row.name, raceLine, row.culture, workerTypeLabel, workLabel, shipPresenceLabel, homeLabel, traits.join(" "), row.belief, row.background]
        .map((value) => String(value ?? "").toLowerCase())
        .join(" "),
      editing
    };

    if (canEdit) {
      const inlineWork = this._residentInlineWorkOption(row, workLabel, workOptionsContext);
      Object.assign(prepared, {
        workInlineValue: inlineWork.value,
        workInlineLabel: inlineWork.label,
        workFreeLabel: inlineWork.freeLabel,
        workCanAssign: inlineWork.canWork
      });
    }

    if (editing) {
      workAllocationTargets ??= buildWorkAllocationTargets(holding);
      workAllocationTargetMap ??= new Map(workAllocationTargets.map((target) => [target.key, target]));
      const laborCapacity = residentLaborCapacity(row);
      const normalWorkCap = canWork ? laborCapacity.normalQd : 0;
      const overtimeWorkCap = canWork ? laborCapacity.overtimeQd : 0;
      const workAllocationValidation = validateWorkAllocationPlan(row?.workAllocations, {
        targets: workAllocationTargetMap,
        maximumNormalQd: normalWorkCap,
        maximumOvertimeQd: overtimeWorkCap
      });
      const workAllocations = workAllocationValidation.rows.map((allocation, allocationIndex) => {
        const selectedKey = workAllocationTargetKey(allocation.sourceId, allocation.functionId);
        const targetOptions = workAllocationTargets.map((target) => ({
          value: target.key,
          label: target.label,
          selected: target.key === selectedKey,
          overtimeAllowed: canWork && !isChild && target.overtimeAllowed
        }));
        if (selectedKey && !workAllocationTargetMap.has(selectedKey)) {
          targetOptions.unshift({ value: selectedKey, label: `Недоступная функция (${selectedKey})`, selected: true, overtimeAllowed: false });
        }
        targetOptions.unshift({ value: "", label: "— Выберите функцию —", selected: !selectedKey, overtimeAllowed: false });
        return {
          ...allocation,
          _index: allocationIndex,
          selectedKey,
          targetOptions,
          overtimeAllowed: canWork && !isChild && Boolean(workAllocationTargetMap.get(selectedKey)?.overtimeAllowed)
        };
      });
      Object.assign(prepared, {
        homeOptions: this._homeOptions(holding, row.home, housingIndex),
        workOptions: this._workOptions(holding, row, workOptionsContext),
        workAllocationExplicit: String(row?.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT,
        workAllocationModeOptions: [
          { value: "legacy", label: "Одно основное назначение", selected: String(row?.workAllocationMode ?? "legacy") !== WORK_ALLOCATION_MODE_EXPLICIT },
          { value: WORK_ALLOCATION_MODE_EXPLICIT, label: "Явный план QD", selected: String(row?.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT }
        ],
        workAllocations,
        workAllocationNormalQd: workAllocationValidation.totals.normalQd,
        workAllocationOvertimeQd: workAllocationValidation.totals.overtimeQd,
        workAllocationNormalCap: normalWorkCap,
        workAllocationOvertimeCap: overtimeWorkCap,
        workAllocationValid: workAllocationValidation.ok,
        workAllocationIssueText: workAllocationValidation.issues.map((issue) => issue.message).join(" · "),
        isCustomWork: this._isCustomWork(row, holding, workOptionsContext),
        cultureOptions: this._cultureOptions(row.culture),
        beliefOptions: this._beliefOptions(row.belief),
        backgroundOptions: socialBackgroundOptions(row.background),
        traitOptions: traitOptions(traits)
      });
    }
    people.push(prepared);
  }
  return people;
},

_prepareSpecialTabs(holding) {
  const people = holding?.people?.list ?? [];
  const dead = people.filter((person) => person?.dead).length;
  const records = holding?.special?.list?.length ?? 0;
  const active = ["records", "cemetery"].includes(this.activeSpecialTab) ? this.activeSpecialTab : "records";
  return [
    { id: "records", label: "Записи", icon: "fa-solid fa-sparkles", count: records, tabCount: records, active: active === "records" },
    { id: "cemetery", label: "Кладбище", icon: "fa-solid fa-skull", count: dead, tabCount: dead, active: active === "cemetery" }
  ];
},

_squadTypeDefs() {
  return MANAGER_SQUAD_TYPE_PROFILES;
},

_isMilitaryBackgroundResident(person = {}) {
  const text = String(person?.background ?? "").toLowerCase();
  return /(солдат|ветеран|на[её]мник|страж|сторож|дозор|егерь|дезертир|канонир|артиллер|сап[её]р|тюремщик|палач|телохранитель|ополчен|мушкет|развед)/i.test(text);
},

_isCommanderCandidate(person = {}) {
  if (!this._isSoldierResident(person) || this._isResidentInjured(person) || person?.dead) return false;
  const attrs = person?.attributes ?? {};
  return this._safeNumber(attrs.wits, 0) >= COMMANDER_MIN_WITS;
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
      if (commandersOnly) return hasProfession && !this._isChildResident?.(person) && this._isCommanderCandidate(person);
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
        (this._safeNumber(attrs.wits, 0) >= COMMANDER_MIN_WITS || /команд|началь|офиц|тактик|стратег|разум|мыслител|писарь|уч[её]н|воевод|капитан/i.test(text) ? 1 : 0)
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
    if (!commander || !this._hasSoldierProfession?.(commander) || !this._isCommanderCandidate(commander) || this._isChildResident?.(commander) || this._isResidentInjured(commander) || commander.dead) {
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
    const armamentResourceId = ["armament-simple", "armament-complex", "armament-elite"].includes(String(squad.armamentResourceId ?? ""))
      ? String(squad.armamentResourceId)
      : "";
    const equipped = Boolean(armamentResourceId);
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
      armamentResourceId,
      armamentLabel: armamentResourceId ? resourceLabel(armamentResourceId) : "Вооружение не выдано",
      armamentOptions: ["armament-simple", "armament-complex", "armament-elite"].map((resourceId) => ({
        value: resourceId,
        label: resourceLabel(resourceId),
        selected: resourceId === (armamentResourceId || "armament-simple")
      })),
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
    equipmentCostText: "Одна единица Вооружения закрепляется за одним отрядом из пяти человек до замены, разоружения или расформирования.",
    defenseHelpText: `Командир выбирается отдельно от отрядов: любой живой взрослый житель. Он не дает плоских кубов; его эффективность 0-3 дает +7%/+14%/+21% к боевой мощи армии. Эффективность: Разум/управленческий тип, военное прошлое, лидерские черты. Сержантом считается только солдат с военным социальным прошлым и любой характеристикой 5+. ${Object.values(typeDefs).map((item) => `${item.label}: ${item.tag}`).join(" · ")}. Первый слот отряда — сержант или обычный солдат; всего в отряде 5 бойцов. Один житель не может занимать несколько слотов. Недоукомплектованные отряды и отряды без закрепленной единицы Вооружения не считаются. Один участвующий отряд расходует одну подходящую единицу Военных припасов за весь бой; без неё он сохраняется, но лишается 20% огнестрельного бонуса и тегов Стрелки/Осадные.`
  };
},

_preparePeopleTabs(holding) {
  const people = holding?.people?.list ?? [];
  const resting = people.filter((person) => isResidentRestingOnShip(person, holding)).length;
  const living = people.filter((person) => !person?.dead && !isResidentRestingOnShip(person, holding)).length;
  const activeCrew = resting > 0 && this.activePeopleTab === "ship-crew";
  const tabs = [{ id: "living", label: "Жители", icon: "fa-solid fa-users", count: living, active: !activeCrew }];
  if (resting) tabs.push({ id: "ship-crew", label: "Экипажи", icon: "fa-solid fa-ship", count: resting, active: activeCrew });
  return tabs;
},

_personMatchesResidentFilters(person) {
  const filters = this.residentFilters ?? {};
  const type = String(filters.type ?? "all");
  const work = String(filters.work ?? "all");
  const home = String(filters.home ?? "all");
  const morale = String(filters.morale ?? "all");

  if (type !== "all" && person.workerTypeLabel !== type) return false;
  if (person.restingOnShip) return true;
  if (work === "free" && !["Без работы", "Свободен", "Ребенок"].includes(person.workLabel)) return false;
  if (work === "assigned" && ["Без работы", "Свободен", "Ребенок"].includes(person.workLabel)) return false;
  if (home === "homeless" && !this._isNoHome(person.homeLabel)) return false;
  if (home === "housed" && this._isNoHome(person.homeLabel)) return false;
  if (morale === "negative" && this._safeNumber(person.moraleValue, 0) >= 0) return false;
  if (morale === "neutral" && this._safeNumber(person.moraleValue, 0) !== 0) return false;
  if (morale === "positive" && this._safeNumber(person.moraleValue, 0) <= 0) return false;
  return true;
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
  const livingPeople = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const crews = this._constructionCrews(holding);
  const buildingsById = new Map();
  const crewsById = new Map();
  const availableBuildingIds = new Set();
  const buildingRoleNames = new Set();
  const residentAssignments = new Map();

  for (const person of livingPeople) {
    const buildingId = String(person?.workAssignment ?? "");
    const personId = String(person?.id ?? "");
    if (!buildingId || !personId) continue;
    if (!residentAssignments.has(buildingId)) residentAssignments.set(buildingId, new Set());
    residentAssignments.get(buildingId).add(personId);
  }

  for (const building of allBuildings) {
    const id = String(building?.id ?? "");
    const name = String(building?.name ?? "").trim();
    if (id) buildingsById.set(id, building);
    if (name) buildingRoleNames.add(name);
    const max = Math.max(0, this._safeNumber(building?.workersMax, 0));
    const occupiedIds = new Set([
      ...(Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : []),
      ...(residentAssignments.get(id) ?? [])
    ].map((value) => String(value ?? "")).filter(Boolean));
    const operational = buildingOperationalState(building).operational;
    if (id && operational && max > 0 && occupiedIds.size < max) availableBuildingIds.add(id);
  }
  for (const crew of crews) {
    const id = String(crew?.id ?? "");
    if (id) crewsById.set(id, crew);
  }

  return { holding, allBuildings, buildingsById, crews, crewsById, availableBuildingIds, buildingRoleNames, buildingOptionsCache: new Map() };
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

_residentWorkOptionCatalog(context) {
  return [
    ...context.crews.map((crew) => ({
      value: `construction:${crew.id}`,
      label: crew.name || "Стройбригада",
      kind: "crew"
    })),
    ...context.allBuildings.filter((building) => context.availableBuildingIds.has(String(building?.id ?? ""))).map((building) => ({
      value: String(building.id),
      label: building.name || "Без названия",
      kind: "building",
      available: true
    })),
    { value: "soldier", label: "Солдат", kind: "soldier" },
    { value: "other", label: "Другое", kind: "other" }
  ];
},

_residentInlineWorkOption(person = {}, workLabel = "", workContext = null) {
  const context = workContext ?? { buildingsById: new Map(), crews: [], crewsById: new Map(), buildingRoleNames: new Set() };
  const selected = String(person?.workAssignment ?? "");
  const role = String(person?.role ?? "").trim();
  const isChild = this._isChildResident(person);
  const canWork = this._canResidentWork(person, context.holding);
  const freeLabel = isChild ? "Ребенок" : "Свободен";
  const free = { value: "", label: freeLabel, freeLabel, canWork };

  if (selected.startsWith("construction-leader:")) {
    const crew = context.crewsById.get(selected.slice("construction-leader:".length));
    if (crew) return { value: selected, label: `Руководитель: ${crew.name || "Стройбригада"}`, freeLabel, canWork };
  }
  if (!canWork) {
    if (selected === "other") return { value: "other", label: "Другое", freeLabel, canWork };
    return free;
  }

  if (selected === "construction") {
    const crew = context.crews.find((entry) => entry?.isDefault) ?? context.crews[0];
    if (crew?.id) return { value: `construction:${crew.id}`, label: crew.name || "Стройбригада", freeLabel, canWork };
    return free;
  }
  if (selected.startsWith("construction:")) {
    const crew = context.crewsById.get(selected.slice("construction:".length));
    if (crew) return { value: selected, label: crew.name || "Стройбригада", freeLabel, canWork };
    return free;
  }
  const building = context.buildingsById.get(selected);
  if (building) return { value: selected, label: building.name || workLabel || "Без названия", freeLabel, canWork };
  if (selected === "soldier") return { value: "soldier", label: "Солдат", freeLabel, canWork };
  if (selected === "other") return { value: "other", label: "Другое", freeLabel, canWork };
  if (selected) return free;
  if (/^солдат$/i.test(role)) return { value: "soldier", label: "Солдат", freeLabel, canWork };
  if (role && !["Свободен", "Без работы", "Ребенок"].includes(role) && !context.buildingRoleNames.has(role)) {
    return { value: "other", label: "Другое", freeLabel, canWork };
  }
  return free;
},

_workOptions(holding, person = {}, workContext = null) {
  const selected = String(person?.workAssignment ?? "");
  const role = String(person?.role ?? "").trim();
  const context = workContext ?? this._residentWorkOptionsContext(holding);
  const isChild = this._isChildResident(person);
  const canWork = this._canResidentWork(person, holding);
  const freeLabel = isChild ? "Ребенок" : "Свободен";
  const buildings = canWork ? this._residentWorkOptionBuildings(context, selected) : [];
  const crews = canWork ? context.crews : [];
  const leaderCrew = selected.startsWith("construction-leader:")
    ? context.crewsById.get(selected.slice("construction-leader:".length)) : null;
  const options = [
    { value: "", label: freeLabel, selected: !selected && (!role || role === "Свободен" || role === "Без работы" || role === "Ребенок") },
    // Leadership is appointed in the crew editor; retain the current position here.
    ...(leaderCrew ? [{ value: selected, label: `Руководитель: ${leaderCrew.name || "Стройбригада"}`, selected: true }] : []),
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
  const buildingsById = workContext?.buildingsById ?? new Map(buildings.map((building) => [String(building.id), building]));
  const crews = workContext?.crews ?? this._constructionCrews(holding);
  const crewsById = workContext?.crewsById ?? new Map(crews.map((crew) => [String(crew.id), crew]));
  for (const person of holding?.people?.list ?? []) {
    if (person?.dead) continue;
    const id = String(person?.id ?? "");
    const selected = String(person?.workAssignment ?? "");
    if (!id) continue;
    if (selected === "construction") map.set(id, crews[0]?.name || "Стройбригада");
    else if (selected.startsWith("construction-leader:")) {
      const crew = crewsById.get(selected.slice("construction-leader:".length));
      map.set(id, `Руководитель: ${crew?.name || "Стройбригада"}`);
    }
    else if (selected.startsWith("construction:")) {
      const crewId = selected.split(":")[1] || "";
      map.set(id, crewsById.get(crewId)?.name || "Стройбригада");
    }
    else if (selected === "other") map.set(id, String(person?.role ?? "").trim() || "Другое");
    else if (selected && buildingsById.has(selected)) map.set(id, buildingsById.get(selected)?.name || "Здание");
    else if (person?.role) map.set(id, String(person.role));
  }
  for (const crew of crews) {
    const name = String(crew?.name ?? "Стройбригада").trim() || "Стройбригада";
    for (const id of crew?.memberIds ?? []) if (id) map.set(String(id), name);
    if (crew?.leaderId) map.set(String(crew.leaderId), `Руководитель: ${name}`);
  }
  for (const building of buildings) {
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

_canResidentWork(person = {}, holding = null) {
  if (!person || !isResidentInPopulation(person, holding) || this._isResidentInjured(person)) return false;
  if (!this._isChildResident(person)) return true;
  return this._safeNumber(person?.age, 0) >= this._childWorkThreshold(person);
},

_childWorkThreshold(person = {}) {
  const thresholds = ageThresholdsFor(raceKeyFromResident(person));
  return Math.min(Math.max(0, Math.floor(this._safeNumber(thresholds?.young, 18)) - 1), 12);
},

_isMilitaryResidentLike(person = {}) {
  const text = [person?.role, person?.background, person?.traitsText, person?.status, person?.notes]
    .map((value) => String(value ?? "").toLowerCase()).join(" ");
  return /(солдат|сержант|командир|офицер|страж|ветеран|наемник|наёмник|ополчен|дозор|егерь|разведчик|мушкет|канонир|сап[её]р|тюремщик|охран|guard|soldier|sergeant|officer|veteran|mercenary|ranger|scout|musketeer|gunner|sapper)/i.test(text);
},

_hasSoldierProfession(person = {}) {
  return String(person?.workAssignment ?? "") === "soldier" || /^\s*(солдат|сержант)\b/i.test(String(person?.role ?? ""));
},

_isSoldierResident(person = {}) {
  if (this._hasSoldierProfession?.(person)) return true;
  const text = [person?.role, person?.background, person?.traitsText, person?.status, person?.notes]
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
  const attrs = person?.attributes ?? {};
  return residentSuitableForSquadType(attrs, squadType);
},

_soldierEfficiency(person = {}, squadType = "line") {
  const attrs = person?.attributes ?? {};
  return residentSoldierEfficiency(attrs, squadType, { militaryBackground: this._isMilitaryBackgroundResident(person) });
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

_isNoHome(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return !text || ["без жилья", "без дома", "нет дома", "нет жилья", "—", "-"].includes(text);
},

_homeLabel(person, holding = null, housingIndex = null) {
  if (isResidentRestingOnShip(person, holding) || isResidentAway(person)) return shipForResident(person, holding)?.name || "Корабль";
  if (this._isNoHome(person?.home)) return "Без дома";
  const match = this._findHomeBuilding(holding, person?.home, housingIndex);
  return match?.name ? String(match.name) : String(person?.home ?? "").trim();
},

_housingMorale(person, holding = null, housingIndex = null) {
  if (person?.dead) return { value: 0, reason: "погиб" };
  if (this._isNoHome(person?.home)) return { value: -3, reason: "без дома" };
  const home = this._findHomeBuilding(holding, person?.home, housingIndex);
  if (!home) return { value: -1, reason: "жилье не найдено" };
  let comfort = buildingHousingComfort(holding, home);
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
    building?.notes
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
    if (!isResidentInPopulation(person, holding)) continue;
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
  return (holding?.people?.list ?? []).filter((person) => isResidentInPopulation(person, holding) && (String(person?.home ?? "") === id || String(person?.home ?? "") === name));
},

_calculateMorale(holding) {
  if (!holding) return 0;

  const people = holding.people?.list ?? [];
  const special = holding.special?.list ?? [];
  const housingIndex = this._residentHousingIndex(holding);

  const peopleMorale = people.reduce((sum, row) => sum + this._calculatePersonMorale(row, holding, { housingIndex }).total, 0);

  const buildingMorale = this._buildingMoraleSummary(holding).total;

  const specialMorale = special.reduce((sum, row) => sum + specialMoraleModifier(row), 0);

  const gmMorale = this._gmSettlementModifiers?.(holding)?.morale ?? this._safeNumber(holding?.gm?.modifiers?.morale, 0);
  return peopleMorale + buildingMorale + specialMorale + gmMorale + (politicsRuntimeEffects(holding)?.morale ?? 0);
},

_buildingMoraleSummary(holding) {
  const population = (holding?.people?.list ?? []).filter((person) => isResidentInPopulation(person, holding)).length;
  const operationalBuildings = (holding?.buildings?.list ?? []).filter((building) => this._buildingStatus(building).value === "built");
  const groups = new Map();
  const negative = [];
  const leisureGroups = new Map();
  for (const [index, building] of operationalBuildings.entries()) {
    const leisure = building?.service?.leisure;
    const hasLeisure = leisure && typeof leisure === "object" && String(leisure.kind ?? "").trim();
    const raw = hasLeisure ? this._safeNumber(leisure.capacity, 0) : this._safeNumber(building?.moraleDelta, 0);
    if (!raw) continue;
    if (raw < 0) {
      if (buildingConfirmedHarmActive(holding, building)) negative.push({ building, raw, value: raw });
      continue;
    }
    if (hasLeisure) {
      const capacity = buildingConfirmedLeisureCapacity(holding, building);
      if (capacity <= 0) continue;
      const kind = String(leisure.kind).trim().toLocaleLowerCase("ru");
      if (!leisureGroups.has(kind)) leisureGroups.set(kind, []);
      leisureGroups.get(kind).push({ building, raw, capacity, index, kind });
      continue;
    }
    const status = buildingConfirmedSocialStatus(holding, building);
    if (!status.active) continue;
    const templateId = String(building?.templateId ?? "").trim().toLocaleLowerCase("ru");
    const key = templateId ? `template:${templateId}` : `instance:${String(building?.id ?? index)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ building, raw, factor: status.maintenanceFactor * (status.laborFactor ?? 1), index });
  }

  let total = negative.reduce((sum, row) => sum + row.value, 0);
  const sources = negative.map((row) => ({
    id: String(row.building?.id ?? ""),
    name: row.building?.name || "Здание",
    raw: row.raw,
    value: row.value,
    repeated: false,
    coverage: 1,
    negative: true
  }));
  for (const rows of groups.values()) {
    rows.sort((left, right) => String(left.building?.id ?? left.index).localeCompare(String(right.building?.id ?? right.index)));
    const first = rows[0];
    const serviceRows = rows.filter((row) => row.building?.service && typeof row.building.service === "object");
    let coverage = 1;
    let capacity = 0;
    let coverageTarget = population;
    if (serviceRows.length) {
      const coverageKind = String(first.building?.service?.coverageKind ?? "population");
      capacity = serviceRows.reduce((sum, row) => sum + buildingConfirmedServiceCapacity(holding, row.building), 0);
      if (["buildings", "target-buildings"].includes(coverageKind)) {
        const validIds = new Set(operationalBuildings.flatMap((building) => [String(building?.id ?? ""), String(building?.templateId ?? "")]).filter(Boolean));
        const covered = new Set(serviceRows.flatMap((row) => row.building?.service?.coveredBuildingIds ?? []).map(String).filter((id) => validIds.has(id)));
        coverageTarget = Math.max(1, operationalBuildings.length);
        capacity = Math.min(capacity, covered.size);
      }
      coverage = coverageTarget > 0 ? Math.min(1, capacity / coverageTarget) : 1;
    }
    const value = scaleIntegerBuildingEffect(first.raw, serviceRows.length ? coverage : first.factor);
    total += value;
    sources.push({
      id: String(first.building?.id ?? ""),
      name: first.building?.name || "Здание",
      raw: first.raw,
      value,
      repeated: false,
      coverage,
      capacity,
      coverageTarget,
      negative: false
    });
    for (const row of rows.slice(1)) {
      const repeatAllowed = row.building?.repeatSettlementEffects === true;
      const repeatValue = repeatAllowed ? scaleIntegerBuildingEffect(row.raw, row.factor) : 0;
      total += repeatValue;
      sources.push({
        id: String(row.building?.id ?? ""),
        name: row.building?.name || "Здание",
        raw: row.raw,
        value: repeatValue,
        repeated: true,
        repeatAllowed,
        coverage: 0,
        negative: false
      });
    }
  }

  const diversityFactors = [1, 0.75, 0.5];
  for (const rows of leisureGroups.values()) {
    rows.sort((left, right) => right.capacity - left.capacity
      || String(left.building?.id ?? left.index).localeCompare(String(right.building?.id ?? right.index)));
    for (const [index, row] of rows.entries()) {
      const rank = index + 1;
      const diversityFactor = diversityFactors[index] ?? 0.25;
      const value = Math.floor(row.capacity * diversityFactor);
      total += value;
      sources.push({
        id: String(row.building?.id ?? ""),
        name: row.building?.name || "Здание",
        raw: row.raw,
        value,
        repeated: rank > 1,
        repeatAllowed: true,
        coverage: 1,
        capacity: row.capacity,
        coverageTarget: row.capacity,
        negative: false,
        leisure: true,
        leisureKind: row.kind,
        diversityFactor,
        rank
      });
    }
  }
  return { total, population, sources };
},

_controlSummary(holding, rawMorale = null) {
  const raw = rawMorale === null ? this._calculateMorale(holding) : this._safeNumber(rawMorale, 0);
  return settlementControlSummary(holding, { rawMorale: raw });
},

_rationMorale(person, holding = null) {
  if (person?.dead) return { value: 0, tier: "none", reason: "погиб" };
  const row = holding?.gm?.moraleSnapshot?.residents?.[String(person?.id ?? "")]?.ration;
  if (row && typeof row === "object") {
    const tier = String(row?.tier ?? "normal");
    const label = tier === "enhanced" ? "усиленный" : tier === "sparse" ? "скудный" : tier === "hunger" ? "голод" : "обычный";
    return { value: this._safeNumber(row?.value, 0), tier, reason: label + (row.diversityBonus > 0 ? `; разнообразие +${row.diversityBonus}` : "") };
  }
  return { value: 0, tier: "normal", reason: "обычный (до первого расчёта)" };
},

_calculatePersonMorale(person, holding = null, options = {}) {
  if (person?.dead) return { total: 0, breakdown: ["Погиб: довольство не считается"] };
  if (!isResidentInPopulation(person, holding)) return { total: 0, breakdown: ["Экипаж на корабле: довольство поселения не считается"] };
  const housingIndex = options?.housingIndex ?? null;
  const base = this._safeNumber(person?.moraleBase, -1);
  const workManual = this._safeNumber(person?.moraleWork, 0);
  const workAuto = this._workMorale(person, holding);
  const workUnclamped = workManual + workAuto.value;
  const work = Math.max(-3, Math.min(3, Math.sign(workUnclamped) * Math.round(Math.abs(workUnclamped))));
  const ration = this._rationMorale(person, holding);
  const homeManual = this._safeNumber(person?.moraleHome, 0);
  const homeAuto = this._housingMorale(person, holding, housingIndex);
  const home = homeManual + homeAuto.value;
  const manual = this._safeNumber(person?.moraleManual, 0);
  const traits = this._traitMoraleModifier(person);
  const total = base + ration.value + work + home + traits.value + manual;

  const breakdown = [
    `Итог: ${total}`,
    `База: ${base}`,
    `Питание: ${ration.value > 0 ? "+" : ""}${ration.value} (${ration.reason})`,
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
