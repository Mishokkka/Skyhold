import {
  MAX_PAYROLL_OPERATION_RECEIPTS,
  normalizePayrollAccount,
  normalizePayrollState,
  PAYROLL_STATE_VERSION
} from "../../data/labor/payroll-state.js";

export {
  MAX_PAYROLL_OPERATION_RECEIPTS,
  normalizePayrollAccount,
  normalizePayrollState,
  PAYROLL_STATE_VERSION
};

function text(value = "") {
  return String(value ?? "").trim();
}

function wholeCopper(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

function signedWholeCopper(value = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function boundedRate(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function enterpriseIdForPerson(person = {}) {
  const assignment = text(person?.workAssignment);
  return assignment.startsWith("building:") ? assignment.slice("building:".length) : assignment;
}

export function validateEnterpriseShareContracts(people = []) {
  const groups = new Map();
  for (const person of Array.isArray(people) ? people : []) {
    if (person?.dead || text(person?.compensationType) !== "share") continue;
    const enterpriseId = enterpriseIdForPerson(person);
    const personId = text(person?.id);
    const rate = boundedRate(person?.shareRate);
    if (!enterpriseId || !personId || rate <= 0) continue;
    const rows = groups.get(enterpriseId) ?? [];
    rows.push({ personId, rate });
    groups.set(enterpriseId, rows);
  }
  const issues = [];
  for (const [enterpriseId, rows] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "ru"))) {
    const totalRate = rows.reduce((sum, row) => sum + row.rate, 0);
    if (totalRate <= 1 + 1e-9) continue;
    issues.push({
      code: "enterprise-share-overallocated",
      enterpriseId,
      totalRate,
      personIds: rows.map((row) => row.personId).sort((left, right) => left.localeCompare(right, "ru")),
      message: `Сумма долей предприятия ${enterpriseId} равна ${Math.round(totalRate * 10000) / 100}% и превышает 100%.`
    });
  }
  return issues;
}

export function enterpriseActualNetCopper(report = {}, enterpriseId = "", {
  resourcePriceCopper = () => 0,
  itemPriceCopper = () => 0
} = {}) {
  const sourceId = text(enterpriseId);
  let money = 0;
  let directCosts = 0;
  for (const row of Array.isArray(report?.ledger) ? report.ledger : []) {
    if (text(row?.sourceId) !== sourceId) continue;
    const qty = Number(row?.qty);
    if (!Number.isFinite(qty) || qty === 0) continue;
    const kind = text(row?.kind);
    const resourceId = text(row?.resourceId);
    if (kind === "money" || resourceId === "money") {
      money += signedWholeCopper(qty);
      continue;
    }
    if (qty >= 0) continue;
    const explicitCost = wholeCopper(row?.meta?.directCostCopper ?? row?.meta?.costCopper);
    if (explicitCost > 0) {
      directCosts += explicitCost;
      continue;
    }
    const unitPrice = kind === "item"
      ? wholeCopper(itemPriceCopper(row))
      : wholeCopper(resourcePriceCopper(resourceId, row));
    directCosts += wholeCopper(Math.abs(qty) * unitPrice);
  }
  return Math.trunc(money - directCosts);
}

function allocateWholeCopper(totalCopper, weightedRows = []) {
  const total = wholeCopper(totalCopper);
  const rows = weightedRows
    .map((row) => ({ ...row, id: text(row?.id), weight: Math.max(0, Number(row?.weight) || 0) }))
    .filter((row) => row.id && row.weight > 0)
    .sort((left, right) => left.id.localeCompare(right.id, "ru"));
  const weightSum = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!total || !weightSum) return rows.map((row) => ({ ...row, copper: 0 }));
  const allocated = rows.map((row) => {
    const exact = total * row.weight / weightSum;
    const copper = Math.floor(exact);
    return { ...row, copper, remainder: exact - copper };
  });
  let left = total - allocated.reduce((sum, row) => sum + row.copper, 0);
  const remainderOrder = [...allocated].sort((leftRow, rightRow) => (
    rightRow.remainder - leftRow.remainder || leftRow.id.localeCompare(rightRow.id, "ru")
  ));
  for (let index = 0; left > 0 && remainderOrder.length; index = (index + 1) % remainderOrder.length) {
    remainderOrder[index].copper += 1;
    left -= 1;
  }
  return allocated.map(({ remainder, ...row }) => row);
}

export function calculateEnterpriseSharePayouts({
  people = [],
  report = {},
  resourcePriceCopper = () => 0,
  itemPriceCopper = () => 0
} = {}) {
  const contracts = new Map();
  for (const person of Array.isArray(people) ? people : []) {
    if (person?.dead || text(person?.compensationType) !== "share") continue;
    const personId = text(person?.id);
    const enterpriseId = enterpriseIdForPerson(person);
    const rate = boundedRate(person?.shareRate);
    if (!personId || !enterpriseId || rate <= 0) continue;
    const rows = contracts.get(enterpriseId) ?? [];
    rows.push({ personId, rate });
    contracts.set(enterpriseId, rows);
  }

  const issues = validateEnterpriseShareContracts(people);
  const payouts = [];
  const enterprises = [];
  for (const [enterpriseId, rows] of [...contracts.entries()].sort(([left], [right]) => left.localeCompare(right, "ru"))) {
    const netCopper = enterpriseActualNetCopper(report, enterpriseId, { resourcePriceCopper, itemPriceCopper });
    const distributableNet = Math.max(0, netCopper);
    const totalRate = rows.reduce((sum, row) => sum + row.rate, 0);
    const effectiveRate = Math.min(1, totalRate);
    const poolCopper = Math.floor(distributableNet * effectiveRate + 1e-9);
    const allocated = allocateWholeCopper(poolCopper, rows.map((row) => ({ id: row.personId, weight: row.rate })));
    for (const allocation of allocated) {
      const contract = rows.find((row) => row.personId === allocation.id);
      payouts.push({
        personId: allocation.id,
        enterpriseId,
        kind: "share",
        contractRate: contract?.rate ?? 0,
        dueCopper: allocation.copper
      });
    }
    enterprises.push({ enterpriseId, netCopper, distributableNet, totalRate, effectiveRate, poolCopper });
  }
  return {
    payouts: payouts.sort((left, right) => left.personId.localeCompare(right.personId, "ru") || left.enterpriseId.localeCompare(right.enterpriseId, "ru")),
    enterprises,
    issues,
    dueCopper: payouts.reduce((sum, row) => sum + row.dueCopper, 0)
  };
}

export function settlePayroll({ state = {}, obligations = [], availableCopper = 0, operationId = "" } = {}) {
  const id = text(operationId);
  if (!id) throw new TypeError("FBL Skyhold | Payroll settlement requires operationId.");
  const normalizedState = normalizePayrollState(state);
  const currentDueByPerson = new Map();
  for (const row of Array.isArray(obligations) ? obligations : []) {
    const personId = text(row?.personId ?? row?.id);
    const dueCopper = wholeCopper(row?.dueCopper ?? row?.copper);
    if (!personId || !dueCopper) continue;
    currentDueByPerson.set(personId, (currentDueByPerson.get(personId) ?? 0) + dueCopper);
  }
  const treasuryBeforeCopper = wholeCopper(availableCopper);
  const requestHash = JSON.stringify({
    availableCopper: treasuryBeforeCopper,
    obligations: [...currentDueByPerson.entries()]
      .map(([personId, dueCopper]) => ({ personId, dueCopper }))
      .sort((left, right) => left.personId.localeCompare(right.personId, "ru"))
  });
  const replay = normalizedState.receipts.find((receipt) => receipt.operationId === id);
  if (replay) {
    if (replay.requestHash && replay.requestHash !== requestHash) {
      return { ok: false, conflict: true, replay: false, state: normalizedState, message: "operationId уже использован для другого расчёта зарплат." };
    }
    return { ok: true, replay: true, state: normalizedState, receipt: clone(replay) };
  }

  const personIds = [...new Set([...Object.keys(normalizedState.accounts), ...currentDueByPerson.keys()])]
    .sort((left, right) => left.localeCompare(right, "ru"));
  const dueRows = personIds.map((personId) => {
    const account = normalizedState.accounts[personId] ?? normalizePayrollAccount({}, personId);
    const currentDueCopper = currentDueByPerson.get(personId) ?? 0;
    return { personId, account, currentDueCopper, dueCopper: account.arrearsCopper + currentDueCopper };
  });
  const totalDueCopper = dueRows.reduce((sum, row) => sum + row.dueCopper, 0);
  const paidPool = Math.min(treasuryBeforeCopper, totalDueCopper);
  const allocations = new Map(allocateWholeCopper(paidPool, dueRows.map((row) => ({ id: row.personId, weight: row.dueCopper }))).map((row) => [row.id, row.copper]));
  const receiptRows = [];
  for (const row of dueRows) {
    const paidCopper = allocations.get(row.personId) ?? 0;
    const arrearsCopper = Math.max(0, row.dueCopper - paidCopper);
    const overdueTendays = arrearsCopper > 0 ? row.account.overdueTendays + 1 : 0;
    normalizedState.accounts[row.personId] = {
      personId: row.personId,
      arrearsCopper,
      overdueTendays,
      lastDueCopper: row.currentDueCopper,
      lastPaidCopper: paidCopper,
      totalDueCopper: row.account.totalDueCopper + row.currentDueCopper,
      totalPaidCopper: row.account.totalPaidCopper + paidCopper
    };
    receiptRows.push({ personId: row.personId, dueCopper: row.dueCopper, paidCopper, arrearsCopper, overdueTendays });
  }
  const paidCopper = receiptRows.reduce((sum, row) => sum + row.paidCopper, 0);
  const arrearsCopper = receiptRows.reduce((sum, row) => sum + row.arrearsCopper, 0);
  const receipt = {
    operationId: id,
    requestHash,
    dueCopper: totalDueCopper,
    paidCopper,
    arrearsCopper,
    treasuryBeforeCopper,
    treasuryAfterCopper: treasuryBeforeCopper - paidCopper,
    rows: receiptRows
  };
  normalizedState.receipts.push(receipt);
  normalizedState.receipts = normalizedState.receipts.slice(-MAX_PAYROLL_OPERATION_RECEIPTS);
  return { ok: true, replay: false, state: normalizedState, receipt: clone(receipt) };
}

export function arrearsLaborFactor(account = {}) {
  const overdue = wholeCopper(account?.overdueTendays);
  if (overdue >= 3) return 0;
  if (overdue === 2) return 0.5;
  if (overdue === 1) return 0.75;
  return 1;
}
