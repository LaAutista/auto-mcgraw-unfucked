# 3.0

This Firefox build uses ChatGPT as its only provider, including for users who saved another provider in 2.x. It carries forward the ChatGPT composer changes from the desktop 2.12.4 build.

SmartBook changed both drag controls. Matching choices now live in native draggable items, and ranking rows have their own drop targets. Auto-McGraw reads the displayed choice text, sends the choices to ChatGPT, performs the requested moves, and checks the resulting slots or order before submitting. If the choices have yet to render, it waits. The original SmartBook drag layout remains covered by regression tests.

The previous double-credit setting is retired. All question types use the original assignment tab.

## Firefox verification

During the live astronomy assignment, 2.12.4 had stopped at 8 of 23 concepts after sending a matching question without its choices. An intermediate 3.0 build filled that question and advanced. At 10 of 23, the ordering question exposed a different row layout. For the final retest, the first item was moved to third before starting automation. The extension restored the four-item order. McGraw marked all four correct and advanced to 11 of 23.

The final build ran from 10 of 23 concepts through the SmartBook completion summary, which reported **100% accuracy and zero challenging concepts out of 23**. No answers were entered manually after the ordering retest started. The rolling diagnostic log retained the last 17 submitted answers, with one confidence click and one successful delivery per request. Those answers included one additional ranking and two matching questions. Six requests included image attachments. The final event was `mhe.run.completed`.

All 12 Node regression files passed, including current and legacy ordering and matching checks. The Firefox XPI was verified against the source and has SHA-256 `ea851fd508aa9605b2a8f89770dde964da3118b88f46a384cd9bd54e7d6a62e7`. Live coverage was Firefox 160 with ChatGPT on this SmartBook assignment.

# v2.12.3 — first maintained fork release

The first official maintained release of **auto-mcgraw-unfucked**, LaAutista's community fork of GooglyBlox/auto-mcgraw. Earlier trial releases are retired. The version remains **2.12.3** to retain the identity of the Firefox build that was actually tested; its Firefox XPI is preserved byte-for-byte.

## Downloads

- **Firefox, primary:** `auto-mcgraw-firefox-2.12.3-unsigned.xpi`.
- **Chrome / Brave, experimental:** `auto-mcgraw-chrome-brave-2.12.3-experimental.zip`. Chromium 121+; not runtime-tested.
- **Checksums:** `SHA256SUMS.txt` covers both browser packages.

Firefox 140 or newer is required. Load the unsigned XPI through `about:debugging` → **This Firefox** → **Load Temporary Add-on**. Reload it after Firefox restarts; permanent installation in standard Firefox requires Mozilla signing. For diagram questions, use **Allow question images** in settings if the image-server permission has not been granted.

Firefox XPI SHA-256:

```text
27857559bf1333bbf2145954e33ed5208633e8005e7fb1a17adb8d2ece5fa21a
```

## Repairs included

- Removed the Ask button's dependency on suppressible native confirmation dialogs; manual pauses and errors now remain visible on the page.
- Corrected tab activation and kept ChatGPT foregrounded while it renders its answer.
- Hardened response capture against animated JSON artifacts, remounted old messages, and empty assistant placeholders following image replies.
- Confirmed prompt submission from the live composer and the newly posted user message.
- Removed grading feedback from choice text and stopped graded questions from being queued again before the next question loads.
- Added supported McGraw diagram attachments and accessible descriptions for ChatGPT. Upload failures and empty answers now have explicit handling.
- Preserved punctuation inside matching choices and rejected ambiguous partial matches instead of selecting the first similar choice.
- Added a local, exportable 300-event diagnostic log without question text, answer text, images, or login data.

## What was verified

A real Firefox/ChatGPT SmartBook assignment was monitored from a stall at **8/27 concepts** through completion. Repairs were made during that run. McGraw's completion screen reported **27/27 concepts, 100% accuracy, and zero challenging concepts**.

The final **v2.12.3** build was observed from **23/27 through completion**: four queued requests and four successful answer deliveries, including the repaired image-based matching question. No failed delivery, error, manual pause, or slow-answer event was logged in that final segment, and automation stopped on completion.

This is **not** a claim that v2.12.3 completed a fresh 27-concept assignment without intervention. It is evidence for the monitored assignment and final four-concept segment, not every future course or website layout.

All **12 regression test files** passed. Archive integrity passed, and the Firefox package's manifest, background, content scripts, and settings matched the tested source. The experimental Chrome/Brave package has no live-browser validation claim. Other AI providers and course integrations were not separately live-tested for this release.

## Credits

Based on [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw). The original copyright notice and [MIT license](https://github.com/LaAutista/auto-mcgraw-unfucked/blob/v2.12.3/LICENSE) are retained. This is an independent community fork, not an official McGraw Hill product.
