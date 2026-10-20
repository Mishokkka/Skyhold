import { planShipVoyage } from "./voyage.js";

const KINDS = new Set(["freight", "smuggling", "commission"]);
const STYLES = new Set(["cautious", "normal", "bold"]);
const MAX_MONEY = 1_000_000_000;

const KIND_LABELS = {
  freight: "Фрахт",
  smuggling: "Контрабандная поставка",
  commission: "Особое поручение"
};

const STYLE_RULES = {
  cautious: { incidentShift: 1, extraExpensePercent: 30, severeExpensePercent: 0, successBonusPercent: 0, label: "Осторожно" },
  normal: { incidentShift: 0, extraExpensePercent: 0, severeExpensePercent: 0, successBonusPercent: 0, label: "Обычно" },
  bold: { incidentShift: 0, extraExpensePercent: 0, severeExpensePercent: 25, successBonusPercent: 25, label: "С риском" }
};

const INCIDENTS = [
  { id: "cargo-seized", label: "Груз конфискован", expensePercent: 120, delayQd: 8, rewardFactorPercent: 0, bonusPercent: 0, attentionDelta: 3 },
  { id: "full-inspection", label: "Полный досмотр", expensePercent: 55, delayQd: 8, rewardFactorPercent: 55, bonusPercent: 0, attentionDelta: 2 },
  { id: "inside-betrayal", label: "Предательство посредника", expensePercent: 50, delayQd: 4, rewardFactorPercent: 70, bonusPercent: 0, attentionDelta: 2 },
  { id: "air-raiders", label: "Нападение воздушных разбойников", expensePercent: 35, delayQd: 8, rewardFactorPercent: 80, bonusPercent: 0, attentionDelta: 1 },
  { id: "damaged-rigging", label: "Повреждение оснастки", expensePercent: 25, delayQd: 4, rewardFactorPercent: 90, bonusPercent: 0, attentionDelta: 1 },
  { id: "urgent-bribes", label: "Незапланированные взятки", expensePercent: 10, delayQd: 0, rewardFactorPercent: 95, bonusPercent: 0, attentionDelta: 1 },
  { id: "bad-weather", label: "Неблагоприятная погода", expensePercent: 5, delayQd: 4, rewardFactorPercent: 100, bonusPercent: 0, attentionDelta: 0 },
  { id: "quiet-passage", label: "Спокойный перелёт", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 0, attentionDelta: 0 },
  { id: "useful-contact", label: "Полезное знакомство", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 5, attentionDelta: -1 },
  { id: "eager-buyer", label: "Нетерпеливый покупатель", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 10, attentionDelta: 0 },
  { id: "discreet-passage", label: "Незаметный проход", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 15, attentionDelta: -1 },
  { id: "rare-opportunity", label: "Редкая возможность", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 25, attentionDelta: 1 }
];

const TITLE_VARIANTS = {
  freight: ["Почтовые мешки", "Срочная партия мануфактуры", "Хрупкий заказ", "Сборный фрахт"],
  smuggling: ["Ящики без клейма", "Груз для тайной пристани", "Запрещённые печатные листы", "Закрытый заказ посредника"],
  commission: ["Вывоз пассажира", "Запечатанное письмо", "Поиск пропавшего курьера", "Срочное поручение"]
};

function integer(value, name, min = 0, max = MAX_MONEY) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Некорректное значение: ${name}.`);
  return value;
}

function randomUnit(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new RangeError("Генератор случайных чисел вернул значение вне диапазона 0–1.");
  return value;
}

function moneyPercent(value, percent, name) {
  integer(value, name);
  integer(percent, `${name}: процент`, 0, 1000);
  return integer(Math.round(value * percent / 100), name);
}

function moneyAdd(left, right, name) {
  integer(left, name);
  integer(right, name);
  return integer(left + right, name);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedDirection(destination) {
  const normalized = String(destination ?? "").normalize("NFKC").trim().toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!normalized) throw new Error("Укажите пункт назначения.");
  return `destination:${normalized}`;
}

function directionKey(route) {
  const explicit = String(route?.directionKey ?? "").trim();
  if (/^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,79}$/u.test(explicit) && !["__proto__", "prototype", "constructor"].includes(explicit)) return explicit;
  return normalizedDirection(route?.destination);
}

function attentionEntry(ship, key) {
  const map = ship?.attentionByDirection;
  if (!map || typeof map !== "object" || !Object.prototype.hasOwnProperty.call(map, key)) return 0;
  return map[key];
}

/** Attention accepts legacy numeric values and the richer {level,...} record used by outcomes. */
export function attentionLevel(ship, key) {
  const entry = attentionEntry(ship, String(key ?? ""));
  const value = typeof entry === "object" && entry !== null ? entry.level : entry;
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(10, value)) : 0;
}

export function attentionLabel(level) {
  integer(level, "внимание", 0, 10);
  if (level <= 1) return "Незнакомый флаг";
  if (level <= 3) return "Знакомое имя";
  if (level <= 5) return "На слуху";
  if (level <= 7) return "Известный перевозчик";
  if (level <= 9) return "Громкое имя";
  return "Центр внимания";
}

function snapshotRoute(ship) {
  const route = ship?.routePlan ?? {};
  const destination = String(route.destination ?? "").trim().slice(0, 160);
  if (!destination) throw new Error("Укажите пункт назначения.");
  const distanceKm = integer(route.distanceKm, "расстояние", 1, 1_000_000);
  const portDays = integer(route.portDays ?? 0, "дни в порту", 0, 1000);
  const preparationCopper = integer(route.preparationCopper ?? 0, "подготовка");
  const upkeepPerDayCopper = integer(route.upkeepPerDayCopper ?? 0, "содержание");
  const baseRewardCopper = integer(route.rewardCopper ?? 0, "базовая награда");
  const speedKmPerDay = integer(ship?.speedKmPerDay, "скорость", 1, 10000);
  const key = directionKey(route);
  const legs = [{ type: "flight", distanceMeters: distanceKm * 1000 }, { type: "port", durationQd: portDays * 4 }, { type: "flight", distanceMeters: distanceKm * 1000 }];
  const durationQd = integer(planShipVoyage({ legs, startQd: 0, speedKmPerDay }).durationQd, "длительность", 1, 100000);
  const operatingCopper = integer(Math.ceil(upkeepPerDayCopper * durationQd / 4), "расходы рейса");
  const baseCost = moneyAdd(preparationCopper, operatingCopper, "базовые расходы");
  // Validate the most expensive generated terms before consuming random numbers.
  moneyPercent(baseRewardCopper, 187, "максимальная награда предложения");
  const worstOutcomeExpense = moneyAdd(moneyPercent(baseCost, 170, "максимальные расходы исхода"), Math.ceil(upkeepPerDayCopper * 8 / 4), "максимальные расходы исхода");
  moneyAdd(operatingCopper, worstOutcomeExpense, "максимальный рекомендуемый бюджет");
  return { destination, directionKey: key, distanceKm, portDays, preparationCopper, upkeepPerDayCopper, baseRewardCopper, speedKmPerDay, durationQd, operatingCopper };
}

function offerKind(index, attention, random) {
  if (index === 0) return "freight";
  if (index === 1) return "commission";
  const roll = randomUnit(random);
  const smugglingChance = attention >= 8 ? 0.8 : attention >= 5 ? 0.55 : 0.25;
  return roll < smugglingChance ? "smuggling" : (roll < (smugglingChance + (1 - smugglingChance) / 2) ? "freight" : "commission");
}

function offerReward(base, kind, attention, random) {
  const variation = 90 + Math.floor(randomUnit(random) * 21); // 90–110%.
  const kindPercent = kind === "freight" ? 100 : kind === "commission" ? 115 : 130 + Math.max(0, attention - 5) * 8;
  return moneyPercent(base, Math.round(variation * kindPercent / 100), "награда предложения");
}

export function contractGuidance(offer, style = "normal", { commercialOnly = false } = {}) {
  if (!STYLES.has(style)) throw new Error("Неизвестный стиль выполнения контракта.");
  const rule = STYLE_RULES[style];
  const reward = integer(offer?.rewardCopper, "награда предложения");
  const operating = integer(offer?.guidance?.operatingCopper ?? offer?.operatingCopper ?? 0, "расходы рейса");
  const preparation = integer(offer?.guidance?.preparationCopper ?? offer?.routePlan?.preparationCopper ?? 0, "подготовка");
  const upkeepPerDay = integer(offer?.routePlan?.upkeepPerDayCopper ?? 0, "содержание");
  const baseCost = moneyAdd(operating, preparation, "базовые расходы");
  const attention = integer(offer?.attention?.level ?? 0, "внимание", 0, 10);
  const incidentPenalty = Math.floor(attention / 5) + (offer.kind === "smuggling" ? 1 : 0);
  const reachable = Array.from({ length: 12 }, (_, index) => Math.max(1, Math.min(12, index + 1 + rule.incidentShift - incidentPenalty)));
  const incidentReserve = commercialOnly ? 0 : Math.max(...reachable.map((roll) => {
    const incident = incidentForKind(INCIDENTS[roll - 1], offer.kind);
    const surcharge = incident.expensePercent >= 25 ? rule.severeExpensePercent : 0;
    const eventCost = moneyAdd(moneyPercent(baseCost, incident.expensePercent, "резерв происшествия"),
      moneyPercent(baseCost, surcharge, "резерв рискованного хода"), "резерв происшествия");
    return moneyAdd(eventCost, integer(Math.ceil(upkeepPerDay * incident.delayQd / 4), "содержание задержки"), "резерв происшествия");
  }));
  const commercialExpensePercent = offer.kind === "smuggling" ? 50 : offer.kind === "commission" ? 35 : 20;
  const precautionCopper = moneyPercent(baseCost, rule.extraExpensePercent, "расход на осторожность");
  const reserveCopper = moneyAdd(moneyAdd(moneyPercent(baseCost, commercialExpensePercent, "коммерческий резерв"), incidentReserve, "полный резерв"), precautionCopper, "полный резерв");
  return {
    style, styleLabel: rule.label,
    preparationCopper: preparation, operatingCopper: operating,
    minimumBudgetCopper: operating,
    suggestedBudgetCopper: moneyAdd(operating, reserveCopper, "рекомендуемый бюджет"),
    rewardRangeCopper: {
      min: kindMinimumReward(offer.kind, reward),
      max: moneyPercent(reward, (offer.kind === "smuggling" ? 225 : offer.kind === "commission" ? 185 : 155) + rule.successBonusPercent, "максимальная награда")
    },
    incidentPressure: Math.min(10, Math.max(0, attention + (offer.kind === "smuggling" ? 2 : 0) - rule.incidentShift + (style === "bold" ? 1 : 0)))
  };
}

function kindMinimumReward(kind, reward) {
  if (!KINDS.has(kind)) throw new Error("Неизвестный вид контракта.");
  integer(reward, "минимальная награда");
  return 0;
}

/** Generate four offers from the GM-authored route rates; no global geography or price table is consulted. */
export function generateShipOffers(ship, { period, random = Math.random } = {}) {
  if (typeof ship?.id !== "string" || !ship.id.trim()) throw new Error("У корабля отсутствует ID.");
  const periodKey = String(period ?? "").trim().slice(0, 80);
  if (!periodKey) throw new Error("Укажите период предложений.");
  const route = snapshotRoute(ship);
  const level = attentionLevel(ship, route.directionKey);
  const offers = Array.from({ length: 4 }, (_, index) => {
    const kind = offerKind(index, level, random);
    const rewardCopper = offerReward(route.baseRewardCopper, kind, level, random);
    const routePlan = deepFreeze({
      destination: route.destination, directionKey: route.directionKey, distanceKm: route.distanceKm,
      portDays: route.portDays, preparationCopper: route.preparationCopper,
      upkeepPerDayCopper: route.upkeepPerDayCopper, rewardCopper
    });
    const offer = {
      id: `${ship.id}:${encodeURIComponent(periodKey)}:${index + 1}:${kind}`,
      shipId: ship.id, period: periodKey, kind,
      title: `${KIND_LABELS[kind]} — ${TITLE_VARIANTS[kind][index]}: ${route.destination}`,
      directionKey: route.directionKey, destination: route.destination,
      routePlan, rewardCopper, speedKmPerDay: route.speedKmPerDay, durationQd: route.durationQd,
      attention: { level, label: attentionLabel(level) },
      guidance: { preparationCopper: route.preparationCopper, operatingCopper: route.operatingCopper }
    };
    offer.guidance = { ...offer.guidance, ...contractGuidance(offer, "normal") };
    return deepFreeze(offer);
  });
  return deepFreeze(offers);
}

function commercialResult(kind, total) {
  if (!KINDS.has(kind)) throw new Error("Неизвестный вид контракта.");
  if (kind === "freight") {
    if (total <= 4) return { label: "Часть товара испорчена", rewardPercent: 45, expensePercent: 20, attentionDelta: 0 };
    if (total <= 8) return { label: "Груз доставлен", rewardPercent: 100, expensePercent: 0, attentionDelta: 0 };
    if (total <= 11) return { label: "Премия за бережную доставку", rewardPercent: 115, expensePercent: 0, attentionDelta: 0 };
    return { label: "Премия за срочное исполнение", rewardPercent: 130, expensePercent: 0, attentionDelta: 1 };
  }
  if (kind === "commission") {
    if (total <= 3) return { label: "Поручение сорвано", rewardPercent: 0, expensePercent: 35, attentionDelta: 1 };
    if (total <= 6) return { label: "Частичное выполнение", rewardPercent: 55, expensePercent: 10, attentionDelta: 0 };
    if (total <= 9) return { label: "Поручение выполнено", rewardPercent: 100, expensePercent: 0, attentionDelta: 0 };
    if (total <= 11) return { label: "Заказчик впечатлён", rewardPercent: 135, expensePercent: 0, attentionDelta: 1 };
    return { label: "Безупречное выполнение", rewardPercent: 160, expensePercent: 0, attentionDelta: 1 };
  }
  if (total <= 4) return { label: "Сделка провалена", rewardPercent: 0, expensePercent: 50, attentionDelta: 2 };
  if (total <= 6) return { label: "Получена лишь часть платы", rewardPercent: 40, expensePercent: 25, attentionDelta: 1 };
  if (total <= 8) return { label: "Товар передан", rewardPercent: 100, expensePercent: 0, attentionDelta: 1 };
  if (total <= 10) return { label: "Покупатели спорят за груз", rewardPercent: 140, expensePercent: 0, attentionDelta: 2 };
  return { label: "Контрабандный куш", rewardPercent: 190, expensePercent: 0, attentionDelta: 3 };
}

function incidentForKind(incident, kind) {
  if (incident.id !== "cargo-seized" || kind === "smuggling") return incident;
  if (kind === "freight") return { ...incident, id: "shipment-rejected", label: "Получатель отказался принять партию" };
  return { ...incident, id: "commission-cancelled", label: "Заказчик отменил поручение" };
}

/** Resolve supplied dice only. Callers on the authority GM draw the dice before invoking this function. */
export function resolveContractOutcome(contract, style = "normal", { commercialDice, incidentRoll, commercialOnly = false, sharedPassageAllowsBonus = true } = {}) {
  if (!contract || !KINDS.has(contract.kind)) throw new Error("Некорректный контракт.");
  if (!STYLES.has(style)) throw new Error("Неизвестный стиль выполнения контракта.");
  if (!Array.isArray(commercialDice) || commercialDice.length !== 2) throw new Error("Нужны два коммерческих кубика.");
  const dice = commercialDice.map((value, index) => integer(value, `коммерческий кубик ${index + 1}`, 1, 6));
  integer(incidentRoll, "бросок происшествия", 1, 12);
  const attention = integer(contract?.attention?.level ?? 0, "внимание", 0, 10);
  const rule = STYLE_RULES[style];
  const commercial = commercialResult(contract.kind, dice[0] + dice[1]);
  const incidentPenalty = Math.floor(attention / 5) + (contract.kind === "smuggling" ? 1 : 0);
  const effectiveIncidentRoll = Math.max(1, Math.min(12, incidentRoll + rule.incidentShift - incidentPenalty));
  const incident = commercialOnly
    ? { id: "shared-passage", label: "Общее происшествие учтено у судна", expensePercent: 0, delayQd: 0, rewardFactorPercent: 100, bonusPercent: 0, attentionDelta: 0 }
    : incidentForKind(INCIDENTS[effectiveIncidentRoll - 1], contract.kind);
  const baseReward = integer(contract.rewardCopper, "награда контракта");
  const baseCost = moneyAdd(
    integer(contract?.guidance?.preparationCopper ?? contract?.routePlan?.preparationCopper ?? 0, "подготовка"),
    integer(contract?.guidance?.operatingCopper ?? 0, "расходы рейса"),
    "базовые расходы"
  );
  const commercialReward = moneyPercent(baseReward, commercial.rewardPercent, "коммерческий результат");
  const incidentAdjustedReward = moneyPercent(commercialReward, incident.rewardFactorPercent, "награда после происшествия");
  const incidentReward = moneyPercent(baseReward, incident.bonusPercent, "премия происшествия");
  const styleBonus = commercial.rewardPercent >= 100 && incident.rewardFactorPercent >= 100 && incident.delayQd === 0 && sharedPassageAllowsBonus
    ? moneyPercent(baseReward, rule.successBonusPercent, "премия за быстрое исполнение") : 0;
  const commercialExpense = moneyPercent(baseCost, commercial.expensePercent, "расход коммерческого результата");
  const incidentExpense = moneyPercent(baseCost, incident.expensePercent, "расход происшествия");
  const severeExpense = incident.expensePercent >= 25 ? moneyPercent(baseCost, rule.severeExpensePercent, "расход рискованного хода") : 0;
  const precautionExpense = moneyPercent(baseCost, rule.extraExpensePercent, "расход на осторожность");
  const upkeepPerDay = integer(contract?.routePlan?.upkeepPerDayCopper ?? 0, "содержание");
  const delayUpkeep = integer(Math.ceil(upkeepPerDay * incident.delayQd / 4), "содержание во время задержки");
  const expenseCopper = moneyAdd(moneyAdd(moneyAdd(moneyAdd(commercialExpense, incidentExpense, "расходы исхода"), delayUpkeep, "расходы исхода"), precautionExpense, "расходы исхода"), severeExpense, "расходы исхода");
  return {
    rewardCopper: moneyAdd(moneyAdd(incidentAdjustedReward, incidentReward, "награда исхода"), styleBonus, "награда исхода"),
    expenseCopper, delayQd: incident.delayQd,
    attentionDelta: Math.max(-4, Math.min(4, commercial.attentionDelta + incident.attentionDelta + (style === "cautious" ? -1 : style === "bold" ? 1 : 0))),
    commercialLabel: commercial.label,
    eventId: incident.id, eventLabel: incident.label,
    commercialDice: dice, incidentRoll, effectiveIncidentRoll
  };
}
