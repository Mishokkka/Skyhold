/** Food classification is independent of recipe ingredient groups. */
export function isPerishableFoodDefinition(definition = {}) {
  if (!(Number(definition.shelfLifeQd) > 0)) return false;
  const category = String(definition.category ?? "").toLocaleLowerCase("ru").replace(/ё/g, "е");
  const tag = String(definition.categoryTag ?? "").toLowerCase();
  const tags = Array.isArray(definition.marketTags) ? definition.marketTags : String(definition.marketTags ?? "").split(/[,;\s]+/);
  return definition.foodEdible === true || category === "пищевое сырье" || category === "готовая еда"
    || ["food.raw", "food.prepared"].includes(tag)
    || tags.some((value) => ["food", "food.raw", "food.prepared"].includes(String(value).toLowerCase()));
}
