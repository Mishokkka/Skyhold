import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderMoraleDialog } from "../apps/domains/morale-dialog-presentation.js";

const baseContext = {
  holdingName: "Лапута <небо>",
  rawMorale: -8,
  state: {
    label: "Апатия",
    range: "-14 до -1",
    css: "low",
    icon: "fa-solid fa-face-meh",
    notes: "Поселение работает хуже."
  },
  control: {
    generalControl: 2,
    unrestOnlyControl: 1,
    orderRequirement: 4,
    disorderMorale: -5,
    institutionalCeiling: -5
  },
  sources: { people: -12, population: 20, buildings: 3, specialAndGm: 1 },
  levels: [
    { label: "Апатия", range: "-14 до -1", css: "low", icon: "fa-solid fa-face-meh", notes: "Штраф.", current: true },
    { label: "Равновесие", range: "0 до 15", css: "neutral", icon: "fa-solid fa-face-smile", notes: "Без штрафов." }
  ],
  residents: [{ name: "Ада <script>", total: -1, breakdown: ["База: -1"] }],
  buildings: [
    { name: "Таверна", raw: 3, value: 0, repeated: true, repeatAllowed: false, coverage: 0 },
    { name: "Баня", raw: 3, value: 2, repeated: false, coverage: 0.75, capacity: 15, coverageTarget: 20 }
  ]
};

export function checkMoraleDialogPresentation() {
  const playerHtml = renderMoraleDialog({ ...baseContext, isGm: false });
  assert.match(playerHtml, /Лапута &lt;небо&gt;/, "holding name must be escaped");
  assert.match(playerHtml, /Из чего складывается/, "dialog must explain the active total");
  assert.match(playerHtml, /Жители/, "dialog must show the resident aggregate");
  assert.match(playerHtml, /Здания/, "dialog must show the building aggregate");
  assert.match(playerHtml, /Прочие поправки/, "dialog must show the remaining aggregate without exposing its sources");
  assert.match(playerHtml, /Сырое довольство/, "dialog must distinguish raw morale from disorder morale");
  assert.match(playerHtml, /Для беспорядков/, "dialog must display the controlled disorder value");
  assert.match(playerHtml, /is-current/, "dialog must mark the active threshold");
  assert.doesNotMatch(playerHtml, /Ада|Таверна|Баня|Только ГМ/, "player view must not expose source details");

  const gmHtml = renderMoraleDialog({ ...baseContext, isGm: true });
  assert.match(gmHtml, /Только ГМ/, "GM view must identify private source details");
  assert.match(gmHtml, /Ада &lt;script&gt;/, "GM resident names must be escaped");
  assert.match(gmHtml, /Повторный эффект не учитывается/, "ignored repeated building effects must be explicit");
  assert.match(gmHtml, /Охват 15 из 20/, "partial service coverage must show capacity and target");
  assert.doesNotMatch(gmHtml, /Охват 0%/, "ignored repeats must not masquerade as service coverage");
  const leisureHtml = renderMoraleDialog({ ...baseContext, isGm: true, buildings: [
    { name: "Досуг", raw: 15, capacity: 15, value: 11, leisure: true, rank: 2, diversityFactor: 0.75, repeated: true, repeatAllowed: true }
  ] });
  assert.match(leisureHtml, /мощность 15 × 75% = \+11/, "GM can distinguish repeat attenuation from population coverage");

  // Exercise the actual launch options: rendering HTML alone cannot detect a
  // DialogV2 configuration that Foundry rejects before opening the window.
  const navigationSource = readFileSync(new URL("../apps/domains/events/navigation-events.js", import.meta.url), "utf8");
  const launchOptions = navigationSource.match(/await foundryDialogV2\(\)\.wait\((\{[\s\S]*?\n  \})\);/);
  assert.ok(launchOptions, "morale dialog launch options must be covered");
  const makeOptions = new Function("holding", "content", `return (${launchOptions[1]});`);
  for (const content of [playerHtml, gmHtml]) {
    const options = makeOptions({ name: "Лапута" }, content);
    assert.ok(Array.isArray(options.buttons) && options.buttons.length > 0, "Foundry DialogV2 requires at least one button even with a hidden footer");
    assert.ok(options.buttons.every((button) => button.action && button.label), "DialogV2 actions must have identifiers and labels");
    assert.equal(options.rejectClose, false, "closing with the window cross must resolve without rejection");
    assert.ok(options.classes.includes("fbl-skyhold-morale-dialog"), "the dialog must retain its footer-hiding shell style");
    assert.equal(options.content, content, "launch must preserve the permission-filtered content");
  }

}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkMoraleDialogPresentation();
  console.log("FBL Skyhold morale dialog presentation and launch-options check passed.");
}
