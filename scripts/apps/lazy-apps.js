import { ensureSkyholdStylesheet } from "./lazy-styles.js";
import { ensureSkyholdTemplateGroup } from "./template-preload.js";

const loadedAppClasses = new Set();

function rememberAppClass(cls) {
  if (cls) loadedAppClasses.add(cls);
  return cls;
}

export function rerenderLoadedSkyholdApps(options = {}) {
  for (const cls of loadedAppClasses) cls?.rerenderOpen?.(options);
}

export async function loadBuildingEditorClass() {
  const [, module] = await Promise.all([
    ensureSkyholdTemplateGroup("buildingEditor"),
    import("./editors/building-editor.js")
  ]);
  return rememberAppClass(module.SkyholdBuildingEditor);
}

export async function loadResidentEditorClass() {
  const module = await import("./editors/resident-editor.js");
  return rememberAppClass(module.SkyholdResidentEditor);
}

export async function openMassCombatApp(options = {}) {
  const [, , module] = await Promise.all([
    ensureSkyholdStylesheet("secondary"),
    ensureSkyholdTemplateGroup("massCombat"),
    import("./mass-combat.js")
  ]);
  return rememberAppClass(module.SkyholdMassCombatApp).open(options);
}

export async function openMarketApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./market-app.js");
  return rememberAppClass(module.SkyholdMarketApp).open(options);
}

export async function openTransportApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./transport-app.js");
  return rememberAppClass(module.SkyholdTransportApp).open(options);
}

export async function openBankApp(options = {}) {
  await Promise.all([ensureSkyholdStylesheet("secondary"), ensureSkyholdTemplateGroup("bankWindow")]);
  const module = await import("./bank-app.js");
  return rememberAppClass(module.SkyholdBankApp).open(options);
}

export async function openWorkforcePlanner(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./workforce-planner-app.js");
  return rememberAppClass(module.SkyholdWorkforcePlanner).open(options);
}

export async function openTendayApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const [{ SkyholdTendayApp }, { getSkyholdWorkflowService }] = await Promise.all([
    import("./tenday-app.js"),
    import("../workflows/skyhold-workflow-service.js")
  ]);
  rememberAppClass(SkyholdTendayApp);
  return SkyholdTendayApp.open({ ...options, workflow: getSkyholdWorkflowService() });
}

export async function openTendayHistory(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const [{ SkyholdTendayApp }, { getSkyholdWorkflowService }] = await Promise.all([
    import("./tenday-app.js"),
    import("../workflows/skyhold-workflow-service.js")
  ]);
  rememberAppClass(SkyholdTendayApp);
  return SkyholdTendayApp.openHistory({ ...options, workflow: getSkyholdWorkflowService() });
}

export async function openRouteGraphApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./editors/route-graph-editor.js");
  return rememberAppClass(module.SkyholdRouteGraphEditor).open(options);
}

export async function openShipWindow(options = {}) {
  const module = await import("./ship-app.js");
  await Promise.all([
    ensureSkyholdStylesheet("secondary"),
    ensureSkyholdTemplateGroup("shipWindow")
  ]);
  return rememberAppClass(module.SkyholdShipApp).open(options);
}

export async function openPoliticsApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./politics-app.js");
  return rememberAppClass(module.SkyholdPoliticsApp).open(options);
}

export async function openPoliticsBalanceEditor(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./editors/politics-balance-editor.js");
  return rememberAppClass(module.SkyholdPoliticsBalanceEditor).open(options);
}
