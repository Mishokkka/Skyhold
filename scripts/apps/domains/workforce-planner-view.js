import { workforceOperationalMinimum } from "./workforce-task-state.js";
import { buildingAcceptsWorkers, buildingLaborCapacityQd } from "../../data/labor-model.js";

const total = (rows, key) => rows.reduce((value, row) => value + Number(row[key] || 0), 0);

/** Planned labor only: execution still checks money, inputs, qualifications and results. */
export function workforceBuildingRequirement(building, tasks) {
  if (!building) return null;
  const { minQd, functionId, relevant, qd, workers } = workforceOperationalMinimum(building, tasks);
  const scope = functionId ? [...new Set(relevant.map((task) => task.functionName))].join(", ") || "функция эффекта здания" : "суммарно по рабочим функциям";
  return {
    minQd,
    minWorkers: 0,
    qd,
    workers,
    gap: Math.max(0, minQd - qd),
    scopeLabel: !minQd
      ? "Объём QD определяется выбранной работой."
      : functionId === "production"
        ? "Производственные линии"
        : functionId
          ? `${relevant[0]?.functionName || "Функция эффекта"}`
          : "Все рабочие функции",
    label: minQd ? `Для эффекта: ${qd} / ${minQd} QD` : "Объём работы — по задаче поселения",
    note: `${minQd ? `Нужно ${minQd} QD за десятник (${scope}). ` : ""}Эффект включается сразу на 100% при выполнении порога и состава. Фактический результат также зависит от оплаты, сырья и состояния здания.`,
    progressMax: Math.max(1, minQd, qd)
  };
}

/** Pagination operates on buildings; filters may narrow their child rows. */
export function workforceTaskGroups(model, matchingTasks = model.tasks) {
  const matches = new Set(matchingTasks.map((task) => task.key));
  const groups = new Map();
  for (const task of model.tasks) {
    const id = task.buildingId || "settlement";
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
      current.qd += row.normalQd + row.overtimeQd;
      assigned.set(row.personId, current);
    }
    const people = [...assigned.values()];
    const normalQd = total(group.allTasks, "normalQd");
    const overtimeQd = total(group.allTasks, "overtimeQd");
    const assignmentsText = people.slice(0, 2).map((row) => `${row.name}: ${row.qd}`).join(" · ")
      + (people.length > 2 ? ` · ещё ${people.length - 2}` : "");
    const warnings = [...new Set(group.allTasks.flatMap((task) => task.warnings))];
    const capacityQd = buildingLaborCapacityQd(group.building);
    const acceptsWorkers = buildingAcceptsWorkers(group.building);
    return {
      ...group,
      tasks,
      requirement,
      key: tasks[0]?.key,
      multiple: group.allTasks.length > 1,
      taskCount: group.allTasks.length,
      capacityText: !acceptsWorkers
        ? "Без работников"
        : capacityQd === null
          ? "Предел — объём работы и оборудование"
          : `Труд: ${normalQd + overtimeQd} / ${capacityQd} QD за десятник`,
      normalQd,
      overtimeQd,
      totalQd: normalQd + overtimeQd,
      goal: 0,
      goalQd: 0,
      assignmentsText,
      preparationText: group.allTasks.filter((task) => task.preparedUnits > 0).map((task) => `${task.functionName}: ${task.preparedUnits} ЕД.`).join(" · "),
      staff: people.length,
      remaining: total(tasks, "remaining"),
      attention: tasks.some((task) => task.attention),
      warningCount: warnings.length,
      warningsText: warnings.join("; "),
      requiredGap: group.allTasks.some((task) => task.careGap > 0),
      requiredText: group.allTasks.filter((task) => task.dailyNeed > 0).map((task) => `Уход: покрыто ${10 - task.missedDays} / 10 дней · ${task.dailyNeed} эфф. QD/день`).join("; ")
    };
  }).filter((group) => group.tasks.length);
}
