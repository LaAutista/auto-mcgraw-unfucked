import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../background/background.js", import.meta.url), "utf8");
const persisted = {};
let rejectWrites = false;
let activeWrites = 0;
const local = {
  async get(key) { return { [key]: structuredClone(persisted[key]) }; },
  async set(values) {
    activeWrites++;
    assert.equal(activeWrites, 1, "diagnostic writes were not serialized");
    try {
      await Promise.resolve();
      if (rejectWrites) throw new Error("Storage unavailable");
      Object.assign(persisted, structuredClone(values));
    } finally {
      activeWrites--;
    }
  },
};
const settings = { url: "moz-extension://diagnostics/popup/settings.html" };
const provider = {
  url: "https://chatgpt.com/c/private-conversation?token=PRIVATE_TOKEN",
  tab: { id: 99, windowId: 8, url: "https://chatgpt.com/" },
  frameId: 3,
};

function background() {
  let listener;
  let transportFailures = 0;
  const session = {};
  const sent = [];
  const api = {
    runtime: {
      lastError: null,
      getURL: (path) => `moz-extension://diagnostics/${path}`,
      onMessage: { addListener: (fn) => { listener = fn; } },
    },
    tabs: {
      query: async ({ url }) => [{ id: Array.isArray(url) ? 11 : 22, windowId: 7 }],
      get: async (id) => ({ id, windowId: 7 }),
      update: async (id) => ({ id, windowId: 7 }),
      onRemoved: { addListener() {} },
      sendMessage(id, message, callback) {
        sent.push({ id, ...message });
        api.runtime.lastError = transportFailures-- > 0
          ? { message: "PRIVATE_TOKEN and private page contents" } : null;
        callback(api.runtime.lastError ? undefined : { received: true, status: "processing" });
        api.runtime.lastError = null;
      },
    },
    windows: { update: async () => {} },
    storage: {
      local,
      sync: { get: async () => ({ aiModel: "chatgpt" }) },
      session: {
        get: async (key) => ({ [key]: session[key] }),
        set: async (values) => Object.assign(session, values),
        remove: async (key) => { delete session[key]; },
      },
    },
  };
  const context = vm.createContext({
    URL, chrome: api, browser: api,
    console: { warn() {}, error() {}, log() {} },
    setTimeout: (fn) => fn(),
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  return {
    run, sent, api,
    failTransport: (count) => { transportFailures = count; },
    message: (message, sender = settings) => new Promise((resolve) => listener(message, sender, resolve)),
  };
}

const bg = background();
await bg.run("findAndStoreTabs()");
const tracking = bg.run("JSON.stringify([mheTabId, aiTabId, mheWindowId, aiWindowId])");
assert.equal((await bg.message({
  type: "diagnosticEvent", stage: "answer.received", requestId: "request-1",
  details: {
    optionCount: 4, hasAnswer: true, tabId: 999, frameId: 999,
    elapsedMs: NaN, answerCount: "PRIVATE_TOKEN", question: "PRIVATE_QUESTION",
    answer: "PRIVATE_ANSWER", url: "https://chatgpt.com/private", html: "<private>",
    cookie: "PRIVATE_COOKIE", error: "PRIVATE_ERROR", errorName: "PRIVATE_ERROR",
    status: "PRIVATE_STATUS",
  },
}, provider)).received, true);
assert.equal(bg.run("JSON.stringify([mheTabId, aiTabId, mheWindowId, aiWindowId])"), tracking,
  "a diagnostic from another tab changed active request routing");
let exported = await bg.message({ type: "getDiagnostics" });
assert.equal(exported.received, true);
assert.equal(exported.version, 1);
assert.equal(exported.events[0].source, "chatgpt.com");
assert.deepEqual(exported.events[0].details, { optionCount: 4, hasAnswer: true, tabId: 99, frameId: 3 });
assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_|private-conversation|token=/);
assert.equal((await bg.message({ type: "getDiagnostics" }, provider)).received, false);
for (const url of ["https://chatgpt.com.evil.test/", "http://chatgpt.com/"]) {
  assert.equal((await bg.message({ type: "diagnosticEvent", stage: "page.ready" }, { url })).received, false);
}
assert.equal((await bg.message({ type: "diagnosticEvent", stage: "PRIVATE PAGE CONTENT" }, provider)).received, false);
await bg.message({ type: "diagnosticEvent", stage: "page.ready", requestId: '{"question":"PRIVATE_QUESTION"}' }, provider);
exported = await bg.message({ type: "getDiagnostics" });
assert.equal(exported.events.at(-1).requestId, null);

// Concurrent enqueues must preserve every event until the bounded ring evicts it.
await bg.run(`Promise.all(Array.from({ length: 305 }, (_, i) =>
  recordDiagnostic("test.enqueue", "ring-" + i, { attempt: i })))`);
exported = await bg.message({ type: "getDiagnostics" });
assert.equal(exported.events.length, 300);
assert.equal(exported.events[0].requestId, "ring-5");
assert.equal(exported.events.at(-1).requestId, "ring-304");
assert.deepEqual(exported.events.map(({ details }) => details.attempt), Array.from({ length: 300 }, (_, i) => i + 5));
assert.ok(exported.events.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp))));
const restarted = background();
assert.deepEqual((await restarted.message({ type: "getDiagnostics" })).events, exported.events,
  "background restart lost persisted diagnostics");

rejectWrites = true;
assert.equal(await bg.run('recordDiagnostic("test.failure", "failed")'), false);
rejectWrites = false;
assert.equal(await bg.run('recordDiagnostic("test.recovered", "recovered")'), true,
  "one rejected write poisoned the queue");

bg.failTransport(1);
await bg.run('processQuestion({ requestId: "lifecycle", sourceTabId: 11, sourceWindowId: 7, question: { type: "multiple_select", question: "PRIVATE_QUESTION" } })');
assert.equal((await bg.run('processResponse({ requestId: "lifecycle", response: "PRIVATE_ANSWER" })')).received, true);
exported = await bg.message({ type: "getDiagnostics" });
const stages = exported.events.filter(({ requestId }) => requestId === "lifecycle").map(({ stage }) => stage);
assert.deepEqual(stages, [
  "question.enqueue", "question.send", "transport.retry", "question.provider_ack",
  "response.received", "response.route", "response.delivery",
]);
assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_/);

rejectWrites = true;
await bg.run('processQuestion({ requestId: "storage-down", sourceTabId: 11, sourceWindowId: 7, question: "test" })');
assert.equal((await bg.run('processResponse({ requestId: "storage-down", response: "test" })')).received, true,
  "diagnostic storage failure broke answer delivery");
await bg.run("diagnosticsWrites");
rejectWrites = false;

console.log("diagnostics regressions: ok");
