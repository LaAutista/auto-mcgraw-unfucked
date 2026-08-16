let messageListener = null;
let isAutomating = false;
let waitingForAI = false;
let loopId = null;
let idleTicks = 0;
let buttonAdded = false;

const TICK_MS = 1500;
const MAX_IDLE_TICKS = 40;
const LOG_PREFIX = "[Auto-McGraw][muzzy]";

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "processChatGPTResponse") {
      handleAIResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      showToast(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      stopAutomation();
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function isVisible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

const OPTION_CONTAINER_SELECTORS = [
  ".prompt-container",
  ".single-submit-area",
  '[role="region"][aria-label="Response"]',
  '[role="region"][aria-label="Choices"]',
  '[role="region"][aria-label="Options"]',
];
const OPTION_CANDIDATE_SELECTOR =
  'button, [role="button"], a, li, [class*="choice"], [class*="option"], [class*="answer"]';
const SUBMIT_DELAY_MS = 800;

function isSubmitControl(el) {
  return /^\s*(submit|check( answer)?)\s*$/i.test(el.textContent.trim());
}

function getOptionContainers() {
  const containers = [];
  for (const selector of OPTION_CONTAINER_SELECTORS) {
    for (const container of document.querySelectorAll(selector)) {
      if (!containers.includes(container)) {
        containers.push(container);
      }
    }
  }
  return containers;
}

// Decision options may be <button>s, links, or clickable rows. Only
// innermost candidates count, so a wrapper holding all options isn't
// mistaken for an option itself.
function getDecisionButtons() {
  const seen = new Set();
  const buttons = [];

  for (const container of getOptionContainers()) {
    for (const el of container.querySelectorAll(OPTION_CANDIDATE_SELECTOR)) {
      if (!el.textContent.trim() || !isVisible(el)) continue;
      if (el.classList.contains("single-submit-btn")) continue;
      if (isSubmitControl(el)) continue;
      if (el.querySelector(OPTION_CANDIDATE_SELECTOR)) continue;

      const key = el.textContent.trim().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
      buttons.push(el);
    }
  }

  return buttons;
}

function getSubmitButton() {
  for (const container of getOptionContainers()) {
    for (const el of container.querySelectorAll('button, [role="button"], a')) {
      if (isVisible(el) && isSubmitControl(el)) {
        return el;
      }
    }
  }

  // Submit may reuse the single-submit button with a different label.
  const single = document.querySelector(".single-submit-btn");
  if (single && isVisible(single) && isSubmitControl(single)) {
    return single;
  }
  return null;
}

function getContinueButton() {
  const btn = document.querySelector(".single-submit-btn");
  if (
    btn &&
    btn.getAttribute("aria-disabled") !== "true" &&
    isVisible(btn) &&
    /continue/i.test(btn.textContent)
  ) {
    return btn;
  }
  return null;
}

// The AI judges decisions on the recent conversation, so collect the last
// few chat lines as "Speaker: text".
function collectContext() {
  const rows = Array.from(document.querySelectorAll('.chat-window [id^="row-"]'));
  const lines = [];

  for (const row of rows.slice(-12)) {
    const speakerEl = row.querySelector(".speaker span");
    const textEl = row.querySelector(".convo-line span");
    const speaker = speakerEl ? speakerEl.textContent.trim() : "";
    const text = textEl ? textEl.textContent.trim() : "";
    if (text) {
      lines.push(`${speaker}: ${text}`);
    }
  }

  return lines.join("\n");
}

function askAI() {
  const context = collectContext();
  const options = getDecisionButtons().map((btn) =>
    btn.textContent.trim().replace(/\s+/g, " ")
  );

  console.info(LOG_PREFIX, "decision point detected, options:", options);

  waitingForAI = true;
  chrome.runtime.sendMessage({
    type: "sendQuestionToChatGPT",
    question: {
      type: "sim_choice",
      question: context,
      options: options,
      previousCorrection: null,
    },
  });
}

function tick() {
  if (!isAutomating || waitingForAI) return;

  const decisionButtons = getDecisionButtons();
  if (decisionButtons.length >= 2) {
    idleTicks = 0;
    askAI();
    return;
  }

  const continueButton = getContinueButton();
  if (continueButton) {
    idleTicks = 0;
    continueButton.click();
    return;
  }

  idleTicks++;
  if (idleTicks >= MAX_IDLE_TICKS) {
    stopAutomation(
      "No interactive elements found for a while - the simulation may be complete, or this screen type isn't recognized yet (if answer choices are visible on screen, please report this screen)"
    );
  }
}

function isOptionMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) {
    return false;
  }

  const choice = String(choiceText).trim().replace(/\s+/g, " ");
  const ans = String(answerText).trim().replace(/\s+/g, " ");
  if (!choice || !ans) return false;

  if (choice === ans) return true;
  if (choice.replace(/\.$/, "") === ans.replace(/\.$/, "")) return true;
  if (choice === ans + ".") return true;

  return choice.includes(ans) || ans.includes(choice);
}

function handleAIResponse(responseText) {
  if (!isAutomating) {
    waitingForAI = false;
    return;
  }

  try {
    const response = JSON.parse(responseText);
    const answer = Array.isArray(response.answer)
      ? response.answer[0]
      : response.answer;

    const buttons = getDecisionButtons();
    for (const btn of buttons) {
      if (isOptionMatch(btn.textContent.trim(), String(answer))) {
        const signature = buttons
          .map((b) => b.textContent.trim().replace(/\s+/g, " "))
          .join("|");
        btn.click();
        console.info(LOG_PREFIX, "selected option:", btn.textContent.trim());
        // Keep waitingForAI set so the tick loop doesn't re-ask the AI
        // while we wait to see if a separate Submit click is needed.
        setTimeout(() => confirmSubmissionIfNeeded(signature), SUBMIT_DELAY_MS);
        return;
      }
    }

    waitingForAI = false;
    stopAutomation(
      "The AI's answer did not match any response option: " +
        JSON.stringify(response.answer)
    );
  } catch (e) {
    waitingForAI = false;
    console.error(LOG_PREFIX, "Error processing response:", e);
    stopAutomation("Error processing AI response: " + e.message);
  }
}

// Some decisions submit on option click; others need a separate Submit
// click. If the same options are still on screen after the delay, the sim
// is waiting for Submit. If they changed, the option click already
// advanced the sim and there's nothing more to do.
function confirmSubmissionIfNeeded(signature) {
  waitingForAI = false;
  if (!isAutomating) return;

  const current = getDecisionButtons()
    .map((b) => b.textContent.trim().replace(/\s+/g, " "))
    .join("|");
  if (current !== signature) return;

  const submit = getSubmitButton();
  if (submit) {
    submit.click();
    console.info(LOG_PREFIX, "clicked Submit");
  }
}

function startAutomation() {
  isAutomating = true;
  waitingForAI = false;
  idleTicks = 0;
  if (loopId) clearInterval(loopId);
  loopId = setInterval(tick, TICK_MS);
}

function stopAutomation(reason) {
  isAutomating = false;
  waitingForAI = false;
  if (loopId) {
    clearInterval(loopId);
    loopId = null;
  }
  updateButtonText();
  if (reason) {
    showToast(`Automation stopped: ${reason}`);
  }
}

// Cross-origin iframes can't show alert()/confirm() dialogs (the browser
// silently ignores them), so surface messages as an in-page toast instead.
function showToast(text) {
  let toast = document.getElementById("automcgraw-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "automcgraw-toast";
    toast.style.cssText = `
      position: fixed;
      top: 8px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(20, 20, 20, 0.92);
      color: #fff;
      padding: 10px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-family: inherit;
      z-index: 999999;
      max-width: 80%;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.style.display = "block";

  clearTimeout(toast.__hideTimer);
  toast.__hideTimer = setTimeout(() => {
    toast.style.display = "none";
  }, 8000);
}

function updateButtonText() {
  chrome.storage.sync.get("aiModel", function (data) {
    const aiModel = data.aiModel || "chatgpt";
    let modelName = "ChatGPT";

    if (aiModel === "gemini") {
      modelName = "Gemini";
    } else if (aiModel === "deepseek") {
      modelName = "DeepSeek";
    }

    const btn = document.querySelector(".automcgraw-sim-btn");
    if (btn && !isAutomating) {
      btn.textContent = `Ask ${modelName}`;
    }
  });
}

function addAssistantButton() {
  if (buttonAdded) return;

  const bannerBtns = document.querySelector(".banner-bar-btns");
  if (!bannerBtns) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "automcgraw-sim-btn";
  btn.style.cssText = `
    background: #fff;
    border: 1px solid #ccc;
    color: #333;
    padding: 4px 10px;
    font-size: 13px;
    font-family: inherit;
    cursor: pointer;
    border-radius: 4px;
    margin-right: 6px;
  `;

  btn.addEventListener("click", () => {
    if (isAutomating) {
      stopAutomation("Manual stop");
    } else {
      btn.textContent = "Stop Automation";
      showToast("Automation started - click the button again to stop.");
      startAutomation();
    }
  });

  bannerBtns.insertBefore(btn, bannerBtns.firstChild);
  buttonAdded = true;
  updateButtonText();
}

function startPageObserver() {
  const observer = new MutationObserver(() => {
    if (!buttonAdded) {
      addAssistantButton();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  addAssistantButton();
}

setupMessageListener();
startPageObserver();
