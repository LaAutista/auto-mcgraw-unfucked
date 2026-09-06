console.log("[Auto-McGraw][chatgpt] content script LOADED — marker v2");
const promiseApi = globalThis.browser ?? chrome;
let hasResponded = false;
let activeRequestId = null;
let messageCountAtQuestion = 0;
let assistantMessagesAtQuestion = new Set();
let candidateAnswer = null;
let candidateSince = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
let pollIntervalId = null;

function recordDiagnostic(stage, details = {}, requestId = activeRequestId) {
  try {
    chrome.runtime.sendMessage({ type: "diagnosticEvent", stage: `chatgpt.${stage}`, requestId, details }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    // Diagnostics cannot interrupt a request during an extension reload.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "cancelRequest") {
    if (message.requestId === activeRequestId) {
      activeRequestId = null;
      resetObservation();
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "receiveQuestion") {
    const requestId = message.requestId || JSON.stringify(message.question);

    // Retry sends reuse an ID; a Stop/Start attempt gets a fresh one.
    if (activeRequestId === requestId) {
      sendResponse({ received: true, status: "already-processing" });
      return true;
    }

    activeRequestId = requestId;
    resetObservation();
    recordDiagnostic("question.received", { questionType: message.question?.type });

    hasResponded = false;

    insertQuestion(message.question, requestId)
      .then((inserted) => {
        if (!inserted || requestId !== activeRequestId) {
          sendResponse({ received: false, stale: true });
          return;
        }
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        recordDiagnostic("submit.error", { errorName: error.name });
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  candidateAnswer = null;
  candidateSince = 0;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (pollIntervalId) {
    clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
}

function waitForIdle(requestId = activeRequestId, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (requestId !== activeRequestId) {
        clearInterval(interval);
        resolve(false);
      } else if (!document.querySelector('[data-testid="stop-button"]')) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for ChatGPT to finish responding"));
      }
    }, 250);
  });
}

async function insertQuestion(questionData, requestId = activeRequestId) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (type === "sim_choice") {
    text +=
      "\nResponse options:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is an interactive business simulation played as a chat conversation. You are playing the student\'s role. Choose the single best response option for the situation. Set "answer" to the exact text of the best option.';
  } else if (type === "worksheet_mc") {
    text +=
      "\nItems:\n" +
      options.items.map((item, i) => `${i + 1}. ${item}`).join("\n");
    text +=
      "\nChoices (the same choices apply to every item):\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nAssign exactly one choice to each item. Set "answer" to an array with one choice per item, in the same order as the items, using the exact choice text.';
  } else if (type === "ranking") {
    text +=
      "\nItems to rank:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is a ranking question. Set "answer" to an array containing ALL of the above items in the correct order from first to last. Use the exact item text.';
  } else if (type === "multiple_response" || type === "multiple_select") {
    text +=
      "\nOptions:\n" +
      options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      '\n\nThis is a "select all that apply" question. Set "answer" to an array containing ALL of the correct options. Use the exact option text.';
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match the above options. Omit only the numbered-list prefix; preserve all numbers in the option text. If there are periods, include them. If there are multiple selections, include all of the correct selections.";
  }

  text +=
    '\n\nIMPORTANT: Your answer should be in a JSON code block.' +
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  if (!(await waitForIdle(requestId))) return false;
  if (requestId !== activeRequestId) return false;
  const existingAssistantMessages = Array.from(document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  ));
  messageCountAtQuestion = existingAssistantMessages.length;
  assistantMessagesAtQuestion = new Set(
    existingAssistantMessages.map(getAssistantMessageKey)
  );

  const inputArea = document.getElementById("prompt-textarea");
  if (!inputArea) throw new Error("Input area not found");

  if (questionData.images?.length) {
    if (!(await attachQuestionImages(inputArea, questionData.images, requestId))) return false;
    text += "\n\nThe attached images belong to this question. Inspect them before answering.";
  }
  const submitted = await submitToComposer(inputArea, text, requestId);
  if (!submitted || requestId !== activeRequestId) return false;
  recordDiagnostic("question.submitted", { status: "submitted", messageCount: messageCountAtQuestion });
  startObserving();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attachQuestionImages(inputArea, images, requestId) {
  const form = inputArea.closest("form");
  const upload = form?.querySelector('input[type="file"]');
  if (!upload || images.length > 4) throw new Error("ChatGPT image upload is unavailable");
  const previews = () => form.querySelectorAll('button[aria-label^="Remove"]');
  if (previews().length) throw new Error("Clear existing ChatGPT attachments before starting");
  const files = new DataTransfer();
  images.forEach(({ dataUrl }, index) => {
    const match = typeof dataUrl === "string" && dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || dataUrl.length > 3 * 1024 * 1024) throw new Error("Question image was not loaded safely");
    const bytes = Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0));
    files.items.add(new File([bytes], `mcgraw-question-${index + 1}.${match[1].split("/")[1]}`, { type: match[1] }));
  });
  if (requestId !== activeRequestId) return false;
  upload.files = files.files;
  upload.dispatchEvent(new Event("change", { bubbles: true }));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (requestId !== activeRequestId) return false;
    // The file input accepting a FileList is not proof the app uploaded it.
    const send = form.querySelector('[data-testid="send-button"]');
    if (previews().length === images.length && send && !send.disabled &&
        !form.querySelector('[role="progressbar"], [aria-busy="true"]')) {
      recordDiagnostic("images.attached", { optionCount: images.length });
      return true;
    }
    await sleep(250);
  }
  throw new Error("ChatGPT did not finish uploading the question image");
}

// Poll for a selector instead of guessing a fixed delay. Resolves with the
// element once it appears, or null on timeout.
function waitForSelector(selector, timeout = 12000, interval = 150) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - start > timeout) return resolve(null);
      setTimeout(tick, interval);
    };
    tick();
  });
}

function setComposerText(inputArea, text) {
  inputArea.focus();
  const paragraph = document.createElement("p");
  paragraph.textContent = String(text);
  inputArea.replaceChildren(paragraph);
  inputArea.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(inputArea) {
  inputArea.focus();
  const opts = {
    key: "Enter",
    code: "Enter",
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  inputArea.dispatchEvent(new KeyboardEvent("keydown", opts));
  inputArea.dispatchEvent(new KeyboardEvent("keyup", opts));
}

// Did the message actually go out? The composer clears on send, and ChatGPT
// shows a stop button while generating — either one confirms success.
function looksSent(inputArea, previousUserMessages = new Set()) {
  const liveInput = document.getElementById("prompt-textarea") || inputArea;
  const stillHasText = (liveInput.innerText || "").trim().length > 0;
  const generating = !!document.querySelector('[data-testid="stop-button"]');
  const newUserMessage = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
    .some((message) => !previousUserMessages.has(getAssistantMessageKey(message)));
  return generating || !stillHasText || newUserMessage;
}

// Type the question and reliably submit it, even when a long/heavy chat makes
// the composer slow to become ready. Waits for the send button, verifies the
// send, falls back to Enter, and retries before giving up.
async function submitToComposer(inputArea, text, requestId = activeRequestId) {
  const previousUserMessages = new Set(Array.from(
    document.querySelectorAll('[data-message-author-role="user"]'), getAssistantMessageKey
  ));
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requestId !== activeRequestId) return false;
    inputArea = document.getElementById("prompt-textarea") || inputArea;
    setComposerText(inputArea, text);

    const sendButton = await waitForSelector('[data-testid="send-button"]:not(:disabled)', 12000);
    if (requestId !== activeRequestId) return false;
    if (sendButton) {
      sendButton.click();
    } else {
      console.warn(
        "[Auto-McGraw][chatgpt] Send button never appeared (attempt " +
          attempt +
          "); trying Enter key."
      );
      pressEnter(inputArea);
    }

    await sleep(600);
    if (requestId !== activeRequestId) return false;
    if (looksSent(inputArea, previousUserMessages)) return true;

    console.warn(
      "[Auto-McGraw][chatgpt] Submit attempt " +
        attempt +
        " didn't go through; retrying."
    );
    await sleep(800);
  }

  throw new Error("Could not submit question to ChatGPT after 3 attempts");
}

// Pull a parseable JSON answer out of the latest assistant message.
// Returns the JSON string if found, or null while the model is still
// thinking / streaming (e.g. the message just says "Thinking").
function getAssistantMessageKey(message) {
  return message.getAttribute("data-message-id") || message;
}

function getLatestAnswerJson() {
  if (document.querySelector('[data-testid="stop-button"]')) return null;
  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  // Image replies can leave an empty assistant placeholder after the finished
  // message. Ignore only empty shells, never a newer nonempty thinking reply.
  const latestMessage = Array.from(messages).reverse().find(
    (message) => (message.textContent || "").trim()
  );
  if (
    !latestMessage ||
    assistantMessagesAtQuestion.has(getAssistantMessageKey(latestMessage))
  ) return null;

  const candidates = [];

  // Prefer fenced code blocks (that's where the JSON normally lands).
  latestMessage.querySelectorAll("pre code").forEach((block) => {
    candidates.push(block.textContent);
  });

  // Fall back to scanning the whole message for a JSON object.
  const fullText = latestMessage.textContent || "";
  const objectMatch = fullText.match(/\{[\s\S]*"answer"[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (let candidate of candidates) {
    candidate = candidate
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();

    // Skip placeholders like "Thinking" and anything not shaped like JSON.
    if (!candidate.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(candidate);
      // ChatGPT's code animation can pause on valid JSON containing this
      // placeholder, especially in a hidden tab. It is not an answer yet.
      if (parsed && parsed.answer !== undefined && !JSON.stringify(parsed.answer).includes("]()")) {
        return candidate;
      }
    } catch (e) {
      // Likely still streaming — keep waiting for the full object.
    }
  }

  return null;
}

function tryHandleResponse() {
  if (hasResponded || !activeRequestId) return;

  const responseText = getLatestAnswerJson();
  if (!responseText) {
    candidateAnswer = null;
    candidateSince = 0;
    return;
  }
  // Code-block animations can briefly form valid but incorrect JSON even after
  // the stop button disappears. Require a quiet second before applying it.
  if (responseText !== candidateAnswer) {
    candidateAnswer = responseText;
    candidateSince = Date.now();
    return;
  }
  if (Date.now() - candidateSince < 1000) return;

  hasResponded = true;
  const requestId = activeRequestId;
  recordDiagnostic("answer.ready", { stable: true, elapsedMs: Date.now() - observationStartTime });
  promiseApi.runtime
    .sendMessage({
      type: "chatGPTResponse",
      requestId,
      response: responseText,
    })
    .then((delivery) => {
      if (requestId !== activeRequestId) return;
      recordDiagnostic("answer.delivery", { received: !!delivery?.received, stale: !!delivery?.stale });
      if (delivery?.received || delivery?.stale) {
        resetObservation();
        return;
      }
      hasResponded = false;
      console.warn("[Auto-McGraw][chatgpt] Answer delivery was not acknowledged; retrying.");
    })
    .catch((error) => {
      if (requestId !== activeRequestId) return;
      hasResponded = false;
      recordDiagnostic("answer.error", { errorName: error.name });
      console.error("[Auto-McGraw][chatgpt] Error sending response:", error);
    });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      recordDiagnostic("answer.slow", { status: "waiting", elapsedMs: Date.now() - observationStartTime });
      console.warn("[Auto-McGraw][chatgpt] Still waiting for a JSON answer.");
    }
  }, 180000);

  // Poll instead of relying on a single mutation firing at the right moment.
  // Thinking models render "Thinking" first, then the real answer later;
  // polling keeps checking until valid JSON with an "answer" field appears.
  pollIntervalId = setInterval(tryHandleResponse, 800);

  // Mutation observer gives a faster response when the answer streams in.
  observer = new MutationObserver(() => {
    tryHandleResponse();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
