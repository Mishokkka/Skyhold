import {
  normalizePoliticsBalance, POLITICS_ARCHETYPES, POLITICS_BUILTIN_ROWS,
  POLITICS_CORE_FIELDS, POLITICS_EFFECT_FIELDS, POLITICS_PARAMETER_FIELDS,
  POLITICS_REQUIREMENTS, politicsBalanceNumber, resolvedPoliticsCatalog
} from "../../data/politics-balance.js";

const SLOTS = new Set(["", "supply", "order", "labor", "external"]);
const KINDS = new Set(["directive", "decree", "perk"]);
const REQUIREMENTS = new Set(POLITICS_REQUIREMENTS.map((row) => row.id));
const ARCHETYPES = new Set(POLITICS_ARCHETYPES.map((row) => row.id));

function reject(reason) { return { ok: false, reason }; }

function unchanged(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export function applyPoliticsBalanceEdit(value, action, payload = {}) {
  const next = normalizePoliticsBalance(value);
  if (next.version > 1) return reject("Баланс Политики сохранён более новой версией модуля.");
  if (action === "core") {
    const fields = payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)
      ? payload.fields : { [String(payload.field ?? "")]: payload.value };
    const before = { ...next.core };
    for (const [id, value] of Object.entries(fields)) {
      const field = POLITICS_CORE_FIELDS.find((row) => row.id === id);
      if (!field) return reject("Неизвестный параметр Политики.");
      const number = politicsBalanceNumber(value, field);
      if (number === null) return reject(`Некорректное значение: ${field.label}.`);
      if (number === field.base) delete next.core[field.id];
      else next.core[field.id] = number;
    }
    if (unchanged(before, next.core)) return { ok: true, noop: true, balance: next };
    return { ok: true, balance: next, summary: `Обновлены общие параметры Политики (${Object.keys(fields).length}).` };
  }
  if (action === "create") {
    const kind = String(payload.kind ?? "");
    const id = String(payload.id ?? "");
    const label = String(payload.label ?? "").trim().slice(0, 100);
    if (!KINDS.has(kind) || !new RegExp(`^custom-${kind}-[a-z0-9-]{6,60}$`).test(id)) return reject("Некорректный вид нового решения.");
    if (!label) return reject("Укажите название нового решения.");
    if (next.custom.length >= 100) return reject("Для одного владения доступно не более 100 дополнительных решений.");
    if (resolvedPoliticsCatalog(next).some((row) => row.id === id)) return reject("Такое решение уже существует.");
    const archetypeId = String(payload.archetypeId ?? "");
    const slot = String(payload.slot ?? "");
    if (archetypeId && !ARCHETYPES.has(archetypeId)) return reject("Неизвестный типаж.");
    if (!SLOTS.has(slot) || (kind === "directive" && !archetypeId && !slot)) return reject("Выберите направление для общей директивы.");
    next.custom.push({ id, kind, label, summary: "", enabled: true, archetypeId, slot: kind === "directive" ? slot : "",
      requires: [], effects: {}, copper: 0, influence: 0, duration: kind === "decree" ? 1 : 0,
      foodPerResident: 0, upkeepCopper: 0, cultureMin: 0, reputationMin: 0, technologyMin: 0 });
    return { ok: true, balance: next, rowId: id, summary: `Добавлено политическое решение «${label}».` };
  }
  if (action === "reset") {
    const id = String(payload.id ?? "");
    if (!POLITICS_BUILTIN_ROWS.some((row) => row.id === id)) return reject("Сброс доступен только для штатного решения.");
    if (!Object.hasOwn(next.rows, id)) return { ok: true, noop: true, balance: next };
    delete next.rows[id];
    return { ok: true, balance: next, summary: `Восстановлены исходные значения решения ${id}.` };
  }
  if (action !== "row") return reject("Неизвестное действие редактора Политики.");

  const id = String(payload.id ?? "");
  const builtin = POLITICS_BUILTIN_ROWS.find((row) => row.id === id);
  const customIndex = next.custom.findIndex((row) => row.id === id);
  if (!builtin && customIndex < 0) return reject("Решение не найдено.");
  const source = builtin ?? next.custom[customIndex];
  const current = builtin ? (next.rows[id] ?? {}) : source;
  const edited = { ...current, effects: { ...(current.effects ?? {}) } };
  if (source.kind === "system" && Object.hasOwn(payload, "slots")) {
    if (!Array.isArray(payload.slots) || payload.slots.some((slot) => !SLOTS.has(slot) || !slot)) return reject("Неизвестный слот системы.");
    const slots = [...new Set(payload.slots)];
    if (unchanged(slots, source.slots)) delete edited.slots;
    else edited.slots = slots;
  }
  const fields = payload.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return reject("Поля решения не переданы.");
  const requires = Array.isArray(payload.requires) ? [...new Set(payload.requires.map(String))] : null;
  if (requires?.some((condition) => !REQUIREMENTS.has(condition))) return reject("Неизвестное условие решения.");
  for (const field of POLITICS_EFFECT_FIELDS) {
    if (!Object.hasOwn(fields, `effects.${field.id}`)) continue;
    const number = politicsBalanceNumber(fields[`effects.${field.id}`], field);
    if (number === null) return reject(`Некорректное значение: ${field.label}.`);
    if (builtin && number === (builtin.effects?.[field.id] ?? field.base ?? 0)) delete edited.effects[field.id];
    else edited.effects[field.id] = number;
  }
  for (const field of POLITICS_PARAMETER_FIELDS) {
    if (!Object.hasOwn(fields, field.id)) continue;
    const number = politicsBalanceNumber(fields[field.id], field);
    if (number === null) return reject(`Некорректное значение: ${field.label}.`);
    if (builtin && number === (builtin[field.id] ?? 0)) delete edited[field.id];
    else edited[field.id] = number;
  }
  const effectiveDuration = edited.duration ?? source.duration ?? 0;
  if (source.kind === "decree" && effectiveDuration < 1) return reject("Указ должен действовать хотя бы один десятник.");
  if (builtin) {
    if (requires) {
      if (unchanged(requires, builtin.requires ?? [])) delete edited.requires;
      else edited.requires = requires;
    }
    if (typeof payload.enabled === "boolean") {
      if (payload.enabled === false) edited.enabled = false;
      else delete edited.enabled;
    }
  }
  if (!builtin) {
    const label = String(payload.label ?? source.label).trim().slice(0, 100);
    const summary = String(payload.summary ?? source.summary ?? "").trim().slice(0, 500);
    const archetypeId = String(payload.archetypeId ?? "");
    const slot = String(payload.slot ?? "");
    if (!label) return reject("Укажите название решения.");
    if (archetypeId && !ARCHETYPES.has(archetypeId)) return reject("Неизвестный типаж.");
    if (!SLOTS.has(slot) || (source.kind === "directive" && !archetypeId && !slot)) return reject("Выберите направление для общей директивы.");
    Object.assign(edited, { label, summary, archetypeId, slot: source.kind === "directive" ? slot : "",
      requires: requires ?? source.requires ?? [], enabled: payload.enabled ?? (source.enabled !== false) });
  }
  if (builtin) {
    if (!Object.keys(edited.effects).length) delete edited.effects;
    const before = next.rows[id] ?? {};
    if (Object.keys(edited).length) next.rows[id] = edited;
    else delete next.rows[id];
    if (unchanged(before, next.rows[id] ?? {})) return { ok: true, noop: true, balance: next };
  } else {
    if (unchanged(source, edited)) return { ok: true, noop: true, balance: next };
    next.custom[customIndex] = edited;
  }
  return { ok: true, balance: next, summary: `Настроено решение «${source.label}».` };
}
