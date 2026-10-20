import {
  workerAttribute,
  workerBackgroundMatches,
  workerHasTrait
} from "./building-qualification.js";

export const CONSTRUCTION_MIN_WORKERS = 2;
export const CONSTRUCTION_WORKER_WAGE_DAILY_COPPER = 12;
export const CONSTRUCTION_LEADER_WAGE_DAILY_COPPER = 18;

export function constructionLeaderQualification(person = {}) {
  if (!person || person.dead || Number(person?.injuredDays ?? 0) > 0) {
    return { eligible: false, code: "unavailable", reason: "житель недоступен" };
  }
  if (workerHasTrait(person, "Builder")) {
    return { eligible: true, code: "builder", reason: "Builder: профессиональный руководитель строительства" };
  }
  if (workerHasTrait(person, "Лидер") && (workerAttribute(person, "wits") >= 3 || workerAttribute(person, "empathy") >= 3)) {
    return { eligible: true, code: "leader", reason: "Лидер и РАЗ/ЭМП 3+" };
  }
  if (workerAttribute(person, "wits") >= 4 && workerAttribute(person, "empathy") >= 4) {
    return { eligible: true, code: "manager", reason: "РАЗ 4+ и ЭМП 4+" };
  }
  if (workerBackgroundMatches(person, ["СТРОИТЕЛЬСТВО"])
    && (workerAttribute(person, "wits") >= 4 || workerAttribute(person, "empathy") >= 4)) {
    return { eligible: true, code: "foreman", reason: "строительное прошлое и РАЗ/ЭМП 4+" };
  }
  return {
    eligible: false,
    code: "qualification",
    reason: "нужны Builder; либо Лидер с РАЗ/ЭМП 3+; либо РАЗ и ЭМП 4+; либо строительное прошлое с РАЗ/ЭМП 4+"
  };
}

export function constructionLeaderCoordinationBonus(person = {}, workerCount = 0) {
  return Number(workerCount) >= CONSTRUCTION_MIN_WORKERS && workerHasTrait(person, "Лидер") ? 1 : 0;
}
