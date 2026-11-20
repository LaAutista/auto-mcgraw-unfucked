## Recording questions in Connect

Auto-McGraw 3.0.1 includes the visible Required information, recording credits, and descriptive audio filenames when sending Connect EZTO questions to ChatGPT. It does not play, download, or transcribe audio. Only the filename is sent, without the media URL or its query parameters.

When the metadata is insufficient, ChatGPT is instructed to return no answer so the question can be reviewed manually.

## Fixes

- Match answer labels split across lines, including composer names such as Bedřich Smetana.
- Acknowledge an answer before showing a manual-review alert, preventing repeated deliveries while the alert is open.
- Resume after manual review when advancing between parts of the same question group.
- Preserve saved fill-in answers when ChatGPT returns no answer.

The SmartBook matching and reordering fixes from [3.0](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/tag/v3.0) remain included. Firefox and ChatGPT are the supported browser/provider combination.

## Verification

Recording metadata was verified in a live Firefox Connect run from question 17. After correcting the wrapped-name mismatch at question 19, the run reached question 40 without further observed stalls. The user completed submission. No final score is claimed.

All 14 regression files pass. The final no-answer and multipart recovery guards were checked by regression tests; those fallback paths were not triggered again during the live run.

## Install

Download the Firefox XPI below. In Firefox 140 or newer, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the XPI. During an update, leave the McGraw quiz open and refresh ChatGPT. This unsigned add-on must be loaded again after restarting Firefox.

**SHA-256**

```text
7157e2d8ec47c150b02715c7377ab4ae95f9db58e571ff2ae9e61c022037d2e1
```
