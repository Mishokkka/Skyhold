// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { normalizeResourceId, resourceIcon, resourceLabel, resourceOptions } from "../../../core/resources.js";
import { getCalendariaSnapshot } from "../../../integrations/calendaria-bridge.js";
import {
  buildingConfirmedHarmActive,
  buildingConfirmedSocialStatus,
  scaleIntegerBuildingEffect
} from "../../../engines/economy/building-service.js";
import { politicsRuntimeEffects } from "../../../engines/politics/runtime-effects.js";
import { productionTimingText, productionIdentityLocked } from "../../../engines/economy/production-timing.js";
import { productionCapacity, productionBatchStates, productionOccupiedQty } from "../../../engines/economy/production-capacity.js";

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
    return {
      _index: index,
      id: String(item?.id ?? `content-${index}`),
      name: String(item?.name ?? item?.label ?? "Содержимое"),
      qty,
      capacity,
      notes: String(item?.notes ?? ""),
      line: capacity ? `${qty}/${capacity}` : String(qty),
      namePath: `${basePath}.name`,
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

_productionPeriodOptions(selected = "day") {
  const value = String(selected ?? "day");
  return [
    { value: "qd", label: "QD", selected: value === "qd" },
    { value: "day", label: "День", selected: value === "day" },
    { value: "tenday", label: "Десятник", selected: value === "tenday" }
  ];
},

_prepareProductionLines(building, buildingIndex, holding, storageRoomsArg = null, holdingIndexArg = null, basePathArg = "", options = {}) {
  const includeEditorOptions = options?.includeEditorOptions !== false;
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
    const choices = roomOptionsCache.get(id);
    if (!choices.some((row) => row.value === "auto")) choices.unshift({ value: "auto", label: "Предпочтительные склады", selected: id === "auto" });
    return choices;
  };
  return source.map((line, index) => {
    const base = this._safeNumber(line?.base, 0);
    const perWorker = this._safeNumber(line?.perWorker, 0);
    const outputQty = Math.max(0, this._safeNumber(line?.outputQty ?? line?.output ?? line?.quantity, base || perWorker || 1));
    const workQd = Math.max(1, this._safeNumber(line?.workQd ?? line?.workerQD ?? line?.cycleQd ?? line?.cycleQD, 1));
    const active = line?.active !== false;
    const resourceId = normalizeResourceId(line?.resourceId, line?.resource);
    const resource = resourceId === "custom" ? (String(line?.resource ?? "").trim() || "Ресурс") : resourceLabel(resourceId);
    const formula = String(line?.formula ?? "").trim();
    const src = ["workers", "time", "content"].includes(String(line?.source ?? "")) ? String(line.source) : "workers";
    const period = ["qd", "day", "tenday"].includes(String(line?.period ?? "")) ? String(line.period) : "day";
    const contentId = String(line?.contentId ?? "");
    const content = contentsById.get(contentId);
    const contentName = content ? String(content.name ?? "Содержимое") : "содержимое";
    const pendingQty = Math.max(0, this._safeNumber(line?.pendingQty, 0));
    const requiresCollection = Boolean(line?.requiresCollection);
    const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
    const expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? "cycle")) ? String(line.expenseMode) : "cycle";
    const autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? "none")) ? String(line.autoCollect) : "none";
    const overtime = Boolean(line?.overtime);
    const wageDailyCopper = Math.max(0, Math.floor(this._safeNumber(line?.wageDailyCopper, 0)));
    const operatingUpkeepMonthlyCopper = Math.max(0, Math.floor(this._safeNumber(line?.operatingUpkeepMonthlyCopper, 0)));
    const basePath = `${recordPath}.productionLines.${index}`;
    const storageRoomId = this._normalizeStorageRoomId?.(line?.storageRoomId ?? line?.roomId) ?? String(line?.storageRoomId ?? line?.roomId ?? "outdoors");
    const storageRoomLabel = roomLabelFor(storageRoomId);
    const seasonPath = `${basePath}.seasons`;
    const seasonOptions = this._productionSeasonOptions(line?.seasons, seasonPath);
    const seasonLabel = this._lineSeasonText(line);
    const enabledSeasonOptions = seasonOptions.filter((item) => item.selected);
    const seasonShort = enabledSeasonOptions.length >= seasonOptions.length ? "Все" : enabledSeasonOptions.map((item) => item.short).join(" · ");
    const seasonTooltip = enabledSeasonOptions.length >= seasonOptions.length ? "Производство доступно во все сезоны." : `Сезоны производства: ${enabledSeasonOptions.map((item) => item.label).join(", ")}`;
    const periodName = this._periodName(period);
    const autoCollectOptions = includeEditorOptions ? this._autoCollectOptions(autoCollect) : null;
    const expenseModeOptions = includeEditorOptions ? this._expenseModeOptions(expenseMode) : null;
    const periodMultiplierText = workQd > 1 ? `${workQd} ${periodName}` : periodName;
    let cycleText = `${outputQty} за ${workQd} QD`;
    if (src === "time") cycleText = `${outputQty} / ${periodMultiplierText}`;
    if (src === "content") cycleText = `${outputQty} × ${contentName} / ${periodMultiplierText}`;
    if (src === "workers" && overtime) cycleText += ", переработка";
    if (src === "workers" && line.waitDays > 0) cycleText += ` + ожидание ${line.waitDays} дн.`;
    if (line.repeat === false) cycleText += ", без повторных запусков";
    if (productionCapacity(line)) cycleText += `, от ${line.batchStartQty || 1} ЕД., вместимость ${line.batchCapacity} ЕД.`;
    if (requiresCollection) cycleText += `, сбор ${collectQd || 0} QD`;
    cycleText += ` → ${storageRoomLabel}`;
    const prepared = {
      _index: index,
      id: String(line?.id ?? `prod-${index}`),
      active,
      mode: String(line?.mode ?? "Всегда"),
      source: src,
      isWorkers: src === "workers",
      isTime: src === "time",
      isContent: src === "content",
      sourceLabel: this._sourceName(src),
      period,
      periodLabel: periodName,
      periodCycleLabel: src === "workers" ? "QD/цикл" : `Время/цикл (${periodName})`,
      periodCycleTooltip: src === "workers" ? "Сколько рабочих QD нужно на один цикл. Рабочие тратят это время на производство." : "Сколько выбранных периодов нужно на один цикл. Если период — День, значение 1 означает один раз за день; значение 2 — один раз за два дня.",
      contentId,
      contentName,
      resourceId,
      resource,
      resourceIcon: resourceIcon(resourceId),
      isCustomResource: resourceId === "custom",
      base,
      perWorker,
      outputQty,
      workQd,
      waitDays: Math.max(0, Number(line.waitDays) || 0),
      repeat: line.repeat !== false,
      batchProgressText: productionTimingText(line),
      identityLocked: productionIdentityLocked(line),
      batchCapacity: productionCapacity(line),
      batchStartQty: Math.max(1, Number(line.batchStartQty) || 1),
      fixedExpenses: String(line.fixedExpenses ?? ""),
      occupiedQty: productionOccupiedQty(line),
      freeCapacity: Math.max(0, productionCapacity(line) - productionOccupiedQty(line)),
      productionBatches: productionBatchStates(line).map((batch) => ({
        id: batch.workReservedInputs?.batchId ?? "", qty: batch.workReservedOutputQty,
        progressText: productionTimingText({ ...batch, active: line.active })
      })),
      formula,
      expenses: String(line?.expenses ?? ""),
      requiresCollection,
      collectQd,
      autoCollect,
      overtime,
      requiresGmConfirmation: line?.requiresGmConfirmation === true,
      wageDailyCopper,
      operatingUpkeepMonthlyCopper,
      storageRoomId,
      storageRoomLabel,
      seasons: this._normalizeProductionSeasons(line?.seasons),
      seasonLabel,
      seasonShort,
      seasonTooltip,
      hasSeasonHint: seasonShort !== "Все",
      expenseMode,
      pendingQty,
      canCancelBatch: Boolean(line?.workInputsReserved || line?.workProgressUnits || line.waitingBatches?.length),
      total: active ? outputQty : 0,
      totalPreview: formula ? `${formula} / цикл` : cycleText,
      cycleText
    };
    if (!includeEditorOptions) return prepared;
    return {
      ...prepared,
      sourceOptions: this._productionSourceOptions(src),
      periodOptions: this._productionPeriodOptions(period),
      contentOptions: this._contentOptions(building, contentId),
      resourceOptions: resourceOptions(resourceId, resource),
      seasonOptions,
      storageRoomOptions: roomOptionsFor(storageRoomId),
      autoCollectLabel: autoCollectOptions.find((option) => option.selected)?.label ?? "Не собирать",
      autoCollectOptions,
      expenseModeLabel: expenseModeOptions.find((option) => option.selected)?.label ?? "За цикл",
      expenseModeOptions,
      activePath: `${basePath}.active`,
      modePath: `${basePath}.mode`,
      sourcePath: `${basePath}.source`,
      periodPath: `${basePath}.period`,
      contentIdPath: `${basePath}.contentId`,
      resourceIdPath: `${basePath}.resourceId`,
      resourcePath: `${basePath}.resource`,
      basePath: `${basePath}.base`,
      perWorkerPath: `${basePath}.perWorker`,
      outputQtyPath: `${basePath}.outputQty`,
      workQdPath: `${basePath}.workQd`,
      waitDaysPath: `${basePath}.waitDays`,
      repeatPath: `${basePath}.repeat`,
      batchCapacityPath: `${basePath}.batchCapacity`,
      batchStartQtyPath: `${basePath}.batchStartQty`,
      fixedExpensesPath: `${basePath}.fixedExpenses`,
      formulaPath: `${basePath}.formula`,
      expensesPath: `${basePath}.expenses`,
      requiresCollectionPath: `${basePath}.requiresCollection`,
      collectQdPath: `${basePath}.collectQd`,
      autoCollectPath: `${basePath}.autoCollect`,
      overtimePath: `${basePath}.overtime`,
      wageDailyCopperPath: `${basePath}.wageDailyCopper`,
      operatingUpkeepMonthlyCopperPath: `${basePath}.operatingUpkeepMonthlyCopper`,
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

_buildingIncomeSummary(building, holding = null, workerContext = null, workerEfficiencyArg = null, storageRoomsArg = null) {
  const effSummary = workerEfficiencyArg ?? this._buildingEffectiveWorkers(holding, building, workerContext);
  const eff = effSummary.total;
  const income = building?.income && typeof building.income === "object" ? building.income : {};
  const base = this._safeNumber(income.base, 0);
  const perWorker = this._safeNumber(income.perWorker, 0);
  const formula = String(income.formula ?? "");
  const risk = this._safeNumber(income.risk, 0);
  const illegal = Boolean(income.illegal);
  const wageDailyCopper = Math.max(0, Math.floor(this._safeNumber(income.wageDailyCopper, 0)));
  const operatingUpkeepMonthlyCopper = Math.max(0, Math.floor(this._safeNumber(income.operatingUpkeepMonthlyCopper, 0)));
  const trade = income.trade && typeof income.trade === "object" ? income.trade : {};
  const selectedTradeRoomId = String(trade.roomId ?? trade.storageRoomId ?? "all") || "all";
  const tradeRoomOptions = Array.isArray(storageRoomsArg)
    ? [
        { value: "all", label: "Все склады", selected: selectedTradeRoomId === "all" },
        ...storageRoomsArg
          .filter((room) => room.available || room.source === "base")
          .map((room) => ({ value: room.id, label: room.label, selected: room.id === selectedTradeRoomId }))
      ]
    : (this._tradeStorageRoomOptions?.(holding, selectedTradeRoomId) ?? [{ value: "all", label: "Все склады", selected: true }]);
  if (Array.isArray(storageRoomsArg) && selectedTradeRoomId !== "all" && !tradeRoomOptions.some((option) => option.value === selectedTradeRoomId)) {
    tradeRoomOptions.push({ value: selectedTradeRoomId, label: `${selectedTradeRoomId} (нет в списке)`, selected: true });
  }
  const tradeEfficiency = this._tradeEfficiencySummary?.(holding, building, workerContext) ?? {
    value: 1,
    text: "1",
    title: "1 = 50% базовой цены, 2 = 100%, 3 = 150%."
  };
  const maintenanceFactor = this._maintenanceEfficiencyFactor?.(building) ?? (this._safeNumber(building?.maintenance?.backlogTendays, 0) >= 2 ? 0.5 : 1);
  const total = Math.floor((base + perWorker * eff) * maintenanceFactor);
  return {
    base,
    perWorker,
    formula,
    risk,
    illegal,
    wageDailyCopper,
    operatingUpkeepMonthlyCopper,
    total,
    effectiveWorkers: eff,
    trade: {
      enabled: Boolean(trade.enabled),
      priceEfficiency: tradeEfficiency.value,
      priceEfficiencyText: tradeEfficiency.text,
      priceEfficiencyTitle: tradeEfficiency.title,
      sourceIdsText: (trade.sourceIds ?? []).join(", "),
      allowedTagsText: (trade.allowedTags ?? []).join(", "),
      demandSource: String(trade.demandSource ?? ""),
      demandBudgetBaseCopper: Math.max(0, Math.floor(this._safeNumber(trade.demandBudgetBaseCopper, 0))),
      demandBudgetPerWorkerCopper: Math.max(0, Math.floor(this._safeNumber(trade.demandBudgetPerWorkerCopper, 0))),
      throughputUnitsPerWorker: Math.max(0, Math.floor(this._safeNumber(trade.throughputUnitsPerWorker, 0))),
      gmPriority: Math.max(0, Math.floor(this._safeNumber(trade.gmPriority, 500))),
      roomId: selectedTradeRoomId,
      kind: ["all", "resources", "items"].includes(String(trade.kind ?? trade.saleKind ?? "all")) ? String(trade.kind ?? trade.saleKind ?? "all") : "all",
      roomOptions: tradeRoomOptions,
      kindOptions: this._tradeKindOptions?.(trade.kind ?? trade.saleKind ?? "all") ?? [{ value: "all", label: "Все", selected: true }],
      service: {
        enabled: Boolean(trade.service?.enabled),
        categoryTag: String(trade.service?.categoryTag ?? ""),
        basePriceCopper: Math.max(0, Math.floor(this._safeNumber(trade.service?.basePriceCopper, 0))),
        unitsPerWorker: Math.max(0, Math.floor(this._safeNumber(trade.service?.unitsPerWorker, 0)))
      },
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
  const maintenanceFactor = Math.max(0, Math.min(1, this._maintenanceEfficiencyFactor?.(building) ?? 1));
  const structuralBase = Math.max(0, Math.floor(base * maintenanceFactor));
  const fromWorkers = workerStep > 0 ? Math.floor(effectiveWorkers / workerStep) * perStep : 0;
  const total = Math.max(0, structuralBase + fromWorkers);
  const hasDefense = Boolean(base || perStep || workerStep);
  const effText = this._formatNumber ? this._formatNumber(effectiveWorkers) : String(Math.round(effectiveWorkers * 100) / 100);
  const detail = workerStep > 0
    ? `${structuralBase} структура + ${fromWorkers} за эфф. ${effText}/${workerStep} оплаченных раб. (${effSummary?.detail || "нет деталей"})`
    : `${structuralBase} структурная защита${maintenanceFactor < 1 ? ` (обслуживание ×${maintenanceFactor})` : ""}`;
  return { base, structuralBase, perStep, workerStep, assigned, effectiveWorkers, fromWorkers, total, hasDefense, detail };
},

_reputationSummary(holding, _moraleStateArg = null) {
  const candidates = [];
  for (const [index, building] of (holding?.buildings?.list ?? []).entries()) {
    if (this._buildingStatus(building).value !== "built") continue;
    const rawValue = this._safeNumber(building?.reputation, 0);
    if (!rawValue) continue;
    const socialStatus = rawValue > 0 ? buildingConfirmedSocialStatus(holding, building) : null;
    if (rawValue > 0 && !socialStatus.active) continue;
    if (rawValue < 0 && !buildingConfirmedHarmActive(holding, building)) continue;
    const serviceFactor = rawValue > 0 ? socialStatus.maintenanceFactor : 1;
    const activeValue = scaleIntegerBuildingEffect(rawValue, serviceFactor);
    if (!activeValue) continue;
    const templateId = String(building?.templateId ?? "").trim().toLowerCase();
    const instanceId = String(building?.id ?? "").trim();
    candidates.push({
      building,
      index,
      rawValue,
      activeValue,
      serviceFactor,
      templateId,
      instanceId,
      groupKey: templateId ? `template:${templateId}` : `instance:${instanceId || "legacy"}:${index}`,
      stableKey: instanceId || `legacy-${String(index).padStart(8, "0")}`
    });
  }
  candidates.sort((left, right) => {
    if (left.groupKey < right.groupKey) return -1;
    if (left.groupKey > right.groupKey) return 1;
    if (left.stableKey < right.stableKey) return -1;
    if (left.stableKey > right.stableKey) return 1;
    return left.index - right.index;
  });

  let total = 0;
  let undiminishedTotal = 0;
  const buildings = [];
  const groupRanks = new Map();
  for (const candidate of candidates) {
    const rank = (groupRanks.get(candidate.groupKey) ?? 0) + 1;
    groupRanks.set(candidate.groupKey, rank);
    const repeated = Boolean(candidate.templateId) && rank > 1;
    const repeatAllowed = candidate.building?.repeatSettlementEffects === true;
    const value = repeated && !repeatAllowed ? 0 : candidate.activeValue;
    total += value;
    undiminishedTotal += candidate.rawValue;
    buildings.push({
      id: candidate.instanceId,
      name: candidate.building.name || "Здание",
      rawValue: candidate.rawValue,
      activeValue: candidate.activeValue,
      serviceFactor: candidate.serviceFactor,
      value,
      rank,
      repeated,
      repeatAllowed,
      templateId: candidate.templateId
    });
  }
  const gmMod = this._gmSettlementModifiers(holding).reputation;
  const politicsMod = politicsRuntimeEffects(holding)?.reputation ?? 0;
  const moraleMod = 0;
  const adjusted = Math.max(0, total + gmMod + politicsMod);
  const modText = gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "";
  const signed = (value) => `${value > 0 ? "+" : ""}${value}`;
  const buildingText = buildings.map((item) => {
    if (item.repeated && !item.repeatAllowed) return `${item.name}: ${signed(item.rawValue)} → 0 (повтор шаблона)`;
    if (item.value !== item.rawValue) return `${item.name}: ${signed(item.rawValue)} → ${signed(item.value)} (активность/обслуживание)`;
    return `${item.name}: ${signed(item.value)}${item.repeated ? " (повтор разрешён явно)" : ""}`;
  }).join("; ");
  const tooltip = buildings.length
    ? `Репутация вычисляется только от действующих зданий. По умолчанию вклад даёт первый действующий экземпляр шаблона; повторы дают 0, если шаблон явно не разрешает исключение: ${buildingText}. База ${total}${modText ? `; ${modText}` : ""}. Итого ${adjusted}.`
    : `Построенные здания пока не дают репутацию.${modText ? ` Модификаторы: ${modText}. Итого ${adjusted}.` : ""}`;
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, undiminishedTotal, gmMod, politicsMod, moraleMod, buildings, bonusText: "", tooltip: `${tooltip}${politicsMod ? ` Политика ${signed(politicsMod)}.` : ""}` };
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
  const politicsMod = politicsRuntimeEffects(holding)?.defense ?? 0;
  const moraleState = moraleStateArg ?? this._moraleState(this._calculateMorale(holding));
  const moraleMod = moraleState.value < 0 ? -1 : 0;
  const adjusted = Math.max(0, total + gmMod + politicsMod + moraleMod);
  const modText = [gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "", moraleMod ? `довольство ${moraleMod}` : ""].filter(Boolean).join("; ");
  const baseTooltip = buildings.length ? buildings.map((item) => `${item.name}: +${item.value} (${item.detail})`).join("; ") : "Построенные оборонные здания пока не дают защищенность.";
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, gmMod, politicsMod, moraleMod, buildings, tooltip: `${baseTooltip}${modText ? ` Модификаторы: ${modText}.` : ""}${politicsMod ? ` Политика ${politicsMod > 0 ? "+" : ""}${politicsMod}.` : ""}` };
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
  const maintenanceFactor = this._maintenanceEfficiencyFactor?.(building) ?? (this._safeNumber(building?.maintenance?.backlogTendays, 0) >= 2 ? 0.5 : 1);
  const total = Math.floor((flat + per * eff.total) * maintenanceFactor);
  return { resource: resource || "—", assignedCount, flat, per, formula, total, effectiveWorkers: eff.total, leaderBonus: eff.leaderBonus, isMoney: this._isMoneyResource(resource) };
},

_buildingMoneyIncome(building, holdingArg = null, workerContext = null, linesArg = null) {
  if (this._buildingStatus(building).value !== "built") return 0;
  const holding = holdingArg ?? this._findHoldingForBuilding(building);
  const functions = this._buildingFunctions(building);
  let total = 0;
  const workerEfficiency = workerContext ? this._buildingEffectiveWorkers(holding, building, workerContext) : null;
  if (functions.income && !building?.income?.trade?.enabled) total += this._buildingIncomeSummary(building, holding, workerContext, workerEfficiency).total;
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
