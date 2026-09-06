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

let nextMessageId = 0;
function makeMessage() {
  const messageId = `message-${++nextMessageId}`;
  return {
    getAttribute: (name) => name === "data-message-id" ? messageId : null,
    textContent: response,
    querySelectorAll: () => [{ textContent: response }],
  };
}

for (const [file, messageSelector] of providers) {
  let listener;
  let now = 1000;
  const sent = [];
  const deliveryResolvers = [];
  const messages = [makeMessage()];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    Date: { now: () => now },
    assistantMessages: messages,
    document: {
      getElementById: () => ({}),
      querySelector: (selector) => selector === '[data-testid="stop-button"]' ? null : ({}),
      querySelectorAll: (selector) =>
        selector === messageSelector ? messages : [],
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn) => (listener = fn) },
        sendMessage(message, callback) {
          if (message.type === "diagnosticEvent") {
            callback?.({ received: true });
            return Promise.resolve({ received: true });
          }
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
  if (file === "chatgpt.js") {
    now += 1000;
    vm.runInContext("tryHandleResponse()", context);
  }
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

  if (file === "chatgpt.js") {
    vm.runInContext(
      `activeRequestId = "virtualized-request";
       resetObservation();
       assistantMessagesAtQuestion = new Set(assistantMessages.map(getAssistantMessageKey));
       messageCountAtQuestion = assistantMessages.length;`,
      context
    );
    messages.shift();
    messages.push(makeMessage());
    vm.runInContext("tryHandleResponse()", context);
    now += 1000;
    vm.runInContext("tryHandleResponse()", context);
    assert.equal(
      sent.at(-1).requestId,
      "virtualized-request",
      "chatgpt.js: ignored a new answer when an old DOM message was virtualized"
    );
  }
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

  assert.deepEqual(await runQuestion(), [22], "tab switching default keeps AI visible");
  tabSwitchingEnabled = false;
  assert.deepEqual(await runQuestion(), [], "tab switching disabled");
  tabSwitchingEnabled = true;
  assert.deepEqual(await runQuestion(), [22], "tab switching re-enabled keeps AI visible");

  aiTabs = [
    { id: 33, windowId: 8 },
    { id: 22, windowId: 7 },
  ];
  assert.deepEqual(await runQuestion(), [22], "same-window AI tab stays visible");

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
  const labelledOptions = new Map();
  const inputs = options.map((option, index) => {
    const labelId = `choice-${index}`;
    labelledOptions.set(labelId, option);
    return {
      type: "checkbox",
      checked: false,
      getAttribute: (name) =>
        index < 2 && name === "aria-labelledby" ? labelId : null,
      labels:
        index < 2
          ? []
          : [{ querySelector: (selector) => (selector === ".choiceText" ? option : null) }],
      click() {
        if (!ignoreClicks) this.checked = !this.checked;
      },
      closest: () => null,
    };
  });
  const container = {
    querySelector(selector) {
      if (selector === ".awd-probe-type-multiple_select") return {};
      if (selector === ".prompt") return prompt;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === ".choiceText") return [];
      if (selector.includes('input[type="radio"]')) return inputs;
      return [];
    },
  };
  class FakeEvent {
    constructor(type) {
      this.type = type;
    }
  }
  const fillEventSnapshots = [];
  class FakeInput {
    constructor() {
      this._value = "";
      this.events = [];
    }
    get value() {
      return this._value;
    }
    set value(value) {
      this._value = value;
    }
    focus() {}
    blur() {}
    dispatchEvent(event) {
      this.events.push(event.type);
      fillEventSnapshots.push(fillInputs.map((input) => input.value));
    }
  }
  const fillInputs = [new FakeInput(), new FakeInput()];
  const fillContainer = {
    querySelector: (selector) =>
      selector === ".awd-probe-type-fill_in_the_blank" ? {} : null,
    querySelectorAll: (selector) =>
      selector === "input.fitb-input" ? fillInputs : [],
  };
  let mheListener;
  let currentContainer = container;
  let pageText = "";
  let statusElement = null;
  const outboundMessages = [];
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    alert() {},
    confirm: () => false,
    Event: FakeEvent,
    HTMLInputElement: FakeInput,
    fillContainer,
    crypto: { randomUUID: () => "request-current" },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    document: {
      body: {
        appendChild(element) { statusElement = element; },
        get innerText() {
          return pageText;
        },
      },
      createElement: () => ({ style: {}, setAttribute() {} }),
      getElementById: (id) => id === "automcgraw-status" ? statusElement : labelledOptions.get(id) || null,
      querySelector: (selector) =>
        selector === ".probe-container" ? currentContainer : null,
      querySelectorAll: () => [],
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
  const originalParseQuestion = context.parseQuestion;
  const signatureFor = (question) => {
    context.parseQuestion = () => question;
    const before = JSON.stringify(question);
    const signature = vm.runInContext("getQuestionSignature({})", context);
    assert.equal(JSON.stringify(question), before, "signature mutated parsed option order");
    return signature;
  };
  for (const type of ["ranking", "matching"]) {
    const optionsFor = (choices) => type === "matching"
      ? { prompts: ["Second prompt", "First prompt"], choices }
      : choices;
    const question = { type, question: "Arrange the colors", options: optionsFor(["red", "blue", "green"]) };
    const signature = signatureFor(question);
    assert.equal(
      signatureFor({ ...question, options: optionsFor(["green", "red", "blue"]) }),
      signature,
      `${type}: filling reordered choices and changed question identity`
    );
    assert.notEqual(
      signatureFor({ ...question, question: "Arrange different colors" }),
      signature,
      `${type}: ignored changed question text`
    );
    assert.notEqual(
      signatureFor({ ...question, options: optionsFor(["red", "orange", "green"]) }),
      signature,
      `${type}: ignored an actual changed choice`
    );
    if (type === "matching") {
      assert.notEqual(
        signatureFor({ ...question, options: { ...question.options, prompts: [...question.options.prompts].reverse() } }),
        signature,
        "matching: ignored changed prompt order"
      );
    }
  }
  context.parseQuestion = originalParseQuestion;
  assert.equal(
    vm.runInContext(
      'isAnswerMatch("Quebec, Canada (53° north)", "Quebec, Canada (53^o north)")',
      context
    ),
    true,
    "rejected ChatGPT's plain-text degree notation"
  );
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

  assert.equal(
    vm.runInContext(
      'fillInAnswers(["revolution", "rotation"], fillContainer)',
      context
    ),
    2
  );
  assert.deepEqual(
    fillInputs.map(({ value, events }) => ({ value, events })),
    [
      { value: "revolution", events: ["input", "change"] },
      { value: "rotation", events: ["input", "change"] },
    ]
  );
  assert.deepEqual(
    fillEventSnapshots[0],
    ["revolution", "rotation"],
    "dispatched a fill-in event before every blank had a value"
  );

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

  vm.runInContext(
    `pauseBeforeSubmit = false;
     lastQueuedQuestionSignature = "";
     globalThis.advanceStarted = false;
     submitAndAdvance = () => {
       advanceStarted = true;
       return new Promise((resolve) => { globalThis.releaseAdvance = resolve; });
     };
     checkForNextStep();`,
    context
  );
  let advanceReply;
  mheListener(
    {
      type: "processChatGPTResponse",
      requestId: "request-current",
      response: JSON.stringify({
        answer: ["(10^-2)^2", "0.0001", "10^2/10^6"],
      }),
    },
    {},
    (reply) => (advanceReply = reply)
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.advanceStarted, true);
  assert.equal(advanceReply, undefined, "ACKed before submit/advance completed");
  vm.runInContext("releaseAdvance()", context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(advanceReply.received, true);

  const questionMessages = () =>
    outboundMessages.filter(({ type }) => type === "sendQuestionToChatGPT");
  const messagesBeforeSameQuestion = questionMessages().length;
  vm.runInContext("checkForNextStep()", context);
  assert.equal(
    questionMessages().length,
    messagesBeforeSameQuestion,
    "requeued the same visible question"
  );
  prompt.childNodes[0].textContent = "A newly rendered question: ";
  vm.runInContext("checkForNextStep()", context);
  assert.equal(
    questionMessages().length,
    messagesBeforeSameQuestion + 1,
    "missed a newly rendered question"
  );

  currentContainer = null;
  pageText = "Accuracy Confidence Challenging Concepts";
  vm.runInContext("activeQuestionRequestId = null; checkForNextStep()", context);
  assert.equal(
    vm.runInContext("isAutomating", context),
    false,
    "did not stop on the assignment completion screen"
  );
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
  let draggingItem = null;
  let dragTargetY = null;
  const dragWindow = {
    dispatchEvent(event) {
      if (event.type === "mousemove") dragTargetY = event.clientY;
      if (event.type === "mouseup" && draggingItem) {
        const sourceIndex = items.indexOf(draggingItem);
        const targetIndex = items.findIndex((item) => {
          const rect = item.getBoundingClientRect();
          return dragTargetY === rect.top + rect.height / 2;
        });
        if (sourceIndex >= 0 && targetIndex >= 0 && sourceIndex !== targetIndex) {
          items.splice(targetIndex, 0, items.splice(sourceIndex, 1)[0]);
        }
        draggingItem = null;
      }
      return true;
    },
  };
  const makeItem = (text) => {
    const content = elementNode(text);
    const item = {
      id: `sortable-${items.length}-${text}`,
      text,
      ownerDocument: { defaultView: dragWindow },
      classList: {
        contains: (name) => name === "-dragging" && draggingItem === item,
      },
      getAttribute: (name) =>
        name === "aria-pressed" && draggingItem === item ? "true" : "false",
      getBoundingClientRect() {
        return {
          left: 100,
          top: items.indexOf(this) * 50,
          width: 200,
          height: 40,
        };
      },
      focus() {},
      matches: (selector) =>
        selector === "[data-react-beautiful-dnd-drag-handle]",
      querySelector: (selector) =>
        selector === ".content" || selector === "p" ? content : null,
      dispatchEvent(event) {
        if (event.type === "mousedown") draggingItem = this;
        return true;
      },
    };
    return item;
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
  class FakeMouseEvent extends FakeKeyboardEvent {}
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {}, info() {} },
    alert() {},
    confirm: () => false,
    KeyboardEvent: FakeKeyboardEvent,
    MouseEvent: FakeMouseEvent,
    innerWidth: 1000,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    document: {
      body: { appendChild() {} },
      createElement: () => ({ style: {}, setAttribute() {} }),
      getElementById: (id) => items.find((item) => item.id === id) || null,
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

  const multiSlotTargets = JSON.parse(
    vm.runInContext(
      `getMatchingResponseSlots = () => [
         { rowIndex: 0, slotIndex: 0, promptText: "Equinox" },
         { rowIndex: 0, slotIndex: 1, promptText: "Equinox" },
         { rowIndex: 1, slotIndex: 0, promptText: "Solstice" },
         { rowIndex: 1, slotIndex: 1, promptText: "Solstice" },
       ];
       globalThis.multiSlotChoices = ["Equal day and night", "March and September", "June and December", "Longest or shortest nights"].map((text) => ({ text }));
       getMatchingChoiceItems = () => multiSlotChoices;
       getMatchingChoiceText = (item) => item?.text || "";
       JSON.stringify(normalizeMatchingTargets({}, ${JSON.stringify([
         "Equinox -> Equal day and night",
         "Equinox -> March and September",
         "Solstice -> June and December",
         "Solstice -> Longest or shortest nights",
       ])}))`,
      context
    )
  );
  assert.deepEqual(
    multiSlotTargets.map(({ targetIndex, rowIndex, slotIndex, promptText, choiceText }) => ({
      targetIndex,
      rowIndex,
      slotIndex,
      promptText,
      choiceText,
    })),
    [
      { targetIndex: 0, rowIndex: 0, slotIndex: 0, promptText: "Equinox", choiceText: "Equal day and night" },
      { targetIndex: 1, rowIndex: 0, slotIndex: 1, promptText: "Equinox", choiceText: "March and September" },
      { targetIndex: 2, rowIndex: 1, slotIndex: 0, promptText: "Solstice", choiceText: "June and December" },
      { targetIndex: 3, rowIndex: 1, slotIndex: 1, promptText: "Solstice", choiceText: "Longest or shortest nights" },
    ],
    "collapsed multiple response slots into one target per prompt"
  );

  vm.runInContext(
    `globalThis.matchingDropped = false;
     globalThis.matchingLocationChecks = 0;
     globalThis.matchingDragging = false;
     globalThis.matchingMouseEvents = [];
     globalThis.MouseEvent = class {
       constructor(type, init) { this.type = type; Object.assign(this, init); }
     };
     globalThis.innerWidth = 1000;
     globalThis.matchingDragWindow = {
       dispatchEvent(event) {
         matchingMouseEvents.push(event.type);
         if (event.type === "mousemove" && !matchingDragging) matchingDragging = true;
         else if (event.type === "mouseup") matchingDropped = true;
         return true;
       },
     };
     globalThis.matchingSource = {
       id: "matching-source",
       ownerDocument: { defaultView: matchingDragWindow },
       classList: { contains: (name) => name === "-dragging" && matchingDragging },
       getAttribute: (name) => name === "aria-pressed" && matchingDragging ? "true" : "false",
       getBoundingClientRect: () => ({ left: 100, top: 100, width: 100, height: 40 }),
       dispatchEvent(event) { matchingMouseEvents.push(event.type); return true; },
     };
     globalThis.matchingTargetBox = {
       getBoundingClientRect: () => ({ left: 300, top: 50, width: 100, height: 40 }),
     };
     globalThis.matchingTargetHolder = {
       querySelector(selector) {
         if (selector === ".choice-item-wrapper") return matchingTargetBox;
         return null;
       },
     };
     document.getElementById = (id) => id === "matching-source" ? matchingSource : null;
     getMatchingResponseSlots = () => [
       { holder: matchingTargetHolder }, {}, {}, {},
     ];
     getMatchingChoiceLocation = () => {
       matchingLocationChecks++;
       if (matchingDropped) {
         return { area: "response", targetIndex: 0, poolIndex: -1, item: {} };
       }
       return {
         area: "pool",
         targetIndex: -1,
         poolIndex: 0,
         item: matchingSource,
       };
     };
     getMatchingDragHandle = (item) => item;
     delay = () => Promise.resolve();`,
    context
  );
  assert.equal(
    await vm.runInContext('moveMatchingChoiceToTarget({}, "delayed", 0)', context),
    true,
    "gave up before McGraw exposed the completed matching drop"
  );
  assert.deepEqual([...context.matchingMouseEvents], [
    "mousedown",
    "mousemove",
    "mousemove",
    "mouseup",
  ]);
  assert.ok(vm.runInContext("matchingLocationChecks", context) >= 2);
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
