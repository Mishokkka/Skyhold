/** Presentation-only folders. Region IDs, geography and links are untouched. */
export const regionFolderName = (value) => String(value ?? "").trim().slice(0, 120);

export function regionCatalogGroups(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const name = regionFolderName(row.catalogFolder);
    if (!groups.has(name)) groups.set(name, { name, label: name || "Без папки", key: `region-folder:${name}`, rows: [] });
    groups.get(name).rows.push(row);
  }
  return [...groups.values()].map((group, index) => ({ ...group, canMoveUp: index > 0, canMoveDown: index < groups.size - 1,
    rows: group.rows.map((row, position) => ({ ...row, canMoveUp: position > 0, canMoveDown: position < group.rows.length - 1 })) }));
}

export function moveCatalogRegion(rows, id, delta) {
  const source = rows.findIndex((row) => row.value === id);
  if (source < 0) return false;
  const peers = rows.map((row, index) => ({ row, index })).filter(({ row }) => regionFolderName(row.catalogFolder) === regionFolderName(rows[source].catalogFolder));
  const next = peers[peers.findIndex(({ index }) => index === source) + Math.sign(delta)];
  if (!next || !delta) return false;
  [rows[source], rows[next.index]] = [rows[next.index], rows[source]];
  return true;
}

export function moveCatalogFolder(rows, name, delta) {
  const groups = regionCatalogGroups(rows), index = groups.findIndex((group) => group.name === name), next = index + Math.sign(delta);
  if (index < 0 || next < 0 || next >= groups.length || !delta) return false;
  [groups[index], groups[next]] = [groups[next], groups[index]];
  const byId = new Map(rows.map((row) => [row.value, row]));
  rows.splice(0, rows.length, ...groups.flatMap((group) => group.rows.map((row) => byId.get(row.value))));
  return true;
}

export function placeCatalogRegion(rows, id, { beforeId = "", folder = "" } = {}) {
  const source = rows.findIndex((row) => row.value === id);
  if (source < 0 || beforeId === id) return false;
  const target = beforeId ? rows.find((row) => row.value === beforeId) : null;
  if (beforeId && !target) return false;
  const folders = new Map([...new Set(rows.map((row) => regionFolderName(row.catalogFolder)))].map((name, index) => [name, index]));
  const [row] = rows.splice(source, 1), name = regionFolderName(target ? target.catalogFolder : folder);
  if (name) row.catalogFolder = name; else delete row.catalogFolder;
  const lastPeer = rows.findLastIndex((peer) => regionFolderName(peer.catalogFolder) === name);
  const index = target ? rows.indexOf(target) : lastPeer < 0 ? rows.length : lastPeer + 1;
  rows.splice(index, 0, row);
  // Moving a folder's first child must not reorder its remaining children as a group.
  rows.sort((a, b) => (folders.get(regionFolderName(a.catalogFolder)) ?? folders.size)
    - (folders.get(regionFolderName(b.catalogFolder)) ?? folders.size));
  return true;
}
