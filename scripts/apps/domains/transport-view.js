import { transportOrderHasObligations } from "../../data/transport/state.js";
import { transportServiceExcluded, resolveTransportSelections } from "../../engines/transport/service-identity.js";
import { TRANSPORT_LOAD_SCALE } from "../../engines/transport/quantities.js";

export const TRANSPORT_HISTORY_PAGE_SIZE = 20;

export const transportRiskLabel = (riskBps = 0) => `${(riskBps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;

/** Parallel departures have separate events; a range never adds their probabilities. */
export function transportStageRiskLabel(stage) {
  const risks = stage.runs.map(run => run.riskBps ?? 0);
  if (!risks.length) return "Нет отправлений";
  const minimum = Math.min(...risks), maximum = Math.max(...risks);
  return minimum === maximum ? transportRiskLabel(minimum) : `${transportRiskLabel(minimum)}–${transportRiskLabel(maximum)}`;
}

export function transportHistoryPage(orders, page = 0) {
  const active = [], history = [];
  for (const order of orders) (transportOrderHasObligations(order) ? active : history).push(order);
  const pages = Math.max(1, Math.ceil(history.length / TRANSPORT_HISTORY_PAGE_SIZE));
  const current = Math.min(pages - 1, Math.max(0, Math.floor(page) || 0));
  const end = Math.max(0, history.length - current * TRANSPORT_HISTORY_PAGE_SIZE);
  return { orders: [...active.reverse(), ...history.slice(Math.max(0, end - TRANSPORT_HISTORY_PAGE_SIZE), end).reverse()],
    history: { count: history.length, page: current + 1, pages, previous: current > 0, next: current + 1 < pages } };
}

/** Refinement choices exist before a feasible plan; endpoint labels remain view-owned. */
export function transportRefinements(services = [], request = {}, pointLabel = id => id) {
  request = resolveTransportSelections(services, request).request;
  const groups = new Map(), companies = new Map();
  for (const service of services) {
    if (service.enabled === false) continue;
    if (service.companyId && !(request.excluded ?? []).includes(service.companyId)) {
      companies.set(service.companyId, { id: service.companyId, label: service.label });
    }
    if (transportServiceExcluded(service, request.excluded)) continue;
    if (!groups.has(service.from)) groups.set(service.from, { from: service.from, label: pointLabel(service.from),
      automatic: !request.pins?.[service.from], options: [] });
    const kind = service.kind === "owned" ? "свой корабль" : service.kind === "regular" ? "регулярный" : "чартер";
    groups.get(service.from).options.push({ value: service.id, selected: request.pins?.[service.from] === service.id,
      label: `${pointLabel(service.to)} · ${service.label} · ${kind} · до ${service.capacity / TRANSPORT_LOAD_SCALE} ед. нагрузки` });
  }
  return { groups: [...groups.values()], companies: [...companies.values()] };
}
