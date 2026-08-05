import { ensureSkyholdStylesheet } from "./lazy-styles.js";

const loadedAppClasses = new Set();

function rememberAppClass(cls) {
  if (cls) loadedAppClasses.add(cls);
  return cls;
}

export function rerenderLoadedSkyholdApps(options = {}) {
  for (const cls of loadedAppClasses) cls?.rerenderOpen?.(options);
}

export async function loadBuildingEditorClass() {
  const module = await import("./editors/building-editor.js");
  return rememberAppClass(module.SkyholdBuildingEditor);
}

export async function openMassCombatApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./mass-combat.js");
  return rememberAppClass(module.SkyholdMassCombatApp).open(options);
}

export async function openMarketApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./market-app.js");
  return rememberAppClass(module.SkyholdMarketApp).open(options);
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

export async function openShipEnterpriseApp(options = {}) {
  await ensureSkyholdStylesheet("secondary");
  const module = await import("./ship-enterprise-app.js");
  return rememberAppClass(module.SkyholdShipEnterpriseApp).open(options);
}
