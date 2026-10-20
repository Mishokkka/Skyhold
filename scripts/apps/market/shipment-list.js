/** All blocked decisions remain reachable, even when the ordinary list is full. */
export function visibleActiveShipments(orders, limit) {
  const waiting = orders.filter((order) => order.status === "needsResolution");
  const ordinary = orders.filter((order) => order.status !== "needsResolution");
  return [...waiting, ...ordinary.slice(0, Math.max(0, limit - waiting.length))];
}
