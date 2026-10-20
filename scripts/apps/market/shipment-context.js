import { marketLossInsurancePayoutCopper } from "../../engines/market/cargo-aging.js";

function boundedNumber(value, fallback = 0, min = 0, max = 1) {
  const parsed = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function defaultPercent(value = 0) {
  return `${(boundedNumber(value) * 100).toFixed(1)}%`;
}

function proposalLabel(outcome = "") {
  if (outcome === "lost") return "утрата груза";
  if (outcome === "delayed") return "задержка";
  return "без последствий";
}

export function marketShipmentRiskContext(order = {}, { isGM = false, formatPercent = defaultPercent, formatCurrency = (value) => String(value) } = {}) {
  const needsResolution = String(order?.status ?? "") === "needsResolution"
    && String(order?.riskStatus ?? "") === "needsResolution";
  if (!needsResolution) return { needsResolution: false, canResolveRisk: false, genericEventText: "", gmResolution: null };

  const genericEventText = "С поставкой произошло событие. Эта партия ожидает решения GM.";
  if (!isGM) return { needsResolution: true, canResolveRisk: false, genericEventText, gmResolution: null };

  const proposal = order?.riskProposal && typeof order.riskProposal === "object" ? order.riskProposal : {};
  const outcome = ["lost", "delayed"].includes(String(proposal.outcome ?? "")) ? String(proposal.outcome) : "delayed";
  const delayQd = Math.max(1, Math.min(20, Math.ceil(Number(proposal.delayQd) || 1)));
  const payoutCopper = marketLossInsurancePayoutCopper(order);
  const insuredValueCopper = Math.max(0, Math.floor(Number(proposal.insuredValueCopper) || 0));
  const coverageRate = boundedNumber(proposal.insuranceCoverageRate);
  return {
    needsResolution: true,
    canResolveRisk: true,
    genericEventText,
    gmResolution: {
      eventId: String(proposal.id ?? order.riskResolutionId ?? ""),
      proposalOutcome: outcome,
      proposalLabel: proposalLabel(outcome),
      applyLabel: outcome === "lost" ? "Применить утрату" : `Применить задержку +${delayQd} QD`,
      lossCheckText: `${formatPercent(proposal.lossRoll)} при пороге ${formatPercent(proposal.lossChance)}`,
      delayCheckText: `${formatPercent(proposal.delayRoll)} при пороге ${formatPercent(proposal.delayChance)}`,
      delayDurationText: `${formatPercent(proposal.delayDurationRoll)} → ${delayQd} QD из ${Math.max(1, Math.ceil(Number(proposal.maxDelayQd) || 1))}`,
      insuranceText: payoutCopper > 0
        ? `${outcome === "lost" ? "при предложенной утрате на дату события" : "при новой утрате сейчас"}: выплата ${formatCurrency(payoutCopper)}; страховая стоимость на дату события ${formatCurrency(insuredValueCopper)}, покрытие ${formatPercent(coverageRate)}`
        : "при утрате выплаты нет",
      delayQd
    }
  };
}
