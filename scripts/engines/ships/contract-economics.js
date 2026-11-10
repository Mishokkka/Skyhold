import { transportInteger, transportMoney } from "../transport/quantities.js";

const labels = { cautious: "Осторожно", normal: "Обычно", bold: "С риском" };
const percent = (amount, rate) => Math.ceil(amount * rate / 100);

function terms(contract, style) {
  const value = contract.economics;
  if (value?.version !== 1 || !Object.hasOwn(labels, style)) throw new Error("Неизвестные условия заказа.");
  if (!["freight", "smuggling", "commission"].includes(contract.kind)) throw new Error("Неизвестный вид контракта.");
  transportInteger(contract.rewardCopper, "плата заказа", 0, 1000000000);
  for (const key of ["repairCopper", "delayDailyCopper", "precautionCopper"]) transportInteger(value[key], key);
  transportInteger(value.riskBps, "риск заказа", 0, 10000);
  transportInteger(value.approachRiskBps ?? 0, "риск подлёта", 0, value.riskBps);
  const factor = style === "cautious" ? 0.75 : style === "bold" ? 1.5 : 1;
  return { ...value, riskBps: Math.min(10000, Math.ceil(value.riskBps * factor)),
    approachRiskBps: Math.min(10000, Math.ceil((value.approachRiskBps ?? 0) * factor)) };
}

/** New agreements store their own terms. Old agreements continue through the legacy resolver. */
export function economicContractGuidance(contract, style, { commercialOnly = false } = {}) {
  const value = terms(contract, style);
  const operating = transportInteger(contract.guidance?.operatingCopper ?? 0, "расходы заказа");
  const precaution = style === "cautious" ? value.precautionCopper : 0;
  const reserve = commercialOnly ? 0 : transportMoney([value.repairCopper, value.delayDailyCopper * 2, precaution]);
  return { style, styleLabel: labels[style], operatingCopper: operating,
    preparationCopper: contract.guidance?.preparationCopper ?? 0,
    minimumBudgetCopper: operating, suggestedBudgetCopper: transportMoney([operating, reserve]),
    rewardRangeCopper: { min: contract.kind === "smuggling" ? 0 : percent(contract.rewardCopper, contract.kind === "freight" ? 56.25 : 37.5),
      max: contract.rewardCopper + (style === "bold" ? percent(contract.rewardCopper, 2) : 0) },
    incidentPressure: value.riskBps / 1000, riskBps: value.riskBps };
}

export function economicContractOutcome(contract, style, { commercialDice, incidentRoll, passageRoll, commercialOnly = false, sharedIncident = null, sharedPassageAllowsBonus = true } = {}) {
  const value = terms(contract, style);
  transportInteger(passageRoll, "бросок риска", 1, 10000);
  const total = commercialDice[0] + commercialDice[1];
  let rewardPercent = 100, commercialLabel = contract.kind === "commission" ? "Поручение выполнено" : "Груз доставлен";
  if (total === 2) {
    rewardPercent = contract.kind === "smuggling" ? 0 : contract.kind === "commission" ? 50 : 75;
    commercialLabel = contract.kind === "smuggling" ? "Сделка сорвана" : "Отмена заказчиком: выплата по договору";
  } else if (contract.kind === "smuggling" && total <= 4) {
    rewardPercent = 50; commercialLabel = "Посредник выплатил часть платы";
  }
  let incident = { eventId: "quiet-passage", eventLabel: "Спокойный перелёт", delayQd: 0, damagePercent: 0, cargoRewardPercent: 100 };
  if (sharedIncident) incident = sharedIncident;
  else if (!commercialOnly && passageRoll <= value.riskBps) {
    if (incidentRoll <= 2) incident = { eventId: "cargo-damage", eventLabel: "Повреждение груза и оснастки", delayQd: 8, damagePercent: 100, cargoRewardPercent: 75 };
    else if (incidentRoll <= 5) incident = { eventId: "damaged-rigging", eventLabel: "Ремонт оснастки", delayQd: 4, damagePercent: 50, cargoRewardPercent: 100 };
    else if (incidentRoll <= 8) incident = { eventId: "bad-weather", eventLabel: "Задержка из-за погоды", delayQd: 4, damagePercent: 0, cargoRewardPercent: 100 };
    else incident = { eventId: "port-inspection", eventLabel: "Портовая проверка", delayQd: 1, damagePercent: 0, cargoRewardPercent: 100 };
    if (passageRoll <= value.approachRiskBps && incident.cargoRewardPercent < 100) {
      incident = { ...incident, eventId: "approach-damage", eventLabel: "Повреждение оснастки на подлёте", cargoRewardPercent: 100 };
    }
  }
  const bonus = style === "bold" && rewardPercent === 100 && incident.cargoRewardPercent === 100
    && incident.delayQd === 0 && sharedPassageAllowsBonus ? 2 : 0;
  const rewardCopper = percent(percent(contract.rewardCopper, rewardPercent), incident.cargoRewardPercent) + percent(contract.rewardCopper, bonus);
  const expenseCopper = commercialOnly ? 0 : transportMoney([
    percent(value.repairCopper, incident.damagePercent), Math.ceil(value.delayDailyCopper * incident.delayQd / 4),
    style === "cautious" ? value.precautionCopper : 0
  ]);
  return { rewardCopper: transportInteger(rewardCopper, "плата заказа"), expenseCopper,
    delayQd: commercialOnly ? 0 : incident.delayQd,
    attentionDelta: contract.kind === "smuggling" ? 1 : total === 12 ? 1 : 0,
    commercialLabel, eventId: incident.eventId, eventLabel: incident.eventLabel,
    commercialDice, incidentRoll, passageRoll, effectiveIncidentRoll: incident.delayQd ? incidentRoll : 12,
    physicalIncident: incident, riskBps: value.riskBps };
}
