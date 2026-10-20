import { clone, isPlainObject, toNumber } from "./utils.js";
import { isKnownHoldingOperationType } from "./operations.js";
import { advanceBuildingProject, buildingOperationalState } from "../core/building-state.js";
import { resourceMatchesMaterialGroup } from "../core/material-groups.js";
import { isMoneyResource, normalizeResourceId, resourceDef } from "../core/resources.js";
import {
  aggregateConstructionCosts,
  constructionCostsForStageRange,
  constructionCrewEligibility,
  constructionHasLegacyPrepayment,
  normalizeConstructionCosts
} from "../engines/economy/construction-stages.js";
import { normalizeStorageRoomId } from "../engines/storage/capacity.js";
import { constructionLeaderQualification } from "../engines/workers/construction-leadership.js";
import { holdingWorkerAdmissionIssues, workerAdmission } from "../engines/workers/building-qualification.js";
import {
  MAX_RESOURCE_BATCHES,
  reservedResourceBatchQuantities,
  resourceBatchTotal,
  syncResourceRowBatches,
  takeResourceBatches
} from "../core/resource-batches.js";
import { validateHoldingWorkAllocations } from "./work-allocations.js";
import { specialMoraleModifier } from "../core/special-effects.js";
import { isResidentAway, isResidentRestingOnShip } from "./resident-presence.js";
import { isSheriffAppointment } from "./control-appointments.js";
import { workforceChangeError } from "./workforce-plan.js";

const MAX_PLAYER_CHANGE_PATHS = 250;
const MAX_STORAGE_LOG_ROWS = 250;
const MAX_HOLDING_OPERATION_ROWS = 250;

export function buildPlayerPatch(current, proposed) {
  const baseRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const paths = diffPatchPaths(current, proposed).filter((path) => !isIgnorablePlayerDiff(path));
  return {
    baseRevision,
    action: inferPlayerPatchAction(paths),
    changes: paths.map((path) => {
      const value = getByPath(proposed, path);
      const oldValue = getByPath(current, path);
      const base = oldValue === undefined ? { oldMissing: true } : { oldValue: clone(oldValue) };
      return value === undefined
        ? { path, delete: true, ...base }
        : { path, value: clone(value), ...base };
    })
  };
}

export function validatePlayerPatch(current, patch, _userId = null) {
  if (!current || !patch || typeof patch !== "object") return { ok: false, error: "Некорректный patch-запрос игрока." };

  const currentRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const baseRevision = Math.max(0, toNumber(patch?.baseRevision, 0));
  if (!Number.isSafeInteger(patch?.baseRevision) || patch.baseRevision < 0 || baseRevision > currentRevision) {
    return { ok: false, error: "Некорректная будущая ревизия patch-запроса игрока." };
  }
  const changes = Array.isArray(patch.changes) ? patch.changes : [];
  if (!changes.length) return { ok: true, changes: [] };
  // A 200-resident plan is one atomic action. Keep the ordinary patch bound;
  // the larger bound applies only to the tightly validated workforce fields.
  const workforcePaths = changes.every((change) => /^holdings\.\d+\.(?:workforcePlan(?:\.|$)|people\.list\.\d+\.(?:workAllocationMode|workAllocations|workAssignment)(?:\.|$)|buildings\.list\.\d+\.assignedWorkerIds(?:\.|$)|log(?:\.|$))/.test(change?.path ?? ""));
  if (changes.length > (workforcePaths ? 4000 : MAX_PLAYER_CHANGE_PATHS)) return { ok: false, error: "Слишком много изменений за один запрос игрока." };

  const badChange = changes.find((change) => !change || typeof change !== "object" || !change.path || typeof change.path !== "string");
  if (badChange) return { ok: false, error: "Некорректный путь изменения в patch-запросе игрока." };

  const paths = changes.map((change) => change.path).filter((path) => !isIgnorablePlayerDiff(path));
  const unsafePath = paths.find((path) => hasUnsafePathSegment(path));
  if (unsafePath) return { ok: false, error: `Некорректный служебный сегмент пути: ${unsafePath}` };

  if (currentRevision > baseRevision) {
    const baseCheck = validatePatchBaseValues(current, changes);
    if (!baseCheck.ok) return baseCheck;
  }

  const changedHoldings = new Set(paths.map((path) => String(path).match(/^holdings\.(\d+)(?:\.|$)/)?.[1]).filter((value) => value !== undefined));
  if (changedHoldings.size !== 1) return { ok: false, error: "Игрок может менять только одно владение за один запрос." };

  const holdingIndex = Number(Array.from(changedHoldings)[0]);
  const holding = current?.holdings?.[holdingIndex];
  if (!holding || holding.visibility === "gm") return { ok: false, error: "Игрок не имеет доступа к этому владению." };

  const inferredAction = inferPlayerPatchAction(paths);
  const declaredAction = patch.action ? normalizePatchAction(patch.action) : "";
  if (patch.action && declaredAction !== inferredAction) {
    return { ok: false, error: "Заявленный тип действия не соответствует переданным изменениям." };
  }
  const action = declaredAction || inferredAction;
  if (!action) return { ok: false, error: "Не удалось определить действие игрока." };

  const wrongActionPaths = paths.filter((path) => patchActionForPath(path) !== action && !isPlayerActionSideEffect(action, path));
  if (wrongActionPaths.length) {
    const sample = wrongActionPaths.slice(0, 5).join(", ");
    return { ok: false, error: `Изменения смешивают разные действия: ${sample}` };
  }

  if (!isPlayerActionAllowed(action, holding)) return { ok: false, error: `Действие игрока запрещено настройками владения: ${action}.` };

  const denied = paths.filter((path) => action === "construction"
    ? !isPlayerConstructionWritablePath(path, current)
    : !isPlayerWritablePath(path, current, current));
  if (denied.length) {
    const sample = denied.slice(0, 5).join(", ");
    return { ok: false, error: `Игрок не имеет права менять эти данные: ${sample}` };
  }

  const tooLarge = changes.find((change) => change?.value !== undefined && JSON.stringify(change.value).length > 250_000);
  if (tooLarge) return { ok: false, error: `Слишком крупное изменение: ${tooLarge.path}` };

  const proposed = applyPlayerPatch(current, patch);
  const semantic = validatePlayerPatchSemantics(current, proposed, action, holdingIndex, paths);
  if (!semantic.ok) return semantic;

  return { ok: true, action, changes: paths };
}

function validatePatchBaseValues(current, changes = []) {
  for (const change of changes) {
    if (!change?.path || isIgnorablePlayerDiff(change.path) || hasUnsafePathSegment(change.path)) continue;
    const hasOldValue = Object.prototype.hasOwnProperty.call(change, "oldValue");
    const expectsMissing = change.oldMissing === true;
    if (!hasOldValue && !expectsMissing) {
      return { ok: false, error: "Данные владения устарели. Открой окно заново и повтори действие." };
    }

    const currentValue = getByPath(current, change.path);
    const matches = expectsMissing
      ? currentValue === undefined
      : sameJson(currentValue, change.oldValue);
    if (!matches) {
      return { ok: false, error: `Данные по пути ${change.path} уже изменились. Открой окно заново и повтори действие.` };
    }
  }
  return { ok: true };
}

export function applyPlayerPatch(current, patch) {
  const next = clone(current);
  const changes = Array.isArray(patch?.changes) ? patch.changes : [];
  for (const change of changes) {
    if (!change?.path || isIgnorablePlayerDiff(change.path)) continue;
    if (hasUnsafePathSegment(change.path)) continue;
    if (change.delete === true) deleteByPath(next, change.path);
    else setByPath(next, change.path, clone(change.value));
  }
  return next;
}

export function isPlayerWritablePath(path, current, proposed) {
  const match = String(path ?? "").match(/^holdings\.(\d+)\.(.+)$/);
  if (!match) return false;

  const index = Number(match[1]);
  const rest = match[2];
  const holding = current?.holdings?.[index];
  const nextHolding = proposed?.holdings?.[index] ?? holding;
  if (!holding || !nextHolding) return false;
  if (String(holding.id ?? "") !== String(nextHolding.id ?? "")) return false;
  if (holding.visibility === "gm") return false;

  const canEditOverview = holding?.gm?.playersCanEditOverview === true;
  const canEditBuildings = holding?.gm?.playersCanEditBuildings === true;
  const canUseStorage = holding?.gm?.playersCanUseStorage === true;
  const canEditResidents = holding?.gm?.playersCanEditResidents === true;
  const canEditDefense = holding?.gm?.playersCanEditDefense === true;
  const canEditBattle = holding?.gm?.playersCanEditBattle === true;
  const canEditSpecial = holding?.gm?.playersCanEditSpecial === true;

  if (canEditOverview && isPlayerOverviewPath(rest)) return true;
  if (canEditBuildings && isPlayerBuildingPath(rest)) return true;
  if (canUseStorage && isPlayerStoragePath(rest)) return true;
  if (canEditResidents && isPlayerResidentPath(rest)) return true;
  if (canEditDefense && isPlayerDefensePath(rest)) return true;
  if (canEditBattle && isPlayerBattlePath(rest)) return true;
  if (canEditSpecial && isPlayerSpecialPath(rest)) return true;
  return false;
}

function playerConstructionRestPathKind(rest = "") {
  const text = String(rest ?? "");
  if (/^buildings\.list\.\d+\.(buildProgress|lifecycle|constructionStatus|status|condition|repairOf|repairProgress|repairTarget)$/.test(text)) return "building";
  if (/^buildings\.list\.\d+\.(constructionMaterials|repair)(\.|$)/.test(text)) return "building";
  if (/^constructionCrews\.\d+\.(lastConstructionPeriod|lastConstructionOperationId)$/.test(text)) return "attempt";
  if (/^constructionCrews\.\d+\.(builderRerollMonth|builderRerollLastLeaderId|builderRerollLastAt)$/.test(text)) return "crew";
  if (/^storage\.resources\.\d+\.(?:qty|batches(?:\.\d+(?:\.(?:id|qty|ageQd))?)?)$/.test(text)) return "storage";
  if (/^storage\.moneyCopper$/.test(text)) return "storage";
  if (/^storage\.log(?:\.\d+)?(?:\.|$)/.test(text)) return "storage";
  return "";
}

function isPlayerConstructionRestPath(rest = "") {
  return Boolean(playerConstructionRestPathKind(rest));
}

function isPlayerConstructionPatchShape(paths = []) {
  const kinds = new Set();
  for (const path of paths) {
    if (isIgnorablePlayerDiff(path)) continue;
    const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
    const kind = playerConstructionRestPathKind(rest);
    if (!kind) return false;
    kinds.add(kind);
  }
  return kinds.has("attempt");
}

function isPlayerConstructionWritablePath(path, current) {
  const match = String(path ?? "").match(/^holdings\.(\d+)\.(.+)$/);
  if (!match) return false;
  const holding = current?.holdings?.[Number(match[1])];
  if (!holding || holding.visibility === "gm" || holding?.gm?.playersCanEditBuildings !== true) return false;
  return isPlayerConstructionRestPath(match[2]);
}

function inferPlayerPatchAction(paths = []) {
  if (isPlayerConstructionPatchShape(paths)) return "construction";
  const actions = new Set();
  for (const path of paths) {
    if (isIgnorablePlayerDiff(path)) continue;
    const action = patchActionForPath(path);
    if (action) actions.add(action);
  }
  if (!actions.size) return "noop";

  // Some UI operations have bookkeeping side effects in other domains. Keep those
  // grouped under the initiating action instead of accepting arbitrary mixed edits.
  if (actions.has("defense") && Array.from(actions).every((action) => ["defense", "buildings", "residents"].includes(action))) return "defense";
  if (actions.has("buildings") && Array.from(actions).every((action) => ["buildings", "residents"].includes(action))) return "buildings";

  return actions.size === 1 ? Array.from(actions)[0] : "mixed";
}

function normalizePatchAction(value = "") {
  const text = String(value ?? "");
  return ["noop", "overview", "buildings", "construction", "storage", "residents", "defense", "battle", "special", "mixed"].includes(text) ? text : "";
}

function patchActionForPath(path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  if (/^workforcePlan(?:\.|$)/.test(rest)) return "buildings";
  if (isPlayerOverviewPath(rest)) return "overview";
  if (/^gm\.massCombat(\.|$)/.test(rest)) return "battle";
  if (/^gm\.defense(\.|$)/.test(rest)) return "defense";
  if (/^storage\./.test(rest) && isPlayerStoragePath(rest)) return "storage";
  if (/^special\./.test(rest) && isPlayerSpecialPath(rest)) return "special";
  if (/^buildings\.|^constructionCrews|^constructionCrewIds(\.\d+)?$/.test(rest) && isPlayerBuildingPath(rest)) return "buildings";
  if (/^people\.list\.\d+\.(workAssignment|role|home)$/.test(rest)) return "buildings";
  if (/^people\.list\.\d+\.(workAllocationMode|workAllocations)(\.|$)/.test(rest)) return "buildings";
  if (/^people\./.test(rest) && isPlayerResidentPath(rest)) return "residents";
  return "";
}

function isPlayerActionSideEffect(action = "", path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  if (action === "defense") {
    return /^people\.list\.\d+\.(workAssignment|role|home)$/.test(rest)
      || /^buildings\.list\.\d+\.assignedWorkerIds(\.\d+)?$/.test(rest)
      || /^constructionCrews(\.\d+)?\.(memberIds|leaderId)(\.\d+)?$/.test(rest)
      || /^constructionCrewIds(\.\d+)?$/.test(rest);
  }
  if (action === "buildings") {
    return /^people\.list\.\d+\.(workAssignment|role|home)$/.test(rest)
      || /^people\.list\.\d+\.(workAllocationMode|workAllocations)(\.|$)/.test(rest)
      || /^log(?:\.\d+)?(?:\.|$)/.test(rest);
  }
  if (action === "construction") return isPlayerConstructionRestPath(rest);
  return false;
}

function isPlayerActionAllowed(action = "", holding = {}) {
  if (action === "noop") return true;
  if (action === "overview") return holding?.gm?.playersCanEditOverview === true;
  if (action === "buildings") return holding?.gm?.playersCanEditBuildings === true;
  if (action === "construction") return false;
  if (action === "storage") return holding?.gm?.playersCanUseStorage === true;
  if (action === "residents") return holding?.gm?.playersCanEditResidents === true;
  if (action === "defense") return holding?.gm?.playersCanEditDefense === true;
  if (action === "battle") return holding?.gm?.playersCanEditBattle === true;
  if (action === "special") return holding?.gm?.playersCanEditSpecial === true;
  return false;
}

function isPlayerOverviewPath(rest) {
  const text = String(rest ?? "");
  return /^(overview\.(description|publicNotes))$/.test(text);
}

function isPlayerResidentPath(rest) {
  const text = String(rest ?? "");
  if (text.startsWith("gm.")) return false;
  if (/^people\.list\.\d+\.workAllocations\.\d+\.(volunteer|volunteerReason)$/.test(text)) return false;
  if (text === "people.notes") return true;
  if (/^people\.list\.\d+\.(name|sex|culture|belief|race|subrace|appearance|notes)$/.test(text)) return true;
  return false;
}

function isPlayerDefensePath(rest) {
  const text = String(rest ?? "");
  if (/^gm\.defense\.(commanderId|notes)$/.test(text)) return true;
  if (/^gm\.defense\.squads(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^people\.list\.\d+\.(workAssignment|role|home)$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.assignedWorkerIds(\.\d+)?$/.test(text)) return true;
  if (/^constructionCrews\.\d+\.(memberIds|leaderId)(?:\.\d+)?$/.test(text)) return true;
  if (/^constructionCrewIds(\.\d+)?$/.test(text)) return true;
  return false;
}

function isPlayerBattlePath(rest) {
  const text = String(rest ?? "");
  const allowed = [
    "gm.massCombat.defenseMode",
    "gm.massCombat.useDefenseSquads",
    "gm.massCombat.raiseMilitia",
    "gm.massCombat.useMedicalSupplies",
    "gm.massCombat.useMedicinesForHeavyCasualties",
    "gm.massCombat.defenderPosition",
    "gm.massCombat.defenderHero",
    "gm.massCombat.defenderMorale",
    "gm.massCombat.defenderSpecial",
    "gm.massCombat.defenderStrategy",
    "gm.massCombat.notes"
  ];
  if (allowed.includes(text)) return true;
  if (/^gm\.massCombat\.defender(Infantry|Shooters|Mobile|Heavy|Sappers|Siege|Skirmishers|Monsters|Sacred)$/.test(text)) return true;
  if (/^gm\.massCombat\.defender[A-Z][A-Za-z0-9_]*-[A-Za-z0-9_-]*$/.test(text)) return true;
  return false;
}

function isPlayerSpecialPath(rest) {
  const text = String(rest ?? "");
  if (text.startsWith("gm.")) return false;
  if (text === "special.notes") return true;
  if (/^special\.list(\.\d+)?(\.|$)/.test(text)) return true;
  return false;
}

function isIgnorablePlayerDiff(path) {
  return path === "meta.lastUpdated"
    || path === "meta.revision"
    || path === "meta.schemaVersion"
    || path === "meta.templateCatalogVersion"
    || path === "meta.storageCommit"
    || path.startsWith("meta.storageCommit.");
}

function isPlayerBuildingPath(rest) {
  const text = String(rest ?? "");
  if (/^workforcePlan(?:\.|$)/.test(text)) return true;
  if (text.startsWith("gm.")) return false;
  if (/^people\.list\.\d+\.(workAssignment|role|home)$/.test(text)) return true;
  if (/^people\.list\.\d+\.(workAllocationMode|workAllocations)(\.|$)/.test(text)) return true;
  if (/^buildings\.list\.\d+\.(name|visibility|img|image|icon|constructionCrewId)$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.assignedWorkerIds(?:\.\d+)?$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.productionLines\.\d+\.(active|storageRoomId)$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.agriculture\.config\.(enabled|activeCropId|outputRoomId|gmPriority|sow|harvest)$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.maintenance\.priority$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.housing\.notes$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.religion\.(faith|customFaith|notes)$/.test(text)) return true;
  if (/^constructionCrews\.\d+\.(name|memberIds|leaderId|distributed|distributedIds|distributedLeaderId)(?:\.\d+)?$/.test(text)) return true;
  if (/^constructionCrewIds(\.\d+)?$/.test(text)) return true;
  if (/^log(?:\.\d+)?(?:\.|$)/.test(text)) return true;
  return false;
}

function isPlayerStoragePath(rest) {
  const text = String(rest ?? "");
  if (text.startsWith("gm.")) return false;
  if (/^storage\.notes$/.test(text)) return true;
  return false;
}

function validatePlayerPatchSemantics(current, proposed, action, holdingIndex, paths = []) {
  const holding = current?.holdings?.[holdingIndex];
  const nextHolding = proposed?.holdings?.[holdingIndex];
  if (!holding || !nextHolding) return { ok: false, error: "Владение игрока не найдено после применения patch." };
  if (String(holding.id ?? "") !== String(nextHolding.id ?? "")) {
    return { ok: false, error: "Игрок не может менять идентификатор владения." };
  }

  const immutablePath = paths.find((path) => isPlayerImmutablePath(path));
  if (immutablePath) return { ok: false, error: `Игрок не может менять служебный идентификатор: ${immutablePath}` };

  const duplicateIdError = validateUniqueRowIds(nextHolding);
  if (duplicateIdError) return { ok: false, error: duplicateIdError };
  const identityError = validateRowIdentityChanges(holding, nextHolding);
  if (identityError) return { ok: false, error: identityError };
  const workforceError = workforceChangeError(holding, nextHolding);
  if (workforceError) return { ok: false, error: workforceError };
  const oldOperationIds = new Set((holding.log ?? []).map((row) => row.operationId));
  const plannerOperation = (nextHolding.log ?? []).find((row) => row.payload?.workforcePlanner && !oldOperationIds.has(row.operationId));
  if (plannerOperation && plannerOperation.payload.expectedRevision !== Number(current.meta?.revision)) {
    return { ok: false, error: "Общий план устарел: поселение изменилось. Черновик нужно сверить заново." };
  }
  for (const person of nextHolding.people?.list ?? []) {
    const original = (holding.people?.list ?? []).find((row) => String(row.id) === String(person.id));
    for (const allocation of person.workAllocations ?? []) {
      if (allocation.volunteer !== true) continue;
      const prior = (original?.workAllocations ?? []).find((row) => String(row.id) === String(allocation.id));
      if (!prior?.volunteer || ["sourceId", "functionId", "volunteerReason"].some((key) => String(prior[key] ?? "") !== String(allocation[key] ?? ""))) {
        return { ok: false, error: "Договорённость о бесплатной работе назначает ведущий; переносить её на другую работу нельзя." };
      }
    }
  }
  const workAllocationCheck = validateHoldingWorkAllocations(nextHolding);
  if (!workAllocationCheck.ok) return { ok: false, error: workAllocationCheck.issues[0]?.message || "Некорректный план рабочих QD." };
  const admissionIssues = holdingWorkerAdmissionIssues(nextHolding);
  if (admissionIssues.length) return { ok: false, error: admissionIssues[0].message };

  if (action === "storage") return validatePlayerStorageSemantics(holding, nextHolding, paths);
  if (action === "special") return validatePlayerSpecialSemantics(holding, nextHolding);
  if (action === "construction") return validatePlayerConstructionSemantics(holding, nextHolding, paths);
  if (action === "buildings" || action === "defense") {
    const buildingCheck = validatePlayerBuildingSemantics(current, holding, nextHolding, paths);
    if (!buildingCheck.ok) return buildingCheck;
    if (action === "buildings" && paths.some((path) => /^holdings\.\d+\.log(?:\.|$)/.test(String(path ?? "")))) {
      return validateHoldingOperationLogAppendOnly(holding?.log, nextHolding?.log, { allowedTypes: new Set(["worker-assignment"]) });
    }
  }
  return { ok: true };
}

function validatePlayerSpecialSemantics(holding, nextHolding) {
  const before = new Map((holding.special?.list ?? []).map((row) => [String(row.id), row]));
  const after = new Map((nextHolding.special?.list ?? []).map((row) => [String(row.id), row]));
  const editable = new Set(["id", "name", "type", "notes"]);
  const protectedFields = (row) => Object.fromEntries(Object.entries(row ?? {}).filter(([key]) => !editable.has(key)));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(id), next = after.get(id);
    if (sameJson(old, next)) continue;
    if (old?.visibility === "gm" || next?.visibility === "gm"
      || !sameJson(protectedFields(old ?? { visibility: "public" }), protectedFields(next ?? { visibility: "public" }))
      || specialMoraleModifier(old) !== specialMoraleModifier(next)) {
      return { ok: false, error: "Игрок может редактировать текст публичных особых записей, но не эффекты и служебные поля." };
    }
    if (next && ["name", "type", "notes"].some((key) => next[key] != null
      && (typeof next[key] !== "string" || next[key].length > 20_000))) {
      return { ok: false, error: "Некорректный текст особой записи." };
    }
  }
  return { ok: true };
}

function validateHoldingOperationLogAppendOnly(beforeRaw = [], afterRaw = [], { allowedTypes = new Set() } = {}) {
  const before = Array.isArray(beforeRaw) ? beforeRaw : [];
  const after = Array.isArray(afterRaw) ? afterRaw : [];
  if (sameJson(before, after)) return { ok: true };
  // appendHoldingOperation retains the latest 250 entries. Allow exactly that
  // one-entry rotation, while still rejecting edits/deletions within the suffix.
  const dropped = Math.max(0, before.length + 1 - MAX_HOLDING_OPERATION_ROWS);
  const retained = before.slice(dropped);
  if (before.length > MAX_HOLDING_OPERATION_ROWS || after.length !== retained.length + 1) {
    return { ok: false, error: "Игрок может только добавить одну запись операции за команду." };
  }
  for (let index = 0; index < retained.length; index += 1) {
    if (!sameJson(retained[index], after[index])) return { ok: false, error: "Игрок не может переписывать журнал операций." };
  }
  const entry = after.at(-1);
  const type = String(entry?.type ?? "");
  const operationId = String(entry?.operationId ?? entry?.id ?? "");
  if (!entry || typeof entry !== "object" || !isKnownHoldingOperationType(type) || !allowedTypes.has(type)) {
    return { ok: false, error: "Недопустимый тип записи операции игрока." };
  }
  if (!operationId || operationId.length > 120 || String(entry.id ?? "") !== operationId) {
    return { ok: false, error: "Некорректный operationId записи операции." };
  }
  if (before.some((row) => String(row?.operationId ?? row?.id ?? "") === operationId)) {
    return { ok: false, error: "Идентификатор записи операции уже использован." };
  }
  if (String(entry.title ?? "").length > 300 || String(entry.summary ?? "").length > 2000) {
    return { ok: false, error: "Слишком длинное описание операции." };
  }
  if (toNumber(entry.assigned, -1) < 0 || toNumber(entry.cleared, -1) < 0) {
    return { ok: false, error: "Некорректные счётчики операции." };
  }
  if (!entry.payload || typeof entry.payload !== "object" || JSON.stringify(entry.payload).length > 20_000) {
    return { ok: false, error: "Некорректные данные операции." };
  }
  return { ok: true };
}

function isPlayerImmutablePath(path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  return /^(buildings\.list|people\.list|special\.list|storage\.resources|storage\.items)\.\d+\.(id|templateId)$/.test(rest);
}

function validateUniqueRowIds(holding = {}) {
  const checks = [
    ["building", holding?.buildings?.list],
    ["resident", holding?.people?.list],
    ["special", holding?.special?.list],
    ["storage resource", holding?.storage?.resources],
    ["storage item", holding?.storage?.items]
  ];
  for (const [label, rows] of checks) {
    if (!Array.isArray(rows)) continue;
    const ids = rows.map((row) => String(row?.id ?? "")).filter(Boolean);
    if (ids.length !== new Set(ids).size) return `Повторяющийся id в списке ${label}.`;
  }
  return "";
}

function validateRowIdentityChanges(holding = {}, nextHolding = {}) {
  const checks = [
    ["построек", holding?.buildings?.list, nextHolding?.buildings?.list],
    ["жителей", holding?.people?.list, nextHolding?.people?.list],
    ["особых записей", holding?.special?.list, nextHolding?.special?.list],
    ["ресурсов хранилища", holding?.storage?.resources, nextHolding?.storage?.resources],
    ["предметов хранилища", holding?.storage?.items, nextHolding?.storage?.items]
  ];

  for (const [label, beforeRows, afterRows] of checks) {
    if (!Array.isArray(beforeRows) || !Array.isArray(afterRows)) continue;
    const beforeIds = new Set(beforeRows.map((row) => String(row?.id ?? "")).filter(Boolean));
    const afterIds = new Set(afterRows.map((row) => String(row?.id ?? "")).filter(Boolean));
    const removed = [...beforeIds].filter((id) => !afterIds.has(id));
    const added = [...afterIds].filter((id) => !beforeIds.has(id));
    if (removed.length && added.length) {
      return `Игрок не может одновременно удалять и добавлять строки списка ${label} одним patch-запросом.`;
    }
  }
  return "";
}

function storageResourceIdentityForGuard(row = {}) {
  const resourceId = normalizeResourceId(row?.resourceId, row?.name, row?.label);
  if (resourceId !== "custom") return `resource:${resourceId}`;
  return `custom:${String(row?.name ?? row?.label ?? "").trim().toLocaleLowerCase("ru")}`;
}

function validatePlayerResourceBatchContinuity(holding = {}, nextHolding = {}) {
  const beforeRows = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const afterRows = Array.isArray(nextHolding?.storage?.resources) ? nextHolding.storage.resources : [];
  const beforeRowsById = new Map(beforeRows.map((row) => [String(row?.id ?? ""), row]));
  const beforeAges = new Map();
  const beforeTotals = new Map();
  const afterTotals = new Map();
  const beforeByIdentity = new Map();
  const afterByIdentity = new Map();

  for (const rawRow of beforeRows) {
    const row = syncResourceRowBatches(clone(rawRow), { compact: false });
    const identity = storageResourceIdentityForGuard(row);
    beforeTotals.set(identity, (beforeTotals.get(identity) ?? 0) + resourceBatchTotal(row.batches));
    if (!beforeByIdentity.has(identity)) beforeByIdentity.set(identity, []);
    beforeByIdentity.get(identity).push(...row.batches);
    for (const batch of row.batches) {
      const key = `${identity}\u0000${batch.id}`;
      beforeAges.set(key, Math.max(beforeAges.get(key) ?? 0, batch.ageQd));
    }

    const reserved = reservedResourceBatchQuantities(holding, rawRow);
    if (reserved.size) {
      const afterRow = afterRows.find((candidate) => String(candidate?.id ?? "") === String(rawRow?.id ?? ""));
      for (const [batchId, reservedQty] of reserved) {
        const afterQty = (afterRow?.batches ?? [])
          .filter((batch) => String(batch?.id ?? "") === batchId)
          .reduce((sum, batch) => sum + Math.max(0, Math.floor(Number(batch?.qty) || 0)), 0);
        if (afterQty < reservedQty) {
          return { ok: false, error: `Партия '${batchId}' зарезервирована для исходящей поставки и не может быть списана игроком.` };
        }
      }
    }
  }

  const introducedByIdentity = new Map();
  for (const rawRow of afterRows) {
    const beforeRow = beforeRowsById.get(String(rawRow?.id ?? ""));
    if (!Array.isArray(rawRow?.batches) && Object.prototype.hasOwnProperty.call(beforeRow ?? {}, "batches")) {
      return { ok: false, error: `Ресурс '${rawRow?.name ?? rawRow?.resourceId ?? "?"}' должен сохранять партии.` };
    }
    const row = Array.isArray(rawRow?.batches) ? rawRow : syncResourceRowBatches(clone(rawRow), { compact: false });
    const identity = storageResourceIdentityForGuard(row);
    afterTotals.set(identity, (afterTotals.get(identity) ?? 0) + resourceBatchTotal(row.batches));
    if (!afterByIdentity.has(identity)) afterByIdentity.set(identity, []);
    afterByIdentity.get(identity).push(...row.batches);
    for (const batch of row.batches) {
      const key = `${identity}\u0000${batch.id}`;
      const previousAge = beforeAges.get(key);
      if (previousAge !== undefined && batch.ageQd < previousAge) {
        return { ok: false, error: `Игрок не может омолаживать партию '${batch.id}'.` };
      }
      if (previousAge === undefined) {
        if (batch.ageQd !== 0) return { ok: false, error: `Новая партия '${batch.id}' должна иметь возраст 0 QD.` };
        introducedByIdentity.set(identity, (introducedByIdentity.get(identity) ?? 0) + batch.qty);
      }
    }
  }

  const identities = new Set([...beforeTotals.keys(), ...afterTotals.keys()]);
  for (const identity of identities) {
    const beforeTotal = beforeTotals.get(identity) ?? 0;
    const afterTotal = afterTotals.get(identity) ?? 0;
    const added = Math.max(0, afterTotal - beforeTotal);
    if ((introducedByIdentity.get(identity) ?? 0) > added) {
      return { ok: false, error: "Новые id партий могут появляться только для фактически добавленного запаса." };
    }
    const removed = Math.max(0, beforeTotal - afterTotal);
    const beforeBatches = beforeByIdentity.get(identity) ?? [];
    const afterBatches = afterByIdentity.get(identity) ?? [];
    const thresholds = new Set(beforeBatches.map((batch) => batch.ageQd).filter((ageQd) => ageQd > 0));
    for (const threshold of thresholds) {
      const beforeOld = beforeBatches.filter((batch) => batch.ageQd >= threshold).reduce((sum, batch) => sum + batch.qty, 0);
      const afterOld = afterBatches.filter((batch) => batch.ageQd >= threshold).reduce((sum, batch) => sum + batch.qty, 0);
      if (afterOld < Math.max(0, beforeOld - removed)) {
        return { ok: false, error: "Игрок не может заменять старый запас новым или уменьшать возраст партий." };
      }
    }
  }
  return { ok: true };
}

function validatePlayerStorageSemantics(holding = {}, nextHolding = {}, paths = []) {
  const storage = nextHolding?.storage ?? {};
  const moneyCopper = toNumber(storage.moneyCopper, 0);
  if (moneyCopper < 0) return { ok: false, error: "Казна хранилища не может быть отрицательной." };

  const resources = Array.isArray(storage.resources) ? storage.resources : [];
  const items = Array.isArray(storage.items) ? storage.items : [];
  for (const row of resources) {
    const qty = Number(row?.qty ?? 0);
    if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: `Ресурс '${row?.name ?? row?.resourceId ?? "?"}' должен иметь целое неотрицательное количество.` };
    if (Object.prototype.hasOwnProperty.call(row ?? {}, "batches")) {
      if (!Array.isArray(row.batches) || row.batches.length > MAX_RESOURCE_BATCHES) {
        return { ok: false, error: `Ресурс '${row?.name ?? row?.resourceId ?? "?"}' может иметь не более ${MAX_RESOURCE_BATCHES} партий.` };
      }
      const ids = new Set();
      for (const batch of row.batches) {
        const id = String(batch?.id ?? "").trim();
        const batchQty = Number(batch?.qty);
        const ageQd = Number(batch?.ageQd);
        if (!id || ids.has(id) || !Number.isInteger(batchQty) || batchQty <= 0 || !Number.isInteger(ageQd) || ageQd < 0) {
          return { ok: false, error: `Партии ресурса '${row?.name ?? row?.resourceId ?? "?"}' имеют недопустимый id, возраст или количество.` };
        }
        ids.add(id);
      }
      if (resourceBatchTotal(row.batches) !== qty) {
        return { ok: false, error: `Количество ресурса '${row?.name ?? row?.resourceId ?? "?"}' не совпадает с суммой его партий.` };
      }
    }
  }
  for (const row of items) {
    const qty = toNumber(row?.qty ?? row?.quantity ?? row?.itemData?.system?.quantity ?? row?.system?.quantity ?? 1, 1);
    if (qty < 0) return { ok: false, error: `Предмет '${row?.name ?? "?"}' не может иметь отрицательное количество.` };
  }

  const batchContinuity = validatePlayerResourceBatchContinuity(holding, nextHolding);
  if (!batchContinuity.ok) return batchContinuity;

  if (paths.some((path) => /^holdings\.\d+\.storage\.log(\.|$)/.test(String(path ?? "")))) {
    const logCheck = validateStorageLogAppendOnly(holding?.storage?.log, storage.log);
    if (!logCheck.ok) return logCheck;
  }

  return { ok: true };
}

function changedConstructionIndexes(paths = [], pattern) {
  return new Set(paths
    .map((path) => String(path ?? "").replace(/^holdings\.\d+\./, "").match(pattern)?.[1])
    .filter((value) => value !== undefined)
    .map(Number));
}

function constructionCostKeyForGuard(row = {}) {
  const group = String(row?.resourceGroup ?? "").trim();
  const resourceId = String(row?.resourceId ?? row?.id ?? "").trim();
  const name = String(row?.name ?? row?.label ?? resourceId ?? "Материал").trim().toLocaleLowerCase("ru");
  const identity = group ? `group:${group}` : `resource:${resourceId}:${name}`;
  const roomId = row?.roomId === undefined && row?.storageRoomId === undefined
    ? ""
    : String(row?.roomId ?? row?.storageRoomId ?? "").trim();
  return `${identity}:room:${roomId}`;
}

function subtractConstructionCostsForGuard(source = [], spent = []) {
  const rows = aggregateConstructionCosts(source);
  const byKey = new Map(rows.map((row) => [constructionCostKeyForGuard(row), row]));
  for (const cost of normalizeConstructionCosts(spent)) {
    const row = byKey.get(constructionCostKeyForGuard(cost));
    if (!row || row.qty < cost.qty) return null;
    row.qty -= cost.qty;
  }
  return rows.filter((row) => row.qty > 0);
}

function constructionCostIncreaseForGuard(beforeRaw = [], afterRaw = []) {
  const before = aggregateConstructionCosts(beforeRaw);
  const after = aggregateConstructionCosts(afterRaw);
  const afterByKey = new Map(after.map((row) => [constructionCostKeyForGuard(row), row]));
  const beforeByKey = new Map(before.map((row) => [constructionCostKeyForGuard(row), row]));
  for (const row of before) {
    const next = afterByKey.get(constructionCostKeyForGuard(row));
    if (!next || next.qty < row.qty) return { ok: false, rows: [] };
  }
  const rows = after
    .map((row) => ({ ...row, qty: row.qty - (beforeByKey.get(constructionCostKeyForGuard(row))?.qty ?? 0) }))
    .filter((row) => row.qty > 0);
  return { ok: true, rows: aggregateConstructionCosts(rows) };
}

function sourceConstructionMaterialStateForGuard(holding = {}, building = {}) {
  const current = building?.constructionMaterials && typeof building.constructionMaterials === "object"
    ? building.constructionMaterials
    : null;
  const target = Math.max(1, Math.floor(toNumber(building?.buildTarget, 1)));
  const progress = Math.min(target, Math.max(0, Math.floor(toNumber(building?.buildProgress, 0))));
  if (current) {
    return {
      version: 1,
      mode: current.mode === "legacy-prepaid" ? "legacy-prepaid" : "staged",
      target: Math.max(1, Math.floor(toNumber(current.target, target))),
      totalCosts: normalizeConstructionCosts(current.totalCosts?.length ? current.totalCosts : building.materialCosts),
      spent: aggregateConstructionCosts(current.spent),
      prepaidRemaining: aggregateConstructionCosts(current.prepaidRemaining),
      cancelled: current.cancelled === true,
      cancelOperationId: String(current.cancelOperationId ?? "").trim(),
      refund: aggregateConstructionCosts(current.refund)
    };
  }

  const totalCosts = normalizeConstructionCosts(building?.materialCosts);
  const prepaid = constructionHasLegacyPrepayment(holding, building);
  return {
    version: 1,
    mode: prepaid ? "legacy-prepaid" : "staged",
    target,
    totalCosts,
    spent: prepaid ? constructionCostsForStageRange(totalCosts, target, 1, progress) : [],
    prepaidRemaining: prepaid ? constructionCostsForStageRange(totalCosts, target, progress + 1, target) : [],
    cancelled: false,
    cancelOperationId: "",
    refund: []
  };
}

function canonicalConstructionMaterialStateForGuard(state = {}, spent = state.spent, prepaidRemaining = state.prepaidRemaining) {
  return {
    version: 1,
    mode: state.mode === "legacy-prepaid" ? "legacy-prepaid" : "staged",
    target: Math.max(1, Math.floor(toNumber(state.target, 1))),
    totalCosts: normalizeConstructionCosts(state.totalCosts),
    spent: aggregateConstructionCosts(spent),
    prepaidRemaining: aggregateConstructionCosts(prepaidRemaining),
    cancelled: state.cancelled === true,
    cancelOperationId: String(state.cancelOperationId ?? "").trim(),
    refund: aggregateConstructionCosts(state.refund)
  };
}

function storageChargesForConstruction(holding = {}, nextHolding = {}) {
  const beforeRows = Array.isArray(holding?.storage?.resources) ? holding.storage.resources : [];
  const afterRows = Array.isArray(nextHolding?.storage?.resources) ? nextHolding.storage.resources : [];
  if (beforeRows.length !== afterRows.length) return { ok: false, rows: [], error: "Строительный бросок не может добавлять или удалять строки хранилища." };
  const rows = [];
  for (let index = 0; index < beforeRows.length; index += 1) {
    const before = beforeRows[index];
    const after = afterRows[index];
    const canonicalBefore = syncResourceRowBatches(clone(before));
    const beforeQtyRaw = Number(canonicalBefore?.qty ?? 0);
    const afterQtyRaw = Number(after?.qty ?? 0);
    if (!Number.isInteger(beforeQtyRaw) || !Number.isInteger(afterQtyRaw) || beforeQtyRaw < 0 || afterQtyRaw < 0) {
      return { ok: false, rows: [], error: "Строительные материалы в хранилище должны оставаться целыми и неотрицательными." };
    }
    if (afterQtyRaw > beforeQtyRaw) return { ok: false, rows: [], error: "Строительный бросок не может добавлять материалы в хранилище." };
    const expectedRow = clone(canonicalBefore);
    takeResourceBatches(expectedRow, beforeQtyRaw - afterQtyRaw, { holding });
    if (!sameJson(expectedRow, after)) return { ok: false, rows: [], error: "Строительный бросок должен списывать партии материалов по FIFO и не может заменять строки хранилища." };
    if (afterQtyRaw < beforeQtyRaw) {
      rows.push({
        resourceId: String(before?.resourceId ?? before?.id ?? "custom"),
        name: String(before?.name ?? before?.label ?? "Ресурс"),
        roomId: normalizeStorageRoomId(before?.roomId ?? before?.storageRoomId),
        qty: beforeQtyRaw - afterQtyRaw,
        sourceRow: before,
        money: false
      });
    }
  }
  const beforeMoney = Number(holding?.storage?.moneyCopper ?? 0);
  const afterMoney = Number(nextHolding?.storage?.moneyCopper ?? 0);
  if (!Number.isInteger(beforeMoney) || !Number.isInteger(afterMoney) || beforeMoney < 0 || afterMoney < 0) {
    return { ok: false, rows: [], error: "Казна строительства должна оставаться целой и неотрицательной." };
  }
  if (afterMoney > beforeMoney) return { ok: false, rows: [], error: "Строительный бросок не может увеличивать казну." };
  if (afterMoney < beforeMoney) {
    rows.push({ resourceId: "money", name: "Деньги", roomId: "", qty: beforeMoney - afterMoney, sourceRow: null, money: true });
  }
  return { ok: true, rows };
}

function constructionChargeMatchesCost(charge = {}, cost = {}) {
  const hasRoom = cost?.roomId !== undefined || cost?.storageRoomId !== undefined;
  if (hasRoom && normalizeStorageRoomId(charge.roomId) !== normalizeStorageRoomId(cost.roomId ?? cost.storageRoomId)) return false;
  const group = String(cost?.resourceGroup ?? "").trim();
  if (group) {
    if (charge.money || charge?.sourceRow?.noAutoConsume === true) return false;
    const id = normalizeResourceId(charge?.sourceRow?.resourceId, charge?.sourceRow?.id, charge?.sourceRow?.name);
    const definition = id === "custom" ? null : resourceDef(id);
    return definition?.noAutoConsume !== true && resourceMatchesMaterialGroup(charge.sourceRow, group, definition);
  }
  const expectedMoney = isMoneyResource(cost?.resourceId, cost?.id, cost?.name);
  if (expectedMoney || charge.money) return expectedMoney && charge.money;
  const chargeId = normalizeResourceId(charge?.resourceId, charge?.name);
  const costId = normalizeResourceId(cost?.resourceId, cost?.id, cost?.name);
  if (chargeId !== costId) return false;
  if (chargeId !== "custom") return true;
  return String(charge?.name ?? "").trim().toLocaleLowerCase("ru") === String(cost?.name ?? "").trim().toLocaleLowerCase("ru");
}

function constructionChargesCoverCosts(chargesRaw = [], costsRaw = []) {
  const charges = chargesRaw.map((row) => ({ ...row, qty: Math.max(0, Math.floor(toNumber(row?.qty, 0))) })).filter((row) => row.qty > 0);
  const costs = normalizeConstructionCosts(costsRaw);
  const chargeTotal = charges.reduce((sum, row) => sum + row.qty, 0);
  const costTotal = costs.reduce((sum, row) => sum + row.qty, 0);
  if (chargeTotal !== costTotal) return false;
  if (!costTotal) return true;

  const source = 0;
  const firstCharge = 1;
  const firstCost = firstCharge + charges.length;
  const sink = firstCost + costs.length;
  const capacity = Array.from({ length: sink + 1 }, () => Array(sink + 1).fill(0));
  charges.forEach((row, index) => { capacity[source][firstCharge + index] = row.qty; });
  costs.forEach((row, index) => { capacity[firstCost + index][sink] = row.qty; });
  for (let chargeIndex = 0; chargeIndex < charges.length; chargeIndex += 1) {
    for (let costIndex = 0; costIndex < costs.length; costIndex += 1) {
      if (constructionChargeMatchesCost(charges[chargeIndex], costs[costIndex])) {
        capacity[firstCharge + chargeIndex][firstCost + costIndex] = costTotal;
      }
    }
  }

  let flow = 0;
  while (true) {
    const parent = Array(sink + 1).fill(-1);
    parent[source] = source;
    const queue = [source];
    while (queue.length && parent[sink] < 0) {
      const node = queue.shift();
      for (let next = 0; next <= sink; next += 1) {
        if (parent[next] < 0 && capacity[node][next] > 0) {
          parent[next] = node;
          queue.push(next);
        }
      }
    }
    if (parent[sink] < 0) break;
    let amount = Number.POSITIVE_INFINITY;
    for (let node = sink; node !== source; node = parent[node]) amount = Math.min(amount, capacity[parent[node]][node]);
    for (let node = sink; node !== source; node = parent[node]) {
      capacity[parent[node]][node] -= amount;
      capacity[node][parent[node]] += amount;
    }
    flow += amount;
  }
  return flow === costTotal;
}

function validateConstructionRerollFields(crew = {}, nextCrew = {}) {
  const keys = ["builderRerollMonth", "builderRerollLastLeaderId", "builderRerollLastAt"];
  if (!keys.some((key) => String(crew?.[key] ?? "") !== String(nextCrew?.[key] ?? ""))) return { ok: true };
  const month = String(nextCrew?.builderRerollMonth ?? "").trim();
  const leaderId = String(nextCrew?.builderRerollLastLeaderId ?? "").trim();
  const usedAt = String(nextCrew?.builderRerollLastAt ?? "").trim();
  if (!month || month === String(crew?.builderRerollMonth ?? "").trim()
    || leaderId !== String(crew?.leaderId ?? "").trim()
    || !Number.isFinite(Date.parse(usedAt))) {
    return { ok: false, error: "Строительный бросок содержит некорректную отметку переброса Builder." };
  }
  return { ok: true };
}

function validatePlayerConstructionSemantics(holding = {}, nextHolding = {}, paths = []) {
  if (!isPlayerConstructionPatchShape(paths)) {
    return { ok: false, error: "Строительная операция содержит посторонние изменения." };
  }
  const buildingIndexes = changedConstructionIndexes(paths, /^buildings\.list\.(\d+)\./);
  const crewIndexes = changedConstructionIndexes(paths, /^constructionCrews\.(\d+)\./);
  if (buildingIndexes.size > 1 || crewIndexes.size !== 1) {
    return { ok: false, error: "Один строительный бросок может менять только один проект и одну бригаду." };
  }

  const crewIndex = Array.from(crewIndexes)[0];
  const crew = holding?.constructionCrews?.[crewIndex];
  const nextCrew = nextHolding?.constructionCrews?.[crewIndex];
  if (!crew || !nextCrew || String(crew.id ?? "") !== String(nextCrew.id ?? "")) return { ok: false, error: "Стройбригада не найдена при проверке строительной операции." };
  const eligibility = constructionCrewEligibility({ holding, crewId: String(crew.id ?? "") });
  if (!eligibility.ok) return { ok: false, error: eligibility.message };

  const expectedPeriod = Math.floor(Math.max(0, toNumber(holding?.gm?.calendaria?.lastQd, 0)) / 40) + 1;
  const oldPeriod = Math.max(0, Math.floor(toNumber(crew.lastConstructionPeriod, 0)));
  const nextPeriod = Math.max(0, Math.floor(toNumber(nextCrew.lastConstructionPeriod, 0)));
  if (oldPeriod >= expectedPeriod || nextPeriod !== expectedPeriod) {
    return { ok: false, error: "Стройбригада уже использовала бросок этого десятника или передала неверный период." };
  }
  const operationId = String(nextCrew.lastConstructionOperationId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    return { ok: false, error: "Строительный бросок не содержит корректный operationId." };
  }
  if (operationId === String(crew.lastConstructionOperationId ?? "").trim()) {
    return { ok: false, error: "Новая строительная попытка должна иметь новый operationId." };
  }
  const rerollCheck = validateConstructionRerollFields(crew, nextCrew);
  if (!rerollCheck.ok) return rerollCheck;

  if (!buildingIndexes.size) {
    const hasNonCrewChange = paths.some((path) => {
      const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
      return !["attempt", "crew"].includes(playerConstructionRestPathKind(rest));
    });
    const hasAssignedProject = (holding?.buildings?.list ?? []).some((row) => {
      if (String(row?.constructionCrewId ?? "") !== String(crew.id ?? "")) return false;
      const state = buildingOperationalState(row);
      if (state.repairActive) return true;
      const progress = Math.max(0, Math.floor(toNumber(row?.buildProgress, 0)));
      const target = Math.max(1, Math.floor(toNumber(row?.buildTarget, 1)));
      return ["planned", "building"].includes(state.lifecycle) && progress < target && row?.constructionMaterials?.cancelled !== true;
    });
    if (hasNonCrewChange || !hasAssignedProject) return { ok: false, error: "Неуспешный бросок не привязан к доступному проекту этой бригады." };
    return { ok: true };
  }

  const buildingIndex = Array.from(buildingIndexes)[0];
  const building = holding?.buildings?.list?.[buildingIndex];
  const nextBuilding = nextHolding?.buildings?.list?.[buildingIndex];
  if (!building || !nextBuilding) return { ok: false, error: "Проект не найден при проверке строительной операции." };
  if (String(building.constructionCrewId ?? "") !== String(crew.id ?? "")
    || String(nextBuilding.constructionCrewId ?? "") !== String(nextCrew.id ?? "")) {
    return { ok: false, error: "Строительный бросок сделан не назначенной на проект бригадой." };
  }

  if (nextBuilding?.constructionMaterials?.cancelled === true) {
    return { ok: false, error: "Обычный строительный бросок не может отменять проект." };
  }

  const storageCheck = validatePlayerStorageSemantics(holding, nextHolding, paths);
  if (!storageCheck.ok) return storageCheck;
  const chargeResult = storageChargesForConstruction(holding, nextHolding);
  if (!chargeResult.ok) return chargeResult;
  const logDelta = storageLogAppendDelta(holding?.storage?.log, nextHolding?.storage?.log);
  if (!logDelta.ok) return logDelta;
  const appended = logDelta.appended;
  if (appended.some((row) => String(row?.kind ?? "") !== "construction-material"
    || toNumber(row?.qty, 0) >= 0
    || String(row?.operationId ?? "") !== operationId)) {
    return { ok: false, error: "Списание строительства не подтверждено корректной записью лога." };
  }
  const logCharges = appended.map((row) => ({
    resourceId: String(row?.resourceId ?? row?.id ?? "custom"),
    name: String(row?.name ?? "Ресурс"),
    roomId: isMoneyResource(row?.resourceId, row?.id, row?.name) ? "" : normalizeStorageRoomId(row?.roomId ?? row?.storageRoomId),
    qty: Math.abs(Math.floor(toNumber(row?.qty, 0))),
    sourceRow: null,
    money: isMoneyResource(row?.resourceId, row?.id, row?.name)
  }));
  if (!constructionChargesCoverCosts(chargeResult.rows, logCharges) || !constructionChargesCoverCosts(logCharges, chargeResult.rows)) {
    return { ok: false, error: "Лог строительства не совпадает с фактическим списанием хранилища." };
  }

  const operational = buildingOperationalState(building);
  const repairActive = operational.repairActive === true;
  const oldProgress = Math.max(0, Math.floor(toNumber(repairActive ? (building?.repair?.progress ?? building?.repairProgress) : building?.buildProgress, 0)));
  const nextProgress = Math.max(0, Math.floor(toNumber(repairActive ? (nextBuilding?.repair?.progress ?? nextBuilding?.repairProgress) : nextBuilding?.buildProgress, 0)));
  const target = Math.max(1, Math.floor(toNumber(repairActive ? (building?.repair?.target ?? building?.repairTarget) : building?.buildTarget, 1)));
  if (nextProgress < oldProgress || nextProgress > target) return { ok: false, error: "Строительный прогресс уменьшен или превышает цель проекта." };
  const appliedStages = nextProgress - oldProgress;
  const expectedBuilding = clone(building);
  const expectedProgress = advanceBuildingProject(expectedBuilding, appliedStages);
  if (String(nextBuilding?.status ?? "") !== String(building?.status ?? "")) {
    expectedBuilding.status = expectedProgress.completed ? "Построено" : (repairActive ? "Ремонтируется" : "Строится");
  }

  if (repairActive) {
    if (chargeResult.rows.length || appended.length) return { ok: false, error: "Текущий ремонт не должен списывать строительные материалы." };
    if (!sameJson(expectedBuilding, nextBuilding)) return { ok: false, error: "Изменения ремонта не соответствуют результату одной строительной попытки." };
    return { ok: true };
  }

  const state = sourceConstructionMaterialStateForGuard(holding, building);
  if (state.cancelled) return { ok: false, error: "Отменённый проект не может принимать строительный бросок." };
  state.target = target;
  const stageCosts = constructionCostsForStageRange(state.totalCosts, target, oldProgress + 1, nextProgress);
  let expectedState;
  if (state.mode === "legacy-prepaid") {
    if (chargeResult.rows.length || appended.length) return { ok: false, error: "Ранее оплаченный проект не должен повторно списывать материалы." };
    const prepaidRemaining = subtractConstructionCostsForGuard(state.prepaidRemaining, stageCosts);
    if (!prepaidRemaining) return { ok: false, error: "Прогресс ранее оплаченного проекта превышает оставшиеся оплаченные стадии." };
    expectedState = canonicalConstructionMaterialStateForGuard(state, [...state.spent, ...stageCosts], prepaidRemaining);
  } else {
    const nextState = nextBuilding?.constructionMaterials;
    const increase = constructionCostIncreaseForGuard(state.spent, nextState?.spent);
    if (!increase.ok || increase.rows.some((row) => String(row?.resourceGroup ?? "").trim())) {
      return { ok: false, error: "Учёт фактически потраченных строительных материалов повреждён." };
    }
    if (!constructionChargesCoverCosts(chargeResult.rows, stageCosts)
      || !constructionChargesCoverCosts(chargeResult.rows, increase.rows)
      || !constructionChargesCoverCosts(increase.rows, chargeResult.rows)) {
      return { ok: false, error: "Списание материалов не соответствует стоимости завершённых стадий." };
    }
    expectedState = canonicalConstructionMaterialStateForGuard(state, nextState?.spent, state.prepaidRemaining);
  }
  expectedBuilding.constructionMaterials = expectedState;
  if (!sameJson(expectedBuilding, nextBuilding)) {
    const mismatch = diffPatchPaths(expectedBuilding, nextBuilding).slice(0, 5).join(", ");
    return { ok: false, error: `Изменения проекта не соответствуют результату одной строительной попытки: ${mismatch}` };
  }
  return { ok: true };
}

function storageLogAppendDelta(beforeRaw = [], afterRaw = []) {
  const before = Array.isArray(beforeRaw) ? beforeRaw : [];
  const after = Array.isArray(afterRaw) ? afterRaw : [];
  if (after.length > MAX_STORAGE_LOG_ROWS) return { ok: false, error: "Лог хранилища превышает допустимый размер." };

  for (let dropped = 0; dropped <= before.length; dropped += 1) {
    const retained = before.slice(dropped);
    if (retained.length > after.length || (before.length && !retained.length)) continue;
    if (retained.some((entry, index) => !sameJson(entry, after[index]))) continue;
    const appended = after.slice(retained.length);
    const expectedDropped = Math.max(0, before.length + appended.length - MAX_STORAGE_LOG_ROWS);
    if (dropped !== expectedDropped) continue;
    for (const entry of appended) {
      if (!entry || typeof entry !== "object") return { ok: false, error: "Некорректная новая запись лога хранилища." };
      if (!String(entry.kind ?? "").trim()) return { ok: false, error: "Запись лога хранилища должна иметь тип." };
      if (!Number.isFinite(Number(entry.qty))) return { ok: false, error: "Запись лога хранилища должна иметь числовое количество." };
    }
    return { ok: true, appended, dropped };
  }
  return { ok: false, error: "Игрок не может очищать, укорачивать или переписывать существующие записи лога хранилища." };
}

function validateStorageLogAppendOnly(beforeRaw = [], afterRaw = []) {
  const result = storageLogAppendDelta(beforeRaw, afterRaw);
  return result.ok ? { ok: true } : result;
}

function validatePlayerBuildingSemantics(_current = {}, holding = {}, nextHolding = {}, paths = []) {
  const before = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const after = Array.isArray(nextHolding?.buildings?.list) ? nextHolding.buildings.list : [];
  const beforeById = new Map(before.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));
  const beforeIds = before.map((row) => String(row?.id ?? ""));
  const afterIds = after.map((row) => String(row?.id ?? ""));
  if (!sameJson(beforeIds, afterIds)) {
    return { ok: false, error: "Игрок не может добавлять, удалять или переставлять постройки через общий patch." };
  }

  const residents = Array.isArray(nextHolding?.people?.list) ? nextHolding.people.list : [];
  const residentsById = new Map(residents.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));
  const residentIds = new Set(residentsById.keys());
  const explicitResidentIds = new Set(residents
    .filter((row) => String(row?.workAllocationMode ?? "") === "explicit")
    .map((row) => String(row?.id ?? ""))
    .filter(Boolean));
  const crewRows = Array.isArray(nextHolding?.constructionCrews) ? nextHolding.constructionCrews : [];
  const crewIds = new Set(crewRows.map((row) => String(row?.id ?? "")).filter(Boolean));
  const defense = nextHolding?.gm?.defense ?? {};
  const defenseChanged = !sameJson(holding?.gm?.defense, nextHolding?.gm?.defense);
  const defenseResidentIds = new Set();
  const defenseIds = [String(defense?.commanderId ?? "")].filter(Boolean);
  for (const squad of defense?.squads ?? []) {
    if (defenseChanged && (!Array.isArray(squad.memberIds) || squad.memberIds.length > 4)) {
      return { ok: false, error: "В отряде допускается не больше четырёх бойцов и одного старшего." };
    }
    const sergeantId = String(squad?.sergeantId ?? "");
    if (sergeantId) defenseIds.push(sergeantId);
    for (const memberId of Array.isArray(squad?.memberIds) ? squad.memberIds : []) {
      const id = String(memberId ?? "");
      if (id) defenseIds.push(id);
    }
  }
  for (const id of defenseIds) {
    const person = residentsById.get(id);
    if (defenseChanged && (defenseResidentIds.has(id) || !person || person.dead || Number(person.injuredDays ?? 0) > 0
      || isResidentAway(person) || isResidentRestingOnShip(person, nextHolding))) {
      return { ok: false, error: "Состав обороны содержит повторного, отсутствующего или недоступного жителя." };
    }
    defenseResidentIds.add(id);
  }
  const assignmentOwnerByResidentId = new Map(Array.from(defenseResidentIds, (id) => [id, "defense"]));
  const touchedPersonIds = new Set(paths.map((path) => {
    const index = String(path ?? "").match(/^holdings\.\d+\.people\.list\.(\d+)\.(?:workAssignment|role)$/)?.[1];
    return index === undefined ? "" : String(residents[Number(index)]?.id ?? "");
  }).filter(Boolean));

  const canReceiveWork = (person = {}) => {
    if (!person || person.dead || Math.max(0, toNumber(person?.injuredDays, 0)) > 0) return false;
    const ageGroup = String(person?.ageGroup ?? "");
    const child = ageGroup === "Ре" || /реб|child/i.test(ageGroup);
    return !child || Math.max(0, toNumber(person?.age, 0)) >= 12;
  };

  const claimAssignment = (personId, owner, label) => {
    if (explicitResidentIds.has(personId)) return "";
    const person = residentsById.get(personId);
    if (!canReceiveWork(person)) return `Нельзя назначить на работу недоступного жителя: ${person?.name ?? personId}`;
    const existing = assignmentOwnerByResidentId.get(personId);
    if (existing && existing !== owner) return `Житель '${person?.name ?? personId}' одновременно назначен в несколько мест (${existing}, ${label}).`;
    assignmentOwnerByResidentId.set(personId, owner);
    return "";
  };

  for (const row of after) {
    const id = String(row?.id ?? "");
    if (!id) return { ok: false, error: "Постройка игрока должна иметь id." };
    const old = beforeById.get(id);
    if (!old) return { ok: false, error: "Игрок не может создавать постройки через общий patch." };
    if (String(old.templateId ?? "") !== String(row?.templateId ?? "")) {
      return { ok: false, error: `Игрок не может менять templateId существующей постройки: ${row?.name ?? id}` };
    }

    const workers = Array.isArray(row?.assignedWorkerIds) ? row.assignedWorkerIds.map((value) => String(value ?? "")).filter(Boolean) : [];
    const workerLimit = Math.max(0, Math.floor(toNumber(old?.workersMax, 0)));
    if (workers.length > workerLimit || workers.length !== new Set(workers).size || workers.some((workerId) => !residentIds.has(workerId))) {
      return { ok: false, error: `Некорректное назначение работников в постройке: ${row?.name ?? id}` };
    }
    for (const workerId of workers) {
      const resident = residentsById.get(workerId);
      const admission = workerAdmission(row, resident);
      if (admission.hard && !admission.eligible && !admission.overridden) {
        return { ok: false, error: `Работник '${resident?.name ?? workerId}' не проходит обязательный допуск постройки '${row?.name ?? id}': ${admission.text}.` };
      }
      if (explicitResidentIds.has(workerId)) {
        return { ok: false, error: "Житель с явным планом QD не может одновременно занимать legacy-слот постройки." };
      }
      const owner = `building:${id}`;
      const claimError = claimAssignment(workerId, owner, row?.name ?? id);
      if (claimError) return { ok: false, error: claimError };
      if (String(residentsById.get(workerId)?.workAssignment ?? "") !== id) {
        return { ok: false, error: `Рабочий '${residentsById.get(workerId)?.name ?? workerId}' не подтверждает назначение в постройку '${row?.name ?? id}'.` };
      }
    }
    const crewId = String(row?.constructionCrewId ?? "");
    if (crewId && !crewIds.has(crewId)) {
      return { ok: false, error: `Назначенная стройбригада не найдена: ${row?.name ?? id}` };
    }
  }

  const beforeCrews = Array.isArray(holding?.constructionCrews) ? holding.constructionCrews : [];
  if (!sameJson(beforeCrews.map((row) => String(row?.id ?? "")), crewRows.map((row) => String(row?.id ?? "")))) {
    return { ok: false, error: "Игрок не может добавлять, удалять или переставлять стройбригады через общий patch." };
  }
  for (const crew of crewRows) {
    const crewId = String(crew?.id ?? "");
    const memberIds = Array.isArray(crew?.memberIds) ? crew.memberIds.map((value) => String(value ?? "")).filter(Boolean) : [];
    const distributedIds = Array.isArray(crew?.distributedIds) ? crew.distributedIds.map((value) => String(value ?? "")).filter(Boolean) : [];
    const leaderId = String(crew?.leaderId ?? "");
    const distributedLeaderId = String(crew?.distributedLeaderId ?? "");
    if (memberIds.length !== new Set(memberIds).size || memberIds.some((id) => !residentIds.has(id))) {
      return { ok: false, error: `Стройбригада '${crew?.name ?? crew?.id ?? "?"}' содержит некорректных участников.` };
    }
    if (distributedIds.length !== new Set(distributedIds).size || distributedIds.some((id) => !residentIds.has(id))) {
      return { ok: false, error: `Стройбригада '${crew?.name ?? crew?.id ?? "?"}' содержит некорректное распределение.` };
    }
    if (distributedLeaderId && !distributedIds.includes(distributedLeaderId)) {
      return { ok: false, error: `Распределённый бригадир должен входить в сохранённый состав стройбригады '${crew?.name ?? crew?.id ?? "?"}'.` };
    }
    if (leaderId && memberIds.includes(leaderId)) {
      return { ok: false, error: `Руководитель не может одновременно занимать рабочий слот стройбригады '${crew?.name ?? crew?.id ?? "?"}'.` };
    }
    for (const memberId of memberIds) {
      if (explicitResidentIds.has(memberId)) return { ok: false, error: "Житель с явным планом QD не может одновременно входить в стройбригаду." };
      const owner = `crew:${crewId}`;
      const claimError = claimAssignment(memberId, owner, crew?.name ?? crewId);
      if (claimError) return { ok: false, error: claimError };
      if (String(residentsById.get(memberId)?.workAssignment ?? "") !== `construction:${crewId}`) {
        return { ok: false, error: `Участник '${residentsById.get(memberId)?.name ?? memberId}' не подтверждает назначение в стройбригаду '${crew?.name ?? crewId}'.` };
      }
    }
    if (leaderId) {
      const leader = residentsById.get(leaderId);
      if (!leader || explicitResidentIds.has(leaderId) || !constructionLeaderQualification(leader).eligible) {
        return { ok: false, error: `У стройбригады '${crew?.name ?? crewId}' назначен неподходящий руководитель.` };
      }
      const owner = `crew-leader:${crewId}`;
      const claimError = claimAssignment(leaderId, owner, crew?.name ?? crewId);
      if (claimError) return { ok: false, error: claimError };
      if (String(leader?.workAssignment ?? "") !== `construction-leader:${crewId}`) {
        return { ok: false, error: `Руководитель '${leader?.name ?? leaderId}' не подтверждает отдельное назначение в стройбригаду '${crew?.name ?? crewId}'.` };
      }
    }
  }

  const buildingsById = new Map(after.map((row) => [String(row?.id ?? ""), row]));
  const crewsById = new Map(crewRows.map((row) => [String(row?.id ?? ""), row]));
  for (const personId of touchedPersonIds) {
    const person = residentsById.get(personId);
    if (!person) return { ok: false, error: "Изменённый житель не найден." };
    const assignment = String(person?.workAssignment ?? "");
    const role = String(person?.role ?? "");
    const owner = assignmentOwnerByResidentId.get(personId) ?? "";
    if (explicitResidentIds.has(personId)) {
      if (assignment) return { ok: false, error: "Житель с явным планом QD не должен иметь legacy-назначение." };
      continue;
    }
    if (!assignment) {
      if (owner && owner !== "defense") return { ok: false, error: "Освобождённый житель остался в рабочем слоте." };
      if (role && !["Свободен", "Без работы", "Ребенок"].includes(role)) {
        return { ok: false, error: "Свободному жителю передана несогласованная рабочая роль." };
      }
      continue;
    }
    const building = buildingsById.get(assignment);
    if (building) {
      if (owner !== `building:${assignment}`) return { ok: false, error: "Назначение жителя не совпадает с рабочим слотом постройки." };
      const expectedRole = String(building?.workerRole || building?.name || "Работает в здании");
      if (role !== expectedRole) return { ok: false, error: "Рабочая роль жителя не соответствует назначенной постройке." };
      continue;
    }
    if (assignment === "other" && isSheriffAppointment(person) && !owner && canReceiveWork(person)
      && !isResidentAway(person) && !isResidentRestingOnShip(person, nextHolding)) continue;
    if (assignment.startsWith("construction:")) {
      const crewId = assignment.slice("construction:".length);
      const crew = crewsById.get(crewId);
      if (!crew || owner !== `crew:${crewId}`) return { ok: false, error: "Назначение жителя не совпадает с составом стройбригады." };
      const expectedRole = String(crew?.name ?? "Стройбригада");
      if (role !== expectedRole) return { ok: false, error: "Рабочая роль жителя не соответствует стройбригаде." };
      continue;
    }
    if (assignment.startsWith("construction-leader:")) {
      const crewId = assignment.slice("construction-leader:".length);
      const crew = crewsById.get(crewId);
      if (!crew || owner !== `crew-leader:${crewId}` || String(crew?.leaderId ?? "") !== personId) {
        return { ok: false, error: "Назначение руководителя не совпадает с отдельной должностью стройбригады." };
      }
      const expectedRole = `Руководитель: ${String(crew?.name ?? "Стройбригада")}`;
      if (role !== expectedRole) return { ok: false, error: "Рабочая роль руководителя не соответствует стройбригаде." };
      continue;
    }
    if (assignment === "soldier" && defenseResidentIds.has(personId)) continue;
    if (assignment === "defenseCommander" && String(defense?.commanderId ?? "") === personId) continue;
    return { ok: false, error: `Недопустимое или несогласованное назначение жителя: ${assignment}` };
  }

  return { ok: true };
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function hasUnsafePathSegment(path = "") {
  return String(path ?? "").split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part));
}

function diffPatchPaths(left, right, base = "", output = []) {
  if (left === right) return output;

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      if (base) output.push(base);
      return output;
    }

    if (shouldPatchWholeArray(left, right)) {
      if (base) output.push(base);
      return output;
    }

    for (let index = 0; index < left.length; index += 1) {
      const path = base ? `${base}.${index}` : String(index);
      diffPatchPaths(left[index], right[index], path, output);
    }
    return output;
  }

  const leftObject = isPlainObject(left);
  const rightObject = isPlainObject(right);
  if (!leftObject || !rightObject) {
    if (base) output.push(base);
    return output;
  }

  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const key of keys) {
    const path = base ? `${base}.${key}` : String(key);
    diffPatchPaths(left?.[key], right?.[key], path, output);
  }
  return output;
}

function shouldPatchWholeArray(left = [], right = []) {
  if (left.length !== right.length) return true;
  const leftHasIds = left.every((item) => isPlainObject(item) && "id" in item);
  const rightHasIds = right.every((item) => isPlainObject(item) && "id" in item);
  if (leftHasIds || rightHasIds) {
    if (!leftHasIds || !rightHasIds) return true;
    for (let index = 0; index < left.length; index += 1) {
      if (String(left[index]?.id ?? "") !== String(right[index]?.id ?? "")) return true;
    }
  }
  return false;
}

function getByPath(source, path) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  let value = source;
  for (const part of parts) {
    if (value == null) return undefined;
    value = value[part];
  }
  return value;
}

function setByPath(target, path, value) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!parts.length) return target;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    const nextKey = parts[index + 1];
    if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = /^\d+$/.test(nextKey) ? [] : {};
    cursor = cursor[key];
  }
  cursor[parts.at(-1)] = value;
  return target;
}

function deleteByPath(target, path) {
  const parts = String(path ?? "").split(".").filter(Boolean);
  if (!parts.length) return false;
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    cursor = cursor?.[parts[index]];
    if (cursor == null) return false;
  }
  const key = parts.at(-1);
  if (Array.isArray(cursor) && /^\d+$/.test(key)) cursor.splice(Number(key), 1);
  else delete cursor[key];
  return true;
}
