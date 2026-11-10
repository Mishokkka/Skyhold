/** A retryable absence of a feasible plan must preserve existing reservations. */
export class TransportPlanningUnavailableError extends Error {
  constructor(code, message) { super(message); this.name = "TransportPlanningUnavailableError"; this.code = code; }
}
