import { MODULE_ID } from "../data/constants.js";
import { holdingPermissionContext } from "../data/holding-permissions.js";
import { HoldingService } from "../data/holding-service.js";
import {
  createFleetVessel,
  FLEET_ACQUISITION_METHODS,
  FLEET_OFFER_KINDS,
  FLEET_OFFER_LIMIT,
  FLEET_TRANSFER_METHODS,
  fleetVesselAvailableCopper,
  VESSEL_STATUSES
} from "../data/normalizers/fleet.js";
import { requestStorageOperation, SkyholdData } from "../data/store.js";
import { makeId } from "../data/utils.js";
import {
  addFleetOffer,
  fleetCrewReadiness,
  quoteFleetOffer,
  quoteFleetRepair,
  startFleetRepair
} from "../engines/fleet/enterprise.js";
import { fleetVesselMarketCapacity, generateFleetMarketOffers } from "../engines/fleet/market-integration.js";
import { marketQuotePeriodKey } from "../engines/market/pricing.js";
import { normalizeMarketEconomy } from "../data/market/economy.js";
import { effectiveMarketLocations } from "../engines/market/composition.js";
import { allResourceDefs } from "../core/resources.js";
import { WindowFrameMixin } from "./common/window-frame.js";
import { requestApplicationRender } from "./common/render-scheduler.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(number(value, fallback)));
}

function money(value) {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(whole(value))} мм`;
}

function signedMoney(value) {
  const amount = Math.trunc(number(value, 0));
  const absolute = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(Math.abs(amount));
  return `${amount < 0 ? "−" : ""}${absolute} мм`;
}

function cargoPointsText(value = 0) {
  const cargoPoints = Math.max(0, Math.round(number(value, 0)));
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(cargoPoints)} груз. очк.`;
}

function shortDate(value) {
  const parsed = new Date(String(value ?? ""));
  if (!Number.isFinite(parsed.getTime())) return String(value ?? "");
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(parsed);
}

function field(form, name) {
  return form?.elements?.namedItem?.(name) ?? null;
}

function fieldValue(form, name, fallback = "") {
  return String(field(form, name)?.value ?? fallback).trim();
}

function checked(form, name) {
  return Boolean(field(form, name)?.checked);
}

export class SkyholdShipEnterpriseApp extends WindowFrameMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ holdingId = "", vesselId = "", owner = null } = {}, options = {}) {
    super(options);
    this.holdingId = String(holdingId ?? "");
    this.vesselId = String(vesselId ?? "");
    this.owner = owner;
    this.pending = false;
    this.openDisclosures = new Set();
    SkyholdShipEnterpriseApp.instance = this;
  }

  static open(options = {}) {
    if (this.instance?.rendered) {
      this.instance.holdingId = String(options.holdingId ?? this.instance.holdingId ?? "");
      this.instance.vesselId = String(options.vesselId ?? this.instance.vesselId ?? "");
      this.instance.owner = options.owner ?? this.instance.owner;
      return this.instance.render({ force: true, focus: true });
    }
    this.instance = new this(options);
    return this.instance.render({ force: true, focus: true });
  }

  static rerenderOpen() {
    if (this.instance?.rendered && !this.instance.pending) this.instance.requestRender({ focus: false });
  }

  requestRender(options = {}) {
    return requestApplicationRender(this, options);
  }

  _entry({ mutable = false } = {}) {
    const data = mutable ? SkyholdData.get() : SkyholdData.view();
    const entry = mutable
      ? HoldingService.getHoldingEntry(this.holdingId, { fallback: false, data })
      : HoldingService.getReadableHoldingEntry(this.holdingId, { fallback: false, data });
    return { ...entry, data };
  }

  _activeVessel(holding) {
    const vessels = (holding?.special?.fleet?.vessels ?? []).filter((row) => game.user?.isGM || row?.visibility !== "gm");
    let vessel = vessels.find((row) => String(row?.id ?? "") === String(this.vesselId ?? ""));
    if (!vessel) vessel = vessels.find((row) => String(row?.id ?? "") === String(holding?.special?.fleet?.activeVesselId ?? ""));
    if (!vessel) vessel = vessels.find((row) => row?.status !== "archived") ?? vessels[0] ?? null;
    if (vessel) this.vesselId = String(vessel.id ?? "");
    return vessel;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const { data, holding } = this._entry();
    if (!holding) return { ...context, missing: true };
    const permissions = holdingPermissionContext(holding);
    const vessel = this._activeVessel(holding);
    const currentQd = whole(holding?.gm?.calendaria?.lastQd, 0);
    const canEdit = Boolean(game.user?.isGM);
    const canDecide = Boolean(permissions.canEditSpecial);
    const canTransfer = Boolean(game.user?.isGM || (permissions.canEditSpecial && permissions.canUseStorage));
    const legalCapacity = fleetVesselMarketCapacity(vessel);
    const concealedCapacity = fleetVesselMarketCapacity({
      profile: {
        legalCapacityCargoPoints: vessel?.profile?.concealedCapacityCargoPoints,
        legalCapacityTonnes: vessel?.profile?.concealedCapacityTonnes,
        legalCapacityVolumeM3: vessel?.profile?.concealedCapacityVolumeM3
      }
    });
    const offers = (vessel?.offers ?? []).map((offer) => {
      const quote = quoteFleetOffer(offer);
      const crew = fleetCrewReadiness(holding, vessel);
      const capacityReady = whole(quote?.reservedCapacityCargoPoints, 0) <= legalCapacity.capacityCargoPoints;
      return {
        ...quote,
        kindLabel: FLEET_OFFER_KINDS[quote.kind] ?? quote.kind,
        grossText: money(quote.grossRevenueCopper),
        costText: money(quote.operatingCostCopper),
        reserveText: money(quote.replacementReserveCopper),
        suppliesText: money(quote?.costBreakdown?.suppliesCopper ?? 0),
        fuelText: money(quote?.costBreakdown?.fuelCopper ?? 0),
        portFeesText: money(quote?.costBreakdown?.portFeesCopper ?? 0),
        externalCrewText: money(quote?.costBreakdown?.externalCrewCopper ?? 0),
        wearSteps: whole(quote.wearSteps, 0),
        resultText: signedMoney(quote.distributableResultCopper),
        resultNegative: quote.distributableResultCopper < 0,
        riskClass: quote.riskPercent >= 30 ? "is-danger" : quote.riskPercent >= 15 ? "is-warning" : "is-success",
        generatedFromMarket: quote.source === "market-generated",
        routeText: Number(quote.distanceKm) > 0 ? `${Math.round(Number(quote.distanceKm))} км · ${quote.durationQd} QD` : `${quote.durationQd} QD`,
        cargoText: cargoPointsText(quote.reservedCapacityCargoPoints),
        capacityReady,
        crewReady: crew.ok,
        crewMessage: crew.message,
        canAccept: canDecide && capacityReady && crew.ok && !vessel.activeVoyage && fleetVesselAvailableCopper(vessel) >= quote.operatingCostCopper
      };
    });
    const voyageResultCopper = vessel?.activeVoyage
      ? whole(vessel.activeVoyage.outboundRevenueCopper)
        + whole(vessel.activeVoyage.returnRevenueCopper)
        - whole(vessel.activeVoyage.operatingCostCopper)
        - whole(vessel.activeVoyage.replacementReserveCopper)
      : 0;
    const voyage = vessel?.activeVoyage ? {
      ...vessel.activeVoyage,
      revenueText: money(whole(vessel.activeVoyage.outboundRevenueCopper) + whole(vessel.activeVoyage.returnRevenueCopper)),
      costText: money(vessel.activeVoyage.operatingCostCopper),
      reserveText: money(vessel.activeVoyage.replacementReserveCopper),
      internalTransferText: money(vessel.activeVoyage.internalTransferCopper ?? vessel.activeVoyage?.revenueBreakdown?.internalTransferCopper ?? 0),
      internalTransfer: whole(vessel.activeVoyage.internalTransferCopper ?? vessel.activeVoyage?.revenueBreakdown?.internalTransferCopper ?? 0),
      suppliesText: money(vessel.activeVoyage?.costBreakdown?.suppliesCopper ?? 0),
      fuelText: money(vessel.activeVoyage?.costBreakdown?.fuelCopper ?? 0),
      portFeesText: money(vessel.activeVoyage?.costBreakdown?.portFeesCopper ?? 0),
      externalCrewText: money(vessel.activeVoyage?.costBreakdown?.externalCrewCopper ?? 0),
      wearSteps: whole(vessel.activeVoyage.wearSteps, 0),
      cargoText: cargoPointsText(vessel.activeVoyage.reservedCapacityCargoPoints),
      resultText: signedMoney(voyageResultCopper),
      resultClass: voyageResultCopper < 0 ? "is-danger" : "is-success",
      remainingQd: Math.max(0, whole(vessel.activeVoyage.etaQd) - currentQd)
    } : null;
    const vesselOptions = (holding?.special?.fleet?.vessels ?? []).filter((row) => game.user?.isGM || row?.visibility !== "gm").map((row) => ({
      id: row.id,
      name: row.name,
      selected: row.id === vessel?.id,
      archived: row.status === "archived"
    }));
    const statusOptions = Object.entries(VESSEL_STATUSES).map(([value, label]) => ({ value, label, selected: value === vessel?.status }));
    const acquisitionMethod = Object.hasOwn(FLEET_ACQUISITION_METHODS, vessel?.acquisition?.method)
      ? vessel.acquisition.method
      : "storyAsset";
    const acquisitionMethodOptions = Object.entries(FLEET_ACQUISITION_METHODS).map(([value, label]) => ({
      value,
      label,
      selected: value === acquisitionMethod
    }));
    const acquisitionHoldingSource = String(vessel?.acquisition?.sourceHoldingId ?? "").trim();
    const acquisitionSourceId = String(vessel?.acquisition?.sourceId ?? "").trim();
    const acquisitionSourceText = [
      acquisitionHoldingSource === String(holding.id ?? "") ? holding.name : acquisitionHoldingSource,
      acquisitionSourceId
    ].filter(Boolean).join(" · ") || "Не указан";
    const kindOptions = Object.entries(FLEET_OFFER_KINDS).map(([value, label]) => ({ value, label }));
    const regions = data?.catalog?.eventRegions ?? [];
    const regionOptions = regions.map((row) => ({
      value: String(row?.value ?? ""),
      label: String(row?.label ?? row?.value ?? "Регион"),
      selected: String(row?.value ?? "") === String(vessel?.position?.regionId ?? "")
    }));
    const currentRegionKnown = regionOptions.some((row) => row.selected);
    if (vessel?.position?.regionId && !currentRegionKnown) regionOptions.unshift({ value: vessel.position.regionId, label: `${vessel.position.regionId} · вне каталога`, selected: true });
    const availableCopper = fleetVesselAvailableCopper(vessel);
    const dockedHere = String(vessel?.position?.dockedAtHoldingId ?? "") === String(holding.id ?? "");
    const transferMethodRows = Object.entries(FLEET_TRANSFER_METHODS).map(([id, defaults]) => {
      const configured = holding?.special?.fleet?.transferMethods?.[id] ?? defaults;
      const feePercent = id === "physical" ? 0 : Math.max(0, Math.min(100, number(configured.feePercent, defaults.feePercent)));
      const etaQd = id === "physical" ? 0 : Math.max(1, whole(configured.etaQd, defaults.etaQd));
      const enabled = id === "physical" || configured.enabled !== false;
      return {
        id,
        label: String(configured.label ?? defaults.label),
        enabled,
        feePercent,
        etaQd,
        requiresDock: Boolean(defaults.requiresDock),
        optionLabel: id === "physical"
          ? "Физическая передача · без комиссии · сразу"
          : `${configured.label ?? defaults.label} · ${feePercent}% · ${etaQd} QD`
      };
    });
    const defaultTransferMethodId = dockedHere
      ? "physical"
      : (transferMethodRows.find((row) => row.enabled && !row.requiresDock)?.id ?? "physical");
    const transferMethodOptions = transferMethodRows
      .filter((row) => row.enabled)
      .map((row) => ({ ...row, selected: row.id === defaultTransferMethodId }));
    const pendingTransfers = (holding?.special?.fleet?.transfers ?? [])
      .filter((row) => String(row?.vesselId ?? "") === String(vessel?.id ?? "") && row?.status === "pending")
      .map((row) => ({
        ...row,
        amountText: money(row.amountCopper),
        feeText: money(row.feeCopper),
        netText: money(row.netCopper),
        remainingQd: Math.max(0, whole(row.etaQd) - currentQd),
        directionLabel: row.direction === "holding-to-vessel" ? "Поселение → корабль" : "Корабль → поселение",
        methodLabel: transferMethodRows.find((methodRow) => methodRow.id === row.method)?.label ?? row.method
      }));
    const conditionScore = Math.round((
      whole(vessel?.condition?.hull, 100)
      + whole(vessel?.condition?.lift, 100)
      + whole(vessel?.condition?.machinery, 100)
      + Math.max(0, 100 - whole(vessel?.condition?.wear, 0))
    ) / 4);
    const conditionClass = conditionScore < 50 ? "is-danger" : conditionScore < 75 ? "is-warning" : "is-success";
    const crewReadiness = fleetCrewReadiness(holding, vessel);
    const crewTarget = crewReadiness.crewTarget;
    const crewCurrent = crewReadiness.residentCount;
    const repairQuote = vessel ? quoteFleetRepair(holding, { vesselId: vessel.id, wearSteps: Math.min(5, Math.max(1, whole(vessel?.condition?.wear, 0))) }) : null;
    const activeRepair = vessel?.activeRepair ? {
      ...vessel.activeRepair,
      moneyText: money(vessel.activeRepair.moneyCopper),
      remainingQd: Math.max(0, whole(vessel.activeRepair.completesQd) - currentQd),
      materialsText: (vessel.activeRepair.materials ?? []).map((row) => `${row.qty} ${row.name}`).join(" · ")
    } : null;
    return {
      ...context,
      missing: false,
      holding,
      holdingName: holding.name,
      revision: whole(data?.meta?.revision, 0),
      permissions,
      canEdit,
      canDecide,
      canTransfer,
      pending: this.pending,
      hasVessel: Boolean(vessel),
      vessel,
      vesselStatusLabel: VESSEL_STATUSES[vessel?.status] ?? vessel?.status ?? "Неизвестно",
      vesselLocationText: String(vessel?.position?.locationLabel ?? "").trim() || String(vessel?.position?.regionId ?? "").trim() || "Не указано",
      acquisitionMethodOptions,
      acquisitionMethodLabel: FLEET_ACQUISITION_METHODS[acquisitionMethod],
      acquisitionPriceText: money(vessel?.acquisition?.acquisitionCopper ?? 0),
      acquisitionSourceText,
      acquisitionStoryAsset: acquisitionMethod === "storyAsset",
      acquisitionGrandfatheredStoryAsset: acquisitionMethod === "storyAsset" && vessel?.acquisition?.grandfathered === true,
      conditionScore,
      conditionClass,
      crewCurrent,
      crewTarget,
      crewNotice: crewReadiness.message,
      crewText: `${crewCurrent} / ${crewTarget}`,
      crewClass: crewTarget > 0 && crewCurrent < crewTarget ? "is-warning" : "is-success",
      legalCapacityCargoPointsText: cargoPointsText(legalCapacity.capacityCargoPoints),
      concealedCapacityCargoPointsText: cargoPointsText(concealedCapacity.capacityCargoPoints),
      vesselOptions,
      statusOptions,
      kindOptions,
      regionOptions,
      hasRegionOptions: regionOptions.length > 0,
      offers,
      hasOffers: offers.length > 0,
      voyage,
      hasVoyage: Boolean(voyage),
      currentQd,
      availableCopper,
      availableText: money(availableCopper),
      cashText: money(vessel?.finances?.cashCopper ?? 0),
      replacementReserveText: money(vessel?.finances?.replacementReserveCopper ?? 0),
      idleArrearsText: money(vessel?.finances?.idleCostArrearsCopper ?? 0),
      idleCostText: money(whole(vessel?.profile?.financeTerms?.mooringCopperPerTenday) + whole(vessel?.profile?.financeTerms?.basicMaintenanceCopperPerTenday)),
      treasuryText: money(holding?.storage?.moneyCopper ?? 0),
      dockedHere,
      transferMethodOptions,
      transferMethodSettings: transferMethodRows.filter((row) => row.id !== "physical"),
      pendingTransfers,
      hasPendingTransfers: pendingTransfers.length > 0,
      repairQuote: repairQuote ? {
        ...repairQuote,
        moneyText: money(repairQuote.moneyCopper),
        materialsText: (repairQuote.materials ?? []).map((row) => `${row.qty} ${row.name}`).join(" · "),
        reasonText: (repairQuote.reasons ?? []).join(" ")
      } : null,
      activeRepair,
      hasActiveRepair: Boolean(activeRepair),
      profileOpen: this.openDisclosures.has("profile"),
      manualOfferOpen: this.openDisclosures.has("manual-offer"),
      transferSettingsOpen: this.openDisclosures.has("transfer-settings"),
      logOpen: this.openDisclosures.has("log"),
      history: (vessel?.history ?? []).slice(-30).reverse().map((row) => ({
        ...row,
        atText: shortDate(row.at),
        amountText: row.amountCopper ? money(Math.abs(row.amountCopper)) : ""
      }))
    };
  }

  async _updateHolding(updater, reason) {
    if (!game.user?.isGM) return null;
    return SkyholdData.updateHolding(this.holdingId, updater, { fallback: false, reason });
  }

  async _runPending(task) {
    if (this.pending) return null;
    this.pending = true;
    this.requestRender({ focus: false });
    try {
      return await task();
    } finally {
      this.pending = false;
      this.requestRender({ focus: false });
      this.owner?.requestRender?.({ focus: false });
    }
  }

  async _saveVessel(form) {
    if (!game.user?.isGM || !this.vesselId) return;
    const saved = await this._updateHolding((holding) => {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === this.vesselId);
      if (!vessel) return SkyholdData.skipTransaction({ ok: false, message: "Корабль не найден." });
      const previousAcquisition = vessel.acquisition && typeof vessel.acquisition === "object" ? vessel.acquisition : {};
      const previousAcquisitionMethod = Object.hasOwn(FLEET_ACQUISITION_METHODS, previousAcquisition.method)
        ? previousAcquisition.method
        : "storyAsset";
      const requestedAcquisitionValue = fieldValue(form, "acquisitionMethod", previousAcquisitionMethod);
      const requestedAcquisitionMethod = Object.hasOwn(FLEET_ACQUISITION_METHODS, requestedAcquisitionValue)
        ? requestedAcquisitionValue
        : previousAcquisitionMethod;
      vessel.acquisition = {
        ...previousAcquisition,
        schemaVersion: 1,
        method: requestedAcquisitionMethod,
        grandfathered: requestedAcquisitionMethod !== previousAcquisitionMethod
          ? false
          : previousAcquisition.grandfathered === true,
        acquiredAt: fieldValue(form, "acquiredAt", previousAcquisition.acquiredAt).slice(0, 200),
        acquisitionCopper: whole(fieldValue(form, "acquisitionCopper", previousAcquisition.acquisitionCopper)),
        sourceHoldingId: requestedAcquisitionMethod === "built" ? holding.id : "",
        sourceId: fieldValue(form, "acquisitionSourceId", previousAcquisition.sourceId).slice(0, 500),
        notes: fieldValue(form, "acquisitionNotes", previousAcquisition.notes).slice(0, 2000)
      };
      vessel.name = fieldValue(form, "name", vessel.name).slice(0, 200) || "Корабль";
      vessel.ownerName = fieldValue(form, "ownerName", vessel.ownerName).slice(0, 200);
      vessel.notes = fieldValue(form, "notes", vessel.notes).slice(0, 4000);
      vessel.status = vessel.activeVoyage ? "voyaging" : fieldValue(form, "status", vessel.status);
      vessel.profile.crewTarget = whole(fieldValue(form, "crewTarget", vessel.profile.crewTarget));
      vessel.profile.legalCapacityCargoPoints = whole(fieldValue(form, "legalCapacityCargoPoints", vessel.profile.legalCapacityCargoPoints));
      vessel.profile.concealedCapacityCargoPoints = whole(fieldValue(form, "concealedCapacityCargoPoints", vessel.profile.concealedCapacityCargoPoints));
      vessel.profile.speedClass = fieldValue(form, "speedClass", vessel.profile.speedClass).slice(0, 100);
      vessel.profile.weaponNote = fieldValue(form, "weaponNote", vessel.profile.weaponNote).slice(0, 500);
      if (!vessel.profile.financeTerms || typeof vessel.profile.financeTerms !== "object") vessel.profile.financeTerms = {};
      for (const key of [
        "mooringCopperPerTenday",
        "basicMaintenanceCopperPerTenday",
        "suppliesCopperPerQd",
        "fuelCopperPerQd",
        "voyageMaintenanceCopperPerQd",
        "portFeeCopper",
        "replacementCopperPerQd"
      ]) vessel.profile.financeTerms[key] = whole(fieldValue(form, key, vessel.profile.financeTerms[key]));
      vessel.profile.financeTerms.freightCopperPer100CargoPoints100Km = Math.max(0.01, Math.round(number(
        fieldValue(form, "freightCopperPer100CargoPoints100Km", vessel.profile.financeTerms.freightCopperPer100CargoPoints100Km),
        15
      ) * 100) / 100);
      vessel.position.regionId = fieldValue(form, "regionId", vessel.position.regionId);
      vessel.position.locationLabel = fieldValue(form, "locationLabel", vessel.position.locationLabel).slice(0, 200);
      vessel.position.dockedAtHoldingId = checked(form, "dockedHere") ? holding.id : "";
      vessel.finances.cashCopper = whole(fieldValue(form, "cashCopper", vessel.finances.cashCopper));
      vessel.finances.operatingReserveCopper = whole(fieldValue(form, "operatingReserveCopper", vessel.finances.operatingReserveCopper));
      vessel.finances.emergencyReserveCopper = whole(fieldValue(form, "emergencyReserveCopper", vessel.finances.emergencyReserveCopper));
      vessel.finances.replacementReserveCopper = whole(fieldValue(form, "replacementReserveCopper", vessel.finances.replacementReserveCopper));
      vessel.condition.hull = Math.min(100, whole(fieldValue(form, "hull", vessel.condition.hull)));
      vessel.condition.lift = Math.min(100, whole(fieldValue(form, "lift", vessel.condition.lift)));
      vessel.condition.machinery = Math.min(100, whole(fieldValue(form, "machinery", vessel.condition.machinery)));
      vessel.condition.wear = Math.min(100, whole(fieldValue(form, "wear", vessel.condition.wear)));
      vessel.revision = whole(vessel.revision) + 1;
      holding.special.fleet.activeVesselId = vessel.id;
      return { ok: true };
    }, "fleet:save-vessel");
    if (saved?.ok) ui.notifications.info("Профиль корабля сохранён.");
    else if (saved) ui.notifications.warn(saved.message || "Не удалось сохранить профиль.");
  }

  async _addOffer(form) {
    if (!game.user?.isGM || !this.vesselId) return;
    const result = await this._updateHolding((holding) => addFleetOffer(holding, {
      vesselId: this.vesselId,
      offer: {
        economyVersion: 2,
        kind: fieldValue(form, "offerKind", "regular"),
        title: fieldValue(form, "offerTitle", "Регулярный фрахт"),
        clientName: fieldValue(form, "offerClient", "Торговый дом"),
        destinationRegionId: fieldValue(form, "offerDestinationId", ""),
        destinationLabel: fieldValue(form, "offerDestination", "Соседний порт"),
        riskPercent: Math.min(100, whole(fieldValue(form, "offerRiskPercent", 5), 5)),
        contractTerms: {
          cargoPoints: whole(fieldValue(form, "offerCargoPoints", 240_000), 240_000),
          returnCargoPoints: whole(fieldValue(form, "offerReturnCargoPoints", 80_000), 80_000),
          outboundDistanceKm: whole(fieldValue(form, "offerOutboundDistanceKm", 160), 160),
          returnDistanceKm: whole(fieldValue(form, "offerReturnDistanceKm", 160), 160),
          durationQd: whole(fieldValue(form, "offerDurationQd", 120), 120),
          demandFactor: Math.max(0.25, number(fieldValue(form, "offerDemandPercent", 100), 100) / 100),
          returnDemandFactor: Math.max(0.25, number(fieldValue(form, "offerReturnDemandPercent", 85), 85) / 100),
          urgencyFactor: Math.max(0.5, number(fieldValue(form, "offerUrgencyPercent", 100), 100) / 100),
          riskPercent: Math.min(100, whole(fieldValue(form, "offerRiskPercent", 5), 5)),
          portCalls: 2,
          externalCrewCopper: whole(fieldValue(form, "offerExternalCrewCopper", 0), 0)
        },
        notes: fieldValue(form, "offerNotes", "").slice(0, 2000),
        createdAt: new Date().toISOString()
      }
    }), "fleet:add-offer");
    if (result?.ok) ui.notifications.info("Предложение добавлено.");
    else if (result) ui.notifications.warn(result.message || "Не удалось добавить предложение.");
  }

  async _refreshMarketOffers() {
    if (!game.user?.isGM || !this.vesselId) return;
    const createdAt = new Date().toISOString();
    const result = await this._updateHolding((holding, data) => {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === this.vesselId);
      if (!vessel) return SkyholdData.skipTransaction({ ok: false, message: "Корабль не найден." });
      if (!String(vessel?.position?.regionId ?? "").trim()) return SkyholdData.skipTransaction({ ok: false, message: "Сначала выбери регион корабля и сохрани профиль." });
      const regions = data?.catalog?.eventRegions ?? [];
      const resources = allResourceDefs({ catalogRows: data?.catalog?.resources });
      const economy = normalizeMarketEconomy(data?.catalog?.marketEconomy, { locations: regions });
      const markets = effectiveMarketLocations({ economy, locations: regions, resources, isGM: true, normalizedEconomy: true });
      const generated = generateFleetMarketOffers({
        vessel,
        markets,
        regions,
        quoteKey: marketQuotePeriodKey(holding, { quotePeriodDays: 10 }),
        createdAt,
        limit: 5
      });
      const preserved = (vessel.offers ?? []).filter((offer) => offer?.source !== "market-generated");
      vessel.offers = [...preserved, ...generated].slice(-FLEET_OFFER_LIMIT);
      vessel.revision = whole(vessel.revision) + 1;
      return { ok: true, count: generated.length };
    }, "fleet:refresh-market-offers");
    if (result?.ok) ui.notifications.info(result.count ? `Подготовлено рыночных предложений: ${result.count}.` : "Из текущей точки нет доступных воздушных маршрутов.");
    else if (result) ui.notifications.warn(result.message || "Не удалось обновить предложения.");
  }

  async _deleteOffer(offerId) {
    if (!game.user?.isGM) return;
    await this._updateHolding((holding) => {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === this.vesselId);
      if (!vessel) return SkyholdData.skipTransaction(false);
      vessel.offers = (vessel.offers ?? []).filter((row) => String(row?.id ?? "") !== String(offerId ?? ""));
      vessel.revision = whole(vessel.revision) + 1;
      return true;
    }, "fleet:delete-offer");
  }

  async _acceptOffer(offerId) {
    const { data, holding } = this._entry({ mutable: true });
    const permissions = holdingPermissionContext(holding);
    if (!holding || !permissions.canEditSpecial) return;
    const result = await requestStorageOperation({
      type: "fleetAcceptOffer",
      holdingId: holding.id,
      vesselId: this.vesselId,
      offerId,
      expectedRevision: whole(data?.meta?.revision, 0),
      operationId: makeId("fleet-accept", 20)
    });
    if (result?.ok) ui.notifications.info(result.duplicate ? "Этот рейс уже был принят." : "Рейс принят и добавлен в календарный поток.");
    else ui.notifications.warn(result?.message || "Не удалось принять рейс.");
  }

  async _saveTransferSettings(form) {
    if (!game.user?.isGM) return;
    const result = await this._updateHolding((holding) => {
      const fleet = holding?.special?.fleet;
      if (!fleet) return SkyholdData.skipTransaction({ ok: false, message: "Флот не найден." });
      if (!fleet.transferMethods || typeof fleet.transferMethods !== "object") fleet.transferMethods = {};
      for (const id of ["bank", "shadow"]) {
        const defaults = FLEET_TRANSFER_METHODS[id];
        const current = fleet.transferMethods[id] ?? {};
        fleet.transferMethods[id] = {
          ...current,
          id,
          label: String(current.label ?? defaults.label),
          enabled: checked(form, `transferMethod-${id}-enabled`),
          feePercent: Math.round(Math.max(0, Math.min(100, number(fieldValue(form, `transferMethod-${id}-feePercent`, defaults.feePercent), defaults.feePercent))) * 100) / 100,
          etaQd: Math.max(1, whole(fieldValue(form, `transferMethod-${id}-etaQd`, defaults.etaQd), defaults.etaQd)),
          requiresDock: false,
          trace: defaults.trace
        };
      }
      return { ok: true };
    }, "fleet:save-transfer-settings");
    if (result?.ok) ui.notifications.info("Каналы перевода сохранены.");
    else if (result) ui.notifications.warn(result.message || "Не удалось сохранить каналы перевода.");
  }

  async _transfer(form) {
    const { data, holding } = this._entry({ mutable: true });
    const permissions = holdingPermissionContext(holding);
    if (!holding || !(game.user?.isGM || (permissions.canEditSpecial && permissions.canUseStorage))) return;
    const result = await requestStorageOperation({
      type: "fleetTransfer",
      holdingId: holding.id,
      vesselId: this.vesselId,
      direction: fieldValue(form, "transferDirection", "vessel-to-holding"),
      amountCopper: whole(fieldValue(form, "transferAmountCopper", 0)),
      method: fieldValue(form, "transferMethod", "physical"),
      expectedRevision: whole(data?.meta?.revision, 0),
      operationId: makeId("fleet-transfer", 20)
    });
    if (result?.ok) {
      ui.notifications.info(result.duplicate
        ? "Этот перевод уже был создан."
        : result.pending
          ? `Перевод отправлен. Комиссия ${money(result.feeCopper)}; завершение произойдёт по календарю.`
          : "Деньги переданы без комиссии.");
    }
    else ui.notifications.warn(result?.message || "Не удалось выполнить перевод.");
  }

  async _cancelTransfer(transferId) {
    const { data, holding } = this._entry({ mutable: true });
    const permissions = holdingPermissionContext(holding);
    if (!holding || !(game.user?.isGM || (permissions.canEditSpecial && permissions.canUseStorage))) return;
    const result = await requestStorageOperation({
      type: "fleetCancelTransfer",
      holdingId: holding.id,
      vesselId: this.vesselId,
      transferId,
      expectedRevision: whole(data?.meta?.revision, 0),
      operationId: makeId("fleet-transfer-cancel", 20)
    });
    if (result?.ok) ui.notifications.info(result.duplicate ? "Этот перевод уже был отменён." : `Перевод отменён; возвращено ${money(result.refundedCopper)}.`);
    else ui.notifications.warn(result?.message || "Не удалось отменить перевод.");
  }

  async _startRepair(form) {
    if (!game.user?.isGM || !this.vesselId) return;
    const wearSteps = Math.max(1, Math.min(20, whole(fieldValue(form, "repairWearSteps", 5), 5)));
    const operationId = makeId("fleet-repair", 20);
    const startedAt = new Date().toISOString();
    const result = await this._updateHolding((holding) => {
      const applied = startFleetRepair(holding, {
        vesselId: this.vesselId,
        wearSteps,
        operationId,
        startedQd: whole(holding?.gm?.calendaria?.lastQd, 0),
        startedAt
      });
      return applied.ok ? applied : SkyholdData.skipTransaction(applied);
    }, "fleet:start-repair");
    if (result?.ok) ui.notifications.info(result.duplicate ? "Этот ремонт уже был поставлен в очередь." : `Корабль поставлен в док до QD ${result.repair.completesQd}.`);
    else if (result) ui.notifications.warn(result.message || "Не удалось начать ремонт.");
  }

  _updateTransferPreview(form) {
    const preview = form?.querySelector?.("[data-role='fleet-transfer-preview']");
    const methodField = field(form, "transferMethod");
    const option = methodField?.selectedOptions?.[0];
    if (!preview || !option) return;
    const amount = whole(fieldValue(form, "transferAmountCopper", 0));
    const feePercent = Math.max(0, number(option.dataset.feePercent, 0));
    const etaQd = whole(option.dataset.etaQd, 0);
    const requiresDock = option.dataset.requiresDock === "true";
    const dockedHere = preview.dataset.dockedHere === "true";
    const feeCopper = Math.ceil(amount * feePercent / 100);
    const netCopper = Math.max(0, amount - feeCopper);
    const blocked = requiresDock && !dockedHere;
    preview.textContent = blocked
      ? "Физическая передача требует совместного порта."
      : `Комиссия ${money(feeCopper)} · поступит ${money(netCopper)} · ${etaQd > 0 ? `через ${etaQd} QD` : "сразу"}.`;
    preview.classList.toggle("fbls-warning-text", blocked);
  }

  async _createVessel() {
    if (!game.user?.isGM) return;
    const result = await this._updateHolding((holding) => {
      const gmId = String(game.user?.id ?? "unknown");
      const gmName = String(game.user?.name ?? gmId);
      const vessel = createFleetVessel({
        holdingId: holding.id,
        name: "Новое судно",
        ownerName: "",
        acquisitionMethod: "storyAsset",
        acquiredAt: new Date().toISOString(),
        acquisitionSourceId: `gm:create-vessel:${gmId}`
      });
      vessel.acquisition.notes = `Создано вручную GM ${gmName} как явный сюжетный внешний актив; это не бесплатная покупка.`;
      holding.special.fleet.vessels.push(vessel);
      holding.special.fleet.activeVesselId = vessel.id;
      return { ok: true, vesselId: vessel.id };
    }, "fleet:create-vessel");
    if (result?.ok) this.vesselId = result.vesselId;
  }

  async _archiveVessel() {
    if (!game.user?.isGM) return;
    const result = await this._updateHolding((holding) => {
      const vessel = holding?.special?.fleet?.vessels?.find((row) => String(row?.id ?? "") === this.vesselId);
      if (!vessel) return SkyholdData.skipTransaction({ ok: false, message: "Корабль не найден." });
      if (vessel.activeVoyage) return SkyholdData.skipTransaction({ ok: false, message: "Нельзя архивировать корабль в активном рейсе." });
      vessel.status = "archived";
      vessel.revision = whole(vessel.revision) + 1;
      holding.special.fleet.activeVesselId = holding.special.fleet.vessels.find((row) => row.status !== "archived" && row.id !== vessel.id)?.id ?? "";
      return { ok: true };
    }, "fleet:archive-vessel");
    if (result?.ok) this.vesselId = "";
    else if (result) ui.notifications.warn(result.message || "Не удалось архивировать корабль.");
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._fleetAbortController?.abort?.();
    const controller = new AbortController();
    this._fleetAbortController = controller;
    for (const disclosure of root.querySelectorAll("[data-fleet-disclosure]")) {
      disclosure.addEventListener("toggle", () => {
        const key = String(disclosure.dataset.fleetDisclosure ?? "");
        if (!key) return;
        if (disclosure.open) this.openDisclosures.add(key);
        else this.openDisclosures.delete(key);
      }, { signal: controller.signal });
    }
    root.addEventListener("change", (event) => {
      const select = event.target?.closest?.("[data-fleet-vessel-select]");
      if (select && root.contains(select)) {
        this.vesselId = String(select.value ?? "");
        this.requestRender({ focus: false });
        return;
      }
      if (["transferMethod", "transferDirection"].includes(String(event.target?.name ?? ""))) {
        this._updateTransferPreview(event.target.closest("form"));
      }
    }, { signal: controller.signal });
    root.addEventListener("input", (event) => {
      if (event.target?.name === "transferAmountCopper") this._updateTransferPreview(event.target.closest("form"));
    }, { signal: controller.signal });
    root.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-action]");
      if (!button || !root.contains(button)) return;
      const action = String(button.dataset.action ?? "");
      const form = button.closest("form") ?? root.querySelector("form");
      event.preventDefault();
      if (action === "fleet-save-vessel") this._runPending(() => this._saveVessel(form));
      else if (action === "fleet-refresh-market-offers") this._runPending(() => this._refreshMarketOffers());
      else if (action === "fleet-add-offer") this._runPending(() => this._addOffer(form));
      else if (action === "fleet-delete-offer") this._runPending(() => this._deleteOffer(button.dataset.offerId));
      else if (action === "fleet-accept-offer") this._runPending(() => this._acceptOffer(button.dataset.offerId));
      else if (action === "fleet-save-transfer-settings") this._runPending(() => this._saveTransferSettings(form));
      else if (action === "fleet-transfer") this._runPending(() => this._transfer(form));
      else if (action === "fleet-cancel-transfer") this._runPending(() => this._cancelTransfer(button.dataset.transferId));
      else if (action === "fleet-start-repair") this._runPending(() => this._startRepair(form));
      else if (action === "fleet-create-vessel") this._runPending(() => this._createVessel());
      else if (action === "fleet-archive-vessel") this._runPending(() => this._archiveVessel());
    }, { signal: controller.signal });
    this._updateTransferPreview(root.querySelector("form"));
  }

  async _onClose(options) {
    await super._onClose(options);
    this._fleetAbortController?.abort?.();
    if (SkyholdShipEnterpriseApp.instance === this) SkyholdShipEnterpriseApp.instance = null;
  }
}

SkyholdShipEnterpriseApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-ship-enterprise",
  classes: ["fbl-skyhold", "fbl-skyhold-ship-enterprise"],
  tag: "section",
  window: { title: "Корабельное предприятие", icon: "fa-solid fa-ship", resizable: true },
  position: { width: 980, height: 720 }
};

SkyholdShipEnterpriseApp.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/ship-enterprise.hbs` }
};

SkyholdShipEnterpriseApp.instance = null;
