function requireDependencies(dependencies = {}) {
  const required = [
    "safeNumber",
    "normalizeStorageRoomId",
    "storageResourceIdentity",
    "isMoneyResource",
    "storageQuantity",
    "storageAdd",
    "storageAddWithOverflow",
    "storageRoomLabel",
    "formatNumber"
  ];
  for (const name of required) {
    if (typeof dependencies[name] !== "function") throw new TypeError(`event effect executor requires dependencies.${name}`);
  }
  return dependencies;
}

function ensureHoldingBranches(holding = {}) {
  if (!holding.overview || typeof holding.overview !== "object") holding.overview = {};
  if (!holding.overview.development || typeof holding.overview.development !== "object") holding.overview.development = {};
  if (!holding.gm || typeof holding.gm !== "object") holding.gm = {};
  if (!holding.gm.modifiers || typeof holding.gm.modifiers !== "object") holding.gm.modifiers = {};
  if (!holding.storage || typeof holding.storage !== "object") holding.storage = {};
  if (!Array.isArray(holding.storage.resources)) holding.storage.resources = [];
}

function labelForKey(key = "") {
  return ({ food: "Еда", technology: "Технологии", culture: "Культура", war: "Война", defense: "Оборона", reputation: "Репутация", morale: "Мораль" })[key] ?? key;
}

function signed(value, formatNumber) {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

export function applyRandomEventEffects({ holding, effects = [], dependencies } = {}) {
  const deps = requireDependencies(dependencies);
  ensureHoldingBranches(holding);
  const changes = [];
  const effectRows = Array.isArray(effects) ? effects : [];

  let moneySpend = effectRows
    .filter((effect) => String(effect?.type ?? "") === "money")
    .reduce((sum, effect) => sum + Math.min(0, deps.safeNumber(effect?.amount, 0)), 0);
  const resourceSpends = new Map();
  for (const effect of effectRows) {
    if (String(effect?.type ?? "") !== "resource" || deps.safeNumber(effect?.amount, 0) >= 0) continue;
    const resource = {
      resourceId: String(effect?.resourceId ?? "custom") || "custom",
      name: String(effect?.name ?? "").trim(),
      roomId: deps.normalizeStorageRoomId(effect?.roomId ?? "outdoors")
    };
    if (deps.isMoneyResource(resource)) {
      moneySpend += deps.safeNumber(effect.amount, 0);
      continue;
    }
    const identity = deps.storageResourceIdentity(resource);
    const key = JSON.stringify([identity.id, identity.name, resource.roomId]);
    const requested = (resourceSpends.get(key)?.requested ?? 0) + Math.abs(deps.safeNumber(effect.amount, 0));
    resourceSpends.set(key, { resource, requested });
  }
  const treasury = Math.max(0, deps.safeNumber(holding.storage.moneyCopper, 0));
  if (treasury + moneySpend < -0.0001) {
    return { ok: false, changes: [], message: `В казне недостаточно денег: доступно ${deps.formatNumber(treasury)} медных.` };
  }
  for (const { resource, requested } of resourceSpends.values()) {
    const available = Math.max(0, deps.storageQuantity(holding, resource));
    if (available + 0.0001 < requested) {
      const label = resource.resourceId === "custom" ? (resource.name || "Ресурс") : (resource.name || resource.resourceId);
      return { ok: false, changes: [], message: `${label}: недостаточно в «${deps.storageRoomLabel(holding, resource.roomId)}» (${deps.formatNumber(available)}).` };
    }
  }

  for (const effect of effectRows) {
    const type = String(effect?.type ?? "");
    const amount = deps.safeNumber(effect?.amount, 0);
    if (!amount) continue;

    if (type === "money") {
      const before = Math.max(0, deps.safeNumber(holding.storage.moneyCopper, 0));
      const after = before + amount;
      if (after < -0.0001) return { ok: false, changes, message: `В казне недостаточно денег: нужно ${deps.formatNumber(Math.abs(amount))} медных.` };
      holding.storage.moneyCopper = Math.max(0, Math.floor(after));
      changes.push({ type, amount, before, after: holding.storage.moneyCopper, text: `Казна: ${signed(amount, deps.formatNumber)} медных` });
      continue;
    }

    if (type === "development") {
      const key = ["food", "technology", "culture", "war"].includes(String(effect?.key ?? "")) ? String(effect.key) : "food";
      const before = deps.safeNumber(holding.overview.development[key], 0);
      const after = Math.max(0, before + amount);
      holding.overview.development[key] = after;
      changes.push({ type, key, amount: after - before, before, after, text: `${labelForKey(key)}: ${signed(after - before, deps.formatNumber)}` });
      continue;
    }

    if (type === "modifier") {
      const key = ["food", "technology", "culture", "war", "defense", "reputation", "morale"].includes(String(effect?.key ?? "")) ? String(effect.key) : "morale";
      const before = deps.safeNumber(holding.gm.modifiers[key], 0);
      const after = before + amount;
      holding.gm.modifiers[key] = after;
      changes.push({ type, key, amount, before, after, text: `Модификатор «${labelForKey(key)}»: ${signed(amount, deps.formatNumber)}` });
      continue;
    }

    if (type === "resource") {
      const roomId = deps.normalizeStorageRoomId(effect?.roomId ?? "outdoors");
      const resource = {
        resourceId: String(effect?.resourceId ?? "custom") || "custom",
        name: String(effect?.name ?? "").trim(),
        roomId
      };
      const label = resource.resourceId === "custom" ? (resource.name || "Ресурс") : (resource.name || resource.resourceId);
      if (amount < 0) {
        const available = Math.max(0, deps.storageQuantity(holding, resource));
        if (available + 0.0001 < Math.abs(amount)) {
          return { ok: false, changes, message: `${label}: недостаточно в «${deps.storageRoomLabel(holding, roomId)}» (${deps.formatNumber(available)}).` };
        }
        deps.storageAdd(holding, resource, amount);
        changes.push({ type, resourceId: resource.resourceId, name: resource.name, roomId, amount, text: `${label}: ${signed(amount, deps.formatNumber)} · ${deps.storageRoomLabel(holding, roomId)}` });
      } else {
        const placements = deps.storageAddWithOverflow(holding, resource, amount);
        changes.push({
          type,
          resourceId: resource.resourceId,
          name: resource.name,
          roomId,
          amount,
          placements,
          text: `${label}: ${signed(amount, deps.formatNumber)} → ${placements.map((row) => deps.storageRoomLabel(holding, row.roomId)).join(", ")}`
        });
      }
    }
  }

  if (!changes.length) return { ok: false, changes: [], message: "У события нет ненулевых эффектов." };
  return { ok: true, changes, message: `Подготовлено эффектов: ${changes.length}.` };
}
