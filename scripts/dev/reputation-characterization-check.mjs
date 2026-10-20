import assert from "node:assert/strict";
import { confirmSocialWork } from "./social-effects-fixtures.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { buildingConfirmedSocialStatus, buildingServiceEffectFactor, scaleIntegerBuildingEffect } from "../engines/economy/building-service.js";

function building(id, templateId, reputation, extra = {}) {
  return {
    id,
    templateId,
    name: extra.name ?? id,
    constructionStatus: extra.constructionStatus ?? "built",
    reputation,
    ...extra
  };
}

function createHarness() {
  return {
    ...BuildingProductionDomain,
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },
    _buildingStatus(value = {}) {
      return { value: String(value.constructionStatus ?? "built") };
    },
    _gmSettlementModifiers(holding = {}) {
      return { reputation: this._safeNumber(holding.gm?.modifiers?.reputation, 0) };
    },
    _calculateMorale() {
      return 0;
    },
    _moraleState(value) {
      return { value: this._safeNumber(value, 0) };
    }
  };
}

function summarize(buildings, { gmMod = 0, morale = 0 } = {}) {
  const harness = createHarness();
  const holding = {
    buildings: { list: structuredClone(buildings) },
    people: { list: buildings.map((row) => ({ id: `worker-${row.id}`, volunteerLabor: true })) },
    gm: { modifiers: { reputation: gmMod } }
  };
  for (const row of holding.buildings.list) confirmSocialWork(holding, row, [`worker-${row.id}`]);
  return harness._reputationSummary(holding, { value: morale });
}

export function checkReputationCharacterization() {
  const repeated = [
    building("market-c", " market ", 5),
    building("market-a", "MARKET", 5),
    building("market-b", "market", 5),
    building("unfinished", "market", 100, { constructionStatus: "building" })
  ];
  const repeatedSummary = summarize(repeated);
  assert.equal(repeatedSummary.rawTotal, 5, "only the first active copy of a template contributes reputation by default");
  assert.equal(repeatedSummary.undiminishedTotal, 15, "summary must retain the diagnostic undiminished building total without persisting it");
  assert.deepEqual(repeatedSummary.buildings.map(({ id, rank, value }) => ({ id, rank, value })), [
    { id: "market-a", rank: 1, value: 5 },
    { id: "market-b", rank: 2, value: 0 },
    { id: "market-c", rank: 3, value: 0 }
  ], "template copies must be ranked by stable instance id rather than current array order");
  assert.match(repeatedSummary.tooltip, /повторы дают 0/);
  assert.match(repeatedSummary.tooltip, /market-b: \+5 → 0 \(повтор шаблона\)/);

  const shuffledSummary = summarize([repeated[1], repeated[2], repeated[0]]);
  assert.deepEqual(
    shuffledSummary.buildings.map(({ id, rank, value }) => ({ id, rank, value })),
    repeatedSummary.buildings.map(({ id, rank, value }) => ({ id, rank, value })),
    "reordering saved building rows must not change repeat ranks or contributions"
  );

  const legacySummary = summarize([
    building("legacy-a", "", 5, { name: "Старая постройка" }),
    building("legacy-b", "", 5, { name: "Старая постройка" })
  ]);
  assert.equal(legacySummary.rawTotal, 10, "buildings without templateId must remain independent instances even when names match");
  assert.deepEqual(legacySummary.buildings.map(({ rank, value }) => ({ rank, value })), [
    { rank: 1, value: 5 },
    { rank: 1, value: 5 }
  ]);

  const negativeSummary = summarize([
    building("omen-a", "bad-omen", -5),
    building("omen-b", "bad-omen", -5),
    building("omen-c", "bad-omen", -5)
  ], { gmMod: 10, morale: -1 });
  assert.deepEqual(negativeSummary.buildings.map(({ rank, value }) => ({ rank, value })), [
    { rank: 1, value: -5 },
    { rank: 2, value: 0 },
    { rank: 3, value: 0 }
  ], "negative reputation follows the same first-template-only repeat rule");
  assert.equal(negativeSummary.rawTotal, -5);
  assert.equal(negativeSummary.gmMod, 10, "GM reputation modifier must remain a separate additive modifier");
  assert.equal(negativeSummary.moraleMod, 0, "reputation must not contain a hidden morale penalty");
  assert.equal(negativeSummary.total, 5, "final reputation applies only active building and explicit GM contributions");

  const explicitRepeatSummary = summarize([
    building("memorial-a", "memorial", 2),
    building("memorial-b", "memorial", 2, { repeatSettlementEffects: true })
  ]);
  assert.equal(explicitRepeatSummary.rawTotal, 4, "a template may explicitly permit repeated settlement effects");
  assert.equal(explicitRepeatSummary.buildings[1].repeatAllowed, true);

  const boundedSummary = summarize(Array.from({ length: 20 }, (_, index) => building(`tiny-${String(index).padStart(2, "0")}`, "tiny", 1)));
  assert.equal(boundedSummary.rawTotal, 1, "arbitrarily many +1 copies must not produce an unbounded +1-per-building exploit");
  assert.equal(boundedSummary.buildings.every((row) => Number.isInteger(row.value)), true, "diminishing contributions must always be whole reputation dice");
  assert.equal(boundedSummary.buildings.slice(1).every((row) => row.value === 0), true);

  const fractionalSummary = summarize([
    building("fraction-positive", "fraction-positive", 3.9),
    building("fraction-negative", "fraction-negative", -3.9)
  ]);
  assert.equal(fractionalSummary.rawTotal, 0, "legacy fractional building values must round symmetrically before they reach reputation dice");
  assert.deepEqual(fractionalSummary.buildings.map((row) => row.value), [-4, 4]);

  const staffedBuilding = building("bathhouse", "bathhouse", 5, {
    workersMin: 1,
    workersMax: 2,
    activation: { minWorkers: 1 },
    functions: { culture: true },
    assignedWorkerIds: ["attendant"],
    maintenance: { backlogTendays: 2 }
  });
  const staffedHolding = {
    people: { list: [{ id: "attendant", dead: false, injuredDays: 0 }] },
    buildings: { list: [staffedBuilding] },
    finance: {}
  };
  assert.equal(buildingServiceEffectFactor(staffedHolding, staffedBuilding), 0.5, "a staffed active service with two missed maintenance tendays must run at half effect");
  assert.equal(scaleIntegerBuildingEffect(5, 0.5), 3, "partial positive effects use symmetric whole-number rounding");
  staffedBuilding.assignedWorkerIds = [];
  assert.equal(buildingServiceEffectFactor(staffedHolding, staffedBuilding), 0, "an active institution without its minimum staff must give no settlement effect");
  const passiveMonument = building("spire", "spire", 5, {
    workersMin: 0,
    workersMax: 0,
    workerProfile: { workersMin: 0, workersMax: 0, composition: [] },
    functions: { culture: true },
    serviceState: { functionId: "culture", active: false },
    maintenance: { backlogTendays: 9 }
  });
  assert.equal(buildingServiceEffectFactor(staffedHolding, passiveMonument), 1, "The generic readiness helper preserves passive structural behavior");
  assert.equal(buildingConfirmedSocialStatus(staffedHolding, passiveMonument).active, false, "Positive reputation never inherits passive structural readiness");

  return { repeated: repeatedSummary.rawTotal, legacy: legacySummary.rawTotal, negative: negativeSummary.rawTotal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkReputationCharacterization();
  console.log("FBL Skyhold reputation characterization checks passed.");
}
