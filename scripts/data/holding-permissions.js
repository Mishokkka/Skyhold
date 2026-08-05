import { canReadHolding } from "./access-guard.js";
import { getSkyholdAuthorityState } from "./authority.js";

function grantedPlayerPermission(holding, key, readable) {
  return Boolean(readable && holding?.gm?.[key] === true);
}

function authorityStatus(authority, { isGM, hasGrantedPlayerWrites } = {}) {
  if (isGM) {
    if (authority?.writeAvailable === false) {
      return {
        show: true,
        severity: "readonly",
        icon: "fa-solid fa-user-lock",
        label: "Другой GM сохраняет изменения",
        detail: authority?.activeGmName
          ? `Единственным writer выбран ${authority.activeGmName}. Эта GM-сессия доступна только для чтения, чтобы не повредить данные мира.`
          : "Эта GM-сессия доступна только для чтения, чтобы не допустить конкурентную запись в данные мира."
      };
    }
    return {
      show: false,
      severity: "gm",
      icon: "fa-solid fa-crown",
      label: "Запись выполняется локально",
      detail: "Текущий пользователь является GM."
    };
  }
  if (!hasGrantedPlayerWrites) {
    return {
      show: true,
      severity: "readonly",
      icon: "fa-solid fa-eye",
      label: "Режим чтения",
      detail: "Для этого владения игрокам не выданы права на изменения."
    };
  }
  if (authority.writeAvailable) {
    return {
      show: false,
      severity: "online",
      icon: "fa-solid fa-link",
      label: "Запись доступна",
      detail: "Доступные игроку изменения будут проверены и сохранены активным GM."
    };
  }
  return {
    show: true,
    severity: "offline",
    icon: "fa-solid fa-link-slash",
    label: "Запись временно недоступна",
    detail: authority.socketAvailable
      ? "В мире нет активного GM. Разрешённые действия доступны только для чтения."
      : "Socket Foundry недоступен. Разрешённые действия доступны только для чтения."
  };
}

export function holdingPermissionContext(holding, {
  user = globalThis.game?.user,
  authority = getSkyholdAuthorityState({ user })
} = {}) {
  const isGM = Boolean(user?.isGM);
  const canView = Boolean(holding && canReadHolding(holding, user));
  const mayEditOverview = isGM || grantedPlayerPermission(holding, "playersCanEditOverview", canView);
  const mayEditBuildings = isGM || grantedPlayerPermission(holding, "playersCanEditBuildings", canView);
  const mayUseStorage = isGM || grantedPlayerPermission(holding, "playersCanUseStorage", canView);
  const mayEditResidents = isGM || grantedPlayerPermission(holding, "playersCanEditResidents", canView);
  const mayEditDefense = isGM || grantedPlayerPermission(holding, "playersCanEditDefense", canView);
  const mayEditBattleSetup = isGM || grantedPlayerPermission(holding, "playersCanEditBattle", canView);
  const mayEditSpecial = isGM || grantedPlayerPermission(holding, "playersCanEditSpecial", canView);
  const mayManageMarkets = isGM || grantedPlayerPermission(holding, "playersCanManageMarkets", canView);
  const writeAvailable = Boolean(authority?.writeAvailable);
  const hasGrantedPlayerWrites = !isGM && [
    mayEditOverview,
    mayEditBuildings,
    mayUseStorage,
    mayEditResidents,
    mayEditDefense,
    mayEditBattleSetup,
    mayEditSpecial,
    mayManageMarkets
  ].some(Boolean);

  return {
    isGM,
    canView,
    authority,
    authorityStatus: authorityStatus(authority, { isGM, hasGrantedPlayerWrites }),
    writeAvailable,
    requiresActiveGm: !isGM && hasGrantedPlayerWrites,
    hasGrantedPlayerWrites,
    mayEditOverview,
    mayEditBuildings,
    mayUseStorage,
    mayEditResidents,
    mayEditDefense,
    mayEditBattleSetup,
    mayEditSpecial,
    mayManageMarkets,
    canEditOverview: mayEditOverview && writeAvailable,
    canEditBuildings: mayEditBuildings && writeAvailable,
    canUseStorage: mayUseStorage && writeAvailable,
    canEditResidents: mayEditResidents && writeAvailable,
    canEditDefense: mayEditDefense && writeAvailable,
    canEditBattleSetup: mayEditBattleSetup && writeAvailable,
    canResolveBattle: isGM && writeAvailable,
    canEditSpecial: mayEditSpecial && writeAvailable,
    canManageMarkets: mayManageMarkets && writeAvailable
  };
}
