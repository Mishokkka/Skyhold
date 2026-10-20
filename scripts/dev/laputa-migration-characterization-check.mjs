import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEFAULT_BUILDING_TEMPLATES } from "../data/building-templates.js";
import { normalizeSkyholdData } from "../data/normalizers.js";
import { SKYHOLD_SCHEMA_VERSION } from "../data/schema-version.js";
import { stableDataHash } from "../data/storage-commit.js";
import { clone } from "../data/utils.js";
import { ECONOMY_RESOURCE_CATALOG_SIZE, ECONOMY_RESOURCE_CATALOG_VERSION } from "../data/resources/resource-base-definitions.js";
import { isCanonicalResourceId } from "../data/resources/resource-id-migration.js";
import {
  LAPUTA_BUILDING_MAPPING,
  LAPUTA_MARKET_PACK_ID,
  LAPUTA_MARKET_PACK_VERSION,
  LAPUTA_MIGRATION_NAMESPACE,
  LAPUTA_SOURCE_SHA256,
  applyLaputaEconomyMigration,
  auditLaputaMigrationSource,
  planLaputaEconomyMigration
} from "../workflows/economy/laputa-migration.js";

const HOUSE_ONE_ID = "laputa-building-house-1";
const HOUSE_TWO_ID = "laputa-building-house-2";
const LAZARET_ID = "cthR8Dn0ffub";
const WAREHOUSE_ID = "7hWwH1qpdroI";
const PASTURE_ID = "laputa-building-pasture";
const FASTI_ID = "b-KurQ68YZNWsg";
const canonicalMarketPack = JSON.parse(readFileSync(new URL("../../examples/content-packs/air-islands-trade-network-template.json", import.meta.url), "utf8"));
assert.equal(canonicalMarketPack.version, LAPUTA_MARKET_PACK_VERSION, "the migration must accept the current bundled market pack version");

function syntheticBuildings() {
  return LAPUTA_BUILDING_MAPPING.map((mapping, index) => {
    const row = {
      id: mapping.instanceId,
      templateId: `legacy-${mapping.templateId}`,
      name: `Старое здание ${index + 1}`,
      location: `Сектор ${index + 1}`,
      img: `legacy/building-${index + 1}.webp`,
      requirements: { food: 77, technology: 77, culture: 77, war: 77 },
      bonuses: { food: 88, technology: 88, culture: 88, war: 88 },
      productionLines: [{ id: "legacy-production", resource: "Milk", base: 999 }],
      income: { base: 9999, perWorker: 9999 },
      storage: { capacity: 9999, security: 99, quality: 99 },
      materialCosts: [{ id: "legacy-material", resourceId: "milk", qty: 999 }],
      workersMin: 9,
      workersMax: 9,
      workersAssigned: 9,
      assignedWorkerIds: ["resident-live-1"],
      upkeep: 999,
      enterpriseCapital: 999999,
      battleDamage: 12,
      lifecycle: "active",
      condition: "heavilyDamaged",
      repair: { active: true, fromCondition: "heavilyDamaged", progress: 1, target: 9 },
      buildProgress: mapping.state === "planned" ? 0 : 1,
      buildTarget: 99,
      constructionStatus: mapping.state,
      constructionCrewId: "legacy-crew",
      residents: 99,
      contents: [{ id: "legacy-content", name: "Milk", resourceId: "milk", qty: 99, capacity: 99 }],
      notes: "Старая экономика",
      effect: "Старый exploit"
    };
    if (mapping.instanceId === HOUSE_ONE_ID) row.name = "Дом-1";
    if (mapping.instanceId === HOUSE_TWO_ID) row.name = "Дом-2";
    if (mapping.instanceId === LAZARET_ID) {
      row.buildProgress = 2;
      row.buildTarget = 3;
    }
    if (mapping.instanceId === WAREHOUSE_ID) row.buildProgress = 0;
    if (mapping.instanceId === PASTURE_ID) {
      row.contents = [
        { id: "legacy-cows", name: "Коровы", resourceId: "cattle", qty: 9, capacity: 11 },
        { id: "legacy-bull", name: "Бык", resourceId: "", qty: 1, capacity: 1 }
      ];
    }
    if (mapping.instanceId === FASTI_ID) {
      row.name = "Лавка Фасти";
      row.img = "3_F00L/Other/Paintings/Fasti.png";
      row.audio = {
        mode: "playlist-sound",
        track: "Music/Sounds/ZiUseless/Spamton.mp3",
        src: "Music/Sounds/ZiUseless/Spamton.mp3",
        playlistId: "playlist-fasti",
        soundId: "sound-fasti",
        volume: 0.45,
        loop: true
      };
    }
    return row;
  });
}

function syntheticResidents() {
  const living = Array.from({ length: 12 }, (_, index) => ({
    id: `resident-live-${index + 1}`,
    name: `Живой ${index + 1}`,
    role: index === 0 ? "Стройбригада" : "Свободен",
    skill: index === 0 ? "Автономность" : "Умелец",
    sex: index % 2 ? "Ж" : "М",
    race: "Человек",
    subrace: "",
    ageGroup: "Вз",
    age: 30 + index,
    culture: "Нованд",
    belief: "",
    background: "Освобождённый пленник",
    appearance: "",
    traitsText: "",
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
    notes: `Заметка ${index + 1}`,
    actorUuid: "",
    educationMilestones: [],
    home: index < 10 ? (index < 5 ? HOUSE_ONE_ID : "Дом-1") : HOUSE_TWO_ID,
    workAssignment: "legacy-work",
    salary: 42,
    salaryModifier: 3,
    compensationType: "shares",
    compensationNote: "Старая ставка",
    shareRate: 50,
    housingProvided: true,
    boardFoodDaily: 4,
    battleCondition: "injured",
    battleNote: "Старое ранение",
    injuredDays: index === 0 ? 5 : 0,
    status: index === 0 ? "Ранен (5 дн.)" : "",
    dead: false,
    deathDate: "",
    deathNote: "",
    moraleBase: 8,
    moraleWork: 7,
    moraleHome: 6,
    moraleManual: 5,
    moraleDelta: 26
  }));
  const dead = Array.from({ length: 9 }, (_, index) => ({
    id: `resident-dead-${index + 1}`,
    name: `Погибший ${index + 1}`,
    role: "Поселенец",
    skill: "",
    sex: "",
    race: "Человек",
    subrace: "",
    ageGroup: "Вз",
    age: 40 + index,
    culture: "Нованд",
    belief: "",
    background: "Освобождённый пленник",
    appearance: "",
    traitsText: "",
    attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
    notes: "",
    actorUuid: "",
    educationMilestones: [],
    home: "Без жилья",
    workAssignment: "legacy-military-assignment",
    salary: 100,
    compensationType: "cash",
    injuredDays: 8,
    battleCondition: "dead",
    status: "Погиб",
    dead: true,
    deathDate: "неизвестно",
    deathNote: "плен Цейхан"
  }));
  return [...living, ...dead];
}

function syntheticSourceSnapshot() {
  return {
    format: "fbl-skyhold-world-economy-snapshot",
    version: 1,
    settings: {
      skyholdMeta: {
        schemaVersion: 91,
        revision: 2719,
        storageCommit: { version: 2, state: "complete", writeComplete: true, revision: 2719 }
      },
      skyholdHoldings: [
        {
          id: "laputa",
          name: "Лапута",
          type: "sky-island",
          owner: "Игроки",
          visibility: "public",
          linkedSceneId: "scene-laputa",
          overview: {
            status: "Стабильно",
            period: "Хладорост 881 г.П.П.",
            description: "Остров-летяга и поселение освобождённых пленников.",
            publicNotes: "Публичная история.",
            population: 999,
            morale: 99,
            moraleBase: 99,
            reputation: 99,
            defense: 99,
            region: "novand-riud",
            altitude: "-",
            drift: "-",
            mechanisms: "Не описано",
            weather: "Не указано",
            development: { food: 99, technology: 99, culture: 99, war: 99 }
          },
          people: { notes: "Старые ставки", list: syntheticResidents() },
          buildings: { notes: "Старая экономика", list: syntheticBuildings() },
          constructionCrewIds: ["resident-live-1"],
          constructionCrews: [{ id: "legacy-crew", memberIds: ["resident-live-1"] }],
          special: {
            list: [{ id: "legacy-route", name: "Старый контракт" }],
            market: { preferredRoomId: "legacy-room", orders: [{ id: "legacy-order" }] },
            fleet: { vessels: [{ id: "legacy-vessel" }], transfers: [{ id: "legacy-transfer" }] }
          },
          storage: {
            moneyCopper: 7660,
            resources: [{ id: "milk", qty: 999 }],
            items: [{ id: "legacy-item" }],
            log: [{ id: "legacy-storage-log" }],
            transaction: { id: "legacy-transaction" }
          },
          gm: {
            eventTables: { legacy: true },
            eventHistory: [{ id: "legacy-event" }],
            eventSchedule: [{ id: "legacy-scheduled-event" }],
            eventArchive: [{ id: "legacy-event-archive" }],
            defense: { squads: [{ id: "legacy-squad" }] },
            massCombat: { archive: [{ id: "legacy-battle" }], log: [{ id: "legacy-battle-log" }] }
          },
          log: [{ id: "legacy-holding-log" }]
        },
        { id: "holding-YqxVhKAEY4", name: "Олива", storage: { moneyCopper: 999999 } }
      ],
      skyholdCatalog: { buildings: [{ id: "legacy-template" }], resources: [{ id: "milk" }] },
      skyholdData: { meta: { revision: 2716 }, holdings: [{ id: "legacy-rollback" }] }
    }
  };
}

function syntheticCurrentData() {
  return {
    meta: {
      schemaVersion: SKYHOLD_SCHEMA_VERSION,
      templateCatalogVersion: 12,
      revision: 42,
      storageCommit: { version: 2, state: "complete", writeComplete: true, revision: 42 }
    },
    holdings: [{ id: "current-before-migration", name: "Current target" }],
    catalog: {
      buildings: clone(DEFAULT_BUILDING_TEMPLATES),
      deletedBuildingTemplateIds: [],
      resources: [{ id: "coke", label: "Старый кокс" }, { id: "cloth-wool", label: "Старая шерстяная ткань" }],
      marketEconomy: {
        schemaVersion: 3,
        baseOffers: [{ id: "old-coke", resourceId: "coke", basePriceCopper: 12, load: 2, baseStock: 65 }],
        countries: [{
          id: "old-industry",
          label: "Старая промышленная страна",
          offers: [
            { id: "old-coal", resourceId: "coal", basePriceCopper: 9, load: 2, baseStock: 80 },
            { id: "old-coke", resourceId: "coke", basePriceCopper: 12, load: 2, baseStock: 65 }
          ]
        }],
        specialties: [{ id: "old-winery", label: "Старая винодельня", offers: [{ id: "old-wine", resourceId: "wine", baseStock: 20 }] }],
        organizations: []
      }
    },
    skyholdData: { meta: { revision: 1 }, holdings: [{ id: "legacy-active-copy" }] }
  };
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error?.code === code, `Expected LaputaMigrationError code ${code}`);
}

function targetTemplate(currentData, id) {
  return currentData.catalog.buildings.find((row) => row.id === id);
}

const source = syntheticSourceSnapshot();
const current = syntheticCurrentData();
const sourceBefore = stableDataHash(source);
const currentBefore = stableDataHash(current);
const canonicalMarketPackBefore = stableDataHash(canonicalMarketPack);
const audit = auditLaputaMigrationSource({ snapshot: source, sourceHash: LAPUTA_SOURCE_SHA256 });
assert.deepEqual(audit.counts, {
  holdings: 2,
  residents: 21,
  livingResidents: 12,
  deadResidents: 9,
  buildings: 16,
  houseOneResidents: 10,
  houseTwoResidents: 2,
  cattle: 10,
  breedingBulls: 1,
  moneyCopper: 7660
});

expectCode("source-hash", () => auditLaputaMigrationSource({ snapshot: source, sourceHash: "0".repeat(64) }));
const wrongRevision = clone(source);
wrongRevision.settings.skyholdMeta.revision = 2718;
expectCode("source-revision", () => auditLaputaMigrationSource({ snapshot: wrongRevision, sourceHash: LAPUTA_SOURCE_SHA256 }));
const missingSourceBuilding = clone(source);
missingSourceBuilding.settings.skyholdHoldings[0].buildings.list.pop();
expectCode("source-building-map", () => auditLaputaMigrationSource({ snapshot: missingSourceBuilding, sourceHash: LAPUTA_SOURCE_SHA256 }));

const missingTarget = clone(current);
missingTarget.catalog.buildings = missingTarget.catalog.buildings.filter((row) => row.id !== "lazaret");
expectCode("target-templates", () => planLaputaEconomyMigration({
  snapshot: source,
  sourceHash: LAPUTA_SOURCE_SHA256,
  currentData: missingTarget,
  canonicalMarketPack,
  operationId: "laputa-migration-test"
}));

const wrongMarketPack = clone(canonicalMarketPack);
wrongMarketPack.version -= 1;
expectCode("target-market-pack", () => planLaputaEconomyMigration({
  snapshot: source,
  sourceHash: LAPUTA_SOURCE_SHA256,
  currentData: current,
  canonicalMarketPack: wrongMarketPack,
  operationId: "laputa-migration-wrong-market"
}));

const plan = planLaputaEconomyMigration({
  snapshot: source,
  sourceHash: LAPUTA_SOURCE_SHA256,
  currentData: current,
  canonicalMarketPack,
  operationId: "laputa-migration-test",
  createdAt: "2026-08-11T00:00:00.000Z"
});
assert.equal(plan.preview.residents, 21);
assert.equal(plan.preview.buildings, 16);
assert.deepEqual(plan.preview.holdingsRemoved, ["current-before-migration"]);
assert.equal(plan.preview.resourceCatalogRows, ECONOMY_RESOURCE_CATALOG_SIZE - 1);
assert.equal(plan.preview.marketBaseOffers, ECONOMY_RESOURCE_CATALOG_SIZE - 1);
assert.equal(plan.preview.marketPackVersion, LAPUTA_MARKET_PACK_VERSION);
assert.equal(plan.preview.marketLocations, 69);
assert.equal(plan.preview.marketCountries, 16);
assert.equal(plan.preview.marketSpecialties, 135);
assert.equal(plan.preview.marketOrganizations, 22);
assert.equal(plan.preview.resourceRowsReplaced, 2);
assert.equal(plan.preview.marketRowsReplaced, 3);
assert.equal(plan.target.marketPackId, LAPUTA_MARKET_PACK_ID);
assert.equal(plan.target.marketPackVersion, LAPUTA_MARKET_PACK_VERSION);

const tamperedPlan = clone(plan);
tamperedPlan.preview.moneyCopper = 1;
expectCode("plan-hash", () => applyLaputaEconomyMigration({ currentData: current, plan: tamperedPlan }));
expectCode("operation-mismatch", () => applyLaputaEconomyMigration({ currentData: current, plan, operationId: "other-operation" }));
const staleRevision = clone(current);
staleRevision.meta.revision += 1;
expectCode("target-revision", () => applyLaputaEconomyMigration({ currentData: staleRevision, plan }));
const staleCatalog = clone(current);
staleCatalog.catalog.buildings.find((row) => row.id === "warehouse").upkeep += 1;
expectCode("target-catalog-hash", () => applyLaputaEconomyMigration({ currentData: staleCatalog, plan }));

const applied = applyLaputaEconomyMigration({ currentData: current, plan });
assert.equal(applied.ok, true);
assert.equal(applied.alreadyApplied, false);
assert.equal(applied.commitRequired, true);
assert.equal(applied.data.holdings.length, 1);
assert.equal(applied.data.holdings[0].id, "laputa");
assert.equal("skyholdData" in applied.data, false);
assert.equal(applied.data.catalog.resources.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1);
assert.ok(applied.data.catalog.resources.every((row) => isCanonicalResourceId(row.id) && row.id !== "money"));
assert.equal(applied.data.catalog.marketEconomy.baseOffers.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1);
assert.ok(applied.data.catalog.marketEconomy.baseOffers.every((row) => isCanonicalResourceId(row.resourceId)));
assert.equal(applied.data.catalog.markets.length, 0);
assert.equal(applied.data.catalog.eventRegions.length, 69);
assert.equal(applied.data.catalog.marketEconomy.countries.length, 16);
assert.equal(applied.data.catalog.marketEconomy.specialties.length, 135);
assert.equal(applied.data.catalog.marketEconomy.organizations.length, 22);
assert.equal(applied.data.catalog.marketEconomy.countries.some((row) => row.id === "old-industry"), false, "legacy countries must not survive the clean market install");
assert.equal(applied.data.catalog.marketEconomy.specialties.some((row) => row.id === "old-winery"), false, "legacy specialties must not survive the clean market install");
assert.equal(applied.data.catalog.marketRouteMap.calibration.distanceKm, 600);
const holding = applied.data.holdings[0];
assert.equal(holding.storage.moneyCopper, 7660);
assert.deepEqual(holding.storage.resources, []);
assert.deepEqual(holding.storage.items, []);
assert.deepEqual(holding.storage.log, []);
assert.equal("transaction" in holding.storage, false);
assert.deepEqual(holding.log, []);
assert.deepEqual(holding.special.list, []);
assert.deepEqual(holding.special.market, {
  preferredRoomId: "outdoors",
  stock: {},
  demand: {},
  outbound: { version: 1, orders: [], operationIds: [], updatedAt: "" },
  orders: []
});
assert.equal("fleet" in holding.special, false);
assert.deepEqual(holding.constructionCrewIds, []);
assert.deepEqual(holding.constructionCrews, []);
assert.deepEqual(holding.gm.defense.squads, []);
assert.deepEqual(holding.gm.eventHistory, []);
assert.deepEqual(holding.gm.eventSchedule, []);
assert.deepEqual(holding.gm.eventArchive, []);
assert.deepEqual(holding.gm.massCombat.archive, []);
assert.deepEqual(holding.gm.massCombat.log, []);
assert.equal(holding.overview.population, 12);
assert.deepEqual(holding.overview.development, { food: 0, technology: 0, culture: 0, war: 0 });
assert.equal(holding.overview.reputation, 0);
assert.equal(holding.overview.description, source.settings.skyholdHoldings[0].overview.description);

assert.equal(holding.people.list.length, 21);
assert.equal(holding.people.list.filter((person) => !person.dead).length, 12);
assert.equal(holding.people.list.filter((person) => person.dead).length, 9);
assert.equal(holding.people.list.filter((person) => person.home === HOUSE_ONE_ID).length, 10);
assert.equal(holding.people.list.filter((person) => person.home === HOUSE_TWO_ID).length, 2);
assert.equal(holding.people.list.filter((person) => person.dead && person.home).length, 0);
assert.ok(holding.people.list.every((person) => person.workAssignment === "" && person.injuredDays === 0));
assert.ok(holding.people.list.every((person) => person.salary === 0 && person.salaryModifier === 0));
assert.ok(holding.people.list.every((person) => !("compensationType" in person) && !("shareRate" in person) && !("battleCondition" in person)));
assert.ok(holding.people.list.every((person) => !("skill" in person)), "Laputa migration must not preserve the removed resident profession field");
assert.match(holding.people.list.find((person) => person.id === "resident-live-1").traitsText, /Автономность/, "a custom legacy value must survive as a custom trait");
assert.equal(holding.people.list.find((person) => person.id === "resident-live-1").status, "");
assert.ok(holding.people.list.filter((person) => person.dead).every((person) => person.deathDate === "неизвестно" && person.deathNote === "плен Цейхан"));

assert.equal(holding.buildings.list.length, 16);
assert.deepEqual(holding.buildings.list.map((row) => row.id), LAPUTA_BUILDING_MAPPING.map((row) => row.instanceId));
assert.deepEqual(holding.buildings.list.map((row) => row.templateId), LAPUTA_BUILDING_MAPPING.map((row) => row.templateId));
assert.ok(holding.buildings.list.every((row) => row.condition === "intact" && row.battleDamage === 0 && row.repair.active === false));
assert.ok(holding.buildings.list.every((row) => row.assignedWorkerIds.every((id) => id === "") && row.constructionCrewId === ""));
for (const mapping of LAPUTA_BUILDING_MAPPING.filter((row) => row.state === "built")) {
  const row = holding.buildings.list.find((building) => building.id === mapping.instanceId);
  assert.equal(row.lifecycle, "active");
  assert.equal(row.constructionStatus, "built");
  assert.equal(row.buildProgress, row.buildTarget);
}
assert.equal(holding.buildings.list.find((row) => row.id === HOUSE_ONE_ID).residents, 10);
assert.equal(holding.buildings.list.find((row) => row.id === HOUSE_TWO_ID).residents, 2);

const crypt = holding.buildings.list.find((row) => row.templateId === "laputa-excavated-crypt");
const targetCrypt = targetTemplate(current, "laputa-excavated-crypt");
assert.deepEqual(crypt.storage, targetCrypt.storage);
assert.deepEqual(crypt.functions, targetCrypt.functions);
assert.deepEqual(crypt.contents, []);
assert.equal(crypt.productionLines.length, 0);
assert.equal(crypt.income.base, 0);

const fasti = holding.buildings.list.find((row) => row.id === FASTI_ID);
assert.equal(fasti.img, "3_F00L/Other/Paintings/Fasti.png");
assert.equal(fasti.audio.playlistId, "playlist-fasti");
assert.equal(fasti.effect, targetTemplate(current, "fasti-shop").effect);
assert.deepEqual(fasti.special, targetTemplate(current, "fasti-shop").special);

const lazaret = holding.buildings.list.find((row) => row.id === LAZARET_ID);
const targetLazaret = targetTemplate(current, "lazaret");
assert.equal(lazaret.lifecycle, "building");
assert.equal(lazaret.condition, "intact");
assert.equal(lazaret.buildTarget, targetLazaret.buildTarget);
assert.equal(
  lazaret.buildProgress,
  Math.min(targetLazaret.buildTarget - 1, Math.round((2 / 3) * targetLazaret.buildTarget)),
  "Lazaret migration must preserve its 2/3 completion ratio against the current approved template"
);
assert.equal(lazaret.materialsAllocated, true);
assert.equal(lazaret.constructionCrewId, "");
assert.deepEqual(lazaret.materialCosts, targetLazaret.materialCosts);

const rescaledTarget = clone(current);
rescaledTarget.catalog.buildings.find((row) => row.id === "lazaret").buildTarget = 6;
const rescaledPlan = planLaputaEconomyMigration({
  snapshot: source,
  sourceHash: LAPUTA_SOURCE_SHA256,
  currentData: rescaledTarget,
  canonicalMarketPack,
  operationId: "laputa-migration-rescaled",
  createdAt: "2026-08-11T00:00:00.000Z"
});
const rescaledApplied = applyLaputaEconomyMigration({ currentData: rescaledTarget, plan: rescaledPlan });
const rescaledLazaret = rescaledApplied.data.holdings[0].buildings.list.find((row) => row.id === LAZARET_ID);
assert.equal(rescaledLazaret.buildTarget, 6);
assert.equal(rescaledLazaret.buildProgress, 4, "Lazaret migration must preserve its 2/3 completion ratio when target difficulty changes");

const warehouse = holding.buildings.list.find((row) => row.id === WAREHOUSE_ID);
assert.equal(warehouse.lifecycle, "planned");
assert.equal(warehouse.buildProgress, 0);
assert.equal(warehouse.materialsAllocated, false);
assert.deepEqual(warehouse.materialCosts, targetTemplate(current, "warehouse").materialCosts);
assert.deepEqual(warehouse.storage, targetTemplate(current, "warehouse").storage);

const pasture = holding.buildings.list.find((row) => row.id === PASTURE_ID);
assert.deepEqual(pasture.contents, []);
assert.equal(pasture.livestock.speciesId, "cattle");
assert.equal(pasture.livestock.profile.capacity, 12);
assert.equal(pasture.livestock.state.adults, 10);
assert.equal(pasture.livestock.state.breedingMales, 1);
assert.deepEqual(pasture.livestock.state.young, []);
assert.equal(JSON.stringify(pasture.contents).includes("Milk"), false);
assert.equal(JSON.stringify(pasture).includes('"name":"Бык"'), false);

const marker = holding.gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE];
assert.equal(marker.operationId, "laputa-migration-test");
assert.equal(marker.source.schemaVersion, 91);
assert.equal(marker.target.schemaVersion, SKYHOLD_SCHEMA_VERSION);
assert.equal(marker.target.rollbackDataHash, currentBefore, "migration metadata must bind rollback to the exact pre-migration root");
assert.deepEqual(marker.financialRegisters, {
  schemaVersion: 1,
  debts: [],
  loans: [],
  bankContracts: [],
  obligationOrder: ["bank-debt", "wages", "building-upkeep", "voluntary"]
});
assert.equal(marker.projects.lazaret.materialsFullyPaid, true);
assert.equal(marker.projects.lazaret.futureMaterialCharge, false);
assert.equal(marker.projects.warehouse.stagedMaterialCharges, true);
assert.equal(marker.projects.warehouse.cancellationRefundRate, 0.9);
assert.deepEqual(marker.runtimeContracts, {
  financeObligations: "canonical-ledger",
  construction: "staged-material-charges",
  assignments: "cleared-for-explicit-replan",
  resourceCatalog: `economy-v${ECONOMY_RESOURCE_CATALOG_VERSION}`,
  marketReferences: "canonical-resource-ids",
  marketInstall: `clean:air-islands-trade-network-template:v${LAPUTA_MARKET_PACK_VERSION}`
});
assert.equal(marker.target.catalogHash, stableDataHash(applied.data.catalog), "migration metadata must bind the resulting canonical catalog");
assert.equal(marker.target.marketPackId, LAPUTA_MARKET_PACK_ID);
assert.equal(marker.target.marketPackVersion, LAPUTA_MARKET_PACK_VERSION);
assert.equal(marker.target.marketPackHash, plan.target.marketPackHash);
assert.equal(applied.data.holdings[0].gm.economy.internalDemand.populationBudgetPerResidentCopper, 12, "Laputa must use the repriced income scale after migration");
assert.equal(marker.livestock.species, "cattle");
assert.equal(marker.livestock.count, 10);
assert.equal(marker.livestock.breedingBullCount, 1);
assert.equal(marker.cemetery.residentIds.length, 9);
assert.equal(holding.buildings.list.some((row) => Object.hasOwn(row, "location")), false, "building instances must not preserve the retired location field");

assert.equal(stableDataHash(source), sourceBefore, "Planning/apply must not mutate the source snapshot");
assert.equal(stableDataHash(current), currentBefore, "Planning/apply must not mutate current data");
assert.equal(stableDataHash(canonicalMarketPack), canonicalMarketPackBefore, "Planning/apply must not mutate the bundled market pack");
const repeated = applyLaputaEconomyMigration({ currentData: applied.data, plan });
assert.equal(repeated.alreadyApplied, true);
assert.equal(repeated.commitRequired, false);
assert.equal(stableDataHash(repeated.data), stableDataHash(applied.data));
const repeatedAfterCatalogChange = clone(applied.data);
repeatedAfterCatalogChange.catalog.buildings = [];
assert.equal(applyLaputaEconomyMigration({ currentData: repeatedAfterCatalogChange, plan }).alreadyApplied, true);

const otherOperation = clone(applied.data);
otherOperation.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE].operationId = "earlier-operation";
expectCode("already-applied", () => applyLaputaEconomyMigration({ currentData: otherOperation, plan }));

for (const priorPackVersion of [12, 13]) {
  const priorPackMigration = clone(otherOperation);
  priorPackMigration.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE].target.marketPackVersion = priorPackVersion;
  expectCode("already-applied", () => applyLaputaEconomyMigration({ currentData: priorPackMigration, plan }));
  expectCode("already-applied", () => planLaputaEconomyMigration({
    snapshot: source,
    sourceHash: LAPUTA_SOURCE_SHA256,
    currentData: priorPackMigration,
    canonicalMarketPack,
    operationId: "laputa-completed-migration-retry"
  }));
}

const outdatedMigration = clone(applied.data);
const outdatedMarker = outdatedMigration.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE];
outdatedMarker.version -= 1;
outdatedMarker.target.marketPackVersion -= 1;
outdatedMarker.operationId = "outdated-operation";
const upgradePlan = planLaputaEconomyMigration({
  snapshot: source,
  sourceHash: LAPUTA_SOURCE_SHA256,
  currentData: outdatedMigration,
  canonicalMarketPack,
  operationId: "laputa-migration-upgrade",
  createdAt: "2026-08-27T00:00:00.000Z"
});
const upgraded = applyLaputaEconomyMigration({ currentData: outdatedMigration, plan: upgradePlan });
assert.equal(upgraded.commitRequired, true, "an outdated migration marker must allow a new atomic migration");
assert.equal(upgraded.data.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE].operationId, "laputa-migration-upgrade");
assert.equal(upgraded.data.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE].target.marketPackVersion, LAPUTA_MARKET_PACK_VERSION);

const migrationImporterSource = readFileSync(new URL("../apps/editors/laputa-migration-importer.js", import.meta.url), "utf8");
const migrationImporterTemplate = readFileSync(new URL("../../templates/laputa-migration-importer.hbs", import.meta.url), "utf8");
const childWindowSource = readFileSync(new URL("../apps/domains/child-window-domain.js", import.meta.url), "utf8");
assert.match(migrationImporterSource, /crypto\?\.subtle|crypto\.subtle/, "the GM migration importer must calculate a cryptographic source hash in the browser");
assert.match(migrationImporterSource, /const file = event\.target\?\.files\?\.\[0\]/, "the delegated change handler must read the selected file from the actual input target");
assert.match(migrationImporterSource, /forceRollbackSnapshot:\s*true/, "the destructive migration must explicitly preserve the pre-migration root");
assert.match(migrationImporterSource, /applyLaputaEconomyMigration/, "the UI must use the strict pure migration workflow");
assert.match(migrationImporterSource, /LAPUTA_MARKET_PACK_PATH/, "the migration UI must load the bundled canonical market pack itself");
assert.match(migrationImporterSource, /getRollbackSnapshotInfo/, "rollback availability must be bound to the expected pre-migration hash");
assert.match(migrationImporterSource, /isCurrentLaputaMigrationMarker/, "the migration UI must distinguish an outdated marker from the current economy contract");
assert.match(migrationImporterSource, /game\.user\?\.isGM/, "the migration importer must reject non-GM use");
assert.match(migrationImporterTemplate, /data-action="laputa-migration-apply"/, "the migration Preview must expose an explicit Apply action");
assert.match(migrationImporterTemplate, /data-action="laputa-migration-rollback"/, "an exact pre-migration snapshot must expose an explicit rollback action");
assert.match(migrationImporterTemplate, /migrationUpgradeAvailable/, "an outdated migration must visibly expose the upgrade path");
assert.match(childWindowSource, /import\("\.\.\/editors\/laputa-migration-importer\.js"\)/, "the migration window must remain behind a lazy import boundary");

const normalizedApplied = normalizeSkyholdData(applied.data);
assert.equal(normalizedApplied.holdings.length, 1);
assert.equal(normalizedApplied.holdings[0].people.list.length, 21);
assert.equal(normalizedApplied.holdings[0].buildings.list.length, 16);
assert.equal(normalizedApplied.holdings[0].gm.migrationMetadata[LAPUTA_MIGRATION_NAMESPACE].operationId, "laputa-migration-test");
assert.ok(normalizedApplied.holdings[0].constructionCrews.every((crew) => crew.memberIds.length === 0));
assert.equal(normalizedApplied.catalog.resources.length, ECONOMY_RESOURCE_CATALOG_SIZE - 1);
assert.equal(normalizedApplied.catalog.eventRegions.length, 69);
assert.equal(normalizedApplied.catalog.marketEconomy.countries.length, 16);
assert.equal(normalizedApplied.catalog.marketEconomy.specialties.length, 135);
assert.equal(normalizedApplied.catalog.marketEconomy.organizations.length, 22);

const realSnapshotPath = process.argv[2];
if (realSnapshotPath) {
  const bytes = readFileSync(realSnapshotPath);
  const sourceHash = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const snapshot = JSON.parse(bytes.toString("utf8"));
  const realAudit = auditLaputaMigrationSource({ snapshot, sourceHash });
  const realPlan = planLaputaEconomyMigration({
    snapshot,
    sourceHash,
    currentData: current,
    canonicalMarketPack,
    operationId: "laputa-real-snapshot-readonly-check",
    createdAt: "2026-08-11T00:00:00.000Z"
  });
  const realApplied = applyLaputaEconomyMigration({ currentData: current, plan: realPlan });
  const realHolding = normalizeSkyholdData(realApplied.data).holdings[0];
  assert.equal(realHolding.id, "laputa");
  assert.equal(realHolding.people.list.length, 21);
  assert.equal(realHolding.people.list.filter((person) => person.dead).length, 9);
  assert.equal(realHolding.buildings.list.length, 16);
  assert.equal(realHolding.storage.moneyCopper, 7660);
  assert.deepEqual(realHolding.storage.resources, []);
  assert.deepEqual(realHolding.special.market.stock, {});
  console.log(`[laputa:migration:check] source=${sourceHash} revision=${realAudit.revision} residents=${realAudit.counts.residents} buildings=${realAudit.counts.buildings} money=${realAudit.counts.moneyCopper}`);
}

console.log("Laputa migration characterization checks passed.");
