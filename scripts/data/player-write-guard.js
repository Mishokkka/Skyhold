import { clone, isPlainObject, toNumber } from "./utils.js";

const MAX_PLAYER_CHANGE_PATHS = 250;

export function buildPlayerPatch(current, proposed) {
  const baseRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const paths = diffPatchPaths(current, proposed).filter((path) => !isIgnorablePlayerDiff(path));
  return {
    baseRevision,
    action: inferPlayerPatchAction(paths),
    changes: paths.map((path) => {
      const value = getByPath(proposed, path);
      return value === undefined
        ? { path, delete: true }
        : { path, value: clone(value) };
    })
  };
}

export function validatePlayerPatch(current, patch, userId = null) {
  if (!current || !patch || typeof patch !== "object") return { ok: false, error: "Некорректный patch-запрос игрока." };

  const currentRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const baseRevision = Math.max(0, toNumber(patch?.baseRevision, 0));
  if (currentRevision > baseRevision) {
    return { ok: false, error: "Данные владения устарели. Открой окно заново и повтори действие." };
  }

  const changes = Array.isArray(patch.changes) ? patch.changes : [];
  if (!changes.length) return { ok: true, changes: [] };
  if (changes.length > MAX_PLAYER_CHANGE_PATHS) return { ok: false, error: "Слишком много изменений за один запрос игрока." };

  const badChange = changes.find((change) => !change || typeof change !== "object" || !change.path || typeof change.path !== "string");
  if (badChange) return { ok: false, error: "Некорректный путь изменения в patch-запросе игрока." };

  const paths = changes.map((change) => change.path).filter((path) => !isIgnorablePlayerDiff(path));
  const unsafePath = paths.find((path) => hasUnsafePathSegment(path));
  if (unsafePath) return { ok: false, error: `Некорректный служебный сегмент пути: ${unsafePath}` };

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

  const denied = paths.filter((path) => !isPlayerWritablePath(path, current, current));
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

// Legacy validator kept for rollback safety and mixed-client worlds. New clients send
// playerDataPatchRequest and the GM applies the patch to the current canonical state.
export function validatePlayerDataRequest(current, proposed, userId = null) {
  if (!current || !proposed) return { ok: false, error: "Некорректные данные запроса." };
  const currentRevision = Math.max(0, toNumber(current?.meta?.revision, 0));
  const proposedRevision = Math.max(0, toNumber(proposed?.meta?.revision, 0));
  if (currentRevision > 0 && proposedRevision <= currentRevision) {
    return { ok: false, error: "Данные владения устарели. Открой окно заново и повтори действие." };
  }

  const changes = diffPaths(current, proposed).filter((path) => !isIgnorablePlayerDiff(path));
  if (!changes.length) return { ok: true, changes };
  if (changes.length > MAX_PLAYER_CHANGE_PATHS) return { ok: false, error: "Слишком много изменений за один запрос игрока." };
  const unsafePath = changes.find((path) => hasUnsafePathSegment(path));
  if (unsafePath) return { ok: false, error: `Некорректный служебный сегмент пути: ${unsafePath}` };

  const changedHoldings = new Set(changes.map((path) => String(path).match(/^holdings\.(\d+)\./)?.[1]).filter((value) => value !== undefined));
  if (changedHoldings.size !== 1) return { ok: false, error: "Игрок может менять только одно владение за один запрос." };

  const action = inferPlayerPatchAction(changes);
  const wrongActionPaths = changes.filter((path) => patchActionForPath(path) !== action && !isPlayerActionSideEffect(action, path));
  if (!action || wrongActionPaths.length) return { ok: false, error: "Legacy-запрос игрока смешивает разные действия." };

  const denied = changes.filter((path) => !isPlayerWritablePath(path, current, proposed));
  if (denied.length) {
    const sample = denied.slice(0, 5).join(", ");
    return { ok: false, error: `Игрок не имеет права менять эти данные: ${sample}` };
  }

  const holdingIndex = Number(Array.from(changedHoldings)[0]);
  const semantic = validatePlayerPatchSemantics(current, proposed, action, holdingIndex, changes);
  if (!semantic.ok) return semantic;

  return { ok: true, action, changes };
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
  if (isPlayerOverviewPath(rest)) return "overview";
  if (/^gm\.massCombat(\.|$)/.test(rest)) return "battle";
  if (/^gm\.defense(\.|$)/.test(rest)) return "defense";
  if (/^storage\./.test(rest) && isPlayerStoragePath(rest)) return "storage";
  if (/^special\./.test(rest) && isPlayerSpecialPath(rest)) return "special";
  if (/^buildings\.|^constructionCrews|^constructionCrewIds(\.\d+)?$/.test(rest) && isPlayerBuildingPath(rest)) return "buildings";
  if (/^people\.list\.\d+\.(workAssignment|role|home|salary|salaryCopper|salaryNote)$/.test(rest)) return "buildings";
  if (/^people\./.test(rest) && isPlayerResidentPath(rest)) return "residents";
  return "";
}

function isPlayerActionSideEffect(action = "", path = "") {
  const rest = String(path ?? "").replace(/^holdings\.\d+\./, "");
  if (action === "defense") {
    return /^people\.list\.\d+\.(workAssignment|role|salary|salaryCopper|salaryNote)$/.test(rest)
      || /^buildings\.list\.\d+\.assignedWorkerIds(\.\d+)?$/.test(rest)
      || /^constructionCrews(\.\d+)?\.(memberIds|leaderId)(\.\d+)?$/.test(rest)
      || /^constructionCrewIds(\.\d+)?$/.test(rest);
  }
  if (action === "buildings") {
    return /^people\.list\.\d+\.(workAssignment|role|home|salary|salaryCopper|salaryNote)$/.test(rest);
  }
  return false;
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
  if (/^people\.list\.\d+\.(workAssignment|role|salary|salaryCopper|salaryNote)$/.test(text)) return true;
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
  if (/^people\.list\.\d+\.(workAssignment|role|home|salary|salaryCopper|salaryNote)$/.test(text)) return true;

  // Building access is still campaign-practical, but no longer means "send the
  // whole world back to the GM". The patch protocol applies only changed paths.
  if (/^buildings\.list(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^constructionCrews(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^constructionCrewIds(\.\d+)?$/.test(text)) return true;
  return false;
}

function isPlayerStoragePath(rest) {
  const text = String(rest ?? "");
  if (text.startsWith("gm.")) return false;

  if (/^storage\.resources(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^storage\.items(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^storage\.log(\.\d+)?(\.|$)/.test(text)) return true;
  if (/^storage\.moneyCopper$/.test(text)) return true;
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

  if (action === "storage") return validatePlayerStorageSemantics(holding, nextHolding, paths);
  if (action === "buildings") return validatePlayerBuildingSemantics(current, holding, nextHolding);
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
  const moneyCopper = toNumber(storage.moneyCopper, 0);
  if (moneyCopper < 0) return { ok: false, error: "Казна хранилища не может быть отрицательной." };

  const resources = Array.isArray(storage.resources) ? storage.resources : [];
  const items = Array.isArray(storage.items) ? storage.items : [];
  for (const row of resources) {
    if (toNumber(row?.qty, 0) < 0) return { ok: false, error: `Ресурс '${row?.name ?? row?.resourceId ?? "?"}' не может уйти в минус.` };
  }
  for (const row of items) {
    const qty = toNumber(row?.qty ?? row?.quantity ?? row?.itemData?.system?.quantity ?? row?.system?.quantity ?? 1, 1);
    if (qty < 0) return { ok: false, error: `Предмет '${row?.name ?? "?"}' не может иметь отрицательное количество.` };
  }

  if (paths.some((path) => /^holdings\.\d+\.storage\.log(\.|$)/.test(String(path ?? "")))) {
    const logCheck = validateStorageLogAppendOnly(holding?.storage?.log, storage.log);
    if (!logCheck.ok) return logCheck;
  }

  return { ok: true };
}

function validateStorageLogAppendOnly(beforeRaw = [], afterRaw = []) {
  const before = Array.isArray(beforeRaw) ? beforeRaw : [];
  const after = Array.isArray(afterRaw) ? afterRaw : [];
  if (after.length < before.length) return { ok: false, error: "Игрок не может очищать или укорачивать лог хранилища." };

  for (let index = 0; index < before.length; index += 1) {
    if (!sameJson(before[index], after[index])) return { ok: false, error: "Игрок не может переписывать существующие записи лога хранилища." };
  }

  for (const entry of after.slice(before.length)) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "Некорректная новая запись лога хранилища." };
    if (!String(entry.kind ?? "").trim()) return { ok: false, error: "Запись лога хранилища должна иметь тип." };
    if (!Number.isFinite(Number(entry.qty))) return { ok: false, error: "Запись лога хранилища должна иметь числовое количество." };
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
    if (old && String(old.templateId ?? "") !== String(row?.templateId ?? "")) {
      return { ok: false, error: `Игрок не может менять templateId существующей постройки: ${row?.name ?? id}` };
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

function diffPaths(left, right, base = "", output = []) {
  if (left === right) return output;
  const leftObject = isPlainObject(left) || Array.isArray(left);
  const rightObject = isPlainObject(right) || Array.isArray(right);
  if (!leftObject || !rightObject || Array.isArray(left) !== Array.isArray(right)) {
    if (base) output.push(base);
    return output;
  }
  const keys = new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})]);
  for (const key of keys) {
    const path = base ? `${base}.${key}` : String(key);
    diffPaths(left?.[key], right?.[key], path, output);
  }
  return output;
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
