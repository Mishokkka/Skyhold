/** Ephemeral views keep one shared balance while respecting each job's overtime rule. */
export function staffBudgetView(entry, functionId = "", overtimeAllowed = false) {
  if (!entry?.staff) return entry;
  return {
    get available() {
      const allowed = (entry.tokens ?? []).reduce((sum, token) => sum + (overtimeAllowed || !token.overtime ? token.qd : 0), 0);
      return Math.max(0, Math.min(entry.available, allowed));
    },
    set available(value) { entry.available = Math.max(0, entry.available - (this.available - value)); },
    get spent() { return entry.spent; },
    set spent(value) { entry.spent = value; },
    get tokens() { return entry.tokens; },
    get workerId() { return entry.workerId; },
    get sourceId() { return entry.sourceId; },
    get limit() { return entry.limit; },
    functionId: "staff",
    selectedFunctionId: functionId,
    overtimeAllowed,
    staff: true
  };
}

export function appendStaffWork(context, workerId, sourceId, functionId, qd, step, overtime = false) {
  if (!context || !workerId || !sourceId || !functionId || !(qd > 0)) return;
  const rows = context.staffWorkByWorkerId.get(workerId) ?? [];
  let row = rows.find((value) => value.sourceId === sourceId && value.functionId === functionId);
  if (!row) {
    row = { sourceId, functionId, normalQd: 0, overtimeQd: 0 };
    rows.push(row);
    context.staffWorkByWorkerId.set(workerId, rows);
  }
  row[overtime ? "overtimeQd" : "normalQd"] += qd;
  const event = { workerId, sourceId, functionId, normalQd: overtime ? 0 : qd, overtimeQd: overtime ? qd : 0, step };
  context.staffWorkLedger.push(event);
  context.plannedWorkSlotsByWorkerId.get(workerId)?.set(step, { sourceId, functionId, overtime });
}

export function recordStaffWork(context, entry, functionId, qd) {
  if (!entry?.staff || !context) return;
  let remaining = Math.max(0, Number(qd) || 0);
  for (const token of entry.tokens ?? []) {
    if (!(remaining > 0)) break;
    if (token.overtime && entry.overtimeAllowed !== true) continue;
    const taken = Math.min(remaining, token.qd);
    if (!(taken > 0)) continue;
    token.qd -= taken;
    remaining -= taken;
    appendStaffWork(context, entry.workerId, entry.sourceId, functionId, taken, token.step, token.overtime);
  }
  if (remaining > 0.0001) throw new Error("FBL Skyhold | Staff work exceeds its funded time.");
}
