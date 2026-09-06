let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let doubleCreditMode = false;
let randomConfidence = false;
let pauseBeforeSubmit = false;
let waitingForDuplicateCompletion = false;
let currentResponse = null;
let matchingPauseIntervalId = null;
let activeQuestionRequestId = null;
let lastQueuedQuestionSignature = "";
let automationRunId = 0;
const LOG_PREFIX = "[Auto-McGraw][mhe]";

function recordDiagnostic(stage, details = {}, requestId = activeQuestionRequestId) {
  try {
    chrome.runtime.sendMessage(
      { type: "diagnosticEvent", stage: `mhe.${stage}`, requestId, details },
      () => { void chrome.runtime.lastError; }
    );
  } catch (_) {
    // Diagnostics must not interrupt answering if the extension was reloaded.
  }
}

function showAutomationStatus(message, urgent = false) {
  let status = document.getElementById("automcgraw-status");
  if (!status) {
    status = document.createElement("div");
    status.id = "automcgraw-status";
    status.style.cssText = "position:fixed;bottom:12px;left:12px;max-width:min(640px,90vw);max-height:35vh;overflow:auto;padding:10px 14px;background:#17212b;color:#fff;border:1px solid #768390;border-radius:6px;white-space:pre-wrap;font:14px/1.4 sans-serif;z-index:999999";
    document.body.appendChild(status);
  }
  status.setAttribute("role", urgent ? "alert" : "status");
  status.textContent = `Auto-McGraw: ${message}`;
}

chrome.storage.sync.get(["doubleCreditMode", "randomConfidence", "pauseBeforeSubmit"], function (data) {
  doubleCreditMode = data.doubleCreditMode || false;
  randomConfidence = data.randomConfidence || false;
  pauseBeforeSubmit = data.pauseBeforeSubmit || false;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.doubleCreditMode) {
    doubleCreditMode = changes.doubleCreditMode.newValue;
  }
  if (changes.randomConfidence) {
    randomConfidence = changes.randomConfidence.newValue;
  }
  if (changes.pauseBeforeSubmit) {
    pauseBeforeSubmit = changes.pauseBeforeSubmit.newValue;
  }
});

function getConfidenceSelector() {
  if (!randomConfidence) {
    return '[data-automation-id="confidence-buttons--high_confidence"]:not([disabled])';
  }
  const levels = [
    "high_confidence",
    "medium_confidence",
    "low_confidence",
  ];
  const pick = levels[Math.floor(Math.random() * levels.length)];
  return `[data-automation-id="confidence-buttons--${pick}"]:not([disabled])`;
}

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      const container = document.querySelector(".probe-container");
      sendResponse({ received: true, ready: !!container });
      return true;
    }

    if (message.type === "processChatGPTResponse") {
      if (
        !message.isDuplicateTab &&
        (!isAutomating ||
          !message.requestId ||
          message.requestId !== activeQuestionRequestId)
      ) {
        sendResponse({ received: false, stale: true });
        return true;
      }
      if (
        !message.isDuplicateTab &&
        !document.querySelector(".probe-container")
      ) {
        sendResponse({ received: false, error: "Question container not ready" });
        return true;
      }

      let processing;
      try {
        if (
          doubleCreditMode &&
          !message.isDuplicateTab &&
          !waitingForDuplicateCompletion
        ) {
          currentResponse = message.response;
          processing = processDoubleCreditResponse(message.response);
        } else {
          processing = processChatGPTResponse(message.response);
        }
      } catch (error) {
        if (!error.retryable) handleProcessResponseError(error);
        sendResponse({ received: false, error: error.message });
        return true;
      }

      Promise.resolve(processing)
        .then(() => {
          const completedCurrentRequest =
            message.requestId === activeQuestionRequestId;
          if (message.requestId === activeQuestionRequestId) {
            activeQuestionRequestId = null;
          }
          sendResponse({ received: true });
          if (completedCurrentRequest && isAutomating) {
            setTimeout(checkForNextStep, 0);
          }
        })
        .catch((error) => {
          if (!error.retryable && !error.stale) handleProcessResponseError(error);
          sendResponse({
            received: false,
            stale: !!error.stale,
            error: error.message,
          });
        });
      return true;
    }

    if (message.type === "processDuplicateTab") {
      processDuplicateTabAnswering(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "completeDoubleCredit") {
      completeDoubleCreditFlow();
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      showAutomationStatus(message.message, true);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      recordDiagnostic("run.stopped.background", { status: "stopped" });
      isAutomating = false;
      automationRunId++;
      activeQuestionRequestId = null;
      lastQueuedQuestionSignature = "";
      clearMatchingPauseWatcher();
      updateButtonState();
      if (document.getElementById("automcgraw-status")?.getAttribute("role") !== "alert") {
        showAutomationStatus("Automation stopped. Click Ask to try again.", true);
      }
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function updateButtonState() {
  chrome.storage.sync.get(["aiModel", "doubleCreditMode"], function (data) {
    const currentModel = data.aiModel || "chatgpt";
    const doubleMode = data.doubleCreditMode || false;
    let currentModelName = "ChatGPT";

    if (currentModel === "gemini") {
      currentModelName = "Gemini";
    } else if (currentModel === "deepseek") {
      currentModelName = "DeepSeek";
    }

    const btn = document.querySelector(".automcgraw-btn");
    if (btn) {
      btn.textContent = `Ask ${currentModelName}${doubleMode ? " (2x)" : ""}`;
    }
  });
}

function handleProcessResponseError(error) {
  console.error("Error processing response:", error);
  recordDiagnostic("run.stopped.error", { status: "failed", errorName: error.name });
  isAutomating = false;
  automationRunId++;
  activeQuestionRequestId = null;
  lastQueuedQuestionSignature = "";
  waitingForDuplicateCompletion = false;
  clearMatchingPauseWatcher();
  updateButtonState();
  showAutomationStatus("Automation stopped: " + error.message + " Click Ask to try again.", true);
}

function processDoubleCreditResponse(responseText) {
  try {
    if (handleTopicOverview()) return;
    if (handleForcedLearning()) return;

    const response = JSON.parse(responseText);
    const answers = Array.isArray(response.answer)
      ? response.answer
      : [response.answer];

    const container = document.querySelector(".probe-container");
    if (!container) return;

    if (
      container.querySelector(
        ".awd-probe-type-matching, .awd-probe-type-sortable"
      )
    ) {
      showAutomationStatus(
        "Matching and ordering questions are not supported in double credit mode. Please complete manually.", true
      );
      isAutomating = false;
      updateButtonState();
      return;
    }

    fillInAnswers(answers, container);

    waitingForDuplicateCompletion = true;
    chrome.runtime.sendMessage({ type: "createDuplicateTab" });
  } catch (e) {
    console.error("Error processing double credit response:", e);
    isAutomating = false;
    updateButtonState();
  }
}

function setTextInputValue(input, value) {
  const text = String(value);
  const nativeSetter =
    typeof HTMLInputElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
          ?.set
      : null;

  if (nativeSetter) nativeSetter.call(input, text);
  else input.value = text;
  return input.value === text;
}

function processDuplicateTabAnswering(responseText) {
  try {

    const response = JSON.parse(responseText);
    const answers = Array.isArray(response.answer)
      ? response.answer
      : [response.answer];


    waitForElement(".probe-container", 5000)
      .then((container) => {

        setTimeout(() => {
          fillInAnswers(answers, container);

          waitForElement(
            getConfidenceSelector(),
            3000
          )
            .then((button) => {
              button.click();

              setTimeout(() => {
                chrome.runtime.sendMessage({ type: "finishDoubleCredit" });

                setTimeout(() => {
                  chrome.runtime.sendMessage({ type: "closeDuplicateTab" });
                }, 300);
              }, 800);
            })
            .catch((error) => {
              console.error(
                "Could not find high confidence button in duplicate tab:",
                error
              );
            });
        }, 500);
      })
      .catch((error) => {
        console.error(
          "Could not find probe container in duplicate tab:",
          error
        );
      });
  } catch (e) {
    console.error("Error processing duplicate tab:", e);
  }
}

function completeDoubleCreditFlow() {
  waitingForDuplicateCompletion = false;

  const container = document.querySelector(".probe-container");
  if (!container) return;

  waitForElement(
    getConfidenceSelector(),
    3000
  ).then((button) => {
    button.click();

    setTimeout(() => {
      checkForCorrectAnswer(container);

      waitForElement(".next-button", 5000)
        .then((nextButton) => {
          nextButton.click();

          chrome.runtime.sendMessage({ type: "resetTabTracking" });

          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 800);
          }
        })
        .catch((error) => {
          console.error("Automation error:", error);
          isAutomating = false;
          updateButtonState();
        });
    }, 800);
  });
}

function fillInAnswers(answers, container) {
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    const inputs = Array.from(container.querySelectorAll("input.fitb-input"));
    if (answers.length !== inputs.length) return 0;
    let filledCount = 0;

    inputs.forEach((input, index) => {
      if (setTextInputValue(input, answers[index])) filledCount++;
    });
    if (filledCount !== inputs.length) return 0;

    inputs.forEach((input) => {
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    inputs[inputs.length - 1]?.blur?.();
    return filledCount;
  }

  const choices = Array.from(
    container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  );

  if (
    !answers.every((answer) =>
      choices.some((choice) => isAnswerMatch(getChoiceText(choice), answer))
    )
  ) {
    return -1;
  }

  let filledCount = 0;
  choices.forEach((choice) => {
    const shouldBeSelected = answers.some((answer) =>
      isAnswerMatch(getChoiceText(choice), answer)
    );
    if (choice.type === "checkbox" && choice.checked !== shouldBeSelected) {
      choice.click();
    } else if (shouldBeSelected && !choice.checked) {
      choice.click();
    }
    if (shouldBeSelected && choice.checked) filledCount++;
  });

  const exactStateApplied = choices.every((choice) => {
    const shouldBeSelected = answers.some((answer) =>
      isAnswerMatch(getChoiceText(choice), answer)
    );
    return choice.checked === shouldBeSelected;
  });

  return exactStateApplied && filledCount === answers.length ? filledCount : 0;
}

function checkForCorrectAnswer(container) {
  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (incorrectMarker) {
    const correctionData = extractCorrectAnswer();
    if (correctionData && correctionData.answer) {
      lastIncorrectQuestion = correctionData.question;
      lastCorrectAnswer = cleanAnswer(correctionData.answer);
      console.log(
        "Found incorrect answer. Correct answer is:",
        lastCorrectAnswer
      );
    }
  }
}

function handleTopicOverview() {
  const continueButton = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );

  if (
    continueButton &&
    continueButton.textContent.trim().toLowerCase().includes("continue")
  ) {
    continueButton.click();

    setTimeout(() => {
      if (isAutomating) {
        checkForNextStep();
      }
    }, 1000);

    return true;
  }
  return false;
}

function isElementVisible(element) {
  if (
    !element ||
    element.hidden ||
    element.disabled ||
    element.getAttribute?.("aria-hidden") === "true" ||
    element.getAttribute?.("aria-disabled") === "true"
  ) {
    return false;
  }
  return typeof element.getClientRects === "function"
    ? element.getClientRects().length > 0
    : true;
}

function handleSessionPrompt() {
  const timeoutText =
    /still there|still working|continue your session|session.*expir|due to inactivity/i;
  const affirmative = new Set([
    "yes",
    "continue",
    "keep working",
    "stay signed in",
    "stay logged in",
    "i'm still here",
  ]);
  const dialogs = Array.from(
    document.querySelectorAll('[role="dialog"], .modal-dialog, .modal')
  ).filter(isElementVisible);

  for (const dialog of dialogs) {
    if (!timeoutText.test(getElementText(dialog))) continue;
    const button = Array.from(
      dialog.querySelectorAll('button, [role="button"], input[type="button"]')
    ).find((candidate) => {
      const text = normalizeChoiceText(
        candidate.value || getElementText(candidate)
      ).toLowerCase();
      return isElementVisible(candidate) && affirmative.has(text);
    });
    if (button) {
      button.click();
      return true;
    }
  }
  return false;
}

function isAssignmentComplete() {
  if (document.querySelector(".probe-container")) return false;
  const pageText = (document.body?.innerText || document.body?.textContent || "")
    .toLowerCase();
  return ["accuracy", "confidence", "challenging concepts"].every((text) =>
    pageText.includes(text)
  );
}

function finishAutomationIfComplete() {
  if (!isAssignmentComplete()) return false;
  recordDiagnostic("run.completed");
  isAutomating = false;
  automationRunId++;
  activeQuestionRequestId = null;
  lastQueuedQuestionSignature = "";
  clearMatchingPauseWatcher();
  updateButtonState();
  showAutomationStatus("Assignment complete.");
  console.log(LOG_PREFIX, "Assignment completion screen detected.");
  return true;
}

function clearMatchingPauseWatcher() {
  if (matchingPauseIntervalId !== null) {
    clearInterval(matchingPauseIntervalId);
    matchingPauseIntervalId = null;
  }
}

function getQuestionSignature(container) {
  if (!container) return "";
  const question = parseQuestion(container);
  if (!question) return "";
  // Dragging an answer changes DOM order, not the identity of the question.
  let options = question.options;
  if (question.type === "ranking") options = [...options].sort();
  if (question.type === "matching") {
    options = { ...options, choices: [...options.choices].sort() };
  }
  return JSON.stringify([
    question.type,
    normalizeChoiceText(question.question),
    options,
    ...(question.images?.length ? [question.images.map((image) => image.src)] : []),
  ]);
}

function pauseForManualMatchingAndResume(questionSignature) {
  if (!questionSignature) return;

  clearMatchingPauseWatcher();

  // After manual fallback, resume only when the user advances to a different question.
  matchingPauseIntervalId = setInterval(() => {
    if (!isAutomating) {
      clearMatchingPauseWatcher();
      return;
    }

    const currentContainer = document.querySelector(".probe-container");
    if (!currentContainer) return;

    const currentSignature = getQuestionSignature(currentContainer);
    if (currentSignature && currentSignature !== questionSignature) {
      clearMatchingPauseWatcher();

      setTimeout(() => {
        if (isAutomating) {
          checkForNextStep();
        }
      }, 500);
    }
  }, 400);
}

// The AI answered, but none of its answers matched an on-screen option (most
// common on multiple_select). Instead of waiting for a confidence button that
// will never enable and killing automation, hand the question to the user and
// resume automatically once they advance.
function pauseForManualAnswer(container, answers) {
  const questionSignature = getQuestionSignature(container);
  console.warn(
    LOG_PREFIX,
    "No on-screen option matched the AI answer:",
    answers
  );

  recordDiagnostic(answers?.length ? "answer.mismatch" : "answer.empty", {
    questionType: detectQuestionType(container), answerCount: answers?.length || 0,
  });
  showAutomationStatus(
    (answers?.length ? "The AI's answer did not match any option on this question." :
      "The AI did not provide an answer to this question.") + "\n\nAI answer:\n" +
      (answers && answers.length ? answers.join("\n") : "(no answer)") +
      "\n\nPlease answer this question manually, then click confidence and next. Automation will resume after you move to the next question.", true
  );

  if (isAutomating) {
    pauseForManualMatchingAndResume(questionSignature);
  }
}

function handleForcedLearning() {
  const forcedLearningAlert = document.querySelector(
    ".forced-learning .alert-error"
  );
  if (forcedLearningAlert) {
    const readButton = document.querySelector(
      '[data-automation-id="lr-tray_reading-button"]'
    );
    if (readButton) {
      readButton.click();

      waitForElement('[data-automation-id="reading-questions-button"]', 10000)
        .then((toQuestionsButton) => {
          toQuestionsButton.click();
          return waitForElement(".next-button", 10000);
        })
        .then((nextButton) => {
          nextButton.click();
          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 1000);
          }
        })
        .catch((error) => {
          console.error("Error in forced learning flow:", error);
          isAutomating = false;
          clearMatchingPauseWatcher();
          updateButtonState();
        });
      return true;
    }
  }
  return false;
}

function checkForNextStep() {
  if (!isAutomating || activeQuestionRequestId) return;

  if (finishAutomationIfComplete()) return;

  if (handleTopicOverview()) {
    return;
  }

  if (handleForcedLearning()) {
    return;
  }

  const container = document.querySelector(".probe-container");
  if (container && !container.querySelector(".forced-learning") && !isQuestionGraded(container)) {
    const questionSignature = getQuestionSignature(container);
    if (questionSignature && questionSignature !== lastQueuedQuestionSignature) {
      const qData = parseQuestion(container);
      lastQueuedQuestionSignature = questionSignature;
      activeQuestionRequestId = crypto.randomUUID();
      const requestId = activeQuestionRequestId;
      recordDiagnostic("request.queued", { questionType: qData.type });
      showAutomationStatus("Waiting for the AI answer...");
      try {
        chrome.runtime.sendMessage({
          type: "sendQuestionToChatGPT", requestId, question: qData,
        }, (reply) => {
          const error = chrome.runtime.lastError;
          if (requestId !== activeQuestionRequestId) return;
          if (error || !reply?.received) {
            recordDiagnostic("request.failed", { status: reply?.status || "failed" });
            handleProcessResponseError(new Error("The question could not be sent to the AI."));
          }
        });
      } catch (error) {
        if (requestId === activeQuestionRequestId) handleProcessResponseError(error);
      }
    }
  }
}

function detectQuestionType(container) {
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    return "multiple_choice";
  }
  if (container.querySelector(".awd-probe-type-true_false")) {
    return "true_false";
  }
  if (container.querySelector(".awd-probe-type-multiple_select")) {
    return "multiple_select";
  }
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    return "fill_in_the_blank";
  }
  if (container.querySelector(".awd-probe-type-select_text")) {
    return "select_text";
  }
  if (container.querySelector(".awd-probe-type-matching")) {
    return "matching";
  }
  if (container.querySelector(".awd-probe-type-sortable")) {
    return "ranking";
  }
  return "";
}

function getElementText(element) {
  if (!element) return "";

  function readMathNode(node) {
    if (node.nodeType === 3) return node.textContent || "";

    const tagName = node.nodeName?.toLowerCase();
    const children = Array.from(node.childNodes || []);
    const parts = children.map(readMathNode);

    if (tagName === "annotation" || tagName === "annotation-xml") return "";
    if (tagName === "semantics") return parts.find(Boolean) || "";
    if (tagName === "mfrac") return `${parts[0] || ""}/${parts[1] || ""}`;
    if (tagName === "msup") return `${parts[0] || ""}^${parts[1] || ""}`;
    if (tagName === "msub") return `${parts[0] || ""}_${parts[1] || ""}`;
    if (tagName === "msubsup") {
      return `${parts[0] || ""}_${parts[1] || ""}^${parts[2] || ""}`;
    }
    if (tagName === "msqrt") return `sqrt(${parts.join("")})`;
    if (tagName === "mroot") {
      return `root(${parts[0] || ""},${parts[1] || ""})`;
    }

    return parts.join("");
  }

  function hasClass(node, className) {
    return node.classList?.contains?.(className) || false;
  }

  function readNode(node) {
    if (node.nodeType === 3) return node.textContent || "";

    const tagName = node.nodeName?.toLowerCase();
    if (tagName === "script" || tagName === "style") return "";
    if (hasClass(node, "MathJax_Preview")) return "";
    if (hasClass(node, "correctness") || hasClass(node, "awd-probe-correctness") ||
        hasClass(node, "_visuallyHidden")) return "";

    if (hasClass(node, "MathJax")) {
      const mathNode = node.querySelector?.(".MJX_Assistive_MathML math, math");
      if (mathNode) return readMathNode(mathNode);
    }

    if (hasClass(node, "MJX_Assistive_MathML")) return "";
    if (tagName === "math") return readMathNode(node);

    const text = Array.from(node.childNodes || [], readNode).join("");
    if (tagName === "sup") return `^${text}`;
    if (tagName === "sub") return `_${text}`;
    return text;
  }

  return readNode(element).trim();
}

function normalizeChoiceText(text) {
  if (typeof text !== "string") return "";

  return text
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\^(?:o|0)\b/gi, "°")
    .replace(/[º˚]/g, "°")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function getChoiceText(choice) {
  const labelledText = (choice?.getAttribute?.("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => {
      const label = document.getElementById(id);
      return getElementText(label?.querySelector?.(".choiceText") || label);
    })
    .filter(Boolean)
    .join(" ");
  if (labelledText) return labelledText;

  const ariaLabel = choice?.getAttribute?.("aria-label");
  if (ariaLabel) return ariaLabel;

  const nativeLabel = choice?.labels?.[0];
  return getElementText(
    nativeLabel?.querySelector?.(".choiceText") ||
      nativeLabel ||
      choice?.closest?.(".choice-row")?.querySelector(".choiceText") ||
      choice?.closest?.("label")?.querySelector(".choiceText")
  );
}

function stripWrappingQuotes(text) {
  if (typeof text !== "string") return "";

  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;

  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];
  if (firstChar !== lastChar || !/["'`]/.test(firstChar)) {
    return trimmed;
  }

  return trimmed.slice(1, -1).trim();
}

function isAnswerMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) {
    return false;
  }

  const choice = String(choiceText).trim();
  const answer = String(answerText).trim();
  if (!choice || !answer) return false;

  if (choice === answer) return true;

  const choiceWithoutPeriod = choice.replace(/\.$/, "");
  const answerWithoutPeriod = answer.replace(/\.$/, "");
  if (choiceWithoutPeriod === answerWithoutPeriod) return true;

  if (choice === answer + ".") return true;

  const normalizedChoice = normalizeChoiceText(choice);
  const normalizedAnswer = normalizeChoiceText(answer);
  if (normalizedChoice === normalizedAnswer) return true;

  return (
    normalizeChoiceText(stripWrappingQuotes(choice)) ===
    normalizeChoiceText(stripWrappingQuotes(answer))
  );
}

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;

  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (!incorrectMarker) return null;

  const questionType = detectQuestionType(container);

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const spans = promptClone.querySelectorAll(
      "span.response-container, span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    spans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      input.parentNode.replaceChild(blankMarker, input);
    });

    questionText = getElementText(promptClone);
  } else {
    questionText = getElementText(promptEl);
  }

  let correctAnswer = null;

  if (questionType === "multiple_choice" || questionType === "true_false") {
    try {
      const answerContainer = container.querySelector(
        ".answer-container .choiceText"
      );
      if (answerContainer) {
        correctAnswer = getElementText(answerContainer);
      } else {
        const correctAnswerContainer = container.querySelector(
          ".correct-answer-container"
        );
        if (correctAnswerContainer) {
          const answerText =
            correctAnswerContainer.querySelector(".choiceText");
          if (answerText) {
            correctAnswer = getElementText(answerText);
          } else {
            const answerDiv = correctAnswerContainer.querySelector(".choice");
            if (answerDiv) {
              correctAnswer = getElementText(answerDiv);
            }
          }
        }
      }
    } catch (e) {
      console.error("Error extracting multiple choice answer:", e);
    }
  } else if (questionType === "multiple_select") {
    try {
      const correctAnswersList = container.querySelectorAll(
        ".correct-answer-container .choice"
      );
      if (correctAnswersList && correctAnswersList.length > 0) {
        correctAnswer = Array.from(correctAnswersList).map((el) => {
          const choiceText = el.querySelector(".choiceText");
          return choiceText
            ? getElementText(choiceText)
            : getElementText(el);
        });
      }
    } catch (e) {
      console.error("Error extracting multiple select answers:", e);
    }
  } else if (questionType === "fill_in_the_blank") {
    try {
      const correctAnswersList = container.querySelectorAll(".correct-answers");

      if (correctAnswersList && correctAnswersList.length > 0) {
        if (correctAnswersList.length === 1) {
          const correctAnswerEl =
            correctAnswersList[0].querySelector(".correct-answer");
          if (correctAnswerEl) {
            correctAnswer = getElementText(correctAnswerEl);
          } else {
            const answerText = getElementText(correctAnswersList[0]);
            if (answerText) {
              const match = answerText.match(/:\s*(.+)$/);
              correctAnswer = match ? match[1].trim() : answerText;
            }
          }
        } else {
          correctAnswer = Array.from(correctAnswersList).map((field) => {
            const correctAnswerEl = field.querySelector(".correct-answer");
            if (correctAnswerEl) {
              return getElementText(correctAnswerEl);
            } else {
              const answerText = getElementText(field);
              const match = answerText.match(/:\s*(.+)$/);
              return match ? match[1].trim() : answerText;
            }
          });
        }
      }
    } catch (e) {
      console.error("Error extracting fill in the blank answers:", e);
    }
  } else if (questionType === "select_text") {
    try {
      const correctAnswersList = Array.from(
        container.querySelectorAll(
          ".correct-answer-container .choice.-interactive, .correct-answer-container .choiceText, .correct-answer-container .choice"
        )
      )
        .map((el) => getElementText(el))
        .filter(Boolean);

      if (correctAnswersList.length === 1) {
        correctAnswer = correctAnswersList[0];
      } else if (correctAnswersList.length > 1) {
        correctAnswer = correctAnswersList;
      }
    } catch (e) {
      console.error("Error extracting select text answers:", e);
    }
  }

  if (questionType === "matching") {
    return null;
  }

  if (correctAnswer === null) {
    console.error("Failed to extract correct answer for", questionType);
    return null;
  }

  return {
    question: questionText,
    answer: correctAnswer,
    type: questionType,
  };
}

function cleanAnswer(answer) {
  if (!answer) return answer;

  if (Array.isArray(answer)) {
    return answer.map((item) => cleanAnswer(item));
  }

  if (typeof answer === "string") {
    let cleanedAnswer = answer.trim();

    cleanedAnswer = cleanedAnswer.replace(/^Field \d+:\s*/, "");

    if (cleanedAnswer.includes(" or ")) {
      cleanedAnswer = cleanedAnswer.split(" or ")[0].trim();
    }

    return cleanedAnswer;
  }

  return answer;
}

function tryParseAnswerArrayString(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function flattenAnswerValues(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenAnswerValues(item, output));
    return output;
  }

  if (typeof value === "string") {
    const parsedArray = tryParseAnswerArrayString(value);
    if (parsedArray) {
      flattenAnswerValues(parsedArray, output);
      return output;
    }

    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return output;
  }

  output.push(String(value));
  return output;
}

function splitCompoundAnswer(answerText) {
  if (typeof answerText !== "string") return [];

  const trimmed = answerText.trim();
  if (!trimmed) return [];

  let parts = trimmed
    .split(/\n|;/)
    .map((part) =>
      part
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^\d+[\).\-\s]+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    )
    .filter(Boolean);

  if (parts.length <= 1 && /\band\b/i.test(trimmed)) {
    parts = trimmed
      .split(/\band\b/i)
      .map((part) =>
        part
          .trim()
          .replace(/^[-*•]\s*/, "")
          .replace(/^\d+[\).\-\s]+/, "")
          .replace(/^["'`]|["'`]$/g, "")
          .trim()
      )
      .filter(Boolean);
  }

  return parts;
}

function dedupeAnswers(answers) {
  const seen = new Set();
  const deduped = [];

  answers.forEach((answer) => {
    const normalized = normalizeChoiceText(answer).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    deduped.push(answer);
  });

  return deduped;
}

function getQuestionChoices(container, questionType) {
  if (questionType === "select_text") {
    return Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => getElementText(el))
      .filter(Boolean);
  }

  const inputs = Array.from(
    container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  );
  const choices = inputs.length
    ? inputs.map((input) => getChoiceText(input))
    : Array.from(container.querySelectorAll(".choiceText")).map((el) =>
        getElementText(el)
      );

  return choices
    .filter(Boolean);
}

function createKeyboardEvent(type, key, code, keyCode) {
  const event = new KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    keyCode,
    which: keyCode,
    charCode: keyCode,
  });

  try {
    Object.defineProperty(event, "keyCode", {
      get: () => keyCode,
    });
    Object.defineProperty(event, "which", {
      get: () => keyCode,
    });
  } catch (e) {
    // Ignore readonly property overrides in environments that block it.
  }

  return event;
}

function dispatchKeyboardSequence(target, key, code, keyCode) {
  if (!target) return;

  const keyDown = createKeyboardEvent("keydown", key, code, keyCode);
  const keyUp = createKeyboardEvent("keyup", key, code, keyCode);
  target.dispatchEvent(keyDown);
  target.dispatchEvent(keyUp);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMatchingComponent(container) {
  if (!container) return null;
  return container.querySelector(".matching-component");
}

// SmartBook rewrites a dropped choice from choices:* to response:* once it lands in a row.
const MATCHING_ALL_CHOICE_SELECTOR =
  '.choice-item-wrapper:not(.-placeholder)[id^="choices:"], .choice-item-wrapper:not(.-placeholder)[id^="response:"]';
const MATCHING_POOL_CHOICE_SELECTOR =
  '.choices-container .choice-item-wrapper:not(.-placeholder)[id^="choices:"]';
const MATCHING_RESPONSE_CHOICE_SELECTOR =
  '.choice-item-wrapper:not(.-placeholder)[id^="choices:"], .choice-item-wrapper:not(.-placeholder)[id^="response:"]';

function getMatchingRows(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(
    matchingComponent.querySelectorAll(".responses-container .match-row")
  );
}

function getMatchingResponseSlots(container) {
  return getMatchingRows(container).flatMap((row, rowIndex) => {
    const promptText = getMatchingPromptText(row);
    const responseWrapper = row.querySelector(
      ".match-single-response-wrapper, .match-multiple-response-wrapper"
    );
    if (!responseWrapper) return [];

    const holders = Array.from(responseWrapper.querySelectorAll(".dropHolder"));
    const slotHolders = holders.length ? holders : [responseWrapper];
    return slotHolders.map((holder, slotIndex) => ({
      rowIndex,
      slotIndex,
      promptText,
      holder,
      item: holder.querySelector(MATCHING_RESPONSE_CHOICE_SELECTOR),
    }));
  });
}

function getMatchingPromptText(matchRow) {
  if (!matchRow) return "";
  const promptContent =
    matchRow.querySelector(".match-prompt .content") ||
    matchRow.querySelector(".match-prompt");
  const rawText = getElementText(promptContent);
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceText(choiceItem) {
  if (!choiceItem) return "";

  const contentEl =
    choiceItem.querySelector(".content") || choiceItem.querySelector("p");
  const rawText = getElementText(contentEl || choiceItem);
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(matchingComponent.querySelectorAll(MATCHING_ALL_CHOICE_SELECTOR));
}

function getMatchingDragHandle(choiceItem) {
  if (!choiceItem) return null;

  if (choiceItem.matches?.("[data-react-beautiful-dnd-drag-handle]")) {
    return choiceItem;
  }

  return (
    choiceItem.querySelector("[data-react-beautiful-dnd-drag-handle]") ||
    choiceItem
  );
}

async function dragChoiceWithMouse(handle, getDestinationBox) {
  if (!handle || typeof getDestinationBox !== "function") return false;

  const sourceRect = handle.getBoundingClientRect?.();
  if (!sourceRect) return false;

  const source = {
    x: sourceRect.left + sourceRect.width / 2,
    y: sourceRect.top + sourceRect.height / 2,
  };
  const liftPoint = {
    x: source.x <= innerWidth - 7 ? source.x + 6 : source.x - 6,
    y: source.y,
  };
  const dragWindow = handle.ownerDocument?.defaultView || window;
  const sendMouse = (eventTarget, type, point, buttons) =>
    eventTarget.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: dragWindow,
        button: 0,
        buttons,
        clientX: Math.round(point.x),
        clientY: Math.round(point.y),
      })
    );

  sendMouse(handle, "mousedown", source, 1);
  sendMouse(dragWindow, "mousemove", liftPoint, 1);

  const sourceId = handle.id;
  const liftDeadline = Date.now() + 2000;
  while (Date.now() < liftDeadline) {
    const liveSource = sourceId ? document.getElementById(sourceId) : handle;
    if (
      liveSource?.classList?.contains("-dragging") &&
      liveSource.getAttribute?.("aria-pressed") === "true"
    ) {
      break;
    }
    await delay(25);
  }

  const liveSource = sourceId ? document.getElementById(sourceId) : handle;
  if (
    !liveSource?.classList?.contains("-dragging") ||
    liveSource.getAttribute?.("aria-pressed") !== "true"
  ) {
    dispatchKeyboardSequence(dragWindow, "Escape", "Escape", 27);
    return false;
  }

  await delay(200);
  const destinationRect = getDestinationBox()?.getBoundingClientRect?.();
  if (!destinationRect) {
    dispatchKeyboardSequence(dragWindow, "Escape", "Escape", 27);
    return false;
  }

  const target = {
    x: destinationRect.left + destinationRect.width / 2,
    y: destinationRect.top + destinationRect.height / 2,
  };
  sendMouse(dragWindow, "mousemove", target, 1);
  await delay(500);
  sendMouse(dragWindow, "mouseup", target, 0);
  return true;
}

function getSortableChoiceItems(container) {
  return Array.from(
    container.querySelectorAll(
      ".sortable-component .vertical-list .choice-item[data-react-beautiful-dnd-draggable]"
    )
  );
}

async function applyRankingAnswer(container, rawAnswers) {
  const answers = flattenAnswerValues(rawAnswers);
  const initialTexts = getSortableChoiceItems(container).map((item) =>
    getMatchingChoiceText(item)
  );
  if (answers.length !== initialTexts.length) return false;

  const usedItemIndexes = new Set();
  const targetOrder = answers.map((answer) => {
    const matchIndex = initialTexts.findIndex(
      (itemText, index) =>
        !usedItemIndexes.has(index) && isAnswerMatch(itemText, answer)
    );
    if (matchIndex === -1) return "";
    usedItemIndexes.add(matchIndex);
    return initialTexts[matchIndex];
  });
  if (targetOrder.some((answer) => !answer)) return false;

  for (let targetIndex = 0; targetIndex < targetOrder.length; targetIndex += 1) {
    const items = getSortableChoiceItems(container);
    const currentIndex = items.findIndex((item) =>
      isAnswerMatch(getMatchingChoiceText(item), targetOrder[targetIndex])
    );
    if (currentIndex === -1) return false;
    if (currentIndex === targetIndex) continue;
    if (currentIndex < targetIndex) return false;

    const handle = getMatchingDragHandle(items[currentIndex]);
    if (!handle) return false;
    if (
      !(await dragChoiceWithMouse(
        handle,
        () => getSortableChoiceItems(container)[targetIndex]
      ))
    ) {
      return false;
    }

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const movedItem = getSortableChoiceItems(container)[targetIndex];
      if (
        isAnswerMatch(
          getMatchingChoiceText(movedItem),
          targetOrder[targetIndex]
        )
      ) {
        break;
      }
      await delay(50);
    }

    const movedItem = getSortableChoiceItems(container)[targetIndex];
    if (
      !isAnswerMatch(
        getMatchingChoiceText(movedItem),
        targetOrder[targetIndex]
      )
    ) return false;
  }

  const finalTexts = getSortableChoiceItems(container).map((item) =>
    getMatchingChoiceText(item)
  );
  return targetOrder.every((answer, index) =>
    isAnswerMatch(finalTexts[index], answer)
  );
}

function getMatchingPoolChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(matchingComponent.querySelectorAll(MATCHING_POOL_CHOICE_SELECTOR));
}

function getMatchingChoiceLocation(container, choiceText) {
  if (!container || !choiceText) {
    return null;
  }

  const slots = getMatchingResponseSlots(container);
  for (let targetIndex = 0; targetIndex < slots.length; targetIndex += 1) {
    const slot = slots[targetIndex];
    if (!slot.item) continue;

    const slotChoiceText = getMatchingChoiceText(slot.item);
    if (isAnswerMatch(slotChoiceText, choiceText)) {
      return {
        area: "response",
        targetIndex,
        rowIndex: slot.rowIndex,
        slotIndex: slot.slotIndex,
        poolIndex: -1,
        item: slot.item,
      };
    }
  }

  const poolItems = getMatchingPoolChoiceItems(container);
  for (let poolIndex = 0; poolIndex < poolItems.length; poolIndex += 1) {
    const poolChoiceText = getMatchingChoiceText(poolItems[poolIndex]);
    if (isAnswerMatch(poolChoiceText, choiceText)) {
      return {
        area: "pool",
        targetIndex: -1,
        rowIndex: -1,
        slotIndex: -1,
        poolIndex,
        item: poolItems[poolIndex],
      };
    }
  }

  return null;
}

function parseMatchingAnswerReference(referenceText, candidateTexts, label = "") {
  if (!candidateTexts || candidateTexts.length === 0) return "";

  const normalizedReference = normalizeChoiceText(String(referenceText || ""));
  if (!normalizedReference) return "";

  const fullMatch = candidateTexts.find((candidate) => isAnswerMatch(candidate, normalizedReference));
  if (fullMatch) return fullMatch;

  // Support common AI shorthand like "#2", "choice 3", or "row 1".
  const parseNumericReference = (value) => {
    const match = value.match(/^#?(\d+)$/);
    if (!match) return "";

    const index = Number(match[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidateTexts.length) {
      return candidateTexts[index];
    }

    return "";
  };

  let resolved = parseNumericReference(normalizedReference);
  if (resolved) return resolved;

  const promptPrefixes = /^(?:prompt|row|left)\s*#?\s*/i;
  const choicePrefixes = /^(?:choice|option|item|right|match)\s*#?\s*/i;
  const prefixRegex = label === "prompt" ? promptPrefixes : choicePrefixes;
  const strippedReference = normalizedReference.replace(prefixRegex, "").trim();

  resolved = parseNumericReference(strippedReference);
  if (resolved) return resolved;

  const referenceVariants = dedupeAnswers([
    strippedReference,
    stripWrappingQuotes(strippedReference),
  ]).filter(Boolean);

  for (const variant of referenceVariants) {
    const exactMatch = candidateTexts.find((candidate) =>
      isAnswerMatch(candidate, variant)
    );
    if (exactMatch) return exactMatch;
  }

  for (const variant of referenceVariants) {
    const normalizedTarget = normalizeChoiceText(variant).toLowerCase();
    if (!normalizedTarget) continue;

    const normalizedCandidateMatch = candidateTexts.find((candidate) => {
      return normalizeChoiceText(candidate).toLowerCase() === normalizedTarget;
    });
    if (normalizedCandidateMatch) return normalizedCandidateMatch;

    const partialMatches = candidateTexts.filter((candidate) => {
      const normalizedCandidate = normalizeChoiceText(candidate).toLowerCase();
      return (
        normalizedCandidate &&
        (normalizedCandidate.includes(normalizedTarget) ||
          normalizedTarget.includes(normalizedCandidate))
      );
    });
    if (partialMatches.length === 1) return partialMatches[0];
  }

  return "";
}

function splitMatchingAnswerSegments(answerText) {
  if (typeof answerText !== "string") return [];

  return answerText
    // A semicolon or comma inside a choice is text, not a mapping boundary.
    .split(/\n|[;,](?=\s*[^;,\n]+?\s*(?:->|=>|:))/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[-*•]\s*/, "")
        .trim()
    )
    .filter(Boolean);
}

function parseMatchingPairString(answerText) {
  if (typeof answerText !== "string") return null;

  let cleanedText = answerText
    .trim()
    .replace(/^[-*•]\s*/, "")
    .trim();
  if (!/(?:->|=>|:)/.test(cleanedText)) {
    cleanedText = cleanedText.replace(/^\d+[\.)]\s+/, "").trim();
  }
  if (!cleanedText) return null;

  const arrowMatch = cleanedText.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/);
  if (arrowMatch) {
    return {
      promptRef: arrowMatch[1].trim(),
      choiceRef: arrowMatch[2].trim(),
    };
  }

  const colonMatch = cleanedText.match(/^(.*?)\s*:\s*(.+)$/);
  if (colonMatch) {
    return {
      promptRef: colonMatch[1].trim(),
      choiceRef: colonMatch[2].trim(),
    };
  }

  return null;
}

function collectMatchingAnswerEntries(rawAnswer, output, choiceTexts = []) {
  if (!output || rawAnswer === null || rawAnswer === undefined) {
    return;
  }

  if (Array.isArray(rawAnswer)) {
    rawAnswer.forEach((entry) => collectMatchingAnswerEntries(entry, output, choiceTexts));
    return;
  }

  if (typeof rawAnswer === "object") {
    // Accept both explicit pair objects and map-like objects.
    const promptCandidate =
      rawAnswer.prompt ??
      rawAnswer.left ??
      rawAnswer.source ??
      rawAnswer.from ??
      rawAnswer.key;
    const choiceCandidate =
      rawAnswer.choice ??
      rawAnswer.match ??
      rawAnswer.right ??
      rawAnswer.target ??
      rawAnswer.to ??
      rawAnswer.answer ??
      rawAnswer.value;

    if (promptCandidate !== undefined && choiceCandidate !== undefined) {
      output.pairs.push({
        promptRef: String(promptCandidate),
        choiceRef: String(choiceCandidate),
      });
      return;
    }

    Object.entries(rawAnswer).forEach(([promptRef, choiceRef]) => {
      output.pairs.push({
        promptRef: String(promptRef),
        choiceRef: String(choiceRef),
      });
    });
    return;
  }

  if (typeof rawAnswer === "string") {
    const parsedArray = tryParseAnswerArrayString(rawAnswer);
    if (parsedArray) {
      collectMatchingAnswerEntries(parsedArray, output, choiceTexts);
      return;
    }

    // Prefer a whole exact choice before interpreting its punctuation as syntax.
    const fullPair = parseMatchingPairString(rawAnswer);
    if (fullPair && choiceTexts.some((choice) => isAnswerMatch(choice, fullPair.choiceRef))) {
      output.pairs.push(fullPair);
      return;
    }
    if (choiceTexts.some((choice) => isAnswerMatch(choice, rawAnswer))) {
      output.sequentialChoices.push(rawAnswer);
      return;
    }

    const segments = splitMatchingAnswerSegments(rawAnswer);
    if (!segments.length) {
      const cleaned = normalizeChoiceText(rawAnswer);
      if (cleaned) {
        output.rawStrings.push(cleaned);
        output.sequentialChoices.push(cleaned);
      }
      return;
    }

    segments.forEach((segment) => {
      const pair = parseMatchingPairString(segment);
      if (pair) {
        output.pairs.push(pair);
      } else {
        const cleanedSegment = normalizeChoiceText(segment);
        if (cleanedSegment) {
          output.rawStrings.push(cleanedSegment);
          output.sequentialChoices.push(cleanedSegment);
        }
      }
    });
    return;
  }

  const normalizedPrimitive = normalizeChoiceText(String(rawAnswer));
  if (normalizedPrimitive) {
    output.rawStrings.push(normalizedPrimitive);
    output.sequentialChoices.push(normalizedPrimitive);
  }
}

function normalizeMatchingTargets(container, rawAnswer) {
  const slots = getMatchingResponseSlots(container);
  if (!slots.length) return [];

  const promptTexts = dedupeAnswers(slots.map((slot) => slot.promptText));
  const choiceTexts = dedupeAnswers(
    getMatchingChoiceItems(container)
      .map((item) => getMatchingChoiceText(item))
      .filter(Boolean)
  );
  if (!promptTexts.length || !choiceTexts.length) return [];

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected, choiceTexts);

  const targetBySlot = new Map();
  const usedChoices = new Set();
  collected.pairs.forEach((pair) => {
    const choiceText = parseMatchingAnswerReference(
      pair.choiceRef,
      choiceTexts,
      "choice"
    );
    const choiceKey = normalizeChoiceText(choiceText).toLowerCase();
    if (!choiceText || usedChoices.has(choiceKey)) return;

    const promptRef = normalizeChoiceText(String(pair.promptRef || ""));
    const numericPromptRef = promptRef
      .replace(/^(?:prompt|row|left)\s*#?\s*/i, "")
      .match(/^#?(\d+)$/);
    let targetIndex = numericPromptRef ? Number(numericPromptRef[1]) - 1 : -1;

    if (
      targetIndex < 0 ||
      targetIndex >= slots.length ||
      targetBySlot.has(targetIndex)
    ) {
      const promptText = parseMatchingAnswerReference(
        pair.promptRef,
        promptTexts,
        "prompt"
      );
      targetIndex = slots.findIndex(
        (slot, index) =>
          !targetBySlot.has(index) && isAnswerMatch(slot.promptText, promptText)
      );
    }

    if (targetIndex < 0) return;

    const slot = slots[targetIndex];
    targetBySlot.set(targetIndex, {
      targetIndex,
      rowIndex: slot.rowIndex,
      slotIndex: slot.slotIndex,
      promptText: slot.promptText,
      choiceText,
    });
    usedChoices.add(choiceKey);
  });

  if (
    targetBySlot.size === 0 &&
    collected.sequentialChoices.length === slots.length
  ) {
    // If AI only returned ordered choices, map them by response-slot position.
    const orderedChoices = collected.sequentialChoices
      .map((choiceRef) =>
        parseMatchingAnswerReference(choiceRef, choiceTexts, "choice")
      )
      .filter(Boolean);

    if (
      orderedChoices.length === slots.length &&
      dedupeAnswers(orderedChoices).length === slots.length
    ) {
      orderedChoices.forEach((choiceText, targetIndex) => {
        const slot = slots[targetIndex];
        targetBySlot.set(targetIndex, {
          targetIndex,
          rowIndex: slot.rowIndex,
          slotIndex: slot.slotIndex,
          promptText: slot.promptText,
          choiceText,
        });
      });
    }
  }

  return slots.map((slot, targetIndex) => {
    const target = targetBySlot.get(targetIndex);
    return {
      targetIndex,
      rowIndex: slot.rowIndex,
      slotIndex: slot.slotIndex,
      promptText: slot.promptText,
      choiceText: target ? target.choiceText : "",
    };
  });
}

function getMatchingSnapshot(container) {
  return getMatchingResponseSlots(container).map((slot, targetIndex) => ({
    targetIndex,
    rowIndex: slot.rowIndex,
    slotIndex: slot.slotIndex,
    promptText: slot.promptText,
    choiceText: slot.item ? getMatchingChoiceText(slot.item) : "",
  }));
}

function isMatchingAligned(container, targetsBySlot) {
  if (!container || !Array.isArray(targetsBySlot) || targetsBySlot.length === 0) {
    return false;
  }

  const slots = getMatchingResponseSlots(container);
  if (slots.length !== targetsBySlot.length) {
    return false;
  }

  for (let targetIndex = 0; targetIndex < slots.length; targetIndex += 1) {
    const target = targetsBySlot[targetIndex];
    if (!target || !target.choiceText) {
      return false;
    }

    const currentChoice = getMatchingChoiceText(slots[targetIndex].item);
    if (!isAnswerMatch(currentChoice, target.choiceText)) {
      return false;
    }
  }

  return true;
}

async function moveMatchingChoiceToTarget(
  container,
  choiceText,
  targetIndex
) {
  if (!container || !choiceText || targetIndex < 0) {
    return false;
  }

  const slots = getMatchingResponseSlots(container);
  const initialLocation = getMatchingChoiceLocation(container, choiceText);
  if (!initialLocation) {
    return false;
  }
  if (initialLocation.targetIndex === targetIndex) {
    return true;
  }

  const handle = getMatchingDragHandle(initialLocation.item);
  if (!handle || !slots[targetIndex]?.holder) {
    return false;
  }
  if (
    !(await dragChoiceWithMouse(handle, () => {
      const liveDestination =
        getMatchingResponseSlots(container)[targetIndex]?.holder;
      return (
        liveDestination?.querySelector(".choice-item-wrapper") ||
        liveDestination
      );
    }))
  ) return false;

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const finalLocation = getMatchingChoiceLocation(container, choiceText);
    if (finalLocation?.targetIndex === targetIndex) return true;
    await delay(50);
  }
  return false;
}

function formatMatchingTargetsForAlert(container, rawAnswer) {
  const resolvedTargets = normalizeMatchingTargets(container, rawAnswer);
  const resolvedLines = resolvedTargets
    .filter((target) => target.choiceText)
    .map((target) => `${target.promptText} -> ${target.choiceText}`);
  if (resolvedLines.length > 0) {
    return resolvedLines;
  }

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const pairLines = collected.pairs
    .map((pair) => {
      const promptRef = normalizeChoiceText(pair.promptRef);
      const choiceRef = normalizeChoiceText(pair.choiceRef);
      if (!promptRef || !choiceRef) return "";
      return `${promptRef} -> ${choiceRef}`;
    })
    .filter(Boolean);

  const fallbackLines = dedupeAnswers(
    pairLines.concat(collected.sequentialChoices, collected.rawStrings).filter(Boolean)
  );

  return fallbackLines;
}

async function applyMatchingAnswer(container, rawAnswer) {
  const slots = getMatchingResponseSlots(container);
  if (!slots.length) {
    console.warn(LOG_PREFIX, "Matching question detected but no response slots found");
    return false;
  }

  const targetsBySlot = normalizeMatchingTargets(container, rawAnswer);
  if (!targetsBySlot.length) {
    console.warn(LOG_PREFIX, "Matching question had no usable answers from AI");
    return false;
  }

  if (targetsBySlot.some((target) => !target.choiceText)) {
    console.warn(LOG_PREFIX, "Matching targets were incomplete", targetsBySlot);
    return false;
  }

  console.info(
    LOG_PREFIX,
    "Matching target sequence",
    targetsBySlot.map((target) => `${target.promptText} -> ${target.choiceText}`)
  );

  const liftStrategies = [{ key: " ", code: "Space", keyCode: 32 }];

  const maxPasses = 4;
  // Re-run passes because one placement can dislodge another slot's current choice.
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (isMatchingAligned(container, targetsBySlot)) {
      return true;
    }

    for (let targetIndex = 0; targetIndex < targetsBySlot.length; targetIndex += 1) {
      const target = targetsBySlot[targetIndex];
      if (!target.choiceText) {
        continue;
      }

      const currentLocation = getMatchingChoiceLocation(container, target.choiceText);
      if (!currentLocation) {
        console.warn(
          LOG_PREFIX,
          "Unable to locate matching choice:",
          target.choiceText,
          "snapshot:",
          getMatchingSnapshot(container)
        );
        continue;
      }

      if (currentLocation.targetIndex === targetIndex) {
        continue;
      }

      let moved = false;
      for (const strategy of liftStrategies) {
        const strategyLocation = getMatchingChoiceLocation(
          container,
          target.choiceText
        );
        if (!strategyLocation) {
          break;
        }
        if (strategyLocation.targetIndex === targetIndex) {
          moved = true;
          break;
        }

        moved = await moveMatchingChoiceToTarget(
          container,
          target.choiceText,
          targetIndex,
          strategy
        );
        if (moved) {
          break;
        }
      }

      if (!moved) {
        console.warn(
          LOG_PREFIX,
          "Matching move may not have completed:",
          `${target.promptText} -> ${target.choiceText}`,
          "snapshot:",
          getMatchingSnapshot(container)
        );
      }
    }

    if (!isMatchingAligned(container, targetsBySlot)) {
      console.info(
        LOG_PREFIX,
        `Matching pass ${pass} incomplete`,
        getMatchingSnapshot(container)
      );
    }
  }

  return isMatchingAligned(container, targetsBySlot);
}
function normalizeResponseAnswers(rawAnswer, questionType, container) {
  if (questionType === "matching") {
    return formatMatchingTargetsForAlert(container, rawAnswer);
  }

  const flattenedAnswers = flattenAnswerValues(rawAnswer);
  if (flattenedAnswers.length === 0) return [];

  const isMultiChoiceType =
    questionType === "multiple_select" || questionType === "select_text";

  if (isMultiChoiceType && flattenedAnswers.length === 1) {
    const combinedAnswer = flattenedAnswers[0];
    const questionChoices = getQuestionChoices(container, questionType);
    const exactChoice = questionChoices.find((choice) =>
      isAnswerMatch(choice, combinedAnswer)
    );
    if (exactChoice) {
      return [exactChoice];
    }

    const splitAnswers = splitCompoundAnswer(combinedAnswer);
    if (splitAnswers.length > 1) {
      const matchedChoices = splitAnswers.map((answer) =>
        questionChoices.find((choice) => isAnswerMatch(choice, answer))
      );
      if (matchedChoices.every(Boolean)) {
        return dedupeAnswers(matchedChoices);
      }
    }
  }

  return dedupeAnswers(flattenedAnswers);
}

function assertCurrentAutomationRun(runId) {
  if (!isAutomating || runId !== automationRunId) {
    const error = new Error("Automation run was replaced");
    error.stale = true;
    throw error;
  }
}

function findClickableElement(selector) {
  return Array.from(document.querySelectorAll(selector)).find(isElementVisible);
}

function isQuestionGraded(container) {
  return !!findClickableElement(".next-button") || Array.from(
    container.querySelectorAll(".awd-probe-correctness.correct, .awd-probe-correctness.incorrect")
  ).some(isElementVisible);
}

function isQuestionIntermission() {
  const overview = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );
  return (isElementVisible(overview) && /continue/i.test(overview.textContent)) ||
    isElementVisible(document.querySelector(".forced-learning .alert-error"));
}

function waitForClickableElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const element = findClickableElement(selector);
      if (element) {
        clearInterval(interval);
        resolve(element);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        const error = new Error("Clickable element not found: " + selector);
        error.retryable = true;
        reject(error);
      }
    }, 100);
  });
}

function waitForQuestionTransition(container, questionSignature, timeout = 20000, previousNextButton = null) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const currentContainer = document.querySelector(".probe-container");
      if (
        isAssignmentComplete() || isQuestionIntermission() ||
        (currentContainer && !isQuestionGraded(currentContainer) && (
          currentContainer !== container ||
          getQuestionSignature(currentContainer) !== questionSignature ||
          (previousNextButton && (previousNextButton.isConnected === false ||
            !isElementVisible(previousNextButton)))
        ))
      ) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        const error = new Error("McGraw did not advance to the next question");
        error.retryable = true;
        reject(error);
      }
    }, 100);
  });
}

async function submitAndAdvance(container, runId) {
  const questionSignature = getQuestionSignature(container);
  let nextButton = findClickableElement(".next-button");

  if (!nextButton) {
    const confidenceButton = await waitForClickableElement(
      getConfidenceSelector(),
      10000
    );
    assertCurrentAutomationRun(runId);
    recordDiagnostic("confidence.clicked");
    confidenceButton.click();

    try {
      nextButton = await waitForClickableElement(".next-button", 15000);
    } catch (error) {
      const currentContainer = document.querySelector(".probe-container");
      if (
        isAssignmentComplete() || isQuestionIntermission() ||
        (currentContainer && !isQuestionGraded(currentContainer) && (
          currentContainer !== container ||
          getQuestionSignature(currentContainer) !== questionSignature
        ))
      ) {
        return;
      }
      throw error;
    }
  }

  assertCurrentAutomationRun(runId);
  checkForCorrectAnswer(container);
  recordDiagnostic("next.clicked");
  nextButton.click();
  await waitForQuestionTransition(container, questionSignature, 20000, nextButton);
  assertCurrentAutomationRun(runId);
  // A new attempt may legitimately repeat the same wording and choices.
  lastQueuedQuestionSignature = "";
  recordDiagnostic("transition.complete");
}

async function processChatGPTResponse(responseText) {
  if (handleTopicOverview()) {
    return;
  }

  if (handleForcedLearning()) {
    return;
  }

  const container = document.querySelector(".probe-container");
  if (!container) return;
  const runId = automationRunId;
  const currentQuestionSignature = getQuestionSignature(container);
  if (
    lastQueuedQuestionSignature &&
    currentQuestionSignature !== lastQueuedQuestionSignature
  ) {
    return;
  }
  const questionType = detectQuestionType(container);
  const response = JSON.parse(responseText);
  const answers = normalizeResponseAnswers(
    response.answer,
    questionType,
    container
  );

  lastIncorrectQuestion = null;
  lastCorrectAnswer = null;

  if (answers.length === 0) {
    pauseForManualAnswer(container, answers);
    return;
  }

  if (questionType === "matching") {
    const applied = await applyMatchingAnswer(container, response.answer);
    if (!applied) {
      const questionSignature = getQuestionSignature(container);
      recordDiagnostic("answer.mismatch", { questionType, answerCount: answers.length });
      showAutomationStatus(
        "Matching Question Solution:\n\n" +
          (answers.length ? answers.join("\n") : "No confident matches parsed.") +
          "\n\nPlease input these matches manually, then click high confidence and next. Automation will resume after you move to the next question.", true
      );

      if (isAutomating) {
        pauseForManualMatchingAndResume(questionSignature);
      }

      return;
    }
  } else if (questionType === "ranking") {
    const applied = await applyRankingAnswer(container, answers);
    if (!applied) {
      pauseForManualAnswer(container, answers);
      return;
    }
  } else if (questionType === "select_text") {
    const choices = Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    );

    if (
      !answers.every((answer) =>
        choices.some((choice) =>
          isAnswerMatch(getElementText(choice), answer)
        )
      )
    ) {
      pauseForManualAnswer(container, answers);
      return;
    }

    let filledCount = 0;
    choices.forEach((choice) => {
      const choiceText = getElementText(choice);
      if (!choiceText) return;

      const shouldBeSelected = answers.some((ans) =>
        isAnswerMatch(choiceText, ans)
      );

      if (shouldBeSelected) {
        choice.click();
        filledCount++;
      }
    });

    if (filledCount === 0) {
      pauseForManualAnswer(container, answers);
      return;
    }
  } else {
    const filledCount = fillInAnswers(answers, container);
    if (filledCount < 0 || (questionType === "fill_in_the_blank" && filledCount === 0)) {
      pauseForManualAnswer(container, answers);
      return;
    }
    if (filledCount === 0) {
      const error = new Error("Matched answer could not be applied yet");
      error.retryable = true;
      throw error;
    }
  }

  recordDiagnostic("answer.applied", { questionType, answerCount: answers.length });
  showAutomationStatus(pauseBeforeSubmit ? "Answer filled. Review it, then submit and advance." : "Answer filled; submitting...");
  if (isAutomating && !pauseBeforeSubmit) {
    await submitAndAdvance(container, runId);
  }
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation").then((headerNav) => {
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.marginLeft = "10px";

    chrome.storage.sync.get(["aiModel", "doubleCreditMode"], function (data) {
      const aiModel = data.aiModel || "chatgpt";
      doubleCreditMode = data.doubleCreditMode || false;
      let modelName = "ChatGPT";

      if (aiModel === "gemini") {
        modelName = "Gemini";
      } else if (aiModel === "deepseek") {
        modelName = "DeepSeek";
      }

      const btn = document.createElement("button");
      btn.textContent = `Ask ${modelName}${doubleCreditMode ? " (2x)" : ""}`;
      btn.classList.add("btn", "btn-secondary", "automcgraw-btn");
      btn.style.borderTopRightRadius = "0";
      btn.style.borderBottomRightRadius = "0";
      btn.addEventListener("click", () => {
        if (isAutomating) {
          recordDiagnostic("run.stopped.manual", { status: "stopped" });
          const stoppedRequestId = activeQuestionRequestId;
          isAutomating = false;
          automationRunId++;
          activeQuestionRequestId = null;
          lastQueuedQuestionSignature = "";
          waitingForDuplicateCompletion = false;
          clearMatchingPauseWatcher();
          chrome.runtime.sendMessage({
            type: "resetTabTracking",
            requestId: stoppedRequestId,
          });
          updateButtonState();
          showAutomationStatus("Automation stopped.");
        } else {
          isAutomating = true;
          automationRunId++;
          activeQuestionRequestId = null;
          lastQueuedQuestionSignature = "";
          clearMatchingPauseWatcher();
          btn.textContent = "Stop Automation";
          recordDiagnostic("run.started");
          checkForNextStep();
        }
      });

      const settingsBtn = document.createElement("button");
      settingsBtn.classList.add("btn", "btn-secondary");
      settingsBtn.style.borderTopLeftRadius = "0";
      settingsBtn.style.borderBottomLeftRadius = "0";
      settingsBtn.style.borderLeft = "1px solid rgba(0,0,0,0.2)";
      settingsBtn.style.padding = "6px 10px";
      settingsBtn.title = "Auto-McGraw Settings";
      settingsBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      `;
      settingsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "openSettings" });
      });

      buttonContainer.appendChild(btn);
      buttonContainer.appendChild(settingsBtn);
      headerNav.appendChild(buttonContainer);

      chrome.storage.onChanged.addListener((changes) => {
        if ((changes.aiModel || changes.doubleCreditMode) && !isAutomating) {
          chrome.storage.sync.get(
            ["aiModel", "doubleCreditMode"],
            function (data) {
              const newModel = data.aiModel || "chatgpt";
              const doubleMode = data.doubleCreditMode || false;
              doubleCreditMode = doubleMode;
              let newModelName = "ChatGPT";

              if (newModel === "gemini") {
                newModelName = "Gemini";
              } else if (newModel === "deepseek") {
                newModelName = "DeepSeek";
              }

              btn.textContent = `Ask ${newModelName}${
                doubleMode ? " (2x)" : ""
              }`;
            }
          );
        }
      });
    });
  });
}

function getQuestionImages(container) {
  const images = [];
  for (const image of container.querySelectorAll("img")) {
    if (image.closest(".MathJax, .MathJax_Preview, .MJX_Assistive_MathML, .correctness, .awd-probe-correctness") ||
        image.getAttribute("aria-hidden") === "true" || image.getAttribute("role") === "presentation") continue;
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width > 0 && height > 0 && Math.max(width, height) <= 32) continue;
    let url;
    try { url = new URL(image.currentSrc || image.src); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password ||
        !(url.hostname === "mheducation.com" || url.hostname.endsWith(".mheducation.com"))) continue;
    if (images.some((existing) => existing.src === url.href)) continue;
    images.push({ src: url.href, alt: (image.alt || "").trim() });
    if (images.length === 4) break;
  }
  return images;
}

function parseQuestion(
  container = document.querySelector(".probe-container")
) {
  if (!container) {
    showAutomationStatus("No question found on the page.", true);
    return null;
  }

  const questionType = detectQuestionType(container);

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const uiSpans = promptClone.querySelectorAll(
      "span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    uiSpans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      if (input.parentNode) {
        input.parentNode.replaceChild(blankMarker, input);
      }
    });

    questionText = getElementText(promptClone);
  } else {
    questionText = getElementText(promptEl);
  }

  const images = getQuestionImages(container);
  for (const image of images) {
    if (image.alt) questionText += `\nImage description: ${image.alt}`;
  }

  let options = [];
  if (questionType === "matching") {
    const prompts = getMatchingResponseSlots(container)
      .map((slot) => slot.promptText)
      .filter(Boolean);
    const choices = dedupeAnswers(
      getMatchingChoiceItems(container)
        .map((item) => getMatchingChoiceText(item))
        .filter(Boolean)
    );
    options = { prompts, choices };
  } else if (questionType === "ranking") {
    options = getSortableChoiceItems(container)
      .map((item) => getMatchingChoiceText(item))
      .filter(Boolean);
  } else if (questionType === "select_text") {
    options = Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => getElementText(el))
      .filter(Boolean);
  } else if (questionType !== "fill_in_the_blank") {
    options = getQuestionChoices(container, questionType);
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    ...(images.length ? { images } : {}),
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
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
addAssistantButton();
setInterval(() => {
  if (!isAutomating) return;
  handleSessionPrompt();
  checkForNextStep();
}, 1000);
