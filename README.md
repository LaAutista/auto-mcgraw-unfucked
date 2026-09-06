# auto-mcgraw-unfucked

A Firefox-first community fork of [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw), maintained by LaAutista. Fixes unreliable ChatGPT answer capture, tab switching, duplicate question requests, diagram questions, and matching-choice parsing in McGraw Hill SmartBook.

## Release status

**v2.12.3 is this fork's first maintained release.** It keeps the version of the verified Firefox build; earlier trial releases are retired. See [release notes](RELEASE_NOTES.md) for the fixes and validation limits.

Firefox with ChatGPT is the live-tested combination. The monitored assignment finished at **27/27 concepts with 100% accuracy** after repairs during the run. The final v2.12.3 build covered the last four concepts, not a fresh, uninterrupted 27-concept run. Chrome/Brave packaging is experimental and has not been runtime-tested.

This fork is not published on browser extension stores. Download packages from this repository's [releases page](https://github.com/LaAutista/auto-mcgraw-unfucked/releases).

## Installation

### Firefox — primary build

Requires Firefox 140 or newer.

1. Download [auto-mcgraw-firefox-2.12.3-unsigned.xpi](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/download/v2.12.3/auto-mcgraw-firefox-2.12.3-unsigned.xpi).
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on** and select the XPI.
4. Refresh existing SmartBook and ChatGPT tabs after installing or upgrading.

The XPI is unsigned. Temporary installation ends when Firefox restarts; reload it through `about:debugging` afterward. Permanent installation in standard Firefox requires a Mozilla-signed XPI. This release does not bypass signing requirements.

For diagram questions, open extension settings and click **Allow question images** if Firefox has not granted access to McGraw's image server.

### Chrome / Brave — experimental, untested

Requires Chromium 121 or newer (including a corresponding Brave version).

1. Download [auto-mcgraw-chrome-brave-2.12.3-experimental.zip](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/download/v2.12.3/auto-mcgraw-chrome-brave-2.12.3-experimental.zip) and extract it.
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
3. In extension settings, select ChatGPT and leave **Switch Between Tabs** enabled for the tested workflow.
4. Click **Ask ChatGPT** in the SmartBook header. The extension sends the question, collects the answer, and fills it. With **Pause Before Submit** off, it also submits and advances.

Use **Pause Before Submit** to review filled answers yourself. Click **Stop Automation** to stop. If an answer cannot be matched safely, follow the on-page manual-pause instructions; automation can resume after you advance manually.

Gemini, DeepSeek, EZTO, and MuzzyLane support remain in the source, but were not separately live-validated for this release. Diagram attachments currently require ChatGPT. AI answers can still be wrong, and site changes can break automation.

## Diagnostics and privacy

Open settings and click **Save diagnostic log** to export the local 300-event log. It contains request, answer-delivery, navigation, and error metadata—not question text, answer text, images, or login data. Review any export before sharing it publicly.

The extension reads visible assignment content and sends it to the selected AI service through that service's browser tab. Supported question images are fetched from McGraw and attached to ChatGPT. No analytics server or data collection endpoint operated by LaAutista is used. Settings use browser sync storage; diagnostics stay in local extension storage. The selected AI service's privacy policy applies to the content it receives.

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
