import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const makeMessage = (id, answer) => ({
  raw: JSON.stringify({ answer }),
  getAttribute: (name) => name === "data-message-id" ? id : null,
  get textContent() { return this.raw; },
  querySelectorAll() { return [{ textContent: this.raw }]; },
});
const messages = [makeMessage("old", "old answer")];
const sent = [];
const acknowledgments = [];
const intervals = new Map();
const timeouts = new Map();
let timerId = 0;
let now = 0;
let generating = false;
let listener;
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  Date: { now: () => now },
  setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; },
  clearInterval: (id) => intervals.delete(id),
  setTimeout: (fn) => { timeouts.set(++timerId, fn); return timerId; },
  clearTimeout: (id) => timeouts.delete(id),
  MutationObserver: class { observe() {} disconnect() {} },
  document: {
    body: {},
    getElementById: () => ({}),
    querySelector: (selector) =>
      selector === '[data-testid="stop-button"]' && generating ? {} : null,
    querySelectorAll: (selector) =>
      selector === '[data-message-author-role="assistant"]' ? messages : [],
  },
  chrome: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
  browser: {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        return new Promise((resolve) => acknowledgments.push(resolve));
      },
    },
  },
});
const run = (source) => vm.runInContext(source, context);
run(readFileSync(new URL("../content-scripts/chatgpt.js", import.meta.url), "utf8"));
run("waitForIdle = async () => true; submitToComposer = async () => true;");
const question = (requestId) => new Promise((resolve) => listener({
  type: "receiveQuestion", requestId,
  question: { type: "multiple_choice", question: "Choose a color", options: ["blue"] },
}, {}, resolve));
const tick = (ms = 0) => { now += ms; run("tryHandleResponse()"); };
const ack = async () => {
  acknowledgments.shift()({ received: true });
  await new Promise((resolve) => setImmediate(resolve));
};

await question("streaming");
const animated = makeMessage("new", "bl]()");
messages.push(animated);
generating = true;
tick(200000);
for (const timeout of timeouts.values()) timeout();
assert.equal(intervals.size, 1, "stopped watching a slow answer after three minutes");
assert.equal(sent.length, 0, "sent parseable but animated JSON while generating");
generating = false;
tick();
tick(5000);
assert.equal(sent.length, 0, "sent an animation placeholder that appeared stable in a hidden tab");
tick(600);
animated.raw = '{"answer":"blu"}';
tick();
tick(600);
assert.equal(sent.length, 0, "animation changes did not restart the quiet period");
animated.raw = '{"answer":';
tick();
tick(1500);
assert.equal(sent.length, 0, "sent incomplete JSON");
animated.raw = '{"answer":"blue"}';
tick();
tick(600);
generating = true;
tick(1500);
generating = false;
tick();
tick(999);
assert.equal(sent.length, 0, "time spent generating counted toward answer stability");
tick(1);
assert.equal(sent.length, 1);
assert.equal(JSON.parse(sent[0].response).answer, "blue");
assert.equal(sent[0].requestId, "streaming");
await ack();

await question("virtualized");
messages[messages.length - 1] = makeMessage("new", "blue");
tick();
tick(2000);
assert.equal(sent.length, 1, "accepted a remounted old message with the same ID");
messages.splice(0, messages.length, makeMessage("next", "blue"));
tick();
tick(1000);
assert.equal(sent.length, 2, "missed a new answer when old messages were virtualized");
assert.equal(sent[1].requestId, "virtualized");
await ack();

// Older layouts without message IDs retain occurrence-based node fallback.
const oldWithoutId = makeMessage(null, "blue");
messages.splice(0, messages.length, oldWithoutId);
await question("without-id");
tick();
tick(1000);
assert.equal(sent.length, 2, "accepted the same old node without an ID");
messages.splice(0, 1, makeMessage(null, "blue"));
tick();
tick(1000);
assert.equal(sent.length, 3, "node fallback lost a new answer without an ID");
await ack();

await question("canceled");
messages.push(makeMessage("canceled-answer", "blue"));
tick();
listener({ type: "cancelRequest", requestId: "canceled" }, {}, () => {});
tick(2000);
assert.equal(sent.length, 3, "delivered a canceled request's pending answer");
assert.equal(intervals.size, 0, "cancel left answer polling active");
await question("replacement");
messages.push(makeMessage("replacement-answer", "blue"));
tick();
listener({ type: "cancelRequest", requestId: "canceled" }, {}, () => {});
tick(999);
assert.equal(sent.length, 3, "replacement inherited the canceled quiet period");
tick(1);
assert.equal(sent.length, 4);
assert.equal(sent[3].requestId, "replacement");
await ack();

await question("empty-trailer");
messages.push(makeMessage("finished-with-trailer", "blue"));
const emptyTrailer = makeMessage("empty-trailer", "");
emptyTrailer.raw = "";
messages.push(emptyTrailer);
const sentBeforeTrailer = sent.length;
tick();
tick(1000);
assert.equal(sent.length, sentBeforeTrailer + 1, "empty assistant trailer hid the finished answer");
await ack();

await question("nonempty-trailer");
messages.push(makeMessage("earlier-part", "blue"));
const thinkingTrailer = makeMessage("newer-thinking", "");
thinkingTrailer.raw = "Thinking";
messages.push(thinkingTrailer);
const sentBeforeThinking = sent.length;
tick();
tick(2000);
assert.equal(sent.length, sentBeforeThinking, "skipped a newer nonempty assistant message");

console.log("chatgpt streaming regressions: ok");
