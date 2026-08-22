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
assert.doesNotMatch(background, /lastActiveTabId/);

async function testTabSwitching() {
  let tabSwitchingEnabled;
  let onActivated;
  let aiTabs = [{ id: 22, windowId: 7 }];
  const updatedTabs = [];
  const delayed = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout(callback, delay) {
      if (delay === 1000) delayed.push(callback);
      else callback();
    },
    chrome: {
      tabs: {
        onActivated: { addListener: (fn) => (onActivated = fn) },
        onRemoved: { addListener() {} },
        query: async ({ url }) =>
          Array.isArray(url)
            ? [{ id: 11, windowId: 7 }]
            : aiTabs,
        get: async (id) => ({ id, windowId: 7, status: "complete" }),
        update: async (id) => {
          updatedTabs.push(id);
          // Reproduce the v2.5 self-activation race if its listener returns.
          onActivated?.({ tabId: id });
        },
        sendMessage: (_id, _message, callback) =>
          callback({ received: true }),
      },
      storage: {
        sync: {
          get: async () => ({ aiModel: "chatgpt", tabSwitchingEnabled }),
        },
      },
      windows: {
        WINDOW_ID_CURRENT: -2,
        update: async () => {},
      },
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
      },
    },
  });

  vm.runInContext(background, context, { filename: "background.js" });
  await vm.runInContext("findAndStoreTabs()", context);

  async function runQuestion() {
    updatedTabs.length = 0;
    delayed.length = 0;
    await vm.runInContext(
      "processQuestion({ sourceTabId: 11, sourceWindowId: 7, question: 'q' })",
      context
    );
    while (delayed.length) await delayed.shift()();
    return [...updatedTabs];
  }

  assert.deepEqual(await runQuestion(), [22, 11], "tab switching default");
  tabSwitchingEnabled = false;
  assert.deepEqual(await runQuestion(), [], "tab switching disabled");
  tabSwitchingEnabled = true;
  assert.deepEqual(await runQuestion(), [22, 11], "tab switching re-enabled");

  aiTabs = [
    { id: 33, windowId: 8 },
    { id: 22, windowId: 7 },
  ];
  assert.deepEqual(await runQuestion(), [22, 11], "same-window AI tab");

  updatedTabs.length = 0;
  tabSwitchingEnabled = false;
  await vm.runInContext("processResponse({ response: 'r' })", context);
  assert.deepEqual(updatedTabs, [], "response switching disabled");

  tabSwitchingEnabled = true;
  await vm.runInContext("processResponse({ response: 'r' })", context);
  assert.deepEqual(updatedTabs, [11], "response switching re-enabled");
}

await testTabSwitching();

const ezto = read("content-scripts/ezto-mheducation.js");
assert.doesNotMatch(ezto, /choice\.includes\(ans\)|ans\.includes\(choice\)/);
assert.match(ezto, /!answers\.every\([\s\S]*isOptionMatch/);

const mhe = read("content-scripts/mheducation.js");
assert.doesNotMatch(mhe, /normalizedAnswer\.includes\(normalizedChoice\)/);
assert.match(mhe, /matchedChoices\.every\(Boolean\)/);

function testMathTextRoundTrip() {
  const textNode = (text) => ({
    nodeType: 3,
    nodeName: "#text",
    childNodes: [],
    textContent: text,
  });
  const elementNode = (nodeName, ...childNodes) => {
    const node = { nodeType: 1, nodeName: nodeName.toUpperCase(), childNodes };
    Object.defineProperty(node, "textContent", {
      get: () => childNodes.map((child) => child.textContent).join(""),
    });
    return node;
  };
  const power = (base, exponent, prefix = "") =>
    elementNode(
      "span",
      textNode(prefix + base),
      elementNode("sup", textNode(exponent))
    );

  const prompt = elementNode(
    "span",
    textNode("1 × 10"),
    elementNode("sup", textNode("7")),
    textNode(" = ______")
  );
  const options = [
    power("10", "7"),
    power("10", "8"),
    power("10", "6", "10 × "),
    power("10", "7", "10 × "),
  ];
  const inputs = options.map((option) => ({
    checked: false,
    click() {
      this.checked = true;
    },
    closest: () => ({ querySelector: () => option }),
  }));
  const container = {
    querySelector(selector) {
      if (selector === ".awd-probe-type-multiple_select") return {};
      if (selector === ".prompt") return prompt;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".choiceText") return options;
      if (selector.includes('input[type="radio"]')) return inputs;
      return [];
    },
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    alert() {},
    confirm: () => false,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    document: {
      querySelector: (selector) =>
        selector === ".probe-container" ? container : null,
    },
    chrome: {
      storage: {
        sync: { get: (_keys, callback) => callback({}) },
        onChanged: { addListener() {} },
      },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage() {},
      },
    },
  });

  vm.runInContext(mhe, context, { filename: "mheducation.js" });
  const parsed = JSON.parse(
    vm.runInContext("JSON.stringify(parseQuestion())", context)
  );
  assert.deepEqual(parsed, {
    type: "multiple_select",
    question: "1 × 10^7 = ______",
    options: ["10^7", "10^8", "10 × 10^6", "10 × 10^7"],
    previousCorrection: null,
  });

  assert.equal(
    vm.runInContext(
      'fillInAnswers(["10^7", "10 × 10^6"], document.querySelector(".probe-container"))',
      context
    ),
    2
  );
  assert.deepEqual(
    inputs.map((input) => input.checked),
    [true, false, true, false]
  );
}

testMathTextRoundTrip();

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

const popupHtml = read("popup/settings.html");
const popupJs = read("popup/settings.js");
const popupCss = read("popup/settings.css");
assert.match(popupHtml, /id="tab-switching-toggle"/);
assert.match(popupJs, /data\.tabSwitchingEnabled !== false/);
assert.match(popupJs, /tabSwitchingEnabled: this\.checked/);
assert.match(popupCss, /input:focus-visible \+ \.toggle-slider/);
assert.doesNotMatch(popupHtml, /check-updates|latest-version|version-status/i);
assert.doesNotMatch(popupJs, /checkForUpdates|fetch\s*\(|api\.github\.com/i);
assert.equal(
  manifest.host_permissions.includes("https://api.github.com/*"),
  false
);

console.log("regressions: ok");
