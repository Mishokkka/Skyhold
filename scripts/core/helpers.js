export const WORKER_TYPE_OPTIONS = [
  "Все с СИЛ", "Все с ЛОВ", "Все с РАЗ", "Все с ЭМП",
  "Разнорабочий",
  "Силач", "Ловкач", "Умелец", "Переговорщик",
  "Строитель", "Механик", "Бригадир", "Ремесленник", "Посыльный", "Управленец",
  "Мастеровой", "Агент", "Старшина", "Полевой вожак", "Мастер на все руки"
];

export function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
}

export function joinList(values) {
  return Array.from(new Set((values ?? []).map((item) => String(item).trim()).filter(Boolean))).join(", ");
}

export function rollD6() {
  return Math.floor(Math.random() * 6) + 1;
}

export function rollD6Pool(count) {
  const dice = Math.max(0, Math.floor(Number(count) || 0));
  return Array.from({ length: dice }, () => rollD6());
}

export function rollD66() {
  return rollD6() * 10 + rollD6();
}

// Один источник правды для data-field. Иначе чекбоксы легко сохраняются как строка "on".
export function fieldValue(field) {
  if (!field) return "";
  if (field.dataset?.type === "visibility") return field.checked ? "public" : "gm";
  if (field.dataset?.type === "checkbox" || field.type === "checkbox") return Boolean(field.checked);
  if (field.dataset?.type === "number" || field.type === "number") {
    const parsed = Number(field.value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return field.value;
}

export function escapeHtml(value) {
  const text = String(value ?? "");
  if (globalThis.document?.createElement) {
    const div = document.createElement("div");
    div.innerText = text;
    return div.innerHTML;
  }
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
