function showFallback(image) {
  image.hidden = true;
  const fallback = image.parentElement?.querySelector?.("[data-fbls-image-fallback-icon]");
  if (fallback) fallback.hidden = false;
}

export function capturePersistentImages(root = null) {
  const images = new Map();
  for (const image of root?.querySelectorAll?.("img[data-fbls-persistent-image]") ?? []) {
    const key = String(image.dataset.fblsPersistentImage ?? "").trim();
    if (key) images.set(key, image);
  }
  return images;
}

export function restorePersistentImages(root = null, images = null) {
  if (!(images instanceof Map) || !images.size) return;
  for (const nextImage of root?.querySelectorAll?.("img[data-fbls-persistent-image]") ?? []) {
    const key = String(nextImage.dataset.fblsPersistentImage ?? "").trim();
    const previous = images.get(key);
    if (!previous || previous.getAttribute("src") !== nextImage.getAttribute("src")) continue;
    nextImage.replaceWith(previous);
    const fallback = previous.parentElement?.querySelector?.("[data-fbls-image-fallback-icon]");
    if (fallback) fallback.hidden = !previous.hidden;
  }
}

export function bindImageFallbacks(root = null) {
  for (const image of root?.querySelectorAll?.("img[data-fbls-image-fallback]") ?? []) {
    if (image.dataset.fblsFallbackBound === "true") continue;
    image.dataset.fblsFallbackBound = "true";
    image.addEventListener("error", () => showFallback(image), { once: true });
    if (image.complete && (!image.naturalWidth || !image.naturalHeight)) showFallback(image);
  }
}
