// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { createHolding, SkyholdData } from "../../../data/store.js";
import { isPlayerWritablePath } from "../../../data/player-write-guard.js";
import { findReadableHoldingEntry } from "../../../data/access-guard.js";
import { generateResidents } from "../../../generators/resident-generator.js";
import { ageGroupFromAge, normalizeBelief } from "../../../generators/resident-rules.js";
import { SkyholdBuildingEditor, SkyholdCrewEditor } from "../../editors.js";
import { SkyholdMassCombatApp } from "../../mass-combat.js";
import { escapeHtml, fieldValue, joinList, rollD66, rollD6Pool, splitList } from "../../../core/helpers.js";
import { GM_ROLLS, gmRollEntry } from "../../../data/gm-rolls.js";
import { addCalendariaQd, formatCalendariaDateTime, getCalendariaSnapshot, parseCalendariaDateInput, timestampForCalendariaDate } from "../../../integrations/calendaria-bridge.js";

export const AccessEventDomain = {
_canEditBuildings() {
  if (game.user?.isGM) return true;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true });
  return Boolean(holding?.gm?.playersCanEditBuildings === true);
},

_canUseStorage() {
  if (game.user?.isGM) return true;
  const data = SkyholdData.get();
  const { holding } = findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true });
  return Boolean(holding?.gm?.playersCanUseStorage);
},

_canPlayerWriteFieldPath(path = "") {
  if (game.user?.isGM) return true;
  const text = String(path ?? "");
  const data = SkyholdData.get();
  return isPlayerWritablePath(text, data, data);
},

_activeHoldingForAccess() {
  const data = SkyholdData.get();
  return findReadableHoldingEntry(data, this.activeHoldingId, { fallback: true }).holding;
},

_canManagePeople() {
  if (game.user?.isGM) return true;
  const holding = this._activeHoldingForAccess?.();
  return Boolean(holding?.gm?.playersCanEditResidents === true);
},

_canManageDefense() {
  if (game.user?.isGM) return true;
  const holding = this._activeHoldingForAccess?.();
  return Boolean(holding?.gm?.playersCanEditDefense === true);
},

_canEditSpecialNotes() {
  if (game.user?.isGM) return true;
  const holding = this._activeHoldingForAccess?.();
  return Boolean(holding?.gm?.playersCanEditSpecial === true);
},

_canEditBattleDefenders() {
  if (game.user?.isGM) return true;
  const holding = this._activeHoldingForAccess?.();
  return Boolean(holding?.gm?.playersCanEditBattle === true);
}
};
