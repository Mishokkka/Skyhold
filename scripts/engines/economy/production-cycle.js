import { minimumStaffStatus } from "../workers/minimum-staff.js";
import { politicsRuntimeEffects, politicsProductionOutcome, politicsProductionBonus } from "../politics/runtime-effects.js";
import { productionBatchShelfLifeQd, productionBatchLife, clearProductionBatch } from "./production-batch-life.js";
import { createProductionTiming, productionTiming, productionTimingText, validProductionTiming, PRODUCTION_WORK_UNITS as WORK_UNITS_PER_QD } from "./production-timing.js";
import { makeId } from "../../data/utils.js";
import { productionCapacity, productionBatchStates, productionOccupiedQty, waitingProductionBatches,
  productionBatchCosts, affordableProductionBatch, enqueueProductionBatch, stopProductionAfterDrain } from "./production-capacity.js";
import { createProductionGoalTracker } from "./production-goals.js";

function productionDependencies(dependencies = {}) {
  const required = [
    "safeNumber", "resetWorkerBudgets", "accrueWorkerBudgets", "getSeasonSnapshot", "buildingStatus",
    "buildingFunctions", "lineSeasonAllowed", "periodDueOnStep", "normalizeResourceId", "resourceLabel",
    "lineContentQuantity", "buildingEffectiveWorkers", "lineOutputForCycle", "parseResourceCosts", "costsForUnits",
    "scaledCosts", "storageCanPay", "storagePay", "normalizeStorageRoomId", "storageAddWithOverflow",
    "pushProductionPlacement", "autoCollectBuilding", "assignedBuildingPeople", "workerBudgetEntry",
    "personBuildingEfficiency", "buildingCompositionStatus", "storageQuantity", "tryCollectResourceForConsumer", "formatNumber"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Production cycle requires dependency "${name}".`);
  }
  return dependencies;
}

function whole(value, fallback = 0) {
  const number = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(number) ? number : fallback));
}

export async function runProductionCycle({
  holding,
  qd = 0,
  report,
  buildings = holding?.buildings?.list ?? [],
  budgets = new Map(),
  workerContext = null,
  afterStep = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Production cycle requires a holding draft.");
  if (!report || typeof report !== "object") throw new TypeError("FBL Skyhold | Production cycle requires a mutable report.");
  const deps = productionDependencies(dependencies);
  const periodQd = whole(deps.safeNumber(qd, 0));
  const compositionSkipped = new Set();
  const preparation = createProductionGoalTracker(deps.linePreparationGoal);
  const staffOutputQuotes = new Map();
  const workerLineSummaries = new Map();
  const releasedCapacityThisStep = new Map();
  const workerLineSummary = (building, line, resourceName, workTargetUnits) => {
    const key = `${String(building?.id ?? building?.name ?? "building")}::${String(line?.id ?? line?.resourceId ?? line?.resource ?? "line")}`;
    if (!workerLineSummaries.has(key)) {
      workerLineSummaries.set(key, {
        buildingName: String(building?.name ?? "Здание"),
        resourceName: String(resourceName || "Ресурс"),
        line,
        workTargetUnits,
        qdSpent: 0,
        completedBatches: 0
      });
    }
    return workerLineSummaries.get(key);
  };
  const appendCosts = (building, costs = []) => deps.appendLedger?.(report, costs.map((cost) => ({
    domain: "production",
    kind: deps.normalizeResourceId(cost.resourceId, cost.name) === "money" ? "money" : "resource",
    resourceId: deps.normalizeResourceId(cost.resourceId, cost.name),
    name: cost.name || deps.resourceLabel(cost.resourceId),
    qty: -Math.max(0, Math.ceil(deps.safeNumber(cost.qty, 0))),
    roomId: cost.roomId ?? cost.storageRoomId ?? "",
    sourceId: building?.id,
    source: building?.name || "Здание",
    note: "Сырьё зарезервировано для производственной партии"
  })));

  const placeOutput = (building, line, resourceId, resourceName, total, extra = "") => {
    if (!total) return;
    if (line.requiresCollection) {
      line.pendingQty = whole(line.pendingQty) + total;
      report.produced.push(`${building.name || "Здание"}: ${resourceName} +${total} готово к сбору.`);
      deps.appendLedger?.(report, {
        domain: "production", kind: "progress", resourceId, name: resourceName, qty: total,
        sourceId: building.id, source: building.name || "Здание", status: "pending",
        note: "Готово к сбору; на склад ещё не помещено"
      });
      return;
    }
    const roomId = deps.normalizeStorageRoomId(line.storageRoomId ?? line.roomId);
    const placements = deps.storageAddWithOverflow(holding, { resourceId, name: resourceName, roomId }, total);
    deps.pushProductionPlacement(report, holding, building.name || "Здание", resourceName, placements, extra, resourceId);
  };

  const completeOutput = (building, line, resourceId, resourceName, base, receipt) => {
    const percent = politicsRuntimeEffects(holding)?.productionPercent ?? 0;
    // Old funded batches have no inventory receipt. Finish them by the old rule.
    const outcome = receipt ? politicsProductionOutcome(base, percent, deps.random ?? Math.random)
      : { total: Math.max(0, Math.floor(base * Math.max(0, 1 + percent / 100))), lost: 0 };
    const previous = line.productionBonusRemainder;
    const sameResource = previous?.resourceId === resourceId && (resourceId !== "custom" || previous?.name === resourceName);
    if (previous && !sameResource) delete line.productionBonusRemainder;
    if (receipt && percent > 0) {
      const bonus = politicsProductionBonus(base, percent, sameResource ? previous.units : 0);
      outcome.total = bonus.total;
      line.productionBonusRemainder = { resourceId, name: resourceName, units: bonus.remainderUnits };
    }
    if (outcome.lost && receipt.entries.length) {
      if (typeof deps.refundProductionInputs !== "function") throw new TypeError("Production requires an input refund adapter.");
      const refunds = deps.refundProductionInputs(holding, receipt, outcome.lost, base);
      for (const row of refunds) {
        report.consumed.push(`${building.name || "Здание"}: ${row.name} +${row.qty} возвращено из резерва неудавшегося выпуска.`);
        deps.appendLedger?.(report, { domain: "production", kind: row.resourceId === "money" ? "money" : "resource",
          resourceId: row.resourceId, name: row.name, qty: row.qty, roomId: row.roomId ?? row.storageRoomId ?? "",
          sourceId: building.id, source: building.name || "Здание", note: "Возврат сырья неудавшегося выпуска" });
      }
    }
    if (outcome.lost) report.work.push(`${building.name || "Здание"} / ${resourceName}: потеряно ${outcome.lost} ед. выпуска${outcome.probabilistic ? " по проверке политического штрафа" : " из-за политического штрафа"}; затраченное время не возвращается.`);
    placeOutput(building, line, resourceId, resourceName, outcome.total);
  };

  const reserveBatch = async (building, line, assignedPeople, resourceName, step) => {
    if (line.workInputsReserved) {
      if (line.workReservedInputs && line.workReservedInputs.version !== 1) throw new Error("Unsupported production input receipt.");
      return { ok: true };
    }
    const capacity = productionCapacity(line);
    const waiting = waitingProductionBatches(line);
    if (waiting.length && (!capacity || line.repeat === false)) return { ok: false, reason: "" };
    const free = capacity ? Math.max(0, capacity - productionOccupiedQty(line) - (releasedCapacityThisStep.get(line) ?? 0)) : Infinity;
    const minimum = Math.max(1, whole(line.batchStartQty, 1));
    if (capacity && free < minimum) return { ok: false, reason: "" };
    const remainingGoal = preparation.remaining(building, line);
    if (remainingGoal === 0) return { ok: false, reason: "" };
    const formula = String(line.formula ?? "").trim();
    if (remainingGoal !== null && formula && !/^\d+$/.test(formula)) {
      return { ok: false, reason: `${resourceName}: количественная цель недоступна для случайного или вычисляемого выпуска.` };
    }
    const timed = line.source === "time";
    const workerSummary = timed ? deps.buildingEffectiveWorkers(holding, building, workerContext) : null;
    const output = staffOutputQuotes.get(line) ?? await deps.lineOutputForCycle(line, {
      eff: workerSummary?.total ?? 1,
      workers: workerSummary?.assigned ?? assignedPeople.length,
      cycles: 1,
      qd: 1,
      workqd: timed ? 0 : Math.max(1, whole(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1))
    });
    const maintenanceFactor = timed ? Math.max(0, Math.min(1, deps.safeNumber(deps.maintenanceEfficiencyFactor?.(building) ?? 1, 1))) : 1;
    const fullOutputQty = whole(output.qty * maintenanceFactor);
    if (!fullOutputQty) return { ok: false, reason: `${resourceName}: рецепт не даёт целого выхода.` };
    let outputQty = capacity ? Math.min(fullOutputQty, free) : fullOutputQty;
    if (remainingGoal !== null) {
      if (!capacity && outputQty > remainingGoal) {
        return { ok: false, reason: `${resourceName}: остаток цели ${remainingGoal} ЕД. меньше неделимой партии ${outputQty} ЕД.` };
      }
      outputQty = Math.min(outputQty, remainingGoal);
    }
    if (capacity && outputQty < minimum) return { ok: false, reason: `${resourceName}: максимальная партия меньше порога запуска ${minimum} ЕД.` };
    const costsPer = deps.parseResourceCosts(line.expenses);
    const fixedCosts = String(line.fixedExpenses ?? "").trim() ? deps.parseResourceCosts(line.fixedExpenses) : [];
    const costsFor = (qty) => productionBatchCosts(line, costsPer, fixedCosts, qty, fullOutputQty);
    let costs = costsFor(outputQty);
    if (costs.some((cost) => Array.isArray(cost.alternatives))) {
      for (const candidate of costs.flatMap((cost) => cost.alternatives ?? [cost])) {
        if (deps.storageCanPay(holding, costs).ok) break;
        await deps.tryCollectResourceForConsumer(holding, building, candidate.resourceId, budgets, report, workerContext, line);
      }
    }
    for (const cost of costs) {
      if (Array.isArray(cost.alternatives)) continue;
      if (deps.storageQuantity(holding, cost) < cost.qty) {
        await deps.tryCollectResourceForConsumer(holding, building, cost.resourceId, budgets, report, workerContext, line);
      }
    }
    if (capacity) {
      outputQty = affordableProductionBatch(outputQty, costsFor, (candidate) => deps.storageCanPay(holding, candidate));
      if (outputQty < minimum) return { ok: false, reason: `${resourceName}: ожидается сырьё для запуска от ${minimum} ЕД.; доступно ${outputQty}.` };
      costs = costsFor(outputQty);
    }
    let inputReceipt = { version: 1, entries: [] };
    if (costs.length) {
      const canPay = deps.storageCanPay(holding, costs);
      if (!canPay.ok) {
        return {
          ok: false,
          reason: `${resourceName}: не хватает ${canPay.missing.map((missing) => `${missing.name} ${Math.max(0, missing.qty - missing.have)}`).join(", ")} для новой партии.`
        };
      }
      const payment = deps.storagePay(holding, costs);
      inputReceipt = Array.isArray(payment?.receipt) ? { version: 1, entries: payment.receipt } : null;
      const paid = payment?.costs ?? canPay.costs ?? costs;
      report.consumed.push(`${building.name || "Здание"}: ${paid.map((item) => `${item.name} -${item.qty}`).join(", ")} (резерв партии)`);
      appendCosts(building, paid);
    }
    line.workInputsReserved = true;
    staffOutputQuotes.delete(line);
    line.workReservedOutputQty = outputQty;
    line.workReservedFormula = String(output.formula ?? "");
    // Keep batch timing and the original output beside its funded-input receipt.
    // Missing receipts from legacy adapters must never become refundable batches.
    line.workReservedInputs = { ...(inputReceipt ?? { version: 1, entries: [], refundUnavailable: true }),
      batchId: makeId("production-batch", 16),
      openedAtQd: whole(holding?.gm?.calendaria?.lastQd) + step,
      processingShelfLifeQd: productionBatchShelfLifeQd(line),
      timing: createProductionTiming(line, deps.normalizeResourceId(line.resourceId, line.resource), resourceName) };
    const timing = line.workReservedInputs.timing;
    timing.parallel = capacity > 0;
    timing.workTargetUnits = Math.max(1, Math.ceil(timing.workTargetUnits * outputQty / fullOutputQty));
    if (timed) preparation.complete(line, outputQty);
    if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula}`);
    return { ok: true };
  };

  const finishBatch = (building, line, batch = line) => {
    const timing = productionTiming(batch);
    const resourceId = timing?.resourceId ?? deps.normalizeResourceId(line.resourceId, line.resource);
    const resourceName = timing?.resourceName ?? (resourceId === "custom" ? line.resource : deps.resourceLabel(resourceId));
    const total = whole(batch.workReservedOutputQty);
    const receipt = batch.workReservedInputs ?? null;
    clearProductionBatch(batch);
    if (total) completeOutput(building, line, resourceId, resourceName, total, receipt);
  };

  const staffLineCanWork = async (building, line, assignedPeople, step) => {
    if (!line || deps.lineFinanceAllowed?.(building, line) === false
      || deps.buildingTechnicalReady?.(building, step) === false
      || !deps.lineSeasonAllowed(line, deps.getSeasonSnapshot(holding, step) ?? null)) return false;
    if (line.requiresCollection && whole(line.pendingQty) > 0) return deps.staffCanCollectLine?.(building, line, workerContext) ?? true;
    if (line.active === false) return false;
    const timing = productionTiming(line);
    if (timing?.phase === "work") return true;
    if (timing?.phase === "waiting" || line.source === "time" || line.source === "content") return false;
    const goalRemaining = preparation.remaining(building, line);
    const formula = String(line.formula ?? "").trim();
    if (goalRemaining === 0 || goalRemaining !== null && formula && !/^\d+$/.test(formula)) return false;
    const capacity = productionCapacity(line);
    if (waitingProductionBatches(line).length && (!capacity || line.repeat === false)) return false;
    const free = capacity ? Math.max(0, capacity - productionOccupiedQty(line) - (releasedCapacityThisStep.get(line) ?? 0)) : Infinity;
    const minimum = Math.max(1, whole(line.batchStartQty, 1));
    if (capacity && free < minimum) return false;
    let output = staffOutputQuotes.get(line);
    if (!output) {
      output = await deps.lineOutputForCycle(line, {
        eff: 1, workers: assignedPeople.length, cycles: 1, qd: 1,
        workqd: Math.max(1, whole(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1))
      });
      staffOutputQuotes.set(line, output);
    }
    const fullQty = whole(output.qty);
    if (!fullQty || !capacity && goalRemaining !== null && fullQty > goalRemaining) return false;
    const limit = Math.min(fullQty, free, goalRemaining ?? Infinity);
    if (capacity && limit < minimum) return false;
    const variable = deps.parseResourceCosts(line.expenses);
    const fixed = String(line.fixedExpenses ?? "").trim() ? deps.parseResourceCosts(line.fixedExpenses) : [];
    const costsFor = (qty) => productionBatchCosts(line, variable, fixed, qty, fullQty);
    if (capacity && affordableProductionBatch(limit, costsFor, (costs) => deps.storageCanPay(holding, costs)) >= minimum) return true;
    const costs = costsFor(capacity ? minimum : limit);
    const payment = deps.storageCanPay(holding, costs);
    return payment.ok || deps.canCollectProductionInputs?.(holding, building, payment.missing ?? [], workerContext, line) === true;
  };

  for (let step = 0; step < periodQd; step += 1) {
    releasedCapacityThisStep.clear();
    deps.beforeStep?.(holding, step, report);
    // Even a stopped line continues to age. Discard a spoiled working batch
    // once; its ingredients were already consumed when the batch was opened.
    for (const building of buildings) for (const line of building.productionLines ?? []) {
      const batchIds = new Set();
      for (const batch of productionBatchStates(line)) {
        const batchId = batch.workReservedInputs?.batchId;
        if (batchId && batchIds.has(batchId)) throw new Error("Duplicate production batch identity.");
        if (batchId) batchIds.add(batchId);
        const timing = productionTiming(batch);
        if (timing && (batch.workReservedInputs.version !== 1 || !validProductionTiming(timing))) throw new Error("Unsupported production batch timing.");
        if (batch !== line && (!batch.id || batch.id !== batchId || !batch.workInputsReserved || timing?.phase !== "waiting")) throw new Error("Invalid waiting production batch.");
        const life = productionBatchLife(holding, batch, step);
        if (!life.expired) continue;
        const name = timing?.resourceName ?? deps.resourceLabel(deps.normalizeResourceId(line.resourceId, line.resource));
        clearProductionBatch(batch);
        if (batch !== line) line.waitingBatches = waitingProductionBatches(line).filter((row) => row !== batch);
        stopProductionAfterDrain(line);
        report.skipped.push(`${building.name || "Здание"} / ${name}: незавершённая пищевая партия испортилась (${life.ageQd}/${life.shelfLifeQd} QD); сырьё и труд утрачены.`);
        deps.appendLedger?.(report, { domain: "production", kind: "notice", name,
          sourceId: building.id, source: building.name, status: "expired", qty: 0,
          note: "Списана просроченная незавершённая партия; повторного списания сырья нет" });
      }
    }
    if (step % 4 === 0) deps.resetWorkerBudgets(holding, budgets, workerContext, step);
    deps.accrueWorkerBudgets(holding, budgets, workerContext, step);
    // Snapshot simultaneous staffing before any line spends this step's labor.
    const stepStaffing = new Map(buildings.map((building) => [building,
      deps.minimumStaffStatus?.(holding, building, workerContext, budgets, step)]));

    // Waiting consumes calendar QD, never worker budgets. Starting raw materials
    // and partial progress survive period boundaries, pauses, and reloads.
    const productionSeasonSnapshot = deps.getSeasonSnapshot(holding, step) ?? null;
    const completedThisStep = new Set();
    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built" || !deps.buildingFunctions(building).production) continue;
      for (const line of building.productionLines ?? []) {
        if (line?.active === false || deps.lineFinanceAllowed?.(building, line) === false || deps.buildingTechnicalReady?.(building, step) === false || !deps.lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        let releasedQty = 0;
        // Existing queued batches each age once, including while another batch
        // is being prepared. Newly finished labor enters this loop next QD.
        for (const batch of [...waitingProductionBatches(line)]) {
          const queuedTiming = productionTiming(batch);
          queuedTiming.elapsedQd += 1;
          if (queuedTiming.elapsedQd < queuedTiming.waitQd) continue;
          if (!line.requiresCollection) releasedQty += whole(batch.workReservedOutputQty);
          finishBatch(building, line, batch);
          line.waitingBatches = waitingProductionBatches(line).filter((row) => row !== batch);
          stopProductionAfterDrain(line);
        }
        releasedCapacityThisStep.set(line, releasedQty);
        if (line.active === false) continue;
        let timing = productionTiming(line);
        const source = timing?.source ?? line.source;
        if (source === "time" && !line.workInputsReserved) {
          const name = deps.resourceLabel(deps.normalizeResourceId(line.resourceId, line.resource));
          // Released places become reusable next QD, so a whole waiting QD
          // cannot simultaneously count as a QD of its replacement batch.
          const reservation = await reserveBatch(building, line, [], name, step);
          if (!reservation.ok) {
            const key = `time:${building.id}:${line.id}:${reservation.reason}`;
            if (reservation.reason && !compositionSkipped.has(key)) report.skipped.push(`${building.name || "Здание"}: ${reservation.reason}`);
            compositionSkipped.add(key);
            continue;
          }
          timing = productionTiming(line);
        }
        if (timing?.phase !== "waiting") continue;
        timing.elapsedQd = whole(timing.elapsedQd) + 1;
        if (timing.elapsedQd >= timing.waitQd) {
          finishBatch(building, line);
          stopProductionAfterDrain(line);
          completedThisStep.add(line);
        } else if (timing.parallel) {
          enqueueProductionBatch(line);
          clearProductionBatch(line);
        }
      }
    }

    // Content-based output retains its existing periodic harvesting rules.
    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built" || !deps.buildingFunctions(building).production) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false || deps.lineFinanceAllowed?.(building, line) === false || deps.buildingTechnicalReady?.(building, step) === false || !deps.lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        const source = ["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers";
        if (source !== "content" || line.workInputsReserved || completedThisStep.has(line)) continue;
        const period = ["qd", "day", "tenday"].includes(String(line.period ?? "")) ? String(line.period) : "day";
        const cycleDuration = Math.max(1, Math.ceil(deps.safeNumber(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1)));
        if (!deps.periodDueOnStep(period, step, cycleDuration)) continue;

        const resourceId = deps.normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : deps.resourceLabel(resourceId);
        const multiplier = source === "content" ? deps.lineContentQuantity(building, line) : 1;
        if (multiplier <= 0) {
          report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, нет содержимого.`);
          continue;
        }
        const workerSummary = deps.buildingEffectiveWorkers(holding, building, workerContext);
        const output = await deps.lineOutputForCycle(line, { eff: workerSummary.total, workers: workerSummary.assigned, cycles: multiplier, qd: 1, workqd: 0 });
        if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula}`);
        const maintenanceFactor = Math.max(0, Math.min(1, deps.safeNumber(deps.maintenanceEfficiencyFactor?.(building) ?? 1, 1)));
        const total = whole(output.qty * multiplier * maintenanceFactor);
        if (!total) continue;

        const costsPer = deps.parseResourceCosts(line.expenses);
        const costs = String(line.expenseMode ?? "cycle") === "unit"
          ? deps.costsForUnits(costsPer, total)
          : deps.scaledCosts(costsPer, multiplier);
        let inputReceipt = { version: 1, entries: [] };
        if (costs.length) {
          const canPay = deps.storageCanPay(holding, costs);
          if (!canPay.ok) {
            report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, не хватает ${canPay.missing.map((missing) => `${missing.name} ${Math.max(0, missing.qty - missing.have)}`).join(", ")}.`);
            continue;
          }
          const payment = deps.storagePay(holding, costs);
          inputReceipt = Array.isArray(payment?.receipt) ? { version: 1, entries: payment.receipt } : null;
          const paid = payment?.costs ?? canPay.costs ?? costs;
          report.consumed.push(`${building.name || "Здание"}: ${paid.map((item) => `${item.name} -${item.qty}`).join(", ")}`);
          appendCosts(building, paid);
        }
        completeOutput(building, line, resourceId, resourceName, total, inputReceipt);
        if (line.repeat === false) line.active = false;
      }
    }

    await deps.prepareStaffWorkerStep?.(holding, budgets, workerContext, step, { lineCanWork: staffLineCanWork, report });
    for (const building of buildings) {
      if (deps.buildingStatus(building).value === "built") await deps.autoCollectBuilding(holding, building, budgets, report, workerContext);
    }

    // A real worker QD contributes integer work units. Finished goods are
    // emitted only when a fully funded batch reaches its integer target.
    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built" || !deps.buildingFunctions(building).production) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false || deps.lineFinanceAllowed?.(building, line) === false || deps.buildingTechnicalReady?.(building, step) === false || !deps.lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        const timing = productionTiming(line);
        const source = timing?.source ?? (["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers");
        if (source !== "workers") continue;
        if (timing?.phase === "waiting" || completedThisStep.has(line)) continue;
        const assignedPeople = deps.assignedBuildingPeople(holding, building, workerContext, line);
        if (!assignedPeople.length) continue;
        const staffing = stepStaffing.get(building) ?? minimumStaffStatus(building, assignedPeople);
        if (!staffing.met) {
          const key = `staff:${building.id ?? building.name}`;
          if (staffing.count > 0 && !compositionSkipped.has(key)) {
            compositionSkipped.add(key);
            report.skipped.push(`${building.name || "Здание"}: производство остановлено — ${staffing.text}.`);
          }
          continue;
        }
        // Specialists belong to the building's simultaneous shift. One shift
        // can supervise several lines, but a one-QD visit cannot staff ten days.
        const composition = deps.buildingCompositionStatus(building, staffing.people ?? assignedPeople, { excludeGroups: ["ЧУДОТВОРЕЦ"] });
        if (!composition.met) {
          const key = `${building.id ?? building.name}:${line.id ?? line.resource}`;
          if (!compositionSkipped.has(key)) {
            compositionSkipped.add(key);
            report.skipped.push(`${building.name || "Здание"}: производственная функция остановлена — нужен состав ${composition.text}.`);
          }
          continue;
        }

        const workTargetUnits = timing?.workTargetUnits ?? Math.max(1, whole(line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1)) * WORK_UNITS_PER_QD;
        line.workProgressUnits = Math.min(workTargetUnits - 1, whole(line.workProgressUnits));
        const resourceId = deps.normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : deps.resourceLabel(resourceId);
        const lineSummary = workerLineSummary(building, line, resourceName, workTargetUnits);

        for (const person of assignedPeople) {
          const entry = deps.workerBudgetEntry(holding, person, budgets, workerContext, building, line);
          const efficiency = Math.max(0, deps.personBuildingEfficiency(holding, building, person, workerContext));
          const maintenanceBasisPoints = Math.max(0, Math.round(deps.safeNumber(deps.maintenanceEfficiencyFactor?.(building) ?? 1, 1) * 10_000));
          const qualificationWorkUnits = Math.max(0, Math.round(efficiency * WORK_UNITS_PER_QD));
          const workUnitsPerQd = Math.floor((qualificationWorkUnits * maintenanceBasisPoints) / 10_000);
          if (!workUnitsPerQd) continue;

          while (line.active !== false && productionTiming(line)?.phase !== "waiting" && deps.safeNumber(entry.available, 0) + 0.0001 >= 1) {
            let remainingUnits = workUnitsPerQd;
            let usedAnyWork = false;
            let blockedReason = "";
            while (remainingUnits > 0 && line.active !== false && productionTiming(line)?.phase !== "waiting") {
              const reservation = await reserveBatch(building, line, assignedPeople, resourceName, step);
              if (!reservation.ok) { blockedReason = reservation.reason; break; }
              // Fetching the ingredients can spend this worker's available QD.
              // Charge actual production once, before any work or next batch:
              // later ingredient collection cannot reuse a QD already underway.
              if (!usedAnyWork) {
                if (deps.safeNumber(entry.available, 0) + 0.0001 < 1) break;
                entry.available = Math.max(0, deps.safeNumber(entry.available, 0) - 1);
                entry.spent += 1;
                lineSummary.qdSpent += 1;
                deps.recordWorkerWork?.(workerContext, entry, building, line, 1);
              }
              const target = productionTiming(line)?.workTargetUnits ?? workTargetUnits;
              const needed = target - whole(line.workProgressUnits);
              const used = Math.min(needed, remainingUnits);
              line.workProgressUnits = whole(line.workProgressUnits) + used;
              remainingUnits -= used;
              usedAnyWork = usedAnyWork || used > 0;
              if (line.workProgressUnits < target) continue;

              preparation.complete(line, line.workReservedOutputQty);
              const batchTiming = productionTiming(line);
              if (batchTiming?.waitQd > 0) {
                batchTiming.phase = "waiting";
                if (batchTiming.parallel) { enqueueProductionBatch(line); clearProductionBatch(line); }
              } else { finishBatch(building, line); stopProductionAfterDrain(line); lineSummary.completedBatches += 1; }
            }
            if (!usedAnyWork) {
              if (blockedReason) report.skipped.push(`${building.name || "Здание"}: ${blockedReason}`);
              break;
            }
            if (blockedReason) {
              report.skipped.push(`${building.name || "Здание"}: остаток QD простаивает — ${blockedReason}`);
              break;
            }
          }
        }
      }
    }
    if (afterStep) await afterStep(step);
  }

  deps.afterPeriod?.(holding);
  for (const summary of workerLineSummaries.values()) {
    if (!summary.qdSpent) continue;
    const details = [`затрачено ${summary.qdSpent} QD`];
    if (summary.completedBatches) details.push(`завершено партий: ${summary.completedBatches}`);
    const progressUnits = whole(summary.line?.workProgressUnits);
    if (progressUnits > 0 && productionTiming(summary.line)?.phase !== "waiting") {
      details.push(`прогресс следующей партии: ${deps.formatNumber(progressUnits / WORK_UNITS_PER_QD)}/${deps.formatNumber((productionTiming(summary.line)?.workTargetUnits ?? summary.workTargetUnits) / WORK_UNITS_PER_QD)} QD`);
    }
    report.work?.push?.(`${summary.buildingName} · ${summary.resourceName}: ${details.join("; ")}.`);
  }

  for (const building of buildings) for (const line of building.productionLines ?? []) {
    const goal = preparation.goal(building, line);
    if (goal !== null) {
      const prepared = preparation.prepared(line);
      const name = deps.resourceLabel(deps.normalizeResourceId(line.resourceId, line.resource));
      report.work?.push?.(`${building.name || "Здание"} · ${name}: подготовлено ${prepared}/${goal} ЕД. по общей цели${prepared > goal ? "; начатая партия завершена целиком" : ""}.`);
      if (prepared < goal) report.skipped.push(`${building.name || "Здание"} · ${name}: цель подготовки не выполнена, осталось ${goal - prepared} ЕД.; проверьте время, сырьё, вместимость и допустимый размер партии.`);
    }
    for (const batch of productionBatchStates(line)) {
      if (productionTiming(batch)?.phase !== "waiting") continue;
      report.work?.push?.(`${building.name || "Здание"} · ${productionTiming(batch).resourceName} (${batch.workReservedOutputQty} ЕД.): ${productionTimingText(batch)}.`);
    }
  }

  return { holding, report, budgets, workerContext };
}
