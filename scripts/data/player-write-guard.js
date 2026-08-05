import { clone, isPlainObject, toNumber } from "./utils.js";
import { isKnownHoldingOperationType } from "./operations.js";
import { EMPLOYMENT_MODE_IDS, EMPLOYMENT_SEASON_IDS } from "./labor/employment-terms.js";
import { WAGE_CLASS_IDS } from "./labor/wage-catalog.js";

const MAX_PLAYER_CHANGE_PATHS = 250;

export function buildPlayerPatch(current, proposed, { action = "" } = {}) {
  const baseRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const paths = diffPatchPaths(current, proposed).filter((path) => !isIgnorablePlayerDiff(path));
  return {
    baseRevision,
    action: normalizePatchAction(action) || inferPlayerPatchAction(paths),
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
  const changes = Array.isArray(patch.changes) ? patch.changes : [];
  if (!changes.length) return { ok: true, changes: [] };
  if (changes.length > MAX_PLAYER_CHANGE_PATHS) return { ok: false, error: "Слишком много изменений за один запрос игрока." };

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

  const action = normalizePatchAction(patch.action || inferPlayerPatchAction(paths));
  if (!action) return { ok: false, error: "Не удалось определить действие игрока." };

  const wrongActionPaths = paths.filter((path) => patchActionForPath(path) !== action && !isPlayerActionSideEffect(action, path));
  if (wrongActionPaths.length) {
    const sample = wrongActionPaths.slice(0, 5).join(", ");
    return { ok: false, error: `Изменения смешивают разные действия: ${sample}` };
  }

  if (!isPlayerActionAllowed(action, holding)) return { ok: false, error: `Действие игрока запрещено настройками владения: ${action}.` };

  const denied = paths.filter((path) => !isPlayerWritablePath(path, current, current) && !isPlayerActionSideEffect(action, path));
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

function inferPlayerPatchAction(paths = []) {
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
  return ["noop", "overview", "buildings", "storage", "residents", "defense", "battle", "special", "mixed"].includes(text) ? text : "";
}

function patchActionForPath(path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  if (/^buildings\.list\.\d+\.enterpriseCapital(?:\.|$)/.test(rest)) return "buildings";
  if (isPlayerOverviewPath(rest)) return "overview";
  if (/^gm\.massCombat(\.|$)/.test(rest)) return "battle";
  if (/^gm\.defense(\.|$)/.test(rest)) return "defense";
  if (/^storage\./.test(rest) && isPlayerStoragePath(rest)) return "storage";
  if (/^special\./.test(rest) && isPlayerSpecialPath(rest)) return "special";
  if (/^buildings\.|^constructionCrews|^constructionCrewIds(\.\d+)?$/.test(rest) && isPlayerBuildingPath(rest)) return "buildings";
  if (/^people\./.test(rest)) return "residents";
  return "";
}

function isPlayerActionSideEffect(action = "", path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  if (action === "defense") {
    return /^people\.list\.\d+\.(workAssignment|role|salary|salaryCopper|salaryNote|baseWageDaily|cashWageDaily|compensationType|boardFoodDaily|foodProvisionMode|housingProvided|shareRate|compensationNote|wageClassId|employmentMode|employmentContractStartQd|employmentContractEndQd|employmentSeasonMask(?:\.(?:spring|summer|autumn|winter))?|volunteerReason|volunteerTermStartQd|volunteerTermEndQd|coercionBasis)$/.test(rest)
      || /^buildings\.list\.\d+\.assignedWorkerIds(\.\d+)?$/.test(rest)
      || /^constructionCrews(\.\d+)?\.(memberIds|leaderId)(\.\d+)?$/.test(rest)
      || /^constructionCrewIds(\.\d+)?$/.test(rest);
  }
  if (action === "buildings") {
    return /^people\.list\.\d+\.(workAssignment|role|home|salary|salaryCopper|salaryNote|baseWageDaily|cashWageDaily|compensationType|boardFoodDaily|foodProvisionMode|housingProvided|shareRate|compensationNote|wageClassId|employmentMode|employmentContractStartQd|employmentContractEndQd|employmentSeasonMask(?:\.(?:spring|summer|autumn|winter))?|volunteerReason|volunteerTermStartQd|volunteerTermEndQd|coercionBasis)$/.test(rest)
      || /^log(?:\.\d+)?(?:\.|$)/.test(rest);
  }
  if (action === "residents") return isResidentAssignmentSideEffectPath(rest);
  return false;
}

function isResidentAssignmentSideEffectPath(rest = "") {
  const text = String(rest ?? "");
  return /^buildings\.list\.\d+\.assignedWorkerIds(?:\.\d+)?$/.test(text)
    || /^constructionCrews\.\d+\.(?:memberIds(?:\.\d+)?|leaderId)$/.test(text)
    || /^gm\.defense\.(?:commanderId|squads\.\d+\.(?:sergeantId|memberIds(?:\.\d+)?))$/.test(text)
    || /^special\.fleet\.vessels\.\d+\.crew\.memberIds(?:\.\d+)?$/.test(text);
}

function isPlayerActionAllowed(action = "", holding = {}) {
  if (action === "noop") return true;
  if (action === "overview") return holding?.gm?.playersCanEditOverview === true;
  if (action === "buildings") return holding?.gm?.playersCanEditBuildings === true;
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
  if (/^people\.list\.\d+\.hungerStreakTendays$/.test(text)) return false;
  if (text === "people.notes") return true;
  if (/^people\.list(\.\d+)?(\.|$)/.test(text)) return true;
  return false;
}

function isPlayerDefensePath(rest) {
  const text = String(rest ?? "");
  if (/^gm\.defense\.(commanderId|notes)$/.test(text)) return true;
  if (/^gm\.defense\.squads(\.\d+)?(\.|$)/.test(text)) return true;

  // Defense assignments update residents and clear them from older jobs.
  // These are bookkeeping side effects of forming squads, not hidden GM edits.
  if (/^people\.list\.\d+\.(workAssignment|role|salary|salaryCopper|salaryNote|baseWageDaily|cashWageDaily|compensationType|boardFoodDaily|foodProvisionMode|housingProvided|shareRate|compensationNote|wageClassId|employmentMode|employmentContractStartQd|employmentContractEndQd|employmentSeasonMask(?:\.(?:spring|summer|autumn|winter))?|volunteerReason|volunteerTermStartQd|volunteerTermEndQd|coercionBasis)$/.test(text)) return true;
  if (/^buildings\.list\.\d+\.assignedWorkerIds(\.\d+)?$/.test(text)) return true;
  if (/^constructionCrews(\.\d+)?\.(memberIds|leaderId)(\.\d+)?$/.test(text)) return true;
  if (/^constructionCrewIds(\.\d+)?$/.test(text)) return true;
  return false;
}

function isPlayerBattlePath(rest) {
  const text = String(rest ?? "");
  const allowed = [
    "gm.massCombat.defenseMode",
    "gm.massCombat.useDefenseSquads",
    "gm.massCombat.raiseMilitia",
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
  if (text.startsWith("gm.")) return false;
  if (/^buildings\.list\.\d+\.enterpriseCapital(?:\.|$)/.test(text)) return false;
  if (/^people\.list\.\d+\.(workAssignment|role|home|salary|salaryCopper|salaryNote|baseWageDaily|cashWageDaily|compensationType|boardFoodDaily|foodProvisionMode|housingProvided|shareRate|compensationNote|wageClassId|employmentMode|employmentContractStartQd|employmentContractEndQd|employmentSeasonMask(?:\.(?:spring|summer|autumn|winter))?|volunteerReason|volunteerTermStartQd|volunteerTermEndQd|coercionBasis)$/.test(text)) return true;

  // Building access is still campaign-practical, but no longer means "send the
  // whole world back to the GM". The patch protocol applies only changed paths.
  if (/^buildings\.list(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^constructionCrews(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^constructionCrewIds(\.\d+)?$/.test(text)) return true;
  if (/^log(?:\.\d+)?(?:\.|$)/.test(text)) return true;
  return false;
}

function isPlayerStoragePath(rest) {
  const text = String(rest ?? "");
  if (text.startsWith("gm.")) return false;

  if (/^storage\.notes$/.test(text)) return true;
  if (/^storage\.(resources|items)\.\d+\.forSale$/.test(text)) return true;
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

  if (action === "storage") return validatePlayerStorageSemantics(holding, nextHolding, paths);
  if (action === "buildings") {
    const buildingCheck = validatePlayerBuildingSemantics(current, holding, nextHolding);
    if (!buildingCheck.ok) return buildingCheck;
    if (paths.some((path) => /^holdings\.\d+\.log(?:\.|$)/.test(String(path ?? "")))) {
      return validateHoldingOperationLogAppendOnly(holding?.log, nextHolding?.log, { allowedTypes: new Set(["worker-assignment"]) });
    }
  }
  if (action === "residents") {
    const residentCheck = validatePlayerResidentSemantics(holding, nextHolding);
    if (!residentCheck.ok) return residentCheck;
    const assignmentCheck = validateResidentAssignmentSideEffects(holding, nextHolding, paths);
    if (!assignmentCheck.ok) return assignmentCheck;
  }
  return { ok: true };
}

function validatePlayerResidentSemantics(holding = {}, nextHolding = {}) {
  const beforeRows = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  const afterRows = Array.isArray(nextHolding?.people?.list) ? nextHolding.people.list : [];
  const beforeById = new Map(beforeRows.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));
  const streak = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) return 0;
    const whole = Math.floor(numeric);
    return Number.isSafeInteger(whole) ? whole : 0;
  };

  for (const row of afterRows) {
    const id = String(row?.id ?? "");
    const previous = beforeById.get(id);
    const previousStreak = streak(previous?.hungerStreakTendays);
    const nextStreak = streak(row?.hungerStreakTendays);
    if ((!previous && nextStreak > 0) || (previous && nextStreak !== previousStreak)) {
      return { ok: false, error: "Счётчик голода изменяется только расчётом десятника или ГМом." };
    }
    if (previous && String(previous.wageClassId ?? "") !== String(row?.wageClassId ?? "") && !WAGE_CLASS_IDS.includes(String(row?.wageClassId ?? ""))) {
      return { ok: false, error: "Класс ставки жителя должен быть выбран из каталога Economy V2." };
    }
    if (previous && String(previous.employmentMode ?? "permanent") !== String(row?.employmentMode ?? "permanent") && !EMPLOYMENT_MODE_IDS.includes(String(row?.employmentMode ?? ""))) {
      return { ok: false, error: "Неизвестный режим найма жителя." };
    }
    for (const key of ["employmentContractStartQd", "employmentContractEndQd"]) {
      if (!previous || sameJson(previous?.[key], row?.[key])) continue;
      const value = row?.[key];
      if (value !== null && value !== "" && (!Number.isSafeInteger(Number(value)) || Number(value) < 0)) {
        return { ok: false, error: "Границы договора должны быть целыми неотрицательными QD." };
      }
    }
    for (const season of EMPLOYMENT_SEASON_IDS) {
      if (!previous || sameJson(previous?.employmentSeasonMask?.[season], row?.employmentSeasonMask?.[season])) continue;
      if (typeof row?.employmentSeasonMask?.[season] !== "boolean") {
        return { ok: false, error: "Сезон договора должен быть логическим флагом." };
      }
    }
  }
  return { ok: true };
}

function validateResidentAssignmentSideEffects(holding = {}, nextHolding = {}, paths = []) {
  const sideEffectPaths = paths
    .map((path) => String(path ?? "").replace(/^holdings\.\d+\./, ""))
    .filter((path) => isResidentAssignmentSideEffectPath(path));
  if (!sideEffectPaths.length) return { ok: true };

  const beforePeople = Array.isArray(holding?.people?.list) ? holding.people.list : [];
  const afterPeople = Array.isArray(nextHolding?.people?.list) ? nextHolding.people.list : [];
  const affectedIds = new Set();
  for (const path of paths) {
    const match = String(path ?? "").match(/^holdings\.\d+\.people\.list\.(\d+)\.(workAssignment|dead)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const id = String(afterPeople[index]?.id ?? beforePeople[index]?.id ?? "");
    if (id) affectedIds.add(id);
  }
  if (paths.some((path) => /^holdings\.\d+\.people\.list$/.test(String(path ?? "")))) {
    const beforeIds = new Set(beforePeople.map((row) => String(row?.id ?? "")).filter(Boolean));
    const afterIds = new Set(afterPeople.map((row) => String(row?.id ?? "")).filter(Boolean));
    for (const id of beforeIds) if (!afterIds.has(id)) affectedIds.add(id);
    for (const id of afterIds) if (!beforeIds.has(id)) affectedIds.add(id);
  }
  if (!affectedIds.size) return { ok: false, error: "Междоменное назначение не связано с изменённым жителем." };

  const beforeRefs = residentAssignmentReferences(holding);
  const afterRefs = residentAssignmentReferences(nextHolding);
  const keys = new Set([...beforeRefs.keys(), ...afterRefs.keys()]);
  const afterById = new Map(afterPeople.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));
  for (const key of keys) {
    const before = beforeRefs.get(key) ?? [];
    const after = afterRefs.get(key) ?? [];
    if (sameJson(before, after)) continue;
    const beforeCounts = idCounts(before);
    const afterCounts = idCounts(after);
    const changedIds = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
    for (const id of changedIds) {
      if ((beforeCounts.get(id) ?? 0) === (afterCounts.get(id) ?? 0)) continue;
      if (!affectedIds.has(id)) return { ok: false, error: "Назначение затрагивает жителя вне текущей операции." };
      if ((afterCounts.get(id) ?? 0) > (beforeCounts.get(id) ?? 0) && !residentAssignmentMatchesReference(afterById.get(id), key)) {
        return { ok: false, error: "Назначение жителя не совпадает с целевым зданием, бригадой или судном." };
      }
    }
  }
  return { ok: true };
}

function residentAssignmentReferences(holding = {}) {
  const refs = new Map();
  for (const building of holding?.buildings?.list ?? []) {
    refs.set(`building:${String(building?.id ?? "")}`, compactIds(building?.assignedWorkerIds));
  }
  for (const crew of holding?.constructionCrews ?? []) {
    refs.set(`construction:${String(crew?.id ?? "")}`, compactIds([...(crew?.memberIds ?? []), crew?.leaderId]));
  }
  const defense = holding?.gm?.defense ?? {};
  refs.set("defense:commander", compactIds([defense?.commanderId]));
  for (const [index, squad] of (defense?.squads ?? []).entries()) {
    refs.set(`defense:squad:${index}`, compactIds([squad?.sergeantId, ...(squad?.memberIds ?? [])]));
  }
  for (const vessel of holding?.special?.fleet?.vessels ?? []) {
    refs.set(`fleet:${String(vessel?.id ?? "")}`, compactIds(vessel?.crew?.memberIds));
  }
  return refs;
}

function compactIds(values = []) {
  return (Array.isArray(values) ? values : []).map((value) => String(value ?? "")).filter(Boolean);
}

function idCounts(values = []) {
  const counts = new Map();
  for (const id of values) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

function residentAssignmentMatchesReference(person = null, key = "") {
  const assignment = String(person?.workAssignment ?? "");
  if (key.startsWith("building:")) return assignment === key.slice("building:".length);
  if (key.startsWith("construction:")) return assignment === key || (assignment === "construction" && key === "construction:legacy");
  if (key.startsWith("fleet:")) return assignment === key;
  return false;
}

function validateHoldingOperationLogAppendOnly(beforeRaw = [], afterRaw = [], { allowedTypes = new Set() } = {}) {
  const before = Array.isArray(beforeRaw) ? beforeRaw : [];
  const after = Array.isArray(afterRaw) ? afterRaw : [];
  if (after.length < before.length || after.length > before.length + 1) {
    return { ok: false, error: "Игрок может только добавить одну запись операции за команду." };
  }
  for (let index = 0; index < before.length; index += 1) {
    if (!sameJson(before[index], after[index])) return { ok: false, error: "Игрок не может переписывать журнал операций." };
  }
  if (after.length === before.length) return { ok: true };
  const entry = after.at(-1);
  const type = String(entry?.type ?? "");
  const operationId = String(entry?.operationId ?? entry?.id ?? "");
  if (!entry || typeof entry !== "object" || !isKnownHoldingOperationType(type) || !allowedTypes.has(type)) {
    return { ok: false, error: "Недопустимый тип записи операции игрока." };
  }
  if (!operationId || operationId.length > 120 || String(entry.id ?? "") !== operationId) {
    return { ok: false, error: "Некорректный operationId записи операции." };
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

function validatePlayerStorageSemantics(holding = {}, nextHolding = {}, paths = []) {
  const storage = nextHolding?.storage ?? {};
  for (const path of paths) {
    const text = String(path ?? "");
    if (/^holdings\.\d+\.storage\.notes$/.test(text)) {
      if (typeof storage.notes !== "string") return { ok: false, error: "Заметка хранилища должна быть текстом." };
      continue;
    }
    const match = text.match(/^holdings\.\d+\.storage\.(resources|items)\.(\d+)\.forSale$/);
    if (!match) return { ok: false, error: `Игрок не может менять хозяйственные данные хранилища: ${text}` };
    const previousRows = Array.isArray(holding?.storage?.[match[1]]) ? holding.storage[match[1]] : [];
    const rows = Array.isArray(storage[match[1]]) ? storage[match[1]] : [];
    const index = Number(match[2]);
    const previous = previousRows[index];
    const next = rows[index];
    if (!previous || !next || !String(previous.id ?? "") || String(previous.id ?? "") !== String(next.id ?? "")) {
      return { ok: false, error: "Игрок может менять флаг продажи только у существующей позиции хранилища." };
    }
    if (typeof next.forSale !== "boolean") {
      return { ok: false, error: "Флаг продажи должен быть логическим значением." };
    }
  }

  return { ok: true };
}

function validatePlayerBuildingSemantics(current = {}, holding = {}, nextHolding = {}) {
  const before = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const after = Array.isArray(nextHolding?.buildings?.list) ? nextHolding.buildings.list : [];
  const beforeById = new Map(before.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));
  const catalogRows = Array.isArray(current?.catalog?.buildings) ? current.catalog.buildings : [];
  const catalogById = new Map(catalogRows.map((row) => [String(row?.id ?? ""), row]).filter(([id]) => Boolean(id)));

  for (const row of after) {
    const id = String(row?.id ?? "");
    if (!id) return { ok: false, error: "Постройка игрока должна иметь id." };
    const old = beforeById.get(id);
    if (old && !sameJson(old?.enterpriseCapital, row?.enterpriseCapital)) {
      return { ok: false, error: `Игрок не может менять капитал предприятия: ${row?.name ?? id}` };
    }
    if (old && String(old.templateId ?? "") !== String(row?.templateId ?? "")) {
      return { ok: false, error: `Игрок не может менять templateId существующей постройки: ${row?.name ?? id}` };
    }

    if (!old) {
      const capital = row?.enterpriseCapital && typeof row.enterpriseCapital === "object" ? row.enterpriseCapital : {};
      const provenance = String(capital.fundingProvenance ?? "").trim();
      const hasAuthoritativeCapital = toNumber(capital.commissioningPaidCopper, 0) > 0
        || toNumber(capital.workingCapitalReserveCopper, 0) > 0
        || toNumber(capital.fundedCopper, 0) > 0
        || capital.legacyGrandfathered === true
        || Boolean(provenance && provenance !== "treasury");
      if (hasAuthoritativeCapital) {
        return { ok: false, error: "Игрок не может создавать предприятие с уже внесённым капиталом или legacy-готовностью." };
      }
    }

    if (!old && row?.templateId) {
      const template = catalogById.get(String(row.templateId));
      if (!template) return { ok: false, error: `Шаблон постройки не найден: ${row.templateId}` };
      if (template.visibility === "gm") return { ok: false, error: "Игрок не может создавать постройку из скрытого шаблона." };
      if (template.unlocked === false) return { ok: false, error: "Игрок не может создавать постройку из закрытого шаблона." };
      if (!requirementsMet(template.requirements, nextHolding?.overview?.development)) {
        return { ok: false, error: "Игрок не может создавать постройку из шаблона с невыполненными требованиями развития." };
      }
    }
  }

  return { ok: true };
}

function requirementsMet(requirements = {}, development = {}) {
  if (!requirements || typeof requirements !== "object") return true;
  for (const key of ["food", "technology", "culture", "war"]) {
    if (toNumber(development?.[key], 0) + 0.0001 < toNumber(requirements?.[key], 0)) return false;
  }
  return true;
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
