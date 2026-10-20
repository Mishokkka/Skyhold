import { buildingCatalogV16Templates } from "./building-template-revision-v16.js";
import { internalDemandTradeDefaults } from "./economy/internal-demand.js";

// Mandatory minimum: a craft can run at low throughput with one practitioner;
// mines, hot furnaces and industrial lines retain a team for handling and safety.
export const ECONOMY_MINIMUM_STAFF = Object.freeze({
  mill: 1, tannery: 1, bakery: 1, "oil-press": 1, cheesery: 1, smokehouse: 1,
  brewery: 2, winery: 2, distillery: 2, "weaving-workshop": 1,
  "carpentry-workshop": 1, soapworks: 2, "writing-workshop": 1, "tailor-shop": 1,
  apothecary: 1, brickworks: 4, mine: 6, glassworks: 3, "tool-workshop": 2,
  forge: 2, "printing-house": 4, cannery: 6, "greenhouse-complex": 2
});

export function buildingCatalogV17Templates() {
  return buildingCatalogV16Templates().map((source) => {
    const row = structuredClone(source);
    row.templateVersion = 17;
    for (const line of row.productionLines ?? []) line.storageRoomId = "auto";
    if (row.agriculture) row.agriculture.outputRoomId = "auto";
    if (row.livestock) row.livestock.outputRoomId = "auto";
    if (row.storage) row.storage.autoReceive = true;
    const minimum = ECONOMY_MINIMUM_STAFF[row.id];
    if (minimum !== undefined) {
      row.workersMin = minimum;
      if (row.workerProfile) row.workerProfile.workersMin = minimum;
      if (row.activation?.minWorkers) row.activation.minWorkers = minimum;
    }
    if (row.income?.trade?.enabled) {
      const defaults = internalDemandTradeDefaults(row);
      row.income.trade = { ...row.income.trade,
        demandBudgetBaseCopper: defaults.demandBudgetBaseCopper,
        demandBudgetPerWorkerCopper: defaults.demandBudgetPerWorkerCopper,
        service: { ...row.income.trade.service, basePriceCopper: defaults.service.basePriceCopper } };
    }
    if (row.agriculture) for (const crop of row.agriculture.crops ?? []) {
      if (row.id === "grain-field") { crop.sowingWorkQd = 24; crop.harvestWorkQd = 56; }
      if (row.id === "garden") { crop.sowingWorkQd = 12; crop.harvestWorkQd = 28; }
      if (row.id === "vineyard") { crop.sowingWorkQd = 32; crop.harvestWorkQd = 48; crop.perennial = true; }
      if (row.id === "hop-yard") { crop.sowingWorkQd = 16; crop.harvestWorkQd = 40; crop.perennial = true; }
      if (row.id === "garden" && crop.id === "fruits") crop.perennial = true;
    }
    if (row.id === "grain-field") row.description = (row.description ?? "") + " Ручная обработка: 24 QD посева и 56 QD уборки за год.";
    if (row.id === "cannery") for (const line of row.productionLines ?? []) {
      const protein = /meat|fish/.test(line.expenses ?? "");
      const fruit = /fruits/.test(line.expenses ?? "");
      line.resourceId = protein ? "canned-protein" : fruit ? "canned-fruit" : "canned-vegetables";
      line.resource = protein ? "Белковые консервы" : fruit ? "Фруктовые консервы" : "Овощные консервы";
      line.outputQty = protein ? 16 : 20;
    }
    return row;
  });
}
