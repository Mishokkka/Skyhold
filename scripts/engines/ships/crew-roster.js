import { normalizePerson } from "../../data/normalizers/resident.js";
import { MAGNIFIQUE_CREW, MAGNIFIQUE_CREW_VERSION } from "../../data/magnifique-crew.js";

const ROSTER_ID = "magnifique";
const INSTALLATION_YEAR = 882;

function text(value = "") {
  return String(value ?? "").trim();
}

function normalizedName(value = "") {
  return text(value).normalize("NFKC").toLocaleLowerCase("ru-RU")
    .replace(/[«»„“”"'’`]/g, "")
    .replace(/[.,:;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function seedKey(seed) {
  return text(seed?.sourceCrewKey || seed?.key || seed?.id);
}

function seedRole(seed) {
  return text(seed?.shipCrewRole || seed?.rank || seed?.crewRole || seed?.role);
}

function candidateNames(seed) {
  const name = normalizedName(seed?.name);
  const rank = normalizedName(seed?.rank);
  const bare = rank && name.startsWith(`${rank} `) ? name.slice(rank.length + 1) : name;
  return new Set([name, bare].filter(Boolean));
}

function deterministicResidentId(key) {
  const ascii = key.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 54);
  if (ascii) return `magnifique-crew-${ascii}`;
  let hash = 2166136261;
  for (const char of key) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `magnifique-crew-${(hash >>> 0).toString(16)}`;
}

function uniqueResidentId(key, occupied) {
  const base = deterministicResidentId(key);
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function personMatchesActor(person, seed) {
  const sourceActorId = text(seed?.sourceActorId);
  const sourceActorUuid = text(seed?.sourceActorUuid);
  const residentUuid = text(person?.actorUuid);
  const residentActorId = residentUuid.split(".").filter(Boolean).at(-1) ?? "";
  return Boolean(
    (sourceActorId && text(person?.sourceActorId) === sourceActorId)
    || (sourceActorId && residentActorId === sourceActorId)
    || (sourceActorUuid && residentUuid === sourceActorUuid)
  );
}

function matchSeedToResidents(seed, residents) {
  const key = seedKey(seed);
  const byKey = residents.filter((person) => text(person?.sourceCrewKey) === key);
  if (byKey.length) return { kind: "sourceCrewKey", matches: byKey };
  const byActor = residents.filter((person) => personMatchesActor(person, seed));
  if (byActor.length) return { kind: "actor", matches: byActor };
  const names = candidateNames(seed);
  const byName = residents.filter((person) => names.has(normalizedName(person?.name)));
  return { kind: "name", matches: byName };
}

function isCommanderSeed(seed) {
  const command = text(seed?.commandRole).toLowerCase();
  return text(seed?.sourceActorId) === "Crr0kvvWjWPJ0bpH" || seed?.isCommander === true
    || command === "commander" || command === "адмирал"
    || normalizedName(seed?.name).endsWith("элина траззмар");
}

function isCoCommanderSeed(seed) {
  const command = text(seed?.commandRole).toLowerCase();
  const name = normalizedName(seed?.name);
  return ["LFJOLkJ7MByM4r2k", "STNVXaxbdukw43Wq"].includes(text(seed?.sourceActorId))
    || seed?.isCoCommander === true || ["co-commander", "cocommander", "капитан"].includes(command)
    || name.endsWith("рико маллье") || name.endsWith("эдгар тибо");
}

function newResidentFromSeed(seed, id, shipId, actorUuid) {
  const person = {
    id,
    name: text(seed?.name),
    role: "Свободен",
    workAssignment: "",
    sex: text(seed?.sex),
    race: text(seed?.race),
    subrace: text(seed?.subrace),
    ageGroup: text(seed?.ageGroup || "Вз"),
    age: seed?.age,
    culture: text(seed?.culture),
    belief: text(seed?.belief),
    background: text(seed?.background || seed?.profession),
    appearance: text(seed?.appearance),
    traitsText: text(seed?.traitsText),
    attributes: seed?.attributes && typeof seed.attributes === "object" ? { ...seed.attributes } : {},
    notes: text(seed?.notes),
    sourceSkills: seed?.sourceSkills && typeof seed.sourceSkills === "object" ? { ...seed.sourceSkills } : undefined,
    sourceImage: text(seed?.img),
    actorUuid: text(actorUuid),
    sourceActorId: text(seed?.sourceActorId),
    sourceCrewKey: seedKey(seed),
    shipCrewRank: text(seed?.rank),
    shipCrewRole: seedRole(seed),
    shipAssignment: { shipId, away: false }
  };
  normalizePerson(person);
  return person;
}

function canonicalizeFirstInstall(person, seed) {
  const name = normalizedName(seed?.name);
  if (text(seed?.sourceActorId) === "Crr0kvvWjWPJ0bpH" || name.endsWith("элина траззмар")) {
    person.age = 35;
    person.ageGroup = "Вз";
  }
  if (text(seed?.sourceActorId) === "0iAq5ZTMfdDntL0U" || name.includes("сабрина")) person.race = "Полуэльф";
}

export function isMagnifiqueShip(ship = {}) {
  const name = normalizedName(ship?.name);
  return name === "магнифик" || name === "magnifique";
}

/**
 * Installs the public Magnifique roster into a holding draft. The function never
 * creates Foundry Actors and does not copy arbitrary source fields or GM notes.
 */
export function installMagnifiqueCrewRoster(holding = {}, ship = {}, {
  seeds = MAGNIFIQUE_CREW,
  clockQd = 0,
  resolveActorUuid = null
} = {}) {
  if (!holding || typeof holding !== "object" || !ship || typeof ship !== "object") {
    throw new TypeError("FBL Skyhold | Для установки команды нужны черновики поселения и корабля.");
  }
  if (!isMagnifiqueShip(ship)) throw new Error("Готовый состав предназначен только для «Магнифика».");
  if (ship.navigationMode !== "world" || ship.location?.kind !== "home" || ship.activeVoyage) {
    throw new Error("Команду «Магнифика» можно добавить только дома между рейсами.");
  }
  const shipId = text(ship.id);
  if (!shipId) throw new TypeError("FBL Skyhold | У корабля отсутствует устойчивый ID.");
  if (!Array.isArray(seeds) || seeds.length !== 36) throw new Error("Состав «Магнифика» должен содержать ровно 36 человек: 27 исходных и 9 согласованных именных персонажей.");

  const keys = seeds.map(seedKey);
  if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error("В составе «Магнифика» повторяются или отсутствуют исходные ключи.");
  if (seeds.some((seed) => !text(seed?.name))) throw new Error("У каждого члена команды должно быть имя.");

  if (holding.people != null && !Array.isArray(holding.people?.list)) throw new TypeError("FBL Skyhold | Список жителей повреждён.");
  const residents = holding.people?.list ?? [];
  const otherShips = (holding.special?.ships?.list ?? []).filter((candidate) => text(candidate?.id) !== shipId);
  const occupiedByOtherShip = new Set(otherShips.flatMap((candidate) => candidate?.crewResidentIds ?? []).map(text).filter(Boolean));
  const matchedIds = new Set();
  const plan = [];

  for (const seed of seeds) {
    const match = matchSeedToResidents(seed, residents);
    if (match.matches.length > 1) {
      throw new Error(`Неоднозначное совпадение для члена команды «${text(seed.name)}» (${match.kind}). Уточните исходный ключ жителя.`);
    }
    const person = match.matches[0] ?? null;
    if (person) {
      const residentId = text(person.id);
      if (!residentId || matchedIds.has(residentId)) throw new Error(`Один житель совпал с несколькими записями команды: ${text(seed.name)}.`);
      if (occupiedByOtherShip.has(residentId) || (person?.shipAssignment?.away === true && text(person.shipAssignment.shipId) !== shipId)) {
        throw new Error(`${text(person.name) || residentId} уже связан с другим кораблём.`);
      }
      matchedIds.add(residentId);
    }
    plan.push({ seed, person });
  }
  const unmatchedExistingCrew = (ship.crewResidentIds ?? []).map(text).filter(Boolean).filter((id) => !matchedIds.has(id));
  if (unmatchedExistingCrew.length) {
    throw new Error("В команде «Магнифика» уже есть жители вне готового состава. Сначала уберите их вручную или свяжите с исходными персонажами.");
  }

  const occupiedIds = new Set(residents.map((person) => text(person?.id)).filter(Boolean));
  const firstInstall = !ship.magnifiqueCrewRoster?.version;
  const resolved = [];
  let created = 0;
  let reused = 0;
  if (!holding.people) holding.people = { list: residents };
  for (const row of plan) {
    let person = row.person;
    if (!person) {
      const id = uniqueResidentId(seedKey(row.seed), occupiedIds);
      occupiedIds.add(id);
      const actorUuid = typeof resolveActorUuid === "function" ? resolveActorUuid(row.seed) : row.seed?.sourceActorUuid;
      person = newResidentFromSeed(row.seed, id, shipId, actorUuid);
      residents.push(person);
      created += 1;
    } else {
      person.sourceCrewKey = seedKey(row.seed);
      person.sourceActorId ||= text(row.seed?.sourceActorId);
      person.shipCrewRank ||= text(row.seed?.rank);
      person.shipCrewRole ||= seedRole(row.seed);
      if (!text(person.actorUuid) && text(row.seed?.sourceActorUuid)) person.actorUuid = text(row.seed.sourceActorUuid);
      person.shipAssignment = { ...(person.shipAssignment ?? {}), shipId, away: false };
      if (firstInstall) canonicalizeFirstInstall(person, row.seed);
      reused += 1;
    }
    resolved.push({ seed: row.seed, person });
  }

  ship.crewResidentIds = resolved.map((row) => text(row.person.id));
  ship.crewTarget = 36;
  ship.commanderResidentId = text(resolved.find((row) => isCommanderSeed(row.seed))?.person?.id);
  ship.coCommanderResidentIds = resolved.filter((row) => isCoCommanderSeed(row.seed)).map((row) => text(row.person.id));
  ship.commanderName ||= text(resolved.find((row) => isCommanderSeed(row.seed))?.person?.name) || "Элина Траззмар";
  ship.magnifiqueCrewRoster = {
    ...(ship.magnifiqueCrewRoster ?? {}),
    id: ROSTER_ID,
    version: MAGNIFIQUE_CREW_VERSION,
    installedAtYear: Number(ship.magnifiqueCrewRoster?.installedAtYear ?? INSTALLATION_YEAR),
    installedAtQd: Number(ship.magnifiqueCrewRoster?.installedAtQd ?? Math.max(0, Math.floor(Number(clockQd) || 0)))
  };

  return {
    ok: true,
    rosterId: ROSTER_ID,
    rosterVersion: MAGNIFIQUE_CREW_VERSION,
    created,
    reused,
    total: resolved.length,
    crewResidentIds: [...ship.crewResidentIds],
    commanderResidentId: ship.commanderResidentId,
    coCommanderResidentIds: [...ship.coCommanderResidentIds]
  };
}
