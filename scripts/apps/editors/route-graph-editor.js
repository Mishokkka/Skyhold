import { MODULE_ID } from "../../data/constants.js";
import { LEGACY_MARKET_ROUTE_UNIT_KM, normalizeEventRegionOptions } from "../../data/random-events.js";
import { marketRouteDistanceKm, marketRoutePolylineLength, normalizeMarketRouteMap } from "../../data/market/route-map.js";
import { SkyholdData } from "../../data/store.js";
import { fieldValue } from "../../core/helpers.js";
import { renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";
import { requestSkyholdAppRender } from "../registry.js";
import { RenderSchedulerMixin } from "../common/render-scheduler.js";
import { readRouteGraphViewport, routeGraphViewportsEqual, writeRouteGraphViewport } from "./route-graph-viewport.js";
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

function graphContext(regionRows = [], selectedNodeId = "", mapSource = {}, selectedSeasonId = "winter") {
  const map = normalizeMarketRouteMap(mapSource);
  const regions = normalizeEventRegionOptions(regionRows, { fallback: false });
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
      const key = edgeKey(region.value, link.regionId);
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
      const seasonal = seasonalModifiers[selectedSeasonId] ?? { enabled: false, costFactor: 1, timeFactor: 1, riskFactor: 1 };
      edges.push({
        key,
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
        scaleAvailable: map.kmPerPixel > 0,
        fromShort: edgeLocationLabel(from.label),
        toShort: edgeLocationLabel(to.label),
        modes,
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

export class SkyholdRouteGraphEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
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
  }

  static open({ owner = null } = {}) {
    const app = new this({ owner });
    app.render({ force: true, focus: true });
    return app;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const graph = graphContext(data?.catalog?.eventRegions, this.selectedNodeId, data?.catalog?.marketRouteMap, this.seasonId);
    if (this.selectedNodeId && !graph.selectedNode) this.selectedNodeId = "";
    if (!this.view) {
      this._viewportMap = graph.map;
      this.view = readRouteGraphViewport(graph.map);
      this._persistedViewport = { ...this.view };
    } else {
      this._viewportMap = graph.map;
    }
    if (this._pathEdit) {
      const edge = graph.edges.find((row) => row.key === edgeKey(this._pathEdit.fromId, this._pathEdit.toId));
      const from = graph.nodes.find((row) => row.value === this._pathEdit.fromId);
      const to = graph.nodes.find((row) => row.value === this._pathEdit.toId);
      if (!edge || !from || !to) this._pathEdit = null;
      else {
        const points = routePoints(from, to, this._pathEdit.points, graph.map);
        edge.points = points;
        edge.pointsText = pointsAttribute(points);
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
    return { ...context, canEdit: Boolean(game.user?.isGM), graph };
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
    root.addEventListener("click", (event) => this._onClick(event, root), listenerOptions);
    root.addEventListener("dblclick", (event) => this._onDoubleClick(event, root), listenerOptions);
    root.addEventListener("change", (event) => this._onChange(event, root), listenerOptions);
    root.addEventListener("input", (event) => this._onInput(event, root), listenerOptions);
    root.addEventListener("pointerdown", (event) => this._onPointerDown(event, root), listenerOptions);
    root.addEventListener("pointermove", (event) => this._onPointerMove(event), listenerOptions);
    root.addEventListener("pointerup", (event) => this._onPointerUp(event), listenerOptions);
    root.addEventListener("pointercancel", (event) => this._onPointerUp(event), listenerOptions);
    root.addEventListener("wheel", (event) => this._onWheel(event, root), { signal: controller.signal, passive: false });
    this._canvas = root.querySelector("[data-route-canvas]");
    this._world = root.querySelector("[data-route-world]");
    if (this._canvas && this._world) {
      this._resizeObserver = new ResizeObserver(() => this._scheduleViewportFrame());
      this._resizeObserver.observe(this._canvas);
      this._scheduleViewportFrame();
    }
  }

  _onClick(event, root) {
    const element = event.target?.closest?.("[data-action]");
    if (!element || !root.contains(element)) return;
    const action = String(element.dataset.action ?? "");
    if (action === "route-node-select") this._onSelectNode(event, element);
    else if (action === "route-edge-delete") this._onDeleteEdge(event, element);
    else if (action === "route-edge-open") this._openEdgeEditor(event, element);
    else if (action === "route-layout-reset") this._onResetLayout(event);
    else if (action === "route-background-pick") this._onPickBackground(event);
    else if (action === "route-background-remove") this._onRemoveBackground(event);
    else if (action === "route-zoom-in") this._changeZoom(1.2);
    else if (action === "route-zoom-out") this._changeZoom(1 / 1.2);
    else if (action === "route-zoom-fit") this._fitView();
    else if (action === "route-node-mode") this._onNodeMode(event, element);
    else if (action === "route-season-preset") this._onSeasonPreset(event, element);
    else if (action === "route-calibration-start") this._startCalibration(event);
    else if (action === "route-calibration-undo") this._undoCalibration(event);
    else if (action === "route-calibration-save") this._saveCalibration(event);
    else if (action === "route-calibration-cancel") this._cancelCalibration(event);
    else if (action === "route-path-undo") this._undoPathPoint(event);
    else if (action === "route-path-save") this._savePathEdit(event);
    else if (action === "route-path-cancel") this._cancelPathEdit(event);
    else if (action === "route-selection-clear") {
      event.preventDefault();
      this.selectedNodeId = "";
      this.requestRender({ focus: false });
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
    const season = event.target?.closest?.("[data-route-season]");
    if (season && root.contains(season)) {
      this.seasonId = SEASONS.some((row) => row.id === season.value) ? season.value : "winter";
      this.requestRender({ focus: false });
      return;
    }
    const field = event.target?.closest?.("[data-route-edge-field]");
    if (field && root.contains(field)) this._onEdgeFieldChange(event, field);
  }

  _onInput(event, root) {
    const search = event.target?.closest?.("[data-route-edge-search]");
    if (search && root.contains(search)) {
      const query = String(search.value ?? "").trim().toLocaleLowerCase("ru");
      for (const row of root.querySelectorAll("[data-route-edge-row]")) {
        const haystack = String(row.dataset.routeEdgeSearchText ?? "").toLocaleLowerCase("ru");
        row.hidden = Boolean(query) && !haystack.includes(query);
      }
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
    if (!this.selectedNodeId || this.selectedNodeId === regionId) {
      this.selectedNodeId = this.selectedNodeId === regionId ? "" : regionId;
      this.requestRender({ focus: false });
      return;
    }
    const fromId = this.selectedNodeId;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, this.seasonId);
      const from = graph.nodes.find((row) => row.value === fromId);
      const to = graph.nodes.find((row) => row.value === regionId);
      if (!from || !to) return skip(false);
      const calculated = marketRouteDistanceKm(routePoints(from, to, [], graph.map), graph.map);
      if (!upsertEdge(regions, fromId, regionId, {
        distanceKm: calculated || LEGACY_MARKET_ROUTE_UNIT_KM,
        distanceMode: calculated > 0 ? "scaled" : "manual",
        pathPoints: []
      })) return skip(false);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:add-edge", scope: "catalog" });
    this.selectedNodeId = "";
    if (saved) this._refreshAll();
  }

  async _onDeleteEdge(event, element) {
    event.preventDefault();
    const fromId = String(element.dataset.routeFrom ?? "");
    const toId = String(element.dataset.routeTo ?? "");
    if (!fromId || !toId || !game.user?.isGM) return;
    const saved = await SkyholdData.transaction((data) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      removeEdge(regions, fromId, toId);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:delete-edge", scope: "catalog" });
    if (saved) this._refreshAll();
  }

  async _onEdgeFieldChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const fromId = String(field.dataset.routeFrom ?? "");
    const toId = String(field.dataset.routeTo ?? "");
    const key = String(field.dataset.routeEdgeField ?? "");
    if (!fromId || !toId || !["ursCost", "distanceKm", "distanceMode", "mode", "season-enabled", "season-cost", "season-time", "season-risk"].includes(key)) return;
    if (key === "mode" && !field.checked && !field.closest(".fbls-route-mode-toggles")?.querySelector("[data-route-edge-field=\"mode\"]:checked")) {
      field.checked = true;
      ui.notifications?.warn?.("У связи должен остаться хотя бы один вид транспорта.");
      return;
    }
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, this.seasonId);
      const current = graph.edges.find((edge) => edge.key === edgeKey(fromId, toId));
      if (!current) return skip(false);
      const patch = {
        ursCost: current.ursCost,
        distanceKm: current.distanceKm,
        distanceMode: current.distanceMode,
        pathPoints: current.pathPoints,
        modes: [...current.modes],
        seasonalModifiers: JSON.parse(JSON.stringify(current.seasonalModifiers ?? {}))
      };
      if (key === "ursCost") patch.ursCost = Math.min(99, Math.max(1, Math.floor(Number(fieldValue(field)) || 1)));
      if (key === "distanceKm") {
        patch.distanceKm = Math.max(1, Number(fieldValue(field)) || LEGACY_MARKET_ROUTE_UNIT_KM);
        patch.distanceMode = "manual";
      }
      if (key === "distanceMode") patch.distanceMode = String(fieldValue(field)) === "scaled" && graph.map.kmPerPixel > 0 ? "scaled" : "manual";
      if (key === "mode") {
        const mode = String(field.dataset.routeMode ?? "");
        const modes = new Set(current.modes);
        if (field.checked) modes.add(mode);
        else modes.delete(mode);
        patch.modes = [...modes];
      }
      if (key.startsWith("season-")) {
        const previous = patch.seasonalModifiers[this.seasonId] ?? { enabled: false, costFactor: 1, timeFactor: 1, riskFactor: 1 };
        const seasonal = { ...previous };
        if (key === "season-enabled") seasonal.enabled = Boolean(field.checked);
        if (key === "season-cost") seasonal.costFactor = clamp(fieldValue(field), 0.25, 4);
        if (key === "season-time") seasonal.timeFactor = clamp(fieldValue(field), 0.25, 4);
        if (key === "season-risk") seasonal.riskFactor = clamp(fieldValue(field), 0.25, 4);
        patch.seasonalModifiers[this.seasonId] = seasonal;
      }
      upsertEdge(regions, fromId, toId, patch);
      recalculateScaledEdgeDistances(regions, graph.map);
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: `route-graph:edge:${key}`, scope: "catalog" });
    if (saved) this._refreshAll();
    return saved;
  }

  async _onSeasonPreset(event, element) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const fromId = String(element.dataset.routeFrom ?? "");
    const toId = String(element.dataset.routeTo ?? "");
    if (!fromId || !toId) return;
    const saved = await SkyholdData.transaction((data, { skip }) => {
      const regions = normalizeEventRegionOptions(data?.catalog?.eventRegions, { fallback: false });
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, "winter");
      const current = graph.edges.find((edge) => edge.key === edgeKey(fromId, toId));
      if (!current) return skip(false);
      const seasonalModifiers = JSON.parse(JSON.stringify(current.seasonalModifiers ?? {}));
      seasonalModifiers.winter = { enabled: true, costFactor: 1.4, timeFactor: 1.25, riskFactor: 1.2 };
      upsertEdge(regions, fromId, toId, { distanceKm: current.distanceKm, modes: [...current.modes], seasonalModifiers });
      data.catalog.eventRegions = normalizeEventRegionOptions(regions, { fallback: false });
      return true;
    }, { reason: "route-graph:season-preset:winter", scope: "catalog" });
    if (saved) this._refreshAll();
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
      const lineByEdge = new Map(incidentLines.map((line) => [edgeKey(line.dataset.routeFrom, line.dataset.routeTo), line]));
      const incidentLabels = [...canvas.querySelectorAll("[data-route-edge-label]")]
        .filter((label) => label.dataset.routeFrom === regionId || label.dataset.routeTo === regionId)
        .map((label) => ({ label, line: lineByEdge.get(edgeKey(label.dataset.routeFrom, label.dataset.routeTo)) }));
      this._dragState = { node, canvas, rect, pointerId: event.pointerId, regionId, startX: event.clientX, startY: event.clientY, moved: false, x: 0, y: 0, incidentLines, incidentLabels };
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
      const points = String(line.getAttribute("points") ?? "").trim().split(/\s+/).map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x, y };
      }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      if (points.length < 2) continue;
      if (line.dataset.routeFrom === state.regionId) points[0] = { x: state.x, y: state.y };
      if (line.dataset.routeTo === state.regionId) points[points.length - 1] = { x: state.x, y: state.y };
      line.setAttribute("points", pointsAttribute(points));
    }
    for (const { label, line } of state.incidentLabels) {
      if (!line) continue;
      const points = String(line.getAttribute("points") ?? "").trim().split(/\s+/).map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x, y };
      }).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
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
      } else if (this._pathEdit) this._pathEdit.points.push(point);
      this.requestRender({ focus: false });
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
        requestSkyholdAppRender();
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
    const rect = canvas.getBoundingClientRect();
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
    this.view.zoom = clamp(this.view.zoom * factor, 0.1, 4);
    this._scheduleViewportFrame();
    this._scheduleViewportPersist();
  }

  _fitView() {
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

  _scheduleViewportFrame() {
    if (this._viewportFrame) return;
    this._viewportFrame = requestAnimationFrame(() => {
      this._viewportFrame = 0;
      const rect = this._canvas?.getBoundingClientRect?.();
      if (!rect || !this._world || !this.view) return;
      const x = rect.width / 2 - this.view.centerX * this.view.zoom;
      const y = rect.height / 2 - this.view.centerY * this.view.zoom;
      this._world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${this.view.zoom})`;
      const label = this.element?.querySelector?.("[data-route-zoom-label]");
      if (label) label.textContent = `${Math.round(this.view.zoom * 100)}%`;
    });
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
    if (!fromId || !toId) return;
    if (this._edgeEditor?.rendered) {
      this._edgeEditor.fromId = fromId;
      this._edgeEditor.toId = toId;
      this._edgeEditor.seasonId = this.seasonId;
      this._edgeEditor.requestRender({ focus: true });
      this._edgeEditor.bringToFront?.();
      return;
    }
    this._edgeEditor = new SkyholdRouteEdgeEditor({ owner: this, fromId, toId, seasonId: this.seasonId });
    this._edgeEditor.render({ force: true, focus: true });
  }

  startEdgePathEdit(fromId, toId) {
    const data = SkyholdData.view();
    const graph = graphContext(data?.catalog?.eventRegions, "", data?.catalog?.marketRouteMap, this.seasonId);
    const edge = graph.edges.find((row) => row.key === edgeKey(fromId, toId));
    if (!edge) return false;
    this._calibrationDraft = null;
    this._pathEdit = { fromId: edge.fromId, toId: edge.toId, points: edge.pathPoints.map((point) => ({ ...point })) };
    this.requestRender({ focus: true });
    return true;
  }

  _undoPathPoint(event) {
    event.preventDefault();
    this._pathEdit?.points?.pop?.();
    this.requestRender({ focus: false });
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
      const graph = graphContext(regions, "", data?.catalog?.marketRouteMap, this.seasonId);
      const edge = graph.edges.find((row) => row.key === edgeKey(draft.fromId, draft.toId));
      if (!edge) return skip(false);
      const distanceMode = graph.map.kmPerPixel > 0 ? "scaled" : edge.distanceMode;
      upsertEdge(regions, edge.fromId, edge.toId, {
        ursCost: edge.ursCost,
        distanceKm: edge.distanceKm,
        distanceMode,
        pathPoints: draft.points,
        modes: edge.modes,
        seasonalModifiers: edge.seasonalModifiers
      });
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

  _refreshAll() {
    requestSkyholdAppRender();
    this._preservedMapBackground = this.element?.querySelector?.(".fbls-route-map-background") ?? null;
    this.requestRender({ focus: false });
  }

  async _onClose(options) {
    clearTimeout(this._viewportPersistTimer);
    clearTimeout(this._mapFieldPersistTimer);
    clearTimeout(this._nodeClickTimer);
    if (this._viewportFrame) globalThis.cancelAnimationFrame(this._viewportFrame);
    if (this._nodeDragFrame) globalThis.cancelAnimationFrame(this._nodeDragFrame);
    await this._persistViewport();
    if (this._edgeEditor?.rendered) await this._edgeEditor.close();
    await super._onClose(options);
    this._graphAbortController?.abort?.();
    this._resizeObserver?.disconnect?.();
  }
}

export class SkyholdRouteEdgeEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ owner = null, fromId = "", toId = "", seasonId = "winter" } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.fromId = String(fromId ?? "");
    this.toId = String(toId ?? "");
    this.seasonId = SEASONS.some((row) => row.id === seasonId) ? seasonId : "winter";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const data = SkyholdData.view();
    const graph = graphContext(data?.catalog?.eventRegions, "", data?.catalog?.marketRouteMap, this.seasonId);
    const edge = graph.edges.find((row) => row.key === edgeKey(this.fromId, this.toId)) ?? null;
    if (edge) {
      edge.manualDistance = !edge.automaticDistance;
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
    root.addEventListener("change", async (event) => {
      const season = event.target?.closest?.("[data-route-edge-season]");
      if (season && root.contains(season)) {
        this.seasonId = SEASONS.some((row) => row.id === season.value) ? season.value : "winter";
        this.owner.seasonId = this.seasonId;
        this.requestRender({ focus: false });
        return;
      }
      const field = event.target?.closest?.("[data-route-edge-field]");
      if (!field || !root.contains(field)) return;
      const saved = await this.owner?._onEdgeFieldChange?.(event, field);
      if (saved && field.dataset.routeEdgeField === "distanceMode") {
        const distance = root.querySelector?.('[data-route-edge-field="distanceKm"]');
        if (distance) distance.disabled = String(field.value ?? "") === "scaled";
      }
    }, { signal: controller.signal });
    root.addEventListener("click", async (event) => {
      const element = event.target?.closest?.("[data-action]");
      if (!element || !root.contains(element)) return;
      const action = String(element.dataset.action ?? "");
      if (action === "route-edge-path-edit") {
        event.preventDefault();
        this.owner?.startEdgePathEdit?.(this.fromId, this.toId);
        this.owner?.bringToFront?.();
      } else if (action === "route-edge-delete") {
        await this.owner?._onDeleteEdge?.(event, element);
        await this.close();
      } else if (action === "route-season-preset") {
        await this.owner?._onSeasonPreset?.(event, element);
        this.requestRender({ focus: false });
      }
    }, { signal: controller.signal });
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
  position: { width: 520, height: 610 }
};

SkyholdRouteEdgeEditor.PARTS = {
  body: { template: `modules/${MODULE_ID}/templates/route-edge-editor.hbs` }
};
