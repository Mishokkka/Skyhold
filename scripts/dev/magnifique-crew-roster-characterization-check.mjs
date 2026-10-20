import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { createShipOperationExecutor } from "../apps/ship-operation-executor.js";
import { shipOperationIntent } from "../apps/domains/events/ship-events.js";
import { prepareShipWindowContext } from "../apps/ships-context.js";
import { MAGNIFIQUE_CREW } from "../data/magnifique-crew.js";
import { createShipRecord } from "../data/ships.js";
import { installMagnifiqueCrewRoster } from "../engines/ships/crew-roster.js";
import { advanceWorldShipEconomy } from "../engines/ships/world-economy.js";
import { advanceWorldShips, initializeWorldShip } from "../engines/ships/world-voyage.js";
import { worldMarketFixture } from "./world-ship-market-characterization-check.mjs";

function blankHolding() {
  return {
    id: "holding", name: "Дом", people: { list: [] },
    special: { ships: { list: [], offers: [], history: [], worldOfferLocks: {} } }
  };
}

function homeMagnifique(id = "magnifique") {
  const ship = createShipRecord(id);
  ship.name = "Магнифик";
  ship.navigationMode = "world";
  ship.profileId = "merchant-barque";
  ship.location = { kind: "home", id: "holding", label: "Дом" };
  return ship;
}

export async function checkMagnifiqueCrewRosterCharacterization() {
  const holding = blankHolding();
  const ship = homeMagnifique();
  holding.special.ships.list.push(ship);
  const installed = installMagnifiqueCrewRoster(holding, ship, { clockQd: 80 });
  assert.deepEqual({ created: installed.created, reused: installed.reused, total: installed.total }, { created: 36, reused: 0, total: 36 });
  assert.equal(new Set(ship.crewResidentIds).size, 36);
  assert.equal(ship.crewTarget, 36);
  assert.equal(holding.people.list.length, 36);
  assert.ok(holding.people.list.every((person) => person.shipAssignment?.shipId === ship.id && person.shipAssignment.away === false));
  assert.ok(holding.people.list.every((person) => person.role === "Свободен" && person.workAssignment === ""));
  assert.ok(holding.people.list.every((person) => !person.actorUuid), "the resident roster must not invent live World Actor UUIDs");
  assert.equal(ship.magnifiqueCrewRoster.installedAtYear, 882);
  assert.equal(ship.magnifiqueCrewRoster.installedAtQd, 80);

  const elina = holding.people.list.find((person) => person.sourceActorId === "Crr0kvvWjWPJ0bpH");
  const sabrina = holding.people.list.find((person) => person.sourceActorId === "0iAq5ZTMfdDntL0U");
  assert.equal(elina.age, 35);
  assert.equal(sabrina.race, "Полуэльф");
  assert.equal(ship.commanderResidentId, elina.id);
  assert.equal(ship.coCommanderResidentIds.length, 2);
  assert.equal(elina.shipCrewRole, "Командующая кораблём");
  const rosterView = prepareShipWindowContext(holding, { shipId: ship.id }).rows[0].crewRoster;
  assert.equal(rosterView.length, 36);
  assert.equal(rosterView.find((row) => row.id === elina.id).duty, "Командующая кораблём");
  assert.ok(rosterView.every((row) => row.status === "Отдыхает на борту"));
  assert.ok(rosterView.every((row) => !Object.hasOwn(row, "sourceSkills") && !Object.hasOwn(row, "notes")));
  assert.ok(elina.notes.includes("душа и сердце"), "the explicitly public biography may be copied");
  assert.equal("system" in elina, false, "arbitrary Actor data and private fields must not enter residents");

  elina.age = 36;
  sabrina.race = "Пользовательская запись";
  sabrina.notes = "Дополнено игроком";
  const replay = installMagnifiqueCrewRoster(holding, ship, { clockQd: 120 });
  assert.deepEqual({ created: replay.created, reused: replay.reused, total: replay.total }, { created: 0, reused: 36, total: 36 });
  assert.equal(elina.age, 36, "a repeated install must not reset elapsed age");
  assert.equal(sabrina.race, "Пользовательская запись", "a repeated install must preserve resident edits");
  assert.equal(sabrina.notes, "Дополнено игроком");
  assert.equal(ship.magnifiqueCrewRoster.installedAtQd, 80, "repeat install retains the first installation date");

  const reusedHolding = blankHolding();
  const reusedShip = homeMagnifique("reuse");
  reusedHolding.special.ships.list.push(reusedShip);
  reusedHolding.people.list.push({
    id: "existing-elina", name: "Элина Траззмар", age: 77, race: "Человек", notes: "Пользовательская заметка",
    sourceActorId: "Crr0kvvWjWPJ0bpH", actorUuid: "Actor.live-elina", attributes: {},
    shipAssignment: { shipId: "previous-ship", away: false }
  }, {
    id: "existing-sabrina", name: "Переименованная Сабрина", age: 20, race: "Человек",
    actorUuid: "Actor.0iAq5ZTMfdDntL0U", attributes: {}
  });
  const reusedResult = installMagnifiqueCrewRoster(reusedHolding, reusedShip);
  assert.equal(reusedResult.created, 34);
  assert.equal(reusedResult.reused, 2);
  const reusedElina = reusedHolding.people.list.find((person) => person.id === "existing-elina");
  assert.equal(reusedElina.age, 35, "the confirmed year-882 canon is applied once during the initial roster link");
  assert.equal(reusedElina.notes, "Пользовательская заметка");
  assert.equal(reusedElina.actorUuid, "Actor.live-elina");
  assert.equal(reusedElina.shipAssignment.shipId, reusedShip.id, "the last completed voyage is not current membership in another crew");
  assert.equal(reusedHolding.people.list.find((person) => person.id === "existing-sabrina").race, "Полуэльф");

  const ambiguous = blankHolding();
  const ambiguousShip = homeMagnifique("ambiguous");
  ambiguous.special.ships.list.push(ambiguousShip);
  ambiguous.people.list.push(
    { id: "one", name: MAGNIFIQUE_CREW[0].name },
    { id: "two", name: MAGNIFIQUE_CREW[0].name }
  );
  const beforeAmbiguous = structuredClone(ambiguous);
  assert.throws(() => installMagnifiqueCrewRoster(ambiguous, ambiguousShip), /Неоднозначное совпадение/);
  assert.deepEqual(ambiguous, beforeAmbiguous, "an ambiguous match must block before any resident or ship mutation");

  const conflict = blankHolding();
  const conflictShip = homeMagnifique("target");
  conflict.people.list.push({ id: "elina", name: "Адмирал Элина Траззмар", sourceActorId: "Crr0kvvWjWPJ0bpH" });
  conflict.special.ships.list.push(conflictShip, { id: "other", crewResidentIds: ["elina"] });
  const beforeConflict = structuredClone(conflict);
  assert.throws(() => installMagnifiqueCrewRoster(conflict, conflictShip), /другим кораблём/);
  assert.deepEqual(conflict, beforeConflict, "membership in another ship must block the whole install atomically");

  const customCrew = blankHolding();
  const customCrewShip = homeMagnifique("custom");
  customCrew.people.list.push({ id: "custom-sailor", name: "Свой матрос", shipAssignment: { shipId: "custom", away: false } });
  customCrewShip.crewResidentIds = ["custom-sailor"];
  customCrew.special.ships.list.push(customCrewShip);
  const beforeCustomCrew = structuredClone(customCrew);
  assert.throws(() => installMagnifiqueCrewRoster(customCrew, customCrewShip), /жители вне готового состава/);
  assert.deepEqual(customCrew, beforeCustomCrew, "install must not leave an omitted home crew marker behind");

  assert.deepEqual(shipOperationIntent({
    type: "install-magnifique-crew", holding: { id: "holding" }, ship: { id: "ship" },
    card: null, button: { closest: () => null }
  }), { type: "install-magnifique-crew", holdingId: "holding", shipId: "ship" });

  const gm = { id: "gm", isGM: true };
  const player = { id: "player", isGM: false };
  let data = worldMarketFixture().data;
  data.holdings[0].visibility = "public";
  data.holdings[0].gm.playersCanManageShips = true;
  data.holdings[0].people.list = [];
  data.holdings[0].special.ships.list = [];
  data.holdings[0].special.ships.offers = [];
  let commits = 0;
  const skipToken = Symbol("skip");
  const execute = createShipOperationExecutor({
    getUser: (id) => id === gm.id ? gm : id === player.id ? player : null,
    random: () => 0.99,
    skip: (value) => ({ [skipToken]: true, value }),
    updateHolding: async (id, updater) => {
      const draft = structuredClone(data);
      const target = draft.holdings.find((row) => row.id === id);
      const result = await updater(target, draft);
      if (result?.[skipToken]) return result.value;
      draft.meta.revision += 1;
      data = draft;
      commits += 1;
      return result;
    }
  });
  const createOperation = {
    type: "create-profile", operationId: "create-magnifique", holdingId: "holding", expectedRevision: data.meta.revision,
    profileId: "merchant-barque", shipName: "Магнифик"
  };
  const created = await execute(createOperation, { userId: gm.id });
  assert.equal(created.crewRoster.total, 36);
  assert.equal(data.holdings[0].people.list.length, 36);
  assert.equal(data.holdings[0].special.ships.list[0].crewResidentIds.length, 36);
  assert.equal(commits, 1, "ship and roster are created in one holding transaction");
  assert.equal((await execute(createOperation, { userId: gm.id })).replay, true);
  assert.equal(commits, 1, "authority replay must not create another roster");

  const createdShip = data.holdings[0].special.ships.list[0];
  const generated = await execute({
    type: "generate-world", operationId: "generate-roster-leg", holdingId: "holding", shipId: createdShip.id,
    expectedRevision: data.meta.revision, locationKind: "home", locationId: "holding"
  }, { userId: player.id, remote: true });
  assert.ok(generated.offerCount > 0);
  const offer = data.holdings[0].special.ships.offers.find((row) => row.shipId === createdShip.id && !row.consumedBy);
  await execute({
    type: "depart-world", operationId: "depart-roster", holdingId: "holding", shipId: createdShip.id,
    expectedRevision: data.meta.revision, offerId: offer.id, style: "normal", budgetCopper: null,
    locationKind: "home", locationId: "holding"
  }, { userId: player.id, remote: true });
  assert.ok(data.holdings[0].people.list.every((person) => person.shipAssignment?.away === true), "all 36 linked residents leave settlement work on departure");
  assert.ok(prepareShipWindowContext(data.holdings[0], { shipId: data.holdings[0].special.ships.list[0].id }).rows[0].crewRoster.every((row) => row.status === "В рейсе"));
  let active = data.holdings[0].special.ships.list[0];
  let arrivalQd = active.activeVoyage.arrivalQd;
  advanceWorldShips(data.holdings[0], arrivalQd);
  data.holdings[0].gm.calendaria.lastQd = arrivalQd;
  await execute({
    type: "resolve-world", operationId: "resolve-roster", holdingId: "holding", shipId: active.id,
    expectedRevision: data.meta.revision, voyageId: active.activeVoyage.id
  }, { userId: player.id, remote: true });
  active = data.holdings[0].special.ships.list[0];
  assert.equal(active.location.kind, "market");
  await execute({
    type: "return-home", operationId: "return-roster", holdingId: "holding", shipId: active.id,
    expectedRevision: data.meta.revision, locationKind: active.location.kind, locationId: active.location.id
  }, { userId: player.id, remote: true });
  active = data.holdings[0].special.ships.list[0];
  arrivalQd = active.activeVoyage.arrivalQd;
  advanceWorldShipEconomy(data.holdings[0], arrivalQd, { work: [], skipped: [], treasury: { spent: 0 } }, () => {});
  assert.ok(data.holdings[0].people.list.every((person) => person.shipAssignment?.away === false), "all roster residents become available after home return processing");

  let separate = worldMarketFixture().data;
  separate.holdings[0].people.list = [];
  separate.holdings[0].special.ships.list = [];
  const existingShip = createShipRecord("existing-magnifique");
  existingShip.name = "Магнифик";
  initializeWorldShip(separate.holdings[0], existingShip, { profileId: "merchant-barque", clockQd: 0 });
  separate.holdings[0].special.ships.list.push(existingShip);
  commits = 0;
  data = separate;
  const installOperation = {
    type: "install-magnifique-crew", operationId: "install-roster", holdingId: "holding", shipId: existingShip.id,
    expectedRevision: data.meta.revision
  };
  await assert.rejects(execute(installOperation, { userId: player.id, remote: true }), /Нет права/);
  assert.equal(commits, 0);
  const authorityInstall = await execute(installOperation, { userId: gm.id });
  assert.deepEqual({ created: authorityInstall.created, total: authorityInstall.total }, { created: 36, total: 36 });
  assert.equal(commits, 1);
  assert.equal((await execute(installOperation, { userId: gm.id })).replay, true);
  assert.equal(commits, 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkMagnifiqueCrewRosterCharacterization();
  console.log("FBL Skyhold Magnifique crew roster characterization: passed.");
}
