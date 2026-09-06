import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const element = (text = "", classes = []) => ({
  nodeType: 1, nodeName: "SPAN", style: {}, attributes: {},
  childNodes: [{ nodeType: 3, textContent: text }],
  classList: { contains: (name) => classes.includes(name) },
  setAttribute(name, value) { this.attributes[name] = value; },
  getAttribute(name) { return this.attributes[name] || null; },
});
const choiceText = element("shorter; longer");
const feedback = element("correct", ["correctness"]);
const label = element();
label.childNodes = [choiceText, feedback];
label.querySelector = (selector) => selector === ".choiceText" ? choiceText : null;
const choice = { getAttribute: (name) => name === "aria-labelledby" ? "label" : null };
const container = { querySelector: () => null, querySelectorAll: () => [] };
let currentContainer = container;
let nextButton = null;
let intermission = null;
let status;
let intervalId = 0;
let requestReply;
const timers = new Map();
const sent = [];
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  alert() { throw new Error("Native dialogs are disabled"); },
  setInterval: (fn) => { timers.set(++intervalId, fn); return intervalId; },
  clearInterval: (id) => timers.delete(id),
  setTimeout: () => 1,
  clearTimeout() {},
  crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
  document: {
    body: { innerText: "", appendChild(node) { status = node; } },
    createElement: () => element(),
    getElementById: (id) => id === "label" ? label : id === "automcgraw-status" ? status : null,
    querySelector: (selector) => selector === ".probe-container" ? currentContainer :
      selector === ".forced-learning .alert-error" ? intermission : null,
    querySelectorAll: (selector) => selector === ".next-button" && nextButton ? [nextButton] : [],
  },
  chrome: {
    storage: { sync: { get: (_keys, cb) => cb({}) }, onChanged: { addListener() {} } },
    runtime: {
      lastError: null,
      onMessage: { addListener() {}, removeListener() {} },
      sendMessage(message, callback) {
        sent.push(message);
        if (message.type === "sendQuestionToChatGPT") requestReply = callback;
        else callback?.({ received: true });
      },
    },
  },
  choice, label, choiceText, container,
});
const run = (source) => vm.runInContext(source, context);
run(readFileSync(new URL("../content-scripts/mheducation.js", import.meta.url), "utf8"));
timers.clear();
run('parseQuestion = () => ({type:"multiple_choice",question:"Choose",options:[getChoiceText(choice)]})');
assert.equal(run("getChoiceText(choice)"), "shorter; longer", "ARIA label included correctness feedback");
const originalSignature = run("getQuestionSignature(container)");
choiceText.childNodes.push(element("correct", ["_visuallyHidden"]));
assert.equal(run("getQuestionSignature(container)"), originalSignature, "grading changed the question signature");

run("isAutomating = true; checkForNextStep()");
requestReply({ received: true });
const questionCount = () => sent.filter(({ type }) => type === "sendQuestionToChatGPT").length;
assert.equal(questionCount(), 1);
run("activeQuestionRequestId = null");
nextButton = { isConnected: true, hidden: false };
// Even unexpected visible feedback must never requeue the graded probe.
choiceText.childNodes.push(element("feedback not recognized"));
run("checkForNextStep()");
assert.equal(questionCount(), 1, "sent a graded question back to the AI");

context.previousNextButton = nextButton;
let transitioned = false;
const transition = run('waitForQuestionTransition(container, "old signature", 20000, previousNextButton)')
  .then(() => { transitioned = true; });
const poll = async () => {
  for (const fn of [...timers.values()]) fn();
  await new Promise((resolve) => setImmediate(resolve));
};
await poll();
assert.equal(transitioned, false, "feedback mutation completed the transition");
currentContainer = null;
nextButton = null;
await poll();
assert.equal(transitioned, false, "temporary empty DOM completed the transition");
currentContainer = container;
context.previousNextButton.hidden = true;
await poll();
await transition;
assert.equal(transitioned, true);

// Identical next attempts are valid once the prior feedback/Next control is gone.
const repeatedSignature = run("getQuestionSignature(container)");
let repeatedDone = false;
context.signature = repeatedSignature;
const repeated = run("waitForQuestionTransition(container, signature, 20000, previousNextButton)")
  .then(() => { repeatedDone = true; });
await poll();
await repeated;
assert.equal(repeatedDone, true, "identical legitimate question never advanced");
currentContainer = null;
intermission = {};
const learning = run("waitForQuestionTransition(container, signature)");
await poll();
await learning;
intermission = null;
currentContainer = container;

run('lastQueuedQuestionSignature = ""; checkForNextStep()');
requestReply({ received: false, status: "busy" });
assert.equal(run("isAutomating"), false, "rejected send left the request locked");
assert.equal(run("activeQuestionRequestId"), null);
assert.equal(status.attributes.role, "alert");
assert.match(status.textContent, /could not be sent/);
run('pauseForManualAnswer(container, ["unmatched option"])');
assert.match(status.textContent, /Please answer this question manually/);
assert.equal(status.attributes.role, "alert");
assert.ok(sent.some(({ stage }) => stage === "mhe.answer.mismatch"));
assert.ok(sent.some(({ stage }) => stage === "mhe.request.failed"));

console.log("MHE feedback, transitions, and visible failures: ok");
