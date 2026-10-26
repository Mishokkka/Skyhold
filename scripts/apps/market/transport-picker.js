const PAGE_SIZE = 6;

/** Presentation only: searching and paging never change the selected agreement. */
export function marketTransportPicker({ options = [], selectedId = "", query = "", page = 0, direction = "inbound", canSelect = false } = {}) {
  const words = String(query).trim().toLocaleLowerCase("ru").split(/\s+/).filter(Boolean);
  const concrete = options.filter((row) => !row.automatic);
  const matches = concrete.filter((row) => words.every((word) => String(row.searchText ?? row.label).toLocaleLowerCase("ru").includes(word)));
  const lastPage = Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1);
  const current = Math.min(lastPage, Math.max(0, Math.floor(Number(page) || 0)));
  const first = current * PAGE_SIZE;
  const chosen = options.find((row) => row.value === selectedId);
  const automatic = options.find((row) => row.automatic);
  return {
    direction, query: String(query), page: current,
    selectedText: chosen?.label ?? (options.length || selectedId ? "Выбранный план недоступен — выберите заново" : "Нет доступных планов"),
    automatic: automatic ? { ...automatic, selected: automatic.value === selectedId, disabled: !canSelect } : null,
    rows: matches.slice(first, first + PAGE_SIZE).map((row) => ({ ...row, selected: row.value === selectedId, disabled: !canSelect })),
    totalText: `Найдено ${matches.length} из ${concrete.length}`,
    pageText: matches.length ? `${first + 1}–${Math.min(first + PAGE_SIZE, matches.length)} из ${matches.length}` : "Нет совпадений",
    emptyText: words.length ? "Подходящих вариантов нет. Измените поисковый запрос." : "Нет доступных вариантов. Проверьте маршрут и УРС.",
    hasPrevious: current > 0, hasNext: current < lastPage
  };
}
