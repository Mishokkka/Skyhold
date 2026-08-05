import { makeId, toNumber } from "./utils.js";

export const EVENT_EFFECT_TYPE_OPTIONS = [
  { value: "resource", label: "Ресурс склада" },
  { value: "money", label: "Казна" },
  { value: "development", label: "Развитие" },
  { value: "modifier", label: "Модификатор поселения" }
];

export const EVENT_EFFECT_DEVELOPMENT_OPTIONS = [
  { value: "food", label: "Еда" },
  { value: "technology", label: "Технологии" },
  { value: "culture", label: "Культура" },
  { value: "war", label: "Война" }
];

export const EVENT_EFFECT_MODIFIER_OPTIONS = [
  ...EVENT_EFFECT_DEVELOPMENT_OPTIONS,
  { value: "defense", label: "Оборона" },
  { value: "reputation", label: "Репутация" },
  { value: "morale", label: "Мораль" }
];

const EFFECT_TYPES = new Set(EVENT_EFFECT_TYPE_OPTIONS.map((option) => option.value));
const DEVELOPMENT_KEYS = new Set(EVENT_EFFECT_DEVELOPMENT_OPTIONS.map((option) => option.value));
const MODIFIER_KEYS = new Set(EVENT_EFFECT_MODIFIER_OPTIONS.map((option) => option.value));

export function normalizeRandomEventEffect(effect = {}) {
  const type = EFFECT_TYPES.has(String(effect?.type ?? "")) ? String(effect.type) : "resource";
  const rawKey = String(effect?.key ?? "");
  const key = type === "development"
    ? (DEVELOPMENT_KEYS.has(rawKey) ? rawKey : "food")
    : type === "modifier"
      ? (MODIFIER_KEYS.has(rawKey) ? rawKey : "morale")
      : "";
  return {
    id: String(effect?.id || makeId("effect", 12)),
    type,
    key,
    resourceId: String(effect?.resourceId ?? "custom") || "custom",
    name: String(effect?.name ?? "").slice(0, 300),
    amount: Math.max(-1_000_000, Math.min(1_000_000, toNumber(effect?.amount ?? effect?.qty ?? effect?.delta, 0))),
    roomId: String(effect?.roomId ?? "outdoors") || "outdoors",
    note: String(effect?.note ?? "").slice(0, 1000)
  };
}

export function normalizeRandomEventEffects(effects = []) {
  return (Array.isArray(effects) ? effects : [])
    .filter((effect) => effect && typeof effect === "object")
    .map((effect) => normalizeRandomEventEffect(effect))
    .slice(0, 40);
}

export function randomEventEffectType(value = "") {
  return EFFECT_TYPES.has(String(value ?? "")) ? String(value) : "resource";
}
