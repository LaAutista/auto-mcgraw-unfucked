let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let buttonAdded = false;
let manualPauseIntervalId = null;

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "processChatGPTResponse") {
      processChatGPTResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      stopAutomation(null);
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function isQuizPage() {
  const hasPrompt =
    document.querySelector(".question") ||
    document.querySelector(".worksheet__main");

  return (
    hasPrompt &&
    (document.querySelector(".answers-wrap.multiple-choice") ||
      document.querySelector(".answers-wrap.boolean") ||
      document.querySelector(".answers-wrap.input-response") ||
      document.querySelector(".answers-wrap.ranking") ||
      document.querySelector('.answers-wrap input[type="checkbox"]') ||
      document.querySelector(
        ".worksheet__main fieldset .worksheet--mc__choices"
      ))
  );
}

function checkForQuizAndAddButton() {
  if (buttonAdded) return;

  const helpLink = document.querySelector(".header__help");
  if (helpLink && isQuizPage()) {
    addAssistantButton();
    buttonAdded = true;
  }
}

function startPageObserver() {
  const observer = new MutationObserver(() => {
    if (!buttonAdded) {
      checkForQuizAndAddButton();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  checkForQuizAndAddButton();
}

function checkForQuizEnd() {
  const progressInfo = document.querySelector(".footer__progress__heading");

  if (progressInfo) {
    const progressText = progressInfo.textContent;
    const match = progressText.match(/(\d+)\s+of\s+(\d+)/);
    if (match) {
      const current = parseInt(match[1]);
      const total = parseInt(match[2]);
      if (current > total) {
        return true;
      }
    }
  }

  return false;
}

function clearManualPauseWatcher() {
  if (manualPauseIntervalId !== null) {
    clearInterval(manualPauseIntervalId);
    manualPauseIntervalId = null;
  }
}

function stopAutomation(reason = "Quiz completed") {
  isAutomating = false;
  clearManualPauseWatcher();

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";
    let currentModelName = "ChatGPT";

    if (currentModel === "gemini") {
      currentModelName = "Gemini";
    } else if (currentModel === "deepseek") {
      currentModelName = "DeepSeek";
    }

    const btn = document.querySelector(".header__automcgraw--main");
    if (btn) {
      btn.textContent = `Ask ${currentModelName}`;
    }
  });

  if (reason) {
    alert(`Automation stopped: ${reason}`);
  }
}

// After a manual fallback, resume only when the user advances to a different
// question (detected via the "N of M" counter in the footer changing).
function pauseForManualAndResume() {
  const progressEl = document.querySelector(".footer__progress__heading");
  const signature = progressEl ? progressEl.textContent.trim() : "";

  clearManualPauseWatcher();

  manualPauseIntervalId = setInterval(() => {
    if (!isAutomating) {
      clearManualPauseWatcher();
      return;
    }

    const currentEl = document.querySelector(".footer__progress__heading");
    const currentSignature = currentEl ? currentEl.textContent.trim() : "";

    if (currentSignature && currentSignature !== signature) {
      clearManualPauseWatcher();

      setTimeout(() => {
        if (isAutomating) {
          checkForNextStep();
        }
      }, 500);
    }
  }, 400);
}

function checkForNextStep() {
  if (!isAutomating) return;

  const questionData = parseQuestion();
  if (questionData) {
    chrome.runtime.sendMessage({
      type: "sendQuestionToChatGPT",
      question: questionData,
    });
  } else {
    stopAutomation("No question found or question type not supported");
  }
}

// Build input + label-text pairs for choice questions. The primary label
// markup is .answers--mc .answer__label--mc; fall back to wrapping labels or
// aria-labels so newer checkbox-based questions are covered too.
function getChoicePairs(inputSelector) {
  const inputs = Array.from(document.querySelectorAll(inputSelector));
  const labels = Array.from(
    document.querySelectorAll(".answers--mc .answer__label--mc")
  );

  return inputs.map((input, i) => {
    let text = "";
    if (labels[i]) {
      text = labels[i].textContent.trim();
    } else {
      const wrappingLabel = input.closest("label");
      if (wrappingLabel) {
        text = wrappingLabel.textContent.trim();
      } else {
        text = (input.getAttribute("aria-label") || input.value || "").trim();
      }
    }
    return { input, text };
  });
}

// Worksheet MC ("classification") questions: one prompt, then a numbered list
// of items, each with its own fieldset of radio choices (same choices per
// item). Prompt text excludes the per-item radio markup; items and the shared
// choice list go into options as { items, choices }.
function parseWorksheetMcQuestion() {
  const main = document.querySelector(".worksheet__main");
  if (!main) return null;

  const promptClone = main.cloneNode(true);
  promptClone.querySelectorAll("ol, fieldset").forEach((el) => el.remove());
  const questionText = promptClone.textContent.trim();

  const items = Array.from(main.querySelectorAll("ol > li"))
    .map((li) => {
      const firstPara = li.querySelector("p");
      return firstPara ? firstPara.textContent.trim() : "";
    })
    .filter(Boolean);

  const firstGroup = main.querySelector("fieldset");
  const choices = firstGroup
    ? Array.from(firstGroup.querySelectorAll('input[type="radio"]'))
        .map((radio) => {
          const label = firstGroup.querySelector(`label[for="${radio.id}"]`);
          return (label
            ? label.textContent
            : radio.getAttribute("title") || ""
          ).trim();
        })
        .filter(Boolean)
    : [];

  if (!items.length || !choices.length) return null;

  return {
    type: "worksheet_mc",
    question: questionText,
    options: { items, choices },
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

// The AI returns one choice per item, in item order. For each item's fieldset
// group, click the radio whose label (or title) matches. All-or-nothing:
// a partially matched worksheet is treated as unmatched for manual fallback.
function handleWorksheetMcAnswer(answer) {
  const answers = (Array.isArray(answer) ? answer : [answer]).map(String);
  const groups = Array.from(
    document.querySelectorAll(".worksheet__main fieldset")
  );
  if (!groups.length) return 0;

  let applied = 0;

  groups.forEach((group, i) => {
    const target = answers[i];
    if (!target) return;

    const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
    for (const radio of radios) {
      const label = group.querySelector(`label[for="${radio.id}"]`);
      const labelText = label ? label.textContent.trim() : "";
      const titleText = (radio.getAttribute("title") || "").trim();

      if (
        isOptionMatch(labelText, target) ||
        isOptionMatch(titleText, target)
      ) {
        if (!radio.checked) {
          radio.click();
        }
        applied++;
        break;
      }
    }
  });

  return applied === groups.length ? applied : 0;
}

function parseQuestion() {
  if (
    document.querySelector(".worksheet__main fieldset .worksheet--mc__choices")
  ) {
    return parseWorksheetMcQuestion();
  }

  const questionElement = document.querySelector(".question");
  if (!questionElement) {
    return null;
  }

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.ranking")) {
    questionType = "ranking";
    const itemElements = document.querySelectorAll(
      ".answers-wrap.ranking .answer--matching__option"
    );
    options = Array.from(itemElements).map((el) => el.textContent.trim());
  } else if (document.querySelector('.answers-wrap input[type="checkbox"]')) {
    questionType = "multiple_response";
    options = getChoicePairs('.answers-wrap input[type="checkbox"]').map(
      (pair) => pair.text.replace(/^[a-z]\s+/, "")
    );
  } else if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    const optionElements = document.querySelectorAll(
      ".answers--mc .answer__label--mc"
    );
    options = Array.from(optionElements).map((el) => {
      const textContent = el.textContent.trim();
      return textContent.replace(/^[a-z]\s+/, "");
    });
  } else if (document.querySelector(".answers-wrap.boolean")) {
    questionType = "true_false";
    options = ["True", "False"];
  } else if (document.querySelector(".answers-wrap.input-response")) {
    questionType = "fill_in_the_blank";
    options = [];
  } else {
    return null;
  }

  let questionText = "";
  if (questionType === "fill_in_the_blank") {
    const questionClone = questionElement.cloneNode(true);

    const blankSpans = questionClone.querySelectorAll(
      'span[aria-hidden="true"]'
    );
    blankSpans.forEach((span) => {
      if (span.textContent.includes("_")) {
        span.textContent = "[BLANK]";
      }
    });

    const hiddenSpans = questionClone.querySelectorAll(
      'span[style*="position: absolute"]'
    );
    hiddenSpans.forEach((span) => span.remove());

    questionText = questionClone.textContent.trim();
  } else {
    questionText = questionElement.textContent.trim();
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

function processChatGPTResponse(responseText) {
  try {

    const response = JSON.parse(responseText);
    const answer = response.answer;

    let applied = 0;
    if (
      document.querySelector(
        ".worksheet__main fieldset .worksheet--mc__choices"
      )
    ) {
      applied = handleWorksheetMcAnswer(answer);
    } else if (document.querySelector(".answers-wrap.ranking")) {
      applied = handleRankingAnswer(answer);
    } else if (document.querySelector('.answers-wrap input[type="checkbox"]')) {
      applied = handleMultipleResponseAnswer(answer);
    } else if (document.querySelector(".answers-wrap.multiple-choice")) {
      applied = handleMultipleChoiceAnswer(answer);
    } else if (document.querySelector(".answers-wrap.boolean")) {
      applied = handleTrueFalseAnswer(answer);
    } else if (document.querySelector(".answers-wrap.input-response")) {
      applied = handleFillInTheBlankAnswer(answer);
    }

    if (applied === 0) {
      console.warn(
        "[Auto-McGraw][ezto] AI answer did not match anything on the page:",
        answer
      );
      if (isAutomating) {
        alert(
          "The AI's answer did not match anything on this question.\n\nAI answer:\n" +
            JSON.stringify(answer) +
            "\n\nPlease answer this question manually, then click Next. Automation will resume on the next question."
        );
        pauseForManualAndResume();
      }
      return;
    }

    if (isAutomating) {
      setTimeout(() => {
        const nextButton = document.querySelector(
          ".footer__link--next:not([hidden])"
        );
        if (
          nextButton &&
          !nextButton.disabled &&
          !nextButton.classList.contains("is-disabled")
        ) {
          nextButton.click();
          setTimeout(() => {
            if (checkForQuizEnd()) {
              stopAutomation("Quiz completed - all questions answered");
              return;
            }
            checkForNextStep();
          }, 1500);
        } else {
          stopAutomation("Quiz completed - no next button available");
        }
      }, 2000);
    }
  } catch (e) {
    console.error("Error processing response:", e);
    stopAutomation("Error processing AI response: " + e.message);
  }
}

// Fuzzy equality between an on-screen option and an AI-returned answer.
function isOptionMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) {
    return false;
  }

  const choice = String(choiceText).trim().replace(/^[a-z]\s+/, "");
  const ans = String(answerText).trim().replace(/^[a-z]\s+/, "");
  if (!choice || !ans) return false;

  if (choice === ans) return true;
  if (choice.replace(/\.$/, "") === ans.replace(/\.$/, "")) return true;
  if (choice === ans + ".") return true;

  return false;
}

function handleMultipleChoiceAnswer(answer) {
  const answerText = Array.isArray(answer) ? answer[0] : answer;
  const pairs = getChoicePairs('.answers--mc input[type="radio"]');

  for (const pair of pairs) {
    if (isOptionMatch(pair.text, answerText)) {
      if (!pair.input.checked) {
        pair.input.click();
      }
      return 1;
    }
  }

  return 0;
}

// "Select all that apply": click every checkbox whose label matches any of
// the AI's answers. Never re-click an already-checked box (would toggle off).
function handleMultipleResponseAnswer(answer) {
  const answers = (Array.isArray(answer) ? answer : [answer]).map(String);
  const pairs = getChoicePairs('.answers-wrap input[type="checkbox"]');

  if (
    !answers.every((ans) =>
      pairs.some((pair) => isOptionMatch(pair.text, ans))
    )
  ) {
    return 0;
  }

  let clicked = 0;
  for (const pair of pairs) {
    const shouldBeSelected = answers.some((ans) =>
      isOptionMatch(pair.text, ans)
    );
    if (shouldBeSelected) {
      if (!pair.input.checked) {
        pair.input.click();
      }
      clicked++;
    }
  }

  return clicked;
}

// Ranking questions: each item row has a native <select> whose option values
// are the rank positions ("1".."N"). The AI returns every item text in the
// correct order; position = index + 1. All-or-nothing: a partially matched
// ranking is treated as unmatched so the user can fix it manually.
function handleRankingAnswer(answer) {
  let orderedItems;

  if (Array.isArray(answer)) {
    orderedItems = answer.map(String);
  } else if (answer && typeof answer === "object") {
    // Also accept {"Item text": position} maps.
    orderedItems = Object.entries(answer)
      .sort((a, b) => Number(a[1]) - Number(b[1]))
      .map(([itemText]) => itemText);
  } else {
    orderedItems = [String(answer)];
  }

  const rows = Array.from(
    document.querySelectorAll(".answers-wrap.ranking li.answer--matching-wrap")
  );
  if (!rows.length) return 0;

  const usedAnswerIndexes = new Set();
  let placed = 0;

  for (const row of rows) {
    const textEl = row.querySelector(".answer--matching__option");
    const select = row.querySelector("select.answer--matching__button");
    if (!textEl || !select) continue;

    const itemText = textEl.textContent.trim();
    const matchIndex = orderedItems.findIndex(
      (ans, idx) => !usedAnswerIndexes.has(idx) && isOptionMatch(itemText, ans)
    );
    if (matchIndex === -1) continue;

    usedAnswerIndexes.add(matchIndex);

    const position = String(matchIndex + 1);
    if (select.value !== position) {
      select.value = position;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    placed++;
  }

  return placed === rows.length ? placed : 0;
}

function handleTrueFalseAnswer(answer) {
  const buttons = document.querySelectorAll(".answer--boolean");

  for (const button of buttons) {
    const buttonSpan = button.querySelector(".answer__button--boolean");
    if (!buttonSpan) {
      continue;
    }

    const fullText = buttonSpan.textContent;

    const buttonText = fullText.trim().split(",")[0].trim();

    if (
      (buttonText === "True" && (answer === "True" || answer === true)) ||
      (buttonText === "False" && (answer === "False" || answer === false))
    ) {
      button.click();
      return 1;
    }
  }

  console.error("No matching button found for answer:", answer);
  return 0;
}

function handleFillInTheBlankAnswer(answer) {
  const inputField = document.querySelector(".answer--input__input");

  if (inputField) {
    let answerText = "";

    if (Array.isArray(answer)) {
      answerText = answer[0];
    } else {
      answerText = answer;
    }

    inputField.value = answerText;
    inputField.dispatchEvent(new Event("input", { bubbles: true }));
    inputField.dispatchEvent(new Event("change", { bubbles: true }));
    return 1;
  }

  console.error("Could not find input field for fill in the blank");
  return 0;
}

function addAssistantButton() {
  const helpLink = document.querySelector(".header__help");
  if (!helpLink) return;

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "header__automcgraw";
  buttonContainer.style.cssText = `
    display: inline-flex;
    margin-right: 20px;
    align-items: center;
  `;

  chrome.storage.sync.get("aiModel", function (data) {
    const aiModel = data.aiModel || "chatgpt";
    let modelName = "ChatGPT";

    if (aiModel === "gemini") {
      modelName = "Gemini";
    } else if (aiModel === "deepseek") {
      modelName = "DeepSeek";
    }

    const btn = document.createElement("button");
    btn.textContent = `Ask ${modelName}`;
    btn.type = "button";
    btn.className = "header__automcgraw--main";
    btn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 12px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      border-radius: 4px 0 0 4px;
      border-right: none;
      height: 32px;
      line-height: 1;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      transition: background-color 0.2s ease;
    `;

    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = "#f5f5f5";
    });

    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "#fff";
    });

    btn.addEventListener("click", () => {
      if (isAutomating) {
        stopAutomation("Manual stop");
      } else {
        const proceed = confirm(
          "Start quiz automation? The automation will stop automatically when the quiz ends.\n\nClick OK to begin, or Cancel to stop."
        );
        if (proceed) {
          isAutomating = true;
          btn.textContent = "Stop Automation";
          checkForNextStep();
        }
      }
    });

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "header__automcgraw--settings";
    settingsBtn.title = "Auto-McGraw Settings";
    settingsBtn.setAttribute("aria-label", "Auto-McGraw Settings");
    settingsBtn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 10px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 0 4px 4px 0;
      height: 32px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s ease;
    `;

    settingsBtn.addEventListener("mouseenter", () => {
      settingsBtn.style.backgroundColor = "#f5f5f5";
    });

    settingsBtn.addEventListener("mouseleave", () => {
      settingsBtn.style.backgroundColor = "#fff";
    });

    settingsBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    `;

    settingsBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openSettings" });
    });

    buttonContainer.appendChild(btn);
    buttonContainer.appendChild(settingsBtn);
    helpLink.parentNode.insertBefore(buttonContainer, helpLink);

    chrome.storage.onChanged.addListener((changes) => {
      if (changes.aiModel) {
        const newModel = changes.aiModel.newValue;
        let newModelName = "ChatGPT";

        if (newModel === "gemini") {
          newModelName = "Gemini";
        } else if (newModel === "deepseek") {
          newModelName = "DeepSeek";
        }

        if (!isAutomating) {
          btn.textContent = `Ask ${newModelName}`;
        }
      }
    });
  });
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Element not found: " + selector));
      }
    }, 100);
  });
}

setupMessageListener();
startPageObserver();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
