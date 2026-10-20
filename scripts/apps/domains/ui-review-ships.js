import { formatShipGold } from "../../core/ship-gold.js";
import { tabKeyTarget } from "../common/tab-navigation.js";

// Presentation fixtures only. No live ship context, authority commands or store imports.
export const SHIP_REVIEW_VARIANTS = [
  { id: "current", label: "Сейчас", hint: "Рабочий вариант А с согласованными уточнениями, на демонстрационных данных." },
  { id: "compact", label: "А · Компактные вкладки", hint: "Привычные четыре вкладки. Короткая шапка, плотные строки, подробности по раскрытию." },
  { id: "split", label: "Б · Рабочий стол", hint: "Список и план рядом. Постоянная навигация слева; при узком окне колонки складываются." },
  { id: "steps", label: "В · Подготовка по шагам", hint: "Заказы → план → проверка. Меньше информации за раз, но больше переключений." }
];
export const SHIP_REVIEW_SECTIONS = [
  { id: "layout", label: "Общая компоновка", panel: "orders" },
  { id: "orders", label: "Рейсы и заказы", panel: "orders" },
  { id: "crew", label: "Экипаж", panel: "crew" },
  { id: "finance", label: "Финансы", panel: "finance" },
  { id: "settings", label: "Настройки ГМа", panel: "settings" }
];
export function createShipReviewState() {
  return { variant: "current", scenario: "home", permission: "gm", panel: "orders", step: "orders", width: "880",
    selected: ["grain"], search: "", crewSearch: "", mapOpen: false, crewAssigned: ["runa", "halvard", "astrid", "ulv", "bor", "ida"], disclosures: {},
    decisions: Object.fromEntries(SHIP_REVIEW_SECTIONS.map(({ id }) => [id, { choice: "compact", note: id === "layout" ? "Карта по отдельной кнопке, в большой раскрываемой области. Без повторных чипов команды, трюма и денег у отправления" : "" }])), message: "" };
}
export function formatShipReviewSummary(state) {
  const labels = Object.fromEntries([...SHIP_REVIEW_VARIANTS.map(v => [v.id, v.label]), ["custom", "Свой вариант"]]);
  return ["FBL Skyhold — окно своих кораблей", "Выбор в окне ничего не применяет. Прежние решения сохраняются.", "",
    ...SHIP_REVIEW_SECTIONS.map(({ id, label }) => `${label}: ${labels[state.decisions[id]?.choice] || "Не решено"}${state.decisions[id]?.note ? ` — ${state.decisions[id].note}` : ""}.`)].join("\n");
}
const choices = (rows, selected) => rows.map(([value, label]) => ({ value, label, selected: selected === value }));
const offerRows = [
  ["grain", "Зерно для северного порта", "Зерно", "Скайхолд", "Ассур", 60, 4, 1850, 3400],
  ["timber", "Балки для верфи", "Древесина", "Зелёный пояс", "Ассур", 30, 5, 2420, 4200],
  ["spice", "Пряности торгового дома", "Пряности", "Накабаси", "Соляные острова", 20, 7, 3150, 5800]
];
const crewRows = [
  ["runa", "Руна", "Капитан"], ["halvard", "Хальвард", "Штурман"], ["astrid", "Астрид", "Боцман"],
  ["ulv", "Ульв", "Матрос"], ["bor", "Бор", "Матрос"], ["ida", "Ида", "Кок"],
  ["tor", "Торстен Длинное Имя из Северного Поселения", "Матрос"], ["siv", "Сив", "Плотник"]
];
export function shipReviewContext(state) {
  const isGM = state.permission === "gm", canAct = state.permission !== "view";
  const atHome = ["home", "blocked", "empty"].includes(state.scenario);
  const ownSale = state.scenario === "sale", inTransit = state.scenario === "sailing" || ownSale;
  const blocked = state.scenario === "blocked", empty = state.scenario === "empty";
  const active = inTransit || ownSale;
  const assigned = empty ? [] : crewRows.filter(([id]) => state.crewAssigned.includes(id));
  const readyCount = empty ? 0 : Math.max(0, assigned.length - (blocked ? 2 : 0));
  const crewReady = readyCount >= 6;
  const offers = empty || active ? [] : offerRows.map(([id, title, cargo, pickupLabel, destination, load, days, cost, reward]) => ({
    id, title, pickupLabel, destination, departureLabel: atHome ? "Скайхолд" : "Ассур", selected: state.selected.includes(id),
    contract: { cargo: { name: cargo, loadPoints: load, quantity: load } }, kindLabel: "Перевозка", durationDays: days,
    difficultyLabel: "Обычный риск", approachKm: id === "grain" ? 0 : 120, deliveryKm: days * 80,
    rewardCopper: reward, costs: { totalCopper: cost, foodCopper: 300, crewCopper: 800, upkeepCopper: 400, handlingCopper: cost - 1500, taxCopper: 0 },
    quote: { distanceKm: days * 80 + (id === "grain" ? 0 : 120) }, timing: { flightDays: days - 1, loadingDays: 0.5, unloadingDays: 0.5 },
    attention: { level: 2, label: "Низкое" }, returnReserveCopper: 900, idleReserveCopper: 300, outcomeReserveCopper: 500,
    recommendedBudgetCopper: cost + 1700, styles: [{ styleLabel: "Обычно", riskLabel: "Обычный риск", rewardRangeCopper: { min: reward, max: reward } }]
  }));
  const selected = offers.filter(row => row.selected);
  const load = selected.reduce((n, row) => n + row.contract.cargo.loadPoints, 0);
  const cost = selected.reduce((n, row) => n + row.costs.totalCopper, 0);
  const reward = selected.reduce((n, row) => n + row.rewardCopper, 0);
  const budget = cost + (selected.length ? 1700 : 0);
  const wallet = blocked ? 200 : 8000, treasury = blocked ? 100 : 24000;
  const obligations = atHome ? 0 : 1200, reserve = atHome ? 0 : 3200;
  const free = wallet + (atHome ? treasury : 0) - obligations - reserve;
  const moneyReady = (atHome ? wallet + treasury : wallet - obligations) >= budget;
  const canDepart = canAct && !active && crewReady && moneyReady && load <= 100 && selected.length > 0;
  const statusLabel = ownSale ? "Доставка своего груза" : inTransit ? "В рейсе" : atHome ? "Дома" : "В чужом порту";
  const nextAction = ownSale ? "Доставка своего груза: расчёт во Внешнем рынке" : inTransit ? "До Ассура осталось 2 дня корабельного времени" : !crewReady ? `Не хватает готовых моряков: ${6 - readyCount}` : blocked ? "Недостаточно денег для выбранного рейса" : "Выберите заказы и проверьте план отправления";
  const crewRoster = empty ? [] : assigned.map(([id, name, duty], index) => ({ id, name, duty,
    status: blocked && index > 3 ? (index === 4 ? "Ранен" : "Отсутствует") : "Готов", canOpenResident: true }));
  const crewOptions = crewRows.map(([id, label, duty]) => ({ id, label, name: label, duty, selected: !empty && state.crewAssigned.includes(id),
    selectedLabel: "Приписка", statusLabel: crewRoster.find(r => r.id === id)?.status || "В поселении", searchText: `${label} ${duty}`.toLocaleLowerCase("ru") }));
  const panel = !isGM && state.panel === "settings" ? "orders" : state.panel;
  const tabIcons = { orders: "fa-solid fa-compass", crew: "fa-solid fa-users", finance: "fa-solid fa-coins", settings: "fa-solid fa-sliders" };
  const tabs = choices([["orders", "Рейсы"], ["crew", "Экипаж"], ["finance", "Финансы"], ...(isGM ? [["settings", "Настройки"]] : [])], panel).map(row => ({ ...row, id: row.value, active: row.selected, icon: tabIcons[row.value] }));
  const ship = { id: "review-ship", index: 0, name: "Северная звезда", isWorld: true, atHome, inTransit, active,
    statusLabel, locationLabel: atHome ? "Скайхолд" : inTransit ? "Скайхолд → Ассур" : "Ассур", profileLabel: "Воздушный торговец", conditionLabel: "Исправен", commanderName: "Руна",
    nextAction, needsCrewAttention: !crewReady, needsMoneyAttention: blocked, permissionReason: canAct ? "" : "Только просмотр: действия недоступны.",
    moneySummary: { calculationValid: true, balanceLabel: atHome ? "Доступно дома" : "На борту", balanceCopper: wallet + (atHome ? treasury : 0), settlementCopper: treasury,
      freeCopper: free, reserveKnown: true, reserveCopper: reserve, obligationsCopper: obligations, portDebtCopper: obligations,
      outcomeDueCopper: 0, returnReserveCopper: 1500, idleReserveCopper: 700, remainingOperatingCopper: 600, incidentReserveCopper: 400 },
    walletGold: formatShipGold(wallet), homeUpkeepEnabled: true, homeUpkeepCopperPerDay: 320, capacityLoadPoints: 100, hiddenCapacityLoadPoints: 10,
    occupiedLoadPoints: active ? 60 : 0, speedKmPerDay: 120, readiness: { ready: crewReady, readyCount, requiredCount: 6,
      issues: !crewReady ? [{ message: empty ? "Назначьте команду перед отправлением." : "Бор ранен, Ида отсутствует: проверьте состав перед отправлением." }] : [], warnings: [] },
    crewRoster, crewOptions, hasCrewOptions: true, linkedCrewCount: crewRoster.length, abstractCrewCount: 0,
    canConfigureCrew: isGM && atHome, canManageResidents: canAct, canAdjust: isGM, canGenerateWorld: canAct && !active, canRerollWorld: isGM && !active,
    canDelete: atHome, deleteReason: "Корабль можно удалить дома между рейсами после проверки груза и обязательств.",
    offers, worldOffersGenerated: !empty, commands: {}, financePresentation: { pendingPayments: active ? [{ label: "Доставка в Ассур", amountCopper: 3400, basisLabel: "После доставки и исхода" }] : [],
      outing: active || empty ? null : { ongoing: false, netCopper: 1550, fundingCopper: 4000, incomeCopper: 3400, shipExpenseCopper: 1850, balanceCopper: 5550,
        completedLegs: 1, startedLegs: 1, durationDays: 4, portExpenseCopper: 0, plannedIncomeCopper: 3400, plannedExpenseCopper: 1850, plannedNetCopper: 1550, plannedDays: 4, canComparePlan: true,
        details: [{ timeLabel: "До выхода", kindLabel: "На борт", isTransfer: true, reason: "Подготовка", hasAmount: true, displayAmountCopper: 4000 },
          { timeLabel: "День 1", kindLabel: "Расход", reason: "Путь и грузовые работы", hasAmount: true, displayAmountCopper: -1850 }] } },
    attentionRecords: [{ direction: "Ассур", level: 2, label: "Низкое" }],
    voyagePresentation: inTransit ? { title: "Скайхолд → Ассур", timeExplanation: "Время учитывается при расчёте поселения.", startNumber: 1,
      leg: { label: "Перелёт с грузом", statusLabel: "В пути", hasProgress: true, elapsedQd: 8, totalQd: 16, elapsedDays: 2, durationDays: 4, remainingDays: 2, progressText: "2 из 4 дней" },
      stops: [{ label: "Скайхолд", statusLabel: "Пройден", complete: true }, { label: "Ассур", statusLabel: "Следующий порт", current: true }] } : null,
    ownSale: ownSale ? { marketLabel: "Ассур", revenueCopper: 3400 } : null, ownSaleCargoText: "Зерно · 60 ед.", ownSaleRemainingDays: 2 };
  const planDays = selected.reduce((sum, offer) => sum + offer.durationDays, 0);
  const map = { viewBox: "0 0 600 180", markerRadius: 8, labelSize: 15,
    nodes: [{ label: "Скайхолд", x: 90, y: 70, start: true, isStop: true, stopNumbers: "0" }, { label: "Ассур", x: 480, y: 90, final: true, isStop: true, stopNumbers: "1" }],
    lines: [{ points: "90,70 260,40 480,90", label: "Демонстрационный путь Скайхолд → Ассур", empty: !selected.length }], schematic: true };
  const plan = { map, mapOpen: state.mapOpen, mapPanelId: "review-current-ship-map", selectedCount: selected.length, hasPlan: selected.length > 0, atHome, durationDays: planDays,
    distanceKm: selected.reduce((sum, row) => sum + row.quote.distanceKm, 0), maxLoadPoints: load, capacityLoadPoints: 100, finalPoint: { label: selected.at(-1)?.destination || "—" },
    totalOperatingCopper: cost, rewardCopper: reward, returnReserveCopper: selected.length ? 900 : 0,
    idleReserveCopper: selected.length ? 300 : 0, outcomeReserveCopper: selected.length ? 500 : 0,
    nominalExitCopper: reward - cost - (selected.length ? 900 : 0), recommendedBudgetCopper: budget, onboardCopper: wallet, debtCopper: obligations,
    settlementWithdrawalCopper: Math.max(0, budget - wallet), transferCopper: Math.max(0, budget - wallet), plannedMarginCopper: reward - cost,
    blockers: !crewReady ? ["Команда не готова к отправлению."] : [], shortageCopper: Math.max(0, budget - (wallet + (atHome ? treasury : 0) - obligations)),
    locationLabel: ship.locationLabel, permissionReason: ship.permissionReason };
  return { ...state, ship, plan, map, isGM, canAct, panel, tabs, atHome, active, inTransit, ownSale, empty, blocked, crewReady, readyCount,
    isCompact: state.variant === "compact", isSplit: state.variant === "split", isSteps: state.variant === "steps", isCurrent: state.variant === "current",
    showOrders: panel === "orders", showCrew: panel === "crew", showFinance: panel === "finance", showSettings: panel === "settings",
    showList: state.variant !== "steps" || state.step === "orders", showPlan: state.variant !== "steps" || state.step === "plan", showCheck: state.variant !== "steps" || state.step === "check",
    steps: choices([["orders", "1 · Заказы"], ["plan", "2 · План"], ["check", "3 · Проверка"]], state.step),
    variants: SHIP_REVIEW_VARIANTS.map(v => ({ ...v, selected: v.id === state.variant })), variantHint: SHIP_REVIEW_VARIANTS.find(v => v.id === state.variant)?.hint,
    scenarios: choices([["home", "Дома · подготовка"], ["blocked", "Не хватает команды и денег"], ["sailing", "В рейсе"], ["port", "В чужом порту"], ["sale", "Продажа своего груза"], ["empty", "Нет заказов и команды"]], state.scenario),
    permissions: choices([["gm", "ГМ"], ["edit", "Игрок с правом кораблей"], ["view", "Только просмотр"]], state.permission),
    widths: choices([["880", "880 px · обычное"], ["620", "620 px · узкое"], ["1100", "1100 px · широкое"]], state.width),
    selectedCount: selected.length, selectedOffers: selected, load, cost: formatShipGold(cost), reward: formatShipGold(reward), budget: formatShipGold(budget),
    canDepart, moneyReady, capacityReady: load <= 100, crewOptions, free: formatShipGold(free),
    obligations: formatShipGold(obligations), reserve: formatShipGold(reserve),
    decisions: SHIP_REVIEW_SECTIONS.map(section => ({ ...section, ...state.decisions[section.id],
      options: choices([["", "Не решено"], ...SHIP_REVIEW_VARIANTS.map(v => [v.id, v.label]), ["custom", "Свой вариант / сочетание"]], state.decisions[section.id].choice) })),
    decisionCount: SHIP_REVIEW_SECTIONS.filter(({ id }) => state.decisions[id]?.choice).length,
    summary: formatShipReviewSummary(state),
    currentContext: { holding: { id: "review-holding", name: "Скайхолд" }, holdingIndex: 0,
      shipsContext: { rows: [ship], canCreateProfile: isGM, history: [] }, shipWindowTabs: tabs,
      shipPanels: Object.fromEntries(tabs.map(t => [t.id, t.active])), shipHome: { dedicated: true, locationLabel: "Скайхолд", canPlace: true, routes: [{ key: "demo", label: "Ассур — Зелёный пояс" }] } }
  };
}
export function inertShipReviewHtml(html) {
  return String(html).replace(/\sdata-(?!fbls-tooltip(?:-delay)?\b)([\w-]+)(?=[\s=>])/g, " data-review-source-$1")
    .replace(/\sdraggable=/g, " data-review-source-draggable=");
}
export function renderShipReviewCurrent(context, handlebars = globalThis.Handlebars) {
  const partial = handlebars.partials["modules/fbl-skyhold/templates/ship-app.hbs"];
  if (!partial) throw new Error("Ship review template is unavailable");
  handlebars.registerHelper("fblsShipGold", formatShipGold);
  let html = (typeof partial === "function" ? partial : handlebars.compile(partial))(context.currentContext);
  const preview = handlebars.partials["modules/fbl-skyhold/templates/parts/ship-window/order-preview.hbs"];
  if (preview) html = html.replace(/(<div data-ship-planner-preview[^>]*>)(<\/div>)/, (_match, start, end) =>
    start + (typeof preview === "function" ? preview : handlebars.compile(preview))(context.plan) + end);
  return inertShipReviewHtml(html);
}
export function renderShipReviewMap(context, handlebars = globalThis.Handlebars) {
  const partial = handlebars.partials["modules/fbl-skyhold/templates/parts/ship-window/route-map-view.hbs"];
  return inertShipReviewHtml((typeof partial === "function" ? partial : handlebars.compile(partial))(context.map));
}

export function bindShipReview(app, root, state, signal) {
  const demo = root.querySelector("[data-ship-review]");
  if (!demo) return;
  const context = shipReviewContext(state);
  for (const field of demo.querySelectorAll("[data-review-source-ship-bundle-select]")) {
    field.checked = state.selected.includes(field.value);
    field.closest(".fbls-ship-order")?.classList.toggle("is-selected", field.checked);
  }
  for (const [name, value] of [["order", state.search], ["roster", state.crewSearch]]) {
    const search = demo.querySelector(`[data-review-source-ship-${name}-search]`);
    if (search) search.value = value;
  }
  const planned = demo.querySelector("[data-review-source-ship-planned]");
  if (planned) planned.disabled = !context.canDepart;
  for (const detail of demo.querySelectorAll(".fbls-review-ship-frame details")) {
    const offerId = detail.closest("[data-ship-review-offer]")?.querySelector("[data-ship-review-order]")?.value || "";
    const key = `${state.variant}:${context.panel}:${offerId}:${detail.dataset.reviewSourceShipDisclosure || detail.querySelector("summary")?.textContent.trim()}`;
    if (Object.hasOwn(state.disclosures, key)) detail.open = state.disclosures[key];
    detail.addEventListener("toggle", () => { state.disclosures[key] = detail.open; }, { signal });
  }
  const rerender = target => { app._shipReviewFocus = target?.getAttribute("data-ship-review-setting") ? `[data-ship-review-setting="${target.dataset.shipReviewSetting}"]` : null; app.requestRender(); };
  const updateSummary = () => {
    root.querySelector("[data-review-summary]").value = formatShipReviewSummary(state);
    root.querySelector("[data-review-count]").textContent = `${SHIP_REVIEW_SECTIONS.filter(({ id }) => state.decisions[id]?.choice).length}/5 решений`;
  };
  demo.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || !demo.contains(button)) return;
    const d = button.dataset;
    if (Object.hasOwn(d, "shipReviewMapToggle") || Object.hasOwn(d, "reviewSourceShipPlannerMapToggle")) {
      state.mapOpen = !state.mapOpen;
      const panel = demo.querySelector("[data-ship-review-map], [data-review-source-ship-planner-map]");
      if (panel) panel.hidden = !state.mapOpen;
      button.setAttribute("aria-expanded", String(state.mapOpen));
      return;
    }
    if (d.shipReviewVariant) state.variant = d.shipReviewVariant;
    else if (d.shipReviewPanel) state.panel = d.shipReviewPanel;
    else if (d.shipReviewStep) state.step = d.shipReviewStep;
    else if (d.reviewSourceShipWindowTab || d.reviewSourceShipPanelTarget) state.panel = d.reviewSourceShipWindowTab || d.reviewSourceShipPanelTarget;
    else if (d.shipReviewDemo || d.reviewSourceAction || d.reviewSourceRouteViewAction || Object.hasOwn(d, "reviewSourceShipPlannerClear")) {
      state.message = "Демонстрация: действие показано для оценки компоновки; корабль, деньги и состав не изменены.";
      demo.querySelector("[data-ship-review-message]").textContent = state.message;
      return;
    } else return;
    event.preventDefault();
    app._shipReviewFocus = d.shipReviewVariant ? `[data-ship-review-variant="${state.variant}"]` : d.shipReviewStep ? `[data-ship-review-step="${state.step}"]` : `[data-ship-review-panel="${state.panel}"], [data-review-source-ship-window-tab="${state.panel}"]`;
    app.requestRender();
  }, { signal });
  demo.addEventListener("change", event => {
    const target = event.target;
    if (target.matches("[data-ship-review-setting]")) {
      const allowed = { scenario: ["home", "blocked", "sailing", "port", "sale", "empty"], permission: ["gm", "edit", "view"], width: ["620", "880", "1100"] };
      const key = target.dataset.shipReviewSetting;
      if (!allowed[key]?.includes(target.value)) return;
      state[key] = target.value; state.message = ""; rerender(target);
    } else if (target.matches("[data-ship-review-order], [data-review-source-ship-bundle-select]")) {
      const selected = new Set(state.selected);
      if (target.checked) selected.add(target.value); else selected.delete(target.value);
      state.selected = [...selected]; app._shipReviewFocus = `[data-ship-review-order][value="${target.value}"], [data-review-source-ship-bundle-select][value="${target.value}"]`; app.requestRender();
    } else if (target.matches("[data-ship-review-crew]")) {
      const selected = new Set(state.crewAssigned);
      if (target.checked) selected.add(target.value); else selected.delete(target.value);
      state.crewAssigned = [...selected];
      demo.querySelector("[data-ship-review-crew-count]").textContent = `Выбрано: ${selected.size}`;
    } else if (target.matches("[data-ship-review-decision]")) {
      const id = target.dataset.shipReviewDecision;
      if (state.decisions[id] && ["", "custom", ...SHIP_REVIEW_VARIANTS.map(v => v.id)].includes(target.value)) state.decisions[id].choice = target.value;
      updateSummary();
    }
  }, { signal });
  demo.addEventListener("input", event => {
    const target = event.target;
    if (target.matches("[data-ship-review-note]")) { const decision = state.decisions[target.dataset.shipReviewNote]; if (decision) decision.note = target.value; updateSummary(); }
    if (target.matches("[data-ship-review-search], [data-review-source-ship-order-search], [data-review-source-ship-roster-search]")) {
      const crew = target.dataset.shipReviewSearch === "crew" || target.hasAttribute("data-review-source-ship-roster-search");
      state[crew ? "crewSearch" : "search"] = target.value;
      filter(crew);
    }
  }, { signal });
  function filter(crew) {
    const query = state[crew ? "crewSearch" : "search"].toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
    const kind = crew ? "roster" : "order";
    const rows = [...demo.querySelectorAll(context.isCurrent ? `[data-review-source-ship-${kind}-search-text]` : crew ? "[data-ship-review-person]" : "[data-ship-review-offer]")];
    rows.forEach(row => { row.hidden = !(context.isCurrent ? row.getAttribute(`data-review-source-ship-${kind}-search-text`) : row.textContent).toLocaleLowerCase("ru").replace(/ё/g, "е").includes(query); });
    const empty = demo.querySelector(context.isCurrent ? `[data-review-source-ship-${kind}-empty]` : `[data-ship-review-empty="${crew ? "crew" : "orders"}"]`);
    if (empty) empty.hidden = context.isCurrent && !rows.length || rows.some(row => !row.hidden);
  }
  filter(false); filter(true);
  demo.addEventListener("keydown", event => {
    const button = event.target.closest("[data-ship-review-variant], [data-ship-review-panel], [data-ship-review-step]");
    if (!button || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...button.parentElement.querySelectorAll("button")];
    const next = tabKeyTarget(event.key, buttons.indexOf(button), buttons.length);
    if (next === null) return;
    event.preventDefault(); buttons[next].click();
  }, { signal });
  if (app._shipReviewFocus) { demo.querySelector(app._shipReviewFocus)?.focus({ preventScroll: true }); app._shipReviewFocus = null; }
}
