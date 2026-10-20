const ARMAMENT_SUPPLY = Object.freeze({
  "armament-simple": "military-supplies-simple",
  "armament-complex": "military-supplies-complex",
  "armament-elite": "military-supplies-complex"
});

function text(value = "") {
  return String(value ?? "").trim();
}

function whole(value) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

export function militarySupplyResourceForArmament(resourceId = "") {
  return ARMAMENT_SUPPLY[text(resourceId)] ?? "";
}

function directResourceQuantity(holding = {}, resourceId = "") {
  return (holding?.storage?.resources ?? []).reduce((sum, row) => (
    text(row?.resourceId) === resourceId ? sum + whole(row?.qty) : sum
  ), 0);
}

export function prepareDefenderMilitarySupplyPlan(holding = {}, state = {}, participantSquadIds = [], {
  resourceQuantity = null
} = {}) {
  const battleId = text(state?.battleId);
  if (!battleId) return { planned: false, suppliedSquadIds: [], unsuppliedSquadIds: [], costs: [] };
  if (text(state?.militarySupplyBattleId) === battleId) {
    return {
      planned: false,
      suppliedSquadIds: [...(state.militarySuppliedSquadIds ?? [])],
      unsuppliedSquadIds: [...(state.militaryUnsuppliedSquadIds ?? [])],
      costs: [...(state.militarySupplyCosts ?? [])]
    };
  }

  const squads = new Map((holding?.gm?.defense?.squads ?? []).map((squad) => [text(squad?.id), squad]));
  const remaining = new Map();
  const available = (resourceId) => {
    if (!remaining.has(resourceId)) {
      const qty = typeof resourceQuantity === "function"
        ? resourceQuantity(holding, resourceId)
        : directResourceQuantity(holding, resourceId);
      remaining.set(resourceId, whole(qty));
    }
    return remaining.get(resourceId);
  };
  const suppliedSquadIds = [];
  const unsuppliedSquadIds = [];
  const costMap = new Map();
  for (const rawId of participantSquadIds ?? []) {
    const squadId = text(rawId);
    const squad = squads.get(squadId);
    const resourceId = militarySupplyResourceForArmament(squad?.armamentResourceId);
    if (!resourceId || available(resourceId) <= 0) {
      if (squadId) unsuppliedSquadIds.push(squadId);
      continue;
    }
    remaining.set(resourceId, available(resourceId) - 1);
    suppliedSquadIds.push(squadId);
    costMap.set(resourceId, (costMap.get(resourceId) ?? 0) + 1);
  }
  const costs = [...costMap.entries()].map(([resourceId, qty]) => ({ resourceId, qty }));
  state.militarySupplyBattleId = battleId;
  state.militarySuppliedSquadIds = suppliedSquadIds;
  state.militaryUnsuppliedSquadIds = unsuppliedSquadIds;
  state.militarySupplyCosts = costs;
  state.militarySuppliesConsumed = false;
  return { planned: true, suppliedSquadIds, unsuppliedSquadIds, costs };
}

export function consumeDefenderMilitarySupplies(holding = {}, state = {}, {
  consumeResource = null
} = {}) {
  const battleId = text(state?.battleId);
  if (!battleId || text(state?.militarySupplyBattleId) !== battleId) return { ok: true, used: 0, text: "план боеприпасов не задан" };
  if (state.militarySuppliesConsumed === true) return { ok: true, used: 0, duplicate: true, text: "боеприпасы уже выданы на этот бой" };
  const costs = Array.isArray(state?.militarySupplyCosts) ? state.militarySupplyCosts : [];
  let used = 0;
  for (const cost of costs) {
    const resourceId = text(cost?.resourceId);
    const qty = whole(cost?.qty);
    if (!resourceId || !qty) continue;
    if (typeof consumeResource !== "function" || consumeResource(holding, resourceId, qty, `Бой ${battleId}: боеприпасы отрядов`) !== true) {
      return { ok: false, used, resourceId, qty, text: `не удалось списать ${qty} ${resourceId}` };
    }
    used += qty;
  }
  state.militarySuppliesConsumed = true;
  return {
    ok: true,
    used,
    text: used > 0
      ? `на бой выдано ${used} ед. военных припасов`
      : "участвующие отряды остались без военных припасов"
  };
}
