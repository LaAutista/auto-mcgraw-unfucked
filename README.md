# auto-mcgraw-unfucked

A Firefox-first community fork of [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw), maintained by LaAutista. Fixes unreliable ChatGPT answer capture, tab switching, duplicate question requests, diagram questions, and matching-choice parsing in McGraw Hill SmartBook.

## Release status

**3.0** is the Firefox build for ChatGPT. It includes the 2.12.4 composer updates and supports both the current native drag controls and the older SmartBook matching and ordering layouts. The extension reads back the placements before submitting. The legacy double-credit mode was removed. Each question is submitted in its original tab.

See [release notes](RELEASE_NOTES.md) for the live test and its scope. The previous published release is available on [GitHub](https://github.com/LaAutista/auto-mcgraw-unfucked/releases).

## Installation

### Firefox — primary build

Requires Firefox 140 or newer.

1. Use the supplied `auto-mcgraw-firefox-3.0-unsigned.xpi`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the XPI.
4. Refresh existing SmartBook and ChatGPT tabs after installing or upgrading.

The XPI is unsigned. Temporary installation ends when Firefox restarts; reload it through `about:debugging` afterward. Permanent installation in standard Firefox requires a Mozilla-signed XPI. This release does not bypass signing requirements.

For diagram questions, open extension settings and click **Allow question images** if Firefox has not granted access to McGraw's image server.

### Chrome / Brave — experimental, untested

Requires Chromium 121 or newer (including a corresponding Brave version).

1. For a Chromium candidate, run the repository’s **Build Release Candidates** workflow and extract the experimental Chromium ZIP from its artifacts.
2. Open `chrome://extensions/` or `brave://extensions/`.
3. Enable **Developer mode**, click **Load unpacked**, and select the extracted folder.

This package is provided for testing, not as a verified equivalent of the Firefox build.

## What was fixed

- **Ask does nothing after blocking dialogs:** the explicit Ask button starts directly, without a browser confirmation popup. Errors and manual-pause instructions stay visible on the page.
- **ChatGPT answers are missed or captured incorrectly:** waits for completed, settled JSON; rejects observed animation artifacts; tracks message IDs; ignores empty trailing assistant placeholders; verifies that prompts actually send.
- **Tab switching stalls:** activates tabs even when window focus is denied and keeps ChatGPT foregrounded until its answer is ready.
- **Repeated questions after grading:** excludes correctness labels from choices and waits for an actual question transition before requesting another answer.
- **Diagram questions and empty answers:** attaches up to four supported McGraw diagrams to ChatGPT, includes accessible descriptions, and makes upload failures or empty answers visible instead of retrying forever.
- **Broken matching choices:** preserves semicolons and commas within exact choices and rejects ambiguous partial matches.
- **Failures without useful diagnostics:** keeps the last 300 diagnostic events locally, with an export button in settings.

## Usage

1. Open a SmartBook assignment while logged into McGraw Hill.
2. Open [ChatGPT](https://chatgpt.com) in another tab and log in.
3. In extension settings, leave **Switch Between Tabs** enabled for the tested workflow.
4. Click **Ask ChatGPT** in the SmartBook header. The extension sends the question, collects the answer, and fills it. With **Pause Before Submit** off, it also submits and advances.

Use **Pause Before Submit** to review filled answers yourself. Click **Stop Automation** to stop. If an answer cannot be matched safely, follow the on-page manual-pause instructions; automation can resume after you advance manually.

EZTO and MuzzyLane remain in the source. The 3.0 live run covered SmartBook in Firefox. AI answers can still be wrong, and site changes can break automation.

## Diagnostics and privacy

Open settings and click **Save diagnostic log** to export the local 300-event log. It contains request, answer-delivery, navigation, and error metadata—not question text, answer text, images, or login data. Review any export before sharing it publicly.

The extension reads visible assignment content and sends it to ChatGPT through its browser tab. Supported question images are fetched from McGraw and attached to ChatGPT. No analytics server or data collection endpoint operated by LaAutista is used. Settings use browser sync storage; diagnostics stay in local extension storage. OpenAI’s privacy policy applies to the content it receives.

## Development

Run all 12 regression test files with Node.js:

```sh
node --test tests/*.test.mjs
```

Passing these tests does not establish compatibility with every course, browser, or future site layout.

The manually triggered **Build Release Candidates** GitHub workflow runs these
tests and creates browser packages with checksums. It does not publish releases
or replace previously tested downloads.

## Credits and license

Based on [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw). The original GooglyBlox copyright notice and [MIT license](LICENSE) are preserved.

This independent project is not affiliated with or endorsed by McGraw Hill, OpenAI, or other named services. Third-party names and assets belong to their respective owners. Use responsibly and follow your institution's academic-integrity policies.

Found a bug? [Open an issue](https://github.com/LaAutista/auto-mcgraw-unfucked/issues) with the browser, extension version, and relevant diagnostic events.
