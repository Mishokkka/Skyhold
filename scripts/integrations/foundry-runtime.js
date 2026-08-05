/* FBL Skyhold: the single runtime boundary for Foundry APIs shared by V13 and V14. */

function requireApi(value, label) {
  if (value) return value;
  throw new Error(`FBL Skyhold | Foundry API is unavailable: ${label}`);
}

export function foundryDialogV2() {
  return requireApi(globalThis.foundry?.applications?.api?.DialogV2, "foundry.applications.api.DialogV2");
}

export function foundryFilePicker() {
  return requireApi(globalThis.foundry?.applications?.apps?.FilePicker, "foundry.applications.apps.FilePicker");
}

export function renderFoundryFilePicker(options = {}) {
  return new (foundryFilePicker())(options).render({ force: true });
}

export function renderFoundryDocumentSheet(document, { force = true, focus = true } = {}) {
  const sheet = document?.sheet;
  if (!sheet?.render) return null;
  const ApplicationV2 = globalThis.foundry?.applications?.api?.ApplicationV2;
  if (ApplicationV2 && sheet instanceof ApplicationV2) return sheet.render({ force, focus });
  return sheet.render(force);
}

export function preloadFoundryTemplates(paths = []) {
  const loadTemplates = requireApi(
    globalThis.foundry?.applications?.handlebars?.loadTemplates,
    "foundry.applications.handlebars.loadTemplates"
  );
  return loadTemplates(paths);
}

export function downloadFoundryJson(json = "", fileName = "fbl-skyhold-backup.json") {
  const document = globalThis.document;
  const Url = globalThis.URL;
  const BlobClass = globalThis.Blob;
  if (!document?.createElement || !Url?.createObjectURL || !BlobClass) {
    throw new Error("FBL Skyhold | Browser download API is unavailable.");
  }
  const url = Url.createObjectURL(new BlobClass([String(json ?? "")], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = String(fileName || "fbl-skyhold-backup.json");
  anchor.hidden = true;
  document.body?.append?.(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove?.();
    globalThis.setTimeout?.(() => Url.revokeObjectURL(url), 0);
  }
  return true;
}

export function foundryChatSpeaker(options = {}) {
  const ChatMessage = requireApi(globalThis.foundry?.documents?.ChatMessage, "foundry.documents.ChatMessage");
  return ChatMessage.getSpeaker(options);
}

export function foundryWhisperRecipients(role = "GM") {
  const ChatMessage = requireApi(globalThis.foundry?.documents?.ChatMessage, "foundry.documents.ChatMessage");
  return ChatMessage.getWhisperRecipients?.(role) ?? [];
}

export function createFoundryChatMessage(data = {}, options = {}) {
  const ChatMessage = requireApi(globalThis.foundry?.documents?.ChatMessage, "foundry.documents.ChatMessage");
  return ChatMessage.create(data, options);
}

export function resolveFoundryUuid(uuid, options = {}) {
  if (!uuid) return Promise.resolve(null);
  const fromUuid = requireApi(globalThis.foundry?.utils?.fromUuid, "foundry.utils.fromUuid");
  return fromUuid(uuid, options);
}

export function foundryActorClass() {
  return requireApi(globalThis.foundry?.documents?.Actor, "foundry.documents.Actor");
}

export function foundryItemClass() {
  return requireApi(globalThis.foundry?.documents?.Item, "foundry.documents.Item");
}

export function foundryRollClass() {
  return requireApi(globalThis.foundry?.dice?.Roll, "foundry.dice.Roll");
}

export function playFoundryAudio(data = {}, socketOptions = false) {
  const AudioHelper = requireApi(globalThis.foundry?.audio?.AudioHelper, "foundry.audio.AudioHelper");
  return AudioHelper.play(data, socketOptions);
}
