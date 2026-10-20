import { financeObligationOutstandingCopper } from "../../../engines/economy/finance-obligations.js";

const OBLIGATION_KIND_LABELS = Object.freeze({
  wage: "Зарплата",
  "building-base-upkeep": "Базовое содержание",
  "building-operating-upkeep": "Работа функции",
  "loan-payment": "Платёж по займу",
  other: "Обязательство"
});

function text(value) {
  return String(value ?? "").trim();
}

function recipientRows(holding, kind) {
  if (kind === "resident") return holding?.people?.list ?? [];
  if (kind === "building") return holding?.buildings?.list ?? [];
  return [];
}

export const FinanceControlsDomain = {
_financeBuildingMothballed(holding, buildingId = "") {
  const id = text(buildingId);
  return Boolean(id && holding?.finance?.buildingStates?.[id]?.mothballed);
},

_financeControlsContext(holding) {
  const canManage = Boolean(globalThis.game?.user?.isGM);
  const obligations = Array.isArray(holding?.finance?.obligations) ? holding.finance.obligations : [];
  const rows = obligations
    .filter((row) => Boolean(row?.orphaned) && !text(row?.orphanResolvedAt) && financeObligationOutstandingCopper(row) > 0)
    .map((row) => {
      const kind = text(row.recipientKind);
      const transferTargets = recipientRows(holding, kind).filter((candidate) => text(candidate?.id) && text(candidate.id) !== text(row.recipientId));
      const outstandingCopper = financeObligationOutstandingCopper(row);
      return {
        id: text(row.id),
        kind: text(row.kind),
        kindLabel: OBLIGATION_KIND_LABELS[text(row.kind)] ?? (text(row.kind) || OBLIGATION_KIND_LABELS.other),
        recipientKind: kind,
        recipientId: text(row.recipientId),
        recipientLabel: kind === "resident" ? "Удалённый житель" : kind === "building" ? "Удалённое здание" : "Удалённый получатель",
        outstandingCopper,
        outstandingText: this._formatCopperCurrency?.(outstandingCopper) ?? `${outstandingCopper} ММ`,
        canTransfer: canManage && transferTargets.length > 0,
        transferTargetCount: transferTargets.length
      };
    });
  return {
    canManage,
    rows,
    count: rows.length,
    hasRows: rows.length > 0
  };
}
};
