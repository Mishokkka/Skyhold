// Immutable accounting used by both voyage adapters. Each adapter supplies the
// current settlement balance and writes the resulting balances to its draft.
function money(value, name) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) throw new RangeError(`${name} must be a non-negative safe integer no greater than 1000000000`);
  return value;
}

function requireFunds(balance, amount) {
  if (balance < amount) throw new RangeError("Insufficient funds");
}

export function createShipFunds(settlementCopper) {
  money(settlementCopper, "settlementCopper");
  return { settlementCopper, onboardCopper: 0, status: "docked", receipts: [] };
}

/** Pure immutable operation with replay/conflict detection within the supplied ledger. */
export function applyShipFundsOperation(state, operation) {
  money(state.settlementCopper, "settlementCopper");
  money(state.onboardCopper, "onboardCopper");
  if (!["docked", "away"].includes(state.status) || !Array.isArray(state.receipts)) throw new TypeError("Invalid funds state");
  const { id, kind } = operation;
  if (typeof id !== "string" || !id.trim()) throw new TypeError("operation.id is required");
  if (!["depart", "expense", "income", "return", "deposit", "withdraw"].includes(kind)) throw new TypeError("Unknown funds operation");
  const amountCopper = money(operation.amountCopper ?? 0, "amountCopper");
  const preparationCopper = money(operation.preparationCopper ?? 0, "preparationCopper");
  if (kind !== "depart" && preparationCopper !== 0) throw new RangeError("Preparation is only paid on departure");
  if (kind === "return" && amountCopper !== 0) throw new RangeError("Return transfers the whole balance");
  const signature = JSON.stringify([kind, amountCopper, preparationCopper]);
  const prior = state.receipts.find((receipt) => receipt.id === id);
  if (prior) {
    if (prior.signature !== signature) throw new Error("Operation ID conflict");
    return { state, replay: true, receipt: prior };
  }

  let settlementCopper = state.settlementCopper;
  let onboardCopper = state.onboardCopper;
  let status = state.status;
  let externalDeltaCopper = 0;
  let transferToShipCopper = 0;
  if (kind === "deposit" || kind === "withdraw") {
    if (status !== "docked") throw new Error("Home transfers require a docked ship");
    if (kind === "deposit") {
      requireFunds(settlementCopper, amountCopper);
      settlementCopper -= amountCopper;
      onboardCopper = money(onboardCopper + amountCopper, "onboardCopper");
      transferToShipCopper = amountCopper;
    } else {
      requireFunds(onboardCopper, amountCopper);
      onboardCopper -= amountCopper;
      settlementCopper = money(settlementCopper + amountCopper, "settlementCopper");
      transferToShipCopper = -amountCopper;
    }
  } else if (kind === "depart") {
    if (status !== "docked") throw new Error("Ship is already away");
    const topUpCopper = Math.max(0, amountCopper - onboardCopper);
    const required = money(topUpCopper + preparationCopper, "departure total");
    requireFunds(settlementCopper, required);
    settlementCopper -= required;
    onboardCopper = money(onboardCopper + topUpCopper, "onboardCopper");
    externalDeltaCopper = preparationCopper ? -preparationCopper : 0;
    transferToShipCopper = topUpCopper;
    status = "away";
  } else {
    if (status !== "away") throw new Error("Ship is not away");
    if (kind === "expense") {
      requireFunds(onboardCopper, amountCopper);
      onboardCopper -= amountCopper;
      externalDeltaCopper = amountCopper ? -amountCopper : 0;
    } else if (kind === "income") {
      onboardCopper = money(onboardCopper + amountCopper, "onboardCopper");
      externalDeltaCopper = amountCopper;
    } else {
      settlementCopper = money(settlementCopper + onboardCopper, "settlementCopper");
      transferToShipCopper = onboardCopper ? -onboardCopper : 0;
      onboardCopper = 0;
      status = "docked";
    }
  }
  const receipt = { id, signature, kind, externalDeltaCopper, transferToShipCopper };
  return {
    replay: false, receipt,
    state: { settlementCopper, onboardCopper, status, receipts: [...state.receipts, receipt] }
  };
}
