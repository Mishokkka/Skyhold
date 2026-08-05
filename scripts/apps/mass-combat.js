import { MODULE_ID } from "../data/constants.js";
import { warnNoHoldingAccess } from "../data/access-guard.js";
import { HoldingService } from "../data/holding-service.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { SkyholdData } from "../data/store.js";
import { makeId } from "../data/utils.js";
import { escapeHtml, fieldValue } from "../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, replaceTabs, unbindGlobalInputGuard } from "../utils/input-guards.js";
import { dispatchDelegatedAction } from "./common/delegated-events.js";
import { bindFloatingTooltips, hideFloatingTooltip } from "./common/floating-tooltip.js";
import { RenderSchedulerMixin } from "./common/render-scheduler.js";
import { getSkyholdManager, requestSkyholdAppRender } from "./registry.js";
import { createFoundryChatMessage, foundryChatSpeaker, foundryDialogV2, playFoundryAudio } from "../integrations/foundry-runtime.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

import {
  ACCESS_MODES,
  ATTACKER_PRESETS,
  DEFENSE_MODES,
  ROUND_THREATS,
  SCALES,
  asInt,
  asNumber,
  clamp,
  selectOptions,
  strategyOptions,
  strategySummary,
  tagValue
} from "./mass-combat/rules.js";
import { getMassCombatTags, isMassCombatUnitTagField, massCombatTagField } from "./mass-combat/tag-config.js";
import { SkyholdCounterReferenceApp, SkyholdWeatherReferenceApp } from "./mass-combat/reference-windows.js";

import { medicalSupport } from "./mass-combat/casualties.js";

import { battleAftermathRows, startBattleRepairs } from "./mass-combat/damage.js";
import { roundChatContent } from "./mass-combat/chat.js";
import {
  applyAttackerPresetToState,
  normalizeManualMassCombatPatch,
  normalizeMassCombatPatch,
  pruneAttackerSourceOverrides,
  resetMassCombatState
} from "./mass-combat/state.js";
import { calculateBattle } from "./mass-combat/calculator.js";
import { battleTerminalState } from "./mass-combat/terminal.js";
import { applyPendingBattleRound, createPendingBattleRound, pendingBattleRoundContext } from "./mass-combat/round-resolution.js";
import { archiveBattle, battleArchiveContext } from "./mass-combat/archive.js";

function chanceText(value) {
  const chance = clamp(asInt(value, 0), 0, 6);
  return `${chance}/6 (${Math.round((chance / 6) * 100)}%)`;
}

function battleCalculationDependencies(manager = getSkyholdManager()) {
  const dependencies = {};
  if (typeof manager?._buildingEffectiveWorkers === "function") {
    dependencies.buildingEffectiveWorkers = (holding, building) => manager._buildingEffectiveWorkers(holding, building);
  }
  if (typeof manager?._calculateMorale === "function") {
    dependencies.calculateMorale = (holding) => manager._calculateMorale(holding);
  }
  if (typeof manager?._medicalAssignments === "function") {
    dependencies.medicalAssignments = (holding) => manager._medicalAssignments(holding);
  }
  if (typeof manager?._medicalCapacityForBuilding === "function") {
    dependencies.medicalCapacityForBuilding = (holding, building) => manager._medicalCapacityForBuilding(holding, building);
  }
  return dependencies;
}

function battleRepairReservationOptions(holding, operationId, manager = getSkyholdManager()) {
  return {
    operationId,
    reservedAt: new Date().toISOString(),
    reservedQd: holding?.gm?.calendaria?.lastQd,
    planCosts: typeof manager?._storageCanPay === "function"
      ? ({ holding: draft, costs }) => manager._storageCanPay(draft, costs)
      : null,
    takeResourceLots: typeof manager?._storageTakeLots === "function"
      ? (draft, row, qty) => manager._storageTakeLots(draft, row, qty)
      : null
  };
}

function buildMortalityHelp(holding, { calculationDependencies = {} } = {}) {
  const support = medicalSupport(holding, { battleLost: false, ...calculationDependencies });
  const hasCare = support.capacity > 0;
  const base = { broken: 1, injured: 2, heavy: 3 };
  const current = {
    broken: Math.max(0, base.broken - (hasCare ? 1 : 0)),
    injured: Math.max(0, base.injured - (hasCare ? 1 : 0)),
    heavy: Math.max(0, base.heavy - (hasCare ? 1 : 0))
  };
  const currentLine = hasCare
    ? `Сейчас с учетом лечебных зданий первые ${support.capacity} потерь получают лечение: перелом ${chanceText(current.broken)}, ранение ${chanceText(current.injured)}, тяжелое ${chanceText(current.heavy)}.`
    : `Сейчас свободных медмест нет: перелом ${chanceText(base.broken)}, ранение ${chanceText(base.injured)}, тяжелое ${chanceText(base.heavy)}.`;
  const short = hasCare
    ? `лечение ${support.capacity}: ${chanceText(current.injured)} / ${chanceText(current.heavy)}`
    : `без лечения: ${chanceText(base.injured)} / ${chanceText(base.heavy)}`;
  const tooltip = [
    "Impact по защитникам создает столько попыток потерь жителей.",
    "Кандидаты: оборонные отряды, гарнизоны, военные жители и поднятое ополчение. Неполное ополчение тоже рискует, даже если не дает кубов.",
    "Травма d6: 1 — перелом, 2–3 — ранение, 4–6 — тяжелое ранение.",
    `Смерть d6 без лечения: перелом ${chanceText(base.broken)}, ранение ${chanceText(base.injured)}, тяжелое ${chanceText(base.heavy)}.`,
    "Свободное медместо снижает шанс смерти одной потери на 1 шаг: перелом 0/6, ранение 1/6, тяжелое 2/6.",
    currentLine,
    `Медицина: ${support.text}.`,
    "Если трек защитников сломан или цель врага выполнена, бой считается проигранным: лечебные здания не успевают принять новых раненых этого раунда."
  ].join("\n");
  return { short, tooltip, support };
}

export class SkyholdMassCombatApp extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  static instances = new Set();

  static open({ holdingId } = {}, options = {}) {
    const id = String(holdingId ?? "");
    const existing = Array.from(SkyholdMassCombatApp.instances).find((app) => String(app?.holdingId ?? "") === id);
    const app = existing ?? new SkyholdMassCombatApp({ holdingId: id || holdingId });
    return app.render({ force: true, focus: true, ...options });
  }

  static rerenderOpen({ skipFocused = true } = {}) {
    for (const app of SkyholdMassCombatApp.instances) {
      const root = app.element;
      if (skipFocused && root && document.activeElement instanceof Element && root.contains(document.activeElement)) continue;
      app.render({ force: true, focus: false });
    }
  }

  constructor({ holdingId } = {}, options = {}) {
    super(options);
    this.holdingId = holdingId;
    this.collapsedSections = new Set();
    SkyholdMassCombatApp.instances.add(this);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    const manager = getSkyholdManager();
    const calculationDependencies = battleCalculationDependencies(manager);
    const state = holding?.gm?.massCombat ?? {};
    const pendingRound = pendingBattleRoundContext(state.pendingRound);
    const permissions = holdingPermissionContext(holding);
    const canResolveBattle = permissions.canResolveBattle;
    const canEdit = canResolveBattle && !pendingRound;
    const canEditDefender = permissions.canEditBattleSetup && !pendingRound;
    const defense = manager?._defenseSummary?.(holding) ?? { total: asNumber(holding?.overview?.defense, 0), tooltip: "" };
    const calc = calculateBattle(holding, state, { defenseTotal: defense.total, ...calculationDependencies });
    calc.mortalityHelp = buildMortalityHelp(holding, { calculationDependencies });
    const terminal = battleTerminalState(state, calc);

    return {
      ...context,
      canEdit,
      canEditDefender,
      permissions,
      holding,
      hasHolding: Boolean(holding),
      state,
      scaleOptions: selectOptions(SCALES, state.scale),
      defenseModeOptions: selectOptions(DEFENSE_MODES, state.defenseMode),
      accessModeOptions: selectOptions(ACCESS_MODES, state.accessMode),
      roundThreatOptions: selectOptions(ROUND_THREATS, calc.roundThreatKey),
      attackerPresetOptions: this._attackerPresetOptions(state.attackerPreset),
      selectedAttackerPreset: ATTACKER_PRESETS[state.attackerPreset] ?? ATTACKER_PRESETS.custom,
      useDefenseSquadsChecked: state.useDefenseSquads !== false,
      raiseMilitiaChecked: state.raiseMilitia === true,
      defenderStrategyOptions: strategyOptions(state.defenderStrategy, "defender"),
      attackerStrategyOptions: strategyOptions(state.attackerStrategy, "attacker"),
      defenderStrategySummary: strategySummary(calc.defenderStrategy, "defender"),
      attackerStrategySummary: strategySummary(calc.attackerStrategy, "attacker"),
      tagRows: this._tagRows(calc.effectiveState ?? state),
      defense,
      calc,
      terminal,
      pendingRound,
      battleArchive: battleArchiveContext(state.archive),
      canRollRound: canEdit && !terminal.finished && !pendingRound,
      canApplyPendingRound: canResolveBattle && Boolean(pendingRound),
      canFinalizeBattle: canResolveBattle && terminal.finished && state.phase !== "archived",
      logRows: (state.log ?? []).slice().reverse().map((row) => ({
        ...row,
        createdText: String(row.createdAt ?? "").replace("T", " ").slice(0, 16),
        marginText: row.margin > 0 ? `+${row.margin}` : String(row.margin ?? 0),
        breachText: row.breachDelta ? `Брешь +${row.breachDelta}` : "Брешь -",
        objectiveText: row.objectiveDelta ? `Часы ${row.objectiveDelta > 0 ? "+" : ""}${row.objectiveDelta}` : "Часы -",
        impactText: row.defenderImpact || row.attackerImpact ? `Impact З ${row.defenderImpact ?? row.defenderLossDelta ?? 0} / В ${row.attackerImpact ?? row.attackerLossDelta ?? 0}` : ""
      }))
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._bindInputGuards(root);
    this._bindGlobalInputGuard(root);
    bindFloatingTooltips(this, root);
    this._bindDelegatedEvents(root);
    this._applyCollapsedSections(root);
  }

  _bindDelegatedEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const listenerOptions = { signal: controller.signal };
    const clickActions = {
      "mass-roll-round": "_onRollRound",
      "mass-apply-round": "_onApplyPendingRound",
      "mass-discard-round": "_onDiscardPendingRound",
      "mass-finalize-battle": "_onFinalizeBattle",
      "mass-post-summary": "_onPostSummary",
      "mass-post-aftermath": "_onPostAftermath",
      "mass-start-repairs": "_onStartRepairs",
      "mass-reset": "_onResetBattle",
      "mass-clear-log": "_onClearLog",
      "mass-apply-preset": "_onApplyAttackerPreset",
      "mass-restore-source-type": "_onRestoreAttackerSourceType",
      "mass-restore-source-efficiency": "_onRestoreAttackerSourceEfficiency",
      "mass-toggle-tags": "_onToggleTagsPopover",
      "mass-toggle-section": "_onToggleSection",
      "mass-show-counters": "_onShowCounterHelp",
      "mass-show-weather": "_onShowWeatherHelp"
    };
    const dispatch = (event, element, handlerName) => {
      return dispatchDelegatedAction(this, event, element, handlerName);
    };

    root.addEventListener("change", (event) => {
      const presetSelect = event.target?.closest?.("[data-attacker-preset-select]");
      if (presetSelect && root.contains(presetSelect)) {
        dispatch(event, presetSelect, "_onAttackerPresetSelectionChange");
        return;
      }
      const field = event.target?.closest?.("[data-mass-field]");
      if (!field || !root.contains(field)) return;
      dispatch(event, field, "_onMassFieldChange");
    }, listenerOptions);

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (element && root.contains(element)) {
        const handlerName = clickActions[String(element.dataset.action ?? "")];
        if (handlerName) dispatch(event, element, handlerName);
      }
      if (event.target?.closest?.("[data-action='mass-toggle-tags'], [data-action='mass-show-counters'], [data-action='mass-show-weather'], .fbls-battle-tags-popover")) return;
      this._closeTagsPopover();
    }, listenerOptions);

    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const trigger = root.querySelector("[data-action='mass-toggle-tags']");
      if (!root.querySelector(".fbls-battle-tags-popover.open")) return;
      this._closeTagsPopover();
      trigger?.focus?.();
    }, listenerOptions);
  }

  _applyCollapsedSections(root = this.element) {
    if (!root) return;
    root.querySelectorAll("[data-battle-section]").forEach((section) => {
      const id = section.dataset.battleSection;
      const collapsed = this.collapsedSections.has(id);
      section.classList.toggle("is-collapsed", collapsed);
      const trigger = section.querySelector("[data-action='mass-toggle-section']");
      trigger?.setAttribute?.("aria-expanded", collapsed ? "false" : "true");
    });
  }

  _onToggleSection(event) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = event.currentTarget;
    const section = trigger?.closest?.("[data-battle-section]");
    const id = section?.dataset?.battleSection;
    if (!id) return;
    const collapse = !this.collapsedSections.has(id);
    const group = section?.dataset?.battleCollapseGroup;
    const sections = group
      ? [...this.element.querySelectorAll(`[data-battle-collapse-group="${group}"]`)]
      : [section];
    for (const target of sections) {
      const targetId = target?.dataset?.battleSection;
      if (!targetId) continue;
      if (collapse) this.collapsedSections.add(targetId);
      else this.collapsedSections.delete(targetId);
    }
    this._applyCollapsedSections();
  }

  _bindInputGuards(root) {
    bindInputGuards(root, { textareaSanitizer: (value) => replaceTabs(value, "  ") });
  }

  _bindGlobalInputGuard(root) {
    bindGlobalInputGuard(this, root);
  }

  _unbindGlobalInputGuard() {
    unbindGlobalInputGuard(this);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    hideFloatingTooltip(this);
    this._unbindGlobalInputGuard();
    SkyholdMassCombatApp.instances.delete(this);
    requestSkyholdAppRender();
  }

  _tagRows(state = {}) {
    return Object.entries(getMassCombatTags()).map(([key, tag]) => ({
      key,
      label: tag.label,
      short: tag.short,
      icon: tag.icon,
      hint: tag.hint,
      tooltip: `${tag.label} — ${tag.hint ?? ""}`,
      defenderField: massCombatTagField("defender", key),
      attackerField: massCombatTagField("attacker", key),
      defenderValue: tagValue(state, "defender", key),
      attackerValue: tagValue(state, "attacker", key)
    }));
  }

  _onToggleTagsPopover(event) {
    event.preventDefault();
    event.stopPropagation();
    const popover = this.element?.querySelector?.(".fbls-battle-tags-popover");
    if (!popover) return;
    const open = popover.classList.toggle("open");
    event.currentTarget?.setAttribute?.("aria-expanded", open ? "true" : "false");
  }

  _closeTagsPopover() {
    const root = this.element;
    root?.querySelector?.(".fbls-battle-tags-popover")?.classList.remove("open");
    root?.querySelector?.("[data-action='mass-toggle-tags']")?.setAttribute?.("aria-expanded", "false");
  }

  _onShowCounterHelp(event) {
    event.preventDefault();
    event.stopPropagation();
    return SkyholdCounterReferenceApp.open();
  }

  _onShowWeatherHelp(event) {
    event.preventDefault();
    event.stopPropagation();
    const data = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    if (!data?.holding) {
      warnNoHoldingAccess();
      return null;
    }
    const state = data?.holding?.gm?.massCombat ?? {};
    const calc = calculateBattle(data?.holding, state, { defenseTotal: 0, ...battleCalculationDependencies() });
    return SkyholdWeatherReferenceApp.open({
      catalog: calc?.weather?.catalog ?? [],
      currentKey: calc?.weather?.key ?? ""
    });
  }

  _attackerPresetOptions(selected = "custom") {
    const current = String(selected || "custom");
    return Object.entries(ATTACKER_PRESETS).map(([value, preset]) => ({
      value,
      label: preset.label,
      summary: preset.summary,
      selected: value === current
    }));
  }

  _compactNameList(names = [], limit = 4) {
    const clean = names.map((name) => String(name ?? "").trim()).filter(Boolean);
    if (clean.length <= limit) return clean.join(", ");
    return `${clean.slice(0, limit).join(", ")} и еще ${clean.length - limit}`;
  }

  async _onStartRepairs(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const operationId = makeId("battle-repair");
    const result = await HoldingService.updateHolding(this.holdingId, (holding) => {
      const repairs = startBattleRepairs(holding, battleRepairReservationOptions(holding, operationId));
      if (!repairs.started.length) {
        return SkyholdData.skipTransaction({
          ok: false,
          blocked: repairs.blocked.length,
          message: repairs.blocked[0]?.message ?? ""
        });
      }
      return { ok: true, count: repairs.started.length, blocked: repairs.blocked.length };
    });
    if (!result?.ok) {
      if (result?.blocked) ui.notifications.warn(result.message || "Ремонт не начат: не удалось зарезервировать материалы по смете.");
      else ui.notifications.info("Нет поврежденных зданий, которые можно отправить в ремонт.");
      return;
    }
    ui.notifications.info(`Ремонт начат: ${result.count} здан.${result.blocked ? ` Без материалов осталось: ${result.blocked}.` : ""}`);
    this.requestRender();
  }

  async _onPostAftermath(event) {
    event.preventDefault();
    event.stopPropagation();
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    if (!holding) {
      warnNoHoldingAccess();
      return;
    }
    const state = holding.gm?.massCombat ?? {};
    const rows = battleAftermathRows(holding, state, (names) => this._compactNameList(names));
    await createFoundryChatMessage({
      speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
      content: `
        <div class="fbls-chat-card">
          <h3>${escapeHtml(state.title || `Итог боя: ${holding.name || "владение"}`)}</h3>
          <p><strong>Враг:</strong> ${escapeHtml(state.enemyName || "Нападающие")}. <strong>Цель:</strong> ${escapeHtml(state.objective || "не задана")}.</p>
          <p><strong>Треки:</strong> защитники ${asInt(state.defenderLossSteps ?? state.defenderLosses, 0)}, враг ${asInt(state.attackerLossSteps ?? state.attackerLosses, 0)}, урон ${asInt(state.settlementDamage, 0)}, брешь ${asInt(state.breachProgress, 0)}, цель ${asInt(state.objectiveProgress, 0)}.</p>
          <p><strong>Жители:</strong> ${escapeHtml(rows.peopleText)}</p>
          <p><strong>Здания:</strong> ${escapeHtml(rows.buildingText)}</p>
        </div>
      `
    });
  }

  async _onFinalizeBattle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const action = await this._chooseAftermathAction();
    if (!action || action === "cancel") return;
    const repairOperationId = makeId("battle-repair");
    const result = await HoldingService.updateHolding(this.holdingId, (holding) => {
      const state = holding?.gm?.massCombat;
      if (!state) return SkyholdData.skipTransaction({ ok: false, reason: "missing" });
      const manager = getSkyholdManager();
      const calculationDependencies = battleCalculationDependencies(manager);
      const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
      const terminal = battleTerminalState(state, calculateBattle(holding, state, { defenseTotal, ...calculationDependencies }));
      if (!terminal.finished) return SkyholdData.skipTransaction({ ok: false, reason: "active" });
      state.outcome = terminal.outcome;
      state.terminalReason = terminal.reason;
      state.resolvedAt = state.resolvedAt || new Date().toISOString();
      state.resolvedBy = state.resolvedBy || String(game.user?.id ?? "");
      const archive = archiveBattle(state, {
        outcome: terminal.outcome,
        terminalReason: terminal.reason,
        resolvedAt: state.resolvedAt,
        resolvedBy: state.resolvedBy,
        reason: "resolved"
      });
      const repairs = action === "archive-repair"
        ? startBattleRepairs(holding, battleRepairReservationOptions(holding, repairOperationId))
        : { started: [], blocked: [] };
      state.phase = "archived";
      return { ok: true, archive, repairCount: repairs.started.length, repairBlocked: repairs.blocked.length };
    });
    if (!result?.ok) {
      ui.notifications.warn(result?.reason === "active" ? "Бой ещё не достиг терминального исхода." : "Не удалось завершить бой.");
      return;
    }
    ui.notifications.info(result.repairCount
      ? `Бой архивирован. Ремонт начат: ${result.repairCount} здан.${result.repairBlocked ? ` Без материалов осталось: ${result.repairBlocked}.` : ""}`
      : (result.repairBlocked ? `Бой архивирован. Ремонт не начат: для ${result.repairBlocked} здан. нет полной сметы или материалов.` : "Бой архивирован."));
    this.requestRender();
  }

  async _chooseAftermathAction() {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.wait) {
      return DialogV2.wait({
        window: { title: "Завершить бой" },
        content: "<p>Сохранить воспроизводимый снимок боя в архиве? Повреждённые здания можно сразу перевести в ремонт.</p>",
        buttons: [
          { action: "archive", label: "Только архив", icon: "fa-solid fa-box-archive" },
          { action: "archive-repair", label: "Архив и ремонт", icon: "fa-solid fa-screwdriver-wrench", default: true },
          { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark" }
        ],
        rejectClose: false
      });
    }
    return await this._confirm("Завершить бой", "Архивировать текущий бой?") ? "archive" : "cancel";
  }

  _playDefenseSound(holding, margin = 0) {
    const src = margin > 0
      ? holding?.gm?.defense?.victorySound
      : margin < 0
        ? holding?.gm?.defense?.defeatSound
        : holding?.gm?.defense?.drawSound;
    if (!src) return;
    try { playFoundryAudio({ src, volume: 0.8, autoplay: true, loop: false }, true); }
    catch (error) { console.warn("FBL Skyhold | Defense sound failed", error); }
  }

  _readStateFromForm() {
    const root = this.element;
    if (!root) return null;
    const state = {};
    root.querySelectorAll("[data-mass-field]").forEach((field) => {
      if (field.dataset.skipFormState === "true") return;
      const key = field.dataset.massField;
      if (!key) return;
      const value = fieldValue(field);
      if (key.includes(".")) foundry.utils.setProperty(state, key, value);
      else state[key] = value;
    });
    return normalizeMassCombatPatch(state);
  }

  _isDefenderEditableMassKey(key = "") {
    return new Set([
      "defenseMode",
      "useDefenseSquads",
      "raiseMilitia",
      "defenderPosition",
      "defenderHero",
      "defenderMorale",
      "defenderSpecial",
      "defenderStrategy",
      "notes"
    ]).has(String(key ?? "")) || isMassCombatUnitTagField(key, { side: "defender" });
  }

  _canEditMassField(key = "") {
    if (game.user?.isGM) return true;
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    return Boolean(holdingPermissionContext(holding).canEditBattleSetup && this._isDefenderEditableMassKey(key));
  }

  async _saveStatePatch(patch = {}) {
    const cleanPatch = normalizeMassCombatPatch(patch);
    if (game.user?.isGM) return HoldingService.updateMassCombatState(this.holdingId, cleanPatch);
    const allowed = Object.fromEntries(Object.entries(cleanPatch).filter(([key]) => this._isDefenderEditableMassKey(key)));
    if (!Object.keys(allowed).length) return null;
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    if (!holdingPermissionContext(holding).canEditBattleSetup) return null;
    return HoldingService.updateMassCombatState(holding.id, allowed);
  }

  async _onMassFieldChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const field = event.currentTarget;
    const key = field?.dataset?.massField;
    if (!key || !this._canEditMassField(key)) return;
    const value = fieldValue(field);
    const patch = game.user?.isGM
      ? normalizeManualMassCombatPatch({
        [key]: value,
        pendingRound: null,
        phase: "active",
        outcome: "active",
        terminalReason: ""
      })
      : { [key]: value };
    if (game.user?.isGM && key === "attackerUnits") {
      const cleanPatch = normalizeMassCombatPatch(patch);
      await HoldingService.updateHolding(this.holdingId, (holding) => {
        if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
        if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
        Object.assign(holding.gm.massCombat, cleanPatch);
        pruneAttackerSourceOverrides(holding.gm.massCombat, cleanPatch.attackerUnits);
        return holding.gm.massCombat;
      });
    } else {
      await this._saveStatePatch(patch);
    }
    this.requestRender();
  }

  _onAttackerPresetSelectionChange(event) {
    const selected = String(event.currentTarget?.value ?? "custom");
    const summary = ATTACKER_PRESETS[selected]?.summary ?? ATTACKER_PRESETS.custom.summary;
    const note = this.element?.querySelector?.("[data-attacker-preset-summary]");
    if (note) note.textContent = summary;
  }

  async _onRestoreAttackerSourceType(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const key = String(event.currentTarget?.dataset?.sourceTypeField ?? "");
    if (!/^attackerSourcePrimaryTag\d+$/.test(key)) return;
    await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      delete holding.gm.massCombat[key];
      holding.gm.massCombat.attackerPreset = "custom";
      return holding.gm.massCombat;
    });
    this.requestRender();
  }

  async _onRestoreAttackerSourceEfficiency(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const key = String(event.currentTarget?.dataset?.sourceEfficiencyField ?? "");
    if (!/^attackerSourceEfficiency\d+$/.test(key)) return;
    await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      delete holding.gm.massCombat[key];
      holding.gm.massCombat.attackerPreset = "custom";
      return holding.gm.massCombat;
    });
    this.requestRender();
  }

  async _onApplyAttackerPreset(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const root = this.element;
    const selected = root?.querySelector("[data-attacker-preset-select]")?.value || "custom";
    if (selected !== "custom") {
      const confirmed = await this._confirm(
        "Применить пресет нападающих",
        "Пресет заменит параметры нападающих и сбросит ручные теги отрядов. Продолжить?"
      );
      if (!confirmed) return;
    }
    await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      return applyAttackerPresetToState(holding.gm.massCombat, selected);
    });
    this.requestRender();
  }

  async _onRollRound(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const formState = this._readStateFromForm() ?? {};
    const result = await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm) holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      Object.assign(holding.gm.massCombat, formState);
      const state = holding.gm.massCombat;
      state.schemaVersion = 2;
      if (!state.battleId) state.battleId = makeId("battle");
      if (!state.startedAt) state.startedAt = new Date().toISOString();
      if (state.pendingRound) return SkyholdData.skipTransaction({ ok: true, pendingRound: state.pendingRound, alreadyPending: true });

      const manager = getSkyholdManager();
      const calculationDependencies = battleCalculationDependencies(manager);
      const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
      const calc = calculateBattle(holding, state, { defenseTotal, ...calculationDependencies });
      const terminal = battleTerminalState(state, calc);
      if (terminal.finished) return SkyholdData.skipTransaction({ ok: false, reason: "terminal", terminal });
      if (!calc.defenderPool && !calc.attackerPool) return SkyholdData.skipTransaction({ ok: false, reason: "empty-pools" });

      const pending = createPendingBattleRound({
        holding,
        state,
        calc,
        defenseTotal,
        calculationDependencies,
        compactNameList: (names) => this._compactNameList(names)
      });
      state.pendingRound = pending.pendingRound;
      state.phase = "pending";
      state.outcome = "active";
      state.terminalReason = "";
      return { ok: true, pendingRound: state.pendingRound, alreadyPending: false };
    });
    if (!result) return;
    if (!result.ok) {
      if (result.reason === "terminal") ui.notifications.warn(result.terminal?.title ?? "Бой уже завершён.");
      else ui.notifications.warn("Нечего бросать: оба пула равны 0.");
      return;
    }
    if (!result.alreadyPending) ui.notifications.info("Результат раунда подготовлен. Проверь последствия и примени их.");
    this.requestRender();
  }

  async _onApplyPendingRound(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const result = await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm) holding.gm = {};
      if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
      const state = holding.gm.massCombat;
      const pendingRound = state.pendingRound;
      if (!pendingRound) return SkyholdData.skipTransaction({ ok: false, reason: "missing-pending" });
      if ((state.log ?? []).some((row) => String(row?.roundId ?? "") === String(pendingRound.roundId ?? ""))) {
        state.pendingRound = null;
        state.phase = "active";
        return { ok: true, alreadyApplied: true, holding, state };
      }
      const manager = getSkyholdManager();
      const calculationDependencies = battleCalculationDependencies(manager);
      const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
      const calc = calculateBattle(holding, state, { defenseTotal, ...calculationDependencies });
      const resolved = applyPendingBattleRound({
        holding,
        state,
        pendingRound,
        calc,
        defenseTotal,
        calculationDependencies,
        compactNameList: (names) => this._compactNameList(names)
      });
      if (!resolved.ok) return SkyholdData.skipTransaction(resolved);
      const {
        round,
        defenderRolls,
        attackerRolls,
        defenderSuccesses,
        attackerSuccesses,
        margin,
        consequences,
        casualtyResult,
        damageResult,
        terminal
      } = resolved;
      state.pendingRound = null;
      state.phase = terminal.finished ? "terminal" : "active";
      state.outcome = terminal.outcome;
      state.terminalReason = terminal.reason;
      state.resolvedAt = terminal.finished ? new Date().toISOString() : "";
      state.resolvedBy = terminal.finished ? String(game.user?.id ?? "") : "";
      if (!Array.isArray(state.log)) state.log = [];
      const logRow = {
        id: makeId("battle-log"),
        roundId: resolved.roundId,
        createdAt: new Date().toISOString(),
        battleId: state.battleId,
        round,
        title: state.title || `Бой у ${holding.name || "владения"}`,
        result: consequences.result,
        defenderPool: calc.defenderPool,
        attackerPool: calc.attackerPool,
        defenderRolls,
        attackerRolls,
        randomTrace: pendingRound.randomTrace,
        resultFingerprint: pendingRound.fingerprint,
        defenderSuccesses,
        attackerSuccesses,
        margin,
        defenderLossDelta: consequences.defenderLossDelta,
        attackerLossDelta: consequences.attackerLossDelta,
        settlementDamageDelta: consequences.settlementDamageDelta,
        breachDelta: consequences.breachDelta,
        objectiveDelta: consequences.objectiveDelta,
        defenderPositionDelta: consequences.defenderPositionDelta,
        attackerPositionDelta: consequences.attackerPositionDelta,
        defenderImpact: consequences.defenderImpact,
        attackerImpact: consequences.attackerImpact,
        casualtyText: casualtyResult.text || "",
        damageText: damageResult.text || "",
      };
      state.log.push(logRow);
      state.log = state.log.slice(-20);

      return {
        ok: true,
        holding,
        state,
        calc,
        round,
        defenderRolls,
        attackerRolls,
        defenderSuccesses,
        attackerSuccesses,
        margin,
        casualtyText: casualtyResult.text || "",
        damageText: damageResult.text || "",
        consequences,
        terminal
      };
    });
    if (!result) return;
    if (!result.ok) {
      if (result.reason === "missing-pending") ui.notifications.warn("Нет подготовленного раунда для применения.");
      else if (result.reason === "stale") ui.notifications.warn("Данные боя изменились после броска. Отмени предпросмотр и брось раунд заново.");
      else ui.notifications.error("Не удалось воспроизвести сохранённый random trace раунда. Последствия не применены.");
      return;
    }
    if (result.alreadyApplied) {
      ui.notifications.info("Этот раунд уже был применён ранее.");
      this.requestRender();
      return;
    }
    await createFoundryChatMessage({
      speaker: foundryChatSpeaker({ alias: result.holding.name || "Владение" }),
      content: roundChatContent(result.holding, result.state, result.calc, {
        round: result.round,
        defenderRolls: result.defenderRolls,
        attackerRolls: result.attackerRolls,
        defenderSuccesses: result.defenderSuccesses,
        attackerSuccesses: result.attackerSuccesses,
        margin: result.margin,
        casualtyText: result.casualtyText,
        damageText: result.damageText,
        terminal: result.terminal,
        ...result.consequences
      })
    });
    this._playDefenseSound(result.holding, result.margin);
    if (result.terminal?.finished) ui.notifications.info(result.terminal.title);
    this.requestRender();
  }

  async _onDiscardPendingRound(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const discarded = await HoldingService.updateHolding(this.holdingId, (holding) => {
      const state = holding?.gm?.massCombat;
      if (!state?.pendingRound) return SkyholdData.skipTransaction(false);
      state.pendingRound = null;
      state.phase = state.battleId ? "active" : "setup";
      state.outcome = "active";
      state.terminalReason = "";
      return true;
    });
    if (!discarded) return;
    ui.notifications.info("Предпросмотр раунда отменён без применения последствий.");
    this.requestRender();
  }

  async _onPostSummary(event) {
    event.preventDefault();
    event.stopPropagation();
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false });
    if (!holding) {
      warnNoHoldingAccess();
      return;
    }
    const state = holding.gm?.massCombat ?? {};
    const manager = getSkyholdManager();
    const calculationDependencies = battleCalculationDependencies(manager);
    const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
    const calc = calculateBattle(holding, state, { defenseTotal, ...calculationDependencies });
    await createFoundryChatMessage({
      speaker: foundryChatSpeaker({ alias: holding.name || "Владение" }),
      content: `
        <div class="fbls-chat-card">
          <h3>${escapeHtml(state.title || `Массовый бой: ${holding.name || "владение"}`)}</h3>
          <p><strong>Враг:</strong> ${escapeHtml(state.enemyName || "Нападающие")}. <strong>Цель:</strong> ${escapeHtml(state.objective || "не задана")}. <strong>Масштаб:</strong> ${escapeHtml(calc.scale.label)}.</p>
          <p><strong>Эффективность:</strong> защитники ${calc.defenderEffective ?? calc.defenderBS}, нападающие ${calc.attackerEffective ?? calc.attackerBS}. <strong>Гарнизоны:</strong> ${calc.defenderGarrisonDice ?? calc.fortificationDice ?? 0}к6 (${calc.garrisonProfile?.count ?? 0} чел.).</p>
          <p><strong>Текущие пулы:</strong> защитники ${calc.defenderPool}к6, нападающие ${calc.attackerPool}к6. ${escapeHtml(calc.deterrence ?? calc.deterrenceText ?? "")}</p>
          <p><strong>Накоплено:</strong> защитники ${asInt(state.defenderLossSteps ?? state.defenderLosses, 0)}/${calc.defenderLossTrack.threshold}, нападающие ${asInt(state.attackerLossSteps ?? state.attackerLosses, 0)}/${calc.attackerLossTrack.threshold}, урон ${asInt(state.settlementDamage, 0)}/${calc.damageTrack.threshold}, брешь ${asInt(state.breachProgress, 0)}/${calc.breachThreshold || "-"}, цель ${asInt(state.objectiveProgress, 0)}/${calc.objectiveTrack.threshold}.</p>
          <p><strong>Расшифровка:</strong> ${escapeHtml(calc.defenderLossTrack.text)} ${escapeHtml(calc.attackerLossTrack.text)} Урон: ${escapeHtml(calc.damageTrack.instruction)}</p>
          ${state.notes ? `<p><strong>Заметки:</strong> ${escapeHtml(state.notes)}</p>` : ""}
        </div>
      `
    });
  }

  async _onResetBattle(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const confirmed = await this._confirm("Сбросить бой", "Очистить текущую подготовку боя, потери и лог? Характеристики владения не меняются.");
    if (!confirmed) return;
    await HoldingService.updateHolding(this.holdingId, (holding) => {
      if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
      const current = holding.gm.massCombat ?? {};
      archiveBattle(current, {
        outcome: current.outcome ?? "active",
        terminalReason: current.terminalReason ?? "",
        resolvedBy: String(game.user?.id ?? ""),
        reason: current.phase === "terminal" || current.phase === "archived" ? "resolved" : "aborted"
      });
      const next = resetMassCombatState();
      next.archive = Array.isArray(current.archive) ? current.archive : [];
      holding.gm.massCombat = next;
      return next;
    });
    this.requestRender();
  }

  async _onClearLog(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    await this._saveStatePatch({ log: [], casualtyLog: [], buildingDamageLog: [] });
    this.requestRender();
  }

  async _confirm(title, content) {
    try {
      return await foundryDialogV2().confirm({ window: { title }, content: `<p>${escapeHtml(content)}</p>`, modal: true });
    } catch (_error) {}
    return window.confirm(content);
  }
}

SkyholdMassCombatApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-mass-combat",
  classes: ["fbl-skyhold", "fbl-skyhold-mass-combat"],
  tag: "section",
  window: {
    title: "Битва за владение",
    icon: "fa-solid fa-shield-halved",
    resizable: true
  },
  position: {
    width: 1160,
    height: 760
  }
};

SkyholdMassCombatApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/mass-combat.hbs`
  }
};
