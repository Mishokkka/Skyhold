import { MODULE_ID } from "../data/constants.js";
import { SkyholdData } from "../data/store.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { hydrateTendayOperation } from "../engines/tenday/operation-payload.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TABS = Object.freeze([
  { id: "summary", label: "Сводка", icon: "fa-solid fa-gauge-high" },
  { id: "economy", label: "Хозяйство", icon: "fa-solid fa-industry" },
  { id: "events", label: "События", icon: "fa-solid fa-dice" },
  { id: "changes", label: "Точный diff", icon: "fa-solid fa-code-compare" }
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function displayValue(value) {
  const text = String(value ?? "").trim();
  return text || "—";
}

function signedNumber(value, formatter = (number) => String(number)) {
  const number = finiteNumber(value, 0);
  return `${number > 0 ? "+" : ""}${formatter(number)}`;
}

function changeDirectionClass(change = {}) {
  if (change.direction === "up") return "is-positive";
  if (change.direction === "down") return "is-negative";
  return "is-neutral";
}

function preparedChange(change = {}, owner = null) {
  let beforeText = change.beforeText ?? displayValue(change.before);
  let afterText = change.afterText ?? displayValue(change.after);
  if (change.key === "progress") {
    beforeText = `${beforeText}/${change.beforeTargetText ?? change.beforeTarget ?? "—"}`;
    afterText = `${afterText}/${change.afterTargetText ?? change.afterTarget ?? "—"}`;
  }
  if (["money", "debt"].includes(change.key) && owner?._formatCopperCurrency) {
    beforeText = owner._formatCopperCurrency(change.before);
    afterText = owner._formatCopperCurrency(change.after);
  }
  return {
    ...change,
    beforeText: displayValue(beforeText),
    afterText: displayValue(afterText),
    deltaText: change.deltaText ?? "",
    hasDelta: Number.isFinite(Number(change.delta)) && Math.abs(Number(change.delta)) > 0.0001,
    directionClass: changeDirectionClass(change)
  };
}

function preparedEntity(row = {}, owner = null) {
  return { ...row, changes: (row.changes ?? []).map((change) => preparedChange(change, owner)) };
}

function eventEffectText(effect = {}, owner = null) {
  const amount = finiteNumber(effect?.amount, 0);
  const formatted = signedNumber(amount, (value) => owner?._formatNumber?.(value) ?? String(value));
  const type = String(effect?.type ?? "resource");
  if (type === "money") return `Казна ${formatted} медных`;
  if (type === "development") return `${({ food: "Еда", technology: "Технологии", culture: "Культура", war: "Война" })[effect?.key] ?? effect?.key ?? "Развитие"} ${formatted}`;
  if (type === "modifier") return `Модификатор «${({ defense: "Оборона", reputation: "Репутация", morale: "Мораль" })[effect?.key] ?? effect?.key ?? "эффект"}» ${formatted}`;
  return `${effect?.name || effect?.resourceId || "Ресурс"} ${formatted}`;
}

function economySections(report = {}) {
  return [
    { key: "labor", title: "Трудовой пул", icon: "fa-solid fa-people-group", rows: report?.labor?.lines ?? [], warning: report?.labor?.ready === false },
    { key: "food", title: "Питание", icon: "fa-solid fa-bowl-food", rows: report?.foodSummary?.lines ?? [] },
    { key: "capital", title: "Капитал предприятий", icon: "fa-solid fa-landmark", rows: report?.capitalSummary?.lines ?? [], warning: (report?.capitalSummary?.blocked ?? 0) > 0 },
    { key: "production", title: "Произведено", icon: "fa-solid fa-gears", rows: report?.produced ?? [] },
    { key: "spoilage", title: "Порча при хранении", icon: "fa-solid fa-bacterium", rows: report?.spoiled ?? [], warning: true },
    { key: "income", title: "Доход", icon: "fa-solid fa-coins", rows: report?.income ?? [] },
    { key: "services", title: "Услуги", icon: "fa-solid fa-utensils", rows: report?.serviceSummary?.lines ?? [] },
    { key: "consumption", title: "Расходы производства", icon: "fa-solid fa-box-open", rows: report?.consumed ?? [] },
    { key: "construction", title: "Строительство и ремонт", icon: "fa-solid fa-person-digging", rows: report?.constructionSummary?.lines ?? [] },
    { key: "trade", title: "Торговля", icon: "fa-solid fa-shop", rows: report?.tradeSummary?.lines ?? [] },
    { key: "payroll", title: "Оплата труда", icon: "fa-solid fa-file-invoice-dollar", rows: report?.payroll?.lines ?? [], warning: (report?.payroll?.arrearsCopper ?? 0) > 0 },
    { key: "treasury", title: "Казна", icon: "fa-solid fa-vault", rows: report?.treasurySummary?.lines ?? [] },
    { key: "work", title: "Другие процессы", icon: "fa-solid fa-list-check", rows: report?.work ?? [] },
    { key: "skipped", title: "Не выполнено", icon: "fa-solid fa-triangle-exclamation", rows: report?.skipped ?? [], warning: true },
    { key: "formulas", title: "Броски и формулы", icon: "fa-solid fa-square-root-variable", rows: report?.formulas ?? [], technical: true }
  ].map((section) => ({ ...section, rows: section.rows.map((text) => ({ text: String(text) })) }))
    .filter((section) => section.rows.length > 0);
}

function attentionRows(prepared = {}) {
  const warnings = (prepared?.warnings ?? []).map((warning) => ({
    key: String(warning?.key ?? "warning"),
    severity: String(warning?.severity ?? "warning"),
    icon: warning?.severity === "danger" ? "fa-solid fa-circle-exclamation" : "fa-solid fa-triangle-exclamation",
    title: warning?.severity === "danger" ? "Критическое последствие" : "Требует внимания",
    text: String(warning?.text ?? "")
  }));
  const existing = new Set(warnings.map((row) => row.key));
  const readiness = (prepared?.readiness?.alerts ?? [])
    .filter((alert) => !existing.has(String(alert?.key ?? "")))
    .map((alert) => ({
      key: String(alert?.key ?? "readiness"),
      severity: String(alert?.severity ?? "info"),
      icon: String(alert?.icon ?? "fa-solid fa-circle-info"),
      title: String(alert?.title ?? "Перед десятником"),
      text: String(alert?.text ?? "")
    }));
  return [...warnings, ...readiness];
}

function resultStatus(prepared = {}, phase = "preview") {
  const rows = attentionRows(prepared);
  if (phase === "history") return { label: "Сохранённый отчёт", css: "is-complete", icon: "fa-solid fa-box-archive" };
  if (phase === "result") return { label: "Десятник проведён", css: "is-complete", icon: "fa-solid fa-circle-check" };
  if (rows.some((row) => row.severity === "danger")) return { label: "Есть тяжёлые последствия", css: "is-danger", icon: "fa-solid fa-circle-exclamation" };
  if (rows.length) return { label: "Требует внимания", css: "is-warning", icon: "fa-solid fa-triangle-exclamation" };
  return { label: "Расчёт готов", css: "is-ready", icon: "fa-solid fa-circle-check" };
}

export class SkyholdTendayApp extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Map();
  static preparedCache = new Map();

  static rememberPrepared(key, prepared) {
    this.preparedCache.delete(key);
    this.preparedCache.set(key, prepared);
    while (this.preparedCache.size > 20) this.preparedCache.delete(this.preparedCache.keys().next().value);
  }

  static open({ workflow = null, holdingId = "", qd = 40 } = {}) {
    const id = String(holdingId ?? "");
    const instanceKey = `live:${id}`;
    const existing = this.instances.get(instanceKey);
    if (existing) {
      if (workflow) existing.workflow = workflow;
      existing.qd = Math.max(40, Number(qd) || 40);
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ workflow, holdingId: id, qd, instanceKey });
    this.instances.set(instanceKey, app);
    const rendered = app.render({ force: true, focus: true });
    Promise.resolve(rendered).then(() => app.prepare()).catch((error) => app._setError(error));
    return app;
  }

  static openHistory({ workflow = null, holdingId = "", holdingName = "", operation = null } = {}) {
    const operationId = String(operation?.operationId ?? operation?.id ?? "");
    const id = String(holdingId ?? "");
    const instanceKey = `history:${id}:${operationId}`;
    const existing = this.instances.get(instanceKey);
    if (existing) {
      if (workflow) existing.workflow = workflow;
      existing.render({ force: true, focus: true });
      return existing;
    }
    const prepared = hydrateTendayOperation(operation, { holdingId: id, holdingName });
    if (!prepared) return null;
    if (workflow?._summarizeEconomyReport) prepared.report = workflow._summarizeEconomyReport(prepared.report);
    const app = new this({ workflow, holdingId: id, qd: prepared.qd, instanceKey });
    app.prepared = prepared;
    app.result = { ok: true, operationId };
    app.phase = "history";
    this.instances.set(instanceKey, app);
    app.render({ force: true, focus: true });
    return app;
  }

  constructor({ workflow = null, holdingId = "", qd = 40, instanceKey = "" } = {}, options = {}) {
    super(options);
    this.workflow = workflow;
    this.holdingId = String(holdingId ?? "");
    this.qd = Math.max(40, Number(qd) || 40);
    this.instanceKey = String(instanceKey || `live:${this.holdingId}`);
    this.activeTab = "summary";
    this.phase = "loading";
    this.prepared = null;
    this.result = null;
    this.error = "";
    this._operationToken = null;
    this._dataHookId = globalThis.Hooks?.on?.("fblSkyholdDataChanged", () => this._onDataChanged());
  }

  async _getWorkflow() {
    if (this.workflow) return this.workflow;
    const { getSkyholdWorkflowService } = await import("../workflows/skyhold-workflow-service.js");
    this.workflow = getSkyholdWorkflowService();
    return this.workflow;
  }

  async prepare() {
    if (this.phase === "loading" && this._operationToken) return;
    if (this.phase === "applying") return;
    const token = Symbol("tenday-prepare");
    this._operationToken = token;
    this.phase = "loading";
    this.error = "";
    this.result = null;
    this.requestRender({ focus: false });
    try {
      const workflow = await this._getWorkflow();
      if (!workflow?._prepareTendayOperation) throw new Error("Workflow десятника недоступен.");
      const cacheKey = `${this.holdingId}:${this.qd}`;
      const cached = this.constructor.preparedCache.get(cacheKey);
      const dataView = SkyholdData.view();
      const dataRevision = Math.max(0, Number(dataView?.meta?.revision) || 0);
      const dependencyHash = cached?.dependencyHash && cached?.dataRevision === dataRevision
        ? cached.dependencyHash
        : (workflow._tendayDependencyHash?.(dataView, this.holdingId) ?? "");
      const prepared = cached?.dependencyHash && cached.dependencyHash === dependencyHash
        ? cached
        : await workflow._prepareTendayOperation({ holdingId: this.holdingId, qd: this.qd, dataView, dependencyHash });
      if (this._operationToken !== token) return;
      if (!prepared?.ok) {
        this.prepared = null;
        this.phase = "error";
        this.error = String(prepared?.message || "Не удалось подготовить десятник.");
      } else {
        this.prepared = prepared;
        this.constructor.rememberPrepared(cacheKey, prepared);
        this.phase = "preview";
        this.error = "";
      }
    } catch (error) {
      if (this._operationToken !== token) return;
      this._setError(error);
    } finally {
      if (this._operationToken === token) this._operationToken = null;
      this.requestRender({ focus: false });
    }
  }

  _setError(error) {
    console.error("FBL Skyhold | Tenday window failed", error);
    this.phase = "error";
    this.error = String(error?.message ?? error ?? "Неизвестная ошибка десятника.");
    this._operationToken = null;
    this.requestRender?.({ focus: false });
  }

  _isStale(dataView = null) {
    return Boolean(this.prepared && !this.prepared.historical && this.phase === "preview" && !this.workflow?._isPreparedTendayCurrent?.(this.prepared, dataView));
  }

  _onDataChanged() {
    if (!this.rendered || !this.prepared || this.phase !== "preview") return;
    if (this._isStale()) this.requestRender({ focus: false });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const currentHolding = (data?.holdings ?? []).find((row) => String(row?.id ?? "") === this.holdingId) ?? null;
    const prepared = this.prepared;
    const stale = this._isStale(data);
    const phase = stale ? "stale" : this.phase;
    const report = prepared?.report ?? {};
    const changeSet = prepared?.changeSet ?? {};
    const owner = this.workflow;
    const changes = {
      core: [
        changeSet?.clock ? { ...preparedChange(changeSet.clock, owner), label: "Внутренние часы", beforeText: `${changeSet.clock.beforeText ?? changeSet.clock.before ?? 0} QD`, afterText: `${changeSet.clock.afterText ?? changeSet.clock.after ?? 0} QD` } : null,
        changeSet?.date ? preparedChange(changeSet.date, owner) : null,
        changeSet?.money && Math.abs(finiteNumber(changeSet.money.delta, 0)) > 0.0001 ? preparedChange(changeSet.money, owner) : null,
        changeSet?.debt && Math.abs(finiteNumber(changeSet.debt.delta, 0)) > 0.0001 ? preparedChange(changeSet.debt, owner) : null,
        changeSet?.food && Math.abs(finiteNumber(changeSet.food.delta, 0)) > 0.0001 ? preparedChange(changeSet.food, owner) : null
      ].filter(Boolean),
      resources: (changeSet?.resources ?? []).map((row) => preparedChange(row, owner)),
      items: (changeSet?.items ?? []).map((row) => preparedChange(row, owner)),
      buildings: (changeSet?.buildings ?? []).map((row) => preparedEntity(row, owner)),
      residents: (changeSet?.residents ?? []).map((row) => preparedEntity(row, owner)),
      development: (changeSet?.development ?? []).map((row) => preparedChange(row, owner)),
      modifiers: (changeSet?.modifiers ?? []).map((row) => preparedChange(row, owner)),
      shipments: (changeSet?.shipments ?? []).map((row) => preparedEntity(row, owner))
    };
    const changeGroups = [
      { key: "core", title: "Ключевые значения", icon: "fa-solid fa-chart-line", rows: changes.core, simple: true },
      { key: "resources", title: "Ресурсы", icon: "fa-solid fa-boxes-stacked", rows: changes.resources, simple: true, locations: true },
      { key: "items", title: "Предметы", icon: "fa-solid fa-sack", rows: changes.items, simple: true, locations: true },
      { key: "buildings", title: "Здания и проекты", icon: "fa-solid fa-building", rows: changes.buildings, entities: true },
      { key: "residents", title: "Жители", icon: "fa-solid fa-people-group", rows: changes.residents, entities: true },
      { key: "development", title: "Развитие", icon: "fa-solid fa-arrow-trend-up", rows: changes.development, simple: true },
      { key: "modifiers", title: "Модификаторы", icon: "fa-solid fa-sliders", rows: changes.modifiers, simple: true },
      { key: "shipments", title: "Поставки", icon: "fa-solid fa-truck-fast", rows: changes.shipments, entities: true }
    ].filter((group) => group.rows.length > 0);
    const eventPlans = (prepared?.events?.entries ?? []).map((entry) => ({
      index: entry.index,
      reputationDice: Math.max(0, finiteNumber(entry?.reputation?.reputation, 0)),
      generalAvailable: Boolean(entry?.general)
    }));
    const liveDecisions = new Map((currentHolding?.gm?.lastRoll?.events ?? []).map((event) => [String(event?.decisionId ?? ""), event]));
    const eventResults = (prepared?.events?.events ?? []).map((event) => {
      const decisionId = String(event?.decisionId ?? "");
      const liveDecision = liveDecisions.get(decisionId) ?? null;
      const effectStatus = String(liveDecision?.effectStatus ?? event?.effectStatus ?? ((event.effects ?? []).length ? "pending" : "none"));
      const hasEffects = (event.effects ?? []).some((effect) => Math.abs(finiteNumber(effect?.amount, 0)) > 0.0001);
      const decisionStatus = {
        pending: { label: "Требует решения", css: "is-pending", icon: "fa-solid fa-hourglass-half" },
        applied: { label: "Применено", css: "is-applied", icon: "fa-solid fa-check" },
        scheduled: { label: "Отложено", css: "is-scheduled", icon: "fa-solid fa-calendar-plus" },
        none: { label: "Без автоэффектов", css: "is-none", icon: "fa-solid fa-minus" }
      }[effectStatus] ?? { label: effectStatus, css: "is-none", icon: "fa-solid fa-minus" };
      return {
        ...event,
        decisionId,
        effectStatus,
        decisionStatus,
        isExternal: event.kind === "external",
        kindLabel: event.kind === "external" ? "Внешнее событие" : "Общее событие",
        visibilityLabel: event.visibility === "gm" ? "Только GM" : "Публичное",
        newcomerText: event.newcomer ? "да" : "нет",
        hasGmText: Boolean(String(event.gmText ?? "").trim()),
        hasEffects,
        canApplyDecision: phase === "result" && hasEffects && effectStatus === "pending" && Boolean(liveDecision),
        canScheduleDecision: phase === "result" && hasEffects && effectStatus === "pending" && Boolean(liveDecision),
        effects: (event.effects ?? []).filter((effect) => Math.abs(finiteNumber(effect?.amount, 0)) > 0.0001).map((effect) => ({ text: eventEffectText(effect, owner) })),
        rollText: event.roll && event.totalWeight ? `${event.roll}/${event.totalWeight}` : "—"
      };
    });
    const attention = prepared ? attentionRows(prepared) : [];
    const status = resultStatus(prepared, phase);
    const sections = economySections(report);
    const moneyDelta = finiteNumber(changeSet?.money?.delta, 0);
    const food = report?.food ?? {};
    const commonTable = food?.commonTable ?? null;
    const tableResidents = Math.max(0, finiteNumber(commonTable?.residentCount, 0));
    const tableCoverage = tableResidents > 0
      ? `стол ${Math.max(0, finiteNumber(commonTable?.coveredResidents, 0))}/${tableResidents}`
      : "";
    const foodMeta = finiteNumber(food.hungryResidentDays, 0) > 0
      ? `Голод: ${finiteNumber(food.hungryResidentDays, 0)} чел.-дн.`
      : [String(food.nutritionDiversityLabel ?? "").trim() || "Все накормлены", tableCoverage].filter(Boolean).join(" · ");
    const construction = report?.construction ?? {};
    const eventCount = eventResults.length;
    const hasPrepared = Boolean(prepared);
    return {
      ...context,
      phase,
      isLoading: phase === "loading",
      isPreview: phase === "preview",
      isApplying: phase === "applying",
      isResult: phase === "result",
      isError: phase === "error",
      isHistory: phase === "history",
      isStale: phase === "stale",
      error: this.error,
      holdingName: prepared?.holdingName ?? currentHolding?.name ?? "Владение",
      holdingMissing: !currentHolding,
      hasPrepared,
      canApply: phase === "preview" && Boolean(currentHolding),
      operationId: prepared?.operationId ?? this.result?.operationId ?? "",
      periodLabel: prepared?.periodLabel ?? "десятник",
      clock: prepared?.clock ?? null,
      dateText: prepared?.calendarAdvance?.dateTime
        ? String(prepared?.preparedHolding?.gm?.calendaria?.lastDateText ?? "")
        : (phase === "history" ? String(changeSet?.date?.afterText ?? changeSet?.date?.after ?? "") : ""),
      status,
      attention,
      hasAttention: attention.length > 0,
      tabs: TABS.map((tab) => ({ ...tab, active: tab.id === this.activeTab })),
      activeSummary: this.activeTab === "summary",
      activeEconomy: this.activeTab === "economy",
      activeEvents: this.activeTab === "events",
      activeChanges: this.activeTab === "changes",
      economySections: sections,
      hasEconomySections: sections.length > 0,
      changeGroups,
      hasChangeGroups: changeGroups.length > 0,
      eventPlans,
      eventResults,
      eventCount,
      eventEffectsPending: eventResults.filter((event) => event.effectStatus === "pending").reduce((sum, event) => sum + (event.effects?.length ?? 0), 0),
      dueEvents: (prepared?.dueEvents ?? []).map((event) => ({
        ...event,
        dueText: event?.dueLabel || `QD ${event?.dueQd ?? "—"}`,
        hasEffects: Boolean(event?.hasEffects || (event?.effects ?? []).some((effect) => Math.abs(finiteNumber(effect?.amount, 0)) > 0.0001))
      })),
      showEventResults: phase === "result" || phase === "history",
      outcomesLocked: phase === "preview" || phase === "stale" || phase === "applying",
      metrics: {
        clock: prepared?.clock ? `${prepared.clock.before} → ${prepared.clock.after} QD` : "—",
        moneyBefore: owner?._formatCopperCurrency?.(changeSet?.money?.before ?? 0) ?? String(changeSet?.money?.before ?? 0),
        moneyAfter: owner?._formatCopperCurrency?.(changeSet?.money?.after ?? 0) ?? String(changeSet?.money?.after ?? 0),
        moneyDelta: `${moneyDelta > 0 ? "+" : moneyDelta < 0 ? "−" : ""}${owner?._formatCopperCurrency?.(Math.abs(moneyDelta)) ?? Math.abs(moneyDelta)}`,
        moneyClass: moneyDelta > 0 ? "is-positive" : moneyDelta < 0 ? "is-negative" : "is-neutral",
        foodText: `${finiteNumber(food.eaten, 0)} / ${finiteNumber(food.needed, 0)}`,
        hungerText: foodMeta,
        constructionText: `${finiteNumber(construction.attempts, 0)} попыток`,
        constructionMeta: `${finiteNumber(construction.completed, 0)} завершено`,
        eventsText: phase === "result" || phase === "history" ? `${eventCount} событий` : `${eventPlans.length} общих проверок`,
        eventsMeta: `${prepared?.dueEvents?.length ?? 0} подошло по плану`
      },
      chatFailed: phase === "result" && this.result?.chatPosted === false,
      chatError: this.result?.chatError ?? ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._bindWindowFrameSync(root);
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "tenday-tab") return this._onTab(event, element);
      if (action === "tenday-apply") return this._onApply(event);
      if (action === "tenday-refresh" || action === "tenday-next") return this._onRefresh(event);
      if (action === "tenday-event-apply") return this._onEventDecision(event, element, "apply");
      if (action === "tenday-event-schedule") return this._onEventDecision(event, element, "schedule");
      if (action === "tenday-close") return this.close();
    }, { signal: controller.signal });
  }

  _onTab(event, element) {
    event.preventDefault();
    const tab = String(element?.dataset?.tab ?? "summary");
    if (!TABS.some((row) => row.id === tab) || tab === this.activeTab) return;
    this.activeTab = tab;
    this.requestRender({ focus: false });
  }

  async _onApply(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.phase !== "preview" || !this.prepared) return;
    if (this._isStale()) {
      this.requestRender({ focus: false });
      return;
    }
    this.phase = "applying";
    this.requestRender({ focus: false });
    try {
      const workflow = await this._getWorkflow();
      const result = await workflow?._applyPreparedTendayOperation?.(this.prepared);
      if (!result?.ok) {
        if (result?.stale) {
          this.phase = "preview";
          this.error = String(result.message || "Расчёт устарел.");
        } else {
          this.phase = "error";
          this.error = String(result?.message || "Не удалось провести десятник.");
        }
        return;
      }
      this.constructor.preparedCache.delete(`${this.holdingId}:${this.qd}`);
      this.result = result;
      this.phase = "result";
      this.error = "";
      this.activeTab = "summary";
      ui.notifications.info(`${this.prepared.periodLabel || "Десятник"} проведён.`);
    } catch (error) {
      this._setError(error);
    } finally {
      this.requestRender({ focus: false });
    }
  }

  async _onEventDecision(event, element, action = "apply") {
    event.preventDefault();
    event.stopPropagation();
    if (this.phase !== "result") return;
    const decisionId = String(element?.dataset?.decisionId ?? "");
    if (!decisionId) return;
    element.disabled = true;
    try {
      const method = action === "schedule" ? "_scheduleTendayEventDecision" : "_applyTendayEventDecision";
      const workflow = await this._getWorkflow();
      const result = await workflow?.[method]?.({ holdingId: this.holdingId, decisionId });
      if (!result?.ok) {
        if (!result?.cancelled) ui.notifications?.warn?.(result?.message || "Не удалось обработать решение события.");
        return;
      }
      const preparedEvent = (this.prepared?.events?.events ?? []).find((row) => String(row?.decisionId ?? "") === decisionId);
      if (preparedEvent) {
        preparedEvent.effectStatus = result.status;
        if (result.operationId) preparedEvent.effectOperationId = result.operationId;
        if (result.scheduleId) preparedEvent.scheduleId = result.scheduleId;
      }
      ui.notifications?.info?.(action === "schedule" ? "Событие добавлено в план следующего десятника." : `Эффекты применены: ${result.changes?.length ?? 0}.`);
    } catch (error) {
      console.error("FBL Skyhold | Tenday event decision failed", error);
      ui.notifications?.error?.("Не удалось обработать решение события. Подробности в консоли.");
    } finally {
      this.requestRender({ focus: false });
    }
  }

  _onRefresh(event) {
    event.preventDefault();
    event.stopPropagation();
    this.prepared = null;
    this.result = null;
    this.activeTab = "summary";
    return this.prepare();
  }

  async _onClose(options) {
    await super._onClose(options);
    this._operationToken = null;
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._unbindWindowFrameSync();
    if (this._dataHookId !== undefined && this._dataHookId !== null) globalThis.Hooks?.off?.("fblSkyholdDataChanged", this._dataHookId);
    this._dataHookId = null;
    if (SkyholdTendayApp.instances.get(this.instanceKey) === this) SkyholdTendayApp.instances.delete(this.instanceKey);
  }
}

SkyholdTendayApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-tenday-app"],
  tag: "section",
  window: { title: "Десятник", icon: "fa-solid fa-calendar-days", resizable: true },
  position: { width: 940, height: 760 }
};

SkyholdTendayApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/tenday-app.hbs` }
};
