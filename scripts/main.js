import { MODULE_ID } from "./data/constants.js";
import { debugSkyholdLog } from "./data/debug.js";
import { canCurrentUserOpenSkyhold, registerSettings } from "./data/settings.js";
import {
  getSkyholdDataPerformanceMetrics,
  handleSkyholdSocketPayload,
  registerStorageOperationExecutor,
  resetSkyholdDataPerformanceMetrics
} from "./data/store.js";
import {
  getSkyholdPerformanceSnapshot,
  isSkyholdPerformanceEnabled,
  resetSkyholdPerformance,
  startSkyholdPerformanceScenario,
  stopSkyholdPerformanceScenario
} from "./data/performance-observer.js";
import { SkyholdApp } from "./apps/skyhold-app.js";
import { rerenderLoadedSkyholdApps } from "./apps/lazy-apps.js";
import { executeStorageOperation } from "./apps/storage-operation-executor.js";
import { detectCalendaria, getCalendariaSnapshot, getLastCalendariaSnapshot, installCalendariaBridge } from "./integrations/calendaria-bridge.js";
import { installSceneNotesIntegration } from "./integrations/scene-notes.js";
import { preloadFoundryTemplates } from "./integrations/foundry-runtime.js";
import {
  getUniqueBuildingRegistration,
  listUniqueBuildings,
  registerUniqueBuilding,
  unregisterUniqueBuilding
} from "./apps/unique-buildings/registry.js";
import { SkyholdUniqueBuildingApp } from "./apps/unique-buildings/base-app.js";
import { registerBuiltinUniqueBuildings } from "./apps/unique-buildings/builtins.js";
import { installSkyholdWindowFocusKeeper } from "./apps/common/window-focus-keeper.js";

let apiInstalled = false;
registerStorageOperationExecutor(executeStorageOperation);

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
  `modules/${MODULE_ID}/templates/parts/storage/tabs.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/resources.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/items.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/rooms.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/accounting.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/market.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/log.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/batch-controls.hbs`,
  `modules/${MODULE_ID}/templates/parts/storage/room-rail.hbs`,
  `modules/${MODULE_ID}/templates/parts/market/sell.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-tab-gm.hbs`,
  `modules/${MODULE_ID}/templates/parts/skyhold-footer.hbs`,
  `modules/${MODULE_ID}/templates/content-pack-importer.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/hero.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/dev-gain.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/tabs.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/main.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/workers.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/construction.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/enterprise-capital.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/production.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/income.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/defense.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/housing.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/storage.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/culture.hbs`,
  `modules/${MODULE_ID}/templates/parts/building-editor/text.hbs`,
  `modules/${MODULE_ID}/templates/building-audio-track-editor.hbs`,
  `modules/${MODULE_ID}/templates/resource-row-editor.hbs`,
  `modules/${MODULE_ID}/templates/unique-buildings/parts/tabs.hbs`,
  `modules/${MODULE_ID}/templates/unique-buildings/parts/editor-tabs.hbs`,
  `modules/${MODULE_ID}/templates/unique-buildings/parts/medical-effective-types.hbs`,
  `modules/${MODULE_ID}/templates/parts/mass-combat/setup.hbs`,
  `modules/${MODULE_ID}/templates/parts/mass-combat/details.hbs`,
  `modules/${MODULE_ID}/templates/parts/mass-combat/progress.hbs`
];

async function preloadSkyholdTemplates() {
  await preloadFoundryTemplates(SKYHOLD_PARTIAL_TEMPLATES);
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

Hooks.on("getSceneControlButtons", (controls) => {
  if (!canCurrentUserOpenSkyhold()) return;
  const journal = controls?.journal ?? controls?.notes;
  const tools = journal?.tools;
  if (!tools) return;

  const name = `${MODULE_ID}-open`;
  const tool = {
    name,
    title: "FBL Skyhold Manager",
    icon: "fas fa-cloud",
    button: true,
    visible: true,
    order: 999,
    onChange: (_event, active) => {
      if (active === false) return;
      openSkyhold();
    }
  };

  if (Array.isArray(tools)) {
    if (!tools.some((entry) => entry?.name === name)) tools.push(tool);
  } else if (!tools[name]) {
    tools[name] = tool;
  }
});

function rerenderSkyhold() {
  try {
    return SkyholdApp.rerenderOpen();
  } catch (error) {
    console.error("FBL Skyhold Manager | rerender() failed", error);
    return null;
  }
}

function rerenderAuthoritySensitiveWindows() {
  rerenderLoadedSkyholdApps({ skipFocused: true });
  SkyholdUniqueBuildingApp.rerenderOpen({ skipFocused: true });
  rerenderSkyhold();
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
  const performanceDetails = () => ({
    storage: getSkyholdDataPerformanceMetrics(),
    activeTabContextCache: SkyholdApp.instance?._activeTabContextCache?.getMetrics?.() ?? null
  });
  const api = {
    open: openSkyhold,
    rerender: rerenderSkyhold,
    load: () => ({ SkyholdApp }),
    diagnostic,
    performance: {
      isEnabled: isSkyholdPerformanceEnabled,
      snapshot: () => getSkyholdPerformanceSnapshot(performanceDetails()),
      reset: () => {
        resetSkyholdPerformance();
        resetSkyholdDataPerformanceMetrics();
        SkyholdApp.instance?._activeTabContextCache?.resetMetrics?.();
      },
      start: (name = "manual", metadata = {}) => {
        resetSkyholdDataPerformanceMetrics();
        SkyholdApp.instance?._activeTabContextCache?.resetMetrics?.();
        return startSkyholdPerformanceScenario(name, metadata);
      },
      stop: () => stopSkyholdPerformanceScenario(performanceDetails())
    },
    calendaria: {
      detect: detectCalendaria,
      snapshot: getCalendariaSnapshot,
      lastSnapshot: getLastCalendariaSnapshot
    },
    uniqueBuildings: {
      register: registerUniqueBuilding,
      unregister: unregisterUniqueBuilding,
      get: getUniqueBuildingRegistration,
      list: listUniqueBuildings
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
  debugSkyholdLog(`FBL Skyhold Manager | API installed (${phase})`);
  return api;
}

Hooks.once("init", async () => {
  try {
    registerBuiltinUniqueBuildings();
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
    installSkyholdWindowFocusKeeper();
    installCalendariaBridge();

    game.socket?.on(`module.${MODULE_ID}`, async (payload) => {
      if (await handleSkyholdSocketPayload(payload)) return;
      if (payload?.type !== "dataChanged") return;
      if (payload.userId === game.user?.id) return;
      Hooks.callAll("fblSkyholdDataChanged");
    });

    installSceneNotesIntegration();

    Hooks.on("fblSkyholdDataChanged", () => {
      rerenderLoadedSkyholdApps({ skipFocused: true });
      SkyholdUniqueBuildingApp.rerenderOpen({ skipFocused: true });
      // SkyholdApp decides whether the update is safe to show now or should remain
      // pending until the user returns to the manager.
      rerenderSkyhold();
    });

    Hooks.on("updateUser", (_user, changes = {}) => {
      if (!Object.hasOwn(changes, "active") && !Object.hasOwn(changes, "role")) return;
      rerenderAuthoritySensitiveWindows();
    });

    Hooks.on("userConnected", () => rerenderAuthoritySensitiveWindows());

    debugSkyholdLog("FBL Skyhold Manager | ready", diagnostic());
  } catch (error) {
    console.error("FBL Skyhold Manager | ready failed", error);
  }
});
