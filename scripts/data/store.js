import { LAPUTA_IMPORT } from "./laputa-import.js";
import { BASE_HOLDING, DEFAULT_SKYHOLD_DATA, HOLDING_TYPES } from "./schema.js";
import { clearBuildingReferences, clearPersonReferences, mergeHoldingDefaults, migrateData } from "./normalizers.js";
import { clone, makeId, toNumber } from "./utils.js";
import { applyPlayerPatch, buildPlayerPatch, validatePlayerDataRequest, validatePlayerPatch } from "./player-write-guard.js";

export { clone } from "./utils.js";
export { DEFAULT_SKYHOLD_DATA, HOLDING_TYPES } from "./schema.js";
export const MODULE_ID = "fbl-skyhold";
export const SETTING_DATA = "skyholdData"; // legacy combined setting, kept for one-way migration and rollback safety
export const SETTING_META = "skyholdMeta";
export const SETTING_HOLDINGS = "skyholdHoldings";
export const SETTING_CATALOG = "skyholdCatalog";
export const SETTING_PLAYERS_CAN_OPEN = "playersCanOpen";
export const SETTING_MASS_COMBAT_TAGS = "massCombatTags";

const PENDING_PLAYER_WRITES = new Map();
const STORAGE_COMMIT_VERSION = 1;
const DEFAULT_HOLDINGS_HASH = stableDataHash(DEFAULT_SKYHOLD_DATA.holdings);
const DEFAULT_CATALOG_HASH = stableDataHash(DEFAULT_SKYHOLD_DATA.catalog);
let cachedRevision = null;
let cachedData = null;
let warnedCommitProblem = "";

export function stableDataHash(value) {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function stableStringify(value) {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function makeStorageCommitMeta(meta = {}, { writeId, previousRevision = 0, holdings, catalog, complete = false, now = new Date().toISOString() } = {}) {
  const revision = Math.max(0, toNumber(meta?.revision, 0));
  const commitId = String(writeId || makeId("commit"));
  return {
    ...clone(meta ?? {}),
    storageCommit: {
      version: STORAGE_COMMIT_VERSION,
      writeId: commitId,
      state: complete ? "complete" : "writing",
      writeComplete: Boolean(complete),
      previousRevision: Math.max(0, toNumber(previousRevision, 0)),
      revision,
      startedAt: String(meta?.storageCommit?.writeId === commitId ? meta?.storageCommit?.startedAt ?? now : now),
      completedAt: complete ? now : null,
      holdingsHash: stableDataHash(holdings ?? []),
      catalogHash: stableDataHash(catalog ?? {})
    }
  };
}

export function inspectStorageCommit(split = {}) {
  const commit = split?.meta?.storageCommit;
  if (!commit) return { ok: true, reason: "missing" };
  if (commit.writeComplete !== true || commit.state !== "complete") return { ok: false, reason: "incomplete", commit };

  const revision = Math.max(0, toNumber(split?.meta?.revision, 0));
  const commitRevision = Math.max(0, toNumber(commit.revision, 0));
  if (revision !== commitRevision) return { ok: false, reason: "revision-mismatch", commit };

  const holdingsHash = stableDataHash(split?.holdings ?? []);
  const catalogHash = stableDataHash(split?.catalog ?? {});
  if (commit.holdingsHash && commit.holdingsHash !== holdingsHash) return { ok: false, reason: "holdings-hash-mismatch", commit };
  if (commit.catalogHash && commit.catalogHash !== catalogHash) return { ok: false, reason: "catalog-hash-mismatch", commit };
  return { ok: true, reason: "complete", commit };
}


export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DATA, {
    name: "Skyhold Data (legacy)",
    hint: "Legacy combined data for FBL Skyhold Manager. Used only for migration/rollback.",
    scope: "world",
    config: false,
    type: Object,
    default: clone(DEFAULT_SKYHOLD_DATA)
  });

  game.settings.register(MODULE_ID, SETTING_META, {
    name: "Skyhold Meta",
    hint: "Internal metadata for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: clone(DEFAULT_SKYHOLD_DATA.meta)
  });

  game.settings.register(MODULE_ID, SETTING_HOLDINGS, {
    name: "Skyhold Holdings",
    hint: "Internal holdings runtime data for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: clone(DEFAULT_SKYHOLD_DATA.holdings)
  });

  game.settings.register(MODULE_ID, SETTING_CATALOG, {
    name: "Skyhold Catalog",
    hint: "Internal catalog data for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: clone(DEFAULT_SKYHOLD_DATA.catalog)
  });

  game.settings.register(MODULE_ID, SETTING_MASS_COMBAT_TAGS, {
    name: "Skyhold Mass Combat Tags",
    hint: "Editable tag and counter matrix for Skyhold mass combat.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_PLAYERS_CAN_OPEN, {
    name: "Игроки могут открывать окно владений",
    hint: "Если выключено, окно владений сможет открывать только ГМ.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}


function readSkyholdSettings() {
  const split = {
    meta: clone(game.settings.get(MODULE_ID, SETTING_META) ?? DEFAULT_SKYHOLD_DATA.meta),
    holdings: clone(game.settings.get(MODULE_ID, SETTING_HOLDINGS) ?? DEFAULT_SKYHOLD_DATA.holdings),
    catalog: clone(game.settings.get(MODULE_ID, SETTING_CATALOG) ?? DEFAULT_SKYHOLD_DATA.catalog)
  };

  const legacy = game.settings.get(MODULE_ID, SETTING_DATA);
  const splitRevision = Math.max(0, toNumber(split?.meta?.revision, 0));
  const legacyRevision = Math.max(0, toNumber(legacy?.meta?.revision, 0));
  const splitLooksDefault = isDefaultSplitPayload(split);
  const legacyLooksUsed = legacyHasRuntimeData(legacy);
  const commitInspection = inspectStorageCommit(split);

  if (!commitInspection.ok && legacyLooksUsed) {
    const warningKey = `${commitInspection.reason}:${commitInspection.commit?.writeId ?? splitRevision}:${legacyRevision}`;
    if (warningKey !== warnedCommitProblem) {
      warnedCommitProblem = warningKey;
      console.warn(`FBL Skyhold | Split data commit is ${commitInspection.reason}; using legacy rollback snapshot when possible.`, commitInspection);
    }
    return legacy;
  }

  // Worlds that already have skyholdData keep working: the first write after this
  // version persists them into split settings. Revision wins after the split exists.
  // The equality fallback protects older saves that never had a revision bump.
  if (legacyRevision > splitRevision) return legacy;
  if (legacyRevision === splitRevision && splitLooksDefault && legacyLooksUsed) return legacy;
  return split;
}

function legacyHasRuntimeData(legacy) {
  if (!legacy || typeof legacy !== "object") return false;
  try {
    return stableDataHash(legacy?.holdings ?? []) !== DEFAULT_HOLDINGS_HASH
      || stableDataHash(legacy?.catalog ?? {}) !== DEFAULT_CATALOG_HASH;
  } catch (_error) {
    return true;
  }
}

function isDefaultSplitPayload(split) {
  try {
    return stableDataHash(split?.holdings ?? []) === DEFAULT_HOLDINGS_HASH
      && stableDataHash(split?.catalog ?? {}) === DEFAULT_CATALOG_HASH;
  } catch (_error) {
    return false;
  }
}

async function persistSkyholdData(data) {
  const next = migrateData(data);
  const previousRevision = Math.max(0, toNumber(cachedData?.meta?.revision ?? game.settings.get(MODULE_ID, SETTING_META)?.revision, 0));
  const writeId = makeId("commit");
  const startedAt = new Date().toISOString();

  const startedMeta = makeStorageCommitMeta(next.meta, {
    writeId,
    previousRevision,
    holdings: next.holdings,
    catalog: next.catalog,
    complete: false,
    now: startedAt
  });

  next.meta = clone(startedMeta);
  await game.settings.set(MODULE_ID, SETTING_META, clone(next.meta));
  await game.settings.set(MODULE_ID, SETTING_HOLDINGS, clone(next.holdings));
  await game.settings.set(MODULE_ID, SETTING_CATALOG, clone(next.catalog));

  next.meta = makeStorageCommitMeta(next.meta, {
    writeId,
    previousRevision,
    holdings: next.holdings,
    catalog: next.catalog,
    complete: true,
    now: new Date().toISOString()
  });
  await game.settings.set(MODULE_ID, SETTING_META, clone(next.meta));

  // Keep the legacy combined setting as a rollback snapshot. It is not the primary
  // store anymore, but it gives the loader a coherent fallback after interrupted
  // split-setting writes.
  try {
    await game.settings.set(MODULE_ID, SETTING_DATA, clone(next));
  } catch (error) {
    console.warn("FBL Skyhold | Could not update rollback snapshot.", error);
  }

  cachedRevision = Math.max(0, toNumber(next?.meta?.revision, 0));
  cachedData = clone(next);
  return next;
}

export class SkyholdData {
  static get() {
    const stored = readSkyholdSettings();
    const migrated = migrateData(stored);
    const revision = Math.max(0, toNumber(migrated?.meta?.revision, 0));
    if (cachedData && cachedRevision === revision) return clone(cachedData);
    cachedRevision = revision;
    cachedData = clone(migrated);
    return clone(migrated);
  }

  static async set(data) {
    const current = SkyholdData.get();
    const next = migrateData(data);
    next.meta.lastUpdated = new Date().toISOString();
    next.meta.revision = Math.max(0, toNumber(current?.meta?.revision, 0)) + 1;
    if (!game.user?.isGM) return requestGmDataSet(next);
    await persistSkyholdData(next);
    notifySkyholdChanged();
    return next;
  }

  static async update(path, value) {
    const data = this.get();
    foundry.utils.setProperty(data, path, value);
    return this.set(data);
  }

  static async addRow(collectionPath, row) {
    const data = this.get();
    const collection = foundry.utils.getProperty(data, collectionPath);

    if (!Array.isArray(collection)) {
      throw new Error(`FBL Skyhold | Collection is not an array: ${collectionPath}`);
    }

    collection.push(row);
    return this.set(data);
  }

  static async deleteRow(collectionPath, rowId) {
    const data = this.get();
    const collection = foundry.utils.getProperty(data, collectionPath);

    if (!Array.isArray(collection)) {
      throw new Error(`FBL Skyhold | Collection is not an array: ${collectionPath}`);
    }

    const holdingMatch = collectionPath.match(/^holdings\.(\d+)\.(people\.list|buildings\.list)$/);
    const holding = holdingMatch ? data.holdings[Number(holdingMatch[1])] : null;
    const removedRow = collection.find((row) => String(row?.id) === String(rowId));
    const nextCollection = collection.filter((row) => String(row?.id) !== String(rowId));
    foundry.utils.setProperty(data, collectionPath, nextCollection);

    // Удаление сущности должно чистить обратные ссылки. Иначе в зданиях и бригадах
    // остаются мертвые ID, а жители продолжают числиться на удаленной работе.
    if (holding && removedRow && holdingMatch?.[2] === "people.list") clearPersonReferences(holding, rowId);
    if (holding && removedRow && holdingMatch?.[2] === "buildings.list") clearBuildingReferences(holding, removedRow);

    return this.set(data);
  }

  static async addHolding(holding) {
    const data = this.get();
    data.holdings.push(mergeHoldingDefaults(holding));
    return this.set(data);
  }

  static async deleteHolding(holdingId) {
    const data = this.get();
    if (data.holdings.length <= 1) {
      throw new Error("FBL Skyhold | Cannot delete the last holding.");
    }

    data.holdings = data.holdings.filter((holding) => holding.id !== holdingId);
    return this.set(data);
  }

  static async importLaputa() {
    const data = this.get();
    const imported = mergeHoldingDefaults(clone(LAPUTA_IMPORT.holding));
    const existingIndex = data.holdings.findIndex((holding) => holding.id === imported.id || holding.name === imported.name);

    if (existingIndex >= 0) {
      const existing = mergeHoldingDefaults(data.holdings[existingIndex]);
      imported.visibility = existing.visibility ?? imported.visibility;
      imported.linkedSceneId = existing.linkedSceneId || imported.linkedSceneId;

      if (existing.gm?.notes && existing.gm.notes !== BASE_HOLDING.gm.notes) {
        imported.gm.notes = `${imported.gm.notes}\n\nСохраненные заметки до импорта:\n${existing.gm.notes}`;
      }

      data.holdings[existingIndex] = imported;
    } else {
      data.holdings.push(imported);
    }

    if (!data.meta) data.meta = {};
    data.meta.lastImport = {
      source: LAPUTA_IMPORT.source,
      holdingId: imported.id,
      importedAt: new Date().toISOString()
    };

    return this.set(data);
  }

  static async reset() {
    return this.set(clone(DEFAULT_SKYHOLD_DATA));
  }
}

export function createHolding({ name = "Новое владение", type = "settlement" } = {}) {
  const id = makeId("holding");
  return mergeHoldingDefaults({
    id,
    name: String(name || "Новое владение").trim() || "Новое владение",
    type: HOLDING_TYPES[type] ? type : "settlement"
  });
}

export function getHoldingTypeLabel(type) {
  return HOLDING_TYPES[type] ?? type ?? "Владение";
}

export function notifySkyholdChanged() {
  Hooks.callAll("fblSkyholdDataChanged");

  // Сокет нужен только для перерендера уже открытых окон на других клиентах.
  // Сами данные хранятся в world setting и синхронизируются Foundry.
  if (game.socket) {
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "dataChanged",
      userId: game.user?.id ?? null
    });
  }
}

export function canCurrentUserOpenSkyhold() {
  if (game.user?.isGM) return true;
  return Boolean(game.settings.get(MODULE_ID, SETTING_PLAYERS_CAN_OPEN));
}

function requestGmDataSet(data) {
  const current = SkyholdData.get();
  const patch = buildPlayerPatch(current, data);
  if (!patch.changes.length) return Promise.resolve(data);
  if (!game.socket) {
    ui.notifications?.warn?.("Не удалось отправить изменение: socket Foundry недоступен.");
    return Promise.reject(new Error("FBL Skyhold | Socket is not available for player write request."));
  }

  const users = Array.isArray(game.users?.contents) ? game.users.contents : Array.from(game.users ?? []);
  const hasActiveGm = users.some((user) => user?.active && user?.isGM);
  if (!hasActiveGm) {
    ui.notifications?.warn?.("Изменения игроков сохраняет активный ГМ. Сейчас в мире нет активного ГМа.");
    return Promise.reject(new Error("FBL Skyhold | No active GM is available for player write request."));
  }

  const requestId = makeId("req");
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      PENDING_PLAYER_WRITES.delete(requestId);
      reject(new Error("FBL Skyhold | GM write request timed out."));
    }, 8000);

    PENDING_PLAYER_WRITES.set(requestId, { resolve, reject, timeout });
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "playerDataPatchRequest",
      requestId,
      userId: game.user?.id ?? null,
      patch
    });
  });
}

export async function handleSkyholdSocketPayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  if (payload.type === "playerSetDataResponse") {
    if (payload.userId && payload.userId !== game.user?.id) return true;
    const pending = PENDING_PLAYER_WRITES.get(payload.requestId);
    if (!pending) return true;
    clearTimeout(pending.timeout);
    PENDING_PLAYER_WRITES.delete(payload.requestId);
    if (payload.ok) pending.resolve(payload.data ?? SkyholdData.get());
    else pending.reject(new Error(payload.error || "FBL Skyhold | GM write request failed."));
    return true;
  }

  if (payload.type === "playerDataPatchRequest") {
    if (!game.user?.isGM) return true;

    try {
      const current = SkyholdData.get();
      const validation = validatePlayerPatch(current, payload.patch, payload.userId);
      if (!validation.ok) throw new Error(validation.error);

      const proposed = migrateData(applyPlayerPatch(current, payload.patch));
      proposed.meta.lastUpdated = new Date().toISOString();
      proposed.meta.revision = Math.max(0, toNumber(current?.meta?.revision, 0)) + 1;
      await persistSkyholdData(proposed);
      notifySkyholdChanged();
      game.socket?.emit?.(`module.${MODULE_ID}`, {
        type: "playerSetDataResponse",
        requestId: payload.requestId,
        userId: payload.userId ?? null,
        ok: true,
        data: proposed
      });
    } catch (error) {
      console.error("FBL Skyhold | Failed to apply player patch request", error);
      game.socket?.emit?.(`module.${MODULE_ID}`, {
        type: "playerSetDataResponse",
        requestId: payload.requestId,
        userId: payload.userId ?? null,
        ok: false,
        error: error?.message ?? String(error)
      });
    }
    return true;
  }

  if (payload.type !== "playerSetDataRequest") return false;
  if (!game.user?.isGM) return true;

  try {
    const current = SkyholdData.get();
    const proposed = migrateData(payload.data);
    const validation = validatePlayerDataRequest(current, proposed, payload.userId);
    if (!validation.ok) throw new Error(validation.error);

    proposed.meta.lastUpdated = new Date().toISOString();
    proposed.meta.revision = Math.max(0, toNumber(current?.meta?.revision, 0)) + 1;
    await persistSkyholdData(proposed);
    notifySkyholdChanged();
    game.socket?.emit?.(`module.${MODULE_ID}`, {
      type: "playerSetDataResponse",
      requestId: payload.requestId,
      userId: payload.userId ?? null,
      ok: true,
      data: proposed
    });
  } catch (error) {
    console.error("FBL Skyhold | Failed to apply legacy player data request", error);
    game.socket?.emit?.(`module.${MODULE_ID}`, {
      type: "playerSetDataResponse",
      requestId: payload.requestId,
      userId: payload.userId ?? null,
      ok: false,
      error: error?.message ?? String(error)
    });
  }
  return true;
}
