import { remainingCargoArrivals, availableTransportCargo, allArrivalCargo, cargoQuantitiesMatch } from "./cargo-flow.js";
import { transportServicesShareFleet } from "./service-identity.js";
import { transportServiceCharge } from "./economics.js";
import { cargoLoad, cargoValue, takeTransportCargo, transportInteger, transportMoney, transportOperatingCharge, transportRateCharge, transportWaitingCharge, TRANSPORT_LIMITS, TRANSPORT_LOAD_SCALE } from "./quantities.js";
import { transportEmptyQd, transportServiceAt } from "./seasonal.js";
import { TransportPlanningUnavailableError } from "./planning-error.js";
export { TransportPlanningUnavailableError } from "./planning-error.js";

const copy = (value) => JSON.parse(JSON.stringify(value));
const slotId = (service, departure, vehicle = "regular") => `${service.id}:${vehicle}:${departure}`;
const occupied = (run) => run.status !== "cancelled";
// Older direct services used the region for the holding end. The exact run ID
// has already matched before comparing these endpoints; its capacity remains shared.
const sameScheduledEndpoint = (left, right) => String(left).replace(/:holding$/, "") === String(right).replace(/:holding$/, "");

function validateEmptyPath(service, kind) {
  if (service[`${kind}Available`] === false || (service[`${kind}AccessCost`] ?? 0) > (service.emptyAccessLimit ?? Infinity)) {
    throw new Error("Пустой перегон собственного корабля недоступен по маршруту или УРС.");
  }
}

function checkService(service) {
  if (!service?.id || !service.from || !service.to || service.from === service.to) throw new Error("Не заданы разные пункты перевозки.");
  if (!["regular", "charter", "owned"].includes(service.kind)) throw new Error("Неизвестный вид перевозки.");
  transportInteger(service.capacity, "capacity", 1);
  transportInteger(service.travelQd, "travelQd", service.distanceKm === 0 ? 0 : 1);
  for (const field of ["loadingQd", "unloadingQd", "preparationQd", "returnQd", "firstQd", "dispatchCopper", "loadCopper", "operatingCopperPerQd", "handlingCopper", "storageCopperPerLoadQd"]) {
    transportInteger(service[field] ?? 0, field);
  }
  for (const field of ["loadingCapacity", "unloadingCapacity"]) if (service[field] !== undefined) transportInteger(service[field], field, 1);
  if (service.travelQd === 0 && !(service.loadingQd || service.unloadingQd)) throw new Error("Местная перевозка требует времени обработки груза.");
  if (service.kind === "regular") transportInteger(service.intervalQd, "интервал отправлений", 1);
  else transportInteger(service.vehicles ?? 1, "число машин", 1, TRANSPORT_LIMITS.vehicles);
  if (service.kind === "owned" && !service.shipId) throw new Error("Не выбран собственный корабль.");
  transportInteger(service.riskBps ?? 0, "вероятность происшествия", 0, 10000);
}

function handlingQd(load, capacity, fixedQd) {
  return capacity ? Math.max(1, Math.ceil(load / capacity)) : fixedQd ?? 0;
}

function regularSlot(service, readyQd, runs, horizon, cargo, load) {
  const loadingQd = handlingQd(load, service.loadingCapacity, service.loadingQd);
  const unloadingQd = handlingQd(load, service.unloadingCapacity, service.unloadingQd);
  // Freeze the handling window at booking. Later cargo can share it within the
  // booked loading and unloading capacity without moving either promised date.
  const slotCapacity = Math.min(service.capacity,
    service.loadingCapacity ? loadingQd * service.loadingCapacity : service.capacity,
    service.unloadingCapacity ? unloadingQd * service.unloadingCapacity : service.capacity);
  const first = service.firstQd ?? 0;
  const earliest = Math.max(first, readyQd + (service.loadingCapacity ? 1 : loadingQd));
  let departure = first + Math.ceil((earliest - first) / service.intervalQd) * service.intervalQd;
  for (; departure <= horizon; departure += service.intervalQd) {
    const id = slotId(service, departure);
    if (runs.some(run => occupied(run) && run.serviceId !== service.id && run.departureQd === departure
      && transportServicesShareFleet(run.serviceId, service.id))) continue;
    const existing = runs.find((run) => run.id === id && occupied(run));
    if (existing?.blocked || existing?.incident || existing?.riskChecked || ["travelling", "arrived"].includes(existing?.status)) continue;
    if (existing && (existing.kind !== service.kind
      || !sameScheduledEndpoint(existing.from, service.from) || !sameScheduledEndpoint(existing.to, service.to))) continue;
    const startQd = existing?.startQd ?? departure - loadingQd;
    if (startQd < readyQd) continue;
    const capacity = existing?.capacity ?? slotCapacity;
    const free = Math.min(service.capacity, capacity) - (existing?.reservedLoad ?? 0);
    if (free >= 0 && cargo.some(lot => lot.unitLoad <= free)) {
      return { id, departureQd: departure, startQd, unloadingQd, capacity, free, vehicle: "regular", existing };
    }
  }
  return null;
}

function charterSlot(service, readyQd, runs, horizon, termsAt) {
  const candidates = [];
  for (let vehicle = 0; vehicle < (service.vehicles ?? 1); vehicle++) {
    let start = Math.max(readyQd, service.firstQd ?? 0);
    const commitments = runs.filter((run) => occupied(run) && (service.kind === "owned"
      ? run.shipId === service.shipId : transportServicesShareFleet(run.serviceId, service.id) && run.vehicle === vehicle))
      .sort((a, b) => a.startQd - b.startQd);
    for (const run of commitments) {
      if (start + termsAt(start).durationQd <= run.startQd) break;
      if (start < run.releaseQd) start = run.releaseQd;
    }
    const terms = termsAt(start);
    if (start + terms.durationQd <= horizon) candidates.push({ id: slotId(service, start, vehicle), startQd: start,
      departureQd: start + (service.loadingQd ?? 0), free: service.capacity, vehicle, terms });
  }
  return candidates.sort((a, b) => a.startQd - b.startQd || a.vehicle - b.vehicle)[0] ?? null;
}

/** A location chain streams ready cargo through each independently reserved service. */
export function planTransportChain({ cargo, services, startQd = 0, runs = [], horizonQd = TRANSPORT_LIMITS.horizonQd, storageRate = 0, cargoArrivals = null }) {
  transportInteger(startQd, "дата");
  if (!cargo?.length || !services?.length || services.length > TRANSPORT_LIMITS.stages) throw new Error("Не задан груз или маршрут слишком длинный.");
  cargoLoad(cargo); cargoValue(cargo);
  const lots = new Set();
  for (const lot of cargo) {
    if (!lot.lotId || lots.has(lot.lotId)) throw new Error("Партии должны иметь уникальное происхождение.");
    lots.add(lot.lotId);
  }
  let arrivals = cargoArrivals ? copy(cargoArrivals) : [{ arrivalQd: startQd, cargo: copy(cargo) }];
  if (!cargoQuantitiesMatch(cargo, allArrivalCargo(arrivals))) throw new Error("Доступные партии не совпадают с грузом.");
  const workingRuns = copy(runs), stages = [];
  const horizon = startQd + transportInteger(horizonQd, "горизонт", 1, 100000);
  let previous = null, ownedEnded = false, ownedId = "";
  for (const [index, rawService] of services.entries()) {
    let service = rawService;
    checkService(service);
    if (previous && previous.to !== service.from) throw new Error("Разрыв транспортной цепочки.");
    if (service.kind === "owned") {
      if (ownedEnded || (ownedId && ownedId !== service.shipId)) throw new Error("Свой корабль может занимать только одну непрерывную часть маршрута.");
      ownedId = service.shipId;
    } else if (ownedId) ownedEnded = true;
    let minimumReadyQd = startQd;
    if (service.kind === "owned" && previous?.kind !== "owned") {
      validateEmptyPath(service, "approach");
      if (service.approachSeasonal) {
        const approachQd = transportEmptyQd(service, "approach", startQd);
        service = { ...service, approachQd, approachCopper: transportOperatingCharge({ dailyCosts: service.approachDailyCosts ?? service.dailyCosts }, approachQd) };
      }
      minimumReadyQd += service.approachQd ?? 0;
      if (previous && services[index + 1]?.kind === "owned") {
        minimumReadyQd = Math.max(minimumReadyQd, ...arrivals.map(row => row.arrivalQd));
      }
    }
    // One owned vessel finishes its previous shuttles before continuing from their destination.
    if (service.kind === "owned" && previous?.kind === "owned") {
      minimumReadyQd = Math.max(minimumReadyQd, ...stages.at(-1).runs.map(run => run.releaseQd));
    }
    const readyQd = Math.max(minimumReadyQd, Math.min(...arrivals.map(row => row.arrivalQd)));
    const forwarded = [], stageRuns = [];
    let storageCopper = 0, firstTerms = null;
    while (true) {
      const remaining = remainingCargoArrivals(arrivals, forwarded);
      if (!remaining.length) break;
      if (stages.reduce((sum, stage) => sum + stage.runs.length, 0) + stageRuns.length >= TRANSPORT_LIMITS.runs) throw new TransportPlanningUnavailableError("run-limit", "Слишком много отправлений. Уменьшите заказ.");
      const waiting = allArrivalCargo(remaining);
      if (waiting.some(lot => lot.unitLoad > service.capacity)) throw new Error("Одна единица товара больше вместимости транспорта.");
      let observeAtQd = Math.max(minimumReadyQd, remaining[0].arrivalQd);
      let available, timed, slot, start, returnQd, finalOwnReturn, returnsToOrigin;
      while (true) {
        available = availableTransportCargo(arrivals, forwarded, observeAtQd, { age: false });
        const cargoReadyQd = Math.max(minimumReadyQd,
          ...remaining.filter(wave => wave.arrivalQd <= observeAtQd).map(wave => wave.arrivalQd));
        const full = takeTransportCargo(available, service.capacity), fullLoad = cargoLoad(full.taken);
        timed = service.kind !== "regular" ? { ...service,
          loadingQd: (service.preparationQd ?? 0) + handlingQd(fullLoad, service.loadingCapacity, service.loadingQd),
          unloadingQd: handlingQd(fullLoad, service.unloadingCapacity, service.unloadingQd) } : service;
        const last = cargoQuantitiesMatch(full.taken, waiting);
        finalOwnReturn = service.kind === "owned" && last && service.returnAtEnd && services[index + 1]?.kind !== "owned";
        if (service.kind === "owned" && (finalOwnReturn || !last)) validateEmptyPath(service, finalOwnReturn ? "endReturn" : "return");
        const termsAt = (at, departure = at + (timed.loadingQd ?? 0)) => {
          const evaluated = transportServiceAt(timed, departure,
            { unloadingQd: timed.unloadingQd, returnKind: finalOwnReturn ? "endReturn" : "return" });
          const backQd = service.kind === "regular" ? 0 : finalOwnReturn ? evaluated.endReturnQd ?? evaluated.returnQd ?? 0
            : (service.kind === "charter" || !last ? evaluated.returnQd ?? 0 : 0);
          return { service: evaluated, returnQd: backQd,
            durationQd: (timed.loadingQd ?? 0) + evaluated.travelQd + (timed.unloadingQd ?? 0) + backQd };
        };
        slot = service.kind === "regular" ? regularSlot(service, cargoReadyQd, workingRuns, horizon, available, fullLoad)
          : charterSlot(timed, cargoReadyQd, workingRuns, horizon, termsAt);
        if (!slot) throw new TransportPlanningUnavailableError("no-slot", "Нет свободного транспорта в горизонте планирования.");
        start = slot.startQd;
        const terms = slot.terms ?? termsAt(start, slot.departureQd);
        timed = terms.service; returnQd = terms.returnQd;
        returnsToOrigin = returnQd > 0 || service.distanceKm === 0
          && (service.kind === "charter" || service.kind === "owned" && !last);
        const atStart = availableTransportCargo(arrivals, forwarded, start, { age: false });
        if (cargoQuantitiesMatch(available, atStart)) break;
        observeAtQd = start;
      }
      const packed = takeTransportCargo(available, slot.free);
      if (!packed.taken.length) throw new Error("Груз не помещается в транспорт.");
      const load = cargoLoad(packed.taken);
      const arrivalQd = slot.existing?.arrivalQd ?? slot.departureQd + timed.travelQd + (slot.unloadingQd ?? timed.unloadingQd ?? 0);
      if (arrivalQd > horizon) throw new TransportPlanningUnavailableError("horizon", "Доставка выходит за горизонт планирования.");
      const charge = transportServiceCharge(timed, load, arrivalQd + returnQd - start, returnQd);
      if (!service.storageIncluded) {
        const needed = new Map(packed.taken.map(lot => [lot.lotId, lot.qty]));
        let loadQd = 0;
        for (const wave of remaining) for (const lot of wave.cargo) {
          if (wave.arrivalQd > start) continue;
          const qty = Math.min(lot.qty, needed.get(lot.lotId) ?? 0);
          needed.set(lot.lotId, (needed.get(lot.lotId) ?? 0) - qty);
          loadQd += qty * lot.unitLoad * Math.max(0, start - wave.arrivalQd);
        }
        storageCopper += transportRateCharge(loadQd, service.storageMilliCopperPerLoadQd
          ?? (service.storageCopperPerLoadQd ?? storageRate) * 1000, TRANSPORT_LOAD_SCALE * 1000);
      }
      const run = { id: slot.id, serviceId: service.id, serviceLabel: service.label || service.id, kind: service.kind,
        shipId: service.shipId ?? "", vehicle: slot.vehicle, from: service.from, to: service.to,
        startQd: start, departureQd: slot.departureQd, arrivalQd, releaseQd: arrivalQd + returnQd,
        releaseLocation: finalOwnReturn ? service.endReturnLocation ?? service.from : returnsToOrigin ? service.from : service.to,
        capacity: slot.capacity ?? service.capacity, reservedLoad: load, cargo: packed.taken, charge, status: "booked", riskBps: timed.riskBps ?? 0 };
      if (slot.existing) {
        for (const key of ["startQd", "departureQd", "arrivalQd", "releaseQd", "releaseLocation", "capacity", "riskBps"]) run[key] = slot.existing[key];
      }
      const shared = workingRuns.find(row => row.id === run.id && occupied(row));
      if (shared) shared.reservedLoad += load;
      else workingRuns.push(copy(run));
      stageRuns.push(run);
      firstTerms ??= timed;
      forwarded.push(...packed.taken);
    }
    const completedQd = Math.max(...stageRuns.map(run => run.arrivalQd));
    // Keep handling inputs, not the per-run preparation+loading sum: replanning adds preparation once.
    const snapshot = firstTerms ? { ...firstTerms, loadingQd: service.loadingQd, unloadingQd: service.unloadingQd } : service;
    stages.push({ index, from: service.from, to: service.to, service: copy(snapshot), readyQd, completedQd,
      storageCopper, runs: stageRuns, totalCopper: transportMoney([...stageRuns.map(run => run.charge.totalCopper), storageCopper]) });
    arrivals = stageRuns.map(run => ({ arrivalQd: run.arrivalQd, cargo: run.cargo }));
    previous = service;
  }
  const ownStages = stages.filter(stage => stage.service.kind === "owned");
  const ownedRuns = ownStages.flatMap(stage => stage.runs), lastOwn = ownedRuns.at(-1), firstOwned = ownStages[0];
  const waitingQd = firstOwned ? Math.max(0, firstOwned.runs[0].startQd - startQd - (firstOwned.service.approachQd ?? 0)) : 0;
  const waitingCopper = firstOwned ? transportWaitingCharge(firstOwned.service, waitingQd) : 0;
  const approachCopper = transportMoney([firstOwned?.service.approachCopper ?? 0, waitingCopper]);
  return { version: 2, startQd, cargo: copy(cargo), stages, ownShipId: ownedId, approachCopper,
    shipApproachCopper: firstOwned?.service.approachCopper ?? 0, shipWaitingCopper: waitingCopper,
    totalCopper: transportMoney([...stages.map(stage => stage.totalCopper), approachCopper]),
    ownExpensesCopper: transportMoney([...ownStages.map(stage => stage.totalCopper), approachCopper]),
    arrivalQd: stages.at(-1).completedQd, firstArrivalQd: Math.min(...stages.at(-1).runs.map(run => run.arrivalQd)),
    shipReleaseQd: lastOwn?.releaseQd ?? null, shipReleaseLocation: lastOwn?.releaseLocation ?? "" };
}

/** Confirmation validates a submitted chain independently of the search heuristic. */
export function validateTransportPlan(plan, { services, runs = [], startQd = plan?.startQd } = {}) {
  const selected = plan?.stages?.map((stage) => services.find((service) => service.id === stage.service.id));
  if (!selected?.length || selected.some((service) => !service || service.enabled === false)) throw new Error("Услуга перевозки больше недоступна.");
  const fresh = planTransportChain({ cargo: plan.cargo, services: selected, startQd, runs });
  if (JSON.stringify(fresh) !== JSON.stringify(plan)) throw new Error("Условия или свободные места изменились. Обновите расчёт.");
  return fresh;
}
