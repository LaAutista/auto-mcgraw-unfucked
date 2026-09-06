import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

let previews = 0;
let changed = false;
let now = 0;
const upload = { dispatchEvent(event) { assert.equal(event.type, "change"); changed = true; } };
const send = { disabled: true };
const form = {
  querySelector(selector) {
    if (selector === 'input[type="file"]') return upload;
    if (selector === '[data-testid="send-button"]') return send;
    return null;
  },
  querySelectorAll: () => Array.from({ length: previews }, () => ({})),
};
const context = vm.createContext({
  console: { log() {} },
  chrome: { runtime: { onMessage: { addListener() {} }, sendMessage() {} } },
  Date: { now: () => now },
  File, Event, atob, Uint8Array,
  DataTransfer: class {
    files = [];
    items = { add: (file) => this.files.push(file) };
  },
  input: { closest: () => form },
});
const run = (source) => vm.runInContext(source, context);
run(readFileSync(new URL("../content-scripts/chatgpt.js", import.meta.url), "utf8"));
run('activeRequestId = "image"');
let waits = 0;
context.sleep = async () => {
  waits++;
  now += 250;
  assert.equal(changed, true);
  previews = 1;
  // Even with a preview, do not submit while the upload disables Send.
  if (waits === 2) send.disabled = false;
};
assert.equal(await run('attachQuestionImages(input, [{dataUrl:"data:image/png;base64,aGVsbG8="}], "image")'), true);
assert.equal(waits, 2);
assert.equal(upload.files[0].name, "mcgraw-question-1.png");
assert.equal(await upload.files[0].text(), "hello");
await assert.rejects(run('attachQuestionImages(input, [{dataUrl:"data:image/png;base64,aA=="}], "image")'), /existing/);
previews = 0;
await assert.rejects(run('attachQuestionImages(input, [{dataUrl:"https://untrusted.test/image"}], "image")'), /safely/);
changed = false;
assert.equal(await run('attachQuestionImages(input, [{dataUrl:"data:image/png;base64,aA=="}], "canceled")'), false);
assert.equal(changed, false);
console.log("ChatGPT image upload regressions: ok");
