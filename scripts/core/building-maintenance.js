export const BUILDING_MAINTENANCE_CLASS_RATES = Object.freeze({
  none: 0,
  minimal: 2,
  standard: 5,
  heavy: 10,
  monumental: 20,
  exceptional: 40
});

export const BUILDING_MAINTENANCE_CLASSES = Object.freeze([
  Object.freeze({ value: "none", label: "Не требует · 0 ММ/десятник", copperPerTenday: 0 }),
  Object.freeze({ value: "minimal", label: "Минимальное · 2 ММ/десятник", copperPerTenday: 2 }),
  Object.freeze({ value: "standard", label: "Обычное · 5 ММ/десятник", copperPerTenday: 5 }),
  Object.freeze({ value: "heavy", label: "Тяжёлое · 10 ММ/десятник", copperPerTenday: 10 }),
  Object.freeze({ value: "monumental", label: "Монументальное · 20 ММ/десятник", copperPerTenday: 20 }),
  Object.freeze({ value: "exceptional", label: "Исключительное · 40 ММ/десятник", copperPerTenday: 40 }),
  Object.freeze({ value: "custom", label: "Наследуемое пользовательское", copperPerTenday: null, legacyOnly: true })
]);

const CLASS_VALUES = new Set(BUILDING_MAINTENANCE_CLASSES.map((row) => row.value));

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeBuildingMaintenance(source = null, legacyUpkeep = 0, safeNumber = number) {
  const row = source && typeof source === "object" && !Array.isArray(source) ? source : null;
  const legacy = Math.max(0, safeNumber(legacyUpkeep, 0));
  const maintenanceClass = String(row?.class ?? row?.maintenanceClass ?? (row ? "custom" : (legacy > 0 ? "custom" : "none")));
  const version = Math.max(1, Math.floor(safeNumber(row?.version, 1)));
  const fixedRate = BUILDING_MAINTENANCE_CLASS_RATES[maintenanceClass];
  const fixedTenday = version >= 2 && Number.isInteger(fixedRate);
  const legacyOperating = Math.max(0, safeNumber(row?.operatingCopperMonthly ?? row?.operatingMonthly ?? (row ? 0 : legacy), 0));
  const legacyReserve = Math.max(0, safeNumber(row?.repairReserveCopperMonthly ?? row?.reserveMonthly ?? 0, 0));
  const copperPerTenday = fixedTenday ? fixedRate : null;
  return {
    version: fixedTenday ? 2 : version,
    class: CLASS_VALUES.has(maintenanceClass) ? maintenanceClass : "custom",
    billingMode: fixedTenday ? "fixed-tenday" : "legacy-monthly",
    copperPerTenday,
    operatingCopperMonthly: fixedTenday ? copperPerTenday * 3 : legacyOperating,
    repairReserveCopperMonthly: fixedTenday ? 0 : legacyReserve,
    notes: String(row?.notes ?? "")
  };
}

export function buildingMaintenanceState(building = {}, safeNumber = number) {
  const maintenance = normalizeBuildingMaintenance(building?.maintenance, building?.upkeep, safeNumber);
  const operatingCopperMonthly = maintenance.operatingCopperMonthly;
  const repairReserveCopperMonthly = maintenance.repairReserveCopperMonthly;
  return {
    ...maintenance,
    operatingCopperMonthly,
    repairReserveCopperMonthly,
    totalCopperMonthly: operatingCopperMonthly + repairReserveCopperMonthly,
    legacyMonthlyBilling: maintenance.billingMode === "legacy-monthly"
  };
}

export function upkeepOperationalFactor(overdueTendays = 0, safeNumber = number) {
  const overdue = Math.max(0, Math.floor(safeNumber(overdueTendays, 0)));
  if (overdue >= 3) return 0;
  if (overdue === 2) return 0.5;
  if (overdue === 1) return 0.75;
  return 1;
}

export function buildingMaintenanceClassOptions(selected = "custom") {
  return BUILDING_MAINTENANCE_CLASSES.map((row) => ({ ...row, selected: row.value === selected }));
}
