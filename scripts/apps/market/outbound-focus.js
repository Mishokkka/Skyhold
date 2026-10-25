/** Open and focus a sale or its composer; return false when that exact target is absent. */
export function focusMarketOutboundOrder(root, orderId) {
  const row = orderId ? [...(root?.querySelectorAll?.("[data-market-outbound-order]") ?? [])]
    .find((node) => node.dataset.marketOutboundOrder === String(orderId))
    : root?.querySelector?.("[data-market-outbound-compose]");
  if (!row) return false;
  if (row.tagName === "DETAILS") row.open = true;
  for (let parent = row.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
  row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  row.focus?.({ preventScroll: true });
  return true;
}
