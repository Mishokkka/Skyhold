import { MARKET_DELIVERY_SERVICES } from "./pricing.js";
import { MAX_ACTIVE_OUTBOUND_ORDERS } from "../../data/market/outbound-state.js";
import { allocateMarketTransportCharges, marketTransportPlanForOrder } from "../../data/market/transport-plan.js";

const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Allocate integer amounts without losing rounding remainders. Stable ties follow source order. */
function allocate(total, weights) {
  const sum = weights.reduce((value, weight) => value + weight, 0);
  if (!sum) return weights.map((_, index) => index === 0 ? whole(total) : 0);
  const exact = weights.map((weight) => whole(total) * weight / sum);
  const result = exact.map(Math.floor);
  const ranked = exact.map((value, index) => ({ index, fraction: value - result[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  const remainder = whole(total) - result.reduce((value, amount) => value + amount, 0);
  for (let index = 0; index < remainder; index++) result[ranked[index].index] += 1;
  return result;
}

/** Transient plans only. Existing accepted orders are never split during loading or advancement. */
export function marketOutboundBatchPlans(plan = {}) {
  const source = plan.route?.ownShipId ? [] : plan.route?.shipmentBatches ?? [];
  if (source.length < 2) return [];
  if (!Array.isArray(source) || source.length > MAX_ACTIVE_OUTBOUND_ORDERS) throw new Error("Слишком много исходящих рейсов. Разделите продажу.");
  const standardQd = Number(plan.route.standardDeliveryQd);
  const service = MARKET_DELIVERY_SERVICES[plan.route.serviceLevel ?? "standard"];
  if (!service || !Number.isSafeInteger(standardQd) || standardQd < 1) throw new Error("Расписание исходящей котировки неполное. Пересчитайте продажу.");
  const transportQd = Math.max(1, Math.ceil(standardQd * service.etaFactor));
  const intervalQd = Math.max(1, Math.ceil(standardQd * service.intervalFactor));
  if (source.some((batch, index) => batch.deliveryQd !== transportQd + index * intervalQd || batch.deliveryQd > 100_000)) {
    throw new Error("Расписание исходящей котировки изменилось. Пересчитайте продажу.");
  }
  const remaining = (plan.cargoReservations ?? []).map((row) => ({ ...row }));
  const remainingBuyers = (plan.buyerAllocations ?? []).map((row) => ({ ...row }));
  const batches = source.map((batch, index) => {
    const cargoReservations = [];
    for (const line of batch.lines ?? []) {
      let qty = whole(line.qty);
      for (const cargo of remaining) {
        if (!qty || cargo.resourceId !== line.resourceId || !cargo.qty) continue;
        const amount = Math.min(qty, cargo.qty);
        cargoReservations.push({ ...cargo, qty: amount, cargoValueCopper: amount * whole(cargo.unitPriceCopper) });
        cargo.qty -= amount;
        qty -= amount;
      }
      if (qty) throw new Error("Груз котировки не совпадает с исходящим резервом. Пересчитайте продажу.");
    }
    if (!cargoReservations.length) throw new Error("В котировке исходящего рейса обнаружена пустая партия.");
    const qtyByLine = new Map();
    for (const row of cargoReservations) qtyByLine.set(row.lineId, (qtyByLine.get(row.lineId) ?? 0) + row.qty);
    const lines = plan.lines.filter((line) => qtyByLine.has(line.id))
      .map((line) => ({ ...line, qty: qtyByLine.get(line.id) }));
    const buyerAllocations = lines.flatMap((line) => {
      const buyers = remainingBuyers.filter((buyer) => buyer.lineId === line.id && buyer.qty > 0);
      if (buyers.reduce((sum, buyer) => sum + buyer.qty, 0) < line.qty) throw new Error("Распределение покупателей не покрывает исходящий груз.");
      const amounts = allocate(line.qty, buyers.map((buyer) => buyer.qty));
      return buyers.flatMap((buyer, buyerIndex) => {
        const qty = amounts[buyerIndex];
        buyer.qty -= qty;
        return qty > 0 ? [{ ...buyer, qty }] : [];
      });
    });
    const risk = batch.riskProfile ?? {};
    return {
      ...plan,
      ...(Object.hasOwn(batch, "transportLegCosts") ? { transportLegCosts: batch.transportLegCosts } : {}),
      direction: "outbound",
      shipmentBatches: undefined,
      lines,
      demandLines: (plan.demandLines ?? plan.lines).filter((line) => qtyByLine.has(line.id))
        .map((line) => ({ ...line, qty: qtyByLine.get(line.id) })),
      cargoReservations,
      buyerAllocations,
      revenueCopper: cargoReservations.reduce((sum, row) => sum + row.cargoValueCopper, 0),
      deliveryQd: whole(batch.deliveryQd),
      standardDeliveryQd: whole(plan.route.standardDeliveryQd),
      serviceLevel: plan.route.serviceLevel ?? "standard",
      batchIndex: index,
      batchCount: source.length,
      riskFactor: risk.riskFactor ?? plan.riskFactor,
      riskLossChance: risk.lossChance ?? plan.riskLossChance,
      riskDelayChance: risk.delayChance ?? plan.riskDelayChance,
      riskMaxDelayQd: risk.maxDelayQd ?? plan.riskMaxDelayQd
    };
  });
  if (remaining.some((row) => row.qty) || remainingBuyers.some((buyer) => buyer.qty)) throw new Error("Котировка рейсов не покрывает весь исходящий груз и распределение покупателей.");
  for (const [field, weights] of [
    ["freightCopper", source.map((batch) => whole(batch.routeCopper) + whole(batch.handlingCopper) + whole(batch.expressSurchargeCopper))],
    ["tariffCopper", source.map((batch) => whole(batch.taxCopper))],
    ["importTaxCopper", source.map((batch) => whole(batch.importTaxCopper))],
    ["exportTaxCopper", source.map((batch) => whole(batch.exportTaxCopper))]
  ]) {
    const amounts = allocate(plan[field], weights);
    batches.forEach((batch, index) => { batch[field] = amounts[index]; });
  }
  const insured = batches.map((batch) => batch.revenueCopper + batch.freightCopper + batch.tariffCopper);
  const premiums = allocate(plan.insuranceCopper, insured);
  const maximums = allocate(plan.maximumInsurancePayoutCopper, insured);
  batches.forEach((batch, index) => {
    batch.insuredValueCopper = insured[index];
    batch.insuranceCopper = premiums[index];
    const coverage = Math.max(0, Math.min(1, Number(batch.insuranceCoverageRate) || 0));
    batch.maximumInsurancePayoutCopper = Math.min(maximums[index], Math.floor(insured[index] * coverage));
    batch.upfrontCopper = batch.freightCopper + batch.tariffCopper + batch.insuranceCopper;
    if (plan.route?.transportPlan) {
      const sourceBatch = source[index];
      const [freightCopper, handlingCopper, expressSurchargeCopper] = allocateMarketTransportCharges(batch.freightCopper,
        [whole(sourceBatch.routeCopper), whole(sourceBatch.handlingCopper), whole(sourceBatch.expressSurchargeCopper)]);
      batch.route = { ...plan.route, transportPlan: marketTransportPlanForOrder(plan.route.transportPlan, {
        transportLegCosts: sourceBatch.transportLegCosts, batchCount: 1, freightCopper,
        insuranceCopper: batch.insuranceCopper, taxCopper: batch.tariffCopper, handlingCopper, expressSurchargeCopper,
        deliveryCopper: batch.upfrontCopper, serviceLevel: batch.serviceLevel, allowReallocation: true
      }) };
    }
  });
  return batches;
}
