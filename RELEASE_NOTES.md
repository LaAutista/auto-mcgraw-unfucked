## Matching and reordering

- **Matching choices are included again.** On SmartBook’s updated layout, the extension sometimes sent ChatGPT the prompts with an empty list of choices. Auto-McGraw now reads the labels from the draggable items, moves each answer into its slot, and verifies the placements before submitting.
- **Ordering questions now move the rows.** Auto-McGraw reads the items in their displayed order, asks ChatGPT for the complete sequence, and uses SmartBook’s native drag controls to put each row in place. It checks the final order before submitting.

## Verified in Firefox

During a live SmartBook assignment in Firefox 160, the final XPI took over at 10 of 23 concepts. For the ordering test, the first item was deliberately moved to third. Auto-McGraw restored the four-item sequence and SmartBook marked every placement correct. The extension continued through completion. SmartBook’s summary reported 100% accuracy for the assignment. All 12 regression test files also passed.

## Install

Download the [Firefox 3.0 XPI](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/download/v3.0/auto-mcgraw-firefox-3.0-unsigned.xpi). In Firefox 140 or newer, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the XPI. Refresh the SmartBook and ChatGPT tabs. Repeat the temporary installation after restarting Firefox.

**SHA-256 of the tested XPI**

```text
ea851fd508aa9605b2a8f89770dde964da3118b88f46a384cd9bd54e7d6a62e7
```
