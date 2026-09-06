import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = "https://smartfactory-api.prod.mheducation.com/files/smart-factory/package/image.png";
const png = new Uint8Array([137, 80, 78, 71, 0, 255, 128]);
const calls = [];
const timers = new Map();
const messages = [];
const logs = [];
const session = {};
let nextTimer = 0;
let respond = () => new Response(png, { headers: { "content-type": "image/png" } });
const api = {
  runtime: { onMessage: { addListener() {} }, lastError: null },
  tabs: {
    query: async ({ url }) => [{ id: Array.isArray(url) ? 11 : 22, windowId: 7 }],
    onRemoved: { addListener() {} },
    get: async (id) => ({ id, windowId: 7 }),
    update: async (id) => ({ id, windowId: 7 }),
    sendMessage(id, message, callback) { messages.push({ id, ...message }); callback({ received: true }); },
  },
  windows: { update: async () => {} },
  storage: {
    sync: { get: async () => ({ aiModel: "chatgpt" }) },
    session: {
      get: async (key) => ({ [key]: session[key] }),
      set: async (values) => Object.assign(session, values),
      remove: async (key) => { delete session[key]; },
    },
  },
};
const context = vm.createContext({
  URL, AbortController, btoa, chrome: api, browser: api,
  console: { log() {}, warn() {}, error() {} },
  setTimeout(fn, ms) {
    if (ms === 15000) { timers.set(++nextTimer, fn); return nextTimer; }
    fn();
  },
  clearTimeout: (id) => timers.delete(id),
  async fetch(url, options) { calls.push({ url, options }); return respond(options.signal); },
  logs,
});
const run = (code) => vm.runInContext(code, context);
run(readFileSync(new URL("../background/background.js", import.meta.url), "utf8"));
run("recordDiagnostic = (stage, requestId, details) => logs.push({stage, requestId, details});");
await run("findAndStoreTabs()");
const question = { type: "multiple_choice", question: "Read diagram", images: [{ src, alt: "diagram" }] };
const resolve = (q = question, provider = "chatgpt") => {
  context.question = q;
  context.provider = provider;
  return run('resolveQuestionImages(question, provider, "image-test")');
};
const original = JSON.stringify(question);
const result = await resolve();
assert.equal(JSON.stringify(question), original, "mutated parsed question images");
assert.equal(result.images[0].src, src);
assert.equal(result.images[0].alt, "diagram");
assert.equal(result.images[0].dataUrl, `data:image/png;base64,${Buffer.from(png).toString("base64")}`);
assert.equal(calls[0].options.credentials, "include");
assert.equal(calls[0].options.redirect, "error");
assert.equal(calls[0].options.signal.aborted, true, "finished download did not release its request");
assert.equal(timers.size, 0);
assert.doesNotMatch(JSON.stringify(logs), /data:|diagram|smart-factory/);
assert.equal(logs.at(-1).details.imageCount, 1);

const requestsBeforeInvalid = calls.length;
for (const badSrc of [
  "https://evil.test/image.png", src.replace("https:", "http:"),
  src.replace("/files/smart-factory/", "/private/"), `${src}?token=secret`,
  `${src}#secret`, src.replace("https://", "https://name:secret@"),
]) await assert.rejects(resolve({ ...question, images: [{ src: badSrc }] }), /supported McGraw image/);
await assert.rejects(resolve(question, "gemini"), /require ChatGPT/);
await assert.rejects(resolve({ ...question, images: Array(5).fill(question.images[0]) }), /at most four/);
assert.equal(calls.length, requestsBeforeInvalid, "downloaded a rejected image URL or provider");

api.permissions = {
  async contains({ origins }) {
    assert.deepEqual([...origins], ["https://smartfactory-api.prod.mheducation.com/*"]);
    return false;
  },
};
await assert.rejects(resolve(), /Enable question image access in extension settings/);
assert.equal(calls.length, requestsBeforeInvalid, "fetched before image host permission was granted");
api.permissions.contains = async () => true;

for (const mime of ["image/jpeg", "image/webp", "image/gif"]) {
  respond = () => new Response(png, { headers: { "content-type": `${mime}; charset=binary` } });
  assert.ok((await resolve()).images[0].dataUrl.startsWith(`data:${mime};base64,`));
}
respond = () => new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
await assert.rejects(resolve(), /unsupported image format/);
respond = () => new Response(png, { headers: { "content-type": "image/png", "content-length": 2097153 } });
await assert.rejects(resolve(), /2 MiB/);
respond = () => new Response(new Uint8Array(2097153), { headers: { "content-type": "image/png" } });
await assert.rejects(resolve(), /2 MiB/, "trusted a missing content-length over the streamed byte count");
respond = () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } });
await assert.rejects(resolve(), /empty/);
respond = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
const timedOut = resolve();
await new Promise((resolve) => setImmediate(resolve));
for (const timeout of timers.values()) timeout();
await assert.rejects(timedOut, /timed out/);
assert.equal(timers.size, 0);

respond = () => new Response("Forbidden", { status: 403 });
context.question = question;
const failure = await run('processQuestion({requestId:"image-failure",sourceTabId:11,sourceWindowId:7,question})');
assert.equal(failure.received, false);
assert.match(failure.error, /HTTP 403/);
assert.equal(messages.some(({ type }) => type === "receiveQuestion"), false, "sent an image question as text only");
assert.ok(messages.some(({ type, message }) => type === "alertMessage" && message.includes("HTTP 403")));
assert.ok(messages.some(({ type }) => type === "stopAutomation"));

console.log("question image regressions: ok");
