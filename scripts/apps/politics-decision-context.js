import { politicsAvailability } from "../data/politics-availability.js";
import { buildingServiceBlockReasons } from "../engines/economy/building-service.js";
import { buildingOperationalState } from "../core/building-state.js";
import { politicsEffects, politicsPeriodIndex } from "../engines/politics/rules.js";
import { settlementControlSummary } from "../engines/settlement/control.js";
import { politicsRouteAvailable } from "../engines/politics/route-context.js";
import { SkyholdData } from "../data/store.js";

/** The same server-side conditions are shown by the window and checked at commit time. */
export function politicsDecisionContext(holding = {}, manager = null, { data = null } = {}) {
  const worldData = data ?? (globalThis.game?.settings?.get ? SkyholdData.view() : {});
  const development = manager?._developmentSummary?.(holding)?.totals ?? {};
  const culture = Number(development.culture) || 0;
  const activeBuildings = (holding?.buildings?.list ?? []).filter((building) =>
    buildingServiceBlockReasons(holding, building).active);
  const active = new Set(activeBuildings.map((building) => String(building.templateId ?? "")));
  const availability = politicsAvailability(holding, culture);
  const projectActive = (holding?.buildings?.list ?? []).some((building) => {
    const state = buildingOperationalState(building);
    return ["planned", "building"].includes(state.lifecycle) && Boolean(building.constructionCrewId);
  });
  const productionActive = activeBuildings.some((building) =>
    manager?._buildingFunctions?.(building)?.production === true
    && (building.productionLines ?? []).some((line) => line.active !== false));
  const lastNetworkPaid = Number(holding?.politics?.lastNetworkPaidPeriodIndex) || 0;
  const networkPaid = lastNetworkPaid > 0
    && lastNetworkPaid >= politicsPeriodIndex(holding?.gm?.calendaria?.lastQd) - 1;
  const food = [...(holding?.log ?? [])].reverse().find((entry) => entry.type === "tenday")?.payload?.economy?.food;
  const rationFullySupplied = holding?.gm?.moraleSnapshot?.ration?.fullySupplied
    ?? Boolean(food?.needed > 0 && food.effectiveTier === food.selectedTier && !food.fallback && food.eaten >= food.needed);
  const context = {
    available: availability.available, culture, technology: Number(development.technology) || 0,
    reputation: Number(manager?._reputationSummary?.(holding)?.total) || 0,
    marketActive: active.has("market"),
    networkPaid,
    rationFullySupplied,
    townHallActive: active.has("town-hall"),
    projectActive, productionActive,
    institutionActive: active.has("meeting-house") || active.has("town-hall"),
    publicTrialInstitutionActive: active.has("meeting-house") || active.has("court"),
    patrolServiceActive: settlementControlSummary(holding, { includePolitics: false }).sources
      .some((source) => source.general > 0 || source.unrestOnly > 0),
    patronAgreementActive: Boolean(holding?.politics?.patronName)
  };
  // Route-gated bonuses cannot create the route that unlocks themselves.
  // Other political URS sources must still count inside the runtime resolver.
  const marketAccess = politicsEffects(holding, { ...context, routeActive: false,
    periodIndex: politicsPeriodIndex(holding?.gm?.calendaria?.lastQd) }).marketAccess;
  context.routeActive = politicsRouteAvailable(holding, worldData, { marketAccess });
  return context;
}
