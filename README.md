# Auto-McGraw

Auto-McGraw is a Firefox extension for McGraw Hill SmartBook and Connect quizzes. Click **Ask ChatGPT** on a question and the extension sends its text and choices to your open ChatGPT tab. It brings the answer back, fills it in, and advances through supported questions. SmartBook also supports question diagrams and automatic answer submission.

**[Download Auto-McGraw 3.0 for Firefox](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/download/v3.0/auto-mcgraw-firefox-3.0-unsigned.xpi)** · [3.0 release notes](https://github.com/LaAutista/auto-mcgraw-unfucked/releases/tag/v3.0)

## Install in Firefox

1. Download the XPI above. Use Firefox 140 or newer.
2. Open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select the downloaded XPI.
3. Open or refresh your SmartBook assignment and ChatGPT in separate tabs. Sign in to both.

The XPI is unsigned. Load it again after restarting Firefox.

## Use it on an assignment

Click **Ask ChatGPT** in the SmartBook header to start. By default, Auto-McGraw submits each answer in the assignment tab. To review answers first, open the settings beside **Ask ChatGPT** and turn on **Pause Before Submit**. Click **Stop Automation** to stop the run.

For multiple-choice, multiple-select, true/false, and fill-in-the-blank questions, the extension clicks the corresponding controls or fills the blanks. Version 3.0 also handles SmartBook’s current drag-and-drop layouts.

- **Matching questions.** Auto-McGraw reads the prompts and the labels on the draggable choices. It moves each choice into the corresponding slot and checks the placements before submitting.
- **Ordering questions.** Auto-McGraw sends the displayed items to ChatGPT, moves the rows into the returned sequence, and reads the list back to verify the order before submitting.

If a placement fails verification, SmartBook stays on the question for manual review. For questions with diagrams, use **Allow question images** in settings if Firefox requests site access.

## Connect recording questions in 3.0.1

For Connect EZTO questions, Auto-McGraw includes the visible **Required information** text, recording credits, and audio reference filenames in the ChatGPT prompt. It does not play, download, or transcribe audio. Full media URLs and their query parameters are omitted. If the supplied metadata cannot identify the excerpt, ChatGPT is instructed to return no answer, and Auto-McGraw pauses for manual review.

Wrapped answer labels are matched with whitespace normalized, so a composer's name split across lines still matches. Connect quiz submission remains a separate step after the last question.

## Data and diagnostics

Question content, recording metadata, and supported images go to ChatGPT through your signed-in tab. **Save diagnostic log** in settings exports the last 300 local events, including request status, answer delivery, and navigation. Question text, answer text, and images are excluded from the log.

Based on [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw). Distributed under the [MIT license](LICENSE).
