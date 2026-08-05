export const PAYROLL_STATE_VERSION = 1;
export const MAX_PAYROLL_OPERATION_RECEIPTS = 120;

function text(value = "") {
  return String(value ?? "").trim();
}

function wholeCopper(value = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.floor(numeric));
}

export function normalizePayrollAccount(raw = {}, personId = "") {
  return {
    personId: text(personId),
    arrearsCopper: wholeCopper(raw?.arrearsCopper),
    overdueTendays: wholeCopper(raw?.overdueTendays),
    lastDueCopper: wholeCopper(raw?.lastDueCopper),
    lastPaidCopper: wholeCopper(raw?.lastPaidCopper),
    totalDueCopper: wholeCopper(raw?.totalDueCopper),
    totalPaidCopper: wholeCopper(raw?.totalPaidCopper)
  };
}

export function normalizePayrollState(raw = {}) {
  const accountsSource = raw?.accounts && typeof raw.accounts === "object" && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  const accounts = {};
  const accountEntries = Object.entries(accountsSource)
    .map(([rawPersonId, account]) => ({ personId: text(rawPersonId), account }))
    .filter((entry) => entry.personId)
    .sort((left, right) => left.personId.localeCompare(right.personId, "ru"));
  for (const { personId, account } of accountEntries) {
    accounts[personId] = normalizePayrollAccount(account, personId);
  }
  const receipts = Array.isArray(raw?.receipts)
    ? raw.receipts
      .map((receipt) => ({
        operationId: text(receipt?.operationId),
        requestHash: text(receipt?.requestHash),
        dueCopper: wholeCopper(receipt?.dueCopper),
        paidCopper: wholeCopper(receipt?.paidCopper),
        arrearsCopper: wholeCopper(receipt?.arrearsCopper),
        treasuryBeforeCopper: wholeCopper(receipt?.treasuryBeforeCopper),
        treasuryAfterCopper: wholeCopper(receipt?.treasuryAfterCopper),
        rows: Array.isArray(receipt?.rows) ? receipt.rows.map((row) => ({
          personId: text(row?.personId),
          dueCopper: wholeCopper(row?.dueCopper),
          paidCopper: wholeCopper(row?.paidCopper),
          arrearsCopper: wholeCopper(row?.arrearsCopper),
          overdueTendays: wholeCopper(row?.overdueTendays)
        })).filter((row) => row.personId) : []
      }))
      .filter((receipt) => receipt.operationId)
      .slice(-MAX_PAYROLL_OPERATION_RECEIPTS)
    : [];
  return { version: PAYROLL_STATE_VERSION, accounts, receipts };
}
