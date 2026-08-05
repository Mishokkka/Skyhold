function windowFrameFor(root) {
  return root?.closest?.(".application, .app, .window-app") ?? root?.parentElement?.closest?.(".application, .app, .window-app") ?? root;
}

export function syncEventContextHeaderButton(app, root) {
  const frame = windowFrameFor(root ?? app?.element);
  const header = frame?.querySelector?.(".window-header");
  if (!header) return;
  header.querySelectorAll(".fbls-event-context-titlebar-button").forEach((button) => button.remove());
  if (!game.user?.isGM) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "fbls-event-context-titlebar-button";
  button.title = "Пороги и факты случайных событий";
  button.setAttribute("aria-label", "Пороги и факты случайных событий");
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-fingerprint";
  button.append(icon);
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("mousedown", (event) => event.stopPropagation());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    app?._onOpenContextEditor?.();
  });

  const controls = header.querySelector(".window-controls, .header-control, .window-header-buttons");
  if (controls?.parentElement === header) header.insertBefore(button, controls);
  else header.appendChild(button);
}

export function removeEventContextHeaderButton(app, root = null) {
  const frame = windowFrameFor(root ?? app?.element);
  frame?.querySelectorAll?.(".fbls-event-context-titlebar-button")?.forEach((button) => button.remove());
}
