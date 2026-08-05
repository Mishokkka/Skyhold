import { getCalendariaSnapshot } from "../../integrations/calendaria-bridge.js";
import { STRATEGIES, asNumber } from "./rules.js";
import { applyPercentModifier, applyTagModifiers } from "./modifiers.js";
import { tagLabel } from "./tag-config.js";

function pct(value) {
  return `${Math.round(asNumber(value, 0) * 100)}%`;
}

function stableHash(text = "") {
  let hash = 0;
  for (const ch of String(text ?? "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

export function normalizeWeatherText(raw = "") {
  const text = String(raw ?? "").trim();
  if (!text || /^(не указано|по маршруту|system|систем)/i.test(text)) return "";
  const cleaned = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/calendaria/ig, " ")
    .replace(/common/ig, " ")
    .replace(/^weather[._:-]?/i, " ");
  const key = cleaned.toLowerCase().replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim();
  const aliases = {
    clear: "ясно",
    sunny: "ясно",
    sun: "ясно",
    cloudy: "облачно",
    clouds: "облачно",
    "partly cloudy": "переменная облачность",
    "partly cloud": "переменная облачность",
    "partly-cloudy": "переменная облачность",
    partlycloudy: "переменная облачность",
    "common partly cloudy": "переменная облачность",
    "partly cloudy weather": "переменная облачность",
    overcast: "пасмурно",
    rain: "дождь",
    rainy: "дождь",
    drizzle: "дождь",
    fog: "туман",
    mist: "туман",
    snow: "снег",
    storm: "шторм",
    thunderstorm: "шторм",
    windy: "ветер",
    wind: "ветер",
    dust: "пыль",
    heat: "жара",
    hot: "жара"
  };
  if (aliases[key]) return aliases[key];
  if (/(partly|partial)/i.test(key) && /cloud/i.test(key)) return "переменная облачность";
  return cleaned.replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function weatherTextFromHolding(holding = {}, snapshot = getCalendariaSnapshot?.()) {
  const explicit = normalizeWeatherText(holding?.overview?.weather);
  if (explicit) return explicit;
  const weather = snapshot?.weather;
  if (typeof weather === "string") {
    const normalized = normalizeWeatherText(weather);
    if (normalized) return normalized;
  }
  if (weather && typeof weather === "object") {
    const normalized = normalizeWeatherText(weather.name ?? weather.label ?? weather.title ?? weather.text ?? weather.id ?? weather.key ?? "");
    if (normalized) return normalized;
  }
  const place = `${holding?.overview?.drift ?? ""} ${holding?.overview?.altitude ?? ""} ${holding?.overview?.region ?? ""} ${holding?.name ?? ""}`.toLowerCase();
  const key = `${snapshot?.dateKey ?? ""}|${place}`;
  const mountain = /гор|mount|хреб|скал|снег|лед|л[её]д|высот/.test(place);
  const sea = /порт|море|берег|кораб|океан|причал|залив/.test(place);
  const desert = /пустын|жар|сух|пес/.test(place);
  const swamp = /болот|туман|дряг|дрыг|топ/.test(place);
  const pools = mountain ? ["ясно и ветрено", "низкая облачность", "снег", "ледяной ветер", "буря"]
    : sea ? ["ясно", "морской ветер", "дождь", "туман", "шторм"]
    : desert ? ["ясно", "сухой ветер", "жара", "пыль", "песчаная буря"]
    : swamp ? ["пасмурно", "сырость", "туман", "дождь", "густой туман"]
    : ["ясно", "облачно", "ветер", "дождь", "туман"];
  return pools[stableHash(key) % pools.length];
}

export function weatherProfile(text = "") {
  const low = String(text ?? "").toLowerCase();
  if (/шторм|буря|ураган|метел|песчаная буря/.test(low)) return { key: "storm", label: "Шторм", tagMods: { shooters: -0.20, siege: -0.20, mobile: -0.15, skirmishers: -0.10 }, planMods: { holdFortifications: 0.05, fightingWithdrawal: -0.05 }, summary: "Плохая видимость и срыв маневра. Удержание укреплений немного надежнее, отход тяжелее." };
  if (/густой туман|туман|низкая облачность/.test(low)) return { key: "fog", label: "Туман", tagMods: { shooters: -0.25, siege: -0.15, mobile: 0.10, skirmishers: 0.10, sappers: 0.05 }, planMods: { raidWithdraw: 0.10, sabotage: 0.10, bombardment: -0.10 }, summary: "Дальняя стрельба хуже. Скрытные и быстрые действия лучше." };
  if (/дождь|сырость/.test(low)) return { key: "rain", label: "Дождь", tagMods: { shooters: -0.15, siege: -0.10, infantry: 0.05, heavy: 0.05, sappers: -0.05 }, planMods: { holdFortifications: 0.05, raidWithdraw: -0.05 }, summary: "Стрельба и механика хуже. Плотный строй держится лучше." };
  if (/переменная облачность|облач|пасмур/.test(low)) return { key: "cloudy", label: "Переменная облачность", tagMods: { shooters: 0.02, skirmishers: 0.02 }, planMods: {}, summary: "Мягкий свет и нормальная видимость. Легкий плюс огневым отрядам и егерям." };
  if (/снег|ледяной/.test(low)) return { key: "snow", label: "Снег", tagMods: { mobile: -0.15, shooters: -0.10, siege: -0.10, infantry: -0.05, heavy: -0.05, skirmishers: 0.05 }, planMods: { deepDefense: 0.05, breakthrough: -0.10 }, summary: "Движение и строй хуже. Глубокая оборона выигрывает от медленного темпа." };
  if (/пыль|песчан/.test(low)) return { key: "dust", label: "Пыль", tagMods: { shooters: -0.20, siege: -0.15, mobile: -0.10, skirmishers: 0.10, sappers: 0.05 }, planMods: { sabotage: 0.10, bombardment: -0.10 }, summary: "Видимость плохая. Диверсанты и застрельщики получают окно." };
  if (/жара|сухой/.test(low)) return { key: "heat", label: "Жара", tagMods: { heavy: -0.10, infantry: -0.05, mobile: -0.05, skirmishers: 0.05, sacred: 0.05 }, planMods: { frontalAssault: -0.05, probingAdvance: 0.05 }, summary: "Тяжелым и плотному строю хуже. Осторожная работа лучше лобового давления." };
  if (/ветер/.test(low)) return { key: "wind", label: "Ветер", tagMods: { shooters: -0.10, siege: -0.10, mobile: 0.05, skirmishers: 0.05 }, planMods: { bombardment: -0.05 }, summary: "Стрельба и осадный огонь хуже. Маневренные группы чувствуют себя лучше." };
  if (/ясно/.test(low)) return { key: "clear", label: "Ясно", tagMods: { shooters: 0.05, siege: 0.05 }, planMods: {}, summary: "Хорошая видимость помогает дальнему и осадному огню." };
  return { key: "neutral", label: text || "Обычная погода", tagMods: {}, planMods: {}, summary: "Боевых модификаторов нет." };
}

export function weatherRulesCatalog() {
  const samples = ["ясно", "переменная облачность", "ветер", "дождь", "туман", "снег", "пыль", "жара", "шторм"];
  return samples.map((sample) => {
    const profile = weatherProfile(sample);
    return {
      key: profile.key,
      label: profile.label,
      summary: profile.summary,
      tagRows: Object.entries(profile.tagMods ?? {}).map(([tag, mod]) => ({ tag, label: tagLabel(tag), percent: mod, text: `${tagLabel(tag)}: ${pct(mod)}`, tone: mod >= 0 ? "positive" : "negative" })),
      planRows: Object.entries(profile.planMods ?? {}).map(([key, mod]) => ({ key, label: STRATEGIES[key]?.label ?? key, percent: mod, text: `${STRATEGIES[key]?.label ?? key}: ${pct(mod)}`, tone: mod >= 0 ? "positive" : "negative" }))
    };
  });
}

export function weatherBattleModifier(holding = {}, { defenderStrategy = null, attackerStrategy = null, snapshot } = {}) {
  const text = weatherTextFromHolding(holding, snapshot);
  const profile = weatherProfile(text);
  const rows = Object.entries(profile.tagMods ?? {}).map(([tag, mod]) => ({ tag, label: tagLabel(tag), percent: mod, text: `${tagLabel(tag)}: ${pct(mod)}` }));
  const defenderPlan = profile.planMods?.[defenderStrategy?.key] ?? profile.planMods?.[defenderStrategy?.aliasOf] ?? 0;
  const attackerPlan = profile.planMods?.[attackerStrategy?.key] ?? profile.planMods?.[attackerStrategy?.aliasOf] ?? 0;
  const planRows = [];
  if (defenderPlan) planRows.push({ side: "defender", percent: defenderPlan, text: `план защитников: ${pct(defenderPlan)}` });
  if (attackerPlan) planRows.push({ side: "attacker", percent: attackerPlan, text: `метод нападающих: ${pct(attackerPlan)}` });
  const effectsText = [...rows.map((row) => row.text), ...planRows.map((row) => row.text)].filter(Boolean).join("; ");
  const tooltip = [`${text || profile.label}: ${profile.summary}`, effectsText].filter(Boolean).join("; ");
  return { key: profile.key, text: text || profile.label, label: tooltip, tooltip, tagMods: profile.tagMods, defenderPlan, attackerPlan, rows, planRows, catalog: weatherRulesCatalog() };
}

export function applyWeatherModifiers(sources = [], weather = {}, side = "defender", strategy = null) {
  applyTagModifiers(sources, weather.tagMods ?? {}, `Погода: ${weather.text}`);
  const planMod = side === "defender" ? asNumber(weather.defenderPlan, 0) : asNumber(weather.attackerPlan, 0);
  if (!planMod) return sources;
  for (const source of sources) {
    applyPercentModifier(source, planMod);
    source.modifiers.push(`Погода + ${strategy?.label ?? "план"}: ${pct(planMod)}`);
  }
  return sources;
}
