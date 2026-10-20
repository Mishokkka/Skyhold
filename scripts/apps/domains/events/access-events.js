// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { isPlayerWritablePath } from "../../../data/player-write-guard.js";
import { findReadableHoldingEntry } from "../../../data/access-guard.js";
import { holdingPermissionContext } from "../../../data/holding-permissions.js";

export const AccessEventDomain = {
_canEditBuildings() {
  return this._activeHoldingPermissionContext().canEditBuildings;
},

_canUseStorage() {
  return this._activeHoldingPermissionContext().canUseStorage;
},

_canPlayerWriteFieldPath(path = "") {
  if (game.user?.isGM) return true;
  if (!this._activeHoldingPermissionContext().writeAvailable) return false;
  const text = String(path ?? "");
  const data = SkyholdData.get();
  const scopedPath = text.startsWith("holdings.") ? this._resolveActiveHoldingScopedPath?.(data, text) : text;
  return Boolean(scopedPath) && isPlayerWritablePath(scopedPath, data, data);
},

_activeHoldingForAccess() {
  const data = SkyholdData.get();
  return findReadableHoldingEntry(data, this.activeHoldingId, { fallback: false }).holding;
},

_activeHoldingPermissionContext() {
  return holdingPermissionContext(this._activeHoldingForAccess?.());
},

_canManagePeople() {
  return this._activeHoldingPermissionContext().canEditResidents;
},

_canManageDefense() {
  return this._activeHoldingPermissionContext().canEditDefense;
},

_canEditSpecialNotes() {
  return this._activeHoldingPermissionContext().canEditSpecial;
},

_canEditBattleDefenders() {
  return this._activeHoldingPermissionContext().canEditBattleSetup;
}
};
