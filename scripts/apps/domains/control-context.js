import { buildingOperationalState } from "../../core/building-state.js";
import { isSheriffAppointment } from "../../data/control-appointments.js";
import { holdingPermissionContext } from "../../data/holding-permissions.js";
import { buildingStaffingWorkerIds, WORK_ALLOCATION_MODE_EXPLICIT } from "../../data/work-allocations.js";
import { buildingServiceBlockReasons } from "../../engines/economy/building-service.js";

const CHAIN_IDS = ["sheriff-post", "guard-house", "guard-precinct", "court"];
const DEVELOPMENT_LABELS = { food: "Пища", technology: "Технологии", culture: "Культура", war: "Война" };
const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));
const visible = (row, user) => user?.isGM || row?.visibility !== "gm";

export function hasControlEffect(building = {}) {
  return ["generalFlat", "generalPerWorker", "unrestOnlyFlat", "unrestOnlyPerWorker"]
    .some((key) => whole(building.control?.[key]) > 0);
}

export function controlEffectText(control = {}) {
  const parts = [];
  if (whole(control.generalFlat)) parts.push(`Общий Контроль +${whole(control.generalFlat)}`);
  if (whole(control.generalPerWorker)) parts.push(`Общий Контроль +${whole(control.generalPerWorker)} за работающего сотрудника`);
  if (whole(control.unrestOnlyFlat)) parts.push(`Против беспорядков +${whole(control.unrestOnlyFlat)}`);
  if (whole(control.unrestOnlyPerWorker)) parts.push(`Против беспорядков +${whole(control.unrestOnlyPerWorker)} за работающего сотрудника`);
  if (whole(control.maximum)) parts.push(`максимум ${whole(control.maximum)}`);
  if (whole(control.capacity)) parts.push(`охват ${whole(control.capacity)} жителей`);
  if (control.ceiling !== null && control.ceiling !== undefined && Number.isFinite(Number(control.ceiling))) {
    parts.push(`предел подавления ${control.ceiling}`);
  }
  return parts.join(" · ") || "Числовой эффект Контроля не задан";
}

/** Only free residents enter the picker: assigning here never silently replaces another job or QD plan. */
export function controlResidentAvailable(holding, person, manager, { sheriff = false, assignedIds = null } = {}) {
  if (!manager?._canResidentWork?.(person, holding)) return false;
  if (String(person?.workAllocationMode ?? "") === WORK_ALLOCATION_MODE_EXPLICIT) return false;
  if ((assignedIds ?? manager?._assignedWorkerSet?.(holding))?.has(String(person.id))) return false;
  if (sheriff && isSheriffAppointment(person)) return true;
  return !String(person?.workAssignment ?? "")
    && ["", "Свободен", "Без работы", "Ребенок"].includes(String(person?.role ?? ""));
}

export function prepareControlContext(holding, catalog = [], summary = {}, manager, { user = globalThis.game?.user } = {}) {
  const permission = holdingPermissionContext(holding, { user });
  const canAssign = permission.canEditBuildings && typeof manager?._assignPersonToBuilding === "function";
  const people = holding?.people?.list ?? [];
  const peopleById = new Map(people.map((person) => [String(person.id), person]));
  const buildings = holding?.buildings?.list ?? [];
  const sourcesById = new Map((summary.sources ?? []).map((source) => [String(source.id), source]));
  const totals = manager?._developmentSummary?.(holding)?.totals ?? {};
  const templates = new Map(catalog.map((template) => [String(template.id), template]));
  const templateName = (id) => {
    const template = templates.get(String(id));
    return template && !visible(template, user) ? "Скрытая предпосылка" : template?.name || id;
  };
  const assignedIds = manager?._assignedWorkerSet?.(holding) ?? new Set();
  const freePeople = people.filter((person) => visible(person, user) && controlResidentAvailable(holding, person, manager, { assignedIds }));
  const sheriffPeople = people.filter((person) => isSheriffAppointment(person) && !person.dead && visible(person, user));
  const sheriffSource = (summary.sources ?? []).find((source) => source.sourceKind === "appointment");
  const selectedSheriffId = sheriffSource?.id?.replace(/^sheriff:/, "") ?? String(sheriffPeople[0]?.id ?? "");
  const sheriffOptions = people.filter((person) => visible(person, user)
    && (sheriffPeople.includes(person) || controlResidentAvailable(holding, person, manager, { sheriff: true, assignedIds })))
    .map((person) => ({ id: person.id, name: person.name || "Житель", selected: String(person.id) === selectedSheriffId,
      disabled: String(person.id) !== selectedSheriffId && !controlResidentAvailable(holding, person, manager, { sheriff: true, assignedIds }) }));

  const jobs = buildings.filter((building) => hasControlEffect(building) && visible(building, user) && whole(building.workersMax) > 0)
    .map((building) => {
      const state = buildingOperationalState(building);
      const workerIds = buildingStaffingWorkerIds(holding, building.id);
      const workers = workerIds.map((id) => {
        const person = peopleById.get(String(id));
        const explicit = person?.workAllocationMode === WORK_ALLOCATION_MODE_EXPLICIT;
        return { id, name: person && visible(person, user) ? person.name || "Житель" : "Скрытый или отсутствующий житель",
          explicit, canRemove: canAssign && !explicit && Boolean(person && visible(person, user)) };
      });
      const candidates = freePeople.filter((person) => {
        const admission = manager?._buildingWorkerAdmission?.(building, person);
        return user?.isGM || !admission?.hard || admission.eligible || admission.overridden;
      }).map((person) => ({ id: person.id, name: person.name || "Житель" }));
      return { id: building.id, name: building.name || "Здание", role: building.workerRole || "Сотрудник учреждения",
        workers, hasWorkers: workers.length > 0, max: whole(building.workersMax), min: whole(building.activation?.minWorkers ?? building.workersMin),
        count: workerIds.length, qd: whole(building.activation?.minOperationalQd), admission: building.workerProfile?.admission?.text || "",
        candidates, canAdd: canAssign && state.operational && workerIds.length < whole(building.workersMax) && candidates.length > 0,
        stateLabel: state.label };
    });

  // Keep catalog customizations. Owned buildings remain visible even if their template was removed.
  const rows = new Map(catalog.filter((row) => hasControlEffect(row) && visible(row, user)).map((row) => [String(row.id), row]));
  for (const building of buildings.filter((row) => hasControlEffect(row) && visible(row, user))) {
    const key = String(building.templateId || building.id);
    if (!rows.has(key)) rows.set(key, { ...building, id: key });
  }
  const progression = [...rows.values()].map((template) => {
    const owned = buildings.filter((building) => String(building.templateId || building.id) === String(template.id) && visible(building, user));
    const instances = owned.map((building) => {
      const state = buildingOperationalState(building);
      const status = buildingServiceBlockReasons(holding, building);
      const source = sourcesById.get(String(building.id));
      return { id: building.id, name: building.name || template.name, stateLabel: state.label, active: Boolean(source),
        actualEffects: source ? `Общий ${source.general} · беспорядки +${source.unrestOnly} · охват ${source.capacity}${source.ceiling === null ? "" : ` · предел ${source.ceiling}`}` : "Сейчас Контроль не даёт",
        effects: controlEffectText(building.control), reasons: status.reasons.map((reason) => reason.text).join("; ") };
    });
    const required = (template.requiredBuildingIds ?? []).map(templateName);
    const any = (template.requiredAnyBuildingIds ?? []).map(templateName);
    const requirements = Object.entries(DEVELOPMENT_LABELS).filter(([key]) => whole(template.requirements?.[key]))
      .map(([key, label]) => ({ label, required: whole(template.requirements[key]), current: whole(totals[key]),
        met: whole(totals[key]) >= whole(template.requirements[key]) }));
    const builtCount = owned.filter((building) => {
      const state = buildingOperationalState(building);
      return ["active", "disabled"].includes(state.lifecycle) && state.condition !== "destroyed";
    }).length;
    return { id: template.id, name: template.name || "Здание", stage: whole(template.developmentStage),
      effects: controlEffectText(template.control), activation: template.activationConditionText || "Требуются исправность, обслуживание и работа функции.",
      minWorkers: whole(template.activation?.minWorkers ?? template.workersMin), maxWorkers: whole(template.workersMax),
      qd: whole(template.activation?.minOperationalQd), prerequisites: [required.length ? `Нужны: ${required.join(", ")}` : "",
        any.length ? `Одно из: ${any.join(", ")}` : ""].filter(Boolean).join(". "), requirements,
      instances, present: builtCount > 0, statusLabel: builtCount ? `Построено: ${builtCount} · работает: ${instances.filter((row) => row.active).length}`
        : owned.length ? `Не построено · записей: ${owned.length}` : "Отсутствует" };
  }).sort((a, b) => a.stage - b.stage || a.name.localeCompare(b.name, "ru"));

  const chain = CHAIN_IDS.map((id) => progression.find((row) => row.id === id)).filter(Boolean);
  const otherBuildings = progression.filter((row) => !CHAIN_IDS.includes(String(row.id)));
  return { canAssign, permissionReason: !permission.mayEditBuildings ? "Назначения доступны с правом редактирования зданий."
    : !permission.writeAvailable ? permission.authorityStatus.detail : !canAssign ? "Откройте главное окно поселения для назначений." : "",
    sheriff: { options: sheriffOptions, empty: !selectedSheriffId, active: Boolean(sheriffSource),
      names: sheriffPeople.map((person) => person.name || "Житель").join(", ") || "Не назначен", multiple: sheriffPeople.length > 1 },
    jobs, hasJobs: jobs.length > 0,
    buildingGroups: [
      { label: "Прогрессия учреждений охраны", chain: true, rows: chain },
      { label: "Другие здания Контроля", chain: false, rows: otherBuildings }
    ], chain, otherBuildings };
}
