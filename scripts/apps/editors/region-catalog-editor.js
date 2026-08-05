import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { normalizeEventRegionOptions } from "../../data/random-events.js";
import { normalizeMarketEconomy } from "../../data/market/economy.js";
import { fieldValue } from "../../core/helpers.js";
import { dispatchDelegatedAction } from "../common/delegated-events.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { openRouteGraphApp } from "../lazy-apps.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const REGION_FIELDS = new Set(["value", "label", "aliases", "countryId", "marketSizeId", "marketSpecialtyIds", "marketConditionId", "marketTags", "marketProfile", "marketPriceFactor", "marketAvailabilityFactor", "marketDeliveryFactor", "marketTimeFactor", "marketRiskFactor", "marketExportFactor", "marketImportFactor", "marketTaxRate", "marketStatus", "marketEnabled", "marketLandmassId", "marketAirshipOnly", "marketTransportModes", "marketLinks", "marketMapX", "marketMapY", "marketNotes"]);
const MARKET_FACTOR_FIELDS = new Set(["marketPriceFactor", "marketAvailabilityFactor", "marketDeliveryFactor", "marketTimeFactor", "marketRiskFactor", "marketExportFactor", "marketImportFactor", "marketTaxRate"]);
const MARKET_ARRAY_FIELDS = new Set(["aliases", "marketSpecialtyIds", "marketTags", "marketTransportModes", "marketLinks"]);
const MARKET_TRANSPORT_MODES = [
  { value: "caravan", label: "Караван", icon: "fa-solid fa-cart-flatbed" },
  { value: "rail", label: "Железная дорога", icon: "fa-solid fa-train" },
  { value: "airship", label: "Воздушный корабль", icon: "fa-solid fa-ship" }
];
const MARKET_PROFILE_OPTIONS = [
  { value: "", label: "Авто по названию" },
  { value: "standard", label: "Обычный маршрут" },
  { value: "connected", label: "Торговый узел" },
  { value: "remote", label: "Удалённый регион" },
  { value: "aerial", label: "Воздушный маршрут" }
];
const MARKET_STATUS_OPTIONS = [
  { value: "thriving", label: "Процветает" },
  { value: "stable", label: "Стабильно" },
  { value: "strained", label: "Напряжение" },
  { value: "disrupted", label: "Логистика нарушена" },
  { value: "ruined", label: "Разрушен" },
  { value: "blockaded", label: "Блокада" }
];

function regionCatalogRows(regionOptions = [], economySource = null, selectedId = "") {
  const normalizedRegions = normalizeEventRegionOptions(regionOptions, { fallback: false });
  const economy = normalizeMarketEconomy(economySource, { locations: normalizedRegions });
  const countriesById = new Map(economy.countries.map((row) => [row.id, row]));
  const sizesById = new Map(economy.sizeProfiles.map((row) => [row.id, row]));
  const conditionsById = new Map(economy.conditions.map((row) => [row.id, row]));
  const specialtiesById = new Map(economy.specialties.map((row) => [row.id, row]));
  return normalizeEventRegionOptions(regionOptions, { fallback: false }).map((option, index) => {
    const country = countriesById.get(option.countryId) ?? null;
    const condition = conditionsById.get(option.marketConditionId) ?? conditionsById.get(country?.conditionId) ?? null;
    const size = sizesById.get(option.marketSizeId) ?? null;
    const specialtyIds = new Set(option.marketSpecialtyIds ?? []);
    const specialtyLabels = [...specialtyIds].map((id) => specialtiesById.get(id)?.label).filter(Boolean);
    const status = MARKET_STATUS_OPTIONS.find((row) => row.value === option.marketStatus) ?? MARKET_STATUS_OPTIONS[1];
    const profile = MARKET_PROFILE_OPTIONS.find((row) => row.value === option.marketProfile) ?? MARKET_PROFILE_OPTIONS[0];
    const modes = new Set(option.marketTransportModes ?? []);
    return {
      ...option,
      _index: index,
      selected: String(option.value) === String(selectedId),
      aliasesText: Array.isArray(option.aliases) ? option.aliases.join(", ") : String(option.aliases ?? ""),
      marketTagsText: Array.isArray(option.marketTags) ? option.marketTags.join(", ") : "",
      countryLabel: country?.label ?? "Государство не назначено",
      countryOptions: economy.countries.map((row) => ({ value: row.id, label: row.label, selected: row.id === option.countryId })),
      marketSizeLabel: size?.label ?? "Размер не найден",
      marketSizeOptions: economy.sizeProfiles.filter((row) => row.active !== false).map((row) => ({ value: row.id, label: row.label, selected: row.id === option.marketSizeId })),
      marketConditionLabel: condition?.label ?? "Стабильно",
      marketConditionOptions: [{ value: "", label: "Наследовать у государства", selected: !option.marketConditionId }, ...economy.conditions.filter((row) => row.active !== false).map((row) => ({ value: row.id, label: row.label, selected: row.id === option.marketConditionId }))],
      marketSpecialtyOptions: economy.specialties.filter((row) => row.active !== false).map((row) => ({ ...row, selected: specialtyIds.has(row.id) })),
      marketSpecialtyLabels: specialtyLabels,
      marketSpecialtyText: specialtyLabels.join(" · ") || "Без специализации",
      marketSpecialtyCount: specialtyLabels.length,
      marketProfileOptions: MARKET_PROFILE_OPTIONS.map((row) => ({ ...row, selected: row.value === option.marketProfile })),
      marketStatusOptions: MARKET_STATUS_OPTIONS.map((row) => ({ ...row, selected: row.value === option.marketStatus })),
      marketStatusLabel: condition?.label ?? status.label,
      marketProfileLabel: profile.label,
      marketLinkCount: Array.isArray(option.marketLinks) ? option.marketLinks.length : 0,
      marketTransportOptions: MARKET_TRANSPORT_MODES.map((row) => ({ ...row, selected: modes.has(row.value) })),
      searchText: [option.value, option.label, country?.label, size?.label, condition?.label, ...specialtyLabels, ...(option.aliases ?? [])].filter(Boolean).join(" ").toLocaleLowerCase("ru")
    };
  });
}

function rewriteRegionReferences(data, fromValue = "", toValue = "") {
  const from = String(fromValue ?? "");
  const to = String(toValue ?? "");
  if (!from || from === to) return;
  for (const holding of data?.holdings ?? []) {
    if (!holding.overview || typeof holding.overview !== "object") holding.overview = {};
    if (String(holding?.overview?.region ?? "") === from) holding.overview.region = to;
    const tables = holding?.gm?.eventTables;
    for (const kind of ["general", "external"]) {
      for (const row of tables?.[kind]?.rows ?? []) {
        for (const dependencyKind of ["requirements", "boosts"]) {
          const rules = row?.[dependencyKind]?.rules;
          if (!Array.isArray(rules)) continue;
          if (to) {
            for (const rule of rules) {
              if (rule?.type === "region" && String(rule.value ?? "") === from) rule.value = to;
            }
          } else {
            row[dependencyKind].rules = rules.filter((rule) => !(rule?.type === "region" && String(rule.value ?? "") === from));
          }
        }
      }
    }
  }
  for (const region of data?.catalog?.eventRegions ?? []) {
    if (!Array.isArray(region.marketLinks)) continue;
    if (to) {
      for (const link of region.marketLinks) {
        if (String(link?.regionId ?? "") === from) link.regionId = to;
      }
    } else region.marketLinks = region.marketLinks.filter((link) => String(link?.regionId ?? "") !== from);
  }
}

export class SkyholdRegionCatalogEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ owner = null } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.regionId = "";
    this.activeSection = "overview";
    this.search = "";
    this.specialtySearch = "";
  }

  openRegion(regionId = "") {
    const id = String(regionId ?? "");
    const exists = normalizeEventRegionOptions(SkyholdData.get()?.catalog?.eventRegions, { fallback: false })
      .some((row) => String(row.value) === id);
    if (!exists) return false;
    this.regionId = id;
    this.activeSection = "overview";
    if (this.rendered) {
      this.requestRender({ focus: true });
      this.bringToFront?.();
    } else this.render({ force: true, focus: true });
    return true;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    let rows = regionCatalogRows(data?.catalog?.eventRegions, data?.catalog?.marketEconomy, this.regionId);
    if (!rows.some((row) => row.selected)) this.regionId = rows[0]?.value ?? "";
    rows = regionCatalogRows(data?.catalog?.eventRegions, data?.catalog?.marketEconomy, this.regionId);
    const selectedRegion = rows.find((row) => row.selected) ?? null;
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      rows,
      selectedRegion,
      search: this.search,
      specialtySearch: this.specialtySearch,
      hasRows: rows.length > 0,
      section: {
        overview: this.activeSection === "overview",
        economy: this.activeSection === "economy",
        logistics: this.activeSection === "logistics"
      }
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root);
    bindGlobalInputGuard(this, root);
    this._bindEvents(root);
  }

  _bindEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;
    const actions = {
      "region-catalog-add": "_onAddRegionOption",
      "region-catalog-delete": "_onDeleteRegionOption",
      "region-graph-open": "_onOpenRouteGraph",
      "region-catalog-select": "_onSelectRegion",
      "region-editor-section": "_onSelectSection"
    };

    root.addEventListener("click", (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      dispatchDelegatedAction(this, event, element, actions[String(element.dataset.action ?? "")]);
    }, { signal: controller.signal });

    root.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const transport = target.closest?.("[data-region-transport-mode]");
      if (transport && root.contains(transport)) {
        this._onTransportModeChange(event, transport);
        return;
      }
      const specialty = target.closest?.("[data-region-specialty-id]");
      if (specialty && root.contains(specialty)) {
        this._onSpecialtyChange(event, specialty);
        return;
      }
      const field = target.closest?.("[data-region-catalog-field]");
      if (field && root.contains(field)) this._onRegionCatalogFieldChange(event, field);
    }, { signal: controller.signal });
    root.addEventListener("input", (event) => {
      const specialtyField = event.target?.closest?.("[data-region-specialty-search]");
      if (specialtyField && root.contains(specialtyField)) {
        this.specialtySearch = String(specialtyField.value ?? "");
        this._applySpecialtySearch(root, this.specialtySearch);
        return;
      }
      const field = event.target?.closest?.("[data-region-search]");
      if (!field || !root.contains(field)) return;
      this.search = String(field.value ?? "");
      this._applySearch(root, this.search);
    }, { signal: controller.signal });
    this._applySearch(root, this.search);
    this._applySpecialtySearch(root, this.specialtySearch);
  }

  _applySpecialtySearch(root, value = "") {
    const query = String(value ?? "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    for (const card of root?.querySelectorAll?.("[data-region-specialty-search-text]") ?? []) {
      const haystack = String(card.dataset.regionSpecialtySearchText ?? "").toLocaleLowerCase("ru");
      const show = !query || haystack.includes(query);
      card.hidden = !show;
      if (show) visible += 1;
    }
    const count = root?.querySelector?.("[data-region-specialty-visible-count]");
    if (count) count.textContent = String(visible);
  }

  _applySearch(root, value = "") {
    const query = String(value ?? "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    for (const card of root?.querySelectorAll?.("[data-region-search-text]") ?? []) {
      const show = !query || String(card.dataset.regionSearchText ?? "").includes(query);
      card.hidden = !show;
      if (show) visible += 1;
    }
    const count = root?.querySelector?.("[data-region-visible-count]");
    if (count) count.textContent = String(visible);
  }

  _onSelectRegion(event) {
    event.preventDefault();
    this.regionId = String(event.currentTarget?.dataset?.regionId ?? "");
    this.requestRender({ focus: false });
  }

  _onSelectSection(event) {
    event.preventDefault();
    const section = String(event.currentTarget?.dataset?.section ?? "overview");
    this.activeSection = ["overview", "economy", "logistics"].includes(section) ? section : "overview";
    this.requestRender({ focus: false });
  }

  async _onOpenRouteGraph(event) {
    event.preventDefault();
    await openRouteGraphApp({ owner: this });
  }

  _refreshOwner() {
    this.owner?.requestRender?.({ focus: false });
  }

  async _onAddRegionOption(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const saved = await SkyholdData.transaction((data) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      const rows = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
      let index = rows.length + 1;
      let value = `region-${index}`;
      const existing = new Set(rows.map((row) => String(row.value ?? "")));
      while (existing.has(value)) {
        index += 1;
        value = `region-${index}`;
      }
      const economy = normalizeMarketEconomy(data.catalog.marketEconomy, { locations: rows });
      rows.push({ value, label: "Новая рыночная локация", aliases: [], countryId: economy.countries[0]?.id ?? value, marketSizeId: "town", marketSpecialtyIds: [], marketConditionId: "" });
      data.catalog.eventRegions = normalizeEventRegionOptions(rows, { fallback: false });
      return value;
    }, { reason: "region-catalog:add" });
    if (!saved) return;
    this.regionId = String(saved);
    this.activeSection = "overview";
    this._refreshOwner();
    this.requestRender({ focus: false });
  }

  async _onDeleteRegionOption(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    const regionId = String(event.currentTarget?.dataset?.regionId ?? this.regionId);
    if (!regionId) return;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      const rows = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
      const index = rows.findIndex((row) => String(row.value) === regionId);
      const removed = rows[index];
      if (!removed) return skip(false);
      rows.splice(index, 1);
      const nextRows = normalizeEventRegionOptions(rows, { fallback: false });
      data.catalog.eventRegions = nextRows;
      rewriteRegionReferences(data, removed.value, nextRows[0]?.value ?? "");
      return nextRows[0]?.value ?? "";
    }, { reason: "region-catalog:delete" });
    this.regionId = String(saved ?? "");
    this._refreshOwner();
    this.requestRender({ focus: false });
  }

  async _onRegionCatalogFieldChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const regionId = String(field.dataset.regionId ?? this.regionId);
    const key = String(field.dataset.regionCatalogField ?? "");
    if (!regionId || !REGION_FIELDS.has(key)) return;
    const value = MARKET_FACTOR_FIELDS.has(key) && String(field.value ?? "").trim() === "" ? "" : fieldValue(field);
    const saved = await SkyholdData.transaction((data, { skip }) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      const rows = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
      const index = rows.findIndex((row) => String(row.value) === regionId);
      const row = rows[index];
      if (!row) return skip(false);
      const previousValue = String(row.value ?? "");
      row[key] = MARKET_ARRAY_FIELDS.has(key) || MARKET_FACTOR_FIELDS.has(key) || ["marketEnabled", "marketAirshipOnly"].includes(key) ? value : String(value ?? "").trim();
      const nextRows = normalizeEventRegionOptions(rows, { fallback: false });
      data.catalog.eventRegions = nextRows;
      if (key === "value") rewriteRegionReferences(data, previousValue, nextRows[index]?.value ?? "");
      return key === "value" ? nextRows[index]?.value ?? previousValue : true;
    }, { reason: `region-catalog:${key}` });
    if (!saved) return;
    const nextRegionId = key === "value" ? String(saved) : regionId;
    this._syncEditedRegionUi({ key, value, regionId, nextRegionId });
    if (key === "value") this.regionId = nextRegionId;
    this._refreshOwner();
  }

  _syncEditedRegionUi({ key, value, regionId, nextRegionId }) {
    const root = this.element;
    if (!root) return;
    const card = Array.from(root.querySelectorAll("[data-region-id]")).find((row) => row.matches?.(".fbls-region-card") && String(row.dataset.regionId) === regionId);
    if (key === "label") {
      const label = String(value ?? "");
      const cardLabel = card?.querySelector?.(".fbls-region-card-copy strong");
      const heroLabel = root.querySelector(".fbls-region-detail-hero h3");
      if (cardLabel) cardLabel.textContent = label;
      if (heroLabel) heroLabel.textContent = label;
    } else if (key === "value") {
      for (const element of root.querySelectorAll("[data-region-id]")) {
        if (String(element.dataset.regionId) === regionId) element.dataset.regionId = nextRegionId;
      }
      const cardId = card?.querySelector?.(".fbls-region-card-copy small");
      if (cardId) cardId.textContent = nextRegionId;
    } else if (key === "marketEnabled" && card) {
      card.classList.toggle("is-disabled", !Boolean(value));
      const icon = card.querySelector(".fbls-region-card-state i");
      icon?.classList.toggle("fa-check", Boolean(value));
      icon?.classList.toggle("fa-pause", !Boolean(value));
    } else if (key === "marketStatus" && card) {
      const status = MARKET_STATUS_OPTIONS.find((row) => row.value === String(value));
      const label = card.querySelector(".fbls-region-card-meta em");
      if (label && status) label.textContent = status.label;
    }
  }

  async _onTransportModeChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const regionId = String(field.dataset.regionId ?? this.regionId);
    const mode = String(field.dataset.regionTransportMode ?? "");
    if (!regionId || !MARKET_TRANSPORT_MODES.some((row) => row.value === mode)) return;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const rows = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const row = rows.find((item) => String(item.value) === regionId);
      if (!row) return skip(false);
      const modes = new Set(row.marketTransportModes ?? []);
      if (field.checked) modes.add(mode);
      else modes.delete(mode);
      row.marketTransportModes = [...modes];
      data.catalog.eventRegions = normalizeEventRegionOptions(rows, { fallback: false });
      return true;
    }, { reason: `region-catalog:transport:${mode}` });
    if (saved) this._refreshOwner();
  }

  async _onSpecialtyChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const regionId = String(field.dataset.regionId ?? this.regionId);
    const specialtyId = String(field.dataset.regionSpecialtyId ?? "");
    if (!regionId || !specialtyId) return;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const rows = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const row = rows.find((item) => String(item.value) === regionId);
      if (!row) return skip(false);
      const specialtyIds = new Set(row.marketSpecialtyIds ?? []);
      if (field.checked) specialtyIds.add(specialtyId);
      else specialtyIds.delete(specialtyId);
      row.marketSpecialtyIds = [...specialtyIds];
      data.catalog.eventRegions = normalizeEventRegionOptions(rows, { fallback: false });
      return true;
    }, { reason: `region-catalog:specialty:${specialtyId}` });
    if (saved) this._refreshOwner();
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    unbindGlobalInputGuard(this);
  }
}

SkyholdRegionCatalogEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-region-catalog-editor"],
  tag: "section",
  window: {
    title: "Рынки-локации, государства и логистика",
    icon: "fa-solid fa-map-location-dot",
    resizable: true
  },
  position: {
    width: 1120,
    height: 760
  }
};

SkyholdRegionCatalogEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/region-catalog-editor.hbs`
  }
};
