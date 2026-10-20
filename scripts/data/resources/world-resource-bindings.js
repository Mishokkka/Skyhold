function compendiumBinding(label, aliases, itemId, img, cost) {
  return {
    img,
    aliases: [...aliases, label, `raw material ${label}`, `raw material: ${label}`],
    itemUuid: `Compendium.world.resursy.Item.${itemId}`,
    itemId,
    itemType: "rawMaterial",
    cost
  };
}

export const WORLD_RESOURCE_BINDINGS = {
  money: {
    aliases: ["money", "coin", "coins", "монеты", "деньги", "медь", "медные", "серебро", "золото"]
  },
  "animal-feed": {
    aliases: ["animal feed", "feed", "fodder", "корм", "корм для животных", "фураж"]
  },
  "fuel-solid": compendiumBinding("Black Coal", ["black coal", "уголь", "черный уголь", "blackcoal", "coal", "charcoal", "coke"], "iozYnXMjzPo0PCRd", "3_F00L/Icons/Items/Smith/BlackCoal.png", "5C"),
  bread: compendiumBinding("Bread", ["bread", "хлеб", "пища", "еда", "food"], "lcKETIyM67KGLIzy", "3_F00L/Icons/Items/TradeGoods/Bread.png", "4C"),
  silk: compendiumBinding("Cloth, Silk", ["silk cloth", "cloth silk", "шелк", "шелковая ткань"], "5CxK93RSJXmBLZ2p", "3_F00L/Icons/Items/TradeGoods/ClothSilk.png", "1 G"),
  cloth: compendiumBinding("Cloth, Wool", ["wool cloth", "cloth wool", "шерстяная ткань", "сукно", "ткань", "cloth"], "Qf3zJ6Ike2yuhVwP", "3_F00L/Icons/Items/TradeGoods/ClothWool.png", "8 C"),
  copper: compendiumBinding("Copper", ["copper", "медь", "медный слиток"], "vfI8j55tsEWUVDrh", "3_F00L/Icons/Items/TradeGoods/CopperIngot.png", "2 S"),
  flour: compendiumBinding("Flour", ["flour", "мука"], "PbQFuw2JzCsc8CeL", "3_F00L/Icons/Items/TradeGoods/Flour.png", "3C"),
  fruits: compendiumBinding("Fruits", ["fruits", "fruit", "фрукты", "плоды", "пища", "еда"], "Ypo2tVoRr60eTFRW", "3_F00L/Icons/Items/Kitchen/Fruits.png", "4C"),
  glass: compendiumBinding("Glass", ["glass", "стекло"], "fWh8rUd5kothZV5B", "3_F00L/Icons/Items/TradeGoods/Glass.png", "8 S"),
  gold: compendiumBinding("Gold", ["gold", "золото", "золотой слиток"], "GoI2DCVtPLKpjobj", "3_F00L/Icons/Items/TradeGoods/Gold.png", "10 G"),
  grain: compendiumBinding("Grain", ["grain", "зерно", "злаки", "пища", "еда"], "6xhdtrjnnRwx6Cab", "3_F00L/Icons/Items/Regular/Grain.png", "2 C"),
  herbs: compendiumBinding("Herbs", ["herbs", "травы", "трава", "лекарственные травы"], "SupoqycbuiyAHUL1", "3_F00L/Icons/Items/TradeGoods/Herbs.png", "2 S"),
  honey: compendiumBinding("Honey", ["honey", "мед", "мёд", "пища", "еда"], "XLmcnqeYFQXlbaJQ", "3_F00L/Icons/Items/Kitchen/Honey.png", "40C"),
  iron: compendiumBinding("Iron", ["iron", "железо", "металл", "слитки", "metal"], "CQpPmttjTUiT3NKM", "3_F00L/Icons/Items/TradeGoods/Iron.png", "1 S"),
  "iron-ore": compendiumBinding("Iron Ore", ["iron ore", "ore", "руда", "железная руда"], "0gwozD4R4pn9Got9", "3_F00L/Icons/Items/TradeGoods/IronOre.png", "4 C"),
  leather: compendiumBinding("Leather", ["leather", "кожа"], "5E4IQjsvA1sJ8Fns", "3_F00L/Icons/Items/TradeGoods/Leather.png", "12 C"),
  meat: compendiumBinding("Meat", ["meat", "мясо", "пища", "еда", "food"], "wwCjXxxnTd2YpJ0s", "3_F00L/Icons/Items/Kitchen/Meat.png", "6C"),
  milk: compendiumBinding("Milk", ["milk", "молоко", "пища", "еда"], "lTu15CSlUJ6nGjZS", "3_F00L/Icons/Items/Kitchen/Milk.png", "3C"),
  parchment: { aliases: ["parchment", "пергамент"] },
  pelt: compendiumBinding("Pelt", ["pelt", "шкура", "шкуры", "мех"], "B85XQAx3hVinQbLq", "3_F00L/Icons/Items/TradeGoods/Pelt.png", "8 C"),
  silver: compendiumBinding("Silver", ["silver", "серебро", "серебряный слиток"], "cjJeJAW8O7A3JlRw", "3_F00L/Icons/Items/TradeGoods/Silver.png", "1 G"),
  stone: compendiumBinding("Stone", ["stone", "камень", "камни", "валун", "каменья"], "aKdiGkyLV3sUQIRr", "3_F00L/Icons/Items/TradeGoods/Stone.png", "2 C"),
  straw: { aliases: ["straw", "солома"] },
  tallow: compendiumBinding("Tallow", ["tallow", "жир", "сало"], "x4b1cSnctu3G3yBD", "3_F00L/Icons/Items/TradeGoods/Tallow.png", "6 C"),
  vegetables: compendiumBinding("Vegetables", ["vegetables", "veggie", "овощи", "овощ", "пища", "еда"], "Vi0DphgtkOLLFm6c", "3_F00L/Icons/Items/Kitchen/Veggie.png", "4C"),
  wood: compendiumBinding("Wood", ["wood", "дерево", "древесина", "лес", "бревна", "доски"], "zSA7X1QooILVS69A", "3_F00L/Icons/Items/Regular/Wood.png", "3 C"),
  wool: compendiumBinding("Wool", ["wool", "шерсть"], "0jaPgPUC0NcJjT66", "3_F00L/Icons/Items/TradeGoods/Wool.png", "4 C"),
  water: { aliases: ["water", "вода"] }
};
