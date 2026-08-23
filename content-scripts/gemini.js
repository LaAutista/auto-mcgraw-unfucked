console.log("[Auto-McGraw][gemini] content script LOADED — marker v2");
const promiseApi = globalThis.browser ?? chrome;
let hasResponded = false;
let activeRequestId = null;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;
let pollIntervalId = null;

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
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
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
      const sendButton = document.querySelector(".send-button");
      if (requestId !== activeRequestId) {
        clearInterval(interval);
        resolve(false);
      } else if (!sendButton || !sendButton.classList.contains("stop")) {
        clearInterval(interval);
        resolve(true);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for Gemini to finish responding"));
      }
    }, 500);
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
  messageCountAtQuestion = document.querySelectorAll("model-response").length;

  const inputArea = document.querySelector(".ql-editor");
  if (!inputArea) throw new Error("Input area not found");

  const submitted = await submitToComposer(inputArea, text, requestId);
  if (!submitted || requestId !== activeRequestId) return false;
  startObserving();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Did the message actually go out? The composer clears on send, and Gemini
// switches the send button to a stop button while generating.
function looksSent(inputArea) {
  const stillHasText = (inputArea.innerText || "").trim().length > 0;
  const generating = !!document.querySelector(".send-button.stop");
  return generating || !stillHasText;
}

// Type the question and reliably submit it, even when a long/heavy chat makes
// the composer slow to become ready. Waits for the send button, verifies the
// send, falls back to Enter, and retries before giving up.
async function submitToComposer(inputArea, text, requestId = activeRequestId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (requestId !== activeRequestId) return false;
    setComposerText(inputArea, text);

    const sendButton = await waitForSelector(".send-button", 12000);
    if (requestId !== activeRequestId) return false;
    if (sendButton) {
      sendButton.click();
    } else {
      console.warn(
        "[Auto-McGraw][gemini] Send button never appeared (attempt " +
          attempt +
          "); trying Enter key."
      );
      pressEnter(inputArea);
    }

    await sleep(600);
    if (requestId !== activeRequestId) return false;
    if (looksSent(inputArea)) return true;

    console.warn(
      "[Auto-McGraw][gemini] Submit attempt " +
        attempt +
        " didn't go through; retrying."
    );
    await sleep(800);
  }

  throw new Error("Could not submit question to Gemini after 3 attempts");
}

// Pull a parseable JSON answer out of the latest assistant message.
// Returns the JSON string if found, or null while the model is still
// thinking / streaming (e.g. the message just says "Thinking").
function getLatestAnswerJson() {
  const messages = document.querySelectorAll("model-response");
  if (messages.length <= messageCountAtQuestion) return null;

  const latestMessage = messages[messages.length - 1];

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
      if (parsed && parsed.answer !== undefined) {
        return candidate;
      }
    } catch (e) {
      // Likely still streaming — keep waiting for the full object.
    }
  }

  return null;
}

function tryHandleResponse() {
  if (hasResponded) return;

  const responseText = getLatestAnswerJson();
  if (!responseText) return;

  hasResponded = true;
  const requestId = activeRequestId;
  console.log("[Auto-McGraw][gemini] sending answer back:", responseText);
  promiseApi.runtime
    .sendMessage({
      type: "geminiResponse",
      requestId,
      response: responseText,
    })
    .then((delivery) => {
      if (requestId !== activeRequestId) return;
      if (delivery?.received || delivery?.stale) {
        resetObservation();
        return;
      }
      hasResponded = false;
      console.warn("[Auto-McGraw][gemini] Answer delivery was not acknowledged; retrying.");
    })
    .catch((error) => {
      if (requestId !== activeRequestId) return;
      hasResponded = false;
      console.error("[Auto-McGraw][gemini] Error sending response:", error);
    });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      console.warn("[Auto-McGraw][gemini] Gave up waiting for a JSON answer.");
      resetObservation();
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
