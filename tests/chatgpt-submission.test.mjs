import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const oldInput = { innerText: "question" };
let liveInput = oldInput;
let posts = [];
const context = vm.createContext({
  console: { log() {} },
  chrome: { runtime: { onMessage: { addListener() {} } } },
  document: {
    getElementById: () => liveInput,
    querySelector: () => null,
    querySelectorAll: () => posts,
  },
  oldInput,
});
const run = (source) => vm.runInContext(source, context);
run(readFileSync(new URL("../content-scripts/chatgpt.js", import.meta.url), "utf8"));
assert.equal(run("looksSent(oldInput)"), false);
liveInput = { innerText: "" };
assert.equal(run("looksSent(oldInput)"), true, "detached composer hid a successful send");
liveInput = oldInput;
posts = [{ getAttribute: () => "old" }];
assert.equal(run('looksSent(oldInput,new Set(["old"]))'), false);
posts = [{ getAttribute: () => "old" }, { getAttribute: () => "new" }];
assert.equal(run('looksSent(oldInput,new Set(["old"]))'), true, "new posted message did not acknowledge submission");
console.log("ChatGPT submission regressions: ok");
