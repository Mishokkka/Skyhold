import { MODULE_ID } from "../data/store.js";
import { HoldingService } from "../data/holding-service.js";
import { canReadHolding } from "../data/access-guard.js";
import { SkyholdBuildingEditor } from "../apps/editors.js";

const BUILDING_NOTE_TOOLTIP_DELAY_MS = 1000;
const BUILDING_NOTE_ICON_SIZE = 32;
const BUILDING_NOTE_FONT_FAMILY = "Hans Hand";
const BUILDING_NOTE_FONT_SIZE = 18;
let buildingNoteTooltipTimer = null;

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

function escapeHtmlLocal(value = "") {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function skyholdBuildingPayloadFromDrop(event) {
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

function getBuildingByPayload(payload = {}) {
  const data = HoldingService.getData();
  const holding = (data.holdings ?? []).find((item) => String(item.id) === String(payload.holdingId));
  if (!canReadHolding(holding)) return { data, holding: null, building: null };
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(payload.buildingId));
  return { data, holding, building };
}

function buildingNoteIcon(building = {}) {
  return buildingNoteTexture(building);
}

function canvasDropPosition(event) {
  try {
    if (canvas?.canvasCoordinatesFromClient) return canvas.canvasCoordinatesFromClient(event);
  } catch (_error) {}
  const rect = canvas?.app?.view?.getBoundingClientRect?.();
  const point = { x: (event.clientX ?? 0) - (rect?.left ?? 0), y: (event.clientY ?? 0) - (rect?.top ?? 0) };
  try {
    const PIXI = globalThis.PIXI;
    if (canvas?.stage?.worldTransform?.applyInverse && PIXI?.Point) {
      return canvas.stage.worldTransform.applyInverse(new PIXI.Point(point.x, point.y));
    }
  } catch (_error) {}
  return point;
}

async function createBuildingSceneNote(payload, event) {
  if (!game.user?.isGM) return;
  const scene = canvas?.scene;
  if (!scene) return;
  const { data, holding, building } = getBuildingByPayload(payload);
  if (!holding || !building) { ui.notifications.warn("Здание для отметки не найдено."); return; }
  const pos = canvasDropPosition(event);
  const texture = String(payload?.img ?? "").trim() || buildingNoteTexture({ ...building, icon: payload?.icon ?? building?.icon }, data);
  const noteData = {
    x: Math.round(pos.x ?? 0),
    y: Math.round(pos.y ?? 0),
    text: String(building.name ?? "Постройка"),
    icon: texture,
    iconSize: BUILDING_NOTE_ICON_SIZE,
    fontFamily: BUILDING_NOTE_FONT_FAMILY,
    fontSize: BUILDING_NOTE_FONT_SIZE,
    textColor: "#f2efe6",
    textAnchor: 1,
    locked: false,
    hidden: false,
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
    const note = Array.isArray(created) ? created[0] : null;
    if (note?.update) {
      await note.update({ icon: texture, iconSize: BUILDING_NOTE_ICON_SIZE, fontFamily: BUILDING_NOTE_FONT_FAMILY, fontSize: BUILDING_NOTE_FONT_SIZE, textColor: "#f2efe6", locked: false });
    }
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

function openBuildingNote(note) {
  const flags = buildingFlagsFromNote(note);
  if (!flags) return false;
  new SkyholdBuildingEditor({ holdingId: String(flags.holdingId ?? ""), buildingId: String(flags.buildingId ?? "") }).render({ force: true, focus: true });
  return true;
}

function hideBuildingNoteTooltip() {
  if (buildingNoteTooltipTimer) window.clearTimeout(buildingNoteTooltipTimer);
  buildingNoteTooltipTimer = null;
  document.querySelector(".fbls-building-note-tooltip")?.remove();
}

function renderBuildingNoteTooltip(note, event = null) {
  const flags = buildingFlagsFromNote(note);
  if (!flags) return;
  const { holding, building } = getBuildingByPayload(flags);
  if (!holding || !building) return;
  document.querySelector(".fbls-building-note-tooltip")?.remove();
  const el = document.createElement("div");
  el.className = "fbls-building-note-tooltip";
  const functions = building.functions && typeof building.functions === "object" ? Object.entries(building.functions).filter(([, v]) => v).map(([k]) => k) : [];
  el.innerHTML = `<h3>${escapeHtmlLocal(building.name || "Постройка")}</h3><p>${escapeHtmlLocal(holding.name || "Владение")} · ${escapeHtmlLocal(building.type || "Здание")}</p>${building.effect ? `<p>${escapeHtmlLocal(building.effect).slice(0, 220)}</p>` : ""}<div class="fbls-note-tags"><span>${escapeHtmlLocal(building.constructionStatus || "built")}</span>${functions.map((item) => `<span>${escapeHtmlLocal(item)}</span>`).join("")}</div>`;
  document.body.appendChild(el);
  const source = event?.data?.originalEvent ?? event?.originalEvent ?? event;
  const x = source?.clientX ?? globalThis.event?.clientX ?? 20;
  const y = source?.clientY ?? globalThis.event?.clientY ?? 20;
  el.style.left = `${Math.min(window.innerWidth - 340, x + 14)}px`;
  el.style.top = `${Math.min(window.innerHeight - 180, y + 14)}px`;
}

function showBuildingNoteTooltip(note, event = null) {
  if (buildingNoteTooltipTimer) window.clearTimeout(buildingNoteTooltipTimer);
  const savedEvent = event?.data?.originalEvent ?? event?.originalEvent ?? event;
  buildingNoteTooltipTimer = window.setTimeout(() => {
    buildingNoteTooltipTimer = null;
    renderBuildingNoteTooltip(note, savedEvent);
  }, BUILDING_NOTE_TOOLTIP_DELAY_MS);
}

function isNotesLayerActive() {
  const active = canvas?.activeLayer;
  return Boolean(active && (active === canvas?.notes || active?.constructor?.name === "NotesLayer" || active?.options?.name === "notes"));
}

function shouldOpenBuildingNoteFromClick() {
  return !isNotesLayerActive();
}

function applyBuildingNoteCanvasStyle(note) {
  const flags = buildingFlagsFromNote(note);
  if (!flags) return;
  const { data, building } = getBuildingByPayload(flags);
  if (!building) return;
  const texturePath = buildingNoteTexture(building, data);
  try {
    const tex = globalThis.PIXI?.Texture?.from?.(texturePath);
    const sprites = [note?.controlIcon?.icon, note?.icon, note?.controlIcon?._icon].filter(Boolean);
    for (const sprite of sprites) {
      if (tex && "texture" in sprite) sprite.texture = tex;
      // Не трогаем anchor/position/scale: у разных клиентов Foundry может держать
      // внутренний sprite ControlIcon по-разному. Принудительные scale/anchor
      // дают смещение вверх-влево на части клиентов.
      if ("tint" in sprite) sprite.tint = 0xffffff;
      if ("alpha" in sprite) sprite.alpha = 1;
    }
  } catch (_error) {}
  try {
    const labels = [note?.tooltip, note?.label, note?.text].filter(Boolean);
    for (const label of labels) {
      if (!label?.style) continue;
      label.style.fontFamily = [BUILDING_NOTE_FONT_FAMILY, "Hans-Hand", "serif"];
      label.style.fontSize = BUILDING_NOTE_FONT_SIZE;
      label.style.fill = "#f2efe6";
      label.style.dropShadow = true;
      label.style.dropShadowAlpha = 0.85;
      label.style.dropShadowBlur = 3;
      label.style.dropShadowDistance = 1;
      if ("dirty" in label) label.dirty = true;
    }
  } catch (_error) {}
}

function installBuildingNoteInteractions() {
  Hooks.on("activateNote", (note) => {
    if (!shouldOpenBuildingNoteFromClick()) return undefined;
    if (openBuildingNote(note)) return false;
    return undefined;
  });
  Hooks.on("clickNote", (note) => {
    if (!shouldOpenBuildingNoteFromClick()) return undefined;
    if (openBuildingNote(note)) return false;
    return undefined;
  });
  Hooks.on("drawNote", (note) => {
    if (!buildingFlagsFromNote(note)) return;
    applyBuildingNoteCanvasStyle(note);
    window.setTimeout(() => applyBuildingNoteCanvasStyle(note), 100);
    const targets = [note.controlIcon, note.tooltip, note].filter(Boolean);
    for (const target of targets) {
      if (!target?.on || target._fblSkyholdBuildingBound) continue;
      target._fblSkyholdBuildingBound = true;
      if ("interactive" in target) target.interactive = true;
      if ("cursor" in target) target.cursor = "pointer";
      target.on("pointertap", () => { if (shouldOpenBuildingNoteFromClick()) openBuildingNote(note); });
      target.on("pointerover", (event) => showBuildingNoteTooltip(note, event));
      target.on("pointerout", () => hideBuildingNoteTooltip());
    }
  });
}

function installCanvasBuildingDrop() {
  const bind = () => {
    const view = canvas?.app?.view;
    if (!view || view._fblSkyholdBuildingDropBound) return;
    view._fblSkyholdBuildingDropBound = true;
    view.addEventListener("dragover", (event) => {
      const payload = skyholdBuildingPayloadFromDrop(event);
      if (!payload) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    view.addEventListener("drop", (event) => {
      const payload = skyholdBuildingPayloadFromDrop(event);
      if (!payload) return;
      event.preventDefault();
      createBuildingSceneNote(payload, event);
    });
  };
  Hooks.on("canvasReady", bind);
  bind();
}


export function installSceneNotesIntegration() {
  installCanvasBuildingDrop();
  installBuildingNoteInteractions();
}
