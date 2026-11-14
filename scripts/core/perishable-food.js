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

/** Whole elapsed QD are compared with the same whole storage deadline at every boundary. */
export function effectiveShelfLifeQd(baseQd, multiplier = 1) {
  const base = Math.floor(Number(baseQd) || 0);
  return base > 0 ? Math.max(1, Math.floor(base * Math.max(1, Number(multiplier) || 1))) : 0;
}
