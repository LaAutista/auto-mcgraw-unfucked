import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const tabs = new Map([
  [11, { id: 11, windowId: 7 }],
  [22, { id: 22, windowId: 8 }],
]);
const actions = [];
const messages = [];
const warnings = [];
const session = {};
let tabSwitchingEnabled;
let rejectFocus = false;
let rejectActivation = false;
let listener;
const context = vm.createContext({
  console: { warn: (...args) => warnings.push(args), error: console.error },
  setTimeout: (fn) => fn(),
  browser: {
    tabs: {
      query: async ({ url }) => [tabs.get(Array.isArray(url) ? 11 : 22)],
      get: async (id) => tabs.get(id),
      update: async (id, options) => {
        assert.equal(options.active, true);
        actions.push(`tab:${id}`);
        if (rejectActivation) throw new Error("Tab unavailable");
        return tabs.get(id);
      },
    },
    windows: {
      update: async (id, options) => {
        assert.equal(options.focused, true);
        actions.push(`window:${id}`);
        if (rejectFocus) throw new Error("Window focus denied");
      },
    },
    storage: {
      sync: { get: async () => ({ aiModel: "chatgpt", tabSwitchingEnabled }) },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (values) => Object.assign(session, values),
        remove: async (key) => { delete session[key]; },
      },
    },
  },
  chrome: {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, lastError: null },
    tabs: {
      onRemoved: { addListener() {} },
      sendMessage(id, message, callback) {
        messages.push({ id, ...message });
        callback({ received: true });
      },
    },
  },
});
const run = (source) => vm.runInContext(source, context);
run(readFileSync(new URL("../background/background.js", import.meta.url), "utf8"));
await run("findAndStoreTabs()");

rejectFocus = true;
assert.equal(await run("focusTab(22)"), true, "window focus failure hid tab activation");
assert.deepEqual(actions.splice(0), ["tab:22", "window:8"]);
assert.match(warnings.at(-1)[0], /Tab activated/);
rejectActivation = true;
assert.equal(await run("focusTab(22)"), false, "reported success for failed activation");
assert.deepEqual(actions.splice(0), ["tab:22"]);
assert.match(warnings.at(-1)[0], /Could not activate tab/);
rejectActivation = false;

for (const enabled of [undefined, false, true]) {
  tabSwitchingEnabled = enabled;
  // Keep rejecting window focus: both directions must still activate and deliver.
  await run(`processQuestion({
    requestId: "request", sourceTabId: 11, sourceWindowId: 7, question: "test"
  })`);
  assert.deepEqual(
    actions.splice(0),
    enabled === false ? [] : ["tab:22", "window:8"],
    `cross-window question switching with setting ${enabled}`
  );
  assert.equal(messages.at(-1).type, "receiveQuestion");
  assert.equal(messages.at(-1).id, 22);
  const delivery = await run('processResponse({ requestId: "request", response: "answer" })');
  assert.equal(delivery.received, true);
  assert.deepEqual(
    actions.splice(0),
    enabled === false ? [] : ["tab:11", "window:7"],
    `cross-window answer switching with setting ${enabled}`
  );
  assert.equal(messages.at(-1).type, "processChatGPTResponse");
  assert.equal(messages.at(-1).id, 11);
}

run("processingQuestion = true; allowQueuedRestart = false;");
const requestCount = messages.length;
const sendQuestion = (requestId) => new Promise((resolve) => listener({
  type: "sendQuestionToChatGPT", requestId,
  sourceTabId: 11, sourceWindowId: 7, question: "test",
}, {}, resolve));
const busy = await sendQuestion("busy");
assert.equal(busy.received, false, "acknowledged a dropped busy request as accepted");
assert.equal(busy.retryable, true);
assert.equal(busy.status, "busy");
assert.equal(messages.length, requestCount);
run("allowQueuedRestart = true;");
const queued = await sendQuestion("queued");
assert.equal(queued.received, true);
assert.equal(queued.status, "queued");
assert.equal(run("queuedRestart.requestId"), "queued");
run("processingQuestion = false; allowQueuedRestart = false; queuedRestart = null;");

console.log("firefox tab regressions: ok");
