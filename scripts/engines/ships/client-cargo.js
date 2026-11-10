import { cargoDeliveryQuantity } from "../market/cargo-aging.js";
import { transportInteger } from "../transport/quantities.js";

/** Existing cargo fields freeze the new agreement's lifetime; absent fields retain legacy terms. */
export function clientCargoLifetime(cargo) {
  return cargo?.shelfLifeQd == null ? 0 : transportInteger(cargo.shelfLifeQd, "срок годности клиентского груза");
}

/** Snapshot at loading completion, including its elapsed work but excluding the empty approach. */
export function startClientCargo(cargo, atQd, loadingQd = 0) {
  if (!clientCargoLifetime(cargo)) return;
  cargo.ageQd = transportInteger(loadingQd, "возраст клиентского груза после погрузки");
  cargo.ageAtQd = transportInteger(atQd, "дата погрузки клиентского груза");
}

export function clientCargoViableAt(cargo, atQd) {
  if (!clientCargoLifetime(cargo) || cargo.ageAtQd == null) return true;
  const elapsed = Math.max(0, transportInteger(atQd, "дата доставки клиентского груза") - cargo.ageAtQd);
  return cargoDeliveryQuantity({ ...cargo, qty: cargo.quantity, ageQd: (cargo.ageQd ?? 0) + elapsed }) > 0;
}

/** Called once while creating the saved outcome; unpaid retries keep exactly the same result. */
export function clientCargoOutcome(contract, outcome, atQd, delayQd = outcome.delayQd) {
  if (clientCargoViableAt(contract.cargo, atQd + delayQd)) return outcome;
  return { ...outcome, rewardCopper: 0, commercialLabel: "Клиентский груз испортился: плата за доставку не начислена" };
}

export function clientCargoLadenDelay(contract, style, outcome) {
  const factor = style === "cautious" ? 0.75 : style === "bold" ? 1.5 : 1;
  const approachRisk = Math.min(10000, Math.ceil((contract.economics?.approachRiskBps ?? 0) * factor));
  return outcome.passageRoll <= approachRisk ? 0 : outcome.delayQd;
}
