function text(value = "") {
  return String(value ?? "").trim();
}

function quantity(row = {}) {
  const numeric = Number(row?.qty ?? row?.quantity ?? row?.system?.quantity ?? row?.itemData?.system?.quantity ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export function buildingDeletionBlocker(building = {}) {
  const reservation = building?.constructionReservation;
  const reservationStatus = text(reservation?.status).toLowerCase();
  if (reservation && typeof reservation === "object" && reservationStatus !== "consumed") {
    return {
      ok: false,
      code: "active-construction-reservation",
      message: "Нельзя удалить здание с активной строительной резервацией: сначала заверши или отдельно отмени проект."
    };
  }
  return { ok: true };
}

export function deleteBuildingWithStorageLifecycle(holding = {}, buildingId = "", {
  releaseWorker = null,
  appendStorageLog = null
} = {}) {
  const id = text(buildingId);
  const buildings = Array.isArray(holding?.buildings?.list) ? holding.buildings.list : [];
  const index = buildings.findIndex((row) => text(row?.id) === id);
  if (index < 0) return { ok: false, code: "building-not-found", message: "Здание не найдено." };
  const building = buildings[index];
  const blocked = buildingDeletionBlocker(building);
  if (!blocked.ok) return blocked;

  const name = text(building?.name) || "Здание";
  const assignedIds = new Set((Array.isArray(building?.assignedWorkerIds) ? building.assignedWorkerIds : [])
    .map(text)
    .filter(Boolean));
  for (const person of holding?.people?.list ?? []) {
    const assignment = text(person?.workAssignment);
    const personId = text(person?.id);
    if (personId && (assignment === id || assignment === name)) assignedIds.add(personId);
  }
  let releasedWorkers = 0;
  for (const personId of assignedIds) {
    if (typeof releaseWorker === "function") releaseWorker(holding, personId);
    else {
      const person = (holding?.people?.list ?? []).find((row) => text(row?.id) === personId);
      if (person) {
        person.workAssignment = "";
        person.role = "Свободен";
      }
    }
    releasedWorkers += 1;
  }

  let clearedHomes = 0;
  for (const person of holding?.people?.list ?? []) {
    const home = text(person?.home);
    if (home !== id && home !== name) continue;
    person.home = "";
    clearedHomes += 1;
  }

  const logEntries = [];
  let movedResources = 0;
  let movedItems = 0;
  for (const row of holding?.storage?.resources ?? []) {
    if (text(row?.roomId ?? row?.storageRoomId) !== id) continue;
    row.roomId = "outdoors";
    movedResources += 1;
    logEntries.push({
      kind: "move-in",
      resourceId: row?.resourceId ?? "custom",
      name: row?.name ?? row?.resourceId ?? "Ресурс",
      qty: quantity(row),
      roomId: "outdoors",
      source: `Удаление «${name}»`,
      note: `аварийный перенос из удалённого хранилища ${id}`
    });
  }
  for (const row of holding?.storage?.items ?? []) {
    if (text(row?.roomId ?? row?.storageRoomId) !== id) continue;
    row.roomId = "outdoors";
    movedItems += 1;
    logEntries.push({
      kind: "move-in",
      resourceId: "custom",
      name: row?.name ?? "Предмет",
      qty: quantity(row),
      roomId: "outdoors",
      source: `Удаление «${name}»`,
      note: `предмет перенесён из удалённого хранилища ${id}`
    });
  }
  if (logEntries.length && typeof appendStorageLog === "function") appendStorageLog(holding, logEntries);

  buildings.splice(index, 1);
  return {
    ok: true,
    buildingId: id,
    buildingName: name,
    movedResources,
    movedItems,
    releasedWorkers,
    clearedHomes,
    logEntries
  };
}
