// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { ATTRIBUTE_META } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { normalizeResourceId, resourceIcon, resourceLabel, resourceOptions } from "../../../core/resources.js";
import { getCalendariaSnapshot } from "../../../integrations/calendaria-bridge.js";

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

_prepareProductionLines(building, buildingIndex, holding, storageRoomsArg = null, holdingIndexArg = null, basePathArg = "") {
  const source = Array.isArray(building?.productionLines) ? building.productionLines : [];
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndexForBuilding(building);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  const storageRooms = Array.isArray(storageRoomsArg) ? storageRoomsArg : (this._storageRooms?.(holding, { includeUnavailable: true }) ?? []);
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
    const content = (building?.contents ?? []).find((item, cIndex) => String(item?.id ?? `content-${cIndex}`) === contentId);
    const contentName = content ? String(content.name ?? "Содержимое") : "содержимое";
    const pendingQty = Math.max(0, this._safeNumber(line?.pendingQty, 0));
    const requiresCollection = Boolean(line?.requiresCollection);
    const collectQd = Math.max(0, this._safeNumber(line?.collectQd, 0));
    const expenseMode = ["cycle", "unit"].includes(String(line?.expenseMode ?? "cycle")) ? String(line.expenseMode) : "cycle";
    const autoCollect = ["none", "building", "worker"].includes(String(line?.autoCollect ?? "none")) ? String(line.autoCollect) : "none";
    const overtime = Boolean(line?.overtime);
    const basePath = `${recordPath}.productionLines.${index}`;
    const storageRoomId = this._normalizeStorageRoomId?.(line?.storageRoomId ?? line?.roomId) ?? String(line?.storageRoomId ?? line?.roomId ?? "outdoors");
    const storageRoomLabel = this._storageRoomLabelFromRooms?.(storageRooms, storageRoomId) ?? this._storageRoomLabel?.(holding, storageRoomId) ?? "Под открытым небом";
    const seasonPath = `${basePath}.seasons`;
    const seasonOptions = this._productionSeasonOptions(line?.seasons, seasonPath);
    const seasonLabel = this._lineSeasonText(line);
    const enabledSeasonOptions = seasonOptions.filter((item) => item.selected);
    const seasonShort = enabledSeasonOptions.length >= seasonOptions.length ? "Все" : enabledSeasonOptions.map((item) => item.short).join(" · ");
    const seasonTooltip = enabledSeasonOptions.length >= seasonOptions.length ? "Производство доступно во все сезоны." : `Сезоны производства: ${enabledSeasonOptions.map((item) => item.label).join(", ")}`;
    const periodName = this._periodName(period);
    const periodMultiplierText = workQd > 1 ? `${workQd} ${periodName}` : periodName;
    let cycleText = `${outputQty} за ${workQd} QD`;
    if (src === "time") cycleText = `${outputQty} / ${periodMultiplierText}`;
    if (src === "content") cycleText = `${outputQty} × ${contentName} / ${periodMultiplierText}`;
    if (src === "workers" && overtime) cycleText += ", переработка";
    if (requiresCollection) cycleText += `, сбор ${collectQd || 0} QD`;
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
      period,
      periodLabel: periodName,
      periodCycleLabel: src === "workers" ? "QD/цикл" : `Время/цикл (${periodName})`,
      periodCycleTooltip: src === "workers" ? "Сколько рабочих QD нужно на один цикл. Рабочие тратят это время на производство." : "Сколько выбранных периодов нужно на один цикл. Если период — День, значение 1 означает один раз за день; значение 2 — один раз за два дня.",
      periodOptions: this._productionPeriodOptions(period),
      contentId,
      contentName,
      contentOptions: this._contentOptions(building, contentId),
      resourceId,
      resource,
      resourceIcon: resourceIcon(resourceId),
      resourceOptions: resourceOptions(resourceId, resource),
      isCustomResource: resourceId === "custom",
      base,
      perWorker,
      outputQty,
      workQd,
      formula,
      expenses: String(line?.expenses ?? ""),
      requiresCollection,
      collectQd,
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
      storageRoomOptions: this._storageRoomOptionsFromRooms?.(storageRooms, storageRoomId) ?? this._storageRoomOptions?.(holding, storageRoomId) ?? [{ value: "outdoors", label: "Под открытым небом", selected: true }],
      autoCollectLabel: this._autoCollectOptions(autoCollect).find((option) => option.selected)?.label ?? "Не собирать",
      autoCollectOptions: this._autoCollectOptions(autoCollect),
      expenseMode,
      expenseModeLabel: this._expenseModeOptions(expenseMode).find((option) => option.selected)?.label ?? "За цикл",
      expenseModeOptions: this._expenseModeOptions(expenseMode),
      pendingQty,
      total: active ? outputQty : 0,
      totalPreview: formula ? `${formula} / цикл` : cycleText,
      cycleText,
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
      formulaPath: `${basePath}.formula`,
      expensesPath: `${basePath}.expenses`,
      requiresCollectionPath: `${basePath}.requiresCollection`,
      collectQdPath: `${basePath}.collectQd`,
      autoCollectPath: `${basePath}.autoCollect`,
      overtimePath: `${basePath}.overtime`,
      expenseModePath: `${basePath}.expenseMode`,
      storageRoomIdPath: `${basePath}.storageRoomId`,
      pendingQtyPath: `${basePath}.pendingQty`
    };
  });
},

_productionLinesText(building, holding = null) {
  const h = holding ?? this._findHoldingForBuilding(building);
  const lines = this._prepareProductionLines(building, 0, h).filter((line) => line.active && line.resource);
  if (!lines.length) return "—";
  return lines.map((line) => `${line.resource}: ${line.totalPreview ?? line.total}`).join(" · ");
},

_pendingProductionRows(building, holding = null, buildingIndex = 0) {
  const h = holding ?? this._findHoldingForBuilding(building);
  return this._prepareProductionLines(building, buildingIndex, h)
    .filter((line) => line.active && line.pendingQty > 0)
    .map((line) => ({
      lineIndex: line._index,
      resource: line.resource,
      qty: line.pendingQty,
      label: `${line.resource}: ${line.pendingQty}`
    }));
},

_buildingIncomeSummary(building, holding = null) {
  const eff = this._buildingEffectiveWorkers(holding, building).total;
  const income = building?.income && typeof building.income === "object" ? building.income : {};
  const base = this._safeNumber(income.base, 0);
  const perWorker = this._safeNumber(income.perWorker, 0);
  const formula = String(income.formula ?? "");
  const risk = this._safeNumber(income.risk, 0);
  const illegal = Boolean(income.illegal);
  const trade = income.trade && typeof income.trade === "object" ? income.trade : {};
  const total = base + perWorker * eff;
  return {
    base,
    perWorker,
    formula,
    risk,
    illegal,
    total,
    effectiveWorkers: eff,
    trade: {
      enabled: Boolean(trade.enabled),
      priceEfficiency: this._tradeEfficiencySummary?.(holding, building)?.value ?? 1,
      priceEfficiencyText: this._tradeEfficiencySummary?.(holding, building)?.text ?? "1",
      priceEfficiencyTitle: this._tradeEfficiencySummary?.(holding, building)?.title ?? "1 = 50% цены Forbidden Lands. Эффективность берется от случайного назначенного торговца.",
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

_buildingDefenseSummary(building, holding = null) {
  if (this._buildingStatus(building).value !== "built") return { base: 0, perStep: 0, workerStep: 0, assigned: 0, effectiveWorkers: 0, fromWorkers: 0, total: 0, hasDefense: false, detail: "не построено" };
  const defense = building?.defense && typeof building.defense === "object" ? building.defense : {};
  const base = this._safeNumber(defense.base, 0);
  const perStep = this._safeNumber(defense.perStep, 0);
  const workerStep = Math.max(0, this._safeNumber(defense.workerStep, 0));
  const assigned = (building?.assignedWorkerIds ?? []).filter(Boolean).length;
  const effSummary = this._buildingEffectiveWorkers ? this._buildingEffectiveWorkers(holding, building) : { total: assigned, detail: `${assigned} раб.` };
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

_reputationSummary(holding) {
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
  const moraleState = this._moraleState(this._calculateMorale(holding));
  const moraleMod = moraleState.value < 0 ? -1 : 0;
  const adjusted = Math.max(0, total + gmMod + moraleMod);
  const modText = [gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "", moraleMod ? `довольство ${moraleMod}` : ""].filter(Boolean).join("; ");
  const tooltip = buildings.length
    ? `Репутация считается только от построенных зданий: ${buildings.map((item) => `${item.name}: ${item.value > 0 ? "+" : ""}${item.value}`).join("; ")}. База ${total}${modText ? `; ${modText}` : ""}. Итого ${adjusted}.`
    : `Построенные здания пока не дают репутацию.${modText ? ` Модификаторы: ${modText}. Итого ${adjusted}.` : ""}`;
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, gmMod, moraleMod, buildings, bonusText: "", tooltip };
},

_defenseSummary(holding) {
  let total = 0;
  const buildings = [];
  for (const building of holding?.buildings?.list ?? []) {
    const summary = this._buildingDefenseSummary(building, holding);
    if (!summary.total) continue;
    total += summary.total;
    buildings.push({ name: building.name || "Здание", value: summary.total, detail: summary.detail });
  }
  const gmMod = this._gmSettlementModifiers(holding).defense;
  const moraleState = this._moraleState(this._calculateMorale(holding));
  const moraleMod = moraleState.value < 0 ? -1 : 0;
  const adjusted = Math.max(0, total + gmMod + moraleMod);
  const modText = [gmMod ? `ГМ ${gmMod > 0 ? "+" : ""}${gmMod}` : "", moraleMod ? `довольство ${moraleMod}` : ""].filter(Boolean).join("; ");
  const baseTooltip = buildings.length ? buildings.map((item) => `${item.name}: +${item.value} (${item.detail})`).join("; ") : "Построенные оборонные здания пока не дают защищенность.";
  return { base: 0, bonus: adjusted, total: adjusted, rawTotal: total, gmMod, moraleMod, buildings, tooltip: `${baseTooltip}${modText ? ` Модификаторы: ${modText}.` : ""}` };
},

_productionLine(building) {
  const holding = this._findHoldingForBuilding(building);
  const text = this._productionLinesText(building, holding);
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

_buildingProductionSummary(building, assignedCount = 0, holding = null) {
  const resource = String(building?.productionResource ?? "").trim() || String(building?.production ?? "").trim();
  const per = this._safeNumber(building?.productionPerWorker, 0);
  const flat = this._safeNumber(building?.productionAmount, 0);
  const formula = String(building?.productionFormula ?? "").trim();
  const eff = this._buildingEffectiveWorkers(holding, building);
  const total = flat + per * eff.total;
  return { resource: resource || "—", assignedCount, flat, per, formula, total, effectiveWorkers: eff.total, leaderBonus: eff.leaderBonus, isMoney: this._isMoneyResource(resource) };
},

_buildingMoneyIncome(building) {
  if (this._buildingStatus(building).value !== "built") return 0;
  const holding = this._findHoldingForBuilding(building);
  const functions = this._buildingFunctions(building);
  let total = 0;
  if (functions.income) total += this._buildingIncomeSummary(building, holding).total;
  for (const line of this._prepareProductionLines(building, 0, holding)) {
    if (!line.active) continue;
    if (this._isMoneyResource(line.resource)) total += line.total;
  }
  const legacy = this._buildingProductionSummary(building, Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds.filter(Boolean).length : 0, holding);
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
