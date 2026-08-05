export function makeId(prefix = "id", length = 10) {
  const requested = Number(length);
  const size = Math.max(1, Math.floor(Number.isFinite(requested) ? requested : 10));
  const randomPart = globalThis.foundry?.utils?.randomID?.(size)
    ?? Array.from({ length: size }, () => Math.floor(Math.random() * 36).toString(36)).join("");
  return `${prefix}-${randomPart}`;
}
