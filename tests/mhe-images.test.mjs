import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const text = (value) => ({ nodeType: 1, nodeName: "SPAN", childNodes: [
  { nodeType: 3, textContent: value },
] });
const image = (src, alt = "A spectrum with dark lines", overrides = {}) => ({
  src, alt, naturalWidth: 558, naturalHeight: 168,
  closest: () => null, getAttribute: () => null, ...overrides,
});
const imageUrl = "https://smartfactory-api.prod.mheducation.com/files/smart-factory/test/smart-package/assets/images/spectrum.png";
let images = [];
let status;
let listener;
const sent = [];
const container = {
  querySelector: (selector) => selector === ".prompt" ? text("What kind of spectrum?") :
    selector === ".awd-probe-type-multiple_choice" ? {} : null,
  querySelectorAll: (selector) => selector === "img" ? images : selector === ".choiceText" ?
    [text("Emission-line"), text("Continuous"), text("Absorption-line")] : [],
};
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  URL,
  alert() { throw new Error("No native dialog allowed"); },
  setInterval: () => 1, clearInterval() {},
  setTimeout: () => 1, clearTimeout() {},
  document: {
    body: { innerText: "", appendChild(node) { status = node; } },
    getElementById: () => status,
    createElement: () => ({ style: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } }),
    querySelector: (selector) => selector === ".probe-container" ? container : null,
    querySelectorAll: () => [],
  },
  chrome: {
    storage: { sync: { get: (_keys, callback) => callback({}) }, onChanged: { addListener() {} } },
    runtime: {
      onMessage: { addListener(fn) { listener = fn; }, removeListener() {} },
      sendMessage(message, callback) { sent.push(message); callback?.({ received: true }); },
    },
  },
  container,
});
const run = (code) => vm.runInContext(code, context);
run(readFileSync(new URL("../content-scripts/mheducation.js", import.meta.url), "utf8"));
const parsed = () => JSON.parse(run("JSON.stringify(parseQuestion())"));
assert.equal(Object.hasOwn(parsed(), "images"), false, "changed the text-only question payload");

images = [image(imageUrl)];
assert.deepEqual(parsed().images, [{ src: imageUrl, alt: "A spectrum with dark lines" }]);
assert.match(parsed().question, /Image description: A spectrum with dark lines/);
const signature = run("getQuestionSignature(container)");
images = [image(imageUrl.replace("spectrum.png", "different.png"))];
assert.notEqual(run("getQuestionSignature(container)"), signature, "different diagrams reused the same question identity");

images = [
  image("http://smartfactory-api.prod.mheducation.com/image.png"),
  image("https://mheducation.com.example.org/image.png"),
  image("data:image/png;base64,AAAA"),
  image(imageUrl, "math", { closest: () => ({}) }),
  image(imageUrl, "icon", { naturalWidth: 16, naturalHeight: 16 }),
  image(imageUrl, "decorative", { getAttribute: (name) => name === "role" ? "presentation" : null }),
  image(imageUrl), image(imageUrl),
];
assert.equal(parsed().images.length, 1, "included icons, math images, unsafe sources, or duplicates");
images = Array.from({ length: 6 }, (_, i) => image(imageUrl.replace("spectrum.png", `${i}.png`), ""));
assert.equal(parsed().images.length, 4, "unbounded image attachment count");
assert.equal(parsed().question, "What kind of spectrum?", "added an empty image description");

// An empty AI answer is a visible manual pause, not a retryable fill failure.
context.fillInAnswers = () => { throw new Error("Tried to fill an empty answer"); };
for (const answer of ["", "   ", [], null]) {
  run('isAutomating = true; activeQuestionRequestId = "empty"; lastQueuedQuestionSignature = getQuestionSignature(container)');
  const delivery = await new Promise((resolve) => listener({
    type: "processChatGPTResponse", requestId: "empty", response: JSON.stringify({ answer }),
  }, {}, resolve));
  assert.equal(delivery.received, true, "empty answer stayed in an infinite delivery retry");
  assert.equal(run("activeQuestionRequestId"), null);
  assert.equal(run("matchingPauseIntervalId"), 1);
  assert.equal(status.attributes.role, "alert");
  assert.match(status.textContent, /did not provide an answer/);
  assert.match(status.textContent, /Please answer this question manually/);
}
assert.equal(sent.filter(({ stage }) => stage === "mhe.answer.empty").length, 4);
assert.ok(!JSON.stringify(sent).includes(imageUrl), "image URL leaked into diagnostics");
console.log("MHE image extraction and empty-answer fallback: ok");
