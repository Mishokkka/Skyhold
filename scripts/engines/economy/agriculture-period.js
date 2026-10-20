import { normalizeAgricultureBuilding } from "../../data/agriculture.js";
import {
  agricultureConfigurationSignature,
  agricultureStateSignature,
  planAgriculturePlot
} from "./agriculture.js";

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0) {
  return Math.max(0, Math.floor(finite(value, fallback)));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function priority(value = 0) {
  return Math.floor(finite(value, 0));
}

function activeCrop(agriculture = {}) {
  return (agriculture.crops ?? []).find((crop) => crop.id === agriculture.activeCropId) ?? null;
}

function configurationSnapshot(agriculture = {}, crop = null) {
  return {
    enabled: agriculture.enabled,
    kind: agriculture.kind,
    activeCropId: agriculture.activeCropId,
    outputRoomId: agriculture.outputRoomId,
    gmPriority: agriculture.gmPriority,
    operations: clone(agriculture.operations),
    crop: clone(crop)
  };
}

function sortedAgricultureBuildings(buildings = []) {
  return (Array.isArray(buildings) ? buildings : [])
    .map((building) => ({ building, agriculture: normalizeAgricultureBuilding(building?.agriculture, { building }) }))
    .filter((row) => row.agriculture?.enabled)
    .sort((left, right) => (
      priority(right.agriculture.gmPriority) - priority(left.agriculture.gmPriority)
      || text(left.building?.id).localeCompare(text(right.building?.id), "ru")
    ));
}

function requirePlanDependencies(dependencies = {}) {
  for (const name of ["isOperational", "isFunctionAllowed", "workQdForBuilding", "calendarContextForOffset"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Agriculture period requires dependency "${name}".`);
  }
  return dependencies;
}

export function planAgriculturePeriod({
  buildings = [],
  elapsedQd = 40,
  operationId = "",
  dependencies = {}
} = {}) {
  const deps = requirePlanDependencies(dependencies);
  const periodQd = whole(elapsedQd);
  const entries = [];
  const skipped = [];

  for (const row of sortedAgricultureBuildings(buildings)) {
    const buildingId = text(row.building?.id);
    const buildingName = text(row.building?.name || (row.agriculture.kind === "field" ? "Поле" : "Сад"));
    if (!deps.isOperational(row.building)) {
      skipped.push({ buildingId, buildingName, reason: "not-operational" });
      continue;
    }
    const functionAllowed = deps.isFunctionAllowed(row.building, "agriculture");
    if (!functionAllowed) {
      skipped.push({ buildingId, buildingName, reason: "finance-blocked" });
    }
    const crop = activeCrop(row.agriculture);
    if (!crop) {
      skipped.push({ buildingId, buildingName, reason: "no-crop" });
      continue;
    }
    const configuration = configurationSnapshot(row.agriculture, crop);
    const stateBefore = clone(row.agriculture.state);
    const plot = planAgriculturePlot({
      state: stateBefore,
      crop,
      // Debt/conservation blocks new labour and transfers, but must not freeze
      // calendar growth or preserve a ready crop forever as an exploit.
      operations: functionAllowed ? row.agriculture.operations : { sow: false, harvest: false },
      elapsedQd: periodQd,
      availableWorkQd: functionAllowed ? deps.workQdForBuilding(row.building, periodQd) : 0,
      operationId: [text(operationId), buildingId].filter(Boolean).join(":"),
      calendarContextForOffset: (offsetQd) => deps.calendarContextForOffset(offsetQd, row.building)
    });
    entries.push({
      buildingId,
      buildingName,
      kind: row.agriculture.kind,
      cropId: crop.id,
      cropLabel: crop.label,
      resourceId: crop.resourceId,
      outputRoomId: row.agriculture.outputRoomId,
      gmPriority: row.agriculture.gmPriority,
      functionAllowed,
      operationId: plot.operationId,
      replay: plot.replay,
      configuration,
      configurationBeforeSignature: agricultureConfigurationSignature(configuration),
      stateBefore,
      stateBeforeSignature: agricultureStateSignature(stateBefore),
      stateAfter: clone(plot.stateAfter),
      workQdAvailable: plot.workQdAvailable,
      workQdUsed: plot.workQdUsed,
      resourceChanges: clone(plot.resourceChanges),
      events: clone(plot.events),
      warnings: clone(plot.warnings)
    });
  }

  const resourceTotals = new Map();
  for (const change of entries.flatMap((entry) => entry.resourceChanges)) {
    const resourceId = text(change?.resourceId);
    const qty = whole(change?.qty);
    if (!resourceId || !qty) continue;
    resourceTotals.set(resourceId, (resourceTotals.get(resourceId) ?? 0) + qty);
  }
  const resourceChanges = [...resourceTotals].map(([resourceId, qty]) => ({ resourceId, qty }));
  return {
    version: 1,
    operationId: text(operationId),
    elapsedQd: periodQd,
    replay: entries.length > 0 && entries.every((entry) => entry.replay),
    entries,
    skipped,
    resourceChanges,
    totals: {
      producedQty: resourceChanges.reduce((sum, change) => sum + whole(change.qty), 0),
      workQdUsed: entries.reduce((sum, entry) => sum + whole(entry.workQdUsed), 0),
      readyPlots: entries.filter((entry) => ["ready", "harvesting"].includes(entry.stateAfter?.phase)).length,
      expiredQty: entries.reduce((sum, entry) => sum + entry.events.filter((event) => event.kind === "expired").reduce((subtotal, event) => subtotal + whole(event.qty), 0), 0)
    }
  };
}

function requireApplyDependencies(dependencies = {}) {
  for (const name of ["getBuilding", "addResource", "setAgriculture"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Agriculture apply requires dependency "${name}".`);
  }
  return dependencies;
}

export function applyAgriculturePeriodPlan({ plan, dependencies = {} } = {}) {
  const deps = requireApplyDependencies(dependencies);
  if (!plan || typeof plan !== "object") return { ok: false, message: "План сельского хозяйства отсутствует." };

  let replayCount = 0;
  for (const entry of plan.entries ?? []) {
    const building = deps.getBuilding(entry.buildingId);
    if (!building) return { ok: false, stale: true, message: `Участок ${entry.buildingName || entry.buildingId} больше не существует.` };
    const agriculture = normalizeAgricultureBuilding(building.agriculture, { building });
    if (!agriculture) return { ok: false, stale: true, message: `Участок «${entry.buildingName || entry.buildingId}» больше не является сезонным хозяйством.` };
    if (entry.operationId && agriculture.state.lastOperationId === entry.operationId) {
      replayCount += 1;
      continue;
    }
    const crop = activeCrop(agriculture);
    const currentConfiguration = configurationSnapshot(agriculture, crop);
    if (agricultureConfigurationSignature(currentConfiguration) !== text(entry.configurationBeforeSignature)) {
      return { ok: false, stale: true, message: `Настройки участка «${entry.buildingName || entry.buildingId}» изменились после Preview.` };
    }
    if (agricultureStateSignature(agriculture.state) !== text(entry.stateBeforeSignature)) {
      return { ok: false, stale: true, message: `Состояние участка «${entry.buildingName || entry.buildingId}» изменилось после Preview.` };
    }
  }

  if (replayCount > 0) {
    if (replayCount !== (plan.entries ?? []).length) {
      return { ok: false, stale: true, message: "План сельского хозяйства применён только к части участков; требуется новый Preview." };
    }
    return {
      ok: true,
      replay: true,
      entries: clone(plan.entries ?? []),
      resourceChanges: [],
      totals: clone(plan.totals ?? {}),
      receipts: []
    };
  }

  const receipts = [];
  for (const entry of plan.entries ?? []) {
    for (const change of entry.resourceChanges ?? []) {
      const qty = whole(change.qty);
      if (qty > 0) receipts.push(deps.addResource(change.resourceId, qty, entry));
    }
    const building = deps.getBuilding(entry.buildingId);
    const agriculture = normalizeAgricultureBuilding(building?.agriculture, { building });
    agriculture.state = clone(entry.stateAfter);
    deps.setAgriculture(building, agriculture, entry);
  }

  return {
    ok: true,
    replay: false,
    entries: clone(plan.entries ?? []),
    resourceChanges: clone(plan.resourceChanges ?? []),
    totals: clone(plan.totals ?? {}),
    receipts
  };
}
