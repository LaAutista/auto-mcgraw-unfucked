import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../content-scripts/ezto-mheducation.js", import.meta.url), "utf8");
const credits = "New York Philharmonic; Leonard Bernstein, conductor\nOriginally released 1969\nAll rights reserved by Sony Music Entertainment";
let notes = [];
const context = vm.createContext({
  console,
  URL,
  MutationObserver: class { observe() {} },
  setInterval() {}, setTimeout() {},
  document: {
    baseURI: "https://ezto.mheducation.com/ext/map/index.html",
    body: {},
    querySelector: (selector) => selector === ".question" ? { textContent: "Who is the composer?" } :
      selector === ".answers-wrap.multiple-choice" ? {} : null,
    querySelectorAll: (selector) => selector === ".note__main" ? notes :
      selector === ".answers--mc .answer__label--mc" ? [{ textContent: "Hector Berlioz" }, { textContent: "Antonín Dvořák" }] : [],
  },
  chrome: { runtime: { onMessage: { addListener() {} } } },
});
vm.runInContext(source, context);
const read = () => JSON.parse(vm.runInContext("JSON.stringify(parseQuestion())", context));
assert.equal(read().context, "");
const note = (text, sources, visible = true) => ({
  getClientRects: () => visible ? [{}] : [],
  cloneNode() {
    let playerRemoved = false;
    return {
      get textContent() { return text + (playerRemoved ? "" : " PLAY PAUSE 00:00"); },
      querySelectorAll(selector) {
        return selector.includes('[aria-label="audio player"]') ? [{ remove() { playerRemoved = true; } }] : [];
      },
    };
  },
  querySelectorAll: () => sources.map((src) => ({ currentSrc: "", getAttribute: () => src })),
});
notes = [
  note(credits, [
    "//ezto-media.prod.mheducation.com/MHHE/EZT/Audio/kamien_ezt_a349_berlioz.mp3?token=private",
    "//ezto-media.prod.mheducation.com/MHHE/EZT/Audio/kamien_ezt_a349_berlioz.mp3?token=private",
    "blob:https://ezto.mheducation.com/private-session",
    "https://media.example/%ZZ.mp3",
  ]),
  note("Another hidden question", ["https://media.example/another.mp3"], false),
];
const question = read();
assert.match(question.context, /New York Philharmonic; Leonard Bernstein, conductor Originally released 1969/);
assert.equal(question.context.match(/kamien_ezt_a349_berlioz.mp3/g).length, 1);
assert.doesNotMatch(question.context, /PLAY|PAUSE|token|private|Another hidden|https:|%ZZ/);
assert.equal(question.question, "Who is the composer?");
assert.deepEqual(question.options, ["Hector Berlioz", "Antonín Dvořák"]);
notes = [note("Different recording", ["https://media.example/other-composer.mp3"])];
assert.doesNotMatch(read().context, /Berlioz|berlioz|Bernstein/);

let prompt;
const provider = vm.createContext({
  console,
  document: { querySelectorAll: () => [] },
  chrome: { runtime: { onMessage: { addListener() {} } } },
});
vm.runInContext(readFileSync(new URL("../content-scripts/chatgpt.js", import.meta.url), "utf8"), provider);
provider.waitForIdle = async () => true;
provider.waitForSelector = async () => ({});
provider.submitToComposer = async (_input, text) => { prompt = text; return true; };
provider.startObserving = () => {};
provider.question = question;
await vm.runInContext("insertQuestion(question)", provider);
assert.match(prompt, /New York Philharmonic; Leonard Bernstein/);
assert.match(prompt, /kamien_ezt_a349_berlioz.mp3/);
assert.match(prompt, /Hector Berlioz/);
assert.match(prompt, /set "answer" to null/);
console.log("EZTO recording context extraction and ChatGPT delivery: ok");
