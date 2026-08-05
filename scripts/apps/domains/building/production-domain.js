// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import {
  isLivestockResource,
  livestockResourceOptions,
  normalizeResourceId,
  parseResourceCosts,
  resourceIcon,
  resourceLabel,
  resourceOptions
} from "../../../core/resources.js";
import { materialGroup, materialGroupOptions } from "../../../core/material-groups.js";
import { getCalendariaSnapshot } from "../../../integrations/calendaria-bridge.js";
import { normalizeProductionCadence } from "../../../core/production-cadence.js";
import { hospitalityDemandSnapshot, normalizeHospitalityService } from "../../../engines/economy/hospitality-service.js";
import { normalizeTradeDemand, tradeDemandSnapshot } from "../../../engines/economy/trade.js";
import { productionRecipeBlockerText, validateProductionRecipe } from "../../../core/economy-quantity-contract.js";

export const BuildingProductionDomain = {
_productionSeasonDefs() {
  return [
    { key: "spring", label: "Зарость (1 половина)", short: "З-I" },
    { key: "summer", label: "Зарость (2 половина)", short: "З-II" },
    { key: "autumn", label: "Ухудно (1 половина)", short: "У-I" },
    { key: "winter", label: "Ухудно (2 половина)", short: "У-II" }
  ];
},

_normalizeProductionSeasons(value = null) {
  const defs = this._productionSeasonDefs();
  const fallback = Object.fromEntries(defs.map((def) => [def.key, true]));
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const normalized = {};
  let enabled = 0;
  for (const def of defs) {
    const active = value[def.key] !== false;
    normalized[def.key] = Boolean(active);
    if (active) enabled += 1;
  }
  return enabled ? normalized : fallback;
},

_productionSeasonOptions(value = null, basePath = "") {
  const current = this._normalizeProductionSeasons(value);
  return this._productionSeasonDefs().map((def) => ({
    ...def,
    selected: Boolean(current[def.key]),
    path: basePath ? `${basePath}.${def.key}` : def.key
  }));
},

_currentProductionSeasonKey(snapshot = null) {
  const season = snapshot?.season;
  const explicitKey = String(season?.key ?? "").trim().toLowerCase();
  if (["spring", "summer", "autumn", "winter"].includes(explicitKey)) return explicitKey;
  const raw = typeof season === "string"
    ? season
    : String(season?.label ?? season?.name ?? season?.title ?? season?.id ?? "");
  const text = raw.trim().toLowerCase().replace(/ё/g, "е");
  if (!text) return "";
  if (text.includes("зарость") && text.includes("1")) return "spring";
  if (text.includes("зарость") && text.includes("2")) return "summer";
  if (text.includes("ухудно") && text.includes("1")) return "autumn";
  if (text.includes("ухудно") && text.includes("2")) return "winter";
  if (/(весн|spring)/.test(text)) return "spring";
  if (/(лет|summer)/.test(text)) return "summer";
  if (/(осен|autumn|fall)/.test(text)) return "autumn";
  if (/(зим|winter)/.test(text)) return "winter";
  return "";
},

_lineSeasonAllowed(line = {}, snapshot = null) {
  const key = this._currentProductionSeasonKey(snapshot ?? getCalendariaSnapshot?.());
  if (!key) return true;
  const seasons = this._normalizeProductionSeasons(line?.seasons);
  return seasons[key] !== false;
},

_lineSeasonText(line = {}) {
  const options = this._productionSeasonOptions(line?.seasons);
  const enabled = options.filter((item) => item.selected);
  if (enabled.length >= options.length) return "Все сезоны";
  return enabled.map((item) => item.label).join(", ");
},

_prepareBuildingContents(building, buildingIndex, holding, holdingIndexArg = null, basePathArg = "") {
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndexForBuilding(building);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  const rows = Array.isArray(building?.contents) ? building.contents : [];
  return rows.map((item, index) => {
    const basePath = `${recordPath}.contents.${index}`;
    const qty = Math.max(0, this._safeNumber(item?.qty ?? item?.quantity ?? item?.count, 0));
    const capacity = Math.max(0, this._safeNumber(item?.capacity ?? item?.max ?? 0));
    const resourceId = normalizeResourceId(item?.resourceId);
    const stockLinked = isLivestockResource(resourceId);
    const storageQty = stockLinked ? Math.max(0, this._storageQuantity?.(holding, { resourceId }) ?? 0) : 0;
    return {
      _index: index,
      id: String(item?.id ?? `content-${index}`),
      name: String(item?.name ?? item?.label ?? "Содержимое"),
      resourceId: stockLinked ? resourceId : "",
      resourceLabel: stockLinked ? resourceLabel(resourceId) : "Ручное содержимое",
      resourceOptions: livestockResourceOptions(resourceId),
      stockLinked,
      resourceLocked: qty > 0,
      storageQty,
      storageQtyText: this._formatNumber?.(storageQty) ?? String(storageQty),
      canTakeFromStorage: storageQty >= 1 && (!capacity || qty < capacity),
      canReturnToStorage: qty >= 1,
      qty,
      capacity,
      notes: String(item?.notes ?? ""),
      line: capacity ? `${qty}/${capacity}` : String(qty),
      namePath: `${basePath}.name`,
      resourceIdPath: `${basePath}.resourceId`,
      qtyPath: `${basePath}.qty`,
      capacityPath: `${basePath}.capacity`,
      notesPath: `${basePath}.notes`
    };
  });
},

_contentOptions(building, selectedId = "") {
  const rows = Array.isArray(building?.contents) ? building.contents : [];
  const selected = String(selectedId ?? "");
  return [
    { value: "", label: "Не выбрано", selected: !selected },
    ...rows.map((item, index) => {
      const value = String(item?.id ?? `content-${index}`);
      return { value, label: `${String(item?.name ?? "Содержимое")} (${this._safeNumber(item?.qty, 0)})`, selected: value === selected };
    })
  ];
},

_productionSourceOptions(selected = "workers") {
  const value = String(selected ?? "workers");
  return [
    { value: "workers", label: "Рабочие", selected: value === "workers" },
    { value: "time", label: "Время", selected: value === "time" },
    { value: "content", label: "Содержимое", selected: value === "content" }
  ];
},

_productionCadenceOptions(selected = "day") {
  const value = normalizeProductionCadence(selected, "day");
  return [
    { value: "qd", label: "QD", selected: value === "qd" },
    { value: "day", label: "День", selected: value === "day" },
    { value: "tenday", label: "Десятник", selected: value === "tenday" },
    { value: "season", label: "Главный сезон", selected: value === "season" },
    { value: "year", label: "Год", selected: value === "year" }
  ];
},

_prepareProductionLines(building, buildingIndex, holding, storageRoomsArg = null, holdingIndexArg = null, basePathArg = "") {
  const source = Array.isArray(building?.productionLines) ? building.productionLines : [];
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndexForBuilding(building);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  const storageRooms = Array.isArray(storageRoomsArg) ? storageRoomsArg : (this._storageRooms?.(holding, { includeUnavailable: true }) ?? []);
  const contentRows = Array.isArray(building?.contents) ? building.contents : [];
  const contentsById = new Map();
  for (const [index, item] of contentRows.entries()) contentsById.set(String(item?.id ?? `content-${index}`), item);
  const roomLabelCache = new Map();
  const roomOptionsCache = new Map();
  const roomLabelFor = (roomId) => {
    const id = this._normalizeStorageRoomId?.(roomId) ?? String(roomId ?? "outdoors");
    if (!roomLabelCache.has(id)) roomLabelCache.set(id, this._storageRoomLabelFromRooms?.(storageRooms, id) ?? this._storageRoomLabel?.(holding, id) ?? "Под открытым небом");
    return roomLabelCache.get(id);
  };
  const roomOptionsFor = (roomId) => {
    const id = this._normalizeStorageRoomId?.(roomId) ?? String(roomId ?? "outdoors");
    if (!roomOptionsCache.has(id)) {
      roomOptionsCache.set(id, this._storageRoomOptionsFromRooms?.(storageRooms, id) ?? this._storageRoomOptions?.(holding, id) ?? [{ value: "outdoors", label: "Под открытым небом", selected: true }]);
    }
    return roomOptionsCache.get(id);
  };
  return source.map((line, index) => {
    const base = this._safeNumber(line?.base, 0);
    const perWorker = this._safeNumber(line?.perWorker, 0);
    const outputQty = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, base || perWorker || 1));
    const legacyWorkQd = Math.max(1, this._safeNumber(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD, 1));
    const active = line?.active !== false;
    const resourceId = normalizeResourceId(line?.resourceId, line?.resource);
    const resource = resourceId === "custom" ? (String(line?.resource ?? "").trim() || "Ресурс") : resourceLabel(resourceId);
    const formula = String(line?.formula ?? "").trim();
    const src = ["workers", "time", "content"].includes(String(line?.source ?? "")) ? String(line.source) : "workers";
    const cadence = normalizeProductionCadence(line?.cadence ?? line?.period, "day");
    const cadenceEvery = Math.max(1, Math.floor(this._safeNumber(line?.cadenceEvery, src === "workers" ? 1 : legacyWorkQd)));
    const laborQdPerBatch = src === "workers" ? Math.max(1, this._safeNumber(line?.laborQdPerBatch, legacyWorkQd)) : Math.max(0, this._safeNumber(line?.laborQdPerBatch, 0));
    const legacyMax = src === "workers" && cadence === "tenday" ? 1 : (src === "workers" ? 0 : 1);
    const maxBatchesPerCadence = Math.max(0, Math.floor(this._safeNumber(line?.maxBatchesPerCadence, legacyMax)));
    const contentId = String(line?.contentId ?? "");
    const content = contentsById.get(contentId);
    const contentName = content ? String(content.name ?? "Содержимое") : "содержимое";
    const contentQuantity = Math.max(0, this._safeNumber(content?.qty ?? content?.quantity ?? content?.count, 0));
    const contentUnitsPerBatch = line?.contentUnitsPerBatch === undefined || line?.contentUnitsPerBatch === null || line?.contentUnitsPerBatch === ""
      ? 1
      : Math.max(0, Math.floor(this._safeNumber(line.contentUnitsPerBatch, 0)));
    const contentCohorts = contentUnitsPerBatch > 0 ? Math.floor(contentQuantity / contentUnitsPerBatch) : 0;
    const pendingQty = Math.max(0, this._safeNumber(line?.pendingQty, 0));
    const requiresCollection = Boolean(line?.requiresCollection);
    const passive = src !== "workers" && Boolean(line?.passive);
    const rawWip = line?.workInProgress && typeof line.workInProgress === "object" ? line.workInProgress : null;
    const wipLaborRequiredQd = rawWip ? Math.max(1, this._safeNumber(rawWip?.laborRequiredQd, laborQdPerBatch || 1)) : 0;
    const wipLaborDoneQd = rawWip ? Math.max(0, Math.min(wipLaborRequiredQd, this._safeNumber(rawWip?.laborDoneQd, 0))) : 0;
    const hasWorkInProgress = Boolean(rawWip);
    const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
    const daylightCollectionOnly = Boolean(line?.daylightCollectionOnly);
    const daylightProductionOnly = Boolean(line?.daylightProductionOnly);
    const expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? "cycle")) ? String(line.expenseMode) : "cycle";
    const expenses = String(line?.expenses ?? "");
    const expenseItems = parseResourceCosts(expenses).map((item, expenseIndex) => {
      const group = materialGroup(item?.resourceGroup ?? item?.resourceId);
      const inputResourceId = group ? "" : normalizeResourceId(item?.resourceId, item?.name);
      return {
        _index: expenseIndex,
        isGroup: Boolean(group),
        resourceGroup: group?.id ?? "",
        groupOptions: materialGroupOptions(group?.id),
        resourceId: inputResourceId,
        name: group?.label ?? (inputResourceId === "custom" ? String(item?.name ?? "Ресурс") : resourceLabel(inputResourceId)),
        icon: group ? "fa-solid fa-layer-group" : resourceIcon(inputResourceId),
        qty: Math.max(0, this._safeNumber(item?.qty, 1))
      };
    });
    const recipeValidation = validateProductionRecipe(line, { parseResourceCosts });
    const recipeQuantityBlocker = productionRecipeBlockerText(recipeValidation);
    const autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? "none")) ? String(line.autoCollect) : "none";
    const overtime = Boolean(line?.overtime);
    const basePath = `${recordPath}.productionLines.${index}`;
    const storageRoomId = this._normalizeStorageRoomId?.(line?.storageRoomId ?? line?.roomId) ?? String(line?.storageRoomId ?? line?.roomId ?? "outdoors");
    const storageRoomLabel = roomLabelFor(storageRoomId);
    const seasonPath = `${basePath}.seasons`;
    const seasonOptions = this._productionSeasonOptions(line?.seasons, seasonPath);
    const seasonLabel = this._lineSeasonText(line);
    const enabledSeasonOptions = seasonOptions.filter((item) => item.selected);
    const seasonShort = enabledSeasonOptions.length >= seasonOptions.length ? "Все" : enabledSeasonOptions.map((item) => item.short).join(" · ");
    const seasonTooltip = enabledSeasonOptions.length >= seasonOptions.length ? "Производство доступно во все сезоны." : `Сезоны производства: ${enabledSeasonOptions.map((item) => item.label).join(", ")}`;
    const cadenceName = this._periodName(cadence);
    const autoCollectOptions = this._autoCollectOptions(autoCollect);
    const expenseModeOptions = this._expenseModeOptions(expenseMode);
    const cadenceMultiplierText = cadenceEvery > 1 ? `${cadenceEvery} × ${cadenceName}` : cadenceName;
    const limitText = maxBatchesPerCadence > 0 ? `до ${maxBatchesPerCadence} парт. / ${cadenceMultiplierText}` : "без календарного лимита";
    const formatNumber = (value) => this._formatNumber?.(value) ?? String(Math.round(value * 100) / 100);
    const nominalOutput = src === "content" && !formula ? outputQty * contentCohorts : outputQty;
    const performanceValue = formula || formatNumber(nominalOutput);
    const performanceLabel = formula
      ? "формула выпуска"
      : (src === "content" ? `${resource} за цикл сейчас` : `${resource} за партию`);
    const driverText = src === "workers"
      ? `${formatNumber(laborQdPerBatch)} рабоч. QD`
      : (src === "content" ? `${contentCohorts} когорт × ${contentUnitsPerBatch} ${contentName}` : cadenceMultiplierText);
    const driverLabel = src === "workers" ? "Труд на партию" : (src === "content" ? "Множитель" : "Интервал");
    const cadenceProgressText = maxBatchesPerCadence > 0
      ? `${maxBatchesPerCadence} / ${cadenceMultiplierText}`
      : "Без лимита";
    let cycleText = `${outputQty} за ${laborQdPerBatch} QD труда, ${limitText}`;
    if (src === "time") cycleText = `${outputQty} / ${cadenceMultiplierText}`;
    if (src === "content") cycleText = `${outputQty} × ${contentCohorts} полн. когорт (${contentUnitsPerBatch} ед.) / ${cadenceMultiplierText}`;
    if (src === "workers" && overtime) cycleText += ", переработка";
    if (src === "workers" && daylightProductionOnly) cycleText += ", только при свете";
    if (requiresCollection) cycleText += `, сбор ${collectQd || 0} QD${daylightCollectionOnly ? ", только при свете" : ""}`;
    if (src !== "workers" && passive) cycleText += ", пассивно";
    cycleText += ` → ${storageRoomLabel}`;
    return {
      _index: index,
      id: String(line?.id ?? `prod-${index}`),
      active,
      mode: String(line?.mode ?? "Всегда"),
      source: src,
      isWorkers: src === "workers",
      isTime: src === "time",
      isContent: src === "content",
      sourceLabel: this._sourceName(src),
      sourceOptions: this._productionSourceOptions(src),
      cadence,
      cadenceLabel: cadenceName,
      cadenceOptions: this._productionCadenceOptions(cadence),
      cadenceEvery,
      laborQdPerBatch,
      maxBatchesPerCadence,
      unlimitedBatches: maxBatchesPerCadence === 0,
      contentId,
      contentName,
      contentQuantity,
      contentUnitsPerBatch,
      contentCohorts,
      contentOptions: this._contentOptions(building, contentId),
      resourceId,
      resource,
      resourceIcon: resourceIcon(resourceId),
      resourceOptions: resourceOptions(resourceId, resource),
      isCustomResource: resourceId === "custom",
      base,
      perWorker,
      outputQty,
      workQd: src === "workers" ? laborQdPerBatch : cadenceEvery,
      formula,
      expenses,
      expenseItems,
      hasExpenses: expenseItems.length > 0,
      recipeQuantityBlocker,
      hasRecipeQuantityBlocker: Boolean(recipeQuantityBlocker),
      requiresCollection,
      passive,
      productionConfigurationError: recipeQuantityBlocker || (src === "content" && contentUnitsPerBatch <= 0
        ? "Размер когорты должен быть целым числом не меньше 1."
        : (src !== "workers" && !requiresCollection && !passive
          ? "Выберите сбор или явный пассивный режим: иначе линия не выпускает ресурс."
          : "")),
      collectQd,
      daylightCollectionOnly,
      daylightProductionOnly,
      autoCollect,
      overtime,
      storageRoomId,
      storageRoomLabel,
      seasons: this._normalizeProductionSeasons(line?.seasons),
      seasonOptions,
      seasonLabel,
      seasonShort,
      seasonTooltip,
      hasSeasonHint: seasonShort !== "Все",
      storageRoomOptions: roomOptionsFor(storageRoomId),
      autoCollectLabel: autoCollectOptions.find((option) => option.selected)?.label ?? "Не собирать",
      autoCollectOptions,
      expenseMode,
      expenseModeLabel: expenseModeOptions.find((option) => option.selected)?.label ?? "За цикл",
      expenseModeOptions,
      pendingQty,
      hasPending: pendingQty > 0,
      hasWorkInProgress,
      wipOutputQty: hasWorkInProgress ? Math.max(0, Math.floor(this._safeNumber(rawWip?.outputQty, 0))) : 0,
      wipLaborRequiredQd,
      wipLaborDoneQd,
      wipProgressText: hasWorkInProgress ? `${formatNumber(wipLaborDoneQd)} / ${formatNumber(wipLaborRequiredQd)} эфф. QD` : "",
      cadenceMultiplierText,
      limitText,
      cadenceProgressText,
      performanceValue,
      performanceLabel,
      performanceIsFormula: Boolean(formula),
      driverText,
      driverLabel,
      total: active ? outputQty : 0,
      totalPreview: formula ? `${formula} / цикл` : cycleText,
      cycleText,
      activePath: `${basePath}.active`,
      modePath: `${basePath}.mode`,
      sourcePath: `${basePath}.source`,
      cadencePath: `${basePath}.cadence`,
      cadenceEveryPath: `${basePath}.cadenceEvery`,
      laborQdPerBatchPath: `${basePath}.laborQdPerBatch`,
      maxBatchesPerCadencePath: `${basePath}.maxBatchesPerCadence`,
      contentIdPath: `${basePath}.contentId`,
      contentUnitsPerBatchPath: `${basePath}.contentUnitsPerBatch`,
      resourceIdPath: `${basePath}.resourceId`,
      resourcePath: `${basePath}.resource`,
      basePath: `${basePath}.base`,
      perWorkerPath: `${basePath}.perWorker`,
      outputQtyPath: `${basePath}.outputQty`,
      formulaPath: `${basePath}.formula`,
      expensesPath: `${basePath}.expenses`,
      requiresCollectionPath: `${basePath}.requiresCollection`,
      passivePath: `${basePath}.passive`,
      collectQdPath: `${basePath}.collectQd`,
      daylightCollectionOnlyPath: `${basePath}.daylightCollectionOnly`,
      daylightProductionOnlyPath: `${basePath}.daylightProductionOnly`,
      autoCollectPath: `${basePath}.autoCollect`,
      overtimePath: `${basePath}.overtime`,
      expenseModePath: `${basePath}.expenseMode`,
      storageRoomIdPath: `${basePath}.storageRoomId`,
      pendingQtyPath: `${basePath}.pendingQty`
    };
  });
},

_productionLinesText(building, holding = null, linesArg = null) {
  const h = holding ?? this._findHoldingForBuilding(building);
  const sourceLines = Array.isArray(linesArg) ? linesArg : this._prepareProductionLines(building, 0, h);
  const lines = sourceLines.filter((line) => line.active && line.resource);
  if (!lines.length) return "—";
  return lines.map((line) => `${line.resource}: ${line.totalPreview ?? line.total}`).join(" · ");
},

_pendingProductionRows(building, holding = null, buildingIndex = 0, linesArg = null) {
  const h = holding ?? this._findHoldingForBuilding(building);
  const lines = Array.isArray(linesArg) ? linesArg : this._prepareProductionLines(building, buildingIndex, h);
  return lines
    .filter((line) => line.active && line.pendingQty > 0)
    .map((line) => ({
      lineIndex: line._index,
      resource: line.resource,
      qty: line.pendingQty,
      label: `${line.resource}: ${line.pendingQty}`
    }));
},

_buildingIncomeSummary(building, holding = null, workerContext = null, workerEfficiencyArg = null) {
  const effSummary = workerEfficiencyArg ?? this._buildingEffectiveWorkers(holding, building, workerContext);
  const eff = effSummary.total;
  const income = building?.income && typeof building.income === "object" ? building.income : {};
  const base = this._safeNumber(income.base, 0);
  const perWorker = this._safeNumber(income.perWorker, 0);
  const formula = String(income.formula ?? "");
  const risk = this._safeNumber(income.risk, 0);
  const illegal = Boolean(income.illegal);
  const trade = income.trade && typeof income.trade === "object" ? income.trade : {};
  const tradeDemandConfig = normalizeTradeDemand(trade, (value, fallback = 0) => this._safeNumber(value, fallback));
  const tradeDemand = tradeDemandSnapshot({
    population: (holding?.people?.list ?? []).filter((person) => !person?.dead).length,
    reputation: this._reputationSummary?.(holding)?.total ?? 0,
    connections: holding?.gm?.modifiers?.marketConnectionsLevel ?? 1,
    periods: 1,
    effectiveWorkers: eff,
    trade: tradeDemandConfig,
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback)
  });
  const service = normalizeHospitalityService(income.service, (value, fallback = 0) => this._safeNumber(value, fallback));
  const serviceDemand = hospitalityDemandSnapshot({
    population: (holding?.people?.list ?? []).filter((person) => !person?.dead).length,
    reputation: this._reputationSummary?.(holding)?.total ?? 0,
    connections: holding?.gm?.modifiers?.marketConnectionsLevel ?? 1,
    periods: 1,
    effectiveWorkers: eff,
    housingCapacity: building?.housing?.capacity,
    service,
    safeNumber: (value, fallback = 0) => this._safeNumber(value, fallback)
  });
  const tradeEfficiency = this._tradeEfficiencySummary?.(holding, building, workerContext) ?? {
    value: 1,
    text: "1",
    title: "1 = 50% справочной цены каталога. Эффективность берётся от случайного назначенного торговца; фактическую продажу ограничивают спрос, бюджет, запас и труд."
  };
  const total = base + perWorker * eff;
  return {
    base,
    perWorker,
    formula,
    risk,
    illegal,
    total,
    effectiveWorkers: eff,
    service: {
      ...service,
      ...serviceDemand,
      expectedRevenue: Math.min(serviceDemand.demand, serviceDemand.capacity) * service.priceCopper,
      demandText: `${serviceDemand.demand}`,
      capacityText: `${serviceDemand.capacity}`,
      hasInputResource: Boolean(service.inputResourceId && service.inputQtyPerService > 0),
      inputResourceLabel: service.inputResourceId ? resourceLabel(normalizeResourceId(service.inputResourceId)) : "—"
    },
    trade: {
      enabled: Boolean(trade.enabled),
      ...tradeDemandConfig,
      ...tradeDemand,
      isSettlementDemand: tradeDemandConfig.demandModel === "settlement",
      expectedBuyers: Math.min(tradeDemand.demand, tradeDemand.capacity),
      demandModelOptions: [
        { value: "settlement", label: "Спрос владения", selected: tradeDemandConfig.demandModel === "settlement" },
        { value: "legacy", label: "Старые броски Репутации", selected: tradeDemandConfig.demandModel === "legacy" }
      ],
      priceEfficiency: tradeEfficiency.value,
      priceEfficiencyText: tradeEfficiency.text,
      priceEfficiencyTitle: tradeEfficiency.title,
      budgetFormula: String(trade.budgetFormula ?? "2d6*10"),
      maxLotsPerBuyer: Math.max(1, Math.floor(this._safeNumber(trade.maxLotsPerBuyer, 1))),
      roomId: String(trade.roomId ?? trade.storageRoomId ?? "all") || "all",
      kind: ["all", "resources", "items"].includes(String(trade.kind ?? trade.saleKind ?? "all")) ? String(trade.kind ?? trade.saleKind ?? "all") : "all",
      roomOptions: this._tradeStorageRoomOptions?.(holding, trade.roomId ?? trade.storageRoomId ?? "all") ?? [{ value: "all", label: "Все склады", selected: true }],
      kindOptions: this._tradeKindOptions?.(trade.kind ?? trade.saleKind ?? "all") ?? [{ value: "all", label: "Все", selected: true }],
      notes: String(trade.notes ?? "")
    }
  };
},

_buildingDefenseSummary(building, holding = null, workerContext = null, statusArg = null, workerEfficiencyArg = null) {
  const status = statusArg ?? this._buildingStatus(building);
  if (status.value !== "built") return { base: 0, perStep: 0, workerStep: 0, assigned: 0, effectiveWorkers: 0, fromWorkers: 0, total: 0, hasDefense: false, detail: "не построено" };
  const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
  const base = this._safeNumber(defense.base, 0);
  const perStep = this._safeNumber(defense.perStep, 0);
  const workerStep = Math.max(0, this._safeNumber(defense.workerStep, 0));
  const assigned = (building?.assignedWorkerIds ?? []).filter(Boolean).length;
  const effSummary = workerEfficiencyArg ?? (this._buildingEffectiveWorkers ? this._buildingEffectiveWorkers(holding, building, workerContext) : { total: assigned, detail: `${assigned} раб.` });
  const effectiveWorkers = Number.isFinite(Number(effSummary?.total)) ? Math.max(0, Number(effSummary.total)) : 0;
  const fromWorkers = workerStep > 0 ? Math.floor(effectiveWorkers / workerStep) * perStep : 0;
  const total = effectiveWorkers > 0 ? Math.max(0, base + fromWorkers) : 0;
  const hasDefense = Boolean(base || perStep || workerStep);
  const effText = this._formatNumber ? this._formatNumber(effectiveWorkers) : String(Math.round(effectiveWorkers * 100) / 100);
  const detail = workerStep > 0
    ? `${base} база + ${fromWorkers} за эфф. ${effText}/${workerStep} раб. (${effSummary?.detail || "нет деталей"})`
    : (effectiveWorkers > 0 ? `${base} база, удерживается эфф. ${effText} раб.` : `${base} база, но нет гарнизона`);
  return { base, perStep, workerStep, assigned, effectiveWorkers, fromWorkers, total, hasDefense, detail };
},

_reputationSummary(holding, moraleStateArg = null) {
  let total = 0;
  const buildings = [];
  for (const building of holding?.buildings?.list ?? []) {
    if (this._buildingStatus(building).value !== "built") continue;
    const value = this._safeNumber(building?.reputation, 0);
    if (!value) continue;
    total += value;
    buildings.push({ name: building.name || "Здание", value });
  }
  const gmMod = this._gmSettlementModifiers(holding).reputation;
  const moraleState = moraleStateArg ?? this._moraleState(this._moraleSnapshot(holding));
  const moraleMod = this._safeNumber(moraleState?.modifiers?.reputation, 0);
  const adjusted = Math.max(0, total + gmMod + moraleMod);
  const modText = [gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "", moraleMod ? `довольство ${moraleMod}` : ""].filter(Boolean).join("; ");
  const tooltip = buildings.length
    ? `Репутация считается только от построенных зданий: ${buildings.map((item) => `${item.name}: ${item.value > 0 ? "+" : ""}${item.value}`).join("; ")}. База ${total}${modText ? `; ${modText}` : ""}. Итого ${adjusted}.`
    : `Построенные здания пока не дают репутацию.${modText ? ` Модификаторы: ${modText}. Итого ${adjusted}.` : ""}`;
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, gmMod, moraleMod, buildings, bonusText: "", tooltip };
},

_defenseSummary(holding, moraleStateArg = null, workerContext = null) {
  let total = 0;
  const buildings = [];
  for (const building of holding?.buildings?.list ?? []) {
    const summary = this._buildingDefenseSummary(building, holding, workerContext);
    if (!summary.total) continue;
    total += summary.total;
    buildings.push({ name: building.name || "Здание", value: summary.total, detail: summary.detail });
  }
  const gmMod = this._gmSettlementModifiers(holding).defense;
  const moraleState = moraleStateArg ?? this._moraleState(this._moraleSnapshot(holding));
  const moraleMod = this._safeNumber(moraleState?.modifiers?.defense, 0);
  const adjusted = Math.max(0, total + gmMod + moraleMod);
  const modText = [gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "", moraleMod ? `довольство ${moraleMod}` : ""].filter(Boolean).join("; ");
  const baseTooltip = buildings.length ? buildings.map((item) => `${item.name}: +${item.value} (${item.detail})`).join("; ") : "Построенные оборонные здания пока не дают защищенность.";
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, gmMod, moraleMod, buildings, tooltip: `${baseTooltip}${modText ? ` Модификаторы: ${modText}.` : ""}` };
},

_productionLine(building, holdingArg = null, linesArg = null) {
  const holding = holdingArg ?? this._findHoldingForBuilding(building);
  const text = this._productionLinesText(building, holding, linesArg);
  if (text !== "—") return text;
  const resource = String(building?.productionResource ?? "").trim();
  const old = String(building?.production ?? "").trim();
  if (!resource) return old || "—";
  const per = this._safeNumber(building?.productionPerWorker, 0);
  const flat = this._safeNumber(building?.productionAmount, 0);
  const formula = String(building?.productionFormula ?? "").trim();
  const bits = [resource];
  if (flat) bits.push(`${flat}`);
  if (per) bits.push(`+${per}/раб.`);
  if (formula) bits.push(formula);
  return bits.join(" ");
},

_buildingProductionSummary(building, assignedCount = 0, holding = null, workerContext = null, workerEfficiencyArg = null) {
  const resource = String(building?.productionResource ?? "").trim() || String(building?.production ?? "").trim();
  const per = this._safeNumber(building?.productionPerWorker, 0);
  const flat = this._safeNumber(building?.productionAmount, 0);
  const formula = String(building?.productionFormula ?? "").trim();
  const eff = workerEfficiencyArg ?? this._buildingEffectiveWorkers(holding, building, workerContext);
  const total = flat + per * eff.total;
  return { resource: resource || "—", assignedCount, flat, per, formula, total, effectiveWorkers: eff.total, leaderBonus: eff.leaderBonus, isMoney: this._isMoneyResource(resource) };
},

_buildingMoneyIncome(building, holdingArg = null, workerContext = null, linesArg = null) {
  if (this._buildingStatus(building).value !== "built") return 0;
  const holding = holdingArg ?? this._findHoldingForBuilding(building);
  const functions = this._buildingFunctions(building);
  let total = 0;
  const workerEfficiency = workerContext ? this._buildingEffectiveWorkers(holding, building, workerContext) : null;
  if (functions.income) total += this._buildingIncomeSummary(building, holding, workerContext, workerEfficiency).total;
  const lines = Array.isArray(linesArg) ? linesArg : this._prepareProductionLines(building, 0, holding);
  for (const line of lines) {
    if (!line.active) continue;
    if (this._isMoneyResource(line.resource)) total += line.total;
  }
  const legacy = this._buildingProductionSummary(building, Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds.filter(Boolean).length : 0, holding, workerContext, workerEfficiency);
  const text = `${building?.productionResource ?? ""} ${building?.production ?? ""}`;
  if (!total && (legacy.isMoney || this._isMoneyResource(text))) total += legacy.total || this._safeNumber(building?.productionAmount, 0);
  return total;
},

_isMoneyResource(value) {
  return /(деньг|монет|money|coin|coins|silver|gold|медн|серебр|золот)/i.test(String(value ?? ""));
},

_buildingHasOvertimeProduction(building) {
  if (!Array.isArray(building?.productionLines)) return false;
  return building.productionLines.some((line) => line?.active !== false && String(line?.source ?? "workers") === "workers" && Boolean(line?.overtime));
}
};
