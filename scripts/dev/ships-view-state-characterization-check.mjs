import assert from "node:assert/strict";
import { createShipViewState } from "../apps/ships-view-state.js";

function surface(holding = "home", scope = "offer:one") {
  const owner = { dataset: { shipHoldingRoot: holding } };
  const draftScope = { dataset: { shipDraftScope: scope } };
  const nodes = [
    { dataset: { shipDisclosure: "offers:ship" }, open: false },
    { dataset: { shipDraft: "budget" }, value: "100" },
    { dataset: { shipDraft: "style" }, value: "normal" }
  ];
  for (const node of nodes) node.closest = (selector) => {
    if (selector === "[data-ship-holding-root]") return owner;
    if (selector === "[data-ship-draft-scope]") return draftScope;
    if (selector === "[data-ship-disclosure]") return node.dataset.shipDisclosure ? node : null;
    if (selector === "[data-ship-draft]") return node.dataset.shipDraft ? node : null;
    return null;
  };
  const listeners = new Map();
  return {
    nodes, listeners,
    querySelectorAll: (selector) => selector === "[data-ship-disclosure]" ? nodes.slice(0, 1) : nodes.slice(1),
    addEventListener: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    emit: (name, node) => { for (const callback of listeners.get(name) ?? []) callback({ target: node }); }
  };
}

function crewSurface(selected = ["one"]) {
  const owner = { dataset: { shipHoldingRoot: "home" } };
  const draftScope = { dataset: { shipDraftScope: "crew:ship" } };
  const options = ["one", "two", "three"].map((value) => ({ value, selected: selected.includes(value) }));
  const node = { dataset: { shipDraft: "residents" }, multiple: true, options };
  Object.defineProperty(node, "selectedOptions", { get: () => options.filter((option) => option.selected) });
  node.closest = (selector) => selector === "[data-ship-holding-root]" ? owner
    : selector === "[data-ship-draft-scope]" ? draftScope
      : selector === "[data-ship-draft]" ? node : null;
  const listeners = new Map();
  return {
    node, listeners,
    querySelectorAll: (selector) => selector === "[data-ship-draft]" ? [node] : [],
    addEventListener: (name, callback) => listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    emit: (name) => { for (const callback of listeners.get(name) ?? []) callback({ target: node }); }
  };
}

export function checkShipViewStateCharacterization() {
  const state = createShipViewState();
  const first = surface();
  state.bind(first);
  first.nodes[0].open = true;
  first.emit("toggle", first.nodes[0]);
  first.nodes[1].value = "321";
  first.emit("input", first.nodes[1]);
  first.nodes[2].value = "bold";
  first.emit("change", first.nodes[2]);
  const refreshed = surface();
  state.bind(refreshed);
  assert.equal(refreshed.nodes[0].open, true);
  assert.equal(refreshed.nodes[1].value, "321");
  assert.equal(refreshed.nodes[2].value, "bold");
  state.bind(refreshed);
  assert.equal(refreshed.listeners.get("input").length, 1, "Repeated render must not accumulate listeners");
  const otherHolding = surface("elsewhere");
  state.bind(otherHolding);
  assert.equal(otherHolding.nodes[0].open, false);
  assert.equal(otherHolding.nodes[1].value, "100");
  const otherOffer = surface("home", "offer:two");
  state.bind(otherOffer);
  assert.equal(otherOffer.nodes[1].value, "100");
  state.clearOperation({ holdingId: "home", type: "depart", offerId: "two" });
  const failedRetry = surface();
  state.bind(failedRetry);
  assert.equal(failedRetry.nodes[1].value, "321");
  state.clearOperation({ holdingId: "home", type: "depart", offerId: "one" });
  const afterSuccess = surface();
  state.bind(afterSuccess);
  assert.equal(afterSuccess.nodes[1].value, "100");
  assert.equal(afterSuccess.nodes[0].open, true);

  const crew = crewSurface(["one"]);
  state.bind(crew);
  crew.node.options[0].selected = false;
  crew.node.options[1].selected = true;
  crew.node.options[2].selected = true;
  crew.emit("change");
  const refreshedCrew = crewSurface(["one"]);
  state.bind(refreshedCrew);
  assert.deepEqual([...refreshedCrew.node.selectedOptions].map((row) => row.value), ["two", "three"]);
  state.clearOperation({ holdingId: "home", type: "crew", shipId: "ship" });
  const clearedCrew = crewSurface(["one"]);
  state.bind(clearedCrew);
  assert.deepEqual([...clearedCrew.node.selectedOptions].map((row) => row.value), ["one"]);

  const bounded = createShipViewState({ limit: 1 });
  for (const scope of ["offer:old", "offer:new"]) {
    const root = surface("home", scope);
    bounded.bind(root);
    root.nodes[1].value = "999";
    root.emit("input", root.nodes[1]);
  }
  const evicted = surface("home", "offer:old");
  bounded.bind(evicted);
  assert.equal(evicted.nodes[1].value, "100", "Draft cache must stay bounded");
}
