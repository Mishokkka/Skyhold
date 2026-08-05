import { MODULE_ID } from "../../data/constants.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { marketEconomySummary, normalizeMarketEconomy } from "../../data/market/economy.js";
import {
  prepareMarketEconomySettingsForEditor,
  marketEconomySettingFromEditor,
  storedLoadFromMarketCargoPoints
} from "../../data/market/editor-units.js";
import { allResourceDefs } from "../../core/resources.js";
import { fieldValue } from "../../core/helpers.js";
import { requestSkyholdAppRender } from "../registry.js";
import { SkyholdMarketApp } from "../market-app.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { bindGlobalInputGuard, bindInputGuards, sanitizeTextBlock, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { SkyholdResourceCatalogEditor } from "./resource-catalog-editor.js";
import { openRouteGraphApp } from "../lazy-apps.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const SECTIONS = new Set(["base", "countries", "specialties", "organizations", "system"]);
const VISIBILITY_OPTIONS = [
  { value: "public", label: "Игрокам и GM" },
  { value: "gm", label: "Только GM" }
];
const KIND_OPTIONS = [
  { value: "material", label: "Материал" },
  { value: "resource", label: "Ресурс" },
  { value: "consumable", label: "Расходник" }
];
const UBIQUITY_OPTIONS = [
  { value: "essential", label: "Повсеместный" },
  { value: "common", label: "Обычный" },
  { value: "ordinary", label: "Развитый рынок" },
  { value: "specialized", label: "Крупный рынок" },
  { value: "restricted", label: "Мировой узел / особый" }
];
const RULE_MODE_OPTIONS = [
  { value: "produce", label: "Производит: больше и дешевле" },
  { value: "consume", label: "Потребляет: меньше и дороже" },
  { value: "adjust", label: "Ручная корректировка" },
  { value: "restrict", label: "Исключает из ассортимента" }
];
const PRICE_MODE_OPTIONS = [
  { value: "catalog", label: "Цена ресурса из каталога" },
  { value: "manual", label: "Ручная цена товара" },
  { value: "legacy", label: "Старая сохранённая цена" }
];
const TRANSPORT_OPTIONS = [
  { value: "caravan", label: "Караван", icon: "fa-solid fa-cart-flatbed" },
  { value: "rail", label: "Железная дорога", icon: "fa-solid fa-train" },
  { value: "airship", label: "Воздушный корабль", icon: "fa-solid fa-ship" }
];

function selectedOptions(options, value) {
  return options.map((row) => ({ ...row, selected: row.value === String(value ?? "") }));
}

function textList(value) {
  return (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((row) => String(row ?? "").trim())
    .filter(Boolean);
}

function prepareOffer(offer = {}, resourcesById = new Map()) {
  const resourceId = String(offer.resourceId ?? "");
  const resource = resourcesById.get(resourceId) ?? {};
  const isCustomOffer = offer.sourceType === "item" || resourceId === "custom";
  const priceMode = String(offer.priceMode ?? "legacy");
  const catalogReferencePriceCopper = Math.max(0, Math.round(Number(resource.referencePriceCopper) || 0));
  const baseAskStock = Math.max(0, Math.floor(Number(offer.baseAskStock ?? offer.baseStock) || 0));
  const baseBidDemand = Math.max(0, Math.floor(Number(offer.baseBidDemand) || 0));
  const bidSpreadPct = Math.round(Math.max(0.05, Math.min(0.5, Number(offer.bidSpreadRate) || 0.18)) * 100);
  const displayName = String(offer.name ?? "").trim() || String(resource.label ?? offer.resourceId ?? "Товар");
  const inheritedLoad = offer.loadMode === "auto" && resource.load !== undefined && resource.load !== null;
  const inheritedCargo = offer.loadMode === "auto" && Number(resource.cargoPoints) > 0;
  const cargoPoints = inheritedCargo
    ? Math.max(1, Math.ceil(Number(resource.cargoPoints) || 1))
    : Math.max(1, Math.ceil(Number(offer.cargoPoints) || (Number(offer.load) || 0) * 10 || 1));
  const cargoClass = inheritedCargo
    ? String(resource.cargoClass ?? cargoPoints)
    : String(offer.cargoClass ?? "").trim() || (cargoPoints > 40 ? "oversized" : "manual");
  return {
    ...offer,
    priceMode,
    priceModeOptions: selectedOptions(PRICE_MODE_OPTIONS, priceMode).map((row) => ({
      ...row,
      disabled: row.value === "catalog" ? isCustomOffer : row.value === "manual" && !isCustomOffer
    })),
    priceModeHint: priceMode === "catalog"
      ? `Котировка начинается с цены ресурса: ${catalogReferencePriceCopper} ММ за единицу.`
      : priceMode === "manual"
        ? "Котировка начинается с ручной цены этого особого товара."
        : "Совместимость: используется цена, сохранённая старой версией мира.",
    storedPriceHint: priceMode === "catalog"
      ? "Не участвует в расчёте, пока выбрана цена из каталога."
      : "Это исходная цена до условий рынка и поправки торговца.",
    catalogPriceMode: priceMode === "catalog",
    baseAskStock,
    baseBidDemand,
    bidSpreadPct,
    load: inheritedLoad ? resource.load : offer.load,
    loadAuto: offer.loadMode === "auto",
    loadManual: offer.loadMode === "manual",
    cargoPoints,
    cargoClass,
    cargoPointsInherited: inheritedCargo,
    cargoPointsHint: inheritedCargo
      ? `Из каталога ресурса · класс ${cargoClass}`
      : `Ручное исключение · класс ${cargoClass}`,
    displayName,
    displayIcon: String(offer.icon ?? "").trim() || String(resource.icon ?? "fa-solid fa-box"),
    tagsText: (offer.tags ?? []).join(", "),
    searchText: `${displayName} ${offer.id ?? ""} ${offer.resourceId ?? ""} ${offer.kind ?? ""} ${offer.ubiquity ?? ""} ${(offer.tags ?? []).join(" ")}`.toLocaleLowerCase("ru"),
    kindOptions: selectedOptions(KIND_OPTIONS, offer.kind),
    ubiquityOptions: selectedOptions(UBIQUITY_OPTIONS, offer.ubiquity),
    visibilityOptions: selectedOptions(VISIBILITY_OPTIONS, offer.visibility)
  };
}

function prepareRule(rule = {}) {
  return {
    ...rule,
    targetTagsText: (rule.targetTags ?? []).join(", "),
    resourceIdsText: (rule.resourceIds ?? []).join(", "),
    modeOptions: selectedOptions(RULE_MODE_OPTIONS, rule.mode)
  };
}

function presenceRow(rows = [], countryId = "") {
  return rows.find((row) => String(row.countryId ?? "") === String(countryId ?? "")) ?? {
    countryId,
    sharePct: 0,
    modeShares: { caravan: null, rail: null, airship: null },
    active: true
  };
}

function preparedOrganization(organization = {}, countries = []) {
  const carrierModes = new Set(organization.carrier?.modes ?? []);
  return {
    ...organization,
    tagsText: (organization.tags ?? []).join(", "),
    visibilityOptions: selectedOptions(VISIBILITY_OPTIONS, organization.visibility),
    merchant: {
      ...organization.merchant,
      includeTagsText: (organization.merchant?.includeTags ?? []).join(", "),
      excludeTagsText: (organization.merchant?.excludeTags ?? []).join(", ")
    },
    carrier: {
      ...organization.carrier,
      transportOptions: TRANSPORT_OPTIONS.map((row) => ({ ...row, selected: carrierModes.has(row.value) }))
    },
    countryRows: countries.map((country) => {
      const merchant = presenceRow(organization.merchant?.countryShares, country.id);
      const carrier = presenceRow(organization.carrier?.countryShares, country.id);
      return {
        id: country.id,
        label: country.label,
        merchantSharePct: merchant.sharePct,
        carrierSharePct: carrier.sharePct,
        caravanSharePct: carrier.modeShares?.caravan,
        railSharePct: carrier.modeShares?.rail,
        airshipSharePct: carrier.modeShares?.airship
      };
    })
  };
}

function refreshOpenMarketWindows() {
  for (const app of SkyholdMarketApp.instances.values()) app.requestRender?.({ focus: false });
}

function economyTarget(economy, scope, ownerId = "", rowId = "") {
  if (scope === "settings") return economy.settings;
  if (scope === "base-offer") return economy.baseOffers.find((row) => row.id === rowId);
  if (scope === "size") return economy.sizeProfiles.find((row) => row.id === rowId);
  if (scope === "condition") return economy.conditions.find((row) => row.id === rowId);
  const country = economy.countries.find((row) => row.id === ownerId);
  if (scope === "country") return country;
  if (scope === "country-rule") return country?.rules?.find((row) => row.id === rowId);
  if (scope === "country-offer") return country?.offers?.find((row) => row.id === rowId);
  const specialty = economy.specialties.find((row) => row.id === ownerId);
  if (scope === "specialty") return specialty;
  if (scope === "specialty-rule") return specialty?.rules?.find((row) => row.id === rowId);
  if (scope === "specialty-offer") return specialty?.offers?.find((row) => row.id === rowId);
  const organization = economy.organizations.find((row) => row.id === ownerId);
  if (scope === "organization") return organization;
  if (scope === "organization-merchant") return organization?.merchant;
  if (scope === "organization-carrier") return organization?.carrier;
  return null;
}

function defaultOffer(id = makeId("offer", 12)) {
  return {
    id,
    active: true,
    visibility: "public",
    sourceType: "resource",
    resourceId: "custom",
    name: "Новый товар",
    unit: "ед.",
    icon: "fa-solid fa-box",
    img: "",
    kind: "material",
    ubiquity: "common",
    forceAvailable: false,
    priceMode: "manual",
    basePriceCopper: 10,
    bidSpreadRate: 0.18,
    volatility: 0.2,
    baseAskStock: 10,
    baseStock: 10,
    baseBidDemand: 8,
    economyVersion: 2,
    loadMode: "auto",
    cargoClass: "10",
    cargoPoints: 10,
    load: 1,
    accessDifficulty: 0,
    origin: "",
    tags: []
  };
}

function defaultRule(id = makeId("rule", 12)) {
  return { id, label: "Новое правило", active: true, mode: "adjust", targetTags: [], resourceIds: [], stockFactor: 1, priceFactor: 1, volatilityFactor: 1, notes: "" };
}

export class SkyholdMarketCatalogEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor(options = {}) {
    super(options);
    this.activeSection = "base";
    this.countryId = "";
    this.specialtyId = "";
    this.organizationId = "";
    this.searches = { base: "", country: "", specialty: "", organization: "" };
  }

  static open(options = {}) {
    const app = new this(options);
    app.render({ force: true, focus: true });
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.get();
    const locations = data?.catalog?.eventRegions ?? [];
    const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations });
    const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
    const resourcesById = new Map(resources.map((row) => [String(row.id ?? ""), row]));
    if (!economy.countries.some((row) => row.id === this.countryId)) this.countryId = economy.countries[0]?.id ?? "";
    if (!economy.specialties.some((row) => row.id === this.specialtyId)) this.specialtyId = economy.specialties[0]?.id ?? "";
    if (!economy.organizations.some((row) => row.id === this.organizationId)) this.organizationId = economy.organizations[0]?.id ?? "";

    const selectedCountry = economy.countries.find((row) => row.id === this.countryId) ?? null;
    const selectedSpecialty = economy.specialties.find((row) => row.id === this.specialtyId) ?? null;
    const selectedOrganization = economy.organizations.find((row) => row.id === this.organizationId) ?? null;
    const conditionOptions = (value) => selectedOptions(economy.conditions.map((row) => ({ value: row.id, label: row.label })), value);
    const summary = marketEconomySummary(economy, locations);

    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      section: Object.fromEntries([...SECTIONS].map((key) => [key, this.activeSection === key])),
      summary,
      settings: prepareMarketEconomySettingsForEditor(economy.settings),
      baseOffers: economy.baseOffers.map((row) => prepareOffer(row, resourcesById)),
      countries: economy.countries.map((row) => ({ ...row, selected: row.id === this.countryId, searchText: `${row.label} ${row.id} ${(row.tags ?? []).join(" ")}`.toLocaleLowerCase("ru") })),
      selectedCountry: selectedCountry ? {
        ...selectedCountry,
        tagsText: (selectedCountry.tags ?? []).join(", "),
        conditionOptions: conditionOptions(selectedCountry.conditionId),
        visibilityOptions: selectedOptions(VISIBILITY_OPTIONS, selectedCountry.visibility),
        rules: selectedCountry.rules.map(prepareRule),
        offers: selectedCountry.offers.map((row) => prepareOffer(row, resourcesById)),
        locationCount: locations.filter((row) => String(row.countryId ?? row.value ?? "") === selectedCountry.id).length
      } : null,
      specialties: economy.specialties.map((row) => ({ ...row, selected: row.id === this.specialtyId, searchText: `${row.label} ${row.category} ${row.id}`.toLocaleLowerCase("ru") })),
      selectedSpecialty: selectedSpecialty ? {
        ...selectedSpecialty,
        rules: selectedSpecialty.rules.map(prepareRule),
        offers: selectedSpecialty.offers.map((row) => prepareOffer(row, resourcesById)),
        locationCount: locations.filter((row) => (row.marketSpecialtyIds ?? []).includes(selectedSpecialty.id)).length
      } : null,
      organizations: economy.organizations.map((row) => ({ ...row, selected: row.id === this.organizationId, searchText: `${row.label} ${row.id} ${(row.tags ?? []).join(" ")}`.toLocaleLowerCase("ru") })),
      selectedOrganization: selectedOrganization ? preparedOrganization(selectedOrganization, economy.countries) : null,
      sizeProfiles: economy.sizeProfiles.map((row) => ({ ...row, ubiquityOptions: selectedOptions(UBIQUITY_OPTIONS, row.maxUbiquity) })),
      conditions: economy.conditions,
      searches: this.searches
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root, { textareaSanitizer: sanitizeTextBlock });
    bindGlobalInputGuard(this, root);
    this._marketEconomyAbortController?.abort?.();
    const controller = new AbortController();
    this._marketEconomyAbortController = controller;
    const listenerOptions = { signal: controller.signal };
    root.addEventListener("click", (event) => this._onClick(event, root), listenerOptions);
    root.addEventListener("change", (event) => this._onChange(event, root), listenerOptions);
    root.addEventListener("input", (event) => this._onInput(event, root), listenerOptions);
    for (const [kind, value] of Object.entries(this.searches)) this._applySearch(root, kind, value);
  }

  async _onClick(event, root) {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains(element)) return;
    const action = String(element.dataset.action ?? "");
    if (action === "market-economy-section") {
      event.preventDefault();
      const section = String(element.dataset.section ?? "base");
      this.activeSection = SECTIONS.has(section) ? section : "base";
      this.requestRender({ focus: false });
    } else if (action === "market-country-select") {
      event.preventDefault();
      this.countryId = String(element.dataset.countryId ?? "");
      this.requestRender({ focus: false });
    } else if (action === "market-specialty-select") {
      event.preventDefault();
      this.specialtyId = String(element.dataset.specialtyId ?? "");
      this.requestRender({ focus: false });
    } else if (action === "market-organization-select") {
      event.preventDefault();
      this.organizationId = String(element.dataset.organizationId ?? "");
      this.requestRender({ focus: false });
    } else if (action === "market-economy-add") this._onAdd(event, element);
    else if (action === "market-economy-delete") this._onDelete(event, element);
    else if (action === "market-economy-pick-resource") this._onPickResource(event, element);
    else if (action === "market-route-graph-open") {
      event.preventDefault();
      await openRouteGraphApp({ owner: this });
    }
  }

  _onInput(event, root) {
    const field = event.target?.closest?.("[data-economy-search]");
    if (!field || !root.contains(field)) return;
    const kind = String(field.dataset.economySearch ?? "");
    this.searches[kind] = String(field.value ?? "");
    this._applySearch(root, kind, field.value);
  }

  _applySearch(root, kind = "", value = "") {
    const query = String(value ?? "").trim().toLocaleLowerCase("ru");
    let visible = 0;
    for (const row of root.querySelectorAll?.(`[data-economy-search-row="${kind}"]`) ?? []) {
      const show = !query || String(row.dataset.economySearchText ?? "").includes(query);
      row.hidden = !show;
      if (show) visible += 1;
    }
    const count = root.querySelector?.(`[data-economy-search-count="${kind}"]`);
    if (count) count.textContent = String(visible);
    const empty = root.querySelector?.(`[data-economy-search-empty="${kind}"]`);
    if (empty) empty.hidden = visible > 0;
  }

  _onChange(event, root) {
    const mode = event.target?.closest?.("[data-organization-carrier-mode]");
    if (mode && root.contains(mode)) {
      this._onCarrierModeChange(event, mode);
      return;
    }
    const field = event.target?.closest?.("[data-economy-field]");
    if (field && root.contains(field)) this._onEconomyFieldChange(event, field);
  }

  async _mutate(reason, mutator, { rerender = false } = {}) {
    if (!game.user?.isGM) return false;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      if (!data.catalog || typeof data.catalog !== "object") data.catalog = {};
      const locations = data.catalog.eventRegions ?? [];
      const economy = normalizeMarketEconomy(data.catalog.marketEconomy, { locations });
      const result = mutator(economy, data);
      if (result === false) return skip(false);
      data.catalog.markets = [];
      data.catalog.marketEconomy = normalizeMarketEconomy(economy, { locations: data.catalog.eventRegions ?? locations });
      return true;
    }, { reason: `market-economy:${reason}` });
    if (!saved) return false;
    requestSkyholdAppRender();
    refreshOpenMarketWindows();
    if (rerender) this.requestRender({ focus: false });
    return true;
  }

  async _onEconomyFieldChange(event, field) {
    event.preventDefault();
    const scope = String(field.dataset.scope ?? "");
    const ownerId = String(field.dataset.ownerId ?? "");
    const rowId = String(field.dataset.rowId ?? "");
    const inputKey = String(field.dataset.economyField ?? "");
    if (!scope || !inputKey) return;
    let key = inputKey === "bidSpreadPct" ? "bidSpreadRate" : inputKey;
    let value = fieldValue(field);
    if (field.hasAttribute("data-list")) value = textList(field.value);
    if (field instanceof HTMLTextAreaElement) value = sanitizeTextBlock(value);
    if (inputKey === "bidSpreadPct") {
      const spreadPct = Number(value);
      value = Math.max(0.05, Math.min(0.5, (Number.isFinite(spreadPct) ? spreadPct : 18) / 100));
    }
    if (scope === "settings") ({ key, value } = marketEconomySettingFromEditor(inputKey, value));
    const rerender = field.hasAttribute("data-rerender");
    await this._mutate(`${scope}:${key}`, (economy) => {
      if (scope === "organization-merchant-presence" || scope === "organization-carrier-presence") {
        const organization = economy.organizations.find((row) => row.id === ownerId);
        const role = scope === "organization-merchant-presence" ? "merchant" : "carrier";
        if (!organization) return false;
        let presence = organization[role].countryShares.find((row) => row.countryId === rowId);
        if (!presence) {
          presence = { countryId: rowId, sharePct: 0, modeShares: { caravan: null, rail: null, airship: null }, active: true };
          organization[role].countryShares.push(presence);
        }
        if (key.startsWith("mode.")) {
          presence.modeShares ??= { caravan: null, rail: null, airship: null };
          presence.modeShares[key.slice(5)] = String(field.value ?? "").trim() === "" ? null : Number(value);
        } else presence[key] = value;
        return true;
      }
      const target = economyTarget(economy, scope, ownerId, rowId);
      if (!target) return false;
      target[key] = value;
      if (key === "baseAskStock" || key === "baseBidDemand") target[key] = Math.max(0, Math.floor(Number(value) || 0));
      if (key === "cargoPoints") {
        target.economyVersion = 2;
        target.cargoPoints = Math.max(1, Math.ceil(Number(value) || 1));
        target.load = storedLoadFromMarketCargoPoints(target.cargoPoints);
        target.cargoClass = target.cargoPoints > 40 ? "oversized" : "manual";
        target.loadMode = "manual";
      }
      if (key === "load") target.loadMode = "manual";
      return true;
    }, { rerender });
    const card = field.closest?.("[data-economy-card]");
    if (key === "active" && card) card.classList.toggle("is-disabled", !Boolean(value));
  }

  async _onCarrierModeChange(event, field) {
    event.preventDefault();
    const organizationId = String(field.dataset.ownerId ?? "");
    const mode = String(field.dataset.organizationCarrierMode ?? "");
    if (!TRANSPORT_OPTIONS.some((row) => row.value === mode)) return;
    await this._mutate(`carrier-mode:${mode}`, (economy) => {
      const organization = economy.organizations.find((row) => row.id === organizationId);
      if (!organization) return false;
      const modes = new Set(organization.carrier.modes ?? []);
      if (field.checked) modes.add(mode);
      else modes.delete(mode);
      organization.carrier.modes = [...modes];
      return true;
    });
  }

  async _onAdd(event, element) {
    event.preventDefault();
    const kind = String(element.dataset.kind ?? "");
    let selectedId = "";
    const saved = await this._mutate(`add:${kind}`, (economy) => {
      if (kind === "base-offer") economy.baseOffers.push(defaultOffer());
      else if (kind === "country") {
        selectedId = makeId("country", 12);
        economy.countries.push({ id: selectedId, label: "Новое государство", active: true, visibility: "public", description: "", conditionId: "stable", tradeRegime: "open", taxRate: 0, priceFactor: 1, stockFactor: 1, deliveryFactor: 1, timeFactor: 1, riskFactor: 1, rules: [], offers: [], tags: [] });
      } else if (kind === "country-rule") {
        const country = economy.countries.find((row) => row.id === this.countryId);
        if (!country) return false;
        country.rules.push(defaultRule());
      } else if (kind === "country-offer") {
        const country = economy.countries.find((row) => row.id === this.countryId);
        if (!country) return false;
        country.offers.push({ ...defaultOffer(), forceAvailable: true, ubiquity: "specialized" });
      } else if (kind === "specialty") {
        selectedId = makeId("specialty", 12);
        economy.specialties.push({ id: selectedId, label: "Новая специализация", category: "Прочее", description: "", active: true, rules: [], offers: [] });
      } else if (kind === "specialty-rule") {
        const specialty = economy.specialties.find((row) => row.id === this.specialtyId);
        if (!specialty) return false;
        specialty.rules.push(defaultRule());
      } else if (kind === "specialty-offer") {
        const specialty = economy.specialties.find((row) => row.id === this.specialtyId);
        if (!specialty) return false;
        specialty.offers.push({ ...defaultOffer(), forceAvailable: true, ubiquity: "specialized" });
      } else if (kind === "organization") {
        selectedId = makeId("organization", 12);
        economy.organizations.push({ id: selectedId, label: "Новая организация", active: true, visibility: "public", description: "", icon: "fa-solid fa-building-columns", tags: [], merchant: { enabled: true, countryShares: [], includeTags: [], excludeTags: [], priceFactor: 1, priceVolatility: 0.04, stockStability: 1 }, carrier: { enabled: false, countryShares: [], modes: ["caravan", "airship"], priceFactor: 1, timeFactor: 1, riskFactor: 1, capacityFactor: 1 } });
      } else if (kind === "size") {
        economy.sizeProfiles.push({ id: makeId("market-size", 12), label: "Новый размер", description: "", active: true, maxUbiquity: "ordinary", stockFactor: 1, priceFactor: 1, handlingFactor: 1 });
      } else if (kind === "condition") {
        economy.conditions.push({ id: makeId("market-condition", 12), label: "Новое состояние", description: "", active: true, priceFactor: 1, stockFactor: 1, deliveryFactor: 1, timeFactor: 1, riskFactor: 1, volatilityFactor: 1 });
      } else return false;
      return true;
    }, { rerender: true });
    if (!saved) return;
    if (kind === "country") this.countryId = selectedId;
    if (kind === "specialty") this.specialtyId = selectedId;
    if (kind === "organization") this.organizationId = selectedId;
    if (selectedId) this.requestRender({ focus: false });
  }

  async _onDelete(event, element) {
    event.preventDefault();
    const kind = String(element.dataset.kind ?? "");
    const ownerId = String(element.dataset.ownerId ?? "");
    const rowId = String(element.dataset.rowId ?? "");
    if (["country", "specialty", "organization"].includes(kind)) {
      const confirmed = await this._confirm("Удалить выбранную запись? Ссылки на неё будут очищены.");
      if (!confirmed) return;
    }
    await this._mutate(`delete:${kind}`, (economy, data) => {
      if (kind === "base-offer") economy.baseOffers = economy.baseOffers.filter((row) => row.id !== rowId);
      else if (kind === "country") {
        const fallback = economy.countries.find((row) => row.id !== rowId)?.id ?? "";
        economy.countries = economy.countries.filter((row) => row.id !== rowId);
        for (const location of data.catalog.eventRegions ?? []) if (String(location.countryId ?? "") === rowId) location.countryId = fallback || String(location.value ?? "");
        for (const organization of economy.organizations) {
          organization.merchant.countryShares = organization.merchant.countryShares.filter((row) => row.countryId !== rowId);
          organization.carrier.countryShares = organization.carrier.countryShares.filter((row) => row.countryId !== rowId);
        }
      } else if (kind === "country-rule") {
        const country = economy.countries.find((row) => row.id === ownerId);
        if (!country) return false;
        country.rules = country.rules.filter((row) => row.id !== rowId);
      } else if (kind === "country-offer") {
        const country = economy.countries.find((row) => row.id === ownerId);
        if (!country) return false;
        country.offers = country.offers.filter((row) => row.id !== rowId);
      } else if (kind === "specialty") {
        economy.specialties = economy.specialties.filter((row) => row.id !== rowId);
        for (const location of data.catalog.eventRegions ?? []) location.marketSpecialtyIds = (location.marketSpecialtyIds ?? []).filter((id) => id !== rowId);
      } else if (kind === "specialty-rule") {
        const specialty = economy.specialties.find((row) => row.id === ownerId);
        if (!specialty) return false;
        specialty.rules = specialty.rules.filter((row) => row.id !== rowId);
      } else if (kind === "specialty-offer") {
        const specialty = economy.specialties.find((row) => row.id === ownerId);
        if (!specialty) return false;
        specialty.offers = specialty.offers.filter((row) => row.id !== rowId);
      } else if (kind === "organization") economy.organizations = economy.organizations.filter((row) => row.id !== rowId);
      else if (kind === "size") economy.sizeProfiles = economy.sizeProfiles.filter((row) => row.id !== rowId);
      else if (kind === "condition") economy.conditions = economy.conditions.filter((row) => row.id !== rowId);
      else return false;
      return true;
    }, { rerender: true });
  }

  _onPickResource(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const scope = String(element.dataset.scope ?? "");
    const ownerId = String(element.dataset.ownerId ?? "");
    const rowId = String(element.dataset.rowId ?? "");
    SkyholdResourceCatalogEditor.pick({
      selectedId: String(element.dataset.resourceId ?? ""),
      onSelect: async (resource) => {
        await this._mutate("pick-resource", (economy) => {
          const offer = economyTarget(economy, scope, ownerId, rowId);
          if (!offer) return false;
          offer.sourceType = "resource";
          offer.resourceId = String(resource.id ?? "custom");
          offer.priceMode = offer.resourceId === "custom" ? "manual" : "catalog";
          if (!String(offer.name ?? "").trim() || offer.name === "Новый товар") offer.name = String(resource.label ?? "");
          offer.icon = String(resource.icon ?? offer.icon ?? "fa-solid fa-box");
          offer.img = String(resource.img ?? offer.img ?? "");
          offer.unit = String(resource.unitLabel ?? resource.unit ?? "ед.");
          offer.priceBasis = String(resource.priceBasis ?? "");
          offer.economyVersion = Math.max(1, Math.floor(Number(resource.economyVersion) || 1));
          offer.loadMode = "auto";
          offer.cargoClass = String(resource.cargoClass ?? "10");
          offer.cargoPoints = Math.max(1, Math.ceil(Number(resource.cargoPoints) || (Number(resource.load) || 0) * 10 || 1));
          offer.load = Math.max(0, Number(resource.load) || 0);
          return true;
        }, { rerender: true });
      }
    });
  }

  async _confirm(message) {
    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (DialogV2?.confirm) return DialogV2.confirm({ window: { title: "Экономика рынков" }, content: `<p>${message}</p>`, modal: true });
    return window.confirm(message);
  }

  async _onClose(options) {
    await super._onClose(options);
    this._marketEconomyAbortController?.abort?.();
    unbindGlobalInputGuard(this);
  }
}

SkyholdMarketCatalogEditor.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-market-catalog-editor",
  classes: ["fbl-skyhold", "fbl-skyhold-market-catalog-editor"],
  tag: "section",
  window: { title: "Экономика внешнего рынка", icon: "fa-solid fa-shop", resizable: true },
  position: { width: 1320, height: 860 }
};

SkyholdMarketCatalogEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/market-catalog-editor.hbs` }
};
