import { SkyholdData } from "../../../data/store.js";
import { makeId } from "../../../data/utils.js";
import { escapeHtml } from "../../../core/helpers.js";
import { foundryDialogV2 } from "../../../integrations/foundry-runtime.js";
import {
  applyFinanceBuildingMothballControl,
  applyFinanceOrphanControl
} from "../../../workflows/economy/finance-controls.js";

function text(value) {
  return String(value ?? "").trim();
}

function activeHolding(data, holdingId) {
  return (data?.holdings ?? []).find((holding) => text(holding?.id) === text(holdingId)) ?? null;
}

function controlErrorMessage(code = "") {
  return ({
    "gm-only": "Управлять денежными обязательствами может только ГМ.",
    holding: "Владение не найдено.",
    invalid: "Операция не содержит точный id цели или operationId.",
    action: "Неизвестное действие с обязательством.",
    reason: "Нужно указать причину решения.",
    "not-found": "Денежное обязательство не найдено.",
    "not-orphaned": "Это обязательство уже не требует решения ГМа.",
    "recipient-kind": "Долг можно передать только получателю того же типа.",
    "recipient-not-found": "Новый получатель больше не существует.",
    "building-not-found": "Здание не найдено.",
    unchanged: "Состояние консервации уже изменилось.",
    "operation-conflict": "Этот operationId уже принадлежит другой финансовой операции."
  })[text(code)] ?? "Не удалось применить финансовое решение.";
}

export const FinanceControlEventActions = {
  click: {
    "resolve-finance-orphan": "_onResolveFinanceOrphan"
  },
  publicClick: []
};

export const FinanceControlEventDomain = {
_financeTransferTargets(holding, obligation) {
  const kind = text(obligation?.recipientKind);
  const source = kind === "resident"
    ? holding?.people?.list ?? []
    : kind === "building"
      ? holding?.buildings?.list ?? []
      : [];
  return source
    .filter((row) => text(row?.id) && text(row.id) !== text(obligation?.recipientId))
    .map((row) => ({
      recipientKind: kind,
      recipientId: text(row.id),
      label: text(row.name) || text(row.id)
    }));
},

async _promptFinanceReason({ title = "Финансовое решение", message = "", exactId = "", submitLabel = "Применить" } = {}) {
  const formClass = `fbls-finance-reason-${makeId("form", 8)}`;
  const content = `
    <form class="${formClass} fbls-stack">
      <p>${escapeHtml(message)}</p>
      <p class="fbls-muted-text">Точный id: <code>${escapeHtml(exactId)}</code></p>
      <label class="fbls-field fbls-field-wide">
        <span>Причина</span>
        <textarea name="reason" rows="4" required autofocus></textarea>
      </label>
    </form>`;
  const value = await foundryDialogV2().prompt({
    window: { title },
    content,
    ok: {
      label: submitLabel,
      callback: (event, button) => {
        const form = button?.form ?? event?.target?.closest?.("form") ?? globalThis.document?.querySelector?.(`.${formClass}`);
        return text(form?.elements?.reason?.value);
      }
    },
    rejectClose: false
  });
  return text(value);
},

async _promptFinanceTransfer({ obligation, targets = [] } = {}) {
  const formClass = `fbls-finance-transfer-${makeId("form", 8)}`;
  const options = targets.map((target, index) => (
    `<option value="${index}" data-recipient-kind="${escapeHtml(target.recipientKind)}" data-recipient-id="${escapeHtml(target.recipientId)}">${escapeHtml(target.label)} (${escapeHtml(target.recipientId)})</option>`
  )).join("");
  const content = `
    <form class="${formClass} fbls-stack">
      <p>Передать существующий долг другому действующему получателю. Сумма и исходный id долга не изменятся.</p>
      <p class="fbls-muted-text">Точный id: <code>${escapeHtml(obligation?.id)}</code></p>
      <label class="fbls-field fbls-field-wide">
        <span>Новый получатель</span>
        <select class="fbls-control" name="recipient" required>${options}</select>
      </label>
      <label class="fbls-field fbls-field-wide">
        <span>Причина</span>
        <textarea class="fbls-control" name="reason" rows="4" required></textarea>
      </label>
    </form>`;
  return foundryDialogV2().prompt({
    classes: ["fbl-skyhold"],
    window: { title: "Передать денежное обязательство" },
    content,
    ok: {
      label: "Передать долг",
      callback: (event, button) => {
        const form = button?.form ?? event?.target?.closest?.("form") ?? globalThis.document?.querySelector?.(`.${formClass}`);
        const selected = form?.elements?.recipient?.selectedOptions?.[0];
        return {
          recipientKind: text(selected?.dataset?.recipientKind),
          recipientId: text(selected?.dataset?.recipientId),
          reason: text(form?.elements?.reason?.value)
        };
      }
    },
    rejectClose: false
  });
},

async _executeFinanceOrphanControl({
  holdingId = "",
  obligationId = "",
  action = "",
  recipientKind = "",
  recipientId = "",
  reason = "",
  operationId = "",
  resolvedAt = ""
} = {}) {
  if (!globalThis.game?.user?.isGM) return { ok: false, replay: false, code: "gm-only" };
  const result = await SkyholdData.updateHolding(text(holdingId), (holding) => {
    const applied = applyFinanceOrphanControl({
      holding,
      obligationId,
      action,
      recipientKind,
      recipientId,
      reason,
      operationId,
      resolvedAt
    });
    return applied.ok && !applied.replay ? applied : SkyholdData.skipTransaction(applied);
  }, { fallback: false, reason: `finance:orphan-control:${text(operationId)}` });
  return result ?? { ok: false, replay: false, code: "holding" };
},

async _executeFinanceBuildingMothball({
  holdingId = "",
  buildingId = "",
  mothballed = true,
  reason = "",
  operationId = "",
  changedAt = ""
} = {}) {
  if (!globalThis.game?.user?.isGM) return { ok: false, replay: false, code: "gm-only" };
  const result = await SkyholdData.updateHolding(text(holdingId), (holding) => {
    const applied = applyFinanceBuildingMothballControl({
      holding,
      buildingId,
      mothballed,
      reason,
      operationId,
      changedAt
    });
    return applied.ok && !applied.replay ? applied : SkyholdData.skipTransaction(applied);
  }, { fallback: false, reason: `finance:building-mothball:${text(operationId)}` });
  return result ?? { ok: false, replay: false, code: "holding" };
},

async _onResolveFinanceOrphan(event) {
  event.preventDefault();
  event.stopPropagation();
  if (!globalThis.game?.user?.isGM) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage("gm-only"));
    return;
  }
  const holdingId = text(this.activeHoldingId);
  const obligationId = text(event.currentTarget?.dataset?.obligationId);
  const action = text(event.currentTarget?.dataset?.mode).toLowerCase();
  const holding = activeHolding(SkyholdData.get(), holdingId);
  const obligation = (holding?.finance?.obligations ?? []).find((row) => text(row?.id) === obligationId);
  if (!holding || !obligation) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage(!holding ? "holding" : "not-found"));
    return;
  }

  let reason = "";
  let recipientKind = "";
  let recipientId = "";
  if (action === "transfer") {
    const targets = this._financeTransferTargets(holding, obligation);
    if (!targets.length) {
      globalThis.ui?.notifications?.warn?.("Нет действующего получателя того же типа, которому можно передать долг.");
      return;
    }
    const answer = await this._promptFinanceTransfer({ obligation, targets });
    if (!answer) return;
    reason = text(answer.reason);
    recipientKind = text(answer.recipientKind);
    recipientId = text(answer.recipientId);
  } else if (action === "waive") {
    reason = await this._promptFinanceReason({
      title: "Списать денежное обязательство",
      message: "Списать остаток долга без выплаты? Это решение сохранится в финансовой истории.",
      exactId: obligationId,
      submitLabel: "Списать долг"
    });
  } else {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage("action"));
    return;
  }
  if (!reason) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage("reason"));
    return;
  }

  const operationId = makeId(`finance-orphan-${action}`, 20);
  const result = await this._executeFinanceOrphanControl({
    holdingId,
    obligationId,
    action,
    recipientKind,
    recipientId,
    reason,
    operationId,
    resolvedAt: new Date().toISOString()
  });
  if (!result?.ok) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage(result?.code));
    return;
  }
  this.requestRender?.();
  globalThis.ui?.notifications?.info?.(result.replay
    ? "Это финансовое решение уже было применено."
    : action === "transfer" ? "Долг передан новому получателю." : "Долг списан с указанной причиной.");
},

async _onSetFinanceBuildingMothball({ holdingId = "", buildingId = "", mothballed = true } = {}) {
  if (!globalThis.game?.user?.isGM) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage("gm-only"));
    return { ok: false, replay: false, code: "gm-only" };
  }
  const data = SkyholdData.get();
  const holding = activeHolding(data, holdingId);
  const building = (holding?.buildings?.list ?? []).find((row) => text(row?.id) === text(buildingId));
  if (!holding || !building) {
    const result = { ok: false, replay: false, code: !holding ? "holding" : "building-not-found" };
    globalThis.ui?.notifications?.warn?.(controlErrorMessage(result.code));
    return result;
  }
  const desired = Boolean(mothballed);
  const reason = await this._promptFinanceReason({
    title: desired ? "Законсервировать здание" : "Снять консервацию",
    message: desired
      ? `Отключить все механические эффекты здания «${text(building.name) || text(building.id)}» и остановить новые начисления содержания? Старые долги сохранятся.`
      : `Вернуть здание «${text(building.name) || text(building.id)}» в экономический цикл? Неоплаченные обязательства продолжат блокировать его функции.`,
    exactId: text(building.id),
    submitLabel: desired ? "Законсервировать" : "Снять консервацию"
  });
  if (!reason) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage("reason"));
    return { ok: false, replay: false, code: "reason" };
  }
  const operationId = makeId(desired ? "finance-mothball" : "finance-unmothball", 20);
  const result = await this._executeFinanceBuildingMothball({
    holdingId: text(holding.id),
    buildingId: text(building.id),
    mothballed: desired,
    reason,
    operationId,
    changedAt: new Date().toISOString()
  });
  if (!result?.ok) {
    globalThis.ui?.notifications?.warn?.(controlErrorMessage(result?.code));
    return result;
  }
  this.requestRender?.();
  globalThis.ui?.notifications?.info?.(result.replay
    ? "Это изменение консервации уже было применено."
    : desired ? "Здание законсервировано." : "Консервация снята.");
  return result;
}
};
