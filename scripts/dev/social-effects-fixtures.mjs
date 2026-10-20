// Explicit completed-work evidence for tests whose subject is downstream UI or pooling.
export function confirmSocialWork(holding, building, ids, qdPerWorker = 20, functionId = "culture") {
  holding.gm ??= {};
  holding.gm.calendaria = { ...holding.gm.calendaria, lastQd: 40 };
  building.assignedWorkerIds = [...ids];
  building.serviceState = {
    periodKey: "tenday:1", functionId, active: true, meaningfulResult: true,
    activeWorkerIds: [...ids], activeWorkerIdsByFunction: { [functionId]: [...ids] },
    workedQd: ids.length * qdPerWorker, workedQdByFunction: { [functionId]: ids.length * qdPerWorker },
    workedQdByWorkerAndFunction: Object.fromEntries(ids.map((id) => [id, { [functionId]: qdPerWorker }]))
  };
}
