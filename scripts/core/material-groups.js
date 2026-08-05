function normalized(value = "") {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

export const MATERIAL_GROUPS = [
  {
    id: "fuel",
    label: "Горючее",
    aliases: ["топливо", "горючий материал", "fuel"],
    resourceIds: ["wood", "charcoal", "black-coal", "coke", "straw", "tallow"],
    keywords: ["дров", "угол", "кокс", "солом", "топлив", "горюч", "масло", "жир", "wood", "coal", "coke", "straw", "fuel", "oil", "tallow"]
  },
  {
    id: "edible",
    label: "Съедобное",
    aliases: ["пищевое сырье", "еда", "продукты", "food", "edible"],
    resourceIds: ["bread", "flour", "fruits", "grain", "herbs", "honey", "meat", "milk", "vegetables"],
    keywords: ["молок", "мяс", "куриц", "птиц", "рыб", "яйц", "зерн", "мук", "хлеб", "овощ", "фрукт", "ягод", "гриб", "мед", "съедоб", "пищ", "food", "edible", "milk", "meat", "chicken", "poultry", "fish", "egg", "grain", "flour", "bread", "vegetable", "fruit", "honey"]
  },
  {
    id: "construction",
    label: "Стройматериал",
    aliases: ["строительный материал", "материал для строительства", "building material"],
    resourceIds: ["wood", "stone", "iron", "glass", "straw"],
    keywords: ["древес", "доск", "кам", "кирпич", "глин", "цемент", "стекл", "желез", "балк", "wood", "timber", "stone", "brick", "clay", "glass", "iron"]
  },
  {
    id: "metal",
    label: "Металл",
    aliases: ["металлы", "metal"],
    resourceIds: ["iron", "copper", "silver", "gold", "iron-ore"],
    keywords: ["желез", "мед", "сереб", "золот", "сталь", "бронз", "олов", "руда", "iron", "copper", "silver", "gold", "steel", "bronze", "ore", "metal"]
  },
  {
    id: "textile",
    label: "Текстиль",
    aliases: ["ткань", "волокно", "textile", "cloth"],
    resourceIds: ["cloth-silk", "cloth-wool", "wool"],
    keywords: ["ткан", "шерст", "шелк", "льн", "хлоп", "нит", "пряж", "cloth", "wool", "silk", "linen", "cotton", "thread", "textile"]
  },
  {
    id: "hide",
    label: "Кожа или шкура",
    aliases: ["кожа", "шкура", "hide", "leather"],
    resourceIds: ["leather", "pelt"],
    keywords: ["кож", "шкур", "мех", "leather", "pelt", "hide", "fur"]
  },
  {
    id: "medicinal",
    label: "Лекарственное сырьё",
    aliases: ["лекарственное", "медицинское сырье", "medicine", "medicinal"],
    resourceIds: ["herbs", "honey"],
    keywords: ["трав", "лекар", "целеб", "медицин", "эликс", "herb", "medicine", "medicinal", "healing"]
  },
  {
    id: "liquid",
    label: "Жидкость",
    aliases: ["жидкости", "liquid"],
    resourceIds: ["water", "milk", "honey", "tallow"],
    keywords: ["вод", "молок", "масло", "жир", "сок", "настой", "жидк", "water", "milk", "oil", "juice", "liquid"]
  },
  {
    id: "organic",
    label: "Органическое сырьё",
    aliases: ["органика", "organic"],
    resourceIds: ["wood", "straw", "wool", "leather", "pelt", "tallow", "herbs"],
    keywords: ["древес", "солом", "шерст", "кож", "шкур", "жир", "трав", "органич", "wood", "straw", "wool", "leather", "pelt", "tallow", "herb", "organic"]
  },
  {
    id: "mineral",
    label: "Минеральное сырьё",
    aliases: ["минерал", "минеральное", "mineral"],
    resourceIds: ["stone", "iron-ore", "black-coal", "coke", "glass", "copper", "iron"],
    keywords: ["кам", "руд", "угол", "минерал", "стекл", "металл", "stone", "ore", "coal", "mineral", "glass", "metal"]
  }
];

const GROUP_BY_ID = new Map(MATERIAL_GROUPS.map((group) => [group.id, group]));
const GROUP_BY_ALIAS = new Map();
for (const group of MATERIAL_GROUPS) {
  for (const alias of [group.id, group.label, ...(group.aliases ?? [])]) GROUP_BY_ALIAS.set(normalized(alias), group);
}

export function materialGroup(value = "") {
  if (value && typeof value === "object") return GROUP_BY_ID.get(String(value.id ?? value.resourceGroup ?? "")) ?? null;
  return GROUP_BY_ID.get(String(value ?? "")) ?? GROUP_BY_ALIAS.get(normalized(value)) ?? null;
}

export function materialGroupOptions(selected = "") {
  const selectedId = materialGroup(selected)?.id ?? "";
  return MATERIAL_GROUPS.map((group) => ({ ...group, selected: group.id === selectedId }));
}

function explicitGroups(resource = {}) {
  const values = resource.materialGroups ?? resource.groups ?? [];
  return (Array.isArray(values) ? values : String(values ?? "").split(/[,;\n]/))
    .map((value) => materialGroup(String(value).trim())?.id ?? String(value).trim())
    .filter(Boolean);
}

export function resourceMatchesMaterialGroup(resource = {}, groupValue = "", definition = null) {
  const group = materialGroup(groupValue);
  if (!group) return false;
  const effective = { ...(definition ?? {}), ...(resource ?? {}) };
  if (explicitGroups(effective).includes(group.id)) return true;
  const id = String(resource?.resourceId ?? resource?.id ?? definition?.id ?? "");
  if ((group.resourceIds ?? []).includes(id)) return true;
  const haystack = normalized([
    resource?.name,
    resource?.label,
    resource?.category,
    definition?.label,
    definition?.category,
    ...(definition?.aliases ?? [])
  ].filter(Boolean).join(" "));
  return (group.keywords ?? []).some((keyword) => haystack.includes(normalized(keyword)));
}

export function materialGroupHelpText() {
  return MATERIAL_GROUPS.map((group) => group.label).join(", ");
}
