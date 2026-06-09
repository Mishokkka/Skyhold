export const TRAIT_DEFINITIONS = [
  { name: "Оптимист", morale: 1, category: "Бытовая", description: "+1 к довольству. Обычно легче переносит бытовые неудобства." },
  { name: "Ворчливый", morale: -1, category: "Бытовая", description: "-1 к довольству. Быстрее раздражается из-за жилья, работы и нехватки удобств." },
  { name: "Неприхотливый", morale: 0, category: "Бытовая", description: "В будущих расчетах сможет игнорировать часть штрафов от плохого жилья." },
  { name: "Чистюля", morale: 0, category: "Бытовая", description: "Сильнее страдает от грязного или тесного жилья, но лучше держит порядок." },
  { name: "Крепкий", morale: 0, category: "Физическая", description: "+0.5 эффективности на тяжелых, производственных и оборонных работах; +1 к стройбригаде." },
  { name: "Больная спина", morale: 0, category: "Проблемная", description: "-0.5 эффективности на тяжелых работах; -1 к стройбригаде." },
  { name: "Грамотный", morale: 0, category: "Профессиональная", description: "+0.5 эффективности в учете, культуре, доходности, библиотеке, скриптории и управлении; может помочь стройке при высоком Разуме." },
  { name: "Мастеровой", morale: 0, category: "Профессиональная", description: "+0.5 эффективности в производстве, складах и мастерских; +1 к стройбригаде." },
  { name: "Builder", morale: 0, category: "Профессиональная", description: "Строитель. Открывает здания с требованием Builder, если возглавляет стройбригаду; раз в месяц позволяет стройбригаде перебросить кубы строительства." },
  { name: "Пьяница", morale: -1, category: "Проблемная", description: "-1 к довольству. Может провоцировать скандалы, прогулы и потери ресурсов." },
  { name: "Клептоман", morale: 0, category: "Скрытая", description: "Скрытая проблемная черта. Может вызывать пропажу ресурсов." },
  { name: "Трус", morale: 0, category: "Проблемная", description: "-0.5 эффективности на оборонных и опасных работах." },
  { name: "Храбрец", morale: 0, category: "Социальная", description: "+0.5 эффективности в обороне, дозорах и опасных службах." },
  { name: "Верующий", morale: 0, category: "Социальная", description: "Острее реагирует на религиозную среду, святыни и конфликты верований." },
  { name: "Скандалист", morale: -1, category: "Проблемная", description: "-1 к довольству. Повышает риск бытовых конфликтов." },
  { name: "Молчаливый", morale: 0, category: "Социальная", description: "Редко создает конфликты, но плохо работает лицом поселения." },
  { name: "Лидер", morale: 0, category: "Социальная", description: "Может усиливать группу, но становится опасен при недовольстве." },
  { name: "Рассеянный", morale: 0, category: "Проблемная", description: "-0.5 эффективности в производстве и механизмах; -1 к стройбригаде." },
  { name: "Бережливый", morale: 0, category: "Профессиональная", description: "+0.5 эффективности в складах, доходности, торговле и снабжении." },
  { name: "Азартный", morale: 0, category: "Проблемная", description: "Тянется к риску, долгам и сомнительным сделкам." },
  { name: "Подозрительный", morale: 0, category: "Социальная", description: "Может замечать угрозы, но ухудшает атмосферу в тесных группах." },
  { name: "Суетливый", morale: 0, category: "Физическая", description: "Хорош для беготни, посылок и легких работ, хуже в спокойной рутине." },
  { name: "Упрямый", morale: 0, category: "Социальная", description: "Трудно переубедить; стабилен под давлением, но конфликтен в споре." },
  { name: "Ночная птица", morale: 0, category: "Бытовая", description: "Лучше подходит для ночных смен, дозоров и работ при необычном графике." },
  { name: "Трудолюбивый", morale: 0, category: "Профессиональная", description: "Надежен в рутинной работе. Пока работает как мягкая положительная черта для будущих событий." },
  { name: "Ленивый", morale: -1, category: "Проблемная", description: "-1 к довольству. Плох в долгой рутине и может стать источником простоев." },
  { name: "Аккуратный", morale: 0, category: "Профессиональная", description: "Полезен для склада, писарской работы, мастерских и сложных операций." },
  { name: "Жадный", morale: 0, category: "Проблемная", description: "Рискован в торговле, казне и доступе к ценностям." },
  { name: "Надежный", morale: 1, category: "Социальная", description: "+1 к довольству. Хорош для ответственных назначений и руководства." },
  { name: "Скрытый фанатик", morale: 0, category: "Скрытая", description: "Скрытая религиозная угроза. Может активироваться при кризисе веры." },
  { name: "Беглый преступник", morale: 0, category: "Скрытая", description: "Скрытое прошлое. Может принести проблемы с законом или бывшими хозяевами." },
  { name: "Саботажник", morale: 0, category: "Скрытая", description: "Скрытая враждебная черта. Опасен для складов, механизмов и обороны." }
];

export const TRAIT_BY_NAME = Object.fromEntries(TRAIT_DEFINITIONS.map((trait) => [trait.name.toLowerCase(), trait]));

export function getTraitDefinition(name = "") {
  return TRAIT_BY_NAME[String(name).trim().toLowerCase()] ?? null;
}

export function traitOptions(selected = []) {
  const selectedSet = new Set(selected.map((item) => String(item).trim().toLowerCase()));
  return TRAIT_DEFINITIONS.map((trait) => ({
    ...trait,
    selected: selectedSet.has(trait.name.toLowerCase())
  }));
}

export function traitBadges(value) {
  const names = Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : String(value ?? "").split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);

  return names.map((name) => {
    const def = getTraitDefinition(name);
    return {
      name,
      description: def?.description ?? "Нет описания. Черта сохранена как пользовательская.",
      morale: Number(def?.morale ?? 0),
      category: def?.category ?? "Пользовательская"
    };
  });
}

export function traitMorale(value) {
  const badges = traitBadges(value);
  const total = badges.reduce((sum, trait) => sum + Number(trait.morale || 0), 0);
  const reasons = badges.filter((trait) => Number(trait.morale || 0) !== 0).map((trait) => `${trait.name} ${Number(trait.morale) > 0 ? "+" : ""}${trait.morale}`);
  return { value: total, reasons };
}

export const TRAIT_POOLS = {
  soft: ["Оптимист", "Надежный", "Неприхотливый", "Грамотный", "Мастеровой", "Builder", "Крепкий", "Бережливый", "Аккуратный", "Храбрец", "Верующий", "Лидер", "Молчаливый"],
  neutral: ["Чистюля", "Трудолюбивый", "Подозрительный", "Азартный", "Рассеянный", "Скандалист", "Ворчливый", "Трус", "Суетливый", "Упрямый", "Ночная птица"],
  dangerous: ["Пьяница", "Ленивый", "Клептоман", "Жадный", "Больная спина", "Скрытый фанатик", "Беглый преступник", "Саботажник"]
};
