import { FloatingTooltipsMixin } from "../common/floating-tooltip.js";
import { dispatchDelegatedAction } from "../common/delegated-events.js";
import { PendingFieldSavesMixin } from "../common/pending-field-saves.js";
import { MODULE_ID } from "../../data/constants.js";
import { LEGACY_MARKET_ROUTE_UNIT_KM, normalizeEventRegionOptions } from "../../data/random-events.js";
import { marketRouteDistanceKm, marketRoutePolylineLength, normalizeMarketRouteMap } from "../../data/market/route-map.js";
import { SkyholdData } from "../../data/store.js";
import { makeId } from "../../data/utils.js";
import { fieldValue } from "../../core/helpers.js";
import { renderFoundryFilePicker, foundryDialogV2 } from "../../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "../registry.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { readRouteGraphViewport, routeGraphViewportTransform, routeGraphViewportsEqual, writeRouteGraphViewport } from "./route-graph-viewport.js";
import {
  clampRouteValue as clamp,
  defaultRouteNodePosition as defaultPosition,
  normalizeRoutePathPoints as normalizedPathPoints,
  recalculateScaledRouteDistances as recalculateScaledEdgeDistances,
  removeRouteEdge as removeEdge,
  routeEdgeKey as edgeKey,
  routePointsAttribute as pointsAttribute,
  routePolylineMidpoint as polylineMidpoint,
  routePolylinePoints as routePoints,
  upsertRouteEdge as upsertEdge
} from "./route-graph-model.js";

const ROUTE_COLLATOR = new Intl.Collator("ru", { numeric: true, sensitivity: "base" });

export function compareRouteRows(left, right, order = "name") {
  const a = left.dataset, b = right.dataset;
  const name = () => ROUTE_COLLATOR.compare(a.routeEdgeSearchText, b.routeEdgeSearchText) || ROUTE_COLLATOR.compare(a.routeKey, b.routeKey);
  if (order === "distance-asc" || order === "distance-desc") return (Number(a.routeDistance) - Number(b.routeDistance)) * (order === "distance-desc" ? -1 : 1) || name();
  if (order === "urs-desc") return Number(b.routeUrs) - Number(a.routeUrs) || name();
  if (order === "transport") return ROUTE_COLLATOR.compare(a.routeModes, b.routeModes) || name();
  return (order === "name-desc" ? -1 : 1) * name();
}

const WINTER_DEFAULTS = Object.freeze({ enabled: false, costFactor: 1.4, timeFactor: 1.25, riskFactor: 1.2 });

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const SEASONS = [
  { id: "spring", label: "Весна" },
  { id: "summer", label: "Лето" },
  { id: "autumn", label: "Осень" },
  { id: "winter", label: "Зима" }
];

function regionAbbreviation(label = "") {
  return [...String(label ?? "").replace(/[^a-zа-яё0-9]/giu, "")].slice(0, 3).join("").toLocaleUpperCase("ru") || "???";
}

function edgeLocationLabel(label = "") {
  const words = String(label ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? "?";
  return words.map((word) => [...word].slice(0, 3).join("")).join(" ");
}

function readPolylinePoints(line) {
  return String(line.getAttribute("points") ?? "").trim().split(/\s+/).map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x, y };
  }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

export function graphContext(regionRows = [], selectedNodeId = "", mapSource = {}, selectedSeasonId = "winter", { normalizedRegions = false } = {}) {
  const map = normalizeMarketRouteMap(mapSource);
  const regions = normalizedRegions ? regionRows : normalizeEventRegionOptions(regionRows, { fallback: false });
  const byId = new Map(regions.map((row) => [row.value, row]));
  const nodes = regions.map((row, index) => {
    const fallback = defaultPosition(index, regions.length, map);
    const hasSavedPosition = Number(row.marketMapX) > 0 || Number(row.marketMapY) > 0;
    const x = clamp(hasSavedPosition ? row.marketMapX : fallback.x, 0, map.worldWidth);
    const y = clamp(hasSavedPosition ? row.marketMapY : fallback.y, 0, map.worldHeight);
    return {
      ...row,
      x,
      y,
      abbreviation: regionAbbreviation(row.label),
      selected: row.value === selectedNodeId,
      statusClass: `status-${row.marketStatus}`
    };
  });
  const nodeById = new Map(nodes.map((row) => [row.value, row]));
  const edges = [];
  const seen = new Set();
  for (const region of regions) {
    for (const link of region.marketLinks ?? []) {
      if (!byId.has(link.regionId) || link.regionId === region.value) continue;
      const key = edgeKey(region.value, link.regionId, link.routeId);
      if (seen.has(key)) continue;
      seen.add(key);
      const from = nodeById.get(region.value);
      const to = nodeById.get(link.regionId);
      const modes = Array.isArray(link.modes) && link.modes.length ? link.modes : ["caravan", "airship"];
      const pathPoints = normalizedPathPoints(link.pathPoints, map);
      const points = routePoints(from, to, pathPoints, map);
      const calculatedDistanceKm = marketRouteDistanceKm(points, map);
      const distanceMode = String(link.distanceMode ?? "") === "scaled" ? "scaled" : "manual";
      const distanceKm = distanceMode === "scaled" && calculatedDistanceKm > 0
        ? calculatedDistanceKm
        : Math.max(1, Number(link.distanceKm) || LEGACY_MARKET_ROUTE_UNIT_KM);
      const midpoint = polylineMidpoint(points);
      const seasonalModifiers = link.seasonalModifiers && typeof link.seasonalModifiers === "object" ? link.seasonalModifiers : {};
      const storedSeason = seasonalModifiers[selectedSeasonId];
      const seasonal = storedSeason ?? (selectedSeasonId === "winter" ? WINTER_DEFAULTS
        : { enabled: false, costFactor: 1, timeFactor: 1, riskFactor: 1 });
      edges.push({
        key, routeId: link.routeId || "",
        fromId: from.value,
        toId: to.value,
        fromLabel: from.label,
        toLabel: to.label,
        points,
        pointsText: pointsAttribute(points),
        pathPoints,
        pathPointCount: pathPoints.length,
        midX: Math.round(midpoint.x),
        midY: Math.round(midpoint.y),
        distanceKm,
        ursCost: Math.min(99, Math.max(1, Math.floor(Number(link.ursCost) || 1))),
        calculatedDistanceKm,
        distanceMode,
        automaticDistance: distanceMode === "scaled" && calculatedDistanceKm > 0,
        scaledDistanceSelected: distanceMode === "scaled",
        scaledDistancePaused: distanceMode === "scaled" && calculatedDistanceKm <= 0,
        scaleAvailable: map.kmPerPixel > 0,
        fromShort: edgeLocationLabel(from.label),
        toShort: edgeLocationLabel(to.label),
        modes,
        modesText: modes.join(" "),
        seasonalModifiers,
        seasonalEnabled: Boolean(seasonal.enabled),
        seasonalCostFactor: Number(seasonal.costFactor) || 1,
        seasonalTimeFactor: Number(seasonal.timeFactor) || 1,
        seasonalRiskFactor: Number(seasonal.riskFactor) || 1,
        modesLabel: modes.map((mode) => ({ caravan: "Караван", rail: "Ж/д", airship: "Корабль" }[mode])).filter(Boolean).join(" · "),
        caravan: modes.includes("caravan"),
        rail: modes.includes("rail"),
        airship: modes.includes("airship")
      });
    }
  }
  const groups = new Map();
  for (const edge of edges) {
    const pair = edgeKey(edge.fromId, edge.toId);
    if (!groups.has(pair)) groups.set(pair, []);
    groups.get(pair).push(edge);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => left.routeId.localeCompare(right.routeId));
    group.forEach((edge, index) => {
      edge.routeLabel = `${edge.modesLabel}${group.length > 1 ? ` · №${index + 1}` : ""}`;
      if (group.length < 2 || edge.pathPointCount) return;
      const [from, to] = edge.points;
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      // Display-only separation: never changes stored geometry or calculated kilometres.
      const offset = (index - (group.length - 1) / 2) * 36 * (edge.fromId < edge.toId ? 1 : -1);
      const mid = { x: (from.x + to.x) / 2 - (to.y - from.y) / length * offset,
        y: (from.y + to.y) / 2 + (to.x - from.x) / length * offset };
      edge.pointsText = pointsAttribute([from, mid, to]);
      edge.displayOffset = offset;
      edge.midX = Math.round(mid.x);
      edge.midY = Math.round(mid.y);
    });
  }
  return {
    nodes,
    edges,
    map,
    zoomPercent: Math.round(map.zoom * 100),
    hasScale: map.kmPerPixel > 0,
    scaleLabel: map.kmPerPixel > 0 ? `${Math.round(map.kmPerPixel * 100000) / 1000} км / 100 px` : "Не откалиброван",
    compactNodes: map.nodeMode === "compact",
    cardNodes: map.nodeMode === "card",
    selectedSeasonId,
    selectedSeasonLabel: SEASONS.find((season) => season.id === selectedSeasonId)?.label ?? "Зима",
    winterSelected: selectedSeasonId === "winter",
    seasonOptions: SEASONS.map((season) => ({ ...season, selected: season.id === selectedSeasonId })),
    hasNodes: nodes.length > 0,
    selectedNode: nodeById.get(selectedNodeId) ?? null
  };
}

function imageDimensions(path = "") {
  return new Promise((resolve) => {
    const image = new globalThis.Image();
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      resolve(result);
    };
    image.onload = () => done({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => done(null);
    image.src = String(path ?? "");
    setTimeout(() => done(null), 5000);
  });
}

export class SkyholdRouteGraphEditor extends FloatingTooltipsMixin(PendingFieldSavesMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  constructor({ owner = null } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.selectedNodeId = "";
    this.seasonId = "winter";
    this.view = null;
    this._viewportMap = null;
    this._persistedViewport = null;
    this._viewportDirty = false;
    this._dragState = null;
    this._panState = null;
    this._suppressNodeClick = false;
    this._pathEdit = null;
    this._calibrationDraft = null;
    this._edgeEditor = null;
    this._nodeClickTimer = 0;
    this.newRouteMode = "airship";
    this.routeModeFilter = "";
    this.routeSearch = "";
    this.routeSort = "name";
    this.routeRegionFilter = "";
    this.routeSeasonFilter = "";
    this.routeDistanceFilter = "";
    this.advancedFiltersOpen = false;
  }

  static open({ owner = null } = {}) {
    const app = new this({ owner });
    app.render({ force: true, focus: true });
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this._preservedMapBackground = this.element?.querySelector?.(".fbls-route-map-background") ?? null;
    const data = SkyholdData.view();
    const graph = this._graphForView(data);
    if (this.selectedNodeId && !graph.selectedNode) this.selectedNodeId = "";
    if (!this.view) {
      this._viewportMap = graph.map;
      this.view = readRouteGraphViewport(graph.map);
      this._persistedViewport = { ...this.view };
    } else {
      this._viewportMap = graph.map;
    }
    if (this._pathEdit) {
      const edge = graph.edges.find((row) => row.key === edgeKey(this._pathEdit.fromId, this._pathEdit.toId, this._pathEdit.routeId));
      const from = graph.nodes.find((row) => row.value === this._pathEdit.fromId);
      const to = graph.nodes.find((row) => row.value === this._pathEdit.toId);
      if (!edge || !from || !to) this._pathEdit = null;
      else {
        const points = routePoints(from, to, this._pathEdit.points, graph.map);
        edge.points = points;
        edge.pointsText = pointsAttribute(points);
        edge.displayOffset = null;
        const midpoint = polylineMidpoint(points);
        edge.midX = Math.round(midpoint.x);
        edge.midY = Math.round(midpoint.y);
        edge.distanceKm = marketRouteDistanceKm(points, graph.map) || edge.distanceKm;
        edge.editing = true;
        graph.pathEdit = {
          active: true,
          fromLabel: edge.fromLabel,
          toLabel: edge.toLabel,
          pointCount: this._pathEdit.points.length,
          canUndo: this._pathEdit.points.length > 0,
          scaleAvailable: graph.map.kmPerPixel > 0,
          distanceKm: marketRouteDistanceKm(points, graph.map)
        };
      }
    }
    if (this._calibrationDraft) {
      const points = this._calibrationDraft.points ?? [];
      graph.calibrationDraft = {
        active: true,
        points,
        pointsText: pointsAttribute(points),
        ready: points.length === 2,
        canUndo: points.length > 0,
        pixelDistance: points.length === 2 ? Math.round(marketRoutePolylineLength(points) * 10) / 10 : 0,
        distanceKm: this._calibrationDraft.distanceKm || graph.map.calibration?.distanceKm || ""
      };
    }
    graph.viewportTransform = this._world?.style?.transform || "";
    graph.zoomPercent = Math.round(this.view.zoom * 100);
    graph.search = this.routeSearch;
    graph.advancedFiltersOpen = this.advancedFiltersOpen;
    graph.activeAdvancedFilterCount = [this.routeRegionFilter, this.routeSeasonFilter, this.routeDistanceFilter].filter(Boolean).length;
    return { ...context, canEdit: Boolean(game.user?.isGM), graph };
  }

  _graphForView(data, season = this.seasonId) {
    const rows = data?.catalog?.eventRegions;
    const map = data?.catalog?.marketRouteMap;
    const revision = data?.meta?.revision;
    let cache = this._graphCache;
    if (!cache || cache.rows !== rows || cache.map !== map || cache.revision !== revision || cache.season !== season) {
      cache = this._graphCache = { rows, map, revision, season, graph: graphContext(rows, "", map, season) };
    }
    const graph = { ...cache.graph, edges: cache.graph.edges.map((edge) => ({ ...edge })),
      nodes: cache.graph.nodes.map((node) => ({ ...node, selected: node.value === this.selectedNodeId })) };
    graph.selectedNode = graph.nodes.find((node) => node.selected) ?? null;
    return graph;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    const nextBackground = root.querySelector?.(".fbls-route-map-background");
    const previousBackground = this._preservedMapBackground;
    this._preservedMapBackground = null;
    if (nextBackground && previousBackground && nextBackground.getAttribute("src") === previousBackground.getAttribute("src")) {
      nextBackground.replaceWith(previousBackground);
    }
    this._graphAbortController?.abort?.();
    this._resizeObserver?.disconnect?.();
    const controller = new AbortController();
    this._graphAbortController = controller;
    const listenerOptions = { signal: controller.signal };
    root.addEventListener("click", (event) => dispatchDelegatedAction(this, event, event.target, () => this._onClick(event, root)), listenerOptions);
    root.addEventListener("dblclick", (event) => this._onDoubleClick(event, root), listenerOptions);
    root.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.target, () => this._onChange(event, root)), listenerOptions);
    root.addEventListener("input", (event) => this._onInput(event, root), listenerOptions);
    root.addEventListener("pointerdown", (event) => this._onPointerDown(event, root), listenerOptions);
    root.addEventListener("pointermove", (event) => this._onPointerMove(event), listenerOptions);
    root.addEventListener("pointerup", (event) => this._onPointerUp(event), listenerOptions);
    root.addEventListener("pointercancel", (event) => this._onPointerUp(event), listenerOptions);
    root.addEventListener("wheel", (event) => this._onWheel(event, root), { signal: controller.signal, passive: false });
    root.querySelector("[data-route-advanced-filters]")?.addEventListener("toggle", (event) => {
      this.advancedFiltersOpen = event.currentTarget.open;
    }, listenerOptions);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.target?.closest?.("input, select, textarea")) return;
      if (!this._pathEdit && !this._calibrationDraft && !this.selectedNodeId) return;
      event.preventDefault();
      event.stopPropagation();
      this._pathEdit = null;
      this._calibrationDraft = null;
      this.selectedNodeId = "";
      this.requestRender({ focus: false });
    }, listenerOptions);
    this._canvas = root.querySelector("[data-route-canvas]");
    this._wheelRect = null;
    this._world = root.querySelector("[data-route-world]");
    const transport = root.querySelector("[data-route-transport-filter]");
    if (transport) transport.value = this.routeModeFilter;
    for (const [selector, value] of [["[data-route-sort]", this.routeSort], ["[data-route-region-filter]", this.routeRegionFilter],
      ["[data-route-season-filter]", this.routeSeasonFilter], ["[data-route-distance-filter]", this.routeDistanceFilter]]) {
      const field = root.querySelector(selector);
      if (field) field.value = value;
    }
    const newMode = root.querySelector("[data-route-new-mode]");
    if (newMode) newMode.value = this.newRouteMode;
    this._displayedEdges = new Map((context.graph?.edges ?? []).map((edge) => [edge.key, edge]));
    this._displayedSeason = this.seasonId;
    this._sortRouteRows(root);
    this._applyRouteFilters(root);
    if (this._canvas && this._world) {
      this._viewportSize = null;
      this._applyViewport();
      this._resizeObserver = new ResizeObserver(([entry]) => {
        this._viewportSize = entry?.contentRect ?? null;
        this._scheduleViewportFrame();
      });
      this._resizeObserver.observe(this._canvas);
      this._scheduleViewportFrame();
    }
  }

  _onClick(event, root) {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains(element)) return;
    const action = String(element.dataset.action ?? "");
    if (action === "route-filters-reset") return this._resetRouteFilters(root);
    else if (action === "route-export") return this._exportNetwork();
    else if (action === "route-import") return this._importNetwork();
    else if (action === "route-node-select") return this._onSelectNode(event, element);
    else if (action === "route-edge-delete") return this._onDeleteEdge(event, element);
    else if (action === "route-edge-open") return this._openEdgeEditor(event, element);
    else if (action === "route-layout-reset") return this._onResetLayout(event);
    else if (action === "route-background-pick") return this._onPickBackground(event);
    else if (action === "route-background-remove") return this._onRemoveBackground(event);
    else if (action === "route-zoom-in") return this._changeZoom(1.2);
    else if (action === "route-zoom-out") return this._changeZoom(1 / 1.2);
    else if (action === "route-zoom-fit") return this._fitView();
    else if (action === "route-node-mode") return this._onNodeMode(event, element);
    else if (action === "route-season-preset") return this._onSeasonPreset(event, element);
    else if (action === "route-calibration-start") return this._startCalibration(event);
    else if (action === "route-calibration-undo") return this._undoCalibration(event);
    else if (action === "route-calibration-save") return this._saveCalibration(event);
    else if (action === "route-calibration-cancel") return this._cancelCalibration(event);
    else if (action === "route-path-undo") return this._undoPathPoint(event);
    else if (action === "route-path-save") return this._savePathEdit(event);
    else if (action === "route-path-cancel") return this._cancelPathEdit(event);
    else if (action === "route-selection-clear") {
      event.preventDefault();
      this.selectedNodeId = "";
      this._updateNodeSelection();
    }
  }

  _onDoubleClick(event, root) {
    const node = event.target?.closest?.("[data-route-node]");
    if (node && root.contains(node)) {
      event.preventDefault();
      event.stopPropagation();
      clearTimeout(this._nodeClickTimer);
      this._nodeClickTimer = 0;
      const regionId = String(node.dataset.regionId ?? "");
      if (regionId) this.owner?.openRegion?.(regionId);
      return;
    }
    const edge = event.target?.closest?.("[data-route-edge-path]");
    if (edge && root.contains(edge)) {
      event.preventDefault();
      event.stopPropagation();
      this._openEdgeEditor(event, edge);
    }
  }

  _onChange(event, root) {
    for (const [selector, key] of [["[data-route-sort]", "routeSort"], ["[data-route-region-filter]", "routeRegionFilter"],
      ["[data-route-season-filter]", "routeSeasonFilter"], ["[data-route-distance-filter]", "routeDistanceFilter"]]) {
      if (!event.target?.closest?.(selector)) continue;
      this[key] = String(event.target.value ?? "");
      if (key === "routeSort") this._sortRouteRows(root);
      this._applyRouteFilters(root);
      return;
    }
    const transport = event.target?.closest?.("[data-route-transport-filter]");
    if (transport) {
      this.routeModeFilter = transport.value;
      this._applyRouteFilters(root);
      return;
    }
    const newMode = event.target?.closest?.("[data-route-new-mode]");
    if (newMode) { this.newRouteMode = newMode.value; return; }
    const locate = event.target?.closest?.("[data-route-locate]");
    if (locate?.value) {
      const node = [...root.querySelectorAll("[data-route-node]")].find((row) => row.dataset.regionId === locate.value);
      if (node) {
        this.view.centerX = Number.parseFloat(node.style.getPropertyValue("--node-x"));
        this.view.centerY = Number.parseFloat(node.style.getPropertyValue("--node-y"));
        this._clampView();
        this._scheduleViewportFrame();
        this._scheduleViewportPersist();
      }
      return;
    }
    const season = event.target?.closest?.("[data-route-season]");
    if (season && root.contains(season)) {
      this.seasonId = SEASONS.some((row) => row.id === season.value) ? season.value : "winter";
      this.requestRender({ focus: false });
      return;
    }
    const field = event.target?.closest?.("[data-route-edge-field]");
    if (field && root.contains(field)) return this._onEdgeFieldChange(event, field);
  }

  _onInput(event, root) {
    const search = event.target?.closest?.("[data-route-edge-search]");
    if (search && root.contains(search)) {
      this.routeSearch = String(search.value ?? "");
      this._applyRouteFilters(root);
      return;
    }
    const distance = event.target?.closest?.("[data-route-calibration-distance]");
    if (distance && root.contains(distance) && this._calibrationDraft) {
      this._calibrationDraft.distanceKm = Math.max(0, Number(fieldValue(distance)) || 0);
      return;
    }
    const opacity = event.target?.closest?.("[data-route-background-opacity]");
    if (!opacity || !root.contains(opacity)) return;
    const world = root.querySelector("[data-route-world]");
    world?.style.setProperty("--map-opacity", String(clamp(fieldValue(opacity), 0.1, 1)));
    this._scheduleMapFieldPersist("backgroundOpacity", clamp(fieldValue(opacity), 0.1, 1));
  }

  async _onSelectNode(event, element) {
    event.preventDefault();
    if (this._suppressNodeClick) {
      this._suppressNodeClick = false;
      return;
    }
    const regionId = String(element.dataset.regionId ?? "");
    if (!regionId) return;
    clearTimeout(this._nodeClickTimer);
    this._nodeClickTimer = setTimeout(() => {
      this._nodeClickTimer = 0;
      this._commitNodeSelection(regionId);
    }, 220);
  }

  async _commitNodeSelection(regionId) {
    if (!game.user?.isGM) return;
    if (!this.selectedNodeId || this.selectedNodeId === regionId) {
      this.selectedNodeId = this.selectedNodeId === regionId ? "" : regionId;
      this._updateNodeSelection();
      return;
    }
    const fromId = this.selectedNodeId;
    const routeId = makeId("route", 20);
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, this.seasonId, { normalizedRegions: true });
      const from = graph.nodes.find((row) => row.value === fromId);
      const to = graph.nodes.find((row) => row.value === regionId);
      if (!from || !to) return skip(false);
      const calculated = marketRouteDistanceKm(routePoints(from, to, [], graph.map), graph.map);
      if (!upsertEdge(regions, fromId, regionId, {
        routeId, modes: [this.newRouteMode || "airship"],
        distanceKm: calculated || LEGACY_MARKET_ROUTE_UNIT_KM,
        distanceMode: calculated > 0 ? "scaled" : "manual",
        pathPoints: [], seasonalModifiers: { winter: { ...WINTER_DEFAULTS } }
      })) return skip(false);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:add-edge", scope: "catalog" });
    this.selectedNodeId = "";
    if (saved) {
      this._refreshAll();
      this._openEdgeEditor(null, { dataset: { routeFrom: fromId, routeTo: regionId, routeId } });
    } else ui.notifications?.warn?.("Маршрут не создан: проверьте регионы и лимит 300 связей у исходной точки.");
  }

  async _onDeleteEdge(event, element) {
    event.preventDefault();
    const fromId = String(element.dataset.routeFrom ?? "");
    const toId = String(element.dataset.routeTo ?? "");
    const routeId = String(element.dataset.routeId ?? "");
    if (!fromId || !toId || !game.user?.isGM) return;
    if (!await foundryDialogV2().confirm({ window: { title: "Удалить маршрут" },
      content: "<p>Удалить этот маршрут между регионами? Действие нельзя отменить.</p>", modal: true })) return;
    const saved = await SkyholdData.transaction((data) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      removeEdge(regions, fromId, toId, routeId);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:delete-edge", scope: "catalog" });
    if (saved) {
      const editor = this._edgeEditor;
      if (editor && edgeKey(editor.fromId, editor.toId, editor.routeId) === edgeKey(fromId, toId, routeId)) await editor.close();
      this._refreshAll();
    }
  }

  _updateNodeSelection() {
    for (const node of this.element?.querySelectorAll?.("[data-route-node]") ?? []) {
      node.classList.toggle("is-selected", node.dataset.regionId === this.selectedNodeId);
    }
    const clear = this.element?.querySelector?.('[data-action="route-selection-clear"]');
    if (clear) clear.disabled = !this.selectedNodeId;
    const hint = this.element?.querySelector?.("[data-route-instructions]");
    if (hint) hint.textContent = this.selectedNodeId
      ? "Выберите второй регион — будет создан новый независимый маршрут. Escape — отмена."
      : "Тяните карту для перемещения, колесо меняет масштаб. Двойной клик открывает регион или маршрут.";
  }

  async _onDuplicateEdge(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const { routeFrom: fromId, routeTo: toId, routeId: selectedId = "" } = element.dataset;
    const routeId = makeId("route", 20);
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data.catalog.marketRouteMap, this.seasonId, { normalizedRegions: true });
      const current = graph.edges.find((edge) => edge.key === edgeKey(fromId, toId, selectedId));
      if (!current || !upsertEdge(regions, fromId, toId, { ...current, routeId })) return skip(false);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:duplicate-edge", scope: "catalog" });
    if (saved) {
      this._refreshAll();
      this._openEdgeEditor(null, { dataset: { routeFrom: fromId, routeTo: toId, routeId } });
    } else ui.notifications?.warn?.("Копия не создана: маршрут удалён или достигнут лимит 300 связей у исходной точки.");
  }

  async _onEdgeFieldChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const fromId = String(field.dataset.routeFrom ?? "");
    const toId = String(field.dataset.routeTo ?? "");
    const routeId = String(field.dataset.routeId ?? "");
    const key = String(field.dataset.routeEdgeField ?? "");
    if (!fromId || !toId || !["ursCost", "distanceKm", "distanceMode", "mode", "season-enabled", "season-cost", "season-time", "season-risk"].includes(key)) return;
    if (key === "mode" && !field.checked && !field.closest(".fbls-route-mode-toggles")?.querySelector("[data-route-edge-field=\"mode\"]:checked")) {
      field.checked = true;
      ui.notifications?.warn?.("У связи должен остаться хотя бы один вид транспорта.");
      return;
    }
    const seasonId = this._edgeEditor?.seasonId ?? this.seasonId;
    const value = fieldValue(field);
    const checked = Boolean(field.checked);
    const mode = String(field.dataset.routeMode ?? "");
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, seasonId, { normalizedRegions: true });
      const current = graph.edges.find((edge) => edge.key === edgeKey(fromId, toId, routeId));
      if (!current) return skip(false);
      const patch = {
        routeId,
        ursCost: current.ursCost,
        distanceKm: current.distanceKm,
        distanceMode: current.distanceMode,
        pathPoints: current.pathPoints,
        modes: [...current.modes],
        seasonalModifiers: JSON.parse(JSON.stringify(current.seasonalModifiers ?? {}))
      };
      if (key === "ursCost") patch.ursCost = Math.min(99, Math.max(1, Math.floor(Number(value) || 1)));
      if (key === "distanceKm") {
        patch.distanceKm = Math.max(1, Number(value) || LEGACY_MARKET_ROUTE_UNIT_KM);
        patch.distanceMode = "manual";
      }
      if (key === "distanceMode") patch.distanceMode = String(value) === "scaled" && graph.map.kmPerPixel > 0 ? "scaled" : "manual";
      if (key === "mode") {
        const modes = new Set(current.modes);
        if (checked) modes.add(mode);
        else modes.delete(mode);
        patch.modes = [...modes];
      }
      if (key.startsWith("season-")) {
        const previous = { enabled: current.seasonalEnabled, costFactor: current.seasonalCostFactor, timeFactor: current.seasonalTimeFactor, riskFactor: current.seasonalRiskFactor };
        const seasonal = { ...previous };
        if (key === "season-enabled") seasonal.enabled = checked;
        if (key === "season-cost") seasonal.costFactor = clamp(value, 0.25, 4);
        if (key === "season-time") seasonal.timeFactor = clamp(value, 0.25, 4);
        if (key === "season-risk") seasonal.riskFactor = clamp(value, 0.25, 4);
        patch.seasonalModifiers[seasonId] = seasonal;
      }
      if (patch.distanceMode === "scaled" && current.calculatedDistanceKm > 0) patch.distanceKm = current.calculatedDistanceKm;
      if (!upsertEdge(regions, fromId, toId, patch)) return skip(false);

      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: `route-graph:edge:${key}`, scope: "catalog" });
    if (saved) this._refreshAll({ incremental: true,
      skipGraph: ["season-cost", "season-time", "season-risk"].includes(key), syncEditor: false });
    return saved;
  }

  async _onSeasonPreset(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const fromId = String(element.dataset.routeFrom ?? "");
    const toId = String(element.dataset.routeTo ?? "");
    const routeId = String(element.dataset.routeId ?? "");
    if (!fromId || !toId) return;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, "winter", { normalizedRegions: true });
      const current = graph.edges.find((edge) => edge.key === edgeKey(fromId, toId, routeId));
      if (!current) return skip(false);
      const seasonalModifiers = JSON.parse(JSON.stringify(current.seasonalModifiers ?? {}));
      seasonalModifiers.winter = { ...WINTER_DEFAULTS, enabled: Boolean(current.seasonalModifiers?.winter?.enabled) };
      if (!upsertEdge(regions, fromId, toId, { routeId, distanceKm: current.distanceKm, modes: [...current.modes], seasonalModifiers })) return skip(false);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:season-preset:winter", scope: "catalog" });
    if (saved) this._refreshAll({ incremental: true });
  }

  _onPointerDown(event, root) {
    if (event.button !== 0) return;
    const node = event.target?.closest?.("[data-route-node]");
    const edgePath = event.target?.closest?.("[data-route-edge-path]");
    const canvas = event.target?.closest?.("[data-route-canvas]");
    if (!canvas || !root.contains(canvas) || event.target?.closest?.("[data-route-map-controls]")) return;
    if (event.target?.closest?.("[data-route-tool-overlay]")) return;
    const rect = canvas.getBoundingClientRect();
    if ((this._pathEdit || this._calibrationDraft) && !node && !edgePath) {
      this._toolPointState = { canvas, rect, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY };
      canvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (edgePath) return;
    if (node && game.user?.isGM) {
      const regionId = String(node.dataset.regionId ?? "");
      const incidentLines = [...canvas.querySelectorAll("[data-route-edge-path]")].filter((line) => line.dataset.routeFrom === regionId || line.dataset.routeTo === regionId);
      const lineByEdge = new Map(incidentLines.map((line) => [edgeKey(line.dataset.routeFrom, line.dataset.routeTo, line.dataset.routeId), line]));
      const incidentLabels = [...canvas.querySelectorAll("[data-route-edge-label]")]
        .filter((label) => label.dataset.routeFrom === regionId || label.dataset.routeTo === regionId)
        .map((label) => ({ label, line: lineByEdge.get(edgeKey(label.dataset.routeFrom, label.dataset.routeTo, label.dataset.routeId)) }));
      this._dragState = { node, canvas, rect, pointerId: event.pointerId, regionId, startX: event.clientX, startY: event.clientY, moved: false, x: 0, y: 0, incidentLines, incidentLabels };
      this._dragState.incidentGeometry = new Map(incidentLines.map((line) => [line, readPolylinePoints(line)]));
      node.setPointerCapture?.(event.pointerId);
      return;
    }
    this._panState = { canvas, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, centerX: this.view.centerX, centerY: this.view.centerY, moved: false };
    canvas.classList.add("is-panning");
    canvas.setPointerCapture?.(event.pointerId);
  }

  _onPointerMove(event) {
    if (this._dragState?.pointerId === event.pointerId) {
      const state = this._dragState;
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 3) state.moved = true;
      if (!state.moved) return;
      event.preventDefault();
      state.x = clamp(this.view.centerX + (event.clientX - state.rect.left - state.rect.width / 2) / this.view.zoom, 0, Number(this._world?.dataset.worldWidth) || 1000);
      state.y = clamp(this.view.centerY + (event.clientY - state.rect.top - state.rect.height / 2) / this.view.zoom, 0, Number(this._world?.dataset.worldHeight) || 600);
      if (!this._nodeDragFrame) this._nodeDragFrame = requestAnimationFrame(() => this._applyNodeDragFrame());
      return;
    }
    if (this._panState?.pointerId !== event.pointerId) return;
    const state = this._panState;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > 2) state.moved = true;
    if (!state.moved) return;
    event.preventDefault();
    this.view.centerX = state.centerX - dx / this.view.zoom;
    this.view.centerY = state.centerY - dy / this.view.zoom;
    this._clampView();
    this._scheduleViewportFrame();
  }

  _applyNodeDragFrame() {
    this._nodeDragFrame = 0;
    const state = this._dragState;
    if (!state?.moved) return;
    state.node.style.setProperty("--node-x", `${state.x}px`);
    state.node.style.setProperty("--node-y", `${state.y}px`);
    for (const line of state.incidentLines) {
      const points = state.incidentGeometry.get(line);
      if (points.length < 2) continue;
      if (line.dataset.routeFrom === state.regionId) points[0] = { x: state.x, y: state.y };
      if (line.dataset.routeTo === state.regionId) points[points.length - 1] = { x: state.x, y: state.y };
      if (points.length === 3 && line.dataset.routeDisplayOffset != null && line.dataset.routeDisplayOffset !== "") {
        const [from, , to] = points;
        const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
        const offset = Number(line.dataset.routeDisplayOffset);
        points[1] = { x: (from.x + to.x) / 2 - (to.y - from.y) / length * offset,
          y: (from.y + to.y) / 2 + (to.x - from.x) / length * offset };
      }
      line.setAttribute("points", pointsAttribute(points));
    }
    for (const { label, line } of state.incidentLabels) {
      if (!line) continue;
      const points = state.incidentGeometry.get(line);
      const midpoint = polylineMidpoint(points);
      label.setAttribute("x", midpoint.x);
      label.setAttribute("y", midpoint.y);
    }
  }

  async _onPointerUp(event) {
    if (this._toolPointState?.pointerId === event.pointerId) {
      const state = this._toolPointState;
      this._toolPointState = null;
      state.canvas.releasePointerCapture?.(event.pointerId);
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 4) return;
      const point = this._worldPointFromPointer(event, state.rect);
      if (this._calibrationDraft) {
        if (this._calibrationDraft.points.length >= 2) this._calibrationDraft.points = [];
        this._calibrationDraft.points.push(point);
        this.requestRender({ focus: false });
      } else if (this._pathEdit && this._pathEdit.points.length < 100) {
        this._pathEdit.points.push(point);
        this._updatePathPreview();
      }
      return;
    }
    if (this._dragState?.pointerId === event.pointerId) {
      const state = this._dragState;
      if (this._nodeDragFrame) globalThis.cancelAnimationFrame(this._nodeDragFrame);
      this._nodeDragFrame = 0;
      this._applyNodeDragFrame();
      this._dragState = null;
      state.node.releasePointerCapture?.(event.pointerId);
      if (!state.moved || !state.regionId) return;
      this._suppressNodeClick = true;
      setTimeout(() => { this._suppressNodeClick = false; }, 0);
      const saved = await SkyholdData.transaction((data, { skip }) => {
        const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
        const region = regions.find((row) => row.value === state.regionId);
        if (!region) return skip(false);
        region.marketMapX = Math.round(state.x);
        region.marketMapY = Math.round(state.y);
        recalculateScaledEdgeDistances(regions, data?.catalog?.marketRouteMap);
        data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
        return true;
      }, { reason: "route-graph:move-node", scope: "catalog" });
      if (saved) {
        this._refreshAll({ incremental: true });
      }
      return;
    }
    if (this._panState?.pointerId !== event.pointerId) return;
    const state = this._panState;
    this._panState = null;
    state.canvas.classList.remove("is-panning");
    state.canvas.releasePointerCapture?.(event.pointerId);
    if (state.moved) this._scheduleViewportPersist();
  }

  _worldPointFromPointer(event, rect = this._canvas?.getBoundingClientRect?.()) {
    const width = Number(this._world?.dataset.worldWidth) || 1000;
    const height = Number(this._world?.dataset.worldHeight) || 600;
    return {
      x: clamp(this.view.centerX + (event.clientX - rect.left - rect.width / 2) / this.view.zoom, 0, width),
      y: clamp(this.view.centerY + (event.clientY - rect.top - rect.height / 2) / this.view.zoom, 0, height)
    };
  }

  _onWheel(event, root) {
    const canvas = event.target?.closest?.("[data-route-canvas]");
    if (!canvas || !root.contains(canvas)) return;
    event.preventDefault();
    const rect = this._wheelRect ??= canvas.getBoundingClientRect();
    this._markZooming(canvas);
    const offsetX = event.clientX - rect.left - rect.width / 2;
    const offsetY = event.clientY - rect.top - rect.height / 2;
    const worldX = this.view.centerX + offsetX / this.view.zoom;
    const worldY = this.view.centerY + offsetY / this.view.zoom;
    const nextZoom = clamp(this.view.zoom * Math.exp(-event.deltaY * 0.0015), 0.1, 4);
    this.view.centerX = worldX - offsetX / nextZoom;
    this.view.centerY = worldY - offsetY / nextZoom;
    this.view.zoom = nextZoom;
    this._clampView();
    this._scheduleViewportFrame();
    this._scheduleViewportPersist();
  }

  _changeZoom(factor) {
    this._markZooming();
    this.view.zoom = clamp(this.view.zoom * factor, 0.1, 4);
    this._scheduleViewportFrame();
    this._scheduleViewportPersist();
  }

  _fitView() {
    this._markZooming();
    const rect = this._canvas?.getBoundingClientRect?.();
    const width = Number(this._world?.dataset.worldWidth) || 1000;
    const height = Number(this._world?.dataset.worldHeight) || 600;
    if (!rect?.width || !rect?.height) return;
    this.view = { centerX: width / 2, centerY: height / 2, zoom: clamp(Math.min(rect.width / width, rect.height / height) * 0.92, 0.1, 4) };
    this._scheduleViewportFrame();
    this._scheduleViewportPersist();
  }

  _clampView() {
    const width = Number(this._world?.dataset.worldWidth) || 1000;
    const height = Number(this._world?.dataset.worldHeight) || 600;
    this.view.centerX = clamp(this.view.centerX, 0, width);
    this.view.centerY = clamp(this.view.centerY, 0, height);
  }

  _markZooming(canvas = this._canvas) {
    canvas?.classList?.add?.("is-zooming");
    clearTimeout(this._zoomEndTimer);
    this._zoomEndTimer = setTimeout(() => {
      canvas?.classList?.remove?.("is-zooming");
      this._wheelRect = null;
    }, 160);
  }

  _scheduleViewportFrame() {
    if (this._viewportFrame) return;
    this._viewportFrame = requestAnimationFrame(() => {
      this._viewportFrame = 0;
      this._applyViewport();
    });
  }

  _applyViewport() {
    const rect = this._viewportSize ?? this._canvas?.getBoundingClientRect?.();
    if (!rect?.width || !rect?.height || !this._world || !this.view) return;
    this._world.style.transform = routeGraphViewportTransform(this.view, rect.width, rect.height);
    const label = this.element?.querySelector?.("[data-route-zoom-label]");
    const zoomText = `${Math.round(this.view.zoom * 100)}%`;
    if (label && label.textContent !== zoomText) label.textContent = zoomText;
    // Focused map buttons can scroll an overflow:hidden element; panning is transform-only.
    if (this._canvas.scrollTop) this._canvas.scrollTop = 0;
    if (this._canvas.scrollLeft) this._canvas.scrollLeft = 0;
  }

  _resetRouteFilters(root = this.element) {
    this.routeSearch = "";
    this.routeModeFilter = "";
    this.routeRegionFilter = "";
    this.routeSeasonFilter = "";
    this.routeDistanceFilter = "";
    this.routeSort = "name";
    for (const selector of ["[data-route-edge-search]", "[data-route-transport-filter]", "[data-route-region-filter]",
      "[data-route-season-filter]", "[data-route-distance-filter]"]) {
      const field = root?.querySelector?.(selector);
      if (field) field.value = "";
    }
    const sort = root?.querySelector?.("[data-route-sort]");
    if (sort) sort.value = "name";
    this._sortRouteRows(root);
    this._applyRouteFilters(root);
  }

  _sortRouteRows(root = this.element) {
    const list = root?.querySelector?.(".fbls-route-edge-list");
    if (!list) return;
    const scrollTop = list.scrollTop;
    const rows = [...list.querySelectorAll("[data-route-edge-row]")].sort((a, b) => compareRouteRows(a, b, this.routeSort));
    for (const row of rows) list.append(row);
    list.scrollTop = scrollTop;
  }

  _applyRouteFilters(root = this.element) {
    const query = this.routeSearch.trim().toLocaleLowerCase("ru");
    const visible = new Set();
    for (const row of root?.querySelectorAll?.("[data-route-edge-row]") ?? []) {
      const matchesText = !query || String(row.dataset.routeEdgeSearchText ?? "").toLocaleLowerCase("ru").includes(query);
      const matchesMode = !this.routeModeFilter || String(row.dataset.routeModes ?? "").split(" ").includes(this.routeModeFilter);
      const matchesRegion = !this.routeRegionFilter || this.routeRegionFilter === row.dataset.routeFrom || this.routeRegionFilter === row.dataset.routeTo;
      const matchesSeason = !this.routeSeasonFilter || (row.dataset.routeSeasonal === "true") === (this.routeSeasonFilter === "enabled");
      const distance = Number(row.dataset.routeDistance);
      const matchesDistance = !this.routeDistanceFilter || (this.routeDistanceFilter === "short" ? distance < 100
        : this.routeDistanceFilter === "medium" ? distance >= 100 && distance <= 500 : distance > 500);
      const hidden = !(matchesText && matchesMode && matchesRegion && matchesSeason && matchesDistance);
      if (row.hidden !== hidden) row.hidden = hidden;
      if (!row.hidden) visible.add(row.dataset.routeKey);
    }
    const advancedSummary = root?.querySelector?.("[data-route-advanced-filters] summary");
    if (advancedSummary) {
      const active = [this.routeRegionFilter, this.routeSeasonFilter, this.routeDistanceFilter].filter(Boolean).length;
      advancedSummary.textContent = `Дополнительные фильтры${active ? ` · ${active}` : ""}`;
    }
    const count = root?.querySelector?.("[data-route-result-count]");
    if (count) count.textContent = String(visible.size);
    for (const line of root?.querySelectorAll?.("[data-route-edge-path], [data-route-edge-label]") ?? []) {
      const display = visible.has(line.dataset.routeKey) ? "" : "none";
      if (line.style.display !== display) line.style.display = display;
    }
  }

  _scheduleViewportPersist() {
    this._viewportDirty = true;
    clearTimeout(this._viewportPersistTimer);
    this._viewportPersistTimer = setTimeout(() => this._persistViewport(), 220);
  }

  async _persistViewport() {
    clearTimeout(this._viewportPersistTimer);
    this._viewportPersistTimer = 0;
    if (!this.view || !this._viewportDirty) return false;
    const view = { ...this.view };
    if (routeGraphViewportsEqual(view, this._persistedViewport)) {
      this._viewportDirty = false;
      return false;
    }
    const saved = await writeRouteGraphViewport(view, this._viewportMap);
    if (saved) {
      this._persistedViewport = { ...view };
      this._viewportDirty = false;
    }
    return saved;
  }

  _scheduleMapFieldPersist(key, value) {
    clearTimeout(this._mapFieldPersistTimer);
    this._mapFieldPersistTimer = setTimeout(async () => {
      await SkyholdData.transaction((data) => {
        data.catalog ??= {};
        data.catalog.marketRouteMap = normalizeMarketRouteMap({ ...data.catalog.marketRouteMap, [key]: value });
        return true;
      }, { reason: `route-graph:map:${key}`, scope: "catalog" });
    }, 180);
  }

  _openEdgeEditor(event, element) {
    event?.preventDefault?.();
    const fromId = String(element?.dataset?.routeFrom ?? "");
    const toId = String(element?.dataset?.routeTo ?? "");
    const routeId = String(element?.dataset?.routeId ?? "");
    if (!fromId || !toId) return;
    if (this._edgeEditor?.rendered) {
      this._edgeEditor.fromId = fromId;
      this._edgeEditor.toId = toId;
      this._edgeEditor.routeId = routeId;
      this._edgeEditor.seasonId = this.seasonId;
      this._edgeEditor.requestRender({ focus: true });
      this._edgeEditor.bringToFront?.();
      return;
    }
    this._edgeEditor = new SkyholdRouteEdgeEditor({ owner: this, fromId, toId, routeId, seasonId: this.seasonId });
    this._edgeEditor.render({ force: true, focus: true });
  }

  startEdgePathEdit(fromId, toId, routeId = "") {
    const data = SkyholdData.view();
    const graph = graphContext(data?.catalog?.eventRegions, "", data?.catalog?.marketRouteMap, this.seasonId);
    const edge = graph.edges.find((row) => row.key === edgeKey(fromId, toId, routeId));
    if (!edge) return false;
    this._calibrationDraft = null;
    this._pathEdit = { fromId: edge.fromId, toId: edge.toId, routeId: edge.routeId, points: edge.pathPoints.map((point) => ({ ...point })) };
    this.requestRender({ focus: true });
    return true;
  }

  _undoPathPoint(event) {
    event.preventDefault();
    this._pathEdit?.points?.pop?.();
    this._updatePathPreview();
  }

  _updatePathPreview() {
    if (!this._pathEdit) return;
    const draft = this._pathEdit;
    const graph = this._graphCache?.graph;
    const from = graph?.nodes.find((node) => node.value === draft.fromId);
    const to = graph?.nodes.find((node) => node.value === draft.toId);
    if (!from || !to) { this.requestRender({ focus: false }); return; }
    const points = routePoints(from, to, draft.points, graph.map);
    const key = edgeKey(draft.fromId, draft.toId, draft.routeId);
    const midpoint = polylineMidpoint(points);
    for (const node of this.element?.querySelectorAll?.("[data-route-edge-path], [data-route-edge-label]") ?? []) {
      if (node.dataset.routeKey !== key) continue;
      if (node.hasAttribute("data-route-edge-path")) {
        node.setAttribute("points", pointsAttribute(points));
        node.dataset.routeDisplayOffset = "";
      }
      else { node.setAttribute("x", midpoint.x); node.setAttribute("y", midpoint.y); }
    }
    const status = this.element?.querySelector?.("[data-route-path-status]");
    if (status) status.textContent = `Промежуточных точек: ${draft.points.length}. ${graph.map.kmPerPixel > 0
      ? `Расчёт: ${marketRouteDistanceKm(points, graph.map)} км.` : "Без масштаба дальность вводится вручную."}`;
    const undo = this.element?.querySelector?.('[data-action="route-path-undo"]');
    if (undo) undo.disabled = draft.points.length === 0;
  }

  _cancelPathEdit(event) {
    event.preventDefault();
    this._pathEdit = null;
    this.requestRender({ focus: false });
  }

  async _savePathEdit(event) {
    event.preventDefault();
    if (!game.user?.isGM || !this._pathEdit) return;
    const draft = this._pathEdit;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, this.seasonId, { normalizedRegions: true });
      const edge = graph.edges.find((row) => row.key === edgeKey(draft.fromId, draft.toId, draft.routeId));
      if (!edge) return skip(false);
      const distanceMode = graph.map.kmPerPixel > 0 ? "scaled" : edge.distanceMode;
      if (!upsertEdge(regions, edge.fromId, edge.toId, {
        routeId: edge.routeId,
        ursCost: edge.ursCost,
        distanceKm: edge.distanceKm,
        distanceMode,
        pathPoints: draft.points,
        modes: edge.modes,
        seasonalModifiers: edge.seasonalModifiers
      })) return skip(false);
      recalculateScaledEdgeDistances(regions, graph.map);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:path", scope: "catalog" });
    if (!saved) return;
    this._pathEdit = null;
    this._refreshAll();
    this._edgeEditor?.requestRender?.({ focus: false });
    if (!(normalizeMarketRouteMap(SkyholdData.view()?.catalog?.marketRouteMap).kmPerPixel > 0)) ui.notifications?.warn?.("Маршрут сохранён, но автоматическая дальность появится после калибровки карты.");
  }

  _startCalibration(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    this._pathEdit = null;
    this._calibrationDraft = { points: [], distanceKm: "" };
    this.requestRender({ focus: true });
  }

  _undoCalibration(event) {
    event.preventDefault();
    this._calibrationDraft?.points?.pop?.();
    this.requestRender({ focus: false });
  }

  _cancelCalibration(event) {
    event.preventDefault();
    this._calibrationDraft = null;
    this.requestRender({ focus: false });
  }

  async _saveCalibration(event) {
    event.preventDefault();
    if (!game.user?.isGM || this._calibrationDraft?.points?.length !== 2) return;
    const distanceField = this.element?.querySelector?.("[data-route-calibration-distance]");
    const distanceKm = Math.max(0, Number(distanceField?.value ?? this._calibrationDraft.distanceKm) || 0);
    const pixelDistance = marketRoutePolylineLength(this._calibrationDraft.points);
    if (!(distanceKm > 0) || !(pixelDistance > 0)) return ui.notifications?.warn?.("Укажите ненулевое расстояние между двумя мерными точками.");
    const points = this._calibrationDraft.points.map((point) => ({ ...point }));
    const saved = await SkyholdData.transaction((data) => {
      data.catalog ??= {};
      const map = normalizeMarketRouteMap({
        ...data.catalog.marketRouteMap,
        kmPerPixel: distanceKm / pixelDistance,
        calibration: { pointA: points[0], pointB: points[1], distanceKm }
      });
      const regions = normalizeEventRegionOptions(data.catalog.eventRegions, { fallback: false });
      recalculateScaledEdgeDistances(regions, map);
      data.catalog.marketRouteMap = map;
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:calibration", scope: "catalog" });
    if (!saved) return;
    this._calibrationDraft = null;
    this._refreshAll();
    this._edgeEditor?.requestRender?.({ focus: false });
    ui.notifications?.info?.(`Масштаб карты сохранён: ${Math.round(distanceKm / pixelDistance * 100000) / 1000} км на 100 px.`);
  }

  _onPickBackground(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const current = String(SkyholdData.view()?.catalog?.marketRouteMap?.background ?? "");
    renderFoundryFilePicker({
      type: "image",
      current,
      callback: (picked) => this._saveBackground(String(picked ?? ""))
    });
  }

  async _saveBackground(path) {
    if (!path) return;
    const dimensions = await imageDimensions(path);
    const saved = await SkyholdData.transaction((data) => {
      data.catalog ??= {};
      const current = normalizeMarketRouteMap(data.catalog.marketRouteMap);
      const patch = { ...current, background: path };
      if (dimensions?.width && dimensions?.height) {
        patch.worldWidth = dimensions.width;
        patch.worldHeight = dimensions.height;
        patch.centerX = dimensions.width / 2;
        patch.centerY = dimensions.height / 2;
        patch.kmPerPixel = 0;
        patch.calibration = null;
      }
      data.catalog.marketRouteMap = normalizeMarketRouteMap(patch);
      return true;
    }, { reason: "route-graph:background", scope: "catalog" });
    if (saved) {
      const map = normalizeMarketRouteMap(SkyholdData.view()?.catalog?.marketRouteMap);
      this._viewportMap = map;
      this.view = { centerX: map.centerX, centerY: map.centerY, zoom: map.zoom };
      this._scheduleViewportPersist();
      this._refreshAll();
    }
  }

  async _onRemoveBackground(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const saved = await SkyholdData.transaction((data) => {
      data.catalog ??= {};
      data.catalog.marketRouteMap = normalizeMarketRouteMap({ ...data.catalog.marketRouteMap, background: "" });
      return true;
    }, { reason: "route-graph:background-remove", scope: "catalog" });
    if (saved) this._refreshAll();
  }

  async _onNodeMode(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const nodeMode = String(element.dataset.nodeMode ?? "") === "compact" ? "compact" : "card";
    const saved = await SkyholdData.transaction((data) => {
      data.catalog ??= {};
      data.catalog.marketRouteMap = normalizeMarketRouteMap({ ...data.catalog.marketRouteMap, nodeMode });
      return true;
    }, { reason: "route-graph:node-mode", scope: "catalog" });
    if (saved) this.requestRender({ focus: false });
  }

  async _onResetLayout(event) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const saved = await SkyholdData.transaction((data) => {
      const map = normalizeMarketRouteMap(data?.catalog?.marketRouteMap);
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      regions.forEach((region, index) => {
        const position = defaultPosition(index, regions.length, map);
        region.marketMapX = position.x;
        region.marketMapY = position.y;
      });
      recalculateScaledEdgeDistances(regions, map);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:reset-layout", scope: "catalog" });
    if (saved) this._refreshAll();
  }

  _refreshAll({ incremental = false, skipGraph = false, syncEditor = true } = {}) {
    this._catalogChanged = true;
    this._preservedMapBackground = this.element?.querySelector?.(".fbls-route-map-background") ?? null;
    if (!skipGraph && (!incremental || !this._syncGraph())) this.requestRender({ focus: false });
    if (syncEditor && this._edgeEditor?.rendered) this._edgeEditor._syncFields();
  }

  _syncGraph() {
    if (this._pathEdit || this._calibrationDraft) return false;
    const graph = this._graphForView(SkyholdData.view());
    const byKey = new Map(graph.edges.map((edge) => [edge.key, edge]));
    const root = this.element;
    const lines = [...(root?.querySelectorAll?.("[data-route-edge-path]") ?? [])];
    if (lines.length !== graph.edges.length || lines.some((line) => !byKey.has(line.dataset.routeKey))) return false;
    const changed = new Set();
    let sortAffected = false;
    for (const edge of graph.edges) {
      const previous = this._displayedEdges?.get(edge.key);
      const needsUpdate = !previous || previous.pointsText !== edge.pointsText || previous.routeLabel !== edge.routeLabel
        || previous.ursCost !== edge.ursCost || previous.distanceKm !== edge.distanceKm
        || previous.automaticDistance !== edge.automaticDistance || previous.seasonalEnabled !== edge.seasonalEnabled
        || previous.fromLabel !== edge.fromLabel || previous.toLabel !== edge.toLabel
        || this._displayedSeason !== this.seasonId;
      if (!needsUpdate) continue;
      changed.add(edge.key);
      if (!previous || (this.routeSort === "urs-desc" && previous.ursCost !== edge.ursCost)
        || (this.routeSort.startsWith("distance-") && previous.distanceKm !== edge.distanceKm)
        || (this.routeSort === "transport" && previous.modesText !== edge.modesText)
        || (["name", "name-desc"].includes(this.routeSort) && (previous.fromLabel !== edge.fromLabel
          || previous.toLabel !== edge.toLabel || previous.modesLabel !== edge.modesLabel))) sortAffected = true;
    }
    for (const line of lines) {
      if (!changed.has(line.dataset.routeKey)) continue;
      const edge = byKey.get(line.dataset.routeKey);
      line.setAttribute("points", edge.pointsText);
      line.dataset.routeDisplayOffset = edge.displayOffset ?? "";
      line.dataset.routeModes = edge.modesText;
      line.classList.toggle("is-seasonal", edge.seasonalEnabled);
    }
    for (const label of root.querySelectorAll("[data-route-edge-label]")) {
      if (!changed.has(label.dataset.routeKey)) continue;
      const edge = byKey.get(label.dataset.routeKey);
      label.setAttribute("x", edge.midX);
      label.setAttribute("y", edge.midY);
      label.textContent = this._edgeSummary(edge, graph);
    }
    for (const row of root.querySelectorAll("[data-route-edge-row]")) {
      if (!changed.has(row.dataset.routeKey)) continue;
      const edge = byKey.get(row.dataset.routeKey);
      row.dataset.routeModes = edge.modesText;
      row.dataset.routeDistance = String(edge.distanceKm);
      row.dataset.routeUrs = String(edge.ursCost);
      row.dataset.routeSeasonal = String(edge.seasonalEnabled);
      const summary = row.querySelector("small");
      if (summary) summary.textContent = this._edgeSummary(edge, graph) + (edge.pathPointCount ? " · " + edge.pathPointCount + " т." : "");
      row.dataset.routeEdgeSearchText = [edge.fromLabel, edge.toLabel, edge.fromShort, edge.toShort, edge.modesLabel].join(" ");
      const modes = row.querySelector(".fbls-route-edge-modes");
      if (modes?.title === edge.modesLabel) continue;
      if (modes) modes.title = edge.modesLabel;
      for (const icon of row.querySelectorAll(".fbls-route-edge-modes i")) icon.remove();
      for (const mode of edge.modes) {
        const icon = document.createElement("i");
        icon.className = "fa-solid " + ({ caravan: "fa-cart-flatbed", rail: "fa-train", airship: "fa-ship" }[mode]);
        modes?.append(icon);
      }
    }
    this._displayedEdges = byKey;
    this._displayedSeason = this.seasonId;
    if (changed.size) {
      if (sortAffected) this._sortRouteRows(root);
      this._applyRouteFilters(root);
    }
    return true;
  }

  _edgeSummary(edge, graph) {
    return edge.routeLabel + " · УРС " + edge.ursCost + " · " + edge.distanceKm + " км"
      + (edge.automaticDistance ? " · авто" : "") + (edge.seasonalEnabled ? " · " + graph.selectedSeasonLabel : "");
  }

  async _exportNetwork() {
    if (!game.user?.isGM) return;
    const { exportRouteNetwork } = await import("./route-network-transfer.js");
    const json = JSON.stringify(exportRouteNetwork(SkyholdData.view().catalog), null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "skyhold-trade-network.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  _importNetwork() {
    if (!game.user?.isGM) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        if (file.size > 5 * 1024 * 1024) throw new Error("Файл больше 5 МБ.");
        const { parseRouteNetwork, mergeRouteNetwork } = await import("./route-network-transfer.js");
        const network = parseRouteNetwork(JSON.parse(await file.text()));
        mergeRouteNetwork(SkyholdData.view().catalog, network);
        const routeCount = network.eventRegions.reduce((count, row) => count + row.marketLinks.length, 0);
        const confirmed = await foundryDialogV2()?.confirm({ window: { title: "Импорт торговой сети" },
          content: "<p>Рынков: " + network.eventRegions.length + "; связей: " + routeCount
            + ".</p><p>Рынки с совпадающими ID будут обновлены, одноимённые маршруты заменены. Остальные рынки и связи сохранятся. Настройки карты и экономики будут заменены; справочники стран, товаров и организаций объединены по ID.</p>", modal: true });
        if (!confirmed || !game.user?.isGM) return;
        const saved = await SkyholdData.transaction((data) => {
          const merged = mergeRouteNetwork(data.catalog, network);
          data.catalog.eventRegions = merged.eventRegions;
          data.catalog.marketRouteMap = merged.marketRouteMap;
          data.catalog.marketEconomy = merged.marketEconomy;
          return true;
        }, { reason: "route-graph:import", scope: "catalog" });
        if (!saved) return;
        this._pathEdit = null;
        this._calibrationDraft = null;
        this._refreshAll();
        ui.notifications?.info?.("Торговая сеть импортирована.");
      } catch (error) { ui.notifications?.error?.("Импорт отменён: " + error.message); }
    }, { once: true });
    input.click();
  }

  async _onClose(options) {
    clearTimeout(this._viewportPersistTimer);
    clearTimeout(this._mapFieldPersistTimer);
    clearTimeout(this._nodeClickTimer);
    clearTimeout(this._zoomEndTimer);
    if (this._viewportFrame) globalThis.cancelAnimationFrame(this._viewportFrame);
    if (this._nodeDragFrame) globalThis.cancelAnimationFrame(this._nodeDragFrame);
    await this._persistViewport();
    if (this._edgeEditor?.rendered) await this._edgeEditor.close();
    await super._onClose(options);
    if (this._catalogChanged) requestSkyholdAppRender();
    this._graphAbortController?.abort?.();
    this._resizeObserver?.disconnect?.();
  }
}

export class SkyholdRouteEdgeEditor extends FloatingTooltipsMixin(PendingFieldSavesMixin(RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)))) {
  constructor({ owner = null, fromId = "", toId = "", routeId = "", seasonId = "winter" } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.fromId = String(fromId ?? "");
    this.toId = String(toId ?? "");
    this.routeId = String(routeId ?? "");
    this.seasonId = SEASONS.some((row) => row.id === seasonId) ? seasonId : "winter";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const graph = this.owner?._graphForView(data, this.seasonId)
      ?? graphContext(data?.catalog?.eventRegions, "", data?.catalog?.marketRouteMap, this.seasonId);
    const edge = graph.edges.find((row) => row.key === edgeKey(this.fromId, this.toId, this.routeId)) ?? null;
    if (edge) {
      edge.manualDistance = !edge.scaledDistanceSelected;
      edge.seasonOptions = graph.seasonOptions;
      edge.selectedSeasonLabel = graph.selectedSeasonLabel;
      edge.winterSelected = graph.winterSelected;
    }
    return { ...context, canEdit: Boolean(game.user?.isGM), edge, hasEdge: Boolean(edge), graph };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    this._edgeAbortController?.abort?.();
    const controller = new AbortController();
    this._edgeAbortController = controller;
    root.addEventListener("change", (event) => dispatchDelegatedAction(this, event, event.target, async () => {
      const season = event.target?.closest?.("[data-route-edge-season]");
      if (season && root.contains(season)) {
        this.seasonId = SEASONS.some((row) => row.id === season.value) ? season.value : "winter";
        this.owner.seasonId = this.seasonId;
        this._syncFields({ seasonChanged: true });
        this.owner._syncGraph();
        return;
      }
      const field = event.target?.closest?.("[data-route-edge-field]");
      if (!field || !root.contains(field)) return;
      await this._saveEdgeField(event, field);
    }), { signal: controller.signal });
    root.addEventListener("click", (event) => dispatchDelegatedAction(this, event, event.target, async () => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "route-edge-path-edit") {
        event.preventDefault();
        this.owner?.startEdgePathEdit?.(this.fromId, this.toId, this.routeId);
        this.owner?.bringToFront?.();
      } else if (action === "route-edge-delete") {
        await this.owner?._onDeleteEdge?.(event, element);
      } else if (action === "route-edge-duplicate") {
        await this.owner?._onDuplicateEdge?.(event, element);
      } else if (action === "route-season-preset") {
        await this.owner?._onSeasonPreset?.(event, element);
      }
    }), { signal: controller.signal });
  }

  async _saveEdgeField(event, field) {
    this._pendingFields ??= new Map();
    const token = {};
    this._pendingFields.set(field, token);
    let saved = false;
    let failure = null;
    let latestForField = false;
    try { saved = await this.owner?._onEdgeFieldChange?.(event, field); }
    catch (error) { failure = error; }
    finally {
      latestForField = this._pendingFields.get(field) === token;
      if (latestForField) this._pendingFields.delete(field);
    }
    this._syncFields({ forceField: !saved && latestForField ? field : null });
    if (failure) throw failure;
    return saved;
  }

  _syncFields({ seasonChanged = false, forceField = null } = {}) {
    const root = this.element;
    if (!root) return;
    const graph = this.owner._graphForView(SkyholdData.view(), this.seasonId);
    const edge = graph.edges.find((row) => row.key === edgeKey(this.fromId, this.toId, this.routeId));
    if (!edge) { this.close(); return; }
    const values = { ursCost: edge.ursCost, distanceKm: edge.distanceKm, distanceMode: edge.distanceMode,
      "season-enabled": edge.seasonalEnabled, "season-cost": edge.seasonalCostFactor,
      "season-time": edge.seasonalTimeFactor, "season-risk": edge.seasonalRiskFactor };
    for (const field of root.querySelectorAll("[data-route-edge-field]")) {
      const key = field.dataset.routeEdgeField;
      if (key === "distanceKm") field.disabled = edge.automaticDistance;
      // Preserve text being entered while an earlier asynchronous save completes.
      if (!seasonChanged && field !== forceField
        && (field === root.ownerDocument.activeElement || this._pendingFields?.has(field))) continue;
      if (key === "mode") field.checked = edge.modes.includes(field.dataset.routeMode);
      else if (field.type === "checkbox") field.checked = Boolean(values[key]);
      else field.value = key === "distanceMode" ? (edge.scaledDistanceSelected ? "scaled" : "manual") : values[key];
    }
    const summary = root.querySelector(".fbls-route-edge-editor-hero p");
    if (summary) summary.textContent = edge.distanceKm + " км · " + edge.routeLabel;
    const seasonToggle = root.querySelector(".fbls-route-season-toggle");
    const seasonLabel = seasonToggle?.querySelector?.("span");
    if (seasonLabel) seasonLabel.textContent = graph.selectedSeasonLabel + " влияет на маршрут";
    if (seasonToggle?.dataset) seasonToggle.dataset.fblsTooltip = `Сезон «${graph.selectedSeasonLabel}» влияет на маршрут. Применять множители цены, времени и риска.`;
    const preset = root.querySelector('[data-action="route-season-preset"]');
    if (preset) preset.hidden = !graph.winterSelected;
  }

  async _onClose(options) {
    await super._onClose(options);
    this._edgeAbortController?.abort?.();
    if (this.owner?._edgeEditor === this) this.owner._edgeEditor = null;
  }
}

SkyholdRouteGraphEditor.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-route-graph-editor",
  classes: ["fbl-skyhold", "fbl-skyhold-route-graph-editor"],
  tag: "section",
  window: { title: "Карта торговых маршрутов", icon: "fa-solid fa-map-location-dot", resizable: true },
  position: { width: 1320, height: 860 }
};

SkyholdRouteGraphEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/route-graph-editor.hbs` }
};

SkyholdRouteEdgeEditor.DEFAULT_OPTIONS = {
  id: "fbl-skyhold-route-edge-editor",
  classes: ["fbl-skyhold", "fbl-skyhold-route-edge-editor"],
  tag: "section",
  window: { title: "Редактор торгового маршрута", icon: "fa-solid fa-route", resizable: true },
  position: { width: 580, height: 700 }
};

SkyholdRouteEdgeEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/route-edge-editor.hbs` }
};
