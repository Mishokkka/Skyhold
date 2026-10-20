import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MAGNIFIQUE_CREW } from "../data/magnifique-crew.js";
import { extractMagnifiqueCrew } from "./build-magnifique-crew.mjs";

export async function checkMagnifiqueCrewContent() {
  const additions = JSON.parse(await readFile(new URL("../../docs/magnifique-crew-additions.json", import.meta.url), "utf8"));
  const originals = MAGNIFIQUE_CREW.filter((row) => row.origin === "compendium");
  assert.equal(originals.length, 27);
  assert.equal(additions.length, 9);
  assert.deepEqual(MAGNIFIQUE_CREW.filter((row) => row.origin === "authored"), additions);
  assert.equal(new Set(MAGNIFIQUE_CREW.map((row) => row.sourceCrewKey)).size, 36);
  assert.ok(Object.isFrozen(MAGNIFIQUE_CREW));
  const allowed = new Set(["sourceCrewKey", "origin", "sourceActorId", "name", "rank", "shipCrewRole", "age", "race", "subrace", "attributes", "background", "img", "appearance", "notes", "sourceSkills"]);
  for (const member of MAGNIFIQUE_CREW) {
    assert.ok(Object.keys(member).every((key) => allowed.has(key)), `Unexpected public field: ${member.name}`);
    assert.ok(member.name && member.shipCrewRole && Number.isInteger(member.age));
    assert.ok(Object.isFrozen(member.attributes));
    assert.deepEqual(Object.keys(member.attributes).sort(), ["agility", "empathy", "strength", "wits"]);
    assert.ok(Object.values(member.attributes).every((value) => Number.isInteger(value) && value >= 1 && value <= 6));
    assert.ok(!String(member.notes).includes("[object Object]"));
  }
  const byId = (id) => originals.find((row) => row.sourceActorId === id);
  assert.equal(byId("Crr0kvvWjWPJ0bpH").age, 35);
  assert.equal(byId("0iAq5ZTMfdDntL0U").race, "Полуэльф");
  assert.equal(byId("9eES91NFHfAKXYF4").age, 15, "Angvar keeps his original age");
  assert.equal(byId("hwQpMC10JeYgliw4").sourceSkills.healing, 3);

  // FBL's bio fields use {label,value}. Private Actor fields must never be
  // copied even if a future export adds more of them next to public content.
  const privateMarker = "PRIVATE_ACTOR_SENTINEL";
  const fixture = originals.map((member) => ({
    _id: member.sourceActorId, name: member.name, img: "icons/test.webp",
    ownership: { default: privateMarker }, flags: { secret: privateMarker },
    items: [{ name: privateMarker }],
    system: {
      secret: privateMarker,
      bio: {
        age: { value: member.age }, kin: { value: member.race }, profession: { value: "Fighter" },
        note: { label: privateMarker, value: "<p>Открытая история &amp; друзья.</p>" },
        face: { value: "Шрам" }, body: { value: "Высокий" }, clothing: { value: "Куртка" },
        darkSecret: { value: privateMarker }, pride: { value: privateMarker }
      },
      attribute: Object.fromEntries(Object.entries(member.attributes).map(([key, value]) => [key, { max: value, value: 1 }])),
      skill: { healing: { value: 2 } }
    }
  }));
  const extracted = extractMagnifiqueCrew({ actors: fixture }, additions);
  assert.equal(JSON.stringify(extracted).includes(privateMarker), false, "only whitelisted public values may enter the distributed roster");
  assert.equal(extracted[0].notes, "Открытая история & друзья.");
  assert.equal(extracted[0].appearance, "Шрам\nВысокий\nКуртка");
  assert.deepEqual(extracted[0].attributes, originals[0].attributes, "use full Actor attributes rather than current damage");
  assert.deepEqual(extractMagnifiqueCrew(fixture.map((value) => ({ key: `!actors!${value._id}`, value })), additions), extracted);
  assert.throws(() => extractMagnifiqueCrew(fixture.slice(1), additions), /Expected 27/);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkMagnifiqueCrewContent();
  console.log("FBL Skyhold Magnifique crew content: passed.");
}
