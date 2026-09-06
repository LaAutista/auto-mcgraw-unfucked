import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const prompts = ["Continuous", "Emission-line", "Absorption-line"];
const choices = [
  "Only specific colors are present; formed by hot, thin gases",
  "Almost all colors are present, but specific colors are dim or missing; formed by cooler gases",
  "All colors are present; formed by dense materials",
];
const context = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  setInterval: () => 1,
  document: { querySelector: () => null },
  chrome: {
    storage: { sync: { get: (_keys, cb) => cb({}) }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener() {}, removeListener() {} } },
  },
  prompts, choices,
});
const run = (code) => vm.runInContext(code, context);
run(readFileSync(new URL("../content-scripts/mheducation.js", import.meta.url), "utf8"));
run(`getMatchingResponseSlots = () => prompts.map((promptText, rowIndex) => ({promptText,rowIndex,slotIndex:0}));
     getMatchingChoiceItems = () => choices;
     getMatchingChoiceText = (choice) => choice;`);
const answers = [
  `${prompts[0]} -> ${choices[2]}`,
  `${prompts[1]} -> ${choices[0]}`,
  `${prompts[2]} -> ${choices[1]}`,
];
const targets = (answer) => {
  context.answer = answer;
  return JSON.parse(run("JSON.stringify(normalizeMatchingTargets({}, answer))"))
    .map(({ choiceText }) => choiceText);
};
for (const answer of [answers, answers.join("\n"), answers.join("; "), answers.join(", ")]) {
  assert.deepEqual(targets(answer), [choices[2], choices[0], choices[1]],
    "punctuation inside spectrum choices corrupted the matching targets");
}
assert.deepEqual(targets([choices[2], choices[0], choices[1]]), [choices[2], choices[0], choices[1]],
  "split punctuation in exact sequential choices");
assert.equal(run('parseMatchingAnswerReference("all colors are present", choices, "choice")'), "",
  "silently chose the first ambiguous substring match");
assert.equal(run('parseMatchingAnswerReference("All colors are present; formed by dense materials", choices, "choice")'), choices[2]);
assert.equal(run('parseMatchingAnswerReference("dense materials", choices, "choice")'), choices[2],
  "lost the unambiguous legacy shorthand");
assert.equal(run('parseMatchingAnswerReference("Option trading", ["Option trading", "Trading"], "choice")'), "Option trading",
  "stripped a real choice prefix before checking the exact text");
assert.equal(run('parseMatchingAnswerReference("2", ["2", "different"], "choice")'), "2",
  "treated an exact numeric choice as a positional reference");
context.choices = ["Specific colors; note: hot, thin gases", "Second choice", "Third choice"];
assert.deepEqual(targets([
  "Continuous -> Specific colors; note: hot, thin gases",
  "Emission-line -> Second choice",
  "Absorption-line -> Third choice",
]), context.choices, "split an exact full entry at the colon inside its choice");
console.log("Matching choice punctuation and ambiguous references: ok");
