import { MODULE_ID } from "./data/constants.js";
import { debugSkyholdLog } from "./data/debug.js";
import { canCurrentUserOpenSkyhold, registerSettings } from "./data/settings.js";
import {
  getSkyholdDataPerformanceMetrics,
  handleSkyholdSocketPayload,
  registerConstructionOperationExecutor,
  registerMarketOperationExecutor,
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
import { executeConstructionOperation } from "./apps/construction-operation-executor.js";
import { detectCalendaria, getCalendariaSnapshot, getLastCalendariaSnapshot, installCalendariaBridge } from "./integrations/calendaria-bridge.js";
import { installSceneNotesIntegration } from "./integrations/scene-notes.js";
import { ensureSkyholdTemplateGroup } from "./apps/template-preload.js";
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
registerConstructionOperationExecutor(executeConstructionOperation);
registerMarketOperationExecutor(async (operation, context) => {
  if (["bank-borrow", "bank-repay", "bank-deposit", "bank-withdraw"].includes(operation?.type)) {
    const { executeBankOperation } = await import("./apps/bank-operation-executor.js");
    return executeBankOperation(operation, context);
  }
  const { executeMarketOperation } = await import("./apps/market-operation-executor.js");
  return executeMarketOperation(operation, context);
});

async function preloadSkyholdTemplates() {
  await ensureSkyholdTemplateGroup("core");
}

function reportSkyholdOpenError(error) {
  console.error("FBL Skyhold Manager | open() failed", error);
  ui?.notifications?.error?.("FBL Skyhold: окно не открылось. Подробности в консоли.");
  return null;
}

function openSkyhold() {
  try {
    const result = SkyholdApp.open();
    return typeof result?.catch === "function" ? result.catch(reportSkyholdOpenError) : result;
  } catch (error) {
    return reportSkyholdOpenError(error);
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

    game.socket?.on(`module.${MODULE_ID}`, async (payload, senderId) => {
      try {
        if (await handleSkyholdSocketPayload(payload, senderId)) return;
        if (payload?.type !== "dataChanged") return;
        if (payload.userId !== senderId || !game.users?.get?.(senderId)?.isGM) return;
        if (payload.userId === game.user?.id) return;
        Hooks.callAll("fblSkyholdDataChanged");
      } catch (error) {
        console.error("FBL Skyhold | Socket payload failed", error);
      }
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
