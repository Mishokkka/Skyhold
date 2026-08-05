import { ENTERPRISE_CAPITAL_SCHEMA_VERSION, enterpriseCapitalState } from "../core/enterprise-capital.js";
import { appendHoldingOperation, findHoldingOperation } from "./operations.js";

function text(value = "") {
  return String(value ?? "").trim();
}

function wholeCopper(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return 0;
  const whole = Math.floor(numeric);
  return Number.isSafeInteger(whole) ? whole : 0;
}

function fundingRequestHash({ buildingId = "", requestedCopper = null } = {}) {
  return JSON.stringify({
    version: ENTERPRISE_CAPITAL_SCHEMA_VERSION,
    buildingId: text(buildingId),
    requestedCopper: requestedCopper === null || requestedCopper === undefined ? "all" : wholeCopper(requestedCopper)
  });
}

function replayResult(existing, requestHash) {
  const payload = existing?.payload && typeof existing.payload === "object" ? existing.payload : {};
  if (payload.contract !== "enterprise-capital-v2" || payload.requestHash !== requestHash) {
    return { ok: false, conflict: true, duplicate: false, message: "operationId уже использован для другой операции капитала." };
  }
  return {
    ok: true,
    conflict: false,
    duplicate: true,
    operationId: existing.operationId,
    ...(payload.result && typeof payload.result === "object" ? payload.result : {})
  };
}

function appendMoneyAudit(holding, building, operationId, createdAt, commissioningCopper, reserveCopper) {
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = {};
  if (!Array.isArray(holding.storage.log)) holding.storage.log = [];
  const source = String(building?.name ?? building?.id ?? "Предприятие");
  if (commissioningCopper > 0) {
    holding.storage.log.push({
      id: `${operationId}:commissioning`,
      ts: createdAt,
      kind: "enterprise-commissioning",
      resourceId: "money",
      name: "Деньги",
      qty: -commissioningCopper,
      roomId: "",
      source,
      note: "Разовый невозвратный ввод оборудования в эксплуатацию.",
      operationId
    });
  }
  if (reserveCopper > 0) {
    holding.storage.log.push({
      id: `${operationId}:reserve`,
      ts: createdAt,
      kind: "enterprise-reserve-transfer",
      resourceId: "money",
      name: "Деньги",
      qty: -reserveCopper,
      roomId: "",
      source,
      note: "Перевод в защищённый оборотный резерв; это не доход и не расход предприятия.",
      operationId
    });
  }
  holding.storage.log = holding.storage.log.slice(-250);
}

/**
 * Atomic in-memory funding operation. The caller commits the containing holding
 * once. Money closes commissioning first and only then enters the protected
 * working-capital reserve.
 */
export function fundEnterpriseCapital(holding = {}, {
  buildingId = "",
  operationId = "",
  requestedCopper = null,
  createdAt = ""
} = {}) {
  const id = text(operationId);
  const targetId = text(buildingId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return { ok: false, conflict: false, message: "Нужен корректный operationId финансирования." };
  if (!targetId) return { ok: false, conflict: false, message: "Не выбрано предприятие для финансирования." };
  const requestHash = fundingRequestHash({ buildingId: targetId, requestedCopper });
  const existing = findHoldingOperation(holding, id);
  if (existing) return replayResult(existing, requestHash);

  const building = (holding?.buildings?.list ?? []).find((row) => text(row?.id) === targetId);
  if (!building) return { ok: false, conflict: false, message: "Предприятие не найдено." };
  const landRightsProvided = holding?.gm?.economy?.landRightsProvided === true;
  const before = enterpriseCapitalState(building, undefined, { landRightsProvided });
  if (!before.enabled) return { ok: false, conflict: false, message: "Для предприятия не включён контракт капитала." };
  if (before.legacyFundingNeedsReview) {
    return { ok: false, conflict: false, needsReview: true, message: "Старое fundedCopper требует явной сверки ГМа перед новым переводом." };
  }
  if (before.ready) return { ok: false, conflict: false, ready: true, message: "Предприятие уже готово к работе." };
  if (before.shortfallCopper <= 0) {
    return { ok: false, conflict: false, message: before.landRightReady ? "Денежный капитал уже обеспечен." : "Денежный капитал обеспечен; владению не хватает права на землю." };
  }

  if (!holding.storage || typeof holding.storage !== "object") holding.storage = {};
  const treasuryBeforeCopper = wholeCopper(holding.storage.moneyCopper);
  const requestLimit = requestedCopper === null || requestedCopper === undefined
    ? before.shortfallCopper
    : wholeCopper(requestedCopper);
  const transferredCopper = Math.min(treasuryBeforeCopper, before.shortfallCopper, requestLimit);
  if (transferredCopper <= 0) return { ok: false, conflict: false, message: "В казне нет денег для ввода или резерва предприятия." };

  const commissioningCopper = Math.min(transferredCopper, before.commissioningShortfallCopper);
  const reserveCopper = transferredCopper - commissioningCopper;
  const capital = building.enterpriseCapital && typeof building.enterpriseCapital === "object"
    ? building.enterpriseCapital
    : (building.enterpriseCapital = {});
  const priorProvenance = String(capital.fundingProvenance ?? "treasury");
  capital.version = ENTERPRISE_CAPITAL_SCHEMA_VERSION;
  capital.commissioningPaidCopper = wholeCopper(capital.commissioningPaidCopper) + commissioningCopper;
  capital.workingCapitalReserveCopper = wholeCopper(capital.workingCapitalReserveCopper) + reserveCopper;
  capital.legacyGrandfathered = false;
  capital.fundingProvenance = ["legacy", "manual", "mixed"].includes(priorProvenance) ? "mixed" : "treasury";
  holding.storage.moneyCopper = treasuryBeforeCopper - transferredCopper;

  const after = enterpriseCapitalState(building, undefined, { landRightsProvided });
  const result = {
    buildingId: targetId,
    transferredCopper,
    commissioningCopper,
    reserveCopper,
    treasuryBeforeCopper,
    treasuryAfterCopper: holding.storage.moneyCopper,
    ready: after.ready,
    landRightReady: after.landRightReady,
    commissioningReady: after.commissioningReady,
    reserveReady: after.reserveReady,
    shortfallCopper: after.shortfallCopper
  };
  appendMoneyAudit(holding, building, id, String(createdAt ?? ""), commissioningCopper, reserveCopper);
  appendHoldingOperation(holding, {
    operationId: id,
    type: "enterprise-capital",
    createdAt: String(createdAt ?? ""),
    title: `Капитал предприятия: ${String(building?.name ?? targetId)}`,
    summary: `Из казны переведено ${transferredCopper} ММ: ввод ${commissioningCopper} ММ, защищённый резерв ${reserveCopper} ММ.`,
    payload: {
      contract: "enterprise-capital-v2",
      requestHash,
      result
    }
  });
  return { ok: true, conflict: false, duplicate: false, operationId: id, ...result };
}
