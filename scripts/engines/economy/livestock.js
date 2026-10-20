const MAX_HEADS = 100_000;
const MAX_YOUNG_COHORTS = 12;

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function whole(value, fallback = 0, max = MAX_HEADS) {
  return Math.min(max, Math.max(0, Math.floor(finite(value, fallback))));
}

function text(value = "") {
  return String(value ?? "").trim();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeCohorts(rows = []) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      id: text(row?.id || `young-${index + 1}`),
      qty: whole(row?.qty),
      ageQd: whole(row?.ageQd, 0, Number.MAX_SAFE_INTEGER),
      bornSeasonKey: text(row?.bornSeasonKey)
    }))
    .filter((row) => row.id && row.qty > 0)
    .sort((left, right) => left.ageQd - right.ageQd || left.id.localeCompare(right.id, "ru"));
  while (normalized.length > MAX_YOUNG_COHORTS) {
    let bestIndex = 0;
    let bestDifference = Number.POSITIVE_INFINITY;
    for (let index = 0; index < normalized.length - 1; index += 1) {
      const difference = Math.abs(normalized[index + 1].ageQd - normalized[index].ageQd);
      if (difference < bestDifference) {
        bestDifference = difference;
        bestIndex = index;
      }
    }
    const left = normalized[bestIndex];
    const right = normalized[bestIndex + 1];
    normalized.splice(bestIndex, 2, {
      id: `${left.id}+${right.id}`.slice(0, 200),
      qty: left.qty + right.qty,
      ageQd: Math.max(left.ageQd, right.ageQd),
      bornSeasonKey: left.bornSeasonKey || right.bornSeasonKey
    });
  }
  return normalized;
}

export function livestockStateSignature(state = {}) {
  return JSON.stringify({
    speciesId: state.speciesId,
    capacity: state.capacity,
    adults: state.adults,
    breedingMales: state.breedingMales,
    young: state.young,
    woolReady: state.woolReady,
    lastBirthSeasonKey: state.lastBirthSeasonKey,
    lastWoolSeasonKey: state.lastWoolSeasonKey,
    productionRemainders: state.productionRemainders,
    shortagePeriods: state.shortagePeriods,
    shortageQd: state.shortageQd,
    feedCreditNumerator: state.feedCreditNumerator
  });
}

export function normalizeLivestockState(value = {}, profile = {}) {
  const capacity = Math.max(1, whole(value.capacity ?? profile.capacity, 12));
  const adults = Math.min(capacity, whole(value.adults ?? value.qty));
  const breedingMales = Math.min(adults, whole(value.breedingMales ?? value.breedingMaleCount));
  const roomForYoung = Math.max(0, capacity - adults);
  let young = normalizeCohorts(value.young ?? value.youngCohorts);
  let acceptedYoung = 0;
  young = young.map((row) => {
    const qty = Math.min(row.qty, Math.max(0, roomForYoung - acceptedYoung));
    acceptedYoung += qty;
    return { ...row, qty };
  }).filter((row) => row.qty > 0);
  return {
    version: 1,
    speciesId: text(value.speciesId ?? profile.speciesId),
    capacity,
    adults,
    breedingMales,
    young,
    woolReady: Math.min(adults, whole(value.woolReady)),
    lastBirthSeasonKey: text(value.lastBirthSeasonKey),
    lastWoolSeasonKey: text(value.lastWoolSeasonKey),
    productionRemainders: { eggs: Math.min(9999, whole(value.productionRemainders?.eggs)), milk: Math.min(9999, whole(value.productionRemainders?.milk)) },
    shortagePeriods: whole(value.shortagePeriods),
    shortageQd: whole(value.shortageQd, whole(value.shortagePeriods) * 40),
    feedCreditNumerator: whole(value.feedCreditNumerator)
  };
}

export function livestockHeadcount(state = {}) {
  const normalized = normalizeLivestockState(state, state);
  return normalized.adults + normalized.young.reduce((sum, row) => sum + row.qty, 0);
}

function normalizedProfile(profile = {}, state = {}) {
  return {
    speciesId: text(profile.speciesId ?? state.speciesId),
    capacity: Math.max(1, whole(profile.capacity ?? state.capacity, 12)),
    grazingSeasons: new Set((Array.isArray(profile.grazingSeasons) ? profile.grazingSeasons : []).map((row) => text(row)).filter(Boolean)),
    breedingSeasonId: text(profile.breedingSeasonId),
    shearingSeasonId: text(profile.shearingSeasonId),
    maturityQd: Math.max(1, whole(profile.maturityQd, 120, Number.MAX_SAFE_INTEGER)),
    feedResourceId: text(profile.feedResourceId || "animal-feed"),
    headsPerFeedUnit: Math.max(1, whole(profile.headsPerFeedUnit, 1)),
    feedUnitsPerHead: Math.max(1, whole(profile.feedUnitsPerHead, 1)),
    offspringNumerator: whole(profile.offspringNumerator, 1),
    offspringDenominator: Math.max(1, whole(profile.offspringDenominator, 2)),
    careWorkQdPerDay: Math.max(1, whole(profile.careWorkQdPerDay, 1)),
    eggResourceId: text(profile.eggResourceId || "eggs"),
    eggPerFullFlockDay: whole(profile.eggPerFullFlockDay, 0),
    milkResourceId: text(profile.milkResourceId || "milk"),
    milkPerHeadDay: whole(profile.milkPerHeadDay, 1),
    milkPerFullFlockDay: whole(profile.milkPerFullFlockDay, 0),
    milkWorkQdPerHeadDay: Math.max(1, whole(profile.milkWorkQdPerHeadDay, 1)),
    milkBatchWorkQdPerDay: Math.max(1, whole(profile.milkBatchWorkQdPerDay, 1)),
    woolResourceId: text(profile.woolResourceId || "wool"),
    woolPerHead: whole(profile.woolPerHead, 1),
    shearWorkQdPerHead: Math.max(1, whole(profile.shearWorkQdPerHead, 1)),
    shearBatchWorkQd: Math.max(1, whole(profile.shearBatchWorkQd, 1)),
    meatResourceId: text(profile.meatResourceId || "meat"),
    meatPerAdult: whole(profile.meatPerAdult, 1),
    peltResourceId: text(profile.peltResourceId || "pelt"),
    peltPerAdult: whole(profile.peltPerAdult, 0),
    tallowResourceId: text(profile.tallowResourceId || "tallow"),
    tallowPerAdult: whole(profile.tallowPerAdult, 0),
    slaughterWorkQdPerHead: Math.max(1, whole(profile.slaughterWorkQdPerHead, 1)),
    producesEggs: profile.producesEggs === true,
    producesMilk: profile.producesMilk === true,
    producesWool: profile.producesWool === true
  };
}

function carePlan(elapsedQd, availableWorkQd, profile) {
  const days = Math.floor(whole(elapsedQd, 0, Number.MAX_SAFE_INTEGER) / 4);
  const perDay = Math.max(1, profile.careWorkQdPerDay);
  const caredDays = Math.min(days, Math.floor(whole(availableWorkQd, 0, Number.MAX_SAFE_INTEGER) / perDay));
  return {
    days,
    caredDays,
    missedDays: Math.max(0, days - caredDays),
    workQd: caredDays * perDay,
    requiredWorkQd: days * perDay
  };
}

function matureYoung(state, elapsedQd, maturityQd) {
  let matured = 0;
  const young = [];
  for (const cohort of state.young) {
    const aged = { ...cohort, ageQd: cohort.ageQd + elapsedQd };
    if (aged.ageQd >= maturityQd) matured += aged.qty;
    else young.push(aged);
  }
  state.young = young;
  state.adults = Math.min(state.capacity, state.adults + matured);
  return matured;
}

function feedingPlan(state, profile, seasonId, availableFeedUnits, feedPriority = "adults", elapsedQd = 40) {
  const youngHeads = state.young.reduce((sum, row) => sum + row.qty, 0);
  const grazing = profile.grazingSeasons.has(text(seasonId));
  if (grazing || elapsedQd <= 0) return { grazing, feedCreditAfter: state.feedCreditNumerator, feedRequired: 0, feedConsumed: 0, fedAdults: state.adults, fedYoung: youngHeads, unfedAdults: 0, unfedYoung: 0 };
  const scale = 40 * profile.headsPerFeedUnit;
  const demandPerHead = elapsedQd * profile.feedUnitsPerHead;
  const credit = whole(state.feedCreditNumerator);
  const capacity = Math.floor((whole(availableFeedUnits) * scale + credit) / demandPerHead);
  let fedAdults = 0;
  let fedYoung = 0;
  if (feedPriority === "young") {
    fedYoung = Math.min(youngHeads, capacity);
    fedAdults = Math.min(state.adults, Math.max(0, capacity - fedYoung));
  } else {
    fedAdults = Math.min(state.adults, capacity);
    fedYoung = Math.min(youngHeads, Math.max(0, capacity - fedAdults));
  }
  const fedHeads = fedAdults + fedYoung;
  const feedConsumed = Math.max(0, Math.ceil((fedHeads * demandPerHead - credit) / scale));
  return {
    grazing: false,
    feedRequired: Math.max(0, Math.ceil(((state.adults + youngHeads) * demandPerHead - credit) / scale)),
    feedConsumed,
    feedCreditAfter: credit + feedConsumed * scale - fedHeads * demandPerHead,
    fedAdults,
    fedYoung,
    unfedAdults: state.adults - fedAdults,
    unfedYoung: youngHeads - fedYoung
  };
}

function seasonalBirths(state, profile, feeding, seasonId, seasonKey) {
  if (!profile.breedingSeasonId || text(seasonId) !== profile.breedingSeasonId) return 0;
  if (!text(seasonKey) || state.lastBirthSeasonKey === text(seasonKey)) return 0;
  if (state.breedingMales < 1 || feeding.fedAdults < 2) return 0;
  const fedBreedingMales = Math.min(state.breedingMales, feeding.fedAdults);
  if (!fedBreedingMales) return 0;
  const fedFemales = Math.max(0, feeding.fedAdults - fedBreedingMales);
  const requested = Math.floor((fedFemales * profile.offspringNumerator) / profile.offspringDenominator);
  const born = Math.min(requested, Math.max(0, state.capacity - livestockHeadcount(state)));
  if (born > 0) {
    state.lastBirthSeasonKey = text(seasonKey);
    state.young = normalizeCohorts([...state.young, { id: `young-${text(seasonKey)}`, qty: born, ageQd: 0, bornSeasonKey: text(seasonKey) }]);
  }
  return born;
}

function wholeProduction(state, key, quantity) {
  const units = Math.round(Math.max(0, quantity) * 10000) + (state.productionRemainders[key] || 0);
  state.productionRemainders[key] = units % 10000;
  return Math.floor(units / 10000);
}

function eggPlan(state, profile, feeding, caredDays, enabled) {
  if (!enabled || !profile.producesEggs || profile.eggPerFullFlockDay <= 0 || caredDays <= 0) {
    return { adultDays: 0, outputQty: 0 };
  }
  const layingAdults = Math.max(0, feeding.fedAdults);
  const output = layingAdults * profile.eggPerFullFlockDay * caredDays / Math.max(1, profile.capacity);
  return { adultDays: layingAdults * caredDays, outputQty: wholeProduction(state, "eggs", output) };
}

function milkPlan(state, profile, feeding, caredDays, enabled) {
  if (!enabled || !profile.producesMilk || (profile.milkPerHeadDay <= 0 && profile.milkPerFullFlockDay <= 0)) return { headDays: 0, workQd: 0, outputQty: 0 };
  const fedMales = Math.min(state.breedingMales, feeding.fedAdults);
  const milkableAdults = Math.max(0, feeding.fedAdults - fedMales);
  const headDays = milkableAdults * caredDays;
  const outputPerDay = profile.milkPerFullFlockDay > 0
    ? milkableAdults * profile.milkPerFullFlockDay / Math.max(1, profile.capacity - 1)
    : milkableAdults * profile.milkPerHeadDay;
  return {
    headDays,
    workQd: 0,
    outputQty: wholeProduction(state, "milk", outputPerDay * caredDays)
  };
}

function woolPlan(state, profile, feeding, seasonId, seasonKey, requestedQty, availableWorkQd) {
  if (!profile.producesWool) return { readyBefore: 0, shearedHeads: 0, workQd: 0, outputQty: 0 };
  const activeSeasonKey = text(seasonKey);
  if (
    profile.shearingSeasonId
    && text(seasonId) === profile.shearingSeasonId
    && activeSeasonKey
    && state.lastWoolSeasonKey !== activeSeasonKey
  ) {
    state.lastWoolSeasonKey = activeSeasonKey;
    state.woolReady = Math.max(state.woolReady, Math.min(state.adults, feeding.fedAdults));
  }
  const readyBefore = state.woolReady;
  const canShear = availableWorkQd >= profile.shearBatchWorkQd;
  const shearedHeads = canShear ? Math.min(whole(requestedQty), readyBefore) : 0;
  state.woolReady -= shearedHeads;
  return {
    readyBefore,
    shearedHeads,
    workQd: shearedHeads > 0 ? profile.shearBatchWorkQd : 0,
    outputQty: shearedHeads * profile.woolPerHead
  };
}

function slaughterPlan(state, profile, requestedQty, requestedBreedingMales = 0, availableWorkQd = 0) {
  const requested = Math.min(whole(requestedQty), state.adults);
  const qty = Math.min(requested, Math.floor(whole(availableWorkQd, 0, Number.MAX_SAFE_INTEGER) / profile.slaughterWorkQdPerHead));
  const nonMales = Math.max(0, state.adults - state.breedingMales);
  const breedingMales = Math.min(state.breedingMales, whole(requestedBreedingMales), Math.max(0, qty - Math.min(qty, nonMales)));
  const nonBreeding = Math.min(nonMales, qty - breedingMales);
  const appliedQty = nonBreeding + breedingMales;
  const warnings = [];
  if (qty < requested) warnings.push(`На забой выделено труда только для ${qty} из ${requested} голов.`);
  if (qty > appliedQty) warnings.push("Для забоя племенных самцов укажи их количество явно.");
  if (breedingMales > 0 && state.breedingMales - breedingMales < 1 && state.adults - appliedQty > 1) warnings.push("Забой удалит последнего племенного самца этого стада.");
  state.adults -= appliedQty;
  state.breedingMales -= breedingMales;
  state.woolReady = Math.min(state.woolReady, state.adults);
  return {
    requestedQty: requested,
    appliedQty,
    breedingMales,
    workQd: appliedQty * profile.slaughterWorkQdPerHead,
    outputQty: appliedQty * profile.meatPerAdult,
    warnings
  };
}

export function planLivestockTenday({
  state: sourceState = {},
  profile: sourceProfile = {},
  elapsedQd = 40,
  seasonId = "",
  seasonKey = "",
  availableFeedUnits = 0,
  availableWorkQd = 0,
  feedPriority = "adults",
  operations = {},
  operationId = ""
} = {}) {
  const stateBefore = normalizeLivestockState(sourceState, sourceProfile);
  const state = clone(stateBefore);
  const profile = normalizedProfile(sourceProfile, state);
  state.capacity = profile.capacity;
  const qd = whole(elapsedQd, 40, Number.MAX_SAFE_INTEGER);
  const feedingBeforeGrowth = feedingPlan(state, profile, seasonId, availableFeedUnits, feedPriority, qd);
  const matured = feedingBeforeGrowth.unfedYoung === 0 ? matureYoung(state, qd, profile.maturityQd) : 0;
  const feeding = feedingPlan(state, profile, seasonId, availableFeedUnits, feedPriority, qd);
  state.feedCreditNumerator = feeding.feedCreditAfter;
  let workRemaining = whole(availableWorkQd, 0, Number.MAX_SAFE_INTEGER);
  const care = carePlan(qd, workRemaining, profile);
  workRemaining -= care.workQd;
  const careRatio = care.days > 0 ? care.caredDays / care.days : 1;
  const caredFeeding = {
    ...feeding,
    fedAdults: Math.floor(feeding.fedAdults * careRatio),
    fedYoung: Math.floor(feeding.fedYoung * careRatio)
  };
  const born = seasonalBirths(state, profile, caredFeeding, seasonId, seasonKey);
  const eggs = eggPlan(state, profile, feeding, care.caredDays, operations.eggs === true);
  const milk = milkPlan(state, profile, feeding, care.caredDays, operations.milk === true);
  const wool = woolPlan(state, profile, caredFeeding, seasonId, seasonKey, operations.shearQty, workRemaining);
  workRemaining -= wool.workQd;
  const slaughter = slaughterPlan(state, profile, operations.slaughterQty, operations.slaughterBreedingMales, workRemaining);
  workRemaining -= slaughter.workQd;
  const resourceChanges = [];
  if (feeding.feedConsumed > 0) resourceChanges.push({ resourceId: profile.feedResourceId, qty: -feeding.feedConsumed, reason: "livestock-feed" });
  if (eggs.outputQty > 0) resourceChanges.push({ resourceId: profile.eggResourceId, qty: eggs.outputQty, reason: "livestock-eggs" });
  if (milk.outputQty > 0) resourceChanges.push({ resourceId: profile.milkResourceId, qty: milk.outputQty, reason: "livestock-milk" });
  if (wool.outputQty > 0) resourceChanges.push({ resourceId: profile.woolResourceId, qty: wool.outputQty, reason: "livestock-wool" });
  if (slaughter.outputQty > 0) resourceChanges.push({ resourceId: profile.meatResourceId, qty: slaughter.outputQty, reason: "livestock-slaughter" });
  if (slaughter.appliedQty > 0 && profile.peltPerAdult > 0) resourceChanges.push({ resourceId: profile.peltResourceId, qty: slaughter.appliedQty * profile.peltPerAdult, reason: "livestock-slaughter-pelt" });
  if (slaughter.appliedQty > 0 && profile.tallowPerAdult > 0) resourceChanges.push({ resourceId: profile.tallowResourceId, qty: slaughter.appliedQty * profile.tallowPerAdult, reason: "livestock-slaughter-tallow" });
  const warnings = [...slaughter.warnings];
  const shortage = feeding.unfedAdults + feeding.unfedYoung > 0 || care.missedDays > 0;
  state.shortageQd = shortage ? state.shortageQd + qd : 0;
  state.shortagePeriods = Math.floor(state.shortageQd / 40);
  if (state.shortagePeriods >= 2) warnings.push("Повторный недостаток корма или ухода: требуется решение ведущего о состоянии стада. Автоматического падежа нет.");
  if (care.missedDays > 0) warnings.push(`Не хватило ухода на ${care.missedDays} из ${care.days} дней; регулярный выпуск и приплод уменьшены.`);
  const requestedShearing = whole(operations.shearQty);
  if (requestedShearing > wool.shearedHeads) warnings.push(`Удалось остричь ${wool.shearedHeads} из ${requestedShearing} запрошенных голов.`);
  if (feeding.unfedAdults + feeding.unfedYoung > 0) warnings.push(`Не накормлено голов: ${feeding.unfedAdults + feeding.unfedYoung}; они не производят и не участвуют в приплоде.`);
  return {
    version: 1,
    operationId: text(operationId),
    stateBefore,
    stateBeforeSignature: livestockStateSignature(stateBefore),
    stateAfter: normalizeLivestockState(state, profile),
    elapsedQd: qd,
    seasonId: text(seasonId),
    seasonKey: text(seasonKey),
    matured,
    born,
    feeding,
    care,
    eggs,
    milk,
    wool,
    slaughter,
    workQdUsed: care.workQd + wool.workQd + slaughter.workQd,
    workQdRemaining: workRemaining,
    resourceChanges,
    warnings
  };
}

function requireApplyDependencies(dependencies = {}) {
  for (const name of ["resourceQuantity", "consumeResource", "addResource", "setState"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Livestock requires dependency "${name}".`);
  }
  return dependencies;
}

export function applyLivestockPlan({ currentState = {}, plan, profile = {}, dependencies = {} } = {}) {
  const deps = requireApplyDependencies(dependencies);
  if (!plan || typeof plan !== "object") return { ok: false, message: "План поголовья отсутствует." };
  const normalizedCurrent = normalizeLivestockState(currentState, profile);
  if (livestockStateSignature(normalizedCurrent) !== text(plan.stateBeforeSignature)) return { ok: false, stale: true, message: "Поголовье изменилось после Preview." };
  const consumptions = (plan.resourceChanges ?? []).filter((row) => whole(-row.qty) > 0);
  for (const row of consumptions) {
    if (whole(deps.resourceQuantity(row.resourceId)) < whole(-row.qty)) return { ok: false, stale: true, message: `Не хватает ресурса ${row.resourceId} после Preview.` };
  }
  for (const row of consumptions) deps.consumeResource(row.resourceId, whole(-row.qty), row.reason);
  for (const row of plan.resourceChanges ?? []) {
    if (whole(row.qty) > 0) deps.addResource(row.resourceId, whole(row.qty), row.reason);
  }
  deps.setState(clone(plan.stateAfter));
  return { ok: true, state: clone(plan.stateAfter), resourceChanges: clone(plan.resourceChanges), warnings: [...(plan.warnings ?? [])] };
}
