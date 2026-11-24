import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resourceLabel } from "../core/resources.js";
import { DEFAULT_BUILDING_TEMPLATES, TEMPLATE_CATALOG_VERSION } from "../data/building-templates.js";

const rows = DEFAULT_BUILDING_TEMPLATES;
assert.equal(rows.length, 126);
const names = new Map(rows.map((row) => [row.id, row.name]));
const vec = (value = {}) => ["food", "technology", "culture", "war"].map((key) => value[key] ?? 0).join("/");
const safe = (value = "") => String(value).replaceAll("\n", " ").replaceAll("\r", "").trim();
const sentence = (value = "") => (value.endsWith(".") ? value : `${value}.`);

const FUNCTIONS = {
  production: "производство",
  income: "доход",
  defense: "оборона",
  housing: "жильё",
  storage: "склад",
  culture: "служба"
};
const SEASONS = { spring: "весна", summer: "лето", autumn: "осень", winter: "зима" };
const LEISURE_KINDS = { gathering: "общение", feast: "трапеза", games: "игры", spectacle: "представления", bath: "баня", park: "прогулки", stage: "театр", museum: "музей" };
const SOURCE_LABELS = { workers: "труд", time: "время", content: "содержимое" };
const COVERAGE_LABELS = { population: "население", buildings: "здания", targeted: "адресная", settlement: "поселение" };

function formatService(service) {
  if (!service) return "";
  const parts = [];
  if (service.capacity) parts.push(`охват ${service.capacity}`);
  if (service.capacityBase) parts.push(`база ${service.capacityBase}`);
  if (service.capacityPerWorker) parts.push(`+${service.capacityPerWorker}/раб.`);
  if (service.capacityPerWorkerStep && service.workerStep) parts.push(`+${service.capacityPerWorkerStep} за ${service.workerStep} раб.`);
  if (service.maximumCapacity) parts.push(`макс. ${service.maximumCapacity}`);
  if (service.coverageKind) parts.push(`тип: ${COVERAGE_LABELS[service.coverageKind] ?? service.coverageKind}`);
  if (service.coveredBuildingIds?.length) parts.push(`объекты: ${service.coveredBuildingIds.map((id) => names.get(id) ?? id).join(", ")}`);
  if (service.leisure) {
    const l = service.leisure;
    parts.push(`досуг (${LEISURE_KINDS[l.kind] ?? l.kind}): мощн. ${l.capacity}, ${l.qdPerCapacity} QD/ед., мин. раб. ${l.minWorkers ?? 0}`);
  }
  return parts.join("; ");
}

function formatControl(control) {
  if (!control) return "";
  const parts = [];
  if (control.generalFlat) parts.push(`общий +${control.generalFlat}`);
  if (control.generalPerWorker) parts.push(`+${control.generalPerWorker}/раб.`);
  if (control.unrestOnlyFlat) parts.push(`от беспорядков +${control.unrestOnlyFlat}`);
  if (control.ceiling) parts.push(`потолок ${control.ceiling}`);
  if (control.maximum) parts.push(`макс. ${control.maximum}`);
  if (control.capacity) parts.push(`охват ${control.capacity}`);
  return parts.join("; ");
}

function formatHousing(housing) {
  if (!housing) return "";
  const parts = [`мест ${housing.capacity ?? 0}`, `качество ${housing.quality ?? 0}`];
  if (housing.comfort) parts.push(`комфорт ${housing.comfort}`);
  if (housing.staffedComfort) parts.push(`при штате ${housing.staffedComfort}`);
  if (housing.notes) parts.push(safe(housing.notes));
  return parts.join("; ");
}

function formatDefense(defense) {
  if (!defense) return "";
  const parts = [];
  if (defense.base) parts.push(`база +${defense.base}`);
  if (defense.perStep && defense.workerStep) parts.push(`+${defense.perStep} за каждые ${defense.workerStep} раб.`);
  return parts.join("; ");
}

function formatStorage(storage) {
  if (!storage) return "";
  const parts = [`вместимость ${storage.capacity ?? 0}`];
  if (storage.shelfLifeMultiplier && storage.shelfLifeMultiplier !== 1) parts.push(`срок ×${storage.shelfLifeMultiplier}`);
  if (storage.security) parts.push(`охрана ${storage.security}`);
  if (storage.quality) parts.push(`качество ${storage.quality}`);
  if (storage.autoReceive === false) parts.push("без автоприёма");
  const hasProfile = Boolean(
    storage.profileLabel
    || storage.profilePerishableFood
    || storage.profileCategoryTags?.length
    || storage.profileMarketTags?.length
    || storage.profileResourceIds?.length
    || (storage.profileCapacityMultiplier && storage.profileCapacityMultiplier !== 1)
    || storage.profileRequiresStaff
  );
  if (hasProfile) {
    const scope = [];
    if (storage.profileLabel) scope.push(safe(storage.profileLabel));
    if (storage.profilePerishableFood && !storage.profileLabel) scope.push("скоропортящаяся пища");
    if (storage.profileCategoryTags?.length) scope.push(`категории: ${storage.profileCategoryTags.join(", ")}`);
    if (storage.profileMarketTags?.length) scope.push(`теги: ${storage.profileMarketTags.join(", ")}`);
    if (storage.profileResourceIds?.length) scope.push(`ресурсы: ${storage.profileResourceIds.join(", ")}`);
    const mult = storage.profileCapacityMultiplier && storage.profileCapacityMultiplier !== 1 ? ` (×${storage.profileCapacityMultiplier} нагрузки)` : "";
    const staff = storage.profileRequiresStaff ? ", нужен штат" : "";
    parts.push(`профиль: ${scope.join("; ") || "специализированный"}${mult}${staff}`);
  }
  return parts.join("; ");
}

function formatIncome(income) {
  if (!income) return "";
  const parts = [];
  if (income.base) parts.push(`база ${income.base} ММ`);
  if (income.perWorker) parts.push(`+${income.perWorker} ММ/раб.`);
  if (income.formula) parts.push(`формула: ${safe(income.formula)}`);
  if (income.trade?.enabled) {
    const t = income.trade;
    const sources = (t.sourceIds ?? []).join("+") || t.demandSource || "—";
    const budget = [t.demandBudgetBaseCopper ? `база ${t.demandBudgetBaseCopper}` : "", t.demandBudgetPerWorkerCopper ? `+${t.demandBudgetPerWorkerCopper}/раб.` : ""].filter(Boolean).join(" ");
    parts.push(`торговля (${sources}${budget ? `, бюджет ${budget} ММ` : ""}, пропуск ${t.throughputUnitsPerWorker ?? 0} ед./раб.)`);
    if (t.service?.enabled) {
      parts.push(`услуга ${t.service.categoryTag || "—"}: ${t.service.basePriceCopper} ММ × ${t.service.unitsPerWorker}/раб.`);
    }
  }
  if (income.wageDailyCopper) parts.push(`ставка ${income.wageDailyCopper} ММ/д`);
  if (income.operatingUpkeepMonthlyCopper) parts.push(`экспл. ${income.operatingUpkeepMonthlyCopper} ММ/мес`);
  if (income.illegal) parts.push("нелегально");
  return parts.join("; ");
}

function formatProductionLine(line) {
  const name = safe(line.name || line.resource || line.resourceId || line.id);
  const outputLabel = line.resourceId && line.resourceId !== "custom"
    ? resourceLabel(line.resourceId)
    : (line.resource || line.resourceId);
  const out = `${line.outputQty ?? 0} ${safe(outputLabel)}`;
  const timing = [];
  if (line.source) timing.push(SOURCE_LABELS[line.source] ?? line.source);
  if (line.workQd) timing.push(`${line.workQd} QD`);
  if (line.waitDays) timing.push(`выдержка ${line.waitDays} д.`);
  if (line.collectQd) timing.push(`сбор ${line.collectQd} QD`);
  if (line.batchCapacity) timing.push(`вмест. ${line.batchCapacity}${line.batchStartQty ? ` (от ${line.batchStartQty})` : ""}`);
  const expenses = safe(line.expenses || line.costsText);
  const mode = expenses && line.expenseMode === "perUnit" ? " [на ед.]" : "";
  const extra = [];
  if (line.wageDailyCopper) extra.push(`ставка ${line.wageDailyCopper}`);
  if (line.requiresGmConfirmation) extra.push("подтв. ГМ");
  if (line.active === false) extra.push("выкл. по умолч");
  return `${name} → **${out}** (${timing.join(", ")})${expenses ? `; сырьё${mode}: ${expenses}` : ""}${extra.length ? `; ${extra.join(", ")}` : ""}`;
}

function formatAgriculture(ag) {
  if (!ag?.crops?.length) return "";
  return ag.crops.map((crop) => {
    const seasons = (crop.sowingSeasons ?? []).map((s) => SEASONS[s] ?? s).join("/");
    const flags = [
      crop.perennial ? "многолетн." : "",
      crop.annualHarvestLimit ? `лимит ${crop.annualHarvestLimit}/год` : "",
      crop.readyExpiryQd ? `срок готовности ${crop.readyExpiryQd} QD` : ""
    ].filter(Boolean).join(", ");
    return `${safe(crop.label)} → ${crop.outputQty} (посев ${seasons}: ${crop.sowingWorkQd} QD, рост ${crop.growingQd} QD, сбор ${crop.harvestWorkQd} QD${flags ? `, ${flags}` : ""})`;
  }).join("; ");
}

function formatLivestock(livestock) {
  if (!livestock?.enabled) return "";
  const options = (livestock.speciesOptions ?? [livestock.speciesId]).filter(Boolean).join(", ");
  const profile = livestock.profile ?? {};
  const details = [];
  if (profile.capacity) details.push(`вмест. ${profile.capacity}`);
  if (profile.headsPerFeedUnit) details.push(`корм 1 ед./${profile.headsPerFeedUnit} гол.`);
  if (profile.maturityQd) details.push(`рост ${profile.maturityQd} QD`);
  if (profile.woolPerHead) details.push(`шерсть ${profile.woolPerHead}/гол.`);
  return `виды: ${options || "—"} (по умолч. ${livestock.speciesId || "—"})${details.length ? `; ${details.join(", ")}` : ""}`;
}

let text = `# Каталог зданий v${TEMPLATE_CATALOG_VERSION}\n\n`
  + `Автогенерируемый справочник встроенного каталога (${rows.length} шаблонов: 124 дерева и 2 сюжетных). Источник — \`scripts/data/building-templates.js\`. Обновление: \`node scripts/dev/build-building-catalog-reference.mjs\` (сверка: \`--check\`). Маршрут открытия конкретного здания: \`node scripts/dev/building-development-reachability-check.mjs --route <id>\`. Сохранённые миры не меняются автоматически — см. [переходы](migrations.md).\n\n`
  + `Обозначения: П/Т/К/В — Пища/Технология/Культура/Война; деньги — ММ (содержание за месяц, ставка за день); труд v2 — единая вместимость QD за десятник («без работников», «лимит N QD» или «без лимита QD»); нулевые и пустые блоки опущены. Правила: [экономика](economy-contract.md), [труд](labor-contract.md), [службы](building-social-contract.md).\n\n`;

for (const row of rows) {
  const visTag = row.visibility && row.visibility !== "public" ? ` · видимость: ${row.visibility === "gm" ? "только ГМ" : row.visibility}` : "";
  text += `## ${safe(row.name)}\n\n`;
  text += `\`${row.id}\` · ${safe(row.type)} · этап ${row.developmentStage ?? "сюжетный"} · треб. **${vec(row.requirements)}** · разв. **${vec(row.bonuses)}**${visTag}\n\n`;

  const materials = (row.materialCosts ?? []).map((cost) => `${safe(cost.name || cost.resourceId)} ${cost.qty}`).join(", ") || "нет";
  text += `- **Стройка:** ${row.buildTarget ?? 0} эт., сл. ${row.buildDifficulty ?? 0}; материалы: ${materials}.\n`;

  const capacityQd = row.labor?.capacityQd;
  const laborSummary = capacityQd === 0
    ? "без работников"
    : capacityQd == null
      ? "без лимита QD"
      : `лимит ${capacityQd} QD`;
  text += `- **Труд и расходы:** ${laborSummary}, ставка ${row.wageDailyCopper ?? 0}; содерж. ${row.baseUpkeepMonthlyCopper ?? 0}/${row.operatingUpkeepMonthlyCopper ?? 0}.\n`;

  const fnList = Object.entries(FUNCTIONS).filter(([key]) => row.functions?.[key]).map(([, label]) => label).join(", ") || "нет";
  const social = [row.reputation ?? 0, row.moraleDelta ?? 0, row.workerMoraleDelta ?? 0];
  const socialStr = social.some((n) => n !== 0) ? `; Реп/Дов/Труд: ${social.join("/")}` : "";
  const exclusiveStr = row.productionSelection?.exclusive ? "; выбор линии: одна активная" : "";
  text += `- **Функции:** ${fnList}${socialStr}${exclusiveStr}.\n`;

  if ((row.activation?.minOperationalQd ?? 0) > 0 || row.activation?.requiresMeaningfulResult) {
    text += `- **Активация:** порог ${row.activation?.minOperationalQd ?? 0} QD (0%/100%)${row.activation?.requiresMeaningfulResult ? ", нужен результат" : ""}.\n`;
  }

  const dependency = (id) => {
    const mode = row.prerequisiteModes?.[id];
    const tag = mode === "construction" ? "проект" : mode === "service" ? "служба" : "наличие";
    return `${names.get(id) ?? id} (${tag})`;
  };
  const deps = [
    ...(row.requiredBuildingIds ?? []).map(dependency),
    ...(row.requiredAnyBuildingIds?.length ? [`одно из: ${row.requiredAnyBuildingIds.map(dependency).join(" ИЛИ ")}`] : []),
    ...(row.requiresConstructionCenter ? ["Центр Строительства"] : []),
    ...(row.upgradesFromTemplateIds?.length ? [`улучшение из: ${row.upgradesFromTemplateIds.map((id) => names.get(id) ?? id).join(", ")}`] : [])
  ];
  if (deps.length) text += `- **Зависимости:** ${deps.join("; ")}.\n`;

  if (row.specialRequirements || row.siteRequirementsText) {
    text += `- **Участок:** ${safe(row.siteRequirementsText || row.specialRequirements)}\n`;
  }

  if (row.workerProfile) {
    const admission = safe(row.workerProfile.admission?.text || "");
    const composition = (row.workerProfile.composition ?? [])
      .map((part) => `${part.count} × ${safe(part.backgrounds?.join(" / ") || part.group || "—")}`)
      .join("; ");
    const reason = safe(row.workerProfile.reason);
    const parts = [admission && admission !== "—" ? admission : "", composition ? `состав: ${composition}` : "", reason].filter(Boolean);
    if (parts.length) text += `- **Кадры:** ${parts.join(". ")}\n`;
  }

  const serviceText = formatService(row.service);
  if (serviceText) text += `- **Услуга:** ${sentence(serviceText)}\n`;
  const controlText = formatControl(row.control);
  if (controlText) text += `- **Контроль:** ${sentence(controlText)}\n`;
  const defenseText = formatDefense(row.defense);
  if (defenseText) text += `- **Оборона:** ${sentence(defenseText)}\n`;
  if (row.functions?.housing) {
    const housingText = formatHousing(row.housing);
    if (housingText) text += `- **Жильё:** ${sentence(housingText)}\n`;
  }
  if (row.functions?.storage) {
    const storageText = formatStorage(row.storage);
    if (storageText) text += `- **Склад:** ${sentence(storageText)}\n`;
  }
  if (row.functions?.income) {
    const incomeText = formatIncome(row.income);
    if (incomeText) text += `- **Доход:** ${sentence(incomeText)}\n`;
  }
  for (const line of row.productionLines ?? []) {
    text += `- **Производство:** ${sentence(formatProductionLine(line))}\n`;
  }
  const agText = formatAgriculture(row.agriculture);
  if (agText) text += `- **Земледелие:** ${sentence(agText)}\n`;
  const liveText = formatLivestock(row.livestock);
  if (liveText) text += `- **Животные:** ${sentence(liveText)}\n`;

  const prose = [safe(row.description), safe(row.effect), safe(row.notes)].filter(Boolean).join(" ");
  if (prose) text += `\n${prose}\n`;
  text += "\n";
}

const destination = new URL("../../docs/building-catalog.md", import.meta.url);
if (process.argv.includes("--check")) {
  assert.equal(readFileSync(destination, "utf8"), text, "The canonical building reference must match runtime data");
} else {
  writeFileSync(destination, text);
}
console.log(`Building reference v${TEMPLATE_CATALOG_VERSION}: ${rows.length} templates.`);
