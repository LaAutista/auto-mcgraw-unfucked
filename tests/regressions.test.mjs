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
  const deliveryResolvers = [];
  const messages = [makeMessage()];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: () => ({}),
      querySelector: () => ({}),
      querySelectorAll: (selector) =>
        selector === messageSelector ? messages : [],
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        sendMessage(message) {
          sent.push(message);
          return new Promise((resolve) => deliveryResolvers.push(resolve));
        },
      },
    },
  });

  vm.runInContext(read(`content-scripts/${file}`), context, { filename: file });
  vm.runInContext(
    `submitToComposer = (_input, text) => {
       globalThis.promptText = text;
       return Promise.resolve();
     };
     startObserving = () => {};
     if (typeof waitForIdle === "function") waitForIdle = () => Promise.resolve(true);
     if (typeof findChatInput === "function") findChatInput = () => ({});`,
    context
  );

  await vm.runInContext(
    `insertQuestion(${JSON.stringify({
      type: "multiple_select",
      question: "1 × 10^7 = ______",
      options: ["10^7", "10^8", "10 × 10^6", "10 × 10^7"],
    })})`,
    context
  );
  assert.match(context.promptText, /select all that apply/i, `${file}: select-all prompt`);
  assert.match(context.promptText, /array containing ALL/, `${file}: array prompt`);

  await vm.runInContext(
    `insertQuestion(${JSON.stringify({
      type: "multiple_choice",
      question: "Choose 107",
      options: ["107", "108"],
    })})`,
    context
  );
  assert.doesNotMatch(context.promptText, /Do not include numbers/);
  assert.match(context.promptText, /preserve all numbers in the option text/);

  context.addOldAssistantMessage = () => messages.push(makeMessage());
  vm.runInContext(
    "waitForIdle = () => { addOldAssistantMessage(); return Promise.resolve(true); }",
    context
  );
  await vm.runInContext(
    `insertQuestion(${JSON.stringify({
      type: "multiple_choice",
      question: "new turn after old answer",
      options: ["A", "B"],
    })})`,
    context
  );
  assert.equal(
    vm.runInContext("messageCountAtQuestion", context),
    messages.length,
    `${file}: counted the old answer as part of the new turn`
  );

  vm.runInContext(
    `globalThis.waitCalls = 0;
     globalThis.providerSubmissions = [];
     waitForIdle = () => {
       waitCalls++;
       if (waitCalls === 1) {
         return new Promise((resolve) => { globalThis.releaseFirstInsert = resolve; });
       }
       return Promise.resolve(true);
     };
     submitToComposer = (_input, text) => {
       providerSubmissions.push(text);
       return Promise.resolve(true);
     };
     startObserving = () => {};`,
    context
  );
  let supersededReply;
  let replacementReply;
  listener(
    {
      type: "receiveQuestion",
      requestId: "superseded-request",
      question: { type: "multiple_choice", question: "old", options: ["A"] },
    },
    {},
    (reply) => (supersededReply = reply)
  );
  let cancelReply;
  listener(
    { type: "cancelRequest", requestId: "superseded-request" },
    {},
    (reply) => (cancelReply = reply)
  );
  listener(
    {
      type: "receiveQuestion",
      requestId: "replacement-request",
      question: { type: "multiple_choice", question: "new", options: ["B"] },
    },
    {},
    (reply) => (replacementReply = reply)
  );
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("releaseFirstInsert(true)", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.providerSubmissions.length, 1, `${file}: submitted superseded prompt`);
  assert.match(context.providerSubmissions[0], /Question: new/);
  assert.equal(cancelReply.received, true);
  assert.equal(supersededReply.stale, true);
  assert.equal(replacementReply.received, true);

  vm.runInContext(
    `globalThis.submissions = 0;
     insertQuestion = () => {
       submissions++;
       return Promise.resolve(true);
     };`,
    context
  );
  const questionMessage = {
    type: "receiveQuestion",
    requestId: "request-1",
    question: { question: "test" },
  };
  listener(
    questionMessage,
    {},
    () => {}
  );
  assert.equal(context.submissions, 1, `${file}: initial submission`);

  let duplicateResponse;
  listener(questionMessage, {}, (reply) => (duplicateResponse = reply));
  assert.equal(context.submissions, 1, `${file}: duplicated a transport retry`);
  assert.equal(duplicateResponse.status, "already-processing");

  listener(
    { ...questionMessage, requestId: "request-2" },
    {},
    () => {}
  );
  assert.equal(context.submissions, 2, `${file}: blocked a Stop/Start retry`);

  vm.runInContext("tryHandleResponse()", context);
  assert.equal(sent.length, 0, `${file}: accepted the stale message`);

  messages.push(makeMessage());
  vm.runInContext("tryHandleResponse()", context);
  assert.equal(sent.length, 1, `${file}: ignored a new identical response`);
  assert.equal(sent[0].response, response);
  assert.equal(sent[0].requestId, "request-2");

  listener(
    { ...questionMessage, requestId: "request-3" },
    {},
    () => {}
  );
  vm.runInContext(
    `globalThis.resetCalls = 0;
     globalThis.originalResetObservation = resetObservation;
     resetObservation = () => {
       resetCalls++;
       originalResetObservation();
     };`,
    context
  );
  deliveryResolvers[0]({ received: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.resetCalls, 0, `${file}: late ACK reset a newer request`);
  assert.equal(
    vm.runInContext("activeRequestId", context),
    "request-3",
    `${file}: late ACK replaced a newer request`
  );
}

const background = read("background/background.js");
assert.match(background, /mheTabId = message\.sourceTabId/);
assert.match(background, /mheWindowId = message\.sourceWindowId/);
assert.match(background, /received === false[\s\S]*type: "stopAutomation"/);
assert.doesNotMatch(background, /lastActiveTabId/);

async function testTabSwitching() {
  let tabSwitchingEnabled;
  let onActivated;
  let backgroundListener;
  let failNextAiRequest = false;
  let aiTabs = [{ id: 22, windowId: 7 }];
  const updatedTabs = [];
  const aiRequests = [];
  const mheMessages = [];
  const delayed = [];
  const sessionState = {};
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    crypto: {
      randomUUID: (() => {
        let nextId = 0;
        return () => `request-${++nextId}`;
      })(),
    },
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
        sendMessage: (id, message, callback) => {
          if (id === 22 && message.type === "receiveQuestion") {
            aiRequests.push(message);
            if (failNextAiRequest) {
              failNextAiRequest = false;
              callback({ received: false, error: "test failure" });
              return;
            }
          }
          if (id === 11) mheMessages.push(message);
          callback({ received: true });
        },
      },
      storage: {
        sync: {
          get: async () => ({ aiModel: "chatgpt", tabSwitchingEnabled }),
        },
        session: {
          async get(key) {
            return { [key]: sessionState[key] };
          },
          async set(values) {
            Object.assign(sessionState, values);
          },
          async remove(key) {
            delete sessionState[key];
          },
        },
      },
      windows: {
        WINDOW_ID_CURRENT: -2,
        update: async () => {},
      },
      runtime: {
        lastError: null,
        onMessage: { addListener: (fn) => (backgroundListener = fn) },
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

  tabSwitchingEnabled = false;
  await runQuestion();
  const suspendedRequestId = aiRequests.at(-1).requestId;
  const messagesBeforeSuspend = mheMessages.length;
  vm.runInContext(
    "mheTabId = null; mheWindowId = null; aiTabId = null; aiWindowId = null",
    context
  );
  const suspendedDelivery = await vm.runInContext(
    `processResponse({ requestId: ${JSON.stringify(
      suspendedRequestId
    )}, response: 'after-suspend' })`,
    context
  );
  assert.equal(
    suspendedDelivery.received,
    true,
    "lost request routing after background state was discarded"
  );
  assert.equal(mheMessages.length, messagesBeforeSuspend + 1);
  assert.equal(mheMessages.at(-1).response, "after-suspend");

  updatedTabs.length = 0;
  await runQuestion();
  updatedTabs.length = 0;
  await vm.runInContext(
    `processResponse({ requestId: ${JSON.stringify(
      aiRequests.at(-1).requestId
    )}, response: 'r' })`,
    context
  );
  assert.deepEqual(updatedTabs, [], "response switching disabled");

  tabSwitchingEnabled = true;
  await runQuestion();
  updatedTabs.length = 0;
  await vm.runInContext(
    `processResponse({ requestId: ${JSON.stringify(
      aiRequests.at(-1).requestId
    )}, response: 'r' })`,
    context
  );
  assert.deepEqual(updatedTabs, [11], "response switching re-enabled");

  tabSwitchingEnabled = false;
  await runQuestion();
  const staleRequestId = aiRequests.at(-1).requestId;
  await new Promise((resolve) =>
    backgroundListener(
      { type: "resetTabTracking", requestId: staleRequestId },
      {},
      resolve
    )
  );
  await runQuestion();
  const currentRequestId = aiRequests.at(-1).requestId;
  const messagesBeforeStaleResponse = mheMessages.length;
  const staleDelivery = await vm.runInContext(
    `processResponse({ requestId: ${JSON.stringify(
      staleRequestId
    )}, response: 'stale' })`,
    context
  );
  assert.equal(staleDelivery.stale, true, "accepted a stale AI response");
  assert.equal(
    mheMessages.length,
    messagesBeforeStaleResponse,
    "delivered a stale AI response"
  );
  const currentDelivery = await vm.runInContext(
    `processResponse({ requestId: ${JSON.stringify(
      currentRequestId
    )}, response: 'current' })`,
    context
  );
  assert.equal(currentDelivery.received, true, "lost the current AI response");
  assert.equal(mheMessages.at(-1).response, "current");

  assert.equal(
    new Set(aiRequests.map(({ requestId }) => requestId)).size,
    aiRequests.length
  );

  const requestCount = aiRequests.length;
  const mheMessageCount = mheMessages.length;
  failNextAiRequest = true;
  const firstRun = vm.runInContext(
    "processQuestion({ sourceTabId: 11, sourceWindowId: 7, question: 'first' })",
    context
  );
  backgroundListener({ type: "resetTabTracking" }, {}, () => {});
  await vm.runInContext(
    "processQuestion({ sourceTabId: 11, sourceWindowId: 7, question: 'restarted' })",
    context
  );
  await firstRun;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    aiRequests.slice(requestCount).map(({ question }) => question),
    ["first", "restarted"],
    "Stop/Start restart was dropped while a question was in flight"
  );
  assert.equal(
    mheMessages.slice(mheMessageCount).some(({ type }) => type === "stopAutomation"),
    false,
    "the failed old request stopped the queued restart"
  );
}

await testTabSwitching();

const ezto = read("content-scripts/ezto-mheducation.js");
assert.doesNotMatch(ezto, /choice\.includes\(ans\)|ans\.includes\(choice\)/);
assert.match(ezto, /!answers\.every\([\s\S]*isOptionMatch/);

const mhe = read("content-scripts/mheducation.js");
assert.doesNotMatch(mhe, /normalizedAnswer\.includes\(normalizedChoice\)/);
assert.match(mhe, /matchedChoices\.every\(Boolean\)/);

async function testMathTextRoundTrip() {
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

  const math = elementNode(
    "math",
    elementNode(
      "mfrac",
      elementNode("msup", textNode("10"), textNode("2")),
      elementNode("msup", textNode("10"), textNode("6"))
    )
  );
  const mathJax = elementNode(
    "span",
    textNode("102106"),
    elementNode("span", math)
  );
  mathJax.classList = { contains: (name) => name === "MathJax" };
  mathJax.querySelector = (selector) =>
    selector === ".MJX_Assistive_MathML math, math" ? math : null;
  const mathPreview = elementNode("span", textNode("102106"));
  mathPreview.classList = {
    contains: (name) => name === "MathJax_Preview",
  };
  const mathSource = elementNode(
    "script",
    textNode(
      '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac><msup><mn>10</mn><mn>2</mn></msup><msup><mn>10</mn><mn>6</mn></msup></mfrac></math>'
    )
  );

  const prompt = elementNode(
    "span",
    textNode("1 × 10"),
    elementNode("sup", textNode("7")),
    textNode(" = ______")
  );
  const options = [
    elementNode(
      "span",
      textNode("("),
      power("10", "-2"),
      textNode(")"),
      elementNode("sup", textNode("2"))
    ),
    elementNode("span", textNode("0.0001")),
    elementNode("span", power("10", "6"), textNode(" × "), power("10", "-2")),
    elementNode("span", power("10", "-2"), textNode(" + "), power("10", "-2")),
    elementNode("span", mathPreview, mathJax, mathSource),
  ];
  let ignoreClicks = false;
  const inputs = options.map((option) => ({
    type: "checkbox",
    checked: false,
    click() {
      if (!ignoreClicks) this.checked = !this.checked;
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
  let mheListener;
  let currentContainer = container;
  const outboundMessages = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    alert() {},
    confirm: () => false,
    crypto: { randomUUID: () => "request-current" },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    document: {
      querySelector: (selector) =>
        selector === ".probe-container" ? currentContainer : null,
    },
    chrome: {
      storage: {
        sync: { get: (_keys, callback) => callback({}) },
        onChanged: { addListener() {} },
      },
      runtime: {
        onMessage: {
          addListener(fn) {
            mheListener = fn;
          },
          removeListener() {},
        },
        sendMessage(message) {
          outboundMessages.push(message);
        },
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
    options: [
      "(10^-2)^2",
      "0.0001",
      "10^6 × 10^-2",
      "10^-2 + 10^-2",
      "10^2/10^6",
    ],
    previousCorrection: null,
  });

  inputs[2].checked = true;
  assert.equal(
    vm.runInContext(
      'fillInAnswers(["(10^-2)^2", "0.0001", "10^2/10^6"], document.querySelector(".probe-container"))',
      context
    ),
    3
  );
  assert.deepEqual(
    inputs.map((input) => input.checked),
    [true, true, false, false, true]
  );

  inputs.forEach((input) => (input.checked = false));
  vm.runInContext(
    "isAutomating = true; pauseBeforeSubmit = true; checkForNextStep(); checkForNextStep()",
    context
  );
  assert.equal(
    outboundMessages.filter(({ type }) => type === "sendQuestionToChatGPT")
      .length,
    1,
    "queued the same McGraw question twice"
  );
  let staleReply;
  mheListener(
    {
      type: "processChatGPTResponse",
      requestId: "request-stale",
      response: JSON.stringify({
        answer: ["(10^-2)^2", "0.0001", "10^2/10^6"],
      }),
    },
    {},
    (reply) => (staleReply = reply)
  );
  assert.equal(staleReply.stale, true);
  assert.deepEqual(inputs.map((input) => input.checked), [false, false, false, false, false]);

  currentContainer = null;
  let notReadyReply;
  mheListener(
    {
      type: "processChatGPTResponse",
      requestId: "request-current",
      response: JSON.stringify({ answer: ["0.0001"] }),
    },
    {},
    (reply) => (notReadyReply = reply)
  );
  assert.equal(notReadyReply.received, false);
  assert.equal(vm.runInContext("isAutomating", context), true);
  assert.equal(
    vm.runInContext("activeQuestionRequestId", context),
    "request-current"
  );
  currentContainer = container;

  ignoreClicks = true;
  let retryReply;
  mheListener(
    {
      type: "processChatGPTResponse",
      requestId: "request-current",
      response: JSON.stringify({
        answer: ["(10^-2)^2", "0.0001", "10^2/10^6"],
      }),
    },
    {},
    (reply) => (retryReply = reply)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retryReply.received, false);
  assert.equal(vm.runInContext("isAutomating", context), true);
  assert.equal(
    vm.runInContext("activeQuestionRequestId", context),
    "request-current"
  );
  ignoreClicks = false;

  let currentReply;
  mheListener(
    {
      type: "processChatGPTResponse",
      requestId: "request-current",
      response: JSON.stringify({
        answer: ["(10^-2)^2", "0.0001", "10^2/10^6"],
      }),
    },
    {},
    (reply) => (currentReply = reply)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(currentReply.received, true);
  assert.deepEqual(
    inputs.map((input) => input.checked),
    [true, true, false, false, true]
  );
  assert.equal(vm.runInContext("activeQuestionRequestId", context), null);
}

await testMathTextRoundTrip();

async function testSortableRankingRoundTrip() {
  const elementNode = (text) => ({
    nodeType: 1,
    nodeName: "DIV",
    childNodes: [
      { nodeType: 3, nodeName: "#text", childNodes: [], textContent: text },
    ],
    textContent: text,
  });
  const items = [];
  let liftedItem = null;
  const makeItem = (text) => {
    const content = elementNode(text);
    return {
      text,
      focus() {},
      matches: (selector) =>
        selector === "[data-react-beautiful-dnd-drag-handle]",
      querySelector: (selector) =>
        selector === ".content" || selector === "p" ? content : null,
      dispatchEvent(event) {
        if (event.type !== "keydown") return true;
        if (event.key === " ") {
          liftedItem = liftedItem === this ? null : this;
          return true;
        }
        if (liftedItem !== this) return true;

        const index = items.indexOf(this);
        const target = index + (event.key === "ArrowUp" ? -1 : 1);
        if (target >= 0 && target < items.length) {
          items.splice(target, 0, items.splice(index, 1)[0]);
        }
        return true;
      },
    };
  };
  items.push(
    ...[
      "The Solar System",
      "A supercluster of clusters",
      "The Milky Way",
      "The Virgo Cluster",
      "The Local Group",
    ].map(makeItem)
  );

  const prompt = elementNode(
    "Order the objects from closest (top) to farthest (bottom)."
  );
  const container = {
    querySelector(selector) {
      if (selector === ".awd-probe-type-sortable") return {};
      if (selector === ".prompt") return prompt;
      return null;
    },
    querySelectorAll(selector) {
      if (
        selector ===
        ".sortable-component .vertical-list .choice-item[data-react-beautiful-dnd-draggable]"
      ) {
        return items;
      }
      return [];
    },
  };
  class FakeKeyboardEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    alert() {},
    confirm: () => false,
    KeyboardEvent: FakeKeyboardEvent,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
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
  assert.equal(parsed.type, "ranking");
  assert.deepEqual(parsed.options, items.map(({ text }) => text));

  const targetOrder = [
    "The Solar System",
    "The Milky Way",
    "The Local Group",
    "The Virgo Cluster",
    "A supercluster of clusters",
  ];
  await vm.runInContext(
    `processChatGPTResponse(${JSON.stringify(
      JSON.stringify({ answer: targetOrder, explanation: "test" })
    )})`,
    context
  );
  assert.deepEqual(items.map(({ text }) => text), targetOrder);
}

await testSortableRankingRoundTrip();

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
