const DEFAULT_LIMIT = 240;

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function holdingId(node) {
  return String(node?.closest?.("[data-ship-holding-root]")?.dataset?.shipHoldingRoot
    ?? node?.closest?.("[data-ship-holding]")?.dataset?.shipHolding ?? "");
}

function disclosureKey(node) {
  const local = String(node?.dataset?.shipDisclosure ?? "");
  const holding = holdingId(node);
  return holding && local ? `${holding}\u0000${local}` : "";
}

function draftKey(node) {
  const field = String(node?.dataset?.shipDraft ?? "");
  const scope = String(node?.closest?.("[data-ship-draft-scope]")?.dataset?.shipDraftScope ?? "");
  const holding = holdingId(node);
  return holding && scope && field ? `${holding}\u0000${scope}\u0000${field}` : "";
}

export function createShipViewState({ limit = DEFAULT_LIMIT } = {}) {
  const disclosure = new Map();
  const drafts = new Map();
  const boundRoots = new WeakSet();
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;

  return {
    bind(root) {
      for (const node of root?.querySelectorAll?.("[data-ship-disclosure]") ?? []) {
        const key = disclosureKey(node);
        if (key && disclosure.has(key)) node.open = disclosure.get(key);
      }
      for (const node of root?.querySelectorAll?.("[data-ship-draft]") ?? []) {
        const key = draftKey(node);
        if (key && drafts.has(key)) {
          if (node.type === "checkbox") node.checked = drafts.get(key) === "true";
          else if (node.multiple && node.options) {
            let selected = [];
            try { selected = JSON.parse(drafts.get(key)); } catch (_error) { selected = []; }
            const values = new Set(Array.isArray(selected) ? selected.map(String) : []);
            for (const option of node.options) option.selected = values.has(String(option.value));
          } else node.value = drafts.get(key);
        }
      }
      if (!root || boundRoots.has(root)) return;
      boundRoots.add(root);
      root?.addEventListener?.("toggle", (event) => {
        const node = event.target?.closest?.("[data-ship-disclosure]");
        const key = disclosureKey(node);
        if (key) boundedSet(disclosure, key, Boolean(node.open), safeLimit);
      }, true);
      const captureDraft = (event) => {
        const node = event.target?.closest?.("[data-ship-draft]");
        const key = draftKey(node);
        if (key) {
          const value = node.type === "checkbox"
            ? String(Boolean(node.checked))
            : node.multiple
            ? JSON.stringify([...(node.selectedOptions ?? [])].map((option) => String(option.value)))
            : String(node.value ?? "");
          boundedSet(drafts, key, value, safeLimit);
        }
      };
      root?.addEventListener?.("input", captureDraft);
      root?.addEventListener?.("change", captureDraft);
    },

    clearOperation(operation = {}) {
      const holding = String(operation.holdingId ?? "");
      if (!holding) return;
      if (["depart-world", "depart-bundle"].includes(operation.type)) {
        const plannerPrefix = `${holding}\u0000bundle:${operation.shipId ?? ""}\u0000`;
        for (const key of drafts.keys()) if (key.startsWith(plannerPrefix)) drafts.delete(key);
      }
      let scope = "";
      if (operation.type === "depart" || operation.type === "depart-world") scope = operation.offerId ? `offer:${operation.offerId}` : `manual:${operation.shipId ?? ""}`;
      if (operation.type === "depart-bundle") {
        for (const offerId of operation.offerIds ?? []) {
          const offerPrefix = `${holding}\u0000offer:${offerId}\u0000`;
          for (const key of drafts.keys()) if (key.startsWith(offerPrefix)) drafts.delete(key);
        }
        scope = `bundle:${operation.shipId ?? ""}`;
      }
      if (operation.type === "adjust") scope = `funds:${operation.shipId || ""}`;
      if (operation.type === "crew") scope = `crew:${operation.shipId ?? ""}`;
      if (!scope) return;
      const prefix = `${holding}\u0000${scope}\u0000`;
      for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key);
    }
  };
}
