<div align="center">

# Auto-McGraw (Smartbook)

<img src="assets/icon.png" alt="Auto-McGraw Logo" width="200">

[![Release](https://img.shields.io/github/v/release/LaAutista/auto-mcgraw-unfucked?include_prereleases&style=flat-square&cache=1)](https://github.com/LaAutista/auto-mcgraw-unfucked/releases)
[![License](https://img.shields.io/github/license/LaAutista/auto-mcgraw-unfucked?style=flat-square&cache=1)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/LaAutista/auto-mcgraw-unfucked/total?style=flat-square&cache=1)](https://github.com/LaAutista/auto-mcgraw-unfucked/releases)

*Automate your McGraw Hill Smartbook homework with AI integration (ChatGPT, Gemini & DeepSeek)*

[Installation](#installation) • [Usage](#usage) • [Settings](#settings) • [Privacy](#privacy) • [Issues](#issues)

</div>

> [!NOTE]
> This is LaAutista's community fork of
> [GooglyBlox/auto-mcgraw](https://github.com/GooglyBlox/auto-mcgraw). It adds
> more reliable AI response handling plus Connect, EZTO, and MuzzyLane support.

---

## Public Service Announcement

**⚠️ Auto-McGraw is not published on the Chrome Web Store.** This GitHub repository is the only official place to download the extension. We've seen fraudulent/unofficial reuploads of Auto-McGraw appear on the Chrome Web Store — these are not affiliated with this project and we cannot vouch for their safety or integrity. Only install from this repository's [releases page](https://github.com/LaAutista/auto-mcgraw-unfucked/releases).

---

## Installation

### Brave or Chrome

1. Download `auto-mcgraw-brave-chrome.zip` from the [releases page](https://github.com/LaAutista/auto-mcgraw-unfucked/releases)
2. Extract the zip file to a folder
3. Open `brave://extensions/` or `chrome://extensions/`
4. Enable "Developer mode" in the top right
5. Click "Load unpacked" and select the extracted folder

### Firefox

1. Download `auto-mcgraw-firefox-unsigned.xpi` from the [releases page](https://github.com/LaAutista/auto-mcgraw-unfucked/releases)
2. Open `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on" and select the XPI

The temporary Firefox installation lasts until Firefox restarts. Permanent
installation in standard Firefox requires a Mozilla-signed XPI. Firefox 140 or
newer is required.

## Usage

1. Log into your McGraw Hill account and open a Smartbook assignment
2. Log into one of the supported AI assistants in another tab:
   - [ChatGPT](https://chatgpt.com)
   - [Gemini](https://gemini.google.com)
   - [DeepSeek](https://chat.deepseek.com)
3. Click the "Ask [AI Model]" button that appears in your Smartbook header
4. Click "OK" when prompted to begin automation
5. Watch as the extension:
   - Sends questions to your chosen AI assistant
   - Processes the responses
   - Automatically fills in answers
   - Handles multiple choice, true/false, fill-in-the-blank, and matching questions
      - **Note about matching questions:** Matching questions now attempt full automation. If a strict, reliable match cannot be completed, the extension will show AI-suggested matches in an alert, pause, and let you finish manually before resuming on the next question.
   - Navigates through forced learning sections when needed

Click "Stop Automation" at any time to pause the process.

## Settings

Click the settings icon ( <img src="assets/settings-icon.svg" alt="Settings Icon" style="vertical-align: middle; width: 16px; height: 16px;"> ) next to the main button to access the settings menu, where you can:

- Choose between **ChatGPT**, **Gemini**, or **DeepSeek** for answering questions
- See the status of your AI assistant connections
- Check if your selected AI assistant is ready to use

The extension will automatically use your selected AI model for all future automation sessions.

## Privacy

Auto-McGraw reads visible assignment content and sends it to the AI service you
select by entering it in that service's browser tab. It does not send data to
LaAutista or use an analytics server. Extension settings are stored with the
browser's sync storage. The selected AI service's privacy policy applies to the
content sent to it.

## Disclaimer

This tool is for educational purposes only. Use it responsibly and be aware of your institution's academic integrity policies.

Auto-McGraw is an independent project and is not affiliated with, endorsed by, sponsored by, or otherwise associated with McGraw Hill or any of its related entities.

Any third-party names, trademarks, logos, assets, or likenesses referenced or displayed by this project remain the property of their respective owners and copyright holders.

## Issues

Found a bug? [Create an issue](https://github.com/LaAutista/auto-mcgraw-unfucked/issues).
