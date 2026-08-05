import { MODULE_ID } from "../../data/constants.js";
import { fieldValue } from "../../core/helpers.js";
import { bindGlobalInputGuard, bindInputGuards, unbindGlobalInputGuard } from "../../utils/input-guards.js";
import { requestSkyholdAppRender } from "../registry.js";
import { RenderSchedulerMixin } from "./render-scheduler.js";
import { playFoundryAudio, renderFoundryFilePicker } from "../../integrations/foundry-runtime.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const HEADER_BUTTON_CLASS = "fbls-building-track-button";
const DEFAULT_AUDIO_VOLUME = 0.45;
const AUDIO_SOURCE_MODES = new Set(["file", "playlist-sound", "playlist"]);
const LOCAL_AUDIO_SESSIONS = new Map();

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function clampVolume(value, fallback = DEFAULT_AUDIO_VOLUME) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection.contents)) return collection.contents;
  if (typeof collection.values === "function") return Array.from(collection.values());
  if (typeof collection[Symbol.iterator] === "function") {
    return Array.from(collection).map((entry) => (Array.isArray(entry) ? entry[1] : entry)).filter(Boolean);
  }
  return [];
}

function playlistDocuments() {
  return collectionValues(game.playlists).filter(Boolean);
}

function playlistSounds(playlist = null) {
  return collectionValues(playlist?.sounds).filter(Boolean);
}

function getPlaylist(playlistId = "") {
  const id = String(playlistId ?? "");
  return game.playlists?.get?.(id) ?? playlistDocuments().find((playlist) => String(playlist?.id ?? "") === id) ?? null;
}

function getPlaylistSound(playlistId = "", soundId = "") {
  const playlist = getPlaylist(playlistId);
  const id = String(soundId ?? "");
  return playlist?.sounds?.get?.(id) ?? playlistSounds(playlist).find((sound) => String(sound?.id ?? "") === id) ?? null;
}

function soundPath(sound = null) {
  return String(sound?.path ?? sound?.src ?? sound?.sound ?? "").trim();
}

function soundName(sound = null) {
  return String(sound?.name ?? sound?.label ?? soundPath(sound) ?? "Звук");
}

function soundVolume(sound = null, fallback = DEFAULT_AUDIO_VOLUME) {
  return clampVolume(sound?.volume ?? fallback, fallback);
}

function stopSound(sound) {
  try {
    if (typeof sound?.stop === "function") sound.stop();
    else if (typeof sound?.pause === "function") {
      sound.pause();
      if ("currentTime" in sound) sound.currentTime = 0;
    }
  } catch (error) {
    console.warn("FBL Skyhold | Failed to stop building audio track", error);
  }
}

function windowFrameFor(root) {
  return root?.closest?.(".application, .app, .window-app") ?? root?.parentElement?.closest?.(".application, .app, .window-app") ?? root;
}

function normalizeBuildingAudioConfig(source = {}) {
  const building = source?.audio ? source : { audio: source };
  const audio = isPlainObject(building?.audio) ? building.audio : {};
  const legacyTrack = String(audio.track ?? building?.soundTrack ?? building?.audioTrack ?? "").trim();
  let mode = String(audio.mode ?? audio.type ?? "").trim();
  if (!AUDIO_SOURCE_MODES.has(mode)) {
    if (audio.playlistId && audio.soundId) mode = "playlist-sound";
    else if (audio.playlistId) mode = "playlist";
    else mode = "file";
  }

  const src = String(audio.src ?? (mode === "file" ? legacyTrack : "")).trim();
  return {
    mode,
    src,
    track: mode === "file" ? src : legacyTrack,
    playlistId: String(audio.playlistId ?? "").trim(),
    soundId: String(audio.soundId ?? "").trim(),
    volume: clampVolume(audio.volume, DEFAULT_AUDIO_VOLUME),
    loop: audio.loop !== false
  };
}

function normalizeEditorAudioConfig(config = {}) {
  const normalized = normalizeBuildingAudioConfig({ audio: config });
  if (!normalized.mode || !AUDIO_SOURCE_MODES.has(normalized.mode)) normalized.mode = "file";
  return normalized;
}

function audioSourceLabel(config = {}) {
  const normalized = normalizeBuildingAudioConfig({ audio: config });
  if (normalized.mode === "playlist") {
    const playlist = getPlaylist(normalized.playlistId);
    return playlist?.name ? `Плейлист: ${playlist.name}` : "Плейлист Foundry";
  }
  if (normalized.mode === "playlist-sound") {
    const sound = getPlaylistSound(normalized.playlistId, normalized.soundId);
    return sound ? `Звук плейлиста: ${soundName(sound)}` : "Звук из плейлиста Foundry";
  }
  return normalized.src || "";
}

function buildingTrackHeaderTitle(building = {}) {
  const label = audioSourceLabel(building?.audio ?? {});
  return label
    ? `Звук здания: ${label}\nЛКМ — открыть редактор звука.\nПКМ — очистить звук.`
    : "Звук здания не задан. ЛКМ — открыть редактор звука.";
}

function createTrackButton(building = {}, onPick = null, onClear = null) {
  const active = Boolean(resolvePlaybackPayload(building).sounds.length);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${HEADER_BUTTON_CLASS}${active ? " active" : ""}`;
  button.title = buildingTrackHeaderTitle(building);
  button.setAttribute("aria-label", active ? "Изменить звук здания" : "Добавить звук здания");

  const icon = document.createElement("i");
  icon.className = active ? "fa-solid fa-volume-high" : "fa-solid fa-music";
  button.append(icon);

  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const result = onPick?.(event);
      Promise.resolve(result).catch((error) => {
        console.error("FBL Skyhold | Failed to open building audio editor", error);
        ui.notifications?.error?.("Не удалось открыть редактор звука здания. Подробности в консоли.");
      });
    } catch (error) {
      console.error("FBL Skyhold | Failed to open building audio editor", error);
      ui.notifications?.error?.("Не удалось открыть редактор звука здания. Подробности в консоли.");
    }
  });
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClear?.(event);
  });
  return button;
}

export function buildingAudioTrack(building = {}) {
  return audioSourceLabel(building?.audio ?? {});
}

export function syncBuildingAudioTrackHeader(app, root, { building = null, canManage = false, onPick = null, onClear = null } = {}) {
  const frame = windowFrameFor(root ?? app?.element);
  const header = frame?.querySelector?.(".window-header");
  if (!header) return;

  header.querySelectorAll(`.${HEADER_BUTTON_CLASS}`).forEach((button) => button.remove());
  if (!canManage || !building) return;

  const button = createTrackButton(building, onPick, onClear);
  const controls = header.querySelector(".window-controls, .header-control, .window-header-buttons");
  if (controls?.parentElement === header) header.insertBefore(button, controls);
  else header.appendChild(button);
}

export function removeBuildingAudioTrackHeader(app, root = null) {
  const frame = windowFrameFor(root ?? app?.element);
  frame?.querySelectorAll?.(`.${HEADER_BUTTON_CLASS}`)?.forEach((button) => button.remove());
}

function nativeAudioSession(session, entry = {}, { loop = false, onEnded = null } = {}) {
  const AudioCtor = globalThis.Audio;
  if (typeof AudioCtor !== "function") return null;
  const audio = new AudioCtor(entry.src);
  audio.loop = Boolean(loop);
  audio.volume = clampVolume(entry.volume, DEFAULT_AUDIO_VOLUME);
  if (typeof onEnded === "function") audio.addEventListener("ended", onEnded, { once: true });
  session.sound = audio;
  const played = audio.play?.();
  Promise.resolve(played).catch((error) => {
    if (!session.stopped) console.warn("FBL Skyhold | Failed to play building audio track", error);
  });
  return audio;
}

function playSingleSession(session, entry = {}, { loop = false } = {}) {
  const playData = {
    src: String(entry.src ?? ""),
    volume: clampVolume(entry.volume, DEFAULT_AUDIO_VOLUME),
    autoplay: true,
    loop: Boolean(loop)
  };
  if (!playData.src) return;
  try {
    const result = playFoundryAudio(playData, false);
    if (result?.then instanceof Function) {
      result.then((sound) => {
        if (session.stopped) {
          stopSound(sound);
          return;
        }
        session.sound = sound ?? null;
      }).catch((error) => {
        if (!session.stopped) {
          console.warn("FBL Skyhold | Failed to play building audio track", error);
          nativeAudioSession(session, entry, { loop });
        }
      });
    } else if (result) {
      session.sound = result;
    } else {
      nativeAudioSession(session, entry, { loop });
    }
  } catch (error) {
    console.warn("FBL Skyhold | Failed to start building audio track", error);
    nativeAudioSession(session, entry, { loop });
  }
}

function playPlaylistSessionNext(session) {
  if (session.stopped) return;
  const entry = session.sounds[session.index];
  if (!entry?.src) {
    stopLocalAudioSession(session.sessionId);
    return;
  }
  nativeAudioSession(session, entry, {
    loop: false,
    onEnded: () => {
      if (session.stopped) return;
      session.index += 1;
      if (session.index >= session.sounds.length) {
        if (!session.loop) {
          stopLocalAudioSession(session.sessionId);
          return;
        }
        session.index = 0;
      }
      playPlaylistSessionNext(session);
    }
  });
}

function startLocalAudioSession(payload = {}) {
  const sessionId = String(payload.sessionId ?? "");
  if (!sessionId) return false;
  stopLocalAudioSession(sessionId);
  const sounds = (Array.isArray(payload.sounds) ? payload.sounds : [])
    .map((sound) => ({
      src: String(sound?.src ?? "").trim(),
      volume: clampVolume(sound?.volume, DEFAULT_AUDIO_VOLUME),
      name: String(sound?.name ?? "")
    }))
    .filter((sound) => sound.src);
  if (!sounds.length) return false;

  const session = {
    sessionId,
    mode: String(payload.audioMode ?? "file"),
    sounds,
    loop: payload.loop !== false,
    index: 0,
    sound: null,
    stopped: false
  };
  LOCAL_AUDIO_SESSIONS.set(sessionId, session);
  if (session.mode === "playlist" && sounds.length > 1) playPlaylistSessionNext(session);
  else playSingleSession(session, sounds[0], { loop: session.loop });
  return true;
}

function stopLocalAudioSession(sessionId = "") {
  const id = String(sessionId ?? "");
  const session = LOCAL_AUDIO_SESSIONS.get(id);
  if (!session) return false;
  session.stopped = true;
  stopSound(session.sound);
  LOCAL_AUDIO_SESSIONS.delete(id);
  return true;
}

function resolvePlaybackPayload(building = {}) {
  const config = normalizeBuildingAudioConfig(building);
  if (config.mode === "playlist") {
    const playlist = getPlaylist(config.playlistId);
    return {
      audioMode: "playlist",
      loop: config.loop,
      sounds: playlistSounds(playlist)
        .map((sound) => ({ src: soundPath(sound), volume: soundVolume(sound, DEFAULT_AUDIO_VOLUME), name: soundName(sound) }))
        .filter((sound) => sound.src)
    };
  }
  if (config.mode === "playlist-sound") {
    const sound = getPlaylistSound(config.playlistId, config.soundId);
    const src = soundPath(sound) || config.src;
    return {
      audioMode: "playlist-sound",
      loop: config.loop,
      sounds: src ? [{ src, volume: soundVolume(sound, DEFAULT_AUDIO_VOLUME), name: soundName(sound) }] : []
    };
  }
  return {
    audioMode: "file",
    loop: config.loop,
    sounds: config.src ? [{ src: config.src, volume: config.volume, name: config.src }] : []
  };
}

function playbackKey(payload = {}) {
  return JSON.stringify({
    audioMode: payload.audioMode,
    loop: payload.loop !== false,
    sounds: (payload.sounds ?? []).map((sound) => ({ src: sound.src, volume: clampVolume(sound.volume, DEFAULT_AUDIO_VOLUME) }))
  });
}

function makeSessionId(building = {}) {
  const id = String(building?.id ?? "building").replace(/[^a-z0-9_-]+/gi, "-") || "building";
  const random = Math.random().toString(36).slice(2, 8);
  return `building-audio-${id}-${Date.now()}-${random}`;
}

export function stopBuildingAudioTrack(app) {
  if (!app) return;
  const sessionId = String(app._buildingAudioTrackSessionId ?? "");
  app._buildingAudioTrackKey = "";
  app._buildingAudioTrackSessionId = "";
  if (sessionId) stopLocalAudioSession(sessionId);
  const sound = app._buildingAudioTrackSound;
  app._buildingAudioTrackSound = null;
  app._buildingAudioTrackSrc = "";
  if (sound) stopSound(sound);
}

export function syncBuildingAudioTrackPlayback(app, building = {}) {
  if (!app) return;
  const payload = resolvePlaybackPayload(building);
  const key = playbackKey(payload);
  if (String(app._buildingAudioTrackKey ?? "") === key) return;
  stopBuildingAudioTrack(app);
  app._buildingAudioTrackKey = key;
  if (!payload.sounds.length) return;

  const sessionId = makeSessionId(building);
  const startPayload = { ...payload, action: "start", sessionId };
  app._buildingAudioTrackSessionId = sessionId;
  startLocalAudioSession(startPayload);
}

function serializableAudioConfig(config = {}) {
  const normalized = normalizeEditorAudioConfig(config);
  const sound = normalized.mode === "playlist-sound" ? getPlaylistSound(normalized.playlistId, normalized.soundId) : null;
  const src = normalized.mode === "file"
    ? normalized.src
    : (normalized.mode === "playlist-sound" ? (soundPath(sound) || normalized.src) : "");
  return {
    mode: normalized.mode,
    track: src,
    src: normalized.mode === "file" ? normalized.src : src,
    playlistId: normalized.mode === "file" ? "" : normalized.playlistId,
    soundId: normalized.mode === "playlist-sound" ? normalized.soundId : "",
    volume: normalized.volume,
    loop: normalized.loop
  };
}

export async function setBuildingAudioConfig(app, config = {}, { reason = "building-audio-track:set" } = {}) {
  if (!app || typeof app._updateMutableBuilding !== "function") return false;
  const nextConfig = serializableAudioConfig(config);
  const updated = await app._updateMutableBuilding(({ building }) => {
    if (!building) return false;
    if (!isPlainObject(building.audio)) building.audio = {};
    building.audio = nextConfig;
    return true;
  }, { reason });
  if (!updated) return false;
  stopBuildingAudioTrack(app);
  app.requestRender?.();
  requestSkyholdAppRender();
  return true;
}

export async function setBuildingAudioTrack(app, track = "", { reason = "building-audio-track:set" } = {}) {
  return setBuildingAudioConfig(app, {
    mode: "file",
    src: String(track ?? "").trim(),
    volume: DEFAULT_AUDIO_VOLUME,
    loop: true
  }, { reason });
}

function selectedOptions(options = [], selectedValue = "") {
  const selected = String(selectedValue ?? "");
  return options.map((option) => ({ ...option, selected: String(option.value) === selected }));
}

function audioEditorSourceOptions(mode = "file") {
  return selectedOptions([
    { value: "file", label: "Файл" },
    { value: "playlist-sound", label: "Звук плейлиста" },
    { value: "playlist", label: "Плейлист" }
  ], mode);
}

function playlistOptions(selectedValue = "") {
  return selectedOptions(playlistDocuments().map((playlist) => ({
    value: String(playlist.id ?? ""),
    label: String(playlist.name ?? playlist.id ?? "Плейлист")
  })).filter((option) => option.value), selectedValue);
}

function soundOptions(playlistId = "", selectedValue = "") {
  return selectedOptions(playlistSounds(getPlaylist(playlistId)).map((sound) => ({
    value: String(sound.id ?? ""),
    label: soundName(sound),
    path: soundPath(sound)
  })).filter((option) => option.value && option.path), selectedValue);
}

class SkyholdBuildingAudioTrackEditor extends RenderSchedulerMixin(HandlebarsApplicationMixin(ApplicationV2)) {
  constructor({ owner = null, reason = "building-audio-track:set" } = {}, options = {}) {
    super(options);
    this.owner = owner;
    this.reason = reason;
    const { building } = owner?._getMutableBuilding?.() ?? {};
    this._audioForm = normalizeEditorAudioConfig(building?.audio ?? {});
    this._coercePlaylistDefaults();
  }

  _coercePlaylistDefaults() {
    const playlists = playlistOptions(this._audioForm.playlistId);
    if ((this._audioForm.mode === "playlist" || this._audioForm.mode === "playlist-sound") && !this._audioForm.playlistId) {
      this._audioForm.playlistId = playlists[0]?.value ?? "";
    }
    if (this._audioForm.mode === "playlist-sound") {
      const sounds = soundOptions(this._audioForm.playlistId, this._audioForm.soundId);
      if (!this._audioForm.soundId || !sounds.some((option) => option.selected)) this._audioForm.soundId = sounds[0]?.value ?? "";
    }
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    this._coercePlaylistDefaults();
    const playlists = playlistOptions(this._audioForm.playlistId);
    const sounds = soundOptions(this._audioForm.playlistId, this._audioForm.soundId);
    const volumePercent = Math.round(clampVolume(this._audioForm.volume, DEFAULT_AUDIO_VOLUME) * 100);
    return {
      ...context,
      canEdit: Boolean(game.user?.isGM),
      form: this._audioForm,
      sourceOptions: audioEditorSourceOptions(this._audioForm.mode),
      isFile: this._audioForm.mode === "file",
      isPlaylistSound: this._audioForm.mode === "playlist-sound",
      isPlaylist: this._audioForm.mode === "playlist",
      playlistOptions: playlists,
      soundOptions: sounds,
      hasPlaylists: playlists.length > 0,
      hasSounds: sounds.length > 0,
      volumePercent,
      canSave: this._canSave()
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    bindInputGuards(root);
    bindGlobalInputGuard(this, root);
    this._bindEvents(root);
  }

  _bindEvents(root) {
    this._delegatedAbortController?.abort?.();
    const controller = new AbortController();
    this._delegatedAbortController = controller;

    root.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]");
      if (!action || !root.contains(action)) return;
      const value = String(action.dataset.action ?? "");
      if (value === "building-audio-pick-file") this._onPickFile(event);
      else if (value === "building-audio-save") this._onSave(event);
      else if (value === "building-audio-clear") this._onClear(event);
    }, { signal: controller.signal });

    root.addEventListener("change", (event) => {
      const field = event.target?.closest?.("[data-building-audio-field]");
      if (field && root.contains(field)) this._onFieldChange(event, field);
    }, { signal: controller.signal });

    root.addEventListener("input", (event) => {
      const field = event.target?.closest?.("[data-building-audio-field='volume']");
      if (field && root.contains(field)) {
        this._audioForm.volume = clampVolume(fieldValue(field), DEFAULT_AUDIO_VOLUME);
        root.querySelectorAll("[data-building-audio-volume-label]").forEach((label) => {
          label.textContent = `${Math.round(this._audioForm.volume * 100)}%`;
        });
      }
    }, { signal: controller.signal });
  }

  _onFieldChange(event, field) {
    event.preventDefault();
    if (!game.user?.isGM) return;
    const key = String(field.dataset.buildingAudioField ?? "");
    if (key === "mode") {
      this._audioForm.mode = AUDIO_SOURCE_MODES.has(String(field.value)) ? String(field.value) : "file";
      this._coercePlaylistDefaults();
      this.requestRender({ focus: false });
      return;
    }
    if (key === "src") this._audioForm.src = String(fieldValue(field) ?? "").trim();
    else if (key === "playlistId") {
      this._audioForm.playlistId = String(fieldValue(field) ?? "").trim();
      this._audioForm.soundId = "";
      this._coercePlaylistDefaults();
      this.requestRender({ focus: false });
      return;
    } else if (key === "soundId") this._audioForm.soundId = String(fieldValue(field) ?? "").trim();
    else if (key === "volume") this._audioForm.volume = clampVolume(fieldValue(field), DEFAULT_AUDIO_VOLUME);
    else if (key === "loop") this._audioForm.loop = Boolean(field.checked);
  }

  _canSave() {
    if (this._audioForm.mode === "file") return Boolean(String(this._audioForm.src ?? "").trim());
    if (this._audioForm.mode === "playlist") return Boolean(this._audioForm.playlistId);
    if (this._audioForm.mode === "playlist-sound") return Boolean(this._audioForm.playlistId && this._audioForm.soundId);
    return false;
  }

  _onPickFile(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    renderFoundryFilePicker({
      type: "audio",
      current: this._audioForm.src,
      callback: (picked) => {
        this._audioForm.mode = "file";
        this._audioForm.src = String(picked ?? "").trim();
        this.requestRender({ focus: true });
      }
    });
  }

  async _onSave(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM || !this._canSave()) return;
    try {
      const saved = await setBuildingAudioConfig(this.owner, this._audioForm, { reason: this.reason });
      if (saved) {
        ui.notifications?.info?.("Звук здания сохранен.");
        this.close({ force: true });
      }
    } catch (error) {
      console.error("FBL Skyhold | Failed to save building audio track", error);
      ui.notifications?.error?.("Не удалось сохранить звук здания. Подробности в консоли.");
    }
  }

  async _onClear(event) {
    event.preventDefault();
    event.stopPropagation();
    if (!game.user?.isGM) return;
    try {
      const cleared = await setBuildingAudioConfig(this.owner, { mode: "file", src: "", volume: DEFAULT_AUDIO_VOLUME, loop: true }, { reason: "building-audio-track:clear" });
      if (cleared) {
        ui.notifications?.info?.("Звук здания очищен.");
        this.close({ force: true });
      }
    } catch (error) {
      console.error("FBL Skyhold | Failed to clear building audio track", error);
      ui.notifications?.error?.("Не удалось очистить звук здания. Подробности в консоли.");
    }
  }

  async _onClose(options) {
    await super._onClose(options);
    this._delegatedAbortController?.abort?.();
    this._delegatedAbortController = null;
    unbindGlobalInputGuard(this);
  }
}

SkyholdBuildingAudioTrackEditor.DEFAULT_OPTIONS = {
  classes: ["fbl-skyhold", "fbl-skyhold-building-audio-editor"],
  tag: "section",
  window: {
    title: "Звук здания",
    icon: "fa-solid fa-volume-high",
    resizable: true
  },
  position: {
    width: 560,
    height: 430
  }
};

SkyholdBuildingAudioTrackEditor.PARTS = {
  body: {
    template: `modules/${MODULE_ID}/templates/building-audio-track-editor.hbs`
  }
};

export async function pickBuildingAudioTrack(app, { reason = "building-audio-track:pick" } = {}) {
  if (!game.user?.isGM) {
    ui.notifications?.warn?.("Редактор звука здания доступен только ГМу.");
    return null;
  }
  const { building } = app?._getMutableBuilding?.() ?? {};
  if (!building) {
    ui.notifications?.warn?.("Здание для настройки звука не найдено.");
    return null;
  }
  const editor = new SkyholdBuildingAudioTrackEditor({ owner: app, reason });
  editor.render({ force: true, focus: true });
  return editor;
}

export async function clearBuildingAudioTrack(app, { reason = "building-audio-track:clear" } = {}) {
  if (!game.user?.isGM) return;
  try {
    const cleared = await setBuildingAudioConfig(app, { mode: "file", src: "", volume: DEFAULT_AUDIO_VOLUME, loop: true }, { reason });
    if (cleared) ui.notifications?.info?.("Звук здания очищен.");
  } catch (error) {
    console.error("FBL Skyhold | Failed to clear building audio track", error);
    ui.notifications?.error?.("Не удалось очистить звук здания. Подробности в консоли.");
  }
}
