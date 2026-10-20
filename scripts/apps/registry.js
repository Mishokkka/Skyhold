import { requestApplicationRender } from "./common/render-scheduler.js";
import { hasActiveProtectedSkyholdWindow } from "./common/window-focus-keeper.js";
import { politicsDecisionContext } from "./politics-decision-context.js";
import { politicsEffects, politicsPeriodIndex } from "../engines/politics/rules.js";
import { setPoliticsRuntimeEffectsResolver } from "../engines/politics/runtime-effects.js";

let SkyholdAppClass = null;

export function registerSkyholdAppClass(cls) {
  SkyholdAppClass = cls;
  if (!cls) { setPoliticsRuntimeEffectsResolver(null); return; }
  const calculationOwner = Object.create(cls.prototype);
  setPoliticsRuntimeEffectsResolver((holding) => politicsEffects(holding, {
    ...politicsDecisionContext(holding, cls.instance ?? calculationOwner),
    periodIndex: politicsPeriodIndex(holding?.gm?.calendaria?.lastQd)
  }));
}

export function getSkyholdAppClass() {
  return SkyholdAppClass;
}

export function getSkyholdManager() {
  return SkyholdAppClass?.instance ?? null;
}

export function requestSkyholdAppRender(options = {}) {
  const app = SkyholdAppClass?.instance ?? null;
  if (!app?.rendered) return null;
  if (options.deferForActiveWindow !== false && hasActiveProtectedSkyholdWindow({ recentMs: 5000 })) {
    app._pendingExternalRerender = true;
    return null;
  }
  const renderOptions = { force: true, focus: false, ...options };
  return requestApplicationRender(app, renderOptions);
}
