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
    id: "masonry",
    label: "Кладочные материалы",
    aliases: ["кладка", "каменная кладка", "кирпич или камень", "masonry"],
    resourceIds: ["stone", "bricks"]
  },
  {
    id: "ferrous",
    label: "Чёрные металлы",
    aliases: ["железо или сталь", "черные металлы", "чёрные металлы", "ferrous"],
    resourceIds: ["iron", "steel"]
  },
  {
    id: "nonferrous",
    label: "Цветные металлы",
    aliases: ["медь или цветные металлы", "цветной металл", "nonferrous"],
    resourceIds: ["copper", "nonferrous-metals"]
  },
  {
    id: "precious",
    label: "Драгоценные металлы",
    aliases: ["золото или серебро", "драгоценный металл", "precious"],
    resourceIds: ["silver", "gold"]
  },
  {
    id: "textile",
    label: "Обычный текстиль",
    aliases: ["ткань или волокно", "текстиль", "textile"],
    resourceIds: ["wool", "plant-fiber", "cloth", "pelt", "leather"]
  },
  {
    id: "ingredient.grain",
    label: "Зерновое сырьё",
    aliases: ["зерновой ингредиент", "зерно или мука", "grain ingredient"],
    resourceIds: ["grain", "flour"]
  },
  {
    id: "ingredient.protein",
    label: "Белковое сырьё",
    aliases: ["белковый ингредиент", "мясо рыба или яйца", "protein ingredient"],
    resourceIds: ["meat", "fish", "eggs"]
  },
  {
    id: "ingredient.fruit",
    label: "Плодовое сырьё",
    aliases: ["плодовый ингредиент", "овощи или фрукты", "fruit ingredient"],
    resourceIds: ["vegetables", "fruits"]
  },
  {
    id: "ingredient.sweet",
    label: "Подсластитель",
    aliases: ["сладкий ингредиент", "мед или сахар", "sweetener"],
    resourceIds: ["honey", "sugar"]
  },
  {
    id: "food.prepared",
    label: "Готовая пища",
    aliases: ["рацион", "готовая еда", "prepared food"],
    resourceIds: ["bread", "food-grain", "food-protein", "food-dairy", "food-fruit", "preserved-meat", "aged-cheese", "dried-fruit"]
  },
  {
    id: "alcohol",
    label: "Алкоголь",
    aliases: ["алкогольный напиток", "alcohol"],
    resourceIds: [
      "alcohol-brewed-cheap-weak", "alcohol-brewed-fine-weak", "alcohol-brewed-cheap-strong", "alcohol-brewed-fine-strong",
      "alcohol-wine-cheap-weak", "alcohol-wine-fine-weak", "alcohol-wine-cheap-strong", "alcohol-wine-fine-strong",
      "alcohol-general-cheap-weak", "alcohol-general-fine-weak", "alcohol-general-cheap-strong", "alcohol-general-fine-strong"
    ]
  },
  {
    id: "component",
    label: "Компоненты",
    aliases: ["детали", "components"],
    resourceIds: ["components-simple", "components-complex", "components-high-tech"]
  },
  {
    id: "tool",
    label: "Инструменты",
    aliases: ["инструмент", "tools"],
    resourceIds: ["tools-simple", "tools-complex"]
  },
  {
    id: "fuel",
    label: "Промышленное топливо",
    aliases: ["топливо", "fuel"],
    resourceIds: ["fuel-solid", "fuel-liquid"]
  },
  {
    id: "chemical",
    label: "Химические материалы",
    aliases: ["химикаты", "chemical"],
    resourceIds: ["chemicals-simple", "chemicals-complex"]
  },
  {
    id: "military",
    label: "Военные припасы",
    aliases: ["боеприпасы", "military supplies"],
    resourceIds: ["military-supplies-simple", "military-supplies-complex"]
  },
  {
    id: "armament",
    label: "Вооружение отряда",
    aliases: ["вооружение", "armament"],
    resourceIds: ["armament-simple", "armament-complex", "armament-elite"]
  },
  {
    id: "medicine",
    label: "Медицинские товары",
    aliases: ["медицина", "medicine"],
    resourceIds: ["medical-supplies", "medicines"]
  },
  {
    id: "medicine.raw",
    label: "Лекарственное сырьё",
    aliases: ["лекарственные травы", "medicine raw"],
    resourceIds: ["herbs"]
  },
  {
    id: "consumer",
    label: "Бытовые товары",
    aliases: ["товары быта", "consumer goods"],
    resourceIds: ["household-goods-simple", "household-goods-fine"]
  },
  {
    id: "luxury",
    label: "Предметы роскоши",
    aliases: ["роскошь", "luxury"],
    resourceIds: ["silk", "tea", "coffee", "cocoa", "tobacco", "gemstones", "art-goods"]
  },
  {
    id: "animal.feed",
    label: "Корм для животных",
    aliases: ["корм", "фураж", "animal feed"],
    resourceIds: ["animal-feed"]
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
  const categoryTag = normalized(effective.categoryTag);
  if (categoryTag) return categoryTag === normalized(group.id);
  if (explicitGroups(effective).includes(group.id)) return true;
  const id = String(resource?.resourceId ?? resource?.id ?? definition?.id ?? "");
  return (group.resourceIds ?? []).includes(id);
}

export function materialGroupHelpText() {
  return MATERIAL_GROUPS.map((group) => group.label).join(", ");
}
