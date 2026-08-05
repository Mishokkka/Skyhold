function truthy(value) {
  return value === true || Number(value) > 0;
}

export function buildingBattleRoles(building = {}) {
  const roles = new Set((Array.isArray(building.battleRoles) ? building.battleRoles : []).map(String));
  const functions = building.functions && typeof building.functions === "object" ? building.functions : {};
  const defense = building.defense && typeof building.defense === "object" ? building.defense : {};
  const storage = building.storage && typeof building.storage === "object" ? building.storage : {};
  const housing = building.housing && typeof building.housing === "object" ? building.housing : {};
  if (truthy(functions.defense) || truthy(defense.base) || truthy(defense.perStep) || truthy(defense.maxDice)) roles.add("defense");
  if (truthy(functions.storage) || truthy(storage.capacity)) roles.add("storage");
  if (truthy(functions.housing) || truthy(housing.capacity)) roles.add("housing");
  if (truthy(functions.production) || (building.productionLines ?? []).some((line) => line?.active !== false)) roles.add("production");
  if (truthy(functions.income)) roles.add("commerce");
  if (truthy(functions.culture) || building.religion?.religious) roles.add("civic");
  if (building.specialKind === "medical") roles.add("medical");
  return roles;
}

export function battleTargetWeight(building, { attackerStrategy = {}, breachOpen = false } = {}) {
  const roles = buildingBattleRoles(building);
  let weight = 1;
  if (attackerStrategy?.breach && roles.has("defense")) weight += 4;
  if (attackerStrategy?.raid && (roles.has("storage") || roles.has("production") || roles.has("commerce"))) weight += 4;
  if (breachOpen && (roles.has("housing") || roles.has("civic") || roles.has("medical"))) weight += 2;
  if (!attackerStrategy?.breach && !attackerStrategy?.raid && roles.has("defense")) weight += 1;
  return weight;
}

export function weightedBattleTargets(buildings = [], context = {}) {
  const result = [];
  for (const building of buildings) {
    const weight = Math.max(1, Math.round(battleTargetWeight(building, context)));
    for (let index = 0; index < weight; index += 1) result.push(building);
  }
  return result;
}
