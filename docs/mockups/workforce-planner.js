/* Standalone design fixture: no Foundry API, storage, network or engine imports. */
(() => {
  "use strict";
  const baseWorkers = [
    { id: "ivan", name: "Иван", role: "Земледелец · лесоруб", skills: ["field", "wood", "quarry"] },
    { id: "maria", name: "Мария", role: "Скотница · обслуживание", skills: ["care", "inn"] },
    { id: "petr", name: "Пётр", role: "Кожевник · кузнец", skills: ["tannery", "forge"] },
    { id: "anna", name: "Анна", role: "Трактирщица · уход за скотом", skills: ["inn", "care"] },
    { id: "egor", name: "Егор", role: "Лесоруб · каменотёс", skills: ["wood", "quarry", "field"] }
  ];
  const tasks = [
    { id: "care", title: "Коровник", job: "Ежедневный уход", need: 10, kind: "required", type: "daily", qualified: true, description: "Животным нужен уход: в примере один смотритель по 1 QD каждый день. Это потребность уже содержащегося скота." },
    { id: "field", title: "Поле № 1", job: "Закончить посев", need: 8, kind: "chosen", type: "stage", description: "Поселение уже выбрало посев. Текущему этапу осталось 8 QD; после него постоянное назначение не требуется." },
    { id: "tannery", title: "Кожевня", job: "Подготовить партию", need: 3, kind: "chosen", type: "stage", qualified: true, description: "У начатой партии осталось 3 QD подготовки, затем ожидание. Только здесь лишние назначения дают прогноз простоя." },
    { id: "inn", title: "Трактир", job: "Обслуживание", need: 20, kind: "chosen", type: "service", qualified: true, description: "Поселение решило открыть трактир. В примере нужны два служащих по 10 QD; один с 20 QD не заменяет состав." },
    { id: "forge", title: "Кузница", job: "Изготовить инструменты", need: 12, kind: "chosen", type: "work", qualified: true, description: "Выбранный игроками план труда — 12 QD. Это цель поселения на десятник, а не обязательство занять все места." },
    { id: "wood", title: "Лесоповал", job: "Добыча по желанию", need: null, kind: "optional", type: "work", slots: 12, description: "12 рабочих мест — возможность производить древесину. Можно не назначать никого. Назначения дают добычу; свободные места не создают дефицит или простой." },
    { id: "quarry", title: "Каменоломня", job: "Добыча по желанию", need: null, kind: "optional", type: "work", slots: 12, description: "12 рабочих мест. Объём труда выбирают игроки. Можно просто назначать людей или задать собственный план QD для помощника." },
    { id: "cheese", title: "Сыроварня", job: "Выдержка · ещё 18 дней", need: null, kind: "optional", type: "waiting", description: "Вся ёмкость занята созревающей партией. Сейчас труд не нужен; это нормальное ожидание, не незакрытая работа." },
    { id: "mill", title: "Мельница", job: "Нет зерна для помола", need: null, kind: "optional", type: "blocked", description: "Нет доступного сырья и выбранного плана помола. Это недоступная возможность, а не обязательная работа или ошибка плана." }
  ];
  const initial = [
    { task: "field", worker: "ivan", qd: 4, locked: false },
    { task: "care", worker: "maria", qd: 10, locked: true },
    { task: "tannery", worker: "petr", qd: 6, locked: false },
    { task: "inn", worker: "anna", qd: 10, locked: false },
    { task: "wood", worker: "ivan", qd: 8, locked: false },
    { task: "wood", worker: "egor", qd: 12, locked: false },
    { task: "forge", worker: "petr", qd: 12, locked: false }
  ];
  const symbols = { care: "M5 5h14v9a7 7 0 0 1-14 0ZM5 5 3 2m16 3 2-3M8 17h8", field: "M12 21V4m0 5C5 9 4 4 4 4c6 0 8 5 8 5Zm0 6c7 0 8-5 8-5-6 0-8 5-8 5Z", tannery: "m7 3 5 3 5-3 4 5-4 4 2 7-7 2-7-2 2-7-4-4Z", inn: "M5 4h11v15H5Zm11 3h4v7h-4M8 8v7m5-7v7", forge: "M3 12h18l-5 4H9Zm6 4-2 5h12l-3-5M8 8l7-6 4 4-7 6", wood: "m12 2 7 8h-3l5 7H3l5-7H5Zm0 15v5", quarry: "m3 18 4-11 8-4 6 9-3 8H5Zm4-11 5 7 9-2m-9 2-7 6", cheese: "m3 10 12-7 6 7v10H3Zm0 0h18M7 14h.01M15 17h.01", mill: "M10 8v13h7V8M13 8 4 3l-2 4 11 1 8-5 2 4-10 1Z" };
  const clone = value => JSON.parse(JSON.stringify(value));
  const $ = selector => document.querySelector(selector);
  const sum = list => list.reduce((n, row) => n + row.qd, 0);
  const taskById = id => tasks.find(t => t.id === id);
  let workers = [], assignments = clone(initial), goals = { wood: null, quarry: null };
  let saved, undo = null, savedOnce = false, population = 20;
  let view = "tasks", filters = { tasks: "all", workers: "all" }, query = "", sort = "default", page = 0;
  let selectedTask = "wood", selectedWorker = "ivan", candidate = "ivan", candidateQuery = "", candidatePage = 0, onlyFree = true;
  let selected = new Set(), toastTimer;
  const workerById = id => workers.find(w => w.id === id);
  const state = () => ({ assignments: clone(assignments), goals: clone(goals) });
  const restore = snapshot => { assignments = clone(snapshot.assignments); goals = clone(snapshot.goals); };
  function makeWorkers(count) {
    const names = ["Алексей", "Борис", "Василий", "Глеб", "Данила", "Елисей", "Захар", "Илья", "Кирилл", "Лев", "Макар", "Никита", "Олег", "Павел", "Роман"];
    const surnames = ["Белов", "Ветров", "Горин", "Дубов", "Зорин", "Кедров", "Луговой", "Мельник", "Озеров", "Рощин", "Серов", "Тихов", "Уваров", "Фомин"];
    const profiles = [["Разнорабочий", ["field", "wood", "quarry"]], ["Скотник", ["care"]], ["Ремесленник", ["forge", "tannery"]], ["Служащий", ["inn"]]];
    const result = baseWorkers.map(w => ({ ...w, capacity: 20, reason: "" }));
    const unavailable = Math.floor(count / 10);
    for (let index = 5; index < count; index++) {
      const [role, skills] = profiles[(index - 5) % profiles.length];
      const reason = index >= count - unavailable ? ["Военная служба", "В экспедиции", "Не может работать"][(index - (count - unavailable)) % 3] : "";
      result.push({ id: `resident-${index + 1}`, name: `${names[(index - 5) % names.length]} ${surnames[Math.floor((index - 5) / names.length)]}`, role, skills, capacity: reason ? 0 : 20, reason });
    }
    return result;
  }
  const total = (id, list = assignments) => sum(list.filter(a => a.task === id));
  const used = (id, list = assignments) => sum(list.filter(a => a.worker === id));
  const free = (id, list = assignments) => workerById(id).capacity - used(id, list);
  const target = task => task.kind === "optional" ? goals[task.id] ?? null : task.need;
  const deficit = (task, list = assignments) => target(task) == null ? 0 : Math.max(0, target(task) - total(task.id, list));
  // A player target is NOT a production ceiling. Surplus only exists for finite stages.
  const surplus = (task, list = assignments) => task.type === "stage" ? Math.max(0, total(task.id, list) - task.need) : 0;
  const crew = (task, list = assignments) => list.filter(a => a.task === task.id && a.qd >= 10).length;
  const slotsUsed = (task, list = assignments) => list.filter(a => a.task === task.id).length;
  const capable = (worker, task) => worker.capacity > 0 && (!task.qualified || worker.skills.includes(task.id));
  const open = task => !["waiting", "blocked"].includes(task.type);
  const capacityLeft = (task, worker, list = assignments) => !task.slots || list.some(a => a.task === task.id && a.worker === worker.id) || slotsUsed(task, list) < task.slots;
  const attention = task => deficit(task) > 0 || surplus(task) > 0 || (task.type === "daily" && crew(task) < 1) || (task.type === "service" && crew(task) < 2);
  function workerIdle(id) {
    return tasks.reduce((result, task) => {
      let extra = surplus(task);
      for (const row of assignments.filter(a => a.task === task.id).toReversed()) { const amount = Math.min(row.qd, extra); if (row.worker === id) result += amount; extra -= amount; }
      return result;
    }, 0);
  }
  const jobText = id => assignments.filter(a => a.worker === id).map(a => `${taskById(a.task).title} ${a.qd}`).join(" · ") || "Нет назначений";
  const category = task => task.kind === "required" ? "Обязательный уход" : target(task) != null ? "Выбранная задача" : "По желанию";
  function status(task) {
    if (task.type === "waiting") return ["tone-info", "Ожидание", "Труд не требуется"];
    if (task.type === "blocked") return ["tone-muted", "Недоступна", "Нет сырья · плана нет"];
    if (deficit(task)) return ["tone-warning", `${task.kind === "required" ? "Не хватает" : "До цели"} ${deficit(task)} QD`, task.type === "service" ? `Состав ${crew(task)} / 2` : category(task)];
    if ((task.type === "service" && crew(task) < 2) || (task.type === "daily" && crew(task) < 1)) return ["tone-warning", "Не хватает состава", task.type === "daily" ? "Смотритель каждый день" : "Нужны двое по 10 QD"];
    if (surplus(task)) return ["tone-warning", `Простой до ${surplus(task)} QD`, "После завершения этапа"];
    if (target(task) == null) return ["tone-muted", total(task.id) ? "Добыча по назначению" : "Можно не работать", `${slotsUsed(task)} / ${task.slots} мест занято`];
    return ["tone-success", task.kind === "required" ? "Уход обеспечен" : "Цель закрыта", `${total(task.id)} QD назначено`];
  }
  const icon = task => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${symbols[task.id]}"></path></svg>`;
  const lock = locked => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="${locked ? "M8 10V6a4 4 0 0 1 8 0v4" : "M8 10V6a4 4 0 0 1 8 0"}"></path></svg>`;
  const progress = (amount, capacity, extra = 0) => `<span class="progress-track" aria-hidden="true"><span class="work-fill" style="width:${capacity ? Math.min(100, Math.max(0, amount - extra) / capacity * 100) : 0}%"></span><span class="idle-fill" style="width:${capacity ? Math.min(100, extra / capacity * 100) : 0}%"></span></span>`;
  function announce(message) { clearTimeout(toastTimer); $("#toast").textContent = message; $("#toast").hidden = false; toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 3800); }
  function mutate(callback, message) { undo = state(); callback(); render(); if (message) announce(message); }
  function add(list, task, worker, qd) { const existing = list.find(a => a.task === task && a.worker === worker); if (existing) existing.qd += qd; else list.push({ task, worker, qd, locked: false }); }
  function renderMetrics() {
    const assigned = sum(assignments), capacity = workers.reduce((n, w) => n + w.capacity, 0);
    const cards = [
      ["Свободно", capacity - assigned, "QD", "tone-success", `Доступно ${workers.filter(w => w.capacity).length} из ${population} жителей; только обычные QD`],
      ["Не хватает на уход", tasks.filter(t => t.kind === "required").reduce((n, t) => n + deficit(t), 0), "QD", "", "Обязательные потребности уже содержащегося скота"],
      ["До выбранных целей", tasks.filter(t => t.kind !== "required").reduce((n, t) => n + deficit(t), 0), "QD", "tone-warning", "Только выбранные задачи и ваши планы; свободные места сюда не входят"],
      ["Простой в назначениях", tasks.reduce((n, t) => n + surplus(t), 0), "QD", "tone-warning", "Лишний труд после конечного этапа; свободные производственные места не считаются простоем"],
      ["Оплата по плану", assigned * 2, "ММ", "", "Условная ставка примера: 2 ММ за назначенный QD"]
    ];
    $("#metrics").innerHTML = cards.map(([label, n, unit, tone, title]) => `<div class="metric" title="${title}"><span class="metric-label">${label}</span><div class="metric-value ${n ? tone : "tone-muted"}">${n}<small>${unit}</small></div></div>`).join("");
    $("#worker-count").textContent = population;
  }
  const matches = (text, search) => search.toLocaleLowerCase("ru").trim().split(/\s+/).every(part => text.toLocaleLowerCase("ru").split(/[^\p{L}\p{N}]+/u).some(word => word.startsWith(part)));
  const match = text => matches(text, query);
  function filteredWorkers() {
    const filter = filters.workers;
    const result = workers.filter(w => match(`${w.name} ${w.role} ${w.reason} ${jobText(w.id)}`)).filter(w => filter === "all" || (filter === "free" ? free(w.id) > 0 : filter === "idle" ? workerIdle(w.id) > 0 : w.capacity === 0));
    if (sort === "name") result.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    if (sort === "free") result.sort((a, b) => free(b.id) - free(a.id) || a.name.localeCompare(b.name, "ru"));
    return result;
  }
  function filteredTasks() {
    const filter = filters.tasks;
    const result = tasks.filter(t => match(`${t.title} ${t.job} ${assignments.filter(a => a.task === t.id).map(a => workerById(a.worker).name).join(" ")}`)).filter(t => filter === "all" || (filter === "attention" ? attention(t) : filter === "required" ? t.kind === "required" : t.kind === "optional"));
    if (sort === "name") result.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    return result;
  }
  function taskRow(task) {
    const list = assignments.filter(a => a.task === task.id), [tone, label, detail] = status(task), needed = target(task);
    const names = list.slice(0, 2).map(a => `${workerById(a.worker).name} ${a.qd}`).join(" · ") + (list.length > 2 ? ` · ещё ${list.length - 2}` : "");
    return `<button type="button" class="task-row" data-task="${task.id}" aria-pressed="${selectedTask === task.id}"><span class="task-label"><span class="task-symbol">${icon(task)}</span><span><strong>${task.title}</strong><span class="task-subtitle">${task.slots ? `Мест: ${slotsUsed(task)} / ${task.slots} · по желанию` : task.job}</span></span></span><span><span class="assignment-text ellipsis" title="${names}">${names || "Никто не назначен"}</span>${needed != null ? progress(total(task.id), Math.max(needed, total(task.id)), surplus(task)) : `<span class="task-subtitle">${total(task.id)} QD${task.slots ? " · плана нет" : ""}</span>`}</span><span><span class="status-label ${tone}">${label}</span><span class="status-detail">${detail}</span></span></button>`;
  }
  function workerRow(worker) {
    const idle = workerIdle(worker.id);
    return `<div class="worker-row ${worker.capacity ? "" : "unavailable"}"><label class="worker-select"><input type="checkbox" data-select="${worker.id}" aria-label="Выбрать: ${worker.name}" ${selected.has(worker.id) ? "checked" : ""} ${worker.capacity ? "" : "disabled"}></label><button type="button" class="task-row" data-worker="${worker.id}" aria-pressed="${selectedWorker === worker.id}"><span><strong>${worker.name}</strong><span class="task-subtitle ellipsis">${worker.role}</span></span><span><span class="assignment-text ellipsis" title="${jobText(worker.id)}">${worker.capacity ? jobText(worker.id) : worker.reason}</span>${worker.capacity ? progress(used(worker.id), worker.capacity, idle) : ""}</span><span><span class="status-label ${worker.capacity ? "tone-success" : "tone-muted"}">${worker.capacity ? `${free(worker.id)} / ${worker.capacity} QD свободно` : "Недоступен"}</span><span class="status-detail">${idle ? `Простой до ${idle} QD` : worker.capacity ? `Назначено ${used(worker.id)} QD` : worker.reason}</span></span></button></div>`;
  }
  function renderFilters() {
    const options = view === "tasks" ? [["all", "Все"], ["attention", "Внимание", tasks.filter(attention).length], ["required", "Обязательное"], ["optional", "По желанию"]] : [["all", "Все"], ["free", "Есть время"], ["idle", "Простой"], ["unavailable", "Недоступны"]];
    $("#filters").innerHTML = options.map(([id, label, count]) => `<button type="button" data-filter="${id}" aria-pressed="${filters[view] === id}">${label}${count == null ? "" : `<small>${count}</small>`}</button>`).join("");
    $("#sort option[value='free']").disabled = view === "tasks";
  }
  function renderRows() {
    const scroll = $("#rows").scrollTop;
    const items = view === "tasks" ? filteredTasks() : filteredWorkers(), size = 25;
    const pages = Math.max(1, Math.ceil(items.length / size)); page = Math.max(0, Math.min(page, pages - 1));
    $("#list-head").classList.toggle("workers-head", view === "workers");
    $("#list-head").innerHTML = view === "tasks" ? "<span>Работа / возможность</span><span>Назначения · QD</span><span>Состояние</span>" : "<span>Житель</span><span>Где работает</span><span>Остаток времени</span>";
    $("#rows").innerHTML = items.slice(page * size, (page + 1) * size).map(view === "tasks" ? taskRow : workerRow).join("") || '<div class="empty-state">Ничего не найдено. Измените поиск или фильтр.</div>';
    $("#rows").scrollTop = scroll;
    $("#pagination").innerHTML = `<span>${items.length ? page * size + 1 : 0}–${Math.min((page + 1) * size, items.length)} из ${items.length}${view === "workers" ? " · по 25" : " работ"}</span><button type="button" data-page="-1" aria-label="Предыдущая страница" ${page === 0 ? "disabled" : ""}>←</button><span>${page + 1} / ${pages}</span><button type="button" data-page="1" aria-label="Следующая страница" ${page === pages - 1 ? "disabled" : ""}>→</button>`;
    $("#bulk-bar").hidden = view !== "workers";
    $("#board-note").textContent = view === "tasks" ? "Места ≠ обязанность. Помощник закрывает уход и выбранные цели; добычу без цели не заполняет." : `Выбор группы сохраняется между страницами и фильтрами. ${workers.filter(w => !w.capacity).length} жителей недоступны для обычной работы.`;
    updateSelection();
  }
  function updateSelection() {
    const eligible = filteredWorkers().filter(w => w.capacity);
    $("#selected-count").textContent = `Выбрано ${selected.size} · на всех страницах`;
    $("[data-action='bulk']").disabled = !selected.size;
    $("#select-matches").checked = eligible.length > 0 && eligible.every(w => selected.has(w.id));
    $("#select-matches").indeterminate = eligible.some(w => selected.has(w.id)) && !$("#select-matches").checked;
    $("#select-matches").disabled = !eligible.length;
  }
  function assignmentControls(task, worker, label) {
    const row = assignments.find(a => a.task === task && a.worker === worker);
    return `<div class="assigned-person"><span>${label} <strong>${row.qd} QD</strong></span><button type="button" class="mini-button" data-lock="${task}:${worker}" aria-pressed="${row.locked}" aria-label="${row.locked ? "Открепить" : "Закрепить"}: ${label}" title="Защитить от помощника">${lock(row.locked)}</button><button type="button" class="mini-button" data-remove="${task}:${worker}" aria-label="Снять назначение: ${label}" ${row.locked ? "disabled" : ""}>×</button></div>`;
  }
  function candidateList(task) {
    return workers.filter(w => capable(w, task) && capacityLeft(task, w) && (!onlyFree || free(w.id) > 0) && matches(`${w.name} ${w.role}`, candidateQuery)).sort((a, b) => Number(assignments.some(x => x.worker === b.id && x.task === task.id)) - Number(assignments.some(x => x.worker === a.id && x.task === task.id)) || Number(b.skills.includes(task.id)) - Number(a.skills.includes(task.id)) || free(b.id) - free(a.id));
  }
  function renderCandidates() {
    const task = taskById(selectedTask), list = candidateList(task), pages = Math.max(1, Math.ceil(list.length / 8));
    candidatePage = Math.max(0, Math.min(candidatePage, pages - 1));
    if (!list.some(w => w.id === candidate)) candidate = list[0]?.id ?? null;
    $("#candidate-list").innerHTML = list.slice(candidatePage * 8, (candidatePage + 1) * 8).map(w => `<button type="button" class="candidate" data-candidate="${w.id}" aria-pressed="${candidate === w.id}" ${free(w.id) ? "" : "disabled"}><span class="candidate-info"><strong>${w.name}</strong><small>${w.skills.includes(task.id) ? "Есть опыт" : "Общая работа"} · назначено ${used(w.id)} QD</small></span><span class="candidate-free">${free(w.id)} QD</span></button>`).join("") || '<div class="empty-state">Подходящих кандидатов нет. Проверьте поиск, свободное время и места.</div>';
    $("#candidate-pagination").innerHTML = `<button type="button" data-candidate-page="-1" aria-label="Предыдущие кандидаты" ${candidatePage === 0 ? "disabled" : ""}>←</button><span>${list.length} подходящих · ${candidatePage + 1} / ${pages}</span><button type="button" data-candidate-page="1" aria-label="Следующие кандидаты" ${candidatePage === pages - 1 ? "disabled" : ""}>→</button>`;
    renderAllocation();
  }
  function renderDetails() {
    const back = '<button type="button" class="back-button quiet-button" data-action="back">← К списку</button>';
    if (view === "workers") {
      const w = workerById(selectedWorker), list = assignments.filter(a => a.worker === w.id);
      $("#details").innerHTML = `${back}<div class="detail-scroll"><div class="detail-kicker">Житель</div><h2 tabindex="-1">${w.name}</h2><p class="details-description">${w.role}</p><div class="task-need"><strong>${w.capacity ? `Свободно ${free(w.id)} из ${w.capacity} QD` : w.reason}</strong><p>${w.capacity ? `Назначено ${used(w.id)} QD · простой до ${workerIdle(w.id)} QD` : "Недоступен для общего распределения"}</p>${w.capacity ? progress(used(w.id), w.capacity, workerIdle(w.id)) : ""}</div>${list.length ? `<h3>Текущие назначения</h3>${list.map(a => assignmentControls(a.task, w.id, taskById(a.task).title)).join("")}` : ""}${w.capacity ? `<div class="section-label">Выбрать работу</div>${tasks.filter(t => open(t) && capable(w, t)).map(t => `<button type="button" class="worker-task-link" data-worker-task="${t.id}"><strong>${t.title}</strong><small>${status(t)[1]} →</small></button>`).join("")}` : ""}</div>`;
      return;
    }
    const task = taskById(selectedTask), list = assignments.filter(a => a.task === task.id), [tone, label, detail] = status(task);
    $("#details").innerHTML = `${back}<div class="detail-scroll"><div class="detail-kicker">${category(task)}</div><h2 tabindex="-1">${task.title}</h2><div class="task-need"><strong class="${tone}">${label}</strong><p>${detail}${task.slots ? ` · ${task.slots - slotsUsed(task)} свободных мест` : ""}</p></div>${task.slots ? `<details class="detail-fold" data-fold="goal"><summary>Ваш план труда: ${target(task) == null ? "без плана" : `${target(task)} QD`}</summary><div class="goal-controls"><label for="goal-qd">Ваш план труда, QD · необязательно</label><input id="goal-qd" type="number" min="1" max="${task.slots * 20}" step="1" value="${target(task) ?? ""}" placeholder="Без плана"><button type="button" data-action="goal">Задать</button><button type="button" data-action="clear-goal" class="text-button" ${target(task) == null ? "disabled" : ""}>Убрать</button></div></details>` : ""}${open(task) ? '<div class="section-label"><span>Кого назначить</span><span>Свободные QD</span></div><div class="candidate-search"><input id="candidate-search" type="search" placeholder="Имя или профессия" aria-label="Поиск кандидата"><label><input id="candidate-free" type="checkbox"> Свободны</label></div><div id="candidate-list" class="candidate-list"></div><div id="candidate-pagination" class="candidate-pagination"></div>' : ""}${list.length ? `<details class="detail-fold" data-fold="assigned"><summary>Назначены: ${list.length} · ${total(task.id)} QD</summary>${list.map(a => assignmentControls(task.id, a.worker, workerById(a.worker).name)).join("")}</details>` : ""}<details class="detail-fold" data-fold="conditions"><summary>Условия работы</summary><p class="details-description">${task.description}</p></details></div>${open(task) ? '<div id="allocation" class="allocation"></div>' : ""}`;
    if (open(task)) { $("#candidate-search").value = candidateQuery; $("#candidate-free").checked = onlyFree; renderCandidates(); }
  }
  function renderAllocation() {
    const w = workerById(candidate), task = taskById(selectedTask);
    if (!w) { $("#allocation").innerHTML = '<p class="candidate-current">Выберите подходящего жителя для назначения.</p>'; return; }
    const max = free(w.id), amount = Math.min(max, target(task) == null ? 4 : deficit(task));
    $("#allocation").innerHTML = `<p class="candidate-current ellipsis" title="${jobText(w.id)}">${w.name}: ${jobText(w.id)}.</p><div class="allocate-controls"><label for="amount">Добавить QD</label><div class="stepper"><button type="button" data-step="-1" aria-label="На один QD меньше">−</button><input id="amount" type="number" min="0" max="${max}" step="1" value="${amount}" aria-describedby="allocation-preview"><button type="button" data-step="1" aria-label="На один QD больше">+</button></div></div><div class="quick-amounts">${target(task) != null ? '<button type="button" data-amount="need">До цели</button>' : ""}<button type="button" data-amount="free">Все свободные QD</button></div><button type="button" class="primary-button" data-action="assign" id="assign-button"></button><p id="allocation-preview" class="allocation-preview"></p>`;
    updateAmount();
  }
  function amountValue() { const n = Number($("#amount")?.value); return candidate && Number.isInteger(n) && n > 0 && n <= free(candidate) ? n : 0; }
  function updateAmount() {
    const amount = amountValue(), task = taskById(selectedTask), w = workerById(candidate);
    if (!w || !$("#assign-button")) return;
    $("#assign-button").disabled = !amount || !capacityLeft(task, w);
    $("#assign-button").textContent = `Выделить ${amount} QD · ${w.name}`;
    const extra = task.type === "stage" ? Math.max(0, total(task.id) + amount - task.need) : 0;
    $("#allocation-preview").textContent = amount ? `Останется ${free(w.id) - amount} QD · +${amount * 2} ММ${extra ? ` · простой до ${extra} QD` : ""}` : `Укажите целое число от 1 до ${free(w.id)} QD.`;
  }
  function render() {
    const focused = document.activeElement, id = focused?.id, data = focused?.dataset || {};
    const selector = data.lock ? `[data-lock="${data.lock}"]` : data.candidate ? `[data-candidate="${data.candidate}"]` : id ? `#${id}` : null;
    const selectionKey = `${view}:${view === "tasks" ? selectedTask : selectedWorker}`;
    const sameSelection = $("#details").dataset.selection === selectionKey;
    const openFolds = sameSelection ? Array.from(document.querySelectorAll("[data-fold][open]"), el => el.dataset.fold) : [];
    const scroll = sameSelection ? $(".detail-scroll")?.scrollTop ?? 0 : 0;
    renderMetrics(); renderFilters(); renderRows(); renderDetails();
    $("#details").dataset.selection = selectionKey;
    for (const fold of openFolds) { const el = $(`[data-fold="${fold}"]`); if (el) el.open = true; }
    document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
    const dirty = JSON.stringify(state()) !== JSON.stringify(saved), delta = sum(assignments) - sum(saved.assignments);
    $("#draft-status").textContent = dirty ? "Черновик изменён" : savedOnce ? "Сохранено в макете" : "Исходный пример";
    $("#draft-summary").textContent = dirty ? `К сохранённому: ${delta > 0 ? "+" : ""}${delta} QD · ${delta > 0 ? "+" : ""}${delta * 2} ММ` : "Назначения повторяются. Сохранение — только в этой вкладке.";
    $("[data-action='undo']").disabled = !undo;
    if ($(".detail-scroll")) $(".detail-scroll").scrollTop = scroll;
    if (selector) $(selector)?.focus({ preventScroll: true });
  }
  function dialog(title, body, label, callback) {
    $("#dialog-title").textContent = title; $("#dialog-body").innerHTML = body;
    $("#dialog-actions").innerHTML = `<button type="button" id="dialog-cancel" class="quiet-button">${callback ? "Отмена" : "Понятно"}</button>${callback ? `<button type="button" id="dialog-confirm" class="primary-button">${label}</button>` : ""}`;
    $("#dialog-cancel").onclick = () => $("#review-dialog").close();
    if (callback) $("#dialog-confirm").onclick = () => { const result = callback(); if (result !== false) $("#review-dialog").close(); };
    if (!$("#review-dialog").open) $("#review-dialog").showModal();
  }
  function showChanges(title, intro, changes, next, skipped = []) {
    dialog(title, `<p class="dialog-intro">${intro}</p>${changes.map(c => `<div class="review-item"><strong>${c.worker.name} → ${c.task.title} · ${c.amount > 0 ? "+" : ""}${c.amount} QD</strong><small>${c.reason}</small></div>`).join("")}${skipped.length ? `<details class="review-item"><summary>Пропущено: ${skipped.length} · причины</summary>${skipped.map(s => `<div>${s}</div>`).join("")}</details>` : ""}<p class="review-summary">${changes.length ? `Изменений: ${changes.length}; труд ${changes.reduce((n, c) => n + c.amount, 0)} QD. Проверьте список перед применением.` : "Изменений нет."}</p>`, "Применить к черновику", changes.length ? () => mutate(() => { assignments = next.filter(a => a.qd > 0); }, "Изменения добавлены в черновик.") : null);
  }
  function suggest() {
    const next = clone(assignments), changes = [];
    for (const task of tasks.filter(t => open(t) && target(t) != null)) {
      const candidates = workers.filter(w => capable(w, task)).sort((a, b) => Number(b.skills.includes(task.id)) - Number(a.skills.includes(task.id)) || free(b.id, next) - free(a.id, next));
      for (const w of candidates) {
        const missing = deficit(task, next); if (!missing) break;
        const current = next.find(a => a.task === task.id && a.worker === w.id);
        if (current?.locked || !capacityLeft(task, w, next)) continue;
        const amount = ["daily", "service"].includes(task.type) ? Math.max(0, 10 - (current?.qd || 0)) : Math.min(missing, free(w.id, next));
        if (!amount || amount > missing || amount > free(w.id, next)) continue;
        add(next, task.id, w.id, amount); changes.push({ task, worker: w, amount, reason: `${task.kind === "required" ? "Обязательный уход" : "Выбранная цель"}; подходящий работник со свободным временем.` });
      }
    }
    showChanges("Предложение по выбранным задачам", "Закрываем уход и выбранные цели. Добычу без цели, свободные места и всё оставшееся время заполнять не нужно. Закреплённые строки сохраняются.", changes, next);
  }
  function trim() {
    const next = clone(assignments), changes = [];
    for (const task of tasks) {
      let extra = surplus(task, next);
      for (const row of next.filter(a => a.task === task.id && !a.locked).toReversed()) {
        const amount = Math.min(extra, row.qd); if (!amount) continue;
        row.qd -= amount; extra -= amount;
        changes.push({ task, worker: workerById(row.worker), amount: -amount, reason: "После конечного этапа этот труд не используется; оставшегося достаточно." });
      }
    }
    showChanges("Пересмотреть простой", "Снимаем только лишний труд конечных этапов. Свободные места лесоповала и каменоломни — не простой; их текущие назначения сохраняются.", changes, next);
  }
  function bulk() {
    dialog("Назначить выбранных жителей", `<p class="dialog-intro">Выбрано ${selected.size} жителей со всех страниц, включая скрытых текущим фильтром. Сначала покажем результат. Свободное время, квалификация, места и закрепления учитываются для каждого.</p><div class="bulk-fields"><label for="bulk-task">Работа<select id="bulk-task">${tasks.filter(open).map(t => `<option value="${t.id}" ${t.id === "quarry" ? "selected" : ""}>${t.title} · ${category(t)}</option>`).join("")}</select></label><label for="bulk-amount">Добавить каждому, QD<input id="bulk-amount" type="number" min="1" max="20" step="1" value="4"></label></div><p id="bulk-error" class="review-summary" role="status"></p>`, "Посмотреть результат", () => {
      const amount = Number($("#bulk-amount").value), task = taskById($("#bulk-task").value);
      if (!Number.isInteger(amount) || amount < 1 || amount > 20) { $("#bulk-error").textContent = "Введите целое число от 1 до 20."; return false; }
      const next = clone(assignments), changes = [], skipped = [];
      for (const w of workers.filter(w => selected.has(w.id))) {
        const row = next.find(a => a.worker === w.id && a.task === task.id);
        const reason = !capable(w, task) ? "недоступен или нет квалификации" : row?.locked ? "назначение закреплено" : !capacityLeft(task, w, next) ? "все места заняты" : free(w.id, next) < amount ? `свободно только ${free(w.id, next)} QD` : "";
        if (reason) { skipped.push(`${w.name}: ${reason}`); continue; }
        add(next, task.id, w.id, amount);
        changes.push({ task, worker: w, amount, reason: `Прямой выбор игрока; останется ${free(w.id, next)} QD.` });
      }
      showChanges("Проверка группового назначения", `Работа: ${task.title}. Добавляем по ${amount} QD; неполные назначения не подставляются молча. ${task.type === "stage" ? "Для конечного этапа проверьте возможный простой после назначения." : "Ваш выбор не создаёт обязательство заполнять остальные места."}`, changes, next, skipped);
      return false;
    });
  }
  function check(saving) {
    const warnings = tasks.filter(attention);
    dialog(saving ? "Сохранить пример плана" : "Проверка плана", `<p class="dialog-intro">Личные лимиты и места в примере соблюдены. Пустая каменоломня и незанятые места лесоповала не являются замечаниями.</p>${warnings.map(t => `<div class="review-item"><strong>${t.title}: ${status(t)[1]}</strong><small>${status(t)[2]}</small></div>`).join("") || '<p class="review-summary">Замечаний к выбранным задачам нет.</p>'}<p class="dialog-intro">Это условный пример: точный календарь, выпуск продукции и данные мира не подключены.</p>`, "Сохранить пример", saving ? () => { saved = state(); savedOnce = true; render(); announce("Сохранено только в макете до перезагрузки."); } : null);
  }
  function reset(count = population) {
    population = count; workers = makeWorkers(count); assignments = clone(initial); goals = { wood: null, quarry: null }; saved = state(); undo = null; savedOnce = false;
    view = "tasks"; filters = { tasks: "all", workers: "all" }; query = ""; sort = "default"; page = 0; selected = new Set(); selectedTask = "wood"; selectedWorker = "ivan"; candidate = "ivan"; candidateQuery = ""; candidatePage = 0; onlyFree = true;
    $("#search").value = ""; $("#sort").value = "default"; $("#population").value = count; $(".planner").classList.remove("panel-open"); render();
    $("#rows").scrollTop = 0; if ($(".detail-scroll")) $(".detail-scroll").scrollTop = 0;
  }
  function chooseTask(id, worker = candidate) { selectedTask = id; candidate = worker; candidateQuery = ""; candidatePage = 0; view = "tasks"; render(); revealDetails(); }
  function revealDetails() { $(".planner").classList.add("panel-open"); $(".detail-scroll").scrollTop = 0; $("#details h2")?.focus({ preventScroll: true }); }
  document.addEventListener("click", event => {
    const button = event.target.closest("button"); if (!button || button.disabled) return; const d = button.dataset;
    if (d.view) { view = d.view; page = 0; if (view === "tasks" && sort === "free") { sort = "default"; $("#sort").value = sort; } $(".planner").classList.remove("panel-open"); render(); $("#rows").scrollTop = 0; }
    if (d.filter) { filters[view] = d.filter; page = 0; renderFilters(); renderRows(); $("#rows").scrollTop = 0; $(`[data-filter="${d.filter}"]`)?.focus(); }
    if (d.page) { page += Number(d.page); renderRows(); $("#rows").scrollTop = 0; $("#rows").focus(); }
    if (d.task) chooseTask(d.task);
    if (d.worker) { selectedWorker = d.worker; render(); revealDetails(); }
    if (d.workerTask) chooseTask(d.workerTask, selectedWorker);
    if (d.candidate) { candidate = d.candidate; renderCandidates(); $(`[data-candidate="${candidate}"]`)?.focus({ preventScroll: true }); }
    if (d.candidatePage) { candidatePage += Number(d.candidatePage); renderCandidates(); $("#candidate-list button")?.focus({ preventScroll: true }); }
    if (d.step || d.amount) { const input = $("#amount"), max = free(candidate); input.value = d.amount ? Math.min(max, d.amount === "need" ? deficit(taskById(selectedTask)) : max) : Math.max(0, Math.min(max, (Number(input.value) || 0) + Number(d.step))); updateAmount(); }
    if (d.lock) { const [task, worker] = d.lock.split(":"); mutate(() => { const row = assignments.find(a => a.task === task && a.worker === worker); row.locked = !row.locked; }); }
    if (d.remove) { const [task, worker] = d.remove.split(":"); mutate(() => { assignments = assignments.filter(a => a.task !== task || a.worker !== worker); }, "Назначение снято; QD свободны."); $("#details h2")?.focus({ preventScroll: true }); }
    if (d.action === "assign" && amountValue()) { const amount = amountValue(); mutate(() => add(assignments, selectedTask, candidate, amount), `Добавлено ${amount} QD.`); $("#amount")?.focus({ preventScroll: true }); }
    if (d.action === "goal") { const n = Number($("#goal-qd").value), task = taskById(selectedTask); if (Number.isInteger(n) && n > 0 && n <= task.slots * 20) mutate(() => { goals[task.id] = n; }, "Добавлена ваша цель; назначения не менялись."); else announce(`Укажите целый план от 1 до ${task.slots * 20} QD или оставьте работу без плана.`); }
    if (d.action === "clear-goal") mutate(() => { goals[selectedTask] = null; }, "Цель убрана. Текущие назначения сохранены.");
    if (d.action === "back") { $(".planner").classList.remove("panel-open"); $(view === "tasks" ? `[data-task="${selectedTask}"]` : `[data-worker="${selectedWorker}"]`)?.focus({ preventScroll: true }); }
    if (d.action === "clear-selection") { selected.clear(); renderRows(); }
    if (d.action === "bulk") bulk();
    if (d.action === "suggest") suggest();
    if (d.action === "trim") trim();
    if (d.action === "check") check(false);
    if (d.action === "save") check(true);
    if (d.action === "undo" && undo) { restore(undo); undo = null; render(); announce("Последний шаг отменён."); }
    if (d.action === "reset") dialog("Сбросить пример?", '<p class="dialog-intro">Вернутся исходные назначения и цели для текущей численности. Изменения в макете будут потеряны.</p>', "Сбросить", () => reset());
    if (d.action === "help") dialog("Как устроен план", '<ol class="help-list"><li><strong>Обязательное:</strong> уход за имеющимися животными. <strong>Выбранное:</strong> посев, начатая партия, открытый трактир. <strong>По желанию:</strong> добыча с доступными местами.</li><li>Лесоповал и каменоломня имеют по 12 мест. Можно не работать, назначить несколько жителей или задать свою цель QD. Цель не ограничивает выпуск; превышение цели не считается простоем.</li><li>Для большого поселения: поиск, фильтры, сортировка, по 25 жителей на странице. Выберите группу на нескольких страницах и проверьте список перед назначением.</li><li>Кандидаты имеют отдельный поиск и страницы по 8 человек. Кнопка выдачи QD закреплена внизу панели.</li><li>Выбор численности сверху загружает другой пример со сбросом черновика. 10% жителей недоступны; их QD не входят в общий бюджет.</li></ol><p class="dialog-intro">Квалификации, ставки и численные цели условны. Для макета место занимает назначенный человек; точное расписание и совместимость работ по дням здесь не рассчитываются. Выходные, смены и незавершённая работа отложены.</p>', "Понятно");
  });
  document.addEventListener("input", event => {
    const el = event.target;
    if (el.id === "search") { query = el.value.trim(); page = 0; renderRows(); $("#rows").scrollTop = 0; }
    if (el.id === "candidate-search") { candidateQuery = el.value.trim(); candidatePage = 0; renderCandidates(); }
    if (el.id === "amount") updateAmount();
  });
  document.addEventListener("change", event => {
    const el = event.target;
    if (el.id === "sort") { sort = el.value; page = 0; renderRows(); $("#rows").scrollTop = 0; }
    if (el.id === "candidate-free") { onlyFree = el.checked; candidatePage = 0; renderCandidates(); }
    if (el.dataset.select) { if (el.checked) selected.add(el.dataset.select); else selected.delete(el.dataset.select); updateSelection(); }
    if (el.id === "select-matches") { for (const w of filteredWorkers().filter(w => w.capacity)) { if (el.checked) selected.add(w.id); else selected.delete(w.id); } renderRows(); }
    if (el.id === "population") {
      const next = Number(el.value); el.value = population;
      if (JSON.stringify(state()) === JSON.stringify(saved) && !savedOnce) reset(next);
      else dialog("Сменить размер примера?", '<p class="dialog-intro">Будет загружен исходный пример другой численности. Текущие назначения и сохранение в этой вкладке сбросятся.</p>', "Загрузить пример", () => reset(next));
    }
  });
  reset();
})();
