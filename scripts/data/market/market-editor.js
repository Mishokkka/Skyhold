import { allResourceDefs } from "../../core/resources.js";
import { effectiveMarketCatalog, marketCatalogSummary, normalizeMarketCatalogRow } from "./market-catalog.js";
import { normalizeEventRegionOptions } from "../random-events.js";

const KIND_OPTIONS = [
  { value: "material", label: "Материалы" },
  { value: "resource", label: "Ресурсы" },
  { value: "consumable", label: "Расходники" },
  { value: "livestock", label: "Животные" }
];
const VISIBILITY_OPTIONS = [
  { value: "public", label: "Всем" },
  { value: "gm", label: "Только GM" }
];
const SOURCE_OPTIONS = [
  { value: "resource", label: "Ресурс каталога" },
  { value: "item", label: "Foundry Item UUID" }
];
const DELIVERY_OPTIONS = [
  { value: "scheduled", label: "Поставка во времени" },
  { value: "instant", label: "Мгновенно (совместимость)" }
];

function selectedOptions(options, selected) {
  return options.map((option) => ({ ...option, selected: option.value === selected }));
}

export function duplicateMarketCatalogRow(row = {}, { id = "market-copy" } = {}) {
  const marketId = String(id || "market-copy");
  return normalizeMarketCatalogRow({
    ...row,
    id: marketId,
    label: `${String(row.label ?? row.name ?? "Торговая площадка")} — копия`,
    active: false,
    contentSource: "",
    contentVersion: 1,
    offers: (row.offers ?? []).map((offer, index) => ({ ...offer, id: `${marketId}-offer-${index + 1}` }))
  });
}

export function prepareMarketCatalogEditor(catalogMarkets = [], catalogResources = [], selectedMarketId = "", regionRows = []) {
  const resources = allResourceDefs({ catalogRows: catalogResources }).filter((resource) => !resource.isMoney && !resource.hidden);
  const regions = normalizeEventRegionOptions(regionRows, { fallback: false });
  const markets = effectiveMarketCatalog(catalogMarkets);
  const selected = markets.find((market) => market.id === selectedMarketId) ?? markets[0] ?? null;
  const regionLabels = new Map(regions.map((region) => [region.value, region.label]));
  const marketOptions = markets.map((market) => ({
    value: market.id,
    label: `${market.label}${market.active ? "" : " · выключен"}`,
    selected: market.id === selected?.id
  }));
  const market = selected ? {
    ...selected,
    tagsText: (selected.tags ?? []).join(", "),
    transportModesText: (selected.transportModes ?? []).join(", "),
    caravanTransport: selected.transportModes?.includes("caravan"),
    railTransport: selected.transportModes?.includes("rail"),
    airshipTransport: selected.transportModes?.includes("airship"),
    visibilityOptions: selectedOptions(VISIBILITY_OPTIONS, selected.visibility),
    deliveryOptions: selectedOptions(DELIVERY_OPTIONS, selected.deliveryMode),
    accessOverrideOptions: [
      { value: 0, label: "Автоматически по числу связей" },
      { value: 1, label: "Принудительно: уровень 1" },
      { value: 2, label: "Принудительно: уровень 2" },
      { value: 3, label: "Принудительно: уровень 3" },
      { value: 4, label: "Принудительно: уровень 4" }
    ].map((row) => ({ ...row, selected: Number(row.value) === Number(selected.accessLevelOverride) })),
    regionOptions: [
      { value: "", label: "— Выберите регион рынка —", selected: !selected.regionId },
      ...regions.map((row) => ({ value: row.value, label: row.label, selected: row.value === selected.regionId }))
    ],
    offers: selected.offers.map((offer) => {
      const resource = resources.find((row) => row.id === offer.resourceId);
      return {
        ...offer,
        displayName: offer.name || resource?.label || offer.itemUuid || offer.id,
        priceLabel: `${offer.basePriceCopper} ММ`,
        stockLabel: `${offer.baseStock} ед.`,
        tagsText: (offer.tags ?? []).join(", "),
        isResourceSource: offer.sourceType === "resource",
        isItemSource: offer.sourceType === "item",
        sourceOptions: selectedOptions(SOURCE_OPTIONS, offer.sourceType),
        kindOptions: selectedOptions(KIND_OPTIONS, offer.kind),
        visibilityOptions: selectedOptions(VISIBILITY_OPTIONS, offer.visibility),
        resourceOptions: resources.map((row) => ({ value: row.id, label: row.label, selected: row.id === offer.resourceId }))
      };
    })
  } : null;
  return {
    markets: markets.map((row) => ({
      ...row,
      selected: row.id === selected?.id,
      regionLabel: regionLabels.get(row.regionId) ?? row.regionId ?? ""
    })),
    marketOptions,
    market,
    hasMarket: Boolean(market),
    summary: marketCatalogSummary(catalogMarkets)
  };
}
