import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let listener;
const scheduled = [];
let clicks = 0;
const input = { checked: false, click() { clicks++; this.checked = true; } };
const context = vm.createContext({
  console,
  MutationObserver: class { observe() {} },
  setTimeout: fn => scheduled.push(fn),
  document: {
    body: {},
    querySelector: () => null,
    querySelectorAll: selector => selector === '.answers--mc input[type="radio"]' ? [input] :
      selector === '.answers--mc .answer__label--mc' ? [{ textContent: 'Bedřich\nSmetana' }] : [],
  },
  chrome: { runtime: { onMessage: { addListener: fn => { listener = fn; } } } },
});
vm.runInContext(readFileSync(new URL('../content-scripts/ezto-mheducation.js', import.meta.url), 'utf8'), context);
assert.equal(vm.runInContext('handleMultipleChoiceAnswer("Bedřich Smetana")', context), 1);
assert.equal(clicks, 1);
assert.equal(vm.runInContext('isOptionMatch(" Hector\\nBerlioz ", "Hector Berlioz.")', context), true);
assert.equal(vm.runInContext('isOptionMatch("Hector Berlioz", "Berlioz")', context), false);
assert.equal(vm.runInContext('isOptionMatch("Hector Berlioz", null)', context), false);
assert.equal(vm.runInContext('isOptionMatch("Hector Berlioz", "Richard Wagner")', context), false);
let acknowledged = false;
let processed = false;
context.processChatGPTResponse = () => {
  assert.equal(acknowledged, true, 'transport acknowledgment must precede blocking manual fallback');
  processed = true;
};
listener({ type: 'processChatGPTResponse', response: '{"answer":null}' }, {}, () => { acknowledged = true; });
assert.equal(acknowledged, true);
assert.equal(processed, false);
scheduled.shift()();
assert.equal(processed, true);
// An unidentified recording must not clear a saved fill-in answer and advance.
const blank = { value: 'saved answer', dispatchEvent() { throw new Error('Unexpected input event'); } };
context.document.querySelector = selector => selector === '.answer--input__input' ? blank : null;
assert.equal(vm.runInContext('handleFillInTheBlankAnswer(null)', context), 0);
assert.equal(blank.value, 'saved answer');

// Next within a multipart group changes the title but leaves the footer unchanged.
let poll;
let resumed = false;
context.setInterval = fn => { poll = fn; return 1; };
context.clearInterval = () => {};
context.checkForNextStep = () => { resumed = true; };
context.document.title = 'Question 19 - Connect';
context.document.querySelector = selector => selector === '.footer__progress__heading' ? { textContent: '19 20 21 of 40' } : null;
vm.runInContext('isAutomating = true; pauseForManualAndResume()', context);
poll();
assert.equal(scheduled.length, 0, 'must remain paused on the same question');
context.document.title = 'Question 20 - Connect';
poll();
scheduled.shift()();
assert.equal(resumed, true);
console.log('EZTO wrapped labels and response acknowledgment: ok');
