import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyContentPackImport, CONTENT_PACK_SCHEMA, normalizeContentPack, planContentPackImport } from "../data/content-packs.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { BUILTIN_RESOURCE_DEFS, normalizeResourceCatalogRow } from "../core/resources.js";
import { ECONOMY_RESOURCE_CATALOG_SIZE } from "../data/resources/resource-base-definitions.js";
import { composeMarketLocation } from "../engines/market/composition.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function dataFixture() {
  return {
    meta: { revision: 5 },
    catalog: {
      buildings: [{ id: "example-wind-observatory", name: "Старая обсерватория", contentSource: "example.skyhold-companion", contentVersion: 1 }],
      resources: [],
      eventRegions: [{ value: "example-high-winds", label: "Локальный регион", aliases: [] }],
      markets: [],
      combatDoctrines: []
    },
    holdings: [{
      id: "holding-1",
      gm: {
        eventTables: {
          general: { id: "general", title: "Общие", rows: [] },
          external: { id: "external", title: "Внешние", rows: [] }
        }
      },
      log: []
    }]
  };
}

export function checkContentPackCharacterization() {
  const examplePath = path.join(root, "examples/content-packs/skyhold-companion-example.json");
  const example = JSON.parse(readFileSync(examplePath, "utf8"));
  const versionTwo = { ...example, version: 2 };
  const pack = normalizeContentPack(versionTwo);
  assert.equal(pack.schema, CONTENT_PACK_SCHEMA, "example pack must use the canonical schema");
  assert.equal(pack.content.buildings.length, 1, "example pack must include a building");
  assert.equal(pack.content.resources.length, 1, "example pack must include a resource catalog row");
  assert.deepEqual(pack.content.resources[0].materialGroups, ["textile", "organic"]);
  assert.equal(pack.content.events.general[0].effects.length, 1, "event effects must survive pack normalization");
  assert.equal(pack.content.regions[0].contentSource, pack.source, "pack metadata must be projected onto regions");
  assert.equal(pack.content.regions[0].marketProfile, "aerial", "region market profile must survive pack normalization");
  assert.equal(pack.content.regions[0].marketDeliveryFactor, 1.25, "region delivery factor must survive pack normalization");
  assert.equal(pack.content.marketEconomy.countries[0].offers[0].resourceId, "wood", "country-market offers must survive pack normalization");
  assert.equal(pack.content.marketEconomy.organizations[0].merchant.countryShares[0].sharePct, 35, "merchant presence must survive pack normalization");
  assert.equal(pack.content.doctrines[0].contentVersion, 2, "pack version must become the default entry version");
  assert.throws(() => normalizeContentPack({ schema: "other", id: "bad", source: "bad" }), /Unsupported content pack schema/, "foreign schemas must be rejected");

  const loreTemplatePath = path.join(root, "examples/content-packs/air-islands-trade-network-template.json");
  const loreTemplateRaw = JSON.parse(readFileSync(loreTemplatePath, "utf8"));
  const loreTemplate = normalizeContentPack(loreTemplateRaw);
  assert.equal(loreTemplate.install.replaceMarket, true, "the full 882 pack must explicitly request a clean market installation");
  assert.equal(loreTemplate.content.regions.length, 69, "Air Islands template must include the prepared national and local markets");
  assert.equal(loreTemplate.content.marketEconomy.baseOffers.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1, "every storable canonical good must own one base market offer");
  assert.equal(loreTemplate.content.marketEconomy.specialties.length, 135, "the full pack must carry both universal and lore-specific specialties instead of relying on installed defaults");
  const rawEconomy = loreTemplateRaw.content.marketEconomy;
  const rawOffers = [
    ...(rawEconomy.baseOffers ?? []),
    ...(rawEconomy.countries ?? []).flatMap((row) => row.offers ?? []),
    ...(rawEconomy.specialties ?? []).flatMap((row) => row.offers ?? [])
  ];
  const rawResources = loreTemplateRaw.content.resources;
  const availableTags = new Set((rawEconomy.baseOffers ?? []).flatMap((offer) => [offer.resourceId, ...(offer.tags ?? [])]));
  for (const specialty of rawEconomy.specialties ?? []) {
    for (const rule of specialty.rules ?? []) {
      assert.ok((rule.targetTags ?? []).some((tag) => tag === "all" || availableTags.has(tag)),
        `${specialty.id}/${rule.id} must target at least one stocked canonical material`);
    }
  }
  const builtinResources = new Map(BUILTIN_RESOURCE_DEFS
    .map((row) => normalizeResourceCatalogRow(row))
    .map((row) => [row.id, row]));
  assert.equal(loreTemplateRaw.version, 14, "revised specialty targets must carry a newer reproducible pack version");
  assert.ok(rawResources.every((row) => row.unit === "ед."), "prepared resources must use only abstract units");
  assert.ok(rawResources.every((row) => Number.isInteger(row.basePriceCopper) && row.basePriceCopper >= 0), "every prepared resource must own an integer canonical price");
  assert.equal(rawResources.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1, "the pack contains all canonical goods and excludes system money");
  for (const resourceId of ["fuel-solid", "copper", "gold", "silver"]) {
    const packed = rawResources.find((row) => row.id === resourceId);
    const builtin = builtinResources.get(resourceId);
    assert.ok(packed && builtin, `${resourceId} must remain available in both the built-in and lore catalogs`);
    assert.equal(packed.basePriceCopper, builtin.basePriceCopper, `${resourceId} must keep the single built-in canonical price when the lore pack is regenerated`);
    assert.equal(packed.loadPoints, builtin.loadPoints, `${resourceId} must keep the single built-in load definition`);
  }
  assert.ok(rawResources.every((row) => Number.isInteger(row.loadPoints) && row.loadPoints >= 0), "every prepared resource must own integer quarter-load points");
  assert.ok(rawResources.every((row) => row.categoryTag === (builtinResources.get(row.id)?.categoryTag ?? String(row.materialGroups?.[0] ?? ""))), "categoryTag must preserve the built-in owner or the first legacy material group");
  assert.ok(rawResources.every((row) => Number.isInteger(row.marketAccessDifficulty) && row.marketAccessDifficulty >= 0), "every prepared resource must retain explicit URS difficulty");
  assert.ok(rawResources.every((row) => typeof row.noAutoConsume === "boolean" && Number.isInteger(row.shelfLifeQd) && row.shelfLifeQd >= 0), "resource consumption and shelf-life fields must be explicit canonical data");
  assert.ok(rawResources.every((row) => typeof row.foodEdible === "boolean" && typeof row.foodType === "string"), "prepared food flags must be explicit instead of inferred from keywords");
  const preparedFoodTypes = new Map([
    ["bread", "grain"], ["food-grain", "grain"], ["food-protein", "protein"], ["food-dairy", "dairy"],
    ["food-fruit", "fruit"], ["food-vegetables", "vegetable"], ["preserved-meat", "protein"], ["aged-cheese", "dairy"], ["dried-fruit", "fruit"],
    ["canned-protein", "protein"], ["canned-fruit", "fruit"], ["canned-vegetables", "vegetable"]
  ]);
  const expectedPreparedFoods = rawResources.filter((row) => preparedFoodTypes.has(row.id)).map((row) => [row.id, preparedFoodTypes.get(row.id)]).sort();
  const actualPreparedFoods = rawResources.filter((row) => row.foodEdible).map((row) => [row.id, row.foodType]).sort();
  assert.deepEqual(actualPreparedFoods, expectedPreparedFoods, "only explicitly prepared ration resources may auto-feed inhabitants");
  assert.equal(rawResources.find((row) => row.id === "eggs")?.foodEdible, false, "raw eggs must require preparation");
  assert.ok(rawResources.filter((row) => row.categoryTag === "alcohol").every((row) => !row.foodEdible), "alcohol must not become a settlement ration");
  assert.ok(rawResources.every((row) => row.contentVersion === loreTemplateRaw.version), "resource entry versions must match the regenerated pack root");
  assert.ok(rawOffers.every((row) => row.unit === "ед."), "every prepared market offer must use the abstract unit");
  assert.ok(rawOffers.every((row) => !/(?:кг|литр|лист|комплект|короб|ящик|шт\.)/iu.test(String(row.priceBasis ?? ""))), "price rationales must not reintroduce physical package sizes");
  const rawBaseOffers = rawEconomy.baseOffers ?? [];
  const rawLayerOffers = [
    ...(rawEconomy.countries ?? []).flatMap((row) => row.offers ?? []),
    ...(rawEconomy.specialties ?? []).flatMap((row) => row.offers ?? [])
  ];
  const legacyOfferFields = (row) => ["basePriceCopper", "priceCopper", "load", "weight", "loadPoints"].some((key) => Object.hasOwn(row, key));
  assert.ok(rawBaseOffers.filter((row) => row.sourceType !== "item").every((row) => !legacyOfferFields(row) && !Object.hasOwn(row, "priceOverrideCopper") && !Object.hasOwn(row, "loadOverridePoints")), "resource-backed base offers must inherit both canonical price and load");
  assert.ok(rawBaseOffers.every((row) => Number.isInteger(row.baseDemand) && row.baseDemand >= 0), "every base offer must persist an independent integer buy-side demand pool");
  assert.ok(rawBaseOffers.every((row) => Number(row.priceFactor) > 0), "base offers must retain an explicit multiplicative price factor");
  assert.ok(rawLayerOffers.every((row) => !legacyOfferFields(row)), "country and specialty offers must not duplicate legacy price or load fields");
  assert.ok(rawLayerOffers.some((row) => Object.hasOwn(row, "priceOverrideCopper")), "country-specific price deviations must remain explicit overrides");
  assert.ok(rawLayerOffers.filter((row) => row.sourceType !== "item").every((row) => !Object.hasOwn(row, "loadOverridePoints")), "resource offer packaging must never override canonical catalog load");
  const canonicalResources = new Map([
    ...BUILTIN_RESOURCE_DEFS.map((row) => normalizeResourceCatalogRow(row)),
    ...rawResources.map((row) => normalizeResourceCatalogRow(row))
  ].map((row) => [row.id, row]));
  for (const offer of rawLayerOffers) {
    if (offer.sourceType === "item") {
      assert.ok(Number.isInteger(offer.priceOverrideCopper) && Number.isInteger(offer.loadOverridePoints), "item offers must retain their own required price and load overrides");
      continue;
    }
    const resource = canonicalResources.get(offer.resourceId);
    assert.ok(resource, `prepared offer ${offer.id} must resolve its canonical resource economics`);
    if (Object.hasOwn(offer, "priceOverrideCopper")) {
      assert.ok(Number.isInteger(offer.priceOverrideCopper) && offer.priceOverrideCopper !== resource.basePriceCopper, `price override ${offer.id} must be an actual deviation from the resource catalog`);
    }
  }
  const preparedSizeIds = new Set(loreTemplate.content.marketEconomy.sizeProfiles.map((row) => row.id));
  assert.ok(loreTemplate.content.regions.every((row) => preparedSizeIds.has(row.marketSizeId)), "every prepared location must use a real market-size profile");
  assert.equal(loreTemplate.content.marketEconomy.countries.length, 16, "Air Islands template must exclude inaccessible Pai Orgul from trade");
  assert.equal(loreTemplate.content.marketEconomy.countries.some((row) => row.id === "pai-orgul"), false, "Pai Orgul must not survive as a purchasable country market");
  assert.ok(loreTemplate.content.marketEconomy.organizations.length >= 20, "Air Islands template must provide a broad editable seller, buyer and carrier layer");
  const novand = loreTemplate.content.marketEconomy.countries.find((row) => row.id === "novand");
  assert.equal(novand.conditionId, "systemic-collapse", "882 Novand collapse must be editable pack data, not engine hardcode");
  const alberve = loreTemplate.content.regions.find((row) => row.value === "novand-alberve");
  const riud = loreTemplate.content.regions.find((row) => row.value === "novand-riud");
  const aulater = loreTemplate.content.regions.find((row) => row.value === "novand-aulater");
  assert.equal(alberve.countryId, "novand");
  assert.equal(riud.countryId, "novand");
  assert.equal(aulater.countryId, "novand");
  assert.ok(riud.marketSpecialtyIds.includes("crystal-shipyard"));
  assert.ok(aulater.marketSpecialtyIds.includes("coastal-fishery"));
  assert.ok(loreTemplate.content.regions.every((row) => row.marketLinks.length === 0), "prepared locations must not invent route links for the GM");
  assert.equal(loreTemplate.content.marketRouteMap.worldWidth, 5000, "the bundled map must keep its native image width");
  assert.equal(loreTemplate.content.marketRouteMap.calibration.distanceKm, 600, "the printed scale bar must survive pack normalization");
  assert.ok(Math.abs(loreTemplate.content.marketRouteMap.kmPerPixel - (600 / 874)) < 1e-9, "route distances must use the calibrated map scale");
  const sagekiLocations = loreTemplate.content.regions.filter((row) => row.countryId === "royu-sageki");
  assert.ok(sagekiLocations.length > 0 && sagekiLocations.every((row) => !row.marketEnabled), "closed Sageki markets must remain visible but unavailable as editable data");
  const freeTradeLeague = loreTemplate.content.marketEconomy.organizations.find((row) => row.id === "free-trade-league");
  assert.equal(freeTradeLeague.merchant.enabled, true);
  assert.equal(freeTradeLeague.buyer.enabled, true);
  assert.equal(freeTradeLeague.carrier.enabled, true);
  assert.ok(freeTradeLeague.carrier.modes.includes("airship"));
  for (const role of ["merchant", "buyer", "carrier"]) {
    const shareTotals = new Map();
    for (const organization of loreTemplate.content.marketEconomy.organizations) {
      for (const presence of organization[role].countryShares) shareTotals.set(presence.countryId, (shareTotals.get(presence.countryId) ?? 0) + presence.sharePct);
    }
    assert.ok([...shareTotals.values()].every((total) => total <= 82.1), `${role} shares must leave room for independent providers`);
  }
  const libraryPath = path.join(root, "examples/content-packs/air-islands-materials-and-country-markets.json");
  const libraryRaw = JSON.parse(readFileSync(libraryPath, "utf8"));
  const library = normalizeContentPack(libraryRaw);
  assert.equal(libraryRaw.version, loreTemplateRaw.version, "the materials library and full network must share one generator version");
  assert.deepEqual(libraryRaw.content.resources, loreTemplateRaw.content.resources, "both generated packs must carry the same canonical resource catalog");
  assert.equal(library.content.resources.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1, "material library must provide every canonical good and omit system money");
  assert.equal(library.content.marketEconomy.countries.length, 16, "country library must provide one editable character per accessible state");
  assert.equal(new Set(library.content.marketEconomy.countries.map((row) => row.id)).size, 16, "country market characters must have unique state IDs");
  assert.ok(library.content.marketEconomy.countries.every((row) => row.active), "country-market templates must be usable immediately after import");
  const availableResourceIds = new Set([...BUILTIN_RESOURCE_DEFS, ...library.content.resources].map((row) => row.id));
  assert.ok(library.content.marketEconomy.countries.every((country) => country.offers.every((offer) => availableResourceIds.has(offer.resourceId))), "every country offer must resolve to a built-in or importable resource");
  assert.ok(library.content.marketEconomy.countries.every((country) => country.offers.every((offer) => offer.priceBasis && offer.historicalSource && offer.availabilityNotes)), "every prepared offer must retain an auditable price and availability rationale");
  const sequentialData = dataFixture();
  const libraryPlan = planContentPackImport({ data: sequentialData, holdingId: "holding-1", rawPack: JSON.parse(readFileSync(libraryPath, "utf8")) });
  assert.equal(applyContentPackImport({ data: sequentialData, plan: libraryPlan }).ok, true);
  const networkAfterLibrary = planContentPackImport({ data: sequentialData, holdingId: "holding-1", rawPack: JSON.parse(readFileSync(loreTemplatePath, "utf8")) });
  assert.equal(networkAfterLibrary.counts.conflict, 0, "the full network pack must upgrade the smaller materials/countries pack without duplicate-country conflicts");
  assert.ok(networkAfterLibrary.changes.some((row) => row.resetScope === "market" && row.status === "remove"), "full network preview must disclose its clean-install reset");
  assert.ok(networkAfterLibrary.changes.some((row) => row.resetScope === "resources" && row.status === "remove"), "full network preview must disclose its clean material-catalog reset");
  assert.ok(networkAfterLibrary.changes.some((row) => row.kind === "market.countries" && row.status === "add"), "all national profiles must be reinstalled after the reset");
  assert.ok(networkAfterLibrary.changes.some((row) => row.kind === "market.routeMap" && row.status === "add"), "full network must install its calibrated route map");

  const retirementData = dataFixture();
  retirementData.catalog.resources.push({ id: "user-kept-resource", label: "Пользовательский ресурс", unit: "ед." });
  retirementData.catalog.eventRegions.push({ value: "old-location", label: "Старая локация", marketLinks: [{ regionId: "another-old-location", distanceKm: 100, modes: ["caravan"] }] });
  retirementData.catalog.marketRouteMap = { background: "old-map.webp", worldWidth: 800, worldHeight: 600 };
  retirementData.catalog.marketEconomy = { countries: [{ id: "old-country", label: "Старая страна" }], organizations: [{ id: "old-company", label: "Старая компания" }], baseOffers: [{ id: "old-offer", resourceId: "wood" }], specialties: [{ id: "old-specialty", label: "Старая отрасль" }] };
  const retirementPlan = planContentPackImport({ data: retirementData, holdingId: "holding-1", rawPack: JSON.parse(readFileSync(loreTemplatePath, "utf8")) });
  assert.ok(retirementPlan.changes.some((row) => row.resetScope === "market"), "clean install must be represented by a dedicated preview row");
  assert.equal(applyContentPackImport({ data: retirementData, plan: retirementPlan }).ok, true);
  assert.equal(retirementData.catalog.eventRegions.length, 69, "clean install must replace every old location with the prepared set");
  assert.ok(retirementData.catalog.eventRegions.every((row) => row.marketLinks.length === 0), "clean install must remove all old and generated route links");
  assert.equal(retirementData.catalog.marketEconomy.countries.length, 16, "clean install must replace the country layer");
  assert.equal(retirementData.catalog.marketEconomy.organizations.length, 22, "clean install must replace seller, buyer and carrier companies");
  assert.equal(retirementData.catalog.marketEconomy.baseOffers.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1, "clean install must install one base offer per canonical good");
  assert.equal(retirementData.catalog.marketEconomy.specialties.length, 135, "clean install must install the complete specialty catalog");
  assert.equal(retirementData.catalog.resources.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1, "clean material import must replace the experimental user catalog with the canonical goods");
  assert.ok(!retirementData.catalog.resources.some((row) => row.id === "user-kept-resource"), "the disclosed clean material reset must remove previous user rows");
  assert.ok(retirementData.catalog.resources.every((row) => Number.isInteger(row.marketAccessDifficulty)), "every clean-import material must retain its assigned URS difficulty");
  assert.equal(retirementData.catalog.marketRouteMap.calibration.distanceKm, 600, "route-map singleton must be applied together with the network");
  const importedAulater = retirementData.catalog.eventRegions.find((row) => row.value === "novand-aulater");
  const composedAulater = composeMarketLocation({
    location: importedAulater,
    economy: retirementData.catalog.marketEconomy,
    resources: [...BUILTIN_RESOURCE_DEFS, ...retirementData.catalog.resources],
    locations: retirementData.catalog.eventRegions
  });
  assert.ok(composedAulater.offers.length >= 80, "a town with country and local specialties must expose a broad subset of the canonical assortment");
  assert.equal(new Set(composedAulater.offers.map((row) => row.resourceId)).size, composedAulater.offers.length, "market composition must not duplicate consolidated resources");
  assert.ok(composedAulater.offers.some((row) => row.resourceId === "fuel-liquid"), "fishery tags must operate on the consolidated liquid-fuel stock");

  const data = dataFixture();
  const plan = planContentPackImport({ data, holdingId: "holding-1", rawPack: versionTwo });
  assert.equal(plan.counts.update, 1, "newer entry from the same source must be an update");
  assert.equal(plan.counts.conflict, 1, "an installed row without source metadata must require an explicit conflict choice");
  assert.equal(plan.counts.add, 5, "new resource, event, country, organization and doctrine must be additions");
  assert.equal(plan.baseRevision, 5, "import preview must capture the current revision");

  const applied = applyContentPackImport({ data, plan, resolutions: {} });
  assert.equal(applied.ok, true, "current preview must apply");
  assert.equal(applied.count, 6, "safe default must apply additions and updates while preserving conflicts");
  assert.equal(data.catalog.eventRegions[0].label, "Локальный регион", "safe conflict default must preserve the installed row");
  assert.equal(data.catalog.buildings[0].contentVersion, 2, "same-source newer building must replace the old version");
  assert.equal(data.catalog.resources[0].id, "example-cloud-fiber", "resource content must be stored in the world catalog");
  assert.ok(data.holdings[0].gm.eventTables.general.rows.some((row) => row.id === "example-favorable-wind"), "event content must target the selected holding");
  assert.equal(data.catalog.combatDoctrines[0].id, "example-wind-screen", "doctrine content must be stored in the catalog");
  assert.equal(data.catalog.markets.length, 0, "legacy provider markets must never be restored by content packs");
  assert.equal(data.catalog.marketEconomy.countries[0].id, "example-high-winds", "country-market content must be stored in the layered economy");
  assert.equal(data.catalog.marketEconomy.organizations[0].id, "example-wind-guild", "provider organizations must be stored independently from locations");
  const renormalized = normalizeSkyholdData(data);
  assert.equal(renormalized.catalog.resources[0].contentSource, pack.source, "resource pack provenance must survive full world normalization");
  assert.equal(renormalized.catalog.markets.length, 0, "full normalization must keep the retired legacy market catalog empty");
  assert.equal(renormalized.catalog.marketEconomy.countries[0].contentSource, pack.source, "country-market pack provenance must survive full world normalization");

  const staleData = dataFixture();
  const stalePlan = planContentPackImport({ data: staleData, holdingId: "holding-1", rawPack: versionTwo });
  staleData.meta.revision += 1;
  assert.equal(applyContentPackImport({ data: staleData, plan: stalePlan }).stale, true, "import apply must reject a stale preview");

  const replaceData = dataFixture();
  const replacePlan = planContentPackImport({ data: replaceData, holdingId: "holding-1", rawPack: versionTwo });
  const regionConflict = replacePlan.changes.find((row) => row.kind === "regions");
  const replaced = applyContentPackImport({ data: replaceData, plan: replacePlan, resolutions: { [regionConflict.key]: "incoming" } });
  assert.equal(replaced.ok, true, "explicit incoming conflict choice must apply");
  assert.equal(replaceData.catalog.eventRegions[0].contentSource, pack.source, "resolved conflict must retain source metadata for future upgrades");
  assert.equal(replaceData.catalog.eventRegions[0].marketProfile, "aerial", "resolved region conflict must retain market metadata");

  const importer = readFileSync(path.join(root, "scripts/apps/editors/content-pack-importer.js"), "utf8");
  const template = readFileSync(path.join(root, "templates/content-pack-importer.hbs"), "utf8");
  assert.match(importer, /planContentPackImport\(/, "importer must build a preview before apply");
  assert.match(importer, /applyContentPackImport\(/, "importer must use the canonical apply operation");
  assert.match(importer, /result\?\.stale/, "importer must refresh a stale plan instead of forcing it");
  assert.match(template, /data-content-pack-resolution/, "conflicts must have an explicit per-row resolution control");
  assert.match(template, /type="file"[^>]+accept="application\/json,\.json"/, "content pack UI must accept local JSON files");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkContentPackCharacterization();
  console.log(`FBL Skyhold content packs: clean market reset, ${ECONOMY_RESOURCE_CATALOG_SIZE - 1} canonical goods, unlinked calibrated map, 16 country characters, 69 locations and 22 organizations passed.`);
}
