function productionDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "resetWorkerBudgets",
    "accrueWorkerBudgets",
    "getSeasonSnapshot",
    "isShadowDayQd",
    "buildingStatus",
    "buildingFunctions",
    "enterpriseCapitalReady",
    "lineSeasonAllowed",
    "productionCadenceWindow",
    "normalizeResourceId",
    "resourceLabel",
    "lineContentQuantity",
    "buildingEffectiveWorkers",
    "lineOutputForCycle",
    "parseResourceCosts",
    "validateProductionRecipe",
    "productionRecipeBlockerText",
    "isWholeEconomyQuantity",
    "costsForUnits",
    "scaledCosts",
    "storageCanPay",
    "storagePay",
    "normalizeStorageRoomId",
    "storageAddWithOverflow",
    "pushProductionPlacement",
    "autoCollectBuilding",
    "assignedBuildingPeople",
    "workerBudgetEntry",
    "personBuildingEfficiency",
    "storageQuantity",
    "tryCollectResourceForConsumer",
    "affordableUnitsForCosts",
    "formatNumber"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`FBL Skyhold | Production cycle requires dependency "${name}".`);
    }
  }
  return dependencies;
}

function floorProducedUnits(value = 0) {
  const numeric = Math.max(0, Number(value) || 0);
  const nearest = Math.round(numeric);
  const tolerance = Math.max(1, Math.abs(numeric)) * 1e-9;
  return Math.abs(numeric - nearest) <= tolerance ? Math.max(0, nearest) : Math.floor(numeric);
}

function normalizedWorkerWip(line = {}, deps = {}) {
  const raw = line?.workInProgress;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const laborRequiredQd = Math.max(1, deps.safeNumber(raw.laborRequiredQd ?? raw.requiredLaborQd ?? line?.laborQdPerBatch, 1));
  const laborDoneQd = Math.max(0, Math.min(laborRequiredQd, deps.safeNumber(raw.laborDoneQd ?? raw.completedLaborQd, 0)));
  const resourceId = deps.normalizeResourceId(raw.resourceId ?? line?.resourceId, raw.resource ?? line?.resource);
  const resource = resourceId === "custom"
    ? String(raw.resource ?? line?.resource ?? "Ресурс")
    : deps.resourceLabel(resourceId);
  return {
    schema: 1,
    source: "workers",
    startedQd: Math.max(0, Math.floor(deps.safeNumber(raw.startedQd, 0))),
    cadenceKey: String(raw.cadenceKey ?? ""),
    laborRequiredQd,
    laborDoneQd,
    outputQty: floorProducedUnits(raw.outputQty),
    resourceId,
    resource,
    storageRoomId: deps.normalizeStorageRoomId(raw.storageRoomId ?? line?.storageRoomId ?? line?.roomId),
    requiresCollection: Boolean(raw.requiresCollection),
    formula: String(raw.formula ?? line?.formula ?? ""),
    formulaResult: String(raw.formulaResult ?? ""),
    inputsCommitted: raw.inputsCommitted !== false,
    inputCosts: Array.isArray(raw.inputCosts)
      ? raw.inputCosts.map((cost) => ({
        resourceId: deps.normalizeResourceId(cost?.resourceId, cost?.name),
        name: String(cost?.name ?? deps.resourceLabel(cost?.resourceId)),
        qty: Math.max(0, deps.safeNumber(cost?.qty, 0)),
        roomId: String(cost?.roomId ?? cost?.storageRoomId ?? "")
      })).filter((cost) => cost.qty > 0)
      : []
  };
}

function availableEffectiveWorkQd(deps, holding, building, budgets, workerContext) {
  if (typeof deps.availableEffectiveWorkQd === "function") {
    return Math.max(0, deps.safeNumber(deps.availableEffectiveWorkQd(holding, building, budgets, workerContext), 0));
  }
  return deps.assignedBuildingPeople(holding, building, workerContext).reduce((sum, person) => {
    const entry = deps.workerBudgetEntry(holding, person, budgets, workerContext);
    const available = Math.max(0, deps.safeNumber(entry?.available, 0));
    const efficiency = Math.max(0, deps.personBuildingEfficiency(holding, building, person, workerContext));
    return sum + available * efficiency;
  }, 0);
}

function spendEffectiveWorkQd(deps, holding, building, budgets, needed, workerContext) {
  if (typeof deps.spendBuildingEffectiveWorkQd === "function") {
    return deps.spendBuildingEffectiveWorkQd(holding, building, budgets, needed, workerContext);
  }
  let rest = Math.max(0, deps.safeNumber(needed, 0));
  let spent = 0;
  let spentEffective = 0;
  for (const person of deps.assignedBuildingPeople(holding, building, workerContext)) {
    if (rest <= 0.0001) break;
    const entry = deps.workerBudgetEntry(holding, person, budgets, workerContext);
    const available = Math.max(0, deps.safeNumber(entry?.available, 0));
    const efficiency = Math.max(0, deps.personBuildingEfficiency(holding, building, person, workerContext));
    if (available <= 0 || efficiency <= 0) continue;
    const take = Math.min(available, rest / efficiency);
    const effective = take * efficiency;
    entry.available = available - take;
    entry.spent = deps.safeNumber(entry.spent, 0) + take;
    rest -= effective;
    spent += take;
    spentEffective += effective;
  }
  return { ok: rest <= 0.0001, spent, spentEffective };
}

export async function runProductionCycle({
  holding,
  qd = 0,
  report,
  buildings = holding?.buildings?.list ?? [],
  budgets = new Map(),
  workerContext = null,
  dependencies = {}
} = {}) {
  if (!holding || typeof holding !== "object") throw new TypeError("FBL Skyhold | Production cycle requires a holding draft.");
  if (!report || typeof report !== "object") throw new TypeError("FBL Skyhold | Production cycle requires a mutable report.");
  const deps = productionDependencies(dependencies);
  const periodQd = Math.max(0, Math.floor(deps.safeNumber(qd, 0)));
  const startQd = Math.max(0, Math.floor(deps.safeNumber(holding?.gm?.calendaria?.lastQd, 0)));
  const cadenceLimitNotices = new Set();
  const daylightWorkNotices = new Set();
  const invalidRecipeNotices = new Set();
  const recipeReady = (building, line) => {
    const validation = deps.validateProductionRecipe(line, { parseResourceCosts: deps.parseResourceCosts });
    if (validation.ok) return true;
    const key = `${building?.id ?? building?.name ?? "building"}:${line?.id ?? line?.mode ?? "line"}`;
    if (!invalidRecipeNotices.has(key)) {
      invalidRecipeNotices.add(key);
      report.skipped.push(`${building?.name || "Здание"}: линия «${line?.mode || line?.resource || "Производство"}» остановлена. ${deps.productionRecipeBlockerText(validation)}`);
    }
    return false;
  };
  const wholeCalculatedOutput = (building, line, output) => {
    if (deps.isWholeEconomyQuantity(output?.qty, { allowZero: true })) return true;
    const key = `${building?.id ?? building?.name ?? "building"}:${line?.id ?? line?.mode ?? "line"}:calculated`;
    if (!invalidRecipeNotices.has(key)) {
      invalidRecipeNotices.add(key);
      report.skipped.push(`${building?.name || "Здание"}: линия «${line?.mode || line?.resource || "Производство"}» остановлена — формула выпуска вернула дробное количество. Исправьте рецепт у ГМ.`);
    }
    return false;
  };
  const lineBatchLimit = (line, source, cadenceSlot) => {
    if (line?.maxBatchesPerCadence !== undefined && line?.maxBatchesPerCadence !== null) {
      return Math.max(0, Math.floor(deps.safeNumber(line.maxBatchesPerCadence, 0)));
    }
    if (source !== "workers") return 1;
    return cadenceSlot?.cadence === "tenday" ? 1 : 0;
  };
  const batchesInWindow = (line, cadenceSlot) => String(line?.cadenceKey ?? "") === String(cadenceSlot?.key ?? "")
    ? Math.max(0, Math.floor(deps.safeNumber(line?.batchesInCadence, 0)))
    : 0;
  const cadenceLimitReached = (line, source, cadenceSlot) => {
    const limit = lineBatchLimit(line, source, cadenceSlot);
    return limit > 0 && batchesInWindow(line, cadenceSlot) >= limit;
  };
  const recordCadenceBatch = (line, source, cadenceSlot) => {
    const limit = lineBatchLimit(line, source, cadenceSlot);
    if (limit <= 0) return;
    if (String(line?.cadenceKey ?? "") !== String(cadenceSlot?.key ?? "")) {
      line.cadenceKey = String(cadenceSlot?.key ?? "");
      line.batchesInCadence = 0;
    }
    line.batchesInCadence = batchesInWindow(line, cadenceSlot) + 1;
  };
  const noteCadenceLimit = (building, line, cadenceSlot) => {
    const key = `${building?.id ?? building?.name ?? "building"}:${line?.id ?? line?.resourceId ?? "line"}:${cadenceSlot?.key ?? "cadence"}`;
    if (cadenceLimitNotices.has(key)) return;
    cadenceLimitNotices.add(key);
    const limit = lineBatchLimit(line, String(line?.source ?? "workers"), cadenceSlot);
    if (Array.isArray(report.work)) report.work.push(`${building?.name || "Здание"}: достигнут лимит ${limit} парт. за календарный период линии «${line?.mode || line?.name || line?.resource || "Производство"}».`);
  };
  const noteDaylightStop = (building, line, absoluteQd) => {
    const day = Math.floor(Math.max(0, absoluteQd - 1) / 4);
    const key = `${building?.id ?? building?.name ?? "building"}:${line?.id ?? line?.resourceId ?? "line"}:${day}`;
    if (daylightWorkNotices.has(key)) return;
    daylightWorkNotices.add(key);
    report.skipped.push(`${building?.name || "Здание"}: линия «${line?.mode || line?.name || line?.resource || "Производство"}» остановлена на теньдень — работа требует дневного света.`);
  };
  const appendCosts = (building, costs = []) => deps.appendLedger?.(report, costs.map((cost) => ({
    domain: "production",
    kind: deps.normalizeResourceId(cost.resourceId, cost.name) === "money" ? "money" : "resource",
    resourceId: deps.normalizeResourceId(cost.resourceId, cost.name),
    name: cost.name || deps.resourceLabel(cost.resourceId),
    qty: -Math.max(0, deps.safeNumber(cost.qty, 0)),
    roomId: cost.roomId ?? cost.storageRoomId ?? "",
    sourceId: building?.id,
    source: building?.name || "Здание",
    note: "Расход производственной линии"
  })));
  const deferredOutputs = [];
  const deferOutput = ({ building, line, output, qty, absoluteQd, extra = "" } = {}) => {
    const total = floorProducedUnits(qty);
    if (!total) return;
    deferredOutputs.push({ building, line, output, qty: total, absoluteQd, extra });
  };
  const flushDeferredOutputs = () => {
    if (!deferredOutputs.length) return;
    const queued = deferredOutputs.splice(0, deferredOutputs.length);
    for (const entry of queued) {
      const { building, line, output, qty, absoluteQd, extra } = entry;
      const resourceId = deps.normalizeResourceId(output?.resourceId, output?.resource);
      const resourceName = resourceId === "custom" ? (String(output?.resource ?? "Ресурс") || "Ресурс") : deps.resourceLabel(resourceId);
      if (output?.requiresCollection) {
        line.pendingQty = Math.max(0, deps.safeNumber(line?.pendingQty, 0)) + qty;
        report.produced.push(`${building?.name || "Здание"}: ${resourceName} +${qty} готово к сбору.`);
        deps.appendLedger?.(report, {
          domain: "production",
          kind: "progress",
          resourceId,
          name: resourceName,
          qty,
          sourceId: building?.id,
          source: building?.name || "Здание",
          status: "pending",
          note: "Готово к сбору; на склад ещё не помещено"
        });
        continue;
      }
      const roomId = deps.normalizeStorageRoomId(output?.storageRoomId ?? line?.storageRoomId ?? line?.roomId);
      const placements = deps.storageAddWithOverflow(holding, {
        resourceId,
        name: resourceName,
        roomId,
        receivedQd: absoluteQd,
        lotSource: "production"
      }, qty);
      deps.pushProductionPlacement(report, holding, building?.name || "Здание", resourceName, placements, extra, resourceId);
    }
  };

  for (let step = 0; step < periodQd; step += 1) {
    const absoluteQd = startQd + step + 1;
    const shadowDay = Boolean(deps.isShadowDayQd(absoluteQd));
    if (step % 4 === 0) deps.resetWorkerBudgets(holding, budgets, workerContext, { absoluteQd });
    deps.accrueWorkerBudgets(holding, budgets, workerContext);

    // Produced goods remain outside free stock until the end of the current
    // tenday. This makes a production step simultaneous: A -> B can use stock
    // that existed before the tenday, but never the output A has just created.
    const productionSeasonSnapshot = deps.getSeasonSnapshot(holding, step) ?? null;
    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built") continue;
      if (!deps.buildingFunctions(building).production) continue;
      if (!deps.enterpriseCapitalReady(building, holding)) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false) continue;
        if (!recipeReady(building, line)) continue;
        if (!deps.lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        if (shadowDay && line?.daylightProductionOnly) {
          noteDaylightStop(building, line, absoluteQd);
          continue;
        }
        const source = ["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers";
        if (source === "workers") continue;
        const legacyImplicitPassive = !Object.hasOwn(line ?? {}, "passive");
        if (!line?.requiresCollection && line?.passive !== true && !legacyImplicitPassive) {
          report.skipped.push(`${building.name || "Здание"}: линия «${line?.mode || line?.name || line?.resource || "Производство"}» требует операции сбора либо явного пассивного режима.`);
          continue;
        }
        const cadenceWindow = deps.productionCadenceWindow(line, absoluteQd);
        if (!cadenceWindow?.due) continue;
        if (cadenceLimitReached(line, source, cadenceWindow)) {
          noteCadenceLimit(building, line, cadenceWindow);
          continue;
        }

        const resourceId = deps.normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : deps.resourceLabel(resourceId);
        const contentQuantity = source === "content" ? deps.lineContentQuantity(building, line) : 0;
        const contentUnitsPerBatch = source === "content"
          ? (line?.contentUnitsPerBatch === undefined || line?.contentUnitsPerBatch === null || line?.contentUnitsPerBatch === ""
            ? 1
            : Math.max(0, Math.floor(deps.safeNumber(line.contentUnitsPerBatch, 0))))
          : 1;
        if (source === "content" && contentUnitsPerBatch <= 0) {
          report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, размер когорты должен быть целым числом не меньше 1.`);
          continue;
        }
        const multiplier = source === "content" ? Math.floor(contentQuantity / contentUnitsPerBatch) : 1;
        if (multiplier <= 0) {
          report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, нет полной когорты содержимого (${deps.formatNumber(contentQuantity)}/${contentUnitsPerBatch}).`);
          continue;
        }
        const workerSummary = deps.buildingEffectiveWorkers(holding, building, workerContext);
        const output = await deps.lineOutputForCycle(line, {
          // Efficiency is production speed, never a free yield multiplier.
          // Authored formulas may still use @workers for a genuine workplace
          // size dependency; legacy @eff formulas resolve to one batch yield.
          eff: 1,
          workers: workerSummary.assigned,
          cycles: 1,
          qd: 1,
          workqd: 0
        });
        if (!wholeCalculatedOutput(building, line, output)) continue;
        if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula}`);
        // Content lines produce whole batches per complete cohort. A partial
        // herd remains owned inventory but never leaks fractional resources.
        const unitOutput = source === "content" && !String(line?.formula ?? "").trim()
          ? Math.max(0, deps.safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, output.qty))
          : output.qty;
        const operationalFactor = typeof deps.buildingOperationalFactor === "function"
          ? Math.max(0, Math.min(1, deps.safeNumber(deps.buildingOperationalFactor(holding, building, workerContext), 1)))
          : 1;
        const total = floorProducedUnits(unitOutput * multiplier * operationalFactor);
        if (!total) continue;

        const costsPer = deps.parseResourceCosts(line.expenses);
        const expenseMode = String(line.expenseMode ?? "cycle") === "unit" ? "unit" : "cycle";
        let costs = [];
        if (costsPer.length) {
          // A cycle expense belongs to the whole herd/crop cycle. Only the
          // explicit per-unit mode grows with the produced quantity.
          costs = expenseMode === "unit"
            ? deps.costsForUnits(costsPer, total)
            : deps.scaledCosts(costsPer, multiplier);
          const canPay = deps.storageCanPay(holding, costs);
          if (!canPay.ok) {
            report.skipped.push(`${building.name || "Здание"}: ${resourceName} не произведен, не хватает ${canPay.missing.map((missing) => `${missing.name} ${Math.max(0, missing.qty - missing.have)}`).join(", ")}.`);
            continue;
          }
          const payment = deps.storagePay(holding, costs);
          costs = payment?.costs ?? canPay.costs ?? costs;
          report.consumed.push(`${building.name || "Здание"}: ${costs.map((item) => `${item.name} -${item.qty}`).join(", ")}`);
          appendCosts(building, costs);
        }

        deferOutput({
          building,
          line,
          output: {
            resourceId,
            resource: resourceName,
            storageRoomId: deps.normalizeStorageRoomId(line.storageRoomId ?? line.roomId),
            requiresCollection: Boolean(line.requiresCollection)
          },
          qty: total,
          absoluteQd
        });
        recordCadenceBatch(line, source, cadenceWindow);
      }
    }

    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built") continue;
      await deps.autoCollectBuilding(holding, building, budgets, report, workerContext, { absoluteQd, shadowDay });
    }

    // Worker lines can consume opening stock and output collected from an older
    // tenday. All output created in this tenday is still deferred.
    for (const building of buildings) {
      if (deps.buildingStatus(building).value !== "built") continue;
      if (!deps.buildingFunctions(building).production) continue;
      if (!deps.enterpriseCapitalReady(building, holding)) continue;
      for (const line of Array.isArray(building.productionLines) ? building.productionLines : []) {
        if (line?.active === false) continue;
        if (!recipeReady(building, line)) continue;
        if (!deps.lineSeasonAllowed(line, productionSeasonSnapshot)) continue;
        if (shadowDay && line?.daylightProductionOnly) {
          noteDaylightStop(building, line, absoluteQd);
          continue;
        }
        const source = ["workers", "time", "content"].includes(String(line.source ?? "")) ? String(line.source) : "workers";
        if (source !== "workers") continue;
        const workQd = Math.max(1, deps.safeNumber(line.laborQdPerBatch ?? line.workQd ?? line.workerQD ?? line.cycleQd ?? line.cycleQD, 1));
        const assignedPeople = deps.assignedBuildingPeople(holding, building, workerContext);
        if (!assignedPeople.length) continue;
        const cadenceWindow = deps.productionCadenceWindow(line, absoluteQd);

        const resourceId = deps.normalizeResourceId(line.resourceId, line.resource);
        const resourceName = resourceId === "custom" ? (line.resource || "Ресурс") : deps.resourceLabel(resourceId);
        const costsPer = deps.parseResourceCosts(line.expenses);
        const expenseMode = String(line.expenseMode ?? "cycle") === "unit" ? "unit" : "cycle";
        let wip = normalizedWorkerWip(line, deps);
        if (wip) line.workInProgress = wip;
        let safety = 0;
        while (((wip && wip.laborDoneQd + 0.0001 >= wip.laborRequiredQd)
          || availableEffectiveWorkQd(deps, holding, building, budgets, workerContext) > 0.0001) && safety < 1000) {
          safety += 1;
          if (!wip) {
            if (cadenceLimitReached(line, source, cadenceWindow)) {
              noteCadenceLimit(building, line, cadenceWindow);
              break;
            }

            const output = await deps.lineOutputForCycle(line, {
              // Efficiency is applied below to labour progress. A formula can
              // describe batch yield, but cannot multiply that yield for free.
              eff: 1,
              workers: assignedPeople.length,
              cycles: 1,
              qd: 1,
              workqd: workQd
            });
            if (!wholeCalculatedOutput(building, line, output)) break;
            const total = floorProducedUnits(output.qty);
            if (!total) break;

            let costs = expenseMode === "unit"
              ? deps.costsForUnits(costsPer, total)
              : deps.scaledCosts(costsPer, 1);
            for (const cost of costs) {
              if (deps.storageQuantity(holding, cost) + 0.0001 < deps.safeNumber(cost.qty, 0)) {
                await deps.tryCollectResourceForConsumer(holding, building, cost.resourceId, budgets, report, workerContext, { absoluteQd, shadowDay });
              }
            }
            if (costs.length) {
              const canPay = deps.storageCanPay(holding, costs);
              if (!canPay.ok) {
                report.skipped.push(`${building.name || "Здание"}: партия ${resourceName} не начата, не хватает ${canPay.missing.map((missing) => `${missing.name} ${Math.max(0, missing.qty - missing.have)}`).join(", ")}.`);
                break;
              }
              const payment = deps.storagePay(holding, costs);
              costs = payment?.costs ?? canPay.costs ?? costs;
              report.consumed.push(`${building.name || "Здание"}: ${costs.map((item) => `${item.name} -${item.qty}`).join(", ")} (входы начатой партии)`);
              appendCosts(building, costs);
            }

            wip = {
              schema: 1,
              source: "workers",
              startedQd: absoluteQd,
              cadenceKey: String(cadenceWindow?.key ?? ""),
              laborRequiredQd: workQd,
              laborDoneQd: 0,
              outputQty: total,
              resourceId,
              resource: resourceName,
              storageRoomId: deps.normalizeStorageRoomId(line.storageRoomId ?? line.roomId),
              requiresCollection: Boolean(line.requiresCollection),
              formula: String(line?.formula ?? ""),
              formulaResult: String(output?.formula ?? ""),
              inputsCommitted: true,
              inputCosts: costs.map((cost) => ({
                resourceId: deps.normalizeResourceId(cost?.resourceId, cost?.name),
                name: String(cost?.name ?? deps.resourceLabel(cost?.resourceId)),
                qty: Math.max(0, deps.safeNumber(cost?.qty, 0)),
                roomId: String(cost?.roomId ?? cost?.storageRoomId ?? "")
              }))
            };
            line.workInProgress = wip;
            recordCadenceBatch(line, source, cadenceWindow);
            if (output.formula) report.formulas.push(`${building.name || "Здание"} / ${resourceName}: ${output.formula} (зафиксировано при старте партии)`);
          }

          const remaining = Math.max(0, wip.laborRequiredQd - wip.laborDoneQd);
          if (remaining > 0.0001) {
            const spent = spendEffectiveWorkQd(deps, holding, building, budgets, remaining, workerContext);
            const progress = Math.max(0, deps.safeNumber(spent?.spentEffective, 0));
            if (progress <= 0.0001) break;
            wip.laborDoneQd = Math.min(wip.laborRequiredQd, wip.laborDoneQd + progress);
            line.workInProgress = wip;
            if (wip.laborDoneQd + 0.0001 < wip.laborRequiredQd) break;
          }

          deferOutput({
            building,
            line,
            output: wip,
            qty: wip.outputQty,
            absoluteQd,
            extra: ` (${deps.formatNumber(wip.laborRequiredQd)} эфф. QD)`
          });
          line.workInProgress = null;
          wip = null;
        }
      }
    }
    if (absoluteQd % 40 === 0) flushDeferredOutputs();
  }

  // Short diagnostic periods (for example a one-day preview) still publish
  // their output when the operation ends. A full tenday always flushes at its
  // own boundary above, before the next tenday can start.
  flushDeferredOutputs();
  for (const building of buildings) {
    for (const line of Array.isArray(building?.productionLines) ? building.productionLines : []) {
      const wip = normalizedWorkerWip(line, deps);
      if (!wip) continue;
      report.work.push(`${building?.name || "Здание"}: партия «${line?.mode || wip.resource || "Производство"}» в работе — ${deps.formatNumber(wip.laborDoneQd)}/${deps.formatNumber(wip.laborRequiredQd)} эфф. QD; входы уже списаны.`);
    }
  }

  return { holding, report, budgets, workerContext };
}
