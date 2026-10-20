import { resourceBasePriceCopper } from "../../core/resources.js";
import { productionLineEconomics } from "../../engines/economy/production-economics.js";
import { productionBatchShelfLifeQd } from "../../engines/economy/production-batch-life.js";
import { productionWaitQd } from "../../engines/economy/production-timing.js";

const formatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const format = (value) => formatter.format(value);
const range = (min, max) => min === max ? format(min) : `${format(min)}…${format(max)}`;
const channels = [["base", "Базовая цена"], ["ordinary", "Обычный торговец (50%)"], ["seller", "Квалифицированный торговец"], ["contract", "Цена договора / рынка"]];

function summary(result) {
  if (!result.available) return result.reason;
  return `Партия ${result.qty} ЕД.: выручка ${format(result.revenue)}, сырьё ${range(result.inputMin, result.inputMax)}, труд ${format(result.labor)} ММ. Остаток до содержания и сбыта: ${range(result.marginMin, result.marginMax)} ММ. Содержание здания с этой линией: ${format(result.upkeepMonthly)} ММ/месяц.`;
}

export function prepareProductionEconomics(editor, building) {
  editor._productionEconomicsState ??= new Map();
  editor._productionEconomicsRows = new Map();
  for (const line of building.productionLines ?? []) {
    const state = editor._productionEconomicsState.get(line.id) ?? { channel: "base", unitPrice: resourceBasePriceCopper(line.resourceId), sellerEfficiency: 2, productionEfficiency: 1, batchQty: line.outputQty };
    editor._productionEconomicsState.set(line.id, state);
    editor._productionEconomicsRows.set(line.id, { line, building });
    line.economics = { ...state, channels: channels.map(([value, label]) => ({ value, label, selected: value === state.channel })),
      summary: summary(productionLineEconomics(line, building, state)),
      waitDays: productionWaitQd(line) / 4,
      batchDays: productionBatchShelfLifeQd(line) / 4 };
  }
}

/** Local inputs only: no data-field, socket command, or world-setting writes. */
export function bindProductionEconomics(editor, root) {
  for (const panel of root.querySelectorAll("[data-production-economics]")) {
    const id = panel.dataset.productionEconomics;
    const model = editor._productionEconomicsRows?.get(id);
    if (!model) continue;
    const state = editor._productionEconomicsState.get(id);
    const update = () => {
      for (const control of panel.querySelectorAll("[data-economics-input]")) {
        const key = control.dataset.economicsInput;
        state[key] = key === "channel" ? control.value : Number(control.value);
      }
      panel.querySelector("[data-economics-result]").textContent = summary(productionLineEconomics(model.line, model.building, state));
      panel.querySelector('[data-economics-input="unitPrice"]').disabled = state.channel !== "contract";
      panel.querySelector('[data-economics-input="sellerEfficiency"]').disabled = state.channel !== "seller";
    };
    for (const control of panel.querySelectorAll("[data-economics-input]")) control.addEventListener("input", update);
    update();
  }
}
