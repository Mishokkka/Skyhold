import { MODULE_ID } from "../data/constants.js";
import { preloadFoundryTemplates } from "../integrations/foundry-runtime.js";

const template = (path) => `modules/${MODULE_ID}/templates/${path}`;

export const SKYHOLD_TEMPLATE_GROUPS = Object.freeze({
  core: Object.freeze([
    template("parts/save-status.hbs"),
    template("parts/skyhold-header.hbs"),
    template("parts/skyhold-tabs.hbs"),
    template("parts/skyhold-empty.hbs"),
    template("parts/skyhold-resident-editor.hbs"),
    template("parts/skyhold-tab-overview.hbs"),
    template("parts/skyhold-tab-people.hbs"),
    template("parts/skyhold-tab-buildings.hbs"),
    template("parts/skyhold-tab-defense.hbs"),
    template("parts/skyhold-tab-special.hbs"),
    template("parts/skyhold-ships.hbs"),
    template("parts/skyhold-tab-storage.hbs"),
    template("parts/skyhold-tab-external-market.hbs"),
    template("parts/storage/tabs.hbs"),
    template("parts/storage/resources.hbs"),
    template("parts/storage/items.hbs"),
    template("parts/storage/rooms.hbs"),
    template("parts/storage/accounting.hbs"),
    template("parts/storage/market.hbs"),
    template("parts/storage/log.hbs"),
    template("parts/storage/batch-controls.hbs"),
    template("parts/storage/room-rail.hbs"),
    template("parts/skyhold-tab-gm.hbs"),
    template("parts/skyhold-footer.hbs")
  ]),
  buildingEditor: Object.freeze([
    template("parts/building-editor/list-picker.hbs"),
    template("parts/save-status.hbs"),
    template("parts/building-editor/hero.hbs"),
    template("parts/building-editor/dev-gain.hbs"),
    template("parts/building-editor/tabs.hbs"),
    template("parts/building-editor/main.hbs"),
    template("parts/building-editor/workers.hbs"),
    template("parts/building-editor/construction.hbs"),
    template("parts/building-editor/rules.hbs"),
    template("parts/building-editor/projects.hbs"),
    template("parts/building-editor/production.hbs"),
    template("parts/building-editor/agriculture.hbs"),
    template("parts/building-editor/livestock.hbs"),
    template("parts/building-editor/income.hbs"),
    template("parts/building-editor/defense.hbs"),
    template("parts/building-editor/housing.hbs"),
    template("parts/building-editor/storage.hbs"),
    template("parts/building-editor/culture.hbs"),
    template("parts/building-editor/text.hbs")
  ]),
  uniqueBuilding: Object.freeze([
    template("unique-buildings/parts/tabs.hbs"),
    template("unique-buildings/parts/editor-tabs.hbs"),
    template("unique-buildings/parts/medical-effective-types.hbs"),
    template("parts/building-editor/main.hbs"),
    template("parts/building-editor/construction.hbs")
  ]),
  massCombat: Object.freeze([
    template("parts/mass-combat/setup.hbs"),
    template("parts/mass-combat/details.hbs"),
    template("parts/mass-combat/progress.hbs")
  ]),
  uiReview: Object.freeze([
    template("ship-app.hbs"),
    template("parts/ui-review-ships.hbs"),
    template("parts/save-status.hbs"),
    template("parts/ui-review-samples.hbs"),
    template("parts/ui-review-audit-samples.hbs"),
    template("parts/ui-review-behavior-samples.hbs"),
    template("parts/ui-review-row-card-samples.hbs"),
    template("parts/ui-review-building-current.hbs"),
    template("parts/ui-review-building-proposed.hbs")
  ]),
  shipWindow: Object.freeze([
    template("parts/ship-window/orders.hbs"),
    template("parts/ship-window/voyage-progress.hbs"),
    template("parts/ship-window/command-readiness.hbs"),
    template("parts/ship-window/order-preview.hbs"),
    template("parts/ship-window/route-map-view.hbs"),
    template("parts/ship-window/crew.hbs"),
    template("parts/ship-window/finance.hbs"),
    template("parts/ship-window/settings.hbs"),
    template("parts/ship-window/legacy.hbs")
  ])
});

const loadedGroups = new Set();
const pendingGroups = new Map();

export function skyholdTemplatePaths(group = "core") {
  const paths = SKYHOLD_TEMPLATE_GROUPS[group];
  if (!paths) throw new Error(`FBL Skyhold | Unknown template group: ${group}`);
  return paths;
}

export function ensureSkyholdTemplateGroup(group = "core") {
  if (loadedGroups.has(group)) return Promise.resolve(skyholdTemplatePaths(group));
  if (pendingGroups.has(group)) return pendingGroups.get(group);
  const paths = skyholdTemplatePaths(group);
  const pending = Promise.resolve(preloadFoundryTemplates(paths))
    .then(() => {
      loadedGroups.add(group);
      pendingGroups.delete(group);
      return paths;
    })
    .catch((error) => {
      pendingGroups.delete(group);
      throw error;
    });
  pendingGroups.set(group, pending);
  return pending;
}
