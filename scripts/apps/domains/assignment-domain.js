// Extracted SkyholdApp domain methods. These functions are mixed into SkyholdApp.prototype.
import { splitList } from "../../core/helpers.js";

export const AssignmentDomain = {
_assignedWorkerSet(holding, exceptBuildingId = null) {
  const set = new Set();
  for (const building of holding?.buildings?.list ?? []) {
    if (exceptBuildingId && building.id === exceptBuildingId) continue;
    for (const id of building?.assignedWorkerIds ?? []) if (id) set.add(String(id));
  }
  for (const crew of this._constructionCrews(holding)) {
    for (const id of crew?.memberIds ?? []) if (id) set.add(String(id));
  }
  const defense = holding?.gm?.defense ?? {};
  if (defense.commanderId) set.add(String(defense.commanderId));
  for (const squad of defense.squads ?? []) {
    if (squad?.sergeantId) set.add(String(squad.sergeantId));
    for (const id of (squad?.memberIds ?? []).slice(0, 4)) if (id) set.add(String(id));
  }
  return set;
},

_findPerson(holding, personId) {
  return (holding?.people?.list ?? []).find((person) => String(person.id) === String(personId));
},

_clearPersonFromAssignments(holding, personId) {
  const id = String(personId ?? "");
  if (!id) return;
  for (const building of holding?.buildings?.list ?? []) {
    if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
    building.assignedWorkerIds = building.assignedWorkerIds.map((value) => String(value) === id ? "" : value);
  }
  for (const crew of holding?.constructionCrews ?? []) {
    if (!Array.isArray(crew.memberIds)) crew.memberIds = [];
    crew.memberIds = crew.memberIds.filter((value) => String(value) !== id);
    if (String(crew.leaderId ?? "") === id) crew.leaderId = "";
  }
  for (const squad of holding?.gm?.defense?.squads ?? []) {
    if (!Array.isArray(squad.memberIds)) squad.memberIds = [];
    squad.memberIds = squad.memberIds.map((value) => String(value) === id ? "" : value);
    if (String(squad.sergeantId ?? "") === id) squad.sergeantId = "";
  }
  if (String(holding?.gm?.defense?.commanderId ?? "") === id) holding.gm.defense.commanderId = "";
},

_setPersonFree(holding, personId) {
  const person = this._findPerson(holding, personId);
  if (!person) return;
  person.workAssignment = "";
  person.role = this._isChildResident?.(person) ? "Ребенок" : "Свободен";
  person.salary = 0;
},

_squadSalaryCopper(squad = {}) {
  const type = String(squad?.type ?? "line") === "militia" ? "line" : String(squad?.type ?? "line");
  const table = {
    line: 10,
    fusiliers: 12,
    jaegers: 14,
    grenadiers: 14,
    sappers: 12,
    artillery: 15,
    cavalry: 16
  };
  return table[type] ?? 10;
},

_applyDefenseSalaries(holding) {
  if (!holding?.gm?.defense || !Array.isArray(holding.gm.defense.squads)) return 0;
  const defense = holding.gm.defense;
  const peopleList = holding?.people?.list ?? [];
  const people = new Map(peopleList.map((person) => [String(person.id), person]));
  const currentIds = new Set();
  for (const squad of defense.squads) {
    if (squad?.sergeantId) currentIds.add(String(squad.sergeantId));
    for (const id of (Array.isArray(squad?.memberIds) ? squad.memberIds.slice(0, 4) : [])) if (id) currentIds.add(String(id));
  }
  const commanderId = String(defense.commanderId ?? "");
  for (const person of peopleList) {
    const role = String(person?.role ?? "");
    const id = String(person?.id ?? "");
    if (String(person?.workAssignment ?? "") === "soldier" && /^(Сержант|Солдат):/.test(role) && !currentIds.has(id)) this._setPersonFree?.(holding, id);
    if (String(person?.workAssignment ?? "") === "defenseCommander" && id !== commanderId) this._setPersonFree?.(holding, id);
  }
  let assigned = 0;
  for (const [index, squad] of defense.squads.entries()) {
    const base = this._squadSalaryCopper(squad);
    const squadName = squad?.name || `${index + 1}-й отряд`;
    const typeDefs = this._squadTypeDefs?.() ?? {};
    const type = String(squad?.type ?? "line") === "militia" ? "line" : String(squad?.type ?? "line");
    const typeLabel = typeDefs[type]?.label ?? "Отряд";
    const ids = [String(squad?.sergeantId ?? ""), ...(Array.isArray(squad?.memberIds) ? squad.memberIds.slice(0, 4).map((id) => String(id ?? "")) : [])].filter(Boolean);
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
      const person = people.get(id);
      if (!person) continue;
      const isSergeant = String(squad?.sergeantId ?? "") === id && this._isSergeantCandidate?.(person);
      const modifier = this._salaryModifier(person);
      person.workAssignment = "soldier";
      person.role = `${isSergeant ? "Сержант" : "Солдат"}: ${squadName} (${typeLabel})`;
      const total = Math.max(0, Math.round((base + (isSergeant ? 2 : 0) + modifier) * 100) / 100);
      person.salary = Number.isFinite(total) ? total : 0;
      assigned += 1;
    }
  }
  if (commanderId) {
    const commander = people.get(commanderId);
    if (commander && !commander.dead) {
      const soldierCount = peopleList.filter((row) => {
        const id = String(row?.id ?? "");
        if (!id || id === commanderId) return false;
        const role = String(row?.role ?? "");
        return currentIds.has(id) || String(row?.workAssignment ?? "") === "soldier" || /солдат|сержант|страж|охран|guard|soldier/i.test(role);
      }).length;
      const base = 10 * soldierCount;
      const modifier = this._salaryModifier(commander);
      commander.workAssignment = "defenseCommander";
      commander.role = `Командир обороны: ${soldierCount} солд.`;
      const total = Math.max(0, Math.round((base + modifier) * 100) / 100);
      commander.salary = Number.isFinite(total) ? total : 0;
      assigned += 1;
    }
  }
  return assigned;
},

_hirelingSalaryTable() {
  return [
    { key: "master-builder", label: "Master Builder", copper: 20, re: /мастер[- ]?стро|главн.*стро|прораб|архитектор|master builder/i },
    { key: "innkeeper", label: "Innkeeper", copper: 12, re: /трактир|таверн|постоял|гостиниц|inn|tavern/i },
    { key: "guard", label: "Guard", copper: 10, re: /страж|караул|охран|дозор|гарнизон|солдат|воен|башн|ворот|тюрьм|темниц|guard|soldier/i },
    { key: "smith", label: "Smith", copper: 10, re: /кузн|оружейн|бронник|forge|smith/i },
    { key: "bowyer", label: "Bowyer", copper: 10, re: /лучник|лук|арбалет|bowyer|fletcher/i },
    { key: "executioner", label: "Executioner", copper: 10, re: /палач|executioner/i },
    { key: "tailor", label: "Tailor", copper: 8, re: /портн|ткач|одежд|текстил|tailor/i },
    { key: "miller", label: "Miller", copper: 8, re: /мельниц|мельник|мукомол|miller/i },
    { key: "jailer", label: "Jailer", copper: 8, re: /тюрем|темниц|jailer/i },
    { key: "carpenter", label: "Carpenter", copper: 7, re: /плотник|столяр|лесопил|древес|carpenter/i },
    { key: "baker", label: "Baker", copper: 6, re: /пекар|хлеб|baker/i },
    { key: "hunter", label: "Hunter", copper: 6, re: /охот|ловч|зверолов|следопыт|hunter/i },
    { key: "tanner", label: "Tanner", copper: 6, re: /кожев|дубиль|шкур|tanner/i },
    { key: "farmer", label: "Farmer", copper: 5, re: /ферм|поле|зерн|сад|пастб|рыб|скот|farmer/i },
    { key: "lumberjack", label: "Lumberjack", copper: 4, re: /лесоруб|лесоповал|lumber/i },
    { key: "miner", label: "Miner", copper: 4, re: /шахт|рудник|карьер|камень|рудокоп|miner/i },
    { key: "handyman", label: "Handyman", copper: 3, re: /разнораб|слуга|убор|носиль|handyman/i }
  ];
},

_salaryModifier(person = {}) {
  const value = this._safeNumber?.(person?.salaryModifier, 0) ?? Number(person?.salaryModifier ?? 0);
  return Number.isFinite(value) ? value : 0;
},

_baseSalaryForAssignment(holding, person = {}, building = null) {
  if (!person || person.dead) return 0;
  if (building) {
    const haystack = [building.workerRole, building.name, building.type, building.effect, building.notes, building.production, building.primaryDev]
      .map((value) => String(value ?? "").toLowerCase()).join(" ");
    for (const row of this._hirelingSalaryTable()) {
      if (row.re.test(haystack)) return row.copper;
    }
    const functions = building.functions && typeof building.functions === "object" ? building.functions : {};
    if (functions.defense || building?.defense?.base || building?.defense?.perStep || building?.defense?.workerStep) return 10;
    if (functions.income) return 8;
    if (functions.culture) return 6;
    if (functions.production) return 5;
    if (functions.storage) return 3;
    return 3;
  }
  const assignment = String(person?.workAssignment ?? "");
  const roleText = `${person?.role ?? ""} ${person?.skill ?? ""}`.toLowerCase();
  if (assignment === "defenseCommander") {
    const soldierCount = (holding?.people?.list ?? []).filter((row) => String(row?.workAssignment ?? "") === "soldier").length;
    return Math.max(0, 10 * soldierCount);
  }
  if (assignment === "soldier" || /солдат|страж|охран|guard|soldier/i.test(roleText)) return 10;
  if (assignment.startsWith("construction") || /строй|строител|плотник|каменщик|мастер/i.test(roleText)) return 7;
  return 0;
},

_applyPersonSalaryForAssignment(holding, person = {}, building = null) {
  if (!person) return 0;
  const base = this._baseSalaryForAssignment(holding, person, building);
  const mod = this._salaryModifier(person);
  const total = Math.max(0, Math.round((base + mod) * 100) / 100);
  person.salary = Number.isFinite(total) ? total : 0;
  return person.salary;
},

_assignPersonToBuilding(holding, personId, buildingId) {
  const person = this._findPerson(holding, personId);
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(buildingId));
  if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0 || (this._canResidentWork && !this._canResidentWork(person)) || !building) return false;
  const max = Math.max(0, this._safeNumber(building.workersMax, 0));
  if (max <= 0) return false;
  this._clearPersonFromAssignments(holding, personId);
  if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
  while (building.assignedWorkerIds.length < max) building.assignedWorkerIds.push("");
  let slot = building.assignedWorkerIds.findIndex((id) => !id);
  if (slot < 0) return false;
  building.assignedWorkerIds[slot] = String(personId);
  person.workAssignment = String(building.id);
  person.role = building.workerRole || building.name || "Работает в здании";
  this._applyPersonSalaryForAssignment?.(holding, person, building);
  return true;
},

_assignPersonToCrew(holding, personId, crewId = null) {
  const person = this._findPerson(holding, personId);
  if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0 || (this._canResidentWork && !this._canResidentWork(person))) return false;
  if (!Array.isArray(holding.constructionCrews)) holding.constructionCrews = [];
  if (!holding.constructionCrews.length) holding.constructionCrews.push({ id: foundry.utils.randomID?.(10) ?? `crew-${Date.now()}`, name: "Стройбригада", memberIds: [], leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец" });
  const crew = crewId ? holding.constructionCrews.find((item) => String(item.id) === String(crewId)) : holding.constructionCrews[0];
  if (!crew) return false;
  this._clearPersonFromAssignments(holding, personId);
  if (!Array.isArray(crew.memberIds)) crew.memberIds = [];
  if (!crew.memberIds.some((id) => String(id) === String(personId))) crew.memberIds.push(String(personId));
  person.workAssignment = `construction:${crew.id}`;
  person.role = crew.name || "Стройбригада";
  this._applyPersonSalaryForAssignment?.(holding, person, null);
  return true;
},

_setBuildingSlot(holding, buildingId, slot, personId) {
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(buildingId));
  if (!building) return false;
  const max = Math.max(0, this._safeNumber(building.workersMax, 0));
  if (max <= 0 || slot >= max) return false;
  if (!Array.isArray(building.assignedWorkerIds)) building.assignedWorkerIds = [];
  while (building.assignedWorkerIds.length <= slot) building.assignedWorkerIds.push("");
  const oldId = String(building.assignedWorkerIds[slot] ?? "");
  if (personId) {
    const person = this._findPerson(holding, personId);
    if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0 || (this._canResidentWork && !this._canResidentWork(person))) return false;
  }
  if (oldId && oldId !== String(personId)) this._setPersonFree(holding, oldId);
  building.assignedWorkerIds[slot] = "";
  if (!personId) return true;
  const person = this._findPerson(holding, personId);
  this._clearPersonFromAssignments(holding, personId);
  building.assignedWorkerIds[slot] = String(personId);
  if (person) {
    person.workAssignment = String(building.id);
    person.role = building.workerRole || building.name || "Работает в здании";
    this._applyPersonSalaryForAssignment?.(holding, person, building);
  }
  return true;
},

_setHousingSlot(holding, buildingId, slot, personId) {
  const building = (holding?.buildings?.list ?? []).find((item) => String(item.id) === String(buildingId));
  if (!building) return false;
  const index = Math.max(0, Math.floor(this._safeNumber(slot, 0)));
  const occupants = this._housingOccupants?.(holding, building) ?? [];
  const oldPerson = occupants[index] ?? null;
  const nextId = String(personId ?? "");
  if (oldPerson && String(oldPerson.id) !== nextId) oldPerson.home = "";
  if (!nextId) return true;
  const person = this._findPerson(holding, nextId);
  if (!person || person.dead) return false;
  person.home = String(building.id ?? building.name ?? "");
  return true;
},


_setCrewSlot(holding, crewId, slot, personId) {
  const crew = (holding?.constructionCrews ?? []).find((item) => String(item.id) === String(crewId));
  if (!crew) return false;
  if (!Array.isArray(crew.memberIds)) crew.memberIds = [];
  while (crew.memberIds.length <= slot) crew.memberIds.push("");
  const oldId = String(crew.memberIds[slot] ?? "");
  if (personId) {
    const person = this._findPerson(holding, personId);
    if (!person || person.dead || this._safeNumber(person?.injuredDays, 0) > 0 || (this._canResidentWork && !this._canResidentWork(person))) return false;
  }
  if (oldId && oldId !== String(personId)) this._setPersonFree(holding, oldId);
  crew.memberIds[slot] = "";
  if (!personId) {
    while (crew.memberIds.length && !crew.memberIds[crew.memberIds.length - 1]) crew.memberIds.pop();
    return true;
  }
  const person = this._findPerson(holding, personId);
  this._clearPersonFromAssignments(holding, personId);
  crew.memberIds[slot] = String(personId);
  if (person) {
    person.workAssignment = `construction:${crew.id}`;
    person.role = crew.name || "Стройбригада";
    this._applyPersonSalaryForAssignment?.(holding, person, null);
  }
  while (crew.memberIds.length && !crew.memberIds[crew.memberIds.length - 1]) crew.memberIds.pop();
  return true;
},

_constructionCrews(holding) {
  const source = Array.isArray(holding?.constructionCrews) ? holding.constructionCrews : [];
  if (source.length) return source.map((crew, index) => ({
    id: String(crew.id ?? `crew-${index}`),
    name: String(crew.name ?? (index ? `Стройбригада ${index + 1}` : "Стройбригада")),
    memberIds: Array.isArray(crew.memberIds) ? crew.memberIds.map((id) => String(id ?? "")).filter(Boolean) : [],
    leaderId: String(crew.leaderId ?? ""),
    suitableWorkerTypes: String(crew.suitableWorkerTypes ?? ""),
    distributed: Boolean(crew.distributed),
    distributedIds: Array.isArray(crew.distributedIds) ? crew.distributedIds.map((id) => String(id ?? "")).filter(Boolean) : [],
    isDefault: index === 0
  }));
  const ids = Array.isArray(holding?.constructionCrewIds) ? holding.constructionCrewIds.map((id) => String(id ?? "")).filter(Boolean) : [];
  return [{ id: "legacy", name: "Стройбригада", memberIds: ids, leaderId: "", suitableWorkerTypes: "Строитель, Силач, Умелец", distributed: false, distributedIds: [], isDefault: true }];
},

_constructionCrew(holding, crewId = null) {
  const crews = this._constructionCrews(holding);
  const target = crewId ? (crews.find((crew) => String(crew.id) === String(crewId)) ?? crews[0]) : crews[0];
  return this._prepareConstructionCrew(holding, target);
},

_prepareConstructionCrew(holding, crew) {
  const people = (holding?.people?.list ?? []).filter((person) => !person?.dead);
  const ids = new Set((crew?.memberIds ?? []).map((id) => String(id || "")).filter(Boolean));
  const assignmentKey = crew?.id ? `construction:${crew.id}` : "construction";
  for (const person of people) {
    const assignment = String(person?.workAssignment ?? "");
    if (assignment === assignmentKey || (crew?.isDefault && assignment === "construction")) ids.add(String(person.id));
  }
  const members = Array.from(ids).map((id) => people.find((person) => String(person.id) === id)).filter(Boolean);
  const suitable = splitList(crew?.suitableWorkerTypes).map((item) => item.toLowerCase());
  const prepared = members.map((person) => {
    const detail = this._constructionContributionDetail(person, suitable);
    return {
      ...person,
      contribution: detail.dice,
      contributionReasons: detail.reasons.join("; "),
      type: this._workerType(person),
      attributes: this._attributeSummary(person),
      isLeader: String(person.id) === String(crew?.leaderId ?? "")
    };
  });
  const leaderPerson = prepared.find((person) => String(person.id) === String(crew?.leaderId ?? ""));
  const leaderBonus = leaderPerson && prepared.length > 1 && this._hasTrait(leaderPerson, "Лидер") ? 1 : 0;
  const gmCrewMod = this._gmEfficiencyModifiers?.(holding)?.constructionCrew ?? this._safeNumber(holding?.gm?.efficiencyModifiers?.constructionCrew, 0);
  const rawDice = prepared.reduce((sum, person) => sum + person.contribution, 0) + leaderBonus + gmCrewMod;
  const moraleMod = this._constructionMoraleModifier(holding, rawDice);
  const dice = Math.max(0, moraleMod.overrideDice !== undefined ? moraleMod.overrideDice : rawDice + moraleMod.value);
  return {
    ...crew,
    members: prepared,
    count: prepared.length,
    rawDice,
    leaderBonus,
    gmCrewMod,
    moraleMod: moraleMod.value,
    moraleReason: moraleMod.reason,
    dice,
    suitableLine: splitList(crew?.suitableWorkerTypes).join(", ") || "—",
    names: prepared.map((person) => `${person.name}${person.isLeader ? " ★" : ""} (${person.contribution})`).join(", ") || `${crew?.name ?? "Стройбригада"} пуста`
  };
},

_isConstructionCrew(person) {
  const text = `${person?.role ?? ""} ${person?.skill ?? ""}`.toLowerCase();
  return /(строй|строит|строитель|бригада|ремонт|плотник|каменщик|мастер|инженер|механик)/i.test(text);
},

_constructionContribution(person) {
  return this._constructionContributionDetail(person).dice;
},

_constructionContributionDetail(person, suitableTypes = []) {
  const attrs = person?.attributes ?? {};
  const strength = this._safeNumber(attrs.strength, 0);
  const wits = this._safeNumber(attrs.wits, 0);
  const type = this._workerType(person);
  const traits = this._traitBadges(person?.traitsText ?? person?.traits).map((trait) => trait.name.toLowerCase());
  const hasTrait = (name) => traits.includes(String(name).toLowerCase());
  let dice = 1;
  const reasons = ["база +1"];
  if (/Строитель|Механик|Бригадир|Мастеровой|Мастер на все руки/i.test(type)) { dice += 1; reasons.push(`тип ${type} +1`); }
  const suitableMatch = (suitableTypes ?? []).some((item) => this._workerTypeMatchesCriterion(type, item));
  if (suitableMatch) { dice += 1; reasons.push("подходящий тип +1"); }
  if (hasTrait("Builder")) { dice += 1; reasons.push("Builder +1"); }
  if (hasTrait("Мастеровой")) { dice += 1; reasons.push("Мастеровой +1"); }
  if (hasTrait("Крепкий")) { dice += 1; reasons.push("Крепкий +1"); }
  if (hasTrait("Больная спина")) { dice -= 1; reasons.push("Больная спина -1"); }
  if (hasTrait("Рассеянный")) { dice -= 1; reasons.push("Рассеянный -1"); }
  if (hasTrait("Пьяница")) { dice -= 1; reasons.push("Пьяница -1"); }
  if (hasTrait("Саботажник")) { dice -= 2; reasons.push("Саботажник -2"); }
  return { dice: Math.max(0, Math.min(6, dice)), reasons };
},

_constructionMoraleModifier(holding, rawDice = 0) {
  const morale = this._calculateMorale(holding);
  const state = this._moraleState(morale);
  const base = Math.max(0, this._safeNumber(rawDice, 0));
  if (state.label === "Бунты") return { value: Math.ceil(base / 2) - base - 3, overrideDice: Math.max(0, Math.ceil(base / 2) - 3), reason: "Бунты: стройбригада /2, затем -3" };
  if (state.label === "Недовольство") return { value: Math.ceil(base / 2) - base - 2, overrideDice: Math.max(0, Math.ceil(base / 2) - 2), reason: "Недовольство: стройбригада /2, затем -2" };
  if (state.label === "Апатия") return { value: Math.ceil(base / 2) - base, overrideDice: Math.ceil(base / 2), reason: "Апатия: стройбригада /2" };
  if (state.label === "Надежда") return { value: 1, reason: "Надежда: +1" };
  if (state.label === "Дом") return { value: 2, reason: "Дом: +2" };
  return { value: 0, reason: "Довольство: 0" };
}
};
