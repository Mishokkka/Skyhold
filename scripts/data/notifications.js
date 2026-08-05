import { MODULE_ID } from "./constants.js";

export function notifySkyholdChanged() {
  Hooks.callAll("fblSkyholdDataChanged");

  // Socket traffic is only a rerender signal for already-open windows on other clients.
  // The canonical data lives in world settings and is synchronized by Foundry.
  if (game.socket) {
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "dataChanged",
      userId: game.user?.id ?? null
    });
  }
}
