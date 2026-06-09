import { MODULE_ID, handleSkyholdSocketPayload, registerSettings } from "./data/store.js";
import { SkyholdApp } from "./apps/skyhold-app.js";
import { SkyholdMassCombatApp } from "./apps/mass-combat.js";
import { detectCalendaria, getCalendariaSnapshot, getLastCalendariaSnapshot, installCalendariaBridge } from "./integrations/calendaria-bridge.js";
import { installSceneNotesIntegration } from "./integrations/scene-notes.js";

let apiInstalled = false;

const SKYHOLD_PARTIAL_TEMPLATES = [
  `modules/${MODULE_ID}/templates/parts/skyhold-header.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tabs.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-empty.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-resident-editor.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-overview.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-people.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-buildings.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-defense.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-special.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-storage.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-gm.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-footer.hbs`
];

async function preloadSkyholdTemplates() {
  if (typeof loadTemplates !== "function") return;
  await loadTemplates(SKYHOLD_PARTIAL_TEMPLATES);
}

function openSkyhold() {
  try {
    return SkyholdApp.open();
  } catch (error) {
    console.error("FBL Skyhold Manager | open() failed", error);
    ui?.notifications?.error?.("FBL Skyhold: окно не открылось. Подробности в консоли.");
    return null;
  }
}

function rerenderSkyhold() {
  try {
    return SkyholdApp.rerenderOpen();
  } catch (error) {
    console.error("FBL Skyhold Manager | rerender() failed", error);
    return null;
  }
}

function diagnostic() {
  const module = game?.modules?.get?.(MODULE_ID);
  return {
    moduleId: MODULE_ID,
    active: module?.active,
    apiOnModule: Boolean(module?.api),
    apiOnGame: Boolean(game?.fblSkyhold),
    appLoaded: Boolean(SkyholdApp),
    user: game?.user?.name,
    isGM: game?.user?.isGM,
    calendaria: detectCalendaria()
  };
}




function installApi(phase = "manual") {
  const api = {
    open: openSkyhold,
    rerender: rerenderSkyhold,
    load: () => ({ SkyholdApp }),
    diagnostic,
    calendaria: {
      detect: detectCalendaria,
      snapshot: getCalendariaSnapshot,
      lastSnapshot: getLastCalendariaSnapshot
    }
  };

  try {
    const module = game?.modules?.get?.(MODULE_ID);
    if (module) {
      try {
        module.api = api;
      } catch (_error) {
        Object.defineProperty(module, "api", {
          value: api,
          writable: true,
          configurable: true
        });
      }
    }
  } catch (error) {
    console.warn("FBL Skyhold Manager | could not attach api to module package", error);
  }

  try {
    game.fblSkyhold = api;
    globalThis.fblSkyhold = api;
  } catch (error) {
    console.warn("FBL Skyhold Manager | could not attach global api", error);
  }

  apiInstalled = true;
  console.log(`FBL Skyhold Manager | API installed (${phase})`);
  return api;
}

// Install once immediately as a safety net. In Foundry worlds `game` already exists
// while ES modules are evaluated, but init/ready below install again if needed.
try {
  installApi("module-eval");
} catch (error) {
  console.warn("FBL Skyhold Manager | early API install skipped", error);
}

Hooks.once("init", async () => {
  try {
    installApi("init");
    registerSettings();
    await preloadSkyholdTemplates();
  } catch (error) {
    console.error("FBL Skyhold Manager | Failed to initialize", error);
  }
});

Hooks.once("ready", () => {
  try {
    if (!apiInstalled) installApi("ready");
    else installApi("ready-refresh");
    installCalendariaBridge();

    game.socket?.on(`module.${MODULE_ID}`, async (payload) => {
      if (await handleSkyholdSocketPayload(payload)) return;
      if (payload?.type !== "dataChanged") return;
      if (payload.userId === game.user?.id) return;
      Hooks.callAll("fblSkyholdDataChanged");
    });

    installSceneNotesIntegration();

    Hooks.on("fblSkyholdDataChanged", () => {
      const active = document.activeElement;
      // Local button/input handlers explicitly render after saving. If the hook also
      // rerenders while focus is still inside the manager, every edit becomes two
      // full ApplicationV2 renders. Remote socket updates still rerender normally.
      SkyholdMassCombatApp.rerenderOpen({ skipFocused: true });
      if (active?.closest?.(".fbl-skyhold-app, .fbl-skyhold-building-editor, .fbl-skyhold-crew-editor, .fbl-skyhold-template-browser, .fbl-skyhold-mass-combat")) return;
      rerenderSkyhold();
    });

    console.log("FBL Skyhold Manager | ready", diagnostic());
  } catch (error) {
    console.error("FBL Skyhold Manager | ready failed", error);
  }
});
