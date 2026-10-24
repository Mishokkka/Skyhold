export function escapeHtml(value) {
  const text = String(value ?? "");
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function escapeAttribute(value) {
  return escapeHtml(value);
}

export function safeIconClasses(value, fallback = ["fa-solid", "fa-circle"]) {
  const classes = String(value ?? "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => /^(fa[srldb]?|fa-(solid|regular|brands|light|duotone|thin)|fa-[a-z0-9-]+)$/i.test(item));
  return classes.length ? [...new Set(classes)] : [...fallback];
}

export function createSafeIcon(classString, fallback = ["fa-solid", "fa-circle"]) {
  const icon = document.createElement("i");
  for (const className of safeIconClasses(classString, fallback)) icon.classList.add(className);
  return icon;
}

export function setText(element, value) {
  if (element) element.textContent = String(value ?? "");
  return element;
}
