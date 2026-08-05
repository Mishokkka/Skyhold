import { buildingOperationalState } from "../../core/building-state.js";

const EPSILON = 0.0001;
const DEVELOPMENT_LABELS = Object.freeze({
  food: "Еда",
  technology: "Технологии",
  culture: "Культура",
  war: "Война"
});
const MODIFIER_LABELS = Object.freeze({
  food: "Еда",
  technology: "Технологии",
  culture: "Культура",
  war: "Война",
  defense: "Оборона",
  reputation: "Репутация",
  morale: "Мораль"
});
const RESIDENT_ATTRIBUTE_LABELS = Object.freeze({
  strength: "Сила",
  agility: "Ловкость",
  wits: "Разум",
  empathy: "Эмпатия"
});

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultFormatNumber(value = 0) {
  const number = finiteNumber(value, 0);
  if (Number.isInteger(number)) return String(number);
  return String(Number(number.toFixed(2)));
}

function changedNumber(before, after) {
  return Math.abs(finiteNumber(after, 0) - finiteNumber(before, 0)) > EPSILON;
}

function direction(delta = 0) {
  const value = finiteNumber(delta, 0);
  if (value > EPSILON) return "up";
  if (value < -EPSILON) return "down";
  return "same";
}

function numberChange(key, label, before, after, formatNumber = defaultFormatNumber) {
  const oldValue = finiteNumber(before, 0);
  const nextValue = finiteNumber(after, 0);
  const delta = nextValue - oldValue;
  return {
    key,
    label,
    before: oldValue,
    after: nextValue,
    delta,
    direction: direction(delta),
    beforeText: formatNumber(oldValue),
    afterText: formatNumber(nextValue),
    deltaText: `${delta > EPSILON ? "+" : ""}${formatNumber(delta)}`
  };
}

function textChange(key, label, before, after) {
  return {
    key,
    label,
    before: String(before ?? ""),
    after: String(after ?? ""),
    direction: "changed"
  };
}

function resourceIdentity(row = {}) {
  const resourceId = String(row?.resourceId ?? "custom") || "custom";
  const name = String((row?.name ?? row?.label ?? resourceId) || "Ресурс").trim() || "Ресурс";
  const roomId = String(row?.roomId ?? row?.storageRoomId ?? "outdoors") || "outdoors";
  const customName = resourceId === "custom" ? name.toLocaleLowerCase("ru") : "";
  return { key: `${resourceId}\u0000${customName}\u0000${roomId}`, resourceId, name, roomId };
}

function resourceIndex(holding = {}) {
  const rows = new Map();
  for (const row of holding?.storage?.resources ?? []) {
    const identity = resourceIdentity(row);
    const current = rows.get(identity.key) ?? { ...identity, qty: 0, source: row };
    current.qty += finiteNumber(row?.qty ?? row?.quantity, 0);
    if (!current.name && row?.name) current.name = String(row.name);
    rows.set(identity.key, current);
  }
  return rows;
}

function itemIdentity(row = {}, index = 0) {
  const id = String(row?.id ?? "").trim();
  const uuid = String(row?.itemUuid ?? "").trim();
  const name = String(row?.name ?? row?.itemData?.name ?? "Предмет").trim() || "Предмет";
  const roomId = String(row?.roomId ?? row?.storageRoomId ?? "outdoors") || "outdoors";
  const fallback = `${uuid}\u0000${name.toLocaleLowerCase("ru")}\u0000${roomId}\u0000${index}`;
  return { key: id || fallback, id, name, roomId };
}

function itemQuantity(row = {}) {
  return Math.max(0, finiteNumber(row?.qty ?? row?.quantity ?? row?.itemData?.system?.quantity, 0));
}

function itemIndex(holding = {}) {
  const rows = new Map();
  (holding?.storage?.items ?? []).forEach((row, index) => {
    const identity = itemIdentity(row, index);
    rows.set(identity.key, { ...identity, qty: itemQuantity(row), source: row });
  });
  return rows;
}

function roomText(roomId, roomLabel) {
  const label = typeof roomLabel === "function" ? String(roomLabel(roomId) ?? "").trim() : "";
  return label || String(roomId || "outdoors");
}

function quantityRows(beforeRows, afterRows, { roomLabel, formatNumber = defaultFormatNumber } = {}) {
  const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
  const rows = [];
  for (const key of keys) {
    const before = beforeRows.get(key);
    const after = afterRows.get(key);
    const oldQty = finiteNumber(before?.qty, 0);
    const nextQty = finiteNumber(after?.qty, 0);
    if (!changedNumber(oldQty, nextQty)) continue;
    const source = after ?? before;
    rows.push({
      ...numberChange(key, source?.name || "Ресурс", oldQty, nextQty, formatNumber),
      id: String(source?.id ?? ""),
      resourceId: String(source?.resourceId ?? ""),
      roomId: String(source?.roomId ?? "outdoors"),
      roomLabel: roomText(source?.roomId, roomLabel)
    });
  }
  return rows.sort((left, right) => (
    Math.abs(right.delta) - Math.abs(left.delta)
    || String(left.label).localeCompare(String(right.label), "ru")
    || String(left.roomLabel).localeCompare(String(right.roomLabel), "ru")
  ));
}

function buildingSnapshot(building = {}) {
  const state = buildingOperationalState(building);
  const repairActive = Boolean(state.repairActive);
  const progress = repairActive
    ? finiteNumber(building?.repair?.progress ?? building?.repairProgress ?? building?.buildProgress, 0)
    : finiteNumber(building?.buildProgress, 0);
  const target = repairActive
    ? Math.max(0, finiteNumber(building?.repair?.target ?? building?.repairTarget ?? building?.buildTarget, 0))
    : Math.max(0, finiteNumber(building?.buildTarget, 0));
  const pendingQty = (building?.productionLines ?? []).reduce((sum, line) => sum + Math.max(0, finiteNumber(line?.pendingQty, 0)), 0);
  return { state, progress, target, pendingQty };
}

function buildingRows(before = {}, after = {}, formatNumber = defaultFormatNumber) {
  const beforeRows = new Map((before?.buildings?.list ?? []).map((row) => [String(row?.id ?? ""), row]));
  const afterRows = new Map((after?.buildings?.list ?? []).map((row) => [String(row?.id ?? ""), row]));
  const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
  const rows = [];
  for (const key of keys) {
    const oldBuilding = beforeRows.get(key);
    const nextBuilding = afterRows.get(key);
    if (!oldBuilding || !nextBuilding) continue;
    const oldState = buildingSnapshot(oldBuilding);
    const nextState = buildingSnapshot(nextBuilding);
    const changes = [];
    if (oldState.state.value !== nextState.state.value) {
      changes.push(textChange("state", "Состояние", oldState.state.label, nextState.state.label));
    }
    if (changedNumber(oldState.progress, nextState.progress) || changedNumber(oldState.target, nextState.target)) {
      changes.push({
        ...numberChange("progress", oldState.state.repairActive || nextState.state.repairActive ? "Ремонт" : "Строительство", oldState.progress, nextState.progress, formatNumber),
        beforeTarget: oldState.target,
        afterTarget: nextState.target,
        beforeTargetText: formatNumber(oldState.target),
        afterTargetText: formatNumber(nextState.target)
      });
    }
    if (changedNumber(oldState.pendingQty, nextState.pendingQty)) {
      changes.push(numberChange("pending", "Готово к сбору", oldState.pendingQty, nextState.pendingQty, formatNumber));
    }
    if (changes.length) rows.push({ id: key, name: String(nextBuilding?.name ?? oldBuilding?.name ?? "Здание"), changes });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function residentRows(before = {}, after = {}, formatNumber = defaultFormatNumber) {
  const beforeRows = new Map((before?.people?.list ?? []).map((row) => [String(row?.id ?? ""), row]));
  const afterRows = new Map((after?.people?.list ?? []).map((row) => [String(row?.id ?? ""), row]));
  const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
  const rows = [];
  for (const key of keys) {
    const oldPerson = beforeRows.get(key);
    const nextPerson = afterRows.get(key);
    if (!oldPerson || !nextPerson) continue;
    const changes = [];
    const oldInjury = Math.max(0, finiteNumber(oldPerson?.injuredDays, 0));
    const nextInjury = Math.max(0, finiteNumber(nextPerson?.injuredDays, 0));
    if (changedNumber(oldInjury, nextInjury)) changes.push(numberChange("injuredDays", "Лечение, дней", oldInjury, nextInjury, formatNumber));
    if (String(oldPerson?.status ?? "") !== String(nextPerson?.status ?? "")) changes.push(textChange("status", "Статус", oldPerson?.status, nextPerson?.status));
    if (Boolean(oldPerson?.dead) !== Boolean(nextPerson?.dead)) changes.push(textChange("dead", "Жизнь", oldPerson?.dead ? "Мёртв" : "Жив", nextPerson?.dead ? "Мёртв" : "Жив"));
    if (changedNumber(oldPerson?.age, nextPerson?.age)) changes.push(numberChange("age", "Возраст", oldPerson?.age, nextPerson?.age, formatNumber));
    if (String(oldPerson?.ageGroup ?? "") !== String(nextPerson?.ageGroup ?? "")) changes.push(textChange("ageGroup", "Возрастная группа", oldPerson?.ageGroup, nextPerson?.ageGroup));
    for (const [attribute, label] of Object.entries(RESIDENT_ATTRIBUTE_LABELS)) {
      const oldValue = finiteNumber(oldPerson?.attributes?.[attribute], 0);
      const nextValue = finiteNumber(nextPerson?.attributes?.[attribute], 0);
      if (changedNumber(oldValue, nextValue)) changes.push(numberChange(`attribute:${attribute}`, label, oldValue, nextValue, formatNumber));
    }
    if (String(oldPerson?.traitsText ?? "") !== String(nextPerson?.traitsText ?? "")) changes.push(textChange("traits", "Черты", oldPerson?.traitsText, nextPerson?.traitsText));
    if (String(oldPerson?.notes ?? "") !== String(nextPerson?.notes ?? "")) changes.push({ key: "notes", label: "Заметки", before: "", after: "Добавлена запись", direction: "changed" });
    if (!changes.length) continue;
    rows.push({
      id: key,
      name: String(nextPerson?.name ?? oldPerson?.name ?? "Житель"),
      recovered: oldInjury > 0 && nextInjury <= 0,
      healing: oldInjury > nextInjury && nextInjury > 0,
      changes
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function keyedNumberRows(before = {}, after = {}, labels = {}, prefix = "", formatNumber = defaultFormatNumber) {
  const rows = [];
  for (const [key, label] of Object.entries(labels)) {
    const oldValue = finiteNumber(before?.[key], 0);
    const nextValue = finiteNumber(after?.[key], 0);
    if (changedNumber(oldValue, nextValue)) rows.push(numberChange(`${prefix}${key}`, label, oldValue, nextValue, formatNumber));
  }
  return rows;
}

function shipmentRows(before = {}, after = {}, formatNumber = defaultFormatNumber) {
  const beforeRows = new Map((before?.special?.market?.orders ?? []).map((row) => [String(row?.id ?? ""), row]));
  const afterRows = new Map((after?.special?.market?.orders ?? []).map((row) => [String(row?.id ?? ""), row]));
  const keys = new Set([...beforeRows.keys(), ...afterRows.keys()]);
  const rows = [];
  for (const key of keys) {
    const oldOrder = beforeRows.get(key);
    const nextOrder = afterRows.get(key);
    if (!oldOrder || !nextOrder) continue;
    const changes = [];
    if (String(oldOrder?.status ?? "") !== String(nextOrder?.status ?? "")) changes.push(textChange("status", "Статус", oldOrder?.status, nextOrder?.status));
    if (changedNumber(oldOrder?.remainingQd, nextOrder?.remainingQd)) changes.push(numberChange("remainingQd", "Осталось QD", oldOrder?.remainingQd, nextOrder?.remainingQd, formatNumber));
    if (changedNumber(oldOrder?.delayQd, nextOrder?.delayQd)) changes.push(numberChange("delayQd", "Задержка QD", oldOrder?.delayQd, nextOrder?.delayQd, formatNumber));
    if (String(oldOrder?.riskOutcome ?? "") !== String(nextOrder?.riskOutcome ?? "")) changes.push(textChange("riskOutcome", "Маршрут", oldOrder?.riskOutcome, nextOrder?.riskOutcome));
    if (changedNumber(oldOrder?.insurancePayoutCopper, nextOrder?.insurancePayoutCopper)) changes.push(numberChange("insurance", "Страховая выплата", oldOrder?.insurancePayoutCopper, nextOrder?.insurancePayoutCopper, formatNumber));
    if (changes.length) rows.push({ id: key, name: String(nextOrder?.marketLabel ?? oldOrder?.marketLabel ?? "Поставка"), changes });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function foodTotal(holding = {}, isFoodResource = null) {
  if (typeof isFoodResource !== "function") return 0;
  return (holding?.storage?.resources ?? [])
    .filter((row) => isFoodResource(row))
    .reduce((sum, row) => sum + Math.max(0, finiteNumber(row?.qty, 0)), 0);
}

function treasuryDebt(holding = {}) {
  const treasury = holding?.gm?.economy?.treasury ?? {};
  return Math.max(0, finiteNumber(treasury.salaryArrearsCopper, 0))
    + Math.max(0, finiteNumber(treasury.upkeepArrearsCopper, 0));
}

export function buildTendayChangeSet(before = {}, after = {}, options = {}) {
  const formatNumber = typeof options.formatNumber === "function" ? options.formatNumber : defaultFormatNumber;
  const roomLabel = (roomId) => typeof options.roomLabel === "function" ? options.roomLabel(after, roomId) : roomId;
  const resources = quantityRows(resourceIndex(before), resourceIndex(after), { roomLabel, formatNumber });
  const items = quantityRows(itemIndex(before), itemIndex(after), { roomLabel, formatNumber });
  const buildings = buildingRows(before, after, formatNumber);
  const residents = residentRows(before, after, formatNumber);
  const development = keyedNumberRows(before?.overview?.development, after?.overview?.development, DEVELOPMENT_LABELS, "development:", formatNumber);
  const modifiers = keyedNumberRows(before?.gm?.modifiers, after?.gm?.modifiers, MODIFIER_LABELS, "modifier:", formatNumber);
  const shipments = shipmentRows(before, after, formatNumber);
  const beforeQd = Math.max(0, finiteNumber(before?.gm?.calendaria?.lastQd, 0));
  const afterQd = Math.max(0, finiteNumber(after?.gm?.calendaria?.lastQd, 0));
  const clock = numberChange("clock", "Внутренние QD", beforeQd, afterQd, formatNumber);
  const beforeDate = String(before?.gm?.calendaria?.lastDateText ?? before?.gm?.calendaria?.lastDateKey ?? "");
  const afterDate = String(after?.gm?.calendaria?.lastDateText ?? after?.gm?.calendaria?.lastDateKey ?? "");
  const date = beforeDate === afterDate ? null : textChange("date", "Дата владения", beforeDate, afterDate);
  const money = numberChange("money", "Казна", before?.storage?.moneyCopper, after?.storage?.moneyCopper, formatNumber);
  const debt = numberChange("debt", "Задолженность казны", treasuryDebt(before), treasuryDebt(after), formatNumber);
  const food = numberChange("food", "Запас пищи", foodTotal(before, options.isFoodResource), foodTotal(after, options.isFoodResource), formatNumber);
  const totals = {
    resourceRows: resources.length,
    itemRows: items.length,
    buildingRows: buildings.length,
    residentRows: residents.length,
    developmentRows: development.length,
    modifierRows: modifiers.length,
    shipmentRows: shipments.length,
    recoveredResidents: residents.filter((row) => row.recovered).length,
    healingResidents: residents.filter((row) => row.healing).length
  };
  const hasChanges = changedNumber(money.before, money.after)
    || changedNumber(debt.before, debt.after)
    || changedNumber(food.before, food.after)
    || changedNumber(clock.before, clock.after)
    || Boolean(date)
    || Object.values(totals).some((value) => value > 0);
  return { money, debt, food, clock, date, resources, items, buildings, residents, development, modifiers, shipments, totals, hasChanges };
}
