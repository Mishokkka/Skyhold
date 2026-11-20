import { formatCopperCurrencyCompact } from "./currency.js";

/** Ship screens display compact З / С / М currency; numeric inputs use decimal gold (1 З = 100 М) and persistence keeps integer copper. */
export function formatShipMoney(copper) {
  if (copper === null || copper === undefined || copper === "") return "—";
  const value = Number(copper);
  if (!Number.isSafeInteger(value)) return "—";
  const sign = value < 0 ? "−" : "";
  return `${sign}${formatCopperCurrencyCompact(Math.abs(value))}`;
}

export function formatShipGold(copper) {
  const value = Number(copper);
  if (!Number.isSafeInteger(value)) return "—";
  const sign = value < 0 ? "−" : "";
  const whole = Math.floor(Math.abs(value) / 100);
  const fraction = String(Math.abs(value) % 100).padStart(2, "0");
  return `${sign}${whole.toLocaleString("ru-RU")},${fraction}`;
}

export function parseShipGoldInput(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(text)) throw new Error("Укажите сумму в золотых с точностью до 0,01 (1 М).");
  const [whole, fraction = ""] = text.split(".");
  const copper = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(copper) || copper > 1_000_000_000) throw new Error("Сумма слишком велика.");
  return copper;
}

export function shipGoldInput(copper) {
  const value = Number(copper);
  return Number.isSafeInteger(value) ? (value / 100).toFixed(2) : "0.00";
}
