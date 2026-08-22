import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));
const response = '{"answer":"same","explanation":"same"}';
const providers = [
  ["chatgpt.js", '[data-message-author-role="assistant"]'],
  ["gemini.js", "model-response"],
  ["deepseek.js", "[data-testid='chat-message-assistant']"],
];

function makeMessage() {
  return {
    textContent: response,
    querySelectorAll: () => [{ textContent: response }],
  };
}

for (const [file, messageSelector] of providers) {
  let listener;
  const sent = [];
  const messages = [makeMessage()];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      querySelectorAll: (selector) =>
        selector === messageSelector ? messages : [],
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        sendMessage(message) {
          sent.push(message);
          return Promise.resolve();
        },
      },
    },
  });

  vm.runInContext(read(`content-scripts/${file}`), context, { filename: file });
  vm.runInContext("insertQuestion = () => Promise.resolve()", context);
  listener(
    { type: "receiveQuestion", question: { question: "test" } },
    {},
    () => {}
  );

  vm.runInContext("tryHandleResponse()", context);
  assert.equal(sent.length, 0, `${file}: accepted the stale message`);

  messages.push(makeMessage());
  vm.runInContext("tryHandleResponse()", context);
  assert.equal(sent.length, 1, `${file}: ignored a new identical response`);
  assert.equal(sent[0].response, response);
}

const background = read("background/background.js");
assert.match(background, /mheTabId = message\.sourceTabId/);
assert.match(background, /mheWindowId = message\.sourceWindowId/);
assert.match(background, /received === false[\s\S]*type: "stopAutomation"/);

const ezto = read("content-scripts/ezto-mheducation.js");
assert.doesNotMatch(ezto, /choice\.includes\(ans\)|ans\.includes\(choice\)/);
assert.match(ezto, /!answers\.every\([\s\S]*isOptionMatch/);

const mhe = read("content-scripts/mheducation.js");
assert.doesNotMatch(mhe, /normalizedAnswer\.includes\(normalizedChoice\)/);
assert.match(mhe, /matchedChoices\.every\(Boolean\)/);

const muzzy = read("content-scripts/muzzylane.js");
assert.match(muzzy, /message\.type === "stopAutomation"[\s\S]*stopAutomation\(\)/);

assert.equal(manifest.background.service_worker, "background/background.js");
assert.deepEqual(manifest.background.scripts, ["background/background.js"]);
assert.equal(
  manifest.browser_specific_settings.gecko.id,
  "auto-mcgraw-unfucked@laautista.github.io"
);
assert.equal(
  manifest.browser_specific_settings.gecko.strict_min_version,
  "140.0"
);
assert.deepEqual(
  manifest.browser_specific_settings.gecko.data_collection_permissions.required,
  ["websiteContent"]
);
assert.doesNotMatch(background, /await chrome\./);

console.log("regressions: ok");
