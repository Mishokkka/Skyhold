// Explicit completed-work evidence for tests whose subject is downstream UI or pooling.
export function confirmSocialWork(holding, building, ids, qdPerWorker = 20, functionId = "culture") {
  holding.gm ??= {};
  holding.gm.calendaria = { ...holding.gm.calendaria, lastQd: 40 };
  const workerIds = new Set(ids.map((id) => String(id)));
  for (const person of holding?.people?.list ?? []) {
    if (Array.isArray(person.workAllocations)) {
      person.workAllocations = person.workAllocations.filter((row) => !(String(row?.sourceId ?? "") === String(building.id) && String(row?.functionId ?? "") === functionId));
    }
    if (!workerIds.has(String(person?.id ?? ""))) continue;
    if (!Array.isArray(person.workAllocations)) person.workAllocations = [];
    person.workAllocations.push({ id: `social-${person.id}-${building.id}`, sourceId: String(building.id), functionId, normalQd: qdPerWorker, overtimeQd: 0 });
  }
  building.serviceState = {
    periodKey: "tenday:1", functionId, active: true, meaningfulResult: true,
    activeWorkerIds: [...ids], activeWorkerIdsByFunction: { [functionId]: [...ids] },
    workedQd: ids.length * qdPerWorker, workedQdByFunction: { [functionId]: ids.length * qdPerWorker },
    workedQdByWorkerAndFunction: Object.fromEntries(ids.map((id) => [id, { [functionId]: qdPerWorker }]))
  };
}
