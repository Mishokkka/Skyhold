const CAPITAL_BY_TEMPLATE = Object.freeze({
  "grain-field": Object.freeze({
    landCopper: 5600,
    equipmentCopper: 600,
    workingCapitalCopper: 600,
    renewalPercentAnnual: 10,
    notes: "Права на пашню, плуг и упряжь, семенной фонд и запас на один производственный цикл."
  }),
  garden: Object.freeze({
    landCopper: 4500,
    equipmentCopper: 600,
    workingCapitalCopper: 500,
    renewalPercentAnnual: 10,
    notes: "Земельные права, многолетние посадки, ручной инвентарь, семена и сезонный оборотный запас."
  }),
  pasture: Object.freeze({
    landCopper: 1800,
    equipmentCopper: 300,
    workingCapitalCopper: 600,
    renewalPercentAnnual: 10,
    notes: "Пастбищные права, молочный инвентарь и запас подкормки. Коровы приобретаются на рынке и размещаются из склада."
  }),
  pigsty: Object.freeze({
    landCopper: 800,
    equipmentCopper: 300,
    workingCapitalCopper: 800,
    renewalPercentAnnual: 15,
    notes: "Двор и выгул, разделочный инвентарь и кормовой запас. Свиньи приобретаются на рынке и размещаются из склада."
  }),
  sheepfold: Object.freeze({
    landCopper: 1600,
    equipmentCopper: 250,
    workingCapitalCopper: 500,
    renewalPercentAnnual: 6,
    notes: "Пастбищные права, инвентарь для стрижки и кормовой резерв. Овцы приобретаются на рынке и размещаются из склада."
  }),
  "goat-pen": Object.freeze({
    landCopper: 1000,
    equipmentCopper: 220,
    workingCapitalCopper: 400,
    renewalPercentAnnual: 8,
    notes: "Права на выпас, молочный инвентарь и кормовой резерв. Козы приобретаются на рынке и размещаются из склада."
  }),
  "poultry-yard": Object.freeze({
    landCopper: 350,
    equipmentCopper: 180,
    workingCapitalCopper: 250,
    renewalPercentAnnual: 12,
    notes: "Малый двор, гнёзда, кормушки и запас зерна. Куры и гуси приобретаются на рынке и размещаются из склада."
  }),
  rabbitry: Object.freeze({
    landCopper: 250,
    equipmentCopper: 200,
    workingCapitalCopper: 300,
    renewalPercentAnnual: 15,
    notes: "Клети, кормушки и запас корма. Кролики приобретаются на рынке и размещаются из склада."
  }),
  inn: Object.freeze({
    landCopper: 600,
    equipmentCopper: 400,
    workingCapitalCopper: 400,
    renewalPercentAnnual: 10,
    notes: "Право вести постоялый двор, мебель, посуда, бельё, топливо и кассовый запас закупок."
  }),
  market: Object.freeze({
    landCopper: 1000,
    equipmentCopper: 400,
    workingCapitalCopper: 1200,
    renewalPercentAnnual: 8,
    notes: "Права на торговую площадь, весы и прилавки, разменная касса и краткий товарный кредит."
  }),
  bathhouse: Object.freeze({
    landCopper: 400,
    equipmentCopper: 1600,
    workingCapitalCopper: 500,
    renewalPercentAnnual: 8,
    notes: "Право на водопользование, котлы, баки и банная оснастка, запас топлива, белья и разменной монеты."
  }),
  apothecary: Object.freeze({
    landCopper: 300,
    equipmentCopper: 2000,
    workingCapitalCopper: 1500,
    renewalPercentAnnual: 10,
    notes: "Право аптекарской практики, ступки, весы, перегонная и сушильная оснастка, запас трав, тары и денег на закупки."
  }),
  lumbermill: Object.freeze({
    landCopper: 6500,
    equipmentCopper: 600,
    workingCapitalCopper: 600,
    renewalPercentAnnual: 12,
    notes: "Лесные права, ручные пилы и подъёмная оснастка, запас инструмента и средства на вывоз товарной древесины."
  }),
  quarry: Object.freeze({
    landCopper: 5500,
    equipmentCopper: 900,
    workingCapitalCopper: 600,
    renewalPercentAnnual: 15,
    notes: "Право разработки, клинья, лебёдки и измерительный инструмент, а также оборотный запас на вывоз блоков."
  }),
  mine: Object.freeze({
    landCopper: 10000,
    equipmentCopper: 2000,
    workingCapitalCopper: 1500,
    renewalPercentAnnual: 15,
    notes: "Горная концессия, водоотлив, вагонетки, лампы и аварийный инструмент, запас крепи и оборотные средства."
  }),
  forge: Object.freeze({
    landCopper: 1000,
    equipmentCopper: 4500,
    workingCapitalCopper: 4500,
    renewalPercentAnnual: 15,
    notes: "Право на огнеопасное производство, меха, наковальни и сменная оснастка, запас руды, угля и денег на заказы."
  }),
  tannery: Object.freeze({
    landCopper: 1500,
    equipmentCopper: 2500,
    workingCapitalCopper: 6000,
    renewalPercentAnnual: 12,
    notes: "Право на водоём и сток, дубильные чаны, ножи и рамы, запас шкур, коры, топлива и денег на длительный цикл выделки."
  }),
  "tailor-shop": Object.freeze({
    landCopper: 500,
    equipmentCopper: 3000,
    workingCapitalCopper: 4500,
    renewalPercentAnnual: 12,
    notes: "Мастерская, ткацкие станки, прялки и отделочная оснастка, запас шерсти, красителей и денег на заказы."
  })
});

const CAPITAL_SCHEMA_BY_TEMPLATE = Object.freeze({
  "grain-field": 76,
  garden: 76,
  pasture: 76,
  pigsty: 76,
  sheepfold: 76,
  "goat-pen": 89,
  "poultry-yard": 89,
  rabbitry: 89,
  inn: 76,
  market: 76,
  bathhouse: 81,
  apothecary: 81,
  lumbermill: 78,
  quarry: 78,
  mine: 78,
  forge: 78,
  tannery: 79,
  "tailor-shop": 79
});

export const ENTERPRISE_CAPITAL_TEMPLATE_IDS = Object.freeze(Object.keys(CAPITAL_BY_TEMPLATE));

export function enterpriseCapitalSchemaVersionForTemplate(templateId = "") {
  return CAPITAL_SCHEMA_BY_TEMPLATE[String(templateId ?? "")] ?? 76;
}

export function enterpriseCapitalForTemplate(templateId = "", { funded = false } = {}) {
  const source = CAPITAL_BY_TEMPLATE[String(templateId ?? "")];
  if (!source) return null;
  const required = source.landCopper + source.equipmentCopper + source.workingCapitalCopper;
  return {
    version: 2,
    enabled: true,
    ...source,
    commissioningPaidCopper: funded ? source.equipmentCopper : 0,
    workingCapitalReserveCopper: 0,
    fundingProvenance: funded ? "legacy-grandfathered" : "treasury",
    legacyGrandfathered: Boolean(funded),
    fundedCopper: funded ? required : 0
  };
}
