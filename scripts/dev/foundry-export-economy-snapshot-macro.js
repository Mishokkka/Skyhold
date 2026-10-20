/**
 * FBL Skyhold world economy snapshot macro.
 *
 * Usage:
 * 1. Log into the target world as an active GM.
 * 2. Create a Foundry "Script" macro.
 * 3. Paste this entire file into the macro and execute it once.
 * 4. Send the downloaded JSON back for migration planning.
 *
 * This macro is read-only. It does not call game.settings.set(), mutate the
 * returned settings, or change any world document.
 */
(async () => {
  const MODULE_ID = "fbl-skyhold";
  const SETTING_KEYS = ["skyholdMeta", "skyholdHoldings", "skyholdCatalog", "skyholdData"];
  const runtime = globalThis.game;
  const notifications = globalThis.ui?.notifications;

  if (!runtime?.user?.isGM) {
    notifications?.error?.("FBL Skyhold: снимок может экспортировать только GM.");
    return;
  }

  const moduleRecord = runtime.modules?.get?.(MODULE_ID);
  if (!moduleRecord?.active) {
    notifications?.error?.("FBL Skyhold: модуль fbl-skyhold не активен в этом мире.");
    return;
  }

  try {
    const settings = Object.fromEntries(
      SETTING_KEYS.map((key) => [key, runtime.settings.get(MODULE_ID, key)])
    );
    const exportedAt = new Date().toISOString();
    const snapshot = {
      format: "fbl-skyhold-world-economy-snapshot",
      formatVersion: 1,
      exportedAt,
      world: {
        id: String(runtime.world?.id ?? ""),
        title: String(runtime.world?.title ?? "")
      },
      foundryVersion: String(runtime.version ?? runtime.release?.version ?? ""),
      system: {
        id: String(runtime.system?.id ?? ""),
        version: String(runtime.system?.version ?? "")
      },
      module: {
        id: MODULE_ID,
        version: String(moduleRecord.version ?? "")
      },
      settings
    };

    const json = JSON.stringify(snapshot, null, 2);
    const safeWorldId = String(runtime.world?.id ?? "world")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "world";
    const timestamp = exportedAt.replace(/[:.]/g, "-");
    const filename = `fbl-skyhold-economy-snapshot-${safeWorldId}-${timestamp}.json`;
    const foundrySave = globalThis.saveDataToFile;

    if (typeof foundrySave === "function") {
      foundrySave(json, "application/json", filename);
    } else {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    notifications?.info?.(`FBL Skyhold: снимок сохранён как ${filename}`);
  } catch (error) {
    console.error("FBL Skyhold | Economy snapshot export failed.", error);
    notifications?.error?.(`FBL Skyhold: не удалось экспортировать снимок — ${error?.message ?? error}`);
  }
})();
