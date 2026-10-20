import { stableDataHash } from "../../data/storage-commit.js";
import { clone } from "../../data/utils.js";
import { normalizeBuilding } from "../../data/normalizers/building.js";

const FIELDS = {
  requirements: "Требования развития", bonuses: "Развитие", materialCosts: "Материалы строительства",
  buildDifficulty: "Сложность строительства", buildTarget: "Этапы строительства",
  workersMin: "Минимальный штат", workersMax: "Максимальный штат", workerProfile: "Допуск работников",
  wageDailyCopper: "Дневная ставка", baseUpkeepMonthlyCopper: "Базовое содержание",
  operatingUpkeepMonthlyCopper: "Эксплуатационное содержание", functions: "Функции",
  activation: "Условия активации", service: "Общественная услуга", control: "Контроль",
  reputation: "Репутация", moraleDelta: "Довольство", workerMoraleDelta: "Условия труда",
  requiredBuildingIds: "Обязательные здания", requiredAnyBuildingIds: "Альтернативные здания",
  prerequisiteModes: "Фазы зависимостей", housing: "Жильё", storage: "Вместимость склада",
  productionLines: "Производственные линии", income: "Доходная функция"
};

export const PRODUCTION_STATE_FIELDS = Object.freeze([
  "active", "autoCollect", "storageRoomId", "pendingQty", "workProgressUnits",
  "workInputsReserved", "workReservedOutputQty", "workReservedFormula", "workReservedInputs", "productionBonusRemainder", "waitingBatches"
]);

function mechanicalValue(field, value) {
  if (field !== "productionLines" || !Array.isArray(value)) return value;
  return value.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !PRODUCTION_STATE_FIELDS.includes(key))));
}

// A difference from the known source template is ambiguous, not proof of a
// deliberate customization. Require a local choice bound to both values.
export function resolveCatalogMechanicalConflicts({ source, baseline, target, scope, resolutions = {}, issues, decisions }) {
  if (!baseline) return;
  const normalized = [source, baseline, target].map((row) => {
    const copy = clone(row);
    normalizeBuilding(copy, { mode: "load", destructive: false, preserveTemplateMechanics: true });
    return copy;
  });
  for (const [field, label] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(source, field)) continue;
    if (stableDataHash(mechanicalValue(field, normalized[0][field])) === stableDataHash(mechanicalValue(field, normalized[1][field]))
      || stableDataHash(mechanicalValue(field, normalized[0][field])) === stableDataHash(mechanicalValue(field, normalized[2][field]))) continue;
    const resolutionKey = stableDataHash({ scope, field, before: source[field], after: target[field] });
    const choice = resolutions[resolutionKey];
    if (["keep-mechanics", "replace-mechanics"].includes(choice)) {
      if (choice === "keep-mechanics") target[field] = clone(source[field]);
      decisions.push({ resolutionKey, detail: `${scope.name}: ${label} — ${choice === "keep-mechanics" ? "сохранить прежнее значение" : "принять новую редакцию"}.` });
    } else issues.push({ code: "mechanical-override", resolutionKey, canResolveMechanics: true,
      buildingId: scope.id, buildingName: scope.name, detail: `${label}: сохранённое значение отличается от исходного шаблона. Требуется выбор.`,
      beforeText: JSON.stringify(source[field]), afterText: JSON.stringify(target[field]) });
  }
}
