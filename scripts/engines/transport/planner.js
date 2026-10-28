import { cargoLoad, cargoValue, takeTransportCargo, transportInteger, transportMoney, transportRateCharge, transportOperatingCharge, transportWaitingCharge, TRANSPORT_LIMITS, TRANSPORT_LOAD_SCALE } from "./quantities.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const slotId = (service, departure, vehicle = "regular") => `${service.id}:${vehicle}:${departure}`;
const occupied = (run) => run.status !== "cancelled";

function validateEmptyPath(service, kind) {
  if (service[`${kind}Available`] === false || (service[`${kind}AccessCost`] ?? 0) > (service.emptyAccessLimit ?? Infinity)) {
    throw new Error("Пустой перегон собственного корабля недоступен по маршруту или УРС.");
  }
}

function checkService(service) {
  if (!service?.id || !service.from || !service.to || service.from === service.to) throw new Error("Не заданы разные пункты перевозки.");
  if (!["regular", "charter", "owned"].includes(service.kind)) throw new Error("Неизвестный вид перевозки.");
  for (const field of ["capacity", "travelQd"]) transportInteger(service[field], field, 1);
  for (const field of ["loadingQd", "unloadingQd", "returnQd", "firstQd", "dispatchCopper", "loadCopper", "operatingCopperPerQd", "handlingCopper", "storageCopperPerLoadQd"]) {
    transportInteger(service[field] ?? 0, field);
  }
  if (service.kind === "regular") transportInteger(service.intervalQd, "интервал отправлений", 1);
  else transportInteger(service.vehicles ?? 1, "число машин", 1, 1000);
  if (service.kind === "owned" && !service.shipId) throw new Error("Не выбран собственный корабль.");
  transportInteger(service.riskBps ?? 0, "вероятность происшествия", 0, 10000);
}

function regularSlot(service, readyQd, runs, horizon) {
  let departure = Math.max(service.firstQd ?? 0, readyQd + (service.loadingQd ?? 0));
  departure = (service.firstQd ?? 0) + Math.ceil((departure - (service.firstQd ?? 0)) / service.intervalQd) * service.intervalQd;
  for (; departure <= horizon; departure += service.intervalQd) {
    const id = slotId(service, departure);
    const existing = runs.find((run) => run.id === id && occupied(run));
    if (existing?.blocked || existing?.incident) continue;
    const free = Math.min(service.capacity, existing?.capacity ?? service.capacity) - (existing?.reservedLoad ?? 0);
    if (free > 0) return { id, departureQd: departure, free, vehicle: "regular", existing };
  }
  return null;
}

function charterSlot(service, readyQd, runs, horizon, durationQd) {
  const candidates = [];
  for (let vehicle = 0; vehicle < (service.vehicles ?? 1); vehicle++) {
    let start = Math.max(readyQd, service.firstQd ?? 0);
    const commitments = runs.filter((run) => occupied(run) && (service.kind === "owned"
      ? run.shipId === service.shipId : run.serviceId === service.id && run.vehicle === vehicle))
      .sort((a, b) => a.startQd - b.startQd);
    for (const run of commitments) {
      if (start + durationQd <= run.startQd) break;
      if (start < run.releaseQd) start = run.releaseQd;
    }
    if (start + durationQd <= horizon) candidates.push({ id: slotId(service, start, vehicle), startQd: start,
      departureQd: start + (service.loadingQd ?? 0), free: service.capacity, vehicle });
  }
  return candidates.sort((a, b) => a.startQd - b.startQd || a.vehicle - b.vehicle)[0] ?? null;
}

function runCharge(service, load, occupiedQd, returnQd = 0) {
  const dispatchCopper = service.dispatchCopper ?? 0;
  const loadCopper = transportRateCharge(load, service.loadMilliCopper ?? (service.loadCopper ?? 0) * 1000, TRANSPORT_LOAD_SCALE * 1000);
  const operatingCopper = service.kind === "regular" ? 0 : transportOperatingCharge(service, occupiedQd - returnQd)
    + transportOperatingCharge(service, returnQd, true);
  const handlingCopper = (service.handlingFlatCopper ?? 0)
    + transportRateCharge(load, service.handlingMilliCopper ?? (service.handlingCopper ?? 0) * 1000, TRANSPORT_LOAD_SCALE * 1000);
  const gross = transportMoney([dispatchCopper, loadCopper, operatingCopper, handlingCopper]);
  const discountBps = transportInteger(service.discountBps ?? 0, "скидка", 0, 10000);
  const discountCopper = Math.floor((dispatchCopper + loadCopper) * discountBps / 10000);
  return { dispatchCopper, loadCopper, operatingCopper, handlingCopper, discountCopper, totalCopper: gross - discountCopper };
}

/** A candidate uses one location chain; each stage packs independently. No bottleneck-sized full-route multiplication. */
export function planTransportChain({ cargo, services, startQd = 0, runs = [], horizonQd = TRANSPORT_LIMITS.horizonQd, storageRate = 0 }) {
  transportInteger(startQd, "дата");
  if (!cargo?.length || !services?.length || services.length > TRANSPORT_LIMITS.stages) throw new Error("Не задан груз или маршрут слишком длинный.");
  cargoLoad(cargo); cargoValue(cargo);
  const lots = new Set();
  for (const lot of cargo) {
    if (!lot.lotId || lots.has(lot.lotId)) throw new Error("Партии должны иметь уникальное происхождение.");
    lots.add(lot.lotId);
  }
  const workingRuns = copy(runs), stages = [];
  const horizon = startQd + transportInteger(horizonQd, "горизонт", 1, 100000);
  let readyQd = startQd, previous = null, ownedEnded = false, ownedId = "";
  for (const [index, service] of services.entries()) {
    checkService(service);
    if (previous && previous.to !== service.from) throw new Error("Разрыв транспортной цепочки.");
    if (service.kind === "owned") {
      if (ownedEnded || (ownedId && ownedId !== service.shipId)) throw new Error("Свой корабль может занимать только одну непрерывную часть маршрута.");
      ownedId = service.shipId;
    } else if (ownedId) ownedEnded = true;
    let waiting = copy(cargo), stageRuns = [], storageCopper = 0;
    if (service.kind === "owned" && previous?.kind !== "owned") {
      validateEmptyPath(service, "approach");
      readyQd = Math.max(readyQd, startQd + (service.approachQd ?? 0));
    }
    while (waiting.length) {
      if (stages.reduce((sum, stage) => sum + stage.runs.length, 0) + stageRuns.length >= TRANSPORT_LIMITS.runs) throw new Error("Слишком много отправлений. Уменьшите заказ.");
      if (waiting.some((lot) => lot.unitLoad > service.capacity)) throw new Error("Одна единица товара больше вместимости транспорта.");
      const full = takeTransportCargo(waiting, service.capacity);
      const fullLoad = cargoLoad(full.taken);
      const timed = service.kind === "owned" ? { ...service,
        loadingQd: service.loadingCapacity ? Math.ceil(fullLoad / service.loadingCapacity) : service.loadingQd ?? 0,
        unloadingQd: service.unloadingCapacity ? Math.ceil(fullLoad / service.unloadingCapacity) : service.unloadingQd ?? 0 } : service;
      const last = full.remaining.length === 0;
      // Charter machines return to their published hub; owned ship returns between shuttles or by explicit final choice.
      const finalOwnReturn = service.kind === "owned" && last && service.returnAtEnd && services[index + 1]?.kind !== "owned";
      if (service.kind === "owned" && (finalOwnReturn || !last)) validateEmptyPath(service, finalOwnReturn ? "endReturn" : "return");
      const returnQd = service.kind === "regular" ? 0 : finalOwnReturn ? service.endReturnQd ?? service.returnQd ?? 0
        : (service.kind === "charter" || !last ? service.returnQd ?? 0 : 0);
      const baseQd = (timed.loadingQd ?? 0) + service.travelQd + (timed.unloadingQd ?? 0);
      const slot = service.kind === "regular" ? regularSlot(service, readyQd, workingRuns, horizon)
        : charterSlot(timed, readyQd, workingRuns, horizon, baseQd + returnQd);
      if (!slot) throw new Error("Нет свободного транспорта в горизонте планирования.");
      const packed = takeTransportCargo(waiting, slot.free);
      if (!packed.taken.length) {
        // A partly occupied scheduled vehicle cannot hold an indivisible unit; skip it in this search only.
        const existing = workingRuns.find((run) => run.id === slot.id);
        if (existing) existing.blocked = true;
        else throw new Error("Груз не помещается в транспорт.");
        continue;
      }
      const load = cargoLoad(packed.taken);
      const arrivalQd = slot.existing?.arrivalQd ?? slot.departureQd + service.travelQd + (timed.unloadingQd ?? 0);
      if (arrivalQd > horizon) throw new Error("Доставка выходит за горизонт планирования.");
      const start = slot.startQd ?? slot.departureQd - (timed.loadingQd ?? 0);
      const charge = runCharge(service, load, arrivalQd + returnQd - start, returnQd);
      storageCopper += transportRateCharge(load * Math.max(0, start - readyQd),
        service.storageMilliCopperPerLoadQd ?? (service.storageCopperPerLoadQd ?? storageRate) * 1000, TRANSPORT_LOAD_SCALE * 1000);
      const run = { id: slot.id, serviceId: service.id, serviceLabel: service.label || service.id, kind: service.kind,
        shipId: service.shipId ?? "", vehicle: slot.vehicle, from: service.from, to: service.to,
        startQd: start, departureQd: slot.departureQd, arrivalQd, releaseQd: arrivalQd + returnQd,
        releaseLocation: finalOwnReturn ? service.endReturnLocation ?? service.from : returnQd ? service.from : service.to, capacity: service.capacity, reservedLoad: load,
        cargo: packed.taken, charge, status: "booked", riskBps: service.riskBps ?? 0 };
      const shared = workingRuns.find((row) => row.id === run.id && occupied(row));
      if (shared) shared.reservedLoad += load;
      else workingRuns.push(copy(run));
      stageRuns.push(run);
      waiting = packed.remaining;
    }
    const completedQd = Math.max(...stageRuns.map((run) => run.arrivalQd));
    stages.push({ index, from: service.from, to: service.to, service: copy(service), readyQd, completedQd,
      storageCopper, runs: stageRuns, totalCopper: transportMoney([...stageRuns.map((run) => run.charge.totalCopper), storageCopper]) });
    readyQd = completedQd;
    previous = service;
  }
  const ownStages = stages.filter((stage) => stage.service.kind === "owned");
  const ownedRuns = ownStages.flatMap((stage) => stage.runs);
  const lastOwn = ownedRuns.at(-1);
  const firstOwned = ownStages[0];
  const waitingQd = firstOwned ? Math.max(0, firstOwned.runs[0].startQd - startQd - (firstOwned.service.approachQd ?? 0)) : 0;
  const waitingCopper = firstOwned ? transportWaitingCharge(firstOwned.service, waitingQd) : 0;
  const approachCopper = transportMoney([ownStages[0]?.service.approachCopper ?? 0, waitingCopper]);
  return { version: 2, startQd, cargo: copy(cargo), stages, ownShipId: ownedId, approachCopper,
    shipApproachCopper: firstOwned?.service.approachCopper ?? 0, shipWaitingCopper: waitingCopper,
    totalCopper: transportMoney([...stages.map((stage) => stage.totalCopper), approachCopper]),
    ownExpensesCopper: transportMoney([...ownStages.map((stage) => stage.totalCopper), approachCopper]),
    arrivalQd: readyQd, firstArrivalQd: Math.min(...stages.at(-1).runs.map((run) => run.arrivalQd)),
    shipReleaseQd: lastOwn?.releaseQd ?? null, shipReleaseLocation: lastOwn?.releaseLocation ?? "" };
}

export function transportChainMatchesConstraints(chain, { pins = {}, excluded = [] } = {}) {
  return Object.entries(pins).every(([from, id]) => chain.some(service => service.from === from && service.id === id))
    && chain.every(service => service.enabled !== false && !excluded.includes(service.id) && !excluded.includes(service.companyId));
}

export function findTransportPlans({ from, to, services = [], cargo, startQd = 0, runs = [], priority = "cost", pins = {}, excluded = [], ownShipId = "", maxPaths = TRANSPORT_LIMITS.paths, accessLimit = Infinity }) {
  const plans = [], failures = new Set();
  const candidates = [...services].sort((a, b) => Number(b.kind === "owned") - Number(a.kind === "owned")
    || Number(b.to === to) - Number(a.to === to) || String(a.id).localeCompare(String(b.id)));
  let searched = 0, limited = false, expanded = 0;
  function visit(location, chain, visited) {
    if (searched >= maxPaths || expanded++ >= maxPaths * TRANSPORT_LIMITS.stages) { limited = true; return; }
    if (location === to) {
      if (ownShipId && !chain.some((service) => service.shipId === ownShipId)) return;
      if (!transportChainMatchesConstraints(chain, { pins, excluded })) return;
      searched++;
      try { plans.push(planTransportChain({ cargo, services: chain, startQd, runs })); }
      catch (error) { failures.add(error.message); }
      return;
    }
    if (chain.length >= TRANSPORT_LIMITS.stages) return;
    const ownIndex = chain.findIndex((service) => service.kind === "owned");
    const ownEnded = ownIndex >= 0 && chain.at(-1).kind !== "owned";
    for (const service of candidates) {
      if (service.enabled === false || service.from !== location || visited.has(service.to)
        || chain.reduce((sum, row) => sum + (row.accessCost ?? 0), service.accessCost ?? 0) > accessLimit
        || excluded.includes(service.id) || excluded.includes(service.companyId)
        || (pins[location] && pins[location] !== service.id)
        || (service.kind === "owned" && (service.shipId !== ownShipId || ownEnded))) continue;
      visit(service.to, [...chain, service], new Set([...visited, service.to]));
      if (searched >= maxPaths) break;
    }
  }
  visit(from, [], new Set([from]));
  plans.sort((a, b) => (priority === "time" ? a.arrivalQd - b.arrivalQd : a.totalCopper - b.totalCopper)
    || (priority === "time" ? a.totalCopper - b.totalCopper : a.arrivalQd - b.arrivalQd)
    || a.stages.length - b.stages.length);
  return { plans: plans.slice(0, 5), searched, limited, failures: [...failures] };
}

/** Confirmation validates a submitted chain independently of the search heuristic. */
export function validateTransportPlan(plan, { services, runs = [], startQd = plan?.startQd, pins = {}, excluded = [] } = {}) {
  const selected = plan?.stages?.map((stage) => services.find((service) => service.id === stage.service.id));
  if (!selected?.length || selected.some((service) => !service)) throw new Error("Услуга перевозки больше недоступна.");
  if (!transportChainMatchesConstraints(selected, { pins, excluded })) throw new Error("Маршрут не соблюдает закрепления или исключения перевозчиков.");
  const fresh = planTransportChain({ cargo: plan.cargo, services: selected, startQd, runs });
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("Условия или свободные места изменились. Обновите расчёт.");
  return fresh;
}
