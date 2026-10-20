import assert from "node:assert/strict";
import { FinanceDomain } from "../apps/domains/finance-domain.js";
import { BuildingProductionDomain } from "../apps/domains/building/production-domain.js";
import { BuildingWorkerDomain } from "../apps/domains/building/worker-domain.js";
import { normalizeProductionLine } from "../core/resources.js";
import { normalizeBuilding } from "../data/normalizers/building.js";
import { BASE_HOLDING } from "../data/schema/base-holding.js";
import { clone } from "../data/utils.js";
import { runConstruction } from "../engines/economy/construction.js";
import { isFoodResource, runFoodConsumption } from "../engines/economy/food-consumption.js";
import { runProductionCycle } from "../engines/economy/production-cycle.js";
import { summarizeEconomyReport } from "../engines/economy/report.js";
import { runTrade } from "../engines/economy/trade.js";
import { runTreasuryCosts } from "../engines/economy/treasury-costs.js";
import { economyLedgerStorageRows, normalizeEconomyLedgerEntry } from "../engines/economy/ledger.js";
import { buildTendayOperationPayload, hydrateTendayOperation } from "../engines/tenday/operation-payload.js";

function makeHolding() {
  const holding = clone(BASE_HOLDING);
  holding.id = "economy-characterization";
  holding.name = "Тестовое владение";
  holding.overview.reputation = 0;
  holding.people.list = [];
  holding.buildings.list = [];
  holding.constructionCrews = [];
  holding.storage.resources = [];
  holding.storage.items = [];
  holding.storage.moneyCopper = 0;
  return holding;
}

let resourceSequence = 0;

function resource(resourceId, qty, extra = {}) {
  resourceSequence += 1;
  return {
    id: `resource-${resourceId}-${resourceSequence}`,
    resourceId,
    name: resourceId,
    qty,
    unit: "ед.",
    roomId: "outdoors",
    ...extra
  };
}

function builtProductionBuilding(id, productionLines, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    constructionStatus: "built",
    status: "Построено",
    functions: { production: true, income: false, ...(extra.functions ?? {}) },
    assignedWorkerIds: extra.assignedWorkerIds ?? [],
    productionLines,
    ...extra
  };
}

function reportShape() {
  return {
    periodQd: 40,
    periodLabel: "десятник",
    produced: [],
    consumed: [],
    skipped: [],
    income: [],
    formulas: [],
    work: [],
    ledger: [],
    food: { needed: 0, eaten: 0, hungryResidentDays: 0, lines: [] },
    construction: { attempts: 0, completed: 0, lines: [] },
    trade: { buyers: 0, sold: 0, revenue: 0, purchases: [] },
    treasury: { spent: 0, deficit: 0, lines: [] }
  };
}

function quantity(holding, resourceId) {
  return (holding.storage.resources ?? [])
    .filter((row) => row.resourceId === resourceId)
    .reduce((sum, row) => sum + Number(row.qty ?? 0), 0);
}

function comparableEconomyDraft(holding) {
  const comparable = clone(holding);
  for (const row of comparable.storage?.resources ?? []) {
    delete row.id;
    for (const batch of row.batches ?? []) delete batch.id;
  }
  for (const row of comparable.storage?.log ?? []) delete row.id;
  return comparable;
}

function createEconomyHarness() {
  return {
    ...FinanceDomain,
    _productionSeasonDefs: BuildingProductionDomain._productionSeasonDefs,
    _normalizeProductionSeasons: BuildingProductionDomain._normalizeProductionSeasons,
    _currentProductionSeasonKey: BuildingProductionDomain._currentProductionSeasonKey,
    _lineSeasonAllowed: BuildingProductionDomain._lineSeasonAllowed,

    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    },

    _buildingStatus(building = {}) {
      const raw = String(building.constructionStatus ?? building.status ?? "built").toLowerCase();
      if (raw === "built" || raw === "построено") return { value: "built", label: "Построено" };
      if (raw === "paused") return { value: "paused", label: "Приостановлено" };
      if (raw === "damaged") return { value: "damaged", label: "Повреждено" };
      return { value: raw || "building", label: "Строится" };
    },

    _buildingFunctions(building = {}) {
      return {
        production: Boolean(building.functions?.production),
        income: Boolean(building.functions?.income),
        defense: Boolean(building.functions?.defense),
        housing: Boolean(building.functions?.housing),
        storage: Boolean(building.functions?.storage),
        culture: Boolean(building.functions?.culture)
      };
    },

    _buildingEffectiveWorkers(holding, building) {
      const assigned = (building.assignedWorkerIds ?? [])
        .map((id) => (holding.people.list ?? []).find((person) => String(person.id) === String(id)))
        .filter((person) => person && !person.dead && Number(person.injuredDays ?? 0) <= 0);
      return {
        assigned: assigned.length,
        total: assigned.reduce((sum, person) => sum + Number(person.testEfficiency ?? 1), 0),
        detail: `${assigned.length} раб.`
      };
    },

    _buildingMoneyIncome(building, holding) {
      if (this._buildingStatus(building).value !== "built" || !this._buildingFunctions(building).income) return 0;
      const workers = this._buildingEffectiveWorkers(holding, building);
      return Math.max(0, Number(building.income?.base ?? 0) + Number(building.income?.perWorker ?? 0) * workers.total);
    },

    _workerType(person = {}) {
      return String(person.workerType ?? person.role ?? "");
    },

    _workerTypeEffectForPerson() {
      return { value: 0 };
    },

    _workerEfficiencyForPerson: BuildingWorkerDomain._workerEfficiencyForPerson,

    _buildingEfficiencyModifier() {
      return { value: 0, reasons: [] };
    },

    _buildingHasOvertimeProduction(building = {}) {
      return (building.productionLines ?? []).some((line) => line.overtime);
    },

    _assignedWorkerSet(holding) {
      return new Set((holding.buildings.list ?? []).flatMap((building) => building.assignedWorkerIds ?? []).map(String));
    },

    _storageRooms() {
      return [{ id: "outdoors", label: "Снаружи", source: "base", available: true, unlimited: true, capacity: null, used: 0 }];
    },

    _storageUnitLoad() {
      return 1;
    },

    _storageRoomLabel(_holding, roomId = "outdoors") {
      return roomId === "outdoors" ? "Снаружи" : String(roomId);
    },

    _itemQuantity(row = {}) {
      return Math.max(0, Math.floor(Number(row.qty ?? row.itemData?.system?.quantity ?? 0) || 0));
    },

    _reputationSummary(holding) {
      return { total: Number(holding.overview?.reputation ?? 0) || 0 };
    },

    _constructionCrew(holding, crewId) {
      return (holding.constructionCrews ?? []).find((crew) => String(crew.id) === String(crewId))
        ?? { id: String(crewId ?? ""), name: "Стройбригада", count: 0, dice: 0 };
    },

    async _rollFormulaTotal(formula = "0") {
      const total = Number(String(formula).trim());
      return { total: Number.isFinite(total) ? total : 0, result: String(Number.isFinite(total) ? total : 0) };
    }
  };
}

async function withSeason(season, callback) {
  const hadCalendaria = Object.hasOwn(globalThis, "CALENDARIA");
  const previousCalendaria = globalThis.CALENDARIA;
  globalThis.CALENDARIA = {
    api: {
      getCurrentDateTime: () => ({ year: 1, month: 1, day: 1, hour: 0, minute: 0 }),
      getCurrentSeason: () => season
    }
  };
  try {
    return await callback();
  } finally {
    if (hadCalendaria) globalThis.CALENDARIA = previousCalendaria;
    else delete globalThis.CALENDARIA;
  }
}

async function withSkyholdCalendar(currentMonth, callback) {
  const hadCalendaria = Object.hasOwn(globalThis, "CALENDARIA");
  const previousCalendaria = globalThis.CALENDARIA;
  const months = ["Хладоход", "Теплорост", "Теплоход", "Зноерост", "Зноеход", "Дождерост", "Дождеход", "Хладорост"]
    .map((name, index) => ({ name, numericRepresentation: index + 1 }));
  globalThis.CALENDARIA = {
    api: {
      getActiveCalendar: () => ({ days: { hoursPerDay: 24 }, monthsArray: months }),
      getCurrentDateTime: () => ({ year: 881, month: currentMonth, day: 18, hour: 0, minute: 0 }),
      getCurrentSeason: () => "native-season-must-not-win",
      addHours: (dateTime, hours) => ({ ...dateTime, hour: Number(dateTime.hour ?? 0) + Number(hours ?? 0) })
    }
  };
  try {
    return await callback();
  } finally {
    if (hadCalendaria) globalThis.CALENDARIA = previousCalendaria;
    else delete globalThis.CALENDARIA;
  }
}

export async function checkEconomyCharacterization() {
  const economy = createEconomyHarness();

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "or-worker", name: "Мастер", workAssignment: "or-workshop" }];
    holding.storage.resources = [resource("wood", 2)];
    holding.buildings.list = [builtProductionBuilding("or-workshop", [{
      id: "or-line", active: true, source: "workers", workQd: 1, resourceId: "grain", outputQty: 1,
      expenses: "wood 2 ИЛИ stone 1; wood 1", expenseMode: "cycle"
    }], { assignedWorkerIds: ["or-worker"] })];
    let collected = false;
    await runProductionCycle({ holding, qd: 1, report: reportShape(), budgets: new Map(),
      workerContext: economy._economyWorkerContext(holding), dependencies: {
        ...economy._productionCycleDependencies(),
        tryCollectResourceForConsumer: async (_holding, _building, id) => {
          if (id === "stone" && !collected) { holding.storage.resources.push(resource("stone", 1)); collected = true; }
        }
      } });
    assert.equal(collected, true, "Autocollection must consider the whole recipe, not just the locally affordable OR group");
    assert.equal(quantity(holding, "wood"), 1);
    assert.equal(quantity(holding, "stone"), 0);
    assert.equal(quantity(holding, "grain"), 1, "One complete funded alternative produces exactly one cycle");
  }

  {
    const holding = makeHolding();
    holding.storage.resources = [resource("wood", 2), resource("stone", 4)];
    holding.buildings.list = [builtProductionBuilding("or-time", [{
      id: "or-time-line", active: true, source: "time", period: "day", workQd: 1, resourceId: "grain", outputQty: 2,
      expenses: "wood 1 ИЛИ stone 2; wood 1 # на единицу", expenseMode: "unit"
    }])];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "wood"), 0);
    assert.equal(quantity(holding, "stone"), 0, "Each OR alternative scales by output units before selection and payment");
    assert.equal(quantity(holding, "grain"), 2);
  }

  {
    const line = normalizeProductionLine({
      id: "fractional-line",
      resourceId: "wood",
      outputQty: 1.8,
      workQd: 1.2,
      collectQd: 1.2,
      pendingQty: 2.9
    });
    assert.equal(line.outputQty, 1, "canonical production output must floor fractional quantities");
    assert.equal(line.workQd, 2, "canonical production work QD must round up");
    assert.equal(line.collectQd, 2, "canonical collection QD must round up");
    assert.equal(line.pendingQty, 2, "canonical pending output must floor fractional quantities");
    const building = {
      id: "fractional-building",
      productionLines: [{ resourceId: "wood", outputQty: 1.8, workQd: 1.2, collectQd: 1.2, pendingQty: 2.9 }],
      materialCosts: [{ resourceId: "wood", name: "Wood", qty: 1.2 }],
      contents: [{ id: "fractional-content", name: "Livestock", qty: 1.8 }]
    };
    normalizeBuilding(building);
    assert.equal(building.productionLines[0].outputQty, 1);
    assert.equal(building.productionLines[0].workQd, 2);
    assert.equal(building.productionLines[0].collectQd, 2);
    assert.equal(building.productionLines[0].pendingQty, 2);
    assert.equal(building.materialCosts[0].qty, 2, "positive construction costs must round up");
    assert.equal(building.contents[0].qty, 1, "building content quantities must round down");
    assert.equal(normalizeEconomyLedgerEntry({ qty: -1.8 }).qty, -1, "signed economy ledger quantities must truncate toward zero");

    const brokenReservation = builtProductionBuilding("broken-reservation", [{
      id: "broken-reservation-line",
      source: "workers",
      workQd: 2,
      resourceId: "stone",
      outputQty: 1,
      workInputsReserved: true,
      workReservedOutputQty: 0,
      workProgressUnits: 5_000,
      workReservedFormula: "stale"
    }]);
    normalizeBuilding(brokenReservation);
    assert.deepEqual(
      [
        brokenReservation.productionLines[0].workInputsReserved,
        brokenReservation.productionLines[0].workReservedOutputQty,
        brokenReservation.productionLines[0].workProgressUnits,
        brokenReservation.productionLines[0].workReservedFormula
      ],
      [false, 0, 0, ""],
      "normalization must discard an impossible reservation with no whole output"
    );
  }

  {
    const sourceHolding = makeHolding();
    sourceHolding.buildings.list = [builtProductionBuilding("engine-contract", [{
      id: "engine-contract-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "stone",
      outputQty: 2
    }])];
    const directHolding = clone(sourceHolding);
    const wrapperHolding = clone(sourceHolding);
    const directReport = { ...reportShape(), periodQd: 4, periodLabel: "1 день" };
    const wrapperReport = clone(directReport);
    const directWorkerContext = economy._economyWorkerContext(directHolding);
    const wrapperWorkerContext = economy._economyWorkerContext(wrapperHolding);
    await runProductionCycle({
      holding: directHolding,
      qd: 4,
      report: directReport,
      budgets: new Map(),
      workerContext: directWorkerContext,
      dependencies: economy._productionCycleDependencies()
    });
    await economy._runProductionCycleForQd(wrapperHolding, 4, wrapperReport, {
      budgets: new Map(),
      workerContext: wrapperWorkerContext
    });
    assert.deepEqual(comparableEconomyDraft(wrapperHolding), comparableEconomyDraft(directHolding), "FinanceDomain production wrapper must preserve the direct engine draft result");
    assert.deepEqual(wrapperReport, directReport, "FinanceDomain production wrapper must preserve the direct engine report result");
  }

  {
    const holding = makeHolding();
    holding.buildings.list = [builtProductionBuilding("time-quarry", [{
      id: "stone-time",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "stone",
      resource: "Stone",
      outputQty: 3,
      storageRoomId: "outdoors"
    }])];
    const report = await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 3, "time production must fire after a complete configured period");
    assert.equal(report.produced.some((line) => /Stone \+3/.test(line)), true, "time production must be recorded in the report");
    assert.equal(report.ledger.some((row) => row.domain === "production" && row.resourceId === "stone" && row.qty === 3), true, "production must emit an exact positive ledger entry");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "fractional-worker", name: "Работник", workAssignment: "fractional-runtime", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.storage.resources = [resource("wood", 2, { name: "Wood" })];
    holding.buildings.list = [builtProductionBuilding("fractional-runtime", [{
      id: "fractional-runtime-line",
      active: true,
      source: "workers",
      workQd: 1.2,
      resourceId: "stone",
      outputQty: 1.8,
      expenses: "Wood 1.2",
      expenseMode: "cycle"
    }], { assignedWorkerIds: ["fractional-worker"] })];
    const report = await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 1, "a 1.8 runtime output must create exactly one resource unit");
    assert.equal(quantity(holding, "wood"), 0, "a 1.2 positive recipe cost must consume two resource units");
    assert.equal(holding.storage.resources.every((row) => Number.isInteger(row.qty)), true, "production must leave only whole storage quantities");
    assert.equal(report.ledger.every((row) => Number.isInteger(row.qty)), true, "production must emit only whole signed ledger quantities");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "worker", name: "Работник", workAssignment: "worker-mill", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.buildings.list = [builtProductionBuilding("worker-mill", [{
      id: "stone-workers",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      resource: "Stone",
      outputQty: 2,
      storageRoomId: "outdoors"
    }], { assignedWorkerIds: ["worker"] })];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 4, "one worker must spend the normal two daily work QD on production");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{
      id: "split-volunteer",
      name: "Разделённый доброволец",
      attributes: { strength: 3, agility: 3, wits: 3, empathy: 3 },
      workAssignment: "",
      workAllocationMode: "explicit",
      workAllocations: [
        { id: "split-wood", sourceId: "split-lumber", functionId: "production:wood-line", normalQd: 10, overtimeQd: 0 },
        { id: "split-stone", sourceId: "split-quarry", functionId: "production:stone-line", normalQd: 10, overtimeQd: 0 }
      ],
      volunteerLabor: true,
      volunteerReason: ""
    }];
    holding.buildings.list = [
      builtProductionBuilding("split-lumber", [{
        id: "wood-line",
        active: true,
        source: "workers",
        workQd: 1,
        resourceId: "wood",
        resource: "Wood",
        outputQty: 1,
        wageDailyCopper: 12,
        storageRoomId: "outdoors"
      }], { name: "Лесоповал", workersMax: 1, wageDailyCopper: 12, assignedWorkerIds: [] }),
      builtProductionBuilding("split-quarry", [{
        id: "stone-line",
        active: true,
        source: "workers",
        workQd: 1,
        resourceId: "stone",
        resource: "Stone",
        outputQty: 1,
        wageDailyCopper: 12,
        storageRoomId: "outdoors"
      }], { name: "Малая каменоломня", workersMin: 1, workersMax: 2, wageDailyCopper: 12, assignedWorkerIds: [] })
    ];
    const report = await economy._runEconomyForQd(holding, 40);
    assert.equal(quantity(holding, "wood"), 10, "an explicit 10-QD lumber allocation must produce its full integer output");
    assert.equal(quantity(holding, "stone"), 10, "an explicit 10-QD allocation produces when the configured mandatory minimum is met");
    assert.deepEqual(report.finance.invalidWorkerIds, [], "the volunteer checkbox must be a complete labor agreement even when its optional note is blank");
    assert.equal(report.skipped.some((line) => /добровольн|дневн.*ставк/i.test(line)), false, "a valid blank-note volunteer must not be blocked by finance");
    const splitWorkLines = report.work.filter((line) => /Лесоповал|Малая каменоломня/.test(line));
    assert.equal(splitWorkLines.length, 2, "worker production must emit one aggregate work row per line instead of one row per QD");
    assert.equal(splitWorkLines.every((line) => /затрачено 10 QD/.test(line)), true);
    assert.equal(report.work.some((line) => /10000|ед\. работы/i.test(line)), false, "player-facing reports must not expose internal work units");
  }

  {
    const holding = makeHolding();
    holding.people.list = ["worker-a", "worker-b"].map((id) => ({
      id,
      name: id,
      workAssignment: "scaled-mill",
      volunteerLabor: true,
      volunteerReason: "characterization fixture"
    }));
    holding.buildings.list = [builtProductionBuilding("scaled-mill", [{
      id: "scaled-workers",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      resource: "Stone",
      outputQty: 2,
      storageRoomId: "outdoors"
    }], { workersMin: 1, workersMax: 2, assignedWorkerIds: ["worker-a", "worker-b"] })];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 8, "two ordinary workers must produce exactly twice the one-worker output when no other bottleneck applies");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "worker", name: "Работник", workAssignment: "understaffed-mill", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.buildings.list = [builtProductionBuilding("understaffed-mill", [{
      id: "understaffed-workers",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      resource: "Stone",
      outputQty: 2,
      storageRoomId: "outdoors"
    }], { workersMin: 2, workersMax: 4, assignedWorkerIds: ["worker", "", "", ""] })];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 0, "the approved mandatory minimum must stop an understaffed production team");
  }

  {
    const holding = makeHolding();
    holding.storage.resources = [resource("wood", 5)];
    holding.buildings.list = [builtProductionBuilding("cycle-cost", [{
      id: "cycle-cost-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Wood 2",
      expenseMode: "cycle"
    }])];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "wood"), 3, "cycle expenses must be charged once per production cycle");
    assert.equal(quantity(holding, "stone"), 4, "cycle expenses must not scale with output units");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "master", name: "Мастер", workAssignment: "efficient-cycle" }];
    holding.storage.resources = [resource("wood", 4)];
    holding.buildings.list = [builtProductionBuilding("efficient-cycle", [{
      id: "efficient-cycle-line",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Wood 2",
      expenseMode: "cycle"
    }], { assignedWorkerIds: ["master"] })];
    const report = reportShape();
    const workerContext = economy._economyWorkerContext(holding);
    await runProductionCycle({
      holding,
      qd: 1,
      report,
      budgets: new Map(),
      workerContext,
      dependencies: {
        ...economy._productionCycleDependencies(),
        personBuildingEfficiency: () => 2
      }
    });
    assert.equal(quantity(holding, "stone"), 8, "efficiency two must double a worker cycle's throughput");
    assert.equal(quantity(holding, "wood"), 0, "cycle inputs must scale with efficiency-driven output instead of creating material");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "qualified", name: "Квалифицированный", workAssignment: "qualified-cycle" }];
    holding.storage.resources = [resource("wood", 4)];
    holding.buildings.list = [builtProductionBuilding("qualified-cycle", [{
      id: "qualified-cycle-line",
      active: true,
      source: "workers",
      workQd: 2,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Wood 2",
      expenseMode: "cycle"
    }], { assignedWorkerIds: ["qualified"] })];
    const line = holding.buildings.list[0].productionLines[0];
    const dependencies = {
      ...economy._productionCycleDependencies(),
      personBuildingEfficiency: () => 1.25
    };
    await runProductionCycle({ holding, qd: 1, report: reportShape(), budgets: new Map(), workerContext: economy._economyWorkerContext(holding), dependencies });
    assert.equal(quantity(holding, "stone"), 0, "qualified work must not emit a fractional or unfinished batch");
    assert.equal(quantity(holding, "wood"), 2, "the first funded batch must reserve its complete cycle input before work begins");
    assert.deepEqual(
      [line.workProgressUnits, line.workInputsReserved, line.workReservedOutputQty],
      [12_500, true, 4],
      "a +25-percent QD must persist exact integer progress and its funded output reservation"
    );
    await runProductionCycle({ holding, qd: 1, report: reportShape(), budgets: new Map(), workerContext: economy._economyWorkerContext(holding), dependencies });
    assert.equal(quantity(holding, "stone"), 4, "the second qualified QD must release exactly one whole funded batch");
    assert.equal(quantity(holding, "wood"), 0, "carried excess work may enter the next batch only after reserving its full inputs");
    assert.deepEqual(
      [line.workProgressUnits, line.workInputsReserved, line.workReservedOutputQty],
      [5_000, true, 4],
      "funded excess work must carry into the next batch without creating fractional goods"
    );
  }

  {
    const holding = makeHolding();
    const person = {
      id: "split-qualified",
      name: "Сильный специалист",
      workAllocationMode: "explicit",
      workAllocations: [],
      attributes: { strength: 5, agility: 3, wits: 3, empathy: 3 }
    };
    const building = builtProductionBuilding("split-qualified-workshop", [
      { id: "short-order", active: true, source: "workers", workQd: 10, resourceId: "stone", outputQty: 2 },
      { id: "long-order", active: true, source: "workers", workQd: 10, resourceId: "wood", outputQty: 3 }
    ], {
      workersMin: 1,
      workersMax: 1,
      workerProfile: {
        version: 1,
        source: "characterization",
        templateId: "",
        name: "Проверка явного плана",
        stage: 0,
        workersMin: 1,
        workersMax: 1,
        admission: { text: "—", hard: false, clauses: [] },
        suitableSelectors: ["СИЛ"],
        optimalSelectors: [],
        staffingClass: "A",
        composition: [],
        production: { backgroundGroups: [], positiveTraits: [], negativeTraits: [] },
        reason: "characterization"
      }
    });
    holding.people.list = [person];
    holding.buildings.list = [building];
    const assignments = [
      { sourceId: building.id, functionId: "production:short-order", normalQd: 8, overtimeQd: 0, dailyRateCopper: 0 },
      { sourceId: building.id, functionId: "production:long-order", normalQd: 12, overtimeQd: 0, dailyRateCopper: 0 }
    ];
    const financeContext = economy._financeExecutionContext(
      { blockers: { workers: {}, buildings: {} }, invalidWorkerIds: [] },
      { plannedWorkers: [{ id: person.id, assignments }], periodQd: 40 }
    );
    const workerContext = economy._economyWorkerContext(holding, { financeContext });
    await runProductionCycle({
      holding,
      qd: 40,
      report: reportShape(),
      budgets: new Map(),
      workerContext,
      dependencies: economy._productionCycleDependencies({ financeContext })
    });
    assert.equal(quantity(holding, "stone"), 2, "eight QD assigned to the short order must complete it only through the worker's +25-percent qualification");
    assert.equal(quantity(holding, "wood"), 3, "the second function must receive only its own twelve allocated QD and complete one whole batch");
    assert.equal(building.productionLines[0].workProgressUnits, 0, "the first function must not borrow or retain QD from the second function");
    assert.equal(building.productionLines[1].workProgressUnits, 50_000, "qualification work beyond a whole batch must remain exact integer progress on the correct function");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "qualified", name: "Квалифицированный", workAssignment: "unfunded-carry" }];
    holding.storage.resources = [resource("wood", 2)];
    holding.buildings.list = [builtProductionBuilding("unfunded-carry", [{
      id: "unfunded-carry-line",
      active: true,
      source: "workers",
      workQd: 2,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Wood 2",
      expenseMode: "cycle"
    }], { assignedWorkerIds: ["qualified"] })];
    const line = holding.buildings.list[0].productionLines[0];
    const dependencies = {
      ...economy._productionCycleDependencies(),
      personBuildingEfficiency: () => 1.25
    };
    await runProductionCycle({ holding, qd: 1, report: reportShape(), budgets: new Map(), workerContext: economy._economyWorkerContext(holding), dependencies });
    const secondReport = reportShape();
    await runProductionCycle({ holding, qd: 1, report: secondReport, budgets: new Map(), workerContext: economy._economyWorkerContext(holding), dependencies });
    assert.equal(quantity(holding, "stone"), 4, "the funded first batch must still complete when the next one is unaffordable");
    assert.deepEqual(
      [line.workProgressUnits, line.workInputsReserved, line.workReservedOutputQty],
      [0, false, 0],
      "unfunded excess work must idle instead of becoming banked progress in a nonexistent batch"
    );
    assert.equal(secondReport.skipped.some((entry) => /остаток QD простаивает/.test(entry)), true, "the discarded unfunded remainder must be visible in the economy report");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "worker", name: "Работник", workAssignment: "unit-cost", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.storage.resources = [resource("wood", 3)];
    holding.buildings.list = [builtProductionBuilding("unit-cost", [{
      id: "unit-cost-line",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Wood 1",
      expenseMode: "unit"
    }], { assignedWorkerIds: ["worker"] })];
    const report = await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "wood"), 3, "an underfunded unit-cost batch must not reserve or consume a partial input set");
    assert.equal(quantity(holding, "stone"), 0, "worker production must emit only a complete funded batch, never an affordable fraction");
    assert.equal(report.skipped.some((line) => /не хватает .* для новой партии/.test(line)), true, "an unaffordable whole batch must be reported");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "cook", name: "Повар", workAssignment: "group-cost", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.storage.resources = [resource("milk", 2, { name: "Milk" }), resource("meat", 1, { name: "Meat" })];
    holding.buildings.list = [builtProductionBuilding("group-cost", [{
      id: "edible-group-line",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      outputQty: 4,
      expenses: "Milk 2; Meat 1",
      expenseMode: "cycle"
    }], { assignedWorkerIds: ["cook"] })];
    const report = await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "milk"), 0, "an explicit milk expense must consume only matching milk stock");
    assert.equal(quantity(holding, "meat"), 0, "an explicit meat expense must consume only matching meat stock");
    assert.equal(quantity(holding, "stone"), 4, "a payable explicit cycle expense must allow the full production output");
    assert.match(report.consumed.join("\n"), /Milk -2/);
    assert.match(report.consumed.join("\n"), /Meat -1/);
  }

  {
    const holding = makeHolding();
    holding.storage.resources = [resource("wood", 1)];
    holding.buildings.list = [builtProductionBuilding("shortage", [{
      id: "shortage-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "stone",
      outputQty: 2,
      expenses: "Wood 2",
      expenseMode: "cycle"
    }])];
    const report = await economy._runEconomyForQd(holding, 4);
    assert.equal(quantity(holding, "stone"), 0, "a cycle with insufficient inputs must not produce output");
    assert.equal(quantity(holding, "wood"), 1, "a rejected cycle must not consume partial inputs");
    assert.equal(report.skipped.some((line) => /не хватает/.test(line)), true, "input shortage must be visible in the report");
  }

  {
    const holding = makeHolding();
    const line = {
      id: "pending-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "grain",
      outputQty: 3,
      requiresCollection: true,
      pendingQty: 0,
      autoCollect: "none"
    };
    holding.buildings.list = [builtProductionBuilding("pending-farm", [line])];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(line.pendingQty, 3, "requiresCollection output must accumulate in pendingQty");
    assert.equal(quantity(holding, "grain"), 0, "uncollected output must not appear in storage");
  }

  {
    const holding = makeHolding();
    const line = {
      id: "building-auto-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "grain",
      outputQty: 3,
      requiresCollection: true,
      pendingQty: 0,
      collectQd: 0,
      autoCollect: "building"
    };
    holding.buildings.list = [builtProductionBuilding("auto-farm", [line])];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(line.pendingQty, 0, "building auto-collect must clear pending output");
    assert.equal(quantity(holding, "grain"), 3, "building auto-collect must move output to storage");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "consumer-worker", name: "Мельник", workAssignment: "consumer", volunteerLabor: true, volunteerReason: "characterization fixture" }];
    const sourceLine = {
      id: "worker-auto-source",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "wood",
      outputQty: 2,
      requiresCollection: true,
      pendingQty: 0,
      collectQd: 0,
      autoCollect: "worker"
    };
    const consumerLine = {
      id: "worker-auto-consumer",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "stone",
      outputQty: 1,
      expenses: "Wood 1",
      expenseMode: "cycle"
    };
    holding.buildings.list = [
      builtProductionBuilding("source", [sourceLine]),
      builtProductionBuilding("consumer", [consumerLine], { assignedWorkerIds: ["consumer-worker"] })
    ];
    await economy._runEconomyForQd(holding, 4);
    assert.equal(sourceLine.pendingQty, 0, "worker auto-collect must clear matching source pending output");
    assert.equal(quantity(holding, "stone"), 2, "consumer workers must use auto-collected inputs in the same QD");
    assert.equal(quantity(holding, "wood"), 0, "auto-collected inputs must be consumed by the requesting worker line");
  }

  {
    const holding = makeHolding();
    holding.people.list = [
      { id: "tavern-worker", name: "Трактирщик", workAssignment: "tavern", volunteerLabor: true, volunteerReason: "characterization fixture" },
      { id: "resident", name: "Житель" }
    ];
    const milkLine = {
      id: "pasture-milk",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "milk",
      outputQty: 2,
      requiresCollection: true,
      pendingQty: 0,
      collectQd: 0,
      autoCollect: "worker"
    };
    const foodLine = {
      id: "tavern-food",
      active: true,
      source: "workers",
      workQd: 1,
      resourceId: "food-dairy",
      outputQty: 1,
      expenses: "Milk 1",
      expenseMode: "cycle"
    };
    holding.buildings.list = [
      builtProductionBuilding("pasture", [milkLine], { name: "Пастбище" }),
      builtProductionBuilding("tavern", [foodLine], { name: "Таверна", assignedWorkerIds: ["tavern-worker"], workersMin: 1 })
    ];
    const readiness = await economy._tendayReadinessContext(holding);
    assert.equal(readiness.foodStored, 0, "tenday readiness must distinguish current food reserves from forecast output");
    assert.equal(readiness.foodProduced, 20, "tenday readiness must forecast food produced through worker auto-collection chains");
    assert.equal(readiness.foodAvailable, 20, "tenday readiness must include forecast food before comparing it with demand");
    assert.equal(readiness.alerts.some((alert) => alert.key === "food"), false, "forecast production that covers demand must clear the food shortage alert");
  }

  {
    const sourceHolding = makeHolding();
    sourceHolding.people.list = [{ id: "one" }, { id: "two" }, { id: "dead", dead: true }, { id: "injured", injuredDays: 1 }];
    sourceHolding.storage.resources = [
      resource("grain", 2, { name: "Grain" }),
      resource("flour", 2, { name: "Flour" }),
      resource("meat", 2, { name: "Meat" }),
      resource("milk", 2, { name: "Milk" }),
      resource("fruits", 2, { name: "Fruits" }),
      resource("vegetables", 2, { name: "Vegetables" }),
      resource("honey", 2, { name: "Honey" }),
      resource("food-fruit", 4, { name: "Food (Fruit)", noAutoConsume: true }),
      resource("bread", 2, { name: "Bread" }),
      resource("food-protein", 2, { name: "Готовая пища (белковая)" }),
      resource("food-dairy", 2, { name: "Food (Dairy)" }),
      resource("stone", 10, { name: "Stone" })
    ];
    const directHolding = clone(sourceHolding);
    const wrapperHolding = clone(sourceHolding);
    const directReport = reportShape();
    const wrapperReport = clone(directReport);
    const dependencies = economy._foodConsumptionDependencies();
    const directFood = runFoodConsumption({ holding: directHolding, qd: 8, report: directReport, dependencies });
    const wrapperFood = economy._runFoodConsumptionForQd(wrapperHolding, 8, wrapperReport);
    assert.deepEqual(wrapperFood, directFood, "FinanceDomain food wrapper must preserve the direct engine result");
    assert.deepEqual(wrapperHolding, directHolding, "FinanceDomain food wrapper must preserve the direct engine draft");
    assert.deepEqual(wrapperReport, directReport, "FinanceDomain food wrapper must preserve the direct engine report");
    assert.deepEqual(directFood, {
      needed: 6,
      minimumNeeded: 3,
      eaten: 6,
      hungryResidentDays: 0,
      availableBeforeConsumption: 6,
      selectedUnits: 10,
      selectedTier: "normal",
      effectiveTier: "normal",
      fallback: false,
      dietTypes: ["grain", "protein", "dairy"],
      effectiveUnits: 10,
      rationModifier: 0,
      diversityBonus: 2,
      nutritionDeficitDays: 0,
      hungerLevel: 0,
      hungerFactor: 1
    }, "food consumption must count every living resident-day, including injured residents and report the ration outcome");
    assert.equal(quantity(directHolding, "bread"), 0, "food consumption must reduce edible storage rows");
    assert.equal(quantity(directHolding, "food-protein"), 0, "prepared protein food must be consumed");
    assert.equal(quantity(directHolding, "food-dairy"), 0, "prepared dairy food must be consumed");
    for (const rawResourceId of ["grain", "flour", "meat", "milk", "fruits", "vegetables", "honey"]) {
      assert.equal(quantity(directHolding, rawResourceId), 2, `raw food input ${rawResourceId} must not be auto-consumed`);
      assert.equal(isFoodResource({ resourceId: rawResourceId, name: rawResourceId }, dependencies), false, `raw food input ${rawResourceId} must not be edible`);
    }
    assert.equal(isFoodResource({ resourceId: "grain", foodEdible: true, foodType: "grain" }, dependencies), false, "stale storage metadata must not make a known raw resource edible");
    assert.equal(quantity(directHolding, "food-fruit"), 4, "row-level noAutoConsume must protect prepared food");
    assert.equal(quantity(directHolding, "stone"), 10, "food consumption must preserve non-food resources");
    assert.equal(directReport.ledger.some((row) => row.domain === "food" && row.resourceId === "bread" && row.qty === -2), true, "food consumption must emit the exact consumed storage row");
    assert.equal(isFoodResource({ resourceId: "custom", name: "Походная еда" }, dependencies), false, "food-like custom names must not bypass explicit food metadata");
    assert.equal(isFoodResource({ resourceId: "custom", name: "Паёк", foodEdible: true }, dependencies), true, "row-level foodEdible must explicitly opt a custom resource into consumption");
    assert.equal(isFoodResource({ resourceId: "food-protein", noAutoConsume: true }, dependencies), false, "row-level noAutoConsume must override edible catalog metadata");
    assert.equal(isFoodResource({ resourceId: "protected-food" }, {
      ...dependencies,
      normalizeResourceId: () => "protected-food",
      resourceDef: () => ({ foodEdible: true, noAutoConsume: true })
    }), false, "definition-level noAutoConsume must protect an edible resource");
  }

  {
    const holding = makeHolding();
    holding.people.list = [{ id: "keeper", name: "Управляющий", dead: false, volunteerLabor: true, volunteerReason: "characterization fixture" }];
    holding.buildings.list = [{
      id: "passive-income",
      name: "Доходное здание",
      constructionStatus: "built",
      functions: { production: false, income: true },
      assignedWorkerIds: ["keeper"],
      income: { base: 100, perWorker: 0, trade: { enabled: false } }
    }];
    const report = await economy._runEconomyForQd(holding, 40);
    assert.equal(holding.storage.moneyCopper, 100, "staffed income must be credited for each complete tenday");
    assert.equal(report.income.some((line) => /Деньги \+100/.test(line)), true, "staffed income must be recorded in the report");

    const unstaffed = makeHolding();
    unstaffed.buildings.list = [{ ...holding.buildings.list[0], assignedWorkerIds: [] }];
    const unstaffedReport = await economy._runEconomyForQd(unstaffed, 40);
    assert.equal(unstaffed.storage.moneyCopper, 0, "an unstaffed income building must not create money");
    assert.equal(unstaffedReport.skipped.includes("Доходное здание: доход не получен — работник не назначен."), true, "unstaffed income must explain why it was skipped");

    const unavailable = makeHolding();
    unavailable.people.list = [{ id: "keeper", name: "Управляющий", dead: true }];
    unavailable.buildings.list = [{ ...holding.buildings.list[0] }];
    await economy._runEconomyForQd(unavailable, 40);
    assert.equal(unavailable.storage.moneyCopper, 0, "a dead assigned resident must not unlock passive building income");
  }

  {
    const sourceHolding = makeHolding();
    sourceHolding.overview.reputation = 1;
    sourceHolding.storage.resources = [resource("wood", 2, { name: "Wood", cost: "10 C", forSale: true })];
    sourceHolding.people.list = [{ id: "merchant", name: "Торговец", dead: false }];
    sourceHolding.buildings.list = [{
      id: "shop",
      name: "Лавка",
      constructionStatus: "built",
      functions: { production: false, income: true },
      assignedWorkerIds: ["merchant"],
      income: {
        base: 0,
        perWorker: 0,
        trade: { enabled: true, budgetFormula: "100", maxLotsPerBuyer: 1, kind: "resources", roomId: "all" }
      }
    }];
    const directHolding = clone(sourceHolding);
    const wrapperHolding = clone(sourceHolding);
    const directReport = reportShape();
    const wrapperReport = clone(directReport);
    const random = () => 0.999;
    const unstaffedHolding = clone(sourceHolding);
    unstaffedHolding.buildings.list[0].assignedWorkerIds = [];
    const unstaffedReport = reportShape();
    const unstaffedTrade = await runTrade({
      holding: unstaffedHolding,
      qd: 4,
      report: unstaffedReport,
      workerContext: economy._economyWorkerContext(unstaffedHolding),
      dependencies: economy._tradeDependencies({ random })
    });
    assert.deepEqual(unstaffedTrade, { sold: 0, buyers: 0, revenue: 0 }, "a trade building without an assigned worker must not sell stock");
    assert.equal(unstaffedReport.skipped.includes("Торговля: ни в одном торговом здании не назначен работник."), true, "unstaffed trade must explain why it was skipped");

    const unavailableHolding = clone(sourceHolding);
    unavailableHolding.people.list[0].injuredDays = 1;
    const unavailableTrade = await runTrade({
      holding: unavailableHolding,
      qd: 4,
      report: reportShape(),
      workerContext: economy._economyWorkerContext(unavailableHolding),
      dependencies: economy._tradeDependencies({ random })
    });
    assert.deepEqual(unavailableTrade, { sold: 0, buyers: 0, revenue: 0 }, "an injured assigned resident must not operate a trade building");

    const directTrade = await runTrade({
      holding: directHolding,
      qd: 4,
      report: directReport,
      workerContext: economy._economyWorkerContext(directHolding),
      dependencies: economy._tradeDependencies({ random })
    });
    const wrapperTrade = await economy._runTradeForQd(
      wrapperHolding,
      4,
      wrapperReport,
      economy._economyWorkerContext(wrapperHolding),
      { random }
    );
    assert.deepEqual(wrapperTrade, directTrade, "FinanceDomain trade wrapper must preserve the direct engine result");
    assert.deepEqual(wrapperHolding, directHolding, "FinanceDomain trade wrapper must preserve the direct engine draft");
    assert.deepEqual(wrapperReport, directReport, "FinanceDomain trade wrapper must preserve the direct engine report");
    assert.equal(economy._resourcePriceCopper(sourceHolding.storage.resources[0]), 4, "a stale storage-row cost must not override the canonical resource price");
    assert.deepEqual(directTrade, { sold: 2, buyers: 1, revenue: 4 }, "deterministic staffed trade must sell affordable marked stock at the canonical resource price");
    assert.equal(quantity(directHolding, "wood"), 0, "trade must reduce the sold resource quantity");
    assert.equal(directHolding.storage.moneyCopper, 4, "trade revenue must be credited to treasury");
    assert.equal(directReport.ledger.some((row) => row.domain === "trade" && row.kind === "resource" && row.qty === -2), true, "trade must ledger the sold stock");
    assert.equal(directReport.ledger.some((row) => row.domain === "trade" && row.kind === "money" && row.qty === 4), true, "trade must ledger the credited revenue");

    const noReputationHolding = clone(sourceHolding);
    noReputationHolding.overview.reputation = 0;
    const noReputationReport = reportShape();
    const noReputationTrade = await runTrade({
      holding: noReputationHolding,
      qd: 4,
      report: noReputationReport,
      workerContext: economy._economyWorkerContext(noReputationHolding),
      dependencies: economy._tradeDependencies({ random })
    });
    assert.deepEqual(noReputationTrade, { sold: 0, buyers: 0, revenue: 0 }, "trade without reputation must not create buyers");
    assert.equal(noReputationReport.skipped.includes("Торговля: нет Репутации для поиска покупателей."), true, "trade without reputation must explain why it was skipped");
  }

  {
    const sourceHolding = makeHolding();
    sourceHolding.people.list = [{ id: "paid", salary: 2 }];
    sourceHolding.buildings.list = [{
      id: "upkeep",
      constructionStatus: "built",
      functions: { production: false, income: false },
      upkeep: 30
    }];
    sourceHolding.storage.moneyCopper = 25;
    const directHolding = clone(sourceHolding);
    const wrapperHolding = clone(sourceHolding);
    const directReport = reportShape();
    const wrapperReport = clone(directReport);
    const totals = economy._prepareLegacyTreasuryTotals(directHolding);
    const directTreasury = runTreasuryCosts({
      holding: directHolding,
      qd: 40,
      totals,
      report: directReport,
      dependencies: economy._treasuryCostDependencies()
    });
    const wrapperTreasury = economy._runTreasuryCostsForQd(wrapperHolding, 40, wrapperReport);
    assert.deepEqual(wrapperTreasury, directTreasury, "FinanceDomain treasury wrapper must preserve the direct engine result");
    assert.deepEqual(wrapperHolding, directHolding, "FinanceDomain treasury wrapper must preserve the direct engine draft");
    assert.deepEqual(wrapperReport, directReport, "FinanceDomain treasury wrapper must preserve the direct engine report");
    assert.deepEqual(directTreasury, { spent: 25, deficit: 5, salaryCost: 20, upkeepCost: 10 }, "treasury costs must combine tenday salaries and one-third monthly upkeep");
    assert.equal(directHolding.storage.moneyCopper, 0, "treasury costs must never make money negative");
    assert.equal(directReport.ledger.some((row) => row.domain === "treasury" && row.kind === "money" && row.qty === -25), true, "treasury must ledger the exact paid amount");

    const partialPeriodHolding = clone(sourceHolding);
    const partialPeriod = runTreasuryCosts({
      holding: partialPeriodHolding,
      qd: 39,
      totals,
      report: reportShape(),
      dependencies: economy._treasuryCostDependencies()
    });
    assert.deepEqual(partialPeriod, { spent: 0, deficit: 0 }, "treasury costs must ignore incomplete tendays");
    assert.equal(partialPeriodHolding.storage.moneyCopper, 25, "an incomplete tenday must not mutate treasury");
  }

  {
    const sourceHolding = makeHolding();
    sourceHolding.people.list = [
      { id: "builder", name: "Рабочий 1", workAssignment: "construction:crew", attributes: { strength: 4, agility: 3, wits: 3, empathy: 2 } },
      { id: "mason", name: "Рабочий 2", workAssignment: "construction:crew", attributes: { strength: 4, agility: 3, wits: 3, empathy: 2 } },
      { id: "foreman", name: "Руководитель", workAssignment: "construction-leader:crew", attributes: { strength: 3, agility: 3, wits: 4, empathy: 4 }, traitsText: "Лидер" }
    ];
    sourceHolding.constructionCrews = [{ id: "crew", name: "Стройбригада", memberIds: ["builder", "mason"], leaderId: "foreman", count: 2, dice: 1 }];
    sourceHolding.buildings.list = [{
      id: "construction",
      name: "Стройка",
      constructionStatus: "building",
      constructionCrewId: "crew",
      buildDifficulty: 0,
      buildProgress: 0,
      buildTarget: 1
    }];
    const directHolding = clone(sourceHolding);
    const wrapperHolding = clone(sourceHolding);
    const directReport = reportShape();
    const wrapperReport = clone(directReport);
    const rollDice = (count) => Array.from({ length: count }, () => 6);
    const directConstruction = runConstruction({
      holding: directHolding,
      qd: 40,
      report: directReport,
      dependencies: economy._constructionDependencies({ rollDice })
    });
    const wrapperConstruction = economy._runConstructionCrewsForQd(wrapperHolding, 40, wrapperReport, { rollDice });
    assert.deepEqual(wrapperConstruction, directConstruction, "FinanceDomain construction wrapper must preserve the direct engine result");
    assert.deepEqual(wrapperHolding, directHolding, "FinanceDomain construction wrapper must preserve the direct engine draft");
    assert.deepEqual(wrapperReport, directReport, "FinanceDomain construction wrapper must preserve the direct engine report");
    assert.deepEqual(directConstruction, { attempts: 1, completed: 1 }, "construction must make one deterministic attempt per complete tenday");
    assert.equal(directHolding.buildings.list[0].constructionStatus, "built", "successful construction must complete the project");
    assert.equal(directReport.ledger.some((row) => row.domain === "construction" && row.kind === "progress" && row.status === "completed"), true, "construction must ledger progress and completion state");

    const partialHolding = clone(sourceHolding);
    const partialConstruction = runConstruction({
      holding: partialHolding,
      qd: 39,
      report: reportShape(),
      dependencies: economy._constructionDependencies({ rollDice })
    });
    assert.deepEqual(partialConstruction, { attempts: 0, completed: 0 }, "construction must ignore incomplete tendays");
    assert.equal(partialHolding.buildings.list[0].buildProgress, 0, "an incomplete tenday must not mutate construction progress");

    const emptyCrewHolding = clone(sourceHolding);
    emptyCrewHolding.constructionCrews[0].count = 0;
    const emptyCrewReport = reportShape();
    const emptyCrewResult = runConstruction({
      holding: emptyCrewHolding,
      qd: 40,
      report: emptyCrewReport,
      dependencies: economy._constructionDependencies({ rollDice })
    });
    assert.deepEqual(emptyCrewResult, { attempts: 0, completed: 0 }, "an empty construction crew must not roll or advance");
    assert.equal(emptyCrewReport.construction.lines.some((line) => /стройбригада пуста/.test(line)), true, "an empty construction crew must be reported");
  }

  {
    const line = {
      id: "season-line",
      active: true,
      source: "time",
      period: "day",
      workQd: 1,
      resourceId: "grain",
      outputQty: 2,
      seasons: { spring: true, summer: true, autumn: false, winter: false }
    };
    const winterHolding = makeHolding();
    winterHolding.buildings.list = [builtProductionBuilding("season-farm", [clone(line)])];
    await withSeason("Winter", () => economy._runEconomyForQd(winterHolding, 4));
    assert.equal(quantity(winterHolding, "grain"), 0, "a disabled production season must suppress the line");

    const summerHolding = makeHolding();
    summerHolding.buildings.list = [builtProductionBuilding("season-farm", [clone(line)])];
    await withSeason("Summer", () => economy._runEconomyForQd(summerHolding, 4));
    assert.equal(quantity(summerHolding, "grain"), 2, "an enabled production season must allow the line");

    const staleWinterHolding = makeHolding();
    staleWinterHolding.gm.calendaria.lastDateTime = { year: 881, month: 7, day: 18, hour: 0, minute: 0 };
    staleWinterHolding.buildings.list = [builtProductionBuilding("season-farm", [clone(line)])];
    await withSkyholdCalendar(3, () => economy._runEconomyForQd(staleWinterHolding, 4));
    assert.equal(quantity(staleWinterHolding, "grain"), 0, "settlement winter must suppress the line even when the current world date is summer");

    const staleSummerHolding = makeHolding();
    staleSummerHolding.gm.calendaria.lastDateTime = { year: 881, month: 3, day: 18, hour: 0, minute: 0 };
    staleSummerHolding.buildings.list = [builtProductionBuilding("season-farm", [clone(line)])];
    await withSkyholdCalendar(7, () => economy._runEconomyForQd(staleSummerHolding, 4));
    assert.equal(quantity(staleSummerHolding, "grain"), 2, "settlement summer must allow the line even when the current world date is winter");
  }

  {
    const rawReport = {
      ...reportShape(),
      produced: ["Мельница: Flour +2 → Снаружи.", "Мельница: Flour +3 → Снаружи."],
      consumed: ["Мельница: Grain -1.", "Мельница: Grain -2."],
      income: ["Лавка: Деньги +10."],
      skipped: ["Нет сырья.", "Нет сырья."],
      food: { needed: 2, eaten: 1, hungryResidentDays: 1, lines: [] },
      construction: { attempts: 1, completed: 1, lines: ["Стройка завершена."] },
      trade: { buyers: 1, sold: 2, revenue: 10, purchases: [{ item: "Wood", qty: 2, revenue: 10 }] },
      treasury: { spent: 5, deficit: 1, lines: ["Расходы."] }
    };
    const dependencies = economy._economyReportDependencies();
    const summarized = summarizeEconomyReport(rawReport, dependencies);
    assert.deepEqual(economy._summarizeEconomyReport(rawReport), summarized, "FinanceDomain report wrapper must preserve the pure engine contract");
    assert.equal(summarized.produced.some((line) => /Flour \+5/.test(line)), true, "report summary must aggregate produced rows");
    assert.equal(summarized.consumed.some((line) => /Grain -3/.test(line)), true, "report summary must aggregate consumed rows");
    assert.equal(summarized.foodSummary.hasRows, true, "report summary must expose the food section");
    assert.equal(summarized.constructionSummary.hasRows, true, "report summary must expose the construction section");
    assert.equal(summarized.tradeSummary.hasRows, true, "report summary must expose the trade section");
    assert.equal(summarized.treasurySummary.hasRows, true, "report summary must expose the treasury section");
    assert.deepEqual(summarized.skipped, ["Нет сырья. ×2"], "report summary must collapse repeated skipped reasons");
  }

  {
    const ledger = [{
      domain: "food",
      kind: "resource",
      resourceId: "bread",
      name: "Bread",
      qty: -3,
      roomId: "pantry",
      source: "Питание"
    }, {
      domain: "trade",
      kind: "item",
      itemId: "Item.test",
      name: "Rope",
      qty: -2,
      roomId: "warehouse",
      source: "Лавка"
    }, {
      domain: "trade",
      kind: "money",
      resourceId: "money",
      name: "Выручка",
      qty: 10,
      roomId: "treasury",
      source: "Лавка"
    }, {
      domain: "treasury",
      kind: "money",
      resourceId: "money",
      name: "Расходы казны",
      qty: -5,
      roomId: "treasury",
      source: "Казна"
    }];
    const storageRows = economyLedgerStorageRows(ledger, { operationId: "tenday:test", period: "десятник" });
    assert.deepEqual(storageRows.map((row) => row.kind), ["food", "trade-sale", "income", "expense"], "ledger domains must map to stable storage audit kinds");
    assert.deepEqual(storageRows.map((row) => row.qty), [-3, -2, 10, -5], "storage audit must preserve exact signed quantities without parsing report prose");
    assert.equal(storageRows.every((row) => row.operationId === "tenday:test"), true, "every generated audit row must retain the tenday operation id");

    const payload = buildTendayOperationPayload({
      qd: 40,
      report: { ...reportShape(), ledger },
      changeSet: {}
    });
    assert.equal(payload.schema, 3, "structured economy ledger and morale snapshot must use the current tenday operation schema");
    assert.equal(payload.economy.ledger.total, 4, "tenday history must retain structured ledger rows");
    assert.deepEqual(payload.economy.ledgerTotals, { resourcesIn: 0, resourcesOut: 3, itemsIn: 0, itemsOut: 2, moneyIn: 10, moneyOut: 5, decisions: 0 }, "tenday payload must retain stable ledger totals");
    const restored = hydrateTendayOperation({ operationId: "tenday:test", createdAt: "2026-07-15T00:00:00.000Z", payload }, { holdingId: "holding", holdingName: "Test" });
    assert.equal(restored.historical, true, "saved tenday payload must hydrate into an immutable history model");
    assert.equal(restored.operationId, "tenday:test", "hydrated history must retain the source operation id");
    assert.deepEqual(restored.report.ledger.map((row) => row.qty), [-3, -2, 10, -5], "hydrated history must preserve the exact signed ledger");
  }
}
