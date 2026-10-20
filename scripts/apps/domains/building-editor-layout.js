// Building editor presentation: move existing controls without changing field paths or values.
function group(parent, title, nodes, { collapsed = false, grid = true } = {}) {
  const items = nodes.filter(Boolean);
  if (!items.length) return null;
  const doc = parent.ownerDocument;
  const section = doc.createElement(collapsed ? "details" : "section");
  section.className = "fbls-editor-group";
  if (collapsed) {
    const sample = parent.closest(".fbls-building-editor-layout");
    const project = parent.closest("[data-building-project-id], [data-review-source-building-project-id]");
    section.dataset.fblsDisclosure = `editor-${sample?.dataset.fblsEditorTab}-${project?.dataset.buildingProjectId ?? project?.dataset.reviewSourceBuildingProjectId ?? ""}-${title}`;
  }
  const heading = doc.createElement(collapsed ? "summary" : "h4");
  heading.textContent = title;
  section.append(heading);
  const body = doc.createElement("div");
  body.className = grid ? (items.every(node => node.matches(".fbls-choice-toggle")) ? "fbls-cluster" : "fbls-editor-fields") : "fbls-stack";
  body.append(...items);
  section.append(body);
  parent.append(section);
  return section;
}
const children = node => node ? [...node.children] : [];
const take = (root, selector) => [...root.querySelectorAll(selector)];
function shortenLabel(label, text) {
  const span = label?.querySelector(":scope > span");
  if (!span) return;
  span.dataset.fblsTooltip ||= span.textContent.trim();
  label.dataset.fblsTooltip ||= span.dataset.fblsTooltip;
  const control = label.querySelector("input, select, textarea");
  if (control && !control.hasAttribute("aria-label")) control.setAttribute("aria-label", span.textContent.trim());
  span.textContent = text;
}
function shorten(root, selector, text) { shortenLabel(root.querySelector(selector), text); }
const caption = node => node.querySelector(":scope > span")?.textContent?.trim();
function regroup(parent, title, selector, settings) {
  return group(parent, title, take(parent, selector), settings);
}
function fieldRow(node) {
  node?.classList.add("fbls-editor-fields");
}
function cardFor(root) { return root.querySelector(".fbls-building-editor-card"); }

function main(root) {
  const cards = take(root, ".fbls-building-editor-card");
  const first = cards[0];
  const passport = first.querySelector(".fbls-building-main-identity");
  const template = first.querySelector(".fbls-building-main-template");
  const economy = first.querySelector(".fbls-building-main-economy");
  const status = first.querySelector(".fbls-building-main-status");
  const functions = first.querySelector(".fbls-function-strip");
  const texts = first.querySelector(".fbls-main-effects-grid");
  const pending = first.querySelector(".fbls-pending-production");
  group(first, "Паспорт", [...children(passport), ...children(template)]);
  group(first, "Деньги · ММ", children(economy).slice(0, 3));
  group(first, "Обслуживание", [...children(economy), ...children(status)]);
  group(first, "Функции", children(functions));
  group(first, "Описание и заметки", children(texts), { collapsed: true });
  if (pending) first.insertBefore(pending, first.querySelector(".fbls-editor-group"));
  for (const node of [passport, template, economy, status, functions, texts]) node?.remove();
  shorten(first, "label:has([data-field$='.backlogTendays'])", "Пропуски");
  const backlog = take(first, "label > span").find(span => span.textContent === "Backlog");
  if (backlog) shortenLabel(backlog.parentElement, "Пропуски");
  const rules = cards[1];
  if (!rules) return;
  const blocks = children(rules).filter(node => node.tagName !== "LEGEND");
  const conditions = blocks[0];
  const activation = blocks[1];
  group(rules, "Условия действия", children(conditions));
  group(rules, "Активация и повтор", children(activation));
  conditions?.remove(); activation?.remove();
  for (let index = 2; index < blocks.length; index++) {
    const node = blocks[index];
    if (node.classList.contains("fbls-subhead")) {
      const title = node.textContent.trim();
      const row = blocks[++index];
      const extra = title === "Общественная услуга" ? blocks[++index] : null;
      group(rules, title, [...children(row), extra]);
      row?.remove(); node.remove();
    } else group(rules, "Связи улучшения", [node], { collapsed: true });
  }
}

function workers(root) {
  const card = cardFor(root);
  const top = card.querySelector(".fbls-worker-top-row");
  const assigned = card.querySelector(".fbls-assigned-worker-area");
  const profiles = card.querySelector(".fbls-worker-profile-grid");
  group(card, "Штат", children(top)); top.remove();
  if (assigned) group(card, "Назначения", [assigned], { grid: false });
  group(card, "Допуск и квалификация", [profiles], { collapsed: true, grid: false });
  for (const help of take(card, ":scope > .fbls-worker-profile-help")) card.append(help);
  for (const heading of take(profiles, ".fbls-worker-profile-heading")) {
    heading.classList.remove("fbls-worker-profile-rule");
    heading.lastElementChild?.remove();
  }
  for (const row of take(profiles, ".fbls-worker-profile-rule")) {
    for (const control of children(row).filter(node => node.matches("input, select"))) {
      const label = root.ownerDocument.createElement("label");
      const text = root.ownerDocument.createElement("span");
      text.textContent = control.getAttribute("aria-label") || "Значение";
      control.before(label); label.append(text, control);
    }
  }
}

function construction(root) {
  const card = cardFor(root);
  const row = card.querySelector(".fbls-build-main-row");
  const dev = row.querySelector(".fbls-construction-dev-inline");
  const stages = group(card, "Стадии · развитие · действия", [...children(row).filter(node => node.matches("label")), ...children(dev?.querySelector(".fbls-dev-line-fields")), ...children(row).filter(node => node.matches("button"))]);
  stages?.classList.add("fbls-editor-construction");
  for (const label of stages?.querySelectorAll("label:has(i)") ?? []) label.classList.add("fbls-editor-development-requirement");
  row.remove();
  const grid = card.querySelector(".fbls-build-subgrid");
  group(card, "Материалы и здания", children(grid), { grid: false }); grid.remove();
  for (const costs of take(card, ".fbls-cost-row")) costs.classList.add("fbls-editor-cost");
}

function projects(root) {
  const card = cardFor(root);
  for (const project of take(card, "article.fbls-card")) {
    const fields = project.querySelector(".fbls-building-main-line");
    const labels = children(fields);
    group(project, "Проект", labels.slice(0, 2));
    group(project, "Ход работы", labels.slice(2, 5));
    group(project, "Решение GM", labels.slice(5)); fields.remove();
    const targets = project.querySelector(".fbls-main-effects-grid");
    group(project, "Участники", children(targets).slice(0, 1));
    group(project, "Цели · ID", children(targets), { collapsed: true }); targets.remove();
    regroup(project, "Затраты", ":scope > .fbls-cost-list", { grid: false });
    regroup(project, "Заметки", ":scope > label", { collapsed: true });
  }
  for (const costs of take(card, ".fbls-cost-row")) costs.classList.add("fbls-editor-cost");
}

function production(root) {
  for (const line of take(root, ".fbls-production-card")) {
    const recipe = line.querySelector(".fbls-production-card-grid");
    const utility = line.querySelector(".fbls-production-utility-row");
    const advanced = line.querySelector(".fbls-production-advanced");
    const footer = line.querySelector(".fbls-production-card-footer");
    group(line, "Рецепт", children(recipe)); recipe.remove();
    group(line, "Работа и доставка", children(utility)); utility.remove();
    const controls = children(advanced);
    const collection = controls.filter(node => node.matches(".fbls-production-collect-toggle") || caption(node) === "Автосбор");
    const expenses = controls.filter(node => caption(node) === "Расходы");
    group(line, "Сбор", collection);
    group(line, "Материалы и затраты", children(advanced)); advanced.remove();
    shortenLabel(expenses[0], "Материалы");
    shortenLabel(expenses[1], "Учёт расхода");
    const hint = line.querySelector(".fbls-expense-picker small");
    if (hint) group(hint.parentElement, "Как задавать расходы", [hint], { collapsed: true, grid: false });
    if (footer) line.append(footer);
  }
}

function agriculture(root) {
  const panels = take(root, ".fbls-production-panel");
  for (const card of take(panels[2], ".fbls-production-card")) {
    const row = card.querySelector(".fbls-production-card-grid");
    const fields = children(row);
    const footer = card.querySelector("footer");
    group(card, "Культура и выпуск", fields.slice(0, 3));
    group(card, "Этапы · QD", fields.slice(3, 6));
    group(card, "Срок готового урожая", fields.slice(6)); row.remove();
    for (const utility of take(card, ":scope > .fbls-production-utility-row")) card.append(utility);
    if (footer) card.append(footer);
    shortenLabel(fields[3], "Посев, QD");
  }
  const state = panels[3];
  if (state) {
    group(cardFor(root), "Ручная корректировка состояния", [state], { collapsed: true, grid: false });
    state.querySelector(".fbls-panel-header")?.remove();
    for (const row of take(state, ".fbls-production-card-grid")) fieldRow(row);
  }
  for (const row of take(panels[1], ".fbls-production-card-grid")) fieldRow(row);
}

function livestock(root) {
  const panels = take(root, ".fbls-production-panel");
  const headcount = panels[1]?.querySelector(".fbls-production-card");
  const row = headcount?.querySelector(".fbls-production-card-grid");
  if (row) {
    const fields = children(row);
    group(headcount, "Поголовье", fields.filter(node => !["Приоритет корма", "Приоритет GM", "Склад продукции"].includes(caption(node))));
    group(headcount, "Корм и склад", children(row)); row.remove();
  }
  for (const cohort of take(panels[1], ".fbls-production-card").filter(node => node !== headcount)) {
    cohort.classList.add("fbls-editor-cohort"); fieldRow(cohort.querySelector(".fbls-production-card-grid"));
  }
  const orders = panels[2]?.querySelector(".fbls-production-card");
  const orderRow = orders?.querySelector(".fbls-production-card-grid");
  if (orderRow) {
    group(orders, "Ежедневный уход", children(orderRow).filter(node => node.matches(".fbls-choice-toggle")));
    group(orders, "Разовые распоряжения", children(orderRow)); orderRow.remove();
  }
}

function income(root) {
  const card = cardFor(root);
  const direct = card.querySelector(".fbls-income-grid");
  const fields = children(direct);
  group(card, "Прямой доход · ММ / десятник", [...fields.slice(0, 4), ...fields.slice(6)]);
  group(card, "Расходы функции · ММ", fields.slice(4, 6)); direct.remove();
  const trade = card.querySelector(".fbls-trade-editor-block");
  const row = trade.querySelector(".fbls-trade-grid");
  const labels = children(row);
  group(card, "Торговый канал", labels.slice(0, 6));
  group(card, "Спрос и разрешённые товары", labels.slice(6, 10));
  group(card, "Услуги", labels.slice(10)); row.remove();
  group(card, "Механика торговли и заметки", children(trade), { collapsed: true, grid: false }); trade.remove();
}
function defense(root) {
  const card = cardFor(root);
  const row = card.querySelector(".fbls-defense-grid");
  const fields = children(row);
  group(card, "Защита", [...fields.slice(0, 3), fields[4]]);
  group(card, "Отряд здания", [fields[3]]); row.remove();
}
function housing(root) {
  const card = cardFor(root);
  const row = card.querySelector(".fbls-housing-building-grid");
  group(card, "Параметры жилья", children(row)); row.remove();
  regroup(card, "Занятость и заселение", ":scope > .fbls-housing-building-current, :scope > .fbls-housing-slot-grid, :scope > p", { grid: false });
  regroup(card, "Заметки", ":scope > label", { collapsed: true });
}
function storage(root) {
  const card = cardFor(root);
  const row = card.querySelector(".fbls-storage-building-grid");
  const fields = children(row);
  group(card, "Помещение", fields.slice(0, 4));
  regroup(card, "Заполнение", ":scope > .fbls-storage-building-current", { grid: false });
  group(card, "Специализация", [...fields.slice(4, 6), ...take(card, ":scope > .fbls-cluster")]);
  group(card, "Подбор товаров для профиля", fields.slice(6), { collapsed: true }); row.remove();
  for (const hint of take(card, ":scope > p")) card.append(hint);
}
function culture(root) {
  const card = cardFor(root);
  const row = card.querySelector(".fbls-building-main-line");
  const hint = card.querySelector(":scope > p");
  group(card, "Досуг и Довольство", [...children(row), hint]); row.remove();
  const faith = card.querySelector(".fbls-culture-religion-grid");
  const fields = children(faith);
  group(card, "Топливо", fields.filter(node => caption(node) === "Выбранное топливо"));
  group(card, "Вера и описание", children(faith)); faith.remove();
  card.querySelector(":scope > .fbls-subhead")?.remove();
  for (const text of take(card, ":scope > p")) card.append(text);
}
function navigation(root) {
  const row = root.querySelector(".fbls-building-editor-tabs");
  if (!row) return;
  const tabs = children(row);
  const general = node => ["main", "workers", "construction"].includes(node.dataset.editorTab ?? node.dataset.reviewSourceEditorTab);
  const sections = [
    group(row, "Общие настройки", tabs.filter(general)),
    group(row, "Функции здания", tabs.filter(node => !general(node)))
  ];
  // Navigation wraps as a row; it must not inherit the form-field grid.
  for (const section of sections) if (section) section.lastElementChild.className = "fbls-cluster";
  row.classList.add("fbls-editor-navigation");
}
const layouts = { main, workers, construction, projects, production, agriculture, livestock, income, defense, housing, storage, culture, navigation };

export function prepareBuildingEditorLayout(root, { tab = "main", navigation: withNavigation = true } = {}) {
  if (!root) return;
  const grid = root.querySelector(".fbls-building-editor-grid");
  if (!grid || grid.dataset.fblsEditorPrepared) return;
  root.classList.add("fbls-building-editor-layout");
  root.dataset.fblsEditorTab = tab;
  if (withNavigation) navigation(root);
  if (tab !== "navigation") layouts[tab]?.(root);
  grid.dataset.fblsEditorPrepared = "true";
  for (const control of root.querySelectorAll("input:not([type='checkbox']), select, textarea")) {
    const label = control.closest("label");
    const text = label?.querySelector(":scope > span")?.textContent?.trim();
    if (!control.hasAttribute("aria-label") && text) control.setAttribute("aria-label", text);
    if (!control.hasAttribute("aria-label") && control.closest(".fbls-cost-row")) {
      const resource = control.closest(".fbls-cost-row").querySelector(".fbls-resource-picker-button span")?.textContent?.trim();
      control.setAttribute("aria-label", `Количество: ${resource || "ресурс"}`);
    }
  }
}
