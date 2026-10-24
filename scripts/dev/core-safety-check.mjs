import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rollInlineDice } from "../core/formula.js";
import { escapeAttribute, escapeHtml } from "../utils/html.js";

/** Asserts browser/headless quote escaping and legal dice endpoints, then restores the original document global. */
export function checkCoreSafety() {
  const value = `" autofocus onfocus="alert('test')" <&>`;
  const expected = "&quot; autofocus onfocus=&quot;alert(&#039;test&#039;)&quot; &lt;&amp;&gt;";
  const hadDocument = Object.hasOwn(globalThis, "document");
  const previousDocument = globalThis.document;
  try {
    delete globalThis.document;
    assert.equal(escapeHtml(value), expected, "headless HTML escaping must encode both quote styles");
    assert.equal(escapeAttribute(value), expected, "attribute values must remain inside their quoted attribute");
    globalThis.document = {
      createElement() {
        // Serializing a text node escapes markup, but leaves quotes intact.
        return {
          set innerText(text) { this.text = text; },
          get innerHTML() { return this.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
        };
      }
    };
    assert.equal(escapeHtml(value), expected, "a browser document must not weaken quote escaping");
    assert.equal(escapeAttribute(value), expected, "browser attribute escaping must match headless escaping");
    assert.equal(escapeHtml(null), "", "empty values must remain empty");
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
  }

  assert.equal(rollInlineDice("1d6 + 2d4", () => 0), "1 + 2", "the valid random endpoint zero must still roll one on every die");
  assert.equal(rollInlineDice("1d6 + 2d4", () => 1 - Number.EPSILON), "6 + 8", "upper random values must remain within the die bounds");
  assert.equal(rollInlineDice("1d6 + 2d4", () => 0.5), "3 + 4", "existing deterministic midpoint results must remain stable");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  checkCoreSafety();
  console.log("Core safety: browser/headless quote escaping and inline dice endpoints passed.");
}
