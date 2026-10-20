import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  countSkyholdPerformance,
  getSkyholdPerformanceSnapshot,
  measureSkyholdPerformance,
  resetSkyholdPerformance,
  startSkyholdPerformanceScenario,
  stopSkyholdPerformanceScenario
} from "../data/performance-observer.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function checkPerformanceObserver() {
  const hadOverride = Object.hasOwn(globalThis, "fblSkyholdPerformance");
  const previousOverride = globalThis.fblSkyholdPerformance;

  try {
    globalThis.fblSkyholdPerformance = false;
    resetSkyholdPerformance();
    assert.equal(measureSkyholdPerformance("disabled", () => 7), 7, "disabled observer must preserve sync return values");
    assert.deepEqual(getSkyholdPerformanceSnapshot().timings, {}, "runtime metrics must remain empty while disabled");

    globalThis.fblSkyholdPerformance = true;
    resetSkyholdPerformance();
    assert.equal(measureSkyholdPerformance("sync", () => 11), 11, "observer must preserve sync return values");
    assert.equal(await measureSkyholdPerformance("async", async () => 13), 13, "observer must preserve async return values");
    countSkyholdPerformance("render", 2);
    const enabled = getSkyholdPerformanceSnapshot();
    assert.equal(enabled.timings.sync.count, 1, "observer must record sync timings");
    assert.equal(enabled.timings.async.count, 1, "observer must record async timings");
    assert.equal(enabled.counters.render, 2, "observer must record explicit counters");

    globalThis.fblSkyholdPerformance = false;
    const started = startSkyholdPerformanceScenario("mouse-overview", { role: "player" });
    assert.equal(started.scenario.name, "mouse-overview", "manual profile must expose its scenario name");
    measureSkyholdPerformance("scenario.action", () => true);
    const stopped = stopSkyholdPerformanceScenario({ source: "characterization" });
    assert.equal(stopped.scenario.name, "mouse-overview", "stopped profile must retain scenario metadata");
    assert.equal(stopped.source, "characterization", "stopped profile must include caller metrics");
    assert.equal(stopped.timings["scenario.action"].count, 1, "manual profile must collect scenario timings");
    assert.equal(globalThis.fblSkyholdPerformance, false, "manual profile must restore the previous client override");
  } finally {
    resetSkyholdPerformance();
    if (hadOverride) globalThis.fblSkyholdPerformance = previousOverride;
    else delete globalThis.fblSkyholdPerformance;
  }

  const store = readFileSync(path.join(root, "scripts/data/store.js"), "utf8");
  const splitStorage = readFileSync(path.join(root, "scripts/data/split-storage.js"), "utf8");
  const app = readFileSync(path.join(root, "scripts/apps/skyhold-app.js"), "utf8");
  const main = readFileSync(path.join(root, "scripts/main.js"), "utf8");
  assert.match(store, /measureSkyholdPerformance\("SkyholdData\.get"/, "SkyholdData.get must expose live timing");
  assert.match(store, /measureSkyholdPerformance\("SkyholdData\.commit"/, "command commits must expose live timing");
  assert.match(splitStorage, /measureSkyholdPerformance\("SkyholdData\.normalize"/, "cold-path normalization must expose live timing");
  assert.match(splitStorage, /countSkyholdPerformance\("Foundry\.settings\.read"\)/, "settings reads must expose a live counter");
  assert.match(app, /measureSkyholdPerformance\("SkyholdApp\.prepareContext"/, "ApplicationV2 context preparation must expose live timing");
  assert.match(app, /finishSkyholdPerformanceTimer\("SkyholdApp\.renderEndToEnd"/, "ApplicationV2 render completion must expose end-to-end timing");
  assert.match(main, /performance:\s*\{[\s\S]{0,1200}start:[\s\S]{0,500}stop:/, "module API must expose manual profile scenarios");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await checkPerformanceObserver();
  console.log("FBL Skyhold performance observer: disabled-by-default and live profile contracts passed.");
}
