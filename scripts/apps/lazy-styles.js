import { MODULE_ID } from "../data/constants.js";

const STYLE_PATHS = Object.freeze({
  secondary: `modules/${MODULE_ID}/styles/skyhold-secondary.css`,
  templateBrowser: `modules/${MODULE_ID}/styles/skyhold-template-browser.css`
});

const pendingStyles = new Map();

export function ensureSkyholdStylesheet(key) {
  const path = STYLE_PATHS[key];
  if (!path || typeof document === "undefined") return Promise.resolve(false);
  const existing = document.querySelector(`link[data-fbl-skyhold-style="${key}"]`);
  if (pendingStyles.has(key)) return pendingStyles.get(key);
  if (existing?.dataset.fblSkyholdLoaded === "true") return Promise.resolve(true);
  existing?.remove();
  const promise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = path;
    link.dataset.fblSkyholdStyle = key;
    link.addEventListener("load", () => {
      link.dataset.fblSkyholdLoaded = "true";
      resolve(true);
    }, { once: true });
    link.addEventListener("error", () => {
      link.remove();
      reject(new Error(`FBL Skyhold | Failed to load stylesheet ${path}`));
    }, { once: true });
    document.head.append(link);
  }).finally(() => pendingStyles.delete(key));
  pendingStyles.set(key, promise);
  return promise;
}
