function resourcePresentation(label, aliases, img, cost) {
  return {
    img,
    aliases: [...aliases, label],
    cost
  };
}

export const RESOURCE_PRESENTATION = {
  money: {
    aliases: ["money", "coin", "coins", "монеты", "деньги", "медь", "медные", "серебро", "золото"]
  },
  "black-coal": resourcePresentation("Black Coal", ["black coal", "уголь", "черный уголь", "blackcoal", "coal"], "3_F00L/Icons/Items/Smith/BlackCoal.png", "5C"),
  bread: resourcePresentation("Bread", ["bread", "хлеб", "пища", "еда", "food"], "3_F00L/Icons/Items/TradeGoods/Bread.png", "6C"),
  charcoal: resourcePresentation("Charcoal", ["charcoal", "древесный уголь", "уголь"], "3_F00L/Icons/Items/Smith/Charcoal.png", "2C"),
  "cloth-silk": resourcePresentation("Cloth, Silk", ["silk cloth", "cloth silk", "шелк", "шелковая ткань", "ткань"], "3_F00L/Icons/Items/TradeGoods/ClothSilk.png", "1 G"),
  "cloth-wool": resourcePresentation("Cloth, Wool", ["wool cloth", "cloth wool", "шерстяная ткань", "сукно", "ткань", "cloth"], "3_F00L/Icons/Items/TradeGoods/ClothWool.png", "18 C"),
  coke: resourcePresentation("Coke", ["coke", "кокс"], "3_F00L/Icons/Items/Smith/Charcoal.png", "4C"),
  copper: resourcePresentation("Copper", ["copper", "медь", "медный слиток"], "3_F00L/Icons/Items/TradeGoods/CopperIngot.png", "2 S"),
  eggs: { aliases: ["eggs", "egg", "яйца", "яйцо"], cost: "6 C" },
  feathers: { aliases: ["feathers", "feather", "down", "перья", "перо", "пух"], cost: "8 C" },
  flour: resourcePresentation("Flour", ["flour", "мука"], "3_F00L/Icons/Items/TradeGoods/Flour.png", "6C"),
  fruits: resourcePresentation("Fruits", ["fruits", "fruit", "фрукты", "плоды", "пища", "еда"], "3_F00L/Icons/Items/Kitchen/Fruits.png", "4C"),
  glass: resourcePresentation("Glass", ["glass", "стекло"], "3_F00L/Icons/Items/TradeGoods/Glass.png", "8 S"),
  gold: resourcePresentation("Gold", ["gold", "золото", "золотой слиток"], "3_F00L/Icons/Items/TradeGoods/Gold.png", "10 G"),
  grain: resourcePresentation("Grain", ["grain", "зерно", "злаки", "пища", "еда"], "3_F00L/Icons/Items/Regular/Grain.png", "4 C"),
  herbs: resourcePresentation("Herbs", ["herbs", "травы", "трава", "лекарственные травы"], "3_F00L/Icons/Items/TradeGoods/Herbs.png", "2 S"),
  honey: resourcePresentation("Honey", ["honey", "мед", "мёд", "пища", "еда"], "3_F00L/Icons/Items/Kitchen/Honey.png", "40C"),
  iron: resourcePresentation("Iron", ["iron", "железо", "металл", "слитки", "metal"], "3_F00L/Icons/Items/TradeGoods/Iron.png", "1 S"),
  "iron-ore": resourcePresentation("Iron Ore", ["iron ore", "ore", "руда", "железная руда"], "3_F00L/Icons/Items/TradeGoods/IronOre.png", "4 C"),
  leather: resourcePresentation("Leather", ["leather", "кожа"], "3_F00L/Icons/Items/TradeGoods/Leather.png", "12 C"),
  meat: resourcePresentation("Meat", ["meat", "мясо", "пища", "еда", "food"], "3_F00L/Icons/Items/Kitchen/Meat.png", "6C"),
  milk: resourcePresentation("Milk", ["milk", "молоко", "пища", "еда"], "3_F00L/Icons/Items/Kitchen/Milk.png", "3C"),
  parchment: { aliases: ["parchment", "пергамент"] },
  pelt: resourcePresentation("Pelt", ["pelt", "шкура", "шкуры", "мех"], "3_F00L/Icons/Items/TradeGoods/Pelt.png", "8 C"),
  silver: resourcePresentation("Silver", ["silver", "серебро", "серебряный слиток"], "3_F00L/Icons/Items/TradeGoods/Silver.png", "1 G"),
  stone: resourcePresentation("Stone", ["stone", "камень", "камни", "валун", "каменья"], "3_F00L/Icons/Items/TradeGoods/Stone.png", "2 C"),
  straw: { aliases: ["straw", "солома"] },
  tallow: resourcePresentation("Tallow", ["tallow", "жир", "сало"], "3_F00L/Icons/Items/TradeGoods/Tallow.png", "6 C"),
  vegetables: resourcePresentation("Vegetables", ["vegetables", "veggie", "овощи", "овощ", "пища", "еда"], "3_F00L/Icons/Items/Kitchen/Veggie.png", "4C"),
  wood: resourcePresentation("Wood", ["wood", "дерево", "древесина", "лес", "бревна", "доски"], "3_F00L/Icons/Items/Regular/Wood.png", "3 C"),
  wool: resourcePresentation("Wool", ["wool", "шерсть"], "3_F00L/Icons/Items/TradeGoods/Wool.png", "4 C"),
  water: { aliases: ["water", "вода"] }
};
