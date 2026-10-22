import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { buildingLaborMode, staffAppointmentFor } from "../../data/hybrid-labor.js";
import { proposedBuildingLaborProfile } from "../../data/building-labor-catalog.js";
import { buildWorkAllocationTargets } from "../../data/work-allocations.js";
import { residentLaborCapacity } from "../../data/labor-budget.js";
import { planHybridLaborMigration, planHybridLaborCatalogMigration } from "../../workflows/buildings/hybrid-labor-migration.js";
import { executeHybridLaborMigration } from "../hybrid-labor-migration-executor.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { WindowFrameMixin } from "../common/window-frame.js";
import { requestSkyholdAppRender } from "../registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const clone = (value) => structuredClone(value);
const modes = [["staff", "Постоянный штат"], ["qd", "Задания по QD"], ["passive", "Без работников"]];
const active = (row) => Number(row?.normalQd) > 0 || Number(row?.overtimeQd) > 0;
const optionsFor = (selected) => [{ value: "", label: "Выберите способ", selected: !selected }, ...modes.map(([value, label]) => ({ value, label, selected: value === selected }))];

export class SkyholdHybridLaborMigration extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  constructor({ holdingId, owner = null } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId; this.owner = owner;
    this.profiles = {}; this.catalogProfiles = {}; this.decisions = {};
    this.includeCatalog = false; this.clearUnavailable = false; this.error = ""; this.status = "";
    this._refresh();
    this.dataHook = globalThis.Hooks?.on?.("fblSkyholdDataChanged", () => {
      this.stale = true;
      if (this.rendered) this.requestRender({ focus: false });
    });
  }
  async render(...args) {
    const first = !this.rendered, result = await super.render(...args);
    if (first && this.element) this._bindWindowFrameSync(this.element);
    return result;
  }
  _refresh() {
    this.base = clone(SkyholdData.get());
    this.holding = this.base.holdings?.find((row) => row.id === this.holdingId);
    this.stale = false; this.error = "";
    this._preview();
  }
  _preview() {
    if (!this.holding) { this.plan = null; this.error = "Поселение не найдено."; return; }
    const staffAppointments = {}, workAllocations = {};
    for (const [id, decision] of Object.entries(this.decisions)) {
      const person = this.holding.people?.list?.find((row) => String(row.id) === id);
      if (!person) continue;
      if (decision.kind === "free") { staffAppointments[id] = null; workAllocations[id] = []; }
      else if (decision.kind === "keep-qd") workAllocations[id] = clone(person.workAllocations ?? []);
      else if (decision.kind === "qd") {
        staffAppointments[id] = null;
        workAllocations[id] = [{ schemaVersion: 1, id: `migration-${id}`, sourceId: decision.buildingId,
          functionId: decision.functionId, normalQd: decision.normalQd ?? residentLaborCapacity(person).normalQd, overtimeQd: 0 }];
      } else if (decision.kind === "staff") staffAppointments[id] = {
        version: 1, buildingId: decision.buildingId, primaryFunctionId: decision.primaryFunctionId ?? "",
        reserveFunctionId: decision.reserveFunctionId ?? "", wageDailyCopper: decision.wageDailyCopper ?? 0,
        overtimeQd: decision.overtimeQd ?? 0, volunteer: decision.volunteer === true, volunteerReason: decision.volunteerReason ?? ""
      };
    }
    this.plan = planHybridLaborMigration({ holding: this.holding, profiles: this.profiles, staffAppointments, workAllocations,
      clearUnavailablePlanReferences: this.clearUnavailable });
    this.catalogPlan = this.includeCatalog ? planHybridLaborCatalogMigration({ catalog: this.base.catalog, profiles: this.catalogProfiles }) : null;
    this.operationId = makeId("hybrid-labor-migration", 20);
  }
  _buildingRow(building, catalog = false) {
    const profile = (catalog ? this.catalogProfiles : this.profiles)[building.id]
      ?? (buildingLaborMode(building) === "legacy" ? proposedBuildingLaborProfile(catalog ? building.id : building.templateId) : building.labor);
    return { id: building.id, name: building.name || building.id, scope: catalog ? "catalog" : "building",
      modeOptions: optionsFor(profile?.mode), qd: profile?.mode === "qd", capacity: profile?.capacityQd ?? "",
      previous: buildingLaborMode(building) === "legacy" ? "Прежние правила" : modes.find(([mode]) => mode === buildingLaborMode(building))?.[1] || "Требует проверки" };
  }
  _hasChanges() {
    return Boolean(this.plan && this.plan.sourceHash !== this.plan.targetHash
      || this.catalogPlan && this.catalogPlan.sourceHash !== this.catalogPlan.targetHash);
  }
  async _prepareContext(options) {
    const context = await super._prepareContext(options), target = this.plan?.targetHolding ?? this.holding;
    const targets = buildWorkAllocationTargets(target), targetBuildings = target?.buildings?.list ?? [];
    const affectedIds = new Set((this.plan?.issues ?? []).map((row) => row.personId).filter(Boolean));
    const people = (this.holding?.people?.list ?? []).filter((person) => affectedIds.has(String(person.id)) || !person.dead && (
      this.decisions[person.id] || staffAppointmentFor(person)
      || (person.workAllocations ?? []).some(active)
      || (this.holding.buildings?.list ?? []).some((building) => (building.assignedWorkerIds ?? []).includes(person.id)
        || [building.id, building.name].includes(person.workAssignment)))).map((person) => {
      const id = String(person.id), decision = this.decisions[id] ?? {}, current = staffAppointmentFor(person);
      const selected = decision.kind === "staff" ? `staff:${decision.buildingId}` : decision.kind === "qd" ? `qd:${decision.buildingId}::${decision.functionId}` : decision.kind ?? "";
      const staffOptions = targetBuildings.filter((building) => buildingLaborMode(building) === "staff")
        .map((building) => ({ value: `staff:${building.id}`, label: `Штат: ${building.name}` }));
      const qdOptions = targets.filter((row) => row.functionId === "maintenance" || buildingLaborMode(targetBuildings.find((building) => building.id === row.buildingId)) === "qd")
        .map((row) => ({ value: `qd:${row.sourceId}::${row.functionId}`, label: `Одно задание QD: ${row.label}` }));
      const choices = [{ value: "", label: "Сохранить существующее, если совместимо" }, { value: "free", label: person.dead ? "Убрать ссылку на прежнюю работу умершего" : "Снять прежнюю работу и освободить" },
        ...(person.dead ? [] : [
        ...((person.workAllocations ?? []).some(active) ? [{ value: "keep-qd", label: "Сохранить все нынешние задания QD" }] : []), ...staffOptions, ...qdOptions])];
      const functions = targets.filter((row) => row.sourceId === decision.buildingId);
      return { id, name: person.name || id, previous: person.dead ? "Архивная запись: требуется только снятие старой ссылки" : current ? `Постоянный штат: ${current.buildingId}`
        : person.workAllocationMode === "explicit" ? (person.workAllocations ?? []).filter(active).map((row) => `${row.sourceId}: ${row.normalQd}+${row.overtimeQd} QD`).join("; ")
          : person.workAssignment || "Свободен",
      choices: choices.map((row) => ({ ...row, selected: row.value === selected })),
      staff: decision.kind === "staff", qd: decision.kind === "qd",
      primaryOptions: [{ value: "", label: "Выберите основную работу", selected: !decision.primaryFunctionId },
        ...functions.map((row) => ({ value: row.functionId, label: row.label, selected: row.functionId === decision.primaryFunctionId }))],
      reserveOptions: [{ value: "", label: "Без резервной работы", selected: !decision.reserveFunctionId },
        ...functions.map((row) => ({ value: row.functionId, label: row.label, selected: row.functionId === decision.reserveFunctionId }))],
      wage: decision.wageDailyCopper ?? 0, overtime: decision.overtimeQd ?? 0, normal: decision.normalQd ?? residentLaborCapacity(person).normalQd,
      volunteer: decision.volunteer === true, reason: decision.volunteerReason ?? "" };
    });
    const issues = [...(this.plan?.issues ?? []), ...(this.catalogPlan?.issues ?? [])];
    return { ...context, name: this.holding?.name || "", buildings: (this.holding?.buildings?.list ?? []).map((row) => this._buildingRow(row)),
      people, includeCatalog: this.includeCatalog, clearUnavailable: this.clearUnavailable,
      catalogRows: this.includeCatalog ? (this.base.catalog?.buildings ?? []).map((row) => this._buildingRow(row, true)) : [],
      issues, error: this.error, status: this.status, stale: this.stale, busy: this.busy,
      canApply: game.user?.isGM === true && this.plan?.ok && (!this.catalogPlan || this.catalogPlan.ok) && this._hasChanges() && !this.stale && !this.busy,
      summary: `${this.plan?.changes.length ?? 0} построек · ${this.catalogPlan?.changes.length ?? 0} шаблонов · ${issues.length} препятствий` };
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    this.listeners?.abort(); this.listeners = new AbortController();
    const signal = this.listeners.signal;
    this.element.addEventListener("change", (event) => this._change(event), { signal });
    this.element.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-action]")?.dataset.action;
      if (action === "hybrid-migration-refresh") { event.preventDefault(); this._refresh(); this.requestRender({ focus: false }); }
      if (action === "hybrid-migration-apply") { event.preventDefault(); void this._apply(); }
    }, { signal });
  }
  _change(event) {
    const field = event.target, kind = field.dataset.hybridField;
    if (!kind || !game.user?.isGM || this.busy) return;
    try {
      if (kind === "includeCatalog") this.includeCatalog = field.checked;
      else if (kind === "clearUnavailable") this.clearUnavailable = field.checked;
      else if (["mode", "capacity"].includes(kind)) {
        const catalog = field.dataset.scope === "catalog", id = field.dataset.id;
        const map = catalog ? this.catalogProfiles : this.profiles;
        const row = (catalog ? this.base.catalog?.buildings : this.holding.buildings?.list)?.find((value) => value.id === id);
        const previous = map[id] ?? row?.labor ?? proposedBuildingLaborProfile(catalog ? row.id : row?.templateId);
        if (kind === "mode") {
          if (!field.value) delete map[id];
          else map[id] = { version: 1, mode: field.value, capacityQd: previous?.capacityQd ?? null };
        } else {
          const value = field.value.trim() === "" ? null : Number(field.value);
          if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Предел QD — целое число от нуля или пустое поле.");
          map[id] = { ...previous, version: 1, capacityQd: value };
        }
      } else {
        const id = field.dataset.personId, person = this.holding.people.list.find((row) => String(row.id) === id);
        if (kind === "decision") {
          if (!field.value) delete this.decisions[id];
          else if (field.value.startsWith("staff:")) {
            const buildingId = field.value.slice(6), building = this.holding.buildings.list.find((row) => row.id === buildingId);
            const prior = staffAppointmentFor(person);
            this.decisions[id] = { ...(prior?.buildingId === buildingId ? clone(prior) : {}), kind: "staff", buildingId,
              wageDailyCopper: prior?.buildingId === buildingId ? prior.wageDailyCopper : person.wageDailyOverrideCopper ?? building.wageDailyCopper ?? 0,
              volunteer: prior?.buildingId === buildingId ? prior.volunteer : person.volunteerLabor === true,
              volunteerReason: prior?.buildingId === buildingId ? prior.volunteerReason : person.volunteerReason ?? "" };
          } else if (field.value.startsWith("qd:")) {
            const [buildingId, functionId] = field.value.slice(3).split("::");
            this.decisions[id] = { kind: "qd", buildingId, functionId, normalQd: residentLaborCapacity(person).normalQd };
          } else this.decisions[id] = { kind: field.value };
        } else if (this.decisions[id]) {
          const key = { primary: "primaryFunctionId", reserve: "reserveFunctionId", wage: "wageDailyCopper", overtime: "overtimeQd", normal: "normalQd",
            volunteer: "volunteer", reason: "volunteerReason" }[kind];
          if (key) this.decisions[id][key] = field.type === "checkbox" ? field.checked : ["wage", "overtime", "normal"].includes(kind) ? Number(field.value) : field.value;
        }
      }
      this.error = ""; this._preview();
    } catch (error) { this.error = error.message; }
    this.requestRender({ focus: false });
  }
  async _apply() {
    if (!game.user?.isGM || this.busy || this.stale || !this._hasChanges() || !this.plan?.ok || this.catalogPlan && !this.catalogPlan.ok) return;
    this.busy = true; this.requestRender({ focus: false });
    const request = { holdingId: this.holdingId, holdingPlan: this.plan, catalogPlan: this.catalogPlan,
      expectedRevision: Number(this.base.meta?.revision ?? 0), operationId: this.operationId };
    try {
      const result = await executeHybridLaborMigration(request);
      if (!result?.ok) throw new Error(result?.reason || "Переход не сохранён.");
      this.decisions = {}; this.profiles = {}; this.catalogProfiles = {};
      this._refresh(); this.status = result.replay ? "Этот переход уже применён; повторной записи нет." : "Выбранный переход применён. Прежнее состояние сохранено для отката.";
      this.owner?.requestRender?.(); requestSkyholdAppRender();
    } catch (error) { this.error = error.message || "Не удалось сохранить переход."; }
    finally { this.busy = false; this.requestRender({ focus: false }); }
  }
  async close(options) {
    if (this.busy) { globalThis.ui?.notifications?.warn?.("Дождитесь завершения перехода."); return this; }
    return super.close(options);
  }
  async _onClose(options) {
    await super._onClose(options);
    this.listeners?.abort(); this._unbindWindowFrameSync();
    if (this.dataHook !== undefined) globalThis.Hooks?.off?.("fblSkyholdDataChanged", this.dataHook);
  }
}

SkyholdHybridLaborMigration.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-content-pack-importer", "fbl-skyhold-hybrid-labor-migration"], tag: "section",
  window: { title: "Переход к двум способам труда", icon: "fa-solid fa-people-arrows", resizable: true },
  position: { width: 1000, height: 760 }
};
SkyholdHybridLaborMigration.PARTS = { body: { template: `modules/${MODULE_ID}/templates/hybrid-labor-migration.hbs` } };
