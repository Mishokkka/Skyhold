function searchDependencies(dependencies = {}) {
  for (const name of ["safeNumber", "itemQuantity", "normalizeRoomId", "roomLabel", "resourceLabel"]) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`FBL Skyhold | Storage search requires dependency "${name}".`);
  }
  return dependencies;
}

export function buildStorageSearchRows({ resources = [], items = [], dependencies = {} } = {}) {
  const deps = searchDependencies(dependencies);
  const rows = [];
  resources.forEach((resource, index) => {
    const qty = deps.safeNumber(resource?.qty, 0);
    if (Math.abs(qty) < 0.0001) return;
    const roomId = deps.normalizeRoomId(resource?.roomId ?? resource?.storageRoomId);
    const title = deps.resourceLabel(resource);
    const roomLabel = deps.roomLabel(roomId);
    rows.push({
      kind: "resource",
      subtab: "resources",
      id: String(resource?.id ?? ""),
      index,
      roomId,
      title,
      roomLabel,
      meta: `${qty} ${String(resource?.unit ?? "").trim()}`.trim(),
      icon: "fa-solid fa-cubes-stacked",
      search: [title, resource?.resourceId, resource?.name, resource?.category, resource?.notes, roomLabel].map((value) => String(value ?? "")).join(" ").toLocaleLowerCase("ru")
    });
  });
  items.forEach((item, index) => {
    const qty = deps.itemQuantity(item);
    if (qty <= 0) return;
    const roomId = deps.normalizeRoomId(item?.roomId ?? item?.storageRoomId);
    const title = String(item?.name ?? item?.itemData?.name ?? "Предмет");
    const roomLabel = deps.roomLabel(roomId);
    rows.push({
      kind: "item",
      subtab: "items",
      id: String(item?.id ?? ""),
      index,
      roomId,
      title,
      roomLabel,
      meta: `${qty} · ${String(item?.type ?? item?.itemData?.type ?? "предмет")}`,
      icon: "fa-solid fa-suitcase",
      search: [title, item?.type, item?.itemData?.type, item?.description, item?.notes, roomLabel].map((value) => String(value ?? "")).join(" ").toLocaleLowerCase("ru")
    });
  });
  return rows.sort((a, b) => a.title.localeCompare(b.title, "ru") || a.roomLabel.localeCompare(b.roomLabel, "ru"));
}
