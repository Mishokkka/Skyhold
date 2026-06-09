import { normalizeResourceId, resourceLabel } from "../core/resources.js";

export function parseResourceCosts(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tail = part.match(/^(.*?)([-+]?\d+(?:[.,]\d+)?)\s*$/);
      const head = part.match(/^([-+]?\d+(?:[.,]\d+)?)\s+(.+)$/);
      let name = part;
      let qty = 1;
      if (tail && tail[1].trim()) {
        name = tail[1].trim();
        qty = Number(String(tail[2]).replace(",", "."));
      } else if (head) {
        qty = Number(String(head[1]).replace(",", "."));
        name = head[2].trim();
      }
      if (!Number.isFinite(qty)) qty = 1;
      const resourceId = normalizeResourceId(name);
      return { resourceId, name: resourceId === "custom" ? name : resourceLabel(resourceId), qty: Math.max(0, qty) };
    })
    .filter((item) => item.name && item.qty > 0);
}
