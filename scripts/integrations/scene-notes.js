import { MODULE_ID } from "../data/constants.js";
import { HoldingService } from "../data/holding-service.js";
import { canReadHolding } from "../data/access-guard.js";
import { loadBuildingEditorClass } from "../apps/lazy-apps.js";
import { foundryDoubleClickThresholds } from "./foundry-runtime.js";

const BUILDING_NOTE_TOOLTIP_DELAY_MS = 1000;
const BUILDING_NOTE_ICON_SIZE = 32;
const BUILDING_NOTE_FONT_FAMILY = "Hans Hand";
const BUILDING_NOTE_FONT_SIZE = 18;
let buildingNoteTooltipTimer = null;
let sceneNotesIntegrationInstalled = false;
const buildingNoteInteractions = new WeakMap();
const pendingBuildingNoteOpens = new WeakMap();

function skyholdMarkerAsset(name) {
  return `modules/${MODULE_ID}/assets/markers/${name}.svg`;
}

const BUILDING_NOTE_ICON_ASSETS = new Set([
  "fa-anchor", "fa-archway", "fa-beer-mug-empty", "fa-book-open", "fa-book-open-reader",
  "fa-book-sparkles", "fa-boot", "fa-box-archive", "fa-boxes-stacked", "fa-bread-slice",
  "fa-building", "fa-bullseye", "fa-campground", "fa-clipboard-list", "fa-cow",
  "fa-cross", "fa-cubes-stacked", "fa-dove", "fa-dumbbell", "fa-dungeon",
  "fa-fan", "fa-fire", "fa-hammer", "fa-hands-praying", "fa-horse",
  "fa-hot-tub-person", "fa-house-chimney", "fa-kit-medical", "fa-lock", "fa-monument",
  "fa-mortar-pestle", "fa-mountain", "fa-mountain-city", "fa-person-digging",
  "fa-person-military-rifle", "fa-piggy-bank", "fa-road-barrier", "fa-scale-balanced",
  "fa-seedling", "fa-sheep", "fa-shield", "fa-shirt", "fa-skull", "fa-tower-broadcast",
  "fa-tower-observation", "fa-tree", "fa-user-plus", "fa-vault", "fa-warehouse",
  "fa-water", "fa-wheat-awn"
]);

function buildingIconClass(icon = "") {
  const classes = String(icon ?? "").match(/\bfa-[a-z0-9-]+\b/g) ?? [];
  return classes.findLast((item) => !["fa-solid", "fa-regular", "fa-brands"].includes(item)) ?? "";
}

function skyholdBuildingIconAsset(icon = "") {
  const iconClass = buildingIconClass(icon);
  if (!iconClass || !BUILDING_NOTE_ICON_ASSETS.has(iconClass)) return "";
  return `modules/${MODULE_ID}/assets/building-icons/${iconClass}.svg`;
}

function templateForBuilding(building = {}, data = null) {
  const source = data ?? HoldingService.getData();
  const catalog = source?.catalog?.buildings ?? [];
  const templateKey = String(building?.templateId ?? "").trim().toLowerCase();
  const nameKey = String(building?.name ?? "").trim().toLowerCase();
  return catalog.find((item) => {
    if (templateKey && String(item?.id ?? "").trim().toLowerCase() === templateKey) return true;
    return nameKey && String(item?.name ?? "").trim().toLowerCase() === nameKey;
  }) ?? null;
}

function buildingNoteTexture(building = {}, data = null) {
  const template = templateForBuilding(building, data);
  const img = String(building?.img ?? building?.image ?? template?.img ?? template?.image ?? "").trim();
  if (img) return img;

  const iconAsset = skyholdBuildingIconAsset(building?.icon ?? template?.icon ?? "");
  if (iconAsset) return iconAsset;

  const haystack = `${building?.icon ?? template?.icon ?? ""} ${building?.name ?? ""} ${building?.type ?? ""} ${building?.category ?? ""}`.toLowerCase();
  if (/tower|castle|shield|guard|страж|башн|оборон|воен|форт|редут|баррикад|казарм|караул|дозор|оруж/.test(haystack)) return skyholdMarkerAsset("defense");
  if (/warehouse|box|crate|storage|склад|хранил|амбар|погреб|vault/.test(haystack)) return skyholdMarkerAsset("storage");
  if (/school|book|music|culture|школ|культур|библиот|храм|церк|часов|вера|религ/.test(haystack)) return skyholdMarkerAsset("culture");
  if (/tree|wood|lumber|лес|дров|бревн|пилорам|лесоповал/.test(haystack)) return skyholdMarkerAsset("lumber");
  if (/farm|food|wheat|ферм|поле|сад|пищ|зерн|мельниц|скот|хлев|овц|коро/.test(haystack)) return skyholdMarkerAsset("food");
  if (/hammer|anvil|wrench|industry|кузн|мастер|производ|мануф|ремес|цех|шахт|рудн|карьер/.test(haystack)) return skyholdMarkerAsset("production");
  if (/home|house|bed|housing|дом|жиль|казарм|ночлеж/.test(haystack)) return skyholdMarkerAsset("housing");
  if (/coin|market|shop|trade|торг|рынок|лавк|трактир|таверн|постоял/.test(haystack)) return skyholdMarkerAsset("trade");
  return skyholdMarkerAsset("building");
}

function skyholdBuildingPayloadFromDrop(data = null, event = null) {
  if (data?.type === "fbl-skyhold-building" && data?.moduleId === MODULE_ID) return data;
  const raw = event?.dataTransfer?.getData?.(`application/${MODULE_ID}+json`) || event?.dataTransfer?.getData?.("text/plain") || "";
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw);
    if (payload?.type !== "fbl-skyhold-building" || payload?.moduleId !== MODULE_ID) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function getBuildingByPayload(payload = {}, { user = globalThis.game?.user, includeHidden = false } = {}) {
  const data = HoldingService.getData();
  const holding = (data.holdings ?? []).find((item) => String(item.id) === String(payload.holdingId));
  if (!canReadHolding(holding, user)) return { data, holding: null, building: null };
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(payload.buildingId));
  if (!building) return { data, holding, building: null };
  if (!includeHidden && !user?.isGM && isBuildingSceneNoteHidden(holding, building, data)) return { data, holding: null, building: null };
  return { data, holding, building };
}

function isGmOnlyVisibility(value = "") {
  return String(value ?? "").trim().toLowerCase() === "gm";
}

function isBuildingSceneNoteHidden(holding = {}, building = {}, data = null) {
  const template = templateForBuilding(building, data);
  return Boolean(
    isGmOnlyVisibility(holding?.visibility)
    || isGmOnlyVisibility(building?.visibility)
    || isGmOnlyVisibility(template?.visibility)
    || building?.hidden === true
  );
}

async function createBuildingSceneNote(payload) {
  if (!game.user?.isGM) return;
  const scene = canvas?.scene;
  if (!scene) return;
  const { data, holding, building } = getBuildingByPayload(payload, { includeHidden: true });
  if (!holding || !building) { ui.notifications.warn("Здание для отметки не найдено."); return; }
  if (isBuildingSceneNoteHidden(holding, building, data)) {
    ui.notifications.warn("Скрытое для игроков здание нельзя вынести на сцену: у Foundry Note нет отдельного GM-only visibility поля.");
    return;
  }
  const pos = { x: Number(payload?.x) || 0, y: Number(payload?.y) || 0 };
  const texture = String(payload?.img ?? "").trim() || buildingNoteTexture({ ...building, icon: payload?.icon ?? building?.icon }, data);
  const noteData = {
    x: Math.round(pos.x ?? 0),
    y: Math.round(pos.y ?? 0),
    text: String(building.name ?? "Постройка"),
    iconSize: BUILDING_NOTE_ICON_SIZE,
    fontFamily: BUILDING_NOTE_FONT_FAMILY,
    fontSize: BUILDING_NOTE_FONT_SIZE,
    textColor: "#f5eee2",
    textAnchor: 1,
    global: false,
    texture: { src: texture },
    flags: {
      [MODULE_ID]: {
        type: "building-note",
        holdingId: String(holding.id ?? ""),
        buildingId: String(building.id ?? "")
      }
    }
  };
  try {
    const created = await scene.createEmbeddedDocuments("Note", [noteData]);
    if (!Array.isArray(created) || !created.length) throw new Error("Foundry did not return a created Note document.");
    ui.notifications.info(`Отметка «${building.name || "Постройка"}» добавлена на сцену.`);
  } catch (error) {
    console.error("FBL Skyhold | Failed to create building Note", error);
    ui.notifications.error("Не удалось создать отметку здания на сцене. Подробности в консоли.");
  }
}

function buildingFlagsFromNote(note) {
  const doc = note?.document ?? note;
  const data = doc?.getFlag?.(MODULE_ID, "type") === "building-note" ? {
    type: doc.getFlag(MODULE_ID, "type"),
    holdingId: doc.getFlag(MODULE_ID, "holdingId"),
    buildingId: doc.getFlag(MODULE_ID, "buildingId")
  } : (doc?.flags?.[MODULE_ID] ?? null);
  if (data?.type !== "building-note") return null;
  return data;
}

export async function openBuildingNote(note) {
  const flags = buildingFlagsFromNote(note);
  if (!flags) return false;
  const { holding, building } = getBuildingByPayload(flags);
  if (!holding || !building) {
    ui.notifications?.warn?.("Здание недоступно или больше не существует.");
    return false;
  }
  const SkyholdBuildingEditor = await loadBuildingEditorClass();
  await new SkyholdBuildingEditor({ holdingId: String(holding.id ?? ""), buildingId: String(building.id ?? "") }).render({ force: true, focus: true });
  return true;
}

function requestBuildingNoteOpen(note) {
  if (pendingBuildingNoteOpens.has(note)) return;
  const pending = openBuildingNote(note).catch((error) => {
    console.error("FBL Skyhold | Failed to open building Note", error);
    globalThis.ui?.notifications?.error?.("Не удалось открыть здание. Подробности в консоли.");
  }).finally(() => pendingBuildingNoteOpens.delete(note));
  pendingBuildingNoteOpens.set(note, pending);
}

function hideBuildingNoteTooltip() {
  if (buildingNoteTooltipTimer) window.clearTimeout(buildingNoteTooltipTimer);
  buildingNoteTooltipTimer = null;
  document.querySelector(".fbls-building-note-tooltip")?.remove();
}

function renderBuildingNoteTooltip(note) {
  const flags = buildingFlagsFromNote(note);
  if (!flags) return;
  const { holding, building } = getBuildingByPayload(flags);
  if (!holding || !building) return;
  document.querySelector(".fbls-building-note-tooltip")?.remove();
  const el = document.createElement("div");
  el.className = "fbl-skyhold fbls-building-note-tooltip";
  const functions = building.functions && typeof building.functions === "object" ? Object.entries(building.functions).filter(([, v]) => v).map(([k]) => k) : [];
  const title = document.createElement("h3");
  title.textContent = building.name || "Постройка";
  const summary = document.createElement("p");
  summary.textContent = `${holding.name || "Владение"} · ${building.type || "Здание"}`;
  el.append(title, summary);
  if (building.effect) {
    const effect = document.createElement("p");
    effect.textContent = String(building.effect).slice(0, 220);
    el.appendChild(effect);
  }
  const tags = document.createElement("div");
  tags.className = "fbls-note-tags";
  for (const item of [building.constructionStatus || "built", ...functions]) {
    const tag = document.createElement("span");
    tag.textContent = item;
    tags.appendChild(tag);
  }
  el.appendChild(tags);
  document.body.appendChild(el);
  const noteDocument = note?.document ?? note;
  const origin = note?.center ?? { x: Number(noteDocument?.x) || 20, y: Number(noteDocument?.y) || 20 };
  let client = origin;
  try { client = canvas?.clientCoordinatesFromCanvas?.(origin) ?? origin; } catch (_error) {}
  const x = Number(client?.x) || 20;
  const y = Number(client?.y) || 20;
  el.style.left = `${Math.min(window.innerWidth - 340, x + 14)}px`;
  el.style.top = `${Math.min(window.innerHeight - 180, y + 14)}px`;
}

function showBuildingNoteTooltip(note) {
  if (buildingNoteTooltipTimer) window.clearTimeout(buildingNoteTooltipTimer);
  buildingNoteTooltipTimer = window.setTimeout(() => {
    buildingNoteTooltipTimer = null;
    renderBuildingNoteTooltip(note);
  }, BUILDING_NOTE_TOOLTIP_DELAY_MS);
}

function isNotesLayerActive() {
  const active = canvas?.activeLayer;
  return Boolean(active && (active === canvas?.notes || active?.constructor?.name === "NotesLayer" || active?.options?.name === "notes"));
}

function shouldOpenBuildingNoteFromClick() {
  return !isNotesLayerActive();
}

function installBuildingNoteInteractions() {
  Hooks.on("activateNote", (note) => {
    if (!buildingFlagsFromNote(note) || !shouldOpenBuildingNoteFromClick()) return undefined;
    requestBuildingNoteOpen(note);
    return false;
  });
  // Unlinked Notes never reach Foundry's activateNote hook. Listen to their
  // public pointer event without replacing the Note class or its permissions.
  Hooks.on("drawNote", (note) => {
    const previous = buildingNoteInteractions.get(note);
    if (previous) note.off("pointertap", previous);
    buildingNoteInteractions.delete(note);
    if (!buildingFlagsFromNote(note)) return;
    let lastClick = null;
    const onPointerTap = (event) => {
      if (event.button !== 0 || note.document?.entry || !shouldOpenBuildingNoteFromClick()) {
        lastClick = null;
        return;
      }
      const click = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      if (![click.time, click.x, click.y].every(Number.isFinite)) { lastClick = null; return; }
      const previousClick = lastClick;
      lastClick = click;
      if (!previousClick) return;
      const elapsed = click.time - previousClick.time;
      const { timeMs, distancePx } = foundryDoubleClickThresholds();
      if (elapsed < 0 || elapsed > timeMs || Math.hypot(click.x - previousClick.x, click.y - previousClick.y) > distancePx) return;
      // Pixi's detail counter uses 200ms. Match Foundry's tap interval instead,
      // consuming each pair so a third tap cannot reopen the editor.
      lastClick = null;
      requestBuildingNoteOpen(note);
    };
    note.on("pointertap", onPointerTap);
    buildingNoteInteractions.set(note, onPointerTap);
  });
  Hooks.on("destroyNote", (note) => {
    const listener = buildingNoteInteractions.get(note);
    if (listener) note.off("pointertap", listener);
    buildingNoteInteractions.delete(note);
    hideBuildingNoteTooltip();
  });
  Hooks.on("canvasTearDown", hideBuildingNoteTooltip);
  Hooks.on("hoverNote", (note, hovered) => {
    if (!buildingFlagsFromNote(note)) return;
    if (hovered) showBuildingNoteTooltip(note);
    else hideBuildingNoteTooltip();
  });
}

function installCanvasBuildingDrop() {
  Hooks.on("dropCanvasData", (_canvas, data, event) => {
    const payload = skyholdBuildingPayloadFromDrop(data, event);
    if (!payload) return;
    void createBuildingSceneNote(payload);
  });
}


export function installSceneNotesIntegration() {
  if (sceneNotesIntegrationInstalled) return;
  sceneNotesIntegrationInstalled = true;
  installCanvasBuildingDrop();
  installBuildingNoteInteractions();
}
