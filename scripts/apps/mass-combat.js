import { MODULE_ID } from "../data/store.js";
import { HoldingService } from "../data/holding-service.js";
import { escapeHtml, fieldValue, rollD6Pool } from "../core/helpers.js";
import { getSkyholdAppClass, getSkyholdManager } from "./registry.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

import {
  ACCESS_MODES,
  ATTACKER_PRESETS,
  DEFENDER_MOBILIZATIONS,
  DEFENSE_MODES,
  OBJECTIVE_THRESHOLDS,
  ROUND_LIMITS,
  ROUND_THREATS,
  SCALES,
  STRATEGIES,
  asInt,
  asNumber,
  applyPercentBonus,
  bestTagAdvantage,
  clamp,
  commandPercentFromEffectiveness,
  diceText,
  militiaQualityText,
  militiaThreshold,
  poolDiceFromStrength,
  selectOptions,
  stateValue,
  strategyOptions,
  strategySummary,
  strengthRatioBonus,
  successCount,
  tagCounterPressure,
  tagValue,
  toSigned
} from "./mass-combat/rules.js";
import { isMassCombatUnitTagField, massCombatTagField } from "./mass-combat/tag-config.js";
import { counterGraphHtml, bindCounterGraphRuntime } from "./mass-combat/counter-graph.js";

import {
  applyDefenderResidentCasualties,
  defenderCasualtyCandidates,
  medicalSupport,
  applyBattleConditionToPerson
} from "./mass-combat/casualties.js";

import { applySettlementBattleDamage, battleAftermathRows, startBattleRepairs } from "./mass-combat/damage.js";
import { roundConsequences } from "./mass-combat/round.js";
import { roundChatContent } from "./mass-combat/chat.js";
import { normalizeMassCombatPatch, resetMassCombatState } from "./mass-combat/state.js";
import {
  autoDefenderProfile,
  builtBuildings,
  calculateBattle,
  commanderEffectiveness,
  damageContext,
  damageTrack,
  defenseCommanderBonus,
  defenseGarrisonProfile,
  defenseSquadProfile,
  deterrenceText,
  fortificationProfile,
  hasResidentWords,
  inferRoundThreatKey,
  isAdultResident,
  isCommanderCandidate,
  isDefenseBuilding,
  isInjuredResident,
  isMilitaryBackgroundResident,
  isMilitaryResident,
  isSergeantCandidate,
  isSoldierResident,
  isSuitableForSquadType,
  lossTrack,
  objectiveTrack,
  personAssignmentText,
  personText,
  residentCombatTrait,
  soldierEfficiency,
  squadTypeProfile
} from "./mass-combat/calculator.js";

export class SkyholdMassCombatApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instances = new Set();

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
    const { data, holding, index: holdingIndex } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    const manager = getSkyholdManager();
    const canEdit = Boolean(game.user?.isGM);
    const canEditDefender = canEdit || Boolean(holding?.gm?.playersCanEditBattle === true);
    const state = holding?.gm?.massCombat ?? {};
    const defense = manager?._defenseSummary?.(holding) ?? { total: asNumber(holding?.overview?.defense, 0), tooltip: "" };
    const reputation = manager?._reputationSummary?.(holding) ?? { total: asNumber(holding?.overview?.reputation, 0), tooltip: "" };
    const morale = manager?._moraleState?.(manager?._calculateMorale?.(holding) ?? 0) ?? { value: 0, label: "", icon: "fa-regular fa-face-meh" };
    const calc = this._calculateBattle(holding, state, { defenseTotal: defense.total });

    return {
      ...context,
      canEdit,
      canEditDefender,
      holding,
      holdingIndex,
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
      reputation,
      morale,
      calc,
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
      "mass-post-summary": "_onPostSummary",
      "mass-post-aftermath": "_onPostAftermath",
      "mass-start-repairs": "_onStartRepairs",
      "mass-reset": "_onResetBattle",
      "mass-clear-log": "_onClearLog",
      "mass-apply-preset": "_onApplyAttackerPreset",
      "mass-toggle-tags": "_onToggleTagsPopover",
      "mass-toggle-section": "_onToggleSection",
      "mass-show-counters": "_onShowCounterHelp",
      "mass-show-weather": "_onShowWeatherHelp"
    };
    const dispatch = (event, element, handlerName) => {
      const handler = this?.[handlerName];
      if (typeof handler !== "function") return false;
      handler.call(this, this._delegatedEvent(event, element));
      return true;
    };

    root.addEventListener("change", (event) => {
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
      root.querySelector(".fbls-battle-tags-popover")?.classList.remove("open");
    }, listenerOptions);
  }

  _delegatedEvent(event, currentTarget) {
    return new Proxy(event, {
      get(target, prop) {
        if (prop === "currentTarget" || prop === "delegateTarget") return currentTarget;
        const value = target[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
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
    const stop = (event) => event.stopPropagation();
    const sanitizeTabs = (event) => {
      const field = event.currentTarget;
      if (!(field instanceof HTMLTextAreaElement)) return;
      const value = String(field.value ?? "");
      if (!value.includes("	")) return;
      const start = field.selectionStart;
      const end = field.selectionEnd;
      const beforeTabs = value.slice(0, start).split("	").length - 1;
      const beforeEndTabs = value.slice(0, end).split("	").length - 1;
      field.value = value.replace(/	/g, "  ");
      field.selectionStart = Math.max(0, start + beforeTabs);
      field.selectionEnd = Math.max(0, end + beforeEndTabs);
    };
    root.querySelectorAll("input, textarea, select").forEach((field) => {
      if (field instanceof HTMLTextAreaElement) {
        field.addEventListener("input", sanitizeTabs);
        field.addEventListener("paste", () => setTimeout(() => sanitizeTabs({ currentTarget: field }), 0));
      }
      for (const eventName of ["keydown", "keyup", "keypress", "input", "beforeinput", "paste", "copy", "cut", "mousedown", "mouseup", "click", "dblclick"]) {
        field.addEventListener(eventName, stop, { capture: true });
        field.addEventListener(eventName, stop);
      }
    });
  }

  _bindGlobalInputGuard(root) {
    this._unbindGlobalInputGuard();
    const editableSelector = "input, textarea, select, [contenteditable='true']";
    this._globalInputGuard = (event) => {
      const target = event.target;
      const active = document.activeElement;
      const targetInside = target instanceof Element && root.contains(target);
      const activeInside = active instanceof Element && root.contains(active);
      const targetEditable = target instanceof Element && Boolean(target.closest(editableSelector));
      const activeEditable = active instanceof Element && Boolean(active.closest(editableSelector));
      if ((targetInside && targetEditable) || (activeInside && activeEditable)) event.stopImmediatePropagation();
    };
    for (const eventName of ["keydown", "keyup", "keypress"]) window.addEventListener(eventName, this._globalInputGuard, true);
  }

  _unbindGlobalInputGuard() {
    if (!this._globalInputGuard) return;
    for (const eventName of ["keydown", "keyup", "keypress"]) window.removeEventListener(eventName, this._globalInputGuard, true);
    this._globalInputGuard = null;
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    this._unbindGlobalInputGuard();
    SkyholdMassCombatApp.instances.delete(this);
    getSkyholdAppClass()?.instance?.render({ force: true, focus: false });
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
    popover.classList.toggle("open");
  }

  _onShowCounterHelp(event) {
    event.preventDefault();
    event.stopPropagation();
    const graphId = `fbls-counter-${foundry.utils.randomID?.(6) ?? Math.floor(Math.random() * 999999)}`;
    const cleanup = bindCounterGraphRuntime(graphId);
    const result = this._showSimpleDialog("Контры тегов", counterGraphHtml(graphId), { classes: ["fbl-skyhold-dark-dialog", "fbl-skyhold-counter-dialog"], width: 660 });
    if (result?.finally) return result.finally(cleanup);
    return result;
  }

  _onShowWeatherHelp(event) {
    event.preventDefault();
    event.stopPropagation();
    const data = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    const state = data?.holding?.gm?.massCombat ?? {};
    const calc = this._calculateBattle(data?.holding, state, { defenseTotal: 0 });
    const cards = (calc?.weather?.catalog ?? []).map((weather) => {
      const tagText = (weather.tagRows ?? []).map((row) => `<span class="${row.tone}">${escapeHtml(row.text)}</span>`).join("") || "<span>нет</span>";
      const planText = (weather.planRows ?? []).map((row) => `<span class="${row.tone}">${escapeHtml(row.text)}</span>`).join("") || "<span>нет</span>";
      return `<article class="fbls-weather-help-card"><header><strong>${escapeHtml(weather.label)}</strong><em>${escapeHtml(weather.summary)}</em></header><div><b>Теги</b>${tagText}</div><div><b>Планы</b>${planText}</div></article>`;
    }).join("");
    const html = `<div class="fbl-skyhold fbls-dialog-help fbls-skyhold-dark-panel fbls-weather-help-compact"><div class="fbls-help-lead compact no-title"><span>Модификаторы эффективности в битве за владение.</span></div><div class="fbls-weather-help-list">${cards}</div></div>`;
    return this._showSimpleDialog("Погода", html, { classes: ["fbl-skyhold-dark-dialog", "fbl-skyhold-weather-dialog"], width: 560 });
  }

  _showSimpleDialog(title, html, options = {}) {
    const classes = [...new Set(["fbl-skyhold-dark-dialog", ...(options.classes ?? [])])];
    const windowOptions = { title };
    if (options.width) windowOptions.width = options.width;
    if (foundry?.applications?.api?.DialogV2?.wait) {
      return foundry.applications.api.DialogV2.wait({ window: windowOptions, classes, content: html, buttons: [{ action: "ok", label: "Понятно", default: true }] });
    }
    return new Dialog({ title, content: html, classes, width: options.width, buttons: { ok: { label: "Понятно" } }, default: "ok" }).render(true);
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

  _builtBuildings(holding) { return builtBuildings(this, holding); }

  _isDefenseBuilding(building) { return isDefenseBuilding(this, building); }

  _isAdultResident(person) { return isAdultResident(this, person); }

  _personText(person = {}) { return personText(this, person); }

  _personAssignmentText(person = {}) { return personAssignmentText(this, person); }

  _isMilitaryResident(person = {}) { return isMilitaryResident(this, person); }

  _hasResidentWords(person = {}, pattern) { return hasResidentWords(this, person, pattern); }

  _residentCombatTrait(person = {}) { return residentCombatTrait(this, person); }

  _isInjuredResident(person = {}) { return isInjuredResident(this, person); }

  _isSoldierResident(person = {}) { return isSoldierResident(this, person); }

  _isSergeantCandidate(person = {}) { return isSergeantCandidate(this, person); }

  _isMilitaryBackgroundResident(person = {}) { return isMilitaryBackgroundResident(this, person); }

  _isCommanderCandidate(person = {}) { return isCommanderCandidate(this, person); }

  _isSuitableForSquadType(person = {}, type = "line") { return isSuitableForSquadType(this, person, type); }

  _soldierEfficiency(person = {}, type = "line") { return soldierEfficiency(this, person, type); }

  _squadTypeProfile(type = "line") { return squadTypeProfile(this, type); }

  _defenseSquadProfile(holding, state = {}) { return defenseSquadProfile(this, holding, state); }

  _commanderEffectiveness(person = {}) { return commanderEffectiveness(this, person); }

  _defenseCommanderBonus(holding, armyDice = 0) { return defenseCommanderBonus(this, holding, armyDice); }

  _inferRoundThreatKey(state = {}, attackerStrategy = {}) { return inferRoundThreatKey(this, state, attackerStrategy); }

  _defenseGarrisonProfile(holding) { return defenseGarrisonProfile(this, holding); }

  _fortificationProfile(holding, state = {}, options = {}) { return fortificationProfile(this, holding, state, options); }

  _medicalSupport(holding, options = {}) {
    return medicalSupport(this, holding, options);
  }

  _defenderCasualtyCandidates(holding, state = {}, calc = {}) {
    return defenderCasualtyCandidates(this, holding, state, calc);
  }

  _applyBattleConditionToPerson(holding, person, condition = "injured", options = {}) {
    return applyBattleConditionToPerson(this, holding, person, condition, options);
  }

  _applyDefenderResidentCasualties(holding, state = {}, lossSteps = 0, calc = {}) {
    return applyDefenderResidentCasualties(this, holding, state, lossSteps, calc);
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
    const { data, holding, index: holdingIndex } = HoldingService.getHoldingEntry(this.holdingId);
    if (holdingIndex < 0 || !holding) return;
    const targets = startBattleRepairs(holding);
    if (!targets.length) {
      ui.notifications.info("Нет поврежденных зданий, которые можно отправить в ремонт.");
      return;
    }
    await HoldingService.saveData(data);
    ui.notifications.info(`Ремонт начат: ${targets.length} здан.`);
    this.render({ force: true, focus: false });
  }

  async _onPostAftermath(event) {
    event.preventDefault();
    event.stopPropagation();
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    if (!holding) return;
    const state = holding.gm?.massCombat ?? {};
    const rows = battleAftermathRows(this, holding, state);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
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

  _playDefenseSound(holding, margin = 0) {
    const src = margin > 0
      ? holding?.gm?.defense?.victorySound
      : margin < 0
        ? holding?.gm?.defense?.defeatSound
        : holding?.gm?.defense?.drawSound;
    if (!src) return;
    try { AudioHelper.play({ src, volume: 0.8, autoplay: true, loop: false }, true); }
    catch (error) { console.warn("FBL Skyhold | Defense sound failed", error); }
  }

  _autoDefenderProfile(holding, state = {}, options = {}) { return autoDefenderProfile(this, holding, state, options); }

  _lossTrack(label, steps, units, fallbackUnits = 1) { return lossTrack(this, label, steps, units, fallbackUnits); }

  _damageContext(holding, state = {}, calcBase = {}) { return damageContext(this, holding, state, calcBase); }

  _damageTrack(holding, state = {}, calcBase = {}) { return damageTrack(this, holding, state, calcBase); }

  _objectiveTrack(state = {}, scale = SCALES.raid) { return objectiveTrack(this, state, scale); }

  _calculateBattle(holding, state = {}, options = {}) { return calculateBattle(this, holding, state, options); }

  _deterrenceText(defenderCombatDice, attackerCombatDice, fortificationDice) { return deterrenceText(this, defenderCombatDice, attackerCombatDice, fortificationDice); }

  _readStateFromForm() {
    const root = this.element;
    if (!root) return null;
    const state = {};
    root.querySelectorAll("[data-mass-field]").forEach((field) => {
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
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    return Boolean(holding?.gm?.playersCanEditBattle === true && this._isDefenderEditableMassKey(key));
  }

  async _saveStatePatch(patch = {}) {
    const cleanPatch = normalizeMassCombatPatch(patch);
    if (game.user?.isGM) return HoldingService.updateMassCombatState(this.holdingId, cleanPatch);
    const allowed = Object.fromEntries(Object.entries(cleanPatch).filter(([key]) => this._isDefenderEditableMassKey(key)));
    if (!Object.keys(allowed).length) return null;
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    if (holding?.gm?.playersCanEditBattle !== true) return null;
    return HoldingService.updateMassCombatState(holding.id, allowed);
  }

  async _onMassFieldChange(event) {
    event.preventDefault();
    event.stopPropagation();
    const field = event.currentTarget;
    const key = field?.dataset?.massField;
    if (!key || !this._canEditMassField(key)) return;
    const value = fieldValue(field);
    await this._saveStatePatch({ [key]: value });
    this.render({ force: true, focus: false });
  }


  async _onApplyAttackerPreset(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const root = this.element;
    const selected = root?.querySelector("[data-mass-field='attackerPreset']")?.value || "custom";
    const preset = ATTACKER_PRESETS[selected] ?? ATTACKER_PRESETS.custom;
    const patch = { attackerPreset: selected, ...(preset.patch ?? {}) };
    await this._saveStatePatch(patch);
    this.render({ force: true, focus: false });
  }

  async _onRollRound(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const formState = this._readStateFromForm() ?? {};
    const { data, holding, index: holdingIndex } = HoldingService.getHoldingEntry(this.holdingId);
    if (holdingIndex < 0 || !holding) return;
    if (!holding.gm) holding.gm = {};
    if (!holding.gm.massCombat || typeof holding.gm.massCombat !== "object") holding.gm.massCombat = {};
    Object.assign(holding.gm.massCombat, formState);
    const state = holding.gm.massCombat;
    if (!state.battleId) state.battleId = foundry.utils.randomID?.(10) ?? `battle-${Date.now()}`;
    const manager = getSkyholdManager();
    const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
    const calc = this._calculateBattle(holding, state, { defenseTotal });
    if (!calc.defenderPool && !calc.attackerPool) {
      ui.notifications.warn("Нечего бросать: оба пула равны 0.");
      return;
    }

    const defenderRolls = rollD6Pool(calc.defenderPool);
    const attackerRolls = rollD6Pool(calc.attackerPool);
    const defenderSuccesses = successCount(defenderRolls);
    const attackerSuccesses = successCount(attackerRolls);
    const margin = defenderSuccesses - attackerSuccesses;
    const round = Math.max(1, asInt(state.round, 1));
    const consequences = roundConsequences({ defenderSuccesses, attackerSuccesses, margin }, calc, state);

    state.defenderLossSteps = Math.max(0, asInt(state.defenderLossSteps ?? state.defenderLosses, 0) + consequences.defenderLossDelta);
    state.attackerLossSteps = Math.max(0, asInt(state.attackerLossSteps ?? state.attackerLosses, 0) + consequences.attackerLossDelta);
    state.settlementDamage = Math.max(0, asInt(state.settlementDamage, 0) + consequences.settlementDamageDelta);
    state.breachProgress = Math.max(0, asInt(state.breachProgress, 0) + consequences.breachDelta);
    state.objectiveProgress = Math.max(0, asInt(state.objectiveProgress, 0) + consequences.objectiveDelta);
    state.defenderPosition = clamp(asInt(state.defenderPosition, 0) + consequences.defenderPositionDelta, 0, 3);
    state.attackerPosition = clamp(asInt(state.attackerPosition, 0) + consequences.attackerPositionDelta, 0, 3);
    const battleLostForMedicine = asInt(state.defenderLossSteps ?? state.defenderLosses, 0) >= asInt(calc.defenderLossTrack?.threshold, 999) || asInt(state.objectiveProgress, 0) >= asInt(calc.objectiveTrack?.threshold, 999);
    const casualtyResult = this._applyDefenderResidentCasualties(holding, state, consequences.defenderLossDelta, { ...calc, defenderRoundLost: battleLostForMedicine });
    const damageResult = applySettlementBattleDamage(this, holding, state, consequences.settlementDamageDelta, calc);
    state.round = round + 1;
    if (!Array.isArray(state.log)) state.log = [];
    const logRow = {
      id: foundry.utils.randomID?.(10) ?? `battle-log-${Date.now()}`,
      createdAt: new Date().toISOString(),
      battleId: state.battleId,
      round,
      title: state.title || `Бой у ${holding.name || "владения"}`,
      result: consequences.result,
      defenderPool: calc.defenderPool,
      attackerPool: calc.attackerPool,
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

    await HoldingService.saveData(data);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
      content: roundChatContent(this, holding, state, calc, { round, defenderRolls, attackerRolls, defenderSuccesses, attackerSuccesses, margin, casualtyText: casualtyResult.text || "", damageText: damageResult.text || "", ...consequences })
    });
    this._playDefenseSound(holding, margin);
    this.render({ force: true, focus: false });
  }

  async _onPostSummary(event) {
    event.preventDefault();
    event.stopPropagation();
    const { holding } = HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: true });
    if (!holding) return;
    const state = holding.gm?.massCombat ?? {};
    const manager = getSkyholdManager();
    const defenseTotal = manager?._defenseSummary?.(holding)?.total ?? asNumber(holding?.overview?.defense, 0);
    const calc = this._calculateBattle(holding, state, { defenseTotal });
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ alias: holding.name || "Владение" }),
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
    await this._saveStatePatch(resetMassCombatState());
    this.render({ force: true, focus: false });
  }

  async _onClearLog(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    await this._saveStatePatch({ log: [], casualtyLog: [], buildingDamageLog: [] });
    this.render({ force: true, focus: false });
  }

  async _confirm(title, content) {
    try {
      if (globalThis.Dialog?.confirm) {
        return await globalThis.Dialog.confirm({ title, content: `<p>${escapeHtml(content)}</p>`, yes: () => true, no: () => false, defaultYes: false });
      }
      const DialogV2 = foundry?.applications?.api?.DialogV2;
      if (DialogV2?.confirm) return await DialogV2.confirm({ window: { title }, content: `<p>${escapeHtml(content)}</p>`, modal: true });
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
