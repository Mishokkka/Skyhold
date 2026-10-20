// Persisted shipment money fields already use this limit. Reject a new quote
// before booking instead of silently clamping its financial promise on save.
export const MAX_MARKET_OPERATION_COPPER = 1_000_000_000;

export function marketMoneyInRange(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MARKET_OPERATION_COPPER;
}
