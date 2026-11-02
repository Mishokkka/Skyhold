import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { transportHistoryFixture, transportHistoryApp } from "./fixtures/transport-history.mjs";
import { prepareTransportContext, transportSourceToken } from "../apps/domains/transport-context.js";

const f = transportHistoryFixture(), app = await transportHistoryApp(f);
async function median(run) {
  await run();
  const values = [];
  for (let i = 0; i < 7; i++) { const start = performance.now(); await run(); values.push(performance.now() - start); }
  return Number(values.sort((a, b) => a - b)[3].toFixed(2));
}
const rows = [];
for (const count of [0, 100, 500, 1000]) {
  f.append(count);
  app.request = null;
  const row = { orders: count, runs: f.data.meta.transportV2.runs.length,
    tokenMs: await median(() => transportSourceToken(f.data, f.holding)),
    quoteMs: await median(() => prepareTransportContext({ ...f, request: f.request, isGM: true })),
    windowMs: await median(() => app._prepareContext({})) };
  app.request = f.request;
  row.windowWithQuoteMs = await median(() => app._prepareContext({}));
  rows.push(row); console.log(JSON.stringify(row));
}
if (process.argv.includes("--check")) {
  const base = rows[0], last = rows.at(-1);
  for (const [key, limit] of [["tokenMs", 100], ["quoteMs", 150], ["windowMs", 100], ["windowWithQuoteMs", 150]]) {
    assert.ok(last[key] <= limit, `${key}: ${last[key]} ms exceeds ${limit} ms`);
    assert.ok(last[key] <= base[key] * 3 + 20, `${key} grows with completed history: ${base[key]} -> ${last[key]} ms`);
  }
}
console.log("Transport history performance passed.");
