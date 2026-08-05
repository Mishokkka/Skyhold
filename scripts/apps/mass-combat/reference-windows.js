import { MODULE_ID } from "../../data/constants.js";
import { makeId } from "../../data/utils.js";
import { bindCounterGraphRuntime, counterGraphHtml } from "./counter-graph.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SkyholdCounterReferenceApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static open(options = {}) {
    const app = SkyholdCounterReferenceApp.instance ?? new SkyholdCounterReferenceApp();
    SkyholdCounterReferenceApp.instance = app;
    return app.render({ force: true, focus: true, ...options });
  }

  constructor(options = {}) {
    super(options);
    this.graphId = makeId("fbls-counter", 8);
    SkyholdCounterReferenceApp.instance = this;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      graphHtml: counterGraphHtml(this.graphId)
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this._counterGraphCleanup?.();
    this._counterGraphCleanup = bindCounterGraphRuntime(this.graphId, this.element);
  }

  async _onClose(options) {
    this._counterGraphCleanup?.();
    this._counterGraphCleanup = null;
    if (SkyholdCounterReferenceApp.instance === this) SkyholdCounterReferenceApp.instance = null;
    await super._onClose(options);
  }
}

SkyholdCounterReferenceApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-counter-reference",
  classes: ["fbl-skyhold", "fbl-skyhold-mass-reference", "fbl-skyhold-counter-reference"],
  tag: "section",
  window: {
    title: "Контры тегов",
    icon: "fa-solid fa-diagram-project",
    resizable: true
  },
  position: {
    width: 960,
    height: 800
  }
};

SkyholdCounterReferenceApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/mass-combat-counter-reference.hbs`
  }
};

export class SkyholdWeatherReferenceApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static instance = null;

  static open({ catalog = [], currentKey = "" } = {}, options = {}) {
    const app = SkyholdWeatherReferenceApp.instance ?? new SkyholdWeatherReferenceApp();
    app.catalog = catalog;
    app.currentKey = currentKey;
    SkyholdWeatherReferenceApp.instance = app;
    return app.render({ force: true, focus: true, ...options });
  }

  constructor(options = {}) {
    super(options);
    this.catalog = [];
    this.currentKey = "";
    SkyholdWeatherReferenceApp.instance = this;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const catalog = (this.catalog ?? []).map((weather) => ({
      ...weather,
      current: weather.key === this.currentKey,
      hasTagRows: (weather.tagRows ?? []).length > 0,
      hasPlanRows: (weather.planRows ?? []).length > 0
    }));
    return {
      ...context,
      catalog,
      currentWeather: catalog.find((weather) => weather.current) ?? null
    };
  }

  async _onClose(options) {
    if (SkyholdWeatherReferenceApp.instance === this) SkyholdWeatherReferenceApp.instance = null;
    await super._onClose(options);
  }
}

SkyholdWeatherReferenceApp.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-weather-reference",
  classes: ["fbl-skyhold", "fbl-skyhold-mass-reference", "fbl-skyhold-weather-reference"],
  tag: "section",
  window: {
    title: "Погода",
    icon: "fa-solid fa-cloud-sun-rain",
    resizable: true
  },
  position: {
    width: 820,
    height: 680
  }
};

SkyholdWeatherReferenceApp.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/mass-combat-weather-reference.hbs`
  }
};
