import {
  COUNTER_STRENGTH,
  DEFAULT_MASS_COMBAT_TAGS,
  tagLabel
} from "./tag-config.js";

export const LEGACY_TAG_FIELD_MAP = {
  fire: "shooters",
  recon: "skirmishers",
  cavalry: "mobile",
  engineering: "sappers",
  monstrous: "monsters"
};

export { COUNTER_STRENGTH };
export const ATTACK_METHODS = {
  frontalAssault: {
    label: "Лобовой штурм",
    summary: "Давить строем, тараном, массой и угрозой. Быстро двигает цель, но стоит крови.",
    hint: "+10% Пехоте/Тяжелым/Саперам, больше потерь обеих сторон.",
    tagMods: { infantry: 0.10, heavy: 0.10, sappers: 0.10 },
    inflictedImpact: 1.15,
    takenImpact: 1.15,
    objectiveBonus: 0,
    breachBonus: 0,
    buildingImpact: 1.10,
    fortAccess: false,
    tags: ["infantry", "heavy", "sappers"]
  },
  probingAdvance: {
    label: "Осторожное продвижение",
    summary: "Медленно, прикрываясь и прощупывая оборону. Снижает потери, но плохо решает цель.",
    hint: "-15% своих потерь, -1 прогресс цели при победе.",
    tagMods: { shooters: 0.05, skirmishers: 0.05 },
    inflictedImpact: 0.90,
    takenImpact: 0.85,
    objectiveBonus: -1,
    breachBonus: 0,
    buildingImpact: 0.85,
    tags: ["shooters", "skirmishers"]
  },
  raidWithdraw: {
    label: "Налет и отход",
    summary: "Ударить по слабой точке и не застрять в честном бою.",
    hint: "+15% Мобильным/Застрельщикам, меньше потерь атакующих, хуже против укрепленной цели.",
    tagMods: { mobile: 0.15, skirmishers: 0.15 },
    inflictedImpact: 0.95,
    takenImpact: 0.80,
    objectiveBonus: 0,
    objectiveCap: 2,
    breachBonus: -1,
    buildingImpact: 0.75,
    raid: true,
    tags: ["mobile", "skirmishers"]
  },
  sabotage: {
    label: "Диверсия",
    summary: "Саперы и лазутчики пытаются открыть путь, испортить механизм или поджечь ключевой объект.",
    hint: "+15% Саперам/Застрельщикам, часть укреплений теряется, провал опасен.",
    tagMods: { sappers: 0.15, skirmishers: 0.15 },
    inflictedImpact: 0.95,
    takenImpact: 1.10,
    objectiveBonus: 1,
    breachBonus: 1,
    fortDiceFactor: 0.80,
    buildingImpact: 1.05,
    raid: true,
    breach: true,
    tags: ["sappers", "skirmishers"]
  },
  bombardment: {
    label: "Обстрел / осада",
    summary: "Стрелять, жечь, ломать стены, башни и ворота. Людей задевает меньше, здания больше.",
    hint: "+20% Осадным/Стрелкам, больше урона зданиям, меньше прямых потерь.",
    tagMods: { siege: 0.20, shooters: 0.20 },
    inflictedImpact: 0.80,
    takenImpact: 0.90,
    objectiveBonus: 0,
    breachBonus: 1,
    buildingImpact: 1.50,
    breach: true,
    tags: ["siege", "shooters"]
  },
  breakthrough: {
    label: "Прорыв к цели",
    summary: "Не перемалывать оборону, а прорваться к воротам, складу, пленнику или командному месту.",
    hint: "+15% Мобильным/Тяжелым, цель двигается быстрее, защитники чаще отвечают потерями.",
    tagMods: { mobile: 0.15, heavy: 0.15 },
    inflictedImpact: 1.00,
    takenImpact: 1.10,
    objectiveBonus: 1,
    breachBonus: 0,
    buildingImpact: 0.90,
    raid: true,
    tags: ["mobile", "heavy"]
  }
};

export const DEFENSE_PLANS = {
  holdFortifications: {
    label: "Удерживать укрепления",
    summary: "Держать стены, ворота, башни и баррикады. Лучший план для полной работы гарнизонов.",
    hint: "Укрепления 100%, +10% Стрелкам/Тяжелым, больше риска для зданий.",
    tagMods: { shooters: 0.10, heavy: 0.10 },
    fortFactor: 1.00,
    takenImpact: 1.00,
    inflictedImpact: 1.00,
    buildingRisk: 1.25,
    objectiveResist: 0,
    protectCivilians: 0,
    tags: ["shooters", "heavy"]
  },
  deepDefense: {
    label: "Глубокая оборона",
    summary: "Отходить рубежами, гасить рывки, не давать врагу быстро решить задачу.",
    hint: "-15% потерь защитников, укрепления 75%, цель врага двигается хуже.",
    tagMods: { infantry: 0.05, skirmishers: 0.05 },
    fortFactor: 0.75,
    takenImpact: 0.85,
    inflictedImpact: 0.90,
    buildingRisk: 0.85,
    objectiveResist: 1,
    protectCivilians: 0.25,
    tags: ["infantry", "skirmishers"]
  },
  counterattack: {
    label: "Контратака",
    summary: "Выйти навстречу, ударить по тарану, саперам или командованию врага.",
    hint: "+15% Мобильным/Тяжелым, укрепления 50%, выше потери обеих сторон.",
    tagMods: { mobile: 0.15, heavy: 0.15 },
    fortFactor: 0.50,
    takenImpact: 1.15,
    inflictedImpact: 1.20,
    buildingRisk: 0.70,
    objectiveResist: 0,
    tags: ["mobile", "heavy"]
  },
  protectCivilians: {
    label: "Прикрыть жителей",
    summary: "Оттянуть бой от гражданских, закрыть эвакуацию, принять удар на боевые части.",
    hint: "Гражданские почти не получают потерь, но боевые отряды страдают сильнее.",
    tagMods: { infantry: 0.05, sacred: 0.05 },
    fortFactor: 0.80,
    takenImpact: 1.05,
    inflictedImpact: 0.85,
    buildingRisk: 0.90,
    objectiveResist: 0,
    protectCivilians: 0.90,
    tags: ["infantry", "sacred"]
  },
  protectObjective: {
    label: "Защитить объект",
    summary: "Все силы на конкретной цели врага: склад, ворота, пленник, причал, ядро острова.",
    hint: "+25% сопротивление цели, но остальные здания уязвимее.",
    tagMods: { infantry: 0.05, shooters: 0.05, sappers: 0.05 },
    fortFactor: 0.90,
    takenImpact: 1.00,
    inflictedImpact: 0.90,
    buildingRisk: 1.15,
    objectiveResist: 2,
    tags: ["infantry", "shooters", "sappers"]
  },
  fightingWithdrawal: {
    label: "Отступать с боем",
    summary: "Сохранять людей, уступая пространство. Не красиво, зато живые потом еще пригодятся.",
    hint: "-30% потерь защитников, укрепления 25%, цель врага двигается быстрее.",
    tagMods: { mobile: 0.10, skirmishers: 0.10 },
    fortFactor: 0.25,
    takenImpact: 0.70,
    inflictedImpact: 0.70,
    buildingRisk: 0.60,
    objectiveResist: -1,
    retreat: true,
    tags: ["mobile", "skirmishers"]
  }
};

function aliasStrategy(source, target, overrides = {}) {
  return { ...target, ...overrides, aliasOf: target.label };
}

export const STRATEGIES = {
  ...DEFENSE_PLANS,
  ...ATTACK_METHODS,
  defense: aliasStrategy("defense", DEFENSE_PLANS.holdFortifications, { label: "Оборона" }),
  allOutDefense: aliasStrategy("allOutDefense", DEFENSE_PLANS.holdFortifications, { label: "Стоять насмерть", takenImpact: 1.15, inflictedImpact: 1.05 }),
  sally: aliasStrategy("sally", DEFENSE_PLANS.counterattack, { label: "Вылазка" }),
  retreat: aliasStrategy("retreat", DEFENSE_PLANS.fightingWithdrawal, { label: "Отход/эвакуация" }),
  attack: aliasStrategy("attack", ATTACK_METHODS.frontalAssault, { label: "Атака" }),
  allOutAssault: aliasStrategy("allOutAssault", ATTACK_METHODS.frontalAssault, { label: "Решительный штурм" }),
  deliberateAssault: aliasStrategy("deliberateAssault", ATTACK_METHODS.bombardment, { label: "Методичный штурм" }),
  skirmish: aliasStrategy("skirmish", ATTACK_METHODS.probingAdvance, { label: "Перестрелка" }),
  raid: aliasStrategy("raid", ATTACK_METHODS.raidWithdraw, { label: "Рейд" }),
  rally: aliasStrategy("rally", DEFENSE_PLANS.deepDefense, { label: "Сбор и мораль" }),
  parley: { label: "Переговоры", summary: "Снизить насилие и выиграть время. Механически почти не двигает бой.", hint: "Мало потерь и мало прогресса.", tagMods: { sacred: 0.05 }, fortFactor: 0.50, takenImpact: 0.40, inflictedImpact: 0.40, objectiveResist: 1, tags: ["sacred"] }
};

export const ACCESS_MODES = {
  normal: { label: "Обычный доступ", hint: "К владению можно подойти обычным способом. Штрафа нет.", penalty: 0 },
  airborne: { label: "Летяга / только воздух", hint: "Без воздушного доступа нападающим трудно навязать бой.", penalty: -3, helps: ["mobile", "monsters", "sacred"] },
  water: { label: "Только вода/причал", hint: "Без кораблей или абордажных групп нападение хуже.", penalty: -2, helps: ["mobile", "shooters"] },
  cliff: { label: "Скалы / высота", hint: "Без разведки, саперов или мобильных сил атаке плохо.", penalty: -2, helps: ["mobile", "skirmishers", "sappers"] },
  portal: { label: "Телепорт / чудо", hint: "Обычный штурм почти невозможен без особого доступа.", penalty: -4, helps: ["sacred", "monsters"] }
};

export const DEFENSE_MODES = {
  behindWalls: { label: "Внутри укреплений", factor: 1, hint: "Стены заняты, ворота держат, укрепления работают полностью." },
  outerWorks: { label: "Передовые укрепления", factor: 0.85, hint: "Внешний двор, баррикады, ров, башни." },
  surprised: { label: "Застигнуты врасплох", factor: 0.5, hint: "Укрепления работают наполовину." },
  outside: { label: "В поле", factor: 0, hint: "Укрепления почти не дают кубов." }
};

export const SCALES = {
  raid: { label: "Налет", loss: 1, damage: 1, duration: "15-30 мин.", hint: "Быстрое столкновение. Мобильные и застрельщики сильнее.", tagMods: { mobile: 0.10, skirmishers: 0.10, sappers: 0.05 } },
  skirmish: { label: "Стычка", loss: 1, damage: 1, duration: "30-60 мин.", hint: "Локальный бой. Легкие силы полезны, осадные хуже.", tagMods: { mobile: 0.15, skirmishers: 0.15, siege: -0.15 } },
  battle: { label: "Битва", loss: 2, damage: 2, duration: "1-3 часа", hint: "Полноценный бой. Строй, тяжелые и саперы работают лучше.", tagMods: { infantry: 0.05, heavy: 0.10, sappers: 0.10, mobile: -0.10 } },
  siege: { label: "Осада", loss: 2, damage: 3, duration: "часы/дни", hint: "Давление по стенам, запасам и морали. Осадные и стрелки ценнее.", tagMods: { infantry: 0.05, shooters: 0.10, siege: 0.15, skirmishers: -0.10 } }
};

export const ROUND_LIMITS = { raid: 3, skirmish: 4, battle: 5, siege: 8 };
export const OBJECTIVE_THRESHOLDS = { raid: 3, skirmish: 4, battle: 6, siege: 8 };

export const ROUND_THREATS = {
  assault: { label: "Штурм", icon: "fa-solid fa-shield-halved", tags: ["infantry", "heavy", "sappers"], hint: "Враг пытается продавить строй, ворота или пролом." },
  fire: { label: "Обстрел", icon: "fa-solid fa-bullseye", tags: ["shooters", "siege"], hint: "Стрелки, пушки, арбалеты или огневые смеси выбивают защитников." },
  arson: { label: "Поджог", icon: "fa-solid fa-fire", tags: ["skirmishers", "sappers"], hint: "Цель — склады, жилье, мастерские или паника." },
  sabotage: { label: "Саботаж", icon: "fa-solid fa-user-ninja", tags: ["skirmishers", "sappers"], hint: "Диверсанты, подкоп, открытые ворота, испорченные механизмы." },
  panic: { label: "Паника", icon: "fa-solid fa-person-running", tags: ["sacred", "skirmishers"], hint: "Давление по морали, слухи, бегство жителей, крики в дыму." },
  breach: { label: "Брешь", icon: "fa-solid fa-door-open", tags: ["siege", "sappers"], hint: "Раунд сосредоточен на разрушении укрепления или удержании пролома." },
  raid: { label: "Рейд", icon: "fa-solid fa-mask", tags: ["skirmishers", "mobile"], hint: "Враг бьет по конкретной цели: склад, пленник, животные, причал, башня." }
};

const ROUND_THREAT_MODIFIERS = {
  assault: {
    attackerTagMods: { infantry: 0.10, heavy: 0.10, sappers: 0.10, monsters: 0.10 },
    defenderTagMods: { infantry: 0.10, heavy: 0.10, garrison: 0.10 },
    modifierHint: "Штурм: +10% атакующим Пехоте, Тяжёлым, Сапёрам и Монстрам; +10% обороняющимся Пехоте, Тяжёлым и Гарнизонам."
  },
  fire: {
    attackerTagMods: { shooters: 0.15, siege: 0.15 },
    defenderTagMods: { heavy: 0.10, garrison: 0.10 },
    modifierHint: "Обстрел: +15% атакующим Огневым и Осадным; +10% обороняющимся Тяжёлым и Гарнизонам."
  },
  arson: {
    attackerTagMods: { skirmishers: 0.15, sappers: 0.15 },
    defenderTagMods: { skirmishers: 0.10, sappers: 0.10, garrison: 0.05 },
    modifierHint: "Поджог: +15% атакующим Егерям и Сапёрам; +10% обороняющимся Егерям и Сапёрам, +5% Гарнизонам."
  },
  sabotage: {
    attackerTagMods: { skirmishers: 0.20, sappers: 0.20 },
    defenderTagMods: { skirmishers: 0.10, garrison: 0.10 },
    modifierHint: "Саботаж: +20% атакующим Егерям и Сапёрам; +10% обороняющимся Егерям и Гарнизонам."
  },
  panic: {
    attackerTagMods: { sacred: 0.15, skirmishers: 0.10, monsters: 0.10 },
    defenderTagMods: { sacred: 0.15, militia: -0.10 },
    modifierHint: "Паника: +15% атакующему Сакральному, +10% Егерям и Монстрам; +15% обороняющемуся Сакральному, −10% Ополчению."
  },
  breach: {
    attackerTagMods: { siege: 0.20, sappers: 0.20 },
    defenderTagMods: { garrison: 0.15, heavy: 0.15 },
    modifierHint: "Брешь: +20% атакующим Осадным и Сапёрам; +15% обороняющимся Гарнизонам и Тяжёлым."
  },
  raid: {
    attackerTagMods: { mobile: 0.15, skirmishers: 0.15 },
    defenderTagMods: { mobile: 0.10, skirmishers: 0.10 },
    modifierHint: "Рейд: +15% атакующим Мобильным и Егерям; +10% обороняющимся Мобильным и Егерям."
  }
};

for (const [key, modifiers] of Object.entries(ROUND_THREAT_MODIFIERS)) {
  Object.assign(ROUND_THREATS[key], modifiers);
  ROUND_THREATS[key].hint = `${ROUND_THREATS[key].hint} ${modifiers.modifierHint}`;
}

export const DEFENDER_MOBILIZATIONS = {
  watch: { label: "Стража", hint: "Постоянные отряды, гарнизоны и военные специалисты." },
  militia: { label: "Стража + ополчение", hint: "Стража плюс гражданское ополчение, если включена галка." },
  manual: { label: "Вручную", hint: "Служебный режим старых данных." }
};

export const ATTACKER_PRESETS = {
  custom: { label: "Свои значения", summary: "Ничего не меняет. Используй, если враг нестандартный.", patch: {} },
  pettyRaiders: { label: "Мелкие налетчики", summary: "6-10 слабых налетчиков. Опасны против пустого склада, но не против стены.", patch: { enemyName: "Мелкие налетчики", objective: "Разграбить окраину", scale: "raid", attackerUnits: 1, attackerBS: 5, attackerCommand: 0, attackerHero: 0, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "raidWithdraw", attackerInfantry: 1, attackerShooters: 0, attackerMobile: 1, attackerHeavy: 0, attackerSappers: 0, attackerSiege: 0, attackerSkirmishers: 1, attackerMonsters: 0, attackerSacred: 0 } },
  banditGang: { label: "Шайка разбойников", summary: "10-20 вооруженных людей. Давят числом и охотно рейдят склады.", patch: { enemyName: "Шайка разбойников", objective: "Разграбить владение", scale: "skirmish", attackerUnits: 3, attackerBS: 15, attackerCommand: 1, attackerHero: 0, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "raidWithdraw", attackerInfantry: 2, attackerShooters: 1, attackerMobile: 1, attackerHeavy: 0, attackerSappers: 0, attackerSiege: 0, attackerSkirmishers: 1, attackerMonsters: 0, attackerSacred: 0 } },
  beastPack: { label: "Стая тварей", summary: "Быстрые звери или мутанты. Слабо управляются, но опасны в рывке.", patch: { enemyName: "Стая тварей", objective: "Прорваться и растерзать", scale: "raid", attackerUnits: 3, attackerBS: 16, attackerCommand: 0, attackerHero: 1, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "breakthrough", attackerInfantry: 0, attackerShooters: 0, attackerMobile: 2, attackerHeavy: 0, attackerSappers: 0, attackerSiege: 0, attackerSkirmishers: 1, attackerMonsters: 3, attackerSacred: 0 } },
  cultMob: { label: "Культовая толпа", summary: "Фанатики с вожаками и ритуалом. Неровная сила, опасная моральным давлением.", patch: { enemyName: "Культовая толпа", objective: "Осквернить место / забрать жертву", scale: "skirmish", attackerUnits: 4, attackerBS: 20, attackerCommand: 1, attackerHero: 1, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "frontalAssault", attackerInfantry: 4, attackerShooters: 0, attackerMobile: 0, attackerHeavy: 0, attackerSappers: 0, attackerSiege: 0, attackerSkirmishers: 0, attackerMonsters: 0, attackerSacred: 3 } },
  skirmishers: { label: "Легкие стрелки", summary: "Стрелки, егеря, охотники или разведчики. Выбивают защитников и избегают лобового боя.", patch: { enemyName: "Легкие стрелки", objective: "Измотать оборону", scale: "skirmish", attackerUnits: 3, attackerBS: 15, attackerCommand: 1, attackerHero: 0, attackerSpecial: 0, attackerPosition: 1, attackerStrategy: "probingAdvance", attackerInfantry: 0, attackerShooters: 3, attackerMobile: 0, attackerHeavy: 0, attackerSappers: 0, attackerSiege: 0, attackerSkirmishers: 3, attackerMonsters: 0, attackerSacred: 0 } },
  trainedWarband: { label: "Военный отряд", summary: "Дисциплинированные бойцы с командиром. База для серьезной атаки на малое поселение.", patch: { enemyName: "Военный отряд", objective: "Взять ворота", scale: "battle", attackerUnits: 4, attackerBS: 22, attackerCommand: 2, attackerHero: 0, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "frontalAssault", attackerInfantry: 3, attackerShooters: 2, attackerMobile: 0, attackerHeavy: 1, attackerSappers: 1, attackerSiege: 0, attackerSkirmishers: 1, attackerMonsters: 0, attackerSacred: 0 } },
  mercCompany: { label: "Рота наемников", summary: "Профессионалы с офицером, стрелками и резервом. Уже настоящий штурм.", patch: { enemyName: "Рота наемников", objective: "Захватить владение", scale: "battle", attackerUnits: 6, attackerBS: 34, attackerCommand: 3, attackerHero: 1, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "frontalAssault", attackerInfantry: 4, attackerShooters: 3, attackerMobile: 1, attackerHeavy: 2, attackerSappers: 1, attackerSiege: 1, attackerSkirmishers: 1, attackerMonsters: 0, attackerSacred: 0 } },
  sapperTeam: { label: "Саперы и подкоп", summary: "Небольшая сила, которая хочет не честного боя, а бреши, взрыва или открытых ворот.", patch: { enemyName: "Саперная команда", objective: "Открыть брешь", scale: "siege", attackerUnits: 2, attackerBS: 10, attackerCommand: 1, attackerHero: 0, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "sabotage", attackerInfantry: 0, attackerShooters: 0, attackerMobile: 0, attackerHeavy: 0, attackerSappers: 2, attackerSiege: 1, attackerSkirmishers: 2, attackerMonsters: 0, attackerSacred: 0 } },
  siegeParty: { label: "Осадная партия", summary: "Таран, пушка, саперы или машина. Целенаправленно ломают укрепления.", patch: { enemyName: "Осадная партия", objective: "Пробить укрепления", scale: "siege", attackerUnits: 5, attackerBS: 28, attackerCommand: 2, attackerHero: 0, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "bombardment", attackerInfantry: 2, attackerShooters: 2, attackerMobile: 0, attackerHeavy: 1, attackerSappers: 3, attackerSiege: 4, attackerSkirmishers: 0, attackerMonsters: 0, attackerSacred: 0 } },
  flyingPirates: { label: "Воздушные пираты", summary: "Мобильная атака с воздуха, абордаж, крюки, вылазки и поджоги.", patch: { enemyName: "Воздушные пираты", objective: "Абордаж и грабеж", scale: "raid", attackerUnits: 4, attackerBS: 22, attackerCommand: 1, attackerHero: 1, attackerSpecial: 0, attackerPosition: 1, attackerStrategy: "breakthrough", attackerInfantry: 2, attackerShooters: 2, attackerMobile: 4, attackerHeavy: 0, attackerSappers: 1, attackerSiege: 0, attackerSkirmishers: 2, attackerMonsters: 0, attackerSacred: 0 } },
  monstrousAssault: { label: "Чудовищный штурм", summary: "Одна или несколько крупных тварей. Мало тактики, много проломленных ворот.", patch: { enemyName: "Чудовищный штурм", objective: "Сломать ворота", scale: "battle", attackerUnits: 2, attackerBS: 18, attackerCommand: 0, attackerHero: 2, attackerSpecial: 0, attackerPosition: 0, attackerStrategy: "breakthrough", attackerInfantry: 0, attackerShooters: 0, attackerMobile: 1, attackerHeavy: 1, attackerSappers: 0, attackerSiege: 1, attackerSkirmishers: 0, attackerMonsters: 2, attackerSacred: 0 } },
  armyColumn: { label: "Военная колонна", summary: "Сила государства или крупной фракции. Задача поселения — выиграть время и цену штурма.", patch: { enemyName: "Военная колонна", objective: "Оккупировать владение", scale: "siege", attackerUnits: 10, attackerBS: 60, attackerCommand: 4, attackerHero: 1, attackerSpecial: 0, attackerPosition: 1, attackerStrategy: "bombardment", attackerInfantry: 7, attackerShooters: 5, attackerMobile: 2, attackerHeavy: 3, attackerSappers: 3, attackerSiege: 4, attackerSkirmishers: 2, attackerMonsters: 0, attackerSacred: 0 } }
};

const ATTACKER_PRESET_TAG_COUNTS = {
  pettyRaiders: { mobile: 1 },
  banditGang: { infantry: 1, mobile: 1, skirmishers: 1 },
  beastPack: { monsters: 3 },
  cultMob: { infantry: 1, sacred: 3 },
  skirmishers: { shooters: 2, skirmishers: 1 },
  trainedWarband: { infantry: 1, shooters: 1, heavy: 1, sappers: 1 },
  mercCompany: { infantry: 2, shooters: 1, mobile: 1, heavy: 1, sappers: 1 },
  sapperTeam: { sappers: 2 },
  siegeParty: { heavy: 1, sappers: 2, siege: 2 },
  flyingPirates: { shooters: 1, mobile: 2, skirmishers: 1 },
  monstrousAssault: { monsters: 2 },
  armyColumn: { infantry: 4, shooters: 2, heavy: 1, sappers: 1, siege: 2 }
};

for (const [presetKey, counts] of Object.entries(ATTACKER_PRESET_TAG_COUNTS)) {
  const patch = ATTACKER_PRESETS[presetKey]?.patch;
  if (!patch) continue;
  for (const tagKey of Object.keys(DEFAULT_MASS_COMBAT_TAGS)) {
    const field = `attacker${tagKey[0].toUpperCase()}${tagKey.slice(1)}`;
    patch[field] = counts[tagKey] ?? 0;
  }
}

export const ATTACKER_PRESET_TAG_REQUIREMENTS = {
  ...ATTACKER_PRESET_TAG_COUNTS
};

export function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asInt(value, fallback = 0) {
  return Math.floor(asNumber(value, fallback));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function toSigned(value) {
  const number = asNumber(value, 0);
  return number > 0 ? `+${number}` : String(number);
}

export function diceText(rolls = []) {
  return rolls.map((roll) => roll >= 6 ? `<strong>${roll}</strong>` : String(roll)).join(", ");
}

export function successCount(rolls = []) {
  return rolls.filter((roll) => roll >= 6).length;
}

export function percentText(value = 0) {
  const pct = Math.round(asNumber(value, 0) * 100);
  return pct > 0 ? `+${pct}%` : `${pct}%`;
}

export function selectOptions(map, selected) {
  return Object.entries(map).map(([value, data]) => ({ value, label: data.label, hint: data.hint, selected: String(selected) === value }));
}

export function strategyOptions(selected, side = "any") {
  const allowedForDefenders = ["holdFortifications", "deepDefense", "counterattack", "protectCivilians", "protectObjective", "fightingWithdrawal"];
  const allowedForAttackers = ["frontalAssault", "probingAdvance", "raidWithdraw", "sabotage", "bombardment", "breakthrough"];
  const allowed = side === "defender" ? allowedForDefenders : side === "attacker" ? allowedForAttackers : [...allowedForDefenders, ...allowedForAttackers];
  return allowed.map((value) => ({ value, label: STRATEGIES[value]?.label ?? value, hint: STRATEGIES[value]?.hint ?? "", selected: String(selected) === value }));
}

export function strategySummary(strategy, side = "side") {
  const data = strategy ?? (side === "defender" ? DEFENSE_PLANS.holdFortifications : ATTACK_METHODS.frontalAssault);
  const role = side === "defender" ? "Защитники" : side === "attacker" ? "Нападающие" : "Сторона";
  const tags = (data.tags ?? []).map((key) => tagLabel(key, { includeSystem: false })).join(", ") || "нет";
  const dice = tags ? `теги: ${tags}` : "без тегового бонуса";
  let progress = "цель по margin";
  if (data.objectiveBonus > 0) progress = `цель быстрее на ${data.objectiveBonus}`;
  else if (data.objectiveBonus < 0) progress = `цель медленнее на ${Math.abs(data.objectiveBonus)}`;
  if (data.objectiveResist > 0) progress = `сопротивление цели +${data.objectiveResist}`;
  if (data.retreat) progress = "уступает пространство, спасает людей";
  return { label: data.label, role, dice, losses: "через Impact", progress, tags, summary: data.summary || data.hint || "" };
}

export function militiaThreshold(defense = {}) {
  if (defense?.militiaLeader) return 8;
  if (defense?.militiaTrained) return 12;
  if (defense?.militiaEquipped) return 15;
  return 20;
}

export function militiaQualityText(defense = {}) {
  const flags = [];
  if (defense?.militiaEquipped) flags.push("экипировано: 15 чел./отряд");
  if (defense?.militiaTrained) flags.push("обучено: 12 чел./отряд");
  if (defense?.militiaLeader) flags.push("лидер: 8 чел./отряд");
  return flags.length ? flags.join(", ") : "20 чел./отряд";
}

function capitalized(key = "") { return `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`; }

export function tagValue(state, side, key) {
  const prefix = side === "defender" ? "defender" : "attacker";
  const canonical = `${prefix}${capitalized(key)}`;
  if (state?.[canonical] !== undefined) return Math.max(0, asNumber(state[canonical], 0));
  for (const [legacy, mapped] of Object.entries(LEGACY_TAG_FIELD_MAP)) {
    if (mapped !== key) continue;
    const legacyKey = `${prefix}${capitalized(legacy)}`;
    if (state?.[legacyKey] !== undefined) return Math.max(0, asNumber(state[legacyKey], 0));
  }
  return 0;
}

export function commandPercentFromEffectiveness(effectiveness = 0) {
  const steps = clamp(asNumber(effectiveness, 0), 0, 5);
  return Math.min(0.25, steps * 0.05);
}

export function stateValue(state, key, fallback = 0) {
  return asNumber(state?.[key], fallback);
}
