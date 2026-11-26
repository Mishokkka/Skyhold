import {
  MODULE_ID,
  SETTING_CATALOG,
  SETTING_DATA,
  SETTING_DEBUG_LOGS,
  SETTING_HOLDINGS,
  SETTING_MASS_COMBAT_TAGS,
  SETTING_META,
  SETTING_PLAYERS_CAN_OPEN,
  SETTING_ROUTE_GRAPH_VIEW
} from "./constants.js";

export function registerSettings() {
  game.settings.register(MODULE_ID, SETTING_DATA, {
    name: "Skyhold Recovery Snapshot",
    hint: "Combined world data used for recovery and rollback.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_META, {
    name: "Skyhold Meta",
    hint: "Internal metadata for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_HOLDINGS, {
    name: "Skyhold Holdings",
    hint: "Internal holdings runtime data for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: []
  });

  game.settings.register(MODULE_ID, SETTING_CATALOG, {
    name: "Skyhold Catalog",
    hint: "Internal catalog data for FBL Skyhold Manager.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_MASS_COMBAT_TAGS, {
    name: "Skyhold Mass Combat Tags",
    hint: "Editable tag and counter matrix for Skyhold mass combat.",
    scope: "world",
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register(MODULE_ID, SETTING_PLAYERS_CAN_OPEN, {
    name: "Игроки могут открывать окно владений",
    hint: "Если выключено, окно владений сможет открывать только ГМ.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });

  game.settings.register(MODULE_ID, SETTING_DEBUG_LOGS, {
    name: "Skyhold debug logs",
    hint: "Enable verbose FBL Skyhold Manager console logs on this client.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false
  });

  game.settings.register(MODULE_ID, SETTING_ROUTE_GRAPH_VIEW, {
    name: "Skyhold route graph viewport",
    hint: "Client-local pan and zoom state for the market route graph.",
    scope: "client",
    config: false,
    type: Object,
    default: {}
  });
}

export function canCurrentUserOpenSkyhold() {
  if (game.user?.isGM) return true;
  return Boolean(game.settings.get(MODULE_ID, SETTING_PLAYERS_CAN_OPEN));
}
