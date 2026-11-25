import { stableDataHash } from "./storage-commit.js";
import { DEFAULT_NORMAL_LABOR_QD, residentLaborCapacity } from "./labor-budget.js";
import { buildingCompositionStatus, workerAdmission } from "../engines/workers/building-qualification.js";
import { isSheriffAppointment } from "./control-appointments.js";
import { isResidentPresent, residentShipAssignment } from "./resident-presence.js";

export const LABOR_SCHEMA_VERSION = 2;

export function laborMigrationSourceHash(data) {
  return stableDataHash([data.meta, data.holdings, data.catalog]);
}

function records(value) {
  return Array.isArray(value) ? value : [];
}

export function hasLegacyBuildingLabor(building) {
  return Boolean(building?.labor?.mode || records(building?.assignedWorkerIds).some(Boolean));
}

export function hasLegacyResidentLabor(person) {
  return Boolean(person?.staffAppointment || Number(person?.salaryModifier));
}

export function hasLegacyLabor(data = {}) {
  return records(data?.catalog?.buildings).some(hasLegacyBuildingLabor) || records(data?.holdings).some((holding) => (
    records(holding?.buildings?.list).some(hasLegacyBuildingLabor)
    || records(holding?.people?.list).some(hasLegacyResidentLabor)
    || records(holding?.workforcePlan?.goals).length > 0
  ));
}
export const MAX_PRODUCTION_GOAL_UNITS = 1_000_000;

function text(value = "") {
  return String(value ?? "").trim();
}

function nonNegInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.floor(num));
}

export function laborTargetKey(sourceId = "", functionId = "") {
  const src = text(sourceId);
  const fn = text(functionId);
  return src && fn ? `${src}::${fn}` : src;
}

/**
 * Normalize building labor capacity to the unified v2 contract:
 * `{ version: 2, capacityQd: 0 | positiveInt | null }`.
 * - `0`: no workers accepted (passive building)
 * - `null`: unlimited / bounded by production lines, fields, or herds
 * - positive int: max QD/tenday accepted by this building
 */
export function normalizeBuildingLabor(value, building = {}) {
  const fallbackCap = Math.max(
    nonNegInt(building?.workersMax, nonNegInt(building?.workerProfile?.workersMax, 0)) * DEFAULT_NORMAL_LABOR_QD,
    buildingMinOperationalQd(building)
  );

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: LABOR_SCHEMA_VERSION, capacityQd: fallbackCap };
  }

  const mode = text(value.mode);
  if (mode === "passive") return { version: LABOR_SCHEMA_VERSION, capacityQd: 0 };
  if (mode === "staff" || mode === "legacy") {
    const explicitCap = value.capacityQd !== null && value.capacityQd !== undefined && value.capacityQd !== ""
      ? nonNegInt(value.capacityQd, fallbackCap)
      : fallbackCap;
    return { version: LABOR_SCHEMA_VERSION, capacityQd: explicitCap };
  }
  if (value.capacityQd === null) return { version: LABOR_SCHEMA_VERSION, capacityQd: null };
  if (value.capacityQd !== undefined && value.capacityQd !== "") {
    return { version: LABOR_SCHEMA_VERSION, capacityQd: nonNegInt(value.capacityQd, fallbackCap) };
  }
  if (mode === "qd") return { version: LABOR_SCHEMA_VERSION, capacityQd: null };
  return { version: LABOR_SCHEMA_VERSION, capacityQd: fallbackCap };
}

export function buildingLaborCapacityQd(building = {}) {
  return normalizeBuildingLabor(building?.labor, building).capacityQd;
}

export function buildingAcceptsWorkers(building = {}) {
  const cap = buildingLaborCapacityQd(building);
  return cap === null || cap > 0;
}

export function uncollectibleProductionLine(building = {}) {
  return (building?.productionLines ?? []).find((line) => (
    line?.active !== false
    && line?.requiresCollection === true
    && Number(line?.collectQd) > 0
    && !buildingAcceptsWorkers(building)
    && String(line?.autoCollect ?? "none") !== "worker"
  )) ?? null;
}

/**
 * Total planned + overtime QD currently reserved on `buildingId` across living, present residents.
 * Used uniformly by planner capacity labels, quick assignments, and Control picks.
 */
export function buildingWorkReservations(holding = {}, { excludePersonId = "", presentIds = null } = {}) {
  const excludedId = text(excludePersonId);
  const totals = new Map();
  for (const person of holding?.people?.list ?? []) {
    if (!person || text(person.id) === excludedId) continue;
    if (presentIds ? !presentIds.has(text(person.id)) : person.dead || !isResidentPresent(person)) continue;
    for (const row of Array.isArray(person.workAllocations) ? person.workAllocations : []) {
      const buildingId = text(row?.sourceId);
      if (!buildingId) continue;
      const qd = nonNegInt(row?.normalQd ?? row?.qd, 0) + nonNegInt(row?.overtimeQd, 0);
      if (qd) totals.set(buildingId, (totals.get(buildingId) ?? 0) + qd);
    }
  }
  return totals;
}

export function buildingReservedQd(holding = {}, buildingId = "", options = {}) {
  return buildingWorkReservations(holding, options).get(text(buildingId)) ?? 0;
}

export function buildingMinOperationalQd(building = {}) {
  const explicit = building?.activation?.minOperationalQd ?? building?.minOperationalQd;
  if (explicit !== undefined && explicit !== null && explicit !== "") {
    return nonNegInt(explicit, 0);
  }
  return 0;
}

export function productionPreparationGoal(holding = {}, sourceId = "", functionId = "") {
  const goals = holding?.workforcePlan?.productionGoals;
  const src = text(sourceId);
  const fn = text(functionId);
  if (Array.isArray(goals)) {
    const forBuilding = goals.filter((row) => text(row?.sourceId) === src);
    const match = forBuilding.find((row) => text(row?.functionId) === fn)
      ?? forBuilding.find((row) => !text(row?.functionId))
      ?? (!fn ? forBuilding[0] : null);
    return Math.min(MAX_PRODUCTION_GOAL_UNITS, nonNegInt(match?.preparedUnits, 0));
  }
  if (!goals || typeof goals !== "object") return 0;
  const key = laborTargetKey(src, fn);
  const raw = goals[key] ?? goals[src];
  return Math.min(MAX_PRODUCTION_GOAL_UNITS, nonNegInt(raw?.preparedUnits ?? raw, 0));
}

export function reservedOccupation(holding = {}, person = {}) {
  const personId = text(person?.id);
  const workAssignment = text(person?.workAssignment);

  if (personId) {
    for (const crew of holding?.constructionCrews ?? []) {
      const name = text(crew?.name || crew?.id) || "Стройбригада";
      if (text(crew?.leaderId) === personId || text(crew?.distributedLeaderId) === personId) {
        return { kind: "construction", label: `Руководитель стройбригады «${name}»` };
      }
      if ((crew?.memberIds ?? []).some((id) => text(id) === personId)
        || (crew?.distributedIds ?? []).some((id) => text(id) === personId)) {
        return { kind: "construction", label: `Стройбригада «${name}»` };
      }
    }
    if ((holding?.constructionCrewIds ?? []).some((id) => text(id) === personId)) {
      return { kind: "construction", label: "Строительная бригада" };
    }

    const defense = holding?.gm?.defense ?? {};
    if (text(defense?.commanderId) === personId) {
      return { kind: "defense", label: "Командующий обороной" };
    }
    for (const squad of defense?.squads ?? []) {
      const squadName = text(squad?.name || squad?.id) || "Отряд";
      if (text(squad?.sergeantId) === personId) {
        return { kind: "defense", label: `Командир отряда «${squadName}»` };
      }
      if ((squad?.memberIds ?? []).some((id) => text(id) === personId)) {
        return { kind: "defense", label: `Отряд «${squadName}»` };
      }
    }

    const voyage = residentShipAssignment(person);
    if (voyage?.away === true) {
      return { kind: "ship", label: "В плавании" };
    }
    const onShoreDuty = voyage?.shoreDuty === true;
    const shoreShipId = text(voyage?.shipId);

    for (const ship of holding?.special?.ships?.list ?? []) {
      if (onShoreDuty && (!shoreShipId || text(ship?.id) === shoreShipId)) continue;
      if ((ship?.crewResidentIds ?? []).some((id) => text(id) === personId)) {
        return { kind: "ship", label: `Экипаж: ${text(ship?.name || ship?.id) || "корабль"}` };
      }
    }
  }

  if (workAssignment === "construction" || workAssignment.startsWith("construction-leader:") || workAssignment.startsWith("construction:")) {
    return { kind: "construction", label: "Стройбригада" };
  }
  if (workAssignment === "soldier" || workAssignment === "defenseCommander") {
    return { kind: "defense", label: "Военная служба" };
  }
  if (workAssignment.startsWith("ship:") && residentShipAssignment(person)?.shoreDuty !== true) {
    return { kind: "ship", label: "Экипаж корабля" };
  }
  if (workAssignment === "sheriff" || workAssignment === "other" || isSheriffAppointment(person)) {
    return { kind: "control", label: text(person?.role) || "Особая должность" };
  }
  return null;
}

function issueKey(issue = {}) {
  return [
    text(issue?.code),
    text(issue?.buildingId || issue?.sourceId),
    text(issue?.functionId),
    text(issue?.personId)
  ].join("|");
}

export function newLaborIssues(previous = [], current = []) {
  const remaining = [...(Array.isArray(previous) ? previous : [])];
  return (Array.isArray(current) ? current : []).filter((issue) => {
    const key = issueKey(issue);
    const index = remaining.findIndex((prior) => {
      if (issueKey(prior) !== key) return false;
      const actualOk = issue?.actual === undefined || prior?.actual === undefined || Number(prior.actual) >= Number(issue.actual);
      const limitOk = issue?.limit === undefined || prior?.limit === undefined || Number(prior.limit) <= Number(issue.limit);
      return actualOk && limitOk;
    });
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

/**
 * Validate unified QD allocations, building capacities, hard resident
 * admissions, and required specialist compositions across the whole holding.
 * Pass `targets` from `buildWorkAllocationTargets(holding)`.
 */
export function validateBuildingLaborAndGoals(holding = {}, { targets = null, skipResidentBudget = false } = {}) {
  const issues = [];
  const warnings = [];
  const buildingsById = new Map((holding?.buildings?.list ?? []).map((b) => [text(b?.id), b]));
  const hasExplicitTargets = targets instanceof Map || Array.isArray(targets);
  const targetList = targets instanceof Map ? [...targets.values()] : (Array.isArray(targets) ? targets : []);
  const targetsByKey = new Map();
  for (const target of targetList) {
    const key = text(target?.key) || laborTargetKey(target?.sourceId, target?.functionId);
    if (key) targetsByKey.set(key, target);
  }

  const buildingQd = new Map();
  const buildingWorkers = new Map();

  for (const person of holding?.people?.list ?? []) {
    if (person?.dead || !isResidentPresent(person)) continue;
    const personId = text(person?.id);
    const personName = text(person?.name || personId) || "Житель";
    const allocations = Array.isArray(person?.workAllocations) ? person.workAllocations : [];
    const positive = allocations.filter((row) => nonNegInt(row?.normalQd ?? row?.qd, 0) + nonNegInt(row?.overtimeQd, 0) > 0);
    if (!positive.length) continue;

    if (!skipResidentBudget) {
      const reserved = reservedOccupation(holding, person);
      if (reserved) {
        issues.push({
          code: "reserved-occupation",
          personId,
          message: `${personName}: занят (${reserved.label}) и не может получать гражданские QD.`
        });
      }
    }

    const cap = residentLaborCapacity(person, holding);
    const maxTotal = cap.normalQd + cap.overtimeQd;
    let totalNormalQd = 0;
    let totalOvertimeQd = 0;
    let totalQd = 0;
    let nonOvertimeQd = 0;

    for (const row of positive) {
      const sourceId = text(row?.sourceId);
      const functionId = text(row?.functionId);
      const rowNormalQd = nonNegInt(row?.normalQd ?? row?.qd, 0);
      const rowOvertimeQd = nonNegInt(row?.overtimeQd, 0);
      const qd = rowNormalQd + rowOvertimeQd;
      totalNormalQd += rowNormalQd;
      totalOvertimeQd += rowOvertimeQd;
      totalQd += qd;
      const key = laborTargetKey(sourceId, functionId);
      const target = targetsByKey.get(key) ?? targetsByKey.get(sourceId) ?? null;
      if (target && target.overtimeAllowed === false) {
        nonOvertimeQd += qd;
        if (rowOvertimeQd > 0 && !skipResidentBudget) {
          issues.push({
            code: "overtime-disallowed",
            personId,
            sourceId,
            functionId,
            actual: rowOvertimeQd,
            limit: 0,
            message: `${personName}: задача «${key || sourceId}» не разрешает переработку.`
          });
        }
      }
      const building = buildingsById.get(text(target?.buildingId || sourceId));
      if (!building || !buildingAcceptsWorkers(building)) {
        if (!skipResidentBudget) {
          issues.push({
            code: "invalid-target",
            personId,
            sourceId,
            functionId,
            message: `${personName}: здание или задача «${sourceId}» не принимает работников.`
          });
        }
        continue;
      }
      if (hasExplicitTargets && !target && !skipResidentBudget) {
        issues.push({
          code: "invalid-target",
          personId,
          buildingId: text(building.id),
          sourceId,
          functionId,
          message: `${personName}: выбранная задача «${key || sourceId}» недоступна.`
        });
      }

      const admission = workerAdmission(building, person);
      if (admission?.hard && !admission.eligible && !admission.overridden) {
        issues.push({
          code: "admission-denied",
          personId,
          buildingId: text(building.id),
          sourceId,
          functionId,
          actual: qd,
          limit: 0,
          message: `${personName}: не допущен в «${building.name || building.id}» (${admission.text || "допуск закрыт"}).`
        });
      }

      const bId = text(building.id);
      buildingQd.set(bId, (buildingQd.get(bId) ?? 0) + qd);
      if (!buildingWorkers.has(bId)) buildingWorkers.set(bId, new Map());
      buildingWorkers.get(bId).set(personId, person);
    }

    if (!skipResidentBudget && nonOvertimeQd > cap.normalQd) {
      issues.push({
        code: "overtime-disallowed",
        personId,
        actual: nonOvertimeQd,
        limit: cap.normalQd,
        message: `${personName}: на задачи без переработки выделено ${nonOvertimeQd} QD при обычном бюджете ${cap.normalQd} QD.`
      });
    }

    if (!skipResidentBudget && totalNormalQd > cap.normalQd) {
      issues.push({
        code: "resident-normal-cap",
        personId,
        actual: totalNormalQd,
        limit: cap.normalQd,
        message: `${personName}: обычный труд (${totalNormalQd} QD) превышает бюджет ${cap.normalQd} QD.`
      });
    }

    if (!skipResidentBudget && totalOvertimeQd > cap.overtimeQd) {
      issues.push({
        code: "resident-overtime-cap",
        personId,
        actual: totalOvertimeQd,
        limit: cap.overtimeQd,
        message: `${personName}: переработка (${totalOvertimeQd} QD) превышает предел ${cap.overtimeQd} QD.`
      });
    }

    if (!skipResidentBudget && totalOvertimeQd > Math.floor(totalNormalQd / 2)) {
      issues.push({
        code: "resident-overtime-days",
        personId,
        actual: totalOvertimeQd,
        limit: Math.floor(totalNormalQd / 2),
        message: `${personName}: каждый QD переработки требует два обычных рабочих QD.`
      });
    }

    if (!skipResidentBudget && totalQd > maxTotal) {
      issues.push({
        code: "resident-budget-exceeded",
        personId,
        actual: totalQd,
        limit: maxTotal,
        message: `${personName}: назначено ${totalQd} QD при пределе ${maxTotal} QD (${cap.normalQd} + ${cap.overtimeQd} переработка).`
      });
    }
  }

  for (const [buildingId, totalQd] of buildingQd.entries()) {
    const building = buildingsById.get(buildingId);
    if (!building) continue;
    const capQd = buildingLaborCapacityQd(building);
    if (capQd !== null && totalQd > capQd) {
      issues.push({
        code: "building-capacity-exceeded",
        buildingId,
        actual: totalQd,
        limit: capQd,
        message: `«${building.name || buildingId}»: назначено ${totalQd} QD при пределе ${capQd} QD.`
      });
    }
    const workers = [...(buildingWorkers.get(buildingId)?.values() ?? [])];
    const composition = buildingCompositionStatus(building, workers, { excludeGroups: ["ЧУДОТВОРЕЦ"] });
    if (!composition.met) {
      warnings.push({
        code: "composition-unmet",
        buildingId,
        message: `«${building.name || buildingId}»: не выполнен обязательный состав (${composition.text}).`
      });
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}
