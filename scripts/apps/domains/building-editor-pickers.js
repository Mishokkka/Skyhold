import { selectionSummary, syncSelectionSummary } from "../common/selection-summary.js";
import { MATERIAL_GROUPS } from "../../core/material-groups.js";

export function editorStringList(value = []) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[,;\n]/);
  return [...new Set(items.map(item => String(item ?? "").trim()).filter(Boolean))];
}

export function editorListPicker(path, values, options, { empty = "Не выбрано", all = false } = {}) {
  const selected = editorStringList(values);
  if (all && !selected.length) selected.push("all");
  const rows = new Map(options.map(option => [String(option.value), option]));
  for (const value of selected) if (!rows.has(value)) rows.set(value, { value, label: `${value} · нет в списке` });
  const choices = [...rows.values()].map(option => ({ ...option, selected: selected.includes(String(option.value)),
    search: `${option.label} ${option.value}`.toLowerCase().replaceAll("ё", "е") }));
  const labels = selected.map(value => rows.get(value)?.label ?? value);
  return { path, choices, all, empty, ...selectionSummary(labels, empty), disclosure: `building-list-${path.split(".").slice(4).join(".") || path}` };
}

export function projectParticipantPicker(project, holding, path) {
  const selected = editorStringList(project?.participantIds);
  const options = (holding?.people?.list ?? []).filter(person => person.id && (!person.dead || selected.includes(String(person.id))))
    .map(person => ({ value: String(person.id), label: `${person.name || person.id}${person.dead ? " · умер" : ""}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  return editorListPicker(path, selected, options, { empty: "Выбрать участников" });
}

const TAG_LABELS = Object.freeze({ all: "Все категории", "food.raw": "Сырое продовольствие", "food.prepared": "Готовая пища",
  beverage: "Напитки", "service.inn": "Ночлег и досуг", food: "Продовольствие", ore: "Руды", industrial: "Промышленность",
  technology: "Технологии", luxury: "Предметы роскоши", timber: "Древесина", leather: "Кожа", textile: "Текстиль" });
const SOURCE_OPTIONS = Object.freeze([
  { value: "population", label: "Население" }, { value: "inn-visitors", label: "Гости трактиров" }, { value: "market-flow", label: "Поток рынка" }
]);

export function tradeCategoryOptions(resources = [], buildings = [], selected = []) {
  const groups = new Map(MATERIAL_GROUPS.map(group => [group.id, group.label]));
  const tags = new Set(["all", "service.inn", ...editorStringList(selected)]);
  for (const resource of resources) {
    if (resource.isMoney) continue;
    for (const tag of [resource.categoryTag, ...editorStringList(resource.marketTags)]) if (tag) tags.add(String(tag));
  }
  for (const building of buildings) {
    const trade = building?.income?.trade;
    for (const tag of [...editorStringList(trade?.allowedTags), trade?.service?.categoryTag]) if (tag) tags.add(String(tag));
  }
  return [...tags].map(value => ({ value, label: TAG_LABELS[value] ?? groups.get(value) ?? value }))
    .sort((a, b) => a.value === "all" ? -1 : b.value === "all" ? 1 : a.label.localeCompare(b.label, "ru"));
}

export function prepareTradePickers(building, categoryOptions) {
  const trade = building?.income?.trade;
  if (!trade) return;
  const path = `${building.basePath}.income.trade`;
  trade.allowedTagsPicker = editorListPicker(`${path}.allowedTags`, trade.allowedTags ?? trade.allowedTagsText, categoryOptions, { empty: "Все категории", all: true });
  trade.sourceIdsPicker = editorListPicker(`${path}.sourceIds`, trade.sourceIds ?? trade.sourceIdsText, SOURCE_OPTIONS);
  const current = String(trade.service?.categoryTag ?? "");
  trade.serviceCategoryOptions = [{ value: "", label: "Не задана" }, ...categoryOptions.filter(option => option.value !== "all")];
  if (current && !trade.serviceCategoryOptions.some(option => option.value === current)) trade.serviceCategoryOptions.push({ value: current, label: current });
  trade.serviceCategoryOptions = trade.serviceCategoryOptions.map(option => ({ ...option, selected: option.value === current }));
}

export function buildingPickerValues(field) {
  const picker = field.closest?.("[data-building-list-picker]");
  if (!picker) return editorStringList(field.value);
  const checked = [...picker.querySelectorAll("[data-building-list-option]:checked")].map(option => option.value);
  if (picker.dataset.buildingListAll === "true") {
    if (field.value === "all" && field.checked) return ["all"];
    const specific = checked.filter(value => value !== "all");
    return specific.length ? specific : ["all"];
  }
  return editorStringList(checked);
}

/** Search and disclosure presentation only; persistence remains with the editor. */
export function bindBuildingEditorPickers(root) {
  for (const picker of root.querySelectorAll("[data-building-list-picker]")) {
    const search = picker.querySelector("[data-building-list-search]");
    const filter = () => {
      const query = search.value.toLowerCase().replaceAll("ё", "е").trim();
      let count = 0;
      for (const option of picker.querySelectorAll("[data-building-list-search-text]")) {
        option.hidden = !option.dataset.buildingListSearchText.includes(query);
        if (!option.hidden) count++;
      }
      picker.querySelector("[data-building-list-empty]").hidden = count > 0;
    };
    search.addEventListener("input", filter);
    let focusSearch = false;
    picker.querySelector("summary").addEventListener("click", () => { focusSearch = !picker.open; });
    picker.addEventListener("toggle", () => {
      if (picker.open && focusSearch) search.focus({ preventScroll: true });
      focusSearch = false;
    });
    picker.addEventListener("change", event => {
      if (!event.target.matches("[data-building-list-option]")) return;
      const values = buildingPickerValues(event.target);
      for (const option of picker.querySelectorAll("[data-building-list-option]")) option.checked = values.includes(option.value);
      const labels = [...picker.querySelectorAll("[data-building-list-option]:checked")].map(option => option.dataset.buildingListLabel);
      syncSelectionSummary(picker, labels, picker.dataset.buildingListEmptyLabel);
    });
  }
}

export class BuildingEditorPickerState {
  constructor() { this.elements = []; this.states = new Map(); }
  capture() {
    for (const picker of this.elements) this.states.set(picker.dataset.buildingListPicker, {
      query: picker.querySelector("[data-building-list-search]").value,
      scroll: picker.querySelector(".fbls-editor-list-options").scrollTop
    });
  }
  bind(root) {
    this.capture();
    this.elements = [...root.querySelectorAll("[data-building-list-picker]")];
    bindBuildingEditorPickers(root);
    for (const picker of this.elements) {
      const state = this.states.get(picker.dataset.buildingListPicker);
      if (!state) continue;
      const search = picker.querySelector("[data-building-list-search]");
      search.value = state.query;
      search.dispatchEvent(new Event("input", { bubbles: true }));
      picker.querySelector(".fbls-editor-list-options").scrollTop = state.scroll;
    }
  }
  close() { this.capture(); this.elements = []; }
}
