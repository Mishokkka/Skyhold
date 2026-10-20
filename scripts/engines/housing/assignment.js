import { isResidentInPopulation } from "../../data/resident-presence.js";

function text(value) {
  return String(value ?? "").trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function homeKey(building = {}) {
  return text(building.id) || text(building.name);
}

export function assignResidentsToFreeHousing(holding = {}, { isResidentialBuilding = () => false } = {}) {
  const people = (holding?.people?.list ?? []).filter((person) => person && isResidentInPopulation(person, holding));
  const homes = (holding?.buildings?.list ?? [])
    .filter((building) => isResidentialBuilding(building))
    .filter((building) => homeKey(building))
    .map((building) => ({
      building,
      key: homeKey(building),
      id: text(building.id) || text(building.name),
      name: text(building.name) || text(building.id),
      capacity: Math.max(0, number(building?.housing?.capacity, 0)),
      comfort: number(building?.housing?.comfort, 0),
      quality: number(building?.housing?.quality, 0),
      occupied: 0
    }));

  if (!homes.length) {
    return { assigned: 0, remaining: people.length, homes: 0, message: "Нет действующих жилых зданий." };
  }

  const homeByValue = new Map();
  for (const row of homes) {
    const id = text(row.building.id);
    const name = text(row.building.name);
    if (id) homeByValue.set(id, row);
    if (name) homeByValue.set(name, row);
  }

  const candidates = [];
  for (const person of people) {
    const current = homeByValue.get(text(person.home));
    if (current) current.occupied += 1;
    else candidates.push(person);
  }

  homes.sort((a, b) =>
    b.comfort - a.comfort
    || b.quality - a.quality
    || a.name.localeCompare(b.name, "ru")
  );
  candidates.sort((a, b) => text(a.name).localeCompare(text(b.name), "ru"));

  let assigned = 0;
  for (const person of candidates) {
    const home = homes.find((row) => row.capacity === 0 || row.occupied < row.capacity);
    if (!home) break;
    person.home = home.id;
    home.occupied += 1;
    assigned += 1;
  }

  const remaining = candidates.length - assigned;
  const message = assigned
    ? `Расселено жителей: ${assigned}${remaining ? `. Без жилья осталось: ${remaining}.` : "."}`
    : remaining
      ? `Свободных мест нет. Без жилья осталось: ${remaining}.`
      : "Все жители уже обеспечены жильём.";
  return { assigned, remaining, homes: homes.length, message };
}
