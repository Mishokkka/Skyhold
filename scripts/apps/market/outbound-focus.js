/** Focus a referenced sale without changing the current market or shopping drafts. */
export function focusMarketOutboundOrder(root, orderId) {
  const row = orderId ? [...(root?.querySelectorAll?.("[data-market-outbound-order]") ?? [])]
    .find((node) => node.dataset.marketOutboundOrder === String(orderId))
    : root?.querySelector?.("[data-market-outbound-section]");
  if (!row) return false;
  for (let parent = row.parentElement; parent && root.contains(parent); parent = parent.parentElement) {
    if (parent.tagName === "DETAILS") parent.open = true;
  }
  row.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  row.focus?.({ preventScroll: true });
  return true;
}
