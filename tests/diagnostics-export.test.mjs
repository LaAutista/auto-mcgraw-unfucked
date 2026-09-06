import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, { handlers: {}, classList: { remove() {}, add() {} }, addEventListener(name, fn) { this.handlers[name] = fn; } });
  return elements.get(id);
};
let blob;
let clicked = false;
let fail = false;
const link = { click() { clicked = true; } };
const api = {
  permissions: { request: async ({ origins }) => {
    assert.deepEqual(Array.from(origins), ["https://smartfactory-api.prod.mheducation.com/*"]);
    return true;
  } },
  runtime: {
    getManifest: () => ({ version: "2.11.0" }),
    sendMessage: async (message) => {
      assert.equal(message.type, "getDiagnostics");
      if (fail) throw new Error("unavailable");
      return { received: true, version: 1, events: [{ stage: "answer.ready" }] };
    },
  },
  storage: { sync: { get() {} } },
};
vm.runInNewContext(readFileSync(new URL("../popup/settings.js", import.meta.url), "utf8"), {
  chrome: api, browser: api, Blob, Date,
  URL: { createObjectURL(value) { blob = value; return "blob:test"; }, revokeObjectURL() {} },
  document: {
    addEventListener(_event, fn) { fn(); },
    getElementById: element,
    createElement: () => link,
  },
  setInterval() {}, setTimeout(fn) { fn(); },
});
await element("export-diagnostics").handlers.click();
assert.equal(clicked, true);
assert.equal(link.href, "blob:test");
assert.match(link.download, /^auto-mcgraw-diagnostics-.*\.json$/);
assert.equal(JSON.parse(await blob.text()).events[0].stage, "answer.ready");
assert.equal(element("diagnostics-status").textContent, "Saved 1 diagnostic events.");
fail = true;
await element("export-diagnostics").handlers.click();
assert.match(element("diagnostics-status").textContent, /Could not save/);
await element("allow-question-images").handlers.click();
assert.equal(element("image-permission-status").textContent, "Question image access enabled.");
console.log("diagnostics export regressions: ok");
