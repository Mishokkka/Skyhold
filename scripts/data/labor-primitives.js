function whole(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

export function allocationNormalQd(row) {
  return whole(row?.normalQd ?? row?.plannedNormalQd ?? row?.qd);
}

export function allocationTotalQd(row) {
  return allocationNormalQd(row) + whole(row?.overtimeQd ?? row?.plannedOvertimeQd);
}

export function residentActiveQd(person) {
  const rows = person?.workAllocations;
  return Array.isArray(rows) ? rows.reduce((total, row) => total + allocationTotalQd(row), 0) : 0;
}
