function timestamp(value = "") {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateText(value = "") {
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString("ru-RU");
}

function operationIcon(type = "") {
  if (type === "worker-assignment") return "fa-solid fa-people-arrows";
  if (type === "event-effect") return "fa-solid fa-wand-magic-sparkles";
  if (type === "event-schedule") return "fa-solid fa-calendar-days";
  if (type === "battle") return "fa-solid fa-shield-halved";
  if (type === "storage") return "fa-solid fa-boxes-stacked";
  if (type === "content-import") return "fa-solid fa-file-import";
  if (type === "market-purchase") return "fa-solid fa-store";
  if (type === "market-export") return "fa-solid fa-arrow-up-from-bracket";
  if (type === "tenday") return "fa-solid fa-calendar-check";
  return "fa-solid fa-clock-rotate-left";
}

export function buildHoldingOperationTimeline(holding = {}, { limit = 80 } = {}) {
  const rows = [];
  const summarizedOperationIds = new Set();
  for (const entry of holding?.log ?? []) {
    const operationId = String(entry?.operationId ?? entry?.id ?? "");
    if (operationId) summarizedOperationIds.add(operationId);
    rows.push({
      id: operationId,
      type: String(entry?.type ?? "system"),
      title: String(entry?.title ?? "Операция"),
      summary: String(entry?.summary ?? ""),
      createdAt: String(entry?.createdAt ?? ""),
      source: "operations",
      canOpenTenday: String(entry?.type ?? "") === "tenday" && Number(entry?.payload?.schema) >= 1
    });
  }
  for (const entry of (holding?.storage?.log ?? []).slice(-60)) {
    const operationId = String(entry?.operationId ?? "");
    if (operationId && summarizedOperationIds.has(operationId)) continue;
    const qty = Number(entry?.qty) || 0;
    rows.push({
      id: String(entry?.operationId ?? entry?.id ?? ""),
      type: "storage",
      title: String(entry?.source || entry?.name || "Хранилище"),
      summary: `${entry?.name || entry?.resourceId || "Ресурс"}: ${qty > 0 ? "+" : ""}${qty}${entry?.note ? ` · ${entry.note}` : ""}`,
      createdAt: String(entry?.ts ?? entry?.at ?? ""),
      source: "storage"
    });
  }
  for (const entry of holding?.gm?.massCombat?.archive ?? []) {
    rows.push({
      id: String(entry?.id ?? entry?.battleId ?? ""),
      type: "battle",
      title: String(entry?.title ?? "Архив сражения"),
      summary: String(entry?.summary ?? entry?.outcome ?? entry?.reason ?? ""),
      createdAt: String(entry?.createdAt ?? entry?.archivedAt ?? ""),
      source: "battle"
    });
  }
  for (const entry of holding?.gm?.eventArchive ?? []) {
    rows.push({
      id: String(entry?.id ?? ""),
      type: "event-schedule",
      title: String(entry?.title ?? "Событие"),
      summary: `${entry?.statusLabel || "В архиве"}${entry?.dueLabel ? ` · ${entry.dueLabel}` : ""}`,
      createdAt: String(entry?.archivedAt ?? entry?.appliedAt ?? entry?.createdAt ?? ""),
      source: "events"
    });
  }

  const seen = new Set();
  return rows
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .filter((entry) => {
      const key = `${entry.source}:${entry.id}:${entry.title}:${entry.createdAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Number(limit) || 80))
    .map((entry) => ({ ...entry, icon: operationIcon(entry.type), dateText: dateText(entry.createdAt) }));
}
