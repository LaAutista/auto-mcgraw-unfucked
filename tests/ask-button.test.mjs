import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

for (const [file, buttonSelector] of [
  ["mheducation.js", ".automcgraw-btn"],
  ["ezto-mheducation.js", ".header__automcgraw--main"],
  ["muzzylane.js", ".automcgraw-sim-btn"],
]) {
  const elements = [];
  const messages = [];
  let nextSteps = 0;
  const createElement = () => {
    const element = {
      style: {},
      classList: { add() {} },
      children: [],
      listeners: {},
      setAttribute() {},
      appendChild(child) { this.children.push(child); },
      insertBefore(child) { this.children.push(child); },
      addEventListener(type, callback) { this.listeners[type] = callback; },
    };
    elements.push(element);
    return element;
  };
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    confirm() { throw new Error("Firefox blocked this site's dialogs"); },
    alert() {},
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    clearTimeout() {},
    MutationObserver: class { observe() {} },
    document: {
      body: createElement(),
      createElement,
      querySelector: () => null,
      getElementById: () => null,
    },
    chrome: {
      storage: {
        sync: { get: (_keys, callback) => callback({}) },
        onChanged: { addListener() {} },
      },
      runtime: {
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage: (message) => messages.push(message),
      },
    },
  });
  const run = (source) => vm.runInContext(source, context);
  run(readFileSync(new URL(`../content-scripts/${file}`, import.meta.url), "utf8"));
  const header = createElement();
  const helpLink = { parentNode: header };
  let button;
  context.document.querySelector = (selector) => {
    if (selector === buttonSelector) return button;
    if (selector === ".header__help") return helpLink;
    if (selector === ".banner-bar-btns") return header;
    return null;
  };
  context.waitForElement = async () => header;
  context.checkForNextStep = () => { nextSteps++; };
  run("addAssistantButton()");
  await new Promise((resolve) => setImmediate(resolve));
  button = elements.find((element) => element.textContent === "Ask ChatGPT");
  // MuzzyLane finds its new button via querySelector when setting the label.
  if (!button && file === "muzzylane.js") {
    button = elements.find((element) => element.className === "automcgraw-sim-btn");
    run("updateButtonText()");
  }
  assert.ok(button, `${file}: Ask button was not created`);

  for (let cycle = 1; cycle <= 2; cycle++) {
    button.listeners.click();
    assert.equal(run("isAutomating"), true, `${file}: blocked dialogs prevented start`);
    assert.equal(button.textContent, "Stop Automation");
    if (file === "muzzylane.js") assert.equal(run("loopId"), 1);
    else assert.equal(nextSteps, cycle, `${file}: Ask did not check the next question`);
    if (file === "mheducation.js") {
      assert.equal(run("automationRunId"), cycle * 2 - 1);
      run('activeQuestionRequestId = "pending"; lastQueuedQuestionSignature = "old"');
    }

    button.listeners.click();
    assert.equal(run("isAutomating"), false, `${file}: Stop did not stop automation`);
    assert.equal(button.textContent, "Ask ChatGPT");
    if (file === "muzzylane.js") assert.equal(run("loopId"), null);
    if (file === "mheducation.js") {
      assert.equal(run("automationRunId"), cycle * 2);
      assert.equal(run("activeQuestionRequestId"), null);
      assert.equal(run("lastQueuedQuestionSignature"), "");
      assert.equal(messages.at(-1).type, "resetTabTracking");
      assert.equal(messages.at(-1).requestId, "pending");
    }
  }
}

console.log("Ask button with blocked dialogs: ok");
