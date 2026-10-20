// Navigation changes use each window's existing click path, including permissions.
export function tabKeyTarget(key, index, count) {
  if (count < 1 || index < 0) return null;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index + count - 1) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

export function bindTabNavigation(app, root, { signal } = {}) {
  if (!root?.querySelectorAll) return;
  const doc = root.ownerDocument;
  const prefix = String(app.id ?? "skyhold").replace(/[^a-zA-Z0-9_-]/g, "-");
  const lists = [...root.querySelectorAll("[data-fbls-tablist]")];
  for (const list of lists) {
    const group = list.dataset.fblsTablist;
    const tabs = [...list.querySelectorAll("[data-fbls-tab-value]")];
    const selected = tabs.find((tab) => tab.classList.contains("active") || tab.getAttribute("aria-selected") === "true") ?? tabs[0];
    list.setAttribute("role", "tablist");
    for (const tab of tabs) {
      tab.id = `${prefix}-${group}-${tab.dataset.fblsTabValue}`;
      tab.setAttribute("role", "tab");
      tab.removeAttribute("aria-pressed");
      tab.setAttribute("aria-selected", String(tab === selected));
      tab.setAttribute("aria-controls", `${prefix}-${group}-panel`);
      tab.tabIndex = tab === selected ? 0 : -1;
    }
    // These applications render one current panel per group, rather than hidden copies.
    for (const panel of root.querySelectorAll(`[data-fbls-tab-panel="${group}"]`)) {
      panel.id = `${prefix}-${group}-panel`;
      panel.setAttribute("role", "tabpanel");
      if (selected) panel.setAttribute("aria-labelledby", selected.id);
    }
  }
  const pending = app._tabNavigationFocus;
  app._tabNavigationFocus = null;
  if (pending && Date.now() - pending.time < 5000) {
    const active = doc?.activeElement;
    const canRestore = !active || active === doc.body || active === pending.element || !active.isConnected;
    if (canRestore) {
      const list = lists.find((element) => element.dataset.fblsTablist === pending.group);
      const tab = [...(list?.querySelectorAll("[data-fbls-tab-value]") ?? [])].find((element) => element.dataset.fblsTabValue === pending.value);
      tab?.focus({ preventScroll: true });
    }
  }
  root.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tab = event.target?.closest?.("[data-fbls-tab-value]");
    const list = tab?.closest?.("[data-fbls-tablist]");
    if (!list || !root.contains(list)) return;
    const tabs = [...list.querySelectorAll("[data-fbls-tab-value]")].filter((element) => !element.disabled && !element.hidden && element.getAttribute("aria-disabled") !== "true");
    const index = tabKeyTarget(event.key, tabs.indexOf(tab), tabs.length);
    if (index === null) return;
    event.preventDefault();
    const target = tabs[index];
    target.focus({ preventScroll: true });
    if (target.getAttribute("aria-selected") === "true") {
      app._tabNavigationFocus = null;
      return;
    }
    app._tabNavigationFocus = { group: list.dataset.fblsTablist, value: target.dataset.fblsTabValue, element: target, time: Date.now() };
    target.click();
  }, { signal });
}
