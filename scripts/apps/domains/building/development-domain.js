// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { SkyholdData } from "../../../data/store.js";
import { ATTRIBUTE_META } from "../../../generators/resident-rules.js";
import { splitList, WORKER_TYPE_OPTIONS } from "../../../core/helpers.js";
import { normalizeResourceId, resourceIcon, resourceLabel, resourceOptions } from "../../../core/resources.js";

export const BuildingDevelopmentDomain = {
_developmentParts(dev, basePath = "") {
  const items = [
    { key: "food", label: "Еда", icon: "fa-solid fa-utensils", css: "food" },
    { key: "technology", label: "Технология", icon: "fa-solid fa-wrench", css: "technology" },
    { key: "culture", label: "Культура", icon: "fa-solid fa-music", css: "culture" },
    { key: "war", label: "Война", icon: "fa-solid fa-shield-halved", css: "war" }
  ];
  return items.map((item) => ({
    ...item,
    value: this._safeNumber(dev?.[item.key], 0),
    path: basePath ? `${basePath}.${item.key}` : ""
  }));
},

_prepareMaterialCosts(building, buildingIndex, holdingIndexArg = null, basePathArg = "") {
  const source = Array.isArray(building?.materialCosts) ? building.materialCosts : [];
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndexForBuilding(building);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  return source.map((item, index) => ({
    id: String(item?.id ?? `mat-${index}`),
    _index: index,
    name: String(item?.name ?? ""),
    resourceId: String(item?.resourceId ?? item?.resource ?? item?.name ?? ""),
    qty: this._safeNumber(item?.qty, 0),
    namePath: `${recordPath}.materialCosts.${index}.name`,
    resourceIdPath: `${recordPath}.materialCosts.${index}.resourceId`,
    qtyPath: `${recordPath}.materialCosts.${index}.qty`
  }));
},

_prepareRequiredBuildingRows(holding, building, buildingIndex, holdingIndexArg = null, basePathArg = "", options = {}) {
  const ids = Array.isArray(building?.requiredBuildingIds) ? building.requiredBuildingIds : [];
  const holdingIndex = Number.isInteger(holdingIndexArg) ? holdingIndexArg : this._holdingIndex(holding);
  const recordPath = basePathArg || `holdings.${holdingIndex}.buildings.list.${buildingIndex}`;
  const buildings = holding?.buildings?.list ?? [];
  return ids.map((value, index) => {
    const text = String(value ?? "");
    const match = buildings.find((item) => item.id === text || item.name === text);
    const status = match ? this._buildingStatus(match) : null;
    return {
      _index: index,
      value: text,
      label: match?.name ?? text,
      met: Boolean(match && status?.value === "built"),
      path: `${recordPath}.requiredBuildingIds.${index}`,
      options: options?.isTemplate ? this._templatePrerequisiteOptions(building, text) : this._buildingPrerequisiteOptions(holding, building, text)
    };
  });
},

_buildingPrerequisiteOptions(holding, building, selected = "") {
  const selectedValue = String(selected ?? "");
  const options = [{ value: "", label: "Выбрать", selected: !selectedValue }];
  for (const candidate of holding?.buildings?.list ?? []) {
    if (!candidate?.id || candidate.id === building?.id) continue;
    const value = String(candidate.id);
    options.push({
      value,
      label: candidate.name || "Без названия",
      selected: value === selectedValue || candidate.name === selectedValue
    });
  }
  if (selectedValue && !options.some((item) => item.selected)) options.push({ value: selectedValue, label: `${selectedValue} (вне списка)`, selected: true });
  return options;
},

_templatePrerequisiteOptions(building, selected = "") {
  const selectedValue = String(selected ?? "");
  const data = this._contextData ?? SkyholdData.get();
  const options = [{ value: "", label: "Выбрать", selected: !selectedValue }];
  for (const candidate of data?.catalog?.buildings ?? []) {
    if (!candidate?.id || candidate.id === building?.id) continue;
    const value = String(candidate.id);
    options.push({
      value,
      label: candidate.name || value,
      selected: value === selectedValue || String(candidate.name ?? "") === selectedValue
    });
  }
  if (selectedValue && !options.some((item) => item.selected)) options.push({ value: selectedValue, label: `${selectedValue} (вне списка)`, selected: true });
  return options;
},

_buildingDevelopmentKey(building = {}) {
  const templateId = String(building?.templateId ?? "").trim();
  if (templateId) return `template:${templateId.toLowerCase()}`;
  const name = String(building?.name ?? "").trim().toLowerCase();
  return name ? `name:${name}` : `id:${String(building?.id ?? "")}`;
},

_isDuplicateDevelopmentBuilding(holding, building) {
  if (!building || String(building?.constructionStatus ?? "built") !== "built") return false;
  const b = this._devObject(building?.bonuses);
  const hasBonus = ["food", "technology", "culture", "war"].some((key) => this._safeNumber(b[key], 0) !== 0);
  if (!hasBonus) return false;
  const key = this._buildingDevelopmentKey(building);
  for (const candidate of holding?.buildings?.list ?? []) {
    if (candidate === building) return false;
    if (String(candidate?.constructionStatus ?? "built") !== "built") continue;
    const cb = this._devObject(candidate?.bonuses);
    const candidateHasBonus = ["food", "technology", "culture", "war"].some((devKey) => this._safeNumber(cb[devKey], 0) !== 0);
    if (candidateHasBonus && this._buildingDevelopmentKey(candidate) === key) return true;
  }
  return false;
},

_developmentSummary(holding) {
  const totals = { food: 0, technology: 0, culture: 0, war: 0 };
  const contributors = { food: [], technology: [], culture: [], war: [] };
  const duplicates = [];
  const seen = new Set();
  for (const building of holding?.buildings?.list ?? []) {
    const status = String(building?.constructionStatus ?? "built");
    if (status !== "built") continue;
    const b = this._devObject(building?.bonuses);
    const hasBonus = ["food", "technology", "culture", "war"].some((key) => this._safeNumber(b[key], 0) !== 0);
    if (!hasBonus) continue;
    const devKey = this._buildingDevelopmentKey(building);
    if (seen.has(devKey)) {
      duplicates.push(building.name || "Здание");
      continue;
    }
    seen.add(devKey);
    for (const key of ["food", "technology", "culture", "war"]) {
      const value = this._safeNumber(b[key], 0);
      if (!value) continue;
      totals[key] += value;
      contributors[key].push(`${building.name || "Здание"}: ${value > 0 ? "+" : ""}${value}`);
    }
  }
  const gm = this._gmSettlementModifiers(holding);
  for (const key of ["food", "technology", "culture", "war"]) {
    const mod = this._safeNumber(gm[key], 0);
    if (!mod) continue;
    totals[key] += mod;
    contributors[key].push(`ГМ: ${mod > 0 ? "+" : ""}${mod}`);
  }
  const base = { food: 0, technology: 0, culture: 0, war: 0 };
  const bonus = { ...totals };
  const duplicateText = duplicates.length ? ` Дубликаты без повторного вклада: ${duplicates.join(", ")}.` : "";
  const tooltip = (key, label) => contributors[key].length
    ? `${label} считается только от уникальных построенных зданий: ${contributors[key].join("; ")}. Итого ${totals[key]}.${duplicateText}`
    : `${label}: уникальные построенные здания пока не дают вклад.${duplicateText}`;
  return {
    base,
    bonus,
    totals,
    duplicateText,
    labels: [
      { key: "food", label: "Еда", icon: "fa-solid fa-utensils", css: "food", value: totals.food, base: 0, bonus: totals.food, tooltip: tooltip("food", "Еда") },
      { key: "technology", label: "Технология", icon: "fa-solid fa-wrench", css: "technology", value: totals.technology, base: 0, bonus: totals.technology, tooltip: tooltip("technology", "Технология") },
      { key: "culture", label: "Культура", icon: "fa-solid fa-music", css: "culture", value: totals.culture, base: 0, bonus: totals.culture, tooltip: tooltip("culture", "Культура") },
      { key: "war", label: "Война", icon: "fa-solid fa-shield-halved", css: "war", value: totals.war, base: 0, bonus: totals.war, tooltip: tooltip("war", "Война") }
    ]
  };
},

_devText(dev, fallback = "—") {
  const parts = [];
  if (dev.food) parts.push(`Еда ${dev.food}`);
  if (dev.technology) parts.push(`Тех ${dev.technology}`);
  if (dev.culture) parts.push(`Культ ${dev.culture}`);
  if (dev.war) parts.push(`Война ${dev.war}`);
  return parts.length ? parts.join(" · ") : fallback;
},

_requirementsMet(requirements, totals) {
  return ["food", "technology", "culture", "war"].every((key) => this._safeNumber(totals?.[key], 0) >= this._safeNumber(requirements?.[key], 0));
}
};
