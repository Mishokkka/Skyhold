import { MODULE_ID } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { workforceKey, workforceLockKey, workforceCapacity } from "../data/workforce-plan.js";
import { makeId } from "../data/utils.js";
import { buildingAppearance } from "../core/building-appearance.js";
import { getSkyholdWorkflowService } from "../workflows/skyhold-workflow-service.js";
import { createWorkforceDraft, buildWorkforceModel, workforceCandidate, setWorkforceAllocation, reviseWorkforceAssignment, workforceDraftError, proposeWorkforceAssignments, proposeWorkforceIdleReview } from "./domains/workforce-planner.js";
import { workforceTaskGroups } from "./domains/workforce-planner-view.js";
import { setWorkforceStaff, removeWorkforceStaff, staffWorkDescription } from "./domains/workforce-staff.js";
import { executeWorkforcePlan } from "./workforce-plan-executor.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { restoreApplicationFocus } from "./common/window-focus-keeper.js";
import { DisclosureState } from "./common/disclosure-state.js";
import { requestSkyholdAppRender } from "./registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const copy = (value) => structuredClone(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const textMatch = (text, query) => String(text).toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru"));
const actions = ["view", "page", "candidate-page", "candidates-all", "task", "person", "person-assign", "person-transfer", "close-rail", "select-all", "clear-selection", "goal", "production-goal", "staff-hire", "staff-save", "staff-remove", "assign", "all-free", "remove", "lock", "preview-bulk", "suggest", "fill", "idle", "accept-preview", "cancel-preview", "undo", "discard", "save", "retry", "refresh", "resident-card", "tenday"];

export class SkyholdWorkforcePlanner extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Map();
  static DEFAULT_OPTIONS = { id: "fbls-workforce", classes: ["fbl-skyhold", "fbls-secondary", "fbls-workforce-window"], tag: "div",
    window: { title: "План работ", resizable: true }, position: { width: 1060, height: 730 },
    actions: Object.fromEntries(actions.map((name) => [`workforce-${name}`, function(event, target) { return this._action(event, target); }])) };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/workforce-planner.hbs` } };
  static open({ holdingId, personId = "", targetKey = "" } = {}) {
    const id = String(holdingId ?? "");
    let app = this.instances.get(id);
    const isNew = !app;
    if (isNew) { app = new this({ holdingId: id }); this.instances.set(id, app); }
    if (personId) { app.view = "people"; app.personId = personId; }
    if (targetKey) { app.view = "tasks"; app.targetKey = targetKey; }
    app.render({ force: true, focus: true }).catch((error) => {
      if (isNew && this.instances.get(id) === app) this.instances.delete(id);
      console.error("FBL Skyhold | Failed to open workforce planner", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть план работ.");
    });
    return app;
  }
  static rerenderOpen() { for (const app of this.instances.values()) app.requestRender({ focus: false }); }
  constructor({ holdingId } = {}, options = {}) {
    super({ ...options, id: `fbls-workforce-${holdingId}` });
    Object.assign(this, { holdingId, view: "tasks", query: "", filter: "all", sort: "name", page: 0, candidatePage: 0,
      candidateQuery: "", candidateFilter: "free", targetKey: "", personId: "", personSource: "", personBuildingId: "", personTargetKey: "", personQd: 4, personOt: 0,
      selected: new Set(), history: [], inputValues: new Map(), bulkQd: 4 });
    this.service = getSkyholdWorkflowService();
    this.disclosures = new DisclosureState();
  }
  async render(...args) {
    const firstRender = !this.rendered;
    const result = await super.render(...args);
    // Remember the frame only after ApplicationV2 has finished positioning it.
    if (firstRender && this.element) this._bindWindowFrameSync(this.element);
    return result;
  }
  _reset(holding, revision) {
    this.base = copy(holding); this.revision = revision; this.draft = createWorkforceDraft(this.base, this.service);
    this.initial = copy(this.draft); this.history = []; this.preview = null; this.inputValues.clear();
  }
  get dirty() { return this.draft && !same(this.initial, this.draft); }
  _change(callback) {
    if (!this.permissions?.canEditBuildings || this._busy || this.pending) return;
    const next = copy(this.draft); callback(next);
    if (same(this.draft, next)) return;
    this.history.push(copy(this.draft)); if (this.history.length > 30) this.history.shift();
    this.draft = next; this.preview = null; this.message = "";
  }
  _rows(model) {
    let rows = this.view === "tasks" ? model.tasks.filter((row) => textMatch(`${row.name} ${row.functionName}`, this.query)
      && (this.filter === "all" || this.filter === "attention" && row.attention || this.filter === "gap" && (row.remaining > 0 || row.effectiveRemaining > 0)
        || this.filter === "idle" && (row.idle || !row.assignable)))
      : model.people.filter((row) => textMatch(row.name, this.query)
        && (this.filter === "all" || this.filter === "free" && row.free > 0 || this.filter === "unavailable" && row.unavailable
          || this.filter === "assigned" && (row.isStaff || row.normalQd + row.overtimeQd > 0)));
    if (this.view === "tasks") rows = workforceTaskGroups(model, rows);
    rows = [...rows].sort((a, b) => this.sort === "free" ? (b.free ?? b.remaining ?? 0) - (a.free ?? a.remaining ?? 0) || a.name.localeCompare(b.name, "ru")
      : a.name.localeCompare(b.name, "ru") || String(a.key ?? a.id).localeCompare(String(b.key ?? b.id)));
    return rows;
  }
  _personContext(model, person, canEdit) {
    if (!person) return null;
    if (person.appointment) {
      const appointment = person.appointment;
      const choices = model.tasks.filter((task) => task.buildingId === appointment.buildingId && task.assignable);
      const value = (kind, fallback) => this.inputValues.get(`staff-${kind}:${person.id}`) ?? fallback;
      return { ...person, staffEditor: {
        primaryKey: workforceKey({ sourceId: appointment.buildingId, functionId: appointment.primaryFunctionId }),
        locked: person.allocations.some((row) => row.locked),
        primary: choices.map((task) => ({ id: task.functionId, name: task.functionName, selected: task.functionId === value("primary", appointment.primaryFunctionId) })),
        reserve: choices.map((task) => ({ id: task.functionId, name: task.functionName, selected: task.functionId === value("reserve", appointment.reserveFunctionId) })),
        noReserve: !value("reserve", appointment.reserveFunctionId),
        rate: value("rate", appointment.wageDailyCopper), overtime: value("ot", appointment.overtimeQd),
        volunteer: value("volunteer", appointment.volunteer), reason: value("reason", appointment.volunteerReason),
        canEdit: canEdit && !person.unavailable, canSetRate: canEdit && this.permissions.isGM,
        canRemove: canEdit, hasUnknownPrimary: !choices.some((task) => task.functionId === appointment.primaryFunctionId),
        hasUnknownReserve: appointment.reserveFunctionId && !choices.some((task) => task.functionId === appointment.reserveFunctionId)
      } };
    }
    const allocations = person.allocations.map((row) => {
      const task = model.taskMap.get(row.key);
      const reason = task ? workforceCandidate(model, person, task, this.service).reason : "Работа недоступна";
      return { ...row, functionName: task?.functionName, name: task?.name || row.label, reason,
        value: this.inputValues.get(`qd:${person.id}:${row.key}`) ?? row.normalQd,
        overtimeValue: this.inputValues.get(`ot:${person.id}:${row.key}`) ?? row.overtimeQd,
        overtimeAllowed: task?.overtimeAllowed || row.overtimeQd > 0,
        canAssign: canEdit && !reason, canRemove: canEdit && !row.locked };
    });
    const source = allocations.find((row) => row.key === this.personSource && !row.locked);
    if (!source) this.personSource = "";
    const groups = this.groups.filter((group) => group.allTasks.some((task) => task.assignable));
    const group = groups.find((row) => row.id === this.personBuildingId) ?? groups[0];
    this.personBuildingId = group?.id || "";
    const choices = (group?.allTasks ?? []).filter((task) => task.assignable).map((task) => ({ ...task,
      reason: task.key === this.personSource ? "Исходная работа" : workforceCandidate(model, person, task, this.service).reason }));
    const destination = choices.find((row) => row.key === this.personTargetKey)
      ?? choices.find((row) => !row.reason) ?? choices[0];
    this.personTargetKey = destination?.key || "";
    const available = source ? source.normalQd : person.free;
    const availableOt = source ? source.overtimeQd : Math.max(0, person.capacity.overtimeQd - person.overtimeQd);
    if (!destination?.overtimeAllowed) this.personOt = 0;
    return { ...person, allocations, sourceKey: this.personSource, transfer: Boolean(source),
      sources: allocations.filter((row) => !row.locked && row.known).map((row) => ({ ...row, selected: row.key === this.personSource })),
      buildings: groups.map((row) => ({ id: row.id, name: row.name, selected: row.id === group?.id })),
      destinations: choices.map((row) => ({ key: row.key, name: row.functionName, reason: row.reason, selected: row.key === destination?.key })),
      assignmentReason: person.unavailable || destination?.reason || (!destination ? "Нет доступных работ" : ""),
      canAssign: canEdit && !person.unavailable && destination && !destination.reason,
      staffDestination: destination?.isStaff === true,
      available, availableOt, amount: this.personQd, overtimeAmount: this.personOt,
      overtimeAllowed: destination?.overtimeAllowed, minimum: destination?.requirement };
  }
  async _prepareContext(options) {
    const active = globalThis.document?.activeElement;
    this.focusState = this.element?.contains(active) ? { element: active, tag: active.tagName,
      attrs: ["name", "data-action", "data-person-id", "data-key", "data-view", "data-delta"].filter((key) => active.hasAttribute(key)).map((key) => [key, active.getAttribute(key)]),
      start: active.selectionStart, end: active.selectionEnd } : null;
    const context = await super._prepareContext(options);
    const data = SkyholdData.view(), { holding } = findReadableHoldingEntry(data, this.holdingId);
    if (!holding) { this._model = null; return { ...context, hasHolding: false }; }
    this.permissions = holdingPermissionContext(holding);
    const revision = Number(data.meta?.revision ?? 0);
    if (!this.draft || !this.dirty && !this.pending && this.revision !== revision) this._reset(holding, revision);
    this.latest = { holding, revision };
    if (this.seenRevision !== revision) this.preview = null;
    this.seenRevision = revision;
    this.stale = revision !== this.revision;
    // Current visibility always wins, including while an older draft is kept for comparison.
    const display = copy(this.base);
    for (const key of ["people", "buildings"]) for (const row of display[key]?.list ?? []) {
      const current = holding[key]?.list?.find((entry) => String(entry.id) === String(row.id));
      row.visibility = current?.visibility ?? (current ? "public" : "gm");
    }
    this.planningOptions = { ...this.permissions, presenceHolding: holding };
    const model = buildWorkforceModel(display, this.draft, this.service, this.planningOptions);
    const templates = data.catalog?.buildings ?? [];
    const categories = this.service._buildingCategoryOptions();
    for (const task of model.tasks) {
      const building = task.building;
      const templateId = String(building?.templateId ?? "").trim().toLowerCase();
      const buildingName = String(building?.name ?? "").trim().toLowerCase();
      const template = templates.find((row) => templateId && String(row.id ?? "").toLowerCase() === templateId)
        ?? templates.find((row) => buildingName && String(row.name ?? "").trim().toLowerCase() === buildingName);
      const categoryIcon = building ? categories.find((row) => row.id === this.service._buildingCategory(building))?.icon : "fa-solid fa-screwdriver-wrench";
      Object.assign(task, buildingAppearance(building, template, categoryIcon));
    }
    this.groups = workforceTaskGroups(model);
    for (const group of this.groups) for (const task of group.allTasks) task.requirement = group.requirement;
    this._model = model;
    const visibleIds = new Set(model.people.map((row) => row.id));
    for (const id of this.selected) if (!visibleIds.has(id)) this.selected.delete(id);
    const matching = this._rows(model), pages = Math.max(1, Math.ceil(matching.length / 25));
    this.page = Math.min(this.page, pages - 1); this.matchingIds = this.view === "people" ? matching.map((row) => row.id) : [];
    const rows = matching.slice(this.page * 25, this.page * 25 + 25).map((row) => ({ ...row, selected: this.selected.has(row.id),
      active: this.view === "tasks" ? row.allTasks.some((task) => task.key === this.targetKey) : row.id === this.personId,
      assignmentsText: this.view === "tasks" ? row.assignmentsText : (row.allocations ?? []).filter((entry) => entry.normalQd || entry.overtimeQd).map((entry) => `${entry.label.split(" · ").slice(0, 2).join(" · ")}: ${entry.normalQd}+${entry.overtimeQd}`).join("; ") }));
    const task = model.tasks.find((row) => row.key === this.targetKey);
    const person = model.people.find((row) => row.id === this.personId);
    let candidates = task ? model.people.map((row) => workforceCandidate(model, row, task, this.service)).filter((row) => textMatch(row.name, this.candidateQuery)
      && (this.candidateFilter === "all" || this.candidateFilter === "free" && (row.free > 0 || task.isStaff && row.isStaff && row.appointment.buildingId === task.buildingId) && !row.reason || this.candidateFilter === "selected" && this.selected.has(row.id))) : [];
    // Use the visible sort choice; partial assignments must not silently reorder
    // an alphabetical list or move its edited row to another page.
    candidates.sort((a, b) => (this.sort === "free" ? b.free - a.free : 0)
      || a.name.localeCompare(b.name, "ru", { numeric: true }) || a.id.localeCompare(b.id));
    const candidateCount = candidates.length, candidatePages = Math.max(1, Math.ceil(candidateCount / 8));
    this.candidatePage = Math.min(this.candidatePage, candidatePages - 1);
    candidates = candidates.slice(this.candidatePage * 8, this.candidatePage * 8 + 8).map((row) => ({ ...row, selected: this.selected.has(row.id),
      value: this.inputValues.get(`qd:${row.id}:${task.key}`) ?? row.existingNormal,
      overtimeValue: this.inputValues.get(`ot:${row.id}:${task.key}`) ?? row.existingOvertime,
      canAssign: !row.reason && this.permissions.canEditBuildings && !this.pending && !this._busy }));
    const canEdit = this.permissions.canEditBuildings && !this.pending && !this._busy;
    const personEditor = this._personContext(model, person, canEdit);
    const error = this.dirty ? workforceDraftError(this.base, this.draft, this.permissions) : "";
    return { ...context, hasHolding: true, holdingName: holding.name, isGM: this.permissions.isGM, canEdit,
      adultCapacity: workforceCapacity({ ageGroup: "Вз" }),
      readonlyReason: this.permissions.canEditBuildings ? "" : this.permissions.authorityStatus.detail,
      tasksView: this.view === "tasks", peopleView: this.view === "people", rows, model, query: this.query,
      filters: (this.view === "tasks" ? [["all", "Все работы"], ["attention", "Требует внимания"], ["gap", "Не закрыт план"], ["idle", "Ожидание / недоступно"]]
        : [["all", "Все жители"], ["free", "Есть свободные QD"], ["assigned", "Назначены"], ["unavailable", "Недоступны"]]).map(([value, label]) => ({ value, label, selected: value === this.filter })),
      sortOptions: [["name", "По имени / зданию"], ["free", "По свободным QD / остатку"]].map(([value, label]) => ({ value, label, selected: value === this.sort })),
      total: matching.length, pageLabel: `${this.page + 1} / ${pages}`, prev: this.page > 0, next: this.page + 1 < pages,
      selectedCount: this.selected.size, bulkQd: Math.min(this.bulkQd, workforceCapacity({ ageGroup: "Вз" }).normalQd), task, person: personEditor, rail: Boolean(this.view === "tasks" ? task : person),
      candidates, candidateCount, candidateQuery: this.candidateQuery, candidatePageLabel: `${this.candidatePage + 1} / ${candidatePages}`,
      candidateEmptyMessage: this.candidateQuery ? "По этому имени никто не найден." : this.candidateFilter === "free"
        ? model.free ? "Нет свободных подходящих работников. Покажите всех, чтобы увидеть причины." : "Все обычные QD заняты. Откройте жителя и перенесите время с другой работы."
        : "Нет жителей по выбранному фильтру.",
      candidatePrev: this.candidatePage > 0, candidateNext: this.candidatePage + 1 < candidatePages,
      candidateFilters: [["free", "Свободные и подходящие"], ["all", "Все жители"], ["selected", "Выбранные"]].map(([value, label]) => ({ value, label, selected: value === this.candidateFilter })),
      goalValue: task ? this.inputValues.get(`goal:${task.key}`) ?? task.goal ?? 0 : 0,
      productionGoalValue: task ? this.inputValues.get(`production-goal:${task.key}`) ?? task.preparedUnits ?? 0 : 0,
      preview: this.preview, canAcceptPreview: canEdit && this.preview && (this.preview.base || this.preview.discard || !same(this.preview.draft, this.draft)), dirty: this.dirty, pending: Boolean(this.pending), busy: this._busy, stale: this.stale,
      canSave: canEdit && this.dirty && !error && !this.stale && !this.preview,
      canUndo: canEdit && this.history.length > 0, error, message: this.message,
      changes: this.draft.edited.filter((id) => visibleIds.has(id)).map((id) => ({ name: model.people.find((row) => row.id === id).name,
        before: staffWorkDescription(this.initial.staffAppointments?.[id], model.taskMap) || this._allocationText(this.initial.allocations[id], model),
        after: staffWorkDescription(this.draft.staffAppointments?.[id], model.taskMap) || this._allocationText(this.draft.allocations[id], model) })) };
  }
  _allocationText(rows, model) {
    return (rows ?? []).filter((row) => row.normalQd || row.overtimeQd).map((row) => {
      const task = model.taskMap.get(workforceKey(row));
      return `${task ? `${task.name} · ${task.functionName}` : "Недоступное назначение"}: ${row.normalQd} + ${row.overtimeQd} QD`;
    }).join("; ") || "Нет назначений";
  }
  async _onRender(context, options) {
    await super._onRender(context, options); this.listeners?.abort(); this.listeners = new AbortController();
    if (options?.isFirstRender) {
      // An intrinsic frame can be just 200px wide. Size it before the frame
      // mixin receives Foundry's first position with left/top (not a user drag).
      const { width, height } = options.position ?? this.position;
      this.setPosition({ width, height });
    } else this._bindWindowFrameSync(this.element);
    this.disclosures.bind(this.element);
    const updateField = (event) => {
      const field = event.target.closest("[data-workforce-field]"), kind = field?.dataset.workforceField;
      if (!kind) return;
      if (kind === "selected") {
        if (field.checked) this.selected.add(field.dataset.personId); else this.selected.delete(field.dataset.personId);
      } else if (kind.startsWith("staff-")) {
        const value = field.type === "checkbox" ? field.checked : field.type === "number" ? Number(field.value) : field.value;
        this.inputValues.set(`${kind}:${field.dataset.personId}`, value);
        return;
      } else if (["qd", "ot", "goal", "production-goal"].includes(kind)) {
        this.inputValues.set(["goal", "production-goal"].includes(kind) ? `${kind}:${this.targetKey}` : `${kind}:${field.dataset.personId}:${field.dataset.key || this.targetKey}`, Number(field.value));
        return;
      } else if (["bulkQd", "personQd", "personOt"].includes(kind)) { this[kind] = Number(field.value); return; }
      else if (["personSource", "personBuildingId", "personTargetKey"].includes(kind)) {
        this[kind] = field.value;
        if (kind !== "personTargetKey") this.personTargetKey = "";
        if (kind === "personSource") { this.personQd = 4; this.personOt = 0; }
      }
      else { this[kind] = field.value; if (kind.startsWith("candidate")) this.candidatePage = 0; else this.page = 0; }
      if (event.type === "input") {
        if (["query", "candidateQuery"].includes(kind)) { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => this.requestRender({ focus: false }), 180); }
        return;
      }
      clearTimeout(this.searchTimer); this.requestRender({ focus: false });
    };
    this.element.addEventListener("change", updateField, { signal: this.listeners.signal });
    this.element.addEventListener("input", (event) => {
      if (["search", "number"].includes(event.target.type)) updateField(event);
    }, { signal: this.listeners.signal });
    restoreApplicationFocus(this, options);
    const focus = this.focusState, active = globalThis.document?.activeElement;
    if (focus?.attrs.length && (!active || active === globalThis.document?.body || active === focus.element || this.element.contains(active))) {
      const replacement = [...this.element.querySelectorAll(focus.tag)].find((element) => focus.attrs.every(([key, value]) => element.getAttribute(key) === value));
      replacement?.focus({ preventScroll: true });
      if (Number.isInteger(focus.start) && ["text", "search"].includes(replacement?.type)) replacement.setSelectionRange(focus.start, focus.end);
    }
  }
  async _action(event, target) {
    event.preventDefault(); if (this._busy || !this._model) return;
    const action = target.dataset.action.replace("workforce-", ""), id = target.dataset.personId, key = target.dataset.key;
    const model = this._model, task = model.tasks.find((row) => row.key === (key || this.targetKey));
    try {
      if (action === "view") { this.view = target.dataset.view; this.filter = "all"; this.query = ""; this.page = 0; }
      else if (action === "page") this.page = Math.max(0, this.page + Number(target.dataset.delta));
      else if (action === "candidate-page") this.candidatePage = Math.max(0, this.candidatePage + Number(target.dataset.delta));
      else if (action === "candidates-all") { this.candidateFilter = "all"; this.candidateQuery = ""; this.candidatePage = 0; }
      else if (action === "task") { this.targetKey = key; this.view = "tasks"; this.candidatePage = 0; }
      else if (action === "person") {
        if (this.view !== "people") { this.filter = "all"; this.query = ""; this.page = 0; }
        if (this.personId !== id) { this.personSource = ""; this.personBuildingId = ""; this.personTargetKey = ""; this.personQd = 4; this.personOt = 0; }
        this.personId = id; this.view = "people";
      }
      else if (action === "person-transfer") { this.personSource = key; this.personTargetKey = ""; this.personQd = 4; this.personOt = 0; }
      else if (action === "close-rail") { this.targetKey = ""; this.personId = ""; }
      else if (action === "select-all") this.matchingIds.forEach((value) => this.selected.add(value));
      else if (action === "clear-selection") this.selected.clear();
      else if (action === "resident-card") {
        const { loadResidentEditorClass } = await import("./lazy-apps.js");
        const Editor = await loadResidentEditorClass(); Editor.open({ holdingId: this.holdingId, personId: id });
      } else if (action === "tenday") {
        const { openTendayApp } = await import("./lazy-apps.js"); await openTendayApp({ holdingId: this.holdingId });
      } else if (action === "cancel-preview") this.preview = null;
      else if (action === "retry") await this._save(true);
      else {
        if (!this.permissions.canEditBuildings || this.pending) return;
        if (action === "staff-hire" && task?.isStaff) {
          const person = model.people.find((row) => row.id === id), candidate = workforceCandidate(model, person, task, this.service);
          if (candidate.reason) throw new Error(candidate.reason);
          if (!person.isStaff) this._change((draft) => setWorkforceStaff(draft, person.person, task));
          this.personId = id; this.view = "people"; this.filter = "all"; this.query = "";
        }
        else if (action === "staff-remove") this._change((draft) => removeWorkforceStaff(draft, id));
        else if (action === "staff-save") {
          const person = model.people.find((row) => row.id === id), appointment = person?.appointment;
          if (!appointment) throw new Error("Постоянное назначение больше не существует.");
          const value = (kind, fallback) => this.inputValues.get(`staff-${kind}:${id}`) ?? fallback;
          const primary = model.tasks.find((row) => row.buildingId === appointment.buildingId && row.functionId === value("primary", appointment.primaryFunctionId));
          if (!primary) throw new Error("Выберите доступную основную работу.");
          this._change((draft) => setWorkforceStaff(draft, person.person, primary, {
            reserveFunctionId: value("reserve", appointment.reserveFunctionId), overtimeQd: value("ot", appointment.overtimeQd),
            wageDailyCopper: this.permissions.isGM ? value("rate", appointment.wageDailyCopper) : appointment.wageDailyCopper,
            volunteer: this.permissions.isGM ? value("volunteer", appointment.volunteer) : appointment.volunteer,
            volunteerReason: this.permissions.isGM ? value("reason", appointment.volunteerReason) : appointment.volunteerReason
          }));
        }
        else if (action === "production-goal" && task?.hasProductionGoal) this._change((draft) => {
          const value = this.inputValues.get(`production-goal:${task.key}`) ?? task.preparedUnits;
          if (!Number.isSafeInteger(value) || value < 0 || value > 1000000) throw new Error("Объём подготовки: целое число от 0 до 1000000 ЕД.; 0 — без ограничения.");
          draft.plan.version = 2;
          draft.plan.productionGoals = (draft.plan.productionGoals ?? []).filter((row) => workforceKey(row) !== task.key);
          if (value) draft.plan.productionGoals.push({ sourceId: task.sourceId, functionId: task.functionId, preparedUnits: value });
        });
        else if (action === "goal" && task?.assignable) this._change((draft) => {
          const value = this.inputValues.get(`goal:${task.key}`) ?? task.goal;
          if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error("Цель: целое число от 0 до 10000 QD.");
          draft.plan.goals = draft.plan.goals.filter((row) => workforceKey(row) !== task.key);
          if (value) draft.plan.goals.push({ sourceId: task.sourceId, functionId: task.functionId, normalQd: value });
        });
        else if (["assign", "all-free"].includes(action) && task) this._change((draft) => {
          const person = model.people.find((row) => row.id === id), candidate = workforceCandidate(model, person, task, this.service);
          if (candidate.reason) throw new Error(candidate.reason);
          const qd = action === "all-free" ? candidate.existingNormal + candidate.free : this.inputValues.get(`qd:${id}:${task.key}`) ?? candidate.existingNormal;
          const overtime = action === "all-free" ? candidate.existingOvertime : this.inputValues.get(`ot:${id}:${task.key}`) ?? candidate.existingOvertime;
          Object.assign(draft, reviseWorkforceAssignment(this.base, draft, this.service,
            { ...this.planningOptions, personId: id, targetKey: task.key, normalQd: qd, overtimeQd: overtime }));
        });
        else if (action === "person-assign") this._change((draft) => {
          const destination = model.taskMap.get(this.personTargetKey);
          if (destination?.isStaff) {
            const person = model.people.find((row) => row.id === this.personId);
            const candidate = workforceCandidate(model, person, destination, this.service);
            if (candidate.reason) throw new Error(candidate.reason);
            setWorkforceStaff(draft, person.person, destination);
            return;
          }
          if (this.personQd + this.personOt <= 0) throw new Error("Укажите объём назначения больше нуля.");
          Object.assign(draft, reviseWorkforceAssignment(this.base, draft, this.service, { ...this.planningOptions,
            personId: this.personId, targetKey: this.personTargetKey, fromKey: this.personSource,
            normalQd: this.personQd, overtimeQd: this.personOt, add: true }));
        });
        else if (action === "remove") this._change((draft) => {
          const row = draft.allocations[id]?.find((entry) => workforceKey(entry) === key);
          if (row) setWorkforceAllocation(draft, id, { ...row, key }, 0, 0);
        });
        else if (action === "lock") this._change((draft) => {
          const appointment = draft.staffAppointments?.[id];
          const row = draft.allocations[id]?.find((entry) => workforceKey(entry) === key)
            ?? (appointment ? { sourceId: appointment.buildingId, functionId: appointment.primaryFunctionId } : null); if (!row) return;
          const lock = { personId: id, sourceId: row.sourceId, functionId: row.functionId }, lockId = workforceLockKey(lock);
          if (draft.plan.locks.some((entry) => workforceLockKey(entry) === lockId)) draft.plan.locks = draft.plan.locks.filter((entry) => workforceLockKey(entry) !== lockId);
          else draft.plan.locks.push(lock);
        });
        else if (["suggest", "preview-bulk", "fill", "idle"].includes(action)) {
          if (action === "preview-bulk" && (!task?.assignable || !this.selected.size)) throw new Error("Выберите работу и жителей для распределения.");
          const proposalDraft = copy(this.draft);
          if (action === "fill" && task && this.inputValues.has(`goal:${task.key}`)) {
            const value = this.inputValues.get(`goal:${task.key}`);
            if (!Number.isSafeInteger(value) || value < 0 || value > 10000) throw new Error("Цель: целое число от 0 до 10000 QD.");
            proposalDraft.plan.goals = proposalDraft.plan.goals.filter((row) => workforceKey(row) !== task.key);
            if (value) proposalDraft.plan.goals.push({ sourceId: task.sourceId, functionId: task.functionId, normalQd: value });
          }
          const proposal = action === "idle" ? proposeWorkforceIdleReview(this.base, proposalDraft, this.service, this.planningOptions)
            : proposeWorkforceAssignments(this.base, proposalDraft, this.service, { ...this.planningOptions,
              ...(action === "fill" ? { taskKeys: [task.key], useBuildingMinimum: true } : {}),
              ...(action === "preview-bulk" ? { taskKeys: [task.key], personIds: [...this.selected], qd: this.bulkQd } : {}) });
          const peopleCount = new Set(proposal.changes.map((row) => row.personId)).size;
          const addedQd = proposal.model.normalQd - model.normalQd;
          this.preview = { ...proposal, title: action === "idle" ? "Пересмотр простаивающих назначений" : proposal.changes.length
            ? `Подобрано: ${peopleCount} жителей · ${addedQd} QD` : "Подбор завершён: новых назначений нет",
            description: action === "idle" ? "Предложение освобождает только подтверждённый простой." : action === "preview-bulk" ? "Добавление указанного объёма выбранным жителям в пределах свободных QD."
              : `${action === "fill" ? "Выбранная работа: цель QD, текущий этап или установленный минимум здания." : "Сначала ежедневный уход, затем цели QD и текущие этапы работ."} Подбор использует свободные обычные QD; среди подходящих жителей сначала учитывает ставку, затем эффективность.`,
            wageBefore: model.wage, wageAfter: proposal.model.wage };
        } else if (action === "accept-preview" && this.preview) {
          const preview = this.preview;
          if (preview.discard) this._reset(this.latest.holding, this.latest.revision);
          else {
            if (preview.base) { this.base = preview.base; this.revision = preview.revision; this.initial = createWorkforceDraft(this.base, this.service); this.history = []; }
            this._change((draft) => Object.assign(draft, copy(preview.draft)));
            this.preview = null; this.inputValues.clear();
          }
        } else if (action === "undo") { if (this.history.length) this.draft = this.history.pop(); this.preview = null; this.inputValues.clear(); }
        else if (action === "discard") this.preview = { title: "Сбросить несохранённый черновик?", discard: true, changes: [], skipped: ["Будет загружен текущий общий план. Данные мира не изменятся."] };
        else if (action === "refresh") this._previewRefresh();
        else if (action === "save") await this._save(false);
      }
      if (["assign", "all-free"].includes(action)) {
        this.inputValues.delete(`qd:${id}:${task.key}`); this.inputValues.delete(`ot:${id}:${task.key}`);
      }
      if (["staff-save", "staff-remove"].includes(action)) {
        for (const field of ["primary", "reserve", "rate", "ot", "volunteer", "reason"]) this.inputValues.delete(`staff-${field}:${id}`);
      }
      if (action === "person-assign" && this.personSource) {
        const source = this.draft.allocations[this.personId]?.find((row) => workforceKey(row) === this.personSource);
        if (source) { this.personQd = Math.min(this.personQd, source.normalQd); this.personOt = Math.min(this.personOt, source.overtimeQd); }
      }
    } catch (error) { this.message = error.message || "Не удалось изменить план."; globalThis.ui?.notifications?.warn?.(this.message); }
    this.requestRender({ focus: false });
  }
  _previewRefresh() {
    const { holding, revision } = this.latest, fresh = createWorkforceDraft(holding, this.service), draft = copy(fresh), changes = [];
    for (const id of this.draft.edited) {
      const person = this._model.people.find((row) => row.id === id);
      if (!person || !fresh.allocations[id]) throw new Error("Часть изменённых жителей недоступна. Сохраните сведения из черновика и сбросьте его.");
      draft.allocations[id] = copy(this.draft.allocations[id]);
      draft.staffAppointments[id] = copy(this.draft.staffAppointments?.[id] ?? null); draft.edited.push(id);
      changes.push({ name: person.name, task: "Актуальные назначения → ваш черновик",
        before: staffWorkDescription(fresh.staffAppointments?.[id], this._model.taskMap) || this._allocationText(fresh.allocations[id], this._model),
        after: staffWorkDescription(draft.staffAppointments[id], this._model.taskMap) || this._allocationText(draft.allocations[id], this._model) });
    }
    for (const [kind, keyFor] of [["goals", workforceKey], ["locks", workforceLockKey], ["productionGoals", workforceKey]]) {
      const old = new Map((this.initial.plan[kind] ?? []).map((row) => [keyFor(row), row])), next = new Map((this.draft.plan[kind] ?? []).map((row) => [keyFor(row), row]));
      for (const key of new Set([...old.keys(), ...next.keys()])) {
        if (same(old.get(key), next.get(key))) continue;
        if (kind === "productionGoals") draft.plan.version = 2;
        draft.plan[kind] = (draft.plan[kind] ?? []).filter((row) => keyFor(row) !== key);
        if (next.has(key)) draft.plan[kind].push(copy(next.get(key)));
        changes.push({ name: kind === "goals" ? "Цель QD" : kind === "productionGoals" ? "Объём подготовки" : "Закрепление", task: key,
          before: JSON.stringify((fresh.plan[kind] ?? []).find((row) => keyFor(row) === key) ?? "нет"), after: JSON.stringify(next.get(key) ?? "нет") });
      }
    }
    const error = workforceDraftError(holding, draft, this.permissions); if (error) throw new Error(error);
    this.preview = { title: "Сверка с актуальным общим планом", base: copy(holding), revision, draft, changes,
      skipped: ["Затронутые назначения будут заменены вашим вариантом. Прочие изменения других окон сохраняются. После принятия проверьте план и нажмите «Сохранить»."] };
  }
  async _save(retry) {
    if (!retry) {
      if (!this.dirty || this.stale || this.preview) throw new Error("Сначала завершите проверку черновика.");
      const error = workforceDraftError(this.base, this.draft, this.permissions); if (error) throw new Error(error);
      this.pending = { holdingId: this.holdingId, operationId: makeId("workforce", 20), expectedRevision: this.revision, draft: copy(this.draft) };
    }
    if (!this.pending) return;
    this._busy = true;
    try {
      const result = await executeWorkforcePlan(this.pending);
      if (!result?.ok) { this.pending = null; throw new Error(result?.reason || "План не сохранён."); }
      this.pending = null; this.draft = null; this.message = "Общий план сохранён.";
      requestSkyholdAppRender(); this.constructor.rerenderOpen();
    } catch (error) {
      if (["conflict", "invalid", "forbidden", "execution-failed"].includes(error.code)) this.pending = null;
      throw error;
    } finally { this._busy = false; }
  }
  async close(options) {
    if (this.pending || this._busy) { globalThis.ui?.notifications?.warn?.("Дождитесь подтверждения сохранения или повторите запрос в этом окне."); return this; }
    if (this.dirty && !this._closingApproved) {
      this.preview = { title: "Закрыть окно с несохранённым черновиком?", discard: true, skipped: ["Сначала нажмите «Принять» для сброса или «Отмена», чтобы вернуться к редактированию."], changes: [] };
      this.requestRender({ focus: false }); return this;
    }
    this.listeners?.abort(); clearTimeout(this.searchTimer); this.disclosures.close(); this._unbindWindowFrameSync();
    if (this.constructor.instances.get(this.holdingId) === this) this.constructor.instances.delete(this.holdingId);
    return super.close(options);
  }
}
