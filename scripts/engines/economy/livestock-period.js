import { normalizeLivestockBuilding } from "../../data/livestock.js";
import {
  livestockStateSignature,
  normalizeLivestockState,
  planLivestockTenday
} from "./livestock.js";

const TENDAY_QD = 40;

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

function sortedLivestockBuildings(buildings = []) {
  return (Array.isArray(buildings) ? buildings : [])
    .map((building) => ({ building, livestock: normalizeLivestockBuilding(building?.livestock, { building }) }))
    .filter((row) => row.livestock?.enabled)
    .sort((left, right) => (
      priority(right.livestock.gmPriority) - priority(left.livestock.gmPriority)
      || text(left.building?.id).localeCompare(text(right.building?.id), "ru")
    ));
}

function resourceTotals(changes = []) {
  const totals = new Map();
  for (const row of changes) {
    const resourceId = text(row?.resourceId);
    const qty = Math.trunc(finite(row?.qty, 0));
    if (!resourceId || !qty) continue;
    const key = `${resourceId}\u0000${qty < 0 ? "out" : "in"}`;
    const current = totals.get(key) ?? { resourceId, qty: 0 };
    current.qty += qty;
    totals.set(key, current);
  }
  return [...totals.values()].filter((row) => row.qty !== 0);
}

function periodDependencies(dependencies = {}) {
  for (const name of ["isOperational", "isFunctionAllowed", "resourceQuantity", "workQdForBuilding", "seasonContextForCycle"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Livestock period requires dependency "${name}".`);
  }
  return dependencies;
}

export function planLivestockPeriod({
  buildings = [],
  elapsedQd = TENDAY_QD,
  operationId = "",
  cycleQd = TENDAY_QD,
  dependencies = {}
} = {}) {
  const deps = periodDependencies(dependencies);
  const periodQd = whole(elapsedQd);
  const cycleLength = Math.max(4, whole(cycleQd, TENDAY_QD));
  const tendayCount = Math.floor(periodQd / cycleLength);
  const ignoredQd = periodQd - tendayCount * cycleLength;
  const rows = sortedLivestockBuildings(buildings);
  const entries = [];
  const skipped = [];
  const availableResources = new Map();
  const availableResource = (resourceId) => {
    const id = text(resourceId);
    if (!availableResources.has(id)) availableResources.set(id, whole(deps.resourceQuantity(id)));
    return availableResources.get(id) ?? 0;
  };
  const consumePlannedResource = (resourceId, qty) => {
    const id = text(resourceId);
    availableResources.set(id, Math.max(0, availableResource(id) - whole(qty)));
  };

  if (!tendayCount) {
    return {
      version: 1,
      operationId: text(operationId),
      elapsedQd: periodQd,
      tendayCount: 0,
      ignoredQd,
      entries,
      skipped,
      resourceChanges: [],
      totals: { born: 0, matured: 0, feedConsumed: 0, eggs: 0, milk: 0, wool: 0, meat: 0, tallow: 0, workQdUsed: 0 }
    };
  }

  for (const row of rows) {
    const buildingId = text(row.building?.id);
    const buildingName = text(row.building?.name || row.livestock.profile.label || "Животноводство");
    if (!deps.isOperational(row.building)) {
      skipped.push({ buildingId, buildingName, reason: "not-operational" });
      continue;
    }
    if (!deps.isFunctionAllowed(row.building, "livestock")) {
      skipped.push({ buildingId, buildingName, reason: "finance-blocked" });
      continue;
    }

    const stateBefore = normalizeLivestockState(row.livestock.state, row.livestock.profile);
    let state = clone(stateBefore);
    const cycles = [];
    const allChanges = [];
    const warnings = [];
    let born = 0;
    let matured = 0;
    let workQdUsed = 0;

    for (let cycleIndex = 0; cycleIndex < tendayCount; cycleIndex += 1) {
      const season = deps.seasonContextForCycle(cycleIndex) ?? {};
      const operations = cycleIndex === 0
        ? row.livestock.operations
        : { ...row.livestock.operations, shearQty: 0, slaughterQty: 0, slaughterBreedingMales: 0 };
      const feedAvailable = availableResource(row.livestock.profile.feedResourceId);
      const availableWorkQd = whole(deps.workQdForBuilding(row.building, cycleLength, cycleIndex));
      const cycle = planLivestockTenday({
        state,
        profile: row.livestock.profile,
        elapsedQd: cycleLength,
        seasonId: season.seasonId,
        seasonKey: season.seasonKey,
        availableFeedUnits: feedAvailable,
        availableWorkQd,
        feedPriority: row.livestock.operations.feedPriority,
        operations,
        operationId: [text(operationId), buildingId, cycleIndex + 1].filter(Boolean).join(":")
      });
      state = clone(cycle.stateAfter);
      cycles.push(cycle);
      allChanges.push(...cycle.resourceChanges);
      warnings.push(...cycle.warnings);
      born += whole(cycle.born);
      matured += whole(cycle.matured);
      workQdUsed += whole(cycle.workQdUsed);
      consumePlannedResource(row.livestock.profile.feedResourceId, cycle.feeding.feedConsumed);
    }

    const changes = resourceTotals(allChanges);
    entries.push({
      buildingId,
      buildingName,
      speciesId: row.livestock.speciesId,
      profile: clone(row.livestock.profile),
      gmPriority: row.livestock.gmPriority,
      stateBefore,
      stateBeforeSignature: livestockStateSignature(stateBefore),
      stateAfter: clone(state),
      cycles,
      resourceChanges: changes,
      warnings: [...new Set(warnings)],
      born,
      matured,
      workQdUsed,
      resetOperations: ["shearQty", "slaughterQty", "slaughterBreedingMales"],
      ...(cycleLength < TENDAY_QD ? { remainingOperations: {
        shearQty: Math.max(0, whole(row.livestock.operations.shearQty) - cycles.reduce((sum, cycle) => sum + cycle.wool.shearedHeads, 0)),
        slaughterQty: Math.max(0, whole(row.livestock.operations.slaughterQty) - cycles.reduce((sum, cycle) => sum + cycle.slaughter.appliedQty, 0)),
        slaughterBreedingMales: Math.max(0, whole(row.livestock.operations.slaughterBreedingMales) - cycles.reduce((sum, cycle) => sum + cycle.slaughter.breedingMales, 0))
      } } : {})
    });
  }

  const changes = resourceTotals(entries.flatMap((entry) => entry.resourceChanges));
  return {
    version: 1,
    operationId: text(operationId),
    elapsedQd: periodQd,
    tendayCount,
    ignoredQd,
    entries,
    skipped,
    resourceChanges: changes,
    totals: {
      born: entries.reduce((sum, entry) => sum + entry.born, 0),
      matured: entries.reduce((sum, entry) => sum + entry.matured, 0),
      feedConsumed: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "animal-feed" && change.qty < 0).reduce((total, change) => total + whole(-change.qty), 0), 0),
      eggs: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "eggs" && change.qty > 0).reduce((total, change) => total + whole(change.qty), 0), 0),
      milk: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "milk" && change.qty > 0).reduce((total, change) => total + whole(change.qty), 0), 0),
      wool: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "wool" && change.qty > 0).reduce((total, change) => total + whole(change.qty), 0), 0),
      meat: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "meat" && change.qty > 0).reduce((total, change) => total + whole(change.qty), 0), 0),
      tallow: entries.reduce((sum, entry) => sum + entry.resourceChanges.filter((change) => change.resourceId === "tallow" && change.qty > 0).reduce((total, change) => total + whole(change.qty), 0), 0),
      workQdUsed: entries.reduce((sum, entry) => sum + entry.workQdUsed, 0)
    }
  };
}

function applyDependencies(dependencies = {}) {
  for (const name of ["getBuilding", "resourceQuantity", "consumeResource", "addResource", "setState", "resetOperations"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Livestock apply requires dependency "${name}".`);
  }
  return dependencies;
}

export function applyLivestockPeriodPlan({ plan, dependencies = {} } = {}) {
  const deps = applyDependencies(dependencies);
  if (!plan || typeof plan !== "object") return { ok: false, message: "План животноводства отсутствует." };

  for (const entry of plan.entries ?? []) {
    const building = deps.getBuilding(entry.buildingId);
    if (!building) return { ok: false, stale: true, message: `Здание ${entry.buildingName || entry.buildingId} больше не существует.` };
    const livestock = normalizeLivestockBuilding(building.livestock, { building });
    const current = normalizeLivestockState(livestock?.state, entry.profile);
    if (livestockStateSignature(current) !== text(entry.stateBeforeSignature)) {
      return { ok: false, stale: true, message: `Поголовье «${entry.buildingName || entry.buildingId}» изменилось после Preview.` };
    }
  }

  const requiredResources = new Map();
  for (const change of plan.resourceChanges ?? []) {
    const required = whole(-change.qty);
    if (required) requiredResources.set(change.resourceId, (requiredResources.get(change.resourceId) ?? 0) + required);
  }
  for (const [resourceId, required] of requiredResources) {
    if (whole(deps.resourceQuantity(resourceId)) < required) return { ok: false, stale: true, message: `После Preview не хватает ресурса ${resourceId}.` };
  }

  const receipts = [];
  for (const entry of plan.entries ?? []) {
    for (const change of entry.resourceChanges ?? []) {
      if (change.qty < 0) receipts.push(deps.consumeResource(change.resourceId, whole(-change.qty), entry));
      if (change.qty > 0) receipts.push(deps.addResource(change.resourceId, whole(change.qty), entry));
    }
    const building = deps.getBuilding(entry.buildingId);
    deps.setState(building, clone(entry.stateAfter));
    deps.resetOperations(building, entry.resetOperations, entry.remainingOperations);
  }

  return {
    ok: true,
    entries: clone(plan.entries ?? []),
    resourceChanges: clone(plan.resourceChanges ?? []),
    totals: clone(plan.totals ?? {}),
    receipts
  };
}
