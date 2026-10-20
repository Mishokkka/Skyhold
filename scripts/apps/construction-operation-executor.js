import { SkyholdData } from "../data/store.js";
import { COMMAND_ERROR } from "../data/command-result.js";
import { appendHoldingOperation, findHoldingOperation } from "../data/operations.js";
import { toNumber } from "../data/utils.js";
import { rollD6Pool } from "../core/helpers.js";
import { advanceBuildingProject, buildingOperationalState } from "../core/building-state.js";
import {
  constructionAttemptGate,
  constructionPeriodForHolding,
  resolveConstructionAttempt
} from "../engines/economy/construction-stages.js";
import { constructionCenterSuccessBonus } from "../engines/economy/construction-center.js";
import { AssignmentDomain } from "./domains/assignment-domain.js";
import { BuildingDomain } from "./domains/building-domain.js";
import { FinanceDomain } from "./domains/finance-domain.js";
import { ResidentDomain } from "./domains/resident-domain.js";
import { composeDomainGroup } from "./domains/compose-domain.js";

const OPERATION_TYPE = "rollConstruction";
const HOLDING_OPERATION_TYPE = "construction-attempt";

const ConstructionOperationLogic = composeDomainGroup("ConstructionOperationLogic", [
  ["ResidentDomain", ResidentDomain],
  ["BuildingDomain", BuildingDomain],
  ["AssignmentDomain", AssignmentDomain],
  ["FinanceDomain", FinanceDomain],
  ["ConstructionOperationSupport", {
    _safeNumber(value, fallback = 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }
  }]
]);

function constructionError(message, code = COMMAND_ERROR.EXECUTION_FAILED, extra = {}) {
  const error = new Error(`FBL Skyhold | ${message}`);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function normalizeOperation(raw = {}) {
  const type = String(raw?.type ?? "");
  if (type !== OPERATION_TYPE) throw constructionError("Unknown construction operation.", COMMAND_ERROR.INVALID);
  const operationId = String(raw?.operationId ?? "").trim();
  const holdingId = String(raw?.holdingId ?? "").trim();
  const buildingId = String(raw?.buildingId ?? "").trim();
  const crewId = String(raw?.crewId ?? "").trim();
  const expectedRevision = Number(raw?.expectedRevision);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) {
    throw constructionError("Construction operation id is missing or invalid.", COMMAND_ERROR.INVALID);
  }
  if (!holdingId || !buildingId || !crewId) {
    throw constructionError("Construction operation target is incomplete.", COMMAND_ERROR.INVALID);
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw constructionError("Construction operation expected revision is invalid.", COMMAND_ERROR.INVALID);
  }
  return { type, operationId, holdingId, buildingId, crewId, expectedRevision };
}

function operationKey(operation = {}) {
  return [operation.type, operation.holdingId, operation.buildingId, operation.crewId].join(":");
}

function userById(userId = "") {
  return globalThis.game?.users?.get?.(userId)
    ?? (Array.isArray(globalThis.game?.users?.contents)
      ? globalThis.game.users.contents.find((user) => String(user?.id ?? "") === String(userId ?? ""))
      : null);
}

function holdingAllowsOperation(holding, user) {
  if (!holding || !user) return false;
  if (user.isGM) return true;
  return holding.visibility !== "gm" && holding?.gm?.playersCanEditBuildings === true;
}

function builderRerollMonthKey(holding = {}, now = () => new Date()) {
  const key = String(holding?.gm?.calendaria?.lastDateKey ?? "").trim();
  const match = key.match(/^(-?\d+)\D+(\d+)/);
  if (match) return `${match[1]}-${match[2]}`;
  const date = now();
  return `${date.getUTCFullYear()}-${date.getUTCMonth() + 1}`;
}

function rawCrewForPrepared(holding = {}, crew = {}) {
  const id = String(crew?.id ?? "");
  return (holding?.constructionCrews ?? []).find((item) => String(item?.id ?? "") === id) ?? null;
}

function applyBuilderReroll({ holding, crew, dicePool, firstRolls, rollDice, now, logic }) {
  const leader = crew?.leader ?? null;
  const hasBuilder = leader && logic._traitBadges(leader?.traitsText ?? leader?.traits)
    .some((trait) => String(trait?.name ?? "").trim().toLowerCase() === "builder");
  if (!hasBuilder) return { rolls: firstRolls, used: false, note: "" };
  const rawCrew = rawCrewForPrepared(holding, crew);
  if (!rawCrew) return { rolls: firstRolls, used: false, note: "" };
  const monthKey = builderRerollMonthKey(holding, now);
  if (String(rawCrew.builderRerollMonth ?? "") === monthKey) {
    return { rolls: firstRolls, used: false, note: `Builder уже использован в этом месяце (${monthKey}).` };
  }
  const secondRolls = rollDice(Math.max(1, dicePool));
  const firstSuccesses = firstRolls.filter((value) => value >= 6).length;
  const secondSuccesses = secondRolls.filter((value) => value >= 6).length;
  rawCrew.builderRerollMonth = monthKey;
  rawCrew.builderRerollLastLeaderId = String(leader.id ?? "");
  rawCrew.builderRerollLastAt = now().toISOString();
  if (secondSuccesses > firstSuccesses) {
    return { rolls: secondRolls, used: true, note: `Builder: ${leader.name || "лидер"} перебросил кубы строительства за ${monthKey}. Было ${firstSuccesses}, стало ${secondSuccesses}.` };
  }
  return { rolls: firstRolls, used: true, note: `Builder: ${leader.name || "лидер"} перебросил кубы строительства за ${monthKey}, но оставлен первый результат (${firstSuccesses} против ${secondSuccesses}).` };
}

function replayResult(entry, operation, userId) {
  if (!entry) return null;
  if (String(entry?.type ?? "") !== HOLDING_OPERATION_TYPE
    || entry?.payload?.signature !== JSON.stringify(operation)
    || entry?.payload?.userId !== String(userId)) {
    throw constructionError("Construction operation id is already used for another command.", COMMAND_ERROR.CONFLICT);
  }
  return {
    ...(entry?.payload?.result && typeof entry.payload.result === "object" ? entry.payload.result : {}),
    ok: true,
    duplicate: true,
    operationId: operation.operationId
  };
}

function rememberResult(holding, operation, result, now, userId) {
  appendHoldingOperation(holding, {
    id: operation.operationId,
    operationId: operation.operationId,
    type: HOLDING_OPERATION_TYPE,
    createdAt: now().toISOString(),
    title: `Строительство: ${result.buildingName}`,
    summary: `${result.successes} усп.; ${result.oldProgress} → ${result.nextProgress}/${result.target}`,
    payload: {
      operationKey: operationKey(operation),
      signature: JSON.stringify(operation),
      userId: String(userId),
      buildingId: operation.buildingId,
      crewId: operation.crewId,
      result
    }
  });
}

export function createConstructionOperationExecutor({
  logic = ConstructionOperationLogic,
  updateHolding = (holdingId, updater, options) => SkyholdData.updateHolding(holdingId, updater, options),
  skipTransaction = (value) => SkyholdData.skipTransaction(value),
  getUser = userById,
  rollDice = rollD6Pool,
  now = () => new Date()
} = {}) {
  const operationResults = new Map();

  async function executeOnce(rawOperation, { userId = "", remote = false } = {}) {
    const operation = normalizeOperation(rawOperation);
    const requester = getUser(userId);
    if (!requester) throw constructionError("Construction operation requester was not found.", COMMAND_ERROR.FORBIDDEN);
    if (remote && requester.isGM) {
      throw constructionError("Remote construction operations cannot claim GM authority.", COMMAND_ERROR.FORBIDDEN);
    }

    const result = await updateHolding(operation.holdingId, (holding, data) => {
      if (!holdingAllowsOperation(holding, requester)) {
        throw constructionError("Нет прав на строительные операции в этом владении.", COMMAND_ERROR.FORBIDDEN);
      }

      const replay = replayResult(findHoldingOperation(holding, operation.operationId), operation, userId);
      if (replay) return skipTransaction(replay);

      const currentRevision = Math.max(0, Math.floor(toNumber(data?.meta?.revision, 0)));
      if (operation.expectedRevision !== currentRevision) {
        throw constructionError("Данные владения изменились. Открой окно заново и повтори бросок.", COMMAND_ERROR.CONFLICT, {
          revision: currentRevision,
          retryable: true
        });
      }

      const building = (holding?.buildings?.list ?? []).find((row) => String(row?.id ?? "") === operation.buildingId);
      if (!building) throw constructionError("Строительный проект не найден.", COMMAND_ERROR.INVALID);
      if (String(building?.constructionCrewId ?? "") !== operation.crewId) {
        throw constructionError("На проект назначена другая стройбригада.", COMMAND_ERROR.CONFLICT);
      }

      const crew = logic._constructionCrew(holding, operation.crewId);
      if (!crew?.count || !crew?.dice) throw constructionError("Стройбригада пуста.", COMMAND_ERROR.INVALID);
      const period = constructionPeriodForHolding(holding);
      const gate = constructionAttemptGate({ holding, crewId: crew.id, crew, period });
      if (!gate.ok) throw constructionError(gate.message, gate.replay ? COMMAND_ERROR.CONFLICT : COMMAND_ERROR.INVALID);

      const difficulty = logic._safeNumber(building.buildDifficulty, 0);
      const dicePool = Math.max(1, crew.dice + difficulty);
      const firstRolls = rollDice(dicePool);
      const reroll = applyBuilderReroll({ holding, crew, dicePool, firstRolls, rollDice, now, logic });
      const rolls = reroll.rolls;
      const rolledSuccesses = rolls.filter((value) => value >= 6).length;
      const successBonus = constructionCenterSuccessBonus(holding, crew.id);
      const successes = rolledSuccesses + successBonus;
      const progress = resolveConstructionAttempt({
        holding,
        building,
        crewId: crew.id,
        crew,
        successes,
        period,
        operationId: operation.operationId,
        dependencies: {
          buildingOperationalState,
          advanceBuildingProject,
          planStorageCosts: (draft, costs) => logic._storageCanPay(draft, costs),
          payStorageCosts: (draft, costs) => logic._storagePay(draft, costs),
          appendStorageLog: (draft, entries) => logic._appendStorageLog(draft, entries)
        }
      });
      if (!progress.attempted) throw constructionError(progress.message || "Строительный бросок не применён.", COMMAND_ERROR.INVALID);
      building.status = progress.completed ? "Построено" : (progress.kind === "repair" ? "Ремонтируется" : "Строится");

      const publicResult = {
        ok: true,
        operationId: operation.operationId,
        holdingName: String(holding.name || "Владение"),
        buildingName: String(building.name || "Постройка"),
        crewNames: String(crew.names || crew.name || "Стройбригада"),
        rawDice: Math.max(0, Number(crew.rawDice) || 0),
        moraleMod: Number(crew.moraleMod) || 0,
        moraleReason: String(crew.moraleReason || ""),
        difficulty,
        dicePool,
        rolls: rolls.map((value) => Number(value) || 0),
        rolledSuccesses,
        successBonus,
        successes,
        requestedStages: progress.requestedStages,
        appliedStages: progress.appliedStages,
        missingText: String(progress.missingText || ""),
        oldProgress: progress.oldProgress,
        nextProgress: progress.nextProgress,
        target: progress.target,
        rerollNote: String(reroll.note || "")
      };
      rememberResult(holding, operation, publicResult, now, userId);
      return publicResult;
    }, { fallback: false, reason: "construction-operation:roll" });

    if (!result) throw constructionError("Construction operation holding was not found.", COMMAND_ERROR.INVALID);
    return result;
  }

  return async function executeConstructionOperation(rawOperation, context = {}) {
    if (["cancelProductionBatch", "deleteProductionLine"].includes(rawOperation.type)) {
      const { executeProductionOperation } = await import("./production-operation-executor.js");
      return executeProductionOperation(rawOperation, context, { updateHolding, skipTransaction, getUser, logic, now });
    }
    const operation = normalizeOperation(rawOperation);
    const requester = getUser(context.userId);
    if (!requester || (context.remote && requester.isGM)) {
      throw constructionError("Нет прав на повтор строительной операции.", COMMAND_ERROR.FORBIDDEN);
    }
    const signature = JSON.stringify([String(context.userId ?? ""), Boolean(context.remote), operation]);
    const cached = operationResults.get(operation.operationId);
    if (cached) {
      if (cached.signature !== signature) {
        throw constructionError("Construction operation id is already used for another command.", COMMAND_ERROR.CONFLICT);
      }
      const replay = await cached.pending;
      return { ...replay, duplicate: true };
    }
    const pending = executeOnce(operation, context);
    operationResults.set(operation.operationId, { signature, pending });
    if (operationResults.size > 500) operationResults.delete(operationResults.keys().next().value);
    try {
      return await pending;
    } catch (error) {
      operationResults.delete(operation.operationId);
      throw error;
    }
  };
}

export const executeConstructionOperation = createConstructionOperationExecutor();
