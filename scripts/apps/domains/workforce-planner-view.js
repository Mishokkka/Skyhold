import { workforceOperationalMinimum } from "./workforce-task-state.js";
import { buildingLaborMode, buildingLaborCapacityQd } from "../../data/hybrid-labor.js";

const total = (rows, key) => rows.reduce((value, row) => value + Number(row[key] || 0), 0);
const whole = (value) => Math.max(0, Math.floor(Number(value) || 0));

/** Planned labor only: execution still checks money, inputs, qualifications and results. */
export function workforceBuildingRequirement(building, tasks) {
  if (!building) return null;
  const { minQd, minWorkers, functionId, relevant, qd, workers } = workforceOperationalMinimum(building, tasks);
  const scope = functionId ? [...new Set(relevant.map((task) => task.functionName))].join(", ") || "функция эффекта здания" : "суммарно по рабочим функциям";
  return { minQd, minWorkers, qd, workers, gap: Math.max(0, minQd - qd),
    scopeLabel: !minQd ? "Объём QD определяется выбранной работой; число мест не задаёт объём труда." : functionId === "production" ? "Производственные линии; без обслуживания" : functionId ? `${relevant[0]?.functionName || "Функция эффекта"}; без обслуживания` : "Все рабочие функции; без обслуживания",
    label: minQd ? `${buildingLaborMode(building) === "legacy" ? "Для эффекта" : "Полный эффект"}: ${qd} / ${minQd} QD${minWorkers ? ` · работников ${workers} / ${minWorkers}` : ""}`
      : minWorkers ? `Минимум: ${minWorkers} чел. · QD по задаче` : "Объём работы — по задаче поселения",
    note: `${minQd ? `Нужно ${minQd} QD за десятник: ${scope}. ` : "Число рабочих мест не переводится в обязательные QD. "}Обслуживание не входит в труд для эффекта. Фактический результат также зависит от состава, оплаты, сырья и состояния здания.`,
    progressMax: Math.max(1, minQd, qd) };
}

/** Pagination operates on buildings; filters may narrow their child rows. */
export function workforceTaskGroups(model, matchingTasks = model.tasks) {
  const matches = new Set(matchingTasks.map((task) => task.key));
  const groups = new Map();
  for (const task of model.tasks) {
    const id = task.buildingId || "settlement-maintenance";
    let group = groups.get(id);
    if (!group) {
      group = { id, name: task.name, icon: task.icon, img: task.img, building: task.building, allTasks: [] };
      groups.set(id, group);
    }
    group.allTasks.push(task);
  }
  return [...groups.values()].map((group) => {
    const tasks = group.allTasks.filter((task) => matches.has(task.key));
    const requirement = workforceBuildingRequirement(group.building, group.allTasks);
    const assigned = new Map();
    for (const task of group.allTasks) for (const row of task.assignments) {
      const current = assigned.get(row.personId) ?? { name: row.name, qd: 0 };
      current.qd += row.normalQd + row.overtimeQd; assigned.set(row.personId, current);
    }
    const people = [...assigned.values()], normalQd = total(group.allTasks, "normalQd"), overtimeQd = total(group.allTasks, "overtimeQd");
    const goal = total(group.allTasks, "goal");
    const goalQd = group.allTasks.reduce((sum, task) => sum + Math.min(Number(task.goal || 0), Number(task.normalQd || 0)), 0);
    const staff = model.staffByBuilding.get(group.id)?.size ?? 0;
    const assignmentsText = people.slice(0, 2).map((row) => `${row.name}: ${row.qd}`).join(" · ") + (people.length > 2 ? ` · ещё ${people.length - 2}` : "")
      || (buildingLaborMode(group.building) === "staff" && staff ? `В штате: ${staff} · сейчас без доступных QD` : "");
    const warnings = [...new Set(group.allTasks.flatMap((task) => task.warnings))];
    const laborMode = buildingLaborMode(group.building), capacityQd = buildingLaborCapacityQd(group.building);
    return { ...group, tasks, requirement, key: tasks[0]?.key, multiple: group.allTasks.length > 1, taskCount: group.allTasks.length,
      laborMode, isStaff: laborMode === "staff", showSeats: ["legacy", "staff"].includes(laborMode),
      modeLabel: { staff: "Постоянный штат", qd: "Задания QD", passive: "Без работников", legacy: "Прежние назначения" }[laborMode],
      capacityText: laborMode === "qd" ? capacityQd === null ? "Предел — объём работы и оборудование" : `Труд: ${normalQd + overtimeQd} / ${capacityQd} QD за десятник` : "",
      normalQd, overtimeQd, totalQd: normalQd + overtimeQd, goal, goalQd, assignmentsText,
      preparationText: group.allTasks.filter((task) => task.preparedUnits > 0).map((task) => `${task.functionName}: ${task.preparedUnits} ЕД.`).join(" · "),
      staff, workersMax: whole(group.building?.workersMax),
      remaining: total(tasks, "remaining"), attention: tasks.some((task) => task.attention),
      warningCount: warnings.length, warningsText: warnings.join("; "),
      requiredGap: group.allTasks.some((task) => task.careGap > 0),
      requiredText: group.allTasks.filter((task) => task.dailyNeed > 0).map((task) => `Уход: покрыто ${10 - task.missedDays} / 10 дней · ${task.dailyNeed} эфф. QD/день`).join("; ") };
  }).filter((group) => group.tasks.length);
}
