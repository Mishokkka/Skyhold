import { economyV2ActivationSourceHash } from "./economy-v2-activation.js";
import { stableDataHash } from "./storage-commit.js";
import { clone, toNumber } from "./utils.js";

export const ECONOMY_V2_BACKUP_FORMAT = "fbl-skyhold/economy-v2-backup";
export const ECONOMY_V2_BACKUP_VERSION = 2;

const LOGICAL_ROOT_KEYS = Object.freeze(["catalog", "holdings", "meta"]);
const BACKUP_PAYLOAD_KEYS = Object.freeze([
  "createdAt", "data", "format", "formatVersion", "payloadHash", "sourceHash", "sourceRevision"
]);

function safeTimestamp(value = "") {
  return String(value ?? "").replace(/[:.]/g, "-").replace(/[^0-9A-Za-z_-]+/g, "-");
}

export function createEconomyV2Backup(data = {}, { now = new Date().toISOString() } = {}) {
  if (!data || typeof data !== "object") throw new TypeError("FBL Skyhold | Full Skyhold data is required for the Economy V2 backup.");
  const createdAt = String(now ?? new Date().toISOString());
  const logicalData = clone(data);
  const sourceRevision = Math.max(0, Math.floor(toNumber(logicalData?.meta?.revision, 0)));
  const sourceHash = economyV2ActivationSourceHash(logicalData);
  const payload = {
    format: ECONOMY_V2_BACKUP_FORMAT,
    formatVersion: ECONOMY_V2_BACKUP_VERSION,
    createdAt,
    sourceRevision,
    sourceHash,
    payloadHash: stableDataHash(logicalData),
    data: logicalData
  };
  const backupHash = stableDataHash(payload);
  const fileName = `fbl-skyhold-before-economy-v2-r${sourceRevision}-${safeTimestamp(createdAt)}.json`;
  return {
    json: JSON.stringify(payload, null, 2),
    receipt: {
      format: ECONOMY_V2_BACKUP_FORMAT,
      formatVersion: ECONOMY_V2_BACKUP_VERSION,
      fileName,
      createdAt,
      downloadInitiatedAt: "",
      sourceRevision,
      sourceHash,
      payloadHash: payload.payloadHash,
      backupHash
    }
  };
}

export function markEconomyV2BackupDownloadInitiated(backup = {}, { now = new Date().toISOString() } = {}) {
  return {
    ...backup,
    receipt: {
      ...(backup?.receipt ?? {}),
      downloadInitiatedAt: String(now ?? new Date().toISOString())
    }
  };
}

function exactKeys(value = {}, expected = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validLogicalRoot(data = {}) {
  return exactKeys(data, LOGICAL_ROOT_KEYS)
    && data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
    && Array.isArray(data.holdings)
    && data.catalog && typeof data.catalog === "object" && !Array.isArray(data.catalog);
}

export function economyV2BackupRestorableHash(data = {}) {
  const meta = clone(data?.meta ?? {});
  delete meta.revision;
  delete meta.lastUpdated;
  delete meta.storageCommit;
  return stableDataHash({ meta, holdings: data?.holdings ?? [], catalog: data?.catalog ?? {} });
}

export function parseEconomyV2BackupJson(rawBackup = "") {
  let payload;
  try {
    payload = typeof rawBackup === "string" ? JSON.parse(rawBackup) : clone(rawBackup);
  } catch (_error) {
    return { ok: false, message: "JSON-копия Economy V2 повреждена или не читается." };
  }
  if (!exactKeys(payload, BACKUP_PAYLOAD_KEYS)
    || payload?.format !== ECONOMY_V2_BACKUP_FORMAT
    || Math.floor(toNumber(payload?.formatVersion, 0)) !== ECONOMY_V2_BACKUP_VERSION
    || !validLogicalRoot(payload?.data)) {
    return { ok: false, message: "Файл не является полной резервной копией FBL Skyhold поддерживаемого формата." };
  }
  const sourceRevision = Number(payload.sourceRevision);
  const dataRevision = Number(payload.data?.meta?.revision);
  const sourceHash = economyV2ActivationSourceHash(payload.data);
  const payloadHash = stableDataHash(payload.data);
  if (typeof payload.formatVersion !== "number"
    || typeof payload.sourceRevision !== "number"
    || typeof payload.data.meta.revision !== "number"
    || typeof payload.createdAt !== "string" || !Number.isFinite(Date.parse(payload.createdAt))
    || !Number.isInteger(sourceRevision) || sourceRevision < 0
    || !Number.isInteger(dataRevision) || dataRevision < 0
    || sourceRevision !== dataRevision
    || String(payload.sourceHash ?? "") !== sourceHash
    || String(payload.payloadHash ?? "") !== payloadHash) {
    return { ok: false, stale: true, message: "Резервная копия не прошла проверку revision и контрольных сумм." };
  }
  return {
    ok: true,
    payload,
    sourceRevision,
    sourceHash,
    payloadHash,
    backupHash: stableDataHash(payload),
    restorableHash: economyV2BackupRestorableHash(payload.data)
  };
}

export function validateEconomyV2Backup(backup = {}, plan = {}) {
  const receipt = backup?.receipt;
  if (!receipt || !String(receipt.downloadInitiatedAt ?? "").trim()) {
    return { ok: false, message: "Перед активацией нужно инициировать скачивание полной JSON-копии данных." };
  }
  const parsed = parseEconomyV2BackupJson(String(backup?.json ?? ""));
  if (!parsed.ok) return parsed;
  const payload = parsed.payload;
  const sourceRevision = Math.max(0, Math.floor(toNumber(plan?.baseRevision, -1)));
  const sourceHash = String(plan?.sourceHash ?? "");
  if (Math.floor(toNumber(payload.sourceRevision, -1)) !== sourceRevision
    || Math.floor(toNumber(receipt.sourceRevision, -1)) !== sourceRevision
    || String(payload.sourceHash ?? "") !== sourceHash
    || String(receipt.sourceHash ?? "") !== sourceHash
    || parsed.sourceHash !== sourceHash
    || String(receipt.payloadHash ?? "") !== parsed.payloadHash
    || String(receipt.backupHash ?? "") !== parsed.backupHash) {
    return { ok: false, stale: true, message: "Резервная копия не соответствует выбранному предпросмотру Economy V2." };
  }
  return { ok: true, payload, receipt: clone(receipt) };
}

export function planEconomyV2BackupRestore({ currentData = {}, rawBackup = "", operationId = "" } = {}) {
  const id = String(operationId ?? "").trim();
  const parsed = parseEconomyV2BackupJson(rawBackup);
  if (!parsed.ok) return { ...parsed, operationId: id };
  const baseRevision = Math.max(0, Math.floor(toNumber(currentData?.meta?.revision, 0)));
  return {
    ok: true,
    operationId: id,
    baseRevision,
    baseHash: economyV2ActivationSourceHash(currentData),
    backupHash: parsed.backupHash,
    payloadHash: parsed.payloadHash,
    targetRestorableHash: parsed.restorableHash,
    sourceRevision: parsed.sourceRevision,
    createdAt: String(parsed.payload.createdAt),
    summary: {
      currentRevision: baseRevision,
      sourceRevision: parsed.sourceRevision,
      holdings: parsed.payload.data.holdings.length,
      resources: Array.isArray(parsed.payload.data.catalog?.resources) ? parsed.payload.data.catalog.resources.length : 0,
      buildings: parsed.payload.data.holdings.reduce((sum, holding) => sum + (holding?.buildings?.list ?? []).length, 0),
      residents: parsed.payload.data.holdings.reduce((sum, holding) => sum + (holding?.people?.list ?? []).length, 0)
    }
  };
}

export function applyEconomyV2BackupRestore({ data, plan, rawBackup = "" } = {}) {
  if (!data || typeof data !== "object") throw new TypeError("FBL Skyhold | Current Skyhold data is required for restore.");
  const parsed = parseEconomyV2BackupJson(rawBackup);
  if (!parsed.ok) return { ...parsed, invalid: true };
  if (!plan?.ok
    || parsed.backupHash !== String(plan.backupHash ?? "")
    || parsed.payloadHash !== String(plan.payloadHash ?? "")
    || parsed.restorableHash !== String(plan.targetRestorableHash ?? "")
    || parsed.sourceRevision !== Math.max(0, Math.floor(toNumber(plan.sourceRevision, -1)))) {
    return { ok: false, invalid: true, message: "Предпросмотр восстановления повреждён или относится к другому backup-файлу." };
  }
  if (economyV2BackupRestorableHash(data) === parsed.restorableHash) {
    return { ok: true, replay: true, changed: false, data };
  }
  const currentRevision = Math.max(0, Math.floor(toNumber(data?.meta?.revision, 0)));
  if (currentRevision !== Math.max(0, Math.floor(toNumber(plan.baseRevision, -1)))
    || economyV2ActivationSourceHash(data) !== String(plan.baseHash ?? "")) {
    return { ok: false, stale: true, message: "Данные изменились после предпросмотра восстановления; выберите файл заново." };
  }
  const target = clone(parsed.payload.data);
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, target);
  return { ok: true, replay: false, changed: true, data };
}
