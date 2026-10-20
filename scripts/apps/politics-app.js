import { MODULE_ID } from "../data/constants.js";
import { SkyholdData, requestPoliticsOperation } from "../data/store.js";
import { findReadableHoldingEntry } from "../data/access-guard.js";
import { politicsAvailability } from "../data/politics-availability.js";
import { normalizePoliticsState, POLITICS_SLOTS } from "../data/politics-state.js";
import { POLITICS_ARCHETYPES, resolvedPoliticsCatalog, resolvedPoliticsCore } from "../data/politics-balance.js";
import { politicsPeriodIndex, politicsRepresentativeArchetype,
  politicsEffects, politicsRepresentativeStatus, politicsRowUnlocked } from "../engines/politics/rules.js";
import { makeId } from "../data/utils.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { getSkyholdManager } from "./registry.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { focusApplicationContent } from "./common/window-focus-keeper.js";
import { bindFloatingTooltips, hideFloatingTooltip, showFloatingTooltip } from "./common/floating-tooltip.js";
import { politicsPermissionContext } from "../data/politics-permissions.js";
import { politicsDecisionView } from "./domains/politics-decision-view.js";
import { politicsDecisionContext } from "./politics-decision-context.js";
import { prepareControlContext } from "./domains/control-context.js";
import { executeControlWorkOperation } from "./control-work-executor.js";
import { confirmBuildingWorkerAdmission } from "./common/building-worker-admission.js";
import { createSafeIcon } from "../core/helpers.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TABS = [
  { id: "cabinet", label: "Кабинет", icon: "fa-solid fa-landmark", tooltip: "Действующие записи о стадии правления, хартии и представителе. ГМ может их изменять." },
  { id: "course", label: "Курс", icon: "fa-solid fa-scroll", tooltip: "Выбор директив, издание указов и просмотр текущих эффектов." },
  { id: "history", label: "История", icon: "fa-solid fa-clock-rotate-left", tooltip: "Публичный журнал оформленных политических актов." },
  { id: "control", label: "Контроль", icon: "fa-solid fa-shield-halved", tooltip: "Действующий расчёт порядка, охраны и влияния Контроля на риск беспорядков." }
];

const SLOT_META = {
  supply: { label: "Снабжение", icon: "fa-solid fa-wheat-awn" },
  order: { label: "Порядок", icon: "fa-solid fa-scale-balanced" },
  labor: { label: "Труд", icon: "fa-solid fa-hammer" },
  external: { label: "Внешние", icon: "fa-solid fa-globe" }
};

function decisionSummary(row) {
  const labels = { reputation: "Репутация", control: "Контроль", unrestControl: "Контроль против беспорядков",
    defense: "Оборона", morale: "Довольство", moraleIfFullyFed: "Довольство при полном питании",
    marketAccess: "УРС", externalFlowPercent: "Внешний поток, %", productionPercent: "Производство, %",
    constructionPercent: "Строительство, %", influenceCap: "Предел Влияния" };
  const parts = Object.entries(labels).filter(([key]) => row.effects?.[key]).map(([key, label]) =>
    `${label} ${row.effects[key] > 0 ? "+" : ""}${row.effects[key]}`);
  if (row.effects?.foodMultiplierPercent !== 100) parts.push(`Пища ${row.effects.foodMultiplierPercent}%`);
  return parts.join(" · ") || row.summary || "Без прямого числового эффекта";
}

function ceilingText(value) {
  return value === null || value === undefined ? "Нет полного охвата" : String(value);
}

export class SkyholdPoliticsApp extends WindowFrameMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2))) {
  static instances = new Map();

  static open({ holdingId = "", owner = null } = {}) {
    const key = String(holdingId ?? "");
    const existing = this.instances.get(key);
    if (existing) {
      if (owner) existing.owner = owner;
      existing.render({ force: true, focus: true });
      return existing;
    }
    const app = new this({ holdingId: key, owner });
    this.instances.set(key, app);
    app.render({ force: true, focus: true }).then(() => {
      if (!app.element) return;
      app.setPosition(this.DEFAULT_OPTIONS.position);
      app._bindWindowFrameSync(app.element);
    }).catch((error) => {
      this.instances.delete(key);
      console.error("FBL Skyhold | Failed to open politics window", error);
      globalThis.ui?.notifications?.error?.("Не удалось открыть окно Политики.");
    });
    return app;
  }

  static rerenderOpen() {
    for (const app of this.instances.values()) {
      app.requestRender({ focus: false });
    }
  }

  constructor({ holdingId = "", owner = null } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.owner = owner;
    this.activeTab = "cabinet";
    this.previewAsPlayer = false;
    this._politicsRetries = new Map();
    this._politicsBusy = false;
  }

  _isPlayerPreview() {
    return globalThis.game?.user?.isGM === true && this.previewAsPlayer === true;
  }

  _viewUser() {
    const user = globalThis.game?.user;
    return this._isPlayerPreview() ? { id: user.id, isGM: false } : user;
  }

  _togglePlayerPreview() {
    if (!globalThis.game?.user?.isGM) return;
    this.previewAsPlayer = !this.previewAsPlayer;
    this._viewToggleFocusPending = true;
    this.requestRender({ focus: false });
  }

  _syncViewToggle(root, { signal } = {}) {
    const header = this._getWindowFrameElement(root)?.querySelector?.(".window-header");
    if (!header) return;
    let button = header.querySelector(".fbls-politics-view-toggle");
    if (!globalThis.game?.user?.isGM) {
      button?.remove();
      return;
    }
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "fbls-button fbls-button-role fbls-politics-view-toggle";
      const controls = header.querySelector(".window-controls, .header-control, .window-header-buttons");
      if (controls?.parentElement === header) header.insertBefore(button, controls);
      else header.appendChild(button);
    }
    const preview = this._isPlayerPreview();
    button.title = preview ? "Вид игрока: предпросмотр без сохранения. Нажмите, чтобы вернуться к виду ГМа." : "Посмотреть окно Политики с правами и видимостью игрока.";
    button.setAttribute("aria-label", preview ? "Вернуться к виду ГМа" : "Включить вид игрока");
    button.setAttribute("aria-pressed", String(preview));
    const label = document.createElement("span");
    label.textContent = preview ? "Вид игрока" : "Вид ГМа";
    button.replaceChildren(createSafeIcon(preview ? "fa-solid fa-eye" : "fa-solid fa-crown"), label);
    button.addEventListener("pointerdown", (event) => event.stopPropagation(), { signal });
    button.addEventListener("mousedown", (event) => event.stopPropagation(), { signal });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._togglePlayerPreview();
    }, { signal });
    if (this._viewToggleFocusPending) {
      this._viewToggleFocusPending = false;
      button.focus({ preventScroll: true });
    }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const viewUser = this._viewUser();
    const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false, user: viewUser });
    if (!holding) return { ...context, hasHolding: false, tabs: [] };

    const manager = getSkyholdManager() ?? this.owner;
    const culture = manager?._developmentSummary?.(holding)?.totals?.culture ?? 0;
    const availability = politicsAvailability(holding, culture);
    const politics = normalizePoliticsState(holding.politics);
    const periodIndex = politicsPeriodIndex(holding?.gm?.calendaria?.lastQd);
    const representativeStatus = politicsRepresentativeStatus(politics, holding, periodIndex);
    const balance = holding?.gm?.politicsBalance ?? {};
    const catalog = resolvedPoliticsCatalog(balance);
    const decisionContext = politicsDecisionContext(holding, manager, { data });
    const archetypeId = politicsRepresentativeArchetype(holding, politics, periodIndex);
    const decisions = politicsDecisionView(holding, { state: politics, catalog, balance, periodIndex,
      context: decisionContext, archetypeId, summary: decisionSummary, slotMeta: SLOT_META });
    const permission = politicsPermissionContext(holding, { user: viewUser });
    const effectPreview = politicsEffects(holding, { ...decisionContext, periodIndex });
    const canManagePolitics = viewUser?.isGM === true;
    const hasIntel = politics.activeDecrees.some((entry) => entry.decreeId === "intel-support" && !entry.cancelled && !entry.used
      && entry.issuedPeriodIndex <= periodIndex && periodIndex < entry.expiresPeriodIndex);
    const showPoliticsPanels = ((availability.available || hasIntel) && permission.canView) || canManagePolitics;
    const activeTab = showPoliticsPanels ? this.activeTab : "control";
    const rawMorale = manager?._calculateMorale?.(holding) ?? 0;
    const control = manager?._controlSummary?.(holding, rawMorale)
      ?? settlementControlSummary(holding, { rawMorale });
    const sources = control.sources.filter((source) => {
      if (viewUser?.isGM) return true;
      const owner = source.sourceKind === "building" ? holding.buildings?.list?.find((row) => String(row.id) === String(source.id))
        : source.sourceKind === "appointment" ? holding.people?.list?.find((row) => `sheriff:${row.id}` === source.id) : null;
      return owner?.visibility !== "gm";
    });

    return {
      ...context,
      hasHolding: true,
      revision: Number(data?.meta?.revision),
      holdingName: holding.name || "Поселение",
      available: availability.available,
      showPoliticsPanels,
      tabs: (showPoliticsPanels ? TABS : TABS.slice(-1)).map((tab) => ({
        ...tab,
        active: tab.id === activeTab
      })),
      panels: Object.fromEntries(TABS.map((tab) => [tab.id, tab.id === activeTab])),
      periodIndex,
      canManagePolitics,
      canUseDirectives: permission.canUseDirectives,
      canIssueDecrees: permission.canIssueDecrees,
      canRequestIntel: permission.canRequestIntel,
      canPetition: permission.canPetition,
      approvalRequired: !viewUser?.isGM && politics.stage === "charter" && politics.charter.approvalRequired,
      politicsReadOnlyReason: !permission.writable ? "Для отправки обращения или решения нужен активный ГМ и доступный socket." : "",
      petitions: politics.petitions.map((entry) => ({ id: entry.id, message: entry.message, response: entry.response, pending: entry.status === "pending" })),
      requests: politics.pendingApprovals.map((entry) => ({ id: entry.id,
        decreeId: catalog.find((row) => row.id === (entry.decreeId?.startsWith("custom-") ? entry.decreeId : `decree:${entry.decreeId}`))?.label ?? entry.decreeId,
        topic: entry.topic, response: entry.response,
        status: { pending: "Ожидает решения", approved: "Одобрена", rejected: "Отклонена", resolved: "Завершена" }[entry.status] ?? entry.status,
        pending: entry.status === "pending" })),
      systemChangePrice: politics.systemChange.chosenForStage ? resolvedPoliticsCore(balance).systemChangeInfluence : 0,
      systemNextAllowed: politics.systemChange.lastChangedPeriodIndex === null ? null
        : politics.systemChange.lastChangedPeriodIndex + resolvedPoliticsCore(balance).systemChangeCooldown,
      canRenewRepresentative: !representativeStatus.vacant && representativeStatus.expired,
      politics: {
        ...politics,
        stageLabel: { protectorate: "Протекторат", charter: "Хартия", selfRule: "Самоуправление" }[politics.stage] ?? politics.stage,
        systemLabel: { governor: "Наместник", "elder-council": "Совет общины", "elected-head": "Избранный глава", "guild-council": "Гильдейский совет" }[politics.system] ?? politics.system,
        representativeName: representativeStatus.resident?.name ?? "Не назначен",
        representativeExpired: representativeStatus.expired,
        representativeExpiry: representativeStatus.expiresPeriodIndex,
        representativeExpiringSoon: representativeStatus.expiringSoon,
        representativeRemaining: representativeStatus.remainingPeriods,
        history: [...politics.history].reverse().map((entry) => ({ ...entry,
          summary: entry.summary || (entry.type === "directive"
            ? `Директива «${SLOT_META[entry.slot]?.label ?? entry.slot}»: ${catalog.find((row) => row.id === (entry.directiveId?.startsWith("custom-") ? entry.directiveId : `directive:${entry.directiveId}`))?.label ?? (entry.directiveId || "Обычный порядок")}.`
            : `Политический акт: ${entry.type ?? "запись"}.`) })),
        hasHistory: politics.history.length > 0
      },
      stageOptions: [
        { id: "protectorate", label: "Протекторат" },
        { id: "charter", label: "Хартия" },
        { id: "selfRule", label: "Самоуправление" }
      ].map((row) => ({ ...row, selected: row.id === politics.stage })),
      charterSlots: POLITICS_SLOTS.map((id) => ({
        id, label: { supply: "Снабжение", order: "Порядок", labor: "Труд", external: "Внешние" }[id],
        selected: politics.charter.allowedSlots.includes(id)
      })),
      charterSlotLabels: politics.charter.allowedSlots.map((id) => ({ supply: "Снабжение", order: "Порядок", labor: "Труд", external: "Внешние" }[id] ?? id)).join(" · ") || "нет",
      residentOptions: (holding?.people?.list ?? []).filter((person) => person?.id && !person?.dead).map((person) => ({
        id: person.id, name: person.name || "Житель", selected: String(person.id) === politics.representative.residentId
      })),
      canChooseSystem: availability.available && politics.stage === "selfRule",
      systemOptions: catalog.filter((row) => row.kind === "system").map((row) => ({
        id: row.id.slice(7), label: row.label, summary: decisionSummary(row),
        selected: politics.system === row.id.slice(7),
        unlocked: politicsRowUnlocked(row, decisionContext), reason: decisions.systemReasons[row.id]
      })),
      ...decisions,
      activeDecrees: politics.activeDecrees.filter((entry) => !entry.cancelled && !entry.used && entry.issuedPeriodIndex <= periodIndex && periodIndex < entry.expiresPeriodIndex).map((entry) => ({
        id: entry.decreeId, intel: entry.decreeId === "intel-support",
        label: catalog.find((row) => row.id === (entry.decreeId.startsWith("custom-") ? entry.decreeId : `decree:${entry.decreeId}`))?.label ?? entry.decreeId,
        expiresPeriodIndex: entry.expiresPeriodIndex
      })),
      effectPreview: decisionSummary({ effects: { ...effectPreview,
        foodMultiplierPercent: Math.round(effectPreview.foodMultiplier * 100) } }),
      representativeArchetypeLabel: POLITICS_ARCHETYPES.find((row) => row.id === archetypeId)?.label ?? "Не определён",
      personalPerks: archetypeId ? catalog.filter((row) => row.kind === "perk" && row.enabled !== false
        && (!row.archetypeId || row.archetypeId === archetypeId)).map((row) => ({
          label: row.label, effect: decisionSummary(row), unlocked: politicsRowUnlocked(row, { ...decisionContext, archetypeId })
        })) : [],
      control: {
        ...control,
        ...prepareControlContext(holding, data.catalog?.buildings ?? [], control, manager, { user: viewUser }),
        institutionalCeilingText: ceilingText(control.institutionalCeiling),
        sources,
        hasSources: sources.length > 0,
        covered: control.crimeDeficit === 0
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    if (!options?.isFirstRender) this._bindWindowFrameSync(root);
    bindFloatingTooltips(this, root);
    this._politicsAbortController?.abort?.();
    const controller = new AbortController();
    this._politicsAbortController = controller;
    this._syncViewToggle(root, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const controlSave = event.target?.closest?.("[data-control-save]");
      if (controlSave && root.contains(controlSave)) {
        event.preventDefault();
        controlSave.closest("form[data-control-assignment]")?.requestSubmit();
        return;
      }
      const save = event.target?.closest?.("[data-politics-save]");
      if (save && root.contains(save)) {
        event.preventDefault();
        save.closest("form[data-politics-action]")?.requestSubmit();
        return;
      }
      const tab = event.target?.closest?.("[data-politics-tab]");
      if (!tab || !root.contains(tab)) return;
      event.preventDefault();
      const id = String(tab.dataset.politicsTab ?? "");
      if (!context.tabs.some((row) => row.id === id)) return;
      this.activeTab = id;
      this.requestRender({ focus: true });
    }, { signal: controller.signal });
    root.addEventListener("submit", (event) => {
      const form = event.target?.closest?.("form[data-control-assignment]");
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      void this._submitControlAssignment(form, context);
    }, { signal: controller.signal });
    root.addEventListener("submit", async (event) => {
      const form = event.target?.closest?.("form[data-politics-action]");
      if (!form || !root.contains(form)) return;
      event.preventDefault();
      if (this._isPlayerPreview() || this._politicsBusy) return;
      const action = String(form.dataset.politicsAction ?? "");
      const allowed = context.canManagePolitics || (action === "petition" && context.canPetition)
        || (action === "directive" && context.canUseDirectives) || (action === "decree" && context.canIssueDecrees)
        || (action === "request-intel" && context.canRequestIntel);
      if (!allowed) return;
      const fields = new FormData(form);
      const value = (key) => String(fields.get(key) ?? "");
      const payload = action === "stage" ? { stage: value("stage"), reason: value("reason") }
        : action === "charter" ? {
          patronName: value("patronName"), terms: value("terms"), allowedSlots: fields.getAll("allowedSlots"),
          approvalRequired: fields.has("approvalRequired"), tributeCopper: value("tributeCopper"),
          tributeStartPeriodIndex: value("tributeStartPeriodIndex"), tributeEndPeriodIndex: value("tributeEndPeriodIndex")
        } : action === "representative" ? {
          residentId: value("residentId"), title: value("title"), note: value("note"),
          competencies: Object.fromEntries(["economy", "war", "diplomacy", "culture"].map((key) => [key, value(key)]))
        } : action === "influence" ? { delta: value("delta"), reason: value("reason") }
          : action === "system" ? { system: value("system"), governorInvited: fields.has("governorInvited"),
            exception: fields.has("exception"), reason: value("reason") }
            : action === "directive" ? { slot: value("slot"), directiveId: value("directiveId") }
              : action === "decree" ? { decreeId: value("decreeId") }
                : action === "petition" ? { message: value("message") }
                  : action === "resolve-petition" ? { id: value("id"), response: value("response") }
                    : action === "resolve-request" ? { id: value("id"), approved: value("approved") === "true", response: value("response") }
                      : action === "revolt" ? { active: value("active") === "true", reason: value("reason") }
                        : { decreeId: value("decreeId"), reason: value("reason"), topic: value("topic"), response: value("response") };
      if (action === "decree") {
        const row = context.courseDecrees.find((item) => item.id === payload.decreeId);
        if (!row || !globalThis.confirm?.(`${context.approvalRequired ? "Отправить заявку на указ" : "Издать указ"} «${row.label}»? Цена: ${row.price}. Срок: ${row.term}.${context.approvalRequired ? " Оплата будет проверена и списана при одобрении ГМа." : ""}`)) return;
      }
      this._politicsBusy = true;
      const retryKey = JSON.stringify({ action, payload });
      const command = this._politicsRetries.get(retryKey) ?? {
        operationId: makeId("politics", 20), expectedRevision: context.revision, action, payload, holdingId: this.holdingId
      };
      this._politicsRetries.set(retryKey, command);
      const button = form.querySelector("[data-politics-save]");
      if (button) button.disabled = true;
      try {
        const result = await requestPoliticsOperation(command);
        this._politicsRetries.delete(retryKey);
        if (!result.ok) globalThis.ui?.notifications?.warn?.(result.reason || "Политический акт не сохранён.");
        else globalThis.ui?.notifications?.info?.(result.summary || "Политический акт сохранён.");
        this.requestRender({ focus: false });
      } catch (error) {
        console.error("FBL Skyhold | Politics operation failed", error);
        if (!error.retryable) this._politicsRetries.delete(retryKey);
        globalThis.ui?.notifications?.error?.(error.message || "Не удалось сохранить политический акт.");
        if (error.code === "conflict") this.requestRender({ focus: false });
      } finally {
        this._politicsBusy = false;
        if (button) button.disabled = false;
      }
    }, { signal: controller.signal });
    root.addEventListener("focusin", (event) => {
      const target = event.target?.closest?.("[data-fbls-tooltip]");
      if (target && root.contains(target)) showFloatingTooltip(this, target);
    }, { signal: controller.signal });
    root.addEventListener("focusout", () => hideFloatingTooltip(this), { signal: controller.signal });
    root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideFloatingTooltip(this);
    }, { signal: controller.signal });
    focusApplicationContent(this, { root, options, preferredSelector: "[data-politics-tab][aria-current='page']" });
  }

  async _onClose(options) {
    this._politicsRetries.clear();
    this._politicsAbortController?.abort?.();
    hideFloatingTooltip(this);
    this._unbindWindowFrameSync();
    await super._onClose(options);
    this.owner = null;
    SkyholdPoliticsApp.instances.delete(this.holdingId);
  }

  async _submitControlAssignment(form, context) {
    if (this._isPlayerPreview()) {
      globalThis.ui?.notifications?.info?.("Это предпросмотр вида игрока. Для изменений вернитесь в вид ГМа.");
      return;
    }
    if (!context.control.canAssign) return;
    const action = String(form.dataset.controlAssignment ?? "");
    const buildingId = String(form.dataset.buildingId ?? "");
    const residentId = String(new FormData(form).get("residentId") ?? "");
    const key = JSON.stringify({ action, buildingId, residentId });
    this._controlWorkBusy ??= false;
    this._controlWorkRetries ??= new Map();
    if (this._controlWorkBusy) return;
    this._controlWorkBusy = true;
    const button = form.querySelector("[data-control-save]");
    if (button) button.disabled = true;
    try {
      const manager = getSkyholdManager() ?? this.owner;
      const data = SkyholdData.view();
      const { holding } = findReadableHoldingEntry(data, this.holdingId, { fallback: false });
      const building = holding?.buildings?.list?.find((row) => String(row.id) === buildingId);
      const person = holding?.people?.list?.find((row) => String(row.id) === residentId);
      const admission = action === "add" && building && person
        ? await confirmBuildingWorkerAdmission({ manager, building, person }) : { allowed: true };
      if (!admission.allowed || this._isPlayerPreview()) return;
      const operation = this._controlWorkRetries.get(key) ?? { operationId: makeId("control-work", 20),
        holdingId: this.holdingId, expectedRevision: context.revision, action, buildingId, residentId };
      this._controlWorkRetries.set(key, operation);
      const result = await executeControlWorkOperation({ ...operation, allowAdmissionOverride: admission.allowAdmissionOverride },
        { getManager: () => manager });
      this._controlWorkRetries.delete(key);
      if (result.ok) globalThis.ui?.notifications?.info?.(result.summary);
      else globalThis.ui?.notifications?.warn?.(result.reason || "Назначение не сохранено.");
      this.requestRender({ focus: false });
    } catch (error) {
      if (!error.retryable || error.code === "conflict") this._controlWorkRetries.delete(key);
      console.error("FBL Skyhold | Control assignment failed", error);
      globalThis.ui?.notifications?.error?.(error.message || "Не удалось сохранить назначение.");
      this.requestRender({ focus: false });
    } finally {
      this._controlWorkBusy = false;
      if (button) button.disabled = false;
    }
  }
}

SkyholdPoliticsApp.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-politics"],
  tag: "section",
  window: { title: "Управление поселением", icon: "fa-solid fa-scale-balanced", resizable: true },
  position: { width: 1080, height: 760 }
};
SkyholdPoliticsApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/politics-app.hbs` }
};
